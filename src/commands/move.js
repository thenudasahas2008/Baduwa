const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('move')
        .setDescription('Moves a track from one position in the queue to another.')
        .addIntegerOption(option =>
            option.setName('from')
                .setDescription('Current track number (1-based index).')
                .setRequired(true)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('to')
                .setDescription('New target position in queue (1-based index).')
                .setRequired(true)
                .setMinValue(1)),
    async execute(interaction) {
        const { client } = interaction;
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const fromPos = interaction.options.getInteger('from');
            const toPos = interaction.options.getInteger('to');
            const tracks = player.queue?.tracks || [];

            if (tracks.length < 2) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Queue Too Short', 'There must be at least 2 tracks in queue to move positions.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (fromPos > tracks.length || toPos > tracks.length) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Position Out of Bounds', `Position must be between 1 and ${tracks.length}.`)],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (fromPos === toPos) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'No Change', 'The track is already at that position.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const [movedTrack] = tracks.splice(fromPos - 1, 1);
            tracks.splice(toPos - 1, 0, movedTrack);

            logger.cmd(`/move from ${fromPos} to ${toPos} in guild ${interaction.guildId}`);

            if (typeof client.playerController?.updatePlayer === 'function') {
                client.playerController.updatePlayer(interaction.guildId, { replace: false }).catch(() => {});
            }

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Track Moved', `Moved **${movedTrack.info?.title || 'Unknown Title'}** from position #${fromPos} to #${toPos}.`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /move command:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Move Error', 'An unexpected error occurred while moving track.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
