const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const logger = require('./logger');

const SUPPORT_SERVER_INVITE = process.env.SUPPORT_SERVER_INVITE || 'https://discord.gg/RH6W8AcQc';
const OWNER_USERNAME = 'zyrox_01xi';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Commands that are always accessible even when music is gated
const EXEMPT_COMMANDS = new Set(['help', 'about', 'support', 'invite']);

// In-memory cache for guild owner membership status
// Map<ownerId, { isMember: boolean, timestamp: number }>
const membershipCache = new Map();
// In-flight cache for concurrent checks
const inFlightMembershipChecks = new Map();

function getSupportServerInvite() {
    return process.env.SUPPORT_SERVER_INVITE || SUPPORT_SERVER_INVITE;
}

function getSupportGuildId() {
    return process.env.SUPPORT_GUILD_ID || null;
}

function getOwnerDiscordId() {
    return process.env.OWNER_DISCORD_ID || null;
}

function getOwnerUsername() {
    return OWNER_USERNAME;
}

function isExemptCommand(commandName) {
    if (!commandName) return false;
    return EXEMPT_COMMANDS.has(commandName.toLowerCase());
}

function invalidateOwner(ownerId) {
    if (ownerId) {
        membershipCache.delete(ownerId);
        inFlightMembershipChecks.delete(ownerId);
    }
}

function clearCache() {
    membershipCache.clear();
    inFlightMembershipChecks.clear();
}

/**
 * Checks whether a guild owner is a member of the official support server.
 *
 * @param {import('discord.js').Client} client - Discord client
 * @param {string} ownerId - Discord user ID of the guild owner
 * @returns {Promise<{ isMember: boolean, active: boolean, reason?: string }>}
 */
async function checkOwnerMembership(client, ownerId) {
    const supportGuildId = getSupportGuildId();

    // If gate is explicitly disabled in environment or not configured, it is inactive (fail-open)
    if (process.env.ENABLE_SUPPORT_GATE === 'false' || process.env.SUPPORT_GATE_ENABLED === 'false' || !supportGuildId) {
        return { isMember: true, active: false, reason: 'GATE_NOT_CONFIGURED' };
    }

    if (!ownerId) {
        return { isMember: true, active: false, reason: 'NO_OWNER_ID' };
    }

    // Bot owner exemption
    const botOwnerId = getOwnerDiscordId();
    if (botOwnerId && ownerId === botOwnerId) {
        return { isMember: true, active: true, reason: 'BOT_OWNER_EXEMPT' };
    }

    // Check TTL cache
    const now = Date.now();
    const cached = membershipCache.get(ownerId);
    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
        return { isMember: cached.isMember, active: true, reason: 'CACHED' };
    }

    // Return existing in-flight check if already pending for this owner
    if (inFlightMembershipChecks.has(ownerId)) {
        return inFlightMembershipChecks.get(ownerId);
    }

    const checkPromise = (async () => {
        try {
            // Find support guild in client cache or fetch it
            let supportGuild = client.guilds?.cache?.get?.(supportGuildId);
            if (!supportGuild && client.guilds?.fetch) {
                try {
                    supportGuild = await Promise.race([
                        client.guilds.fetch(supportGuildId),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Support guild fetch timeout')), 800))
                    ]).catch(() => null);
                } catch (fetchError) {
                    logger.warn('Error fetching support guild:', fetchError.message);
                }
            }

            // If bot is not in support server or cannot access it, fail-open to avoid locking users out
            if (!supportGuild) {
                logger.warn('Support guild is not accessible to the bot. Bypassing gate check.');
                return { isMember: true, active: false, reason: 'SUPPORT_GUILD_UNAVAILABLE' };
            }

            // Check Discord.js member cache first (0ms instantaneous lookup)
            if (supportGuild.members?.cache?.has?.(ownerId)) {
                membershipCache.set(ownerId, { isMember: true, timestamp: Date.now() });
                return { isMember: true, active: true, reason: 'VERIFIED_MEMBER' };
            }

            // Verify member existence with an 800ms timeout guard so interaction SLAs are preserved
            try {
                if (typeof supportGuild.members?.fetch === 'function') {
                    const fetchPromise = supportGuild.members.fetch(ownerId);
                    fetchPromise.catch(() => null); // Prevent unhandledRejection if timeoutPromise wins the race
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => {
                            const err = new Error('Support guild member fetch timed out');
                            err.name = 'TimeoutError';
                            reject(err);
                        }, 800)
                    );
                    const member = await Promise.race([fetchPromise, timeoutPromise]);
                    if (member) {
                        membershipCache.set(ownerId, { isMember: true, timestamp: Date.now() });
                        return { isMember: true, active: true, reason: 'VERIFIED_MEMBER' };
                    }
                }
            } catch (error) {
                // Discord API 10007: Unknown Member -> User is definitively NOT in the support server
                if (error.code === 10007 || error.status === 404) {
                    membershipCache.set(ownerId, { isMember: false, timestamp: Date.now() });
                    return { isMember: false, active: true, reason: 'NOT_IN_SUPPORT_GUILD' };
                }

                // On network/API errors or timeouts, do not penalize users
                logger.warn('Could not verify support server membership due to API error:', error.message);
                return { isMember: true, active: false, reason: 'API_ERROR_FAILSAFE' };
            }

            membershipCache.set(ownerId, { isMember: false, timestamp: Date.now() });
            return { isMember: false, active: true, reason: 'NOT_IN_SUPPORT_GUILD' };
        } finally {
            inFlightMembershipChecks.delete(ownerId);
        }
    })();

    inFlightMembershipChecks.set(ownerId, checkPromise);
    return checkPromise;
}

/**
 * Creates the branded ZYRO server activation embed
 */
function createGateEmbed(guild) {
    const invite = getSupportServerInvite();
    const ownerMention = guild?.ownerId ? `<@${guild.ownerId}>` : 'Server Owner';

    return new EmbedBuilder()
        .setColor(0x7C3AED) // Electric Violet
        .setAuthor({ name: 'ZYRO • Server Activation Required' })
        .setTitle('⚡ Official Support Server Membership Required')
        .setDescription(
            `To enable music playback in **${guild?.name || 'this server'}**, the **Server Owner** (${ownerMention}) must be a member of the official **ZYRO Support Server**.\n\n` +
            `**Why is activation required?**\n` +
            `• Receive critical audio node updates, announcements, and uptime notices.\n` +
            `• Get priority direct audio assistance from developer **${OWNER_USERNAME}**.\n` +
            `• Help prevent unmanaged bot abuse and maintain premium audio quality.\n\n` +
            `*Once the server owner joins the support server, all music commands unlock immediately!*`
        )
        .addFields([
            {
                name: '👑 Required Member',
                value: ownerMention,
                inline: true,
            },
            {
                name: '🛡️ Official Community',
                value: `[discord.gg/RH6W8AcQc](${invite})`,
                inline: true,
            },
            {
                name: '💡 Always Accessible',
                value: '`/help`, `/about`, `/support`, and `/invite` remain unlocked.',
                inline: false,
            },
        ])
        .setFooter({ text: 'ZYRO Music • Server Activation Policy' })
        .setTimestamp();
}

/**
 * Creates the buttons for the activation gate
 */
function createGateComponents(ownerId) {
    const invite = getSupportServerInvite();
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Join Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(invite)
            .setEmoji('🛡️'),
        new ButtonBuilder()
            .setCustomId(`support:verify:${ownerId || 'unknown'}`)
            .setLabel('Verify Activation')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔄')
    );
}

/**
 * Checks interaction against the support server gate
 *
 * @param {import('discord.js').CommandInteraction} interaction
 * @returns {Promise<{ allowed: boolean }>}
 */
async function enforceSupportGate(interaction) {
    try {
        // Non-guild interactions or exempt commands bypass gate
        if (!interaction.guild || isExemptCommand(interaction.commandName)) {
            return { allowed: true };
        }

        const { client, guild } = interaction;
        const { isMember } = await checkOwnerMembership(client, guild.ownerId);

        if (isMember) {
            return { allowed: true };
        }

        // Owner is not in support server — block execution and display branded invitation
        const embed = createGateEmbed(guild);
        const row = createGateComponents(guild.ownerId);

        const replyPayload = {
            embeds: [embed],
            components: [row],
            flags: MessageFlags.Ephemeral,
        };

        const { safeReply } = require('./interactionHelpers');
        await safeReply(interaction, replyPayload);

        return { allowed: false };
    } catch (err) {
        logger.warn('Error in enforceSupportGate (failing open):', err?.message || err);
        return { allowed: true };
    }
}

module.exports = {
    SUPPORT_SERVER_INVITE,
    OWNER_USERNAME,
    getSupportServerInvite,
    getSupportGuildId,
    getOwnerDiscordId,
    getOwnerUsername,
    isExemptCommand,
    checkOwnerMembership,
    createGateEmbed,
    createGateComponents,
    enforceSupportGate,
    invalidateOwner,
    clearCache,
    inFlightMembershipChecks,
};
