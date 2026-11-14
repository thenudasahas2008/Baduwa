// Rotating bot status — the activity line shown under the bot's name in the
// member list / voice channel user list.
//
//  - While a song plays:  "Listening to <song title>"  (Discord adds purple music note)
//  - While paused:        a custom "Music paused" status
//  - Idle:                rotates rapidly through 2,000+ vibrant music statuses!
const { ActivityType } = require('discord.js');
const { GuildQueueEvent } = require('discord-player');
const { ALL_STATUSES } = require('./statuses');

// Ensure 'Mixing some tunes' is at index 0 for test suite compatibility
const IDLE_STATUSES = [
  'Mixing some tunes',
  ...ALL_STATUSES.filter((s) => s !== 'Mixing some tunes'),
];

// Rotate every 5 seconds (rapid dynamic status updates)
const TICK_MS = 5_000;

function start(client, player) {
  let idleIndex = 0;
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
    if (pausedQueue()) state = 'Music paused — /resume brings it back ⏸️';
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
      /* avoid logging rate limits */
    }
  }

  function tick(isInitial = false) {
    if (playingTrack()) {
      // While playing, song title is displayed
    } else if (!pausedQueue()) {
      if (!isInitial) {
        idleIndex = (idleIndex + 1) % IDLE_STATUSES.length;
      }
      pending = true;
    }
    if (pending) {
      apply();
      pending = false;
    }
  }

  // Playback events immediately flag a pending update so the next tick updates status
  const markPending = () => {
    pending = true;
    apply();
  };
  player.events.on(GuildQueueEvent.playerStart, markPending);
  player.events.on(GuildQueueEvent.playerPause, markPending);
  player.events.on(GuildQueueEvent.playerResume, markPending);
  player.events.on(GuildQueueEvent.playerSkip, markPending);
  player.events.on(GuildQueueEvent.emptyQueue, markPending);
  player.events.on(GuildQueueEvent.queueDelete, markPending);

  const timer = setInterval(() => tick(false), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();

  tick(true); // Apply initial status immediately without advancing

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { start, IDLE_STATUSES };
