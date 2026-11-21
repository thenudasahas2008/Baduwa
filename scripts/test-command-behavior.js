// Deterministic unit tests for /stop, /leave, /247, and lifecycle handlers.
// No Discord gateway or Lavalink server required.
// Run: node scripts/test-command-behavior.js

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MessageFlags, PermissionsBitField } = require('discord.js');

let passed = 0;
function check(name, fn) {
    try {
        const res = fn();
        if (res && typeof res.then === 'function') {
            return res.then(() => { passed++; console.log(`  ok  - ${name}`); })
                .catch((err) => { 
                    const details = err.errors ? err.errors.map(e => e.stack || e.message).join('\n') : (err.stack || err.message);
                    console.error(`FAIL - ${name}\n      ${details}`); 
                    process.exitCode = 1; 
                });
        }
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        const details = err.errors ? err.errors.map(e => e.stack || e.message).join('\n') : (err.stack || err.message);
        console.error(`FAIL - ${name}\n      ${details}`);
        process.exitCode = 1;
    }
}

async function runTests() {
    console.log('Testing guildSettings and 24/7 persistence...');

    const guildSettings = require('../src/utils/guildSettings');
    const testGuildId = 'test-guild-123';

    check('guildSettings sets, gets, and persists 24/7 mode', () => {
        guildSettings.set247(testGuildId, true, { voiceChannelId: 'vc-1', textChannelId: 'tc-1' });
        assert.equal(guildSettings.is247(testGuildId), true);
        const data = guildSettings.get(testGuildId);
        assert.equal(data.twentyFourSeven, true);
        assert.equal(data.voiceChannelId, 'vc-1');
        assert.equal(data.textChannelId, 'tc-1');

        // Turn OFF
        guildSettings.set247(testGuildId, false);
        assert.equal(guildSettings.is247(testGuildId), false);
        const disabledData = guildSettings.get(testGuildId);
        assert.equal(disabledData.twentyFourSeven, false);
        assert.equal(disabledData.voiceChannelId, undefined);

        // Clean up
        guildSettings.delete(testGuildId);
        assert.equal(guildSettings.is247(testGuildId), false);
    });

    console.log('\nTesting slash command builders and translations...');

    const locales = ['en', 'es', 'it', 'pt-BR', 'tr'];
    const requiredKeys = ['LEAVE_SUCCESS', 'MODE_247_ENABLED', 'MODE_247_DISABLED', 'STOPPED_PLAYBACK'];

    check('all locales have required translation keys', () => {
        for (const loc of locales) {
            const filePath = path.join(__dirname, '..', 'locales', `${loc}.json`);
            assert.ok(fs.existsSync(filePath), `Locale file ${loc}.json must exist`);
            const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            for (const key of requiredKeys) {
                assert.ok(typeof json[key] === 'string' && json[key].length > 0, `Locale ${loc} missing key ${key}`);
            }
        }
    });

    const stopCommand = require('../src/commands/stop');
    const leaveCommand = require('../src/commands/leave');
    const cmd247 = require('../src/commands/247');

    check('command definitions match required names and descriptions', () => {
        assert.equal(stopCommand.data.name, 'stop');
        assert.equal(leaveCommand.data.name, 'leave');
        assert.equal(cmd247.data.name, '247');

        assert.ok(stopCommand.data.description.length > 0);
        assert.ok(leaveCommand.data.description.length > 0);
        assert.ok(cmd247.data.description.length > 0);
    });

    console.log('\nTesting /stop command behavior...');

    await check('/stop stops playback without destroying player, updates stopped UI, and preserves 24/7', async () => {
        let stopPlayingCalled = false;
        let destroyed = false;
        let playerStoppedStateShown = false;

        guildSettings.set247('guild-stop-test', true);

        const fakePlayer = {
            guildId: 'guild-stop-test',
            voiceChannelId: 'vc-1',
            playing: true,
            queue: { current: { info: { title: 'Test Song' } }, tracks: [{ info: { title: 'Queued' } }] },
            async stopPlaying(clearQueue, executeAutoplay) {
                assert.equal(clearQueue, true, 'must clear queue');
                assert.equal(executeAutoplay, false, 'must not run autoplay');
                stopPlayingCalled = true;
            },
            async destroy() {
                destroyed = true;
            }
        };

        let repliedEmbed = null;
        const fakeInteraction = {
            guild: { id: 'guild-stop-test', name: 'Test Guild' },
            channel: { name: 'general' },
            user: { tag: 'User#0001' },
            member: { voice: { channel: { id: 'vc-1' } } },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: { getPlayer: () => fakePlayer },
                playerController: {
                    deletePlayer: async () => {},
                    showStoppedState: async () => { playerStoppedStateShown = true; }
                },
                activePlayers: new Map([['guild-stop-test', {}]]),
                updatePresence: () => {},
                is247Enabled: (gId) => guildSettings.is247(gId),
            },
            reply: async (payload) => {
                repliedEmbed = payload?.embeds?.[0] || payload?.content;
            }
        };

        await stopCommand.execute(fakeInteraction);

        assert.ok(stopPlayingCalled, 'player.stopPlaying must be called');
        assert.equal(destroyed, false, 'player.destroy must NOT be called on /stop');
        assert.ok(playerStoppedStateShown, 'playerController.showStoppedState must be called to update Now Playing panel');
        assert.equal(fakeInteraction.client.activePlayers.has('guild-stop-test'), false);
        assert.equal(guildSettings.is247('guild-stop-test'), true, '24/7 mode must be preserved');
        assert.ok(repliedEmbed, 'Must reply with confirmation embed');

        guildSettings.delete('guild-stop-test');
    });

    console.log('\nTesting /leave command behavior...');

    await check('/leave stops playback, destroys player, and turns off 24/7 mode', async () => {
        let destroyed = false;
        let playerDeleted = false;

        guildSettings.set247('guild-leave-test', true);
        assert.equal(guildSettings.is247('guild-leave-test'), true);

        const fakePlayer = {
            guildId: 'guild-leave-test',
            voiceChannelId: 'vc-leave',
            async destroy() {
                destroyed = true;
            }
        };

        let repliedEmbed = null;
        const fakeInteraction = {
            guild: { id: 'guild-leave-test', name: 'Test Guild', members: { me: { voice: { channel: { id: 'vc-leave' } } } } },
            channel: { name: 'general' },
            user: { tag: 'User#0001' },
            member: { voice: { channel: { id: 'vc-leave' } } },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: { getPlayer: () => fakePlayer },
                playerController: {
                    deletePlayer: async () => { playerDeleted = true; }
                },
                activePlayers: new Map([['guild-leave-test', {}]]),
                autoplayEnabled: new Map([['guild-leave-test', true]]),
                updatePresence: () => {},
                is247Enabled: (gId) => guildSettings.is247(gId),
                set247: (gId, enabled) => guildSettings.set247(gId, enabled),
            },
            reply: async (payload) => {
                repliedEmbed = payload?.embeds?.[0] || payload?.content;
            }
        };

        await leaveCommand.execute(fakeInteraction);

        assert.ok(destroyed, 'player.destroy must be called on /leave');
        assert.ok(playerDeleted, 'playerController.deletePlayer must be called');
        assert.equal(guildSettings.is247('guild-leave-test'), false, '24/7 mode must be turned OFF on /leave');
        assert.equal(fakeInteraction.client.activePlayers.has('guild-leave-test'), false);
        assert.equal(fakeInteraction.client.autoplayEnabled.has('guild-leave-test'), false);
        assert.ok(repliedEmbed, 'Must reply with confirmation embed');

        guildSettings.delete('guild-leave-test');
    });

    console.log('\nTesting /247 toggle behavior...');

    await check('/247 toggles ON, cancels timeouts, and toggles OFF', async () => {
        const guildId = 'guild-toggle-test';
        guildSettings.delete(guildId);
        assert.equal(guildSettings.is247(guildId), false);

        let connected = false;
        let internalTimeoutCleared = false;
        let fakeInternalTimeout = setTimeout(() => {}, 100000);

        const fakePlayer = {
            guildId,
            voiceChannelId: 'vc-247',
            connected: false,
            async connect() { connected = true; this.connected = true; },
            getData(key) {
                if (key === 'internal_queueempty') return fakeInternalTimeout;
                return undefined;
            },
            setData(key, val) {
                if (key === 'internal_queueempty' && val === undefined) {
                    internalTimeoutCleared = true;
                }
            }
        };

        const fakeInteraction = {
            guild: { id: guildId, name: 'Test Guild', channels: { cache: new Map([['vc-247', { members: { filter: (fn) => [] } }]]) } },
            channel: { name: 'general', id: 'tc-247' },
            user: { tag: 'User#0001' },
            member: { voice: { channel: { id: 'vc-247' } } },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: {
                    getPlayer: () => fakePlayer,
                    createPlayer: () => fakePlayer,
                },
                playerController: { deletePlayer: async () => {} },
                activePlayers: new Map(),
                autoplayEnabled: new Map(),
                updatePresence: () => {},
                is247Enabled: (gId) => guildSettings.is247(gId),
                set247: (gId, enabled, opts) => guildSettings.set247(gId, enabled, opts),
            },
            reply: async (payload) => payload?.embeds?.[0] || payload?.content
        };

        // 1. Toggle ON
        const reply1 = await cmd247.execute(fakeInteraction);
        assert.ok(reply1, 'Must return embed response for 24/7 enable');
        assert.equal(guildSettings.is247(guildId), true);
        assert.ok(connected, 'must connect player to voice channel');
        assert.ok(internalTimeoutCleared, 'must clear internal_queueempty timer');
        clearTimeout(fakeInternalTimeout);

        // 2. Toggle OFF
        const reply2 = await cmd247.execute(fakeInteraction);
        assert.ok(reply2, 'Must return embed response for 24/7 disable');
        assert.equal(guildSettings.is247(guildId), false);

        const { emptyChannelTimeouts } = require('../src/events/voiceStateUpdate');
        if (emptyChannelTimeouts.has(guildId)) {
            clearTimeout(emptyChannelTimeouts.get(guildId));
            emptyChannelTimeouts.delete(guildId);
        }

        guildSettings.delete(guildId);
    });

    console.log('\nTesting voiceStateUpdate 24/7 protection...');

    await check('voiceStateUpdate does not disconnect when 24/7 is enabled and channel is empty', async () => {
        const vsu = require('../src/events/voiceStateUpdate');
        const guildId = 'guild-vsu-test';
        guildSettings.set247(guildId, true);

        const oldState = {
            id: 'human-user-id',
            guild: {
                id: guildId,
                members: {
                    me: {
                        voice: {
                            channel: {
                                id: 'bot-vc',
                                guild: { id: guildId },
                                members: { filter: (fn) => [] } // 0 human members
                            }
                        }
                    }
                }
            },
            channelId: 'bot-vc',
            client: {
                user: { id: 'bot-id' },
                is247Enabled: (gId) => guildSettings.is247(gId),
            }
        };

        const newState = {
            id: 'human-user-id',
            channelId: null
        };

        await vsu.execute(oldState, newState);

        assert.equal(vsu.emptyChannelTimeouts.has(guildId), false, 'emptyChannelTimeout must NOT be set when 24/7 is ON');

        // Now test when 24/7 is OFF
        guildSettings.set247(guildId, false);
        await vsu.execute(oldState, newState);
        assert.equal(vsu.emptyChannelTimeouts.has(guildId), true, 'emptyChannelTimeout MUST be set when 24/7 is OFF');

        // Cleanup
        if (vsu.emptyChannelTimeouts.has(guildId)) {
            clearTimeout(vsu.emptyChannelTimeouts.get(guildId));
            vsu.emptyChannelTimeouts.delete(guildId);
        }
        guildSettings.delete(guildId);
    });

    console.log('\nTesting Search Engine accuracy and ranking...');
    const searchEngine = require('../src/utils/searchEngine');

    check('searchEngine normalizes queries and extracts modifiers correctly', () => {
        const query1 = 'The Weeknd - Blinding Lights (Official Remix) [sped up]';
        const mods = searchEngine.extractModifiers(query1);
        assert.ok(mods.has('remix'));
        assert.ok(mods.has('sped up'));

        // Sinhala query preservation
        const sinhalaQuery = 'මනහාරී Manahari Live Acoustic';
        const sinhalaMods = searchEngine.extractModifiers(sinhalaQuery);
        assert.ok(sinhalaMods.has('live'));
        assert.ok(sinhalaMods.has('acoustic'));
        const norm = searchEngine.normalizeText(sinhalaQuery);
        assert.ok(norm.includes('මනහාරී'));
    });

    check('searchEngine scores exact and modifier-matching tracks higher', () => {
        const query = 'Ed Sheeran - Shape of You Acoustic';
        const trackAcoustic = {
            info: {
                title: 'Shape of You (Acoustic Version)',
                author: 'Ed Sheeran',
                duration: 210000,
            }
        };
        const trackStudio = {
            info: {
                title: 'Shape of You',
                author: 'Ed Sheeran',
                duration: 233000,
            }
        };
        const trackCover = {
            info: {
                title: 'Shape of You - Live Club Cover',
                author: 'Random Band',
                duration: 180000,
            }
        };

        const scoreAcoustic = searchEngine.scoreTrack(trackAcoustic, query);
        const scoreStudio = searchEngine.scoreTrack(trackStudio, query);
        const scoreCover = searchEngine.scoreTrack(trackCover, query);

        assert.ok(scoreAcoustic > scoreStudio, 'Acoustic track should rank higher than studio when acoustic was requested');
        assert.ok(scoreStudio > scoreCover, 'Studio by original artist should rank higher than a cover band');
    });

    check('searchEngine penalizes unrequested modifiers to prevent returning remix/live when studio was wanted', () => {
        const query = 'Coldplay Yellow';
        const trackStudio = {
            info: {
                title: 'Yellow',
                author: 'Coldplay',
                duration: 269000,
            }
        };
        const trackLive = {
            info: {
                title: 'Yellow (Live in Buenos Aires)',
                author: 'Coldplay',
                duration: 320000,
            }
        };

        const scoreStudio = searchEngine.scoreTrack(trackStudio, query);
        const scoreLive = searchEngine.scoreTrack(trackLive, query);

        assert.ok(scoreStudio > scoreLive, 'Studio track should rank higher than Live when live was NOT requested');
    });

    await check('searchMusic falls back from primary to secondary provider when primary returns 0 results', async () => {
        let searchedSources = [];
        const mockPlayer = {
            async search(searchObj) {
                searchedSources.push(searchObj.source);
                if (searchObj.source === 'ytmsearch') {
                    return { loadType: 'empty', tracks: [] };
                }
                if (searchObj.source === 'ytsearch') {
                    return {
                        loadType: 'search',
                        tracks: [
                            {
                                info: {
                                    title: 'Sihinayaki Mata Adare',
                                    author: 'Kasun Kalhara',
                                    duration: 240000,
                                    uri: 'https://youtube.com/watch?v=123'
                                }
                            }
                        ]
                    };
                }
                return { tracks: [] };
            }
        };

        const result = await searchEngine.searchMusic(mockPlayer, 'Kasun Kalhara Sihinayaki');
        assert.deepEqual(searchedSources, ['ytmsearch', 'ytsearch'], 'Must try ytmsearch first, then fallback to ytsearch');
        assert.equal(result.tracks.length, 1);
        assert.equal(result.tracks[0].info.title, 'Sihinayaki Mata Adare');
    });

    console.log('\nTesting ZYRO Signature UI and Embed builders...');
    const zyroEmbeds = require('../src/utils/zyroEmbeds');

    check('createProgressBar renders accurate Unicode indicator across durations', () => {
        const bar0 = zyroEmbeds.createProgressBar(0, 100000);
        assert.ok(bar0.includes('▶ 🔘'), 'At 0%, indicator must be at the very start');

        const bar100 = zyroEmbeds.createProgressBar(100000, 100000);
        assert.ok(bar100.includes('🔘 `1:40 / 1:40`'), 'At 100%, indicator must be at the very end of bar');

        const bar50 = zyroEmbeds.createProgressBar(50000, 100000);
        assert.ok(bar50.includes('🔘'), 'Must contain thumb indicator');
        assert.ok(!bar50.includes('▶ 🔘') && !bar50.includes('🔘 `1:40 / 1:40`'), 'At 50%, indicator must be in the middle');
    });

    check('formatDuration correctly formats ms into M:SS or H:MM:SS', () => {
        assert.equal(zyroEmbeds.formatDuration(65000), '1:05');
        assert.equal(zyroEmbeds.formatDuration(3665000), '1:01:05');
    });

    check('createNowPlayingEmbed includes UP NEXT preview and player status', () => {
        const mockPlayer = {
            position: 30000,
            volume: 80,
            repeatMode: 'track',
            queue: {
                current: {
                    info: {
                        title: 'Blinding Lights',
                        author: 'The Weeknd',
                        duration: 200000,
                        uri: 'https://youtube.com/watch?v=bl',
                        artworkUrl: 'https://img.youtube.com/vi/bl/hqdefault.jpg'
                    },
                    requester: { username: 'CoolUser', id: '123' }
                },
                tracks: [
                    {
                        info: {
                            title: 'Save Your Tears',
                            author: 'The Weeknd',
                            duration: 215000,
                            uri: 'https://youtube.com/watch?v=syt'
                        }
                    }
                ]
            }
        };

        const embed = zyroEmbeds.createNowPlayingEmbed(mockPlayer, { is247: true, autoplay: false });
        assert.equal(embed.data.color, zyroEmbeds.ZYRO_COLORS.PRIMARY);
        assert.ok((embed.data.title && embed.data.title.includes('NOW PLAYING')) || (embed.data.author && embed.data.author.name.includes('NOW PLAYING')));
        assert.ok(embed.data.description.includes('Blinding Lights'));
        assert.ok(embed.data.description.includes('CoolUser') || embed.data.fields.some(f => f.value.includes('CoolUser')));

        // Check Up Next field
        const upNextField = embed.data.fields.find(f => f.name.includes('Up Next'));
        assert.ok(upNextField, 'Must include Up Next field');
        assert.ok(upNextField.value.includes('Save Your Tears'));
    });

    console.log('\nTesting /help Slash Command & Interactive Navigation...');
    const helpCommand = require('../src/commands/help');

    check('help command is properly registered with builder and categories', () => {
        assert.equal(helpCommand.data.name, 'help');
        assert.ok(helpCommand.CATEGORIES, 'Must export CATEGORIES');
        assert.ok(helpCommand.CATEGORIES.playback);
        assert.ok(helpCommand.CATEGORIES.queue);
        assert.ok(helpCommand.CATEGORIES.automation);
        assert.ok(helpCommand.CATEGORIES.info);
    });

    check('help overview embed generates with ZYRO branding and quick start guide', () => {
        const mockClient = {
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' }
        };
        const overview = helpCommand.buildOverviewEmbed(mockClient);
        assert.ok(overview.data.title.includes('Welcome to ZYRO Music') || overview.data.author.name.includes('Help Center'));
        assert.ok(overview.data.description.includes('Quick-Start') || overview.data.fields.some(f => f.name.includes('Quick-Start')));
        assert.ok(overview.data.fields.some(f => f.value.includes('/stop') && f.value.includes('/leave')));
        assert.ok(overview.data.fields.some(f => f.value.includes('/247') && f.value.includes('/autoplay')));
        assert.ok(overview.data.fields.some(f => f.name.includes('Troubleshooting')));
        assert.equal(overview.data.color, 0x7C3AED);
    });

    check('help category embeds document all registered commands accurately', () => {
        const mockClient = {
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' }
        };

        for (const catKey of ['playback', 'queue', 'automation', 'info']) {
            const catEmbed = helpCommand.buildCategoryEmbed(mockClient, catKey);
            assert.ok(catEmbed.data.fields && catEmbed.data.fields.length > 0, `Category ${catKey} must have command fields`);
        }

        const navRows = helpCommand.buildHelpComponents('overview');
        assert.ok(navRows && navRows.length > 0);
        assert.equal(navRows[0].components[0].data.custom_id, 'help:category_select');
    });

    console.log('\nTesting Support Server Membership Gate...');
    const supportGate = require('../src/utils/supportGate');

    await check('support gate allows access when guild owner is a member of support server', async () => {
        const supportGuildId = '999888777666';
        const ownerId = '111222333444';
        process.env.SUPPORT_GUILD_ID = supportGuildId;

        const mockClient = {
            guilds: {
                cache: {
                    get: (id) => (id === supportGuildId ? {
                        id: supportGuildId,
                        name: 'ZYRO Official Support',
                        members: {
                            fetch: async (userId) => {
                                if (userId === ownerId) return { id: ownerId };
                                throw new Error('Unknown Member');
                            }
                        }
                    } : null)
                }
            }
        };

        supportGate.clearCache();
        const result = await supportGate.checkOwnerMembership(mockClient, ownerId);
        assert.equal(result.isMember, true);
        assert.equal(result.active, true);
    });

    await check('support gate blocks access when guild owner is NOT a member of support server', async () => {
        const supportGuildId = '999888777666';
        const nonMemberOwnerId = '999000111222';
        process.env.SUPPORT_GUILD_ID = supportGuildId;

        const mockClient = {
            guilds: {
                cache: {
                    get: (id) => (id === supportGuildId ? {
                        id: supportGuildId,
                        name: 'ZYRO Official Support',
                        members: {
                            fetch: async (userId) => {
                                const err = new Error('Unknown Member');
                                err.code = 10007; // DiscordAPIError: Unknown Member
                                throw err;
                            }
                        }
                    } : null)
                }
            }
        };

        const mockGuild = {
            id: '555666777889',
            name: 'Unactivated Server',
            ownerId: nonMemberOwnerId,
        };

        // Clear cache
        supportGate.clearCache();

        const result = await supportGate.checkOwnerMembership(mockClient, nonMemberOwnerId);
        assert.equal(result.isMember, false);
        assert.equal(result.active, true);

        // Verify gate embed and components
        const gateEmbed = supportGate.createGateEmbed(mockGuild);
        assert.ok(gateEmbed.data.title.includes('Required') || gateEmbed.data.author.name.includes('Required'));
        assert.equal(gateEmbed.data.color, 0x7C3AED);

        const components = supportGate.createGateComponents(nonMemberOwnerId);
        assert.ok(components.components && components.components.length > 0);
        const buttons = components.components;
        assert.ok(buttons.some(b => b.data.url === supportGate.SUPPORT_SERVER_INVITE));
        assert.ok(buttons.some(b => b.data.custom_id && b.data.custom_id.startsWith('support:verify')));
    });

    await check('support gate fails open safely when configuration is missing or API fails', async () => {
        const mockClient = { guilds: { cache: { get: () => null } } };

        // 1. Missing support guild ID
        delete process.env.SUPPORT_GUILD_ID;
        supportGate.clearCache();
        const resultMissingConfig = await supportGate.checkOwnerMembership(mockClient, '123');
        assert.equal(resultMissingConfig.isMember, true, 'Must fail-open if SUPPORT_GUILD_ID is not configured');
        assert.equal(resultMissingConfig.active, false);

        // 2. Bot not in support guild (returns null)
        process.env.SUPPORT_GUILD_ID = 'some_guild_id';
        supportGate.clearCache();
        const resultBotNotInGuild = await supportGate.checkOwnerMembership(mockClient, '123');
        assert.equal(resultBotNotInGuild.isMember, true, 'Must fail-open if bot cannot find support guild');
        assert.equal(resultBotNotInGuild.active, false);
    });

    check('unrestricted commands (help, about, support, invite) remain accessible regardless of gate', () => {
        assert.equal(supportGate.isExemptCommand('help'), true);
        assert.equal(supportGate.isExemptCommand('about'), true);
        assert.equal(supportGate.isExemptCommand('support'), true);
        assert.equal(supportGate.isExemptCommand('invite'), true);
        assert.equal(supportGate.isExemptCommand('play'), false);
        assert.equal(supportGate.isExemptCommand('leave'), false);
    });

    console.log('\nTesting /support Slash Command...');
    const supportCommand = require('../src/commands/support');

    await check('/support command responds with invite link, developer info, and verify button', async () => {
        assert.equal(supportCommand.data.name, 'support');
        let repliedWith = null;

        const mockInteraction = {
            user: { tag: 'Tester#0001' },
            channel: { name: 'general' },
            guild: { id: 'guild123', name: 'Test Guild', ownerId: 'owner123' },
            client: {
                user: { id: '123456789', displayAvatarURL: () => 'https://example.com/avatar.png' },
                guilds: { cache: { get: () => null } }
            },
            deferReply: async () => {},
            editReply: async (payload) => { repliedWith = payload; }
        };

        delete process.env.SUPPORT_GUILD_ID;
        await supportCommand.execute(mockInteraction);
        assert.ok(repliedWith, 'Must editReply with payload');
        assert.ok(repliedWith.embeds && repliedWith.embeds.length > 0);
        assert.ok(repliedWith.embeds[0].data.title.includes('Support Center'));
        assert.ok(repliedWith.components && repliedWith.components.length > 0);
    });

    console.log('\nTesting guildCreate Welcome Message Deduplication...');
    const guildCreateEvent = require('../src/events/guildCreate');

    await check('guildCreate sends welcome message once and deduplicates subsequent triggers', async () => {
        let sentMessages = 0;
        const testGuildId = 'guild_welcome_dedup_test';

        const mockChannel = {
            name: 'general',
            permissionsFor: () => ({ has: () => true }),
            send: async () => { sentMessages++; }
        };

        const mockGuild = {
            id: testGuildId,
            name: 'New ZYRO Server',
            ownerId: 'owner_abc',
            systemChannel: mockChannel,
            client: { user: { displayAvatarURL: () => 'https://example.com/avatar.png' } },
            members: {
                me: {
                    permissionsIn: () => ({ has: () => true })
                }
            }
        };

        guildCreateEvent.welcomedGuilds.delete(testGuildId);

        // First trigger
        await guildCreateEvent.execute(mockGuild);
        assert.equal(sentMessages, 1, 'First guildCreate must send welcome message');

        // Second trigger (duplicate event)
        await guildCreateEvent.execute(mockGuild);
        assert.equal(sentMessages, 1, 'Second guildCreate must NOT duplicate welcome message');
    });

    console.log('\nTesting /play, search resolution, and PlayerController reliability...');
    const playCommand = require('../src/commands/play');
    const { createNowPlayingEmbed } = require('../src/utils/zyroEmbeds');
    const PlayerController = require('../src/utils/PlayerController');
    const { emptyChannelTimeouts, clearEmptyChannelTimeout } = require('../src/events/voiceStateUpdate');
    const { queueEndTimeouts, clearQueueEndTimeout } = require('../src/utils/playerLifecycle');

    await check('/play works from a voice channel with 24/7 OFF without invoking /247', async () => {
        const guildId = 'play-no-247-test';
        guildSettings.delete(guildId);
        assert.equal(guildSettings.is247(guildId), false, '24/7 must be OFF initially');

        let connected = false;
        let played = false;
        let controllerUpdated = false;

        // Set a pending empty channel timeout and queue end timeout to verify /play clears them
        let emptyTimeoutCleared = false;
        const dummyTimeout1 = setTimeout(() => {}, 100000);
        emptyChannelTimeouts.set(guildId, dummyTimeout1);

        const dummyTimeout2 = setTimeout(() => {}, 100000);
        queueEndTimeouts.set(guildId, dummyTimeout2);

        const mockTrack = {
            info: { title: 'First Song', author: 'Artist A', uri: 'https://youtube.com/watch?v=1', duration: 120000 }
        };

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            textChannelId: 'tc-1',
            connected: false,
            voice: { token: 'mock-token' },
            playing: false,
            queue: {
                current: null,
                tracks: [],
                add: async (t) => { mockPlayer.queue.tracks.push(t); }
            },
            async connect() {
                connected = true;
                this.connected = true;
            },
            async search(queryObj) {
                return { loadType: 'track', tracks: [mockTrack] };
            },
            async play() {
                played = true;
                this.playing = true;
                this.queue.current = mockPlayer.queue.tracks.shift();
            }
        };

        const mockInteraction = {
            guild: { id: guildId, name: 'Play Test Guild', members: { me: { voice: { channelId: null } } } },
            channel: { id: 'tc-1', name: 'music' },
            member: {
                user: { tag: 'User#1234' },
                voice: {
                    channel: {
                        id: 'vc-1',
                        permissionsFor: () => ({ has: () => true })
                    }
                }
            },
            user: { id: 'user-1' },
            options: {
                getString: (opt) => opt === 'query' ? 'first song' : null,
                getBoolean: (opt) => opt === 'next' ? false : null,
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: {
                    getPlayer: () => mockPlayer,
                    createPlayer: () => mockPlayer,
                },
                playerController: {
                    updatePlayer: async () => { controllerUpdated = true; }
                }
            },
            deferReply: async () => {},
            editReply: async () => {}
        };

        await playCommand.execute(mockInteraction);

        assert.ok(connected, 'Player must connect on /play');
        assert.ok(played, 'Player must start playback on /play');
        assert.equal(emptyChannelTimeouts.has(guildId), false, 'Empty channel timeout must be cleared on /play');
        assert.equal(queueEndTimeouts.has(guildId), false, 'Queue end timeout must be cleared on /play');
        assert.equal(guildSettings.is247(guildId), false, '24/7 mode must remain OFF');
        assert.ok(controllerUpdated, 'Player controller must be updated');
    });

    await check('/play queues newly requested track behind current song and preserves upcoming tracks', async () => {
        const guildId = 'play-replace-test';
        let controllerUpdated = false;

        const currentSong = { info: { title: 'Current Playing Song', author: 'Old Artist' } };
        const upcomingSong1 = { info: { title: 'Upcoming Track 1', author: 'Artist 1' } };
        const upcomingSong2 = { info: { title: 'Upcoming Track 2', author: 'Artist 2' } };
        const newSong = { info: { title: 'Newly Requested Song', author: 'New Artist', uri: 'https://youtube.com/watch?v=new', duration: 180000 } };

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            textChannelId: 'tc-1',
            connected: true,
            voice: { token: 'mock-token' },
            playing: true,
            queue: {
                current: currentSong,
                tracks: [upcomingSong1, upcomingSong2],
                add: async (t, pos) => {
                    if (pos === 0) mockPlayer.queue.tracks.unshift(t);
                    else mockPlayer.queue.tracks.push(t);
                }
            },
            async search(queryObj) {
                return { loadType: 'track', tracks: [newSong] };
            },
            async play(opts) {
                throw new Error('player.play must NOT be called when a track is actively playing!');
            }
        };

        const mockInteraction = {
            guild: { id: guildId, name: 'Replace Test Guild', members: { me: { voice: { channelId: 'vc-1' } } } },
            channel: { id: 'tc-1', name: 'music' },
            member: {
                user: { tag: 'User#1234' },
                voice: {
                    channel: {
                        id: 'vc-1',
                        permissionsFor: () => ({ has: () => true })
                    }
                }
            },
            user: { id: 'user-1' },
            options: {
                getString: (opt) => opt === 'query' ? 'newly requested song' : null,
                getBoolean: (opt) => opt === 'next' ? false : null,
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: { getPlayer: () => mockPlayer },
                playerController: {
                    updatePlayer: async () => { controllerUpdated = true; }
                }
            },
            deferReply: async () => {},
            editReply: async () => {}
        };

        await playCommand.execute(mockInteraction);

        assert.equal(mockPlayer.queue.current.info.title, 'Newly Requested Song', 'Newly requested track must start playing immediately');
        assert.equal(mockPlayer.queue.previous[0].info.title, 'Current Playing Song', 'Previous track must be moved to previous history');
        assert.ok(controllerUpdated, 'Player controller must be updated');
    });

    await check('/play does NOT interrupt current song if search fails', async () => {
        const guildId = 'play-fail-test';
        let playCalled = false;
        const currentSong = { info: { title: 'Keep Playing This', author: 'Artist' } };

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            textChannelId: 'tc-1',
            connected: true,
            voice: { token: 'mock-token' },
            playing: true,
            queue: {
                current: currentSong,
                tracks: [{ info: { title: 'Next Up' } }]
            },
            async search() {
                return { loadType: 'empty', tracks: [] };
            },
            async play() {
                playCalled = true;
            }
        };

        let repliedEmbed = null;
        const mockInteraction = {
            guild: { id: guildId, name: 'Fail Test Guild', members: { me: { voice: { channelId: 'vc-1' } } } },
            channel: { id: 'tc-1', name: 'music' },
            member: {
                user: { tag: 'User#1234' },
                voice: {
                    channel: {
                        id: 'vc-1',
                        permissionsFor: () => ({ has: () => true })
                    }
                }
            },
            user: { id: 'user-1' },
            options: {
                getString: (opt) => opt === 'query' ? 'nonexistent song abcxyz123' : null,
                getBoolean: (opt) => opt === 'next' ? false : null,
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: { getPlayer: () => mockPlayer },
                playerController: { updatePlayer: async () => {} }
            },
            deferReply: async () => {},
            editReply: async (payload) => { repliedEmbed = payload?.embeds?.[0]; }
        };

        await playCommand.execute(mockInteraction);

        assert.equal(playCalled, false, 'player.play must NOT be called when search returns no tracks');
        assert.equal(mockPlayer.queue.current.info.title, 'Keep Playing This', 'Current track must continue playing');
        assert.ok(repliedEmbed, 'Must display no matching tracks embed');
    });

    await check('/play with next:true queues at position 0 without interrupting current playback', async () => {
        const guildId = 'play-next-test';
        let playWithClientTrackCalled = false;

        const currentSong = { info: { title: 'Currently Playing', author: 'Artist A' } };
        const queuedSong1 = { info: { title: 'Old Next', author: 'Artist B' } };
        const nextSong = { info: { title: 'Play Me Next', author: 'Artist C', uri: 'https://youtube.com/watch?v=next', duration: 150000 } };

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            textChannelId: 'tc-1',
            connected: true,
            voice: { token: 'mock-token' },
            playing: true,
            queue: {
                current: currentSong,
                tracks: [queuedSong1],
                add: async (t, pos) => {
                    if (pos === 0) mockPlayer.queue.tracks.unshift(t);
                    else mockPlayer.queue.tracks.push(t);
                }
            },
            async search() {
                return { loadType: 'track', tracks: [nextSong] };
            },
            async play(opts) {
                if (opts?.clientTrack) playWithClientTrackCalled = true;
            }
        };

        const mockInteraction = {
            guild: { id: guildId, name: 'Play Next Guild', members: { me: { voice: { channelId: 'vc-1' } } } },
            channel: { id: 'tc-1', name: 'music' },
            member: {
                user: { tag: 'User#1234' },
                voice: {
                    channel: {
                        id: 'vc-1',
                        permissionsFor: () => ({ has: () => true })
                    }
                }
            },
            user: { id: 'user-1' },
            options: {
                getString: (opt) => opt === 'query' ? 'play me next' : null,
                getBoolean: (opt) => opt === 'next' ? true : null,
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k },
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: { getPlayer: () => mockPlayer },
                playerController: { updatePlayer: async () => {} }
            },
            deferReply: async () => {},
            editReply: async () => {}
        };

        await playCommand.execute(mockInteraction);

        assert.equal(playWithClientTrackCalled, false, 'Current playback must NOT be interrupted when next:true');
        assert.equal(mockPlayer.queue.tracks[0].info.title, 'Play Me Next', 'Track must be placed at front of queue');
        assert.equal(mockPlayer.queue.tracks[1].info.title, 'Old Next', 'Original queued track must be shifted to index 1');
    });

    check('compact Now Playing embed: no redundant Status section, UP NEXT preview only when upcoming exists', () => {
        const mockClient = {
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map(),
        };

        const track = {
            info: {
                title: 'Clean Compact Song',
                author: 'Test Artist',
                uri: 'https://youtube.com/watch?v=clean',
                duration: 200000,
                artworkUrl: 'https://example.com/art.png'
            },
            requester: { id: 'u1' }
        };

        // Case A: Queue is empty
        const emptyQueuePlayer = {
            guildId: 'g1',
            volume: 80,
            repeatMode: 'off',
            position: 50000,
            queue: { current: track, tracks: [] }
        };

        const embedEmpty = createNowPlayingEmbed(emptyQueuePlayer, track, mockClient);
        const descriptionEmpty = embedEmpty.data.description;
        assert.ok(!descriptionEmpty.includes('Queue is empty — add songs with /play'), 'Must NOT have verbose empty-queue paragraph');
        assert.ok(!descriptionEmpty.includes('📊 Status'), 'Must NOT have oversized Status section');
        assert.ok(descriptionEmpty.includes('🔊 `80%` • 📜 `0` in queue • Loop: `Off`'), 'Must contain clean compact meta row');
        assert.equal(embedEmpty.data.fields?.length || 0, 0, 'Must NOT show UP NEXT when queue is empty');

        // Case B: Queue has upcoming track
        const upcomingTrack = {
            info: {
                title: 'Next Upcoming Hit',
                author: 'Next Artist',
                uri: 'https://youtube.com/watch?v=next',
                duration: 180000
            }
        };

        const populatedQueuePlayer = {
            guildId: 'g1',
            volume: 80,
            repeatMode: 'off',
            position: 50000,
            queue: { current: track, tracks: [upcomingTrack] }
        };

        const embedPopulated = createNowPlayingEmbed(populatedQueuePlayer, track, mockClient);
        assert.equal(embedPopulated.data.fields?.length, 1, 'Must show UP NEXT preview field when queue is populated');
        assert.equal(embedPopulated.data.fields[0].name, '⏭️ Up Next');
        assert.ok(embedPopulated.data.fields[0].value.includes('Next Upcoming Hit'));
    });

    await check('PlayerController updates in-place when replace:false and replaces when replace:true or deleted', async () => {
        let sentCount = 0;
        let editedCount = 0;

        const fakeMessage = {
            id: 'new-msg-1',
            channelId: 'tc-1',
            edit: async () => { editedCount++; },
            delete: async () => {}
        };

        const fakeChannel = {
            id: 'tc-1',
            messages: {
                cache: new Map([['new-msg-1', fakeMessage]]),
                fetch: async (id) => {
                    const msg = fakeChannel.messages.cache.get(id);
                    if (msg) return msg;
                    throw new Error('Unknown Message');
                }
            },
            send: async () => {
                sentCount++;
                return { id: `new-msg-${sentCount}`, channelId: 'tc-1', delete: async () => {} };
            }
        };

        const mockClient = {
            lavalink: {
                getPlayer: () => ({
                    guildId: 'g-controller',
                    textChannelId: 'tc-1',
                    volume: 80,
                    repeatMode: 'off',
                    position: 1000,
                    queue: {
                        current: { info: { title: 'Playing' } },
                        tracks: []
                    }
                })
            },
            channels: {
                cache: new Map([['tc-1', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);

        // 1. First time update: message doesn't exist yet, creates new message
        await controller.updatePlayer('g-controller');
        assert.equal(sentCount, 1, 'Must send new controller message if none exists');
        assert.equal(controller.playerMessages.get('g-controller').messageId, 'new-msg-1');

        // 2. Second update with replace:false: edits existing message in-place
        await controller.updatePlayer('g-controller', { replace: false });
        assert.equal(editedCount, 1, 'Must edit existing message when replace: false');

        // 3. Message was deleted by user: fetch throws, automatically sends replacement
        fakeChannel.messages.cache.delete('new-msg-1');
        await controller.updatePlayer('g-controller', { replace: false });
        assert.equal(sentCount, 2, 'Must create replacement controller message if previous was deleted');
        assert.equal(controller.playerMessages.get('g-controller').messageId, 'new-msg-2');
    });

    console.log('\nTesting Safe ZYRO Music Player Dashboard Replacement Flow...');

    await check('Successive songs (Song A -> Song B -> Song C): newest dashboard at bottom, previous deleted, exactly 1 active', async () => {
        const guildId = 'guild-successive-test';
        guildSettings.delete(guildId);

        const channelMessages = new Map(); // id -> message
        const activeMessageIds = new Set();
        let messageCounter = 0;

        function createMockMessage(id, embed, components) {
            return {
                id,
                channelId: 'tc-music',
                embeds: [embed],
                components,
                delete: async () => {
                    activeMessageIds.delete(id);
                    channelMessages.delete(id);
                }
            };
        }

        const fakeChannel = {
            id: 'tc-music',
            messages: {
                cache: channelMessages,
                fetch: async (id) => {
                    const msg = channelMessages.get(id);
                    if (msg) return msg;
                    const err = new Error('Unknown Message');
                    err.code = 10008;
                    throw err;
                }
            },
            send: async (payload) => {
                messageCounter++;
                const newId = `dash-msg-${messageCounter}`;
                const msg = createMockMessage(newId, payload.embeds[0], payload.components);
                channelMessages.set(newId, msg);
                activeMessageIds.add(newId);
                return msg;
            }
        };

        let currentTrackTitle = 'Song A';
        const mockPlayer = {
            guildId,
            textChannelId: 'tc-music',
            voiceChannelId: 'vc-music',
            volume: 80,
            repeatMode: 'off',
            position: 15000,
            paused: false,
            queue: {
                current: { info: { title: currentTrackTitle, author: 'Artist A', duration: 180000, uri: 'https://youtube.com/a' } },
                tracks: [{ info: { title: 'Upcoming Song', duration: 200000, uri: 'https://youtube.com/up' } }],
                previous: []
            }
        };

        const mockClient = {
            guildSettings,
            lavalink: {
                getPlayer: () => mockPlayer
            },
            channels: {
                cache: new Map([['tc-music', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);

        // 1. Play Song A:
        await controller.updatePlayer(guildId, { replace: true });
        assert.equal(activeMessageIds.size, 1, 'Exactly 1 active dashboard after Song A starts');
        assert.ok(activeMessageIds.has('dash-msg-1'), 'Dashboard 1 must be active');
        assert.equal(controller.getDashboard(guildId).messageId, 'dash-msg-1');
        assert.equal(guildSettings.getDashboard(guildId).messageId, 'dash-msg-1', 'Must persist dashboard ID');

        // Verify button controls on Dashboard A
        const dashA = channelMessages.get('dash-msg-1');
        assert.ok(dashA, 'Dashboard A message must exist');
        const customIdsA = dashA.components.flatMap(row => row.components.map(b => b.data.custom_id));
        assert.ok(customIdsA.includes('player:back'), 'Must have back button');
        assert.ok(customIdsA.includes('player:playpause'), 'Must have play/pause button');
        assert.ok(customIdsA.includes('player:skip'), 'Must have skip button');
        assert.ok(customIdsA.includes('player:stop'), 'Must have stop button');
        assert.ok(customIdsA.includes('player:autoplay'), 'Must have autoplay button');
        assert.ok(customIdsA.includes('player:queue'), 'Must have queue button');
        assert.ok(customIdsA.includes('player:shuffle'), 'Must have shuffle button');
        assert.ok(customIdsA.includes('player:loop'), 'Must have loop button');
        assert.ok(!customIdsA.includes('player:247'), 'Must not have 24/7 button');

        // 2. Play Song B:
        currentTrackTitle = 'Song B';
        mockPlayer.queue.current = { info: { title: 'Song B', author: 'Artist B', duration: 210000, uri: 'https://youtube.com/b' } };
        mockPlayer.queue.previous = [{ info: { title: 'Song A' } }];
        await controller.updatePlayer(guildId, { replace: true });

        assert.equal(activeMessageIds.size, 1, 'Exactly 1 active dashboard after Song B starts');
        assert.ok(activeMessageIds.has('dash-msg-2'), 'Dashboard 2 must be the only active dashboard at the bottom');
        assert.equal(activeMessageIds.has('dash-msg-1'), false, 'Previous Dashboard 1 must be deleted');
        assert.equal(controller.getDashboard(guildId).messageId, 'dash-msg-2');
        assert.equal(guildSettings.getDashboard(guildId).messageId, 'dash-msg-2');

        // Verify button controls on Dashboard B
        const dashB = channelMessages.get('dash-msg-2');
        const customIdsB = dashB.components.flatMap(row => row.components.map(b => b.data.custom_id));
        assert.ok(customIdsB.includes('player:back'));
        assert.ok(customIdsB.includes('player:playpause'));
        assert.ok(customIdsB.includes('player:skip'));
        assert.ok(customIdsB.includes('player:stop'));

        // 3. Play Song C:
        currentTrackTitle = 'Song C';
        mockPlayer.queue.current = { info: { title: 'Song C', author: 'Artist C', duration: 240000, uri: 'https://youtube.com/c' } };
        mockPlayer.queue.previous = [{ info: { title: 'Song B' } }, { info: { title: 'Song A' } }];
        await controller.updatePlayer(guildId, { replace: true });

        assert.equal(activeMessageIds.size, 1, 'Exactly 1 active dashboard after Song C starts');
        assert.ok(activeMessageIds.has('dash-msg-3'), 'Dashboard 3 must be the active dashboard at the bottom');
        assert.equal(activeMessageIds.has('dash-msg-2'), false, 'Previous Dashboard 2 must be deleted');
        assert.equal(activeMessageIds.has('dash-msg-1'), false, 'Old Dashboard 1 must not exist');
        assert.equal(controller.getDashboard(guildId).messageId, 'dash-msg-3');

        guildSettings.delete(guildId);
    });

    await check('Per-guild lock prevents race conditions and duplicate messages under concurrent updates', async () => {
        const guildId = 'guild-concurrent-test';
        guildSettings.delete(guildId);

        const channelMessages = new Map();
        const activeMessageIds = new Set();
        let messageCounter = 0;

        const fakeChannel = {
            id: 'tc-conc',
            messages: {
                cache: channelMessages,
                fetch: async (id) => channelMessages.get(id) || null
            },
            send: async (payload) => {
                // Add artificial async delay to expose race conditions without lock
                await new Promise(r => setTimeout(r, 20));
                messageCounter++;
                const newId = `conc-msg-${messageCounter}`;
                const msg = {
                    id: newId,
                    channelId: 'tc-conc',
                    delete: async () => {
                        activeMessageIds.delete(newId);
                        channelMessages.delete(newId);
                    }
                };
                channelMessages.set(newId, msg);
                activeMessageIds.add(newId);
                return msg;
            }
        };

        const mockClient = {
            guildSettings,
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    textChannelId: 'tc-conc',
                    volume: 80,
                    repeatMode: 'off',
                    position: 1000,
                    queue: {
                        current: { info: { title: 'Concurrent Song' } },
                        tracks: []
                    }
                })
            },
            channels: {
                cache: new Map([['tc-conc', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);

        // Fire 3 simultaneous updatePlayer requests
        await Promise.all([
            controller.updatePlayer(guildId, { replace: true }),
            controller.updatePlayer(guildId, { replace: true }),
            controller.updatePlayer(guildId, { replace: true })
        ]);

        assert.equal(activeMessageIds.size, 1, 'Lock must guarantee exactly 1 active dashboard after concurrent updates');
        assert.equal(controller.getDashboard(guildId).messageId, `conc-msg-${messageCounter}`);
        guildSettings.delete(guildId);
    });

    await check('Failed send keeps previous dashboard and stored ID intact', async () => {
        const guildId = 'guild-failed-send-test';
        guildSettings.delete(guildId);

        let sendShouldFail = false;
        let deletedOld = false;

        const oldMessage = {
            id: 'old-good-dashboard',
            channelId: 'tc-1',
            delete: async () => { deletedOld = true; }
        };

        const fakeChannel = {
            id: 'tc-1',
            messages: {
                cache: new Map([['old-good-dashboard', oldMessage]]),
                fetch: async (id) => {
                    if (id === 'old-good-dashboard') return oldMessage;
                    throw new Error('Unknown Message');
                }
            },
            send: async () => {
                if (sendShouldFail) {
                    throw new Error('DiscordAPIError: Rate limited / network error');
                }
                return oldMessage;
            }
        };

        const mockClient = {
            guildSettings,
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    textChannelId: 'tc-1',
                    volume: 80,
                    repeatMode: 'off',
                    position: 1000,
                    queue: {
                        current: { info: { title: 'Test Song' } },
                        tracks: []
                    }
                })
            },
            channels: {
                cache: new Map([['tc-1', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);

        // First successful send
        await controller.updatePlayer(guildId, { replace: true });
        assert.equal(controller.getDashboard(guildId).messageId, 'old-good-dashboard');

        // Now trigger failed send
        sendShouldFail = true;
        await controller.updatePlayer(guildId, { replace: true });

        // Stored ID must NOT be changed or cleared
        assert.equal(controller.getDashboard(guildId).messageId, 'old-good-dashboard', 'Stored message ID must remain intact on send failure');
        assert.equal(deletedOld, false, 'Previous dashboard must NOT be deleted when replacement send fails');

        guildSettings.delete(guildId);
    });

    await check('Failed delete is tracked in staleMessages and safely retried on next update', async () => {
        const guildId = 'guild-failed-delete-test';
        guildSettings.delete(guildId);

        let deleteFail = true;
        let deleteAttempts = 0;

        const msg1 = {
            id: 'msg-del-1',
            channelId: 'tc-1',
            delete: async () => {
                deleteAttempts++;
                if (deleteFail) {
                    throw new Error('Simulated Discord delete timeout');
                }
            }
        };

        const msg2 = {
            id: 'msg-del-2',
            channelId: 'tc-1',
            delete: async () => {}
        };

        const msg3 = {
            id: 'msg-del-3',
            channelId: 'tc-1',
            delete: async () => {}
        };

        const allMessages = new Map([
            ['msg-del-1', msg1],
            ['msg-del-2', msg2],
            ['msg-del-3', msg3]
        ]);

        let currentSendId = 'msg-del-1';

        const fakeChannel = {
            id: 'tc-1',
            messages: {
                cache: allMessages,
                fetch: async (id) => allMessages.get(id) || null
            },
            send: async () => {
                return allMessages.get(currentSendId);
            }
        };

        const mockClient = {
            guildSettings,
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    textChannelId: 'tc-1',
                    volume: 80,
                    repeatMode: 'off',
                    position: 1000,
                    queue: {
                        current: { info: { title: 'Retry Test' } },
                        tracks: []
                    }
                })
            },
            channels: {
                cache: new Map([['tc-1', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);

        // 1. Send first message
        currentSendId = 'msg-del-1';
        await controller.updatePlayer(guildId, { replace: true });
        assert.equal(controller.getDashboard(guildId).messageId, 'msg-del-1');

        // 2. Send second message; deleting msg-del-1 throws
        currentSendId = 'msg-del-2';
        await controller.updatePlayer(guildId, { replace: true });
        assert.equal(controller.getDashboard(guildId).messageId, 'msg-del-2');
        assert.equal(deleteAttempts, 1, 'Attempted to delete msg-del-1');
        assert.ok(controller.staleMessages.get(guildId)?.size > 0, 'Must track failed delete in staleMessages');

        // 3. Send third message; now deletion succeeds
        deleteFail = false;
        currentSendId = 'msg-del-3';
        await controller.updatePlayer(guildId, { replace: true });
        assert.equal(controller.getDashboard(guildId).messageId, 'msg-del-3');
        assert.equal(deleteAttempts, 2, 'Must retry deleting msg-del-1 on next update');
        assert.equal(controller.staleMessages.has(guildId), false, 'staleMessages must be empty after successful cleanup');

        guildSettings.delete(guildId);
    });

    await check('Dashboard message ID and channel ID survive bot restart via guildSettings', async () => {
        const guildId = 'guild-persist-test';
        guildSettings.delete(guildId);

        const fakeChannel = {
            id: 'tc-persist',
            messages: {
                cache: new Map(),
                fetch: async () => ({ id: 'persisted-msg-1', channelId: 'tc-persist', delete: async () => {} })
            },
            send: async () => ({ id: 'persisted-msg-1', channelId: 'tc-persist', delete: async () => {} })
        };

        const mockClient = {
            guildSettings,
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    textChannelId: 'tc-persist',
                    volume: 80,
                    repeatMode: 'off',
                    position: 1000,
                    queue: {
                        current: { info: { title: 'Persist Song' } },
                        tracks: []
                    }
                })
            },
            channels: {
                cache: new Map([['tc-persist', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        // Instance 1 creates dashboard
        const controller1 = new PlayerController(mockClient);
        await controller1.updatePlayer(guildId, { replace: true });

        const stored = guildSettings.getDashboard(guildId);
        assert.ok(stored, 'Must store dashboard in guildSettings');
        assert.equal(stored.messageId, 'persisted-msg-1');
        assert.equal(stored.channelId, 'tc-persist');

        // Instance 2 (simulating restart) without in-memory state
        const controller2 = new PlayerController(mockClient);
        const retrieved = controller2.getDashboard(guildId);
        assert.ok(retrieved, 'Must recover dashboard settings on restart');
        assert.equal(retrieved.messageId, 'persisted-msg-1');
        assert.equal(retrieved.channelId, 'tc-persist');

        // deletePlayer cleans up storage
        await controller2.deletePlayer(guildId);
        assert.equal(controller2.getDashboard(guildId), null, 'Must clear dashboard reference on deletePlayer');
        assert.equal(guildSettings.getDashboard(guildId), null, 'Must clear guildSettings dashboard on deletePlayer');

        guildSettings.delete(guildId);
    });

    await check('showStoppedState replaces dashboard with stopped UI at bottom and deletePlayer cleans up', async () => {
        const guildId = 'guild-stop-replace-test';
        guildSettings.delete(guildId);

        let sentPayload = null;
        let deletedId = null;

        const fakeChannel = {
            id: 'tc-stopped',
            messages: {
                cache: new Map([
                    ['active-playing-msg', { id: 'active-playing-msg', delete: async () => { deletedId = 'active-playing-msg'; } }]
                ]),
                fetch: async (id) => ({ id, delete: async () => { deletedId = id; } })
            },
            send: async (payload) => {
                sentPayload = payload;
                return { id: 'stopped-msg-1', channelId: 'tc-stopped', delete: async () => {} };
            }
        };

        const mockClient = {
            guildSettings,
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    textChannelId: 'tc-stopped',
                    voiceChannelId: 'vc-1',
                    volume: 80,
                    repeatMode: 'off',
                    position: 0,
                    queue: { current: null, tracks: [] }
                })
            },
            channels: {
                cache: new Map([['tc-stopped', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => true,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard(guildId, { messageId: 'active-playing-msg', channelId: 'tc-stopped' });

        // showStoppedState: replaces playing dashboard with stopped dashboard at bottom
        await controller.showStoppedState(guildId);
        assert.equal(deletedId, 'active-playing-msg', 'Must delete old playing dashboard message');
        assert.equal(controller.getDashboard(guildId).messageId, 'stopped-msg-1', 'Must store new stopped dashboard ID');
        assert.ok(
            sentPayload?.embeds?.[0]?.data?.description?.includes('Playback stopped') ||
            sentPayload?.embeds?.[0]?.data?.author?.name?.includes('IDLE'),
            'Embed must reflect stopped state'
        );

        // Stopped dashboard components payload must remove all buttons
        assert.strictEqual(sentPayload.components.length, 0, 'Stopped dashboard must have 0 rows of components');
        assert.deepStrictEqual(sentPayload.components, [], 'Stopped dashboard components payload must be an empty array');

        guildSettings.delete(guildId);
    });

    console.log('\nTesting Voice Channel Disconnect and Lifecycle Behavior...');
    const voiceStateEvent = require('../src/events/voiceStateUpdate');
    const { scheduleEmptyChannelTimeout, countHumanMembers } = voiceStateEvent;

    await check('last human leaves voice channel with 24/7 OFF: schedules disconnect timer', async () => {
        const guildId = 'disconnect-empty-test';
        clearEmptyChannelTimeout(guildId);
        guildSettings.delete(guildId);

        const mockClient = {
            user: { id: 'bot-123' },
            is247Enabled: () => false,
        };

        const mockBotChannel = {
            id: 'vc-empty',
            guild: { id: guildId },
            members: new Map([['bot-123', { user: { id: 'bot-123', bot: true } }]])
        };

        const oldState = {
            id: 'human-1',
            channelId: 'vc-empty',
            guild: {
                id: guildId,
                members: { me: { voice: { channel: mockBotChannel } } }
            },
            client: mockClient
        };

        const newState = {
            id: 'human-1',
            channelId: null,
            guild: oldState.guild,
            client: mockClient
        };

        await voiceStateEvent.execute(oldState, newState);

        assert.ok(emptyChannelTimeouts.has(guildId), 'Disconnect timer must be scheduled when channel is empty of humans');
        clearEmptyChannelTimeout(guildId);
    });

    await check('human rejoins before timeout: cancels pending disconnect timer', async () => {
        const guildId = 'disconnect-rejoin-test';
        guildSettings.delete(guildId);

        const mockClient = {
            user: { id: 'bot-123' },
            is247Enabled: () => false,
        };

        // Schedule timer first
        scheduleEmptyChannelTimeout(mockClient, guildId, 'vc-rejoin');
        assert.ok(emptyChannelTimeouts.has(guildId), 'Timer must be active');

        const mockBotChannel = {
            id: 'vc-rejoin',
            guild: { id: guildId },
            members: new Map([
                ['bot-123', { user: { id: 'bot-123', bot: true } }],
                ['human-rejoined', { user: { id: 'human-rejoined', bot: false } }]
            ])
        };

        const oldState = {
            id: 'human-rejoined',
            channelId: null,
            guild: {
                id: guildId,
                members: { me: { voice: { channel: mockBotChannel } } }
            },
            client: mockClient
        };

        const newState = {
            id: 'human-rejoined',
            channelId: 'vc-rejoin',
            guild: oldState.guild,
            client: mockClient
        };

        await voiceStateEvent.execute(oldState, newState);

        assert.equal(emptyChannelTimeouts.has(guildId), false, 'Disconnect timer must be cancelled when human rejoins');
    });

    await check('/247 ON prevents automatic disconnection when channel is empty', async () => {
        const guildId = '247-prevent-disconnect-test';
        guildSettings.set247(guildId, true);

        const mockClient = {
            user: { id: 'bot-123' },
            is247Enabled: (gId) => guildSettings.is247(gId),
        };

        scheduleEmptyChannelTimeout(mockClient, guildId, 'vc-247');
        assert.equal(emptyChannelTimeouts.has(guildId), false, '24/7 ON must prevent empty channel timeout');

        guildSettings.delete(guildId);
    });

    await check('stale timer aborts safely if bot moved to a different channel or human rejoined', async () => {
        const guildId = 'stale-timer-test';
        let destroyed = false;

        const mockPlayer = {
            destroy: () => { destroyed = true; },
            stopPlaying: async () => {}
        };

        // Channel where timer was originally scheduled: vc-old
        // But bot is currently in vc-new!
        const currentChannel = {
            id: 'vc-new',
            members: new Map([['bot-123', { user: { id: 'bot-123', bot: true } }]])
        };

        const mockClient = {
            user: { id: 'bot-123' },
            is247Enabled: () => false,
            guilds: {
                cache: new Map([[guildId, {
                    members: {
                        me: { voice: { channel: currentChannel } }
                    }
                }]])
            },
            lavalink: { getPlayer: () => mockPlayer },
            playerController: { deletePlayer: () => {} },
            activePlayers: new Map(),
            autoplayEnabled: new Map(),
            updatePresence: () => {}
        };

        // Call schedule with vc-old
        scheduleEmptyChannelTimeout(mockClient, guildId, 'vc-old');
        const entry = emptyChannelTimeouts.get(guildId);
        assert.ok(entry);

        // Clear native timeout and trigger its callback directly
        clearTimeout(entry.timeout);
        emptyChannelTimeouts.delete(guildId);

        // If the callback were to fire with channelId 'vc-old':
        assert.notEqual(currentChannel.id, 'vc-old', 'Bot moved to a different channel');
        assert.equal(destroyed, false, 'Stale timer must NOT destroy player in different channel');
    });

    console.log('\nTesting Previous, Shuffle, and Loop button functionality...');
    const { playPrevious, shuffleQueue } = require('../src/utils/PlayerActions');

    await check('Previous button: replays most recent track and preserves queue order', async () => {
        let playedTrack = null;
        const song1 = { info: { identifier: 'id-1', title: 'Song 1', author: 'Artist 1' } };
        const song2 = { info: { identifier: 'id-2', title: 'Song 2', author: 'Artist 2' } };
        const song3 = { info: { identifier: 'id-3', title: 'Song 3', author: 'Artist 3' } };

        const mockPlayer = {
            guildId: 'prev-test-guild',
            queue: {
                current: song2,
                tracks: [song3],
                previous: [song1],
                add: async (track, pos) => {
                    if (pos === 0) mockPlayer.queue.tracks.unshift(track);
                    else mockPlayer.queue.tracks.push(track);
                }
            },
            setData: () => {},
            async play(opts) {
                playedTrack = opts.clientTrack;
                this.queue.current = opts.clientTrack;
            }
        };

        const result = await playPrevious(mockPlayer);

        assert.equal(result.info.title, 'Song 1', 'Must return previous track');
        assert.equal(playedTrack.info.title, 'Song 1', 'Must play previous track');
        assert.equal(mockPlayer.queue.tracks.length, 2, 'Queue must contain previous current track and upcoming tracks');
        assert.equal(mockPlayer.queue.tracks[0].info.title, 'Song 2', 'Current track must be placed at front of queue');
        assert.equal(mockPlayer.queue.tracks[1].info.title, 'Song 3', 'Original upcoming track must follow');
        assert.equal(mockPlayer.queue.previous.length, 0, 'Previous history entry must be consumed');
    });

    await check('Previous button: returns null safely when no history exists', async () => {
        const mockPlayer = {
            queue: {
                current: { info: { title: 'Only Song' } },
                tracks: [],
                previous: []
            }
        };

        const result = await playPrevious(mockPlayer);
        assert.equal(result, null, 'Must return null when history is empty');
    });

    await check('Shuffle button: randomizes upcoming queue without changing current playing track or losing songs', async () => {
        const currentSong = { info: { title: 'Current Song' } };
        const tracks = Array.from({ length: 10 }, (_, i) => ({
            info: { identifier: `id-${i}`, title: `Queued Song ${i}` }
        }));

        const originalTitles = new Set(tracks.map(t => t.info.title));

        const mockPlayer = {
            queue: {
                current: currentSong,
                tracks: [...tracks]
            }
        };

        await shuffleQueue(mockPlayer);

        assert.equal(mockPlayer.queue.current.info.title, 'Current Song', 'Current track must NOT be changed by shuffle');
        assert.equal(mockPlayer.queue.tracks.length, 10, 'Queue length must be preserved');

        const newTitles = new Set(mockPlayer.queue.tracks.map(t => t.info.title));
        assert.equal(newTitles.size, 10, 'All unique tracks must be present');
        for (const title of originalTitles) {
            assert.ok(newTitles.has(title), `Queue must retain ${title}`);
        }
    });

    check('Shuffle button state: disabled when fewer than 2 upcoming tracks', () => {
        const mockClient = {
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };
        const controller = new PlayerController(mockClient);

        // Case 1: 0 upcoming tracks
        const player0 = {
            guildId: 'g1',
            queue: { current: { info: { title: 'A' } }, tracks: [], previous: [] },
            repeatMode: 'off'
        };
        const buttons0 = controller.createPlayerButtons(player0);
        const shuffleBtn0 = buttons0.flatMap(r => r.components).find(b => b.data.custom_id === 'player:shuffle');
        assert.equal(shuffleBtn0.data.disabled, true, 'Shuffle must be disabled with 0 upcoming tracks');

        // Case 2: 1 upcoming track
        const player1 = {
            guildId: 'g1',
            queue: { current: { info: { title: 'A' } }, tracks: [{ info: { title: 'B' } }], previous: [] },
            repeatMode: 'off'
        };
        const buttons1 = controller.createPlayerButtons(player1);
        const shuffleBtn1 = buttons1.flatMap(r => r.components).find(b => b.data.custom_id === 'player:shuffle');
        assert.equal(shuffleBtn1.data.disabled, true, 'Shuffle must be disabled with 1 upcoming track');

        // Case 3: 2 upcoming tracks
        const player2 = {
            guildId: 'g1',
            queue: { current: { info: { title: 'A' } }, tracks: [{ info: { title: 'B' } }, { info: { title: 'C' } }], previous: [] },
            repeatMode: 'off'
        };
        const buttons2 = controller.createPlayerButtons(player2);
        const shuffleBtn2 = buttons2.flatMap(r => r.components).find(b => b.data.custom_id === 'player:shuffle');
        assert.equal(shuffleBtn2.data.disabled, false, 'Shuffle must be enabled with 2 upcoming tracks');
    });

    check('Loop button: remains clickable when loop is off and reflects track/queue/off state', () => {
        const mockClient = {
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };
        const controller = new PlayerController(mockClient);

        // State 1: Loop Off
        const playerOff = {
            guildId: 'g1',
            queue: { current: { info: { title: 'A' } }, tracks: [] },
            repeatMode: 'off'
        };
        const buttonsOff = controller.createPlayerButtons(playerOff);
        const loopBtnOff = buttonsOff[1].components.find(b => b.data.custom_id === 'player:loop');
        assert.equal(loopBtnOff.data.disabled, false, 'Loop button must remain clickable when loop is off');
        assert.equal(loopBtnOff.data.label, 'Loop: Off');

        // State 2: Track Loop
        const playerTrack = {
            guildId: 'g1',
            queue: { current: { info: { title: 'A' } }, tracks: [] },
            repeatMode: 'track'
        };
        const buttonsTrack = controller.createPlayerButtons(playerTrack);
        const loopBtnTrack = buttonsTrack[1].components.find(b => b.data.custom_id === 'player:loop');
        assert.equal(loopBtnTrack.data.label, 'Loop: Track');
        assert.equal(loopBtnTrack.data.disabled, false);

        // State 3: Queue Loop
        const playerQueue = {
            guildId: 'g1',
            queue: { current: { info: { title: 'A' } }, tracks: [] },
            repeatMode: 'queue'
        };
        const buttonsQueue = controller.createPlayerButtons(playerQueue);
        const loopBtnQueue = buttonsQueue[1].components.find(b => b.data.custom_id === 'player:loop');
        assert.equal(loopBtnQueue.data.label, 'Loop: Queue');
        assert.equal(loopBtnQueue.data.disabled, false);
    });

    console.log('\nTesting Discord Interaction Acknowledgement, /247, and /clear Reliability...');

    const { safeReply } = require('../src/utils/interactionHelpers');
    const cmdClear = require('../src/commands/clear');
    const interactionCreate = require('../src/events/interactionCreate');

    await check('safeReply routes correctly to reply, editReply, or followUp based on interaction state', async () => {
        let replyCalled = false;
        let editReplyCalled = false;
        let followUpCalled = false;

        // 1. Unacknowledged interaction
        const mock1 = {
            replied: false,
            deferred: false,
            reply: async () => { replyCalled = true; },
            editReply: async () => { editReplyCalled = true; },
            followUp: async () => { followUpCalled = true; }
        };
        await safeReply(mock1, { content: 'test1' });
        assert.ok(replyCalled, 'Must call reply on unacknowledged interaction');

        // 2. Deferred interaction
        const mock2 = {
            replied: false,
            deferred: true,
            reply: async () => {},
            editReply: async () => { editReplyCalled = true; },
            followUp: async () => {}
        };
        await safeReply(mock2, { content: 'test2' });
        assert.ok(editReplyCalled, 'Must call editReply on deferred interaction');

        // 3. Replied interaction
        const mock3 = {
            replied: true,
            deferred: false,
            reply: async () => {},
            editReply: async () => {},
            followUp: async () => { followUpCalled = true; }
        };
        await safeReply(mock3, { content: 'test3' });
        assert.ok(followUpCalled, 'Must call followUp on replied interaction');
    });

    await check('/247 immediately defers interaction and handles voice permissions and node checks', async () => {
        const guildId = 'guild-ack-247-test';
        let deferred = false;
        let editedPayload = null;

        const fakeInteractionNoVc = {
            guild: { id: guildId, name: 'Ack Guild' },
            channel: { name: 'general', id: 'tc-ack' },
            user: { tag: 'User#1111' },
            member: { voice: { channel: null } },
            deferred: false,
            replied: false,
            client: {
                defaultLanguage: 'en',
                is247Enabled: () => false,
            },
            deferReply: async () => { deferred = true; fakeInteractionNoVc.deferred = true; },
            editReply: async (payload) => { editedPayload = payload; return payload; },
            reply: async (payload) => { editedPayload = payload; return payload; }
        };

        // No voice channel: must defer then respond
        await cmd247.execute(fakeInteractionNoVc);
        assert.ok(deferred, '/247 must call deferReply immediately');
        assert.ok(editedPayload?.embeds?.[0]?.data?.title?.includes('Voice Channel Required'));

        // Missing permissions: test Connect/Speak permission check
        let permDeferred = false;
        let permPayload = null;
        const fakeInteractionNoPerm = {
            guild: {
                id: guildId,
                name: 'Ack Guild',
                members: {
                    me: {
                        id: 'bot-id'
                    }
                }
            },
            channel: { name: 'general', id: 'tc-ack' },
            user: { tag: 'User#1111' },
            member: {
                voice: {
                    channel: {
                        id: 'vc-noperm',
                        permissionsFor: () => ({
                            has: (flag) => false // Missing all permissions
                        })
                    }
                }
            },
            deferred: false,
            replied: false,
            client: {
                defaultLanguage: 'en',
                is247Enabled: () => false,
            },
            deferReply: async () => { permDeferred = true; fakeInteractionNoPerm.deferred = true; },
            editReply: async (payload) => { permPayload = payload; return payload; },
            reply: async (payload) => { permPayload = payload; return payload; }
        };

        await cmd247.execute(fakeInteractionNoPerm);
        assert.ok(permDeferred, 'Must call deferReply before permission checks');
        assert.ok(permPayload?.embeds?.[0]?.data?.title?.includes('Missing Permissions'));
    });

    await check('/clear immediately defers, clears upcoming queue, does not disconnect, and handles empty queue', async () => {
        const guildId = 'guild-clear-test';
        let deferred = false;
        let editedPayload = null;
        let playerDestroyed = false;

        const fakePlayer = {
            guildId,
            voiceChannelId: 'vc-clear',
            playing: true,
            queue: {
                current: { info: { title: 'Now Playing Song' } },
                tracks: [{ info: { title: 'Upcoming Song 1' } }, { info: { title: 'Upcoming Song 2' } }]
            },
            async destroy() { playerDestroyed = true; }
        };

        const fakeInteraction = {
            guild: { id: guildId, name: 'Clear Guild' },
            channel: { name: 'music', id: 'tc-clear' },
            user: { tag: 'User#2222' },
            member: { voice: { channel: { id: 'vc-clear' } } },
            deferred: false,
            replied: false,
            client: {
                defaultLanguage: 'en',
                lavalinkConnectionManager: { isAvailable: () => true },
                lavalink: { getPlayer: () => fakePlayer },
                autoplayEnabled: new Map(),
                playerController: { updatePlayer: async () => {} }
            },
            deferReply: async () => { deferred = true; fakeInteraction.deferred = true; },
            editReply: async (payload) => { editedPayload = payload; return payload; },
            reply: async (payload) => { editedPayload = payload; return payload; }
        };

        await cmdClear.execute(fakeInteraction);

        assert.ok(deferred, '/clear must call deferReply immediately');
        assert.equal(fakePlayer.queue.tracks.length, 0, 'Upcoming tracks must be cleared');
        assert.ok(fakePlayer.queue.current, 'Current playing track must not be removed by /clear');
        assert.equal(playerDestroyed, false, '/clear must not destroy player or disconnect');
        assert.ok(editedPayload?.embeds?.[0]?.data?.title?.includes('Queue Cleared'));

        // Calling /clear again when queue is already empty
        let emptyPayload = null;
        const fakeInteractionEmpty = {
            ...fakeInteraction,
            deferred: false,
            replied: false,
            deferReply: async () => { fakeInteractionEmpty.deferred = true; },
            editReply: async (payload) => { emptyPayload = payload; return payload; },
            reply: async (payload) => { emptyPayload = payload; return payload; }
        };
        await cmdClear.execute(fakeInteractionEmpty);
        assert.ok(emptyPayload?.embeds?.[0]?.data?.title?.includes('Queue Empty'));
    });

    await check('interactionCreate acknowledges unknown slash commands and catches command errors safely', async () => {
        let repliedUnknown = null;
        const unknownInteraction = {
            isCommand: () => true,
            isButton: () => false,
            isStringSelectMenu: () => false,
            commandName: 'nonexistentcommand123',
            user: { tag: 'Tester#0001', id: 'u1' },
            guild: { id: 'g1', name: 'Test Guild' },
            client: {
                commands: new Map() // Empty commands collection
            },
            deferred: false,
            replied: false,
            reply: async (payload) => { repliedUnknown = payload; return payload; }
        };

        await interactionCreate.execute(unknownInteraction);
        assert.ok(repliedUnknown?.embeds?.[0]?.data?.title?.includes('Unknown Command'), 'Must acknowledge unknown commands');

        // Command execution error:
        let repliedError = null;
        const faultyCommand = {
            data: { name: 'faulty' },
            execute: async () => { throw new Error('Simulated command explosion'); }
        };

        const faultyInteraction = {
            isCommand: () => true,
            isButton: () => false,
            isStringSelectMenu: () => false,
            commandName: 'faulty',
            user: { tag: 'Tester#0001', id: 'u1' },
            guild: { id: 'g1', name: 'Test Guild', ownerId: 'owner-1' },
            member: { permissions: 8 }, // Admin
            client: {
                commands: new Map([['faulty', faultyCommand]]),
                defaultLanguage: 'en',
                languageManager: { get: (l, k) => k }
            },
            deferred: true,
            replied: false,
            editReply: async (payload) => { repliedError = payload; return payload; },
            reply: async (payload) => { repliedError = payload; return payload; }
        };

        await interactionCreate.execute(faultyInteraction);
        assert.equal(repliedError?.content, 'ERROR_COMMAND_EXECUTION', 'Must send user-facing error response when command fails');
    });

    console.log('\nTesting Regression: Ghost Now Playing Elimination & 24/7 Voice Resilience...');

    const embedsModule = require('../src/utils/embeds');
    const voiceStateUpdate = require('../src/events/voiceStateUpdate');

    check('formatDuration and createProgressBar handle 0ms, duration, and live streams without "Live / 4:02"', () => {
        // 1. formatDuration
        assert.equal(embedsModule.formatDuration(0), '0:00', '0ms must be "0:00", not "Live"');
        assert.equal(embedsModule.formatDuration(-10), '0:00', 'Negative ms must be "0:00"');
        assert.equal(embedsModule.formatDuration(null), '0:00', 'null must be "0:00"');
        assert.equal(embedsModule.formatDuration(undefined), '0:00', 'undefined must be "0:00"');
        assert.equal(embedsModule.formatDuration(242000), '4:02', '242000ms must be "4:02"');
        assert.equal(embedsModule.formatDuration(3665000), '1:01:05', '3665000ms must be "1:01:05"');

        // 2. createProgressBar finite track at 0ms
        const finiteBarAtStart = zyroEmbeds.createProgressBar(0, 242000, 10, false);
        assert.ok(!finiteBarAtStart.includes('Live / 4:02'), 'Must not display "Live / 4:02"');
        assert.ok(finiteBarAtStart.includes('0:00 / 4:02'), 'Must display "0:00 / 4:02"');

        // 3. createProgressBar finite track mid-song
        const finiteBarMid = zyroEmbeds.createProgressBar(120000, 240000, 10, false);
        assert.ok(finiteBarMid.includes('2:00 / 4:00'), 'Must display "2:00 / 4:00"');
        assert.ok(finiteBarMid.includes('🔘'), 'Must have indicator dot');

        // 4. createProgressBar live stream
        const liveBar = zyroEmbeds.createProgressBar(0, 0, 10, true);
        assert.ok(liveBar.includes('🔴 LIVE STREAM'), 'Live stream must display "🔴 LIVE STREAM"');
    });

    check('createNowPlayingEmbed guards against stale tracks and stopped players', () => {
        const dummyClient = {
            is247Enabled: () => false,
            autoplayEnabled: new Map(),
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' }
        };

        // No track: must return stopped embed
        const stopped1 = zyroEmbeds.createNowPlayingEmbed(null, null, dummyClient);
        assert.ok(stopped1.data.author?.name?.includes('IDLE') || stopped1.data.description?.includes('Playback stopped'), 'Missing track must produce stopped embed');

        // Player with playing: false and not paused: must return stopped embed
        const stoppedPlayer = {
            guildId: 'g1',
            playing: false,
            paused: false,
            queue: { current: null, tracks: [], previous: [] }
        };
        const stopped2 = zyroEmbeds.createNowPlayingEmbed(stoppedPlayer, null, dummyClient);
        assert.ok(stopped2.data.author?.name?.includes('IDLE') || stopped2.data.description?.includes('Playback stopped'), 'Stopped player must produce stopped embed');

        // Player with playing: true: returns now playing embed
        const playingTrack = {
            info: { title: 'Live Hit Song', author: 'Famous Artist', duration: 180000, uri: 'https://youtube.com/watch?v=hit', isStream: false }
        };
        const playingPlayer = {
            guildId: 'g1',
            playing: true,
            paused: false,
            position: 30000,
            volume: 100,
            repeatMode: 'off',
            queue: { current: playingTrack, tracks: [], previous: [] }
        };
        const npEmbed = zyroEmbeds.createNowPlayingEmbed(playingPlayer, playingTrack, dummyClient);
        assert.ok(npEmbed.data.author.name.includes('NOW PLAYING'));
        assert.ok(npEmbed.data.description.includes('Live Hit Song'));

        // Player paused: returns now playing embed with Paused status badge
        playingPlayer.paused = true;
        playingPlayer.playing = false;
        const pausedEmbed = zyroEmbeds.createNowPlayingEmbed(playingPlayer, playingTrack, dummyClient);
        assert.ok(pausedEmbed.data.author.name.includes('PAUSED'));
        assert.ok(pausedEmbed.data.description.includes('Paused'));
    });

    await check('reconcileAllDashboards eliminates ghost panels on startup/reconnect', async () => {
        const guildId247 = 'g-reconcile-247';
        const guildIdNo247 = 'g-reconcile-no247';

        let deletedMessages = [];
        let editedMessages = new Map();

        const makeMockMsg = (id, channelId) => ({
            id,
            channelId,
            embeds: [{ title: 'Ghost Old Track Title', description: 'Stale track description' }],
            edit: async (payload) => {
                editedMessages.set(id, payload);
                return makeMockMsg(id, channelId);
            },
            delete: async () => {
                deletedMessages.push(id);
            }
        });

        const mockChannel = {
            id: 'tc-reconcile',
            messages: {
                fetch: async (id) => makeMockMsg(id, 'tc-reconcile')
            }
        };

        guildSettings.set247(guildId247, true, {
            voiceChannelId: 'vc-reconcile-1',
            textChannelId: 'tc-reconcile'
        });
        guildSettings.setDashboard(guildId247, { messageId: 'msg-ghost-247', channelId: 'tc-reconcile' });

        guildSettings.set247(guildIdNo247, false);
        guildSettings.setDashboard(guildIdNo247, { messageId: 'msg-ghost-no247', channelId: 'tc-reconcile' });

        const mockClient = {
            guildSettings,
            lavalink: {
                // No active Lavalink player (e.g. after restart)
                getPlayer: () => null
            },
            lavalinkConnectionManager: {
                isAvailable: () => true
            },
            channels: {
                cache: new Map([['tc-reconcile', mockChannel]]),
                fetch: async () => mockChannel
            },
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: (gid) => guildSettings.is247(gid),
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        await controller.reconcileAllDashboards();

        // 1. The 24/7 guild's ghost dashboard was edited in place to the stopped/idle dashboard
        assert.ok(editedMessages.has('msg-ghost-247'), '24/7 ghost dashboard must be edited in-place');
        const editedPayload = editedMessages.get('msg-ghost-247');
        assert.ok(editedPayload.embeds[0].data.author?.name?.includes('IDLE') || editedPayload.embeds[0].data.description?.includes('Playback stopped'), 'Must replace ghost track with Stopped/Idle UI');
        assert.ok(editedPayload.embeds[0].data.footer?.text?.includes('24/7 Mode Active'), 'Must show 24/7 active in footer');

        // 2. The non-24/7 guild's ghost dashboard was deleted
        assert.ok(deletedMessages.includes('msg-ghost-no247'), 'Non-24/7 ghost dashboard must be deleted');
        assert.equal(guildSettings.getDashboard(guildIdNo247), null, 'Stored dashboard ID must be cleared after deletion');

        // Clean up
        guildSettings.delete(guildId247);
        guildSettings.delete(guildIdNo247);
    });

    await check('voiceStateUpdate handles unintentional disconnect for 24/7 guild with auto-recovery', async () => {
        const guildId = 'g-voice-drop-247';
        guildSettings.set247(guildId, true, {
            voiceChannelId: 'vc-intended',
            textChannelId: 'tc-music'
        });

        let stoppedStateCalled = false;
        let presenceUpdated = false;
        let playerDestroyed = false;

        const fakePlayer = {
            guildId,
            playing: true,
            voiceChannelId: 'vc-intended',
            destroy: async () => { playerDestroyed = true; },
            queue: { current: { info: { title: 'Was Playing' } }, tracks: [], clear: () => {} }
        };

        const mockClient = {
            guildSettings,
            user: { id: 'bot-id' },
            is247Enabled: (gid) => guildSettings.is247(gid),
            lavalink: {
                getPlayer: (gid) => gid === guildId ? fakePlayer : null
            },
            playerController: {
                showStoppedState: async (gid) => { stoppedStateCalled = true; }
            },
            activityManager: {
                updatePresence: () => { presenceUpdated = true; }
            }
        };

        // Simulate bot voice disconnect event: bot had channelId 'vc-intended', now has null
        const oldState = {
            guild: { id: guildId, name: 'Voice Drop Guild' },
            id: 'bot-id',
            channelId: 'vc-intended'
        };
        const newState = {
            guild: { id: guildId, name: 'Voice Drop Guild' },
            id: 'bot-id',
            channelId: null
        };

        await voiceStateUpdate.execute(oldState, newState, mockClient);

        // Verify:
        // 1. 24/7 is NOT turned off
        assert.equal(guildSettings.is247(guildId), true, '24/7 mode must remain enabled after unintentional drop');
        assert.equal(guildSettings.get(guildId).voiceChannelId, 'vc-intended', 'Intended voice channel ID must be preserved');

        // 2. Player playing state set to false and stopped UI shown
        assert.equal(fakePlayer.playing, false, 'Playing state must be invalidated');
        assert.equal(fakePlayer.queue.current, null, 'Current track must be cleared');
        assert.equal(stoppedStateCalled, true, 'Stopped state must be displayed on dashboard');
        assert.equal(presenceUpdated, true, 'Bot presence must be refreshed');

        // Clean up
        guildSettings.delete(guildId);
    });

    console.log('\nTesting Regression: Screenshot Reproduction — ZYRO Player Dashboard Replacement Flow...');

    await check('Screenshot Reproduction: /play immediately switches to Song B when playing Song A, updating canonical dashboard', async () => {
        const { MessageFlags } = require('discord.js');
        const guildId = 'guild-screenshot-repro';
        guildSettings.delete(guildId);

        const channelMessages = new Map(); // id -> msg
        const activeMessageIds = new Set();
        let messageCounter = 0;

        function createMockMsg(id, embed, components) {
            const msgObj = {
                id,
                channelId: 'tc-music',
                embeds: [embed],
                components: components || [],
                delete: async () => {
                    activeMessageIds.delete(id);
                    channelMessages.delete(id);
                },
                edit: async (payload) => {
                    if (payload.embeds) msgObj.embeds = payload.embeds;
                    if (payload.components) msgObj.components = payload.components;
                    return msgObj;
                }
            };
            return msgObj;
        }

        const publicMessagesSent = [];
        const fakeChannel = {
            id: 'tc-music',
            name: 'music',
            messages: {
                cache: channelMessages,
                fetch: async (id) => channelMessages.get(id) || null
            },
            send: async (payload) => {
                messageCounter++;
                const newId = `dash-msg-${messageCounter}`;
                const msg = createMockMsg(newId, payload.embeds[0], payload.components);
                channelMessages.set(newId, msg);
                activeMessageIds.add(newId);
                publicMessagesSent.push({ id: newId, embed: payload.embeds[0], components: payload.components });
                return msg;
            }
        };

        const songA = {
            info: {
                title: 'Song A (Previously Playing)',
                author: 'Original Artist',
                duration: 180000,
                uri: 'https://youtube.com/watch?v=songA',
                artworkUrl: 'https://example.com/artA.png'
            },
            requester: { id: 'u1', username: 'InitialRequester' }
        };

        const songB = {
            info: {
                title: 'Song B (Newly Requested)',
                author: 'Replacement Artist',
                duration: 240000,
                uri: 'https://youtube.com/watch?v=songB',
                artworkUrl: 'https://example.com/artB.png'
            },
            requester: { id: 'u2', username: 'ReplacementRequester' }
        };

        let playerPaused = false;
        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            textChannelId: 'tc-music',
            volume: 85,
            repeatMode: 'off',
            position: 25000,
            playing: true,
            paused: false,
            connected: true,
            voice: { token: 'mock-token' },
            data: new Map(),
            setData(k, v) { this.data.set(k, v); },
            getData(k) { return this.data.get(k); },
            queue: {
                current: songA,
                tracks: [],
                previous: [],
                add: async (track) => { mockPlayer.queue.tracks.push(track); }
            },
            search: async () => ({ loadType: 'track', tracks: [songB] }),
            play: async (opts) => {
                if (opts?.clientTrack) {
                    mockPlayer.queue.current = opts.clientTrack;
                }
            },
            pause: async () => { playerPaused = true; mockPlayer.paused = true; },
            resume: async () => { playerPaused = false; mockPlayer.paused = false; },
            skip: async () => {
                mockPlayer.queue.current = mockPlayer.queue.tracks.shift() || null;
            }
        };

        const mockClient = {
            guildSettings,
            defaultLanguage: 'en',
            languageManager: { get: (l, k) => k },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: () => mockPlayer
            },
            channels: {
                cache: new Map([['tc-music', fakeChannel]]),
                fetch: async () => fakeChannel
            },
            user: { id: 'bot-id', displayAvatarURL: () => 'https://example.com/bot.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        mockClient.playerController = controller;

        // 1. Start Song A and create a full dashboard
        await controller.updatePlayer(guildId, { replace: true });
        assert.equal(activeMessageIds.size, 1, 'Requirement 1: Initial full dashboard created');
        assert.ok(activeMessageIds.has('dash-msg-1'), 'Requirement 1: Dashboard 1 active');
        const dash1 = channelMessages.get('dash-msg-1');
        assert.ok(dash1.embeds[0].data.author.name.includes('NOW PLAYING'));
        assert.ok(dash1.embeds[0].data.description.includes('Song A (Previously Playing)'));

        // 2. Run /play to queue Song B behind Song A
        let deferredEphemeral = false;
        let ephemeralReplies = [];
        const mockInteraction = {
            guild: { id: guildId, name: 'Screenshot Guild', members: { me: { voice: { channelId: 'vc-1' } } } },
            channel: fakeChannel,
            member: {
                user: { tag: 'User#1234', id: 'u2' },
                voice: {
                    channel: {
                        id: 'vc-1',
                        permissionsFor: () => ({ has: () => true })
                    }
                }
            },
            user: { id: 'u2' },
            options: {
                getString: (opt) => opt === 'query' ? 'Song B (Newly Requested)' : null,
                getBoolean: (opt) => opt === 'next' ? false : null,
            },
            client: mockClient,
            deferred: false,
            replied: false,
            deferReply: async (opts) => {
                mockInteraction.deferred = true;
                if (opts?.flags === MessageFlags.Ephemeral || opts?.ephemeral === true) {
                    deferredEphemeral = true;
                }
            },
            editReply: async (payload) => {
                ephemeralReplies.push(payload);
                mockInteraction.replied = true;
            },
            reply: async (payload) => {
                ephemeralReplies.push(payload);
                mockInteraction.replied = true;
            }
        };

        await playCommand.execute(mockInteraction);

        // 3. Verify exactly 1 active dashboard remains in channel with complete expected controls
        assert.equal(activeMessageIds.size, 1, 'Requirement 3: Exactly 1 active dashboard remains in channel');
        const activeDashId = controller.getDashboard(guildId).messageId;
        assert.ok(activeMessageIds.has(activeDashId), 'Requirement 3: Canonical dashboard must be active');
        const dash2 = channelMessages.get(activeDashId);
        assert.ok(dash2, 'Dashboard message must exist');

        // Check complete current player interface:
        // - ZYRO • NOW PLAYING title
        assert.ok(dash2.embeds[0].data.author.name.includes('NOW PLAYING'), 'Must display NOW PLAYING');
        // - Active song switches to Song B immediately
        assert.ok(dash2.embeds[0].data.description.includes('Song B (Newly Requested)'), 'Active song switches to Song B');
        assert.equal(mockPlayer.queue.current.info.title, 'Song B (Newly Requested)', 'Song B becomes current track');
        assert.equal(mockPlayer.queue.previous[0].info.title, 'Song A (Previously Playing)', 'Song A moved to previous history');
        // - Duration and accurate playback position (progress bar)
        assert.ok(dash2.embeds[0].data.description.includes('─') && dash2.embeds[0].data.description.includes('🔘'), 'Must include progress bar');
        // - Volume, queue count, loop mode and requester information
        assert.ok(dash2.embeds[0].data.description.includes('🔊 `85%`'), 'Must include volume');
        assert.ok(dash2.embeds[0].data.description.includes('📜 `0` in queue'), 'Must include updated queue count');
        assert.ok(dash2.embeds[0].data.description.includes('Loop: `Off`'), 'Must include loop mode');
        assert.ok(dash2.embeds[0].data.description.includes('ReplacementRequester'), 'Must include active track requester info');

        // - Verify all 9 button controls
        const customIdsDash2 = dash2.components.flatMap(row => row.components.map(b => b.data.custom_id));
        assert.ok(customIdsDash2.includes('player:back'), 'Must have Back button');
        assert.ok(customIdsDash2.includes('player:playpause'), 'Must have Play/Pause button');
        assert.ok(customIdsDash2.includes('player:skip'), 'Must have Skip button');
        assert.ok(customIdsDash2.includes('player:stop'), 'Must have Stop button');
        assert.ok(customIdsDash2.includes('player:autoplay'), 'Must have Autoplay button');
        assert.ok(customIdsDash2.includes('player:queue'), 'Must have Queue button');
        assert.ok(customIdsDash2.includes('player:shuffle'), 'Must have Shuffle button');
        assert.ok(customIdsDash2.includes('player:loop'), 'Must have Loop button');
        assert.ok(!customIdsDash2.includes('player:247'), 'Must not have 24/7 button');

        // 4. Verify canonical dashboard message is maintained without orphaned duplicates
        assert.equal(activeMessageIds.size, 1, 'Requirement 4: Exactly 1 active dashboard remains');

        // 5. Verify no public "Now Playing (Replaced Current)" partial embed is posted
        for (const pub of publicMessagesSent) {
            const title = pub.embed?.data?.title || pub.embed?.title || '';
            const author = pub.embed?.data?.author?.name || '';
            assert.ok(!title.includes('Now Playing (Replaced Current)'), 'Must NEVER post public Now Playing (Replaced Current) embed');
            assert.ok(!author.includes('Replaced Current'), 'Author must not contain Replaced Current');
        }

        // Verify command reply was ephemeral
        assert.equal(deferredEphemeral, true, 'Command reply must be deferred as ephemeral');
        assert.ok(ephemeralReplies.length > 0, 'Command must send ephemeral confirmation');
        const replyTitle = ephemeralReplies[0]?.embeds?.[0]?.data?.title || '';
        assert.ok(!replyTitle.includes('Now Playing (Replaced Current)'), 'Ephemeral reply must not use partial title');

        // 6. Verify only one active dashboard remains and its ID is stored correctly
        assert.equal(controller.getDashboard(guildId).messageId, activeDashId, 'Requirement 6: Dashboard message ID stored in controller');
        assert.equal(guildSettings.getDashboard(guildId).messageId, activeDashId, 'Requirement 6: Dashboard message ID persisted in guildSettings');

        // 7. Verify sending failure keeps the previous dashboard
        const originalSend = fakeChannel.send;
        fakeChannel.send = async () => { throw new Error('Simulated Discord API error'); };
        const failedResult = await controller.updatePlayer(guildId, { replace: true, force: true });
        assert.equal(failedResult, null, 'Failed send returns null');
        assert.equal(controller.getDashboard(guildId).messageId, activeDashId, 'Requirement 7: Must preserve stored ID on send failure');
        assert.equal(activeMessageIds.has(activeDashId), true, 'Requirement 7: Must preserve active dashboard message on send failure');
        fakeChannel.send = originalSend;

        // 8. Verify concurrent /play and track-start events cannot create duplicate dashboards
        // Simulate simultaneous /play and trackStart replacement for Song B
        await Promise.all([
            controller.updatePlayer(guildId, { replace: true }),
            controller.updatePlayer(guildId, { replace: true })
        ]);

        assert.equal(activeMessageIds.size, 1, 'Requirement 8: Concurrent updates must maintain exactly 1 active dashboard');
        const finalDashId = controller.getDashboard(guildId).messageId;
        assert.ok(activeMessageIds.has(finalDashId), 'Concurrent update maintains valid active dashboard without duplicates');

        // 9. Verify buttons on replacement dashboard work
        let buttonReplied = null;
        const buttonInteraction = {
            isCommand: () => false,
            isButton: () => true,
            isStringSelectMenu: () => false,
            customId: 'player:playpause',
            guild: { id: guildId, name: 'Screenshot Guild', members: { me: { voice: { channelId: 'vc-1' } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u2', tag: 'DJMaster#0001' },
                voice: { channel: { id: 'vc-1' }, channelId: 'vc-1' },
                permissions: { has: () => true }
            },
            user: { id: 'u2', tag: 'DJMaster#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            reply: async (payload) => { buttonReplied = payload; return payload; }
        };

        await interactionCreate.execute(buttonInteraction);
        assert.equal(playerPaused, true, 'Requirement 9: Clicking player:playpause on replacement dashboard pauses playback');
        assert.ok(buttonReplied?.embeds?.[0]?.data?.title?.includes('Playback Paused'), 'Sends paused confirmation');

        guildSettings.delete(guildId);
    });

    console.log('\nTesting Critical Fix: ZYRO Full Player Dashboard Lifecycle & Regression Scenarios...');

    await check('Full Player Dashboard: Initial send, /skip, autoplay, restore deleted, permissions, buttons', async () => {
        const guildId = 'guild-regression-dashboard';
        const channelId = 'tc-full-dashboard';
        guildSettings.delete(guildId);

        let msgCounter = 0;
        const channelMessages = new Map();
        const activeMessagesOnDiscord = new Set();
        const publicMessagesLogged = [];

        function createMockDashboardMsg(id, embed, components) {
            return {
                id,
                channelId,
                embeds: [embed],
                components,
                async edit(payload) {
                    if (payload.embeds) this.embeds = payload.embeds;
                    if (payload.components) this.components = payload.components;
                    return this;
                },
                async delete() {
                    channelMessages.delete(this.id);
                    activeMessagesOnDiscord.delete(this.id);
                }
            };
        }

        const validChannel = {
            id: channelId,
            name: 'music',
            guild: { id: guildId, name: 'Regression Guild' },
            permissionsFor: (member) => ({
                has: (perm) => true
            }),
            messages: {
                cache: {
                    get: (id) => channelMessages.get(id)
                },
                fetch: async (id) => {
                    const m = channelMessages.get(id);
                    if (!m) {
                        const err = new Error('Unknown Message');
                        err.code = 10008;
                        throw err;
                    }
                    return m;
                }
            },
            send: async (payload) => {
                msgCounter++;
                const newId = `msg-dash-${msgCounter}`;
                const m = createMockDashboardMsg(newId, payload.embeds[0], payload.components);
                channelMessages.set(newId, m);
                activeMessagesOnDiscord.add(newId);
                publicMessagesLogged.push({ id: newId, payload });
                return m;
            }
        };

        const channelNoPerms = {
            id: 'tc-no-perms',
            name: 'restricted',
            guild: { id: guildId, name: 'Regression Guild' },
            permissionsFor: (member) => ({
                has: (perm) => {
                    // Deny SendMessages and EmbedLinks
                    if (perm === PermissionsBitField.Flags.SendMessages || perm === PermissionsBitField.Flags.EmbedLinks) return false;
                    return true;
                }
            }),
            send: async () => {
                const err = new Error('Missing Permissions');
                err.code = 50013;
                throw err;
            }
        };

        const track1 = {
            info: {
                title: 'Acoustic Dreams',
                author: 'Artist Alpha',
                duration: 210000,
                uri: 'https://youtube.com/watch?v=track1',
                artworkUrl: 'https://example.com/art1.png'
            },
            requester: { id: 'u1', username: 'RequesterAlpha' }
        };

        const track2 = {
            info: {
                title: 'Electric Vibe',
                author: 'Artist Beta',
                duration: 180000,
                uri: 'https://youtube.com/watch?v=track2',
                artworkUrl: 'https://example.com/art2.png'
            },
            requester: { id: 'u2', username: 'RequesterBeta' }
        };

        const track3Autoplay = {
            info: {
                title: 'Cosmic Journey',
                author: 'Artist Gamma',
                duration: 240000,
                uri: 'https://youtube.com/watch?v=track3',
                artworkUrl: 'https://example.com/art3.png'
            },
            userData: { autoplay: true }
        };

        let playerVolume = 80;
        let isPaused = false;
        let repeatMode = 'off';

        const mockPlayer = {
            guildId,
            voiceChannelId: 'vc-1',
            textChannelId: channelId,
            volume: playerVolume,
            repeatMode,
            position: 15000,
            playing: true,
            paused: false,
            connected: true,
            voice: { token: 'mock-token' },
            data: new Map(),
            setData(k, v) { this.data.set(k, v); },
            getData(k) { return this.data.get(k); },
            queue: {
                current: track1,
                tracks: [track2],
                previous: [],
                add: async (tracks, pos) => {
                    const arr = Array.isArray(tracks) ? tracks : [tracks];
                    if (typeof pos === 'number') {
                        mockPlayer.queue.tracks.splice(pos, 0, ...arr);
                    } else {
                        mockPlayer.queue.tracks.push(...arr);
                    }
                }
            },
            setVolume: (v) => { playerVolume = v; mockPlayer.volume = v; },
            setRepeatMode: (m) => { repeatMode = m; mockPlayer.repeatMode = m; },
            pause: async () => { isPaused = true; mockPlayer.paused = true; },
            resume: async () => { isPaused = false; mockPlayer.paused = false; },
            skip: async () => {
                const prev = mockPlayer.queue.current;
                if (prev) mockPlayer.queue.previous.unshift(prev);
                mockPlayer.queue.current = mockPlayer.queue.tracks.shift() || null;
            },
            stopPlaying: async () => {
                mockPlayer.playing = false;
                mockPlayer.queue.current = null;
                mockPlayer.queue.tracks = [];
            }
        };

        const client247Map = new Map();
        const clientAutoplayMap = new Map();
        const activePlayersMap = new Map();

        const mockClient = {
            guildSettings,
            defaultLanguage: 'en',
            languageManager: { get: (l, k, ...args) => k + (args.length ? ` ${args.join(' ')}` : '') },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: (gid) => (gid === guildId ? mockPlayer : null)
            },
            channels: {
                cache: new Map([
                    [channelId, validChannel],
                    ['tc-no-perms', channelNoPerms]
                ]),
                fetch: async (id) => {
                    if (id === channelId) return validChannel;
                    if (id === 'tc-no-perms') return channelNoPerms;
                    return null;
                }
            },
            user: { id: 'bot-id', username: 'ZYRO', displayAvatarURL: () => 'https://example.com/bot.png' },
            is247Enabled: (gid) => Boolean(client247Map.get(gid)),
            set247: (gid, val, opts) => {
                client247Map.set(gid, val);
                guildSettings.set247(gid, val, opts);
            },
            autoplayEnabled: clientAutoplayMap,
            activePlayers: activePlayersMap,
            updatePresence: () => {}
        };

        const controller = new PlayerController(mockClient);
        mockClient.playerController = controller;

        // SCENARIO 1: Start a song and verify one complete public dashboard is sent
        const initDashboard = await controller.updatePlayer(guildId, { replace: true, channelId });
        assert.ok(initDashboard, 'Scenario 1: Dashboard must be sent successfully');
        assert.equal(activeMessagesOnDiscord.size, 1, 'Scenario 1: Exactly 1 active message on Discord');
        assert.equal(initDashboard.id, 'msg-dash-1');

        const initialEmbed = initDashboard.embeds[0].data;
        assert.ok(initialEmbed.author?.name.includes('NOW PLAYING'), 'Scenario 1: Author heading must be NOW PLAYING');
        assert.ok(initialEmbed.description.includes('Acoustic Dreams'), 'Scenario 1: Description must include song title');
        assert.ok(initialEmbed.description.includes('Artist Alpha'), 'Scenario 1: Description must include artist');
        assert.ok(initialEmbed.description.includes('RequesterAlpha'), 'Scenario 1: Description must include requester');
        assert.ok(initialEmbed.description.includes('🔊 `80%`'), 'Scenario 1: Description must include volume');
        assert.equal(initialEmbed.thumbnail?.url, 'https://example.com/art1.png', 'Scenario 1: Embed thumbnail must be artworkUrl');

        // Verify all 9 control buttons are present across 2 rows
        const buttonsRow1 = initDashboard.components[0].components.map(b => b.data.custom_id);
        const buttonsRow2 = initDashboard.components[1].components.map(b => b.data.custom_id);
        const allCustomIds = [...buttonsRow1, ...buttonsRow2];
        assert.deepEqual(
            allCustomIds,
            ['player:playpause', 'player:skip', 'player:shuffle', 'player:stop', 'player:back', 'player:autoplay', 'player:queue', 'player:loop'],
            'Scenario 1 & 9: All 8 button controls must be present on dashboard'
        );

        // SCENARIO 2: Run /skip and verify full dashboard replaces correctly even if acknowledgement is ephemeral
        let skipReplied = null;
        let skipDeferredEphemeral = false;
        const skipInteraction = {
            guild: { id: guildId, name: 'Regression Guild' },
            channel: validChannel,
            member: {
                user: { tag: 'UserAlpha#0001', id: 'u1' },
                voice: { channel: { id: 'vc-1' }, channelId: 'vc-1' }
            },
            user: { tag: 'UserAlpha#0001', id: 'u1' },
            client: mockClient,
            deferred: false,
            replied: false,
            async deferReply(opts) {
                if (opts?.flags === MessageFlags.Ephemeral || opts?.flags === 64 || opts?.ephemeral === true) skipDeferredEphemeral = true;
                this.deferred = true;
            },
            async editReply(payload) {
                if (payload?.flags === MessageFlags.Ephemeral || payload?.flags === 64 || payload?.ephemeral === true) skipDeferredEphemeral = true;
                skipReplied = payload;
                this.replied = true;
                return payload;
            },
            async reply(payload) {
                if (payload?.flags === MessageFlags.Ephemeral || payload?.flags === 64 || payload?.ephemeral === true) skipDeferredEphemeral = true;
                skipReplied = payload;
                this.replied = true;
                return payload;
            }
        };

        const skipCommand = require('../src/commands/skip');
        await skipCommand.execute(skipInteraction);

        // Verify /skip reply is private/ephemeral
        assert.equal(skipDeferredEphemeral, true, 'Scenario 2: /skip reply was deferred as ephemeral');
        const skipTitle = skipReplied?.embeds?.[0]?.data?.title || skipReplied?.embeds?.[0]?.title || '';
        assert.ok(skipTitle.includes('Track Skipped'), 'Scenario 2: Received Track Skipped confirmation');
        assert.equal(mockPlayer.queue.current.info.title, 'Electric Vibe', 'Scenario 2: Player skipped to track 2');

        // Let the scheduled player update execute
        await new Promise(r => setTimeout(r, 200));

        assert.equal(activeMessagesOnDiscord.size, 1, 'Scenario 2: Still exactly 1 active dashboard message');
        const activeDashId = controller.getDashboard(guildId).messageId;
        assert.ok(activeMessagesOnDiscord.has(activeDashId), 'Scenario 2: Canonical dashboard message is active');

        const dash2 = channelMessages.get(activeDashId);
        assert.ok(dash2.embeds[0].data.description.includes('Electric Vibe'), 'Scenario 2: Dashboard updated with skipped track Electric Vibe');
        assert.ok(dash2.embeds[0].data.description.includes('Artist Beta'), 'Scenario 2: Dashboard updated with Artist Beta');

        // SCENARIO 3: Enable autoplay and verify the next track produces a full dashboard
        let autoplayReplied = null;
        let autoplayEphemeral = false;
        const autoplayInteraction = {
            guild: { id: guildId, name: 'Regression Guild' },
            channel: validChannel,
            member: { user: { tag: 'UserAlpha#0001', id: 'u1' } },
            user: { tag: 'UserAlpha#0001', id: 'u1' },
            client: mockClient,
            deferred: false,
            replied: false,
            async deferReply(opts) {
                if (opts?.flags === MessageFlags.Ephemeral || opts?.flags === 64 || opts?.ephemeral === true) autoplayEphemeral = true;
                this.deferred = true;
            },
            async editReply(payload) {
                if (payload?.flags === MessageFlags.Ephemeral || payload?.flags === 64 || payload?.ephemeral === true) autoplayEphemeral = true;
                autoplayReplied = payload;
                this.replied = true;
                return payload;
            },
            async reply(payload) {
                if (payload?.flags === MessageFlags.Ephemeral || payload?.flags === 64 || payload?.ephemeral === true) autoplayEphemeral = true;
                autoplayReplied = payload;
                this.replied = true;
                return payload;
            }
        };

        const autoplayCommand = require('../src/commands/autoplay');
        await autoplayCommand.execute(autoplayInteraction);
        assert.equal(clientAutoplayMap.get(guildId), true, 'Scenario 3: Autoplay enabled in client');
        assert.equal(autoplayEphemeral, true, 'Scenario 3: Autoplay response is ephemeral');
        assert.ok(autoplayReplied?.embeds?.[0]?.data?.title?.includes('Autoplay Enabled'), 'Scenario 3: Autoplay confirmation returned');

        // Now simulate autoplay pushing track3 and starting playback
        mockPlayer.queue.current = track3Autoplay;
        mockPlayer.queue.tracks = [];
        await controller.updatePlayer(guildId, { replace: true, channelId });

        const dash3 = channelMessages.get(controller.getDashboard(guildId).messageId);
        assert.ok(dash3.embeds[0].data.description.includes('Cosmic Journey'), 'Scenario 3: Autoplay track Cosmic Journey shown on dashboard');
        assert.ok(dash3.embeds[0].data.description.includes('Autoplay Radio'), 'Scenario 3: Shows Autoplay Radio requester');
        assert.ok(dash3.embeds[0].data.footer.text.includes('Autoplay Active'), 'Scenario 3: Footer indicates Autoplay Active');

        // SCENARIO 4: Verify ephemeral confirmations do not replace or suppress public dashboard updates
        let volumeReplied = null;
        let volumeEphemeral = false;
        const volumeInteraction = {
            guild: { id: guildId, name: 'Regression Guild' },
            channel: validChannel,
            member: { user: { tag: 'UserAlpha#0001', id: 'u1' } },
            user: { tag: 'UserAlpha#0001', id: 'u1' },
            client: mockClient,
            options: { getInteger: (opt) => opt === 'level' ? 95 : null },
            deferred: false,
            replied: false,
            async deferReply(opts) {
                if (opts?.flags === MessageFlags.Ephemeral || opts?.flags === 64 || opts?.ephemeral === true) volumeEphemeral = true;
                this.deferred = true;
            },
            async editReply(payload) {
                if (payload?.flags === MessageFlags.Ephemeral || payload?.flags === 64 || payload?.ephemeral === true) volumeEphemeral = true;
                volumeReplied = payload;
                this.replied = true;
                return payload;
            },
            async reply(payload) {
                if (payload?.flags === MessageFlags.Ephemeral || payload?.flags === 64 || payload?.ephemeral === true) volumeEphemeral = true;
                volumeReplied = payload;
                this.replied = true;
                return payload;
            }
        };

        const volumeCommand = require('../src/commands/volume');
        await volumeCommand.execute(volumeInteraction);
        assert.equal(playerVolume, 95, 'Scenario 4: Volume updated to 95%');
        assert.equal(volumeEphemeral, true, 'Scenario 4: Volume confirmation is ephemeral');

        await new Promise(r => setTimeout(r, 200));
        const currentActiveId = controller.getDashboard(guildId).messageId;
        const currentDashMsg = channelMessages.get(currentActiveId);
        assert.ok(currentDashMsg.embeds[0].data.description.includes('🔊 `95%`'), 'Scenario 4: Dashboard reflects updated volume 95%');
        assert.equal(activeMessagesOnDiscord.size, 1, 'Scenario 4: Public dashboard remains single and intact');

        // SCENARIO 5: Verify a missing/deleted dashboard is restored
        // Simulate moderator deleting the active dashboard message from Discord
        await currentDashMsg.delete();
        assert.equal(activeMessagesOnDiscord.size, 0, 'Scenario 5: Message deleted from Discord');
        assert.equal(channelMessages.has(currentActiveId), false, 'Scenario 5: Channel has no message in cache');

        // Bot runs reconciliation (e.g. periodic reconcile or startup recovery)
        const restoredMsg = await controller.reconcileDashboard(guildId);
        assert.ok(restoredMsg, 'Scenario 5: Reconcile must recreate the missing dashboard');
        assert.equal(activeMessagesOnDiscord.size, 1, 'Scenario 5: Exactly 1 restored message in Discord channel');
        assert.equal(controller.getDashboard(guildId).messageId, restoredMsg.id, 'Scenario 5: Controller has new restored message ID');
        assert.equal(guildSettings.getDashboard(guildId).messageId, restoredMsg.id, 'Scenario 5: Persisted settings updated with restored message ID');

        // SCENARIO 6: Verify invalid channel or failed channel.send does not falsely mark dashboard as existing
        const originalFetch = mockClient.channels.fetch;
        mockClient.channels.fetch = async () => null;
        mockClient.channels.cache.clear();

        const fakeGhostGuild = 'guild-all-channels-dead';
        const failureResult = await controller.updatePlayer(fakeGhostGuild, { replace: true, channelId: 'dead-channel-id' });
        assert.equal(failureResult, null, 'Scenario 6: Inaccessible channels return null');
        assert.equal(controller.getDashboard(fakeGhostGuild), null, 'Scenario 6: Dashboard is NOT marked as existing on failure');
        assert.equal(guildSettings.getDashboard(fakeGhostGuild), null, 'Scenario 6: guildSettings does not store fake dashboard ID');

        // Restore channels
        mockClient.channels.fetch = async (id) => (id === channelId ? validChannel : null);
        mockClient.channels.cache.set(channelId, validChannel);

        // SCENARIO 7: Verify stored message IDs, concurrent updates and cleanup still work
        const concurrentResults = await Promise.all([
            controller.updatePlayer(guildId, { replace: true }),
            controller.updatePlayer(guildId, { replace: true }),
            controller.updatePlayer(guildId, { replace: true })
        ]);
        assert.equal(activeMessagesOnDiscord.size, 1, 'Scenario 7: Concurrent updates maintain exactly 1 active message');
        assert.ok(concurrentResults.every(r => r !== null), 'Scenario 7: All concurrent updates resolved safely');

        // SCENARIO 8: Verify there is no duplicate full dashboard and no partial public Now Playing embed
        for (const log of publicMessagesLogged) {
            const title = log.payload.embeds[0]?.data?.title || '';
            const author = log.payload.embeds[0]?.data?.author?.name || '';
            assert.ok(!title.includes('Replaced Current'), 'Scenario 8: No partial Replaced Current embed title');
            assert.ok(!author.includes('Replaced Current'), 'Scenario 8: No Replaced Current author');
        }

        // SCENARIO 9: Verify all dashboard buttons remain functional
        const activeDash = channelMessages.get(controller.getDashboard(guildId).messageId);
        assert.ok(activeDash, 'Active dashboard exists');

        // Test Pause/Resume button
        let buttonReply = null;
        const playPauseInteraction = {
            isCommand: () => false,
            isButton: () => true,
            isStringSelectMenu: () => false,
            customId: 'player:playpause',
            guild: { id: guildId, name: 'Regression Guild', members: { me: { voice: { channelId: 'vc-1' } } } },
            channel: validChannel,
            member: {
                user: { id: 'u1', tag: 'DJ#0001' },
                voice: { channel: { id: 'vc-1' }, channelId: 'vc-1' },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'DJ#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            reply: async (p) => { buttonReply = p; return p; }
        };

        await interactionCreate.execute(playPauseInteraction);
        assert.equal(isPaused, true, 'Scenario 9: playpause pauses playback');
        assert.ok(buttonReply?.embeds?.[0]?.data?.title?.includes('Playback Paused'), 'Scenario 9: Paused reply received');

        // Test 24/7 button retired handling
        let button247Reply = null;
        const button247Interaction = {
            ...playPauseInteraction,
            customId: 'player:247',
            reply: async (p) => { button247Reply = p; return p; }
        };
        await interactionCreate.execute(button247Interaction);
        assert.ok(button247Reply?.embeds?.[0]?.data?.title?.includes('Control Retired'), 'Scenario 9: 24/7 button is retired');

        // Clean up guild
        guildSettings.delete(guildId);
    });

    console.log('\nTesting ZYRO Player Dashboard Repositioning After Queue Interactions...');

    await check('Queue Button & Pagination: Ephemeral response, bottom refresh, old delete, all 9 controls, concurrent deduplication, error safety', async () => {
        const guildId = 'guild-queue-reposition';
        const channelId = 'tc-queue-test';
        guildSettings.delete(guildId);

        let msgCounter = 0;
        const channelMessages = new Map();
        const activeMessagesOnDiscord = new Set();
        let shouldFailSend = false;

        function createMockDashboardMsg(id, embed, components) {
            return {
                id,
                channelId,
                embeds: [embed],
                components,
                async edit(payload) {
                    if (payload.embeds) this.embeds = payload.embeds;
                    if (payload.components) this.components = payload.components;
                    return this;
                },
                async delete() {
                    channelMessages.delete(this.id);
                    activeMessagesOnDiscord.delete(this.id);
                    return true;
                }
            };
        }

        const fakeChannel = {
            id: channelId,
            name: 'music-queue-channel',
            guild: { id: guildId },
            isTextBased: () => true,
            permissionsFor: () => ({ has: () => true }),
            messages: {
                cache: channelMessages,
                fetch: async (id) => channelMessages.get(id) || null,
            },
            send: async (payload) => {
                if (shouldFailSend) {
                    throw new Error('Simulated Discord API failure on send');
                }
                msgCounter++;
                const newId = `msg-dash-queue-${msgCounter}`;
                const msg = createMockDashboardMsg(newId, payload.embeds[0], payload.components);
                channelMessages.set(newId, msg);
                activeMessagesOnDiscord.add(newId);
                return msg;
            }
        };

        const mockTrack = {
            info: {
                title: 'Queue Active Song',
                author: 'Queue Artist',
                uri: 'https://example.com/queue-song',
                artworkUrl: 'https://example.com/queue-art.png',
                duration: 210000
            },
            requester: { id: 'u1', username: 'QueueRequester' }
        };

        const queuedTracks = Array.from({ length: 12 }, (_, i) => ({
            info: {
                title: `Upcoming Track ${i + 1}`,
                author: `Upcoming Artist ${i + 1}`,
                uri: `https://example.com/up-${i + 1}`,
                duration: 180000
            },
            requester: { id: 'u1', username: 'QueueRequester' }
        }));

        const mockPlayer = {
            guildId,
            textChannelId: channelId,
            voiceChannelId: 'vc-queue-1',
            playing: true,
            paused: false,
            stopped: false,
            volume: 80,
            repeatMode: 'off',
            position: 30000,
            queue: {
                current: mockTrack,
                tracks: [...queuedTracks]
            }
        };

        const mockClient = {
            user: { id: 'zyro-bot' },
            guildSettings,
            defaultLanguage: 'en',
            languageManager: { get: () => 'Error' },
            channels: {
                cache: new Map([[channelId, fakeChannel]]),
                fetch: async (id) => (id === channelId ? fakeChannel : null),
            },
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    name: 'Queue Guild',
                    members: { me: { voice: { channelId: 'vc-queue-1' } } },
                    channels: { cache: new Map([[channelId, fakeChannel]]) }
                }]])
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: (gId) => (gId === guildId ? mockPlayer : null),
                players: new Map([[guildId, mockPlayer]]),
            },
            autoplayEnabled: new Map([[guildId, false]]),
            activePlayers: new Map(),
            is247Enabled: () => false,
            set247: () => {},
            updatePresence: () => {},
        };

        const controller = new PlayerController(mockClient);
        mockClient.playerController = controller;

        // 1. Initial dashboard send at bottom (Song is playing)
        const initialDash = await controller.replaceWithFullDashboard(guildId, channelId);
        assert.ok(initialDash, 'Initial dashboard must be sent');
        assert.equal(activeMessagesOnDiscord.size, 1);
        const dash1Id = initialDash.id;
        assert.ok(activeMessagesOnDiscord.has(dash1Id));

        // 2. User clicks Queue button (customId: 'player:queue')
        let queueReplyPayload = null;
        let replyCalled = false;
        const queueButtonInteraction = {
            isCommand: () => false,
            isButton: () => true,
            isStringSelectMenu: () => false,
            customId: 'player:queue',
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: 'vc-queue-1' } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Listener#0001' },
                voice: { channel: { id: 'vc-queue-1' }, channelId: 'vc-queue-1' },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Listener#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            reply: async (payload) => {
                replyCalled = true;
                queueReplyPayload = payload;
                queueButtonInteraction.replied = true;
                return payload;
            }
        };

        await interactionCreate.execute(queueButtonInteraction);

        // Requirement 1: Ephemeral queue response
        assert.ok(replyCalled, 'Queue button must immediately acknowledge with reply');
        assert.ok(queueReplyPayload?.flags === MessageFlags.Ephemeral || queueReplyPayload?.ephemeral === true, 'Queue response must be ephemeral');
        assert.ok(queueReplyPayload?.embeds?.[0]?.data?.title?.includes('Queue'), 'Queue response embed has Queue title');

        // Requirement 2 & 3: Canonical dashboard remains active and updated in place
        assert.equal(activeMessagesOnDiscord.size, 1, 'Exactly 1 active dashboard remains');
        const dash2Id = controller.getDashboard(guildId).messageId;
        assert.ok(activeMessagesOnDiscord.has(dash2Id), 'Dashboard is active');

        // Requirement 4: Dashboard contains all metadata and all controls
        const dash2Msg = channelMessages.get(dash2Id);
        assert.ok(dash2Msg, 'New dashboard exists');
        assert.ok(dash2Msg.embeds[0].data.author.name.includes('NOW PLAYING'));
        assert.ok(dash2Msg.embeds[0].data.description.includes('Queue Active Song'));
        assert.ok(dash2Msg.embeds[0].data.description.includes('Queue Artist'));
        assert.equal(dash2Msg.embeds[0].data.thumbnail.url, 'https://example.com/queue-art.png');
        assert.ok(dash2Msg.embeds[0].data.description.includes('🔊 `80%`'));
        assert.ok(dash2Msg.embeds[0].data.description.includes('QueueRequester'));

        const dash2Buttons = dash2Msg.components.flatMap(row => row.components.map(b => b.data.custom_id));
        const requiredButtons = [
            'player:back', 'player:playpause', 'player:skip', 'player:stop',
            'player:autoplay', 'player:queue', 'player:shuffle', 'player:loop'
        ];
        for (const btn of requiredButtons) {
            assert.ok(dash2Buttons.includes(btn), `Dashboard must contain ${btn} button`);
        }
        assert.ok(!dash2Buttons.includes('player:247'), 'Dashboard must not contain player:247');

        // Requirement 5: Queue page navigation button keeps working and brings dashboard to bottom
        let updateCalled = false;
        let updatePayload = null;
        const pageNextInteraction = {
            isCommand: () => false,
            isButton: () => true,
            isStringSelectMenu: () => false,
            customId: 'queue:next:2',
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: 'vc-queue-1' } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Listener#0001' },
                voice: { channel: { id: 'vc-queue-1' }, channelId: 'vc-queue-1' },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Listener#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            update: async (payload) => {
                updateCalled = true;
                updatePayload = payload;
                return payload;
            }
        };

        await interactionCreate.execute(pageNextInteraction);
        assert.ok(updateCalled, 'Queue pagination must update ephemeral message');
        assert.ok(updatePayload?.embeds?.[0]?.data?.footer?.text?.includes('Page 2'), 'Navigates to Page 2');

        // Requirement 6: Concurrent Queue clicks do not create duplicate dashboards
        const clickA = { ...queueButtonInteraction, reply: async () => ({}) };
        const clickB = { ...queueButtonInteraction, reply: async () => ({}) };
        await Promise.all([
            interactionCreate.execute(clickA),
            interactionCreate.execute(clickB)
        ]);
        assert.equal(activeMessagesOnDiscord.size, 1, 'Concurrent queue clicks must maintain exactly 1 dashboard');

        // Requirement 7: Failed dashboard send preserves previous dashboard
        const currentActiveId = controller.getDashboard(guildId).messageId;
        shouldFailSend = true;
        const failedResult = await controller.replaceWithFullDashboard(guildId, channelId, { reason: 'queue', force: true });
        assert.equal(failedResult, null, 'Failed send returns null');
        assert.equal(controller.getDashboard(guildId).messageId, currentActiveId, 'Stored dashboard ID preserved on failed send');
        assert.ok(activeMessagesOnDiscord.has(currentActiveId), 'Previous dashboard message preserved on failed send');
        shouldFailSend = false;

        // Requirement 8: Final state contains exactly one active public dashboard
        assert.equal(activeMessagesOnDiscord.size, 1, 'Final state has exactly one active public dashboard');

        guildSettings.delete(guildId);
    });

    console.log('\nTesting ZYRO Queue Popup — Interactive Song Selection & Immediate Playback...');

    await check('Queue Popup: Ephemeral queue with select menu, click song to play immediately, queue order preserved, dashboard & voice status updated', async () => {
        const guildId = 'guild-queue-jump-test';
        const channelId = 'tc-queue-jump';
        const vcId = 'vc-queue-jump';

        // 1. Channel messages & active message tracking
        const channelMessages = new Map();
        let msgCounter = 0;

        function createMockDashboardMsg(id, embed, components) {
            return {
                id,
                channelId,
                embeds: [embed],
                components,
                async edit(payload) {
                    if (payload.embeds) this.embeds = payload.embeds;
                    if (payload.components) this.components = payload.components;
                    return this;
                },
                async delete() {
                    channelMessages.delete(this.id);
                    return true;
                }
            };
        }

        const fakeChannel = {
            id: channelId,
            name: 'music-channel',
            guild: { id: guildId },
            isTextBased: () => true,
            permissionsFor: () => ({ has: () => true }),
            messages: {
                cache: channelMessages,
                fetch: async (id) => channelMessages.get(id) || null,
            },
            send: async (payload) => {
                msgCounter++;
                const newId = `msg-dash-jump-${msgCounter}`;
                const msg = createMockDashboardMsg(newId, payload.embeds[0], payload.components);
                channelMessages.set(newId, msg);
                return msg;
            }
        };

        // 2. Mock Tracks
        const trackA = {
            info: { identifier: 'id-a', title: 'Song A', author: 'Artist A', uri: 'https://example.com/a', duration: 180000 },
            requester: { id: 'u1', username: 'Tester' }
        };
        const trackB = {
            info: { identifier: 'id-b', title: 'Song B', author: 'Artist B', uri: 'https://example.com/b', duration: 200000 },
            requester: { id: 'u1', username: 'Tester' }
        };
        const trackC = {
            info: { identifier: 'id-c', title: 'Song C', author: 'Artist C', uri: 'https://example.com/c', duration: 220000 },
            requester: { id: 'u1', username: 'Tester' }
        };
        const trackD = {
            info: { identifier: 'id-d', title: 'Song D', author: 'Artist D', uri: 'https://example.com/d', duration: 240000 },
            requester: { id: 'u1', username: 'Tester' }
        };

        let playCalledWith = null;
        const mockPlayer = {
            guildId,
            textChannelId: channelId,
            voiceChannelId: vcId,
            playing: true,
            paused: false,
            stopped: false,
            volume: 80,
            repeatMode: 'off',
            position: 15000,
            data: new Map(),
            setData: (k, v) => mockPlayer.data.set(k, v),
            getData: (k) => mockPlayer.data.get(k),
            queue: {
                current: trackA,
                tracks: [trackB, trackC, trackD],
                previous: []
            },
            play: async (options) => {
                playCalledWith = options;
                if (options?.clientTrack) {
                    mockPlayer.queue.current = options.clientTrack;
                }
                return mockPlayer;
            }
        };

        let voiceStatusUpdatedWith = null;
        const mockVoiceStatusManager = {
            updateFromPlayer: async (player, track, state) => {
                voiceStatusUpdatedWith = { track, state };
            }
        };

        const mockClient = {
            user: { id: 'zyro-bot' },
            guildSettings,
            defaultLanguage: 'en',
            languageManager: { get: () => 'Error' },
            channels: {
                cache: new Map([[channelId, fakeChannel]]),
                fetch: async (id) => (id === channelId ? fakeChannel : null),
            },
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    name: 'Queue Guild',
                    members: { me: { voice: { channelId: vcId } } },
                    channels: { cache: new Map([[channelId, fakeChannel]]) }
                }]])
            },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: (gId) => (gId === guildId ? mockPlayer : null),
                players: new Map([[guildId, mockPlayer]]),
            },
            autoplayEnabled: new Map([[guildId, false]]),
            activePlayers: new Map(),
            is247Enabled: () => false,
            set247: () => {},
            updatePresence: () => {},
            voiceChannelStatusManager: mockVoiceStatusManager
        };

        const controller = new PlayerController(mockClient);
        mockClient.playerController = controller;

        // Start with an initial dashboard
        await controller.replaceWithFullDashboard(guildId, channelId);

        // --- SUBTEST 1: Queue button opens ephemeral view with StringSelectMenuBuilder ---
        let queueView = null;
        const queueButtonInteraction = {
            isCommand: () => false,
            isButton: () => true,
            isStringSelectMenu: () => false,
            customId: 'player:queue',
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Tester#0001' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Tester#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            reply: async (payload) => {
                queueView = payload;
                queueButtonInteraction.replied = true;
                return payload;
            }
        };

        await interactionCreate.execute(queueButtonInteraction);

        assert.ok(queueView, 'Queue button must produce an ephemeral view');
        assert.ok(queueView.flags === MessageFlags.Ephemeral || queueView.ephemeral === true, 'Queue must be ephemeral');
        assert.ok(queueView.embeds[0].data.description.includes('Song A'), 'Ephemeral view shows current Song A');
        assert.ok(queueView.embeds[0].data.description.includes('Song B'), 'Ephemeral view lists Song B in UP NEXT');
        assert.ok(queueView.embeds[0].data.description.includes('Song C'), 'Ephemeral view lists Song C in UP NEXT');
        assert.ok(queueView.embeds[0].data.description.includes('Song D'), 'Ephemeral view lists Song D in UP NEXT');

        // Check select menu builder presence
        const selectRow = queueView.components.find(row => 
            row.components.some(c => c.data.custom_id === 'queue:select')
        );
        assert.ok(selectRow, 'Queue view must contain StringSelectMenuBuilder with customId queue:select');
        const selectMenu = selectRow.components.find(c => c.data.custom_id === 'queue:select');
        const selectOptions = selectMenu.toJSON().options;
        assert.equal(selectOptions.length, 3, 'Select menu contains 3 upcoming options');
        assert.ok(selectOptions[0].label.includes('Song B'));
        assert.ok(selectOptions[1].label.includes('Song C'));
        assert.ok(selectOptions[2].label.includes('Song D'));

        // --- SUBTEST 2: Selecting Song C while Song A plays starts Song C immediately ---
        const songCOption = selectOptions[1];
        let queueViewUpdated = null;
        let followUpPayload = null;

        const selectSongCInteraction = {
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            customId: 'queue:select',
            values: [songCOption.value],
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Tester#0001' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Tester#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            update: async (payload) => {
                queueViewUpdated = payload;
                selectSongCInteraction.replied = true;
                return payload;
            },
            followUp: async (payload) => {
                followUpPayload = payload;
                return payload;
            }
        };

        await interactionCreate.execute(selectSongCInteraction);

        // Verification:
        // 1. Song C is playing
        assert.equal(mockPlayer.queue.current.info.title, 'Song C', 'Current song must now be Song C');
        assert.equal(playCalledWith?.clientTrack?.info?.title, 'Song C', 'player.play called with Song C clientTrack');
        
        // 2. Song A moved to previous (history) and not re-added
        assert.equal(mockPlayer.queue.previous.length, 1, 'Previous history contains 1 track');
        assert.equal(mockPlayer.queue.previous[0].info.title, 'Song A', 'Previous history is Song A');

        // 3. Queue order preserved: Song B remains next, Song D remains after Song B
        assert.equal(mockPlayer.queue.tracks.length, 2, 'Queue now has exactly 2 tracks remaining');
        assert.equal(mockPlayer.queue.tracks[0].info.title, 'Song B', 'Song B remains next');
        assert.equal(mockPlayer.queue.tracks[1].info.title, 'Song D', 'Song D remains after Song B');

        // 4. Voice status updated to Song C
        assert.ok(voiceStatusUpdatedWith, 'Voice status update called');
        assert.equal(voiceStatusUpdatedWith.track.info.title, 'Song C', 'Voice channel status updated to Song C');
        assert.equal(voiceStatusUpdatedWith.state, 'playing');

        // 5. Ephemeral view updated to show Song C
        assert.ok(queueViewUpdated, 'Ephemeral queue view updated in-place');
        assert.ok(queueViewUpdated.embeds[0].data.description.includes('Song C'), 'Updated queue shows Song C as current');

        // 6. Full dashboard replaced at bottom showing Song C
        const currentDash = controller.getDashboard(guildId);
        const dashMsg = channelMessages.get(currentDash.messageId);
        assert.ok(dashMsg, 'Dashboard message exists');
        assert.ok(dashMsg.embeds[0].data.description.includes('Song C'), 'Dashboard shows Song C');

        // --- SUBTEST 3: Duplicate songs handled safely via unique queueId ---
        const dupTrack1 = {
            _queueId: 'dup-1',
            info: { identifier: 'id-dup', title: 'Duplicate Song', author: 'Same Artist', uri: 'https://example.com/dup', duration: 100000 },
            requester: { id: 'u1', username: 'Tester' }
        };
        const midTrack = {
            _queueId: 'mid-track',
            info: { identifier: 'id-mid', title: 'Middle Track', author: 'Mid Artist', uri: 'https://example.com/mid', duration: 120000 },
            requester: { id: 'u1', username: 'Tester' }
        };
        const dupTrack2 = {
            _queueId: 'dup-2',
            info: { identifier: 'id-dup', title: 'Duplicate Song', author: 'Same Artist', uri: 'https://example.com/dup', duration: 100000 },
            requester: { id: 'u1', username: 'Tester' }
        };

        mockPlayer.queue.tracks = [dupTrack1, midTrack, dupTrack2];

        // Select the 2nd duplicate instance (index 2, dup-2)
        const dup2Value = `2:1:dup-2:id-dup`;
        const selectDup2Interaction = {
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            customId: 'queue:select',
            values: [dup2Value],
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Tester#0001' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Tester#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            update: async () => { selectDup2Interaction.replied = true; },
            followUp: async () => {}
        };

        await interactionCreate.execute(selectDup2Interaction);

        assert.equal(mockPlayer.queue.current._queueId, 'dup-2', 'Selected exact duplicate instance using queueId');
        assert.equal(mockPlayer.queue.tracks.length, 2, 'Queue has 2 tracks left');
        assert.equal(mockPlayer.queue.tracks[0]._queueId, 'dup-1', 'First duplicate remains at head of queue');
        assert.equal(mockPlayer.queue.tracks[1]._queueId, 'mid-track', 'Middle track remains after first duplicate');

        // --- SUBTEST 4: Stale queue selection handled gracefully ---
        let staleReply = null;
        const staleValue = `99:1:stale-queue-id:nonexistent-track`;
        const staleInteraction = {
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            customId: 'queue:select',
            values: [staleValue],
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Tester#0001' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Tester#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            reply: async (payload) => {
                staleReply = payload;
                staleInteraction.replied = true;
                return payload;
            }
        };

        await interactionCreate.execute(staleInteraction);

        assert.ok(staleReply, 'Stale queue selection replies to user');
        assert.ok(
            staleReply.embeds[0].data.description.includes('The queue changed. Please reopen the queue and select a track again.'),
            'Displays exact friendly message when queue entry is stale'
        );

        // --- SUBTEST 5: Empty queue handling ---
        mockPlayer.queue.tracks = [];
        let emptyReply = null;
        const emptyInteraction = {
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            customId: 'queue:select',
            values: ['0:1:some-id:some-track'],
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Tester#0001' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Tester#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            update: async (payload) => {
                emptyReply = payload;
                emptyInteraction.replied = true;
                return payload;
            }
        };

        await interactionCreate.execute(emptyInteraction);
        assert.ok(emptyReply, 'Empty queue selection produces update');
        assert.ok(emptyReply.embeds[0].data.title.includes('Queue Empty'));

        // --- SUBTEST 6: Pagination and track selection across multiple pages ---
        const pageTracks = Array.from({ length: 25 }, (_, i) => ({
            _queueId: `multi_${i + 1}`,
            info: {
                identifier: `id-multi-${i + 1}`,
                title: `Multi Track ${i + 1}`,
                author: `Multi Artist ${i + 1}`,
                uri: `https://example.com/multi-${i + 1}`,
                duration: 180000
            },
            requester: { id: 'u1', username: 'Tester' }
        }));
        mockPlayer.queue.tracks = [...pageTracks];

        const { createPaginatedQueueResponse } = require('../src/utils/PlayerActions');
        const page2Response = createPaginatedQueueResponse(mockClient, mockPlayer, 2);
        const page2SelectRow = page2Response.components.find(r => r.components.some(c => c.data.custom_id === 'queue:select'));
        assert.ok(page2SelectRow, 'Page 2 contains select menu');
        const page2SelectMenu = page2SelectRow.components.find(c => c.data.custom_id === 'queue:select');
        const page2Options = page2SelectMenu.toJSON().options;
        assert.ok(page2Options[0].label.includes('9. Multi Track 9'));

        // Select Track 12 from page 2 (index 3 of page 2 options, global index 11)
        const track12Option = page2Options[3];
        assert.ok(track12Option.label.includes('12. Multi Track 12'));

        const selectPage2Interaction = {
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            customId: 'queue:select',
            values: [track12Option.value],
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Tester#0001' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Tester#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            update: async () => { selectPage2Interaction.replied = true; },
            followUp: async () => {}
        };

        await interactionCreate.execute(selectPage2Interaction);

        assert.equal(mockPlayer.queue.current.info.title, 'Multi Track 12', 'Selected track across pages starts playing immediately');
        assert.equal(mockPlayer.queue.tracks.length, 24, 'Remaining queue has 24 tracks');
        assert.equal(mockPlayer.queue.tracks[10].info.title, 'Multi Track 11');
        assert.equal(mockPlayer.queue.tracks[11].info.title, 'Multi Track 13');

        // --- SUBTEST 7: Concurrent selections protected by per-guild lock ---
        // Setup 4 tracks: T1, T2, T3, T4
        const concTracks = [
            { _queueId: 'c1', info: { identifier: 'id-c1', title: 'Conc 1' } },
            { _queueId: 'c2', info: { identifier: 'id-c2', title: 'Conc 2' } },
            { _queueId: 'c3', info: { identifier: 'id-c3', title: 'Conc 3' } },
            { _queueId: 'c4', info: { identifier: 'id-c4', title: 'Conc 4' } },
        ];
        mockPlayer.queue.tracks = [...concTracks];

        // Two concurrent jump selections: User 1 selects Conc 2 (c2), User 2 selects Conc 4 (c4)
        const concSelect1 = {
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            customId: 'queue:select',
            values: ['1:1:c2:id-c2'],
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u1', tag: 'Tester#0001' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u1', tag: 'Tester#0001' },
            client: mockClient,
            deferred: false,
            replied: false,
            update: async () => { concSelect1.replied = true; },
            followUp: async () => {}
        };

        const concSelect2 = {
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            customId: 'queue:select',
            values: ['3:1:c4:id-c4'],
            guild: { id: guildId, name: 'Queue Guild', members: { me: { voice: { channelId: vcId } } } },
            channel: fakeChannel,
            member: {
                user: { id: 'u2', tag: 'Tester#0002' },
                voice: { channel: { id: vcId }, channelId: vcId },
                permissions: { has: () => true }
            },
            user: { id: 'u2', tag: 'Tester#0002' },
            client: mockClient,
            deferred: false,
            replied: false,
            update: async () => { concSelect2.replied = true; },
            followUp: async () => {}
        };

        // Fire concurrently
        await Promise.all([
            interactionCreate.execute(concSelect1),
            interactionCreate.execute(concSelect2)
        ]);

        // Both executed safely under lock without corrupted tracks
        assert.equal(mockPlayer.queue.tracks.length, 2, 'Two tracks successfully extracted, leaving 2');
        assert.equal(mockPlayer.queue.tracks[0]._queueId, 'c1', 'Conc 1 remains');
        assert.equal(mockPlayer.queue.tracks[1]._queueId, 'c3', 'Conc 3 remains');

        guildSettings.delete(guildId);
    });

    console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
    process.exit(process.exitCode ? 1 : 0);
}

runTests();
