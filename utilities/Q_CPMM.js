'use strict';

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { mergeCanonicalPool, finalizeQuote } = require('../utilities/poolContract');

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === undefined || value === null || value === '') return 0n;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    if (trimmed.includes('.')) return BigInt(trimmed.split('.')[0] || '0');
    return BigInt(trimmed);
  }
  return BigInt(value.toString());
}

function normalizePools(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.pools)) return raw.pools;
  if (Array.isArray(raw?.data)) return raw.data;
  return Object.values(raw || {});
}

function normalizePoolRecord(pool = {}) {
  return mergeCanonicalPool({
    ...pool,
    type: pool.type || 'cpmm',
    dexType: pool.dexType || 'RAYDIUM_CPMM',
  });
}

function reserveQuoteCpmm(poolShape, inAmountAtomic, swapForY, slippageBps = 20) {
  const amountIn = toBigInt(inAmountAtomic);
  const reserveX = toBigInt(poolShape.reserves?.x);
  const reserveY = toBigInt(poolShape.reserves?.y);
  const feeBps = BigInt(Number(poolShape.feeBps || 0));

  if (reserveX <= 0n || reserveY <= 0n) {
    return finalizeQuote({
      dexType: 'RAYDIUM_CPMM',
      poolAddress: poolShape.poolAddress,
      swapForY: Boolean(swapForY),
      inAmountRaw: String(inAmountAtomic ?? 0),
      outAmountRaw: '0',
      minOutAmountRaw: '0',
      success: false,
      error: 'CPMM reserve fallback unavailable: x/y reserves missing',
      quoteSource: 'native-reserves',
    }, poolShape);
  }

  const amountAfterFee = amountIn * (10_000n - feeBps) / 10_000n;
  const outAmount = swapForY
    ? (amountAfterFee * reserveY) / (reserveX + amountAfterFee)
    : (amountAfterFee * reserveX) / (reserveY + amountAfterFee);
  const minOutAmount = outAmount * (10_000n - BigInt(slippageBps || 0)) / 10_000n;

  return finalizeQuote({
    dexType: 'RAYDIUM_CPMM',
    poolAddress: poolShape.poolAddress,
    swapForY: Boolean(swapForY),
    inAmountRaw: amountIn.toString(),
    outAmountRaw: outAmount.toString(),
    minOutAmountRaw: minOutAmount.toString(),
    feeBps: Number(poolShape.feeBps || 0),
    tickSpacing: poolShape.tickSpacing,
    tickCurrent: poolShape.tickCurrent,
    tickArrays: poolShape.tickArrays,
    remainingAccounts: poolShape.remainingAccounts,
    vaults: poolShape.vaults,
    success: outAmount > 0n,
    error: outAmount > 0n ? null : 'CPMM quote produced zero output',
    quoteSource: 'native-reserves',
  }, poolShape);
}

class CPMMAdapter {
  constructor(connection, poolAddress, poolData = null) {
    this.connection = connection || new Connection(
      process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.poolAddress = poolAddress || poolData?.poolAddress || poolData?.address || '';
    this.poolPublicKey = null;
    try {
      this.poolPublicKey = this.poolAddress ? new PublicKey(this.poolAddress) : null;
    } catch (_error) {
      this.poolPublicKey = null;
    }
    this.poolShape = normalizePoolRecord({ ...(poolData || {}), poolAddress: this.poolAddress });
  }

  async init() {
    return this;
  }

  loadPools(raw) {
    return normalizePools(raw).map(normalizePoolRecord);
  }

  async getQuote(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
    return this.quoteExactIn(inAmountAtomic, swapForY, slippageBps, opts);
  }

  async quoteExactIn(inAmountAtomic, swapForY = true, slippageBps = 20, opts = {}) {
    const poolShape = normalizePoolRecord({ ...this.poolShape, ...(opts.pool || {}) });
    if (typeof opts?.quoteProvider === 'function') {
      const rawQuote = await opts.quoteProvider({
        pool: poolShape,
        inAmountAtomic: String(inAmountAtomic),
        swapForY,
        slippageBps,
        connection: this.connection,
      });
      return finalizeQuote({
        ...rawQuote,
        dexType: 'RAYDIUM_CPMM',
        poolAddress: poolShape.poolAddress,
        quoteSource: 'custom-provider',
      }, poolShape);
    }

    return reserveQuoteCpmm(poolShape, inAmountAtomic, swapForY, slippageBps);
  }
}

function parseArgs(argv) {
  const out = {
    input: 'custom_raw-10.json',
    pool: null,
    amount: '1000000000',
    output: 'Qseries/_CPMM.json',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      continue;
    }
    if (!out.pool && arg.length >= 32) out.pool = arg;
    else if (out.amount === '1000000000') out.amount = arg;
  }
  return out;
}

module.exports = CPMMAdapter;
module.exports.CPMMAdapter = CPMMAdapter;
module.exports.normalizePoolRecord = normalizePoolRecord;
module.exports.reserveQuoteCpmm = reserveQuoteCpmm;

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    const pool = normalizePools(raw).find((entry) => String(entry?.type || '').toLowerCase().includes('cpmm'));
    if (!pool) throw new Error('No CPMM pool found in input file');
    const adapter = new CPMMAdapter(null, args.pool || pool.poolAddress || pool.address || pool.id, pool);
    const quote = await adapter.quoteExactIn(args.amount, true, 50);
    const result = { poolAddress: adapter.poolShape.poolAddress, poolShape: adapter.poolShape, quote };
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  })().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
// node engine/Q_CPMM.js
