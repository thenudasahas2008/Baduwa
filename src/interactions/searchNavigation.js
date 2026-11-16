const { MessageFlags, PermissionsBitField } = require('discord.js');
const searchSessions = require('../utils/searchSessions');
const { isLavalinkAvailable, safeReply } = require('../utils/interactionHelpers');
const { createSearchEmbed, createSearchComponents } = require('../utils/embeds');
const { getValidVolume } = require('../utils/volumeValidator');
const { clearGuildLifecycleTimers, clearQueueEndTimeout, schedulePlayerUpdate, clearManualStop } = require('../utils/playerLifecycle');
const { clearEmptyChannelTimeout } = require('../events/voiceStateUpdate');
const { createActionEmbed, formatDuration, COLORS, ICONS } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

async function handleSearchNavigation(interaction) {
    const { client, customId, user, guild } = interaction;
    const lang = client.defaultLanguage;

    try {
        const parts = customId.split(':');
        const [component, action, sessionId, ...args] = parts;

        if (component !== 'search') return;

        // Get search session
        const session = searchSessions.getSession(sessionId);
        
        if (!session) {
            const payload = {
                content: client.languageManager.get(lang, 'SEARCH_SESSION_EXPIRED'),
                embeds: [],
                components: []
            };
            if (typeof interaction.update === 'function' && !interaction.deferred && !interaction.replied) {
                return await interaction.update(payload).catch(() => safeReply(interaction, payload));
            }
            return safeReply(interaction, payload);
        }
        
        // Validate session ownership
        if (session.userId !== user.id) {
            return safeReply(interaction, {
                content: client.languageManager.get(lang, 'SEARCH_NOT_YOUR_SESSION'),
                flags: MessageFlags.Ephemeral
            });
        }

        // Check if Lavalink is available
        if (!isLavalinkAvailable(client)) {
            return safeReply(interaction, {
                content: client.languageManager.get(lang, 'LAVALINK_UNAVAILABLE'),
                flags: MessageFlags.Ephemeral
            });
        }

        let shouldUpdate = false;
        let responseMessage = null;

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate().catch(() => {});
        }

        switch (action) {
            case 'prev':
                if (searchSessions.updatePage(sessionId, session.currentPage - 1)) {
                    shouldUpdate = true;
                }
                break;

            case 'next':
                if (searchSessions.updatePage(sessionId, session.currentPage + 1)) {
                    shouldUpdate = true;
                }
                break;

            case 'select': {
                // Handle dropdown selection - exact selected track
                const trackIndex = parseInt(interaction.values[0]);
                if (isNaN(trackIndex) || !session.tracks[trackIndex]) {
                    searchSessions.deleteSession(sessionId);
                    return interaction.followUp({
                        embeds: [createActionEmbed('warning', 'Selection Expired', 'The selected track is no longer available in this search session.')],
                        flags: MessageFlags.Ephemeral
                    });
                }

                const track = session.tracks[trackIndex];

                // Validate user still in voice channel
                const member = interaction.member || guild.members?.cache?.get?.(user.id) || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(user.id).catch(() => null) : null);
                const voiceChannel = member?.voice?.channel;

                if (!voiceChannel) {
                    return interaction.followUp({
                        content: client.languageManager.get(lang, 'NOT_IN_VOICE'),
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Check permissions on the voice channel
                const botMember = guild.members.me;
                if (botMember) {
                    const permissions = voiceChannel.permissionsFor(botMember);
                    if (permissions && (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak))) {
                        return interaction.followUp({
                            embeds: [createActionEmbed('error', 'Missing Permissions', `Baduwa requires **Connect** and **Speak** permissions in <#${voiceChannel.id}>.`)],
                            flags: MessageFlags.Ephemeral
                        });
                    }
                }

                // Clear any pending empty-channel or queue-end timeouts
                clearEmptyChannelTimeout(guild.id);
                clearQueueEndTimeout(guild.id);

                // Get or create player
                let player = client.lavalink.getPlayer(guild.id);

                if (!player) {
                    player = client.lavalink.createPlayer({
                        guildId: guild.id,
                        voiceChannelId: voiceChannel.id,
                        textChannelId: session.textChannelId,
                        selfDeaf: true,
                        selfMute: false,
                        volume: getValidVolume(process.env.DEFAULT_VOLUME, 80),
                    });
                } else {
                    player.voiceChannelId = voiceChannel.id;
                    player.textChannelId = session.textChannelId;
                }

                // Connect if not already connected
                if (!player.connected) {
                    await player.connect();
                }

                // Wait for voice state/token readiness (max ~1.5s)
                let waitCount = 0;
                while ((!player.connected || !player.voice?.token) && waitCount < 15) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    waitCount++;
                }

                // Attach requester and complete metadata
                if (!track.requester) {
                    track.requester = user;
                }
                if (!track.userData) track.userData = {};
                track.userData.query = session.query;
                track.userData.guildId = guild.id;
                track.userData.requestedBy = user.id;
                track.userData.requestedAt = Date.now();
                track.userData.searchSessionId = sessionId;

                const wasPlaying = Boolean(player.playing && player.queue.current);

                // Add track to queue according to user request
                if (session.playNext) {
                    if (wasPlaying) {
                        await player.queue.add(track, 0);
                    } else {
                        if (player.queue) player.queue.current = null;
                        await player.queue.add(track, 0);
                        await player.play();
                    }
                } else if (wasPlaying) {
                    await player.queue.add(track);
                    if (!player.playing) {
                        await player.play();
                    }
                } else {
                    clearManualStop(guild.id);
                    if (typeof player.setData === 'function') {
                        player.setData('internal_stopPlaying', void 0);
                        player.setData('internal_autoplayStopPlaying', void 0);
                        player.setData('manual_stop_generation', void 0);
                    }
                    if (player.queue) player.queue.current = null;
                    await player.queue.add(track);
                    await player.play();
                }

                const trackTitle = track.info?.title || 'Unknown Title';
                const trackUri = track.info?.uri;
                const trackLink = trackUri ? `[${trackTitle}](${trackUri})` : trackTitle;
                const author = track.info?.author || 'Unknown Artist';
                const duration = formatDuration(track.info?.duration || 0);

                logger.info(`[SEARCH-DIAG] User selected track "${trackTitle}" (${track.info?.identifier}) by "${author}" from search session ${sessionId}`);

                // Clean up search session after selection
                searchSessions.deleteSession(sessionId);

                // Send or update the player controller (replace at bottom if started playback)
                if (!wasPlaying) {
                    await client.playerController.replaceWithFullDashboard(guild.id, session.textChannelId || interaction.channel?.id, { track }).catch(() => {});
                    if (client.voiceChannelStatusManager?.updateFromPlayer) {
                        client.voiceChannelStatusManager.updateFromPlayer(player, track, 'playing').catch(() => {});
                    }
                } else {
                    await client.playerController.updatePlayer(guild.id, { replace: false }).catch(() => {});
                }

                // Clear the search UI and show truthful action confirmation (never a substitute for the player dashboard)
                const confirmEmbed = wasPlaying
                    ? createActionEmbed({
                        title: session.playNext ? '🎵 Queued to Play Next' : '🎵 Track Added to Queue',
                        description: `**${trackLink}**\nby **${author}**`,
                        fields: [
                            { name: '⏱️ Duration', value: `\`${duration}\``, inline: true },
                            { name: '📌 Position', value: `\`${session.playNext ? 'Playing Next' : '#' + player.queue.tracks.length}\``, inline: true },
                            { name: `${ICONS.USER} Added by`, value: `<@${user.id}>`, inline: true },
                        ],
                        thumbnail: track.info?.artworkUrl || null,
                        color: COLORS.PRIMARY,
                    })
                    : createActionEmbed({
                        title: '🎵 Track Selected',
                        description: `Loading audio for **${trackLink}**\nby **${author}**...`,
                        fields: [
                            { name: '⏱️ Duration', value: `\`${duration}\``, inline: true },
                            { name: `${ICONS.USER} Added by`, value: `<@${user.id}>`, inline: true },
                        ],
                        thumbnail: track.info?.artworkUrl || null,
                        color: COLORS.PRIMARY,
                    });

                await safeReply(interaction, {
                    content: null,
                    embeds: [confirmEmbed],
                    components: []
                });
                return;
            }

            case 'cancel':
                // Clean up player if it was created for search but never connected
                const existingPlayer = client.lavalink.getPlayer(guild.id);
                if (existingPlayer && !existingPlayer.connected && !existingPlayer.playing) {
                    clearGuildLifecycleTimers(guild.id);
                    existingPlayer.destroy();
                }

                searchSessions.deleteSession(sessionId);
                const { createActionEmbed: createCancelEmbed } = require('../utils/zyroEmbeds');
                await safeReply(interaction, {
                    content: null,
                    embeds: [createCancelEmbed('info', 'Search Cancelled', 'The interactive search session was closed.')],
                    components: []
                });
                return; // Exit early
        }

        if (shouldUpdate) {
            const pageData = searchSessions.getCurrentPageData(sessionId);
            if (pageData) {
                const embed = createSearchEmbed(client, pageData, session.query);
                const components = createSearchComponents(client, pageData, sessionId);
                await safeReply(interaction, { embeds: [embed], components });
            }
        }

        if (responseMessage) {
            await safeReply(interaction, { content: responseMessage, flags: MessageFlags.Ephemeral });
        }

    } catch (error) {
        logger.error('Error handling search navigation:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.deferUpdate().catch(() => {});
        }
        await interaction.followUp({
            content: client.languageManager.get(lang, 'SEARCH_INTERACTION_ERROR'),
            flags: MessageFlags.Ephemeral
        }).catch(() => {});
    }
}

module.exports = {
    handleSearchNavigation,
};
