#!/usr/bin/env node
'use strict';
/**
 * prepareKaminoReserve.js
 *
 * Prepares Kamino reserve account data for flashloan execution.
 *
 * For a flashloan, you need to identify the Kamino lending reserve that
 * holds the token you want to borrow (typically SOL or USDC). This script:
 *
 *   1. Finds the reserve address by scanning Kamino reserve accounts
 *   2. Fetches the reserve account from RPC and decodes its structure
 *   3. Outputs a properly formatted reserve-detail JSON for the flashloan
 *      pipeline
 *
 * USAGE:
 *   # If you know the reserve address:
 *   node flashloanSubmit/prepareKaminoReserve.js --reserve <RESERVE_ADDRESS> --mint <MINT>
 *
 *   # If you know the lending market and mint:
 *   node flashloanSubmit/prepareKaminoReserve.js --market <MARKET_ADDRESS> --mint So11111111111111111111111111111111111111112
 *
 *   # If you only know the mint, scan all Kamino reserves:
 *   node flashloanSubmit/prepareKaminoReserve.js --mint SOL --output kamino_sol_reserve.json
 *
 *   # If you have a Kamino API key (preferred — gets live data):
 *   node flashloanSubmit/prepareKaminoReserve.js --mint USDC --apiKey <KEY>
 *
 * OUTPUT:
 *   Prints the reserve-detail JSON to stdout and optionally saves to file.
 *   This JSON is consumed by kaminoReserveResolver.js to build
 *   { borrowAccounts, repayAccounts }.
 */

const {
  Connection,
  PublicKey,
  Keypair,
} = require('@solana/web3.js');

const {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const { Reserve } = require('@kamino-finance/klend-sdk');
const {
  createRpcConnection,
  getConfiguredRpcUrls,
} = require('../utilities/rpcConnectionManager');

try { require('dotenv').config(); } catch (_e) { }

const env = (() => {
  try { return require('./env-update'); } catch (_e) { return null; }
})();

/* -------------------------------------------------------------------------- */
/*                             Kamino constants                               */
/* -------------------------------------------------------------------------- */

const KAMINO_LENDING_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoSw8b1zWzGvNfRj6Q2uHvXN4e8fQ');

// Known Kamino lending markets on mainnet. Used only when --market is provided
// or as a legacy named value; the default CLI path scans all reserves by mint.
const KNOWN_MARKETS = {
  main: '7u3HeHVY9rzDBjufT8KDKpNZCA7wRTkPnhy4c6cWBj9Z',
  alt1: '7u3HeHVY9rzDBjufT8KDKpNZCA7wRTkPnhy4c6cWBj9Z', // same market, different reserves
};

const MINT_ALIASES = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

/* -------------------------------------------------------------------------- */
/*                             CLI helpers                                    */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {
    rpcUrl: env?.getRpcUrl?.() || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    reserve: '',
    market: '',
    mint: 'So11111111111111111111111111111111111111112',
    apiKey: process.env.KAMINO_API_KEY || '',
    output: '',
    payer: '',
    userLiquidityAccount: '',
    allowPlaceholder: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2).toLowerCase();
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? argv[++i] : 'true';
    if (key === 'reserve') out.reserve = value;
    if (key === 'market') out.market = value;
    if (key === 'mint') out.mint = value;
    if (key === 'apikey') out.apiKey = value;
    if (key === 'output') out.output = value;
    if (key === 'payer') out.payer = value;
    if (key === 'userliquidityaccount') out.userLiquidityAccount = value;
    if (key === 'rpc' || key === 'rpcurl' || key === 'rpc-url') out.rpcUrl = value;
    if (key === 'allowplaceholder' || key === 'allow-placeholder') out.allowPlaceholder = value === 'true';
  }
  out.mint = normalizeMint(out.mint);
  return out;
}

function loadWallet() {
  if (env?.loadKeypair) return env.loadKeypair();
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY not set');
  if (pk.includes(',')) {
    return Keypair.fromSecretKey(new Uint8Array(pk.split(',').map(Number)));
  }
  throw new Error('PRIVATE_KEY must be comma-separated bytes');
}

/* -------------------------------------------------------------------------- */
/*                         Reserve derivation                                 */
/* -------------------------------------------------------------------------- */

function deriveReserveAddress(lendingMarket, mint) {
  void lendingMarket;
  void mint;
  throw new Error(
    'Kamino reserve accounts are not derived from lendingMarket + mint. ' +
    'Use findReserveInMarket(), pass --reserve, or run this CLI with --market and --mint.'
  );
}

function deriveLendingMarketAuthority(lendingMarket) {
  const marketPubkey = new PublicKey(lendingMarket);
  const [authorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), marketPubkey.toBuffer()],
    KAMINO_LENDING_PROGRAM_ID
  );
  return authorityPda.toBase58();
}

function deriveReserveLiquiditySupply(reserve) {
  const reservePubkey = new PublicKey(reserve);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reserve_liq_supply'), reservePubkey.toBuffer()],
    KAMINO_LENDING_PROGRAM_ID
  );
  return pda.toBase58();
}

function deriveReserveLiquidityFeeReceiver(reserve) {
  const reservePubkey = new PublicKey(reserve);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_receiver'), reservePubkey.toBuffer()],
    KAMINO_LENDING_PROGRAM_ID
  );
  return pda.toBase58();
}

/* -------------------------------------------------------------------------- */
/*                         RPC reserve fetcher                                */
/* -------------------------------------------------------------------------- */

/**
 * Decode a Kamino reserve account from raw buffer.
 * This is a best-effort manual decoder. For production, use the
 * Kamino SDK or a proper IDL parser.
 */
function decodeKaminoReserve(buffer, reserveAddress) {
  if (!buffer || buffer.length < 8) {
    throw new Error('Reserve account data too small — is this a Kamino reserve?');
  }

  const reserve = Reserve.decode(buffer);
  const liquidity = reserve.liquidity || {};

  return {
    version: reserve.version?.toString?.() || String(reserve.version || ''),
    address: reserveAddress,
    lendingMarket: toPubkeyString(reserve.lendingMarket),
    reserveLiquidityMint: toPubkeyString(liquidity.mintPubkey),
    reserveLiquiditySupply: toPubkeyString(liquidity.supplyVault),
    reserveLiquidityFeeReceiver: toPubkeyString(liquidity.feeVault),
    tokenProgram: toPubkeyString(liquidity.tokenProgram),
    availableAmount: liquidity.availableAmount?.toString?.() || '',
    _raw: {
      dataLength: buffer.length,
      hexPrefix: buffer.slice(0, 16).toString('hex'),
    },
  };
}

async function fetchReserveFromRpc(connection, reserveAddress) {
  const pubkey = new PublicKey(reserveAddress);
  const accountInfo = await connection.getAccountInfo(pubkey, 'confirmed');
  if (!accountInfo) {
    throw new Error(`Reserve account not found on-chain: ${reserveAddress}`);
  }

  console.log(`   Account size: ${accountInfo.data.length} bytes`);
  console.log(`   Owner: ${accountInfo.owner.toBase58()}`);

  if (!accountInfo.owner.equals(KAMINO_LENDING_PROGRAM_ID)) {
    throw new Error(
      `Account owner is ${accountInfo.owner.toBase58()}, not Kamino lending program (${KAMINO_LENDING_PROGRAM_ID.toBase58()}). ` +
      `This may not be a valid Kamino reserve.`
    );
  }

  return decodeKaminoReserve(accountInfo.data, reserveAddress);
}

async function findReserveInMarket(connection, lendingMarket, mint) {
  const marketPubkey = new PublicKey(lendingMarket);
  const mintPubkey = new PublicKey(normalizeMint(mint));
  const dataSize = Reserve.layout.span + 8;
  const lendingMarketOffset = 8 + 8 + 16;

  const accounts = await connection.getProgramAccounts(KAMINO_LENDING_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [
      { dataSize },
      {
        memcmp: {
          offset: lendingMarketOffset,
          bytes: marketPubkey.toBase58(),
        },
      },
    ],
  });

  const matches = [];
  for (const account of accounts) {
    let decoded;
    try {
      decoded = decodeKaminoReserve(account.account.data, account.pubkey.toBase58());
    } catch (_e) {
      continue;
    }
    if (decoded.reserveLiquidityMint === mintPubkey.toBase58()) {
      matches.push(decoded);
    }
  }

  matches.sort((a, b) => compareBigIntDesc(a.availableAmount, b.availableAmount));
  return matches;
}

async function findReservesByMint(connection, mint) {
  const mintPubkey = new PublicKey(normalizeMint(mint));
  const dataSize = Reserve.layout.span + 8;

  const accounts = await connection.getProgramAccounts(KAMINO_LENDING_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [{ dataSize }],
  });

  const matches = [];
  for (const account of accounts) {
    let decoded;
    try {
      decoded = decodeKaminoReserve(account.account.data, account.pubkey.toBase58());
    } catch (_e) {
      continue;
    }
    if (decoded.reserveLiquidityMint === mintPubkey.toBase58()) {
      matches.push(decoded);
    }
  }

  matches.sort((a, b) => compareBigIntDesc(a.availableAmount, b.availableAmount));
  return matches;
}

/* -------------------------------------------------------------------------- */
/*                         Kamino API fetcher                                 */
/* -------------------------------------------------------------------------- */

async function fetchReserveFromApi(mint, apiKey) {
  if (!apiKey) {
    throw new Error('Kamino API key required. Set KAMINO_API_KEY env var or pass --apiKey');
  }

  // Kamino API endpoint (v2)
  const url = `https://api.kamino.finance/v2/reserves?mint=${mint}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Kamino API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No reserves found for mint ${mint}`);
  }

  // Return the first active reserve
  const reserve = data[0];
  return {
    address: reserve.address || reserve.reserve || '',
    lendingMarket: reserve.lendingMarket || reserve.market || '',
    reserveLiquidityMint: reserve.reserveLiquidityMint || reserve.liquidityMint || mint,
    reserveLiquiditySupply: reserve.reserveLiquiditySupply || reserve.liquiditySupply || '',
    reserveLiquidityFeeReceiver: reserve.reserveLiquidityFeeReceiver || reserve.feeReceiver || '',
    _apiSource: true,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Output formatter                                   */
/* -------------------------------------------------------------------------- */

function buildReserveDetail(reserveData, opts = {}) {
  const lendingMarket = reserveData.lendingMarket;
  const reserve = reserveData.address || reserveData.reserve || '';
  const reserveLiquidityMint = reserveData.reserveLiquidityMint || opts.mint || '';
  const reserveLiquiditySupply = reserveData.reserveLiquiditySupply || '';
  const reserveLiquidityFeeReceiver = reserveData.reserveLiquidityFeeReceiver || '';
  const tokenProgram = reserveData.tokenProgram || TOKEN_PROGRAM_ID.toBase58();

  if (!lendingMarket || !reserve || !reserveLiquidityMint) {
    throw new Error(
      'Incomplete reserve data. Required: lendingMarket, reserve/reserveAddress, reserveLiquidityMint.\n' +
      'Got: ' + JSON.stringify(reserveData, null, 2)
    );
  }
  if (!reserveLiquiditySupply || !reserveLiquidityFeeReceiver) {
    throw new Error(
      'Incomplete reserve data. Required for flashloan accounts: reserveLiquiditySupply and reserveLiquidityFeeReceiver.\n' +
      'Got: ' + JSON.stringify(reserveData, null, 2)
    );
  }

  // Derive the lending market authority
  const lendingMarketAuthority = deriveLendingMarketAuthority(lendingMarket);

  // Derive user ATA if payer provided
  let userLiquidityAccount = opts.userLiquidityAccount || '';
  if (!userLiquidityAccount && opts.payer) {
    try {
      userLiquidityAccount = getAssociatedTokenAddressSync(
        new PublicKey(reserveLiquidityMint),
        new PublicKey(opts.payer),
        false,
        new PublicKey(tokenProgram)
      ).toBase58();
    } catch (err) {
      throw new Error(`Unable to derive userLiquidityAccount from payer ${opts.payer}: ${err.message}`);
    }
  }

  return {
    lendingMarket,
    lendingMarketAuthority,
    reserve,
    reserveLiquidityMint,
    reserveLiquiditySupply,
    reserveLiquidityFeeReceiver,
    userLiquidityAccount,
    tokenProgram,
    kaminoProgramId: KAMINO_LENDING_PROGRAM_ID.toBase58(),
    generatedAt: new Date().toISOString(),
    _source: reserveData._apiSource ? 'kamino-api' : 'rpc-decode',
    _raw: reserveData._raw || null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Main                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const connection = createBotConnection(cli.rpcUrl);

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Prepare Kamino Reserve for Flashloan Execution       ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`\nMint: ${cli.mint}`);
  console.log(`RPC: ${redactUrl(cli.rpcUrl)}`);
  if (typeof connection.listEndpoints === 'function') {
    console.log(`RPC endpoints configured: ${connection.listEndpoints().length}`);
  }

  let reserveData;

  // --- Path 1: Direct reserve address ---
  if (cli.reserve) {
    console.log(`\n🔍 Fetching reserve from RPC: ${cli.reserve}`);
    reserveData = await fetchReserveFromRpc(connection, cli.reserve);
  }
  // --- Path 2: Derive from market + mint ---
  else if (cli.market) {
    console.log(`\n🔍 Scanning Kamino market reserves`);
    console.log(`   Lending market: ${cli.market}`);
    const matches = await findReserveInMarket(connection, cli.market, cli.mint);
    if (!matches.length) {
      throw new Error(`No Kamino reserve found for mint ${cli.mint} in market ${cli.market}`);
    }
    reserveData = matches[0];
    console.log(`   Found reserve: ${reserveData.address}`);
    if (matches.length > 1) {
      console.log(`   Multiple matches found: ${matches.length}; using largest available liquidity.`);
    }
  }
  // --- Path 3: Kamino API ---
  else if (cli.apiKey) {
    console.log(`\n🔍 Fetching reserve from Kamino API for mint: ${cli.mint}`);
    reserveData = await fetchReserveFromApi(cli.mint, cli.apiKey);
  }
  // --- Path 4: Scan all Kamino reserves by mint ---
  else {
    console.log(`\n🔍 Scanning all Kamino reserves for mint`);
    const matches = await findReservesByMint(connection, cli.mint);
    if (!matches.length) {
      if (!cli.allowPlaceholder) {
        throw new Error(`No Kamino reserve found for mint ${cli.mint}`);
      }
      reserveData = {
        address: '',
        lendingMarket: KNOWN_MARKETS.main,
        reserveLiquidityMint: cli.mint,
        reserveLiquiditySupply: '',
        reserveLiquidityFeeReceiver: '',
      };
    } else {
      reserveData = matches[0];
      console.log(`   Found reserve: ${reserveData.address}`);
      console.log(`   Lending market: ${reserveData.lendingMarket}`);
      if (matches.length > 1) {
        console.log(`   Multiple matches found: ${matches.length}; using largest available liquidity.`);
      }
    }
  }

  // Build output
  const payer = cli.payer || (env?.getPayerPublicKey?.() || '');
  const detail = buildReserveDetail(reserveData, {
    mint: cli.mint,
    payer,
    userLiquidityAccount: cli.userLiquidityAccount,
  });

  // Print
  console.log(`\n📋 Reserve Detail (for flashloan pipeline):`);
  console.log(JSON.stringify(detail, null, 2));

  // Save
  if (cli.output) {
    const fs = require('fs');
    fs.writeFileSync(cli.output, JSON.stringify(detail, null, 2));
    console.log(`\n💾 Saved to: ${cli.output}`);
  }

  // Print usage
  console.log(`\n📎 USAGE:`);
  console.log(`   Pass this file to simulateExecutionBundle.js:`);
  console.log(`     --reserveDetail ${cli.output || '<file>'}`);
  if (detail.userLiquidityAccount) {
    console.log(`     (userLiquidityAccount auto-derived: ${short(detail.userLiquidityAccount)})`);
  } else {
    console.log(`     --userLiquidityAccount <YOUR_ATA_FOR_${cli.mint.slice(0, 6)}..>`);
  }
}

function short(addr) {
  return addr ? `${addr.slice(0, 6)}..${addr.slice(-4)}` : '-';
}

function normalizeMint(mint) {
  const value = String(mint || '').trim();
  return MINT_ALIASES[value.toUpperCase()] || value;
}

function toPubkeyString(value) {
  if (!value) return '';
  if (value instanceof PublicKey) return value.toBase58();
  return String(value);
}

function compareBigIntDesc(a, b) {
  const av = safeBigInt(a);
  const bv = safeBigInt(b);
  if (av === bv) return 0;
  return av > bv ? -1 : 1;
}

function safeBigInt(value) {
  try {
    return BigInt(String(value || '0'));
  } catch (_e) {
    return 0n;
  }
}

function createBotConnection(rpcUrl) {
  const urls = [
    rpcUrl,
    ...getConfiguredRpcUrls(),
  ].filter(Boolean);
  return createRpcConnection({ urls, commitment: 'confirmed' }) || new Connection(rpcUrl, { commitment: 'confirmed' });
}

function redactUrl(url) {
  return String(url || '').replace(/api-key=([^&]+)/gi, 'api-key=<redacted>');
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */
module.exports = {
  parseArgs,
  loadWallet,
  deriveReserveAddress,
  deriveLendingMarketAuthority,
  deriveReserveLiquiditySupply,
  deriveReserveLiquidityFeeReceiver,
  fetchReserveFromRpc,
  findReserveInMarket,
  findReservesByMint,
  fetchReserveFromApi,
  buildReserveDetail,
  KAMINO_LENDING_PROGRAM_ID,
  KNOWN_MARKETS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ Fatal error:', err.stack || err.message);
    process.exit(1);
  });
}
//. node flashloanSubmit/prepareKaminoReserve.js
