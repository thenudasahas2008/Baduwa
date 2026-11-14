const { MessageFlags } = require('discord.js');
const logger = require('./logger');

const RESPONSE_STATES = Object.freeze({
    PENDING: 'PENDING',
    ACKNOWLEDGED: 'ACKNOWLEDGED',
    FINALIZING: 'FINALIZING',
    RESPONDED: 'RESPONDED',
    RESPONSE_FAILED: 'RESPONSE_FAILED',
    EXPIRED: 'EXPIRED',
});

// Check if Lavalink is available
const isLavalinkAvailable = (client) => {
    if (client?.lavalinkConnectionManager && typeof client.lavalinkConnectionManager.isAvailable === 'function') {
        return client.lavalinkConnectionManager.isAvailable();
    }
    const node = client?.lavalink?.nodeManager?.nodes?.get('main-node');
    return node?.connected === true;
};

/**
 * Diagnostic logger for Discord interaction lifecycle events.
 */
const logInteractionDiag = (interaction, event, metadata = {}) => {
    try {
        const id = interaction?.id || 'unknown';
        const type = interaction?.isCommand?.() ? 'command' : (interaction?.isButton?.() ? 'button' : (interaction?.isStringSelectMenu?.() ? 'select' : 'interaction'));
        const name = interaction?.isCommand?.() ? interaction.commandName : (interaction?.customId || 'unknown');
        const guildId = interaction?.guildId || 'DM';
        const acknowledged = Boolean(interaction?.deferred || interaction?.replied);
        const metaStr = Object.entries(metadata)
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(' ');
        logger.debug(`[INTERACTION-DIAG] [${event}] id=${id} type=${type} name=${name} guild=${guildId} ack=${acknowledged} ${metaStr}`.trim());
    } catch (_) {
        // Logging should never throw or trigger unhandled rejections
    }
};

/**
 * Detects whether a Discord error indicates an expired or invalid webhook/interaction token.
 * Discord returns:
 * - 10015: Unknown Webhook (webhook token expired or deleted)
 * - 50027: Invalid Webhook Token (webhook token expired after 15m)
 * - 10062: Unknown interaction (interaction expired after 3s if not acknowledged or expired token)
 */
const isTokenExpiredError = (err) => {
    if (!err) return false;
    const code = err.code || err.rawError?.code;
    const msg = String(err.message || err.rawError?.message || '');
    return code === 10015
        || code === 50027
        || code === 10062
        || /Invalid Webhook Token|Unknown Webhook|Unknown interaction/i.test(msg);
};

/**
 * Classifies Discord REST errors into distinct categories for diagnostics and lifecycle handling.
 */
const classifyRestError = (err) => {
    if (!err) return { category: 'UNKNOWN', code: 'UNKNOWN', message: 'Unknown error' };
    if (isTokenExpiredError(err)) {
        return { category: 'TOKEN_EXPIRED', code: err.code || 10062, message: 'Interaction token expired' };
    }
    if (err.code === 'REST_TIMEOUT') {
        return { category: 'REST_TIMEOUT', code: 'REST_TIMEOUT', message: err.message || 'Discord REST request timed out' };
    }
    if (err.code === 40060) {
        return { category: 'ALREADY_ACKNOWLEDGED', code: 40060, message: 'Interaction already acknowledged' };
    }
    if (err.status === 429 || err.code === 429) {
        const retryAfter = err.retry_after || err.rawError?.retry_after || null;
        return { category: 'RATE_LIMITED', code: 429, message: `Discord rate limit encountered${retryAfter ? ` (retry after ${retryAfter}s)` : ''}` };
    }
    if (err.status >= 500 && err.status < 600) {
        return { category: 'DISCORD_5XX', code: err.status, message: `Discord API returned HTTP ${err.status}` };
    }
    const codeStr = String(err.code || '');
    const msgStr = String(err.message || '');
    if (codeStr === 'ENOTFOUND' || /getaddrinfo/i.test(msgStr)) {
        return { category: 'DNS_ERROR', code: 'ENOTFOUND', message: 'Discord API DNS resolution failed' };
    }
    if (/CERT|TLS|SSL/i.test(codeStr) || /CERT|TLS|SSL/i.test(msgStr)) {
        return { category: 'TLS_ERROR', code: codeStr || 'TLS_ERROR', message: 'Discord API TLS handshake failed' };
    }
    if (/HEADERS_TIMEOUT|BODY_TIMEOUT|CONNECT_TIMEOUT|ETIMEDOUT/i.test(codeStr) || /timeout/i.test(msgStr)) {
        return { category: 'SOCKET_TIMEOUT', code: codeStr || 'ETIMEDOUT', message: 'Underlying socket connection timed out' };
    }
    if (codeStr === 'ECONNRESET' || codeStr === 'ECONNREFUSED') {
        return { category: 'NETWORK_ERROR', code: codeStr, message: `Network connection error (${codeStr})` };
    }
    return { category: 'REST_ERROR', code: err.code || err.status || 'REST_ERROR', message: err.message || 'REST error' };
};

const getRestTimeoutMs = () => {
    const raw = process.env.DISCORD_REST_TIMEOUT_MS;
    const parsed = parseInt(raw, 10);
    // Strict upper bound of 8000ms prevents long environment variables from stalling command lifecycles
    return (!isNaN(parsed) && parsed > 0) ? Math.min(parsed, 8000) : 6000;
}; // 6s default bounded timeout prevents Discord REST from consuming the full 20s command deadline
const DEFER_TIMEOUT_MS = 2500;  // 2.5s for initial acknowledgement to satisfy Discord's 3s hard SLA

/**
 * Executes a REST promise bounded by a strict timeout.
 * Coordinates an AbortController so that when timeout triggers,
 * the underlying network request is aborted cleanly rather than left orphaned in the queue.
 * Captures late resolution truthfully without clearing error records or corrupting failure states.
 */
const withRestTimeout = async (promiseOrFactory, timeoutMs = getRestTimeoutMs(), label = 'REST', interaction = null) => {
    let timer;
    let didTimeout = false;
    const startTime = Date.now();
    const abortController = new AbortController();

    const actualTimeoutMs = (!isNaN(Number(timeoutMs)) && Number(timeoutMs) > 0) ? Number(timeoutMs) : getRestTimeoutMs();

    let promise;
    try {
        if (typeof promiseOrFactory === 'function') {
            promise = promiseOrFactory(abortController.signal);
        } else {
            promise = promiseOrFactory;
        }
    } catch (createErr) {
        return Promise.reject(createErr);
    }

    // Capture late settlement in background without masking errors
    if (promise && typeof promise.then === 'function') {
        promise.then(
            (lateResult) => {
                if (didTimeout && interaction) {
                    const lateElapsed = Date.now() - startTime;
                    interaction._lateResolved = true;
                    interaction._lateDurationMs = lateElapsed;
                    interaction.replied = true;
                    // Note: do NOT mutate _responseState to RESPONDED or set _restError = null;
                    // delivery timed out and must remain truthfully recorded as a response failure.
                    logger.info(`[LIFECYCLE-DIAG] [LATE_COMPLETION] id=${interaction.id || 'unknown'} path="${label}" status=SUCCESS durationMs=${lateElapsed}ms`);
                }
                return lateResult;
            },
            (lateErr) => {
                if (didTimeout && interaction) {
                    const lateElapsed = Date.now() - startTime;
                    const classified = classifyRestError(lateErr);
                    logger.debug(`[LIFECYCLE-DIAG] [LATE_REJECTION] id=${interaction.id || 'unknown'} path="${label}" code="${classified.code}" durationMs=${lateElapsed}ms: ${classified.message}`);
                }
            }
        );
    }

    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            didTimeout = true;
            try {
                abortController.abort(new Error(`Discord ${label} call timed out after ${actualTimeoutMs}ms`));
            } catch (_) {}
            const err = new Error(`Discord ${label} call timed out after ${actualTimeoutMs}ms`);
            err.code = 'REST_TIMEOUT';
            reject(err);
        }, actualTimeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/**
 * Ensures an interaction is deferred immediately to comply with Discord's 3-second SLA.
 * Idempotent: checks deferred/replied state and state machine first to prevent duplicate deferrals or code 40060.
 */
const ensureDeferred = async (interaction, { ephemeral = true } = {}) => {
    if (!interaction) return { deferred: false, durationMs: 0 };
    if (interaction._tokenExpired || interaction._timedOut || interaction._responseState === RESPONSE_STATES.EXPIRED) {
        return { deferred: false, durationMs: 0 };
    }
    if (interaction.deferred || interaction.replied || interaction._responseState === RESPONSE_STATES.RESPONDED || interaction._responseState === RESPONSE_STATES.ACKNOWLEDGED) {
        return { deferred: true, durationMs: 0 };
    }
    const start = Date.now();
    try {
        if (typeof interaction.deferReply === 'function') {
            await withRestTimeout(
                interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
                DEFER_TIMEOUT_MS,
                'deferReply',
                interaction
            );
            const durationMs = Date.now() - start;
            interaction._responseState = RESPONSE_STATES.ACKNOWLEDGED;
            logger.info(`[LIFECYCLE-DIAG] [ACKNOWLEDGED] id=${interaction.id || 'unknown'} command="${interaction.commandName || interaction.customId || 'unknown'}" durationMs=${durationMs}ms isDeferred=true`);
            return { deferred: true, durationMs };
        }
    } catch (err) {
        const durationMs = Date.now() - start;
        const classified = classifyRestError(err);
        if (classified.category === 'TOKEN_EXPIRED') {
            interaction._tokenExpired = true;
            interaction._responseState = RESPONSE_STATES.EXPIRED;
            logger.warn(`Interaction expired before deferReply could be sent (guild: ${interaction.guildId || 'DM'})`);
            return { deferred: false, durationMs };
        }
        if (err.code === 40060) {
            // Already acknowledged in parallel
            interaction._responseState = RESPONSE_STATES.ACKNOWLEDGED;
            return { deferred: true, durationMs };
        }
        logger.warn(`Failed early deferReply for /${interaction.commandName || 'interaction'}:`, err?.message || err);
        return { deferred: false, durationMs };
    }
    return { deferred: false, durationMs: 0 };
};

/**
 * Safely responds to a Discord interaction whether it is deferred, already replied, or unacknowledged.
 * Prevents double failures, token expiry retries, and concurrent conflicting edits.
 */
const safeReply = async (interaction, payload) => {
    if (!interaction) return null;
    if (interaction._tokenExpired || interaction._responseState === RESPONSE_STATES.EXPIRED) {
        logger.debug(`[LIFECYCLE-DIAG] Interaction ${interaction.id || 'unknown'} token is expired. Aborting safeReply.`);
        return null;
    }
    // Suppress stale background executions from overwriting a timed-out interaction
    if (interaction._timedOut && !payload?._isTimeoutReply) {
        logger.debug(`[LIFECYCLE-DIAG] Interaction ${interaction.id || 'unknown'} already timed out. Suppressing stale safeReply.`);
        return null;
    }

    // If previous response delivery already failed, suppress duplicate cascading attempts unless designated terminal/timeout/error/fallback reply
    if (interaction._responseState === RESPONSE_STATES.RESPONSE_FAILED) {
        const isTerminalReply = Boolean(payload?._isTimeoutReply || payload?._isErrorReply || payload?._isFallbackReply || payload?._isFinalReply);
        if (!isTerminalReply) {
            const errCat = interaction._restError?.category || 'REST_FAILURE';
            logger.debug(`[LIFECYCLE-DIAG] Interaction ${interaction.id || 'unknown'} previous response failed with ${errCat}. Suppressing cascading duplicate attempt.`);
            return null;
        }
    }
    if (interaction._responseState === RESPONSE_STATES.EXPIRED || interaction._tokenExpired) {
        logger.debug(`[LIFECYCLE-DIAG] Interaction ${interaction.id || 'unknown'} token expired. Suppressing reply.`);
        return null;
    }

    // If an underlying REST operation is currently in flight, return it to prevent competing duplicate edits
    // Exception: urgent timeout replies must not be blocked by a stalled in-flight REST request
    if (interaction._inFlightReplyPromise && !payload?._isTimeoutReply) {
        logger.debug(`[LIFECYCLE-DIAG] Interaction ${interaction.id || 'unknown'} already has a reply in flight. Awaiting existing reply.`);
        return await interaction._inFlightReplyPromise.catch(() => null);
    }

    const startTime = Date.now();
    // Discord REST API rejects flags in PATCH /webhooks/:id/:token/messages/@original (error 50035)
    const editPayload = (payload && typeof payload === 'object') ? { ...payload } : payload;
    if (editPayload && typeof editPayload === 'object') {
        if ('flags' in editPayload) delete editPayload.flags;
        if ('_isTimeoutReply' in editPayload) delete editPayload._isTimeoutReply;
        if ('_isErrorReply' in editPayload) delete editPayload._isErrorReply;
        if ('_isFallbackReply' in editPayload) delete editPayload._isFallbackReply;
        if ('_isFinalReply' in editPayload) delete editPayload._isFinalReply;
    }

    let path = 'unknown';
    const currentRestTimeout = getRestTimeoutMs();
    const executeReply = async () => {
        if (payload?._isFollowUp && typeof interaction.followUp === 'function') {
            path = 'followUp';
            return await withRestTimeout(() => interaction.followUp(payload), currentRestTimeout, 'followUp', interaction);
        } else if (interaction.deferred && typeof interaction.editReply === 'function') {
            path = 'editReply';
            return await withRestTimeout(() => interaction.editReply(editPayload), currentRestTimeout, 'editReply', interaction);
        } else if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
            path = 'reply';
            return await withRestTimeout(() => interaction.reply(payload), currentRestTimeout, 'reply', interaction);
        } else if (interaction.replied) {
            if (payload?._isFinalReply && typeof interaction.editReply === 'function') {
                path = 'editReply';
                return await withRestTimeout(() => interaction.editReply(editPayload), currentRestTimeout, 'editReply', interaction);
            }
            if (typeof interaction.followUp === 'function') {
                path = 'followUp';
                return await withRestTimeout(() => interaction.followUp(payload), currentRestTimeout, 'followUp', interaction);
            }
            if (typeof interaction.editReply === 'function') {
                path = 'editReply';
                return await withRestTimeout(() => interaction.editReply(editPayload), currentRestTimeout, 'editReply', interaction);
            }
            if (typeof interaction.reply === 'function') {
                path = 'reply';
                return await withRestTimeout(() => interaction.reply(payload), currentRestTimeout, 'reply', interaction);
            }
        } else if (typeof interaction.editReply === 'function') {
            path = 'editReply_fallback';
            return await withRestTimeout(() => interaction.editReply(editPayload), currentRestTimeout, 'editReply_fallback', interaction);
        } else if (typeof interaction.followUp === 'function') {
            path = 'followUp_fallback';
            return await withRestTimeout(() => interaction.followUp(payload), currentRestTimeout, 'followUp_fallback', interaction);
        } else if (typeof interaction.reply === 'function') {
            path = 'reply_fallback';
            return await withRestTimeout(() => interaction.reply(payload), currentRestTimeout, 'reply_fallback', interaction);
        }
        return null;
    };

    interaction._responseState = RESPONSE_STATES.FINALIZING;
    const inFlightPromise = executeReply();
    interaction._inFlightReplyPromise = inFlightPromise;

    try {
        const result = await inFlightPromise;
        const elapsedMs = Date.now() - startTime;
        interaction._responseState = RESPONSE_STATES.RESPONDED;
        interaction.replied = true;
        interaction._restError = null;
        interaction._inFlightReplyPromise = null;

        logInteractionDiag(interaction, 'SAFE_REPLY_SUCCESS', {
            path,
            elapsedMs
        });
        logger.info(`[LIFECYCLE-DIAG] [RESPONSE_COMPLETED] id=${interaction?.id || 'unknown'} path="${path}" status=SUCCESS durationMs=${elapsedMs}ms`);
        return result;
    } catch (err) {
        const elapsedMs = Date.now() - startTime;
        const classified = classifyRestError(err);
        interaction._restError = classified;
        interaction._inFlightReplyPromise = null;

        logInteractionDiag(interaction, 'SAFE_REPLY_ERROR', {
            path,
            code: classified.code,
            category: classified.category,
            status: err?.status,
            message: classified.message,
            elapsedMs
        });

        if (classified.category === 'TOKEN_EXPIRED') {
            interaction._tokenExpired = true;
            interaction._responseState = RESPONSE_STATES.EXPIRED;
            logger.warn(`[LIFECYCLE-DIAG] [RESPONSE_COMPLETED] id=${interaction?.id || 'unknown'} path="${path}" status=EXPIRED code="${classified.code}" durationMs=${elapsedMs}ms. Token expired; stopping retries.`);
            return null;
        }

        interaction._responseState = RESPONSE_STATES.RESPONSE_FAILED;
        logger.warn(`[LIFECYCLE-DIAG] [RESPONSE_COMPLETED] id=${interaction?.id || 'unknown'} path="${path}" status=FAILED code="${classified.code}" category="${classified.category}" durationMs=${elapsedMs}ms: ${classified.message}`);

        if (err.code === 40060) {
            if (path === 'reply' && typeof interaction.editReply === 'function') {
                return await interaction.editReply(editPayload).then((res) => {
                    interaction._responseState = RESPONSE_STATES.RESPONDED;
                    interaction.replied = true;
                    interaction._restError = null;
                    return res;
                }).catch((retryErr) => {
                    const retryClassified = classifyRestError(retryErr);
                    if (retryClassified.category === 'TOKEN_EXPIRED') {
                        interaction._tokenExpired = true;
                        interaction._responseState = RESPONSE_STATES.EXPIRED;
                    }
                    return null;
                });
            }
            return null;
        }
        logger.error(`Failed to respond to interaction via ${path}:`, err?.message || err);
        return null;
    }
};

// Handle Lavalink connection errors consistently
const handleLavalinkError = async (interaction, error, client) => {
    const { createActionEmbed } = require('./zyroEmbeds');
    const msg = error?.message || '';
    let title = 'Music Service Reconnecting';
    let description = 'Music service is reconnecting; please try again shortly.';

    if (error?.name === 'TimeoutError' || /aborted due to timeout/i.test(msg)) {
        title = 'Search Timed Out';
        description = 'The music search took too long to complete. The audio server may be busy — please try again.';
    }

    await safeReply(interaction, {
        embeds: [createActionEmbed('warning', title, description)],
        flags: MessageFlags.Ephemeral
    });
};

const requirePlayer = async (interaction, { requireQueue = false } = {}) => {
    const { client, guild } = interaction;
    const lang = client.defaultLanguage;

    // Check if Lavalink is available first
    if (!isLavalinkAvailable(client)) {
        const { createActionEmbed } = require('./zyroEmbeds');
        await safeReply(interaction, {
            embeds: [createActionEmbed('warning', 'Music Service Reconnecting', 'Music service is reconnecting; please try again shortly.')],
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    const guildId = guild?.id || interaction.guildId;
    if (!guildId) {
        await safeReply(interaction, {
            content: 'This command can only be used in a Discord server voice channel.',
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }
    const player = client.lavalink.getPlayer(guildId);
    if (!player) {
        await safeReply(interaction, {
            content: client.languageManager.get(lang, 'NOTHING_PLAYING'),
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    if (requireQueue && player.queue.tracks.length === 0) {
        await safeReply(interaction, {
            content: client.languageManager.get(lang, 'QUEUE_EMPTY'),
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }

    return player;
};

/**
 * Ensures the member executing the interaction is in the same voice channel as the player.
 * Returns true if validation passes, otherwise replies with an error and returns false.
 */
const requireSameVoice = async (interaction, player) => {
    const { member, client } = interaction;
    const lang = client.defaultLanguage;

    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel || voiceChannel.id !== player.voiceChannelId) {
        await safeReply(interaction, {
            content: client.languageManager.get(lang, 'NOT_IN_VOICE'),
            flags: MessageFlags.Ephemeral,
        });
        return false;
    }
    return true;
};

module.exports = {
    RESPONSE_STATES,
    classifyRestError,
    withRestTimeout,
    getRestTimeoutMs,
    ensureDeferred,
    safeReply,
    requirePlayer,
    requireSameVoice,
    isLavalinkAvailable,
    handleLavalinkError,
    logInteractionDiag,
    isTokenExpiredError,
};