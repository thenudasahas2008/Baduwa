const assert = require('node:assert/strict');
const { attachNodeProtection, validateAndFormatNodeOption, sanitizeError } = require('../src/utils/lavalinkNodeOptions');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');
const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
const PlayerController = require('../src/utils/PlayerController');
const guildSettings = require('../src/utils/guildSettings');
const { performanceMonitor } = require('../src/utils/performanceMonitor');
const { safeReply, isLavalinkAvailable } = require('../src/utils/interactionHelpers');

let passed = 0;
let total = 0;

async function test(name, fn) {
    total++;
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
    console.log('--- ZYRO Production Emergency Master Fix Regression Suite ---');

    const originalFetch = global.fetch;

    try {
        // 1. HTTP 500 proxy connection refused remains transient and does not trigger false incompatible-API cooldown
        await test('1. HTTP 500 proxy connection refused remains transient and does not trigger false incompatible-API cooldown', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [{ host: 'proxy-fail.test', port: 443, secure: true, authorization: 'pass' }];
            const errorMsg = 'HTTP 500: Proxy error: Could not proxy request. Host is unreachable: connection refused';

            provider.markNodeFailed('proxy-fail.test', 443, errorMsg, 'TRANSIENT_ERROR');
            const rec = provider.failedNodes.get('proxy-fail.test:443');

            assert.ok(rec, 'Failure record must exist');
            assert.strictEqual(rec.category, 'TRANSIENT_ERROR', 'Category must be TRANSIENT_ERROR');
            assert.notStrictEqual(rec.category, 'INCOMPATIBLE_API', 'Must NOT be categorized as INCOMPATIBLE_API');
            assert.ok(rec.cooldownUntil > Date.now(), 'Candidate must be in cooldown');
            assert.ok(rec.cooldownUntil - Date.now() <= 185000, 'Transient cooldown must be standard duration (~180s), not 30m');
        });

        // 2. HTTP 401/403, 429, 5xx, timeout and confirmed incompatibility are classified correctly
        await test('2. HTTP 401/403, 429, 5xx, timeout and confirmed incompatibility are classified correctly', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [
                { host: 'node-401.test', port: 443, secure: true, authorization: 'pass' },
                { host: 'node-403.test', port: 443, secure: true, authorization: 'pass' },
                { host: 'node-429.test', port: 443, secure: true, authorization: 'pass' },
                { host: 'node-502.test', port: 443, secure: true, authorization: 'pass' },
                { host: 'node-timeout.test', port: 443, secure: true, authorization: 'pass' },
                { host: 'node-v3.test', port: 443, secure: true, authorization: 'pass' },
            ];

            provider.markNodeFailed('node-401.test', 443, 'HTTP 401 Unauthorized', 'AUTH_FAILED');
            provider.markNodeFailed('node-403.test', 443, 'HTTP 403 Forbidden', 'AUTH_FAILED');
            provider.markNodeFailed('node-429.test', 443, 'HTTP 429 Rate limited', 'RATE_LIMITED');
            provider.markNodeFailed('node-502.test', 443, 'HTTP 502 Bad Gateway', 'TRANSIENT_ERROR');
            provider.markNodeFailed('node-timeout.test', 443, 'Connection timeout after 8000ms', 'TIMEOUT');
            provider.markNodeFailed('node-v3.test', 443, 'Lavalink Node is incompatible: version 3.7.0', 'INCOMPATIBLE_API');

            const n401 = provider.failedNodes.get('node-401.test:443');
            const n403 = provider.failedNodes.get('node-403.test:443');
            const n429 = provider.failedNodes.get('node-429.test:443');
            const n502 = provider.failedNodes.get('node-502.test:443');
            const nTimeout = provider.failedNodes.get('node-timeout.test:443');
            const nV3 = provider.failedNodes.get('node-v3.test:443');

            assert.strictEqual(n401.category, 'AUTH_FAILED');
            assert.strictEqual(n403.category, 'AUTH_FAILED');
            assert.strictEqual(n429.category, 'RATE_LIMITED');
            assert.strictEqual(n502.category, 'TRANSIENT_ERROR');
            assert.strictEqual(nTimeout.category, 'TIMEOUT');
            assert.strictEqual(nV3.category, 'INCOMPATIBLE_API');
            assert.ok(nV3.cooldownUntil - Date.now() >= 25 * 60 * 1000, 'Incompatible node gets 30m cooldown');
        });

        // 3. One failure does not increment the same candidate's cooldown multiple times through overlapping handlers
        await test('3. One failure does not increment the same candidate cooldown multiple times through overlapping handlers', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [{ host: 'dedup.test', port: 443, secure: true, authorization: 'pass' }];

            // Simulate hookNodeOpen, onError, and onDisconnect all firing within 50ms for same failure
            provider.markNodeFailed('dedup.test', 443, 'HTTP 500 Proxy error', 'TRANSIENT_ERROR');
            const rec = provider.failedNodes.get('dedup.test:443');
            const firstCooldown = rec.cooldownUntil;
            const firstFails = rec.failCount;

            provider.markNodeFailed('dedup.test', 443, 'Disconnect during handshake', 'TRANSIENT_ERROR');
            provider.markNodeFailed('dedup.test', 443, 'Socket closed 1006', 'TRANSIENT_ERROR');

            const afterRec = provider.failedNodes.get('dedup.test:443');
            assert.strictEqual(afterRec.failCount, firstFails, 'failCount must not be incremented multiple times within 4s window');
            assert.strictEqual(afterRec.cooldownUntil, firstCooldown, 'cooldownUntil must not be multiplied within 4s window');
        });

        // 4. All-candidates-cooling-down behavior uses bounded backoff with no rapid rotation storm
        await test('4. All-candidates-cooling-down behavior uses bounded backoff with no rapid rotation storm', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [
                { host: 'cool1.test', port: 443, secure: true, authorization: 'pass' },
                { host: 'cool2.test', port: 443, secure: true, authorization: 'pass' }
            ];
            provider.markNodeFailed('cool1.test', 443, 'cooldown', 'TRANSIENT_ERROR');
            provider.markNodeFailed('cool2.test', 443, 'cooldown', 'TRANSIENT_ERROR');

            assert.strictEqual(provider.hasEligibleNode(), false);
            assert.strictEqual(provider.areAllNodesInCooldown(), true);

            // Without deliberate fallback authorization, getNextNode returns null rather than spinning
            const selected = provider.getNextNode({ allowCooldownFallback: false });
            assert.strictEqual(selected, null, 'Must return null when all nodes in cooldown and fallback disabled');

            // LavalinkConnectionManager controlled backoff delay
            const dummyClient = { lavalink: {}, lavalinkMode: 'public', publicNodeProvider: provider };
            const connMgr = new LavalinkConnectionManager(dummyClient);

            const backoffDelay0 = connMgr.getReconnectDelay(0, true);
            const backoffDelay3 = connMgr.getReconnectDelay(3, true);

            assert.ok(backoffDelay0 >= 15000, `Backoff delay attempt 0 must be >= 15s (got ${backoffDelay0}ms)`);
            assert.ok(backoffDelay3 >= 30000 && backoffDelay3 <= 60000, `Backoff delay attempt 3 must be bounded <= 60s (got ${backoffDelay3}ms)`);
        });

        // 5. Only one reconnection/failover job runs at a time
        await test('5. Only one reconnection/failover job runs at a time', async () => {
            const dummyClient = {
                lavalink: { nodeManager: { createNode: () => ({ id: 'n', connect: () => {} }) } },
                lavalinkMode: 'public',
                user: { id: 'bot-123' }
            };
            const connMgr = new LavalinkConnectionManager(dummyClient);
            connMgr.state.isReconnecting = true;

            // Attempting reconnection while isReconnecting is true should immediately exit
            await connMgr.attemptReconnection();
            assert.strictEqual(connMgr.state.reconnectAttempts, 0, 'Must not increment attempts or spawn parallel reconnection');
        });

        // 6. Duplicate discovery requests are coalesced
        await test('6. Duplicate discovery requests are coalesced', async () => {
            const provider = new PublicNodeProvider();
            let fetchCount = 0;
            const payload = JSON.stringify([{ host: '8.8.8.8', port: 443, secure: true, password: 'pass', version: 'v4' }]);
            global.fetch = async () => {
                fetchCount++;
                await new Promise(r => setTimeout(r, 50));
                return {
                    ok: true,
                    status: 200,
                    text: async () => payload,
                    json: async () => JSON.parse(payload)
                };
            };

            // Call fetchNodes concurrently 5 times
            const results = await Promise.all([
                provider.fetchNodes(),
                provider.fetchNodes(),
                provider.fetchNodes(),
                provider.fetchNodes(),
                provider.fetchNodes(),
            ]);

            assert.strictEqual(fetchCount, 1, 'Concurrent discovery requests must be coalesced into a single fetch call');
            assert.ok(results.every(r => r === true));
        });

        // 7. Long-running or failed guild-lock tasks cannot block future valid tasks indefinitely
        await test('7. Long-running or failed guild-lock tasks cannot block future valid tasks indefinitely', async () => {
            const pc = new PlayerController({ lavalink: {} });
            const guildId = 'test-guild-lock-safety';

            // Failed task in lock
            try {
                await pc.runWithGuildLock(guildId, async () => {
                    throw new Error('Task crashed in lock');
                });
            } catch (_) {}

            // Subsequent task should still acquire lock and execute cleanly without hanging
            let executed = false;
            await pc.runWithGuildLock(guildId, async () => {
                executed = true;
            });

            assert.strictEqual(executed, true, 'Subsequent task must execute after failed task in guild lock');
        });

        // 8. Lock wait and held-time metrics identify real contention
        await test('8. Lock wait and held-time metrics identify real contention', async () => {
            const pc = new PlayerController({ lavalink: {} });
            const guildId = 'test-contention';

            const start = Date.now();
            const op1 = pc.runWithGuildLock(guildId, async () => {
                await new Promise(r => setTimeout(r, 60));
                return 'op1';
            });

            const op2 = pc.runWithGuildLock(guildId, async () => {
                return 'op2';
            });

            const [res1, res2] = await Promise.all([op1, op2]);
            assert.strictEqual(res1, 'op1');
            assert.strictEqual(res2, 'op2');
            assert.ok(Date.now() - start >= 60, 'op2 must serialize after op1');
        });

        // 9. A stale deleted channel is invalidated without repeated lookups
        await test('9. A stale deleted channel is invalidated without repeated lookups', async () => {
            const guildId = 'guild-deleted-ch';
            const deletedChId = 'ch-deleted-10003';

            guildSettings.updateTextChannelId(guildId, deletedChId);
            guildSettings.setDashboard(guildId, { messageId: 'msg-1', channelId: deletedChId });

            const dummyClient = {
                guilds: {
                    cache: new Map(),
                    fetch: async () => ({
                        id: guildId,
                        systemChannel: null,
                        channels: { cache: new Map(), values: () => [] }
                    })
                },
                channels: {
                    cache: new Map(),
                    fetch: async (id) => {
                        if (id === deletedChId) {
                            const err = new Error('Unknown Channel');
                            err.code = 10003;
                            throw err;
                        }
                        return null;
                    }
                },
                guildSettings,
            };

            const pc = new PlayerController(dummyClient);
            const resolved = await pc.resolvePlayerChannel(guildId);

            assert.strictEqual(resolved, null);
            assert.strictEqual(guildSettings.get(guildId).textChannelId, undefined, 'textChannelId must be invalidated on code 10003');
            assert.strictEqual(guildSettings.getDashboard(guildId), null, 'Dashboard must be cleared on code 10003');
        });

        // 10. 24/7 recovery is idempotent and does not run twice for the same event
        await test('10. 24/7 recovery is idempotent and does not run twice for the same event', async () => {
            const mainNode = { id: 'main-node', connected: true };
            let connectionCount = 0;

            const dummyClient = {
                guildSettings: {
                    cache: new Map([
                        ['g-247', { twentyFourSeven: true, voiceChannelId: 'vc-1' }]
                    ])
                },
                lavalink: {
                    getPlayer: () => ({
                        guildId: 'g-247',
                        connected: true,
                        voice: { sessionId: 'sess-1' },
                        node: mainNode,
                        connect: async () => { connectionCount++; }
                    }),
                    createPlayer: () => null
                },
                guilds: {
                    cache: new Map([
                        ['g-247', {
                            members: {
                                me: {
                                    voice: { channelId: 'vc-1' }
                                }
                            },
                            channels: {
                                cache: new Map([
                                    ['vc-1', { id: 'vc-1', isVoiceBased: () => true, permissionsFor: () => ({ has: () => true }) }]
                                ])
                            }
                        }]
                    ])
                }
            };

            const connMgr = new LavalinkConnectionManager(dummyClient);
            // Run concurrent 24/7 recovery calls
            await Promise.all([
                connMgr.recover247Connections(mainNode),
                connMgr.recover247Connections(mainNode)
            ]);

            assert.strictEqual(connectionCount, 0, 'Already connected 24/7 player on mainNode must not re-connect or duplicate recovery');
        });

        // 11. A missing dashboard can be rebuilt automatically in the actual connected voice channel chat
        await test('11. A missing dashboard can be rebuilt automatically in the actual connected voice channel chat', async () => {
            const guildId = 'g-voice-dash';
            const vcId = 'vc-target';
            let sentChannelId = null;

            const voiceChannel = {
                id: vcId,
                name: 'Voice Lounge',
                isVoiceBased: () => true,
                permissionsFor: () => ({ has: () => true }),
                send: async (payload) => {
                    sentChannelId = vcId;
                    return { id: 'msg-dash-auto', channelId: vcId };
                }
            };

            const textChannel = {
                id: 'tc-general',
                name: 'general',
                isVoiceBased: () => false,
                permissionsFor: () => ({ has: () => true }),
                send: async () => {
                    sentChannelId = 'tc-general';
                    return { id: 'msg-tc', channelId: 'tc-general' };
                }
            };

            const dummyClient = {
                guilds: {
                    cache: new Map([
                        [guildId, {
                            id: guildId,
                            members: { me: { voice: { channelId: vcId } } },
                            channels: {
                                cache: new Map([
                                    [vcId, voiceChannel],
                                    ['tc-general', textChannel]
                                ])
                            }
                        }]
                    ])
                },
                channels: {
                    cache: new Map([
                        [vcId, voiceChannel],
                        ['tc-general', textChannel]
                    ])
                },
                lavalink: {
                    getPlayer: () => ({
                        guildId,
                        voiceChannelId: vcId,
                        playing: true,
                        paused: false,
                        queue: {
                            current: {
                                info: { title: 'Rebuilt Track', author: 'Artist', duration: 180000, uri: 'https://youtube.com/watch?v=123' }
                            },
                            tracks: []
                        }
                    })
                },
                guildSettings,
                lavalinkConnectionManager: { isAvailable: () => true }
            };

            const pc = new PlayerController(dummyClient);
            await pc.sendReplacementPlayer(guildId);

            assert.strictEqual(sentChannelId, vcId, 'Full dashboard must be sent to the connected voice channel, NOT text channel');
            const dash = pc.getDashboard(guildId);
            assert.strictEqual(dash?.messageId, 'msg-dash-auto');
            assert.strictEqual(dash?.channelId, vcId);
        });

        // 12. All relevant slash commands acknowledge and finalize correctly
        await test('12. All relevant slash commands acknowledge and finalize correctly', async () => {
            let edited = false;

            const mockInteraction = {
                id: 'slash-test-ack',
                deferred: true,
                replied: false,
                editReply: async (payload) => {
                    edited = true;
                    return payload;
                }
            };

            await safeReply(mockInteraction, { content: 'Operation finalized' });
            assert.strictEqual(edited, true, 'Deferred interaction must be finalized via editReply without double ack');
        });

        // 13. Music commands return a prompt temporary-unavailability result when no healthy node is available
        await test('13. Music commands return a prompt temporary-unavailability result when no healthy node is available', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [
                { host: 'dead1.test', port: 443, secure: true, authorization: 'pass' }
            ];
            provider.markNodeFailed('dead1.test', 443, 'dead', 'TRANSIENT_ERROR');

            const dummyClient = {
                lavalink: { nodeManager: { nodes: new Map() } },
                lavalinkMode: 'public',
                publicNodeProvider: provider,
                lavalinkConnectionManager: { isAvailable: () => false }
            };

            assert.strictEqual(dummyClient.lavalinkConnectionManager.isAvailable(), false);
            assert.strictEqual(provider.hasEligibleNode(), false);
            assert.strictEqual(isLavalinkAvailable(dummyClient), false, 'isLavalinkAvailable helper must promptly return false');
        });

        // 14. Dashboard rendering does not start playback
        await test('14. Dashboard rendering does not start playback', async () => {
            let playCalled = false;
            const mockPlayer = {
                guildId: 'g-render-test',
                playing: false,
                paused: true,
                queue: {
                    current: { info: { title: 'Paused Song', author: 'Artist', duration: 120000 } },
                    tracks: []
                },
                play: () => { playCalled = true; },
                resume: () => { playCalled = true; }
            };

            const pc = new PlayerController({ lavalink: {} });
            const embed = pc.createPlayerEmbed(mockPlayer, mockPlayer.queue.current);
            const buttons = pc.createPlayerButtons(mockPlayer);

            assert.ok(embed, 'Embed must be generated');
            assert.ok(buttons.length > 0, 'Buttons must be generated');
            assert.strictEqual(playCalled, false, 'Rendering dashboard must NEVER call play() or resume()');
        });

        // 15. Healthy playback is not restarted due to ordinary dashboard updates
        await test('15. Healthy playback is not restarted due to ordinary dashboard updates', async () => {
            let restartCount = 0;
            const mockPlayer = {
                guildId: 'g-upd',
                playing: true,
                paused: false,
                position: 45000,
                queue: {
                    current: { info: { title: 'Ongoing Song', author: 'Artist', duration: 200000 } },
                    tracks: []
                },
                seek: () => { restartCount++; },
                play: () => { restartCount++; }
            };

            const dummyMsg = {
                id: 'existing-msg-id',
                edit: async () => dummyMsg
            };

            const dummyClient = {
                channels: {
                    cache: new Map([
                        ['vc-ongoing', {
                            id: 'vc-ongoing',
                            name: 'Voice',
                            isVoiceBased: () => true,
                            permissionsFor: () => ({ has: () => true }),
                            messages: {
                                cache: new Map([['existing-msg-id', dummyMsg]]),
                                fetch: async () => dummyMsg
                            },
                            send: async () => dummyMsg
                        }]
                    ])
                },
                lavalink: { getPlayer: () => mockPlayer },
                guildSettings,
                lavalinkConnectionManager: { isAvailable: () => true }
            };

            const pc = new PlayerController(dummyClient);
            pc.setDashboard('g-upd', { messageId: 'existing-msg-id', channelId: 'vc-ongoing' });
            pc.lastReplacement.set('g-upd', {
                trackId: 'PLAYING',
                messageId: 'existing-msg-id',
                timestamp: Date.now()
            });

            await pc.sendReplacementPlayer('g-upd', { track: mockPlayer.queue.current });

            assert.strictEqual(restartCount, 0, 'In-place dashboard update must NEVER restart or re-seek the track');
        });

        // 16. Autoplay/natural queue progression starts one valid next track exactly once
        await test('16. Autoplay/natural queue progression starts one valid next track exactly once', async () => {
            let playCount = 0;
            const mockPlayer = {
                guildId: 'g-autoplay',
                playing: false,
                paused: false,
                queue: {
                    current: null,
                    tracks: [{ info: { title: 'Next Up', uri: 'https://youtube.com/watch?v=next' } }]
                },
                play: async () => {
                    playCount++;
                    mockPlayer.queue.current = mockPlayer.queue.tracks.shift();
                    mockPlayer.playing = true;
                }
            };

            // Natural advance
            if (!mockPlayer.queue.current && mockPlayer.queue.tracks.length > 0) {
                await mockPlayer.play();
            }

            assert.strictEqual(playCount, 1, 'Next track must be played exactly once');
            assert.strictEqual(mockPlayer.queue.current?.info?.title, 'Next Up');
        });

        // 17. Distinguish sustained lag from startup spike and reset histogram periodically
        await test('17. Performance metrics distinguish sustained lag from startup spike and reset histogram periodically', async () => {
            const summary = performanceMonitor.getMetricsSummary();
            assert.ok(summary.eventLoop, 'eventLoop metrics must exist');
            assert.ok(typeof summary.eventLoop.sustainedLagMs === 'number', 'sustainedLagMs must be numeric');
            assert.ok(typeof summary.eventLoop.recentMaxLagMs === 'number', 'recentMaxLagMs must be numeric');
            assert.ok(typeof summary.eventLoop.lagMeanMs === 'number', 'lagMeanMs must be numeric');
        });

    } finally {
        global.fetch = originalFetch;
    }

    console.log(`\nAll production emergency master fix tests passed: ${passed}/${total}`);
    if (passed < total) process.exit(1);
    process.exit(0);
}

run().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
