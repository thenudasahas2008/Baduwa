// URL Classifier for ZYRO Music Bot.
// Distinguishes and validates YouTube, YouTube Music, and Spotify track/album/playlist links
// while preventing unsupported URLs from becoming invalid search queries or SSRF vectors.

const SUPPORTED_TYPES = {
    YOUTUBE_TRACK: 'YOUTUBE_TRACK',
    YOUTUBE_PLAYLIST: 'YOUTUBE_PLAYLIST',
    SPOTIFY_TRACK: 'SPOTIFY_TRACK',
    SPOTIFY_ALBUM: 'SPOTIFY_ALBUM',
    SPOTIFY_PLAYLIST: 'SPOTIFY_PLAYLIST',
    UNSUPPORTED_URL: 'UNSUPPORTED_URL',
    TEXT_QUERY: 'TEXT_QUERY',
};

const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
]);

const SPOTIFY_HOSTS = new Set([
    'open.spotify.com',
    'play.spotify.com',
    'spotify.link',
    'spotify.app.link',
]);

/**
 * Checks if a string looks like a URL or URI
 * @param {string} str
 * @returns {boolean}
 */
function isPotentialUrl(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    return /^https?:\/\//i.test(trimmed) || /^spotify:/i.test(trimmed);
}

/**
 * Sanitizes and strips wrapped quotes, angle brackets, or markdown links
 * @param {string} str
 * @returns {string}
 */
function cleanRawUrl(str) {
    if (!str) return '';
    let cleaned = str.trim();
    cleaned = cleaned.replace(/^<+|>+$/g, ''); // strip <https://...>
    cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '');
    return cleaned.trim();
}

/**
 * Classifies an input string into a supported type or text query.
 *
 * @param {string} rawInput
 * @returns {{
 *   type: string,
 *   id?: string,
 *   canonicalUrl?: string,
 *   originalQuery: string,
 *   isUrl: boolean,
 *   error?: string
 * }}
 */
function classifyInput(rawInput) {
    const originalQuery = cleanRawUrl(rawInput);
    if (!originalQuery) {
        return { type: SUPPORTED_TYPES.TEXT_QUERY, originalQuery: '', isUrl: false };
    }

    // 1. Spotify URI support (e.g. spotify:track:..., spotify:album:...)
    if (/^spotify:/i.test(originalQuery)) {
        const match = originalQuery.match(/^spotify:(track|album|playlist):([a-zA-Z0-9]+)/i);
        if (match) {
            const kind = match[1].toLowerCase();
            const id = match[2];
            let type = SUPPORTED_TYPES.SPOTIFY_TRACK;
            if (kind === 'album') type = SUPPORTED_TYPES.SPOTIFY_ALBUM;
            else if (kind === 'playlist') type = SUPPORTED_TYPES.SPOTIFY_PLAYLIST;

            return {
                type,
                id,
                canonicalUrl: `https://open.spotify.com/${kind}/${id}`,
                originalQuery,
                isUrl: true,
            };
        }
        return {
            type: SUPPORTED_TYPES.UNSUPPORTED_URL,
            originalQuery,
            isUrl: true,
            error: 'Unsupported Spotify URI format.',
        };
    }

    // 2. Unsupported URI schemes (file://, ftp://, ws://, etc.)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(originalQuery)) {
        if (!/^https?:\/\//i.test(originalQuery)) {
            return {
                type: SUPPORTED_TYPES.UNSUPPORTED_URL,
                originalQuery,
                isUrl: true,
                error: 'Unsupported URL protocol. Only HTTP, HTTPS, and Spotify links are supported.',
            };
        }
    }

    // If it does not start with http:// or https://, treat as standard text query
    if (!/^https?:\/\//i.test(originalQuery)) {
        return {
            type: SUPPORTED_TYPES.TEXT_QUERY,
            originalQuery,
            isUrl: false,
        };
    }

    // 2. Parse HTTP/HTTPS URL safely
    let parsed;
    try {
        parsed = new URL(originalQuery);
    } catch {
        return {
            type: SUPPORTED_TYPES.UNSUPPORTED_URL,
            originalQuery,
            isUrl: true,
            error: 'Malformed URL.',
        };
    }

    // Prevent local / private network targeting
    const hostname = parsed.hostname.toLowerCase();
    if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
        return {
            type: SUPPORTED_TYPES.UNSUPPORTED_URL,
            originalQuery,
            isUrl: true,
            error: 'Private or local URLs are not allowed.',
        };
    }

    // 3. YouTube parsing
    if (YOUTUBE_HOSTS.has(hostname)) {
        const isMusic = hostname === 'music.youtube.com';

        // A. youtu.be/<id>
        if (hostname === 'youtu.be') {
            const videoId = parsed.pathname.slice(1).split('/')[0];
            if (videoId && /^[\w-]{10,12}$/.test(videoId)) {
                return {
                    type: SUPPORTED_TYPES.YOUTUBE_TRACK,
                    id: videoId,
                    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    originalQuery,
                    isUrl: true,
                };
            }
        }

        // B. YouTube Playlist: /playlist?list=...
        if (parsed.pathname === '/playlist') {
            const listId = parsed.searchParams.get('list');
            if (listId) {
                return {
                    type: SUPPORTED_TYPES.YOUTUBE_PLAYLIST,
                    id: listId,
                    canonicalUrl: `https://www.youtube.com/playlist?list=${listId}`,
                    originalQuery,
                    isUrl: true,
                    isMusicUrl: isMusic,
                };
            }
        }

        // C. YouTube Video: /watch?v=...
        if (parsed.pathname === '/watch') {
            const videoId = parsed.searchParams.get('v');
            const listId = parsed.searchParams.get('list');

            // If it is a playlist-centric watch URL without a video ID, treat as playlist
            if (!videoId && listId) {
                return {
                    type: SUPPORTED_TYPES.YOUTUBE_PLAYLIST,
                    id: listId,
                    canonicalUrl: `https://www.youtube.com/playlist?list=${listId}`,
                    originalQuery,
                    isUrl: true,
                    isMusicUrl: isMusic,
                };
            }

            // Radio mix URL (/watch?v=...&list=RD...) -> preserve full radio playlist URL
            if (listId && listId.startsWith('RD')) {
                return {
                    type: SUPPORTED_TYPES.YOUTUBE_PLAYLIST,
                    id: listId,
                    canonicalUrl: `https://www.youtube.com/watch?v=${videoId || ''}&list=${listId}`,
                    originalQuery,
                    isUrl: true,
                    isMusicUrl: isMusic,
                };
            }

            if (videoId && /^[\w-]{10,12}$/.test(videoId)) {
                return {
                    type: SUPPORTED_TYPES.YOUTUBE_TRACK,
                    id: videoId,
                    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    originalQuery,
                    isUrl: true,
                    isMusicUrl: isMusic,
                };
            }
        }

        // D. YouTube Shorts: /shorts/<id>
        if (parsed.pathname.startsWith('/shorts/')) {
            const videoId = parsed.pathname.replace('/shorts/', '').split('/')[0];
            if (videoId && /^[\w-]{10,12}$/.test(videoId)) {
                return {
                    type: SUPPORTED_TYPES.YOUTUBE_TRACK,
                    id: videoId,
                    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    originalQuery,
                    isUrl: true,
                };
            }
        }

        // E. YouTube Embed: /embed/<id>
        if (parsed.pathname.startsWith('/embed/')) {
            const videoId = parsed.pathname.replace('/embed/', '').split('/')[0];
            if (videoId && /^[\w-]{10,12}$/.test(videoId)) {
                return {
                    type: SUPPORTED_TYPES.YOUTUBE_TRACK,
                    id: videoId,
                    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    originalQuery,
                    isUrl: true,
                };
            }
        }

        return {
            type: SUPPORTED_TYPES.UNSUPPORTED_URL,
            originalQuery,
            isUrl: true,
            error: 'Could not extract a valid YouTube video or playlist ID.',
        };
    }

    // 4. Spotify parsing
    if (SPOTIFY_HOSTS.has(hostname)) {
        // Short links (e.g. spotify.link/xyz or spotify.app.link/xyz)
        if (hostname === 'spotify.link' || hostname === 'spotify.app.link') {
            const shortId = parsed.pathname.replace(/^\/+/, '').split('/')[0];
            return {
                type: SUPPORTED_TYPES.SPOTIFY_TRACK,
                id: shortId || 'short',
                canonicalUrl: originalQuery,
                originalQuery,
                isUrl: true,
                isShortLink: true,
            };
        }

        // Strip localization path prefix like /intl-es/ or /intl-en/
        let normalizedPath = parsed.pathname.replace(/^\/intl-[a-z]{2,5}\//i, '/');

        // A. Spotify Track: /track/<id>
        const trackMatch = normalizedPath.match(/^\/track\/([a-zA-Z0-9]+)/i);
        if (trackMatch) {
            const id = trackMatch[1];
            return {
                type: SUPPORTED_TYPES.SPOTIFY_TRACK,
                id,
                canonicalUrl: `https://open.spotify.com/track/${id}`,
                originalQuery,
                isUrl: true,
            };
        }

        // B. Spotify Album: /album/<id>
        const albumMatch = normalizedPath.match(/^\/album\/([a-zA-Z0-9]+)/i);
        if (albumMatch) {
            const id = albumMatch[1];
            return {
                type: SUPPORTED_TYPES.SPOTIFY_ALBUM,
                id,
                canonicalUrl: `https://open.spotify.com/album/${id}`,
                originalQuery,
                isUrl: true,
            };
        }

        // C. Spotify Playlist: /playlist/<id>
        const playlistMatch = normalizedPath.match(/^\/playlist\/([a-zA-Z0-9]+)/i);
        if (playlistMatch) {
            const id = playlistMatch[1];
            return {
                type: SUPPORTED_TYPES.SPOTIFY_PLAYLIST,
                id,
                canonicalUrl: `https://open.spotify.com/playlist/${id}`,
                originalQuery,
                isUrl: true,
            };
        }

        return {
            type: SUPPORTED_TYPES.UNSUPPORTED_URL,
            originalQuery,
            isUrl: true,
            error: 'Unsupported Spotify URL format. Please provide a track, album, or playlist link.',
        };
    }

    // 5. Any other domain
    return {
        type: SUPPORTED_TYPES.UNSUPPORTED_URL,
        originalQuery,
        isUrl: true,
        error: 'Unsupported URL. ZYRO supports YouTube, YouTube Music, and Spotify links.',
    };
}

module.exports = {
    SUPPORTED_TYPES,
    isPotentialUrl,
    cleanRawUrl,
    classifyInput,
};
