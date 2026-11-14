const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

// Standard 15-band Lavalink EQ configurations for bass boost levels
const BASS_LEVELS = {
    off: [
        { band: 0, gain: 0.0 }, { band: 1, gain: 0.0 }, { band: 2, gain: 0.0 },
        { band: 3, gain: 0.0 }, { band: 4, gain: 0.0 }, { band: 5, gain: 0.0 }
    ],
    low: [
        { band: 0, gain: 0.20 }, { band: 1, gain: 0.15 }, { band: 2, gain: 0.10 },
        { band: 3, gain: 0.05 }, { band: 4, gain: 0.0 }, { band: 5, gain: -0.05 }
    ],
    medium: [
        { band: 0, gain: 0.35 }, { band: 1, gain: 0.25 }, { band: 2, gain: 0.15 },
        { band: 3, gain: 0.08 }, { band: 4, gain: 0.0 }, { band: 5, gain: -0.05 }
    ],
    high: [
        { band: 0, gain: 0.50 }, { band: 1, gain: 0.40 }, { band: 2, gain: 0.25 },
        { band: 3, gain: 0.15 }, { band: 4, gain: 0.05 }, { band: 5, gain: -0.05 }
    ]
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bassboost')
        .setDescription('Adjusts bass boost intensity for music playback.')
        .addStringOption(option =>
            option.setName('level')
                .setDescription('Bass boost level.')
                .setRequired(true)
                .addChoices(
                    { name: 'Off', value: 'off' },
                    { name: 'Low', value: 'low' },
                    { name: 'Medium', value: 'medium' },
                    { name: 'High', value: 'high' }
                )),
    async execute(interaction) {
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const level = interaction.options.getString('level');
            const bands = BASS_LEVELS[level] || BASS_LEVELS.off;

            if (level === 'off') {
                if (typeof player.filterManager?.clearEQ === 'function') {
                    await player.filterManager.clearEQ();
                } else if (typeof player.setEQ === 'function') {
                    await player.setEQ(BASS_LEVELS.off);
                }
                player._activeEqPreset = null;
            } else {
                if (typeof player.filterManager?.setEQ === 'function') {
                    await player.filterManager.setEQ(bands);
                } else if (typeof player.setEQ === 'function') {
                    await player.setEQ(bands);
                }
                player._activeEqPreset = `bassboost_${level}`;
            }

            logger.cmd(`/bassboost ${level} in guild ${interaction.guildId}`);

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Bass Boost Adjusted', `Bass boost has been set to **${level.toUpperCase()}** 🔊`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /bassboost command:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Filter Error', 'An unexpected error occurred while applying bass boost.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
