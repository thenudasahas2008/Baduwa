// /seek — jump to a position in the current song
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('seek')
  .setDescription('Seek to a position in the current song (e.g. 90 or 1:30)')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addStringOption((o) => o.setName('time').setDescription('Position like 90 (seconds) or 1:30 (mm:ss)').setRequired(true));

function parseTime(input) {
  const str = String(input || '').trim();
  let m = str.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = str.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = str.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || !queue.isPlaying()) return void (await interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true }));
  const seconds = parseTime(interaction.options.getString('time', true));
  if (seconds == null) return void (await interaction.reply({ content: 'Invalid time format — use seconds (90) or mm:ss (1:30).', ephemeral: true }));
  const ok = await queue.node.seek(seconds * 1000);
  await interaction.reply(ok ? `Seeked to **${interaction.options.getString('time', true)}** ⏩` : 'Could not seek (live streams cannot be seeked).');
}

module.exports = { data, execute };
