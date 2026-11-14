// /play — the main command. Supports song names, YouTube links (video/playlist),
// Spotify links (track/album/playlist) and other direct audio URLs.
const {
  SlashCommandBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
  EmbedBuilder,
} = require('discord.js');
const { buildPanel, setPanelMessage, startProgressInterval, updatePanel } = require('../bot/panel');

const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song — name, YouTube link or Spotify link (with autocomplete suggestions)')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addStringOption((o) =>
    o.setName('query').setDescription('Song name / YouTube link / Spotify link').setRequired(true).setAutocomplete(true)
  )
  .addBooleanOption((o) => o.setName('next').setDescription('Play this song next (jump to front of the queue)'));

// ---- autocomplete ------------------------------------------------------------
const suggestCache = new Map(); // query -> { at, tracks: [{title, author, duration, url}] }

function pretty(track) {
  const label = `${track.title} — ${track.author}`.slice(0, 97);
  const dur = track.duration && track.duration !== '0:00' ? ` (${track.duration})` : '';
  return { name: (label + dur).slice(0, 100), value: track.url || track.title.slice(0, 100) };
}

async function autocomplete(interaction, ctx) {
  const q = interaction.options.getFocused(true).value;
  try {
    if (!q || q.trim().length < 2) return void (await interaction.respond([]));
    const key = q.trim().toLowerCase();
    let entry = suggestCache.get(key);
    if (!entry || Date.now() - entry.at > 60_000) {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2600));
      const search = ctx.player.search(q.trim(), { searchEngine: 'youtubeSearch' }).catch(() => null);
      const res = await Promise.race([search, timeout]);
      entry = { at: Date.now(), tracks: res && res.tracks ? res.tracks.slice(0, 8).map(pretty) : [] };
      suggestCache.set(key, entry);
      if (suggestCache.size > 200) {
        const oldest = [...suggestCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) suggestCache.delete(oldest[0]);
      }
    }
    await interaction.respond(entry.tracks.slice(0, 8));
  } catch {
    /* autocomplete failures are silently ignored */
  }
}

// ---- command -----------------------------------------------------------------
async function execute(interaction, ctx) {
  const query = interaction.options.getString('query', true);
  const asNext = interaction.options.getBoolean('next') || false;
  const member =
    interaction.guild.members.cache.get(interaction.user.id) ||
    (await interaction.guild.members.fetch(interaction.user.id));
  const voiceChannel = member && member.voice && member.voice.channel;

  if (!voiceChannel) {
    return void (await interaction.reply({
      content: 'You need to join a voice channel first! 🎧',
      ephemeral: true,
    }));
  }

  await interaction.deferReply();

  try {
    const existingQueue = ctx.player.nodes.get(interaction.guild.id);
    const alreadyPlaying = existingQueue && existingQueue.isPlaying();

    const out = await ctx.music.playQuery({
      guild: interaction.guild,
      voiceChannel,
      textChannel: interaction.channel,
      user: interaction.user,
      query,
    });

    const queue = ctx.player.nodes.get(interaction.guild.id);

    if (asNext && queue && queue.size > 1) {
      const track = queue.tracks.at(queue.size - 1);
      queue.node.move(track, 0);
    }

    if (alreadyPlaying) {
      // Added to existing queue -> reply with sleek confirmation & refresh panel stats
      const first = out.first || {};
      const addedEmbed = new EmbedBuilder()
        .setColor(0x7b2cbf)
        .setDescription(
          asNext
            ? `⏭️ **Added to front:** [${first.title || 'Track'}](${first.url || ''}) — plays next • by **${first.author || 'Artist'}**`
            : `✅ **Added to queue:** [${first.title || 'Track'}](${first.url || ''}) (#${queue?.tracks?.size || 1}) • by **${first.author || 'Artist'}**`
        );

      if (out.playlist && out.count > 1) {
        addedEmbed.setAuthor({
          name: `${out.playlist.title || 'Playlist'} • ${out.count} tracks added`,
        });
      }

      await interaction.editReply({ embeds: [addedEmbed] });
      if (queue) await updatePanel(queue).catch(() => {});
    } else {
      // Brand new playback -> Immediately send the ZYRO dashboard
      const payload = buildPanel(queue, out.first);
      const msg = await interaction.editReply(payload);
      if (msg && msg.id) {
        setPanelMessage(interaction.guild.id, msg.id, interaction.channelId);
      }
      if (queue) {
        startProgressInterval(queue);
      }
    }
  } catch (e) {
    console.error('[play]', e);
    await interaction.editReply({ content: `Could not play that: ${e.message || e}` }).catch(() => {});
  }
}

module.exports = { data, execute, autocomplete };
