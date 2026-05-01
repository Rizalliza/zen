"use strict";

const BN = require('bn.js');

const MAX_TICK_INDEX = 443636;
const MIN_TICK_INDEX = -443636;
const TICK_ARRAY_SIZE = 88;
const MAX_SQRT_PRICE = "79226673515401279992447579055";
const MIN_SQRT_PRICE = "4295048016";

function toBN(value, fallback = '0') {
  if (BN.isBN(value)) return value;
  if (value === undefined || value === null || value === '') return new BN(fallback);
  return new BN(String(value));
}

function getStartTickIndex(tickIndex, tickSpacing, offset = 0) {
  const spacing = Number(tickSpacing);
  const index = Number(tickIndex);
  const arrayOffset = Number(offset);

  if (!Number.isFinite(index)) throw new Error('tickIndex must be finite');
  if (!Number.isFinite(spacing) || spacing <= 0) throw new Error('tickSpacing must be positive');
  if (!Number.isFinite(arrayOffset)) throw new Error('offset must be finite');

  const realIndex = Math.floor(index / spacing / TICK_ARRAY_SIZE);
  const startTickIndex = (realIndex + arrayOffset) * spacing * TICK_ARRAY_SIZE;
  const ticksInArray = TICK_ARRAY_SIZE * spacing;
  const minArrayStart = MIN_TICK_INDEX - ((MIN_TICK_INDEX % ticksInArray) + ticksInArray);

  if (startTickIndex < minArrayStart) throw new Error('startTickIndex is too small');
  if (startTickIndex > MAX_TICK_INDEX) throw new Error('startTickIndex is too large');

  return startTickIndex;
}

function normalizeTickArrayRef(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return value.address || value.pubkey || value.publicKey || value.id || null;
}

function normalizeStructuredTickArray(entry = {}) {
  const address = normalizeTickArrayRef(entry.address || entry.publicKey || entry.pubkey || entry.id || entry);
  const data = entry.data && typeof entry.data === 'object' ? entry.data : entry;
  const startTickIndex = Number(data.startTickIndex ?? data.start_index ?? entry.startTickIndex ?? 0);
  const rawTicks = Array.isArray(data.ticks) ? data.ticks : [];

  return {
    address,
    data: {
      startTickIndex,
      ticks: rawTicks.map((tick = {}) => ({
        initialized: Boolean(tick.initialized),
        liquidityNet: toBN(tick.liquidityNet || '0').toString(),
        liquidityGross: toBN(tick.liquidityGross || '0').toString(),
      })),
    },
  };
}

function createEmptyTickArrayData(startTickIndex, address = null) {
  return {
    address,
    data: {
      startTickIndex,
      ticks: Array.from({ length: TICK_ARRAY_SIZE }, () => ({
        initialized: false,
        liquidityNet: '0',
        liquidityGross: '0',
      })),
    },
  };
}

module.exports = {
  MAX_TICK_INDEX,
  MIN_TICK_INDEX,
  TICK_ARRAY_SIZE,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  getStartTickIndex,
  normalizeTickArrayRef,
  normalizeStructuredTickArray,
  createEmptyTickArrayData,
};
