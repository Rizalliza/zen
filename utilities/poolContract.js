'use strict';

const {
  normalizePoolRecord: normalizeCanonicalPool,
  normalizeQuote: normalizeCanonicalQuote,
} = require('../utilities/normalizer');

function normalizeKeyLike(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  if (typeof value.toString === 'function') return value.toString();
  if (value.address) return normalizeKeyLike(value.address);
  if (value.pubkey) return normalizeKeyLike(value.pubkey);
  if (value.publicKey) return normalizeKeyLike(value.publicKey);
  return String(value);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeKeyLike).filter(Boolean);
}

function candidateSources(pool = {}) {
  const sources = [];
  for (const candidate of [pool.normalized, pool, pool.raw, pool._raw, pool.state]) {
    if (candidate && typeof candidate === 'object' && !sources.includes(candidate)) {
      sources.push(candidate);
    }
  }
  return sources;
}

function looksLikeMint(value) {
  const text = String(value || '');
  return text.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(text);
}

function cleanSymbol(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text === '?' || looksLikeMint(text)) return null;
  return text;
}

function firstCleanSymbol(values = []) {
  for (const value of values) {
    const symbol = cleanSymbol(value);
    if (symbol) return symbol;
  }
  return null;
}

function normalizeReserves(pool = {}) {
  const sources = candidateSources(pool);
  const pick = (paths) => {
    for (const source of sources) {
      for (const path of paths) {
        const parts = path.split('.');
        let current = source;
        let missing = false;
        for (const part of parts) {
          if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), part)) {
            missing = true;
            break;
          }
          current = current[part];
        }
        if (!missing && current != null) return current;
      }
    }
    return '0';
  };

  const x = pick([
    'reserves.x',
    'reserves.amountA',
    'xReserve',
    'reserveA',
    'baseReserve',
    'amountA',
    'amount0',
    'reserve_x_amount',
  ]);
  const y = pick([
    'reserves.y',
    'reserves.amountB',
    'yReserve',
    'reserveB',
    'quoteReserve',
    'amountB',
    'amount1',
    'reserve_y_amount',
  ]);

  return { x: String(x ?? '0'), y: String(y ?? '0') };
}

function normalizeVaults(pool = {}) {
  const sources = candidateSources(pool);
  const pick = (paths) => {
    for (const source of sources) {
      for (const path of paths) {
        const parts = path.split('.');
        let current = source;
        let missing = false;
        for (const part of parts) {
          if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), part)) {
            missing = true;
            break;
          }
          current = current[part];
        }
        if (!missing && current != null && current !== '') return current;
      }
    }
    return null;
  };

  const xVault = normalizeKeyLike(pick([
    'vaults.xVault',
    'vaults.aVault',
    'xVault',
    'vaultA',
    'tokenVaultA',
    'tokenVault0',
    'reserveX',
    'vaultX.tokenVault',
    'vaultX.address',
  ]));
  const yVault = normalizeKeyLike(pick([
    'vaults.yVault',
    'vaults.bVault',
    'yVault',
    'vaultB',
    'tokenVaultB',
    'tokenVault1',
    'reserveY',
    'vaultY.tokenVault',
    'vaultY.address',
  ]));
  return { xVault, yVault };
}

function mergeCanonicalPool(pool = {}) {
  const canonical = (
    pool.normalized
    && typeof pool.normalized === 'object'
    && pool.normalized.address
    && pool.normalized.dexType
  ) ? pool.normalized : (normalizeCanonicalPool(pool) || {});
  const merged = { ...pool, normalized: canonical };
  const address = String(canonical.address || pool.poolAddress || pool.address || pool.id || '');
  const tokenXMint = String(canonical.tokenXMint || pool.tokenXMint || pool.baseMint || pool.mintA || pool.tokenA?.mint || '');
  const tokenYMint = String(canonical.tokenYMint || pool.tokenYMint || pool.quoteMint || pool.mintB || pool.tokenB?.mint || '');
  const reserves = normalizeReserves(merged);
  const vaults = normalizeVaults(merged);
  const tickArrays = normalizeStringArray(canonical.tickArrays || pool.tickArrays || pool.remainingAccounts || []);
  const tokenXSymbol = firstCleanSymbol([
    pool.tokenXSymbol,
    pool.baseSymbol,
    pool.tokenA?.symbol,
    pool.raw?.tokenXSymbol,
    pool.raw?.baseSymbol,
    pool.raw?.tokenA?.symbol,
    pool._raw?.tokenXSymbol,
    pool._raw?.baseSymbol,
    pool._raw?.tokenA?.symbol,
    canonical.tokenXSymbol,
    canonical.baseSymbol,
  ]);
  const tokenYSymbol = firstCleanSymbol([
    pool.tokenYSymbol,
    pool.quoteSymbol,
    pool.tokenB?.symbol,
    pool.raw?.tokenYSymbol,
    pool.raw?.quoteSymbol,
    pool.raw?.tokenB?.symbol,
    pool._raw?.tokenYSymbol,
    pool._raw?.quoteSymbol,
    pool._raw?.tokenB?.symbol,
    canonical.tokenYSymbol,
    canonical.quoteSymbol,
  ]);

  return {
    ...pool,
    ...canonical,
    address,
    poolAddress: address,
    dex: canonical.dex || pool.dex || 'unknown',
    type: canonical.type || pool.type || 'unknown',
    dexType: canonical.dexType || pool.dexType || 'UNKNOWN',
    tokenXMint,
    tokenYMint,
    tokenA: tokenXMint,
    tokenB: tokenYMint,
    mintA: tokenXMint,
    mintB: tokenYMint,
    baseMint: tokenXMint,
    quoteMint: tokenYMint,
    tokenXSymbol,
    tokenYSymbol,
    baseSymbol: tokenXSymbol,
    quoteSymbol: tokenYSymbol,
    tokenXDecimals: Number(canonical.tokenXDecimals ?? pool.tokenXDecimals ?? pool.baseDecimals ?? pool.tokenA?.decimals ?? 0),
    tokenYDecimals: Number(canonical.tokenYDecimals ?? pool.tokenYDecimals ?? pool.quoteDecimals ?? pool.tokenB?.decimals ?? 0),
    baseDecimals: Number(canonical.tokenXDecimals ?? pool.baseDecimals ?? pool.tokenXDecimals ?? pool.tokenA?.decimals ?? 0),
    quoteDecimals: Number(canonical.tokenYDecimals ?? pool.quoteDecimals ?? pool.tokenYDecimals ?? pool.tokenB?.decimals ?? 0),
    reserves,
    xReserve: reserves.x,
    yReserve: reserves.y,
    vaults,
    feeBps: Number(canonical.feeBps ?? pool.feeBps ?? 0),
    feeRateBps: Number(canonical.feeBps ?? pool.feeRateBps ?? pool.feeBps ?? 0),
    tickSpacing: canonical.tickSpacing ?? pool.tickSpacing ?? null,
    tickCurrent: canonical.tickCurrent ?? pool.tickCurrent ?? pool.tickCurrentIndex ?? null,
    tickCurrentIndex: canonical.tickCurrent ?? pool.tickCurrentIndex ?? pool.tickCurrent ?? null,
    tickArrays,
    remainingAccounts: normalizeStringArray(pool.remainingAccounts || canonical.tickArrays || pool.tickArrays || []),
    liquidity: canonical.liquidity ?? pool.liquidity ?? null,
    sqrtPrice: canonical.sqrtPrice ?? pool.sqrtPrice ?? pool.sqrtPriceX64 ?? null,
    sqrtPriceX64: canonical.sqrtPrice ?? pool.sqrtPriceX64 ?? pool.sqrtPrice ?? null,
    binStep: canonical.binStep ?? pool.binStep ?? null,
    activeBinId: canonical.activeBinId ?? pool.activeBinId ?? pool.activeId ?? null,
    bins: Array.isArray(canonical.bins) ? canonical.bins : (Array.isArray(pool.bins) ? pool.bins : []),
    binArrays: Array.isArray(canonical.binArrays) ? canonical.binArrays : (Array.isArray(pool.binArrays) ? pool.binArrays : []),
    normalized: canonical,
  };
}

function finalizeQuote(rawQuote = {}, pool = {}, extras = {}) {
  const poolShape = mergeCanonicalPool(pool);
  const normalized = normalizeCanonicalQuote({ ...rawQuote, ...extras }, poolShape);

  return {
    ...rawQuote,
    ...extras,
    ...normalized,
    poolAddress: normalized.poolAddress || poolShape.poolAddress,
    tickArrays: normalizeStringArray(
      normalized.tickArrays
      || extras.tickArrays
      || rawQuote.tickArrays
      || poolShape.tickArrays
    ),
    remainingAccounts: normalizeStringArray(
      normalized.remainingAccounts
      || extras.remainingAccounts
      || rawQuote.remainingAccounts
      || rawQuote.tickArrays
      || poolShape.remainingAccounts
    ),
    vaults: extras.vaults || rawQuote.vaults || poolShape.vaults,
    tokenXMint: normalized.tokenXMint || poolShape.tokenXMint,
    tokenYMint: normalized.tokenYMint || poolShape.tokenYMint,
    tokenInMint: normalized.tokenInMint || (normalized.swapForY ? poolShape.tokenXMint : poolShape.tokenYMint),
    tokenOutMint: normalized.tokenOutMint || (normalized.swapForY ? poolShape.tokenYMint : poolShape.tokenXMint),
    inputMint: normalized.inputMint || normalized.tokenInMint,
    outputMint: normalized.outputMint || normalized.tokenOutMint,
    inputDecimals: normalized.inputDecimals ?? normalized.inDecimals,
    outputDecimals: normalized.outputDecimals ?? normalized.outDecimals,
    success: Boolean(normalized.success),
    error: normalized.error || null,
  };
}

function validatePoolContract(pool = {}) {
  const required = [
    'poolAddress',
    'type',
    'dexType',
    'tokenXMint',
    'tokenYMint',
    'tokenXDecimals',
    'tokenYDecimals',
    'feeBps',
    'reserves.x',
    'reserves.y',
  ];
  const missing = [];

  for (const key of required) {
    const parts = key.split('.');
    let current = pool;
    for (const part of parts) {
      current = current?.[part];
    }
    if (current === undefined || current === null || current === '') {
      missing.push(key);
    }
  }

  return { valid: missing.length === 0, missing };
}

function validateRouteLegContract(leg = {}) {
  const required = [
    'poolAddress',
    'type',
    'dexType',
    'tokenInMint',
    'tokenOutMint',
    'swapDirection',
    'inputDecimals',
    'outputDecimals',
  ];
  const missing = required.filter((key) => leg[key] === undefined || leg[key] === null || leg[key] === '');
  return { valid: missing.length === 0, missing };
}

function validateQuoteContract(quote = {}) {
  const required = [
    'poolAddress',
    'dexType',
    'tokenInMint',
    'tokenOutMint',
    'swapDirection',
    'inAmountRaw',
    'outAmountRaw',
    'minOutAmountRaw',
    'inputDecimals',
    'outputDecimals',
    'success',
  ];
  const missing = required.filter((key) => quote[key] === undefined || quote[key] === null || quote[key] === '');
  return { valid: missing.length === 0, missing };
}

module.exports = {
  mergeCanonicalPool,
  finalizeQuote,
  normalizeKeyLike,
  normalizeStringArray,
  validatePoolContract,
  validateRouteLegContract,
  validateQuoteContract,
};
