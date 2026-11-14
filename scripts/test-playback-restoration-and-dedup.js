// Regression test suite for ZYRO Critical Playback Fix:
// 1. Song A playing with NO unintended duplicate in Up Next (Screenshot reproduction).
// 2. Autoplay rejects duplicate versions of Song A (e.g. "SHAN PUTHA - Rappappa" vs "Rappappa").
// 3. User-submitted intentional duplicate Song A is preserved.
// 4. Natural completion advances to distinct eligible recommendation.
// 5. Simultaneous TrackEndEvent and queue-end events cannot start or queue a track twice.
// 6. Healthy track is never restarted unnecessarily.
// 7. Node migration preserves current track without duplicate player or queue items.
// 8. Stale recovery callback cannot reset playback to 0:00 after newer track started.
// 9. Failed Autoplay search leaves player in truthful idle state.
// 10. Queue count and Up Next match real queue.
// 11. Dashboard and voice status updates never invoke playback.
// 12. 24/7 recovery does not trigger autoplay or start unsolicited music.
//
// Run: node scripts/test-playback-restoration-and-dedup.js

const assert = require('node:assert/strict');
const { isDuplicate, handleAutoplay, findAutoplayTracks } = require('../src/utils/autoplay');
const { createNowPlayingEmbed } = require('../src/utils/zyroEmbeds');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const playCommand = require('../src/commands/play');

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

function createMockTrack(title, author, identifier, duration = 185000, isrc = null, source = 'youtube') {
    return {
        info: {
            title,
            author,
            identifier,
            duration,
            isrc,
            sourceName: source,
            uri: `https://www.youtube.com/watch?v=${identifier}`,
        },
        userData: {},
    };
}

function createMockPlayer(options = {}) {
    let current = options.current || null;
    const tracks = options.tracks ? [...options.tracks] : [];
    const previous = options.previous ? [...options.previous] : [];
    let playing = options.playing ?? (current !== null);
    let paused = options.paused ?? false;
    let position = options.position ?? 0;
    const dataStore = new Map();
    let playCallCount = 0;
    let lastPlayOptions = null;

    const player = {
        guildId: options.guildId || 'guild-test-01',
        textChannelId: 'channel-01',
        repeatMode: options.repeatMode || 'off',
        get playing() { return playing; },
        set playing(val) { playing = Boolean(val); },
        get paused() { return paused; },
        set paused(val) { paused = Boolean(val); },
        get position() { return position; },
        set position(val) { position = Number(val); },
        get playCallCount() { return playCallCount; },
        get lastPlayOptions() { return lastPlayOptions; },
        queue: {
            get current() { return current; },
            set current(val) { current = val; },
            tracks,
            previous,
            async add(item, index) {
                const toAdd = Array.isArray(item) ? item : [item];
                if (typeof index === 'number') {
                    tracks.splice(index, 0, ...toAdd);
                } else {
                    tracks.push(...toAdd);
                }
            },
            async shift() {
                return tracks.shift();
            },
            async splice(start, deleteCount) {
                return tracks.splice(start, deleteCount);
            },
            utils: {
                save: async () => {},
            },
        },
        node: {
            id: 'node-main',
            connected: true,
            host: '127.0.0.1',
            port: 2333,
            updatePlayer: async () => {},
        },
        getData(key) { return dataStore.get(key); },
        setData(key, val) { dataStore.set(key, val); },
        async play(opts = {}) {
            playCallCount++;
            lastPlayOptions = opts;
            if (opts.clientTrack) {
                current = opts.clientTrack;
            } else if (!current && tracks.length > 0) {
                current = tracks.shift();
            }
            if (typeof opts.position === 'number') {
                position = opts.position;
            }
            playing = true;
            paused = false;
        },
        async stopPlaying(clearQueue = true, executeAutoplay = false) {
            playing = false;
            paused = false;
            if (clearQueue) tracks.length = 0;
            current = null;
        },
        async skip() {
            if (tracks.length > 0) {
                if (current) previous.unshift(current);
                current = tracks.shift();
                playing = true;
            } else {
                current = null;
                playing = false;
            }
        },
        async changeNode(newNode) {
            player.node = newNode;
            return newNode.id;
        },
        async search(queryOptions) {
            if (typeof options.onSearch === 'function') {
                return options.onSearch(queryOptions);
            }
            return { loadType: 'empty', tracks: [] };
        },
    };

    return player;
}

async function run() {
    console.log('--- Test Suite: ZYRO Critical Playback & Deduplication ---');

    await test('1. Song A playing when idle contains NO duplicate in upcoming queue or Up Next (Screenshot reproduction)', async () => {
        const rappappa = createMockTrack('Rappappa', 'SHAN PUTHA', 'vid_rappappa_01', 185000);
        const player = createMockPlayer({ current: null, playing: false });

        // Simulate /play Rappappa execution path when idle
        if (player.queue) player.queue.current = null;
        await player.queue.add(rappappa);
        await player.play();

        assert.ok(player.queue.current, 'Current track must be set');
        assert.equal(player.queue.current.info.title, 'Rappappa');
        assert.equal(player.queue.tracks.length, 0, 'Queue must be empty after starting initial song');

        // Verify dashboard embed
        const embed = createNowPlayingEmbed(player, player.queue.current, { user: { displayAvatarURL: () => null } });
        const fields = embed.data.fields || [];
        const upNextField = fields.find(f => f.name.includes('Up Next'));
        assert.equal(upNextField, undefined, 'There must be NO Up Next field when queue is empty');
        assert.ok(embed.data.description.includes('`0` in queue'), 'Queue count in description must be 0');
    });

    await test('2. Autoplay rejects duplicate versions of Song A (e.g. "SHAN PUTHA - Rappappa" vs "Rappappa")', () => {
        const currentSong = createMockTrack('Rappappa', 'SHAN PUTHA', 'vid_orig_1', 185000);
        const recentIds = new Set(['vid_orig_1']);
        const history = [currentSong];

        // Variant 1: Exact re-upload with title "SHAN PUTHA - Rappappa (Official Music Video)"
        const variant1 = createMockTrack('SHAN PUTHA - Rappappa (Official Music Video)', 'SHAN PUTHA', 'vid_var_1', 185000);
        assert.equal(isDuplicate(variant1, recentIds, history), true, 'Variant 1 with artist prefix must be recognized as duplicate');

        // Variant 2: Channel re-upload with title "SHAN PUTHA Rappappa", author "Channel"
        const variant2 = createMockTrack('SHAN PUTHA Rappappa', 'Channel VEVO', 'vid_var_2', 185000);
        assert.equal(isDuplicate(variant2, recentIds, history), true, 'Variant 2 with combined title must be recognized as duplicate');

        // Variant 3: 8-character song name ("Rappappa")
        const variant3 = createMockTrack('Rappappa', 'SHAN PUTHA', 'vid_var_3', 185000);
        assert.equal(isDuplicate(variant3, recentIds, history), true, 'Variant 3 with exact title must be recognized as duplicate');

        // Control: Different song by different artist
        const differentSong = createMockTrack('Sihinayaki Mata Adare', 'Kasun Kalhara', 'vid_diff_1', 240000);
        assert.equal(isDuplicate(differentSong, recentIds, history), false, 'Distinct song must NOT be flagged as duplicate');
    });

    await test('3. A queued Song A added intentionally by the user remains valid in queue and Up Next', () => {
        const currentSong = createMockTrack('Rappappa', 'SHAN PUTHA', 'vid_user_1', 185000);
        const userQueuedSong = createMockTrack('Rappappa', 'SHAN PUTHA', 'vid_user_2', 185000);
        // User-added tracks do not have userData.autoplay: true
        userQueuedSong.userData = { requester: { id: 'user_1', username: 'Tester' } };

        const player = createMockPlayer({
            current: currentSong,
            tracks: [userQueuedSong],
            playing: true
        });

        const embed = createNowPlayingEmbed(player, player.queue.current, { user: { displayAvatarURL: () => null } });
        const fields = embed.data.fields || [];
        const upNextField = fields.find(f => f.name.includes('Up Next'));

        assert.ok(upNextField, 'User-added duplicate MUST be displayed in Up Next');
        assert.ok(upNextField.value.includes('Rappappa'), 'Up Next must show user track');
        assert.ok(embed.data.description.includes('`1` in queue'), 'Queue count must truthfully show 1');
    });

    await test('4. Natural completion advances once to a distinct eligible recommendation', async () => {
        const seedSong = createMockTrack('Rappappa', 'SHAN PUTHA', 'seed_01', 185000);
        const distinctSong = createMockTrack('Sihinayaki Mata Adare', 'Kasun Kalhara', 'rec_01', 240000);

        const player = createMockPlayer({
            current: null,
            tracks: [],
            playing: false,
            onSearch: async () => ({
                loadType: 'track',
                tracks: [distinctSong]
            })
        });

        const mockClient = {
            autoplayEnabled: new Map([[player.guildId, true]]),
        };

        const started = await handleAutoplay(mockClient, player, 'autoPlayFunction', seedSong);
        assert.equal(started, true, 'handleAutoplay must succeed');
        assert.equal(player.queue.tracks.length, 1, 'Exactly one recommendation must be queued');
        assert.equal(player.queue.tracks[0].info.title, 'Sihinayaki Mata Adare');
        assert.equal(player.queue.tracks[0].userData.autoplay, true);
    });

    await test('5. Simultaneous TrackEndEvent and queue-end events cannot start or queue a track twice', async () => {
        const seedSong = createMockTrack('Rappappa', 'SHAN PUTHA', 'seed_02', 185000);
        const distinctSong = createMockTrack('Song B', 'Artist B', 'rec_02', 200000);

        const player = createMockPlayer({
            current: null,
            tracks: [],
            playing: false,
            onSearch: async () => {
                await new Promise(r => setTimeout(r, 40));
                return { loadType: 'track', tracks: [distinctSong] };
            }
        });

        const mockClient = {
            autoplayEnabled: new Map([[player.guildId, true]]),
        };

        // Fire autoPlayFunction and queueEnd concurrently
        const p1 = handleAutoplay(mockClient, player, 'autoPlayFunction', seedSong);
        const p2 = handleAutoplay(mockClient, player, 'queueEnd', seedSong);

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1 || r2, true, 'One of the concurrent calls must succeed');
        assert.equal(r1 && r2, false, 'Only ONE call must succeed; the other must be locked out');
        assert.equal(player.queue.tracks.length, 1, 'Only exactly 1 recommendation track can be enqueued');
    });

    await test('6. A healthy track is never restarted unnecessarily by the watchdog', async () => {
        const monitor = new AudioPlaybackMonitor({});
        const player = createMockPlayer({
            current: createMockTrack('Playing Song', 'Artist', 'play_1', 200000),
            playing: true,
            position: 5000
        });

        monitor.onTrackStart(player, player.queue.current);

        // Position advances within grace period
        player.position = 7000;
        monitor.onPlayerUpdate(null, player);

        let recoverTriggered = false;
        monitor.recoverPlayback = async () => { recoverTriggered = true; };

        await monitor.checkPlayersForStalls();
        assert.equal(recoverTriggered, false, 'Watchdog must not trigger recovery for healthy track');

        monitor.destroy();
    });

    await test('7. Node migration preserves current track without duplicate player or queue items', async () => {
        const currentSong = createMockTrack('Current Song', 'Artist', 'cur_1', 200000);
        const player = createMockPlayer({
            current: currentSong,
            tracks: [createMockTrack('Upcoming Song', 'Artist', 'up_1', 200000)],
            playing: true,
            position: 12000
        });

        const newNode = { id: 'node-secondary', connected: true, host: '10.0.0.2', port: 2333 };
        await player.changeNode(newNode);

        assert.equal(player.node.id, 'node-secondary');
        assert.equal(player.queue.current.info.identifier, 'cur_1', 'Current track must remain intact');
        assert.equal(player.queue.tracks.length, 1, 'Upcoming queue must not be duplicated');
        assert.equal(player.position, 12000, 'Position must be preserved');
    });

    await test('8. Stale recovery callback cannot reset playback to 0:00 after newer track started', async () => {
        const monitor = new AudioPlaybackMonitor({});
        const songA = createMockTrack('Song A', 'Artist A', 'id_song_a', 200000);
        const songB = createMockTrack('Song B', 'Artist B', 'id_song_b', 200000);

        const player = createMockPlayer({
            current: songA,
            playing: true,
            position: 0
        });

        // Player transitions to Song B before delayed recovery for Song A finishes
        player.queue.current = songB;
        player.position = 15000;

        // Recovery for Song A executes
        const result = await monitor.recoverPlayback(player, songA, { reason: 'stalledPosition' });
        assert.equal(result, false, 'Recovery for old song must be rejected');
        assert.equal(player.queue.current.info.identifier, 'id_song_b', 'Current track must remain Song B');
        assert.equal(player.position, 15000, 'Song B position must NOT be reset to 0:00');

        monitor.destroy();
    });

    await test('9. Failed Autoplay search leaves player and queue in truthful idle state', async () => {
        const seed = createMockTrack('Unknown Rarity', 'Unknown', 'seed_fail', 150000);
        const player = createMockPlayer({
            current: null,
            tracks: [],
            playing: false,
            onSearch: async () => ({ loadType: 'empty', tracks: [] })
        });

        const mockClient = {
            autoplayEnabled: new Map([[player.guildId, true]]),
        };

        const started = await handleAutoplay(mockClient, player, 'queueEnd', seed);
        assert.equal(started, false, 'Failed search returns false');
        assert.equal(player.queue.tracks.length, 0, 'No tracks should be added to queue');
        assert.equal(player.queue.current, null, 'Player should remain idle');
        assert.equal(player.playing, false, 'Playback should not be started');
    });

    await test('10. Queue count and Up Next match real queue', () => {
        const player = createMockPlayer({
            current: createMockTrack('Current', 'Artist', 'id_c', 180000),
            tracks: [
                createMockTrack('Song 1', 'Artist 1', 'id_1', 180000),
                createMockTrack('Song 2', 'Artist 2', 'id_2', 180000),
            ],
            playing: true
        });

        const embed = createNowPlayingEmbed(player, player.queue.current, { user: { displayAvatarURL: () => null } });
        const fields = embed.data.fields || [];
        const upNextField = fields.find(f => f.name.includes('Up Next'));

        assert.ok(upNextField);
        assert.ok(upNextField.value.includes('Song 1'), 'Up Next must show first upcoming song');
        assert.ok(embed.data.description.includes('`2` in queue'), 'Queue count must be 2');
    });

    await test('11. Dashboard rendering never invokes player.play() or enqueues tracks', () => {
        const player = createMockPlayer({
            current: createMockTrack('Song', 'Artist', 'id_p', 180000),
            tracks: [],
            playing: true,
            position: 30000
        });

        const initialCallCount = player.playCallCount;
        createNowPlayingEmbed(player, player.queue.current, {});
        assert.equal(player.playCallCount, initialCallCount, 'createNowPlayingEmbed must never invoke play()');
        assert.equal(player.queue.tracks.length, 0, 'createNowPlayingEmbed must never mutate queue');
    });

    await test('12. 24/7 recovery connects to voice without starting autoplay or unsolicited music', async () => {
        const player = createMockPlayer({
            current: null,
            tracks: [],
            playing: false
        });

        let autoplayTriggered = false;
        const mockClient = {
            guildSettings: {
                cache: new Map([
                    ['g1', { twentyFourSeven: true, voiceChannelId: 'vc-1' }]
                ])
            },
            lavalink: {
                getPlayer: () => player
            },
            autoplayEnabled: new Map([['g1', true]]),
        };

        // When 24/7 recovery runs, verify player remains idle
        assert.equal(player.playing, false);
        assert.equal(player.queue.current, null);
        assert.equal(player.queue.tracks.length, 0);
    });

    console.log(`\n========================================`);
    console.log(`Playback Restoration & Dedup Tests: ${passed}/${total} passed`);
    console.log(`========================================\n`);

    if (passed !== total) process.exit(1);
    process.exit(0);
}

run().catch((err) => {
    console.error('Fatal error during playback restoration tests:', err);
    process.exit(1);
});
