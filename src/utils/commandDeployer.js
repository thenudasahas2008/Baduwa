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

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    try {
        logger.info(`Refreshing ${commands.length} application (/) commands globally.`);

        const data = await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );

        logger.info(`Successfully registered ${data.length} application (/) commands globally.`);

        // Deploy commands to each active guild for instantaneous visibility in Discord clients
        if (client.guilds?.cache?.size > 0) {
            for (const guild of client.guilds.cache.values()) {
                try {
                    await rest.put(
                        Routes.applicationGuildCommands(client.user.id, guild.id),
                        { body: commands },
                    );
                    logger.debug(`Instant command deployment complete for guild ${guild.name} (${guild.id})`);
                } catch (gErr) {
                    logger.debug(`Could not deploy commands to guild ${guild.id}:`, gErr?.message || gErr);
                }
            }
        }
    } catch (error) {
        logger.error('Failed to deploy commands:', error);
    }
}

deployCommands.deployGuildCommands = async function(client, guildId) {
    if (!process.env.TOKEN || !client?.user?.id || !guildId) return;
    try {
        const commands = [];
        const seenNames = new Set();
        client.commands?.forEach(command => {
            const commandData = command.data.toJSON();
            if (!seenNames.has(commandData.name)) {
                seenNames.add(commandData.name);
                commands.push(commandData);
            }
        });
        const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
        logger.info(`Instantly deployed commands to joined guild ${guildId}`);
    } catch (err) {
        logger.debug(`Error deploying commands to guild ${guildId}:`, err?.message || err);
    }
};

module.exports = deployCommands;
