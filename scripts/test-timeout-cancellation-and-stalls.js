const assert = require('node:assert/strict');
const { ensureDeferred, safeReply } = require('../src/utils/interactionHelpers');
const { stopPlayer } = require('../src/utils/PlayerActions');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');
const { performanceMonitor } = require('../src/utils/performanceMonitor');
const guildSettings = require('../src/utils/guildSettings');

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
        process.exitCode = 1;
    }
}

async function run() {
    console.log('--- Testing ZYRO Master Performance & Audio Stability Repairs ---');

    // Test 1: safeReply with timeout on stalled REST request
    await test('1. safeReply aborts with REST_TIMEOUT and does not hang indefinitely on stalled Discord REST', async () => {
        let editReplyCalled = false;
        const mockInteraction = {
            id: 'mock_stall_1',
            deferred: true,
            replied: false,
            editReply: async () => {
                editReplyCalled = true;
                // Simulate stalled network request (hanging promise)
                await new Promise(r => setTimeout(r, 4000));
                return { id: 'msg_1' };
            }
        };

        process.env.DISCORD_REST_TIMEOUT_MS = '2000';
        const start = Date.now();
        const result = await safeReply(mockInteraction, { content: 'test message' });
        const elapsed = Date.now() - start;
        delete process.env.DISCORD_REST_TIMEOUT_MS;

        assert.strictEqual(result, null, 'safeReply should return null on timeout error');
        assert.ok(elapsed >= 1900 && elapsed < 3500, `Expected elapsed around 2000ms, got ${elapsed}ms`);
        assert.ok(editReplyCalled, 'editReply must have been invoked');
    });

    // Test 2: safeReply suppresses stale replies for timed-out interactions
    await test('2. safeReply suppresses stale background replies when interaction._timedOut is true', async () => {
        let editReplyCalled = false;
        const mockInteraction = {
            id: 'mock_stale_2',
            deferred: true,
            replied: false,
            _timedOut: true,
            editReply: async () => {
                editReplyCalled = true;
                return { id: 'msg_2' };
            }
        };

        // Normal reply from background task
        const res1 = await safeReply(mockInteraction, { content: 'Stale query result' });
        assert.strictEqual(res1, null, 'Should suppress stale reply');
        assert.strictEqual(editReplyCalled, false, 'editReply should NOT have been called for stale task');

        // Legitimate timeout notification
        const res2 = await safeReply(mockInteraction, { content: 'Command Timed Out', _isTimeoutReply: true });
        assert.ok(res2, 'Timeout notification should be delivered');
        assert.strictEqual(editReplyCalled, true, 'editReply should be called for timeout reply');
    });

    // Test 3: ensureDeferred respects timeout deadline
    await test('3. ensureDeferred terminates with DEFER_TIMEOUT if Discord deferReply stalls', async () => {
        const mockInteraction = {
            id: 'mock_defer_stall',
            deferred: false,
            replied: false,
            deferReply: async () => {
                await new Promise(r => setTimeout(r, 4000));
            }
        };

        const start = Date.now();
        const res = await ensureDeferred(mockInteraction);
        const elapsed = Date.now() - start;

        assert.strictEqual(res.deferred, false, 'Should fail deferral on timeout');
        assert.ok(elapsed >= 2400 && elapsed < 3500, `Expected elapsed around 2500ms, got ${elapsed}ms`);
    });

    // Test 4: AudioPlaybackMonitor avoids false stalls when node or voice connection is disconnected
    await test('4. AudioPlaybackMonitor does not declare false stalls while node is disconnected', async () => {
        const mockPlayer = {
            guildId: 'guild_audio_stall_test',
            playing: true,
            paused: false,
            connected: true,
            position: 5000,
            node: { id: 'node_1', connected: false }, // Node disconnected
            queue: {
                current: { info: { identifier: 'track_1', title: 'Test Track', duration: 180000 } }
            }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'public'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        const state = monitor.getOrCreateState('guild_audio_stall_test');
        state.lastProgressTimestamp = Date.now() - 25000; // 25s ago (exceeds STALL_THRESHOLD_MS of 18s)
        state.stalledChecks = 1;

        let recovered = false;
        monitor.recoverPlayback = async () => { recovered = true; };

        await monitor.checkPlayersForStalls();

        assert.strictEqual(recovered, false, 'Must NOT trigger recovery when node is disconnected');
        assert.strictEqual(state.stalledChecks, 0, 'stalledChecks should reset on disconnected node');
    });

    // Test 5: stopPlayer aborts in-flight /play requests
    await test('5. stopPlayer aborts in-flight /play requests for the guild', async () => {
        const guildId = 'guild_stop_abort_test';
        let aborted = false;
        const mockAbortController = {
            abort: () => { aborted = true; }
        };

        const playCommand = require('../src/commands/play');
        playCommand._inFlightPlayRequests.set(guildId, {
            interactionId: 'inter_play_stop',
            abortController: mockAbortController,
            superseded: false,
            completed: false,
        });

        const mockPlayer = {
            guildId,
            playing: true,
            paused: false,
            stopPlaying: async () => {},
            setData: () => {},
            getData: () => null,
            queue: { tracks: [], current: null }
        };

        const mockClient = {
            commands: new Map([['play', playCommand]]),
            playerController: { showStoppedState: async () => {} }
        };

        await stopPlayer(mockClient, mockPlayer);

        assert.strictEqual(aborted, true, 'In-flight /play request must be aborted when stopPlayer runs');
        assert.strictEqual(playCommand._inFlightPlayRequests.has(guildId), false, 'inFlightPlayRequests must be cleared');
    });

    // Test 6: PerformanceMonitor records timeouts truthfully and preserves metrics
    await test('6. PerformanceMonitor records timeouts separately and preserves truthful metrics', async () => {
        performanceMonitor.recordInteraction('command', 'test_timeout', 20000, { isTimeout: true });
        const metrics = performanceMonitor.getMetricsSummary();

        assert.ok(metrics.interactions.timeouts >= 1, 'Timeouts must be tracked separately');
        assert.ok(metrics.interactions.maxDurationMs >= 20000, 'Max duration should reflect truthful execution time');
        assert.ok(metrics.nodeValidation !== undefined, 'Node validation metrics section exists');
    });

    // Test 7: PublicNodeProvider getNextValidatedNode probes candidates concurrently
    await test('7. PublicNodeProvider probes candidate nodes concurrently without sequential delay', async () => {
        const provider = new PublicNodeProvider();
        provider.nodes = [
            { host: 'node-a.test', port: 443, password: 'youshallnotpass', secure: true, version: 'v4' },
            { host: 'node-b.test', port: 443, password: 'youshallnotpass', secure: true, version: 'v4' },
            { host: 'node-c.test', port: 443, password: 'youshallnotpass', secure: true, version: 'v4' },
        ];

        let probeCount = 0;
        provider.checkNodeCompatibility = async (cand) => {
            probeCount++;
            await new Promise(r => setTimeout(r, 60)); // 60ms delay per candidate
            if (cand.host === 'node-c.test') {
                return { compatible: true, category: 'COMPATIBLE_V4', status: 200, version: '4.0.0' };
            }
            return { compatible: false, category: 'TRANSIENT_ERROR', status: 500 };
        };

        const start = Date.now();
        const selected = await provider.getNextValidatedNode({ maxCandidates: 3, probeTimeoutMs: 1000 });
        const elapsed = Date.now() - start;

        assert.ok(selected, 'Should find compatible candidate node-c');
        assert.strictEqual(selected.host, 'node-c.test');
        assert.strictEqual(probeCount, 3, 'All 3 candidates probed');
        // If sequential: 3 * 60 = 180ms+. If concurrent: ~60-80ms.
        assert.ok(elapsed < 140, `Expected concurrent execution (<140ms), got ${elapsed}ms`);
    });

    // Test 8: guildSettings.saveAsync writes asynchronously
    await test('8. guildSettings.saveAsync writes asynchronously without error', async () => {
        guildSettings.cache.set('test_guild_async', { volume: 80 });
        await guildSettings.saveAsync();
        assert.strictEqual(guildSettings.get('test_guild_async')?.volume, 80);
    });

    // Test 9: /play rejects users not in voice without deferring, superseding, or modifying in-flight requests
    await test('9. /play fast validation returns promptly without modifying in-flight requests', async () => {
        const playCommand = require('../src/commands/play');
        const guildId = 'g_fast_val';

        // Pre-register an active valid in-flight request
        playCommand._inFlightPlayRequests.set(guildId, {
            interactionId: 'valid_user_play',
            superseded: false,
            completed: false,
        });

        let safeReplyPayload = null;
        const mockInteraction = {
            id: 'invalid_user_play',
            guild: { id: guildId },
            guildId,
            member: { voice: { channel: null } }, // User NOT in voice
            options: { getString: () => 'any song', getBoolean: () => false },
            client: { defaultLanguage: 'en', languageManager: { get: () => 'You need to be in a voice channel!' } },
            deferred: true,
            editReply: async (payload) => { safeReplyPayload = payload; return payload; },
        };

        await playCommand.execute(mockInteraction);

        const active = playCommand._inFlightPlayRequests.get(guildId);
        assert.ok(active, 'Valid in-flight request must NOT have been deleted');
        assert.strictEqual(active.interactionId, 'valid_user_play', 'Valid in-flight request must NOT be overwritten');
        assert.strictEqual(active.superseded, false, 'Valid in-flight request must NOT be superseded by invalid command');
        assert.ok(safeReplyPayload, 'Immediate reply must be delivered to invalid user');

        playCommand._inFlightPlayRequests.delete(guildId);
    });

    // Test 10: handleAutoplay does not start music if player is stopped during discovery
    await test('10. handleAutoplay aborts and does not restart playback if player is stopped', async () => {
        const { handleAutoplay } = require('../src/utils/autoplay');
        const guildId = 'g_autoplay_abort';

        let playCalled = false;
        const mockPlayer = {
            guildId,
            playing: false,
            queue: {
                tracks: [],
                current: null,
                add: async () => {},
            },
            play: async () => { playCalled = true; },
            getData: (k) => k === 'internal_stopPlaying' ? true : null,
        };

        const mockClient = {
            autoplayEnabled: new Map([[guildId, true]]),
        };

        const started = await handleAutoplay(mockClient, mockPlayer, 'queueEnd');
        assert.strictEqual(started, false, 'handleAutoplay must return false when stopped');
        assert.strictEqual(playCalled, false, 'player.play must NOT be called when stopped');
    });

    // Test 11: PublicNodeProvider early-exits when candidate 0 succeeds and aborts candidate 1
    await test('11. PublicNodeProvider early-exits when candidate 0 succeeds without waiting for candidate 1', async () => {
        const provider = new PublicNodeProvider();
        provider.nodes = [
            { host: 'fast-node.test', port: 443, password: 'youshallnotpass', secure: true, version: 'v4' },
            { host: 'slow-node.test', port: 443, password: 'youshallnotpass', secure: true, version: 'v4' },
        ];

        let slowAborted = false;
        provider.checkNodeCompatibility = async (cand, { signal } = {}) => {
            if (cand.host === 'fast-node.test') {
                return { compatible: true, category: 'COMPATIBLE_V4', status: 200, version: '4.0.0' };
            }
            if (cand.host === 'slow-node.test') {
                await new Promise((r) => {
                    const timer = setTimeout(r, 2000);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            slowAborted = true;
                            clearTimeout(timer);
                            r();
                        });
                    }
                });
                return { compatible: false, category: 'ABORTED', status: null };
            }
        };

        const start = Date.now();
        const selected = await provider.getNextValidatedNode({ maxCandidates: 2, probeTimeoutMs: 2000 });
        const elapsed = Date.now() - start;

        assert.ok(selected, 'Must find fast-node');
        assert.strictEqual(selected.host, 'fast-node.test');
        assert.ok(elapsed < 200, `Fast node should resolve immediately (<200ms), took ${elapsed}ms`);
        assert.strictEqual(slowAborted, true, 'Slower probe must be aborted');
    });

    console.log(`\nAll ${passed} Master Performance & Audio Stability repair tests passed successfully!`);
}

run().then(() => {
    process.exit(process.exitCode || 0);
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
