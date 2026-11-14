// Music engine: search resolution (YT names/links, Spotify links, other URLs), queue
// creation with 24/7 aware options, autoplay kick, enqueue + start logic.
const { QueryType, QueueRepeatMode } = require('discord-player');
const store = require('./store');
const spotify = require('./spotify');

function isUrl(q) {
  return /^https?:\/\//i.test(String(q || '').trim());
}

function isYouTubeUrl(q) {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(String(q || ''));
}

function extractVideoId(url) {
  const m = String(url || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function baseQueueOptions(guildId, textChannel) {
  const f = store.flags(guildId);
  return {
    metadata: { channel: textChannel || null },
    selfDeaf: true,
    pauseOnEmpty: false,
    leaveOnEmpty: !f.twenty4seven,
    leaveOnEmptyCooldown: f.twenty4seven ? 0 : 300_000,
    leaveOnEnd: !f.twenty4seven,
    leaveOnEndCooldown: 10_000,
    leaveOnStop: !f.twenty4seven,
    leaveOnStopCooldown: 0,
    repeatMode: f.autoplay ? QueueRepeatMode.AUTOPLAY : QueueRepeatMode.OFF,
    maxHistorySize: 500,
    bufferingTimeout: 2000,
  };
}

function createEngine(player) {

  function ensureQueue(guild, voiceChannel, textChannel) {
    let queue = player.nodes.get(guild.id);
    if (!queue) {
      queue = player.nodes.create(guild, baseQueueOptions(guild.id, textChannel));
    }
    if (textChannel) queue.metadata = { channel: textChannel };
    return queue;
  }

  async function ensureQueueConnected(guild, voiceChannel, textChannel) {
    const queue = ensureQueue(guild, voiceChannel, textChannel);
    const me = guild.members.me;
    const isConnected = me && me.voice && me.voice.channelId && queue.connection && queue.channel;
    if (voiceChannel && (!isConnected || queue.channel.id !== voiceChannel.id)) {
      await queue.connect(voiceChannel);
    }
    return queue;
  }

  function applyFlagsToQueue(queue) {
    if (!queue) return;
    const f = store.flags(queue.guild.id);
    queue.options.leaveOnEmpty = !f.twenty4seven;
    queue.options.leaveOnEmptyCooldown = f.twenty4seven ? 0 : 300_000;
    queue.options.leaveOnEnd = !f.twenty4seven;
    queue.options.leaveOnStop = !f.twenty4seven;
    queue.options.pauseOnEmpty = false;
    if (queue.repeatMode !== QueueRepeatMode.TRACK && queue.repeatMode !== QueueRepeatMode.QUEUE) {
      queue.setRepeatMode(f.autoplay ? QueueRepeatMode.AUTOPLAY : QueueRepeatMode.OFF);
    }
  }

  async function youtubeUrlFallback(url, user) {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (!r.ok) return null;
      const info = await r.json().catch(() => null);
      if (!info || !info.title) return null;
      const q = `${info.title} ${info.author_name || ''}`.trim();
      const res = await player.search(q, { requestedBy: user, searchEngine: QueryType.YOUTUBE_SEARCH });
      if (!res.tracks.length) return null;
      const id = extractVideoId(url);
      const match = id ? res.tracks.find((t) => extractVideoId(t.url) === id) : null;
      return { tracks: [match || res.tracks[0]], playlist: null };
    } catch {
      return null;
    }
  }

  function enqueue(queue, res, user) {
    if (res.playlist && res.playlist.tracks.length > 1) {
      const tracks = res.playlist.tracks.slice();
      queue.addTrack(tracks);
      if (!queue.isPlaying() && !queue.node.isPaused()) {
        queue.node.play().catch((err) => console.error('[music] queue.node.play error:', err));
      }
      return { count: tracks.length, first: tracks[0], playlist: res.playlist };
    }

    const track = res.tracks[0];
    queue.addTrack(track);
    if (!queue.isPlaying() && !queue.node.isPaused()) {
      queue.node.play().catch((err) => console.error('[music] queue.node.play error:', err));
    }
    return { count: 1, first: track, playlist: null };
  }

  async function addFromQueries(queue, user, resolved) {
    const queries = resolved.queries.slice();
    const batchSize = 6;
    const firstBatch = queries.splice(0, batchSize);

    const lookupOne = async (q) => {
      try {
        const res = await player.search(q, { requestedBy: user, searchEngine: QueryType.YOUTUBE_SEARCH });
        return res.tracks[0] || null;
      } catch {
        return null;
      }
    };

    const firstTracks = (await Promise.all(firstBatch.map(lookupOne))).filter(Boolean);
    if (!firstTracks.length) throw new Error(`Could not find any tracks for "${resolved.title}".`);

    firstTracks.forEach((t) => queue.addTrack(t));
    if (!queue.isPlaying() && !queue.node.isPaused()) {
      await queue.node.play().catch((err) => console.error('[music] queue.node.play error:', err));
    }

    if (queries.length) {
      (async () => {
        while (queries.length) {
          const slice = queries.splice(0, batchSize);
          const tracks = (await Promise.all(slice.map(lookupOne))).filter(Boolean);
          tracks.forEach((t) => queue.addTrack(t));
        }
      })().catch((e) => console.error('[spotify] background enqueue failed:', e.message));
    }

    const found = firstTracks.slice();
    return {
      count: resolved.queries.length,
      first: found[0],
      playlist: { title: resolved.title, tracks: found, source: 'spotify' },
    };
  }

  /**
   * Full play flow. Caller: slash /play.
   * @param {object} p { guild, voiceChannel, textChannel, user, query }
   */
  async function playQuery(p) {
    const query = String(p.query || '').trim();
    if (!query) throw new Error('Query cannot be empty — give a song name or a link.');

    const queue = await ensureQueueConnected(p.guild, p.voiceChannel, p.textChannel);
    store.touchChannels(p.guild.id, {
      voiceChannelId: p.voiceChannel ? p.voiceChannel.id : null,
      textChannelId: p.textChannel ? p.textChannel.id : null,
    });

    if (spotify.isSpotifyUrl(query)) {
      const resolved = await spotify.resolveLink(query).catch((e) => {
        console.error('[spotify] resolveLink failed:', e.message);
        return null;
      });
      if (resolved && resolved.queries.length) {
        return addFromQueries(queue, p.user, resolved);
      }
      const res = await player.search(query, { requestedBy: p.user });
      if (res.tracks.length || res.playlist) return enqueue(queue, res, p.user);
      throw new Error(
        'Could not resolve that Spotify link.\n' +
          'Fix: add `DP_SPOTIFY_CLIENT_ID` and `DP_SPOTIFY_CLIENT_SECRET` to your `.env` (free — see README > Spotify setup).'
      );
    }

    if (isUrl(query)) {
      const res = await player.search(query, { requestedBy: p.user });
      const first = res.tracks[0];
      const emptyMetadata = res.tracks.length > 0 && first && !first.title;
      if ((!res.tracks.length || emptyMetadata) && isYouTubeUrl(query)) {
        const fixed = await youtubeUrlFallback(query, p.user);
        if (fixed && fixed.tracks.length) return enqueue(queue, fixed, p.user);
      }
      if (res.tracks.length || res.playlist) return enqueue(queue, res, p.user);
      throw new Error('Could not load any track from that link.');
    }

    const res = await player.search(query, { requestedBy: p.user, searchEngine: QueryType.YOUTUBE_SEARCH });
    if (!res.tracks.length) throw new Error(`No results found for "${query}" — try different words.`);
    return enqueue(queue, res, p.user);
  }

  // Manually start autoplay when queue is idle but autoplay is on (e.g. right after /autoplay on).
  async function kickAutoplay(queue) {
    if (!queue || queue.isPlaying() || !queue.isEmpty()) return false;
    const hist = queue.history;
    const size = hist.size;
    if (!size) return false;
    const last = hist.tracks.at(size - 1);
    if (!last) return false;
    const res = await player.extractors
      .run(async (ext) => {
        try {
          const r = await ext.getRelatedTracks(last, queue.history);
          if (r && r.tracks && r.tracks.length) return r.tracks;
          return false;
        } catch {
          return false;
        }
      })
      .catch(() => null);
    const tracks = res && res.result;
    if (!Array.isArray(tracks) || !tracks.length) return false;
    const seen = new Set(queue.history.tracks.toArray().map((t) => t.url));
    const pool = tracks.filter((t) => t.url && !seen.has(t.url));
    const next = (pool.length ? pool : tracks).find((t) => (t.durationMS || 0) > 60_000) || (pool.length ? pool[0] : tracks[0]);
    if (!next) return false;
    queue.addTrack(next);
    if (!queue.isPlaying() && !queue.node.isPaused()) {
      await queue.node.play().catch((err) => console.error('[music] kickAutoplay play error:', err));
    }
    return true;
  }

  return { playQuery, ensureQueue, ensureQueueConnected, applyFlagsToQueue, kickAutoplay };
}

module.exports = {
  createEngine,
  baseQueueOptions,
  isUrl,
  isYouTubeUrl,
  extractVideoId,
};
