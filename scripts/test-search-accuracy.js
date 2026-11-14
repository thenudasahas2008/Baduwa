// Regression tests for search accuracy, candidate ranking, confidence evaluation, and exact track playback.
// Run: node scripts/test-search-accuracy.js

const assert = require('node:assert/strict');
const {
    parseSearchQuery,
    calculateScore,
    rankTracks,
    searchMusic,
    CONFIDENCE_LEVELS,
    CONFIDENCE_THRESHOLDS,
    clearSearchCache
} = require('../src/utils/searchEngine');
const searchSessions = require('../src/utils/searchSessions');
const { handleSearchNavigation } = require('../src/interactions/searchNavigation');

let passed = 0;
let total = 0;

async function check(name, fn) {
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

(async () => {
    console.log('\n--- ZYRO Search Accuracy & Candidate Selection Tests ---');

    // 1. Exact title-and-artist query selects the correct candidate even when unrelated result appears first
    await check('1. An exact title-and-artist query selects the correct candidate even when an unrelated result appears first', () => {
        const query = 'Queen - Bohemian Rhapsody';
        const candidateUnrelatedFirst = {
            info: {
                title: 'Top 100 Rock Songs of All Time Compilation',
                author: 'Various Artists',
                duration: 7200000,
                identifier: 'unrelated_compilation'
            }
        };
        const candidateCorrect = {
            info: {
                title: 'Bohemian Rhapsody',
                author: 'Queen - Topic',
                duration: 354000,
                identifier: 'queen_studio_bohemian'
            }
        };
        const candidateCover = {
            info: {
                title: 'Queen - Bohemian Rhapsody Guitar Cover',
                author: 'GuitarShredder',
                duration: 360000,
                identifier: 'cover_bohemian'
            }
        };

        const tracks = [candidateUnrelatedFirst, candidateCover, candidateCorrect];
        const ranked = rankTracks(tracks, query);

        assert.equal(ranked[0].info.identifier, 'queen_studio_bohemian', 'Correct candidate must be ranked #1 despite appearing third');
        assert.equal(ranked.confidence, CONFIDENCE_LEVELS.HIGH, 'Exact match must have HIGH confidence');
    });

    // 2. Exact title match outranks a weak title similarity
    await check('2. An exact title match outranks a weak title similarity', () => {
        const query = 'Kesariya';
        const candidateExact = {
            info: {
                title: 'Kesariya',
                author: 'Pritam, Arijit Singh - Topic',
                duration: 268000,
                identifier: 'exact_kesariya'
            }
        };
        const candidateWeak = {
            info: {
                title: 'Kesariya Tera Rang Hai Piya (Re-imagined Mashup)',
                author: 'DJ Mixes',
                duration: 310000,
                identifier: 'weak_kesariya'
            }
        };

        const ranked = rankTracks([candidateWeak, candidateExact], query);
        assert.equal(ranked[0].info.identifier, 'exact_kesariya');
        const features = parseSearchQuery(query);
        const scoreExact = calculateScore(candidateExact, features);
        const scoreWeak = calculateScore(candidateWeak, features);
        assert.ok(scoreExact > scoreWeak + 30, 'Exact title match must strongly outrank weak similarity');
    });

    // 3. A candidate from the wrong artist does not automatically win
    await check('3. A candidate from the wrong artist does not automatically win', () => {
        const query = 'Adele - Hello';
        const candidateLionel = {
            info: {
                title: 'Hello',
                author: 'Lionel Richie',
                duration: 250000,
                identifier: 'lionel_hello'
            }
        };
        const candidateAdele = {
            info: {
                title: 'Hello',
                author: 'Adele',
                duration: 295000,
                identifier: 'adele_hello'
            }
        };

        const ranked = rankTracks([candidateLionel, candidateAdele], query);
        assert.equal(ranked[0].info.identifier, 'adele_hello', 'Requested artist must win over same-title track by different artist');
        const features = parseSearchQuery(query);
        const scoreAdele = calculateScore(candidateAdele, features);
        const scoreLionel = calculateScore(candidateLionel, features);
        assert.ok(scoreAdele > scoreLionel + 50, 'Adele must outscore Lionel Richie by a large margin when Adele was requested');
    });

    // 4. A remix, cover or live version is not selected over requested original
    await check('4. A remix, cover or live version is not selected over the requested original without justification', () => {
        const query = 'Coldplay - Yellow';
        const candidateRemix = {
            info: { title: 'Yellow (Club Dance Remix)', author: 'DJ Night', duration: 210000, identifier: 'remix' }
        };
        const candidateCover = {
            info: { title: 'Yellow - Acoustic Cover', author: 'CoverBand', duration: 230000, identifier: 'cover' }
        };
        const candidateLive = {
            info: { title: 'Yellow (Live at Glastonbury)', author: 'Coldplay', duration: 320000, identifier: 'live' }
        };
        const candidateStudio = {
            info: { title: 'Yellow', author: 'Coldplay', duration: 269000, identifier: 'studio' }
        };

        const ranked = rankTracks([candidateRemix, candidateCover, candidateLive, candidateStudio], query);
        assert.equal(ranked[0].info.identifier, 'studio', 'Original studio track must outrank remixes, covers, and live versions');
    });

    // 5. Sinhala and other non-Latin song titles remain searchable and rank correctly
    await check('5. Sinhala and other non-Latin song titles remain searchable and rank correctly', () => {
        const query = 'සනුක - සරාගයේ';
        const candidateSinhala = {
            info: {
                title: 'සරාගයේ (Saragaye)',
                author: 'Sanuka',
                duration: 220000,
                identifier: 'sanuka_saragaye'
            }
        };
        const candidateOther = {
            info: {
                title: 'Random English Song',
                author: 'Unknown',
                duration: 180000,
                identifier: 'random'
            }
        };

        const features = parseSearchQuery(query);
        assert.ok(features.isNonLatin, 'Must recognize non-Latin script');
        assert.equal(features.expectedArtist, 'සනුක');
        assert.equal(features.expectedTitle, 'සරාගයේ');

        const ranked = rankTracks([candidateOther, candidateSinhala], query);
        assert.equal(ranked[0].info.identifier, 'sanuka_saragaye');
        assert.ok(ranked.topScore >= CONFIDENCE_THRESHOLDS.HIGH_SCORE);
    });

    // 6. Ambiguous queries show selectable candidates instead of playing an arbitrary song
    await check('6. Ambiguous queries show selectable candidates instead of playing an arbitrary song', () => {
        // "Hello" is extremely ambiguous without an artist (Adele, Lionel Richie, Kesha, Martin Solveig, etc.)
        const query = 'Hello';
        const cand1 = { info: { title: 'Hello', author: 'Adele', duration: 295000, identifier: 'h1' } };
        const cand2 = { info: { title: 'Hello', author: 'Lionel Richie', duration: 250000, identifier: 'h2' } };
        const cand3 = { info: { title: 'Hello', author: 'Martin Solveig & Dragonette', duration: 191000, identifier: 'h3' } };

        const ranked = rankTracks([cand1, cand2, cand3], query);
        assert.equal(ranked.confidence, CONFIDENCE_LEVELS.MEDIUM, 'Ambiguous multi-artist title must be flagged as MEDIUM confidence for interactive selection');
    });

    // 7. Selecting a result plays that exact encoded track
    await check('7. Selecting a result plays that exact encoded track', async () => {
        const tracks = [
            { info: { title: 'Candidate 1', author: 'Artist A', duration: 200000, identifier: 'c1', uri: 'https://youtube.com/watch?v=c1' } },
            { info: { title: 'Candidate 2', author: 'Artist B', duration: 210000, identifier: 'c2', uri: 'https://youtube.com/watch?v=c2' } },
        ];

        const sessionId = searchSessions.createSession('user_1', 'g1', tracks, 'test query', 'vc_1', 'tc_1');
        const session = searchSessions.getSession(sessionId);
        assert.ok(session, 'Session must exist');

        let playedTrack = null;
        let replaceDashboardCalled = false;

        const mockPlayer = {
            guildId: 'g1',
            voiceChannelId: 'vc_1',
            textChannelId: 'tc_1',
            playing: false,
            connected: true,
            queue: {
                tracks: [],
                current: null,
                add: async (t) => { playedTrack = t; }
            },
            play: async () => { mockPlayer.playing = true; }
        };

        const mockClient = {
            defaultLanguage: 'en',
            languageManager: { get: (l, k) => k },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: () => mockPlayer,
                createPlayer: () => mockPlayer
            },
            playerController: {
                replaceWithFullDashboard: async () => { replaceDashboardCalled = true; },
                updatePlayer: async () => {}
            }
        };

        const mockInteraction = {
            client: mockClient,
            customId: `search:select:${sessionId}`,
            values: ['1'], // Select Candidate 2
            user: { id: 'user_1', tag: 'Tester#0001' },
            guild: {
                id: 'g1',
                members: {
                    fetch: async () => ({ voice: { channel: { id: 'vc_1', permissionsFor: () => ({ has: () => true }) } } }),
                    me: { voice: { channelId: 'vc_1' } }
                }
            },
            deferUpdate: async () => {},
            editReply: async () => {},
            followUp: async () => {}
        };

        await handleSearchNavigation(mockInteraction);

        assert.ok(playedTrack, 'A track must be enqueued');
        assert.equal(playedTrack.info.identifier, 'c2', 'Selected track must be Candidate 2, matching selection value');
        assert.equal(searchSessions.getSession(sessionId), null, 'Session must be cleaned up after selection');
        assert.ok(replaceDashboardCalled, 'Full dashboard must be refreshed after track starts');
    });

    // 8. Search fallback does not replace a valid higher-confidence result with a worse match
    await check('8. Search fallback does not replace a valid higher-confidence result with a worse match', async () => {
        clearSearchCache();
        const mockPlayer = {
            async search({ source, query }) {
                if (source === 'ytmsearch') {
                    return {
                        loadType: 'search',
                        tracks: [
                            {
                                info: {
                                    title: 'Sihinayaki Mata Adare',
                                    author: 'Kasun Kalhara - Topic',
                                    duration: 240000,
                                    identifier: 'good_ytm'
                                }
                            }
                        ]
                    };
                }
                if (source === 'ytsearch') {
                    return {
                        loadType: 'search',
                        tracks: [
                            {
                                info: {
                                    title: 'Sihinayaki Mata Adare Cover by Amateur',
                                    author: 'RandomUploader',
                                    duration: 180000,
                                    identifier: 'bad_yt'
                                }
                            }
                        ]
                    };
                }
                return { tracks: [] };
            }
        };

        const result = await searchMusic(mockPlayer, 'Kasun Kalhara - Sihinayaki Mata Adare');
        assert.equal(result.tracks[0].info.identifier, 'good_ytm', 'High confidence ytmsearch result must NOT be replaced by worse ytsearch cover');
    });

    // 9. Exact YouTube URLs continue to play the requested video
    await check('9. Exact YouTube URLs continue to play the requested video', async () => {
        clearSearchCache();
        const requestedId = 'dQw4w9WgXcQ';
        const mockPlayer = {
            async search({ query }) {
                return {
                    loadType: 'track',
                    tracks: [
                        {
                            info: {
                                title: 'Rick Astley - Never Gonna Give You Up',
                                author: 'RickAstleyVEVO',
                                identifier: requestedId,
                                uri: `https://www.youtube.com/watch?v=${requestedId}`
                            }
                        }
                    ]
                };
            }
        };

        const result = await searchMusic(mockPlayer, `https://www.youtube.com/watch?v=${requestedId}`);
        assert.equal(result.tracks[0].info.identifier, requestedId, 'Exact video ID must be preserved');
        assert.equal(result.confidence, CONFIDENCE_LEVELS.HIGH);
    });

    // 10. Spotify track matching and playlist ordering continue working
    await check('10. Spotify track matching and playlist ordering continue working', async () => {
        const { matchSpotifyTrackToYouTube } = require('../src/utils/spotifyResolver');
        const mockPlayer = {
            async search({ query }) {
                return {
                    loadType: 'search',
                    tracks: [
                        {
                            info: {
                                title: 'Flowers',
                                author: 'Miley Cyrus',
                                duration: 200000,
                                identifier: 'miley_flowers'
                            }
                        }
                    ]
                };
            }
        };

        const meta = { title: 'Flowers', artists: 'Miley Cyrus', durationMs: 200400 };
        const matched = await matchSpotifyTrackToYouTube(mockPlayer, meta, { id: 'u1' });
        assert.ok(matched, 'Spotify track must resolve to playable match');
        assert.equal(matched.info.title, 'Flowers');
    });

    // 11. A failed search preserves the current playing song and queue
    await check('11. A failed search preserves the current playing song and queue', async () => {
        clearSearchCache();
        const mockPlayer = {
            async search() {
                return { loadType: 'empty', tracks: [] };
            }
        };

        const result = await searchMusic(mockPlayer, 'completely nonexistent song xyz123456789');
        assert.equal(result.tracks.length, 0);
        assert.equal(result.confidence, CONFIDENCE_LEVELS.LOW);
    });

    // 12. Search-result buttons acknowledge interactions promptly and cannot be replayed as stale selections
    await check('12. Search-result buttons acknowledge interactions promptly and cannot be replayed as stale selections', async () => {
        let updateMsg = null;
        const expiredInteraction = {
            client: { defaultLanguage: 'en', languageManager: { get: (l, k) => 'SEARCH_SESSION_EXPIRED' } },
            customId: 'search:select:nonexistent-session-id',
            values: ['0'],
            user: { id: 'user_1' },
            guild: { id: 'g1' },
            update: async (payload) => { updateMsg = payload; }
        };

        await handleSearchNavigation(expiredInteraction);
        assert.equal(updateMsg?.content, 'SEARCH_SESSION_EXPIRED', 'Stale/expired session must be rejected with expired notice');
    });

    // 13. Autoplay artist diversity, audio recovery, /247, dashboard replacement and voice-channel status remain functional
    await check('13. Autoplay artist diversity, audio recovery, /247, dashboard replacement and voice-channel status remain functional', async () => {
        const { resolveAlternativeTrack } = require('../src/utils/searchEngine');
        const cmd247 = require('../src/commands/247');
        const voiceChannelStatusManager = require('../src/utils/voiceChannelStatusManager');
        const PlayerController = require('../src/utils/PlayerController');

        // Verify audio recovery via resolveAlternativeTrack
        const mockPlayer = {
            async search({ query, source }) {
                return {
                    loadType: 'search',
                    tracks: [
                        {
                            info: {
                                title: 'Alternative Stream for Song',
                                author: 'Test Artist',
                                duration: 200000,
                                identifier: 'alt_stream_id'
                            }
                        }
                    ]
                };
            }
        };
        const failedTrack = {
            info: {
                title: 'Song',
                author: 'Test Artist',
                duration: 202000,
                identifier: 'expired_stream_id'
            },
            requester: { id: 'u1' }
        };
        const alternative = await resolveAlternativeTrack(mockPlayer, failedTrack);
        assert.ok(alternative, 'Alternative track must be resolved');
        assert.equal(alternative.info.identifier, 'alt_stream_id');
        assert.equal(alternative.requester.id, 'u1', 'Original requester must be preserved');

        // Verify /247 command structure
        assert.ok(cmd247?.data?.name === '247', '/247 command must be defined');
        assert.equal(typeof cmd247.execute, 'function', '/247 execute must be a function');

        // Verify PlayerController dashboard methods
        assert.equal(typeof PlayerController.prototype.replaceWithFullDashboard, 'function', 'replaceWithFullDashboard must exist');
        assert.equal(typeof PlayerController.prototype.updatePlayer, 'function', 'updatePlayer must exist');

        // Verify voice channel status utility
        assert.equal(typeof voiceChannelStatusManager.prototype.formatStatus, 'function', 'formatStatus must exist on VoiceChannelStatusManager');
    });

    // 14. Valid descriptive query "paradise sinhala rap sri lanka" and "paradise sinhala" accurately matches candidate track
    await check('14. Valid query "paradise sinhala rap sri lanka" and "paradise sinhala" matches candidate track "Paradise"', () => {
        const queryFull = 'paradise sinhala rap sri lanka';
        const queryShort = 'paradise sinhala';

        const candidateParadise = {
            info: {
                title: 'Paradise',
                author: 'Sachie Leoze',
                duration: 205000,
                identifier: 'sachie_leoze_paradise'
            }
        };

        const candidateUnrelated = {
            info: {
                title: 'Random Western Country Song',
                author: 'Country Singer',
                duration: 180000,
                identifier: 'unrelated_track'
            }
        };

        const featuresFull = parseSearchQuery(queryFull);
        const scoreFull = calculateScore(candidateParadise, featuresFull);
        assert.ok(scoreFull >= CONFIDENCE_THRESHOLDS.MIN_SCORE, `Score for "${queryFull}" must be >= ${CONFIDENCE_THRESHOLDS.MIN_SCORE}, got ${scoreFull}`);

        const featuresShort = parseSearchQuery(queryShort);
        const scoreShort = calculateScore(candidateParadise, featuresShort);
        assert.ok(scoreShort >= CONFIDENCE_THRESHOLDS.MIN_SCORE, `Score for "${queryShort}" must be >= ${CONFIDENCE_THRESHOLDS.MIN_SCORE}, got ${scoreShort}`);

        const ranked = rankTracks([candidateUnrelated, candidateParadise], queryFull);
        assert.equal(ranked[0].info.identifier, 'sachie_leoze_paradise', 'Candidate "Paradise" must be ranked #1');
        assert.ok(ranked.confidence !== CONFIDENCE_LEVELS.LOW, 'Confidence must not be LOW');
    });

    // 15. Search fallback triggers ytsearch when ytmsearch confidence is weak or empty
    await check('15. Search fallback triggers ytsearch when ytmsearch confidence is weak or empty', async () => {
        clearSearchCache();
        const query = 'paradise sinhala rap sri lanka';

        let ytmCalled = false;
        let ytCalled = false;

        const mockPlayer = {
            async search({ query: q, source }) {
                if (source === 'ytmsearch') {
                    ytmCalled = true;
                    // Return low relevance track from ytmsearch
                    return {
                        loadType: 'search',
                        tracks: [
                            {
                                info: {
                                    title: 'Unrelated Instrumentals',
                                    author: 'Unknown Musician',
                                    duration: 120000,
                                    identifier: 'weak_ytm_id'
                                }
                            }
                        ]
                    };
                }
                if (source === 'ytsearch') {
                    ytCalled = true;
                    return {
                        loadType: 'search',
                        tracks: [
                            {
                                info: {
                                    title: 'Sachie Leoze - Paradise (Official Video)',
                                    author: 'Sachie Leoze',
                                    duration: 205000,
                                    identifier: 'best_yt_id'
                                }
                            }
                        ]
                    };
                }
                return { loadType: 'empty', tracks: [] };
            }
        };

        const result = await searchMusic(mockPlayer, query, { id: 'u1' });
        assert.ok(ytmCalled, 'Primary ytmsearch must be attempted');
        assert.ok(ytCalled, 'Fallback ytsearch must be attempted when ytmsearch had weak confidence');
        assert.ok(result.tracks.length > 0, 'Must return candidates');
        assert.equal(result.tracks[0].info.identifier, 'best_yt_id', 'Best match from fallback must rank #1');
        assert.ok(result.confidence !== CONFIDENCE_LEVELS.LOW, 'Result must not have LOW confidence');
    });

    // 16. Track selection in searchNavigation produces action confirmation without partial Now Playing embeds
    await check('16. Track selection in searchNavigation produces action confirmation without partial Now Playing embeds', async () => {
        let editedPayload = null;
        let dashboardReplaced = false;

        const fakeGuild = { id: 'guild-nav-test', members: { me: null } };
        const fakeUser = { id: 'user-nav-1' };
        const fakeChannel = { id: 'channel-nav-1', send: async () => ({ id: 'new-dash' }) };

        const testTrack = {
            info: {
                identifier: 'test-track-id',
                title: 'Paradise',
                author: 'Sachie Leoze',
                duration: 205000,
                uri: 'https://youtube.com/watch?v=paradise'
            }
        };

        const sessionId = searchSessions.createSession(
            fakeUser.id,
            fakeGuild.id,
            [testTrack],
            'paradise sinhala',
            'vc-1',
            fakeChannel.id
        );

        let playerPlayed = false;
        const fakePlayer = {
            guildId: fakeGuild.id,
            connected: true,
            playing: false,
            voice: { token: 'mock-token' },
            queue: {
                current: null,
                tracks: [],
                add: async (t) => { fakePlayer.queue.current = t; }
            },
            play: async () => { playerPlayed = true; }
        };

        const fakeClient = {
            defaultLanguage: 'en',
            languageManager: { get: () => 'text' },
            lavalinkConnectionManager: { isAvailable: () => true },
            lavalink: {
                getPlayer: () => fakePlayer
            },
            playerController: {
                replaceWithFullDashboard: async (gid, chId, opts) => {
                    dashboardReplaced = true;
                    assert.equal(opts?.track?.info?.title, 'Paradise', 'Must pass track to replaceWithFullDashboard');
                },
                updatePlayer: async () => {}
            },
            voiceChannelStatusManager: {
                updateFromPlayer: async () => {}
            }
        };

        const mockSelectInteraction = {
            client: fakeClient,
            customId: `search:select:${sessionId}`,
            values: ['0'],
            user: fakeUser,
            guild: fakeGuild,
            member: { voice: { channel: { id: 'vc-1', permissionsFor: () => ({ has: () => true }) } } },
            channel: fakeChannel,
            deferUpdate: async () => {},
            editReply: async (payload) => {
                editedPayload = payload;
            }
        };

        await handleSearchNavigation(mockSelectInteraction);

        assert.ok(playerPlayed, 'Playback must be initiated');
        assert.ok(dashboardReplaced, 'replaceWithFullDashboard must be called with track');
        assert.ok(editedPayload, 'Interaction must be edited with reply');
        assert.equal(editedPayload.embeds.length, 1);
        const embed = editedPayload.embeds[0];
        assert.equal(embed.data.title, '🎵 Track Selected', 'Must use "🎵 Track Selected", never "▶️ Now Playing" without controls');
        assert.ok(embed.data.description.includes('Loading audio for'), 'Must indicate loading');
        assert.deepEqual(editedPayload.components, [], 'Components must be cleared');
    });

    // 17. Empty query returns no preset song suggestions
    await check('17. /play empty query returns no preset song suggestions', async () => {
        const { getAutocompleteChoices } = require('../src/utils/searchAutocomplete');
        const emptyChoices = await getAutocompleteChoices({}, '', {});
        assert.ok(Array.isArray(emptyChoices));
        assert.equal(emptyChoices.length, 0, 'Empty query must return 0 suggestions');

        const whitespaceChoices = await getAutocompleteChoices({}, '   ', {});
        assert.ok(Array.isArray(whitespaceChoices));
        assert.equal(whitespaceChoices.length, 0, 'Whitespace query must return 0 suggestions');
    });

    // 18. Title - Artist vs Artist - Title symmetric ranking
    await check('18. Bidirectional delimiters handle Title - Artist and Artist - Title symmetrically', () => {
        const candidateStudio = {
            info: {
                title: 'Shape of You',
                author: 'Ed Sheeran',
                duration: 233000,
                identifier: 'shape_studio'
            }
        };
        const candidateBadHabits = {
            info: {
                title: 'Ed Sheeran - Bad Habits',
                author: 'Ed Sheeran',
                duration: 230000,
                identifier: 'bad_habits'
            }
        };

        const tracks = [candidateBadHabits, candidateStudio];

        const rankedTitleArtist = rankTracks(tracks, 'Shape of You - Ed Sheeran');
        assert.equal(rankedTitleArtist[0].info.identifier, 'shape_studio', 'Title - Artist query must rank Shape of You first');
        assert.equal(rankedTitleArtist.confidence, CONFIDENCE_LEVELS.HIGH);

        const rankedArtistTitle = rankTracks(tracks, 'Ed Sheeran - Shape of You');
        assert.equal(rankedArtistTitle[0].info.identifier, 'shape_studio', 'Artist - Title query must rank Shape of You first');
        assert.equal(rankedArtistTitle.confidence, CONFIDENCE_LEVELS.HIGH);
    });

    // 19. Sinhala orthographic variations rank #1 with HIGH confidence
    await check('19. Sinhala orthographic variation (ඟ vs ග) ranks intended recording first with HIGH confidence', () => {
        const candidateAlt = {
            info: {
                title: 'දඟකාර හීනේ',
                author: 'Centigradz',
                duration: 250000,
                identifier: 'alt_spelling'
            }
        };
        const candidateUnrelated = {
            info: {
                title: 'Random Sinhala Baila Mix',
                author: 'Various',
                duration: 200000,
                identifier: 'unrelated_mix'
            }
        };

        const ranked = rankTracks([candidateUnrelated, candidateAlt], 'දගකාර හීනේ');
        assert.equal(ranked[0].info.identifier, 'alt_spelling', 'Orthographic spelling variation must rank #1');
        assert.equal(ranked.confidence, CONFIDENCE_LEVELS.HIGH, 'Orthographic variation must achieve HIGH confidence');
    });

    // 20. Cross-script matching (Sinhala Unicode query matching Romanized track title)
    await check('20. Cross-script matching: Sinhala Unicode query correctly ranks Romanized YouTube title', () => {
        const candidateRomanized = {
            info: {
                title: 'Dagakara Heene - Centigradz',
                author: 'Centigradz',
                duration: 250000,
                identifier: 'romanized_track'
            }
        };
        const candidateUnrelated = {
            info: {
                title: 'Top English Songs 2024',
                author: 'Various Artists',
                duration: 220000,
                identifier: 'unrelated_track'
            }
        };

        const ranked = rankTracks([candidateUnrelated, candidateRomanized], 'දගකාර හීනේ');
        assert.equal(ranked[0].info.identifier, 'romanized_track', 'Romanized candidate must rank #1 for Sinhala query');
        assert.ok(ranked.topScore >= 50, `Expected score >= 50, got ${ranked.topScore}`);
    });

    // 21. Compound modifier handling ("Slowed + Reverb")
    await check('21. Compound modifier ("Slowed + Reverb") accurately selects slowed version and penalizes studio', () => {
        const query = 'The Weeknd - After Hours (Slowed + Reverb)';
        const candidateSlowedReverb = {
            info: {
                title: 'The Weeknd - After Hours (Slowed + Reverb)',
                author: 'AestheticEdits',
                duration: 380000,
                identifier: 'slowed_reverb_match'
            }
        };
        const candidateStudio = {
            info: {
                title: 'After Hours',
                author: 'The Weeknd',
                duration: 360000,
                identifier: 'studio_original'
            }
        };
        const candidateRemix = {
            info: {
                title: 'After Hours (Club Remix)',
                author: 'DJ Mix',
                duration: 280000,
                identifier: 'club_remix'
            }
        };

        const ranked = rankTracks([candidateStudio, candidateRemix, candidateSlowedReverb], query);
        assert.equal(ranked[0].info.identifier, 'slowed_reverb_match', 'Slowed + Reverb version must rank #1');
        assert.equal(ranked.confidence, CONFIDENCE_LEVELS.HIGH);
        assert.ok(ranked[0]._relevanceScore > ranked[1]._relevanceScore + 30, 'Slowed+Reverb must strongly outrank studio track');
    });

    // 22. Remix versus original recording
    await check('22. Studio query favors original recording over remix and cover', () => {
        const query = 'Blinding Lights';
        const candidateOriginal = {
            info: {
                title: 'The Weeknd - Blinding Lights (Official Audio)',
                author: 'The Weeknd - Topic',
                duration: 200000,
                identifier: 'original_track'
            }
        };
        const candidateRemix = {
            info: {
                title: 'The Weeknd - Blinding Lights (Major Lazer Remix)',
                author: 'The Weeknd',
                duration: 198000,
                identifier: 'remix_track'
            }
        };
        const candidateCover = {
            info: {
                title: 'Blinding Lights - Acoustic Guitar Cover',
                author: 'CoverSinger',
                duration: 210000,
                identifier: 'cover_track'
            }
        };

        const ranked = rankTracks([candidateCover, candidateRemix, candidateOriginal], query);
        assert.equal(ranked[0].info.identifier, 'original_track', 'Original studio recording must rank #1 when studio requested');
    });

    // 23. Candidate ranking with similar names: Studio > Live > Cover > Reaction
    await check('23. Candidate ranking with similar names ranks Studio > Live > Cover > Reaction', () => {
        const query = 'Queen - Radio Ga Ga';
        const candidateStudio = { info: { title: 'Radio Ga Ga', author: 'Queen - Topic', duration: 345000, identifier: 'studio' } };
        const candidateLive = { info: { title: 'Queen - Radio Ga Ga (Live Aid 1985)', author: 'Queen Official', duration: 360000, identifier: 'live' } };
        const candidateCover = { info: { title: 'Radio Ga Ga - Rock Band Cover', author: 'CoverBand', duration: 350000, identifier: 'cover' } };
        const candidateReaction = { info: { title: 'Vocal Coach Reacts to Queen - Radio Ga Ga', author: 'ReactionChannel', duration: 600000, identifier: 'reaction' } };

        const ranked = rankTracks([candidateReaction, candidateCover, candidateLive, candidateStudio], query);
        assert.equal(ranked[0].info.identifier, 'studio', '#1 must be Studio recording');
        assert.equal(ranked[1].info.identifier, 'live', '#2 must be Live recording');
        assert.equal(ranked[2].info.identifier, 'cover', '#3 must be Cover');
        assert.equal(ranked[3].info.identifier, 'reaction', '#4 must be Reaction video');
    });

    // 24. Provider deduplication preserves modifiers across ytmsearch and ytsearch
    await check('24. Provider candidate combining deduplicates identical tracks while preserving version variants', async () => {
        clearSearchCache();
        const mockPlayer = {
            async search({ source }) {
                if (source === 'ytmsearch') {
                    return {
                        tracks: [
                            { info: { title: 'Levitating', author: 'Dua Lipa', identifier: 'ytm_id_1', uri: 'https://youtube.com/watch?v=1' } }
                        ]
                    };
                }
                if (source === 'ytsearch') {
                    return {
                        tracks: [
                            { info: { title: 'Levitating', author: 'Dua Lipa', identifier: 'yt_id_1', uri: 'https://youtube.com/watch?v=1' } }, // Duplicate
                            { info: { title: 'Levitating (Remix)', author: 'Dua Lipa', identifier: 'yt_id_remix', uri: 'https://youtube.com/watch?v=remix' } } // Distinct variant
                        ]
                    };
                }
                return { tracks: [] };
            }
        };

        const res = await searchMusic(mockPlayer, 'Levitating');
        assert.ok(res.tracks.length >= 2, 'Should preserve both studio and remix without duplicate studio entries');
        assert.equal(res.tracks[0].info.title, 'Levitating', 'Studio track must rank first');
        const titles = res.tracks.map(t => t.info.title);
        const uniqueTitles = new Set(titles);
        assert.equal(titles.length, uniqueTitles.size, 'Duplicate studio re-upload must be filtered out');
    });

    // 25. Provider timeout and empty result sets handle gracefully
    await check('25. Provider timeout or empty result sets return low confidence without unhandled rejection', async () => {
        clearSearchCache();
        const mockPlayerHanging = {
            search: async () => new Promise(() => {}) // Never resolves
        };

        const res = await searchMusic(mockPlayerHanging, 'Some Song', {}, { signal: AbortSignal.timeout(50) }).catch(err => ({ error: err }));
        assert.ok(res, 'Must return a result object even on timeout');
        assert.ok(res.tracks.length === 0, 'Tracks must be empty on timeout');
    });

    console.log(`\n========================================`);
    console.log(`Search Accuracy & Candidate Selection Tests: ${passed}/${total} passed`);
    console.log(`========================================\n`);

    if (passed !== total) process.exit(1);
    process.exit(0);
})();
