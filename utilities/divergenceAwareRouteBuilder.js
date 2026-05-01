'use strict';
/**
 * divergenceAwareRouteBuilder.js  (utilities/)
 *
 * Replaces the brute Cartesian inner loop in triangleArb.buildChainRoutes
 * with a directional best-pool-per-leg selector that consumes the divergence
 * fields the divergenceScanner already stamps on every pool:
 *
 *   pool.pairBaseMint        — alphabetically-first mint of the pair
 *   pool.pairQuoteMint       — alphabetically-second mint
 *   pool.pairMidPrice        — pool's mid in canonical (quote-per-base) units
 *   pool.pairMedianMid       — pair-wide median (across comparable peers)
 *   pool.pairBestMid         — pair-wide max
 *   pool.pairWorstMid        — pair-wide min
 *   pool.pairMidDeviationBps — (pool.mid - pair.median) / pair.median  in bps
 *   pool.pairSpreadPosition  — (pool.mid - min) / (max - min)  ∈ [0, 1]
 *   pool.pairDivergenceBps   — pair-wide spread in bps
 *   pool.pairDivergenceComparable — true if cross-source comparison is safe
 *
 * Direction model
 * ---------------
 * For a leg `tokenIn → tokenOut` on a pool whose canonical pair is
 * (base, quote):
 *
 *   - If tokenIn === pairBaseMint:  we are SELLING base for quote.
 *     We want the highest quote-per-base price → prefer pools with
 *     pairMidDeviationBps > 0 (above pair median = cheap base, lots of quote
 *     coming back).
 *
 *   - If tokenIn === pairQuoteMint: we are SELLING quote for base.
 *     We want the lowest quote-per-base price (= cheapest base in quote
 *     terms) → prefer pools with pairMidDeviationBps < 0.
 *
 *   directionalEdgeBps = sellingBase ? +deviation : -deviation
 *
 * The pool with the HIGHEST directionalEdgeBps is the best-priced venue for
 * that leg's direction. This is the same metric divergenceScanner already
 * uses in scoreTriangleByDivergence; we make the route builder honour it
 * during route assembly instead of evaluating it after the fact.
 *
 * Output contract
 * ---------------
 * Returns the SAME shape as triangleArb.buildChainRoutes — an array of
 * 3-leg arrays where each leg is the result of buildRouteLeg(pool, in, out).
 * That keeps myEngine, SwapChainSimulator, and the canonical pool contract
 * unchanged.
 *
 * Drop-in
 * -------
 * In triangleArb.diagnose() (or wherever buildChainRoutes is currently called):
 *
 *   const { buildDivergenceAwareRoutes } = require('../utilities/divergenceAwareRouteBuilder');
 *   const chainRoutes = buildDivergenceAwareRoutes(poolsAB, poolsBC, poolsCA, {
 *     triangleIndex,
 *     routePath,
 *     tokenA, tokenB, tokenC,
 *     buildRouteLeg,        // pass the existing builder so route shape matches
 *     maxRoutesPerTriangle, // top-K alternative routes (default 3)
 *     fallbackToCartesian,  // if all directional scores are 0, fall through (default false)
 *   });
 *
 * If buildRouteLeg is not supplied, the module falls back to a minimal leg
 * shape that satisfies validateRouteLegContract from poolContract.js.
 */

const {
    mergeCanonicalPool,
    validateRouteLegContract,
} = require('../utilities/poolContract');

const SOL = 'So11111111111111111111111111111111111111112';

/* -------------------------------------------------------------------------- */
/*                              Pure helpers                                  */
/* -------------------------------------------------------------------------- */

function toFiniteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function getPoolMints(pool) {
    return {
        tokenXMint: String(pool?.tokenXMint || pool?.baseMint || pool?.mintA || ''),
        tokenYMint: String(pool?.tokenYMint || pool?.quoteMint || pool?.mintB || ''),
    };
}

function getPoolDecimals(pool) {
    return {
        tokenXDecimals: toFiniteNumber(
            pool?.tokenXDecimals ?? pool?.baseDecimals ?? pool?.decimalsA ?? pool?.tokenA?.decimals,
            0,
        ),
        tokenYDecimals: toFiniteNumber(
            pool?.tokenYDecimals ?? pool?.quoteDecimals ?? pool?.decimalsB ?? pool?.tokenB?.decimals,
            0,
        ),
    };
}

function getFeeBps(pool) {
    return toFiniteNumber(pool?.feeBps ?? pool?.feeRateBps ?? pool?.feeBpsCanonical, 0);
}

/**
 * Compute directional edge for a leg `tokenIn → tokenOut` on a given pool.
 *
 * Returns { directionalBps, deviationBps, divergenceBps, comparable, baseMint, quoteMint }.
 *
 * If the pool has no usable divergence annotation (single peer, heterogeneous
 * sources, or scanner never ran), directionalBps is 0 — the route builder
 * then falls back to fee minimization.
 */
function computeLegDirectionalEdge(pool, tokenInMint) {
    const baseMint = pool?.pairBaseMint || null;
    const quoteMint = pool?.pairQuoteMint || null;
    const deviationBps = toFiniteNumber(pool?.pairMidDeviationBps, 0);
    const divergenceBps = toFiniteNumber(pool?.pairDivergenceBps, 0);
    const comparable = pool?.pairDivergenceComparable !== false
        && Number(pool?.pairComparablePeerCount || 0) >= 2;

    if (!baseMint || !quoteMint || !comparable || deviationBps === 0) {
        return {
            directionalBps: 0,
            deviationBps,
            divergenceBps,
            comparable,
            baseMint,
            quoteMint,
        };
    }

    const sellingBase = tokenInMint === baseMint;
    const directionalBps = sellingBase ? deviationBps : -deviationBps;

    return {
        directionalBps: Number(directionalBps.toFixed(4)),
        deviationBps,
        divergenceBps,
        comparable,
        baseMint,
        quoteMint,
    };
}

/**
 * Score a candidate pool for one leg. Higher = better.
 *
 * Three components, summed:
 *   1. Directional edge (bps): how favourable this pool's price is for the
 *      intended swap direction. This is the dominant signal when divergence
 *      is comparable.
 *   2. Fee penalty: -feeBps. Always applied.
 *   3. Divergence weight: small bonus when this pool sits at the favourable
 *      extreme of the pair (pairSpreadPosition close to 1 or 0 depending on
 *      direction). Disambiguates between two pools at the same deviationBps.
 *
 * The score is a relative ordering, not an absolute economic claim. The
 * profitabilityGate is the sole authority on whether a route is profitable.
 */
function scoreLegPool(pool, tokenInMint, options = {}) {
    const directional = computeLegDirectionalEdge(pool, tokenInMint);
    const feeBps = getFeeBps(pool);
    const spreadPosition = toFiniteNumber(pool?.pairSpreadPosition, 0.5);

    const sellingBase = directional.baseMint && tokenInMint === directional.baseMint;
    // When selling base we want HIGH spread position (near 1.0 means this pool
    // has the highest mid in the pair). When selling quote we want LOW spread
    // position (0.0 means cheapest base in pair).
    const positionEdgeBps = directional.divergenceBps > 0
        ? (sellingBase ? (spreadPosition - 0.5) : (0.5 - spreadPosition)) * directional.divergenceBps
        : 0;

    const directionalWeight = toFiniteNumber(options.directionalWeight, 1);
    const feeWeight = toFiniteNumber(options.feeWeight, 1);
    const positionWeight = toFiniteNumber(options.positionWeight, 0.25);

    return {
        score: (directional.directionalBps * directionalWeight)
            - (feeBps * feeWeight)
            + (positionEdgeBps * positionWeight),
        directionalBps: directional.directionalBps,
        deviationBps: directional.deviationBps,
        divergenceBps: directional.divergenceBps,
        comparable: directional.comparable,
        feeBps,
        spreadPosition,
        positionEdgeBps: Number(positionEdgeBps.toFixed(4)),
        pool,
    };
}

/**
 * Pick the best pool for a leg given a candidate list. Returns the pool plus
 * the score breakdown.
 */
function pickBestPoolForLeg(candidatePools, tokenInMint, options = {}) {
    if (!Array.isArray(candidatePools) || candidatePools.length === 0) return null;

    const scored = candidatePools
        .map((pool) => scoreLegPool(pool, tokenInMint, options))
        .filter((entry) => entry.pool);

    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
}

/**
 * Get the top-K pools by score (used for generating alternative routes).
 */
function pickTopKForLeg(candidatePools, tokenInMint, k = 1, options = {}) {
    if (!Array.isArray(candidatePools) || candidatePools.length === 0) return [];

    const scored = candidatePools
        .map((pool) => scoreLegPool(pool, tokenInMint, options))
        .filter((entry) => entry.pool);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Number(k) || 1));
}

/* -------------------------------------------------------------------------- */
/*                          Minimal leg builder fallback                      */
/* -------------------------------------------------------------------------- */

/**
 * If the caller does not pass triangleArb's buildRouteLeg, we synthesize a
 * minimum-viable leg that satisfies validateRouteLegContract. This is only a
 * fallback for tests; production callers should always pass the real builder.
 */
function fallbackBuildRouteLeg(pool, tokenInMint, tokenOutMint, meta = {}) {
    const canonical = mergeCanonicalPool(pool);
    const { tokenXMint, tokenYMint } = getPoolMints(canonical);
    const { tokenXDecimals, tokenYDecimals } = getPoolDecimals(canonical);

    const aToB = tokenInMint === tokenXMint;
    const tokenOut = tokenOutMint || (aToB ? tokenYMint : tokenXMint);
    const inputDecimals = aToB ? tokenXDecimals : tokenYDecimals;
    const outputDecimals = aToB ? tokenYDecimals : tokenXDecimals;

    return {
        ...canonical,
        poolAddress: canonical.poolAddress,
        type: canonical.type,
        dexType: canonical.dexType,
        tokenInMint,
        tokenOutMint: tokenOut,
        inputMint: tokenInMint,
        outputMint: tokenOut,
        swapForY: aToB,
        swapDirection: aToB ? 'A_TO_B' : 'B_TO_A',
        direction: aToB ? 'A_TO_B' : 'B_TO_A',
        aToB,
        inputDecimals,
        outputDecimals,
        inDecimals: inputDecimals,
        outDecimals: outputDecimals,
        routeId: meta.routeId || null,
        routePath: meta.routePath || null,
        routeIndex: meta.routeIndex ?? null,
        triangleIndex: meta.triangleIndex ?? null,
        routeTotalFeeBps: meta.routeTotalFeeBps || 0,
        legIndex: meta.legIndex || null,
        label: meta.pairLabel || null,
    };
}

/* -------------------------------------------------------------------------- */
/*                              Main route builder                            */
/* -------------------------------------------------------------------------- */

/**
 * Build divergence-aware chain routes for a triangle (A → B → C → A).
 *
 * @param {Pool[]} poolsAB  candidate pools for leg 1 (tokenA → tokenB)
 * @param {Pool[]} poolsBC  candidate pools for leg 2 (tokenB → tokenC)
 * @param {Pool[]} poolsCA  candidate pools for leg 3 (tokenC → tokenA)
 * @param {object} meta
 *   - tokenA / tokenB / tokenC: mint strings (required)
 *   - triangleIndex: number (default 0)
 *   - routePath: human-readable path string
 *   - maxRoutesPerTriangle: top-K (default 3)
 *   - buildRouteLeg: function (pool, tokenIn, tokenOut, legMeta) → leg
 *                    (defaults to internal fallback)
 *   - fallbackToCartesian: when no leg has a directional edge, generate one
 *                          route per cheapest-fee combination instead of
 *                          dropping the triangle (default true)
 *   - scoringOptions: passed through to scoreLegPool
 */
function buildDivergenceAwareRoutes(poolsAB, poolsBC, poolsCA, meta = {}) {
    const tokenA = String(meta.tokenA || SOL);
    const tokenB = String(meta.tokenB || '');
    const tokenC = String(meta.tokenC || '');
    if (!tokenB || !tokenC) {
        throw new Error('buildDivergenceAwareRoutes requires meta.tokenB and meta.tokenC');
    }

    const triangleIndex = Number(meta.triangleIndex || 0);
    const maxRoutesPerTriangle = Math.max(1, Number(meta.maxRoutesPerTriangle || 3));
    const buildRouteLeg = typeof meta.buildRouteLeg === 'function'
        ? meta.buildRouteLeg
        : fallbackBuildRouteLeg;
    const fallbackToCartesian = meta.fallbackToCartesian !== false;
    const scoringOptions = meta.scoringOptions || {};

    // Score each leg's candidate pools.
    const scoredAB = (poolsAB || []).map((p) => scoreLegPool(p, tokenA, scoringOptions));
    const scoredBC = (poolsBC || []).map((p) => scoreLegPool(p, tokenB, scoringOptions));
    const scoredCA = (poolsCA || []).map((p) => scoreLegPool(p, tokenC, scoringOptions));

    if (scoredAB.length === 0 || scoredBC.length === 0 || scoredCA.length === 0) {
        return [];
    }

    scoredAB.sort((a, b) => b.score - a.score);
    scoredBC.sort((a, b) => b.score - a.score);
    scoredCA.sort((a, b) => b.score - a.score);

    // Detect "no signal" case: if NO leg has a non-zero directionalBps, the
    // divergence annotation didn't add any preference. We can either fall back
    // to cheapest-fee Cartesian (default) or return empty to skip the triangle.
    const anySignal = scoredAB.some((s) => s.directionalBps !== 0)
        || scoredBC.some((s) => s.directionalBps !== 0)
        || scoredCA.some((s) => s.directionalBps !== 0);

    const routes = [];
    let routeIndex = 0;

    const buildRoute = (legAB, legBC, legCA, info) => {
        routeIndex += 1;
        const routeId = `tri-${triangleIndex}-${routeIndex}`;
        const routeTotalFeeBps = legAB.feeBps + legBC.feeBps + legCA.feeBps;
        const directionalEdgeTotal = Number((
            legAB.directionalBps + legBC.directionalBps + legCA.directionalBps
        ).toFixed(4));

        const route = [
            buildRouteLeg(legAB.pool, tokenA, tokenB, {
                routeId,
                routePath: meta.routePath || '',
                routeIndex,
                triangleIndex,
                routeTotalFeeBps,
                legIndex: 1,
                pairLabel: 'A-B',
            }),
            buildRouteLeg(legBC.pool, tokenB, tokenC, {
                routeId,
                routePath: meta.routePath || '',
                routeIndex,
                triangleIndex,
                routeTotalFeeBps,
                legIndex: 2,
                pairLabel: 'B-C',
            }),
            buildRouteLeg(legCA.pool, tokenC, tokenA, {
                routeId,
                routePath: meta.routePath || '',
                routeIndex,
                triangleIndex,
                routeTotalFeeBps,
                legIndex: 3,
                pairLabel: 'C-A',
            }),
        ];

        // Validate every leg conforms to the canonical contract before we hand
        // it to the simulator. If any leg is missing required fields, drop the
        // route (silent failures here are exactly the bug Rizal asked about).
        for (const leg of route) {
            const contract = validateRouteLegContract(leg);
            if (!contract.valid) {
                return null;
            }
        }

        // Stamp directional metadata on the route so myEngine's diagnostic
        // reporter can show WHY this route was chosen.
        route._divergenceMeta = {
            directionalEdgeTotalBps: directionalEdgeTotal,
            perLeg: [
                {
                    legIndex: 1,
                    poolAddress: legAB.pool.poolAddress || legAB.pool.address,
                    directionalBps: legAB.directionalBps,
                    deviationBps: legAB.deviationBps,
                    divergenceBps: legAB.divergenceBps,
                    spreadPosition: legAB.spreadPosition,
                    feeBps: legAB.feeBps,
                    score: legAB.score,
                },
                {
                    legIndex: 2,
                    poolAddress: legBC.pool.poolAddress || legBC.pool.address,
                    directionalBps: legBC.directionalBps,
                    deviationBps: legBC.deviationBps,
                    divergenceBps: legBC.divergenceBps,
                    spreadPosition: legBC.spreadPosition,
                    feeBps: legBC.feeBps,
                    score: legBC.score,
                },
                {
                    legIndex: 3,
                    poolAddress: legCA.pool.poolAddress || legCA.pool.address,
                    directionalBps: legCA.directionalBps,
                    deviationBps: legCA.deviationBps,
                    divergenceBps: legCA.divergenceBps,
                    spreadPosition: legCA.spreadPosition,
                    feeBps: legCA.feeBps,
                    score: legCA.score,
                },
            ],
            routeTotalFeeBps,
            info: info || null,
        };
        return route;
    };

    // Strategy 1: best-of-each-leg. Always emit this if it survives leg
    // validation.
    const primary = buildRoute(scoredAB[0], scoredBC[0], scoredCA[0], 'best-of-each-leg');
    if (primary) routes.push(primary);

    // Strategy 2: top-K alternatives. We perturb one leg at a time, picking
    // the second-best for that leg. This generates variants the simulator can
    // compare against the primary, surfacing cases where the second-best pool
    // has lower fees that compensate for slightly worse directional edge.
    if (routes.length < maxRoutesPerTriangle && (scoredAB.length > 1 || scoredBC.length > 1 || scoredCA.length > 1)) {
        const variants = [];
        if (scoredAB.length > 1) variants.push(['ab', scoredAB[1], scoredBC[0], scoredCA[0]]);
        if (scoredBC.length > 1) variants.push(['bc', scoredAB[0], scoredBC[1], scoredCA[0]]);
        if (scoredCA.length > 1) variants.push(['ca', scoredAB[0], scoredBC[0], scoredCA[1]]);
        // Score each variant by aggregate, take in order.
        variants.sort((v1, v2) => {
            const s1 = (v1[1].score + v1[2].score + v1[3].score);
            const s2 = (v2[1].score + v2[2].score + v2[3].score);
            return s2 - s1;
        });
        for (const [tag, ab, bc, ca] of variants) {
            if (routes.length >= maxRoutesPerTriangle) break;
            const route = buildRoute(ab, bc, ca, `swap-leg-${tag}`);
            if (route) routes.push(route);
        }
    }

    // Strategy 3: cartesian fallback when no signal exists.
    if (routes.length === 0 && fallbackToCartesian && !anySignal) {
        // Sort each leg by fee asc and try cheapest combination first.
        const cheapAB = scoredAB.slice().sort((a, b) => a.feeBps - b.feeBps);
        const cheapBC = scoredBC.slice().sort((a, b) => a.feeBps - b.feeBps);
        const cheapCA = scoredCA.slice().sort((a, b) => a.feeBps - b.feeBps);
        outer:
        for (const ab of cheapAB) {
            for (const bc of cheapBC) {
                for (const ca of cheapCA) {
                    if (routes.length >= maxRoutesPerTriangle) break outer;
                    const route = buildRoute(ab, bc, ca, 'cartesian-fallback-cheapest-fees');
                    if (route) routes.push(route);
                }
            }
        }
    }

    return routes;
}

/**
 * Convenience wrapper that mirrors triangleArb.diagnose's signature for
 * walking a pool universe and emitting routes. Useful when callers want a
 * one-shot replacement; otherwise call buildDivergenceAwareRoutes directly
 * inside diagnose().
 *
 * @param {object} pairMap     output of triangleArb.buildPairMap (Map<key,Pool[]>)
 * @param {object} options
 *   - tokenA: string (required, default SOL)
 *   - maxRoutesPerTriangle: number
 *   - buildRouteLeg: function
 *   - mintToSymbol: Map<mint, symbol> (optional, for nicer routePath strings)
 */
function buildAllDivergenceAwareRoutesForGraph(pairMap, options = {}) {
    const tokenA = String(options.tokenA || SOL);
    const buildRouteLeg = options.buildRouteLeg;
    const mintToSymbol = options.mintToSymbol || new Map();
    const maxRoutesPerTriangle = options.maxRoutesPerTriangle || 3;

    const sym = (m) => mintToSymbol.get(m) || `${String(m).slice(0, 6)}..${String(m).slice(-4)}`;

    const findConnectedMints = (mint) => {
        const out = new Set();
        for (const key of pairMap.keys()) {
            if (key.startsWith(`${mint}-`)) out.add(key.split('-')[1]);
        }
        return Array.from(out);
    };

    const getPoolsForPair = (m1, m2) => pairMap.get(`${m1}-${m2}`) || pairMap.get(`${m2}-${m1}`) || [];

    const tokenBs = findConnectedMints(tokenA);
    const triangles = [];
    const allChainRoutes = [];

    for (const tokenB of tokenBs) {
        const tokenCs = findConnectedMints(tokenB);
        for (const tokenC of tokenCs) {
            if (tokenC === tokenA || tokenC === tokenB) continue;
            const poolsAB = getPoolsForPair(tokenA, tokenB);
            const poolsBC = getPoolsForPair(tokenB, tokenC);
            const poolsCA = getPoolsForPair(tokenC, tokenA);
            if (!poolsAB.length || !poolsBC.length || !poolsCA.length) continue;

            const routePath = `${sym(tokenA)} → ${sym(tokenB)} → ${sym(tokenC)} → ${sym(tokenA)}`;
            const chainRoutes = buildDivergenceAwareRoutes(poolsAB, poolsBC, poolsCA, {
                triangleIndex: triangles.length + 1,
                routePath,
                tokenA, tokenB, tokenC,
                buildRouteLeg,
                maxRoutesPerTriangle,
                scoringOptions: options.scoringOptions || {},
            });
            if (!chainRoutes.length) continue;

            triangles.push({
                path: routePath,
                tokenA, tokenB, tokenC,
                poolsAB: poolsAB.length,
                poolsBC: poolsBC.length,
                poolsCA: poolsCA.length,
                chainRouteCount: chainRoutes.length,
                chainRoutes,
            });
            allChainRoutes.push(...chainRoutes);
        }
    }

    return { triangles, chainRoutes: allChainRoutes, chainRouteCount: allChainRoutes.length };
}

module.exports = {
    buildDivergenceAwareRoutes,
    buildAllDivergenceAwareRoutesForGraph,
    computeLegDirectionalEdge,
    scoreLegPool,
    pickBestPoolForLeg,
    pickTopKForLeg,
};