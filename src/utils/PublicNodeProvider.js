const logger = require('./logger');
const { isSafeExternalHost, normalizeHost, parseHostAllowlist } = require('./networkGuard');
const { validateAndFormatNodeOption } = require('./lavalinkNodeOptions');

const API_URL = 'https://lavalink-list.ajieblogs.eu.org/All';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes (matches API refresh)
const FETCH_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_HOST_LENGTH = 253;
const MAX_PASSWORD_LENGTH = 512;

async function readResponseTextWithLimit(response) {
    if (!response.body?.getReader) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
            throw new Error('Public node API response exceeded size limit');
        }
        return text;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error('Public node API response exceeded size limit');
        }
        chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks).toString('utf8');
}

const NODE_BASE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes cooldown on failure
const NODE_MAX_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes max cooldown
const NODE_INCOMPATIBLE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes for confirmed incompatible API
const NODE_AUTH_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes for auth failure
const NODE_RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // 1 minute for temporary rate limits

const PREFERRED_FAST_HOSTS = [
    'lavalink-v4.triniumhost.com',
    'lavalink.jirayu.net',
    'lavalink.nazha.online',
    'lavalinkv4.serenetia.com',
    'lavalink.triniumhost.com',
];

const BLOCKED_PUBLIC_HOSTS = [
    'lava-v4.millohost.my.id', // HTTP 403 / auth rejection / -29000ms latency clock skew
    'n3.nexcloud.in',          // Continuous timeout
    'omega.vexanode.cloud',    // Continuous timeout
    'lava2.kasawa.pro',        // Continuous timeout
    '157.254.192.15',          // Continuous timeout
];

class PublicNodeProvider {
    constructor() {
        this.nodes = [];
        this.currentIndex = 0;
        this.refreshInterval = null;
        this.failedNodes = new Map(); // key: "host:port" -> { cooldownUntil, failCount, stallCount, playbackSuccessCount, lastStallTimestamp, lastSuccessTimestamp, category, reason, lastFailureTimestamp }
        this._fetchPromise = null;
    }

    markNodeFailed(host, port, reason = '', category = 'TRANSIENT_ERROR') {
        const key = `${normalizeHost(host)}:${port}`;
        const now = Date.now();
        const existing = this.failedNodes.get(key) || { failCount: 0, stallCount: 0, playbackSuccessCount: 0, lastFailureTimestamp: 0 };

        // Deduplicate overlapping error/disconnect/catch handlers for the same failure event (within 4s)
        const isDuplicateRecentFailure = (now - (existing.lastFailureTimestamp || 0)) < 4000;
        if (isDuplicateRecentFailure) {
            // Upgrade category if more specific (e.g. INCOMPATIBLE_API, AUTH_FAILED, RATE_LIMITED)
            if (category === 'INCOMPATIBLE_API' && existing.category !== 'INCOMPATIBLE_API') {
                existing.category = category;
                existing.cooldownUntil = Math.max(existing.cooldownUntil, now + NODE_INCOMPATIBLE_COOLDOWN_MS);
            }
            existing.reason = String(reason || existing.reason || '').slice(0, 100);
            this.failedNodes.set(key, existing);
            return;
        }

        const failCount = existing.failCount + 1;

        let cooldownDuration;
        if (category === 'INCOMPATIBLE_API') {
            cooldownDuration = NODE_INCOMPATIBLE_COOLDOWN_MS;
        } else if (category === 'AUTH_FAILED') {
            cooldownDuration = NODE_AUTH_COOLDOWN_MS;
        } else if (category === 'RATE_LIMITED') {
            cooldownDuration = Math.min(
                NODE_RATE_LIMIT_COOLDOWN_MS * Math.pow(2, failCount - 1),
                NODE_MAX_COOLDOWN_MS
            );
        } else if (category === 'PLAYBACK_STALL') {
            cooldownDuration = Math.min(5 * 60 * 1000 * Math.pow(2, (existing.stallCount || 1) - 1), NODE_MAX_COOLDOWN_MS);
        } else {
            cooldownDuration = Math.min(
                NODE_BASE_COOLDOWN_MS * Math.pow(2, failCount - 1),
                NODE_MAX_COOLDOWN_MS
            );
        }
        const cooldownUntil = now + cooldownDuration;

        this.failedNodes.set(key, {
            ...existing,
            cooldownUntil,
            failCount,
            category,
            lastFailureTimestamp: now,
            reason: String(reason || 'connection-failed').slice(0, 100),
        });

        logger.warn(`Public node candidate ${key} failed [${category}]: ${String(reason || '').slice(0, 80)}. Node entered cooldown for ${Math.round(cooldownDuration / 1000)}s.`);
    }

    recordPlaybackStall(host, port, reason = 'playback-stall') {
        const key = `${normalizeHost(host)}:${port}`;
        const existing = this.failedNodes.get(key) || { failCount: 0, stallCount: 0, playbackSuccessCount: 0 };
        existing.stallCount = (existing.stallCount || 0) + 1;
        existing.lastStallTimestamp = Date.now();
        this.failedNodes.set(key, existing);
        this.markNodeFailed(host, port, reason, 'PLAYBACK_STALL');
    }

    recordPlaybackSuccess(host, port) {
        const key = `${normalizeHost(host)}:${port}`;
        const existing = this.failedNodes.get(key) || { failCount: 0, stallCount: 0, playbackSuccessCount: 0 };
        existing.playbackSuccessCount = (existing.playbackSuccessCount || 0) + 1;
        existing.lastSuccessTimestamp = Date.now();

        // If the node stalled recently (< 15 mins), retain stall count for ranking but decrement failCount
        if (existing.lastStallTimestamp && Date.now() - existing.lastStallTimestamp < 15 * 60 * 1000) {
            existing.failCount = Math.max(0, (existing.failCount || 0) - 1);
        } else {
            existing.failCount = Math.max(0, (existing.failCount || 0) - 1);
            if (existing.failCount === 0 && (!existing.stallCount || existing.stallCount === 0)) {
                existing.cooldownUntil = 0;
            }
        }
        this.failedNodes.set(key, existing);
        logger.debug(`Public node ${key} recorded verified playback success (success count: ${existing.playbackSuccessCount})`);
    }

    markNodeSuccess(host, port) {
        this.recordPlaybackSuccess(host, port);
    }

    isNodeInCooldown(host, port) {
        const key = `${normalizeHost(host)}:${port}`;
        const record = this.failedNodes.get(key);
        if (!record) return false;
        if (Date.now() >= record.cooldownUntil) {
            record.cooldownUntil = 0;
            return false;
        }
        return true;
    }

    hasEligibleNode() {
        if (!this.nodes || this.nodes.length === 0) return false;
        const now = Date.now();
        return this.nodes.some(n => {
            const key = `${n.host}:${n.port}`;
            const rec = this.failedNodes.get(key);
            return !rec || rec.cooldownUntil <= now;
        });
    }

    areAllNodesInCooldown() {
        if (!this.nodes || this.nodes.length === 0) return false;
        const now = Date.now();
        return this.nodes.every(n => {
            const key = `${n.host}:${n.port}`;
            const rec = this.failedNodes.get(key);
            return rec && rec.cooldownUntil > now;
        });
    }

    /**
     * Fetches and validates public Lavalink nodes with bounded retries,
     * explicit error differentiation, and proper timeout cleanup.
     * Coalesces concurrent in-flight discovery requests.
     * @param {object} [options]
     * @param {number} [options.maxRetries=2]
     * @param {number} [options.timeoutMs=15000]
     * @param {number} [options.retryDelayMs=1500]
     * @returns {Promise<boolean>}
     */
    async fetchNodes(options = {}) {
        if (this._fetchPromise) {
            return this._fetchPromise;
        }

        this._fetchPromise = this._executeFetchNodes(options);
        try {
            return await this._fetchPromise;
        } finally {
            this._fetchPromise = null;
        }
    }

    async _executeFetchNodes({ maxRetries = 2, timeoutMs = FETCH_TIMEOUT_MS, retryDelayMs = 1500 } = {}) {
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            let timeoutId = null;
            const controller = new AbortController();

            try {
                timeoutId = setTimeout(() => {
                    controller.abort();
                }, timeoutMs);

                let response;
                try {
                    response = await fetch(API_URL, { signal: controller.signal });
                } catch (netErr) {
                    if (controller.signal.aborted || netErr.name === 'AbortError' || netErr.name === 'TimeoutError') {
                        throw new Error(`Request timed out after ${timeoutMs}ms (attempt ${attempt}/${maxRetries + 1})`);
                    }
                    throw new Error(`Network failure: ${netErr.message || netErr}`);
                }

                if (!response.ok) {
                    throw new Error(`Public Lavalink list API returned HTTP ${response.status} ${response.statusText}`);
                }

                let text;
                try {
                    text = await readResponseTextWithLimit(response);
                } catch (streamErr) {
                    if (controller.signal.aborted || streamErr.name === 'AbortError') {
                        throw new Error(`Response stream reading timed out after ${timeoutMs}ms`);
                    }
                    throw streamErr;
                }

                // Immediately clear the timeout as soon as the response is fully read
                clearTimeout(timeoutId);
                timeoutId = null;

                let data;
                try {
                    data = JSON.parse(text);
                } catch (jsonErr) {
                    throw new Error(`Invalid JSON received from public node list API: ${jsonErr.message}`);
                }

                if (!Array.isArray(data)) {
                    throw new Error('Unexpected API response format: expected an Array of node descriptors');
                }

                if (data.length === 0) {
                    throw new Error('Public Lavalink list API returned an empty list');
                }

                const allowlist = parseHostAllowlist();
                const checkedNodes = [];
                const BATCH_SIZE = 5;
                for (let i = 0; i < data.length; i += BATCH_SIZE) {
                    const batch = data.slice(i, i + BATCH_SIZE);
                    const batchResults = await Promise.all(batch.map(node => this.validateNode(node, allowlist)));
                    checkedNodes.push(...batchResults);
                }
                const allV4Nodes = checkedNodes.filter(Boolean);

                if (allV4Nodes.length === 0) {
                    logger.warn('Public Lavalink API returned no valid v4 nodes');
                    return this.nodes.length > 0;
                }

                const secureNodes = allV4Nodes.filter(node => node.secure === true);
                const insecureNodes = allV4Nodes.filter(node => node.secure !== true);

                // Prioritize known high-performance low-latency secure nodes first
                const preferredSecure = [];
                const otherSecure = [];
                for (const node of secureNodes) {
                    if (PREFERRED_FAST_HOSTS.includes(node.host)) {
                        preferredSecure.push(node);
                    } else {
                        otherSecure.push(node);
                    }
                }

                this.nodes = [...preferredSecure, ...otherSecure, ...insecureNodes];
                this.currentIndex = 0;

                logger.info(`Discovered ${this.nodes.length} validated public Lavalink v4 nodes (${secureNodes.length} secure, ${insecureNodes.length} standard)`);
                return true;

            } catch (error) {
                lastError = error;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }

                if (attempt <= maxRetries) {
                    const backoffMs = retryDelayMs * Math.pow(1.5, attempt - 1);
                    logger.warn(`Failed to fetch public nodes: ${error.message}. Retrying in ${Math.round(backoffMs)}ms (attempt ${attempt}/${maxRetries + 1})...`);
                    await new Promise(r => setTimeout(r, backoffMs));
                }
            }
        }

        if (this.nodes.length > 0) {
            logger.warn(`Failed to refresh public node list (${lastError?.message}), continuing with ${this.nodes.length} cached nodes`);
            return true;
        }

        logger.error(`Failed to fetch public Lavalink nodes: ${lastError?.message || lastError}`);
        return false;
    }

    async validateNode(node, allowlist) {
        if (!node || typeof node !== 'object') return null;
        if (node.version !== 'v4') return null;

        const host = normalizeHost(node.host);
        if (BLOCKED_PUBLIC_HOSTS.includes(host)) {
            logger.debug(`Rejected blocked/broken public host: ${host}`);
            return null;
        }
        const port = Number(node.port);
        const password = typeof node.password === 'string' ? node.password.trim() : '';
        // lavalink-client strictly enforces: if secure is true, port must be 443
        const secure = node.secure === true && port === 443;

        if (!host || host.length > MAX_HOST_LENGTH) return null;
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
        if (!password || password.length > MAX_PASSWORD_LENGTH) return null;

        try {
            const safeHost = await isSafeExternalHost(host, { allowlist });
            if (!safeHost) return null;
        } catch (error) {
            logger.debug(`Rejected public Lavalink node ${host}:${port}: ${error.message}`);
            return null;
        }

        return {
            version: 'v4',
            host,
            port,
            password,
            secure,
        };
    }

    /**
     * Actively probes candidate Lavalink node via authenticated REST GET /v4/info.
     * Parses responses as JSON only when valid JSON, differentiating unsupported versions,
     * plain-text errors, auth rejections, rate limits, and network timeouts.
     * @param {object} candidate
     * @param {object} [options]
     * @param {number} [options.timeoutMs=3500]
     * @returns {Promise<{compatible: boolean, category: string, status: number|null, reason?: string, info?: object, version?: string, temporary?: boolean}>}
     */
    async checkNodeCompatibility(candidate, { timeoutMs = 3500, signal = null } = {}) {
        if (!candidate || typeof candidate !== 'object') {
            return { compatible: false, category: 'INVALID_CONFIG', status: null, reason: 'Invalid candidate object' };
        }

        const host = normalizeHost(candidate.host);
        const port = Number(candidate.port);
        const password = typeof candidate.password === 'string' ? candidate.password.trim() : (typeof candidate.authorization === 'string' ? candidate.authorization.trim() : '');
        const secure = candidate.secure === true && port === 443;

        if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !password) {
            return { compatible: false, category: 'INVALID_CONFIG', status: null, reason: 'Missing required node parameters' };
        }

        const scheme = secure ? 'https' : 'http';
        const url = `${scheme}://${host}:${port}/v4/info`;
        const checkStart = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let onExternalAbort = null;
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timeoutId);
                return {
                    compatible: false,
                    category: 'ABORTED',
                    status: null,
                    reason: 'Node check aborted by caller',
                    temporary: true,
                };
            }
            onExternalAbort = () => controller.abort();
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': password,
                    'Accept': 'application/json',
                    'User-Agent': 'Baduwa-Audio-Compatibility/1.0',
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);
            if (signal && onExternalAbort) {
                signal.removeEventListener('abort', onExternalAbort);
            }

            if (response.status === 401 || response.status === 403) {
                return {
                    compatible: false,
                    category: 'AUTH_FAILED',
                    status: response.status,
                    reason: `Authentication failed (HTTP ${response.status})`,
                };
            }

            if (response.status === 429) {
                return {
                    compatible: false,
                    category: 'RATE_LIMITED',
                    status: 429,
                    reason: 'Endpoint temporarily rate-limited (HTTP 429)',
                    temporary: true,
                };
            }

            if (response.status === 404) {
                return {
                    compatible: false,
                    category: 'INCOMPATIBLE_API',
                    status: 404,
                    reason: 'Endpoint /v4/info not found (HTTP 404) — node does not support Lavalink v4',
                };
            }

            if (response.status === 530) {
                return {
                    compatible: false,
                    category: 'INCOMPATIBLE_API',
                    status: 530,
                    reason: 'Cloudflare 530 Direct IP access not allowed — host misconfigured',
                };
            }

            if (response.status >= 500) {
                return {
                    compatible: false,
                    category: 'TRANSIENT_ERROR',
                    status: response.status,
                    reason: `Server error (HTTP ${response.status})`,
                    temporary: true,
                };
            }

            // Read response text safely
            let rawText;
            try {
                rawText = await readResponseTextWithLimit(response);
            } catch (readErr) {
                return {
                    compatible: false,
                    category: 'TRANSIENT_ERROR',
                    status: response.status,
                    reason: `Failed to read response body: ${readErr.message}`,
                    temporary: true,
                };
            }

            if (!rawText || !rawText.trim()) {
                return {
                    compatible: false,
                    category: 'INCOMPATIBLE_API',
                    status: response.status,
                    reason: 'Empty body returned from /v4/info',
                };
            }

            if (rawText.trim().startsWith('<') || /<!doctype/i.test(rawText)) {
                return {
                    compatible: false,
                    category: 'INCOMPATIBLE_API',
                    status: response.status,
                    reason: 'HTML response received instead of Lavalink JSON API',
                };
            }

            // Parse response as JSON only when actually valid JSON; never crash with SyntaxError
            let info;
            try {
                info = JSON.parse(rawText);
            } catch (jsonErr) {
                const snippet = rawText.slice(0, 60).replace(/[\r\n\t]/g, ' ');
                return {
                    compatible: false,
                    category: 'INCOMPATIBLE_API',
                    status: response.status,
                    reason: `Non-JSON body received: "${snippet}"`,
                };
            }

            if (!info || typeof info !== 'object') {
                return {
                    compatible: false,
                    category: 'INCOMPATIBLE_API',
                    status: response.status,
                    reason: 'Parsed JSON response is not an object',
                };
            }

            // Validate Lavalink v4 version semantics strictly from info.version (never treat info.git.commit as server version)
            if (!info.version || (typeof info.version !== 'object' && typeof info.version !== 'string')) {
                if (Array.isArray(info.sourceManagers) || Array.isArray(info.plugins) || info.lavaplayer) {
                    return {
                        compatible: true,
                        category: 'COMPATIBLE_V4',
                        status: response.status,
                        version: 'v4-custom',
                        info,
                    };
                }
                return {
                    compatible: false,
                    category: 'INCOMPATIBLE_API',
                    status: response.status,
                    reason: 'Missing version object in /v4/info response (expected info.version)',
                };
            }

            let major = null;
            let semverStr = '';

            if (typeof info.version === 'object') {
                if (typeof info.version.major === 'number' && Number.isInteger(info.version.major)) {
                    major = info.version.major;
                } else if (typeof info.version.major === 'string') {
                    const parsed = parseInt(info.version.major.trim(), 10);
                    if (!Number.isNaN(parsed)) major = parsed;
                }

                if (typeof info.version.semver === 'string') {
                    semverStr = info.version.semver.trim();
                }
            } else if (typeof info.version === 'string') {
                semverStr = info.version.trim();
            }

            const isGitHash = /^[0-9a-f]{7,40}(?:-[a-z0-9.]+)?$/i.test(semverStr);

            // Parse major version from semantic version string (e.g. "4.0.8", "v4.0.0", "4.0.0-beta.1")
            // NEVER use parseInt on a raw git commit hash
            if (major === null && semverStr && !isGitHash) {
                const match = semverStr.match(/^v?(\d+)(?:\.|$)/);
                if (match) {
                    major = parseInt(match[1], 10);
                }
            }

            if (major === 4) {
                return {
                    compatible: true,
                    category: 'COMPATIBLE_V4',
                    status: response.status,
                    version: semverStr || `v${major}`,
                    info,
                    latencyMs: Date.now() - checkStart,
                };
            }

            // If semver is a git commit hash or git build but node responded to /v4/info with valid Lavalink v4 structure:
            if ((isGitHash || major === null || !semverStr) && (Array.isArray(info.sourceManagers) || Array.isArray(info.plugins) || info.lavaplayer)) {
                return {
                    compatible: true,
                    category: 'COMPATIBLE_V4',
                    status: response.status,
                    version: isGitHash ? `v4-git-${semverStr.slice(0, 7)}` : (semverStr ? `v4-${semverStr}` : 'v4-custom'),
                    info,
                    latencyMs: Date.now() - checkStart,
                };
            }

            return {
                compatible: false,
                category: 'INCOMPATIBLE_API',
                status: response.status,
                reason: `Incompatible Lavalink version detected: ${semverStr || major || 'unknown'} (expected v4)`,
            };

        } catch (fetchErr) {
            clearTimeout(timeoutId);
            if (signal && onExternalAbort) {
                signal.removeEventListener('abort', onExternalAbort);
            }
            if (signal?.aborted) {
                return {
                    compatible: false,
                    category: 'ABORTED',
                    status: null,
                    reason: 'Node check aborted by caller',
                    temporary: true,
                };
            }
            const isTimeout = controller.signal.aborted || fetchErr.name === 'AbortError' || fetchErr.name === 'TimeoutError';
            const msg = fetchErr?.message || String(fetchErr);
            let category = isTimeout ? 'TIMEOUT' : 'CONNECTION_ERROR';
            if (/ECONNREFUSED|connection refused/i.test(msg)) {
                category = 'TRANSIENT_ERROR';
            } else if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
                category = 'DNS_ERROR';
            } else if (/proxy/i.test(msg)) {
                category = 'TRANSIENT_ERROR';
            }
            return {
                compatible: false,
                category,
                status: null,
                reason: isTimeout ? `Connection timed out after ${timeoutMs}ms` : msg,
                temporary: true,
            };
        }
    }

    /**
     * Probes and returns the highest-scoring candidate node that actively passes
     * Lavalink v4 REST compatibility validation. Incompatible candidates are placed on cooldown.
     * Probes top candidates concurrently to eliminate sequential probing latency.
     * @param {object} [options]
     * @param {number} [options.maxCandidates=5]
     * @param {number} [options.probeTimeoutMs=3500]
     * @param {string} [options.excludeHost=null]
     * @param {number} [options.excludePort=null]
     * @returns {Promise<object|null>} Validated NodeOptions or null if none pass
     */
    async getNextValidatedNode({ maxCandidates = 5, probeTimeoutMs = 3500, excludeHost = null, excludePort = null } = {}) {
        if (this.nodes.length === 0) return null;

        const now = Date.now();
        const candidates = [];

        for (let i = 0; i < this.nodes.length; i++) {
            const index = (this.currentIndex + i) % this.nodes.length;
            const candidate = this.nodes[index];
            if (excludeHost && candidate.host === excludeHost && (!excludePort || Number(candidate.port) === Number(excludePort))) {
                continue;
            }
            const key = `${candidate.host}:${candidate.port}`;
            const record = this.failedNodes.get(key);
            if (!record || record.cooldownUntil <= now) {
                const failCount = record ? (record.failCount || 0) : 0;
                const stallCount = record ? (record.stallCount || 0) : 0;
                const successCount = record ? (record.playbackSuccessCount || 0) : 0;
                const bonus = PREFERRED_FAST_HOSTS.includes(candidate.host) ? 100 : 0;
                const score = (successCount * 10) - (failCount * 5) - (stallCount * 15) + bonus;
                candidates.push({ candidate, score, failCount, stallCount, index });
            }
        }

        if (candidates.length === 0) return null;

        // Rank: highest score first; lowest stallCount, lowest failCount
        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.stallCount !== b.stallCount) return a.stallCount - b.stallCount;
            return a.failCount - b.failCount;
        });

        const toTest = candidates.slice(0, maxCandidates);
        const probeController = new AbortController();
        const probeStart = Date.now();

        // Track per-candidate states for priority-aware early resolution
        const probeStates = toTest.map((item) => ({
            item,
            status: 'pending',
            check: null,
        }));

        const probePromises = toTest.map((item, idx) => {
            return (async () => {
                try {
                    const check = await this.checkNodeCompatibility(item.candidate, {
                        timeoutMs: probeTimeoutMs,
                        signal: probeController.signal,
                    });
                    probeStates[idx].check = check;
                    if (check.compatible) {
                        probeStates[idx].status = 'success';
                    } else {
                        probeStates[idx].status = 'failed';
                        if (check.category !== 'ABORTED' && !probeController.signal.aborted) {
                            this.markNodeFailed(item.candidate.host, item.candidate.port, check.reason, check.category);
                        }
                    }
                } catch (_) {
                    probeStates[idx].status = 'failed';
                }
            })();
        });

        // Resolve as soon as the highest-ranked viable candidate succeeds without waiting for slower candidates
        const winner = await new Promise((resolve) => {
            let settled = 0;
            const evaluate = () => {
                if (settled >= toTest.length) {
                    const successful = probeStates.filter((s) => s.status === 'success');
                    if (successful.length === 0) return resolve(null);
                    successful.sort((a, b) => {
                        const scoreA = (a.item.score || 0) * 100 - (a.check?.latencyMs || 500);
                        const scoreB = (b.item.score || 0) * 100 - (b.check?.latencyMs || 500);
                        return scoreB - scoreA;
                    });
                    return resolve(successful[0]);
                }

                for (let k = 0; k < probeStates.length; k++) {
                    if (probeStates[k].status === 'success') {
                        const latency = probeStates[k].check?.latencyMs || 1000;
                        // All higher-ranked candidates (0..k-1) must have completed and failed
                        let allPriorFailed = true;
                        for (let j = 0; j < k; j++) {
                            if (probeStates[j].status !== 'failed') {
                                allPriorFailed = false;
                                break;
                            }
                        }
                        if (allPriorFailed || (latency < 450 && probeStates[k].item.score >= 0)) {
                            try { probeController.abort(); } catch (_) {}
                            return resolve(probeStates[k]);
                        }
                        break;
                    } else if (probeStates[k].status === 'pending') {
                        // Higher-ranked candidate is still probing, wait for it
                        break;
                    }
                }
            };

            probePromises.forEach((p) => {
                p.finally(() => {
                    settled++;
                    evaluate();
                });
            });
        });

        if (winner && winner.status === 'success') {
            const item = winner.item;
            this.currentIndex = (item.index + 1) % this.nodes.length;
            const elapsed = Date.now() - probeStart;
            logger.info(`[NODE-DIAG] Selected validated Lavalink v4 node ${item.candidate.host}:${item.candidate.port} in ${elapsed}ms (score: ${item.score})`);
            return validateAndFormatNodeOption({
                host: item.candidate.host,
                port: item.candidate.port,
                authorization: item.candidate.password || item.candidate.authorization,
                secure: item.candidate.secure,
                id: 'main-node',
                retryAmount: 3,
                retryDelay: 2000,
            });
        }

        return null;
    }

    getNextNode({ allowCooldownFallback = true } = {}) {
        if (this.nodes.length === 0) return null;

        const now = Date.now();
        let selectedNode = null;

        // Collect all eligible nodes not currently in cooldown
        const eligible = [];
        for (let i = 0; i < this.nodes.length; i++) {
            const index = (this.currentIndex + i) % this.nodes.length;
            const candidate = this.nodes[index];
            const key = `${candidate.host}:${candidate.port}`;
            const record = this.failedNodes.get(key);
            if (!record || record.cooldownUntil <= now) {
                const failCount = record ? (record.failCount || 0) : 0;
                const stallCount = record ? (record.stallCount || 0) : 0;
                const successCount = record ? (record.playbackSuccessCount || 0) : 0;
                const score = (successCount * 10) - (failCount * 5) - (stallCount * 15);
                eligible.push({ candidate, score, failCount, stallCount, index });
            }
        }

        if (eligible.length > 0) {
            // Prioritize highest score (verified playback), then lowest stall count, then lowest fail count
            eligible.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                if (a.stallCount !== b.stallCount) return a.stallCount - b.stallCount;
                return a.failCount - b.failCount;
            });
            selectedNode = eligible[0].candidate;
            this.currentIndex = (eligible[0].index + 1) % this.nodes.length;
        }

        if (!selectedNode) {
            if (!allowCooldownFallback) {
                // Background refresh without storming cooldown nodes
                this.fetchNodes().catch(() => {});
                return null;
            }

            // All nodes are in cooldown. Prefer nodes that are NOT INCOMPATIBLE_API, then earliest expiring
            const inCooldownNodes = this.nodes.map(node => {
                const key = `${node.host}:${node.port}`;
                const record = this.failedNodes.get(key);
                const isIncompatible = record?.category === 'INCOMPATIBLE_API';
                return {
                    node,
                    cooldownUntil: record ? record.cooldownUntil : 0,
                    isIncompatible
                };
            });
            inCooldownNodes.sort((a, b) => {
                if (a.isIncompatible !== b.isIncompatible) return a.isIncompatible ? 1 : -1;
                return a.cooldownUntil - b.cooldownUntil;
            });
            selectedNode = inCooldownNodes[0].node;
            logger.warn(`All ${this.nodes.length} public nodes are in cooldown; retrying ${selectedNode.host}:${selectedNode.port} early`);

            // Proactively trigger refresh of node list in background
            this.fetchNodes().catch(() => {});
        }

        return validateAndFormatNodeOption({
            host: selectedNode.host,
            port: selectedNode.port,
            authorization: selectedNode.password || selectedNode.authorization,
            secure: selectedNode.secure,
            id: 'main-node',
            retryAmount: 3,
            retryDelay: 2000,
        });
    }

    hasNodes() {
        return this.nodes.length > 0;
    }

    startAutoRefresh() {
        if (this.refreshInterval) return;

        this.refreshInterval = setInterval(() => {
            this.fetchNodes().catch((err) => {
                logger.debug('Background public node refresh failed:', err?.message || err);
            });
        }, REFRESH_INTERVAL_MS);
        if (typeof this.refreshInterval.unref === 'function') {
            this.refreshInterval.unref();
        }
    }

    destroy() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.failedNodes.clear();
    }
}

module.exports = PublicNodeProvider;
