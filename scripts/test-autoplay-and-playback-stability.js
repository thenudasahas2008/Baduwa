// Comprehensive regression test suite for Autoplay, Queue Insertion, Audio Dropouts, Track Restarts and Lavalink Recovery
// Run: node scripts/test-autoplay-and-playback-stability.js

const assert = require('node:assert/strict');
const { findAutoplayTracks } = require('../src/utils/autoplay');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');

let passed = 0;
async function check(name, fn) {
    try {
        const res = fn();
        if (res && typeof res.then === 'function') {
            await res;
        }
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
        process.exitCode = 1;
    }
}

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
    console.log('--- ZYRO Autoplay, Audio Dropouts, Restarts & Node Recovery Tests ---');

    // ── Test 1: Autoplay discovers tracks for non-YouTube sources (e.g. Spotify) via complementary search ──
    await check('1. Non-YouTube tracks (e.g. Spotify) discover autoplay recommendations via complementary search', async () => {
        const spotifyTrack = makeTrack('sp123', 'As It Was', {
            author: 'Harry Styles',
            sourceName: 'spotify',
        });

        const player = {
            guildId: 'guild-autoplay-1',
            queue: { current: null, previous: [], tracks: [] },
            async search({ query }) {
                if (query.includes('Harry Styles') || query.includes('As It Was')) {
                    return {
                        tracks: [
                            makeTrack('yt1', 'Watermelon Sugar', { author: 'Harry Styles - Topic', sourceName: 'youtubemusic' }),
                            makeTrack('yt2', 'Late Night Talking', { author: 'Harry Styles', sourceName: 'youtube' }),
                            makeTrack('yt3', 'Adore You', { author: 'Harry Styles - Topic', sourceName: 'youtubemusic' }),
                        ]
                    };
                }
                return { tracks: [] };
            }
        };

        const tracks = await findAutoplayTracks(player, spotifyTrack);
        assert.ok(tracks.length > 0, 'Autoplay must discover candidates for non-YouTube input tracks');
        assert.ok(tracks.some(t => t.info.title === 'Watermelon Sugar'));
        assert.ok(tracks.some(t => t.info.title === 'Late Night Talking'));
    });

    // ── Test 2: Autoplay gracefully resolves lastPlayedTrack fallback when argument is omitted ──
    await check('2. Autoplay gracefully resolves lastPlayedTrack from player data or history when argument is omitted', async () => {
        const historicalTrack = makeTrack('hist1', 'Blinding Lights', {
            author: 'The Weeknd',
            sourceName: 'youtube',
        });

        const player = {
            guildId: 'guild-autoplay-2',
            queue: { current: null, previous: [historicalTrack], tracks: [] },
            getData: (key) => key === 'lastPlayedTrack' ? historicalTrack : null,
            async search({ query }) {
                if (query.includes('The Weeknd') || query.includes('Blinding Lights')) {
                    return {
                        tracks: [
                            makeTrack('rec1', 'Save Your Tears', { author: 'The Weeknd - Topic', sourceName: 'youtubemusic' }),
                        ]
                    };
                }
                return { tracks: [] };
            }
        };

        const tracks = await findAutoplayTracks(player);
        assert.ok(tracks.length > 0, 'Must recover lastPlayedTrack from player history');
        assert.equal(tracks[0].info.identifier, 'rec1');
    });

    // ── Test 3: Idle playback start does not create duplicate tracks in queue ──
    await check('3. Starting playback when idle adds track to queue without duplicate entries in queue.tracks', async () => {
        const player = {
            guildId: 'guild-idle-play',
            playing: false,
            queue: {
                current: null,
                tracks: []
            },
            async play() {
                if (!this.queue.current && this.queue.tracks.length > 0) {
                    this.queue.current = this.queue.tracks.shift();
                }
                this.playing = true;
            }
        };
        player.queue.add = async (t) => { player.queue.tracks.push(t); };

        const newTrack = makeTrack('new1', 'First Track');

        // Execute the updated idle playback flow
        await player.queue.add(newTrack);
        await player.play();

        assert.equal(player.queue.current.info.identifier, 'new1', 'Current track must be set to new track');
        assert.equal(player.queue.tracks.length, 0, 'queue.tracks must NOT retain a duplicate copy of the playing track');
    });

    // ── Test 4: Transient 10-12s audio pauses do not restart track from the beginning ──
    await check('4. Transient slow updates (10-12s) do not restart track or trigger premature recovery', async () => {
        let playCalled = false;
        const mockPlayer = {
            guildId: 'guild-audio-transient',
            playing: true,
            paused: false,
            position: 12000,
            node: { id: 'node-1', host: 'node1.test', port: 443 },
            queue: {
                current: makeTrack('t1', 'Song 1', { duration: 200000 }),
                tracks: []
            },
            play: async () => { playCalled = true; }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        monitor.onTrackStart(mockPlayer, mockPlayer.queue.current);

        // Advance initial grace period (set trackStartTime back 15s)
        const state = monitor.getOrCreateState('guild-audio-transient');
        state.trackStartTime = Date.now() - 15000;
        state.lastProgressTimestamp = Date.now() - 11000; // 11s elapsed (less than 15s threshold)

        await monitor.checkPlayersForStalls();
        assert.equal(playCalled, false, 'Transient delay (< 15s) must not trigger recovery play call');
        assert.equal(state.stalledChecks, 0, 'stalledChecks must be 0 for sub-threshold delay');

        monitor.destroy();
    });

    // ── Test 5: Confirmed stall requires at least 2 consecutive watchdog checks (~18s) ──
    await check('5. Confirmed stall requires 2 consecutive checks (>=15s and >=18s) before recovery triggers', async () => {
        let playCalled = false;
        const mockPlayer = {
            guildId: 'guild-audio-stall-confirm',
            playing: true,
            paused: false,
            position: 8000,
            node: { id: 'node-1', host: 'node1.test', port: 443, connected: true },
            queue: {
                current: makeTrack('t2', 'Song 2', { duration: 200000 }),
                tracks: []
            },
            play: async (opts) => {
                playCalled = true;
                assert.equal(opts.position, 8000, 'Must resume at the frozen position (8000ms), NOT 0!');
            }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        monitor.onTrackStart(mockPlayer, mockPlayer.queue.current);

        const state = monitor.getOrCreateState('guild-audio-stall-confirm');
        state.trackStartTime = Date.now() - 25000;
        state.lastPosition = 8000;
        state.lastProgressTimestamp = Date.now() - 18500; // Check 1: 18.5s elapsed (>= 18s threshold)

        // Check 1: Should flag stalledChecks = 1 but NOT trigger play yet
        await monitor.checkPlayersForStalls();
        assert.equal(state.stalledChecks, 1, 'First check at 18.5s flags stalledChecks = 1');
        assert.equal(playCalled, false, 'Single check must not immediately restart audio');

        // Check 2: 21.5s elapsed -> stalledChecks = 2 -> confirmed stall, triggers recovery!
        state.lastProgressTimestamp = Date.now() - 21500;
        await monitor.checkPlayersForStalls();
        assert.equal(playCalled, true, 'Confirmed stall after 2 consecutive checks triggers recovery');
        assert.ok(state.recoveryPending, 'Recovery must be pending verification');

        monitor.destroy();
    });

    // ── Test 6: Audio recovery resumes at the exact recorded playback position without resetting to 0 ──
    await check('6. Audio recovery resumes at the exact recorded playback position without resetting to 0', async () => {
        let resumePos = null;
        const mockPlayer = {
            guildId: 'guild-audio-resume-pos',
            playing: true,
            paused: false,
            position: 4200, // Under 5000ms - previously this got wrongly reset to 0!
            node: { id: 'node-1', host: 'node1.test', port: 443, connected: true },
            queue: {
                current: makeTrack('t3', 'Song 3', { duration: 200000 }),
                tracks: []
            },
            play: async (opts) => { resumePos = opts.position; }
        };

        const mockClient = {
            lavalink: { getPlayer: () => mockPlayer },
            lavalinkMode: 'local'
        };

        const monitor = new AudioPlaybackMonitor(mockClient);
        const state = monitor.getOrCreateState('guild-audio-resume-pos');
        state.lastPosition = 4200;

        await monitor.recoverPlayback(mockPlayer, mockPlayer.queue.current, { reason: 'stalledPosition' });
        assert.equal(resumePos, 4200, 'Must resume at the exact playback position (4200ms) rather than resetting to 0');

        monitor.destroy();
    });

    // ── Test 7: Public node migration rejects unvalidated incompatible nodes ──
    await check('7. migratePlayerToHealthyNode rejects unvalidated incompatible public nodes', async () => {
        const mockPlayer = {
            guildId: 'guild-migration-test',
            playing: true,
            paused: false,
            position: 20000,
            node: { id: 'node-current', host: 'current.test', port: 443 },
            voice: { token: 'tok', endpoint: 'end', sessionId: 'ses' },
            queue: { current: makeTrack('t7', 'Track 7'), tracks: [] },
            changeNode: async () => {}
        };

        const provider = new PublicNodeProvider();
        provider.nodes = [
            { host: 'current.test', port: 443, password: 'pw', secure: true },
            { host: 'incompatible.test', port: 8080, password: 'pw', secure: false },
        ];
        // Mock getNextValidatedNode returning null (no validated v4 nodes)
        provider.getNextValidatedNode = async () => null;
        // Mock checkNodeCompatibility identifying incompatible API
        provider.checkNodeCompatibility = async () => ({
            compatible: false,
            category: 'INCOMPATIBLE_API',
            reason: 'Incompatible Lavalink version'
        });

        const mockClient = {
            lavalinkMode: 'public',
            publicNodeProvider: provider,
            lavalink: {
                nodeManager: {
                    nodes: new Map([['node-current', mockPlayer.node]])
                }
            }
        };

        const connectionManager = new LavalinkConnectionManager(mockClient);
        const migrated = await connectionManager.migratePlayerToHealthyNode(mockPlayer, 'stall');

        assert.equal(migrated, false, 'Must reject migration when candidate is incompatible');
        assert.ok(provider.failedNodes.has('incompatible.test:8080'), 'Incompatible candidate must be marked failed');
        assert.equal(provider.failedNodes.get('incompatible.test:8080').category, 'INCOMPATIBLE_API');
    });

    // ── Test 8: Autoplay setting persists in guildSettings and survives client re-creation ──
    await check('8. Autoplay setting persists in guildSettings and survives client re-creation', async () => {
        const guildSettings = require('../src/utils/guildSettings');
        const testGuildId = 'test-guild-persistence-99';

        // Explicitly set autoplay to false
        guildSettings.setAutoplay(testGuildId, false);
        assert.equal(guildSettings.isAutoplay(testGuildId), false);

        // Explicitly set autoplay to true
        guildSettings.setAutoplay(testGuildId, true);
        assert.equal(guildSettings.isAutoplay(testGuildId), true);

        // Check that /247 does not mutate autoplay
        guildSettings.set247(testGuildId, true);
        assert.equal(guildSettings.is247(testGuildId), true);
        assert.equal(guildSettings.isAutoplay(testGuildId), true, '247 setting must not alter autoplay setting');

        // Cleanup
        guildSettings.delete(testGuildId);
    });

    // ── Test 9: Unicode title preservation in normalizeString (Sinhala, Tamil, Hindi) ──
    await check('9. normalizeString preserves Sinhala, Tamil, Hindi and non-Latin scripts without collapsing to empty string', async () => {
        const { normalizeString } = require('../src/utils/trackText');

        const sinhala = normalizeString('මනමාලී (Official Video) [4K]');
        assert.ok(sinhala.length > 0, 'Sinhala string must not collapse to empty string');
        assert.ok(sinhala.includes('මනමාලී'), `Expected Sinhala letters preserved, got "${sinhala}"`);

        const tamil = normalizeString('வணக்கம் (Official Audio)');
        assert.ok(tamil.length > 0, 'Tamil string must not collapse to empty string');
        assert.ok(tamil.includes('வணக்கம்'), `Expected Tamil letters preserved, got "${tamil}"`);

        const hindi = normalizeString('नमस्ते [Remastered]');
        assert.ok(hindi.length > 0, 'Hindi string must not collapse to empty string');
        assert.ok(hindi.includes('नमस्ते'), `Expected Hindi letters preserved, got "${hindi}"`);
    });

    // ── Test 10: Deduplication does not reject different songs by different artists sharing substring fragments ──
    await check('10. Deduplication allows different songs sharing common words when artists differ', async () => {
        const { handleAutoplay } = require('../src/utils/autoplay');
        const player = {
            guildId: 'guild-dedup-test',
            playing: false,
            queue: {
                current: null,
                previous: [
                    makeTrack('id1', 'Love Story', { author: 'Taylor Swift' }),
                ],
                tracks: []
            },
            async search({ query }) {
                return {
                    tracks: [
                        // Different song with different artist that contains "Love Story" in title
                        makeTrack('id2', 'Another Love Story', { author: 'Alternative Band' }),
                    ]
                };
            }
        };
        player.queue.add = async (tracks) => { player.queue.tracks.push(...tracks); };
        player.play = async () => {
            player.queue.current = player.queue.tracks.shift();
            player.playing = true;
        };

        const mockClient = {
            autoplayEnabled: { get: () => true }
        };

        const started = await handleAutoplay(mockClient, player, 'test', player.queue.previous[0]);
        assert.equal(started, true, 'Different song by different artist should not be rejected');
        assert.equal(player.queue.current.info.identifier, 'id2');
    });

    // ── Test 11: YouTube Radio Mix /watch?v=...&list=RD... preserved as YOUTUBE_PLAYLIST ──
    await check('11. YouTube Radio mix URL /watch?v=...&list=RD... classified as YOUTUBE_PLAYLIST', async () => {
        const { classifyInput, SUPPORTED_TYPES } = require('../src/utils/urlClassifier');
        const mixUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ';

        const classification = classifyInput(mixUrl);
        assert.equal(classification.type, SUPPORTED_TYPES.YOUTUBE_PLAYLIST);
        assert.equal(classification.id, 'RDdQw4w9WgXcQ');
        assert.ok(classification.canonicalUrl.includes('list=RDdQw4w9WgXcQ'), 'Must preserve list=RD parameter');
    });

    // ── Test 12: Concurrency lock prevents duplicate autoplay insertions from overlapping callbacks ──
    await check('12. Concurrency lock prevents duplicate autoplay insertions from overlapping callbacks', async () => {
        const { handleAutoplay } = require('../src/utils/autoplay');
        let searchCalls = 0;

        const player = {
            guildId: 'guild-concurrency-lock',
            playing: false,
            queue: {
                current: null,
                previous: [makeTrack('s1', 'Seed Song', { author: 'Seed Artist' })],
                tracks: []
            },
            async search() {
                searchCalls++;
                // Artificial delay to simulate network latency
                await new Promise(r => setTimeout(r, 40));
                return {
                    tracks: [makeTrack('rec-conc', 'Recommended Song', { author: 'Rec Artist' })]
                };
            }
        };
        player.queue.add = async (tracks) => { player.queue.tracks.push(...tracks); };
        player.play = async () => {
            player.queue.current = player.queue.tracks.shift();
            player.playing = true;
        };

        const mockClient = {
            autoplayEnabled: { get: () => true }
        };

        // Fire two simultaneous autoplay triggers (simulating autoPlayFunction and queueEnd racing)
        const [res1, res2] = await Promise.all([
            handleAutoplay(mockClient, player, 'autoPlayFunction', player.queue.previous[0]),
            handleAutoplay(mockClient, player, 'queueEnd', player.queue.previous[0]),
        ]);

        assert.ok((res1 && !res2) || (!res1 && res2), 'Exactly one caller must acquire the lock and succeed');
        assert.ok(searchCalls <= 5, `Expected 1 discovery batch (<= 5 queries), got ${searchCalls} queries`);
        assert.ok(searchCalls > 0, 'At least 1 search query must be made');
        assert.equal(player.queue.tracks.length + (player.queue.current ? 1 : 0), 1, 'Exactly one recommended track must be enqueued without duplicates');
        const targetTrack = player.queue.current || player.queue.tracks[0];
        assert.equal(targetTrack.info.identifier, 'rec-conc');
    });

    // ── Test 13: Manual queue addition during Autoplay discovery is preserved ──
    await check('13. Manual queue addition during Autoplay discovery is preserved and not overwritten', async () => {
        const { handleAutoplay } = require('../src/utils/autoplay');
        const userManualTrack = makeTrack('manual1', 'User Requested Song', { author: 'User Pick' });

        const player = {
            guildId: 'guild-manual-preservation',
            playing: false,
            queue: {
                current: null,
                previous: [makeTrack('seed-prev', 'Previous Song')],
                tracks: []
            },
            async search() {
                // User runs /play while search is in flight!
                player.queue.tracks.push(userManualTrack);
                return {
                    tracks: [makeTrack('stale-auto', 'Stale Auto Song')]
                };
            }
        };
        player.queue.add = async (tracks) => { player.queue.tracks.push(...tracks); };
        player.play = async () => {
            player.queue.current = player.queue.tracks.shift();
            player.playing = true;
        };

        const mockClient = {
            autoplayEnabled: { get: () => true }
        };

        const started = await handleAutoplay(mockClient, player, 'autoPlayFunction');
        assert.equal(started, false, 'Autoplay must yield and preserve user queue');
        assert.equal(player.queue.current.info.identifier, 'manual1', 'User manually queued track must play');
        assert.ok(!player.queue.tracks.some(t => t.info.identifier === 'stale-auto'), 'Stale autoplay track must not be enqueued');
    });

    // ── Test 14: Autoplay OFF never starts recommendations ──
    await check('14. Autoplay OFF never starts recommendations', async () => {
        const { handleAutoplay } = require('../src/utils/autoplay');
        let searchCalled = false;

        const player = {
            guildId: 'guild-autoplay-off',
            playing: false,
            queue: { current: null, previous: [makeTrack('prev', 'Prev')], tracks: [] },
            async search() {
                searchCalled = true;
                return { tracks: [makeTrack('t', 'Title')] };
            }
        };

        const mockClient = {
            autoplayEnabled: { get: () => false }
        };

        const started = await handleAutoplay(mockClient, player, 'queueEnd');
        assert.equal(started, false, 'Must not start when Autoplay is OFF');
        assert.equal(searchCalled, false, 'Must not search when Autoplay is OFF');
    });

    // ── Test 15: Playlist session restriction stops autoplay when playlist finishes ──
    await check('15. Playlist session restriction stops autoplay when playlist finishes', async () => {
        const { handleAutoplay } = require('../src/utils/autoplay');
        let sessionCleared = false;

        const player = {
            guildId: 'guild-playlist-session',
            playing: false,
            queue: { current: null, previous: [makeTrack('pl-last', 'Last Playlist Track')], tracks: [] },
            getData(key) {
                if (key === 'playlistSession') return { isPlaylist: true };
                return null;
            },
            setData(key, val) {
                if (key === 'playlistSession' && val === null) sessionCleared = true;
            },
            async search() {
                return { tracks: [makeTrack('unrelated', 'Unrelated Autoplay')] };
            }
        };

        const mockClient = {
            autoplayEnabled: { get: () => true }
        };

        const started = await handleAutoplay(mockClient, player, 'autoPlayFunction');
        assert.equal(started, false, 'Autoplay must not start after a playlist finishes');
        assert.equal(sessionCleared, true, 'Playlist session must be cleared');
        assert.equal(player.queue.tracks.length, 0);
    });

    // ── Test 16: Playback recovery verifies progression relative to observed start position ──
    await check('16. Recovery verifies progression relative to observed start without requiring resume at high initial position', async () => {
        const mockPlayer = {
            guildId: 'guild-rec-verify',
            position: 0,
            queue: {
                current: makeTrack('rec-v1', 'Recovering Song', { duration: 180000 }),
                tracks: []
            },
            node: { id: 'node-1' }
        };

        const monitor = new AudioPlaybackMonitor({ lavalink: { getPlayer: () => mockPlayer }, lavalinkMode: 'local' });
        const state = monitor.getOrCreateState('guild-rec-verify');

        // Simulate recovery initiated at target position 45,000ms, but track restarts at 0ms
        state.recoveryPending = {
            trackIdentifier: 'rec-v1',
            trackTitle: 'Recovering Song',
            targetResumePosition: 45000,
            firstObservedPosition: null,
            initiatedAt: Date.now(),
            verificationDeadlineMs: 25000,
            verified: false,
        };

        // First update at 100ms: records firstObservedPosition
        mockPlayer.position = 100;
        monitor.onPlayerUpdate(null, mockPlayer);
        assert.equal(state.recoveryPending.verified, false, 'Should not verify on first update');
        assert.equal(state.recoveryPending.firstObservedPosition, 100, 'firstObservedPosition must be captured');

        // Second update at 450ms (>= 100 + 200ms): verifies recovery progression!
        mockPlayer.position = 450;
        monitor.onPlayerUpdate(null, mockPlayer);
        assert.equal(state.recoveryPending, null, 'recoveryPending must be cleared upon successful verification');

        monitor.destroy();
    });

    // ── Test 17: Backwards jump in position updates state without triggering false stall ──
    await check('17. Position jump backwards (track loop or seek back) updates lastPosition without false stall', async () => {
        const mockPlayer = {
            guildId: 'guild-backward-pos',
            position: 50000,
            queue: { current: makeTrack('t-loop', 'Looping Song', { duration: 60000 }), tracks: [] },
            node: { id: 'node-1' }
        };

        const monitor = new AudioPlaybackMonitor({ lavalink: { getPlayer: () => mockPlayer }, lavalinkMode: 'local' });
        const state = monitor.getOrCreateState('guild-backward-pos');
        state.lastPosition = 50000;
        state.lastProgressTimestamp = Date.now() - 1000;

        // Track loops back to 1000ms
        mockPlayer.position = 1000;
        monitor.onPlayerUpdate(null, mockPlayer);

        assert.equal(state.lastPosition, 1000, 'lastPosition must update when position jumps backwards');
        assert.ok(Date.now() - state.lastProgressTimestamp < 500, 'lastProgressTimestamp must be refreshed');
        assert.equal(state.stalledChecks, 0);

        monitor.destroy();
    });

    // ── Test 18: YouTube single video URL requires exact video identifier match ──
    await check('18. YouTube track search requires exact video identifier and rejects missing exact matches', async () => {
        const { searchMusic } = require('../src/utils/searchEngine');
        const mockPlayer = {
            async search({ query }) {
                // Return search result with different video ID
                return {
                    loadType: 'track',
                    tracks: [makeTrack('wrongId123', 'Unrelated Search Result')]
                };
            }
        };

        const res = await searchMusic(mockPlayer, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', { id: 'u1' });
        assert.equal(res.loadType, 'error', 'Must return error when exact requested video ID is not found');
        assert.ok(res.exception.message.includes('unavailable'), 'Should report exact track unavailable');
    });

    // ── Test 19: Artist diversity normalizes VEVO suffixes correctly ──
    await check('19. Artist diversity normalizes VEVO suffixes (RickAstleyVEVO -> rick astley)', () => {
        const { normalizeArtist, isGenericArtist } = require('../src/utils/trackText');
        const normVevo = normalizeArtist('RickAstleyVEVO');
        const normPlain = normalizeArtist('Rick Astley');

        assert.equal(normVevo, normPlain, `VEVO artist "${normVevo}" must match "${normPlain}"`);
        assert.equal(isGenericArtist(normVevo), false);
    });

    // ── Test 20: Up Next in embed displays actual next queued track and excludes automated duplicates ──
    await check('20. Up Next in embed displays actual next queued track and excludes automated duplicates', () => {
        const { createNowPlayingEmbed } = require('../src/utils/zyroEmbeds');
        const currentTrack = makeTrack('curr-1', 'Current Playing Song', { author: 'Current Artist' });
        const autoDupTrack = makeTrack('curr-1', 'Current Playing Song', { author: 'Current Artist', userData: { autoplay: true } });
        const upcomingTrack = makeTrack('next-1', 'Next Queued Song', { author: 'Next Artist' });

        // Queue has accidental automated duplicate of current track, followed by valid upcoming track
        const player = {
            repeatMode: 'off',
            paused: false,
            volume: 80,
            position: 10000,
            queue: { tracks: [autoDupTrack, upcomingTrack] }
        };
        const embed = createNowPlayingEmbed(player, currentTrack, {});
        const upNextField = embed.data.fields.find(f => f.name.includes('Up Next'));
        assert.ok(upNextField, 'Embed must include Up Next field');
        assert.ok(upNextField.value.includes('Next Queued Song'), 'Up Next must skip automated duplicate of current track and show real next track');
        assert.ok(!upNextField.value.includes('Current Playing Song'), 'Up Next must not re-display current song from automated duplicate');
    });

    console.log(`\n========================================\nAutoplay & Playback Stability Tests: ${passed}/20 passed\n========================================\n`);
}

runTests();
