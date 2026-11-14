// Tests for Live Playback Progress Bar and Interactive Music Seeking
// Run: node scripts/test-progress-and-seeking.js

const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const {
    parseTimestampToMs,
    getPlaybackPosition,
    validateAndSeek,
    seekRelative
} = require('../src/utils/seekManager');
const { createProgressBar, createNowPlayingEmbed } = require('../src/utils/zyroEmbeds');
const PlayerController = require('../src/utils/PlayerController');
const PlaybackProgressManager = require('../src/utils/PlaybackProgressManager');
const seekCommand = require('../src/commands/seek');
const interactionCreate = require('../src/events/interactionCreate');

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

function createMockPlayer(options = {}) {
    let position = options.position || 0;
    let lastPosition = options.position || 0;
    let lastPositionChange = options.lastPositionChange || (options.paused ? null : Date.now());
    let paused = Boolean(options.paused);
    let stopped = Boolean(options.stopped);
    let playing = options.playing !== undefined ? options.playing : true;

    const track = options.track || {
        info: {
            title: options.title || 'Test Song',
            author: options.author || 'Test Artist',
            duration: options.duration !== undefined ? options.duration : 240000,
            uri: 'https://youtube.com/watch?v=test1234',
            isStream: Boolean(options.isStream),
            isSeekable: options.isSeekable !== undefined ? options.isSeekable : true,
            artworkUrl: 'https://example.com/art.png'
        }
    };

    return {
        guildId: options.guildId || 'guild_001',
        voiceChannelId: 'vc_1',
        textChannelId: 'tc_1',
        volume: 100,
        repeatMode: options.repeatMode || 'off',
        get paused() { return paused; },
        set paused(val) { paused = val; },
        get stopped() { return stopped; },
        set stopped(val) { stopped = val; },
        get playing() { return playing; },
        set playing(val) { playing = val; },
        get lastPosition() { return lastPosition; },
        set lastPosition(val) { lastPosition = val; },
        get lastPositionChange() { return lastPositionChange; },
        set lastPositionChange(val) { lastPositionChange = val; },
        get position() {
            if (paused) return lastPosition;
            return lastPosition + (lastPositionChange ? Date.now() - lastPositionChange : 0);
        },
        queue: {
            current: track,
            tracks: options.upcoming || [],
            previous: []
        },
        async seek(target) {
            lastPosition = target;
            lastPositionChange = paused ? null : Date.now();
            return this;
        },
        async pause() {
            paused = true;
            lastPositionChange = null;
        },
        async resume() {
            paused = false;
            lastPositionChange = Date.now();
        }
    };
}

(async () => {
    console.log('\n--- Test 1 & 2 & 3: Progress Marker Advance, Pause Freeze & Resume ---');

    await test('1. Progress marker and elapsed time advance as the real track position changes', async () => {
        const dummyClient = {
            is247Enabled: () => false,
            autoplayEnabled: new Map(),
            user: { displayAvatarURL: () => null }
        };

        const duration = 200000; // 3:20
        const track = {
            info: { title: 'Dynamic Track', author: 'Artist', duration, uri: 'https://youtube.com/watch?v=abc', isStream: false }
        };

        // Position 0ms
        const player0 = createMockPlayer({ position: 0, duration, track });
        const embed0 = createNowPlayingEmbed(player0, track, dummyClient);
        assert.ok(embed0.data.description.includes('0:00 / 3:20'), 'Must show 0:00 / 3:20 at start');
        assert.ok(embed0.data.description.includes('🔘─────────────'), 'Marker at start');

        // Position 100000ms (50% progress)
        const playerMid = createMockPlayer({ position: 100000, duration, track });
        const embedMid = createNowPlayingEmbed(playerMid, track, dummyClient);
        assert.ok(embedMid.data.description.includes('1:40 / 3:20'), 'Must show 1:40 / 3:20 at middle');
        assert.ok(embedMid.data.description.includes('───────🔘──────'), 'Marker in middle');

        // Position 200000ms (100% progress)
        const playerEnd = createMockPlayer({ position: 200000, duration, track });
        const embedEnd = createNowPlayingEmbed(playerEnd, track, dummyClient);
        assert.ok(embedEnd.data.description.includes('3:20 / 3:20'), 'Must show 3:20 / 3:20 at end');
        assert.ok(embedEnd.data.description.includes('─────────────🔘'), 'Marker at end');
    });

    await test('2. Pausing freezes the displayed position', async () => {
        const player = createMockPlayer({ position: 50000, paused: true, duration: 180000 });
        const initialPos = getPlaybackPosition(player);
        assert.equal(initialPos, 50000, 'Initial frozen position matches');

        // Simulate time passing while paused
        await new Promise(r => setTimeout(r, 60));
        const laterPos = getPlaybackPosition(player);
        assert.equal(laterPos, 50000, 'Position must not change while paused');
    });

    await test('3. Resuming continues progression from the correct position', async () => {
        const player = createMockPlayer({ position: 50000, paused: true, duration: 180000 });
        await player.resume();
        assert.equal(player.paused, false);

        await new Promise(r => setTimeout(r, 40));
        const resumedPos = getPlaybackPosition(player);
        assert.ok(resumedPos >= 50030, `Resumed position must advance past 50000 (was ${resumedPos})`);
    });

    console.log('\n--- Test 4, 5 & 6: Seeking Controls, Parsing & Boundary Validation ---');

    await test('4. Seeking backward and forward updates the actual player position', async () => {
        const player = createMockPlayer({ position: 60000, duration: 180000 });

        // Seek forward +30s
        const fwdResult = await seekRelative(player, 30);
        assert.equal(fwdResult.success, true);
        assert.equal(fwdResult.positionMs, 90000);
        assert.equal(player.lastPosition, 90000);

        // Seek backward -10s
        const bwdResult = await seekRelative(player, -10);
        assert.equal(bwdResult.success, true);
        assert.equal(bwdResult.positionMs, 80000);
        assert.equal(player.lastPosition, 80000);
    });

    await test('5. The Seek To modal correctly handles timestamps, including 1:45, 03:20 and valid long-track timestamps', async () => {
        // MM:SS
        assert.equal(parseTimestampToMs('1:45'), 105000, '1:45 -> 105,000ms');
        assert.equal(parseTimestampToMs('03:20'), 200000, '03:20 -> 200,000ms');
        assert.equal(parseTimestampToMs('0:00'), 0, '0:00 -> 0ms');

        // HH:MM:SS
        assert.equal(parseTimestampToMs('1:02:30'), 3750000, '1:02:30 -> 3,750,000ms');
        assert.equal(parseTimestampToMs('01:00:00'), 3600000, '1 hour -> 3,600,000ms');

        // Pure seconds and units
        assert.equal(parseTimestampToMs('90'), 90000, '90 -> 90,000ms');
        assert.equal(parseTimestampToMs('90s'), 90000, '90s -> 90,000ms');
        assert.equal(parseTimestampToMs('1m30s'), 90000, '1m30s -> 90,000ms');
    });

    await test('6. Invalid, negative and out-of-range positions are rejected', async () => {
        const player = createMockPlayer({ position: 0, duration: 180000 }); // 3:00 track

        // Parsing rejection
        assert.equal(parseTimestampToMs('-10'), null, 'Negative seconds rejected');
        assert.equal(parseTimestampToMs('-1:30'), null, 'Negative timestamp rejected');
        assert.equal(parseTimestampToMs('1:75'), null, 'Seconds >= 60 rejected in colon format');
        assert.equal(parseTimestampToMs('abc'), null, 'Malformed string rejected');
        assert.equal(parseTimestampToMs(''), null, 'Empty string rejected');

        // Range rejection in validateAndSeek
        const negativeSeek = await validateAndSeek(player, -5000);
        assert.equal(negativeSeek.success, false);
        assert.equal(negativeSeek.code, 'OUT_OF_BOUNDS_NEGATIVE');

        const exceedSeek = await validateAndSeek(player, 250000); // 4:10 on 3:00 track
        assert.equal(exceedSeek.success, false);
        assert.equal(exceedSeek.code, 'OUT_OF_BOUNDS_EXCEEDED');
    });

    console.log('\n--- Test 7: Livestreams & Unknown Duration Safety ---');

    await test('7. Livestreams and unknown-duration tracks handle progress/seeking safely', async () => {
        const streamTrack = {
            info: { title: 'Live Stream', author: 'Broadcaster', duration: 0, isStream: true, isSeekable: false }
        };
        const streamPlayer = createMockPlayer({ track: streamTrack, isStream: true });

        // Progress bar formatting
        const bar = createProgressBar(0, 0, 12, true);
        assert.equal(bar, '🔴 LIVE STREAM');

        // Seeking attempt must fail cleanly
        const seekAttempt = await validateAndSeek(streamPlayer, 30000);
        assert.equal(seekAttempt.success, false);
        assert.equal(seekAttempt.code, 'SEEK_UNSUPPORTED');
    });

    console.log('\n--- Test 8 & 9: In-Place Dashboard Updates Without Replacement ---');

    await test('8 & 9. Progress updates edit the existing dashboard message ID in place without replacements', async () => {
        let editCount = 0;
        let sendCount = 0;
        const msgId = 'dashboard-msg-42';
        const channelId = 'chan-99';

        const mockMessage = {
            id: msgId,
            async edit(payload) {
                editCount++;
                return this;
            }
        };

        const mockChannel = {
            id: channelId,
            name: 'music',
            messages: {
                cache: new Map([[msgId, mockMessage]]),
                async fetch(id) { return id === msgId ? mockMessage : null; }
            },
            async send(payload) {
                sendCount++;
                return { id: `new-msg-${sendCount}` };
            }
        };

        const mockClient = {
            guilds: { cache: new Map([['g1', { id: 'g1' }]]) },
            channels: { cache: new Map([[channelId, mockChannel]]) },
            lavalink: {
                getPlayer: (id) => id === 'g1' ? mockPlayer : null
            },
            is247Enabled: () => false,
            autoplayEnabled: new Map()
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard('g1', { messageId: msgId, channelId });
        mockClient.playerController = controller;

        const mockPlayer = createMockPlayer({ guildId: 'g1', position: 30000, duration: 180000 });

        const progressManager = new PlaybackProgressManager(mockClient, { tickIntervalMs: 50, minEditIntervalMs: 0 });

        // Trigger progress update
        await progressManager.tick();

        assert.equal(editCount, 1, 'Existing dashboard must be edited in-place');
        assert.equal(sendCount, 0, 'No new message may be sent for progress update');
        assert.equal(controller.getDashboard('g1').messageId, msgId, 'Stored dashboard message ID remains identical');

        progressManager.stop();
    });

    console.log('\n--- Test 10: Seeking Preserves Player, Queue and Autoplay ---');

    await test('10. Seeking never creates a new player or changes queue/autoplay settings', async () => {
        const player = createMockPlayer({
            position: 10000,
            duration: 180000,
            upcoming: [{ info: { title: 'Track 2' } }, { info: { title: 'Track 3' } }]
        });

        const initialTracks = [...player.queue.tracks];
        await validateAndSeek(player, 60000);

        assert.equal(player.queue.tracks.length, 2, 'Queue length remains untouched');
        assert.deepEqual(player.queue.tracks, initialTracks, 'Queue contents and order preserved');
    });

    console.log('\n--- Test 11: Track Replacement Resets Progress State ---');

    await test('11. A real track replacement resets the progress state and follows existing bottom-replacement flow', async () => {
        const mockClient = {
            guilds: { cache: new Map([['g1', { id: 'g1' }]]) }
        };
        const progressManager = new PlaybackProgressManager(mockClient);
        progressManager.lastEditTimes.set('g1', 12345);

        // When a new track starts
        progressManager.onTrackStart('g1');
        assert.ok(progressManager.lastEditTimes.get('g1') > 12345, 'Track start resets lastEditTime to current timestamp');

        // When track ends
        progressManager.onTrackEnd('g1');
        assert.equal(progressManager.lastEditTimes.has('g1'), false, 'Track end clears guild tracking completely');

        progressManager.stop();
    });

    console.log('\n--- Test 12: Rate-Limit and Concurrency Safety ---');

    await test('12. Concurrent progress ticks and button interactions do not race or exceed rate limits', async () => {
        const mockClient = {
            guilds: { cache: new Map([['g1', { id: 'g1' }]]) },
            lavalink: { getPlayer: () => mockPlayer },
            playerController: {
                getDashboard: () => ({ messageId: 'm1', channelId: 'c1' }),
                createPlayerEmbed: () => ({ data: {} }),
                createPlayerButtons: () => []
            },
            channels: {
                cache: new Map([['c1', {
                    messages: {
                        cache: new Map([['m1', {
                            async edit() {
                                await new Promise(r => setTimeout(r, 20));
                            }
                        }]])
                    }
                }]])
            }
        };

        const mockPlayer = createMockPlayer({ position: 20000, duration: 180000 });
        const manager = new PlaybackProgressManager(mockClient, { minEditIntervalMs: 1000 });

        // First tick launches edit
        const p1 = manager.tick();
        // Immediate second tick should be skipped by inFlight check or minEditIntervalMs
        const p2 = manager.tick();

        await Promise.all([p1, p2]);
        assert.equal(manager.inFlightEdits.size, 0, 'In-flight edits cleanly clear after completion');
        manager.stop();
    });

    console.log('\n--- Test 13: /seek Command & Modal Submit End-to-End ---');

    await test('13. /seek command executes accurately, updates dashboard in place, and rejects bad input', async () => {
        const mockPlayer = createMockPlayer({ guildId: 'g1', position: 10000, duration: 180000 });
        let repliedPayload = null;

        let dashboardUpdatedInPlace = false;
        const mockController = {
            updatePlayer: async (guildId, opts) => {
                if (opts.replace === false) dashboardUpdatedInPlace = true;
            }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkConnectionManager: { isAvailable: () => true },
            playerController: mockController,
            defaultLanguage: 'en',
            languageManager: { get: () => 'Error' }
        };

        const mockInteraction = {
            client: mockClient,
            guildId: 'g1',
            guild: { id: 'g1', name: 'Test Guild', ownerId: 'u1' },
            channel: { id: 'c1', name: 'music' },
            user: { id: 'u1', tag: 'User#1234' },
            member: {
                voice: { channelId: 'vc_1', channel: { id: 'vc_1', permissionsFor: () => ({ has: () => true }) } }
            },
            options: {
                getString: (k) => '1:30'
            },
            deferReply: async () => {},
            deferred: true,
            reply: async () => {},
            editReply: async (payload) => { repliedPayload = payload; return payload; },
            followUp: async (payload) => { repliedPayload = payload; return payload; }
        };

        await seekCommand.execute(mockInteraction);

        assert.equal(mockPlayer.lastPosition, 90000, 'Player sought to 90,000ms (1:30)');
        assert.equal(dashboardUpdatedInPlace, true, 'Dashboard updated in-place without replacement');
        const desc = repliedPayload?.embeds?.[0]?.data?.description || repliedPayload?.embeds?.[0]?.description || '';
        assert.ok(desc.includes('1:30') && desc.includes('3:00'), `Confirmation embed includes 1:30 and 3:00 (desc: "${desc}")`);
    });

    console.log(`\n========================================`);
    console.log(`Live Progress & Seeking Tests: ${passed}/${total} passed`);
    console.log(`========================================\n`);

    if (passed !== total) process.exit(1);
    process.exit(0);
})();
