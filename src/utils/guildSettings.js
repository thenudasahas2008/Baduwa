const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SETTINGS_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'guild-settings.json');

class GuildSettingsManager {
    constructor() {
        this.cache = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(SETTINGS_FILE)) {
                const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
                const data = JSON.parse(raw);
                if (data && typeof data === 'object') {
                    for (const [guildId, settings] of Object.entries(data)) {
                        this.cache.set(guildId, settings);
                    }
                }
            }
        } catch (err) {
            logger.warn('Failed to load guild settings from disk:', err?.message || err);
        }

        // Support environment-seeded 24/7 settings (survives ephemeral container restarts)
        const envGuildId = process.env.TWENTY_FOUR_SEVEN_GUILD_ID || process.env.DEFAULT_247_GUILD_ID;
        const envVoiceChannelId = process.env.TWENTY_FOUR_SEVEN_VOICE_CHANNEL_ID || process.env.DEFAULT_247_VOICE_CHANNEL_ID || process.env.DEFAULT_247_CHANNEL;
        if (envGuildId) {
            const current = this.cache.get(envGuildId) || {};
            this.cache.set(envGuildId, {
                ...current,
                twentyFourSeven: true,
                voiceChannelId: envVoiceChannelId || current.voiceChannelId,
            });
        }
    }

    save() {
        if (this._saveTimer) {
            return;
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.saveAsync().catch(() => {});
        }, 150);
        if (typeof this._saveTimer.unref === 'function') {
            this._saveTimer.unref();
        }
    }

    async saveAsync() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        try {
            if (!fs.existsSync(SETTINGS_DIR)) {
                await fs.promises.mkdir(SETTINGS_DIR, { recursive: true });
            }
            const obj = Object.fromEntries(this.cache);
            await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
        } catch (err) {
            logger.warn('Failed to save guild settings to disk asynchronously:', err?.message || err);
        }
    }

    saveSync() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        try {
            if (!fs.existsSync(SETTINGS_DIR)) {
                fs.mkdirSync(SETTINGS_DIR, { recursive: true });
            }
            const obj = Object.fromEntries(this.cache);
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
        } catch (err) {
            logger.warn('Failed to save guild settings to disk:', err?.message || err);
        }
    }

    get(guildId) {
        return this.cache.get(guildId) || {};
    }

    getDashboard(guildId) {
        const settings = this.get(guildId);
        if (settings.dashboardMessageId && settings.dashboardChannelId) {
            return {
                messageId: settings.dashboardMessageId,
                channelId: settings.dashboardChannelId,
            };
        }
        if (settings.dashboard?.messageId && settings.dashboard?.channelId) {
            return {
                messageId: settings.dashboard.messageId,
                channelId: settings.dashboard.channelId,
            };
        }
        return null;
    }

    setDashboard(guildId, { messageId, channelId }) {
        const current = this.get(guildId);
        const updated = {
            ...current,
            dashboardMessageId: messageId,
            dashboardChannelId: channelId,
        };
        this.cache.set(guildId, updated);
        this.save();
        return updated;
    }

    deleteDashboard(guildId) {
        const current = this.get(guildId);
        if (!current.dashboardMessageId && !current.dashboardChannelId && !current.dashboard) {
            return;
        }
        const updated = { ...current };
        delete updated.dashboardMessageId;
        delete updated.dashboardChannelId;
        delete updated.dashboard;
        this.cache.set(guildId, updated);
        this.save();
    }

    is247(guildId) {
        if (!guildId) return false;
        const s = this.get(guildId);
        if (typeof s.twentyFourSeven === 'boolean') {
            return s.twentyFourSeven;
        }
        if (process.env.DEFAULT_247_ENABLED === 'true') {
            return true;
        }
        const envGuildId = process.env.TWENTY_FOUR_SEVEN_GUILD_ID || process.env.DEFAULT_247_GUILD_ID;
        if (envGuildId && envGuildId === guildId) {
            return true;
        }
        return false;
    }

    set247(guildId, enabled, options = {}) {
        const current = this.get(guildId);
        const updated = {
            ...current,
            twentyFourSeven: Boolean(enabled),
        };

        if (enabled) {
            if (options.voiceChannelId) {
                updated.voiceChannelId = options.voiceChannelId;
            }
            if (options.textChannelId) {
                updated.textChannelId = options.textChannelId;
            }
        } else {
            delete updated.voiceChannelId;
            delete updated.textChannelId;
        }

        this.cache.set(guildId, updated);
        this.save();
        return updated;
    }

    updateTextChannelId(guildId, channelId) {
        if (!guildId || !channelId) return this.get(guildId);
        const current = this.get(guildId);
        if (current.textChannelId === channelId) {
            return current;
        }
        const updated = {
            ...current,
            textChannelId: channelId,
        };
        this.cache.set(guildId, updated);
        this.save();
        return updated;
    }

    invalidateVoiceChannel(guildId) {
        if (!guildId) return this.get(guildId);
        const current = this.get(guildId);
        if (!current.voiceChannelId) {
            return current;
        }
        const updated = { ...current };
        delete updated.voiceChannelId;
        this.cache.set(guildId, updated);
        this.save();
        return updated;
    }

    invalidateTextChannel(guildId) {
        if (!guildId) return this.get(guildId);
        const current = this.get(guildId);
        if (!current.textChannelId) {
            return current;
        }
        const updated = { ...current };
        delete updated.textChannelId;
        this.cache.set(guildId, updated);
        this.save();
        return updated;
    }

    isAutoplay(guildId) {
        const val = this.get(guildId).autoplay;
        if (typeof val === 'boolean') {
            return val;
        }
        return process.env.AUTOPLAY_DEFAULT === 'true';
    }

    setAutoplay(guildId, enabled) {
        const current = this.get(guildId);
        const updated = {
            ...current,
            autoplay: Boolean(enabled),
        };
        this.cache.set(guildId, updated);
        this.save();
        return updated;
    }

    delete(guildId) {
        if (this.cache.delete(guildId)) {
            this.save();
        }
    }

    isWelcomeMigrated(guildId) {
        return Boolean(this.get(guildId).welcomeMigrated);
    }

    setWelcomeMigrated(guildId, { messageId, channelId } = {}) {
        const current = this.get(guildId);
        const updated = {
            ...current,
            welcomeMigrated: true,
        };
        if (messageId) updated.welcomeMessageId = messageId;
        if (channelId) updated.welcomeChannelId = channelId;
        this.cache.set(guildId, updated);
        this.save();
        return updated;
    }
}

module.exports = new GuildSettingsManager();
