const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const searchSessions = require('../utils/searchSessions');
const { ensureDeferred, isLavalinkAvailable, handleLavalinkError, safeReply } = require('../utils/interactionHelpers');
const { createSearchEmbed, createSearchComponents } = require('../utils/embeds');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const { searchMusic } = require('../utils/searchEngine');
const { validatePlaybackQuery } = require('../utils/queryGuard');
const { getValidVolume } = require('../utils/volumeValidator');
const { handleAutocomplete, resolveAutocompleteToken, isExpiredToken } = require('../utils/searchAutocomplete');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search for music and select tracks to add to the queue.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Search query for music (max 200 characters).')
                .setRequired(true)
                .setAutocomplete(true)),
    
    async autocomplete(interaction) {
        await handleAutocomplete(interaction);
    },

    async execute(interaction) {
        const { client, guild, member, options } = interaction;
        const rawQuery = options.getString('query');
        const resolvedQuery = resolveAutocompleteToken(rawQuery);
        const voiceChannel = member?.voice?.channel;
        const lang = client.defaultLanguage;

        // Promptly acknowledge interaction
        await ensureDeferred(interaction, { ephemeral: true });

        if (isExpiredToken(resolvedQuery)) {
            return await safeReply(interaction, {
                embeds: [createActionEmbed(
                    'warning',
                    'Suggestion Expired',
                    'The selected song suggestion has expired. Please search again and choose from the current dropdown suggestions.'
                )],
                flags: MessageFlags.Ephemeral
            });
        }
        const query = resolvedQuery;

        const guildId = guild?.id || interaction.guildId;
        if (!guildId) {
            return await safeReply(interaction, {
                content: 'This command can only be used in a Discord server voice channel.',
                flags: MessageFlags.Ephemeral
            });
        }

        try {
            // Input validation
            if (!query || query.trim().length === 0) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Empty Query', 'Please provide a valid song title, artist, or music keyword to search.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (query.length > 200) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Query Too Long', 'Search queries must be 200 characters or fewer.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const querySafety = await validatePlaybackQuery(query);
            if (!querySafety.allowed) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('error', 'Search Blocked', 'This search query is not permitted.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (!voiceChannel) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Voice Channel Required', 'You must be in a voice channel to use music commands.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Check if Lavalink is available
            if (!isLavalinkAvailable(client)) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Music Service Reconnecting', 'Music service is reconnecting; please try again shortly.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const gName = guild?.name || guildId;
            const chName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const uTag = member?.user?.tag || interaction.user?.tag || 'unknown-user';
            logger.cmd(`/search "${query}" by ${uTag} in #${chName} (Guild: ${gName})`);
            
            // Get or create player (deferred connection until track selection)
            const activeNode = client.lavalinkConnectionManager?.getActiveNode?.()
                || client.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                || (client.lavalink?.nodeManager?.nodes ? Array.from(client.lavalink.nodeManager.nodes.values())[0] : null);

            let player = client.lavalink.getPlayer(guildId);
            let createdNewPlayer = false;

            if (!player) {
                player = client.lavalink.createPlayer({
                    guildId,
                    voiceChannelId: voiceChannel.id,
                    textChannelId: voiceChannel.id,
                    selfDeaf: true,
                    selfMute: false,
                    volume: getValidVolume(process.env.DEFAULT_VOLUME, 80),
                    node: activeNode?.id || undefined,
                });
                createdNewPlayer = true;
            } else if (player.voiceChannelId && player.voiceChannelId !== voiceChannel.id) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Different Voice Channel', 'You need to be in the same voice channel as ZYRO to search.')],
                    flags: MessageFlags.Ephemeral
                });
            } else if (activeNode && activeNode.connected && (!player.node || !player.node.connected)) {
                if (typeof player.changeNode === 'function') {
                    await player.changeNode(activeNode, false).catch(() => { player.node = activeNode; });
                } else {
                    player.node = activeNode;
                }
            }

            // Perform intelligent search with ranking and automatic provider fallback
            const searchResult = await searchMusic(player, query, interaction.user);

            if (!searchResult || !searchResult.tracks || !searchResult.tracks.length) {
                if (createdNewPlayer && !player.connected) {
                    player.destroy();
                }
                const noResultEmbed = createActionEmbed(
                    'info',
                    'No Tracks Found',
                    `No matching tracks found for **"${query.trim()}"**.\n\nTry including the artist name and track title, or paste a direct YouTube/Spotify URL.`
                );
                return await safeReply(interaction, {
                    embeds: [noResultEmbed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Create search session with voice channel info for deferred connection
            const sessionId = searchSessions.createSession(
                interaction.user.id,
                guildId,
                searchResult.tracks,
                query.trim(),
                voiceChannel.id,
                interaction.channel.id
            );

            // Get initial page data
            const pageData = searchSessions.getCurrentPageData(sessionId);
            if (!pageData) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('error', 'Session Error', 'Failed to initialize search session. Please try again.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Create and send search results with dropdown
            const embed = createSearchEmbed(client, pageData, query.trim());
            const components = createSearchComponents(client, pageData, sessionId);

            await safeReply(interaction, {
                embeds: [embed],
                components,
                flags: MessageFlags.Ephemeral
            });

        } catch (error) {
            if (error.code === 10062) {
                logger.warn(`Interaction expired before reply could be delivered (/search, guild: ${guild?.id || 'DM'})`);
                return;
            }
            logger.error('Error in search command:', error);
            await handleLavalinkError(interaction, error, client);
        }
    },
};
