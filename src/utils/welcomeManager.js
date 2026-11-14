const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const { getSupportServerInvite } = require('./supportGate');
const logger = require('./logger');

const { INTENDED_BOT_USERNAME, ZYRO_PURPLE, GITHUB_PROFILE_URL } = require('./branding');

/**
 * Builds the official ZYRO welcome embed with exact required title, description, and footer.
 * @param {object} client - Discord Client instance
 * @returns {EmbedBuilder}
 */
function buildWelcomeEmbed(client) {
    const embed = new EmbedBuilder()
        .setColor(ZYRO_PURPLE)
        .setTitle('Thanks for adding ZYRO!')
        .setDescription('ZYRO is ready to play music! Use /play to get started, or /about to learn more.')
        .setFooter({ text: 'ZYRO Music' });

    if (client?.user?.displayAvatarURL) {
        embed.setThumbnail(client.user.displayAvatarURL());
    }

    return embed;
}

/**
 * Builds the standard ZYRO welcome components with the verified GitHub profile link button.
 * @returns {ActionRowBuilder[]}
 */
function buildWelcomeComponents() {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('GitHub')
            .setStyle(ButtonStyle.Link)
            .setURL(GITHUB_PROFILE_URL)
    );

    try {
        const invite = getSupportServerInvite?.();
        if (invite) {
            row.addComponents(
                new ButtonBuilder()
                    .setLabel('Join Support Server')
                    .setStyle(ButtonStyle.Link)
                    .setURL(invite)
                    .setEmoji('🛡️')
            );
        }
    } catch (_) {}

    return [row];
}

/**
 * Safely updates components for an existing message being migrated in place.
 * Preserves other link buttons while ensuring the GitHub button displays "GitHub"
 * and opens the user's GitHub profile.
 * @param {ActionRowBuilder[]|object[]} existingComponents
 * @returns {ActionRowBuilder[]}
 */
function updateWelcomeComponents(existingComponents) {
    if (!Array.isArray(existingComponents) || existingComponents.length === 0) {
        return buildWelcomeComponents();
    }

    let foundGithub = false;
    const newRows = [];

    for (const row of existingComponents) {
        const componentsList = row.components || [];
        if (!componentsList.length) continue;

        const newRow = new ActionRowBuilder();
        for (const comp of componentsList) {
            const raw = comp.data || comp;
            const label = String(raw.label || '');
            const url = String(raw.url || '');
            const isGithub = label.toLowerCase().includes('github') || url.toLowerCase().includes('github.com');

            if (isGithub) {
                foundGithub = true;
                newRow.addComponents(
                    new ButtonBuilder()
                        .setLabel('GitHub')
                        .setStyle(ButtonStyle.Link)
                        .setURL(GITHUB_PROFILE_URL)
                );
            } else if (raw.style === ButtonStyle.Link || raw.style === 5) {
                // Preserve other link buttons
                const btn = new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setURL(raw.url)
                    .setLabel(raw.label || 'Link');
                if (raw.emoji) btn.setEmoji(raw.emoji);
                newRow.addComponents(btn);
            }
        }

        if (newRow.components.length > 0) {
            newRows.push(newRow);
        }
    }

    if (!foundGithub) {
        if (newRows.length > 0 && newRows[0].components.length < 5) {
            newRows[0].addComponents(
                new ButtonBuilder()
                    .setLabel('GitHub')
                    .setStyle(ButtonStyle.Link)
                    .setURL(GITHUB_PROFILE_URL)
            );
        } else {
            newRows.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('GitHub')
                    .setStyle(ButtonStyle.Link)
                    .setURL(GITHUB_PROFILE_URL)
            ));
        }
    }

    return newRows;
}

/**
 * Finds candidate channels in a guild where a welcome message may reside.
 * @param {object} guild
 * @returns {object[]}
 */
function getCandidateWelcomeChannels(guild) {
    const channels = [];
    const me = guild.members?.me;
    const requiredPerms = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.SendMessages
    ];

    const canAccess = (ch) => {
        if (!ch || ch.type !== ChannelType.GuildText) return false;
        if (!me) return true; // In mock environments
        return ch.permissionsFor(me)?.has(requiredPerms);
    };

    // 1. Stored welcome channel from guildSettings if present
    const storedChannelId = guild.client?.guildSettings?.get?.(guild.id)?.welcomeChannelId;
    if (storedChannelId) {
        const storedCh = guild.channels?.cache?.get(storedChannelId);
        if (storedCh && canAccess(storedCh)) channels.push(storedCh);
    }

    // 2. Guild systemChannel
    if (guild.systemChannel && canAccess(guild.systemChannel) && !channels.includes(guild.systemChannel)) {
        channels.push(guild.systemChannel);
    }

    // 3. Channels named 'general', 'welcome', 'main', 'chat'
    const nameMatches = ['general', 'welcome', 'main', 'chat', 'lounge'];
    const matchingChannels = guild.channels?.cache?.filter
        ? Array.from(guild.channels.cache.values()).filter(ch => canAccess(ch) && nameMatches.includes(ch.name?.toLowerCase()))
        : [];

    for (const ch of matchingChannels) {
        if (!channels.includes(ch)) channels.push(ch);
    }

    // 4. Any other readable text channels (sorted by position)
    if (guild.channels?.cache) {
        const allAccessible = (guild.channels.cache.filter
            ? Array.from(guild.channels.cache.filter(canAccess).values())
            : Array.from(guild.channels.cache.values()).filter(canAccess))
            .sort((a, b) => (a.position || 0) - (b.position || 0));

        for (const ch of allAccessible) {
            if (!channels.includes(ch)) channels.push(ch);
        }
    }

    return channels;
}

/**
 * Checks if a message is an old BeatDock welcome message authored by this bot.
 * @param {object} message
 * @param {string} botId
 * @returns {boolean}
 */
function isOldBeatDockWelcomeMessage(message, botId) {
    if (!message || (botId && message.author?.id !== botId)) return false;
    const embeds = message.embeds || [];
    if (!embeds.length) return false;

    for (const embed of embeds) {
        const raw = embed.data || embed;
        const title = raw.title || '';
        const description = raw.description || '';
        const footer = raw.footer?.text || '';

        if (title.includes('Thanks for adding BeatDock!') ||
            title.toLowerCase().includes('beatdock') ||
            description.includes('BeatDock is ready to play music') ||
            footer.includes('BeatDock')) {
            return true;
        }
    }

    return false;
}

/**
 * Checks if a message is an already-updated ZYRO welcome message authored by this bot.
 * @param {object} message
 * @param {string} botId
 * @returns {boolean}
 */
function isExistingZyroWelcomeMessage(message, botId) {
    if (!message || (botId && message.author?.id !== botId)) return false;
    const embeds = message.embeds || [];
    if (!embeds.length) return false;

    for (const embed of embeds) {
        const raw = embed.data || embed;
        const title = raw.title || '';
        if (title.includes('Thanks for adding ZYRO!')) {
            return true;
        }
    }

    return false;
}

/**
 * Safely migrates an existing welcome message for a single guild in place.
 * @param {object} guild
 * @param {object} options
 * @returns {Promise<object>}
 */
async function migrateGuildWelcomeMessage(guild, options = {}) {
    const { client } = guild;
    const guildSettings = client?.guildSettings;
    const botId = client?.user?.id;

    if (!options.force && guildSettings?.isWelcomeMigrated?.(guild.id)) {
        return { success: true, skipped: true, reason: 'already_migrated' };
    }

    const candidateChannels = getCandidateWelcomeChannels(guild);
    if (!candidateChannels.length) {
        logger.info(`Welcome message migration: No accessible channels found for guild ${guild.name} (${guild.id})`);
        guildSettings?.setWelcomeMigrated?.(guild.id);
        return { success: false, reason: 'no_accessible_channels' };
    }

    const storedMessageId = guildSettings?.get?.(guild.id)?.welcomeMessageId;

    for (const channel of candidateChannels) {
        try {
            // 1. If stored message ID exists, try to fetch directly
            if (storedMessageId) {
                const directMsg = await channel.messages.fetch(storedMessageId).catch(() => null);
                if (directMsg && directMsg.author?.id === botId) {
                    const newEmbed = buildWelcomeEmbed(client);
                    const newComponents = updateWelcomeComponents(directMsg.components);
                    await directMsg.edit({ embeds: [newEmbed], components: newComponents });

                    guildSettings?.setWelcomeMigrated?.(guild.id, {
                        messageId: directMsg.id,
                        channelId: channel.id
                    });

                    logger.info(`Successfully migrated existing welcome message in ${guild.name} (#${channel.name}, message ID: ${directMsg.id})`);
                    return { success: true, migrated: true, messageId: directMsg.id, channelId: channel.id };
                }
            }

            // 2. Bounded recent history scan (max 50 messages)
            const recentMessages = await channel.messages.fetch({ limit: 50 }).catch((fetchErr) => {
                logger.debug(`Could not scan messages in #${channel.name}: ${fetchErr?.message || fetchErr}`);
                return null;
            });

            if (!recentMessages || !recentMessages.size) continue;

            const messagesList = Array.from(recentMessages.values ? recentMessages.values() : recentMessages);

            // Find matching old welcome message authored by bot
            const targetMessage = messagesList.find(m => isOldBeatDockWelcomeMessage(m, botId));

            if (targetMessage) {
                const newEmbed = buildWelcomeEmbed(client);
                const newComponents = updateWelcomeComponents(targetMessage.components);

                // Edit message in place preserving position
                await targetMessage.edit({ embeds: [newEmbed], components: newComponents });

                guildSettings?.setWelcomeMigrated?.(guild.id, {
                    messageId: targetMessage.id,
                    channelId: channel.id
                });

                logger.info(`Successfully migrated existing welcome message in ${guild.name} (#${channel.name}, message ID: ${targetMessage.id})`);
                return { success: true, migrated: true, messageId: targetMessage.id, channelId: channel.id };
            }

            // Check if already updated to ZYRO
            const alreadyUpdated = messagesList.find(m => isExistingZyroWelcomeMessage(m, botId));
            if (alreadyUpdated) {
                // Ensure GitHub button URL is up to date
                const updatedComponents = updateWelcomeComponents(alreadyUpdated.components);
                await alreadyUpdated.edit({ components: updatedComponents }).catch(() => {});

                guildSettings?.setWelcomeMigrated?.(guild.id, {
                    messageId: alreadyUpdated.id,
                    channelId: channel.id
                });

                logger.info(`Existing welcome message in ${guild.name} is already ZYRO branded (#${channel.name}, message ID: ${alreadyUpdated.id})`);
                return { success: true, migrated: false, alreadyUpdated: true, messageId: alreadyUpdated.id };
            }

        } catch (err) {
            logger.debug(`Error checking channel #${channel.name} during welcome migration: ${err?.message || err}`);
        }
    }

    // No matching message found in any candidate channel
    logger.info(`Welcome message migration: No existing BeatDock welcome embed found in ${guild.name}. Message may have been deleted or is outside recent history.`);
    guildSettings?.setWelcomeMigrated?.(guild.id);
    return { success: false, notFound: true };
}

/**
 * Runs the welcome message migration across all guilds on bot startup.
 * @param {object} client
 */
async function migrateAllWelcomeMessages(client) {
    if (!client?.guilds?.cache) return;

    logger.info('Checking for existing welcome messages to migrate to ZYRO...');
    const guilds = Array.from(client.guilds.cache.values());
    let migratedCount = 0;

    for (const guild of guilds) {
        try {
            const result = await migrateGuildWelcomeMessage(guild);
            if (result.migrated) {
                migratedCount++;
            }
        } catch (err) {
            logger.warn(`Failed welcome migration check for guild ${guild.name}: ${err?.message || err}`);
        }
    }

    if (migratedCount > 0) {
        logger.info(`Welcome message migration complete: ${migratedCount} message(s) updated in place.`);
    } else {
        logger.info('Welcome message migration complete: all guilds up to date.');
    }
}

module.exports = {
    INTENDED_BOT_USERNAME,
    GITHUB_PROFILE_URL,
    ZYRO_PURPLE,
    buildWelcomeEmbed,
    buildWelcomeComponents,
    updateWelcomeComponents,
    getCandidateWelcomeChannels,
    isOldBeatDockWelcomeMessage,
    isExistingZyroWelcomeMessage,
    migrateGuildWelcomeMessage,
    migrateAllWelcomeMessages,
};
