Solana Arbitrage in a Low-Latency Environment
Executive summary
For a competitive Solana arbitrage bot, the core design principle is this: rank routes by executable net edge, not by raw price divergence. Your current scripts already contain several good ideas for candidate generation—turnover-to-liquidity, pair multiplicity, fee-tier diversity, pool exclusion lists, symbol normalization, and a preference for homogeneous price-source subsets—but the runtime artifact shows the present pipeline still collapses at the execution gate, with no route surviving to profitability. That strongly suggests the next bottleneck is not “finding more pools,” but turning candidate spreads into slot-aware, executable, fee-adjusted, landing-aware decisions. 
 
 

The most important tactical shift is to move to a two-stage pool model. Stage one is cheap discovery: use metadata such as TVL, fee tier, pair multiplicity, venue diversity, and recent activity to keep your search space manageable. Stage two is expensive but decisive: for each candidate, fetch fresh account state, reconstruct amount-specific depth, simulate the exact transaction shape, and compute a per-route score such as
net_edge_bps = gross_edge_bps - swap_fees_bps - price_impact_bps - priority_fee_bps - relay_tip_bps - expected_latency_drift_bps - failure_cost_bps.
On Solana, this matters because transactions compete on prioritization fees, requested compute units, transaction size, account locks, and relay path; there is no public mempool where you can leisurely inspect pending trades. Transactions are routed to leaders, and execution quality depends heavily on how quickly and privately you can observe state, build, simulate, and deliver the transaction to the current or next leaders. 

Your data plane should therefore be built around dedicated/private RPC plus low-latency streaming, not public endpoints. At minimum, use native RPC with getMultipleAccounts, selective getProgramAccounts filters, and WebSocket subscriptions; for serious competition, add Yellowstone/Geyser-style streams and, where justified, shred-level feeds. Official and provider docs now make this stack fairly clear: Solana RPC offers HTTP and WebSocket methods for state reads and subscriptions; Geyser exists specifically to avoid heavy RPC nodes falling behind under load; commercial low-latency offerings expose Yellowstone or shred streams for faster read paths; and relay networks such as Jito and validator SWQoS paths exist for faster write paths. 

For execution, the practical Solana analogue to “Flashbots-like” infrastructure is Jito bundles and validator-directed low-latency senders, with the important caveat that Solana’s architecture differs from Ethereum’s. Jito’s Block Engine supports single-transaction fast sends and atomic bundles of up to five transactions; bundles are executed sequentially and atomically within one slot, and Jito exposes explicit sandwich-mitigation behavior via jitodontfront, plus regional endpoints and tip data streams. Helius Sender and Triton’s Cascade expose other low-latency write paths, including dual routing and stake-weighted QoS lanes. In a production arb stack, these should be treated as parallel delivery channels, not mutually exclusive choices. 

The best medium-term engineering path is a Rust hot path with JS/TS as control plane. Solana programs themselves are stateless sBPF programs and are primarily developed in Rust; CPIs, PDA signing, and extra instruction indirection all consume compute and can reduce landing odds if overused. For off-chain execution, Rust is the better fit for the latency-critical quote/sim/send loop, while JS/TS remains excellent for research, orchestration, and dashboards—especially given the strong TS SDK surfaces from major venues. 

The final strategic conclusion is straightforward: if the goal is a serious arbitrage engine rather than a retail swap tool, then you should keep Jupiter-style aggregator infrastructure as a venue and fall-back path, but own the arb decisioning, route simulation, fee/tip policy, and transaction submission stack yourself. Jupiter’s own docs are explicit that Ultra is the managed execution engine, while Metis/Router is the path for teams that need CPI, custom instructions, and full infrastructure control; that is much closer to your use case. 

Assessment of your current approach
The uploaded scripts suggest a sensible research-stage architecture. poolFetchCustom_raw.js appears to rank candidates using weighted components such as liquidity, turnover-to-liquidity, token-pair multiplicity, fee-tier diversity, and pool-count per pair, while also normalizing token symbols and maintaining explicit pool exclusions. divergenceScanner.js then tries to compare “comparable” pools, prefers the largest homogeneous subset by price source, and finally evaluates route-level economics. Those are strong instincts because they reduce obvious junk pools and avoid comparing incompatible price feeds. 
 

The runtime result is the more revealing artifact. It shows a meaningful filter cascade—candidate generation, heterogeneity checks, comparable-pair selection, route simulation, and route gating—but the process ends with zero profitable execution-eligible routes. The right interpretation is not “the scanner is wrong,” but “the scanner is still too upstream from the actual source of PnL.” In other words, your model is probably good enough to identify potential spread zones, but not yet good enough to estimate landable edge after fees, impact, latency drift, and ordering competition. 

That points to three immediate design upgrades. First, score pools by executable depth at your intended trade sizes, not just TVL or current price. Second, replace raw cross-venue price comparison with same-slot, same-notional quote reconstruction using venue-specific account state. Third, carry execution costs all the way back into the pool-selection layer so that “good” pools are defined by realized route economics rather than surface divergence. Official venue docs consistently support this approach: Orca and Raydium both require fresh tick arrays / computed pool info for valid swap computation, and Jupiter’s router docs explicitly recommend simulating your final transaction to derive the actual compute budget. 

Pool selection and pricing model
A production pool-selection model on Solana should be amount-aware, venue-aware, and time-aware. TVL and volume are still useful, but they are only proxies for what matters: whether a route can absorb your target notional with acceptable slippage and low failure risk at the moment you need to send. Concentrated-liquidity venues make this especially important because the usable depth can change materially as the active tick/bin shifts. Orca requires fresh tick arrays for quote generation, Raydium’s CLMM flow requires fresh compute info plus tick arrays before computing an output amount, and Meteora’s DLMM liquidity is organized into discrete bins where the active bin and bin step materially shape near-touch execution cost. 

I recommend scoring each venue-pool pair with the following explicit metrics:

Executable depth by notional bucket: estimate output and impact for several canonical sizes, such as 500 USD, 2,000 USD, 10,000 USD, and your current max bankroll slice. This is the single most important metric. For concentrated or bin-based AMMs, compute it from fresh tick/bin state, not from API summary fields. 
Swap-fee load: include explicit LP fee tiers and venue-specific routing fee behavior. Raydium supports multiple pool types and fee tiers; Meteora DLMM also varies fee behavior with volatility. 
Price impact curve: store impact as a curve over size, not a single number. Jupiter quotes expose priceImpactPct, but for venue-native arbitrage you should recompute impact from the underlying pool state so you are not hostage to an aggregator abstraction. 
Quote freshness / state age: penalize pools whose decoded state is older than your target slot window or whose stream has recently gapped. Solana’s WebSocket and Geyser-style streams exist for exactly this reason. 
Token-pair correlation and basis half-life: compute rolling correlation of mid-price returns across venues and a mean-reversion half-life for the cross-venue spread. Highly correlated, liquid, lower-volatility pairs are better for repeatable basis capture; weakly correlated meme pairs may show high divergence but often monetize badly after latency and adverse selection. This is an inference from market microstructure rather than a network rule, but it aligns with recent Solana MEV research showing that high-slippage, illiquid markets are much more exposed to toxic flow. 
Execution complexity score: count writable accounts, total accounts, expected compute units, and required address lookup tables. On Solana, larger and more lock-heavy transactions are harder to land cheaply. Priority fees are based on requested compute units, not actual usage, so overbudgeting directly eats edge. 
Historical landing quality: track venue- and route-specific fill rate, median slots-to-land, and post-simulation failure rate. This should feed directly back into route scoring. Solana send semantics explicitly do not guarantee processing just because the RPC accepted the transaction. 
A practical scoring function for your setup is:

text
Copy
net_score =
  gross_edge_bps
  - lp_fee_bps
  - modeled_price_impact_bps
  - requested_cu_fee_bps
  - relay_tip_bps
  - expected_latency_drift_bps
  - expected_fail_cost_bps
  - inventory_carry_bps
The important change from your current approach is that liquidity, turnover, and fee diversity become priors, while gross_edge_bps and the cost terms are computed from executable quotes and simulations. That preserves the spirit of your pool-selection script while making the ranking economically faithful. 
 
 
Solana Explorer, Solscan, SolanaFM	Debugging, forensic review, transaction inspection	Useful human-readable post-trade visibility	Too slow and indirect for the hot path	Explorer pages 

The simplest high-confidence recommendation is: authoritative reads from dedicated RPC + streamed state, venue-native quote reconstruction for candidate confirmation, and at least two private/low-latency write paths for submission. That stack gives you redundancy without outsourcing your core arbitrage logic. 

Latency, execution, and MEV defense
Solana’s execution environment rewards state freshness and write-path quality more than clever retry loops. There is no protocol-level public mempool; transactions are routed to leaders either via RPC or more directly to validator interfaces. That means the “sequencer selection” problem on Solana is really a leader/validator path-selection problem: you optimize around current and upcoming leaders, regionally close relays, and stake-weighted QoS lanes, not around a single public sequencer queue. Official RPC methods expose leader schedules and slot leaders, while provider docs show how low-latency stacks exploit validator adjacency and SWQoS. 

Three concrete execution rules follow from the docs:

Batch reads, stream deltas: use getMultipleAccounts and filtered getProgramAccounts for cold starts; then rely on WebSocket or Yellowstone/Geyser updates for hot state. 
Simulate your exact transaction shape, then send with minimal latency: Solana’s own production guidance shows maxRetries: 0 and skipPreflight: true as the low-latency production pattern after you have already validated the transaction, and Jito’s low-latency send path always skips preflight. 
Request tight compute budgets: priority fees depend on the requested compute-unit limit, not the units actually consumed. Jupiter’s router docs recommend simulating the final transaction and then setting the limit to roughly 1.2× actual CU, capped by protocol maximums. 
Transaction parallelization also matters. The runtime can execute transactions in parallel when their account access patterns do not conflict, but writable-account overlaps serialize execution. Jito’s bundle auction similarly groups bundles by intersecting lock patterns. In practice, that means you should prefer routes and bundle shapes that minimize hot writable overlaps, keep account lists short, and avoid unnecessary CPIs or sidecar instructions in the hot path. 

For front-running and sandwich defense, the highest-confidence toolkit today is: private submission, atomic ordering, tight slippage, and explicit relay-level mitigation. Jito’s jitodontfront mechanism rejects bundles unless the protected transaction is positioned first; bundle ordering is atomic and sequential; Jito also warns that standalone tip transactions can be vulnerable and that ALTs should not be used for tip accounts. Recent public research also suggests that sandwich activity on Solana has adapted away from older public-mempool patterns, which is exactly why private delivery and route-level value protection matter. 

Sample low-latency architecture
Observability

Delivery

Execution

Strategy

MarketData

Dedicated RPC

WebSocket subscriptions

Yellowstone/Geyser stream

Shred feed optional

Pool metadata cache

Executable depth engine

Route scorer

Risk engine

Tx builder

Local simulation

Fee and tip policy

Signer service

Jito bundle/send path

Low-latency sender path

Fallback RPC send path

Metrics and logs

Alerting

Backtest and replay store



Show code
This layout separates discovery, executable pricing, transaction construction, and delivery so that you can improve each independently. It also enforces an important production habit: the read path and the send path should be independently redundant. 


Implementation checklist and reference patterns
Prioritized checklist of discrete tactics
Promote executable-depth scoring to the top of the ranking stack. Keep your current turnover/liquidity heuristics only for coarse pruning; finalize route choice from fresh amount-specific quotes and simulations. 
 
Replace single-price divergence with same-slot, same-notional venue-native quote reconstruction using fresh tick/bin state. 
Run a dedicated/private RPC plus streamed state; do not use shared public RPC in production. 
Use getMultipleAccounts / filtered getProgramAccounts for cold loads, then switch to streams for hot state. 
Track current and next leaders and bias submission toward regionally close relays / SWQoS paths. 
Simulate the exact final transaction shape, estimate actual compute, then request only a modest margin above it. 
Send through at least two write paths in parallel: a private/relay path and a fallback low-latency RPC path. 
Use atomic bundles when the strategy requires multi-tx ordering guarantees. 
Add jitodontfront protection where compatible, especially for user-like or vulnerable swap legs. 
Model tip policy separately from priority-fee policy; on Jito, the optimal mix depends on whether you use single send or bundles. 
Log route-level failure-cost bps and feed it back into the scorer. The route that lands more often is often the truly profitable one. 
Enforce per-token, per-venue, and per-route capital caps so a bad fill or stuck inventory episode cannot consume treasury.
Move the hot path to Rust if latency becomes your limiting factor; keep JS/TS for research, orchestration, and UI. This is a strategic recommendation supported by Solana’s Rust-first program model and the availability of Rust venue SDKs. 
If you build any on-chain helper program, keep it tiny: stateless checks, PDA auth, and minimal CPI. Avoid turning the whole strategy into an on-chain router. 
Continuously audit for toxic flow and sandwich patterns using your own logs plus public MEV datasets. 
Pool-selection pseudocode
ts
Copy
type VenueQuote = {
  venue: string
  pool: string
  inAmount: bigint
  outAmount: bigint
  feeBps: number
  impactBps: number
  cuEstimate: number
  writableAccounts: number
  stateSlot: number
  landingFailRate: number
}

function netEdgeBps(
  grossEdgeBps: number,
  q: VenueQuote,
  priorityFeeBps: number,
  relayTipBps: number,
  latencyDriftBps: number,
) {
  const failureCostBps = grossEdgeBps * q.landingFailRate
  return grossEdgeBps
    - q.feeBps
    - q.impactBps
    - priorityFeeBps
    - relayTipBps
    - latencyDriftBps
    - failureCostBps
}

async function rankArbCandidates(candidates, notionalBuckets) {
  const results = []

  for (const c of candidates) {
    // Stage one: cheap filters from your existing metadata model
    if (c.excluded || c.turnoverToLiquidity < MIN_TURNOVER || c.venueDiversity < 2) continue

    // Stage two: amount-aware venue-native quotes from fresh state
    for (const size of notionalBuckets) {
      const legA = await quoteVenueNative(c.buyVenue, c.buyPool, size)
      const legB = await quoteVenueNative(c.sellVenue, c.sellPool, legA.outAmount)

      if (!sameSlotWindow(legA.stateSlot, legB.stateSlot, 1)) continue

      const grossEdge = calcGrossEdgeBps(size, legB.outAmount)
      const prioBps = priorityFeeModel(legA.cuEstimate + legB.cuEstimate)
      const tipBps = relayTipModel(c.venuePair, size)
      const driftBps = latencyDriftModel(c.tokenPair, c.venuePair)

      const score =
        netEdgeBps(grossEdge, legA, prioBps, tipBps, driftBps) +
        netEdgeBps(0, legB, prioBps, tipBps, driftBps)

      if (score > MIN_NET_BPS && exposureAllowed(c.tokenPair, size)) {
        results.push({ candidate: c, size, score, legA, legB })
      }
    }
  }

  return results.sort((a, b) => b.score - a.score)
}
This pattern keeps your current metadata ranking but forces every final decision through executable quotes, fresh slot checks, and cost modeling. It is the natural extension of what your scripts already started. 
 
 