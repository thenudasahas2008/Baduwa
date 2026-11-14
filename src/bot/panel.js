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

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const PROGRESS_BAR_SIZE = 9; // 4 bars + marker + 4 bars = "▬▬▬▬●▬▬▬▬"

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

function createProgressBar(currentMS, totalMS, size = PROGRESS_BAR_SIZE) {
  const current = Math.max(0, Number(currentMS) || 0);
  const total = Math.max(0, Number(totalMS) || 0);
  const totalStr = total > 0 ? fmtDuration(total) : 'live';
  const currentStr = fmtDuration(current);

  const numBars = Math.max(2, size - 1);
  if (!total || total <= 0) {
    return `🔘${'▬'.repeat(numBars)} ${currentStr} / ${totalStr}`;
  }

  const ratio = Math.max(0, Math.min(1, current / total));
  const pos = Math.round(ratio * numBars);
  const bar = '▬'.repeat(pos) + '●' + '▬'.repeat(numBars - pos);
  return `${bar} ${currentStr} / ${totalStr}`;
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

function buildPanelButtons(options = {}) {
  const {
    isPaused = false,
    autoplay = false,
    loopMode = 0,
    disabled = false,
  } = options;

  const loopLabel = getLoopModeLabel(loopMode);

  // Row 1: Pause/Resume, Skip, Previous, Stop, Shuffle
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_pause')
      .setLabel(isPaused ? 'Resume' : 'Pause')
      .setEmoji(isPaused ? '▶️' : '⏸️')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_previous')
      .setLabel('Previous')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  // Row 2: Autoplay, Loop, Queue, Vol+, Vol-
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_autoplay')
      .setLabel('Autoplay')
      .setEmoji('🔮')
      .setStyle(autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(false), // Autoplay remains enabled even in standby
    new ButtonBuilder()
      .setCustomId('panel_loop')
      .setLabel(`Loop: ${loopLabel}`)
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('panel_queue')
      .setLabel('Queue')
      .setEmoji('📜')
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

  return [row1, row2];
}

function buildPanel(queue, currentTrack = null) {
  const track = currentTrack || (queue && queue.currentTrack);
  const guildId = queue?.guild?.id;
  const flags = guildId ? store.flags(guildId) : { autoplay: false, twenty4seven: false };
  const botUser = queue?.client?.user || { username: 'Baduwa' };
  const volume = queue?.node?.volume !== undefined ? queue.node.volume : 100;
  const queueSize = queue?.tracks?.size ?? queue?.size ?? 0;
  const is247 = Boolean(flags.twenty4seven);
  const isAutoplay = Boolean(flags.autoplay || queue?.repeatMode === 3);
  const isPaused = queue?.node?.isPaused ? queue.node.isPaused() : false;
  const repeatMode = queue?.repeatMode ?? 0;

  if (!track) {
    // Standby embed
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('💤 Standby Mode')
      .setDescription(
        'Queue finished! Use `/play` to drop a song — or turn on **Autoplay** to keep music flowing automatically.'
      )
      .addFields(
        { name: 'Volume', value: `${volume}%`, inline: true },
        { name: 'Queue', value: `${queueSize}`, inline: true },
        { name: 'Loop', value: getLoopModeLabel(repeatMode), inline: true },
        { name: 'Autoplay Radio', value: isAutoplay ? 'On' : 'Off', inline: true }
      )
      .setFooter({
        text: `${botUser.username} Music • 24/7 mode ${is247 ? 'active' : 'inactive'}`,
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

  // Active playing embed
  const timestamp = queue?.node?.getTimestamp ? queue.node.getTimestamp() : null;
  const currentMS = timestamp?.current?.value ?? queue?.node?.streamTime ?? 0;
  const totalMS = track.durationMS || timestamp?.total?.value || 0;
  const progressBar = createProgressBar(currentMS, totalMS, PROGRESS_BAR_SIZE);

  const titleText = track.title || 'Unknown track';
  const authorText = track.author || 'Unknown artist';
  const url = track.url || null;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`▶ Now playing: ${titleText}`)
    .setDescription(
      `by **${authorText}**${track.requestedBy ? ` • requested by <@${track.requestedBy.id}>` : ''}\n\n` +
      `\`${progressBar}\``
    );

  if (url) embed.setURL(url);
  if (track.thumbnail) embed.setImage(track.thumbnail);

  embed
    .addFields(
      { name: 'Volume', value: `${volume}%`, inline: true },
      { name: 'Queue', value: `${queueSize}`, inline: true },
      { name: 'Loop', value: getLoopModeLabel(repeatMode), inline: true },
      { name: 'Autoplay Radio', value: isAutoplay ? 'On' : 'Off', inline: true }
    )
    .setFooter({
      text: `${botUser.username} Music • 24/7 mode ${is247 ? 'active' : 'inactive'}`,
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

async function updatePanel(queue, currentTrack = null) {
  if (!queue || !queue.guild) return null;
  const guildId = queue.guild.id;
  const channel = queue.metadata && queue.metadata.channel;
  if (!channel || typeof channel.send !== 'function') return null;

  const payload = buildPanel(queue, currentTrack);
  const state = panelState.get(guildId);

  // If we have an existing message within 15 minutes, edit it
  if (state && state.messageId && Date.now() - state.createdAt < EDIT_WINDOW_MS) {
    try {
      const msg = await channel.messages.fetch(state.messageId).catch(() => null);
      if (msg) {
        await msg.edit(payload);
        return msg;
      }
    } catch {
      /* fall back to sending new message */
    }
  }

  // Send a fresh message if none exists, fetch failed, or 15-minute edit window expired
  try {
    const sent = await channel.send(payload);
    if (sent) {
      panelState.set(guildId, {
        messageId: sent.id,
        channelId: channel.id,
        createdAt: Date.now(),
      });
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

  // Check voice channel match
  const member = interaction.member;
  const botVoiceId = interaction.guild.members.me?.voice?.channelId;
  if (!botVoiceId || member?.voice?.channelId !== botVoiceId) {
    return interaction.reply({
      content: '❌ You must join the same voice channel as the bot to control playback.',
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
      .setColor(0x5865f2)
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
      break;
    }
    case 'panel_previous': {
      const hist = queue.history;
      if (hist && hist.size > 0) {
        await hist.back().catch(() => {});
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
      store.setFlag(guildId, 'autoplay', !current);
      if (music && music.applyFlagsToQueue) music.applyFlagsToQueue(queue);
      if (!current && music && music.kickAutoplay) {
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
