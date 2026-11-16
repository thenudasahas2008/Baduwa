const crypto = require('crypto');
const logger = require('./logger');

/**
 * VoiceHandshakeSynchronizer
 * 
 * Ensures reliable, order-independent synchronization of Discord Voice Gateway events
 * (VOICE_SERVER_UPDATE and VOICE_STATE_UPDATE) with Lavalink's player voice credentials.
 * 
 * Discord Gateway transmits VOICE_SERVER_UPDATE (token, endpoint) and VOICE_STATE_UPDATE
 * (sessionId, channelId) asynchronously. If VOICE_SERVER_UPDATE arrives before
 * VOICE_STATE_UPDATE, standard lavalink-client drops the token because sessionId is missing.
 * This synchronizer caches updates, merges them regardless of arrival order, and guarantees
 * that Lavalink receives the complete { token, endpoint, sessionId } payload.
 */
class VoiceHandshakeSynchronizer {
    constructor(client) {
        this.client = client;
        // guildId -> { token, endpoint, sessionId, channelId, lastUpdated, lastDispatchedAt, lastDispatchedFingerprint }
        this.voiceStates = new Map();
    }

    /**
     * Intercept and synchronize raw Discord Gateway events for voice handshakes
     * Returns true if event was a voice gateway event handled by the synchronizer.
     */
    async handleRawGateway(data) {
        if (!data || !data.t || !data.d) return false;

        const { t, d } = data;
        if (!['VOICE_SERVER_UPDATE', 'VOICE_STATE_UPDATE'].includes(t)) {
            return false;
        }

        const guildId = d.guild_id;
        if (!guildId) return false;

        let entry = this.voiceStates.get(guildId) || {
            token: null,
            endpoint: null,
            sessionId: null,
            channelId: null,
            lastUpdated: 0,
            lastDispatchedAt: 0,
            lastDispatchedFingerprint: null
        };

        const player = this.client?.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;

        if (t === 'VOICE_SERVER_UPDATE') {
            // Check for voice server or region change
            if ((entry.endpoint && d.endpoint && entry.endpoint !== d.endpoint) || (entry.token && d.token && entry.token !== d.token)) {
                const sanitizedOld = String(entry.endpoint || '').replace(/:.*$/, '');
                const sanitizedNew = String(d.endpoint || '').replace(/:.*$/, '');
                logger.info(`[VOICE-HANDSHAKE] [SERVER_CHANGED] guild=${guildId} oldEndpoint="${sanitizedOld}" newEndpoint="${sanitizedNew}"`);
                entry.lastDispatchedFingerprint = null;
            }

            // d: { token, endpoint, guild_id }
            entry.token = d.token || entry.token;
            entry.endpoint = d.endpoint || entry.endpoint;
            entry.lastUpdated = Date.now();

            if (player && player.voice) {
                player.voice.token = entry.token;
                player.voice.endpoint = entry.endpoint;
            }

            // Fallback: check if sessionId is already known from Discord.js guild cache
            if (!entry.sessionId) {
                const guild = this.client?.guilds?.cache?.get(guildId);
                const meVoice = guild?.members?.me?.voice;
                if (meVoice?.sessionId) {
                    entry.sessionId = meVoice.sessionId;
                    entry.channelId = meVoice.channelId || entry.channelId;
                    if (player && player.voice) {
                        player.voice.sessionId = entry.sessionId;
                        player.voice.channelId = entry.channelId;
                    }
                }
            }

            const effectiveSession = entry.sessionId || player?.voice?.sessionId;
            logger.info(`[VOICE-HANDSHAKE] [VOICE_SERVER_UPDATE] guild=${guildId} hasToken=${Boolean(d.token)} hasEndpoint=${Boolean(d.endpoint)} hasSession=${Boolean(effectiveSession)}`);

            this.voiceStates.set(guildId, entry);

            const effectiveNode = (player?.node?.sessionId ? player.node : null)
                || this.client?.lavalinkConnectionManager?.getActiveNode?.()
                || this.client?.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                || null;

            if (player && effectiveNode && (!player.node?.sessionId || !player.node.connected) && effectiveNode.sessionId) {
                player.node = effectiveNode;
            }

            // If we have token, endpoint, AND sessionId, dispatch updatePlayer to Lavalink
            if (entry.token && entry.endpoint && effectiveSession && effectiveNode?.sessionId) {
                await this.dispatchToLavalink(player || { node: effectiveNode, guildId }, guildId, entry.token, entry.endpoint, effectiveSession, entry.channelId);
            }
            return true;
        } else if (t === 'VOICE_STATE_UPDATE') {
            // Only process state updates for our own bot user
            if (d.user_id !== this.client?.user?.id) return false;

            // d: { session_id, channel_id, user_id, guild_id }
            if (d.channel_id) {
                // Invalidate dispatch key if bot moved voice channels
                if (entry.channelId && entry.channelId !== d.channel_id) {
                    logger.info(`[VOICE-HANDSHAKE] [CHANNEL_CHANGED] guild=${guildId} oldChannel=${entry.channelId} newChannel=${d.channel_id}`);
                    entry.lastDispatchedFingerprint = null;
                }

                entry.sessionId = d.session_id || entry.sessionId;
                entry.channelId = d.channel_id;
                entry.lastUpdated = Date.now();

                const effectiveNode = (player?.node?.sessionId ? player.node : null)
                    || this.client?.lavalinkConnectionManager?.getActiveNode?.()
                    || this.client?.lavalink?.nodeManager?.leastUsedNodes?.()?.[0]
                    || null;

                if (player) {
                    if (player.voice) {
                        player.voice.sessionId = entry.sessionId;
                        player.voice.channelId = entry.channelId;
                    }
                    player.voiceChannelId = entry.channelId;
                    if (player.options) {
                        player.options.voiceChannelId = entry.channelId;
                    }
                    if (effectiveNode && (!player.node?.sessionId || !player.node.connected) && effectiveNode.sessionId) {
                        player.node = effectiveNode;
                    }
                }

                const effectiveToken = entry.token || player?.voice?.token;
                const effectiveEndpoint = entry.endpoint || player?.voice?.endpoint;

                logger.info(`[VOICE-HANDSHAKE] [VOICE_STATE_UPDATE] guild=${guildId} channelId=${d.channel_id} hasSession=${Boolean(d.session_id)} hasToken=${Boolean(effectiveToken)} hasEndpoint=${Boolean(effectiveEndpoint)}`);

                this.voiceStates.set(guildId, entry);

                // If token and endpoint were already cached, dispatch to Lavalink now
                if (effectiveToken && effectiveEndpoint && entry.sessionId && effectiveNode?.sessionId) {
                    await this.dispatchToLavalink(player || { node: effectiveNode, guildId }, guildId, effectiveToken, effectiveEndpoint, entry.sessionId, entry.channelId);
                }
            } else {
                // Bot was disconnected from voice channel: clear all cached state
                logger.info(`[VOICE-HANDSHAKE] [CLEARED] guild=${guildId} reason=disconnect`);
                this.clear(guildId);
                if (player && player.voice) {
                    player.voice.sessionId = null;
                    player.voice.channelId = null;
                    player.voice.token = null;
                    player.voice.endpoint = null;
                }
            }
            return true;
        }
        return false;
    }

    /**
     * Dispatch validated voice credentials to Lavalink's REST API
     */
    async dispatchToLavalink(player, guildId, token, endpoint, sessionId, channelId) {
        if (!player || !player.node || !player.node.sessionId) return false;

        const now = Date.now();
        const entry = this.voiceStates.get(guildId);
        
        // Cryptographic digest of the credential tuple to prevent storing raw plaintext credentials in deduplication key
        const dispatchFingerprint = crypto.createHash('sha256')
            .update(`${token}:${endpoint}:${sessionId}:${channelId || ''}`)
            .digest('hex');
        
        // Single authoritative path: prevent duplicate REST updatePlayer calls for identical credentials
        if (entry && entry.lastDispatchedFingerprint === dispatchFingerprint) {
            // When player is connected (or connection status is uninitialized), deduplicate identical credentials
            if (player?.connected !== false) {
                return true;
            }
            // When player is explicitly disconnected from voice gateway (connected === false),
            // allow re-dispatching to reconnect Lavalink's socket, throttled to avoid rapid REST spam
            if (now - (entry.lastDispatchedAt || 0) < 2000) {
                return true;
            }
        }

        try {
            const voicePayload = {
                token,
                endpoint,
                sessionId,
                channelId: channelId || player.voiceChannelId || undefined
            };

            await player.node.updatePlayer({
                guildId,
                playerOptions: { voice: voicePayload }
            });

            if (entry) {
                entry.lastDispatchedAt = now;
                entry.lastDispatchedFingerprint = dispatchFingerprint;
            }

            const sanitizedEndpoint = String(endpoint || '').replace(/:.*$/, '');
            logger.info(`[VOICE-HANDSHAKE] [HANDSHAKE_DISPATCHED] guild=${guildId} endpoint="${sanitizedEndpoint}" hasToken=true hasSession=true`);
            return true;
        } catch (err) {
            logger.warn(`[VOICE-HANDSHAKE] Failed to update Lavalink voice credentials for guild ${guildId}: ${err?.message || err}`);
            return false;
        }
    }

    /**
     * Get cached voice state for diagnostics
     */
    getVoiceState(guildId) {
        return this.voiceStates.get(guildId) || null;
    }

    /**
     * Check if voice credentials are fully assembled
     */
    isVoiceReady(guildId) {
        const state = this.voiceStates.get(guildId);
        return Boolean(state && state.token && state.endpoint && state.sessionId);
    }

    /**
     * Invalidate cached fingerprint to force re-dispatching credentials (e.g. after socket disconnect)
     */
    invalidateFingerprint(guildId) {
        const entry = this.voiceStates.get(guildId);
        if (entry) {
            entry.lastDispatchedFingerprint = null;
        }
    }

    /**
     * Clear cached voice state for a guild
     */
    clear(guildId) {
        this.voiceStates.delete(guildId);
    }
}

module.exports = VoiceHandshakeSynchronizer;
