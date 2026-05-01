'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Connection } = require('@solana/web3.js');

const { CLMMAdapter } = require('./Q_CLMM');
const { CPMMAdapter } = require('./Q_CPMM');
const { DLMMAdapter } = require('./Q_DLMM');
const { WhirlpoolAdapter } = require('./Q_WHIRLPOOL');
const {
    normalizeQuote: normalizeCanonicalQuote,
} = require('../utilities/normalizer');
const {
    mergeCanonicalPool,
    validateRouteLegContract,
    validateQuoteContract,
} = require('../utilities/poolContract');
const {
    extractPools: extractPoolsFromPayload,
} = require('../utilities/triangleRouteCore');
const {
    calculateQuotePriceMetrics,
} = require('../utilities/priCeDiff&impact');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_SLIPPAGE_BPS = 20;

const short = (s) => s ? `${s.slice(0, 6)}..${s.slice(-4)}` : '?';

function toFiniteNumber(value, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toBigIntSafe(value, fallback = 0n) {
    try {
        if (typeof value === 'bigint') return value;
        if (value === null || value === undefined || value === '') return fallback;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) return fallback;
            return BigInt(Math.trunc(value));
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return fallback;
            if (trimmed.includes('.') || trimmed.includes('e') || trimmed.includes('E')) {
                const parsed = Number(trimmed);
                if (!Number.isFinite(parsed)) return fallback;
                return BigInt(Math.trunc(parsed));
            }
            return BigInt(trimmed);
        }
        return BigInt(String(value));
    } catch (_error) {
        return fallback;
    }
}

function hasPositiveReserves(pool = {}) {
    const reserveX = toBigIntSafe(pool?.reserves?.x ?? pool?.xReserve ?? 0);
    const reserveY = toBigIntSafe(pool?.reserves?.y ?? pool?.yReserve ?? 0);
    return reserveX > 0n && reserveY > 0n;
}

function normalizeTextList(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
}

function classifyQuoteExecutionQuality(quote = {}) {
    const type = getPoolType(quote);
    const quoteSource = String(quote?.quoteSource || '').toLowerCase();
    const tickStrategy = String(quote?.tickStrategy || '').toLowerCase();
    const tickArrays = normalizeTextList(quote?.tickArrays);
    const binArrays = normalizeTextList(quote?.binArrays);
    const bins = Array.isArray(quote?.bins) ? quote.bins : [];
    const reserveBacked = hasPositiveReserves(quote);
    const liquidity = toBigIntSafe(quote?.liquidity ?? 0);
    const currentPrice = toFiniteNumber(quote?.currentPrice ?? quote?._raw?.current_price ?? quote?._raw?.price, 0);

    let executable = false;
    let reason = 'Unsupported quote source';

    switch (type) {
        case 'cpmm':
            executable = reserveBacked && (
                quoteSource === 'native-reserves'
                || quoteSource === 'sdk'
                || quoteSource === 'custom-provider'
            );
            reason = executable
                ? 'CPMM reserve quote accepted'
                : 'CPMM quote missing positive reserves or supported quote source';
            break;
        case 'clmm':
            executable = (
                quoteSource === 'sdk'
                || quoteSource === 'custom-provider'
                || (
                    quoteSource === 'rpc-live'
                    && tickStrategy === 'swap-step'
                    && tickArrays.length > 0
                    && (reserveBacked || liquidity > 0n)
                )
            );
            reason = executable
                ? 'CLMM exact quote source accepted'
                : 'CLMM quote uses reserve fallback, not concentrated-liquidity math';
            break;
        case 'whirlpool':
            executable = (
                quoteSource === 'sdk'
                || quoteSource === 'custom-provider'
                || (
                    quoteSource === 'rpc-live'
                    && tickStrategy !== 'adapter-approximation'
                    && tickArrays.length > 0
                    && (reserveBacked || liquidity > 0n)
                )
            );
            reason = executable
                ? 'Whirlpool live quote source accepted'
                : 'Whirlpool quote is approximation-only or missing live tick state';
            break;
        case 'dlmm':
            executable = quoteSource === 'sdk' && (binArrays.length > 0 || bins.length > 0 || currentPrice > 0);
            reason = executable
                ? 'DLMM live quote source accepted'
                : 'DLMM quote is fallback-only without live bin-walk execution';
            break;
        default:
            executable = false;
            reason = `Unsupported pool type for execution gate: ${type || 'unknown'}`;
            break;
    }

    return {
        executable,
        qualityTier: executable ? 'execution-grade' : 'diagnostic-only',
        gateReason: reason,
        quoteSource: quoteSource || null,
        tickStrategy: tickStrategy || null,
        reserveBacked,
        tickArrayCount: tickArrays.length,
        binArrayCount: binArrays.length,
        binCount: bins.length,
    };
}

function getFeeBpsFromPool(pool) {
    if (!pool) return 0;
    if (pool.feeBps != null) return toFiniteNumber(pool.feeBps, 0);
    if (pool.feeRate != null) {
        const feeRate = toFiniteNumber(pool.feeRate, 0);
        return feeRate > 0 && feeRate < 1 ? Math.round(feeRate * 10000) : Math.round(feeRate);
    }
    return 0;
}

function minFeeBpsForPools(pools) {
    if (!pools || pools.length === 0) return 0;
    let min = Number.POSITIVE_INFINITY;
    for (const pool of pools) {
        const fee = getFeeBpsFromPool(pool);
        if (fee < min) min = fee;
    }
    return Number.isFinite(min) ? min : 0;
}

function loadPools(poolsPath) {
    const resolved = path.isAbsolute(poolsPath)
        ? poolsPath
        : path.resolve(poolsPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }

    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const pools = extractPoolsFromPayload(raw);
    return pools.map(mergeCanonicalPool);
}

function getPoolAddress(pool) {
    return String(pool?.poolAddress || pool?.address || pool?.id || '');
}

function getPoolType(pool) {
    return String(pool?.type || pool?.poolType || '').toLowerCase();
}

function getPoolDexType(pool) {
    return String(pool?.dexType || '').toUpperCase();
}

function getPoolDex(pool) {
    return pool?.dex || pool?.type || pool?.poolType || 'unknown';
}

function getPoolMints(pool) {
    const tokenXMint = String(
        pool?.tokenXMint
        || pool?.baseMint
        || pool?.mintA
        || pool?.tokenMintA
        || pool?.tokenA?.mint
        || ''
    );
    const tokenYMint = String(
        pool?.tokenYMint
        || pool?.quoteMint
        || pool?.mintB
        || pool?.tokenMintB
        || pool?.tokenB?.mint
        || ''
    );

    return { tokenXMint, tokenYMint };
}

function getPoolDecimals(pool) {
    return {
        tokenXDecimals: toFiniteNumber(
            pool?.tokenXDecimals
            ?? pool?.baseDecimals
            ?? pool?.decimalsA
            ?? pool?.tokenA?.decimals,
            0
        ),
        tokenYDecimals: toFiniteNumber(
            pool?.tokenYDecimals
            ?? pool?.quoteDecimals
            ?? pool?.decimalsB
            ?? pool?.tokenB?.decimals,
            0
        ),
    };
}

function getPoolSymbols(pool) {
    return {
        tokenXSymbol: pool?.tokenXSymbol || pool?.baseSymbol || pool?.tokenA?.symbol || null,
        tokenYSymbol: pool?.tokenYSymbol || pool?.quoteSymbol || pool?.tokenB?.symbol || null,
    };
}

function summarizePool(pool, pairLabel = '') {
    const { tokenXMint, tokenYMint } = getPoolMints(pool || {});
    const { tokenXDecimals, tokenYDecimals } = getPoolDecimals(pool || {});
    const { tokenXSymbol, tokenYSymbol } = getPoolSymbols(pool || {});

    return {
        pairLabel: pairLabel || null,
        poolAddress: getPoolAddress(pool),
        address: getPoolAddress(pool),
        dex: getPoolDex(pool),
        type: getPoolType(pool) || 'unknown',
        dexType: getPoolDexType(pool) || 'UNKNOWN',
        tokenXMint,
        tokenYMint,
        tokenA: tokenXMint,
        tokenB: tokenYMint,
        mintA: tokenXMint,
        mintB: tokenYMint,
        baseMint: tokenXMint,
        quoteMint: tokenYMint,
        tokenXDecimals,
        tokenYDecimals,
        baseDecimals: tokenXDecimals,
        quoteDecimals: tokenYDecimals,
        tokenXSymbol,
        tokenYSymbol,
        baseSymbol: tokenXSymbol,
        quoteSymbol: tokenYSymbol,
        feeBps: getFeeBpsFromPool(pool),
        reserves: pool?.reserves || null,
        vaults: pool?.vaults || null,
        tickSpacing: pool?.tickSpacing ?? null,
        tickCurrent: pool?.tickCurrent ?? pool?.tickCurrentIndex ?? null,
        tickArrays: Array.isArray(pool?.tickArrays) ? pool.tickArrays : [],
        tickArrayData: Array.isArray(pool?.tickArrayData) ? pool.tickArrayData : [],
        remainingAccounts: Array.isArray(pool?.remainingAccounts) ? pool.remainingAccounts : [],
        liquidity: pool?.liquidity ?? null,
        sqrtPrice: pool?.sqrtPrice ?? pool?.sqrtPriceX64 ?? null,
        sqrtPriceX64: pool?.sqrtPriceX64 ?? pool?.sqrtPrice ?? null,
        currentPrice: pool?.currentPrice ?? pool?._raw?.current_price ?? pool?._raw?.price ?? null,
        pairCanonical: pool?.pairCanonical ?? null,
        pairLabel: pool?.pairLabel ?? pairLabel ?? null,
        pairBaseMint: pool?.pairBaseMint ?? null,
        pairQuoteMint: pool?.pairQuoteMint ?? null,
        pairBaseSymbol: pool?.pairBaseSymbol ?? null,
        pairQuoteSymbol: pool?.pairQuoteSymbol ?? null,
        pairOrientation: pool?.pairOrientation ?? null,
        pairPeerCount: pool?.pairPeerCount ?? 0,
        pairComparablePeerCount: pool?.pairComparablePeerCount ?? 0,
        pairMidPrice: pool?.pairMidPrice ?? null,
        pairMedianMid: pool?.pairMedianMid ?? null,
        pairBestMid: pool?.pairBestMid ?? null,
        pairWorstMid: pool?.pairWorstMid ?? null,
        pairDivergenceBps: pool?.pairDivergenceBps ?? 0,
        pairDivergenceComparable: pool?.pairDivergenceComparable ?? null,
        pairMidDeviationBps: pool?.pairMidDeviationBps ?? 0,
        pairSpreadPosition: pool?.pairSpreadPosition ?? null,
        pairMidExtractionSource: pool?.pairMidExtractionSource ?? null,
        binStep: pool?.binStep ?? null,
        activeBinId: pool?.activeBinId ?? pool?.activeId ?? null,
        bins: Array.isArray(pool?.bins) ? pool.bins : [],
        binArrays: Array.isArray(pool?.binArrays) ? pool.binArrays : [],
        aux: pool?.aux || null,
    };
}

function buildPairMap(pools) {
    const pairMap = new Map();
    const mintToSymbol = new Map();

    for (const pool of pools) {
        const { tokenXMint, tokenYMint } = getPoolMints(pool);
        const { tokenXSymbol, tokenYSymbol } = getPoolSymbols(pool);

        if (!tokenXMint || !tokenYMint) continue;

        if (tokenXSymbol) mintToSymbol.set(tokenXMint, tokenXSymbol);
        if (tokenYSymbol) mintToSymbol.set(tokenYMint, tokenYSymbol);

        const keyXY = `${tokenXMint}-${tokenYMint}`;
        const keyYX = `${tokenYMint}-${tokenXMint}`;

        if (!pairMap.has(keyXY)) pairMap.set(keyXY, []);
        if (!pairMap.has(keyYX)) pairMap.set(keyYX, []);

        pairMap.get(keyXY).push(pool);
        pairMap.get(keyYX).push(pool);
    }

    return { pairMap, mintToSymbol };
}

function findConnectedMints(pairMap, mint) {
    const connected = new Set();
    for (const key of pairMap.keys()) {
        if (key.startsWith(`${mint}-`)) {
            connected.add(key.split('-')[1]);
        }
    }
    return Array.from(connected);
}

function canFormTriangle(pairMap, tokenA, tokenB, tokenC) {
    const hasAB = pairMap.has(`${tokenA}-${tokenB}`) || pairMap.has(`${tokenB}-${tokenA}`);
    const hasBC = pairMap.has(`${tokenB}-${tokenC}`) || pairMap.has(`${tokenC}-${tokenB}`);
    const hasCA = pairMap.has(`${tokenC}-${tokenA}`) || pairMap.has(`${tokenA}-${tokenC}`);
    return { hasAB, hasBC, hasCA, valid: hasAB && hasBC && hasCA };
}

function getPoolsForPair(pairMap, mintA, mintB) {
    return pairMap.get(`${mintA}-${mintB}`) || pairMap.get(`${mintB}-${mintA}`) || [];
}

function resolveSwapOrientation(pool, inputMint, outputMint = null) {
    const { tokenXMint, tokenYMint } = getPoolMints(pool);
    const { tokenXDecimals, tokenYDecimals } = getPoolDecimals(pool);

    if (!inputMint) {
        throw new Error(`Missing input mint for pool ${getPoolAddress(pool)}`);
    }
    if (!tokenXMint || !tokenYMint) {
        throw new Error(`Pool ${getPoolAddress(pool)} is missing token orientation`);
    }

    if (inputMint === tokenXMint) {
        if (outputMint && outputMint !== tokenYMint) {
            throw new Error(`Pool ${getPoolAddress(pool)} does not support ${short(inputMint)} -> ${short(outputMint)}`);
        }
        return {
            swapForY: true,
            aToB: true,
            swapDirection: 'A_TO_B',
            direction: 'A_TO_B',
            tokenInMint: tokenXMint,
            tokenOutMint: tokenYMint,
            inputMint: tokenXMint,
            outputMint: tokenYMint,
            inputDecimals: tokenXDecimals,
            outputDecimals: tokenYDecimals,
            inDecimals: tokenXDecimals,
            outDecimals: tokenYDecimals,
        };
    }

    if (inputMint === tokenYMint) {
        if (outputMint && outputMint !== tokenXMint) {
            throw new Error(`Pool ${getPoolAddress(pool)} does not support ${short(inputMint)} -> ${short(outputMint)}`);
        }
        return {
            swapForY: false,
            aToB: false,
            swapDirection: 'B_TO_A',
            direction: 'B_TO_A',
            tokenInMint: tokenYMint,
            tokenOutMint: tokenXMint,
            inputMint: tokenYMint,
            outputMint: tokenXMint,
            inputDecimals: tokenYDecimals,
            outputDecimals: tokenXDecimals,
            inDecimals: tokenYDecimals,
            outDecimals: tokenXDecimals,
        };
    }

    throw new Error(`Input mint ${short(inputMint)} is not part of pool ${getPoolAddress(pool)}`);
}

function buildRouteLeg(pool, inputMint, outputMint, meta = {}) {
    const summary = summarizePool(pool, meta.pairLabel);
    const orientation = resolveSwapOrientation(pool, inputMint, outputMint);

    return {
        ...summary,
        ...orientation,
        routeId: meta.routeId || null,
        routePath: meta.routePath || null,
        routeIndex: meta.routeIndex || null,
        triangleIndex: meta.triangleIndex || null,
        routeTotalFeeBps: meta.routeTotalFeeBps || 0,
        legIndex: meta.legIndex || null,
        label: meta.pairLabel || null,
    };
}

function buildChainRoutes(poolsAB, poolsBC, poolsCA, meta = {}) {
    const routePath = meta.routePath || '';
    const triangleIndex = Number(meta.triangleIndex || 0);
    const maxRoutesPerTriangle = Number(meta.maxRoutesPerTriangle) > 0
        ? Number(meta.maxRoutesPerTriangle)
        : Infinity;

    const chainRoutes = [];
    let routeIndex = 0;

    outer:
    for (const poolAB of poolsAB || []) {
        for (const poolBC of poolsBC || []) {
            for (const poolCA of poolsCA || []) {
                routeIndex += 1;
                const routeId = `tri-${triangleIndex}-${routeIndex}`;
                const routeTotalFeeBps =
                    getFeeBpsFromPool(poolAB)
                    + getFeeBpsFromPool(poolBC)
                    + getFeeBpsFromPool(poolCA);

                const route = [
                    buildRouteLeg(poolAB, meta.tokenA, meta.tokenB, {
                        routeId,
                        routePath,
                        routeIndex,
                        triangleIndex,
                        routeTotalFeeBps,
                        legIndex: 1,
                        pairLabel: 'A-B',
                    }),
                    buildRouteLeg(poolBC, meta.tokenB, meta.tokenC, {
                        routeId,
                        routePath,
                        routeIndex,
                        triangleIndex,
                        routeTotalFeeBps,
                        legIndex: 2,
                        pairLabel: 'B-C',
                    }),
                    buildRouteLeg(poolCA, meta.tokenC, meta.tokenA, {
                        routeId,
                        routePath,
                        routeIndex,
                        triangleIndex,
                        routeTotalFeeBps,
                        legIndex: 3,
                        pairLabel: 'C-A',
                    }),
                ];

                chainRoutes.push(route);

                if (chainRoutes.length >= maxRoutesPerTriangle) {
                    break outer;
                }
            }
        }
    }

    return chainRoutes;
}

async function diagnose(poolsPath, tokenAMint = SOL, meta = {}) {
    const sources = Array.isArray(meta.sources) ? meta.sources : [];
    const maxRoutesPerTriangle = Number(meta.maxRoutesPerTriangle) > 0
        ? Number(meta.maxRoutesPerTriangle)
        : Infinity;

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('TRIANGLE CANDIDATE DIAGNOSTIC');
    console.log('═══════════════════════════════════════════════════════════════');
    if (sources.length) {
        console.log(`Pool file(s): ${sources.join(', ')}`);
    } else {
        console.log(`Pool file: ${Array.isArray(poolsPath) ? '[in-memory pools]' : poolsPath}`);
    }
    console.log(`Token A: ${short(tokenAMint)}`);
    console.log('');

    const pools = (Array.isArray(poolsPath) ? poolsPath : loadPools(poolsPath)).map(mergeCanonicalPool);
    console.log(`📦 Loaded ${pools.length} pools`);

    const { pairMap, mintToSymbol } = buildPairMap(pools);
    console.log(`🔗 Found ${pairMap.size / 2} unique pairs`);
    console.log('');

    const sym = (mint) => mintToSymbol.get(mint) || short(mint);

    console.log('───────────────────────────────────────────────────────────────');
    console.log(`STEP 1: Tokens connected to ${sym(tokenAMint)} (potential tokenB)`);
    console.log('───────────────────────────────────────────────────────────────');

    const tokenBs = findConnectedMints(pairMap, tokenAMint);
    console.log(`Found ${tokenBs.length} tokens connected to ${sym(tokenAMint)}:`);

    if (tokenBs.length === 0) {
        console.log('❌ NO TOKENS CONNECTED TO SOL!');
        console.log('   This means no pools have SOL as base or quote mint.');
        return {
            triangles: [],
            chainRoutes: [],
            chainRouteCount: 0,
            tokenBs: [],
            solPools: [],
            usdcPools: [],
            sources,
        };
    }

    for (const tokenB of tokenBs) {
        const poolCount = getPoolsForPair(pairMap, tokenAMint, tokenB).length;
        console.log(`  ${sym(tokenB)} (${poolCount} pools)`);
    }
    console.log('');

    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 2: Finding triangle candidates');
    console.log('───────────────────────────────────────────────────────────────');

    const triangles = [];
    const allChainRoutes = [];

    for (const tokenB of tokenBs) {
        const tokenCs = findConnectedMints(pairMap, tokenB);

        for (const tokenC of tokenCs) {
            if (tokenC === tokenAMint || tokenC === tokenB) continue;

            const check = canFormTriangle(pairMap, tokenAMint, tokenB, tokenC);
            if (!check.valid) continue;

            const poolsAB = getPoolsForPair(pairMap, tokenAMint, tokenB);
            const poolsBC = getPoolsForPair(pairMap, tokenB, tokenC);
            const poolsCA = getPoolsForPair(pairMap, tokenC, tokenAMint);
            const minFeeBpsAB = minFeeBpsForPools(poolsAB);
            const minFeeBpsBC = minFeeBpsForPools(poolsBC);
            const minFeeBpsCA = minFeeBpsForPools(poolsCA);
            const minTotalFeeBps = minFeeBpsAB + minFeeBpsBC + minFeeBpsCA;

            const routePath = `${sym(tokenAMint)} → ${sym(tokenB)} → ${sym(tokenC)} → ${sym(tokenAMint)}`;
            const totalCombinations = poolsAB.length * poolsBC.length * poolsCA.length;
            const chainRoutes = buildChainRoutes(poolsAB, poolsBC, poolsCA, {
                triangleIndex: triangles.length + 1,
                routePath,
                tokenA: tokenAMint,
                tokenB,
                tokenC,
                maxRoutesPerTriangle,
            });

            triangles.push({
                path: routePath,
                tokenA: tokenAMint,
                tokenB,
                tokenC,
                poolsAB: poolsAB.length,
                poolsBC: poolsBC.length,
                poolsCA: poolsCA.length,
                totalCombinations,
                minFeeBpsAB,
                minFeeBpsBC,
                minFeeBpsCA,
                minTotalFeeBps,
                chainRouteCount: chainRoutes.length,
                chainRoutes,
            });

            allChainRoutes.push(...chainRoutes);
        }
    }

    console.log(`Found ${triangles.length} valid triangles:`);
    console.log('');

    if (triangles.length === 0) {
        console.log('❌ NO VALID TRIANGLES FOUND');
        console.log('');
        console.log('Debugging why...');

        for (const tokenB of tokenBs.slice(0, 5)) {
            console.log(`\n  Checking ${sym(tokenB)}:`);
            const tokenCs = findConnectedMints(pairMap, tokenB);
            console.log(`    Connected to ${tokenCs.length} other tokens`);

            for (const tokenC of tokenCs.slice(0, 3)) {
                if (tokenC === tokenAMint || tokenC === tokenB) continue;
                const check = canFormTriangle(pairMap, tokenAMint, tokenB, tokenC);
                console.log(`    ${sym(tokenC)}: AB=${check.hasAB}, BC=${check.hasBC}, CA=${check.hasCA}`);
                if (!check.hasCA) {
                    console.log(`      ⚠️ Missing ${sym(tokenC)} → ${sym(tokenAMint)} pool!`);
                }
            }
        }
    } else {
        triangles.sort((a, b) => {
            if (a.minTotalFeeBps !== b.minTotalFeeBps) return a.minTotalFeeBps - b.minTotalFeeBps;
            return b.totalCombinations - a.totalCombinations;
        });

        for (const tri of triangles.slice(0, 20)) {
            console.log(`  ✓ ${tri.path}`);
            console.log(`    Pools: AB=${tri.poolsAB}, BC=${tri.poolsBC}, CA=${tri.poolsCA}`);
            console.log(`    Combinations: ${tri.totalCombinations}`);
            console.log(`    Saved chain routes: ${tri.chainRouteCount}`);
            console.log(`    Min fee bps: AB=${tri.minFeeBpsAB}, BC=${tri.minFeeBpsBC}, CA=${tri.minFeeBpsCA}, total=${tri.minTotalFeeBps}`);
        }

        console.log('');
        console.log(`Saved ${allChainRoutes.length} total chain routes across ${triangles.length} triangles`);
        if (triangles.length > 20) {
            console.log(`  ... and ${triangles.length - 20} more`);
        }
    }

    console.log('');
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 3: Pool types in file');
    console.log('───────────────────────────────────────────────────────────────');

    const typeCount = {};
    const dexCount = {};

    for (const pool of pools) {
        const type = getPoolType(pool) || 'unknown';
        const dex = pool?.dex || 'unknown';
        typeCount[type] = (typeCount[type] || 0) + 1;
        dexCount[dex] = (dexCount[dex] || 0) + 1;
    }

    console.log('By type:');
    for (const [type, count] of Object.entries(typeCount)) {
        console.log(`  ${type}: ${count}`);
    }

    console.log('\nBy dex:');
    for (const [dex, count] of Object.entries(dexCount)) {
        console.log(`  ${dex}: ${count}`);
    }

    console.log('');
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 4: SOL pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const solPools = pools.filter((pool) => {
        const { tokenXMint, tokenYMint } = getPoolMints(pool);
        return tokenXMint === SOL || tokenYMint === SOL;
    });

    console.log(`Pools with SOL: ${solPools.length}`);
    for (const pool of solPools.slice(0, 30)) {
        const { tokenXMint, tokenYMint } = getPoolMints(pool);
        const other = tokenXMint === SOL ? tokenYMint : tokenXMint;
        console.log(`  ${sym(SOL)} ↔ ${sym(other)} [${getPoolType(pool) || '?'}] ${short(getPoolAddress(pool))}`);
    }

    console.log('');
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 5: USDC pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const usdcPools = pools.filter((pool) => {
        const { tokenXMint, tokenYMint } = getPoolMints(pool);
        return tokenXMint === USDC || tokenYMint === USDC;
    });

    console.log(`Pools with USDC: ${usdcPools.length}`);
    for (const pool of usdcPools.slice(0, 30)) {
        const { tokenXMint, tokenYMint } = getPoolMints(pool);
        const other = tokenXMint === USDC ? tokenYMint : tokenXMint;
        console.log(`  ${sym(USDC)} ↔ ${sym(other)} [${getPoolType(pool) || '?'}] ${short(getPoolAddress(pool))}`);
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('DIAGNOSTIC COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');

    return {
        triangles,
        chainRoutes: allChainRoutes,
        chainRouteCount: allChainRoutes.length,
        tokenBs,
        solPools,
        usdcPools,
        sources,
    };
}

class SwapSimulator {
    constructor(connection = null) {
        this.connection = connection || new Connection(
            process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed',
        );
        this.adapterCache = new Map();
    }

    async getAdapter(pool) {
        const poolAddress = getPoolAddress(pool);
        const type = getPoolType(pool);
        const cacheKey = `${type}:${poolAddress}`;

        if (this.adapterCache.has(cacheKey)) {
            return this.adapterCache.get(cacheKey);
        }

        let adapter;
        switch (type) {
            case 'clmm':
                adapter = new CLMMAdapter(this.connection, poolAddress, pool);
                break;
            case 'cpmm':
                adapter = new CPMMAdapter(this.connection, poolAddress, pool);
                break;
            case 'dlmm':
                adapter = new DLMMAdapter(this.connection, poolAddress, pool);
                break;
            case 'whirlpool':
                adapter = new WhirlpoolAdapter(this.connection, poolAddress, pool);
                break;
            default:
                throw new Error(`Unknown pool type: ${type || 'missing-type'}`);
        }

        if (typeof adapter.init === 'function') {
            await adapter.init();
        }

        this.adapterCache.set(cacheKey, adapter);
        return adapter;
    }

    async getSwapQuote(_ctx, params = {}) {
        const {
            pool,
            poolAddress,
            tokenMint,
            outputMint,
            inputAmount,
            slippageBps = DEFAULT_SLIPPAGE_BPS,
        } = params;

        if (!poolAddress || !tokenMint || inputAmount === undefined || inputAmount === null) {
            return {
                success: false,
                error: 'Missing required params: poolAddress, tokenMint, inputAmount',
            };
        }

        if (!pool) {
            return {
                success: false,
                error: `Pool payload missing for ${poolAddress}`,
            };
        }

        try {
            const orientation = resolveSwapOrientation(pool, tokenMint, outputMint || null);
            const adapter = await this.getAdapter(pool);
            const quoteArgs = [String(inputAmount), orientation.swapForY, slippageBps, { pool }];

            let quote;
            if (typeof adapter.getQuote === 'function') {
                quote = await adapter.getQuote(...quoteArgs);
            } else if (typeof adapter.quoteExactIn === 'function') {
                quote = await adapter.quoteExactIn(...quoteArgs);
            } else {
                throw new Error(`Adapter for ${poolAddress} does not expose getQuote/quoteExactIn`);
            }

            const normalizedQuote = normalizeCanonicalQuote(quote || {}, pool);

            const quoteEnvelope = {
                ...quote,
                ...normalizedQuote,
                poolAddress,
                tokenMint,
                outputMint: orientation.tokenOutMint,
                tokenInMint: orientation.tokenInMint,
                tokenOutMint: orientation.tokenOutMint,
                swapForY: orientation.swapForY,
                swapDirection: orientation.swapDirection,
                direction: orientation.direction,
                aToB: orientation.aToB,
                inputDecimals: orientation.inputDecimals,
                outputDecimals: orientation.outputDecimals,
                inDecimals: orientation.inputDecimals,
                outDecimals: orientation.outputDecimals,
            };
            const priceMetrics = calculateQuotePriceMetrics({
                pool,
                inputMint: orientation.tokenInMint,
                outputMint: orientation.tokenOutMint,
                inputAmountRaw: quoteEnvelope.inAmountRaw,
                outputAmountRaw: quoteEnvelope.outAmountRaw,
                inputDecimals: orientation.inputDecimals,
                outputDecimals: orientation.outputDecimals,
                quoteImpact: quote.priceImpact,
                feeBps: quoteEnvelope.feeBps,
            });
            if (priceMetrics.impactPct != null) {
                quoteEnvelope.priceImpact = Number((priceMetrics.impactPct / 100).toFixed(8));
                quoteEnvelope.impactPct = priceMetrics.impactPct;
                quoteEnvelope.impactBps = priceMetrics.impactBps;
            }
            quoteEnvelope.grossImpactPct = priceMetrics.grossImpactPct ?? null;
            quoteEnvelope.feePct = priceMetrics.feePct ?? null;
            quoteEnvelope.tradeRatioPct = priceMetrics.tradeRatioPct ?? null;
            quoteEnvelope.midPrice = priceMetrics.midPrice ?? null;
            quoteEnvelope.feeAdjustedMidPrice = priceMetrics.feeAdjustedMidPrice ?? null;
            quoteEnvelope.executionPrice = priceMetrics.executionPrice ?? null;
            quoteEnvelope.priceDiff = null;
            quoteEnvelope.priceDiffBps = null;
            quoteEnvelope.priceDiffSource = 'runtime-single-leg-no-peer-comparison';

            const contract = validateQuoteContract(quoteEnvelope);
            if (!contract.valid) {
                return {
                    success: false,
                    error: `Quote contract mismatch: ${contract.missing.join(', ')}`,
                    poolAddress,
                    tokenMint,
                    inputAmount: String(inputAmount),
                };
            }

            return quoteEnvelope;
        } catch (error) {
            return {
                success: false,
                error: error.message,
                poolAddress,
                tokenMint,
                inputAmount: String(inputAmount),
            };
        }
    }

    async simulateSwap(baseInput = {}, input = {}) {
        const params = {
            ...baseInput,
            ...input,
        };

        const quote = await this.getSwapQuote(null, params);
        if (!quote.success) {
            return {
                success: false,
                amountIn: String(params.inputAmount ?? 0),
                amountOut: '0',
                sqrtPriceLimitX64: null,
                error: quote.error,
                quote,
            };
        }

        return {
            success: true,
            amountIn: String(quote.inAmountRaw ?? params.inputAmount ?? 0),
            amountOut: String(quote.outAmountRaw ?? 0),
            sqrtPriceLimitX64: quote.sqrtPriceLimitX64 ?? null,
            quote,
            error: null,
        };
    }
}

class SwapChainSimulator {
    constructor(connection = null) {
        this.simulator = new SwapSimulator(connection);
    }

    _coerceRouteLegs(leg1OrRoute, leg2, leg3, startAmount, opts = {}) {
        if (Array.isArray(leg1OrRoute)) {
            return {
                routeLegs: leg1OrRoute,
                startAmount: String(leg2),
                opts: leg3 || {},
            };
        }

        return {
            routeLegs: [leg1OrRoute, leg2, leg3],
            startAmount: String(startAmount),
            opts,
        };
    }

    async simulate3LegChain(leg1OrRoute, leg2, leg3, startAmount, opts = {}) {
        const parsed = this._coerceRouteLegs(leg1OrRoute, leg2, leg3, startAmount, opts);
        const routeLegs = parsed.routeLegs;
        const slippageBps = parsed.opts?.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

        if (!Array.isArray(routeLegs) || routeLegs.length !== 3) {
            return { success: false, error: 'simulate3LegChain requires exactly 3 route legs' };
        }

        let currentAmount = String(parsed.startAmount);
        const quotedLegs = [];

        for (const leg of routeLegs) {
            if (!leg?.poolAddress) {
                return { success: false, error: 'Route leg is missing poolAddress', legs: quotedLegs };
            }
            if (!leg?.tokenInMint) {
                return { success: false, error: `Route leg ${leg.legIndex || '?'} is missing tokenInMint`, legs: quotedLegs };
            }
            const legContract = validateRouteLegContract(leg);
            if (!legContract.valid) {
                return {
                    success: false,
                    error: `Route leg ${leg.legIndex || '?'} contract mismatch: ${legContract.missing.join(', ')}`,
                    legs: quotedLegs,
                };
            }

            const quote = await this.simulator.getSwapQuote(null, {
                pool: leg,
                poolAddress: leg.poolAddress,
                tokenMint: leg.tokenInMint,
                outputMint: leg.tokenOutMint,
                inputAmount: currentAmount,
                slippageBps,
            });

            if (!quote.success) {
                return {
                    success: false,
                    error: `Leg ${leg.legIndex || quotedLegs.length + 1} failed: ${quote.error}`,
                    legs: [...quotedLegs, quote],
                };
            }

            quotedLegs.push({
                ...leg,
                ...quote,
                legIndex: leg.legIndex || quotedLegs.length + 1,
            });
            currentAmount = String(quote.outAmountRaw || 0);
        }

        const startBI = BigInt(parsed.startAmount);
        const finalBI = BigInt(currentAmount);
        const profitBI = finalBI - startBI;
        const profitBps = startBI > 0n ? Number((profitBI * 10000n) / startBI) : 0;
        const sumFeeBps = quotedLegs.reduce((sum, leg) => sum + toFiniteNumber(leg.feeBps, 0), 0);
        const sumImpactBps = quotedLegs.reduce((sum, leg) => {
            if (leg.impactBps != null) return sum + toFiniteNumber(leg.impactBps, 0);
            if (leg.impactPct != null) return sum + (toFiniteNumber(leg.impactPct, 0) * 100);
            return sum + (toFiniteNumber(leg.priceImpact, 0) * 10000);
        }, 0);
        const sumTradeRatioPct = quotedLegs.reduce((sum, leg) => sum + toFiniteNumber(leg.tradeRatioPct, 0), 0);
        const routePath = quotedLegs[0]?.routePath || quotedLegs.map((leg) => short(leg.tokenInMint)).join(' → ');
        const path = [
            quotedLegs[0]?.tokenInMint || null,
            quotedLegs[0]?.tokenOutMint || null,
            quotedLegs[1]?.tokenOutMint || null,
            quotedLegs[2]?.tokenOutMint || null,
        ];

        if (path[0] && path[3] && path[0] !== path[3]) {
            return {
                success: false,
                error: 'Triangle does not close (final output mint does not match initial input mint)',
                routePath,
                path,
                legs: quotedLegs,
            };
        }

        const legQualities = quotedLegs.map((leg) => ({
            legIndex: leg.legIndex,
            poolAddress: leg.poolAddress,
            dexType: leg.dexType,
            type: leg.type,
            ...classifyQuoteExecutionQuality(leg),
        }));
        const executionLegs = quotedLegs.map((leg) => ({
            legIndex: leg.legIndex,
            label: leg.label || leg.pairLabel || null,
            poolAddress: leg.poolAddress,
            dexType: leg.dexType,
            type: leg.type,
            tokenInMint: leg.tokenInMint,
            tokenOutMint: leg.tokenOutMint,
            inputAmount: leg.inAmountRaw,
            expectedOutputAmount: leg.outAmountRaw,
            minOutputAmount: leg.minOutAmountRaw,
            swapForY: leg.swapForY,
            swapDirection: leg.swapDirection,
            inputDecimals: leg.inputDecimals,
            outputDecimals: leg.outputDecimals,
            feeBps: leg.feeBps,
            priceImpact: leg.priceImpact,
            impactPct: leg.impactPct,
            impactBps: leg.impactBps,
            grossImpactPct: leg.grossImpactPct,
            feePct: leg.feePct,
            tradeRatioPct: leg.tradeRatioPct,
            priceDiff: leg.priceDiff,
            priceDiffBps: leg.priceDiffBps,
            priceDiffSource: leg.priceDiffSource,
            quoteSource: leg.quoteSource || null,
            tickStrategy: leg.tickStrategy || null,
            tickArrays: leg.tickArrays || [],
            binArrays: leg.binArrays || [],
            binStep: leg.binStep ?? null,
            activeBinId: leg.activeBinId ?? null,
            executionQuality: classifyQuoteExecutionQuality(leg),
        }));
        // after quoting all 3 legs:
        const grossYieldBps = profitBps + sumFeeBps + sumImpactBps;
        const edgeMinusFeesBps = grossYieldBps - sumFeeBps;
        if (grossYieldBps < 0) {
            return {
                success: true,
                routeId: quotedLegs[0]?.routeId || `tri-${Date.now()}`,
                routePath,
                startAmount: String(parsed.startAmount),
                finalAmount: currentAmount,
                profitLamports: profitBI.toString(),
                profitBps,
                sumFeeBps,
                sumImpactBps,
                sumTradeRatioPct,
                grossYieldBps,
                grossEdgeBps: grossYieldBps,
                edgeMinusFeesBps,
                profitable: false,
                executionEligible: false,
                executionQuality: 'diagnostic-only',
                path,
                legs: quotedLegs,
                gateReason: 'Negative pre-fee yield (stale or contradictory quotes)',
                execution: {
                    executable: false,
                    qualityTier: 'diagnostic-only',
                    rejectedByGate: true,
                    gateReasons: [{
                        reason: 'Negative pre-fee yield (stale or contradictory quotes)',
                    }],
                    legs: executionLegs,
                },
            };
        }
        const rejectedLegs = legQualities.filter((entry) => !entry.executable);
        const totalFeeBps = sumFeeBps;
        const latencySlippageBps = toFiniteNumber(parsed.opts?.latencySlippageBps, 0);
        const explicitJitoTipBps = parsed.opts?.jitoTipBps == null
            ? null
            : toFiniteNumber(parsed.opts.jitoTipBps, 0);
        const jitoTipLamports = toBigIntSafe(parsed.opts?.jitoTipLamports, 0n);
        const jitoTipBps = explicitJitoTipBps == null
            ? (startBI > 0n ? Number((jitoTipLamports * 10000n) / startBI) : 0)
            : explicitJitoTipBps;
        const requiredEdgeBps = totalFeeBps + latencySlippageBps + jitoTipBps;
        const rejectedByProfitabilityGate = profitBps < requiredEdgeBps;
        const profitabilityGateReason = rejectedByProfitabilityGate
            ? {
                reason: 'Profit below required execution edge',
                profitBps,
                requiredEdgeBps,
                totalFeeBps,
                latencySlippageBps,
                jitoTipBps,
            }
            : null;
        const gateReasons = [
            ...rejectedLegs.map((entry) => ({
                legIndex: entry.legIndex,
                poolAddress: entry.poolAddress,
                dexType: entry.dexType,
                type: entry.type,
                reason: entry.gateReason,
                quoteSource: entry.quoteSource,
                tickStrategy: entry.tickStrategy,
            })),
            ...(profitabilityGateReason ? [profitabilityGateReason] : []),
        ];
        const executionEligible = gateReasons.length === 0;

        return {
            success: true,
            routeId: quotedLegs[0]?.routeId || `tri-${Date.now()}`,
            routePath,
            startAmount: String(parsed.startAmount),
            finalAmount: currentAmount,
            profitLamports: profitBI.toString(),
            profitBps,
            sumFeeBps,
            sumImpactBps,
            sumTradeRatioPct,
            grossYieldBps,
            grossEdgeBps: grossYieldBps,
            edgeMinusFeesBps,
            totalFeeBps,
            latencySlippageBps,
            jitoTipBps,
            requiredEdgeBps,
            profitable: profitBI > 0n && !rejectedByProfitabilityGate,
            executionEligible,
            executionQuality: executionEligible ? 'execution-grade' : 'diagnostic-only',
            path,
            legs: quotedLegs,
            execution: {
                executable: executionEligible,
                qualityTier: executionEligible ? 'execution-grade' : 'diagnostic-only',
                rejectedByGate: !executionEligible,
                gateReasons,
                legs: executionLegs,
            },
        };
    }
}

function parseArgs(argv) {
    const out = {
        inputs: [],
        tokenA: SOL,
        output: 'custom_routed.json',
        maxRoutesPerTriangle: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg) continue;

        if (arg.startsWith('--')) {
            const key = arg.slice(2).toLowerCase();
            const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';

            if (key === 'input' || key === 'in') out.inputs.push(...String(value).split(',').map((s) => s.trim()).filter(Boolean));
            if (key === 'token' || key === 'tokena') out.tokenA = value;
            if (key === 'output' || key === 'out') out.output = value;
            if (key === 'maxroutespertriangle' || key === 'maxroutes') out.maxRoutesPerTriangle = value;
            continue;
        }

        if (arg.includes('=')) {
            const [rawKey, ...rest] = arg.split('=');
            const key = rawKey.toLowerCase();
            const value = rest.join('=');

            if (key === 'input' || key === 'in') out.inputs.push(...String(value).split(',').map((s) => s.trim()).filter(Boolean));
            if (key === 'token' || key === 'tokena') out.tokenA = value;
            if (key === 'output' || key === 'out') out.output = value;
            if (key === 'maxroutespertriangle' || key === 'maxroutes') out.maxRoutesPerTriangle = value;
            continue;
        }

        out.inputs.push(arg);
    }

    if (!out.inputs.length) out.inputs.push('metaData_enriched.json');
    return out;
}

if (require.main === module) {
    const parsed = parseArgs(process.argv.slice(2));
    const inputs = parsed.inputs.length ? parsed.inputs : ['metaData_enriched.json'];
    const tokenA = parsed.tokenA || SOL;
    const mergedPools = [];
    const loadedSources = [];
    const skippedSources = [];

    for (const input of inputs) {
        try {
            const pools = loadPools(input);
            mergedPools.push(...pools);
            loadedSources.push(input);
        } catch (error) {
            skippedSources.push({ input, error: error.message });
        }
    }

    if (!mergedPools.length) {
        console.error('No pools loaded from inputs. Aborting.');
        process.exit(1);
    }

    diagnose(mergedPools, tokenA, {
        sources: loadedSources,
        skippedSources,
        maxRoutesPerTriangle: parsed.maxRoutesPerTriangle,
    }).then((result) => {
        if (parsed.output) {
            fs.writeFileSync(parsed.output, JSON.stringify(result, null, 2));
            console.log(`Output saved: ${parsed.output}`);
        }
    }).catch((error) => {
        console.error('Error:', error);
        process.exit(1);
    });
}
module.exports = SwapChainSimulator;
module.exports = {
    SwapSimulator,
    SOL,
    USDC,
    loadPools,
    buildPairMap,
    findConnectedMints,
    canFormTriangle,
    getPoolsForPair,
    summarizePool,
    resolveSwapOrientation,
    buildRouteLeg,
    buildChainRoutes,
    diagnose,

};
/*
node engine/Q_enrichment.js raw.json results.json
node engine/triangleArb.js --input CUSTOM_selected-E.json --output custom_routed.json --tokenA So11111111111111111111111111111111111111112 --output result.json --maxRoutesPerTriangle 5


*/
