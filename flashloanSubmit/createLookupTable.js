#!/usr/bin/env node
'use strict';
/**
 * createLookupTable.js
 *
 * Creates and populates an Address Lookup Table (LUT) for flashloan
 * arbitrage transactions.
 *
 * WHY THIS MATTERS:
 *   A 3-leg Kamino flashloan route with manual DEX builders uses ~45-60
 *   static account keys. Solana's packet limit is 1232 bytes, and a v0
 *   message with 50+ keys serializes to ~1600+ bytes — it will NEVER land.
 *
 *   By moving common accounts (Token Program, DEX programs, common mints)
 *   into a LUT, the static key list drops to ~20-30 keys, and the
 *   transaction fits comfortably within the limit.
 *
 * ACCOUNTS TO INCLUDE:
 *   - System programs: SystemProgram, Token Program, Associated Token Program
 *   - Compute budget: ComputeBudgetProgram
 *   - DEX programs: Raydium CLMM, CPMM, AMM V4, Orca Whirlpool, Meteora DLMM
 *   - Kamino: Kamino Lending Program
 *   - Jito tip accounts
 *   - Common token mints: SOL, USDC, USDT, BONK, etc.
 *   - Your wallet (payer)
 *   - Your ATAs for common tokens
 *   - Kamino lending market authority and common reserves
 *
 * USAGE:
 *   node flashloanSubmit/createLookupTable.js --fund 0.002
 *
 *   # After creation, pass the LUT address to simulateExecutionBundle:
 *   node flashloanSubmit/simulateExecutionBundle.js \
 *     --input runtime_results.json \
 *     --lookupTables <LUT_ADDRESS>
 */

const {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  SystemProgram,
  ComputeBudgetProgram,
} = require('@solana/web3.js');

const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// Try to load env, fall back to manual config
try { require('dotenv').config(); } catch (_e) {}

const env = (() => {
  try { return require('./env'); } catch (_e) { return null; }
})();

/* -------------------------------------------------------------------------- */
/*                             Program IDs                                    */
/* -------------------------------------------------------------------------- */

const PROGRAMS = {
  RAYDIUM_CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
  RAYDIUM_CPMM: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  RAYDIUM_AMM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
  METEORA_DLMM: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  KAMINO_LENDING: new PublicKey('KLend2g3cP87fffoSw8b1zWzGvNfRj6Q2uHvXN4e8fQ'),
};

const COMMON_MINTS = [
  { name: 'SOL', address: 'So11111111111111111111111111111111111111112' },
  { name: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { name: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { name: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { name: 'JUP', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { name: 'RAY', address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
];

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZR2zFv5',
  'Cw8CFyM9FkoMi7G7hiqxXejYNLih3GXqKMpzinA4pwjb',
];

/* -------------------------------------------------------------------------- */
/*                             CLI helpers                                    */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {
    rpcUrl: env?.getRpcUrl?.() || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    fundLamports: 2282880, // default LUT creation cost
    maxAccounts: 256,
    extraAccounts: [],
    output: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2).toLowerCase();
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? argv[++i] : 'true';
    if (key === 'rpcurl') out.rpcUrl = value;
    if (key === 'fund') out.fundLamports = Number(value) || out.fundLamports;
    if (key === 'extra') out.extraAccounts = value.split(',').map(s => s.trim()).filter(Boolean);
    if (key === 'output') out.output = value;
  }
  return out;
}

function loadWallet() {
  if (env?.loadKeypair) return env.loadKeypair();

  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY not set in env');
  if (pk.includes(',')) {
    return Keypair.fromSecretKey(new Uint8Array(pk.split(',').map(Number)));
  }
  throw new Error('PRIVATE_KEY must be comma-separated bytes');
}

/* -------------------------------------------------------------------------- */
/*                         Account collection                                 */
/* -------------------------------------------------------------------------- */

function collectAccountsForLut(payer, extra = []) {
  const accounts = [];
  const seen = new Set();

  function add(pubkey, label) {
    const key = pubkey.toBase58();
    if (seen.has(key)) return;
    seen.add(key);
    accounts.push({ pubkey, label });
  }

  // System programs
  add(SystemProgram.programId, 'SystemProgram');
  add(ComputeBudgetProgram.programId, 'ComputeBudget');
  add(TOKEN_PROGRAM_ID, 'TokenProgram');
  add(TOKEN_2022_PROGRAM_ID, 'Token2022Program');
  add(ASSOCIATED_TOKEN_PROGRAM_ID, 'AssociatedTokenProgram');

  // DEX programs
  add(PROGRAMS.RAYDIUM_CLMM, 'RaydiumCLMM');
  add(PROGRAMS.RAYDIUM_CPMM, 'RaydiumCPMM');
  add(PROGRAMS.RAYDIUM_AMM_V4, 'RaydiumAMMv4');
  add(PROGRAMS.ORCA_WHIRLPOOL, 'OrcaWhirlpool');
  add(PROGRAMS.METEORA_DLMM, 'MeteoraDLMM');

  // Kamino
  add(PROGRAMS.KAMINO_LENDING, 'KaminoLending');

  // Jito tip accounts
  for (const addr of JITO_TIP_ACCOUNTS) {
    add(new PublicKey(addr), 'JitoTipAccount');
  }

  // Common mints
  for (const mint of COMMON_MINTS) {
    add(new PublicKey(mint.address), `Mint:${mint.name}`);
  }

  // Payer and payer's ATAs for common mints
  add(payer.publicKey, 'Payer');
  for (const mint of COMMON_MINTS) {
    const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint.address), payer.publicKey, false, TOKEN_PROGRAM_ID);
    add(ata, `ATA:${mint.name}`);
  }

  // Extra accounts from CLI
  for (const addr of extra) {
    try {
      add(new PublicKey(addr), 'Extra');
    } catch (_e) {
      console.warn(`Skipping invalid extra address: ${addr}`);
    }
  }

  return accounts;
}

/* -------------------------------------------------------------------------- */
/*                         LUT creation flow                                  */
/* -------------------------------------------------------------------------- */

async function createAndExtendLut(connection, payer, accounts, fundLamports) {
  const slot = await connection.getSlot();

  // Step 1: Create LUT instruction
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });

  console.log(`\n📋 Creating Address Lookup Table`);
  console.log(`   Authority: ${payer.publicKey.toBase58()}`);
  console.log(`   Recent slot: ${slot}`);
  console.log(`   LUT address: ${lutAddress.toBase58()}`);

  // Step 2: Extend LUT instructions (max 30 accounts per instruction)
  const BATCH_SIZE = 30;
  const batches = [];
  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    batches.push(accounts.slice(i, i + BATCH_SIZE));
  }

  const extendIxs = batches.map((batch) =>
    AddressLookupTableProgram.extendLookupTable({
      lookupTable: lutAddress,
      authority: payer.publicKey,
      payer: payer.publicKey,
      addresses: batch.map((a) => a.pubkey),
    })
  );

  console.log(`   Accounts to add: ${accounts.length}`);
  console.log(`   Extend batches: ${batches.length}`);

  // Step 3: Build transaction
  const allIxs = [createIx, ...extendIxs];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: allIxs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  // Step 4: Send
  console.log(`\n🚀 Sending LUT creation transaction...`);
  const sig = await connection.sendTransaction(tx, {
    maxRetries: 3,
    skipPreflight: false,
  });
  console.log(`   Signature: ${sig}`);

  // Step 5: Confirm
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  console.log(`   ✅ Confirmed`);

  // Step 6: Verify contents
  console.log(`\n🔍 Verifying LUT contents...`);
  const lutAccount = await connection.getAddressLookupTable(lutAddress);
  if (!lutAccount || !lutAccount.value) {
    throw new Error('LUT account not found after creation');
  }

  const lut = lutAccount.value;
  console.log(`   Addresses stored: ${lut.state.addresses.length}`);
  console.log(`   Authority: ${lut.state.authority.toBase58()}`);
  console.log(`   Deactivation slot: ${lut.state.deactivationSlot}`);

  // Step 7: Print account summary
  console.log(`\n📦 Accounts in LUT:`);
  for (const [index, acc] of accounts.entries()) {
    const inLut = lut.state.addresses.some((a) => a.toBase58() === acc.pubkey.toBase58());
    console.log(`   ${String(index).padStart(3)} ${inLut ? '✓' : '✗'} ${acc.pubkey.toBase58().slice(0, 12)}..${acc.pubkey.toBase58().slice(-4)}  (${acc.label})`);
  }

  return {
    lutAddress: lutAddress.toBase58(),
    lut,
    signature: sig,
    accountCount: lut.state.addresses.length,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Main                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const payer = loadWallet();
  const connection = new Connection(cli.rpcUrl, 'confirmed');

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Create Address Lookup Table for Flashloan Arb        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`\nPayer: ${payer.publicKey.toBase58()}`);
  console.log(`RPC: ${cli.rpcUrl}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / 1e9} SOL`);
  if (balance < cli.fundLamports + 5000) {
    throw new Error(`Insufficient balance. Need at least ${(cli.fundLamports + 5000) / 1e9} SOL`);
  }

  const accounts = collectAccountsForLut(payer, cli.extraAccounts);
  if (accounts.length > cli.maxAccounts) {
    throw new Error(`Too many accounts (${accounts.length}). Max is ${cli.maxAccounts}.`);
  }

  const result = await createAndExtendLut(connection, payer, accounts, cli.fundLamports);

  console.log(`\n✅ Lookup Table Created Successfully`);
  console.log(`   Address: ${result.lutAddress}`);
  console.log(`   Accounts stored: ${result.accountCount}`);
  console.log(`   Creation signature: ${result.signature}`);

  if (cli.output) {
    const fs = require('fs');
    const out = {
      lutAddress: result.lutAddress,
      createdAt: new Date().toISOString(),
      payer: payer.publicKey.toBase58(),
      rpcUrl: cli.rpcUrl,
      signature: result.signature,
      accountCount: result.accountCount,
      accounts: accounts.map((a) => ({ address: a.pubkey.toBase58(), label: a.label })),
    };
    fs.writeFileSync(cli.output, JSON.stringify(out, null, 2));
    console.log(`   LUT metadata saved to: ${cli.output}`);
  }

  console.log(`\n📎 USAGE:`);
  console.log(`   Pass this LUT to your simulation:`);
  console.log(`     --lookupTables ${result.lutAddress}`);
  console.log(`\n   Or in code:`);
  console.log(`     const lut = await connection.getAddressLookupTable(new PublicKey('${result.lutAddress}'));`);
  console.log(`     const lookupTableAccounts = [lut.value];`);
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */
module.exports = {
  parseArgs,
  loadWallet,
  collectAccountsForLut,
  createAndExtendLut,
  PROGRAMS,
  COMMON_MINTS,
  JITO_TIP_ACCOUNTS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ Fatal error:', err.stack || err.message);
    process.exit(1);
  });
}
