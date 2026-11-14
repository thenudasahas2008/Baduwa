// /autoplay — toggle endless music: when the queue runs out the bot keeps
// suggesting and playing similar songs automatically.
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, EmbedBuilder } = require('discord.js');
const { trackBaseEmbed } = require('../bot/ui');
const { baseQueueOptions } = require('../bot/music');

const data = new SlashCommandBuilder()
  .setName('autoplay')
  .setDescription('Toggle autoplay — keep playing similar songs forever when the queue ends')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const guildId = interaction.guild.id;
  const on = !ctx.store.flags(guildId).autoplay;
  ctx.store.setFlag(guildId, 'autoplay', on);

  let queue = ctx.player.nodes.get(guildId);
  if (on && !queue) {
    const member = interaction.member;
    const vc = member && member.voice && member.voice.channel;
    if (vc) {
      queue = ctx.player.nodes.create(interaction.guild, baseQueueOptions(guildId, interaction.channel));
      await queue.connect(vc).catch(() => {});
    }
  }
  if (queue) ctx.music.applyFlagsToQueue(queue);

  if (on && queue && !queue.isPlaying() && queue.isEmpty()) {
    const kicked = await ctx.music.kickAutoplay(queue).catch(() => false);
    if (kicked) {
      const t = queue.currentTrack;
      return void (await interaction.reply({
        embeds: [
          trackBaseEmbed(t).setDescription('**Autoplay on** — picked up from history and started playing similar music 🎵'),
        ],
      }));
    }
  }

  await interaction.reply(
    on
      ? 'Autoplay **ON** ♾️ — when the queue runs out, the bot automatically finds and plays similar songs forever.\nTip: turn on `/247` too and the bot becomes a non-stop radio!'
      : 'Autoplay **off** — music stops when the queue runs out.'
  );
}

module.exports = { data, execute };
