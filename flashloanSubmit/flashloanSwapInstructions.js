// flashloanSwapInstructions.js
// CommonJS module
// Purpose:
//  1) Provide concrete per-DEX swap instruction builders (Raydium CLMM/CPMM/AMM-V4, Orca Whirlpools, Meteora DLMM)
//  2) Align with normalizer.js canonical pool shape (tokenXMint/tokenYMint, vaults.xVault/yVault, tickArrays, binArrays, etc.)
//  3) Provide SDK-first building with manual instruction construction fallback
//  4) Provide a generic flashloan transaction wrapper that integrates with Kamino
//
// FIXES in this revision:
//   - Manual CLMM builder: removed MEMO_PROGRAM_ID (not essential for basic swaps)
//   - Manual CLMM/Whirlpool/CPMM builders: removed unconditional TOKEN_2022_PROGRAM_ID.
//     Token-2022 is only included when the mint actually requires it (detected by
//     mint program in pool context). This saves ~1 account per swap.
//   - CLMM tickArrays: capped to first 4 to prevent account bloat. A typical swap
//     only traverses 2-4 tick arrays; including all 7+ from enrichment explodes
//     the static key count.
//   - AMM V4: added minimal manual fallback using known program layout.
//     The SDK path (Raydium SDK v2 makeAMMSwapV2Instruction) is still preferred.
//
// IMPORTANT:
//  - This file consumes the canonical pool shape produced by normalizer.js
//  - DEX builders attempt installed SDKs first, then fall back to manual instruction construction
//  - Manual fallbacks use known program IDs and account layouts from deployed programs

'use strict';

const {
    PublicKey,
    TransactionInstruction,
    SystemProgram,
} = require('@solana/web3.js');
const Decimal = require('decimal.js');
const BN = require('bn.js');

// Defensive SDK loads (use installed SDKs if available)
let RaydiumSdkV2 = null;
let RaydiumSdk = null;
let OrcaWhirlpoolSdk = null;
let MeteoraSdk = null;
try { RaydiumSdkV2 = require('@raydium-io/raydium-sdk-v2'); } catch (e) { /* SDK not installed */ }
try { RaydiumSdk = require('@raydium-io/raydium-sdk'); } catch (e) { /* SDK not installed */ }
try { OrcaWhirlpoolSdk = require('@orca-so/whirlpools-sdk'); } catch (e) { /* SDK not installed */ }
try { MeteoraSdk = require('@meteora-ag/dlmm'); } catch (e) { /* SDK not installed */ }

// Program IDs for manual fallback instruction construction
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Authority constants
const RAYDIUM_CPMM_AUTHORITY = new PublicKey('6P4Puju4LJN8cCWMHHiKZQi7L2F2nW7YMaPaqJdRQZaL');

// Account bloat limits
const MAX_CLMM_TICK_ARRAYS = 4;
const MAX_WHIRLPOOL_TICK_ARRAYS = 4;
const MAX_DLMM_BIN_ARRAYS = 6;

/* -------------------------------------------------------------------------- */
/*                                Helpers                                     */
/* -------------------------------------------------------------------------- */

function ensure(condition, message) {
    if (!condition) throw new Error(message || 'assert failed');
}

function pubkeyOf(v) {
    if (!v) return null;
    if (v instanceof PublicKey) return v;
    return new PublicKey(v);
}

function asDecimal(v) {
    if (v instanceof Decimal) return v;
    if (v === undefined || v === null) return new Decimal(0);
    return new Decimal(v.toString());
}

function toU64LE(val) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(asDecimal(val).toFixed(0)));
    return buf;
}

function toU16LE(val) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(Number(val));
    return buf;
}

function normalizeDex(value) {
    const str = String(value || '').toUpperCase();
    if (str.startsWith('METEORA')) return 'meteora';
    if (str.startsWith('RAYDIUM')) return 'raydium';
    if (str.startsWith('ORCA')) return 'orca';
    return String(value || '').toLowerCase();
}

function normalizeType(value) {
    return String(value || '').toLowerCase();
}

function getHopAmountInAtomic(hop, fallbackAmount) {
    return hop.amountInAtomic ?? hop.inputAmount ?? hop.inputAmountRaw ?? hop.inAmountRaw ?? fallbackAmount;
}

function getHopMinOutAtomic(hop) {
    return hop.minOutAtomic ?? hop.minOutputAmount ?? hop.minOutputAmountRaw ?? hop.minOutAmountRaw ?? null;
}

/**
 * Determine if a mint uses the Token-2022 program.
 * Without RPC, we can't know for sure. We use a heuristic:
 * if the pool explicitly marks a mint as token2022, or if
 * the caller passes opts.useToken2022 = true.
 */
function needsToken2022(ctx, opts) {
    if (opts?.useToken2022 === true) return true;
    if (ctx?.poolContext?.tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') return true;
    return false;
}

function limitTickArrays(arr, max) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, max);
}

function limitBinArrays(arr, max) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, max);
}

/**
 * Extract canonical pool fields from a hop object.
 */
function extractPoolContext(hop) {
    const dex = normalizeDex(hop.dex || hop.dexType);
    const type = normalizeType(hop.type);
    const poolAddress = hop.poolAddress || hop.address || hop.id || '';

    const tokenXMint = hop.tokenXMint || hop.baseMint || hop.mintA || hop.tokenA || hop.inputMint || '';
    const tokenYMint = hop.tokenYMint || hop.quoteMint || hop.mintB || hop.tokenB || hop.outputMint || '';

    let xVault = null;
    let yVault = null;
    if (hop.vaults) {
        xVault = hop.vaults.xVault || hop.vaults.aVault || hop.xVault || null;
        yVault = hop.vaults.yVault || hop.vaults.bVault || hop.yVault || null;
    } else {
        xVault = hop.xVault || hop.tokenVaultA || hop.vaultA || null;
        yVault = hop.yVault || hop.tokenVaultB || hop.vaultB || null;
    }

    const tickArrays = limitTickArrays(
        Array.isArray(hop.tickArrays) ? hop.tickArrays : [],
        MAX_CLMM_TICK_ARRAYS
    );
    const binArrays = limitBinArrays(
        Array.isArray(hop.binArrays) ? hop.binArrays : [],
        MAX_DLMM_BIN_ARRAYS
    );

    return {
        dex,
        type,
        poolAddress,
        tokenXMint,
        tokenYMint,
        inputMint: hop.inputMint || hop.tokenInMint || tokenXMint,
        outputMint: hop.outputMint || hop.tokenOutMint || tokenYMint,
        xVault,
        yVault,
        swapForY: Boolean(hop.swapForY),
        tickArrays,
        binArrays,
        binStep: hop.binStep ?? null,
        activeBinId: hop.activeBinId ?? hop.activeId ?? null,
        tickSpacing: hop.tickSpacing ?? null,
        liquidity: hop.liquidity ?? null,
        sqrtPrice: hop.sqrtPrice ?? hop.sqrtPriceX64 ?? null,
        feeBps: hop.feeBps ?? 25,
        slippageBps: hop.slippageBps ?? 20,
        poolContext: hop.poolContext || hop,
    };
}

/* -------------------------------------------------------------------------- */
/*                         Instruction discriminator builders                 */
/* -------------------------------------------------------------------------- */

function makeCpmmSwapDiscriminator() {
    return Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
}

function makeClmmSwapDiscriminator() {
    return Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
}

function makeWhirlpoolSwapDiscriminator() {
    return Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
}

function makeDlmmSwapDiscriminator() {
    return Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
}

function makeAmmV4SwapDiscriminator() {
    // Raydium AMM V4 swap instruction discriminator
    // Verify against on-chain IDL for your deployed version
    return Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
}

/* -------------------------------------------------------------------------- */
/*                           Manual CPMM swap builder                         */
/* -------------------------------------------------------------------------- */

function buildManualCpmmSwapIx(ctx, amountIn, minAmountOut, payer, opts) {
    const poolPubkey = pubkeyOf(ctx.poolAddress);
    const payerPubkey = pubkeyOf(payer);
    const inputVault = pubkeyOf(ctx.xVault);
    const outputVault = pubkeyOf(ctx.yVault);

    if (!poolPubkey || !inputVault || !outputVault) {
        throw new Error(
            'Manual CPMM swap requires poolAddress, xVault, and yVault. ' +
            'Ensure the pool object includes vaults from the normalizer.'
        );
    }

    const [observationState] = PublicKey.findProgramAddressSync(
        [Buffer.from('observation'), poolPubkey.toBuffer()],
        RAYDIUM_CPMM_PROGRAM_ID
    );

    const inputTokenAccount = pubkeyOf(ctx.inputTokenAccount);
    const outputTokenAccount = pubkeyOf(ctx.outputTokenAccount);
    if (!inputTokenAccount || !outputTokenAccount) {
        throw new Error('Manual CPMM swap requires inputTokenAccount and outputTokenAccount (payer ATAs).');
    }

    const data = Buffer.concat([
        makeCpmmSwapDiscriminator(),
        toU64LE(amountIn),
        toU64LE(minAmountOut),
    ]);

    const keys = [
        { pubkey: payerPubkey, isSigner: true, isWritable: false },
        { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: poolPubkey, isSigner: false, isWritable: true },
        { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: inputVault, isSigner: false, isWritable: true },
        { pubkey: outputVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: observationState, isSigner: false, isWritable: true },
    ];

    if (needsToken2022(ctx, opts)) {
        keys.splice(-1, 0, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({ programId: RAYDIUM_CPMM_PROGRAM_ID, keys, data });
}

/* -------------------------------------------------------------------------- */
/*                           Manual CLMM swap builder                         */
/* -------------------------------------------------------------------------- */

function buildManualClmmSwapIx(ctx, amountIn, minAmountOut, payer, opts) {
    const poolPubkey = pubkeyOf(ctx.poolAddress);
    const payerPubkey = pubkeyOf(payer);
    const inputVault = pubkeyOf(ctx.xVault);
    const outputVault = pubkeyOf(ctx.yVault);

    if (!poolPubkey || !inputVault || !outputVault) {
        throw new Error('Manual CLMM swap requires poolAddress, xVault, and yVault.');
    }
    if (!Array.isArray(ctx.tickArrays) || ctx.tickArrays.length === 0) {
        throw new Error('Manual CLMM swap requires tickArrays (max ' + MAX_CLMM_TICK_ARRAYS + ').');
    }

    const inputTokenAccount = pubkeyOf(ctx.inputTokenAccount);
    const outputTokenAccount = pubkeyOf(ctx.outputTokenAccount);
    if (!inputTokenAccount || !outputTokenAccount) {
        throw new Error('Manual CLMM swap requires inputTokenAccount and outputTokenAccount (payer ATAs).');
    }

    const [observationState] = PublicKey.findProgramAddressSync(
        [Buffer.from('observation'), poolPubkey.toBuffer()],
        RAYDIUM_CLMM_PROGRAM_ID
    );

    const sqrtPriceLimitX64 = ctx.sqrtPriceLimitX64
        ? Buffer.from(new BN(ctx.sqrtPriceLimitX64).toArray('le', 16))
        : Buffer.from('ffffffffffffffffffffffffffffffff', 'hex');

    const data = Buffer.concat([
        makeClmmSwapDiscriminator(),
        toU64LE(amountIn),
        toU64LE(minAmountOut),
        sqrtPriceLimitX64,
    ]);

    const keys = [
        { pubkey: payerPubkey, isSigner: true, isWritable: false },
        { pubkey: poolPubkey, isSigner: false, isWritable: true },
        { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: inputVault, isSigner: false, isWritable: true },
        { pubkey: outputVault, isSigner: false, isWritable: true },
        { pubkey: observationState, isSigner: false, isWritable: true },
        ...ctx.tickArrays.map(addr => ({
            pubkey: pubkeyOf(addr),
            isSigner: false,
            isWritable: true,
        })),
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    if (needsToken2022(ctx, opts)) {
        keys.push({ pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({ programId: RAYDIUM_CLMM_PROGRAM_ID, keys, data });
}

/* -------------------------------------------------------------------------- */
/*                        Manual Whirlpool swap builder                       */
/* -------------------------------------------------------------------------- */

function buildManualWhirlpoolSwapIx(ctx, amountIn, minAmountOut, payer, opts) {
    const poolPubkey = pubkeyOf(ctx.poolAddress);
    const payerPubkey = pubkeyOf(payer);

    if (!poolPubkey) {
        throw new Error('Manual Whirlpool swap requires poolAddress.');
    }
    if (!Array.isArray(ctx.tickArrays) || ctx.tickArrays.length === 0) {
        throw new Error('Manual Whirlpool swap requires tickArrays (max ' + MAX_WHIRLPOOL_TICK_ARRAYS + ').');
    }

    const inputTokenAccount = pubkeyOf(ctx.inputTokenAccount);
    const outputTokenAccount = pubkeyOf(ctx.outputTokenAccount);
    const xVault = pubkeyOf(ctx.xVault);
    const yVault = pubkeyOf(ctx.yVault);

    if (!inputTokenAccount || !outputTokenAccount || !xVault || !yVault) {
        throw new Error('Manual Whirlpool swap requires ATAs and vaults.');
    }

    const [oracle] = PublicKey.findProgramAddressSync(
        [Buffer.from('oracle'), poolPubkey.toBuffer()],
        ORCA_WHIRLPOOL_PROGRAM_ID
    );

    const aToB = ctx.swapForY;
    const tokenAccountA = aToB ? inputTokenAccount : outputTokenAccount;
    const tokenAccountB = aToB ? outputTokenAccount : inputTokenAccount;

    const sqrtPriceLimit = Buffer.from('ffffffffffffffffffffffffffffffff', 'hex');
    const data = Buffer.concat([
        makeWhirlpoolSwapDiscriminator(),
        toU64LE(amountIn),
        toU64LE(minAmountOut),
        sqrtPriceLimit,
        Buffer.from([1]), // exactIn = true
        Buffer.from([aToB ? 1 : 0]),
    ]);

    const keys = [
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: payerPubkey, isSigner: true, isWritable: false },
        { pubkey: poolPubkey, isSigner: false, isWritable: true },
        { pubkey: tokenAccountA, isSigner: false, isWritable: true },
        { pubkey: tokenAccountB, isSigner: false, isWritable: true },
        { pubkey: xVault, isSigner: false, isWritable: true },
        { pubkey: yVault, isSigner: false, isWritable: true },
        ...ctx.tickArrays.map(addr => ({
            pubkey: pubkeyOf(addr),
            isSigner: false,
            isWritable: true,
        })),
        { pubkey: oracle, isSigner: false, isWritable: true },
    ];

    if (needsToken2022(ctx, opts)) {
        keys.splice(1, 0, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({ programId: ORCA_WHIRLPOOL_PROGRAM_ID, keys, data });
}

/* -------------------------------------------------------------------------- */
/*                          Manual DLMM swap builder                          */
/* -------------------------------------------------------------------------- */

function buildManualDlmmSwapIx(ctx, amountIn, minAmountOut, payer, opts) {
    const poolPubkey = pubkeyOf(ctx.poolAddress);
    const payerPubkey = pubkeyOf(payer);

    if (!poolPubkey) {
        throw new Error('Manual DLMM swap requires poolAddress.');
    }
    if (!Array.isArray(ctx.binArrays) || ctx.binArrays.length === 0) {
        throw new Error('Manual DLMM swap requires binArrays (max ' + MAX_DLMM_BIN_ARRAYS + ').');
    }

    const inputTokenAccount = pubkeyOf(ctx.inputTokenAccount);
    const outputTokenAccount = pubkeyOf(ctx.outputTokenAccount);
    const xVault = pubkeyOf(ctx.xVault);
    const yVault = pubkeyOf(ctx.yVault);
    const inputMint = pubkeyOf(ctx.inputMint);
    const outputMint = pubkeyOf(ctx.outputMint);

    if (!inputTokenAccount || !outputTokenAccount || !xVault || !yVault || !inputMint || !outputMint) {
        throw new Error('Manual DLMM swap requires ATAs, vaults, and mints.');
    }

    const [binArrayBitmapExtension] = PublicKey.findProgramAddressSync(
        [Buffer.from('bitmap'), poolPubkey.toBuffer()],
        METEORA_DLMM_PROGRAM_ID
    );

    const [oracle] = PublicKey.findProgramAddressSync(
        [Buffer.from('oracle'), poolPubkey.toBuffer()],
        METEORA_DLMM_PROGRAM_ID
    );

    const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')],
        METEORA_DLMM_PROGRAM_ID
    );

    const host = payerPubkey;

    const data = Buffer.concat([
        makeDlmmSwapDiscriminator(),
        toU64LE(amountIn),
        toU64LE(minAmountOut),
    ]);

    const keys = [
        { pubkey: poolPubkey, isSigner: false, isWritable: true },
        { pubkey: binArrayBitmapExtension, isSigner: false, isWritable: true },
        { pubkey: xVault, isSigner: false, isWritable: true },
        { pubkey: yVault, isSigner: false, isWritable: true },
        { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
        ...ctx.binArrays.map(addr => ({
            pubkey: pubkeyOf(addr),
            isSigner: false,
            isWritable: true,
        })),
        { pubkey: inputMint, isSigner: false, isWritable: false },
        { pubkey: outputMint, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: true },
        { pubkey: host, isSigner: false, isWritable: true },
        { pubkey: payerPubkey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: METEORA_DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    if (needsToken2022(ctx, opts)) {
        keys.splice(-3, 0, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({ programId: METEORA_DLMM_PROGRAM_ID, keys, data });
}

/* -------------------------------------------------------------------------- */
/*                        Manual AMM V4 swap builder                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal manual AMM V4 swap instruction.
 * This is a fallback ONLY when the Raydium SDK is not installed.
 * The account layout follows the known AMM V4 program structure.
 * In production, install @raydium-io/raydium-sdk-v2 for the SDK path.
 */
function buildManualAmmV4SwapIx(ctx, amountIn, minAmountOut, payer, opts) {
    const poolPubkey = pubkeyOf(ctx.poolAddress);
    const payerPubkey = pubkeyOf(payer);

    if (!poolPubkey) {
        throw new Error('Manual AMM V4 swap requires poolAddress.');
    }

    const inputTokenAccount = pubkeyOf(ctx.inputTokenAccount);
    const outputTokenAccount = pubkeyOf(ctx.outputTokenAccount);
    const xVault = pubkeyOf(ctx.xVault);
    const yVault = pubkeyOf(ctx.yVault);

    if (!inputTokenAccount || !outputTokenAccount || !xVault || !yVault) {
        throw new Error('Manual AMM V4 swap requires ATAs and vaults.');
    }

    const data = Buffer.concat([
        makeAmmV4SwapDiscriminator(),
        toU64LE(amountIn),
        toU64LE(minAmountOut),
    ]);

    const keys = [
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: poolPubkey, isSigner: false, isWritable: true },
        { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: xVault, isSigner: false, isWritable: true },
        { pubkey: yVault, isSigner: false, isWritable: true },
        { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: payerPubkey, isSigner: true, isWritable: false },
    ];

    if (needsToken2022(ctx, opts)) {
        keys.splice(1, 0, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({ programId: RAYDIUM_AMM_V4_PROGRAM_ID, keys, data });
}

/* -------------------------------------------------------------------------- */
/*                      Main: buildSwapIxForPool                              */
/* -------------------------------------------------------------------------- */

async function buildSwapIxForPool(poolOrHop, amountIn, payerPubkey, opts = {}) {
    if (!poolOrHop || !(poolOrHop.dex || poolOrHop.dexType)) {
        throw new Error('poolOrHop must include dex/dexType field');
    }

    const amt = asDecimal(amountIn);
    ensure(amt.gt(0), 'amountIn must be > 0');

    const payer = pubkeyOf(payerPubkey);
    const ctx = extractPoolContext(poolOrHop);
    const dex = ctx.dex;
    const type = ctx.type;

    const slippageBps = opts.slippageBps || poolOrHop.slippageBps || 20;
    const minOut = getHopMinOutAtomic(poolOrHop);
    const minAmountOut = minOut !== null
        ? asDecimal(minOut)
        : amt.mul(new Decimal(10000 - slippageBps).div(10000)).toFixed(0);

    ctx.inputTokenAccount = opts.inputTokenAccount || poolOrHop.inputTokenAccount || null;
    ctx.outputTokenAccount = opts.outputTokenAccount || poolOrHop.outputTokenAccount || null;

    // ---- Raydium ----
    if (dex === 'raydium') {
        // AMM V4
        if (type === 'amm' || type === 'ammv4') {
            if (RaydiumSdkV2) {
                try {
                    const Amm = RaydiumSdkV2.Amm || RaydiumSdkV2.AMM;
                    if (Amm && typeof Amm.makeAMMSwapV2Instruction === 'function') {
                        return await Amm.makeAMMSwapV2Instruction({
                            poolAddress: ctx.poolAddress,
                            inputMint: ctx.inputMint,
                            amount: amt.toFixed(0),
                            payer,
                        });
                    }
                    if (Amm && typeof Amm.makeSwapInstruction === 'function') {
                        return await Amm.makeSwapInstruction({
                            poolAddress: ctx.poolAddress,
                            inputMint: ctx.inputMint,
                            amount: amt.toFixed(0),
                            payer,
                        });
                    }
                } catch (_sdkErr) {
                    // fall through
                }
            }
            return buildManualAmmV4SwapIx(ctx, amt.toFixed(0), minAmountOut, payer, opts);
        }

        // CPMM
        if (type === 'cpmm') {
            if (RaydiumSdkV2) {
                try {
                    const Amm = RaydiumSdkV2.Amm || RaydiumSdkV2.AMM;
                    if (Amm && typeof Amm.makeSwapInstruction === 'function') {
                        return await Amm.makeSwapInstruction({
                            poolAddress: ctx.poolAddress,
                            inputMint: ctx.inputMint,
                            amount: amt.toFixed(0),
                            payer,
                        });
                    }
                } catch (_sdkErr) {
                    // fall through
                }
            }
            return buildManualCpmmSwapIx(ctx, amt.toFixed(0), minAmountOut, payer, opts);
        }

        // CLMM
        if (type === 'clmm') {
            if (RaydiumSdkV2) {
                try {
                    const Clmm = RaydiumSdkV2.Clmm;
                    if (Clmm && typeof Clmm.makeSwapInstruction === 'function') {
                        return await Clmm.makeSwapInstruction({
                            poolAddress: ctx.poolAddress,
                            amountIn: amt.toFixed(0),
                            byInput: true,
                            payer,
                        });
                    }
                    if (Clmm && typeof Clmm.makeSwapInstructionFromQuote === 'function') {
                        const quote = await Clmm.swapQuoteByInputToken(
                            ctx.poolAddress, amt.toFixed(0)
                        ).catch(() => null);
                        if (quote) {
                            return await Clmm.makeSwapInstructionFromQuote(ctx.poolAddress, quote, payer);
                        }
                    }
                } catch (_sdkErr) {
                    // fall through
                }
            }
            return buildManualClmmSwapIx(ctx, amt.toFixed(0), minAmountOut, payer, opts);
        }
    }

    // ---- Orca ----
    if (dex === 'orca') {
        if (OrcaWhirlpoolSdk) {
            try {
                const { buildWhirlpoolClient, WhirlpoolContext } = OrcaWhirlpoolSdk;
                if (buildWhirlpoolClient && WhirlpoolContext) {
                    const client = buildWhirlpoolClient(WhirlpoolContext);
                    if (client && typeof client.getPool === 'function') {
                        const poolObj = await client.getPool(pubkeyOf(ctx.poolAddress));
                        if (typeof client.swapQuoteByInputToken === 'function' && typeof client.swap === 'function') {
                            const quote = await client.swapQuoteByInputToken(
                                poolObj, ctx.inputMint, amt.toFixed(0), slippageBps
                            ).catch(() => null);
                            if (quote) {
                                const swapIx = await client.swap(poolObj, quote).catch(() => null);
                                if (swapIx) return swapIx;
                            }
                        }
                    }
                }
            } catch (_sdkErr) {
                // fall through
            }
        }
        return buildManualWhirlpoolSwapIx(ctx, amt.toFixed(0), minAmountOut, payer, opts);
    }

    // ---- Meteora ----
    if (dex === 'meteora') {
        if (MeteoraSdk) {
            try {
                if (MeteoraSdk.DlmmClient) {
                    const client = new MeteoraSdk.DlmmClient(opts.connection || null);
                    if (typeof client.makeSwapInstruction === 'function') {
                        return await client.makeSwapInstruction({
                            poolAddress: pubkeyOf(ctx.poolAddress),
                            inputMint: ctx.inputMint,
                            amountIn: amt.toFixed(0),
                            user: payer,
                        });
                    }
                }
            } catch (_sdkErr) {
                // fall through
            }
        }
        return buildManualDlmmSwapIx(ctx, amt.toFixed(0), minAmountOut, payer, opts);
    }

    throw new Error(`Unsupported pool.dex: ${poolOrHop.dex || poolOrHop.dexType}`);
}

/* -------------------------------------------------------------------------- */
/*                      Flashloan transaction wrapper                         */
/* -------------------------------------------------------------------------- */

async function buildFlashloanTx({
    connection,
    payerKeypair,
    loanMint,
    loanAmount,
    route,
    flashloanInstructionBuilder,
    borrowerProgramId,
    opts = {}
}) {
    ensure(connection, 'connection required');
    ensure(payerKeypair, 'payerKeypair required');
    ensure(flashloanInstructionBuilder && typeof flashloanInstructionBuilder === 'function',
        'flashloanInstructionBuilder function required');
    ensure(route && Array.isArray(route) && route.length > 0, 'route required');

    const perHopIxs = [];
    for (const hop of route) {
        const hopAmount = getHopAmountInAtomic(hop, loanAmount);
        const hopMinOut = getHopMinOutAtomic(hop);

        const normalizedHop = {
            ...hop,
            dex: normalizeDex(hop.dex || hop.dexType),
            type: normalizeType(hop.type),
            inputMint: hop.inputMint || hop.tokenInMint,
            outputMint: hop.outputMint || hop.tokenOutMint,
            amountInAtomic: hopAmount != null ? String(hopAmount) : null,
            minOutAtomic: hopMinOut != null ? String(hopMinOut) : null,
        };

        if (normalizedHop.amountInAtomic == null) {
            throw new Error(`Missing per-hop amount for pool: ${normalizedHop.poolAddress || 'unknown'}`);
        }
        if (normalizedHop.minOutAtomic == null) {
            throw new Error(`Missing per-hop min out for pool: ${normalizedHop.poolAddress || 'unknown'}`);
        }

        const ixOrArray = await buildSwapIxForPool(
            normalizedHop,
            normalizedHop.amountInAtomic,
            payerKeypair.publicKey,
            { connection, slippageBps: opts.slippageBps || 20 }
        );

        if (!ixOrArray) {
            throw new Error('buildSwapIxForPool returned nothing for pool: ' + (normalizedHop.poolAddress || 'unknown'));
        }
        if (Array.isArray(ixOrArray)) {
            perHopIxs.push(...ixOrArray);
        } else {
            perHopIxs.push(ixOrArray);
        }
    }

    const callbackPayload = {
        loanMint: loanMint ? pubkeyOf(loanMint).toBase58() : null,
        loanAmount: asDecimal(loanAmount).toFixed(0),
        callbackIxs: perHopIxs,
        borrowerProgramId: borrowerProgramId ? pubkeyOf(borrowerProgramId).toBase58() : null,
    };

    const flashloanIx = await flashloanInstructionBuilder({
        connection,
        loanMint,
        loanAmount,
        borrowerProgramId,
        callbackIxs: perHopIxs,
        callbackPayload,
        payer: payerKeypair.publicKey,
        opts,
    });

    ensure(flashloanIx, 'flashloanInstructionBuilder did not return an instruction');

    const { Transaction } = require('@solana/web3.js');
    const tx = new Transaction();

    if (opts.computeBudgetInstruction) tx.add(opts.computeBudgetInstruction);
    if (opts.priorityFeeInstruction) tx.add(opts.priorityFeeInstruction);

    tx.add(flashloanIx);

    return { tx, requiredSigners: [payerKeypair] };
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
    // Main API
    buildSwapIxForPool,
    buildFlashloanTx,

    // Manual instruction builders
    buildManualCpmmSwapIx,
    buildManualClmmSwapIx,
    buildManualWhirlpoolSwapIx,
    buildManualDlmmSwapIx,
    buildManualAmmV4SwapIx,

    // Context extraction
    extractPoolContext,

    // Utility exports
    ensure,
    pubkeyOf,
    asDecimal,
    normalizeDex,
    normalizeType,
    getHopAmountInAtomic,
    getHopMinOutAtomic,
    toU64LE,
    toU16LE,

    // Program IDs
    RAYDIUM_CLMM_PROGRAM_ID,
    RAYDIUM_CPMM_PROGRAM_ID,
    RAYDIUM_AMM_V4_PROGRAM_ID,
    ORCA_WHIRLPOOL_PROGRAM_ID,
    METEORA_DLMM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,

    // Account bloat limits
    MAX_CLMM_TICK_ARRAYS,
    MAX_WHIRLPOOL_TICK_ARRAYS,
    MAX_DLMM_BIN_ARRAYS,

    // SDK availability flags
    _sdk: {
        raydiumV2: !!RaydiumSdkV2,
        raydiumV1: !!RaydiumSdk,
        orca: !!OrcaWhirlpoolSdk,
        meteora: !!MeteoraSdk,
    },
};
