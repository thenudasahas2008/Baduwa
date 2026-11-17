const { PermissionsBitField } = require('discord.js');
const logger = require('./logger');
const { validateAndFormatNodeOption, sanitizeError, safeDeleteNode, protectSocket, attachNodeProtection } = require('./lavalinkNodeOptions');
const { INTENDED_BOT_USERNAME } = require('./branding');

const CONNECTION_TIMEOUT_MS = 10000;
const JITTER_MS = 1000;
const RECONNECT_DELAY_ON_ERROR_MS = 3000;
const MONITORING_CHECK_INTERVAL_MS = 3000;
const MONITORING_FALLBACK_TIMEOUT_MS = 10000; // Trigger failover if no connection after 10s (not 2 mins)
const CRITICAL_TIMEOUT_MS = 180000;
const PERIODIC_RESET_INTERVAL_MS = 60 * 60 * 1000;
const PING_TIMEOUT_MS = 30 * 60 * 1000;

class LavalinkConnectionManager {
    constructor(client, createLavalinkManagerFn = null) {
        this.client = client;
        this.createLavalinkManagerFn = createLavalinkManagerFn;
        this.state = {
            reconnectAttempts: 0,
            maxReconnectAttempts: parseInt(process.env.LAVALINK_MAX_RECONNECT_ATTEMPTS || "15", 10),
            baseDelay: parseInt(process.env.LAVALINK_BASE_DELAY_MS || "1000", 10),
            maxDelay: parseInt(process.env.LAVALINK_MAX_DELAY_MS || "15000", 10),
            reconnectTimer: null,
            discoveryTimer: null,
            discoveryAttempts: 0,
            isDiscovering: false,
            healthCheckInterval: null,
            periodicResetInterval: null,
            lastPing: Date.now(),
            isReconnecting: false,
            cooldownUntil: 0,
            isInitialized: false,
            hasHadSuccessfulConnection: false
        };
        // Map<guildId, Promise<boolean>> - Tracks in-flight player migrations to prevent collisions
        this.activePlayerMigrations = new Map();
    }

    _getPlayer(guildId) {
        if (!this.client?.lavalink || !guildId) return null;
        if (typeof this.client.lavalink.getPlayer === 'function') {
            return this.client.lavalink.getPlayer(guildId);
        }
        if (this.client.lavalink.players?.get) {
            return this.client.lavalink.players.get(guildId);
        }
        return null;
    }

    // Check if a player is currently in the process of node migration
    isPlayerMigrating(guildId) {
        return Boolean(guildId && this.activePlayerMigrations?.has(guildId));
    }

    // Get the currently connected active node (prioritizing healthy, non-cooldown nodes)
    getActiveNode() {
        if (!this.client.lavalink?.nodeManager?.nodes) return null;
        const provider = this.client.publicNodeProvider;
        const now = Date.now();
        let fallbackNode = null;

        for (const node of this.client.lavalink.nodeManager.nodes.values()) {
            if (node && node.connected) {
                if (provider && provider.failedNodes) {
                    const host = String(node.options?.host || node.host || '').toLowerCase().trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
                    const port = node.options?.port || node.port;
                    const key = `${host}:${port}`;
                    const failure = provider.failedNodes.get(key);
                    const isCooling = failure && failure.cooldownUntil && failure.cooldownUntil > now;
                    if (!isCooling) {
                        return node;
                    }
                    if (!fallbackNode) fallbackNode = node;
                } else {
                    return node;
                }
            }
        }
        return fallbackNode || this.client.lavalink.nodeManager.nodes.get('main-node') || Array.from(this.client.lavalink.nodeManager.nodes.values())[0] || null;
    }

    // Check if Lavalink is available
    isAvailable() {
        const activeNode = this.getActiveNode();
        return Boolean(activeNode && activeNode.connected);
    }

    // Check if Lavalink manager is ready
    isManagerReady() {
        return Boolean(this.client.lavalink && this.client.lavalink.nodeManager);
    }

    // Exponential backoff delay calculation
    getReconnectDelay(attempt, isAllCooldown = false) {
        if (this.client.lavalinkMode === 'public') {
            if (isAllCooldown) {
                // When all public nodes are in cooldown, use controlled backoff (15s–60s)
                return Math.min(15000 * Math.pow(1.3, Math.min(attempt, 5)), 60000) + (Math.random() * 2000);
            }
            // For healthy public alternatives, rotate with controlled delay (2-8s)
            return Math.min(2000 + (attempt * 1000), 8000) + (Math.random() * 1000);
        }
        const delay = Math.min(this.state.baseDelay * Math.pow(2, attempt), this.state.maxDelay);
        return delay + (Math.random() * JITTER_MS);
    }

    // Health check function
    startHealthCheck() {
        if (this.state.healthCheckInterval) {
            clearInterval(this.state.healthCheckInterval);
        }

        const healthCheckInterval = parseInt(process.env.LAVALINK_HEALTH_CHECK_INTERVAL_MS || "30000", 10);
        let lastHealthStatus = true;

        this.state.healthCheckInterval = setInterval(() => {
            const isCurrentlyHealthy = this.isAvailable();

            if (!isCurrentlyHealthy) {
                logger.warn('Health check: Lavalink node not connected, attempting reconnection...');
                lastHealthStatus = false;
                this.attemptReconnection().catch((err) => {
                    logger.debug('Health check reconnection attempt failed:', err?.message || err);
                });
            } else {
                this.state.lastPing = Date.now();

                if (!lastHealthStatus) {
                    logger.debug('Health check: Lavalink node is healthy');
                    lastHealthStatus = true;
                }

                if (this.state.reconnectAttempts > 0) {
                    logger.info('Connection restored, resetting reconnection attempts');
                    this.state.reconnectAttempts = 0;
                }

                // Audit 24/7 voice presence: self-heal any dropped 24/7 voice connections
                try {
                    this.audit247Presence().catch((auditErr) => {
                        logger.debug('Error auditing 24/7 presence during health check:', auditErr?.message || auditErr);
                    });
                } catch (auditErr) {
                    logger.debug('Error auditing 24/7 presence during health check:', auditErr?.message || auditErr);
                }
            }
        }, healthCheckInterval);

        if (typeof this.state.healthCheckInterval.unref === 'function') {
            this.state.healthCheckInterval.unref();
        }
    }

    stopHealthCheck() {
        if (this.state.healthCheckInterval) {
            clearInterval(this.state.healthCheckInterval);
            this.state.healthCheckInterval = null;
        }
    }

    // Periodic reset function - safety net for long-running disconnections
    startPeriodicReset() {
        if (this.state.periodicResetInterval) {
            clearInterval(this.state.periodicResetInterval);
        }

        this.state.periodicResetInterval = setInterval(() => {
            const timeSinceLastPing = Date.now() - this.state.lastPing;

            if (!this.isAvailable() || timeSinceLastPing > PING_TIMEOUT_MS) {
                logger.debug('Periodic reset: No recent connection activity, attempting reconnection...');
                this.state.reconnectAttempts = 0;
                this.attemptReconnection().catch((err) => {
                    logger.debug('Periodic reset reconnection attempt failed:', err?.message || err);
                });
            }
        }, PERIODIC_RESET_INTERVAL_MS);
    }

    // Get node config based on mode (local or public)
    async getNodeConfig() {
        if (this.client.lavalinkMode === 'public') {
            const provider = this.client.publicNodeProvider;
            let rawNode = null;
            if (provider && typeof provider.getNextValidatedNode === 'function') {
                rawNode = await provider.getNextValidatedNode({ maxCandidates: 4, probeTimeoutMs: 3500 });
            }
            if (!rawNode && provider) {
                // If there are eligible non-cooling nodes, fetch next node without cooldown fallback
                if (typeof provider.hasEligibleNode === 'function' ? provider.hasEligibleNode() : true) {
                    rawNode = provider.getNextNode({ allowCooldownFallback: false });
                }
            }

            if (!rawNode && provider) {
                logger.debug('No eligible cached public nodes, refreshing list...');
                await provider.fetchNodes();
                if (typeof provider.getNextValidatedNode === 'function') {
                    rawNode = await provider.getNextValidatedNode({ maxCandidates: 4, probeTimeoutMs: 3500 });
                }
                if (!rawNode && (typeof provider.hasEligibleNode === 'function' ? provider.hasEligibleNode() : true)) {
                    rawNode = provider.getNextNode({ allowCooldownFallback: false });
                }
            }

            // Controlled fallback policy: only allow selecting a cooling node if deliberately authorized
            // (e.g. after backoff attempts when all nodes remain in cooldown)
            if (!rawNode && provider && typeof provider.areAllNodesInCooldown === 'function' && provider.areAllNodesInCooldown()) {
                if (this.state.reconnectAttempts >= 3) {
                    rawNode = provider.getNextNode({ allowCooldownFallback: true });
                }
            }

            if (!rawNode) {
                const isAllCooldown = provider?.areAllNodesInCooldown?.() || false;
                const err = new Error(isAllCooldown
                    ? 'All public Lavalink nodes are currently in cooldown'
                    : 'No public Lavalink nodes available');
                err.isAllCooldown = isAllCooldown;
                throw err;
            }

            const formatted = validateAndFormatNodeOption(rawNode, 'main-node');
            if (!formatted) {
                throw new Error('Retrieved public node could not be formatted into valid NodeOptions');
            }

            logger.info(`Rotating to public node: ${formatted.secure ? 'wss' : 'ws'}://${formatted.host}:${formatted.port}`);
            return formatted;
        }

        const localConfig = validateAndFormatNodeOption({
            host: process.env.LAVALINK_HOST,
            port: parseInt(process.env.LAVALINK_PORT, 10),
            authorization: process.env.LAVALINK_PASSWORD,
            id: 'main-node',
            secure: process.env.LAVALINK_SECURE === 'true',
            retryAmount: 3,
            retryDelay: 3000,
        }, 'main-node');

        if (!localConfig) {
            throw new Error('Invalid dedicated Lavalink configuration');
        }

        return localConfig;
    }

    // Reconnection logic
    async attemptReconnection() {
        if (this.state.isReconnecting) {
            logger.debug('Reconnection already in progress, skipping');
            return;
        }

        if (this.state.cooldownUntil > Date.now()) {
            return;
        }

        if (!this.isManagerReady()) {
            logger.debug('Lavalink manager not ready yet, attempting deferred discovery/initialization');
            this.attemptDiscoveryAndDeferredInit();
            return;
        }

        // Lavalink connection requires the Discord client ID
        if (!this.client.user?.id) {
            logger.debug('Discord client user not ready yet, deferring Lavalink connection');
            return;
        }

        this.state.isReconnecting = true;
        let keepReconnectLock = false;
        let nodeConfig = null;

        try {
            // Ensure client options are set on manager
            if (!this.client.lavalink.options?.client?.id) {
                this.client.lavalink.options.client = {
                    ...this.client.lavalink.options?.client,
                    id: this.client.user.id,
                    username: this.client.user.username || INTENDED_BOT_USERNAME,
                };
            }

            const oldNode = this.getActiveNode();

            if (oldNode && oldNode.connected) {
                logger.debug('Node is already connected, skipping reconnection');
                this.state.isReconnecting = false;
                return;
            }

            // Get node config based on mode and ensure it strictly satisfies NodeOptions
            const rawConfig = await this.getNodeConfig();
            this.state.nodeCounter = (this.state.nodeCounter || 0) + 1;
            const candidateId = this.client.lavalinkMode === 'public'
                ? `public-${String(rawConfig.host).replace(/[^a-zA-Z0-9_-]/g, '_')}-${rawConfig.port}-${this.state.nodeCounter}`
                : `local-${this.state.nodeCounter}`;

            nodeConfig = validateAndFormatNodeOption({
                ...rawConfig,
                id: candidateId,
                // Keep retryAmount >= 1 so isNodeOptions passes; 1 attempt allows fast failover
                retryAmount: this.client.lavalinkMode === 'public' ? 1 : (rawConfig.retryAmount || 3),
            }, candidateId);

            if (!nodeConfig) {
                throw new Error('Node configuration is invalid or missing required NodeOptions parameters');
            }

            const hostDisplay = `${nodeConfig.secure ? 'wss' : 'ws'}://${nodeConfig.host}:${nodeConfig.port}`;
            logger.info(`Connecting to Lavalink server at ${hostDisplay} (${nodeConfig.id}) (attempt ${this.state.reconnectAttempts + 1}/${this.state.maxReconnectAttempts})...`);

            let newNode;
            try {
                newNode = this.client.lavalink.nodeManager.createNode(nodeConfig);
            } catch (error) {
                throw new Error(`Failed to create node: ${error.message}`);
            }

            if (!newNode) {
                throw new Error('Node creation failed - no node object returned');
            }

            // Immediately hook socket getter/setter so socket is protected prior to connection
            attachNodeProtection(newNode);
            await new Promise((resolve, reject) => {
                let resolved = false;
                let timeout = null;

                const cleanup = () => {
                    if (timeout) clearTimeout(timeout);
                    this.client.lavalink.nodeManager.off('connect', onConnect);
                    this.client.lavalink.nodeManager.off('error', onError);
                    this.client.lavalink.nodeManager.off('disconnect', onDisconnect);
                };

                const onConnect = (node) => {
                    if (node.id === newNode.id || node === newNode) {
                        if (!resolved) {
                            resolved = true;
                            cleanup();
                            resolve(node);
                        }
                    }
                };

                const onError = (node, error) => {
                    if (node.id === newNode.id || node === newNode) {
                        if (!resolved) {
                            resolved = true;
                            cleanup();
                            safeDeleteNode(this.client.lavalink.nodeManager, newNode);
                            const sanitized = sanitizeError(error, nodeConfig.authorization);
                            reject(new Error(sanitized));
                        }
                    }
                };

                const onDisconnect = (node, reason) => {
                    if (node.id === newNode.id || node === newNode) {
                        if (!resolved) {
                            resolved = true;
                            cleanup();
                            safeDeleteNode(this.client.lavalink.nodeManager, newNode);
                            const reasonText = reason?.reason || reason?.code || 'WebSocket Closed';
                            reject(new Error(`Disconnect during handshake: ${reasonText}`));
                        }
                    }
                };

                this.client.lavalink.nodeManager.on('connect', onConnect);
                this.client.lavalink.nodeManager.on('error', onError);
                this.client.lavalink.nodeManager.on('disconnect', onDisconnect);

                timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        safeDeleteNode(this.client.lavalink.nodeManager, newNode);
                        reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`));
                    }
                }, CONNECTION_TIMEOUT_MS);

                // Call connect on the node
                try {
                    newNode.connect();
                    if (newNode.socket) {
                        protectSocket(newNode.socket);
                    }
                } catch (connError) {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        safeDeleteNode(this.client.lavalink.nodeManager, newNode);
                        reject(connError);
                    }
                }
            });

            logger.info(`Lavalink node connected successfully: ${hostDisplay} (${newNode.id})`);
            // Note: markNodeSuccess is deferred until playback progress is verified by audioPlaybackMonitor
            await this.onConnect(newNode, oldNode);

        } catch (error) {
            const safeMessage = sanitizeError(error);
            logger.warn(`Lavalink connection failed: ${safeMessage}`);
            this.state.reconnectAttempts++;

            // Immediately mark public node as failed with typed category so it gets cooled down and we rotate to next candidate
            if (this.client.lavalinkMode === 'public' && nodeConfig) {
                try {
                    let category = 'CONNECTION_FAILED';
                    if (safeMessage.includes('WRAPPER_ERROR') || safeMessage.includes('isNodelink') || safeMessage.includes('not connected')) {
                        category = 'WRAPPER_ERROR';
                    } else if (safeMessage.includes('TRANSIENT_ERROR') || safeMessage.includes('proxy error') || safeMessage.includes('connection refused') || safeMessage.includes('ECONNREFUSED') || safeMessage.includes('500') || safeMessage.includes('502') || safeMessage.includes('503') || safeMessage.includes('504')) {
                        category = 'TRANSIENT_ERROR';
                    } else if (safeMessage.includes('INCOMPATIBLE_API') || safeMessage.includes('does not provide any') || safeMessage.includes('SyntaxError') || safeMessage.includes('non-JSON')) {
                        category = 'INCOMPATIBLE_API';
                    } else if (safeMessage.includes('AUTH_FAILED') || safeMessage.includes('401') || safeMessage.includes('Unauthorized') || safeMessage.includes('403')) {
                        category = 'AUTH_FAILED';
                    } else if (safeMessage.includes('RATE_LIMITED') || safeMessage.includes('429')) {
                        category = 'RATE_LIMITED';
                    } else if (safeMessage.includes('timeout') || safeMessage.includes('ETIMEDOUT') || safeMessage.includes('TIMEOUT')) {
                        category = 'TIMEOUT';
                    }
                    this.client.publicNodeProvider?.markNodeFailed(nodeConfig.host, nodeConfig.port, safeMessage, category);
                } catch (_) {}
            }

            // Clean up the failed candidate node safely without WebSocket error race conditions
            try {
                if (nodeConfig?.id) {
                    const failedCandidate = this.client.lavalink?.nodeManager?.nodes?.get(nodeConfig.id);
                    if (failedCandidate) {
                        safeDeleteNode(this.client.lavalink.nodeManager, failedCandidate);
                    }
                }
            } catch (_) {}

            if (this.state.reconnectAttempts >= this.state.maxReconnectAttempts) {
                logger.error('Max Lavalink reconnection attempts reached, will retry after 3 minutes...');
                this.state.isReconnecting = false;

                const resetMinutes = parseInt(process.env.LAVALINK_RESET_ATTEMPTS_AFTER_MINUTES || "3", 10);
                const resetDelay = resetMinutes * 60 * 1000;

                this.state.cooldownUntil = Date.now() + resetDelay;
                if (this.state.reconnectTimer) clearTimeout(this.state.reconnectTimer);
                this.state.reconnectTimer = setTimeout(() => {
                    logger.info('Resetting reconnection attempts and retrying node connection...');
                    this.state.reconnectAttempts = 0;
                    this.state.isReconnecting = false;
                    this.attemptReconnection().catch((err) => {
                        logger.debug('Reconnection attempt failed after reset:', err?.message || err);
                    });
                }, resetDelay);

                return;
            }

            const isAllCooldown = Boolean(error?.isAllCooldown || this.client.publicNodeProvider?.areAllNodesInCooldown?.());
            const delay = this.getReconnectDelay(this.state.reconnectAttempts, isAllCooldown);
            if (isAllCooldown) {
                logger.warn(`All public nodes in cooldown. Controlled backoff for ${Math.round(delay / 1000)}s before next candidate attempt...`);
            } else {
                logger.debug(`Scheduling next reconnection attempt in ${Math.round(delay / 1000)} seconds...`);
            }

            if (this.state.reconnectTimer) clearTimeout(this.state.reconnectTimer);
            this.state.reconnectTimer = setTimeout(() => {
                this.state.isReconnecting = false;
                this.attemptReconnection().catch((err) => {
                    logger.debug('Reconnection attempt failed:', err?.message || err);
                });
            }, delay);
            keepReconnectLock = true;
        } finally {
            if (!keepReconnectLock) {
                this.state.isReconnecting = false;
            }
        }
    }

    // Handle connection events
    async onConnect(node, oldNode = null) {
        this.state.lastPing = Date.now();
        this.state.reconnectAttempts = 0;
        this.state.isReconnecting = false;
        this.state.isInitialized = true;
        this.state.hasHadSuccessfulConnection = true;

        if (this.state.reconnectTimer) {
            clearTimeout(this.state.reconnectTimer);
            this.state.reconnectTimer = null;
        }

        if (!this.state.healthCheckInterval) {
            this.startHealthCheck();
        }

        if (!this.state.periodicResetInterval) {
            this.startPeriodicReset();
        }

        // Migrate active players to newNode and recover 24/7 presence
        try {
            await this.migrateAndRecoverPlayers(node, oldNode);
        } catch (recoverErr) {
            logger.debug('Error migrating/recovering connections on node connect:', recoverErr?.message || recoverErr);
        }

        // Reconcile dashboards with live player state
        if (this.client.playerController?.reconcileAllDashboards) {
            this.client.playerController.reconcileAllDashboards().catch((err) => {
                logger.debug('Error reconciling dashboards on node connect:', err?.message || err);
            });
        }
    }

    /**
     * Migrates active players to the new connected node using player.changeNode()
     * where supported, cleans up stale nodes, and recovers 24/7 presence without starting autoplay.
     */
    async migrateAndRecoverPlayers(newNode, oldNode = null) {
        if (!this.client?.lavalink) return;

        // 1. Migrate active players using the library's player.changeNode()
        const players = Array.from(this.client.lavalink.players?.values() || []);
        for (const player of players) {
            const isNodeChanging = Boolean(player.isChangingNode || (typeof player.getData === 'function' && player.getData("internal_nodeChanging")));
            if (this.isPlayerMigrating(player.guildId) || isNodeChanging) {
                logger.debug(`[MIGRATION] Skipping player for guild ${player.guildId} in migrateAndRecoverPlayers: migration already in flight.`);
                continue;
            }
            // Only migrate if player's current node is missing or disconnected
            if (!player.node || !player.node.connected) {
                const is247 = Boolean(this.client.is247Enabled?.(player.guildId));
                const hasVoiceData = Boolean(player.voice?.token && player.voice?.endpoint && player.voice?.sessionId);

                if (hasVoiceData) {
                    try {
                        logger.info(`Migrating player for guild ${player.guildId} from ${player.node?.id || 'disconnected'} to ${newNode.id}...`);
                        await player.changeNode(newNode, false);
                        logger.info(`Successfully migrated player for guild ${player.guildId} to ${newNode.id}`);
                        if (this.client.voiceHandshakeSynchronizer?.reapplyVoiceCredentials) {
                            await this.client.voiceHandshakeSynchronizer.reapplyVoiceCredentials(player).catch(() => {});
                        }
                        this.client.voiceChannelStatusManager?.updateFromPlayer(player, player.queue?.current, player.paused ? 'paused' : 'playing').catch(() => {});
                    } catch (migErr) {
                        logger.warn(`Failed to migrate player for guild ${player.guildId}: ${migErr?.message || migErr}`);
                        if (is247) {
                            // Cleanly teardown internal player state without sending voice disconnect to Discord
                            await player.destroy('NodeMigrationFail', false).catch(() => {});
                        }
                    }
                } else if (is247) {
                    // Stale or missing voice credentials: clean up internally without voice disconnect
                    await player.destroy('NodeMigrationFail', false).catch(() => {});
                }
            }
        }

        // 2. Safely destroy and delete the old disconnected node now that players have been migrated
        if (oldNode && oldNode !== newNode && oldNode.id) {
            safeDeleteNode(this.client.lavalink.nodeManager, oldNode);
        }

        // Clean up any other lingering disconnected nodes in nodeManager
        if (this.client.lavalink.nodeManager?.nodes) {
            for (const node of this.client.lavalink.nodeManager.nodes.values()) {
                if (node !== newNode && !node.connected && node.id !== 'main-node') {
                    safeDeleteNode(this.client.lavalink.nodeManager, node);
                }
            }
            // Keep 'main-node' pointing to the active connected node for compatibility
            this.client.lavalink.nodeManager.nodes.set('main-node', newNode);
        }

        // 3. Recover 24/7 presence for any configured 24/7 guilds
        await this.recover247Connections(newNode);
    }

    /**
     * Migrates a single player to another healthy node.
     * Used by the audio playback monitor when a node stalls or encounters unrecoverable errors.
     * @param {Object} player - The Lavalink player instance
     * @param {string} reason - Diagnostic reason for migration
     * @returns {Promise<boolean>} True if migration succeeded
     */
    async migratePlayerToHealthyNode(player, reason = 'unhealthy-node') {
        if (!player || !player.guildId || !this.client?.lavalink) return false;
        if (this.client.lavalinkMode !== 'public' || !this.client.publicNodeProvider) return false;

        // Prevent concurrent migration collisions for the same player
        if (this.isPlayerMigrating(player.guildId)) {
            logger.debug(`[MIGRATION] Migration already in progress for guild ${player.guildId}; awaiting in-flight migration.`);
            return await this.activePlayerMigrations.get(player.guildId).catch(() => false);
        }

        const isNodeChanging = Boolean(player.isChangingNode || (typeof player.getData === 'function' && player.getData("internal_nodeChanging")));
        if (isNodeChanging) {
            logger.debug(`[MIGRATION] Player for guild ${player.guildId} is currently changing nodes; skipping duplicate migration.`);
            return false;
        }

        const migrationPromise = (async () => {
            const currentNode = player.node;
            const currentHost = currentNode?.host || currentNode?.options?.host;
            const currentPort = currentNode?.port || currentNode?.options?.port;

            if (currentHost && currentPort) {
                this.client.publicNodeProvider.recordPlaybackStall(currentHost, currentPort, reason);
            }

            let nextConfig = null;
            if (typeof this.client.publicNodeProvider.getNextValidatedNode === 'function') {
                nextConfig = await this.client.publicNodeProvider.getNextValidatedNode({
                    excludeHost: currentHost,
                    excludePort: currentPort,
                    maxCandidates: 4,
                    probeTimeoutMs: 3000,
                });
            }
            if (!nextConfig && typeof this.client.publicNodeProvider.getNextNode === 'function') {
                const rawCandidate = this.client.publicNodeProvider.getNextNode();
                if (rawCandidate) {
                    // If candidate already exists and is connected in nodeManager, it is safe to migrate to
                    let isAlreadyConnected = false;
                    if (this.client.lavalink.nodeManager?.nodes) {
                        for (const n of this.client.lavalink.nodeManager.nodes.values()) {
                            const nHost = n.host || n.options?.host;
                            const nPort = n.port || n.options?.port;
                            if (n && n.connected && nHost === rawCandidate.host && Number(nPort) === Number(rawCandidate.port)) {
                                isAlreadyConnected = true;
                                break;
                            }
                        }
                    }
                    if (isAlreadyConnected) {
                        nextConfig = rawCandidate;
                    } else if (typeof this.client.publicNodeProvider.checkNodeCompatibility === 'function') {
                        const check = await this.client.publicNodeProvider.checkNodeCompatibility(rawCandidate, { timeoutMs: 3000 });
                        if (check.compatible) {
                            nextConfig = rawCandidate;
                        } else {
                            this.client.publicNodeProvider.markNodeFailed(rawCandidate.host, rawCandidate.port, check.reason, check.category);
                        }
                    }
                }
            }
            if (!nextConfig) return false;

            // If candidate node is the identical host and port, avoid migrating to itself
            if (currentHost === nextConfig.host && Number(currentPort) === Number(nextConfig.port)) {
                return false;
            }

            // Check if player was destroyed or stopped while node discovery was in flight
            const livePlayerBefore = this._getPlayer(player.guildId) || player;
            if (!player.guildId || !livePlayerBefore) {
                logger.debug(`[MIGRATION] Player for guild ${player.guildId} was destroyed during candidate search; aborting migration.`);
                return false;
            }

            logger.info(`Migrating player for guild ${player.guildId} from ${currentNode?.id || 'unknown'} to candidate ${nextConfig.host}:${nextConfig.port} (reason: ${reason})...`);

            // Check if candidate node already exists and is connected in nodeManager
            let targetNode = null;
            if (this.client.lavalink.nodeManager?.nodes) {
                for (const n of this.client.lavalink.nodeManager.nodes.values()) {
                    const nHost = n.host || n.options?.host;
                    const nPort = n.port || n.options?.port;
                    if (n && n.connected && nHost === nextConfig.host && Number(nPort) === Number(nextConfig.port)) {
                        targetNode = n;
                        break;
                    }
                }
            }

            if (!targetNode && typeof this.client.lavalink.nodeManager?.createNode === 'function') {
                let newNode = null;
                try {
                    const candidateNodeId = `public-${nextConfig.host}:${nextConfig.port}-${Date.now()}`;
                    const nodeToCreate = { ...nextConfig, id: candidateNodeId };
                    newNode = this.client.lavalink.nodeManager.createNode(nodeToCreate);
                    attachNodeProtection(newNode);

                    await new Promise((resolve, reject) => {
                        let resolved = false;
                        let timeoutId = null;
                        const cleanup = () => {
                            if (timeoutId) clearTimeout(timeoutId);
                            this.client.lavalink.nodeManager.off('connect', onConn);
                            this.client.lavalink.nodeManager.off('error', onErr);
                        };
                        const onConn = (n) => {
                            if (n === newNode || n.id === candidateNodeId) {
                                if (!resolved) { resolved = true; cleanup(); resolve(n); }
                            }
                        };
                        const onErr = (n, err) => {
                            if (n === newNode || n.id === candidateNodeId) {
                                if (!resolved) { resolved = true; cleanup(); reject(err); }
                            }
                        };
                        this.client.lavalink.nodeManager.on('connect', onConn);
                        this.client.lavalink.nodeManager.on('error', onErr);
                        timeoutId = setTimeout(() => {
                            if (!resolved) { resolved = true; cleanup(); reject(new Error('Connection timeout')); }
                        }, 8000);
                        newNode.connect();
                        if (newNode.socket) protectSocket(newNode.socket);
                    });

                    targetNode = newNode;
                    // Note: markNodeSuccess is deferred until playback progress is verified
                } catch (err) {
                    if (newNode) {
                        safeDeleteNode(this.client.lavalink.nodeManager, newNode);
                    }
                    const safeMessage = sanitizeError(err);
                    logger.warn(`Failed to connect replacement node ${nextConfig.host}:${nextConfig.port}: ${safeMessage}`);
                    let cat = 'CONNECTION_FAILED';
                    if (safeMessage.includes('timeout') || safeMessage.includes('ETIMEDOUT') || safeMessage.includes('TIMEOUT')) {
                        cat = 'TIMEOUT';
                    } else if (safeMessage.includes('INCOMPATIBLE_API') || safeMessage.includes('does not provide any')) {
                        cat = 'INCOMPATIBLE_API';
                    }
                    this.client.publicNodeProvider.markNodeFailed(nextConfig.host, nextConfig.port, safeMessage, cat);
                    return false;
                }
            }

            // Re-verify player validity after candidate node connection
            const isStillChanging = Boolean(player.isChangingNode || (typeof player.getData === 'function' && player.getData("internal_nodeChanging")));
            const livePlayerAfter = this._getPlayer(player.guildId) || player;
            if (!player.guildId || !livePlayerAfter || isStillChanging) {
                logger.debug(`[MIGRATION] Player for guild ${player.guildId} invalid or already changing node; aborting changeNode.`);
                return false;
            }

            if (targetNode && targetNode.connected) {
                try {
                    await player.changeNode(targetNode, false);
                    logger.info(`Successfully migrated player for guild ${player.guildId} to ${targetNode.id}`);
                    if (this.client.voiceHandshakeSynchronizer?.reapplyVoiceCredentials) {
                        await this.client.voiceHandshakeSynchronizer.reapplyVoiceCredentials(player).catch(() => {});
                    }
                    this.client.voiceChannelStatusManager?.updateFromPlayer(player, player.queue?.current, player.paused ? 'paused' : 'playing').catch(() => {});
                    return true;
                } catch (migErr) {
                    logger.warn(`Failed to execute changeNode for guild ${player.guildId}: ${migErr?.message || migErr}`);
                    return false;
                }
            }

            return false;
        })();

        this.activePlayerMigrations.set(player.guildId, migrationPromise);
        try {
            return await migrationPromise;
        } finally {
            this.activePlayerMigrations.delete(player.guildId);
        }
    }

    /**
     * Re-establishes voice connections for guilds that have 24/7 mode enabled
     * without triggering autoplay or modifying queues.
     * Coalesces concurrent recovery attempts and prevents duplicate recovery logs.
     */
    async recover247Connections(activeNode = null) {
        if (!this.client?.guildSettings || !this.client?.lavalink) return;
        const mainNode = activeNode || this.getActiveNode();
        if (!mainNode || !mainNode.connected) return;

        if (this._recover247Promise) {
            return this._recover247Promise;
        }

        this._recover247Promise = this._executeRecover247Connections(mainNode);
        try {
            return await this._recover247Promise;
        } finally {
            this._recover247Promise = null;
        }
    }

    async _executeRecover247Connections(mainNode) {
        if (this.client.guildSettings?.discoverAndRestoreFromDiscord) {
            await this.client.guildSettings.discoverAndRestoreFromDiscord(this.client).catch(() => {});
        }

        const guildIds = new Set();
        if (this.client.guildSettings?.cache) {
            for (const g of this.client.guildSettings.cache.keys()) guildIds.add(g);
        }
        if (this.client.guilds?.cache) {
            for (const g of this.client.guilds.cache.keys()) guildIds.add(g);
        }

        for (const guildId of guildIds) {
            const settings = this.client.guildSettings?.get?.(guildId) || {};
            const is247 = Boolean(this.client.is247Enabled?.(guildId) || settings?.twentyFourSeven);
            if (!is247) continue;

            const voiceChannelId = settings?.voiceChannelId;
            if (voiceChannelId) {
                // Prevent duplicate recovery if twentyFourSevenManager is already actively reconnecting this guild
                if (this.client.twentyFourSevenManager?.isReconnecting?.(guildId)) {
                    continue;
                }
                try {
                    const guild = this.client.guilds?.cache?.get(guildId)
                        || (typeof this.client.guilds?.fetch === 'function' ? await this.client.guilds.fetch(guildId).catch(() => null) : null);
                    if (!guild) continue;

                    let isDeletedVoiceChannel = false;
                    const voiceChannel = guild.channels?.cache?.get(settings.voiceChannelId)
                        || (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(settings.voiceChannelId).catch((fetchErr) => {
                            if (fetchErr.code === 10003) {
                                isDeletedVoiceChannel = true;
                                logger.warn(`[247-RECOVERY] Intended voice channel ${settings.voiceChannelId} was deleted in guild ${guildId} (code 10003 Unknown Channel).`);
                                return null;
                            }
                            logger.debug(`[247-RECOVERY] Fetch error for voice channel ${settings.voiceChannelId}:`, fetchErr?.message || fetchErr);
                            return null;
                        }) : null);
                    if (!voiceChannel) {
                        if (isDeletedVoiceChannel) {
                            logger.warn(`[247-RECOVERY] Intended 24/7 voice channel ${settings.voiceChannelId} was deleted in guild ${guild.name || guildId}. Cleared invalid channel reference while preserving 24/7 mode. Waiting for an authorized user to configure a valid voice channel.`);
                            this.client.guildSettings?.invalidateVoiceChannel?.(guildId);
                        } else {
                            logger.warn(`[247-RECOVERY] Intended 24/7 voice channel ${settings.voiceChannelId} does not exist in guild ${guild.name || guildId}. Aborting 24/7 recovery.`);
                        }
                        continue;
                    }

                    const isVoice = (typeof voiceChannel.isVoiceBased === 'function' && voiceChannel.isVoiceBased())
                        || voiceChannel.type === 2 || voiceChannel.type === 13;
                    if (!isVoice) {
                        logger.warn(`[247-RECOVERY] Channel ${settings.voiceChannelId} in guild ${guildId} is not a voice channel. Cleared invalid voice channel reference.`);
                        this.client.guildSettings?.invalidateVoiceChannel?.(guildId);
                        continue;
                    }

                    const botMember = guild.members?.me
                        || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(this.client.user?.id).catch(() => null) : null);

                    // Check Connect permission
                    if (botMember && typeof voiceChannel.permissionsFor === 'function') {
                        const perms = voiceChannel.permissionsFor(botMember);
                        if (perms && !perms.has(PermissionsBitField.Flags.Connect)) {
                            logger.warn(`[247-RECOVERY] Missing Connect permission in voice channel #${voiceChannel.name} for guild ${guildId}.`);
                            continue;
                        }
                    }

                    const isVoiceConnected = Boolean(botMember?.voice?.channelId === voiceChannel.id);

                    let player = this._getPlayer(guildId);

                    // Idempotent recovery guard: if already connected to target channel with valid session on a connected node, skip cleanly
                    if (isVoiceConnected && player && player.voice?.sessionId && player.connected && player.node?.connected) {
                        continue;
                    }

                    if (player) {
                        // Only migrate node if player's current node is disconnected/missing
                        if (!player.node || !player.node.connected) {
                            try {
                                if (player.voice?.token && player.voice?.endpoint && player.voice?.sessionId) {
                                    await player.changeNode(mainNode, false);
                                } else {
                                    player.node = mainNode;
                                    await player.connect();
                                }
                            } catch (_) {
                                player.node = mainNode;
                                await player.connect();
                            }
                        }
                        if (!player.queue?.current) {
                            player.playing = false;
                        }
                    } else {
                        player = this.client.lavalink.createPlayer({
                            guildId,
                            voiceChannelId: voiceChannel.id,
                            textChannelId: settings.textChannelId || null,
                            node: mainNode.id,
                            selfDeaf: true,
                            selfMute: false,
                        });
                    }

                    if (!isVoiceConnected || !player.voice?.sessionId) {
                        await player.connect();
                        logger.info(`Recovered 24/7 player in guild ${guild.name || guildId} (#${voiceChannel.name || settings.voiceChannelId})`);
                    }

                    // If autoplay is enabled and player is idle with empty queue, seamlessly start autoplay
                    const isAutoplay = Boolean(
                        this.client.autoplayEnabled?.get?.(guildId) ||
                        this.client.guildSettings?.isAutoplay?.(guildId)
                    );
                    if (isAutoplay && !player.queue?.current && !player.playing && (player.queue?.tracks?.length || 0) === 0) {
                        const { handleAutoplay } = require('./autoplay');
                        handleAutoplay(this.client, player, 'recovery_connect', null).catch(() => {});
                    }
                } catch (error) {
                    logger.debug(`Failed to recover 24/7 connection for guild ${guildId}:`, error?.message || error);
                }
            }
        }
    }

    /**
     * Audits all configured 24/7 guilds to ensure voice presence is actively maintained.
     * Reconnects to voice if disconnected without starting playback or creating duplicate players.
     */
    async audit247Presence() {
        if (!this.client?.guildSettings || !this.client?.lavalink || !this.isAvailable()) return;
        const mainNode = this.getActiveNode();
        if (!mainNode || !mainNode.connected) return;

        const entries = this.client.guildSettings.cache?.entries
            ? Array.from(this.client.guildSettings.cache.entries())
            : [];

        for (const [guildId, settings] of entries) {
            if (!settings?.twentyFourSeven || !settings?.voiceChannelId) continue;

            try {
                const guild = this.client.guilds?.cache?.get(guildId)
                    || (typeof this.client.guilds?.fetch === 'function' ? await this.client.guilds.fetch(guildId).catch(() => null) : null);
                if (!guild) continue;

                const botMember = guild.members?.me
                    || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(this.client.user?.id).catch(() => null) : null);

                const currentChannelId = botMember?.voice?.channelId;
                const expectedChannelId = settings.voiceChannelId;

                const isConnected = Boolean(currentChannelId && currentChannelId === expectedChannelId);

                let player = this._getPlayer(guildId);

                if (!isConnected) {
                    const voiceChannel = guild.channels?.cache?.get(expectedChannelId)
                        || (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(expectedChannelId).catch(() => null) : null);
                    if (!voiceChannel) continue;

                    if (!player) {
                        player = this.client.lavalink.createPlayer({
                            guildId,
                            voiceChannelId: voiceChannel.id,
                            textChannelId: settings.textChannelId || null,
                            node: mainNode.id,
                            selfDeaf: true,
                            selfMute: false,
                        });
                    } else {
                        player.options.voiceChannelId = voiceChannel.id;
                        player.voiceChannelId = voiceChannel.id;
                        if ((!player.node || !player.node.connected) && mainNode) player.node = mainNode;
                    }

                    await player.connect();
                    logger.info(`Health check restored 24/7 voice presence for guild ${guild.name || guildId} in #${voiceChannel.name || expectedChannelId}`);
                } else if (player && (!player.node || !player.node.connected)) {
                    try {
                        if (player.voice?.token && player.voice?.endpoint && player.voice?.sessionId) {
                            await player.changeNode(mainNode, false);
                        } else {
                            player.node = mainNode;
                            await player.connect();
                        }
                    } catch (_) {
                        player.node = mainNode;
                        await player.connect();
                    }
                }
            } catch (err) {
                logger.debug(`Failed 24/7 audit check for guild ${guildId}:`, err?.message || err);
            }
        }
    }

    onError(node, error) {
        const safeMsg = sanitizeError(error, node?.options?.authorization);
        const host = node?.options?.host || 'unknown';
        const port = node?.options?.port || 0;

        logger.error(`Lavalink node ${host}:${port} encountered an error: ${safeMsg}`);

        if (this.client.lavalinkMode === 'public') {
            let cat = error?.category || 'CONNECTION_FAILED';
            if (safeMsg.includes('TRANSIENT_ERROR') || safeMsg.includes('proxy error') || safeMsg.includes('500') || safeMsg.includes('connection refused')) {
                cat = 'TRANSIENT_ERROR';
            } else if (safeMsg.includes('INCOMPATIBLE_API') || safeMsg.includes('does not provide any')) {
                cat = 'INCOMPATIBLE_API';
            } else if (safeMsg.includes('RATE_LIMITED') || safeMsg.includes('429')) {
                cat = 'RATE_LIMITED';
            } else if (safeMsg.includes('AUTH_FAILED') || safeMsg.includes('401') || safeMsg.includes('403')) {
                cat = 'AUTH_FAILED';
            }
            this.client.publicNodeProvider?.markNodeFailed(host, port, safeMsg, cat);
        }

        if (!this.isAvailable() && !this.state.isReconnecting) {
            logger.info('Node is disconnected following error; triggering reconnection...');
            if (this.state.reconnectTimer) clearTimeout(this.state.reconnectTimer);
            this.state.reconnectTimer = setTimeout(() => {
                this.attemptReconnection().catch((err) => {
                    logger.debug('Reconnection after error failed:', err?.message || err);
                });
            }, RECONNECT_DELAY_ON_ERROR_MS);
        }
    }

    onDisconnect(node, reason) {
        const rawReason = reason?.reason || reason?.code || reason || 'Unknown';
        const safeReason = sanitizeError({ message: String(rawReason) }, node?.options?.authorization);
        const host = node?.options?.host || 'unknown';
        const port = node?.options?.port || 0;

        logger.warn(`Lavalink node ${host}:${port} disconnected (reason: ${safeReason})`);

        if (this.client.lavalinkMode === 'public') {
            let cat = 'CONNECTION_FAILED';
            if (safeReason.includes('TRANSIENT_ERROR') || safeReason.includes('500') || safeReason.includes('proxy error') || safeReason.includes('Socket got terminated')) {
                cat = 'TRANSIENT_ERROR';
            }
            this.client.publicNodeProvider?.markNodeFailed(host, port, safeReason, cat);
        }

        if (safeReason !== 'Node-Destroy' && safeReason !== 'NodeDeleted' && !this.state.isReconnecting) {
            logger.info('Disconnected from Lavalink node; searching for healthy alternative...');
            if (!this.isAvailable() && this.client.playerController?.reconcileAllDashboards) {
                this.client.playerController.reconcileAllDashboards().catch(() => {});
            }
            if (this.state.reconnectTimer) clearTimeout(this.state.reconnectTimer);
            this.state.reconnectTimer = setTimeout(() => {
                this.attemptReconnection().catch((err) => {
                    logger.debug('Reconnection after disconnect failed:', err?.message || err);
                });
            }, 1500);
        }
    }

    // Initialize the connection manager
    initialize() {
        logger.info('Lavalink connection manager initializing...');
        this.state.isInitialized = true;
        this.startMonitoring();
    }

    // Start monitoring for Lavalink availability
    startMonitoring() {
        this.checkAndStartHealthChecks();

        // If LavalinkManager is not initialized yet (deferred), immediately kick off background discovery
        if (!this.isManagerReady()) {
            this.attemptDiscoveryAndDeferredInit();
        }

        // Check every 3 seconds until we get a connection
        const monitoringInterval = setInterval(() => {
            if (this.isAvailable()) {
                logger.info('Lavalink connection verified healthy');
                clearInterval(monitoringInterval);
                this.startHealthCheck();
                this.startPeriodicReset();
            }
        }, MONITORING_CHECK_INTERVAL_MS);

        // Fallback after 10s: if not connected, trigger reconnection proactively
        setTimeout(() => {
            clearInterval(monitoringInterval);
            if (!this.isAvailable()) {
                logger.warn('No Lavalink connection established after initial window, initiating failover...');
                this.attemptReconnection().catch((err) => {
                    logger.debug('Initial fallback reconnection attempt failed:', err?.message || err);
                });
                this.startHealthCheck();
                this.startPeriodicReset();
            }
        }, MONITORING_FALLBACK_TIMEOUT_MS);

        setTimeout(() => {
            if (!this.isAvailable()) {
                if (this.client.lavalinkMode === 'local') {
                    logger.error('CRITICAL: Local Lavalink has not connected after 3 minutes!\n  - Check if Lavalink container is running: docker ps\n  - Check Lavalink logs: docker compose logs lavalink\n  - Verify network connectivity between containers');
                } else {
                    logger.error('CRITICAL: Public Lavalink nodes have not connected after 3 minutes!\n  - Public nodes may be experiencing widespread downtime or rate limiting.\n  - Configure a dedicated Lavalink server via LAVALINK_HOST, LAVALINK_PORT, and LAVALINK_PASSWORD in .env for guaranteed uptime.');
                }
            }
        }, CRITICAL_TIMEOUT_MS);
    }

    // Retries public node discovery in background and initializes LavalinkManager exactly once
    async attemptDiscoveryAndDeferredInit() {
        if (this.state.isDiscovering) return;
        if (this.isManagerReady()) return;

        const provider = this.client.publicNodeProvider;
        if (!provider) return;

        this.state.isDiscovering = true;
        try {
            logger.info('Retrying public Lavalink node discovery in background...');
            const success = await provider.fetchNodes({ maxRetries: 1, timeoutMs: 12000, retryDelayMs: 1500 });

            if (success && provider.hasNodes()) {
                provider.startAutoRefresh();
                const rawFirstNode = provider.getNextNode();
                const firstNode = validateAndFormatNodeOption(rawFirstNode, 'main-node');

                if (firstNode && typeof this.createLavalinkManagerFn === 'function') {
                    logger.info(`Discovered public node in background: ${firstNode.secure ? 'wss' : 'ws'}://${firstNode.host}:${firstNode.port}`);
                    this.createLavalinkManagerFn(this.client, [firstNode]);

                    if (this.client.user?.id && this.client.lavalink) {
                        try {
                            await this.client.lavalink.init({ ...this.client.user });
                            logger.info('Deferred Lavalink initialized with Discord client');
                        } catch (initErr) {
                            logger.warn('Deferred Lavalink init warning:', initErr?.message || initErr);
                        }
                    }

                    this.attemptReconnection().catch((err) => {
                        logger.debug('Reconnection after deferred discovery failed:', err?.message || err);
                    });
                    return;
                }
            }

            this.scheduleNextDiscoveryRetry();
        } catch (err) {
            logger.debug(`Background discovery error: ${err?.message || err}`);
            this.scheduleNextDiscoveryRetry();
        } finally {
            this.state.isDiscovering = false;
        }
    }

    scheduleNextDiscoveryRetry() {
        if (this.isManagerReady()) return;
        this.state.discoveryAttempts = (this.state.discoveryAttempts || 0) + 1;
        const delay = Math.min(5000 * Math.pow(1.5, Math.min(this.state.discoveryAttempts, 5)), 60000) + (Math.random() * 2000);
        logger.debug(`Scheduling next background public node discovery in ${Math.round(delay / 1000)}s (attempt ${this.state.discoveryAttempts})...`);

        if (this.state.discoveryTimer) clearTimeout(this.state.discoveryTimer);
        this.state.discoveryTimer = setTimeout(() => {
            this.attemptDiscoveryAndDeferredInit();
        }, delay);
    }

    // Check if Lavalink is available and start health checks if it is
    checkAndStartHealthChecks() {
        if (this.isAvailable()) {
            this.startHealthCheck();
            this.startPeriodicReset();
            return true;
        }
        return false;
    }

    // Cleanup function
    destroy() {
        if (this.state.reconnectTimer) {
            clearTimeout(this.state.reconnectTimer);
            this.state.reconnectTimer = null;
        }
        if (this.state.discoveryTimer) {
            clearTimeout(this.state.discoveryTimer);
            this.state.discoveryTimer = null;
        }
        if (this.state.healthCheckInterval) {
            clearInterval(this.state.healthCheckInterval);
            this.state.healthCheckInterval = null;
        }
        if (this.state.periodicResetInterval) {
            clearInterval(this.state.periodicResetInterval);
            this.state.periodicResetInterval = null;
        }
    }
}

module.exports = LavalinkConnectionManager;
