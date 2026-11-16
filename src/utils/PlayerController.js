const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { createNowPlayingEmbed, createStoppedEmbed, createUnavailableEmbed } = require('./zyroEmbeds');
const { isManualStopActive } = require('./playerLifecycle');
const logger = require('./logger');

class PlayerController {
    constructor(client) {
        this.client = client;
        this.playerMessages = new Map(); // Guild ID -> { messageId, channelId }
        this.guildLocks = new Map();     // Guild ID -> Promise chain lock
        this.staleMessages = new Map();  // Guild ID -> Set of JSON stringified { channelId, messageId }
        this.lastReplacement = new Map(); // Guild ID -> { trackId, messageId, timestamp }
        this.lastQueueRefresh = new Map(); // Guild ID -> timestamp of last bottom dashboard refresh from queue
    }

    getDashboard(guildId) {
        if (this.playerMessages.has(guildId)) {
            return this.playerMessages.get(guildId);
        }
        const saved = typeof this.client?.guildSettings?.getDashboard === 'function'
            ? this.client.guildSettings.getDashboard(guildId)
            : null;
        if (saved) {
            this.playerMessages.set(guildId, saved);
            return saved;
        }
        return null;
    }

    setDashboard(guildId, data) {
        if (!guildId || !data) return;
        this.playerMessages.set(guildId, data);
        try {
            if (typeof this.client?.guildSettings?.setDashboard === 'function') {
                this.client.guildSettings.setDashboard(guildId, data);
            }
        } catch (err) {
            logger.debug('Failed to persist dashboard settings:', err?.message || err);
        }
    }

    deleteDashboard(guildId) {
        this.playerMessages.delete(guildId);
        this.lastReplacement?.delete(guildId);
        this.lastQueueRefresh?.delete(guildId);
        try {
            if (typeof this.client?.guildSettings?.deleteDashboard === 'function') {
                this.client.guildSettings.deleteDashboard(guildId);
            }
        } catch (err) {
            logger.debug('Failed to delete dashboard settings:', err?.message || err);
        }
    }

    /**
     * Checks if the bot has required permissions in the specified channel.
     * Supports both TextChannel and VoiceChannel (VoiceChannel in Discord.js v14 has built-in text chat).
     * Required: ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory.
     */
    checkChannelPermissions(channel, options = {}) {
        if (!channel) {
            return { ok: false, reason: 'Channel is null or undefined' };
        }

        // Must support sending messages or fetching messages for in-place edit
        if (options.requireSend && typeof channel.send !== 'function') {
            return { ok: false, reason: 'Channel cannot send messages' };
        }

        if (typeof channel.send !== 'function' && !channel.messages) {
            return { ok: false, reason: 'Channel cannot send or fetch messages' };
        }

        // Check Discord permissions if available
        if (typeof channel.permissionsFor === 'function') {
            const botMember = channel.guild?.members?.me || this.client.user;
            if (botMember) {
                const perms = channel.permissionsFor(botMember);
                if (perms && typeof perms.has === 'function') {
                    const missing = [];
                    if (!perms.has(PermissionsBitField.Flags.ViewChannel)) missing.push('ViewChannel');
                    if (!perms.has(PermissionsBitField.Flags.SendMessages)) missing.push('SendMessages');
                    if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) missing.push('EmbedLinks');
                    if (!perms.has(PermissionsBitField.Flags.ReadMessageHistory)) missing.push('ReadMessageHistory');
                    if (missing.length > 0) {
                        return { ok: false, reason: `Missing permissions: ${missing.join(', ')}` };
                    }
                }
            }
        }
        return { ok: true };
    }

    /**
     * Resolves the target channel for player dashboard messages.
     * When ZYRO is connected to a voice channel, the destination MUST BE the chat panel
     * of the connected voice channel. Never falls back to a normal text channel when connected.
     * When not connected to voice, preserves idle/configured channel behavior.
     */
    async resolvePlayerChannel(guildId, options = {}, player = null) {
        const activePlayer = player || (this.client.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null);
        const guild = this.client.guilds?.cache?.get(guildId)
            || (this.client.guilds?.fetch ? await this.client.guilds.fetch(guildId).catch(() => null) : null);

        const currentDashboard = this.getDashboard(guildId);

        // 1. Resolve connected voice channel
        const connectedVoiceChannelId = activePlayer?.voiceChannelId
            || guild?.members?.me?.voice?.channelId;

        const excludedId = options.excludeChannelId || null;

        if (connectedVoiceChannelId && connectedVoiceChannelId !== excludedId) {
            try {
                let voiceChannel = this.client.channels?.cache?.get(connectedVoiceChannelId)
                    || guild?.channels?.cache?.get(connectedVoiceChannelId);

                if (!voiceChannel && this.client.channels?.fetch) {
                    voiceChannel = await this.client.channels.fetch(connectedVoiceChannelId).catch((fetchErr) => {
                        if (fetchErr.code === 10003) {
                            logger.warn(`[DASHBOARD-DIAG] Connected voice channel ${connectedVoiceChannelId} for guild ${guildId} returned Unknown Channel (code 10003). Invalidating stale voice channel reference.`);
                            this.client?.guildSettings?.invalidateVoiceChannel?.(guildId);
                            return null;
                        }
                        if (fetchErr.code === 50013 || fetchErr.code === 50001 || fetchErr.status === 403) {
                            logger.warn(`[DASHBOARD-DIAG] Missing permissions to fetch connected voice channel ${connectedVoiceChannelId} for guild ${guildId}: ${fetchErr.message}`);
                            return null;
                        }
                        logger.debug(`Failed to fetch connected voice channel ${connectedVoiceChannelId} in guild ${guildId}:`, fetchErr?.message || fetchErr);
                        return null;
                    });
                }

                if (voiceChannel) {
                    const permResult = this.checkChannelPermissions(voiceChannel, options);
                    if (permResult.ok) {
                        return voiceChannel;
                    }
                    logger.warn(`[DASHBOARD-DIAG] Connected voice channel ${connectedVoiceChannelId} (${voiceChannel.name || 'voice'}) failed validation: ${permResult.reason}. Falling back to command channel for dashboard visibility.`);
                }

                // If voiceChannel was not found in Discord or lacked permissions, check fallback candidates strictly excluding the failing channel
                const fallbackCandidates = [
                    options.channelId !== connectedVoiceChannelId ? options.channelId : null,
                    activePlayer?.textChannelId !== connectedVoiceChannelId ? activePlayer?.textChannelId : null,
                    this.client?.guildSettings?.get?.(guildId)?.textChannelId,
                    currentDashboard?.channelId !== connectedVoiceChannelId ? currentDashboard?.channelId : null,
                ].filter(id => id && id !== excludedId);

                for (const fallbackId of [...new Set(fallbackCandidates)]) {
                    const fallbackChannel = this.client.channels?.cache?.get(fallbackId)
                        || guild?.channels?.cache?.get(fallbackId)
                        || (this.client.channels?.fetch ? await this.client.channels.fetch(fallbackId).catch(() => null) : null);
                    if (fallbackChannel && this.checkChannelPermissions(fallbackChannel, options).ok) {
                        return fallbackChannel;
                    }
                }

                // Guild-level fallback: system channel or first accessible text channel in cache
                if (guild) {
                    if (guild.systemChannel && guild.systemChannel.id !== connectedVoiceChannelId && guild.systemChannel.id !== excludedId) {
                        if (this.checkChannelPermissions(guild.systemChannel, options).ok) {
                            logger.info(`[DASHBOARD-DIAG] Falling back to systemChannel #${guild.systemChannel.name} for guild ${guildId}`);
                            return guild.systemChannel;
                        }
                    }

                    if (guild.channels?.cache?.size > 0) {
                        for (const ch of guild.channels.cache.values()) {
                            if (ch.id === connectedVoiceChannelId || ch.id === excludedId) continue;
                            const isText = typeof ch.isTextBased === 'function' ? ch.isTextBased() : (ch.type === 0 || ch.type === 2);
                            if (isText && this.checkChannelPermissions(ch, options).ok) {
                                logger.info(`[DASHBOARD-DIAG] Falling back to accessible channel #${ch.name} (${ch.id}) for guild ${guildId}`);
                                return ch;
                            }
                        }
                    }
                }

                logger.warn(`[DASHBOARD-DIAG] Connected voice channel ${connectedVoiceChannelId} not usable in guild ${guildId} and no valid fallback channel found.`);
                return null;
            } catch (err) {
                logger.warn(`[DASHBOARD-DIAG] Error resolving connected voice channel ${connectedVoiceChannelId} for guild ${guildId}:`, err?.message || err);
                return null;
            }
        }

        // 2. When the bot is not connected to voice, follow existing safe idle behavior and do not invent a voice channel target.
        const candidates = [
            this.client?.guildSettings?.get?.(guildId)?.textChannelId,
            options.channelId,
            activePlayer?.textChannelId,
            currentDashboard?.channelId,
        ].filter(Boolean);

        for (const channelId of [...new Set(candidates)]) {
            try {
                let channel = this.client.channels?.cache?.get(channelId)
                    || guild?.channels?.cache?.get(channelId);

                if (!channel && this.client.channels?.fetch) {
                    channel = await this.client.channels.fetch(channelId).catch((fetchErr) => {
                        if (fetchErr.code === 10003) {
                            logger.warn(`[DASHBOARD-DIAG] Idle channel candidate ${channelId} for guild ${guildId} returned Unknown Channel (code 10003). Invalidating stale channel reference.`);
                            if (this.client?.guildSettings?.get?.(guildId)?.textChannelId === channelId) {
                                this.client?.guildSettings?.invalidateTextChannel?.(guildId);
                            }
                            if (currentDashboard?.channelId === channelId) {
                                this.deleteDashboard(guildId);
                            }
                            if (activePlayer?.textChannelId === channelId) {
                                activePlayer.textChannelId = null;
                            }
                            if (this.client?.guildSettings?.get?.(guildId)?.voiceChannelId === channelId) {
                                this.client?.guildSettings?.invalidateVoiceChannel?.(guildId);
                            }
                            return null;
                        }
                        return null;
                    });
                }

                if (channel) {
                    const permResult = this.checkChannelPermissions(channel, options);
                    if (permResult.ok) {
                        return channel;
                    }
                }
            } catch (err) {
                logger.debug(`Failed to resolve idle channel ${channelId}:`, err?.message || err);
            }
        }

        // Fallback for idle mode: if candidates failed, check systemChannel or accessible text channel in guild
        try {
            const guild = this.client.guilds?.cache?.get(guildId)
                || (this.client.guilds?.fetch ? await this.client.guilds.fetch(guildId).catch(() => null) : null);
            if (guild) {
                if (guild.systemChannel) {
                    const permResult = this.checkChannelPermissions(guild.systemChannel, options);
                    if (permResult.ok) {
                        return guild.systemChannel;
                    }
                }
                const channels = guild.channels?.cache ? Array.from(guild.channels.cache.values()) : [];
                for (const ch of channels) {
                    const permResult = this.checkChannelPermissions(ch, options);
                    if (permResult.ok) {
                        return ch;
                    }
                }
            }
        } catch (fallbackErr) {
            logger.debug(`Idle guild text channel fallback error for guild ${guildId}:`, fallbackErr?.message || fallbackErr);
        }

        logger.debug(`No valid destination channel found for guild ${guildId} (idle/disconnected)`);
        return null;
    }

    async runWithGuildLock(guildId, fn) {
        if (!guildId) return fn();
        const startWait = Date.now();
        const prevLock = this.guildLocks.get(guildId) || Promise.resolve();
        let unlock;
        const nextLock = new Promise((resolve) => { unlock = resolve; });
        this.guildLocks.set(guildId, nextLock);

        let startHeld = 0;
        try {
            // Guard lock wait with bounded timeout so a stalled lock never permanently blocks execution
            let lockTimer;
            try {
                await Promise.race([
                    prevLock.catch(() => {}),
                    new Promise((resolve) => {
                        lockTimer = setTimeout(resolve, 8000);
                        if (typeof lockTimer?.unref === 'function') lockTimer.unref();
                    })
                ]);
            } finally {
                if (lockTimer) clearTimeout(lockTimer);
            }
            const waitMs = Date.now() - startWait;
            startHeld = Date.now();

            const result = await fn();
            const heldMs = Date.now() - startHeld;
            if (waitMs > 25 || heldMs > 50) {
                logger.info(`[LOCK-DIAG] guild="${guildId}" lockWaitDuration=${waitMs}ms lockHeldDuration=${heldMs}ms`);
            }
            return result;
        } catch (err) {
            const heldMs = startHeld ? (Date.now() - startHeld) : 0;
            const waitMs = Date.now() - startWait;
            if (waitMs > 25 || heldMs > 50) {
                logger.info(`[LOCK-DIAG] guild="${guildId}" lockWaitDuration=${waitMs}ms lockHeldDuration=${heldMs}ms error="${err?.message || err}"`);
            }
            throw err;
        } finally {
            unlock();
            if (this.guildLocks.get(guildId) === nextLock) {
                this.guildLocks.delete(guildId);
            }
        }
    }

    trackStaleMessage(guildId, channelId, messageId) {
        if (!guildId || !messageId) return;
        if (!this.staleMessages.has(guildId)) {
            this.staleMessages.set(guildId, new Set());
        }
        this.staleMessages.get(guildId).add(JSON.stringify({ channelId, messageId }));
    }

    async cleanupStaleMessages(guildId) {
        const staleSet = this.staleMessages.get(guildId);
        if (!staleSet || staleSet.size === 0) return;

        const currentDashboard = this.getDashboard(guildId);
        const currentActiveId = currentDashboard?.messageId;

        for (const itemStr of Array.from(staleSet)) {
            let item;
            try {
                item = JSON.parse(itemStr);
            } catch {
                staleSet.delete(itemStr);
                continue;
            }

            const { channelId, messageId } = item;
            // Never delete the currently active dashboard message
            if (messageId === currentActiveId) {
                staleSet.delete(itemStr);
                continue;
            }

            try {
                const channel = this.client.channels?.cache?.get(channelId)
                    || (this.client.channels?.fetch ? await this.client.channels.fetch(channelId).catch(() => null) : null);
                if (!channel) {
                    staleSet.delete(itemStr);
                    continue;
                }

                const msg = channel.messages?.cache?.get(messageId)
                    || (channel.messages?.fetch ? await channel.messages.fetch(messageId).catch((fetchErr) => {
                        // Discord error code 10008 = Unknown Message (already removed)
                        if (fetchErr.code === 10008) return null;
                        throw fetchErr;
                    }) : null);

                if (msg && typeof msg.delete === 'function') {
                    await msg.delete();
                    logger.info(`[DASHBOARD-DIAG] [DELETION_OUTCOME] Deleted old dashboard message ${messageId} in guild ${guildId}`);
                }
                staleSet.delete(itemStr);
            } catch (err) {
                if (err.code === 10008) {
                    logger.info(`[DASHBOARD-DIAG] [DELETION_OUTCOME] Stale dashboard message ${messageId} in guild ${guildId} already removed (Unknown Message 10008)`);
                    staleSet.delete(itemStr);
                } else {
                    logger.debug(`Failed to delete stale dashboard message ${messageId} in guild ${guildId}, will retry:`, err?.message || err);
                }
            }
        }

        if (staleSet.size === 0) {
            this.staleMessages.delete(guildId);
        }
    }

    createPlayerEmbed(player, track) {
        if (!player || (player.playing === false && !player.paused) || !track) {
            return createStoppedEmbed(player, this.client);
        }
        return createNowPlayingEmbed(player, track, this.client);
    }

    createPlayerButtons(player) {
        if (!player || (player.playing === false && !player.paused) || player.stopped === true || !player.queue?.current) {
            return this.createStoppedButtons(player);
        }
        const guildId = player.guildId || player.guild?.id || player.options?.guildId;
        if (guildId && isManualStopActive(guildId)) {
            return this.createStoppedButtons(player);
        }
        if (typeof player.getData === 'function' && (player.getData('internal_stopPlaying') || player.getData('internal_autoplayStopPlaying'))) {
            return this.createStoppedButtons(player);
        }

        const isPaused = Boolean(player.paused);
        const hasPrevious = Boolean(player.queue?.previous && player.queue.previous.length > 0);
        const isAutoplay = Boolean(this.client.autoplayEnabled?.get(player.guildId));
        const canShuffle = Boolean(player.queue?.tracks && player.queue.tracks.length >= 2);

        let loopLabel = 'Loop: Off';
        let loopStyle = ButtonStyle.Secondary;
        let loopEmoji = '🔁';

        if (player.repeatMode === 'track') {
            loopLabel = 'Loop: Track';
            loopStyle = ButtonStyle.Success;
            loopEmoji = '🔂';
        } else if (player.repeatMode === 'queue') {
            loopLabel = 'Loop: Queue';
            loopStyle = ButtonStyle.Success;
            loopEmoji = '🔁';
        }

        // Row 1: Primary Controls
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('player:playpause')
                .setLabel(isPaused ? 'Resume' : 'Pause')
                .setEmoji(isPaused ? '▶️' : '⏸️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('player:skip')
                .setLabel('Skip')
                .setEmoji('⏭️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('player:shuffle')
                .setLabel('Shuffle')
                .setEmoji('🔀')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canShuffle),
            new ButtonBuilder()
                .setCustomId('player:stop')
                .setLabel('Stop')
                .setEmoji('🟥')
                .setStyle(ButtonStyle.Danger)
        );

        // Row 2: Secondary Controls
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('player:back')
                .setLabel('Previous')
                .setEmoji('⏮️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!hasPrevious),
            new ButtonBuilder()
                .setCustomId('player:autoplay')
                .setLabel('Autoplay')
                .setEmoji('📻')
                .setStyle(isAutoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('player:queue')
                .setLabel('Queue')
                .setEmoji('📜')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('player:loop')
                .setLabel(loopLabel)
                .setEmoji(loopEmoji)
                .setStyle(loopStyle)
                .setDisabled(false)
        );

        return [row1, row2];
    }

    createStoppedButtons(player) {
        return [];
    }

    /**
     * Replaces the player dashboard with a full, complete dashboard at the bottom of the target text channel.
     * Persists the new message ID and cleans up the previous dashboard only after successful send.
     * @param {string} guildId
     * @param {string} [channelId]
     * @param {object} [options]
     */
    async replaceWithFullDashboard(guildId, channelId = null, options = {}) {
        return this.sendReplacementPlayer(guildId, {
            ...options,
            channelId: channelId || options.channelId,
            replace: true,
            force: options.force === true,
        });
    }

    async sendReplacementPlayer(guildId, options = {}) {
        return this.runWithGuildLock(guildId, async () => {
            const player = this.client.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;
            const isStopped = Boolean(options.stopped);
            const isUnavailable = Boolean(options.unavailable);

            const isLavalinkAvailable = Boolean(this.client.lavalinkConnectionManager?.isAvailable?.());
            const currentTrack = player?.queue?.current || options.track;
            const hasLiveTrack = Boolean(
                player &&
                currentTrack &&
                !isStopped
            );

            // If not actively playing and not explicit unavailable, ensure we treat as stopped
            const renderStopped = isStopped || (!isUnavailable && !hasLiveTrack);
            const renderUnavailable = isUnavailable || (!isLavalinkAvailable && !hasLiveTrack && options.allowUnavailable);

            if (!player && !renderStopped && !renderUnavailable) {
                await this.deletePlayer(guildId);
                return null;
            }

            const currentDashboard = this.getDashboard(guildId);
            const channel = await this.resolvePlayerChannel(guildId, options, player);
            if (!channel) return null;

            let embed;
            let components;

            if (renderUnavailable) {
                embed = createUnavailableEmbed(player || { guildId }, this.client);
                components = this.createStoppedButtons(player || { guildId });
            } else if (renderStopped) {
                embed = createStoppedEmbed(player || { guildId }, this.client, player?.voiceChannelId || this.client?.guildSettings?.get(guildId)?.voiceChannelId);
                components = this.createStoppedButtons(player || { guildId });
            } else {
                embed = this.createPlayerEmbed(player, currentTrack);
                components = this.createPlayerButtons(player);
            }

            // If a replacement dashboard was recently created for this exact same state at the bottom
            // (e.g. concurrent command, trackStart, or multiple stop/queueEnd/trackEnd events), update in-place instead of creating duplicate messages.
            const currentTrackId = currentTrack?.info?.identifier
                || currentTrack?.identifier
                || currentTrack?.info?.uri
                || currentTrack?.uri
                || currentTrack?.info?.title;

            const stateId = renderUnavailable
                ? 'UNAVAILABLE'
                : (renderStopped ? 'IDLE' : (currentTrackId || 'PLAYING'));

            const now = Date.now();
            const lastRep = this.lastReplacement.get(guildId);
            const lastQueueTime = this.lastQueueRefresh?.get(guildId) || 0;
            const isSameState = Boolean(lastRep && lastRep.trackId === stateId);
            const isQueueInteraction = options.reason === 'queue';
            const recentQueueRefresh = isQueueInteraction && isSameState && (now - lastQueueTime) < 2500;

            const isRecentStateReplacement = !isQueueInteraction && isSameState &&
                lastRep.messageId === currentDashboard?.messageId &&
                (now - lastRep.timestamp) < 2500;

            // Consolidate rapid idle transitions (e.g. /stop, queueEnd, trackEnd, playerDestroy during same transition)
            const isDuplicateIdle = renderStopped && isSameState && (now - lastRep.timestamp) < 5000;

            // Update in-place to prevent duplicate messages if:
            // 1. Not explicitly forced
            // 2. AND message exists in the target channel
            // 3. AND either explicitly requested in-place / recovery update
            // 4. OR replace is explicitly false (e.g. queue update, volume change, loop change)
            // 5. OR player is in stopped/unavailable state (edit existing message to show stopped embed)
            // 6. OR concurrent queue click occurred when dashboard was already refreshed to bottom within debounce window
            // 7. OR concurrent track replacement for same song within debounce window
            // 8. OR duplicate stop / idle event within consolidation window
            const canDeduplicate = !options.force &&
                currentDashboard?.messageId &&
                (
                    options.inPlace === true ||
                    options.replace === false ||
                    renderStopped ||
                    options.reason === 'recovery' ||
                    (isQueueInteraction && recentQueueRefresh) ||
                    (stateId && (isRecentStateReplacement || isDuplicateIdle))
                );

            if (canDeduplicate) {
                try {
                    const targetChannel = (currentDashboard?.channelId && currentDashboard.channelId !== channel.id)
                        ? (this.client.channels?.cache?.get(currentDashboard.channelId)
                            || (this.client.channels?.fetch ? await this.client.channels.fetch(currentDashboard.channelId).catch(() => null) : null)
                            || channel)
                        : channel;
                    const existingMsg = targetChannel.messages?.cache?.get(currentDashboard.messageId)
                        || (targetChannel.messages?.fetch ? await targetChannel.messages.fetch(currentDashboard.messageId).catch((fetchErr) => {
                            if (fetchErr.code === 10008) {
                                logger.warn(`[DASHBOARD-DIAG] Dashboard message ${currentDashboard.messageId} was deleted externally for guild ${guildId}. Clearing stale reference.`);
                                if (currentDashboard?.messageId) {
                                    this.deleteDashboard(guildId);
                                }
                                return null;
                            }
                            if (fetchErr.code === 10003) {
                                logger.warn(`[DASHBOARD-DIAG] Failed to fetch message: Channel ${channel.id} is Unknown Channel (code 10003).`);
                                if (currentDashboard?.channelId === channel.id) {
                                    this.deleteDashboard(guildId);
                                }
                                return null;
                            }
                            if (fetchErr.code === 50013 || fetchErr.code === 50001 || fetchErr.status === 403) {
                                logger.warn(`[DASHBOARD-DIAG] Missing permissions to fetch dashboard message in channel ${channel.id}: ${fetchErr.message}`);
                                return null;
                            }
                            throw fetchErr;
                        }) : null);
                    if (existingMsg && typeof existingMsg.edit === 'function') {
                        await existingMsg.edit({ embeds: [embed], components });
                        this.lastReplacement.set(guildId, {
                            trackId: stateId,
                            messageId: existingMsg.id,
                            timestamp: now,
                        });
                        logger.info(`[DASHBOARD-DIAG] Deduplicated dashboard update in-place for guild ${guildId} (State: ${stateId}, Message ID: ${existingMsg.id})`);
                        logger.info(`[LIFECYCLE-DIAG] [DASHBOARD_UPDATED] guild="${guildId}" messageId="${existingMsg.id}" state="${stateId}" inPlace=true`);
                        return existingMsg;
                    }
                } catch (editErr) {
                    if (editErr.code === 10008) {
                        logger.warn(`[DASHBOARD-DIAG] Failed to edit dashboard in-place: Message ${currentDashboard?.messageId} is Unknown Message (code 10008). Clearing stale dashboard.`);
                        if (currentDashboard?.messageId) {
                            this.deleteDashboard(guildId);
                        }
                    } else if (editErr.code === 10003) {
                        logger.warn(`[DASHBOARD-DIAG] Failed to edit dashboard in-place: Channel ${channel.id} is Unknown Channel (code 10003). Clearing stale dashboard.`);
                        if (currentDashboard?.channelId === channel.id) {
                            this.deleteDashboard(guildId);
                        }
                    } else if (editErr.code === 50013 || editErr.code === 50001 || editErr.status === 403) {
                        logger.warn(`[DASHBOARD-DIAG] Missing permissions to edit dashboard in channel ${channel.id}: ${editErr?.message || editErr}`);
                    } else {
                        logger.debug('Failed to update recent replacement message in-place, creating new:', editErr?.message || editErr);
                    }
                }
            }

            // 1. Create the updated dashboard as a new message at the bottom of the channel.
            logger.info(`[DASHBOARD-DIAG] [ATTEMPT] Publishing full dashboard for guild ${guildId} to #${channel.name || channel.id} (track: ${currentTrack?.info?.title || stateId})`);
            let newMessage;
            try {
                newMessage = await channel.send({ embeds: [embed], components });
            } catch (err) {
                if (err.code === 10003) {
                    logger.warn(`[DASHBOARD-DIAG] [SEND_FAILED] Failed to send replacement dashboard for guild ${guildId}: Channel ${channel.id} is Unknown Channel (code 10003). Clearing stale dashboard reference.`);
                    if (currentDashboard?.channelId === channel.id) {
                        this.deleteDashboard(guildId);
                    }
                    const configuredChannelId = this.client?.guildSettings?.get?.(guildId)?.textChannelId;
                    if (configuredChannelId === channel.id) {
                        this.client?.guildSettings?.invalidateTextChannel?.(guildId);
                    }
                    return null;
                }

                if (err.code === 50013 || err.code === 50001 || err.status === 403) {
                    logger.warn(`[DASHBOARD-DIAG] [SEND_FAILED] Missing permissions (code ${err.code || 403}) to send replacement dashboard in channel ${channel.id} for guild ${guildId}: ${err?.message || err}`);
                    // Fall back to alternative accessible channel in guild if available
                    const fallbackChannel = await this.resolvePlayerChannel(guildId, { ...options, channelId: null, excludeChannelId: channel.id }, player);
                    if (fallbackChannel && fallbackChannel.id !== channel.id) {
                        try {
                            newMessage = await fallbackChannel.send({ embeds: [embed], components });
                            channel = fallbackChannel;
                        } catch (fallbackErr) {
                            logger.warn(`[DASHBOARD-DIAG] Fallback channel send failed:`, fallbackErr?.message || fallbackErr);
                            return null;
                        }
                    } else {
                        return null;
                    }
                }

                logger.error(`[DASHBOARD-DIAG] [SEND_FAILED] Failed to send replacement dashboard for guild ${guildId}:`, err?.message || err);
                // 5. If sending replacement fails, keep previous dashboard and stored ID intact.
                return null;
            }

            if (!newMessage || !newMessage.id) {
                logger.error(`Discord did not return a valid message object when sending dashboard for guild ${guildId}`);
                return null;
            }

            logger.info(`[DASHBOARD-DIAG] [SEND_SUCCESS] Published full dashboard for guild ${guildId} messageId=${newMessage.id} channelId=${channel.id}`);
            if (player) {
                player.textChannelId = channel.id;
            }

            const oldMessageId = currentDashboard?.messageId;
            const oldChannelId = currentDashboard?.channelId || channel.id;

            // 3 & 8. Update in-memory and persistent storage with latest dashboard message ID
            this.setDashboard(guildId, {
                messageId: newMessage.id,
                channelId: channel.id,
            });

            // Persist the corrected channel ID in guildSettings only after a successful dashboard send
            const configuredChannelId = this.client?.guildSettings?.get?.(guildId)?.textChannelId;
            if (configuredChannelId !== channel.id && typeof this.client?.guildSettings?.updateTextChannelId === 'function') {
                this.client.guildSettings.updateTextChannelId(guildId, channel.id);
            }

            this.lastReplacement.set(guildId, {
                trackId: stateId,
                messageId: newMessage.id,
                timestamp: Date.now(),
            });

            if (options.reason === 'queue') {
                this.lastQueueRefresh.set(guildId, Date.now());
            }

            logger.info(`[DASHBOARD-DIAG] Published full player dashboard for guild ${guildId} at bottom of #${channel.name || channel.id} (State: ${stateId}, Message ID: ${newMessage.id})`);
            logger.info(`[LIFECYCLE-DIAG] [DASHBOARD_UPDATED] guild="${guildId}" messageId="${newMessage.id}" state="${stateId}" inPlace=false`);

            // 3 & 6. Queue previous dashboard message for safe deletion and retry
            if (oldMessageId && oldMessageId !== newMessage.id) {
                this.trackStaleMessage(guildId, oldChannelId, oldMessageId);
            }

            // Cleanup stale messages asynchronously in the background so callers are not blocked on Discord REST deletes
            this.cleanupStaleMessages(guildId).catch((err) => {
                logger.debug(`Background stale message cleanup error for guild ${guildId}:`, err?.message || err);
            });

            return newMessage;
        });
    }

    async sendPlayer(channel, player) {
        return this.sendReplacementPlayer(player.guildId, { channelId: channel.id });
    }

    async sendToPlayerChannel(guildId, content) {
        try {
            const channelId = this.getDashboard(guildId)?.channelId
                ?? this.client.lavalink?.getPlayer?.(guildId)?.textChannelId;
            if (!channelId) return;

            const channel = this.client.channels?.cache?.get(channelId)
                || (this.client.channels?.fetch ? await this.client.channels.fetch(channelId).catch(() => null) : null);
            if (!channel || typeof channel.send !== 'function') return;

            const perm = this.checkChannelPermissions(channel);
            if (!perm.ok) return;

            await channel.send({ content, allowedMentions: { parse: [] } });
        } catch (error) {
            logger.debug('Failed to send player channel message:', error?.message || error);
        }
    }

    async updatePlayer(guildId, options = {}) {
        const replace = options.replace !== false; // Default: true (always position at bottom)
        if (replace) {
            return this.sendReplacementPlayer(guildId, options);
        }

        // replace is explicitly false (e.g. track added to queue without changing current song)
        return this.runWithGuildLock(guildId, async () => {
            const player = this.client.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;
            if (!player || !player.queue?.current) return null;

            const currentDashboard = this.getDashboard(guildId);
            const channel = await this.resolvePlayerChannel(guildId, options, player);
            if (!channel) return null;

            const embed = this.createPlayerEmbed(player, player.queue.current);
            const components = this.createPlayerButtons(player);

            if (currentDashboard?.messageId) {
                try {
                    const message = channel.messages?.cache?.get(currentDashboard.messageId)
                        || (channel.messages?.fetch ? await channel.messages.fetch(currentDashboard.messageId).catch((fetchErr) => {
                            if (fetchErr.code === 10008) {
                                logger.warn(`[DASHBOARD-DIAG] Dashboard message ${currentDashboard.messageId} was deleted externally for guild ${guildId}. Clearing stale reference.`);
                                if (currentDashboard?.messageId) {
                                    this.deleteDashboard(guildId);
                                }
                                return null;
                            }
                            if (fetchErr.code === 10003) {
                                logger.warn(`[DASHBOARD-DIAG] Channel ${channel.id} returned Unknown Channel (code 10003) on message fetch. Clearing stale dashboard.`);
                                if (currentDashboard?.channelId === channel.id) {
                                    this.deleteDashboard(guildId);
                                }
                                return null;
                            }
                            if (fetchErr.code === 50013 || fetchErr.code === 50001 || fetchErr.status === 403) {
                                logger.warn(`[DASHBOARD-DIAG] Missing permissions to fetch dashboard message in channel ${channel.id}: ${fetchErr.message}`);
                                return null;
                            }
                            return null;
                        }) : null);
                    if (message && typeof message.edit === 'function') {
                        await message.edit({ embeds: [embed], components });
                        const configuredChannelId = this.client?.guildSettings?.get?.(guildId)?.textChannelId;
                        if (configuredChannelId !== channel.id && typeof this.client?.guildSettings?.updateTextChannelId === 'function') {
                            this.client.guildSettings.updateTextChannelId(guildId, channel.id);
                        }
                        return message;
                    }
                } catch (editError) {
                    if (editError.code === 10008) {
                        logger.warn(`[DASHBOARD-DIAG] In-place edit failed: Message ${currentDashboard?.messageId} is Unknown Message (code 10008). Clearing stale dashboard.`);
                        if (currentDashboard?.messageId) {
                            this.deleteDashboard(guildId);
                        }
                    } else if (editError.code === 10003) {
                        logger.warn(`[DASHBOARD-DIAG] In-place edit failed: Channel ${channel.id} is Unknown Channel (code 10003). Clearing stale dashboard.`);
                        if (currentDashboard?.channelId === channel.id) {
                            this.deleteDashboard(guildId);
                        }
                        const configuredChannelId = this.client?.guildSettings?.get?.(guildId)?.textChannelId;
                        if (configuredChannelId === channel.id) {
                            this.client?.guildSettings?.invalidateTextChannel?.(guildId);
                        }
                    } else if (editError.code === 50013 || editError.code === 50001 || editError.status === 403) {
                        logger.warn(`[DASHBOARD-DIAG] Missing permissions to edit dashboard message in channel ${channel.id}: ${editError?.message || editError}`);
                    } else {
                        logger.debug('Error editing existing dashboard message in-place, falling back to replacement:', editError?.message || editError);
                    }
                }
            }

            // If no existing message or in-place edit failed, safely create replacement at bottom
            let newMessage;
            try {
                newMessage = await channel.send({ embeds: [embed], components });
            } catch (err) {
                if (err.code === 10003) {
                    logger.warn(`[DASHBOARD-DIAG] Failed to send fallback replacement dashboard for guild ${guildId}: Channel ${channel.id} is Unknown Channel (code 10003). Clearing stale dashboard.`);
                    if (currentDashboard?.channelId === channel.id) {
                        this.deleteDashboard(guildId);
                    }
                    const configuredChannelId = this.client?.guildSettings?.get?.(guildId)?.textChannelId;
                    if (configuredChannelId === channel.id) {
                        this.client?.guildSettings?.invalidateTextChannel?.(guildId);
                    }
                    return null;
                }
                if (err.code === 50013 || err.code === 50001 || err.status === 403) {
                    logger.warn(`[DASHBOARD-DIAG] Missing permissions to send fallback replacement dashboard in channel ${channel.id} for guild ${guildId}: ${err?.message || err}`);
                    return null;
                }
                logger.error(`Failed to send fallback replacement dashboard for guild ${guildId}:`, err?.message || err);
                return null;
            }

            const oldMessageId = currentDashboard?.messageId;
            const oldChannelId = currentDashboard?.channelId || channel.id;

            this.setDashboard(guildId, {
                messageId: newMessage.id,
                channelId: channel.id,
            });

            // Persist the corrected channel ID only after a successful dashboard send
            const configuredChannelId = this.client?.guildSettings?.get?.(guildId)?.textChannelId;
            if (configuredChannelId !== channel.id && typeof this.client?.guildSettings?.updateTextChannelId === 'function') {
                this.client.guildSettings.updateTextChannelId(guildId, channel.id);
            }

            if (oldMessageId && oldMessageId !== newMessage.id) {
                this.trackStaleMessage(guildId, oldChannelId, oldMessageId);
            }

            // Cleanup stale messages asynchronously in the background so callers are not blocked on Discord REST deletes
            this.cleanupStaleMessages(guildId).catch((err) => {
                logger.debug(`Background stale message cleanup error for guild ${guildId}:`, err?.message || err);
            });

            return newMessage;
        });
    }

    async showStoppedState(guildId, options = {}) {
        return this.sendReplacementPlayer(guildId, { ...options, stopped: true, inPlace: true });
    }

    async showUnavailableState(guildId, options = {}) {
        return this.sendReplacementPlayer(guildId, { ...options, unavailable: true });
    }

    /**
     * Reconciles all stored dashboard messages with the real Lavalink player state.
     * Prevents ghost dashboards from showing stale tracks after restart or reconnection.
     */
    async reconcileAllDashboards() {
        const guildIds = new Set();
        if (this.client?.guildSettings?.cache) {
            for (const guildId of this.client.guildSettings.cache.keys()) {
                guildIds.add(guildId);
            }
        }
        if (this.client?.guilds?.cache) {
            for (const guildId of this.client.guilds.cache.keys()) {
                guildIds.add(guildId);
            }
        }
        if (this.client?.lavalink?.players) {
            const players = this.client.lavalink.players.values ? Array.from(this.client.lavalink.players.values()) : [];
            for (const player of players) {
                if (player?.guildId) guildIds.add(player.guildId);
            }
        }

        for (const guildId of guildIds) {
            try {
                await this.reconcileDashboard(guildId);
            } catch (err) {
                logger.debug(`Failed to reconcile dashboard for guild ${guildId}:`, err?.message || err);
            }
        }
    }

    /**
     * Reconciles a single guild's dashboard message with actual player and track state.
     * Safely refreshes any existing Discord dashboard message to remove retired buttons.
     * @param {string} guildId
     */
    async reconcileDashboard(guildId) {
        return this.runWithGuildLock(guildId, async () => {
            let dashboard = this.getDashboard(guildId);
            const player = this.client.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;
            const isPlaying = Boolean(
                player &&
                player.queue?.current &&
                (player.playing || player.paused)
            );
            const is247 = Boolean(this.client.is247Enabled?.(guildId));

            const channel = await this.resolvePlayerChannel(guildId, {}, player);
            if (!channel) return;

            // Search recent channel messages to locate existing bot dashboard messages
            let discoveredMessage = null;
            if (typeof channel.messages?.fetch === 'function') {
                try {
                    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
                    if (recentMessages && recentMessages.size > 0) {
                        const botDashboards = [];
                        for (const [, msg] of recentMessages) {
                            if (msg.author?.id === this.client.user?.id && msg.components?.length > 0) {
                                const hasPlayerBtn = msg.components.some(row =>
                                    (row.components || []).some(c => (c.customId || c.data?.custom_id || '').startsWith('player:'))
                                );
                                if (hasPlayerBtn) {
                                    botDashboards.push(msg);
                                }
                            }
                        }

                        if (botDashboards.length > 0) {
                            botDashboards.sort((a, b) => BigInt(b.id) - BigInt(a.id));
                            discoveredMessage = botDashboards[0];
                            if (!dashboard?.messageId) {
                                dashboard = {
                                    messageId: discoveredMessage.id,
                                    channelId: channel.id,
                                };
                                this.setDashboard(guildId, dashboard);
                            }

                            // Clean up any older duplicate dashboards in this channel to prevent spam
                            for (let i = 1; i < botDashboards.length; i++) {
                                const dup = botDashboards[i];
                                this.trackStaleMessage(guildId, channel.id, dup.id);
                            }
                            if (botDashboards.length > 1) {
                                this.cleanupStaleMessages(guildId).catch(() => {});
                            }
                        }
                    }
                } catch (findErr) {
                    logger.debug(`Could not search recent channel messages in guild ${guildId}:`, findErr?.message || findErr);
                }
            }

            if (!dashboard?.messageId && !discoveredMessage && !isPlaying && !is247) return;

            const isLavalinkAvailable = Boolean(this.client.lavalinkConnectionManager?.isAvailable?.());

            // Sync voice channel status with real player state
            this.client.voiceChannelStatusManager?.syncGuildPlayerStatus?.(guildId).catch(() => {});

            let embed;
            let components;

            if (!isLavalinkAvailable) {
                embed = createUnavailableEmbed(player || { guildId }, this.client);
                components = this.createStoppedButtons(player || { guildId });
            } else if (isPlaying) {
                embed = this.createPlayerEmbed(player, player.queue.current);
                components = this.createPlayerButtons(player);
            } else if (is247) {
                embed = createStoppedEmbed(player || { guildId }, this.client, player?.voiceChannelId || this.client.guildSettings?.get(guildId)?.voiceChannelId);
                components = this.createStoppedButtons(player || { guildId });
            } else {
                // Not playing and not 24/7: delete the stale ghost dashboard message
                const msgIdToDelete = dashboard?.messageId || discoveredMessage?.id;
                if (msgIdToDelete) {
                    this.trackStaleMessage(guildId, channel.id, msgIdToDelete);
                    this.deleteDashboard(guildId);
                    await this.cleanupStaleMessages(guildId);
                }
                return;
            }

            // Edit the existing dashboard message in-place to strip retired buttons and sync UI
            let message = discoveredMessage;
            const targetChannel = (dashboard?.channelId && dashboard.channelId !== channel.id)
                ? (this.client.channels?.cache?.get(dashboard.channelId)
                    || (this.client.channels?.fetch ? await this.client.channels.fetch(dashboard.channelId).catch(() => null) : null)
                    || channel)
                : channel;
            if (!message && dashboard?.messageId) {
                try {
                    message = targetChannel.messages?.cache?.get(dashboard.messageId)
                        || (targetChannel.messages?.fetch ? await targetChannel.messages.fetch(dashboard.messageId).catch((fetchErr) => {
                            if (fetchErr.code === 10008) return null;
                            if (fetchErr.code === 10003) {
                                logger.warn(`[DASHBOARD-DIAG] Reconciliation message fetch: Channel ${channel.id} is Unknown Channel (code 10003). Clearing stale dashboard.`);
                                this.deleteDashboard(guildId);
                                return null;
                            }
                            if (fetchErr.code === 50013 || fetchErr.code === 50001 || fetchErr.status === 403) {
                                logger.warn(`[DASHBOARD-DIAG] Missing permissions to fetch dashboard message in channel ${channel.id}: ${fetchErr.message}`);
                                return null;
                            }
                            return null;
                        }) : null);
                } catch (fetchErr) {
                    message = null;
                }
            }

            if (message && typeof message.edit === 'function') {
                try {
                    await message.edit({ embeds: [embed], components });
                    logger.debug(`Reconciled and safely refreshed dashboard message in guild ${guildId} (Message ID: ${message.id})`);
                    return message;
                } catch (editErr) {
                    if (editErr.code === 10003) {
                        logger.warn(`[DASHBOARD-DIAG] Reconciliation in-place edit failed: Channel ${channel.id} is Unknown Channel (code 10003). Clearing stale dashboard.`);
                        this.deleteDashboard(guildId);
                    } else if (editErr.code === 50013 || editErr.code === 50001 || editErr.status === 403) {
                        logger.warn(`[DASHBOARD-DIAG] Missing permissions to edit dashboard message in channel ${channel.id}: ${editErr?.message || editErr}`);
                    } else {
                        logger.debug(`Existing dashboard message fetch/edit failed in guild ${guildId}:`, editErr?.message || editErr);
                    }
                }
            }

            // If message was deleted or couldn't be edited, and player is playing or 24/7 is enabled:
            // Safely recreate the full dashboard at the bottom!
            if (isPlaying || is247) {
                logger.info(`Recreating missing/deleted dashboard for guild ${guildId} at bottom of #${channel.name || channel.id}`);
                try {
                    const newMessage = await channel.send({ embeds: [embed], components });
                    this.setDashboard(guildId, {
                        messageId: newMessage.id,
                        channelId: channel.id,
                    });
                    if (player) {
                        player.textChannelId = channel.id;
                    }
                    if (dashboard?.messageId && dashboard.messageId !== newMessage.id) {
                        this.trackStaleMessage(guildId, dashboard.channelId, dashboard.messageId);
                    }
                    await this.cleanupStaleMessages(guildId);
                    return newMessage;
                } catch (sendErr) {
                    if (sendErr.code === 10003) {
                        logger.warn(`[DASHBOARD-DIAG] Recreate dashboard on reconciliation failed: Channel ${channel.id} is Unknown Channel (code 10003). Clearing stale dashboard reference.`);
                        this.deleteDashboard(guildId);
                        return null;
                    }
                    if (sendErr.code === 50013 || sendErr.code === 50001 || sendErr.status === 403) {
                        logger.warn(`[DASHBOARD-DIAG] Missing permissions to recreate dashboard on reconciliation in channel ${channel.id}: ${sendErr?.message || sendErr}`);
                        return null;
                    }
                    logger.error(`Failed to recreate dashboard on reconciliation for guild ${guildId}:`, sendErr?.message || sendErr);
                    return null;
                }
            }
        });
    }

    async deletePlayer(guildId) {
        return this.runWithGuildLock(guildId, async () => {
            const currentDashboard = this.getDashboard(guildId);
            if (currentDashboard?.messageId) {
                this.trackStaleMessage(guildId, currentDashboard.channelId, currentDashboard.messageId);
            }
            this.deleteDashboard(guildId);
            await this.cleanupStaleMessages(guildId);
        });
    }
}

module.exports = PlayerController;
