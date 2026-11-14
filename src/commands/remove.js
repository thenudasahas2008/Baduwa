// /remove — remove a song from the queue by its position number
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('Remove a song from the queue')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addIntegerOption((o) => o.setName('number').setDescription('Queue position to remove (see /queue)').setMinValue(1).setRequired(true));

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || queue.isEmpty()) return void (await interaction.reply({ content: 'The queue is empty — nothing to remove.', ephemeral: true }));
  const n = interaction.options.getInteger('number', true);
  if (n > queue.size) return void (await interaction.reply({ content: `The queue only has ${queue.size} songs — position ${n} does not exist.`, ephemeral: true }));
  const track = queue.tracks.at(n - 1);
  if (!track) return void (await interaction.reply({ content: 'Could not find that track.', ephemeral: true }));
  queue.removeTrack(track);
  await interaction.reply(`Removed **${track.title}** from the queue 🗑️`);
}

module.exports = { data, execute };
