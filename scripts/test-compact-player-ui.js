/**
 * Test Suite: Compact ZYRO Music Player UI Redesign
 * Validates layout, violet accent, controls, embeds, duplicate prevention, and lifecycle.
 */

const assert = require('assert');
const { createNowPlayingEmbed, createStoppedEmbed, COLORS } = require('../src/utils/zyroEmbeds');
const PlayerController = require('../src/utils/PlayerController');

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}`);
        console.error(err);
        process.exit(1);
    }
}

(async () => {
    console.log('\n--- Testing ZYRO Compact Player UI Redesign ---');

    await test('1. The dashboard uses the new compact ZYRO layout and signature violet accent (#7C3AED)', async () => {
        const mockPlayer = {
            guildId: 'guild-ui-1',
            playing: true,
            paused: false,
            volume: 100,
            repeatMode: 'off',
            position: 45000,
            queue: {
                current: {
                    info: {
                        title: 'Violet Sky',
                        author: 'Aurora',
                        duration: 180000,
                        uri: 'https://youtube.com/watch?v=sky',
                        artworkUrl: 'https://example.com/art.png'
                    },
                    requester: { username: 'NightOwl' }
                },
                tracks: []
            }
        };

        const embed = createNowPlayingEmbed(mockPlayer, mockPlayer.queue.current, {
            user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
            is247Enabled: () => false,
            autoplayEnabled: new Map([['guild-ui-1', false]])
        });

        assert.equal(embed.data.color, 0x7C3AED, 'Must use ZYRO violet accent #7C3AED');
        assert.equal(embed.data.author.name, '🎵 ZYRO • NOW PLAYING', 'Must have 🎵 ZYRO • NOW PLAYING heading');
        assert.ok(embed.data.description.includes('### [Violet Sky](https://youtube.com/watch?v=sky)'), 'Prominent blue/link title');
        assert.ok(embed.data.description.includes('by **Aurora**'), 'Artist directly beneath title');
        assert.equal(embed.data.thumbnail.url, 'https://example.com/art.png', 'Artwork in thumbnail (upper right)');
        assert.ok(embed.data.footer.text.includes('ZYRO Music'), 'Footer has ZYRO Music branding');
    });

    await test('2. The current title, artist, artwork, duration and requester are correct', async () => {
        const track = {
            info: {
                title: 'Starlight Symphony',
                author: 'Celeste',
                duration: 215000,
                uri: 'https://youtube.com/watch?v=celeste',
                artworkUrl: 'https://example.com/celeste.png'
            },
            userData: { requester: { username: 'Cosmo' } }
        };

        const mockPlayer = {
            guildId: 'guild-ui-2',
            playing: true,
            paused: false,
            volume: 85,
            repeatMode: 'track',
            position: 30000,
            queue: { current: track, tracks: [] }
        };

        const embed = createNowPlayingEmbed(mockPlayer, track, {
            user: { displayAvatarURL: () => null },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        });

        assert.ok(embed.data.description.includes('Starlight Symphony'));
        assert.ok(embed.data.description.includes('Celeste'));
        assert.equal(embed.data.thumbnail.url, 'https://example.com/celeste.png');
        assert.ok(embed.data.description.includes('Cosmo'));
        assert.ok(embed.data.description.includes('🔊 `85%`'));
        assert.ok(embed.data.description.includes('Loop: `🔂 Track`'));
        assert.ok(embed.data.description.includes('0:30 / 3:35'));
    });

    await test('3. Up Next contains the real next track, not a duplicate of the current track', async () => {
        const currentTrack = {
            info: { identifier: 'id-cur', title: 'Current Jam', author: 'Artist 1', duration: 180000, uri: 'https://youtube.com/watch?v=cur' }
        };
        const nextTrack = {
            info: { identifier: 'id-next', title: 'Upcoming Banger', author: 'Artist 2', duration: 200000, uri: 'https://youtube.com/watch?v=next' }
        };

        const mockPlayer = {
            guildId: 'guild-ui-3',
            playing: true,
            paused: false,
            volume: 100,
            repeatMode: 'off',
            position: 10000,
            queue: { current: currentTrack, tracks: [nextTrack] }
        };

        const embed = createNowPlayingEmbed(mockPlayer, currentTrack, {
            user: { displayAvatarURL: () => null },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        });

        assert.equal(embed.data.fields?.length, 1);
        const upNextField = embed.data.fields[0];
        assert.equal(upNextField.name, '⏭️ Up Next');
        assert.ok(upNextField.value.includes('Upcoming Banger'));
        assert.ok(upNextField.value.includes('Artist 2'));
        assert.ok(upNextField.value.includes('3:20'));
        assert.ok(!upNextField.value.includes('Current Jam'), 'Up Next must not duplicate current track');
    });

    await test('4. All primary and secondary controls are present and functional in compact layout', async () => {
        const mockClient = {
            user: { displayAvatarURL: () => null },
            is247Enabled: () => true,
            autoplayEnabled: new Map([['guild-ui-4', true]])
        };
        const controller = new PlayerController(mockClient);

        const player = {
            guildId: 'guild-ui-4',
            playing: true,
            paused: false,
            repeatMode: 'queue',
            queue: {
                current: { info: { title: 'Track 1', duration: 120000 } },
                tracks: [{ info: { title: 'Track 2' } }, { info: { title: 'Track 3' } }],
                previous: [{ info: { title: 'Old Track' } }]
            }
        };

        const rows = controller.createPlayerButtons(player);
        assert.equal(rows.length, 2, 'Must have 2 rows: Primary and Secondary (seek controls removed)');

        // Row 1: Primary Controls
        const row1Ids = rows[0].components.map(b => b.data.custom_id);
        assert.deepEqual(row1Ids, ['player:playpause', 'player:skip', 'player:shuffle', 'player:stop']);
        assert.equal(rows[0].components[0].data.label, 'Pause');
        assert.equal(rows[0].components[2].data.disabled, false, 'Shuffle enabled with 2 tracks');
        assert.equal(rows[0].components[3].data.emoji.name, '🟥', 'Stop has 🟥 emoji');

        // Row 2: Secondary Controls
        const row2Ids = rows[1].components.map(b => b.data.custom_id);
        assert.deepEqual(row2Ids, ['player:back', 'player:autoplay', 'player:queue', 'player:loop']);
        assert.equal(rows[1].components[0].data.disabled, false, 'Previous enabled with history');
        assert.equal(rows[1].components[1].data.style, 3, 'Autoplay active has Success style');
        assert.equal(rows[1].components[3].data.label, 'Loop: Queue');

        // Verify seek controls and 24/7 button are completely removed
        const allIds = rows.flatMap(r => r.components.map(b => b.data.custom_id));
        assert.ok(!allIds.some(id => id.startsWith('player:seek')), 'Must not contain any seek controls');
        assert.ok(!allIds.includes('player:247'), 'Must not contain 24/7 toggle button');
    });

    await test('5. Successful /play does not create competing public Enqueued Track and partial Now Playing embeds', async () => {
        const guildId = 'guild-ui-5';
        const channelId = 'channel-ui-5';

        const sentMessages = [];
        const fakeChannel = {
            id: channelId,
            name: 'music',
            type: 0,
            permissionsFor: () => ({ has: () => true }),
            send: async (payload) => {
                const msg = {
                    id: `msg-${Date.now()}-${Math.random()}`,
                    channelId,
                    embeds: payload.embeds || [],
                    components: payload.components || [],
                    edit: async (update) => {
                        msg.embeds = update.embeds || msg.embeds;
                        msg.components = update.components || msg.components;
                        return msg;
                    },
                    delete: async () => true
                };
                sentMessages.push(msg);
                return msg;
            }
        };

        const mockClient = {
            channels: { cache: new Map([[channelId, fakeChannel]]), fetch: async () => fakeChannel },
            guilds: { cache: new Map() },
            guildSettings: { get: () => ({ textChannelId: channelId }), getDashboard: () => null, setDashboard: () => {} },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    playing: true,
                    paused: false,
                    textChannelId: channelId,
                    position: 5000,
                    queue: {
                        current: { info: { identifier: 'track-A', title: 'Track A', author: 'Artist A', duration: 180000, uri: 'https://youtube.com/watch?v=a' } },
                        tracks: []
                    }
                })
            },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        await controller.replaceWithFullDashboard(guildId, channelId);

        assert.equal(sentMessages.length, 1, 'Only exactly 1 dashboard sent');
        assert.equal(sentMessages[0].embeds[0].data.author.name, '🎵 ZYRO • NOW PLAYING');
    });

    await test('6. A queued song is not shown as playing before it starts', async () => {
        const currentSong = { info: { identifier: 'id-current', title: 'Current Song', duration: 180000 } };
        const queuedSong = { info: { identifier: 'id-queued', title: 'Queued Song', duration: 200000 } };

        const player = {
            guildId: 'guild-ui-6',
            playing: true,
            paused: false,
            volume: 100,
            repeatMode: 'off',
            position: 25000,
            queue: {
                current: currentSong,
                tracks: [queuedSong]
            }
        };

        const embed = createNowPlayingEmbed(player, currentSong, {
            user: { displayAvatarURL: () => null },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        });

        assert.ok(embed.data.description.includes('Current Song'), 'Current song is in now playing');
        assert.ok(!embed.data.description.includes('Queued Song'), 'Queued song must NOT be shown in now playing description');
        assert.equal(embed.data.fields[0].name, '⏭️ Up Next');
        assert.ok(embed.data.fields[0].value.includes('Queued Song'), 'Queued song is shown only in Up Next');
    });

    await test('7. A track change produces one complete dashboard at the bottom', async () => {
        const guildId = 'guild-ui-7';
        const channelId = 'channel-ui-7';
        const activeMessages = new Map();

        const fakeChannel = {
            id: channelId,
            name: 'music',
            type: 0,
            permissionsFor: () => ({ has: () => true }),
            send: async (payload) => {
                const id = `dash-${Date.now()}-${Math.random()}`;
                const msg = {
                    id,
                    channelId,
                    embeds: payload.embeds,
                    components: payload.components,
                    delete: async () => { activeMessages.delete(id); }
                };
                activeMessages.set(id, msg);
                return msg;
            },
            messages: {
                cache: activeMessages,
                fetch: async (id) => activeMessages.get(id)
            }
        };

        let currentTrack = { info: { identifier: 'song-1', title: 'Song 1', duration: 180000 } };
        const mockClient = {
            channels: { cache: new Map([[channelId, fakeChannel]]), fetch: async () => fakeChannel },
            guilds: { cache: new Map() },
            guildSettings: { get: () => ({ textChannelId: channelId }), getDashboard: () => null, setDashboard: () => {} },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    playing: true,
                    textChannelId: channelId,
                    position: 0,
                    queue: { current: currentTrack, tracks: [] }
                })
            },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);

        // Track 1
        await controller.replaceWithFullDashboard(guildId, channelId);
        assert.equal(activeMessages.size, 1);

        // Track change to Track 2
        currentTrack = { info: { identifier: 'song-2', title: 'Song 2', duration: 210000 } };
        await controller.replaceWithFullDashboard(guildId, channelId);
        await controller.cleanupStaleMessages(guildId);
        assert.equal(activeMessages.size, 1, 'Only one active dashboard after track change');
    });

    await test('8. Progress updates edit the current dashboard in place', async () => {
        const guildId = 'guild-ui-8';
        const channelId = 'channel-ui-8';
        let sendCount = 0;
        let editCount = 0;

        const fakeMessage = {
            id: 'msg-prog-1',
            channelId,
            embeds: [],
            components: [],
            edit: async (payload) => {
                editCount++;
                return fakeMessage;
            }
        };

        const fakeChannel = {
            id: channelId,
            type: 0,
            permissionsFor: () => ({ has: () => true }),
            send: async () => {
                sendCount++;
                return fakeMessage;
            },
            messages: {
                cache: new Map([['msg-prog-1', fakeMessage]]),
                fetch: async () => fakeMessage
            }
        };

        const track = { info: { identifier: 'prog-track', title: 'Progress Track', duration: 200000 } };
        const mockPlayer = {
            guildId,
            playing: true,
            paused: false,
            textChannelId: channelId,
            position: 10000,
            queue: { current: track, tracks: [] }
        };

        const mockClient = {
            channels: { cache: new Map([[channelId, fakeChannel]]), fetch: async () => fakeChannel },
            guilds: { cache: new Map() },
            guildSettings: { get: () => ({ textChannelId: channelId }), getDashboard: () => ({ messageId: 'msg-prog-1', channelId }), setDashboard: () => {} },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: { getPlayer: () => mockPlayer },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard(guildId, { messageId: 'msg-prog-1', channelId });

        // Update with replace: false (normal progress tick)
        await controller.updatePlayer(guildId, { replace: false, channelId });

        assert.equal(sendCount, 0, 'Must NOT send new message for progress update');
        assert.equal(editCount, 1, 'Must edit existing dashboard in place');
    });

    await test('9. Failed replacement sends preserve the previous valid dashboard', async () => {
        const guildId = 'guild-ui-9';
        const channelId = 'channel-ui-9';

        const fakeChannel = {
            id: channelId,
            type: 0,
            permissionsFor: () => ({ has: () => true }),
            send: async () => { throw new Error('Network error'); }
        };

        const mockClient = {
            channels: { cache: new Map([[channelId, fakeChannel]]), fetch: async () => fakeChannel },
            guilds: { cache: new Map() },
            guildSettings: { get: () => ({ textChannelId: channelId }), getDashboard: () => ({ messageId: 'orig-dash', channelId }), setDashboard: () => {} },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: { getPlayer: () => ({ guildId, playing: true, textChannelId: channelId, queue: { current: { info: { title: 'T' } }, tracks: [] } }) },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard(guildId, { messageId: 'orig-dash', channelId });

        const result = await controller.sendReplacementPlayer(guildId, { force: true });
        assert.equal(result, null);
        assert.equal(controller.getDashboard(guildId).messageId, 'orig-dash', 'Must preserve original dashboard ID on failure');
    });

    await test('10. Concurrent events never create duplicate dashboards', async () => {
        const guildId = 'guild-ui-10';
        const channelId = 'channel-ui-10';
        let totalSent = 0;

        const fakeChannel = {
            id: channelId,
            type: 0,
            permissionsFor: () => ({ has: () => true }),
            send: async (payload) => {
                totalSent++;
                const msg = {
                    id: `msg-${totalSent}`,
                    channelId,
                    embeds: payload.embeds,
                    components: payload.components,
                    edit: async () => msg,
                    delete: async () => true
                };
                return msg;
            },
            messages: {
                cache: new Map(),
                fetch: async (id) => ({ id, channelId, edit: async () => ({}) })
            }
        };

        const track = { info: { identifier: 'concurrent-song', title: 'Concurrent Song', duration: 180000 } };
        const mockPlayer = {
            guildId,
            playing: true,
            textChannelId: channelId,
            position: 0,
            queue: { current: track, tracks: [] }
        };

        const mockClient = {
            channels: { cache: new Map([[channelId, fakeChannel]]), fetch: async () => fakeChannel },
            guilds: { cache: new Map() },
            guildSettings: { get: () => ({ textChannelId: channelId }), getDashboard: () => null, setDashboard: () => {} },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: { getPlayer: () => mockPlayer },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);

        // Run 3 simultaneous replacements for same track
        await Promise.all([
            controller.replaceWithFullDashboard(guildId, channelId),
            controller.replaceWithFullDashboard(guildId, channelId),
            controller.replaceWithFullDashboard(guildId, channelId)
        ]);

        assert.equal(totalSent, 1, 'Only 1 message created despite 3 concurrent calls');
    });

    await test('11. Stopped/Idle embed provides clean state and functional stopped buttons', async () => {
        const mockClient = {
            user: { displayAvatarURL: () => null },
            is247Enabled: () => false
        };

        const embed = createStoppedEmbed({ guildId: 'g-stop' }, mockClient, 'vc-123');
        assert.equal(embed.data.color, COLORS.NEUTRAL);
        assert.equal(embed.data.author.name, 'ZYRO • IDLE');
        assert.ok(embed.data.description.includes('Playback stopped and queue cleared'));
        assert.ok(embed.data.description.includes('<#vc-123>'));

        const controller = new PlayerController(mockClient);
        const stoppedButtons = controller.createStoppedButtons({ guildId: 'g-stop' });
        assert.equal(stoppedButtons.length, 0, 'Stopped state must have no playback buttons');
        assert.deepEqual(stoppedButtons, [], 'Stopped components payload must be empty');
    });

    console.log('\n========================================');
    console.log('Compact Player UI Tests: 11/11 passed');
    console.log('========================================\n');
})();
