const { REST, Routes } = require('discord.js');
const logger = require('./logger');

async function deployCommands(client) {
    const commands = [];
    const seenNames = new Set();

    client.commands.forEach(command => {
        const commandData = command.data.toJSON();

        if (seenNames.has(commandData.name)) {
            logger.warn(`Duplicate command name "${commandData.name}", skipping.`);
            return;
        }

        seenNames.add(commandData.name);
        commands.push(commandData);
    });

    const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
    if (!token) {
        logger.warn('Cannot deploy application commands: No TOKEN or DISCORD_TOKEN provided in environment.');
        return;
    }

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        logger.info(`Refreshing ${commands.length} application (/) commands globally.`);

        const data = await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );

        logger.info(`Successfully registered ${data.length} application (/) commands globally.`);

        // Purge guild-scoped commands for all active guilds to eliminate duplicate slash command entries in Discord UI
        let guilds = [];
        try {
            if (typeof client.guilds?.fetch === 'function') {
                const fetched = await client.guilds.fetch().catch(() => null);
                if (fetched) {
                    guilds = Array.from(fetched.values());
                }
            }
        } catch (_) {}
        if (!guilds.length && client.guilds?.cache?.size > 0) {
            guilds = Array.from(client.guilds.cache.values());
        }

        // Also include any guild IDs known in guild settings
        const knownGuildIds = new Set(guilds.map(g => g.id || g));
        try {
            const guildSettings = client.guildSettings || require('./guildSettings');
            if (guildSettings?.cache) {
                for (const gId of guildSettings.cache.keys()) {
                    if (!knownGuildIds.has(gId)) {
                        knownGuildIds.add(gId);
                        guilds.push({ id: gId, name: gId });
                    }
                }
            }
        } catch (_) {}

        for (const guild of guilds) {
            const gId = guild.id || guild;
            try {
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, gId),
                    { body: [] },
                );
                logger.info(`Purged duplicate guild-scoped commands for guild ${guild.name || gId} (${gId})`);
            } catch (gErr) {
                logger.debug(`Could not clear guild-scoped commands for guild ${gId}:`, gErr?.message || gErr);
            }
        }
    } catch (error) {
        logger.error('Failed to deploy commands:', error);
    }
}

deployCommands.deployGuildCommands = async function(client, guildId) {
    const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
    if (!token || !client?.user?.id || !guildId) return;
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        // Clear any guild-specific commands so only single global commands are active, preventing duplicates
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] });
        logger.debug(`Cleared guild-scoped commands for guild ${guildId} to prevent duplicates`);
    } catch (err) {
        logger.debug(`Error clearing guild commands for guild ${guildId}:`, err?.message || err);
    }
};

module.exports = deployCommands;
