// Rotating bot status — the activity line shown under the bot's name in the
// member list / voice channel user list (the "Mixing some tunes" look).
//
//  - While a song plays:  "Listening to <song title>"  (Discord adds its purple music note)
//  - While paused:        a custom "Music paused" status
//  - Idle:                rotating custom statuses (image-2 style clean text)
//
// Presence updates are rate limited by Discord (~5/minute), so updates are
// applied on a 13s tick, and event handlers only mark a pending change.
const { ActivityType } = require('discord.js');
const { GuildQueueEvent } = require('discord-player');

const IDLE_STATUSES = [
  'Mixing some tunes',
  '24/7 nonstop beats',
  'Type /play to drop a song',
  'Cueing up the next banger',
  'Never sleeping, always streaming',
];
const TICK_MS = 13_000; // safe against Discord's presence rate limit
const IDLE_ROTATE_TICKS = 5; // rotate the idle text every ~65 seconds

function start(client, player) {
  let idleIndex = 0;
  let idleTicks = 0;
  let pending = true;

  function playingTrack() {
    for (const guild of client.guilds.cache.values()) {
      const queue = player.nodes.get(guild.id);
      if (queue && queue.isPlaying() && queue.currentTrack) return queue.currentTrack;
    }
    return null;
  }

  function pausedQueue() {
    for (const guild of client.guilds.cache.values()) {
      const queue = player.nodes.get(guild.id);
      if (queue && queue.currentTrack && queue.node && queue.node.isPaused()) return queue;
    }
    return null;
  }

  function buildPresence() {
    const track = playingTrack();
    if (track && track.title) {
      return {
        activities: [{ name: String(track.title).slice(0, 100), type: ActivityType.Listening }],
        status: 'online',
      };
    }
    let state = IDLE_STATUSES[idleIndex % IDLE_STATUSES.length];
    if (pausedQueue()) state = 'Music paused — /resume brings it back';
    return {
      activities: [{ name: 'Custom Status', type: ActivityType.Custom, state }],
      status: 'online',
    };
  }

  function apply() {
    if (!client.user || typeof client.user.setPresence !== 'function') return;
    const presence = buildPresence();
    try {
      client.user.setPresence(presence);
    } catch (e) {
      console.error('[presence] setPresence failed:', e && e.message ? e.message : e);
    }
  }

  function tick() {
    if (playingTrack()) {
      idleTicks = 0;
    } else if (!pausedQueue()) {
      idleTicks++;
      if (idleTicks >= IDLE_ROTATE_TICKS) {
        idleTicks = 0;
        idleIndex++;
      }
    }
    if (pending) {
      apply();
      pending = false;
    }
  }

  // playback events only flag a pending update — the tick applies it (rate-limit safe)
  const markPending = () => {
    pending = true;
  };
  player.events.on(GuildQueueEvent.playerStart, markPending);
  player.events.on(GuildQueueEvent.playerSkip, markPending);
  player.events.on(GuildQueueEvent.emptyQueue, markPending);
  player.events.on(GuildQueueEvent.queueDelete, markPending);

  const timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();

  tick(); // first tick right away — applies the initial status once (pending starts true)

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { start, IDLE_STATUSES };
