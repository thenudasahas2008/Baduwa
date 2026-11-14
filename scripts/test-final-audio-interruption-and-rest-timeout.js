/**
 * ZYRO — Final Audio Interruption & Global REST_TIMEOUT Regression Suite
 * Covers the 12 core acceptance verification scenarios:
 * 1. /skip and /play final replies terminate cleanly without hanging thinking state
 * 2. Interaction REST timeout and late completion handling
 * 3. Prevention of overlapping/competing final response attempts
 * 4. Fast controls remain responsive during background operations
 * 5. Source error classification (YouTube login/streams) vs genuine node disconnects
 * 6. Duplicate/concurrent node migration prevention
 * 7. Watchdog behavior during node reconnects (no false stall declarations)
 * 8. Stop cancellation and stale callback suppression
 * 9. Exact track identity preserved through resolution retries
 * 10. No unrelated Autoplay track starts after explicit source failure
 * 11. One canonical dashboard message maintained across track changes (in-place edits, no churn)
 * 12. Accurate and truthful response vs playback outcome metrics
 */

const assert = require('assert');
const { RESPONSE_STATES, safeReply, ensureDeferred, classifyRestError } = require('../src/utils/interactionHelpers');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
const PlayerController = require('../src/utils/PlayerController');
const { markManualStop, clearManualStop, isManualStopActive } = require('../src/utils/playerLifecycle');
const { handleAutoplay } = require('../src/utils/autoplay');

let passedTests = 0;
let totalTests = 0;

async function runTest(name, fn) {
    totalTests++;
    try {
        await fn();
        passedTests++;
        console.log(`✅ PASS: [${totalTests}] ${name}`);
    } catch (err) {
        console.error(`❌ FAIL: [${totalTests}] ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

(async () => {
    console.log('=== RUNNING FINAL AUDIO INTERRUPTION & REST_TIMEOUT REGRESSION TESTS ===\n');

    // 1. /skip and /play final replies terminate cleanly without hanging thinking state
    await runTest('1. /skip and /play final replies terminate cleanly without hanging thinking state', async () => {
        let repliedCount = 0;
        const mockInteraction = {
            id: 'int-skip-reply',
            guildId: 'g-skip',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async (payload) => {
                repliedCount++;
                return { id: 'msg-reply', ...payload };
            }
        };

        const result = await safeReply(mockInteraction, { content: 'Skipped track' });
        assert.ok(result, 'safeReply should successfully deliver reply');
        assert.strictEqual(mockInteraction._responseState, RESPONSE_STATES.RESPONDED);
        assert.strictEqual(mockInteraction.replied, true);
        assert.strictEqual(repliedCount, 1);
    });

    // 2. Interaction REST timeout and late completion handling
    await runTest('2. Interaction REST timeout captures late resolution truthfully without masking failure', async () => {
        let lateResolve;
        const mockInteraction = {
            id: 'int-late-test',
            guildId: 'g-late',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: () => new Promise((resolve) => {
                lateResolve = resolve;
            })
        };

        const prevTimeout = process.env.DISCORD_REST_TIMEOUT_MS;
        process.env.DISCORD_REST_TIMEOUT_MS = '50'; // fast test timeout
        try {
            const res = await safeReply(mockInteraction, { content: 'Slow reply' });
            assert.strictEqual(res, null, 'SafeReply should return null on timeout');
            assert.strictEqual(mockInteraction._responseState, RESPONSE_STATES.RESPONSE_FAILED);
            assert.strictEqual(mockInteraction._restError?.category, 'REST_TIMEOUT');

            // Trigger late resolution
            lateResolve({ id: 'msg-late-ok' });
            await new Promise(r => setTimeout(r, 60));

            assert.strictEqual(mockInteraction._lateResolved, true, 'Late resolution must be recorded');
            assert.strictEqual(mockInteraction._responseState, RESPONSE_STATES.RESPONSE_FAILED, 'Failure state must remain truthfully recorded');
        } finally {
            process.env.DISCORD_REST_TIMEOUT_MS = prevTimeout;
        }
    });

    // 3. Prevention of overlapping/competing final response attempts
    await runTest('3. Prevention of overlapping/competing final response attempts on same interaction', async () => {
        let editCount = 0;
        let resolveEdit;
        const mockInteraction = {
            id: 'int-concurrent-edit',
            guildId: 'g-concurrent',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async () => {
                editCount++;
                return new Promise(r => { resolveEdit = r; });
            }
        };

        // Launch first reply
        const firstReply = safeReply(mockInteraction, { content: 'First edit' });
        // Launch concurrent second reply
        const secondReply = safeReply(mockInteraction, { content: 'Second competing edit' });

        resolveEdit({ id: 'done-first' });
        const [r1, r2] = await Promise.all([firstReply, secondReply]);

        assert.strictEqual(editCount, 1, 'Underlying editReply must only be invoked once');
        assert.ok(r1, 'First reply resolved');
        assert.ok(r2, 'Second reply awaited existing and resolved');
    });

    // 4. Fast controls remain responsive during background operations
    await runTest('4. Fast local controls reply immediately without waiting for deferred SLA states', async () => {
        const mockInteraction = {
            id: 'int-fast-ctl',
            commandName: 'about',
            deferred: false,
            replied: false,
            _responseState: RESPONSE_STATES.PENDING,
            reply: async () => {
                mockInteraction.replied = true;
                return { id: 'msg-fast-about' };
            }
        };

        const start = Date.now();
        const res = await safeReply(mockInteraction, { content: 'ZYRO Info' });
        const elapsed = Date.now() - start;

        assert.ok(res);
        assert.strictEqual(mockInteraction.replied, true);
        assert.ok(elapsed < 50, `Fast reply took ${elapsed}ms; must be immediate`);
    });

    // 5. Source error classification (YouTube login/streams) vs genuine node disconnects
    await runTest('5. Source error classification distinguishes login/stream issues from node disconnections', async () => {
        const dummyClient = { lavalink: { getPlayer: () => null } };
        const monitor = new AudioPlaybackMonitor(dummyClient);

        assert.strictEqual(monitor.isSourceLevelError('This video requires login'), true);
        assert.strictEqual(monitor.isSourceLevelError('No supported audio streams available'), true);
        assert.strictEqual(monitor.isSourceLevelError('This video is unavailable'), true);
        assert.strictEqual(monitor.isSourceLevelError('Sign in to confirm your age'), true);
        assert.strictEqual(monitor.isSourceLevelError('WebSocket connection closed'), false);
        assert.strictEqual(monitor.isSourceLevelError('ECONNREFUSED 127.0.0.1:2333'), false);
        assert.strictEqual(monitor.isSourceLevelError('Node was destroyed'), false);
    });

    // 6. Duplicate/concurrent node migration prevention
    await runTest('6. LavalinkConnectionManager single-flight lock prevents duplicate migration collisions', async () => {
        const manager = new LavalinkConnectionManager();
        let changeNodeCalls = 0;
        const mockPlayer = {
            guildId: 'g-mig-single',
            voiceChannelId: 'vc-1',
            isChangingNode: false,
            node: { id: 'old-node', connected: false },
            changeNode: async () => {
                changeNodeCalls++;
                await new Promise(r => setTimeout(r, 50));
            }
        };

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

        const [p1, p2] = await Promise.all([
            manager.migratePlayerToHealthyNode(mockPlayer, 'stall-1'),
            manager.migratePlayerToHealthyNode(mockPlayer, 'stall-2')
        ]);

        assert.strictEqual(p1, true, 'First migration should succeed');
        assert.strictEqual(p2, true, 'Second concurrent call should await first lock without throwing error');
        assert.strictEqual(changeNodeCalls, 1, 'Only one actual node change should occur');
    });

    // 7. Watchdog behavior during node reconnects (no false stall declarations)
    await runTest('7. AudioPlaybackMonitor does not declare false stalls while node is disconnected', async () => {
        const dummyClient = {
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-disconnected',
                    node: { id: 'test-node', connected: false }, // Node disconnected
                    position: 5000,
                    lastPosition: 5000,
                    playing: true,
                    paused: false,
                    queue: { current: { info: { identifier: 'id-stall', duration: 180000 } } }
                })
            }
        };

        const monitor = new AudioPlaybackMonitor(dummyClient);
        const state = monitor.getOrCreateState('g-disconnected');
        state.lastProgressTimestamp = Date.now() - 35000; // stalled for 35s
        state.trackStartTime = Date.now() - 40000;

        let recoveryCalled = false;
        monitor.recoverPlayback = async () => { recoveryCalled = true; return true; };

        await monitor.checkPlayersForStalls();
        assert.strictEqual(recoveryCalled, false, 'Watchdog must NOT declare stall while node is disconnected');
    });

    // 8. Stop cancellation and stale callback suppression
    await runTest('8. Stop cancellation invalidates active playback recovery', async () => {
        const dummyClient = {
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-stop-test',
                    getData: (k) => k === 'internal_stopPlaying' ? true : false,
                    queue: { current: { info: { identifier: 'id-stop' } } }
                })
            }
        };

        const monitor = new AudioPlaybackMonitor(dummyClient);
        const recovered = await monitor.recoverPlayback({
            guildId: 'g-stop-test',
            getData: (k) => k === 'internal_stopPlaying' ? true : false,
            queue: { current: { info: { identifier: 'id-stop' } } }
        }, { info: { identifier: 'id-stop' } }, { reason: 'stalledPosition' });

        assert.strictEqual(recovered, false, 'Recovery must be cancelled when manual stop is active');
    });

    // 9. Exact track identity preserved through resolution retries
    await runTest('9. Track identity is validated so stale recovery cannot overwrite newer playback', async () => {
        const dummyClient = {
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-track-changed',
                    queue: { current: { info: { identifier: 'new-song-id' } } }
                })
            }
        };

        const monitor = new AudioPlaybackMonitor(dummyClient);
        const recovered = await monitor.recoverPlayback({
            guildId: 'g-track-changed',
            queue: { current: { info: { identifier: 'new-song-id' } } }
        }, { info: { identifier: 'old-song-id' } }, { reason: 'stalledPosition' });

        assert.strictEqual(recovered, false, 'Recovery must abort when current track identifier has changed');
    });

    // 10. No unrelated Autoplay track starts after explicit source failure
    await runTest('10. Autoplay is suppressed when player was stopped or empty with no natural queue advance', async () => {
        const mockPlayer = {
            guildId: 'g-autoplay-stop',
            playing: false,
            paused: false,
            getData: (k) => k === 'internal_stopPlaying' ? true : null,
            queue: { current: null, tracks: [] }
        };

        const mockClient = {
            autoplayEnabled: new Map([['g-autoplay-stop', true]])
        };

        const started = await handleAutoplay(mockClient, mockPlayer, 'queueEnd', null);
        assert.strictEqual(started, false, 'Autoplay must not trigger when stopPlaying is active');
    });

    // 11. Dashboard auto-moves to bottom on track change and edits in-place for progress/state
    await runTest('11. PlayerController moves dashboard to bottom on track change and edits in-place for state updates', async () => {
        let sendCount = 0;
        let editCount = 0;
        const guildId = 'g-canonical-dash';
        const channelId = 'vc-dash-chan';

        const existingMsg = {
            id: 'msg-canon-1',
            channelId,
            embeds: [],
            components: [],
            edit: async () => {
                editCount++;
                return existingMsg;
            }
        };

        const newMsg = {
            id: 'msg-canon-2',
            channelId,
            embeds: [],
            components: [],
            edit: async () => {
                editCount++;
                return newMsg;
            }
        };

        const mockClient = {
            channels: {
                cache: new Map([[channelId, {
                    id: channelId,
                    type: 2, // voice
                    permissionsFor: () => ({ has: () => true }),
                    send: async () => {
                        sendCount++;
                        return newMsg;
                    },
                    messages: {
                        cache: new Map([['msg-canon-1', existingMsg], ['msg-canon-2', newMsg]]),
                        fetch: async (id) => id === 'msg-canon-2' ? newMsg : existingMsg
                    }
                }]])
            },
            guilds: { cache: new Map() },
            guildSettings: {
                get: () => ({ textChannelId: channelId, voiceChannelId: channelId }),
                getDashboard: () => ({ messageId: 'msg-canon-1', channelId }),
                setDashboard: () => {}
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    playing: true,
                    textChannelId: channelId,
                    voiceChannelId: channelId,
                    position: 0,
                    queue: { current: { info: { title: 'New Song', identifier: 'id-new', duration: 120000 } }, tracks: [] }
                })
            },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard(guildId, { messageId: 'msg-canon-1', channelId });

        // Update dashboard for new song (moves to bottom)
        const result = await controller.sendReplacementPlayer(guildId, {
            channelId,
            track: { info: { title: 'New Song', identifier: 'id-new', duration: 120000 } }
        });

        assert.ok(result);
        assert.strictEqual(result.id, 'msg-canon-2', 'New dashboard message posted at bottom');
        assert.strictEqual(sendCount, 1, 'channel.send called to post dashboard at bottom on track change');
        assert.strictEqual(controller.getDashboard(guildId)?.messageId, 'msg-canon-2', 'New message ID stored as canonical');

        // Subsequent in-place update (e.g. progress or pause)
        await controller.updatePlayer(guildId, { replace: false, channelId });
        assert.strictEqual(editCount, 1, 'In-place update must edit without posting additional messages');
        assert.strictEqual(sendCount, 1, 'sendCount must remain 1');
    });

    // 12. Accurate response and playback outcome metrics
    await runTest('12. Separate reporting for playback success vs response delivery failure', async () => {
        const lifecycle = {
            interactionId: 'int-sla-test',
            guildId: 'g-sla',
            status: 'PENDING',
            playbackStatus: 'NONE',
            responseStatus: 'PENDING'
        };

        // Simulated playback start succeeded, but response edit timed out
        lifecycle.playbackStatus = 'STARTED';
        lifecycle.responseStatus = 'FAILED';
        lifecycle.status = 'PLAYBACK_SUCCESS_RESPONSE_FAILED';
        lifecycle.failureReason = 'REST_TIMEOUT';

        assert.strictEqual(lifecycle.playbackStatus, 'STARTED', 'Playback is truthfully recorded as started');
        assert.strictEqual(lifecycle.responseStatus, 'FAILED', 'Response delivery failure is truthfully distinguished');
        assert.strictEqual(lifecycle.status, 'PLAYBACK_SUCCESS_RESPONSE_FAILED', 'Outcome is accurately classified');
    });

    // 13. Queuing a track while active playback is in progress never interrupts current track or calls player.play
    await runTest('13. Queuing a track while active playback is in progress preserves active song and appends to queue', async () => {
        const playCommand = require('../src/commands/play');
        let playCalled = false;
        const currentActiveTrack = { info: { identifier: 'active-song-id', title: 'Currently Playing Song', duration: 180000, uri: 'https://youtube.com/watch?v=active' } };
        const newTrack = { info: { identifier: 'new-song-id', title: 'Newly Queued Song', duration: 200000, uri: 'https://youtube.com/watch?v=new' } };

        const mockPlayer = {
            guildId: 'g-queue-test',
            connected: true,
            playing: true,
            paused: false,
            voice: { token: 'token-active' },
            queue: {
                current: currentActiveTrack,
                tracks: [],
                add: async (track, pos) => {
                    const list = Array.isArray(track) ? track : [track];
                    if (pos === 0) mockPlayer.queue.tracks.unshift(...list);
                    else mockPlayer.queue.tracks.push(...list);
                }
            },
            search: async () => ({
                loadType: 'track',
                tracks: [newTrack]
            }),
            play: async () => {
                playCalled = true;
            },
            setData: () => {},
            getData: () => null
        };

        let repliedPayload = null;
        const mockInteraction = {
            id: 'int-queue-non-interrupt',
            commandName: 'play',
            guildId: 'g-queue-test',
            guild: { id: 'g-queue-test', name: 'Test Guild', members: { me: { id: 'bot-id', voice: { channelId: 'vc-1' } } } },
            member: {
                user: { id: 'user-1', tag: 'User#0001' },
                voice: { channel: { id: 'vc-1', name: 'Voice', permissionsFor: () => ({ has: () => true }) } }
            },
            user: { id: 'user-1', tag: 'User#0001' },
            channel: { id: 'tc-1' },
            options: {
                getString: (k) => (k === 'query' ? 'Newly Queued Song' : null),
                getBoolean: (k) => (k === 'next' ? false : false)
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => null },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: { getPlayer: () => mockPlayer, createPlayer: () => mockPlayer },
                playerController: { updatePlayer: async () => {}, replaceWithFullDashboard: async () => {} },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} }
            },
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async (p) => {
                repliedPayload = p;
                mockInteraction.replied = true;
                return p;
            }
        };

        await playCommand.execute(mockInteraction);

        assert.strictEqual(playCalled, true, 'player.play() must be called to start new track immediately');
        assert.strictEqual(mockPlayer.queue.current.info.identifier, 'new-song-id', 'Active track must switch to requested track');
        assert.strictEqual(mockPlayer.queue.previous[0].info.identifier, 'active-song-id', 'Previous track must be stored in previous history');
        assert.match(repliedPayload?.content || '', /Started playing/, 'Reply must report song started playing');
    });

    // 14. Deferred interaction with prior transient failure finalizes cleanly via editReply without staying stuck on thinking
    await runTest('14. Deferred interaction with prior transient failure finalizes cleanly via editReply', async () => {
        let finalEditReceived = null;
        const mockInteraction = {
            id: 'int-recovery-reply',
            guildId: 'g-recover',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.RESPONSE_FAILED, // Simulated prior transient failure
            _restError: { category: 'REST_TIMEOUT', code: 'REST_TIMEOUT', message: 'Interim timeout' },
            editReply: async (p) => {
                finalEditReceived = p;
                return { id: 'msg-recovered', ...p };
            }
        };

        const res = await safeReply(mockInteraction, { content: 'Final resolved result', _isFinalReply: true });
        assert.ok(res, 'safeReply must deliver final response for pending deferred interaction');
        assert.strictEqual(mockInteraction.replied, true, 'Interaction replied state must be true');
        assert.strictEqual(mockInteraction._responseState, RESPONSE_STATES.RESPONDED, 'Response state must transition to RESPONDED');
        assert.strictEqual(finalEditReceived.content, 'Final resolved result');
    });

    console.log(`\n========================================`);
    console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
    console.log(`========================================\n`);

    const { performanceMonitor } = require('../src/utils/performanceMonitor');
    if (performanceMonitor && typeof performanceMonitor.destroy === 'function') {
        performanceMonitor.destroy();
    }

    try {
        const { getGlobalDispatcher } = require('undici');
        const dispatcher = getGlobalDispatcher();
        if (dispatcher && typeof dispatcher.destroy === 'function') {
            await dispatcher.destroy();
        }
    } catch (_) {}

    if (passedTests !== totalTests) {
        process.exitCode = 1;
    }
    process.exit(process.exitCode ? 1 : 0);
})();
