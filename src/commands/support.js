const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getSupportServerInvite, getOwnerUsername, checkOwnerMembership } = require('../utils/supportGate');
const { generateInviteUrl } = require('../utils/inviteUrl');
const { safeReply } = require('../utils/interactionHelpers');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('support')
        .setDescription('Get the official ZYRO support server link and server activation status.'),
    async execute(interaction) {
        const { client, guild } = interaction;
        const lang = client.defaultLanguage;

        logger.cmd(`/support by ${interaction.user.tag} in #${interaction.channel?.name || 'DM'} (Guild: ${guild?.name || 'None'})`);

        const invite = getSupportServerInvite();
        const ownerUsername = getOwnerUsername();
        const botInvite = generateInviteUrl(client.user.id);

        let activationStatus = '🟢 Active (Gate Inactive / All Features Unlocked)';
        if (guild) {
            const { isMember, active } = await checkOwnerMembership(client, guild.ownerId);
            if (active) {
                activationStatus = isMember
                    ? '✅ **Activated** — Server owner is a verified support server member.'
                    : '⚠️ **Activation Required** — The server owner must join the support server to unlock music playback.';
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0x7C3AED) // ZYRO Electric Violet
            .setAuthor({ name: 'ZYRO • Support & Community', iconURL: client.user.displayAvatarURL() })
            .setTitle('⚡ ZYRO Official Support Center')
            .setDescription(
                `Welcome to **ZYRO**! Need help setting up the bot, troubleshooting audio issues, or suggesting new features? Join our vibrant community of music lovers and developers.`
            )
            .addFields([
                {
                    name: '👑 Lead Developer',
                    value: `\`${ownerUsername}\``,
                    inline: true,
                },
                {
                    name: '🛡️ Support Community',
                    value: `[discord.gg/RH6W8AcQc](${invite})`,
                    inline: true,
                },
                {
                    name: '📊 Server Status',
                    value: activationStatus,
                    inline: false,
                },
                {
                    name: '🎵 Need Music Help?',
                    value: 'Type `/help` for an interactive guide to all 21 available commands.',
                    inline: false,
                },
            ])
            .setFooter({ text: 'ZYRO Music • High Fidelity Discord Audio' })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Join Support Server')
                .setStyle(ButtonStyle.Link)
                .setURL(invite)
                .setEmoji('🛡️'),
            new ButtonBuilder()
                .setLabel('Invite ZYRO')
                .setStyle(ButtonStyle.Link)
                .setURL(botInvite)
                .setEmoji('➕')
        );

        if (guild?.ownerId) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`support:verify:${guild.ownerId}`)
                    .setLabel('Check Activation')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🔄')
            );
        }

        return safeReply(interaction, { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    },
};
