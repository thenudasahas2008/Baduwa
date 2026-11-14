const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { requirePlayer, safeReply, ensureDeferred } = require('../utils/interactionHelpers');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pauses or resumes playback.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
            const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
            const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';

            logger.cmd(`/pause by ${userTag} in #${channelName} (Guild: ${guildName})`);

            const isCurrentlyPaused = Boolean(player.paused);

            if (isCurrentlyPaused) {
                try {
                    await Promise.race([
                        player.resume(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Resume timed out')), 3000))
                    ]);
                } catch (err) {
                    if (!err?.message?.includes("isn't paused")) {
                        logger.warn(`Failed to resume player in guild ${interaction.guildId}:`, err?.message || err);
                    }
                }
                player.paused = false;

                schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });
                client.voiceChannelStatusManager?.updateFromPlayer(player, player.queue?.current, 'playing').catch(() => {});

                const resumeEmbed = createActionEmbed('success', 'Playback Resumed', 'Music playback has resumed.');
                return await safeReply(interaction, {
                    embeds: [resumeEmbed],
                    flags: MessageFlags.Ephemeral
                });
            } else {
                try {
                    await Promise.race([
                        player.pause(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Pause timed out')), 3000))
                    ]);
                } catch (err) {
                    if (!err?.message?.includes("already paused")) {
                        logger.warn(`Failed to pause player in guild ${interaction.guildId}:`, err?.message || err);
                    }
                }
                player.paused = true;

                schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });
                client.voiceChannelStatusManager?.updateFromPlayer(player, player.queue?.current, 'paused').catch(() => {});

                const pauseEmbed = createActionEmbed('info', 'Playback Paused', 'Music playback has been paused.');
                return await safeReply(interaction, {
                    embeds: [pauseEmbed],
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            logger.error(`Error executing /pause in guild ${interaction.guildId || 'unknown'}:`, error?.stack || error);
            const errEmbed = createActionEmbed('error', 'Pause Failed', 'An unexpected error occurred while toggling playback state.');
            return await safeReply(interaction, {
                embeds: [errEmbed],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};