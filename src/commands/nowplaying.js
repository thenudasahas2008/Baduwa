const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Shows information about the currently playing song.'),
    async execute(interaction) {
        const { client } = interaction;
        const { requirePlayer, safeReply } = require('../utils/interactionHelpers');

        const player = await requirePlayer(interaction);
        if (!player) return;

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/nowplaying by ${userTag} in #${channelName} (Guild: ${guildName})`);

        if (!player.playing || !player.queue.current) {
            return safeReply(interaction, {
                content: client.languageManager.get(client.defaultLanguage, 'NOTHING_PLAYING'),
                flags: MessageFlags.Ephemeral
            });
        }

        const track = player.queue.current;

        const embed = client.playerController.createPlayerEmbed(player, track);

        // Add loop status to nowplaying
        if (player.repeatMode && player.repeatMode !== 'off') {
            const loopIcon = player.repeatMode === 'track' ? '🔂' : '🔁';
            const loopText = player.repeatMode === 'track' 
                ? client.languageManager.get(client.defaultLanguage, 'LOOP_STATUS_TRACK')
                : client.languageManager.get(client.defaultLanguage, 'LOOP_STATUS_QUEUE');
            
            embed.addFields({
                name: client.languageManager.get(client.defaultLanguage, 'LOOP_STATUS'),
                value: `${loopIcon} ${loopText}`,
                inline: true
            });
        }

        return safeReply(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral});
    },
}; 