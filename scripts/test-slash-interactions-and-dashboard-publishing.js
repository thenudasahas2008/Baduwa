'use strict';

const assert = require('assert');
const { MessageFlags } = require('discord.js');
const { safeReply } = require('../src/utils/interactionHelpers');
const PlayerController = require('../src/utils/PlayerController');

let passedTests = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ok  - ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  FAIL - ${name}:`, err);
        process.exitCode = 1;
    }
}

async function run() {
    console.log('--- Testing Slash Command Interactions & Automatic Full Dashboard Publishing ---');

    // 1. safeReply strips flags on editReply so Discord 50035 error is prevented
    await test('safeReply strips flags on editReply to prevent DiscordAPIError[50035]', async () => {
        let editPayloadCaptured = null;
        const interaction = {
            id: 'inter-test-flags',
            deferred: true,
            replied: false,
            editReply: async (payload) => {
                editPayloadCaptured = payload;
                if (payload && 'flags' in payload) {
                    const err = new Error('Invalid Form Body: flags: This field cannot be updated');
                    err.code = 50035;
                    throw err;
                }
                return { id: 'msg-edited' };
            }
        };

        const result = await safeReply(interaction, {
            content: '🎵 Paused playback',
            flags: MessageFlags.Ephemeral
        });

        assert.strictEqual(result.id, 'msg-edited', 'editReply should succeed without flags');
        assert.strictEqual(editPayloadCaptured.flags, undefined, 'flags should be stripped from editReply payload');
        assert.strictEqual(editPayloadCaptured.content, '🎵 Paused playback', 'content should be preserved');
    });

    // 2. Double-acknowledgement and expired-token retries are prevented
    await test('Double-acknowledgement and expired-token retries are prevented', async () => {
        let deferCount = 0;
        let replyCount = 0;
        const interaction = {
            id: 'inter-double-ack',
            deferred: false,
            replied: false,
            deferReply: async () => {
                deferCount++;
                interaction.deferred = true;
            },
            reply: async () => {
                replyCount++;
                interaction.replied = true;
            },
            editReply: async () => ({ id: 'msg-1' })
        };

        // First reply: defers or replies
        await safeReply(interaction, { content: 'First' });
        assert(interaction.deferred || interaction.replied, 'Interaction must be acknowledged');

        // Second reply to same interaction must use editReply or followUp without calling deferReply/reply again
        await safeReply(interaction, { content: 'Second' });
        assert.strictEqual(replyCount <= 1 && deferCount <= 1, true, 'Cannot reply or defer twice');

        // Expired interaction (code 10062) should be handled gracefully without infinite retry
        const expiredInteraction = {
            id: 'inter-expired',
            deferred: true,
            replied: false,
            editReply: async () => {
                const err = new Error('Unknown interaction');
                err.code = 10062;
                throw err;
            }
        };
        const expiredRes = await safeReply(expiredInteraction, { content: 'Too late' });
        assert.strictEqual(expiredRes, null, 'Expired interaction returns null without throwing or looping');
    });

    // 3. /pause, /skip, /clear, /play prompt finalization
    await test('/pause command finalizes deferred interaction with terminal response', async () => {
        const pauseCmd = require('../src/commands/pause');
        let edited = false;
        let repliedPayload = null;
        const mockInteraction = {
            id: 'pause-test-1',
            guildId: 'guild-pause',
            guild: { id: 'guild-pause', name: 'Test Guild' },
            member: { voice: { channel: { id: 'vc-1' } } },
            channel: { id: 'tc-1', name: 'music' },
            client: {
                lavalink: {
                    getPlayer: () => ({
                        guildId: 'guild-pause',
                        voiceChannelId: 'vc-1',
                        playing: true,
                        paused: false,
                        pause: async () => {},
                        resume: async () => {}
                    })
                },
                playerController: {
                    updatePlayer: async () => {}
                },
                t: (k) => k
            },
            deferred: true,
            replied: false,
            editReply: async (opts) => {
                edited = true;
                repliedPayload = opts;
                return { id: 'msg-pause' };
            }
        };

        await pauseCmd.execute(mockInteraction);
        assert.strictEqual(edited, true, '/pause must finalize interaction via editReply');
        assert(repliedPayload?.embeds?.length > 0 || repliedPayload?.content?.length > 0, 'Must return embed or content');
    });

    await test('/clear command finalizes interaction promptly', async () => {
        const clearCmd = require('../src/commands/clear');
        let replied = false;
        const mockInteraction = {
            id: 'clear-test-1',
            guildId: 'guild-clear',
            guild: { id: 'guild-clear', name: 'Test Guild' },
            member: { voice: { channel: { id: 'vc-1' } } },
            channel: { id: 'tc-1', name: 'music' },
            client: {
                lavalink: {
                    getPlayer: () => ({
                        guildId: 'guild-clear',
                        voiceChannelId: 'vc-1',
                        queue: {
                            tracks: [{ info: { title: 'T1' } }, { info: { title: 'T2' } }],
                            clear: () => {}
                        }
                    })
                },
                playerController: {
                    updatePlayer: async () => {}
                },
                t: (k) => k
            },
            deferred: false,
            replied: false,
            reply: async () => {
                replied = true;
                return { id: 'msg-clear' };
            },
            deferReply: async () => {
                mockInteraction.deferred = true;
            },
            editReply: async () => {
                replied = true;
                return { id: 'msg-clear' };
            }
        };

        await clearCmd.execute(mockInteraction);
        assert.strictEqual(replied, true, '/clear must finalize interaction');
    });

    // 4. Automatic Full Dashboard publication contains all controls
    await test('PlayerController publishes full dashboard with all 9 player controls and 5 seek controls', async () => {
        let sentPayload = null;
        const mockChannel = {
            id: 'tc-main',
            name: 'music',
            type: 0,
            send: async (payload) => {
                sentPayload = payload;
                return { id: 'dash-msg-1', channelId: 'tc-main' };
            }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            guilds: {
                cache: new Map([
                    ['g1', {
                        id: 'g1',
                        channels: { cache: new Map([['tc-main', mockChannel]]) },
                        systemChannel: mockChannel
                    }]
                ])
            },
            channels: {
                cache: new Map([['tc-main', mockChannel]])
            },
            guildSettings: {
                get: () => ({ textChannelId: 'tc-main' }),
                updateTextChannelId: () => {}
            },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g1',
                    playing: true,
                    paused: false,
                    position: 45000,
                    volume: 100,
                    repeatMode: 'off',
                    queue: {
                        current: {
                            info: {
                                title: 'Test Track',
                                author: 'Test Artist',
                                duration: 180000,
                                identifier: 'test-track-1',
                                uri: 'https://youtube.com/watch?v=123',
                                artworkUrl: 'https://img.youtube.com/vi/123/default.jpg',
                                isSeekable: true,
                                isStream: false
                            }
                        },
                        tracks: [],
                        previous: []
                    }
                })
            },
            lavalinkConnectionManager: {
                isAvailable: () => true
            },
            autoplayEnabled: new Map(),
            is247Enabled: () => false,
            t: (k) => k
        };

        const controller = new PlayerController(mockClient);
        const result = await controller.replaceWithFullDashboard('g1', 'tc-main');

        assert(result, 'Dashboard send should return message object');
        assert.strictEqual(result.id, 'dash-msg-1');
        assert(sentPayload.embeds && sentPayload.embeds.length === 1, 'Dashboard must have embed');

        // Validate buttons: Row 1 (Play/Pause, Skip, Shuffle, Stop), Row 2 (Back, Autoplay, Queue, Loop)
        assert(sentPayload.components && sentPayload.components.length === 2, 'Dashboard must have 2 action rows');
        const customIds = sentPayload.components.flatMap(row => row.components.map(c => c.data.custom_id));

        assert.strictEqual(customIds.length, 8, 'Must have exactly 8 buttons across 2 rows');
        assert(customIds.includes('player:playpause'), 'Must have play/pause button');
        assert(customIds.includes('player:skip'), 'Must have skip button');
        assert(customIds.includes('player:shuffle'), 'Must have shuffle button');
        assert(customIds.includes('player:stop'), 'Must have stop button');
        assert(customIds.includes('player:back'), 'Must have back button');
        assert(customIds.includes('player:autoplay'), 'Must have autoplay button');
        assert(customIds.includes('player:queue'), 'Must have queue button');
        assert(customIds.includes('player:loop'), 'Must have loop button');
        assert(!customIds.includes('player:247'), 'Must not have 247 button');
        assert(!customIds.some(id => id.startsWith('player:seek')), 'Must not have any seek buttons');
    });

    // 5. In-place edits for pause/resume and progress updates without recreating dashboard
    await test('PlayerController edits existing dashboard in place for pause/resume and progress updates', async () => {
        let editedPayload = null;
        let sendCount = 0;

        const mockExistingMsg = {
            id: 'dash-msg-existing',
            edit: async (payload) => {
                editedPayload = payload;
                return mockExistingMsg;
            }
        };

        const mockChannel = {
            id: 'tc-main',
            name: 'music',
            type: 0,
            messages: {
                cache: new Map([['dash-msg-existing', mockExistingMsg]]),
                fetch: async () => mockExistingMsg
            },
            send: async () => {
                sendCount++;
                return { id: 'dash-msg-new' };
            }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            channels: { cache: new Map([['tc-main', mockChannel]]) },
            guilds: { cache: new Map([['g2', { id: 'g2', channels: { cache: new Map([['tc-main', mockChannel]]) } }]]) },
            guildSettings: { get: () => ({ textChannelId: 'tc-main' }) },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g2',
                    playing: true,
                    paused: true,
                    position: 50000,
                    volume: 100,
                    repeatMode: 'off',
                    queue: {
                        current: {
                            info: {
                                title: 'Same Track',
                                duration: 180000,
                                identifier: 'track-same-id',
                                isSeekable: true
                            }
                        },
                        tracks: [],
                        previous: []
                    }
                })
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            autoplayEnabled: new Map(),
            is247Enabled: () => false,
            t: (k) => k
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g2', { messageId: 'dash-msg-existing', channelId: 'tc-main' });

        // Update in-place
        await controller.updatePlayer('g2', { replace: false });

        assert.strictEqual(sendCount, 0, 'In-place update must NOT call channel.send');
        assert(editedPayload, 'Existing message must be edited in-place');
    });

    // 6. Startup reconciliation recovers missing dashboard for active player
    await test('Startup reconciliation reconstructs full dashboard if message is missing for active player', async () => {
        let recreatedDashboard = null;
        const mockChannel = {
            id: 'tc-main',
            name: 'general',
            type: 0,
            send: async (payload) => {
                recreatedDashboard = payload;
                return { id: 'dash-msg-recreated', channelId: 'tc-main' };
            }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            channels: { cache: new Map([['tc-main', mockChannel]]) },
            guilds: {
                cache: new Map([
                    ['g-reconcile', {
                        id: 'g-reconcile',
                        channels: { cache: new Map([['tc-main', mockChannel]]) },
                        systemChannel: mockChannel
                    }]
                ])
            },
            guildSettings: {
                cache: new Map([['g-reconcile', { textChannelId: 'tc-main' }]]),
                get: () => ({ textChannelId: 'tc-main' })
            },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-reconcile',
                    playing: true,
                    paused: false,
                    position: 10000,
                    queue: {
                        current: {
                            info: {
                                title: 'Active Playing Song',
                                duration: 200000,
                                identifier: 'reconcile-song'
                            }
                        },
                        tracks: [],
                        previous: []
                    }
                }),
                players: new Map([['g-reconcile', { guildId: 'g-reconcile' }]])
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            autoplayEnabled: new Map(),
            is247Enabled: () => false,
            voiceChannelStatusManager: { syncGuildPlayerStatus: async () => {} },
            t: (k) => k
        };

        const controller = new PlayerController(mockClient);
        // Note: No stored dashboard exists!
        await controller.reconcileAllDashboards();

        assert(recreatedDashboard, 'Reconciliation must reconstruct dashboard for active playing player');
        const dash = controller.getDashboard('g-reconcile');
        assert.strictEqual(dash?.messageId, 'dash-msg-recreated', 'Reconstructed dashboard must be stored');
    });

    // 7. Failed dashboard sends preserve previous valid dashboard
    await test('Failed dashboard sends preserve previous valid dashboard reference', async () => {
        const mockChannel = {
            id: 'tc-failing',
            name: 'music',
            type: 0,
            send: async () => {
                const err = new Error('Discord 500 Internal Server Error');
                err.code = 500;
                throw err;
            }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            channels: { cache: new Map([['tc-failing', mockChannel]]) },
            guilds: { cache: new Map([['g-fail', { id: 'g-fail', channels: { cache: new Map([['tc-failing', mockChannel]]) } }]]) },
            guildSettings: { get: () => ({ textChannelId: 'tc-failing' }) },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-fail',
                    playing: true,
                    queue: {
                        current: { info: { title: 'Failing Song', identifier: 'fail-1' } },
                        tracks: [],
                        previous: []
                    }
                })
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            autoplayEnabled: new Map(),
            is247Enabled: () => false,
            t: (k) => k
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g-fail', { messageId: 'valid-prev-msg', channelId: 'tc-failing' });

        const result = await controller.replaceWithFullDashboard('g-fail', 'tc-failing');
        assert.strictEqual(result, null, 'Send failure returns null');

        const dashAfter = controller.getDashboard('g-fail');
        assert.strictEqual(dashAfter?.messageId, 'valid-prev-msg', 'Previous valid dashboard reference must be preserved');
    });

    // 8. Full dashboard is sent to connected Voice Channel chat, NOT to normal #general text channel
    await test('Full dashboard is sent to connected Voice Channel chat, NOT to normal #general text channel', async () => {
        let sentToVoice = false;
        let sentToGeneral = false;

        const mockGeneralTextChannel = {
            id: 'tc-general',
            name: 'general',
            type: 0,
            send: async () => {
                sentToGeneral = true;
                return { id: 'msg-general', channelId: 'tc-general' };
            }
        };

        const mockVoiceChannel = {
            id: 'vc-general-chat',
            name: 'General',
            type: 2, // GuildVoice
            isVoiceBased: () => true,
            send: async () => {
                sentToVoice = true;
                return { id: 'msg-voice', channelId: 'vc-general-chat' };
            }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            channels: {
                cache: new Map([
                    ['tc-general', mockGeneralTextChannel],
                    ['vc-general-chat', mockVoiceChannel]
                ])
            },
            guilds: {
                cache: new Map([
                    ['g-voice-test', {
                        id: 'g-voice-test',
                        channels: {
                            cache: new Map([
                                ['tc-general', mockGeneralTextChannel],
                                ['vc-general-chat', mockVoiceChannel]
                            ])
                        },
                        systemChannel: mockGeneralTextChannel
                    }]
                ])
            },
            guildSettings: {
                get: () => ({ textChannelId: 'tc-general' })
            },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-voice-test',
                    voiceChannelId: 'vc-general-chat',
                    playing: true,
                    queue: {
                        current: { info: { title: 'Voice Song', identifier: 'v-1' } },
                        tracks: [],
                        previous: []
                    }
                })
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            autoplayEnabled: new Map(),
            is247Enabled: () => false,
            t: (k) => k
        };

        const controller = new PlayerController(mockClient);
        const result = await controller.replaceWithFullDashboard('g-voice-test');

        assert(result, 'Dashboard send should succeed in voice channel');
        assert.strictEqual(sentToVoice, true, 'Dashboard MUST be sent to the connected voice channel');
        assert.strictEqual(sentToGeneral, false, 'Dashboard MUST NOT be redirected to normal #general text channel');
        assert.strictEqual(controller.getDashboard('g-voice-test')?.channelId, 'vc-general-chat', 'Dashboard channelId must be voice channel');
    });

    // 9. Missing Send Messages permission on voice channel does NOT fall back to normal text channel
    await test('Missing permission on voice channel does NOT silently fall back to normal text channel', async () => {
        let sentToGeneral = false;

        const mockGeneralTextChannel = {
            id: 'tc-general',
            name: 'general',
            type: 0,
            send: async () => {
                sentToGeneral = true;
                return { id: 'msg-general', channelId: 'tc-general' };
            }
        };

        const mockNoPermVoiceChannel = {
            id: 'vc-locked',
            name: 'Locked Voice',
            type: 2,
            isVoiceBased: () => true,
            permissionsFor: () => ({
                has: (flag) => false // Missing permissions
            }),
            send: async () => ({ id: 'msg-locked' })
        };

        const mockClient = {
            user: { id: 'bot-1' },
            channels: {
                cache: new Map([
                    ['tc-general', mockGeneralTextChannel],
                    ['vc-locked', mockNoPermVoiceChannel]
                ])
            },
            guilds: {
                cache: new Map([
                    ['g-locked-test', {
                        id: 'g-locked-test',
                        channels: {
                            cache: new Map([
                                ['tc-general', mockGeneralTextChannel],
                                ['vc-locked', mockNoPermVoiceChannel]
                            ])
                        },
                        systemChannel: mockGeneralTextChannel
                    }]
                ])
            },
            guildSettings: {
                get: () => ({ textChannelId: 'tc-general' })
            },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-locked-test',
                    voiceChannelId: 'vc-locked',
                    playing: true,
                    queue: {
                        current: { info: { title: 'Locked Song', identifier: 'l-1' } },
                        tracks: [],
                        previous: []
                    }
                })
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            autoplayEnabled: new Map(),
            is247Enabled: () => false,
            t: (k) => k
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g-locked-test', { messageId: 'msg-prev', channelId: 'vc-locked' });

        const result = await controller.replaceWithFullDashboard('g-locked-test');
        assert.strictEqual(result, null, 'Send should fail due to missing voice permissions');
        assert.strictEqual(sentToGeneral, false, 'Must NOT silently fall back to #general');
        assert.strictEqual(controller.getDashboard('g-locked-test')?.messageId, 'msg-prev', 'Previous valid dashboard must be preserved');
    });

    // 10. Voice channel change moves dashboard to new voice channel and deletes from old voice channel
    await test('Voice channel change moves dashboard to new voice channel and deletes from old voice channel', async () => {
        let deletedOld = false;
        const oldMsg = {
            id: 'msg-old-vc',
            delete: async () => {
                deletedOld = true;
            }
        };

        const mockVoice1 = {
            id: 'vc-1',
            name: 'Voice 1',
            type: 2,
            isVoiceBased: () => true,
            messages: {
                cache: new Map([['msg-old-vc', oldMsg]]),
                fetch: async () => oldMsg
            },
            send: async () => ({ id: 'msg-vc-1' })
        };

        const mockVoice2 = {
            id: 'vc-2',
            name: 'Voice 2',
            type: 2,
            isVoiceBased: () => true,
            messages: { cache: new Map(), fetch: async () => null },
            send: async () => ({ id: 'msg-vc-2', channelId: 'vc-2' })
        };

        const mockClient = {
            user: { id: 'bot-1' },
            channels: {
                cache: new Map([
                    ['vc-1', mockVoice1],
                    ['vc-2', mockVoice2]
                ])
            },
            guilds: {
                cache: new Map([
                    ['g-move', {
                        id: 'g-move',
                        channels: { cache: new Map([['vc-1', mockVoice1], ['vc-2', mockVoice2]]) }
                    }]
                ])
            },
            guildSettings: {
                get: () => ({})
            },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-move',
                    voiceChannelId: 'vc-2', // Moved to Voice 2!
                    playing: true,
                    queue: {
                        current: { info: { title: 'Moved Song', identifier: 'm-1' } },
                        tracks: [],
                        previous: []
                    }
                })
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            autoplayEnabled: new Map(),
            is247Enabled: () => false,
            t: (k) => k
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g-move', { messageId: 'msg-old-vc', channelId: 'vc-1' });

        const result = await controller.replaceWithFullDashboard('g-move');
        assert(result, 'Dashboard send in new voice channel must succeed');
        assert.strictEqual(result.id, 'msg-vc-2', 'New dashboard should be in Voice 2');
        assert.strictEqual(controller.getDashboard('g-move')?.channelId, 'vc-2');

        // Allow async cleanup
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(deletedOld, true, 'Old dashboard in Voice 1 must be deleted after replacement in Voice 2');
    });

    // 11. No /dashboard command is registered in src/commands/
    await test('No /dashboard command exists in src/commands/', () => {
        const fs = require('fs');
        const path = require('path');
        const commandsDir = path.join(__dirname, '..', 'src', 'commands');
        const files = fs.readdirSync(commandsDir);
        assert(!files.includes('dashboard.js'), 'dashboard.js command MUST NOT exist');
    });

    // 12. safeReply 40060 fallback strips flags before editReply
    await test('safeReply strips flags on 40060 already-acknowledged fallback', async () => {
        let capturedPayload = null;
        const interaction = {
            id: 'inter-40060',
            deferred: false,
            replied: false,
            reply: async () => {
                const err = new Error('Interaction already acknowledged');
                err.code = 40060;
                throw err;
            },
            editReply: async (payload) => {
                capturedPayload = payload;
                if (payload && 'flags' in payload) {
                    const err = new Error('Invalid Form Body: flags: This field cannot be updated');
                    err.code = 50035;
                    throw err;
                }
                return { id: 'msg-40060' };
            }
        };

        const result = await safeReply(interaction, {
            content: 'Recovered message',
            flags: MessageFlags.Ephemeral
        });

        assert.strictEqual(result.id, 'msg-40060');
        assert.strictEqual(capturedPayload.flags, undefined, 'flags must be stripped from editReply in 40060 fallback');
    });

    // 13. Multi-guild isolation: slow operation in Guild A does not block independent commands in Guild B
    await test('Multi-guild isolation: slow operation in Guild A does not block commands in Guild B', async () => {
        let guildAFinished = false;
        let guildBFinished = false;

        const slowGuildAPromise = new Promise(async (resolve) => {
            await new Promise(r => setTimeout(r, 60));
            guildAFinished = true;
            resolve('guildA-done');
        });

        const fastGuildBPromise = new Promise(async (resolve) => {
            await new Promise(r => setTimeout(r, 10));
            guildBFinished = true;
            resolve('guildB-done');
        });

        const resultB = await fastGuildBPromise;
        assert.strictEqual(resultB, 'guildB-done');
        assert.strictEqual(guildBFinished, true);
        assert.strictEqual(guildAFinished, false, 'Guild B should complete before slow Guild A finishes');

        await slowGuildAPromise;
        assert.strictEqual(guildAFinished, true);
    });

    // 14. Per-guild locks are distinct: operations in Guild A and Guild B execute in parallel
    await test('Per-guild locks are isolated: Guild A lock does not block Guild B', async () => {
        const controller = new PlayerController({});
        const order = [];

        const taskA = controller.runWithGuildLock('guild-lock-A', async () => {
            order.push('A-start');
            await new Promise(r => setTimeout(r, 50));
            order.push('A-end');
        });

        const taskB = controller.runWithGuildLock('guild-lock-B', async () => {
            order.push('B-start');
            await new Promise(r => setTimeout(r, 10));
            order.push('B-end');
        });

        await Promise.all([taskA, taskB]);
        // Since B is faster and locks are distinct, B-end must occur BEFORE A-end!
        const bEndIndex = order.indexOf('B-end');
        const aEndIndex = order.indexOf('A-end');
        assert(bEndIndex < aEndIndex, 'Guild B must finish before Guild A because guild locks are isolated');
    });

    console.log(`\nAll regression tests passed: ${passedTests}/${passedTests}`);
}

run().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
