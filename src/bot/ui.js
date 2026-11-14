// Embed builders shared by events and commands
const { EmbedBuilder } = require('discord.js');
const { buildPanel, fmtDuration } = require('./panel');

function trackBaseEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle(track.title || 'Unknown track')
    .setURL(track.url || null)
    .setAuthor({ name: track.author || 'Unknown artist' });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

function nowPlayingEmbed(queue, track) {
  const panel = buildPanel(queue, track);
  return panel.embeds[0];
}

module.exports = { fmtDuration, trackBaseEmbed, nowPlayingEmbed };
