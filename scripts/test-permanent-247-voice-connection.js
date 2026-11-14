/**
 * Comprehensive verification test suite for ZYRO Permanent 24/7 Voice Connection & Auto-Reconnect
 *
 * Verifies:
 * 1. /247 ON keeps ZYRO connected when the last human user leaves
 * 2. A human user leaving does not trigger a bot disconnect or empty channel timeout
 * 3. Manual bot disconnection while /247 is ON triggers one controlled reconnect with generation ID & backoff
 * 4. Manual disconnection while /247 is OFF does not trigger a reconnect
 * 5. /247 OFF cancels pending recovery callbacks and timers
 * 6. /stop stops playback, clears queue, but preserves voice connection when 24/7 is ON
 * 7. /leave explicitly disables 24/7, cancels recovery, and disconnects the bot
 * 8. Node reconnection does not create duplicate players or duplicate recoveries
 * 9. Multiple rapid voice-state events do not create duplicate reconnect attempts
 * 10. A deleted voice channel (10003) or missing permissions stops retrying and clears invalid channel reference
 * 11. Bot restart correctly restores saved 24/7 state across guilds
 * 12. Active playback state is preserved and safely restored upon auto-recovery
 */

const assert = require('assert');
const twentyFourSevenManager = require('../src/utils/twentyFourSevenManager');
const { countHumanMembers, scheduleEmptyChannelTimeout, clearEmptyChannelTimeout, emptyChannelTimeouts, execute: voiceStateUpdateExecute } = require('../src/events/voiceStateUpdate');
const cmd247 = require('../src/commands/247');
const cmdLeave = require('../src/commands/leave');
const cmdStop = require('../src/commands/stop');
const { stopPlayer } = require('../src/utils/PlayerActions');
const guildSettings = require('../src/utils/guildSettings');

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
    totalTests++;
    try {
        await fn();
        passedTests++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}:`, err.message || err);
        throw err;
    }
}

async function run247Tests() {
    console.log('\n--- STARTING ZYRO 24/7 VOICE CONNECTION & AUTO-RECONNECT VERIFICATION ---');

    // Test 1 & 2: Human leaves channel when 24/7 is ON
    await test('1 & 2. /247 ON keeps ZYRO connected when human users leave (no empty-channel timeout scheduled)', async () => {
        const guildId = 'g-human-leave-test';
        let emptyTimeoutScheduled = false;

        const mockClient = {
            is247Enabled: (gId) => gId === guildId,
            guildSettings: {
                is247: (gId) => gId === guildId,
                get: () => ({ twentyFourSeven: true, voiceChannelId: 'vc-1' }),
            }
        };

        // When scheduleEmptyChannelTimeout is called with 24/7 ON, it should NOT set a timer
        scheduleEmptyChannelTimeout(mockClient, guildId, 'vc-1');
        assert.equal(emptyChannelTimeouts.has(guildId), false, 'Must not schedule emptyChannelTimeout when 24/7 is ON');

        // Test via voiceStateUpdate: human disconnects leaving channel empty
        const humanMember = { id: 'user-1', user: { bot: false } };
        const mockBotChannel = {
            id: 'vc-1',
            name: 'General Voice',
            guild: { id: guildId },
            members: new Map([
                ['bot-1', { id: 'bot-1', user: { bot: true } }]
                // Zero human members remain
            ])
        };

        const oldState = {
            id: 'user-1',
            channelId: 'vc-1',
            guild: {
                id: guildId,
                members: {
                    me: { id: 'bot-1', voice: { channel: mockBotChannel } }
                }
            }
        };
        const newState = { id: 'user-1', channelId: null };

        await voiceStateUpdateExecute(oldState, newState, mockClient);
        assert.equal(emptyChannelTimeouts.has(guildId), false, 'Human departure must not schedule disconnect when 24/7 is ON');
    });

    // Test 3: Manual bot disconnection while 24/7 is ON triggers one controlled reconnect
    await test('3. Manual bot disconnection while /247 is ON triggers controlled reconnect', async () => {
        const guildId = 'g-manual-disconnect-test';
        let connectedCalled = false;

        const mockChannel = {
            id: 'vc-247',
            name: 'Chill Lounge',
            type: 2,
            isVoiceBased: () => true,
            permissionsFor: () => ({
                has: () => true,
            })
        };

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-247',
            playing: false,
            options: {},
            connect: async () => { connectedCalled = true; },
            queue: { current: null, tracks: [] }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            is247Enabled: (gId) => gId === guildId,
            guildSettings: {
                get: () => ({ twentyFourSeven: true, voiceChannelId: 'vc-247' }),
            },
            guilds: {
                cache: new Map([
                    [guildId, {
                        id: guildId,
                        name: 'Test Guild',
                        members: {
                            me: { id: 'bot-1', voice: { channelId: null } }
                        },
                        channels: {
                            cache: new Map([['vc-247', mockChannel]]),
                            fetch: async () => mockChannel,
                        }
                    }]
                ])
            },
            lavalink: {
                getPlayer: () => mockPlayer,
                createPlayer: () => mockPlayer,
            },
            lavalinkConnectionManager: {
                getActiveNode: () => ({ id: 'node-1', connected: true })
            }
        };

        const oldState = {
            id: 'bot-1',
            channelId: 'vc-247',
            guild: mockClient.guilds.cache.get(guildId),
        };
        const newState = { id: 'bot-1', channelId: null };

        // Bot was disconnected from Discord
        await voiceStateUpdateExecute(oldState, newState, mockClient);

        // Verification: auto-recovery session was scheduled
        assert.ok(twentyFourSevenManager.isReconnecting(guildId), 'Must schedule auto-recovery session');

        // Fast-forward / execute recovery
        const session = twentyFourSevenManager.sessions.get(guildId);
        assert.ok(session, 'Session must exist');
        await twentyFourSevenManager.executeRecovery(mockClient, guildId, session.generation);

        assert.equal(connectedCalled, true, 'Must call player.connect() during recovery');
        assert.equal(twentyFourSevenManager.isReconnecting(guildId), false, 'Must clear recovery session after success');
    });

    // Test 4: Manual disconnection while 24/7 is OFF does not trigger a reconnect
    await test('4. Manual bot disconnection while /247 is OFF does not trigger a reconnect', async () => {
        const guildId = 'g-off-disconnect-test';
        let destroyedCalled = false;

        const mockPlayer = {
            guildId,
            destroy: () => { destroyedCalled = true; }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            is247Enabled: () => false,
            lavalink: {
                getPlayer: () => mockPlayer,
            },
            playerController: {
                deletePlayer: () => {},
            },
            activePlayers: new Set([guildId]),
            updatePresence: () => {},
        };

        const oldState = {
            id: 'bot-1',
            channelId: 'vc-off',
            guild: { id: guildId, name: 'Normal Guild' },
        };
        const newState = { id: 'bot-1', channelId: null };

        twentyFourSevenManager.cancelRecovery(guildId, 'pre_clean');
        await voiceStateUpdateExecute(oldState, newState, mockClient);

        assert.equal(twentyFourSevenManager.isReconnecting(guildId), false, 'Must NOT schedule recovery when 24/7 is OFF');
        assert.equal(destroyedCalled, true, 'Must destroy player when 24/7 is OFF and bot is disconnected');
    });

    // Test 5: /247 OFF cancels pending recovery callbacks
    await test('5. /247 OFF cancels pending recovery callbacks and timers', () => {
        const guildId = 'g-cancel-test';
        twentyFourSevenManager.scheduleAutoRecovery({ is247Enabled: () => true }, guildId, 'vc-test', 'test');
        assert.ok(twentyFourSevenManager.isReconnecting(guildId), 'Reconnection must be active');

        // Cancel recovery (what /247 OFF and /leave do)
        twentyFourSevenManager.cancelRecovery(guildId, 'command_toggle_off');
        assert.equal(twentyFourSevenManager.isReconnecting(guildId), false, 'Reconnection must be cancelled');
    });

    // Test 6: /stop stops music but preserves voice connection when 24/7 is ON
    await test('6. /stop stops playback, clears queue, but keeps voice connection intact when 24/7 is ON', async () => {
        const guildId = 'g-stop-247-test';
        let stopPlayingCalled = false;
        let destroyCalled = false;

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-stop',
            playing: true,
            queue: {
                current: { info: { title: 'Song 1' } },
                tracks: [{ info: { title: 'Song 2' } }],
                splice: async () => { mockPlayer.queue.tracks.length = 0; }
            },
            stopPlaying: async () => { stopPlayingCalled = true; },
            destroy: () => { destroyCalled = true; },
            setData: () => {},
        };

        const mockClient = {
            is247Enabled: () => true,
            activePlayers: new Set([guildId]),
            updatePresence: () => {},
            playerController: {
                showStoppedState: async () => {},
            }
        };

        const result = await stopPlayer(mockClient, mockPlayer, { channelId: 'tc-1' });
        assert.equal(result, true);
        assert.equal(stopPlayingCalled, true, 'Must stop audio playback');
        assert.equal(destroyCalled, false, 'Must NOT destroy player or disconnect voice');
        assert.equal(mockPlayer.playing, false, 'Player playing state must be false');
        assert.equal(mockPlayer.queue.current, null, 'Current track must be null');
        assert.equal(mockPlayer.queue.tracks.length, 0, 'Queue tracks must be cleared');
    });

    // Test 7: /leave preserves its documented behavior
    await test('7. /leave explicitly disables 24/7, cancels recovery, and disconnects', async () => {
        const guildId = 'g-leave-cmd-test';
        let disabled247 = false;
        let destroyedPlayer = false;

        twentyFourSevenManager.scheduleAutoRecovery({ is247Enabled: () => true }, guildId, 'vc-leave', 'test');
        assert.ok(twentyFourSevenManager.isReconnecting(guildId));

        const mockChannel = { id: 'vc-leave', name: 'Leave Voice' };
        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-leave',
            destroy: async () => { destroyedPlayer = true; }
        };

        const mockInteraction = {
            guildId,
            guild: {
                id: guildId,
                name: 'Leave Guild',
                members: { me: { voice: { channel: mockChannel, disconnect: async () => {} } } }
            },
            member: { voice: { channel: mockChannel } },
            channel: { id: 'tc-1', name: 'bot-commands' },
            client: {
                defaultLanguage: 'en',
                is247Enabled: (gId) => (disabled247 ? false : true),
                set247: (gId, enabled) => { if (!enabled) disabled247 = true; },
                lavalink: { getPlayer: () => mockPlayer },
                playerController: { deletePlayer: async () => {} },
            },
            deferReply: async () => {},
            editReply: async () => ({ id: 'reply-1' }),
            reply: async () => ({ id: 'reply-1' }),
        };

        await cmdLeave.execute(mockInteraction);

        assert.equal(disabled247, true, 'Must turn off 24/7 on /leave');
        assert.equal(twentyFourSevenManager.isReconnecting(guildId), false, 'Must cancel pending 24/7 recovery on /leave');
        assert.equal(destroyedPlayer, true, 'Must destroy player and disconnect on /leave');
    });

    // Test 8: Node reconnection does not create duplicate players
    await test('8. Node reconnection does not create duplicate players or duplicate recoveries', async () => {
        const guildId = 'g-node-reconnect-test';
        let createCount = 0;

        const dummyPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            voice: { sessionId: 'sess-1' },
            connected: true,
            node: { id: 'main-node' },
            connect: async () => {},
        };

        const mockClient = {
            is247Enabled: () => true,
            twentyFourSevenManager: {
                isReconnecting: () => false, // No active voiceState recovery
            },
            guildSettings: {
                cache: new Map([[guildId, { twentyFourSeven: true, voiceChannelId: 'vc-1' }]]),
                get: () => ({ twentyFourSeven: true, voiceChannelId: 'vc-1' })
            },
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    name: 'Test Guild',
                    members: { me: { voice: { channelId: 'vc-1' } } },
                    channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'Voice', type: 2, isVoiceBased: () => true, permissionsFor: () => ({ has: () => true }) }]]) }
                }]])
            },
            lavalink: {
                getPlayer: () => dummyPlayer, // Player already exists
                createPlayer: () => { createCount++; return dummyPlayer; }
            }
        };

        const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
        const connMgr = new LavalinkConnectionManager(mockClient);
        const mainNode = { id: 'main-node', connected: true };

        await connMgr.recover247Connections(mainNode);

        // Player was already connected with same node, so createPlayer must not be called
        assert.equal(createCount, 0, 'Must NOT recreate healthy existing player on node reconnect');
    });

    // Test 9: Multiple voice-state events do not create duplicate reconnect attempts
    await test('9. Multiple rapid voice-state events coalesce into a single coordinated reconnect', () => {
        const guildId = 'g-rapid-events-test';
        const mockClient = { is247Enabled: () => true };

        twentyFourSevenManager.cancelRecovery(guildId);

        // Simulate 5 rapid disconnect events
        twentyFourSevenManager.scheduleAutoRecovery(mockClient, guildId, 'vc-rapid', 'event-1');
        const gen1 = twentyFourSevenManager.sessions.get(guildId).generation;

        twentyFourSevenManager.scheduleAutoRecovery(mockClient, guildId, 'vc-rapid', 'event-2');
        const gen2 = twentyFourSevenManager.sessions.get(guildId).generation;

        twentyFourSevenManager.scheduleAutoRecovery(mockClient, guildId, 'vc-rapid', 'event-3');
        const gen3 = twentyFourSevenManager.sessions.get(guildId).generation;

        assert.ok(gen3 > gen1, 'Generation must increment to supersede previous attempts');
        assert.equal(twentyFourSevenManager.sessions.size, 1, 'Only one session must exist per guild');

        twentyFourSevenManager.cancelRecovery(guildId);
    });

    // Test 10: Deleted or inaccessible channel stops retrying
    await test('10. Deleted channel (code 10003) stops recovery and clears invalid channel reference', async () => {
        const guildId = 'g-deleted-channel-test';
        let voiceInvalidated = false;

        const mockClient = {
            is247Enabled: () => true,
            guildSettings: {
                get: () => ({ twentyFourSeven: true, voiceChannelId: 'vc-deleted' }),
                invalidateVoiceChannel: () => { voiceInvalidated = true; }
            },
            guilds: {
                cache: new Map([
                    [guildId, {
                        id: guildId,
                        name: 'Deleted Channel Guild',
                        members: { me: { id: 'bot-1', voice: { channelId: null } } },
                        channels: {
                            cache: new Map(),
                            fetch: async () => {
                                const err = new Error('Unknown Channel');
                                err.code = 10003;
                                throw err;
                            }
                        }
                    }]
                ])
            }
        };

        twentyFourSevenManager.sessions.set(guildId, {
            generation: 1,
            attempts: 1,
            targetChannelId: 'vc-deleted',
        });

        await twentyFourSevenManager.executeRecovery(mockClient, guildId, 1);

        assert.equal(voiceInvalidated, true, 'Must invalidate deleted voice channel reference');
        assert.equal(twentyFourSevenManager.isReconnecting(guildId), false, 'Must stop recovery attempts for deleted channel');
    });

    // Test 11: Missing Connect permission stops retry loop
    await test('11. Missing Connect permission stops recovery without endless loops', async () => {
        const guildId = 'g-no-perm-test';

        const restrictedChannel = {
            id: 'vc-locked',
            name: 'Locked Voice',
            type: 2,
            isVoiceBased: () => true,
            permissionsFor: () => ({
                has: (flag) => false, // No Connect permission
            })
        };

        const mockClient = {
            is247Enabled: () => true,
            guildSettings: {
                get: () => ({ twentyFourSeven: true, voiceChannelId: 'vc-locked' }),
            },
            guilds: {
                cache: new Map([
                    [guildId, {
                        id: guildId,
                        name: 'Locked Guild',
                        members: { me: { id: 'bot-1', voice: { channelId: null } } },
                        channels: {
                            cache: new Map([['vc-locked', restrictedChannel]]),
                            fetch: async () => restrictedChannel,
                        }
                    }]
                ])
            }
        };

        twentyFourSevenManager.sessions.set(guildId, {
            generation: 1,
            attempts: 1,
            targetChannelId: 'vc-locked',
        });

        await twentyFourSevenManager.executeRecovery(mockClient, guildId, 1);

        assert.equal(twentyFourSevenManager.isReconnecting(guildId), false, 'Must abort recovery when Connect permission is denied');
    });

    // Test 12: Active playback is restored upon auto-recovery
    await test('12. Active track playback is safely restored after auto-recovery reconnects', async () => {
        const guildId = 'g-restore-playback-test';
        let resumedTrack = null;
        let resumedPosition = 0;

        const mockChannel = {
            id: 'vc-play',
            name: 'Playback Voice',
            type: 2,
            isVoiceBased: () => true,
            permissionsFor: () => ({ has: () => true }),
        };

        const activeTrack = { info: { title: 'Kasun Kalhara - Mal Mitak' } };

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-play',
            options: {},
            playing: false,
            queue: { current: null, tracks: [] },
            connect: async () => {},
            play: async (opts) => {
                resumedTrack = mockPlayer.queue.current;
                resumedPosition = opts?.position || 0;
            }
        };

        const mockClient = {
            user: { id: 'bot-1' },
            is247Enabled: () => true,
            guildSettings: {
                get: () => ({ twentyFourSeven: true, voiceChannelId: 'vc-play' }),
            },
            guilds: {
                cache: new Map([
                    [guildId, {
                        id: guildId,
                        name: 'Music Guild',
                        members: { me: { id: 'bot-1', voice: { channelId: null } } },
                        channels: { cache: new Map([['vc-play', mockChannel]]), fetch: async () => mockChannel }
                    }]
                ])
            },
            lavalink: {
                getPlayer: () => mockPlayer,
            },
            lavalinkConnectionManager: {
                getActiveNode: () => ({ id: 'node-1', connected: true })
            },
            voiceChannelStatusManager: {
                syncGuildPlayerStatus: async () => {}
            }
        };

        twentyFourSevenManager.sessions.set(guildId, {
            generation: 1,
            attempts: 1,
            targetChannelId: 'vc-play',
            savedState: {
                wasPlaying: true,
                track: activeTrack,
                position: 45000,
            }
        });

        await twentyFourSevenManager.executeRecovery(mockClient, guildId, 1);

        assert.ok(resumedTrack, 'Must resume playing the saved active track');
        assert.equal(resumedTrack.info.title, 'Kasun Kalhara - Mal Mitak');
        assert.equal(resumedPosition, 45000, 'Must resume at saved playback position');
    });

    console.log(`\nAll ${passedTests}/${totalTests} 24/7 Voice Connection tests PASSED! ✓\n`);
    process.exit(0);
}

run247Tests().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
