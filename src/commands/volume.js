const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { requirePlayer, safeReply, ensureDeferred } = require('../utils/interactionHelpers');
const { schedulePlayerUpdate } = require('../utils/playerLifecycle');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Adjusts the playback volume.')
        .addIntegerOption(option =>
            option.setName('level')
                .setDescription('Volume level (1-100)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(100)),
    async execute(interaction) {
        const { client, options } = interaction;

        await ensureDeferred(interaction, { ephemeral: true });

        const player = await requirePlayer(interaction);
        if (!player) return;

        const rawVolume = options?.getInteger?.('level') ?? options?.getInteger?.('volume') ?? options?.getInteger?.('amount') ?? options?.getInteger?.('value');

        // If no volume argument was provided or is invalid, report current volume cleanly
        if (rawVolume === null || rawVolume === undefined || isNaN(rawVolume)) {
            const currentVol = player.volume ?? 80;
            return safeReply(interaction, {
                content: `🔊 Current volume is **${currentVol}%**\n*To adjust the volume, use \`/volume level: <1-100>\`.*`,
                flags: MessageFlags.Ephemeral
            });
        }

        const validVolume = Math.min(100, Math.max(1, Number(rawVolume)));

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = interaction.guild?.name || interaction.guildId || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/volume ${validVolume} by ${userTag} in #${channelName} (Guild: ${guildName})`);

        // Set the volume
        player.setVolume(validVolume);

        // Update the player display in-place
        schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });

        return safeReply(interaction, {
            content: client.languageManager.get(client.defaultLanguage, 'VOLUME_SET', validVolume),
            flags: MessageFlags.Ephemeral
        });
    },
};
