// ZYRO-style now-playing control panel: embed + interactive buttons.
// Keeps ONE persistent message per guild, edits in place on track changes,
// button clicks, and progress bar ticks (every 5 seconds while playing).
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  QueueRepeatMode,
} = require('discord.js');
const store = require('./store');

/** guildId -> { messageId, channelId, createdAt } */
const panelState = new Map();

/** guildId -> setInterval handle */
const progressIntervals = new Map();

const PROGRESS_BAR_SIZE = 12; // Continuous smooth line with marker

function fmtDuration(ms) {
  if (!ms || ms < 0 || !Number.isFinite(ms)) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function clampVolume(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(150, Math.round(n)));
}

/**
 * Creates a smooth, continuous progress bar using box-drawing line '─' and blue circle '🔵'
 * Example: "──🔵─────────"
 */
function createProgressBar(currentMS, totalMS, size = PROGRESS_BAR_SIZE) {
  const current = Math.max(0, Number(currentMS) || 0);
  const total = Math.max(0, Number(totalMS) || 0);

  const numBars = Math.max(2, size);
  if (!total || total <= 0) {
    return '🔵' + '─'.repeat(numBars);
  }

  const ratio = Math.max(0, Math.min(1, current / total));
  const pos = Math.round(ratio * numBars);
  const bar = '─'.repeat(pos) + '🔵' + '─'.repeat(Math.max(0, numBars - pos));
  return bar;
}

function getLoopModeLabel(mode) {
  if (mode === 1 || mode === 'Track') return 'Track';
  if (mode === 2 || mode === 'Queue') return 'Queue';
  return 'Off';
}

function getNextLoopMode(currentMode) {
  // Cycle: Off (0/3) -> Track (1) -> Queue (2) -> Off (0)
  if (currentMode === 0 || currentMode === 3 || currentMode === 'Off') return 1;
  if (currentMode === 1 || currentMode === 'Track') return 2;
  return 0;
}

/**
 * Build 4 action rows matching the ZYRO dashboard layout:
 * Row 1: Pause/Resume (Primary), Skip (Secondary), Shuffle (Secondary)
 * Row 2: Stop (Danger)
 * Row 3: Previous (Secondary), Autoplay (Success when on / Secondary when off), Queue (Secondary)
 * Row 4: Loop (Secondary), Vol+ (Secondary), Vol- (Secondary)
 */
function buildPanelButtons(options = {}) {
  const {
    isPaused = false,
    autoplay = false,
    loopMode = 0,
    disabled = false,
  } = options;

  const loopLabel = getLoopModeLabel(loopMode);

  // Row 1: Pause/Resume, Skip, Shuffle
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_pause')
      .setLabel(isPaused ? 'Resume' : 'Pause')
      .setEmoji(isPaused ? '▶' : '⏸')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_skip')
      .setLabel('Skip')
      .setEmoji('⏭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  // Row 2: Stop
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_stop')
      .setLabel('Stop')
      .setEmoji('⏹')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );

  // Row 3: Previous, Autoplay, Queue
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_previous')
      .setLabel('Previous')
      .setEmoji('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_autoplay')
      .setLabel('Autoplay')
      .setEmoji('📻')
      .setStyle(autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(false), // Autoplay can be toggled even in standby
    new ButtonBuilder()
      .setCustomId('panel_queue')
      .setLabel('Queue')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  // Row 4: Loop, Vol+, Vol-
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_loop')
      .setLabel(`Loop: ${loopLabel}`)
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_volup')
      .setLabel('Vol+')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_voldown')
      .setLabel('Vol-')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  return [row1, row2, row3, row4];
}

function buildPanel(queue, currentTrack = null) {
  const track = currentTrack || (queue && queue.currentTrack);
  const guildId = queue?.guild?.id;
  const flags = guildId ? store.flags(guildId) : { autoplay: false, twenty4seven: false };
  const botUser = queue?.client?.user || { username: 'Baduwa' };
  const botAvatar = typeof botUser.displayAvatarURL === 'function' ? botUser.displayAvatarURL() : null;
  const volume = queue?.node?.volume !== undefined ? queue.node.volume : 100;
  const queueSize = queue?.tracks?.size ?? queue?.size ?? 0;
  const is247 = Boolean(flags.twenty4seven);
  const isAutoplay = Boolean(flags.autoplay || queue?.repeatMode === 3);
  const isPaused = queue?.node?.isPaused ? queue.node.isPaused() : false;
  const repeatMode = queue?.repeatMode ?? 0;
  const loopLabel = getLoopModeLabel(repeatMode);

  if (!track) {
    // Standby embed (sleek ZYRO purple theme)
    const embed = new EmbedBuilder()
      .setColor(0x7b2cbf)
      .setAuthor({
        name: `🎵 ${botUser.username.toUpperCase()} • STANDBY`,
        iconURL: botAvatar,
      })
      .setTitle('💤 Standby Mode')
      .setDescription(
        'Queue finished! Use `/play` to drop a song — or click **Autoplay** below to keep music flowing automatically.\n\n' +
        `🔊 \`${volume}%\` • 📜 \`0\` in queue • Loop: \`Off\` • 👤📻 Autoplay Radio`
      )
      .setFooter({
        text: `${botUser.username} Music • 24/7 Mode ${is247 ? 'Active' : 'Inactive'}`,
      })
      .setTimestamp();

    const components = buildPanelButtons({
      isPaused: false,
      autoplay: isAutoplay,
      loopMode: repeatMode,
      disabled: true,
    });

    return { embeds: [embed], components };
  }

  // Active playing embed matching ZYRO card
  const timestamp = queue?.node?.getTimestamp ? queue.node.getTimestamp() : null;
  const currentMS = timestamp?.current?.value ?? queue?.node?.streamTime ?? 0;
  const totalMS = track.durationMS || timestamp?.total?.value || 0;
  const progressBar = createProgressBar(currentMS, totalMS, PROGRESS_BAR_SIZE);
  const currentStr = fmtDuration(currentMS);
  const totalStr = totalMS > 0 ? fmtDuration(totalMS) : 'live';

  const titleText = track.title || 'Unknown track';
  const authorText = track.author || 'Unknown artist';
  const url = track.url || null;
  const statusIcon = isPaused ? '⏸' : '▶';

  const embed = new EmbedBuilder()
    .setColor(0x7b2cbf) // Vibrant ZYRO purple
    .setAuthor({
      name: `🎵 ${botUser.username.toUpperCase()} • NOW PLAYING`,
      iconURL: botAvatar,
    })
    .setTitle(titleText)
    .setDescription(
      `by **${authorText}**\n\n` +
      `${statusIcon} ${progressBar} \`${currentStr} / ${totalStr}\`\n\n` +
      `🔊 \`${volume}%\` • 📜 \`${queueSize}\` in queue • Loop: \`${loopLabel}\` • 👤📻 Autoplay Radio`
    );

  if (url) embed.setURL(url);
  // Small thumbnail in upper-right corner (matching ZYRO)
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  embed
    .setFooter({
      text: `${botUser.username} Music • 24/7 Mode ${is247 ? 'Active' : 'Inactive'}`,
    })
    .setTimestamp();

  const components = buildPanelButtons({
    isPaused,
    autoplay: isAutoplay,
    loopMode: repeatMode,
    disabled: false,
  });

  return { embeds: [embed], components };
}

function setPanelMessage(guildId, messageId, channelId) {
  panelState.set(guildId, {
    messageId,
    channelId,
    createdAt: Date.now(),
  });
}

async function updatePanel(queue, currentTrack = null) {
  if (!queue || !queue.guild) return null;
  const guildId = queue.guild.id;
  const channel = queue.metadata && queue.metadata.channel;
  if (!channel || typeof channel.send !== 'function') return null;

  const payload = buildPanel(queue, currentTrack);
  const state = panelState.get(guildId);

  // If we have an existing panel message, edit it in place
  if (state && state.messageId) {
    try {
      const targetChannel =
        state.channelId === channel.id
          ? channel
          : (queue.guild.channels.cache.get(state.channelId) || channel);
      const msg = await targetChannel.messages.fetch(state.messageId).catch(() => null);
      if (msg) {
        await msg.edit(payload);
        return msg;
      }
    } catch {
      /* fall back to sending new message */
    }
  }

  // Send a fresh panel message if none exists or fetch failed
  try {
    const sent = await channel.send(payload);
    if (sent) {
      setPanelMessage(guildId, sent.id, channel.id);
      return sent;
    }
  } catch (e) {
    console.error(`[panel] failed to send panel to ${channel.name}:`, e.message);
  }
  return null;
}

function startProgressInterval(queue) {
  if (!queue || !queue.guild) return;
  const guildId = queue.guild.id;
  stopProgressInterval(guildId);

  const timer = setInterval(async () => {
    try {
      if (!queue.isPlaying() || queue.node.isPaused()) return;
      await updatePanel(queue);
    } catch {
      /* best effort */
    }
  }, 5000);

  progressIntervals.set(guildId, timer);
}

function stopProgressInterval(guildId) {
  const timer = progressIntervals.get(guildId);
  if (timer) {
    clearInterval(timer);
    progressIntervals.delete(guildId);
  }
}

function clearPanel(guildId) {
  stopProgressInterval(guildId);
  panelState.delete(guildId);
}

async function handleButtonInteraction(interaction, context) {
  const { player, music } = context;
  const guildId = interaction.guildId;
  const queue = player.nodes.get(guildId);

  // Check voice channel match if bot is currently in a VC
  const member = interaction.member;
  const botVoiceId = interaction.guild.members.me?.voice?.channelId;
  if (botVoiceId && member?.voice?.channelId !== botVoiceId) {
    return interaction.reply({
      content: '❌ You must join the same voice channel as the bot to use the dashboard buttons.',
      ephemeral: true,
    });
  }

  const id = interaction.customId;

  if (id === 'panel_queue') {
    if (!queue || (queue.isEmpty() && !queue.currentTrack)) {
      return interaction.reply({ content: '📜 The queue is empty.', ephemeral: true });
    }
    const current = queue.currentTrack;
    const tracks = queue.tracks.toArray().slice(0, 10);
    let desc = `**Now Playing:**\n▶ [${current.title}](${current.url}) (${current.duration})\n\n`;
    if (tracks.length) {
      desc += `**Up Next (${queue.tracks.size} total):**\n`;
      desc += tracks
        .map((t, i) => `\`${i + 1}.\` [${t.title}](${t.url}) - ${t.author} (${t.duration})`)
        .join('\n');
      if (queue.tracks.size > 10) {
        desc += `\n...and ${queue.tracks.size - 10} more.`;
      }
    } else {
      desc += '_No tracks queued._';
    }
    const qEmbed = new EmbedBuilder()
      .setColor(0x7b2cbf)
      .setTitle(`🎶 Queue for ${interaction.guild.name}`)
      .setDescription(desc);
    return interaction.reply({ embeds: [qEmbed], ephemeral: true });
  }

  if (!queue) {
    return interaction.reply({ content: '❌ No active player found.', ephemeral: true });
  }

  await interaction.deferUpdate().catch(() => {});

  switch (id) {
    case 'panel_pause': {
      if (queue.node.isPaused()) {
        queue.node.resume();
        startProgressInterval(queue);
      } else {
        queue.node.pause();
        stopProgressInterval(guildId);
      }
      break;
    }
    case 'panel_skip': {
      queue.node.skip();
      setTimeout(() => updatePanel(queue).catch(() => {}), 350);
      break;
    }
    case 'panel_previous': {
      const hist = queue.history;
      if (hist && hist.size > 0) {
        await hist.back().catch(() => {});
        setTimeout(() => updatePanel(queue).catch(() => {}), 350);
      } else {
        await interaction.followUp({ content: '⏮ No previous track in history.', ephemeral: true }).catch(() => {});
      }
      break;
    }
    case 'panel_stop': {
      stopProgressInterval(guildId);
      queue.node.stop();
      break;
    }
    case 'panel_shuffle': {
      if (queue.tracks.size > 1) {
        queue.tracks.shuffle();
      }
      break;
    }
    case 'panel_autoplay': {
      const current = store.flags(guildId).autoplay;
      const nextState = !current;
      store.setFlag(guildId, 'autoplay', nextState);
      if (music && music.applyFlagsToQueue) music.applyFlagsToQueue(queue);
      if (nextState && music && music.kickAutoplay) {
        await music.kickAutoplay(queue);
      }
      break;
    }
    case 'panel_loop': {
      const currentMode = queue.repeatMode;
      const nextMode = getNextLoopMode(currentMode);
      queue.setRepeatMode(nextMode);
      break;
    }
    case 'panel_volup': {
      const cur = queue.node.volume;
      const next = clampVolume(cur + 10);
      queue.node.setVolume(next);
      break;
    }
    case 'panel_voldown': {
      const cur = queue.node.volume;
      const next = clampVolume(cur - 10);
      queue.node.setVolume(next);
      break;
    }
  }

  await updatePanel(queue).catch(() => {});
}

module.exports = {
  buildPanel,
  updatePanel,
  setPanelMessage,
  startProgressInterval,
  stopProgressInterval,
  clearPanel,
  handleButtonInteraction,
  createProgressBar,
  buildPanelButtons,
  getLoopModeLabel,
  getNextLoopMode,
  clampVolume,
  fmtDuration,
  panelState,
  progressIntervals,
};
