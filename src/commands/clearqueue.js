const { SlashCommandBuilder } = require('discord.js');
const clearCommand = require('./clear');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clearqueue')
        .setDescription('Clears all songs from the upcoming queue.'),
    async execute(interaction) {
        const handler = interaction.client?.commands?.get('clear') || clearCommand;
        return await handler.execute(interaction);
    },
};
