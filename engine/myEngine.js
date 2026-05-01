'use strict';

/**
 * MAIN ARB ENGINE
 *
 * Uses the same canonical + triangle-route flow that already passes in
 * test_canonical_3leg_flow.js, instead of brute-forcing all pool triples.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { enrichAllPools, buildEnrichmentDiagnosticsEntry } = require('./Q_enrichment');
const { diagnose, buildChainRoutes, buildRouteLeg, SwapChainSimulator, SOL } = require('./triangleArb');
const { mergeCanonicalPool } = require('../utilities/poolContract.js');
const {
  extractPools: extractPoolsFromPayload,
  extractChainRoutes: extractChainRoutesFromPayload,
  getPoolSymbolForMint,
} = require('../utilities/triangleRouteCore');
const { processInBatches } = require('../utilities/batchProcess');
const { createRpcConnection, getConfiguredRpcUrls } = require('../utilities/rpcConnectionManager');
const {
  annotatePairDivergence,
  scoreTriangleByDivergence,
  filterRoutesByDivergence,
  buildDivergenceReport,
} = require('../utilities/divergenceScanner');
const { generateTradeReports } = require('../utilities/tradeReportGenerator');

const DEFAULT_START_AMOUNT = '1000000000'; // 1 SOL
const DEFAULT_OUTPUT = path.resolve(__dirname, '..', '04_runtimeResults.json');
const DEFAULT_INPUT = path.resolve(__dirname, '..', '03_enriched.json');
const DEFAULT_TOP_N = 20;
const DEFAULT_REPORT_CSV = '05_result_compare.csv';
const DEFAULT_REPORT_JSON = '06_result_data.json';
const DEFAULT_REPORT_HTML = '07_result_report.html';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_TRADE_SIZE_SWEEP_SOL = '0.1,0.5,1,5';
const DEFAULT_DEPTH_TICK_WINDOW = 50;

function parseArgs(argv) {
  const out = {
    outputCSV: DEFAULT_REPORT_CSV,
    outputReportJson: DEFAULT_REPORT_JSON,
    outputHTML: DEFAULT_REPORT_HTML,
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    tokenA: SOL,
    startAmount: DEFAULT_START_AMOUNT,
    maxRoutesPerTriangle: 5,
    maxSimulations: 500,
    batchSize: 10,
    batchDelayMs: 0,
    poolLimit: 0,
    topN: DEFAULT_TOP_N,
    slippageBps: 20,
    latencySlippageBps: 0,
    jitoTipBps: null,
    jitoTipLamports: 0,
    divergenceMinBps: 0,
    divergenceMaxFlatLegs: 3,
    divergenceMinDirectionalBps: null,
    divergenceDiagnose: false,
    tradeSizeSweep: DEFAULT_TRADE_SIZE_SWEEP_SOL,
    tradeSizeSweepEnabled: true,
    minDepthLiquidity: '0',
    depthTickWindow: DEFAULT_DEPTH_TICK_WINDOW,
    executionMode: 'strict',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      out[key] = next && !next.startsWith('--') ? argv[++i] : 'true';
      continue;
    }

    out.input = arg;
  }

  if (out.in) out.input = out.in;
  if (out.out) out.output = out.out;
  if (out.outputCsv) out.outputCSV = out.outputCsv;
  if (out.csv) out.outputCSV = out.csv;
  if (out.outputJson) out.outputReportJson = out.outputJson;
  if (out.reportJson) out.outputReportJson = out.reportJson;
  if (out.htmlJson) out.outputReportJson = out.htmlJson;
  if (out.json) out.outputReportJson = out.json;
  if (out.outputHtml) out.outputHTML = out.outputHtml;
  if (out.reportHtml) out.outputHTML = out.reportHtml;
  if (out.html) out.outputHTML = out.html;
  if (out.executionmode) out.executionMode = out.executionmode;
  if (out.maxSimulation) out.maxSimulations = out.maxSimulation;
  if (out.maxsimulation) out.maxSimulations = out.maxsimulation;
  if (out.sizeSweep != null) out.tradeSizeSweep = out.sizeSweep;
  if (out['size-sweep'] != null) out.tradeSizeSweep = out['size-sweep'];
  if (out.tradeSizes != null) out.tradeSizeSweep = out.tradeSizes;
  if (out['trade-sizes'] != null) out.tradeSizeSweep = out['trade-sizes'];
  if (out['trade-size-sweep'] != null) out.tradeSizeSweep = out['trade-size-sweep'];
  if (out.noSizeSweep != null) out.tradeSizeSweepEnabled = false;
  if (out['no-size-sweep'] != null) out.tradeSizeSweepEnabled = false;
  if (String(out.tradeSizeSweep).toLowerCase() === 'false') out.tradeSizeSweepEnabled = false;
  if (String(out.tradeSizeSweep).toLowerCase() === 'off') out.tradeSizeSweepEnabled = false;
  if (out['min-depth-liquidity'] != null) out.minDepthLiquidity = out['min-depth-liquidity'];
  if (out.minTickDepthLiquidity != null) out.minDepthLiquidity = out.minTickDepthLiquidity;
  if (out['min-tick-depth-liquidity'] != null) out.minDepthLiquidity = out['min-tick-depth-liquidity'];
  if (out['depth-tick-window'] != null) out.depthTickWindow = out['depth-tick-window'];
  if (out.depthWindowTicks != null) out.depthTickWindow = out.depthWindowTicks;
  if (out['depth-window-ticks'] != null) out.depthTickWindow = out['depth-window-ticks'];
  if (out['divergence-min-bps'] != null) out.divergenceMinBps = out['divergence-min-bps'];
  if (out['route-min-bps'] != null) out.divergenceMinBps = out['route-min-bps'];
  if (out['divergence-max-flat-legs'] != null) out.divergenceMaxFlatLegs = out['divergence-max-flat-legs'];
  if (out['max-flat-legs'] != null) out.divergenceMaxFlatLegs = out['max-flat-legs'];
  if (out['divergence-min-directional-bps'] != null) out.divergenceMinDirectionalBps = out['divergence-min-directional-bps'];
  if (out['min-directional-bps'] != null) out.divergenceMinDirectionalBps = out['min-directional-bps'];
  if (out['divergence-diagnose'] != null) out.divergenceDiagnose = out['divergence-diagnose'];

  out.maxRoutesPerTriangle = Number(out.maxRoutesPerTriangle || 5);
  out.maxSimulations = Number(out.maxSimulations || 1000);
  out.batchSize = Math.max(1, Number(out.batchSize || 10));
  out.batchDelayMs = Math.max(0, Number(out.batchDelayMs || 0));
  out.poolLimit = Math.max(0, Number(out.poolLimit || 0));
  out.topN = Number(out.topN || DEFAULT_TOP_N);
  out.slippageBps = Number(out.slippageBps || 20);
  out.latencySlippageBps = Number(out.latencySlippageBps || 0);
  out.jitoTipBps = out.jitoTipBps == null ? null : Number(out.jitoTipBps || 0);
  out.jitoTipLamports = Number(out.jitoTipLamports || 0);
  out.divergenceMinBps = Number(out.divergenceMinBps || 0);
  out.divergenceMaxFlatLegs = Number(out.divergenceMaxFlatLegs || 3);
  out.divergenceMinDirectionalBps = out.divergenceMinDirectionalBps == null
    ? null
    : Number(out.divergenceMinDirectionalBps || 0);
  out.divergenceDiagnose = String(out.divergenceDiagnose || '').toLowerCase() === 'true'
    || String(out.diagnose || '').toLowerCase() === 'true';
  out.depthTickWindow = Math.max(0, Number(out.depthTickWindow || DEFAULT_DEPTH_TICK_WINDOW));
  out.minDepthLiquidity = String(out.minDepthLiquidity || '0');
  out.startAmount = String(out.startAmount || DEFAULT_START_AMOUNT);
  out.executionMode = String(out.executionMode || 'strict').toLowerCase();
  return out;
}

function loadPools(inputPath) {
  const resolved = path.resolve(inputPath);
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const runtime = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.runtime && typeof raw.runtime === 'object'
    ? raw.runtime
    : null;
  const source = runtime || raw;
  const pools = extractPoolsFromPayload(source);
  const precomputedChainRoutes = extractChainRoutesFromPayload(source);

  if (!Array.isArray(raw) && pools.length === 0 && Array.isArray(raw.allRankedRoutes)) {
    throw new Error(
      `Input file ${resolved} is a ranking report without runtime pools. Re-run sim_diagnose_tri_ranked.js with the patched version to regenerate the file.`
    );
  }

  return {
    resolved,
    raw,
    pools: pools.map((pool) => mergeCanonicalPool(pool)),
    precomputedChainRoutes,
    inputProfile: classifyInputProfile(source, precomputedChainRoutes),
  };
}

function classifyInputProfile(raw = {}, precomputedChainRoutes = []) {
  const hasSummary = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.summary && typeof raw.summary === 'object';
  const hasPoolsWrapper = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.pools);
  const hasRoutePrep = hasPoolsWrapper && precomputedChainRoutes.length > 0;

  return {
    kind: hasRoutePrep ? 'routed' : (hasPoolsWrapper ? 'wrapped-pools' : 'plain-pools'),
    hasSummary,
    hasRoutePrep,
    summary: hasSummary ? raw.summary : null,
    metadata: raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.metadata || null) : null,
  };
}

function resolvePoolType(pool = {}) {
  return String(pool.type || pool.dexType || pool.dex || '').toLowerCase();
}

function needsRpcEnrichment(pools = []) {
  return pools.some((pool) => ['clmm', 'whirlpool', 'dlmm'].includes(resolvePoolType(pool)));
}

function getRpcConnectionIfAvailable(pools) {
  if (!needsRpcEnrichment(pools)) return null;

  const rpcUrls = getConfiguredRpcUrls();
  if (!rpcUrls.length) {
    console.warn('⚠ HELIUS_ENDPOINT1 not set. Continuing without live RPC enrichment.');
    return null;
  }

  console.log(`\n🔌 Connecting to RPC pool for live enrichment...`);
  console.log(`   Endpoints: ${rpcUrls.length}`);
  return createRpcConnection({ urls: rpcUrls, commitment: 'confirmed' });
}

function divergenceLegFields(leg = {}) {
  return {
    pairCanonical: leg.pairCanonical ?? null,
    pairLabel: leg.pairLabel || leg.label || null,
    pairBaseMint: leg.pairBaseMint ?? null,
    pairQuoteMint: leg.pairQuoteMint ?? null,
    pairBaseSymbol: leg.pairBaseSymbol ?? null,
    pairQuoteSymbol: leg.pairQuoteSymbol ?? null,
    pairOrientation: leg.pairOrientation ?? null,
    pairPeerCount: leg.pairPeerCount ?? 0,
    pairComparablePeerCount: leg.pairComparablePeerCount ?? 0,
    pairMidPrice: leg.pairMidPrice ?? null,
    pairMedianMid: leg.pairMedianMid ?? null,
    pairBestMid: leg.pairBestMid ?? null,
    pairWorstMid: leg.pairWorstMid ?? null,
    pairDivergenceBps: leg.pairDivergenceBps ?? 0,
    pairDivergenceComparable: leg.pairDivergenceComparable ?? null,
    pairMidDeviationBps: leg.pairMidDeviationBps ?? 0,
    pairSpreadPosition: leg.pairSpreadPosition ?? null,
    pairMidExtractionSource: leg.pairMidExtractionSource ?? null,
  };
}

function summarizeSimulation(simulation) {
  return {
    routeId: simulation.routeId,
    routePath: simulation.routePath,
    startAmount: simulation.startAmount,
    finalAmount: simulation.finalAmount,
    profitLamports: simulation.profitLamports,
    profitBps: simulation.profitBps,
    requiredEdgeBps: simulation.requiredEdgeBps,
    totalFeeBps: simulation.totalFeeBps,
    latencySlippageBps: simulation.latencySlippageBps,
    jitoTipBps: simulation.jitoTipBps,
    profitable: simulation.profitable,
    executionEligible: simulation.executionEligible,
    executionQuality: simulation.executionQuality,
    legs: simulation.legs.map((leg) => ({
      legIndex: leg.legIndex,
      poolAddress: leg.poolAddress,
      dexType: leg.dexType,
      type: leg.type,
      tokenInMint: leg.tokenInMint,
      tokenOutMint: leg.tokenOutMint,
      inAmountRaw: leg.inAmountRaw,
      outAmountRaw: leg.outAmountRaw,
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
      tickDepth: leg.tickDepth || null,
      ...divergenceLegFields(leg),
      swapDirection: leg.swapDirection,
      quoteSource: leg.quoteSource || null,
      tickStrategy: leg.tickStrategy || null,
    })),
    execution: simulation.execution,
  };
}

function looksLikeMint(value) {
  const text = String(value || '');
  return text.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(text);
}

function displaySymbolFromRouteLeg(routeLeg = {}, mint) {
  const token = String(mint || '');
  if (!token) return '?';
  const pool = routeLeg.pool || routeLeg;
  const symbol = getPoolSymbolForMint(pool, token);
  if (!symbol || symbol === '?' || looksLikeMint(symbol)) return token.slice(0, 6) + '..' + token.slice(-4);
  return symbol;
}

function annotateSimulationSymbols(summary = {}, sourceRoute = []) {
  const sourceLegs = Array.isArray(sourceRoute) ? sourceRoute : [];
  const legs = (summary.legs || []).map((leg, index) => {
    const sourceLeg = sourceLegs[index] || {};
    const inputSymbol = displaySymbolFromRouteLeg(sourceLeg, leg.tokenInMint);
    const outputSymbol = displaySymbolFromRouteLeg(sourceLeg, leg.tokenOutMint);
    return {
      ...leg,
      inputSymbol,
      outputSymbol,
      ...divergenceLegFields({ ...sourceLeg, ...leg }),
    };
  });
  const routePathSymbols = legs.length
    ? [legs[0].inputSymbol, ...legs.map((leg) => leg.outputSymbol)].join(' → ')
    : summary.routePath;

  return {
    ...summary,
    routePathSymbols,
    divergenceScore: scoreTriangleByDivergence(sourceRoute),
    legs,
  };
}

function summarizeGateReasons(entries = []) {
  const counts = new Map();
  for (const entry of entries) {
    const key = String(entry?.reason || 'Unknown gate rejection');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}

function toBigIntAmount(value, fallback = 0n) {
  try {
    if (typeof value === 'bigint') return value;
    if (value === null || value === undefined || value === '') return fallback;
    return BigInt(String(value).split('.')[0]);
  } catch (_error) {
    return fallback;
  }
}

function parseSolToLamports(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0n;
  if (!/^\d+(\.\d+)?$/.test(text)) return 0n;
  const [whole, fraction = ''] = text.split('.');
  const fractionalLamports = `${fraction}000000000`.slice(0, 9);
  return (BigInt(whole || '0') * LAMPORTS_PER_SOL) + BigInt(fractionalLamports || '0');
}

function lamportsToSolNumber(value) {
  const lamports = toBigIntAmount(value, 0n);
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

function resolveTradeSizeAmounts(startAmount, options = {}) {
  if (!options.tradeSizeSweepEnabled) return [String(startAmount || DEFAULT_START_AMOUNT)];

  const rawSweep = String(options.tradeSizeSweep || DEFAULT_TRADE_SIZE_SWEEP_SOL)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const parsed = rawSweep
    .map(parseSolToLamports)
    .filter((amount) => amount > 0n);
  const unique = Array.from(new Set(parsed.map((amount) => amount.toString())));

  return unique.length ? unique : [String(startAmount || DEFAULT_START_AMOUNT)];
}

function summarizeSizeSweepAttempt(result = {}, amount) {
  return {
    startAmount: String(amount),
    sizeSol: lamportsToSolNumber(amount),
    success: Boolean(result.success),
    routeId: result.routeId || null,
    finalAmount: result.finalAmount || null,
    profitLamports: result.profitLamports || null,
    profitBps: result.profitBps ?? null,
    requiredEdgeBps: result.requiredEdgeBps ?? null,
    totalFeeBps: result.totalFeeBps ?? result.sumFeeBps ?? null,
    profitable: result.profitable ?? false,
    executionEligible: result.executionEligible ?? false,
    executionQuality: result.executionQuality || null,
    error: result.error || null,
    gateReasons: result.execution?.gateReasons || [],
  };
}

function sizeSweepObjective(result = {}, amount) {
  if (!result.success || !Number.isFinite(Number(result.profitBps))) {
    return Number.NEGATIVE_INFINITY;
  }
  return Number(result.profitBps) * lamportsToSolNumber(amount);
}

function extractStructuredTickArrays(pool = {}) {
  if (Array.isArray(pool.tickArrayData) && pool.tickArrayData.length) return pool.tickArrayData;
  if (Array.isArray(pool.aux?.whirlpool?.tickArrays) && pool.aux.whirlpool.tickArrays.length) {
    return pool.aux.whirlpool.tickArrays;
  }
  if (Array.isArray(pool.aux?.clmm?.tickArrayData) && pool.aux.clmm.tickArrayData.length) {
    return pool.aux.clmm.tickArrayData;
  }
  if (Array.isArray(pool.tickArrays) && pool.tickArrays.some((entry) => entry && typeof entry === 'object')) {
    return pool.tickArrays;
  }
  return [];
}

function computeTickDepthAtCurrent(pool = {}, windowTicks = DEFAULT_DEPTH_TICK_WINDOW) {
  const tickCurrent = Number(pool.tickCurrent ?? pool.tickCurrentIndex);
  const tickSpacing = Math.max(1, Number(pool.tickSpacing || 1));
  const window = Math.max(0, Number(windowTicks || DEFAULT_DEPTH_TICK_WINDOW));
  const arrays = extractStructuredTickArrays(pool);

  if (!Number.isFinite(tickCurrent) || arrays.length === 0) {
    return {
      available: false,
      reason: arrays.length === 0 ? 'missing-structured-tick-arrays' : 'missing-current-tick',
      tickCurrent: Number.isFinite(tickCurrent) ? tickCurrent : null,
      tickWindow: window,
      liquidityGrossWithinWindow: '0',
      initializedTickCountWithinWindow: 0,
      sampledTickCountWithinWindow: 0,
    };
  }

  const lowerTick = tickCurrent - window;
  const upperTick = tickCurrent + window;
  let liquidityGrossWithinWindow = 0n;
  let initializedTickCountWithinWindow = 0;
  let sampledTickCountWithinWindow = 0;

  for (const entry of arrays) {
    const data = entry?.data && typeof entry.data === 'object' ? entry.data : entry;
    const startTickIndex = Number(data?.startTickIndex ?? data?.start_index ?? entry?.startTickIndex ?? entry?.start_index);
    const rawTicks = Array.isArray(data?.ticks) ? data.ticks : (Array.isArray(entry?.ticks) ? entry.ticks : []);
    if (!Number.isFinite(startTickIndex) || rawTicks.length === 0) continue;

    for (const [index, tick] of rawTicks.entries()) {
      const tickIndex = Number(tick?.tick ?? tick?.tickIndex ?? tick?.index ?? (startTickIndex + (index * tickSpacing)));
      if (!Number.isFinite(tickIndex) || tickIndex < lowerTick || tickIndex > upperTick) continue;
      sampledTickCountWithinWindow += 1;

      const liquidityGross = toBigIntAmount(tick?.liquidityGross ?? tick?.gross ?? tick?.liquidity_gross, 0n);
      if (liquidityGross > 0n || tick?.initialized) initializedTickCountWithinWindow += 1;
      liquidityGrossWithinWindow += liquidityGross;
    }
  }

  return {
    available: sampledTickCountWithinWindow > 0,
    reason: sampledTickCountWithinWindow > 0 ? null : 'no-sampled-ticks-in-window',
    tickCurrent,
    tickWindow: window,
    lowerTick,
    upperTick,
    liquidityGrossWithinWindow: liquidityGrossWithinWindow.toString(),
    initializedTickCountWithinWindow,
    sampledTickCountWithinWindow,
  };
}

function applyTickDepthFilter(pools = [], options = {}) {
  const threshold = toBigIntAmount(options.minDepthLiquidity, 0n);
  const windowTicks = options.depthTickWindow || DEFAULT_DEPTH_TICK_WINDOW;
  const summary = {
    enabled: threshold > 0n,
    threshold: threshold.toString(),
    tickWindow: windowTicks,
    inputPools: pools.length,
    outputPools: pools.length,
    droppedPools: 0,
    dropped: [],
    measuredPools: 0,
    unmeasuredPools: 0,
  };

  for (const pool of pools) {
    const type = String(pool?.type || pool?.poolType || pool?.dexType || '').toLowerCase();
    const needsDepth = type.includes('clmm') || type.includes('whirlpool');
    if (!needsDepth) continue;

    const depth = computeTickDepthAtCurrent(pool, windowTicks);
    pool.tickDepth = depth;
    if (depth.available) summary.measuredPools += 1;
    else summary.unmeasuredPools += 1;
  }

  if (!summary.enabled) return { pools, summary };

  const filtered = pools.filter((pool) => {
    const type = String(pool?.type || pool?.poolType || pool?.dexType || '').toLowerCase();
    const needsDepth = type.includes('clmm') || type.includes('whirlpool');
    if (!needsDepth) return true;

    const depth = pool.tickDepth || computeTickDepthAtCurrent(pool, windowTicks);
    if (!depth.available) return true;

    const keep = toBigIntAmount(depth.liquidityGrossWithinWindow, 0n) >= threshold;
    if (!keep) {
      summary.dropped.push({
        poolAddress: pool.poolAddress || pool.address || pool.id || null,
        dex: pool.dex || null,
        type: pool.type || pool.poolType || null,
        tickCurrent: depth.tickCurrent,
        liquidityGrossWithinWindow: depth.liquidityGrossWithinWindow,
      });
    }
    return keep;
  });

  summary.outputPools = filtered.length;
  summary.droppedPools = pools.length - filtered.length;
  return { pools: filtered, summary };
}

function summarizeRouteDexCombos(routes = []) {
  const counts = new Map();

  for (const route of routes) {
    const combo = (route || [])
      .map((leg) => `${leg?.dexType || 'UNKNOWN'}:${leg?.type || 'unknown'}`)
      .join(' | ');
    if (!combo) continue;
    counts.set(combo, (counts.get(combo) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([combo, count]) => ({ combo, count }));
}

function buildPoolAddressMap(pools = []) {
  const byAddress = new Map();
  for (const pool of pools) {
    const address = String(pool?.poolAddress || pool?.address || '').trim();
    if (!address) continue;
    byAddress.set(address, pool);
  }
  return byAddress;
}

function rehydrateRouteLeg(leg = {}, pool = null, routeMeta = {}) {
  const base = pool || leg;
  const tokenInMint = leg?.tokenInMint || leg?.inputMint || null;
  const tokenOutMint = leg?.tokenOutMint || leg?.outputMint || null;
  const rebuilt = buildRouteLeg(base, tokenInMint, tokenOutMint, {
    triangleIndex: leg?.triangleIndex ?? routeMeta?.triangleIndex ?? 0,
    routePath: leg?.routePath || routeMeta?.routePath || '',
    routeId: leg?.routeId || routeMeta?.routeId || null,
    routeIndex: leg?.routeIndex ?? routeMeta?.routeIndex ?? null,
    routeTotalFeeBps: leg?.routeTotalFeeBps ?? routeMeta?.routeTotalFeeBps ?? 0,
    legIndex: leg?.legIndex ?? null,
    pairLabel: leg?.label || null,
  });

  const merged = {
    ...(rebuilt || base),
    routeId: routeMeta?.routeId || leg?.routeId || rebuilt?.routeId || null,
    routePath: leg?.routePath || routeMeta?.routePath || rebuilt?.routePath || null,
    routeIndex: leg?.routeIndex ?? routeMeta?.routeIndex ?? rebuilt?.routeIndex ?? null,
    triangleIndex: leg?.triangleIndex ?? routeMeta?.triangleIndex ?? rebuilt?.triangleIndex ?? null,
    routeTotalFeeBps: leg?.routeTotalFeeBps ?? routeMeta?.routeTotalFeeBps ?? rebuilt?.routeTotalFeeBps ?? 0,
    legIndex: leg?.legIndex ?? rebuilt?.legIndex ?? null,
    label: leg?.label || rebuilt?.label || null,
    tokenInMint: tokenInMint || rebuilt?.tokenInMint || null,
    tokenOutMint: tokenOutMint || rebuilt?.tokenOutMint || null,
    inputMint: leg?.inputMint || tokenInMint || rebuilt?.inputMint || null,
    outputMint: leg?.outputMint || tokenOutMint || rebuilt?.outputMint || null,
  };

  return merged;
}

function hydratePrecomputedChainRoutes(precomputedRoutes = [], pools = []) {
  if (!Array.isArray(precomputedRoutes) || precomputedRoutes.length === 0) {
    return [];
  }

  const poolByAddress = buildPoolAddressMap(pools);
  const hydrated = [];

  for (const route of precomputedRoutes) {
    if (Array.isArray(route?.legs) && route.legs.length === 3) {
      let missingPool = false;
      const rebuiltRoute = route.legs.map((leg, index) => {
        const address = String(leg?.poolAddress || '').trim();
        const pool = address ? poolByAddress.get(address) : null;
        if (address && !pool) missingPool = true;
        return rehydrateRouteLeg({ ...leg, legIndex: leg?.legIndex ?? index + 1 }, pool, route);
      });
      if (missingPool) continue;
      hydrated.push(rebuiltRoute);
      continue;
    }

    if (Array.isArray(route) && route.length === 3 && route.every((leg) => leg?.tokenInMint && leg?.tokenOutMint)) {
      let missingPool = false;
      const rebuiltRoute = route.map((leg, index) => {
        const address = String(leg?.poolAddress || '').trim();
        const pool = address ? poolByAddress.get(address) : null;
        if (address && !pool) missingPool = true;
        return rehydrateRouteLeg(leg, pool, {
          routeId: route?.[0]?.routeId || null,
          routePath: route?.[0]?.routePath || null,
          routeIndex: route?.[0]?.routeIndex ?? null,
          triangleIndex: route?.[0]?.triangleIndex ?? null,
          routeTotalFeeBps: route?.[0]?.routeTotalFeeBps ?? 0,
          legIndex: index + 1,
        });
      });
      if (missingPool) continue;
      hydrated.push(rebuiltRoute);
      continue;
    }

    const leg1Address = String(route?.leg1?.poolAddress || '').trim();
    const leg2Address = String(route?.leg2?.poolAddress || '').trim();
    const leg3Address = String(route?.leg3?.poolAddress || '').trim();
    if (!leg1Address || !leg2Address || !leg3Address) continue;

    const poolAB = poolByAddress.get(leg1Address);
    const poolBC = poolByAddress.get(leg2Address);
    const poolCA = poolByAddress.get(leg3Address);
    if (!poolAB || !poolBC || !poolCA) continue;




    const rebuilt = buildChainRoutes([poolAB], [poolBC], [poolCA], {
      triangleIndex: route?.triangleIndex || 0,
      routePath: route?.routePath || '',
      tokenA: route?.tokenA,
      tokenB: route?.tokenB,
      tokenC: route?.tokenC,
      maxRoutesPerTriangle: 1,
    });

    if (!rebuilt[0]) continue;

    hydrated.push(rebuilt[0].map((leg, index) => rehydrateRouteLeg(
      { ...leg, legIndex: leg?.legIndex ?? index + 1 },
      poolByAddress.get(leg.poolAddress),
      route
    )));
  }

  return hydrated;
}

function annotateDivergenceForEngine(pools = [], options = {}) {
  annotatePairDivergence(pools, { diagnose: Boolean(options.divergenceDiagnose) });
  const report = buildDivergenceReport(pools);
  const comparablePairs = report.filter((row) => {
    const member = pools.find((pool) => pool.pairCanonical === row.pair);
    return member?.pairDivergenceComparable !== false;
  }).length;
  const sourceCounts = {};
  for (const pool of pools) {
    const source = pool.pairMidExtractionSource || 'none';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  }

  return {
    pairCount: report.length,
    comparablePairs,
    heterogeneousPairs: Math.max(0, report.length - comparablePairs),
    topPair: report[0]?.pairLabel || null,
    topDivergenceBps: report[0]?.divergenceBps ?? null,
    sourceCounts,
  };
}

function rankAndFilterChainRoutes(chainRoutes = [], options = {}) {
  const scoredRoutes = (chainRoutes || []).map((legs) => ({
    legs,
    score: scoreTriangleByDivergence(legs),
  }));

  scoredRoutes.sort((a, b) => {
    if (b.score.directionalEdgeBps !== a.score.directionalEdgeBps) {
      return b.score.directionalEdgeBps - a.score.directionalEdgeBps;
    }
    return b.score.maxLegBps - a.score.maxLegBps;
  });

  const filterActive = Number(options.divergenceMinBps || 0) > 0
    || options.divergenceMinDirectionalBps != null;
  const selected = filterActive
    ? filterRoutesByDivergence(scoredRoutes, {
      minBps: Number(options.divergenceMinBps || 0),
      maxFlatLegs: Number(options.divergenceMaxFlatLegs || 3),
      minDirectionalBps: options.divergenceMinDirectionalBps,
    })
    : scoredRoutes;

  return {
    chainRoutes: selected.map((entry) => entry.legs),
    summary: {
      filterActive,
      inputRoutes: scoredRoutes.length,
      selectedRoutes: selected.length,
      minBps: Number(options.divergenceMinBps || 0),
      maxFlatLegs: Number(options.divergenceMaxFlatLegs || 3),
      minDirectionalBps: options.divergenceMinDirectionalBps,
      topScores: selected.slice(0, 5).map((entry) => entry.score),
    },
  };
}

function finalizeRouteResolution(baseResolution = {}, options = {}) {
  const ranked = rankAndFilterChainRoutes(baseResolution.chainRoutes || [], options);
  return {
    ...baseResolution,
    chainRoutes: ranked.chainRoutes,
    chainRouteCount: ranked.chainRoutes.length,
    generatedChainRouteCount: (baseResolution.chainRoutes || []).length,
    divergenceRouteFilter: ranked.summary,
    routeDexCombos: summarizeRouteDexCombos(ranked.chainRoutes),
  };
}

function resolveChainRoutes(loaded, enrichedPools, options = {}) {
  const hydratedPrecomputed = hydratePrecomputedChainRoutes(loaded.precomputedChainRoutes, enrichedPools);
  if (hydratedPrecomputed.length > 0) {
    return finalizeRouteResolution({
      source: 'precomputed-routed-file',
      triangles: [],
      chainRoutes: hydratedPrecomputed,
      chainRouteCount: hydratedPrecomputed.length,
    }, options);
  }

  return diagnose(enrichedPools, options.tokenA || SOL, {
    sources: [loaded.resolved],
    maxRoutesPerTriangle: options.maxRoutesPerTriangle,
  }).then((diagnosis) => finalizeRouteResolution({
    source: 'diagnose',
    ...diagnosis,
  }, options));
}

function compactExecutionLeg(leg = {}) {
  return {
    legIndex: leg.legIndex,
    label: leg.label || null,
    poolAddress: leg.poolAddress,
    dexType: leg.dexType,
    type: leg.type,
    tokenInMint: leg.tokenInMint,
    tokenOutMint: leg.tokenOutMint,
    inputAmount: leg.inputAmount,
    expectedOutputAmount: leg.expectedOutputAmount,
    minOutputAmount: leg.minOutputAmount,
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
    tickDepth: leg.tickDepth || null,
    ...divergenceLegFields(leg),
    quoteSource: leg.quoteSource || null,
    swapDirection: leg.swapDirection || null,
    tickArrays: Array.isArray(leg.tickArrays) ? leg.tickArrays : [],
    binArrays: Array.isArray(leg.binArrays) ? leg.binArrays : [],
    binStep: leg.binStep ?? null,
    activeBinId: leg.activeBinId ?? null,
    executionQuality: leg.executionQuality || null,
  };
}

function buildSubmissionCandidate(route = {}, rank = 0, bucket = 'eligible') {
  const execution = route.execution || {};
  const executionLegs = Array.isArray(execution.legs) ? execution.legs : [];
  const lastLeg = executionLegs[executionLegs.length - 1] || {};
  const summaryLegsByIndex = new Map((route.legs || []).map((leg) => [Number(leg.legIndex), leg]));

  return {
    rank,
    bucket,
    routeId: route.routeId,
    routePath: route.routePath,
    routePathSymbols: route.routePathSymbols || route.routePath,
    startAmount: route.startAmount,
    selectedSizeSol: route.tradeSizeSelection?.selectedSizeSol ?? null,
    tradeSizeSelection: route.tradeSizeSelection || null,
    finalAmount: route.finalAmount,
    minFinalAmount: lastLeg.minOutputAmount || null,
    profitLamports: route.profitLamports,
    profitBps: route.profitBps,
    tradeSizeObjective: route.tradeSizeObjective ?? null,
    profitable: route.profitable,
    executionEligible: route.executionEligible,
    executionQuality: route.executionQuality || execution.qualityTier || 'unknown',
    gateReasons: execution.gateReasons || [],
    legCount: executionLegs.length,
    legs: executionLegs.map((leg) => {
      const compact = compactExecutionLeg(leg);
      const summaryLeg = summaryLegsByIndex.get(Number(compact.legIndex));
      return {
        ...compact,
        ...divergenceLegFields({ ...summaryLeg, ...compact }),
        inputSymbol: summaryLeg?.inputSymbol || null,
        outputSymbol: summaryLeg?.outputSymbol || null,
      };
    }),
  };
}

function collectSubmissionCandidates(routeSimulations, topN) {
  const preferred = Array.isArray(routeSimulations.profitable) && routeSimulations.profitable.length > 0
    ? routeSimulations.profitable
    : routeSimulations.eligibleRoutes;
  const seen = new Set();
  const out = [];

  for (const [index, route] of preferred.entries()) {
    const key = String(route?.routeId || route?.routePath || `route-${index}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(buildSubmissionCandidate(route, out.length + 1, route.profitable ? 'profitable' : 'eligible'));
    if (out.length >= topN) break;
  }

  return out;
}

function buildSubmissionSummary(candidates = []) {
  const profitable = candidates.filter((candidate) => candidate.profitable).length;
  const executionGrade = candidates.filter((candidate) => candidate.executionQuality === 'execution-grade').length;
  return {
    count: candidates.length,
    profitable,
    executionGrade,
    topRouteId: candidates[0]?.routeId || null,
    topProfitBps: candidates[0]?.profitBps ?? null,
    topTradeSizeObjective: candidates[0]?.tradeSizeObjective ?? null,
  };
}

function printInputPrepSummary(loaded, sourcePools) {
  const profile = loaded.inputProfile || {};
  if (profile.kind !== 'routed') return;

  console.log('\n🧭 Routed Runtime Input');
  console.log(`   Pools: ${sourcePools.length}`);
  console.log(`   Precomputed routes: ${loaded.precomputedChainRoutes.length}`);
  if (profile.summary) {
    if (profile.summary.triangles != null) {
      console.log(`   Triangles: ${profile.summary.triangles}`);
    }
    if (profile.summary.chainRoutes != null) {
      console.log(`   Chain routes: ${profile.summary.chainRoutes}`);
    }
    if (profile.summary.routedPools != null) {
      console.log(`   Routed pools: ${profile.summary.routedPools}`);
    }
  }
}

function shouldReuseRoutedPoolsWithoutReenrichment(loaded, options = {}) {
  if ((loaded.inputProfile || {}).kind !== 'routed') return false;
  if (String(options.reenrich || '').toLowerCase() === 'true') return false;
  const poolByAddress = buildPoolAddressMap(loaded.pools);
  const routePoolAddresses = new Set();
  for (const route of loaded.precomputedChainRoutes || []) {
    const legs = Array.isArray(route?.legs) ? route.legs : (Array.isArray(route) ? route : []);
    for (const leg of legs) {
      const address = String(leg?.poolAddress || leg?.address || '').trim();
      if (address) routePoolAddresses.add(address);
    }
  }

  for (const address of routePoolAddresses) {
    const pool = poolByAddress.get(address);
    if (!pool) return false;
    if (!buildEnrichmentDiagnosticsEntry(pool).executionReady) return false;
  }

  return true;
}

function printSubmissionSummary(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    console.log('\nNo 3-leg submission candidates available from this run.');
    return;
  }

  console.log('\n🚀 3-Leg Submission Candidates');
  for (const candidate of candidates.slice(0, 3)) {
    const sizeLabel = candidate.selectedSizeSol ? `${candidate.selectedSizeSol} SOL | ` : '';
    console.log(`  ${candidate.rank}. ${sizeLabel}${candidate.profitBps} bps | ${candidate.executionQuality} | ${candidate.routePathSymbols || candidate.routePath}`);
    for (const leg of candidate.legs) {
      const path = leg.inputSymbol && leg.outputSymbol
        ? `${leg.inputSymbol} -> ${leg.outputSymbol}`
        : `${leg.tokenInMint} -> ${leg.tokenOutMint}`;
      console.log(`     L${leg.legIndex}: ${leg.dexType}/${leg.type} ${leg.poolAddress} | ${path} | in=${leg.inputAmount} out=${leg.expectedOutputAmount}`);
    }
  }
}

async function simulateRoutes(chainRoutes, startAmount, slippageBps, connection, maxSimulations, executionMode = 'strict', options = {}) {
  const simulator = new SwapChainSimulator(connection);
  const limit = Math.min(chainRoutes.length, maxSimulations);
  const tradeSizeAmounts = resolveTradeSizeAmounts(startAmount, options);
  const sweepEnabled = tradeSizeAmounts.length > 1;
  const profitable = [];
  const gatedProfitable = [];
  const eligibleRoutes = [];
  let successCount = 0;
  let failedCount = 0;
  let attemptedCount = 0;
  let executableCount = 0;
  let gateRejectedCount = 0;
  const gateRejections = [];
  const diagnosticRoutes = [];
  const routesToSimulate = chainRoutes.slice(0, limit);

  await processInBatches(routesToSimulate, async (route) => {
    const attempts = [];
    let best = null;

    for (const amount of tradeSizeAmounts) {
      attemptedCount += 1;
      const result = await simulator.simulate3LegChain(route, amount, {
        slippageBps,
        latencySlippageBps: options.latencySlippageBps,
        jitoTipBps: options.jitoTipBps,
        jitoTipLamports: options.jitoTipLamports,
      });
      const attempt = summarizeSizeSweepAttempt(result, amount);
      attempt.objective = sizeSweepObjective(result, amount);
      attempts.push({ amount, result, attempt });

      if (!result.success) continue;
      if (!best || attempt.objective > best.attempt.objective) {
        best = { amount, result, attempt };
      }
    }

    if (!best) {
      failedCount += 1;
      return attempts[0]?.result || { success: false, error: 'No trade-size attempts were executed' };
    }

    const result = best.result;
    successCount += 1;
    const executionEligible = executionMode !== 'strict' || result.executionEligible;
    const summary = annotateSimulationSymbols(summarizeSimulation(result), route);
    summary.tradeSizeSelection = {
      enabled: sweepEnabled,
      objective: 'profitBps * sizeSol',
      selectedStartAmount: String(best.amount),
      selectedSizeSol: lamportsToSolNumber(best.amount),
      selectedObjective: best.attempt.objective,
      attempts: attempts.map((entry) => entry.attempt),
    };
    summary.tradeSizeObjective = best.attempt.objective;
    summary.selectedSizeSol = lamportsToSolNumber(best.amount);
    diagnosticRoutes.push(summary);

    if (executionEligible) {
      executableCount += 1;
      eligibleRoutes.push(summary);
    } else {
      gateRejectedCount += 1;
      gateRejections.push(...(result.execution?.gateReasons || []));
    }

    if (result.profitable && executionEligible) {
      profitable.push(summary);
    } else if (result.profitable) {
      gatedProfitable.push(summary);
    }

    return result;
  }, {
    batchSize: options.batchSize || 10,
    delayMs: options.batchDelayMs || 0,
  });

  const routeSortScore = (route) => Number.isFinite(Number(route.tradeSizeObjective))
    ? Number(route.tradeSizeObjective)
    : Number(route.profitBps || 0);

  profitable.sort((a, b) => routeSortScore(b) - routeSortScore(a));
  gatedProfitable.sort((a, b) => routeSortScore(b) - routeSortScore(a));
  eligibleRoutes.sort((a, b) => routeSortScore(b) - routeSortScore(a));
  diagnosticRoutes.sort((a, b) => routeSortScore(b) - routeSortScore(a));

  return {
    simulatedCount: limit,
    attemptedCount,
    tradeSizeSweep: {
      enabled: sweepEnabled,
      objective: 'profitBps * sizeSol',
      sizes: tradeSizeAmounts.map((amount) => ({
        startAmount: String(amount),
        sizeSol: lamportsToSolNumber(amount),
      })),
    },
    successCount,
    failedCount,
    executableCount,
    gateRejectedCount,
    gateRejectReasons: summarizeGateReasons(gateRejections),
    profitable,
    gatedProfitable,
    eligibleRoutes,
    diagnosticRoutes,
  };
}

async function runEngine(options = {}) {
  const loaded = loadPools(options.input || DEFAULT_INPUT);
  const connection = getRpcConnectionIfAvailable(loaded.pools);
  const sourcePools = options.poolLimit > 0
    ? loaded.pools.slice(0, options.poolLimit)
    : loaded.pools;

  console.log(`\n📦 Loaded ${loaded.pools.length} pools from ${loaded.resolved}`);
  if (options.poolLimit > 0 && sourcePools.length !== loaded.pools.length) {
    console.log(`🎯 Pool limit applied: ${sourcePools.length}/${loaded.pools.length}`);
  }
  printInputPrepSummary(loaded, sourcePools);

  const reuseRoutedPools = shouldReuseRoutedPoolsWithoutReenrichment(loaded, options);
  if (reuseRoutedPools) {
    console.log('\n♻ Reusing routed input pools without re-enrichment');
  }

  const enrichedPools = reuseRoutedPools
    ? sourcePools.map((pool) => ({ ...pool }))
    : await enrichAllPools(sourcePools.map((pool) => ({ ...pool })), connection);
  const depthFiltered = applyTickDepthFilter(enrichedPools, options);
  if (depthFiltered.summary.enabled) {
    console.log(`\n🧱 Tick-depth filter: kept ${depthFiltered.summary.outputPools}/${depthFiltered.summary.inputPools} pools `
      + `(dropped ${depthFiltered.summary.droppedPools}, window=±${depthFiltered.summary.tickWindow} ticks)`);
  }
  const candidatePools = depthFiltered.pools;
  const divergenceSummary = annotateDivergenceForEngine(candidatePools, options);
  const routeResolution = await resolveChainRoutes(loaded, candidatePools, options);

  const routeSimulations = await simulateRoutes(
    routeResolution.chainRoutes || [],
    options.startAmount || DEFAULT_START_AMOUNT,
    options.slippageBps || 20,
    connection,
    options.maxSimulations || 1000,
    options.executionMode || 'strict',
    {
      batchSize: options.batchSize || 10,
      batchDelayMs: options.batchDelayMs || 0,
      latencySlippageBps: options.latencySlippageBps || 0,
      jitoTipBps: options.jitoTipBps,
      jitoTipLamports: options.jitoTipLamports || 0,
      tradeSizeSweepEnabled: options.tradeSizeSweepEnabled,
      tradeSizeSweep: options.tradeSizeSweep,
    },
  );
  const submissionCandidates = collectSubmissionCandidates(routeSimulations, options.topN || DEFAULT_TOP_N);
  const triangleCount = (routeResolution.triangles || []).length
    || Number(loaded.inputProfile?.summary?.triangles || 0);

  return {
    success: true,
    source: loaded.resolved,
    inputProfile: loaded.inputProfile,
    routeSource: routeResolution.source,
    rpcEndpoints: typeof connection?.listEndpoints === 'function' ? connection.listEndpoints() : [],
    poolCount: candidatePools.length,
    enrichedPoolCount: enrichedPools.length,
    tickDepthFilter: depthFiltered.summary,
    divergenceSummary,
    triangleCount,
    chainRouteCount: routeResolution.chainRouteCount || 0,
    generatedChainRouteCount: routeResolution.generatedChainRouteCount || routeResolution.chainRouteCount || 0,
    divergenceRouteFilter: routeResolution.divergenceRouteFilter || null,
    routeDexCombos: routeResolution.routeDexCombos || [],
    simulatedRouteCount: routeSimulations.simulatedCount,
    attemptedSimulationCount: routeSimulations.attemptedCount,
    tradeSizeSweep: routeSimulations.tradeSizeSweep,
    batchSize: options.batchSize || 10,
    successfulSimulations: routeSimulations.successCount,
    failedSimulations: routeSimulations.failedCount,
    executionMode: options.executionMode || 'strict',
    executionEligibleRouteCount: routeSimulations.executableCount,
    gateRejectedRouteCount: routeSimulations.gateRejectedCount,
    gateRejectReasons: routeSimulations.gateRejectReasons,
    profitableRouteCount: routeSimulations.profitable.length,
    gatedProfitableRouteCount: routeSimulations.gatedProfitable.length,
    executionEligibleTopRoutes: routeSimulations.eligibleRoutes.slice(0, options.topN || DEFAULT_TOP_N),
    topRoutes: routeSimulations.profitable.slice(0, options.topN || DEFAULT_TOP_N),
    topGatedRoutes: routeSimulations.gatedProfitable.slice(0, Math.min(options.topN || DEFAULT_TOP_N, 10)),
    diagnosticTopRoutes: routeSimulations.diagnosticRoutes.slice(0, Math.min(options.topN || DEFAULT_TOP_N, 10)),
    submissionSummary: buildSubmissionSummary(submissionCandidates),
    submissionCandidates,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║  SOLANA ARBITRAGE - Canonical Pipeline               ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  const result = await runEngine(options);
  const output = JSON.stringify(result, null, 2);


  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output);
    console.log(`\n💾 Saved to: ${outputPath}`);
  }

  console.log('');
  console.log(output);
  printSubmissionSummary(result.submissionCandidates || []);

  try {
    const reportPaths = await generateTradeReports(result, options.output || DEFAULT_OUTPUT, {
      csvPath: options.outputCSV,
      htmlJsonPath: options.outputReportJson,
      htmlPath: options.outputHTML,
    });
    if (reportPaths.csv) {
      console.log(`\n📊 CSV comparison: ${reportPaths.csv}`);
    }
    if (reportPaths.html) {
      console.log(`📈 HTML report:    ${reportPaths.html}`);
    }
    if (reportPaths.htmlJson) {
      console.log(`📋 Report data:    ${reportPaths.htmlJson}`);
    }
  } catch (reportErr) {
    console.warn('[tradeReportGenerator] Report generation failed:', reportErr.message);
  }

  if (result.profitableRouteCount > 0) {
    console.log('\nTop routes:');
    for (const [index, route] of result.topRoutes.slice(0, 5).entries()) {
      console.log(`  ${index + 1}. ${route.profitBps} bps | ${route.routePathSymbols || route.routePath}`);
    }
  } else {
    console.log('\nNo profitable simulated routes found in the scanned set.');
  }
}

module.exports = {
  parseArgs,
  loadPools,
  runEngine,
  simulateRoutes,
  resolveTradeSizeAmounts,
  computeTickDepthAtCurrent,
  applyTickDepthFilter,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error.stack || error.message);
    process.exit(1);
  });
}
/*
Canonical numbered runtime sequence:

node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json
node utilities/divergenceScanner.js --in 01_meta.json --out 02_filtered.json
node engine/Q_enrichment.js --in 02_filtered.json --out 03_enriched.json
node engine/myEngine.js --in 03_enriched.json --out 04_runtimeResults.json --csv 05_result_compare.csv --json 06_result_data.json --html 07_result_report.html
*/
