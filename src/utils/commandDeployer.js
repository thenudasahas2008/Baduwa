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
        if (client.guilds?.cache?.size > 0) {
            for (const guild of client.guilds.cache.values()) {
                try {
                    await rest.put(
                        Routes.applicationGuildCommands(client.user.id, guild.id),
                        { body: [] },
                    );
                    logger.debug(`Purged duplicate guild-scoped commands for guild ${guild.name} (${guild.id})`);
                } catch (gErr) {
                    logger.debug(`Could not clear guild-scoped commands for guild ${guild.id}:`, gErr?.message || gErr);
                }
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
