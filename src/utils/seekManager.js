const { formatDuration } = require('./embeds');
const logger = require('./logger');

/**
 * Parses user timestamp input into milliseconds.
 * Supports:
 * - "MM:SS" (e.g. "1:45", "03:20")
 * - "HH:MM:SS" (e.g. "1:02:30")
 * - Plain seconds string or number (e.g. "90", "90s")
 * - Combined units (e.g. "1m30s", "1h20m")
 *
 * Rejects:
 * - Negative values
 * - Malformed strings
 * - Seconds or minutes >= 60 in colon-delimited format
 *
 * @param {string|number} input
 * @returns {number|null} Milliseconds, or null if invalid
 */
function parseTimestampToMs(input) {
    if (input === null || input === undefined) return null;

    if (typeof input === 'number') {
        if (isNaN(input) || !isFinite(input) || input < 0) return null;
        return Math.floor(input);
    }

    if (typeof input !== 'string') return null;

    const trimmed = input.trim();
    if (!trimmed) return null;

    // Disallow negative values
    if (trimmed.startsWith('-')) return null;

    // Colon-delimited format: MM:SS or HH:MM:SS
    if (trimmed.includes(':')) {
        const parts = trimmed.split(':');
        if (parts.length < 2 || parts.length > 3) return null;

        // Verify each part is purely digits
        for (const part of parts) {
            if (!/^\d+$/.test(part)) return null;
        }

        if (parts.length === 2) {
            const minutes = parseInt(parts[0], 10);
            const seconds = parseInt(parts[1], 10);
            if (isNaN(minutes) || isNaN(seconds)) return null;
            if (seconds >= 60) return null;
            return (minutes * 60 + seconds) * 1000;
        } else if (parts.length === 3) {
            const hours = parseInt(parts[0], 10);
            const minutes = parseInt(parts[1], 10);
            const seconds = parseInt(parts[1], 10);
            const secs = parseInt(parts[2], 10);
            if (isNaN(hours) || isNaN(minutes) || isNaN(secs)) return null;
            if (minutes >= 60 || secs >= 60) return null;
            return (hours * 3600 + minutes * 60 + secs) * 1000;
        }
    }

    // Unit-based format: e.g. "1h20m30s", "2m45s", "90s"
    const unitRegex = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i;
    const unitMatch = trimmed.match(unitRegex);
    if (unitMatch && (unitMatch[1] || unitMatch[2] || unitMatch[3])) {
        const hours = parseInt(unitMatch[1] || '0', 10);
        const minutes = parseInt(unitMatch[2] || '0', 10);
        const seconds = parseInt(unitMatch[3] || '0', 10);
        return (hours * 3600 + minutes * 60 + seconds) * 1000;
    }

    // Pure numeric seconds: e.g. "90"
    if (/^\d+$/.test(trimmed)) {
        const seconds = parseInt(trimmed, 10);
        if (isNaN(seconds) || seconds < 0) return null;
        return seconds * 1000;
    }

    return null;
}

/**
 * Returns authoritative playback position from a player.
 * Accurately handles paused state (frozen) and active progression.
 *
 * @param {object} player
 * @returns {number} Position in milliseconds
 */
function getPlaybackPosition(player) {
    if (!player) return 0;

    const track = player.queue?.current;
    const duration = track?.info?.duration || 0;

    let pos = 0;
    if (player.paused) {
        pos = typeof player.lastPosition === 'number'
            ? player.lastPosition
            : (typeof player.position === 'number' ? player.position : 0);
    } else if (typeof player.position === 'number' && !isNaN(player.position)) {
        pos = player.position;
    } else if (typeof player.position === 'function') {
        const fnVal = player.position();
        pos = typeof fnVal === 'number' && !isNaN(fnVal) ? fnVal : 0;
    } else if (typeof player.lastPosition === 'number' && player.lastPositionChange) {
        pos = player.lastPosition + (Date.now() - player.lastPositionChange);
    } else if (typeof player.lastPosition === 'number') {
        pos = player.lastPosition;
    }

    pos = Math.max(0, pos);
    if (duration > 0) {
        pos = Math.min(pos, duration);
    }

    return pos;
}

/**
 * Validates track seekability, bounds, and performs the seek operation using
 * the canonical lavalink-client v2.11.0 player.seek() API.
 *
 * @param {object} player
 * @param {number} targetMs
 * @returns {Promise<{ success: boolean, code?: string, message: string, positionMs?: number, durationMs?: number, track?: object }>}
 */
async function validateAndSeek(player, targetMs) {
    if (!player) {
        return {
            success: false,
            code: 'NO_PLAYER',
            message: 'There is no active music player in this server.'
        };
    }

    const track = player.queue?.current;
    if (!track || player.stopped) {
        return {
            success: false,
            code: 'NO_TRACK',
            message: 'There is no track currently playing to seek.'
        };
    }

    const duration = track.info?.duration || 0;
    const isStream = Boolean(track.info?.isStream || duration <= 0);
    const isSeekable = track.info?.isSeekable !== false && !isStream;

    if (!isSeekable) {
        return {
            success: false,
            code: 'SEEK_UNSUPPORTED',
            message: 'Seeking is not supported on livestreams or tracks with unknown duration.'
        };
    }

    if (typeof targetMs !== 'number' || isNaN(targetMs)) {
        return {
            success: false,
            code: 'INVALID_POSITION',
            message: 'Invalid seek position provided.'
        };
    }

    if (targetMs < 0) {
        return {
            success: false,
            code: 'OUT_OF_BOUNDS_NEGATIVE',
            message: 'Seek position cannot be negative.'
        };
    }

    if (targetMs > duration) {
        return {
            success: false,
            code: 'OUT_OF_BOUNDS_EXCEEDED',
            message: `Seek position (${formatDuration(targetMs)}) exceeds track duration (${formatDuration(duration)}).`
        };
    }

    try {
        if (typeof player.seek === 'function') {
            await player.seek(targetMs);
        } else {
            // Fallback for mocked players in unit tests
            player.lastPosition = targetMs;
            player.lastPositionChange = player.paused ? null : Date.now();
        }

        logger.info(`[SEEK-DIAG] guild="${player.guildId}" track="${track.info?.title}" target=${targetMs}ms (${formatDuration(targetMs)} / ${formatDuration(duration)})`);

        return {
            success: true,
            positionMs: targetMs,
            durationMs: duration,
            track
        };
    } catch (err) {
        logger.error(`[SEEK-DIAG] Failed to seek player for guild ${player.guildId}:`, err?.message || err);
        return {
            success: false,
            code: 'SEEK_EXECUTION_ERROR',
            message: `Failed to seek: ${err?.message || 'Player error'}`
        };
    }
}

/**
 * Seeks relative to the current playback position.
 * Clamps to [0, duration].
 *
 * @param {object} player
 * @param {number} offsetSeconds (e.g. -10, 30)
 * @returns {Promise<object>}
 */
async function seekRelative(player, offsetSeconds) {
    if (!player || !player.queue?.current) {
        return {
            success: false,
            code: 'NO_TRACK',
            message: 'There is no track currently playing to seek.'
        };
    }

    const duration = player.queue.current.info?.duration || 0;
    const currentPos = getPlaybackPosition(player);
    const roundedPos = Math.round(currentPos / 1000) * 1000;
    const targetMs = Math.max(0, Math.min(roundedPos + (offsetSeconds * 1000), duration));

    return validateAndSeek(player, targetMs);
}

module.exports = {
    parseTimestampToMs,
    getPlaybackPosition,
    validateAndSeek,
    seekRelative,
};
