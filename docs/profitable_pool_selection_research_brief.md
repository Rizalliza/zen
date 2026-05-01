# Profitable Pool Selection Research Brief

## Purpose

This brief frames the research needed to improve profitable route discovery for our Solana arbitrage bot. The main constraint is not only finding theoretical divergence, but finding a route that remains executable after enrichment, simulation, fee/tip gates, transaction construction, and submission inside a very short market window.

## Working Scenario

A profitable pool selection should work like this:

1. Fetch a broad pool universe from DEX APIs.
2. Normalize every pool into the same canonical shape.
3. Keep only pools that have a reason to move: high turnover, enough TVL, multiple peers on the same pair, usable price fields, and non-toxic history.
4. Detect pair-level divergence only when price units are comparable.
5. Enrich only the short hot list, not the entire broad universe.
6. Build 3-leg routes from enriched pools.
7. Simulate each route across trade sizes, for example `0.1 / 0.5 / 1 / 5 SOL`.
8. Select only routes where net edge survives fees, price impact, priority fee, Jito tip, stale quote haircut, and execution risk.
9. Revalidate the chosen route immediately before submission.
10. Submit through the fastest available path with correct compute budget, priority fee, and Jito tip.

The practical goal is not "highest displayed divergence." The goal is "highest executable net profit per unit of time."

## Current Pipeline

Current intended file sequence:

```bash
node utilities/poolFetchCustom_raw.js --out 01_meta.json --raw 00_raw.json
node utilities/divergenceScanner.js --in 01_meta.json --out 02_filtered.json
node engine/Q_enrichment.js --in 02_filtered.json --out 03_enriched.json
node engine/myEngine.js --in 03_enriched.json --out 04_runtimeResults.json --csv 05_result_compare.csv --json 06_result_data.json --html 07_result_report.html
```

### `poolFetchCustom_raw.js`

This is the broad candidate discovery layer. It currently focuses on:

- API-level pool discovery.
- Turnover ranking: `volume24h / TVL`.
- TVL and volume floors.
- Pair multiplicity.
- Fee-tier diversity.
- Poison pool exclusion.
- Snapshot `currentPrice`, now normalized as `tokenY_per_tokenX`.
- Rough divergence boost and optional `--min-divergence` prescreen.

This stage should stay cheap. It should not attempt full tick/bin depth validation because raw API payloads usually do not contain enough live state.

### `divergenceScanner.js`

This is the pair divergence annotation layer. It currently:

- Reads through the canonical pool contract.
- Computes pair mid-price from `sqrtPriceX64`, reserves, DLMM bin formula, or `currentPrice`.
- Avoids unsafe cross-source comparisons by using comparable homogeneous subsets.
- Stamps fields like `pairDivergenceBps`, `pairMidDeviationBps`, `pairComparablePeerCount`, and symbols.

This is useful for ranking, but it must not be treated as proof of executability.

### `Q_enrichment.js`

This is the expensive live-state layer. It fills:

- CLMM/Whirlpool tick state.
- DLMM bin state.
- reserves/vaults.
- current tick/bin.
- execution readiness fields.

This is where most latency appears. It should become a rolling state cache, not a full blocking step before every submission attempt.

### `myEngine.js`

This is the route and simulation layer. It now supports:

- Enrichment-first divergence annotation.
- Route scoring by divergence.
- Trade-size sweep.
- Profitability gate using fees, impact, latency slippage, and Jito tip.
- Report outputs.

The next improvement is making route simulation consume fresher cached state and submit only routes that survive a final just-in-time revalidation.

## Key Reality Of The 4-Second Window

The 4-second window should be treated as a soft market-decay window, not the Solana blockhash lifetime. Solana blockhash validity is longer than a few seconds, but arbitrage price edge can disappear in milliseconds. Jito block engine auctions can run at very fine intervals, and profitable bundles compete on tip and compute efficiency.

Research should distinguish:

- **Blockhash validity window:** whether the transaction is still technically valid.
- **Quote freshness window:** whether the pool state still matches the simulated route.
- **Opportunity half-life:** how quickly the edge disappears.
- **Landing window:** whether priority fee/tip/route locks are competitive enough to land before the edge is gone.

## Expert Practice Themes To Research

These are not magic tricks; they are the operational habits that separate profitable searchers from slow scanners.

### 1. Hot Set Maintenance

Do not enrich everything on demand. Maintain a rolling hot set of pools:

- Top pairs by turnover.
- Pairs with repeated measurable divergence.
- Pools with healthy execution history.
- Pools with enough near-tick/bin liquidity.
- Pools with low quote failure rate.

Research questions:

- How many pools can be kept fresh per second with our RPC pool?
- What is the optimal hot-set size for 1, 2, 5, and 10 RPC endpoints?
- Which DEX types consume the most enrichment time?
- Which pools repeatedly produce simulated profit but fail execution gates?

### 2. Tiered Freshness

Not every field needs the same refresh cadence.

Suggested TTL tiers:

- Pool metadata: minutes.
- Token symbols/decimals/program IDs: hours/days.
- API TVL/volume/currentPrice: 5-30 seconds.
- Pool state account: every slot or on subscription.
- Tick/bin neighborhood for hot routes: every slot or just-in-time.
- Final route quote: immediately before transaction build.

Research questions:

- Which fields are static enough to cache permanently?
- Which fields must be refreshed for every route?
- Can tick/bin arrays be incrementally refreshed instead of fully reloaded?

### 3. Divergence Quality, Not Just Divergence Size

Large divergence is often fake when units or orientation are mixed.

Good divergence criteria:

- Same canonical pair.
- At least 2 comparable peers.
- Homogeneous or compatible price source.
- Price source is not stale.
- Both pools are execution-ready.
- Route-level edge survives fees and impact.
- Divergence direction matches the intended leg direction.

Bad divergence signs:

- `currentPrice` compared to raw DLMM bin formula without normalization.
- One pool only.
- Huge 10,000+ bps spreads without matching executable quote.
- Divergence on a low-depth pool near an empty tick.
- Spread exists only at tiny size but route is simulated at 1 SOL or 5 SOL.

### 4. Depth Near Current Price

Pool TVL is not enough for CLMM/Whirlpool. A pool can have high TVL but little liquidity near the current tick.

Research criteria:

- Sum initialized liquidity within `±50` ticks of `tickCurrent`.
- Sum executable bin liquidity around active DLMM bin.
- Compare route input size against near-price depth.
- Penalize pools where quote impact rises sharply between `0.1` and `1.0 SOL`.

Candidate metrics:

- `nearTickLiquidityGross`.
- `nearBinLiquidityX/Y`.
- `inputSize / nearDepth`.
- `impactSlopeBps`: impact change from `0.1 SOL` to `1 SOL`.
- quote failure rate by pool.

### 5. Trade Size Sweep

A route may be unprofitable at `1 SOL` but profitable at `0.1 SOL`. Selection should optimize expected profit, not just bps.

Current method:

- Simulate `0.1 / 0.5 / 1 / 5 SOL`.
- Select the size maximizing `profitBps * sizeSol`.

Research improvements:

- Add adaptive search around the best size.
- Include absolute profit in lamports after fees/tips.
- Track route-specific optimal size over time.
- Penalize routes where profit collapses sharply with size.

### 6. Submission Path And Fee Strategy

Solana priority fees and Jito tips are part of the trade, not afterthoughts.

Research criteria:

- Compute unit limit should be tight. Over-requesting CU can overpay priority fee.
- Priority fee should be estimated from current local congestion.
- Jito tip should be derived from expected profit and current tip market.
- Bundle should include only profitable, atomic, executable instructions.
- Account locks matter: routes touching popular pools compete in the same local auction.

Practical route scoring should include:

```text
expectedNetProfit =
  simulatedProfit
  - baseFee
  - priorityFee
  - jitoTip
  - staleQuoteHaircut
  - failureRiskPenalty
```

## Best Way Forward For Pool Selection

### Stage 1: Cheap Fetch Prescreen

Use `poolFetchCustom_raw.js` to reduce the universe:

- Minimum TVL.
- Minimum volume.
- High turnover.
- Pair multiplicity.
- Fee-tier diversity.
- Snapshot `currentPrice`.
- Rough divergence boost.
- Exclude known toxic pools.

Do not spend RPC here except for very targeted validation.

### Stage 2: Rolling Enrichment Cache

Run enrichment continuously for the hot set:

- Keep `03_enriched.json` or an in-memory equivalent warm.
- Refresh high-priority pools more often.
- Refresh slow or low-value pools less often.
- Track RPC endpoint health and per-pool enrichment time.

This converts enrichment from a blocking step into a background state service.

### Stage 3: Route Candidate Filter

Before simulation, require:

- Three executable legs.
- Every leg has fresh enough state.
- Every CLMM/Whirlpool leg has near-tick depth.
- Every DLMM leg has active-bin neighborhood liquidity.
- Route has at least one meaningful divergence leg.
- Estimated size is within depth tolerance.

### Stage 4: Simulation And Size Sweep

For each route:

- Simulate multiple sizes.
- Keep the best objective.
- Drop routes with negative pre-fee yield.
- Drop routes below required execution edge.
- Record failure reasons per pool.

### Stage 5: Just-In-Time Revalidation

Immediately before submission:

- Refresh only the accounts used by the selected route.
- Requote selected size.
- Recompute required edge including current priority fee and Jito tip.
- Submit only if still profitable.

## Research Topics To Assign

### A. Pool Selection Data Science

- Which pool features predict profitable simulations?
- Which pool features predict failed simulations?
- Which DEX/pair/fee tiers produce repeatable opportunities?
- Does turnover outperform TVL as a predictor?
- What is the right `maxPerPair` and `maxPerDexType`?

### B. Divergence Signal Quality

- Compare `currentPrice`, reserves, sqrt, and bin-derived mids.
- Measure false positives by source type.
- Determine when `currentPrice` can be trusted.
- Build source-specific confidence scores.
- Study divergence persistence over 1, 2, 5, and 10 slots.

### C. Enrichment Latency

- Time enrichment by DEX type.
- Time enrichment by pool account count.
- Identify slow RPC endpoints.
- Test concurrency settings.
- Compare full enrichment vs route-account-only refresh.
- Measure cache hit rate.

### D. Tick/Bin Depth

- Define minimum near-tick liquidity thresholds.
- Define minimum active-bin liquidity thresholds.
- Measure impact slope across trade sizes.
- Identify concentration traps.
- Compare depth filters against actual quote failure/profitability.

### E. Trade Sizing

- Compare fixed `1 SOL` against size sweep.
- Estimate optimal size from liquidity/impact curves.
- Find route-specific best size distribution.
- Track whether smaller profitable routes land more often.

### F. Submission And Landing

- Measure time from quote to signed transaction.
- Measure time from transaction send to landed slot.
- Compare RPC send vs Jito sendTransaction vs Jito bundle.
- Test priority fee and Jito tip strategies.
- Track bundle rejection/landing reasons.

### G. Route Lock Contention

- Identify pools/accounts that are highly contended.
- Measure if high-contention routes need higher tips.
- Prefer routes with less crowded account locks when edge is similar.
- Penalize routes that repeatedly lose in landing despite simulated profit.

## Immediate Improvements To Our Codebase

1. Make `poolFetchCustom_raw.js` output a ranked candidate reason per pool.
2. Keep `currentPriceUnit` and `currentPriceSource` in all outputs.
3. Add `nearTickLiquidity` and `nearBinLiquidity` fields after enrichment.
4. Save per-pool enrichment latency and failure count.
5. Maintain a hot-set cache instead of enriching the full selected set every run.
6. Add final route-only revalidation inside `myEngine` before flashloan submission.
7. Persist simulation outcomes by pool and pair for future selection scoring.
8. Add landing telemetry after submission.

## Proposed Scoring Model

Pool score:

```text
poolScore =
  turnoverScore
  + divergenceConfidenceScore
  + pairMultiplicityScore
  + depthScore
  - feePenalty
  - staleStatePenalty
  - quoteFailurePenalty
  - toxicPoolPenalty
```

Route score:

```text
routeScore =
  bestSizeExpectedProfitLamports
  + divergenceDirectionalEdge
  - totalFeeBps
  - expectedImpactBps
  - priorityFeeBps
  - jitoTipBps
  - staleQuoteHaircutBps
  - landingRiskPenalty
```

## Sources

- Solana fee structure and priority fee model: https://solana.com/docs/core/fees/fee-structure
- Solana transaction structure and recent blockhash behavior: https://solana.com/docs/core/transactions/transaction-structure
- Solana transaction confirmation and expiration guide: https://solana.com/developers/guides/advanced/confirmation
- Jito low-latency transaction and bundle documentation: https://docs.jito.wtf/lowlatencytxnsend/

