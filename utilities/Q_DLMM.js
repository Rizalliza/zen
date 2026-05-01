'use strict';
require('dotenv').config({ quiet: true });
const { Connection, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const DLMM = require('@meteora-ag/dlmm');
const fs = require('fs');
const { loadPoolsFromAny } = require("../utilities/poolLoader.js");
const { mergeCanonicalPool, validateQuoteContract, finalizeQuote } = require('../utilities/poolContract');

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    if (value.constructor?.name === 'BN' && typeof value.toString === 'function') return value.toString();
    if (typeof value.toBase58 === 'function') return value.toBase58();
  }
  return value;
}

/**
 * @param {Connection} 
 * @returns {(addr:string)=>Promise<DLMM.Pool>}
 */
async function loadDLMM(connection) {
  return async (addr) => {
    try {
      const pool = await DLMM.getPool(new PublicKey(addr), connection);
      return pool;
    } catch (error) {
      console.error(`Failed to load DLMM pool at address ${addr}:`, error);
      throw error;
    }
  };
}

// typedAmount.js
'use strict';

function ensure(cond, msg) { if (!cond) throw new Error(msg); }

function makeAmount({ mint, decimals, atomic }) {
  ensure(mint, 'mint required');
  ensure(Number.isInteger(decimals) && decimals >= 0, 'decimals required');
  // atomic as string to avoid BigInt/JSON pain
  ensure(atomic !== undefined && atomic !== null, 'atomic required');
  return { mint: mint.toString(), decimals, atomic: atomic.toString() };
}

function addFeeToLedger(ledger, feeAmt) {
  // ledger: Map<string, bigint> or plain object of strings
  const mint = feeAmt.mint;
  const a = BigInt(feeAmt.atomic);
  ledger[mint] = (ledger[mint] ? (BigInt(ledger[mint]) + a) : a).toString();
  return ledger;
}

//

function attachTypedToDlmmQuote(q, { inMint, outMint, inDecimals, outDecimals }) {
  // q has inAmountRaw/outAmountRaw/minOutAmountRaw already
  q.typed = {
    in: makeAmount({ mint: inMint, decimals: inDecimals, atomic: q.inAmountRaw }),
    out: makeAmount({ mint: outMint, decimals: outDecimals, atomic: q.outAmountRaw }),
    minOut: makeAmount({ mint: outMint, decimals: outDecimals, atomic: q.minOutAmountRaw }),
    // Only include fee here if you have a reliable fee amount + fee mint.
    // Otherwise: store feeRateBps and let fee be "unknown" until you compute it correctly.
    fee: null,
    feeRateBps: q.feeBps ?? null
  };

  // Hard assertions (safety rails)
  if (q.typed.in.atomic !== q.inAmountRaw.toString()) throw new Error('typed.in.atomic mismatch');
  if (q.typed.out.atomic !== q.outAmountRaw.toString()) throw new Error('typed.out.atomic mismatch');
  if (q.typed.minOut.atomic !== q.minOutAmountRaw.toString()) throw new Error('typed.minOut.atomic mismatch');

  return q;
}


class DLMMAdapter {
  constructor(connection, poolAddress, poolData = null) {
    this.connection = connection;
    this.poolAddress = new PublicKey(poolAddress);
    this.poolData = poolData;
    this.dlmm = null;
    this.pool = null;

    // Cache token metadata
    this.tokenXMint = null;
    this.tokenYMint = null;
    this.tokenXDecimals = null;
    this.tokenYDecimals = null;
    this.feeBps = null;
  }

  async init() {
    try {
      this.pool = await DLMM.create(this.connection, this.poolAddress);

      // Debugging
      // console.log("DLMM Pool keys:", Object.keys(this.pool));
      // if (this.pool.lbPair) console.log("DLMM Pool lbPair keys:", Object.keys(this.pool.lbPair));

      // Use poolData if available to populate what we can
      if (this.poolData) {
        this.tokenXMint = new PublicKey(this.poolData.baseMint);
        this.tokenYMint = new PublicKey(this.poolData.quoteMint);
        this.tokenXDecimals = this.poolData.baseDecimals;
        this.tokenYDecimals = this.poolData.quoteDecimals;
        // feeBps from poolData.feeRate (0.001 -> 10)
        this.feeBps = this.poolData.feeRate * 10000;
      } else {
        // Fallback if poolData not provided
        // Attempt to access lbPair directly
        if (!this.pool.lbPair) {
          console.log("Keys:", Object.keys(this.pool));
          throw new Error("lbPair not found on DLMM instance");
        }

        this.tokenXMint = this.pool.lbPair.tokenXMint;
        this.tokenYMint = this.pool.lbPair.tokenYMint;

        // Fetch decimals
        const [tokenXInfo, tokenYInfo] = await Promise.all([
          this.connection.getParsedAccountInfo(this.tokenXMint),
          this.connection.getParsedAccountInfo(this.tokenYMint)
        ]);

        this.tokenXDecimals = tokenXInfo.value.data.parsed.info.decimals;
        this.tokenYDecimals = tokenYInfo.value.data.parsed.info.decimals;

        // Get fee from parameters
        // lbPair.parameters.baseFactor is usually the base fee in bin steps or similar?
        // Use getFeeInfo() or similar if possible.
        // lbPair.parameters usually has baseFactor (bps * some multiplier)
        // Let's rely on hardcoded assumption or just log it for now
        // But wait, the previous code used poolState.feeBps

        // Try getFeeInfo if available
        // const feeInfo = this.pool.getFeeInfo(); // this might need params
        // For now, let's assume 25 bps or check lbPair.parameters
        this.feeBps = 25; // Default fallback
      }

      return this;
    } catch (error) {
      throw new Error(`DLMM init failed for ${this.poolAddress}: ${error.message}`);
    }
  }

  /**
   * Refresh pool state
   */
  async refresh() {
    if (this.pool) {
      await this.pool.refetchStates();
    }
  }
  async quoteExactIn({ pool, inputMint, outputMint, amountInAtomic, slippageBps = 20, connection }) {
    const type = normalizeType(pool);
    if (type !== 'dlmm') {
      switch (pool.dexType) {
        case 'METEORA_DLMM': return quoteDLMM(pool, amountInTyped, direction, opts);
        case 'RAYDIUM_CLMM': return quoteRaydiumCLMM(pool, amountInTyped, direction, opts);
        case 'ORCA_WHIRLPOOL': return quoteWhirlpool(pool, amountInTyped, direction, opts);
        case 'RAYDIUM_CPMM': return quoteCPMM(pool, amountInTyped, direction, opts);
        default: throw new Error('Unsupported dexType');

          return { ok: false, reason: 'quoteExactIn: unsupported type (dlmm only for now)' };
      }

    }
  }

  /**
   * LOADER: Fast quote for graph edge weights
   * Returns standardized format for triangular arbitrage
   */
  async quoteFastExactIn({ inAmountLamports, swapForY, slippageBps = 20 }) {
    try {
      const binArrays = await this.pool.getBinArrayForSwap(swapForY, 2);

      const quote = this.pool.swapQuote(
        new BN(inAmountLamports),
        swapForY,
        new BN(slippageBps),
        binArrays,
        false,
        this.poolData ? 0 : 0 // fallback
      );

      // Normalize to standard format
      return this._normalizeQuote(quote, inAmountLamports, swapForY, slippageBps, binArrays);

    } catch (error) {
      return {
        success: false,
        error: error.message,
        dexType: "METEORA_DLMM",
        poolAddress: this.poolAddress.toString()
      };
    }
  }

  /**
   * ACCURATE QUOTE: For actual execution
   */
  async quoteExactIn({ inAmountLamports, swapForY, slippageBps = 20 }) {
    try {
      await this.refresh(); // Fresh state before accurate quote

      const binArrays = await this.pool.getBinArrayForSwap(swapForY, 6);

      const quote = this.pool.swapQuote(
        new BN(inAmountLamports),
        swapForY,
        new BN(slippageBps),
        binArrays,
        false,
        3 // allow extra arrays (max 3)
      );

      return this._normalizeQuote(quote, inAmountLamports, swapForY, slippageBps, binArrays);

    } catch (error) {
      return {
        success: false,
        error: error.message,
        dexType: "METEORA_DLMM",
        poolAddress: this.poolAddress.toString()
      };
    }
  }

  /**
   * CRITICAL: Normalize DLMM quote to standard format
   * This is where you fix your decimal bugs
   */
  _normalizeQuote(quote, inAmountLamports, swapForY, slippageBps, binArrays) {
    // Determine which token is in/out based on swap direction
    const inDecimals = swapForY ? this.tokenXDecimals : this.tokenYDecimals;
    const outDecimals = swapForY ? this.tokenYDecimals : this.tokenXDecimals;

    // Convert lamports to decimal
    const inAmountDecimal = Number(inAmountLamports) / Math.pow(10, inDecimals);
    const outAmountDecimal = Number(quote.outAmount.toString()) / Math.pow(10, outDecimals);
    const minOutDecimal = Number(quote.minOutAmount.toString()) / Math.pow(10, outDecimals);

    // Calculate price & impact
    const executionPrice = outAmountDecimal / inAmountDecimal;
    const feeRate = this.feeBps / 10000; // e.g., 25 bps = 0.0025

    const rawImpact = quote.priceImpact;
    const priceImpact = rawImpact != null
      ? Number(rawImpact.toString())   // SDK returns Decimal as-is (0.005 = 0.5%)
      : 0;                              // do NOT call _estimatePriceImpact — it's broken

    const rawQuote = {
      // Raw values
      inAmountRaw: inAmountLamports.toString(),
      outAmountRaw: quote.outAmount.toString(),
      minOutAmountRaw: quote.minOutAmount.toString(),

      // Scaled decimals
      inAmountDecimal,
      outAmountDecimal,
      minOutAmountDecimal: minOutDecimal,

      // Price & cost
      executionPrice,
      priceImpact,
      fee: feeRate,

      // Metadata
      poolAddress: this.poolAddress.toString(),
      dexType: "METEORA_DLMM",
      swapForY,
      quoteSource: "sdk",

      // DLMM-specific data for execution
      binArrays: binArrays.map(ba => ba.publicKey.toString()),

      // Validation
      success: true,
      error: null
    };

    if (this.poolData) {
      return finalizeQuote(rawQuote, mergeCanonicalPool(this.poolData));
    }
    return rawQuote;
  }

  _estimatePriceImpact(inAmountDecimal, outAmountDecimal) {
    const execPx = outAmountDecimal / inAmountDecimal;
    const midPx = this.pool?.getCurrentPrice?.();
    if (!midPx || midPx <= 0) return 0;
    return Math.abs(execPx - Number(midPx)) / Number(midPx);
  }


  /**
   * Build swap TX - uses standardized quote object
   */
  async buildSwapTx({ user, standardQuote }) {
    const inTokenMint = standardQuote.swapForY ? this.tokenXMint : this.tokenYMint;
    const outTokenMint = standardQuote.swapForY ? this.tokenYMint : this.tokenXMint;
    const binArraysPubkey = standardQuote.binArrays.map(addr => new PublicKey(addr));

    console.log(`Building swap tx for ${inTokenMint.toBase58()} -> ${outTokenMint.toBase58()}...`)
    console.log(`User: ${user}`);
    console.log(JSON.stringify(standardQuote));
    console.log(`inputAmount: ${standardQuote.inAmountRaw}, outputAmount: ${standardQuote.outAmountRaw}`);
    console.log(`binArrays: ${JSON.stringify(binArraysPubkey)}`);
    console.log('-------------------');

    return await this.pool.swap({
      inToken: inTokenMint,
      outToken: outTokenMint,
      inAmount: new BN(standardQuote.inAmountRaw),
      minOutAmount: new BN(standardQuote.minOutAmountRaw),
      lbPair: this.pool.pubkey,
      user: new PublicKey(user),
      binArraysPubkey
    });
  }

}

//return this._normalizeQuote(quote, inAmountLamports, swapForY, slippageBps, binArrays);
// Normalize to standard format
module.exports = DLMMAdapter;
module.exports.DLMMAdapter = DLMMAdapter;
module.exports.makeAmount = makeAmount;
module.exports.addFeeToLedger = addFeeToLedger;
module.exports.attachTypedToDlmmQuote = attachTypedToDlmmQuote;
if (require.main === module) {
  (async () => {
    function parseArgs(argv) {
      const out = { input: null, output: null, amount: null, pool: null, rpc: null, help: false, pos: [] };
      const setKey = (k, v) => {
        const key = String(k || '').replace(/^--?/, '').toLowerCase();
        const val = v == null ? '' : String(v);
        if (['input', 'in'].includes(key)) out.input = val;
        else if (['output', 'out'].includes(key)) out.output = val;
        else if (['amount', 'amt'].includes(key)) out.amount = val;
        else if (['pool', 'pooladdress', 'address'].includes(key)) out.pool = val;
        else if (['rpc', 'rpcurl'].includes(key)) out.rpc = val;
      };
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a) continue;
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        const kv = a.match(/^([a-zA-Z][\\w-]*)=(.*)$/);
        if (kv) {
          let val = kv[2];
          if (val === '' && argv[i + 1] && !argv[i + 1].startsWith('-')) val = argv[++i];
          setKey(kv[1], val);
          continue;
        }
        if (a.startsWith('--')) {
          const key = a.replace(/^--?/, '');
          let val = argv[i + 1];
          if (val && val.startsWith('--')) val = '';
          if (val !== '' && val != null && !val.startsWith('--')) i++;
          setKey(key, val);
          continue;
        }
        out.pos.push(a);
      }
      return out;
    }

    const parsed = parseArgs(process.argv.slice(2));
    const args = process.argv.slice(2);
    // Arg 0: Input source (file path) OR Pool Address OR Output file (if old usage)
    // Arg 1: Amount
    // Arg 2: Output file (optional)

    let poolAddress = 'custom_raw-10.json';
    let amount = '1000000000';
    let outputFile = 'Qseries/_CLMM.json';
    let poolData = null;

    // Heuristic argument parsing
    const arg0 = parsed.input || parsed.pool || args[0];
    const arg1 = parsed.amount || args[1];
    const arg2 = parsed.output || args[2];

    try {
      if (arg0 && fs.existsSync(arg0) && fs.lstatSync(arg0).isFile()) {
        // First arg is a file -> Input Source
        console.log(`Loading pools from ${arg0}...`);
        const raw = JSON.parse(fs.readFileSync(arg0, 'utf8'));
        const pools = await loadPoolsFromAny(raw);
        const dlmmPool = pools.find(p => p.type === 'dlmm');

        if (!dlmmPool) {
          console.error("No DLMM pools found in input file.");
          process.exit(1);
        }
        poolAddress = dlmmPool.address;
        poolData = dlmmPool;
        console.log(`Found DLMM pool in file: ${poolAddress}`);

        if (arg1) amount = arg1;
        if (arg2) outputFile = arg2;

      } else if (arg0 && arg0.length > 30) {
        // Likely a pool address (PublicKey string is usually 32-44 chars)
        poolAddress = arg0;
        if (arg1) amount = arg1; // temp
        if (arg2) outputFile = arg2; // temp
      } else {
        // Fallback/Legacy: Output file first?

        outputFile = arg0 || outputFile;
        amount = arg1 || amount;
        poolAddress = arg2 || "9DiruRpjnAnzhn6ts5HGLouHtJrT1JGsPbXNYCrFz2ad"; // Default
      }

      console.log(`Running DLMM quoter...`);
      console.log(`Pool: ${poolAddress}`);
      console.log(`Amount: ${amount}`);
      console.log(`Output: ${outputFile}`);

      const rpcUrl = parsed.rpc || process.env.RPC_URL || "https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy";
      const adapter = new DLMMAdapter(new Connection(rpcUrl), poolAddress, poolData);
      await adapter.init();

      const fastQuote = await adapter.quoteFastExactIn({ inAmountLamports: Number(amount), swapForY: true });
      console.log('Fast Quote Result:', JSON.stringify(fastQuote, null, 2));

      const exactQuote = await adapter.quoteExactIn({ inAmountLamports: Number(amount), swapForY: true });
      console.log('Exact Quote Result:', JSON.stringify(exactQuote, null, 2));

      // Write to file
      const output = {
        timestamp: new Date().toISOString(),
        poolAddress,
        poolShape: poolData ? mergeCanonicalPool(poolData) : null,
        amount,
        fastQuote,
        exactQuote
      };

      // Ensure directory exists
      const dir = outputFile.substring(0, outputFile.lastIndexOf('/'));
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(outputFile, JSON.stringify(output, jsonReplacer, 2));
      console.log(`Quotes written to ${outputFile}`);
      process.exit(0);
    } catch (e) {
      console.error("Error:", e);
      process.exit(1);
    }
  })();
}

//. node engine/Q_DLMM.js
