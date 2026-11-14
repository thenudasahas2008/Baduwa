const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createPaginatedQueueResponse } = require('../utils/PlayerActions');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Displays the song queue.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction, { requireQueue: false });
            if (!player) return;

            const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
            const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';

            logger.cmd(`/queue by ${userTag} in #${channelName} (Guild: ${guildName})`);

            const queueResponse = createPaginatedQueueResponse(client, player, 1);
            await safeReply(interaction, queueResponse);

            if (typeof client.playerController?.replaceWithFullDashboard === 'function') {
                client.playerController.replaceWithFullDashboard(interaction.guild.id, interaction.channel?.id, { reason: 'queue' }).catch((err) => {
                    logger.warn(`Failed to refresh dashboard after /queue for guild ${interaction.guild.id}:`, err?.message || err);
                });
            }
        } catch (error) {
            if (error.code === 10062) {
                logger.warn(`Interaction expired before reply could be delivered (/queue, guild: ${interaction.guildId || 'DM'})`);
                return;
            }
            logger.error('Error executing /queue command:', error);
            const errorEmbed = createActionEmbed('error', 'Error Viewing Queue', 'An unexpected error occurred while loading the queue.');
            return await safeReply(interaction, { embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
        }
    },
};