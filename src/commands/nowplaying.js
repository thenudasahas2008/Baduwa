// /nowplaying — show the song currently playing with the full ZYRO dashboard panel
const {
  SlashCommandBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
} = require('discord.js');
const { buildPanel } = require('../bot/panel');

const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Show what is playing right now')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || !queue.currentTrack) {
    return void (await interaction.reply({
      content: 'Nothing is playing right now. Use `/play` to start a song!',
      ephemeral: true,
    }));
  }

  const payload = buildPanel(queue, queue.currentTrack);
  await interaction.reply(payload);
}

module.exports = { data, execute };
