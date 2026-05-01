"use strict";

const BN = require("bn.js");
const { PublicKey } = require("@solana/web3.js");

const MAX_BIN_ARRAY_SIZE = 70;
const DEFAULT_BIN_PER_POSITION = 70;
const DEFAULT_DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (value && typeof value.toNumber === "function") {
    try {
      const parsed = value.toNumber();
      return Number.isFinite(parsed) ? parsed : fallback;
    } catch (_error) {
      return fallback;
    }
  }
  return fallback;
}

function toPublicKey(value, fallback = null) {
  try {
    if (!value) return fallback;
    if (value instanceof PublicKey) return value;
    return new PublicKey(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeAmount(value) {
  if (value === null || value === undefined) return "0";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0";
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "0";
    if (trimmed.includes(".")) return trimmed.split(".")[0] || "0";
    return trimmed;
  }
  if (value && typeof value.toString === "function") {
    return normalizeAmount(value.toString());
  }
  return "0";
}

function normalizeBinId(bin) {
  return toNumber(
    bin?.bin_id ?? bin?.binId ?? bin?.id ?? bin?.index ?? bin?.activeBinId ?? bin?.active_id,
    0
  );
}

function binIdToBinArrayIndex(binId) {
  const id = toNumber(binId, 0);
  return id >= 0
    ? Math.floor(id / MAX_BIN_ARRAY_SIZE)
    : Math.floor((id - (MAX_BIN_ARRAY_SIZE - 1)) / MAX_BIN_ARRAY_SIZE);
}

function getBinArrayLowerUpperBinId(binArrayIndex) {
  const index = toNumber(binArrayIndex, 0);
  const lower = index * MAX_BIN_ARRAY_SIZE;
  const upper = lower + MAX_BIN_ARRAY_SIZE - 1;
  return [lower, upper];
}

function getBinIdIndexInBinArray(binId, lowerBinId, upperBinId) {
  const id = toNumber(binId, 0);
  const lower = toNumber(lowerBinId, 0);
  const upper = toNumber(upperBinId, 0);
  if (id < lower || id > upper) return null;
  return id - lower;
}

function normalizeBinRange(binRange, binStep, activeId) {
  if (!binRange && binRange !== 0) return null;

  if (typeof binRange === "object") {
    const min = toNumber(binRange.min ?? binRange.start ?? binRange.lower ?? activeId, activeId || 0);
    const max = toNumber(binRange.max ?? binRange.end ?? binRange.upper ?? activeId, activeId || 0);
    return {
      min,
      max,
      start: min,
      end: max,
      binStep: toNumber(binStep, binRange.binStep ?? 0),
      activeId: toNumber(activeId, binRange.activeId ?? 0),
    };
  }

  const id = toNumber(binRange, activeId || 0);
  return {
    min: id,
    max: id,
    start: id,
    end: id,
    binStep: toNumber(binStep, 0),
    activeId: toNumber(activeId, 0),
  };
}

function normalizeBinArrays(binArrays, binStep, activeId) {
  if (!Array.isArray(binArrays)) return [];

  return binArrays.map((entry) => {
    const index = toNumber(entry?.index ?? entry?.binArrayIndex ?? entry?.id ?? 0, 0);
    const [lowerBinId, upperBinId] = getBinArrayLowerUpperBinId(index);
    const key = toPublicKey(entry?.key ?? entry?.publicKey ?? entry?.pubkey ?? entry?.address, null);

    return {
      ...entry,
      index,
      key: key || undefined,
      address: key ? key.toBase58() : (entry?.address || null),
      binStep: toNumber(binStep, entry?.binStep ?? 0),
      activeId: toNumber(activeId, entry?.activeId ?? 0),
      lowerBinId,
      upperBinId,
    };
  });
}

function normalizeBins(bins, binStep, activeId) {
  if (!Array.isArray(bins)) return [];

  return bins
    .map((bin) => {
      const binId = normalizeBinId(bin);
      const binArrayIndex = binIdToBinArrayIndex(binId);
      const [lowerBinId, upperBinId] = getBinArrayLowerUpperBinId(binArrayIndex);

      return {
        ...bin,
        binId,
        binArrayIndex,
        lowerBinId,
        upperBinId,
        binStep: toNumber(bin?.binStep ?? binStep, 0),
        activeId: toNumber(bin?.activeId ?? activeId, 0),
        xAmount: normalizeAmount(bin?.xAmount ?? bin?.x_amount ?? bin?.reserveA ?? bin?.amount_x ?? bin?.reserveX ?? bin?.xReserve),
        yAmount: normalizeAmount(bin?.yAmount ?? bin?.y_amount ?? bin?.reserveB ?? bin?.amount_y ?? bin?.reserveY ?? bin?.yReserve),
        reserveA: normalizeAmount(bin?.reserveA ?? bin?.xAmount ?? bin?.x_amount ?? bin?.amount_x ?? bin?.reserveX ?? bin?.xReserve),
        reserveB: normalizeAmount(bin?.reserveB ?? bin?.yAmount ?? bin?.y_amount ?? bin?.amount_y ?? bin?.reserveY ?? bin?.yReserve),
        liquidity: normalizeAmount(bin?.liquidity ?? bin?.totalLiquidity),
      };
    })
    .filter((bin) => Number.isFinite(bin.binId));
}

function getBinRangeFromActiveId(activeId, binStep) {
  const id = toNumber(activeId, 0);
  const index = binIdToBinArrayIndex(id);
  const [min, max] = getBinArrayLowerUpperBinId(index);
  return {
    min,
    max,
    start: min,
    end: max,
    binStep: toNumber(binStep, 0),
    activeId: id,
  };
}

function getBinRangeFromIds(fromBinId, toBinId, binStep, activeId) {
  const from = toNumber(fromBinId, 0);
  const to = toNumber(toBinId, 0);
  const min = Math.min(from, to);
  const max = Math.max(from, to);
  return {
    min,
    max,
    start: min,
    end: max,
    binStep: toNumber(binStep, 0),
    activeId: toNumber(activeId, 0),
  };
}

function deriveBinArray(pair, index, programId = DEFAULT_DLMM_PROGRAM_ID) {
  const pairKey = toPublicKey(pair);
  const programKey = toPublicKey(programId, DEFAULT_DLMM_PROGRAM_ID);
  if (!pairKey) {
    throw new Error("DLMM pair public key is required");
  }

  const indexBuffer = Buffer.alloc(8);
  indexBuffer.writeBigInt64LE(BigInt(toNumber(index, 0)));

  return PublicKey.findProgramAddressSync(
    [Buffer.from("bin_array"), pairKey.toBuffer(), indexBuffer],
    programKey
  );
}

function getBinArraysRequiredByPositionRange(pair, fromBinId, toBinId, programId = DEFAULT_DLMM_PROGRAM_ID) {
  const startIndex = binIdToBinArrayIndex(Math.min(toNumber(fromBinId, 0), toNumber(toBinId, 0)));
  const endIndex = binIdToBinArrayIndex(Math.max(toNumber(fromBinId, 0), toNumber(toBinId, 0)));
  const indexes = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    indexes.push(index);
  }

  return indexes.map((index) => {
    const [key] = deriveBinArray(pair, index, programId);
    return { key, index };
  });
}

module.exports = {
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
