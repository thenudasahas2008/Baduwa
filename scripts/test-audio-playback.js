const assert = require('node:assert/strict');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');
const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
const { searchMusic, resolveAlternativeTrack } = require('../src/utils/searchEngine');

let passed = 0;
function check(name, fn) {
    try {
        const res = fn();
        if (res && typeof res.then === 'function') {
            return res.then(() => {
                passed++;
                console.log(`  ok  - ${name}`);
            }).catch((err) => {
                console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
                process.exitCode = 1;
            });
        }
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
        process.exitCode = 1;
    }
}

async function runTests() {
    console.log('Testing ZYRO Audio Playback Monitor, Watchdog & Recovery Flow...');

    // Test 1: Normal playback continues without unnecessary recovery
    await check('1. Normal playback continues without unnecessary recovery', async () => {
        let playCount = 0;
        const mockPlayer = {
            guildId: 'g1',
            playing: true,
            paused: false,
            position: 1000,
            node: { id: 'node-1', host: 'node1.test', port: 443 },
            queue: {
                current: {
                    info: { identifier: 'track-1', title: 'Normal Track', author: 'Artist 1', duration: 180000, isStream: false }
                },
                tracks: []
            },
            play: async () => { playCount++; }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        monitor.onTrackStart(mockPlayer, mockPlayer.queue.current);

        // Progress advances normally
        monitor.onPlayerUpdate(mockPlayer, { ...mockPlayer, position: 2500 });
        monitor.onPlayerUpdate(mockPlayer, { ...mockPlayer, position: 4000 });

        await monitor.checkPlayersForStalls();
        assert.equal(playCount, 0, 'Normal playback must not trigger recovery play calls');

        monitor.destroy();
    });

    // Test 2: Transient slow progress update does not cause immediate track restart
    await check('2. Transient slow progress update does not cause immediate track restart', async () => {
        let playCount = 0;
        const mockPlayer = {
            guildId: 'g2',
            playing: true,
            paused: false,
            position: 5000,
            node: { id: 'node-1', host: 'node1.test', port: 443 },
            queue: {
                current: {
                    info: { identifier: 'track-2', title: 'Buffering Track', author: 'Artist 2', duration: 180000, isStream: false }
                },
                tracks: []
            },
            play: async () => { playCount++; }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        monitor.onTrackStart(mockPlayer, mockPlayer.queue.current);

        // Simulate 4 seconds of buffering (less than the 10s stall threshold)
        const state = monitor.getOrCreateState('g2');
        state.lastProgressTimestamp = Date.now() - 4000;

        await monitor.checkPlayersForStalls();
        assert.equal(playCount, 0, 'Transient delay under stall threshold must not trigger track restart');

        monitor.destroy();
    });

    // Test 3: Genuine TrackStuck event triggers only one recovery operation (deduplication)
    await check('3. Genuine TrackStuck event triggers only one recovery operation (deduplication)', async () => {
        let playCount = 0;
        let resolvePlay;
        const playPromise = new Promise(r => { resolvePlay = r; });

        const mockPlayer = {
            guildId: 'g3',
            playing: true,
            paused: false,
            position: 10000,
            node: { id: 'node-1', host: 'node1.test', port: 443 },
            queue: {
                current: {
                    info: { identifier: 'track-3', title: 'Stuck Track', author: 'Artist 3', duration: 180000, isStream: false }
                },
                tracks: []
            },
            play: async () => {
                playCount++;
                await playPromise;
            }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        monitor.onTrackStart(mockPlayer, mockPlayer.queue.current);

        // Trigger two stuck events simultaneously
        const p1 = monitor.onTrackStuck(mockPlayer, mockPlayer.queue.current, { thresholdMs: 10000 });
        const p2 = monitor.onTrackStuck(mockPlayer, mockPlayer.queue.current, { thresholdMs: 10000 });

        resolvePlay();
        await Promise.all([p1, p2]);

        assert.equal(playCount, 1, 'Concurrent stuck events must be deduplicated to exactly 1 recovery operation');
        monitor.destroy();
    });

    // Test 4: TrackException event is handled safely
    await check('4. TrackException event is handled safely', async () => {
        let playCount = 0;
        const mockPlayer = {
            guildId: 'g4',
            playing: true,
            paused: false,
            position: 15000,
            node: { id: 'node-1', host: 'node1.test', port: 443 },
            queue: {
                current: {
                    info: { identifier: 'track-4', title: 'Exception Track', author: 'Artist 4', duration: 200000, isStream: false }
                },
                tracks: []
            },
            play: async () => { playCount++; }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        monitor.onTrackStart(mockPlayer, mockPlayer.queue.current);

        const recovered = await monitor.onTrackError(mockPlayer, mockPlayer.queue.current, {
            exception: { message: 'AllClientsFailed: 403 Forbidden' }
        });

        assert.equal(recovered, true, 'TrackException should be recovered');
        assert.equal(playCount, 1, 'player.play should be invoked to resume track');
        monitor.destroy();
    });

    // Test 5: Disconnected Lavalink node enters cooldown and is not repeatedly selected
    await check('5. Disconnected Lavalink node enters cooldown and is not repeatedly selected', () => {
        const provider = new PublicNodeProvider();
        provider.nodes = [
            { host: 'flappy.node.com', port: 443, password: 'p1', secure: true },
            { host: 'stable.node.com', port: 443, password: 'p2', secure: true },
        ];

        // Mark flappy node failed
        provider.markNodeFailed('flappy.node.com', 443, 'audio-stall');
        assert.ok(provider.isNodeInCooldown('flappy.node.com', 443), 'Flappy node must be placed in cooldown');

        // Next node must select stable node
        const next = provider.getNextNode();
        assert.equal(next.host, 'stable.node.com', 'Next node must choose the healthy alternative');

        provider.destroy();
    });

    // Test 6: Failover to another node preserves the intended player and queue state
    await check('6. Failover to another node preserves the intended player and queue state', async () => {
        let changedNodeId = null;
        const targetTrack = { info: { identifier: 't6', title: 'Playing Track', author: 'Singer' } };
        const queuedTrack = { info: { identifier: 't7', title: 'Queued Next', author: 'Singer' } };

        const mockPlayer = {
            guildId: 'g6',
            playing: true,
            paused: false,
            position: 25000,
            node: { id: 'node-dead', host: 'dead.node.com', port: 443 },
            voice: { token: 'tok', endpoint: 'end', sessionId: 'ses', channelId: 'vc1' },
            queue: {
                current: targetTrack,
                tracks: [queuedTrack]
            },
            changeNode: async (newNode) => {
                changedNodeId = newNode.id;
                mockPlayer.node = newNode;
            }
        };

        const healthyNode = { id: 'node-healthy', host: 'healthy.node.com', port: 443, connected: true };
        const provider = new PublicNodeProvider();
        provider.nodes = [
            { host: 'dead.node.com', port: 443, password: 'p1', secure: true },
            { host: 'healthy.node.com', port: 443, password: 'p2', secure: true },
        ];

        const mockClient = {
            lavalinkMode: 'public',
            publicNodeProvider: provider,
            lavalink: {
                nodeManager: {
                    nodes: new Map([
                        ['node-dead', mockPlayer.node],
                        ['node-healthy', healthyNode],
                    ])
                }
            }
        };

        const connectionManager = new LavalinkConnectionManager(mockClient);
        const migrated = await connectionManager.migratePlayerToHealthyNode(mockPlayer, 'playback-stall');

        assert.equal(migrated, true, 'Migration must succeed');
        assert.equal(changedNodeId, 'node-healthy', 'Player must be migrated to healthy node');
        assert.equal(mockPlayer.queue.current.info.title, 'Playing Track', 'Current track preserved');
        assert.equal(mockPlayer.queue.tracks.length, 1, 'Upcoming queue preserved');
        assert.equal(mockPlayer.queue.tracks[0].info.title, 'Queued Next', 'Queue order preserved');

        provider.destroy();
    });

    // Test 7: Failed source resolution does not interrupt an already-playing valid track
    await check('7. Failed source resolution does not interrupt an already-playing valid track', async () => {
        const playingTrack = {
            info: { identifier: 'playing-id', title: 'Good Track', author: 'Author' }
        };
        const mockPlayer = {
            guildId: 'g7',
            playing: true,
            queue: { current: playingTrack, tracks: [] },
            search: async () => {
                throw new Error('Simulated YouTube Search Timeout');
            }
        };

        const alt = await resolveAlternativeTrack(mockPlayer, playingTrack);
        assert.equal(alt, null, 'Failed resolution gracefully returns null');
        assert.equal(mockPlayer.queue.current.info.title, 'Good Track', 'Playing track is not interrupted or removed');
        assert.equal(mockPlayer.playing, true, 'Player remains playing');
    });

    // Test 8: Duplicate events do not queue or play the same recovery track twice
    await check('8. Duplicate events do not queue or play the same recovery track twice', async () => {
        let playCount = 0;
        const track8 = {
            info: { identifier: 'id-dup-test', title: 'Deduplicated Song', duration: 150000, isStream: false }
        };

        const mockPlayer = {
            guildId: 'g8',
            playing: true,
            paused: false,
            position: 30000,
            node: { id: 'n1', host: 'n1.test', port: 443 },
            queue: { current: track8, tracks: [] },
            play: async () => { playCount++; }
        };

        const monitor = new AudioPlaybackMonitor({ lavalink: { getPlayer: () => mockPlayer }, lavalinkMode: 'local' });
        monitor.onTrackStart(mockPlayer, track8);

        // First recovery attempt
        const r1 = await monitor.recoverPlayback(mockPlayer, track8, { reason: 'stall' });
        assert.equal(r1, true, 'First recovery attempt should succeed');
        assert.equal(playCount, 1);

        // Fast duplicate trigger while recovering flag or same track
        const r2 = await monitor.recoverPlayback(mockPlayer, track8, { reason: 'stall' });
        assert.equal(playCount, 2, 'Second distinct attempt within max retries succeeds');

        // Third attempt exceeds MAX_TRACK_RETRIES (2), preventing duplicate infinite loop
        let skipped = false;
        mockPlayer.skip = async () => { skipped = true; };
        mockPlayer.stopPlaying = async () => {};

        const r3 = await monitor.recoverPlayback(mockPlayer, track8, { reason: 'stall' });
        assert.equal(r3, false, 'Third attempt must be rejected and skip');
        assert.equal(playCount, 2, 'Must not play the failing track again');
        assert.equal(skipped, false, 'Queue empty, stopped instead of infinite skip');

        monitor.destroy();
    });

    // Test 9: Failed recovery does not create zombie players, false playing: true state or unhandled promise rejections
    await check('9. Failed recovery does not create zombie players, false playing: true state or unhandled promise rejections', async () => {
        let stopped = false;
        const failingTrack = {
            info: { identifier: 'fail-track', title: 'Broken Track', duration: 120000, isStream: false }
        };
        const mockPlayer = {
            guildId: 'g9',
            playing: true,
            paused: false,
            position: 5000,
            node: { id: 'n1', host: 'n1.test', port: 443 },
            queue: { current: failingTrack, tracks: [] },
            play: async () => { throw new Error('Unrecoverable audio stream failure'); },
            stopPlaying: async () => { stopped = true; mockPlayer.playing = false; }
        };

        let stoppedStateShown = false;
        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local',
            playerController: {
                sendToPlayerChannel: async () => {},
                showStoppedState: () => { stoppedStateShown = true; }
            }
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        const state = monitor.getOrCreateState('g9');
        state.trackRetries.set('fail-track', 2); // At limit

        const res = await monitor.recoverPlayback(mockPlayer, failingTrack, { reason: 'terminal-error' });
        assert.equal(res, false, 'Terminal error returns false without throwing');
        assert.equal(stopped, true, 'Player stopPlaying must be called');
        assert.equal(mockPlayer.playing, false, 'Playing must not remain true');
        assert.equal(stoppedStateShown, true, 'Stopped state must be displayed');

        monitor.destroy();
    });

    // Test 10: Recovery does not change /247 into autoplay or start unsolicited music
    await check('10. Recovery does not change /247 into autoplay or start unsolicited music', async () => {
        const guildId = 'g10-247';
        let autoplayEnabled = false;
        let unsolicitedTrackPlayed = false;

        const mockClient = {
            lavalinkMode: 'local',
            is247Enabled: (gId) => gId === guildId,
            autoplayEnabled: new Map([[guildId, false]]),
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    playing: false,
                    paused: false,
                    queue: { current: null, tracks: [] },
                    play: () => { unsolicitedTrackPlayed = true; }
                })
            }
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        // Run stall check on idle 24/7 player
        await monitor.checkPlayersForStalls();

        assert.equal(unsolicitedTrackPlayed, false, 'Idle 24/7 player must not play unsolicited music');
        assert.equal(mockClient.autoplayEnabled.get(guildId), false, '24/7 must not be mutated to autoplay: true');

        monitor.destroy();
    });

    // Test 11: Dashboard and Voice Channel Status reflect the real player state after recovery
    await check('11. Dashboard and Voice Channel Status reflect the real player state after recovery', async () => {
        let voiceStatusTrack = null;
        let dashboardRefreshed = false;

        const recoveredTrack = {
            info: { identifier: 'id-rec', title: 'Recovered Hit', author: 'Hitmaker', duration: 180000, isStream: false }
        };

        const mockPlayer = {
            guildId: 'g11',
            playing: true,
            paused: false,
            position: 12000,
            textChannelId: 'tc-11',
            node: { id: 'node-ok', host: 'node-ok.test', port: 443 },
            queue: { current: recoveredTrack, tracks: [] },
            play: async () => {}
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local',
            voiceChannelStatusManager: {
                updateFromPlayer: async (player, track, state) => {
                    voiceStatusTrack = track;
                }
            },
            playerController: {
                replaceWithFullDashboard: async (gId, chId, opts) => {
                    dashboardRefreshed = true;
                }
            }
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        await monitor.recoverPlayback(mockPlayer, recoveredTrack, { reason: 'buffer-recovered' });

        assert.ok(voiceStatusTrack, 'Voice status update must be triggered');
        assert.equal(voiceStatusTrack.info.title, 'Recovered Hit', 'Voice channel status displays recovered song');
        assert.equal(dashboardRefreshed, true, 'Full player dashboard must be refreshed at bottom');

        monitor.destroy();
    });

    // Test 12: A long-running simulated session does not accumulate duplicate timers or background tasks
    await check('12. A long-running simulated session does not accumulate duplicate timers or background tasks', async () => {
        const mockPlayer = {
            guildId: 'g12',
            playing: true,
            paused: false,
            position: 1000,
            node: { id: 'n1', host: 'n1.test', port: 443 },
            queue: {
                current: { info: { identifier: 't1', title: 'Track 1', duration: 100000, isStream: false } },
                tracks: []
            },
            play: async () => {}
        };

        const monitor = new AudioPlaybackMonitor({ lavalink: { getPlayer: () => mockPlayer }, lavalinkMode: 'local' });

        // Simulate 10 trackStart events across multiple tracks
        for (let i = 1; i <= 10; i++) {
            monitor.onTrackStart(mockPlayer, { info: { identifier: `t${i}`, title: `Track ${i}` } });
            assert.ok(monitor.watchdogInterval, 'Watchdog interval should be active');
        }

        const activeInterval = monitor.watchdogInterval;
        // Start another track - should NOT create duplicate interval
        monitor.onTrackStart(mockPlayer, { info: { identifier: 't11', title: 'Track 11' } });
        assert.equal(monitor.watchdogInterval, activeInterval, 'Watchdog interval must be deduplicated and reused');

        // Destroy player
        monitor.onPlayerDestroy(mockPlayer);
        assert.equal(monitor.monitoredPlayers.size, 0, 'Monitored players cleared on destroy');
        assert.equal(monitor.watchdogInterval, null, 'Watchdog stopped when zero players remain');

        monitor.destroy();
    });

    console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
    process.exit(process.exitCode ? 1 : 0);
}

runTests();
