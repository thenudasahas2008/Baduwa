const { 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    MessageFlags,
    ComponentType 
} = require('discord.js');
const { getSupportServerInvite, getOwnerUsername } = require('../utils/supportGate');
const { generateInviteUrl } = require('../utils/inviteUrl');
const { safeReply, RESPONSE_STATES } = require('../utils/interactionHelpers');
const logger = require('../utils/logger');

// Categories definition
const CATEGORIES = {
    overview: {
        id: 'overview',
        label: 'Overview & Getting Started',
        emoji: '🏠',
        description: 'Introduction, quick-start guide, and core concepts.',
    },
    playback: {
        id: 'playback',
        label: 'Playback Controls',
        emoji: '🎵',
        description: 'Play, search, pause, resume, skip, back, previous, join, stop, and leave voice.',
        commands: ['play', 'search', 'pause', 'resume', 'skip', 'back', 'previous', 'join', 'stop', 'leave', 'disconnect'],
    },
    queue: {
        id: 'queue',
        label: 'Queue Management',
        emoji: '📜',
        description: 'View, shuffle, clear, jump, remove, deduplicate, loop, and audio effects.',
        commands: ['queue', 'shuffle', 'clear', 'clearqueue', 'jump', 'remove', 'removedupes', 'move', 'loop', 'volume', 'filter', 'bassboost', 'speed', 'pitch'],
    },
    automation: {
        id: 'automation',
        label: 'Automation & Voice',
        emoji: '⚡',
        description: 'Autoplay recommendations, 24/7 voice presence, and song grabbing.',
        commands: ['autoplay', '247', 'grab'],
    },
    info: {
        id: 'info',
        label: 'Information & Utility',
        emoji: 'ℹ️',
        description: 'Bot statistics, lyrics, invite links, support, node telemetry, and help.',
        commands: ['help', 'about', 'support', 'invite', 'nowplaying', 'lyrics', 'music-info', 'music-logs', 'nodes'],
    },
};

// Rich, accurate metadata for all real commands
const COMMAND_METADATA = {
    play: {
        syntax: '/play query: <title | artist | URL> [next: True/False]',
        desc: 'Searches and queues a song or playlist from YouTube, Spotify, or direct audio link with smart relevance ranking.',
        example: '/play query: The Weeknd Blinding Lights',
        sideEffects: 'Automatically connects to voice and creates a persistent Now Playing controller.',
    },
    search: {
        syntax: '/search query: <text>',
        desc: 'Searches music with automatic provider fallback (YouTube Music -> YouTube) and presents interactive selectable results.',
        example: '/search query: Ed Sheeran Shape of You Acoustic',
        sideEffects: 'Opens an interactive dropdown menu to pick the exact track before playing.',
    },
    pause: {
        syntax: '/pause',
        desc: 'Toggles playback between paused and resumed states without losing progress.',
        example: '/pause',
        sideEffects: 'Freezes track progress until resumed.',
    },
    skip: {
        syntax: '/skip',
        desc: 'Skips the currently playing track and starts the next song in the queue.',
        example: '/skip',
        sideEffects: 'If the queue is empty and Autoplay is active, automatically discovers and queues a related track.',
    },
    back: {
        syntax: '/back',
        desc: 'Replays the previous track from the queue history.',
        example: '/back',
        sideEffects: 'Places the currently playing track back at the front of the queue.',
    },
    stop: {
        syntax: '/stop',
        desc: 'Immediately halts playback and clears the queue while staying connected in the voice channel.',
        example: '/stop',
        sideEffects: 'Preserves 24/7 mode and keeps the voice connection alive. Updates Now Playing panel to idle state.',
    },
    leave: {
        syntax: '/leave',
        desc: 'Stops playback, clears the queue, disables 24/7 mode, and disconnects Baduwa from voice.',
        example: '/leave',
        sideEffects: 'Destroys the voice session and deletes the active player message.',
    },
    queue: {
        syntax: '/queue',
        desc: 'Displays upcoming songs with track numbers, durations, requesters, total queue time, and jump menu.',
        example: '/queue',
        sideEffects: 'Includes pagination buttons and a select menu to jump directly to any queued song.',
    },
    shuffle: {
        syntax: '/shuffle',
        desc: 'Randomizes the order of all upcoming songs in the queue.',
        example: '/shuffle',
        sideEffects: 'Blocked when Autoplay is actively generating dynamic queues.',
    },
    clear: {
        syntax: '/clear',
        desc: 'Removes all upcoming tracks from the queue while keeping the current song playing.',
        example: '/clear',
        sideEffects: 'Upcoming queue becomes empty; current track is untouched.',
    },
    loop: {
        syntax: '/loop',
        desc: 'Cycles loop modes: Track Loop 🔂 -> Queue Loop 🔁 -> Off ➡️.',
        example: '/loop',
        sideEffects: 'Controls whether a single song or the entire queue repeats.',
    },
    volume: {
        syntax: '/volume level: <1-100>',
        desc: 'Adjusts the audio volume percentage for music playback.',
        example: '/volume level: 85',
        sideEffects: 'Instantly scales output volume across the server.',
    },
    filter: {
        syntax: '/filter',
        desc: 'Opens an interactive menu to toggle audio effects (Bass Boost, Nightcore, Vaporwave, 8D, etc.).',
        example: '/filter',
        sideEffects: 'Applies real-time DSP equalizers through Lavalink.',
    },
    autoplay: {
        syntax: '/autoplay',
        desc: 'Toggles automatic discovery and queueing of related music when the queue runs out.',
        example: '/autoplay',
        sideEffects: 'Operates independently of 24/7 mode. Automatically generates fresh music continuously.',
    },
    247: {
        syntax: '/247',
        desc: 'Toggles 24/7 persistent voice presence so Baduwa remains in your voice channel permanently.',
        example: '/247',
        sideEffects: 'Prevents idle timeouts and empty-channel disconnects. Persists across bot restarts.',
    },
    nowplaying: {
        syntax: '/nowplaying',
        desc: 'Displays the currently playing track with elapsed time, progress bar, artwork, and status badges.',
        example: '/nowplaying',
        sideEffects: 'Sends an ephemeral status panel on demand.',
    },
    lyrics: {
        syntax: '/lyrics',
        desc: 'Fetches clean, synchronized lyrics for the currently playing track via LRCLIB.',
        example: '/lyrics',
        sideEffects: 'Detects and flags instrumental tracks if lyrics are not available.',
    },
    about: {
        syntax: '/about',
        desc: 'Displays bot technical specifications, uptime, latency, developer details, and platform version.',
        example: '/about',
        sideEffects: 'Provides general health and developer information.',
    },
    invite: {
        syntax: '/invite',
        desc: 'Generates an official Discord authorization link with required permissions to add Baduwa to other servers.',
        example: '/invite',
        sideEffects: 'Displays invite link with pre-configured bot permissions.',
    },
    support: {
        syntax: '/support',
        desc: 'Displays the official support server invite, lead developer info (zyrox_01xi), and server activation status.',
        example: '/support',
        sideEffects: 'Allows checking whether the server owner has activated music playback for this guild.',
    },
    help: {
        syntax: '/help [category]',
        desc: 'Opens the interactive Baduwa Help Center with command breakdowns, guides, and troubleshooting.',
        example: '/help category: playback',
        sideEffects: 'Provides interactive dropdown navigation.',
    },
    'music-info': {
        syntax: '/music-info',
        desc: 'Displays a concise overview of the current song playback health and streaming status.',
        example: '/music-info',
        sideEffects: 'Read-only check of song playback progression, audio node latency, and queue status.',
    },
    'music-logs': {
        syntax: '/music-logs [public: True/False]',
        desc: 'Inspects detailed live music playback health, Lavalink telemetry, and audio diagnostics (Authorized only).',
        example: '/music-logs public: False',
        sideEffects: 'Read-only diagnostic inspection of player progression, node stats, voice gateway, and root cause analysis.',
    },
};

/**
 * Builds the Overview Embed
 */
function buildOverviewEmbed(client) {
    const totalCommands = client.commands?.size || Object.keys(COMMAND_METADATA).length;

    return new EmbedBuilder()
        .setColor(0x7C3AED) // Signature Electric Violet
        .setAuthor({ name: 'Baduwa • Help Center & Command Guide', iconURL: client.user.displayAvatarURL() })
        .setTitle('⚡ Welcome to Baduwa Music')
        .setDescription(
            `**Baduwa** is a premium, high-fidelity Discord music bot engineered for crystal-clear audio, intelligent queue discovery, and seamless interactive controls.\n\n` +
            `Use the **select menu below** to browse all **${totalCommands} registered slash commands** organized by category.`
        )
        .addFields([
            {
                name: '🚀 Quick-Start Guide',
                value: 
                    '1️⃣ **Join Voice**: Connect to any voice channel in this server.\n' +
                    '2️⃣ **Play a Song**: Type `/play query: <song name or link>`.\n' +
                    '3️⃣ **Use Controller**: Manage playback using the buttons on the persistent player panel!',
                inline: false,
            },
            {
                name: '⚖️ Key Distinctions to Know',
                value:
                    '• **/stop vs /leave**:\n' +
                    '  - `/stop`: Stops audio & clears queue, but **remains in voice** and preserves 24/7 mode.\n' +
                    '  - `/leave`: Stops audio, clears queue, turns off 24/7, and **disconnects from voice**.\n\n' +
                    '• **/247 vs /autoplay**:\n' +
                    '  - `/247`: Manages **voice presence** (keeps bot connected indefinitely).\n' +
                    '  - `/autoplay`: Manages **music discovery** (auto-queues related songs when queue finishes).',
                inline: false,
            },
            {
                name: '🛠️ Common Troubleshooting',
                value:
                    '• **Bot not joining?** Ensure Baduwa has `Connect` and `Speak` channel permissions.\n' +
                    '• **No search results?** Try adding the artist name or paste a direct YouTube/Spotify URL.\n' +
                    '• **Activation required?** The Discord server owner must join our official support server (`/support`).',
                inline: false,
            },
            {
                name: '📂 Command Categories',
                value:
                    '🎵 **Playback** — `/play`, `/search`, `/pause`, `/skip`, `/back`, `/stop`, `/leave`\n' +
                    '📜 **Queue Management** — `/queue`, `/shuffle`, `/clear`, `/loop`, `/volume`, `/filter`\n' +
                    '⚡ **Automation & Voice** — `/autoplay`, `/247`\n' +
                    'ℹ️ **Information & Utility** — `/help`, `/about`, `/support`, `/invite`, `/nowplaying`, `/lyrics`',
                inline: false,
            },
        ])
        .setFooter({ text: 'Baduwa Music • Select a category below for full details' })
        .setTimestamp();
}

/**
 * Builds a specific Category Embed
 */
function buildCategoryEmbed(client, categoryKey) {
    const cat = CATEGORIES[categoryKey];
    if (!cat || categoryKey === 'overview') {
        return buildOverviewEmbed(client);
    }

    const commandNames = cat.commands || [];
    const fields = [];

    for (const cmdName of commandNames) {
        // Inspect real command registered in client
        const registeredCmd = client.commands?.get(cmdName);
        const meta = COMMAND_METADATA[cmdName] || {};

        const description = registeredCmd?.data?.description || meta.desc || 'No description provided.';
        const syntax = meta.syntax || `/${cmdName}`;
        const example = meta.example || `/${cmdName}`;
        const sideEffects = meta.sideEffects ? `\n*Note:* ${meta.sideEffects}` : '';

        fields.push({
            name: `\`${syntax}\``,
            value: `${description}\n**Example:** \`${example}\`${sideEffects}`,
            inline: false,
        });
    }

    return new EmbedBuilder()
        .setColor(0x7C3AED)
        .setAuthor({ name: `Baduwa • ${cat.label}`, iconURL: client.user.displayAvatarURL() })
        .setTitle(`${cat.emoji} ${cat.label}`)
        .setDescription(`${cat.description}\n\n**Available Commands in this Category:**`)
        .addFields(fields)
        .setFooter({ text: `Baduwa Music • Category: ${cat.label}` })
        .setTimestamp();
}

/**
 * Creates the interactive components for /help
 */
function buildHelpComponents(currentCategory = 'overview') {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('help:category_select')
        .setPlaceholder('📂 Choose a command category to view...')
        .addOptions([
            {
                label: CATEGORIES.overview.label,
                value: 'overview',
                emoji: CATEGORIES.overview.emoji,
                description: CATEGORIES.overview.description,
                default: currentCategory === 'overview',
            },
            {
                label: CATEGORIES.playback.label,
                value: 'playback',
                emoji: CATEGORIES.playback.emoji,
                description: CATEGORIES.playback.description,
                default: currentCategory === 'playback',
            },
            {
                label: CATEGORIES.queue.label,
                value: 'queue',
                emoji: CATEGORIES.queue.emoji,
                description: CATEGORIES.queue.description,
                default: currentCategory === 'queue',
            },
            {
                label: CATEGORIES.automation.label,
                value: 'automation',
                emoji: CATEGORIES.automation.emoji,
                description: CATEGORIES.automation.description,
                default: currentCategory === 'automation',
            },
            {
                label: CATEGORIES.info.label,
                value: 'info',
                emoji: CATEGORIES.info.emoji,
                description: CATEGORIES.info.description,
                default: currentCategory === 'info',
            },
        ]);

    const invite = getSupportServerInvite();
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(invite)
            .setEmoji('🛡️')
    );

    return [
        new ActionRowBuilder().addComponents(selectMenu),
        actionRow,
    ];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Opens the comprehensive Baduwa Music command guide and help center.')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Jump directly to a specific command category')
                .setRequired(false)
                .addChoices(
                    { name: '🏠 Overview & Getting Started', value: 'overview' },
                    { name: '🎵 Playback Controls', value: 'playback' },
                    { name: '📜 Queue Management', value: 'queue' },
                    { name: '⚡ Automation & Voice', value: 'automation' },
                    { name: 'ℹ️ Information & Utility', value: 'info' },
                )),
    async execute(interaction) {
        const { client, options } = interaction;
        const initialCategory = options.getString('category') || 'overview';

        logger.cmd(`/help category:${initialCategory} by ${interaction.user.tag} in #${interaction.channel?.name || 'DM'}`);

        const embed = buildCategoryEmbed(client, initialCategory);
        const components = buildHelpComponents(initialCategory);

        let reply = await safeReply(interaction, {
            embeds: [embed],
            components,
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        });

        if (interaction.deferred && !reply?.createMessageComponentCollector && typeof interaction.fetchReply === 'function') {
            reply = await interaction.fetchReply().catch(() => null);
        }

        if (!reply || typeof reply.createMessageComponentCollector !== 'function') {
            return;
        }

        // Set up component collector for smooth interactive navigation
        const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 5 * 60 * 1000, // 5 minutes
        });

        collector.on('collect', async (menuInteraction) => {
            if (menuInteraction.user.id !== interaction.user.id) {
                return menuInteraction.reply({
                    content: 'This help session belongs to someone else. Use `/help` to open your own.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const selectedCategory = menuInteraction.values[0];
            const updatedEmbed = buildCategoryEmbed(client, selectedCategory);
            const updatedComponents = buildHelpComponents(selectedCategory);

            await menuInteraction.update({
                embeds: [updatedEmbed],
                components: updatedComponents,
            });
        });

        collector.on('end', async () => {
            // Disable components after timeout
            try {
                const disabledComponents = buildHelpComponents(initialCategory).map(row => {
                    const rowBuilder = ActionRowBuilder.from(row);
                    rowBuilder.components.forEach(c => {
                        if (c.data.type !== ComponentType.Button || c.data.style !== ButtonStyle.Link) {
                            c.setDisabled(true);
                        }
                    });
                    return rowBuilder;
                });
                await interaction.editReply({ components: disabledComponents }).catch(() => {});
            } catch (err) {
                // Ignore expiration edit errors
            }
        });
    },
    // Export helper functions for testing
    CATEGORIES,
    COMMAND_METADATA,
    buildOverviewEmbed,
    buildCategoryEmbed,
    buildHelpComponents,
};
