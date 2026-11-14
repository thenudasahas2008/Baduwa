const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { playPrevious } = require('../utils/PlayerActions');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('previous')
        .setDescription('Goes back to the previous song in queue history.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
            const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';

            logger.cmd(`/previous by ${userTag} in #${channelName} (Guild: ${guildName})`);

            const track = await Promise.race([
                playPrevious(player),
                new Promise((_, reject) => setTimeout(() => reject(new Error('playPrevious timed out')), 4000))
            ]).catch((err) => {
                logger.warn(`playPrevious error in guild ${interaction.guildId}:`, err?.message || err);
                return null;
            });

            if (!track) {
                const noPrevMsg = client.languageManager?.get?.(client.defaultLanguage || 'en', 'NO_PREVIOUS_SONG') || 'No previously played track found in history.';
                return await safeReply(interaction, {
                    content: noPrevMsg,
                    flags: MessageFlags.Ephemeral
                });
            }

            schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: true, channelId: interaction.channel?.id, track });

            const playPrevMsg = client.languageManager?.get?.(client.defaultLanguage || 'en', 'PLAYING_PREVIOUS', track.info?.title || 'Unknown') || `⏮️ Now replaying previous track: **${track.info?.title || 'Unknown'}**`;
            return await safeReply(interaction, {
                content: playPrevMsg,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            if (error.code === 10062) {
                logger.warn(`Interaction expired before reply could be delivered (/previous, guild: ${interaction.guildId || 'DM'})`);
                return;
            }
            logger.error('Error executing /previous command:', error);
            const errorEmbed = createActionEmbed('error', 'Error Replaying Track', 'An unexpected error occurred while replaying the previous song.');
            return await safeReply(interaction, { embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
        }
    },
};
