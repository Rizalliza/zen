#!/usr/bin/env node
'use strict';
/**
 * UNIFIED POOL ENRICHMENT  (refactored)
 *
 * What changed vs the previous version:
 *  1. Whirlpool tick-array fetch is now ONE batched getMultipleAccountsInfo call
 *     (was 7 sequential getAccountInfo calls). Same pattern CLMM already used.
 *  2. enrichAllPools uses processInBatches — concurrency across pools instead of
 *     a strictly serial for-loop. Tick batching alone only fixes one pool at a
 *     time; this fixes the wall.
 *  3. The dead RPCManager shadow class was removed. The imported
 *     createRpcConnection proxy already provides rotation + failover, so we
 *     just trust it.
 *  4. binArray_util.js is now actually imported. The duplicate copies of
 *     binIdToBinArrayIndex / getBinArrayLowerUpperBinId / normalizeBinArrays /
 *     normalizeBins / deriveBinArray / etc. that were inlined are gone.
 *  5. The toPublicKey ReferenceError in normalizeBinArrays is fixed because we
 *     now call into binArray_util's version (which has toPublicKey).
 *  6. The CLMM RPC_DELAY_MS sleep was removed — concurrency is governed by
 *     the batch size and the RPC manager's failure cooldown, not a fixed
 *     sleep that throttled single-threaded throughput.
 *  7. Whirlpool pool + vaults + tick arrays now resolve in 2 round trips total
 *     (was up to 10).
 *
 * Public API unchanged:
 *   enrichAllPools(pools, connection)
 *   buildEnrichmentDebugReport / buildEnrichmentDiagnosticsEntry
 *   printEnrichmentDebugSummary
 *   parseCliArgs / extractPoolsFromInput / mergeOutputPayload
 *   plus re-exports from binArray_util that older callers depend on.
 */

require('dotenv').config();
const fs = require('fs');
const { PublicKey } = require('@solana/web3.js');
const {
  ParsableWhirlpool,
  ParsableTickArray,
  TickUtil,
  PDAUtil,
  ORCA_WHIRLPOOL_PROGRAM_ID,
} = require('@orca-so/whirlpools-sdk');
const {
  PoolInfoLayout: RaydiumClmmPoolInfoLayout,
  CpmmPoolInfoLayout,
  liquidityStateV4Layout,
  TickArrayLayout: RaydiumClmmTickArrayLayout,
  getPdaTickArrayAddress: getRaydiumClmmTickArrayAddress,
  TickUtils: RaydiumTickUtils,
} = require('@raydium-io/raydium-sdk-v2');
const { BorshAccountsCoder } = require('@coral-xyz/anchor');
const DLMM_IDL = require('@meteora-ag/dlmm').IDL;
const BN = require('bn.js');

// Project utilities — actually used now
const { buildNormalizedAux } = require('../utilities/aux-builders.js');
const { normalizePoolRecord, validateCanonicalPool } = require('../utilities/normalizer');
const { normalizeStructuredTickArray } = require('../utilities/whirlpool_tick_utils');
const { processInBatches } = require('../utilities/batchProcess');
const { createRpcConnection, getConfiguredRpcUrls } = require('../utilities/rpcConnectionManager');
const {
  MAX_BIN_ARRAY_SIZE,
  DEFAULT_BIN_PER_POSITION,
  binIdToBinArrayIndex,
  getBinArrayLowerUpperBinId,
  getBinIdIndexInBinArray,
  getBinArraysRequiredByPositionRange,
  getBinRangeFromActiveId,
  getBinRangeFromIds,
  normalizeBinRange,
  normalizeBinArrays,
  normalizeBins,
  normalizeBinId,
  deriveBinArray,
} = require('../utilities/binArray_util');

// DLMM constants
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const dlmmCoder = new BorshAccountsCoder(DLMM_IDL);

// Tunables. CONCURRENCY is the number of pools to enrich in parallel.
// 8 is a safe starting point with one Helius endpoint; raise to 16 if you have
// 2+ endpoints behind the rpcConnectionManager rotation.
const CONFIG = {
  CONCURRENCY: Number(process.env.ENRICHMENT_CONCURRENCY || 8),
  WHIRLPOOL_TICK_ARRAY_OFFSETS: [-3, -2, -1, 0, 1, 2, 3],
  CLMM_TICK_ARRAY_OFFSETS: [-3, -2, -1, 0, 1, 2, 3],
  DLMM_BIN_ARRAY_OFFSETS: [-4, -3, -2, -1, 0, 1, 2, 3, 4],
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
};

/* -------------------------------------------------------------------------- */
/*                              Pure helpers                                  */
/* -------------------------------------------------------------------------- */

function resolvePoolType(pool = {}) {
  const rawType = String(pool.type || pool.dexType || pool.dex || '').toLowerCase();
  if (rawType.includes('whirlpool') || rawType.includes('orca')) return 'whirlpool';
  if (rawType.includes('clmm')) return 'clmm';
  if (rawType.includes('dlmm') || rawType.includes('meteora')) return 'dlmm';
  if (rawType.includes('cpmm') || rawType.includes('amm')) return 'cpmm';
  return 'unknown';
}

function isFreshCanonicalInput(pool = {}) {
  const hasFreshTimestamps = Boolean(pool.fetchedAt || pool.enrichedAt);
  const hasFreshPayload = Boolean(pool.raw || pool.normalized);
  const hasCoreState = Boolean(
    pool.reserves || pool.xReserve || pool.yReserve
    || pool.vaults || pool.xVault || pool.yVault
  );
  const hasExecutionHints = Boolean(
    pool.tokenA || pool.tokenB
    || pool.hasRequiredFields || pool.isValid
    || pool.tickArrays || pool.binArrays || pool.bins
  );
  return hasFreshTimestamps && hasFreshPayload && hasCoreState && hasExecutionHints;
}

function parseSplTokenAmount(data) {
  if (!data || !Buffer.isBuffer(data) || data.length < 72) return null;
  try {
    return data.readBigUInt64LE(64).toString();
  } catch (_e) {
    return null;
  }
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    if (value.constructor?.name === 'BN' && typeof value.toString === 'function') {
      return value.toString();
    }
    if (typeof value.toBase58 === 'function') {
      return value.toBase58();
    }
  }
  return value;
}

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, currentValue) => {
    const normalizedValue = jsonReplacer(key, currentValue);
    if (normalizedValue && typeof normalizedValue === 'object') {
      if (seen.has(normalizedValue)) return undefined;
      seen.add(normalizedValue);
    }
    return normalizedValue;
  }, 2);
}

function hasPositiveAtomic(value) {
  try {
    if (value === undefined || value === null || value === '') return false;
    return BigInt(String(value).split('.')[0] || '0') > 0n;
  } catch (_error) {
    return false;
  }
}

function hasPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function getVaultAddress(pool = {}, side = 'x') {
  if (side === 'x') {
    return (
      pool.xVault || pool.vaults?.xVault || pool.vaults?.aVault
      || pool.tokenVaultA || pool.baseVault || pool.tokenVault0 || pool.vaultA
      || pool._raw?.reserve_x || pool.reserveX || null
    );
  }
  return (
    pool.yVault || pool.vaults?.yVault || pool.vaults?.bVault
    || pool.tokenVaultB || pool.quoteVault || pool.tokenVault1 || pool.vaultB
    || pool._raw?.reserve_y || pool.reserveY || null
  );
}

function asPublicKey(value) {
  if (!value) return null;
  if (value instanceof PublicKey) return value;
  try {
    return new PublicKey(typeof value.toBase58 === 'function' ? value.toBase58() : String(value));
  } catch (_e) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                          Canonical wire-up                                 */
/* -------------------------------------------------------------------------- */

function hasCanonicalReserves(pool = {}, canonical = {}) {
  return hasPositiveAtomic(canonical?.reserves?.x ?? pool?.xReserve ?? pool?.reserves?.x)
    && hasPositiveAtomic(canonical?.reserves?.y ?? pool?.yReserve ?? pool?.reserves?.y);
}

function wireCanonicalAndAux(pool = {}, enrichment = {}) {
  const merged = { ...pool, ...enrichment };

  if (enrichment.xVault !== undefined || enrichment.yVault !== undefined || enrichment.vaults) {
    merged.xVault = enrichment.xVault ?? merged.xVault ?? merged.vaults?.xVault;
    merged.yVault = enrichment.yVault ?? merged.yVault ?? merged.vaults?.yVault;
    merged.vaults = {
      ...(merged.vaults || {}),
      ...(enrichment.vaults || {}),
      ...(enrichment.xVault !== undefined ? { xVault: enrichment.xVault } : {}),
      ...(enrichment.yVault !== undefined ? { yVault: enrichment.yVault } : {}),
    };
  }
  if (enrichment.xReserve !== undefined || enrichment.yReserve !== undefined) {
    merged.xReserve = enrichment.xReserve ?? merged.xReserve;
    merged.yReserve = enrichment.yReserve ?? merged.yReserve;
    merged.reserves = {
      ...(merged.reserves || {}),
      ...(enrichment.xReserve !== undefined ? { x: enrichment.xReserve } : {}),
      ...(enrichment.yReserve !== undefined ? { y: enrichment.yReserve } : {}),
    };
  }

  const tokenXPriceUsd = enrichment.tokenXPriceUsd
    ?? enrichment.tokenA?.priceUsd ?? enrichment.basePriceUsd
    ?? pool.tokenXPriceUsd ?? pool.tokenA?.priceUsd ?? merged.tokenXPriceUsd;
  const tokenYPriceUsd = enrichment.tokenYPriceUsd
    ?? enrichment.tokenB?.priceUsd ?? enrichment.quotePriceUsd
    ?? pool.tokenYPriceUsd ?? pool.tokenB?.priceUsd ?? merged.tokenYPriceUsd;
  if (tokenXPriceUsd !== undefined) {
    merged.tokenXPriceUsd = tokenXPriceUsd;
    merged.basePriceUsd = tokenXPriceUsd;
  }
  if (tokenYPriceUsd !== undefined) {
    merged.tokenYPriceUsd = tokenYPriceUsd;
    merged.quotePriceUsd = tokenYPriceUsd;
  }

  const canonical = normalizePoolRecord(merged);
  if (!canonical) return merged;

  const validation = validateCanonicalPool(canonical);
  const builtAux = buildNormalizedAux({ ...merged, ...canonical });

  merged.address = merged.address || merged.poolAddress || merged.id || canonical.address;
  merged.poolAddress = merged.poolAddress || canonical.address || merged.address;
  merged.programId = merged.programId || merged._raw?.programId || canonical._raw?.programId || null;
  merged.dexType = canonical.dexType || merged.dexType;
  merged.dex = canonical.dex || merged.dex;
  merged.type = canonical.type || merged.type;

  merged.tokenXMint = canonical.tokenXMint;
  merged.tokenYMint = canonical.tokenYMint;
  merged.tokenXDecimals = canonical.tokenXDecimals;
  merged.tokenYDecimals = canonical.tokenYDecimals;

  merged.reserves = canonical.reserves;
  merged.vaults = canonical.vaults;
  merged.xVault = canonical.vaults?.xVault ?? merged.xVault ?? null;
  merged.yVault = canonical.vaults?.yVault ?? merged.yVault ?? null;
  merged.feeBps = canonical.feeBps;
  merged.feeBpsCanonical = canonical.feeBps;
  merged.feePctCanonical = Number((Number(canonical.feeBps || 0) / 100).toFixed(4));

  if (canonical.tickSpacing !== undefined) merged.tickSpacing = canonical.tickSpacing;
  if (canonical.tickCurrent !== undefined) merged.tickCurrent = canonical.tickCurrent;
  if (canonical.tickArrays !== undefined) merged.tickArrays = canonical.tickArrays;
  if (canonical.liquidity !== undefined) merged.liquidity = canonical.liquidity;
  if (canonical.sqrtPrice !== undefined) merged.sqrtPrice = canonical.sqrtPrice;
  if (enrichment.tickArrayData !== undefined) merged.tickArrayData = enrichment.tickArrayData;
  if (enrichment.remainingAccounts !== undefined) merged.remainingAccounts = enrichment.remainingAccounts;

  if (canonical.binStep !== undefined) merged.binStep = canonical.binStep;
  if (canonical.activeBinId !== undefined) merged.activeBinId = canonical.activeBinId;
  if (enrichment.bins !== undefined) merged.bins = enrichment.bins;
  else if (canonical.bins !== undefined) merged.bins = canonical.bins;
  if (enrichment.binArrays !== undefined) merged.binArrays = enrichment.binArrays;
  else if (canonical.binArrays !== undefined) merged.binArrays = canonical.binArrays;

  merged.aux = { ...(merged.aux || {}), ...(builtAux || {}) };
  merged.normalized = canonical;
  merged.normalization = validation;

  return merged;
}

/* -------------------------------------------------------------------------- */
/*                               Diagnostics                                  */
/* -------------------------------------------------------------------------- */

function collectExecutionBlockers(type, pool, canonical, validation) {
  const blockers = [];
  if (!validation.valid) {
    blockers.push(...validation.errors.map((error) => `canonical:${error}`));
  }
  const reservesOk = hasCanonicalReserves(pool, canonical);
  const tickArrays = countArray(pool?.tickArrays);
  const tickArrayData = countArray(pool?.tickArrayData) || countArray(pool?.aux?.whirlpool?.tickArrays);
  const ticks = countArray(pool?.ticks) || countArray(pool?.aux?.whirlpool?.ticks) || countArray(pool?.aux?.clmm?.ticks);
  const binArrays = countArray(pool?.binArrays) || countArray(pool?.aux?.dlmm?.binArrays);
  const bins = countArray(pool?.bins) || countArray(pool?.aux?.dlmm?.bins);
  const liquidityOk = hasPositiveAtomic(pool?.liquidity ?? canonical?.liquidity);
  const sqrtPriceOk = hasPositiveAtomic(pool?.sqrtPriceX64 ?? pool?.sqrtPrice ?? canonical?.sqrtPriceX64 ?? canonical?.sqrtPrice);
  const binStepOk = hasPositiveNumber(pool?.binStep ?? canonical?.binStep);
  const activeBinPresent = Number.isFinite(Number(pool?.activeBinId ?? canonical?.activeBinId));

  if (!pool?.enriched) blockers.push('enrichment:failed');
  if (pool?.error) blockers.push(`enrichment:${pool.error}`);
  if (pool?.liveError) blockers.push(`live:${pool.liveError}`);

  switch (type) {
    case 'cpmm':
      if (!reservesOk) blockers.push('state:missing-reserves');
      break;
    case 'clmm':
      if (!reservesOk) blockers.push('state:missing-reserves');
      if (!tickArrays) blockers.push('state:missing-tick-arrays');
      if (!ticks) blockers.push('state:missing-ticks');
      if (!liquidityOk) blockers.push('state:missing-liquidity');
      if (!sqrtPriceOk) blockers.push('state:missing-sqrt-price');
      break;
    case 'whirlpool':
      if (!reservesOk) blockers.push('state:missing-reserves');
      if (!tickArrays) blockers.push('state:missing-tick-arrays');
      if (!tickArrayData) blockers.push('state:missing-structured-tick-arrays');
      if (!ticks) blockers.push('state:missing-ticks');
      if (!liquidityOk) blockers.push('state:missing-liquidity');
      if (!sqrtPriceOk) blockers.push('state:missing-sqrt-price');
      break;
    case 'dlmm':
      if (!reservesOk) blockers.push('state:missing-reserves');
      if (!binArrays) blockers.push('state:missing-bin-arrays');
      if (!bins) blockers.push('state:missing-bins');
      if (!binStepOk) blockers.push('state:missing-bin-step');
      if (!activeBinPresent) blockers.push('state:missing-active-bin');
      break;
    default:
      blockers.push(`type:unsupported-${type}`);
      break;
  }

  return Array.from(new Set(blockers));
}

function buildEnrichmentDiagnosticsEntry(pool = {}) {
  const canonical = normalizePoolRecord(pool);
  const validation = validateCanonicalPool(canonical);
  const type = resolvePoolType(pool);
  const blockers = collectExecutionBlockers(type, pool, canonical, validation);

  return {
    poolAddress: pool.address || pool.poolAddress || pool.id || null,
    dex: pool.dex || canonical?.dex || null,
    type,
    dexType: canonical?.dexType || pool.dexType || null,
    enriched: Boolean(pool.enriched),
    canonicalValid: validation.valid,
    canonicalErrors: validation.errors,
    reservesOk: hasCanonicalReserves(pool, canonical),
    liquidityOk: hasPositiveAtomic(pool?.liquidity ?? canonical?.liquidity),
    sqrtPriceOk: hasPositiveAtomic(pool?.sqrtPriceX64 ?? pool?.sqrtPrice ?? canonical?.sqrtPriceX64 ?? canonical?.sqrtPrice),
    tickArrayCount: countArray(pool?.tickArrays),
    structuredTickArrayCount: countArray(pool?.tickArrayData) || countArray(pool?.aux?.whirlpool?.tickArrays),
    tickCount: countArray(pool?.ticks) || countArray(pool?.aux?.whirlpool?.ticks) || countArray(pool?.aux?.clmm?.ticks),
    binArrayCount: countArray(pool?.binArrays) || countArray(pool?.aux?.dlmm?.binArrays),
    binCount: countArray(pool?.bins) || countArray(pool?.aux?.dlmm?.bins),
    tickStrategy: pool?.tickStrategy || null,
    feeBps: canonical?.feeBps,
    liveError: pool?.liveError || null,
    error: pool?.error || null,
    reserveSource: pool?.reserveSource || canonical?._raw?.reserveSource || null,
    remainingAccountCount: countArray(pool?.remainingAccounts),
    executionReady: blockers.length === 0,
    blockers,
  };
}

function buildEnrichmentDebugReport(pools = []) {
  const entries = pools.map(buildEnrichmentDiagnosticsEntry);
  const summary = {
    totalPools: entries.length,
    executionReadyPools: entries.filter((entry) => entry.executionReady).length,
    byType: {},
    topBlockers: {},
  };

  for (const entry of entries) {
    const bucket = summary.byType[entry.type] || {
      total: 0, enriched: 0, executionReady: 0, reservesOk: 0,
      canonicalInvalid: 0, tickArraysPresent: 0, structuredTickArraysPresent: 0,
      ticksPresent: 0, binArraysPresent: 0, binsPresent: 0,
      liquidityPresent: 0, sqrtPricePresent: 0,
    };
    bucket.total += 1;
    if (entry.enriched) bucket.enriched += 1;
    if (entry.executionReady) bucket.executionReady += 1;
    if (entry.reservesOk) bucket.reservesOk += 1;
    if (!entry.canonicalValid) bucket.canonicalInvalid += 1;
    if (entry.tickArrayCount > 0) bucket.tickArraysPresent += 1;
    if (entry.structuredTickArrayCount > 0) bucket.structuredTickArraysPresent += 1;
    if (entry.tickCount > 0) bucket.ticksPresent += 1;
    if (entry.binArrayCount > 0) bucket.binArraysPresent += 1;
    if (entry.binCount > 0) bucket.binsPresent += 1;
    if (entry.liquidityOk) bucket.liquidityPresent += 1;
    if (entry.sqrtPriceOk) bucket.sqrtPricePresent += 1;
    summary.byType[entry.type] = bucket;
    for (const blocker of entry.blockers) {
      summary.topBlockers[blocker] = (summary.topBlockers[blocker] || 0) + 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary,
    pools: entries,
  };
}

function printEnrichmentDebugSummary(report) {
  if (!report?.summary) return;

  console.log('\n🔎 ENRICHMENT DIAGNOSTICS');
  console.log('───────────────────────────────────────────────────────────────────────────');
  console.log(`Execution-ready pools: ${report.summary.executionReadyPools}/${report.summary.totalPools}`);

  for (const [type, stats] of Object.entries(report.summary.byType)) {
    console.log(
      `  ${type}: ready=${stats.executionReady}/${stats.total} `
      + `reserves=${stats.reservesOk}/${stats.total} `
      + `tickArrays=${stats.tickArraysPresent}/${stats.total} `
      + `structured=${stats.structuredTickArraysPresent}/${stats.total} `
      + `ticks=${stats.ticksPresent}/${stats.total} `
      + `bins=${stats.binsPresent}/${stats.total}`,
    );
  }

  const topBlockers = Object.entries(report.summary.topBlockers)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);

  if (topBlockers.length) {
    console.log('\nTop blockers:');
    for (const [blocker, count] of topBlockers) {
      console.log(`  ${blocker}: ${count}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                          Compaction helpers                                */
/* -------------------------------------------------------------------------- */

const QUOTE_KEEP_KEYS = [
  'dexType', 'poolAddress', 'swapForY', 'swapDirection', 'direction',
  'inAmountRaw', 'outAmountRaw', 'minOutAmountRaw',
  'tokenXMint', 'tokenYMint', 'tokenA', 'tokenB', 'mintA', 'mintB',
  'baseMint', 'quoteMint', 'tokenInMint', 'tokenOutMint', 'inputMint', 'outputMint',
  'inAmountDecimal', 'outAmountDecimal', 'minOutAmountDecimal',
  'inAmountHuman', 'outAmountHuman',
  'executionPrice', 'priceImpact', 'priceDiff', 'priceDiffBps',
  'toUsd', 'outputPriceUsd', 'priceSourceUsd',
  'fee', 'feeBps', 'slippageBps',
  'inDecimals', 'outDecimals', 'inputDecimals', 'outputDecimals',
  'success', 'error', 'quoteSource', 'tickStrategy',
  'tickArrays', 'remainingAccounts', 'binArrays', 'bins',
  'binStep', 'activeBinId',
  'sqrtPriceLimitX64', 'liquidity', 'feeAmount', 'sqrtPriceNext', 'tickNext', 'loopCount',
];

const POOL_KEEP_KEYS = [
  'poolAddress', 'address', 'programId',
  'dex', 'dexType', 'type',
  'pair', 'pairLabel',
  'baseSymbol', 'quoteSymbol', 'tokenXSymbol', 'tokenYSymbol', 'tokenSymbol',
  'baseMint', 'quoteMint', 'tokenXMint', 'tokenYMint',
  'baseDecimals', 'quoteDecimals', 'tokenXDecimals', 'tokenYDecimals',
  'reserves', 'xReserve', 'yReserve', 'vaults', 'xVault', 'yVault',
  'feeBps', 'feeBpsCanonical', 'feePctCanonical',
  'tickSpacing', 'tickCurrent', 'tickArrays', 'tickArrayData', 'ticks', 'remainingAccounts',
  'liquidity', 'sqrtPrice', 'sqrtPriceX64',
  'tokenXPriceUsd', 'tokenYPriceUsd', 'basePriceUsd', 'quotePriceUsd',
  'binStep', 'activeBinId', 'bins', 'binArrays',
  'reserveSource', 'tickStrategy', 'tickCount', 'binCount',
  'hasReserves', 'hasRealTicks', 'isMathReady',
  'enriched', 'enrichmentDiagnostics',
];

function compactQuoteOutput(quote = {}) {
  if (!quote || typeof quote !== 'object') return quote;
  const compact = {};
  for (const key of QUOTE_KEEP_KEYS) {
    if (quote[key] !== undefined) compact[key] = quote[key];
  }
  return compact;
}

function compactPoolOutput(pool = {}) {
  if (!pool || typeof pool !== 'object') return pool;
  const compact = {};
  for (const key of POOL_KEEP_KEYS) {
    if (pool[key] !== undefined) compact[key] = pool[key];
  }
  if (pool.quote) compact.quote = compactQuoteOutput(pool.quote);
  if (pool.fastQuote) compact.fastQuote = compactQuoteOutput(pool.fastQuote);
  if (pool.exactQuote) compact.exactQuote = compactQuoteOutput(pool.exactQuote);
  return compact;
}

/* -------------------------------------------------------------------------- */
/*                         Whirlpool enrichment                               */
/* -------------------------------------------------------------------------- */

function buildApproxWhirlpoolEnrichment(pool) {
  const sqrtPriceX64 = String(pool.sqrtPriceX64 || pool.sqrtPrice || '0');
  const xReserve = String(pool.xReserve || pool.reserves?.x || '0');
  const yReserve = String(pool.yReserve || pool.reserves?.y || '0');
  const tickArrays = Array.isArray(pool.tickArrays) ? pool.tickArrays : [];
  const tickArrayData = Array.isArray(pool.tickArrayData) ? pool.tickArrayData : [];

  return {
    sqrtPriceX64,
    sqrtPrice: sqrtPriceX64,
    tickCurrent: Number(pool.tickCurrent ?? pool.tickCurrentIndex ?? 0),
    tickSpacing: Number(pool.tickSpacing ?? 64),
    liquidity: String(pool.liquidity || '0'),
    tickArrays,
    tickArrayData,
    remainingAccounts: Array.isArray(pool.remainingAccounts) ? pool.remainingAccounts : tickArrays,
    ticks: Array.isArray(pool.ticks) ? pool.ticks : [],
    tickCount: Array.isArray(pool.ticks) ? pool.ticks.length : 0,
    hasRealTicks: false,
    tickStrategy: 'adapter-approximation',
    xReserve,
    yReserve,
    hasReserves: xReserve !== '0' && yReserve !== '0',
    aux: {
      whirlpool: {
        sqrtPriceX64,
        tickCurrent: Number(pool.tickCurrent ?? pool.tickCurrentIndex ?? 0),
        tickSpacing: Number(pool.tickSpacing ?? 64),
        liquidity: String(pool.liquidity || '0'),
        tickArrays: tickArrayData,
        remainingAccounts: Array.isArray(pool.remainingAccounts) ? pool.remainingAccounts : tickArrays,
        approximation: true,
      },
    },
    enriched: true,
  };
}

function buildStructuredTickArrayData(address, startTickIndex, rawTicks = []) {
  return normalizeStructuredTickArray({
    address,
    data: {
      startTickIndex,
      ticks: Array.isArray(rawTicks)
        ? rawTicks.map((tick = {}) => ({
          initialized: tick.initialized !== undefined
            ? Boolean(tick.initialized)
            : ((tick.liquidityGross?.toString?.() || String(tick.liquidityGross || '0')) !== '0'),
          liquidityNet: tick.liquidityNet?.toString?.() || String(tick.liquidityNet || '0'),
          liquidityGross: tick.liquidityGross?.toString?.() || String(tick.liquidityGross || '0'),
        }))
        : [],
    },
  });
}

/**
 * Whirlpool enrichment in 2 round trips:
 *   RT1 — pool account
 *   RT2 — getMultipleAccountsInfo([vaultA, vaultB, ...7 tickArray PDAs])
 *
 * Was 1 + 7 + 2 = 10 RPCs (7 of them sequential).
 */
async function enrichWhirlpool(pool, connection) {
  if (!connection) return buildApproxWhirlpoolEnrichment(pool);

  try {
    const poolAddress = new PublicKey(pool.address || pool.poolAddress);

    // RT1: pool state.
    const poolAccount = await connection.getAccountInfo(poolAddress);
    if (!poolAccount) throw new Error(`Pool account not found: ${poolAddress.toBase58()}`);

    const poolState = ParsableWhirlpool.parse(poolAddress, poolAccount);
    if (!poolState) throw new Error('Failed to parse whirlpool account');

    const tickCurrent = poolState.tickCurrentIndex || poolState.currentTickIndex || 0;
    const tickSpacing = poolState.tickSpacing || Number(pool.tickSpacing ?? 1);
    const sqrtPriceX64 = (poolState.sqrtPrice || poolState.sqrtPriceX64 || '0').toString();
    const liquidity = (poolState.liquidity || '0').toString();

    const tokenVaultA = poolState.tokenVaultA || poolState.tokenVault0 || poolState.vaultA || getVaultAddress(pool, 'x');
    const tokenVaultB = poolState.tokenVaultB || poolState.tokenVault1 || poolState.vaultB || getVaultAddress(pool, 'y');
    const xVault = tokenVaultA?.toBase58?.() || tokenVaultA?.toString?.() || null;
    const yVault = tokenVaultB?.toBase58?.() || tokenVaultB?.toString?.() || null;

    // Build the tick-array PDA list.
    const tickArrayRefs = [];
    for (const offset of CONFIG.WHIRLPOOL_TICK_ARRAY_OFFSETS) {
      try {
        const startIndex = TickUtil.getStartTickIndex(tickCurrent, tickSpacing, offset);
        const pda = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, poolAddress, startIndex);
        tickArrayRefs.push({ startIndex, address: pda.publicKey });
      } catch (_e) {
        // out-of-range offset; ignore.
      }
    }

    // RT2: vaults + tick arrays in a single batch.
    const batchKeys = [];
    if (tokenVaultA) batchKeys.push(asPublicKey(tokenVaultA));
    if (tokenVaultB) batchKeys.push(asPublicKey(tokenVaultB));
    const tickArrayKeyOffset = batchKeys.length;
    for (const ref of tickArrayRefs) batchKeys.push(ref.address);

    const accounts = batchKeys.length
      ? await connection.getMultipleAccountsInfo(batchKeys)
      : [];

    let xReserve = '0';
    let yReserve = '0';
    if (tokenVaultA) {
      const vaultA = accounts[0];
      xReserve = vaultA ? (parseSplTokenAmount(vaultA.data) || '0') : '0';
    }
    if (tokenVaultB) {
      const vaultB = accounts[tokenVaultA ? 1 : 0];
      yReserve = vaultB ? (parseSplTokenAmount(vaultB.data) || '0') : '0';
    }

    const ticks = [];
    const tickArrays = [];
    const tickArrayData = [];
    for (let i = 0; i < tickArrayRefs.length; i += 1) {
      const tickArrayAccount = accounts[tickArrayKeyOffset + i];
      if (!tickArrayAccount) continue;
      try {
        const tickArrayAddress = tickArrayRefs[i].address.toBase58();
        const tickArrayParsed = ParsableTickArray.parse(tickArrayRefs[i].address, tickArrayAccount);
        if (!tickArrayParsed?.ticks) continue;
        tickArrays.push(tickArrayAddress);
        tickArrayData.push(buildStructuredTickArrayData(
          tickArrayAddress,
          tickArrayRefs[i].startIndex,
          tickArrayParsed.ticks,
        ));

        for (let j = 0; j < tickArrayParsed.ticks.length; j += 1) {
          const tick = tickArrayParsed.ticks[j];
          if (!tick?.initialized || !tick.liquidityGross || tick.liquidityGross.lte(new BN(0))) continue;
          ticks.push({
            index: tickArrayRefs[i].startIndex + j,
            initialized: true,
            liquidityNet: tick.liquidityNet?.toString?.() || '0',
            liquidityGross: tick.liquidityGross.toString(),
          });
        }
      } catch (_error) {
        // Skip malformed tick array; keep going.
      }
    }
    ticks.sort((a, b) => a.index - b.index);

    return {
      sqrtPriceX64,
      sqrtPrice: sqrtPriceX64.toString(),
      tickCurrent,
      tickSpacing,
      liquidity,
      tickArrays,
      tickArrayData,
      remainingAccounts: tickArrays,
      ticks,
      tickCount: ticks.length,
      hasRealTicks: ticks.length > 0,
      tickStrategy: ticks.length > 0 ? 'rpc-live' : 'rpc-state-only',
      xVault,
      yVault,
      vaults: { xVault, yVault },
      xReserve,
      yReserve,
      hasReserves: xReserve !== '0' && yReserve !== '0',
      aux: {
        whirlpool: {
          sqrtPriceX64,
          tickCurrent,
          tickSpacing,
          liquidity,
          tickArrays: tickArrayData,
          ticks,
        },
      },
      enriched: true,
    };
  } catch (error) {
    return {
      ...buildApproxWhirlpoolEnrichment(pool),
      liveError: error.message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                            CLMM enrichment                                 */
/* -------------------------------------------------------------------------- */

/**
 * CLMM enrichment in 3 round trips:
 *   RT1 — pool account
 *   RT2 — vaults batch
 *   RT3 — tick arrays batch
 *
 * Could be folded to 2 RTs by combining RT2+RT3 (same pattern as Whirlpool),
 * left at 3 because the order of vault addresses is determined from the pool
 * state, and combining adds one extra dependency on parsing the pool first.
 * The downstream concurrency already covers it.
 */
async function enrichCLMM(pool, connection) {
  if (!connection) {
    return { hasReserves: false, enriched: false, error: 'CLMM enrichment requires an RPC connection' };
  }

  try {
    const poolAddress = new PublicKey(pool.address || pool.poolAddress);

    const account = await connection.getAccountInfo(poolAddress);
    if (!account) throw new Error('Pool account not found');

    const raydiumClmmProgramId = account.owner;
    const poolState = RaydiumClmmPoolInfoLayout.decode(account.data);
    const sqrtPriceX64 = poolState.sqrtPriceX64?.toString?.() || String(poolState.sqrtPriceX64 || pool.sqrtPriceX64 || '0');
    const liquidity = poolState.liquidity?.toString?.() || String(poolState.liquidity || pool.liquidity || '0');
    const tickCurrent = Number(poolState.tickCurrent ?? pool.tickCurrent ?? 0);
    const tickSpacing = Number(poolState.tickSpacing ?? pool.tickSpacing ?? 1);

    let xReserve = String(pool.xReserve || pool.reserves?.x || '0');
    let yReserve = String(pool.yReserve || pool.reserves?.y || '0');
    const xVaultRaw = poolState.vaultA || getVaultAddress(pool, 'x');
    const yVaultRaw = poolState.vaultB || getVaultAddress(pool, 'y');
    const xVault = xVaultRaw?.toBase58?.() || xVaultRaw?.toString?.() || null;
    const yVault = yVaultRaw?.toBase58?.() || yVaultRaw?.toString?.() || null;

    // Build tick-array PDAs.
    const tickArraySpan = tickSpacing * 60;
    const currentStartIndex = RaydiumTickUtils.getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
    const startIndexes = CONFIG.CLMM_TICK_ARRAY_OFFSETS.map((offset) => currentStartIndex + offset * tickArraySpan);
    const tickArrayRefs = startIndexes.map((startIndex) => ({
      startIndex,
      address: getRaydiumClmmTickArrayAddress(raydiumClmmProgramId, poolAddress, startIndex).publicKey,
    }));

    // Single combined batch: vaults + tick arrays.
    const batchKeys = [];
    if (xVault) batchKeys.push(new PublicKey(xVault));
    if (yVault) batchKeys.push(new PublicKey(yVault));
    const tickOffset = batchKeys.length;
    for (const ref of tickArrayRefs) batchKeys.push(ref.address);

    const accounts = batchKeys.length
      ? await connection.getMultipleAccountsInfo(batchKeys).catch(() => [])
      : [];

    if (xVault) {
      const vaultA = accounts[0];
      xReserve = vaultA ? (parseSplTokenAmount(vaultA.data) || xReserve) : xReserve;
    }
    if (yVault) {
      const vaultB = accounts[xVault ? 1 : 0];
      yReserve = vaultB ? (parseSplTokenAmount(vaultB.data) || yReserve) : yReserve;
    }

    const ticks = [];
    const tickArrays = [];
    const tickArrayData = [];
    for (let i = 0; i < tickArrayRefs.length; i += 1) {
      const accountInfo = accounts[tickOffset + i];
      if (!accountInfo) continue;
      try {
        const decoded = RaydiumClmmTickArrayLayout.decode(accountInfo.data);
        const tickArrayAddress = tickArrayRefs[i].address.toBase58();
        const startIndex = Number(decoded.startTickIndex ?? tickArrayRefs[i].startIndex);
        tickArrays.push(tickArrayAddress);
        tickArrayData.push(buildStructuredTickArrayData(tickArrayAddress, startIndex, decoded.ticks));

        for (let j = 0; j < decoded.ticks.length; j += 1) {
          const tick = decoded.ticks[j];
          const liquidityGross = tick?.liquidityGross?.toString?.() || String(tick?.liquidityGross || '0');
          if (liquidityGross === '0') continue;
          ticks.push({
            tickIndex: Number(tick?.tick ?? (startIndex + (j * tickSpacing))),
            index: Number(tick?.tick ?? (startIndex + (j * tickSpacing))),
            liquidityNet: tick?.liquidityNet?.toString?.() || '0',
            liquidityGross,
            initialized: true,
          });
        }
      } catch (_error) {
        // Skip malformed tick-array account.
      }
    }
    ticks.sort((left, right) => left.tickIndex - right.tickIndex);

    const hasReserves = xReserve !== '0' && yReserve !== '0';
    const hasRealTicks = ticks.length > 0;

    return {
      sqrtPriceX64,
      sqrtPrice: sqrtPriceX64,
      liquidity,
      tickCurrent,
      tickSpacing,
      tickArrays,
      tickArrayData,
      remainingAccounts: tickArrays,
      ticks,
      tickCount: ticks.length,
      hasRealTicks,
      tickStrategy: hasRealTicks ? 'rpc-live' : 'rpc-state-only',
      xVault,
      yVault,
      vaults: { xVault, yVault },
      xReserve,
      yReserve,
      hasReserves,
      aux: {
        clmm: {
          sqrtPriceX64,
          tickCurrent,
          tickSpacing,
          liquidity,
          tickArrays,
          tickArrayData,
          ticks,
        },
      },
      enriched: true,
    };
  } catch (error) {
    return { hasReserves: false, enriched: false, error: error.message };
  }
}

/* -------------------------------------------------------------------------- */
/*                            DLMM enrichment                                 */
/* -------------------------------------------------------------------------- */

function getPriceFromBinId(binId, binStep) {
  // P = (1 + binStep/10000)^binId — DLMM canonical bin price formula.
  const base = 1 + binStep / 10000;
  return Math.pow(base, binId);
}

function priceToQ64(price) {
  const scale = 2n ** 64n;
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) return '0';
  return BigInt(Math.floor(priceNum * Number(scale))).toString();
}

function normalizeDlmmBinForOutput(bin, fallbackFeeBps = 25) {
  const xAmount = String(bin.xAmount || bin.x_amount || bin.reserveA || bin.amount_x || '0');
  const yAmount = String(bin.yAmount || bin.y_amount || bin.reserveB || bin.amount_y || '0');
  const binId = Number(bin.binId ?? bin.bin_id ?? bin.id ?? 0);
  const fallbackPrice = bin.price ?? (
    Number.isFinite(bin.binStep) || Number.isFinite(bin.bin_step)
      ? getPriceFromBinId(binId, Number(bin.binStep ?? bin.bin_step ?? 0))
      : null
  );
  const fallbackPxQ64 = bin.priceAB_Q64 || bin.pxAB_Q64
    || (fallbackPrice != null ? priceToQ64(fallbackPrice) : null);

  return {
    binId,
    price: fallbackPrice,
    pxAB_Q64: fallbackPxQ64,
    priceAB_Q64: fallbackPxQ64,
    reserveA: xAmount,
    reserveB: yAmount,
    xAmount,
    yAmount,
    liquidity: String(bin.liquidity || (BigInt(xAmount) + BigInt(yAmount)).toString()),
    feeBps: Number(bin.feeBps || fallbackFeeBps),
  };
}

function deriveBinArrayPubkey(lbPair, index) {
  // Wrapper around binArray_util's deriveBinArray that returns just the key,
  // for parity with the previous local helper.
  const [pubkey] = deriveBinArray(lbPair, index, DLMM_PROGRAM_ID);
  return pubkey;
}

/**
 * DLMM enrichment in 2 round trips:
 *   RT1 — pair account (active_id, bin_step)
 *   RT2 — getMultipleAccountsInfo([...9 binArrays, vaultX, vaultY])
 */
async function enrichDLMM(pool, connection) {
  try {
    let activeBinId = Number(pool.activeBinId || pool.activeId || 0);
    let binStep = Number(pool.binStep || 0);
    let bins = [];
    let binArrays = [];

    if (connection) {
      const poolAddress = new PublicKey(pool.address || pool.poolAddress);

      // RT1: pair account
      const pairAccount = await connection.getAccountInfo(poolAddress).catch(() => null);
      if (pairAccount && dlmmCoder) {
        try {
          const lbPair = dlmmCoder.decode('LbPair', pairAccount.data);
          if (lbPair) {
            activeBinId = lbPair.active_id !== undefined ? Number(lbPair.active_id) : activeBinId;
            binStep = lbPair.bin_step !== undefined ? Number(lbPair.bin_step) : binStep;
          }
        } catch (_e) {
          // Borsh decode failed — keep the input values and proceed.
        }
      }

      const activeArrayIndex = binIdToBinArrayIndex(activeBinId);
      const binArrayIndexes = CONFIG.DLMM_BIN_ARRAY_OFFSETS.map((offset) => activeArrayIndex + offset);
      const binArrayPubkeys = binArrayIndexes.map((idx) => deriveBinArrayPubkey(poolAddress, idx));
      const xVaultAddr = getVaultAddress(pool, 'x');
      const yVaultAddr = getVaultAddress(pool, 'y');

      // RT2: bin arrays + vaults in one batch.
      const batchKeys = [...binArrayPubkeys];
      const vaultBaseOffset = batchKeys.length;
      if (xVaultAddr) batchKeys.push(asPublicKey(xVaultAddr));
      if (yVaultAddr) batchKeys.push(asPublicKey(yVaultAddr));

      const accounts = batchKeys.length
        ? await connection.getMultipleAccountsInfo(batchKeys).catch(() => [])
        : [];

      // Decode bin arrays
      for (let i = 0; i < binArrayIndexes.length; i += 1) {
        const accountInfo = accounts[i];
        if (!accountInfo) continue;
        try {
          const decoded = dlmmCoder.decode('BinArray', accountInfo.data);
          const rawBins = decoded?.bins || [];
          const binArrayIndex = binArrayIndexes[i];
          binArrays.push({
            address: binArrayPubkeys[i].toBase58(),
            index: binArrayIndex,
            binStep,
          });

          for (let j = 0; j < rawBins.length; j += 1) {
            const bin = rawBins[j];
            const xAmount = bin?.amount_x?.toString?.() || bin?.xAmount?.toString?.() || '0';
            const yAmount = bin?.amount_y?.toString?.() || bin?.yAmount?.toString?.() || '0';
            if (xAmount === '0' && yAmount === '0') continue;
            const binId = (binArrayIndex * MAX_BIN_ARRAY_SIZE) + j;
            bins.push(normalizeDlmmBinForOutput({
              binId,
              xAmount,
              yAmount,
              liquidity: bin?.liquidity?.toString?.() || (BigInt(xAmount) + BigInt(yAmount)).toString(),
              binStep,
              price: getPriceFromBinId(binId, binStep),
            }, pool.feeBps || 25));
          }
        } catch (_e) {
          // Skip malformed bin array.
        }
      }

      // Pull vault reserves out of the same batch (no extra RTT)
      let xReserveLive = null;
      let yReserveLive = null;
      if (xVaultAddr) {
        const vaultA = accounts[vaultBaseOffset];
        xReserveLive = vaultA ? parseSplTokenAmount(vaultA.data) : null;
      }
      if (yVaultAddr) {
        const vaultB = accounts[vaultBaseOffset + (xVaultAddr ? 1 : 0)];
        yReserveLive = vaultB ? parseSplTokenAmount(vaultB.data) : null;
      }

      // Stash for the assembler below.
      pool.__dlmmLiveReserveX = xReserveLive;
      pool.__dlmmLiveReserveY = yReserveLive;
    }

    if (bins.length === 0) {
      // Use binArray_util.normalizeBins to populate from input data only.
      const normalizedRawBins = normalizeBins(pool.bins || [], binStep, activeBinId);
      bins = normalizedRawBins
        .map((bin) => normalizeDlmmBinForOutput(bin, pool.feeBps || 25))
        .sort((a, b) => a.binId - b.binId);
    }

    if (binArrays.length === 0) {
      const derivedBinRange = getBinRangeFromActiveId(activeBinId, binStep);
      const sourceBinArrays = Array.isArray(pool.binArrays)
        ? pool.binArrays
        : getBinArraysRequiredByPositionRange(
          pool.address || pool.poolAddress || pool.id,
          derivedBinRange.min,
          derivedBinRange.max,
          DLMM_PROGRAM_ID,
        );
      binArrays = normalizeBinArrays(sourceBinArrays, binStep, activeBinId);
    }

    const derivedBinRange = getBinRangeFromActiveId(activeBinId, binStep);
    const xVault = getVaultAddress(pool, 'x');
    const yVault = getVaultAddress(pool, 'y');

    const xReserve = pool.__dlmmLiveReserveX
      || String(pool.xReserve || pool.reserves?.x || '0');
    const yReserve = pool.__dlmmLiveReserveY
      || String(pool.yReserve || pool.reserves?.y || '0');
    delete pool.__dlmmLiveReserveX;
    delete pool.__dlmmLiveReserveY;

    const hasBins = bins.length > 0;
    const hasReserves = xReserve !== '0' && yReserve !== '0';

    return {
      bins,
      binCount: bins.length,
      hasRealBins: hasBins,
      activeBinId,
      binStep,
      binArrays,
      binRange: derivedBinRange,

      xReserve,
      yReserve,
      hasReserves,
      xVault,
      yVault,
      vaults: { xVault, yVault },

      aux: {
        dlmm: {
          bins,
          binArrays,
          binRange: derivedBinRange,
          activeBinId,
          binStep,
        },
      },

      enriched: true,
    };
  } catch (error) {
    return {
      hasRealBins: false,
      hasReserves: false,
      enriched: false,
      error: error.message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                            CPMM enrichment                                 */
/* -------------------------------------------------------------------------- */

/**
 * CPMM enrichment in 2 round trips when vaults are pre-known, 3 otherwise:
 *   RT1 — pool account (to discover programId + vaults if not already cached)
 *   RT2 — vaults batch
 */
async function enrichCPMM(pool, connection) {
  try {
    let xReserve = String(pool.xReserve || pool.reserves?.x || '0');
    let yReserve = String(pool.yReserve || pool.reserves?.y || '0');
    let xVault = getVaultAddress(pool, 'x');
    let yVault = getVaultAddress(pool, 'y');
    let programId = String(pool.programId || pool._raw?.programId || '');
    let reserveSource = 'input-reserves';
    let liveVaults = false;

    if (connection) {
      const poolAddress = new PublicKey(pool.address || pool.poolAddress);
      const account = await connection.getAccountInfo(poolAddress).catch(() => null);
      if (account) {
        programId = account.owner?.toBase58?.() || account.owner?.toString?.() || programId;
        if (programId === CONFIG.RAYDIUM_AMM_V4) {
          const poolState = liquidityStateV4Layout.decode(account.data);
          xVault = poolState?.baseVault?.toBase58?.() || poolState?.baseVault?.toString?.() || xVault;
          yVault = poolState?.quoteVault?.toBase58?.() || poolState?.quoteVault?.toString?.() || yVault;
        } else if (programId === CONFIG.RAYDIUM_CPMM) {
          const poolState = CpmmPoolInfoLayout.decode(account.data);
          xVault = poolState?.vaultA?.toBase58?.() || poolState?.vaultA?.toString?.() || xVault;
          yVault = poolState?.vaultB?.toBase58?.() || poolState?.vaultB?.toString?.() || yVault;
        }
      }

      if (xVault && yVault) {
        // Single batched vault fetch instead of two parallel single calls.
        const vaults = await connection.getMultipleAccountsInfo(
          [new PublicKey(xVault), new PublicKey(yVault)],
        ).catch(() => []);
        const nextXReserve = vaults[0] ? parseSplTokenAmount(vaults[0].data) : null;
        const nextYReserve = vaults[1] ? parseSplTokenAmount(vaults[1].data) : null;
        if (nextXReserve && nextYReserve) {
          xReserve = nextXReserve;
          yReserve = nextYReserve;
          reserveSource = 'rpc-live-vaults';
          liveVaults = true;
        }
      }
    }

    const hasReserves = xReserve !== '0' && yReserve !== '0';

    return {
      xReserve,
      yReserve,
      xVault,
      yVault,
      vaults: { xVault, yVault },
      programId: programId || null,
      hasReserves,
      reserveSource,
      feeBps: pool.feeBps || 25,
      enriched: liveVaults,
    };
  } catch (error) {
    return { hasReserves: false, enriched: false, error: error.message };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Orchestrator                                  */
/* -------------------------------------------------------------------------- */

const EMPTY_STATS = () => ({
  whirlpool: { total: 0, success: 0, reservesOk: 0, livePath: 0, approxPath: 0, realTicks: 0 },
  clmm: { total: 0, success: 0, reservesOk: 0 },
  dlmm: { total: 0, success: 0, reservesOk: 0, realBins: 0 },
  cpmm: { total: 0, success: 0, reservesOk: 0 },
});

async function enrichOnePool(pool, connection, stats) {
  const type = resolvePoolType(pool);
  const poolId = pool.address || pool.poolAddress || pool.id || 'unknown';
  const shortPoolId = String(poolId).slice(0, 8);
  const dex = pool.dex || 'unknown-dex';

  // Fast path: trust pre-canonicalized input.
  if (isFreshCanonicalInput(pool) && pool.enriched === true) {
    const wired = wireCanonicalAndAux(pool, {});
    Object.assign(pool, wired);
    const diag = buildEnrichmentDiagnosticsEntry(pool);
    if (diag.executionReady) {
      console.log(`[skip] ${dex}/${type} ${shortPoolId} ↪ trusted canonical input, ready=YES`);
      return;
    }
  }

  let enrichment;
  try {
    switch (type) {
      case 'whirlpool':
        stats.whirlpool.total++;
        enrichment = await enrichWhirlpool(pool, connection);
        if (enrichment.enriched) {
          stats.whirlpool.success++;
          if (enrichment.hasReserves) stats.whirlpool.reservesOk++;
          if (enrichment.hasRealTicks) stats.whirlpool.realTicks++;
          if (enrichment.tickStrategy === 'adapter-approximation') stats.whirlpool.approxPath++;
          else stats.whirlpool.livePath++;
        }
        break;
      case 'clmm':
        stats.clmm.total++;
        enrichment = await enrichCLMM(pool, connection);
        if (enrichment.enriched) {
          stats.clmm.success++;
          if (enrichment.hasReserves) stats.clmm.reservesOk++;
        }
        break;
      case 'dlmm':
        stats.dlmm.total++;
        enrichment = await enrichDLMM(pool, connection);
        if (enrichment.enriched) {
          stats.dlmm.success++;
          if (enrichment.hasReserves) stats.dlmm.reservesOk++;
          if (enrichment.hasRealBins) stats.dlmm.realBins++;
        }
        break;
      case 'cpmm':
        stats.cpmm.total++;
        enrichment = await enrichCPMM(pool, connection);
        if (enrichment.enriched) {
          stats.cpmm.success++;
          if (enrichment.hasReserves) stats.cpmm.reservesOk++;
        }
        break;
      default:
        console.log(`[skip] unknown pool type: ${type}`);
        return;
    }

    const wired = wireCanonicalAndAux(pool, enrichment);
    Object.assign(pool, wired);

    const diag = buildEnrichmentDiagnosticsEntry(pool);
    const blockersLabel = diag.blockers.length ? diag.blockers.join(', ') : 'none';
    const status = diag.executionReady ? '✓' : '·';
    console.log(
      `${status} ${dex}/${type} ${shortPoolId} `
      + `ready=${diag.executionReady ? 'YES' : 'NO'} `
      + `reserves=${diag.reservesOk ? 'OK' : 'MISS'} `
      + `tickArrays=${diag.tickArrayCount}/${diag.structuredTickArrayCount} `
      + `ticks=${diag.tickCount} bins=${diag.binCount} `
      + `blockers=${blockersLabel}`,
    );
  } catch (error) {
    console.log(`✗ ${dex}/${type} ${shortPoolId}: ${error.message}`);
    pool.error = error.message;
    pool.enriched = false;
  }
}

async function enrichAllPools(pools, connection, options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency || CONFIG.CONCURRENCY));
  console.log(`\n🔄 Enriching ${pools.length} pools (concurrency=${concurrency})...\n`);

  const startedAt = Date.now();
  const stats = EMPTY_STATS();

  // Pre-canonicalize so the wire shape exists even before enrichment data arrives.
  for (let i = 0; i < pools.length; i += 1) {
    Object.assign(pools[i], wireCanonicalAndAux(pools[i], {}));
  }

  await processInBatches(pools, async (pool) => {
    await enrichOnePool(pool, connection, stats);
  }, { batchSize: concurrency });

  const elapsedMs = Date.now() - startedAt;

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('📊 ENRICHMENT SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════');

  console.log('\nWhirlpool:');
  console.log(`  Total: ${stats.whirlpool.total}`);
  console.log(`  Processed: ${stats.whirlpool.success}`);
  console.log(`  Live path: ${stats.whirlpool.livePath}`);
  console.log(`  Approx path: ${stats.whirlpool.approxPath}`);
  console.log(`  Real ticks: ${stats.whirlpool.realTicks}`);
  console.log(`  Reserves OK: ${stats.whirlpool.reservesOk}`);

  console.log('\nCLMM:');
  console.log(`  Total: ${stats.clmm.total}`);
  console.log(`  Processed: ${stats.clmm.success}`);
  console.log(`  Reserves OK: ${stats.clmm.reservesOk}`);

  console.log('\nDLMM:');
  console.log(`  Total: ${stats.dlmm.total}`);
  console.log(`  Processed: ${stats.dlmm.success}`);
  console.log(`  Real bins: ${stats.dlmm.realBins}`);
  console.log(`  Reserves OK: ${stats.dlmm.reservesOk}`);

  console.log('\nCPMM:');
  console.log(`  Total: ${stats.cpmm.total}`);
  console.log(`  Processed: ${stats.cpmm.success}`);
  console.log(`  Reserves OK: ${stats.cpmm.reservesOk}`);

  const totalSuccess = Object.values(stats).reduce((sum, s) => sum + s.success, 0);
  const totalPools = Object.values(stats).reduce((sum, s) => sum + s.total, 0);

  console.log(`\n✅ Total processed: ${totalSuccess}/${totalPools}  ·  elapsed: ${elapsedMs}ms`);
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  return pools;
}

/* -------------------------------------------------------------------------- */
/*                                 CLI                                        */
/* -------------------------------------------------------------------------- */

function parseCliArgs(argv) {
  const out = {
    inputPath: '02_filtered.json',
    outputPath: '03_enriched.json',
    debugReportPath: null,
    debugSummary: false,
    debugQuotes: false,
    concurrency: CONFIG.CONCURRENCY,
  };

  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in' || arg === '--input') {
      out.inputPath = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : out.inputPath;
      continue;
    }
    if (arg === '--out' || arg === '--output') {
      out.outputPath = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : out.outputPath;
      continue;
    }
    if (arg === '--debug-report') {
      out.debugReportPath = argv[i + 1] && !argv[i + 1].startsWith('--')
        ? argv[++i]
        : 'raw_enrichment_diagnostics.json';
      continue;
    }
    if (arg === '--debug-summary') { out.debugSummary = true; continue; }
    if (arg === '--debug-quotes') { out.debugQuotes = true; continue; }
    if (arg === '--concurrency') {
      out.concurrency = Number(argv[i + 1]) || out.concurrency;
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  if (positional[0]) out.inputPath = positional[0];
  if (positional[1]) out.outputPath = positional[1];
  if (!out.debugReportPath && process.env.ENRICHMENT_DEBUG_REPORT) {
    out.debugReportPath = process.env.ENRICHMENT_DEBUG_REPORT;
  }
  if (!out.debugSummary && process.env.ENRICHMENT_DEBUG_SUMMARY === '1') out.debugSummary = true;
  if (!out.debugQuotes && process.env.ENRICHMENT_DEBUG_QUOTES === '1') out.debugQuotes = true;

  return out;
}

function extractPoolsFromInput(rawInput) {
  if (Array.isArray(rawInput)) return rawInput;
  if (Array.isArray(rawInput?.pools)) return rawInput.pools;
  if (Array.isArray(rawInput?.data)) return rawInput.data;
  if (rawInput?.poolShape && typeof rawInput.poolShape === 'object') {
    return [{
      ...rawInput.poolShape,
      address: rawInput.poolShape.address || rawInput.poolShape.poolAddress || rawInput.poolAddress,
      poolAddress: rawInput.poolShape.poolAddress || rawInput.poolShape.address || rawInput.poolAddress,
    }];
  }
  if (rawInput && typeof rawInput === 'object' && (rawInput.address || rawInput.poolAddress || rawInput.id)) {
    return [rawInput];
  }
  return [];
}

function mergeOutputPayload(rawInput, pools, debugReport = null) {
  if (Array.isArray(rawInput)) return pools;
  if (Array.isArray(rawInput?.pools)) return { ...rawInput, pools };
  if (Array.isArray(rawInput?.data)) return { ...rawInput, data: pools };
  if (rawInput?.poolShape && typeof rawInput.poolShape === 'object') {
    return {
      ...rawInput,
      poolShape: pools[0] || rawInput.poolShape,
      enrichmentDiagnostics: debugReport?.pools?.[0] || null,
    };
  }
  if (rawInput && typeof rawInput === 'object' && (rawInput.address || rawInput.poolAddress || rawInput.id)) {
    return { ...rawInput, ...(pools[0] || {}), enrichmentDiagnostics: debugReport?.pools?.[0] || null };
  }
  return { ...rawInput, pools };
}

async function main() {
  const args = parseCliArgs(process.argv);
  const { inputPath, outputPath, debugReportPath, debugSummary, debugQuotes, concurrency } = args;

  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  UNIFIED POOL ENRICHMENT - All Types (refactored)                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');

  console.log(`\n📦 Loading pools from: ${inputPath}`);
  const rawInput = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const pools = extractPoolsFromInput(rawInput);
  console.log(`   Loaded ${pools.length} pools`);

  const needsRpc = pools.some((pool) => ['clmm', 'whirlpool', 'dlmm', 'cpmm'].includes(resolvePoolType(pool)));
  let connection = null;

  if (needsRpc) {
    const rpcUrls = getConfiguredRpcUrls();
    if (!rpcUrls.length) {
      console.error('❌ Enrichment requires HELIUS_ENDPOINT*/RPC_URL in .env for live pool data');
      process.exit(1);
    }
    console.log(`\n🔌 Connecting to RPC pool for live enrichment...`);
    console.log(`   Endpoints: ${rpcUrls.length}`);
    if (rpcUrls.length === 1) {
      console.log('   RPC rotation: single endpoint configured; add HELIUS_ENDPOINT2+ for failover/load spread');
    } else {
      console.log(`   RPC rotation: enabled across ${rpcUrls.length} endpoints`);
    }
    connection = createRpcConnection({ urls: rpcUrls, commitment: 'confirmed' });
  } else {
    console.log(`\n🔌 No RPC-backed pools detected; skipping RPC connection`);
  }

  await enrichAllPools(pools, connection, { concurrency });

  const debugReport = buildEnrichmentDebugReport(pools);
  if (debugSummary || debugReportPath) printEnrichmentDebugSummary(debugReport);
  if (debugReportPath) {
    fs.writeFileSync(debugReportPath, safeStringify(debugReport));
    console.log(`\n📝 Diagnostics report saved to: ${debugReportPath}`);
  }

  console.log(`💾 Saving to: ${outputPath}`);
  const outputPayload = mergeOutputPayload(rawInput, pools, debugReport);
  const compactPayload = Array.isArray(outputPayload)
    ? outputPayload.map(compactPoolOutput)
    : {
      ...outputPayload,
      pools: Array.isArray(outputPayload?.pools) ? outputPayload.pools.map(compactPoolOutput) : outputPayload?.pools,
      data: Array.isArray(outputPayload?.data) ? outputPayload.data.map(compactPoolOutput) : outputPayload?.data,
      poolShape: outputPayload?.poolShape ? compactPoolOutput(outputPayload.poolShape) : outputPayload?.poolShape,
    };
  fs.writeFileSync(outputPath, safeStringify(compactPayload));
  console.log(`   ✓ Saved ${pools.length} pools\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
}
// node utilities/Q_enrichment.js --in 02_filtered.json --out 03_enriched.json

module.exports = {
  enrichAllPools,
  enrichWhirlpool,
  enrichCLMM,
  enrichDLMM,
  enrichCPMM,
  buildEnrichmentDebugReport,
  buildEnrichmentDiagnosticsEntry,
  printEnrichmentDebugSummary,
  parseCliArgs,
  extractPoolsFromInput,
  mergeOutputPayload,
  // re-export from binArray_util for backward compatibility with old callers
  MAX_BIN_ARRAY_SIZE,
  DEFAULT_BIN_PER_POSITION,
  binIdToBinArrayIndex,
  getBinArrayLowerUpperBinId,
  getBinIdIndexInBinArray,
  getBinArraysRequiredByPositionRange,
  getBinRangeFromActiveId,
  getBinRangeFromIds,
  normalizeBinRange,
  normalizeBinArrays,
  normalizeBins,
  normalizeBinId,
  deriveBinArray,
};
