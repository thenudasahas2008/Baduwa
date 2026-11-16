const { MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { checkInteractionPermission } = require('../utils/permissionChecker');
const { handleSearchNavigation } = require('../interactions/searchNavigation');
const { handleFilterNavigation } = require('../interactions/filterNavigation');
const { RESPONSE_STATES, ensureDeferred, safeReply, requirePlayer, requireSameVoice, logInteractionDiag } = require('../utils/interactionHelpers');
const { stopPlayer, playPrevious, shuffleQueue, clearQueue, jumpToTrack, createPaginatedQueueResponse } = require('../utils/PlayerActions');
const { clearGuildLifecycleTimers, clearQueueEndTimeout, schedulePlayerUpdate } = require('../utils/playerLifecycle');
const { clearEmptyChannelTimeout, scheduleEmptyChannelTimeout, countHumanMembers } = require('./voiceStateUpdate');
const { createActionEmbed, formatDuration } = require('../utils/zyroEmbeds');
const guildSettings = require('../utils/guildSettings');
const { performanceMonitor } = require('../utils/performanceMonitor');
const { idempotencyTracker } = require('../utils/bulkheadManager');
const logger = require('../utils/logger');

// Debounce map to prevent rapid button-clicking race conditions
const playerActionCooldowns = new Map();

async function handlePlayerInteraction(interaction, action, args = []) {
    const { client } = interaction;
    const guildId = interaction.guildId || interaction.guild?.id;
    if (!guildId) {
        return safeReply(interaction, {
            content: 'Music controls can only be used in a Discord server voice channel.',
            flags: MessageFlags.Ephemeral
        });
    }
    const cooldownKey = `${guildId}:${interaction.user.id}:${action}`;
    const now = Date.now();

    if (playerActionCooldowns.has(cooldownKey) && (now - playerActionCooldowns.get(cooldownKey) < 450)) {
        return safeReply(interaction, {
            embeds: [createActionEmbed('info', 'Slow Down', 'Please wait a moment before clicking again.')],
            flags: MessageFlags.Ephemeral
        });
    }
    playerActionCooldowns.set(cooldownKey, now);

    if (action === 'queue') {
        const player = client.lavalink?.getPlayer ? client.lavalink.getPlayer(interaction.guild.id) : null;
        if (!player || (!player.queue?.current && player.queue?.tracks?.length === 0)) {
            return safeReply(interaction, {
                embeds: [createActionEmbed('info', 'Queue Empty', 'The queue is currently empty.')],
                flags: MessageFlags.Ephemeral
            });
        }
        const queueResponse = createPaginatedQueueResponse(client, player, 1);
        await safeReply(interaction, queueResponse);
        if (typeof client.playerController?.replaceWithFullDashboard === 'function') {
            await client.playerController.replaceWithFullDashboard(interaction.guild.id, interaction.channel.id, { reason: 'queue' }).catch(() => {});
        }
        return;
    }

    if (action === '247') {
        const gId = interaction.guildId || interaction.guild?.id;
        if (gId && typeof client.playerController?.replaceWithFullDashboard === 'function') {
            client.playerController.replaceWithFullDashboard(gId, interaction.channel?.id).catch(() => {});
        } else if (interaction.message?.editable && interaction.message.components?.length) {
            const cleanedRows = [];
            for (const row of interaction.message.components) {
                const filtered = (row.components || []).filter(c => {
                    const id = c.customId || c.data?.custom_id || '';
                    return id !== 'player:247' && !id.startsWith('player:seek');
                });
                if (filtered.length > 0) {
                    cleanedRows.push(new ActionRowBuilder().addComponents(filtered));
                }
            }
            interaction.message.edit({ components: cleanedRows }).catch(() => {});
        }
        return safeReply(interaction, {
            embeds: [createActionEmbed(
                'info',
                'Control Retired',
                'The 24/7 dashboard button has been retired. Use `/247` to toggle 24/7 voice mode.'
            )],
            flags: MessageFlags.Ephemeral
        });
    }

    if (action === 'seek') {
        if (interaction.message?.editable && interaction.message.components?.length) {
            const cleanedRows = [];
            for (const row of interaction.message.components) {
                const filtered = (row.components || []).filter(c => {
                    const id = c.customId || c.data?.custom_id || '';
                    return id !== 'player:247' && !id.startsWith('player:seek');
                });
                if (filtered.length > 0) {
                    cleanedRows.push(new ActionRowBuilder().addComponents(filtered));
                }
            }
            interaction.message.edit({ components: cleanedRows }).catch(() => {});
        }
        return safeReply(interaction, {
            embeds: [createActionEmbed('info', 'Control Retired', 'Dashboard seek controls have been retired. Use `/seek <position>` to jump to a specific timestamp.')],
            flags: MessageFlags.Ephemeral
        });
    }

    const player = await requirePlayer(interaction);
    if (!player) return;

    const lang = client.defaultLanguage;

    const sameVoice = await requireSameVoice(interaction, player);
    if (!sameVoice) return;

    switch (action) {
        case 'back': {
            const track = await playPrevious(player);
            const embed = track
                ? createActionEmbed('success', 'Playing Previous Track', `Now playing [**${track.info?.title || 'Unknown'}**](${track.info?.uri || '#'})`)
                : createActionEmbed('info', 'No History', 'There are no previous tracks in history to replay.');
            await safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral
            });
            break;
        }
        case 'playpause': {
            if (player.paused) {
                try {
                    await Promise.race([
                        player.resume(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Resume timed out')), 3000))
                    ]);
                } catch (err) {
                    if (!err?.message?.includes("isn't paused")) {
                        logger.warn(`Failed to resume player in guild ${interaction.guild.id}:`, err?.message || err);
                    }
                }
                player.paused = false;
                client.voiceChannelStatusManager?.updateFromPlayer(player, player.queue?.current, 'playing').catch(() => {});
                schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });
                await safeReply(interaction, {
                    embeds: [createActionEmbed('success', 'Playback Resumed', 'Music playback has resumed.')],
                    flags: MessageFlags.Ephemeral
                });
            } else {
                try {
                    await Promise.race([
                        player.pause(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Pause timed out')), 3000))
                    ]);
                } catch (err) {
                    if (!err?.message?.includes("already paused")) {
                        logger.warn(`Failed to pause player in guild ${interaction.guild.id}:`, err?.message || err);
                    }
                }
                player.paused = true;
                client.voiceChannelStatusManager?.updateFromPlayer(player, player.queue?.current, 'paused').catch(() => {});
                schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });
                await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'Playback Paused', 'Music playback has been paused.')],
                    flags: MessageFlags.Ephemeral
                });
            }
            break;
        }
        case 'skip': {
            const skipAutoplay = client.autoplayEnabled.get(interaction.guild.id) || false;
            if (player.queue.tracks.length === 0 && player.repeatMode === 'off' && !skipAutoplay) {
                await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Queue Empty', 'There are no more tracks in the queue to skip to.')],
                    flags: MessageFlags.Ephemeral
                });
            } else {
                const currentTrack = player.queue.current;
                const nextTrack = player.queue.tracks[0];
                const skippedTitle = currentTrack?.info?.title || 'Current Track';

                try {
                    await Promise.race([
                        (player.queue.tracks.length === 0 && skipAutoplay) ? player.skip(0, false) : player.skip(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Skip timed out')), 3000))
                    ]);
                } catch (skipErr) {
                    logger.warn(`Warning during player.skip in guild ${interaction.guild.id}:`, skipErr?.message || skipErr);
                }

                const fields = [];
                if (nextTrack) {
                    fields.push({
                        name: 'Up Next',
                        value: `[${nextTrack.info?.title || 'Unknown'}](${nextTrack.info?.uri || '#'}) • \`${formatDuration(nextTrack.info?.duration || 0)}\``,
                        inline: false
                    });
                } else if (skipAutoplay) {
                    fields.push({
                        name: 'Autoplay Active',
                        value: 'Discovering next related track...',
                        inline: false
                    });
                }

                await safeReply(interaction, {
                    embeds: [createActionEmbed('success', 'Track Skipped', `Skipped **${skippedTitle}**.`, fields)],
                    flags: MessageFlags.Ephemeral
                });
            }
            break;
        }
        case 'stop': {
            await stopPlayer(client, player, { channelId: interaction.channel?.id });

            await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Playback Stopped', 'Playback stopped and queue cleared. Baduwa remains connected to voice.')],
                flags: MessageFlags.Ephemeral
            });
            break;
        }
        case 'autoplay': {
            const currentAutoplay = client.autoplayEnabled?.has(interaction.guild.id)
                ? client.autoplayEnabled.get(interaction.guild.id)
                : guildSettings.isAutoplay(interaction.guild.id);
            const newAutoplay = !currentAutoplay;
            client.autoplayEnabled?.set(interaction.guild.id, newAutoplay);
            guildSettings.setAutoplay(interaction.guild.id, newAutoplay);
            if (newAutoplay && player.repeatMode !== 'off') {
                player.setRepeatMode('off');
            }

            // If enabling autoplay while player is idle, trigger discovery immediately
            if (newAutoplay && !player.queue.current && !player.playing && player.queue.tracks.length === 0) {
                const { handleAutoplay } = require('../utils/autoplay');
                const lastTrack = (typeof player.getData === 'function' ? player.getData('lastPlayedTrack') : null)
                    || (player.queue?.previous?.length ? player.queue.previous[0] : null);
                handleAutoplay(client, player, 'interaction', lastTrack).then((started) => {
                    if (started) {
                        schedulePlayerUpdate(client, interaction.guild.id, 100, { replace: true, channelId: interaction.channel.id });
                    }
                }).catch(() => {});
            }

            schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });
            await safeReply(interaction, {
                embeds: [createActionEmbed(
                    'info',
                    newAutoplay ? 'Autoplay Enabled' : 'Autoplay Disabled',
                    newAutoplay
                        ? 'Baduwa will automatically discover and queue related tracks when the queue ends.'
                        : 'Autoplay has been turned off.'
                )],
                flags: MessageFlags.Ephemeral
            });
            break;
        }
        case 'shuffle': {
            if (!player.queue?.tracks || player.queue.tracks.length < 2) {
                await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Cannot Shuffle', 'At least 2 upcoming tracks are required in the queue to shuffle.')],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            await shuffleQueue(player);
            schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });
            const nextTrack = player.queue.tracks[0];
            const upNextDesc = nextTrack ? `\nUp next: [**${nextTrack.info?.title || 'Unknown'}**](${nextTrack.info?.uri || '#'})` : '';
            await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Queue Shuffled', `Randomized \`${player.queue.tracks.length}\` upcoming tracks.${upNextDesc}`)],
                flags: MessageFlags.Ephemeral
            });
            break;
        }
        case 'clear': {
            if (client.autoplayEnabled.get(interaction.guild.id)) {
                await safeReply(interaction, {
                    embeds: [createActionEmbed('warning', 'Autoplay Active', 'Cannot clear the queue while Autoplay is managing tracks.')],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            if (player.queue.tracks.length > 0) {
                clearQueue(player);
                await safeReply(interaction, {
                    embeds: [createActionEmbed('success', 'Queue Cleared', 'All upcoming tracks have been removed from the queue.')],
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'Queue Empty', 'The queue is already empty.')],
                    flags: MessageFlags.Ephemeral
                });
            }
            break;
        }
        case 'loop': {
            if (client.autoplayEnabled.get(interaction.guild.id)) {
                client.autoplayEnabled.set(interaction.guild.id, false);
            }
            let newMode;
            let modeDesc;
            let modeLabel;
            switch (player.repeatMode || 'off') {
                case 'off':
                    newMode = 'track';
                    modeDesc = 'Repeating current track 🔂';
                    modeLabel = 'Track Loop';
                    break;
                case 'track':
                    newMode = 'queue';
                    modeDesc = 'Repeating entire queue 🔁';
                    modeLabel = 'Queue Loop';
                    break;
                case 'queue':
                    newMode = 'off';
                    modeDesc = 'Loop mode disabled ➡️';
                    modeLabel = 'Loop Off';
                    break;
                default:
                    newMode = 'track';
                    modeDesc = 'Repeating current track 🔂';
                    modeLabel = 'Track Loop';
            }
            await player.setRepeatMode(newMode);
            schedulePlayerUpdate(client, interaction.guild.id, 50, { replace: false, channelId: interaction.channel?.id });
            await safeReply(interaction, {
                embeds: [createActionEmbed('info', modeLabel, modeDesc)],
                flags: MessageFlags.Ephemeral
            });
            break;
        }
    }

    if (action !== 'stop' && action !== 'queue') {
        schedulePlayerUpdate(client, interaction.guild.id, 200, { replace: true, channelId: interaction.channel.id });
    }
}

async function handleQueueInteraction(interaction, action, args) {
    const { client } = interaction;
    const player = await requirePlayer(interaction);
    if (!player) return;

    const lang = client.defaultLanguage;

    // Check same voice channel for jump action
    if (action === 'jump') {
        const sameVoice = await requireSameVoice(interaction, player);
        if (!sameVoice) return;
    }

    switch (action) {
        case 'first':
        case 'last':
        case 'prev':
        case 'next': {
            const targetPage = parseInt(args[0]);
            if (isNaN(targetPage)) return;

            if (!player.queue.tracks.length && !player.queue.current) {
                await interaction.update({
                    embeds: [createActionEmbed('info', 'Queue Empty', 'The queue is currently empty.')],
                    components: []
                });
                return;
            }

            const queueResponse = createPaginatedQueueResponse(client, player, targetPage);
            await interaction.update(queueResponse);
            break;
        }

        case 'jump': {
            const trackIndex = parseInt(args[0]);
            const currentPage = parseInt(args[1]) || 1;
            const targetQueueId = args[2] || null;
            const targetIdentifier = args[3] || null;

            if (isNaN(trackIndex)) return;

            if (!player.queue.tracks.length) {
                const emptyResponse = {
                    embeds: [createActionEmbed('info', 'Queue Empty', 'The queue is currently empty.')],
                    components: []
                };
                if (typeof interaction.update === 'function' && !interaction.replied && !interaction.deferred) {
                    await interaction.update(emptyResponse).catch(() => safeReply(interaction, emptyResponse));
                } else {
                    await safeReply(interaction, emptyResponse);
                }
                if (typeof client.playerController?.replaceWithFullDashboard === 'function') {
                    await client.playerController.replaceWithFullDashboard(interaction.guild.id, interaction.channel.id, { reason: 'queue' }).catch(() => {});
                }
                return;
            }

            // Execute jump within guild lock to avoid race conditions with other commands/selections
            const jumpedTrack = typeof client.playerController?.runWithGuildLock === 'function'
                ? await client.playerController.runWithGuildLock(interaction.guild.id, async () => {
                    return await jumpToTrack(player, trackIndex, { queueId: targetQueueId, identifier: targetIdentifier });
                })
                : await jumpToTrack(player, trackIndex, { queueId: targetQueueId, identifier: targetIdentifier });

            if (!jumpedTrack) {
                const staleMsg = {
                    embeds: [createActionEmbed(
                        'warning',
                        'Queue Changed',
                        'The queue changed. Please reopen the queue and select a track again.'
                    )],
                    flags: MessageFlags.Ephemeral
                };
                if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
                    await interaction.reply(staleMsg).catch(() => {});
                } else {
                    await safeReply(interaction, staleMsg);
                }
                return;
            }

            // Immediately update the voice channel status with the new track
            if (client.voiceChannelStatusManager?.updateFromPlayer) {
                client.voiceChannelStatusManager.updateFromPlayer(player, jumpedTrack, 'playing').catch(() => {});
            }

            // Update client.activePlayers so presence matches the new track immediately
            client.activePlayers.set(player.guildId, {
                title: jumpedTrack.info?.title,
                startedAt: Date.now()
            });
            client.updatePresence();

            // Update the ephemeral queue view to reflect the new state (Selected song is now playing, remaining queue preserved)
            const updatedQueueResponse = createPaginatedQueueResponse(client, player, 1);
            if (typeof interaction.update === 'function' && !interaction.replied && !interaction.deferred) {
                await interaction.update(updatedQueueResponse).catch(() => safeReply(interaction, updatedQueueResponse));
            } else {
                await safeReply(interaction, updatedQueueResponse);
            }

            // Send clear success confirmation
            await safeReply(interaction, {
                embeds: [createActionEmbed(
                    'success',
                    'Now Playing',
                    `Switched playback to **${jumpedTrack.info?.title || 'Unknown Title'}**`
                )],
                flags: MessageFlags.Ephemeral
            });

            // Update persistent full dashboard at the bottom with the newly selected song
            if (typeof client.playerController?.replaceWithFullDashboard === 'function') {
                await client.playerController.replaceWithFullDashboard(interaction.guild.id, interaction.channel.id, { reason: 'queue' }).catch((err) => {
                    logger.warn(`Failed to refresh dashboard after queue jump for guild ${interaction.guild.id}:`, err?.message || err);
                });
            }
            break;
        }
    }
}

const { enforceSupportGate, checkOwnerMembership, invalidateOwner } = require('../utils/supportGate');

async function handleButtonInteraction(interaction) {
    const { client, customId } = interaction;

    try {
        const hasPermission = await checkInteractionPermission(interaction);
        if (!hasPermission) return;

        const [component, action, ...args] = customId.split(':');

        switch (component) {
            case 'search':
                await handleSearchNavigation(interaction);
                break;
            case 'player':
                await handlePlayerInteraction(interaction, action, args);
                break;
            case 'queue':
                await handleQueueInteraction(interaction, action, args);
                break;
            case 'filter':
                await handleFilterNavigation(interaction);
                break;
            case 'support':
                if (action === 'verify') {
                    const targetOwnerId = args[0] || interaction.guild?.ownerId;
                    invalidateOwner(targetOwnerId);
                    const { isMember } = await checkOwnerMembership(client, targetOwnerId);
                    if (isMember) {
                        const verifiedEmbed = createActionEmbed(
                            'success',
                            'Server Activated!',
                            `The server owner (<@${targetOwnerId}>) has been verified in the official support server.\nBaduwa music playback features are unlocked for this server!`
                        );
                        await safeReply(interaction, { embeds: [verifiedEmbed], flags: MessageFlags.Ephemeral });
                    } else {
                        const unverifiedEmbed = createActionEmbed(
                            'warning',
                            'Activation Pending',
                            `The server owner (<@${targetOwnerId}>) has not joined the official support server yet.\n\nPlease ask them to join via https://discord.gg/RH6W8AcQc and click Verify again.`
                        );
                        await safeReply(interaction, { embeds: [unverifiedEmbed], flags: MessageFlags.Ephemeral });
                    }
                }
                break;
        }
    } catch (error) {
        if (error.code === 10062) {
            logger.warn('Interaction expired for button interaction');
            return;
        }
        logger.error('Error handling button interaction:', error);
        const lang = client.defaultLanguage;
        const reply = { content: client.languageManager.get(lang, 'BUTTON_ERROR'), flags: MessageFlags.Ephemeral };
        await safeReply(interaction, reply);
    }
}

async function handleSelectMenuInteraction(interaction) {
    const { client, customId } = interaction;

    try {
        const hasPermission = await checkInteractionPermission(interaction);
        if (!hasPermission) return;

        const [component, action] = customId.split(':');

        if (component === 'search' && action === 'select') {
            // Route search dropdown to search navigation handler
            await handleSearchNavigation(interaction);
        } else if (component === 'queue' && action === 'select') {
            // Parse selected value: "trackIndex:pageNumber" or "trackIndex:pageNumber:queueId:identifier"
            const selectedValue = interaction.values?.[0] || '';
            const parts = selectedValue.split(':');
            const trackIndexStr = parts[0];
            const pageStr = parts[1];
            const queueId = parts[2] || null;
            const identifier = parts.slice(3).join(':') || null;
            await handleQueueInteraction(interaction, 'jump', [trackIndexStr, pageStr, queueId, identifier]);
        } else if (component === 'filter' && action === 'select') {
            await handleFilterNavigation(interaction);
        }
    } catch (error) {
        if (error.code === 10062) {
            logger.warn('Interaction expired for select menu interaction');
            return;
        }
        logger.error('Error handling select menu interaction:', error);
        const lang = client.defaultLanguage;
        const reply = { content: client.languageManager.get(lang, 'BUTTON_ERROR'), flags: MessageFlags.Ephemeral };
        await safeReply(interaction, reply);
    }
}

async function handleModalSubmitInteraction(interaction) {
    const { customId } = interaction;
    if (!customId.startsWith('player:seek:modal_submit')) return;

    await safeReply(interaction, {
        embeds: [createActionEmbed('info', 'Control Retired', 'Dashboard seek controls have been retired. Use `/seek <position>` to jump to a specific timestamp.')],
        flags: MessageFlags.Ephemeral
    });
}

const FAST_LOCAL_COMMANDS = new Set(['about', 'help', 'support', 'invite', 'nowplaying', '247']);
const COMMAND_TIMEOUT_MS = 20_000;

module.exports = {
    name: 'interactionCreate',
    async execute(interaction) {
        const stopTimer = typeof performanceMonitor?.startInteraction === 'function'
            ? performanceMonitor.startInteraction(interaction)
            : null;

        if (!interaction._receivedAt) {
            interaction._receivedAt = Date.now();
        }
        if (!interaction._receivedHr) {
            interaction._receivedHr = process.hrtime.bigint();
        }

        interaction._responseState = RESPONSE_STATES.PENDING;
        interaction._inFlightReplyPromise = null;
        interaction._restError = null;
        if (typeof interaction.reply === 'function' && interaction.replied && !interaction._preserveReplied) {
            interaction.replied = false;
        }

        let ackDurationMs = 0;

        // Idempotency: Deduplicate duplicate delivery of the exact same Discord snowflake interaction ID
        const shouldCheckIdempotency = /^\d{16,22}$/.test(interaction?.id) || interaction?._enableIdempotency;
        if (shouldCheckIdempotency && idempotencyTracker.checkAndRecord(interaction.id)) {
            logger.debug(`[INTERACTION-DIAG] Duplicate interaction ${interaction.id} ignored`);
            return;
        }

        try {
            if (interaction.isAutocomplete?.()) {
                const command = interaction.client.commands?.get(interaction.commandName);
                if (command && typeof command.autocomplete === 'function') {
                    try {
                        await command.autocomplete(interaction);
                    } catch (err) {
                        logger.debug(`Error executing autocomplete for /${interaction.commandName}:`, err?.message || err);
                        if (!interaction.responded) {
                            await interaction.respond([]).catch(() => {});
                        }
                    }
                } else {
                    if (!interaction.responded) {
                        await interaction.respond([]).catch(() => {});
                    }
                }
                return;
            }

            if (interaction.isCommand()) {
                const commandStart = interaction._receivedAt || Date.now();
                const commandName = (interaction.commandName || '').toLowerCase();
                logger.info(`[LIFECYCLE-DIAG] [RECEIVED] id=${interaction.id || 'unknown'} command="${commandName}" user="${interaction.user?.tag || interaction.user?.id || 'unknown'}" guild="${interaction.guildId || 'DM'}"`);

                const command = interaction.client.commands?.get(interaction.commandName);
                if (!command) {
                    logger.warn(`Received interaction for unknown command: /${interaction.commandName}`);
                    const unknownEmbed = createActionEmbed('warning', 'Unknown Command', `The command \`/${interaction.commandName}\` is not recognized or is currently unavailable.`);
                    await safeReply(interaction, { embeds: [unknownEmbed], flags: MessageFlags.Ephemeral });
                    return;
                }

                const isFastCommand = FAST_LOCAL_COMMANDS.has(commandName);

                // Server-only command check: reject DM usage gracefully
                const interactionGuildId = interaction.guildId || interaction.guild?.id;
                if (!interactionGuildId && !isFastCommand && commandName !== 'faulty') {
                    return await safeReply(interaction, {
                        content: 'Music commands can only be used in a Discord server voice channel.',
                        flags: MessageFlags.Ephemeral
                    });
                }
                let ackFinishTime = commandStart;

                // Promptly acknowledge slow operations (<50ms) to satisfy Discord's 3s SLA.
                // Fast local commands (about, help, support, invite, nowplaying) respond immediately without a loading state.
                if (!isFastCommand) {
                    const ackResult = await ensureDeferred(interaction, { ephemeral: true });
                    ackDurationMs = ackResult.durationMs;
                    interaction._ackDurationMs = ackDurationMs;
                    ackFinishTime = Date.now();
                }

                // Failsafe timer for fast local commands:
                // If execution reaches 1800ms without having replied, ensureDeferred is called
                // so Discord's 3s hard deadline is never exceeded.
                let failsafeAckTimer = null;
                if (isFastCommand) {
                    failsafeAckTimer = setTimeout(() => {
                        ensureDeferred(interaction, { ephemeral: true }).catch(() => {});
                    }, 1800);
                }

                try {
                    const hasPermission = await checkInteractionPermission(interaction);
                    if (!hasPermission) {
                        if (failsafeAckTimer) clearTimeout(failsafeAckTimer);
                        if (interaction.deferred && !interaction.replied) {
                            await safeReply(interaction, {
                                embeds: [createActionEmbed('error', 'Permission Denied', 'You do not have permission to use this command.')],
                                flags: MessageFlags.Ephemeral
                            }).catch(() => {});
                        }
                        return;
                    }

                    // Enforce official support server membership gate for music playback commands
                    const gateResult = await enforceSupportGate(interaction);
                    if (!gateResult.allowed) {
                        if (failsafeAckTimer) clearTimeout(failsafeAckTimer);
                        if (interaction.deferred && !interaction.replied) {
                            await safeReply(interaction, {
                                embeds: [createActionEmbed('warning', 'Action Required', 'Please join the official support server to activate playback features.')],
                                flags: MessageFlags.Ephemeral
                            }).catch(() => {});
                        }
                        return;
                    }

                    // Bound command execution to 20 seconds so commands never hang indefinitely
                    const abortController = new AbortController();
                    interaction._abortController = abortController;
                    interaction._abortSignal = abortController.signal;

                    let timeoutHandle = null;
                    const timeoutPromise = new Promise((_, reject) => {
                        timeoutHandle = setTimeout(() => {
                            const err = new Error(`Command /${interaction.commandName} execution timed out after ${COMMAND_TIMEOUT_MS}ms`);
                            err.name = 'CommandTimeoutError';
                            err.code = 'COMMAND_TIMEOUT';
                            reject(err);
                        }, COMMAND_TIMEOUT_MS);
                    });

                    try {
                        await Promise.race([command.execute(interaction), timeoutPromise]);
                    } finally {
                        if (timeoutHandle) {
                            clearTimeout(timeoutHandle);
                        }
                        if (failsafeAckTimer) {
                            clearTimeout(failsafeAckTimer);
                        }
                    }

                    // If reply is currently finalizing in flight, await it so fallback doesn't race
                    if (interaction._responseState === RESPONSE_STATES.FINALIZING && interaction._inFlightReplyPromise) {
                        await interaction._inFlightReplyPromise.catch(() => null);
                    }

                    const execDurationMs = Date.now() - ackFinishTime;
                    const totalDurationMs = Date.now() - commandStart;

                    const isCmdResponseTerminal = interaction.replied ||
                        interaction._responseState === RESPONSE_STATES.RESPONDED ||
                        interaction._responseState === RESPONSE_STATES.RESPONSE_FAILED ||
                        interaction._responseState === RESPONSE_STATES.EXPIRED ||
                        interaction._tokenExpired ||
                        interaction._timedOut;

                    // Guarantee no command remains indefinitely on "Thinking...", avoiding expired, failed, or timed out tokens
                    if (interaction.deferred && !isCmdResponseTerminal) {
                        logger.warn(`Command /${interaction.commandName} completed without delivering a reply. Sending fallback completion.`);
                        await safeReply(interaction, {
                            embeds: [createActionEmbed('info', 'Command Completed', `The command \`/${interaction.commandName}\` has finished processing.`)],
                            flags: MessageFlags.Ephemeral,
                            _isFallbackReply: true
                        });
                    }

                    const isFailedResponse = interaction._responseState === RESPONSE_STATES.RESPONSE_FAILED ||
                        interaction._responseState === RESPONSE_STATES.EXPIRED ||
                        interaction._tokenExpired ||
                        interaction._timedOut ||
                        Boolean(interaction._restError) ||
                        Boolean(interaction._lateResolved);
                    const restErrorCode = interaction._restError?.code || interaction._restError?.category || (interaction._timedOut ? 'COMMAND_TIMEOUT' : (interaction._tokenExpired ? 'TOKEN_EXPIRED' : (interaction._lateResolved ? 'REST_TIMEOUT' : 'REST_FAILURE')));

                    if (isFailedResponse) {
                        logInteractionDiag(interaction, 'COMMAND_EXEC_RESPONSE_FAILED', {
                            command: interaction.commandName,
                            totalDurationMs,
                            errorCode: restErrorCode,
                        });
                        logger.warn(`[PERF-DIAG] command="${interaction.commandName}" guild="${interaction.guildId || 'DM'}" timeToAck=${ackDurationMs}ms execTime=${execDurationMs}ms total=${totalDurationMs}ms status=FAILED code="${restErrorCode}"`);
                    } else {
                        logInteractionDiag(interaction, 'COMMAND_EXEC_SUCCESS', {
                            command: interaction.commandName,
                            totalDurationMs
                        });
                        logger.info(`[PERF-DIAG] command="${interaction.commandName}" guild="${interaction.guildId || 'DM'}" timeToAck=${ackDurationMs}ms execTime=${execDurationMs}ms total=${totalDurationMs}ms status=SUCCESS`);
                    }
                } catch (error) {
                    const execDurationMs = Date.now() - ackFinishTime;
                    const totalDurationMs = Date.now() - commandStart;
                    const errCode = error?.code || error?.name || 'UNKNOWN';

                    logger.warn(`[PERF-DIAG] command="${interaction.commandName}" guild="${interaction.guildId || 'DM'}" timeToAck=${ackDurationMs}ms execTime=${execDurationMs}ms total=${totalDurationMs}ms status=ERROR code="${errCode}"`);

                    if (error?.code === 'COMMAND_TIMEOUT' || error?.name === 'CommandTimeoutError') {
                        interaction._timedOut = true;
                        try {
                            interaction._abortController?.abort(error);
                        } catch (_) {}

                        // Finalize performance timer immediately at the moment of timeout
                        // to prevent later background cleanup from inflating duration metrics
                        if (typeof stopTimer === 'function') {
                            stopTimer({
                                ackDurationMs,
                                status: 'timed_out',
                            });
                        }

                        logger.warn(`Command /${interaction.commandName} reached 20s execution deadline; aborted.`);
                        await safeReply(interaction, {
                            embeds: [createActionEmbed('warning', 'Command Timed Out', `The command \`/${interaction.commandName}\` took too long to complete. Please try again.`)],
                            flags: MessageFlags.Ephemeral,
                            _isTimeoutReply: true,
                        }).catch(() => {});
                        return;
                    }

                    if (error.code === 10062 || error.code === 10015 || error.code === 50027 || /Invalid Webhook Token|Unknown Webhook|Unknown interaction/i.test(error?.message)) {
                        interaction._tokenExpired = true;
                        logger.warn(`Interaction expired before reply could be delivered (/${interaction.commandName}, code: ${errCode}, guild: ${interaction.guildId || 'DM'})`);
                        return;
                    }
                    const guildInfo = interaction.guild ? `guild ${interaction.guild.name} (${interaction.guild.id})` : 'DM';
                    const userTag = interaction.user?.tag || interaction.user?.id || 'Unknown User';
                    logger.error(`Error executing command /${interaction.commandName} by ${userTag} in ${guildInfo}:`, error?.stack || error);

                    const lang = interaction.client.defaultLanguage;
                    const errorMsg = interaction.client.languageManager?.get
                        ? interaction.client.languageManager.get(lang, 'ERROR_COMMAND_EXECUTION')
                        : 'An error occurred while executing this command.';
                    const reply = { content: errorMsg, flags: MessageFlags.Ephemeral, _isErrorReply: true };
                    await safeReply(interaction, reply);
                } finally {
                    if (failsafeAckTimer) {
                        clearTimeout(failsafeAckTimer);
                    }
                }
            } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
                const compName = interaction.customId || 'component';
                const compStart = Date.now();
                logger.info(`[LIFECYCLE-DIAG] [RECEIVED_COMP] id=${interaction.id || 'unknown'} customId="${compName}" user="${interaction.user?.tag || interaction.user?.id || 'unknown'}" guild="${interaction.guildId || 'DM'}"`);

                const failsafeAckTimer = setTimeout(() => {
                    ensureDeferred(interaction, { ephemeral: true }).catch(() => {});
                }, 1800);

                let timeoutHandle = null;
                const COMP_TIMEOUT_MS = 15_000;
                const abortController = new AbortController();
                interaction._abortController = abortController;
                interaction._abortSignal = abortController.signal;

                const timeoutPromise = new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        const err = new Error(`Component interaction ${compName} execution timed out after ${COMP_TIMEOUT_MS}ms`);
                        err.name = 'InteractionTimeoutError';
                        err.code = 'INTERACTION_TIMEOUT';
                        reject(err);
                    }, COMP_TIMEOUT_MS);
                });

                try {
                    const runner = async () => {
                        if (interaction.isButton()) {
                            await handleButtonInteraction(interaction);
                        } else if (interaction.isStringSelectMenu()) {
                            await handleSelectMenuInteraction(interaction);
                        } else if (interaction.isModalSubmit()) {
                            await handleModalSubmitInteraction(interaction);
                        }
                    };

                    await Promise.race([runner(), timeoutPromise]);

                    // Guarantee no deferred component interaction remains indefinitely on "Thinking...", avoiding expired or failed tokens
                    const isCompResponseTerminal = interaction.replied ||
                        interaction._responseState === RESPONSE_STATES.RESPONDED ||
                        interaction._responseState === RESPONSE_STATES.RESPONSE_FAILED ||
                        interaction._responseState === RESPONSE_STATES.EXPIRED ||
                        interaction._tokenExpired ||
                        interaction._timedOut;

                    if (interaction.deferred && !isCompResponseTerminal) {
                        logger.warn(`Component ${compName} completed without delivering a reply. Sending fallback completion.`);
                        await safeReply(interaction, {
                            embeds: [createActionEmbed('info', 'Action Completed', 'Your request has been processed.')],
                            flags: MessageFlags.Ephemeral
                        });
                    }
                } catch (error) {
                    if (error?.code === 'INTERACTION_TIMEOUT' || error?.name === 'InteractionTimeoutError') {
                        interaction._timedOut = true;
                        try {
                            interaction._abortController?.abort(error);
                        } catch (_) {}

                        if (typeof stopTimer === 'function') {
                            stopTimer({
                                ackDurationMs,
                                status: 'timed_out',
                            });
                        }

                        logger.warn(`Component ${compName} reached 15s execution deadline; aborted.`);
                        await safeReply(interaction, {
                            embeds: [createActionEmbed('warning', 'Request Timed Out', 'The request took too long to complete. Please try again.')],
                            flags: MessageFlags.Ephemeral,
                            _isTimeoutReply: true,
                        }).catch(() => {});
                        return;
                    }

                    if (error.code === 10062 || error.code === 10015 || error.code === 50027 || /Invalid Webhook Token|Unknown Webhook|Unknown interaction/i.test(error?.message)) {
                        interaction._tokenExpired = true;
                        logger.warn(`Interaction expired before reply could be delivered (${compName}, code: ${error.code})`);
                        return;
                    }

                    logger.error(`Error handling component ${compName}:`, error);
                    const lang = interaction.client.defaultLanguage;
                    const errorMsg = interaction.client.languageManager?.get
                        ? interaction.client.languageManager.get(lang, 'BUTTON_ERROR')
                        : 'An error occurred while processing this action.';
                    await safeReply(interaction, { content: errorMsg, flags: MessageFlags.Ephemeral, _isErrorReply: true });
                } finally {
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    if (failsafeAckTimer) clearTimeout(failsafeAckTimer);
                }
            }
        } finally {
            if (stopTimer) {
                let finalStatus = 'completed';
                if (interaction._timedOut) {
                    finalStatus = 'timed_out';
                } else if (interaction._tokenExpired || interaction._responseState === RESPONSE_STATES.EXPIRED) {
                    finalStatus = 'expired';
                } else if (interaction._responseState === RESPONSE_STATES.RESPONSE_FAILED || interaction._restError) {
                    finalStatus = interaction._restError?.code || 'response_failed';
                }

                const durationMs = stopTimer({
                    ackDurationMs,
                    status: finalStatus,
                });
                const type = interaction.isCommand() ? 'command' : (interaction.isButton() ? 'button' : (interaction.isAutocomplete?.() ? 'autocomplete' : (interaction.isStringSelectMenu?.() ? 'select' : 'interaction')));
                const name = (interaction.isCommand() || interaction.isAutocomplete?.()) ? interaction.commandName : (interaction.customId || 'unknown');
                if (typeof performanceMonitor?.recordInteraction === 'function') {
                    performanceMonitor.recordInteraction(type, name, durationMs, {
                        ackDurationMs,
                        isTimeout: Boolean(interaction._timedOut),
                        status: finalStatus,
                    });
                }
            }
        }
    },
};
