// All discord-player queue events + ZYRO-style now-playing panel lifecycle.
// The bot maintains ONE persistent panel message per guild, updated on track start,
// pause, resume, queue end, and progress ticks.
const { GuildQueueEvent } = require('discord-player');
const {
  updatePanel,
  startProgressInterval,
  stopProgressInterval,
  clearPanel,
  panelState,
} = require('./panel');
const prefetch = require('./prefetch');
const store = require('./store');
const vcStatus = require('./vcStatus');

/** guildId -> watchdog timer handle */
const silentWatchdogs = new Map();

function safeSend(queue, payload) {
  try {
    const channel = queue.metadata && queue.metadata.channel;
    if (!channel || typeof channel.send !== 'function') return null;
    return channel.send(payload).catch(() => null);
  } catch {
    return null;
  }
}

function clearWatchdog(guildId) {
  const timer = silentWatchdogs.get(guildId);
  if (timer) {
    clearTimeout(timer);
    silentWatchdogs.delete(guildId);
  }
}

function setupWatchdog(queue, track) {
  const guildId = queue?.guild?.id;
  if (!guildId) return;
  clearWatchdog(guildId);

  // Watchdog: If track has started but playback is stalled after 25 seconds, force-skip once
  const timer = setTimeout(() => {
    try {
      if (!queue || !queue.isPlaying()) return;
      if (queue.currentTrack !== track) return;

      const streamTime = queue.node?.playbackTime ?? queue.node?.streamTime ?? 0;
      const isBuffering = typeof queue.node?.isBuffering === 'function' && queue.node.isBuffering();

      if (streamTime <= 0 && !queue.node.isPaused() && !isBuffering) {
        console.warn(
          `[watchdog] Stalled stream detected for "${track.title}" in guild "${queue.guild.name}". Skipping to next track...`
        );
        safeSend(queue, {
          content: `⚠️ Playback stalled for **${track.title}** — skipping to next track.`,
        });
        queue.node.skip();
      }
    } catch (e) {
      console.error('[watchdog] error during check:', e.message);
    }
  }, 25_000);

  silentWatchdogs.set(guildId, timer);
}

function attach(player) {
  player.events.on(GuildQueueEvent.playerStart, async (queue, track) => {
    clearWatchdog(queue.guild.id);
    await updatePanel(queue, track);
    startProgressInterval(queue);
    setupWatchdog(queue, track);
    prefetch.prefetchNext(queue);
    // Song title appears under voice channel's status
    vcStatus.setNowPlaying(queue, track);
  });

  player.events.on(GuildQueueEvent.playerPause, async (queue) => {
    stopProgressInterval(queue.guild.id);
    await updatePanel(queue);
  });

  player.events.on(GuildQueueEvent.playerResume, async (queue) => {
    startProgressInterval(queue);
    await updatePanel(queue);
  });

  // Smart autoplay picker: skip already-played and very short videos
  player.events.on(GuildQueueEvent.willAutoPlay, (queue, tracks, done) => {
    try {
      if (!Array.isArray(tracks) || !tracks.length) return done(null);
      const seen = new Set(queue.history.tracks.toArray().map((t) => t.url));
      const fresh = tracks.filter((t) => t.url && !seen.has(t.url));
      const pool = fresh.length ? fresh : tracks.slice(0, 5);
      const longEnough = pool.filter((t) => (t.durationMS || 0) > 60_000);
      done((longEnough.length ? longEnough : pool)[0]);
    } catch {
      done(tracks[0] || null);
    }
  });

  player.events.on(GuildQueueEvent.playerSkip, (queue) => {
    clearWatchdog(queue.guild.id);
  });

  player.events.on(GuildQueueEvent.emptyQueue, async (queue) => {
    clearWatchdog(queue.guild.id);
    stopProgressInterval(queue.guild.id);

    const f = store.flags(queue.guild.id);
    if (f.autoplay) {
      vcStatus.setStandby(queue, 'autoplay');
      return;
    }

    await updatePanel(queue, null); // Switch to Standby panel
    vcStatus.setStandby(queue, f.twenty4seven ? 'twenty4seven' : null);

    if (!f.twenty4seven) {
      safeSend(queue, {
        content: 'Queue finished! Type `/queue history` to see what was played — or use `/autoplay` to keep similar songs coming automatically.',
      });
    } else {
      safeSend(queue, {
        content: 'Queue finished — bot stays in the voice channel (24/7 mode). Use `/play` or `/autoplay` any time!',
      });
    }
  });

  player.events.on(GuildQueueEvent.emptyChannel, (queue) => {
    const f = store.flags(queue.guild.id);
    vcStatus.clear(queue);
    if (!f.twenty4seven) {
      safeSend(queue, { content: 'Voice channel is empty — leaving. Use `/247` to make the bot stay 24/7!' });
    }
  });

  player.events.on(GuildQueueEvent.queueDelete, (queue) => {
    clearWatchdog(queue.guild.id);
    clearPanel(queue.guild.id);
    vcStatus.clear(queue);
  });

  player.events.on(GuildQueueEvent.playerError, (queue, error, track) => {
    clearWatchdog(queue.guild.id);
    console.error(`[player] error on "${track && track.title}":`, error && (error.stack || error.message || error));
    safeSend(queue, { content: `⚠️ Something went wrong while playing "${track ? track.title : 'track'}" — skipping it.` });
  });

  player.events.on(GuildQueueEvent.error, (queue, error) => {
    console.error('[queue] error:', error && (error.stack || error.message || error));
    safeSend(queue, { content: '⚠️ The player hit an error — check the console logs.' });
  });
}

module.exports = {
  attach,
  safeSend,
  clearWatchdog,
  panelState,
  lastNpMessages: panelState, // for backward compat if referenced
};
