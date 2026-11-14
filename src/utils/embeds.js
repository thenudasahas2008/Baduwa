const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createTrackSelectMenu } = require('./trackSelectMenu');

/**
 * Formats duration from milliseconds to readable format
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration string (e.g., "3:45" or "1:23:45")
 */
function formatDuration(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return '0:00';
    if (ms <= 0) return '0:00';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
}

/**
 * Creates the search results embed with pagination
 *
 * @param {Object} client - Discord client instance
 * @param {Object} pageData - Page data from search session
 * @param {string} query - Original search query
 * @returns {EmbedBuilder} Configured embed builder for search results
 */
function createSearchEmbed(client, pageData, query) {
    const { tracks, currentPage, totalPages, totalTracks } = pageData;

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setAuthor({ name: 'ZYRO • SEARCH RESULTS', iconURL: client.user.displayAvatarURL() })
        .setDescription(`Search results for **"${query}"**\n*Select a song from the dropdown menu below to add it to the queue.*`)
        .setFooter({
            text: `Page ${currentPage}/${totalPages} • ${totalTracks} results • ZYRO Music`
        })
        .setTimestamp();

    if (tracks[0]?.info?.artworkUrl) {
        embed.setThumbnail(tracks[0].info.artworkUrl);
    }

    tracks.forEach((track, index) => {
        const globalIndex = pageData.startIndex + index;
        const duration = formatDuration(track.info?.duration || 0);
        const title = track.info?.title || 'Unknown Title';
        const uri = track.info?.uri;
        const link = uri ? `[${title}](${uri})` : title;
        const artist = track.info?.author || 'Unknown Artist';

        embed.addFields({
            name: `${globalIndex + 1}. ${title}`,
            value: `by **${artist}** • \`⏱️ ${duration}\``,
            inline: false
        });
    });

    return embed;
}

/**
 * Creates components for search results with dropdown and navigation
 *
 * @param {Object} client - Discord client instance
 * @param {Object} pageData - Page data from search session
 * @param {string} sessionId - Unique search session identifier
 * @returns {Array} Array of ActionRowBuilder components
 */
function createSearchComponents(client, pageData, sessionId) {
    const { hasNext, hasPrevious, tracks, startIndex } = pageData;

    const components = [];

    // Row 1: Track selection dropdown
    const selectMenu = createTrackSelectMenu(tracks, {
        customId: `search:select:${sessionId}`,
        placeholder: 'Select a track to play...',
        startIndex: startIndex,
    });
    components.push(new ActionRowBuilder().addComponents(selectMenu));

    // Row 2: Navigation + Cancel
    const navRow = new ActionRowBuilder();

    if (hasPrevious) {
        navRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`search:prev:${sessionId}`)
                .setLabel('Previous')
                .setEmoji('◀️')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    if (hasNext) {
        navRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`search:next:${sessionId}`)
                .setLabel('Next')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`search:cancel:${sessionId}`)
            .setLabel('Cancel')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
    );

    components.push(navRow);

    return components;
}

module.exports = {
    formatDuration,
    createSearchEmbed,
    createSearchComponents,
};
