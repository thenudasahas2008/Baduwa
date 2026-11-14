// /help — grouped command reference + button control panel guide
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, EmbedBuilder } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show all commands and button controls')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎧 Music Bot — Guide & Commands')
    .setDescription(
      'Type a command or use the interactive in-Discord button panel on every now-playing message! `/play` shows song suggestions while you type.'
    )
    .addFields(
      {
        name: '🎛️ In-Discord Button Control Panel',
        value: [
          '• `⏯️ Pause / Resume` — toggle audio playback',
          '• `⏭️ Skip` — jump to the next track',
          '• `⏮️ Previous` — replay history track',
          '• `⏹️ Stop` — stop playback and clear',
          '• `🔀 Shuffle` — randomize remaining queue',
          '• `🔮 Autoplay` — toggle smart autoplay (green when ON)',
          '• `🔁 Loop` — cycle Off ➔ Track ➔ Queue ➔ Off',
          '• `📜 Queue` — view upcoming tracks in an instant popup',
          '• `🔊 Vol+ / 🔉 Vol-` — adjust volume in 10% steps (0-150)',
        ].join('\n'),
      },
      {
        name: '🎵 Playback Commands',
        value: [
          '`/play` — play a song (name / YouTube / Spotify link)',
          '`/pause` • `/resume` — pause & resume',
          '`/skip` — skip 1 (or `/skip count:5`)',
          '`/previous` — previous song',
          '`/seek` — jump to a time (`1:30` or `90`)',
          '`/stop` — stop & clear queue',
          '`/volume` — adjust volume (0-150)',
        ].join('\n'),
      },
      {
        name: '📜 Queue Commands',
        value: [
          '`/queue` — see what is queued (`/queue view:history`)',
          '`/nowplaying` — current song + interactive control panel',
          '`/shuffle` • `/remove` • `/clear` • `/move` • `/loop`',
        ].join('\n'),
      },
      {
        name: '♾️ 24/7 & Autoplay',
        value: [
          '`/autoplay` — automatically plays similar songs forever (radio mode)',
          '`/247` — bot stays in voice channel 24/7 (auto-rejoins after restart)',
          '`/disconnect` — disconnect the bot from voice',
        ].join('\n'),
      },
      {
        name: 'ℹ️ Info',
        value: '`/ping` — bot latency & uptime\n\nWhile playing, the current song automatically updates under the **Voice Channel status**, and the bot presence rotates with current track details.',
      }
    );

  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
