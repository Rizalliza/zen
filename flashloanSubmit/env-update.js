'use strict';
/**
 * env.js
 *
 * Environment configuration loader for the flashloan submission pipeline.
 *
 * This file centralizes all environment-dependent configuration:
 *   - RPC endpoints
 *   - Wallet keypair
 *   - Jito block engine settings
 *   - Compute budget defaults
 *   - Priority fee / tip defaults
 *
 * It reads from process.env (via dotenv) and provides typed accessors.
 * If a required variable is missing, it throws a descriptive error telling
 * you exactly which env var to set.
 */

// Load .env if dotenv is available
try {
  require('dotenv').config();
} catch (_e) {
  // dotenv not installed — proceed with process.env only
}

const fs = require('fs');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');

/* -------------------------------------------------------------------------- */
/*                             Required env vars                              */
/* -------------------------------------------------------------------------- */

function requireEnv(name, example = '') {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `  Set it in your .env file or export it:\n` +
      `    export ${name}=${example || '<value>'}\n`
    );
  }
  return String(value).trim();
}

function getEnv(name, fallback = null) {
  const value = process.env[name];
  if (!value || !String(value).trim()) return fallback;
  return String(value).trim();
}

/* -------------------------------------------------------------------------- */
/*                              RPC configuration                             */
/* -------------------------------------------------------------------------- */

function getRpcUrl() {
  return getEnv('RPC_URL', getEnv('ALCHEMY_RPC_URL', 'https://api.mainnet-beta.solana.com'));
}

function getConfiguredRpcUrls() {
  const urls = [];
  const primary = getEnv('RPC_URL');
  const alchemy = getEnv('ALCHEMY_RPC_URL');
  const fallback = getEnv('FALLBACK_RPC_URL');
  if (primary) urls.push(primary);
  if (alchemy && alchemy !== primary) urls.push(alchemy);
  if (fallback && !urls.includes(fallback)) urls.push(fallback);
  return urls;
}

/* -------------------------------------------------------------------------- */
/*                             Wallet keypair                                  */
/* -------------------------------------------------------------------------- */

function loadKeypair() {
  // Option 1: comma-separated byte array
  const byteStr = getEnv('PRIVATE_KEY');
  if (byteStr && byteStr.includes(',')) {
    const bytes = byteStr.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (bytes.length === 64) {
      return Keypair.fromSecretKey(new Uint8Array(bytes));
    }
  }

  // Option 2: base58-encoded secret key
  if (byteStr && byteStr.length > 30 && !byteStr.includes(',')) {
    try {
      const decoded = require('bs58')?.decode(byteStr);
      if (decoded && decoded.length >= 64) {
        return Keypair.fromSecretKey(decoded.slice(0, 64));
      }
    } catch (_e) {
      // not base58 or bs58 not installed
    }
  }

  // Option 3: keypair file path
  const keypairPath = getEnv('KEYPAIR_PATH');
  if (keypairPath && fs.existsSync(keypairPath)) {
    const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
    if (Array.isArray(raw)) {
      return Keypair.fromSecretKey(new Uint8Array(raw));
    }
  }

  throw new Error(
    'Wallet keypair not found. Set one of the following in your .env:\n' +
    '  PRIVATE_KEY=1,2,3,...,64   (comma-separated byte array, 64 bytes)\n' +
    '  PRIVATE_KEY=<base58>      (base58-encoded secret key)\n' +
    '  KEYPAIR_PATH=/path/id.json (Solana keypair JSON file)'
  );
}

/* -------------------------------------------------------------------------- */
/*                             Jito configuration                             */
/* -------------------------------------------------------------------------- */

function getJitoBlockEngineUrl() {
  return getEnv('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf/api/v1');
}

function getJitoUuid() {
  return getEnv('JITO_UUID', '');
}

function getJitoTipLamports() {
  const raw = getEnv('JITO_TIP_LAMPORTS', '10000');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

/* -------------------------------------------------------------------------- */
/*                          Compute budget defaults                           */
/* -------------------------------------------------------------------------- */

function getComputeUnitLimit() {
  const raw = getEnv('COMPUTE_UNIT_LIMIT', '1400000');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1400000;
}

function getPriorityFeeMicroLamports() {
  const raw = getEnv('PRIORITY_FEE_MICRO_LAMPORTS', '50000');
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 50000;
}

/* -------------------------------------------------------------------------- */
/*                            Helper accessors                                */
/* -------------------------------------------------------------------------- */

function getPayerPublicKey() {
  try {
    return loadKeypair().publicKey.toBase58();
  } catch (_e) {
    return null;
  }
}

function printEnvSummary() {
  console.log('Environment summary:');
  console.log(`  RPC_URL:            ${getRpcUrl()}`);
  console.log(`  JITO_BLOCK_ENGINE:  ${getJitoBlockEngineUrl()}`);
  console.log(`  PAYER:              ${getPayerPublicKey() || '(not loaded)'}`);
  console.log(`  COMPUTE_UNIT_LIMIT: ${getComputeUnitLimit()}`);
  console.log(`  PRIORITY_FEE:       ${getPriorityFeeMicroLamports()} micro-lamports`);
  console.log(`  JITO_TIP:           ${getJitoTipLamports()} lamports`);
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
  // RPC
  getRpcUrl,
  getConfiguredRpcUrls,

  // Wallet
  loadKeypair,
  getPayerPublicKey,

  // Jito
  getJitoBlockEngineUrl,
  getJitoUuid,
  getJitoTipLamports,

  // Compute budget
  getComputeUnitLimit,
  getPriorityFeeMicroLamports,

  // Utilities
  getEnv,
  requireEnv,
  printEnvSummary,
};
