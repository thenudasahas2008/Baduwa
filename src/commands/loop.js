const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { requirePlayer, safeReply, ensureDeferred } = require('../utils/interactionHelpers');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('loop')
        .setDescription('Toggle loop mode for the current track or queue.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        const player = await requirePlayer(interaction);
        if (!player) return;

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/loop by ${userTag} in #${channelName} (Guild: ${guildName})`);

        if (client.autoplayEnabled.get(interaction.guild.id)) {
            return safeReply(interaction, {
                content: client.languageManager.get(client.defaultLanguage, 'AUTOPLAY_BLOCKS_ACTION'),
                flags: MessageFlags.Ephemeral,
            });
        }

        // Cycle through loop modes: off -> track -> queue -> off
        let newMode;
        let modeMessage;

        switch (player.repeatMode) {
            case 'off':
                newMode = 'track';
                modeMessage = client.languageManager.get(client.defaultLanguage, 'LOOP_TRACK_ENABLED');
                break;
            case 'track':
                newMode = 'queue';
                modeMessage = client.languageManager.get(client.defaultLanguage, 'LOOP_QUEUE_ENABLED');
                break;
            case 'queue':
                newMode = 'off';
                modeMessage = client.languageManager.get(client.defaultLanguage, 'LOOP_DISABLED');
                break;
            default:
                newMode = 'track';
                modeMessage = client.languageManager.get(client.defaultLanguage, 'LOOP_TRACK_ENABLED');
        }

        // Set the new repeat mode
        player.setRepeatMode(newMode);

        // Update the player display in-place
        schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });

        return safeReply(interaction, { content: modeMessage, flags: MessageFlags.Ephemeral });
    },
};
