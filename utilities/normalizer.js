'use strict';
/**
 * UNIFIED POOL NORMALIZER
 * 
 * Runs ONCE after raw API fetch
 * Outputs canonical pool shape for entire pipeline
 * 
 * Every downstream function uses THIS shape unchanged
 * NO re-normalization in Q-series, myEngine, or anywhere else
 * 
 * CANONICAL POOL SHAPE:
 * {
 *   // Identity
 *   address: string,
 *   poolAddress: string,
 *   dexType: 'RAYDIUM_CLMM' | 'RAYDIUM_CPMM' | 'METEORA_DLMM' | 'ORCA_WHIRLPOOL',
 *   dex: 'raydium' | 'orca' | 'meteora',
 *   type: 'clmm' | 'cpmm' | 'dlmm' | 'whirlpool',
 *   
 *   // Token info (canonical X/Y orientation)
 *   tokenXMint: string,
 *   tokenYMint: string,
 *   tokenXDecimals: number,
 *   tokenYDecimals: number,
 *   
 *   // Aliases for legacy consumers (NEVER remove — downstream depends on these)
 *   baseMint: string,
 *   quoteMint: string,
 *   tokenA: string,
 *   tokenB: string,
 *   mintA: string,
 *   mintB: string,
 *   baseDecimals: number,
 *   quoteDecimals: number,
 *   
 *   // Reserves (atomic, as strings)
 *   reserves: { x: string, y: string },
 *   xReserve: string,
 *   yReserve: string,
 *   
 *   // Vaults
 *   vaults: { xVault: string|null, yVault: string|null },
 *   xVault: string|null,
 *   yVault: string|null,
 *   
 *   // Pricing & Fees
 *   feeBps: number,
 *   feeBpsCanonical: number,
 *   feePctCanonical: number,
 *   
 *   // CLMM/Whirlpool specific
 *   tickSpacing?: number,
 *   tickCurrent?: number,
 *   tickArrays?: string[],
 *   liquidity?: string,
 *   sqrtPrice?: string,
 *   sqrtPriceX64?: string,
 *   
 *   // DLMM specific
 *   binStep?: number,
 *   activeBinId?: number,
 *   activeId?: number,
 *   bins?: array,
 *   binArrays?: string[],
 *   
 *   // Metadata
 *   tvl?: number,
 *   volume24h?: number,
 *   
 *   // Source retention
 *   _raw: object,
 *   normalized: true
 * }
 * 
 * UNIFIED QUOTE NORMALIZER
 * 
 * Takes raw quotes from Q-series adapters (with only atomic values)
 * and normalizes them to include:
 * - Decimal conversions
 * - Execution prices
 * - 3-leg swap compatible format
 * - Fee calculations
 * - All execution-critical fields preserved (tickArrays, binArrays, etc.)
 */

const Decimal = require('decimal.js');
const { getSymbolFromMint } = require('./symbolDisplay');

/* -------------------------------------------------------------------------- */
/*                               Core helpers                                 */
/* -------------------------------------------------------------------------- */

function firstOf(obj, paths) {
    if (!obj) return null;
    for (const path of paths) {
        const parts = path.split('.');
        let current = obj;
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
    return null;
}

function firstOfMany(objects, paths) {
    for (const obj of objects || []) {
        const value = firstOf(obj, paths);
        if (value != null) return value;
    }
    return null;
}

function candidateSources(raw) {
    const sources = [];
    for (const candidate of [
        raw,
        raw?.normalized,
        raw?.data?.[0],
        raw?.raw,
        raw?.raw?.data?.[0],
        raw?._raw,
        raw?.state,
        raw?.clmm,
        raw?.whirlpool,
    ]) {
        if (candidate && typeof candidate === 'object' && !sources.includes(candidate)) {
            sources.push(candidate);
        }
    }
    return sources;
}

function toStr(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val.toString) return val.toString();
    return String(val);
}

function toAtomicStr(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'number') {
        return Number.isFinite(val) ? String(Math.trunc(val)) : null;
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) return null;
        if (trimmed.includes('.')) return trimmed.split('.')[0] || '0';
        return trimmed;
    }
    if (typeof val === 'object' && val.toString) return toAtomicStr(val.toString());
    return String(val);
}

function toNum(val, fallback = 0) {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'number') return Number.isFinite(val) ? val : fallback;
    if (typeof val === 'string') {
        const n = Number(val);
        return Number.isFinite(n) ? n : fallback;
    }
    if (typeof val === 'bigint') return Number(val);
    return fallback;
}

function toDecimalSafe(val, fallback = '0') {
    try {
        if (val === null || val === undefined || val === '') return new Decimal(fallback);
        return new Decimal(String(val));
    } catch (_error) {
        return new Decimal(fallback);
    }
}

function symbolFromMint(mint) {
    if (!mint) return '';
    return getSymbolFromMint(mint) || '';
}

/* -------------------------------------------------------------------------- */
/*                             Price / impact                                 */
/* -------------------------------------------------------------------------- */

function getMidPriceFromPool(pool = {}, swapForY = true) {
    const tokenXDecimals = toNum(firstOf(pool, ['tokenXDecimals', 'baseDecimals', 'tokenA.decimals']), 0);
    const tokenYDecimals = toNum(firstOf(pool, ['tokenYDecimals', 'quoteDecimals', 'tokenB.decimals']), 0);
    const sqrtPriceX64 = toDecimalSafe(firstOf(pool, ['sqrtPriceX64', 'sqrtPrice', 'state.sqrtPriceX64']), '0');

    if (sqrtPriceX64.gt(0)) {
        const q64 = new Decimal(2).pow(64);
        const yPerX = sqrtPriceX64.div(q64).pow(2)
            .mul(new Decimal(10).pow(tokenXDecimals - tokenYDecimals));
        if (yPerX.gt(0)) {
            return swapForY ? yPerX : new Decimal(1).div(yPerX);
        }
    }

    const reserveX = toDecimalSafe(firstOf(pool, ['reserves.x', 'xReserve', 'baseReserve', 'amountA', 'reserve_x_amount']), '0');
    const reserveY = toDecimalSafe(firstOf(pool, ['reserves.y', 'yReserve', 'quoteReserve', 'amountB', 'reserve_y_amount']), '0');

    if (reserveX.gt(0) && reserveY.gt(0)) {
        const xUi = reserveX.div(new Decimal(10).pow(tokenXDecimals));
        const yUi = reserveY.div(new Decimal(10).pow(tokenYDecimals));
        if (xUi.gt(0) && yUi.gt(0)) {
            return swapForY ? yUi.div(xUi) : xUi.div(yUi);
        }
    }

    const liquidityUsd = toDecimalSafe(firstOf(pool, ['tvl', 'liquidity.liquidityUsd', 'liquidity.totalLiquidityUsd']), '0');
    if (liquidityUsd.gt(0)) {
        return null;
    }

    return null;
}

function estimatePriceImpact(rawQuote = {}, pool = {}, inDec, outDec, swapForY, feeBps) {
    const explicitImpact = firstOf(rawQuote, ['priceImpact', 'impact']);
    if (explicitImpact !== null && explicitImpact !== undefined && explicitImpact !== '') {
        const explicitImpactNum = toNum(explicitImpact, 0);
        if (explicitImpactNum > 0) {
            return explicitImpactNum;
        }
    }

    const midPrice = getMidPriceFromPool(pool, swapForY);
    const feeFraction = new Decimal(toNum(feeBps, 0)).div(10000);

    if (midPrice && midPrice.gt(0) && inDec.gt(0) && outDec.gt(0)) {
        const executionPrice = outDec.div(inDec);
        const feeAdjustedMid = midPrice.mul(Decimal.max(new Decimal(0), new Decimal(1).minus(feeFraction)));
        if (feeAdjustedMid.gt(0)) {
            const impact = Decimal.max(new Decimal(0), new Decimal(1).minus(executionPrice.div(feeAdjustedMid)));
            return Number(impact.toFixed(6));
        }
    }

    const liquidityUsd = toDecimalSafe(firstOf(pool, ['tvl', 'liquidity.liquidityUsd', 'liquidity.totalLiquidityUsd']), '0');
    const inputUsd = (() => {
        const tokenInPrice = toDecimalSafe(firstOf(pool, [
            swapForY ? 'tokenXPriceUsd' : 'tokenYPriceUsd',
            swapForY ? 'tokenA.priceUsd' : 'tokenB.priceUsd',
            swapForY ? '_raw.tokenXPriceUsd' : '_raw.tokenYPriceUsd',
        ]), '0');
        return tokenInPrice.gt(0) ? inDec.mul(tokenInPrice) : new Decimal(0);
    })();

    if (liquidityUsd.gt(0) && inputUsd.gt(0)) {
        const tradeRatio = inputUsd.div(liquidityUsd);
        let impact = tradeRatio.mul(2);
        const type = String(firstOf(pool, ['type', 'poolType', 'dexType']) || '').toLowerCase();
        if (type.includes('clmm') || type.includes('whirlpool')) {
            impact = impact.mul(0.6);
        } else if (type.includes('dlmm')) {
            const binStep = toNum(firstOf(pool, ['binStep', 'activeBinId']), 0);
            impact = impact.mul(1 + (binStep / 10000));
        }
        return Number(Decimal.max(impact, feeFraction).toFixed(6));
    }

    return Number(feeFraction.toFixed(6));
}

function estimatePriceDiff(rawQuote = {}, pool = {}, inDec, outDec, swapForY) {
    const explicitBps = firstOf(rawQuote, ['priceDiffBps']);
    if (explicitBps !== null && explicitBps !== undefined && explicitBps !== '') {
        const bps = toNum(explicitBps, 0);
        return {
            priceDiff: Number(new Decimal(bps).div(10000).toFixed(8)),
            priceDiffBps: Number(new Decimal(bps).toFixed(4)),
            priceDiffPct: Number(new Decimal(bps).div(100).toFixed(6)),
            priceDiffSource: rawQuote.priceDiffSource || 'explicit-bps',
        };
    }

    const explicitPct = firstOf(rawQuote, ['priceDiffPct']);
    if (explicitPct !== null && explicitPct !== undefined && explicitPct !== '') {
        const pct = toNum(explicitPct, 0);
        return {
            priceDiff: Number(new Decimal(pct).div(100).toFixed(8)),
            priceDiffBps: Number(new Decimal(pct).mul(100).toFixed(4)),
            priceDiffPct: Number(new Decimal(pct).toFixed(6)),
            priceDiffSource: rawQuote.priceDiffSource || 'explicit-pct',
        };
    }

    const explicit = firstOf(rawQuote, ['priceDiff']);
    if (explicit !== null && explicit !== undefined && explicit !== '') {
        const fraction = toNum(explicit, 0);
        return {
            priceDiff: Number(new Decimal(fraction).toFixed(8)),
            priceDiffBps: Number(new Decimal(fraction).mul(10000).toFixed(4)),
            priceDiffPct: Number(new Decimal(fraction).mul(100).toFixed(6)),
            priceDiffSource: rawQuote.priceDiffSource || 'explicit-fraction',
        };
    }

    return {
        priceDiff: null,
        priceDiffBps: null,
        priceDiffPct: null,
        priceDiffSource: 'not-computed-without-peer-comparison',
    };
}

/* -------------------------------------------------------------------------- */
/*                           Extraction helpers                               */
/* -------------------------------------------------------------------------- */

function identifyDexType(raw) {
    const sources = candidateSources(raw);
    const dexField = firstOfMany(sources, ['dex', 'dexType', 'poolType', 'market']) || '';
    const typeField = firstOfMany(sources, ['type']) || '';
    const id = firstOfMany(sources, ['id', 'address', 'poolAddress']) || '';

    const dexStr = String(dexField).toLowerCase();
    const typeStr = String(typeField).toLowerCase();

    // Raydium detection
    if (dexStr.includes('raydium-clmm')) {
        return { dex: 'raydium', type: 'clmm', dexType: 'RAYDIUM_CLMM' };
    }
    if (dexStr.includes('raydium-cpmm')) {
        return { dex: 'raydium', type: 'cpmm', dexType: 'RAYDIUM_CPMM' };
    }
    if (dexStr.includes('raydium') || id.includes('Raydium')) {
        if (typeStr.includes('clmm') || typeStr.includes('concentrated')) {
            return { dex: 'raydium', type: 'clmm', dexType: 'RAYDIUM_CLMM' };
        }
        if (typeStr.includes('cpmm') || typeStr.includes('standard') || typeStr.includes('amm')) {
            return { dex: 'raydium', type: 'cpmm', dexType: 'RAYDIUM_CPMM' };
        }
        // Default to CPMM
        return { dex: 'raydium', type: 'cpmm', dexType: 'RAYDIUM_CPMM' };
    }

    // Orca Whirlpool detection
    if (dexStr.includes('orca') || dexStr.includes('whirlpool')) {
        return { dex: 'orca', type: 'whirlpool', dexType: 'ORCA_WHIRLPOOL' };
    }

    // Meteora DLMM detection
    if (dexStr.includes('meteora') || dexStr.includes('dlmm')) {
        return { dex: 'meteora', type: 'dlmm', dexType: 'METEORA_DLMM' };
    }

    // Fallback
    return { dex: 'unknown', type: 'unknown', dexType: 'UNKNOWN' };
}

function extractTokens(raw) {
    const sources = candidateSources(raw);
    const x = firstOfMany(sources, [
        'tokenXMint', 'mintA', 'baseMint', 'mint_x', 'tokenA.mint',
        'tokenMintA', 'tokenMint0', 'token0.mint', 'mint_a', 'tokenA',
        'mintA.address', 'token_x.address', 'tokenX.address'
    ]);
    const y = firstOfMany(sources, [
        'tokenYMint', 'mintB', 'quoteMint', 'mint_y', 'tokenB.mint',
        'tokenMintB', 'tokenMint1', 'token1.mint', 'mint_b', 'tokenB',
        'mintB.address', 'token_y.address', 'tokenY.address'
    ]);

    return {
        xMint: toStr(x) || '',
        yMint: toStr(y) || '',
        xDecimals: toNum(firstOfMany(sources, [
            'tokenXDecimals', 'decimalsX', 'baseDecimals', 'decimals_x',
            'tokenA.decimals', 'token0.decimals', 'mintA.decimals',
            'token_x.decimals', 'tokenX.decimals'
        ]), 6),
        yDecimals: toNum(firstOfMany(sources, [
            'tokenYDecimals', 'decimalsY', 'quoteDecimals', 'decimals_y',
            'tokenB.decimals', 'token1.decimals', 'mintB.decimals',
            'token_y.decimals', 'tokenY.decimals'
        ]), 6),
    };
}

function extractReserves(raw) {
    const sources = candidateSources(raw);
    const x = firstOfMany(sources, [
        'reserves.x', 'reserves.amountA', 'reserves.reserveA',
        'xReserve', 'reserveA', 'reserve_x_amount',
        'amountA', 'amount0', 'tokenAmountA', 'tokenVaultAmountA',
        'baseReserve', 'reserve0', 'amount_x', 'token_a_amount', 'xAmount',
        'mintAmountA', 'token_x_amount', 'reserve_x'
    ]);
    const y = firstOfMany(sources, [
        'reserves.y', 'reserves.amountB', 'reserves.reserveB',
        'yReserve', 'reserveB', 'reserve_y_amount',
        'amountB', 'amount1', 'tokenAmountB', 'tokenVaultAmountB',
        'quoteReserve', 'reserve1', 'amount_y', 'token_b_amount', 'yAmount',
        'mintAmountB', 'token_y_amount', 'reserve_y'
    ]);

    return {
        x: toAtomicStr(x) || '0',
        y: toAtomicStr(y) || '0',
    };
}

function extractVaults(raw) {
    const sources = candidateSources(raw);
    const xVault = firstOfMany(sources, [
        'vaultA', 'tokenVaultA', 'vault_a', 'vaults.xVault', 'vaults.aVault',
        'token_vault_a', 'tokenVault0', 'vault_x', 'token_a_vault',
        'reserveX', 'vaultX.tokenVault', 'vaultX.address', 'reserve_x'
    ]);
    const yVault = firstOfMany(sources, [
        'vaultB', 'tokenVaultB', 'vault_b', 'vaults.yVault', 'vaults.bVault',
        'token_vault_b', 'tokenVault1', 'vault_y', 'token_b_vault',
        'reserveY', 'vaultY.tokenVault', 'vaultY.address', 'reserve_y'
    ]);

    return {
        xVault: xVault ? toStr(xVault) : null,
        yVault: yVault ? toStr(yVault) : null,
    };
}

function extractFee(raw) {
    const { dexType } = identifyDexType(raw);
    const sources = candidateSources(raw);

    // CRITICAL: Prefer native program fields first. Do NOT trust stale top-level fee fields.
    const explicitBps = firstOfMany(sources, ['feeBps', 'fee_bps', 'feeRateBps', 'tradeFeeBps', 'feeBpsCanonical']);
    if (explicitBps != null) {
        return Math.round(toNum(explicitBps, 0));
    }

    const configTradeFeeRate = firstOfMany(sources, ['config.tradeFeeRate']);
    if (configTradeFeeRate != null) {
        return Math.round(toNum(configTradeFeeRate, 0) / 100);
    }

    const lpFeeRate = firstOfMany(sources, ['lpFeeRate']);
    if (lpFeeRate != null) {
        return Math.round(toNum(lpFeeRate, 0) * 10000);
    }

    const baseFeePercentage = firstOfMany(sources, ['base_fee_percentage']);
    if (baseFeePercentage != null) {
        return Math.round(toNum(baseFeePercentage, 0) * 100);
    }

    const poolConfigBaseFeePct = firstOfMany(sources, ['pool_config.base_fee_pct', 'base_fee_pct']);
    if (poolConfigBaseFeePct != null) {
        return Math.round(toNum(poolConfigBaseFeePct, 0) * 100);
    }

    const baseFeeRate = firstOfMany(sources, ['baseFeeRate']);
    if (baseFeeRate != null) {
        return Math.round(toNum(baseFeeRate, 0));
    }

    // Generic fee LAST — known trap for Raydium CLMM where top-level feeRate: 0.12 is misleading
    const genericFee = firstOfMany(sources, ['feeRate', 'fee_rate', 'fee', 'feePercent']);
    if (genericFee != null) {
        const n = toNum(genericFee, 0);
        if (n > 0 && n < 1) return Math.round(n * 10000);
        return Math.round(n);
    }

    // Verified defaults by DEX
    if (dexType === 'ORCA_WHIRLPOOL') return 30;
    if (dexType === 'METEORA_DLMM') return 10;
    if (dexType === 'RAYDIUM_CLMM') return 25;
    if (dexType === 'RAYDIUM_CPMM') return 25;
    return 25;
}

function extractCLMMFields(raw) {
    const sources = candidateSources(raw);
    return {
        tickSpacing: toNum(firstOfMany(sources, ['tickSpacing', 'tick_spacing', 'tickSpace', 'config.tickSpacing']), 1),
        tickCurrent: toNum(firstOfMany(sources, ['tickCurrent', 'tick_current', 'currentTickIndex', 'tickCurrentIndex']), 0),
        tickArrays: extractTickArrays(raw),
        liquidity: toStr(firstOfMany(sources, ['liquidity', 'currentLiquidity', 'liquidityGross'])) || '0',
        sqrtPrice: toStr(firstOfMany(sources, ['sqrtPrice', 'sqrtPriceX64', 'sqrt_price'])) || '0',
        sqrtPriceX64: toStr(firstOfMany(sources, ['sqrtPriceX64', 'sqrtPrice', 'sqrt_price'])) || '0',
        currentPrice: toNum(firstOfMany(sources, ['currentPrice', 'current_price', 'price']), 0),
    };
}

function extractTickArrays(raw) {
    const tickArrays = firstOfMany(candidateSources(raw), ['tickArrays', 'tick_arrays', 'remainingAccounts']) || [];

    if (!Array.isArray(tickArrays)) return [];

    return tickArrays
        .map(ta => {
            if (typeof ta === 'string') return ta;
            if (ta && ta.address) return ta.address;
            if (ta && ta.pubkey) return ta.pubkey;
            if (ta && ta.publicKey) return ta.publicKey;
            return null;
        })
        .filter(Boolean);
}

function extractDLMMFields(raw) {
    const sources = candidateSources(raw);
    const binStep = toNum(firstOfMany(sources, ['binStep', 'bin_step', 'bin_step_size', 'pool_config.bin_step']), 25);
    const explicitActiveBinId = firstOfMany(sources, ['activeBinId', 'active_id', 'currentBinId', 'activeId']);
    const currentPrice = toNum(firstOfMany(sources, ['currentPrice', 'current_price', 'price']), 0);

    let activeBinId = toNum(explicitActiveBinId, 0);
    if (explicitActiveBinId == null && currentPrice > 0 && binStep > 0) {
        const logBase = Math.log(1 + (binStep / 10000));
        if (Number.isFinite(logBase) && logBase > 0) {
            const inferred = Math.log(currentPrice) / logBase;
            if (Number.isFinite(inferred)) {
                activeBinId = Math.round(inferred);
            }
        }
    }

    return {
        binStep,
        activeBinId,
        activeId: activeBinId,
        currentPrice,
        bins: firstOfMany(sources, ['bins']) || [],
        binArrays: extractBinArrays(raw),
    };
}

function extractBinArrays(raw) {
    const binArrays = firstOfMany(candidateSources(raw), ['binArrays', 'bin_arrays', 'dlmmBinArrays']) || [];
    if (!Array.isArray(binArrays)) return [];
    return binArrays
        .map(ba => {
            if (typeof ba === 'string') return ba;
            if (ba && ba.address) return ba.address;
            if (ba && ba.pubkey) return ba.pubkey;
            return null;
        })
        .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/*                         MAIN: normalizePoolRecord                          */
/* -------------------------------------------------------------------------- */

function normalizePoolRecord(raw = {}) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const sources = candidateSources(raw);
    const { dex, type, dexType } = identifyDexType(raw);
    const { xMint, yMint, xDecimals, yDecimals } = extractTokens(raw);
    const xSymbol = symbolFromMint(xMint);
    const ySymbol = symbolFromMint(yMint);
    const reserves = extractReserves(raw);
    const vaults = extractVaults(raw);
    const feeBps = extractFee(raw);
    const pairLabel = `${xSymbol || xMint || ''}/${ySymbol || yMint || ''}`;

    // Base canonical pool — ALL fields required by downstream must be here
    const canonical = {
        // Identity
        address: toStr(firstOfMany(sources, ['address', 'id', 'poolAddress'])) || '',
        poolAddress: toStr(firstOfMany(sources, ['address', 'id', 'poolAddress'])) || '',
        dex,
        type,
        dexType,

        // Tokens (canonical X/Y)
        tokenXMint: xMint,
        tokenYMint: yMint,
        tokenXDecimals: xDecimals,
        tokenYDecimals: yDecimals,
        tokenXSymbol: xSymbol,
        tokenYSymbol: ySymbol,
        baseSymbol: xSymbol,
        quoteSymbol: ySymbol,
        tokenSymbol: xSymbol || xMint || '',
        pairLabel,
        pair: pairLabel,

        // Aliases — downstream files depend on these (DO NOT REMOVE)
        baseMint: xMint,
        quoteMint: yMint,
        tokenA: xMint,
        tokenB: yMint,
        mintA: xMint,
        mintB: yMint,
        baseDecimals: xDecimals,
        quoteDecimals: yDecimals,

        // Reserves (atomic, as strings)
        reserves,
        xReserve: reserves.x,
        yReserve: reserves.y,

        // Vaults
        vaults,
        xVault: vaults.xVault,
        yVault: vaults.yVault,

        // Pricing & Fees
        feeBps,
        feeBpsCanonical: feeBps,
        feePctCanonical: feeBps / 100,
        currentPrice: toNum(firstOfMany(sources, ['currentPrice', 'current_price', 'price']), 0),

        // Metadata
        tvl: toNum(firstOfMany(sources, ['liquidity.liquidityUsd', 'tvl']), 0),
        volume24h: toNum(firstOfMany(sources, ['liquidity.volume24hUsd', 'volume24h', 'volume.day', 'volume_24h', 'volume.24h']), 0),

        // Source retention
        _raw: raw._raw || raw.raw || raw,
        normalized: true,
    };

    // Add CLMM/Whirlpool fields if applicable
    if (dexType === 'RAYDIUM_CLMM' || dexType === 'ORCA_WHIRLPOOL') {
        Object.assign(canonical, extractCLMMFields(raw));
    }

    // Add DLMM fields if applicable
    if (dexType === 'METEORA_DLMM') {
        Object.assign(canonical, extractDLMMFields(raw));
    }

    return canonical;
}

function normalizePoolsArray(rawPools = []) {
    return rawPools
        .map(normalizePoolRecord)
        .filter(Boolean);
}

function validateCanonicalPool(pool) {
    const errors = [];

    if (!pool.address) errors.push('Missing address');
    if (!pool.dexType) errors.push('Missing dexType');
    if (!pool.tokenXMint) errors.push('Missing tokenXMint');
    if (!pool.tokenYMint) errors.push('Missing tokenYMint');
    if (!pool.reserves?.x || !pool.reserves?.y) errors.push('Missing reserves');
    if (pool.feeBps < 0) errors.push('Invalid feeBps');

    return {
        valid: errors.length === 0,
        errors,
    };
}

/* -------------------------------------------------------------------------- */
/*                            Decimal utilities                               */
/* -------------------------------------------------------------------------- */

function toDecimal(atomic, decimals) {
    if (!atomic || atomic === '0') return new Decimal(0);
    const num = typeof atomic === 'bigint' ? atomic.toString() : String(atomic);
    const divisor = new Decimal(10).pow(decimals || 0);
    return new Decimal(num).div(divisor);
}

function toHuman(atomic, decimals, dp = 6) {
    const dec = toDecimal(atomic, decimals);
    return dec.toDP(dp).toString();
}

function formatNumber(val, decimals = 2) {
    if (typeof val === 'number') {
        return Number.isFinite(val) ? val.toFixed(decimals) : '0';
    }
    if (val instanceof Decimal) {
        return val.toDP(decimals).toString();
    }
    return '0';
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'USD1ttHhAohfN8M7f3dS6KkwQZtV8Lk5fQKibQfEmuB',
    'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
]);

function inferMintPriceUsd(mint, pool = {}) {
    if (!mint) return null;
    if (STABLE_MINTS.has(mint)) return new Decimal(1);
    const solPriceUsd = toDecimalSafe(process.env.SOL_PRICE_USD || '86.18', '86.18');
    if (mint === SOL_MINT) return solPriceUsd;

    const explicit = mint === firstOf(pool, ['tokenXMint', 'baseMint', 'mintA'])
        ? firstOf(pool, ['tokenXPriceUsd', 'basePriceUsd', 'tokenA.priceUsd', '_raw.tokenXPriceUsd'])
        : mint === firstOf(pool, ['tokenYMint', 'quoteMint', 'mintB'])
            ? firstOf(pool, ['tokenYPriceUsd', 'quotePriceUsd', 'tokenB.priceUsd', '_raw.tokenYPriceUsd'])
            : null;
    if (explicit != null) {
        const price = toDecimalSafe(explicit, '0');
        if (price.gt(0)) return price;
    }

    const tokenXMint = toStr(firstOf(pool, ['tokenXMint', 'baseMint', 'mintA', 'tokenA.mint']));
    const tokenYMint = toStr(firstOf(pool, ['tokenYMint', 'quoteMint', 'mintB', 'tokenB.mint']));
    const tokenXDecimals = toNum(firstOf(pool, ['tokenXDecimals', 'baseDecimals', 'tokenA.decimals']), 0);
    const tokenYDecimals = toNum(firstOf(pool, ['tokenYDecimals', 'quoteDecimals', 'tokenB.decimals']), 0);
    const reserveX = toDecimalSafe(firstOf(pool, ['reserves.x', 'xReserve']), '0').div(new Decimal(10).pow(tokenXDecimals));
    const reserveY = toDecimalSafe(firstOf(pool, ['reserves.y', 'yReserve']), '0').div(new Decimal(10).pow(tokenYDecimals));
    if (reserveX.lte(0) || reserveY.lte(0)) return null;

    const knownPrice = (knownMint) => {
        if (STABLE_MINTS.has(knownMint)) return new Decimal(1);
        if (knownMint === SOL_MINT) return solPriceUsd;
        return null;
    };

    if (mint === tokenXMint) {
        const yPrice = knownPrice(tokenYMint);
        return yPrice ? reserveY.mul(yPrice).div(reserveX) : null;
    }
    if (mint === tokenYMint) {
        const xPrice = knownPrice(tokenXMint);
        return xPrice ? reserveX.mul(xPrice).div(reserveY) : null;
    }
    return null;
}

/* -------------------------------------------------------------------------- */
/*                             normalizeQuote                                 */
/* -------------------------------------------------------------------------- */

function normalizeQuote(rawQuote, pool = {}) {
    const {
        dexType,
        poolAddress,
        swapForY,
        inAmountRaw,
        outAmountRaw,
        minOutAmountRaw,
        feeBps,
        success,
        error,
        slippageBps,
        tickArrays,
        binArrays,
        binStep,
        activeBinId,
        remainingAccounts,
        sqrtPriceLimitX64,
        ...extras
    } = rawQuote;

    const tokenXMint = toStr(firstOf(pool, ['tokenXMint', 'baseMint', 'mintA', 'tokenA.mint'])) || '';
    const tokenYMint = toStr(firstOf(pool, ['tokenYMint', 'quoteMint', 'mintB', 'tokenB.mint'])) || '';
    const tokenXSymbol = symbolFromMint(tokenXMint);
    const tokenYSymbol = symbolFromMint(tokenYMint);
    const pairLabel = `${tokenXSymbol || tokenXMint || ''}/${tokenYSymbol || tokenYMint || ''}`;

    // Get decimals from pool or use defaults
    let inDecimals, outDecimals;

    if (swapForY) {
        inDecimals = pool.tokenXDecimals || pool.baseDecimals || 6;
        outDecimals = pool.tokenYDecimals || pool.quoteDecimals || 6;
    } else {
        inDecimals = pool.tokenYDecimals || pool.quoteDecimals || 6;
        outDecimals = pool.tokenXDecimals || pool.baseDecimals || 6;
    }

    const inDec = toDecimal(inAmountRaw, inDecimals);
    const outDec = toDecimal(outAmountRaw, outDecimals);
    const minOutDec = toDecimal(minOutAmountRaw, outDecimals);
    const outputMint = swapForY ? tokenYMint : tokenXMint;
    const explicitOutputPriceUsd = firstOf(rawQuote, ['outputPriceUsd']);
    const outputPriceUsdDecimal = explicitOutputPriceUsd != null
        ? toDecimalSafe(explicitOutputPriceUsd, '0')
        : inferMintPriceUsd(outputMint, pool);
    const hasOutputPriceUsd = outputPriceUsdDecimal && outputPriceUsdDecimal.gt(0);
    const explicitToUsd = firstOf(rawQuote, ['toUsd']);
    const toUsdDecimal = explicitToUsd != null
        ? toDecimalSafe(explicitToUsd, '0')
        : (hasOutputPriceUsd ? outDec.mul(outputPriceUsdDecimal) : null);

    // Calculate execution price: outAmount / inAmount
    let executionPrice = 0;
    if (inDec.gt(0)) {
        executionPrice = Number(outDec.div(inDec));
    }

    const priceImpact = estimatePriceImpact(rawQuote, pool, inDec, outDec, swapForY, feeBps || 25);
    const priceDiffMetrics = estimatePriceDiff(rawQuote, pool, inDec, outDec, swapForY);

    return {
        // Original raw fields
        dexType,
        poolAddress,
        swapForY: Boolean(swapForY),
        swapDirection: swapForY ? 'A_TO_B' : 'B_TO_A',
        direction: swapForY ? 'A_TO_B' : 'B_TO_A',
        inAmountRaw: String(inAmountRaw || '0'),
        outAmountRaw: String(outAmountRaw || '0'),
        minOutAmountRaw: String(minOutAmountRaw || '0'),
        tokenXMint,
        tokenYMint,
        tokenXSymbol,
        tokenYSymbol,
        baseSymbol: tokenXSymbol,
        quoteSymbol: tokenYSymbol,
        tokenSymbol: tokenXSymbol || tokenXMint || '',
        pairLabel,
        pair: pairLabel,
        tokenA: tokenXMint,
        tokenB: tokenYMint,
        mintA: tokenXMint,
        mintB: tokenYMint,
        baseMint: tokenXMint,
        quoteMint: tokenYMint,
        tokenInMint: swapForY ? tokenXMint : tokenYMint,
        tokenOutMint: outputMint,
        inputMint: swapForY ? tokenXMint : tokenYMint,
        outputMint,

        // Normalized decimal fields
        inAmountDecimal: formatNumber(inDec, 8),
        outAmountDecimal: formatNumber(outDec, 8),
        minOutAmountDecimal: formatNumber(minOutDec, 8),
        inAmountHuman: toHuman(inAmountRaw, inDecimals),
        outAmountHuman: toHuman(outAmountRaw, outDecimals),

        // Price & impact
        executionPrice: formatNumber(executionPrice, 8),
        priceImpact: formatNumber(priceImpact, 6),
        priceDiff: priceDiffMetrics.priceDiff,
        priceDiffBps: priceDiffMetrics.priceDiffBps,
        priceDiffPct: priceDiffMetrics.priceDiffPct,
        priceDiffSource: priceDiffMetrics.priceDiffSource,
        fee: formatNumber(new Decimal(feeBps || 25).div(10000), 6),
        feeBps: Number(feeBps || 25),
        slippageBps: Number(slippageBps || 20),
        toUsd: toUsdDecimal ? toUsdDecimal.toDP(8).toString() : null,
        outputPriceUsd: hasOutputPriceUsd ? outputPriceUsdDecimal.toDP(12).toString() : null,
        priceSourceUsd: firstOf(rawQuote, ['priceSourceUsd']) || (hasOutputPriceUsd ? 'normalizer-inferred' : null),

        // Metadata
        inDecimals,
        outDecimals,
        inputDecimals: inDecimals,
        outputDecimals: outDecimals,
        success: Boolean(success),
        error: error || null,

        // Execution-critical DEX-specific fields (must survive normalization)
        tickArrays: Array.isArray(tickArrays) ? tickArrays : (Array.isArray(pool?.tickArrays) ? pool.tickArrays : []),
        binArrays: Array.isArray(binArrays) ? binArrays : (Array.isArray(pool?.binArrays) ? pool.binArrays : []),
        binStep: binStep != null ? binStep : pool?.binStep ?? null,
        activeBinId: activeBinId != null ? activeBinId : pool?.activeBinId ?? null,
        remainingAccounts: Array.isArray(remainingAccounts) ? remainingAccounts : [],
        sqrtPriceLimitX64: sqrtPriceLimitX64 || null,

        // Pass through any extra fields that adapters may need
        ...extras,
    };
}

/* -------------------------------------------------------------------------- */
/*                            buildSwapLeg                                    */
/* -------------------------------------------------------------------------- */

function buildSwapLeg(normalizedQuote, legIndex) {
    const {
        dexType,
        poolAddress,
        swapForY,
        inAmountRaw,
        outAmountRaw,
        feeBps,
        inDecimals,
        outDecimals,
        tickArrays,
        binArrays,
        binStep,
        activeBinId,
        remainingAccounts,
        sqrtPriceLimitX64,
        ...extras
    } = normalizedQuote;

    return {
        legIndex: legIndex,
        dex: dexType,
        dexType,
        poolAddress,
        direction: normalizedQuote.direction || (swapForY ? 'A_TO_B' : 'B_TO_A'),
        swapDirection: normalizedQuote.swapDirection || (swapForY ? 'A_TO_B' : 'B_TO_A'),
        swapForY: Boolean(swapForY),
        tokenXMint: normalizedQuote.tokenXMint || normalizedQuote.baseMint || normalizedQuote.mintA || null,
        tokenYMint: normalizedQuote.tokenYMint || normalizedQuote.quoteMint || normalizedQuote.mintB || null,
        tokenA: normalizedQuote.tokenA || normalizedQuote.tokenXMint || normalizedQuote.baseMint || null,
        tokenB: normalizedQuote.tokenB || normalizedQuote.tokenYMint || normalizedQuote.quoteMint || null,
        mintA: normalizedQuote.mintA || normalizedQuote.tokenXMint || normalizedQuote.baseMint || null,
        mintB: normalizedQuote.mintB || normalizedQuote.tokenYMint || normalizedQuote.quoteMint || null,
        baseMint: normalizedQuote.baseMint || normalizedQuote.tokenXMint || normalizedQuote.mintA || null,
        quoteMint: normalizedQuote.quoteMint || normalizedQuote.tokenYMint || normalizedQuote.mintB || null,
        tokenInMint: normalizedQuote.tokenInMint || normalizedQuote.inputMint || null,
        tokenOutMint: normalizedQuote.tokenOutMint || normalizedQuote.outputMint || null,
        inputMint: normalizedQuote.inputMint || normalizedQuote.tokenInMint || null,
        outputMint: normalizedQuote.outputMint || normalizedQuote.tokenOutMint || null,
        inAmountRaw,
        outAmountRaw,
        inDecimals,
        outDecimals,
        inputDecimals: normalizedQuote.inputDecimals ?? inDecimals,
        outputDecimals: normalizedQuote.outputDecimals ?? outDecimals,
        feeBps,
        success: normalizedQuote.success,
        priceImpact: normalizedQuote.priceImpact,
        executionPrice: normalizedQuote.executionPrice,
        slippageBps: normalizedQuote.slippageBps || 20,
        // Execution-critical DEX-specific fields
        tickArrays: Array.isArray(tickArrays) ? tickArrays : [],
        binArrays: Array.isArray(binArrays) ? binArrays : [],
        binStep: binStep ?? null,
        activeBinId: activeBinId ?? null,
        remainingAccounts: Array.isArray(remainingAccounts) ? remainingAccounts : [],
        sqrtPriceLimitX64: sqrtPriceLimitX64 || null,
        // Preserve any extra execution fields
        ...extras,
    };
}

/* -------------------------------------------------------------------------- */
/*                          Triangle profit calc                              */
/* -------------------------------------------------------------------------- */

function calculateTriangleProfitAtomic(leg1, leg2, leg3) {
    const profit = BigInt(leg3.outAmountRaw || '0') - BigInt(leg1.inAmountRaw || '0');
    const profitBps = profit === 0n ? 0 : Number(profit * 10000n / BigInt(leg1.inAmountRaw || '1'));

    return {
        profitAtomic: profit.toString(),
        profitBps: profitBps,
        profitPercent: (profitBps / 10000).toFixed(4),
        grossReturnFactor: (Number(leg3.outAmountRaw || '0') / Number(leg1.inAmountRaw || '1')).toFixed(8),
    };
}

function validate3LegRoute(leg1, leg2, leg3) {
    const errors = [];

    if (!leg1.success) errors.push('Leg 1 quote failed');
    if (!leg2.success) errors.push('Leg 2 quote failed');
    if (!leg3.success) errors.push('Leg 3 quote failed');

    if (BigInt(leg1.outAmountRaw || '0') === 0n) errors.push('Leg 1 output is zero');
    if (BigInt(leg2.outAmountRaw || '0') === 0n) errors.push('Leg 2 output is zero');
    if (BigInt(leg3.outAmountRaw || '0') === 0n) errors.push('Leg 3 output is zero');

    return {
        valid: errors.length === 0,
        errors,
    };
}

function format3LegRoute({
    routeId,
    leg1,
    leg2,
    leg3,
    profit,
    profitBps,
    grossReturnFactor
}) {
    return {
        routeId: routeId || `route-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        legs: [leg1, leg2, leg3],
        netProfitLamports: profit?.profitAtomic || '0',
        estProfitBps: profitBps || 0,
        estProfitPercent: profit?.profitPercent || '0',
        grossReturnFactor: grossReturnFactor || '1.0',
        sanityPassed: true,
        timestamp: new Date().toISOString(),
    };
}

/* -------------------------------------------------------------------------- */
/*                              MODULE EXPORTS                                */
/* -------------------------------------------------------------------------- */

module.exports = {
    // Core normalization
    normalizePoolRecord,
    normalizePoolsArray,
    validateCanonicalPool,

    // Quote normalization
    normalizeQuote,
    buildSwapLeg,

    // Triangle helpers
    calculateTriangleProfitAtomic,
    validate3LegRoute,
    format3LegRoute,

    // Utilities
    toHuman,
    toDecimal,
    formatNumber,

    // Extraction (for poolContract or advanced use)
    identifyDexType,
    extractTokens,
    extractReserves,
    extractVaults,
    extractFee,
    extractCLMMFields,
    extractDLMMFields,
    extractTickArrays,
    extractBinArrays,

    // Low-level helpers
    firstOf,
    toStr,
    toNum,
    toAtomicStr,
    candidateSources,
    firstOfMany,
};
