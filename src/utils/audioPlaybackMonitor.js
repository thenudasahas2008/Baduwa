const logger = require('./logger');
const { resolveAlternativeTrack } = require('./searchEngine');
const { isManualStopActive } = require('./playerLifecycle');

const WATCHDOG_CHECK_INTERVAL_MS = 3000;
const STALL_THRESHOLD_MS = 18000;
const INITIAL_GRACE_PERIOD_MS = 15000;
const MAX_TRACK_RETRIES = 2;

function formatDuration(ms) {
    if (!ms || isNaN(ms) || ms < 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return `${hours}:${String(remMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatUptime(ms) {
    if (!ms || isNaN(ms) || ms <= 0) return 'Unavailable';
    const s = Math.floor(ms / 1000);
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return 'never';
    const elapsedMs = Date.now() - timestamp;
    if (elapsedMs < 5000) return 'just now';
    const s = Math.floor(elapsedMs / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}

class AudioPlaybackMonitor {
    constructor(client) {
        this.client = client;
        this.monitoredPlayers = new Map(); // guildId -> State
        this.watchdogInterval = null;
        this.latestNodeStats = new Map(); // nodeId -> latest WebSocket stats payload
    }

    /**
     * Sanitized structured diagnostic logger
     */
    logDiagnostic(eventType, data = {}) {
        const {
            guildId = 'unknown',
            nodeId = 'unknown',
            trackTitle = 'none',
            trackIdentifier = 'none',
            position = 0,
            duration = 0,
            elapsedSinceUpdate = 0,
            detail = '',
            action = null,
            level = 'info'
        } = data;

        const redactSecrets = (str) => String(str || '')
            .replace(/[\w-]{24,30}\.[\w-]{5,8}\.[\w-]{20,50}/g, '[REDACTED_TOKEN]')
            .replace(/(password|token|secret|authorization)[:=][^&\s]+/gi, '$1=[REDACTED]');

        const sanitizedTitle = trackTitle ? redactSecrets(String(trackTitle).slice(0, 50).replace(/["\\]/g, '')) : 'none';
        const sanitizedId = trackIdentifier ? redactSecrets(String(trackIdentifier).slice(0, 25)) : 'none';
        const sanitizedDetail = detail ? redactSecrets(String(detail).slice(0, 100).replace(/["\\]/g, '')) : '';
        const sanitizedAction = action ? redactSecrets(String(action).slice(0, 80).replace(/["\\]/g, '')) : '';

        const msg = `[AUDIO-DIAG] event=${eventType} guild=${guildId} node=${nodeId} pos=${position}ms/${duration}ms elapsed=${elapsedSinceUpdate}ms track="${sanitizedTitle}" (${sanitizedId})${sanitizedDetail ? ` detail="${sanitizedDetail}"` : ''}${sanitizedAction ? ` action="${sanitizedAction}"` : ''}`;

        if (level === 'error') {
            logger.error(msg);
        } else if (level === 'warn') {
            logger.warn(msg);
        } else {
            logger.info(msg);
        }

        if (guildId && guildId !== 'unknown') {
            this.recordGuildEvent(guildId, eventType, {
                ...data,
                detail: sanitizedDetail,
                action: sanitizedAction,
                trackTitle: sanitizedTitle
            });
        }
    }

    recordGuildEvent(guildId, eventType, data = {}) {
        if (!guildId || guildId === 'unknown') return;
        const state = this.getOrCreateState(guildId);
        const now = Date.now();

        const eventItem = {
            timestamp: now,
            event: eventType,
            trackTitle: data.trackTitle ? String(data.trackTitle).slice(0, 50) : null,
            trackIdentifier: data.trackIdentifier ? String(data.trackIdentifier).slice(0, 25) : null,
            position: data.position ?? null,
            duration: data.duration ?? null,
            nodeId: data.nodeId || 'unknown',
            detail: data.detail ? String(data.detail).slice(0, 100) : null,
            action: data.action ? String(data.action).slice(0, 80) : null,
            level: data.level || 'info'
        };

        state.recentEvents.push(eventItem);
        if (state.recentEvents.length > 25) {
            state.recentEvents.shift();
        }

        if (data.level === 'warn' || data.level === 'error') {
            state.recentErrors.push(eventItem);
            if (state.recentErrors.length > 15) {
                state.recentErrors.shift();
            }
        }

        if (eventType === 'VOICE_SOCKET_CLOSED') {
            state.lastSocketClose = {
                timestamp: now,
                code: data.code || data.detail || 0,
                reason: data.detail || 'Socket closed',
            };
        } else if (eventType === 'SOURCE_UNAVAILABLE') {
            state.lastSourceFailure = {
                timestamp: now,
                detail: data.detail || 'Source stream failed',
                trackTitle: data.trackTitle || 'unknown',
                trackId: data.trackIdentifier || 'unknown'
            };
        } else if (eventType === 'TRACK_END') {
            state.lastTrackEnd = {
                timestamp: now,
                reason: data.detail || 'finished',
                trackTitle: data.trackTitle,
                trackId: data.trackIdentifier
            };
        } else if (eventType === 'NODE_MIGRATED') {
            state.lastNodeMigration = {
                timestamp: now,
                nodeId: data.nodeId,
                action: data.action
            };
        }
    }

    getOrCreateState(guildId) {
        let state = this.monitoredPlayers.get(guildId);
        if (!state) {
            state = {
                guildId,
                lastPosition: 0,
                lastProgressTimestamp: Date.now(),
                lastPositionUpdateTimestamp: Date.now(),
                consecutiveProgressCount: 0,
                trackStartTime: Date.now(),
                stalledChecks: 0,
                recovering: false,
                recoveryPending: null,
                trackRetries: new Map(), // trackIdentifier -> count
                recentEvents: [],
                recentErrors: [],
                lastSocketClose: null,
                lastSourceFailure: null,
                lastTrackEnd: null,
                lastNodeMigration: null,
                lastRecoveryResult: null,
            };
            this.monitoredPlayers.set(guildId, state);
        }
        return state;
    }

    startWatchdog() {
        if (this.watchdogInterval) return;

        this.watchdogInterval = setInterval(() => {
            this.checkPlayersForStalls().catch((err) => {
                logger.debug('Error in audio playback watchdog check:', err?.message || err);
            });
        }, WATCHDOG_CHECK_INTERVAL_MS);

        if (typeof this.watchdogInterval.unref === 'function') {
            this.watchdogInterval.unref();
        }
    }

    stopWatchdog() {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
    }

    onTrackStart(player, track) {
        if (!player || !player.guildId) return;
        const state = this.getOrCreateState(player.guildId);

        const newTrackId = track?.info?.identifier;
        const pendingTrackId = state.recoveryPending?.trackIdentifier;

        // If this is a new track or recovery is for a different track,
        // strictly reset lastPosition to 0 so new tracks NEVER start from the middle!
        if (!state.recoveryPending || (newTrackId && pendingTrackId && newTrackId !== pendingTrackId)) {
            state.lastPosition = 0;
            state.lastSourceFailure = null;
            state.recoveryPending = null;
        }
        state.lastProgressTimestamp = Date.now();
        state.trackStartTime = Date.now();
        state.stalledChecks = 0;

        this.logDiagnostic('TRACK_START', {
            guildId: player.guildId,
            nodeId: player.node?.id || player.node?.options?.id || 'unknown',
            trackTitle: track?.info?.title,
            trackIdentifier: track?.info?.identifier,
            duration: track?.info?.duration || 0,
        });

        logger.info(`[PLAY-STAGE] stage=TRACK_START_EVENT outcome=SUCCESS guild=${player.guildId} track="${track?.info?.title || 'unknown'}" pos=${player.position || 0}ms ping=${player.ping?.ws ?? -1}ms connected=${Boolean(player.connected)}`);

        this.startWatchdog();
    }

    async onPlayerUpdate(oldPlayer, newPlayer) {
        if (!newPlayer || !newPlayer.guildId) return;
        const state = this.getOrCreateState(newPlayer.guildId);

        const currentPos = Number(newPlayer.lastPosition ?? newPlayer.position ?? 0);
        const lastPos = Number(state.lastPosition || 0);
        state.lastPositionUpdateTimestamp = Date.now();

        // Check for position jump backwards (loop, seek backwards, or track restart)
        if (currentPos < lastPos - 1000) {
            state.lastPosition = currentPos;
            state.lastProgressTimestamp = Date.now();
            state.stalledChecks = 0;
            state.consecutiveProgressCount = 1;
        } else if (currentPos > lastPos + 50) {
            state.lastPosition = currentPos;
            state.lastProgressTimestamp = Date.now();
            state.stalledChecks = 0;
            state.consecutiveProgressCount = (state.consecutiveProgressCount || 0) + 1;
        } else if (Math.abs(currentPos - lastPos) <= 20) {
            state.consecutiveProgressCount = 0;
        }

        // Track voice gateway connection state from player update
        const isConnected = (newPlayer.connected === true);
        const rawPing = Number(newPlayer.ping?.ws ?? newPlayer.ping ?? -1);
        const validPing = rawPing >= 0 ? rawPing : null;

        state.isLavalinkConnected = isConnected;
        state.lavalinkPing = validPing;

        // Diagnostic logging of voice connection status transitions
        if (isConnected) {
            state.consecutiveDisconnectedUpdates = 0;
            if (!state.hasLoggedConnected) {
                state.hasLoggedConnected = true;
                state.voiceDisconnectedChecks = 0;
                this.logDiagnostic('VOICE_GATEWAY_CONNECTED', {
                    guildId: newPlayer.guildId,
                    nodeId: newPlayer.node?.id || 'unknown',
                    trackIdentifier: newPlayer.queue?.current?.info?.identifier,
                    position: currentPos,
                    detail: `Lavalink connected to Discord voice gateway, ping=${validPing != null ? validPing + 'ms' : 'n/a'}`
                });
                // Update dashboard message in-place to clear any voice disconnected banner
                this.client?.playerController?.updatePlayer?.(newPlayer.guildId, { replace: false }).catch(() => {});
            }
        } else {
            state.consecutiveDisconnectedUpdates = (state.consecutiveDisconnectedUpdates || 0) + 1;
            // Transient single-update drops should not cause audio interruption or emergency disconnects.
            // Only declare disconnected and initiate auto-healing if disconnection is sustained (>= 2 updates).
            if (state.consecutiveDisconnectedUpdates >= 2 && state.hasLoggedConnected) {
                state.hasLoggedConnected = false;
                this.logDiagnostic('VOICE_GATEWAY_DISCONNECTED', {
                    guildId: newPlayer.guildId,
                    nodeId: newPlayer.node?.id || 'unknown',
                    trackIdentifier: newPlayer.queue?.current?.info?.identifier,
                    position: currentPos,
                    detail: 'Lavalink lost connection to Discord voice gateway (ping: -1, connected: false)',
                    level: 'warn'
                });

                // If bot is still inside a Discord voice channel, attempt smooth auto-healing (without resetting gateway session)
                const guild = this.client?.guilds?.cache?.get(newPlayer.guildId);
                if (guild?.members?.me?.voice?.channelId) {
                    await this.autoHealVoiceConnection(newPlayer, { forceGatewayReconnect: false }).catch(() => {});
                }
            }
        }

        // Verified playback recovery: confirm success only when real progression is observed
        if (state.recoveryPending && !state.recoveryPending.verified) {
            const currentTrackId = newPlayer.queue?.current?.info?.identifier;
            const pendingTrackId = state.recoveryPending.trackIdentifier;

            if (!currentTrackId || currentTrackId === pendingTrackId) {
                if (state.recoveryPending.firstObservedPosition === null || typeof state.recoveryPending.firstObservedPosition === 'undefined') {
                    state.recoveryPending.firstObservedPosition = currentPos;
                } else if (currentPos >= state.recoveryPending.firstObservedPosition + 200) {
                    state.recoveryPending.verified = true;
                    state.recoveryPending = null;
                    state.trackRetries.delete(pendingTrackId);
                    state.lastProgressTimestamp = Date.now();
                    state.stalledChecks = 0;

                    this.logDiagnostic('RECOVERY_SUCCEEDED', {
                        guildId: newPlayer.guildId,
                        nodeId: newPlayer.node?.id || newPlayer.node?.options?.id || 'unknown',
                        trackTitle: newPlayer.queue?.current?.info?.title,
                        trackIdentifier: pendingTrackId,
                        position: currentPos,
                        duration: newPlayer.queue?.current?.info?.duration || 0,
                        action: 'playback progression verified successfully',
                    });

                    if (this.client?.voiceChannelStatusManager?.updateFromPlayer) {
                        this.client.voiceChannelStatusManager.updateFromPlayer(newPlayer, newPlayer.queue?.current, 'playing').catch(() => {});
                    }
                    if (this.client?.playerController?.replaceWithFullDashboard) {
                        this.client.playerController.replaceWithFullDashboard(newPlayer.guildId, newPlayer.textChannelId, { inPlace: true, reason: 'recovery' }).catch(() => {});
                    }
                }
            }
        }

        // In public mode, report proven audio delivery success on the node
        if (currentPos > lastPos + 200 && this.client?.lavalinkMode === 'public' && this.client?.publicNodeProvider && newPlayer.node) {
            const host = newPlayer.node.host || newPlayer.node.options?.host;
            const port = newPlayer.node.port || newPlayer.node.options?.port;
            if (host && port) {
                this.client.publicNodeProvider.recordPlaybackSuccess(host, port);
            }
        }
    }

    onPlayerPaused(player) {
        if (!player || !player.guildId) return;
        const state = this.getOrCreateState(player.guildId);
        state.lastProgressTimestamp = Date.now();
        state.stalledChecks = 0;

        this.logDiagnostic('PLAYER_PAUSED', {
            guildId: player.guildId,
            nodeId: player.node?.id || 'unknown',
            trackTitle: player.queue?.current?.info?.title,
            trackIdentifier: player.queue?.current?.info?.identifier,
            position: player.position || 0,
            duration: player.queue?.current?.info?.duration || 0,
        });
    }

    onPlayerResumed(player) {
        if (!player || !player.guildId) return;
        const state = this.getOrCreateState(player.guildId);
        state.lastProgressTimestamp = Date.now();
        state.stalledChecks = 0;

        this.logDiagnostic('PLAYER_RESUMED', {
            guildId: player.guildId,
            nodeId: player.node?.id || 'unknown',
            trackTitle: player.queue?.current?.info?.title,
            trackIdentifier: player.queue?.current?.info?.identifier,
            position: player.position || 0,
            duration: player.queue?.current?.info?.duration || 0,
        });
    }

    onTrackEnd(player, track, reason) {
        if (!player || !player.guildId) return;
        const state = this.monitoredPlayers.get(player.guildId);
        const reasonText = reason?.reason || reason || 'unknown';

        this.logDiagnostic('TRACK_END', {
            guildId: player.guildId,
            nodeId: player.node?.id || 'unknown',
            trackTitle: track?.info?.title,
            trackIdentifier: track?.info?.identifier,
            position: player.position || 0,
            duration: track?.info?.duration || 0,
            detail: reasonText,
        });

        if (state) {
            state.stalledChecks = 0;
            state.recoveryPending = null;
            state.lastPosition = 0; // Always clear lastPosition when a track ends so subsequent tracks start from 0:00!
            state.lastTrackEnd = {
                timestamp: Date.now(),
                reason: reasonText,
                trackTitle: track?.info?.title,
                trackId: track?.info?.identifier
            };
            // Clean up retry record for tracks that finished normally
            if (reasonText === 'finished' && track?.info?.identifier) {
                state.trackRetries.delete(track.info.identifier);
            }
        }
    }

    async onTrackStuck(player, track, payload) {
        if (!player || !player.guildId) return;
        const threshold = payload?.thresholdMs || 10000;

        this.logDiagnostic('TRACK_STUCK', {
            guildId: player.guildId,
            nodeId: player.node?.id || 'unknown',
            trackTitle: track?.info?.title,
            trackIdentifier: track?.info?.identifier,
            position: player.position || 0,
            duration: track?.info?.duration || 0,
            detail: `stuck threshold ${threshold}ms`,
            level: 'warn'
        });

        logger.info(`[PLAY-STAGE] stage=TRACK_STUCK_EVENT outcome=STUCK guild=${player.guildId} track="${track?.info?.title || 'unknown'}" pos=${player.position || 0}ms threshold=${threshold}ms`);

        return await this.recoverPlayback(player, track, {
            reason: 'trackStuck',
            detail: `Lavalink trackStuck event (${threshold}ms threshold)`
        });
    }

    isSourceLevelError(errorMsg) {
        if (!errorMsg || typeof errorMsg !== 'string') return false;
        const lower = errorMsg.toLowerCase();
        return lower.includes('requires login')
            || lower.includes('no supported audio streams')
            || lower.includes('unavailable')
            || lower.includes('age restricted')
            || lower.includes('sign in to confirm')
            || lower.includes('private video')
            || lower.includes('members-only')
            || lower.includes('copyright')
            || lower.includes('not available in your country')
            || lower.includes('blocked in your country')
            || lower.includes('format not supported')
            || lower.includes('video is private');
    }

    async onTrackError(player, track, payload) {
        if (!player || !player.guildId) return;
        const errorMsg = payload?.exception?.message || payload?.error || payload?.message || 'Unknown error';
        const isSourceError = this.isSourceLevelError(errorMsg);

        if (isSourceError) {
            const state = this.getOrCreateState(player.guildId);
            state.lastSourceFailure = {
                timestamp: Date.now(),
                trackId: track?.info?.identifier,
                detail: errorMsg
            };
        }

        this.logDiagnostic(isSourceError ? 'SOURCE_UNAVAILABLE' : 'TRACK_EXCEPTION', {
            guildId: player.guildId,
            nodeId: player.node?.id || 'unknown',
            trackTitle: track?.info?.title,
            trackIdentifier: track?.info?.identifier,
            position: player.position || 0,
            duration: track?.info?.duration || 0,
            detail: errorMsg,
            level: 'warn'
        });

        logger.info(`[PLAY-STAGE] stage=TRACK_EXCEPTION_EVENT outcome=ERROR guild=${player.guildId} track="${track?.info?.title || 'unknown'}" pos=${player.position || 0}ms error="${errorMsg}"`);

        return await this.recoverPlayback(player, track, {
            reason: isSourceError ? 'sourceUnavailable' : 'trackError',
            isSourceError,
            detail: errorMsg
        });
    }

    async onPlayerSocketClosed(player, payload) {
        if (!player || !player.guildId) return;
        const code = payload?.code || 0;
        const reason = payload?.reason || 'Socket closed';

        const isMigrating = Boolean(
            this.client?.lavalinkConnectionManager?.isPlayerMigrating?.(player.guildId) ||
            player.isChangingNode ||
            (typeof player.getData === 'function' && player.getData("internal_nodeChanging"))
        );

        this.logDiagnostic('VOICE_SOCKET_CLOSED', {
            guildId: player.guildId,
            nodeId: player.node?.id || 'unknown',
            position: player.position || 0,
            detail: `code ${code}: ${reason}${isMigrating ? ' (during node migration)' : ''}`,
            code,
            level: 'warn'
        });

        const state = this.getOrCreateState(player.guildId);
        state.lastSocketClose = {
            timestamp: Date.now(),
            code,
            reason,
            isMigrating
        };

        // If player is actively changing nodes, the voice socket closing on the old node is an expected transition
        if (isMigrating) {
            logger.debug(`Voice socket closed for guild ${player.guildId} during active node migration; skipping redundant voice reconnect.`);
            return;
        }

        // 4006 / 4009 / 4014 / 4015: Session invalid, timeout, voice server changed/crashed; 1000 / 1006: Socket closed
        const reconnectableCodes = [4006, 4009, 4014, 4015, 1000, 1001, 1006];
        if (reconnectableCodes.includes(code) && (player.playing || this.client?.is247Enabled?.(player.guildId))) {
            logger.info(`Reconnecting Discord voice for guild ${player.guildId} after voice socket closed (${code})...`);
            await this.autoHealVoiceConnection(player).catch((connErr) => {
                logger.debug('Voice reconnection after socket closed failed:', connErr?.message || connErr);
            });
        }
    }

    /**
     * Automatically heals Lavalink's connection to the Discord voice gateway when
     * player.connected is false while the bot is inside a Discord voice channel.
     * Prioritizes soft re-dispatching of cached credentials to prevent tearing down
     * the Discord voice session and interrupting audio playback.
     */
    async autoHealVoiceConnection(player, options = {}) {
        if (!player || !player.guildId) return false;
        const guildId = player.guildId;
        const state = this.getOrCreateState(guildId);

        // Debounce healing attempts (minimum 3 seconds between attempts per guild)
        const now = Date.now();
        if (now - (state.lastVoiceHealAttempt || 0) < 3000) {
            return false;
        }
        state.lastVoiceHealAttempt = now;

        const guild = this.client?.guilds?.cache?.get(guildId);
        const meVoice = guild?.members?.me?.voice;
        const channelId = meVoice?.channelId || player.voiceChannelId || player.options?.voiceChannelId;

        // If bot is not in a Discord voice channel, cannot heal gateway socket
        if (!channelId) {
            return false;
        }

        this.logDiagnostic('VOICE_GATEWAY_HEALING', {
            guildId,
            nodeId: player.node?.id || 'unknown',
            trackIdentifier: player.queue?.current?.info?.identifier,
            position: player.position || 0,
            detail: `Attempting voice gateway auto-healing for channel ${channelId} (forceReconnect: ${Boolean(options.forceGatewayReconnect)})`,
            level: 'warn'
        });

        // 1. Invalidate cached dispatch fingerprint in VoiceHandshakeSynchronizer
        if (this.client?.voiceHandshakeSynchronizer) {
            this.client.voiceHandshakeSynchronizer.invalidateFingerprint(guildId);
        }

        // 2. Check if complete voice credentials are known in synchronizer
        const voiceState = this.client?.voiceHandshakeSynchronizer?.getVoiceState?.(guildId);
        const effectiveSession = voiceState?.sessionId || meVoice?.sessionId || player.voice?.sessionId;
        const effectiveToken = voiceState?.token || player.voice?.token;
        const effectiveEndpoint = voiceState?.endpoint || player.voice?.endpoint;

        const hasValidCredentials = Boolean(effectiveToken && effectiveEndpoint && effectiveSession && player.node?.sessionId);

        if (hasValidCredentials) {
            // Re-dispatch credentials directly to Lavalink's player REST API.
            // This reconnects Lavalink to the Discord voice server WITHOUT resetting Discord gateway session.
            try {
                await this.client.voiceHandshakeSynchronizer.dispatchToLavalink(
                    player,
                    guildId,
                    effectiveToken,
                    effectiveEndpoint,
                    effectiveSession,
                    channelId
                );
            } catch (err) {
                logger.debug(`[AUDIO-MONITOR] Voice gateway credentials dispatch failed: ${err?.message || err}`);
            }

            // ONLY call player.connect() if explicitly requested (e.g. repeated failure or socket error code),
            // because player.connect() sends OP 4 which forces Discord to tear down the voice connection and cuts audio.
            if (options.forceGatewayReconnect) {
                try {
                    await player.connect();
                } catch (connErr) {
                    logger.debug(`[AUDIO-MONITOR] player.connect() force heal error: ${connErr?.message || connErr}`);
                }
            }
        } else {
            // Credentials are missing, so player.connect() is genuinely required to ask Discord for them
            try {
                await player.connect();
            } catch (connErr) {
                logger.debug(`[AUDIO-MONITOR] player.connect() voice heal error: ${connErr?.message || connErr}`);
            }
        }

        return true;
    }

    onPlayerDestroy(player) {
        if (!player || !player.guildId) return;
        this.clearGuild(player.guildId);
        if (this.monitoredPlayers.size === 0) {
            this.stopWatchdog();
        }
    }

    /**
     * Real-time WebSocket audio frame and node statistics collector.
     * Captures node-level frameStats (sent, nulled, deficit), uptime, and resource usage,
     * and correlates them with active guilds/tracks on that node.
     */
    onNodeStats(node, stats) {
        if (!node || !stats) return;
        const nodeId = node.id || node.options?.id || 'unknown';
        const now = Date.now();

        const frameStatsObj = stats.frameStats || node.stats?.frameStats || null;
        const sent = frameStatsObj ? Number(frameStatsObj.sent || 0) : null;
        const nulled = frameStatsObj ? Number(frameStatsObj.nulled || 0) : null;
        const deficit = frameStatsObj ? Number(frameStatsObj.deficit || 0) : null;

        const uptime = stats.uptime || node.stats?.uptime || 0;
        const players = stats.players != null ? Number(stats.players) : (node.stats?.players ?? 0);
        const playingPlayers = stats.playingPlayers != null ? Number(stats.playingPlayers) : (node.stats?.playingPlayers ?? 0);

        const cpuStats = stats.cpu || node.stats?.cpu;
        const cpuLavalink = cpuStats?.lavalinkLoad != null ? (cpuStats.lavalinkLoad * 100).toFixed(1) + '%' : 'Unavailable';
        const cpuSystem = cpuStats?.systemLoad != null ? (cpuStats.systemLoad * 100).toFixed(1) + '%' : 'Unavailable';

        const memStats = stats.memory || node.stats?.memory;
        const memUsedMb = memStats?.used != null ? (memStats.used / 1024 / 1024).toFixed(1) : 'Unavailable';

        this.latestNodeStats.set(nodeId, {
            timestamp: now,
            uptime,
            players,
            playingPlayers,
            frameStats: frameStatsObj ? { sent, nulled, deficit } : null,
            cpu: { lavalink: cpuLavalink, system: cpuSystem },
            memory: { usedMb: memUsedMb }
        });

        // Correlate with active players in this client connected to this node
        if (this.client?.guilds?.cache) {
            for (const [guildId, guild] of this.client.guilds.cache.entries()) {
                const player = this.client.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;
                if (!player || (player.node?.id !== nodeId && nodeId !== 'unknown') || !player.queue?.current) continue;

                const track = player.queue.current;
                const trackId = track.info?.identifier || 'unknown';
                const position = player.position || 0;
                const ping = player.ping?.ws ?? null;
                const isVoiceConnected = Boolean(guild.members?.me?.voice?.channelId && player.connected !== false);

                const correlationId = `frame_${now}_${guildId.slice(-4)}`;
                const frameStr = frameStatsObj 
                    ? `sent=${sent} nulled=${nulled} deficit=${deficit}`
                    : 'frameStats=Unavailable';

                logger.info(
                    `[AUDIO-FRAME-STATS] id=${correlationId} guild=${guildId} node=${nodeId} ` +
                    `uptime=${uptime}ms players=${players} playing=${playingPlayers} ` +
                    `${frameStr} cpuLavalink=${cpuLavalink} cpuSystem=${cpuSystem} memUsedMb=${memUsedMb} ` +
                    `track="${trackId}" pos=${position}ms ping=${ping != null ? ping + 'ms' : 'n/a'} voiceConnected=${isVoiceConnected}`
                );

                // Diagnostic telemetry for node frame statistics (sent, nulled, deficit)
                // Note: Node-level aggregate frame stats reflect global traffic across all bot connections
                // and must NOT trigger mid-track player migration while the guild's stream is actively progressing.
                if (frameStatsObj) {
                    const hasHighNullRatio = sent > 50 && nulled > 0 && (nulled / (sent + nulled)) > 0.15;
                    const hasHighDeficit = sent > 50 && deficit != null && deficit > 100;
                    if (hasHighNullRatio || hasHighDeficit) {
                        const detail = hasHighNullRatio
                            ? `High null frame ratio on node (${nulled}/${sent + nulled} frames nulled). Node buffer starvation telemetry.`
                            : `Severe frame deficit on node (${deficit} deficit frames). Node load or network telemetry.`;
                        this.logDiagnostic('BUFFER_STARVATION_TELEMETRY', {
                            guildId,
                            nodeId,
                            trackTitle: track.info?.title,
                            trackIdentifier: trackId,
                            position,
                            detail,
                            level: 'debug'
                        });
                    }
                }
            }
        }
    }

    clearGuild(guildId) {
        this.monitoredPlayers.delete(guildId);
    }

    /**
     * Periodic watchdog scan for stalled playback positions across all monitored guilds
     */
    async checkPlayersForStalls() {
        if (!this.client?.lavalink) return;
        const now = Date.now();

        for (const [guildId, state] of this.monitoredPlayers.entries()) {
            const player = this.client.lavalink.getPlayer(guildId);
            if (!player) continue;

            const currentTrack = player.queue?.current;
            if (player.node && player.node.stats && (!this.latestNodeStats.has(player.node.id) || (now - this.latestNodeStats.get(player.node.id).timestamp > 30000))) {
                this.onNodeStats(player.node, player.node.stats);
            }

            // 1. Check Lavalink player voice connection state
            const guild = this.client?.guilds?.cache?.get(guildId);
            const isDiscordVoiceConnected = Boolean(guild?.members?.me?.voice?.channelId);

            if (player.connected === false) {
                if (isDiscordVoiceConnected && player.playing && !player.paused && currentTrack) {
                    state.voiceDisconnectedChecks = (state.voiceDisconnectedChecks || 0) + 1;
                    // First 3 checks (~9s): soft re-dispatch credentials to Lavalink
                    // Check 4+: force fresh gateway handshake via player.connect()
                    const forceReconnect = state.voiceDisconnectedChecks >= 4;
                    this.autoHealVoiceConnection(player, { forceGatewayReconnect: forceReconnect }).catch(() => {});

                    // If voice disconnection persists for >= 8 watchdog cycles (~24s), recover playback
                    if (state.voiceDisconnectedChecks >= 8) {
                        state.voiceDisconnectedChecks = 0;
                        await this.recoverPlayback(player, currentTrack, {
                            reason: 'voiceGatewayDisconnected',
                            detail: 'Lavalink player lost Discord voice gateway connection'
                        });
                    }
                } else {
                    state.lastProgressTimestamp = now;
                    state.stalledChecks = 0;
                }
                continue;
            } else {
                state.voiceDisconnectedChecks = 0;
            }

            // Must be actively playing and not paused, with healthy node
            if (!player.playing || player.paused || !currentTrack || !player.node?.connected) {
                if (!player.node?.connected) {
                    state.lastProgressTimestamp = now;
                    state.stalledChecks = 0;
                }
                continue;
            }

            // 2. Ignore livestreams without known duration
            if (currentTrack.info?.isStream || currentTrack.info?.duration === 0) {
                continue;
            }

            // 3. Grace period for initial track startup / buffering (6s)
            if (now - state.trackStartTime < INITIAL_GRACE_PERIOD_MS) {
                continue;
            }

            // If recovery is pending verification, check if deadline exceeded without progress
            if (state.recoveryPending && !state.recoveryPending.verified) {
                const timeSinceRecovery = now - state.recoveryPending.initiatedAt;
                if (timeSinceRecovery > state.recoveryPending.verificationDeadlineMs) {
                    const pending = state.recoveryPending;
                    state.recoveryPending = null;

                    this.logDiagnostic('RECOVERY_FAILED', {
                        guildId,
                        nodeId: player.node?.id || 'unknown',
                        trackTitle: pending.trackTitle,
                        trackIdentifier: pending.trackIdentifier,
                        position: player.position || 0,
                        duration: currentTrack.info?.duration || 0,
                        detail: `Playback position remained frozen after ${Math.round(timeSinceRecovery / 1000)}s verification window`,
                        level: 'warn'
                    });

                    // Trigger next recovery attempt or skip if retries exhausted
                    await this.recoverPlayback(player, currentTrack, {
                        reason: 'recoveryVerificationFailed',
                        detail: 'Position failed to advance during recovery verification window'
                    });
                }
                continue;
            }

            const elapsedSinceProgress = now - state.lastProgressTimestamp;

            // 4. Stalled condition: zero progress for >= STALL_THRESHOLD_MS (18s)
            if (elapsedSinceProgress >= STALL_THRESHOLD_MS) {
                state.stalledChecks++;

                // Trigger recovery on confirmed stall (at least 2 consecutive checks with verified zero position change)
                if (state.stalledChecks >= 2) {
                    // Check if player position actually advanced right now before triggering recovery
                    const freshPlayer = this.client?.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;
                    const freshPos = Number(freshPlayer?.lastPosition ?? freshPlayer?.position ?? 0);
                    if (freshPlayer && freshPos > Number(state.lastPosition || 0) + 200) {
                        state.lastPosition = freshPos;
                        state.lastProgressTimestamp = now;
                        state.stalledChecks = 0;
                        continue;
                    }

                    this.logDiagnostic('TRACK_STALLED', {
                        guildId,
                        nodeId: player.node?.id || 'unknown',
                        trackTitle: currentTrack.info?.title,
                        trackIdentifier: currentTrack.info?.identifier,
                        position: player.position || 0,
                        duration: currentTrack.info?.duration || 0,
                        elapsedSinceUpdate: elapsedSinceProgress,
                        detail: `Zero progress for ${Math.round(elapsedSinceProgress / 1000)}s while playing: true`,
                        level: 'warn'
                    });

                    // Trigger recovery
                    await this.recoverPlayback(player, currentTrack, {
                        reason: 'stalledPosition',
                        detail: `Audio stalled for ${Math.round(elapsedSinceProgress / 1000)}s`
                    });
                }
            } else {
                state.stalledChecks = 0;
            }
        }
    }

    /**
     * Safely advances playback when a track fails or is interrupted:
     * If queue has remaining tracks, skips to the next track.
     * If queue is empty and autoplay is enabled, seamlessly triggers Autoplay so music never stops.
     * Only enters stopped state if autoplay is disabled or exhausted.
     */
    async advanceOrAutoplay(player, track) {
        if (!player || !player.guildId) return false;
        const guildId = player.guildId;

        if (player.queue?.tracks?.length > 0) {
            logger.info(`[AUDIO-DIAG] Skipping failed track to next queued track for guild ${guildId}`);
            await player.skip().catch(() => {});
            return true;
        }

        const isAutoplay = Boolean(
            typeof this.client?.autoplayEnabled?.get === 'function'
                ? this.client.autoplayEnabled.get(guildId)
                : (this.client?.guildSettings?.isAutoplay ? this.client.guildSettings.isAutoplay(guildId) : false)
        );

        if (isAutoplay) {
            try {
                const { handleAutoplay } = require('./autoplay');
                const seed = track || player.queue?.current || (typeof player.getData === 'function' ? player.getData('lastPlayedTrack') : null);
                logger.info(`[AUDIO-DIAG] Queue empty after track failure in guild ${guildId}; triggering autoplay recovery with seed "${seed?.info?.title || 'unknown'}"`);
                const started = await handleAutoplay(this.client, player, 'recovery_skip', seed).catch((err) => {
                    logger.warn('[AUDIO-DIAG] handleAutoplay error during recovery skip:', err?.message || err);
                    return false;
                });
                if (started || player.playing || (player.queue?.tracks?.length > 0)) {
                    return true;
                }

                // If seed-based discovery didn't find anything, perform emergency fallback search so playback never dies
                if (typeof player.search === 'function') {
                    const fallbackRes = await player.search({ query: 'sinhala songs hits', source: 'ytsearch' }).catch(() => null);
                    if (fallbackRes?.tracks?.length > 0) {
                        const fallbackTrack = fallbackRes.tracks[0];
                        fallbackTrack.userData = { ...(fallbackTrack.userData || {}), autoplay: true };
                        await player.queue.add(fallbackTrack);
                        await player.skip().catch(() => player.play().catch(() => {}));
                        return true;
                    }
                }
            } catch (apErr) {
                logger.debug('[AUDIO-DIAG] Error attempting autoplay after track skip:', apErr?.message || apErr);
            }
        }

        // If autoplay is NOT active, gracefully enter stopped state
        if (!isAutoplay) {
            await player.stopPlaying().catch(() => {});
            if (this.client?.playerController?.showStoppedState) {
                this.client.playerController.showStoppedState(guildId);
            }
        }
        return false;
    }

    /**
     * Bounded, deduplicated playback recovery engine.
     * Prevents overlapping recovery operations and recursive loops.
     */
    async recoverPlayback(player, track, options = {}) {
        if (!player || !player.guildId) return false;
        const guildId = player.guildId;
        const state = this.getOrCreateState(guildId);

        // Deduplication: prevent overlapping recovery runs on the same guild
        if (state.recovering) {
            logger.debug(`[AUDIO-DIAG] Recovery already in progress for guild ${guildId}, skipping overlapping trigger`);
            return false;
        }

        // Avoid competing with active Autoplay resolution
        const { isAutoplayInProgress } = require('./autoplay');
        if (isAutoplayInProgress(guildId)) {
            logger.debug(`[AUDIO-DIAG] Autoplay in progress for guild ${guildId}, skipping competing recovery`);
            return false;
        }

        // Do not recover if player has been intentionally stopped
        if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) {
            return false;
        }

        // Verify track identity: player must still be on the same track
        const currentTrack = player.queue?.current;
        const targetId = track?.info?.identifier || track?.identifier;
        if (!currentTrack || (targetId && currentTrack.info?.identifier !== targetId)) {
            logger.info(`[AUDIO-DIAG] Recovery cancelled for guild ${guildId}: track already changed or finished`);
            return false;
        }

        state.recovering = true;

        try {
            const trackId = targetId || 'current-track';
            const retries = state.trackRetries.get(trackId) || 0;

            // If max retries exceeded for this track, advance cleanly to prevent infinite loops
            if (retries >= MAX_TRACK_RETRIES) {
                this.logDiagnostic('RECOVERY_EXHAUSTED', {
                    guildId,
                    nodeId: player.node?.id || 'unknown',
                    trackTitle: track?.info?.title,
                    trackIdentifier: trackId,
                    position: player.position || 0,
                    duration: track?.info?.duration || 0,
                    detail: `Exhausted ${MAX_TRACK_RETRIES} recovery attempts`,
                    action: 'skipping to next queued track',
                    level: 'error'
                });

                state.trackRetries.delete(trackId);

                // Notify channel politely
                if (typeof this.client?.playerController?.sendToPlayerChannel === 'function') {
                    await this.client.playerController.sendToPlayerChannel(
                        guildId,
                        `⚠️ Audio playback for **${track?.info?.title || 'this track'}** was interrupted and could not be recovered. Skipping to the next track.`
                    ).catch(() => {});
                }

                await this.advanceOrAutoplay(player, track);

                return false;
            }

            // Record retry attempt
            state.trackRetries.set(trackId, retries + 1);
            if (options.isSourceError) {
                state.lastSourceFailure = {
                    timestamp: Date.now(),
                    trackId: trackId,
                    detail: options.detail || 'Source requires login or has no supported audio streams'
                };
            }

            this.logDiagnostic('RECOVERY_ATTEMPT', {
                guildId,
                nodeId: player.node?.id || 'unknown',
                trackTitle: track?.info?.title,
                trackIdentifier: trackId,
                position: player.position || 0,
                duration: track?.info?.duration || 0,
                detail: `Attempt ${retries + 1}/${MAX_TRACK_RETRIES} (reason: ${options.reason || 'unknown'})`,
                level: 'warn'
            });

            // Step 1: In public node mode, migrate to a healthy node if the node is experiencing
            // a stall, disconnection, track execution failure, or repeated source errors.
            let migrated = false;
            const shouldAttemptNodeMigration = (
                options.reason === 'trackError' ||
                options.reason === 'trackStuck' ||
                options.reason === 'stalledPosition' ||
                options.reason === 'nodeDisconnected' ||
                !player.node?.connected ||
                (options.isSourceError && retries >= 1)
            );

            if (shouldAttemptNodeMigration && this.client?.lavalinkMode === 'public' && this.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode) {
                migrated = await this.client.lavalinkConnectionManager.migratePlayerToHealthyNode(player, options.reason || 'audio-stall').catch(() => false);
                if (migrated) {
                    this.logDiagnostic('NODE_MIGRATED', {
                        guildId,
                        nodeId: player.node?.id || 'unknown',
                        trackTitle: track?.info?.title,
                        trackIdentifier: trackId,
                        position: player.position || 0,
                        action: 'migrated player to healthy node and resumed stream',
                    });
                } else {
                    this.logDiagnostic('NODE_MIGRATION_FAILED', {
                        guildId,
                        nodeId: player.node?.id || 'unknown',
                        trackTitle: track?.info?.title,
                        trackIdentifier: trackId,
                        position: player.position || 0,
                        detail: 'No compatible replacement node connected; attempting stream recovery',
                        level: 'warn'
                    });
                }
            }

            // Step 2: If not migrated, recover the track stream on current node
            if (!migrated) {
                if (!player.node || player.node.connected === false) {
                    this.logDiagnostic('RECOVERY_FAILED', {
                        guildId,
                        nodeId: player.node?.id || 'unknown',
                        trackTitle: track?.info?.title,
                        trackIdentifier: trackId,
                        detail: 'Node is disconnected and no replacement candidate connected',
                        level: 'error'
                    });
                    return false;
                }

                let trackToPlay = track;

                // If source error has already failed once, skip immediately without looping
                if (options.isSourceError && retries >= 1) {
                    this.logDiagnostic('SOURCE_UNAVAILABLE', {
                        guildId,
                        nodeId: player.node?.id || 'unknown',
                        trackTitle: track?.info?.title,
                        trackIdentifier: trackId,
                        detail: options.detail || 'Source requires login or has no supported audio streams; retry limit reached',
                        level: 'warn'
                    });

                    if (typeof this.client?.playerController?.sendToPlayerChannel === 'function') {
                        await this.client.playerController.sendToPlayerChannel(
                            guildId,
                            `⚠️ Audio stream for **${track?.info?.title || 'this track'}** cannot be played (${options.detail || 'requires login or unavailable on YouTube'}). Skipping to next track.`
                        ).catch(() => {});
                    }

                    await this.advanceOrAutoplay(player, track);
                    return true;
                }

                // If source-level failure or stall, attempt to find an alternative working audio stream
                if (options.isSourceError || options.reason === 'trackError' || options.reason === 'stalledPosition' || options.reason === 'recoveryVerificationFailed') {
                    const altTrack = await resolveAlternativeTrack(player, track).catch(() => null);
                    if (altTrack) {
                        trackToPlay = altTrack;
                        player.queue.current = altTrack;
                        this.logDiagnostic('STREAM_RESOLVED', {
                            guildId,
                            nodeId: player.node?.id || 'unknown',
                            trackTitle: altTrack.info?.title,
                            trackIdentifier: altTrack.info?.identifier,
                            action: 'resolved fresh alternative audio stream',
                        });
                    } else if (options.isSourceError) {
                        this.logDiagnostic('SOURCE_UNAVAILABLE', {
                            guildId,
                            nodeId: player.node?.id || 'unknown',
                            trackTitle: track?.info?.title,
                            trackIdentifier: trackId,
                            detail: options.detail || 'Source requires login or has no supported audio streams; no alternative found',
                            level: 'warn'
                        });

                        if (typeof this.client?.playerController?.sendToPlayerChannel === 'function') {
                            await this.client.playerController.sendToPlayerChannel(
                                guildId,
                                `⚠️ Audio stream for **${track?.info?.title || 'this track'}** cannot be played (requires login or unavailable on YouTube). Skipping to next track.`
                            ).catch(() => {});
                        }

                        await this.advanceOrAutoplay(player, track);
                        return true;
                    }
                }

                if (player.queue?.current && targetId && player.queue.current.info?.identifier !== targetId && (!trackToPlay || player.queue.current.info?.identifier !== trackToPlay.info?.identifier)) {
                    logger.info(`[AUDIO-DIAG] Aborting playback start: current track changed during resolution for guild ${guildId}`);
                    return false;
                }

                if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) {
                    logger.info(`[AUDIO-DIAG] Aborting playback restart: player was intentionally stopped during recovery for guild ${guildId}`);
                    return false;
                }

                let resumePosition = 0;
                const isSameTrack = Boolean(
                    trackToPlay?.info?.identifier &&
                    track?.info?.identifier &&
                    trackToPlay.info.identifier === track.info.identifier
                );
                if (isSameTrack && !trackToPlay.info?.isStream && trackToPlay.info?.duration > 0) {
                    const rawPos = Math.max(0, state.lastPosition, Number(player.position || 0));
                    if (rawPos < trackToPlay.info.duration - 2000) {
                        resumePosition = rawPos;
                    }
                }

                await player.play({
                    clientTrack: trackToPlay,
                    position: resumePosition > 0 ? resumePosition : 0
                });
            }

            // Step 3: Establish bounded verification window - do NOT log RECOVERY_SUCCEEDED yet!
            const targetResume = (!track?.info?.isStream && track?.info?.duration > 0)
                ? Math.min(Math.max(0, state.lastPosition, Number(player.position || 0)), track.info.duration - 2000)
                : 0;

            state.lastPosition = targetResume;
            state.recoveryPending = {
                trackIdentifier: trackId,
                trackTitle: track?.info?.title,
                targetResumePosition: targetResume,
                firstObservedPosition: null,
                initiatedAt: Date.now(),
                verificationDeadlineMs: 18000,
                verified: false,
            };
            state.lastProgressTimestamp = Date.now();
            state.trackStartTime = Date.now();
            state.stalledChecks = 0;

            this.logDiagnostic('RECOVERY_PENDING', {
                guildId,
                nodeId: player.node?.id || 'unknown',
                trackTitle: track?.info?.title,
                trackIdentifier: trackId,
                position: player.position || 0,
                duration: track?.info?.duration || 0,
                action: 'verifying audio playback progression before confirming recovery',
            });

            // Update persistent dashboard in place and voice channel status
            if (this.client?.voiceChannelStatusManager?.updateFromPlayer) {
                this.client.voiceChannelStatusManager.updateFromPlayer(player, player.queue?.current, 'playing').catch(() => {});
            }
            if (this.client?.playerController?.replaceWithFullDashboard) {
                this.client.playerController.replaceWithFullDashboard(guildId, player.textChannelId, { inPlace: true, reason: 'recovery' }).catch(() => {});
            }

            return true;

        } catch (recoveryErr) {
            this.logDiagnostic('RECOVERY_FAILED', {
                guildId,
                nodeId: player.node?.id || 'unknown',
                trackTitle: track?.info?.title,
                trackIdentifier: track?.info?.identifier,
                detail: recoveryErr?.message || String(recoveryErr),
                level: 'error'
            });
            state.lastRecoveryResult = {
                timestamp: Date.now(),
                success: false,
                detail: recoveryErr?.message || String(recoveryErr)
            };
            return false;
        } finally {
            state.recovering = false;
        }
    }

    /**
     * Automatic live audio health classification
     */
    classifyHealth(player, state, guild) {
        const now = Date.now();

        // 1. Source failure in recent window (even if player stopped or queue empty)
        const recentSourceError = state.lastSourceFailure && (now - state.lastSourceFailure.timestamp < 30000);
        if (recentSourceError && (!player || !player.playing)) {
            return {
                status: 'SOURCE_FAILURE',
                detail: `Source stream failed to load: ${state.lastSourceFailure.detail || 'Upstream provider error'}`
            };
        }

        if (!player || (!player.queue?.current && !player.playing)) {
            return {
                status: 'IDLE',
                detail: 'No track is currently playing or queued in this server.'
            };
        }

        const isDiscordVoiceConnected = Boolean(guild?.members?.me?.voice?.channelId);
        const isLavalinkVoiceConnected = player.connected === true || (typeof player.connected === 'undefined' && Boolean(player.node?.connected));
        const inStartupGrace = (now - state.trackStartTime < 4000);

        // 2. Voice connection status
        if (!isDiscordVoiceConnected) {
            return {
                status: 'VOICE_DISCONNECTED',
                detail: 'Bot is not connected to a Discord voice channel.'
            };
        }

        if (!isLavalinkVoiceConnected) {
            if (inStartupGrace) {
                return {
                    status: 'VOICE_CONNECTION_PENDING',
                    detail: 'Establishing secure Discord voice gateway connection...'
                };
            }
            return {
                status: 'VOICE_DISCONNECTED',
                detail: 'Lavalink player is not connected to the Discord voice gateway (ping: -1ms, connected: false).'
            };
        }

        // 3. Node unhealthy
        if (!player.node || !player.node.connected) {
            return {
                status: 'NODE_UNHEALTHY',
                detail: `Lavalink audio node (${player.node?.id || 'unknown'}) is disconnected or unavailable.`
            };
        }

        // 4. Recovery or node migration active
        const isMigrating = Boolean(
            this.client?.lavalinkConnectionManager?.isPlayerMigrating?.(player.guildId) ||
            player.isChangingNode ||
            (typeof player.getData === 'function' && player.getData("internal_nodeChanging"))
        );
        if (state.recovering || Boolean(state.recoveryPending) || isMigrating) {
            return {
                status: 'RECOVERING',
                detail: isMigrating 
                    ? 'Player is migrating to an alternate Lavalink node.'
                    : 'Bounded audio playback recovery is currently in progress.'
            };
        }

        // 5. Source failure check (if stream error / login required was logged recently)
        const targetTrackId = player?.queue?.current?.info?.identifier;
        if (state.lastSourceFailure && (now - state.lastSourceFailure.timestamp < 30000) && (!targetTrackId || state.lastSourceFailure.trackId === targetTrackId)) {
            return {
                status: 'SOURCE_FAILURE',
                detail: state.lastSourceFailure.detail || 'Source stream failed or requires login.'
            };
        }

        // 6. Paused (paused is healthy, not stalled)
        if (player.paused) {
            return {
                status: 'HEALTHY',
                detail: 'Playback is paused by user request.'
            };
        }

        // 6. Position stalled
        const elapsedSinceProgress = now - state.lastProgressTimestamp;
        const initialGracePeriod = (now - state.trackStartTime < INITIAL_GRACE_PERIOD_MS);
        if (player.playing && !initialGracePeriod && elapsedSinceProgress >= STALL_THRESHOLD_MS && state.stalledChecks >= 1) {
            return {
                status: 'POSITION_STALLED',
                detail: `Playback position has not progressed for ${Math.round(elapsedSinceProgress / 1000)}s while player reports playing: true.`
            };
        }

        // 7. Healthy
        if (player.playing && (elapsedSinceProgress < STALL_THRESHOLD_MS || initialGracePeriod)) {
            return {
                status: 'HEALTHY',
                detail: initialGracePeriod 
                    ? 'Track buffering and starting playback normally.'
                    : 'Connection is valid and playback position is progressing.'
            };
        }

        return {
            status: 'UNKNOWN',
            detail: 'Insufficient telemetry to conclusively determine playback health.'
        };
    }

    /**
     * Root-cause correlation engine
     */
    diagnoseRootCause(player, state, guild, health) {
        const confirmedCauses = [];
        const possibleCauses = [];
        const now = Date.now();

        // 1. Source failure check
        if (state.lastSourceFailure && (now - state.lastSourceFailure.timestamp < 60000)) {
            confirmedCauses.push(
                `Source stream error from provider: "${state.lastSourceFailure.detail}". Upstream rejected or blocked the stream.`
            );
        }

        // 2. Voice socket closure check
        if (state.lastSocketClose && (now - state.lastSocketClose.timestamp < 60000)) {
            const code = state.lastSocketClose.code;
            const reason = state.lastSocketClose.reason;
            if ([4015, 1006, 4006].includes(code)) {
                confirmedCauses.push(
                    `Discord voice socket disconnected (Code ${code}: ${reason}). The Discord voice server crashed or invalidated the session.`
                );
            } else {
                possibleCauses.push(
                    `Recent voice socket closed (Code ${code}: ${reason}).`
                );
            }
        }

        // 3. Node connectivity check
        if (player?.node && !player.node.connected) {
            confirmedCauses.push(
                `Lavalink node "${player.node.id}" is disconnected. Audio gateway link between bot and audio daemon is down.`
            );
        } else if (player?.node?.heartBeatPing != null && player.node.heartBeatPing > 500) {
            possibleCauses.push(
                `High Lavalink node ping (${player.node.heartBeatPing}ms) may cause network buffering or audio stutter.`
            );
        }

        // 4. Lavalink Frame Stats check (sent, nulled, deficit)
        if (player?.node?.stats?.frameStats) {
            const { sent = 0, nulled = 0, deficit = 0 } = player.node.stats.frameStats;
            if (nulled > 0 && sent > 0 && (nulled / (sent + nulled)) > 0.05) {
                possibleCauses.push(
                    `Lavalink frame buffer starvation observed (${nulled} silence/null frames inserted). Decoder or stream could not produce audio frames in real time.`
                );
            }
            if (deficit < -100) {
                possibleCauses.push(
                    `Lavalink frame timing deficit observed (${deficit} frames behind schedule). Node process load or network latency is delaying audio output.`
                );
            }
        }

        // 5. Position stall check
        const elapsedSinceProgress = now - state.lastProgressTimestamp;
        if (player?.playing && !player.paused && elapsedSinceProgress >= STALL_THRESHOLD_MS && state.stalledChecks >= 1) {
            confirmedCauses.push(
                `Server-reported position frozen for ${Math.round(elapsedSinceProgress / 1000)}s despite player reporting playing = true. The audio stream decoder stopped delivering packets.`
            );
        }

        // 6. High Event Loop Lag check
        if (this.client?.performanceMonitor) {
            const perf = this.client.performanceMonitor.getMetricsSummary();
            if (perf.eventLoop?.recentMaxLagMs > 250 || perf.eventLoop?.lagP95Ms > 200) {
                possibleCauses.push(
                    `Host process event-loop delay is elevated (p95: ${perf.eventLoop?.lagP95Ms}ms, max: ${perf.eventLoop?.recentMaxLagMs}ms), which can delay Discord websocket acknowledgements.`
                );
            }
        }

        // 7. Track replaced or stopped check
        if (state.lastTrackEnd && (now - state.lastTrackEnd.timestamp < 30000)) {
            if (['replaced', 'stopped'].includes(state.lastTrackEnd.reason)) {
                confirmedCauses.push(
                    `Track ended due to deliberate "${state.lastTrackEnd.reason}" action (skip, stop, or new track requested).`
                );
            }
        }

        // Summary and actionable advice
        let summary = '';
        let actionableAdvice = '';

        if (confirmedCauses.length > 0) {
            summary = `Confirmed interruption cause: ${confirmedCauses[0]}`;
            if (confirmedCauses[0].includes('Source stream error')) {
                actionableAdvice = 'Try searching for an alternative title/artist or use Spotify/SoundCloud link instead of restricted YouTube URLs.';
            } else if (confirmedCauses[0].includes('voice socket disconnected')) {
                actionableAdvice = 'Discord voice server reconnection was initiated. If persistent, change the voice channel region in Discord channel settings.';
            } else if (confirmedCauses[0].includes('Lavalink node')) {
                actionableAdvice = 'Verify Lavalink node server connectivity or configure a backup node in config.';
            } else if (confirmedCauses[0].includes('frozen')) {
                actionableAdvice = 'Automatic watchdog recovery will resolve an alternative stream or skip if stream remains stalled.';
            } else {
                actionableAdvice = 'No action required; playback changed according to user command.';
            }
        } else if (possibleCauses.length > 0) {
            summary = `No fatal error confirmed; potential contributing factors: ${possibleCauses[0]}`;
            actionableAdvice = 'Monitor node ping and host process load. Playback is currently operating normally.';
        } else {
            summary = health.status === 'HEALTHY' 
                ? 'Continuous, uninterrupted playback verified. Audio delivery and telemetry are optimal.'
                : (health.status === 'IDLE' ? 'Player is idle. Ready to play tracks.' : health.detail);
            actionableAdvice = health.status === 'HEALTHY' 
                ? 'Everything is running smoothly.' 
                : 'Use /play to start music.';
        }

        return {
            confirmedCauses,
            possibleCauses,
            summary,
            actionableAdvice,
        };
    }

    /**
     * Comprehensive Guild Health Telemetry Report
     */
    getGuildHealth(guildId) {
        const state = this.monitoredPlayers.get(guildId) || this.getOrCreateState(guildId);
        const player = this.client?.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;
        const guild = this.client?.guilds?.cache?.get ? this.client.guilds.cache.get(guildId) : null;
        const now = Date.now();

        // 1. Resolve Voice Information
        const botMember = guild?.members?.me;
        const botVoice = botMember?.voice;
        const channelId = botVoice?.channelId || null;
        const voiceChannel = channelId && guild?.channels?.cache?.get(channelId);
        const expectedVoiceChannelId = player?.voiceChannelId || (typeof this.client?.guildSettings?.get247 === 'function' ? this.client.guildSettings.get247(guildId)?.channelId : null) || null;
        const channelSynchronized = Boolean(channelId && (!expectedVoiceChannelId || expectedVoiceChannelId === channelId));
        const hasDiscordVoiceSession = Boolean(botVoice?.sessionId);
        const lavalinkVoiceConnected = Boolean(player && player.connected !== false);
        const reconnectPending = Boolean(state.reconnectingVoice || (player && player.connected === false && channelId));
        const discordPing = this.client?.ws?.ping != null && this.client.ws.ping !== -1 ? `${Math.round(this.client.ws.ping)}ms` : 'Unavailable';

        // 2. Resolve Player State
        const currentTrack = player?.queue?.current || null;
        const trackAssigned = Boolean(currentTrack);
        let playerState = 'IDLE';
        if (player) {
            if (player.paused) {
                playerState = 'PAUSED';
            } else if (player.playing && trackAssigned) {
                playerState = 'PLAYING';
            } else if (trackAssigned) {
                playerState = 'STOPPED';
            }
        }

        const currentPos = Number(player?.lastPosition ?? player?.position ?? state.lastPosition ?? 0);
        const trackDuration = Number(currentTrack?.info?.duration || 0);
        const elapsedSinceProgress = now - (state.lastProgressTimestamp || now);
        const elapsedSinceLastUpdate = state.lastPositionUpdateTimestamp ? (now - state.lastPositionUpdateTimestamp) : null;
        const initialGracePeriod = (now - (state.trackStartTime || now) < INITIAL_GRACE_PERIOD_MS);

        const isProgressing = Boolean(
            player?.playing &&
            !player.paused &&
            trackAssigned &&
            (elapsedSinceProgress < STALL_THRESHOLD_MS || initialGracePeriod) &&
            ((state.consecutiveProgressCount || 0) > 0 || initialGracePeriod)
        );

        const isMigrating = Boolean(
            this.client?.lavalinkConnectionManager?.isPlayerMigrating?.(guildId) ||
            player?.isChangingNode ||
            (typeof player?.getData === 'function' && player.getData("internal_nodeChanging"))
        );

        const currentTrackId = currentTrack?.info?.identifier;
        const retryCount = currentTrackId ? (state.trackRetries?.get(currentTrackId) || 0) : 0;

        // 3. Resolve Lavalink Node Information
        const node = player?.node || (this.client?.lavalink?.nodeManager?.nodes?.values ? this.client.lavalink.nodeManager.nodes.values().next()?.value : null);
        const nodeId = node?.id || node?.options?.id || 'Unavailable';
        const nodeConnected = Boolean(node?.connected);
        const nodeStatus = node?.connectionStatus || (nodeConnected ? 'connected' : 'disconnected');
        const nodeVersion = node?.info?.version || node?.version || 'Unavailable';
        const isNodeCompatible = Boolean(nodeConnected && (String(node?.version || '').startsWith('4') || String(node?.info?.version || '').startsWith('4') || !String(nodeVersion).startsWith('3')));
        const nodePing = (node?.heartBeatPing != null && !isNaN(node.heartBeatPing)) ? `${Math.round(node.heartBeatPing)}ms` : (node?.ping != null ? `${Math.round(node.ping)}ms` : 'Unavailable');
        const nodeUptime = node?.stats?.uptime ? formatUptime(node.stats.uptime) : 'Unavailable';

        const cpuStats = node?.stats?.cpu;
        const lavalinkCpuLoad = cpuStats?.lavalinkLoad != null ? `${(cpuStats.lavalinkLoad * 100).toFixed(1)}%` : 'Unavailable';
        const systemCpuLoad = cpuStats?.systemLoad != null ? `${(cpuStats.systemLoad * 100).toFixed(1)}%` : 'Unavailable';

        const memStats = node?.stats?.memory;
        const memUsed = memStats?.used != null ? `${(memStats.used / 1024 / 1024).toFixed(1)} MB` : 'Unavailable';
        const memAllocated = memStats?.allocated != null ? `${(memStats.allocated / 1024 / 1024).toFixed(1)} MB` : 'Unavailable';
        const memFree = memStats?.free != null ? `${(memStats.free / 1024 / 1024).toFixed(1)} MB` : 'Unavailable';

        // Official Lavalink frame statistics payload interpretation (sent, nulled, deficit)
        const frameStatsObj = node?.stats?.frameStats;
        let frameStatsInterpretation = 'Unavailable (node does not report frame telemetry)';
        let frameStatsData = null;
        if (frameStatsObj && (frameStatsObj.sent != null || frameStatsObj.nulled != null || frameStatsObj.deficit != null)) {
            const sent = Number(frameStatsObj.sent || 0);
            const nulled = Number(frameStatsObj.nulled || 0);
            const deficit = Number(frameStatsObj.deficit || 0);
            frameStatsData = { sent, nulled, deficit };
            frameStatsInterpretation = `${sent} sent, ${nulled} nulled (silence buffer), ${deficit} deficit`;
        }

        // 4. Resolve Queue and Event History
        const queueTracks = player?.queue?.tracks || [];
        const queueLength = queueTracks.length;
        const nextTrackTitle = queueTracks[0]?.info?.title || null;
        const autoplayState = Boolean(typeof this.client?.autoplayEnabled?.get === 'function' ? this.client.autoplayEnabled.get(guildId) : false);
        const repeatMode = player?.repeatMode || 'off';

        // 5. Resolve Hosting & Runtime Telemetry
        const processUptime = formatUptime(process.uptime() * 1000);
        const nodeProcessVersion = process.version;
        const processMem = process.memoryUsage();
        const rssMb = `${(processMem.rss / 1024 / 1024).toFixed(1)} MB`;
        const heapUsedMb = `${(processMem.heapUsed / 1024 / 1024).toFixed(1)} MB`;
        const heapTotalMb = `${(processMem.heapTotal / 1024 / 1024).toFixed(1)} MB`;

        const perfSummary = typeof this.client?.performanceMonitor?.getMetricsSummary === 'function'
            ? this.client.performanceMonitor.getMetricsSummary()
            : null;

        const eventLoopLagMean = perfSummary?.eventLoop?.lagMeanMs != null ? `${perfSummary.eventLoop.lagMeanMs}ms` : 'Unavailable';
        const eventLoopLagP95 = perfSummary?.eventLoop?.lagP95Ms != null ? `${perfSummary.eventLoop.lagP95Ms}ms` : 'Unavailable';
        const eventLoopLagMax = perfSummary?.eventLoop?.lagMaxMs != null ? `${perfSummary.eventLoop.lagMaxMs}ms` : 'Unavailable';
        const interactionCount = perfSummary?.interactions?.total ?? 0;
        const interactionAvgMs = perfSummary?.interactions?.avgDurationMs ?? 0;
        const interactionTimeouts = perfSummary?.interactions?.timeouts ?? 0;
        const searchAvgMs = perfSummary?.searches?.avgDurationMs ?? 0;
        const searchCacheHitPct = perfSummary?.searches?.cacheHitRatePct ?? 0;

        // 6. Audio Health Classification
        const healthClassification = this.classifyHealth(player, state, guild);

        // 7. Root Cause Determination
        const rootCause = this.diagnoseRootCause(player, state, guild, healthClassification);

        return {
            guildId,
            status: healthClassification.status,
            statusDetail: healthClassification.detail,
            diagnosis: rootCause,
            player: {
                exists: Boolean(player),
                state: playerState,
                connected: lavalinkVoiceConnected,
                playing: Boolean(player?.playing),
                paused: Boolean(player?.paused),
                trackAssigned,
                trackTitle: currentTrack?.info?.title || 'None',
                trackAuthor: currentTrack?.info?.author || 'Unknown',
                trackDuration,
                trackDurationFormatted: formatDuration(trackDuration),
                trackIdentifier: currentTrack?.info?.identifier || 'none',
                trackUri: currentTrack?.info?.uri || null,
                trackSource: currentTrack?.info?.sourceName || (currentTrack?.info?.uri?.includes('youtube') ? 'youtube' : 'unknown'),
                positionMs: currentPos,
                positionFormatted: formatDuration(currentPos),
                isProgressing,
                consecutiveProgressCount: state.consecutiveProgressCount || 0,
                elapsedSinceProgressMs: elapsedSinceProgress,
                elapsedSinceLastUpdateMs: elapsedSinceLastUpdate,
                volume: player?.volume ?? 100,
                queueLength,
                nextTrackTitle,
                autoplay: autoplayState,
                repeatMode,
                recovering: Boolean(state.recovering || state.recoveryPending),
                migrating: isMigrating,
                currentTrackRetries: retryCount,
                lastRecoveryResult: state.lastRecoveryResult || null,
            },
            node: {
                id: nodeId,
                connected: nodeConnected,
                connectionStatus: nodeStatus,
                version: nodeVersion,
                isCompatible: isNodeCompatible,
                pingMs: nodePing,
                uptimeMs: node?.stats?.uptime || null,
                uptimeFormatted: nodeUptime,
                cpu: {
                    lavalinkLoad: lavalinkCpuLoad,
                    systemLoad: systemCpuLoad,
                },
                memory: {
                    used: memUsed,
                    allocated: memAllocated,
                    free: memFree,
                },
                frameStats: {
                    data: frameStatsData,
                    interpretation: frameStatsInterpretation,
                },
            },
            voice: {
                botConnected: Boolean(channelId),
                expectedChannelId: expectedVoiceChannelId,
                connectedChannelId: channelId,
                channelName: voiceChannel?.name || (channelId ? `<#${channelId}>` : 'Unavailable'),
                channelSynchronized,
                hasDiscordVoiceSession,
                lavalinkGatewayConnected: lavalinkVoiceConnected,
                reconnectPending,
                lastSocketClose: state.lastSocketClose ? {
                    code: state.lastSocketClose.code,
                    reason: state.lastSocketClose.reason,
                    timeAgo: formatTimeAgo(state.lastSocketClose.timestamp)
                } : null,
                discordPing,
                hasCredentialsExposed: false,
            },
            queueAndEvents: {
                queueLength,
                nextTrack: nextTrackTitle,
                lastTrackEndReason: state.lastTrackEnd?.reason || 'none',
                recentSourceFailuresCount: (state.recentErrors || []).filter(e => e.isSourceError || e.event === 'SOURCE_UNAVAILABLE').length,
                recentErrors: (state.recentErrors || []).slice(-5),
                recentEvents: (state.recentEvents || []).slice(-8),
            },
            hosting: {
                uptime: processUptime,
                nodeVersion: nodeProcessVersion,
                rss: rssMb,
                heapUsed: heapUsedMb,
                heapTotal: heapTotalMb,
                eventLoop: {
                    meanMs: eventLoopLagMean,
                    p95Ms: eventLoopLagP95,
                    maxMs: eventLoopLagMax,
                },
                interactions: {
                    total: interactionCount,
                    avgDurationMs: interactionAvgMs,
                    timeouts: interactionTimeouts,
                },
                searches: {
                    avgDurationMs: searchAvgMs,
                    cacheHitRatePct: searchCacheHitPct,
                },
            },
        };
    }

    destroy() {
        this.stopWatchdog();
        this.monitoredPlayers.clear();
    }
}

module.exports = AudioPlaybackMonitor;
