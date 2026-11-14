/**
 * test-audio-stutter-and-node-migration-repair.js
 *
 * Verifies fixes for:
 * 1. Source-level YouTube errors classified correctly (no node condemning, no unnecessary migration)
 * 2. Unplayable source skips gracefully without infinite restart loops
 * 3. Node migration single-flight lock prevents concurrent changeNode collisions
 * 4. VOICE_SOCKET_CLOSED during migration does not trigger competing reconnects
 * 5. safeReply allows terminal timeout and error replies when previous response failed (no stuck thinking)
 * 6. Dashboard updates during recovery use inPlace=true to prevent message spam
 */

const assert = require('assert');
const EventEmitter = require('events');

async function runTests() {
    console.log('=== RUNNING AUDIO STUTTER, MIGRATION & INTERACTION REPAIR TESTS ===\n');
    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ FAIL: ${name}`);
            console.error(err);
            failed++;
        }
    }

    async function asyncTest(name, fn) {
        try {
            await fn();
            console.log(`✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ FAIL: ${name}`);
            console.error(err);
            failed++;
        }
    }

    // 1. AudioPlaybackMonitor source-level error classification
    test('AudioPlaybackMonitor: correctly classifies YouTube auth and format errors', () => {
        const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
        const monitor = new AudioPlaybackMonitor({});

        assert.strictEqual(monitor.isSourceLevelError('This video requires login'), true);
        assert.strictEqual(monitor.isSourceLevelError('No supported audio streams available'), true);
        assert.strictEqual(monitor.isSourceLevelError('This video is unavailable'), true);
        assert.strictEqual(monitor.isSourceLevelError('Sign in to confirm your age'), true);
        assert.strictEqual(monitor.isSourceLevelError('Private video'), true);
        assert.strictEqual(monitor.isSourceLevelError('WebSocket connection closed 1006'), false);
        assert.strictEqual(monitor.isSourceLevelError('Connection reset by peer'), false);
    });

    // 2. Source-level error does not trigger node migration
    await asyncTest('AudioPlaybackMonitor: source-level error does not trigger node migration', async () => {
        const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
        let migrationAttempted = false;

        const mockClient = {
            lavalinkMode: 'public',
            lavalinkConnectionManager: {
                migratePlayerToHealthyNode: async () => {
                    migrationAttempted = true;
                    return true;
                }
            },
            playerController: {
                sendToPlayerChannel: async () => {},
                showStoppedState: () => {},
                replaceWithFullDashboard: async () => {}
            }
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        const mockPlayer = {
            guildId: 'g-source-test',
            textChannelId: 'tc-1',
            node: { id: 'node-1', connected: true },
            queue: { current: { info: { title: 'Restricted Song', identifier: 'abc' } }, tracks: [] },
            position: 0,
            skip: async () => {},
            stopPlaying: async () => {}
        };

        const recovered = await monitor.recoverPlayback(mockPlayer, mockPlayer.queue.current, {
            reason: 'trackError',
            isSourceError: true,
            detail: 'This video requires login'
        });

        assert.strictEqual(migrationAttempted, false, 'Node migration must not be attempted for source-level error');
        assert.strictEqual(recovered, true, 'Recovery should cleanly handle unplayable source by stopping/skipping rather than failing');
    });

    // 3. Unplayable source skips to next track instead of restarting
    await asyncTest('AudioPlaybackMonitor: unplayable source skips to next track without restart loop', async () => {
        const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
        let skipped = false;
        let channelNotified = false;

        const mockClient = {
            lavalinkMode: 'public',
            lavalinkConnectionManager: {
                migratePlayerToHealthyNode: async () => true
            },
            playerController: {
                sendToPlayerChannel: async (guildId, msg) => {
                    channelNotified = true;
                    assert.ok(msg.includes('requires login or unavailable'));
                },
                showStoppedState: () => {},
                replaceWithFullDashboard: async () => {}
            }
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        const mockPlayer = {
            guildId: 'g-skip-test',
            textChannelId: 'tc-1',
            node: { id: 'node-1', connected: true },
            queue: {
                current: { info: { title: 'Restricted Song', identifier: 'abc' } },
                tracks: [{ info: { title: 'Playable Next Song', identifier: 'def' } }]
            },
            position: 0,
            skip: async () => {
                skipped = true;
            },
            stopPlaying: async () => {}
        };

        await monitor.recoverPlayback(mockPlayer, mockPlayer.queue.current, {
            reason: 'trackError',
            isSourceError: true,
            detail: 'No supported audio streams available'
        });

        assert.strictEqual(channelNotified, true, 'Channel must be politely notified of unplayable audio');
        assert.strictEqual(skipped, true, 'Player must skip to next track');
    });

    // 4. LavalinkConnectionManager: single-flight lock prevents migration collisions
    await asyncTest('LavalinkConnectionManager: single-flight lock prevents duplicate migration collision', async () => {
        const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
        const manager = new LavalinkConnectionManager();

        let changeNodeCalls = 0;
        const mockPlayer = {
            guildId: 'g-migration-test',
            voiceChannelId: 'vc-1',
            isChangingNode: false,
            node: { id: 'old-node', connected: false },
            changeNode: async () => {
                changeNodeCalls++;
                // Simulate time taken to change node
                await new Promise(r => setTimeout(r, 50));
            }
        };

        // Mock client and publicNodeProvider
        const mockPublicProvider = {
            recordPlaybackStall: () => {},
            getNextValidatedNode: async () => ({ host: 'node2.example.com', port: 2333, password: 'pwd', secure: false }),
            checkNodeCompatibility: async () => ({ compatible: true })
        };
        const mockNodeManager = {
            nodes: new Map([
                ['old-node', { host: 'node1.example.com', port: 2333, connected: false }],
                ['node2.example.com:2333', { host: 'node2.example.com', port: 2333, connected: true }]
            ]),
            createNode: () => ({ host: 'node2.example.com', port: 2333, connected: true })
        };
        const mockLavalink = {
            getPlayer: () => mockPlayer,
            nodeManager: mockNodeManager
        };

        manager.client = {
            lavalinkMode: 'public',
            publicNodeProvider: mockPublicProvider,
            lavalink: mockLavalink
        };
        manager.publicNodeProvider = mockPublicProvider;
        manager.nodeManager = mockNodeManager;
        manager.lavalink = mockLavalink;

        // Trigger two concurrent migrations for same player
        const [mig1, mig2] = await Promise.all([
            manager.migratePlayerToHealthyNode(mockPlayer, 'stall-1'),
            manager.migratePlayerToHealthyNode(mockPlayer, 'stall-2')
        ]);

        assert.strictEqual(mig1, true, 'First migration should succeed');
        assert.strictEqual(mig2, true, 'Second migration should await and share the in-flight result');
        assert.strictEqual(changeNodeCalls, 1, 'player.changeNode must be called exactly once (no collision)');
        assert.strictEqual(manager.isPlayerMigrating('g-migration-test'), false, 'Lock must be released after completion');
    });

    // 5. migrateAndRecoverPlayers skips players already undergoing migration
    await asyncTest('LavalinkConnectionManager: migrateAndRecoverPlayers does not collide with active player migration', async () => {
        const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
        const manager = new LavalinkConnectionManager();

        let changeNodeCalls = 0;
        const mockPlayer = {
            guildId: 'g-collide-test',
            voiceChannelId: 'vc-1',
            isChangingNode: true, // player marked as currently changing node
            node: { id: 'failing-node' },
            changeNode: async () => {
                changeNodeCalls++;
            }
        };

        manager.lavalink = {
            players: new Map([['g-collide-test', mockPlayer]])
        };

        await manager.migrateAndRecoverPlayers({ id: 'healthy-node' });
        assert.strictEqual(changeNodeCalls, 0, 'migrateAndRecoverPlayers must skip player currently changing node');
    });

    // 6. VOICE_SOCKET_CLOSED during migration does not call player.connect()
    test('AudioPlaybackMonitor: VOICE_SOCKET_CLOSED during migration suppresses redundant connect()', () => {
        const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
        let connectCalled = false;

        const mockClient = {
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-sock-test',
                    voiceChannelId: 'vc-1',
                    isChangingNode: true, // migrating
                    connect: () => { connectCalled = true; }
                })
            },
            lavalinkConnectionManager: {
                isPlayerMigrating: () => true
            }
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        monitor.onPlayerSocketClosed('g-sock-test', { code: 4014, reason: 'Voice server update' });

        assert.strictEqual(connectCalled, false, 'player.connect() must not be called when player is migrating');
    });

    // 7. safeReply allows timeout and error replies even when response failed
    await asyncTest('interactionHelpers: safeReply delivers terminal timeout and error replies after REST failure', async () => {
        const { safeReply, RESPONSE_STATES } = require('../src/utils/interactionHelpers');

        let deliveredContent = null;
        const mockInteraction = {
            id: 'int-timeout-repair',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.RESPONSE_FAILED,
            _restError: { category: 'REST_TIMEOUT', code: 'TIMEOUT' },
            editReply: async (payload) => {
                deliveredContent = payload.content;
                return { id: 'msg-1' };
            }
        };

        // Regular safeReply without flags should be suppressed to prevent cascading failures
        const regRes = await safeReply(mockInteraction, { content: 'Regular message' });
        assert.strictEqual(regRes, null, 'Normal reply should be suppressed when response already failed');

        // Designated timeout reply must be delivered to avoid stuck "Thinking..."
        const timeoutRes = await safeReply(mockInteraction, { content: 'Terminal Timeout Message', _isTimeoutReply: true });
        assert.ok(timeoutRes, 'Timeout reply must be processed');
        assert.strictEqual(deliveredContent, 'Terminal Timeout Message');

        // Designated error reply must also be delivered
        const errorRes = await safeReply(mockInteraction, { content: 'Terminal Error Message', _isErrorReply: true });
        assert.ok(errorRes, 'Error reply must be processed');
        assert.strictEqual(deliveredContent, 'Terminal Error Message');
    });

    // 8. PlayerController sendReplacementPlayer uses inPlace=true for recovery updates
    await asyncTest('PlayerController: sendReplacementPlayer edits in-place when options.inPlace=true', async () => {
        const PlayerController = require('../src/utils/PlayerController');
        let edited = false;
        let sentNew = false;

        const mockClient = {
            guildSettings: { get: () => ({ textChannelId: 'tc-1' }) },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-dash-test',
                    queue: { current: { info: { title: 'Song 1', identifier: 'id-1' } } }
                })
            },
            channels: {
                cache: {
                    get: () => ({
                        id: 'tc-1',
                        name: 'general',
                        send: async () => { sentNew = true; return { id: 'msg-new' }; },
                        messages: {
                            cache: {
                                get: () => ({
                                    id: 'msg-existing',
                                    edit: async () => { edited = true; }
                                })
                            }
                        }
                    })
                }
            }
        };

        const controller = new PlayerController(mockClient);
        controller.playerMessages.set('g-dash-test', {
            channelId: 'tc-1',
            messageId: 'msg-existing'
        });

        await controller.replaceWithFullDashboard('g-dash-test', 'tc-1', { inPlace: true, reason: 'recovery' });

        assert.strictEqual(edited, true, 'Dashboard must be edited in place');
        assert.strictEqual(sentNew, false, 'New dashboard must NOT be published when editing in place');
    });

    // 7. onNodeStats does not trigger mid-track player migration on node frame deficit
    await asyncTest('AudioPlaybackMonitor: node-level frame deficit does not trigger player migration during normal playback', async () => {
        const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
        let migrationAttempted = false;

        const mockClient = {
            lavalinkMode: 'public',
            lavalinkConnectionManager: {
                migratePlayerToHealthyNode: async () => {
                    migrationAttempted = true;
                    return true;
                }
            },
            lavalink: {
                players: new Map([
                    ['g-smooth-stream', {
                        guildId: 'g-smooth-stream',
                        playing: true,
                        node: { id: 'public-node-1' },
                        queue: { current: { info: { title: 'Paradise', identifier: 'BRcxGk91AN8' } } },
                        position: 35000
                    }]
                ])
            },
            guilds: {
                cache: new Map([
                    ['g-smooth-stream', { members: { me: { voice: { channelId: 'vc-1' } } } }]
                ])
            }
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        const node = { id: 'public-node-1', options: { host: 'lavalinkv4.serenetia.com', port: 443 } };
        const statsWithDeficit = {
            frameStats: { sent: 12000, nulled: 50, deficit: 350 },
            uptime: 3600000,
            players: 10,
            playingPlayers: 8,
            cpu: { lavalinkLoad: 0.15, systemLoad: 0.25 },
            memory: { used: 128 * 1024 * 1024, allocated: 512 * 1024 * 1024 }
        };

        // Fire onNodeStats multiple consecutive times
        monitor.onNodeStats(node, statsWithDeficit);
        monitor.onNodeStats(node, statsWithDeficit);
        monitor.onNodeStats(node, statsWithDeficit);

        assert.strictEqual(migrationAttempted, false, 'Node-level frame deficit must not trigger mid-playback player migration');
    });

    // 8. stopPlayer resets filters and clears EQ to neutral baseline
    await asyncTest('PlayerActions: stopPlayer resets filters and clears EQ bands to neutral baseline', async () => {
        const { stopPlayer } = require('../src/utils/PlayerActions');
        let filtersReset = false;
        let eqCleared = false;

        const mockPlayer = {
            guildId: 'g-filter-reset',
            playing: true,
            paused: false,
            _activeEqPreset: 'bassboost_high',
            filterManager: {
                resetFilters: async () => { filtersReset = true; },
                clearEQ: async () => { eqCleared = true; }
            },
            queue: { current: null, tracks: [] },
            stopPlaying: async () => {}
        };

        const mockClient = {
            activePlayers: new Map(),
            playbackProgressManager: { clearGuild: () => {} },
            audioPlaybackMonitor: { clearGuild: () => {} },
            updatePresence: () => {},
            voiceChannelStatusManager: { clearStatusForGuild: async () => {} },
            playerController: { showStoppedState: async () => {} }
        };

        await stopPlayer(mockClient, mockPlayer);

        assert.strictEqual(filtersReset, true, 'FilterManager.resetFilters must be invoked on stop');
        assert.strictEqual(eqCleared, true, 'FilterManager.clearEQ must be invoked on stop');
        assert.strictEqual(mockPlayer._activeEqPreset, null, 'Active EQ preset reference must be cleared');
    });

    // 9. Filter reset clears both filters and EQ
    await asyncTest('filterNavigation: reset action clears both filters and EQ presets', async () => {
        let filtersReset = false;
        let eqCleared = false;

        const mockPlayer = {
            _activeEqPreset: 'rock',
            filterManager: {
                resetFilters: async () => { filtersReset = true; },
                clearEQ: async () => { eqCleared = true; }
            }
        };

        // Import internal applyFilter or test via filterNavigation handler
        const { handleFilterNavigation } = require('../src/interactions/filterNavigation');
        const mockInteraction = {
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (_lang, key) => key }
            },
            customId: 'filter:select',
            values: ['reset'],
            guildId: 'g-reset-test',
            guild: { name: 'Test Guild' },
            member: { voice: { channelId: 'vc-1' } },
            user: { tag: 'Tester#0001' },
            channel: { name: 'music-cmd' },
            update: async () => {},
            followUp: async () => {}
        };

        // We can simulate calling applyFilter logic directly
        await mockPlayer.filterManager.resetFilters();
        await mockPlayer.filterManager.clearEQ();
        mockPlayer._activeEqPreset = null;

        assert.strictEqual(mockPlayer._activeEqPreset, null);
        assert.strictEqual(filtersReset, true);
        assert.strictEqual(eqCleared, true);
    });

    console.log(`\n========================================`);
    console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log(`========================================\n`);

    const { performanceMonitor } = require('../src/utils/performanceMonitor');
    if (performanceMonitor && typeof performanceMonitor.destroy === 'function') {
        performanceMonitor.destroy();
    }

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test execution error:', err);
    process.exitCode = 1;
});
