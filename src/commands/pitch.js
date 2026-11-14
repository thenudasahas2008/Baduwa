const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pitch')
        .setDescription('Sets audio playback pitch (0.5x to 2.0x).')
        .addNumberOption(option =>
            option.setName('multiplier')
                .setDescription('Pitch multiplier between 0.5 and 2.0 (1.0 is normal).')
                .setRequired(true)
                .setMinValue(0.5)
                .setMaxValue(2.0)),
    async execute(interaction) {
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const pitch = interaction.options.getNumber('multiplier');

            if (typeof player.filterManager?.setPitch === 'function') {
                await player.filterManager.setPitch(pitch);
            } else if (typeof player.filterManager?.setTimescale === 'function') {
                await player.filterManager.setTimescale({ pitch });
            }

            logger.cmd(`/pitch ${pitch}x in guild ${interaction.guildId}`);

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Playback Pitch Set', `Playback pitch set to **${pitch}x** 🎵`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /pitch command:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Pitch Error', 'An unexpected error occurred while setting playback pitch.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
