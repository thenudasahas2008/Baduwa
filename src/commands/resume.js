// /resume — resume paused playback
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume playback')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || !queue.node.isPaused()) {
    return void (await interaction.reply({ content: 'Playback is not paused.', ephemeral: true }));
  }
  queue.node.resume();
  await interaction.reply('Resumed ▶️');
}

module.exports = { data, execute };
