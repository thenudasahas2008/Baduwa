// Per-guild persistent flags (24/7 mode, autoplay, last channels) stored in data/guilds.json
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const FILE = path.join(config.dataDir, 'guilds.json');

let cache = {};
let saveTimer = null;

function load() {
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
      console.error('[store] failed to save guilds.json:', e.message);
    }
  }, 300);
}

load();

function flags(guildId) {
  guildId = String(guildId);
  if (!cache[guildId]) {
    cache[guildId] = { twenty4seven: false, autoplay: false, lastVoiceChannelId: null, lastTextChannelId: null };
  }
  return cache[guildId];
}

function setFlag(guildId, key, value) {
  const f = flags(guildId);
  f[key] = value;
  saveSoon();
  return f;
}

function touchChannels(guildId, { voiceChannelId, textChannelId }) {
  const f = flags(guildId);
  if (voiceChannelId != null) f.lastVoiceChannelId = String(voiceChannelId);
  if (textChannelId != null) f.lastTextChannelId = String(textChannelId);
  saveSoon();
}

function allGuildIdsWithFlag(key) {
  return Object.entries(cache)
    .filter(([, f]) => f && f[key])
    .map(([id]) => id);
}

module.exports = { flags, setFlag, touchChannels, allGuildIdsWithFlag, _file: FILE };
