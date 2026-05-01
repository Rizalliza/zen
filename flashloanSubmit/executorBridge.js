'use strict';
/**
 * executorBridge.js
 *
 * Integration bridge: myEngine simulation results → executable Jito bundle.
 *
 * This is the wiring layer that connects the simulation pipeline to live execution.
 * It demonstrates the complete flow:
 *
 *   myEngine result file
 *     → loadCandidateFromResultFile (tradeExecute.js)
 *     → candidateToFlashloanPlan
 *     → validateFlashloanPlan
 *     → buildExecutionBundle (TradeExecutor)
 *       → buildSwapIxForPool (flashloanSwapInstructions.js) [per leg]
 *       → buildKaminoFlashBorrowInstruction (kaminoFlashloan.js)
 *       → buildKaminoFlashRepayInstruction (kaminoFlashloan.js)
 *       → buildAtomicKaminoArbTransaction (atomicBundleBuilder.js)
 *     → submitViaJito (jitoClient.js)
 *
 * Usage:
 *   const { runExecutionFromResultFile } = require('./executorBridge');
 *   await runExecutionFromResultFile('runtime_results.json', 0, wallet, connection, kaminoAccounts);
 */

const { Connection, Keypair } = require('@solana/web3.js');

const {
    TradeExecutor,
    loadCandidateFromResultFile,
    candidateToFlashloanPlan,
    validateFlashloanPlan,
} = require('./tradeExecute');

const {
    buildAtomicKaminoArbTransaction,
    sendAtomicBundle,
    resolveKaminoReserveAccounts,
} = require('./atomicBundleBuilder');

const {
    createJitoClient,
} = require('./jitoClient');

/* -------------------------------------------------------------------------- */
/*                              Complete flow                                 */
/* -------------------------------------------------------------------------- */

/**
 * Execute a candidate from a myEngine result file.
 *
 * @param {string} resultFilePath - Path to myEngine output JSON
 * @param {number} candidateIndex - Which candidate to execute (default: 0 = best)
 * @param {Keypair} payer - Payer keypair
 * @param {Connection} connection - Solana connection
 * @param {Object} kaminoAccounts - Kamino borrow/repay accounts (or opts for resolution)
 * @param {Object} opts - Execution options
 * @returns {Promise<Object>} Bundle result with signature
 */
async function runExecutionFromResultFile(resultFilePath, candidateIndex = 0, payer, connection, kaminoAccounts, opts = {}) {
    // 1. Load and validate candidate
    const { candidate, plan, validation } = loadCandidateFromResultFile(resultFilePath, candidateIndex, {
        validate: true,
    });

    if (!validation.valid) {
        throw new Error(`Candidate validation failed: ${validation.issues.join('; ')}`);
    }

    console.log(`\n📋 Loaded candidate ${candidateIndex}:`);
    console.log(`   Route: ${plan.routePath}`);
    console.log(`   Profit: ${plan.profitBps} bps`);
    console.log(`   Loan: ${plan.loanAmountAtomic} of ${plan.loanMint}`);

    // 2. Build execution bundle
    const executor = new TradeExecutor(connection, payer, opts.executor || {});
    const bundle = await executor.buildExecutionBundle(plan, {
        kaminoAccounts,
        computeUnitLimit: opts.computeUnitLimit || 1_400_000,
        computeUnitPrice: opts.computeUnitPrice || 50_000,
        jitoTipLamports: opts.jitoTipLamports || 10_000,
        lookupTableAccounts: opts.lookupTableAccounts || [],
    });

    console.log(`\n📦 Bundle assembled:`);
    console.log(`   Instructions: ${bundle.metadata.instructionCount}`);
    console.log(`   Blockhash: ${bundle.metadata.blockhash}`);

    // 3. Submit via Jito
    const jitoClient = opts.jitoClient || createJitoClient();
    const result = await executor.submitViaJito(bundle, { jitoClient });

    console.log(`\n🚀 Bundle submitted:`, result);

    return {
        bundle,
        plan,
        jitoResult: result,
    };
}

/**
 * Build a transaction from a myEngine result WITHOUT submitting.
 * Use this to inspect the transaction before execution.
 */
async function buildTransactionFromResultFile(resultFilePath, candidateIndex, payer, connection, kaminoAccounts, opts = {}) {
    const { candidate, plan, validation } = loadCandidateFromResultFile(resultFilePath, candidateIndex, {
        validate: false,
    });

    if (!validation.valid) {
        console.warn(`Validation issues: ${validation.issues.join('; ')}`);
    }

    const executor = new TradeExecutor(connection, payer, opts.executor || {});
    return executor.buildExecutionBundle(plan, {
        kaminoAccounts,
        ...opts,
    });
}

/**
 * Execute a candidate using the atomicBundleBuilder direct bridge.
 * This path is useful when you already have the myEngine result object in memory.
 */
async function executeCandidateDirect(candidate, pools, payer, connection, kaminoAccounts, opts = {}) {
    const { buildTransactionFromCandidate } = require('./atomicBundleBuilder');

    const bundle = await buildTransactionFromCandidate({
        candidate,
        pools,
        payer,
        connection,
        kaminoAccounts,
        opts,
    });

    // Submit via Jito
    const jitoClient = opts.jitoClient || createJitoClient();
    const result = await sendAtomicBundle(bundle.transaction, jitoClient);

    return {
        bundle,
        jitoResult: result,
    };
}

/* -------------------------------------------------------------------------- */
/*                         Kamino account helpers                             */
/* -------------------------------------------------------------------------- */

/**
 * Convenience wrapper to resolve Kamino accounts for a given loan mint.
 */
async function prepareKaminoAccounts(connection, loanMint, lendingMarket, opts = {}) {
    return resolveKaminoReserveAccounts(connection, loanMint, lendingMarket, opts);
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
    // Full execution flow
    runExecutionFromResultFile,
    buildTransactionFromResultFile,
    executeCandidateDirect,

    // Kamino helpers
    prepareKaminoAccounts,
};
