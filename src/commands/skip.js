const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed, formatDuration } = require('../utils/zyroEmbeds');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skips the current song.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
            const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';

            logger.cmd(`/skip by ${userTag} in #${channelName} (Guild: ${guildName})`);

            const autoplayOn = client.autoplayEnabled?.get(interaction.guild.id) || false;
            if (player.queue.tracks.length === 0 && !autoplayOn) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Queue Empty', 'There are no more tracks in the queue to skip to.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const currentTrack = player.queue.current;
            const nextTrack = player.queue.tracks[0];
            const skippedTitle = currentTrack?.info?.title || 'Current Track';

            try {
                await Promise.race([
                    player.queue.tracks.length === 0 && autoplayOn ? player.skip(0, false) : player.skip(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Skip timed out')), 3000))
                ]);
            } catch (err) {
                logger.warn(`Error during player.skip in guild ${interaction.guildId}:`, err?.message || err);
            }

            // Schedule central dashboard replacement at bottom of the channel
            schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: true, channelId: interaction.channel?.id });

            const fields = [];
            if (nextTrack) {
                fields.push({
                    name: 'Up Next',
                    value: `[${nextTrack.info?.title || 'Unknown'}](${nextTrack.info?.uri || '#'}) • \`${formatDuration(nextTrack.info?.duration || 0)}\``,
                    inline: false
                });
            } else if (autoplayOn) {
                fields.push({
                    name: 'Autoplay Active',
                    value: 'Discovering next related track...',
                    inline: false
                });
            }

            const skipEmbed = createActionEmbed(
                'success',
                'Track Skipped',
                `Skipped **${skippedTitle}**.`,
                fields
            );

            return await safeReply(interaction, {
                embeds: [skipEmbed],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            if (error.code === 10062) {
                logger.warn(`Interaction expired before reply could be delivered (/skip, guild: ${interaction.guildId || 'DM'})`);
                return;
            }
            logger.error('Error executing /skip command:', error);
            const errorEmbed = createActionEmbed('error', 'Error Skipping Track', 'An unexpected error occurred while skipping.');
            return await safeReply(interaction, { embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
        }
    },
};