const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const logger = require('../utils/logger');
const { isAdmin } = require('../utils/permissionChecker');
const { safeReply } = require('../utils/interactionHelpers');

function isAuthorizedForDiagnostics(member) {
    if (!member) return false;

    let memberPermissions;
    try {
        const raw = typeof member.permissions === 'number' ? BigInt(member.permissions) : (member.permissions || 0n);
        memberPermissions = new PermissionsBitField(raw);
    } catch {
        memberPermissions = new PermissionsBitField(0n);
    }

    if (isAdmin(memberPermissions) || memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return true;
    }

    if (typeof member.permissions?.has === 'function') {
        if (member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return true;
        }
    }

    const allowedRoles = (process.env.ALLOWED_ROLES || '')
        .split(',')
        .map(r => r.trim())
        .filter(Boolean);

    if (allowedRoles.length > 0) {
        return member.roles?.cache?.some(r => allowedRoles.includes(r.id || r)) || false;
    }

    return false;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('music-logs')
        .setDescription('Inspect detailed live music playback health, Lavalink telemetry, and audio diagnostics.')
        .addBooleanOption(option =>
            option.setName('public')
                .setDescription('Post the diagnostics publicly in the channel instead of ephemeral (Authorized only).')
                .setRequired(false)
        ),
    async execute(interaction) {
        const { client, guild, member } = interaction;
        const guildId = guild?.id || interaction.guildId;

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = guild?.name || guildId || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/music-logs by ${userTag} in #${channelName} (Guild: ${guildName})`);

        // Permission check: Admins, ManageGuild, or configured allowed roles
        const isPublic = interaction.options?.getBoolean('public') || false;
        const flags = isPublic ? undefined : MessageFlags.Ephemeral;

        const hasAccess = isAuthorizedForDiagnostics(member);
        if (!hasAccess) {
            return safeReply(interaction, {
                content: '❌ **Access Denied:** `/music-logs` is reserved for administrators and authorized server managers.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!client.audioPlaybackMonitor) {
            return safeReply(interaction, {
                content: '⚠️ Audio playback monitor is not initialized.',
                flags: MessageFlags.Ephemeral
            });
        }

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);

        // Map status to badge & emoji
        let statusEmoji = '🟢';
        let statusBadge = 'HEALTHY';
        switch (health.status) {
            case 'HEALTHY':
                statusEmoji = '🟢';
                statusBadge = 'HEALTHY (Playback Advancing)';
                break;
            case 'POSITION_STALLED':
                statusEmoji = '🔴';
                statusBadge = 'POSITION STALLED (Audio Buffer Frozen)';
                break;
            case 'SOURCE_FAILURE':
                statusEmoji = '🔴';
                statusBadge = 'SOURCE FAILURE (Stream Blocked / Failed)';
                break;
            case 'VOICE_DISCONNECTED':
                statusEmoji = '🟠';
                statusBadge = 'VOICE DISCONNECTED (Gateway Dropped)';
                break;
            case 'NODE_UNHEALTHY':
                statusEmoji = '🔴';
                statusBadge = 'NODE UNHEALTHY (Audio Daemon Down)';
                break;
            case 'RECOVERING':
                statusEmoji = '🟡';
                statusBadge = 'RECOVERING (Automatic Stream Recovery)';
                break;
            case 'IDLE':
                statusEmoji = '⚪';
                statusBadge = 'IDLE (No Active Playback)';
                break;
            default:
                statusEmoji = '❓';
                statusBadge = 'UNKNOWN (Telemetry Inconclusive)';
                break;
        }

        const embed = new EmbedBuilder()
            .setColor(0x7C3AED) // Signature Violet
            .setTitle(`🎵 Baduwa Music Health & Audio Quality Diagnostics`)
            .setDescription(`**Overall Playback Health:** ${statusEmoji} \`${statusBadge}\`\n${health.statusDetail}`)
            .addFields([
                {
                    name: '🩺 Root Cause Analysis & Verdict',
                    value:
                        `• **Verdict:** ${health.diagnosis.summary}\n` +
                        (health.diagnosis.confirmedCauses.length > 0
                            ? `• **Confirmed Interruption Causes:**\n${health.diagnosis.confirmedCauses.map(c => `  - ⚠️ ${c}`).join('\n')}\n`
                            : '') +
                        (health.diagnosis.possibleCauses.length > 0
                            ? `• **Potential Contributing Factors:**\n${health.diagnosis.possibleCauses.map(c => `  - ℹ️ ${c}`).join('\n')}\n`
                            : '') +
                        `• **Actionable Guidance:** ${health.diagnosis.actionableAdvice}`,
                    inline: false,
                },
                {
                    name: '🎛️ Player & Audio Progression',
                    value:
                        `• **Player State:** \`${health.player.state}\` (Playing: \`${health.player.playing}\`, Paused: \`${health.player.paused}\`)\n` +
                        `• **Active Track:** **${health.player.trackTitle}** by *${health.player.trackAuthor}*\n` +
                        `• **Source:** \`${health.player.trackSource}\` (ID: \`${health.player.trackIdentifier}\`)\n` +
                        `• **Server Position:** \`${health.player.positionFormatted} / ${health.player.trackDurationFormatted}\`\n` +
                        `• **Position Advancing:** ${health.player.isProgressing ? '🟢 **Yes** (server-verified)' : (health.player.state === 'PAUSED' ? '🟠 Paused' : (health.player.state === 'IDLE' ? '⚪ Idle' : '🔴 **NO (Position Frozen)**'))}\n` +
                        `• **Last Update Received:** \`${health.player.elapsedSinceLastUpdateMs != null ? `${Math.round(health.player.elapsedSinceLastUpdateMs / 1000)}s ago` : 'Unavailable'}\`\n` +
                        `• **Volume:** \`${health.player.volume}%\` | **Loop:** \`${health.player.repeatMode}\` | **Autoplay:** \`${health.player.autoplay ? 'Enabled' : 'Disabled'}\`\n` +
                        `• **Recovery State:** \`${health.player.recovering ? 'In Progress' : 'Inactive'}\` (Retries: \`${health.player.currentTrackRetries}\` | Migration: \`${health.player.migrating ? 'Active' : 'No'}\`)`,
                    inline: false,
                },
                {
                    name: '📡 Lavalink Audio Node Telemetry',
                    value:
                        `• **Node ID:** \`${health.node.id}\` (\`${health.node.connected ? 'Connected' : 'Disconnected'}\`)\n` +
                        `• **Lavalink Version:** \`${health.node.version}\` (Compatibility: \`${health.node.isCompatible ? 'Verified' : 'Degraded'}\`)\n` +
                        `• **Node Ping:** \`${health.node.pingMs}\` | **Uptime:** \`${health.node.uptimeFormatted}\`\n` +
                        `• **CPU Load:** Lavalink: \`${health.node.cpu.lavalinkLoad}\` | System: \`${health.node.cpu.systemLoad}\`\n` +
                        `• **Memory:** \`${health.node.memory.used}\` used / \`${health.node.memory.allocated}\` allocated\n` +
                        `• **Audio Frame Generator Buffer:** \`${health.node.frameStats.interpretation}\``,
                    inline: false,
                },
                {
                    name: '🎙️ Discord Voice Gateway Connection',
                    value:
                        `• **Voice Channel:** ${health.voice.channelName} (\`${health.voice.botConnected ? 'Connected' : 'Disconnected'}\`)\n` +
                        `• **Session Synchronization:** \`${health.voice.channelSynchronized ? 'Synchronized' : 'Desynchronized'}\`\n` +
                        `• **Discord Voice Session:** \`${health.voice.hasDiscordVoiceSession ? 'Available' : 'Unavailable'}\`\n` +
                        `• **Lavalink Gateway State:** \`${health.voice.lavalinkGatewayConnected ? 'Connected' : 'Disconnected'}\`\n` +
                        `• **Discord Gateway Ping:** \`${health.voice.discordPing}\`\n` +
                        `• **Recent Voice Socket Close:** \`${health.voice.lastSocketClose ? `Code ${health.voice.lastSocketClose.code} (${health.voice.lastSocketClose.reason}) — ${health.voice.lastSocketClose.timeAgo}` : 'None recorded'}\``,
                    inline: false,
                },
                {
                    name: '📜 Recent Guild Diagnostic Events',
                    value: health.queueAndEvents.recentEvents.length > 0
                        ? health.queueAndEvents.recentEvents.map(e => {
                            const timeStr = new Date(e.timestamp).toISOString().slice(11, 19);
                            return `\`[${timeStr}]\` **${e.event}**${e.detail ? ` — ${e.detail}` : ''}${e.action ? ` (${e.action})` : ''}`;
                        }).join('\n')
                        : '• No recent audio events logged in this guild.',
                    inline: false,
                },
                {
                    name: '🖥️ Host Runtime & Execution SLA',
                    value:
                        `• **Node.js Process Uptime:** \`${health.hosting.uptime}\` (Runtime: \`${health.hosting.nodeVersion}\`)\n` +
                        `• **Host Memory:** RSS: \`${health.hosting.rss}\` | Heap: \`${health.hosting.heapUsed} / ${health.hosting.heapTotal}\`\n` +
                        `• **Event Loop Delay:** Avg: \`${health.hosting.eventLoop.meanMs}\` | p95: \`${health.hosting.eventLoop.p95Ms}\` | Max: \`${health.hosting.eventLoop.maxMs}\`\n` +
                        `• **Interaction SLA:** \`${health.hosting.interactions.total}\` processed (Avg: \`${health.hosting.interactions.avgDurationMs}ms\`, Timeouts: \`${health.hosting.interactions.timeouts}\`)\n` +
                        `• **Search SLA:** Avg: \`${health.hosting.searches.avgDurationMs}ms\` | Cache Hit: \`${health.hosting.searches.cacheHitRatePct}%\``,
                    inline: false,
                }
            ])
            .setFooter({ text: 'Baduwa Live Music Health Diagnostics • Read-only inspection' })
            .setTimestamp();

        return safeReply(interaction, { embeds: [embed], flags });
    }
};
