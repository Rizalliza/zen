import { AccountInfo, AddressLookupTableAccount, Blockhash, BlockhashWithExpiryBlockHeight, Commitment, Connection, GetLatestBlockhashConfig, Keypair, ParsedAccountData, PublicKey, RpcResponseAndContext, SignatureResult, Signer, Transaction, TransactionInstruction, TransactionSignature, VersionedTransaction } from '@solana/web3.js';
import { SignerWalletAdapterProps } from '@solana/wallet-adapter-base';
import { CreateSmartTransactionOptions, GetPriorityFeeEstimateRequest, GetPriorityFeeEstimateResponse, HeliusSendOptions, JitoRegion, JupiterSwapParams, JupiterSwapResult, PollTransactionOptions, SendSmartTransactionOptions, SignedTransactionInput, SmartTransactionContext } from './types';
import { DAS } from './types/das-types';
export type SendAndConfirmTransactionResponse = {
    signature: TransactionSignature;
    confirmResponse: RpcResponseAndContext<SignatureResult>;
    blockhash: Blockhash;
    lastValidBlockHeight: number;
};
/**
 * The beefed up RPC client from Helius SDK
 */
export declare class RpcClient {
    protected readonly connection: Connection;
    protected readonly id?: string | undefined;
    constructor(connection: Connection, id?: string | undefined);
    /**
     * Request an allocation of lamports to the specified address
     * @returns {Promise<SendAndConfirmTransactionResponse>}
     */
    airdrop(publicKey: PublicKey, lamports: number, commitment?: Commitment): Promise<SendAndConfirmTransactionResponse>;
    /**
     * Fetch the latest blockhash from the cluster
     * @returns {Promise<BlockhashWithExpiryBlockHeight>}
     */
    getLatestBlockhash(commitmentOrConfig?: Commitment | GetLatestBlockhashConfig): Promise<BlockhashWithExpiryBlockHeight>;
    /**
     * Returns the current transactions per second (TPS) rate — including voting transactions.
     *
     * @returns {Promise<number>} A promise that resolves to the current TPS rate.
     * @throws {Error} If there was an error calling the `getRecentPerformanceSamples` method.
     */
    getCurrentTPS(): Promise<number>;
    /**
     * Returns all the stake accounts for a given public key
     *
     * @returns {Promise<number>} A promise that resolves to the current TPS rate.
     * @throws {Error} If there was an error calling the `getStakeAccounts` method.
     */
    getStakeAccounts(wallet: string): Promise<any>;
    /**
     * Returns all the token accounts for a given mint address (ONLY FOR SPL TOKENS)
     *
     * @returns {Promise<{pubkey: PublicKey; account: AccountInfo<ParsedAccountData | Buffer}[]>} A promise that resolves to an array of accountInfo
     * @throws {Error} If there was an error calling the `getTokenHolders` method.
     */
    getTokenHolders(mintAddress: string): Promise<{
        pubkey: PublicKey;
        account: AccountInfo<ParsedAccountData | Buffer>;
    }[]>;
    /**
     * Get a single asset by ID.
     * @param {DAS.GetAssetRequest | string} id - Asset ID
     * @returns {Promise<DAS.GetAssetResponse>}
     * @throws {Error}
     */
    getAsset(params: DAS.GetAssetRequest | string): Promise<DAS.GetAssetResponse>;
    /**
     * Get multiple assets.
     * @returns {Promise<DAS.GetAssetResponse[]>}
     * @throws {Error}
     */
    getAssetBatch(params: DAS.GetAssetBatchRequest): Promise<DAS.GetAssetResponse[]>;
    /**
     * Get Asset proof.
     * @returns {Promise<DAS.GetAssetProofResponse>}
     * @throws {Error}
     */
    getAssetProof(params: DAS.GetAssetProofRequest): Promise<DAS.GetAssetProofResponse>;
    /**
     * Get Assets By group.
     * @returns {Promise<DAS.GetAssetResponseList>}
     * @throws { Error }
     */
    getAssetsByGroup(params: DAS.AssetsByGroupRequest): Promise<DAS.GetAssetResponseList>;
    /**
     * Get all assets (compressed and regular) for a public key.
     * @returns {Promise<DAS.GetAssetResponseList>}
     * @throws {Error}
     */
    getAssetsByOwner(params: DAS.AssetsByOwnerRequest): Promise<DAS.GetAssetResponseList>;
    /**
     * Request assets for a given creator.
     * @returns {Promise<DAS.GetAssetResponseList>}
     * @throws {Error}
     */
    getAssetsByCreator(params: DAS.AssetsByCreatorRequest): Promise<DAS.GetAssetResponseList>;
    /**
     * Get assets by authority.
     * @returns {Promise<DAS.GetAssetResponseList>}
     * @throws {Error}
     */
    getAssetsByAuthority(params: DAS.AssetsByAuthorityRequest): Promise<DAS.GetAssetResponseList>;
    /**
     * Search Assets
     * @returns {Promise<DAS.GetAssetResponseList>}
     * @throws {Error}
     */
    searchAssets(params: DAS.SearchAssetsRequest): Promise<DAS.GetAssetResponseList>;
    /**
     * Get transaction history for the asset.
     * @returns {Promise<GetSignatureForAssetResponse>}
     * @throws {Error}
     */
    getSignaturesForAsset(params: DAS.GetSignaturesForAssetRequest): Promise<DAS.GetSignaturesForAssetResponse>;
    /**
     * Get priority fee estimate
     * @returns {Promise<GetPriorityFeeEstimateResponse>}
     * @throws {Error}
     */
    getPriorityFeeEstimate(params: GetPriorityFeeEstimateRequest): Promise<GetPriorityFeeEstimateResponse>;
    /**
     * Simulate a transaction to get the total compute units consumed
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {PublicKey} payer - The public key of the payer
     * @param {AddressLookupTableAccount[]} lookupTables - The address lookup tables
     * @param {Signer[]} signers - Optional signers for the transaction
     * @returns {Promise<number | null>} - The compute units consumed, or null if unsuccessful
     */
    getComputeUnits(instructions: TransactionInstruction[], payer: PublicKey, lookupTables: AddressLookupTableAccount[], signers?: Signer[]): Promise<number | null>;
    /**
     * Poll a transaction to check whether it has been confirmed
     * @param {TransactionSignature} txtSig - The transaction signature
     * @param {PollTransactionOptions} pollOptions - Optional parameters for polling
     * @returns {Promise<TransactionSignature>} - The confirmed transaction signature or an error if the confirmation times out
     */
    pollTransactionConfirmation(txtSig: TransactionSignature, pollOptions?: PollTransactionOptions): Promise<TransactionSignature>;
    /**
     * Create a smart transaction with the provided configuration
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {Signer[]} signers - The transaction's signers. The first signer should be the fee payer
     * @param {AddressLookupTableAccount[]} lookupTables - The lookup tables to be included in a versioned transaction. Defaults to `[]`
     * @param {CreateSmartTransactionOptions} options - Options for customizing the transaction creation process. Includes:
     *   - `feePayer` (Signer, optional): Override fee payer (defaults to first signer).
     *   - `serializeOptions` (SerializeConfig, optional): Custom serialization options for the transaction.
     *   - `priorityFeeCap` (number, optional): Maximum priority fee to pay in microlamports (for fee estimation capping).
     *
     * @returns {Promise<SmartTransactionContext>} - The transaction with blockhash, blockheight and slot
     *
     * @throws {Error} If there are issues with constructing the transaction, fetching priority fees, or computing units
     */
    createSmartTransaction(instructions: TransactionInstruction[], signers: Signer[], lookupTables?: AddressLookupTableAccount[], options?: CreateSmartTransactionOptions): Promise<SmartTransactionContext>;
    /**
     * Build and send an optimized transaction, and handle its confirmation status
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {Signer[]} signers - The transaction's signers. The first signer should be the fee payer
     * @param {AddressLookupTableAccount[]} [lookupTables=[]] - The lookup tables to be included in a versioned transaction
     * @param {SendSmartTransactionOptions} [sendOptions={}] - Options for customizing the transaction sending process. Includes:
     *   - `lastValidBlockHeightOffset` (number, optional, default=150): Offset added to current block height to compute expiration. Must be positive.
     *   - `pollTimeoutMs` (number, optional, default=60000): Total timeout (ms) for confirmation polling.
     *   - `pollIntervalMs` (number, optional, default=2000): Interval (ms) between polling attempts.
     *   - `pollChunkMs` (number, optional, default=10000): Timeout (ms) for each individual polling chunk.
     *   - `skipPreflight` (boolean, optional, default=false): Skip preflight transaction checks if true.
     *   - `preflightCommitment` (Commitment, optional, default='confirmed'): Commitment level for preflight checks.
     *   - `maxRetries` (number, optional): Maximum number of retries for sending the transaction.
     *   - `minContextSlot` (number, optional): Minimum slot at which to fetch blockhash (prevents stale blockhash usage).
     *   - `feePayer` (Signer, optional): Override fee payer (defaults to first signer).
     *   - `priorityFeeCap` (number, optional): Maximum priority fee to pay in microlamports (for fee estimation capping).
     *   - `serializeOptions` (SerializeConfig, optional): Custom serialization options for the transaction.
     *
     * @returns {Promise<TransactionSignature>} - The transaction signature
     *
     * @throws {Error} If the transaction fails to confirm within the specified parameters
     */
    sendSmartTransaction(instructions: TransactionInstruction[], signers: Signer[], lookupTables?: AddressLookupTableAccount[], sendOptions?: SendSmartTransactionOptions): Promise<TransactionSignature>;
    /**
     * Creates a smart transaction using a wallet adapter's signing functionality
     *
     * Instead of requiring signers, this method accepts a signTransaction function, which is
     * provided by wallet adapters
     *
     *
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {PublicKey} payer - The public key that will pay for the transaction
     * @param {SignerWalletAdapterProps['signTransaction']} signTransaction - A function (from the wallet adapter) to sign the transaction
     * @param {AddressLookupTableAccount[]} lookupTables - The lookup tables to be included in a versioned transaction. Defaults to `[]`
     * @param {CreateSmartTransactionOptions} options - Options for customizing the transaction creation process. Includes:
     *   - `feePayer` (Signer, optional): Override fee payer (defaults to first signer).
     *   - `serializeOptions` (SerializeConfig, optional): Custom serialization options for the transaction.
     *   - `priorityFeeCap` (number, optional): Maximum priority fee to pay in microlamports (for fee estimation capping).
     * @returns {Promise<SmartTransactionContext>} - The transaction with blockhash, blockheight and slot
     *
     * @throws {Error} If there are issues with constructing the transaction, fetching priority fees, or computing units
     */
    createSmartTransactionWithWalletAdapter(instructions: TransactionInstruction[], payer: PublicKey, signTransaction: SignerWalletAdapterProps['signTransaction'], lookupTables?: AddressLookupTableAccount[], options?: CreateSmartTransactionOptions): Promise<SmartTransactionContext>;
    /**
     * Sends a smart transaction using a wallet adatpers's signing functionality
     *
     * This method builds an unsigned transaction by calling `createSmartTransactionWithWalletAdapter`, and then
     * sends it via `sendRawTransaction` and polls for confirmation
     *
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {PublicKey} payer - The public key that will pay for the transaction
     * @param {SignerWalletAdapterProps['signTransaction']} signTransaction - A function (from the wallet adapter) to sign the transaction
     * @param {AddressLookupTableAccount[]} lookupTables - The lookup tables to be included in a versioned transaction. Defaults to `[]`
     * @param {SendSmartTransactionOptions} [sendOptions={}] - Options for customizing the transaction sending process. Includes:
     *   - `lastValidBlockHeightOffset` (number, optional, default=150): Offset added to current block height to compute expiration. Must be positive.
     *   - `pollTimeoutMs` (number, optional, default=60000): Total timeout (ms) for confirmation polling.
     *   - `pollIntervalMs` (number, optional, default=2000): Interval (ms) between polling attempts.
     *   - `pollChunkMs` (number, optional, default=10000): Timeout (ms) for each individual polling chunk.
     *   - `skipPreflight` (boolean, optional, default=false): Skip preflight transaction checks if true.
     *   - `preflightCommitment` (Commitment, optional, default='confirmed'): Commitment level for preflight checks.
     *   - `maxRetries` (number, optional): Maximum number of retries for sending the transaction.
     *   - `minContextSlot` (number, optional): Minimum slot at which to fetch blockhash (prevents stale blockhash usage).
     *   - `feePayer` (Signer, optional): Override fee payer (defaults to first signer, but we override here since we're using the wallet adapter).
     *   - `priorityFeeCap` (number, optional): Maximum priority fee to pay in microlamports (for fee estimation capping).
     *   - `serializeOptions` (SerializeConfig, optional): Custom serialization options for the transaction.
     *
     * @returns {Promise<TransactionSignature>} - The transaction signature
     *
     * @throws {Error} If the transaction fails to confirm within the specified parameters
     */
    sendSmartTransactionWithWalletAdapter(instructions: TransactionInstruction[], payer: PublicKey, signTransaction: SignerWalletAdapterProps['signTransaction'], lookupTables?: AddressLookupTableAccount[], sendOptions?: SendSmartTransactionOptions): Promise<TransactionSignature>;
    /**
     * Add a tip instruction to the last instruction in the bundle provided
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {PublicKey} feePayer - The public key of the fee payer
     * @param {string} tipAccount - The public key of the tip account
     * @param {number} tipAmount - The amount of lamports to tip
     */
    addTipInstruction(instructions: TransactionInstruction[], feePayer: PublicKey, tipAccount: string, tipAmount: number): void;
    /**
     * Create a smart transaction with a Jito tip
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {Signer[]} signers - The transaction's signers. The first signer should be the fee payer if a separate one isn't provided
     * @param {AddressLookupTableAccount[]} lookupTables - The lookup tables to be included. Defaults to `[]`
     * @param {number} tipAmount - The amount of lamports to tip. Defaults to 1000
     * @param {SmartTransactionOptions} options - Additional options for customizing the transaction (see `createSmartTransaction`)
     *
     * @returns {Promise<{ serializedTransaction: string, lastValidBlockHeight: number }>} - The serialized transaction
     *
     * @throws {Error} If there are issues with constructing the transaction or fetching the priority fees
     */
    createSmartTransactionWithTip(instructions: TransactionInstruction[], signers: Signer[], lookupTables?: AddressLookupTableAccount[], tipAmount?: number, options?: CreateSmartTransactionOptions): Promise<SmartTransactionContext>;
    /**
     * Send a bundle of transactions to the Jito Block Engine
     * @param {string[]} serializedTransactions - The serialized transactions in the bundle
     * @param {string} jitoApiUrl - The Jito Block Engine API URL
     * @returns {Promise<string>} - The bundle ID
     */
    sendJitoBundle(serializedTransactions: string[], jitoApiUrl: string): Promise<string>;
    /**
     * Get the status of Jito bundles
     * @param {string[]} bundleIds - An array of bundle IDs to check the status for
     * @param {string} jitoApiUrl - The Jito Block Engine API URL
     * @returns {Promise<any>} - The status of the bundles
     */
    getBundleStatuses(bundleIds: string[], jitoApiUrl: string): Promise<any>;
    /**
     * Send a smart transaction as a Jito bundle with a tip
     * @param {TransactionInstruction[]} instructions - The transaction instructions
     * @param {Signer[]} signers - The transaction's signers. The first signer should be the fee payer if a separate one isn't provided
     * @param {AddressLookupTableAccount[]} lookupTables - The lookup tables to be included. Defaults to `[]`
     * @param {number} tipAmount - The amount of lamports to tip. Defaults to 1000
     * @param {JitoRegion} region - The Jito Block Engine region. Defaults to "Default" (i.e., https://mainnet.block-engine.jito.wtf)
     * @param {SmartTransactionOptions} options - Options for customizing the transaction and bundle sending
     *
     * @returns {Promise<string>} - The bundle ID of the sent transaction
     *
     * @throws {Error} If the bundle fails to confirm within the specified parameters
     */
    sendSmartTransactionWithTip(instructions: TransactionInstruction[], signers: Signer[], lookupTables?: AddressLookupTableAccount[], tipAmount?: number, region?: JitoRegion, options?: SendSmartTransactionOptions): Promise<string>;
    /**
     * Get information about all the edition NFTs for a specific master NFT
     * @returns {Promise<DAS.GetNftEditionsResponse>}
     * @throws {Error}
     */
    getNftEditions(params: DAS.GetNftEditionsRequest): Promise<DAS.GetNftEditionsResponse>;
    /**
     * Get information about all token accounts for a specific mint or a specific owner
     * @returns {Promise<DAS.GetTokenAccountsResponse>}
     * @throws {Error}
     */
    getTokenAccounts(params: DAS.GetTokenAccountsRequest): Promise<DAS.GetTokenAccountsResponse>;
    /**
     * Send a transaction
     * @param {Transaction} transaction - The transaction to send
     * @param {HeliusSendOptions} options - Options for sending the transaction
     * @returns {Promise<TransactionSignature>} - The transaction signature
     */
    sendTransaction(transaction: Transaction | VersionedTransaction, options?: HeliusSendOptions): Promise<TransactionSignature>;
    /**
     * Execute a token swap using Jupiter Exchange with optimized transaction sending
     *
     * @example
     * ```typescript
     * // Basic swap: 0.01 SOL to USDC with default settings
     * const result = await helius.rpc.executeJupiterSwap({
     *   inputMint: 'So11111111111111111111111111111111111111112',  // SOL
     *   outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  // USDC
     *   amount: 10000000,  // 0.01 SOL
     * }, wallet);
     *
     * // Advanced swap with custom settings for better transaction landing
     * const advancedResult = await helius.rpc.executeJupiterSwap({
     *   inputMint: 'So11111111111111111111111111111111111111112',
     *   outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
     *   amount: 10000000,
     *   slippageBps: 50,                       // 0.5% slippage
     *   priorityLevel: 'veryHigh',             // High priority for congestion
     *   maxPriorityFeeLamports: 2000000,       // Max 0.002 SOL for priority fee
     *   skipPreflight: true,                   // Skip preflight checks
     *   maxRetries: 3,                         // Retry sending 3 times if needed
     *   confirmationCommitment: 'finalized',   // Wait for finalization
     * }, wallet);
     * ```
     *
     * @param params - Swap parameters object with the following properties:
     *   - `inputMint` - Input token mint address
     *   - `outputMint` - Output token mint address
     *   - `amount` - Amount of input tokens to swap (in smallest units)
     *   - `slippageBps` - Maximum allowed slippage in basis points (1 bp = 0.01%, default: 50)
     *   - `restrictIntermediateTokens` - Whether to restrict intermediate tokens (default: true)
     *   - `wrapUnwrapSOL` - Whether to auto-wrap/unwrap SOL (default: true)
     *   - `priorityLevel` - Priority level for transaction ('low', 'medium', 'high', 'veryHigh', 'unsafeMax', default: 'high')
     *   - `maxPriorityFeeLamports` - Maximum priority fee in lamports (default: 1000000)
     *   - `skipPreflight` - Whether to skip preflight transaction checks (default: true)
     *   - `maxRetries` - Maximum number of retries when sending transaction (default: 0)
     *   - `confirmationCommitment` - Commitment level for confirming transaction ('processed', 'confirmed', 'finalized', default: 'confirmed')
     *
     * @param signer - The wallet that will execute and pay for the swap
     *
     * @returns Swap result with the following properties:
     *   - `signature` - Transaction signature (empty if failed)
     *   - `success` - Whether the swap succeeded
     *   - `error` - Error message if swap failed
     *   - `inputAmount` - Amount of tokens swapped (in smallest units)
     *   - `outputAmount` - Amount of tokens received (in smallest units)
     *   - `minimumOutputAmount` - Minimum amount guaranteed with slippage (in smallest units)
     *   - `lastValidBlockHeight` - Last valid block height for the transaction
     *   - `prioritizationFeeLamports` - Actual priority fee used
     *   - `computeUnitLimit` - Compute unit limit set for the transaction
     *   - `confirmed` - Whether transaction was confirmed
     *   - `confirmationStatus` - Confirmation status of transaction
     *   - `explorerUrl` - URL to view transaction on Orb
     */
    executeJupiterSwap(params: JupiterSwapParams, signer: Signer): Promise<JupiterSwapResult>;
    /**
     * Generate an unsigned, serialized transaction to create and delegate a new stake account with the Helius validator
     * This transaction must be signed by the funder's wallet before sending
     *
     * @param {PublicKey} owner - The wallet that will fund and authorize the stake
     * @param {number} amountSol - The amount of SOL to stake (excluding rent exemption)
     * @returns {Promise<{ serializedTx: string, stakeAccountPubkey: PublicKey }>}
     */
    createStakeTransaction(owner: PublicKey, amountSol: number): Promise<{
        serializedTx: string;
        stakeAccountPubkey: PublicKey;
    }>;
    /**
     * Create an unsigned transaction to deactivate a stake account
     * @param {PublicKey} owner - The wallet that authorized the stake
     * @param {PublicKey} stakeAccountPubkey - The stake account to deactivate
     * @returns {Promise<string>} - Base58 serialized unsigned transaction
     */
    createUnstakeTransaction(owner: PublicKey, stakeAccountPubkey: PublicKey): Promise<string>;
    /**
     * Create an unsigned transaction to withdraw lamports from a stake account
     * This must be called **after** the cooldown period (i.e., once the stake is inactive).
     *
     * @param {PublicKey} owner - The wallet that authorized the stake
     * @param {PublicKey} stakeAccountPubkey - The stake account to withdraw from
     * @param {PublicKey} destination - The wallet that will receive the withdrawn SOL
     * @param {number} amountLamports - The amount of lamports to withdraw
     * @returns {Promise<string>} - Base58 serialized unsigned transaction
     */
    createWithdrawTransaction(owner: PublicKey, stakeAccountPubkey: PublicKey, destination: PublicKey, amountLamports: number): Promise<string>;
    /**
     * Fetch all stake accounts owned by a wallet and delegated to Helius
     * @param {string} wallet - The base58-encoded wallet address
     * @returns {Promise<any[]>} - The stake accounts delegated to Helius
     */
    getHeliusStakeAccounts(wallet: string): Promise<any[]>;
    /**
     * Get the amount of lamports that can be withdrawn from a stake account
     *
     * This checks whether the account is fully inactive (i.e., deactivated and cooled down),
     * and subtracts the rent-exempt minimum balance if applicable
     *
     * If `includeRentExempt` is `true`, it returns the entire balance, allowing the user to
     * close the stake account
     *
     * @param {PublicKey} stakeAccountPubkey - The stake account to inspect
     * @param {boolean} [includeRentExempt=false] - Whether to include the rent-exempt reserve in the amount
     * @returns {Promise<number>} - The number of lamports available for withdrawal (0 if none)
     */
    getWithdrawableAmount(stakeAccountPubkey: PublicKey, includeRentExempt?: boolean): Promise<number>;
    /**
     * Generate instructions to create and delegate a new stake account with Helius
     *
     * @param {PublicKey} owner - The wallet that will fund and authorize the stake
     * @param {number} amountSol - The amount of SOL to stake (excluding rent exemption)
     * @returns {Promise<{ instructions: TransactionInstruction[], stakeAccount: Keypair }>}
     */
    getStakeInstructions(owner: PublicKey, amountSol: number): Promise<{
        instructions: TransactionInstruction[];
        stakeAccount: Keypair;
    }>;
    /**
     * Generate an instruction to deactivate a stake account
     *
     * @param {PublicKey} owner - The wallet that authorized the stake
     * @param {PublicKey} stakeAccountPubkey - The stake account to deactivate
     * @returns {TransactionInstruction}
     */
    getUnstakeInstruction(owner: PublicKey, stakeAccountPubkey: PublicKey): TransactionInstruction;
    /**
     * Generate an instruction to withdraw lamports from a stake account
     *
     * This should only be called **after** the stake account has been deactivated
     * and the cooldown period (~2 epochs) has completed
     *
     * If you withdraw the full balance, the stake account can be closed
     *
     * @param {PublicKey} owner - The wallet that authorized the stake and can withdraw
     * @param {PublicKey} stakeAccountPubkey - The stake account to withdraw from
     * @param {PublicKey} destination - The account that will receive the withdrawn lamports
     * @param {number} amountLamports - The amount of lamports to withdraw
     * @returns {TransactionInstruction} - The instruction to include in a transaction
     */
    getWithdrawInstruction(owner: PublicKey, stakeAccountPubkey: PublicKey, destination: PublicKey, amountLamports: number): TransactionInstruction;
    /**
     * Broadcasts a fully signed transaction (object or serialized) and polls for its confirmation
     *
     * Automatically extracts the recentBlockhash if a `Transaction` is passed
     *
     * @param {SignedTransactionInput} transaction - Fully signed transaction (object or serialized)
     * @param {SendSmartTransactionOptions} [options={}] - Options for customizing the send and confirmation process
     *
     * @returns {Promise<TransactionSignature>} - Resolves with the transaction signature once confirmed
     *
     * @throws {Error} If the transaction fails to confirm within the timeout, fails on-chain, `lastValidBlockHeightOffset` is negative,
     * or the blockhash exceeds the block height
     */
    broadcastTransaction(transaction: SignedTransactionInput, options?: SendSmartTransactionOptions): Promise<string>;
}
