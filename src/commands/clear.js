const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isLavalinkAvailable, safeReply, ensureDeferred } = require('../utils/interactionHelpers');
const { clearQueue } = require('../utils/PlayerActions');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clears all upcoming tracks from the queue.'),
    async execute(interaction) {
        const { client, guild, member, channel } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        const channelName = channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = guild?.name || interaction.guildId || 'unknown-guild';
        const guildId = interaction.guildId || guild?.id;
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';

        try {
            // Check if Lavalink is available
            if (typeof isLavalinkAvailable === 'function' && !isLavalinkAvailable(client)) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Music Service Reconnecting', 'Music service is reconnecting; please try again shortly.')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            const player = client.lavalink?.getPlayer(guildId);
            if (!player || (!player.queue?.current && (!player.queue?.tracks || player.queue.tracks.length === 0))) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'Nothing Playing', 'Baduwa is not currently playing any track.')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            const voiceChannel = member?.voice?.channel;
            if (!voiceChannel) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Voice Channel Required', 'You must be in a voice channel to clear the queue.')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (player.voiceChannelId && player.voiceChannelId !== voiceChannel.id) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Different Voice Channel', 'You need to be in the same voice channel as Baduwa.')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (client.autoplayEnabled?.get(guildId)) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Autoplay Active', 'Cannot clear the queue while Autoplay is actively managing tracks.')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (!player.queue?.tracks || player.queue.tracks.length === 0) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'Queue Empty', 'The queue is already empty.')],
                    flags: MessageFlags.Ephemeral,
                });
            }

            const clearedCount = player.queue.tracks.length;
            clearQueue(player);

            // Update persistent player UI
            schedulePlayerUpdate(client, guildId, 50, { replace: false, channelId: interaction.channel?.id });

            logger.cmd(`/clear (${clearedCount} tracks) by ${userTag} in #${channelName} (Guild: ${guildName})`);

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Queue Cleared', `Successfully removed **${clearedCount}** upcoming track${clearedCount === 1 ? '' : 's'} from the queue.`)],
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            logger.error(`Error executing /clear in guild ${guildId}:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Clear Failed', 'An unexpected error occurred while clearing the queue.')],
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};