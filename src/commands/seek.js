const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, requireSameVoice, safeReply } = require('../utils/interactionHelpers');
const { parseTimestampToMs, validateAndSeek } = require('../utils/seekManager');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const { formatDuration } = require('../utils/embeds');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('seek')
        .setDescription('Seek to a specific position in the current track.')
        .addStringOption(option =>
            option.setName('position')
                .setDescription('Timestamp to seek to (e.g. 1:45, 03:20, or 1:02:30)')
                .setRequired(true)),
    async execute(interaction) {
        const { client, options, guild } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        const player = await requirePlayer(interaction);
        if (!player) return;

        const sameVoice = await requireSameVoice(interaction, player);
        if (!sameVoice) return;

        const inputStr = options.getString('position');
        const targetMs = parseTimestampToMs(inputStr);

        if (targetMs === null) {
            return safeReply(interaction, {
                embeds: [createActionEmbed(
                    'warning',
                    'Invalid Timestamp',
                    `Could not parse **"${inputStr}"** as a valid timestamp.\n\n*Valid examples:*\n• \`1:45\` (1 minute, 45 seconds)\n• \`03:20\` (3 minutes, 20 seconds)\n• \`1:05:30\` (1 hour, 5 minutes, 30 seconds)\n• \`90\` or \`90s\` (90 seconds)`
                )],
                flags: MessageFlags.Ephemeral
            });
        }

        const seekResult = await validateAndSeek(player, targetMs);
        if (!seekResult.success) {
            return safeReply(interaction, {
                embeds: [createActionEmbed('warning', 'Cannot Seek', seekResult.message)],
                flags: MessageFlags.Ephemeral
            });
        }

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = guild?.name || guild?.id || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/seek ${inputStr} (${formatDuration(targetMs)}) by ${userTag} in #${channelName} (Guild: ${guildName})`);

        // Notify progress manager of state change so it can update smoothly
        client.playbackProgressManager?.onPlaybackStateChange(guild.id);

        // Promptly update the dashboard in place with the new position
        if (typeof client.playerController?.updatePlayer === 'function') {
            client.playerController.updatePlayer(guild.id, { replace: false, channelId: interaction.channel?.id }).catch(() => {});
        } else {
            schedulePlayerUpdate(client, guild.id, 50, { replace: false, channelId: interaction.channel?.id });
        }

        return safeReply(interaction, {
            embeds: [createActionEmbed(
                'success',
                'Position Updated',
                `Seeked to **${formatDuration(targetMs)}** / **${formatDuration(seekResult.durationMs)}** in [**${seekResult.track.info?.title || 'Current Track'}**](${seekResult.track.info?.uri || '#'})`
            )],
            flags: MessageFlags.Ephemeral
        });
    },
};
