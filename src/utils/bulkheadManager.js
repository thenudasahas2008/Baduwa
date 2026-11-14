// Bulkhead and concurrency manager for ZYRO Music Bot.
// Provides bounded concurrency limits, queue depth backpressure, timeouts,
// cancellation, and interaction idempotency deduplication to protect against overload.

const logger = require('./logger');

class Bulkhead {
    constructor(name, options = {}) {
        this.name = name;
        this.maxConcurrent = options.maxConcurrent || 15;
        this.maxQueue = options.maxQueue || 60;
        this.defaultTimeoutMs = options.defaultTimeoutMs || 10_000;

        this.activeCount = 0;
        this.queue = [];
        this.stats = {
            totalExecuted: 0,
            totalRejected: 0,
            totalTimedOut: 0,
            maxQueueDepthObserved: 0,
        };
    }

    get active() {
        return this.activeCount;
    }

    get queued() {
        return this.queue.length;
    }

    /**
     * Executes a task within the bulkhead concurrency limits.
     * Throws an error with code 'BULKHEAD_BUSY' if the waiting queue is saturated.
     */
    async run(task, options = {}) {
        const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
        const signal = options.signal;

        if (signal?.aborted) {
            const err = new Error(`Task cancelled before bulkhead acquisition (${this.name})`);
            err.name = 'AbortError';
            err.code = 'ABORT_ERR';
            throw err;
        }

        // Apply backpressure if waiting queue is full
        if (this.queue.length >= this.maxQueue) {
            this.stats.totalRejected++;
            const err = new Error(`Service is currently experiencing high load (${this.name} capacity reached: ${this.queue.length}/${this.maxQueue} queued)`);
            err.name = 'BulkheadCapacityError';
            err.code = 'BULKHEAD_BUSY';
            err.isBusy = true;
            logger.warn(`[BULKHEAD] ${this.name} rejected task due to queue saturation (${this.queue.length}/${this.maxQueue})`);
            throw err;
        }

        if (this.queue.length > this.stats.maxQueueDepthObserved) {
            this.stats.maxQueueDepthObserved = this.queue.length;
        }

        return new Promise((resolve, reject) => {
            const queueEntry = {
                task,
                timeoutMs,
                signal,
                resolve,
                reject,
                enqueuedAt: Date.now(),
            };

            this.queue.push(queueEntry);
            this._dequeue();
        });
    }

    _dequeue() {
        if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        const entry = this.queue.shift();
        if (!entry) return;

        // Check if aborted while waiting in queue
        if (entry.signal?.aborted) {
            const err = new Error(`Task cancelled while queued in bulkhead (${this.name})`);
            err.name = 'AbortError';
            err.code = 'ABORT_ERR';
            entry.reject(err);
            this._dequeue();
            return;
        }

        this.activeCount++;
        let timeoutHandle = null;
        let abortHandler = null;

        const executeTask = async () => {
            const timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    this.stats.totalTimedOut++;
                    const err = new Error(`Task timed out after ${entry.timeoutMs}ms in bulkhead (${this.name})`);
                    err.name = 'TimeoutError';
                    err.code = 'BULKHEAD_TIMEOUT';
                    reject(err);
                }, entry.timeoutMs);

                if (entry.signal) {
                    abortHandler = () => {
                        const err = new Error(`Task aborted during execution in bulkhead (${this.name})`);
                        err.name = 'AbortError';
                        err.code = 'ABORT_ERR';
                        reject(err);
                    };
                    entry.signal.addEventListener('abort', abortHandler, { once: true });
                }
            });

            try {
                const result = await Promise.race([entry.task(), timeoutPromise]);
                this.stats.totalExecuted++;
                entry.resolve(result);
            } catch (err) {
                entry.reject(err);
            } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (entry.signal && abortHandler) {
                    entry.signal.removeEventListener('abort', abortHandler);
                }
                this.activeCount = Math.max(0, this.activeCount - 1);
                this._dequeue();
            }
        };

        executeTask().catch(() => {});
    }

    getStats() {
        return {
            name: this.name,
            active: this.activeCount,
            queued: this.queue.length,
            maxConcurrent: this.maxConcurrent,
            maxQueue: this.maxQueue,
            totalExecuted: this.stats.totalExecuted,
            totalRejected: this.stats.totalRejected,
            totalTimedOut: this.stats.totalTimedOut,
            maxQueueDepthObserved: this.stats.maxQueueDepthObserved,
        };
    }

    clear() {
        while (this.queue.length > 0) {
            const entry = this.queue.shift();
            const err = new Error(`Bulkhead ${this.name} cleared`);
            err.code = 'BULKHEAD_CLEARED';
            entry?.reject(err);
        }
        this.activeCount = 0;
    }
}

class IdempotencyTracker {
    constructor(ttlMs = 15_000, maxSize = 5000) {
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this.seen = new Map(); // id -> timestamp
    }

    /**
     * Checks if an interaction ID has already been seen / processed.
     * If unseen, records it and returns false.
     * If seen, returns true.
     */
    checkAndRecord(id) {
        if (!id) return false;
        const now = Date.now();
        this._cleanup(now);

        if (this.seen.has(id)) {
            return true;
        }

        if (this.seen.size >= this.maxSize) {
            const oldest = this.seen.keys().next().value;
            this.seen.delete(oldest);
        }

        this.seen.set(id, now + this.ttlMs);
        return false;
    }

    _cleanup(now = Date.now()) {
        if (this.seen.size === 0) return;
        for (const [id, expiresAt] of this.seen.entries()) {
            if (now >= expiresAt) {
                this.seen.delete(id);
            } else {
                break;
            }
        }
    }

    clear() {
        this.seen.clear();
    }
}

// Canonical singleton bulkheads
const searchBulkhead = new Bulkhead('SearchService', {
    maxConcurrent: 15,
    maxQueue: 60,
    defaultTimeoutMs: 10_000,
});

const spotifyBulkhead = new Bulkhead('SpotifyService', {
    maxConcurrent: 8,
    maxQueue: 40,
    defaultTimeoutMs: 6_000,
});

const idempotencyTracker = new IdempotencyTracker(15_000, 5000);

module.exports = {
    Bulkhead,
    IdempotencyTracker,
    searchBulkhead,
    spotifyBulkhead,
    idempotencyTracker,
};
