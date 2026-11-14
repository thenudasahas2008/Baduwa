const assert = require('node:assert/strict');
const { searchMusic, isRateLimitError, fetchYouTubeMetadata } = require('../src/utils/searchEngine');
const { getSpotifyTrackMetadata, matchSpotifyTrackToYouTube } = require('../src/utils/spotifyResolver');
const { handleAutoplay } = require('../src/utils/autoplay');

let passed = 0;
function check(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => { passed++; console.log(`  ✓ ok  - ${name}`); })
        .catch((err) => { console.error(`  ✗ FAIL - ${name}\n      ${err.message}`); process.exitCode = 1; });
}

function makeMockTrack(id, title, author = 'Artist', duration = 180000) {
    return {
        info: {
            identifier: id,
            title,
            author,
            duration,
            uri: `https://www.youtube.com/watch?v=${id}`,
            artworkUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            sourceName: 'youtube',
        },
        userData: {},
    };
}

async function main() {
    console.log('\n--- VERIFYING RATE LIMIT FAILOVER & LINK RESOLUTION ---');

    // 1. isRateLimitError detection
    await check('1. isRateLimitError correctly identifies 429 status and RATE_LIMITED messages', () => {
        assert.ok(isRateLimitError({ status: 429 }));
        assert.ok(isRateLimitError(new Error('Node Request resulted into an error... (HTTP 429) [RATE_LIMITED].')));
        assert.ok(isRateLimitError({ loadType: 'error', exception: { message: 'Too Many Requests (429)' } }));
        assert.ok(!isRateLimitError(new Error('Normal network error')));
        assert.ok(!isRateLimitError({ loadType: 'empty', tracks: [] }));
    });

    // 2. YouTube direct link fallback to oEmbed and search when Lavalink returns 429
    await check('2. YouTube direct URL automatically falls back to oEmbed metadata + search on 429', async () => {
        let migrationCalled = false;
        let searchAttempt = 0;

        const mockNode = {
            host: 'lava1.example.com',
            port: 443,
            connected: true,
        };

        const mockPlayer = {
            guildId: 'guild-yt-429',
            node: mockNode,
            client: {
                lavalinkMode: 'public',
                publicNodeProvider: {
                    markNodeFailed: (h, p, reason, cat) => {
                        assert.equal(cat, 'RATE_LIMITED');
                    },
                },
                lavalinkConnectionManager: {
                    migratePlayerToHealthyNode: async (p, reason) => {
                        migrationCalled = true;
                        p.node = { host: 'lava2.example.com', port: 443, connected: true };
                        return true;
                    },
                },
            },
            search: async (opts) => {
                searchAttempt++;
                // Direct query with URL triggers 429 initially
                if (opts.query.startsWith('https://')) {
                    throw new Error('Node Request resulted into an error, request-PATH: /v4/loadtracks?identifier=... (HTTP 429) [RATE_LIMITED].');
                }
                // Fallback oEmbed search query resolves
                return {
                    loadType: 'track',
                    tracks: [makeMockTrack('R96p0qPSUTY', 'Ninda Noyana Handawe', 'IRAJ')],
                };
            },
        };

        const res = await searchMusic(mockPlayer, 'https://youtu.be/R96p0qPSUTY', { id: 'u1' });
        assert.ok(migrationCalled, 'migratePlayerToHealthyNode must be called on 429');
        assert.equal(res.loadType, 'track');
        assert.ok(res.tracks?.length > 0, 'Must successfully return a track via oEmbed fallback');
        assert.equal(res.tracks[0].info.identifier, 'R96p0qPSUTY');
    });

    // 3. Spotify track resolution with embed metadata
    await check('3. getSpotifyTrackMetadata extracts title and artists via embed scraping fallback', async () => {
        // Rick Astley - Never Gonna Give You Up
        const meta = await getSpotifyTrackMetadata('4cOdK2wGLETKBW3PvgPWqT');
        assert.ok(meta, 'Metadata must not be null');
        assert.ok(meta.title.includes('Never Gonna Give You Up'), `Expected title to include Never Gonna Give You Up, got: ${meta.title}`);
        assert.ok(meta.artists.includes('Rick Astley'), `Expected artist to include Rick Astley, got: ${meta.artists}`);
        assert.ok(meta.durationMs > 0, `Expected durationMs > 0, got: ${meta.durationMs}`);
    });

    // 4. matchSpotifyTrackToYouTube recovers from 429 and matches track
    await check('4. matchSpotifyTrackToYouTube recovers from rate limits and matches candidate', async () => {
        let migrationCalled = false;
        let attempts = 0;

        const mockPlayer = {
            guildId: 'guild-spotify-429',
            node: { host: 'lava-spot1.example.com', port: 443, connected: true },
            client: {
                lavalinkMode: 'public',
                publicNodeProvider: {
                    markNodeFailed: () => {},
                },
                lavalinkConnectionManager: {
                    migratePlayerToHealthyNode: async () => {
                        migrationCalled = true;
                        return true;
                    },
                },
            },
            search: async (opts) => {
                attempts++;
                if (attempts === 1) {
                    return { loadType: 'error', exception: { message: 'HTTP 429 [RATE_LIMITED]' } };
                }
                return {
                    loadType: 'track',
                    tracks: [makeMockTrack('dQw4w9WgXcQ', 'Never Gonna Give You Up', 'Rick Astley', 213573)],
                };
            },
        };

        const matched = await matchSpotifyTrackToYouTube(
            mockPlayer,
            { title: 'Never Gonna Give You Up', artists: 'Rick Astley', durationMs: 213573 },
            { id: 'u1' }
        );

        assert.ok(matched, 'Must find a matched track');
        assert.equal(matched.info.title, 'Never Gonna Give You Up');
        assert.ok(migrationCalled, 'Must trigger node migration on rate limit');
    });

    console.log(`\nAll ${passed}/4 rate limit and link playback checks PASSED!`);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
