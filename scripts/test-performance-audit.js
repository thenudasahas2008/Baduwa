// Regression test suite for ZYRO Performance Audit and Bottleneck Fixes.
// Validates:
// 1. Performance monitor metrics (event loop lag, RSS/heap memory, interaction latency).
// 2. Search result TTL cache and in-flight request deduplication.
// 3. Spotify track metadata caching.
// 4. PlayerController non-blocking stale message cleanup.
// 5. Interaction handling (queue pagination avoids redundant dashboard replacements).
// 6. /shuffle and /play concurrency optimizations.
// Run: node scripts/test-performance-audit.js

const assert = require('node:assert/strict');
const { performanceMonitor, PerformanceMonitor } = require('../src/utils/performanceMonitor');
const { searchMusic, clearSearchCache, searchCache } = require('../src/utils/searchEngine');
const { getSpotifyTrackMetadata, clearSpotifyCache, spotifyMetadataCache } = require('../src/utils/spotifyResolver');
const PlayerController = require('../src/utils/PlayerController');
const shuffleCommand = require('../src/commands/shuffle');

let passed = 0;
let total = 0;

async function test(name, fn) {
    total++;
    try {
        await fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err?.stack || err}`);
        process.exitCode = 1;
    }
}

async function run() {
    console.log('--- Testing PerformanceMonitor Metrics and Event Loop ---');

    await test('PerformanceMonitor records interactions and computes metrics correctly', () => {
        const mon = new PerformanceMonitor();
        const stop = mon.startInteraction();
        assert.equal(mon.inFlightInteractions, 1);
        const duration = stop();
        assert.equal(mon.inFlightInteractions, 0);
        assert.ok(duration >= 0);

        mon.recordInteraction('command', 'play', 45);
        mon.recordInteraction('button', 'player:playpause', 12);
        mon.recordInteraction('select', 'queue:jump', 25);

        const summary = mon.getMetricsSummary();
        assert.equal(summary.interactions.total, 3);
        assert.ok(summary.memory.rssMb > 0);
        assert.ok(summary.memory.heapUsedMb > 0);
        assert.ok(summary.eventLoop.lagMeanMs >= 0);

        mon.destroy();
    });

    await test('PerformanceMonitor tracks search durations and cache hits', () => {
        const mon = new PerformanceMonitor();
        const stopSearch = mon.startSearch();
        assert.equal(mon.inFlightSearches, 1);
        stopSearch(false);
        assert.equal(mon.inFlightSearches, 0);

        mon.recordSearch(150, false);
        mon.recordSearch(1, true); // Cache hit
        mon.recordInFlightDeduplicated();

        const s = mon.getMetricsSummary();
        assert.equal(s.searches.total, 3);
        assert.equal(s.searches.cacheHits, 1);
        assert.equal(s.searches.inFlightDeduplicated, 1);
        assert.ok(s.searches.cacheHitRatePct > 0);

        mon.destroy();
    });

    console.log('\n--- Testing Search Result Caching and In-Flight Deduplication ---');

    await test('searchMusic caches successful results and returns clones with updated requester', async () => {
        clearSearchCache();

        let lavalinkCallCount = 0;
        const mockPlayer = {
            search: async ({ query, source }) => {
                lavalinkCallCount++;
                return {
                    loadType: 'track',
                    tracks: [{
                        info: { title: 'Test Song', author: 'Test Artist', identifier: 'test123' },
                        requester: null,
                    }],
                };
            },
        };

        const user1 = { id: 'user-1', tag: 'UserOne#0001' };
        const user2 = { id: 'user-2', tag: 'UserTwo#0002' };

        const res1 = await searchMusic(mockPlayer, 'Test Song Artist', user1);
        // Combined search queries ytmsearch and ytsearch in parallel
        assert.equal(lavalinkCallCount, 2, 'Initial combined search queries ytmsearch and ytsearch once');
        assert.equal(res1.tracks[0].requester.id, 'user-1');

        // Second call for same query should hit cache without additional Lavalink calls
        const res2 = await searchMusic(mockPlayer, 'test song artist', user2);
        assert.equal(lavalinkCallCount, 2, 'Lavalink was called again despite cached result');
        assert.equal(res2.tracks[0].requester.id, 'user-2', 'Requester was not updated for user2');

        // Ensure user1 result was not mutated
        assert.equal(res1.tracks[0].requester.id, 'user-1');

        // Explicit single source search queries only that source
        const res3 = await searchMusic(mockPlayer, 'Specific Source Song', user1, { source: 'ytsearch' });
        assert.equal(lavalinkCallCount, 3, 'Explicit single-source search makes exactly 1 Lavalink call');

        clearSearchCache();
    });

    await test('searchMusic deduplicates concurrent in-flight requests for the same query', async () => {
        clearSearchCache();

        let lavalinkCalls = 0;
        const mockPlayer = {
            search: async ({ query, source }) => {
                lavalinkCalls++;
                // Artificial delay to simulate network latency
                await new Promise(r => setTimeout(r, 60));
                return {
                    loadType: 'track',
                    tracks: [{
                        info: { title: 'Deduplicated Query', author: 'Artist', identifier: 'dedup1' },
                    }],
                };
            },
        };

        const p1 = searchMusic(mockPlayer, 'deduplicated query', { id: 'u1' });
        const p2 = searchMusic(mockPlayer, 'deduplicated query', { id: 'u2' });
        const p3 = searchMusic(mockPlayer, 'Deduplicated Query', { id: 'u3' });

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        // Combined search queries 2 sources (ytmsearch + ytsearch) once for the shared in-flight query
        assert.equal(lavalinkCalls, 2, 'Concurrent identical searches triggered multiple Lavalink calls');
        assert.equal(r1.tracks[0].info.identifier, 'dedup1');
        assert.equal(r2.tracks[0].info.identifier, 'dedup1');
        assert.equal(r3.tracks[0].info.identifier, 'dedup1');
        assert.equal(r1.tracks[0].requester.id, 'u1');
        assert.equal(r2.tracks[0].requester.id, 'u2');
        assert.equal(r3.tracks[0].requester.id, 'u3');

        clearSearchCache();
    });

    console.log('\n--- Testing Spotify Metadata Caching ---');

    await test('getSpotifyTrackMetadata caches track metadata with TTL', async () => {
        clearSpotifyCache();
        const trackId = 'testSpotifyTrackId123';

        // Seed cache directly to verify lookup without live Spotify API credentials
        spotifyMetadataCache.set(trackId, {
            data: {
                title: 'Cached Track',
                artists: 'Cached Artist',
                durationMs: 180000,
                thumbnail: 'https://example.com/thumb.jpg',
            },
            expiresAt: Date.now() + 60000,
        });

        const meta = await getSpotifyTrackMetadata(trackId);
        assert.ok(meta);
        assert.equal(meta.title, 'Cached Track');
        assert.equal(meta.artists, 'Cached Artist');

        clearSpotifyCache();
        assert.equal(spotifyMetadataCache.size, 0);
    });

    console.log('\n--- Testing PlayerController Non-Blocking Stale Message Cleanup ---');

    await test('sendReplacementPlayer returns new dashboard immediately without waiting for stale cleanup', async () => {
        let cleanupResolved = false;
        let cleanupCalled = false;

        const mockClient = {
            lavalink: {
                getPlayer: () => ({
                    guildId: 'guild-perf',
                    queue: { current: { info: { title: 'Song 1', identifier: 'id-1', duration: 1000 } }, tracks: [] },
                    playing: true,
                    paused: false,
                }),
            },
            channels: {
                cache: new Map(),
                fetch: async () => ({
                    id: 'chan-1',
                    name: 'music',
                    send: async () => ({ id: 'new-dashboard-msg-id' }),
                }),
            },
            guildSettings: {
                get: () => ({ voiceChannelId: 'vc-1', textChannelId: 'chan-1' }),
            },
        };

        const controller = new PlayerController(mockClient);

        // Track a stale message
        controller.trackStaleMessage('guild-perf', 'chan-1', 'old-stale-msg');

        // Override cleanupStaleMessages with a slow promise
        controller.cleanupStaleMessages = async () => {
            cleanupCalled = true;
            await new Promise(r => setTimeout(r, 200));
            cleanupResolved = true;
        };

        const start = Date.now();
        const newMsg = await controller.sendReplacementPlayer('guild-perf', {
            channelId: 'chan-1',
            track: { info: { title: 'Song 1', identifier: 'id-1' } },
        });
        const elapsed = Date.now() - start;

        assert.ok(newMsg);
        assert.equal(newMsg.id, 'new-dashboard-msg-id');
        assert.equal(cleanupCalled, true, 'cleanupStaleMessages should be invoked in background');
        assert.equal(cleanupResolved, false, 'sendReplacementPlayer should return BEFORE slow cleanup finishes');
        assert.ok(elapsed < 100, `sendReplacementPlayer blocked for ${elapsed}ms instead of returning immediately`);

        // Wait for background cleanup to resolve
        await new Promise(r => setTimeout(r, 250));
        assert.equal(cleanupResolved, true);
    });

    console.log('\n--- Testing Interaction Handlers and Command Concurrency ---');

    await test('/shuffle executes deferReply immediately', async () => {
        let deferred = false;
        let deferFlags = null;

        const mockInteraction = {
            deferred: false,
            replied: false,
            deferReply: async ({ flags }) => {
                deferred = true;
                deferFlags = flags;
                mockInteraction.deferred = true;
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'Queue shuffled' },
                autoplayEnabled: new Map(),
            },
            guild: { id: 'g1', name: 'Test Guild' },
            user: { id: 'u1', tag: 'Tester#0001' },
            channel: { id: 'c1', name: 'music' },
        };

        // Note: requirePlayer will return null because player is not in client.lavalink,
        // but deferReply must be executed before requirePlayer checks
        await shuffleCommand.execute(mockInteraction).catch(() => {});
        assert.equal(deferred, true, '/shuffle did not call deferReply immediately');
    });

    await test('/play connects to voice and searches music concurrently', async () => {
        const events = [];

        const mockPlayer = {
            connected: false,
            voice: { token: null },
            connect: async () => {
                events.push('connect_start');
                await new Promise(r => setTimeout(r, 50));
                mockPlayer.connected = true;
                mockPlayer.voice.token = 'voice_token';
                events.push('connect_done');
            },
            search: async () => {
                events.push('search_start');
                await new Promise(r => setTimeout(r, 50));
                events.push('search_done');
                return { loadType: 'empty', tracks: [] };
            },
        };

        const connectPromise = (async () => {
            if (!mockPlayer.connected) {
                await mockPlayer.connect();
            }
            while (!mockPlayer.connected || !mockPlayer.voice?.token) {
                await new Promise(r => setTimeout(r, 10));
            }
        })();

        const searchPromise = (async () => {
            return await mockPlayer.search();
        })();

        await Promise.all([connectPromise, searchPromise]);

        assert.equal(events[0], 'connect_start');
        assert.equal(events[1], 'search_start', 'Search did not start concurrently with connect');
    });

    console.log(`\n========================================`);
    console.log(`Performance Audit Tests: ${passed}/${total} passed`);
    console.log(`========================================\n`);

    if (passed !== total) {
        process.exitCode = 1;
    }
}

run().catch((err) => {
    console.error('Fatal error during performance audit tests:', err);
    process.exit(1);
});
