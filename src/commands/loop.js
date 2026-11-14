// /loop — cycle repeat mode: off -> track -> queue
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const { QueueRepeatMode } = require('discord-player');

const data = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('Cycle loop mode: off -> song -> queue')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

const labels = {
  [QueueRepeatMode.OFF]: 'loop **OFF**',
  [QueueRepeatMode.TRACK]: 'looping the current **song** 🔂',
  [QueueRepeatMode.QUEUE]: 'looping the whole **queue** 🔁',
};

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || (!queue.isPlaying() && queue.isEmpty())) {
    return void (await interaction.reply({ content: 'Nothing to loop — the queue is empty.', ephemeral: true }));
  }
  const order = [QueueRepeatMode.OFF, QueueRepeatMode.TRACK, QueueRepeatMode.QUEUE];
  const next = order[(order.indexOf(queue.repeatMode) + 1) % order.length];
  queue.setRepeatMode(next);
  await interaction.reply(`Set to ${labels[next]}`);
}

module.exports = { data, execute };
