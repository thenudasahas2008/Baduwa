// /stop — stop music. With 24/7 mode ON the bot stays in the voice channel.
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop the music and clear the queue (bot stays if 24/7 mode is on)')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue) return void (await interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true }));
  const tf = ctx.store.flags(interaction.guild.id).twenty4seven;
  queue.node.stop();
  queue.clear();
  if (tf) {
    await interaction.reply('Stopped the music 🛑 — bot stays in the voice channel (24/7 mode is ON, use `/247` to disable).');
  } else {
    await interaction.reply('Stopped the music 🛑 — use `/play` to start again.');
  }
}

module.exports = { data, execute };
