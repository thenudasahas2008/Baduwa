// /previous — go back to the previous song
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('previous')
  .setDescription('Play the previous song from history')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || !queue.isPlaying()) return void (await interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true }));
  if (!queue.history.size) return void (await interaction.reply({ content: 'No history yet — this is the first song!', ephemeral: true }));
  await queue.history.back(true);
  await interaction.reply('Playing the previous song ⏮️');
}

module.exports = { data, execute };
