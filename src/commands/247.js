// /247 — toggle 24/7 mode: the bot never leaves the voice channel, never
// auto-disconnects, survives restarts (auto-rejoin) and keeps the queue alive.
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, EmbedBuilder } = require('discord.js');
const { baseQueueOptions } = require('../bot/music');

const data = new SlashCommandBuilder()
  .setName('247')
  .setDescription('Toggle 24/7 mode — bot stays in the voice channel forever (no auto-leave)')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const guildId = interaction.guild.id;
  const on = !ctx.store.flags(guildId).twenty4seven;
  ctx.store.setFlag(guildId, 'twenty4seven', on);

  let queue = ctx.player.nodes.get(guildId);

  if (on) {
    if (!queue) {
      const member = interaction.member;
      const vc = member && member.voice && member.voice.channel;
      if (vc) {
        queue = ctx.player.nodes.create(interaction.guild, baseQueueOptions(guildId, interaction.channel));
        await queue.connect(vc).catch(() => {});
        ctx.store.touchChannels(guildId, { voiceChannelId: vc.id, textChannelId: interaction.channel.id });
      }
    }
    if (queue) {
      ctx.store.touchChannels(guildId, {
        voiceChannelId: queue.channel ? queue.channel.id : null,
        textChannelId: interaction.channel.id,
      });
      ctx.music.applyFlagsToQueue(queue);
    }
  } else if (queue) {
    ctx.music.applyFlagsToQueue(queue);
  }

  const embed = new EmbedBuilder().setColor(on ? 0x1db954 : 0x555555);
  if (on) {
    embed
      .setTitle('24/7 mode ON ♾️')
      .setDescription(
        [
          'The bot will **never** leave the voice channel:',
          '• Stays even when the voice channel is empty',
          '• Keeps the queue alive when it runs out',
          '• Auto-rejoins the channel even after a restart',
          '',
          'Tip: turn on `/autoplay` too and this becomes a **non-stop radio**!',
        ].join('\n')
      );
  } else {
    embed
      .setTitle('24/7 mode OFF')
      .setDescription(
        'Back to normal: the bot leaves when the voice channel is empty (after 5 min), when the queue ends, or when `/stop` is used.'
      );
  }
  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
