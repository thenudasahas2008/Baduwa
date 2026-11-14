// Bot bootstrap: client, player, extractors, event wiring, slash command deploy,
// 24/7 auto-rejoin on boot, connection watchdog, and audio stream safeguards.
const { Client, GatewayIntentBits, Events, ChannelType } = require('discord.js');
const { Player } = require('discord-player');
const { YoutubeExtractor } = require('discord-player-youtubei');
const config = require('../config');
const store = require('./store');
const events = require('./events');
const presence = require('./presence');
const vcStatus = require('./vcStatus');
const { createEngine, baseQueueOptions } = require('./music');
const { handleButtonInteraction } = require('./panel');
const commands = require('../commands');
const context = require('./context');

// --- Audio & Environment Setup ---------------------------------------------
try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic && !process.env.FFMPEG_PATH) {
    process.env.FFMPEG_PATH = ffmpegStatic;
  }
} catch {
  /* best effort */
}

if (!process.env.USER_AGENT) {
  process.env.USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
}

const WATCHDOG_INTERVAL = 5 * 60 * 1000;

function log(...args) {
  console.log('[bot]', ...args);
}

async function verifyVoiceEnvironment() {
  // Voice encryption
  try {
    const sodium = require('libsodium-wrappers');
    if (sodium && typeof sodium.ready === 'object') {
      await sodium.ready;
    }
  } catch {
    try {
      require('sodium-native');
    } catch {
      /* fallback */
    }
  }

  // Opus encoder verification
  try {
    const opus =
      require('@discord-player/opus') ||
      require('@discordjs/opus') ||
      require('opusscript');
    if (opus) log('voice encoder ready');
  } catch (e) {
    console.warn('[bot] voice encoder notice:', e.message);
  }
}

async function initPoToken() {
  try {
    const { BotGuardSimplified } = require('simple-ytdl-core');
    const { getInnertube } = require('discord-player-youtubei');
    const tube = await getInnertube({
      cookie: config.youtubeCookie || null,
    });
    const bg = await BotGuardSimplified.create(tube);
    const token = await bg.createBindingToken('dQw4w9WgXcQ');
    await bg.shutdown().catch(() => {});
    if (token) {
      log('YouTube PoToken ready & cached:', `${token.slice(0, 16)}...`);
      return token;
    }
  } catch (e) {
    log('YouTube PoToken notice (will stream via Innertube fallback):', e.message);
  }
  return null;
}

function checkDuplicateInstance(client) {
  for (const [, guild] of client.guilds.cache) {
    const me = guild.members.me;
    if (me && me.voice && me.voice.channelId) {
      console.warn(
        `\n================================================================================\n` +
          `[WARNING] DUPLICATE BOT INSTANCE DETECTED:\n` +
          `Bot is already connected to voice channel "${me.voice.channel?.name || me.voice.channelId}" ` +
          `in guild "${guild.name}"!\n` +
          `Another process is likely logged in with the same DISCORD_TOKEN.\n` +
          `A ghost instance will hold the voice socket and cause "song plays but no sound heard".\n` +
          `Please stop any other running bot instances.\n` +
          `================================================================================\n`
      );
    }
  }
}

async function syncSlashCommands(client) {
  try {
    const existing = await client.application.commands.fetch();
    const mine = [...commands.values()].map((c) => c.data);
    const namesLocal = mine.map((c) => c.name).sort();
    const namesRemote = [...existing.values()].map((c) => c.name).sort();
    const changed =
      JSON.stringify(namesLocal) !== JSON.stringify(namesRemote) ||
      existing.size !== mine.length;
    if (changed) {
      await client.application.commands.set(mine);
      log(`slash commands synced (${mine.length} commands)`);
    } else {
      log(`slash commands already up to date (${mine.length})`);
    }
  } catch (e) {
    console.error('[bot] command sync failed:', e.message);
  }
}

async function rejoin247(client, player, onlyIfDisconnected = true) {
  const guildIds = store.allGuildIdsWithFlag('twenty4seven');
  for (const guildId of guildIds) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const vcId = store.flags(guildId).lastVoiceChannelId;
      if (!vcId) continue;
      const channel = guild.channels.cache.get(vcId);
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;

      let queue = player.nodes.get(guildId);
      if (queue && queue.connection && onlyIfDisconnected) continue;

      log(`[24/7] rejoining ${guild.name} -> ${channel.name}`);
      queue = queue || player.nodes.create(guild, baseQueueOptions(guildId, null));
      if (!queue.connection || !queue.channel) {
        await queue.connect(channel).catch((e) =>
          log(`[24/7] connect failed for ${guild.name}:`, e.message)
        );
      }
      // show a standby line under the channel name until a song starts
      if (queue.channel && !queue.isPlaying()) vcStatus.setStandby(queue, 'twenty4seven');
    } catch (e) {
      console.error('[24/7] rejoin error for guild', guildId, e.message);
    }
  }
}

async function init() {
  if (!config.token) throw new Error('DISCORD_TOKEN is missing — put it in .env (see .env.example)');
  if (!config.clientId) throw new Error('CLIENT_ID is missing — put it in .env (see .env.example)');

  await verifyVoiceEnvironment();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
  });

  const player = new Player(client, {
    lagMonitor: 15_000,
    connectionTimeout: 30_000,
  });

  // Log any FFmpeg stderr errors for visibility
  player.events.on('debug', (queue, message) => {
    if (typeof message === 'string' && /error|invalid/i.test(message)) {
      console.warn(`[ffmpeg/debug][guild: ${queue?.guild?.name || queue?.id}]`, message);
    }
  });

  // ---- extractors ---------------------------------------------------------
  // Only load the extractors used (Spotify + SoundCloud) to conserve container memory
  const defaults = await player.extractors.loadDefault(
    (ext) => ext === 'SpotifyExtractor' || ext === 'SoundCloudExtractor',
    {
      SpotifyExtractor: {},
    }
  );
  if (!defaults.success) console.error('[bot] default extractors failed to load:', defaults.error);

  const ytOptions = {};
  if (config.youtubeCookie) ytOptions.cookie = config.youtubeCookie;

  await player.extractors.register(YoutubeExtractor, ytOptions);
  log('extractors ready:', player.extractors.size);

  // ---- wiring -------------------------------------------------------------
  events.attach(player);
  const music = createEngine(player);
  context.setContext({ client, player, music, store, config, commands });
  vcStatus.init(client);

  client.once(Events.ClientReady, async (c) => {
    log(`logged in as ${c.user.tag}`);
    checkDuplicateInstance(c);
    presence.start(c, player); // rotating statuses
    await syncSlashCommands(c);
    await rejoin247(c, player, false);
    setInterval(() => rejoin247(c, player, true).catch(() => {}), WATCHDOG_INTERVAL).unref();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const cmd = commands.get(interaction.commandName);
        if (!cmd) return;
        await cmd.execute(interaction, context.getContext());
      } else if (interaction.isAutocomplete()) {
        const cmd = commands.get(interaction.commandName);
        if (cmd && typeof cmd.autocomplete === 'function') {
          await cmd.autocomplete(interaction, context.getContext());
        }
      } else if (interaction.isButton()) {
        if (interaction.customId.startsWith('panel_')) {
          await handleButtonInteraction(interaction, context.getContext());
        }
      }
    } catch (e) {
      console.error('[interaction]', e);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong — try again.', ephemeral: true });
        } else if (interaction.isRepliable() && interaction.deferred) {
          await interaction.editReply({ content: 'Something went wrong — try again.' });
        }
      } catch {
        /* noop */
      }
    }
  });

  client.on(Events.Error, (e) => console.error('[discord]', e));
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

  await client.login(config.token);

  return { client, player, music };
}

module.exports = { init, rejoin247 };
