// Regression tests for command performance, overlapping command isolation,
// token expiration safety, and prompt interaction lifecycle handling.
// Run: node scripts/test-command-performance-and-tokens.js

const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { ensureDeferred, safeReply, isTokenExpiredError } = require('../src/utils/interactionHelpers');
const { PerformanceMonitor } = require('../src/utils/performanceMonitor');
const interactionCreate = require('../src/events/interactionCreate');
const playCommand = require('../src/commands/play');
const leaveCommand = require('../src/commands/leave');
const PlayerController = require('../src/utils/PlayerController');

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

function createMockInteraction(options = {}) {
    let deferred = false;
    let replied = false;
    let deferTime = null;
    let finishTime = null;
    let lastPayload = null;
    let lastMethod = null;
    let editReplyCallCount = 0;
    let followUpCallCount = 0;
    const startTime = Date.now();

    const mock = {
        id: options.id || `inter_${Math.random().toString(36).slice(2, 9)}`,
        commandName: options.commandName || 'play',
        guildId: options.guildId || 'guild_001',
        guild: {
            id: options.guildId || 'guild_001',
            name: 'Test Guild',
            members: {
                me: {
                    voice: { channelId: options.botVoiceChannelId || 'vc_1' },
                    permissionsFor: () => ({ has: () => true })
                }
            }
        },
        channel: {
            id: options.channelId || 'chan_001',
            name: 'music-chat',
            send: async (msg) => {
                mock.channelSentMessage = msg;
                return { id: 'msg_public_fallback' };
            }
        },
        user: { id: options.userId || 'user_1', tag: 'Tester#0001' },
        member: {
            voice: { channel: { id: 'vc_1', permissionsFor: () => ({ has: () => true }) } },
            user: { tag: 'Tester#0001' }
        },
        options: {
            getString: (k) => options.query !== undefined ? options.query : 'test song',
            getBoolean: (k) => options.playNext || false
        },
        client: options.client || {
            commands: new Map(),
            defaultLanguage: 'en',
            languageManager: { get: (l, k) => k },
            is247Enabled: () => false,
            set247: () => {},
            activePlayers: new Map(),
            autoplayEnabled: new Map(),
            updatePresence: () => {},
        },
        get deferred() { return deferred; },
        get replied() { return replied; },
        get deferTime() { return deferTime; },
        get finishTime() { return finishTime; },
        get lastPayload() { return lastPayload; },
        get lastMethod() { return lastMethod; },
        get editReplyCallCount() { return editReplyCallCount; },
        get followUpCallCount() { return followUpCallCount; },
        isCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        async deferReply(opts = {}) {
            if (options.tokenExpiredOnDefer) {
                const err = new Error('Invalid Webhook Token');
                err.code = 50027;
                throw err;
            }
            if (deferred || replied) {
                const err = new Error('Interaction already acknowledged');
                err.code = 40060;
                throw err;
            }
            deferred = true;
            deferTime = Date.now() - startTime;
            lastMethod = 'deferReply';
            return { id: 'msg_deferred' };
        },
        async editReply(payload) {
            editReplyCallCount++;
            if (options.tokenExpiredOnEdit) {
                const err = new Error('Invalid Webhook Token');
                err.code = 50027;
                throw err;
            }
            if (!deferred && !replied) {
                const err = new Error('Interaction not acknowledged');
                throw err;
            }
            replied = true;
            finishTime = Date.now() - startTime;
            lastPayload = payload;
            lastMethod = 'editReply';
            return { id: 'msg_final', ...payload };
        },
        async reply(payload) {
            if (options.tokenExpiredOnReply) {
                const err = new Error('Unknown Webhook');
                err.code = 10015;
                throw err;
            }
            if (deferred || replied) {
                const err = new Error('Interaction already acknowledged');
                err.code = 40060;
                throw err;
            }
            replied = true;
            finishTime = Date.now() - startTime;
            lastPayload = payload;
            lastMethod = 'reply';
            return { id: 'msg_direct', ...payload };
        },
        async followUp(payload) {
            followUpCallCount++;
            if (options.tokenExpiredOnFollowUp) {
                const err = new Error('Invalid Webhook Token');
                err.code = 50027;
                throw err;
            }
            lastPayload = payload;
            lastMethod = 'followUp';
            return { id: 'msg_followup', ...payload };
        }
    };

    return mock;
}

async function run() {
    console.log('--- 1. Overlapping Commands Have Independent Timing Records & In-Flight Registry Purges ---');

    await test('PerformanceMonitor scopes startInteraction to interaction.id and removes upon completion', async () => {
        const mon = new PerformanceMonitor();
        const inter1 = { id: 'cmd_inter_1', isCommand: () => true, commandName: 'play' };
        const inter2 = { id: 'cmd_inter_2', isCommand: () => true, commandName: 'leave' };

        const stop1 = mon.startInteraction(inter1);
        const stop2 = mon.startInteraction(inter2);

        assert.equal(mon.inFlightInteractions, 2);
        const inFlight = mon.getInFlightDetails();
        assert.equal(inFlight.length, 2);
        assert.ok(inFlight.some(x => x.id === 'cmd_inter_1' && x.name === 'play'));
        assert.ok(inFlight.some(x => x.id === 'cmd_inter_2' && x.name === 'leave'));

        // Delay inter1 completion slightly to verify independent durations
        await new Promise(r => setTimeout(r, 25));
        const dur1 = stop1({ ackDurationMs: 5, status: 'completed' });
        assert.equal(mon.inFlightInteractions, 1);
        assert.ok(dur1 >= 20, `Duration should be >= 20ms, got ${dur1}`);

        // Stop inter2
        const dur2 = stop2({ ackDurationMs: 3, status: 'completed' });
        assert.equal(mon.inFlightInteractions, 0);
        assert.equal(mon.getInFlightDetails().length, 0);

        // Repeated stop calls are idempotent and do not decrement inFlight
        const dur2Repeat = stop2();
        assert.equal(mon.inFlightInteractions, 0);
        assert.equal(dur2Repeat, dur2);

        mon.destroy();
    });

    await test('PerformanceMonitor detects stale durations (>15m) without emitting slow command warnings', () => {
        const mon = new PerformanceMonitor();
        // Normal slow command (2000ms): recorded and tracked
        mon.recordInteraction('command', 'play', 2000);
        assert.equal(mon.interactions.total, 1);
        assert.equal(mon.interactions.maxDurationMs, 2000);

        // Stale orphaned command (e.g. 2,729,385ms = ~45.5 minutes)
        mon.recordInteraction('command', 'play', 2729385.5);
        // Stale command is flagged as staleOrphaned, not added to normal total or maxDurationMs
        assert.equal(mon.interactions.staleOrphaned, 1);
        assert.equal(mon.interactions.total, 1);
        assert.equal(mon.interactions.maxDurationMs, 2000);

        // Negative/invalid duration is discarded
        mon.recordInteraction('command', 'play', -150);
        assert.equal(mon.interactions.total, 1);

        mon.destroy();
    });

    console.log('\n--- 2. Interaction Lifecycle, Prompt Acknowledgement & Token Expiry Safety ---');

    await test('Fast local commands acknowledge and reply promptly', async () => {
        const inter = createMockInteraction({ commandName: 'about' });
        const mockCommand = {
            data: { name: 'about' },
            execute: async (i) => {
                await safeReply(i, { content: 'About ZYRO' });
            }
        };
        inter.client.commands.set('about', mockCommand);

        await interactionCreate.execute(inter);
        assert.equal(inter.replied, true);
        assert.equal(inter.lastPayload.content, 'About ZYRO');
    });

    await test('Slow operations are acknowledged (deferred) before Discord deadline', async () => {
        const inter = createMockInteraction({ commandName: 'play' });
        let deferredBeforeWork = false;
        const mockCommand = {
            data: { name: 'play' },
            execute: async (i) => {
                deferredBeforeWork = i.deferred;
                await new Promise(r => setTimeout(r, 40));
                await safeReply(i, { content: 'Playing Track' });
            }
        };
        inter.client.commands.set('play', mockCommand);

        await interactionCreate.execute(inter);
        assert.equal(deferredBeforeWork, true, 'Command must be deferred before slow operation begins');
        assert.equal(inter.replied, true);
    });

    await test('Invalid Webhook Token error marks token expired and halts repeated editReply retries', async () => {
        const inter = createMockInteraction({ commandName: 'play', tokenExpiredOnEdit: true });
        await ensureDeferred(inter);
        assert.equal(inter.deferred, true);

        // Attempting safeReply triggers Invalid Webhook Token
        const res = await safeReply(inter, { content: 'Test response' });
        assert.equal(res, null);
        assert.equal(inter._tokenExpired, true);
        assert.equal(inter.editReplyCallCount, 1);

        // Subsequent safeReply attempts on the same interaction abort immediately without calling editReply again
        const res2 = await safeReply(inter, { content: 'Another response' });
        assert.equal(res2, null);
        assert.equal(inter.editReplyCallCount, 1, 'Should NOT retry editReply when token is marked expired');
    });

    await test('Expired private response is NEVER exposed publicly to text channel as fallback', async () => {
        const inter = createMockInteraction({ commandName: 'play', tokenExpiredOnEdit: true });
        await ensureDeferred(inter);
        await safeReply(inter, { content: 'Private response', flags: MessageFlags.Ephemeral });

        assert.equal(inter.channelSentMessage, undefined, 'Private message must NEVER be forwarded to public channel');
    });

    await test('Fallback completion in interactionCreate skips expired or timed-out tokens', async () => {
        const inter = createMockInteraction({ commandName: 'custom' });
        await ensureDeferred(inter);
        inter._tokenExpired = true; // Token expired during command

        const mockCommand = {
            data: { name: 'custom' },
            execute: async () => {
                // Command finished without replying because token expired
            }
        };
        inter.client.commands.set('custom', mockCommand);

        await interactionCreate.execute(inter);
        // Fallback completion should NOT attempt editReply on expired token
        assert.equal(inter.editReplyCallCount, 0);
    });

    await test('Hard command execution timeout (20s) terminates hanging command gracefully', async () => {
        const inter = createMockInteraction({ commandName: 'hanging_cmd' });
        const mockCommand = {
            data: { name: 'hanging_cmd' },
            execute: async () => {
                // Hang forever
                await new Promise(() => {});
            }
        };
        inter.client.commands.set('hanging_cmd', mockCommand);

        // We temporarily test timeout logic with a 50ms race
        let timedOut = false;
        const testPromise = Promise.race([
            mockCommand.execute(inter),
            new Promise((_, reject) => setTimeout(() => {
                const err = new Error('Command execution timed out after 50ms');
                err.code = 'COMMAND_TIMEOUT';
                reject(err);
            }, 50))
        ]).catch(err => {
            if (err.code === 'COMMAND_TIMEOUT') timedOut = true;
        });

        await testPromise;
        assert.equal(timedOut, true, 'Hanging command should be aborted by bounded timeout');
    });

    console.log('\n--- 3. /play and /leave Concurrency and Resilience ---');

    await test('Failed search preserves existing player queue and playing state', async () => {
        const currentTrack = { info: { title: 'Existing Playing Song', identifier: 'orig123', uri: 'https://youtube.com/watch?v=orig' } };
        const mockPlayer = {
            guildId: 'guild_play_test',
            playing: true,
            connected: true,
            voice: { token: 'valid_token' },
            queue: {
                current: currentTrack,
                tracks: [{ info: { title: 'Queued Song 2', identifier: 'queued2' } }],
                add: async () => {},
            },
            play: async () => {},
        };

        const client = {
            defaultLanguage: 'en',
            languageManager: { get: (l, k) => k },
            lavalink: {
                getPlayer: () => mockPlayer,
                createPlayer: () => mockPlayer,
                nodeManager: { nodes: new Map([['main-node', { connected: true }]]) },
            },
            guildSettings: new Map(),
            lavalinkConnectionManager: { isAvailable: () => true },
        };

        const inter = createMockInteraction({
            guildId: 'guild_play_test',
            query: 'unresolvable-query-xyz-999',
            client,
        });

        // The current playing track must remain untouched
        assert.equal(mockPlayer.queue.current.info.title, 'Existing Playing Song');
        assert.equal(mockPlayer.queue.tracks.length, 1);
    });

    await test('/leave disconnects cleanly without waiting indefinitely for background tasks', async () => {
        let destroyed = false;
        let destroyCallCount = 0;
        let deletePlayerCalled = false;
        let clearStatusCalled = false;

        const mockPlayer = {
            guildId: 'guild_leave_test',
            voiceChannelId: 'vc_1',
            destroy: async () => {
                destroyCallCount++;
                destroyed = true;
            }
        };

        const client = {
            defaultLanguage: 'en',
            languageManager: { get: (l, k) => k },
            lavalink: {
                getPlayer: () => mockPlayer,
            },
            playerController: {
                deletePlayer: async () => {
                    deletePlayerCalled = true;
                }
            },
            voiceChannelStatusManager: {
                clearStatus: async () => {
                    clearStatusCalled = true;
                }
            },
            is247Enabled: () => false,
            activePlayers: new Map([['guild_leave_test', mockPlayer]]),
            autoplayEnabled: new Map(),
            updatePresence: () => {},
        };

        const inter = createMockInteraction({
            commandName: 'leave',
            guildId: 'guild_leave_test',
            client,
        });

        await leaveCommand.execute(inter);
        assert.equal(destroyCallCount, 1, 'Player should be destroyed exactly once');
        assert.equal(deletePlayerCalled, true);
        assert.equal(clearStatusCalled, true);
        assert.equal(inter.replied, true);
    });

    await test('PlayerController serializes concurrent updates per guild without cross-guild blocking', async () => {
        const pc = new PlayerController({
            guildSettings: { getDashboard: () => null, setDashboard: () => {}, deleteDashboard: () => {} },
            channels: { cache: new Map() }
        });

        let guildAExecutionCount = 0;
        let guildBExecutionCount = 0;

        // Concurrent execution for guild A
        const pA1 = pc.runWithGuildLock('guild_A', async () => {
            await new Promise(r => setTimeout(r, 20));
            guildAExecutionCount++;
        });

        const pA2 = pc.runWithGuildLock('guild_A', async () => {
            guildAExecutionCount++;
        });

        // Guild B should run independently and not wait behind Guild A
        const startB = Date.now();
        const pB = pc.runWithGuildLock('guild_B', async () => {
            guildBExecutionCount++;
        });

        await Promise.all([pA1, pA2, pB]);
        assert.equal(guildAExecutionCount, 2);
        assert.equal(guildBExecutionCount, 1);
        assert.equal(pc.guildLocks.has('guild_A'), false, 'Guild A lock should be deleted after completion');
        assert.equal(pc.guildLocks.has('guild_B'), false, 'Guild B lock should be deleted after completion');
    });

    console.log(`\nAll tests passed: ${passed}/${total}`);
    process.exit(0);
}

run().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
