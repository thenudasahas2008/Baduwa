const { Events, PermissionsBitField } = require('discord.js');
const searchSessions = require('../utils/searchSessions');
const { clearGuildLifecycleTimers } = require('../utils/playerLifecycle');
const twentyFourSevenManager = require('../utils/twentyFourSevenManager');
const logger = require('../utils/logger');

// Keep track of disconnect timers per guild: Map<guildId, { timeout: NodeJS.Timeout, channelId: string }>
const emptyChannelTimeouts = new Map();
const EMPTY_CHANNEL_TIMEOUT_MS = parseInt(process.env.EMPTY_CHANNEL_DESTROY_MS || "60000", 10);

function countHumanMembers(channel) {
    if (!channel?.members) return 0;
    const nonBots = typeof channel.members.filter === 'function'
        ? channel.members.filter((m) => !m.user?.bot)
        : Array.from(channel.members.values()).filter((m) => !m.user?.bot);
    return nonBots?.size !== undefined ? nonBots.size : (nonBots?.length || 0);
}

function clearEmptyChannelTimeout(guildId) {
    if (emptyChannelTimeouts.has(guildId)) {
        const item = emptyChannelTimeouts.get(guildId);
        const timeout = item?.timeout || item;
        clearTimeout(timeout);
        emptyChannelTimeouts.delete(guildId);
    }
}

function scheduleEmptyChannelTimeout(client, guildId, channelId) {
    // 1. Never schedule if 24/7 mode is active
    if (client.is247Enabled?.(guildId)) {
        clearEmptyChannelTimeout(guildId);
        return;
    }

    // 2. Prevent duplicate timers for the same channel
    if (emptyChannelTimeouts.has(guildId)) {
        const current = emptyChannelTimeouts.get(guildId);
        if (current?.channelId === channelId) {
            return; // Existing timer for this exact channel is already running
        }
        clearTimeout(current?.timeout || current);
        emptyChannelTimeouts.delete(guildId);
    }

    const timeout = setTimeout(async () => {
        emptyChannelTimeouts.delete(guildId);

        // Re-check 1: Is 24/7 mode active now?
        if (client.is247Enabled?.(guildId)) return;

        // Re-check 2: Find the bot's current voice state in this guild
        const guild = client.guilds?.cache?.get(guildId)
            || (typeof client.guilds?.fetch === 'function' ? await client.guilds.fetch(guildId).catch(() => null) : null);
        if (!guild) return;

        const botMember = guild.members?.me
            || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(client.user?.id).catch(() => null) : null);
        if (!botMember || !botMember.voice?.channel) return;

        const currentBotChannel = botMember.voice.channel;

        // Re-check 3: If the bot has moved to another voice channel, never disconnect the wrong channel
        if (currentBotChannel.id !== channelId) return;

        // Re-check 4: Has any human rejoined?
        const humanCount = countHumanMembers(currentBotChannel);
        if (humanCount > 0) return;

        // Send leave message (if we can find the player text channel)
        const playerMessage = client.playerController?.playerMessages?.get(guildId);
        if (playerMessage) {
            const textChannel = client.channels?.cache?.get(playerMessage.channelId);
            if (textChannel) {
                const leaveText = client.t ? client.t('LEFT_EMPTY') : client.languageManager?.get(client.defaultLanguage, 'LEFT_EMPTY');
                if (leaveText) await textChannel.send(leaveText).catch(() => {});
            }
        }

        // Stop playback, clear queue, and clean up player and sessions
        const player = client.lavalink?.getPlayer(guildId);
        clearGuildLifecycleTimers(guildId);
        if (client.voiceChannelStatusManager && channelId) {
            await client.voiceChannelStatusManager.clearStatus(channelId, guildId, { force: true }).catch(() => {});
        }
        if (player) {
            await player.stopPlaying(true, false).catch(() => {});
            player.destroy();
        }
        if (client.playerController?.deletePlayer) {
            await client.playerController.deletePlayer(guildId);
        }

        searchSessions.cleanupGuildSessions(guildId);

        client.activePlayers?.delete(guildId);
        client.updatePresence?.();
    }, EMPTY_CHANNEL_TIMEOUT_MS);

    emptyChannelTimeouts.set(guildId, { timeout, channelId });
}

module.exports = {
    emptyChannelTimeouts,
    EMPTY_CHANNEL_TIMEOUT_MS,
    countHumanMembers,
    clearEmptyChannelTimeout,
    scheduleEmptyChannelTimeout,
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState, maybeClient) {
        const client = oldState?.client || newState?.client || maybeClient;
        const botId = client?.user?.id;

        // --- 1. Handle the bot itself being disconnected or moved ---------------------------------
        if (oldState.id === botId) {
            // Bot left voice completely
            if (oldState.channelId && !newState.channelId) {
                const guildId = oldState.guild.id;

                clearEmptyChannelTimeout(guildId);
                clearGuildLifecycleTimers(guildId);
                client.voiceChannelStatusManager?.clearStatus(oldState.channelId, guildId, { force: true }).catch(() => {});

                const is247 = Boolean(client.is247Enabled?.(guildId));

                // Case B: If 24/7 is enabled, this disconnect was unintentional (since /leave disables 24/7 first)
                if (is247) {
                    twentyFourSevenManager.scheduleAutoRecovery(client, guildId, oldState.channelId, 'voice_disconnect');

                    // Invalidate active playing state since voice connection dropped
                    const player = client.lavalink?.getPlayer(guildId);
                    if (player) {
                        player.playing = false;
                        if (player.queue) {
                            player.queue.current = null;
                        }
                    }
                    if (client.activityManager) {
                        client.activityManager.updatePresence();
                    } else if (client.updatePresence) {
                        client.updatePresence();
                    }
                    client.playerController?.showStoppedState?.(guildId).catch(() => {});
                    return;
                }

                // If 24/7 is not enabled, perform standard cleanup
                twentyFourSevenManager.cancelRecovery(guildId, 'voice_disconnect_normal');
                const player = client.lavalink?.getPlayer(guildId);
                if (player) player.destroy();
                client.playerController?.deletePlayer(guildId);

                searchSessions.cleanupGuildSessions(guildId);

                client.activePlayers?.delete(guildId);
                client.updatePresence?.();
                return;
            }

            // Bot moved to another voice channel
            if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
                const guildId = newState.guild.id;
                clearEmptyChannelTimeout(guildId);

                // Anti-AFK guard for 24/7: if Discord auto-moved the bot to the server's AFK channel, return immediately
                if (client.is247Enabled?.(guildId) && newState.guild?.afkChannelId && newState.channelId === newState.guild.afkChannelId) {
                    logger.info(`[247-LIFECYCLE] Discord moved bot to AFK channel in guild ${guildId}. Returning to 24/7 channel #${oldState.channelId}...`);
                    const player = client.lavalink?.getPlayer?.(guildId);
                    if (player) {
                        player.voiceChannelId = oldState.channelId;
                        if (player.options) player.options.voiceChannelId = oldState.channelId;
                        player.connect().catch((err) => {
                            logger.debug(`[247-LIFECYCLE] Return from AFK channel caught:`, err?.message || err);
                        });
                    }
                    return;
                }

                // Synchronize 24/7 designated voice channel and cancel any pending recovery for old channel
                twentyFourSevenManager.handleChannelMove(client, guildId, newState.channelId);

                if (client.voiceChannelStatusManager) {
                    client.voiceChannelStatusManager.handleChannelMove(oldState.channelId, newState.channelId, guildId).catch(() => {});
                }

                // If player exists, update its voiceChannelId and update dashboard in the new voice channel
                const player = client.lavalink?.getPlayer?.(guildId);
                if (player) {
                    player.voiceChannelId = newState.channelId;
                    if (player.options) player.options.voiceChannelId = newState.channelId;
                }

                // Move dashboard to the new voice channel's chat panel and safely delete from the old one
                if (client.playerController?.replaceWithFullDashboard) {
                    client.playerController.replaceWithFullDashboard(guildId, newState.channelId, { force: true }).catch((err) => {
                        logger.warn(`Failed to move dashboard to new voice channel ${newState.channelId} for guild ${guildId}:`, err?.message || err);
                    });
                }

                const newChannel = newState.channel;
                if (newChannel) {
                    const humans = countHumanMembers(newChannel);
                    if (humans === 0) {
                        scheduleEmptyChannelTimeout(client, guildId, newChannel.id);
                    }
                }
                return;
            }
            return;
        }

        // --- 2. Handle human users joining/leaving/moving ---------------------------------------
        const botMember = oldState.guild.members?.me;
        if (!botMember || !botMember.voice?.channel) return; // Bot not in any channel

        const botChannel = botMember.voice.channel;
        const guildId = botChannel.guild.id;

        // Only react if the voice state update affects the bot's current channel
        if (oldState.channelId !== botChannel.id && newState.channelId !== botChannel.id) {
            return;
        }

        // Count human members in the channel the bot is in
        const humanCount = countHumanMembers(botChannel);

        if (humanCount === 0) {
            // Case A: A human user leaves the voice channel
            if (client.is247Enabled?.(guildId)) {
                clearEmptyChannelTimeout(guildId);
                logger.debug(`[247-LIFECYCLE] Voice channel #${botChannel.name} is now empty of humans in guild ${guildId}, but 24/7 mode is active. Maintaining voice connection.`);
                return;
            }
            scheduleEmptyChannelTimeout(client, guildId, botChannel.id);
        } else {
            // One or more humans are in the channel: cancel any pending disconnect timer
            clearEmptyChannelTimeout(guildId);
        }
    },
};
