const assert = require('node:assert/strict');
const { handleAutoplay } = require('../src/utils/autoplay');
const guildSettings = require('../src/utils/guildSettings');

function makeTrack(id, title, opts = {}) {
    return {
        info: {
            identifier: id,
            title,
            author: opts.author || 'Artist',
            sourceName: opts.sourceName || 'youtube',
            isrc: opts.isrc || null,
            duration: opts.duration || 180000,
            isStream: opts.isStream || false,
            uri: opts.uri || `https://youtube.com/watch?v=${id}`,
        },
        userData: opts.userData || {},
    };
}

async function runTests() {
    console.log('--- Infinite Limitless Autoplay Regression Suite ---');
    let passed = 0;

    async function check(name, fn) {
        try {
            await fn();
            passed++;
            console.log(`  ok  - ${name}`);
        } catch (err) {
            console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
            process.exit(1);
        }
    }

    // 1. Playlist session clears and allows autoplay on queueEnd
    await check('1. Playlist session transitions into autoplay on queueEnd when autoplay is enabled', async () => {
        let sessionCleared = false;
        let queuedTracks = [];

        const player = {
            guildId: 'guild-infinite-pl',
            playing: false,
            queue: {
                current: null,
                previous: [makeTrack('pl-end-1', 'Last Song in Mix')],
                tracks: [],
                add: async (tracks) => { queuedTracks.push(...tracks); }
            },
            getData(key) {
                if (key === 'playlistSession') return { isPlaylist: true };
                return null;
            },
            setData(key, val) {
                if (key === 'playlistSession' && val === null) sessionCleared = true;
            },
            play: async () => {},
            async search({ query }) {
                return {
                    loadType: 'playlist',
                    tracks: [makeTrack('auto-next-1', 'Autoplay Recommended Song')]
                };
            }
        };

        const mockClient = {
            autoplayEnabled: { get: () => true }
        };

        const started = await handleAutoplay(mockClient, player, 'queueEnd');
        assert.equal(started, true, 'Autoplay must start on queueEnd even if previous session was a playlist');
        assert.equal(sessionCleared, true, 'playlistSession flag must be cleared');
        assert.equal(queuedTracks.length, 1, 'Exactly one recommendation queued');
        assert.equal(queuedTracks[0].info.title, 'Autoplay Recommended Song');
    });

    // 2. Candidate pool exhaustion does not fail: soft fallback and emergency search succeed
    await check('2. Soft fallback prevents autoplay stoppage when all candidates match previous history', async () => {
        let queuedTracks = [];
        const prevTrack = makeTrack('id-repeat', 'Repeated Song');

        const player = {
            guildId: 'guild-exhaustion',
            playing: false,
            queue: {
                current: null,
                previous: [prevTrack],
                tracks: [],
                add: async (tracks) => { queuedTracks.push(...tracks); }
            },
            getData: () => null,
            setData: () => {},
            play: async () => {},
            async search() {
                // Returns candidates that would normally be treated as soft duplicates
                return {
                    loadType: 'playlist',
                    tracks: [makeTrack('id-repeat', 'Repeated Song')]
                };
            }
        };

        const mockClient = {
            autoplayEnabled: { get: () => true }
        };

        const started = await handleAutoplay(mockClient, player, 'queueEnd', prevTrack);
        assert.equal(started, true, 'Must not return false when soft duplicates exist');
        assert.equal(queuedTracks.length, 1);
    });

    // 3. Queue is empty debounce protection: does not suppress discovery when queue is empty and bot stopped
    await check('3. Does not suppress autoplay discovery on queueEnd even if rapid debounce window is active', async () => {
        let queuedTracks = [];
        const seed = makeTrack('rapid-seed', 'Rapid Song');

        const player = {
            guildId: 'guild-rapid-test',
            playing: false,
            queue: {
                current: null,
                previous: [seed],
                tracks: [],
                add: async (tracks) => { queuedTracks.push(...tracks); }
            },
            getData: () => null,
            setData: () => {},
            play: async () => {},
            async search() {
                return {
                    loadType: 'playlist',
                    tracks: [makeTrack('rec-rapid', 'Rapid Rec')]
                };
            }
        };

        const mockClient = {
            autoplayEnabled: { get: () => true }
        };

        // First call records seed
        await handleAutoplay(mockClient, player, 'queueEnd', seed);
        queuedTracks = [];

        // Second call 100ms later while player is still idle / queue empty
        const started = await handleAutoplay(mockClient, player, 'queueEnd', seed);
        assert.equal(started, true, 'Must not suppress discovery when queue is empty and playback is not active');
        assert.equal(queuedTracks.length, 1);
    });

    // 4. Autoplay settings persistence in guildSettings
    await check('4. Autoplay mode correctly sets and gets in guildSettings', () => {
        const testGuild = 'guild-settings-autoplay-test';
        assert.equal(guildSettings.isAutoplay(testGuild), false);

        guildSettings.setAutoplay(testGuild, true);
        assert.equal(guildSettings.isAutoplay(testGuild), true);

        guildSettings.setAutoplay(testGuild, false);
        assert.equal(guildSettings.isAutoplay(testGuild), false);

        guildSettings.delete(testGuild);
    });

    console.log(`\n========================================`);
    console.log(`Infinite Autoplay Tests: ${passed}/4 passed`);
    console.log(`========================================\n`);
}

runTests();
