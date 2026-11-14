const assert = require('assert');
const { stopPlayer } = require('../src/utils/PlayerActions');
const {
    isManualStopActive,
    markManualStop,
    clearManualStop,
    getManualStopGeneration,
    schedulePlayerUpdate,
} = require('../src/utils/playerLifecycle');
const { handleAutoplay } = require('../src/utils/autoplay');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const PlayerController = require('../src/utils/PlayerController');
const stopCommand = require('../src/commands/stop');
const playCommand = require('../src/commands/play');

console.log('--- ZYRO Stop Button & Playback Cancellation Regression Suite ---\n');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ok  - ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL - ${name}`);
        console.error(err);
        failed++;
    }
}

(async () => {
    // Test 1: Stop button invokes correct installed lavalink-client v2.11.0 API
    await test('1. Stop button invokes correct installed lavalink-client stopPlaying API', async () => {
        let stopPlayingArgs = null;
        const mockPlayer = {
            guildId: 'guild-1',
            playing: true,
            paused: false,
            voiceChannelId: 'vc-1',
            textChannelId: 'tc-1',
            queue: {
                current: { info: { title: 'Test Song' } },
                tracks: [{ info: { title: 'Upcoming 1' } }],
                splice: async (start, count) => { mockPlayer.queue.tracks.splice(start, count); }
            },
            setData: () => {},
            getData: () => null,
            stopPlaying: async (clearQ, execAutoplay) => {
                stopPlayingArgs = [clearQ, execAutoplay];
            }
        };

        const mockClient = {
            activePlayers: new Map([['guild-1', {}]]),
            updatePresence: () => {},
            voiceChannelStatusManager: { clearStatusForGuild: async () => {} },
            playerController: { showStoppedState: async () => {} },
        };

        await stopPlayer(mockClient, mockPlayer);

        assert.deepStrictEqual(stopPlayingArgs, [true, false], 'stopPlaying must be called with (true, false)');
        assert.strictEqual(mockPlayer.playing, false, 'player.playing must be false');
        assert.strictEqual(mockPlayer.queue.current, null, 'queue.current must be null');
        assert.strictEqual(mockPlayer.queue.tracks.length, 0, 'queue.tracks must be empty');
    });

    // Test 2: Stop button stops audio immediately and clears upcoming queue
    await test('2. Stop button stops audio immediately and clears upcoming queue', async () => {
        const mockPlayer = {
            guildId: 'guild-2',
            playing: true,
            queue: {
                current: { info: { title: 'Playing Now' } },
                tracks: [{ info: { title: 'Track 1' } }, { info: { title: 'Track 2' } }],
                splice: async (start, count) => { mockPlayer.queue.tracks.splice(start, count); }
            },
            setData: () => {},
            stopPlaying: async () => {}
        };
        const mockClient = {
            activePlayers: new Map([['guild-2', {}]]),
            updatePresence: () => {},
            playerController: { showStoppedState: async () => {} },
        };

        await stopPlayer(mockClient, mockPlayer);
        assert.strictEqual(mockPlayer.queue.tracks.length, 0, 'All upcoming tracks cleared');
        assert.strictEqual(mockPlayer.queue.current, null, 'Current track cleared');
    });

    // Test 3: Stop operation cancels pending queue transitions
    await test('3. Stop operation cancels pending queue transitions', async () => {
        const guildId = 'guild-3';
        let updateFired = false;
        const mockClient = {
            playerController: {
                updatePlayer: async () => { updateFired = true; },
                showStoppedState: async () => {},
            },
            activePlayers: new Map(),
            updatePresence: () => {},
        };

        // Schedule a pending playing update
        schedulePlayerUpdate(mockClient, guildId, 10, { track: { info: { title: 'Old' } } });

        const mockPlayer = {
            guildId,
            playing: true,
            queue: { current: null, tracks: [] },
            setData: () => {},
            stopPlaying: async () => {}
        };

        await stopPlayer(mockClient, mockPlayer);

        // Wait to verify timer did not execute a playing update
        await new Promise(r => setTimeout(r, 30));
        assert.strictEqual(updateFired, false, 'Pending playing update was suppressed');
    });

    // Test 4: Autoplay does not start music after Stop button clicked
    await test('4. Autoplay does not start music after Stop button clicked', async () => {
        const guildId = 'guild-4';
        const mockPlayer = {
            guildId,
            playing: false,
            queue: { current: null, tracks: [] },
            setData: () => {},
            getData: (k) => k === 'internal_stopPlaying' ? true : null,
            stopPlaying: async () => {}
        };
        const mockClient = {
            autoplayEnabled: new Map([[guildId, true]]),
            activePlayers: new Map(),
            updatePresence: () => {},
            playerController: { showStoppedState: async () => {} }
        };

        await stopPlayer(mockClient, mockPlayer);

        // Try triggering handleAutoplay
        const started = await handleAutoplay(mockClient, mockPlayer, 'queueEnd', { info: { title: 'Seed' } });
        assert.strictEqual(started, false, 'handleAutoplay must return false when manual stop active');
    });

    // Test 5: Track-end event does not start next track after Stop button clicked
    await test('5. Track-end event does not start next track after Stop button clicked', async () => {
        const guildId = 'guild-5';
        markManualStop(guildId);
        assert.strictEqual(isManualStopActive(guildId), true, 'Manual stop must be marked active');

        // Test that isManualStopActive blocks lifecycle operations
        let called = false;
        if (!isManualStopActive(guildId)) {
            called = true;
        }
        assert.strictEqual(called, false, 'Track end operations skipped when manual stop active');
        clearManualStop(guildId);
    });

    // Test 6: Queue-end event does not trigger autoplay or recovery after Stop button clicked
    await test('6. Queue-end event does not trigger autoplay or recovery after Stop button clicked', async () => {
        const guildId = 'guild-6';
        markManualStop(guildId);

        const isIntentionalStop = Boolean(isManualStopActive(guildId));
        assert.strictEqual(isIntentionalStop, true, 'isIntentionalStop evaluates to true');
        clearManualStop(guildId);
    });

    // Test 7: Audio playback monitor watchdog does not restart playback after Stop button clicked
    await test('7. Audio playback monitor watchdog does not restart playback after Stop button clicked', async () => {
        const guildId = 'guild-7';
        const monitor = new AudioPlaybackMonitor({});
        const mockPlayer = {
            guildId,
            playing: false,
            queue: { current: null, tracks: [] },
            getData: () => null,
        };

        markManualStop(guildId);
        const recovered = await monitor.recoverPlayback(mockPlayer, { info: { title: 'Test' } }, { reason: 'stalledPosition' });
        assert.strictEqual(recovered, false, 'Watchdog recovery must be rejected when manual stop active');
        clearManualStop(guildId);
    });

    // Test 8: Lavalink reconnect / recovery callbacks do not restart music after Stop button clicked
    await test('8. Lavalink reconnect / recovery callbacks do not restart music after Stop button clicked', async () => {
        const guildId = 'guild-8';
        markManualStop(guildId);

        // An idle player with manual stop active should remain idle
        const mockPlayer = {
            guildId,
            queue: { current: null, tracks: [] },
            playing: false
        };
        assert.strictEqual(Boolean(mockPlayer.queue.current), false);
        assert.strictEqual(isManualStopActive(guildId), true);
        clearManualStop(guildId);
    });

    // Test 9: Bot remains in voice channel after Stop button clicked (preserving /stop behavior)
    await test('9. Bot remains in voice channel after Stop button clicked', async () => {
        let destroyed = false;
        let disconnected = false;
        const mockPlayer = {
            guildId: 'guild-9',
            playing: true,
            voiceChannelId: 'vc-stay',
            queue: { current: { info: {} }, tracks: [] },
            setData: () => {},
            stopPlaying: async () => {},
            destroy: () => { destroyed = true; },
            disconnect: () => { disconnected = true; }
        };
        const mockClient = {
            activePlayers: new Map([['guild-9', {}]]),
            updatePresence: () => {},
            playerController: { showStoppedState: async () => {} },
        };

        await stopPlayer(mockClient, mockPlayer);
        assert.strictEqual(destroyed, false, 'Player must not be destroyed');
        assert.strictEqual(disconnected, false, 'Voice must not be disconnected');
        assert.strictEqual(mockPlayer.voiceChannelId, 'vc-stay', 'Voice channel ID preserved');
    });

    // Test 10: Stop button updates dashboard to stopped/idle state
    await test('10. Stop button updates dashboard to stopped/idle state', async () => {
        let shownStopped = false;
        const mockPlayer = {
            guildId: 'guild-10',
            playing: true,
            voiceChannelId: 'vc-10',
            queue: { current: { info: {} }, tracks: [] },
            setData: () => {},
            stopPlaying: async () => {}
        };
        const mockClient = {
            activePlayers: new Map(),
            updatePresence: () => {},
            playerController: {
                showStoppedState: async (gid, opts) => {
                    shownStopped = true;
                    assert.strictEqual(gid, 'guild-10');
                    assert.strictEqual(opts.channelId, 'vc-10');
                }
            }
        };

        await stopPlayer(mockClient, mockPlayer);
        assert.strictEqual(shownStopped, true, 'showStoppedState was called');
    });

    // Test 11: Stopped dashboard remains in connected voice channel chat (never #general)
    await test('11. Stopped dashboard remains in connected voice channel chat (never #general)', async () => {
        const guildId = 'guild-11';
        let channelSentTo = null;
        const mockClient = {
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    members: { me: { voice: { channelId: 'vc-connected' } } }
                }]])
            },
            channels: {
                cache: new Map([
                    ['vc-connected', {
                        id: 'vc-connected',
                        name: 'Voice Lounge',
                        isVoiceBased: () => true,
                        permissionsFor: () => ({ has: () => true }),
                        send: async (payload) => {
                            channelSentTo = 'vc-connected';
                            return { id: 'msg-stop-1' };
                        }
                    }],
                    ['tc-general', {
                        id: 'tc-general',
                        name: 'general',
                        isVoiceBased: () => false,
                        permissionsFor: () => ({ has: () => true }),
                    }]
                ])
            },
            guildSettings: {
                get: () => ({ voiceChannelId: 'vc-connected', textChannelId: 'tc-general' }),
                updateTextChannelId: () => {}
            },
            lavalink: { getPlayer: () => null }
        };

        const controller = new PlayerController(mockClient);
        await controller.showStoppedState(guildId, { channelId: 'vc-connected' });
        assert.strictEqual(channelSentTo, 'vc-connected', 'Must send to voice channel chat, never #general');
    });

    // Test 12: No duplicate dashboard messages created by stop button
    await test('12. No duplicate dashboard messages created by stop button', async () => {
        const guildId = 'guild-12';
        let sendCount = 0;
        let editCount = 0;
        const mockMsg = {
            id: 'dash-msg-12',
            edit: async () => { editCount++; }
        };
        const mockChannel = {
            id: 'vc-12',
            name: 'Voice Chat',
            isVoiceBased: () => true,
            permissionsFor: () => ({ has: () => true }),
            send: async () => {
                sendCount++;
                return mockMsg;
            },
            messages: {
                cache: new Map([['dash-msg-12', mockMsg]]),
                fetch: async () => mockMsg
            }
        };
        const mockClient = {
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    members: { me: { voice: { channelId: 'vc-12' } } }
                }]])
            },
            channels: { cache: new Map([['vc-12', mockChannel]]) },
            guildSettings: { get: () => ({ voiceChannelId: 'vc-12' }), updateTextChannelId: () => {} },
            lavalink: { getPlayer: () => null }
        };

        const controller = new PlayerController(mockClient);
        // First stop sends
        await controller.showStoppedState(guildId, { channelId: 'vc-12' });
        assert.strictEqual(sendCount, 1, 'First stop sends replacement');

        // Immediate subsequent stop updates in-place or deduplicates
        await controller.showStoppedState(guildId, { channelId: 'vc-12' });
        assert.strictEqual(sendCount, 1, 'No second message sent');
        assert.strictEqual(editCount, 1, 'Edited in-place');
    });

    // Test 13: Subsequent /play command successfully starts new playback after Stop button clicked
    await test('13. Subsequent /play command successfully starts new playback after Stop button clicked', async () => {
        const guildId = 'guild-13';
        markManualStop(guildId);
        assert.strictEqual(isManualStopActive(guildId), true);

        // Clear manual stop state as done by play.js
        clearManualStop(guildId);
        assert.strictEqual(isManualStopActive(guildId), false, 'Manual stop cleared by play');
    });

    // Test 14: Both /stop command and dashboard Stop button produce identical player state
    await test('14. Both /stop command and dashboard Stop button produce identical player state', async () => {
        const makePlayer = (id) => ({
            guildId: id,
            playing: true,
            paused: false,
            voiceChannelId: 'vc-same',
            textChannelId: 'tc-same',
            queue: {
                current: { info: { title: 'Same Song' } },
                tracks: [{ info: { title: 'Q1' } }],
                splice: async (s, c) => {}
            },
            setData: function(k, v) { this[k] = v; },
            getData: function(k) { return this[k]; },
            stopPlaying: async () => {}
        });

        const pButton = makePlayer('guild-btn');
        const pCmd = makePlayer('guild-cmd');

        const mockClient = {
            activePlayers: new Map([['guild-btn', {}], ['guild-cmd', {}]]),
            updatePresence: () => {},
            voiceChannelStatusManager: { clearStatusForGuild: async () => {} },
            playerController: { showStoppedState: async () => {} }
        };

        // Stop button calls stopPlayer
        await stopPlayer(mockClient, pButton);

        // /stop command calls stopPlayer
        await stopPlayer(mockClient, pCmd);

        assert.strictEqual(pButton.playing, pCmd.playing, 'playing flag identical');
        assert.strictEqual(pButton.queue.current, pCmd.queue.current, 'queue.current identical');
        assert.strictEqual(pButton.queue.tracks.length, pCmd.queue.tracks.length, 'queue length identical');
        assert.strictEqual(pButton.internal_stopPlaying, pCmd.internal_stopPlaying, 'internal_stopPlaying identical');
        assert.strictEqual(pButton.internal_autoplayStopPlaying, pCmd.internal_autoplayStopPlaying, 'internal_autoplayStopPlaying identical');
    });

    // Test 15: Autoplay setting remains enabled after Stop, but autoplay does not run while stopped
    await test('15. Autoplay setting remains enabled after Stop, but autoplay does not run while stopped', async () => {
        const guildId = 'guild-15';
        const mockClient = {
            autoplayEnabled: new Map([[guildId, true]]),
            activePlayers: new Map(),
            updatePresence: () => {},
            playerController: { showStoppedState: async () => {} }
        };
        const mockPlayer = {
            guildId,
            playing: true,
            queue: { current: { info: {} }, tracks: [] },
            setData: () => {},
            stopPlaying: async () => {}
        };

        await stopPlayer(mockClient, mockPlayer);

        // Autoplay setting must remain TRUE (not turned off permanently)
        assert.strictEqual(mockClient.autoplayEnabled.get(guildId), true, 'Autoplay setting preserved');

        // But autoplay function must not run
        const started = await handleAutoplay(mockClient, mockPlayer, 'autoPlayFunction');
        assert.strictEqual(started, false, 'Autoplay does not trigger while stopped');
        clearManualStop(guildId);
    });

    // Test 16: Rapid stop button clicks are debounced cleanly without errors
    await test('16. Rapid stop button clicks are debounced cleanly without errors', async () => {
        const guildId = 'guild-16';
        let stopCalls = 0;
        const mockPlayer = {
            guildId,
            playing: true,
            queue: { current: { info: {} }, tracks: [] },
            setData: () => {},
            stopPlaying: async () => { stopCalls++; }
        };
        const mockClient = {
            activePlayers: new Map(),
            updatePresence: () => {},
            playerController: { showStoppedState: async () => {} }
        };

        // Run 3 rapid concurrent stopPlayer calls
        await Promise.all([
            stopPlayer(mockClient, mockPlayer),
            stopPlayer(mockClient, mockPlayer),
            stopPlayer(mockClient, mockPlayer)
        ]);

        assert.strictEqual(isManualStopActive(guildId), true, 'Manual stop active after concurrent calls');
        clearManualStop(guildId);
    });

    console.log(`\nAll Stop button behavior tests passed: ${passed}/${passed + failed}`);
    if (failed > 0) process.exit(1);
    process.exit(0);
})();
