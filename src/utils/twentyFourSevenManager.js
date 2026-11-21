const { PermissionsBitField } = require('discord.js');
const logger = require('./logger');

/**
 * Manages the coordinated 24/7 reconnection lifecycle across Discord voice disconnects,
 * node reconnects, and permission/channel validation.
 */
class TwentyFourSevenManager {
    constructor() {
        // Map<guildId, { generation: number, timer: NodeJS.Timeout, inFlight: boolean, attempts: number, savedState: Object, targetChannelId: string }>
        this.sessions = new Map();
        this.BACKOFF_DELAYS = [2000, 5000, 10000, 15000, 20000];
        this.MAX_ATTEMPTS = 10;
    }

    /**
     * Checks if a reconnection attempt is currently pending or in flight for this guild.
     *
     * @param {string} guildId
     * @returns {boolean}
     */
    isReconnecting(guildId) {
        return this.sessions.has(guildId);
    }

    /**
     * Cancels any pending 24/7 auto-recovery callbacks or timers for a guild.
     *
     * @param {string} guildId
     * @param {string} [reason='cancelled']
     */
    cancelRecovery(guildId, reason = 'cancelled') {
        const session = this.sessions.get(guildId);
        if (session) {
            if (session.timer) {
                clearTimeout(session.timer);
            }
            this.sessions.delete(guildId);
            logger.debug(`[247-LIFECYCLE] Cancelled 24/7 recovery for guild ${guildId} (reason: ${reason})`);
        }
    }

    /**
     * Called when the bot is moved to a different voice channel.
     * Cancels pending recoveries and synchronizes the active 24/7 voiceChannelId.
     *
     * @param {Object} client
     * @param {string} guildId
     * @param {string} newChannelId
     */
    handleChannelMove(client, guildId, newChannelId) {
        this.cancelRecovery(guildId, 'channel_moved');
        if (client?.is247Enabled?.(guildId) && newChannelId) {
            // Guard against recording an AFK channel as the 24/7 channel
            const guild = client.guilds?.cache?.get(guildId);
            if (guild?.afkChannelId && newChannelId === guild.afkChannelId) {
                logger.warn(`[247-LIFECYCLE] Suppressed updating 24/7 channel to AFK channel (${newChannelId}) in guild ${guildId}`);
                return;
            }
            client.set247?.(guildId, true, { voiceChannelId: newChannelId });
            logger.debug(`[247-LIFECYCLE] Updated 24/7 designated channel to #${newChannelId} in guild ${guildId}`);
        }
    }

    /**
     * Schedules an auto-recovery attempt after an unexpected voice disconnection.
     *
     * @param {Object} client
     * @param {string} guildId
     * @param {string} oldChannelId
     * @param {string} [reason='unexpected_disconnect']
     */
    scheduleAutoRecovery(client, guildId, oldChannelId, reason = 'unexpected_disconnect') {
        if (!client?.is247Enabled?.(guildId)) {
            return;
        }

        const existing = this.sessions.get(guildId);
        const nextGen = (existing?.generation || 0) + 1;
        const attempts = existing ? existing.attempts : 0;

        const isNodeWaiting = reason === 'node_reconnecting' || reason === 'fetch_retry';
        const nextAttempts = isNodeWaiting ? attempts : attempts + 1;

        if (attempts >= this.MAX_ATTEMPTS) {
            logger.warn(`[247-LIFECYCLE] Max recovery attempts (${this.MAX_ATTEMPTS}) reached for guild ${guildId}. Aborting auto-recovery to prevent infinite loop.`);
            this.cancelRecovery(guildId, 'max_attempts_exceeded');
            return;
        }

        // Capture current playback state before player cleanup
        const player = client.lavalink?.getPlayer?.(guildId);
        const savedState = existing?.savedState || {
            wasPlaying: Boolean(player?.playing && player?.queue?.current),
            track: player?.queue?.current ? { ...player.queue.current } : null,
            position: player?.position || 0,
            queue: player?.queue?.tracks ? [...player.queue.tracks] : [],
        };

        if (existing?.timer) {
            clearTimeout(existing.timer);
        }

        const delay = this.BACKOFF_DELAYS[Math.min(attempts, this.BACKOFF_DELAYS.length - 1)] || 10000;
        logger.warn(`[247-LIFECYCLE] Baduwa was disconnected from voice channel in guild ${guildId} while 24/7 is enabled (reason: ${reason}). Scheduling auto-recovery attempt ${attempts + 1}/${this.MAX_ATTEMPTS} in ${delay}ms (gen: ${nextGen})...`);

        const timer = setTimeout(async () => {
            await this.executeRecovery(client, guildId, nextGen);
        }, delay);

        this.sessions.set(guildId, {
            generation: nextGen,
            timer,
            inFlight: false,
            attempts: nextAttempts,
            savedState,
            targetChannelId: oldChannelId,
        });
    }

    /**
     * Executes the actual voice reconnection attempt with strict validation of guild,
     * channel existence, permissions, and node availability.
     *
     * @param {Object} client
     * @param {string} guildId
     * @param {number} expectedGen
     */
    async executeRecovery(client, guildId, expectedGen) {
        const session = this.sessions.get(guildId);
        if (!session || session.generation !== expectedGen) {
            return; // Stale or superseded recovery attempt
        }

        if (!client?.is247Enabled?.(guildId)) {
            logger.debug(`[247-LIFECYCLE] 24/7 mode disabled during recovery window for guild ${guildId}; aborting.`);
            this.cancelRecovery(guildId, 'mode_disabled');
            return;
        }

        session.inFlight = true;

        try {
            // 1. Resolve guild
            const guild = client.guilds?.cache?.get(guildId)
                || (typeof client.guilds?.fetch === 'function' ? await client.guilds.fetch(guildId).catch(() => null) : null);

            if (!guild) {
                logger.warn(`[247-LIFECYCLE] Bot is no longer in guild ${guildId}. Aborting 24/7 recovery.`);
                this.cancelRecovery(guildId, 'bot_removed_from_guild');
                return;
            }

            // 2. Resolve bot member
            const botMember = guild.members?.me
                || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(client.user?.id).catch(() => null) : null);

            if (!botMember) {
                logger.warn(`[247-LIFECYCLE] Bot member object missing in guild ${guildId}. Aborting recovery.`);
                this.cancelRecovery(guildId, 'bot_member_missing');
                return;
            }

            // 3. Resolve target channel ID
            const settings = client.guildSettings?.get?.(guildId);
            const targetChannelId = settings?.voiceChannelId || session.targetChannelId;

            if (!targetChannelId) {
                logger.warn(`[247-LIFECYCLE] No configured voice channel found for guild ${guild.name || guildId}. Aborting recovery.`);
                this.cancelRecovery(guildId, 'no_channel_configured');
                return;
            }

            // 4. Fetch target voice channel safely
            let isDeletedVoiceChannel = false;
            let targetChannel = guild.channels?.cache?.get(targetChannelId);
            if (!targetChannel && typeof guild.channels?.fetch === 'function') {
                targetChannel = await guild.channels.fetch(targetChannelId).catch((fetchErr) => {
                    if (fetchErr?.code === 10003) {
                        isDeletedVoiceChannel = true;
                        return null;
                    }
                    logger.debug(`[247-LIFECYCLE] Fetch error for channel ${targetChannelId}:`, fetchErr?.message || fetchErr);
                    return null;
                });
            }

            if (!targetChannel) {
                if (isDeletedVoiceChannel) {
                    logger.warn(`[247-LIFECYCLE] Intended 24/7 voice channel ${targetChannelId} was deleted in guild ${guild.name || guildId} (code 10003 Unknown Channel). Cleared invalid channel reference while preserving 24/7 mode.`);
                    client.guildSettings?.invalidateVoiceChannel?.(guildId);
                    this.cancelRecovery(guildId, 'channel_deleted');
                } else {
                    logger.warn(`[247-LIFECYCLE] Transient channel fetch failure for ${targetChannelId} in guild ${guild.name || guildId}. Scheduling retry...`);
                    session.inFlight = false;
                    this.scheduleAutoRecovery(client, guildId, targetChannelId, 'fetch_retry');
                }
                return;
            }

            // 5. Verify target is voice-based
            const isVoice = (typeof targetChannel.isVoiceBased === 'function' && targetChannel.isVoiceBased())
                || targetChannel.type === 2 || targetChannel.type === 13;

            if (!isVoice) {
                logger.warn(`[247-LIFECYCLE] Target channel #${targetChannel.name} in guild ${guildId} is not a voice channel. Aborting 24/7 recovery.`);
                client.guildSettings?.invalidateVoiceChannel?.(guildId);
                this.cancelRecovery(guildId, 'not_voice_channel');
                return;
            }

            // 6. Verify Connect & ViewChannel permissions
            if (typeof targetChannel.permissionsFor === 'function') {
                const perms = targetChannel.permissionsFor(botMember);
                if (perms) {
                    if (!perms.has(PermissionsBitField.Flags.ViewChannel)) {
                        logger.warn(`[247-LIFECYCLE] Missing ViewChannel permission in #${targetChannel.name} (${targetChannel.id}) for guild ${guildId}. Aborting recovery.`);
                        this.cancelRecovery(guildId, 'missing_view_channel_permission');
                        return;
                    }
                    if (!perms.has(PermissionsBitField.Flags.Connect)) {
                        logger.warn(`[247-LIFECYCLE] Missing Connect permission in #${targetChannel.name} (${targetChannel.id}) for guild ${guildId}. Aborting recovery.`);
                        this.cancelRecovery(guildId, 'missing_connect_permission');
                        return;
                    }
                }
            }

            // 7. Check if already connected to target channel
            if (botMember.voice?.channelId === targetChannel.id) {
                logger.debug(`[247-LIFECYCLE] Bot is already connected to voice in guild ${guildId}; recovery complete.`);
                this.cancelRecovery(guildId, 'already_connected');
                return;
            }

            // 8. Verify active Lavalink node
            const mainNode = client.lavalinkConnectionManager?.getActiveNode?.()
                || client.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                || (client.lavalink?.nodeManager?.nodes ? Array.from(client.lavalink.nodeManager.nodes.values())[0] : null);

            if (!mainNode || !mainNode.connected) {
                logger.debug(`[247-LIFECYCLE] Lavalink node not connected for guild ${guildId}; scheduling retry after backoff.`);
                session.inFlight = false;
                this.scheduleAutoRecovery(client, guildId, targetChannelId, 'node_reconnecting');
                return;
            }

            // 9. Create or update Lavalink player
            let player = client.lavalink?.getPlayer?.(guildId);
            if (!player && client.lavalink) {
                player = client.lavalink.createPlayer({
                    guildId,
                    voiceChannelId: targetChannel.id,
                    textChannelId: settings?.textChannelId || null,
                    node: mainNode.id,
                    selfDeaf: true,
                    selfMute: false,
                });
            }

            if (player) {
                player.voiceChannelId = targetChannel.id;
                if (player.options) player.options.voiceChannelId = targetChannel.id;
                if ((!player.node || !player.node.connected) && mainNode) player.node = mainNode;

                const connectPromise = player.connect();
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Voice connection timed out after 15000ms')), 15000)
                );

                await Promise.race([connectPromise, timeoutPromise]);
                logger.info(`[247-LIFECYCLE] Successfully auto-recovered 24/7 voice connection in guild ${guild.name || guildId} (#${targetChannel.name || targetChannelId})`);

                // 10. Restore playback state safely if playback was active
                if (session.savedState?.wasPlaying && session.savedState?.track) {
                    try {
                        const currentTrackId = player.queue?.current?.info?.identifier;
                        const savedTrackId = session.savedState.track?.info?.identifier;
                        const isSameTrack = Boolean(!player.queue.current || (currentTrackId && currentTrackId === savedTrackId));

                        if (!player.queue.current) {
                            player.queue.current = session.savedState.track;
                        }
                        if (!player.playing) {
                            const resumePosition = isSameTrack ? (session.savedState.position || 0) : 0;
                            await player.play({ position: resumePosition }).catch(() => {});
                            logger.info(`[247-LIFECYCLE] Restored active playback for "${player.queue.current?.info?.title || session.savedState.track.info?.title}" at ${resumePosition}ms in guild ${guild.name || guildId}`);
                        }
                    } catch (playErr) {
                        logger.debug('[247-LIFECYCLE] Error resuming playback after 24/7 recovery:', playErr?.message);
                    }
                } else {
                    player.playing = false;
                    client.playerController?.showStoppedState?.(guildId).catch(() => {});
                }

                client.voiceChannelStatusManager?.syncGuildPlayerStatus?.(guildId).catch(() => {});
                this.cancelRecovery(guildId, 'recovered_successfully');
            }
        } catch (err) {
            logger.warn(`[247-LIFECYCLE] Attempt ${session.attempts} failed for guild ${guildId}:`, err?.message || err);
            session.inFlight = false;
            if (session.attempts < this.MAX_ATTEMPTS) {
                this.scheduleAutoRecovery(client, guildId, session.targetChannelId, 'retry_after_error');
            } else {
                logger.warn(`[247-LIFECYCLE] Exhausted recovery retries for guild ${guildId}. Preserving 24/7 setting for manual recovery.`);
                this.cancelRecovery(guildId, 'retries_exhausted');
            }
        }
    }

    /**
     * Starts a background watchdog interval that checks whether 24/7 enabled bots
     * are still connected to their designated voice channels, auto-reconnecting if disconnected.
     *
     * @param {Object} client - Discord client
     * @param {number} [intervalMs=25000] - Interval between checks (default: 25 seconds)
     */
    startWatchdog(client, intervalMs = 25000) {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
        }

        this.watchdogTimer = setInterval(async () => {
            if (!client?.guildSettings || !client?.is247Enabled) return;
            const guildIds = new Set();
            if (client.guildSettings?.cache) {
                for (const g of client.guildSettings.cache.keys()) guildIds.add(g);
            }
            if (client.guilds?.cache) {
                for (const g of client.guilds.cache.keys()) guildIds.add(g);
            }

            for (const guildId of guildIds) {
                const settings = client.guildSettings.get(guildId) || {};
                const is247 = Boolean(client.is247Enabled?.(guildId) || settings?.twentyFourSeven);
                if (!is247) continue;

                let voiceChannelId = settings.voiceChannelId;
                if (!voiceChannelId) {
                    const guild = client.guilds?.cache?.get(guildId);
                    const botMember = guild?.members?.me;
                    if (botMember?.voice?.channelId) {
                        voiceChannelId = botMember.voice.channelId;
                        client.set247?.(guildId, true, { voiceChannelId });
                    } else {
                        continue;
                    }
                }

                // If currently actively reconnecting via backoff, skip this tick
                if (this.isReconnecting(guildId)) continue;

                try {
                    const guild = client.guilds?.cache?.get(guildId)
                        || (typeof client.guilds?.fetch === 'function' ? await client.guilds.fetch(guildId).catch(() => null) : null);
                    if (!guild) continue;

                    const botMember = guild.members?.me
                        || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(client.user?.id).catch(() => null) : null);

                    const isVoiceConnected = Boolean(botMember?.voice?.channelId === voiceChannelId);
                    const player = client.lavalink?.getPlayer?.(guildId);
                    const isPlayerConnected = Boolean(player && player.connected && player.node?.connected);

                    if (!isVoiceConnected) {
                        // Bot is not in voice: do not force re-join; respect disconnect
                        continue;
                    } else if (!player) {
                        // Bot is in voice channel, but Lavalink player was destroyed or missing: recreate player
                        const mainNode = client.lavalinkConnectionManager?.getActiveNode?.()
                            || client.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                            || (client.lavalink?.nodeManager?.nodes ? Array.from(client.lavalink.nodeManager.nodes.values()).find(n => n.connected) : null);
                        if (mainNode && client.lavalink) {
                            logger.info(`[247-WATCHDOG] Creating missing Lavalink player for 24/7 channel in guild ${guild.name || guildId}...`);
                            const newPlayer = client.lavalink.createPlayer({
                                guildId,
                                voiceChannelId,
                                textChannelId: settings.textChannelId || null,
                                node: mainNode.id,
                                selfDeaf: true,
                                selfMute: false,
                            });
                            newPlayer.connect().catch((pErr) => {
                                logger.debug(`[247-WATCHDOG] Connect new player caught:`, pErr?.message || pErr);
                            });
                        }
                    } else if (!player.node || !player.node.connected) {
                        // Player attached to disconnected/dead node: reassign to healthy node
                        const mainNode = client.lavalinkConnectionManager?.getActiveNode?.()
                            || client.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                            || (client.lavalink?.nodeManager?.nodes ? Array.from(client.lavalink.nodeManager.nodes.values()).find(n => n.connected) : null);
                        if (mainNode && mainNode.connected) {
                            logger.info(`[247-WATCHDOG] Re-attaching player in guild ${guild.name || guildId} to healthy node ${mainNode.id}...`);
                            if (typeof player.changeNode === 'function') {
                                player.changeNode(mainNode, false).catch(() => {
                                    player.node = mainNode;
                                    player.connect().catch(() => {});
                                });
                            } else {
                                player.node = mainNode;
                                player.connect().catch(() => {});
                            }
                        }
                    } else if (!player.playing) {
                        // Only auto-reconnect idle players to prevent interrupting active audio playback
                        if (!isPlayerConnected) {
                            logger.info(`[247-WATCHDOG] Idle 24/7 player disconnected from voice in guild ${guild.name || guildId}. Re-connecting player...`);
                            player.connect().catch((pErr) => {
                                logger.debug(`[247-WATCHDOG] Re-connect player caught:`, pErr?.message || pErr);
                            });
                        }
                    }
                } catch (checkErr) {
                    logger.debug(`[247-WATCHDOG] Check error for guild ${guildId}:`, checkErr?.message || checkErr);
                }
            }
        }, intervalMs);

        if (typeof this.watchdogTimer.unref === 'function') {
            this.watchdogTimer.unref();
        }
    }

    /**
     * Stops the background 24/7 watchdog.
     */
    stopWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }
}

module.exports = new TwentyFourSevenManager();
