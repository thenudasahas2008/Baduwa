const { Routes, PermissionsBitField, ChannelType } = require('discord.js');
const logger = require('./logger');
const { INTENDED_BOT_USERNAME } = require('./branding');

/**
 * VoiceChannelStatusManager
 * Handles automatic Discord Voice Channel Status updates using the official REST API:
 * PUT /channels/{channel.id}/voice-status with body { "status": "🎵 Now Playing: Title — Artist" }
 */
class VoiceChannelStatusManager {
    constructor(client) {
        this.client = client;
        // Map<channelId, string> - Tracks last status successfully set by ZYRO
        this.managedStatuses = new Map();
        // Map<guildId, string> - Tracks known voice channel ID per guild
        this.guildVoiceChannels = new Map();
        // Map<channelId, Promise> - Mutex queue per channel to prevent overlapping REST requests
        this.channelQueues = new Map();
    }

    /**
     * Formats the voice channel status string based on track metadata.
     * Clean native format: ♪ {Track Title} | {Artist} | {Source or Album}
     * Truncates safely to stay comfortably within Discord's 500-character limit.
     * @param {string} title - Song title
     * @param {string} [artist] - Song artist/uploader
     * @param {string|object} [sourceOrAlbum] - Source, album or options
     * @returns {string}
     */
    formatStatus(title, artist, sourceOrAlbum = null) {
        if (!title && !artist) return '';

        const cleanText = (str) => {
            if (!str || typeof str !== 'string') return '';
            return str
                .replace(/[\r\n\t]+/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
        };

        const cleanTitle = cleanText(title) || 'Unknown Track';
        let cleanArtist = cleanText(artist);
        let cleanSource = cleanText(typeof sourceOrAlbum === 'string' ? sourceOrAlbum : (sourceOrAlbum?.source || sourceOrAlbum?.album || ''));

        // Avoid displaying undefined, null, unknown, internal IDs, raw JSON, or duplicate text
        if (cleanArtist && (/^(undefined|null|unknown)$/i.test(cleanArtist) || cleanArtist.toLowerCase() === cleanTitle.toLowerCase())) {
            cleanArtist = '';
        }

        if (cleanSource && (/^(undefined|null|unknown|playing|paused|idle)$/i.test(cleanSource) || cleanSource.toLowerCase() === cleanTitle.toLowerCase() || cleanSource.toLowerCase() === cleanArtist.toLowerCase())) {
            cleanSource = '';
        }

        const parts = [cleanTitle];
        if (cleanArtist) {
            parts.push(cleanArtist);
        }
        if (cleanSource) {
            parts.push(cleanSource);
        }

        const prefix = '♪ ';
        let formatted = `${prefix}${parts.join(' | ')}`;

        // Discord voice channel status limit is 500 characters
        if (formatted.length > 500) {
            formatted = formatted.slice(0, 499).trimEnd() + '…';
        }

        return formatted;
    }

    /**
     * Checks if the bot member has required permissions to update status on the voice channel.
     * Requires SET_VOICE_CHANNEL_STATUS (281474976710656n).
     * If the bot is not currently connected to the voice channel, additionally requires MANAGE_CHANNELS (16n).
     * @param {object} channel - Discord voice channel object
     * @param {object} [botMember] - Guild member object for the bot
     * @param {boolean} [isConnected=true] - Whether the bot is currently in this voice channel
     * @returns {{ ok: boolean, reason?: string, missing?: string[], permissionNames?: string[] }}
     */
    checkPermissions(channel, botMember = null, isConnected = true) {
        if (!channel) {
            return { ok: false, reason: 'channel_not_found', missing: [], permissionNames: [] };
        }

        const member = botMember || channel.guild?.members?.me || null;
        const permissionSubject = member || this.client?.user;
        if (!permissionSubject) {
            return { ok: true };
        }

        if (typeof channel.permissionsFor === 'function') {
            const perms = channel.permissionsFor(permissionSubject);
            if (perms && typeof perms.has === 'function') {
                const missing = [];
                const permissionNames = [];

                const setVoiceStatusFlag = PermissionsBitField.Flags.SetVoiceChannelStatus;
                if (!perms.has(setVoiceStatusFlag)) {
                    missing.push('SET_VOICE_CHANNEL_STATUS');
                    permissionNames.push('Set Voice Channel Status');
                }

                // MANAGE_CHANNELS is only required by Discord if the bot is NOT inside the voice channel
                if (!isConnected) {
                    const manageChannelsFlag = PermissionsBitField.Flags.ManageChannels;
                    if (!perms.has(manageChannelsFlag)) {
                        missing.push('MANAGE_CHANNELS');
                        permissionNames.push('Manage Channels');
                    }
                }

                if (missing.length > 0) {
                    return {
                        ok: false,
                        reason: 'missing_permissions',
                        missing,
                        permissionNames
                    };
                }
            }
        }

        return { ok: true };
    }

    /**
     * Resolves the actual voice channel ZYRO is connected to in a guild.
     * Strictly verifies the channel is voice-based and never targets a text channel.
     * @param {string} guildId
     * @param {object} [player]
     * @returns {Promise<object|null>}
     */
    async resolveVoiceChannel(guildId, player = null) {
        if (!guildId) return null;

        const guild = this.client?.guilds?.cache?.get(guildId)
            || (this.client?.guilds?.fetch ? await this.client.guilds.fetch(guildId).catch(() => null) : null);

        // 1. Direct active player voice channel ID
        let targetVoiceChannelId = player?.voiceChannelId
            || player?.voice?.channelId
            || player?.options?.voiceChannelId;

        // 2. Bot member voice channel in Discord guild
        if (!targetVoiceChannelId && guild) {
            let me = guild.members?.me;
            if (!me && typeof guild.members?.fetchMe === 'function') {
                me = await guild.members.fetchMe().catch(() => null);
            }
            if (!me && typeof guild.members?.fetch === 'function' && this.client?.user?.id) {
                me = await guild.members.fetch(this.client.user.id).catch(() => null);
            }
            if (me?.voice?.channelId) {
                targetVoiceChannelId = me.voice.channelId;
            }
        }

        // 3. Scan guild channels cache for voice channel containing the bot
        if (!targetVoiceChannelId && guild?.channels?.cache) {
            const botId = this.client?.user?.id;
            if (botId) {
                const connectedChannel = guild.channels.cache.find(c => {
                    const isVoice = Boolean(
                        c.isVoiceBased?.() ||
                        c.type === ChannelType.GuildVoice ||
                        c.type === ChannelType.GuildStageVoice ||
                        c.type === 2 ||
                        c.type === 13
                    );
                    return isVoice && (c.members?.has?.(botId) || c.voiceStates?.has?.(botId));
                });
                if (connectedChannel) {
                    targetVoiceChannelId = connectedChannel.id;
                }
            }
        }

        // 4. Cached voice channel ID or 24/7 settings
        if (!targetVoiceChannelId) {
            targetVoiceChannelId = this.guildVoiceChannels.get(guildId)
                || this.client?.guildSettings?.get?.(guildId)?.voiceChannelId;
        }

        if (!targetVoiceChannelId) return null;

        let channel = guild?.channels?.cache?.get(targetVoiceChannelId)
            || this.client?.channels?.cache?.get(targetVoiceChannelId)
            || (this.client?.channels?.fetch ? await this.client.channels.fetch(targetVoiceChannelId).catch(() => null) : null);

        if (!channel) return null;

        // Strictly verify channel is voice-based
        const isVoice = Boolean(
            channel.isVoiceBased?.() ||
            channel.type === ChannelType.GuildVoice ||
            channel.type === ChannelType.GuildStageVoice ||
            channel.type === 2 ||
            channel.type === 13
        );

        if (!isVoice) {
            logger.debug(`Channel candidate ${targetVoiceChannelId} for guild ${guildId} is not a voice channel. Ignoring.`);
            return null;
        }

        this.guildVoiceChannels.set(guildId, channel.id);
        return channel;
    }

    /**
     * Updates or clears the voice channel status on Discord via REST API.
     * Uses a per-channel mutex to prevent overlapping requests and deduplicates identical statuses.
     * @param {string} channelId
     * @param {string} statusText - Desired status string (empty string to clear)
     * @param {string} [guildId]
     * @param {object} [options]
     * @returns {Promise<{ success: boolean, skipped?: boolean, reason?: string, error?: any }>}
     */
    async setStatus(channelId, statusText = '', guildId = null, options = {}) {
        if (!channelId) {
            return { success: false, reason: 'missing_channel_id' };
        }

        const targetStatus = typeof statusText === 'string' ? statusText : '';
        const currentManaged = this.managedStatuses.get(channelId);

        // Deduplication: if target status matches what ZYRO already set, skip REST call
        if (!options.force && currentManaged !== undefined && currentManaged === targetStatus) {
            return { success: true, skipped: true, reason: 'duplicate' };
        }

        // Serialize requests per channel through promise chain lock
        const previousQueue = this.channelQueues.get(channelId) || Promise.resolve();
        const currentExecution = previousQueue
            .catch(() => {})
            .then(async () => {
                // Re-check deduplication inside queue execution
                const freshManaged = this.managedStatuses.get(channelId);
                if (!options.force && freshManaged !== undefined && freshManaged === targetStatus) {
                    return { success: true, skipped: true, reason: 'duplicate' };
                }

                // Resolve channel object for permission inspection
                let channel = this.client?.channels?.cache?.get(channelId);
                if (!channel && typeof this.client?.channels?.fetch === 'function') {
                    channel = await this.client.channels.fetch(channelId).catch(() => null);
                }

                const effectiveGuildId = guildId || channel?.guild?.id;
                let botMember = channel?.guild?.members?.me || null;
                if (!botMember && channel?.guild?.members?.fetchMe) {
                    botMember = await channel.guild.members.fetchMe().catch(() => null);
                }

                // Determine if bot is connected to this voice channel
                const player = this.client?.lavalink?.getPlayer?.(effectiveGuildId);
                const botVoiceChannelId = botMember?.voice?.channelId
                    || player?.voiceChannelId
                    || player?.voice?.channelId;

                const isConnected = Boolean(
                    options.isConnected ||
                    (botVoiceChannelId && botVoiceChannelId === channelId) ||
                    (channel?.members?.has?.(this.client?.user?.id))
                );

                // Check permissions before sending request
                const permCheck = this.checkPermissions(channel, botMember, isConnected);
                if (!permCheck.ok && (targetStatus !== '' || !options.force)) {
                    const missingNames = permCheck.permissionNames?.join(' and ') || 'Set Voice Channel Status';
                    logger.warn(
                        `Cannot set voice channel status for guild ${effectiveGuildId || 'unknown'} (#${channel?.name || channelId}): ` +
                        `Missing permission "${missingNames}". Please enable "${missingNames}" in the server's role settings.`
                    );
                    return {
                        success: false,
                        reason: 'missing_permissions',
                        missing: permCheck.missing,
                        permissionNames: permCheck.permissionNames
                    };
                }

                // Construct official REST endpoint route: PUT /channels/{channel.id}/voice-status
                const route = typeof Routes?.channelVoiceStatus === 'function'
                    ? Routes.channelVoiceStatus(channelId)
                    : `/channels/${channelId}/voice-status`;

                // Discord REST body: { "status": string }
                const payload = { status: targetStatus };

                try {
                    if (!this.client?.rest?.put) {
                        throw new Error('client.rest.put is not available');
                    }

                    await Promise.race([
                        this.client.rest.put(route, { body: payload }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Voice status REST request timed out after 4000ms')), 4000))
                    ]);

                    if (targetStatus) {
                        this.managedStatuses.set(channelId, targetStatus);
                        if (effectiveGuildId) {
                            this.guildVoiceChannels.set(effectiveGuildId, channelId);
                        }
                        logger.info(`Updated voice channel status in #${channel?.name || channelId}: "${targetStatus}"`);
                    } else {
                        this.managedStatuses.delete(channelId);
                        logger.info(`Cleared voice channel status in #${channel?.name || channelId}`);
                    }

                    return { success: true, status: targetStatus };
                } catch (error) {
                    const httpStatus = error?.status || error?.rawError?.status || (error?.code >= 100 && error?.code < 600 ? error.code : 500);
                    const errorCode = error?.code || error?.rawError?.code || 'UNKNOWN';
                    const errorMessage = error?.message || error?.rawError?.message || String(error);

                    if (errorCode === 50013 || httpStatus === 403) {
                        // Fallback: If clearing status failed due to missing permissions from outside the channel,
                        // attempt a brief voice connection fallback if bot has CONNECT permission
                        if (!targetStatus && effectiveGuildId && channelId && !isConnected) {
                            try {
                                const player = this.client?.lavalink?.getPlayer?.(effectiveGuildId)
                                    || this.client?.lavalink?.createPlayer?.({
                                        guildId: effectiveGuildId,
                                        voiceChannelId: channelId,
                                        selfDeaf: true,
                                        selfMute: true
                                    });
                                if (player && typeof player.connect === 'function') {
                                    await player.connect();
                                    await this.client.rest.put(route, { body: payload });
                                    await player.disconnect().catch(() => {});
                                    this.managedStatuses.delete(channelId);
                                    logger.info(`Cleared voice channel status in #${channel?.name || channelId} via brief connection fallback`);
                                    return { success: true, status: '' };
                                }
                            } catch (fallbackErr) {
                                logger.debug(`Brief voice connection fallback to clear status failed:`, fallbackErr?.message || fallbackErr);
                            }
                        }

                        logger.warn(
                            `Discord rejected voice channel status update in guild ${effectiveGuildId || 'unknown'} (#${channel?.name || channelId}): ` +
                            `Missing Permissions (HTTP 403, error code 50013). Ensure ${INTENDED_BOT_USERNAME} has the "Set Voice Channel Status" and "Manage Channels" permission enabled in role settings.`
                        );
                    } else if (errorCode === 429 || httpStatus === 429) {
                        logger.warn(
                            `Rate limited by Discord while updating voice channel status in guild ${effectiveGuildId || 'unknown'} (#${channel?.name || channelId}) (HTTP 429).`
                        );
                    } else {
                        logger.warn(
                            `Failed to update voice channel status in guild ${effectiveGuildId || 'unknown'} (#${channel?.name || channelId}): [HTTP ${httpStatus}, Code ${errorCode}] ${errorMessage}`
                        );
                    }

                    return {
                        success: false,
                        error: errorCode,
                        status: httpStatus,
                        message: errorMessage
                    };
                }
            });

        currentExecution.finally(() => {
            if (this.channelQueues.get(channelId) === currentExecution) {
                this.channelQueues.delete(channelId);
            }
        });

        this.channelQueues.set(channelId, currentExecution);
        return currentExecution;
    }

    /**
     * Clears a voice channel status if and only if it is currently managed by ZYRO.
     * Prevents clearing statuses manually modified by human administrators.
     * @param {string} channelId
     * @param {string} [guildId]
     * @returns {Promise<{ success: boolean, skipped?: boolean, reason?: string }>}
     */
    async clearStatus(channelId, guildId = null, options = {}) {
        if (!channelId) {
            return { success: false, reason: 'missing_channel_id' };
        }

        // Only clear if ZYRO previously set a status on this channel, unless force=true
        if (!options.force && !this.managedStatuses.has(channelId)) {
            return { success: true, skipped: true, reason: 'not_managed_by_zyro' };
        }

        const channel = this.client?.channels?.cache?.get(channelId);
        // If Discord channel status is exposed and does not match our recorded managed status,
        // a user changed it manually, so preserve their custom status (unless force is requested).
        if (!options.force && channel?.status && typeof channel.status === 'string' && channel.status !== this.managedStatuses.get(channelId)) {
            logger.debug(`Voice channel #${channel.name || channelId} status was manually changed to "${channel.status}"; leaving untouched.`);
            this.managedStatuses.delete(channelId);
            return { success: true, skipped: true, reason: 'manually_changed' };
        }

        return this.setStatus(channelId, '', guildId, { isConnected: true, force: true, ...options });
    }

    /**
     * Clears the bot-managed voice channel status for a guild.
     * @param {string} guildId
     * @param {object} [options]
     * @returns {Promise<{ success: boolean, skipped?: boolean, reason?: string }>}
     */
    async clearStatusForGuild(guildId, options = {}) {
        if (!guildId) return { success: false, reason: 'missing_guild_id' };

        const player = this.client?.lavalink?.getPlayer?.(guildId);
        const channel = await this.resolveVoiceChannel(guildId, player);
        if (!channel) {
            const cachedChannelId = this.guildVoiceChannels.get(guildId);
            if (cachedChannelId) {
                return this.clearStatus(cachedChannelId, guildId, { force: true, ...options });
            }
            return { success: true, skipped: true, reason: 'no_channel' };
        }

        return this.clearStatus(channel.id, guildId, { force: true, ...options });
    }

    /**
     * Synchronizes and updates the voice channel status from active Lavalink player state.
     * @param {object} player - Lavalink player instance
     * @param {object} [track] - Track object (defaults to player.queue.current)
     * @param {string} [state='playing'] - 'playing' or 'paused'
     * @returns {Promise<{ success: boolean, skipped?: boolean, reason?: string }>}
     */
    async updateFromPlayer(player, track = null, state = 'playing') {
        if (!player || !player.guildId) {
            return { success: false, reason: 'invalid_player' };
        }

        // Defensive: support updateFromPlayer(player, 'paused')
        if (typeof track === 'string') {
            state = track;
            track = null;
        }

        const currentTrack = track || player.queue?.current;
        const hasLiveTrack = Boolean(currentTrack && (player.playing || player.paused || state === 'paused' || !player.stopped));

        if (!hasLiveTrack) {
            return this.clearStatusForGuild(player.guildId);
        }

        const channel = await this.resolveVoiceChannel(player.guildId, player);
        if (!channel) {
            logger.debug(`Could not resolve voice channel for guild ${player.guildId} during updateFromPlayer`);
            return { success: false, reason: 'no_channel' };
        }

        let sourceOrAlbum = currentTrack.info?.albumName
            || currentTrack.info?.album
            || currentTrack.albumName
            || currentTrack.album
            || null;

        if (!sourceOrAlbum && currentTrack.info?.sourceName) {
            const src = currentTrack.info.sourceName.toLowerCase();
            if (src === 'youtube' || src === 'yt') sourceOrAlbum = 'YouTube';
            else if (src === 'ytm' || src === 'youtubemusic') sourceOrAlbum = 'YouTube Music';
            else if (src === 'spotify') sourceOrAlbum = 'Spotify';
            else if (src === 'soundcloud') sourceOrAlbum = 'SoundCloud';
        }

        const statusText = this.formatStatus(currentTrack.info?.title, currentTrack.info?.author, sourceOrAlbum);

        return this.setStatus(channel.id, statusText, player.guildId, { isConnected: true });
    }

    /**
     * Handles the bot moving from one voice channel to another.
     * Cleans up the previous channel's status if managed by ZYRO, and updates the new channel.
     * @param {string} oldChannelId
     * @param {string} newChannelId
     * @param {string} guildId
     */
    async handleChannelMove(oldChannelId, newChannelId, guildId) {
        if (oldChannelId && oldChannelId !== newChannelId) {
            await this.clearStatus(oldChannelId, guildId);
        }

        if (newChannelId) {
            this.guildVoiceChannels.set(guildId, newChannelId);
            await this.syncGuildPlayerStatus(guildId);
        }
    }

    /**
     * Reconciles the voice channel status for a single guild with true player state.
     * Useful after reconnection, startup, or node failover.
     * @param {string} guildId
     */
    async syncGuildPlayerStatus(guildId) {
        if (!guildId) return;

        const player = this.client?.lavalink?.getPlayer?.(guildId);
        if (!player || (!player.playing && !player.paused) || !player.queue?.current) {
            await this.clearStatusForGuild(guildId);
            return;
        }

        await this.updateFromPlayer(player, player.queue.current, player.paused ? 'paused' : 'playing');
    }

    /**
     * Cleans up orphaned or stale voice channel statuses across all guilds on bot startup.
     */
    async cleanupStaleStatusesOnStartup() {
        if (!this.client?.guilds?.cache) return;

        for (const guild of this.client.guilds.cache.values()) {
            const player = this.client.lavalink?.getPlayer?.(guild.id);
            const isPlaying = Boolean(player && (player.playing || player.paused) && player.queue?.current);

            if (!isPlaying) {
                const cachedChannelId = this.guildVoiceChannels.get(guild.id);
                if (cachedChannelId) {
                    await this.clearStatus(cachedChannelId, guild.id, { force: true }).catch(() => {});
                }
            }
        }
    }

    /**
     * Cleanup resources and pending queues on shutdown.
     */
    destroy() {
        this.managedStatuses.clear();
        this.guildVoiceChannels.clear();
        this.channelQueues.clear();
    }
}

module.exports = VoiceChannelStatusManager;
