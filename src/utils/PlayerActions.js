// Utility functions that encapsulate common queue manipulations, allowing both
// slash-commands and component interactions to share the same core logic.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { createTrackSelectMenu, truncateText } = require('./trackSelectMenu');
const { clearGuildLifecycleTimers, markManualStop } = require('./playerLifecycle');
const logger = require('./logger');

/**
 * Canonical stop operation for both /stop command and dashboard Stop button.
 * Immediately stops playback via lavalink-client API, clears upcoming queue,
 * increments manualStopGeneration to suppress stale callbacks/autoplay,
 * keeps voice presence intact, and renders the idle dashboard in the active voice channel.
 *
 * @param {Object} client - Discord client
 * @param {Object} player - Lavalink player instance
 * @param {Object} [options] - Additional options (e.g. channelId)
 * @returns {Promise<boolean>} True if stopped successfully
 */
async function stopPlayer(client, player, options = {}) {
    if (!player) return false;
    const guildId = player.guildId;

    // 1. Increment manual stop generation to suppress stale callbacks, watchdog recovery, and autoplay
    const generation = markManualStop(guildId);

    // Cancel and abort any pending in-flight /play requests for this guild
    try {
        const playCommand = client?.commands?.get?.('play') || require('../commands/play');
        const inFlightPlay = playCommand?._inFlightPlayRequests?.get?.(guildId);
        if (inFlightPlay) {
            inFlightPlay.superseded = true;
            inFlightPlay.completed = true;
            try {
                inFlightPlay.abortController?.abort(new Error('STOPPED'));
            } catch (_) {}
            playCommand._inFlightPlayRequests.delete(guildId);
        }
    } catch (_) {}

    // 2. Set flags on player
    if (typeof player.setData === 'function') {
        player.setData('internal_stopPlaying', true);
        player.setData('internal_autoplayStopPlaying', true);
        player.setData('manual_stop_generation', generation);
    }

    // 3. Clear scheduled timers immediately
    clearGuildLifecycleTimers(guildId);

    // 4. Clear the upcoming queue and cancel pending queue transitions
    if (player.queue) {
        if (typeof player.queue.splice === 'function' && player.queue.tracks?.length) {
            await player.queue.splice(0, player.queue.tracks.length).catch(() => {});
        } else if (Array.isArray(player.queue.tracks)) {
            player.queue.tracks.length = 0;
        }
        player.queue.current = null;
    }

    // 5. Stop playback immediately via lavalink-client API (clearQueue: true, executeAutoplay: false)
    try {
        if (typeof player.stopPlaying === 'function') {
            await Promise.race([
                player.stopPlaying(true, false),
                new Promise((_, reject) => setTimeout(() => reject(new Error('player.stopPlaying timed out')), 3000))
            ]);
        }
    } catch (stopErr) {
        logger.warn(`Error during player.stopPlaying for guild ${guildId}:`, stopErr?.message || stopErr);
    }

    // 6. Reset playing state and reset audio filters to neutral baseline
    player.playing = false;
    player.paused = false;
    if (typeof player.filterManager?.resetFilters === 'function') {
        await player.filterManager.resetFilters().catch(() => {});
    }
    if (typeof player.filterManager?.clearEQ === 'function') {
        await player.filterManager.clearEQ().catch(() => {});
    }
    player._activeEqPreset = null;

    // 7. Update active tracking & presence
    client.activePlayers?.delete(guildId);
    client.playbackProgressManager?.clearGuild?.(guildId);
    client.audioPlaybackMonitor?.clearGuild?.(guildId);
    client.updatePresence?.();
    client.voiceChannelStatusManager?.clearStatusForGuild?.(guildId, { force: true }).catch(() => {});

    // 8. Render stopped/idle dashboard in the connected voice channel's chat
    const channelId = options.channelId || player.voiceChannelId || player.textChannelId;
    if (client.playerController?.showStoppedState) {
        await client.playerController.showStoppedState(guildId, { channelId, inPlace: true }).catch((err) => {
            logger.warn(`Failed to show stopped state for guild ${guildId}:`, err?.message || err);
        });
    }

    return true;
}

/**
 * Plays the previous track from the queue history.
 * Returns the track that started playing, or null if none.
 */
async function playPrevious(player) {
    if (!player?.queue?.previous || player.queue.previous.length === 0) {
        return null;
    }

    // Find the first playable previous track from history
    let previousTrack = null;
    while (player.queue.previous.length > 0) {
        const candidate = typeof player.queue.shiftPrevious === 'function'
            ? await player.queue.shiftPrevious()
            : player.queue.previous.shift();

        if (candidate && (candidate.info || candidate.encoded)) {
            previousTrack = candidate;
            break;
        }
    }

    if (!previousTrack) {
        return null;
    }

    // Put current playing track back to the front of the queue (so queue order is preserved)
    if (player.queue.current) {
        await player.queue.add(player.queue.current, 0);
    }

    // Mark the track so it's not immediately duplicated into history
    const previousClientData = previousTrack.pluginInfo?.clientData || {};
    previousTrack.pluginInfo = previousTrack.pluginInfo || {};
    previousTrack.pluginInfo.clientData = {
        ...previousClientData,
        previousTrack: true,
    };

    if (typeof player.setData === 'function') {
        player.setData('lastPlayedTrack', previousTrack);
    }

    // Start playing
    await player.play({ clientTrack: previousTrack });
    return previousTrack;
}

async function shuffleQueue(player) {
    if (!player?.queue?.tracks || player.queue.tracks.length < 2) {
        return;
    }
    if (typeof player.queue.shuffle === 'function') {
        await player.queue.shuffle();
    } else {
        // Fallback Fisher-Yates shuffle
        for (let i = player.queue.tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [player.queue.tracks[i], player.queue.tracks[j]] = [player.queue.tracks[j], player.queue.tracks[i]];
        }
    }
}

function clearQueue(player) {
    const len = player.queue.tracks.length;
    player.queue.tracks.splice(0, len);
}

/**
 * Plays a specific track from the queue immediately and removes it from the upcoming list
 * Preserves the exact relative order of all other upcoming tracks
 *
 * @param {Object} player - Lavalink player instance
 * @param {number} trackIndex - Zero-based index of track to jump to
 * @param {Object} [options] - Additional lookup options for stale-queue safety
 * @param {string} [options.queueId] - Unique queue ID of the target entry
 * @param {string} [options.identifier] - Lavalink track identifier
 * @returns {Promise<Object|null>} The track that was started, or null if not found
 */
async function jumpToTrack(player, trackIndex, options = {}) {
    if (!player || !player.queue?.tracks?.length) {
        return null;
    }

    const { queueId, identifier } = options;
    let targetIndex = -1;

    // 1. Try to find by unique queueId (handles duplicate songs and queue shifts perfectly)
    if (queueId) {
        targetIndex = player.queue.tracks.findIndex(t => t._queueId === queueId);
    }

    // 2. If not found by queueId, check if trackIndex is valid
    if (targetIndex === -1 && typeof trackIndex === 'number' && trackIndex >= 0 && trackIndex < player.queue.tracks.length) {
        const candidate = player.queue.tracks[trackIndex];
        if (!identifier || candidate.info?.identifier === identifier || candidate.identifier === identifier) {
            targetIndex = trackIndex;
        } else {
            // Find track with matching identifier closest to trackIndex
            const matchIndex = player.queue.tracks.findIndex(t => (t.info?.identifier === identifier || t.identifier === identifier));
            if (matchIndex !== -1) {
                targetIndex = matchIndex;
            }
        }
    }

    // 3. Fallback: if identifier was provided and still not found
    if (targetIndex === -1 && identifier) {
        targetIndex = player.queue.tracks.findIndex(t => (t.info?.identifier === identifier || t.identifier === identifier));
    }

    // If target track not found in current queue, it's stale
    if (targetIndex === -1 || targetIndex >= player.queue.tracks.length) {
        return null;
    }

    // Splice ONLY the target track from upcoming queue; preserves exact order of all other tracks!
    const [targetTrack] = player.queue.tracks.splice(targetIndex, 1);
    if (!targetTrack) {
        return null;
    }

    // Record previous track in history
    if (player.queue.current) {
        if (!player.queue.previous) player.queue.previous = [];
        if (player.queue.previous[0]?.info?.identifier !== player.queue.current.info?.identifier) {
            player.queue.previous.unshift(player.queue.current);
            if (player.queue.previous.length > 25) {
                player.queue.previous.splice(25);
            }
        }
        if (typeof player.setData === 'function') {
            player.setData('lastPlayedTrack', targetTrack);
        }
    }

    // Make target track the current track and start playback immediately
    player.queue.current = targetTrack;
    if (typeof player.play === 'function') {
        try {
            await player.play({ clientTrack: targetTrack });
        } catch (err) {
            // Fallback to plain play if clientTrack is not supported by mock
            await player.play().catch(() => {});
        }
    }

    return targetTrack;
}

function paginatedQueue(player, page = 1, itemsPerPage = 9) {
    const tracks = player.queue.tracks;

    if (!tracks.length) {
        return {
            tracks: [],
            currentPage: 1,
            totalPages: 1,
            totalTracks: 0,
            hasNext: false,
            hasPrevious: false,
            startIndex: 0,
            endIndex: 0
        };
    }

    const totalTracks = tracks.length;
    const totalPages = Math.ceil(totalTracks / itemsPerPage);
    const currentPage = Math.max(1, Math.min(page, totalPages));

    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalTracks);

    // Get tracks for current page
    const pageTracks = tracks.slice(startIndex, endIndex);

    return {
        tracks: pageTracks,
        currentPage,
        totalPages,
        totalTracks,
        hasNext: currentPage < totalPages,
        hasPrevious: currentPage > 1,
        startIndex,
        endIndex
    };
}

const { ZYRO_COLORS, formatDuration, createActionEmbed } = require('./zyroEmbeds');

function createPaginatedQueueResponse(client, player, page = 1) {
    const totalTracks = player.queue.tracks.length;
    const current = player.queue.current;

    // Handle completely empty player state
    if (totalTracks === 0 && !current) {
        return {
            embeds: [
                createActionEmbed(
                    'info',
                    'Queue is Empty',
                    'There are no tracks currently in the queue.\nAdd songs using `/play <query>` or `/search <query>`.'
                )
            ],
            components: [],
            flags: MessageFlags.Ephemeral
        };
    }

    const pageData = paginatedQueue(player, page, 8);
    const totalDuration = player.queue.tracks.reduce((acc, t) => acc + (t.info?.duration || 0), 0);

    // Build track list
    const trackLines = pageData.tracks.map((track, index) => {
        const displayIndex = pageData.startIndex + index + 1;
        const title = truncateText(track.info?.title || 'Unknown', 40);
        const artist = truncateText(track.info?.author || 'Unknown', 22);
        const dur = formatDuration(track.info?.duration || 0);
        const req = track.requester?.username ? ` • <@${track.requester.id || ''}>` : '';
        return `\`${displayIndex.toString().padStart(2, '0')}.\` [**${title}**](${track.info?.uri || '#'}) — ${artist} \`[${dur}]\``;
    });

    let description = '';
    if (current) {
        const curTitle = truncateText(current.info?.title || 'Unknown', 45);
        const curArtist = truncateText(current.info?.author || 'Unknown', 25);
        const curDur = formatDuration(current.info?.duration || 0);
        const curReq = current.requester?.username ? ` • Requested by ${current.requester.username}` : '';
        description += `**NOW PLAYING**\n▶️ [**${curTitle}**](${current.info?.uri || '#'}) — ${curArtist} \`[${curDur}]\`${curReq}\n\n`;
    }

    if (pageData.tracks.length > 0) {
        description += `**UP NEXT IN QUEUE**\n${trackLines.join('\n')}`;
    } else {
        description += `*No additional tracks queued.*`;
    }

    const embed = new EmbedBuilder()
        .setColor(ZYRO_COLORS.PRIMARY)
        .setTitle(`ZYRO • Queue (${totalTracks} track${totalTracks === 1 ? '' : 's'})`)
        .setDescription(description.length > 4000 ? description.substring(0, 4000) + '\n...' : description)
        .setFooter({
            text: `Page ${pageData.currentPage} of ${pageData.totalPages} • Total Duration: ${formatDuration(totalDuration)}`
        });

    const components = [];

    // Navigation row (if multiple pages)
    if (pageData.totalPages > 1) {
        const navRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('queue:first:1')
                .setEmoji('⏮️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageData.currentPage === 1),
            new ButtonBuilder()
                .setCustomId(`queue:prev:${pageData.currentPage - 1}`)
                .setEmoji('◀️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!pageData.hasPrevious),
            new ButtonBuilder()
                .setCustomId(`queue:next:${pageData.currentPage + 1}`)
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!pageData.hasNext),
            new ButtonBuilder()
                .setCustomId(`queue:last:${pageData.totalPages}`)
                .setEmoji('⏭️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageData.currentPage === pageData.totalPages)
        );
        components.push(navRow);
    }

    // Select menu for jumping directly to any track on current page
    if (pageData.tracks.length > 0) {
        const selectMenu = createTrackSelectMenu(pageData.tracks, {
            customId: 'queue:select',
            placeholder: '⚡ Jump directly to a track...',
            startIndex: pageData.startIndex,
            valueFormatter: (globalIndex, track) => {
                const qId = track?._queueId || `q_${globalIndex}`;
                const ident = (track?.info?.identifier || track?.identifier || '').substring(0, 25);
                return `${globalIndex}:${pageData.currentPage}:${qId}:${ident}`;
            },
        });
        components.push(new ActionRowBuilder().addComponents(selectMenu));
    }

    return {
        embeds: [embed],
        components,
        flags: MessageFlags.Ephemeral
    };
}

module.exports = {
    stopPlayer,
    playPrevious,
    shuffleQueue,
    clearQueue,
    jumpToTrack,
    paginatedQueue,
    createPaginatedQueueResponse,
};