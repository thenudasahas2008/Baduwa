const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { jumpToTrack } = require('../utils/PlayerActions');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('jump')
        .setDescription('Jumps to a specific song in the queue.')
        .addIntegerOption(option =>
            option.setName('position')
                .setDescription('Track position number to jump to (1-based index).')
                .setRequired(true)
                .setMinValue(1)),
    async execute(interaction) {
        const { client } = interaction;
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const position = interaction.options.getInteger('position');
            const queueLength = player.queue?.tracks?.length || 0;

            if (queueLength === 0) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Queue Empty', 'There are no upcoming tracks in the queue to jump to.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (position > queueLength) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Position Out of Bounds', `Position \`${position}\` exceeds current queue length (\`${queueLength}\`).`)],
                    flags: MessageFlags.Ephemeral
                });
            }

            const jumpedTrack = await jumpToTrack(player, position - 1);
            if (!jumpedTrack) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('error', 'Jump Failed', 'Could not jump to the requested track.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            logger.cmd(`/jump ${position} in guild ${interaction.guildId}`);

            if (typeof client.playerController?.replaceWithFullDashboard === 'function') {
                client.playerController.replaceWithFullDashboard(interaction.guildId, interaction.channelId, { track: jumpedTrack }).catch(() => {});
            }

            client.voiceChannelStatusManager?.updateFromPlayer(player, jumpedTrack, 'playing').catch(() => {});

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Jumped Track', `Now playing **${jumpedTrack.info?.title || 'Unknown Title'}** (was #${position} in queue).`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /jump command (guild: ${interaction.guildId}):`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Jump Error', 'An unexpected error occurred while jumping to track.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
