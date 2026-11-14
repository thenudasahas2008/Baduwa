const { isManualStopActive } = require('./playerLifecycle');
const logger = require('./logger');

/**
 * PlaybackProgressManager manages periodic in-place dashboard updates
 * for active players across all guilds using a single shared timer.
 *
 * Requirements:
 * - Updates progress indicator approximately every 5–10 seconds.
 * - Always edits existing dashboard in place; never creates a replacement message.
 * - Single shared timer for all guilds to prevent duplicate timers and memory leaks.
 * - Coalesces in-flight edits and respects Discord REST rate limits.
 * - Resets on track changes and pauses progression when player is paused.
 */
class PlaybackProgressManager {
    constructor(client, options = {}) {
        this.client = client;
        this.tickIntervalMs = options.tickIntervalMs || 5000;
        this.minEditIntervalMs = options.minEditIntervalMs || 4500;
        this.timer = null;
        this.inFlightEdits = new Set();
        this.lastEditTimes = new Map();
        this.lastRenderedPositions = new Map();
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.tick().catch((err) => {
                logger.debug('[PROGRESS-DIAG] Error in progress tick:', err?.message || err);
            });
        }, this.tickIntervalMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }

        logger.info(`[PROGRESS-DIAG] Started shared playback progress manager (interval: ${this.tickIntervalMs}ms)`);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.inFlightEdits.clear();
        this.lastEditTimes.clear();
        this.lastRenderedPositions.clear();
        logger.info('[PROGRESS-DIAG] Stopped shared playback progress manager');
    }

    clearGuild(guildId) {
        this.inFlightEdits.delete(guildId);
        this.lastEditTimes.delete(guildId);
        this.lastRenderedPositions.delete(guildId);
    }

    onTrackStart(guildId) {
        this.clearGuild(guildId);
        this.lastEditTimes.set(guildId, Date.now());
    }

    onTrackEnd(guildId) {
        this.clearGuild(guildId);
    }

    onPlaybackStateChange(guildId) {
        // Reset rate limit guard so immediate in-place update can proceed without delay
        this.lastEditTimes.delete(guildId);
    }

    async tick() {
        if (!this.client?.guilds?.cache) return;

        const guildsToCheck = Array.from(this.client.guilds.cache.keys());
        const now = Date.now();
        const updatePromises = [];

        for (const guildId of guildsToCheck) {
            const player = this.client.lavalink?.getPlayer ? this.client.lavalink.getPlayer(guildId) : null;
            if (!player || !player.queue?.current) continue;

            // Only tick for actively playing, non-paused, non-stopped normal tracks
            if (player.paused || player.stopped || !player.playing) continue;
            if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) continue;

            const track = player.queue.current;
            // Livestreams and tracks with no valid duration have static indicators
            if (track.info?.isStream || !track.info?.duration || track.info.duration <= 0) continue;

            // Check if dashboard exists
            const dashboard = this.client.playerController?.getDashboard(guildId);
            if (!dashboard?.messageId || !dashboard?.channelId) continue;

            // Coalesce: skip if an edit is currently in-flight for this guild
            if (this.inFlightEdits.has(guildId)) continue;

            // Enforce minimum edit interval to respect Discord message edit rate limits
            const lastEdit = this.lastEditTimes.get(guildId) || 0;
            if (now - lastEdit < this.minEditIntervalMs) continue;

            const updatePromise = this.updateGuildProgress(guildId, player, dashboard, track).catch((err) => {
                logger.debug(`[PROGRESS-DIAG] Failed to update progress for guild ${guildId}:`, err?.message || err);
            });
            updatePromises.push(updatePromise);
        }

        if (updatePromises.length > 0) {
            await Promise.allSettled(updatePromises);
        }
    }

    async updateGuildProgress(guildId, player, dashboard, track) {
        this.inFlightEdits.add(guildId);
        try {
            const channel = this.client.channels?.cache?.get(dashboard.channelId)
                || (this.client.channels?.fetch ? await this.client.channels.fetch(dashboard.channelId).catch(() => null) : null);
            if (!channel) return;

            let message = channel.messages?.cache?.get(dashboard.messageId);
            if (!message && channel.messages?.fetch) {
                try {
                    message = await channel.messages.fetch(dashboard.messageId);
                } catch (fetchErr) {
                    if (fetchErr.code === 10008) {
                        logger.warn(`[PROGRESS-DIAG] Dashboard message ${dashboard.messageId} was deleted externally for guild ${guildId}. Clearing stale reference and recovering dashboard.`);
                        if (this.client.playerController?.getDashboard(guildId)?.messageId === dashboard.messageId) {
                            this.client.playerController.deleteDashboard(guildId);
                        }
                        if (player && player.queue?.current && !player.stopped) {
                            this.client.playerController?.replaceWithFullDashboard?.(guildId, dashboard.channelId, { track: player.queue.current, reason: 'deleted_recovery' })?.catch?.(() => {});
                        }
                    }
                    return;
                }
            }
            if (!message || typeof message.edit !== 'function') return;

            // Re-verify that player is still actively playing the exact same track
            if (!player.playing || player.paused || player.stopped || !player.queue?.current) return;
            if (isManualStopActive(guildId) || player.getData?.("internal_stopPlaying") || player.getData?.("internal_autoplayStopPlaying")) return;
            if (player.queue.current !== track && player.queue.current.info?.identifier !== track.info?.identifier) return;

            // Verify the stored dashboard message is still this exact message
            const currentDash = this.client.playerController?.getDashboard(guildId);
            if (currentDash?.messageId !== dashboard.messageId) return;

            const embed = this.client.playerController.createPlayerEmbed(player, player.queue.current);
            const components = this.client.playerController.createPlayerButtons(player);

            await message.edit({ embeds: [embed], components });
            this.lastEditTimes.set(guildId, Date.now());
        } catch (error) {
            if (error.code === 10008) {
                // Unknown Message (was deleted externally)
                logger.warn(`[PROGRESS-DIAG] Dashboard message ${dashboard.messageId} was deleted externally for guild ${guildId}. Clearing stale reference and recovering dashboard.`);
                if (this.client.playerController?.getDashboard(guildId)?.messageId === dashboard.messageId) {
                    this.client.playerController.deleteDashboard(guildId);
                }
                if (player && player.queue?.current && !player.stopped) {
                    this.client.playerController?.replaceWithFullDashboard?.(guildId, dashboard.channelId, { track: player.queue.current, reason: 'deleted_recovery' })?.catch?.(() => {});
                }
            } else if (error.status === 429 || error.code === 429) {
                // Rate limited: back off
                const retryAfter = ((error.retry_after || 5) * 1000);
                this.lastEditTimes.set(guildId, Date.now() + retryAfter);
                logger.warn(`[PROGRESS-DIAG] Discord rate limited progress edit on guild ${guildId}, backoff ${retryAfter}ms`);
            } else {
                logger.debug(`[PROGRESS-DIAG] Error during progress edit for guild ${guildId}:`, error?.message || error);
            }
        } finally {
            this.inFlightEdits.delete(guildId);
        }
    }
}

module.exports = PlaybackProgressManager;
