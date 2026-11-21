const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { version } = require('../../package.json');
const os = require('os');
const logger = require('../utils/logger');
const { COLORS } = require('../utils/zyroEmbeds');
const { SUPPORT_SERVER_INVITE } = require('../utils/supportGate');
const { safeReply } = require('../utils/interactionHelpers');

// Helper to format uptime from milliseconds to a readable string
function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    let uptime = '';
    if (days > 0) uptime += `${days}d `;
    if (hours > 0) uptime += `${hours}h `;
    if (minutes > 0) uptime += `${minutes}m `;
    uptime += `${seconds}s`;

    return uptime.trim();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('about')
        .setDescription('Displays detailed information about Baduwa Music.'),
    async execute(interaction) {
        const { client } = interaction;

        logger.cmd(`/about by ${interaction.user.tag} in #${interaction.channel?.name || 'DM'} (Guild: ${interaction.guild?.name || 'Unknown'})`);

        const embed = new EmbedBuilder()
            .setColor(COLORS.PRIMARY)
            .setTitle('⚡ About Baduwa Music')
            .setDescription(
                '**Baduwa** is a premium, high-fidelity Discord music bot engineered for crystal-clear audio, seamless queue automation, and uninterrupted 24/7 playback.'
            );

        const avatarUrl = client.user?.displayAvatarURL?.() || null;
        if (avatarUrl) {
            embed.setThumbnail(avatarUrl);
        }

        embed.addFields(
                {
                    name: '👑 Developer & Team',
                    value: `**Lead Developer:** \`zyrox_01xi\`\n**Brand:** \`Baduwa Music Systems\``,
                    inline: true,
                },
                {
                    name: '📊 General',
                    value: `**Version:** \`v${version}\`\n**Servers:** \`${client.guilds.cache.size}\`\n**Active Players:** \`${client.activePlayers?.size || 0}\``,
                    inline: true,
                },
                {
                    name: '📈 Latency',
                    value: `**API:** \`${client.ws?.ping != null && client.ws.ping !== -1 ? `${Math.round(client.ws.ping)}ms` : 'Pinging...'}\``,
                    inline: true,
                },
                {
                    name: '⚙️ Environment',
                    value: `**Uptime:** \`${formatUptime(client.uptime)}\`\n**Node.js:** \`${process.version}\`\n**Platform:** \`${os.platform()} (${os.arch()})\``,
                    inline: false,
                }
            )
            .setFooter({ text: 'Baduwa Music • Built for audiophiles and high-traffic communities' })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Official Support Server')
                .setStyle(ButtonStyle.Link)
                .setURL(SUPPORT_SERVER_INVITE)
                .setEmoji('💬'),
            new ButtonBuilder()
                .setLabel('GitHub Profile')
                .setStyle(ButtonStyle.Link)
                .setURL('https://github.com/thenudasahas2008')
        );

        await safeReply(interaction, {
            embeds: [embed],
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
    },
};

