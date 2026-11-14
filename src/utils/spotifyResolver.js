// Spotify Resolver for ZYRO Music Bot.
// Resolves Spotify track, album, and playlist URLs to exact metadata (with or without API credentials)
// and maps them to verified, high-fidelity playable audio streams via YouTube/Lavalink.

const logger = require('./logger');
const { extractQueryFeatures, calculateScore } = require('./searchEngine');
const { spotifyBulkhead } = require('./bulkheadManager');

let cachedSpotifyToken = null;
let tokenExpiresAt = 0;

const SPOTIFY_META_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SPOTIFY_META_CACHE_SIZE = 250;
const spotifyMetadataCache = new Map();

const SPOTIFY_YT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SPOTIFY_YT_CACHE_SIZE = 250;
const spotifyTrackToYouTubeCache = new Map();

function clearSpotifyCache() {
    spotifyMetadataCache.clear();
    spotifyTrackToYouTubeCache.clear();
    if (spotifyBulkhead && typeof spotifyBulkhead.clear === 'function') {
        spotifyBulkhead.clear();
    }
}

/**
 * Retrieves a Spotify Client Credentials Bearer Token if credentials are provided in process.env
 * @returns {Promise<string|null>}
 */
async function getSpotifyApiToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) return null;

    if (cachedSpotifyToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedSpotifyToken;
    }

    try {
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
            logger.debug(`Spotify token request failed with HTTP ${res.status}`);
            return null;
        }

        const data = await res.json();
        if (data.access_token) {
            cachedSpotifyToken = data.access_token;
            tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
            return cachedSpotifyToken;
        }
    } catch (err) {
        logger.debug('Failed to fetch Spotify API token:', err?.message || err);
    }
    return null;
}

/**
 * Unshortens mobile share links (e.g. spotify.link/xyz) to canonical track IDs
 * @param {string} urlOrId
 * @returns {Promise<string>}
 */
async function unshortenSpotifyUrl(urlOrId) {
    if (!urlOrId) return urlOrId;
    if (/^https?:\/\/(?:spotify\.link|spotify\.app\.link)/i.test(urlOrId)) {
        try {
            const res = await fetch(urlOrId, {
                method: 'GET',
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                signal: AbortSignal.timeout(4000),
            });
            const finalUrl = res.url || '';
            const match = finalUrl.match(/\/track\/([a-zA-Z0-9]+)/i);
            if (match) return match[1];
        } catch (_) {}
    }
    return urlOrId;
}

/**
 * Fetches track metadata via Spotify Web API or public oEmbed / Embed fallback
 * @param {string} rawTrackId
 * @returns {Promise<{ title: string, artists: string, durationMs: number, thumbnail: string|null }|null>}
 */
async function getSpotifyTrackMetadata(rawTrackId) {
    if (!rawTrackId) return null;
    const trackId = await unshortenSpotifyUrl(rawTrackId);

    const cached = spotifyMetadataCache.get(trackId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    return spotifyBulkhead.run(async () => {
        // Double-check cache inside bulkhead
        const innerCached = spotifyMetadataCache.get(trackId);
        if (innerCached && Date.now() < innerCached.expiresAt) {
            return innerCached.data;
        }

    // 1. Try Spotify Web API if credentials exist
    const token = await getSpotifyApiToken();
    if (token) {
        try {
            const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
                headers: { 'Authorization': `Bearer ${token}` },
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = await res.json();
                const metadata = {
                    title: data.name,
                    artists: data.artists ? data.artists.map(a => a.name).join(', ') : '',
                    durationMs: data.duration_ms || 0,
                    thumbnail: data.album?.images?.[0]?.url || null,
                };
                if (spotifyMetadataCache.size >= MAX_SPOTIFY_META_CACHE_SIZE) {
                    const oldestKey = spotifyMetadataCache.keys().next().value;
                    spotifyMetadataCache.delete(oldestKey);
                }
                spotifyMetadataCache.set(trackId, {
                    data: metadata,
                    expiresAt: Date.now() + SPOTIFY_META_TTL_MS,
                });
                return metadata;
            }
        } catch (err) {
            logger.debug(`Spotify API track lookup error: ${err?.message || err}`);
        }
    }

    // 2. Unauthenticated Fallback: Spotify Embed page scraping (__NEXT_DATA__)
    try {
        const embedRes = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
            signal: AbortSignal.timeout(5000),
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (embedRes.ok) {
            const html = await embedRes.text();
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                const nextData = JSON.parse(nextDataMatch[1]);
                const entity = nextData.props?.pageProps?.state?.data?.entity;
                if (entity && (entity.name || entity.title)) {
                    const title = entity.name || entity.title;
                    const artists = entity.artists
                        ? entity.artists.map(a => a.name).join(', ')
                        : (entity.subtitle || '');
                    const durationMs = entity.duration || 0;
                    const thumbnail = entity.coverArt?.sources?.[0]?.url || null;

                    const metadata = {
                        title,
                        artists,
                        durationMs,
                        thumbnail,
                    };
                    if (spotifyMetadataCache.size >= MAX_SPOTIFY_META_CACHE_SIZE) {
                        const oldestKey = spotifyMetadataCache.keys().next().value;
                        spotifyMetadataCache.delete(oldestKey);
                    }
                    spotifyMetadataCache.set(trackId, {
                        data: metadata,
                        expiresAt: Date.now() + SPOTIFY_META_TTL_MS,
                    });
                    return metadata;
                }
            }
        }
    } catch (err) {
        logger.debug(`Spotify Embed track lookup error: ${err?.message || err}`);
    }

    // 3. Fallback: Spotify oEmbed API
    try {
        const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`;
        const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const data = await res.json();
            let title = data.title || '';
            title = title.replace(/\s*-\s*song by.*$/i, '').trim();

            const artists = data.author_name || '';
            const thumbnail = data.thumbnail_url || null;

            const metadata = {
                title,
                artists,
                durationMs: 0,
                thumbnail,
            };
            if (spotifyMetadataCache.size >= MAX_SPOTIFY_META_CACHE_SIZE) {
                const oldestKey = spotifyMetadataCache.keys().next().value;
                spotifyMetadataCache.delete(oldestKey);
            }
            spotifyMetadataCache.set(trackId, {
                data: metadata,
                expiresAt: Date.now() + SPOTIFY_META_TTL_MS,
            });
            return metadata;
        }
    } catch (err) {
        logger.debug(`Spotify oEmbed lookup error: ${err?.message || err}`);
    }

    return null;
    }, { timeoutMs: 8000 }).catch(err => {
        logger.debug(`Spotify track metadata resolution failed: ${err?.message || err}`);
        return null;
    });
}

/**
 * Fetches album tracks via Spotify API or Embed fallback
 * @param {string} albumId
 * @returns {Promise<{ title: string, tracks: Array<{ title: string, artists: string, durationMs: number, thumbnail: string|null }> }|null>}
 */
async function getSpotifyAlbumTracks(albumId) {
    if (!albumId) return null;

    // 1. Try Spotify Web API
    const token = await getSpotifyApiToken();
    if (token) {
        try {
            const res = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
                headers: { 'Authorization': `Bearer ${token}` },
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = await res.json();
                const albumTitle = data.name || 'Album';
                const thumbnail = data.images?.[0]?.url || null;
                const tracks = (data.tracks?.items || []).map(item => ({
                    title: item.name,
                    artists: item.artists ? item.artists.map(a => a.name).join(', ') : '',
                    durationMs: item.duration_ms || 0,
                    thumbnail,
                }));
                return { title: albumTitle, tracks, thumbnail };
            }
        } catch (err) {
            logger.debug(`Spotify API album lookup error: ${err?.message || err}`);
        }
    }

    // 2. Unauthenticated Fallback: Spotify Embed scraping
    try {
        const embedRes = await fetch(`https://open.spotify.com/embed/album/${albumId}`, { signal: AbortSignal.timeout(5000) });
        if (embedRes.ok) {
            const html = await embedRes.text();
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                const nextData = JSON.parse(nextDataMatch[1]);
                const entity = nextData.props?.pageProps?.state?.data?.entity;
                if (entity) {
                    const albumTitle = entity.name || 'Album';
                    const thumbnail = entity.coverArt?.sources?.[0]?.url || null;
                    const trackList = entity.trackList || [];
                    const tracks = trackList.map(t => ({
                        title: t.title || t.name,
                        artists: t.subtitle || (t.artists ? t.artists.map(a => a.name).join(', ') : ''),
                        durationMs: t.duration || 0,
                        thumbnail,
                    }));
                    if (tracks.length > 0) {
                        return { title: albumTitle, tracks, thumbnail };
                    }
                }
            }
        }
    } catch (err) {
        logger.debug(`Spotify Embed album lookup error: ${err?.message || err}`);
    }

    return null;
}

/**
 * Fetches playlist tracks via Spotify API or Embed fallback
 * @param {string} playlistId
 * @returns {Promise<{ title: string, tracks: Array<{ title: string, artists: string, durationMs: number, thumbnail: string|null }> }|null>}
 */
async function getSpotifyPlaylistTracks(playlistId) {
    if (!playlistId) return null;

    // 1. Try Spotify Web API
    const token = await getSpotifyApiToken();
    if (token) {
        try {
            const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
                headers: { 'Authorization': `Bearer ${token}` },
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = await res.json();
                const playlistTitle = data.name || 'Playlist';
                const thumbnail = data.images?.[0]?.url || null;
                const tracks = (data.tracks?.items || [])
                    .map(item => item.track)
                    .filter(Boolean)
                    .map(t => ({
                        title: t.name,
                        artists: t.artists ? t.artists.map(a => a.name).join(', ') : '',
                        durationMs: t.duration_ms || 0,
                        thumbnail: t.album?.images?.[0]?.url || thumbnail,
                    }));
                return { title: playlistTitle, tracks, thumbnail };
            }
        } catch (err) {
            logger.debug(`Spotify API playlist lookup error: ${err?.message || err}`);
        }
    }

    // 2. Unauthenticated Fallback: Spotify Embed scraping
    try {
        const embedRes = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, { signal: AbortSignal.timeout(5000) });
        if (embedRes.ok) {
            const html = await embedRes.text();
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                const nextData = JSON.parse(nextDataMatch[1]);
                const entity = nextData.props?.pageProps?.state?.data?.entity;
                if (entity) {
                    const playlistTitle = entity.name || 'Playlist';
                    const thumbnail = entity.coverArt?.sources?.[0]?.url || null;
                    const trackList = entity.trackList || [];
                    const tracks = trackList.map(t => ({
                        title: t.title || t.name,
                        artists: t.subtitle || (t.artists ? t.artists.map(a => a.name).join(', ') : ''),
                        durationMs: t.duration || 0,
                        thumbnail,
                    }));
                    if (tracks.length > 0) {
                        return { title: playlistTitle, tracks, thumbnail };
                    }
                }
            }
        }
    } catch (err) {
        logger.debug(`Spotify Embed playlist lookup error: ${err?.message || err}`);
    }

    return null;
}

/**
 * Searches Lavalink/YouTube for a playable equivalent of a Spotify track,
 * ranking candidate tracks using title, artists, and duration alignment.
 *
 * @param {Object} player
 * @param {{ title: string, artists: string, durationMs?: number, thumbnail?: string|null }} spotifyMeta
 * @param {Object} requestUser
 * @returns {Promise<Object|null>} Playable Lavalink track or null if no reliable match
 */
async function matchSpotifyTrackToYouTube(player, spotifyMeta, requestUser, options = {}) {
    if (!player || !spotifyMeta?.title) return null;
    if (options.signal?.aborted) return null;

    const cacheKey = `${String(spotifyMeta.title || '').toLowerCase().trim()}::${String(spotifyMeta.artists || '').toLowerCase().trim()}`;
    const cachedMatch = spotifyTrackToYouTubeCache.get(cacheKey);
    if (cachedMatch && Date.now() < cachedMatch.expiresAt && cachedMatch.track) {
        const cloned = { ...cachedMatch.track };
        if (cachedMatch.track.info) cloned.info = { ...cachedMatch.track.info };
        if (cachedMatch.track.userData) cloned.userData = { ...cachedMatch.track.userData };
        if (requestUser) cloned.requester = requestUser;
        return cloned;
    }

    const resolveStart = Date.now();
    const query = `${spotifyMeta.title} ${spotifyMeta.artists || ''}`.trim();
    const features = extractQueryFeatures(query);

    let lastError = null;
    const safeSearch = (searchOpts) => {
        if (!player || typeof player.search !== 'function') return Promise.resolve(null);
        if (options.signal?.aborted) return Promise.resolve(null);
        let timeoutId;
        const searchPromise = player.search(searchOpts, requestUser).catch((err) => {
            lastError = err;
            return null;
        });
        const timeoutPromise = new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(null), 5000);
            if (options.signal) {
                options.signal.addEventListener('abort', () => resolve(null), { once: true });
            }
        });
        return Promise.race([searchPromise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
    };

    const isRateLimited = (r) => {
        const msg = String(r?.message || r?.exception?.message || lastError?.message || '');
        return r?.status === 429 || /429|RATE_LIMITED|rate\s*limited|Too Many Requests/i.test(msg);
    };

    let searchResult = null;
    try {
        searchResult = await safeSearch({ query, source: 'ytmsearch' });
        if ((!searchResult?.tracks?.length || isRateLimited(searchResult)) && !options.signal?.aborted) {
            if (isRateLimited(searchResult)) {
                const node = player.node;
                const host = node?.options?.host || node?.host;
                const port = node?.options?.port || node?.port;
                if (host && port && player.client?.publicNodeProvider) {
                    player.client.publicNodeProvider.markNodeFailed(host, port, 'YouTube HTTP 429 Rate Limited (Spotify)', 'RATE_LIMITED');
                }
                if (player.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode) {
                    await player.client.lavalinkConnectionManager.migratePlayerToHealthyNode(player, 'spotify-429-rate-limit').catch(() => false);
                }
            }
            searchResult = await safeSearch({ query, source: 'ytsearch' });
        }
        // Fallback: If title + artists returned nothing, try title alone to prevent over-constraining
        if (!searchResult?.tracks?.length && spotifyMeta.title && !options.signal?.aborted) {
            searchResult = await safeSearch({ query: spotifyMeta.title, source: 'ytmsearch' });
            if (!searchResult?.tracks?.length) {
                searchResult = await safeSearch({ query: spotifyMeta.title, source: 'ytsearch' });
            }
        }
    } catch (err) {
        logger.debug(`YouTube search for Spotify track "${query}" failed:`, err?.message || err);
        return null;
    }

    if (!searchResult?.tracks?.length) return null;

    const targetDuration = spotifyMeta.durationMs || 0;
    let bestTrack = null;
    let bestScore = -Infinity;

    for (const candidate of searchResult.tracks) {
        let score = calculateScore(candidate, features);

        // Duration alignment check
        const candDuration = candidate.info?.duration || 0;
        if (targetDuration > 0 && candDuration > 0) {
            const diff = Math.abs(candDuration - targetDuration);
            if (diff <= 4000) {
                score += 25; // within 4 seconds: strong positive indicator
            } else if (diff <= 12000) {
                score += 15; // within 12 seconds
            } else if (diff > 35000 && (diff / targetDuration) > 0.20) {
                score -= 40; // excessive duration mismatch (e.g. extended version or 1 hour loop)
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestTrack = candidate;
        }
    }

    const resolveDurationMs = Date.now() - resolveStart;
    logger.info(`[SPOTIFY-DIAG] track="${spotifyMeta.title}" resolveDuration=${resolveDurationMs}ms score=${bestScore} success=${Boolean(bestScore >= 40 && bestTrack)}`);

    // Require a reliable minimum score (40) so we never replace songs with arbitrary junk
    if (bestScore < 40 || !bestTrack) {
        logger.debug(`No confident match for Spotify track "${query}" (best score: ${bestScore})`);
        return null;
    }

    // Preserve original Spotify metadata on the returned track
    bestTrack.info.title = spotifyMeta.title;
    if (spotifyMeta.artists) bestTrack.info.author = spotifyMeta.artists;
    if (spotifyMeta.thumbnail && !bestTrack.info.artworkUrl) {
        bestTrack.info.artworkUrl = spotifyMeta.thumbnail;
    }
    bestTrack.userData = {
        ...bestTrack.userData,
        spotifyTitle: spotifyMeta.title,
        spotifyArtist: spotifyMeta.artists,
        resolvedVia: 'youtube',
    };

    if (spotifyTrackToYouTubeCache.size >= MAX_SPOTIFY_YT_CACHE_SIZE) {
        const oldest = spotifyTrackToYouTubeCache.keys().next().value;
        spotifyTrackToYouTubeCache.delete(oldest);
    }
    spotifyTrackToYouTubeCache.set(cacheKey, {
        track: bestTrack,
        expiresAt: Date.now() + SPOTIFY_YT_CACHE_TTL_MS,
    });

    return bestTrack;
}

/**
 * Resolves an array of Spotify track items using bounded concurrency
 * @param {Object} player
 * @param {Array<Object>} items
 * @param {Object} requestUser
 * @param {number} concurrencyLimit
 * @returns {Promise<Array<Object>>}
 */
async function resolveTracksBounded(player, items, requestUser, concurrencyLimit = 4, options = {}) {
    const targetItems = Array.isArray(items) ? items.slice(0, 50) : [];
    const results = new Array(targetItems.length);
    let index = 0;

    async function worker() {
        while (index < targetItems.length) {
            const currentIndex = index++;
            if (options.signal?.aborted) break;
            try {
                const matchPromise = matchSpotifyTrackToYouTube(player, targetItems[currentIndex], requestUser, options);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Match timeout')), 4000)
                );
                const matched = await Promise.race([matchPromise, timeoutPromise]);
                results[currentIndex] = matched;
            } catch (err) {
                results[currentIndex] = null;
            }
        }
    }

    const workerCount = Math.min(concurrencyLimit, targetItems.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    return results.filter(Boolean);
}

module.exports = {
    unshortenSpotifyUrl,
    getSpotifyTrackMetadata,
    getSpotifyAlbumTracks,
    getSpotifyPlaylistTracks,
    matchSpotifyTrackToYouTube,
    resolveTracksBounded,
    clearSpotifyCache,
    spotifyMetadataCache,
    spotifyTrackToYouTubeCache,
};
