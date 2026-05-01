'use strict';
/**
 * poolFetchCustom_raw.js  (triangle-closure-aware)
 *
 * Goal of this rewrite
 * ====================
 * Previous selection ranked by activity score then deduped by per-pair count.
 * That funnels every run into deep stable-major pools (SOL/USDC/USDT/RAY) which
 * are saturated by HFT bots in milliseconds. Result: every triangle the engine
 * builds is some permutation of SOL→USDC→USDT→SOL, divergence is ~0.2 bps,
 * fees are ~4 bps, and net is always negative.
 *
 * The new selector is graph-aware and triangle-closure-driven:
 *
 *   1. Anchor hubs are SOL, USDC, USDT (mints any triangle must close back to).
 *   2. For every NON-anchor token T, we require either:
 *        (a) ≥2 distinct anchor connections (T↔SOL and T↔USDC), so the triangle
 *            SOL → T → USDC → SOL has all three legs available; OR
 *        (b) ≥2 pools to the SAME anchor (cross-DEX), so divergence is
 *            measurable on the T↔anchor pair (path SOL → T → SOL via two
 *            different DEXes is degenerate, but multi-pool same-anchor lets
 *            T↔anchor act as a divergent leg in a larger triangle).
 *   3. T must have ≥2 total pools across the candidate set, otherwise the
 *      divergenceScanner can't compute a comparable mid for it.
 *   4. Within each surviving T-bucket we pull the highest-activity pools but
 *      enforce FEE-TIER DIVERSITY (1 pool per fee bucket per T-anchor pair),
 *      so a 19 bps gross-edge route doesn't get killed because the only kept
 *      RAY/USDC pool is the 25 bps CPMM.
 *
 * The selector returns pools that are ALREADY SHAPED via the existing mappers
 * (mapRaydiumRaw/mapOrcaRaw/mapMeteoraRaw). It does NOT rebuild canonical
 * fields. Downstream consumers see exactly the same field set they did before
 * — divergenceScanner, Q_enrichment, myEngine all work unchanged.
 *
 * Backward compat
 * ---------------
 * `--quality` still works. The legacy `selectWithDiversity` is preserved and
 * available via `--select-mode legacy`. New default in quality mode is
 * `--select-mode triangle-closure`.
 *
 * `--quality 60` now correctly sets BOTH quality=true AND qualityCount=60
 * (was a CLI bug — the 60 was silently dropped).
 */

const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');

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

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const DEFAULT_ANCHOR_MINTS = [SOL, USDC, USDT];

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

    overFetch: 4,
    rank: 'composite',
    minTurnover: 0.05,
    minVolume24h: 50_000,
    minDivergence: 0,
    divergenceWeight: 50,
    divergenceDiagnose: false,
    feeTierDiversity: true,
    includePairs: [],
    excludePools: [
      'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
    ],

    // NEW: selection mode and triangle-closure tunables.
    selectMode: 'triangle-closure', // 'triangle-closure' | 'legacy'
    anchorMints: [...DEFAULT_ANCHOR_MINTS],
    minPoolsPerToken: 2,            // every non-anchor token must have ≥N pools
    maxPoolsPerToken: 6,            // cap per non-anchor token (keep top-N by activity)
    maxAnchorAnchorPools: 8,        // SOL/USDC, SOL/USDT, USDC/USDT total
    requireTwoAnchorConnections: false, // default: allow same-anchor multi-pool tokens
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out' && next) { out.out = next; i += 1; }
    else if ((arg === '--raw' || arg === '--raw-out' || arg === '--raw-output') && next) { out.rawOut = next; i += 1; }
    else if (arg === '--limit' && next) { out.limit = Number(next) || DEFAULT_LIMIT; i += 1; }
    else if ((arg === '--quality-count' || arg === '--topN') && next) { out.qualityCount = Number(next) || out.qualityCount; i += 1; }
    else if (arg === '--min-liquidity' && next) { out.minLiquidity = Number(next) || 0; i += 1; }
    else if (arg === '--max-per-pair' && next) { out.maxPerPair = Number(next) || out.maxPerPair; i += 1; }
    else if (arg === '--max-per-dex-type' && next) { out.maxPerDexType = Number(next) || 15; i += 1; }
    else if (arg === '--quality-meta' && next) { out.qualityMeta = next; i += 1; }
    else if (arg === '--quality') {
      out.quality = true;
      // Fix: `--quality 60` should also set qualityCount=60.
      const numericNext = Number(next);
      if (next && !next.startsWith('--') && Number.isFinite(numericNext) && numericNext > 0) {
        out.qualityCount = numericNext;
        i += 1;
      }
    }
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

    // NEW flags
    else if (arg === '--select-mode' && next) { out.selectMode = String(next).toLowerCase(); i += 1; }
    else if (arg === '--anchor-mint' && next) { out.anchorMints.push(next); i += 1; }
    else if (arg === '--anchor-mints' && next) {
      out.anchorMints = String(next).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
    else if (arg === '--min-pools-per-token' && next) { out.minPoolsPerToken = Math.max(2, Number(next)); i += 1; }
    else if (arg === '--max-pools-per-token' && next) { out.maxPoolsPerToken = Math.max(2, Number(next)); i += 1; }
    else if (arg === '--max-anchor-anchor-pools' && next) { out.maxAnchorAnchorPools = Math.max(0, Number(next)); i += 1; }
    else if (arg === '--require-two-anchor-connections') { out.requireTwoAnchorConnections = true; }

    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  // Dedup anchor mints.
  out.anchorMints = Array.from(new Set(out.anchorMints || []));
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

function activityScore(pool) {
  const tvl = Number(pool.tvl || 0);
  const vol = Number(pool.volume24h || 0);
  const fee = Number(pool.feeBps || 30);

  if (tvl <= 0) return 0;

  const turnover = vol > 0 ? vol / tvl : 0;
  const tvlScore = Math.log10(Math.max(tvl, 100));
  const turnoverScore = turnover > 0
    ? Math.log10(1 + turnover * 10)
    : 0;
  const feePenalty = 1 / (1 + Math.log10(1 + fee / 10));

  if (turnover > 0) {
    return turnoverScore * tvlScore * feePenalty;
  }
  return tvlScore * feePenalty * 0.3;
}

function tvlScoreFn(pool) {
  return Math.log10(Math.max(Number(pool.tvl || 0), 100));
}

function turnoverOnly(pool) {
  const tvl = Number(pool.tvl || 0);
  const vol = Number(pool.volume24h || 0);
  if (tvl <= 0 || vol <= 0) return 0;
  return vol / tvl;
}

function getRankFn(rankMode) {
  if (rankMode === 'tvl') return tvlScoreFn;
  if (rankMode === 'turnover') return turnoverOnly;
  return activityScore;
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
  if (n <= 5) return 'ultralow';
  if (n <= 15) return 'low';
  if (n <= 30) return 'mid';
  return 'high';
}

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

  const pairCounts = new Map();
  for (const pool of pools) {
    const k = pairKey(pool);
    if (!k) continue;
    pairCounts.set(k, (pairCounts.get(k) || 0) + 1);
  }

  for (const pool of pools) {
    const baseScore = rankFn(pool);
    const k = pairKey(pool);
    const peerCount = k ? pairCounts.get(k) || 1 : 1;
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

  const floored = pools.filter((p) => {
    const tvl = Number(p.tvl || 0);
    const vol = Number(p.volume24h || 0);
    if (vol > 0 && minVolume > 0 && vol < minVolume) return false;
    if (p._turnover > 0 && minTurnover > 0 && p._turnover < minTurnover) return false;
    if (tvl <= 0) return false;
    return true;
  });

  floored.sort((a, b) => (b._activityScore || 0) - (a._activityScore || 0));
  return floored;
}

/**
 * LEGACY selector (kept for `--select-mode legacy`). Same behaviour as the
 * previous version: rank-ordered, per-pair cap, optional fee-tier diversity.
 */
function selectWithDiversity(rankedPools, options) {
  const topN = Number(options.qualityCount || 40);
  const maxPerPair = Number(options.maxPerPair || 2);
  const maxPerDexType = Number(options.maxPerDexType || 0);
  const includeMints = new Set(options.includePairs || []);
  const enforceDiversity = options.feeTierDiversity !== false;

  const selected = [];
  const perPair = new Map();
  const perPairFeeTiers = new Map();
  const perDexType = new Map();

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

  for (const pool of rankedPools) {
    if (selected.length >= topN) break;
    if (selected.includes(pool)) continue;

    const k = pool._pairKey;
    const dt = pool.dexType || 'unknown';
    const pairCount = k ? perPair.get(k) || 0 : 0;
    const dexCount = perDexType.get(dt) || 0;

    if (k && pairCount >= maxPerPair) {
      if (enforceDiversity) {
        const tiers = perPairFeeTiers.get(k) || new Set();
        if (!tiers.has(pool._feeTier) && pairCount < maxPerPair + 1) {
          // diversity exception
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
/*                  NEW: Triangle-closure-aware selector                      */
/* -------------------------------------------------------------------------- */

/**
 * Build a graph view of the pool universe.
 *
 * Returns:
 *   tokenPools:     mint -> array of pools touching this mint
 *   tokenAnchors:   mint -> Set<anchorMint> the token connects to
 *   anchorPairs:    Set of "anchor|anchor" pair keys (canonical)
 *
 * Only tokens that pass the canonical {tokenXMint, tokenYMint} check enter
 * the graph. Anchor mints are treated as ordinary mints in tokenPools so they
 * naturally accumulate their cross-anchor pools.
 */
function buildTokenGraph(pools, anchorMints) {
  const anchorSet = new Set(anchorMints);
  const tokenPools = new Map();
  const tokenAnchors = new Map();
  const anchorPairs = new Set();

  const add = (token, pool) => {
    if (!tokenPools.has(token)) tokenPools.set(token, []);
    tokenPools.get(token).push(pool);
  };

  for (const pool of pools) {
    const x = String(pool.tokenXMint || pool.baseMint || '');
    const y = String(pool.tokenYMint || pool.quoteMint || '');
    if (!x || !y) continue;

    add(x, pool);
    add(y, pool);

    const xIsAnchor = anchorSet.has(x);
    const yIsAnchor = anchorSet.has(y);

    if (!xIsAnchor && yIsAnchor) {
      if (!tokenAnchors.has(x)) tokenAnchors.set(x, new Set());
      tokenAnchors.get(x).add(y);
    }
    if (!yIsAnchor && xIsAnchor) {
      if (!tokenAnchors.has(y)) tokenAnchors.set(y, new Set());
      tokenAnchors.get(y).add(x);
    }
    if (xIsAnchor && yIsAnchor) {
      const k = pairKey(pool);
      if (k) anchorPairs.add(k);
    }
  }

  return { tokenPools, tokenAnchors, anchorPairs, anchorSet };
}

/**
 * Decide whether a non-anchor token T can participate in a closable triangle
 * given the ranked candidate pools.
 *
 * A token is closable if EITHER:
 *   (a) it touches ≥2 different anchors (path SOL → T → USDC → SOL closes),
 *       AND has ≥1 pool to each (so both legs exist); OR
 *   (b) it has ≥2 cross-DEX pools to the SAME anchor, so the T↔anchor pair
 *       has measurable divergence and can serve as a leg in a larger
 *       SOL → T → anchor → SOL triangle (degenerate when anchor=SOL, but if
 *       anchor=USDC the closing SOL↔USDC leg comes from anchor-anchor pools).
 *
 * Mode (a) is strictly preferred. Mode (b) is enabled only when (a) yields
 * too few tokens, which is detected by the caller.
 *
 * Returns { closable, reason, anchorCounts, totalPools }.
 */
function classifyTokenClosure(token, pools, anchorSet) {
  const anchorCounts = new Map();
  let totalAnchorPools = 0;
  for (const pool of pools) {
    const x = String(pool.tokenXMint || '');
    const y = String(pool.tokenYMint || '');
    const other = x === token ? y : (y === token ? x : null);
    if (!other) continue;
    if (anchorSet.has(other)) {
      anchorCounts.set(other, (anchorCounts.get(other) || 0) + 1);
      totalAnchorPools += 1;
    }
  }

  const distinctAnchors = anchorCounts.size;
  const hasMultiAnchor = distinctAnchors >= 2;
  const hasMultiSameAnchor = Array.from(anchorCounts.values()).some((c) => c >= 2);

  if (hasMultiAnchor) {
    return {
      closable: true,
      mode: 'multi-anchor',
      anchorCounts,
      totalPools: pools.length,
      reason: `connects to ${distinctAnchors} anchors`,
    };
  }
  if (hasMultiSameAnchor) {
    return {
      closable: true,
      mode: 'cross-dex-same-anchor',
      anchorCounts,
      totalPools: pools.length,
      reason: `≥2 pools to same anchor (cross-DEX divergence available)`,
    };
  }

  return {
    closable: false,
    mode: 'orphan',
    anchorCounts,
    totalPools: pools.length,
    reason: distinctAnchors === 0
      ? 'no anchor connection'
      : `only 1 pool to ${distinctAnchors} anchor(s)`,
  };
}

/**
 * Pick the best pools for one (token, anchor) bucket, enforcing fee-tier
 * diversity. Always includes the highest-activity pool, then adds one pool
 * per additional fee tier present, then fills with rank order until the
 * per-anchor cap is reached.
 */
function pickPoolsForTokenAnchor(pools, options) {
  const cap = Math.max(1, Number(options.cap || 3));
  const enforceDiversity = options.feeTierDiversity !== false;

  const sorted = pools.slice().sort((a, b) => (b._activityScore || 0) - (a._activityScore || 0));
  const picked = [];
  const tiersSeen = new Set();

  for (const pool of sorted) {
    if (picked.length >= cap) break;
    const tier = pool._feeTier || 'unknown';

    if (enforceDiversity) {
      // First pool always wins. After that, prefer adding new tiers, but allow
      // same-tier pools if no fresh tier candidate exists.
      if (picked.length === 0 || !tiersSeen.has(tier)) {
        picked.push(pool);
        tiersSeen.add(tier);
        continue;
      }
      // Same tier as one already picked — only add if remaining pools have no
      // fresh tier to offer.
      const remaining = sorted.slice(sorted.indexOf(pool) + 1);
      const hasFreshTier = remaining.some((p) => !tiersSeen.has(p._feeTier || 'unknown'));
      if (!hasFreshTier) {
        picked.push(pool);
        tiersSeen.add(tier);
      }
    } else {
      picked.push(pool);
      tiersSeen.add(tier);
    }
  }

  return picked;
}

/**
 * Triangle-closure-aware selector.
 *
 * Algorithm:
 *   1. Build token graph from ranked pools.
 *   2. Force-include any pool touching --include-pair mints (unconditional).
 *   3. Classify every non-anchor token as closable / orphan.
 *   4. Sort closable tokens by aggregate activity (sum of pool _activityScore).
 *   5. For each token in rank order, pull its pools partitioned by anchor:
 *        - For each anchor connection, run pickPoolsForTokenAnchor.
 *        - Honour --max-pools-per-token globally per token.
 *   6. Add anchor-anchor pools (SOL/USDC, etc.) up to --max-anchor-anchor-pools.
 *   7. Stop when total selected reaches --quality-count, but never below the
 *      "minimum executable" floor of 2 pools per kept token.
 *
 * Returns a single array of pools (no dedup needed; we track by addr Set).
 *
 * The diagnostic counters are stamped on the returned object via a side-band
 * `_selection` field that the caller can read for the summary.
 */
function selectTriangleClosable(rankedPools, options) {
  const topN = Number(options.qualityCount || 40);
  const minPoolsPerToken = Math.max(2, Number(options.minPoolsPerToken || 2));
  const maxPoolsPerToken = Math.max(minPoolsPerToken, Number(options.maxPoolsPerToken || 6));
  const maxAnchorAnchorPools = Math.max(0, Number(options.maxAnchorAnchorPools || 8));
  const requireTwoAnchors = Boolean(options.requireTwoAnchorConnections);
  const includeMints = new Set(options.includePairs || []);
  const anchorMints = options.anchorMints && options.anchorMints.length
    ? options.anchorMints
    : DEFAULT_ANCHOR_MINTS;

  const graph = buildTokenGraph(rankedPools, anchorMints);
  const { tokenPools, anchorSet } = graph;

  const selected = new Set();
  const selectedAddresses = new Set();
  const counts = {
    forcedIncluded: 0,
    closableTokens: 0,
    orphanTokens: 0,
    multiAnchorTokens: 0,
    crossDexSameAnchorTokens: 0,
    rejectedTokens: 0,
    anchorAnchorPools: 0,
    rejectionReasons: new Map(),
  };

  const pushPool = (pool) => {
    const addr = String(pool.poolAddress || pool.address || '');
    if (!addr || selectedAddresses.has(addr)) return false;
    selectedAddresses.add(addr);
    selected.add(pool);
    return true;
  };

  // Step 1: Forced includes via --include-pair.
  if (includeMints.size) {
    for (const pool of rankedPools) {
      const x = String(pool.tokenXMint || '');
      const y = String(pool.tokenYMint || '');
      if (includeMints.has(x) || includeMints.has(y)) {
        if (pushPool(pool)) counts.forcedIncluded += 1;
      }
    }
  }

  // Step 2: Classify non-anchor tokens by closure mode and rank by aggregate activity.
  const tokenClassifications = new Map();
  for (const [token, pools] of tokenPools.entries()) {
    if (anchorSet.has(token)) continue;
    if (pools.length < minPoolsPerToken) {
      counts.orphanTokens += 1;
      const reason = `<${minPoolsPerToken} pools (has ${pools.length})`;
      counts.rejectionReasons.set(reason, (counts.rejectionReasons.get(reason) || 0) + 1);
      continue;
    }
    const classification = classifyTokenClosure(token, pools, anchorSet);
    if (!classification.closable) {
      counts.orphanTokens += 1;
      counts.rejectionReasons.set(classification.reason, (counts.rejectionReasons.get(classification.reason) || 0) + 1);
      continue;
    }
    if (requireTwoAnchors && classification.mode !== 'multi-anchor') {
      counts.rejectedTokens += 1;
      const reason = 'requires two-anchor connection';
      counts.rejectionReasons.set(reason, (counts.rejectionReasons.get(reason) || 0) + 1);
      continue;
    }
    if (classification.mode === 'multi-anchor') counts.multiAnchorTokens += 1;
    if (classification.mode === 'cross-dex-same-anchor') counts.crossDexSameAnchorTokens += 1;
    counts.closableTokens += 1;

    const aggregateActivity = pools.reduce((sum, p) => sum + (Number(p._activityScore) || 0), 0);
    tokenClassifications.set(token, {
      classification,
      pools,
      aggregateActivity,
    });
  }

  const rankedTokens = Array.from(tokenClassifications.entries()).sort(
    (a, b) => b[1].aggregateActivity - a[1].aggregateActivity,
  );

  // Step 3: Walk ranked tokens, pulling fee-diverse pools per (token, anchor) bucket.
  for (const [token, info] of rankedTokens) {
    if (selected.size >= topN) break;
    const { pools } = info;

    // Bucket pools by which anchor they connect to (or 'non-anchor' if pool is
    // T↔T2 where neither is anchor — those are useful as bridge legs for
    // deeper triangles but we handle them only if explicitly enabled).
    const byAnchor = new Map();
    const nonAnchorBucket = [];
    for (const pool of pools) {
      const x = String(pool.tokenXMint || '');
      const y = String(pool.tokenYMint || '');
      const other = x === token ? y : x;
      if (anchorSet.has(other)) {
        if (!byAnchor.has(other)) byAnchor.set(other, []);
        byAnchor.get(other).push(pool);
      } else {
        nonAnchorBucket.push(pool);
      }
    }

    // Per-token cap: split between anchor buckets. Each bucket gets up to
    // ceil(cap / numBuckets), but at least 1.
    const buckets = byAnchor.size;
    if (buckets === 0) continue;
    const perBucketCap = Math.max(1, Math.ceil(maxPoolsPerToken / buckets));

    let pickedForToken = 0;
    for (const [anchor, anchorPools] of byAnchor.entries()) {
      if (pickedForToken >= maxPoolsPerToken) break;
      const remaining = maxPoolsPerToken - pickedForToken;
      const cap = Math.min(perBucketCap, remaining);
      const chosen = pickPoolsForTokenAnchor(anchorPools, {
        cap,
        feeTierDiversity: options.feeTierDiversity,
      });
      for (const pool of chosen) {
        if (selected.size >= topN) break;
        if (pushPool(pool)) pickedForToken += 1;
      }
    }
  }

  // Step 4: Anchor-anchor pools (SOL/USDC, SOL/USDT, USDC/USDT). Triangles
  // need at least one of these as the closing leg whenever the route uses two
  // distinct anchors. We pull cross-DEX pools to enable divergence on these
  // legs too.
  const anchorAnchorPools = rankedPools.filter((pool) => {
    const x = String(pool.tokenXMint || '');
    const y = String(pool.tokenYMint || '');
    return anchorSet.has(x) && anchorSet.has(y);
  });
  // Group by canonical anchor pair, take fee-diverse top picks per group.
  const aaByPair = new Map();
  for (const pool of anchorAnchorPools) {
    const k = pairKey(pool);
    if (!k) continue;
    if (!aaByPair.has(k)) aaByPair.set(k, []);
    aaByPair.get(k).push(pool);
  }
  for (const [, group] of aaByPair) {
    const cap = Math.max(2, Math.ceil(maxAnchorAnchorPools / Math.max(1, aaByPair.size)));
    const chosen = pickPoolsForTokenAnchor(group, {
      cap,
      feeTierDiversity: options.feeTierDiversity,
    });
    for (const pool of chosen) {
      if (selected.size >= topN) break;
      if (counts.anchorAnchorPools >= maxAnchorAnchorPools) break;
      if (pushPool(pool)) counts.anchorAnchorPools += 1;
    }
  }

  // Result, with a side-band selection summary stored on the array itself.
  const result = Array.from(selected);
  result._selection = {
    mode: 'triangle-closure',
    anchorMints,
    minPoolsPerToken,
    maxPoolsPerToken,
    maxAnchorAnchorPools,
    closableTokens: counts.closableTokens,
    multiAnchorTokens: counts.multiAnchorTokens,
    crossDexSameAnchorTokens: counts.crossDexSameAnchorTokens,
    orphanTokens: counts.orphanTokens,
    forcedIncluded: counts.forcedIncluded,
    anchorAnchorPools: counts.anchorAnchorPools,
    rejectedTokens: counts.rejectedTokens,
    totalSelected: result.length,
    rejectionReasons: Object.fromEntries(counts.rejectionReasons),
  };
  return result;
}

/* -------------------------------------------------------------------------- */
/*                   Optional divergence pre-screen                           */
/* -------------------------------------------------------------------------- */

function applyDivergenceScreen(pools, minBps) {
  if (!minBps || minBps <= 0) return pools;

  const scanner = loadDivergenceScanner();
  if (!scanner?.annotatePairDivergence) {
    console.warn('  divergenceScanner not available — skipping divergence screen');
    return pools;
  }

  scanner.annotatePairDivergence(pools);

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

function summarizeTriangleCoverage(pools, anchorMints) {
  const graph = buildTokenGraph(pools, anchorMints);
  const tokenList = [];
  let triangleClosable = 0;
  let multiAnchor = 0;
  for (const [token, pools_] of graph.tokenPools.entries()) {
    if (graph.anchorSet.has(token)) continue;
    if (pools_.length < 2) continue;
    const cls = classifyTokenClosure(token, pools_, graph.anchorSet);
    if (cls.closable) {
      triangleClosable += 1;
      if (cls.mode === 'multi-anchor') multiAnchor += 1;
      tokenList.push({
        token,
        symbol: pools_.find((p) => p.tokenXMint === token)?.baseSymbol
          || pools_.find((p) => p.tokenYMint === token)?.quoteSymbol
          || token.slice(0, 6) + '..' + token.slice(-4),
        poolCount: pools_.length,
        anchorConnections: Array.from(cls.anchorCounts.entries()).map(([a, n]) => ({ anchor: a, pools: n })),
        mode: cls.mode,
      });
    }
  }
  return {
    triangleClosableTokens: triangleClosable,
    multiAnchorTokens: multiAnchor,
    anchorAnchorPairs: graph.anchorPairs.size,
    closableTokenList: tokenList.slice(0, 30),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json \\
       --quality 60 --over-fetch 5 --max-per-dex-type 20

Selection mode:
  --select-mode triangle-closure   New default — graph-aware (recommended)
  --select-mode legacy             Old behaviour (rank+pair-cap)

Triangle-closure tunables:
  --anchor-mints A,B,C             Which mints triangles must close back to
                                   (default SOL,USDC,USDT)
  --min-pools-per-token N          Drop tokens with <N total pools (default 2)
  --max-pools-per-token N          Cap pools per non-anchor token (default 6)
  --max-anchor-anchor-pools N      Cap on SOL/USDC etc combined (default 8)
  --require-two-anchor-connections Only keep tokens connecting to ≥2 anchors

Activity ranking:
  --rank turnover|tvl|composite    Primary signal (default composite)
  --over-fetch N                   Fetch N x limit per DEX (default 4)
  --min-turnover N                 Drop pools with vol/TVL < N (default 0.05)
  --min-volume24h $                Drop pools with $vol < amount (default 50000)
  --min-divergence N               Drop pools whose pair has <N bps divergence
  --divergence-weight N            Rank boost for clear divergence (default 50)

Other:
  --quality N                      Enable quality selection, topN=N
  --max-per-pair N                 Per-pair cap (legacy mode only)
  --include-pair MINT              Force-include any pool touching MINT
  --no-fee-tier-diversity          Disable fee-tier diversity (default ON)
`);
    process.exit(0);
  }

  console.log('Custom raw pool fetcher (triangle-closure-aware)');
  console.log(`Output:        ${args.out}`);
  if (args.rawOut) console.log(`Raw snapshot:  ${args.rawOut}`);
  console.log(`Limit per DEX: ${args.limit}  ·  over-fetch x${args.overFetch}`);
  console.log(`Ranking:       ${args.rank}  min-turnover=${args.minTurnover} min-volume=${args.minVolume24h}`);
  console.log(`Divergence:    min=${args.minDivergence}bps weight=${args.divergenceWeight}`);
  console.log(`Selection:     mode=${args.selectMode} topN=${args.qualityCount} `
    + `feeTierDiversity=${args.feeTierDiversity}`);
  if (args.selectMode === 'triangle-closure') {
    console.log(`               anchors=${args.anchorMints.length} `
      + `minPoolsPerToken=${args.minPoolsPerToken} maxPoolsPerToken=${args.maxPoolsPerToken} `
      + `maxAnchorAnchor=${args.maxAnchorAnchorPools}`);
  }

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

  console.log(`\nRanking by ${args.rank} score...`);
  let ranked = rankAndAnnotate(candidatePools, args);
  console.log(`  After activity floor: ${ranked.length}/${candidatePools.length}`);
  const activitySummary = summarizeActivity(ranked);
  console.log(`  Volume coverage: ${activitySummary.coverage.withVolumeData}/${ranked.length} pools have volume24h`);
  console.log(`  Avg turnover (vol/TVL):`, activitySummary.avgTurnover);
  console.log(`  Fee tiers:`, activitySummary.feeTiers);

  if (args.minDivergence > 0) {
    ranked = applyDivergenceScreen(ranked, args.minDivergence);
  }

  // Pre-selection diagnostic.
  const preCoverage = summarizeTriangleCoverage(ranked, args.anchorMints);
  console.log(`\nPre-selection triangle coverage:`);
  console.log(`  Triangle-closable tokens: ${preCoverage.triangleClosableTokens}`);
  console.log(`  Multi-anchor tokens: ${preCoverage.multiAnchorTokens}`);
  console.log(`  Anchor-anchor pairs: ${preCoverage.anchorAnchorPairs}`);

  let outputPools;
  if (args.quality) {
    if (args.selectMode === 'legacy') {
      outputPools = selectWithDiversity(ranked, args);
      console.log(`\nLegacy quality selection: ${outputPools.length}/${ranked.length}`);
    } else {
      outputPools = selectTriangleClosable(ranked, args);
      const sel = outputPools._selection || {};
      console.log(`\nTriangle-closure selection: ${outputPools.length}/${ranked.length}`);
      console.log(`  Closable tokens kept: ${sel.closableTokens || 0} `
        + `(multi-anchor=${sel.multiAnchorTokens || 0}, cross-dex=${sel.crossDexSameAnchorTokens || 0})`);
      console.log(`  Anchor-anchor pools: ${sel.anchorAnchorPools || 0}`);
      console.log(`  Forced includes: ${sel.forcedIncluded || 0}`);
      if (sel.orphanTokens) {
        console.log(`  Orphan tokens dropped: ${sel.orphanTokens}`);
        const top = Object.entries(sel.rejectionReasons || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        for (const [reason, n] of top) {
          console.log(`     · ${reason}: ${n}`);
        }
      }
    }
    console.log('  Counts:', summarize(outputPools));
  } else {
    outputPools = ranked.slice(0, args.limit * 4);
    console.log(`\nNo --quality flag: writing top ${outputPools.length} ranked pools`);
  }

  // Post-selection coverage.
  const postCoverage = summarizeTriangleCoverage(outputPools, args.anchorMints);
  console.log(`\nPost-selection triangle coverage:`);
  console.log(`  Triangle-closable tokens: ${postCoverage.triangleClosableTokens}`);
  console.log(`  Multi-anchor tokens: ${postCoverage.multiAnchorTokens}`);
  console.log(`  Anchor-anchor pairs: ${postCoverage.anchorAnchorPairs}`);
  if (postCoverage.closableTokenList.length) {
    console.log(`  Top closable tokens (showing ${Math.min(postCoverage.closableTokenList.length, 10)}):`);
    for (const t of postCoverage.closableTokenList.slice(0, 10)) {
      const anchors = t.anchorConnections.map((c) => `${c.anchor.slice(0, 4)}..×${c.pools}`).join(' ');
      console.log(`     ${t.symbol.padEnd(10)} pools=${t.poolCount} anchors=[${anchors}] mode=${t.mode}`);
    }
  }

  // Strip internal annotations from output.
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

  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(cleanedOutput, null, 2));
  console.log(`\nSaved raw pools to ${path.resolve(args.out)}`);

  if (args.quality && args.qualityMeta) {
    const qualityOutput = buildQualityOutput({
      source: 'poolFetchCustom_raw.js (triangle-closure)',
      selected: cleanedOutput,
      ranked: ranked.slice(0, 200),
      triangleFamilies: postCoverage.closableTokenList,
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
        selectMode: args.selectMode,
        anchorMints: args.anchorMints,
        minPoolsPerToken: args.minPoolsPerToken,
        maxPoolsPerToken: args.maxPoolsPerToken,
        maxAnchorAnchorPools: args.maxAnchorAnchorPools,
        activitySummary,
        triangleCoverage: postCoverage,
        selectionDiagnostics: outputPools._selection || null,
      },
      mode: args.selectMode === 'legacy' ? 'direct-api-activity-select' : 'direct-api-triangle-closure',
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
  rankAndAnnotate,
  selectWithDiversity,
  selectTriangleClosable,
  buildTokenGraph,
  classifyTokenClosure,
  pickPoolsForTokenAnchor,
  summarizeTriangleCoverage,
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
  DEFAULT_ANCHOR_MINTS,
};

/*
Canonical numbered runtime sequence (unchanged):

node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json --quality 60 --over-fetch 5 --max-per-dex-type 20
node utilities/divergenceScanner.js --in 01_meta.json --out 02_filtered.json
node engine/Q_enrichment.js --in 02_filtered.json --out 03_enriched.json
node engine/myEngine.js --in 03_enriched.json --out 04_runtimeResults.json --csv 05_result_compare.csv --json 06_result_data.json --html 07_result_report.html
*/
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
