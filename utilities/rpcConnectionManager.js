'use strict';
require('dotenv').config();
const { Connection } = require('@solana/web3.js');


const DEFAULT_COMMITMENT = 'confirmed';
const FAILURE_COOLDOWN_MS = 15_000;

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function buildHeliusRpcUrl(endpoint, apiKey) {
  const base = String(endpoint || '').trim();
  if (!base) return null;

  if (!apiKey || String(apiKey).trim() === '') {
    return base;
  }

  if (base.includes('api-key=')) {
    return base;
  }

  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}api-key=${encodeURIComponent(String(apiKey).trim())}`;
}

function collectHeliusRpcUrls() {
  return [
    buildHeliusRpcUrl(process.env.HELIUS_ENDPOINT1, process.env.HELIUS_API_KEY1),
    buildHeliusRpcUrl(process.env.HELIUS_ENDPOINT2, process.env.HELIUS_API_KEY2),
    buildHeliusRpcUrl(process.env.HELIUS_ENDPOINT3, process.env.HELIUS_API_KEY3),
  ].filter(Boolean);
}

function getConfiguredRpcUrls() {
  return unique([
    ...collectHeliusRpcUrls(),
    process.env.RPC_URL,
    process.env.RPC
  ]);
}

class RpcConnectionManager {
  constructor(options = {}) {
    const urls = unique(options.urls && options.urls.length ? options.urls : getConfiguredRpcUrls());
    this.endpoints = urls.map((url) => ({
      url,
      connection: new Connection(url, { commitment: options.commitment || DEFAULT_COMMITMENT }),
      failures: 0,
      lastErrorAt: 0,
      successCount: 0,
    }));
    this.cursor = 0;
    this.commitment = options.commitment || DEFAULT_COMMITMENT;
  }

  hasEndpoints() {
    return this.endpoints.length > 0;
  }

  listEndpoints() {
    return this.endpoints.map((entry) => ({
      url: entry.url,
      failures: entry.failures,
      successCount: entry.successCount,
      lastErrorAt: entry.lastErrorAt || null,
    }));
  }

  isCoolingDown(entry) {
    if (!entry.lastErrorAt) return false;
    return (Date.now() - entry.lastErrorAt) < FAILURE_COOLDOWN_MS;
  }

  getNextEndpoint() {
    if (!this.endpoints.length) return null;

    const total = this.endpoints.length;
    for (let i = 0; i < total; i += 1) {
      const index = (this.cursor + i) % total;
      const candidate = this.endpoints[index];
      if (!this.isCoolingDown(candidate)) {
        this.cursor = (index + 1) % total;
        return candidate;
      }
    }

    const fallback = this.endpoints[this.cursor % total];
    this.cursor = (this.cursor + 1) % total;
    return fallback;
  }

  markSuccess(entry) {
    if (!entry) return;
    entry.successCount += 1;
    entry.failures = 0;
    entry.lastErrorAt = 0;
  }

  markFailure(entry, error) {
    if (!entry) return;
    entry.failures += 1;
    entry.lastErrorAt = Date.now();
    if (error?.message) {
      const short = error.message.slice(0, 120);
      console.warn(`[RPC] ${entry.url} failed: ${short}`);
    }
  }

  async invoke(method, args = [], options = {}) {
    if (!this.endpoints.length) {
      throw new Error('No RPC endpoints configured');
    }

    const tried = new Set();
    let lastError = null;
    const maxAttempts = Math.min(
      this.endpoints.length,
      Math.max(1, Number(options.maxAttempts || this.endpoints.length))
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const endpoint = this.getNextEndpoint();
      if (!endpoint || tried.has(endpoint.url)) continue;
      tried.add(endpoint.url);

      try {
        const value = await endpoint.connection[method](...args);
        this.markSuccess(endpoint);
        return value;
      } catch (error) {
        lastError = error;
        this.markFailure(endpoint, error);
      }
    }

    throw lastError || new Error(`RPC call failed for ${method}`);
  }

  getCurrentConnection() {
    const endpoint = this.getNextEndpoint() || this.endpoints[0];
    return endpoint ? endpoint.connection : null;
  }

  async getAccountInfo(...args) {
    return this.invoke('getAccountInfo', args);
  }

  async getMultipleAccountsInfo(...args) {
    return this.invoke('getMultipleAccountsInfo', args);
  }

  async getProgramAccounts(...args) {
    return this.invoke('getProgramAccounts', args);
  }

  async getTokenAccountBalance(...args) {
    return this.invoke('getTokenAccountBalance', args);
  }

  async getLatestBlockhash(...args) {
    return this.invoke('getLatestBlockhash', args);
  }

  async getBalance(...args) {
    return this.invoke('getBalance', args);
  }
}

function createRpcConnection(options = {}) {
  const manager = new RpcConnectionManager(options);
  const baseConnection = manager.getCurrentConnection();

  if (!baseConnection) return null;

  return new Proxy(baseConnection, {
    get(target, prop, receiver) {
      if (prop === '__rpcManager') return manager;
      if (prop === 'listEndpoints') return manager.listEndpoints.bind(manager);
      if (prop === 'getCurrentConnection') return manager.getCurrentConnection.bind(manager);
      if (prop === 'getAccountInfo') return manager.getAccountInfo.bind(manager);
      if (prop === 'getMultipleAccountsInfo') return manager.getMultipleAccountsInfo.bind(manager);
      if (prop === 'getProgramAccounts') return manager.getProgramAccounts.bind(manager);
      if (prop === 'getTokenAccountBalance') return manager.getTokenAccountBalance.bind(manager);
      if (prop === 'getLatestBlockhash') return manager.getLatestBlockhash.bind(manager);
      if (prop === 'getBalance') return manager.getBalance.bind(manager);

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return value.bind(manager.getCurrentConnection() || target);
      }
      return value;
    },
  });
}
module.exports = RpcConnectionManager;
module.exports = {
  createRpcConnection,
  getConfiguredRpcUrls,
  collectHeliusRpcUrls,
  buildHeliusRpcUrl,
  unique
};
