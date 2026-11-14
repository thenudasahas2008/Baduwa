// Configuration: reads .env once, exposes typed-ish config object
const path = require('node:path');
const fs = require('node:fs');

require('dotenv').config();

const projectRoot = path.join(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

module.exports = {
  root: projectRoot,
  dataDir,
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  spotify: {
    clientId: process.env.DP_SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.DP_SPOTIFY_CLIENT_SECRET || '',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
  youtubeCookie: process.env.YOUTUBE_COOKIE || '',
  intents: {
    guilds: true,
    voiceStates: true,
    guildMessages: true,
  },
  isProduction: process.env.NODE_ENV === 'production',
};
