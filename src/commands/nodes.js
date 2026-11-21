const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, safeReply } = require('../utils/interactionHelpers');
const { COLORS } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(1)} MB`;
}

function formatUptime(ms) {
    if (!ms || ms <= 0) return 'Unavailable';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${totalSeconds % 60}s`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nodes')
        .setDescription('Displays Lavalink audio streaming nodes status, telemetry, and system stats.'),
    async execute(interaction) {
        const { client } = interaction;
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            logger.cmd(`/nodes in guild ${interaction.guildId}`);

            const nodesMap = client.lavalink?.nodeManager?.nodes;
            const nodes = nodesMap ? Array.from(nodesMap.values()) : [];

            if (nodes.length === 0) {
                const noNodesEmbed = new EmbedBuilder()
                    .setColor(0xEF4444)
                    .setTitle('📡 Lavalink Node Telemetry')
                    .setDescription('🔴 **No Lavalink nodes are currently registered or connected.**')
                    .setTimestamp();
                return await safeReply(interaction, { embeds: [noNodesEmbed], flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIMARY)
                .setTitle(`📡 Lavalink Node Telemetry (${nodes.length} registered)`)
                .setDescription('Real-time audio node status, connection health, and resource utilization.')
                .setTimestamp();

            for (const node of nodes) {
                const isConnected = Boolean(node.connected);
                const statusDot = isConnected ? '🟢 Connected' : '🔴 Disconnected';
                const id = node.id || node.options?.id || 'unknown';
                const host = node.host || node.options?.host || 'localhost';
                const port = node.port || node.options?.port || 2333;
                const stats = node.stats || {};

                const playersCount = stats.players ?? (node.players?.size || 0);
                const playingPlayers = stats.playingPlayers ?? 0;
                const memUsed = formatBytes(stats.memory?.used || 0);
                const memAllocated = formatBytes(stats.memory?.allocated || 0);
                const cpuSystem = typeof stats.cpu?.systemLoad === 'number' ? `${(stats.cpu.systemLoad * 100).toFixed(1)}%` : 'n/a';
                const cpuLavalink = typeof stats.cpu?.lavalinkLoad === 'number' ? `${(stats.cpu.lavalinkLoad * 100).toFixed(1)}%` : 'n/a';
                const uptime = formatUptime(stats.uptime || 0);
                const ping = typeof node.ping === 'number' ? `${node.ping}ms` : 'n/a';

                embed.addFields([
                    {
                        name: `Node: \`${id}\` (${statusDot})`,
                        value:
                            `• **Address:** \`${host}:${port}\`\n` +
                            `• **Latency:** \`${ping}\` | **Uptime:** \`${uptime}\`\n` +
                            `• **Players:** \`${playingPlayers} active\` / \`${playersCount} total\`\n` +
                            `• **Memory:** \`${memUsed} / ${memAllocated}\`\n` +
                            `• **CPU Load:** Lavalink: \`${cpuLavalink}\` | System: \`${cpuSystem}\``,
                        inline: false
                    }
                ]);
            }

            return await safeReply(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral });
        } catch (error) {
            logger.error(`Error in /nodes command:`, error?.stack || error);
            const errEmbed = new EmbedBuilder()
                .setColor(0xEF4444)
                .setTitle('Error Fetching Node Telemetry')
                .setDescription('An unexpected error occurred while querying node statistics.')
                .setTimestamp();
            return await safeReply(interaction, { embeds: [errEmbed], flags: MessageFlags.Ephemeral });
        }
    },
};
