'use strict';
/**
 * poolFetchCustom_raw.js  (refactored — activity & divergence-aware)
 *
 * What changed
 * ============
 *
 * The old fetcher hit each DEX's API with `sortField=liquidity&sortType=desc`,
 * truncated to limit, and produced a list dominated by deep stable pools
 * (SOL/USDC, USDC/USDT, SOL/JitoSOL). Those are the most liquid pools on
 * Solana — and also the most efficiently arbitraged. Any edge there is
 * gone in milliseconds, captured by co-located HFT bots.
 *
 * The new fetcher fetches WIDER (3-5x the limit) from each API, then ranks
 * locally using:
 *
 *   1. Turnover ratio (volume24h / TVL) — the volatility/activity proxy.
 *      A $1M pool doing $10M/day has 10x turnover; a $100M pool doing
 *      $5M/day has 0.05x. Higher turnover = more reprice events = more
 *      divergence opportunities.
 *
 *   2. Pair-multiplicity bonus — pools on pairs that have at least 2
 *      candidates get a score boost. Triangular arbitrage requires multiple
 *      pools per pair (otherwise there's no divergence to exploit).
 *
 *   3. Fee-tier diversity — instead of dropping all high-fee pools, we
 *      ensure each pair gets at least one pool from each fee tier present.
 *      Last analysis showed RAY/USDC and RAY/USDT had +22 bps gross edge
 *      that died because the only included CPMM pool had ~30 bps fees;
 *      diversity preserves the option to take divergence even when fees
 *      are higher.
 *
 *   4. Optional pre-screen by min divergence — if --min-divergence is set,
 *      we drop pools whose pair has < N bps cross-venue spread. This
 *      requires having computed mids, which means we'd need at least
 *      sqrtPrice or reserves, so it's done as a post-step on raw data.
 *
 * Backward compatibility
 * ----------------------
 * Same CLI flags (--limit, --quality, --quality-count, etc.) plus new ones:
 *   --over-fetch N       Fetch N x limit per DEX before ranking (default 4)
 *   --rank turnover|tvl  Ranking primary signal (default turnover)
 *   --min-turnover X     Drop pools with turnover < X (default 0.05 = 5%/day)
 *   --min-volume24h $    Drop pools with daily volume < $ (default 50000)
 *   --min-divergence N   Drop pools whose pair has <N bps divergence
 *   --fee-tier-diversity When picking from a pair, force at least one pool
 *                        per fee tier present (default ON, --no-fee-tier-diversity to disable)
 *   --include-pair MINT  Force-include any pool touching this mint (repeatable)
 *
 * Same exports: main, parseArgs, extractList, mapRaydiumRaw, mapOrcaRaw,
 *               mapMeteoraRaw, fetchRaydium, fetchOrca, fetchMeteora.
 */

const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');

// ----- DEX_DIRECT_ENDPOINTS may not be available in test environments;
// the fetcher needs the program IDs to populate `programId` on each pool,
// but the tests for this module don't actually exercise the fetch network
// path. Try to require, fall back to defaults if missing.
let DEX_DIRECT_CONFIGS;
try {
  DEX_DIRECT_CONFIGS = require('./DEX_DIRECT_ENDPOINTS.js').DEX_DIRECT_CONFIGS;
} catch (_e) {
  DEX_DIRECT_CONFIGS = {
    raydium: { programIds: { clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' }, config: { timeout: 60_000 } },
    orca: { programIds: { whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }, whirlpool: { endpoints: { list: 'https://api.mainnet.orca.so/v1/whirlpool/list' } }, config: { timeout: 60_000 } },
    meteora: { programIds: { dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' }, config: { timeout: 60_000 } },
  };
}

let selectQualityPools, buildQualityOutput, summarizeSelection;
try {
  ({ selectQualityPools, buildQualityOutput, summarizeSelection } = require('./qualityPoolSelector'));
} catch (_e) {
  // Provide minimal fallbacks if the helper isn't on the path.
  selectQualityPools = (pools, opts) => ({ selected: pools.slice(0, opts.topN || 40), ranked: pools, triangleFamilies: [] });
  buildQualityOutput = (data) => ({ ...data });
  summarizeSelection = (pools) => ({ byDexType: pools.reduce((a, p) => { const k = p.dexType || 'unknown'; a[k] = (a[k] || 0) + 1; return a; }, {}) });
}

const PROGRAM_IDS = {
  raydiumClmm: DEX_DIRECT_CONFIGS.raydium.programIds.clmm,
  raydiumCpmm: DEX_DIRECT_CONFIGS.raydium.programIds.cpmm,
  orca: DEX_DIRECT_CONFIGS.orca.programIds.whirlpool,
  meteoraDlmm: DEX_DIRECT_CONFIGS.meteora.programIds.dlmm,
};

const PRICE_UNIT_Y_PER_X = 'tokenY_per_tokenX';
const DEFAULT_RAW_OUTPUT = '00_raw.json';
const DEFAULT_OUTPUT = '01_meta.json';
const DEFAULT_LIMIT = 75;

/* -------------------------------------------------------------------------- */
/*                                CLI parsing                                 */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {
    out: DEFAULT_OUTPUT,
    rawOut: DEFAULT_RAW_OUTPUT,
    limit: DEFAULT_LIMIT,
    orca: true,
    raydiumClmm: true,
    raydiumCpmm: true,
    meteoraDlmm: true,
    quality: false,
    qualityCount: 40,
    minLiquidity: 0,
    maxPerPair: 2,
    maxPerDexType: 0,
    qualityMeta: '',

    // New ranking knobs
    overFetch: 4,             // fetch this multiple of limit, then rank
    rank: 'turnover',         // 'turnover' | 'tvl' | 'composite'
    minTurnover: 0.05,        // 5% daily turnover floor
    minVolume24h: 50_000,     // $50k daily volume floor
    minDivergence: 0,         // bps; 0 = off (requires post-enrichment)
    divergenceWeight: 50,     // high by design: clear spread should dominate raw fetch ranking
    divergenceDiagnose: false,
    feeTierDiversity: true,
    includePairs: [],
    excludePools: [
      // Orca SOL/USDC pool that has produced contradictory quotes in runtime tests.
      'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
    ],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out' && next) out.out = next;
    else if ((arg === '--raw' || arg === '--raw-out' || arg === '--raw-output') && next) { out.rawOut = next; i += 1; }
    else if (arg === '--limit' && next) out.limit = Number(next) || DEFAULT_LIMIT;
    else if ((arg === '--quality-count' || arg === '--topN') && next) out.qualityCount = Number(next) || out.qualityCount;
    else if (arg === '--min-liquidity' && next) out.minLiquidity = Number(next) || 0;
    else if (arg === '--max-per-pair' && next) out.maxPerPair = Number(next) || out.maxPerPair;
    else if (arg === '--max-per-dex-type' && next) out.maxPerDexType = Number(next) || 15;
    else if (arg === '--quality-meta' && next) out.qualityMeta = next;
    else if (arg === '--quality') out.quality = true;
    else if (arg === '--orca') out.orca = true;
    else if (arg === '--raydium-clmm') out.raydiumClmm = true;
    else if (arg === '--raydium-cpmm') out.raydiumCpmm = true;
    else if (arg === '--meteora') out.meteoraDlmm = true;
    else if (arg === '--raydium-only') {
      out.orca = false; out.raydiumClmm = true; out.raydiumCpmm = true; out.meteoraDlmm = false;
    }
    else if (arg === '--no-orca') out.orca = false;
    else if (arg === '--no-raydium-clmm') out.raydiumClmm = false;
    else if (arg === '--no-raydium-cpmm') out.raydiumCpmm = false;
    else if (arg === '--no-meteora') out.meteoraDlmm = false;

    // New flags
    else if (arg === '--over-fetch' && next) { out.overFetch = Math.max(1, Number(next)); i += 1; }
    else if (arg === '--rank' && next) { out.rank = String(next).toLowerCase(); i += 1; }
    else if (arg === '--min-turnover' && next) { out.minTurnover = Number(next); i += 1; }
    else if (arg === '--min-volume24h' && next) { out.minVolume24h = Number(next); i += 1; }
    else if ((arg === '--min-divergence' || arg === '--prescreen-min-bps' || arg === '--divergence-min-bps') && next) {
      out.minDivergence = Number(next);
      i += 1;
    }
    else if (arg === '--divergence-weight' && next) { out.divergenceWeight = Number(next); i += 1; }
    else if (arg === '--divergence-diagnose') out.divergenceDiagnose = true;
    else if (arg === '--no-fee-tier-diversity') out.feeTierDiversity = false;
    else if (arg === '--fee-tier-diversity') out.feeTierDiversity = true;
    else if (arg === '--include-pair' && next) { out.includePairs.push(next); i += 1; }
    else if ((arg === '--exclude-pool' || arg === '--exclude-pools' || arg === '--block-pool') && next) {
      out.excludePools.push(...String(next).split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
    }

    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}


function poolIdOf(pool) {
  return String(pool?.poolAddress || pool?.address || pool?.id || pool?.poolId || '').trim();
}

function applyPoolExclusions(pools, excludePools = [
  'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'
]) {
  const excluded = new Set((excludePools || []).map((addr) => String(addr || '').trim()).filter(Boolean));
  if (!excluded.size) return pools;

  const kept = [];
  let removed = 0;
  for (const pool of pools || []) {
    const poolId = poolIdOf(pool);
    if (poolId && excluded.has(poolId)) {
      removed += 1;
      continue;
    }
    kept.push(pool);
  }

  if (removed > 0) {
    console.log(`  excluded pools: removed ${removed}/${pools.length}`);
  }
  return kept;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function pick(obj, keys) {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.pools)) return payload.pools;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.whirlpools)) return payload.whirlpools;
  if (Array.isArray(payload.pairs)) return payload.pairs;
  if (isObject(payload.data)) {
    if (Array.isArray(payload.data.data)) return payload.data.data;
    if (Array.isArray(payload.data.pools)) return payload.data.pools;
    if (Array.isArray(payload.data.whirlpools)) return payload.data.whirlpools;
  }
  return [];
}

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(String(value).replace(/[, _]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uiToAtomicString(value, decimals) {
  const num = toNumber(value, null);
  const dec = toNumber(decimals, null);
  if (num === null || dec === null) return undefined;
  return String(Math.round(num * Math.pow(10, dec)));
}

function deriveReservePriceYPerX(xReserve, yReserve, xDecimals, yDecimals) {
  const xRaw = toNumber(xReserve, null);
  const yRaw = toNumber(yReserve, null);
  const xDec = toNumber(xDecimals, null);
  const yDec = toNumber(yDecimals, null);
  if (xRaw === null || yRaw === null || xDec === null || yDec === null || xRaw <= 0 || yRaw <= 0) {
    return null;
  }
  const xUi = xRaw / Math.pow(10, xDec);
  const yUi = yRaw / Math.pow(10, yDec);
  if (!Number.isFinite(xUi) || !Number.isFinite(yUi) || xUi <= 0 || yUi <= 0) return null;
  return yUi / xUi;
}

function deriveBinPriceYPerX(binStep, activeBinId, xDecimals, yDecimals) {
  const step = toNumber(binStep, null);
  const activeId = toNumber(activeBinId, null);
  const xDec = toNumber(xDecimals, 0);
  const yDec = toNumber(yDecimals, 0);
  if (step === null || activeId === null || step <= 0) return null;

  const price = Math.pow(1 + (step / 10000), activeId) * Math.pow(10, xDec - yDec);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function buildCurrentPriceFields({
  explicitPrice,
  xReserve,
  yReserve,
  xDecimals,
  yDecimals,
  binStep,
  activeBinId,
} = {}) {
  const explicit = toNumber(explicitPrice, null);
  if (explicit !== null && explicit > 0) {
    return {
      currentPrice: explicit,
      currentPriceSource: 'api',
      currentPriceUnit: PRICE_UNIT_Y_PER_X,
      currentPricePayload: '1_tokenX',
    };
  }

  const reservePrice = deriveReservePriceYPerX(xReserve, yReserve, xDecimals, yDecimals);
  if (reservePrice !== null) {
    return {
      currentPrice: reservePrice,
      currentPriceSource: 'reserves',
      currentPriceUnit: PRICE_UNIT_Y_PER_X,
      currentPricePayload: '1_tokenX',
    };
  }

  const binPrice = deriveBinPriceYPerX(binStep, activeBinId, xDecimals, yDecimals);
  if (binPrice !== null) {
    return {
      currentPrice: binPrice,
      currentPriceSource: 'bin',
      currentPriceUnit: PRICE_UNIT_Y_PER_X,
      currentPricePayload: '1_tokenX',
    };
  }

  return {
    currentPrice: null,
    currentPriceSource: 'unavailable',
    currentPriceUnit: PRICE_UNIT_Y_PER_X,
    currentPricePayload: '1_tokenX',
  };
}

function withSource(pool, source) {
  return {
    ...source,
    source: 'direct-dex-api',
    sourceUrl: source.endpoint,
    fetchedAt: new Date().toISOString(),
    _raw: pool,
  };
}

/* -------------------------------------------------------------------------- */
/*                            DEX-specific mappers                            */
/*                          (unchanged from original)                         */
/* -------------------------------------------------------------------------- */

function mapRaydiumRaw(pool, type, endpoint) {
  const mintA = pick(pool, ['mintA', 'mint0', 'tokenMint0']);
  const mintB = pick(pool, ['mintB', 'mint1', 'tokenMint1']);
  const baseMint = pick(mintA, ['address', 'mint']) || mintA || null;
  const quoteMint = pick(mintB, ['address', 'mint']) || mintB || null;
  const baseDecimals = toNumber(pick(mintA, ['decimals']) ?? pool.mintDecimals0 ?? pool.decimalsA, null);
  const quoteDecimals = toNumber(pick(mintB, ['decimals']) ?? pool.mintDecimals1 ?? pool.decimalsB, null);
  const xReserve = uiToAtomicString(pick(pool, ['mintAmountA', 'amountA', 'reserveA', 'reserve_x']), baseDecimals);
  const yReserve = uiToAtomicString(pick(pool, ['mintAmountB', 'amountB', 'reserveB', 'reserve_y']), quoteDecimals);
  const address = pick(pool, ['id', 'address', 'poolAddress', 'poolId']);
  const currentPriceFields = buildCurrentPriceFields({
    explicitPrice: pool.price ?? pool.currentPrice,
    xReserve,
    yReserve,
    xDecimals: baseDecimals,
    yDecimals: quoteDecimals,
  });

  return withSource(pool, {
    endpoint,
    address,
    poolAddress: address,
    dex: 'raydium',
    dexType: type === 'clmm' ? 'RAYDIUM_CLMM' : 'RAYDIUM_CPMM',
    type,
    programId: type === 'clmm' ? PROGRAM_IDS.raydiumClmm : PROGRAM_IDS.raydiumCpmm,
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,
    tokenXMint: baseMint,
    tokenYMint: quoteMint,
    tokenXDecimals: baseDecimals,
    tokenYDecimals: quoteDecimals,
    baseSymbol: pick(mintA, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
    quoteSymbol: pick(mintB, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
    reserves: xReserve !== undefined || yReserve !== undefined ? { x: xReserve || '0', y: yReserve || '0' } : undefined,
    xReserve,
    yReserve,
    vaults: {
      xVault: pick(pool, ['vaultA', 'tokenVault0', 'tokenVaultA']) || null,
      yVault: pick(pool, ['vaultB', 'tokenVault1', 'tokenVaultB']) || null,
    },
    tickSpacing: toNumber(pool.tickSpacing ?? pool.config?.tickSpacing, undefined),
    tickCurrent: toNumber(pool.currentTickIndex ?? pool.tickCurrent ?? pool.tickCurrentIndex, undefined),
    sqrtPriceX64: pick(pool, ['sqrtPriceX64', 'sqrtPrice']) ?? null,
    liquidity: pool.liquidity ?? pool.minimumLiquidity ?? null,
    ...currentPriceFields,
    feeBps: toNumber(pool.feeRate, undefined) != null
      ? Math.round(toNumber(pool.feeRate, 0) * 10000)
      : (pool.tradeFeeRate != null ? Math.round(Number(pool.tradeFeeRate) * 10000) : undefined),
    tvl: toNumber(pool.tvl ?? pool.liquidity?.liquidityUsd, undefined),
    volume24h: toNumber(pool.day?.volume ?? pool.volume24h ?? pool.volume, undefined),
  });
}

function mapOrcaRaw(pool, endpoint) {
  const tokenA = pool.tokenA || {};
  const tokenB = pool.tokenB || {};
  const baseMint = pick(tokenA, ['mint', 'address']) || pick(pool, ['tokenMintA']) || null;
  const quoteMint = pick(tokenB, ['mint', 'address']) || pick(pool, ['tokenMintB']) || null;
  const baseDecimals = toNumber(tokenA.decimals ?? pool.tokenA?.decimals, null);
  const quoteDecimals = toNumber(tokenB.decimals ?? pool.tokenB?.decimals, null);
  const xReserve = uiToAtomicString(pick(pool, ['reserveA', 'liquidityA', 'amountA']), baseDecimals);
  const yReserve = uiToAtomicString(pick(pool, ['reserveB', 'liquidityB', 'amountB']), quoteDecimals);
  const address = pick(pool, ['address', 'id', 'poolAddress']);
  const currentPriceFields = buildCurrentPriceFields({
    explicitPrice: pool.price ?? pool.currentPrice,
    xReserve,
    yReserve,
    xDecimals: baseDecimals,
    yDecimals: quoteDecimals,
  });

  return withSource(pool, {
    endpoint,
    address,
    poolAddress: address,
    dex: 'orca',
    dexType: 'ORCA_WHIRLPOOL',
    type: 'whirlpool',
    programId: PROGRAM_IDS.orca,
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,
    tokenXMint: baseMint,
    tokenYMint: quoteMint,
    tokenXDecimals: baseDecimals,
    tokenYDecimals: quoteDecimals,
    baseSymbol: pick(tokenA, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
    quoteSymbol: pick(tokenB, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
    feeRate: pick(pool, ['lpFeeRate', 'lpsFeeRate', 'feeRate', 'fee']),
    feeBps: toNumber(pick(pool, ['lpFeeRate', 'feeRate']), undefined) != null
      ? Math.round(toNumber(pick(pool, ['lpFeeRate', 'feeRate']), 0) * 10000)
      : undefined,
    reserves: xReserve !== undefined || yReserve !== undefined ? { x: xReserve || '0', y: yReserve || '0' } : undefined,
    xReserve,
    yReserve,
    vaults: {
      xVault: pick(pool, ['tokenVaultA', 'vaultA']) || null,
      yVault: pick(pool, ['tokenVaultB', 'vaultB']) || null,
    },
    tickSpacing: toNumber(pool.tickSpacing, undefined),
    tickCurrent: toNumber(pool.tickCurrentIndex ?? pool.currentTickIndex ?? pool.tickCurrent, undefined),
    sqrtPriceX64: pick(pool, ['sqrtPriceX64', 'sqrtPrice']) ?? null,
    liquidity: pool.liquidity ?? null,
    ...currentPriceFields,
    tvl: toNumber(pool.tvl, undefined),
    volume24h: toNumber(pool.volume?.day ?? pool.volume24h ?? pool.volume, undefined),
  });
}

function mapMeteoraRaw(pool, endpoint) {
  const tokenX = pool.token_x || pool.tokenX || {};
  const tokenY = pool.token_y || pool.tokenY || {};
  const baseMint = pick(pool, ['mint_x', 'tokenXMint', 'baseMint']) || pick(tokenX, ['mint', 'address']) || null;
  const quoteMint = pick(pool, ['mint_y', 'tokenYMint', 'quoteMint']) || pick(tokenY, ['mint', 'address']) || null;
  const baseDecimals = toNumber(tokenX.decimals ?? pool.decimals_x ?? pool.tokenXDecimals, null);
  const quoteDecimals = toNumber(tokenY.decimals ?? pool.decimals_y ?? pool.tokenYDecimals, null);
  const address = pick(pool, ['address', 'id', 'poolAddress', 'pairAddress']);
  const xReserve = pool.reserve_x_amount !== undefined ? String(pool.reserve_x_amount) : uiToAtomicString(pool.token_x_amount, baseDecimals);
  const yReserve = pool.reserve_y_amount !== undefined ? String(pool.reserve_y_amount) : uiToAtomicString(pool.token_y_amount, quoteDecimals);
  const binStep = toNumber(pick(pool, ['bin_step', 'binStep', 'bin_step_size']) ?? pool.pool_config?.bin_step, undefined);
  const activeBinId = toNumber(pool.active_id ?? pool.activeId ?? pool.active_bin?.bin_id, undefined);
  const currentPriceFields = buildCurrentPriceFields({
    explicitPrice: pool.current_price ?? pool.price ?? pool.currentPrice,
    xReserve,
    yReserve,
    xDecimals: baseDecimals,
    yDecimals: quoteDecimals,
    binStep,
    activeBinId,
  });

  return withSource(pool, {
    endpoint,
    address,
    poolAddress: address,
    dex: 'meteora',
    dexType: 'METEORA_DLMM',
    type: 'dlmm',
    programId: PROGRAM_IDS.meteoraDlmm,
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,
    tokenXMint: baseMint,
    tokenYMint: quoteMint,
    tokenXDecimals: baseDecimals,
    tokenYDecimals: quoteDecimals,
    baseSymbol: pick(tokenX, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
    quoteSymbol: pick(tokenY, ['symbol', 'tokenSymbol', 'name', 'ticker']) || null,
    base_fee_percentage: pool.base_fee_percentage ?? pool.pool_config?.base_fee_pct,
    feeRate: pool.feeRate,
    feeBps: toNumber(pool.base_fee_percentage, undefined) != null
      ? Math.round(toNumber(pool.base_fee_percentage, 0) * 100)
      : undefined,
    reserves: { x: xReserve || '0', y: yReserve || '0' },
    xReserve,
    yReserve,
    vaults: {
      xVault: pool.reserve_x || pick(pool, ['tokenVaultA', 'vaultA']) || null,
      yVault: pool.reserve_y || pick(pool, ['tokenVaultB', 'vaultB']) || null,
    },
    binStep,
    activeBinId,
    ...currentPriceFields,
    liquidity: pool.liquidity ?? null,
    tvl: toNumber(pool.liquidity ?? pool.tvl, undefined),
    volume24h: toNumber(pool.trade_volume_24h ?? pool.volume24h ?? pool.volume?.['24h'] ?? pool.volume, undefined),
    bins: Array.isArray(pool.bins) ? pool.bins : undefined,
    binArrays: Array.isArray(pool.binArrays) ? pool.binArrays : undefined,
  });
}

async function fetchJson(url, timeout = 60_000) {
  const response = await axios.get(url, {
    timeout,
    headers: { 'User-Agent': 'Solana-Arbitrage-Bot/1.0.0' },
  });
  return response.data;
}

/* -------------------------------------------------------------------------- */
/*                       Wider fetches (3-5x of limit)                        */
/* -------------------------------------------------------------------------- */

async function fetchRaydium(limit, includeClmm, includeCpmm, overFetchSize) {
  const fetchSize = overFetchSize || limit;
  const endpoints = [];
  if (includeClmm) {
    endpoints.push({
      type: 'clmm',
      url: `https://api-v3.raydium.io/pools/info/list-v2?poolType=Concentrated&hasReward=false&sortField=liquidity&sortType=desc&size=${fetchSize}`,
    });
  }
  if (includeCpmm) {
    endpoints.push({
      type: 'cpmm',
      url: `https://api-v3.raydium.io/pools/info/list-v2?poolType=Standard&sortField=liquidity&sortType=desc&size=${fetchSize}`,
    });
  }

  const out = [];
  for (const { type, url } of endpoints) {
    try {
      console.log(`Fetching Raydium ${type.toUpperCase()} (size=${fetchSize})...`);
      const data = await fetchJson(url, DEX_DIRECT_CONFIGS.raydium.config.timeout);
      const selected = extractList(data);
      out.push(...selected.map((pool) => mapRaydiumRaw(pool, type, url)).filter(Boolean));
      console.log(`  Fetched ${selected.length} pools`);
    } catch (error) {
      console.error(`  Raydium ${type} failed:`, error.message);
    }
  }
  return out;
}

async function fetchOrca(limit, overFetchSize) {
  const fetchSize = overFetchSize || limit;
  const url = DEX_DIRECT_CONFIGS.orca.whirlpool.endpoints.list;
  try {
    console.log(`Fetching Orca Whirlpools...`);
    const data = await fetchJson(url, DEX_DIRECT_CONFIGS.orca.config.timeout);
    const selected = extractList(data)
      .slice()
      .sort((a, b) => Number(b?.tvl || 0) - Number(a?.tvl || 0))
      .slice(0, fetchSize);
    console.log(`  Fetched ${selected.length} pools`);
    return selected.map((pool) => mapOrcaRaw(pool, url)).filter(Boolean);
  } catch (error) {
    console.error('  Orca failed:', error.message);
    return [];
  }
}

async function fetchMeteora(limit, overFetchSize) {
  const fetchSize = overFetchSize || limit;
  const pageSize = Math.max(1, Math.min(Number(fetchSize) || 1, 1000));
  const baseUrl = 'https://dlmm.datapi.meteora.ag/pools';
  const url = `${baseUrl}?page_size=${pageSize}&sort_by=tvl:desc`;
  try {
    console.log(`Fetching Meteora DLMM (size=${pageSize})...`);
    const data = await fetchJson(url, DEX_DIRECT_CONFIGS.meteora.config?.timeout || 60_000);
    const selected = extractList(data)
      .slice()
      .sort((a, b) => Number(b?.liquidity || b?.tvl || 0) - Number(a?.liquidity || a?.tvl || 0))
      .slice(0, fetchSize);
    console.log(`  Fetched ${selected.length} pools`);
    return selected.map((pool) => mapMeteoraRaw(pool, url)).filter(Boolean);
  } catch (error) {
    console.error('  Meteora failed:', error.message);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                         Activity-aware ranking                             */
/* -------------------------------------------------------------------------- */

/**
 * Activity score combines:
 *   - turnover = volume24h / TVL  (higher is better — more reprice events)
 *   - log(TVL) (deeper pools more executable)
 *   - fee penalty (lower fees marginally preferred at equal turnover)
 *
 * Pools with no volume data fall back to a fraction of TVL so they aren't
 * automatically excluded from the candidate set, but they rank below pools
 * with confirmed activity.
 */
function activityScore(pool) {
  const tvl = Number(pool.tvl || 0);
  const vol = Number(pool.volume24h || 0);
  const fee = Number(pool.feeBps || 30);

  if (tvl <= 0) return 0;

  const turnover = vol > 0 ? vol / tvl : 0;
  const tvlScore = Math.log10(Math.max(tvl, 100));   // log to flatten the curve
  const turnoverScore = turnover > 0
    ? Math.log10(1 + turnover * 10)                 // 1.0 -> 1.04, 10.0 -> 2.0
    : 0;
  const feePenalty = 1 / (1 + Math.log10(1 + fee / 10));  // gentle penalty

  // Composite: turnover dominates, TVL is multiplicative depth proof.
  if (turnover > 0) {
    return turnoverScore * tvlScore * feePenalty;
  }
  // No volume known: fall back to depth, but discounted.
  return tvlScore * feePenalty * 0.3;
}

function tvlScore(pool) {
  return Math.log10(Math.max(Number(pool.tvl || 0), 100));
}

function turnoverOnly(pool) {
  const tvl = Number(pool.tvl || 0);
  const vol = Number(pool.volume24h || 0);
  if (tvl <= 0 || vol <= 0) return 0;
  return vol / tvl;
}

function getRankFn(rankMode) {
  if (rankMode === 'tvl') return tvlScore;
  if (rankMode === 'turnover') return turnoverOnly;
  return activityScore; // 'composite' (default-ish)
}

function loadDivergenceScanner() {
  try {
    return require('./divergenceScanner');
  } catch (_e) {
    return null;
  }
}

function pairHasClearDivergence(pool, minBps = 0) {
  const peerCount = Number(pool?.pairPeerCount || 0);
  const comparablePeers = Number(pool?.pairComparablePeerCount || 0);
  const divergenceBps = Number(pool?.pairDivergenceBps || 0);
  const comparable = pool?.pairDivergenceComparable !== false && comparablePeers >= 2;
  return peerCount >= 2 && comparable && divergenceBps >= Number(minBps || 0);
}

function annotateDivergenceSignals(pools, options = {}) {
  const scanner = loadDivergenceScanner();
  if (!scanner?.annotatePairDivergence) {
    console.warn('  divergenceScanner not available — ranking without divergence boost');
    return {
      available: false,
      clearPairs: 0,
      clearPools: 0,
      comparablePools: 0,
      maxDivergenceBps: 0,
    };
  }

  scanner.annotatePairDivergence(pools, { diagnose: Boolean(options.divergenceDiagnose) });

  const minBps = Number(options.minDivergence || 0);
  const seenClearPairs = new Set();
  let clearPools = 0;
  let comparablePools = 0;
  let maxDivergenceBps = 0;

  for (const pool of pools) {
    const divergenceBps = Number(pool.pairDivergenceBps || 0);
    const comparable = pool.pairDivergenceComparable !== false && Number(pool.pairComparablePeerCount || 0) >= 2;
    const clear = pairHasClearDivergence(pool, minBps > 0 ? minBps : 0.0001);

    pool._divergenceScoreBps = Number.isFinite(divergenceBps) ? divergenceBps : 0;
    pool._divergenceComparable = comparable;
    pool._divergenceClear = clear;

    if (comparable) comparablePools += 1;
    if (clear) {
      clearPools += 1;
      if (pool.pairCanonical) seenClearPairs.add(pool.pairCanonical);
    }
    if (Number.isFinite(divergenceBps) && divergenceBps > maxDivergenceBps) {
      maxDivergenceBps = divergenceBps;
    }
  }

  return {
    available: true,
    clearPairs: seenClearPairs.size,
    clearPools,
    comparablePools,
    maxDivergenceBps: Number(maxDivergenceBps.toFixed(4)),
  };
}

/* -------------------------------------------------------------------------- */
/*                       Pair-aware selection logic                           */
/* -------------------------------------------------------------------------- */

function pairKey(pool) {
  const x = String(pool.tokenXMint || pool.baseMint || '');
  const y = String(pool.tokenYMint || pool.quoteMint || '');
  if (!x || !y) return null;
  return [x, y].sort().join('|');
}

function feeTierBucket(feeBps) {
  if (feeBps == null) return 'unknown';
  const n = Number(feeBps);
  if (n <= 5) return 'ultralow';   // ≤5 bps
  if (n <= 15) return 'low';       // 6–15
  if (n <= 30) return 'mid';       // 16–30
  return 'high';                   // 31+
}

/**
 * Apply activity ranking + pair-multiplicity bonus + fee-tier diversity.
 * Returns ranked pools with score annotations.
 */
function rankAndAnnotate(pools, options) {
  const rankFn = getRankFn(options.rank);
  const minTurnover = Number(options.minTurnover || 0);
  const minVolume = Number(options.minVolume24h || 0);
  const divergenceWeight = Number.isFinite(Number(options.divergenceWeight))
    ? Number(options.divergenceWeight)
    : 50;

  const divergenceSummary = annotateDivergenceSignals(pools, options);
  if (divergenceSummary.available) {
    console.log(`  Divergence signal: ${divergenceSummary.clearPools} pools across ${divergenceSummary.clearPairs} clear pairs `
      + `(max=${divergenceSummary.maxDivergenceBps} bps, comparable=${divergenceSummary.comparablePools}/${pools.length})`);
  }

  // Group by pair to count multiplicity.
  const pairCounts = new Map();
  for (const pool of pools) {
    const k = pairKey(pool);
    if (!k) continue;
    pairCounts.set(k, (pairCounts.get(k) || 0) + 1);
  }

  // Score every pool.
  for (const pool of pools) {
    const baseScore = rankFn(pool);
    const k = pairKey(pool);
    const peerCount = k ? pairCounts.get(k) || 1 : 1;
    // Multiplicity bonus: pools on pairs with 2+ candidates get a 1.3x boost.
    const multiplicityBonus = peerCount >= 2 ? 1.3 : 1.0;
    const turnover = turnoverOnly(pool);
    const divergenceBps = Number(pool._divergenceScoreBps || 0);
    const divergenceComparable = pool._divergenceComparable === true;
    const divergenceBoost = divergenceComparable && divergenceBps > 0
      ? Math.log10(1 + divergenceBps) * divergenceWeight
      : 0;

    pool._activityScore = (baseScore * multiplicityBonus) + divergenceBoost;
    pool._baseActivityScore = baseScore;
    pool._divergenceRankBoost = divergenceBoost;
    pool._turnover = turnover;
    pool._pairPeerCount = peerCount;
    pool._feeTier = feeTierBucket(pool.feeBps);
    pool._pairKey = k;
  }

  // Hard floors: drop pools with no activity at all.
  const floored = pools.filter((p) => {
    const tvl = Number(p.tvl || 0);
    const vol = Number(p.volume24h || 0);
    if (vol > 0 && minVolume > 0 && vol < minVolume) return false;
    if (p._turnover > 0 && minTurnover > 0 && p._turnover < minTurnover) return false;
    if (tvl <= 0) return false;
    return true;
  });

  // Sort by activity score, descending.
  floored.sort((a, b) => (b._activityScore || 0) - (a._activityScore || 0));
  return floored;
}

/**
 * Pick `topN` pools while enforcing per-pair caps. If feeTierDiversity is on,
 * each pair gets at least one pool per fee-tier bucket present in its
 * candidates before any one bucket can take a second slot.
 *
 * This is what makes your RAY/USDC + RAY/USDT divergence routes survive:
 * the high-fee CPMM and the low-fee CLMM both get included even when
 * --max-per-pair=2.
 */
function selectWithDiversity(rankedPools, options) {
  const topN = Number(options.qualityCount || 40);
  const maxPerPair = Number(options.maxPerPair || 2);
  const maxPerDexType = Number(options.maxPerDexType || 0);
  const includeMints = new Set(options.includePairs || []);
  const enforceDiversity = options.feeTierDiversity !== false;

  const selected = [];
  const perPair = new Map();              // pairKey -> count
  const perPairFeeTiers = new Map();      // pairKey -> Set<feeTier>
  const perDexType = new Map();           // dexType -> count

  // First pass: forced includes (any pool touching an --include-pair mint).
  if (includeMints.size) {
    for (const pool of rankedPools) {
      const x = String(pool.tokenXMint || '');
      const y = String(pool.tokenYMint || '');
      if (includeMints.has(x) || includeMints.has(y)) {
        if (!selected.includes(pool)) {
          selected.push(pool);
          const k = pool._pairKey;
          if (k) {
            perPair.set(k, (perPair.get(k) || 0) + 1);
            if (!perPairFeeTiers.has(k)) perPairFeeTiers.set(k, new Set());
            perPairFeeTiers.get(k).add(pool._feeTier);
          }
          const dt = pool.dexType || 'unknown';
          perDexType.set(dt, (perDexType.get(dt) || 0) + 1);
        }
      }
    }
  }

  // Second pass: rank-ordered selection with caps + diversity.
  for (const pool of rankedPools) {
    if (selected.length >= topN) break;
    if (selected.includes(pool)) continue;

    const k = pool._pairKey;
    const dt = pool.dexType || 'unknown';
    const pairCount = k ? perPair.get(k) || 0 : 0;
    const dexCount = perDexType.get(dt) || 0;

    // Per-pair cap.
    if (k && pairCount >= maxPerPair) {
      // BUT: if we're enforcing diversity and this fee tier hasn't been seen
      // on this pair yet, allow one extra slot beyond the cap.
      if (enforceDiversity) {
        const tiers = perPairFeeTiers.get(k) || new Set();
        if (!tiers.has(pool._feeTier) && pairCount < maxPerPair + 1) {
          // Allowed via diversity exception.
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
    if (maxPerDexType > 0 && dexCount >= maxPerDexType) continue;

    selected.push(pool);
    if (k) {
      perPair.set(k, (perPair.get(k) || 0) + 1);
      if (!perPairFeeTiers.has(k)) perPairFeeTiers.set(k, new Set());
      perPairFeeTiers.get(k).add(pool._feeTier);
    }
    perDexType.set(dt, dexCount + 1);
  }

  return selected;
}

/* -------------------------------------------------------------------------- */
/*                          Optional divergence pre-screen                    */
/* -------------------------------------------------------------------------- */

function applyDivergenceScreen(pools, minBps) {
  if (!minBps || minBps <= 0) return pools;

  const scanner = loadDivergenceScanner();
  if (!scanner?.annotatePairDivergence) {
    console.warn('  divergenceScanner not available — skipping divergence screen');
    return pools;
  }

  scanner.annotatePairDivergence(pools);

  // Keep clear, comparable divergence. Singletons and genuinely unmeasurable
  // raw pairs pass through because they cannot prove or disprove divergence
  // until Q-enrichment fills chain-state fields. Comparable peer groups with
  // sub-threshold divergence are dropped.
  const kept = pools.filter((p) => {
    const peerCount = Number(p.pairPeerCount || 0);
    const comparablePeers = Number(p.pairComparablePeerCount || 0);
    if (peerCount < 2) return true;
    if (comparablePeers < 2 || p.pairDivergenceComparable === false) return true;
    return pairHasClearDivergence(p, minBps);
  });

  const clearKept = kept.filter((p) => pairHasClearDivergence(p, minBps)).length;
  console.log(`  divergence screen: kept ${kept.length}/${pools.length} pools `
    + `(${clearKept} clear >=${minBps} bps; singletons/unmeasurable pass to enrichment)`);
  return kept;
}

/* -------------------------------------------------------------------------- */
/*                              CLI / main                                    */
/* -------------------------------------------------------------------------- */

function summarize(pools) {
  return pools.reduce((acc, pool) => {
    const key = `${pool.dex || 'unknown'}:${pool.type || 'unknown'}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function summarizeActivity(pools) {
  const tiers = { ultralow: 0, low: 0, mid: 0, high: 0, unknown: 0 };
  let withVol = 0; let withoutVol = 0;
  let totalTurnover = 0; let countTurnover = 0;
  for (const p of pools) {
    tiers[feeTierBucket(p.feeBps)] = (tiers[feeTierBucket(p.feeBps)] || 0) + 1;
    if (Number(p.volume24h || 0) > 0) {
      withVol += 1;
      const t = turnoverOnly(p);
      if (t > 0) { totalTurnover += t; countTurnover += 1; }
    } else {
      withoutVol += 1;
    }
  }
  return {
    feeTiers: tiers,
    coverage: { withVolumeData: withVol, withoutVolumeData: withoutVol },
    avgTurnover: countTurnover > 0 ? Number((totalTurnover / countTurnover).toFixed(3)) : 0,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node poolFetch_raw.js --out custom_raw-25.json --limit 25
  node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json
  node poolFetch_raw.js --out raw.json --limit 60 --quality \\
       --rank turnover --min-turnover 0.1 --min-volume24h 100000 \\
       --over-fetch 4 --quality-count 60 --max-per-pair 2

Activity-aware ranking flags:
  --rank turnover|tvl|composite     Primary signal (default composite)
  --over-fetch N                    Fetch N x limit per DEX (default 4)
  --raw PATH                        Save fetched raw pool snapshot before screening
  --min-turnover N                  Drop pools with vol/TVL < N (default 0.05)
  --min-volume24h $                 Drop pools with $vol < amount (default 50000)
  --min-divergence N                Drop pools whose pair has <N bps divergence
  --divergence-weight N             Rank boost for clear divergence (default 50)
  --divergence-diagnose             Print mid-price extraction diagnostics
  --no-fee-tier-diversity           Disable fee-tier diversity (default ON)
  --include-pair MINT               Force include any pool touching MINT
`);
    process.exit(0);
  }

  console.log('Custom raw pool fetcher (activity-aware)');
  console.log(`Output:        ${args.out}`);
  if (args.rawOut) console.log(`Raw snapshot:  ${args.rawOut}`);
  console.log(`Limit per DEX: ${args.limit}  ·  over-fetch x${args.overFetch}`);
  console.log(`Ranking:       ${args.rank}  min-turnover=${args.minTurnover} min-volume=${args.minVolume24h}`);
  console.log(`Divergence:    min=${args.minDivergence}bps weight=${args.divergenceWeight}`);
  console.log(`Selection:     topN=${args.qualityCount} maxPerPair=${args.maxPerPair} feeTierDiversity=${args.feeTierDiversity}`);

  const overFetchSize = args.limit * args.overFetch;
  const pools = [];

  if (args.raydiumClmm || args.raydiumCpmm) {
    pools.push(...await fetchRaydium(args.limit, args.raydiumClmm, args.raydiumCpmm, overFetchSize));
  }
  if (args.orca) pools.push(...await fetchOrca(args.limit, overFetchSize));
  if (args.meteoraDlmm) pools.push(...await fetchMeteora(args.limit, overFetchSize));

  console.log(`\nTotal raw fetched: ${pools.length}`);
  console.log('  Counts:', summarize(pools));
  if (args.rawOut) {
    await fs.mkdir(path.dirname(path.resolve(args.rawOut)), { recursive: true });
    await fs.writeFile(args.rawOut, JSON.stringify(pools, null, 2));
    console.log(`  Saved raw snapshot to ${path.resolve(args.rawOut)}`);
  }
  const candidatePools = applyPoolExclusions(pools, args.excludePools);

  // Rank and annotate.
  console.log(`\nRanking by ${args.rank} score...`);
  let ranked = rankAndAnnotate(candidatePools, args);
  console.log(`  After activity floor: ${ranked.length}/${candidatePools.length}`);
  const activitySummary = summarizeActivity(ranked);
  console.log(`  Volume coverage: ${activitySummary.coverage.withVolumeData}/${ranked.length} pools have volume24h`);
  console.log(`  Avg turnover (vol/TVL):`, activitySummary.avgTurnover);
  console.log(`  Fee tiers:`, activitySummary.feeTiers);

  // Optional divergence pre-screen (only effective if pools have sqrtPrice/reserves).
  if (args.minDivergence > 0) {
    ranked = applyDivergenceScreen(ranked, args.minDivergence);
  }

  // Final selection with caps and diversity.
  let outputPools;
  let qualityResult = null;
  if (args.quality) {
    outputPools = selectWithDiversity(ranked, args);
    console.log(`\nQuality selection: ${outputPools.length}/${ranked.length}`);
    console.log('  Counts:', summarize(outputPools));
  } else {
    outputPools = ranked.slice(0, args.limit * 4);  // sensible default cap
    console.log(`\nNo --quality flag: writing top ${outputPools.length} ranked pools`);
  }

  // Strip internal annotation prefixes from output (keep them only in metadata).
  const cleanedOutput = outputPools.map((p) => {
    const cleaned = { ...p };
    delete cleaned._activityScore;
    delete cleaned._baseActivityScore;
    delete cleaned._turnover;
    delete cleaned._pairPeerCount;
    delete cleaned._feeTier;
    delete cleaned._pairKey;
    delete cleaned._divergenceScoreBps;
    delete cleaned._divergenceComparable;
    delete cleaned._divergenceClear;
    delete cleaned._divergenceRankBoost;
    return cleaned;
  });

  await fs.writeFile(args.out, JSON.stringify(cleanedOutput, null, 2));
  console.log(`\nSaved raw pools to ${path.resolve(args.out)}`);

  if (args.quality && args.qualityMeta) {
    const qualityOutput = buildQualityOutput({
      source: 'poolFetchCustom_raw.js (activity-aware)',
      selected: cleanedOutput,
      ranked: ranked.slice(0, 200),  // top 200 by activity for inspection
      triangleFamilies: [],
      options: {
        topN: args.qualityCount,
        minLiquidity: args.minLiquidity,
        rank: args.rank,
        minTurnover: args.minTurnover,
        minVolume24h: args.minVolume24h,
        minDivergence: args.minDivergence,
        divergenceWeight: args.divergenceWeight,
        divergenceDiagnose: args.divergenceDiagnose,
        feeTierDiversity: args.feeTierDiversity,
        excludePools: args.excludePools,
        activitySummary,
      },
      mode: 'direct-api-activity-select',
    });
    await fs.writeFile(args.qualityMeta, JSON.stringify(qualityOutput, null, 2));
    console.log(`Saved quality metadata to ${path.resolve(args.qualityMeta)}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  extractList,
  mapRaydiumRaw,
  mapOrcaRaw,
  mapMeteoraRaw,
  fetchRaydium,
  fetchOrca,
  fetchMeteora,
  // Newly exported for downstream tooling and tests:
  rankAndAnnotate,
  selectWithDiversity,
  activityScore,
  turnoverOnly,
  pairKey,
  feeTierBucket,
  applyDivergenceScreen,
  annotateDivergenceSignals,
  pairHasClearDivergence,
  buildCurrentPriceFields,
  deriveReservePriceYPerX,
  applyPoolExclusions,
  poolIdOf,
};
/*
Canonical numbered runtime sequence:

node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json --max-per-dex-type 15 --quality 60 --include-pair DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
3UwfrdLTpAjxTRni1boc5HUWe6hzc4HgE5yLdvEp2Noc
C9U2Ksk6KKWvLEeo5yUQ7Xu46X7NzeBJtd9PBfuXaUSM
HUGNqTa2qqkaAVsQmYzBorZfusMUY4ToHq99WKJY43Vb
F4etmPcJMYzkhvXKdSddYYAyWVCw6iKR3Fbn5uL2UqAB
YxyQcW66neHiMYLfThmVs776SHFczwFMjJh1Noi4BQv
6wJ7W3oHj7ex6MVFp2o26NSof3aey7U8Brs8E371WCXA
7wkFP7EHYTgeUG5ouX64ftTsMuXpR1gFCJK6knyp22Rd
BhjvwZoCir2jqVrdGemebDFmTeMW3eENFrxYffkPfj1Y
6pLFuygN2yLg6fAJ4JRtdDfKaugcY51ZYK5PTjFZMa5s
DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU
2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv
CRoTdDUM3NJGbuvB7Vr9rhmRxnSswMjnTLC1ANjhwsdq
F4qzoTiHXm2zLKLJdUZfrpKH7q3zk7dVzgjCoeg8rbTV
EdRQgfs2oRyyqsGDNH5XPJKMUDUBdpPcy597ZHdYY7uk
AbTXfZfd2YnR8w1uv81NzHT4ggmq6jombkAFPcpprnfr
A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC
4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R
2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2
4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R
Hz1EtXTGaFEtAWRgRNpDMFV6vnSZtQUY9UqmdM6vfKSS
HDhWhQCBrSh9xNWmNtsTi86eWj3yCoEiaRodjgNydo1b
cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij

node utilities/divergenceScanner.js --in 01_meta.json --out 02_filtered.json
node engine/Q_enrichment.js --in 02_filtered.json --out 03_enriched.json
node engine/myEngine.js --in 03_enriched.json  --out 04_runtimeResults.json --csv 05_result_compare.csv  --json 06_result_data.json --html 07_result_report.html


BONK/RAY/TRUNP/CBBTC/FARTCOIN/PENGU
DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
3UwfrdLTpAjxTRni1boc5HUWe6hzc4HgE5yLdvEp2Noc
C9U2Ksk6KKWvLEeo5yUQ7Xu46X7NzeBJtd9PBfuXaUSM
HUGNqTa2qqkaAVsQmYzBorZfusMUY4ToHq99WKJY43Vb
F4etmPcJMYzkhvXKdSddYYAyWVCw6iKR3Fbn5uL2UqAB
YxyQcW66neHiMYLfThmVs776SHFczwFMjJh1Noi4BQv
6wJ7W3oHj7ex6MVFp2o26NSof3aey7U8Brs8E371WCXA
7wkFP7EHYTgeUG5ouX64ftTsMuXpR1gFCJK6knyp22Rd
BhjvwZoCir2jqVrdGemebDFmTeMW3eENFrxYffkPfj1Y
6pLFuygN2yLg6fAJ4JRtdDfKaugcY51ZYK5PTjFZMa5s
DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU
2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv
CRoTdDUM3NJGbuvB7Vr9rhmRxnSswMjnTLC1ANjhwsdq
F4qzoTiHXm2zLKLJdUZfrpKH7q3zk7dVzgjCoeg8rbTV
EdRQgfs2oRyyqsGDNH5XPJKMUDUBdpPcy597ZHdYY7uk
AbTXfZfd2YnR8w1uv81NzHT4ggmq6jombkAFPcpprnfr
A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC
4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R
2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2
4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R
Hz1EtXTGaFEtAWRgRNpDMFV6vnSZtQUY9UqmdM6vfKSS
HDhWhQCBrSh9xNWmNtsTi86eWj3yCoEiaRodjgNydo1b
cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij

*/
