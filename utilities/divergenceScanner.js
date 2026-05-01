'use strict';
/**
 * divergenceScanner.js  (v2 — adapted to poolContract & normalizer)
 *
 * What changed from v1
 * --------------------
 *   1. All pool reads now go through `mergeCanonicalPool` from `./poolContract`.
 *      The scanner sees pools through the same lens as the rest of the
 *      pipeline. mergeCanonicalPool is idempotent — safe even when the
 *      pool was already normalized at extraction time.
 *
 *   2. Symbol resolution:
 *        - hardcoded SOL / USDC / USDT / USD1 (matches triangleRouteCore)
 *        - falls back to canonical baseSymbol / quoteSymbol / tokenXSymbol
 *        - last resort: short mint string ("So1111..1112")
 *      The pair report now shows "SOL/USDC" instead of mint fragments.
 *
 *   3. New `--diagnose` flag prints, per pool, which extraction path
 *      produced the mid (sqrt | bin | reserves | currentPrice | none).
 *      Use this when divergence shows 0.00 across all pairs — it tells
 *      you whether the data is genuinely tight or whether extraction is
 *      failing.
 *
 *   4. New `--out` flag writes annotated pools (with pair* fields) back
 *      to disk for downstream consumption — preserves the input wrapper
 *      shape (object vs array).
 *
 *   5. New currentPrice fallback path. Some DEX APIs include `currentPrice`
 *      directly; if neither sqrt nor reserves resolve, we use it. Comes
 *      with a warning since orientation depends on the source.
 *
 * Public API
 *   annotatePairDivergence(pools, options?)
 *   scoreTriangleByDivergence(routeLegs)
 *   filterRoutesByDivergence(routes, options?)
 *   selectBestPoolPerLeg(poolsPerLegInDirection)
 *   buildDivergenceReport(pools)
 *   printDivergenceReport(pools, options?)
 */

const fs = require('fs');
const Decimal = require('decimal.js');
Decimal.set({ precision: 60 });

// Project-wide canonicalizer. The scanner no longer reinvents normalization.
const { mergeCanonicalPool } = require('./poolContract');

// Hardcoded mint→symbol map (matches triangleRouteCore.js).
const SYMBOL_MAP = new Map([
    ['So11111111111111111111111111111111111111112', 'SOL'],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
    ['USD1ttHhAohfN8M7f3dS6KkwQZtV8Lk5fQKibQfEmuB', 'USD1'],
]);

/* -------------------------------------------------------------------------- */
/*                              Pure helpers                                  */
/* -------------------------------------------------------------------------- */

function decimalOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    try {
        const d = new Decimal(String(value));
        return d.isFinite() ? d : null;
    } catch (_e) {
        return null;
    }
}

function shortMint(value) {
    if (!value) return '?';
    const s = String(value);
    return s.length > 12 ? `${s.slice(0, 6)}..${s.slice(-4)}` : s;
}

function looksLikeMint(value) {
    const s = String(value || '');
    return s.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function symbolFor(mint, fallback) {
    if (!mint) return '?';
    const known = SYMBOL_MAP.get(mint);
    if (known) return known;
    if (fallback && fallback !== '?' && !looksLikeMint(fallback) && String(fallback).length <= 16) {
        return String(fallback);
    }
    return shortMint(mint);
}

function canonicalPairKey(mintA, mintB) {
    if (!mintA || !mintB) return null;
    const [base, quote] = [String(mintA), String(mintB)].sort();
    return { base, quote, key: `${base}|${quote}` };
}

function median(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? sorted[mid - 1].plus(sorted[mid]).div(2)
        : sorted[mid];
}

/**
 * Get the canonical view of a pool. Calls mergeCanonicalPool which is
 * idempotent — if pool.normalized already holds a valid canonical, it's
 * reused without re-normalizing. Always safe to call.
 */
function getCanonical(pool) {
    return mergeCanonicalPool(pool || {});
}

/* -------------------------------------------------------------------------- */
/*                           Mid-price extraction                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns { mid, source }. Source identifies which path produced the value:
 *   'sqrt'         CLMM/Whirlpool sqrtPriceX64 — most accurate
 *   'bin'          DLMM bin formula
 *   'reserves'     CPMM reserves ratio (or DLMM/CLMM with reserves available)
 *   'currentPrice' API-provided field, last resort, orientation may vary
 *   'none'         No path produced a mid
 *
 * Mid is "tokenY per tokenX" in UI units (decimals applied).
 */
function getPoolMidPriceYperX(pool) {
    const c = getCanonical(pool);
    const xDec = Number(c.tokenXDecimals || 0);
    const yDec = Number(c.tokenYDecimals || 0);

    // Path 1 — sqrtPriceX64 (CLMM/Whirlpool primary).
    const sqrtRaw = decimalOrNull(c.sqrtPriceX64 ?? c.sqrtPrice);
    if (sqrtRaw && sqrtRaw.gt(0)) {
        const Q64 = new Decimal(2).pow(64);
        const decimalsAdj = new Decimal(10).pow(xDec - yDec);
        const mid = sqrtRaw.div(Q64).pow(2).mul(decimalsAdj);
        if (mid.isFinite() && mid.gt(0)) return { mid, source: 'sqrt' };
    }

    // Path 2 — DLMM bin formula. P_bin = (1 + binStep/10000)^activeId.
    if (c.binStep != null && c.activeBinId != null) {
        const binStep = Number(c.binStep);
        const activeId = Number(c.activeBinId);
        if (Number.isFinite(binStep) && Number.isFinite(activeId) && binStep > 0) {
            const base = new Decimal(1).plus(new Decimal(binStep).div(10000));
            const rawPrice = base.pow(activeId);
            const decimalsAdj = new Decimal(10).pow(xDec - yDec);
            const mid = rawPrice.mul(decimalsAdj);
            if (mid.isFinite() && mid.gt(0)) return { mid, source: 'bin' };
        }
    }

    // Path 3 — reserve ratio (CPMM, or pre-enrichment DLMM/CLMM).
    const rxRaw = decimalOrNull(c.reserves?.x ?? c.xReserve);
    const ryRaw = decimalOrNull(c.reserves?.y ?? c.yReserve);
    if (rxRaw && ryRaw && rxRaw.gt(0) && ryRaw.gt(0)) {
        const rxUi = rxRaw.div(new Decimal(10).pow(xDec));
        const ryUi = ryRaw.div(new Decimal(10).pow(yDec));
        if (rxUi.gt(0) && ryUi.gt(0)) return { mid: ryUi.div(rxUi), source: 'reserves' };
    }

    // Path 4 — API-provided currentPrice (raydium/orca/meteora). Treated as
    // yPerX in UI units; orientation may differ across APIs but it's better
    // than nothing for a divergence signal.
    const cp = decimalOrNull(c.currentPrice ?? pool.currentPrice);
    if (cp && cp.gt(0)) return { mid: cp, source: 'currentPrice' };

    return { mid: null, source: 'none' };
}

/**
 * Mid in canonical orientation: quote-per-base where base = alphabetically-
 * first mint. Two pools on the same pair are now directly comparable.
 */
function getPoolMidCanonical(pool) {
    const c = getCanonical(pool);
    const xMint = c.tokenXMint;
    const yMint = c.tokenYMint;
    const pair = canonicalPairKey(xMint, yMint);
    if (!pair) return { mid: null, pair: null, orientation: null, source: 'none' };

    const { mid: yPerX, source } = getPoolMidPriceYperX(pool);
    if (!yPerX || yPerX.lte(0)) return { mid: null, pair, orientation: null, source };

    if (xMint === pair.base) {
        return { mid: yPerX, pair, orientation: 'base-is-x', source };
    }
    return { mid: new Decimal(1).div(yPerX), pair, orientation: 'base-is-y', source };
}

/* -------------------------------------------------------------------------- */
/*                            Symbol resolution                               */
/* -------------------------------------------------------------------------- */

function getPoolSymbols(pool) {
    const c = getCanonical(pool);
    return {
        tokenXSymbol: symbolFor(c.tokenXMint, c.tokenXSymbol || c.baseSymbol),
        tokenYSymbol: symbolFor(c.tokenYMint, c.tokenYSymbol || c.quoteSymbol),
    };
}

/**
 * Build a pair label like "SOL/USDC" from any member pool. Walks members
 * until it finds one whose canonical X/Y orientation lines up with the
 * pair's base/quote, then pulls symbols from that side.
 */
function pairLabel(pair, members) {
    let baseSym = SYMBOL_MAP.get(pair.base) || null;
    let quoteSym = SYMBOL_MAP.get(pair.quote) || null;

    if (!baseSym || !quoteSym) {
        for (const { pool } of members) {
            const c = getCanonical(pool);
            let candidateBase, candidateQuote;
            if (c.tokenXMint === pair.base) {
                candidateBase = c.tokenXSymbol || c.baseSymbol;
                candidateQuote = c.tokenYSymbol || c.quoteSymbol;
            } else if (c.tokenYMint === pair.base) {
                candidateBase = c.tokenYSymbol || c.quoteSymbol;
                candidateQuote = c.tokenXSymbol || c.baseSymbol;
            }
            if (!baseSym && candidateBase && !looksLikeMint(candidateBase)) baseSym = candidateBase;
            if (!quoteSym && candidateQuote && !looksLikeMint(candidateQuote)) quoteSym = candidateQuote;
            if (baseSym && quoteSym) break;
        }
    }
    return `${baseSym || shortMint(pair.base)}/${quoteSym || shortMint(pair.quote)}`;
}

/* -------------------------------------------------------------------------- */
/*                            Pair divergence                                 */
/* -------------------------------------------------------------------------- */

function annotatePairDivergence(pools = [], options = {}) {
    const diagnose = Boolean(options.diagnose);

    // Group by canonical pair.
    const groups = new Map();
    for (const pool of pools) {
        const { mid, pair, orientation, source } = getPoolMidCanonical(pool);
        if (!pair) {
            if (diagnose) {
                const c = getCanonical(pool);
                console.log(`  [skip] ${shortMint(pool.poolAddress || pool.address)} ${c.dex}/${c.type} — missing mint`);
            }
            continue;
        }
        if (!groups.has(pair.key)) groups.set(pair.key, { pair, members: [] });
        groups.get(pair.key).members.push({ pool, mid, orientation, source });
    }

    // Per-pair stats.
    for (const { pair, members } of groups.values()) {
        const mids = members.map((m) => m.mid).filter((m) => m && m.gt(0));
        const label = pairLabel(pair, members);
        const [baseSymStr, quoteSymStr] = label.split('/');

        if (mids.length === 0) {
            for (const m of members) {
                m.pool.pairCanonical = pair.key;
                m.pool.pairLabel = label;
                m.pool.pairBaseMint = pair.base;
                m.pool.pairQuoteMint = pair.quote;
                m.pool.pairBaseSymbol = baseSymStr;
                m.pool.pairQuoteSymbol = quoteSymStr;
                m.pool.pairMidPrice = null;
                m.pool.pairPeerCount = members.length;
                m.pool.pairDivergenceBps = 0;
                m.pool.pairMidExtractionSource = m.source;
            }
            continue;
        }

        // Sanity gate. Different extraction sources produce values in different
        // unit spaces:
        //   - sqrt:         derived from sqrtPriceX64, rigorous and orientation-clean
        //   - reserves:     derived from atomic reserves, rigorous and orientation-clean
        //   - bin:          DLMM raw bin formula, NOT decimal-adjusted across DEXes
        //   - currentPrice: API-provided, orientation varies by API
        //
        // Comparing 'sqrt' to 'reserves' is safe (both are decimal-adjusted yPerX
        // canonicalized to base/quote). Comparing 'currentPrice' to anything else
        // is unsafe because orientation isn't guaranteed. Comparing 'bin' to
        // 'currentPrice' is the worst case (the heterogeneous mismatches we saw
        // in pre-enriched data).
        //
        // Strategy: compute divergence only over the LARGEST homogeneous subset.
        // If a pair has 2 'sqrt' and 1 'currentPrice', use the 2 'sqrt' members.
        // If all members are different sources, refuse to publish a divergence.
        const COMPATIBLE = new Set(['sqrt', 'reserves']);  // safely interchangeable
        const sourceCounts = new Map();
        for (const m of members) {
            sourceCounts.set(m.source, (sourceCounts.get(m.source) || 0) + 1);
        }

        // Build the comparable subset. Prefer sqrt+reserves combined (safe to mix).
        const compatibleMembers = members.filter((m) => COMPATIBLE.has(m.source));
        let comparable = compatibleMembers.length >= 2 ? compatibleMembers : null;

        if (!comparable) {
            // Otherwise pick the largest single-source group of size >= 2.
            let bestSource = null; let bestCount = 0;
            for (const [src, n] of sourceCounts.entries()) {
                if (n > bestCount) { bestSource = src; bestCount = n; }
            }
            if (bestCount >= 2) {
                comparable = members.filter((m) => m.source === bestSource);
            }
        }

        const cmpMids = (comparable || []).map((m) => m.mid).filter((m) => m && m.gt(0));
        const med = cmpMids.length ? median(cmpMids) : median(mids); // fallback for stamping
        const min = cmpMids.length ? cmpMids.reduce((a, b) => (a.lt(b) ? a : b)) : null;
        const max = cmpMids.length ? cmpMids.reduce((a, b) => (a.gt(b) ? a : b)) : null;

        const heterogeneous = !comparable;
        const divergenceBps = (heterogeneous || !med || !med.gt(0) || !min || !max)
            ? 0
            : Number(max.minus(min).div(med).mul(10000).toFixed(4));

        for (const { pool, mid, orientation, source } of members) {
            pool.pairCanonical = pair.key;
            pool.pairLabel = label;
            pool.pairBaseMint = pair.base;
            pool.pairQuoteMint = pair.quote;
            pool.pairBaseSymbol = baseSymStr;
            pool.pairQuoteSymbol = quoteSymStr;
            pool.pairOrientation = orientation;
            pool.pairPeerCount = members.length;
            pool.pairComparablePeerCount = comparable ? comparable.length : 0;
            pool.pairMidPrice = mid ? Number(mid.toFixed(12)) : null;
            pool.pairMedianMid = med ? Number(med.toFixed(12)) : null;
            pool.pairBestMid = max ? Number(max.toFixed(12)) : null;
            pool.pairWorstMid = min ? Number(min.toFixed(12)) : null;
            pool.pairDivergenceBps = divergenceBps;
            pool.pairDivergenceComparable = !heterogeneous;
            // Deviation only meaningful when this pool is in the comparable subset.
            const inCompare = comparable && comparable.some((m) => m.pool === pool);
            pool.pairMidDeviationBps = (heterogeneous || !inCompare || !mid || !med || !med.gt(0))
                ? 0
                : Number(mid.minus(med).div(med).mul(10000).toFixed(4));
            pool.pairSpreadPosition = (heterogeneous || !inCompare || !max || !min || !max.gt(min) || !mid)
                ? 0.5
                : Number(mid.minus(min).div(max.minus(min)).toFixed(4));
            pool.pairMidExtractionSource = source;
        }
    }

    if (diagnose) {
        const sources = {};
        let withMid = 0; let withoutMid = 0;
        let heterogeneous = 0;
        const seenPairs = new Set();
        for (const p of pools) {
            const s = p.pairMidExtractionSource || 'none';
            sources[s] = (sources[s] || 0) + 1;
            if (p.pairMidPrice != null) withMid += 1; else withoutMid += 1;
            if (p.pairCanonical && !seenPairs.has(p.pairCanonical)) {
                seenPairs.add(p.pairCanonical);
                if (p.pairDivergenceComparable === false) heterogeneous += 1;
            }
        }
        console.log('\n  Mid-price extraction summary:');
        for (const [s, n] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${s.padEnd(14)} ${n} pools`);
        }
        console.log(`  Pools with mid:    ${withMid}/${pools.length}`);
        console.log(`  Pools without mid: ${withoutMid}/${pools.length}`);
        if (heterogeneous > 0) {
            console.log(`  ⚠ Heterogeneous pairs (cross-source mid mismatch): ${heterogeneous}`);
            console.log(`    These pairs have divergence forced to 0 — comparison was unsafe.`);
            console.log(`    To fix: enrich pools first so all members extract via 'sqrt' or 'reserves'.`);
        }
        if (withoutMid > pools.length / 2) {
            console.log(`  ⚠ More than half of pools have no mid — divergence will be unreliable.`);
            console.log(`    Likely cause: pools missing both sqrtPriceX64 and reserves data.`);
            console.log(`    Run enrichment before scanning, or check that pool data flows through normalizer.`);
        }
    }

    return pools;
}

/* -------------------------------------------------------------------------- */
/*                          Triangle/route scoring                            */
/* -------------------------------------------------------------------------- */

function scoreTriangleByDivergence(routeLegs = []) {
    if (!Array.isArray(routeLegs) || routeLegs.length === 0) {
        return { maxLegBps: 0, sumLegBps: 0, directionalEdgeBps: 0, flatLegs: 0, perLeg: [] };
    }

    const perLeg = routeLegs.map((leg) => {
        const pool = leg?.pool || leg;
        const c = getCanonical(pool);
        const divergenceBps = Number(pool?.pairDivergenceBps || 0);
        const peerCount = Number(pool?.pairPeerCount || 0);
        const deviation = Number(pool?.pairMidDeviationBps || 0);

        // Direction-aware deviation. pairMidPrice is "quote per base":
        //   selling base for quote: want high mid → favorable when deviation > 0
        //   buying base with quote: want low mid  → favorable when deviation < 0
        let directionalBps = 0;
        const tokenIn = leg?.tokenInMint || leg?.inputMint;
        const baseMint = pool?.pairBaseMint;
        if (tokenIn && baseMint) {
            const sellingBase = tokenIn === baseMint;
            directionalBps = sellingBase ? deviation : -deviation;
        }

        return {
            legIndex: leg?.legIndex ?? null,
            poolAddress: pool?.poolAddress || pool?.address || null,
            pairLabel: pool?.pairLabel || pool?.pairCanonical || null,
            dex: c.dex || pool?.dex || null,
            type: c.type || pool?.type || null,
            divergenceBps,
            peerCount,
            deviationBps: deviation,
            directionalBps: Number(directionalBps.toFixed(4)),
        };
    });

    const maxLegBps = perLeg.reduce((m, l) => Math.max(m, l.divergenceBps), 0);
    const sumLegBps = perLeg.reduce((s, l) => s + l.divergenceBps, 0);
    const directionalEdgeBps = perLeg.reduce((s, l) => s + l.directionalBps, 0);
    const flatLegs = perLeg.filter((l) => l.divergenceBps < 0.5).length;

    return {
        maxLegBps: Number(maxLegBps.toFixed(4)),
        sumLegBps: Number(sumLegBps.toFixed(4)),
        directionalEdgeBps: Number(directionalEdgeBps.toFixed(4)),
        flatLegs,
        perLeg,
    };
}

function filterRoutesByDivergence(routes = [], options = {}) {
    const minBps = Number(options.minBps ?? 5);
    const maxFlatLegs = Number(options.maxFlatLegs ?? 2);
    const minDirectionalBps = options.minDirectionalBps != null
        ? Number(options.minDirectionalBps)
        : null;

    return routes.filter((route) => {
        const score = route.score || scoreTriangleByDivergence(route.legs || route);
        if (score.maxLegBps < minBps) return false;
        if (score.flatLegs > maxFlatLegs) return false;
        if (minDirectionalBps !== null && score.directionalEdgeBps < minDirectionalBps) return false;
        return true;
    });
}

function selectBestPoolPerLeg(poolsPerLegInDirection = []) {
    return poolsPerLegInDirection.map((pools) => {
        if (!Array.isArray(pools) || pools.length === 0) return null;
        if (pools.length === 1) return pools[0];

        let best = pools[0];
        let bestScore = -Infinity;
        for (const candidate of pools) {
            const pool = candidate.pool || candidate;
            const tokenIn = candidate.tokenInMint || candidate.inputMint;
            const baseMint = pool.pairBaseMint;
            const mid = Number(pool.pairMidPrice || 0);
            if (!mid || !tokenIn || !baseMint) continue;
            const score = (tokenIn === baseMint) ? mid : -mid;
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        return best;
    });
}

/* -------------------------------------------------------------------------- */
/*                          Reporting / CLI helpers                           */
/* -------------------------------------------------------------------------- */

function buildDivergenceReport(pools = []) {
    const groups = new Map();
    for (const pool of pools) {
        const key = pool.pairCanonical;
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pool);
    }

    const rows = Array.from(groups.entries()).map(([key, members]) => {
        const first = members[0];
        return {
            pair: key,
            pairLabel: first.pairLabel || key,
            base: first.pairBaseMint,
            quote: first.pairQuoteMint,
            baseSymbol: first.pairBaseSymbol,
            quoteSymbol: first.pairQuoteSymbol,
            poolCount: members.length,
            divergenceBps: first.pairDivergenceBps,
            medianMid: first.pairMedianMid,
            bestMid: first.pairBestMid,
            worstMid: first.pairWorstMid,
            pools: members.map((p) => {
                const c = getCanonical(p);
                return {
                    addr: shortMint(p.poolAddress || p.address),
                    dex: c.dex || p.dex || p.dexType,
                    type: c.type || p.type,
                    feeBps: c.feeBps != null ? c.feeBps : p.feeBps,
                    mid: p.pairMidPrice,
                    deviationBps: p.pairMidDeviationBps,
                    midSource: p.pairMidExtractionSource,
                };
            }),
        };
    });

    rows.sort((a, b) => b.divergenceBps - a.divergenceBps);
    return rows;
}

function printDivergenceReport(pools = [], options = {}) {
    const limit = Number(options.limit || 20);
    const minBps = Number(options.minBps || 0);
    const rows = buildDivergenceReport(pools).filter((r) => r.divergenceBps >= minBps);

    console.log('\n📐 PAIR DIVERGENCE REPORT');
    console.log('───────────────────────────────────────────────────────────────────────────');
    console.log(`${rows.length} pairs with divergence >= ${minBps} bps (showing top ${limit})\n`);
    console.log('PAIR                            | POOLS | DIVERGE | MEDIAN MID');
    console.log('────────────────────────────────┼───────┼─────────┼──────────────');

    for (const row of rows.slice(0, limit)) {
        const label = row.pairLabel.length > 30 ? `${row.pairLabel.slice(0, 27)}..` : row.pairLabel;
        const divLabel = `${row.divergenceBps.toFixed(2).padStart(6)}b`;
        const midLabel = row.medianMid ? Number(row.medianMid).toExponential(4) : 'n/a';
        console.log(`${label.padEnd(32)}|${String(row.poolCount).padStart(6)} | ${divLabel} | ${midLabel}`);
        if (options.verbose) {
            for (const p of row.pools) {
                const dev = p.deviationBps != null
                    ? `${p.deviationBps > 0 ? '+' : ''}${p.deviationBps.toFixed(2)}b`
                    : 'n/a';
                const mid = p.mid != null ? Number(p.mid).toExponential(4) : 'n/a';
                console.log(`    ${p.addr.padEnd(14)} ${(p.dex || '').padEnd(8)} ${(p.type || '').padEnd(10)} `
                    + `fee=${String(p.feeBps).padStart(3)}b mid=${mid} dev=${dev} via=${p.midSource}`);
            }
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                                   CLI                                      */
/* -------------------------------------------------------------------------- */

function parseCliArgs(argv) {
    const out = { input: '01_meta.json', output: '02_filtered.json', minBps: 0, limit: 20, verbose: false, diagnose: false };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--in' || arg === '--input') { out.input = argv[++i]; continue; }
        if (arg === '--out' || arg === '--output') { out.output = argv[++i]; continue; }
        if (arg === '--min-bps') { out.minBps = Number(argv[++i]); continue; }
        if (arg === '--limit') { out.limit = Number(argv[++i]); continue; }
        if (arg === '--verbose' || arg === '-v') { out.verbose = true; continue; }
        if (arg === '--diagnose') { out.diagnose = true; continue; }
        if (!out.input) out.input = arg;
    }
    return out;
}

function extractPoolsFromAny(raw) {
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.pools)) return raw.pools;
    if (Array.isArray(raw?.runtime?.pools)) return raw.runtime.pools;
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.selected)) return raw.selected;
    return [];
}

function reseatPools(rawInput, pools) {
    if (Array.isArray(rawInput)) return pools;
    if (Array.isArray(rawInput?.pools)) return { ...rawInput, pools };
    if (Array.isArray(rawInput?.runtime?.pools)) {
        return { ...rawInput, runtime: { ...rawInput.runtime, pools } };
    }
    if (Array.isArray(rawInput?.data)) return { ...rawInput, data: pools };
    if (Array.isArray(rawInput?.selected)) return { ...rawInput, selected: pools };
    return pools;
}

if (require.main === module) {
    const args = parseCliArgs(process.argv);
    if (!args.input) {
        console.error('Usage: node divergenceScanner.js --in 01_meta.json --out 02_filtered.json');
        console.error('                                  [--min-bps 5] [--limit 30] [--verbose] [--diagnose]');
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    const pools = extractPoolsFromAny(raw);
    console.log(`Loaded ${pools.length} pools from ${args.input}`);

    if (args.diagnose) console.log('\n🔍 Per-pool extraction (--diagnose):');
    annotatePairDivergence(pools, { diagnose: args.diagnose });
    printDivergenceReport(pools, { minBps: args.minBps, limit: args.limit, verbose: args.verbose });

    if (args.output) {
        const payload = reseatPools(raw, pools);
        fs.writeFileSync(args.output, JSON.stringify(payload, null, 2));
        console.log(`\nWrote annotated pools to ${args.output}`);
    }
}

module.exports = {
    parseCliArgs,
    annotatePairDivergence,
    scoreTriangleByDivergence,
    filterRoutesByDivergence,
    selectBestPoolPerLeg,
    buildDivergenceReport,
    printDivergenceReport,
    // Lower-level utilities for advanced callers:
    getPoolMidPriceYperX,
    getPoolMidCanonical,
    getPoolSymbols,
    canonicalPairKey,
    symbolFor,
};

/*
Canonical numbered runtime sequence:

node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json
node utilities/divergenceScanner.js --in 01_meta.json --out 02_filtered.json
node engine/Q_enrichment.js --in 02_filtered.json --out 03_enriched.json
node engine/myEngine.js --in 03_enriched.json --out 04_runtimeResults.json --csv 05_result_compare.csv --json 06_result_data.json --html 07_result_report.html
*/
