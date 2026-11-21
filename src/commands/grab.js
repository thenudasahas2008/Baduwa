const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed, formatDuration, COLORS } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('grab')
        .setDescription('Sends details of the currently playing song to your Direct Messages (DMs).'),
    async execute(interaction) {
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const current = player.queue?.current || player.current;
            if (!current) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'No Music Playing', 'There is no music currently playing.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const title = current.info?.title || 'Unknown Title';
            const uri = current.info?.uri || '#';
            const author = current.info?.author || 'Unknown Artist';
            const duration = formatDuration(current.info?.duration || 0);
            const artwork = current.info?.artworkUrl || null;

            const dmEmbed = new EmbedBuilder()
                .setColor(COLORS.PRIMARY)
                .setTitle('🎵 Saved Track from Baduwa')
                .setDescription(`[**${title}**](${uri})\nby **${author}**`)
                .addFields([
                    { name: '⏱️ Duration', value: `\`${duration}\``, inline: true },
                    { name: '🌐 Server', value: interaction.guild?.name || 'Discord Server', inline: true },
                ])
                .setThumbnail(artwork)
                .setFooter({ text: 'Baduwa Music Bot • Grabbed Song' })
                .setTimestamp();

            let dmSent = true;
            try {
                await interaction.user.send({ embeds: [dmEmbed] });
            } catch (dmErr) {
                dmSent = false;
                logger.debug('Failed to send DM to user for /grab:', dmErr?.message);
            }

            if (!dmSent) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Direct Messages Closed', `Could not send DM. Please enable Direct Messages from server members to receive saved tracks.`)],
                    flags: MessageFlags.Ephemeral
                });
            }

            logger.cmd(`/grab by ${interaction.user.tag} in guild ${interaction.guildId}`);

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Track Saved', `Sent details for **${title}** directly to your DMs! 📩`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /grab command:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Grab Error', 'An unexpected error occurred while grabbing track.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
