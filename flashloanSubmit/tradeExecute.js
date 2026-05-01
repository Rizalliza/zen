'use strict';
/**
 * tradeExecute.js
 *
 * Execution orchestrator for 3-leg flashloan arbitrage.
 *
 * Responsibilities:
 *  1. Load submission candidates from myEngine result files
 *  2. Normalize legs to canonical execution format (aligned with normalizer.js)
 *  3. Build associated token account (ATA) setup instructions
 *  4. Coordinate DEX-specific swap instruction building
 *  5. Assemble Kamino flash-borrow → swaps → flash-repay atomic transaction
 *  6. Wire Jito bundle submission
 *
 * FIX in this revision:
 *   - No longer pre-builds _borrowIx / _repayIx for atomicBundleBuilder.
 *     TradeExecutor now ONLY produces swap + ATA instructions.
 *     atomicBundleBuilder handles all Kamino instruction construction internally,
 *     ensuring the borrowInstructionIndex is always correct.
 *   - This eliminates the borrowInstructionIndex:0 mismatch that silently broke
 *     Kamino repay validation.
 */

const fs = require('fs');
const path = require('path');
const {
    Connection,
    PublicKey,
    TransactionInstruction,
    SystemProgram,
    ComputeBudgetProgram,
    TransactionMessage,
    VersionedTransaction,
} = require('@solana/web3.js');
const BN = require('bn.js');

// Token Program IDs
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/* -------------------------------------------------------------------------- */
/*                             Internal helpers                               */
/* -------------------------------------------------------------------------- */

function normalizeDex(value) {
    const str = String(value || '').toUpperCase();
    if (str.startsWith('METEORA')) return 'meteora';
    if (str.startsWith('RAYDIUM')) return 'raydium';
    if (str.startsWith('ORCA')) return 'orca';
    return String(value || '').toLowerCase();
}

function normalizeType(value) {
    return String(value || '').toLowerCase();
}

function pubkeyOf(v) {
    if (!v) return null;
    if (v instanceof PublicKey) return v;
    try {
        return new PublicKey(v);
    } catch (_e) {
        return null;
    }
}

function toStr(v) {
    if (v === null || v === undefined) return '';
    return String(v);
}

function loadJson(inputPath) {
    const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    return {
        resolved,
        raw: JSON.parse(fs.readFileSync(resolved, 'utf8')),
    };
}

/* -------------------------------------------------------------------------- */
/*                         Submission candidate loader                        */
/* -------------------------------------------------------------------------- */

function extractSubmissionCandidates(raw = {}) {
    if (Array.isArray(raw.submissionCandidates)) return raw.submissionCandidates;
    return [];
}

function selectSubmissionCandidate(raw = {}, index = 0) {
    const candidates = extractSubmissionCandidates(raw);
    if (!candidates[index]) {
        throw new Error(`submissionCandidates[${index}] not found`);
    }
    return candidates[index];
}

function normalizeSubmissionLeg(leg = {}, index = 0) {
    const poolAddress = toStr(leg.poolAddress || leg.address || leg.id || '');
    const dex = normalizeDex(leg.dex || leg.dexType || '');
    const type = normalizeType(leg.type || String(leg.dexType || '').split('_').pop() || '');

    const inputMint = toStr(leg.inputMint || leg.tokenInMint || leg.tokenA || leg.mintA || leg.baseMint || '');
    const outputMint = toStr(leg.outputMint || leg.tokenOutMint || leg.tokenB || leg.mintB || leg.quoteMint || '');

    const amountInAtomic = toStr(
        leg.amountInAtomic || leg.inputAmount || leg.inAmountRaw || leg.amountIn || ''
    );
    const minOutAtomic = toStr(
        leg.minOutAtomic || leg.minOutputAmount || leg.minOutAmountRaw || leg.minOutputAmountRaw || ''
    );
    const expectedOutAtomic = toStr(
        leg.expectedOutAtomic || leg.expectedOutputAmount || leg.outAmountRaw || leg.amountOut || ''
    );

    return {
        legIndex: leg.legIndex || index + 1,
        dex,
        dexType: leg.dexType || dex.toUpperCase() + '_' + type.toUpperCase(),
        type,
        poolAddress,
        inputMint,
        outputMint,
        tokenInMint: inputMint,
        tokenOutMint: outputMint,
        tokenA: toStr(leg.tokenA || leg.tokenXMint || leg.baseMint || inputMint),
        tokenB: toStr(leg.tokenB || leg.tokenYMint || leg.quoteMint || outputMint),
        mintA: toStr(leg.mintA || leg.tokenXMint || leg.baseMint || inputMint),
        mintB: toStr(leg.mintB || leg.tokenYMint || leg.quoteMint || outputMint),
        baseMint: toStr(leg.baseMint || leg.tokenXMint || leg.mintA || inputMint),
        quoteMint: toStr(leg.quoteMint || leg.tokenYMint || leg.mintB || outputMint),
        amountInAtomic,
        minOutAtomic,
        expectedOutAtomic,
        feeBps: leg.feeBps ?? null,
        quoteSource: leg.quoteSource || null,
        swapDirection: leg.swapDirection || (leg.swapForY ? 'A_TO_B' : 'B_TO_A') || null,
        swapForY: Boolean(leg.swapForY),
        tickArrays: Array.isArray(leg.tickArrays) ? leg.tickArrays : [],
        binArrays: Array.isArray(leg.binArrays) ? leg.binArrays : [],
        binStep: leg.binStep ?? null,
        activeBinId: leg.activeBinId ?? leg.activeId ?? null,
        tickSpacing: leg.tickSpacing ?? null,
        tickCurrent: leg.tickCurrent ?? null,
        liquidity: leg.liquidity ?? null,
        sqrtPrice: leg.sqrtPrice ?? leg.sqrtPriceX64 ?? null,
        sqrtPriceX64: leg.sqrtPriceX64 ?? leg.sqrtPrice ?? null,
        remainingAccounts: Array.isArray(leg.remainingAccounts) ? leg.remainingAccounts : [],
        executionQuality: leg.executionQuality || null,
        poolContext: leg.poolContext || leg.pool || leg._raw || null,
    };
}

function candidateToRouteLegs(candidate = {}) {
    const directLegs = Array.isArray(candidate.legs) ? candidate.legs : [];
    if (directLegs.length === 3) {
        return directLegs.map((leg, index) => normalizeSubmissionLeg(leg, index));
    }

    const route = candidate.arbitrageRoute || {};
    const routeLegs = [route.leg1, route.leg2, route.leg3].filter(Boolean);
    if (routeLegs.length !== 3) {
        throw new Error('submission candidate must contain exactly 3 legs');
    }

    return routeLegs.map((leg, index) => normalizeSubmissionLeg({
        legIndex: index + 1,
        dex: leg.dex,
        dexType: leg.dex,
        type: String(leg.dex || '').split('_').pop() || '',
        poolAddress: leg.poolAddress,
        inputMint: leg.inputMint,
        outputMint: leg.outputMint,
        amountInAtomic: leg.inputAmount,
        minOutAtomic: leg.minOutputAmount || null,
        expectedOutAtomic: leg.outputAmount || null,
        feeBps: leg.feeBps ?? null,
        quoteSource: 'reference-archive',
    }, index));
}

function candidateToFlashloanPlan(candidate = {}) {
    const routeLegs = candidateToRouteLegs(candidate);
    const flashLoan = candidate.flashLoan || {};
    const loanMint = toStr(flashLoan.borrowMint || routeLegs[0]?.inputMint || '');
    const loanAmountAtomic = toStr(flashLoan.borrowAmount || routeLegs[0]?.amountInAtomic || '');
    const repayAmountAtomic = toStr(flashLoan.repayAmount || loanAmountAtomic || '');

    return {
        routeId: candidate.routeId || candidate.candidateId || null,
        routePath: candidate.routePath || candidate.arbitrageRoute?.path || null,
        startAmount: toStr(candidate.startAmount || flashLoan.borrowAmount || routeLegs[0]?.amountInAtomic || ''),
        finalAmount: toStr(candidate.finalAmount || routeLegs[2]?.expectedOutAtomic || ''),
        minFinalAmount: toStr(candidate.minFinalAmount || routeLegs[2]?.minOutAtomic || ''),
        profitLamports: toStr(candidate.profitLamports || ''),
        profitBps: Number(candidate.profitBps || candidate.estimatedProfit?.profitBps || 0),
        executionQuality: candidate.executionQuality || candidate.status || 'unknown',
        routeLegs,
        loanMint,
        loanAmountAtomic,
        repayAmountAtomic,
        flashLoan,
    };
}

function validateFlashloanPlan(plan = {}) {
    const issues = [];
    const routeLegs = Array.isArray(plan.routeLegs) ? plan.routeLegs : [];

    if (routeLegs.length !== 3) {
        issues.push(`routeLegs must contain exactly 3 legs, got ${routeLegs.length}`);
    }
    if (!plan.loanMint) {
        issues.push('loanMint is missing');
    }
    if (!plan.loanAmountAtomic) {
        issues.push('loanAmountAtomic is missing');
    }
    if (!plan.repayAmountAtomic) {
        issues.push('repayAmountAtomic is missing');
    }

    if (routeLegs[0]?.inputMint && plan.loanMint && routeLegs[0].inputMint !== plan.loanMint) {
        issues.push(`flash loan mint ${plan.loanMint} does not match first leg input ${routeLegs[0].inputMint}`);
    }
    if (routeLegs[2]?.outputMint && plan.loanMint && routeLegs[2].outputMint !== plan.loanMint) {
        issues.push(`flash loan mint ${plan.loanMint} does not match final leg output ${routeLegs[2].outputMint}`);
    }

    if (routeLegs[0]?.outputMint && routeLegs[1]?.inputMint && routeLegs[0].outputMint !== routeLegs[1].inputMint) {
        issues.push(`leg 1 output ${routeLegs[0].outputMint} does not match leg 2 input ${routeLegs[1].inputMint}`);
    }
    if (routeLegs[1]?.outputMint && routeLegs[2]?.inputMint && routeLegs[1].outputMint !== routeLegs[2].inputMint) {
        issues.push(`leg 2 output ${routeLegs[1].outputMint} does not match leg 3 input ${routeLegs[2].inputMint}`);
    }

    for (const leg of routeLegs) {
        if (!leg.poolAddress) issues.push(`leg ${leg.legIndex}: poolAddress is missing`);
        if (!leg.inputMint) issues.push(`leg ${leg.legIndex}: inputMint is missing`);
        if (!leg.outputMint) issues.push(`leg ${leg.legIndex}: outputMint is missing`);
        if (!leg.amountInAtomic) issues.push(`leg ${leg.legIndex}: amountInAtomic is missing`);
        if (!leg.minOutAtomic) issues.push(`leg ${leg.legIndex}: minOutAtomic is missing`);
    }

    return {
        valid: issues.length === 0,
        issues,
    };
}

function loadCandidateFromResultFile(inputPath, candidateIndex = 0, options = {}) {
    const { resolved, raw } = loadJson(inputPath);
    const candidate = selectSubmissionCandidate(raw, candidateIndex);
    const plan = candidateToFlashloanPlan(candidate);
    const validation = validateFlashloanPlan(plan);
    if (options.validate !== false && !validation.valid) {
        throw new Error(`submission candidate is not execution-consistent: ${validation.issues.join('; ')}`);
    }
    return {
        resolved,
        candidate,
        plan,
        validation,
    };
}

/* -------------------------------------------------------------------------- */
/*                         Compute budget helpers                             */
/* -------------------------------------------------------------------------- */

function computeBudgetIxs({ unitLimit, unitPriceMicroLamports } = {}) {
    const ixs = [];
    if (unitLimit != null) {
        ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Number(unitLimit) }));
    }
    if (unitPriceMicroLamports != null) {
        ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(unitPriceMicroLamports) }));
    }
    return ixs;
}

/* -------------------------------------------------------------------------- */
/*                           ATA helpers                                      */
/* -------------------------------------------------------------------------- */

function findATA(ownerPubkey, mintPubkey, programId = TOKEN_PROGRAM_ID) {
    const [address] = PublicKey.findProgramAddressSync(
        [pubkeyOf(ownerPubkey).toBuffer(), pubkeyOf(programId).toBuffer(), pubkeyOf(mintPubkey).toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return address;
}

function createATAInstruction(payer, owner, mint, programId = TOKEN_PROGRAM_ID) {
    const ata = findATA(owner, mint, programId);
    return new TransactionInstruction({
        keys: [
            { pubkey: pubkeyOf(payer), isSigner: true, isWritable: true },
            { pubkey: ata, isSigner: false, isWritable: true },
            { pubkey: pubkeyOf(owner), isSigner: false, isWritable: false },
            { pubkey: pubkeyOf(mint), isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: programId, isSigner: false, isWritable: false },
        ],
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        data: Buffer.from([]),
    });
}

/* -------------------------------------------------------------------------- */
/*                           TradeExecutor class                              */
/* -------------------------------------------------------------------------- */

class TradeExecutor {
    constructor(connection, wallet, opts = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.opts = {
            computeUnitPrice: opts.computeUnitPrice || 100_000,
            computeUnitLimit: opts.computeUnitLimit || 200_000,
            skipPreflight: opts.skipPreflight || false,
            maxRetries: opts.maxRetries ?? 2,
            skipConfirm: opts.skipConfirm || false,
            ...opts,
        };
    }

    async getOrCreateATA(mint, owner = this.wallet.publicKey) {
        const ata = findATA(owner, mint);
        try {
            const info = await this.connection.getAccountInfo(ata);
            if (info) {
                return { address: ata, exists: true, createIx: null };
            }
        } catch (_e) {
            // account doesn't exist
        }
        return {
            address: ata,
            exists: false,
            createIx: createATAInstruction(this.wallet.publicKey, owner, mint),
        };
    }

    async prepareTokenAccountsForRoute(routeLegs) {
        const instructions = [];
        const neededMints = new Set();

        for (const leg of routeLegs) {
            neededMints.add(leg.inputMint);
            neededMints.add(leg.outputMint);
        }

        const accounts = {};
        for (const mint of neededMints) {
            const result = await this.getOrCreateATA(pubkeyOf(mint));
            accounts[mint] = result.address;
            if (result.createIx) {
                instructions.push(result.createIx);
            }
        }

        return { accounts, instructions };
    }

    async getFreshQuote(leg) {
        const adapters = {};
        try {
            const mod = require('./Q-clmm');
            adapters.clmm = mod.CLMMAdapter || mod;
        } catch (_e) { /* not available */ }
        try {
            const mod = require('./Q-cpmm');
            adapters.cpmm = mod.CPMMAdapter || mod;
        } catch (_e) { /* not available */ }
        try {
            const mod = require('./Q-dlmm');
            adapters.dlmm = mod.DLMMAdapter || mod;
        } catch (_e) { /* not available */ }
        try {
            const mod = require('./Q-whirlpool');
            adapters.whirlpool = mod.WhirlpoolAdapter || mod;
        } catch (_e) { /* not available */ }

        const type = normalizeType(leg.type || leg.dexType);
        const adapter = adapters[type];

        if (!adapter) {
            throw new Error(`No quoter adapter available for type: ${type}`);
        }

        if (typeof adapter.quoteSwap === 'function') {
            return await adapter.quoteSwap(leg.poolContext || leg, leg.amountInAtomic, leg.swapForY, leg.slippageBps || 20);
        }
        if (typeof adapter.getQuote === 'function') {
            return await adapter.getQuote(String(leg.amountInAtomic), leg.swapForY, leg.slippageBps || 20, { pool: leg.poolContext || leg });
        }
        if (typeof adapter.quoteExactIn === 'function') {
            return await adapter.quoteExactIn(String(leg.amountInAtomic), leg.swapForY, leg.slippageBps || 20, { pool: leg.poolContext || leg });
        }

        throw new Error(`Adapter for ${type} does not expose a compatible quote interface`);
    }

    validateRouteProfitability(legs, initialAmount) {
        let amount = new BN(initialAmount);
        const debugPath = [];

        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];
            const minOut = new BN(leg.minOutAtomic || '0');

            if (minOut.eq(new BN(0))) {
                return {
                    profitable: false,
                    reason: `Leg ${i + 1}: minOutAtomic is zero`,
                    debugPath,
                };
            }

            const fee = new BN(leg.feeBps || 25);
            const slippage = new BN(leg.slippageBps || 20);
            const totalDeductionBps = fee.add(slippage);
            const amountAfterDeduction = minOut.mul(
                new BN(10000 - totalDeductionBps.toNumber())
            ).div(new BN(10000));

            debugPath.push({
                leg: i + 1,
                dex: leg.dex,
                in: amount.toString(),
                minOut: minOut.toString(),
                afterDeductions: amountAfterDeduction.toString(),
                feeBps: fee.toString(),
                slippageBps: slippage.toString(),
            });

            amount = amountAfterDeduction;
        }

        const profitBps = amount.sub(new BN(initialAmount)).mul(new BN(10000)).div(new BN(initialAmount));
        const profitable = amount.gt(new BN(initialAmount));

        return {
            profitable,
            finalAmount: amount.toString(),
            profitBps: profitBps.toString(),
            debugPath,
        };
    }

    async buildRouteSwapInstructions(routeLegs, opts = {}) {
        const { buildSwapIxForPool } = require('./flashloanSwapInstructions');
        const swapInstructions = [];

        for (let i = 0; i < routeLegs.length; i++) {
            const leg = routeLegs[i];
            const hop = {
                ...leg,
                dex: leg.dex,
                type: leg.type,
                poolAddress: leg.poolAddress,
                inputMint: leg.inputMint,
                outputMint: leg.outputMint,
                amountInAtomic: leg.amountInAtomic,
                minOutAtomic: leg.minOutAtomic,
                swapForY: leg.swapForY,
                slippageBps: leg.slippageBps || 20,
                tickArrays: leg.tickArrays,
                binArrays: leg.binArrays,
                binStep: leg.binStep,
                activeBinId: leg.activeBinId,
                tickSpacing: leg.tickSpacing,
                tickCurrent: leg.tickCurrent,
                liquidity: leg.liquidity,
                sqrtPrice: leg.sqrtPrice,
                sqrtPriceX64: leg.sqrtPriceX64,
                remainingAccounts: leg.remainingAccounts,
                poolContext: leg.poolContext,
            };

            const ixOrArray = await buildSwapIxForPool(
                hop,
                hop.amountInAtomic,
                this.wallet.publicKey,
                { connection: this.connection, slippageBps: hop.slippageBps, ...opts }
            );

            if (!ixOrArray) {
                throw new Error(`buildSwapIxForPool returned nothing for leg ${i + 1} (${hop.poolAddress})`);
            }
            if (Array.isArray(ixOrArray)) {
                swapInstructions.push(...ixOrArray);
            } else {
                swapInstructions.push(ixOrArray);
            }
        }

        return swapInstructions;
    }

    /**
     * Build an execution bundle.
     *
     * TradeExecutor produces ONLY swap + ATA instructions.
     * Kamino borrow/repay instructions are constructed by atomicBundleBuilder
     * with the correct borrowInstructionIndex.
     */
    async buildExecutionBundle(plan, opts = {}) {
        const { buildAtomicKaminoArbTransaction } = require('./atomicBundleBuilder');

        // 1. Resolve required token accounts
        const { accounts: tokenAccounts, instructions: ataInstructions } = await this.prepareTokenAccountsForRoute(plan.routeLegs);

        // 2. Build swap instructions
        const swapInstructions = await this.buildRouteSwapInstructions(plan.routeLegs, opts);

        // 3. Build flash loan config for atomicBundleBuilder
        //    (We do NOT pre-build Kamino instructions here — atomicBundleBuilder
        //     will construct them with the correct borrowInstructionIndex.)
        if (!opts.kaminoAccounts) {
            throw new Error('Kamino reserve accounts (kaminoAccounts) are required in opts. Use resolveKaminoReserveAccounts() to fetch them.');
        }

        const flashLoan = {
            amountLamports: plan.loanAmountAtomic,
            repayAmountLamports: plan.repayAmountAtomic,
            borrowAccounts: opts.kaminoAccounts.borrow,
            repayAccounts: opts.kaminoAccounts.repay,
        };

        // 4. Compute budget
        const budgetIxs = computeBudgetIxs({
            unitLimit: opts.computeUnitLimit || this.opts.computeUnitLimit,
            unitPriceMicroLamports: opts.computeUnitPrice || this.opts.computeUnitPrice,
        });

        // 5. Assemble through atomicBundleBuilder
        const { transaction, metadata } = await buildAtomicKaminoArbTransaction({
            payer: this.wallet,
            connection: this.connection,
            flashLoan,
            arbitrageInstructions: [...ataInstructions, ...swapInstructions],
            lookupTableAccounts: opts.lookupTableAccounts || [],
            computeUnitLimit: opts.computeUnitLimit || this.opts.computeUnitLimit,
            priorityFeeMicroLamports: opts.computeUnitPrice || this.opts.computeUnitPrice,
            jitoTipLamports: opts.jitoTipLamports || 10000,
            // TradeExecutor no longer passes _borrowIx or _repayIx.
            // atomicBundleBuilder constructs them with correct indices.
            _budgetIxs: budgetIxs,
        });

        return {
            transaction,
            metadata: {
                ...metadata,
                plan,
                tokenAccounts,
                ataInstructionCount: ataInstructions.length,
                swapInstructionCount: swapInstructions.length,
            },
        };
    }

    async submitViaJito(bundle, opts = {}) {
        const { sendAtomicBundle } = require('./atomicBundleBuilder');
        const { createJitoClient } = require('./jitoClient');
        const client = opts.jitoClient || createJitoClient();
        return sendAtomicBundle(bundle.transaction, client);
    }

    async sendDirect(bundle, opts = {}) {
        const tx = bundle.transaction;
        const sig = await this.connection.sendTransaction(tx, {
            skipPreflight: opts.skipPreflight ?? this.opts.skipPreflight,
            maxRetries: opts.maxRetries ?? this.opts.maxRetries,
        });

        if (!opts.skipConfirm) {
            const { blockhash, lastValidBlockHeight } = bundle.metadata || {};
            if (blockhash && lastValidBlockHeight) {
                await this.connection.confirmTransaction(
                    { signature: sig, blockhash, lastValidBlockHeight },
                    'confirmed'
                );
            }
        }

        return { signature: sig };
    }
}

/* -------------------------------------------------------------------------- */
/*                     Kamino reserve account resolution                      */
/* -------------------------------------------------------------------------- */

async function resolveKaminoReserveAccounts(connection, mint, opts = {}) {
    const mintPubkey = pubkeyOf(mint);
    if (!mintPubkey) {
        throw new Error('resolveKaminoReserveAccounts: mint is required');
    }

    if (opts.borrowAccounts && opts.repayAccounts) {
        return {
            borrow: opts.borrowAccounts,
            repay: opts.repayAccounts,
        };
    }

    throw new Error(
        'Kamino reserve account resolution is not yet implemented. ' +
        'You must provide opts.borrowAccounts / opts.repayAccounts with:\n' +
        '  borrow: { lendingMarketAuthority, lendingMarket, reserve, reserveLiquidityMint, reserveSourceLiquidity, userDestinationLiquidity, reserveLiquidityFeeReceiver }\n' +
        '  repay:  { lendingMarketAuthority, lendingMarket, reserve, reserveLiquidityMint, reserveDestinationLiquidity, userSourceLiquidity, reserveLiquidityFeeReceiver }'
    );
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
    // Core execution class
    TradeExecutor,

    // Submission candidate loading / normalization
    loadJson,
    extractSubmissionCandidates,
    selectSubmissionCandidate,
    normalizeSubmissionLeg,
    candidateToRouteLegs,
    candidateToFlashloanPlan,
    validateFlashloanPlan,
    loadCandidateFromResultFile,

    // Compute budget
    computeBudgetIxs,

    // Kamino resolution
    resolveKaminoReserveAccounts,

    // Low-level helpers
    normalizeDex,
    normalizeType,
    pubkeyOf,
    toStr,
    findATA,
    createATAInstruction,

    // Token program constants
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
};
