const assert = require('assert');
const PlayerController = require('../src/utils/PlayerController');
const deployCommands = require('../src/utils/commandDeployer');
const { PermissionsBitField } = require('discord.js');

async function runTests() {
    console.log('--- Duplicate Commands & Dashboard Channel Fallback Tests ---');
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

    // 1. Command Deployer purges guild-scoped commands with empty array to prevent duplicates
    await test('1. Command deployer registers global commands and purges guild-scoped commands with body: []', async () => {
        const calls = [];
        const originalEnv = process.env.TOKEN;
        process.env.TOKEN = 'mock-token';

        // Mock REST client
        const mockClient = {
            user: { id: 'bot-123' },
            commands: new Map([
                ['play', { data: { toJSON: () => ({ name: 'play', description: 'Play music' }) } }],
                ['pause', { data: { toJSON: () => ({ name: 'pause', description: 'Pause music' }) } }],
            ]),
            guilds: {
                cache: new Map([
                    ['guild-1', { id: 'guild-1', name: 'Server 1' }],
                    ['guild-2', { id: 'guild-2', name: 'Server 2' }],
                ])
            }
        };

        // Inject REST interceptor via deployCommands testing
        const REST = require('discord.js').REST;
        const originalPut = REST.prototype.put;
        REST.prototype.put = async function(route, options) {
            calls.push({ route, body: options.body });
            return options.body;
        };

        try {
            await deployCommands(mockClient);

            // Assert global registration
            const globalCall = calls.find(c => c.route === '/applications/bot-123/commands');
            assert.ok(globalCall, 'Global application commands must be deployed');
            assert.equal(globalCall.body.length, 2, 'Global commands must include all registered commands');

            // Assert guild-level purge
            const guild1Call = calls.find(c => c.route === '/applications/bot-123/guilds/guild-1/commands');
            assert.ok(guild1Call, 'Guild 1 commands endpoint must be called');
            assert.deepEqual(guild1Call.body, [], 'Guild 1 commands must be cleared with empty array [] to eliminate duplicates');

            const guild2Call = calls.find(c => c.route === '/applications/bot-123/guilds/guild-2/commands');
            assert.ok(guild2Call, 'Guild 2 commands endpoint must be called');
            assert.deepEqual(guild2Call.body, [], 'Guild 2 commands must be cleared with empty array [] to eliminate duplicates');

            // Test deployGuildCommands clears guild commands
            calls.length = 0;
            await deployCommands.deployGuildCommands(mockClient, 'guild-joined');
            const joinedGuildCall = calls.find(c => c.route === '/applications/bot-123/guilds/guild-joined/commands');
            assert.ok(joinedGuildCall, 'Joined guild commands must be targeted');
            assert.deepEqual(joinedGuildCall.body, [], 'Joined guild must have guild-level commands cleared to prevent duplicates');
        } finally {
            REST.prototype.put = originalPut;
            process.env.TOKEN = originalEnv;
        }
    });

    // 2. Dashboard Fallback: When connected voice channel lacks SendMessages, falls back to textChannelId
    await test('2. resolvePlayerChannel falls back from permission-restricted voice channel to textChannelId', async () => {
        // Voice channel where bot cannot send messages
        const voiceChannel = {
            id: 'vc-no-send',
            name: 'VO',
            type: 2,
            isVoiceBased: () => true,
            send: async () => ({ id: 'voice-msg' }),
            permissionsFor: () => ({
                has: (flag) => {
                    // Bot lacks SendMessages in VO
                    if (flag === PermissionsBitField.Flags.SendMessages) return false;
                    return true;
                }
            })
        };

        // Command text channel where user ran /play
        const commandTextChannel = {
            id: 'tc-general',
            name: 'general',
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
            send: async () => ({ id: 'dash-msg' }),
            permissionsFor: () => ({
                has: () => true // Full permissions in general
            })
        };

        const mockClient = {
            user: { id: 'bot-123' },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'guild-test',
                    voiceChannelId: 'vc-no-send',
                    textChannelId: 'tc-general',
                })
            },
            channels: {
                cache: new Map([
                    ['vc-no-send', voiceChannel],
                    ['tc-general', commandTextChannel],
                ]),
                fetch: async (id) => (id === 'vc-no-send' ? voiceChannel : (id === 'tc-general' ? commandTextChannel : null)),
            },
            guildSettings: {
                get: () => ({}),
                getDashboard: () => null,
            },
            guilds: {
                cache: new Map([
                    ['guild-test', {
                        channels: {
                            cache: new Map([
                                ['vc-no-send', voiceChannel],
                                ['tc-general', commandTextChannel],
                            ])
                        }
                    }]
                ])
            }
        };

        const controller = new PlayerController(mockClient);

        // When updating dashboard for guild-test with channelId passed as voiceChannelId (or textChannelId)
        const resolved = await controller.resolvePlayerChannel('guild-test', { channelId: 'vc-no-send' });
        assert.ok(resolved, 'Should successfully resolve a usable channel');
        assert.equal(resolved.id, 'tc-general', 'Should fall back to tc-general when voice channel lacks SendMessages');
    });

    // 3. Dashboard Fallback: When voice channel has NO text permissions and no textChannelId, falls back to guild channels
    await test('3. resolvePlayerChannel falls back to available guild text channel when voice channel and textChannelId are unusable', async () => {
        const voiceChannel = {
            id: 'vc-restricted',
            name: 'Game Voice',
            type: 2,
            send: async () => ({ id: 'vc-msg' }),
            permissionsFor: () => ({
                has: (flag) => {
                    if (flag === PermissionsBitField.Flags.EmbedLinks) return false;
                    return true;
                }
            })
        };

        const generalTextChannel = {
            id: 'tc-fallback-avail',
            name: 'lounge',
            type: 0,
            isTextBased: () => true,
            send: async () => ({ id: 'avail-msg' }),
            permissionsFor: () => ({
                has: () => true
            })
        };

        const mockClient = {
            user: { id: 'bot-123' },
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-guild-fallback',
                    voiceChannelId: 'vc-restricted',
                    textChannelId: 'vc-restricted', // Same as voice channel
                })
            },
            channels: {
                cache: new Map([
                    ['vc-restricted', voiceChannel],
                    ['tc-fallback-avail', generalTextChannel],
                ]),
                fetch: async (id) => (id === 'vc-restricted' ? voiceChannel : (id === 'tc-fallback-avail' ? generalTextChannel : null)),
            },
            guildSettings: {
                get: () => ({}),
                getDashboard: () => null,
            },
            guilds: {
                cache: new Map([
                    ['g-guild-fallback', {
                        channels: {
                            cache: new Map([
                                ['vc-restricted', voiceChannel],
                                ['tc-fallback-avail', generalTextChannel],
                            ])
                        }
                    }]
                ])
            }
        };

        const controller = new PlayerController(mockClient);
        const resolved = await controller.resolvePlayerChannel('g-guild-fallback', { channelId: 'vc-restricted' });
        assert.ok(resolved, 'Should resolve fallback channel');
        assert.equal(resolved.id, 'tc-fallback-avail', 'Should fall back to accessible guild text channel');
    });

    console.log(`\n========================================`);
    console.log(`Duplicate Commands & Dashboard Fallback Tests: ${passed}/3 passed`);
    console.log(`========================================\n`);
}

runTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
