const { ActivityType } = require('discord.js');
const logger = require('./logger');

const ROTATION_INTERVAL_MS = 240000; // 4 minutes (240,000 ms)

const ACTIVITIES = [
    '🎵 Taking song requests',
    '🎧 Music on demand',
    '🎶 Use /play to start',
    '🔎 Find your next song • /search',
    '📜 Lyrics available • /lyrics',
    '🎛️ Shuffle your vibe',
    '🔁 Loop your favorites',
    '📋 Managing the queue • /queue',
    '🎤 Your server\'s music',
    '⏭️ Ready for the next track',
    '🎼 Autoplay your playlist',
    '🔊 Your music, your rules',
    '🎵 Requests open • /play',
    '🎚️ Music controls • /help',
    '🌐 Music in {serverCount} servers',
];

class ActivityManager {
    /**
     * Centralized manager for rotating ZYRO music-themed activities.
     * @param {object} client - Discord client instance
     * @param {object} [options]
     * @param {number} [options.intervalMs=240000] - Rotation interval in milliseconds
     * @param {string[]} [options.activities] - Custom activity templates
     * @param {number} [options.activityType=ActivityType.Custom] - ActivityType to use (Custom, Playing, Listening)
     */
    constructor(client, options = {}) {
        this.client = client;
        this.currentIndex = 0;
        this.rotationTimer = null;
        this.intervalMs = options.intervalMs || ROTATION_INTERVAL_MS;
        this.activities = Array.isArray(options.activities) && options.activities.length > 0
            ? [...options.activities]
            : [...ACTIVITIES];
        this.activityType = options.activityType !== undefined
            ? options.activityType
            : ActivityType.Custom;
    }

    /**
     * Formats an activity template string with live client metrics.
     * @param {string} template
     * @returns {string}
     */
    formatActivity(template) {
        if (typeof template !== 'string') return '';
        const serverCount = this.client?.guilds?.cache?.size || 0;
        return template.replace('{serverCount}', String(serverCount));
    }

    /**
     * Resolves the current activity text with dynamic parameters substituted.
     * @returns {string}
     */
    getCurrentActivityText() {
        const template = this.activities[this.currentIndex] || this.activities[0];
        return this.formatActivity(template);
    }

    /**
     * Constructs a valid Discord presence payload compliant with Discord.js v14.
     * When using ActivityType.Custom (type 4), text must be placed in `state` with `name: 'Custom Status'`.
     * @param {string} text
     * @returns {object}
     */
    buildPresencePayload(text) {
        if (this.activityType === ActivityType.Custom) {
            return {
                activities: [{
                    name: 'Custom Status',
                    type: ActivityType.Custom,
                    state: text,
                }],
                status: 'online',
            };
        }

        return {
            activities: [{
                name: text,
                type: this.activityType,
            }],
            status: 'online',
        };
    }

    /**
     * Applies the current activity to Discord presence if appropriate.
     * If music is actively playing in guilds, allows music presence to take precedence.
     * @param {boolean} [force=false]
     */
    applyCurrentActivity(force = false) {
        if (!this.client?.user) {
            return;
        }

        // If active players are playing music, music presence takes precedence unless forced
        const activeCount = this.client.activePlayers?.size || 0;
        if (!force && activeCount > 0) {
            logger.debug(`Rotation advanced to index ${this.currentIndex}, but active music playback takes presence precedence`);
            return;
        }

        try {
            const text = this.getCurrentActivityText();
            const payload = this.buildPresencePayload(text);

            if (typeof this.client.user.setPresence === 'function') {
                this.client.user.setPresence(payload);
            } else if (typeof this.client.presence?.set === 'function') {
                this.client.presence.set(payload);
            } else if (typeof this.client.user.setActivity === 'function') {
                if (this.activityType === ActivityType.Custom) {
                    this.client.user.setActivity({
                        name: 'Custom Status',
                        type: ActivityType.Custom,
                        state: text,
                    });
                } else {
                    this.client.user.setActivity(text, { type: this.activityType });
                }
            }

            logger.info(`Updated bot activity [index ${this.currentIndex + 1}/${this.activities.length}]: "${text}"`);
        } catch (err) {
            logger.warn('Failed to set rotating activity:', err?.message || err);
        }
    }

    /**
     * Sets music listening presence when one or more guilds are actively playing tracks.
     * @param {string} text
     */
    setMusicPresence(text) {
        if (!this.client?.user) {
            return;
        }

        try {
            const payload = {
                activities: [{
                    name: text,
                    type: ActivityType.Listening,
                }],
                status: 'online',
            };

            if (typeof this.client.user.setPresence === 'function') {
                this.client.user.setPresence(payload);
            } else if (typeof this.client.presence?.set === 'function') {
                this.client.presence.set(payload);
            } else if (typeof this.client.user.setActivity === 'function') {
                this.client.user.setActivity(text, { type: ActivityType.Listening });
            }

            logger.debug(`Updated music presence: Listening to "${text}"`);
        } catch (err) {
            logger.debug('Failed to set music presence:', err?.message || err);
        }
    }

    /**
     * Centralized presence coordinator.
     * Handles active music players vs idle rotating statuses.
     */
    updatePresence() {
        const activeCount = this.client?.activePlayers?.size || 0;
        if (activeCount === 0) {
            this.applyCurrentActivity();
        } else if (activeCount === 1) {
            const text = typeof this.client.t === 'function'
                ? this.client.t('PLAYING_MUSIC_GENERIC')
                : 'music';
            this.setMusicPresence(text);
        } else {
            const text = typeof this.client.t === 'function'
                ? this.client.t('PLAYING_MUSIC_IN_SERVERS', activeCount)
                : `music in ${activeCount} servers`;
            this.setMusicPresence(text);
        }
    }

    /**
     * Advances to the next activity in the list and applies it.
     * @param {boolean} [force=false]
     * @returns {string} The newly applied activity text
     */
    rotateNext(force = false) {
        this.currentIndex = (this.currentIndex + 1) % this.activities.length;
        this.applyCurrentActivity(force);
        return this.getCurrentActivityText();
    }

    /**
     * Starts the activity rotation timer.
     * Ensures only one timer is active, even across reconnects or repeated ready events.
     */
    start() {
        // Clear any existing timer to prevent duplicates on reconnects or repeated ready events
        this.stop();

        logger.info(`Activity rotation manager started (interval: ${this.intervalMs}ms, active index: ${this.currentIndex}, activity: "${this.getCurrentActivityText()}")`);

        // Immediately apply the current activity
        this.applyCurrentActivity();

        // Schedule periodic rotation every 4 minutes (240,000 ms)
        this.rotationTimer = setInterval(() => {
            this.rotateNext();
        }, this.intervalMs);

        if (typeof this.rotationTimer.unref === 'function') {
            this.rotationTimer.unref();
        }
    }

    /**
     * Stops the rotation timer cleanly.
     */
    stop() {
        if (this.rotationTimer) {
            clearInterval(this.rotationTimer);
            this.rotationTimer = null;
        }
    }

    /**
     * Checks if the rotation timer is currently running.
     * @returns {boolean}
     */
    isRunning() {
        return this.rotationTimer !== null;
    }
}

module.exports = {
    ROTATION_INTERVAL_MS,
    ACTIVITIES,
    ActivityManager,
};
