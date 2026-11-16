const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const guildSettings = require('../utils/guildSettings');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autoplay')
        .setDescription('Toggle autoplay mode to automatically play related songs.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
            const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
            logger.cmd(`/autoplay by ${userTag} in #${channelName} (Guild: ${guildName})`);

            const guildId = interaction.guild.id;
            const currentState = client.autoplayEnabled?.has(guildId)
                ? client.autoplayEnabled.get(guildId)
                : guildSettings.isAutoplay(guildId);
            const newState = !currentState;
            client.autoplayEnabled?.set(guildId, newState);
            guildSettings.setAutoplay(guildId, newState);

            // When enabling autoplay, reset loop mode (DJ mode takes over)
            if (newState && player.repeatMode !== 'off') {
                player.setRepeatMode('off');
            }

            // If enabling autoplay while player is idle, trigger discovery immediately
            if (newState && !player.queue.current && !player.playing && player.queue.tracks.length === 0) {
                const { handleAutoplay } = require('../utils/autoplay');
                const lastTrack = (typeof player.getData === 'function' ? player.getData('lastPlayedTrack') : null)
                    || (player.queue?.previous?.length ? player.queue.previous[0] : null);
                handleAutoplay(client, player, 'command', lastTrack).then((started) => {
                    if (started) {
                        schedulePlayerUpdate(client, guildId, 100, { replace: true, channelId: interaction.channel?.id });
                    }
                }).catch(() => {});
            }

            schedulePlayerUpdate(client, guildId, 50, { replace: false, channelId: interaction.channel?.id });

            const autoEmbed = createActionEmbed(
                'info',
                newState ? 'Autoplay Enabled' : 'Autoplay Disabled',
                newState
                    ? 'Baduwa will automatically discover and queue related tracks when the queue runs out.'
                    : 'Autoplay has been turned off.'
            );

            return safeReply(interaction, {
                embeds: [autoEmbed],
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            if (error.code === 10062) {
                logger.warn(`Interaction expired before reply could be delivered (/autoplay, guild: ${interaction.guildId || 'DM'})`);
                return;
            }
            logger.error('Error executing /autoplay command:', error);
            const errorEmbed = createActionEmbed('error', 'Error Toggling Autoplay', 'An unexpected error occurred while toggling autoplay.');
            return safeReply(interaction, { embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
        }
    },
};
