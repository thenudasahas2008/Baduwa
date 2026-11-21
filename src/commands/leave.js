const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { clearGuildLifecycleTimers } = require('../utils/playerLifecycle');
const { clearGuild: clearFailureState } = require('../utils/playbackFailureTracker');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const { safeReply, ensureDeferred } = require('../utils/interactionHelpers');
const searchSessions = require('../utils/searchSessions');
const { emptyChannelTimeouts } = require('../events/voiceStateUpdate');
const twentyFourSevenManager = require('../utils/twentyFourSevenManager');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Stops playback, clears the queue, and disconnects the bot from the voice channel.'),
    async execute(interaction) {
        const { client, guild, member } = interaction;
        const lang = client.defaultLanguage;

        await ensureDeferred(interaction, { ephemeral: true });

        const guildId = guild?.id || interaction.guildId;
        if (!guildId) {
            return await safeReply(interaction, {
                content: 'This command can only be used in a Discord server voice channel.',
                flags: MessageFlags.Ephemeral
            });
        }

        const voiceChannel = member?.voice?.channel;

        if (!voiceChannel) {
            return await safeReply(interaction, {
                embeds: [createActionEmbed('warning', 'Voice Channel Required', 'You must be in a voice channel to disconnect Baduwa.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const player = client.lavalink.getPlayer(guildId);
        const botVoiceChannel = guild.members?.me?.voice?.channel;

        if (!player && !botVoiceChannel) {
            return await safeReply(interaction, {
                embeds: [createActionEmbed('info', 'Not Connected', 'Baduwa is not currently in any voice channel.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (player?.voiceChannelId && player.voiceChannelId !== voiceChannel.id) {
            return await safeReply(interaction, {
                embeds: [createActionEmbed('warning', 'Different Voice Channel', 'You need to be in the same voice channel as Baduwa.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (botVoiceChannel && botVoiceChannel.id !== voiceChannel.id) {
            return await safeReply(interaction, {
                embeds: [createActionEmbed('warning', 'Different Voice Channel', 'You need to be in the same voice channel as Baduwa.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = guild?.name || guild?.id || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/leave by ${userTag} in #${channelName} (Guild: ${guildName})`);

        // If 24/7 is enabled, explicitly cancel recovery and turn it off
        twentyFourSevenManager.cancelRecovery(guildId, 'command_leave');
        client.set247?.(guildId, false);
        client.guildSettings?.set247?.(guildId, false);

        // Clear timers
        clearGuildLifecycleTimers(guildId);
        if (emptyChannelTimeouts.has(guildId)) {
            clearTimeout(emptyChannelTimeouts.get(guildId));
            emptyChannelTimeouts.delete(guildId);
        }

        // Clean up failure tracker and search sessions
        clearFailureState(guildId);
        searchSessions.cleanupGuildSessions(guildId);

        // Delete player controller embed (bounded to 1500ms)
        if (typeof client.playerController?.deletePlayer === 'function') {
            await Promise.race([
                client.playerController.deletePlayer(guildId),
                new Promise(resolve => setTimeout(resolve, 1500))
            ]).catch((err) => {
                logger.warn(`Failed to delete player dashboard for guild ${guildId}:`, err?.message || err);
            });
        }

        // Clear bot-managed voice channel status before leaving (bounded to 1500ms)
        const targetVoiceChannelId = player?.voiceChannelId || botVoiceChannel?.id;
        if (targetVoiceChannelId && typeof client.voiceChannelStatusManager?.clearStatus === 'function') {
            await Promise.race([
                client.voiceChannelStatusManager.clearStatus(targetVoiceChannelId, guildId, { force: true }),
                new Promise(resolve => setTimeout(resolve, 1500))
            ]).catch(() => {});
        }

        // Disconnect and destroy player (bounded to 2500ms with fallback voice disconnect)
        if (player) {
            await Promise.race([
                typeof player.destroy === 'function' ? player.destroy('command:leave', true) : Promise.resolve(),
                new Promise(resolve => setTimeout(resolve, 2500))
            ]).catch(() => {
                guild.members?.me?.voice?.disconnect().catch(() => {});
            });
        } else if (botVoiceChannel) {
            guild.members?.me?.voice?.disconnect().catch(() => {});
        }

        // Clean up client state
        client.activePlayers?.delete(guildId);
        client.autoplayEnabled?.delete(guildId);
        client.guildSettings?.setAutoplay(guildId, false);
        client.updatePresence?.();

        const leaveEmbed = createActionEmbed(
            'success',
            'Disconnected from Voice',
            'Playback stopped. Baduwa disconnected from voice.'
        );

        return await safeReply(interaction, {
            embeds: [leaveEmbed],
            flags: MessageFlags.Ephemeral
        });
    },
};
