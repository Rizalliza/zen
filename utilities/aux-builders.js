"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.buildWhirlpoolAux = buildWhirlpoolAux;
exports.buildClmmAux = buildClmmAux;
exports.buildDlmmAux = buildDlmmAux;
exports.buildNormalizedAux = buildNormalizedAux;

function toBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0) return 0n;
    if (s.toLowerCase() === 'nan' || s.toLowerCase() === 'inf' || s.toLowerCase() === '-inf') return 0n;
    if (/^-?\d+$/.test(s)) return BigInt(s);
    const parsed = Number(s);
    if (Number.isFinite(parsed)) return BigInt(Math.trunc(parsed));
    return 0n;
  }
  if (v === undefined || v === null) return 0n;
  return 0n;
}

function pow10(n) {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

function q64FromDecimal(dec) {
  const s = typeof dec === 'string' ? dec.trim() : String(dec);
  if (s.includes('e') || s.includes('E')) {
    return BigInt(Math.floor(Number(s) * Math.pow(2, 64)));
  }
  const parts = s.split('.');
  const intPart = parts[0] || '0';
  const fracPart = parts[1] || '';
  const scale = pow10(fracPart.length);
  const num = BigInt(intPart + fracPart);
  const Q64 = 1n << 64n;
  return (num * Q64) / scale;
}

function getSnapshot(input) {
  return input?.raw || input?._raw || input?.snapshot || input?.enriched || input?.pool || input || {};
}

function normalizeTickArrayRef(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return value.address || value.pubkey || value.publicKey || value.id || null;
}

function normalizeStructuredTickArrays(tickArrays) {
  if (!Array.isArray(tickArrays)) return [];
  return tickArrays
    .map((entry = {}) => {
      const data = entry.data && typeof entry.data === 'object' ? entry.data : entry;
      const ticks = Array.isArray(data.ticks) ? data.ticks : [];
      return {
        address: normalizeTickArrayRef(entry.address || entry.publicKey || entry.pubkey || entry.id || entry),
        data: {
          startTickIndex: Number(data.startTickIndex ?? data.start_index ?? entry.startTickIndex ?? 0),
          ticks: ticks.map((tick = {}) => ({
            initialized: Boolean(tick.initialized),
            liquidityNet: toBigInt(tick.liquidityNet ?? tick.liqNet ?? tick.net ?? tick.liquidity_net ?? 0),
            liquidityGross: toBigInt(tick.liquidityGross ?? tick.gross ?? tick.liquidity_gross ?? 0),
          })),
        },
      };
    })
    .filter((entry) => Array.isArray(entry.data.ticks) && entry.data.ticks.length > 0);
}

function normalizeTickList(ticks) {
  if (!Array.isArray(ticks)) return [];
  return ticks.map((t) => ({
    tickIndex: Number(t?.tickIndex ?? t?.index ?? t?.tick_index ?? t?.id ?? 0),
    sqrtPriceX64: toBigInt(t?.sqrtPriceX64 ?? t?.sqrt_price_x64 ?? t?.sqrtPrice ?? 0),
    liquidityNet: toBigInt(t?.liquidityNet ?? t?.liqNet ?? t?.net ?? t?.liquidity_net ?? 0),
    liquidityGross: toBigInt(t?.liquidityGross ?? t?.gross ?? t?.liquidity_gross ?? 0),
    initialized: t?.initialized !== false,
  })).sort((a, b) => a.tickIndex - b.tickIndex);
}

function normalizeBinList(bins) {
  if (!Array.isArray(bins)) return [];
  return bins.map((b) => {
    const pxQ64 = b?.pxAB_Q64 ?? b?.px_q64 ?? b?.priceAB_Q64 ?? (b?.price != null ? q64FromDecimal(b.price) : undefined);
    if (!pxQ64) throw new Error('DLMM bin missing pxAB_Q64/price');
    const reserveA = b?.reserveA ?? b?.x ?? b?.amountA ?? b?.reserve_a ?? b?.xAmount;
    const reserveB = b?.reserveB ?? b?.y ?? b?.amountB ?? b?.reserve_b ?? b?.yAmount;
    return {
      binId: Number(b?.binId ?? b?.id ?? b?.bin_id ?? 0),
      pxAB_Q64: toBigInt(pxQ64),
      reserveA: toBigInt(reserveA),
      reserveB: toBigInt(reserveB),
      feeBps: (b?.feeBps ?? b?.fee_bps) != null ? Number(b.feeBps ?? b.fee_bps) : undefined
    };
  });
}

function buildWhirlpoolAux(input) {
  const snapshot = getSnapshot(input);
  const feeBps = input.feeBps ?? input.fee_rate_bps ?? input.fee_rate ?? input.fee ?? snapshot.feeBps ?? snapshot.feeRateBps ?? 0;
  const st = {
    address: input.address || input.poolAddress || snapshot.address || snapshot.poolAddress,
    tokenAMint: input.tokenAMint || input.tokenXMint || input.mintA || input.baseMint || input.tokenA?.mint || snapshot.tokenAMint || snapshot.tokenXMint || snapshot.mintA || snapshot.baseMint || snapshot.tokenA?.mint,
    tokenBMint: input.tokenBMint || input.tokenYMint || input.mintB || input.quoteMint || input.tokenB?.mint || snapshot.tokenBMint || snapshot.tokenYMint || snapshot.mintB || snapshot.quoteMint || snapshot.tokenB?.mint,
    sqrtPriceX64: toBigInt(input.sqrtPriceX64 ?? input.sqrt_price_x64 ?? input.sqrtPrice?.x64 ?? snapshot.sqrtPriceX64 ?? snapshot.sqrt_price_x64 ?? snapshot.sqrtPrice?.x64),
    liquidity: toBigInt(input.liquidity ?? input.liquidityNet ?? snapshot.liquidity ?? 0),
    tickCurrentIndex: Number(input.tickCurrentIndex ?? input.tickCurrent ?? input.tick_current_index ?? snapshot.tickCurrentIndex ?? snapshot.tickCurrent ?? snapshot.tick_current_index ?? 0),
    tickSpacing: Number(input.tickSpacing ?? input.tick_spacing ?? snapshot.tickSpacing ?? snapshot.tick_spacing ?? 64),
    feeBps: Number(feeBps),
  };

  const structuredTickArrays =
    input.tickArrayData
    || input.aux?.whirlpool?.tickArrays
    || input.whirlpool?.tickArrays
    || snapshot.tickArrayData
    || snapshot.aux?.whirlpool?.tickArrays
    || snapshot.whirlpool?.tickArrays
    || [];
  if (Array.isArray(structuredTickArrays) && structuredTickArrays.length) {
    st.tickArrays = normalizeStructuredTickArrays(structuredTickArrays);
  }

  const ticks = input.ticks || input.tickArray || input.tick_arrays || snapshot.ticks || snapshot.tickArray || snapshot.tick_arrays || [];
  if (Array.isArray(ticks) && ticks.length) {
    st.ticks = normalizeTickList(ticks);
  } else if (input.nextTickIndex && input.nextTickSqrtPriceX64) {
    st.nextTickIndex = Number(input.nextTickIndex);
    st.nextTickSqrtPriceX64 = toBigInt(input.nextTickSqrtPriceX64);
  } else if (snapshot.nextTickIndex && snapshot.nextTickSqrtPriceX64) {
    st.nextTickIndex = Number(snapshot.nextTickIndex);
    st.nextTickSqrtPriceX64 = toBigInt(snapshot.nextTickSqrtPriceX64);
  }

  return { whirlpool: st };
}

function buildClmmAux(input) {
  const snapshot = getSnapshot(input);
  const feeBps = input.feeBps ?? input.fee_rate_bps ?? input.fee_rate ?? input.fee ?? snapshot.feeBps ?? snapshot.feeRateBps ?? 0;
  const st = {
    address: input.address || input.poolAddress || snapshot.address || snapshot.poolAddress,
    tokenAMint: input.tokenAMint || input.tokenXMint || input.mintA || input.baseMint || input.tokenA?.mint || snapshot.tokenAMint || snapshot.tokenXMint || snapshot.mintA || snapshot.baseMint || snapshot.tokenA?.mint,
    tokenBMint: input.tokenBMint || input.tokenYMint || input.mintB || input.quoteMint || input.tokenB?.mint || snapshot.tokenBMint || snapshot.tokenYMint || snapshot.mintB || snapshot.quoteMint || snapshot.tokenB?.mint,
    sqrtPriceX64: toBigInt(input.sqrtPriceX64 ?? input.sqrt_price_x64 ?? snapshot.sqrtPriceX64 ?? snapshot.sqrt_price_x64 ?? 0),
    liquidity: toBigInt(input.liquidity ?? input.liquidityNet ?? snapshot.liquidity ?? 0),
    tickCurrentIndex: Number(input.tickCurrentIndex ?? input.tickCurrent ?? input.tick_current_index ?? snapshot.tickCurrentIndex ?? snapshot.tickCurrent ?? snapshot.tick_current_index ?? 0),
    tickSpacing: Number(input.tickSpacing ?? input.tick_spacing ?? snapshot.tickSpacing ?? snapshot.tick_spacing ?? 10),
    feeBps: Number(feeBps),
  };

  const ticks = input.ticks || input.tickArray || input.tick_arrays || snapshot.ticks || snapshot.tickArray || snapshot.tick_arrays || [];
  if (Array.isArray(ticks) && ticks.length) {
    st.ticks = normalizeTickList(ticks);
  } else if (input.nextTickIndex && input.nextTickSqrtPriceX64) {
    st.nextTickIndex = Number(input.nextTickIndex);
    st.nextTickSqrtPriceX64 = toBigInt(input.nextTickSqrtPriceX64);
  } else if (snapshot.nextTickIndex && snapshot.nextTickSqrtPriceX64) {
    st.nextTickIndex = Number(snapshot.nextTickIndex);
    st.nextTickSqrtPriceX64 = toBigInt(snapshot.nextTickSqrtPriceX64);
  }

  return { clmm: st };
}

function buildDlmmAux(input) {
  const snapshot = getSnapshot(input);
  const feeBps = input.feeBps ?? input.fee_rate_bps ?? input.fee ?? snapshot.feeBps ?? snapshot.feeRateBps ?? 0;
  const st = {
    address: input.address || input.poolAddress || snapshot.address || snapshot.poolAddress,
    baseMint: input.baseMint || input.tokenXMint || input.mintA || input.tokenA?.mint || snapshot.baseMint || snapshot.tokenXMint || snapshot.mintA || snapshot.tokenA?.mint,
    quoteMint: input.quoteMint || input.tokenYMint || input.mintB || input.tokenB?.mint || snapshot.quoteMint || snapshot.tokenYMint || snapshot.mintB || snapshot.tokenB?.mint,
    feeBps: Number(feeBps),
    activeBinId: Number(input.activeBinId ?? input.binId ?? input.active_bin_id ?? snapshot.activeBinId ?? snapshot.binId ?? snapshot.active_bin_id ?? 0),
    binStep: Number(input.binStep ?? input.bin_step ?? snapshot.binStep ?? snapshot.bin_step ?? 0),
    bins: [],
  };

  const bins = input.bins || input.binLadder || input.bin_ladder || input.bin_array || snapshot.bins || snapshot.binLadder || snapshot.bin_ladder || snapshot.bin_array || [];
  if (!Array.isArray(bins) || bins.length === 0) {
    return { dlmm: st };
  }

  st.bins = normalizeBinList(bins);
  return { dlmm: st };
}

function buildNormalizedAux(input) {
  const dexType = String(input.dexType || input.type || input.dex || '').toUpperCase();
  if (dexType.includes('WHIRLPOOL')) return buildWhirlpoolAux(input);
  if (dexType.includes('CLMM')) return buildClmmAux(input);
  if (dexType.includes('DLMM')) return buildDlmmAux(input);
  return {};
}

module.exports = {
  buildWhirlpoolAux,
  buildClmmAux,
  buildDlmmAux,
  buildNormalizedAux,
};
