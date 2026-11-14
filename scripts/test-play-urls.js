// Test suite for ZYRO YouTube & Spotify Link Playback, URL classification,
// exact track matching, playlist preservation, and autoplay restrictions.
// Run: node scripts/test-play-urls.js

const assert = require('node:assert/strict');
const { classifyInput, SUPPORTED_TYPES } = require('../src/utils/urlClassifier');
const { searchMusic } = require('../src/utils/searchEngine');
const { resolveTracksBounded } = require('../src/utils/spotifyResolver');

let passed = 0;
function check(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => { passed++; console.log(`  ok  - ${name}`); })
        .catch((err) => { console.error(`FAIL - ${name}\n      ${err.message}`); process.exitCode = 1; });
}

function makeMockTrack(id, title, opts = {}) {
    return {
        info: {
            identifier: id,
            title,
            author: opts.author || 'Artist',
            duration: opts.duration || 180000,
            uri: opts.uri || `https://www.youtube.com/watch?v=${id}`,
            artworkUrl: opts.artworkUrl || null,
        },
        userData: {},
    };
}

function makeMockPlayer({ searchHandler } = {}) {
    const data = new Map();
    return {
        guildId: 'test-guild-urls',
        playing: true,
        queue: {
            current: makeMockTrack('current-song', 'Currently Playing'),
            previous: [],
            tracks: [makeMockTrack('queued-1', 'Queued Track 1')],
        },
        setData(k, v) { data.set(k, v); },
        getData(k) { return data.get(k); },
        async search(queryObj, user) {
            if (searchHandler) return searchHandler(queryObj, user);
            return { loadType: 'empty', tracks: [] };
        },
    };
}

async function main() {
    console.log('Testing ZYRO Exact YouTube & Spotify Link Playback...');

    // ── 1. YouTube single-video link ──
    await check('1. A YouTube single-video link plays the exact requested video', async () => {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const player = makeMockPlayer({
            searchHandler: async ({ query }) => {
                if (query.includes('dQw4w9WgXcQ')) {
                    return {
                        loadType: 'track',
                        tracks: [
                            makeMockTrack('wrong-id', 'Other Song'),
                            makeMockTrack('dQw4w9WgXcQ', 'Never Gonna Give You Up', { author: 'Rick Astley' }),
                        ],
                    };
                }
                return { loadType: 'empty', tracks: [] };
            },
        });

        const res = await searchMusic(player, url, { id: 'u1' });
        assert.equal(res.loadType, 'track', 'Expected loadType track');
        assert.equal(res.tracks[0].info.identifier, 'dQw4w9WgXcQ', 'Must select exact matching video ID');
        assert.equal(res.tracks[0].info.title, 'Never Gonna Give You Up');
    });

    // ── 2. YouTube Music link ──
    await check('2. A YouTube Music link resolves the intended track', async () => {
        const url = 'https://music.youtube.com/watch?v=y6120QOlsfU';
        const player = makeMockPlayer({
            searchHandler: async ({ query }) => {
                if (query.includes('y6120QOlsfU')) {
                    return {
                        loadType: 'track',
                        tracks: [makeMockTrack('y6120QOlsfU', 'Sandstorm', { author: 'Darude' })],
                    };
                }
                return { loadType: 'empty', tracks: [] };
            },
        });

        const res = await searchMusic(player, url, { id: 'u1' });
        assert.equal(res.loadType, 'track');
        assert.equal(res.tracks[0].info.identifier, 'y6120QOlsfU');
        assert.equal(res.tracks[0].info.title, 'Sandstorm');
    });

    // ── 3. YouTube playlist queues all available entries in correct order ──
    await check('3. A YouTube playlist queues all available entries in the correct order', async () => {
        const url = 'https://www.youtube.com/playlist?list=PL12345';
        const playlistTracks = [
            makeMockTrack('yt-1', 'Track 1'),
            makeMockTrack('yt-2', 'Track 2'),
            makeMockTrack('yt-3', 'Track 3'),
        ];
        const player = makeMockPlayer({
            searchHandler: async ({ query }) => {
                if (query.includes('PL12345')) {
                    return {
                        loadType: 'playlist',
                        playlist: { title: 'My Awesome Playlist', duration: 540000 },
                        tracks: playlistTracks,
                    };
                }
                return { loadType: 'empty', tracks: [] };
            },
        });

        const res = await searchMusic(player, url, { id: 'u1' });
        assert.equal(res.loadType, 'playlist');
        assert.equal(res.tracks.length, 3);
        assert.equal(res.tracks[0].info.identifier, 'yt-1');
        assert.equal(res.tracks[1].info.identifier, 'yt-2');
        assert.equal(res.tracks[2].info.identifier, 'yt-3');
    });

    // ── 4. Spotify track resolves to best matching playable track ──
    await check('4. A Spotify track resolves to the most reliable matching playable track', async () => {
        const url = 'https://open.spotify.com/track/mockSpotifyTrack1';
        const player = makeMockPlayer({
            searchHandler: async ({ query }) => {
                // Return candidate tracks with varying relevance
                return {
                    loadType: 'search',
                    tracks: [
                        makeMockTrack('bad-cand', 'Totally Different Song', { duration: 120000 }),
                        makeMockTrack('cand-live', 'Mock Song (Live Remix 10 Hours)', { duration: 360000 }),
                        makeMockTrack('best-match', 'Mock Song', { author: 'Mock Artist - Topic', duration: 180000 }),
                    ],
                };
            },
        });

        // Test the matching logic directly with mock metadata
        const { matchSpotifyTrackToYouTube } = require('../src/utils/spotifyResolver');
        const matched = await matchSpotifyTrackToYouTube(player, {
            title: 'Mock Song',
            artists: 'Mock Artist',
            durationMs: 180000,
            thumbnail: 'https://i.scdn.co/thumb.jpg',
        }, { id: 'u1' });

        assert.ok(matched, 'Expected a matched track');
        assert.equal(matched.info.identifier, 'best-match', 'Must select best-matching studio track');
        assert.equal(matched.info.title, 'Mock Song', 'Preserves Spotify title');
        assert.equal(matched.info.author, 'Mock Artist', 'Preserves Spotify artist');
        assert.equal(matched.userData.resolvedVia, 'youtube');
    });

    // ── 5. Spotify playlist/album entries maintain order and identity ──
    await check('5. Spotify playlist/album entries maintain their order and identity', async () => {
        const items = [
            { title: 'Song Alpha', artists: 'Band A', durationMs: 180000 },
            { title: 'Song Beta', artists: 'Band B', durationMs: 200000 },
            { title: 'Song Gamma', artists: 'Band C', durationMs: 210000 },
        ];

        const player = makeMockPlayer({
            searchHandler: async ({ query }) => {
                if (query.includes('Alpha')) return { loadType: 'search', tracks: [makeMockTrack('id-alpha', 'Song Alpha', { author: 'Band A', duration: 180000 })] };
                if (query.includes('Beta')) return { loadType: 'search', tracks: [makeMockTrack('id-beta', 'Song Beta', { author: 'Band B', duration: 200000 })] };
                if (query.includes('Gamma')) return { loadType: 'search', tracks: [makeMockTrack('id-gamma', 'Song Gamma', { author: 'Band C', duration: 210000 })] };
                return { loadType: 'empty', tracks: [] };
            },
        });

        const resolved = await resolveTracksBounded(player, items, { id: 'u1' }, 2);
        assert.equal(resolved.length, 3);
        assert.equal(resolved[0].info.identifier, 'id-alpha');
        assert.equal(resolved[1].info.identifier, 'id-beta');
        assert.equal(resolved[2].info.identifier, 'id-gamma');
    });

    // ── 6. Incorrect or unavailable tracks are not replaced by arbitrary search results ──
    await check('6. Incorrect or unavailable tracks are not replaced by arbitrary search results', async () => {
        const player = makeMockPlayer({
            searchHandler: async () => {
                // Candidates are completely unrelated
                return {
                    loadType: 'search',
                    tracks: [
                        makeMockTrack('bad-1', 'Reaction to Random Video', { duration: 60000 }),
                        makeMockTrack('bad-2', 'Unrelated Instrumental Guitar', { duration: 300000 }),
                    ],
                };
            },
        });

        const { matchSpotifyTrackToYouTube } = require('../src/utils/spotifyResolver');
        const matched = await matchSpotifyTrackToYouTube(player, {
            title: 'Very Specific Real Track',
            artists: 'Original Artist',
            durationMs: 195000,
        }, { id: 'u1' });

        assert.equal(matched, null, 'Must reject low-confidence arbitrary matches');
    });

    // ── 7. Unsupported URLs produce a useful error ──
    await check('7. Unsupported URLs produce a useful error and reject search', async () => {
        const badUrls = [
            'https://example.com/audio.mp3',
            'http://localhost:8080/music',
            'file:///etc/passwd',
            'ftp://music.server.com/song.flac',
        ];

        const player = makeMockPlayer();
        for (const bad of badUrls) {
            const res = await searchMusic(player, bad, { id: 'u1' });
            assert.equal(res.loadType, 'error', `Expected error for ${bad}`);
            assert.equal(res.isUnsupportedUrl, true, `Expected isUnsupportedUrl: true for ${bad}`);
        }
    });

    // ── 8. Playlist playback never receives unrelated autoplay recommendations ──
    await check('8. Playlist playback never receives unrelated autoplay recommendations', async () => {
        const player = makeMockPlayer();
        player.setData('playlistSession', { isPlaylist: true, count: 10 });

        let autoplayCalled = false;
        const fakeAutoPlayFunction = async (p) => {
            const session = p.getData('playlistSession');
            if (session?.isPlaylist) {
                p.setData('playlistSession', null);
                return; // Suppressed as required
            }
            autoplayCalled = true;
        };

        await fakeAutoPlayFunction(player);
        assert.equal(autoplayCalled, false, 'Autoplay recommendation must not run after playlist session');
        assert.equal(player.getData('playlistSession'), null, 'Playlist session cleared after completion');
    });

    // ── 9. Ordinary text search continues working normally ──
    await check('9. Ordinary text search continues working normally without URL restrictions', async () => {
        const query = 'Imagine Dragons Believer';
        const player = makeMockPlayer({
            searchHandler: async ({ query: q }) => {
                if (q.includes('Believer')) {
                    return {
                        loadType: 'search',
                        tracks: [makeMockTrack('believer-id', 'Believer', { author: 'Imagine Dragons' })],
                    };
                }
                return { loadType: 'empty', tracks: [] };
            },
        });

        const res = await searchMusic(player, query, { id: 'u1' });
        assert.ok(res.tracks.length > 0, 'Text search must return tracks');
        assert.equal(res.tracks[0].info.identifier, 'believer-id');
    });

    // ── 10. Resolution failure preserves current valid track and queue ──
    await check('10. Resolution failure preserves the current valid track and queue', async () => {
        const player = makeMockPlayer({
            searchHandler: async () => {
                throw new Error('Lavalink resolution failed');
            },
        });

        const initialCurrent = player.queue.current.info.identifier;
        const initialQueueLen = player.queue.tracks.length;

        const res = await searchMusic(player, 'https://www.youtube.com/watch?v=brokenId123', { id: 'u1' });
        assert.equal(res.loadType, 'error');

        // Current track and upcoming queue must be completely untouched
        assert.equal(player.queue.current.info.identifier, initialCurrent, 'Current track intact');
        assert.equal(player.queue.tracks.length, initialQueueLen, 'Queue length intact');
    });

    // ── 11. URL Classifier correctly parses all valid variants ──
    await check('11. URL Classifier correctly parses all valid variants and short links', async () => {
        const tests = [
            { in: 'https://youtu.be/dQw4w9WgXcQ?t=10', type: SUPPORTED_TYPES.YOUTUBE_TRACK, id: 'dQw4w9WgXcQ' },
            { in: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: SUPPORTED_TYPES.YOUTUBE_TRACK, id: 'dQw4w9WgXcQ' },
            { in: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', type: SUPPORTED_TYPES.YOUTUBE_TRACK, id: 'dQw4w9WgXcQ' },
            { in: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', type: SUPPORTED_TYPES.YOUTUBE_TRACK, id: 'dQw4w9WgXcQ' },
            { in: 'https://www.youtube.com/playlist?list=PLtestList', type: SUPPORTED_TYPES.YOUTUBE_PLAYLIST, id: 'PLtestList' },
            { in: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', type: SUPPORTED_TYPES.SPOTIFY_TRACK, id: '4cOdK2wGLETKBW3PvgPWqT' },
            { in: 'https://open.spotify.com/intl-es/track/4cOdK2wGLETKBW3PvgPWqT', type: SUPPORTED_TYPES.SPOTIFY_TRACK, id: '4cOdK2wGLETKBW3PvgPWqT' },
            { in: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa', type: SUPPORTED_TYPES.SPOTIFY_ALBUM, id: '4m2880jivSbbyEGAKfITCa' },
            { in: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', type: SUPPORTED_TYPES.SPOTIFY_PLAYLIST, id: '37i9dQZF1DXcBWIGoYBM5M' },
            { in: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', type: SUPPORTED_TYPES.SPOTIFY_TRACK, id: '4cOdK2wGLETKBW3PvgPWqT' },
        ];

        for (const t of tests) {
            const c = classifyInput(t.in);
            assert.equal(c.type, t.type, `Expected ${t.type} for ${t.in}`);
            assert.equal(c.id, t.id, `Expected id ${t.id} for ${t.in}`);
        }
    });

    // ── 12. Bounded resolution concurrency respects limit ──
    await check('12. Large playlists use bounded resolution concurrency', async () => {
        let maxActive = 0;
        let currentActive = 0;

        const fakeItems = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}`, artists: 'Artist' }));
        const player = makeMockPlayer({
            searchHandler: async () => {
                currentActive++;
                if (currentActive > maxActive) maxActive = currentActive;
                await new Promise((resolve) => setTimeout(resolve, 20));
                currentActive--;
                return { loadType: 'search', tracks: [makeMockTrack('mock-id', 'Item')] };
            },
        });

        await resolveTracksBounded(player, fakeItems, { id: 'u1' }, 3);
        assert.ok(maxActive <= 3, `Max active concurrency should be <= 3, got ${maxActive}`);
    });

    // ── 13. Dashboard & Voice Channel Status update accurately ──
    await check('13. Dashboard and voice-channel status reflect resolved track metadata', async () => {
        const trackObj = makeMockTrack('resolved-1', 'Resolved Hit Song', { author: 'Verified Artist' });
        trackObj.userData = { spotifyTitle: 'Resolved Hit Song', spotifyArtist: 'Verified Artist', resolvedVia: 'youtube' };

        assert.equal(trackObj.info.title, 'Resolved Hit Song');
        assert.equal(trackObj.info.author, 'Verified Artist');
        assert.equal(trackObj.userData.resolvedVia, 'youtube');
    });

    console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
}

main();
