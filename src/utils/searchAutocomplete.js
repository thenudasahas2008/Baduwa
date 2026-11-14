const { formatDuration } = require('./zyroEmbeds');
const { cleanQueryString, isUrl, rankTracks, CONFIDENCE_LEVELS } = require('./searchEngine');
const logger = require('./logger');

// In-memory bounded cache for autocomplete responses (5-minute TTL)
const AUTOCOMPLETE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_AUTOCOMPLETE_CACHE_SIZE = 500;
const autocompleteCache = new Map();

// Stable token map for URLs/queries that exceed Discord's 100-character choice value limit (30-minute TTL)
const TOKEN_TTL_MS = 30 * 60 * 1000;
const tokenMap = new Map();

// In-flight request deduplication map to prevent multiple simultaneous requests for the same query
const inFlightRequests = new Map();

/**
 * Stores a long URI or track object into the stable token map and returns a compact identifier (<= 40 chars).
 *
 * @param {string} fullUri - The complete canonical URI or query string
 * @param {Object} [metadata] - Optional track metadata (title, author)
 * @returns {string} Compact stable token
 */
function storeAutocompleteToken(fullUri, metadata = {}) {
    if (!fullUri) return '';
    if (fullUri.length <= 100) return fullUri;

    // Generate a deterministic compact base64url key
    const hash = Buffer.from(fullUri).toString('base64url').slice(0, 32);
    const token = `tok_${hash}`;

    // Periodically clean expired tokens when map grows large
    if (tokenMap.size >= 1000) {
        const now = Date.now();
        for (const [k, v] of tokenMap.entries()) {
            if (v.expiresAt < now) tokenMap.delete(k);
        }
    }

    tokenMap.set(token, {
        uri: fullUri,
        title: metadata.title || null,
        author: metadata.author || null,
        expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    return token;
}

/**
 * Resolves a potentially tokenized query value back into its full canonical URL or query string.
 * If the token has expired, returns an object with { isExpired: true, token }.
 *
 * @param {string} input - User submitted query or token
 * @returns {string|{ isExpired: boolean, token: string }} Resolved canonical URL or original query
 */
function resolveAutocompleteToken(input) {
    if (!input || typeof input !== 'string') return input || '';

    if (input.startsWith('tok_')) {
        if (tokenMap.has(input)) {
            const entry = tokenMap.get(input);
            if (entry && entry.expiresAt > Date.now()) {
                return entry.uri;
            }
            tokenMap.delete(input);
        }
        // Token was expired or evicted
        return { isExpired: true, token: input };
    }

    return input;
}

/**
 * Checks if a resolved autocomplete token value represents an expired token.
 *
 * @param {*} value - Value returned from resolveAutocompleteToken
 * @returns {boolean} True if value is an expired token
 */
function isExpiredToken(value) {
    return Boolean(value && typeof value === 'object' && value.isExpired);
}

/**
 * Safely sanitizes and formats a choice label within Discord's strict 100-character constraint.
 *
 * @param {string} prefix - Icon emoji (e.g. '🎵', '📁', '🔍', '🔗')
 * @param {string} title - Primary title
 * @param {string} [subtitle] - Secondary info (e.g. artist, playlist tag)
 * @param {string} [extra] - Extra info (e.g. duration)
 * @returns {string} Truncated string strictly <= 100 chars
 */
function formatChoiceName(prefix, title, subtitle = '', extra = '') {
    const cleanPrefix = (prefix || '').trim();
    const cleanTitle = (title || '').replace(/\s+/g, ' ').trim();
    const cleanSub = (subtitle || '').replace(/\s+/g, ' ').trim();
    const cleanExtra = (extra || '').replace(/\s+/g, ' ').trim();

    const extraPart = cleanExtra ? ` (${cleanExtra})` : '';
    const prefixPart = cleanPrefix ? `${cleanPrefix} ` : '';

    // Fast path: if full string fits in 100 chars, return as is
    let candidate = `${prefixPart}${cleanTitle}`;
    if (cleanSub) candidate += ` — ${cleanSub}`;
    candidate += extraPart;

    if (candidate.length <= 100) {
        return candidate;
    }

    // Budget available characters for title and subtitle
    const budget = Math.max(10, 100 - prefixPart.length - extraPart.length);

    let titlePart = cleanTitle;
    let subPart = cleanSub;

    if (cleanSub) {
        const separator = ' — ';
        const contentBudget = Math.max(8, budget - separator.length);

        // Max subtitle length: min(28, 35% of contentBudget)
        const maxSubLen = Math.min(28, Math.floor(contentBudget * 0.35));
        if (subPart.length > maxSubLen) {
            subPart = `${subPart.slice(0, Math.max(4, maxSubLen - 1)).trim()}…`;
        }

        const remainingForTitle = Math.max(5, budget - separator.length - subPart.length);
        if (titlePart.length > remainingForTitle) {
            titlePart = `${titlePart.slice(0, Math.max(4, remainingForTitle - 1)).trim()}…`;
        }

        return `${prefixPart}${titlePart}${separator}${subPart}${extraPart}`.slice(0, 100);
    } else {
        if (titlePart.length > budget) {
            titlePart = `${titlePart.slice(0, Math.max(4, budget - 1)).trim()}…`;
        }
        return `${prefixPart}${titlePart}${extraPart}`.slice(0, 100);
    }
}

const NON_MUSIC_TERMS = [
    'gastritis', 'constipation', 'cramp', 'cramps', 'infection', 'symptom', 'symptoms',
    'disease', 'meaning', 'definition', 'recipe', 'treatment', 'diet', 'workout', 'pain',
    'headache', 'medicine', 'tablet', 'vomiting', 'fever', 'cough', 'tutorial', 'how to'
];

/**
 * Fetches real song suggestions (title, artist, duration) via iTunes Search API with a 750ms timeout.
 *
 * @param {string} query
 * @returns {Promise<Array<Object>>}
 */
async function fetchMusicSuggestions(query) {
    if (!query || query.length < 2) return [];
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 750);
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=10`;

        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
        clearTimeout(timeout);

        if (!response.ok) return [];
        const data = await response.json();
        if (Array.isArray(data?.results)) {
            const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
            return data.results.map(item => ({
                info: {
                    title: item.trackName || '',
                    author: item.artistName || '',
                    duration: item.trackTimeMillis || 0,
                    artworkUrl: item.artworkUrl100 || null,
                    isExternalMusic: true,
                }
            })).filter(t => {
                if (!t.info.title) return false;
                const text = `${t.info.title} ${t.info.author}`.toLowerCase();
                return queryWords.some(w => text.includes(w));
            });
        }
    } catch (_) {
        // Non-blocking fallback
    }
    return [];
}

/**
 * Fetches YouTube search suggestion strings via Google suggest API with a tight 800ms timeout.
 *
 * @param {string} query - Raw search query
 * @returns {Promise<string[]>} Array of suggestion strings
 */
async function fetchSearchSuggestions(query) {
    if (!query || query.length < 2) return [];
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 800);
        const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;

        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
        clearTimeout(timeout);

        if (!response.ok) return [];
        const data = await response.json();
        if (Array.isArray(data) && Array.isArray(data[1])) {
            return data[1]
                .map(s => (typeof s === 'string' ? s.trim() : ''))
                .filter(s => {
                    if (!s) return false;
                    const lower = s.toLowerCase();
                    return !NON_MUSIC_TERMS.some(t => lower.includes(t));
                });
        }
    } catch (_) {
        // Non-blocking fallback
    }
    return [];
}

/**
 * Queries Lavalink node for real track and playlist suggestions with a 1200ms timeout
 * and automatic fallback between YouTube Music and YouTube.
 *
 * @param {Object} client - Discord client
 * @param {string} query - Search query
 * @param {Object} user - User initiating the interaction
 * @returns {Promise<{ tracks: Object[], playlist: Object|null }>}
 */
async function fetchLavalinkTracks(client, query, user) {
    const defaultResult = { tracks: [], playlist: null };
    if (!client?.lavalink) return defaultResult;

    // Check if any Lavalink node is connected
    const activeNode = client.lavalinkConnectionManager?.getActiveNode?.()
        || client.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
        || (client.lavalink?.nodeManager?.nodes ? Array.from(client.lavalink.nodeManager.nodes.values())[0] : null);

    if (!activeNode || !activeNode.connected) {
        return defaultResult;
    }

    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Lavalink autocomplete search timeout')), 1600)
        );

        const searchPromise = (async () => {
            const isSinhala = /[\u0D80-\u0DFF]/.test(query);

            if (isSinhala) {
                // Regional Sinhala content: query YouTube first, YouTube Music in parallel
                const ytPromise = activeNode.search({ query, source: 'ytsearch' }, user).catch(() => null);
                const ytmPromise = activeNode.search({ query, source: 'ytmsearch' }, user).catch(() => null);
                const [ytRes, ytmRes] = await Promise.all([ytPromise, ytmPromise]);

                const checkRateLimit = (r) => {
                    const msg = String(r?.message || r?.exception?.message || '');
                    return r?.status === 429 || /429|RATE_LIMITED|rate\s*limited|Too Many Requests/i.test(msg);
                };
                if (checkRateLimit(ytRes) || checkRateLimit(ytmRes)) {
                    const host = activeNode.options?.host || activeNode.host;
                    const port = activeNode.options?.port || activeNode.port;
                    if (host && port && client.publicNodeProvider) {
                        client.publicNodeProvider.markNodeFailed(host, port, 'YouTube HTTP 429 Rate Limited (Autocomplete)', 'RATE_LIMITED');
                    }
                }

                const combinedTracks = [];
                if (ytRes?.tracks?.length) combinedTracks.push(...ytRes.tracks);
                if (ytmRes?.tracks?.length) combinedTracks.push(...ytmRes.tracks);

                return {
                    tracks: combinedTracks,
                    playlist: ytRes?.loadType === 'playlist' ? ytRes.playlist : (ytmRes?.loadType === 'playlist' ? ytmRes.playlist : null),
                };
            }

            // Query YouTube Music and YouTube in parallel for fast, responsive song suggestions
            const ytmPromise = activeNode.search({ query, source: 'ytmsearch' }, user).catch(() => null);
            const ytPromise = activeNode.search({ query, source: 'ytsearch' }, user).catch(() => null);
            const [ytmRes, ytRes] = await Promise.all([ytmPromise, ytPromise]);

            const checkRateLimit = (r) => {
                const msg = String(r?.message || r?.exception?.message || '');
                return r?.status === 429 || /429|RATE_LIMITED|rate\s*limited|Too Many Requests/i.test(msg);
            };
            if (checkRateLimit(ytmRes) || checkRateLimit(ytRes)) {
                const host = activeNode.options?.host || activeNode.host;
                const port = activeNode.options?.port || activeNode.port;
                if (host && port && client.publicNodeProvider) {
                    client.publicNodeProvider.markNodeFailed(host, port, 'YouTube HTTP 429 Rate Limited (Autocomplete)', 'RATE_LIMITED');
                }
            }

            const combinedTracks = [];
            if (ytmRes?.tracks?.length) combinedTracks.push(...ytmRes.tracks);
            if (ytRes?.tracks?.length) combinedTracks.push(...ytRes.tracks);

            return {
                tracks: combinedTracks,
                playlist: ytmRes?.loadType === 'playlist' ? ytmRes.playlist : (ytRes?.loadType === 'playlist' ? ytRes.playlist : null),
            };
        })();

        const res = await Promise.race([searchPromise, timeoutPromise]);
        if (!res) return defaultResult;

        const tracks = Array.isArray(res.tracks) ? res.tracks : [];
        const playlist = res.playlist || (res.loadType === 'playlist' ? res.playlist : null);

        return { tracks, playlist };
    } catch (_) {
        return defaultResult;
    }
}

/**
 * Normalizes title + artist string to detect near-duplicate re-uploads,
 * while preserving version modifiers (slowed, reverb, remix, live, acoustic, cover).
 *
 * @param {string} title
 * @param {string} author
 * @returns {string} Normalized key
 */
function makeTrackDeduplicationKey(title = '', author = '') {
    const titleLower = String(title || '').toLowerCase();
    const cleanT = titleLower.replace(/[^a-z0-9\u0D80-\u0DFF]/g, '');
    const cleanA = String(author || '').toLowerCase().replace(/[^a-z0-9\u0D80-\u0DFF]/g, '');

    const modTags = [];
    if (titleLower.includes('slowed') && titleLower.includes('reverb')) modTags.push('slowed_reverb');
    else if (titleLower.includes('slowed')) modTags.push('slowed');
    else if (titleLower.includes('reverb')) modTags.push('reverb');
    if (titleLower.includes('remix')) modTags.push('remix');
    if (titleLower.includes('live')) modTags.push('live');
    if (titleLower.includes('acoustic')) modTags.push('acoustic');
    if (titleLower.includes('cover')) modTags.push('cover');
    if (titleLower.includes('instrumental')) modTags.push('instrumental');

    const modKey = modTags.length > 0 ? modTags.sort().join('_') : 'studio';
    return `${cleanT}::${cleanA}::${modKey}`;
}

/**
 * Core autocomplete search resolver that combines Lavalink tracks, intelligent ranking,
 * deduplication, and YouTube suggestions into Discord choices.
 *
 * @param {Object} client - Discord client instance
 * @param {string} rawInput - Currently typed input string
 * @param {Object} user - Discord user executing autocomplete
 * @returns {Promise<Array<{ name: string, value: string }>>} Array of up to 25 Discord autocomplete choices
 */
async function getAutocompleteChoices(client, rawInput, user) {
    const trimmed = (rawInput || '').normalize('NFC').trim();

    // Empty query returns no song suggestions to comply with Discord best practices
    // and prevent displaying preset playlists before user enters their query
    if (!trimmed) {
        return [];
    }

    // Direct URL check
    if (isUrl(trimmed)) {
        const cleanLink = cleanQueryString(trimmed);
        return [{
            name: formatChoiceName('🔗', `Play Direct Link (${cleanLink.slice(0, 75)})`),
            value: cleanLink.slice(0, 100),
        }];
    }

    const cacheKey = trimmed.toLowerCase();

    // 1. Check TTL cache
    const cached = autocompleteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.choices;
    }

    // 2. Check in-flight deduplication
    if (inFlightRequests.has(cacheKey)) {
        return await inFlightRequests.get(cacheKey);
    }

    const resolvePromise = (async () => {
        try {
            // Overall autocomplete timeout ceiling (1800ms) to guarantee Discord 3s SLA and test constraint
            const hardTimeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Overall autocomplete timeout')), 1800)
            );

            const searchOperation = Promise.all([
                fetchLavalinkTracks(client, trimmed, user),
                fetchMusicSuggestions(trimmed),
                fetchSearchSuggestions(trimmed),
            ]);

            const [lavalinkRes, musicTracks, suggestions] = await Promise.race([searchOperation, hardTimeoutPromise]);

            const choices = [];
            const seenValues = new Set();
            const seenNames = new Set();
            const seenTrackKeys = new Set();
            const seenUris = new Set();
            const seenIds = new Set();

            const addChoice = (name, value) => {
                if (choices.length >= 25) return;
                const cleanName = (name || '').trim().slice(0, 100);
                const cleanVal = (value || '').trim().slice(0, 100);
                if (!cleanName || !cleanVal) return;

                const valKey = cleanVal.toLowerCase();
                const nameKey = cleanName.toLowerCase();
                if (seenValues.has(valKey) || seenNames.has(nameKey)) return;

                seenValues.add(valKey);
                seenNames.add(nameKey);
                choices.push({ name: cleanName, value: cleanVal });
            };

            // 1. If provider returned a playlist, format and place it at the top
            if (lavalinkRes?.playlist) {
                const pTitle = lavalinkRes.playlist.title || lavalinkRes.playlist.name || 'Playlist';
                const pUri = lavalinkRes.playlist.uri || lavalinkRes.tracks[0]?.info?.uri;
                const trackCount = lavalinkRes.tracks?.length ? `${lavalinkRes.tracks.length} tracks` : 'Playlist';
                const pLabel = formatChoiceName('📁', pTitle, trackCount);
                const pVal = (pUri && pUri.length <= 100) ? pUri : storeAutocompleteToken(pUri || trimmed, { title: pTitle });
                addChoice(pLabel, pVal);
            }

            // 2. Rank candidate tracks using relevance engine (penalizes unrequested remixes, slowed & reverb, covers)
            const lavalinkTracks = lavalinkRes?.tracks || [];
            const rawTracks = [...lavalinkTracks];
            if (rawTracks.length === 0 && Array.isArray(musicTracks) && musicTracks.length > 0) {
                rawTracks.push(...musicTracks);
            }

            let rankedTracks = [];
            if (rawTracks.length > 0) {
                rankedTracks = rankTracks(rawTracks, trimmed);
            }

            // 3. Add individual tracks with title, artist, duration, and canonical URL
            for (const track of rankedTracks) {
                if (!track?.info) continue;
                const title = track.info.title || 'Unknown Track';
                const author = track.info.author || '';
                const duration = track.info.duration ? formatDuration(track.info.duration) : '';
                const uri = track.info.uri;
                const identifier = track.info.identifier;

                // Check identifier and URI deduplication
                if (identifier && seenIds.has(identifier)) continue;
                if (uri && seenUris.has(uri)) continue;

                // Check title + author deduplication to remove duplicate re-uploads of the same song
                const dedupKey = makeTrackDeduplicationKey(title, author);
                if (dedupKey && seenTrackKeys.has(dedupKey)) continue;

                // For autocomplete, user is typing live; only include tracks with positive relevance score
                if (track._relevanceScore !== undefined && track._relevanceScore <= 0) {
                    continue;
                }

                if (identifier) seenIds.add(identifier);
                if (uri) seenUris.add(uri);
                if (dedupKey) seenTrackKeys.add(dedupKey);

                // Formulate label: "🎵 Title — Artist (3:45)"
                const label = formatChoiceName('🎵', title, author, duration);

                // Formulate value: canonical URI (preferred) or song search string
                let val;
                if (uri && isUrl(uri) && uri.length <= 100) {
                    val = uri;
                } else if (identifier && `https://www.youtube.com/watch?v=${identifier}`.length <= 100) {
                    val = `https://www.youtube.com/watch?v=${identifier}`;
                } else if (title && author && `${title} - ${author}`.length <= 100) {
                    val = `${title} - ${author}`;
                } else {
                    val = storeAutocompleteToken(uri || `${title} ${author}`, { title, author, track });
                }

                addChoice(label, val);
                if (choices.length >= 20) break;
            }

            // 4. Fill remaining choice slots with YouTube query suggestions only if we have room
            for (const sug of suggestions) {
                if (choices.length >= 25) break;
                // e.g. "🔍 sinhala old songs"
                const sugLabel = formatChoiceName('🔍', sug);
                addChoice(sugLabel, sug);
            }

            // 5. If still no choices, return the exact query as a search choice
            if (choices.length === 0) {
                choices.push({
                    name: `🔍 Search for: "${trimmed.slice(0, 80)}"`,
                    value: trimmed.slice(0, 100),
                });
            }

            // Cache the result
            if (autocompleteCache.size >= MAX_AUTOCOMPLETE_CACHE_SIZE) {
                const oldestKey = autocompleteCache.keys().next().value;
                autocompleteCache.delete(oldestKey);
            }
            autocompleteCache.set(cacheKey, {
                choices,
                expiresAt: Date.now() + AUTOCOMPLETE_CACHE_TTL_MS,
            });

            return choices;
        } catch (err) {
            logger.debug(`Autocomplete search failed for "${trimmed}":`, err?.message || err);
            return [{
                name: `🔍 Search for: "${trimmed.slice(0, 80)}"`,
                value: trimmed.slice(0, 100),
            }];
        } finally {
            inFlightRequests.delete(cacheKey);
        }
    })();

    inFlightRequests.set(cacheKey, resolvePromise);
    return await resolvePromise;
}

/**
 * Handles incoming Discord autocomplete interaction gracefully.
 *
 * @param {Object} interaction - Discord AutocompleteInteraction
 */
async function handleAutocomplete(interaction) {
    if (!interaction?.isAutocomplete?.()) return;

    try {
        const focused = interaction.options?.getFocused?.(true);
        if (!focused || focused.name !== 'query') {
            if (!interaction.responded) {
                await interaction.respond([]).catch(() => {});
            }
            return;
        }

        const choices = await getAutocompleteChoices(interaction.client, focused.value, interaction.user);

        if (!interaction.responded) {
            await interaction.respond(choices).catch((err) => {
                logger.debug('Error delivering autocomplete response:', err?.message || err);
            });
        }
    } catch (err) {
        logger.debug('Error in handleAutocomplete:', err?.message || err);
        if (!interaction.responded) {
            await interaction.respond([]).catch(() => {});
        }
    }
}

module.exports = {
    handleAutocomplete,
    getAutocompleteChoices,
    resolveAutocompleteToken,
    storeAutocompleteToken,
    isExpiredToken,
    formatChoiceName,
    fetchSearchSuggestions,
    fetchLavalinkTracks,
    makeTrackDeduplicationKey,
    autocompleteCache,
    tokenMap,
};
