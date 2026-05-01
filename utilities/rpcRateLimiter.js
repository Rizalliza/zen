'use strict';
/**
 * rpcRateLimiter.js  (utilities/)
 *
 * Token-bucket rate limiter with 429 detection, jittered exponential backoff,
 * adaptive concurrency, and per-endpoint pacing. Wraps a Solana web3.js
 * Connection (or the createRpcConnection proxy from rpcConnectionManager) so
 * every getAccountInfo / getMultipleAccountsInfo / getProgramAccounts call
 * is paced and retried automatically.
 *
 * Why this exists
 * ---------------
 * Q_enrichment.js fans out to ~23 accounts per Whirlpool/CLMM pool
 * (2 vaults + 21 tick arrays) inside a single getMultipleAccountsInfo call,
 * and runs CONCURRENCY=8 pools in parallel. That's 8 large MGAA requests
 * per batch. Helius bills MGAA by account count on most plans and 429s on
 * burst at the dev tier. The previous "fix" deleted RPC_DELAY_MS without
 * replacing it with anything; this module is the proper replacement.
 *
 * Three independent mechanisms:
 *
 *   1. Token bucket — the request rate cap. Tokens refill at a steady
 *      rate (e.g. 50/sec for Helius dev) and a burst capacity allows short
 *      flurries. Acquiring a token blocks until one is available.
 *
 *   2. 429 backoff — when a 429 response (or its variants like
 *      "Too Many Requests" / Retry-After header) is detected, the limiter
 *      pauses ALL pending acquires on that endpoint for an exponentially
 *      growing window with jitter. Retries the failed call automatically.
 *
 *   3. Adaptive concurrency — the limiter exposes a `currentConcurrency`
 *      that callers can read. When 429 rate exceeds the threshold, it
 *      halves; when 60s passes without any 429, it ramps back up by one.
 *      This is what processInBatches should consult instead of using a
 *      fixed batchSize.
 *
 * Drop-in usage
 * -------------
 *   const { wrapConnection, createRateLimiter } = require('../utilities/rpcRateLimiter');
 *
 *   // Option A: wrap an existing Connection
 *   const limited = wrapConnection(connection, {
 *     tokensPerSecond: 50,
 *     burstCapacity: 60,
 *     maxConcurrent: 8,
 *     minConcurrent: 2,
 *     onAdaptive: (info) => console.log(`[rpc] adaptive concurrency=${info.concurrency}`),
 *   });
 *   // Use `limited` exactly like `connection`. All RPC calls go through the limiter.
 *
 *   // Option B: hand-roll for non-Connection methods
 *   const limiter = createRateLimiter({ tokensPerSecond: 50 });
 *   await limiter.execute(() => connection.getAccountInfo(pubkey));
 *
 * For multi-endpoint setups, attach a unique `endpointKey` per Connection so
 * each endpoint gets its own bucket. Or use `wrapMultiConnection` which
 * accepts an array of connections and round-robins through their limiters.
 *
 * Default tunings (Helius dev tier safe):
 *   tokensPerSecond  50
 *   burstCapacity    60
 *   maxConcurrent    8
 *   minConcurrent    2
 *   maxRetries       4
 *   baseBackoffMs    400
 *   maxBackoffMs     8000
 */

/* -------------------------------------------------------------------------- */
/*                              Helpers                                       */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function jitter(ms, fraction = 0.3) {
    const range = ms * fraction;
    return ms + (Math.random() * 2 - 1) * range;
}

function isRateLimitError(err) {
    if (!err) return false;
    // axios-style error
    const status = err.response?.status ?? err.status ?? err.statusCode ?? null;
    if (status === 429) return true;
    if (status === 503) return true; // service unavailable, treat similarly
    // web3.js fetch error string detection
    const msg = String(err.message || err.toString() || '').toLowerCase();
    if (msg.includes('429')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('rate limit')) return true;
    if (msg.includes('try again')) return true;
    return false;
}

function isRetryableError(err) {
    if (isRateLimitError(err)) return true;
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('etimedout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('socket hang up')) return true;
    if (msg.includes('network')) return true;
    return false;
}

function extractRetryAfterMs(err) {
    const header = err?.response?.headers?.['retry-after']
        ?? err?.headers?.['retry-after']
        ?? null;
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    // Could be HTTP date format; we don't bother parsing — fall back to default.
    return null;
}

/* -------------------------------------------------------------------------- */
/*                           Token bucket                                     */
/* -------------------------------------------------------------------------- */

class TokenBucket {
    constructor({ tokensPerSecond = 50, burstCapacity = 60 } = {}) {
        this.tokensPerSecond = Math.max(1, tokensPerSecond);
        this.capacity = Math.max(1, burstCapacity);
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
        this.waitQueue = [];
    }

    refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        if (elapsed > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.tokensPerSecond);
            this.lastRefill = now;
        }
    }

    async acquire(cost = 1) {
        while (true) {
            this.refill();
            if (this.tokens >= cost) {
                this.tokens -= cost;
                return;
            }
            const deficit = cost - this.tokens;
            const waitMs = Math.max(5, Math.ceil((deficit / this.tokensPerSecond) * 1000));
            await sleep(waitMs);
        }
    }

    setRate(tokensPerSecond) {
        this.tokensPerSecond = Math.max(1, tokensPerSecond);
    }
}

/* -------------------------------------------------------------------------- */
/*                       Per-endpoint limiter state                           */
/* -------------------------------------------------------------------------- */

class EndpointLimiter {
    constructor(opts = {}) {
        this.endpointKey = opts.endpointKey || 'default';
        this.bucket = new TokenBucket({
            tokensPerSecond: opts.tokensPerSecond,
            burstCapacity: opts.burstCapacity,
        });

        this.maxRetries = Math.max(0, Number(opts.maxRetries ?? 4));
        this.baseBackoffMs = Math.max(50, Number(opts.baseBackoffMs ?? 400));
        this.maxBackoffMs = Math.max(this.baseBackoffMs, Number(opts.maxBackoffMs ?? 8000));

        this.maxConcurrent = Math.max(1, Number(opts.maxConcurrent ?? 8));
        this.minConcurrent = Math.max(1, Number(opts.minConcurrent ?? 2));
        this.currentConcurrency = this.maxConcurrent;
        this.activeCount = 0;
        this.concurrencyWaitQueue = [];

        // 429 cooldown: when a 429 hits, ALL pending acquires on this endpoint
        // pause until cooldownUntil. Each retry doubles the cooldown.
        this.cooldownUntil = 0;

        // Sliding-window 429 tracking for adaptive concurrency.
        this.recent429Times = [];
        this.last429Cleanup = 0;
        this.adaptiveWindowMs = Number(opts.adaptiveWindowMs ?? 60_000);
        this.adaptiveThreshold429 = Number(opts.adaptiveThreshold429 ?? 3);
        this.lastAdaptiveAdjust = Date.now();
        this.onAdaptive = typeof opts.onAdaptive === 'function' ? opts.onAdaptive : null;

        // Stats.
        this.stats = {
            successes: 0,
            retries: 0,
            rateLimitHits: 0,
            otherErrors: 0,
            totalWaitMs: 0,
            maxObservedBackoffMs: 0,
        };
    }

    // ----------------------------------------------------------------------
    // Concurrency gate
    // ----------------------------------------------------------------------

    async _acquireConcurrency() {
        if (this.activeCount < this.currentConcurrency) {
            this.activeCount += 1;
            return;
        }
        return new Promise((resolve) => {
            this.concurrencyWaitQueue.push(resolve);
        });
    }

    _releaseConcurrency() {
        this.activeCount = Math.max(0, this.activeCount - 1);
        while (this.concurrencyWaitQueue.length > 0
            && this.activeCount < this.currentConcurrency) {
            const next = this.concurrencyWaitQueue.shift();
            this.activeCount += 1;
            next();
        }
    }

    // ----------------------------------------------------------------------
    // Cooldown handling
    // ----------------------------------------------------------------------

    async _waitForCooldown() {
        const now = Date.now();
        if (now < this.cooldownUntil) {
            const waitMs = this.cooldownUntil - now;
            this.stats.totalWaitMs += waitMs;
            await sleep(waitMs);
        }
    }

    _setCooldown(ms) {
        const target = Date.now() + ms;
        if (target > this.cooldownUntil) this.cooldownUntil = target;
        if (ms > this.stats.maxObservedBackoffMs) this.stats.maxObservedBackoffMs = ms;
    }

    // ----------------------------------------------------------------------
    // Adaptive concurrency
    // ----------------------------------------------------------------------

    _record429() {
        const now = Date.now();
        this.recent429Times.push(now);
        this.stats.rateLimitHits += 1;
        this._cleanup429Window(now);
        this._maybeAdjustConcurrency(now);
    }

    _cleanup429Window(now) {
        if (now - this.last429Cleanup < 1000) return;
        this.last429Cleanup = now;
        const cutoff = now - this.adaptiveWindowMs;
        while (this.recent429Times.length && this.recent429Times[0] < cutoff) {
            this.recent429Times.shift();
        }
    }

    _maybeAdjustConcurrency(now) {
        // Only adjust at most once per 5s.
        if (now - this.lastAdaptiveAdjust < 5000) return;
        this._cleanup429Window(now);

        const recentCount = this.recent429Times.length;
        if (recentCount >= this.adaptiveThreshold429
            && this.currentConcurrency > this.minConcurrent) {
            const old = this.currentConcurrency;
            this.currentConcurrency = Math.max(this.minConcurrent, Math.floor(this.currentConcurrency / 2));
            this.lastAdaptiveAdjust = now;
            if (this.onAdaptive) {
                this.onAdaptive({
                    endpointKey: this.endpointKey,
                    concurrency: this.currentConcurrency,
                    previous: old,
                    recent429: recentCount,
                    windowMs: this.adaptiveWindowMs,
                    reason: 'too-many-rate-limits',
                });
            }
            return;
        }

        // Ramp back up when 60s elapsed without any 429.
        if (recentCount === 0
            && now - this.lastAdaptiveAdjust >= this.adaptiveWindowMs
            && this.currentConcurrency < this.maxConcurrent) {
            const old = this.currentConcurrency;
            this.currentConcurrency = Math.min(this.maxConcurrent, this.currentConcurrency + 1);
            this.lastAdaptiveAdjust = now;
            if (this.onAdaptive) {
                this.onAdaptive({
                    endpointKey: this.endpointKey,
                    concurrency: this.currentConcurrency,
                    previous: old,
                    recent429: 0,
                    windowMs: this.adaptiveWindowMs,
                    reason: 'cooldown-recovered',
                });
            }
        }
    }

    // ----------------------------------------------------------------------
    // Public: execute a function under the limiter
    // ----------------------------------------------------------------------

    async execute(fn, opts = {}) {
        const cost = Math.max(1, Number(opts.cost ?? 1));

        await this._acquireConcurrency();
        try {
            let attempt = 0;
            let lastErr;
            while (attempt <= this.maxRetries) {
                await this._waitForCooldown();
                await this.bucket.acquire(cost);

                try {
                    const result = await fn();
                    this.stats.successes += 1;
                    // Successful call also nudges the 429 window cleanup so adaptive
                    // concurrency can recover.
                    this._cleanup429Window(Date.now());
                    this._maybeAdjustConcurrency(Date.now());
                    return result;
                } catch (err) {
                    lastErr = err;
                    if (isRateLimitError(err)) {
                        this._record429();
                        const retryAfter = extractRetryAfterMs(err);
                        const expBackoff = Math.min(
                            this.maxBackoffMs,
                            this.baseBackoffMs * Math.pow(2, attempt),
                        );
                        const cooldownMs = Math.ceil(jitter(retryAfter || expBackoff));
                        this._setCooldown(cooldownMs);
                        attempt += 1;
                        this.stats.retries += 1;
                        continue;
                    }
                    if (isRetryableError(err)) {
                        const expBackoff = Math.min(
                            this.maxBackoffMs,
                            this.baseBackoffMs * Math.pow(2, attempt),
                        );
                        const waitMs = Math.ceil(jitter(expBackoff));
                        await sleep(waitMs);
                        attempt += 1;
                        this.stats.retries += 1;
                        this.stats.otherErrors += 1;
                        continue;
                    }
                    // Non-retryable: surface immediately.
                    this.stats.otherErrors += 1;
                    throw err;
                }
            }
            // Exhausted retries.
            throw lastErr;
        } finally {
            this._releaseConcurrency();
        }
    }

    getStats() {
        return {
            endpointKey: this.endpointKey,
            currentConcurrency: this.currentConcurrency,
            activeCount: this.activeCount,
            pendingQueue: this.concurrencyWaitQueue.length,
            cooldownUntil: this.cooldownUntil,
            cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
            ...this.stats,
        };
    }
}

/* -------------------------------------------------------------------------- */
/*                          Connection wrappers                               */
/* -------------------------------------------------------------------------- */

const RPC_METHODS_TO_LIMIT = new Set([
    'getAccountInfo',
    'getMultipleAccountsInfo',
    'getProgramAccounts',
    'getParsedAccountInfo',
    'getParsedProgramAccounts',
    'getBalance',
    'getTokenAccountBalance',
    'getTokenAccountsByOwner',
    'getSlot',
    'getBlockHeight',
    'getLatestBlockhash',
    'getTransaction',
    'getSignaturesForAddress',
    'getRecentPrioritizationFees',
    'simulateTransaction',
]);

/**
 * Cost weighting for known methods. getMultipleAccountsInfo is roughly
 * proportional to N accounts; we charge max(1, ceil(N / 10)) tokens so a
 * 23-account batch costs ~3 tokens. This keeps the bucket honest about the
 * actual server-side load.
 */
function costForMethod(method, args) {
    if (method === 'getMultipleAccountsInfo') {
        const keys = Array.isArray(args?.[0]) ? args[0] : [];
        return Math.max(1, Math.ceil(keys.length / 10));
    }
    if (method === 'getProgramAccounts' || method === 'getParsedProgramAccounts') {
        return 3; // generally heavier than account info
    }
    return 1;
}

/**
 * Wrap a single Solana web3.js Connection (or the createRpcConnection proxy)
 * so all rate-limited methods are routed through the supplied EndpointLimiter.
 *
 * Returns a Proxy that forwards all other property access unchanged. The
 * original connection is left intact.
 */
function wrapConnection(connection, opts = {}) {
    const limiter = opts.limiter || new EndpointLimiter(opts);

    const proxy = new Proxy(connection, {
        get(target, prop) {
            const original = target[prop];
            if (typeof original !== 'function' || !RPC_METHODS_TO_LIMIT.has(prop)) {
                // Non-RPC field or method: pass through.
                if (typeof original === 'function') return original.bind(target);
                return original;
            }
            // Wrap RPC calls.
            return (...args) => limiter.execute(
                () => original.apply(target, args),
                { cost: costForMethod(prop, args) },
            );
        },
    });

    // Expose the limiter so callers can read stats / adjust concurrency.
    Object.defineProperty(proxy, '__rateLimiter', {
        value: limiter,
        enumerable: false,
    });
    return proxy;
}

/**
 * Round-robin wrapper across multiple connections. Each connection gets its
 * own EndpointLimiter (so 429s on one endpoint don't pause the others).
 *
 * The returned proxy delegates RPC calls to the next available endpoint by
 * round-robin. Non-RPC properties forward to the FIRST connection (since
 * those are typically static fields like commitment/rpcEndpoint).
 *
 * Use this when you have HELIUS_ENDPOINT1/2/3 etc. and want fan-out with
 * per-endpoint backoff.
 */
function wrapMultiConnection(connections, opts = {}) {
    if (!Array.isArray(connections) || connections.length === 0) {
        throw new Error('wrapMultiConnection requires a non-empty array of connections');
    }

    const limiters = connections.map((_, i) => new EndpointLimiter({
        ...opts,
        endpointKey: opts.endpointKeys?.[i] || `endpoint-${i}`,
    }));

    let cursor = 0;
    const pickIndex = () => {
        // Choose the limiter with the lowest active load (best-effort load
        // balancing). Fall back to round-robin if all equal.
        let bestIdx = -1;
        let bestActive = Infinity;
        for (let i = 0; i < limiters.length; i += 1) {
            const l = limiters[i];
            const cooldownRemaining = Math.max(0, l.cooldownUntil - Date.now());
            const score = l.activeCount + cooldownRemaining / 1000;
            if (score < bestActive) {
                bestActive = score;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) {
            bestIdx = cursor % limiters.length;
            cursor += 1;
        }
        return bestIdx;
    };

    const primary = connections[0];
    const proxy = new Proxy(primary, {
        get(target, prop) {
            const original = target[prop];
            if (typeof original !== 'function' || !RPC_METHODS_TO_LIMIT.has(prop)) {
                if (typeof original === 'function') return original.bind(target);
                return original;
            }
            return (...args) => {
                const idx = pickIndex();
                const conn = connections[idx];
                const limiter = limiters[idx];
                const fn = conn[prop];
                if (typeof fn !== 'function') {
                    // Method missing on this endpoint, fall back to primary.
                    return original.apply(target, args);
                }
                return limiter.execute(
                    () => fn.apply(conn, args),
                    { cost: costForMethod(prop, args) },
                );
            };
        },
    });

    Object.defineProperty(proxy, '__rateLimiters', {
        value: limiters,
        enumerable: false,
    });
    Object.defineProperty(proxy, '__rateLimiterStats', {
        value: () => limiters.map((l) => l.getStats()),
        enumerable: false,
    });
    return proxy;
}

/**
 * Create a standalone limiter (when you can't / don't want to wrap a
 * Connection). Returns an EndpointLimiter you can call .execute(fn) on.
 */
function createRateLimiter(opts = {}) {
    return new EndpointLimiter(opts);
}

/**
 * Replacement for the existing processInBatches that consults a limiter's
 * adaptive concurrency. If the limiter ramps down due to 429 pressure, the
 * batch shrinks automatically; if it ramps back up, larger batches resume.
 *
 * Drop-in usage in Q_enrichment.js:
 *
 *   const { processInBatchesLimited } = require('../utilities/rpcRateLimiter');
 *   await processInBatchesLimited(pools, async (pool) => {
 *     await enrichOnePool(pool, connection, stats);
 *   }, { limiter: connection.__rateLimiter });
 *
 * If `limiter` is omitted, behaves like the original processInBatches with
 * a fixed batchSize.
 */
async function processInBatchesLimited(items, handler, opts = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const fixedBatchSize = Math.max(1, Number(opts.batchSize ?? 8));
    const delayMs = Math.max(0, Number(opts.delayMs ?? 0));
    const limiter = opts.limiter || null;

    const results = new Array(items.length);
    let cursor = 0;

    while (cursor < items.length) {
        const concurrency = limiter
            ? Math.max(1, Math.min(fixedBatchSize, limiter.currentConcurrency))
            : fixedBatchSize;
        const slice = items.slice(cursor, cursor + concurrency);
        const baseIndex = cursor;
        const settled = await Promise.allSettled(
            slice.map((item, i) => Promise.resolve().then(() => handler(item, baseIndex + i))),
        );
        for (let i = 0; i < settled.length; i += 1) {
            const entry = settled[i];
            if (entry.status === 'fulfilled') {
                results[baseIndex + i] = entry.value;
            } else {
                results[baseIndex + i] = { __error: entry.reason };
            }
        }
        cursor += slice.length;
        if (delayMs > 0 && cursor < items.length) await sleep(delayMs);
    }

    return results;
}

module.exports = {
    EndpointLimiter,
    TokenBucket,
    wrapConnection,
    wrapMultiConnection,
    createRateLimiter,
    processInBatchesLimited,
    isRateLimitError,
    isRetryableError,
    RPC_METHODS_TO_LIMIT,
};