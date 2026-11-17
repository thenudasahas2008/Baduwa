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

    /**
     * Proactively discovers and restores 24/7 settings from live Discord state across restarts/updates:
     * 1. Inspects active Discord voice channel presence of the bot member.
     * 2. Scans recent bot dashboard embeds for "24/7 Mode Active" markers and voice channel mentions.
     * 3. Fallback resolution to active or canonical voice channels when 24/7 is enabled.
     */
    async discoverAndRestoreFromDiscord(client) {
        if (!client?.guilds?.cache) return;

        for (const [guildId, guild] of client.guilds.cache.entries()) {
            try {
                let current = this.cache.get(guildId) || {};
                let is247 = Boolean(current.twentyFourSeven);
                let voiceChannelId = current.voiceChannelId;
                let textChannelId = current.textChannelId;

                // 1. If bot is currently in a voice channel in this guild, preserve it immediately
                const botMember = guild.members?.me
                    || (typeof guild.members?.fetch === 'function' ? await guild.members.fetch(client.user?.id).catch(() => null) : null);
                if (botMember?.voice?.channelId) {
                    voiceChannelId = botMember.voice.channelId;
                    is247 = true;
                    logger.info(`[247-PERSIST] Auto-detected active voice connection in #${voiceChannelId} for guild ${guild.name || guildId}. Preserving 24/7 presence across update.`);
                }

                // 2. If not yet determined, search recent channels for existing dashboard with "24/7 Mode Active"
                if (!is247 || !voiceChannelId) {
                    const channels = guild.channels?.cache ? Array.from(guild.channels.cache.values()) : [];
                    for (const ch of channels) {
                        if (!ch.isTextBased?.() || typeof ch.messages?.fetch !== 'function') continue;
                        try {
                            const perms = ch.permissionsFor?.(botMember);
                            if (perms && (!perms.has('ViewChannel') || !perms.has('ReadMessageHistory'))) continue;

                            const recentMsgs = await ch.messages.fetch({ limit: 10 }).catch(() => null);
                            if (!recentMsgs) continue;

                            for (const [, msg] of recentMsgs) {
                                if (msg.author?.id !== client.user?.id) continue;
                                const embed = msg.embeds?.[0];
                                if (!embed) continue;

                                const footerText = embed.footer?.text || '';
                                const descText = embed.description || '';

                                if (footerText.includes('24/7 Mode Active') || descText.includes('remains connected in')) {
                                    is247 = true;
                                    textChannelId = ch.id;

                                    const match = descText.match(/<#(\d+)>/);
                                    if (match && match[1]) {
                                        voiceChannelId = match[1];
                                    } else if (ch.isVoiceBased?.()) {
                                        voiceChannelId = ch.id;
                                    }
                                    logger.info(`[247-PERSIST] Discovered previous 24/7 dashboard in #${ch.name} (voice: #${voiceChannelId || 'unknown'}) for guild ${guild.name || guildId}`);
                                    break;
                                }
                            }
                            if (is247 && voiceChannelId) break;
                        } catch (_) {}
                    }
                }

                // 3. Fallback for 24/7 enabled guilds without a specific voice channel:
                // If 24/7 is enabled (or DEFAULT_247_ENABLED=true) but voiceChannelId is still unset,
                // pick the best voice channel (channel with human members, or named game/music/voice/general)
                if ((is247 || process.env.DEFAULT_247_ENABLED === 'true') && !voiceChannelId) {
                    const voiceChannels = guild.channels?.cache
                        ? Array.from(guild.channels.cache.values()).filter(c => (typeof c.isVoiceBased === 'function' && c.isVoiceBased()) || c.type === 2 || c.type === 13)
                        : [];

                    let bestVc = voiceChannels.find(c => {
                        const humanMembers = c.members ? Array.from(c.members.values()).filter(m => !m.user?.bot) : [];
                        return humanMembers.length > 0;
                    });

                    if (!bestVc) {
                        bestVc = voiceChannels.find(c => /game|music|voice|chill|general/i.test(c.name));
                    }

                    if (!bestVc && voiceChannels.length > 0) {
                        bestVc = voiceChannels.find(c => {
                            const p = c.permissionsFor?.(botMember);
                            return !p || p.has('Connect');
                        }) || voiceChannels[0];
                    }

                    if (bestVc) {
                        voiceChannelId = bestVc.id;
                        is247 = true;
                        logger.info(`[247-PERSIST] Resolved voice channel #${bestVc.name} (${bestVc.id}) for 24/7 guild ${guild.name || guildId}`);
                    }
                }

                if (is247) {
                    this.set247(guildId, true, { voiceChannelId, textChannelId });
                    if (typeof this.get(guildId).autoplay !== 'boolean') {
                        this.setAutoplay(guildId, true);
                    }
                }
            } catch (err) {
                logger.debug(`[247-PERSIST] Discovery error for guild ${guildId}:`, err?.message || err);
            }
        }
    }
}

module.exports = new GuildSettingsManager();
