'use strict';

const fs = require('fs');
const path = require('path');

const { mergeCanonicalPool, validatePoolContract } = require('./poolContract');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USD1 = 'USD1ttHhAohfN8M7f3dS6KkwQZtV8Lk5fQKibQfEmuB';

function short(value) {
    return value ? `${String(value).slice(0, 6)}..${String(value).slice(-4)}` : '?';
}

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

function extractPools(raw) {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.runtime?.pools)) return raw.runtime.pools;
    if (Array.isArray(raw?.runtime?.hotSet?.pools)) return raw.runtime.hotSet.pools;
    if (Array.isArray(raw?.hotSet?.pools)) return raw.hotSet.pools;
    if (Array.isArray(raw?.pools)) return raw.pools;
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.selectedPools)) return raw.selectedPools;
    if (raw?.poolShape && typeof raw.poolShape === 'object') return [raw.poolShape];
    if (raw && typeof raw === 'object' && (raw.address || raw.poolAddress || raw.id || raw.normalized)) return [raw];
    return [];
}

function extractChainRoutes(raw) {
    if (Array.isArray(raw?.runtime?.chainRoutes)) return raw.runtime.chainRoutes;
    if (Array.isArray(raw?.chainRoutes)) return raw.chainRoutes;
    if (Array.isArray(raw?.routes)) return raw.routes;
    if (Array.isArray(raw?.selectedRoutes)) return raw.selectedRoutes;
    return [];
}

function loadPools(inputPath) {
    const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const pools = extractPools(raw).map((pool) => (
        validatePoolContract(pool).valid ? pool : mergeCanonicalPool(pool)
    ));
    const context = {
        hasRuntimeHotSet: Array.isArray(raw?.runtime?.pools),
        reportPoolCount: Number(raw?.poolCount ?? raw?.summary?.pools ?? 0),
        reportChainRouteCount: Number(raw?.chainRouteCount ?? raw?.summary?.chainRoutes ?? 0),
        runtimePoolCount: Array.isArray(raw?.runtime?.pools) ? raw.runtime.pools.length : 0,
        runtimeChainRouteCount: Array.isArray(raw?.runtime?.chainRoutes) ? raw.runtime.chainRoutes.length : 0,
        profitableCount: Number(raw?.profitableCount ?? raw?.summary?.profitable ?? 0),
        executionGradeProfitableCount: Number(
            raw?.executionGradeProfitableCount ?? raw?.summary?.executionGradeProfitable ?? 0
        ),
        routeSource: raw?.routeSource || raw?.runtime?.routeSource || null,
    };
    return { resolved, raw, pools, context };
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

function getPoolSymbolForMint(pool, mint) {
    const token = String(mint || '');
    if (!token) return '?';
    if (token === SOL) return 'SOL';
    if (token === USDC) return 'USDC';
    if (token === USDT) return 'USDT';
    if (token === USD1) return 'USD1';

    if (pool) {
        const tokenXMint = String(pool.tokenXMint || pool.baseMint || pool.mintA || '');
        const tokenYMint = String(pool.tokenYMint || pool.quoteMint || pool.mintB || '');
        if (token === tokenXMint) return pool.baseSymbol || pool.tokenXSymbol || short(token);
        if (token === tokenYMint) return pool.quoteSymbol || pool.tokenYSymbol || short(token);
    }

    return short(token);
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

function normalizeSelectedRouteLeg(leg = {}, legIndex = null) {
    const pool = leg?.pool || leg;
    const tokenInMint = getLegTokenInMint(leg);
    const tokenOutMint = getLegTokenOutMint(leg);
    return {
        ...leg,
        pool,
        poolAddress: leg?.poolAddress || pool?.poolAddress || pool?.address || null,
        tokenInMint,
        tokenOutMint,
        inputMint: leg?.inputMint || tokenInMint,
        outputMint: leg?.outputMint || tokenOutMint,
        legIndex: leg?.legIndex || legIndex || null,
    };
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
            executable = (
                quoteSource === 'sdk'
                || quoteSource === 'local-math'
                || quoteSource === 'adapter-approximation'
                || quoteSource === 'reserve-approximation'
            ) && (binArrays.length > 0 || bins.length > 0 || currentPrice > 0 || reserveBacked);
            reason = executable
                ? 'DLMM live quote source accepted'
                : 'DLMM quote is fallback-only without usable execution data';
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

function normalizeSelectedRoute(route = {}) {
    if (Array.isArray(route)) {
        return route.map((leg, index) => normalizeSelectedRouteLeg(leg, index + 1));
    }
    if (Array.isArray(route?.legs)) {
        return route.legs.map((leg, index) => normalizeSelectedRouteLeg(leg, index + 1));
    }
    if (route?.leg1 && route?.leg2 && route?.leg3) {
        return [
            normalizeSelectedRouteLeg(route.leg1, 1),
            normalizeSelectedRouteLeg(route.leg2, 2),
            normalizeSelectedRouteLeg(route.leg3, 3),
        ];
    }
    return [];
}

function hasPositiveReserves(pool = {}) {
    const reserveX = toBigIntSafe(pool?.reserves?.x ?? pool?.xReserve ?? 0);
    const reserveY = toBigIntSafe(pool?.reserves?.y ?? pool?.yReserve ?? 0);
    return reserveX > 0n && reserveY > 0n;
}

function normalizeTextList(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
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
        binStep: pool?.binStep ?? null,
        activeBinId: pool?.activeBinId ?? pool?.activeId ?? null,
        bins: Array.isArray(pool?.bins) ? pool.bins : [],
        binArrays: Array.isArray(pool?.binArrays) ? pool.binArrays : [],
        aux: pool?.aux || null,
    };
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

function buildPairMap(pools) {
    const pairMap = new Map();
    const mintToSymbol = new Map();

    for (const pool of pools || []) {
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

function getPoolsForPair(pairMap, mintA, mintB) {
    return pairMap.get(`${mintA}-${mintB}`) || pairMap.get(`${mintB}-${mintA}`) || [];
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

module.exports = {
    SOL,
    USDC,
    short,
    toFiniteNumber,
    toBigIntSafe,
    extractPools,
    extractChainRoutes,
    loadPools,
    getPoolAddress,
    getPoolType,
    getPoolDexType,
    getPoolDex,
    getPoolMints,
    getPoolDecimals,
    getPoolSymbols,
    getPoolSymbolForMint,
    getFeeBpsFromPool,
    minFeeBpsForPools,
    summarizePool,
    resolveSwapOrientation,
    buildRouteLeg,
    buildPairMap,
    getPoolsForPair,
    findConnectedMints,
    canFormTriangle,
    buildChainRoutes,
};
