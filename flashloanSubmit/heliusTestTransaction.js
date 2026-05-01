'use strict';

const {
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  PublicKey,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const env = require('./env-update');
const {
  createRpcConnection,
  getConfiguredRpcUrls,
} = require('../utilities/rpcConnectionManager');

const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
];

function parseArgs(argv) {
  const out = {
    recipient: '',
    transferSol: '0',
    tipLamports: env.getJitoTipLamports(),
    computeUnits: env.getComputeUnitLimit(),
    priorityFeeMicroLamports: env.getPriorityFeeMicroLamports(),
    dryRun: false,
    simulate: true,
    send: false,
    skipPreflight: true,
    maxRetries: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2).toLowerCase();
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? argv[++i] : 'true';

    if (key === 'recipient') out.recipient = value;
    if (key === 'transfersol') out.transferSol = value;
    if (key === 'tipsol') out.tipSol = value;
    if (key === 'tiplamports') out.tipLamports = Number(value || out.tipLamports);
    if (key === 'computeunits') out.computeUnits = Number(value || out.computeUnits);
    if (key === 'priorityfeemicrolamports') out.priorityFeeMicroLamports = Number(value || out.priorityFeeMicroLamports);
    if (key === 'dryrun') out.dryRun = value === 'true';
    if (key === 'simulate') out.simulate = value === 'true';
    if (key === 'send') out.send = value === 'true';
    if (key === 'skippreflight') out.skipPreflight = value === 'true';
    if (key === 'maxretries') out.maxRetries = Number(value || out.maxRetries);
  }

  return out;
}

function lamportsFromSol(value) {
  const sol = Number(value || 0);
  if (!Number.isFinite(sol) || sol < 0) {
    throw new Error(`Invalid SOL amount: ${value}`);
  }
  return Math.round(sol * LAMPORTS_PER_SOL);
}

function getHeliusSenderUrl() {
  const direct = process.env.HELIUS_SENDER_URL || process.env.HELIUS_SENDER_ENDPOINT;
  if (direct) return direct;

  const apiKey =
    process.env.HELIUS_SENDER_API_KEY
    || process.env.HELIUS_API_KEY
    || process.env.HELIUS_API_KEY1
    || extractApiKeyFromUrl(process.env.HELIUS_ENDPOINT1)
    || extractApiKeyFromUrl(process.env.HELIUS_ENDPOINT)
    || '';
  return apiKey
    ? `https://sender.helius-rpc.com/fast?api-key=${encodeURIComponent(apiKey)}`
    : 'https://sender.helius-rpc.com/fast';
}

function redactUrl(value) {
  return String(value || '').replace(/([?&]api-key=)[^&]+/i, '$1<redacted>');
}

function extractApiKeyFromUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    return parsed.searchParams.get('api-key') || '';
  } catch (_error) {
    return '';
  }
}

function pickTipAccount() {
  return new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]);
}

function createBotConnection() {
  const urls = getConfiguredRpcUrls();
  const connection = createRpcConnection({ urls, commitment: 'confirmed' });
  if (!connection) {
    throw new Error('No RPC endpoints configured. Set HELIUS_ENDPOINT1/RPC_URL in .env.');
  }
  return connection;
}

async function buildSmokeTransferTransaction({
  connection,
  payer,
  recipient,
  transferLamports = 0,
  tipLamports = env.getJitoTipLamports(),
  computeUnits = env.getComputeUnitLimit(),
  priorityFeeMicroLamports = env.getPriorityFeeMicroLamports(),
  recentBlockhash = null,
}) {
  if (!recipient) {
    throw new Error('recipient is required');
  }

  const recipientPubkey = new PublicKey(String(recipient));
  const tipAccount = pickTipAccount();
  const blockhash = recentBlockhash || (await connection.getLatestBlockhash('confirmed')).blockhash;
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: Number(computeUnits) }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(priorityFeeMicroLamports) }),
  ];

  if (Number(transferLamports) > 0) {
    instructions.push(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipientPubkey,
      lamports: transferLamports,
    }));
  }

  if (Number(tipLamports) > 0) {
    instructions.push(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    }));
  }

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

async function sendVersionedTransactionViaHelius(transaction, options = {}) {
  if (!(transaction instanceof VersionedTransaction)) {
    throw new Error('sendVersionedTransactionViaHelius expects a VersionedTransaction');
  }

  const senderUrl = options.senderUrl || getHeliusSenderUrl();
  const encoded = Buffer.from(transaction.serialize()).toString('base64');
  const response = await fetch(senderUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'sendTransaction',
      params: [
        encoded,
        {
          encoding: 'base64',
          skipPreflight: options.skipPreflight !== false,
          maxRetries: Number.isFinite(options.maxRetries) ? options.maxRetries : 0,
        },
      ],
    }),
  });

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message || 'Helius sender returned an error');
  }

  return {
    signature: json.result,
    senderUrl,
    senderUrlRedacted: redactUrl(senderUrl),
  };
}

async function sendSmokeTransfer(options = {}) {
  const payer = options.payer || env.loadKeypair();
  const connection = options.connection || createBotConnection();
  const transaction = await buildSmokeTransferTransaction({
    connection,
    payer,
    recipient: options.recipient,
    transferLamports: options.transferLamports ?? lamportsFromSol(options.transferSol || '0'),
    tipLamports: options.tipLamports ?? (options.tipSol != null
      ? lamportsFromSol(options.tipSol)
      : env.getJitoTipLamports()),
    computeUnits: options.computeUnits,
    priorityFeeMicroLamports: options.priorityFeeMicroLamports,
  });

  return sendVersionedTransactionViaHelius(transaction, options);
}

module.exports = {
  getHeliusSenderUrl,
  redactUrl,
  buildSmokeTransferTransaction,
  sendVersionedTransactionViaHelius,
  sendSmokeTransfer,
  createBotConnection,
};

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  const payer = env.loadKeypair();
  const connection = createBotConnection();
  const recipient = parsed.recipient || payer.publicKey.toBase58();
  const tipLamports = parsed.tipSol != null
    ? lamportsFromSol(parsed.tipSol)
    : Number(parsed.tipLamports);

  buildSmokeTransferTransaction({
    connection,
    payer,
    recipient,
    transferLamports: lamportsFromSol(parsed.transferSol),
    tipLamports,
    computeUnits: parsed.computeUnits,
    priorityFeeMicroLamports: parsed.priorityFeeMicroLamports,
    recentBlockhash: parsed.dryRun ? '11111111111111111111111111111111' : null,
  }).then(async (transaction) => {
    const serialized = Buffer.from(transaction.serialize()).toString('base64');
    if (parsed.dryRun) {
      console.log(JSON.stringify({
        senderUrlRedacted: redactUrl(getHeliusSenderUrl()),
        rpcEndpoints: connection.listEndpoints ? connection.listEndpoints().length : null,
        payer: payer.publicKey.toBase58(),
        recipient,
        transferSol: parsed.transferSol,
        tipLamports,
        computeUnits: parsed.computeUnits,
        priorityFeeMicroLamports: parsed.priorityFeeMicroLamports,
        serializedBase64Length: serialized.length,
      }, null, 2));
      return;
    }

    if (parsed.simulate) {
      const simulation = await connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
      console.log(JSON.stringify({
        mode: 'simulate',
        senderUrlRedacted: redactUrl(getHeliusSenderUrl()),
        rpcEndpoints: connection.listEndpoints ? connection.listEndpoints().length : null,
        payer: payer.publicKey.toBase58(),
        recipient,
        transferSol: parsed.transferSol,
        tipLamports,
        computeUnits: parsed.computeUnits,
        priorityFeeMicroLamports: parsed.priorityFeeMicroLamports,
        serializedBase64Length: serialized.length,
        simulation: simulation.value,
      }, null, 2));
    }

    if (!parsed.send) return;

    const result = await sendVersionedTransactionViaHelius(transaction);
    console.log(JSON.stringify({
      ...result,
      senderUrl: undefined,
      senderUrlRedacted: result.senderUrlRedacted || redactUrl(result.senderUrl),
    }, null, 2));
  }).catch((error) => {
    console.error('❌ Helius sender test failed:', error.stack || error.message);
    process.exit(1);
  });
}
