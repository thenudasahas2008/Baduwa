// /move — move a song to a different position in the queue
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('move')
  .setDescription('Move a song within the queue')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addIntegerOption((o) => o.setName('from').setDescription('Current position of the song').setMinValue(1).setRequired(true))
  .addIntegerOption((o) => o.setName('to').setDescription('New position for the song').setMinValue(1).setRequired(true));

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || queue.isEmpty()) return void (await interaction.reply({ content: 'The queue is empty — nothing to move.', ephemeral: true }));
  const from = interaction.options.getInteger('from', true);
  const to = interaction.options.getInteger('to', true);
  if (from > queue.size || to > queue.size) {
    return void (await interaction.reply({ content: `The queue only has ${queue.size} songs.`, ephemeral: true }));
  }
  const track = queue.tracks.at(from - 1);
  if (!track) return void (await interaction.reply({ content: 'Could not find that track.', ephemeral: true }));
  queue.node.move(track, to - 1);
  await interaction.reply(`Moved **${track.title}** from position ${from} to ${to} 📦`);
}

module.exports = { data, execute };
