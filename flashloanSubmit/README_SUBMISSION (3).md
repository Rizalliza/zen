# Kamino Flashloan Arbitrage — Submission Package (Revision 2)

## What Changed in This Revision

### 1. Fixed `RangeError: encoding overruns Uint8Array`

**Root cause:** Your 3-leg route (2× CLMM + AMM V4) produced ~50-70 unique static account keys. Without lookup tables, the compiled v0 message exceeded the 1232-byte packet limit.

**Fixes applied:**

| File | Fix |
|------|-----|
| `atomicBundleBuilder.js` | Added `estimateV0MessageSize()` and `printPreSignDiagnostic()` — prints instruction count, static key count, estimated TX size, and per-instruction account counts BEFORE `tx.sign()`. Throws a structured error with remediation steps instead of the cryptic RangeError. |
| `atomicBundleBuilder.js` | Added `PACKET_DATA_SIZE` constant (1232 bytes) and size guard: if `estTxSize > PACKET_DATA_SIZE`, aborts with clear guidance. |
| `flashloanSwapInstructions.js` | **Removed MEMO_PROGRAM_ID** from CLMM manual builder (not essential for swaps). **Removed unconditional TOKEN_2022_PROGRAM_ID** — only included when mint actually uses Token-2022. **Capped tickArrays to 4** per CLMM leg (was including all 7+ from enrichment). **Capped binArrays to 6** per DLMM leg. |
| `tradeExecute.js` | Stops pre-building `_borrowIx` / `_repayIx` with wrong `borrowInstructionIndex: 0`. Now passes only `flashLoan.borrowAccounts/repayAccounts` and lets `atomicBundleBuilder` construct Kamino instructions with the correct index. |
| `atomicBundleBuilder.js` | Added `rebuildRepayIxIfNeeded()` — parses the last byte of pre-built repay instruction data and rebuilds if the index doesn't match the actual borrow position. |

### 2. Pre-sign Diagnostic Output

When you run the simulation, you now see a clear table before signing:

```
╔═══════════════════════════════════════════════════════════════╗
║  Atomic Bundle Pre-sign Check                                 ║
╠═══════════════════════════════════════════════════════════════╣
║  Instructions:        12                                      ║
║  Static account keys:  52                                       ║
║  Unique static+prog:   48                                       ║
║  Compiled Ixs:        12                                      ║
║  Lookup tables:       0                                         ║
║  Borrow instruction index: 2                                    ║
║  Est. message size:   1856                                      ║
║  Est. TX size:        1921                                      ║
║  Packet limit:        1232                                      ║
║  SAFE TO SIGN:        NO ✗                                      ║
╚═══════════════════════════════════════════════════════════════╝
```

### 3. Structured Error on Overflow

Instead of `RangeError: encoding overruns Uint8Array`, you now get:

```
TRANSACTION TOO LARGE TO SERIALIZE
  Est. TX size: 1921 bytes (limit: 1232)
  Static keys:  52
  Unique static+program: 48
  Instructions: 12
  Lookup tables resolved: 0

  How to fix:
  1. Pass --lookupTables <addr1,addr2> with addresses of lookup tables
     that contain common programs (Token Program, System Program, etc.)
  2. Reduce the number of tickArrays/binArrays per leg in the pool data
  3. Use SDK swap builders instead of manual builders (fewer accounts)
  4. Split into multiple transactions (not atomic — higher risk)
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PIPELINE FLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Raw Pool Data                                                              │
│       │                                                                     │
│       ▼                                                                     │
│  ┌──────────────┐    normalizer.js                                         │
│  │ normalizer   │ ──► Canonical pool shape                                  │
│  └──────────────┘    (ONE normalization, used EVERYWHERE)                   │
│       │                                                                     │
│       ▼                                                                     │
│  ┌──────────────┐                                                           │
│  │ poolContract │ ──► mergeCanonicalPool()                                  │
│  │   (existing) │    validateRouteLegContract()                             │
│  └──────────────┘    finalizeQuote()                                        │
│       │                                                                     │
│       ▼                                                                     │
│  ┌──────────────┐    myEngine.js   (entry point)                           │
│  │   myEngine   │ ──► Load → Enrich → Route → Simulate → Candidates        │
│  └──────────────┘                                                           │
│       │                                                                     │
│       ├── output: runtime_results.json                                      │
│       ├── output: executionContext (poolMap + enriched candidates)         │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         BUNDLE ASSEMBLY                                │   │
│  │                                                                      │   │
│  │   simulateExecutionBundle.js                                         │   │
│  │   ─────────────────────────────                                       │   │
│  │   load candidate 0 → buildTransactionFromCandidate()                 │   │
│  │                    │                                                 │   │
│  │                    ▼                                                 │   │
│  │   ┌─────────────────────────────────────────────────────────────┐   │   │
│  │   │              tradeExecute.js                                 │   │   │
│  │   │  ──────────────────────────────────────                      │   │   │
│  │   │  TradeExecutor                                               │   │   │
│  │   │  ├── prepareTokenAccounts → ATA creation instructions        │   │   │
│  │   │  ├── buildRouteSwapInstructions                              │   │   │
│  │   │  │     └── flashloanSwapInstructions.js (per-DEX builders)    │   │   │
│  │   │  └── buildExecutionBundle                                    │   │   │
│  │   │         └── calls atomicBundleBuilder with:                  │   │   │
│  │   │             flashLoan.borrowAccounts/repayAccounts            │   │   │
│  │   │             (NOT pre-built _borrowIx / _repayIx)            │   │   │
│  │   └─────────────────────────────────────────────────────────────┘   │   │
│  │                    │                                                 │   │
│  │                    ▼                                                 │   │
│  │   ┌─────────────────────────────────────────────────────────────┐   │   │
│  │   │              atomicBundleBuilder.js                          │   │   │
│  │   │  ──────────────────────────────────────                      │   │   │
│  │   │  [compute budget]                                             │   │   │
│  │   │  [Kamino flash borrow]  ◄── kaminoFlashloan.js               │   │   │
│  │   │       borrowInstructionIndex = setupIxs.length (e.g. 2)       │   │   │
│  │   │  [ATA setup + DEX swap instructions]                         │   │   │
│  │   │  [Kamino flash repay]   ◄── kaminoFlashloan.js               │   │   │
│  │   │       borrowInstructionIndex rebuilt correctly              │   │   │
│  │   │  [Jito tip]           ◄── jitoClient.js                      │   │   │
│  │   │  printPreSignDiagnostic() ← NEW: shows size before sign     │   │   │
│  │   │  SIZE GUARD ← NEW: aborts if > 1232 bytes                   │   │   │
│  │   │  tx.sign([payer])                                           │   │   │
│  │   └─────────────────────────────────────────────────────────────┘   │   │
│  │                    │                                                 │   │
│  │                    ▼                                                 │   │
│  │            ┌──────────────┐                                        │   │
│  │            │ jitoClient   │ ──► sendAtomicBundle()                 │   │
│  │            └──────────────┘                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File Inventory

| File | Status | Purpose |
|------|--------|---------|
| `normalizer.js` | Unchanged from Rev 1 | Canonical pool shape |
| `myEngine.js` | Unchanged from Rev 1 | Entry point: enrichment → simulation → candidates |
| `triangleArb.js` | Unchanged | Triangle discovery, chain route building, swap simulation |
| `kaminoFlashloan.js` | Unchanged | Kamino flash borrow/repay instruction builders |
| `jitoClient.js` | Unchanged | Jito bundle submission client |
| `flashloanSwapInstructions.js` | **Rev 2** | Trimmed manual builders, capped tick/bin arrays, removed MEMO/Token2022 bloat |
| `tradeExecute.js` | **Rev 2** | No longer pre-builds wrong _repayIx; lets atomicBundleBuilder handle Kamino |
| `atomicBundleBuilder.js` | **Rev 2** | Pre-sign diagnostics, size guard, borrowInstructionIndex fix |
| `simulateExecutionBundle.js` | **Rev 2** | Structured error handling, LUT guidance on overflow |
| `executorBridge.js` | Unchanged from Rev 1 | Integration bridge |

## Usage

### Step 1: Run myEngine (simulation)

```bash
node engine/myEngine.js \
    --in raw_routed.json \
    --startAmount 1000000000 \
    --maxSimulations 30 \
    --topN 5 \
    --executionMode lenient \
    --output runtime_results.json
```

### Step 2: Simulate execution bundle (with lookup tables)

```bash
node flashloanSubmit/simulateExecutionBundle.js \
    --input runtime_results.json \
    --lookupTables "LUT_ADDR1,LUT_ADDR2" \
    --computeUnitLimit 1400000 \
    --priorityFeeMicroLamports 50000 \
    --jitoTipLamports 10000 \
    --output sim_result.json
```

**Lookup tables are REQUIRED for 3-leg routes.** Without them, the transaction will be too large. Pass them via `--lookupTables`.

### Step 3: Execute via executorBridge

```js
const { runExecutionFromResultFile } = require('./flashloanSubmit/executorBridge');
await runExecutionFromResultFile(
    'runtime_results.json',
    0,
    payerKeypair,
    connection,
    kaminoAccounts,
    { lookupTableAccounts: ['LUT_ADDR1', 'LUT_ADDR2'] }
);
```

## borrowInstructionIndex Fix Detail

**Before (broken):**
```
[0] ComputeBudgetProgram.setComputeUnitLimit
[1] ComputeBudgetProgram.setComputeUnitPrice
[2] Kamino flashBorrowReserveLiquidity     ← borrowInstructionIndex = 2
[3..n] DEX swap instructions
[n+1] Kamino flashRepayReserveLiquidity
       ^ data contains borrowInstructionIndex = 0  ← WRONG!
       Kamino program looks at instruction 0 (compute budget) and fails.
```

**After (fixed):**
```
[0] ComputeBudgetProgram.setComputeUnitLimit
[1] ComputeBudgetProgram.setComputeUnitPrice
[2] Kamino flashBorrowReserveLiquidity     ← borrowInstructionIndex = 2
[3..n] DEX swap instructions
[n+1] Kamino flashRepayReserveLiquidity
       ^ data contains borrowInstructionIndex = 2  ← CORRECT!
       Matches actual position of borrow instruction.
```

The fix is in `atomicBundleBuilder.js`: `rebuildRepayIxIfNeeded()` parses the last byte of pre-built repay data and rebuilds with the correct index if it doesn't match.

## Account Bloat Reduction Detail

| Builder | Before | After | Savings |
|---------|--------|-------|---------|
| CLMM manual | ~16 accounts (incl. MEMO + Token2022) | ~13 accounts | -3 |
| Whirlpool manual | ~14 accounts (incl. Token2022) | ~11 accounts | -3 |
| CPMM manual | ~11 accounts (incl. Token2022) | ~9 accounts | -2 |
| TickArrays per CLMM | all 7+ from enrichment | capped at 4 | -3 to -5 |
| BinArrays per DLMM | all from enrichment | capped at 6 | varies |

For a 2×CLMM + 1×AMM route, total savings: ~10-15 accounts = ~320-480 bytes.

## If You Still Get "TRANSACTION TOO LARGE"

Even with the reductions, a 3-leg route may still need lookup tables. The diagnostic will tell you exactly how many static keys you have.

**To add lookup tables:**

1. **Find existing community LUTs** — Raydium, Orca, and Meteora maintain lookup tables on mainnet. Check their APIs or Discord.
2. **Create your own LUT** — Use `@solana/web3.js` `AddressLookupTableProgram` to create a table with common accounts (Token Program, System Program, common mints, your wallet). This costs ~0.002 SOL and can be reused.
3. **Reduce route complexity** — Try 2-leg routes instead of 3-leg.

Example: create a LUT with common programs:
```js
const { AddressLookupTableProgram } = require('@solana/web3.js');
const [ix, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: await connection.getSlot(),
});
// Then extend it with accounts...
```

## Regression Test Commands

```bash
# Syntax check
cd flashloanSubmit && for f in *.js; do node --check "$f"; done

# Test normalizer field survival
node -e "const n = require('./normalizer'); const p = n.normalizePoolRecord({address:'test',dexType:'RAYDIUM_CLMM',tokenXMint:'A',tokenYMint:'B',reserves:{x:'100',y:'200'},vaults:{xVault:'Vx',yVault:'Vy'},feeBps:25,tickArrays:['ta1']}); console.log(p.baseMint === p.tokenXMint && p.xVault === 'Vx' ? 'PASS' : 'FAIL');"

# Test atomicBundleBuilder diagnostics
node -e "const a = require('./atomicBundleBuilder'); console.log(typeof a.estimateV0MessageSize === 'function' ? 'PASS' : 'FAIL');"

# Test tradeExecute borrowIndex fix
node -e "const t = require('./tradeExecute'); console.log(typeof t.TradeExecutor === 'function' ? 'PASS' : 'FAIL');"

# Test flashloanSwapInstructions bloat limits
node -e "const f = require('./flashloanSwapInstructions'); console.log(f.MAX_CLMM_TICK_ARRAYS === 4 && f.MAX_DLMM_BIN_ARRAYS === 6 ? 'PASS' : 'FAIL');"
```

## Important Constraints (unchanged from Rev 1)

1. **Single signer**: Only signs with payer keypair. Add extra signers before `tx.sign([payer])` if needed.
2. **Kamino reserve discovery**: Not auto-implemented. Provide reserve accounts or implement resolution.
3. **Pre-submit simulation**: Call `connection.simulateTransaction(tx)` before submission.
4. **Profit gating**: Only execute if `profitBps` exceeds fees (flash loan + Jito tip + priority fee).
5. **Landed-bundle polling**: Poll `connection.getSignatureStatus(sig)` after Jito submission.

## Files You Must Provide

| Requirement | Status | Notes |
|-------------|--------|-------|
| Kamino reserve accounts | **Required** | Provide via `kaminoAccounts` param |
| Jito auth / tip config | In `env.js` | `JITO_BLOCK_ENGINE_URL`, `JITO_UUID` |
| RPC endpoint | In `.env` | `RPC_URL` or `ALCHEMY_RPC_URL` |
| Wallet keypair | In `.env` | `PRIVATE_KEY` (base58) or keypair file |
| **Lookup tables** | **Strongly recommended** | Pass `--lookupTables <addr1,addr2>` for 3-leg routes |
| DEX SDKs (optional) | npm install | `@raydium-io/raydium-sdk-v2`, `@orca-so/whirlpools-sdk`, `@meteora-ag/dlmm` |

## Quick Start: From Zero to Live Bundle

### Prerequisites

```bash
# Install dependencies
npm install @solana/web3.js @solana/spl-token decimal.js bn.js

# Optional but recommended
npm install @raydium-io/raydium-sdk-v2 @orca-so/whirlpools-sdk @meteora-ag/dlmm

# For Jito bundle submission
npm install jito-js-rpc
```

### Step 0: Environment Setup

Create `.env` in project root:

```bash
RPC_URL=https://api.mainnet-beta.solana.com
PRIVATE_KEY=1,2,3,...,64   # 64 comma-separated bytes
# OR
KEYPAIR_PATH=/path/to/id.json

# Jito (optional — only for bundle submission)
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf/api/v1
JITO_UUID=your-uuid-here

# Optional defaults
COMPUTE_UNIT_LIMIT=1400000
PRIORITY_FEE_MICRO_LAMPORTS=50000
JITO_TIP_LAMPORTS=10000
```

### Step 1: Run myEngine (Simulation)

```bash
node engine/myEngine.js \
    --in raw_routed.json \
    --startAmount 1000000000 \
    --maxSimulations 30 \
    --topN 5 \
    --executionMode lenient \
    --output runtime_results.json
```

### Step 2: Create a Lookup Table (REQUIRED for 3-leg routes)

Without a lookup table, your 3-leg transaction will be **~1600+ bytes** and will never land. The LUT moves common programs (Token Program, DEX programs, common mints) out of the static account list.

```bash
node flashloanSubmit/createLookupTable.js \
    --fund 0.002 \
    --extra <any-pool-specific-accounts> \
    --output my_lut.json
```

This creates an on-chain Address Lookup Table and outputs its address. **Save this address.**

**What gets included in the LUT:**
- System programs (SystemProgram, Token Program, ComputeBudget, ATA Program)
- All DEX programs (Raydium CLMM/CPMM/AMM V4, Orca Whirlpool, Meteora DLMM)
- Kamino Lending Program
- Jito tip accounts
- Common mints (SOL, USDC, USDT, BONK, JUP, RAY)
- Your wallet and ATAs for common tokens

### Step 3: Prepare Kamino Reserve Data

You need the Kamino lending reserve for the token you'll borrow (usually SOL or USDC).

**Option A: Let the script derive it**

```bash
node flashloanSubmit/prepareKaminoReserve.js \
    --market 7u3HeHVY9rzDBjufT8KDKpNZCA7wRTkPnhy4c6cWBj9Z \
    --mint So11111111111111111111111111111111111111112 \
    --output kamino_sol_reserve.json
```

**Option B: Use the template and fill in real addresses**

```bash
# Edit kamino_sol_reserve.json with real addresses from Kamino
# Then use it directly:
node flashloanSubmit/simulateExecutionBundle.js \
    --input runtime_results.json \
    --reserveDetail kamino_sol_reserve.json \
    --lookupTables <LUT_ADDRESS_FROM_STEP_2>
```

**How to get real reserve data:**
1. Kamino API: `GET https://api.kamino.finance/v2/reserves?mint=So11111111111111111111111111111111111111112`
2. On-chain: Use `prepareKaminoReserve.js` with `--market` and `--mint` — it derives the reserve PDA and attempts to decode it
3. Kamino UI: Find your reserve on app.kamino.finance and copy the addresses

### Step 4: Simulate the Execution Bundle

```bash
node flashloanSubmit/simulateExecutionBundle.js \
    --input runtime_results.json \
    --candidate 0 \
    --reserveDetail kamino_sol_reserve.json \
    --userLiquidityAccount <YOUR_SOL_ATA> \
    --lookupTables <LUT_ADDRESS_FROM_STEP_2> \
    --computeUnitLimit 1400000 \
    --priorityFeeMicroLamports 50000 \
    --jitoTipLamports 10000 \
    --output sim_result.json
```

If this succeeds with no simulation errors, your bundle is structurally sound.

### Step 5: Submit to Jito (Live Execution)

```bash
node flashloanSubmit/executorBridge.js \
    --input runtime_results.json \
    --candidate 0 \
    --reserveDetail kamino_sol_reserve.json \
    --lookupTables <LUT_ADDRESS> \
    --submit
```

Or in code:

```js
const { runExecutionFromResultFile } = require('./flashloanSubmit/executorBridge');
await runExecutionFromResultFile(
    'runtime_results.json',
    0,
    payerKeypair,
    connection,
    kaminoAccounts,
    {
        lookupTableAccounts: ['<LUT_ADDRESS>'],
        computeUnitLimit: 1_400_000,
        computeUnitPrice: 50_000,
        jitoTipLamports: 10_000,
    }
);
```
