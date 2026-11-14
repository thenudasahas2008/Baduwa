const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { generateInviteUrl } = require('../utils/inviteUrl');
const { safeReply } = require('../utils/interactionHelpers');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Get a link to invite Baduwa (ZYRO) to your server.'),
    async execute(interaction) {
        const { client } = interaction;
        const lang = client.defaultLanguage;

        logger.cmd(`/invite by ${interaction.user.tag} in #${interaction.channel.name} (Guild: ${interaction.guild.name})`);

        const inviteUrl = generateInviteUrl(client.user.id);

        const embed = new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle(client.languageManager.get(lang, 'INVITE_TITLE'))
            .setDescription(client.languageManager.get(lang, 'INVITE_DESCRIPTION'))
            .setThumbnail(client.user.displayAvatarURL());

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setLabel(client.languageManager.get(lang, 'INVITE_BUTTON'))
                    .setStyle(ButtonStyle.Link)
                    .setURL(inviteUrl)
            );

        await safeReply(interaction, { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    },
};
