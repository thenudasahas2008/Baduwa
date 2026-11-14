// Voice channel status — the small "about" line that appears right under a
// voice channel's name in the channel list. While the bot plays a song, the
// song title automatically appears there (exactly like the first screenshot).
//
// REST API:
//   PUT    /channels/{id}/voice-status   body: { "status": "text" }  (max 500 chars)
//   DELETE /channels/{id}/voice-status   (clears it)
// Permission: SET_VOICE_CHANNEL_STATUS. The bot is connected to the channel while
// playing, so MANAGE_CHANNELS is NOT needed.
//
// discord.js exposes Routes.channelVoiceStatus() but has no helper method yet,
// so we call the REST manager directly. If the bot is missing the permission,
// we log a hint once and stop trying (wasting rate limit on 403s is pointless).
const { Routes } = require('discord.js');

const MAX_LEN = 150; // keep it tidy in the channel list
const GIVE_UP_AFTER = 4; // consecutive failures before disabling

let sharedClient = null;
let consecutiveFailures = 0;
let disabled = false;
const lastChannelByGuild = new Map(); // guildId -> last voice channel id we set a status on

const STANDBY = {
  autoplay: 'Autoplay is picking the next song...',
  twenty4seven: '24/7 mode — drop a song with /play',
};

function init(client) {
  sharedClient = client;
}

function trackText(track) {
  if (!track) return null;
  const title = String(track.title || '').trim();
  if (!title) return null;
  const author = String(track.author || '').trim();
  return (author ? `${title} • ${author}` : title).slice(0, MAX_LEN);
}

async function restCall(client, channelId, status) {
  const route = Routes.channelVoiceStatus(channelId);
  if (status === null || status === undefined || status === '') {
    return client.rest.delete(route);
  }
  return client.rest.put(route, { body: { status: String(status).slice(0, MAX_LEN) } });
}

async function setVoiceChannelStatus(client, channelId, status, { clearing = false } = {}) {
  if (!client || !client.rest || !channelId || disabled) return false;
  try {
    await restCall(client, channelId, status);
    consecutiveFailures = 0;
    return true;
  } catch (e) {
    const code = e && typeof e.status === 'number' ? e.status : 0;
    if (code === 404) return true; // nothing there to delete — already cleared
    if (clearing && code === 403) return false; // left the channel already; nothing we can do
    consecutiveFailures++;
    if (consecutiveFailures >= GIVE_UP_AFTER) {
      disabled = true;
      console.warn(
        '[vcstatus] voice channel status updates disabled — the bot is probably missing the ' +
          '"Set Voice Channel Status" permission. Re-invite it with the invite link in docs/SETUP.md to turn this back on.'
      );
    } else if (consecutiveFailures === 1) {
      console.warn('[vcstatus] update failed:', e && e.message ? e.message : e);
    }
    return false;
  }
}

function queueVoiceChannel(queue) {
  if (!queue) return null;
  const ch = queue.channel;
  if (ch && ch.id) return ch;
  const guildId = queue.guild && queue.guild.id ? String(queue.guild.id) : null;
  const cachedId = guildId && lastChannelByGuild.get(guildId);
  if (cachedId && sharedClient && sharedClient.channels) {
    const cached = sharedClient.channels.cache.get(cachedId);
    if (cached && cached.id) return cached;
  }
  return null;
}

async function setForQueue(queue, status, opts) {
  const ch = queueVoiceChannel(queue);
  if (!ch) return false;
  const client = sharedClient || (ch.client ?? null);
  if (!client) return false;
  const guildId = queue.guild && queue.guild.id ? String(queue.guild.id) : null;
  if (guildId) {
    if (status) lastChannelByGuild.set(guildId, ch.id);
    else lastChannelByGuild.delete(guildId);
  }
  return setVoiceChannelStatus(client, ch.id, status, opts);
}

/** Show the current song as the voice channel status. */
function setNowPlaying(queue, track) {
  const text = trackText(track);
  if (!text) return Promise.resolve(false);
  return setForQueue(queue, text);
}

/** Standby texts ("autoplay hunting", "24/7 waiting"). kind: 'autoplay' | 'twenty4seven' */
function setStandby(queue, kind) {
  const text = STANDBY[kind] || null;
  return setForQueue(queue, text, { clearing: !text });
}

/** Clear the voice channel status (bot left / queue deleted). */
function clear(queue) {
  return setForQueue(queue, null, { clearing: true });
}

/** Used by tests to reset the failure state. */
function reset() {
  consecutiveFailures = 0;
  disabled = false;
  lastChannelByGuild.clear();
}

module.exports = { init, setNowPlaying, setStandby, clear, setVoiceChannelStatus, trackText, reset, STANDBY };
