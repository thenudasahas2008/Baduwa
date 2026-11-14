const { EmbedBuilder } = require('discord.js');
const { formatDuration } = require('./embeds');
const { truncateText } = require('./trackSelectMenu');
const { getPlaybackPosition } = require('./seekManager');

const COLORS = {
    PRIMARY: 0x7C3AED, // Electric Violet (ZYRO signature)
    CYAN: 0x06B6D4,    // Cyan accent
    SECONDARY: 0x06B6D4,// Cyan accent alias
    SUCCESS: 0x10B981, // Emerald green
    WARNING: 0xF59E0B, // Warm amber
    DANGER: 0xEF4444,  // Crimson red
    ERROR: 0xEF4444,   // Crimson red alias
    NEUTRAL: 0x27272A, // Dark graphite
};

const ICONS = {
    ZYRO: '⚡',
    PLAYING: '▶️',
    PAUSED: '⏸️',
    STOPPED: '⏹️',
    QUEUE: '📜',
    UP_NEXT: '⏭️',
    AUTOPLAY: '📻',
    MODE_247: '🕒',
    LOOP_OFF: '➡️',
    LOOP_TRACK: '🔂',
    LOOP_QUEUE: '🔁',
    VOLUME: '🔊',
    SUCCESS: '✅',
    ERROR: '❌',
    SEARCH: '🔍',
    USER: '👤',
    MUSIC: '🎵',
};

/**
 * Creates a clean, tasteful Unicode progress bar
 * Example: "▶ 🔘────────── 1:23 / 3:45"
 */
function createProgressBar(currentMs = 0, totalMs = 0, barLength = 12, isStream = false, isPaused = false) {
    if (isStream || !totalMs || totalMs <= 0) {
        return '🔴 LIVE STREAM';
    }

    const clampedCurrent = Math.max(0, Math.min(currentMs, totalMs));
    const percent = totalMs > 0 ? clampedCurrent / totalMs : 0;
    const progressIndex = Math.min(barLength - 1, Math.floor(percent * barLength));

    let bar = '';
    for (let i = 0; i < barLength; i++) {
        if (i === progressIndex) {
            bar += '🔘';
        } else {
            bar += '─';
        }
    }

    const icon = isPaused ? '⏸' : '▶';
    return `${icon} ${bar} \`${formatDuration(clampedCurrent)} / ${formatDuration(totalMs)}\``;
}

/**
 * Creates a cohesive ZYRO action confirmation embed
 * Supports both createActionEmbed(type, title, description, fields) and createActionEmbed({ title, description, ... })
 */
function createActionEmbed(typeOrOptions, maybeTitle, maybeDescription, maybeFields) {
    let title = '';
    let description = '';
    let fields = [];
    let color = COLORS.PRIMARY;
    let thumbnail = null;
    let footer = 'ZYRO Music';
    let timestamp = true;

    if (typeof typeOrOptions === 'string') {
        const type = typeOrOptions.toLowerCase();
        title = maybeTitle || '';
        description = maybeDescription || '';
        fields = maybeFields || [];

        switch (type) {
            case 'success':
                color = COLORS.PRIMARY;
                title = `✨ ${title}`;
                break;
            case 'info':
                color = COLORS.SECONDARY;
                title = `ℹ️ ${title}`;
                break;
            case 'warning':
                color = COLORS.WARNING;
                title = `⚠️ ${title}`;
                break;
            case 'error':
                color = COLORS.ERROR;
                title = `❌ ${title}`;
                break;
            default:
                color = COLORS.PRIMARY;
        }
    } else if (typeOrOptions && typeof typeOrOptions === 'object') {
        title = typeOrOptions.title || '';
        description = typeOrOptions.description || '';
        fields = typeOrOptions.fields || [];
        color = typeOrOptions.color || COLORS.PRIMARY;
        thumbnail = typeOrOptions.thumbnail || null;
        footer = typeOrOptions.footer || 'ZYRO Music';
        timestamp = typeOrOptions.timestamp !== false;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(truncateText(title, 256));

    if (description) {
        embed.setDescription(truncateText(description, 4096));
    }

    if (thumbnail) {
        embed.setThumbnail(thumbnail);
    }

    if (fields.length > 0) {
        embed.addFields(fields.slice(0, 25));
    }

    if (footer) {
        embed.setFooter({ text: truncateText(footer, 2048) });
    }

    if (timestamp) {
        embed.setTimestamp();
    }

    return embed;
}

/**
 * Builds the ZYRO Signature Now Playing panel
 */
function createNowPlayingEmbed(player, track, client) {
    if (track && !track.info && !client) {
        // Called with (player, options) in tests
        const opts = track;
        client = {
            is247Enabled: () => !!opts.is247,
            autoplayEnabled: new Map([[player.guildId, !!opts.autoplay]]),
            user: { displayAvatarURL: () => null }
        };
        track = player.queue?.current;
    } else if (!track) {
        track = player?.queue?.current;
    }

    if (!track || (player && player.stopped && !player.paused)) {
        return createStoppedEmbed(player, client || {});
    }

    const title = truncateText(track.info?.title || 'Unknown Title', 120);
    const uri = typeof track.info?.uri === 'string' && track.info.uri.length <= 2048
        ? track.info.uri
        : null;
    const trackLink = uri ? `[${title}](${uri})` : title;
    const artist = truncateText(track.info?.author || 'Unknown Artist', 80);

    const is247 = client?.is247Enabled ? client.is247Enabled(player?.guildId) : false;
    const isAutoplay = client?.autoplayEnabled ? client.autoplayEnabled.get(player?.guildId) : false;

    // Requester text
    const requester = track.userData?.autoplay
        ? `${ICONS.AUTOPLAY} Autoplay Radio`
        : track.userData?.requester
            ? (track.userData.requester.username || `<@${track.userData.requester.id || ''}>`)
            : track.requester
                ? (track.requester.username || (track.requester.id ? `<@${track.requester.id}>` : String(track.requester)))
                : null;

    // Compact meta info row: volume, queue count, loop, and requester
    const loopLabel = player?.repeatMode === 'track'
        ? '🔂 Track'
        : player?.repeatMode === 'queue'
            ? '🔁 Queue'
            : 'Off';

    const upcomingTracks = player?.queue?.tracks || [];
    // Filter out accidental stale references identical to current track, or automated duplicates
    const eligibleUpcoming = upcomingTracks.filter(t => {
        if (!t?.info) return false;
        if (t === track) return false;
        if (t.userData?.autoplay && t.info?.identifier && t.info.identifier === track.info?.identifier) return false;
        return true;
    });

    const queueCount = eligibleUpcoming.length;
    const isPaused = Boolean(player?.paused);
    const metaParts = [];
    if (isPaused) {
        metaParts.push('⏸️ `Paused`');
    }
    metaParts.push(
        `🔊 \`${player?.volume ?? 100}%\``,
        `📜 \`${queueCount}\` in queue`,
        `Loop: \`${loopLabel}\``
    );
    if (requester) {
        metaParts.push(`👤 ${requester}`);
    }
    const metaRow = metaParts.join(' • ');

    const isStream = Boolean(track.info?.isStream || !track.info?.duration || track.info?.duration <= 0);
    const position = getPlaybackPosition(player);
    const duration = Math.max(0, track.info?.duration || 0);

    // Check if monitor reports an active source or audio delivery issue
    let healthAlert = null;
    if (client?.audioPlaybackMonitor?.classifyHealth && player?.guildId) {
        const state = client.audioPlaybackMonitor.getOrCreateState?.(player.guildId);
        const guild = client.guilds?.cache?.get?.(player.guildId);
        if (state) {
            const health = client.audioPlaybackMonitor.classifyHealth(player, state, guild);
            if (health?.status === 'SOURCE_FAILURE') {
                healthAlert = `⚠️ **Audio Stream Unavailable:** ${health.detail || 'Source stream failed or requires login.'}`;
            } else if (health?.status === 'POSITION_STALLED') {
                healthAlert = `⚠️ **Audio Delivery Stalled:** ${health.detail || 'Playback position has stopped progressing.'}`;
            } else if (health?.status === 'VOICE_CONNECTION_PENDING') {
                healthAlert = `🔄 **Connecting to Voice:** ${health.detail || 'Establishing secure voice gateway connection...'}`;
            } else if (health?.status === 'VOICE_DISCONNECTED') {
                healthAlert = `🔌 **Voice Disconnected:** ${health.detail || 'Bot disconnected from voice channel.'}`;
            } else if (health?.status === 'RECOVERING') {
                healthAlert = `🔄 **Audio Recovery Active:** ${health.detail || 'Reconnecting audio stream...'}`;
            }
        }
    }

    const descParts = [
        `### ${trackLink}`,
        `by **${artist}**`
    ];
    if (healthAlert) {
        descParts.push('', healthAlert);
    }
    descParts.push(
        '',
        createProgressBar(position, duration, 14, isStream, isPaused),
        '',
        metaRow
    );

    const description = descParts.join('\n');

    // UP NEXT preview only when an eligible upcoming track actually exists
    const fields = [];
    const nextTrack = eligibleUpcoming[0];
    if (nextTrack) {
        const nextTitle = truncateText(nextTrack.info?.title || 'Unknown', 55);
        const nextArtist = truncateText(nextTrack.info?.author || 'Unknown', 30);
        const nextDuration = formatDuration(nextTrack.info?.duration || 0);
        const nextUri = nextTrack.info?.uri;
        const nextLink = nextUri ? `[${nextTitle}](${nextUri})` : nextTitle;
        fields.push({
            name: '⏭️ Up Next',
            value: `**${nextLink}**\n${nextArtist} • \`${nextDuration}\``,
            inline: false,
        });
    }

    const authorText = isPaused ? '⏸️ ZYRO • PAUSED' : '🎵 ZYRO • NOW PLAYING';
    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setAuthor({ name: authorText, iconURL: client?.user?.displayAvatarURL?.() || null })
        .setDescription(description)
        .setThumbnail(track.info?.artworkUrl || null);

    if (fields.length > 0) {
        embed.addFields(fields);
    }

    const footerText = is247
        ? 'ZYRO Music • 24/7 Mode Active'
        : (isAutoplay ? 'ZYRO Music • Autoplay Active' : 'ZYRO Music • High Fidelity Audio');

    embed.setFooter({ text: footerText });
    embed.setTimestamp();

    return embed;
}

/**
 * Builds the Stopped/Idle State panel
 */
function createStoppedEmbed(player, client, voiceChannelId) {
    const is247 = client?.is247Enabled ? client.is247Enabled(player?.guildId) : false;
    const channelId = voiceChannelId || player?.voiceChannelId || (player?.guildId && client?.guildSettings?.get(player.guildId)?.voiceChannelId);
    const channelMention = channelId ? `<#${channelId}>` : 'voice channel';

    return new EmbedBuilder()
        .setColor(COLORS.NEUTRAL)
        .setAuthor({ name: 'ZYRO • IDLE', iconURL: client?.user?.displayAvatarURL?.() || null })
        .setDescription(`Playback stopped and queue cleared.\nZYRO remains connected in ${channelMention}.\n\n*Use \`/play\` to start music or \`/leave\` to disconnect.*`)
        .setFooter({ text: is247 ? 'ZYRO Music • 24/7 Mode Active' : 'ZYRO Music • Ready for playback' })
        .setTimestamp();
}

/**
 * Builds the Lavalink Reconnecting / Unavailable State panel
 */
function createUnavailableEmbed(player, client) {
    const is247 = client?.is247Enabled ? client.is247Enabled(player?.guildId) : false;

    return new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setAuthor({ name: 'ZYRO • RECONNECTING', iconURL: client?.user?.displayAvatarURL?.() || null })
        .setDescription('Audio service is temporarily reconnecting to a node.\nPlayback will resume once a healthy connection is established.\n\n*Use `/help` for commands or `/leave` to disconnect.*')
        .setFooter({ text: is247 ? 'ZYRO Music • 24/7 Mode Active' : 'ZYRO Music • Reconnecting' })
        .setTimestamp();
}

module.exports = {
    COLORS,
    ZYRO_COLORS: COLORS,
    ICONS,
    formatDuration,
    createProgressBar,
    createActionEmbed,
    createNowPlayingEmbed,
    createStoppedEmbed,
    createUnavailableEmbed,
};
