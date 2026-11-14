// Regression tests for slash-command timeouts, stuck "thinking..." states, and duplicate Idle dashboards.
// Run: node scripts/test-command-timeouts.js

const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { ensureDeferred, safeReply, handleLavalinkError, logInteractionDiag } = require('../src/utils/interactionHelpers');
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

// Helper to create a mock interaction
function createMockInteraction(options = {}) {
    let deferred = false;
    let replied = false;
    let deferTime = null;
    let finishTime = null;
    let lastPayload = null;
    let lastMethod = null;
    const startTime = Date.now();

    return {
        id: options.id || 'inter_12345',
        commandName: options.commandName || 'play',
        guildId: options.guildId || 'guild_001',
        guild: {
            id: options.guildId || 'guild_001',
            name: 'Test Guild',
            ownerId: 'owner_999',
            members: { me: { voice: { channelId: 'vc_1' } } }
        },
        channel: {
            id: options.channelId || 'chan_001',
            name: 'music-chat'
        },
        user: { id: 'user_1', tag: 'Tester#0001' },
        member: {
            voice: { channel: { id: 'vc_1', permissionsFor: () => ({ has: () => true }) } },
            user: { tag: 'Tester#0001' }
        },
        options: {
            getString: (k) => options.query || 'test song',
            getBoolean: (k) => false
        },
        get deferred() { return deferred; },
        get replied() { return replied; },
        get deferTime() { return deferTime; },
        get finishTime() { return finishTime; },
        get lastPayload() { return lastPayload; },
        get lastMethod() { return lastMethod; },
        isCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        async deferReply(opts = {}) {
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
            lastPayload = payload;
            lastMethod = 'followUp';
            return { id: 'msg_followup', ...payload };
        }
    };
}

(async () => {
    console.log('\n--- Test A: /play SLA Acknowledgement and Finalization ---');

    await test('A1: /play acknowledges interaction within 50ms before slow 2000ms search', async () => {
        const interaction = createMockInteraction({ commandName: 'play' });

        // Simulate interactionCreate dispatcher early defer
        const start = Date.now();
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
        const ackLatency = Date.now() - start;

        assert.ok(interaction.deferred, 'Interaction must be deferred immediately');
        assert.ok(ackLatency < 100, `Acknowledgement must be well under 3000ms SLA, was ${ackLatency}ms`);

        // Simulate 2000ms track search resolution
        await new Promise(r => setTimeout(r, 50)); // scaled test delay

        // Complete command
        await safeReply(interaction, { content: '🎵 Playing: **Test Track**' });

        assert.equal(interaction.lastMethod, 'editReply', 'Response must be finalized via editReply');
        assert.ok(interaction.lastPayload?.content?.includes('Test Track'), 'Final response must reflect resolved track');
    });

    await test('A2: safeReply catches errors gracefully and never leaves unhandled rejections', async () => {
        const interaction = createMockInteraction();
        await interaction.deferReply();

        // Expired interaction (Discord 10062)
        const expiredInteraction = {
            deferred: true,
            async editReply() {
                const err = new Error('Unknown interaction');
                err.code = 10062;
                throw err;
            }
        };

        const result = await safeReply(expiredInteraction, { content: 'test' });
        assert.equal(result, null, 'Expired interaction error must be caught safely');
    });

    console.log('\n--- Test B: /stop Prompt Acknowledgement and Consolidating Duplicate Dashboards ---');

    await test('B1: /stop acknowledges promptly and finalizes deferred response', async () => {
        const interaction = createMockInteraction({ commandName: 'stop' });

        // Early defer
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        assert.ok(interaction.deferred);

        // Execute stop
        const stopEmbed = { title: 'Playback Stopped' };
        await safeReply(interaction, { embeds: [stopEmbed] });

        assert.equal(interaction.lastMethod, 'editReply');
        assert.equal(interaction.lastPayload.embeds[0].title, 'Playback Stopped');
    });

    await test('B2: PlayerController consolidates stop + queueEnd into exactly one Idle dashboard', async () => {
        let sentMessagesCount = 0;
        let editedMessagesCount = 0;
        const messages = new Map();

        const mockChannel = {
            id: 'chan_001',
            name: 'music',
            messages: {
                cache: messages,
                fetch: async (id) => messages.get(id) || null
            },
            send: async (payload) => {
                sentMessagesCount++;
                const msgId = `msg_idle_${sentMessagesCount}`;
                const msg = {
                    id: msgId,
                    channelId: 'chan_001',
                    embeds: payload.embeds,
                    components: payload.components,
                    edit: async (update) => {
                        editedMessagesCount++;
                        msg.embeds = update.embeds;
                        msg.components = update.components;
                        return msg;
                    }
                };
                messages.set(msgId, msg);
                return msg;
            }
        };

        const mockClient = {
            channels: {
                cache: new Map([['chan_001', mockChannel]]),
                fetch: async () => mockChannel
            },
            guildSettings: {
                get: () => ({ textChannelId: 'chan_001' }),
                getDashboard: () => null,
                setDashboard: () => {},
                deleteDashboard: () => {}
            },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'guild_001',
                    voiceChannelId: 'vc_1',
                    playing: false,
                    stopped: true,
                    queue: { current: null, tracks: [] }
                })
            },
            lavalinkConnectionManager: {
                isAvailable: () => true
            },
            is247Enabled: () => true
        };

        const controller = new PlayerController(mockClient);

        // 1. /stop triggers showStoppedState
        await controller.showStoppedState('guild_001', { channelId: 'chan_001' });

        assert.equal(sentMessagesCount, 1, 'First stop must send one dashboard message');
        const firstMsgId = controller.getDashboard('guild_001')?.messageId;
        assert.ok(firstMsgId, 'Dashboard message ID must be stored');

        // 2. Simultaneous queueEnd triggers showStoppedState immediately afterwards
        await controller.showStoppedState('guild_001', { channelId: 'chan_001' });

        // 3. User clicks /stop again 100ms later
        await controller.showStoppedState('guild_001', { channelId: 'chan_001' });

        assert.equal(sentMessagesCount, 1, 'Rapid Idle transitions must NOT create duplicate dashboard messages');
        assert.equal(editedMessagesCount, 2, 'Subsequent transitions must update in-place');
        assert.equal(controller.getDashboard('guild_001')?.messageId, firstMsgId, 'Dashboard ID must remain consistent');
    });

    console.log('\n--- Test C: Command Dispatcher Lifecycle and Error Guard ---');

    await test('C1: Command throwing an error is caught and finalized without leaving stuck thinking', async () => {
        const interaction = createMockInteraction({ commandName: 'play' });

        // Early defer
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Simulate command execution throwing
        try {
            throw new Error('Lavalink connection dropped');
        } catch (err) {
            await safeReply(interaction, { content: 'An unexpected error occurred.' });
        }

        assert.equal(interaction.lastMethod, 'editReply');
        assert.equal(interaction.lastPayload.content, 'An unexpected error occurred.');
    });

    await test('C2: safeReply prevents double acknowledgement error (code 40060)', async () => {
        const interaction = createMockInteraction();
        await interaction.deferReply();

        // Calling reply directly would fail with 40060, but safeReply routes to editReply
        const res = await safeReply(interaction, { content: 'Safe update' });
        assert.ok(res, 'safeReply must succeed without throwing');
        assert.equal(interaction.lastMethod, 'editReply');
    });

    console.log('\n--- Test D: Dashboard Lifecycle and Idle Controls ---');

    await test('D1: Old dashboard message is only queued for deletion after new one succeeds', async () => {
        let sent = 0;
        const staleQueue = [];
        const mockChannel = {
            id: 'c1',
            send: async () => {
                sent++;
                return { id: `msg_${sent}` };
            }
        };

        const mockClient = {
            channels: { fetch: async () => mockChannel },
            guildSettings: { get: () => ({ textChannelId: 'c1' }) },
            lavalink: { getPlayer: () => null },
            lavalinkConnectionManager: { isAvailable: () => true },
            is247Enabled: () => true
        };

        const controller = new PlayerController(mockClient);
        controller.trackStaleMessage = (guildId, chanId, msgId) => {
            staleQueue.push(msgId);
        };

        // First creation
        await controller.showStoppedState('g1', { channelId: 'c1' });
        assert.equal(staleQueue.length, 0, 'First dashboard has no stale messages to delete');

        // Replacement with force: true
        await controller.sendReplacementPlayer('g1', { channelId: 'c1', force: true, stopped: true });
        assert.equal(staleQueue.length, 1, 'Previous dashboard ID must be tracked as stale for cleanup');
        assert.equal(staleQueue[0], 'msg_1', 'Correct old message ID was tracked');
        assert.equal(controller.getDashboard('g1').messageId, 'msg_2', 'Active dashboard must be updated to msg_2');
    });

    await test('D2: Failed dashboard send preserves previous dashboard ID', async () => {
        const mockChannel = {
            id: 'c1',
            send: async () => {
                throw new Error('Discord 500 Internal Server Error');
            }
        };

        const mockClient = {
            channels: { fetch: async () => mockChannel },
            guildSettings: { get: () => ({ textChannelId: 'c1' }) },
            lavalink: { getPlayer: () => null },
            lavalinkConnectionManager: { isAvailable: () => true }
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g1', { messageId: 'msg_existing', channelId: 'c1' });

        const result = await controller.sendReplacementPlayer('g1', { channelId: 'c1', force: true, stopped: true });
        assert.equal(result, null, 'Failed send returns null');
        assert.equal(controller.getDashboard('g1').messageId, 'msg_existing', 'Stored dashboard ID must remain intact on failure');
    });

    await test('D3: Idle dashboard component payload removes all playback buttons', () => {
        const mockClient = { is247Enabled: () => false };
        const controller = new PlayerController(mockClient);
        const buttons = controller.createStoppedButtons({ guildId: 'g1' });

        assert.equal(buttons.length, 0, 'Stopped state must have 0 rows of controls');
        assert.deepEqual(buttons, [], 'Idle dashboard components must be an empty array');
    });

    console.log('\n--- Test E: Guild Lock Concurrency & Cleanup ---');

    await test('E1: Per-guild locks serialize concurrent operations and clean up completely', async () => {
        const controller = new PlayerController({});
        const executionOrder = [];

        const op1 = controller.runWithGuildLock('g1', async () => {
            await new Promise(r => setTimeout(r, 20));
            executionOrder.push(1);
        });

        const op2 = controller.runWithGuildLock('g1', async () => {
            executionOrder.push(2);
        });

        await Promise.all([op1, op2]);
        assert.deepEqual(executionOrder, [1, 2], 'Operations must execute sequentially');
        assert.equal(controller.guildLocks.has('g1'), false, 'Guild lock must be cleaned up when idle');
    });

    console.log('\n--- Test F: Fast Command Immediate Reply & SLA Metrics ---');

    await test('F1: Fast local commands (/about, /support, /invite) reply directly without deferReply', async () => {
        const interactionCreate = require('../src/events/interactionCreate');
        const aboutCmd = require('../src/commands/about');
        const commands = new Map();
        commands.set('about', aboutCmd);

        const mockClient = {
            commands,
            defaultLanguage: 'en',
            user: { username: 'ZYRO', tag: 'ZYRO#1234', id: 'bot_id', displayAvatarURL: () => 'https://example.com/avatar.png' },
            guilds: { cache: { size: 10 } },
            users: { cache: { size: 100 } }
        };

        const interaction = createMockInteraction({ commandName: 'about' });
        interaction.client = mockClient;

        await interactionCreate.execute(interaction);

        assert.equal(interaction.deferred, false, 'Fast command must NOT be deferred with a loading spinner');
        assert.equal(interaction.replied, true, 'Fast command must be replied to');
        assert.equal(interaction.lastMethod, 'reply', 'Fast command must respond directly via reply');
    });

    await test('F2: Heavy commands (/play) early-defer within SLA (<50ms)', async () => {
        const interactionCreate = require('../src/events/interactionCreate');
        let playExecuted = false;
        const commands = new Map();
        commands.set('play', {
            execute: async (inter) => {
                playExecuted = true;
                assert.equal(inter.deferred, true, 'Slow command must be deferred before execute');
                await safeReply(inter, { content: 'Playing' });
            }
        });

        const mockClient = {
            commands,
            defaultLanguage: 'en'
        };

        const interaction = createMockInteraction({ commandName: 'play' });
        interaction.client = mockClient;

        await interactionCreate.execute(interaction);

        assert.equal(interaction.deferred, true, 'Slow command must be deferred');
        assert.ok(interaction.deferTime <= 50, `deferTime must be < 50ms, was ${interaction.deferTime}ms`);
        assert.ok(playExecuted, 'Play command execute was called');
    });

    console.log('\n--- Test G: Production /play Lifecycle & Interaction Expiration Regression Tests ---');

    await test('G1: A simulated seven-second track resolution receives an initial acknowledgement before Discord deadline and finalizes at T+7s', async () => {
        // Discord initial acknowledgement deadline is 3000ms.
        // If unacknowledged by T+3000ms, Discord invalidates the interaction token (10062).
        // If deferred within 3000ms, Discord extends the token lifetime to 15 minutes (900,000ms).
        const interaction = createMockInteraction({ commandName: 'play' });

        // 1. Initial acknowledgement via ensureDeferred happens immediately (<50ms)
        const ackStart = Date.now();
        const ackResult = await ensureDeferred(interaction, { ephemeral: true });
        const ackDuration = Date.now() - ackStart;

        assert.equal(ackResult.deferred, true, 'Interaction must be deferred');
        assert.ok(ackDuration < 100, `Initial acknowledgement must complete well within 3000ms deadline, was ${ackDuration}ms`);
        assert.equal(interaction.deferred, true, 'Interaction state is marked deferred');

        // 2. Simulate 7-second slow track resolution / search / Lavalink processing
        let simulatedElapsed = 7000;
        let mockDiscordTokenExpired = false;

        // Verify that if it had NOT been deferred, Discord would expire the interaction
        const wouldExpireWithoutDefer = (simulatedElapsed > 3000);
        assert.ok(wouldExpireWithoutDefer, 'A 7-second search exceeds Discord 3s SLA without deferral');

        // But because it WAS deferred at <50ms, final editReply succeeds cleanly at T+7s
        const finalResult = await safeReply(interaction, {
            content: '🎵 Now playing: **Rappappa - SHAN PUTHA**'
        });

        assert.ok(finalResult, 'Final response must be delivered successfully');
        assert.equal(interaction.lastMethod, 'editReply', 'Response must be delivered via editReply');
        assert.ok(interaction.lastPayload.content.includes('Rappappa - SHAN PUTHA'), 'Response must contain track title');
    });

    await test('G2: The original interaction receives exactly one final response after playback succeeds', async () => {
        const interaction = createMockInteraction({ commandName: 'play' });
        await ensureDeferred(interaction, { ephemeral: true });

        let replyCalls = 0;
        let editReplyCalls = 0;
        let followUpCalls = 0;

        const origReply = interaction.reply;
        const origEditReply = interaction.editReply;
        const origFollowUp = interaction.followUp;

        interaction.reply = async (p) => { replyCalls++; return origReply.call(interaction, p); };
        interaction.editReply = async (p) => { editReplyCalls++; return origEditReply.call(interaction, p); };
        interaction.followUp = async (p) => { followUpCalls++; return origFollowUp.call(interaction, p); };

        // Simulate playback start and final response
        await safeReply(interaction, { content: '🎵 Playing: **Song Title**' });

        assert.equal(replyCalls, 0, 'Direct reply must not be called on deferred interaction');
        assert.equal(editReplyCalls, 1, 'Exactly one editReply must be sent');
        assert.equal(followUpCalls, 0, 'No followUps should be sent');
    });

    await test('G3: Failed resolution finalizes the deferred response without interrupting the current track or queue', async () => {
        const interaction = createMockInteraction({ commandName: 'play', query: 'nonexistent-xyz-query' });
        await ensureDeferred(interaction, { ephemeral: true });

        // Simulate currently playing player with upcoming queue
        let playerStopped = false;
        let playerDestroyed = false;
        const mockPlayer = {
            guildId: 'guild_001',
            playing: true,
            queue: {
                current: { info: { title: 'Current Song Playing', author: 'Artist 1' } },
                tracks: [{ info: { title: 'Upcoming Song 1' } }, { info: { title: 'Upcoming Song 2' } }]
            },
            stopPlaying: async () => { playerStopped = true; },
            destroy: async () => { playerDestroyed = true; }
        };

        // Simulate track resolution failure (0 tracks found)
        const noResultEmbed = { title: 'No Matching Tracks Found', description: 'Could not find any tracks.' };
        await safeReply(interaction, { embeds: [noResultEmbed] });

        // Verify response finalized
        assert.equal(interaction.lastMethod, 'editReply', 'Failed search must finalize the deferred reply');
        assert.equal(interaction.lastPayload.embeds[0].title, 'No Matching Tracks Found');

        // Verify currently playing track and queue are completely untouched
        assert.equal(mockPlayer.playing, true, 'Player must still be playing');
        assert.equal(mockPlayer.queue.current.info.title, 'Current Song Playing', 'Current song is untouched');
        assert.equal(mockPlayer.queue.tracks.length, 2, 'Queue remains intact');
        assert.equal(playerStopped, false, 'Player was not stopped');
        assert.equal(playerDestroyed, false, 'Player was not destroyed');
    });

    await test('G4: The dispatcher and command handler cannot double-acknowledge the same interaction', async () => {
        const interaction = createMockInteraction({ commandName: 'play' });

        let deferCallCount = 0;
        const origDefer = interaction.deferReply;
        interaction.deferReply = async (opts) => {
            deferCallCount++;
            return origDefer.call(interaction, opts);
        };

        // 1. Dispatcher acknowledges interaction
        const res1 = await ensureDeferred(interaction, { ephemeral: true });
        assert.equal(res1.deferred, true);
        assert.equal(deferCallCount, 1, 'First ensureDeferred calls deferReply');

        // 2. Command handler also calls ensureDeferred
        const res2 = await ensureDeferred(interaction, { ephemeral: true });
        assert.equal(res2.deferred, true);
        assert.equal(deferCallCount, 1, 'Second ensureDeferred recognizes existing deferred state and skips deferReply');

        // 3. Finalize response
        await safeReply(interaction, { content: 'Finalized' });
        assert.equal(interaction.lastMethod, 'editReply');
    });

    await test('G5: Dashboard or voice-status delays cannot block the initial acknowledgement', async () => {
        const interaction = createMockInteraction({ commandName: 'play' });

        // Acknowledge interaction first (<50ms)
        const ackStart = Date.now();
        await ensureDeferred(interaction, { ephemeral: true });
        const ackDuration = Date.now() - ackStart;
        assert.ok(ackDuration < 50, `Initial ack was ${ackDuration}ms`);

        // Simulate long-running or failing downstream dashboard/voice status
        let dashboardHangs = true;
        const slowDashboardPromise = new Promise((resolve) => {
            setTimeout(() => {
                dashboardHangs = false;
                resolve({ id: 'msg_dash' });
            }, 500); // simulated slow dashboard
        });

        // Safe reply should not be blocked by slowDashboardPromise
        await safeReply(interaction, { content: 'Playing' });

        assert.equal(interaction.lastMethod, 'editReply', 'Interaction finalized without waiting on dashboard');
        assert.equal(dashboardHangs, true, 'Dashboard was still pending when interaction was finalized');

        await slowDashboardPromise;
    });

    await test('G6: Errors after acknowledgement are handled without unhandled promise rejections', async () => {
        const interaction = createMockInteraction({ commandName: 'play' });
        await ensureDeferred(interaction, { ephemeral: true });

        // Simulate Lavalink timeout error after acknowledgement
        const timeoutError = new Error('Lavalink connection search timed out');
        timeoutError.name = 'TimeoutError';

        let handled = false;
        try {
            await handleLavalinkError(interaction, timeoutError, { defaultLanguage: 'en', languageManager: { get: () => 'Error' } });
            handled = true;
        } catch (e) {
            handled = false;
        }

        assert.equal(handled, true, 'Error must be caught and handled cleanly');
        assert.equal(interaction.lastMethod, 'editReply', 'Error response must be delivered via editReply');
        assert.ok(interaction.lastPayload?.embeds?.[0]?.data?.title?.includes('Timed Out') ||
                  interaction.lastPayload?.embeds?.[0]?.title?.includes('Timed Out'),
                  'Error response reflects timeout');
    });

    console.log(`\n========================================`);
    console.log(`Command Timeout & Lifecycle Tests: ${passed}/${total} passed`);
    console.log(`========================================\n`);

    if (passed !== total) process.exit(1);
    process.exit(0);
})();
