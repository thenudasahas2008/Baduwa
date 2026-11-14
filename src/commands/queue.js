// /queue — show the queue (upcoming + history)
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, EmbedBuilder } = require('discord.js');
const { fmtDuration } = require('../bot/ui');

const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addStringOption((o) =>
    o
      .setName('view')
      .setDescription('Which part of the queue to show')
      .addChoices({ name: 'Up next', value: 'next' }, { name: 'History', value: 'history' })
  );

function line(i, t) {
  const dur = t.durationMS ? fmtDuration(t.durationMS) : t.duration || 'live';
  return `**${i}.** [${(t.title || 'Unknown').slice(0, 60)}](${t.url || ''}) • ${dur} • ${t.requestedBy ? `<@${t.requestedBy.id}>` : 'autoplay'}`;
}

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue) return void (await interaction.reply({ content: 'The queue is empty — start something with `/play`!', ephemeral: true }));

  const view = interaction.options.getString('view') || 'next';
  const embed = new EmbedBuilder().setColor(0x1db954).setTitle(`Queue — ${interaction.guild.name}`);
  const f = ctx.store.flags(interaction.guild.id);
  embed.setDescription(`Autoplay: ${f.autoplay ? '✅ on' : 'off'} • 24/7 mode: ${f.twenty4seven ? '✅ on' : 'off'}`);

  if (view === 'history') {
    const hist = queue.history.tracks.toArray().reverse().slice(0, 12);
    if (!hist.length) return void (await interaction.reply({ content: 'History is empty.', ephemeral: true }));
    embed.setTitle('Recently played');
    embed.setDescription(hist.map((t, idx) => line(idx + 1, t)).join('\n'));
    embed.setFooter({ text: `Total history size: ${queue.history.size}` });
    return void (await interaction.reply({ embeds: [embed] }));
  }

  if (queue.currentTrack) {
    embed.addFields({ name: '▶ Now playing', value: line('•', queue.currentTrack).slice(0, 1024) });
  }
  const upcoming = queue.tracks.toArray().slice(0, 12);
  if (upcoming.length) {
    embed.addFields({ name: `⏭ Up next (${queue.size} total)`, value: upcoming.map((t, i) => line(i + 1, t)).join('\n').slice(0, 1024) });
  } else if (!queue.currentTrack) {
    return void (await interaction.reply({ content: 'The queue is empty — start something with `/play`!', ephemeral: true }));
  } else {
    embed.addFields({ name: '⏭ Up next', value: f.autoplay ? 'Autoplay will keep the music going 🎵' : 'Nothing queued — `/play` something!' });
  }
  embed.setFooter({ text: `Total queue duration: ${queue.durationFormatted}` });
  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
