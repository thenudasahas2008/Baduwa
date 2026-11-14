// Lightweight performance and event-loop monitor for ZYRO Music Bot.
// Measures event-loop delay, process RSS/heap memory, interaction execution duration,
// search resolution duration, Discord REST latency, and active timers without logging secrets.

const { monitorEventLoopDelay } = require('perf_hooks');
const logger = require('./logger');

class PerformanceMonitor {
    constructor() {
        this.enabled = true;
        this.histogram = null;
        try {
            this.histogram = monitorEventLoopDelay({ resolution: 20 });
            this.histogram.enable();
        } catch (err) {
            logger.debug('Event loop delay monitoring not available:', err?.message || err);
        }

        // Interaction metrics
        this.interactions = {
            total: 0,
            commands: 0,
            buttons: 0,
            selectMenus: 0,
            timeouts: 0,
            errors: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
        };

        // Search metrics
        this.searches = {
            total: 0,
            cacheHits: 0,
            inFlightDeduplicated: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
        };

        // Dashboard REST metrics
        this.dashboardRest = {
            sends: 0,
            edits: 0,
            deletes: 0,
            totalDurationMs: 0,
        };

        this.ackSamples = [];
        this.durationSamples = [];
        this.nodeValidationSamples = [];
        this.playbackStartSamples = [];
        this.maxSampleSize = 2000;

        this.inFlightSearches = 0;
        this.inFlightInteractionsMap = new Map();

        // Monotonic event loop delay sampling (1s interval) to distinguish short-lived spikes from sustained lag
        this.recentLagSamples = [];
        this.maxRecentSamples = 60;
        this.lastMonotonicSample = process.hrtime.bigint();
        this.sampleTimer = setInterval(() => {
            const now = process.hrtime.bigint();
            const elapsedNs = now - this.lastMonotonicSample;
            this.lastMonotonicSample = now;
            const expectedNs = 1_000_000_000n;
            const lagNs = elapsedNs > expectedNs ? (elapsedNs - expectedNs) : 0n;
            const lagMs = Number(lagNs) / 1_000_000;
            this.recentLagSamples.push(lagMs);
            if (this.recentLagSamples.length > this.maxRecentSamples) {
                this.recentLagSamples.shift();
            }
        }, 1000);
        if (typeof this.sampleTimer.unref === 'function') {
            this.sampleTimer.unref();
        }

        // Periodic sampled logging (every 5 minutes, unrefed)
        this.interval = setInterval(() => {
            this.logSummary();
        }, 5 * 60 * 1000);

        if (typeof this.interval.unref === 'function') {
            this.interval.unref();
        }
    }

    get inFlightInteractions() {
        return this.inFlightInteractionsMap.size;
    }

    set inFlightInteractions(_) {
        // Backwards compatibility no-op
    }

    startInteraction(interaction = null) {
        const id = interaction?.id || (interaction && typeof interaction === 'string' ? interaction : `gen_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
        const type = interaction?.isCommand?.() ? 'command' : (interaction?.isButton?.() ? 'button' : (interaction?.isStringSelectMenu?.() ? 'select' : 'interaction'));
        const name = interaction?.isCommand?.() ? interaction.commandName : (interaction?.customId || 'unknown');
        const startHr = process.hrtime.bigint();
        const startEpoch = Date.now();

        const record = {
            id,
            type,
            name,
            startHr,
            startEpoch,
            ackDurationMs: 0,
            status: 'in_flight',
        };

        this.inFlightInteractionsMap.set(id, record);

        let finalized = false;
        return (details = {}) => {
            if (finalized) {
                return record.durationMs || 0;
            }
            finalized = true;

            const endHr = process.hrtime.bigint();
            const durationMs = Number(endHr - startHr) / 1_000_000;
            record.durationMs = durationMs;
            record.status = details.status || 'completed';
            if (typeof details.ackDurationMs === 'number') record.ackDurationMs = details.ackDurationMs;
            if (typeof details.operationDurationMs === 'number') record.operationDurationMs = details.operationDurationMs;
            if (typeof details.externalDurationMs === 'number') record.externalDurationMs = details.externalDurationMs;
            if (details.error) record.error = details.error;

            this.inFlightInteractionsMap.delete(id);
            return durationMs;
        };
    }

    getInFlightDetails() {
        const nowHr = process.hrtime.bigint();
        const details = [];
        for (const [id, rec] of this.inFlightInteractionsMap.entries()) {
            const elapsedMs = Number(nowHr - rec.startHr) / 1_000_000;
            details.push({
                id,
                type: rec.type,
                name: rec.name,
                elapsedMs: Number(elapsedMs.toFixed(1)),
                status: rec.status,
            });
        }
        return details;
    }

    resetHistogram() {
        if (this.histogram && typeof this.histogram.reset === 'function') {
            this.histogram.reset();
        }
    }

    recordInteraction(type, name, durationMs, details = {}) {
        if (!Number.isFinite(durationMs) || durationMs < 0) {
            logger.warn(`[PERF] Discarding invalid duration for ${type} "${name}": ${durationMs}ms`);
            return;
        }

        // Detect stale orphaned interactions that exceeded the 15-minute Discord webhook token lifetime (900,000ms)
        // rather than emitting misleading slow-command warnings that confuse operators
        if (durationMs > 900_000) {
            this.interactions.staleOrphaned = (this.interactions.staleOrphaned || 0) + 1;
            logger.warn(`[PERF] Stale orphaned interaction completed after ${(durationMs / 1000).toFixed(1)}s (exceeded 15m Discord token lifetime, command="${name}", type="${type}")`);
            return;
        }

        this.interactions.total++;
        if (type === 'command') this.interactions.commands++;
        else if (type === 'button') this.interactions.buttons++;
        else if (type === 'select') this.interactions.selectMenus++;

        const isTimeout = Boolean(details?.isTimeout || details?.status === 'timed_out');
        const isError = Boolean(details?.status === 'error' || details?.error);

        if (isTimeout) {
            this.interactions.timeouts++;
        }
        if (isError) {
            this.interactions.errors++;
        }

        // Truthfully record actual duration without artificial capping
        this.interactions.totalDurationMs += durationMs;
        if (durationMs > this.interactions.maxDurationMs) {
            this.interactions.maxDurationMs = durationMs;
        }

        // Rolling sample arrays for truthful percentile and windowed average computation
        if (this.durationSamples.length >= this.maxSampleSize) {
            this.durationSamples.shift();
        }
        this.durationSamples.push(durationMs);

        if (typeof details?.ackDurationMs === 'number' && details.ackDurationMs >= 0) {
            if (this.ackSamples.length >= this.maxSampleSize) {
                this.ackSamples.shift();
            }
            this.ackSamples.push(details.ackDurationMs);
        }

        // Warn on unusually slow interactions (> 1500ms) within reasonable active window
        if (durationMs > 1500) {
            logger.warn(`[PERF] Slow ${type} "${name}": ${durationMs.toFixed(1)}ms${isTimeout ? ' (TIMED OUT)' : ''}`);
        }
    }

    recordNodeValidation(durationMs) {
        if (!Number.isFinite(durationMs) || durationMs < 0) return;
        if (this.nodeValidationSamples.length >= this.maxSampleSize) {
            this.nodeValidationSamples.shift();
        }
        this.nodeValidationSamples.push(durationMs);
    }

    recordPlaybackStart(durationMs) {
        if (!Number.isFinite(durationMs) || durationMs < 0) return;
        if (this.playbackStartSamples.length >= this.maxSampleSize) {
            this.playbackStartSamples.shift();
        }
        this.playbackStartSamples.push(durationMs);
    }

    startSearch() {
        this.inFlightSearches++;
        const start = process.hrtime.bigint();
        return (isCacheHit = false) => {
            this.inFlightSearches = Math.max(0, this.inFlightSearches - 1);
            const end = process.hrtime.bigint();
            const durationMs = Number(end - start) / 1_000_000;
            this.recordSearch(durationMs, isCacheHit);
            return durationMs;
        };
    }

    recordSearch(durationMs, isCacheHit = false) {
        this.searches.total++;
        if (isCacheHit) {
            this.searches.cacheHits++;
        }
        this.searches.totalDurationMs += durationMs;
        if (durationMs > this.searches.maxDurationMs) {
            this.searches.maxDurationMs = durationMs;
        }
    }

    recordInFlightDeduplicated() {
        this.searches.inFlightDeduplicated++;
    }

    recordDashboardAction(action, durationMs) {
        if (action === 'send') this.dashboardRest.sends++;
        else if (action === 'edit') this.dashboardRest.edits++;
        else if (action === 'delete') this.dashboardRest.deletes++;
        this.dashboardRest.totalDurationMs += durationMs;
    }

    getMetricsSummary() {
        const mem = process.memoryUsage();
        const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
        const heapUsedMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
        const heapTotalMb = (mem.heapTotal / 1024 / 1024).toFixed(1);

        let eventLoopLagMs = 0;
        let eventLoopP95Ms = 0;
        let eventLoopMaxMs = 0;

        if (this.histogram) {
            const mean = this.histogram.mean;
            eventLoopLagMs = Number.isFinite(mean) ? (mean / 1_000_000).toFixed(2) : '0.00';
            const p95 = this.histogram.percentile(95);
            eventLoopP95Ms = Number.isFinite(p95) ? (p95 / 1_000_000).toFixed(2) : '0.00';
            const max = this.histogram.max;
            eventLoopMaxMs = Number.isFinite(max) ? (max / 1_000_000).toFixed(2) : '0.00';
        }

        const sampleSum = this.durationSamples.reduce((acc, v) => acc + v, 0);
        const avgInteractionMs = this.durationSamples.length > 0
            ? (sampleSum / this.durationSamples.length).toFixed(1)
            : (this.interactions.total > 0
                ? (this.interactions.totalDurationMs / this.interactions.total).toFixed(1)
                : '0.0');

        const avgSearchMs = this.searches.total > 0
            ? (this.searches.totalDurationMs / this.searches.total).toFixed(1)
            : '0.0';

        const cacheHitRate = this.searches.total > 0
            ? ((this.searches.cacheHits / this.searches.total) * 100).toFixed(1)
            : '0.0';

        const calcP = (arr, p) => {
            if (!arr || !arr.length) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
            return Number(sorted[idx].toFixed(1));
        };

        let bulkheadStats = null;
        try {
            const { searchBulkhead, spotifyBulkhead } = require('./bulkheadManager');
            bulkheadStats = {
                search: searchBulkhead ? searchBulkhead.getStats() : null,
                spotify: spotifyBulkhead ? spotifyBulkhead.getStats() : null,
            };
        } catch (_) {}

        return {
            memory: {
                rssMb: Number(rssMb),
                heapUsedMb: Number(heapUsedMb),
                heapTotalMb: Number(heapTotalMb),
            },
            eventLoop: {
                lagMeanMs: Number(eventLoopLagMs),
                lagP95Ms: Number(eventLoopP95Ms),
                lagMaxMs: Number(eventLoopMaxMs),
                sustainedLagMs: (this.recentLagSamples && this.recentLagSamples.length > 0)
                    ? Number((this.recentLagSamples.reduce((a, b) => a + b, 0) / this.recentLagSamples.length).toFixed(2))
                    : 0,
                recentMaxLagMs: (this.recentLagSamples && this.recentLagSamples.length > 0)
                    ? Number(Math.max(...this.recentLagSamples).toFixed(2))
                    : 0,
            },
            acknowledgement: {
                p50Ms: calcP(this.ackSamples, 50),
                p95Ms: calcP(this.ackSamples, 95),
                p99Ms: calcP(this.ackSamples, 99),
                samples: this.ackSamples.length,
            },
            completion: {
                p50Ms: calcP(this.durationSamples, 50),
                p95Ms: calcP(this.durationSamples, 95),
                p99Ms: calcP(this.durationSamples, 99),
                samples: this.durationSamples.length,
            },
            nodeValidation: {
                p50Ms: calcP(this.nodeValidationSamples, 50),
                p95Ms: calcP(this.nodeValidationSamples, 95),
                samples: this.nodeValidationSamples.length,
            },
            playbackStart: {
                p50Ms: calcP(this.playbackStartSamples, 50),
                p95Ms: calcP(this.playbackStartSamples, 95),
                samples: this.playbackStartSamples.length,
            },
            interactions: {
                total: this.interactions.total,
                timeouts: this.interactions.timeouts,
                errors: this.interactions.errors,
                avgDurationMs: Number(avgInteractionMs),
                maxDurationMs: Number(this.interactions.maxDurationMs.toFixed(1)),
                inFlight: this.inFlightInteractions,
                staleOrphaned: this.interactions.staleOrphaned || 0,
            },
            searches: {
                total: this.searches.total,
                cacheHits: this.searches.cacheHits,
                cacheHitRatePct: Number(cacheHitRate),
                inFlightDeduplicated: this.searches.inFlightDeduplicated,
                avgDurationMs: Number(avgSearchMs),
                maxDurationMs: Number(this.searches.maxDurationMs.toFixed(1)),
                inFlight: this.inFlightSearches,
            },
            bulkhead: bulkheadStats,
            dashboardRest: {
                ...this.dashboardRest,
            },
        };
    }

    logSummary() {
        const s = this.getMetricsSummary();
        logger.info(
            `[PERF-METRICS] Memory: RSS=${s.memory.rssMb}MB Heap=${s.memory.heapUsedMb}/${s.memory.heapTotalMb}MB | ` +
            `EventLoop Lag: avg=${s.eventLoop.lagMeanMs}ms p95=${s.eventLoop.lagP95Ms}ms max=${s.eventLoop.lagMaxMs}ms (sustained=${s.eventLoop.sustainedLagMs}ms recentMax=${s.eventLoop.recentMaxLagMs}ms) | ` +
            `Interactions: count=${s.interactions.total} avg=${s.interactions.avgDurationMs}ms inFlight=${s.interactions.inFlight} | ` +
            `Searches: count=${s.searches.total} avg=${s.searches.avgDurationMs}ms hits=${s.searches.cacheHits} (${s.searches.cacheHitRatePct}%) inFlightDedup=${s.searches.inFlightDeduplicated}`
        );
        // Reset histogram window periodically to avoid stale tail skew
        if (this.histogram && typeof this.histogram.reset === 'function') {
            this.histogram.reset();
        }
    }

    destroy() {
        if (this.sampleTimer) {
            clearInterval(this.sampleTimer);
            this.sampleTimer = null;
        }
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.histogram && typeof this.histogram.disable === 'function') {
            this.histogram.disable();
        }
    }
}

const performanceMonitor = new PerformanceMonitor();

module.exports = {
    PerformanceMonitor,
    performanceMonitor,
};
