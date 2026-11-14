const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speed')
        .setDescription('Sets audio playback speed (0.5x to 2.0x).')
        .addNumberOption(option =>
            option.setName('multiplier')
                .setDescription('Speed multiplier between 0.5 and 2.0 (1.0 is normal).')
                .setRequired(true)
                .setMinValue(0.5)
                .setMaxValue(2.0)),
    async execute(interaction) {
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const speed = interaction.options.getNumber('multiplier');

            if (typeof player.filterManager?.setSpeed === 'function') {
                await player.filterManager.setSpeed(speed);
            } else if (typeof player.filterManager?.setTimescale === 'function') {
                await player.filterManager.setTimescale({ speed });
            }

            logger.cmd(`/speed ${speed}x in guild ${interaction.guildId}`);

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Playback Speed Set', `Playback speed set to **${speed}x** ⚡`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /speed command:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Speed Error', 'An unexpected error occurred while setting playback speed.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
