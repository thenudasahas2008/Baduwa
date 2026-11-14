// /clear — remove everything from the queue (keeps the current song playing)
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Clear all queued songs (the current song keeps playing)')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || queue.isEmpty()) return void (await interaction.reply({ content: 'The queue is already empty.', ephemeral: true }));
  const count = queue.size;
  queue.clear();
  await interaction.reply(`Cleared **${count}** songs from the queue 🧹`);
}

module.exports = { data, execute };
