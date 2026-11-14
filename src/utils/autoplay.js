// Autoplay recommendation engine — diverse, balanced, and musically relevant recommendations.
// Discovers candidates across different artists, genres, moods, and music scenes using YouTube's
// native radio (RD mix) and complementary searches with multi-tier diversity and per-guild cooldowns.

const {
    normalizeString,
    cleanTitle,
    cleanAuthor,
    normalizeArtist,
    isGenericArtist,
    extractCollaborators,
    detectMusicContext,
    splitArtistFromTitle,
} = require('./trackText');
const { isManualStopActive } = require('./playerLifecycle');
const { isRateLimitError, markPlayerNodeRateLimited } = require('./searchEngine');
const logger = require('./logger');

const AUTOPLAY_TARGET = Math.max(1, parseInt(process.env.AUTOPLAY_TARGET_COUNT || '25', 10) || 25);
const MAX_SEEDS = 3;
const HISTORY_WINDOW = 50;
const ARTIST_COOLDOWN_WINDOW = 3; // Avoid same artist for next 3 autoplay selections

// Clearly non-music uploads to skip
const NON_MUSIC = /\b(reaction|trailer|teaser|interview|podcast|review|tutorial|gameplay|highlights?|behind\s+the\s+scenes|full\s+(?:movie|album|concert))\b/i;
const TOPIC_AUTHOR = /-\s*topic\s*$/i;

class AutoplayHistoryManager {
    constructor() {
        this.guilds = new Map();
        this.MAX_RECENT_ARTISTS = 25;
    }

    getGuildState(guildId) {
        if (!guildId) guildId = 'default';
        if (!this.guilds.has(guildId)) {
            this.guilds.set(guildId, {
                recentArtists: [], // chronological array of normalized artist names
                recentTrackIds: new Set(),
                recentChannels: new Set(),
            });
        }
        return this.guilds.get(guildId);
    }

    recordTrack(guildId, track) {
        if (!track?.info) return;
        const state = this.getGuildState(guildId);

        if (track.info.identifier) {
            state.recentTrackIds.add(track.info.identifier);
            if (state.recentTrackIds.size > 100) {
                const first = state.recentTrackIds.values().next().value;
                state.recentTrackIds.delete(first);
            }
        }

        if (track.info.author) {
            const ch = normalizeArtist(track.info.author);
            if (ch && !isGenericArtist(ch)) {
                state.recentChannels.add(ch);
            }
        }

        const artists = extractCollaborators(track.info.title, track.info.author);
        for (const artist of artists) {
            if (isGenericArtist(artist)) continue;
            state.recentArtists.push(artist);
        }
        if (state.recentArtists.length > this.MAX_RECENT_ARTISTS) {
            state.recentArtists = state.recentArtists.slice(-this.MAX_RECENT_ARTISTS);
        }
    }

    isArtistOnCooldown(guildId, artists) {
        if (!guildId || !artists || !artists.length) return false;
        const state = this.getGuildState(guildId);
        if (!state.recentArtists.length) return false;

        // Take unique recent artists from the tail up to ARTIST_COOLDOWN_WINDOW
        const cooldownSet = new Set();
        for (let i = state.recentArtists.length - 1; i >= 0; i--) {
            cooldownSet.add(state.recentArtists[i]);
            if (cooldownSet.size >= ARTIST_COOLDOWN_WINDOW) break;
        }

        for (const a of artists) {
            if (isGenericArtist(a)) continue;
            if (cooldownSet.has(a)) return true;
        }
        return false;
    }

    clearGuild(guildId) {
        if (guildId) this.guilds.delete(guildId);
    }
}

const historyManager = new AutoplayHistoryManager();

function syncPlayerHistory(player) {
    if (!player?.guildId) return;
    const state = historyManager.getGuildState(player.guildId);
    if (state.recentArtists.length === 0 && player.queue?.previous?.length) {
        for (const t of player.queue.previous.slice(-10)) {
            historyManager.recordTrack(player.guildId, t);
        }
    }
}

function isYouTubeSource(track) {
    const source = track?.info?.sourceName;
    return source === 'youtube' || source === 'youtubemusic';
}

function getRecentIdentifiers(player) {
    const ids = new Set();
    if (player.queue?.current?.info?.identifier) ids.add(player.queue.current.info.identifier);
    for (const t of (player.queue?.previous || []).slice(-HISTORY_WINDOW)) {
        if (t.info?.identifier) ids.add(t.info.identifier);
    }
    for (const t of (player.queue?.tracks || [])) {
        if (t.info?.identifier) ids.add(t.info.identifier);
    }
    return ids;
}

function extractCoreTitleAndArtists(track) {
    if (!track?.info) return { normTitle: '', normFullTitle: '', normAuthor: '', collaborators: [], isGeneric: true };
    const rawTitle = track.info.title || '';
    const rawAuthor = track.info.author || '';
    const { title: sTitle, artist: sArtist } = splitArtistFromTitle(rawTitle, rawAuthor);
    const normTitle = normalizeString(sTitle || rawTitle);
    const normFullTitle = normalizeString(rawTitle);
    const normAuthor = normalizeArtist(sArtist || rawAuthor);
    const collaborators = extractCollaborators(rawTitle, rawAuthor);
    const isGeneric = isGenericArtist(normAuthor) && (collaborators.length === 0 || collaborators.every(isGenericArtist));
    return { normTitle, normFullTitle, normAuthor, collaborators, isGeneric };
}

function isDuplicate(track, recentIds, history) {
    if (!track?.info) return true;
    if (recentIds && recentIds.has(track.info.identifier)) return true;

    if (track.info.isrc) {
        for (const h of history) {
            if (h.info?.isrc && h.info.isrc === track.info.isrc) return true;
        }
    }

    const candidate = extractCoreTitleAndArtists(track);
    if (!candidate.normTitle && !candidate.normFullTitle) return false;

    for (const h of history) {
        if (!h?.info) continue;
        const hCore = extractCoreTitleAndArtists(h);
        if (!hCore.normTitle && !hCore.normFullTitle) continue;

        // Check if candidate and history track share any collaborator or author
        const shareArtist = !candidate.isGeneric && !hCore.isGeneric && (
            (candidate.normAuthor && hCore.normAuthor && candidate.normAuthor === hCore.normAuthor) ||
            candidate.collaborators.some(c => hCore.collaborators.includes(c) || hCore.normAuthor === c) ||
            hCore.collaborators.some(c => candidate.collaborators.includes(c) || candidate.normAuthor === c)
        );

        // Exact core title match or full title match
        const titlesMatch = (
            (candidate.normTitle && (candidate.normTitle === hCore.normTitle || candidate.normTitle === hCore.normFullTitle)) ||
            (candidate.normFullTitle && (candidate.normFullTitle === hCore.normTitle || candidate.normFullTitle === hCore.normFullTitle))
        );

        if (titlesMatch) {
            // If they share an artist, or if either artist is generic/unknown -> Definite duplicate
            if (shareArtist || candidate.isGeneric || hCore.isGeneric) {
                return true;
            }
            // If artists are known and clearly different, it's a different song with the same title (e.g. Adele - Hello vs Lionel Richie - Hello)
            continue;
        }

        // Substring / variant match when artists match (e.g. "Song (Remix)" vs "Song", or "SHAN PUTHA - Rappappa" vs "Rappappa")
        if (shareArtist) {
            const cLen = candidate.normTitle ? candidate.normTitle.length : 0;
            const hLen = hCore.normTitle ? hCore.normTitle.length : 0;
            if (cLen >= 3 && hLen >= 3) {
                if (candidate.normTitle.includes(hCore.normTitle) || hCore.normTitle.includes(candidate.normTitle)) {
                    return true;
                }
            }
            if (cLen >= 3 && candidate.normFullTitle && candidate.normFullTitle.includes(hCore.normTitle)) {
                return true;
            }
            if (hLen >= 3 && hCore.normFullTitle && hCore.normFullTitle.includes(candidate.normTitle)) {
                return true;
            }
        }

        // Combined title match: upload title contains both the artist and the title of the other track
        if (hCore.normAuthor && !hCore.isGeneric && hCore.normTitle && hCore.normTitle.length >= 3) {
            if (candidate.normFullTitle.includes(hCore.normAuthor) && candidate.normFullTitle.includes(hCore.normTitle)) {
                return true;
            }
        }
        if (candidate.normAuthor && !candidate.isGeneric && candidate.normTitle && candidate.normTitle.length >= 3) {
            if (hCore.normFullTitle.includes(candidate.normAuthor) && hCore.normFullTitle.includes(candidate.normTitle)) {
                return true;
            }
        }
    }
    return false;
}

function looksLikeNonMusic(track) {
    if (track.info.isStream) return true;
    return NON_MUSIC.test(track.info.title || '');
}

function isSongLike(track) {
    const info = track.info;
    return Boolean(info.isrc) || info.sourceName === 'youtubemusic' || TOPIC_AUTHOR.test(info.author || '');
}

function buildSeeds(lastPlayedTrack, history) {
    const seedIds = new Set();
    const seeds = [];
    for (const t of [lastPlayedTrack, ...history.slice().reverse()]) {
        const id = t?.info?.identifier;
        if (!id || !isYouTubeSource(t) || seedIds.has(id)) continue;
        seedIds.add(id);
        seeds.push(t);
        if (seeds.length >= MAX_SEEDS) break;
    }
    return seeds;
}

async function fetchMix(player, videoId) {
    try {
        const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
        let res = await player.search({ query: mixUrl });
        if (isRateLimitError(res)) {
            markPlayerNodeRateLimited(player, 'YouTube HTTP 429 Rate Limited (Autoplay RD Mix)');
            if (player.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode) {
                const migrated = await player.client.lavalinkConnectionManager.migratePlayerToHealthyNode(player, 'autoplay-429-rate-limit').catch(() => false);
                if (migrated) {
                    res = await player.search({ query: mixUrl }).catch(() => null);
                }
            }
        }
        return res?.tracks || [];
    } catch (err) {
        if (isRateLimitError(err)) {
            markPlayerNodeRateLimited(player, 'YouTube HTTP 429 Rate Limited (Autoplay RD Mix)');
            player.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode?.(player, 'autoplay-429-rate-limit').catch(() => false);
        }
        return [];
    }
}

const isUrl = (s) => /^https?:\/\//i.test(String(s || '').trim());

async function fetchComplementaryCandidates(player, lastPlayedTrack) {
    const candidates = [];
    if (!lastPlayedTrack?.info || typeof player.search !== 'function') return candidates;

    let rawTitle = lastPlayedTrack.userData?.spotifyTitle || lastPlayedTrack.info.title || '';
    if (isUrl(rawTitle)) rawTitle = '';
    const title = cleanTitle(rawTitle);
    const author = cleanAuthor(lastPlayedTrack.userData?.spotifyArtist || lastPlayedTrack.info.author || '');
    const context = detectMusicContext(lastPlayedTrack);
    const queries = [];

    if (title && title.length > 2) {
        queries.push({ query: `${title} similar songs`, source: 'ytmsearch' });
    }

    if (author && !isGenericArtist(author)) {
        queries.push({ query: `${author} top tracks`, source: 'ytmsearch' });
        queries.push({ query: `${author} radio mix`, source: 'ytmsearch' });
    }

    if (title && author && !isGenericArtist(author)) {
        queries.push({ query: `${author} ${title}`, source: 'ytmsearch' });
    }

    if (context.scene) {
        queries.push({ query: `${context.scene} music hits`, source: 'ytmsearch' });
    }
    if (context.scene === 'sinhala' || /[\u0D80-\u0DFF]/.test(rawTitle)) {
        if (author && !isGenericArtist(author)) {
            queries.push({ query: `${author} sinhala songs`, source: 'ytmsearch' });
        }
        if (title) {
            queries.push({ query: `${title} sinhala`, source: 'ytmsearch' });
        }
        if (context.genre) {
            queries.push({ query: `sinhala ${context.genre} songs`, source: 'ytmsearch' });
        }
        queries.push({ query: `sinhala songs playlist`, source: 'ytmsearch' });
    }

    if (context.genre) {
        if (context.scene && context.scene !== 'sinhala') {
            queries.push({ query: `${context.scene} ${context.genre} songs`, source: 'ytmsearch' });
        } else {
            queries.push({ query: `${context.genre} songs playlist`, source: 'ytmsearch' });
        }
    } else if (context.mood) {
        queries.push({ query: `${context.mood} songs playlist`, source: 'ytmsearch' });
    }

    const searchPromises = queries.map(async (q) => {
        try {
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => resolve(null), 2500)
            );
            const doSearch = async () => {
                let res = await player.search({ query: q.query, source: q.source }).catch(() => null);
                if (isRateLimitError(res)) {
                    markPlayerNodeRateLimited(player, 'YouTube HTTP 429 Rate Limited (Autoplay Search)');
                    player.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode?.(player, 'autoplay-429-rate-limit').catch(() => false);
                }
                if ((!res || !res.tracks?.length) && q.source === 'ytmsearch') {
                    res = await player.search({ query: q.query, source: 'ytsearch' }).catch(() => null);
                }
                return res?.tracks || [];
            };
            return await Promise.race([doSearch(), timeoutPromise]);
        } catch (err) {
            logger.debug(`Complementary query "${q.query}" failed:`, err?.message || err);
            return [];
        }
    });

    const results = await Promise.all(searchPromises);
    for (const tracks of results) {
        if (Array.isArray(tracks) && tracks.length) {
            candidates.push(...tracks);
        }
    }

    return candidates;
}

function calculateTrackSimilarity(candidate, seedTrack) {
    if (!candidate?.info || !seedTrack?.info) return 0;
    let score = 0;
    if (isSongLike(candidate)) score += 10;

    const seedTitle = String(seedTrack.info.title || '').toLowerCase();
    const seedAuthor = String(seedTrack.info.author || '').toLowerCase();
    const candTitle = String(candidate.info.title || '').toLowerCase();
    const candAuthor = String(candidate.info.author || '').toLowerCase();

    const seedContext = detectMusicContext(seedTrack);
    const candContext = detectMusicContext(candidate);

    // 1. Language / Regional Scene Match (Sinhala, Hindi, Tamil, Latin, etc.)
    const isSeedSinhala = /[\u0D80-\u0DFF]/.test(seedTitle) || /[\u0D80-\u0DFF]/.test(seedAuthor) || seedContext.scene === 'sinhala';
    const isCandSinhala = /[\u0D80-\u0DFF]/.test(candTitle) || /[\u0D80-\u0DFF]/.test(candAuthor) || candContext.scene === 'sinhala';

    if (isSeedSinhala) {
        if (isCandSinhala) {
            score += 60;
        } else {
            score -= 50; // Strongly deprioritize non-Sinhala tracks when seed is Sinhala
        }
    } else if (seedContext.scene && candContext.scene) {
        if (candContext.scene === seedContext.scene) {
            score += 50;
        } else {
            score -= 50; // Penalize conflicting regional scenes
        }
    }

    // 2. Genre Match (rap, lofi, edm, pop, rock, acoustic, etc.)
    if (seedContext.genre && candContext.genre) {
        if (seedContext.genre === candContext.genre) {
            score += 35;
        } else {
            score -= 15;
        }
    }

    // 3. Mood Match (chill, party, sad, workout, etc.)
    if (seedContext.mood && candContext.mood) {
        if (seedContext.mood === candContext.mood) {
            score += 25;
        }
    }

    // 4. Shared Collaborators (exclude identical primary artist to protect artist diversity in autoplay)
    const normSeedAuthor = normalizeArtist(seedTrack.info.author);
    const normCandAuthor = normalizeArtist(candidate.info.author);
    if (normSeedAuthor && normCandAuthor && normSeedAuthor !== normCandAuthor) {
        const seedArtists = extractCollaborators(seedTrack.info.title, seedTrack.info.author);
        const candArtists = extractCollaborators(candidate.info.title, candidate.info.author);
        const hasSharedCollab = seedArtists.some(a => candArtists.includes(a));
        if (hasSharedCollab) {
            score += 25;
        }
    }

    return score;
}

/**
 * Builds an autoplay batch with high diversity across artists, channels, and styles.
 * Uses native YouTube radio mixes supplemented by targeted style/genre searches,
 * applying per-guild artist cooldowns and single-batch artist limits.
 *
 * @param {Object} player - Lavalink player
 * @param {Object} [lastPlayedTrack] - Last played track (or recovered from player history)
 * @returns {Promise<Array>} Up to AUTOPLAY_TARGET unique, deduplicated tracks
 */
async function findAutoplayTracks(player, lastPlayedTrack) {
    if (!lastPlayedTrack?.info) {
        lastPlayedTrack = (typeof player?.getData === 'function' ? player.getData('lastPlayedTrack') : null)
            || (player?.queue?.previous?.length ? player.queue.previous[0] : null)
            || player?.queue?.current;
    }
    if (!lastPlayedTrack?.info) return [];

    syncPlayerHistory(player);
    historyManager.recordTrack(player.guildId, lastPlayedTrack);

    const history = player.queue.previous ? player.queue.previous.slice(-HISTORY_WINDOW) : [];
    const seen = getRecentIdentifiers(player);
    seen.add(lastPlayedTrack.info.identifier);

    const dedupHistory = [
        ...(player.queue.current?.info ? [player.queue.current] : []),
        ...history.filter((t) => t?.info),
        ...(player.queue.tracks || []).filter((t) => t?.info),
        lastPlayedTrack,
    ];

    const seeds = buildSeeds(lastPlayedTrack, history);

    // 1. Gather raw candidates from RD mix
    const candidatePool = [];
    const seedIdsSeen = new Set();

    for (const seed of seeds) {
        const tracks = await fetchMix(player, seed.info.identifier);
        if (tracks.length) {
            candidatePool.push(...tracks);
            seedIdsSeen.add(seed.info.identifier);
        }
    }

    // If no seeds or seeds returned no tracks, attempt to find a YouTube seed for non-YouTube tracks
    if (candidatePool.length === 0 && lastPlayedTrack?.info) {
        try {
            let rawTitle = lastPlayedTrack.userData?.spotifyTitle || lastPlayedTrack.info.title || '';
            if (isUrl(rawTitle)) rawTitle = '';
            const cleanT = cleanTitle(rawTitle);
            const cleanA = cleanAuthor(lastPlayedTrack.userData?.spotifyArtist || lastPlayedTrack.info.author || '');
            if (cleanT || (cleanA && !isGenericArtist(cleanA))) {
                const q = cleanA && !isGenericArtist(cleanA) ? (cleanT ? `${cleanA} ${cleanT}` : cleanA) : cleanT;
                let seedRes = await player.search({ query: q, source: 'ytmsearch' }).catch(() => null);
                if (!seedRes || !seedRes.tracks?.length) {
                    seedRes = await player.search({ query: q, source: 'ytsearch' }).catch(() => null);
                }
                if (seedRes?.tracks?.length) {
                    const found = seedRes.tracks.find((t) => isYouTubeSource(t) && t.info?.identifier);
                    if (found) {
                        const mix = await fetchMix(player, found.info.identifier);
                        if (mix?.length) {
                            candidatePool.push(...mix);
                            seedIdsSeen.add(found.info.identifier);
                        }
                    }
                }
            }
        } catch (err) {
            logger.debug('Non-YT seed discovery failed:', err?.message || err);
        }
    }

    // Count how many unique non-generic artists we discovered from RD mix
    const discoveredArtists = new Set();
    for (const t of candidatePool) {
        const artists = extractCollaborators(t.info?.title, t.info?.author);
        for (const a of artists) {
            if (!isGenericArtist(a)) discoveredArtists.add(a);
        }
    }

    // 2. If the candidate pool is narrow or dominated by few artists, fetch complementary searches
    if (candidatePool.length === 0 || discoveredArtists.size < Math.min(AUTOPLAY_TARGET, 8)) {
        const extraTracks = await fetchComplementaryCandidates(player, lastPlayedTrack);
        if (extraTracks.length) {
            candidatePool.push(...extraTracks);
        }
    }

    if (!candidatePool.length) return [];

    // Prioritize candidates that best match the seed track's musical context (scene, genre, style, language)
    const ordered = [...candidatePool].sort((a, b) => {
        const simB = calculateTrackSimilarity(b, lastPlayedTrack);
        const simA = calculateTrackSimilarity(a, lastPlayedTrack);
        if (simB !== simA) return simB - simA;
        return Number(isSongLike(b)) - Number(isSongLike(a));
    });

    const nonMusic = [];
    const tier1 = []; // Diverse artists, fresh channels, not on cooldown
    const tier2 = []; // Diverse artists, repeat channel, not on cooldown
    const tier3 = []; // Same artist / on cooldown fallback
    const tierMismatched = []; // Lower similarity or conflicting category fallback ONLY

    const poolSeen = new Set();

    for (const track of ordered) {
        if (!track?.info?.identifier) continue;
        if (poolSeen.has(track.info.identifier)) continue;
        poolSeen.add(track.info.identifier);

        if (isDuplicate(track, seen, dedupHistory)) continue;

        if (looksLikeNonMusic(track)) {
            nonMusic.push(track);
            continue;
        }

        seen.add(track.info.identifier);
        dedupHistory.push(track);

        const artists = extractCollaborators(track.info.title, track.info.author);
        const channel = normalizeArtist(track.info.author);
        const onCooldown = historyManager.isArtistOnCooldown(player.guildId, artists);
        const sim = calculateTrackSimilarity(track, lastPlayedTrack);

        const item = { track, artists, channel, onCooldown, sim };
        if (sim < 0) {
            tierMismatched.push(item);
        } else if (onCooldown) {
            tier3.push(item);
        } else {
            tier1.push(item);
        }
    }

    const collected = [];
    const collectedIds = new Set();
    const batchArtists = new Set();
    const batchChannels = new Set();

    // Pass 1: Select Tier 1 candidates (diverse artists + fresh channels)
    const deferredToTier2 = [];
    const deferredToTier3 = [];

    for (const item of tier1) {
        if (collected.length >= AUTOPLAY_TARGET) break;

        const hasGenericOnly = item.artists.length === 0 || item.artists.every(isGenericArtist);
        const artistInBatch = !hasGenericOnly && item.artists.some((a) => batchArtists.has(a));

        if (artistInBatch) {
            deferredToTier3.push(item);
            continue;
        }

        const channelInBatch = Boolean(item.channel && !isGenericArtist(item.channel) && batchChannels.has(item.channel));
        if (channelInBatch) {
            deferredToTier2.push(item);
            continue;
        }

        collected.push(item.track);
        collectedIds.add(item.track.info.identifier);

        for (const a of item.artists) {
            if (!isGenericArtist(a)) batchArtists.add(a);
        }
        if (item.channel && !isGenericArtist(item.channel)) {
            batchChannels.add(item.channel);
        }
    }

    // Pass 2: Select Tier 2 candidates (diverse artists, repeated channel)
    const tier2Pool = [...deferredToTier2, ...tier2];
    for (const item of tier2Pool) {
        if (collected.length >= AUTOPLAY_TARGET) break;

        if (collectedIds.has(item.track.info.identifier)) continue;

        const hasGenericOnly = item.artists.length === 0 || item.artists.every(isGenericArtist);
        const artistInBatch = !hasGenericOnly && item.artists.some((a) => batchArtists.has(a));
        if (artistInBatch) {
            deferredToTier3.push(item);
            continue;
        }

        collected.push(item.track);
        collectedIds.add(item.track.info.identifier);

        for (const a of item.artists) {
            if (!isGenericArtist(a)) batchArtists.add(a);
        }
    }

    // Pass 3: Fallback to Tier 3 (cooldown or repeat artists) if alternatives were insufficient
    const tier3Pool = [...deferredToTier3, ...tier3];
    for (const item of tier3Pool) {
        if (collected.length >= AUTOPLAY_TARGET) break;

        if (collectedIds.has(item.track.info.identifier)) continue;

        collected.push(item.track);
        collectedIds.add(item.track.info.identifier);
    }

    // Pass 4: Fallback to tierMismatched ONLY if absolutely no matching tracks were found
    if (collected.length === 0) {
        for (const item of tierMismatched) {
            if (collected.length >= AUTOPLAY_TARGET) break;
            if (collectedIds.has(item.track.info.identifier)) continue;
            collected.push(item.track);
            collectedIds.add(item.track.info.identifier);
        }
    }

    const result = (collected.length ? collected : nonMusic).slice(0, AUTOPLAY_TARGET);
    logger.debug(`Autoplay: ${result.length} track(s) from ${seeds.length} seed(s) (${batchArtists.size} unique artist(s))`);
    return result;
}

const autoplayLocks = new Set();
const lastHandledSeedByGuild = new Map();

/**
 * Centralized Autoplay executor and coordinator.
 * Prevents concurrent discovery/insertions with a per-guild mutex lock,
 * re-checks queue and settings after async discovery, and safely starts playback.
 *
 * @param {Object} client - Discord client
 * @param {Object} player - Lavalink player
 * @param {string} reason - Caller context (e.g. 'autoPlayFunction', 'queueEnd', 'command')
 * @param {Object} [seedTrack] - Explicit seed track
 * @returns {Promise<boolean>} Whether tracks were discovered and enqueued
 */
async function handleAutoplay(client, player, reason = 'unknown', seedTrack = null) {
    if (!player?.guildId) return false;
    const guildId = player.guildId;

    // Concurrency check: prevent overlapping discovery & queue insertions
    if (autoplayLocks.has(guildId)) {
        logger.debug(`[AUTOPLAY] Skipped for guild ${guildId} (reason: ${reason}) - resolution already in progress`);
        return false;
    }

    // Setting check: must be enabled
    if (!client?.autoplayEnabled?.get(guildId)) {
        return false;
    }

    // Stop checks: do not run if intentionally stopped
    if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) {
        return false;
    }

    // Playlist session check: respect playlist session boundary
    const playlistSession = typeof player.getData === 'function' ? player.getData('playlistSession') : null;
    if (playlistSession?.isPlaylist) {
        logger.info(`Playlist session finished for guild ${guildId}; stopping autoplay as playlist completed.`);
        player.setData('playlistSession', null);
        return false;
    }

    // If upcoming queue already has tracks:
    if (player.queue?.tracks?.length > 0) {
        if (!player.queue.current && !player.playing) {
            await player.play().catch(() => {});
        }
        return false;
    }

    // If already playing a current track:
    if (player.playing && player.queue?.current) {
        return false;
    }

    const seed = seedTrack
        || (typeof player.getData === 'function' ? player.getData('lastPlayedTrack') : null)
        || player.queue?.previous?.[0]
        || player.queue?.current;

    // Deduplication check: prevent multiple rapid triggers for the exact same seed track
    const seedId = seed?.info?.identifier;
    const now = Date.now();
    const lastHandled = lastHandledSeedByGuild.get(guildId);
    if (seedId && lastHandled && lastHandled.seedId === seedId && (now - lastHandled.timestamp) < 8000) {
        logger.debug(`[AUTOPLAY] Suppressing duplicate autoplay discovery for guild ${guildId} with same seed ${seedId}`);
        return false;
    }
    if (seedId) {
        lastHandledSeedByGuild.set(guildId, { seedId, timestamp: now });
    }

    // Acquire lock
    autoplayLocks.add(guildId);
    const autoplayStart = Date.now();
    try {
        if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) {
            logger.info(`[AUTOPLAY] Playback was stopped intentionally; suppressing autoplay for guild ${guildId}`);
            return false;
        }

        logger.info(`[AUTOPLAY] Discovering recommendation for guild ${guildId} (reason: ${reason}, seed: "${seed?.info?.title || 'none'}")`);
        logger.info(`[AUTOPLAY-DIAG] guild=${guildId} reason=${reason} stage=recommendation_started elapsed=0ms seed="${seed?.info?.title || 'none'}"`);

        const tracks = await findAutoplayTracks(player, seed);

        logger.info(`[AUTOPLAY-DIAG] guild=${guildId} stage=candidate_received candidatesCount=${tracks?.length || 0} elapsed=${Date.now() - autoplayStart}ms`);

        // Re-check state after asynchronous network discovery: verify manual stop was not invoked while searching
        if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) {
            logger.info(`[AUTOPLAY] Playback was stopped during autoplay discovery for guild ${guildId}; discarding candidates.`);
            return false;
        }

        if (!client?.autoplayEnabled?.get(guildId)) {
            logger.info(`[AUTOPLAY] Autoplay was disabled during search for guild ${guildId}`);
            return false;
        }

        // Did user manually enqueue tracks while discovery was in flight?
        if (player.queue?.tracks?.length > 0) {
            logger.info(`[AUTOPLAY] User queued tracks during autoplay discovery for ${guildId}; preserving user queue.`);
            if (!player.queue.current && !player.playing) {
                await player.play().catch(() => {});
            }
            return false;
        }

        // Did playback start in the meantime?
        if (player.playing && player.queue?.current) {
            logger.info(`[AUTOPLAY] Playback already started during discovery for guild ${guildId}`);
            return false;
        }

        if (!tracks || tracks.length === 0) {
            logger.warn(`[AUTOPLAY] No recommendation candidates found for guild ${guildId}`);
            return false;
        }

        // Filter out any candidates that match the current track or upcoming queue
        const currentId = player.queue.current?.info?.identifier;
        const upcomingIds = new Set((player.queue.tracks || []).map(t => t?.info?.identifier).filter(Boolean));
        const currentTrackRef = player.queue.current;

        const eligibleTracks = tracks.filter(t => {
            if (!t?.info?.identifier) return false;
            if (currentId && t.info.identifier === currentId) return false;
            if (upcomingIds.has(t.info.identifier)) return false;
            if (currentTrackRef && isDuplicate(t, null, [currentTrackRef])) return false;
            if (seed && isDuplicate(t, null, [seed])) return false;
            return true;
        });

        if (eligibleTracks.length === 0) {
            logger.warn(`[AUTOPLAY] All discovered candidates were duplicates of current/upcoming tracks for guild ${guildId}`);
            return false;
        }

        // Insert exactly one valid recommendation when queue ends
        const tracksToQueue = eligibleTracks.slice(0, 1);
        logger.info(`[AUTOPLAY-DIAG] guild=${guildId} stage=candidate_validated eligibleCount=${eligibleTracks.length} chosen="${tracksToQueue[0]?.info?.title || 'none'}" elapsed=${Date.now() - autoplayStart}ms`);

        for (const t of tracksToQueue) {
            t.userData = { ...(t.userData || {}), autoplay: true };
        }

        logger.info(`[AUTOPLAY-DIAG] guild=${guildId} stage=playback_requested elapsed=${Date.now() - autoplayStart}ms`);

        // Add candidate(s) to queue
        await player.queue.add(tracksToQueue);

        // If called outside of autoPlayFunction, start playback if player is idle and not stopped
        if (reason !== 'autoPlayFunction') {
            if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) {
                return false;
            }
            if (!player.queue.current && !player.playing) {
                await player.play().catch((err) => {
                    logger.debug('Autoplay player.play() error:', err?.message || err);
                });
            }
        }

        return true;
    } catch (err) {
        logger.error(`[AUTOPLAY] Autoplay failed for guild ${guildId}:`, err?.message || err);
        return false;
    } finally {
        autoplayLocks.delete(guildId);
    }
}

function isAutoplayInProgress(guildId) {
    return Boolean(guildId && autoplayLocks.has(guildId));
}

module.exports = {
    findAutoplayTracks,
    AutoplayHistoryManager,
    historyManager,
    handleAutoplay,
    autoplayLocks,
    isAutoplayInProgress,
    isDuplicate,
};
