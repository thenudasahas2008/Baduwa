const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const logger = require('../utils/logger');
const { safeReply } = require('../utils/interactionHelpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('music-info')
        .setDescription('View a concise overview of the current song playback health and streaming status.'),
    async execute(interaction) {
        const { client, guild } = interaction;
        const guildId = guild?.id || interaction.guildId;

        const channelName = interaction.channel?.name || interaction.channelId || 'unknown-channel';
        const guildName = guild?.name || guildId || 'unknown-guild';
        const userTag = interaction.user?.tag || interaction.user?.id || 'unknown-user';
        logger.cmd(`/music-info by ${userTag} in #${channelName} (Guild: ${guildName})`);

        if (!client.audioPlaybackMonitor) {
            return safeReply(interaction, {
                content: '⚠️ Audio playback monitor is not initialized.',
                flags: MessageFlags.Ephemeral
            });
        }

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);

        if (health.player.state === 'IDLE' || !health.player.trackAssigned) {
            const idleEmbed = new EmbedBuilder()
                .setColor(0x7C3AED)
                .setTitle('🎵 ZYRO Music Playback Status')
                .setDescription('⚪ **No track is currently playing in this server.**\n\nJoin a voice channel and use `/play <song>` to start high-fidelity music streaming!')
                .setFooter({ text: 'ZYRO Music • Status: Idle' })
                .setTimestamp();

            return safeReply(interaction, { embeds: [idleEmbed], flags: MessageFlags.Ephemeral });
        }

        // Status badge
        let statusBadge = '🟢 Healthy & Streaming';
        if (health.status === 'POSITION_STALLED') {
            statusBadge = '🔴 Stalled (Audio buffer frozen)';
        } else if (health.status === 'SOURCE_FAILURE') {
            statusBadge = '🔴 Source Error (Stream unavailable)';
        } else if (health.status === 'VOICE_DISCONNECTED') {
            statusBadge = '🟠 Voice Disconnected';
        } else if (health.status === 'NODE_UNHEALTHY') {
            statusBadge = '🔴 Node Unhealthy';
        } else if (health.status === 'RECOVERING') {
            statusBadge = '🟡 Recovering Stream';
        } else if (health.player.state === 'PAUSED') {
            statusBadge = '🟠 Playback Paused';
        }

        // Progress bar calculation
        const duration = health.player.trackDuration;
        const pos = health.player.positionMs;
        const pct = duration > 0 ? Math.min(1, Math.max(0, pos / duration)) : 0;
        const barLength = 14;
        const filled = Math.round(barLength * pct);
        const bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, barLength - filled));

        const embed = new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle(`🎵 Current Song Playback Health`)
            .setDescription(`### **${health.player.trackTitle}**\nby **${health.player.trackAuthor}**\n\n\`${bar}\`\n\`${health.player.positionFormatted} / ${health.player.trackDurationFormatted}\``)
            .addFields([
                {
                    name: '📊 Playback Health Status',
                    value: `**Status:** \`${statusBadge}\`\n${health.statusDetail}`,
                    inline: false,
                },
                {
                    name: '📡 Audio Stream & Delivery',
                    value:
                        `• **Position Advancing:** ${health.player.isProgressing ? '🟢 **Yes**' : (health.player.state === 'PAUSED' ? '🟠 Paused' : '🔴 **Frozen**')}\n` +
                        `• **Voice Channel:** ${health.voice.channelName}\n` +
                        `• **Audio Node:** \`${health.node.id}\` (\`${health.node.connected ? 'Connected' : 'Offline'}\`)\n` +
                        `• **Latency:** Node: \`${health.node.pingMs}\` | Discord: \`${health.voice.discordPing}\``,
                    inline: true,
                },
                {
                    name: '📜 Queue & Modes',
                    value:
                        `• **Upcoming Tracks:** \`${health.player.queueLength} in queue\`\n` +
                        `• **Next Track:** ${health.player.nextTrackTitle ? `**${health.player.nextTrackTitle}**` : '*End of queue*'}\n` +
                        `• **Autoplay:** \`${health.player.autoplay ? 'Enabled' : 'Disabled'}\`\n` +
                        `• **Loop Mode:** \`${health.player.repeatMode}\``,
                    inline: true,
                }
            ])
            .setFooter({ text: 'ZYRO Live Music Info • Run /music-logs for in-depth Lavalink diagnostics' })
            .setTimestamp();

        return safeReply(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral });
    }
};
