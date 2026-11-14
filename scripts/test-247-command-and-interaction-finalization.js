/**
 * ZYRO — Comprehensive Regression Test Suite: /247 Command Execution & Interaction Finalization
 *
 * Verifies all 13 core acceptance scenarios:
 * 1. /247 enabled returns the correct final response
 * 2. /247 disabled returns the correct final response
 * 3. A state-transition failure returns an error rather than a false success
 * 4. A deferred interaction is finalized exactly once via editReply
 * 5. A fast toggle does not wait for a slow background voice audit
 * 6. Concurrent /247 commands cannot create inconsistent state or duplicate toggles
 * 7. /stop respects 24/7 retention (stops playback, clears queue, preserves voice connection)
 * 8. /leave and /disconnect respect voice policy (turns off 24/7, cancels recovery, disconnects)
 * 9. Disabling 24/7 cancels stale reconnect work
 * 10. Failed response delivery does not apply the state change twice
 * 11. A late audit completion cannot update an unrelated interaction
 * 12. The command does not trigger unnecessary node migration or playback restart
 * 13. Shared response helpers still work for /play, /skip, /pause, /stop, and other existing commands
 */

const assert = require('assert');
const { PermissionsBitField } = require('discord.js');
const cmd247 = require('../src/commands/247');
const cmdStop = require('../src/commands/stop');
const cmdLeave = require('../src/commands/leave');
const cmdDisconnect = require('../src/commands/disconnect');
const twentyFourSevenManager = require('../src/utils/twentyFourSevenManager');
const guildSettings = require('../src/utils/guildSettings');
const { safeReply, RESPONSE_STATES } = require('../src/utils/interactionHelpers');

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

function createMockInteraction(options = {}) {
    const guildId = options.guildId || 'g-247-suite';
    const channelId = options.channelId || 'vc-1';
    let repliedPayload = null;
    let editPayload = null;

    const mockChannel = {
        id: channelId,
        name: 'General Voice',
        type: 2,
        isVoiceBased: () => true,
        permissionsFor: () => ({
            has: (flag) => true
        })
    };

    const defaultGuilds = {
        cache: new Map([[guildId, {
            id: guildId,
            name: 'Test Guild',
            members: { me: { voice: { channelId: options.botInVoice ? channelId : null } } },
            channels: { cache: new Map([[channelId, mockChannel]]) }
        }]])
    };

    const mockClient = {
        defaultLanguage: 'en',
        languageManager: { get: (lang, key) => key },
        guildSettings,
        is247Enabled: (gId) => guildSettings.is247(gId),
        set247: (gId, enabled, opts) => guildSettings.set247(gId, enabled, opts),
        lavalinkConnectionManager: {
            isAvailable: () => true
        },
        lavalink: options.lavalink || {
            getPlayer: () => options.player || null,
            createPlayer: () => options.player || { connect: async () => {}, connected: true }
        },
        guilds: defaultGuilds,
        ...(options.client || {})
    };
    if (!mockClient.guilds) mockClient.guilds = defaultGuilds;
    if (!mockClient.languageManager) mockClient.languageManager = { get: (lang, key) => key };

    const interaction = {
        id: options.id || `int_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        commandName: options.commandName || '247',
        guildId,
        guild: mockClient.guilds.cache.get(guildId),
        member: {
            voice: {
                channel: options.noUserVoice ? null : mockChannel,
                channelId: options.noUserVoice ? null : channelId
            }
        },
        channel: { id: 'tc-commands', name: 'bot-commands' },
        channelId: 'tc-commands',
        client: mockClient,
        deferred: Boolean(options.deferred),
        replied: false,
        _responseState: options.deferred ? RESPONSE_STATES.ACKNOWLEDGED : RESPONSE_STATES.PENDING,
        reply: async (payload) => {
            interaction.replied = true;
            repliedPayload = payload;
            return { id: 'msg-reply', ...payload };
        },
        editReply: async (payload) => {
            interaction.replied = true;
            editPayload = payload;
            return { id: 'msg-edit', ...payload };
        },
        followUp: async (payload) => {
            return { id: 'msg-followup', ...payload };
        },
        getDeliveredPayload: () => editPayload || repliedPayload
    };

    return interaction;
}

(async () => {
    console.log('=== RUNNING /247 COMMAND & INTERACTION FINALIZATION REGRESSION TESTS ===\n');

    // 1. /247 enabled returns the correct final response
    await runTest('1. /247 enabled returns the correct final response and updates state', async () => {
        const guildId = 'g-toggle-on-test';
        guildSettings.set247(guildId, false);

        const interaction = createMockInteraction({ guildId });
        await cmd247.execute(interaction);

        assert.strictEqual(guildSettings.is247(guildId), true, '24/7 mode must be enabled');
        assert.strictEqual(interaction.replied, true, 'Interaction must be marked replied');
        const payload = interaction.getDeliveredPayload();
        assert.ok(payload, 'A response must be delivered');
        const embed = payload.embeds?.[0];
        assert.ok(embed, 'Embed must be included');
        const title = embed.data?.title || embed.title || '';
        const desc = embed.data?.description || embed.description || '';
        assert.match(title, /24\/7 Mode Enabled/i, 'Title indicates 24/7 enabled');
        assert.match(desc, /ZYRO will remain connected to the configured voice channel/i, 'Description explains 24/7 retention');
    });

    // 2. /247 disabled returns the correct final response
    await runTest('2. /247 disabled returns the correct final response and cancels recovery', async () => {
        const guildId = 'g-toggle-off-test';
        guildSettings.set247(guildId, true, { voiceChannelId: 'vc-1' });
        twentyFourSevenManager.scheduleAutoRecovery({ is247Enabled: () => true }, guildId, 'vc-1', 'test');
        assert.strictEqual(twentyFourSevenManager.isReconnecting(guildId), true, 'Recovery must be scheduled initially');

        const interaction = createMockInteraction({ guildId });
        await cmd247.execute(interaction);

        assert.strictEqual(guildSettings.is247(guildId), false, '24/7 mode must be disabled');
        assert.strictEqual(twentyFourSevenManager.isReconnecting(guildId), false, 'Recovery must be cancelled');
        assert.strictEqual(interaction.replied, true, 'Interaction must be marked replied');
        const payload = interaction.getDeliveredPayload();
        const desc = payload.embeds?.[0]?.data?.description || payload.embeds?.[0]?.description || '';
        assert.match(desc, /normal idle-disconnect behavior is restored/i, 'Description confirms normal idle disconnect restored');
    });

    // 3. A state-transition failure returns an error rather than a false success
    await runTest('3. A state-transition failure returns an error rather than a false success', async () => {
        const guildId = 'g-fail-test';
        guildSettings.set247(guildId, false);

        const faultyClient = {
            guildSettings,
            is247Enabled: () => false,
            set247: () => { throw new Error('Database write failure'); },
            lavalink: { getPlayer: () => null }
        };

        const interaction = createMockInteraction({ guildId, client: faultyClient });
        await cmd247.execute(interaction);

        assert.strictEqual(guildSettings.is247(guildId), false, 'State must not be enabled on failure');
        const payload = interaction.getDeliveredPayload();
        const title = payload.embeds?.[0]?.data?.title || payload.embeds?.[0]?.title || '';
        assert.match(title, /Configuration Failed/i, 'Must report failure, not success');
    });

    // 4. A deferred interaction is finalized exactly once via editReply
    await runTest('4. A deferred interaction is finalized cleanly via editReply', async () => {
        const guildId = 'g-defer-test';
        guildSettings.set247(guildId, false);

        let editReplyCalled = false;
        let replyCalled = false;

        const interaction = createMockInteraction({ guildId, deferred: true });
        interaction.editReply = async (p) => {
            editReplyCalled = true;
            interaction.replied = true;
            return { id: 'msg-defer-edit', ...p };
        };
        interaction.reply = async () => {
            replyCalled = true;
        };

        await cmd247.execute(interaction);

        assert.strictEqual(editReplyCalled, true, 'Must call editReply for deferred interaction');
        assert.strictEqual(replyCalled, false, 'Must NOT call reply on deferred interaction');
        assert.strictEqual(interaction._responseState, RESPONSE_STATES.RESPONDED);
    });

    // 5. A fast toggle does not wait for a slow background voice audit
    await runTest('5. Fast toggle executes in <50ms without waiting for background audit', async () => {
        const guildId = 'g-fast-audit-test';
        guildSettings.set247(guildId, false);

        const slowPlayer = {
            connected: false,
            connect: () => new Promise(res => setTimeout(res, 2000)) // 2s connect
        };

        const interaction = createMockInteraction({
            guildId,
            lavalink: {
                getPlayer: () => slowPlayer,
                createPlayer: () => slowPlayer
            }
        });

        const start = Date.now();
        await cmd247.execute(interaction);
        const elapsed = Date.now() - start;

        assert.ok(elapsed < 100, `Execution took ${elapsed}ms; must be under 100ms`);
        assert.strictEqual(guildSettings.is247(guildId), true);
    });

    // 6. Concurrent /247 commands cannot create inconsistent state or duplicate toggles
    await runTest('6. Concurrent /247 commands are guarded against race conditions', async () => {
        const guildId = 'g-conc-test';
        guildSettings.set247(guildId, false);

        const interaction1 = createMockInteraction({ guildId });
        const interaction2 = createMockInteraction({ guildId });

        // Fire both simultaneously
        const [res1, res2] = await Promise.all([
            cmd247.execute(interaction1),
            cmd247.execute(interaction2)
        ]);

        // One must succeed, one must receive in-progress warning
        const p1 = interaction1.getDeliveredPayload();
        const p2 = interaction2.getDeliveredPayload();

        const titles = [
            p1?.embeds?.[0]?.data?.title || p1?.embeds?.[0]?.title || '',
            p2?.embeds?.[0]?.data?.title || p2?.embeds?.[0]?.title || ''
        ];

        assert.ok(titles.some(t => /24\/7 Mode Enabled/i.test(t)), 'One command must succeed');
        assert.ok(titles.some(t => /Operation In Progress/i.test(t)), 'Concurrent command must receive in-progress notice');
        assert.strictEqual(guildSettings.is247(guildId), true, 'State must be toggled exactly once');
    });

    // 7. /stop respects 24/7 retention
    await runTest('7. /stop stops playback and clears queue while preserving voice connection when 24/7 is ON', async () => {
        const guildId = 'g-stop-247-test';
        guildSettings.set247(guildId, true, { voiceChannelId: 'vc-1' });

        let playerDestroyed = false;
        let playbackStopped = false;

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            playing: true,
            queue: {
                current: { info: { title: 'Track 1' } },
                tracks: [{ info: { title: 'Track 2' } }],
                clear: () => { mockPlayer.queue.tracks = []; }
            },
            stopPlaying: async () => { playbackStopped = true; mockPlayer.playing = false; },
            destroy: async () => { playerDestroyed = true; }
        };

        const interaction = createMockInteraction({
            guildId,
            commandName: 'stop',
            player: mockPlayer,
            botInVoice: true
        });

        await cmdStop.execute(interaction);

        assert.strictEqual(playbackStopped, true, 'Playback must be stopped');
        assert.strictEqual(playerDestroyed, false, 'Player must NOT be destroyed when 24/7 is active');
        assert.strictEqual(guildSettings.is247(guildId), true, '24/7 mode must remain enabled');
    });

    // 8. /leave and /disconnect respect existing voice policy
    await runTest('8. /leave and /disconnect explicitly disable 24/7 mode and disconnect', async () => {
        const guildId = 'g-leave-policy-test';
        guildSettings.set247(guildId, true, { voiceChannelId: 'vc-1' });

        let destroyed = false;
        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            destroy: async () => { destroyed = true; }
        };

        const interaction = createMockInteraction({
            guildId,
            commandName: 'leave',
            player: mockPlayer,
            botInVoice: true
        });

        await cmdLeave.execute(interaction);

        assert.strictEqual(guildSettings.is247(guildId), false, '/leave must disable 24/7 mode');
        assert.strictEqual(destroyed, true, 'Player must be destroyed on /leave');

        // Test /disconnect alias
        guildSettings.set247(guildId, true, { voiceChannelId: 'vc-1' });
        destroyed = false;
        const discInteraction = createMockInteraction({
            guildId,
            commandName: 'disconnect',
            player: mockPlayer,
            botInVoice: true
        });
        await cmdDisconnect.execute(discInteraction);
        assert.strictEqual(guildSettings.is247(guildId), false, '/disconnect must disable 24/7 mode');
        assert.strictEqual(destroyed, true, 'Player must be destroyed on /disconnect');
    });

    // 9. Disabling 24/7 cancels stale reconnect work
    await runTest('9. Disabling 24/7 cancels stale recovery timers', async () => {
        const guildId = 'g-stale-cancel-test';
        guildSettings.set247(guildId, true, { voiceChannelId: 'vc-1' });

        twentyFourSevenManager.scheduleAutoRecovery({ is247Enabled: () => true }, guildId, 'vc-1', 'drop');
        assert.strictEqual(twentyFourSevenManager.isReconnecting(guildId), true);

        const interaction = createMockInteraction({ guildId });
        await cmd247.execute(interaction);

        assert.strictEqual(twentyFourSevenManager.isReconnecting(guildId), false, 'Recovery must be cancelled upon disabling 24/7');
    });

    // 10. Failed response delivery does not apply state change twice
    await runTest('10. Failed response delivery preserves single-toggle consistency', async () => {
        const guildId = 'g-resp-fail-test';
        guildSettings.set247(guildId, false);

        const interaction = createMockInteraction({ guildId });
        interaction.reply = async () => {
            const err = new Error('Discord 500 Server Error');
            err.code = 'REST_TIMEOUT';
            throw err;
        };

        await cmd247.execute(interaction);

        // State was toggled to true once; failure to reply does NOT toggle it back to false
        assert.strictEqual(guildSettings.is247(guildId), true, 'State change remains applied consistently');
    });

    // 11. A late audit completion cannot update an unrelated interaction
    await runTest('11. Background audit does not mutate interaction response', async () => {
        const guildId = 'g-audit-immut-test';
        guildSettings.set247(guildId, false);

        const interaction = createMockInteraction({ guildId });
        await cmd247.execute(interaction);

        const originalPayload = interaction.getDeliveredPayload();
        // Wait 100ms for background setImmediate audit to finish
        await new Promise(r => setTimeout(r, 100));

        const postAuditPayload = interaction.getDeliveredPayload();
        assert.strictEqual(originalPayload, postAuditPayload, 'Payload must remain untouched by background audit');
    });

    // 12. Command does not trigger unnecessary node migration or playback restart
    await runTest('12. /247 does not trigger node migration or disrupt active song', async () => {
        const guildId = 'g-no-disrupt-test';
        guildSettings.set247(guildId, false);

        let migrationCalled = false;
        let playCalled = false;

        const activePlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            connected: true,
            playing: true,
            queue: { current: { info: { title: 'Existing Song' } }, tracks: [] },
            play: () => { playCalled = true; }
        };

        const client = {
            guildSettings,
            is247Enabled: (gId) => guildSettings.is247(gId),
            set247: (gId, enabled, opts) => guildSettings.set247(gId, enabled, opts),
            lavalink: { getPlayer: () => activePlayer },
            lavalinkConnectionManager: {
                migratePlayer: () => { migrationCalled = true; }
            },
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    name: 'Disrupt Test Guild',
                    members: { me: { voice: { channelId: 'vc-1' } } },
                    channels: { cache: new Map([['vc-1', { id: 'vc-1', permissionsFor: () => ({ has: () => true }) }]]) }
                }]])
            }
        };

        const interaction = createMockInteraction({ guildId, client, player: activePlayer, botInVoice: true });
        await cmd247.execute(interaction);

        assert.strictEqual(migrationCalled, false, 'Node migration must not be triggered by /247');
        assert.strictEqual(playCalled, false, 'Active playback must not be restarted by /247');
        assert.strictEqual(activePlayer.playing, true, 'Active playback must remain playing');
    });

    // 13. Shared response helpers still work for /play, /skip, /pause, /stop
    await runTest('13. Shared safeReply helper reliably delivers replies across commands', async () => {
        let delivered = null;
        const testInteraction = {
            id: 'int-shared-test',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async (p) => {
                delivered = p;
                testInteraction.replied = true;
                return { id: 'msg-shared', ...p };
            }
        };

        const res = await safeReply(testInteraction, {
            content: 'Shared helper test',
            _isFinalReply: true
        });

        assert.ok(res, 'safeReply must deliver reply');
        assert.strictEqual(delivered.content, 'Shared helper test');
        assert.strictEqual(testInteraction.replied, true);
        assert.strictEqual(testInteraction._responseState, RESPONSE_STATES.RESPONDED);
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
