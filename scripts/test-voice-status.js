const assert = require('assert');
const { PermissionsBitField, Routes } = require('discord.js');
const VoiceChannelStatusManager = require('../src/utils/voiceChannelStatusManager');

console.log('Testing ZYRO Discord Voice Channel Status Manager...');

// Helper to create mock channel
function createMockChannel(id, name, guild, perms = [PermissionsBitField.Flags.SetVoiceChannelStatus, PermissionsBitField.Flags.ManageChannels]) {
    const permBitfield = new PermissionsBitField(perms);
    return {
        id,
        name,
        guild,
        isVoiceBased: () => true,
        permissionsFor: (member) => permBitfield,
    };
}

// Helper to create mock guild
function createMockGuild(id, name) {
    const guild = {
        id,
        name,
        members: {
            me: {
                id: 'zyro-bot-id',
                voice: { channelId: null }
            }
        },
        channels: {
            cache: new Map()
        }
    };
    return guild;
}

// Helper to create mock client
function createMockClient() {
    const putCalls = [];
    const client = {
        user: { id: 'zyro-bot-id' },
        guilds: { cache: new Map() },
        channels: { cache: new Map() },
        guildSettings: {
            get: (guildId) => ({ voiceChannelId: null }),
            is247: (guildId) => false,
        },
        activePlayers: new Map(),
        autoplayEnabled: new Map(),
        lavalink: {
            players: new Map(),
            getPlayer: (guildId) => client.lavalink.players.get(guildId) || null,
        },
        rest: {
            putCalls,
            put: async (route, { body }) => {
                putCalls.push({ route, body, timestamp: Date.now() });
                return { success: true };
            }
        }
    };
    return client;
}

async function runTests() {
    let passed = 0;
    const check = (title, fn) => {
        try {
            fn();
            console.log(`  ok  - ${title}`);
            passed++;
        } catch (err) {
            console.error(`  FAIL - ${title}`);
            console.error(err);
            process.exit(1);
        }
    };

    const asyncCheck = async (title, fn) => {
        try {
            await fn();
            console.log(`  ok  - ${title}`);
            passed++;
        } catch (err) {
            console.error(`  FAIL - ${title}`);
            console.error(err);
            process.exit(1);
        }
    };

    // -------------------------------------------------------------------------
    // Test 1: Track start sets the correct voice channel status
    // -------------------------------------------------------------------------
    await asyncCheck('1. Track start sets the correct voice channel status via PUT /channels/{id}/voice-status', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);
        client.voiceChannelStatusManager = manager;

        const guild = createMockGuild('g1', 'Music Server');
        const channel = createMockChannel('vc-1', 'General Voice', guild);
        guild.channels.cache.set('vc-1', channel);
        client.guilds.cache.set('g1', guild);
        client.channels.cache.set('vc-1', channel);
        guild.members.me.voice.channelId = 'vc-1';

        const player = {
            guildId: 'g1',
            voiceChannelId: 'vc-1',
            playing: true,
            paused: false,
            queue: {
                current: {
                    info: {
                        title: 'Ramapir No Helo',
                        author: 'Bholu Jalampura'
                    }
                }
            }
        };

        const res = await manager.updateFromPlayer(player, player.queue.current, 'playing');
        assert.strictEqual(res.success, true);
        assert.strictEqual(client.rest.putCalls.length, 1);
        assert.strictEqual(client.rest.putCalls[0].route, Routes.channelVoiceStatus('vc-1'));
        assert.deepStrictEqual(client.rest.putCalls[0].body, {
            status: '♪ Ramapir No Helo | Bholu Jalampura'
        });
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Ramapir No Helo | Bholu Jalampura');
    });

    // -------------------------------------------------------------------------
    // Test 2: Track change replaces previous title and artist
    // -------------------------------------------------------------------------
    await asyncCheck('2. Track change replaces previous title and artist', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g1', 'Music Server');
        const channel = createMockChannel('vc-1', 'General Voice', guild);
        guild.channels.cache.set('vc-1', channel);
        client.guilds.cache.set('g1', guild);
        client.channels.cache.set('vc-1', channel);
        guild.members.me.voice.channelId = 'vc-1';

        const player = {
            guildId: 'g1',
            voiceChannelId: 'vc-1',
            playing: true,
            paused: false,
            queue: {
                current: {
                    info: {
                        title: 'Song One',
                        author: 'Artist Alpha'
                    }
                }
            }
        };

        await manager.updateFromPlayer(player, player.queue.current, 'playing');
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Song One | Artist Alpha');

        // Track changes to Track Two
        player.queue.current = {
            info: {
                title: 'Bohemian Rhapsody',
                author: 'Queen'
            }
        };

        await manager.updateFromPlayer(player, player.queue.current, 'playing');
        assert.strictEqual(client.rest.putCalls.length, 2);
        assert.strictEqual(client.rest.putCalls[1].body.status, '♪ Bohemian Rhapsody | Queen');
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Bohemian Rhapsody | Queen');
    });

    // -------------------------------------------------------------------------
    // Test 3: Natural queue transition and autoplay update status
    // -------------------------------------------------------------------------
    await asyncCheck('3. Natural queue transition and autoplay update the status', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g1', 'Music Server');
        const channel = createMockChannel('vc-1', 'General Voice', guild);
        guild.channels.cache.set('vc-1', channel);
        client.guilds.cache.set('g1', guild);
        client.channels.cache.set('vc-1', channel);
        guild.members.me.voice.channelId = 'vc-1';

        const player = {
            guildId: 'g1',
            voiceChannelId: 'vc-1',
            playing: true,
            paused: false,
            queue: {
                current: {
                    info: { title: 'First Queued Song', author: 'Singer 1' }
                }
            }
        };

        // Natural transition to next track
        await manager.updateFromPlayer(player, player.queue.current, 'playing');
        assert.strictEqual(client.rest.putCalls[client.rest.putCalls.length - 1].body.status, '♪ First Queued Song | Singer 1');

        // Autoplay recommended track starts
        const autoplayTrack = {
            info: { title: 'Autoplay Radio Hit', author: 'Radio Star' }
        };
        player.queue.current = autoplayTrack;
        await manager.updateFromPlayer(player, autoplayTrack, 'playing');

        assert.strictEqual(client.rest.putCalls[client.rest.putCalls.length - 1].body.status, '♪ Autoplay Radio Hit | Radio Star');
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Autoplay Radio Hit | Radio Star');
    });

    // -------------------------------------------------------------------------
    // Test 4: Pause/resume and stop produce accurate status states
    // -------------------------------------------------------------------------
    await asyncCheck('4. Pause/resume and stop produce accurate status states', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g1', 'Music Server');
        const channel = createMockChannel('vc-1', 'General Voice', guild);
        guild.channels.cache.set('vc-1', channel);
        client.guilds.cache.set('g1', guild);
        client.channels.cache.set('vc-1', channel);
        guild.members.me.voice.channelId = 'vc-1';

        const player = {
            guildId: 'g1',
            voiceChannelId: 'vc-1',
            playing: true,
            paused: false,
            queue: {
                current: { info: { title: 'Hotel California', author: 'Eagles' } }
            }
        };

        // Start playing
        await manager.updateFromPlayer(player, player.queue.current, 'playing');
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Hotel California | Eagles');

        // Pause keeps current track status without pretending another track is playing
        player.paused = true;
        await manager.updateFromPlayer(player, player.queue.current, 'paused');
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Hotel California | Eagles');

        // Resume
        player.paused = false;
        await manager.updateFromPlayer(player, player.queue.current, 'playing');
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Hotel California | Eagles');

        // Stop
        await manager.clearStatusForGuild('g1');
        assert.strictEqual(client.rest.putCalls[client.rest.putCalls.length - 1].body.status, '');
        assert.strictEqual(manager.managedStatuses.has('vc-1'), false);
    });

    // -------------------------------------------------------------------------
    // Test 5: /leave clears only a status managed by ZYRO
    // -------------------------------------------------------------------------
    await asyncCheck('5. /leave clears only a status managed by ZYRO and protects user manual statuses', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g1', 'Music Server');
        const channel = createMockChannel('vc-1', 'General Voice', guild);
        guild.channels.cache.set('vc-1', channel);
        client.guilds.cache.set('g1', guild);
        client.channels.cache.set('vc-1', channel);

        // A. Channel not managed by ZYRO: clearStatus skips
        const unmanagedRes = await manager.clearStatus('vc-1', 'g1');
        assert.strictEqual(unmanagedRes.skipped, true);
        assert.strictEqual(unmanagedRes.reason, 'not_managed_by_zyro');
        assert.strictEqual(client.rest.putCalls.length, 0);

        // B. ZYRO sets a status, then leaves: status is cleared
        await manager.setStatus('vc-1', '♪ Song | Artist', 'g1');
        assert.strictEqual(manager.managedStatuses.get('vc-1'), '♪ Song | Artist');

        const clearRes = await manager.clearStatus('vc-1', 'g1');
        assert.strictEqual(clearRes.success, true);
        assert.strictEqual(manager.managedStatuses.has('vc-1'), false);
        assert.strictEqual(client.rest.putCalls[client.rest.putCalls.length - 1].body.status, '');

        // C. User manual status protection:
        // If ZYRO set a status, but user manually changed it to "Staff Meeting"
        await manager.setStatus('vc-1', '♪ Track A | Singer A', 'g1');
        channel.status = 'Staff Meeting'; // User manually edited channel status

        const manualRes = await manager.clearStatus('vc-1', 'g1');
        assert.strictEqual(manualRes.skipped, true);
        assert.strictEqual(manualRes.reason, 'manually_changed');
        // Did not send empty PUT that would erase the user's manual "Staff Meeting"
        assert.notStrictEqual(client.rest.putCalls[client.rest.putCalls.length - 1].body.status, '');
    });

    // -------------------------------------------------------------------------
    // Test 6: /247 ON with an empty queue never displays a fake Now Playing song
    // -------------------------------------------------------------------------
    await asyncCheck('6. /247 ON with an empty queue never displays a fake Now Playing song', async () => {
        const client = createMockClient();
        client.guildSettings.is247 = (guildId) => true;
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g-247', '24/7 Server');
        const channel = createMockChannel('vc-247', '24/7 Chill', guild);
        guild.channels.cache.set('vc-247', channel);
        client.guilds.cache.set('g-247', guild);
        client.channels.cache.set('vc-247', channel);
        guild.members.me.voice.channelId = 'vc-247';

        // 24/7 player connected to voice, but queue is empty and playback stopped
        const player = {
            guildId: 'g-247',
            voiceChannelId: 'vc-247',
            playing: false,
            paused: false,
            queue: {
                current: null,
                tracks: []
            }
        };
        client.lavalink.players.set('g-247', player);

        // When empty queue update occurs
        const res = await manager.updateFromPlayer(player, null, 'playing');
        // Must clear or not set any "Now Playing" string
        assert.strictEqual(manager.managedStatuses.has('vc-247'), false);
        for (const call of client.rest.putCalls) {
            assert.strictEqual(call.body.status.includes('Now Playing'), false);
        }

        // Reconcile / sync check
        await manager.syncGuildPlayerStatus('g-247');
        assert.strictEqual(manager.managedStatuses.has('vc-247'), false);
    });

    // -------------------------------------------------------------------------
    // Test 7: A second guild receives updates only for its own voice channel
    // -------------------------------------------------------------------------
    await asyncCheck('7. A second guild receives updates only for its own voice channel', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guildA = createMockGuild('gA', 'Guild Alpha');
        const channelA = createMockChannel('vc-A', 'Alpha Voice', guildA);
        guildA.channels.cache.set('vc-A', channelA);
        guildA.members.me.voice.channelId = 'vc-A';
        client.guilds.cache.set('gA', guildA);
        client.channels.cache.set('vc-A', channelA);

        const guildB = createMockGuild('gB', 'Guild Beta');
        const channelB = createMockChannel('vc-B', 'Beta Voice', guildB);
        guildB.channels.cache.set('vc-B', channelB);
        guildB.members.me.voice.channelId = 'vc-B';
        client.guilds.cache.set('gB', guildB);
        client.channels.cache.set('vc-B', channelB);

        const playerA = {
            guildId: 'gA',
            voiceChannelId: 'vc-A',
            playing: true,
            queue: { current: { info: { title: 'Track A', author: 'Artist A' } } }
        };
        const playerB = {
            guildId: 'gB',
            voiceChannelId: 'vc-B',
            playing: true,
            queue: { current: { info: { title: 'Track B', author: 'Artist B' } } }
        };

        await manager.updateFromPlayer(playerA, playerA.queue.current, 'playing');
        await manager.updateFromPlayer(playerB, playerB.queue.current, 'playing');

        assert.strictEqual(manager.managedStatuses.get('vc-A'), '♪ Track A | Artist A');
        assert.strictEqual(manager.managedStatuses.get('vc-B'), '♪ Track B | Artist B');

        // Clearing Guild A must not alter Guild B's channel status
        await manager.clearStatusForGuild('gA');
        assert.strictEqual(manager.managedStatuses.has('vc-A'), false);
        assert.strictEqual(manager.managedStatuses.get('vc-B'), '♪ Track B | Artist B');
    });

    // -------------------------------------------------------------------------
    // Test 8: Duplicate track events do not cause repeated identical API calls
    // -------------------------------------------------------------------------
    await asyncCheck('8. Duplicate track events do not cause repeated identical API calls (deduplication)', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g1', 'Music Server');
        const channel = createMockChannel('vc-1', 'General Voice', guild);
        guild.channels.cache.set('vc-1', channel);
        client.guilds.cache.set('g1', guild);
        client.channels.cache.set('vc-1', channel);
        guild.members.me.voice.channelId = 'vc-1';

        const player = {
            guildId: 'g1',
            voiceChannelId: 'vc-1',
            playing: true,
            queue: { current: { info: { title: 'Same Song', author: 'Same Artist' } } }
        };

        // 1st call
        const res1 = await manager.updateFromPlayer(player, player.queue.current, 'playing');
        assert.strictEqual(res1.success, true);
        assert.strictEqual(client.rest.putCalls.length, 1);

        // 2nd, 3rd, 4th duplicate events with identical song
        const res2 = await manager.updateFromPlayer(player, player.queue.current, 'playing');
        const res3 = await manager.updateFromPlayer(player, player.queue.current, 'playing');
        const res4 = await manager.updateFromPlayer(player, player.queue.current, 'playing');

        assert.strictEqual(res2.skipped, true);
        assert.strictEqual(res3.skipped, true);
        assert.strictEqual(res4.skipped, true);
        // REST put calls must remain exactly 1!
        assert.strictEqual(client.rest.putCalls.length, 1);
    });

    // -------------------------------------------------------------------------
    // Test 9: Permission failures and rate limits do not crash the bot
    // -------------------------------------------------------------------------
    await asyncCheck('9. Permission failures and rate limits do not crash the bot', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g-noperm', 'Restricted Server');
        // Channel without SET_VOICE_CHANNEL_STATUS permission
        const channelNoPerm = createMockChannel('vc-noperm', 'Restricted Voice', guild, []);
        guild.channels.cache.set('vc-noperm', channelNoPerm);
        client.guilds.cache.set('g-noperm', guild);
        client.channels.cache.set('vc-noperm', channelNoPerm);

        // A. Missing local permission when connected
        guild.members.me.voice.channelId = 'vc-noperm';
        const resPermConnected = await manager.setStatus('vc-noperm', '♪ Test | Artist', 'g-noperm');
        assert.strictEqual(resPermConnected.success, false);
        assert.strictEqual(resPermConnected.reason, 'missing_permissions');
        assert.deepStrictEqual(resPermConnected.missing, ['SET_VOICE_CHANNEL_STATUS']);

        // A2. Missing local permissions when NOT connected (requires SET_VOICE_CHANNEL_STATUS and MANAGE_CHANNELS)
        guild.members.me.voice.channelId = null;
        const resPermDisconnected = await manager.setStatus('vc-noperm', '♪ Test | Artist', 'g-noperm', { force: true });
        assert.strictEqual(resPermDisconnected.success, false);
        assert.strictEqual(resPermDisconnected.reason, 'missing_permissions');
        assert.deepStrictEqual(resPermDisconnected.missing, ['SET_VOICE_CHANNEL_STATUS', 'MANAGE_CHANNELS']);

        // B. Discord API 50013 Missing Permissions error simulation
        guild.members.me.voice.channelId = 'vc-api-err';
        const channelPerm = createMockChannel('vc-api-err', 'API Err Voice', guild);
        guild.channels.cache.set('vc-api-err', channelPerm);
        client.channels.cache.set('vc-api-err', channelPerm);

        client.rest.put = async () => {
            const err = new Error('Missing Permissions');
            err.code = 50013;
            err.status = 403;
            throw err;
        };

        const res50013 = await manager.setStatus('vc-api-err', '♪ Test | Artist', 'g-noperm');
        assert.strictEqual(res50013.success, false);
        assert.strictEqual(res50013.error, 50013);

        // C. Rate limit 429 simulation
        client.rest.put = async () => {
            const err = new Error('You are being rate limited');
            err.code = 429;
            err.status = 429;
            throw err;
        };

        const res429 = await manager.setStatus('vc-api-err', '♪ Test | Artist', 'g-noperm', { force: true });
        assert.strictEqual(res429.success, false);
        assert.strictEqual(res429.error, 429);
    });

    // -------------------------------------------------------------------------
    // Test 10: Reconnection and migration restore the correct status
    // -------------------------------------------------------------------------
    await asyncCheck('10. Reconnection restores the correct status after actual playback resumes', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g-recon', 'Reconnection Server');
        const channel = createMockChannel('vc-recon', 'Voice Lounge', guild);
        guild.channels.cache.set('vc-recon', channel);
        client.guilds.cache.set('g-recon', guild);
        client.channels.cache.set('vc-recon', channel);
        guild.members.me.voice.channelId = 'vc-recon';

        const player = {
            guildId: 'g-recon',
            voiceChannelId: 'vc-recon',
            playing: true,
            paused: false,
            queue: {
                current: { info: { title: 'Recovered Track', author: 'Resilient Artist' } }
            }
        };
        client.lavalink.players.set('g-recon', player);

        // Bot reconnects or node migration completes: sync status
        await manager.syncGuildPlayerStatus('g-recon');

        assert.strictEqual(client.rest.putCalls.length, 1);
        assert.strictEqual(client.rest.putCalls[0].body.status, '♪ Recovered Track | Resilient Artist');
        assert.strictEqual(manager.managedStatuses.get('vc-recon'), '♪ Recovered Track | Resilient Artist');
    });

    // -------------------------------------------------------------------------
    // Test 11: Text length safe within 500-character limit
    // -------------------------------------------------------------------------
    check('11. Text formatting safely caps at Discord 500-character limit without breaking', () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const giantTitle = 'A'.repeat(400);
        const giantArtist = 'B'.repeat(300);

        const status = manager.formatStatus(giantTitle, giantArtist);
        assert(status.length <= 500, `Status length (${status.length}) exceeds 500 chars`);
        assert(status.startsWith('♪ '));
        assert(status.includes(' | '));
        assert(status.endsWith('…') || status.endsWith('...'));
    });

    // -------------------------------------------------------------------------
    // Test 12: Production Screenshot Regression — Connected bot in "General" voice
    // Targets voice channel, never text channel, and requires only SET_VOICE_CHANNEL_STATUS
    // -------------------------------------------------------------------------
    await asyncCheck('12. Production Regression: Connected bot updates "General" voice status without requiring MANAGE_CHANNELS and never targets text channel', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);
        client.voiceChannelStatusManager = manager;

        const guild = createMockGuild('g-prod', 'Production Server');
        // Only grant SET_VOICE_CHANNEL_STATUS (bot does NOT have MANAGE_CHANNELS)
        const voiceChannel = createMockChannel('vc-general', 'General', guild, [PermissionsBitField.Flags.SetVoiceChannelStatus]);
        voiceChannel.members = new Map([['zyro-bot-id', { id: 'zyro-bot-id' }]]);

        // Text channel where /play was invoked
        const textChannel = {
            id: 'tc-play-invoked',
            name: 'music-commands',
            guild,
            isVoiceBased: () => false,
            type: 0,
        };

        guild.channels.cache.set('vc-general', voiceChannel);
        guild.channels.cache.set('tc-play-invoked', textChannel);
        client.guilds.cache.set('g-prod', guild);
        client.channels.cache.set('vc-general', voiceChannel);
        client.channels.cache.set('tc-play-invoked', textChannel);

        guild.members.me.voice.channelId = 'vc-general';

        const player = {
            guildId: 'g-prod',
            voiceChannelId: 'vc-general',
            textChannelId: 'tc-play-invoked',
            playing: true,
            paused: false,
            queue: {
                current: { info: { title: 'Ramapir No Helo', author: 'Bholu Jalampura' } }
            }
        };
        client.lavalink.players.set('g-prod', player);

        // Update from player
        const result = await manager.updateFromPlayer(player);
        assert.strictEqual(result.success, true, 'Status update must succeed without MANAGE_CHANNELS when connected');

        // Verify PUT request targeted vc-general, NOT tc-play-invoked
        assert.strictEqual(client.rest.putCalls.length, 1, 'Exactly one REST PUT must be made');
        assert.strictEqual(client.rest.putCalls[0].route, Routes.channelVoiceStatus('vc-general'), 'Must target voice channel route');
        assert.notStrictEqual(client.rest.putCalls[0].route, Routes.channelVoiceStatus('tc-play-invoked'), 'Must never target text channel route');
        assert.strictEqual(client.rest.putCalls[0].body.status, '♪ Ramapir No Helo | Bholu Jalampura');
        assert.strictEqual(manager.managedStatuses.get('vc-general'), '♪ Ramapir No Helo | Bholu Jalampura');
    });

    // -------------------------------------------------------------------------
    // Test 13: Diagnostics on denied permission & uncached member fallback
    // -------------------------------------------------------------------------
    await asyncCheck('13. Production Regression: Denied SET_VOICE_CHANNEL_STATUS provides explicit diagnostic; uncached member falls back safely', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);
        client.voiceChannelStatusManager = manager;

        const guild = createMockGuild('g-diag', 'Diagnostic Server');
        // Channel with NO permissions granted
        const noPermChannel = createMockChannel('vc-locked', 'General Voice Locked', guild, []);
        noPermChannel.members = new Map([['zyro-bot-id', { id: 'zyro-bot-id' }]]);

        guild.channels.cache.set('vc-locked', noPermChannel);
        client.guilds.cache.set('g-diag', guild);
        client.channels.cache.set('vc-locked', noPermChannel);

        // Simulate uncached members.me: fallback locates channel where bot member is in members map
        delete guild.members.me;

        const player = {
            guildId: 'g-diag',
            voiceChannelId: 'vc-locked',
            playing: true,
            paused: false,
            queue: {
                current: { info: { title: 'Diagnostic Song', author: 'Artist' } }
            }
        };

        const result = await manager.updateFromPlayer(player);
        assert.strictEqual(result.success, false, 'Must fail cleanly on missing permission');
        assert.strictEqual(result.reason, 'missing_permissions');
        assert.ok(result.missing.includes('SET_VOICE_CHANNEL_STATUS'), 'Missing permission must explicitly mention SET_VOICE_CHANNEL_STATUS');
    });

    // -------------------------------------------------------------------------
    // Test 14: Screenshot Reference Example & Metadata Sanitization
    // Expected: ♪ Hithata Wadinama Sindu 01 | Manoparakata | Sinhala Songs
    // -------------------------------------------------------------------------
    check('14. Screenshot Reference Example: exact formatting and metadata sanitization', () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        // A. Exact screenshot example with title, artist, album/source
        const refStatus = manager.formatStatus('Hithata Wadinama Sindu 01', 'Manoparakata', 'Sinhala Songs');
        assert.strictEqual(refStatus, '♪ Hithata Wadinama Sindu 01 | Manoparakata | Sinhala Songs');

        // B. Track with YouTube source when album is absent
        const ytStatus = manager.formatStatus('Shape of You', 'Ed Sheeran', 'YouTube');
        assert.strictEqual(ytStatus, '♪ Shape of You | Ed Sheeran | YouTube');

        // C. Track with missing artist/source - no empty separators or 'undefined'
        const titleOnly = manager.formatStatus('Solo Guitar Acoustic', null, undefined);
        assert.strictEqual(titleOnly, '♪ Solo Guitar Acoustic');

        // D. Track with 'undefined' / 'null' / 'unknown' strings sanitized
        const dirtyMeta = manager.formatStatus('Clean Track   Title  ', 'unknown', 'null');
        assert.strictEqual(dirtyMeta, '♪ Clean Track Title');

        // E. Duplicate artist equal to title is suppressed
        const duplicateMeta = manager.formatStatus('Lofi Chill', 'Lofi Chill', null);
        assert.strictEqual(duplicateMeta, '♪ Lofi Chill');
    });

    // -------------------------------------------------------------------------
    // Test 15: Native voice channel status only — zero text channel spam or embeds
    // -------------------------------------------------------------------------
    await asyncCheck('15. Strict Native Status Only: Does not create embeds, text messages, or #general spam', async () => {
        const client = createMockClient();
        const manager = new VoiceChannelStatusManager(client);

        const guild = createMockGuild('g-clean', 'Clean Server');
        const voiceChannel = createMockChannel('vc-music', 'Music Lounge', guild);
        const textChannel = {
            id: 'tc-general',
            name: 'general',
            guild,
            sendCalls: [],
            send: async (payload) => {
                textChannel.sendCalls.push(payload);
                return { id: 'msg-1' };
            }
        };

        guild.channels.cache.set('vc-music', voiceChannel);
        guild.channels.cache.set('tc-general', textChannel);
        client.guilds.cache.set('g-clean', guild);
        client.channels.cache.set('vc-music', voiceChannel);
        client.channels.cache.set('tc-general', textChannel);
        guild.members.me.voice.channelId = 'vc-music';

        const player = {
            guildId: 'g-clean',
            voiceChannelId: 'vc-music',
            textChannelId: 'tc-general',
            playing: true,
            paused: false,
            queue: {
                current: {
                    info: {
                        title: 'Hithata Wadinama Sindu 01',
                        author: 'Manoparakata',
                        album: 'Sinhala Songs'
                    }
                }
            }
        };

        // 1. Play track
        const playResult = await manager.updateFromPlayer(player);
        assert.strictEqual(playResult.success, true);
        assert.strictEqual(client.rest.putCalls.length, 1);
        assert.strictEqual(client.rest.putCalls[0].route, Routes.channelVoiceStatus('vc-music'));
        assert.strictEqual(client.rest.putCalls[0].body.status, '♪ Hithata Wadinama Sindu 01 | Manoparakata | Sinhala Songs');

        // 2. Pause track -> status is maintained without changing to a fake pause message
        player.paused = true;
        const pauseResult = await manager.updateFromPlayer(player, 'paused');
        assert.strictEqual(pauseResult.success, true);
        assert.strictEqual(pauseResult.skipped, true, 'Status unchanged during pause to keep current track visible');

        // 3. Confirm zero text channel sends occurred
        assert.strictEqual(textChannel.sendCalls.length, 0, 'No text channel messages, embeds, or cards may be posted');
    });

    console.log(`\nAll ${passed} voice channel status tests passed successfully!\n`);
}

runTests().catch((err) => {
    console.error('Test runner encountered an error:', err);
    process.exit(1);
});
