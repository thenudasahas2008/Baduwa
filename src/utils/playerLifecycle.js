const logger = require('./logger');

const queueEndTimeouts = new Map();
const pendingPlayerUpdates = new Map();

function clearMappedTimeout(map, guildId) {
    const entry = map.get(guildId);
    if (!entry) return;

    const timeout = entry?.timeout || entry;
    clearTimeout(timeout);
    map.delete(guildId);
}

function clearQueueEndTimeout(guildId) {
    clearMappedTimeout(queueEndTimeouts, guildId);
}

function setQueueEndTimeout(guildId, timeout) {
    clearQueueEndTimeout(guildId);
    queueEndTimeouts.set(guildId, timeout);
}

function clearAllQueueEndTimeouts() {
    for (const timeout of queueEndTimeouts.values()) {
        clearTimeout(timeout);
    }
    queueEndTimeouts.clear();
}

function clearPlayerUpdate(guildId) {
    clearMappedTimeout(pendingPlayerUpdates, guildId);
}

function clearAllPlayerUpdates() {
    for (const entry of pendingPlayerUpdates.values()) {
        const timeout = entry?.timeout || entry;
        clearTimeout(timeout);
    }
    pendingPlayerUpdates.clear();
}

const manualStopGenerations = new Map();

function markManualStop(guildId) {
    if (!guildId) return 0;
    const nextGen = (manualStopGenerations.get(guildId) || 0) + 1;
    manualStopGenerations.set(guildId, nextGen);
    return nextGen;
}

function clearManualStop(guildId) {
    if (!guildId) return;
    manualStopGenerations.delete(guildId);
}

function isManualStopActive(guildId, generation = null) {
    if (!guildId) return false;
    const currentGen = manualStopGenerations.get(guildId);
    if (!currentGen) return false;
    if (generation === null || generation === undefined) return true;
    return currentGen === generation;
}

function getManualStopGeneration(guildId) {
    return manualStopGenerations.get(guildId) || 0;
}

function clearGuildLifecycleTimers(guildId) {
    clearQueueEndTimeout(guildId);
    clearPlayerUpdate(guildId);
}

function schedulePlayerUpdate(client, guildId, delay = 500, options = {}) {
    if (!client?.playerController || !guildId) return;

    // Suppress scheduled updates for playing tracks if a manual stop is actively in effect
    if (isManualStopActive(guildId) && !options.stopped && !options.unavailable) {
        return;
    }

    const existing = pendingPlayerUpdates.get(guildId);
    let mergedOptions = { ...(existing?.options || {}), ...options };
    if (existing) {
        const existingTimeout = existing?.timeout || existing;
        clearTimeout(existingTimeout);
        // If either the prior scheduled update or the new one requested replace: true, keep it true
        if (existing?.options?.replace === true || options.replace === true) {
            mergedOptions.replace = true;
        }
    }

    const timeout = setTimeout(() => {
        pendingPlayerUpdates.delete(guildId);
        if (isManualStopActive(guildId) && !mergedOptions.stopped && !mergedOptions.unavailable) {
            return;
        }
        client.playerController.updatePlayer(guildId, mergedOptions).catch((error) => {
            logger.debug('Scheduled player update failed:', error?.message || error);
        });
    }, delay);

    pendingPlayerUpdates.set(guildId, { timeout, options: mergedOptions });
}

module.exports = {
    queueEndTimeouts,
    clearQueueEndTimeout,
    setQueueEndTimeout,
    clearAllQueueEndTimeouts,
    clearPlayerUpdate,
    clearAllPlayerUpdates,
    clearGuildLifecycleTimers,
    schedulePlayerUpdate,
    manualStopGenerations,
    markManualStop,
    clearManualStop,
    isManualStopActive,
    getManualStopGeneration,
};

