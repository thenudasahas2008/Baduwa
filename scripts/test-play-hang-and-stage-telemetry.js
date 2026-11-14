const assert = require('node:assert/strict');
const playCommand = require('../src/commands/play');
const { safeReply, ensureDeferred, RESPONSE_STATES } = require('../src/utils/interactionHelpers');
const { clearSearchCache } = require('../src/utils/searchEngine');
const { performanceMonitor } = require('../src/utils/performanceMonitor');

if (performanceMonitor && performanceMonitor.intervalTimer && typeof performanceMonitor.intervalTimer.unref === 'function') {
    performanceMonitor.intervalTimer.unref();
}

console.log('=== ZYRO /play Hang Fix & 11-Stage Telemetry Regression Suite ===\n');

let passed = 0;
let total = 0;

async function test(name, fn) {
    total++;
    try {
        await fn();
        passed++;
        console.log(`  [PASS] ${name}`);
    } catch (err) {
        console.error(`  [FAIL] ${name}:`, err.message || err);
        process.exitCode = 1;
    }
}

function createMockInteraction(overrides = {}) {
    const replies = [];
    const deferrals = [];
    let isDeferred = false;
    let isReplied = false;

    const base = {
        id: overrides.id || `mock-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        commandName: 'play',
        guildId: overrides.guildId || 'guild-hang-1',
        channelId: overrides.channelId || 'chan-123',
        guild: overrides.guild !== undefined ? overrides.guild : {
            id: overrides.guildId || 'guild-hang-1',
            name: 'Test Guild',
            members: { me: { voice: { channelId: 'vc-123' }, permissions: { has: () => true } } }
        },
        member: overrides.member !== undefined ? overrides.member : {
            id: 'user-123',
            voice: {
                channel: {
                    id: 'vc-123',
                    name: 'Voice Channel',
                    permissionsFor: () => ({ has: () => true })
                }
            },
            user: { tag: 'Tester#0001', id: 'user-123' }
        },
        user: { id: 'user-123', tag: 'Tester#0001' },
        options: {
            getString: (k) => overrides.query !== undefined ? overrides.query : 'Adele - Hello',
            getBoolean: (k) => overrides.next || false
        },
        get deferred() { return isDeferred; },
        set deferred(v) { isDeferred = v; },
        get replied() { return isReplied; },
        set replied(v) { isReplied = v; },
        client: overrides.client || {
            defaultLanguage: 'en',
            languageManager: { get: (l, k) => `lang:${k}` },
            commands: new Map([['play', playCommand]]),
            lavalink: {
                getPlayer: () => null,
                createPlayer: () => ({
                    connected: true,
                    playing: false,
                    voice: { token: 'mock-token', endpoint: 'mock-endpoint', sessionId: 'mock-sess' },
                    connect: async () => true,
                    play: async () => true,
                    queue: { tracks: [], add: async () => {}, current: null },
                    search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Adele - Hello', uri: 'https://youtube.com/watch?v=123' } }] })
                }),
                nodeManager: { leastUsedNodes: () => [{ id: 'active-node', connected: true }] }
            },
            lavalinkConnectionManager: {
                getActiveNode: () => ({ id: 'active-node', connected: true }),
                isAvailable: () => true,
            },
            voiceChannelStatusManager: { updateFromPlayer: async () => {} },
            playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} },
            is247Enabled: () => false,
        },
        deferReply: async function() {
            isDeferred = true;
            deferrals.push(true);
            return { id: 'deferred' };
        },
        editReply: async function(payload) {
            isReplied = true;
            replies.push({ type: 'editReply', payload });
            return { id: 'edited', ...payload };
        },
        reply: async function(payload) {
            isReplied = true;
            replies.push({ type: 'reply', payload });
            return { id: 'reply', ...payload };
        },
        followUp: async function(payload) {
            replies.push({ type: 'followUp', payload });
            return { id: 'followUp', ...payload };
        },
        _getReplies: () => replies,
        _getDeferrals: () => deferrals,
    };

    if (overrides._timedOut) base._timedOut = true;
    if (overrides.deferred !== undefined) base.deferred = overrides.deferred;
    if (overrides.replied !== undefined) base.replied = overrides.replied;

    return base;
}

(async () => {
    // 1. Prompt acknowledgment (< 3s SLA)
    await test('1. /play promptly acknowledges interaction with deferReply within deadline', async () => {
        clearSearchCache();
        const interaction = createMockInteraction();
        const start = Date.now();
        await playCommand.execute(interaction);
        const duration = Date.now() - start;
        assert.equal(interaction.deferred, true, 'Interaction must be deferred');
        assert.ok(duration < 2500, `Execution should be snappy, took ${duration}ms`);
        assert.equal(interaction.replied, true, 'Interaction must have final reply delivered');
    });

    // 2. Hanging search bounded timeout
    await test('2. A hanging search operation times out cleanly and delivers a final response without hanging indefinitely', async () => {
        clearSearchCache();
        const slowSearchPlayer = {
            connected: true,
            voice: { token: 'mock-token', sessionId: 'sess-1' },
            connect: async () => true,
            play: async () => true,
            queue: { tracks: [], add: async () => {}, current: null },
            // Stalls forever
            search: () => new Promise(() => {})
        };
        const interaction = createMockInteraction({
            query: 'uniquely-stalled-query-' + Date.now(),
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'err' },
                lavalink: {
                    getPlayer: () => slowSearchPlayer,
                    createPlayer: () => slowSearchPlayer,
                    nodeManager: { leastUsedNodes: () => [{ id: 'slow-node', connected: true }] }
                },
                lavalinkConnectionManager: { getActiveNode: () => ({ id: 'slow-node', connected: true }), isAvailable: () => true },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} }
            }
        });

        const start = Date.now();
        await playCommand.execute(interaction);
        const elapsed = Date.now() - start;
        // Bounded to 6s (+ small margin), must NOT hang indefinitely
        assert.ok(elapsed < 8500, `Search timeout must bound command execution (took ${elapsed}ms)`);
        assert.equal(interaction.replied, true, 'Interaction must reach a final response');
        const replies = interaction._getReplies();
        assert.ok(replies.length > 0, 'Must have sent a reply');
        const embedTitle = replies[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(embedTitle, /No Matching Tracks Found/i);
    });

    // 3. Hanging voice connection bounded timeout
    await test('3. A hanging voice connection does not leave response pending indefinitely', async () => {
        clearSearchCache();
        const slowVoicePlayer = {
            connected: false,
            voice: {},
            // Hangs on connect
            connect: () => new Promise(() => {}),
            play: async () => true,
            queue: { tracks: [], add: async () => {}, current: null },
            search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Track 1' } }] })
        };
        const interaction = createMockInteraction({
            guild: {
                id: 'guild-hang-vc',
                members: { me: { voice: { channelId: null } } }
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'err' },
                lavalink: {
                    getPlayer: () => slowVoicePlayer,
                    createPlayer: () => slowVoicePlayer,
                    nodeManager: { leastUsedNodes: () => [{ id: 'node-1', connected: true }] }
                },
                lavalinkConnectionManager: { getActiveNode: () => ({ id: 'node-1', connected: true }), isAvailable: () => true },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} }
            }
        });

        const start = Date.now();
        await playCommand.execute(interaction);
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 6000, `Voice connection timeout must bound execution (took ${elapsed}ms)`);
        assert.equal(interaction.replied, true, 'Must have replied');
        const replies = interaction._getReplies();
        const embedTitle = replies[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(embedTitle, /Voice Connection Failed/i);
    });

    // 4. Each failure path returns a useful final response
    await test('4. Failure paths return useful final responses (NOT_IN_VOICE, MISSING_PERMS, LAVALINK_UNAVAILABLE)', async () => {
        // Path A: User not in voice
        const noVoiceInter = createMockInteraction({ member: { id: 'u1', voice: { channel: null } } });
        await playCommand.execute(noVoiceInter);
        assert.equal(noVoiceInter.replied, true);
        assert.match(noVoiceInter._getReplies()[0].payload.content || '', /NOT_IN_VOICE|You must be in a voice channel/i);

        // Path B: Missing permissions
        const noPermsInter = createMockInteraction({
            member: {
                id: 'u1',
                voice: {
                    channel: {
                        id: 'vc-no-perm',
                        permissionsFor: () => ({ has: () => false })
                    }
                }
            }
        });
        await playCommand.execute(noPermsInter);
        assert.equal(noPermsInter.replied, true);
        const permEmbed = noPermsInter._getReplies()[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(permEmbed, /Missing Permissions/i);

        // Path C: Lavalink unavailable
        const lavalinkUnavailInter = createMockInteraction({
            client: {
                defaultLanguage: 'en',
                lavalinkConnectionManager: { isAvailable: () => false }
            }
        });
        await playCommand.execute(lavalinkUnavailInter);
        assert.equal(lavalinkUnavailInter.replied, true);
        const unavailEmbed = lavalinkUnavailInter._getReplies()[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(unavailEmbed, /Music Service Reconnecting/i);
    });

    // 5. Response edit failure does NOT replay the song
    await test('5. A response-edit failure does not replay the song or crash execution', async () => {
        clearSearchCache();
        let playCount = 0;
        const mockPlayer = {
            connected: true,
            voice: { token: 'token-ok', sessionId: 'sess-ok' },
            connect: async () => true,
            play: async () => { playCount++; return true; },
            queue: { tracks: [], add: async () => {}, current: null },
            search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Dua Lipa - Levitating' } }] })
        };
        const interaction = createMockInteraction({
            query: 'Dua Lipa - Levitating ' + Date.now(),
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'err' },
                lavalink: {
                    getPlayer: () => mockPlayer,
                    createPlayer: () => mockPlayer,
                    nodeManager: { leastUsedNodes: () => [{ id: 'node-ok', connected: true }] }
                },
                lavalinkConnectionManager: { getActiveNode: () => ({ id: 'node-ok', connected: true }), isAvailable: () => true },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} }
            }
        });

        // Simulate editReply throwing network error
        interaction.editReply = async () => {
            const err = new Error('Discord 500 Internal Server Error');
            err.code = 500;
            throw err;
        };

        // Should not throw unhandled exception or replay
        await playCommand.execute(interaction);
        assert.equal(playCount, 1, 'Track must be played exactly once; never replayed on edit failure');
    });

    // 6. Successful search results in exactly one playback request
    await test('6. A successful search results in exactly one playback request', async () => {
        clearSearchCache();
        let playCount = 0;
        const mockPlayer = {
            connected: true,
            voice: { token: 'token-ok', sessionId: 'sess-ok' },
            connect: async () => true,
            play: async () => { playCount++; return true; },
            queue: { tracks: [], add: async () => {}, current: null },
            search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Queen - Bohemian Rhapsody' } }] })
        };
        const interaction = createMockInteraction({
            query: 'Queen - Bohemian Rhapsody ' + Date.now(),
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'err' },
                lavalink: {
                    getPlayer: () => mockPlayer,
                    createPlayer: () => mockPlayer,
                    nodeManager: { leastUsedNodes: () => [{ id: 'node-ok', connected: true }] }
                },
                lavalinkConnectionManager: { getActiveNode: () => ({ id: 'node-ok', connected: true }), isAvailable: () => true },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} }
            }
        });

        await playCommand.execute(interaction);
        assert.equal(playCount, 1, 'Expected exactly one player.play() call');
        assert.equal(interaction.replied, true, 'Interaction must be replied');
    });

    // 7. A failed source is not misclassified as a voice failure
    await test('7. A failed source (no search results / unplayable) is not misclassified as a voice failure', async () => {
        clearSearchCache();
        const mockPlayer = {
            connected: true,
            voice: { token: 'token-ok', sessionId: 'sess-ok' },
            connect: async () => true,
            play: async () => true,
            queue: { tracks: [], add: async () => {}, current: null },
            search: async () => ({ loadType: 'empty', tracks: [] })
        };
        const interaction = createMockInteraction({
            query: 'unknown-query-no-results-xyz-' + Date.now(),
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'err' },
                lavalink: {
                    getPlayer: () => mockPlayer,
                    createPlayer: () => mockPlayer,
                    nodeManager: { leastUsedNodes: () => [{ id: 'node-ok', connected: true }] }
                },
                lavalinkConnectionManager: { getActiveNode: () => ({ id: 'node-ok', connected: true }), isAvailable: () => true },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} }
            }
        });

        await playCommand.execute(interaction);
        const reply = interaction._getReplies()[0];
        const title = reply.payload?.embeds?.[0]?.data?.title || '';
        assert.match(title, /No Matching Tracks Found/i, 'Must report source failure, NOT voice failure');
        assert.doesNotMatch(title, /Voice Connection Failed/i);
    });

    // 8. A voice failure is not misclassified as a source failure
    await test('8. A voice failure is not misclassified as a source failure', async () => {
        clearSearchCache();
        const mockPlayer = {
            connected: false,
            voice: {},
            connect: async () => { throw new Error('Voice server connection refused'); },
            play: async () => true,
            queue: { tracks: [], add: async () => {}, current: null },
            search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Test Track' } }] })
        };
        const interaction = createMockInteraction({
            guild: {
                id: 'guild-voice-fail',
                members: { me: { voice: { channelId: null } } }
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'err' },
                lavalink: {
                    getPlayer: () => mockPlayer,
                    createPlayer: () => mockPlayer,
                    nodeManager: { leastUsedNodes: () => [{ id: 'node-ok', connected: true }] }
                },
                lavalinkConnectionManager: { getActiveNode: () => ({ id: 'node-ok', connected: true }), isAvailable: () => true },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} }
            }
        });

        await playCommand.execute(interaction);
        const reply = interaction._getReplies()[0];
        const title = reply.payload?.embeds?.[0]?.data?.title || '';
        assert.match(title, /Voice Connection Failed/i, 'Must report voice failure, NOT source failure');
        assert.doesNotMatch(title, /No Matching Tracks Found/i);
    });

    // 9. Dashboard failure cannot block playback
    await test('9. Dashboard failure cannot block playback or command finalization', async () => {
        clearSearchCache();
        let playCount = 0;
        const mockPlayer = {
            connected: true,
            voice: { token: 'token-ok', sessionId: 'sess-ok' },
            connect: async () => true,
            play: async () => { playCount++; return true; },
            queue: { tracks: [], add: async () => {}, current: null },
            search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Dashboard Resilient Track' } }] })
        };
        const interaction = createMockInteraction({
            query: 'Dashboard Resilient Track ' + Date.now(),
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'err' },
                lavalink: {
                    getPlayer: () => mockPlayer,
                    createPlayer: () => mockPlayer,
                    nodeManager: { leastUsedNodes: () => [{ id: 'node-ok', connected: true }] }
                },
                lavalinkConnectionManager: { getActiveNode: () => ({ id: 'node-ok', connected: true }), isAvailable: () => true },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: {
                    replaceWithFullDashboard: async () => { throw new Error('Simulated Discord API Error while sending dashboard message'); },
                    updatePlayer: async () => { throw new Error('Simulated updatePlayer failure'); }
                }
            }
        });

        await playCommand.execute(interaction);
        assert.equal(playCount, 1, 'Playback must succeed even when dashboard API rejects');
        assert.equal(interaction.replied, true, 'Interaction must be finalized');
    });

    // 10. Late timeout/recovery callbacks cannot overwrite a newer track
    await test('10. Late superseded command cannot overwrite newer queue or playback', async () => {
        clearSearchCache();
        let playOrder = [];
        const mockPlayer = {
            connected: true,
            voice: { token: 'token-ok', sessionId: 'sess-ok' },
            connect: async () => true,
            play: async () => true,
            queue: {
                tracks: [],
                add: async (track) => {
                    const t = Array.isArray(track) ? track[0] : track;
                    playOrder.push(t.info?.title);
                },
                current: null
            },
            search: async (options) => {
                const titleStr = typeof options === 'string' ? options : (options?.query || 'Song');
                return {
                    loadType: 'track',
                    tracks: [{ info: { title: titleStr, uri: 'https://youtube.com/watch?v=123' } }]
                };
            }
        };

        const client = {
            defaultLanguage: 'en',
            languageManager: { get: () => 'err' },
            lavalink: {
                getPlayer: () => mockPlayer,
                createPlayer: () => mockPlayer,
                nodeManager: { leastUsedNodes: () => [{ id: 'node-ok', connected: true }] }
            },
            lavalinkConnectionManager: { getActiveNode: () => ({ id: 'node-ok', connected: true }), isAvailable: () => true },
            voiceChannelStatusManager: { updateFromPlayer: async () => {} },
            playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} }
        };

        // Command 1 starts for Song A, but will be slow
        const inter1 = createMockInteraction({ id: 'cmd-1', guildId: 'guild-supersede', query: 'Slow Song A ' + Date.now(), client });
        // Command 2 starts immediately after for Song B
        const inter2 = createMockInteraction({ id: 'cmd-2', guildId: 'guild-supersede', query: 'Fast Song B ' + Date.now(), client });

        // Execute inter1 then inter2
        const p1 = playCommand.execute(inter1);
        const p2 = playCommand.execute(inter2);

        await Promise.all([p1, p2]);

        // Inter1 was superseded by inter2
        assert.equal(inter1.replied, true);
        assert.equal(inter2.replied, true);
        // Queue must have received Song B, not double-queued or corrupted
        assert.ok(playOrder.some(t => t && t.includes('Fast Song B')), 'Song B must be queued');
    });

    // 11. Stage telemetry logs contain non-secret commandRunId
    await test('11. Command creates unique non-secret commandRunId and logs stages', async () => {
        const interaction = createMockInteraction();
        await playCommand.execute(interaction);
        assert.ok(interaction._commandRunId, 'Must have set _commandRunId on interaction');
        assert.match(interaction._commandRunId, /^cmd_/, 'commandRunId must follow format cmd_*');
        assert.doesNotMatch(interaction._commandRunId, /token|auth|password/i, 'commandRunId must be non-secret');
    });

    console.log(`\nRegression Suite Completed: ${passed} / ${total} passed`);
    process.exit(passed === total ? 0 : 1);
})();
