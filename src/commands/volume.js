// /volume — set playback volume (0-150)
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Set the music volume')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addIntegerOption((o) => o.setName('value').setDescription('Volume (0-150, default 100)').setMinValue(0).setMaxValue(150).setRequired(true));

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue) return void (await interaction.reply({ content: 'There is no queue here yet.', ephemeral: true }));
  const value = interaction.options.getInteger('value', true);
  queue.node.setVolume(value);
  await interaction.reply(`Volume set to **${value}%** ${value > 100 ? '🔊 (careful with those ears!)' : '🔉'}`);
}

module.exports = { data, execute };
