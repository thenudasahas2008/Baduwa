require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const LanguageManager = require('./LanguageManager');
const PlayerController = require('./utils/PlayerController');
const LavalinkConnectionManager = require('./utils/LavalinkConnectionManager');
const PublicNodeProvider = require('./utils/PublicNodeProvider');
const { validateAndFormatNodeOption, toValidNodeArray, sanitizeError, attachNodeProtection } = require('./utils/lavalinkNodeOptions');
const searchSessions = require('./utils/searchSessions');
const { findAutoplayTracks, historyManager, handleAutoplay } = require('./utils/autoplay');
const {
    clearQueueEndTimeout,
    setQueueEndTimeout,
    clearAllQueueEndTimeouts,
    clearAllPlayerUpdates,
    clearGuildLifecycleTimers,
    schedulePlayerUpdate,
    isManualStopActive,
} = require('./utils/playerLifecycle');
const {
    recordFailure,
    recordSuccess,
    endedOnFailure,
    hasNotified,
    clearGuild: clearFailureState,
} = require('./utils/playbackFailureTracker');
const { verifyNodePlugins } = require('./utils/nodePluginCheck');
const loadCommands = require('./handlers/commandHandler');
const registerEvents = require('./handlers/eventHandler');
const twentyFourSevenManager = require('./utils/twentyFourSevenManager');
const guildSettings = require('./utils/guildSettings');
const { ActivityManager } = require('./utils/activityManager');
const VoiceChannelStatusManager = require('./utils/voiceChannelStatusManager');
const VoiceHandshakeSynchronizer = require('./utils/VoiceHandshakeSynchronizer');
const AudioPlaybackMonitor = require('./utils/audioPlaybackMonitor');
const PlaybackProgressManager = require('./utils/PlaybackProgressManager');
const { performanceMonitor } = require('./utils/performanceMonitor');
const logger = require('./utils/logger');

const AUTOPLAY_TIMEOUT_MS = 5000;
const TRACK_END_CLEANUP_DELAY_MS = 500;
const SHUTDOWN_TIMEOUT_MS = 5000;
const HEALTHCHECK_HEARTBEAT_PATH = process.env.HEALTHCHECK_HEARTBEAT_PATH || '/tmp/beatdock-alive';
const HEALTHCHECK_HEARTBEAT_INTERVAL_MS = 30000;

function isLocalLavalinkConfigured() {
    const host = process.env.LAVALINK_HOST;
    const port = process.env.LAVALINK_PORT;
    const password = process.env.LAVALINK_PASSWORD;
    return Boolean(host && host.trim() && port && port.trim() && password && password.trim());
}

async function getInitialNodes() {
    if (isLocalLavalinkConfigured()) {
        logger.info('Using local Lavalink server');
        const localNode = validateAndFormatNodeOption({
            host: process.env.LAVALINK_HOST,
            port: parseInt(process.env.LAVALINK_PORT, 10),
            authorization: process.env.LAVALINK_PASSWORD,
            id: 'main-node',
            secure: process.env.LAVALINK_SECURE === 'true',
            retryAmount: 3,
            retryDelay: 3000,
        }, 'main-node');

        if (localNode) {
            return {
                mode: 'local',
                nodes: [localNode],
                provider: null,
            };
        }
        logger.warn('Dedicated Lavalink configuration is invalid; falling back to public servers...');
    }

    logger.info('No local Lavalink configured, fetching public Lavalink servers...');
    const provider = new PublicNodeProvider();

    let success = false;
    try {
        success = await provider.fetchNodes({ maxRetries: 1, timeoutMs: 8000, retryDelayMs: 1000 });
    } catch (err) {
        logger.debug(`Initial public node fetch caught: ${err?.message || err}`);
    }

    if (success && provider.hasNodes()) {
        provider.startAutoRefresh();
        let rawFirstNode = null;
        if (typeof provider.getNextValidatedNode === 'function') {
            rawFirstNode = await provider.getNextValidatedNode({ maxCandidates: 5, probeTimeoutMs: 3000 });
        }
        if (!rawFirstNode) {
            rawFirstNode = provider.getNextNode();
        }
        const firstNode = validateAndFormatNodeOption(rawFirstNode, 'main-node');

        if (firstNode) {
            logger.warn('Using public Lavalink servers — search queries and track requests are sent to third-party servers');
            logger.info(`Selected public node: ${firstNode.secure ? 'wss' : 'ws'}://${firstNode.host}:${firstNode.port}`);

            return {
                mode: 'public',
                nodes: [firstNode],
                provider,
            };
        }
    }

    // Public nodes are temporarily unavailable; do not crash Discord bot startup!
    logger.warn('Public Lavalink discovery was unavailable during startup. Deferring Lavalink connection — Discord bot will start normally and connect music when discovery succeeds in the background.');
    return {
        mode: 'public',
        nodes: [],
        provider,
    };
}

function createAutoplayAdapter(guildSettingsManager) {
    return {
        get(guildId) {
            if (!guildId) return false;
            return guildSettingsManager.isAutoplay(guildId);
        },
        set(guildId, enabled) {
            if (!guildId) return this;
            guildSettingsManager.setAutoplay(guildId, Boolean(enabled));
            return this;
        },
        has(guildId) {
            if (!guildId) return false;
            const settings = guildSettingsManager.get(guildId);
            return typeof settings.autoplay === 'boolean';
        },
        delete(guildId) {
            if (!guildId) return false;
            const settings = guildSettingsManager.get(guildId);
            if (settings && typeof settings.autoplay !== 'undefined') {
                const updated = { ...settings };
                delete updated.autoplay;
                guildSettingsManager.cache.set(guildId, updated);
                guildSettingsManager.save();
                return true;
            }
            return false;
        },
        clear() {
            for (const [guildId, settings] of guildSettingsManager.cache.entries()) {
                if (typeof settings.autoplay !== 'undefined') {
                    delete settings.autoplay;
                }
            }
            guildSettingsManager.save();
        }
    };
}

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    try {
        dns.setDefaultResultOrder('ipv4first');
    } catch (_) {}
}

const { Agent: UndiciAgent } = require('undici');

function createClient() {
    const rawRestTimeout = parseInt(process.env.DISCORD_REST_TIMEOUT_MS || "8000", 10);
    const restTimeoutMs = (!isNaN(rawRestTimeout) && rawRestTimeout > 0) ? Math.min(rawRestTimeout, 8000) : 8000;
    const restRetries = parseInt(process.env.DISCORD_REST_RETRIES || "2", 10);

    // Custom Undici Agent with bounded socket lifecycle to eliminate stale connections and head-of-line stalls
    const restAgent = new UndiciAgent({
        keepAliveTimeout: 10_000,         // 10s idle timeout: keeps socket alive across command defer -> reply lifecycle
        keepAliveMaxTimeout: 30_000,      // 30s max lifetime for pooled socket
        keepAliveTimeoutThreshold: 1_000, // Do not reuse socket within 1s of expiration
        pipelining: 0,                    // Disable HTTP pipelining to avoid head-of-line stalls
        connect: {
            timeout: 5_000,               // 5s connection timeout
        },
        headersTimeout: 6_000,            // 6s headers timeout
        bodyTimeout: 6_000,               // 6s body timeout
    });

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
        ],
        rest: {
            agent: restAgent,
            timeout: restTimeoutMs,
            retries: restRetries,
            offset: 50,
        },
    });

    client.commands = new Map();
    client.languageManager = new LanguageManager();
    client.defaultLanguage = process.env.DEFAULT_LANGUAGE || 'en';

    client.t = function (key, ...args) {
        return this.languageManager.get(this.defaultLanguage, key, ...args);
    };

    client.playerController = new PlayerController(client);
    client.activePlayers = new Map();
    client.guildSettings = guildSettings;
    client.autoplayEnabled = createAutoplayAdapter(guildSettings);
    client.activityManager = new ActivityManager(client);
    client.voiceChannelStatusManager = new VoiceChannelStatusManager(client);
    client.voiceHandshakeSynchronizer = new VoiceHandshakeSynchronizer(client);
    client.audioPlaybackMonitor = new AudioPlaybackMonitor(client);
    client.playbackProgressManager = new PlaybackProgressManager(client);
    client.playbackProgressManager.start();
    client.twentyFourSevenManager = twentyFourSevenManager;

    client.is247Enabled = function (guildId) {
        return this.guildSettings.is247(guildId);
    };

    client.set247 = function (guildId, enabled, options) {
        return this.guildSettings.set247(guildId, enabled, options);
    };

    client.updatePresence = function() {
        if (this.activityManager) {
            this.activityManager.updatePresence();
            return;
        }

        const activePlayers = Array.from(this.activePlayers.values());
        if (activePlayers.length === 0) {
            this.user?.setPresence?.({ activities: [], status: 'online' });
        } else if (activePlayers.length === 1) {
            this.user?.setActivity?.(this.t('PLAYING_MUSIC_GENERIC'), { type: ActivityType.Listening });
        } else {
            this.user?.setActivity?.(this.t('PLAYING_MUSIC_IN_SERVERS', activePlayers.length), { type: ActivityType.Listening });
        }
    };

    return client;
}

function writeHealthcheckHeartbeat() {
    fs.writeFile(HEALTHCHECK_HEARTBEAT_PATH, String(Date.now()), (error) => {
        if (error) {
            logger.debug('Failed to write healthcheck heartbeat:', error.message);
        }
    });
}

function startHealthcheckHeartbeat() {
    writeHealthcheckHeartbeat();
    return setInterval(writeHealthcheckHeartbeat, HEALTHCHECK_HEARTBEAT_INTERVAL_MS);
}

function cleanupGuildPlayer(client, guildId) {
    clearGuildLifecycleTimers(guildId);
    client.playerController.deletePlayer(guildId);
    client.activePlayers.delete(guildId);
    clearFailureState(guildId);
    client.audioPlaybackMonitor?.clearGuild(guildId);
    client.playbackProgressManager?.clearGuild(guildId);
    client.updatePresence();
    client.voiceChannelStatusManager?.clearStatusForGuild(guildId).catch(() => {});
}

function createAndRegisterLavalinkManager(client, initialNodes) {
    if (client.lavalink) {
        return client.lavalink;
    }

    if (!initialNodes || initialNodes.length === 0) {
        logger.warn('Cannot initialize LavalinkManager with empty nodes array');
        return null;
    }

    const validatedNodes = toValidNodeArray(initialNodes);

    try {
        client.lavalink = new LavalinkManager({
            nodes: validatedNodes,
            sendToShard: (guildId, payload) => {
                const guild = client.guilds.cache.get(guildId);
                if (guild) guild.shard.send(payload);
            },
            autoSkip: true,
            playerOptions: {
                clientBasedPositionUpdateInterval: 1000,
                minAutoPlayMs: 0,
                defaultSearchPlatform: process.env.DEFAULT_SEARCH_PLATFORM || "ytmsearch",
                applyVolumeAsFilter: false,
                instaUpdateFiltersFix: false,
                onDisconnect: {
                    autoReconnect: true,
                    destroyPlayer: false
                },
                onEmptyQueue: {
                    destroyAfterMs: parseInt(process.env.QUEUE_EMPTY_DESTROY_MS || "30000", 10),
                    autoPlayFunction: async (player, lastPlayedTrack) => {
                        if (isManualStopActive(player?.guildId)) return;
                        await handleAutoplay(client, player, 'autoPlayFunction', lastPlayedTrack);
                    },
                }
            },
        });
    } catch (initError) {
        const safeMessage = sanitizeError(initError);
        logger.error(`LavalinkManager initialization failed: ${safeMessage}`);
        throw initError;
    }

    // Attach socket protection to existing nodes and hook createNode for future nodes
    for (const node of client.lavalink.nodeManager.nodes.values()) {
        attachNodeProtection(node);
    }
    const origCreateNode = client.lavalink.nodeManager.createNode.bind(client.lavalink.nodeManager);
    client.lavalink.nodeManager.createNode = function (options) {
        const node = origCreateNode(options);
        attachNodeProtection(node);
        return node;
    };

    client.lavalink.nodeManager.on('connect', (node) => {
        if (client.lavalinkConnectionManager?.onConnect) {
            Promise.resolve(client.lavalinkConnectionManager.onConnect(node)).catch((err) => {
                logger.debug('onConnect handler error:', err?.message || err);
            });
        }

        if (client.lavalinkMode !== 'local') return;
        verifyNodePlugins(node).catch((error) => {
            logger.debug('Lavalink plugin check failed:', error?.message || error);
        });
    });

    client.lavalink.nodeManager.on('error', (node, error) => {
        client.lavalinkConnectionManager?.onError(node, error);
    });

    client.lavalink.nodeManager.on('disconnect', (node, reason) => {
        client.lavalinkConnectionManager?.onDisconnect(node, reason);
    });

    registerLavalinkEvents(client);

    return client.lavalink;
}

async function setupLavalink(client) {
    const { mode, nodes, provider } = await getInitialNodes();
    client.lavalinkMode = mode;
    client.publicNodeProvider = provider;

    if (nodes && nodes.length > 0) {
        try {
            createAndRegisterLavalinkManager(client, nodes);
        } catch (initError) {
            const safeMessage = sanitizeError(initError);
            logger.error(`LavalinkManager initialization failed: ${safeMessage}`);
            throw initError;
        }
    } else {
        client.lavalink = null;
        logger.warn('LavalinkManager initialization deferred: no active nodes available yet. Will retry in background.');
    }

    client.lavalinkConnectionManager = new LavalinkConnectionManager(client, createAndRegisterLavalinkManager);
    client.lavalinkConnectionManager.initialize();
}

function registerLavalinkEvents(client) {
    if (!client.lavalink || client.lavalink._eventsRegistered) return;
    client.lavalink._eventsRegistered = true;
    // A systemic source outage (every YouTube client blocked, a node handing back dead streams)
    // fails every track the instant it starts. lavalink-client then autoSkips through the whole
    // queue behind a cheerful "Now playing", and autoplay refills it with more of the same dead
    // source - forever. Trip once per streak: kill autoplay, stop draining, and say so.
    const handlePlaybackFailure = async (player, track, detail) => {
        const guildId = player.guildId;
        const { consecutive, shouldNotify } = recordFailure(guildId);

        logger.error(`Playback failed (${consecutive} in a row): ${track?.info?.title} — ${detail}`);
        if (!shouldNotify) return;

        logger.error(
            `Playback failed ${consecutive} times in a row in guild ${guildId}; stopping playback.\n` +
            `  - Is the source blocked?  docker compose logs lavalink | grep -iE "AllClientsFailed|Sign in to confirm"\n` +
            `  - Is the config current?  docker compose exec lavalink cat /opt/Lavalink/application.yml`
        );

        // Breaks the autoplay half of the loop. autoSkip is a library option we do not own,
        // so stopPlaying() below is what stops the drain - and it races the autoSkip already
        // in flight for this track. Best effort by design: if it loses, the next failure is
        // counted and the queue is empty within a few more skips either way.
        client.autoplayEnabled.set(guildId, false);

        // Defaults are what we want: clear the queue, and do not run autoplay on the way out.
        await player.stopPlaying().catch((error) => {
            logger.debug('Failed to stop player after repeated failures:', error?.message || error);
        });
        await client.playerController.sendToPlayerChannel(guildId, client.t('PLAYBACK_UNAVAILABLE'));
    };

    client.lavalink.on("trackStart", (player, track) => {
        if (isManualStopActive(player.guildId) || player?.getData?.("internal_stopPlaying")) {
            logger.debug(`[LIFECYCLE-DIAG] Suppressing stale trackStart for guild ${player.guildId} due to active manual stop`);
            try { player.stopPlaying(true, false).catch(() => {}); } catch (_) {}
            return;
        }

        client.audioPlaybackMonitor?.onTrackStart(player, track);
        historyManager.recordTrack(player.guildId, track);
        clearQueueEndTimeout(player.guildId);

        // Record previously played track in history
        const lastTrack = typeof player.getData === 'function' ? player.getData("lastPlayedTrack") : null;
        if (lastTrack && lastTrack.info?.identifier !== track?.info?.identifier && !lastTrack.pluginInfo?.clientData?.previousTrack) {
            if (!player.queue.previous) player.queue.previous = [];
            if (player.queue.previous[0]?.info?.identifier !== lastTrack.info?.identifier) {
                player.queue.previous.unshift(lastTrack);
                if (player.queue.previous.length > 25) {
                    player.queue.previous.splice(25);
                }
            }
        }
        if (typeof player.setData === 'function') {
            player.setData("lastPlayedTrack", track);
        }

        if (!client.autoplayEnabled.has(player.guildId)) {
            const autoplayDefault = process.env.AUTOPLAY_DEFAULT === 'true';
            client.autoplayEnabled.set(player.guildId, autoplayDefault);
        }

        schedulePlayerUpdate(client, player.guildId, 0, { replace: true, channelId: player.voiceChannelId || player.textChannelId, track });

        client.activePlayers.set(player.guildId, {
            title: track.info?.title,
            startedAt: Date.now()
        });
        client.updatePresence();

        client.playbackProgressManager?.onTrackStart(player.guildId);

        // Automatically update the connected voice channel status with the active playing track
        client.voiceChannelStatusManager?.updateFromPlayer(player, track, 'playing').catch(() => {});

        logger.track(`Now playing: ${track.info?.title} — ${track.info?.author}`);
    });

    client.lavalink.on("playerCreate", (player) => {
        player.client = client;
        const originalDestroy = player.destroy.bind(player);
        player.destroy = async function (reason, disconnect = true) {
            const is247 = Boolean(client.is247Enabled?.(player.guildId));

            // Intentional leave command or bot kicked from guild: disconnect and clean up fully
            if (reason === "command:leave" || reason === "guildDelete") {
                return originalDestroy(reason, true);
            }

            // Ordinary track end / empty queue when 24/7 is enabled: keep idle presence in channel
            if (reason === "QueueEmpty" && is247) {
                logger.debug(`Preserving idle 24/7 presence for guild ${player.guildId} on QueueEmpty`);
                player.playing = false;
                if (player.queue) player.queue.current = null;
                return this;
            }

            // Node failover, reconnection failure, or node deletion:
            // When 24/7 is enabled, do NOT send voice disconnect packet to Discord,
            // but let lavalink-client clean up its internal player structures with disconnect = false
            // so no zombie player pointing to a dead node is leaked into the manager.
            const isNodeTeardown = [
                "NodeDeleted",
                "NodeDestroy",
                "NodeReconnectFail",
                "DisconnectAllNodes",
                "ReconnectAllNodes",
                "PlayerChangeNodeFail",
                "PlayerChangeNodeFailNoEligibleNode",
                "NodeMigrationFail",
                "LavalinkNoVoice",
                "destroy"
            ].includes(reason);

            if (is247 && isNodeTeardown) {
                logger.debug(`Teardown player internally without voice disconnect for 24/7 guild ${player.guildId} (reason: ${reason})`);
                player.playing = false;
                if (player.queue) player.queue.current = null;
                return originalDestroy(reason, false);
            }

            return originalDestroy(reason, disconnect);
        };
    });

    client.lavalink.on("playerUpdate", (oldPlayer, newPlayer) => {
        client.audioPlaybackMonitor?.onPlayerUpdate(oldPlayer, newPlayer);
    });

    client.lavalink.on("playerPaused", (player) => {
        client.audioPlaybackMonitor?.onPlayerPaused(player);
    });

    client.lavalink.on("playerResumed", (player) => {
        client.audioPlaybackMonitor?.onPlayerResumed(player);
    });

    client.lavalink.on("playerSocketClosed", (player, payload) => {
        client.audioPlaybackMonitor?.onPlayerSocketClosed(player, payload);
    });

    if (client.lavalink.nodeManager?.on) {
        client.lavalink.nodeManager.on("raw", (node, payload) => {
            if (payload?.op === "stats") {
                client.audioPlaybackMonitor?.onNodeStats(node, payload);
            }
        });
    }

    client.lavalink.on("playerQueueEmptyStart", (player) => {
        if (client.is247Enabled(player.guildId)) {
            const timeout = player.getData("internal_queueempty");
            if (timeout) {
                clearTimeout(timeout);
                player.setData("internal_queueempty", void 0);
            }
        }
    });

    client.lavalink.on("trackEnd", (player, track, reason) => {
        client.audioPlaybackMonitor?.onTrackEnd(player, track, reason);
        client.playbackProgressManager?.onTrackEnd(player.guildId);
        if (track && typeof player.setData === 'function') {
            player.setData("lastPlayedTrack", track);
        }
        const endReason = reason?.reason || reason;
        logger.debug(`Track ended: ${track?.info?.title} (reason: ${endReason})`);
        if (endReason === "replaced" || endReason === "stopped" || isManualStopActive(player.guildId) || player?.getData?.("internal_stopPlaying")) return;

        setTimeout(() => {
            if (isManualStopActive(player.guildId)) return;
            if (player.queue.current) {
                schedulePlayerUpdate(client, player.guildId, 0, { replace: true, channelId: player.textChannelId });
            } else if (!client.autoplayEnabled.get(player.guildId)) {
                if (!client.is247Enabled(player.guildId)) {
                    cleanupGuildPlayer(client, player.guildId);
                } else {
                    client.playerController.showStoppedState(player.guildId, { channelId: player.textChannelId });
                    client.activePlayers.delete(player.guildId);
                    client.updatePresence();
                    client.voiceChannelStatusManager?.clearStatusForGuild(player.guildId).catch(() => {});
                }
            }
        }, TRACK_END_CLEANUP_DELAY_MS);

        if ((reason?.reason || reason) === "finished") recordSuccess(player.guildId);
    });

    client.lavalink.on("queueEnd", async (player, track, payload) => {
        client.playbackProgressManager?.onTrackEnd(player.guildId);
        const guildId = player.guildId;

        clearQueueEndTimeout(guildId);

        // If stopped intentionally (e.g. /stop or stopPlaying or manual stop generation), do not restart playback or send queue ended notification
        const isSkipAction = Boolean(player.getData("internal_skipped"));
        const isIntentionalStop = Boolean(
            isManualStopActive(guildId) ||
            player.getData("internal_stopPlaying") ||
            player.getData("internal_autoplayStopPlaying") ||
            (payload?.reason === "stopped" && !isSkipAction)
        );
        if (isIntentionalStop) {
            client.activePlayers.delete(guildId);
            client.updatePresence();
            client.voiceChannelStatusManager?.clearStatusForGuild(guildId).catch(() => {});
            client.playerController.showStoppedState(guildId);
            return;
        }

        const is247 = client.is247Enabled(guildId);

        // The breaker already explains a systemic outage, so a per-track notice on top of it
        // would just be noise.
        const endMessage = () => {
            if (hasNotified(guildId)) return null;
            if (endedOnFailure(payload)) return client.t('TRACK_UNPLAYABLE', track?.info?.title || client.t('UNKNOWN_TITLE'));
            // If 24/7 is enabled, the bot remains in the channel
            if (is247) return null;
            return client.t('QUEUE_ENDED');
        };

        if (client.autoplayEnabled.get(guildId)) {
            // Only natural queue completion triggers Autoplay progression
            if (endedOnFailure(payload)) {
                logger.warn(`Queue ended on failure (${payload?.reason || payload?.type}) for guild ${guildId}; skipping autoplay to prevent failure loop.`);
                const message = endMessage();
                if (message) client.playerController.sendToPlayerChannel(guildId, message);
                if (!is247) cleanupGuildPlayer(client, guildId);
                return;
            }

            // If tracks were already added by autoPlayFunction or queue has items, resume playback
            if (player.queue.current || player.playing || player.queue.tracks.length > 0) {
                if (!player.queue.current && player.queue.tracks.length > 0 && !player.playing) {
                    await player.play().catch(() => {});
                }
                return;
            }

            // Fallback: If autoPlayFunction was bypassed or didn't add tracks yet, actively discover now
            const lastTrack = track || (typeof player.getData === 'function' ? player.getData('lastPlayedTrack') : null) || player.queue.previous?.[0];
            const started = await handleAutoplay(client, player, 'queueEnd', lastTrack);
            if (started || player.queue.current || player.playing || player.queue.tracks.length > 0) {
                return;
            }

            const timeout = setTimeout(() => {
                clearQueueEndTimeout(guildId);

                const currentPlayer = client.lavalink.getPlayer(guildId);
                if (currentPlayer?.queue.current || currentPlayer?.playing || currentPlayer?.queue?.tracks?.length > 0) return;

                const message = endMessage();
                if (message) client.playerController.sendToPlayerChannel(guildId, message);

                if (!is247) {
                    cleanupGuildPlayer(client, guildId);
                } else {
                    client.playerController.showStoppedState(guildId);
                    client.activePlayers.delete(guildId);
                    client.updatePresence();
                    client.voiceChannelStatusManager?.clearStatusForGuild(guildId).catch(() => {});
                }
            }, AUTOPLAY_TIMEOUT_MS);
            setQueueEndTimeout(guildId, timeout);
            return;
        }

        const message = endMessage();
        if (message) client.playerController.sendToPlayerChannel(guildId, message);

        if (!is247) {
            cleanupGuildPlayer(client, guildId);
        } else {
            client.playerController.showStoppedState(guildId);
            client.activePlayers.delete(guildId);
            client.updatePresence();
            client.voiceChannelStatusManager?.clearStatusForGuild(guildId).catch(() => {});
        }
    });

    client.lavalink.on("trackStuck", async (player, track, payload) => {
        const recovered = await client.audioPlaybackMonitor?.onTrackStuck(player, track, payload).catch(() => false);
        if (!recovered) {
            handlePlaybackFailure(player, track, `stuck for ${payload?.thresholdMs || 10000}ms`).catch(() => {});
        }
    });

    client.lavalink.on("trackError", async (player, track, payload) => {
        const detail = payload?.exception?.message || payload?.error || payload?.message || 'Unknown error';
        const recovered = await client.audioPlaybackMonitor?.onTrackError(player, track, payload).catch(() => false);
        if (!recovered) {
            handlePlaybackFailure(player, track, detail).catch(() => {});
        }
    });

    // /stop, /clear, an empty channel and a kick all destroy the player without ever reaching
    // cleanupGuildPlayer, so this is the only place that catches every teardown path.
    client.lavalink.on("playerDestroy", (player) => {
        client.audioPlaybackMonitor?.onPlayerDestroy(player);
        clearFailureState(player.guildId);
    });
}

function setupShutdown(client) {
    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down gracefully...`);

        client.lavalinkConnectionManager.destroy();
        if (client.activityManager) {
            client.activityManager.stop();
        }
        if (client.voiceChannelStatusManager) {
            client.voiceChannelStatusManager.destroy();
        }
        if (client.audioPlaybackMonitor) {
            client.audioPlaybackMonitor.destroy();
        }
        clearAllQueueEndTimeouts();
        clearAllPlayerUpdates();

        if (client.healthcheckHeartbeat) {
            clearInterval(client.healthcheckHeartbeat);
            client.healthcheckHeartbeat = null;
        }

        client.publicNodeProvider?.destroy();
        client.playbackProgressManager?.stop();
        performanceMonitor.destroy();

        searchSessions.destroy();

        const shutdownWork = (async () => {
            if (client.lavalink) {
                await Promise.allSettled([...client.lavalink.players.values()].map(player => player.destroy()));
                await Promise.allSettled([...client.lavalink.nodeManager.nodes.values()].map(node => node.destroy()));
            }
            if (client.lavalinkConnectionManager) {
                client.lavalinkConnectionManager.destroy();
            }
            await client.destroy();
        })();

        const result = await Promise.race([
            shutdownWork.then(() => 'complete'),
            new Promise(resolve => setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS)),
        ]);

        if (result === 'timeout') {
            logger.warn(`Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms deadline; exiting`);
        }

        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const http = require('node:http');

// Render / cloud host keep-alive HTTP port listener
const port = process.env.PORT || 3000;
const keepAliveServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Baduwa / ZYRO Music Bot is Online and Healthy! 🎧');
});
keepAliveServer.listen(port, () => {
    logger.info(`[http] Keep-alive server listening on port ${port}`);

    // Self-ping keepalive mechanism for Render Free Tier (prevents 15-minute idle spindown)
    const externalUrl = process.env.RENDER_EXTERNAL_URL
        || (process.env.RENDER_SERVICE_NAME ? `https://${process.env.RENDER_SERVICE_NAME}.onrender.com` : null);
    if (externalUrl) {
        logger.info(`[http] Render external URL detected: ${externalUrl}. Starting self-ping keep-alive (every 4 minutes)...`);
        const pingInterval = setInterval(() => {
            const clientModule = externalUrl.startsWith('https') ? require('node:https') : require('node:http');
            clientModule.get(externalUrl, (resp) => {
                logger.debug(`[http] Self-ping successful: HTTP ${resp.statusCode}`);
            }).on('error', (err) => {
                logger.debug('[http] Self-ping ping error:', err?.message || err);
            });
        }, 4 * 60 * 1000);
        if (typeof pingInterval.unref === 'function') {
            pingInterval.unref();
        }
    } else {
        logger.warn('[http] No RENDER_EXTERNAL_URL or RENDER_SERVICE_NAME set; self-ping keep-alive is inactive.');
    }
});

async function bootstrap() {
    const client = createClient();
    loadCommands(client);
    registerEvents(client);
    setupShutdown(client);
    await setupLavalink(client);
    await client.login(process.env.TOKEN || process.env.DISCORD_TOKEN);
    client.healthcheckHeartbeat = startHealthcheckHeartbeat();
    return client;
}

process.on('uncaughtException', (error) => {
    logger.error('Unhandled exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    logger.error('Unhandled promise rejection:', sanitizeError(error));
});

if (require.main === module) {
    bootstrap().catch(err => {
        logger.error('Failed to start bot:', err);
        process.exit(1);
    });
}

module.exports = {
    createClient,
    getInitialNodes,
    setupLavalink,
    createAndRegisterLavalinkManager,
    bootstrap,
};
