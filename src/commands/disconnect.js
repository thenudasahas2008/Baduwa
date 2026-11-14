const { SlashCommandBuilder } = require('discord.js');
const leaveCommand = require('./leave');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('disconnect')
        .setDescription('Disconnects ZYRO from voice and clears playback state.'),
    async execute(interaction) {
        const handler = interaction.client?.commands?.get('leave') || leaveCommand;
        return await handler.execute(interaction);
    },
};
