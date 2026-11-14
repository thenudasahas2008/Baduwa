const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { requirePlayer, safeReply, ensureDeferred } = require('../utils/interactionHelpers');
const { shuffleQueue } = require('../utils/PlayerActions');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shuffle')
        .setDescription('Shuffles the queue.'),
    async execute(interaction) {
        const { client } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        const player = await requirePlayer(interaction, { requireQueue: true });
        if (!player) return;

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/shuffle by ${userTag} in #${channelName} (Guild: ${guildName})`);

        if (client.autoplayEnabled.get(interaction.guild.id)) {
            return safeReply(interaction, {
                content: client.languageManager.get(client.defaultLanguage, 'AUTOPLAY_BLOCKS_ACTION'),
                flags: MessageFlags.Ephemeral,
            });
        }

        shuffleQueue(player);

        // Update the player display in-place
        schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });

        return safeReply(interaction, {
            content: client.languageManager.get(client.defaultLanguage, 'QUEUE_SHUFFLED'),
            flags: MessageFlags.Ephemeral
        });
    },
};
