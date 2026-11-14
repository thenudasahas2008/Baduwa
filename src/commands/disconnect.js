// /disconnect — force the bot out of the voice channel (also disables 24/7 for that guild)
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('disconnect')
  .setDescription('Disconnect the bot from the voice channel')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const guildId = interaction.guild.id;
  const queue = ctx.player.nodes.get(guildId);
  const botVc = interaction.guild.members.me && interaction.guild.members.me.voice && interaction.guild.members.me.voice.channel;

  if (!queue && !botVc) return void (await interaction.reply({ content: 'The bot is not in any voice channel.', ephemeral: true }));

  // turning 24/7 off so the watchdog/restart does not auto rejoin
  if (ctx.store.flags(guildId).twenty4seven) ctx.store.setFlag(guildId, 'twenty4seven', false);

  if (queue) queue.delete();
  else if (botVc) await interaction.guild.members.me.voice.disconnect().catch(() => {});

  await interaction.reply('Disconnected 👋 — 24/7 mode disabled. `/play` me anytime!');
}

module.exports = { data, execute };
