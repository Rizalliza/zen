'use strict';

function toFiniteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function atomicToUi(value, decimals) {
  const amount = toFiniteNumber(value, 0);
  const dec = Math.max(0, toFiniteNumber(decimals, 0));
  return amount / (10 ** dec);
}

function deriveMidPrice(pool = {}, inputMint = null, outputMint = null) {
  const tokenXMint = pool.tokenXMint || pool.baseMint || pool.mintA || pool.tokenA?.mint || null;
  const tokenYMint = pool.tokenYMint || pool.quoteMint || pool.mintB || pool.tokenB?.mint || null;
  const xDecimals = toFiniteNumber(pool.tokenXDecimals ?? pool.baseDecimals ?? pool.decimalsA, 0);
  const yDecimals = toFiniteNumber(pool.tokenYDecimals ?? pool.quoteDecimals ?? pool.decimalsB, 0);

  let yPerX = toFiniteNumber(pool.currentPrice, 0);
  if (!(yPerX > 0)) {
    const xReserve = toFiniteNumber(pool.reserves?.x ?? pool.xReserve, 0);
    const yReserve = toFiniteNumber(pool.reserves?.y ?? pool.yReserve, 0);
    if (xReserve > 0 && yReserve > 0) {
      const xUi = xReserve / (10 ** xDecimals);
      const yUi = yReserve / (10 ** yDecimals);
      yPerX = xUi > 0 ? yUi / xUi : 0;
    }
  }

  if (!(yPerX > 0) || !inputMint || !outputMint) return yPerX > 0 ? yPerX : null;
  if (inputMint === tokenXMint && outputMint === tokenYMint) return yPerX;
  if (inputMint === tokenYMint && outputMint === tokenXMint) return 1 / yPerX;
  return yPerX;
}

function calculateQuotePriceMetrics({
  pool = {},
  inputMint = null,
  outputMint = null,
  inputAmountRaw = 0,
  outputAmountRaw = 0,
  inputDecimals = 0,
  outputDecimals = 0,
  quoteImpact = null,
  feeBps = 0,
} = {}) {
  const inputUi = atomicToUi(inputAmountRaw, inputDecimals);
  const outputUi = atomicToUi(outputAmountRaw, outputDecimals);
  const executionPrice = inputUi > 0 ? outputUi / inputUi : null;
  const midPrice = deriveMidPrice(pool, inputMint, outputMint);
  const feePct = toFiniteNumber(feeBps, 0) / 100;
  const feeAdjustedMidPrice = midPrice != null ? midPrice * (1 - (toFiniteNumber(feeBps, 0) / 10000)) : null;

  let impactPct = null;
  const explicitImpact = toFiniteNumber(quoteImpact, null);
  if (explicitImpact !== null && Number.isFinite(explicitImpact)) {
    impactPct = Math.abs(explicitImpact) <= 1 ? Math.abs(explicitImpact) * 100 : Math.abs(explicitImpact);
  } else if (executionPrice != null && feeAdjustedMidPrice && feeAdjustedMidPrice > 0) {
    impactPct = Math.max(0, ((feeAdjustedMidPrice - executionPrice) / feeAdjustedMidPrice) * 100);
  }

  const impactBps = impactPct == null ? null : impactPct * 100;
  const grossImpactPct = impactPct == null ? null : impactPct + feePct;
  const tradeRatioPct = toFiniteNumber(pool.tvl, 0) > 0 && inputUi > 0
    ? (inputUi / toFiniteNumber(pool.tvl, 1)) * 100
    : null;

  return {
    midPrice,
    feeAdjustedMidPrice,
    executionPrice,
    impactPct,
    impactBps,
    grossImpactPct,
    feePct,
    tradeRatioPct,
  };
}

module.exports = {
  calculateQuotePriceMetrics,
};
