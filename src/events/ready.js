const { Events } = require('discord.js');
const { generateInviteUrl } = require('../utils/inviteUrl');
const deployCommands = require('../utils/commandDeployer');
const logger = require('../utils/logger');

const { INTENDED_BOT_USERNAME } = require('../utils/branding');

/**
 * Synchronizes the Discord bot username with the authoritative identity constant ("ZYRO ♪").
 * Avoids redundant Discord API calls if the username already matches.
 * Handles rate limits (Discord allows only 2 username updates per hour) and errors gracefully without crashing.
 *
 * @param {object} client - Discord.js client instance
 * @returns {Promise<boolean>} True if username already matched or was successfully updated, false otherwise.
 */
async function syncBotUsername(client) {
    if (!client?.user) {
        return false;
    }

    const currentUsername = client.user.username;
    if (currentUsername === INTENDED_BOT_USERNAME) {
        logger.info(`Bot username matches intended identity "${INTENDED_BOT_USERNAME}". No update necessary.`);
        return true;
    }

    logger.info(`Current bot username is "${currentUsername}". Intended identity: "${INTENDED_BOT_USERNAME}".`);

    if (typeof client.user.setUsername !== 'function') {
        logger.warn('client.user.setUsername is not available; skipping username synchronization.');
        return false;
    }

    try {
        await client.user.setUsername(INTENDED_BOT_USERNAME);
        logger.info(`Bot username updated to ${INTENDED_BOT_USERNAME} successfully.`);
        return true;
    } catch (err) {
        logger.warn(`Failed to update bot username to "${INTENDED_BOT_USERNAME}" (${err?.message || err}). Discord API username changes are rate-limited to 2 per hour. The username can also be updated directly in the Discord Developer Portal.`);
        return false;
    }
}

module.exports = {
    name: Events.ClientReady,
    once: true,
    INTENDED_BOT_USERNAME,
    syncBotUsername,
    async execute(client) {
        let deployedCommit = 'unknown';
        try {
            const { execSync } = require('child_process');
            deployedCommit = execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 2000 }).trim();
        } catch (_) {}
        logger.info(`[STARTUP] Bot ready as ${client.user.tag} | commit=${deployedCommit} | startupTimestamp=${new Date().toISOString()}`);

        // Start activity rotation immediately upon ready so presence is visible right away
        if (client.activityManager) {
            client.activityManager.start();
        }

        // Sync server nickname to Baduwa in all guilds immediately so it displays as Baduwa right away
        try {
            client.guilds?.cache?.forEach?.(guild => {
                const me = guild.members?.me;
                if (me && me.nickname !== INTENDED_BOT_USERNAME) {
                    me.setNickname(INTENDED_BOT_USERNAME).catch(() => {});
                }
            });
        } catch (_) {}

        // Retry syncing global username every 10 minutes until Discord rate limit expires and Baduwa is set
        const usernameSyncInterval = setInterval(async () => {
            if (client.user?.username === INTENDED_BOT_USERNAME) {
                clearInterval(usernameSyncInterval);
                return;
            }
            const success = await syncBotUsername(client);
            if (success) {
                clearInterval(usernameSyncInterval);
            }
        }, 10 * 60 * 1000);
        if (typeof usernameSyncInterval?.unref === 'function') {
            usernameSyncInterval.unref();
        }

        // Deploy commands without blocking Lavalink initialization
        deployCommands(client).catch(err => {
            logger.error('Failed to deploy application commands:', err?.message || err);
        });

        if (client.lavalink) {
            try {
                await client.lavalink.init({ ...client.user });
                logger.info('Lavalink initialized');
            } catch (initError) {
                logger.warn('Initial Lavalink init encountered an error:', initError?.message || initError);
            }
        }

        // Allow a brief grace period (up to 3000ms) for the initial node WebSocket connection to settle
        if (client.lavalinkConnectionManager && !client.lavalinkConnectionManager.isAvailable()) {
            let waitMs = 0;
            while (!client.lavalinkConnectionManager.isAvailable() && waitMs < 3000) {
                await new Promise((r) => setTimeout(r, 200));
                waitMs += 200;
            }
        }

        // Proactively verify connection; trigger failover if node disconnected, or background discovery if deferred
        if (client.lavalinkConnectionManager && !client.lavalinkConnectionManager.isAvailable()) {
            if (client.lavalinkConnectionManager.isManagerReady()) {
                logger.info('Initial Lavalink node not connected after startup window; triggering connection manager failover...');
                client.lavalinkConnectionManager.attemptReconnection().catch((err) => {
                    logger.debug('Initial Lavalink reconnection failed on ready:', err?.message || err);
                });
            } else {
                logger.info('Lavalink initialization is deferred; background discovery is active.');
                client.lavalinkConnectionManager.attemptDiscoveryAndDeferredInit?.();
            }
        }

        // Proactively discover and restore 24/7 presence across restarts/updates from live Discord context
        if (client.guildSettings?.discoverAndRestoreFromDiscord) {
            await client.guildSettings.discoverAndRestoreFromDiscord(client).catch((err) => {
                logger.debug('Failed to discover 24/7 state from Discord on ready:', err?.message || err);
            });
        }

        // Reconnect 24/7 players across restarts if Lavalink is ready
        if (client.lavalinkConnectionManager?.recover247Connections) {
            client.lavalinkConnectionManager.recover247Connections().catch((err) => {
                logger.debug('Failed to recover 24/7 connections on ready:', err?.message || err);
            });
        } else if (client.guildSettings && client.lavalink) {
            for (const [guildId, settings] of client.guildSettings.cache.entries()) {
                if (settings.twentyFourSeven && settings.voiceChannelId) {
                    try {
                        const guild = client.guilds.cache.get(guildId);
                        if (!guild) continue;
                        const voiceChannel = guild.channels.cache.get(settings.voiceChannelId);
                        if (!voiceChannel) continue;

                        let player = client.lavalink.getPlayer(guildId);
                        if (!player) {
                            player = client.lavalink.createPlayer({
                                guildId,
                                voiceChannelId: voiceChannel.id,
                                textChannelId: settings.textChannelId || null,
                                selfDeaf: true,
                                selfMute: false,
                            });
                        }
                        const botMember = guild.members?.me
                            || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(client.user?.id).catch(() => null) : null);
                        const isVoiceConnected = Boolean(botMember?.voice?.channelId === voiceChannel.id);
                        if (!isVoiceConnected || !player.voice?.sessionId) {
                            player.connect().catch((error) => {
                                logger.debug(`Failed to connect 24/7 player in guild ${guildId}:`, error?.message || error);
                            });
                            logger.info(`Reconnected 24/7 player in guild ${guild.name} (#${voiceChannel.name})`);
                        }
                    } catch (error) {
                        logger.debug(`Failed to reconnect 24/7 for guild ${guildId}:`, error?.message || error);
                    }
                }
            }
        }

        // Start continuous 24/7 voice channel watchdog (monitors every 20s and auto-rejoins if disconnected)
        const twentyFourSevenManager = require('../utils/twentyFourSevenManager');
        twentyFourSevenManager.startWatchdog(client, 20000);

        const inviteUrl = generateInviteUrl(client.user.id);
        logger.info(`Invite URL: ${inviteUrl}`);

        // Verify and synchronize bot username identity
        await syncBotUsername(client);

        // Safely migrate existing welcome messages to ZYRO branding
        try {
            const { migrateAllWelcomeMessages } = require('../utils/welcomeManager');
            migrateAllWelcomeMessages(client).catch((err) => {
                logger.debug('Welcome message migration encountered an error:', err?.message || err);
            });
        } catch (migErr) {
            logger.debug('Failed to initiate welcome message migration:', migErr?.message || migErr);
        }

        // Reconcile stored dashboards with live player state to eliminate ghost Now Playing panels
        if (client.playerController?.reconcileAllDashboards) {
            client.playerController.reconcileAllDashboards().catch((err) => {
                logger.debug('Error reconciling dashboards on ready:', err?.message || err);
            });
        }

        // Clean up any stale voice channel statuses left over from prior sessions
        if (client.voiceChannelStatusManager?.cleanupStaleStatusesOnStartup) {
            client.voiceChannelStatusManager.cleanupStaleStatusesOnStartup().catch((err) => {
                logger.debug('Error cleaning up stale voice statuses on ready:', err?.message || err);
            });
        }

        // Reset performance histogram to eliminate synchronous module-load startup skew (~3.28s)
        try {
            const { performanceMonitor } = require('../utils/performanceMonitor');
            if (typeof performanceMonitor?.resetHistogram === 'function') {
                performanceMonitor.resetHistogram();
            }
        } catch (_) {}
    },
};
