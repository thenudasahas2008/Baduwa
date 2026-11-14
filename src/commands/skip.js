// /skip — skip the current song (optionally skip many)
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the current song')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addIntegerOption((o) => o.setName('count').setDescription('How many songs to skip (default 1)').setMinValue(1).setMaxValue(50));

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || !queue.isPlaying()) return void (await interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true }));
  const count = interaction.options.getInteger('count') || 1;
  const current = queue.currentTrack;
  if (count > 1 && queue.size >= count) {
    for (let i = 1; i < count; i++) queue.node.skip();
  }
  queue.node.skip();
  await interaction.reply(`Skipped **${current ? current.title : 'track'}**${count > 1 ? ` (+${count - 1} more)` : ''} ⏭️`);
}

module.exports = { data, execute };
