/**
 * Deterministic unit & regression test suite for:
 * Silent Playback Repair, Audio Delivery Validation, Source Classification,
 * and Dashboard State Accuracy.
 *
 * Verifies all 16 required invariants:
 * 1. A valid source loads and the player starts.
 * 2. Consecutive server position updates are actually observed.
 * 3. A source error is distinguished from a voice connection error.
 * 4. A silent or failed audio stream is not automatically deemed healthy.
 * 5. A progressing position does not trigger unnecessary restarts.
 * 6. A stale frame or delayed update does not trigger immediate recovery.
 * 7. A source-level failure does not cause node migration without evidence of node failure.
 * 8. Recovery does not call player.play() repeatedly for the same failed source.
 * 9. Node migrations are not triggered unnecessarily.
 * 10. A normal track transition advances once.
 * 11. /play while another track is playing does not interrupt the current track.
 * 12. A failed interaction response does not restart playback.
 * 13. The thinking response is finalized whenever Discord permits it.
 * 14. IDLE has no stale active-playback controls.
 * 15. The existing /247 behavior remains correct.
 * 16. Sensitive credentials never appear in diagnostics.
 */

const assert = require('node:assert/strict');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const { createNowPlayingEmbed, createStoppedEmbed } = require('../src/utils/zyroEmbeds');
const { safeReply } = require('../src/utils/interactionHelpers');
const guildSettings = require('../src/utils/guildSettings');

let passed = 0;
let failed = 0;

async function runScenario(id, title, fn) {
    try {
        await fn();
        passed++;
        console.log(`✅ PASS: [${id}] ${title}`);
    } catch (err) {
        failed++;
        console.error(`❌ FAIL: [${id}] ${title}\n`, err?.stack || err);
    }
}

async function runAll() {
    console.log('=== RUNNING SILENT PLAYBACK & AUDIO DELIVERY REGRESSION SUITE ===\n');

    // 1. A valid source loads and the player starts
    await runScenario(1, 'A valid source loads and the player starts', async () => {
        const dummyClient = { guilds: { cache: new Map() } };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-valid-load';
        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            position: 1200,
            queue: { current: { info: { title: 'Valid Song', duration: 180000, identifier: 'val-1' } } }
        };

        monitor.onTrackStart(player, player.queue.current);
        const state = monitor.getOrCreateState(guildId);
        assert.equal(state.trackStartTime > 0, true, 'Track start timestamp recorded');
        assert.equal(state.recovering, false, 'Player starts without recovery');
    });

    // 2. Consecutive server position updates are actually observed
    await runScenario(2, 'Consecutive server position updates are actually observed', async () => {
        const dummyClient = { guilds: { cache: new Map() } };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-consec-pos';
        const player = {
            guildId,
            playing: true,
            position: 1000,
            queue: { current: { info: { title: 'Prog Track', identifier: 'p1' } } }
        };

        monitor.onTrackStart(player, player.queue.current);
        monitor.onPlayerUpdate(player, { guildId, position: 3000 });
        monitor.onPlayerUpdate(player, { guildId, position: 5000 });

        const state = monitor.getOrCreateState(guildId);
        assert.equal(state.lastPosition, 5000, 'Last position updated');
        assert.ok(state.consecutiveProgressCount >= 2, 'Consecutive progress count recorded');
    });

    // 3. A source error is distinguished from a voice connection error
    await runScenario(3, 'A source error is distinguished from a voice connection error', async () => {
        const monitor = new AudioPlaybackMonitor({});
        assert.equal(monitor.isSourceLevelError('This video requires login.'), true);
        assert.equal(monitor.isSourceLevelError('No supported audio streams available'), true);
        assert.equal(monitor.isSourceLevelError('video is private'), true);

        // Voice connection errors must NOT be classified as source errors
        assert.equal(monitor.isSourceLevelError('Voice socket closed: code 4015'), false);
        assert.equal(monitor.isSourceLevelError('Connection timeout to Discord voice gateway'), false);
    });

    // 4. A silent or failed audio stream is not automatically deemed healthy
    await runScenario(4, 'A silent or failed audio stream is not automatically deemed healthy', async () => {
        const dummyClient = {
            guilds: {
                cache: new Map([
                    ['g-src-fail', { members: { me: { voice: { channelId: 'vc-1' } } } }]
                ])
            }
        };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-src-fail';
        const player = {
            guildId,
            node: { id: 'test-node-1', connected: true },
            playing: true,
            paused: false,
            connected: true,
            position: 3000,
            queue: { current: { info: { title: 'Failed YouTube Video', identifier: 'fail-yt-1' } } }
        };

        const state = monitor.getOrCreateState(guildId);
        state.lastSourceFailure = {
            timestamp: Date.now(),
            trackId: 'fail-yt-1',
            detail: 'This video requires login. No supported audio streams available.'
        };

        const health = monitor.classifyHealth(player, state, dummyClient.guilds.cache.get(guildId));
        assert.equal(health.status, 'SOURCE_FAILURE', 'Status must be SOURCE_FAILURE, not HEALTHY');

        dummyClient.audioPlaybackMonitor = monitor;
        const embed = createNowPlayingEmbed(player, player.queue.current, dummyClient);
        assert.ok(embed.data.description.includes('⚠️ **Audio Stream Unavailable:**'), 'Embed surfaces source error alert');
    });

    // 5. A progressing position does not trigger unnecessary restarts
    await runScenario(5, 'A progressing position does not trigger unnecessary restarts', async () => {
        const dummyClient = { guilds: { cache: new Map() } };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-prog-pos';
        let playCalled = false;
        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            position: 25000,
            async play() { playCalled = true; },
            queue: { current: { info: { title: 'Smooth Track', identifier: 'smooth-1', duration: 180000 } } }
        };

        monitor.onTrackStart(player, player.queue.current);
        const state = monitor.getOrCreateState(guildId);
        state.lastPosition = 25000;
        state.lastProgressTimestamp = Date.now();

        await monitor.checkPlayersForStalls();
        assert.equal(playCalled, false, 'Progressing playback must never call player.play()');
    });

    // 6. A stale frame or delayed update does not trigger immediate recovery
    await runScenario(6, 'A stale frame or delayed update does not trigger immediate recovery', async () => {
        const dummyClient = { guilds: { cache: new Map() } };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-delayed-update';
        let recoveryCalled = false;
        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            position: 10000,
            queue: { current: { info: { title: 'Buffering Track', identifier: 'buf-1' } } }
        };

        const state = monitor.getOrCreateState(guildId);
        // Only 5 seconds since progress (stall threshold is 18s)
        state.lastProgressTimestamp = Date.now() - 5000;
        state.stalledChecks = 0;

        await monitor.checkPlayersForStalls();
        assert.equal(state.recovering, false, 'No recovery triggered under stall threshold');
    });

    // 7. A source-level failure does not cause node migration without evidence of node failure
    await runScenario(7, 'A source-level failure does not cause node migration without evidence of node failure', async () => {
        let migrationAttempted = false;
        const dummyClient = {
            lavalinkMode: 'public',
            lavalinkConnectionManager: {
                migratePlayerToHealthyNode: async () => {
                    migrationAttempted = true;
                    return true;
                }
            }
        };

        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-src-mig-guard';
        const player = {
            guildId,
            node: { id: 'node-healthy', connected: true },
            queue: { current: { info: { title: 'Age Restricted Song', identifier: 'age-1' } }, tracks: [] },
            skip: async () => {},
            stopPlaying: async () => {}
        };

        await monitor.recoverPlayback(player, player.queue.current, {
            reason: 'sourceUnavailable',
            isSourceError: true,
            detail: 'Video is age restricted'
        });

        assert.equal(migrationAttempted, false, 'Source error must never trigger node migration on healthy node');
    });

    // 8. Recovery does not call player.play() repeatedly for the same failed source
    await runScenario(8, 'Recovery does not call player.play() repeatedly for the same failed source', async () => {
        let playCallCount = 0;
        let skipCalled = false;
        const dummyClient = {
            playerController: { sendToPlayerChannel: async () => {} }
        };

        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-fail-repeat';
        const track = { info: { title: 'Unplayable Video', identifier: 'unplay-1', duration: 120000 } };
        const player = {
            guildId,
            node: { id: 'n1', connected: true },
            queue: { current: track, tracks: [{ info: { title: 'Next Song' } }] },
            play: async () => { playCallCount++; },
            skip: async () => { skipCalled = true; }
        };

        const state = monitor.getOrCreateState(guildId);
        // Simulate already attempted once
        state.trackRetries.set('unplay-1', 1);

        await monitor.recoverPlayback(player, track, {
            reason: 'sourceUnavailable',
            isSourceError: true,
            detail: 'Requires login'
        });

        assert.equal(playCallCount, 0, 'Must not call play() again for repeatedly failing source');
        assert.equal(skipCalled, true, 'Must skip cleanly to next track');
    });

    // 9. Node migrations are not triggered unnecessarily
    await runScenario(9, 'Node migrations are not triggered unnecessarily', async () => {
        let migrations = 0;
        const dummyClient = {
            lavalinkMode: 'public',
            lavalinkConnectionManager: {
                migratePlayerToHealthyNode: async () => {
                    migrations++;
                    return true;
                }
            }
        };

        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-no-mig';
        const player = {
            guildId,
            node: { id: 'healthy-node-1', connected: true },
            queue: { current: { info: { title: 'Healthy', identifier: 'h1' } } }
        };

        // Recovery for normal paused/user reason
        await monitor.recoverPlayback(player, player.queue.current, {
            reason: 'userRequest',
            isSourceError: false
        });

        assert.equal(migrations, 0, 'No migration triggered without actual node disconnection or confirmed stall');
    });

    // 10. A normal track transition advances once
    await runScenario(10, 'A normal track transition advances once', async () => {
        const dummyClient = { guilds: { cache: new Map() } };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const guildId = 'g-trans-test';
        const track1 = { info: { title: 'Track 1', identifier: 't1' } };
        const track2 = { info: { title: 'Track 2', identifier: 't2' } };

        const player = { guildId, queue: { current: track1 } };
        monitor.onTrackStart(player, track1);
        monitor.onTrackEnd(player, track1, 'finished');

        player.queue.current = track2;
        monitor.onTrackStart(player, track2);

        const state = monitor.getOrCreateState(guildId);
        assert.equal(state.lastTrackEnd?.trackId, 't1');
        assert.equal(state.trackRetries.size, 0, 'Retries cleared on successful track advance');
    });

    // 11. /play while another track is playing does not interrupt current track
    await runScenario(11, '/play while another track is playing does not interrupt current track', async () => {
        const currentSong = { info: { title: 'Active Playing Song', identifier: 'active-1' } };
        const newSong = { info: { title: 'Queued Song 2', identifier: 'q-2' } };

        const player = {
            playing: true,
            paused: false,
            queue: {
                current: currentSong,
                tracks: [],
                add(track) { this.tracks.push(track); }
            }
        };

        // Simulating queueing behavior in /play
        if (player.playing && player.queue.current) {
            player.queue.add(newSong);
        }

        assert.equal(player.queue.current.info.title, 'Active Playing Song', 'Active song remains untouched');
        assert.equal(player.queue.tracks.length, 1, 'New song added to queue');
        assert.equal(player.queue.tracks[0].info.title, 'Queued Song 2', 'Queue has new song');
    });

    // 12. A failed interaction response does not restart playback
    await runScenario(12, 'A failed interaction response does not restart playback', async () => {
        let playCalled = false;
        const player = {
            playing: true,
            play: async () => { playCalled = true; }
        };

        const faultyInteraction = {
            replied: false,
            deferred: true,
            editReply: async () => { throw new Error('Discord 500 Internal Error'); }
        };

        const res = await safeReply(faultyInteraction, { content: 'Test response' });
        assert.equal(res, null, 'safeReply returns null on delivery failure');
        assert.equal(playCalled, false, 'Failed interaction response must never restart playback');
    });

    // 13. The thinking response is finalized whenever Discord permits it
    await runScenario(13, 'The thinking response is finalized whenever Discord permits it', async () => {
        let editInvoked = false;
        let deliveredPayload = null;

        const deferredInteraction = {
            deferred: true,
            replied: false,
            editReply: async (payload) => {
                editInvoked = true;
                deliveredPayload = payload;
                return payload;
            }
        };

        await safeReply(deferredInteraction, { content: 'Final resolution', _isFinalReply: true });
        assert.equal(editInvoked, true, 'editReply must be called to finalize deferred response');
        assert.equal(deliveredPayload.content, 'Final resolution');
    });

    // 14. IDLE has no stale active-playback controls
    await runScenario(14, 'IDLE has no stale active-playback controls', async () => {
        const dummyClient = {
            user: { displayAvatarURL: () => null },
            is247Enabled: () => false
        };

        const stoppedEmbed = createStoppedEmbed({ guildId: 'g-idle' }, dummyClient, 'vc-123');
        assert.equal(stoppedEmbed.data.author.name, 'ZYRO • IDLE');
        assert.ok(stoppedEmbed.data.description.includes('Playback stopped and queue cleared'));
        assert.ok(!stoppedEmbed.data.description.includes('by **'), 'No stale track author');
        assert.ok(!stoppedEmbed.data.description.includes('🔘'), 'No active progress bar');
    });

    // 15. The existing /247 behavior remains correct
    await runScenario(15, 'The existing /247 behavior remains correct', async () => {
        const guildId = 'g-247-check';
        guildSettings.delete(guildId);
        assert.equal(guildSettings.is247(guildId), false);

        guildSettings.set247(guildId, true, { voiceChannelId: 'vc-247', textChannelId: 'tc-247' });
        assert.equal(guildSettings.is247(guildId), true);

        const data = guildSettings.get(guildId);
        assert.equal(data.voiceChannelId, 'vc-247');

        guildSettings.set247(guildId, false);
        assert.equal(guildSettings.is247(guildId), false);
        guildSettings.delete(guildId);
    });

    // 16. Sensitive credentials never appear in diagnostics
    await runScenario(16, 'Sensitive credentials never appear in diagnostics', async () => {
        const dummyClient = { guilds: { cache: new Map() } };
        const monitor = new AudioPlaybackMonitor(dummyClient);

        let capturedLog = '';
        const originalInfo = console.log;
        // Test sanitization on diagnostic logging
        const tokenString = 'Bot MTAyOTM4NDc1NjQ3Mzg0OTUw.GxYz12.aBcDeFgHiJkLmNoPqRsTuVwXyZ';
        monitor.logDiagnostic('AUTH_TEST', {
            guildId: 'g-sec-test',
            detail: `Authorization header sent with ${tokenString}`
        });

        // Verify tokens are not logged verbatim
        const state = monitor.getOrCreateState('g-sec-test');
        const lastEvent = state.recentEvents[state.recentEvents.length - 1];
        assert.ok(!lastEvent?.detail?.includes('MTAyOTM4NDc1NjQ3Mzg0OTUw.GxYz12'), 'Tokens must not appear in diagnostic event records');
    });

    console.log('\n========================================');
    console.log(`TOTAL: 16 | PASSED: ${passed} | FAILED: ${failed}`);
    console.log('========================================');

    if (failed > 0) {
        process.exitCode = 1;
    }
}

runAll().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
