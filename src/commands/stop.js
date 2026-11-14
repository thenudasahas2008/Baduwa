const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, requireSameVoice, safeReply } = require('../utils/interactionHelpers');
const { stopPlayer } = require('../utils/PlayerActions');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stops playback and clears the queue while staying in the voice channel.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const sameVoice = await requireSameVoice(interaction, player);
            if (!sameVoice) return;

            const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
            const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';

            logger.cmd(`/stop by ${userTag} in #${channelName} (Guild: ${guildName})`);

            if (!player.queue?.current && !player.playing && (!player.queue?.tracks || player.queue.tracks.length === 0)) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'Nothing Playing', 'Baduwa is not currently playing any track.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Execute canonical stop operation: stops playback immediately, clears queue,
            // suppresses autoplay and watchdog recovery, keeps voice connection, and renders stopped state
            await stopPlayer(client, player, { channelId: interaction.channel?.id });


            const stopEmbed = createActionEmbed(
                'success',
                'Playback Stopped',
                'Playback stopped and queue cleared. Baduwa remains connected to voice.'
            );

            return await safeReply(interaction, {
                embeds: [stopEmbed],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            if (error.code === 10062) {
                logger.warn('Interaction expired for /stop command');
                return;
            }
            logger.error('Error executing /stop command:', error);
            const errorEmbed = createActionEmbed('error', 'Error Stopping Playback', 'An unexpected error occurred while stopping playback.');
            return await safeReply(interaction, {
                embeds: [errorEmbed],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
