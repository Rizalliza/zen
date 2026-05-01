'use strict';
/**
 * simulateExecutionBundle.js
 *
 * One-shot simulation: load candidate from myEngine results,
 * hydrate pools via RPC, resolve Kamino accounts, build the full atomic
 * transaction, sign + simulate, print detailed diagnostics.
 *
 * Combines:
 *   - User's sophisticated pool hydration (SDK layout decoding)
 *   - Kamino reserve account resolution from reserve detail files
 *   - atomicBundleBuilder pre-sign diagnostics and size guard
 *   - Structured error handling with remediation guidance
 */

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');

// Lazy-load project dependencies to avoid hard crashes at module init
let env = null;
try { env = require('./env'); } catch (_e) { /* env.js may not exist */ }

let poolContract = null;
try { poolContract = require('../engine/poolContract'); } catch (_e) { /* alternate path */ }
try { poolContract = require('./poolContract'); } catch (_e) { /* alternate path */ }

let atomicBundleBuilder = null;
try { atomicBundleBuilder = require('./atomicBundleBuilder'); } catch (_e) { /* may not exist */ }

let tradeExecute = null;
try { tradeExecute = require('./tradeExecute'); } catch (_e) { /* may not exist */ }

let kaminoReserveResolver = null;
try { kaminoReserveResolver = require('../flashloan/kaminoReserveResolver'); } catch (_e) { /* alternate path */ }
try { kaminoReserveResolver = require('./kaminoReserveResolver'); } catch (_e) { /* alternate path */ }

let RaydiumSdkV2 = null;
try {
  RaydiumSdkV2 = require('@raydium-io/raydium-sdk-v2');
} catch (_e) { /* SDK not installed */ }

let OrcaSdk = null;
try {
  OrcaSdk = require('@orca-so/whirlpools-sdk');
} catch (_e) { /* SDK not installed */ }

// ---------------------------------------------------------------------------
//  CLI helpers
// ---------------------------------------------------------------------------
function parseArgs(argv = []) {
  const out = {
    results: 'raw_runtime_results.json',
    candidateIndex: 0,
    pools: '',
    kaminoAccounts: '',
    reserveDetail: '',
    userLiquidityAccount: '',
    lookupTables: '',
    output: '',
    computeUnitLimit: 1_400_000,
    priorityFeeMicroLamports: env?.getPriorityFeeMicroLamports?.() || 50_000,
    jitoTipLamports: env?.getJitoTipLamports?.() || 10_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2).toLowerCase();
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? argv[++i] : 'true';

    if (key === 'results' || key === 'input') out.results = value;
    if (key === 'candidate' || key === 'candidateindex') out.candidateIndex = Number(value || 0);
    if (key === 'pools') out.pools = value;
    if (key === 'kaminoaccounts') out.kaminoAccounts = value;
    if (key === 'reservedetail') out.reserveDetail = value;
    if (key === 'userliquidityaccount') out.userLiquidityAccount = value;
    if (key === 'lookuptables') out.lookupTables = value;
    if (key === 'output') out.output = value;
    if (key === 'computeunitlimit') out.computeUnitLimit = Number(value || out.computeUnitLimit);
    if (key === 'priorityfeemicrolamports') out.priorityFeeMicroLamports = Number(value || out.priorityFeeMicroLamports);
    if (key === 'jitotiplamports') out.jitoTipLamports = Number(value || out.jitoTipLamports);
  }

  return out;
}

function resolvePath(input) {
  if (!input) return '';
  return path.isAbsolute(input) ? input : path.resolve(input);
}

function loadJsonFile(inputPath) {
  const resolved = resolvePath(inputPath);
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`JSON file not found: ${inputPath}`);
  }
  return { resolved, raw: JSON.parse(fs.readFileSync(resolved, 'utf8')) };
}

function parseLookupTables(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function short(value, size = 6) {
  const text = String(value || '');
  if (!text) return '-';
  return text.length <= size * 2 ? text : `${text.slice(0, size)}..${text.slice(-size)}`;
}

// ---------------------------------------------------------------------------
//  Pool hydration
// ---------------------------------------------------------------------------
function mergeCanonicalPool(pool) {
  if (poolContract && typeof poolContract.mergeCanonicalPool === 'function') {
    return poolContract.mergeCanonicalPool(pool);
  }
  // Minimal fallback
  return {
    ...pool,
    poolAddress: pool.poolAddress || pool.address || pool.id || '',
    tokenXMint: pool.tokenXMint || pool.baseMint || pool.mintA || pool.tokenA || '',
    tokenYMint: pool.tokenYMint || pool.quoteMint || pool.mintB || pool.tokenB || '',
    xVault: pool.xVault || pool.vaults?.xVault || pool.tokenVaultA || null,
    yVault: pool.yVault || pool.vaults?.yVault || pool.tokenVaultB || null,
    vaults: pool.vaults || { xVault: pool.xVault, yVault: pool.yVault },
  };
}

function extractPools(raw = {}) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.runtime?.pools)) return raw.runtime.pools;
  if (Array.isArray(raw.pools)) return raw.pools;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

function loadPoolMap(resultRaw, explicitPoolsPath = '') {
  const candidatePaths = [explicitPoolsPath, resultRaw?.source || ''].filter(Boolean);

  for (const candidatePath of candidatePaths) {
    try {
      const { resolved, raw } = loadJsonFile(candidatePath);
      const pools = extractPools(raw);
      if (!pools.length) continue;

      const poolMap = {};
      for (const pool of pools) {
        const normalized = mergeCanonicalPool(pool);
        const address = normalized.poolAddress || normalized.address;
        if (!address) continue;
        poolMap[address] = normalized;
      }

      if (Object.keys(poolMap).length > 0) {
        return { poolMap, source: resolved };
      }
    } catch (_e) {
      // Try next candidate path
    }
  }

  return { poolMap: {}, source: null };
}

async function hydratePoolForSubmission(pool = {}, connection) {
  const poolAddress = pool.poolAddress || pool.address;
  if (!poolAddress) return pool;
  if (pool.xVault && pool.yVault) return pool;

  const type = String(pool.type || '').toLowerCase();
  const programId = String(pool.programId || pool._raw?.programId || '');

  let account = null;
  try {
    account = await connection.getAccountInfo(new PublicKey(poolAddress));
  } catch (_e) {
    return pool;
  }
  if (!account) return pool;

  let xVault = pool.xVault || pool.vaults?.xVault || null;
  let yVault = pool.yVault || pool.vaults?.yVault || null;

  try {
    if (type === 'clmm' && RaydiumSdkV2) {
      const layout = RaydiumSdkV2.PoolInfoLayout || RaydiumSdkV2.ClmmPoolInfoLayout;
      if (layout && typeof layout.decode === 'function') {
        const state = layout.decode(account.data);
        xVault = state?.vaultA?.toBase58?.() || state?.vaultA?.toString?.() || xVault;
        yVault = state?.vaultB?.toBase58?.() || state?.vaultB?.toString?.() || yVault;
      }
    } else if (type === 'cpmm' && RaydiumSdkV2) {
      if (programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
        const layout = RaydiumSdkV2.liquidityStateV4Layout;
        if (layout && typeof layout.decode === 'function') {
          const state = layout.decode(account.data);
          xVault = state?.baseVault?.toBase58?.() || state?.baseVault?.toString?.() || xVault;
          yVault = state?.quoteVault?.toBase58?.() || state?.quoteVault?.toString?.() || yVault;
        }
      } else {
        const layout = RaydiumSdkV2.CpmmPoolInfoLayout;
        if (layout && typeof layout.decode === 'function') {
          const state = layout.decode(account.data);
          xVault = state?.vaultA?.toBase58?.() || state?.vaultA?.toString?.() || xVault;
          yVault = state?.vaultB?.toBase58?.() || state?.vaultB?.toString?.() || yVault;
        }
      }
    } else if (type === 'whirlpool' && OrcaSdk) {
      const parser = OrcaSdk.ParsableWhirlpool;
      if (parser && typeof parser.parse === 'function') {
        const state = parser.parse(new PublicKey(poolAddress), account);
        xVault = state?.tokenVaultA?.toBase58?.() || state?.tokenVaultA?.toString?.() || xVault;
        yVault = state?.tokenVaultB?.toBase58?.() || state?.tokenVaultB?.toString?.() || yVault;
      }
    }
  } catch (_error) {
    // Decoding failed — return pool as-is
  }

  return {
    ...pool,
    xVault: xVault || null,
    yVault: yVault || null,
    vaults: {
      ...(pool.vaults || {}),
      xVault: xVault || null,
      yVault: yVault || null,
    },
  };
}

async function hydrateCandidatePools(poolMap = {}, candidate = {}, connection) {
  const nextMap = { ...poolMap };
  const legs = Array.isArray(candidate.legs) ? candidate.legs : [];
  for (const leg of legs) {
    const poolAddress = leg.poolAddress || leg.address;
    if (!poolAddress || !nextMap[poolAddress]) continue;
    nextMap[poolAddress] = await hydratePoolForSubmission(nextMap[poolAddress], connection);
  }
  return nextMap;
}

// ---------------------------------------------------------------------------
//  Kamino account resolution
// ---------------------------------------------------------------------------
function normalizeKaminoAccounts(raw = {}) {
  if (raw.borrow && raw.repay) return raw;
  if (raw.borrowAccounts && raw.repayAccounts) {
    return { borrow: raw.borrowAccounts, repay: raw.repayAccounts };
  }
  throw new Error('Kamino accounts file must contain { borrow, repay } or { borrowAccounts, repayAccounts }');
}

function loadKaminoAccounts(cli, payerPublicKey) {
  // Direct accounts file
  if (cli.kaminoAccounts) {
    const { raw } = loadJsonFile(cli.kaminoAccounts);
    return {
      kaminoAccounts: normalizeKaminoAccounts(raw),
      source: resolvePath(cli.kaminoAccounts),
    };
  }

  // Derive from reserve detail
  if (cli.reserveDetail && kaminoReserveResolver) {
    const { raw, resolved } = loadJsonFile(cli.reserveDetail);
    const reserveSnapshot = kaminoReserveResolver.extractReserveSnapshot(raw);
    const derivedUserLiquidityAccount = cli.userLiquidityAccount
      || getAssociatedTokenAddressSync(
        new PublicKey(reserveSnapshot.reserveLiquidityMint),
        new PublicKey(payerPublicKey),
        false,
      ).toBase58();
    const derived = kaminoReserveResolver.buildFlashloanAccountsFromReserveDetail(raw, {
      userLiquidityAccount: derivedUserLiquidityAccount,
    });
    return {
      kaminoAccounts: { borrow: derived.borrowAccounts, repay: derived.repayAccounts },
      source: resolved,
      userLiquidityAccount: derivedUserLiquidityAccount,
    };
  }

  throw new Error(
    'Kamino reserve accounts are required. Provide one of:\n' +
    '  --kaminoAccounts <file.json>   (file with { borrow, repay })\n' +
    '  --reserveDetail <file.json> --userLiquidityAccount <ATA>\n'
  );
}

// ---------------------------------------------------------------------------
//  Main simulation
// ---------------------------------------------------------------------------
async function simulateBundle(cli = parseArgs(process.argv.slice(2))) {
  // Validate dependencies
  if (!atomicBundleBuilder || typeof atomicBundleBuilder.buildTransactionFromCandidate !== 'function') {
    throw new Error('atomicBundleBuilder.js is required but could not be loaded.');
  }
  if (!tradeExecute || typeof tradeExecute.loadCandidateFromResultFile !== 'function') {
    throw new Error('tradeExecute.js is required but could not be loaded.');
  }

  const payer = env?.loadKeypair?.() || (() => {
    throw new Error('env.js loadKeypair() is required. Set PRIVATE_KEY in .env');
  })();

  const rpcUrl = env?.getRpcUrl?.() || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const { resolved: resultPath, raw: resultRaw } = loadJsonFile(cli.results);
  const { candidate, plan, validation } = tradeExecute.loadCandidateFromResultFile(resultPath, cli.candidateIndex, { validate: true });

  const { kaminoAccounts, source: kaminoSource, userLiquidityAccount: derivedUserLiquidityAccount = null } =
    loadKaminoAccounts(cli, payer.publicKey.toBase58());

  const { poolMap: loadedPoolMap, source: poolSource } = loadPoolMap(resultRaw, cli.pools);
  const lookupTableAccounts = parseLookupTables(cli.lookupTables);
  const poolMap = await hydrateCandidatePools(loadedPoolMap, candidate, connection);

  if (!Object.keys(poolMap).length) {
    throw new Error('Unable to load pool context. Provide --pools <enriched-pools-file> or ensure results file source points to one.');
  }

  console.log(`\n🔍 Simulating candidate ${cli.candidateIndex}: ${short(plan.routeId || candidate.routeId)} | ${plan.routePath || '-'}`);
  console.log(`   Loan: ${short(plan.loanMint)} | amount=${plan.loanAmountAtomic}`);
  console.log(`   RPC: ${rpcUrl}`);
  console.log(`   Pools: ${poolSource || 'from results file'}`);
  console.log(`   Kamino: ${kaminoSource}`);
  console.log(`   LUTs: ${lookupTableAccounts.length > 0 ? lookupTableAccounts.join(', ') : '(none — may exceed packet size)'}`);

  let bundle;
  try {
    bundle = await atomicBundleBuilder.buildTransactionFromCandidate({
      candidate,
      pools: poolMap,
      payer,
      connection,
      kaminoAccounts,
      opts: {
        computeUnitLimit: cli.computeUnitLimit,
        computeUnitPrice: cli.priorityFeeMicroLamports,
        jitoTipLamports: cli.jitoTipLamports,
        lookupTableAccounts,
      },
    });
  } catch (buildError) {
    console.error('\n❌  BUILD ERROR');
    console.error(`   ${buildError.message || String(buildError)}`);

    if (buildError.message && buildError.message.includes('TRANSACTION TOO LARGE')) {
      console.error('\n   🔧 This route requires lookup tables to fit within the packet limit.');
      console.error('   Pass them via --lookupTables <addr1,addr2>');
    }
    if (buildError.message && buildError.message.includes('borrowInstructionIndex')) {
      console.error('\n   🔧 borrowInstructionIndex mismatch — this should be auto-fixed.');
    }
    throw buildError;
  }

  const metadata = bundle.metadata || {};
  console.log('\n📦 Bundle assembled:');
  console.log(`   Instructions: ${metadata.instructionCount || '?'}`);
  console.log(`   Static keys: ${metadata.staticAccountKeyCount || '?'}`);
  console.log(`   Unique accounts: ${metadata.uniqueAccountCount || '?'}`);
  console.log(`   Lookup tables: ${metadata.lookupTableCount || 0}`);
  console.log(`   Est. TX size: ${metadata.estTransactionSize || '?'} bytes (limit: ${atomicBundleBuilder.PACKET_DATA_SIZE || 1232})`);
  console.log(`   Borrow instruction index: ${metadata.borrowInstructionIndex ?? '?'}`);

  // Simulate
  let simulation;
  try {
    simulation = await connection.simulateTransaction(bundle.transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
  } catch (simError) {
    console.error('\n❌  SIMULATION ERROR');
    console.error(`   ${simError.message || String(simError)}`);
    throw simError;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    rpcUrl,
    resultsFile: resultPath,
    candidateIndex: cli.candidateIndex,
    candidate: {
      routeId: candidate.routeId || null,
      routePath: candidate.routePath || null,
      profitBps: candidate.estimatedProfitBps ?? candidate.profitBps ?? null,
      executionQuality: candidate.executionQuality || null,
    },
    plan: {
      routeId: plan.routeId,
      routePath: plan.routePath,
      loanMint: plan.loanMint,
      loanAmountAtomic: plan.loanAmountAtomic,
      repayAmountAtomic: plan.repayAmountAtomic,
      legCount: Array.isArray(plan.routeLegs) ? plan.routeLegs.length : 0,
      legs: (plan.routeLegs || []).map((leg) => ({
        legIndex: leg.legIndex,
        dexType: leg.dexType,
        type: leg.type,
        poolAddress: leg.poolAddress,
        inputMint: leg.inputMint,
        outputMint: leg.outputMint,
        amountInAtomic: leg.amountInAtomic,
        minOutAtomic: leg.minOutAtomic,
        quoteSource: leg.quoteSource || null,
      })),
    },
    validation,
    inputs: {
      payer: payer.publicKey.toBase58(),
      kaminoSource,
      poolSource,
      userLiquidityAccount: cli.userLiquidityAccount || derivedUserLiquidityAccount || null,
      lookupTableAccounts,
      computeUnitLimit: cli.computeUnitLimit,
      priorityFeeMicroLamports: cli.priorityFeeMicroLamports,
      jitoTipLamports: cli.jitoTipLamports,
    },
    bundle: {
      metadata: bundle.metadata,
      serializedBase64Length: Buffer.from(bundle.transaction.serialize()).toString('base64').length,
    },
    simulation: {
      err: simulation.value?.err || null,
      logs: simulation.value?.logs || [],
      unitsConsumed: simulation.value?.unitsConsumed ?? null,
      replacementBlockhash: simulation.value?.replacementBlockhash || null,
      accounts: simulation.value?.accounts || null,
      returnData: simulation.value?.returnData || null,
    },
  };

  if (cli.output) {
    const outputPath = resolvePath(cli.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    output.outputPath = outputPath;
  }

  console.log(`\n✅ Simulated candidate ${cli.candidateIndex}: ${short(plan.routeId || candidate.routeId)} | ${plan.routePath || '-'}`);
  console.log(`   Units consumed: ${simulation.value?.unitsConsumed ?? '?'}`);
  console.log(`   Error: ${simulation.value?.err ? JSON.stringify(simulation.value.err) : 'none'}`);

  if (output.simulation.err) {
    process.exitCode = 1;
  }

  return output;
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------
module.exports = {
  parseArgs,
  loadKaminoAccounts,
  simulateBundle,
  hydratePoolForSubmission,
  hydrateCandidatePools,
  loadPoolMap,
  mergeCanonicalPool,
};

if (require.main === module) {
  simulateBundle().catch((error) => {
    console.error('\n❌ Bundle simulation failed:', error.stack || error.message);
    process.exit(1);
  });
}
