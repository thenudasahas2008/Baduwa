const logger = require('./logger');

/**
 * Redacts passwords, tokens, and authorization strings from error messages and logs.
 */
function sanitizeError(error, passwordToRedact) {
    let msg = error?.message || String(error || 'Unknown error');
    if (passwordToRedact && typeof passwordToRedact === 'string' && passwordToRedact.length > 1) {
        msg = msg.split(passwordToRedact).join('[REDACTED]');
    }
    // Redact Discord tokens or secret patterns
    msg = msg.replace(/([a-zA-Z0-9_-]{24,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{27,})/g, '[REDACTED_TOKEN]');
    msg = msg.replace(/(authorization:\s*)([^\s,]+)/gi, '$1[REDACTED]');
    msg = msg.replace(/(password:\s*)([^\s,]+)/gi, '$1[REDACTED]');
    return msg;
}

/**
 * Validates and converts any raw Lavalink node specification into a strictly compliant
 * NodeOptions object matching the installed lavalink-client API.
 *
 * Rules enforced by lavalink-client (ManagerUtils.isNodeOptions and LavalinkNode constructor):
 * 1. host must be a non-empty string.
 * 2. port must be an integer between 1 and 65535.
 * 3. authorization must be a non-empty string (from 'authorization' or 'password').
 * 4. If secure is true, port MUST be 443 (otherwise LavalinkNode throws a SyntaxError).
 * 5. If retryAmount is present, it MUST be a number > 0 (retryAmount <= 0 fails isNodeOptions).
 * 6. If retryDelay is present, it MUST be a number > 0.
 * 7. If requestTimeout is present, it MUST be a number > 0.
 * 8. id must be a string.
 *
 * @param {object} rawNode
 * @param {string} [defaultId='main-node']
 * @returns {object|null} Formatted NodeOptions object or null if invalid
 */
function validateAndFormatNodeOption(rawNode, defaultId = 'main-node') {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
        return null;
    }

    const host = String(rawNode.host || '').trim();
    const port = Number(rawNode.port);
    const authorization = String(rawNode.authorization || rawNode.password || '').trim();

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !authorization) {
        return null;
    }

    // lavalink-client strictly throws if secure === true and port !== 443
    const secure = rawNode.secure === true && port === 443;
    const id = String(rawNode.id || defaultId).trim() || defaultId;

    const formatted = {
        host,
        port,
        authorization,
        secure,
        id,
    };

    // retryAmount must be > 0 if present in NodeOptions
    if (typeof rawNode.retryAmount === 'number' && Number.isFinite(rawNode.retryAmount) && rawNode.retryAmount > 0) {
        formatted.retryAmount = Math.floor(rawNode.retryAmount);
    } else {
        formatted.retryAmount = 3;
    }

    // retryDelay must be > 0 if present
    if (typeof rawNode.retryDelay === 'number' && Number.isFinite(rawNode.retryDelay) && rawNode.retryDelay > 0) {
        formatted.retryDelay = Math.floor(rawNode.retryDelay);
    } else {
        formatted.retryDelay = 2000;
    }

    // requestTimeout must be > 0 if present
    if (typeof rawNode.requestTimeout === 'number' && Number.isFinite(rawNode.requestTimeout) && rawNode.requestTimeout > 0) {
        formatted.requestTimeout = Math.floor(rawNode.requestTimeout);
    } else {
        formatted.requestTimeout = 7500;
    }

    // requestSignalTimeoutMS is checked by lavalink-client rawRequest
    formatted.requestSignalTimeoutMS = formatted.requestTimeout || 7500;

    return formatted;
}

/**
 * Validates an array of node options and ensures at least 1 valid node exists.
 * @param {Array<object>} nodes
 * @returns {Array<object>} Array of valid NodeOptions
 * @throws {SyntaxError} If nodes is not an array or contains 0 valid nodes
 */
function toValidNodeArray(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
        throw new SyntaxError("ManagerOption.nodes must be an Array of NodeOptions or the Node-Classes 'NodeLinkNode' or 'LavalinkNode' and is required of at least 1 Node");
    }

    const validated = nodes
        .map((n, i) => validateAndFormatNodeOption(n, `node-${i + 1}`))
        .filter(Boolean);

    if (validated.length === 0) {
        throw new SyntaxError("ManagerOption.nodes must be an Array of NodeOptions or the Node-Classes 'NodeLinkNode' or 'LavalinkNode' and is required of at least 1 Node");
    }

    return validated;
}

/**
 * Global prototype-level defense: ensures no WebSocket instance in ws can emit
 * an unhandled 'error' event to an EventEmitter with 0 error listeners, which would
 * cause Node.js to throw an uncaughtException and terminate the process.
 */
function installWebSocketProtection() {
    try {
        const WebSocket = require('ws');
        if (WebSocket && WebSocket.prototype && !WebSocket.prototype._antigravityProtected) {
            WebSocket.prototype._antigravityProtected = true;
            const originalEmit = WebSocket.prototype.emit;
            WebSocket.prototype.emit = function (type, ...args) {
                if (type === 'error' && this.listenerCount('error') === 0) {
                    // Prevent Node.js from throwing an Unhandled 'error' event crash
                    // when a socket is torn down and its listeners were stripped.
                    return false;
                }
                return originalEmit.apply(this, [type, ...args]);
            };
        }
    } catch (_) {}
}

// Install prototype protection immediately upon module load
installWebSocketProtection();

/**
 * Attaches a permanent error handler to a WebSocket instance and ensures removeAllListeners
 * and removeListener cannot strip away the error handler, preventing Node.js unhandled 'error' events.
 * @param {object} socket
 */
function protectSocket(socket) {
    if (!socket || typeof socket.on !== 'function') return;

    // Attach permanent no-op error handler
    if (socket.listenerCount('error') === 0) {
        socket.on('error', () => {});
    }

    if (typeof socket.removeAllListeners === 'function' && !socket._antigravityProtected) {
        socket._antigravityProtected = true;
        const origRemoveAll = socket.removeAllListeners.bind(socket);
        socket.removeAllListeners = function (event) {
            try {
                origRemoveAll(event);
            } catch (_) {}
            socket.on('error', () => {});
            return this;
        };

        const origRemoveListener = socket.removeListener.bind(socket);
        socket.removeListener = function (event, listener) {
            try {
                origRemoveListener(event, listener);
            } catch (_) {}
            if (event === 'error' && socket.listenerCount('error') === 0) {
                socket.on('error', () => {});
            }
            return this;
        };
        socket.off = socket.removeListener;
    }
}

/**
 * Hooks a LavalinkNode's open() method so that any thrown errors during info-fetching
 * or version validation are caught locally, typed, and emitted as 'error' on NodeManager
 * instead of bubbling as an unhandled promise rejection from an async WebSocket event.
 * @param {object} node
 */
function hookNodeOpen(node) {
    if (!node || Object.prototype.hasOwnProperty.call(node, '_antigravityOpenHooked') || typeof node.open !== 'function') return;
    try {
        const { LavalinkNode } = require('lavalink-client');
        if (node === LavalinkNode?.prototype) return;
    } catch (_) {}
    node._antigravityOpenHooked = true;

    const origOpen = node.open;
    node.open = async function () {
        this._lastRequestError = null;
        try {
            const res = await origOpen.call(this);
            if (!this.info && ['v3', 'v4'].includes(this.version)) {
                if (this._lastRequestError) {
                    throw this._lastRequestError;
                }
                throw new Error(`Lavalink Node (${this.restAddress}) does not provide any /${this.version}/info`);
            }
            return res;
        } catch (error) {
            const host = this.options?.host || this.host || 'unknown';
            const port = this.options?.port || this.port || 'unknown';
            const safeMsg = sanitizeError(error, this.options?.authorization);

            let category = error?.category || this._lastRequestError?.category || 'HANDSHAKE_ERROR';
            const isLocalWrapperError = error instanceof TypeError ||
                safeMsg.includes('isNodelink') ||
                safeMsg.includes('not connected');

            const isTransientServerOrNet = (error?.status >= 500) ||
                (this._lastRequestError?.status >= 500) ||
                /500|502|503|504|proxy error|connection refused|econnrefused|econnreset|epipe/i.test(safeMsg);

            if (isLocalWrapperError) {
                category = 'WRAPPER_ERROR';
            } else if (isTransientServerOrNet) {
                category = 'TRANSIENT_ERROR';
            } else if (error?.status === 401 || error?.status === 403 || /401|403|unauthorized|auth_failed/i.test(safeMsg)) {
                category = 'AUTH_FAILED';
            } else if (error?.status === 429 || /429|rate_limited|rate limit/i.test(safeMsg)) {
                category = 'RATE_LIMITED';
            } else if (safeMsg.includes('timeout') || safeMsg.includes('ETIMEDOUT') || safeMsg.includes('TIMEOUT')) {
                category = 'TIMEOUT';
            } else if (!category || category === 'HANDSHAKE_ERROR') {
                if ((error?.status === 404 || this._lastRequestError?.status === 404 || safeMsg.includes('404') || safeMsg.includes('does not provide any') || safeMsg.includes('non-JSON')) && !isTransientServerOrNet) {
                    category = 'INCOMPATIBLE_API';
                }
            }

            logger.warn(`Lavalink node ${host}:${port} handshake failed [${category}]: ${safeMsg}`);

            try {
                if (this.socket && typeof this.socket.close === 'function') {
                    this.socket.close(4000, 'HandshakeValidationFailed');
                }
            } catch (_) {}

            if (this.NodeManager && typeof this.NodeManager.emit === 'function') {
                const emittedError = new Error(`Handshake failed [${category}]: ${safeMsg}`);
                emittedError.category = category;
                emittedError.status = error?.status || this._lastRequestError?.status || null;
                this.NodeManager.emit('error', this, emittedError);
            }
        }
    };
}

/**
 * Hooks a LavalinkNode's request() method so that plain-text or HTML responses
 * (such as plain-text error pages) are handled safely without throwing raw SyntaxErrors
 * that produce noisy console output or unhandled promise rejections, while ensuring
 * handshake requests (/info, /version) are never blocked prior to full connection.
 * @param {object} node
 */
function hookNodeRequest(node) {
    if (!node || Object.prototype.hasOwnProperty.call(node, '_antigravityRequestHooked') || typeof node.request !== 'function') return;
    try {
        const { LavalinkNode } = require('lavalink-client');
        if (node === LavalinkNode?.prototype) return;
    } catch (_) {}
    node._antigravityRequestHooked = true;

    node.request = async function (endpoint, modify, parseAsText) {
        const normalizedEndpoint = String(endpoint || '').replace(/^\/v[0-9]+/, '');
        const isHandshakeEndpoint = normalizedEndpoint === '/info' ||
            normalizedEndpoint === '/version' ||
            normalizedEndpoint.startsWith('/info?') ||
            normalizedEndpoint.startsWith('/version?');

        const isConnectingOrOpen = this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1);
        const isHandshakeInit = isHandshakeEndpoint || (!this.info && isConnectingOrOpen);

        // Safety check: disconnected requests after initialization must still be blocked
        if (!this.connected && !isHandshakeInit) {
            throw new Error('The node is not connected to the Lavalink Server! Please call node.connect() first!');
        }

        const { response, options } = await this.rawRequest(endpoint, modify);
        if (options && ['DELETE', 'PUT'].includes(options.method)) return;
        if (response.status === 204) return;
        if (response.status === 404) {
            const err = new Error(`Node Request resulted into an error, request-PATH: ${options?.path || endpoint} (HTTP 404)`);
            err.status = 404;
            err.category = 'INCOMPATIBLE_API';
            this._lastRequestError = err;
            throw err;
        }

        if (response.status === 401 || response.status === 403) {
            const err = new Error(`Node Request resulted into an error, request-PATH: ${options?.path || endpoint} (HTTP ${response.status}) [AUTH_FAILED]`);
            err.status = response.status;
            err.category = 'AUTH_FAILED';
            this._lastRequestError = err;
            throw err;
        }

        if (response.status === 429) {
            const err = new Error(`Node Request resulted into an error, request-PATH: ${options?.path || endpoint} (HTTP 429) [RATE_LIMITED]`);
            err.status = 429;
            err.category = 'RATE_LIMITED';
            this._lastRequestError = err;
            throw err;
        }

        if (parseAsText) {
            return await response.text();
        }

        const rawText = await response.text();
        if (!rawText || !rawText.trim()) {
            return null;
        }

        try {
            return JSON.parse(rawText);
        } catch (jsonErr) {
            const host = this.options?.host || this.host || 'unknown';
            const port = this.options?.port || this.port || 'unknown';
            const snippet = rawText.slice(0, 80).replace(/[\r\n\t]/g, ' ');
            logger.warn(`Lavalink node ${host}:${port} returned non-JSON response for ${endpoint} (HTTP ${response.status}): "${snippet}"`);
            const err = new Error(`Lavalink Node (${this.restAddress || `${host}:${port}`}) returned non-JSON response for ${endpoint} (HTTP ${response.status}): ${snippet}`);
            err.status = response.status;
            err.category = response.status >= 500 ? 'TRANSIENT_ERROR' : 'INCOMPATIBLE_API';
            this._lastRequestError = err;
            throw err;
        }
    };
}

/**
 * Hooks a LavalinkNode instance so that the instant `this.socket = new WebSocket(...)`
 * is assigned inside `connect()`, `protectSocket` is attached before any event loop tick,
 * and open/request methods are protected against unhandled rejections and parse crashes.
 * @param {object} node
 */
function attachNodeProtection(node) {
    if (!node) return node;

    hookNodeOpen(node);
    hookNodeRequest(node);

    if (node._antigravitySocketHooked) return node;
    node._antigravitySocketHooked = true;

    let _socket = node.socket || null;
    if (_socket) {
        protectSocket(_socket);
    }

    try {
        Object.defineProperty(node, 'socket', {
            configurable: true,
            enumerable: true,
            get() {
                return _socket;
            },
            set(sock) {
                _socket = sock;
                if (sock) {
                    protectSocket(sock);
                }
            }
        });
    } catch (_) {}

    return node;
}

/**
 * Safely destroys and removes a LavalinkNode without triggering the Node.js
 * unhandled 'error' event crash caused by ws.close() + removeAllListeners() on connecting sockets.
 * @param {object} nodeManager
 * @param {object|string} node
 */
function safeDeleteNode(nodeManager, node) {
    if (!nodeManager || !node) return;

    try {
        const targetNode = typeof node === 'string' ? nodeManager?.nodes?.get(node) : node;
        if (!targetNode) return;

        // Cancel any pending reconnect on the LavalinkNode so it doesn't try to open another socket
        if (targetNode.reconnectTimeout) {
            clearTimeout(targetNode.reconnectTimeout);
            targetNode.reconnectTimeout = null;
        }
        targetNode.reconnectionState = 'IDLE';

        // Defend against the ws removeAllListeners unhandled error race condition
        const socket = targetNode.socket;
        if (socket) {
            protectSocket(socket);

            // If socket is still connecting (readyState 0), terminate it directly
            // (Calling close(1000) on a connecting socket triggers 'WebSocket was closed before the connection was established')
            if (socket.readyState === 0 /* CONNECTING */) {
                try {
                    socket.terminate();
                } catch (_) {}
            } else {
                try {
                    socket.close(1000, 'Node-Destroy');
                } catch (_) {}
            }
            targetNode.socket = null;
        }

        // Call targetNode.destroy safely
        try {
            if (typeof targetNode.destroy === 'function') {
                targetNode.destroy('NodeDeleted', true, false);
            }
        } catch (_) {}

        // Remove from NodeManager nodes map
        if (nodeManager?.nodes && typeof nodeManager.nodes.delete === 'function') {
            nodeManager.nodes.delete(targetNode.id);
        }
    } catch (err) {
        logger.debug(`safeDeleteNode error: ${err?.message || err}`);
    }
}

module.exports = {
    validateAndFormatNodeOption,
    toValidNodeArray,
    sanitizeError,
    protectSocket,
    attachNodeProtection,
    installWebSocketProtection,
    safeDeleteNode,
};
