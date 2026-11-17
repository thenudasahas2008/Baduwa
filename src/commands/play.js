const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const { ensureDeferred, isLavalinkAvailable, handleLavalinkError, safeReply } = require('../utils/interactionHelpers');
const { validatePlaybackQuery } = require('../utils/queryGuard');
const { getValidVolume } = require('../utils/volumeValidator');
const { classifyInput, SUPPORTED_TYPES } = require('../utils/urlClassifier');
const { searchMusic, isUrl, CONFIDENCE_LEVELS, cleanQueryString } = require('../utils/searchEngine');
const searchSessions = require('../utils/searchSessions');
const { createActionEmbed, COLORS, ICONS } = require('../utils/zyroEmbeds');
const { createSearchEmbed, createSearchComponents, formatDuration } = require('../utils/embeds');
const { clearQueueEndTimeout, schedulePlayerUpdate, clearManualStop } = require('../utils/playerLifecycle');
const { clearEmptyChannelTimeout } = require('../events/voiceStateUpdate');
const { handleAutocomplete, resolveAutocompleteToken, isExpiredToken } = require('../utils/searchAutocomplete');
const logger = require('../utils/logger');

// Per-guild in-flight request tracker to coordinate rapid concurrent /play commands
// Map<guildId, { interactionId, query, timestamp, abortController, interaction, superseded, completed }>
const inFlightGuildPlayRequests = new Map();

function getQueryTypeString(classification) {
    switch (classification?.type) {
        case SUPPORTED_TYPES.YOUTUBE_TRACK: return 'YouTube URL';
        case SUPPORTED_TYPES.YOUTUBE_PLAYLIST: return 'YouTube Playlist URL';
        case SUPPORTED_TYPES.SPOTIFY_TRACK: return 'Spotify URL';
        case SUPPORTED_TYPES.SPOTIFY_ALBUM:
        case SUPPORTED_TYPES.SPOTIFY_PLAYLIST: return 'Spotify Playlist URL';
        case SUPPORTED_TYPES.UNSUPPORTED_URL: return 'Unsupported URL';
        case SUPPORTED_TYPES.TEXT_QUERY:
        default:
            return 'Text Search';
    }
}

function sanitizeQueryForLog(raw) {
    if (!raw) return 'none';
    const cleaned = cleanQueryString(raw);
    try {
        if (/^https?:\/\//i.test(cleaned)) {
            const parsed = new URL(cleaned);
            // Redact query params to prevent logging private credentials or tokens
            return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
        }
    } catch (_) {
        // Fall back to clean query
    }
    return cleaned.slice(0, 100);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Plays a song or playlist from YouTube, Spotify, or direct link.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Song title, artist, or music URL.')
                .setRequired(true)
                .setMaxLength(500)
                .setAutocomplete(true))
        .addBooleanOption(option =>
            option.setName('next')
                .setDescription('Add the song to play next in the queue.')
                .setRequired(false)),
    // Exported for deterministic testing
    _inFlightPlayRequests: inFlightGuildPlayRequests,
    async autocomplete(interaction) {
        await handleAutocomplete(interaction);
    },
    async execute(interaction) {
        const commandStartHr = interaction._receivedHr || process.hrtime.bigint();
        const commandStart = interaction._receivedAt || Date.now();
        const getElapsedMs = (startHr = commandStartHr) => Math.round(Number(process.hrtime.bigint() - startHr) / 1_000_000);

        const commandRunId = interaction._commandRunId || `cmd_${(interaction.id || Math.random().toString(36).slice(2, 8))}_${Date.now().toString(36)}`;
        interaction._commandRunId = commandRunId;

        const logStage = (stage, outcome, detail = '') => {
            const elapsed = getElapsedMs();
            logger.info(`[PLAY-STAGE] runId=${commandRunId} stage=${stage} outcome=${outcome} elapsedMs=${elapsed}ms${detail ? ' ' + detail : ''}`);
        };

        const { client, guild, member, options } = interaction;
        const rawQuery = options.getString('query');
        const resolvedQuery = resolveAutocompleteToken(rawQuery);
        const playNext = options.getBoolean('next') || false;
        const voiceChannel = member?.voice?.channel;
        const lang = client?.defaultLanguage || 'en';

        const query = resolvedQuery;
        const sanitizedQuery = sanitizeQueryForLog(query);
        const guildId = guild?.id || interaction.guildId;

        logStage('COMMAND_RECEIVED', 'SUCCESS', `guild=${guildId || 'DM'} query="${sanitizedQuery}"`);

        // 1. Promptly acknowledge interaction to guarantee Discord 3s SLA (idempotent, checks deferred state)
        logStage('DEFER_REPLY_START', 'START');
        const ackStartHr = process.hrtime.bigint();
        const ackResult = await ensureDeferred(interaction, { ephemeral: true });
        const ackDurationMs = interaction._ackDurationMs || ackResult.durationMs || getElapsedMs(ackStartHr);
        logStage('DEFER_REPLY_COMPLETED', ackResult?.deferred ? 'SUCCESS' : 'FAILED', `ackMs=${ackDurationMs}ms`);

        if (isExpiredToken(resolvedQuery)) {
            logStage('FINAL_RESPONSE_START', 'START', 'reason=SUGGESTION_EXPIRED');
            const resp = await safeReply(interaction, {
                embeds: [createActionEmbed(
                    'warning',
                    'Suggestion Expired',
                    'The selected song suggestion has expired. Please search again and choose from the current dropdown suggestions.'
                )],
                flags: MessageFlags.Ephemeral
            });
            logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=SUGGESTION_EXPIRED');
            return resp;
        }
        if (!query || !query.trim()) {
            logStage('FINAL_RESPONSE_START', 'START', 'reason=EMPTY_QUERY');
            const resp = await safeReply(interaction, {
                embeds: [createActionEmbed('warning', 'Empty Query', 'Please provide a valid song title, artist, or music URL to play.')],
                flags: MessageFlags.Ephemeral
            });
            logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=EMPTY_QUERY');
            return resp;
        }

        // Reject direct messages or interactions missing server context
        if (!guildId) {
            logStage('FINAL_RESPONSE_START', 'START', 'reason=DM_NOT_ALLOWED');
            const resp = await safeReply(interaction, {
                content: 'This command can only be used in a Discord server voice channel.',
                flags: MessageFlags.Ephemeral
            });
            logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=DM_NOT_ALLOWED');
            return resp;
        }

        const classification = classifyInput(query);
        const queryType = getQueryTypeString(classification);

        // 2. Fast Validation: verify voice channel, permissions, and query state immediately
        // BEFORE registering or aborting in-flight requests in the guild
        const valStartHr = process.hrtime.bigint();
        if (!voiceChannel) {
            const valDurationMs = getElapsedMs(valStartHr);
            const totalValMs = Math.max(getElapsedMs(), (ackDurationMs || 0) + valDurationMs);
            logger.info(`[PLAY-LIFECYCLE] id=${interaction.id || 'unknown'} guild=${guildId} queryType="${queryType}" query="${sanitizedQuery}" ackMs=${ackDurationMs}ms valMs=${valDurationMs}ms connectMs=n/a searchMs=n/a playMs=n/a dashMs=n/a respMs=n/a totalMs=${totalValMs}ms status=NOT_IN_VOICE playback=NONE response=DELIVERED failure="User not in voice channel"`);
            logStage('FINAL_RESPONSE_START', 'START', 'reason=NOT_IN_VOICE');
            const resp = await safeReply(interaction, {
                content: client.languageManager?.get?.(lang, 'NOT_IN_VOICE') || 'You must be in a voice channel to use this command.',
                flags: MessageFlags.Ephemeral
            });
            logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=NOT_IN_VOICE');
            return resp;
        }

        // Check permissions on the target voice channel
        const botMember = guild?.members?.me;
        if (botMember) {
            const permissions = voiceChannel.permissionsFor(botMember);
            if (permissions && (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak))) {
                const valDurationMs = getElapsedMs(valStartHr);
                const totalValMs = Math.max(getElapsedMs(), (ackDurationMs || 0) + valDurationMs);
                logger.info(`[PLAY-LIFECYCLE] id=${interaction.id || 'unknown'} guild=${guildId} queryType="${queryType}" query="${sanitizedQuery}" ackMs=${ackDurationMs}ms valMs=${valDurationMs}ms connectMs=n/a searchMs=n/a playMs=n/a dashMs=n/a respMs=n/a totalMs=${totalValMs}ms status=MISSING_PERMISSIONS playback=NONE response=DELIVERED failure="Missing Connect or Speak permissions"`);
                const permEmbed = createActionEmbed({
                    title: '🔒 Missing Permissions',
                    description: `Baduwa requires **Connect** and **Speak** permissions in <#${voiceChannel.id}> to play music.`,
                    color: COLORS.ERROR,
                });
                logStage('FINAL_RESPONSE_START', 'START', 'reason=MISSING_PERMISSIONS');
                const resp = await safeReply(interaction, {
                    embeds: [permEmbed],
                    flags: MessageFlags.Ephemeral
                });
                logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=MISSING_PERMISSIONS');
                return resp;
            }
        }

        const querySafety = await validatePlaybackQuery(query);
        if (!querySafety.allowed) {
            const valDurationMs = getElapsedMs(valStartHr);
            const totalValMs = Math.max(getElapsedMs(), (ackDurationMs || 0) + valDurationMs);
            logStage('FINAL_RESPONSE_START', 'START', 'reason=QUERY_BLOCKED');
            const respStart = Date.now();
            const resp = await safeReply(interaction, {
                content: client.languageManager?.get?.(lang, 'QUERY_NOT_ALLOWED') || 'This playback query is not allowed.',
                flags: MessageFlags.Ephemeral
            });
            const respMs = Date.now() - respStart;
            const respStatus = resp ? 'DELIVERED' : 'FAILED';
            if (!resp) {
                const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="QUERY_BLOCKED" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
            }
            logger.info(`[PLAY-LIFECYCLE] id=${interaction.id || 'unknown'} guild=${guildId} queryType="${queryType}" query="${sanitizedQuery}" ackMs=${ackDurationMs}ms valMs=${valDurationMs}ms connectMs=n/a searchMs=n/a playMs=n/a dashMs=n/a respMs=${respMs}ms totalMs=${totalValMs + respMs}ms status=QUERY_BLOCKED playback=NONE response=${respStatus} failure="${querySafety.reason || 'Query blocked by queryGuard'}"`);
            logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=QUERY_BLOCKED');
            return resp;
        }

        // Check if Lavalink is available
        if (!isLavalinkAvailable(client)) {
            const valDurationMs = getElapsedMs(valStartHr);
            const totalValMs = Math.max(getElapsedMs(), (ackDurationMs || 0) + valDurationMs);
            logStage('FINAL_RESPONSE_START', 'START', 'reason=LAVALINK_UNAVAILABLE');
            const respStart = Date.now();
            const resp = await safeReply(interaction, {
                embeds: [createActionEmbed('warning', 'Music Service Reconnecting', 'Music service is reconnecting; please try again shortly.')],
                flags: MessageFlags.Ephemeral
            });
            const respMs = Date.now() - respStart;
            const respStatus = resp ? 'DELIVERED' : 'FAILED';
            if (!resp) {
                const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="LAVALINK_UNAVAILABLE" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
            }
            logger.info(`[PLAY-LIFECYCLE] id=${interaction.id || 'unknown'} guild=${guildId} queryType="${queryType}" query="${sanitizedQuery}" ackMs=${ackDurationMs}ms valMs=${valDurationMs}ms connectMs=n/a searchMs=n/a playMs=n/a dashMs=n/a respMs=${respMs}ms totalMs=${totalValMs + respMs}ms status=LAVALINK_UNAVAILABLE playback=NONE response=${respStatus} failure="Music service reconnecting"`);
            logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=LAVALINK_UNAVAILABLE');
            return resp;
        }

        const validationDurationMs = getElapsedMs(valStartHr);

        // 3. Coordinate concurrent requests per guild: safely supersede earlier in-flight searches
        const prevRequest = inFlightGuildPlayRequests.get(guildId);
        if (prevRequest && !prevRequest.completed) {
            logger.info(`[PLAY-LIFECYCLE] Newer /play command (${interaction.id}) supersedes earlier in-flight command (${prevRequest.interactionId}) in guild ${guildId}`);
            prevRequest.superseded = true;
            try {
                prevRequest.abortController?.abort();
            } catch (_) {}

            // Promptly finalize earlier interaction with deliberate response so it NEVER remains on "Thinking..."
            safeReply(prevRequest.interaction, {
                embeds: [createActionEmbed(
                    'info',
                    'Search Superseded',
                    `This search was replaced by your newer request for **"${cleanQueryString(query).slice(0, 60)}"**.`
                )],
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
        }

        const abortController = interaction._abortController || new AbortController();
        interaction._abortController = abortController;
        const activeRequest = {
            interactionId: interaction.id,
            guildId,
            query,
            startTime: commandStart,
            abortController,
            interaction,
            superseded: false,
            completed: false,
        };
        inFlightGuildPlayRequests.set(guildId, activeRequest);

        // Granular correlation record scoped by interaction ID (null for non-executed phases)
        const lifecycle = {
            interactionId: interaction.id || 'unknown',
            guildId: guild?.id || 'DM',
            queryType,
            sanitizedQuery,
            ackDurationMs,
            validationDurationMs,
            connectDurationMs: null,
            searchDurationMs: null,
            playDurationMs: null,
            dashboardDurationMs: null,
            responseDeliveryDurationMs: null,
            totalDurationMs: 0,
            searchOutcome: 'PENDING',
            trackResolution: 'PENDING',
            playbackStatus: 'NONE',
            responseStatus: 'PENDING',
            status: 'PENDING',
            failureReason: null,
        };

        try {
            const chName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const gName = guild?.name || guild?.id || 'unknown-guild';
            const uTag = member?.user?.tag || member?.user?.id || 'unknown-user';
            logger.cmd(`/play "${query}" by ${uTag} in #${chName} (Guild: ${gName})`);

            // Clear any lingering empty-channel or queue-end disconnect timers for this guild
            clearEmptyChannelTimeout(guildId);
            clearQueueEndTimeout(guildId);

            const activeNode = client.lavalinkConnectionManager?.getActiveNode?.()
                || client.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                || (client.lavalink?.nodeManager?.nodes ? Array.from(client.lavalink.nodeManager.nodes.values())[0] : null);

            let player = client.lavalink.getPlayer(guildId);
            const isNewPlayer = !player;

            if (!player) {
                player = client.lavalink.createPlayer({
                    guildId,
                    voiceChannelId: voiceChannel.id,
                    textChannelId: interaction.channel?.id || voiceChannel.id,
                    selfDeaf: true,
                    selfMute: false,
                    volume: getValidVolume(process.env.DEFAULT_VOLUME, 80),
                    instaUpdateFiltersFix: false,
                    applyVolumeAsFilter: false,
                    node: activeNode?.id || undefined,
                });
            } else {
                // If bot is active in a different voice channel, require user to be in the same channel
                const botVoiceChannelId = guild.members?.me?.voice?.channelId;
                if (botVoiceChannelId && botVoiceChannelId !== voiceChannel.id) {
                    lifecycle.status = 'DIFFERENT_VOICE_CHANNEL';
                    lifecycle.failureReason = 'User in different voice channel than bot';
                    logStage('FINAL_RESPONSE_START', 'START', 'reason=DIFFERENT_VOICE_CHANNEL');
                    const respStart = Date.now();
                    const resp = await safeReply(interaction, {
                        content: client.languageManager.get(lang, 'ERROR_SAME_VOICE_CHANNEL'),
                        flags: MessageFlags.Ephemeral
                    });
                    const respMs = Date.now() - respStart;
                    lifecycle.responseDeliveryDurationMs = respMs;
                    lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                    if (!resp) {
                        const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                        logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="DIFFERENT_VOICE_CHANNEL" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                    }
                    logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=DIFFERENT_VOICE_CHANNEL');
                    return resp;
                }
                // Keep player voice and text channel references synchronized
                player.voiceChannelId = voiceChannel.id;
                player.textChannelId = interaction.channel?.id || voiceChannel.id;
            }
            player.client = client;

            if (client.autoplayEnabled) {
                const guildSettings = require('../utils/guildSettings');
                const savedSetting = guildSettings.get(guildId)?.autoplay;
                const isAuto = typeof savedSetting === 'boolean' ? savedSetting : true;
                client.autoplayEnabled.set(guildId, isAuto);
                if (typeof savedSetting !== 'boolean') {
                    guildSettings.setAutoplay(guildId, true);
                }
            }

            // Always ensure player is attached to activeNode if current node is disconnected
            if (activeNode && activeNode.connected && (!player.node || !player.node.connected)) {
                logger.info(`[PLAY] Synchronizing player node for guild ${guildId} from ${player.node?.id || 'none'} to active node ${activeNode.id}`);
                if (typeof player.changeNode === 'function') {
                    await player.changeNode(activeNode, false).catch((err) => {
                        logger.debug(`player.changeNode error:`, err?.message || err);
                        player.node = activeNode;
                    });
                } else {
                    player.node = activeNode;
                }
            }

            logStage('PLAYER_NODE_SELECTED', player ? 'SUCCESS' : 'FAILED', `node=${player?.node?.id || activeNode?.id || 'none'} isNew=${isNewPlayer}`);

            // 4. Connect to voice and search concurrently to eliminate connection wait time from query resolution
            const connectStart = Date.now();
            let voiceConnectError = null;
            const connectPromise = (async () => {
                try {
                    if (!player.connected) {
                        logStage('VOICE_CONNECTION_REQUESTED', 'START', `channel=${voiceChannel.id}`);
                        await Promise.race([
                            player.connect(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Voice connection timed out after 3500ms')), 3500))
                        ]);
                    }
                    // Wait for voice state/token readiness (polling every 25ms bounded to max ~2.5s)
                    let waitCount = 0;
                    while (!player.connected && waitCount < 100) {
                        if (abortController.signal.aborted) break;
                        const voiceReady = Boolean(
                            (player.voice?.token && player.voice?.sessionId) ||
                            client.voiceHandshakeSynchronizer?.isVoiceReady(guildId)
                        );
                        const currentVoiceChannel = guild.members?.me?.voice?.channelId ||
                            client.voiceHandshakeSynchronizer?.getVoiceState(guildId)?.channelId ||
                            player.voiceChannelId;
                        if (player.connected || (voiceReady && currentVoiceChannel)) {
                            break;
                        }
                        await new Promise(resolve => setTimeout(resolve, 25));
                        waitCount++;
                    }

                    const meVoiceChannel = guild.members?.me?.voice?.channelId ||
                        client.voiceHandshakeSynchronizer?.getVoiceState(guildId)?.channelId ||
                        player.voiceChannelId;
                    const hasVoiceCreds = Boolean(
                        player.connected ||
                        (player.voice?.token && player.voice?.sessionId) ||
                        client.voiceHandshakeSynchronizer?.isVoiceReady(guildId)
                    );

                    const meVoice = guild.members?.me?.voice;
                    if (meVoice?.serverMute || meVoice?.suppress) {
                        logger.warn(`[VOICE-DIAG] Bot is server-muted or suppressed in guild ${guildId} channel ${meVoice.channelId}`);
                    }

                    if ((!meVoiceChannel || !hasVoiceCreds) && !player.connected) {
                        voiceConnectError = new Error('Voice connection could not be established');
                        logStage('VOICE_HANDSHAKE_COMPLETED', 'FAILED', `error="${voiceConnectError.message}"`);
                    } else {
                        logStage('VOICE_HANDSHAKE_COMPLETED', 'SUCCESS', `connected=${Boolean(player.connected)} ready=${hasVoiceCreds}`);
                    }
                } catch (err) {
                    voiceConnectError = err;
                    logStage('VOICE_HANDSHAKE_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                    logger.warn(`Voice connection attempt failed for guild ${guildId}:`, err?.message || err);
                } finally {
                    lifecycle.connectDurationMs = Date.now() - connectStart;
                }
            })();

            // Search with intelligent fallback (ytmsearch -> ytsearch) and relevance ranking (bounded to 12s)
            logStage('SEARCH_STARTED', 'START', `query="${sanitizedQuery}"`);
            const searchStart = Date.now();
            const searchPromise = Promise.race([
                searchMusic(player, query, interaction.user, { signal: abortController.signal }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Audio search timed out after 12000ms')), 12000))
            ]).then((res) => {
                lifecycle.searchDurationMs = Date.now() - searchStart;
                const outcome = res?.tracks?.length ? 'SUCCESS' : (res?.isBusy ? 'BUSY' : (res?.isUnsupportedUrl ? 'UNSUPPORTED' : 'NO_RESULTS'));
                logStage('SEARCH_COMPLETED', outcome, `count=${res?.tracks?.length || 0} loadType="${res?.loadType || 'none'}"`);
                return res;
            }).catch((err) => {
                lifecycle.searchDurationMs = Date.now() - searchStart;
                logStage('SEARCH_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                if (err?.name === 'AbortError' || err?.message?.includes('cancelled')) {
                    return { loadType: 'error', exception: { message: 'Audio search cancelled' }, tracks: [], cancelled: true };
                }
                logger.warn(`Search attempt timed out or failed for "${query}":`, err?.message || err);
                return { loadType: 'error', exception: { message: 'Audio search timed out' }, tracks: [] };
            });

            const [_, res] = await Promise.all([connectPromise, searchPromise]);

            if (abortController.signal.aborted || interaction._timedOut) {
                lifecycle.status = 'TIMED_OUT';
                lifecycle.failureReason = 'Command timed out';
                activeRequest.completed = true;
                if (inFlightGuildPlayRequests.get(guildId)?.interactionId === interaction.id) {
                    inFlightGuildPlayRequests.delete(guildId);
                }
                if (interaction.deferred && !interaction.replied && !interaction._tokenExpired) {
                    logStage('FINAL_RESPONSE_START', 'START', 'reason=TIMED_OUT');
                    const respStart = Date.now();
                    const resp = await safeReply(interaction, {
                        embeds: [createActionEmbed('warning', 'Command Timed Out', 'The request took too long to complete. Please try again.')],
                        flags: MessageFlags.Ephemeral,
                        _isTimeoutReply: true,
                    }).catch(() => {});
                    const respMs = Date.now() - respStart;
                    lifecycle.responseDeliveryDurationMs = respMs;
                    lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                    if (!resp) {
                        const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                        logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="TIMED_OUT" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                    }
                    logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=TIMED_OUT');
                }
                return;
            }

            // 5. Check if this request was superseded while search was in flight
            if (activeRequest.superseded || inFlightGuildPlayRequests.get(guildId)?.interactionId !== interaction.id) {
                lifecycle.status = 'SUPERSEDED';
                lifecycle.failureReason = 'Request superseded by newer /play command during resolution';
                logger.info(`[PLAY-LIFECYCLE] In-flight /play request ${interaction.id} for guild ${guildId} was superseded. Aborting playback mutation.`);
                logStage('FINAL_RESPONSE_START', 'START', 'reason=SUPERSEDED');
                const respStart = Date.now();
                const resp = await safeReply(interaction, {
                    embeds: [createActionEmbed(
                        'info',
                        'Search Superseded',
                        'This search was replaced by a newer request.'
                    )],
                    flags: MessageFlags.Ephemeral
                }).catch(() => {});
                const respMs = Date.now() - respStart;
                lifecycle.responseDeliveryDurationMs = respMs;
                lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                if (!resp) {
                    const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                    logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="SUPERSEDED" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                }
                logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=SUPERSEDED');
                return;
            }

            const wasPlaying = Boolean(player.playing && player.queue?.current);
            const botVoiceChannelId = guild.members?.me?.voice?.channelId ||
                client.voiceHandshakeSynchronizer?.getVoiceState(guildId)?.channelId ||
                player.voiceChannelId;
            const inVoiceChannel = Boolean(botVoiceChannelId);
            const voiceCredentialsValid = Boolean(
                player.connected ||
                (player.voice?.token && player.voice?.sessionId) ||
                client.voiceHandshakeSynchronizer?.isVoiceReady(guildId)
            );

            if ((!inVoiceChannel || !voiceCredentialsValid || voiceConnectError) && !player.connected && !wasPlaying) {
                lifecycle.status = 'VOICE_CONNECT_FAILED';
                lifecycle.failureReason = voiceConnectError?.message || 'Failed to connect to voice channel';
                activeRequest.completed = true;
                if (inFlightGuildPlayRequests.get(guildId)?.interactionId === interaction.id) {
                    inFlightGuildPlayRequests.delete(guildId);
                }
                logStage('FINAL_RESPONSE_START', 'START', 'reason=VOICE_CONNECT_FAILED');
                const respStart = Date.now();
                const resp = await safeReply(interaction, {
                    embeds: [createActionEmbed(
                        'error',
                        'Voice Connection Failed',
                        'Baduwa could not connect to your voice channel. Please verify that Baduwa has permissions to Connect and Speak in your channel, and that Discord voice servers are responsive.'
                    )],
                    flags: MessageFlags.Ephemeral
                });
                const respMs = Date.now() - respStart;
                lifecycle.responseDeliveryDurationMs = respMs;
                lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                if (!resp) {
                    const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                    logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="VOICE_CONNECT_FAILED" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                }
                logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=VOICE_CONNECT_FAILED');
                return resp;
            }

            logger.info(`[LIFECYCLE-DIAG] [TRACK_RESOLVED] id=${interaction.id || 'unknown'} query="${(query || '').slice(0, 50)}" tracks=${res?.tracks?.length || 0} loadType="${res?.loadType || 'none'}" durationMs=${lifecycle.searchDurationMs}ms`);

            if (res?.isBusy) {
                lifecycle.status = 'SERVER_BUSY';
                lifecycle.failureReason = res.exception?.message || 'Search queue capacity reached';
                const busyEmbed = createActionEmbed({
                    title: '⏳ Service Busy',
                    description: 'The music search queue is currently handling high volume. Please try again in a few moments.',
                    color: COLORS.WARNING,
                });
                logStage('FINAL_RESPONSE_START', 'START', 'reason=SERVER_BUSY');
                const respStart = Date.now();
                const resp = await safeReply(interaction, { embeds: [busyEmbed], flags: MessageFlags.Ephemeral });
                const respMs = Date.now() - respStart;
                lifecycle.responseDeliveryDurationMs = respMs;
                lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                if (!resp) {
                    const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                    logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="SERVER_BUSY" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                }
                logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=SERVER_BUSY');
                return resp;
            }

            if (res?.isUnsupportedUrl) {
                lifecycle.status = 'UNSUPPORTED_URL';
                lifecycle.failureReason = res.exception?.message || 'Unsupported link format';
                const unsupportedEmbed = createActionEmbed({
                    title: '⚠️ Unsupported Link',
                    description: `${res.exception?.message || 'Unsupported link format provided.'}\n\n*Supported link formats:*\n• **YouTube**: \`https://www.youtube.com/watch?v=...\` or \`https://youtu.be/...\`\n• **YouTube Music**: \`https://music.youtube.com/watch?v=...\`\n• **YouTube Playlist**: \`https://www.youtube.com/playlist?list=...\`\n• **Spotify**: Track, Album, or Playlist links`,
                    color: COLORS.ERROR,
                });
                logStage('FINAL_RESPONSE_START', 'START', 'reason=UNSUPPORTED_URL');
                const respStart = Date.now();
                const resp = await safeReply(interaction, { embeds: [unsupportedEmbed], flags: MessageFlags.Ephemeral });
                const respMs = Date.now() - respStart;
                lifecycle.responseDeliveryDurationMs = respMs;
                lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                if (!resp) {
                    const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                    logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="UNSUPPORTED_URL" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                }
                logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=UNSUPPORTED_URL');
                return resp;
            }

            if (!res || !res.tracks || !res.tracks.length) {
                lifecycle.status = 'NO_RESULTS';
                lifecycle.failureReason = res?.exception?.message || 'No matching tracks found';
                const noResultEmbed = createActionEmbed({
                    title: '🔍 No Matching Tracks Found',
                    description: res?.exception?.message && res.exception.message !== 'Search failed'
                        ? `${res.exception.message}.\n\n*Query:* **"${cleanQueryString(query)}"**`
                        : `Could not find any playable audio for **"${cleanQueryString(query)}"**.\n\n*Suggestions:*\n• Check for spelling typos\n• Include the artist name (e.g. \`Artist - Title\`)\n• Paste a direct YouTube or Spotify URL`,
                    color: COLORS.WARNING,
                });
                logStage('FINAL_RESPONSE_START', 'START', 'reason=NO_RESULTS');
                const respStart = Date.now();
                const resp = await safeReply(interaction, { embeds: [noResultEmbed], flags: MessageFlags.Ephemeral });
                const respMs = Date.now() - respStart;
                lifecycle.responseDeliveryDurationMs = respMs;
                lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                if (!resp) {
                    const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                    logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="NO_RESULTS" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                }
                logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=NO_RESULTS');
                return resp;
            }

            // Re-verify current live player state before applying changes
            player = client.lavalink.getPlayer(guildId) || player;

            // Clear manual stop state so subsequent playback runs normally
            clearManualStop(guildId);
            if (typeof player.setData === 'function') {
                player.setData('internal_stopPlaying', void 0);
                player.setData('internal_autoplayStopPlaying', void 0);
                player.setData('manual_stop_generation', void 0);
            }

            if (res.loadType === 'playlist') {
                const playlistTitle = res.playlist?.title || res.playlist?.name || 'Playlist';
                logStage('SEARCH_RESULTS_SELECTED', 'SUCCESS', `type=playlist count=${res.tracks.length} title="${playlistTitle}"`);
                if (typeof player.setData === 'function') {
                    player.setData('playlistSession', { isPlaylist: true, count: res.tracks.length });
                }
                for (const track of res.tracks) {
                    track.requester = track.requester ? { ...track.requester, ...interaction.user } : interaction.user;
                    if (!track.userData) track.userData = {};
                    track.userData.query = query;
                    track.userData.guildId = guildId;
                    track.userData.requestedBy = interaction.user.id;
                    track.userData.requestedAt = Date.now();
                    track.userData.interactionId = interaction.id;
                    track.userData.commandRunId = commandRunId;
                }
                const firstTrack = res.tracks[0];
                const playStart = Date.now();
                let playError = null;

                logStage('TRACK_LOAD_REQUESTED', 'START', `count=${res.tracks.length}`);
                if (playNext) {
                    if (wasPlaying) {
                        await player.queue.add(res.tracks, 0);
                        logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `queueLength=${player.queue?.tracks?.length || 0}`);
                    } else {
                        if (player.queue) player.queue.current = null;
                        await player.queue.add(res.tracks, 0);
                        logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `queueLength=${player.queue?.tracks?.length || 0}`);
                        logStage('PLAYBACK_REQUEST_START', 'START', `type=playlist title="${firstTrack?.info?.title || playlistTitle}"`);
                        try {
                            await Promise.race([
                                player.play(),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Player.play timed out after 3500ms')), 3500))
                            ]);
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `type=playlist title="${firstTrack?.info?.title || playlistTitle}"`);
                        } catch (err) {
                            playError = err;
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                            logger.warn(`player.play timed out or failed:`, err?.message || err);
                        }
                    }
                } else if (wasPlaying) {
                    // When music is already playing: switch immediately to the playlist!
                    if (player.queue) {
                        if (!Array.isArray(player.queue.previous)) player.queue.previous = [];
                        if (player.queue.current) {
                            player.queue.previous.unshift(player.queue.current);
                            if (player.queue.previous.length > 25) {
                                player.queue.previous.splice(25);
                            }
                        }
                        player.queue.current = firstTrack;
                    }
                    if (res.tracks.length > 1) {
                        await player.queue.add(res.tracks.slice(1), 0);
                    }
                    logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `queueLength=${player.queue?.tracks?.length || 0}`);
                    logStage('PLAYBACK_REQUEST_START', 'START', `type=playlist title="${firstTrack?.info?.title || playlistTitle}"`);
                    try {
                        await Promise.race([
                            player.play({ clientTrack: firstTrack }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Player.play timed out after 3500ms')), 3500))
                        ]);
                        logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `type=playlist title="${firstTrack?.info?.title || playlistTitle}"`);
                    } catch (err) {
                        try {
                            await player.play();
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `type=playlist title="${firstTrack?.info?.title || playlistTitle}"`);
                        } catch (err2) {
                            playError = err;
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                            logger.warn(`player.play timed out or failed:`, err?.message || err);
                        }
                    }
                } else {
                    if (typeof player.setData === 'function') {
                        player.setData('internal_stopPlaying', void 0);
                        player.setData('internal_autoplayStopPlaying', void 0);
                    }
                    if (player.queue) player.queue.current = null;
                    await player.queue.add(res.tracks);
                    logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `queueLength=${player.queue?.tracks?.length || 0}`);
                    logStage('PLAYBACK_REQUEST_START', 'START', `type=playlist title="${firstTrack?.info?.title || playlistTitle}"`);
                    try {
                        await Promise.race([
                            player.play(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Player.play timed out after 3500ms')), 3500))
                        ]);
                        logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `type=playlist title="${firstTrack?.info?.title || playlistTitle}"`);
                    } catch (err) {
                        playError = err;
                        logStage('PLAYBACK_REQUEST_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                        logger.warn(`player.play timed out or failed:`, err?.message || err);
                    }
                }

                lifecycle.playDurationMs = Date.now() - playStart;
                logger.info(`[LIFECYCLE-DIAG] [PLAYBACK_STARTED] id=${interaction.id || 'unknown'} track="${firstTrack?.info?.title || 'Playlist'}" isPlaylist=true durationMs=${Date.now() - commandStart}ms`);

                const playlistUri = res.playlist?.uri;
                const playlistLink = playlistUri ? `[${playlistTitle}](${playlistUri})` : playlistTitle;

                let embedTitle = '🎶 Playlist Added to Queue';
                if (playNext) {
                    embedTitle = '🎶 Playlist Added to Play Next';
                } else if (wasPlaying) {
                    embedTitle = '🎶 Playlist Added to Queue';
                } else {
                    embedTitle = '🎵 Playlist Started';
                }

                const confirmationEmbed = createActionEmbed({
                    title: embedTitle,
                    description: `**${playlistLink}**`,
                    fields: [
                        { name: '🎵 Tracks Added', value: `\`${res.tracks.length}\` songs`, inline: true },
                        { name: '⏱️ Total Duration', value: `\`${formatDuration(res.playlist?.duration || 0)}\``, inline: true },
                        { name: `${ICONS.USER} Added by`, value: `<@${interaction.user.id}>`, inline: true },
                    ],
                    thumbnail: res.playlist?.thumbnail || res.tracks[0]?.info?.artworkUrl || null,
                    color: COLORS.PRIMARY,
                });

                lifecycle.searchOutcome = 'FOUND';
                lifecycle.trackResolution = 'RESOLVED';
                lifecycle.playbackStatus = (playNext || wasPlaying) ? 'QUEUED' : 'STARTED';

                logStage('FINAL_RESPONSE_START', 'START', `type=playlist wasPlaying=${wasPlaying} playNext=${playNext}`);
                const respStartHr = process.hrtime.bigint();
                const replyResult = await safeReply(interaction, {
                    embeds: [confirmationEmbed],
                    flags: MessageFlags.Ephemeral,
                    _isFinalReply: true
                });
                lifecycle.responseDeliveryDurationMs = getElapsedMs(respStartHr);

                if (replyResult) {
                    lifecycle.responseStatus = 'DELIVERED';
                    lifecycle.status = 'SUCCESS';
                    logStage('FINAL_RESPONSE_COMPLETED', 'SUCCESS', `type=playlist count=${res.tracks.length}`);
                } else {
                    lifecycle.responseStatus = 'FAILED';
                    lifecycle.status = 'PLAYBACK_SUCCESS_RESPONSE_FAILED';
                    lifecycle.failureReason = interaction._restError?.message || 'Interaction response delivery failed';
                    logStage('FINAL_RESPONSE_COMPLETED', 'FAILED', `error="${lifecycle.failureReason}"`);
                }
            } else {
                const isDirectUrl = isUrl(query);
                const isAmbiguous = !isDirectUrl && res.confidence === CONFIDENCE_LEVELS.MEDIUM;
                const isUnreliable = !isDirectUrl && (res.confidence === CONFIDENCE_LEVELS.LOW || (typeof res.topScore === 'number' && res.topScore <= 0) || !res.tracks.length);

                if (isUnreliable) {
                    lifecycle.status = 'LOW_CONFIDENCE';
                    lifecycle.failureReason = 'Search results did not meet confidence threshold';
                    const noReliableMatchEmbed = createActionEmbed({
                        title: '🔍 No Reliable Match Found',
                        description: `I couldn't find a reliable match for **"${cleanQueryString(query)}"**.\n\n*Suggestions:*\n• Include the artist name (e.g. \`Artist - Song Title\`)\n• Check for spelling typos\n• Paste a direct YouTube or Spotify link`,
                        color: COLORS.WARNING,
                    });
                    logStage('FINAL_RESPONSE_START', 'START', 'reason=LOW_CONFIDENCE');
                    const resp = await safeReply(interaction, { embeds: [noReliableMatchEmbed], flags: MessageFlags.Ephemeral });
                    logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=LOW_CONFIDENCE');
                    return resp;
                }

                if (isAmbiguous && res.tracks.length > 1) {
                    // Show ephemeral interactive result selector so user picks the exact intended song
                    const sessionId = searchSessions.createSession(
                        interaction.user.id,
                        guildId,
                        res.tracks.slice(0, 5),
                        query.trim(),
                        voiceChannel.id,
                        interaction.channel.id,
                        { playNext }
                    );

                    const pageData = searchSessions.getCurrentPageData(sessionId);
                    const embed = createSearchEmbed(client, pageData, query.trim());
                    const components = createSearchComponents(client, pageData, sessionId);

                    logger.info(`[SEARCH-DIAG] Ambiguous query "${query}" -> presented ephemeral selector with ${pageData.tracks.length} candidates (Session: ${sessionId})`);
                    lifecycle.status = 'AMBIGUOUS_SELECTOR';

                    logStage('FINAL_RESPONSE_START', 'START', `reason=AMBIGUOUS_SELECTOR count=${pageData.tracks.length}`);
                    const resp = await safeReply(interaction, {
                        embeds: [embed],
                        components,
                        flags: MessageFlags.Ephemeral
                    });
                    logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=AMBIGUOUS_SELECTOR');
                    return resp;
                }

                // Final check before modifying playback state
                if (abortController.signal.aborted || interaction._timedOut) {
                    lifecycle.status = 'TIMED_OUT';
                    lifecycle.failureReason = 'Command timed out';
                    activeRequest.completed = true;
                    if (inFlightGuildPlayRequests.get(guildId)?.interactionId === interaction.id) {
                        inFlightGuildPlayRequests.delete(guildId);
                    }
                    if (interaction.deferred && !interaction.replied && !interaction._tokenExpired) {
                        logStage('FINAL_RESPONSE_START', 'START', 'reason=TIMED_OUT');
                        const resp = await safeReply(interaction, {
                            embeds: [createActionEmbed('warning', 'Command Timed Out', 'The request took too long to complete. Please try again.')],
                            flags: MessageFlags.Ephemeral,
                            _isTimeoutReply: true,
                        }).catch(() => {});
                        logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=TIMED_OUT');
                    }
                    return;
                }

                if (activeRequest.superseded || inFlightGuildPlayRequests.get(guildId)?.interactionId !== interaction.id) {
                    lifecycle.status = 'SUPERSEDED';
                    lifecycle.failureReason = 'Superseded by newer request before playback mutation';
                    logStage('FINAL_RESPONSE_START', 'START', 'reason=SUPERSEDED');
                    const resp = await safeReply(interaction, {
                        embeds: [createActionEmbed(
                            'info',
                            'Search Superseded',
                            'This search was replaced by a newer request.'
                        )],
                        flags: MessageFlags.Ephemeral
                    }).catch(() => {});
                    logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', 'reason=SUPERSEDED');
                    activeRequest.completed = true;
                    if (inFlightGuildPlayRequests.get(guildId)?.interactionId === interaction.id) {
                        inFlightGuildPlayRequests.delete(guildId);
                    }
                    return;
                }

                if (typeof player.setData === 'function') {
                    player.setData('playlistSession', null);
                }
                const selectedTrack = res.tracks[0];
                const title = selectedTrack.info?.title || 'Unknown Title';
                const uri = selectedTrack.info?.uri;
                logStage('SEARCH_RESULTS_SELECTED', 'SUCCESS', `type=track title="${title}"`);

                selectedTrack.requester = selectedTrack.requester ? { ...selectedTrack.requester, ...interaction.user } : interaction.user;
                if (!selectedTrack.userData) selectedTrack.userData = {};
                selectedTrack.userData.query = query;
                selectedTrack.userData.guildId = guildId;
                selectedTrack.userData.requestedBy = interaction.user.id;
                selectedTrack.userData.requestedAt = Date.now();
                selectedTrack.userData.interactionId = interaction.id;
                selectedTrack.userData.commandRunId = commandRunId;
                const playStart = Date.now();
                let playError = null;

                logStage('TRACK_LOAD_REQUESTED', 'START', `title="${title}" playNext=${playNext}`);
                if (playNext) {
                    // Insert at position 0 without interrupting current playback
                    if (wasPlaying) {
                        await player.queue.add(selectedTrack, 0);
                        logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `queueLength=${player.queue?.tracks?.length || 0}`);
                    } else {
                        if (player.queue) player.queue.current = null;
                        await player.queue.add(selectedTrack, 0);
                        logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `queueLength=${player.queue?.tracks?.length || 0}`);
                        logStage('PLAYBACK_REQUEST_START', 'START', `title="${title}"`);
                        try {
                            await Promise.race([
                                player.play(),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Player.play timed out after 3500ms')), 3500))
                            ]);
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `title="${title}"`);
                        } catch (err) {
                            playError = err;
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                            logger.warn(`player.play timed out or failed in guild ${guildId}:`, err?.message || err);
                        }
                    }
                } else if (wasPlaying) {
                    // Switch to new track immediately: stop current track, move to previous history, and play new track!
                    if (player.queue) {
                        if (!Array.isArray(player.queue.previous)) player.queue.previous = [];
                        if (player.queue.current) {
                            player.queue.previous.unshift(player.queue.current);
                            if (player.queue.previous.length > 25) {
                                player.queue.previous.splice(25);
                            }
                        }
                        player.queue.current = selectedTrack;
                    }
                    logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `current="${title}"`);
                    logStage('PLAYBACK_REQUEST_START', 'START', `title="${title}"`);
                    try {
                        await Promise.race([
                            player.play({ clientTrack: selectedTrack }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Player.play timed out after 3500ms')), 3500))
                        ]);
                        logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `title="${title}"`);
                    } catch (err) {
                        try {
                            await player.play();
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `title="${title}"`);
                        } catch (err2) {
                            playError = err;
                            logStage('PLAYBACK_REQUEST_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                            logger.warn(`player.play timed out or failed in guild ${guildId}:`, err?.message || err);
                        }
                    }
                } else {
                    if (typeof player.setData === 'function') {
                        player.setData('internal_stopPlaying', void 0);
                        player.setData('internal_autoplayStopPlaying', void 0);
                    }
                    if (player.queue) player.queue.current = null;
                    await player.queue.add(selectedTrack);
                    logStage('TRACK_LOAD_COMPLETED', 'SUCCESS', `queueLength=${player.queue?.tracks?.length || 0}`);
                    logStage('PLAYBACK_REQUEST_START', 'START', `title="${title}"`);
                    try {
                        await Promise.race([
                            player.play(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Player.play timed out after 3500ms')), 3500))
                        ]);
                        logStage('PLAYBACK_REQUEST_COMPLETED', 'SUCCESS', `title="${title}"`);
                    } catch (err) {
                        playError = err;
                        logStage('PLAYBACK_REQUEST_COMPLETED', 'FAILED', `error="${err?.message || err}"`);
                        logger.warn(`player.play timed out or failed in guild ${guildId}:`, err?.message || err);
                    }
                }

                lifecycle.playDurationMs = Date.now() - playStart;

                if (playError && !wasPlaying) {
                    lifecycle.status = 'PLAYBACK_FAILED';
                    lifecycle.failureReason = playError.message;
                    activeRequest.completed = true;
                    if (inFlightGuildPlayRequests.get(guildId)?.interactionId === interaction.id) {
                        inFlightGuildPlayRequests.delete(guildId);
                    }
                    logStage('FINAL_RESPONSE_START', 'START', `reason=PLAYBACK_FAILED error="${playError.message}"`);
                    const respStart = Date.now();
                    const resp = await safeReply(interaction, {
                        embeds: [createActionEmbed(
                            'error',
                            'Playback Failed',
                            `Could not start playback for **${title}**.\nThe audio node encountered an error: \`${playError.message}\`.`
                        )],
                        flags: MessageFlags.Ephemeral,
                        _isErrorReply: true,
                        _isFinalReply: true,
                    });
                    const respMs = Date.now() - respStart;
                    lifecycle.responseDeliveryDurationMs = respMs;
                    lifecycle.responseStatus = resp ? 'DELIVERED' : 'FAILED';
                    if (!resp) {
                        const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                        logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="PLAYBACK_FAILED" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
                    }
                    logStage('FINAL_RESPONSE_COMPLETED', resp ? 'SUCCESS' : 'FAILED', `reason=PLAYBACK_FAILED`);
                    return resp;
                }

                logger.info(`[LIFECYCLE-DIAG] [PLAYBACK_STARTED] id=${interaction.id || 'unknown'} track="${title}" uri="${uri || '#'}" wasPlaying=${wasPlaying} playNext=${playNext} durationMs=${Date.now() - commandStart}ms`);

                // Requirement 9: Do not report that a song is playing when it has only been found or queued.
                let ackText;
                if (playNext) {
                    ackText = `🎵 Queued to play next: **${title}**`;
                } else if (wasPlaying) {
                    ackText = `🎵 Started playing: **${title}**`;
                } else {
                    ackText = `🎵 Loading audio: **${title}**...`;
                }

                lifecycle.searchOutcome = 'FOUND';
                lifecycle.trackResolution = 'RESOLVED';
                lifecycle.playbackStatus = playNext ? 'QUEUED' : 'STARTED';

                logStage('FINAL_RESPONSE_START', 'START', `wasPlaying=${wasPlaying} playNext=${playNext}`);
                const respStartHr = process.hrtime.bigint();
                const replyResult = await safeReply(interaction, {
                    content: ackText,
                    flags: MessageFlags.Ephemeral,
                    _isFinalReply: true,
                });
                lifecycle.responseDeliveryDurationMs = getElapsedMs(respStartHr);

                if (replyResult) {
                    lifecycle.responseStatus = 'DELIVERED';
                    lifecycle.status = 'SUCCESS';
                    logStage('FINAL_RESPONSE_COMPLETED', 'SUCCESS', `ackText="${ackText.slice(0, 40)}"`);
                } else {
                    lifecycle.responseStatus = 'FAILED';
                    lifecycle.status = 'PLAYBACK_SUCCESS_RESPONSE_FAILED';
                    lifecycle.failureReason = interaction._restError?.code || interaction._restError?.message || 'Interaction response delivery failed';
                    const classified = interaction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                    logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${interaction.id || 'unknown'} stage="PLAYBACK_STARTED" elapsedMs=${lifecycle.responseDeliveryDurationMs}ms code="${classified.code}" category="${classified.category}"`);
                    logStage('FINAL_RESPONSE_COMPLETED', 'FAILED', `error="${lifecycle.failureReason}"`);
                }
            }

            // Immediately update the voice channel status with current track (fire-and-forget)
            client.voiceChannelStatusManager?.updateFromPlayer(player, player.queue?.current, 'playing').catch(() => {});

            // Update dashboard asynchronously with short bounded timeout (25ms) so command returns immediately without blocking
            const dashStart = Date.now();
            const songChangedImmediately = !wasPlaying;
            const targetTrackForDash = player.queue?.current || res?.tracks?.[0];
            if (songChangedImmediately) {
                if (typeof client.playerController?.replaceWithFullDashboard === 'function') {
                    const dashPromise = client.playerController.replaceWithFullDashboard(guildId, interaction.channel?.id || voiceChannel.id, { track: targetTrackForDash, channelId: interaction.channel?.id || voiceChannel.id }).catch((err) => {
                        logger.warn(`Failed to replace dashboard for guild ${guildId}:`, err?.message || err);
                    });
                    // Allow immediate resolution for unit tests/mocks without blocking real command reply
                    await Promise.race([
                        dashPromise,
                        new Promise(resolve => setTimeout(resolve, 25))
                    ]);
                } else if (typeof client.playerController?.updatePlayer === 'function') {
                    const updatePromise = client.playerController.updatePlayer(guildId, { replace: true, channelId: interaction.channel?.id || voiceChannel.id, track: targetTrackForDash }).catch((err) => {
                        logger.warn(`Failed to update dashboard for guild ${guildId}:`, err?.message || err);
                    });
                    await Promise.race([
                        updatePromise,
                        new Promise(resolve => setTimeout(resolve, 25))
                    ]);
                }
            } else if (typeof client.playerController?.updatePlayer === 'function') {
                const updatePromise = client.playerController.updatePlayer(guildId, { replace: false, channelId: interaction.channel?.id || voiceChannel.id }).catch((err) => {
                    logger.warn(`Failed to update dashboard for guild ${guildId}:`, err?.message || err);
                });
                await Promise.race([
                    updatePromise,
                    new Promise(resolve => setTimeout(resolve, 25))
                ]);
            }
            lifecycle.dashboardDurationMs = Date.now() - dashStart;

        } catch (error) {
            lifecycle.status = 'ERROR';
            lifecycle.failureReason = error?.code || error?.message || 'UNKNOWN_ERROR';
            logStage('FINAL_RESPONSE_START', 'START', `reason=EXCEPTION error="${error?.message || error}"`);

            if (error.code === 10062) {
                logger.warn(`Interaction expired before reply could be delivered (/play, guild: ${guildId})`);
                logStage('FINAL_RESPONSE_COMPLETED', 'FAILED', 'reason=TOKEN_EXPIRED');
                return;
            }
            logger.error('Error in play command:', error);
            const errResp = await handleLavalinkError(interaction, error, client);
            logStage('FINAL_RESPONSE_COMPLETED', errResp ? 'SUCCESS' : 'FAILED', 'reason=HANDLED_ERROR');
        } finally {
            // Clean up active request from registry
            activeRequest.completed = true;
            if (inFlightGuildPlayRequests.get(guildId)?.interactionId === interaction.id) {
                inFlightGuildPlayRequests.delete(guildId);
            }

            const phasesSum = (lifecycle.ackDurationMs || 0) +
                (lifecycle.validationDurationMs || 0) +
                (lifecycle.connectDurationMs || 0) +
                (lifecycle.searchDurationMs || 0) +
                (lifecycle.playDurationMs || 0) +
                (lifecycle.dashboardDurationMs || 0) +
                (lifecycle.responseDeliveryDurationMs || 0);

            lifecycle.totalDurationMs = Math.max(getElapsedMs(commandStartHr), phasesSum);

            const fmtMs = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v}ms` : 'n/a');
            logger.info(`[PLAY-LIFECYCLE] id=${lifecycle.interactionId} guild=${lifecycle.guildId} queryType="${lifecycle.queryType}" query="${lifecycle.sanitizedQuery}" ackMs=${fmtMs(lifecycle.ackDurationMs)} valMs=${fmtMs(lifecycle.validationDurationMs)} connectMs=${fmtMs(lifecycle.connectDurationMs)} searchMs=${fmtMs(lifecycle.searchDurationMs)} playMs=${fmtMs(lifecycle.playDurationMs)} dashMs=${fmtMs(lifecycle.dashboardDurationMs)} respMs=${fmtMs(lifecycle.responseDeliveryDurationMs)} totalMs=${lifecycle.totalDurationMs}ms status=${lifecycle.status} playback=${lifecycle.playbackStatus} response=${lifecycle.responseStatus} failure="${lifecycle.failureReason || 'none'}"`);
        }
    },
};
