// /ping — bot latency + uptime
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Show bot latency and uptime')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m`;
}

async function execute(interaction, ctx) {
  const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
  const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
  const ws = ctx.client.ws.ping < 0 ? 'reconnecting' : `${Math.round(ctx.client.ws.ping)}ms`;
  await interaction.editReply(
    `🏓 Pong!\nRoundtrip: **${roundtrip}ms** • Gateway: **${ws}**\nUptime: **${fmtUptime(process.uptime() * 1000)}**`
  );
}

module.exports = { data, execute };
