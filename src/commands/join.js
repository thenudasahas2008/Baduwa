const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const { ensureDeferred, safeReply, isLavalinkAvailable } = require('../utils/interactionHelpers');
const { getValidVolume } = require('../utils/volumeValidator');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Connects ZYRO to your voice channel.'),
    async execute(interaction) {
        const { client, guild, member } = interaction;
        const voiceChannel = member?.voice?.channel;

        await ensureDeferred(interaction, { ephemeral: true });

        try {
            if (!voiceChannel) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Voice Channel Required', 'You must be in a voice channel to use this command.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const botMember = guild?.members?.me;
            if (botMember) {
                const permissions = voiceChannel.permissionsFor(botMember);
                if (permissions && (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak))) {
                    return await safeReply(interaction, {
                        embeds: [createActionEmbed('error', 'Missing Permissions', `ZYRO requires **Connect** and **Speak** permissions in <#${voiceChannel.id}>.`)],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            if (!isLavalinkAvailable(client)) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Music Service Reconnecting', 'Music service is reconnecting; please try again shortly.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const activeNode = client.lavalinkConnectionManager?.getActiveNode?.()
                || client.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                || (client.lavalink?.nodeManager?.nodes ? Array.from(client.lavalink.nodeManager.nodes.values())[0] : null);

            let player = client.lavalink.getPlayer(guild.id);
            if (!player) {
                player = client.lavalink.createPlayer({
                    guildId: guild.id,
                    voiceChannelId: voiceChannel.id,
                    textChannelId: interaction.channelId,
                    selfDeaf: true,
                    selfMute: false,
                    volume: getValidVolume(process.env.DEFAULT_VOLUME, 80),
                    node: activeNode?.id || undefined,
                });
            } else {
                player.voiceChannelId = voiceChannel.id;
                player.textChannelId = interaction.channelId;
            }

            if (!player.connected) {
                await Promise.race([
                    player.connect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Voice connection timed out')), 5000))
                ]);
            }

            logger.cmd(`/join in #${voiceChannel.name} (Guild: ${guild.name})`);

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Connected', `Connected to <#${voiceChannel.id}>.`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /join command (Guild: ${guild?.id}):`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Connection Failed', `Failed to connect to voice channel: \`${error?.message || error}\``)],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
