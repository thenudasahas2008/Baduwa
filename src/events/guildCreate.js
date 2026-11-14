const { ChannelType, PermissionsBitField } = require('discord.js');
const { buildWelcomeEmbed, buildWelcomeComponents } = require('../utils/welcomeManager');
const logger = require('../utils/logger');

// Prevent duplicate welcome messages
const welcomedGuilds = new Set();

function findWelcomeChannel(guild) {
    const me = guild.members?.me;
    if (!me) return guild.systemChannel || guild.channels?.cache?.first?.() || null;

    const requiredPerms = [
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks
    ];

    if (guild.systemChannel && guild.systemChannel.permissionsFor(me)?.has(requiredPerms)) {
        return guild.systemChannel;
    }

    return guild.channels?.cache
        ?.filter(ch => ch.type === ChannelType.GuildText && ch.permissionsFor(me)?.has(requiredPerms))
        ?.sort((a, b) => (a.position || 0) - (b.position || 0))
        ?.first?.() || null;
}

module.exports = {
    name: 'guildCreate',
    once: false,
    async execute(guild) {
        if (!guild || welcomedGuilds.has(guild.id)) return;

        const { client } = guild;
        const deployCommands = require('../utils/commandDeployer');
        if (typeof deployCommands.deployGuildCommands === 'function') {
            deployCommands.deployGuildCommands(client, guild.id).catch(() => {});
        }

        const channel = findWelcomeChannel(guild);
        if (!channel) return;

        welcomedGuilds.add(guild.id);
        logger.info(`Sending ZYRO welcome message in ${guild.name} (#${channel.name})`);

        const embed = buildWelcomeEmbed(client);
        const components = buildWelcomeComponents();

        try {
            const sent = await channel.send({ embeds: [embed], components });
            if (sent?.id && client?.guildSettings?.setWelcomeMigrated) {
                client.guildSettings.setWelcomeMigrated(guild.id, {
                    messageId: sent.id,
                    channelId: channel.id
                });
            }
        } catch (error) {
            logger.warn(`Could not send welcome message in ${guild.name}: ${error.message}`);
        }
    },
    welcomedGuilds,
    findWelcomeChannel,
};
