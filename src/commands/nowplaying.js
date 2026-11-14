// /nowplaying — show the song currently playing with a progress bar
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const { nowPlayingEmbed } = require('../bot/ui');

const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Show what is playing right now')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || !queue.currentTrack) {
    return void (await interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true }));
  }
  const bar = queue.node.createProgressBar({ timecodes: true, length: 18 });
  const embed = nowPlayingEmbed(queue, queue.currentTrack);
  if (bar) embed.addFields({ name: 'Progress', value: bar });
  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
