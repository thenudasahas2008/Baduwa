const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Removes a track from the queue by its position number.')
        .addIntegerOption(option =>
            option.setName('position')
                .setDescription('Track position number to remove (1-based index).')
                .setRequired(true)
                .setMinValue(1)),
    async execute(interaction) {
        const { client } = interaction;
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const position = interaction.options.getInteger('position');
            const queueTracks = player.queue?.tracks || [];

            if (queueTracks.length === 0) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Queue Empty', 'The queue has no upcoming songs to remove.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (position > queueTracks.length) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Position Out of Bounds', `Position \`${position}\` exceeds queue size (\`${queueTracks.length}\`).`)],
                    flags: MessageFlags.Ephemeral
                });
            }

            const [removedTrack] = queueTracks.splice(position - 1, 1);
            if (!removedTrack) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('error', 'Remove Failed', 'Track could not be removed.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            logger.cmd(`/remove ${position} in guild ${interaction.guildId}`);

            if (typeof client.playerController?.updatePlayer === 'function') {
                client.playerController.updatePlayer(interaction.guildId, { replace: false }).catch(() => {});
            }

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Track Removed', `Removed **${removedTrack.info?.title || 'Unknown Title'}** (#${position}) from the queue.`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /remove command:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Remove Error', 'An unexpected error occurred while removing track.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
