const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const { getValidVolume } = require('../utils/volumeValidator');
const { clearQueueEndTimeout } = require('../utils/playerLifecycle');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const { clearEmptyChannelTimeout, scheduleEmptyChannelTimeout, countHumanMembers } = require('../events/voiceStateUpdate');
const { safeReply } = require('../utils/interactionHelpers');
const twentyFourSevenManager = require('../utils/twentyFourSevenManager');
const logger = require('../utils/logger');

// Per-guild in-flight lock to guarantee exactly one toggle at a time and prevent race conditions
const inFlight247Toggles = new Set();

function sanitize(msg) {
    if (!msg) return '';
    return String(msg).replace(/[\w-]{24,26}\.[\w-]{6}\.[\w-]{27,38}/g, '[REDACTED_DISCORD_TOKEN]');
}

/**
 * Executes a background, bounded voice audit to reconcile Lavalink player connection if needed.
 * Strictly non-blocking: never prevents the /247 toggle response from finalizing immediately.
 */
function scheduleBackground247Audit(client, guildId, targetChannelId, newState, correlationId) {
    setImmediate(async () => {
        const auditStart = Date.now();
        logger.info(`[247-DIAG] [247_BACKGROUND_AUDIT_STARTED] id=${correlationId} guild=${guildId} newState=${newState}`);

        try {
            if (newState && targetChannelId && client?.lavalink) {
                const player = client.lavalink.getPlayer ? client.lavalink.getPlayer(guildId) : null;
                const guild = client.guilds?.cache?.get(guildId);
                const botVoiceChannelId = player?.voiceChannelId || guild?.members?.me?.voice?.channelId;

                // If bot is not in voice, attempt connection in background with a tight 3.5s timeout
                if (!botVoiceChannelId) {
                    let auditPlayer = player;
                    if (!auditPlayer) {
                        auditPlayer = client.lavalink.createPlayer({
                            guildId,
                            voiceChannelId: targetChannelId,
                            textChannelId: targetChannelId,
                            selfDeaf: true,
                            selfMute: false,
                            volume: getValidVolume(process.env.DEFAULT_VOLUME, 80),
                        });
                    }

                    if (auditPlayer && !auditPlayer.connected) {
                        await Promise.race([
                            auditPlayer.connect(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Voice connect timed out in background audit')), 3500))
                        ]).catch((err) => {
                            logger.debug(`[247-DIAG] Background voice connect in guild ${guildId} caught:`, err?.message || err);
                        });
                    }
                }
            }

            const durationMs = Date.now() - auditStart;
            logger.info(`[247-DIAG] [247_BACKGROUND_AUDIT_COMPLETED] id=${correlationId} guild=${guildId} durationMs=${durationMs}ms`);
        } catch (auditErr) {
            logger.warn(`[247-DIAG] Background audit error in guild ${guildId}:`, auditErr?.message || auditErr);
        }
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('247')
        .setDescription('Toggles 24/7 mode to keep the bot connected in the voice channel.'),

    async execute(interaction) {
        const startHr = process.hrtime.bigint();
        const correlationId = interaction?.id || `247_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const guildId = interaction?.guildId || interaction?.guild?.id;
        const userTag = interaction?.user?.tag || interaction?.user?.id || 'unknown';

        function getElapsedMs(fromHr) {
            return (Number(process.hrtime.bigint() - fromHr) / 1_000_000).toFixed(2);
        }

        logger.info(`[247-DIAG] [247_RECEIVED] id=${correlationId} guild=${guildId || 'NONE'} user="${userTag}"`);

        // Defer interaction if not yet deferred or replied to prevent Discord interaction expiration
        if (typeof interaction?.deferReply === 'function' && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        // 1. Validate that the command is running inside a valid guild
        if (!guildId) {
            logger.warn(`[247-DIAG] [247_FAILURE] id=${correlationId} guild=NONE stage=GUILD_VALIDATION error="Cannot execute 247 in DM" category="INVALID_GUILD"`);
            return await safeReply(interaction, {
                content: 'Music commands can only be used in a Discord server.',
                flags: MessageFlags.Ephemeral,
                _isFinalReply: true
            });
        }

        // Concurrency Guard: prevent simultaneous /247 commands in the same guild
        if (inFlight247Toggles.has(guildId)) {
            logger.warn(`[247-DIAG] [247_FAILURE] id=${correlationId} guild=${guildId} stage=CONCURRENCY_LOCK error="Duplicate 247 toggle already in flight" category="CONCURRENT_LOCK"`);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('warning', 'Operation In Progress', 'A 24/7 mode toggle is already in progress for this server. Please wait a moment.')],
                flags: MessageFlags.Ephemeral,
                _isFinalReply: true
            });
        }

        inFlight247Toggles.add(guildId);

        let currentStage = 'INITIALIZATION';
        try {
            const client = interaction.client;
            const guild = interaction.guild;
            const member = interaction.member;

            if (interaction.deferred) {
                logger.info(`[247-DIAG] [247_ACKNOWLEDGED] id=${correlationId} guild=${guildId} durationMs=${getElapsedMs(startHr)}ms`);
            } else {
                logger.info(`[247-DIAG] [247_IMMEDIATE_REPLY_STARTED] id=${correlationId} guild=${guildId} durationMs=${getElapsedMs(startHr)}ms`);
            }

            // Resolve voice channel and member
            const memberVoiceChannel = member?.voice?.channel;
            const memberVoiceChannelId = member?.voice?.channelId || memberVoiceChannel?.id;
            let player = client?.lavalink?.getPlayer ? client.lavalink.getPlayer(guildId) : null;
            const botVoiceChannel = guild?.members?.me?.voice?.channel;
            const botVoiceChannelId = player?.voiceChannelId || botVoiceChannel?.id;

            const targetVoiceChannel = memberVoiceChannel || botVoiceChannel;
            const targetChannelId = memberVoiceChannelId || botVoiceChannelId;

            // 2. Read the actual current 24/7 state using the supported state manager
            currentStage = 'STATE_READ';
            const stateReadStart = process.hrtime.bigint();
            const currentState = Boolean(
                typeof client?.is247Enabled === 'function'
                    ? client.is247Enabled(guildId)
                    : (client?.guildSettings?.is247 ? client.guildSettings.is247(guildId) : false)
            );
            logger.info(`[247-DIAG] [247_STATE_READ] id=${correlationId} guild=${guildId} currentState=${currentState} durationMs=${getElapsedMs(stateReadStart)}ms`);

            // 3. Toggle the state exactly once
            currentStage = 'STATE_TOGGLE';
            const stateChangeStart = process.hrtime.bigint();
            const newState = !currentState;
            logger.info(`[247-DIAG] [247_STATE_CHANGED] id=${correlationId} guild=${guildId} from=${currentState} to=${newState} durationMs=${getElapsedMs(stateChangeStart)}ms`);

            // If enabling, validate voice channel presence and permissions
            if (newState) {
                if (!targetChannelId) {
                    logger.warn(`[247-DIAG] [247_FAILURE] id=${correlationId} guild=${guildId} stage=CHANNEL_VALIDATION error="No voice channel available" category="MISSING_VOICE_CHANNEL"`);
                    return await safeReply(interaction, {
                        embeds: [createActionEmbed('warning', 'Voice Channel Required', 'You must be in a voice channel to configure 24/7 mode.')],
                        flags: MessageFlags.Ephemeral,
                        _isFinalReply: true
                    });
                }

                // If user is in a different voice channel than the bot
                if (player && botVoiceChannelId && memberVoiceChannelId && botVoiceChannelId !== memberVoiceChannelId) {
                    logger.warn(`[247-DIAG] [247_FAILURE] id=${correlationId} guild=${guildId} stage=CHANNEL_MISMATCH error="User in different voice channel" category="VOICE_CHANNEL_MISMATCH"`);
                    return await safeReply(interaction, {
                        embeds: [createActionEmbed('warning', 'Different Voice Channel', 'You need to be in the same voice channel as ZYRO.')],
                        flags: MessageFlags.Ephemeral,
                        _isFinalReply: true
                    });
                }

                // Permission check
                const botMember = guild?.members?.me || (typeof guild?.members?.fetchMe === 'function' ? await guild.members.fetchMe().catch(() => null) : null);
                if (botMember && targetVoiceChannel && typeof targetVoiceChannel.permissionsFor === 'function') {
                    const permissions = targetVoiceChannel.permissionsFor(botMember);
                    if (permissions && typeof permissions.has === 'function') {
                        if (!permissions.has(PermissionsBitField.Flags.Connect)) {
                            logger.warn(`[247-DIAG] [247_FAILURE] id=${correlationId} guild=${guildId} stage=PERMISSION_CHECK error="Missing Connect" category="MISSING_PERMISSIONS"`);
                            return await safeReply(interaction, {
                                embeds: [createActionEmbed('error', 'Missing Permissions', 'ZYRO does not have permission to **Connect** to your voice channel.')],
                                flags: MessageFlags.Ephemeral,
                                _isFinalReply: true
                            });
                        }
                        if (!permissions.has(PermissionsBitField.Flags.Speak)) {
                            logger.warn(`[247-DIAG] [247_FAILURE] id=${correlationId} guild=${guildId} stage=PERMISSION_CHECK error="Missing Speak" category="MISSING_PERMISSIONS"`);
                            return await safeReply(interaction, {
                                embeds: [createActionEmbed('error', 'Missing Permissions', 'ZYRO does not have permission to **Speak** in your voice channel.')],
                                flags: MessageFlags.Ephemeral,
                                _isFinalReply: true
                            });
                        }
                    }
                }

                // Connect player if needed (bounded timeout to prevent hanging the command)
                if (!player && client?.lavalink?.createPlayer) {
                    player = client.lavalink.createPlayer({
                        guildId,
                        voiceChannelId: targetChannelId,
                        textChannelId: interaction.channelId || interaction.channel?.id || targetChannelId,
                        selfDeaf: true,
                        selfMute: false,
                        volume: getValidVolume(process.env.DEFAULT_VOLUME, 80),
                    });
                }

                if (player && !player.connected && typeof player.connect === 'function') {
                    // Initiate player voice connection without blocking the interaction response
                    player.connect().catch((connErr) => {
                        logger.warn(`[247-DIAG] player.connect failed in guild ${guildId}:`, connErr?.message || connErr);
                    });
                }
            }

            // 4. Persist or update the state through the existing supported mechanism
            currentStage = 'PERSISTENCE';
            const persistStart = process.hrtime.bigint();
            const textChannelId = interaction.channelId || interaction.channel?.id || targetChannelId;

            if (typeof client?.set247 === 'function') {
                client.set247(guildId, newState, newState ? { voiceChannelId: targetChannelId, textChannelId } : {});
            } else if (typeof client?.guildSettings?.set247 === 'function') {
                client.guildSettings.set247(guildId, newState, newState ? { voiceChannelId: targetChannelId, textChannelId } : {});
            }

            // Verify persistence
            const persistedCheck = Boolean(
                typeof client?.is247Enabled === 'function'
                    ? client.is247Enabled(guildId)
                    : (client?.guildSettings?.is247 ? client.guildSettings.is247(guildId) : false)
            );
            if (persistedCheck !== newState) {
                throw new Error(`State persistence mismatch: expected ${newState}, got ${persistedCheck}`);
            }

            logger.info(`[247-DIAG] [247_PERSISTENCE_COMPLETED] id=${correlationId} guild=${guildId} newState=${newState} durationMs=${getElapsedMs(persistStart)}ms`);

            // 5. Apply the voice-retention policy
            currentStage = 'VOICE_POLICY';
            const policyStart = process.hrtime.bigint();

            if (newState) {
                // Cancel pending recovery attempts
                twentyFourSevenManager.cancelRecovery(guildId, 'command_toggle_on');

                // Cancel disconnect and empty-channel timers
                clearQueueEndTimeout(guildId);
                clearEmptyChannelTimeout(guildId);

                if (player) {
                    player.set?.('twentyFourSeven', true);
                    if (player.options) player.options.twentyFourSeven = true;
                    if (typeof player.getData === 'function' && player.getData('internal_queueempty')) {
                        clearTimeout(player.getData('internal_queueempty'));
                        player.setData('internal_queueempty', void 0);
                    }
                }
            } else {
                // Cancel pending recovery
                twentyFourSevenManager.cancelRecovery(guildId, 'command_toggle_off');

                if (player) {
                    player.set?.('twentyFourSeven', false);
                    if (player.options) player.options.twentyFourSeven = false;
                }

                // If voice channel is currently empty of humans, schedule empty channel timeout
                const currentVoiceChannelId = player?.voiceChannelId || botVoiceChannelId || targetChannelId;
                const vc = currentVoiceChannelId ? guild?.channels?.cache?.get(currentVoiceChannelId) : null;
                if (vc) {
                    const humans = countHumanMembers(vc);
                    if (humans === 0) {
                        scheduleEmptyChannelTimeout(client, guildId, currentVoiceChannelId);
                    } else {
                        clearEmptyChannelTimeout(guildId);
                    }
                }
            }

            logger.info(`[247-DIAG] [247_VOICE_POLICY_APPLIED] id=${correlationId} guild=${guildId} newState=${newState} durationMs=${getElapsedMs(policyStart)}ms`);

            // 6. Return a clear final response
            currentStage = 'RESPONSE_DELIVERY';
            const respStart = process.hrtime.bigint();
            const embed = newState
                ? createActionEmbed(
                    'info',
                    '24/7 Mode Enabled',
                    '24/7 Mode Enabled — ZYRO will remain connected to the configured voice channel when playback stops, as long as the connection and channel remain available.'
                )
                : createActionEmbed(
                    'info',
                    '24/7 Mode Disabled',
                    '24/7 Mode Disabled — normal idle-disconnect behavior is restored.'
                );

            logger.info(`[247-DIAG] [247_RESPONSE_ATTEMPT] id=${correlationId} guild=${guildId} path="${interaction.deferred ? 'editReply' : 'reply'}"`);

            const replyResult = await safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
                _isFinalReply: true
            });

            logger.info(`[247-DIAG] [247_RESPONSE_COMPLETED] id=${correlationId} guild=${guildId} status=${replyResult ? 'SUCCESS' : 'DELIVERY_FAILED'} durationMs=${getElapsedMs(respStart)}ms totalMs=${getElapsedMs(startHr)}ms`);

            // 7. Schedule any long-running reconciliation or audit work separately, with bounded execution
            scheduleBackground247Audit(client, guildId, targetChannelId, newState, correlationId);

            return replyResult;

        } catch (error) {
            const errCategory = error?.code || error?.name || 'UNEXPECTED_ERROR';
            logger.error(`[247-DIAG] [247_FAILURE] id=${correlationId} guild=${guildId} stage=${currentStage} category="${errCategory}" durationMs=${getElapsedMs(startHr)}ms error="${sanitize(error?.message || error)}"`);

            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Configuration Failed', 'An unexpected error occurred while toggling 24/7 mode. The setting was not changed.')],
                flags: MessageFlags.Ephemeral,
                _isFinalReply: true
            }).catch(() => null);
        } finally {
            inFlight247Toggles.delete(guildId);
        }
    }
};
