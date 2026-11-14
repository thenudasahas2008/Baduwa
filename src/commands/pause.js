// /pause — pause the current song
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause the current song')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || !queue.node.isPlaying()) {
    return void (await interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true }));
  }
  queue.node.pause();
  await interaction.reply('Paused ⏸️ — use `/resume` to continue.');
}

module.exports = { data, execute };
