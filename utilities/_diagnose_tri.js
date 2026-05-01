'use strict';
/**
 * diagnose_triangles.js
 * 
 * Diagnoses why no triangle candidates are being found.
 * Logs detailed information about:
 *   1. Available pairs for tokenA (SOL)
 *   2. Potential intermediate tokens (tokenB)
 *   3. Potential third tokens (tokenC) 
 *   4. Why each triangle might be rejected
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Connection } = require('@solana/web3.js');

// ============================================================================
// CONFIG
// ============================================================================

const RPC_URL = process.env.RPC_URL || process.env.ALCHEMY_RPC_URL;
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const short = (s) => s ? `${s.slice(0, 6)}..${s.slice(-4)}` : '?';

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

function getFeeBpsFromPool(pool) {
    if (!pool) return 0;
    if (pool.feeBps != null) return Number(pool.feeBps) || 0;
    if (pool.feeRate != null) return Math.round(Number(pool.feeRate) * 10000) || 0;
    return 0;
}

function minFeeBpsForPools(pools) {
    if (!pools || pools.length === 0) return 0;
    let min = Number.POSITIVE_INFINITY;
    for (const p of pools) {
        const fee = getFeeBpsFromPool(p);
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
    return Array.isArray(raw) ? raw : (raw.pools || raw.data || []);
}

function getPoolMints(pool) {
    const base = pool.baseMint || pool.mintA || pool.tokenMintA;
    const quote = pool.quoteMint || pool.mintB || pool.tokenMintB;
    return { base, quote };
}

function buildPairMap(pools) {
    const pairMap = new Map(); // "mintA-mintB" -> [pools]
    const mintToSymbol = new Map();

    for (const pool of pools) {
        const { base, quote } = getPoolMints(pool);
        if (!base || !quote) continue;

        // Store symbol mappings
        if (pool.baseSymbol) mintToSymbol.set(base, pool.baseSymbol);
        if (pool.quoteSymbol) mintToSymbol.set(quote, pool.quoteSymbol);

        // Store both directions
        const key1 = `${base}-${quote}`;
        const key2 = `${quote}-${base}`;

        if (!pairMap.has(key1)) pairMap.set(key1, []);
        if (!pairMap.has(key2)) pairMap.set(key2, []);

        pairMap.get(key1).push(pool);
        pairMap.get(key2).push(pool);
    }

    return { pairMap, mintToSymbol };
}

function findConnectedMints(pairMap, mint) {
    const connected = new Set();
    for (const [key, pools] of pairMap.entries()) {
        if (key.startsWith(mint + '-')) {
            const other = key.split('-')[1];
            connected.add(other);
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

function getPoolAddress(pool) {
    return pool?.poolAddress || pool?.address || pool?.id || null;
}

function summarizePool(pool, pairLabel = '') {
    const { base, quote } = getPoolMints(pool || {});
    return {
        pair: pairLabel || null,
        poolAddress: getPoolAddress(pool),
        dex: pool?.dex || pool?.type || pool?.poolType || 'unknown',
        type: pool?.type || pool?.poolType || 'unknown',
        baseMint: base || null,
        quoteMint: quote || null,
        baseSymbol: pool?.baseSymbol || null,
        quoteSymbol: pool?.quoteSymbol || null,
        feeBps: getFeeBpsFromPool(pool),
    };
}

function buildChainRoutes(poolsAB, poolsBC, poolsCA, meta = {}) {
    const routePath = meta.routePath || '';
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

                const leg1 = summarizePool(poolAB, 'A-B');
                const leg2 = summarizePool(poolBC, 'B-C');
                const leg3 = summarizePool(poolCA, 'C-A');

                chainRoutes.push({
                    routeId: `tri-${meta.triangleIndex || 0}-${routeIndex}`,
                    routePath,
                    tokenA: meta.tokenA || null,
                    tokenB: meta.tokenB || null,
                    tokenC: meta.tokenC || null,
                    totalFeeBps: leg1.feeBps + leg2.feeBps + leg3.feeBps,
                    leg1,
                    leg2,
                    leg3,
                });

                if (chainRoutes.length >= maxRoutesPerTriangle) {
                    break outer;
                }
            }
        }
    }

    return chainRoutes;
}

// ============================================================================
// MAIN DIAGNOSTIC
// ============================================================================

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

    // Load pools
    const pools = Array.isArray(poolsPath) ? poolsPath : loadPools(poolsPath);
    console.log(`📦 Loaded ${pools.length} pools`);

    // Build pair map
    const { pairMap, mintToSymbol } = buildPairMap(pools);
    console.log(`🔗 Found ${pairMap.size / 2} unique pairs`);
    console.log('');

    // Helper to get symbol
    const sym = (mint) => mintToSymbol.get(mint) || short(mint);

    // Step 1: Find all tokens connected to tokenA
    console.log('───────────────────────────────────────────────────────────────');
    console.log(`STEP 1: Tokens connected to ${sym(tokenAMint)} (potential tokenB)`);
    console.log('───────────────────────────────────────────────────────────────');

    const tokenBs = findConnectedMints(pairMap, tokenAMint);
    console.log(`Found ${tokenBs.length} tokens connected to ${sym(tokenAMint)}:`);

    if (tokenBs.length === 0) {
        console.log('❌ NO TOKENS CONNECTED TO SOL!');
        console.log('   This means no pools have SOL as base or quote mint.');
        console.log('');
        console.log('   Checking pool structure...');

        // Debug: show what mints ARE in the pools
        const allMints = new Set();
        for (const pool of pools.slice(0, 5)) {
            console.log(`   Pool: ${JSON.stringify({
                baseMint: pool.baseMint?.slice(0, 10),
                quoteMint: pool.quoteMint?.slice(0, 10),
                mintA: pool.mintA?.slice(0, 10),
                mintB: pool.mintB?.slice(0, 10),
                type: pool.type || pool.poolType
            })}`);
        }
        return;
    }

    for (const tokenB of tokenBs) {
        const poolCount = getPoolsForPair(pairMap, tokenAMint, tokenB).length;
        console.log(`  ${sym(tokenB)} (${poolCount} pools)`);
    }
    console.log('');

    // Step 2: For each tokenB, find potential tokenCs
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 2: Finding triangle candidates');
    console.log('───────────────────────────────────────────────────────────────');

    const triangles = [];
    const allChainRoutes = [];

    for (const tokenB of tokenBs) {
        // Find tokens connected to tokenB (potential tokenC)
        const tokenCs = findConnectedMints(pairMap, tokenB);

        for (const tokenC of tokenCs) {
            // Skip if tokenC is tokenA or tokenB
            if (tokenC === tokenAMint || tokenC === tokenB) continue;

            // Check if we can complete the triangle back to tokenA
            const check = canFormTriangle(pairMap, tokenAMint, tokenB, tokenC);

            if (check.valid) {
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
                    maxRoutesPerTriangle
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
                    chainRoutes
                });

                allChainRoutes.push(...chainRoutes);
            }
        }
    }

    console.log(`Found ${triangles.length} valid triangles:`);
    console.log('');

    if (triangles.length === 0) {
        console.log('❌ NO VALID TRIANGLES FOUND');
        console.log('');
        console.log('Debugging why...');

        // Show what's missing
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
        // Sort by lowest min total fee, then by combinations
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

    // Step 3: Show pool types breakdown
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 3: Pool types in file');
    console.log('───────────────────────────────────────────────────────────────');

    const typeCount = {};
    const dexCount = {};

    for (const pool of pools) {
        const type = pool.type || pool.poolType || 'unknown';
        const dex = pool.dex || 'unknown';
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

    // Step 4: Check SOL specifically
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 4: SOL pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const solPools = pools.filter(p => {
        const { base, quote } = getPoolMints(p);
        return base === SOL || quote === SOL;
    });

    console.log(`Pools with SOL: ${solPools.length}`);

    for (const pool of solPools.slice(0, 30)) {
        const { base, quote } = getPoolMints(pool);
        const type = pool.type || pool.poolType || '?';
        const other = base === SOL ? quote : base;
        console.log(`  ${sym(SOL)} ↔ ${sym(other)} [${type}] ${short(pool.poolAddress || pool.address)}`);
    }

    if (solPools.length === 0) {
        console.log('');
        console.log('❌ NO SOL POOLS FOUND!');
        console.log('');
        console.log('Sample pool structure:');
        const sample = pools[0];
        console.log(JSON.stringify(sample, null, 2).slice(0, 1000));
    }



    // Step 5: Check USDC specifically
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 5: USDC pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const usdcPools = pools.filter(p => {
        const { base, quote } = getPoolMints(p);
        return base === USDC || quote === USDC;
    });

    console.log(`Pools with USDC: ${usdcPools.length}`);

    for (const pool of usdcPools.slice(0, 30)) {
        const { base, quote } = getPoolMints(pool);
        const type = pool.type || pool.poolType || '?';
        const other = base === USDC ? quote : base;
        console.log(`  ${sym(USDC)} ↔ ${sym(other)} [${type}] ${short(pool.poolAddress || pool.address)}`);
    }

    if (solPools.length === 0) {
        console.log('');
        console.log('❌ NO USDC POOLS FOUND!');
        console.log('');
        console.log('Sample pool structure:');
        const sample = pools[0];
        console.log(JSON.stringify(sample, null, 2).slice(0, 1000));
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
        sources
    };
}



// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
    const parseArgs = (argv) => {
        const out = { inputs: [], tokenA: null, output: null, maxRoutesPerTriangle: null };
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i];
            if (!a) continue;
            const kv = a.match(/^([a-zA-Z][\\w-]*)=(.*)$/);
            if (kv) {
                let val = kv[2];
                if (val === '' && argv[i + 1] && !argv[i + 1].startsWith('-')) val = argv[++i];
                const key = kv[1].toLowerCase();
                if (key === 'input' || key === 'in') out.inputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                if (key === 'token' || key === 'tokena') out.tokenA = val;
                if (key === 'output' || key === 'out') out.output = val;
                if (key === 'maxroutespertriangle' || key === 'maxroutes') out.maxRoutesPerTriangle = val;
                continue;
            }
            if (a.startsWith('--')) {
                const key = a.replace(/^--?/, '').toLowerCase();
                let val = argv[i + 1];
                if (val && val.startsWith('--')) val = '';
                if (val !== '' && val != null && !val.startsWith('--')) i++;
                if (key === 'input' || key === 'in') out.inputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                if (key === 'token' || key === 'tokena') out.tokenA = val;
                if (key === 'output' || key === 'out') out.output = val;
                if (key === 'maxroutespertriangle' || key === 'maxroutes') out.maxRoutesPerTriangle = val;
                continue;
            }
            out.inputs.push(a);
        }
        return out;
    };

    const parsed = parseArgs(process.argv.slice(2));
    const inputs = parsed.inputs.length ? parsed.inputs : ['results/filtered_whitelist_pools.json'];
    const tokenA = parsed.tokenA || SOL;

    const mergedPools = [];
    const loadedSources = [];
    const skippedSources = [];
    for (const p of inputs) {
        if (!p) continue;
        if (!fs.existsSync(p)) {
            console.warn(`Input not found: ${p}`);
            skippedSources.push({ path: p, reason: 'not_found' });
            continue;
        }
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(raw)) {
            mergedPools.push(...raw);
            loadedSources.push(p);
            continue;
        }
        if (Array.isArray(raw?.pools)) {
            mergedPools.push(...raw.pools);
            loadedSources.push(p);
            continue;
        }
        if (Array.isArray(raw?.data)) {
            mergedPools.push(...raw.data);
            loadedSources.push(p);
            continue;
        }
        if (raw?.fastQuote || raw?.exactQuote) {
            console.warn(`Skipping quote-only file (no pools): ${p}`);
            skippedSources.push({ path: p, reason: 'quote_only' });
            continue;
        }
        console.warn(`Unrecognized input shape: ${p}`);
        skippedSources.push({ path: p, reason: 'unrecognized_shape' });
    }

    if (!mergedPools.length) {
        console.error('No pools loaded from inputs. Aborting.');
        process.exit(1);
    }

    diagnose(mergedPools, tokenA, {
        sources: loadedSources,
        skippedSources,
        maxRoutesPerTriangle: parsed.maxRoutesPerTriangle
    }).then((result) => {
        if (parsed.output) {
            fs.writeFileSync(parsed.output, JSON.stringify(result, null, 2));
            console.log(`Output saved: ${parsed.output}`);
        }
    }).catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}

module.exports = { diagnose, loadPools, buildPairMap, findConnectedMints, canFormTriangle };



//. 


//. node utilities/_diagnose_tri.js --in 01_meta.json --out Qseries/01_meta-routed.json tokenA=So11111111111111111111111111111111111111112 maxRoutesPerTriangle=5 --output=Qseries/01_meta_diagnostic.json
