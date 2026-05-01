'use strict';
/**
 * jitoClient.js
 *
 * Jito block engine client for bundle submission.
 *
 * Handles missing `jito-js-rpc` dependency gracefully:
 *   - If jito-js-rpc is installed, uses it directly.
 *   - If not installed, provides a stub that throws a descriptive error
 *     only when you actually try to submit, so the rest of the pipeline
 *     (building, simulating) still works.
 */

const { PublicKey, SystemProgram } = require('@solana/web3.js');

// Lazy-load env to avoid circular deps at module init
function lazyEnv() {
  try {
    return require('./env');
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  jito-js-rpc integration (with fallback)
// ---------------------------------------------------------------------------

let JitoJsonRpcClient = null;
try {
  const mod = require('jito-js-rpc');
  JitoJsonRpcClient = mod.JitoJsonRpcClient || mod;
} catch (_e) {
  // jito-js-rpc not installed — stub will be used
}

function createJitoClient() {
  const env = lazyEnv();
  const url = env?.getJitoBlockEngineUrl?.() || process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf/api/v1';
  const uuid = env?.getJitoUuid?.() || process.env.JITO_UUID || '';

  if (!JitoJsonRpcClient) {
    return new StubJitoClient(url, uuid);
  }

  return new JitoJsonRpcClient(url, uuid);
}

// Stub client that throws descriptive errors when called
class StubJitoClient {
  constructor(url, uuid) {
    this.url = url;
    this.uuid = uuid;
  }

  _throw() {
    throw new Error(
      'jito-js-rpc is not installed.\n' +
      'To submit bundles via Jito, install it:\n' +
      '  npm install jito-js-rpc\n\n' +
      'Or submit via RPC directly using tradeExecute.js sendDirect().'
    );
  }

  getRandomTipAccount() { this._throw(); }
  sendBundle() { this._throw(); }
  sendTxn() { this._throw(); }
  simulateBundle() { this._throw(); }
}

// ---------------------------------------------------------------------------
//  Tip account helpers
// ---------------------------------------------------------------------------

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZR2zFv5',
  'Cw8CFyM9FkoMi7G7hiqxXejYNLih3GXqKMpzinA4pwjb',
  '3AVi9WGA8qahFz2iK3e6vTcSt4BRd4iB8tY6i3A4pGrA',
  '6ZjyhETZ4E8W6C6Dz6Dz6Dz6Dz6Dz6Dz6Dz6Dz6Dz6D',
];

function getJitoTipAccount(index = null) {
  const idx = index !== null ? index : Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[idx % JITO_TIP_ACCOUNTS.length]);
}

async function fetchTipAccount(_client) {
  return getJitoTipAccount();
}

async function buildJitoTipInstruction(payer, lamports, _client) {
  const tipAccount = await fetchTipAccount();
  const env = lazyEnv();
  const tipLamports = Math.max(1000, Number(lamports || env?.getJitoTipLamports?.() || 1000));
  return SystemProgram.transfer({
    fromPubkey: payer.publicKey || payer,
    toPubkey: tipAccount,
    lamports: tipLamports,
  });
}

// ---------------------------------------------------------------------------
//  Bundle submission helpers
// ---------------------------------------------------------------------------

async function sendBundleBase64(encodedTransactions, client) {
  const c = client || createJitoClient();
  if (!Array.isArray(encodedTransactions) || !encodedTransactions.length) {
    throw new Error('sendBundleBase64 requires at least one base64 encoded transaction');
  }
  return c.sendBundle([encodedTransactions, { encoding: 'base64' }]);
}

async function sendSingleTransactionBase64(encodedTransaction, { bundleOnly = true } = {}, client) {
  const c = client || createJitoClient();
  return c.sendTxn([encodedTransaction, { encoding: 'base64' }], bundleOnly);
}

async function simulateBundle(transactions, client) {
  const c = client || createJitoClient();
  if (typeof c.simulateBundle === 'function') {
    return c.simulateBundle(transactions);
  }
  return { landingProbability: null, error: 'simulateBundle not available in this client' };
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

module.exports = {
  createJitoClient,
  fetchTipAccount,
  buildJitoTipInstruction,
  sendBundleBase64,
  sendSingleTransactionBase64,
  simulateBundle,
  getJitoTipAccount,
  JITO_TIP_ACCOUNTS,
};
