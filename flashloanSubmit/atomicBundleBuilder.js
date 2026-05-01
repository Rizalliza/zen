'use strict';
/**
 * atomicBundleBuilder.js
 *
 * Assembles one atomic transaction for 3-leg Kamino flashloan arbitrage.
 *
 * CRITICAL FIXES in this revision:
 *   1. Pre-sign diagnostics — prints instruction count, static key count,
 *      lookup table count, and ESTIMATED SERIALIZED SIZE before sign()
 *   2. Size guard — throws a structured error if the v0 message will exceed
 *      the ~1150-byte safe limit, instead of the cryptic
 *      "RangeError: encoding overruns Uint8Array"
 *   3. borrowInstructionIndex fix — _repayIx from TradeExecutor is rebuilt
 *      with the CORRECT borrow instruction index. The pre-built repayIx
 *      passed by TradeExecutor had borrowInstructionIndex: 0 which is
 *      wrong when compute-budget instructions precede the borrow.
 *   4. Lookup table dedupe & auto-collection from instruction metadata.
 *   5. Per-instruction account count logging in diagnostics.
 */

const {
  Connection,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  PublicKey,
  ComputeBudgetProgram,
} = require('@solana/web3.js');

const {
  buildKaminoFlashBorrowInstruction,
  buildKaminoFlashRepayInstruction,
} = require('./kaminoFlashloan');
const {
  buildJitoTipInstruction,
  sendBundleBase64,
} = require('./jitoClient');

const PACKET_DATA_SIZE = 1232;
const SIGNATURE_LENGTH = 64;
const VERSION_PREFIX_SIZE = 1;

/* -------------------------------------------------------------------------- */
/*                         Compute budget helpers                             */
/* -------------------------------------------------------------------------- */

function buildComputeBudgetIxs({ computeUnitLimit, priorityFeeMicroLamports }) {
  const ixs = [];
  if (computeUnitLimit != null) {
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Number(computeUnitLimit) }));
  }
  if (priorityFeeMicroLamports != null) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(priorityFeeMicroLamports) }));
  }
  return ixs;
}

/* -------------------------------------------------------------------------- */
/*                      Lookup table account helpers                          */
/* -------------------------------------------------------------------------- */

async function fetchLookupTableAccounts(connection, lookupTableAddresses = []) {
  if (!Array.isArray(lookupTableAddresses) || lookupTableAddresses.length === 0) {
    return [];
  }
  const deduped = [];
  const seen = new Set();
  for (const entry of lookupTableAddresses) {
    const key = entry instanceof AddressLookupTableAccount
      ? entry.key.toBase58()
      : (entry instanceof PublicKey ? entry.toBase58() : String(entry || '').trim());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  const accounts = [];
  for (const addr of deduped) {
    try {
      if (addr instanceof AddressLookupTableAccount) {
        accounts.push(addr);
        continue;
      }
      const pubkey = addr instanceof PublicKey ? addr : new PublicKey(addr);
      const accountInfo = await connection.getAddressLookupTable(pubkey);
      if (accountInfo && accountInfo.value) {
        accounts.push(accountInfo.value);
      }
    } catch (_e) {
      // Skip invalid or missing lookup tables
    }
  }
  return accounts;
}

function uniqueAccountsWithProgramIds(instructions, lookupTableKeys = []) {
  const seen = new Set(lookupTableKeys);
  const unique = [];
  for (const ix of instructions) {
    for (const meta of ix.keys || []) {
      const key = meta.pubkey.toBase58();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(meta.pubkey);
      }
    }
    const programKey = ix.programId.toBase58();
    if (!seen.has(programKey)) {
      seen.add(programKey);
      unique.push(ix.programId);
    }
  }
  return unique;
}

function collectLookupTableCandidatesFromInstructions(instructions = []) {
  const out = [];
  for (const ix of instructions) {
    if (!ix || typeof ix !== 'object') continue;
    const candidates = []
      .concat(Array.isArray(ix.lookupTableAccounts) ? ix.lookupTableAccounts : [])
      .concat(Array.isArray(ix.addressLookupTableAddresses) ? ix.addressLookupTableAddresses : []);
    out.push(...candidates);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                        Pre-sign diagnostics & size guard                   */
/* -------------------------------------------------------------------------- */

function compactU16Size(n) {
  if (n < 0x80) return 1;
  if (n < 0x4000) return 2;
  return 3;
}

/**
 * Estimate the serialized size of a compiled MessageV0.
 * This is a pessimistic upper bound — actual bincode may be slightly smaller.
 */
function estimateV0MessageSize(message) {
  if (!message) return 0;
  let size = 3; // header: numRequiredSignatures + numReadonlySigned + numReadonlyUnsigned
  size += compactU16Size(message.staticAccountKeys.length);
  size += message.staticAccountKeys.length * 32;
  size += 32; // recentBlockhash

  size += compactU16Size(message.compiledInstructions.length);
  for (const ix of message.compiledInstructions) {
    size += 1; // programIdIndex
    size += compactU16Size(ix.accountKeyIndexes.length);
    size += ix.accountKeyIndexes.length;
    size += compactU16Size(ix.data.length);
    size += ix.data.length;
  }

  size += compactU16Size(message.addressTableLookups.length);
  for (const lut of message.addressTableLookups) {
    size += 32; // accountKey
    size += compactU16Size(lut.writableIndexes.length);
    size += lut.writableIndexes.length;
    size += compactU16Size(lut.readonlyIndexes.length);
    size += lut.readonlyIndexes.length;
  }

  return size;
}

function estimateVersionedTransactionSize(message, numSignatures = 1) {
  return VERSION_PREFIX_SIZE + (numSignatures * SIGNATURE_LENGTH) + estimateV0MessageSize(message);
}

function collectPerInstructionAccountCounts(instructions = []) {
  return instructions.map((ix, idx) => {
    const programId = ix.programId.toBase58().slice(0, 8);
    const keyCount = (ix.keys || []).length;
    const dataLen = (ix.data || []).length;
    return { index: idx, programId, keyCount, dataLen };
  });
}

function printPreSignDiagnostic({
  instructions,
  message,
  resolvedLookupTableAccounts,
  borrowInstructionIndex,
  label = 'Pre-sign diagnostic',
}) {
  const staticKeyCount = Array.isArray(message.staticAccountKeys) ? message.staticAccountKeys.length : null;
  const compiledIxCount = Array.isArray(message.compiledInstructions) ? message.compiledInstructions.length : null;
  const lutCount = Array.isArray(message.addressTableLookups) ? message.addressTableLookups.length : null;
  const msgSize = estimateV0MessageSize(message);
  const txSize = estimateVersionedTransactionSize(message, 1);
  const safe = txSize <= PACKET_DATA_SIZE;
  const uniqueStatic = uniqueAccountsWithProgramIds(
    instructions,
    resolvedLookupTableAccounts.map((lut) => lut.key.toBase58())
  );

  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  ${label.padEnd(61)} ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Instructions:        ${String(instructions.length).padEnd(44)} ║`);
  console.log(`║  Static account keys: ${String(staticKeyCount).padEnd(44)} ║`);
  console.log(`║  Unique static+prog:  ${String(uniqueStatic.length).padEnd(44)} ║`);
  console.log(`║  Compiled Ixs:        ${String(compiledIxCount).padEnd(44)} ║`);
  console.log(`║  Lookup tables:       ${String(lutCount).padEnd(44)} ║`);
  console.log(`║  LUT addresses:       ${resolvedLookupTableAccounts.map(l => l.key.toBase58().slice(0, 12)).join(', ').padEnd(44).substring(0, 44)} ║`);
  console.log(`║  Borrow instruction index: ${String(borrowInstructionIndex).padEnd(37)} ║`);
  console.log(`║  Est. message size:   ${String(msgSize).padEnd(44)} ║`);
  console.log(`║  Est. TX size:        ${String(txSize).padEnd(44)} ║`);
  console.log(`║  Packet limit:        ${String(PACKET_DATA_SIZE).padEnd(44)} ║`);
  console.log(`║  SAFE TO SIGN:        ${String(safe ? 'YES ✓' : 'NO ✗').padEnd(44)} ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);

  const perIx = collectPerInstructionAccountCounts(instructions);
  console.log('\n  Per-instruction account counts:');
  for (const row of perIx) {
    console.log(`    [${String(row.index).padStart(2)}] ${row.programId.padEnd(8)} | accounts=${String(row.keyCount).padStart(2)} | data=${row.dataLen} bytes`);
  }

  if (!safe) {
    console.log('\n  ⚠️  TRANSACTION OVERSIZED — Lookup tables are required.');
    console.log('      Pass --lookupTables <addr1,addr2,...> to offload common accounts.');
    console.log('      Common Raydium LUTs may be available from their API or community.');
  }

  return { msgSize, txSize, safe, staticKeyCount, uniqueStaticCount: uniqueStatic.length };
}

/* -------------------------------------------------------------------------- */
/*                    Kamino reserve account resolution                       */
/* -------------------------------------------------------------------------- */

function validateKaminoBorrowAccounts(accounts = {}) {
  const required = [
    'lendingMarketAuthority',
    'lendingMarket',
    'reserve',
    'reserveLiquidityMint',
    'reserveSourceLiquidity',
    'userDestinationLiquidity',
    'reserveLiquidityFeeReceiver',
  ];
  const missing = required.filter(k => !accounts[k]);
  return {
    valid: missing.length === 0,
    missing,
    accounts,
  };
}

function validateKaminoRepayAccounts(accounts = {}) {
  const required = [
    'lendingMarketAuthority',
    'lendingMarket',
    'reserve',
    'reserveLiquidityMint',
    'reserveDestinationLiquidity',
    'userSourceLiquidity',
    'reserveLiquidityFeeReceiver',
  ];
  const missing = required.filter(k => !accounts[k]);
  return {
    valid: missing.length === 0,
    missing,
    accounts,
  };
}

async function resolveKaminoReserveAccounts(connection, mint, lendingMarket, opts = {}) {
  const { PublicKey } = require('@solana/web3.js');
  const mintPubkey = mint instanceof PublicKey ? mint : new PublicKey(String(mint));
  const marketPubkey = lendingMarket
    ? (lendingMarket instanceof PublicKey ? lendingMarket : new PublicKey(String(lendingMarket)))
    : null;

  if (opts.borrowAccounts && opts.repayAccounts) {
    const bValid = validateKaminoBorrowAccounts(opts.borrowAccounts);
    const rValid = validateKaminoRepayAccounts(opts.repayAccounts);
    if (!bValid.valid) {
      throw new Error(`Invalid borrowAccounts: missing ${bValid.missing.join(', ')}`);
    }
    if (!rValid.valid) {
      throw new Error(`Invalid repayAccounts: missing ${rValid.missing.join(', ')}`);
    }
    return {
      borrow: opts.borrowAccounts,
      repay: opts.repayAccounts,
      source: 'provided',
    };
  }

  throw new Error(
    'Kamino reserve account auto-resolution is not yet implemented.\n' +
    'You must provide opts with the following account shapes:\n\n' +
    '  opts.borrowAccounts = {\n' +
    '    lendingMarketAuthority: PublicKey|string,\n' +
    '    lendingMarket: PublicKey|string,\n' +
    '    reserve: PublicKey|string,\n' +
    '    reserveLiquidityMint: PublicKey|string,\n' +
    '    reserveSourceLiquidity: PublicKey|string,\n' +
    '    userDestinationLiquidity: PublicKey|string,\n' +
    '    reserveLiquidityFeeReceiver: PublicKey|string,\n' +
    '  };\n\n' +
    '  opts.repayAccounts = {\n' +
    '    lendingMarketAuthority: PublicKey|string,\n' +
    '    lendingMarket: PublicKey|string,\n' +
    '    reserve: PublicKey|string,\n' +
    '    reserveLiquidityMint: PublicKey|string,\n' +
    '    reserveDestinationLiquidity: PublicKey|string,\n' +
    '    userSourceLiquidity: PublicKey|string,\n' +
    '    reserveLiquidityFeeReceiver: PublicKey|string,\n' +
    '  };'
  );
}

/* -------------------------------------------------------------------------- */
/*                          borrowInstructionIndex fix                        */
/* -------------------------------------------------------------------------- */

/**
 * The Kamino flash repay instruction stores the borrow instruction index
 * as the LAST BYTE of its data payload (after 8-byte discriminator + 8-byte amount).
 *
 * If a pre-built _repayIx has the wrong index, we rebuild it.
 */
function getBorrowInstructionIndexFromRepayData(data) {
  if (!data || data.length < 17) return null;
  return data.readUInt8(16);
}

function rebuildRepayIxIfNeeded(_repayIx, correctBorrowInstructionIndex, flashLoan, payer) {
  if (!_repayIx) return null;

  const currentIndex = getBorrowInstructionIndexFromRepayData(_repayIx.data);
  if (currentIndex === correctBorrowInstructionIndex) {
    return _repayIx; // already correct
  }

  console.warn(
    `  ⚠️  Repay instruction borrowInstructionIndex mismatch: ` +
    `pre-built=${currentIndex}, correct=${correctBorrowInstructionIndex}. Rebuilding...`
  );

  return buildKaminoFlashRepayInstruction({
    userTransferAuthority: payer,
    liquidityAmount: flashLoan.repayAmountLamports || flashLoan.amountLamports,
    borrowInstructionIndex: correctBorrowInstructionIndex,
    ...flashLoan.repayAccounts,
  });
}

/* -------------------------------------------------------------------------- */
/*                    Main: buildAtomicKaminoArbTransaction                   */
/* -------------------------------------------------------------------------- */

async function buildAtomicKaminoArbTransaction({
  payer,
  connection,
  flashLoan,
  arbitrageInstructions = [],
  lookupTableAccounts = [],
  computeUnitLimit = 1_400_000,
  priorityFeeMicroLamports = 50_000,
  jitoTipLamports = 10_000,
  _borrowIx = null,
  _repayIx = null,
  _budgetIxs = null,
}) {
  if (!flashLoan || !flashLoan.borrowAccounts || !flashLoan.repayAccounts) {
    throw new Error('flashLoan.borrowAccounts and flashLoan.repayAccounts are required');
  }
  if (!flashLoan.amountLamports) {
    throw new Error('flashLoan.amountLamports is required');
  }

  const borrowValidation = validateKaminoBorrowAccounts(flashLoan.borrowAccounts);
  if (!borrowValidation.valid) {
    throw new Error(`Invalid Kamino borrow accounts: missing ${borrowValidation.missing.join(', ')}`);
  }

  const repayValidation = validateKaminoRepayAccounts(flashLoan.repayAccounts);
  if (!repayValidation.valid) {
    throw new Error(`Invalid Kamino repay accounts: missing ${repayValidation.missing.join(', ')}`);
  }

  // 1. Compute budget instructions
  let setupIxs;
  if (_budgetIxs && Array.isArray(_budgetIxs)) {
    setupIxs = _budgetIxs;
  } else {
    setupIxs = buildComputeBudgetIxs({ computeUnitLimit, priorityFeeMicroLamports });
  }

  // 2. Flash borrow instruction
  const borrowInstructionIndex = setupIxs.length;

  let borrowIx;
  if (_borrowIx) {
    borrowIx = _borrowIx;
  } else {
    borrowIx = buildKaminoFlashBorrowInstruction({
      userTransferAuthority: payer,
      liquidityAmount: flashLoan.amountLamports,
      ...flashLoan.borrowAccounts,
    });
  }

  // 3. Flash repay instruction — ALWAYS rebuild with correct borrowInstructionIndex
  let repayIx = rebuildRepayIxIfNeeded(_repayIx, borrowInstructionIndex, flashLoan, payer);
  if (!repayIx) {
    repayIx = buildKaminoFlashRepayInstruction({
      userTransferAuthority: payer,
      liquidityAmount: flashLoan.repayAmountLamports || flashLoan.amountLamports,
      borrowInstructionIndex,
      ...flashLoan.repayAccounts,
    });
  }

  // 4. Jito tip instruction
  const tipIx = await buildJitoTipInstruction(payer, jitoTipLamports);

  // Assemble in strict order
  const instructions = [
    ...setupIxs,
    borrowIx,
    ...arbitrageInstructions,
    repayIx,
    tipIx,
  ];

  // 5. Resolve lookup tables
  const instructionLookupTableCandidates = collectLookupTableCandidatesFromInstructions(instructions);
  const allLookupTableCandidates = []
    .concat(Array.isArray(lookupTableAccounts) ? lookupTableAccounts : [])
    .concat(instructionLookupTableCandidates);
  const resolvedLookupTableAccounts = await fetchLookupTableAccounts(
    connection,
    allLookupTableCandidates
  );

  // 6. Build versioned transaction
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(resolvedLookupTableAccounts);

  // ---- PRE-SIGN DIAGNOSTIC ----
  const diagnostic = printPreSignDiagnostic({
    instructions,
    message,
    resolvedLookupTableAccounts,
    borrowInstructionIndex,
    label: 'Atomic Bundle Pre-sign Check',
  });

  // ---- SIZE GUARD ----
  if (!diagnostic.safe) {
    const reductionTips = [];
    if (diagnostic.staticKeyCount > 40) {
      reductionTips.push(`Static keys are ${diagnostic.staticKeyCount} (>40). Pass lookup tables via --lookupTables <addr1,addr2,...>`);
    }
    if (instructions.length > 10) {
      reductionTips.push(`Instruction count is ${instructions.length}. Consider splitting or removing non-essential instructions.`);
    }

    throw new Error(
      `TRANSACTION TOO LARGE TO SERIALIZE\n` +
      `  Est. TX size: ${diagnostic.txSize} bytes (limit: ${PACKET_DATA_SIZE})\n` +
      `  Static keys:  ${diagnostic.staticKeyCount}\n` +
      `  Unique static+program: ${diagnostic.uniqueStaticCount}\n` +
      `  Instructions: ${instructions.length}\n` +
      `  Lookup tables resolved: ${resolvedLookupTableAccounts.length}\n\n` +
      `  How to fix:\n` +
      `  1. Pass --lookupTables <addr1,addr2> with addresses of lookup tables\n` +
      `     that contain common programs (Token Program, System Program, etc.)\n` +
      `  2. Reduce the number of tickArrays/binArrays per leg in the pool data\n` +
      `  3. Use SDK swap builders instead of manual builders (fewer accounts)\n` +
      `  4. Split into multiple transactions (not atomic — higher risk)\n\n` +
      (reductionTips.length ? `  Specific issues:\n  - ${reductionTips.join('\n  - ')}\n` : '')
    );
  }

  const tx = new VersionedTransaction(message);

  try {
    tx.sign([payer]);
  } catch (error) {
    const fallbackDiagnostic = {
      instructionCount: instructions.length,
      uniqueAccountCount: uniqueAccountsWithProgramIds(
        instructions,
        resolvedLookupTableAccounts.map((lut) => lut.key.toBase58())
      ).length,
      lookupTableCount: resolvedLookupTableAccounts.length,
      lookupTableKeys: resolvedLookupTableAccounts.map((lut) => lut.key.toBase58()),
      staticAccountKeyCount: Array.isArray(message.staticAccountKeys) ? message.staticAccountKeys.length : null,
      compiledInstructionCount: Array.isArray(message.compiledInstructions) ? message.compiledInstructions.length : null,
      recentBlockhash: blockhash,
      estMessageSize: estimateV0MessageSize(message),
      estTxSize: estimateVersionedTransactionSize(message, 1),
    };
    throw new Error(
      `Atomic bundle signing failed: ${error.message}\n` +
      `Diagnostic: ${JSON.stringify(fallbackDiagnostic, null, 2)}`
    );
  }

  return {
    transaction: tx,
    metadata: {
      instructionCount: instructions.length,
      borrowInstructionIndex,
      blockhash,
      lastValidBlockHeight,
      flashLoanAmountLamports: String(flashLoan.amountLamports),
      flashRepayAmountLamports: String(flashLoan.repayAmountLamports || flashLoan.amountLamports),
      lookupTableCount: resolvedLookupTableAccounts.length,
      lookupTableKeys: resolvedLookupTableAccounts.map((lut) => lut.key.toBase58()),
      uniqueAccountCount: uniqueAccountsWithProgramIds(
        instructions,
        resolvedLookupTableAccounts.map((lut) => lut.key.toBase58())
      ).length,
      staticAccountKeyCount: Array.isArray(message.staticAccountKeys) ? message.staticAccountKeys.length : null,
      compiledInstructionCount: Array.isArray(message.compiledInstructions) ? message.compiledInstructions.length : null,
      jitoTipLamports: String(jitoTipLamports),
      estMessageSize: diagnostic.msgSize,
      estTransactionSize: diagnostic.txSize,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          Bundle submission                                 */
/* -------------------------------------------------------------------------- */

async function sendAtomicBundle(transaction, client) {
  const encoded = Buffer.from(transaction.serialize()).toString('base64');
  return sendBundleBase64([encoded], client);
}

/* -------------------------------------------------------------------------- */
/*             Bridge: myEngine candidate → atomic transaction               */
/* -------------------------------------------------------------------------- */

async function buildTransactionFromCandidate({
  candidate,
  pools = {},
  payer,
  connection,
  kaminoAccounts,
  opts = {},
}) {
  const { TradeExecutor, candidateToFlashloanPlan, validateFlashloanPlan } = require('./tradeExecute');

  const plan = candidateToFlashloanPlan(candidate);
  const validation = validateFlashloanPlan(plan);
  if (!validation.valid) {
    throw new Error(`Invalid flashloan plan: ${validation.issues.join('; ')}`);
  }

  for (const leg of plan.routeLegs) {
    const pool = pools[leg.poolAddress];
    if (pool) {
      leg.poolContext = pool;
      leg.vaults = pool.vaults || null;
      leg.xVault = pool.xVault || pool.vaults?.xVault || null;
      leg.yVault = pool.yVault || pool.vaults?.yVault || null;
      leg.tickArrays = leg.tickArrays?.length ? leg.tickArrays : (pool.tickArrays || []);
      leg.binArrays = leg.binArrays?.length ? leg.binArrays : (pool.binArrays || []);
      leg.binStep = leg.binStep ?? pool.binStep ?? null;
      leg.activeBinId = leg.activeBinId ?? pool.activeBinId ?? null;
      leg.tickSpacing = leg.tickSpacing ?? pool.tickSpacing ?? null;
      leg.tickCurrent = leg.tickCurrent ?? pool.tickCurrent ?? null;
      leg.liquidity = leg.liquidity ?? pool.liquidity ?? null;
      leg.sqrtPrice = leg.sqrtPrice ?? pool.sqrtPrice ?? null;
      leg.feeBps = leg.feeBps ?? pool.feeBps ?? 25;
    }
  }

  const executor = new TradeExecutor(connection, payer, opts.executor || {});
  return executor.buildExecutionBundle(plan, {
    kaminoAccounts,
    ...opts,
  });
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
  // Core transaction builder
  buildAtomicKaminoArbTransaction,
  sendAtomicBundle,

  // Kamino account resolution
  resolveKaminoReserveAccounts,
  validateKaminoBorrowAccounts,
  validateKaminoRepayAccounts,

  // myEngine bridge
  buildTransactionFromCandidate,

  // Compute budget
  buildComputeBudgetIxs,

  // Lookup table utilities
  fetchLookupTableAccounts,
  uniqueAccountsWithProgramIds,

  // Diagnostics (exported for external use)
  estimateV0MessageSize,
  estimateVersionedTransactionSize,
  printPreSignDiagnostic,
  collectPerInstructionAccountCounts,
  PACKET_DATA_SIZE,
};
