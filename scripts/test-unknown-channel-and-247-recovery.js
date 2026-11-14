const assert = require('assert');
const PlayerController = require('../src/utils/PlayerController');
const voiceStateUpdate = require('../src/events/voiceStateUpdate');

async function runTests() {
    console.log('--- ZYRO Unknown Channel & 24/7 Recovery Tests ---');
    let passed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`  ok  - ${name}`);
            passed++;
        } catch (err) {
            console.error(`  FAIL - ${name}`);
            console.error(err);
            process.exit(1);
        }
    }

    // 1. Channel Validation: Allows voice channels with message capability, rejects channels without send support
    await test('1. PlayerController accepts voice channels with send support and rejects channels without send capability', () => {
        const controller = new PlayerController({});

        const voiceChannel = {
            id: 'vc-1',
            type: 2, // ChannelType.GuildVoice
            isVoiceBased: () => true,
            send: async () => {},
        };

        const stageChannelWithoutSend = {
            id: 'sc-1',
            type: 13, // ChannelType.GuildStageVoice
            isVoiceBased: () => true,
            // no send method
        };

        const textChannel = {
            id: 'tc-1',
            type: 0, // ChannelType.GuildText
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => {},
        };

        const voiceResult = controller.checkChannelPermissions(voiceChannel);
        assert.equal(voiceResult.ok, true, 'Voice channel with send support should be accepted');

        const stageResult = controller.checkChannelPermissions(stageChannelWithoutSend);
        assert.equal(stageResult.ok, false, 'Channel without send support should be rejected');

        const textResult = controller.checkChannelPermissions(textChannel);
        assert.equal(textResult.ok, true);
    });

    // 2. Precedence: Configured dashboard channel is preferred over interaction when valid
    await test('2. Configured dashboard channel is preferred over interaction channel when valid', async () => {
        const configuredChannel = {
            id: 'configured-tc',
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => ({ id: 'new-msg' }),
        };

        const interactionChannel = {
            id: 'interaction-tc',
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => ({ id: 'inter-msg' }),
        };

        const channelsMap = new Map([
            ['configured-tc', configuredChannel],
            ['interaction-tc', interactionChannel],
        ]);

        const mockClient = {
            channels: {
                cache: channelsMap,
                fetch: async (id) => channelsMap.get(id) || null,
            },
            guildSettings: {
                get: () => ({ textChannelId: 'configured-tc' }),
                getDashboard: () => null,
            },
        };

        const controller = new PlayerController(mockClient);
        const resolved = await controller.resolvePlayerChannel('g1', { channelId: 'interaction-tc' });
        assert.equal(resolved.id, 'configured-tc', 'Should resolve configured text channel first');
    });

    // 3. Fallback: Resolves connected voice channel and does NOT fall back to normal text channel
    await test('3. Resolves connected voice channel and does not fall back to normal text channel', async () => {
        const voiceInteractionChannel = {
            id: 'general-vc',
            name: 'General',
            type: 2,
            isVoiceBased: () => true,
            send: async () => ({ id: 'voice-msg' }),
        };

        const fallbackGuildTextChannel = {
            id: 'general-text',
            name: 'general-text',
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => ({ id: 'text-msg' }),
        };

        const mockClient = {
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g1',
                    voiceChannelId: 'general-vc',
                    textChannelId: 'general-vc',
                })
            },
            channels: {
                cache: new Map([
                    ['general-vc', voiceInteractionChannel],
                    ['general-text', fallbackGuildTextChannel],
                ]),
                fetch: async (id) => (id === 'general-vc' ? voiceInteractionChannel : null),
            },
            guildSettings: {
                get: () => ({}),
                getDashboard: () => null,
            },
            guilds: {
                cache: new Map([
                    ['g1', {
                        channels: {
                            cache: new Map([
                                ['general-vc', voiceInteractionChannel],
                                ['general-text', fallbackGuildTextChannel],
                            ])
                        }
                    }]
                ])
            }
        };

        const controller = new PlayerController(mockClient);
        const resolved = await controller.resolvePlayerChannel('g1', { channelId: 'general-vc' });
        assert.equal(resolved.id, 'general-vc', 'Should resolve connected voice channel directly instead of falling back to text channel');
    });

    // 4. Unknown Channel (10003) clears stale dashboard without retrying indefinitely
    await test('4. Discord error 10003 (Unknown Channel) clears stale dashboard reference and does not loop', async () => {
        let deletedDashboardCalled = false;
        let deleteDashboardGuildId = null;

        const deadChannel = {
            id: 'dead-channel-id',
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => {
                const err = new Error('Unknown Channel');
                err.code = 10003;
                throw err;
            }
        };

        const mockClient = {
            channels: {
                cache: new Map([['dead-channel-id', deadChannel]]),
                fetch: async () => deadChannel,
            },
            guildSettings: {
                _dash: { messageId: 'old-msg-1', channelId: 'dead-channel-id' },
                get: () => ({}),
                getDashboard() {
                    return this._dash;
                },
                deleteDashboard(gid) {
                    deletedDashboardCalled = true;
                    deleteDashboardGuildId = gid;
                    this._dash = null;
                }
            },
            lavalink: { getPlayer: () => null },
            lavalinkConnectionManager: { isAvailable: () => true },
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g1', { messageId: 'old-msg-1', channelId: 'dead-channel-id' });

        const result = await controller.sendReplacementPlayer('g1', { channelId: 'dead-channel-id', stopped: true });
        assert.equal(result, null, 'Failed send returns null');
        assert.equal(deletedDashboardCalled, true, 'deleteDashboard must be called when Discord returns 10003');
        assert.equal(deleteDashboardGuildId, 'g1');
        assert.equal(controller.getDashboard('g1'), null, 'In-memory dashboard reference must be cleared');
    });

    // 5. Preserves 24/7, autoplay and other settings when clearing stale dashboard on 10003
    await test('5. Clearing invalid dashboard preserves twentyFourSeven and other guild settings', async () => {
        const guildSettings = require('../src/utils/guildSettings');
        const guildId = 'g-settings-preserve-test';

        guildSettings.set247(guildId, true, { voiceChannelId: 'vc-100', textChannelId: 'tc-200' });
        guildSettings.setDashboard(guildId, { messageId: 'msg-dead', channelId: 'ch-dead' });

        assert.equal(guildSettings.is247(guildId), true);
        assert.equal(guildSettings.getDashboard(guildId).messageId, 'msg-dead');

        // Delete dashboard (what PlayerController calls on 10003)
        guildSettings.deleteDashboard(guildId);

        // Dashboard is cleared
        assert.equal(guildSettings.getDashboard(guildId), null);
        // But 24/7 mode, voiceChannelId, and textChannelId are completely preserved!
        assert.equal(guildSettings.is247(guildId), true);
        assert.equal(guildSettings.get(guildId).voiceChannelId, 'vc-100');
        assert.equal(guildSettings.get(guildId).textChannelId, 'tc-200');

        // Clean up
        guildSettings.delete(guildId);
    });

    // 6. Missing permissions (50013 / 403) are handled separately from Unknown Channel (10003)
    await test('6. Missing permissions (code 50013 / 403) are logged separately and do not clear dashboard as Unknown Channel', async () => {
        let deletedDashboardCalled = false;

        const restrictedChannel = {
            id: 'restricted-ch',
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => {
                const err = new Error('Missing Permissions');
                err.code = 50013;
                throw err;
            }
        };

        const mockClient = {
            channels: {
                cache: new Map([['restricted-ch', restrictedChannel]]),
                fetch: async () => restrictedChannel,
            },
            guildSettings: {
                get: () => ({}),
                getDashboard: () => ({ messageId: 'saved-msg', channelId: 'restricted-ch' }),
                deleteDashboard: () => {
                    deletedDashboardCalled = true;
                }
            },
            lavalink: { getPlayer: () => null },
            lavalinkConnectionManager: { isAvailable: () => true },
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g1', { messageId: 'saved-msg', channelId: 'restricted-ch' });

        const result = await controller.sendReplacementPlayer('g1', { channelId: 'restricted-ch', stopped: true });
        assert.equal(result, null, 'Failed send returns null');
        assert.equal(deletedDashboardCalled, false, 'deleteDashboard must NOT be called for 50013 missing permissions');
        assert.equal(controller.getDashboard('g1').messageId, 'saved-msg', 'Saved dashboard reference remains intact for permission errors');
    });

    // 7. 24/7 Auto-recovery handles deleted target voice channel (10003) safely without looping
    await test('7. 24/7 Auto-recovery gracefully handles deleted voice channel without reconnect loops', async () => {
        let connectAttempted = false;

        const mockClient = {
            user: { id: 'bot-123' },
            is247Enabled: () => true,
            guildSettings: {
                get: () => ({ voiceChannelId: 'deleted-vc-id' })
            },
            lavalink: {
                getPlayer: () => ({
                    connect: async () => { connectAttempted = true; }
                })
            },
            lavalinkConnectionManager: {
                getActiveNode: () => ({ connected: true, id: 'main' })
            },
            playerController: {
                showStoppedState: async () => {}
            }
        };

        const oldState = {
            id: 'bot-123',
            channelId: 'deleted-vc-id',
            guild: {
                id: 'g-247-test',
                name: 'ZYRO Music',
                members: { me: { id: 'bot-123', voice: null } },
                channels: {
                    cache: new Map(),
                    fetch: async (id) => {
                        const err = new Error('Unknown Channel');
                        err.code = 10003;
                        throw err;
                    }
                }
            }
        };

        const newState = {
            id: 'bot-123',
            channelId: null,
            guild: oldState.guild
        };

        await voiceStateUpdate.execute(oldState, newState, mockClient);

        // Wait past the 3000ms setTimeout in voiceStateUpdate
        await new Promise(resolve => setTimeout(resolve, 3100));

        assert.equal(connectAttempted, false, 'Must not attempt to connect when target voice channel is deleted (10003)');
    });

    // 8. 24/7 Auto-recovery skips duplicate connection if bot is already connected
    await test('8. 24/7 Auto-recovery does not create duplicate connection if bot already reconnected', async () => {
        let connectAttempted = false;

        const mockVoiceChannel = {
            id: 'vc-active',
            name: 'Voice Channel',
            type: 2,
            isVoiceBased: () => true,
            permissionsFor: () => ({ has: () => true })
        };

        const mockClient = {
            user: { id: 'bot-123' },
            is247Enabled: () => true,
            guildSettings: {
                get: () => ({ voiceChannelId: 'vc-active' })
            },
            lavalink: {
                getPlayer: () => ({
                    connect: async () => { connectAttempted = true; }
                })
            },
            lavalinkConnectionManager: {
                getActiveNode: () => ({ connected: true, id: 'main' })
            },
            playerController: {
                showStoppedState: async () => {}
            }
        };

        const oldState = {
            id: 'bot-123',
            channelId: 'vc-active',
            guild: {
                id: 'g-duplicate-test',
                name: 'Test Guild',
                // Bot already connected to voice channel in guild!
                members: { me: { id: 'bot-123', voice: { channelId: 'vc-active' } } },
                channels: {
                    cache: new Map([['vc-active', mockVoiceChannel]]),
                    fetch: async () => mockVoiceChannel
                }
            }
        };

        const newState = {
            id: 'bot-123',
            channelId: null,
            guild: oldState.guild
        };

        await voiceStateUpdate.execute(oldState, newState, mockClient);
        await new Promise(resolve => setTimeout(resolve, 3100));

        assert.equal(connectAttempted, false, 'Must not create duplicate connection when bot is already in voice');
    });

    // 9. Channel without message sending capability saved in guildSettings.textChannelId falls back to text channel and updates guildSettings only after successful send
    await test('9. Channel without message capability saved in guildSettings.textChannelId falls back safely and persists corrected textChannelId after send', async () => {
        let persistedChannelId = null;

        const voiceChannelWithoutSend = {
            id: 'saved-vc-in-settings',
            name: 'Voice Chat',
            type: 2,
            isVoiceBased: () => true,
            isTextBased: () => false,
            // No send method: channel without message capability
        };

        const validTextChannel = {
            id: 'fallback-tc',
            name: 'music-commands',
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => ({ id: 'new-dashboard-msg', edit: async () => {} }),
        };

        const channelsMap = new Map([
            ['saved-vc-in-settings', voiceChannelWithoutSend],
            ['fallback-tc', validTextChannel],
        ]);

        const mockGuild = {
            id: 'g-persisted-test',
            systemChannel: validTextChannel,
            channels: {
                cache: channelsMap,
                fetch: async (id) => channelsMap.get(id) || null,
            },
        };

        const mockClient = {
            user: { id: 'bot-123' },
            guilds: {
                cache: new Map([['g-persisted-test', mockGuild]]),
                fetch: async () => mockGuild,
            },
            channels: {
                cache: channelsMap,
                fetch: async (id) => channelsMap.get(id) || null,
            },
            guildSettings: {
                get: () => ({ textChannelId: 'saved-vc-in-settings', twentyFourSeven: true }),
                getDashboard: () => null,
                setDashboard: () => {},
                invalidateTextChannel: (guildId) => {},
                updateTextChannelId: (guildId, newChannelId) => {
                    persistedChannelId = newChannelId;
                },
            },
        };

        const controller = new PlayerController(mockClient);

        // 1. Resolve channel should reject channel without send support and return fallback text channel
        const resolved = await controller.resolvePlayerChannel('g-persisted-test');
        assert.equal(resolved.id, 'fallback-tc', 'Must reject channel without message support and return fallback text channel');
        assert.equal(persistedChannelId, null, 'Must NOT update persisted channel ID before send succeeds');

        // 2. Send replacement dashboard
        const sent = await controller.sendReplacementPlayer('g-persisted-test', { stopped: true });
        assert.ok(sent, 'Dashboard send must succeed');
        assert.equal(persistedChannelId, 'fallback-tc', 'Corrected text channel ID must be persisted after send');
    });

    // 10. LavalinkConnectionManager 24/7 recovery invalidates deleted voice channel (10003) and preserves 24/7 mode
    await test('10. LavalinkConnectionManager 24/7 recovery invalidates deleted voice channel (10003) and preserves twentyFourSeven', async () => {
        const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');

        let voiceInvalidated = false;
        let connectCalled = false;

        const settingsStore = {
            'g-deleted-247': {
                voiceChannelId: 'deleted-vc-10003',
                twentyFourSeven: true,
                autoplay: false,
            }
        };

        const mockClient = {
            user: { id: 'bot-123' },
            guildSettings: {
                cache: new Map(Object.entries(settingsStore)),
                get: (id) => settingsStore[id],
                invalidateVoiceChannel: (id) => {
                    voiceInvalidated = true;
                    delete settingsStore[id].voiceChannelId;
                }
            },
            guilds: {
                cache: new Map([
                    ['g-deleted-247', {
                        id: 'g-deleted-247',
                        name: 'Guild 24/7',
                        channels: {
                            cache: new Map(),
                            fetch: async (id) => {
                                const err = new Error('Unknown Channel');
                                err.code = 10003;
                                throw err;
                            }
                        }
                    }]
                ]),
            },
            lavalink: {
                getPlayer: () => null,
                createPlayer: () => ({
                    connect: async () => { connectCalled = true; }
                })
            }
        };

        const manager = new LavalinkConnectionManager(mockClient);
        const dummyNode = { connected: true, id: 'main-node' };

        await manager.recover247Connections(dummyNode);

        assert.equal(voiceInvalidated, true, 'Must call invalidateVoiceChannel when 10003 is encountered');
        assert.equal(settingsStore['g-deleted-247'].twentyFourSeven, true, 'Must preserve twentyFourSeven: true');
        assert.equal(settingsStore['g-deleted-247'].voiceChannelId, undefined, 'Must clear stale voiceChannelId reference');
        assert.equal(connectCalled, false, 'Must NOT attempt to connect to deleted voice channel');
    });

    console.log(`\n========================================`);
    console.log(`Unknown Channel & 24/7 Recovery Tests: ${passed}/${passed} passed`);
    console.log(`========================================\n`);
    process.exit(0);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
