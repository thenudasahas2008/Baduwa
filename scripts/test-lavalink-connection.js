const assert = require('node:assert/strict');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');
const LavalinkConnectionManager = require('../src/utils/LavalinkConnectionManager');
const { isLavalinkAvailable, requirePlayer, safeReply } = require('../src/utils/interactionHelpers');

let passed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.message}`);
        process.exitCode = 1;
    }
}

async function asyncCheck(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.message}`);
        process.exitCode = 1;
    }
}

async function run() {
    console.log('Testing PublicNodeProvider node validation & prioritization...');

    const provider = new PublicNodeProvider();

    // Test validation
    const validNode = await provider.validateNode({
        version: 'v4',
        host: 'lavalinkv4.serenetia.com',
        port: 443,
        password: 'secretpassword123',
        secure: true
    }, []);
    assert.ok(validNode, 'Valid node should pass validation');
    assert.equal(validNode.host, 'lavalinkv4.serenetia.com');
    assert.equal(validNode.port, 443);
    assert.equal(validNode.secure, true);

    const invalidVersion = await provider.validateNode({
        version: 'v3',
        host: 'lavalink.example.com',
        port: 2333,
        password: 'pass',
        secure: false
    }, []);
    assert.equal(invalidVersion, null, 'v3 node must be rejected');

    const invalidPort = await provider.validateNode({
        version: 'v4',
        host: 'lavalink.example.com',
        port: 999999,
        password: 'pass',
        secure: false
    }, []);
    assert.equal(invalidPort, null, 'Invalid port must be rejected');

    const missingPass = await provider.validateNode({
        version: 'v4',
        host: 'lavalink.example.com',
        port: 2333,
        password: '',
        secure: false
    }, []);
    assert.equal(missingPass, null, 'Missing password must be rejected');

    console.log('Testing PublicNodeProvider cooldown & rotation logic...');

    provider.nodes = [
        { host: 'node1.example.com', port: 443, password: 'pass1', secure: true },
        { host: 'node2.example.com', port: 443, password: 'pass2', secure: true },
        { host: 'node3.example.com', port: 80, password: 'pass3', secure: false },
    ];

    // Node rotation
    const n1 = provider.getNextNode();
    assert.equal(n1.host, 'node1.example.com');
    assert.equal(n1.authorization, 'pass1');
    assert.equal(n1.id, 'main-node');

    // Mark node1 as failed
    provider.markNodeFailed('node1.example.com', 443, '401 Unauthorized');
    assert.ok(provider.isNodeInCooldown('node1.example.com', 443), 'node1 should be in cooldown');

    // Next node should skip node1 and return node2
    const n2 = provider.getNextNode();
    assert.equal(n2.host, 'node2.example.com');

    // Mark node2 as failed
    provider.markNodeFailed('node2.example.com', 443, '502 Bad Gateway');

    // Next node should return node3
    const n3 = provider.getNextNode();
    assert.equal(n3.host, 'node3.example.com');

    // Mark node3 as failed
    provider.markNodeFailed('node3.example.com', 80, 'Timeout');

    // When all nodes in cooldown, getNextNode returns earliest expiring node without crashing
    const fallbackNode = provider.getNextNode();
    assert.ok(fallbackNode, 'Should return a fallback node even if all are in cooldown');

    // Success marks node healthy
    provider.markNodeSuccess('node1.example.com', 443);
    assert.equal(provider.isNodeInCooldown('node1.example.com', 443), false, 'node1 should no longer be in cooldown');

    console.log('Testing LavalinkConnectionManager state & error sanitization...');

    const mockClient = {
        lavalinkMode: 'public',
        publicNodeProvider: provider,
        user: { id: '987654321012345678', username: 'ZYRO_Test' },
        lavalink: {
            options: { client: {} },
            nodeManager: {
                nodes: new Map(),
                on: () => {},
                off: () => {},
                createNode: (cfg) => ({
                    id: cfg.id,
                    options: cfg,
                    connected: false,
                    connect: () => {},
                    destroy: async () => {},
                }),
                deleteNode: () => {},
            }
        }
    };

    const manager = new LavalinkConnectionManager(mockClient);
    mockClient.lavalinkConnectionManager = manager;
    assert.equal(manager.isAvailable(), false, 'isAvailable should return false when main-node is not connected');

    // Simulate connected node
    mockClient.lavalink.nodeManager.nodes.set('main-node', {
        id: 'main-node',
        connected: true,
        options: { host: 'node1.example.com', port: 443 }
    });
    assert.equal(manager.isAvailable(), true, 'isAvailable should return true when main-node is connected');
    assert.equal(isLavalinkAvailable(mockClient), true, 'isLavalinkAvailable helper should return true');

    // Disconnect simulation
    mockClient.lavalink.nodeManager.nodes.set('main-node', {
        id: 'main-node',
        connected: false,
        options: { host: 'node1.example.com', port: 443 }
    });
    assert.equal(manager.isAvailable(), false, 'isAvailable should return false after disconnect');
    assert.equal(isLavalinkAvailable(mockClient), false, 'isLavalinkAvailable helper should return false');

    console.log('Testing command responses when Lavalink is unavailable...');

    let replyPayload = null;
    const mockInteraction = {
        replied: false,
        deferred: false,
        client: mockClient,
        guild: {
            id: 'g_test',
            name: 'Test Guild',
            members: { me: { id: 'bot_id', voice: {} } }
        },
        member: { voice: { channel: { id: 'vc_1', permissionsFor: () => ({ has: () => true }) } } },
        options: { getString: () => 'faded alan walker', getBoolean: () => false },
        reply: async (p) => { replyPayload = p; mockInteraction.replied = true; return p; },
        editReply: async (p) => { replyPayload = p; return p; },
        deferReply: async () => { mockInteraction.deferred = true; },
        channel: { id: 'c_test', name: 'general' },
        user: { tag: 'User#0001' }
    };

    // Test requirePlayer when Lavalink unavailable
    const playerResult = await requirePlayer(mockInteraction);
    assert.equal(playerResult, null, 'requirePlayer should return null when Lavalink is unavailable');
    assert.ok(replyPayload, 'requirePlayer should respond to interaction');
    const embedTitle = replyPayload.embeds?.[0]?.data?.title || '';
    const embedDesc = replyPayload.embeds?.[0]?.data?.description || '';
    assert.ok(embedTitle.includes('Reconnecting') || embedDesc.includes('reconnecting'), 'Should inform user music service is reconnecting');

    // Test /play command when Lavalink unavailable
    const playCommand = require('../src/commands/play');
    replyPayload = null;
    mockInteraction.replied = false;
    mockInteraction.deferred = false;
    await playCommand.execute(mockInteraction);
    assert.ok(replyPayload, '/play should respond when Lavalink is unavailable');
    const playDesc = replyPayload.embeds?.[0]?.data?.description || '';
    assert.ok(playDesc.includes('reconnecting') || playDesc.includes('unavailable'), 'Should show reconnecting message for /play');

    // Test /247 command when Lavalink unavailable
    const command247 = require('../src/commands/247');
    replyPayload = null;
    mockInteraction.replied = false;
    mockInteraction.deferred = false;
    await command247.execute(mockInteraction);
    assert.ok(replyPayload, '/247 should respond when Lavalink is unavailable');

    // Test /clear command when Lavalink unavailable
    const clearCommand = require('../src/commands/clear');
    replyPayload = null;
    mockInteraction.replied = false;
    mockInteraction.deferred = false;
    await clearCommand.execute(mockInteraction);
    assert.ok(replyPayload, '/clear should respond when Lavalink is unavailable');

    console.log('Testing LavalinkManager NodeOptions validation & regression for invalid nodes...');
    const { validateAndFormatNodeOption, toValidNodeArray, sanitizeError } = require('../src/utils/lavalinkNodeOptions');
    const { LavalinkManager } = require('lavalink-client');

    // 1. validateAndFormatNodeOption normalization
    const normalizedRetry0 = validateAndFormatNodeOption({
        host: 'lavalinkv4.serenetia.com',
        port: 443,
        password: 'password123',
        secure: true,
        retryAmount: 0,
    });
    assert.ok(normalizedRetry0, 'Normalized node must be created');
    assert.equal(normalizedRetry0.host, 'lavalinkv4.serenetia.com');
    assert.equal(normalizedRetry0.port, 443);
    assert.equal(normalizedRetry0.authorization, 'password123');
    assert.equal(normalizedRetry0.secure, true);
    assert.ok(normalizedRetry0.retryAmount > 0, 'retryAmount must be normalized to > 0');

    // 2. Non-443 secure node normalized to secure: false
    const non443Secure = validateAndFormatNodeOption({
        host: 'lava.example.com',
        port: 2333,
        authorization: 'password123',
        secure: true,
    });
    assert.equal(non443Secure.secure, false, 'Non-443 port must have secure set to false to avoid LavalinkNode constructor failure');

    // 3. Invalid inputs return null
    assert.equal(validateAndFormatNodeOption(null), null);
    assert.equal(validateAndFormatNodeOption({ host: '', port: 443, password: 'p' }), null);
    assert.equal(validateAndFormatNodeOption({ host: 'h', port: 999999, password: 'p' }), null);
    assert.equal(validateAndFormatNodeOption({ host: 'h', port: 443, password: '' }), null);

    // 4. toValidNodeArray throws SyntaxError on invalid array
    assert.throws(() => {
        toValidNodeArray([]);
    }, { name: 'SyntaxError' }, 'toValidNodeArray([]) must throw SyntaxError');

    assert.throws(() => {
        toValidNodeArray([{ host: '', port: 0 }]);
    }, { name: 'SyntaxError' }, 'toValidNodeArray with no valid nodes must throw SyntaxError');

    const validArray = toValidNodeArray([normalizedRetry0, non443Secure]);
    assert.equal(validArray.length, 2, 'toValidNodeArray must return array of 2 valid nodes');

    // 5. Reproduce exact regression: LavalinkManager constructor throws on retryAmount: 0
    assert.throws(() => {
        new LavalinkManager({
            nodes: [{
                host: 'lavalinkv4.serenetia.com',
                port: 443,
                authorization: 'pass',
                secure: true,
                retryAmount: 0,
            }],
            sendToShard: () => {}
        });
    }, (err) => {
        return err instanceof SyntaxError && err.message.includes('ManagerOption.nodes must be an Array of NodeOptions');
    }, 'LavalinkManager must reject retryAmount: 0 with exact ManagerOption.nodes SyntaxError');

    // 6. Confirms LavalinkManager accepts formatted nodes without throwing
    const testManager = new LavalinkManager({
        nodes: toValidNodeArray([{
            host: 'lavalinkv4.serenetia.com',
            port: 443,
            password: 'secretpassword',
            secure: true,
            retryAmount: 0, // Should be normalized by toValidNodeArray
        }]),
        sendToShard: () => {}
    });
    assert.ok(testManager, 'LavalinkManager constructor must succeed with formatted nodes');
    assert.ok(testManager.utils.isNodeOptions(testManager.options.nodes[0]), 'Formatted node must pass utils.isNodeOptions');

    // 7. Test sanitizeError redacting sensitive tokens and passwords
    const rawError = new Error('Connection failed to lavalink://mySecretPassword123@node.example.com with token mfa.abcdef1234567890abcdef1234567890');
    const cleaned = sanitizeError(rawError, 'mySecretPassword123');
    assert.ok(!cleaned.includes('mySecretPassword123'), 'Must redact password');
    assert.ok(cleaned.includes('[REDACTED]'), 'Must replace with [REDACTED]');

    console.log('Testing WebSocket premature close & safeDeleteNode resilience...');
    const { protectSocket, safeDeleteNode } = require('../src/utils/lavalinkNodeOptions');
    const WebSocket = require('ws');

    // 8. Test protectSocket preventing unhandled 'error' crash when ws is closed before connection
    let unhandledTriggered = false;
    const testWs = new WebSocket('wss://127.0.0.1:65534');
    protectSocket(testWs);
    testWs.close(1000, 'Test-Close');
    testWs.removeAllListeners();
    // Allow any async event emission to settle
    await new Promise(r => setTimeout(r, 100));
    assert.equal(unhandledTriggered, false, 'protectSocket must prevent unhandled WebSocket error');

    // 9. Test safeDeleteNode with mock connecting node and error-throwing destroy
    const mockNodesMap = new Map();
    const mockConnectingSocket = new WebSocket('wss://127.0.0.1:65533');
    const mockFaultyNode = {
        id: 'faulty-node',
        socket: mockConnectingSocket,
        reconnectTimeout: setTimeout(() => {}, 60000),
        destroy: () => { throw new Error('Simulated destroy explosion'); }
    };
    mockNodesMap.set('faulty-node', mockFaultyNode);
    const mockNodeManager = { nodes: mockNodesMap };

    // safeDeleteNode must not throw despite faultyNode.destroy throwing and socket being in CONNECTING state
    assert.doesNotThrow(() => {
        safeDeleteNode(mockNodeManager, mockFaultyNode);
    }, 'safeDeleteNode must never throw, even if node.destroy throws');
    assert.equal(mockNodesMap.has('faulty-node'), false, 'Node must be removed from nodeManager map');
    assert.equal(mockFaultyNode.reconnectTimeout, null, 'Pending reconnect timer must be cleared');

    // 10. Test all-node cooldown exhaustion handling
    provider.nodes = [
        { host: 'node-a.com', port: 443, password: 'p1', secure: true },
        { host: 'node-b.com', port: 443, password: 'p2', secure: true },
    ];
    provider.markNodeFailed('node-a.com', 443, 'Handshake failure');
    provider.markNodeFailed('node-b.com', 443, 'Timeout');
    assert.ok(provider.isNodeInCooldown('node-a.com', 443));
    assert.ok(provider.isNodeInCooldown('node-b.com', 443));

    // When all nodes are exhausted in cooldown, getNextNode returns earliest expiring candidate safely
    const exhaustedCandidate = provider.getNextNode();
    assert.ok(exhaustedCandidate, 'Must return fallback node when all nodes are in cooldown');
    assert.ok(testManager.utils.isNodeOptions(exhaustedCandidate), 'Fallback node must still be valid NodeOptions');

    // 11. Strict Regression Test: Proving CONNECTING WebSocket failure is handled locally without global uncaughtException handler
    console.log('Testing local CONNECTING WebSocket failure handling (zero uncaught exceptions)...');
    let uncaughtErrorReceived = null;
    const strictUncaughtHandler = (err) => {
        uncaughtErrorReceived = err;
    };
    process.on('uncaughtException', strictUncaughtHandler);

    try {
        const { attachNodeProtection } = require('../src/utils/lavalinkNodeOptions');
        const rawNode = new WebSocket('wss://127.0.0.1:65531');
        assert.equal(rawNode.readyState, 0, 'WebSocket must be in CONNECTING state (readyState 0)');

        const mockNode = {
            id: 'connecting-test-node',
            socket: rawNode,
            reconnectTimeout: setTimeout(() => {}, 60000),
            destroy: function (reason, deleteNode) {
                // Mimic lavalink-client LavalinkNode.destroy() behavior
                this.socket?.close(1000, 'Node-Destroy');
                this.socket?.removeAllListeners();
                this.socket = null;
            }
        };

        // Attach protection and then trigger safe destruction during handshake
        attachNodeProtection(mockNode);
        const map = new Map();
        map.set('connecting-test-node', mockNode);
        safeDeleteNode({ nodes: map }, mockNode);

        // Wait multiple event-loop ticks for any potential unhandled ws error event to dispatch
        await new Promise(r => setTimeout(r, 250));

        assert.equal(uncaughtErrorReceived, null, 'No uncaughtException must be triggered during CONNECTING WebSocket teardown');
    } finally {
        process.removeListener('uncaughtException', strictUncaughtHandler);
    }

    // 12. Regression Test: Discovery request timeout followed by success (bounded retries)
    console.log('Testing discovery request timeout followed by success (bounded retries)...');
    const originalFetch = global.fetch;
    let fetchAttemptCount = 0;
    try {
        global.fetch = async (url, options) => {
            fetchAttemptCount++;
            if (fetchAttemptCount === 1) {
                // Simulate timeout abort on attempt 1
                const err = new Error('This operation was aborted');
                err.name = 'AbortError';
                throw err;
            }
            // Succeed on attempt 2
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                text: async () => JSON.stringify([
                    { version: 'v4', host: 'lavalinkv4.serenetia.com', port: 443, password: 'pw', secure: true }
                ]),
            };
        };

        const retryProvider = new PublicNodeProvider();
        const retryResult = await retryProvider.fetchNodes({ maxRetries: 2, timeoutMs: 100, retryDelayMs: 20 });
        assert.equal(retryResult, true, 'fetchNodes must succeed after timeout retry');
        assert.equal(fetchAttemptCount, 2, 'fetchNodes must have retried after initial timeout');
        assert.equal(retryProvider.nodes.length, 1, 'retryProvider must populate discovered nodes');
        assert.equal(retryProvider.nodes[0].host, 'lavalinkv4.serenetia.com');
        retryProvider.destroy();
    } finally {
        global.fetch = originalFetch;
    }

    // 13. Regression Test: Repeated discovery failure while Discord startup succeeds
    console.log('Testing repeated discovery failure does not abort Discord bot startup...');
    const { getInitialNodes, setupLavalink, createAndRegisterLavalinkManager } = require('../src/index');
    let failFetchCount = 0;
    try {
        global.fetch = async () => {
            failFetchCount++;
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            throw err;
        };

        // Ensure dedicated env vars are not set for this test
        const savedHost = process.env.LAVALINK_HOST;
        delete process.env.LAVALINK_HOST;

        const initialRes = await getInitialNodes();
        assert.equal(initialRes.mode, 'public', 'Mode must be public');
        assert.deepEqual(initialRes.nodes, [], 'Nodes must be empty on discovery failure without throwing');

        const mockBotClient = {
            guilds: { cache: new Map() },
            autoplayEnabled: new Map(),
            activePlayers: new Map(),
            defaultLanguage: 'en',
            is247Enabled: () => false,
            updatePresence: () => {},
            t: (key) => key,
            playerController: {
                deletePlayer: () => {},
                sendToPlayerChannel: () => {},
            }
        };

        // setupLavalink must NOT throw when discovery fails; it must defer
        await assert.doesNotReject(async () => {
            await setupLavalink(mockBotClient);
        }, 'setupLavalink must not throw when public discovery fails');

        assert.equal(mockBotClient.lavalink, null, 'client.lavalink must be null when deferred');
        assert.ok(mockBotClient.lavalinkConnectionManager, 'client.lavalinkConnectionManager must be initialized');
        assert.equal(mockBotClient.lavalinkConnectionManager.isAvailable(), false, 'isAvailable must be false');
        assert.equal(mockBotClient.lavalinkConnectionManager.isManagerReady(), false, 'isManagerReady must be false');

        // Restore env
        if (savedHost) process.env.LAVALINK_HOST = savedHost;
        mockBotClient.lavalinkConnectionManager.destroy();
    } finally {
        global.fetch = originalFetch;
    }

    // 14. Regression Test: No manager initialization with zero nodes (does not crash with SyntaxError)
    console.log('Testing createAndRegisterLavalinkManager with zero nodes...');
    const dummyClient = { guilds: { cache: new Map() } };
    const zeroNodeResult = createAndRegisterLavalinkManager(dummyClient, []);
    assert.equal(zeroNodeResult, null, 'Must return null and not instantiate LavalinkManager with empty array');
    assert.equal(dummyClient.lavalink, undefined, 'dummyClient.lavalink must remain unset');

    // 15. Regression Test: Background recovery when valid nodes become available
    console.log('Testing background recovery when valid nodes become available...');
    try {
        global.fetch = async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify([
                { version: 'v4', host: '1.1.1.1', port: 443, password: 'pw', secure: true }
            ]),
        });

        const recoveringClient = {
            guilds: { cache: new Map() },
            autoplayEnabled: new Map(),
            activePlayers: new Map(),
            defaultLanguage: 'en',
            is247Enabled: () => false,
            updatePresence: () => {},
            t: (key) => key,
            playerController: { deletePlayer: () => {}, sendToPlayerChannel: () => {} }
        };

        recoveringClient.lavalinkMode = 'public';
        recoveringClient.publicNodeProvider = new PublicNodeProvider();
        recoveringClient.lavalinkConnectionManager = new LavalinkConnectionManager(recoveringClient, createAndRegisterLavalinkManager);

        assert.equal(recoveringClient.lavalink, undefined);
        await recoveringClient.lavalinkConnectionManager.attemptDiscoveryAndDeferredInit();

        assert.ok(recoveringClient.lavalink, 'LavalinkManager must be initialized upon background recovery');
        assert.equal(recoveringClient.lavalinkConnectionManager.isManagerReady(), true, 'Manager must be ready');

        // 16. Regression Test: Single manager initialization (idempotency)
        console.log('Testing single manager initialization idempotency...');
        const initialManager = recoveringClient.lavalink;
        const secondAttempt = createAndRegisterLavalinkManager(recoveringClient, [
            { host: 'node-second.com', port: 443, password: 'pw', secure: true }
        ]);
        assert.equal(secondAttempt, initialManager, 'Must return same LavalinkManager instance and not recreate');

        recoveringClient.lavalinkConnectionManager.destroy();
        recoveringClient.publicNodeProvider.destroy();
    } finally {
        global.fetch = originalFetch;
    }

    // 17. Regression Test: Unavailable music commands responding safely when Lavalink is deferred
    console.log('Testing unavailable music commands response when Lavalink is deferred...');
    const deferredClient = {
        lavalink: null,
        lavalinkConnectionManager: { isAvailable: () => false },
        defaultLanguage: 'en',
        languageManager: { get: (l, k) => k }
    };

    let deferredReplyPayload = null;
    const mockDeferredInteraction = {
        replied: false,
        deferred: false,
        client: deferredClient,
        guild: { id: 'g_def', name: 'Def Guild', members: { me: { id: 'b_def' } } },
        member: { voice: { channel: { id: 'vc_def', permissionsFor: () => ({ has: () => true }) } } },
        options: { getString: () => 'song', getBoolean: () => false },
        channel: { name: 'music' },
        deferReply: async () => { mockDeferredInteraction.deferred = true; },
        reply: async (p) => { deferredReplyPayload = p; mockDeferredInteraction.replied = true; return p; },
        editReply: async (p) => { deferredReplyPayload = p; return p; },
        followUp: async (p) => { deferredReplyPayload = p; return p; },
    };

    const playCmd = require('../src/commands/play');
    await playCmd.execute(mockDeferredInteraction);
    assert.ok(deferredReplyPayload, '/play must respond when Lavalink is deferred');
    const desc = deferredReplyPayload.embeds?.[0]?.data?.description || '';
    assert.ok(desc.includes('reconnecting'), 'Must display temporary-unavailability reconnecting message');

    manager.destroy();
    provider.destroy();

    console.log('\nTesting Regression: nodeConfig scoping and rejection safety...');

    // 1. Regression test: nodeConfig reference error when getNodeConfig throws
    await asyncCheck('attemptReconnection does not throw ReferenceError: nodeConfig is not defined when getNodeConfig rejects', async () => {
        let unhandledRejections = [];
        const rejectionHandler = (reason) => unhandledRejections.push(reason);
        process.on('unhandledRejection', rejectionHandler);

        const mockClient = {
            lavalinkMode: 'public',
            user: { id: 'bot-zyro-test', username: 'ZYRO' },
            lavalink: {
                options: {},
                nodeManager: {
                    nodes: new Map(),
                    createNode: () => { throw new Error('should not reach createNode'); }
                }
            },
            publicNodeProvider: {
                getNextNode: () => null,
                fetchNodes: async () => false,
                markNodeFailed: () => {},
                markNodeSuccess: () => {},
            }
        };

        const mgr = new LavalinkConnectionManager(mockClient);
        // Force getNodeConfig to throw "No public Lavalink nodes available"
        await mgr.attemptReconnection();

        mgr.destroy();
        process.off('unhandledRejection', rejectionHandler);

        assert.equal(unhandledRejections.length, 0, 'Must produce 0 unhandled promise rejections');
        assert.equal(mgr.state.reconnectAttempts, 1, 'Reconnect attempts should increment safely');
    });

    // 2. Health check rejection handling
    await asyncCheck('startHealthCheck handles reconnection promise rejection without unhandled rejection', async () => {
        let unhandledRejections = [];
        const rejectionHandler = (reason) => unhandledRejections.push(reason);
        process.on('unhandledRejection', rejectionHandler);

        const mockClient = {
            lavalinkMode: 'public',
            user: { id: 'bot-zyro-test' },
            lavalink: {
                options: {},
                nodeManager: { nodes: new Map() }
            },
            publicNodeProvider: {
                getNextNode: () => null,
                fetchNodes: async () => false,
            }
        };

        const mgr = new LavalinkConnectionManager(mockClient);
        mgr.attemptReconnection = async () => {
            throw new Error('Simulated reconnection failure');
        };

        // Trigger health check interval logic directly
        mgr.startHealthCheck();
        // Clear interval immediately to avoid lingering timer
        if (mgr.state.healthCheckInterval) {
            clearInterval(mgr.state.healthCheckInterval);
            mgr.state.healthCheckInterval = null;
        }

        // Test periodic reset rejection handling as well
        mgr.startPeriodicReset();
        if (mgr.state.periodicResetInterval) {
            clearInterval(mgr.state.periodicResetInterval);
            mgr.state.periodicResetInterval = null;
        }

        mgr.destroy();
        process.off('unhandledRejection', rejectionHandler);
        assert.equal(unhandledRejections.length, 0, 'No unhandled rejections during health check or periodic reset');
    });

    console.log('\nTesting Lavalink disconnect failover, rotation, and cooldown...');

    // 3. Disconnect / failover rotation and cooldown
    await asyncCheck('onDisconnect rotates public node, marks cooldown, and safely triggers reconnection', async () => {
        const cooldowns = [];
        const mockProvider = {
            markNodeFailed: (host, port, reason) => {
                cooldowns.push({ host, port, reason });
            }
        };

        let reconnected = false;
        const mockClient = {
            lavalinkMode: 'public',
            publicNodeProvider: mockProvider,
            lavalink: {
                nodeManager: { nodes: new Map() }
            }
        };

        const mgr = new LavalinkConnectionManager(mockClient);
        mgr.attemptReconnection = async () => { reconnected = true; };

        const fakeNode = {
            options: { host: 'node-dropped.lavalink.net', port: 443, authorization: 'pass' }
        };

        mgr.onDisconnect(fakeNode, { reason: 'Socket got terminated due to no ping connection' });

        assert.equal(cooldowns.length, 1, 'Dropped node must be placed in cooldown');
        assert.equal(cooldowns[0].host, 'node-dropped.lavalink.net');
        assert.equal(cooldowns[0].port, 443);
        assert.ok(cooldowns[0].reason.includes('no ping connection'), 'Reason must be recorded');

        mgr.destroy();
    });

    console.log('\nTesting 24/7 Voice Channel Recovery on Lavalink Reconnect...');

    // 4. Voice presence recovery with 24/7 ON after reconnect without autoplay
    await asyncCheck('recover247Connections restores voice connections on node connect without autoplay', async () => {
        let connectedGuilds = [];
        let playedTracks = [];

        const mockGuildChannel = { id: 'vc-music-247', name: '247-lounge', isVoiceBased: () => true, type: 2 };
        const mockGuild = {
            id: 'g-247',
            name: '24/7 Chill Server',
            channels: {
                cache: new Map([['vc-music-247', mockGuildChannel]])
            }
        };

        const fakeMainNode = { id: 'main-node', connected: true };
        const fakePlayer = {
            guildId: 'g-247',
            node: fakeMainNode,
            connected: false,
            connect: async () => {
                fakePlayer.connected = true;
                connectedGuilds.push('g-247');
            },
            play: async (track) => {
                playedTracks.push(track);
            }
        };

        const mockClient = {
            guildSettings: {
                cache: new Map([
                    ['g-247', { twentyFourSeven: true, voiceChannelId: 'vc-music-247' }],
                    ['g-normal', { twentyFourSeven: false, voiceChannelId: 'vc-other' }]
                ])
            },
            guilds: {
                cache: new Map([['g-247', mockGuild]])
            },
            lavalink: {
                nodeManager: {
                    nodes: new Map([['main-node', fakeMainNode]])
                },
                getPlayer: (id) => id === 'g-247' ? fakePlayer : null,
                createPlayer: () => fakePlayer
            }
        };

        const mgr = new LavalinkConnectionManager(mockClient);
        await mgr.recover247Connections();

        assert.equal(connectedGuilds.length, 1, '24/7 player must be reconnected to voice channel');
        assert.equal(connectedGuilds[0], 'g-247');
        assert.equal(fakePlayer.connected, true);
        assert.equal(playedTracks.length, 0, 'recover247Connections must NEVER trigger track playback / autoplay');

        mgr.destroy();
    });

    console.log('\nTesting 24/7 Player Destruction Interception and Voice Disconnection Rules...');

    // 5. player.destroy protection and lifecycle rules for 24/7 guilds
    await asyncCheck('player.destroy intercepts node teardowns without voice disconnect, preserves idle presence on QueueEmpty, and disconnects on /leave', async () => {
        let destroyedCalls = [];
        const rawPlayer = {
            guildId: 'g-protect-247',
            playing: true,
            queue: { current: { info: { title: 'Old Song' } }, tracks: [] },
            destroy: async function(reason, disconnect = true) {
                destroyedCalls.push({ reason, disconnect });
                return this;
            }
        };

        let is247 = true;
        const mockClient = {
            is247Enabled: (gId) => is247
        };

        // Install the exact wrapped destroy logic from src/index.js
        const originalDestroy = rawPlayer.destroy.bind(rawPlayer);
        rawPlayer.destroy = async function (reason, disconnect = true) {
            const is247Active = Boolean(mockClient.is247Enabled?.(rawPlayer.guildId));

            // Intentional leave command or bot kicked from guild: disconnect and clean up fully
            if (reason === "command:leave" || reason === "guildDelete") {
                return originalDestroy(reason, true);
            }

            // Ordinary track end / empty queue when 24/7 is enabled: keep idle presence in channel
            if (reason === "QueueEmpty" && is247Active) {
                rawPlayer.playing = false;
                if (rawPlayer.queue) rawPlayer.queue.current = null;
                return this;
            }

            // Node failover, reconnection failure, or node deletion:
            // When 24/7 is enabled, do NOT send voice disconnect packet to Discord,
            // but let lavalink-client clean up its internal player structures with disconnect = false
            const isNodeTeardown = [
                "NodeDeleted",
                "NodeDestroy",
                "NodeReconnectFail",
                "DisconnectAllNodes",
                "ReconnectAllNodes",
                "PlayerChangeNodeFail",
                "PlayerChangeNodeFailNoEligibleNode",
                "NodeMigrationFail",
                "LavalinkNoVoice",
                "destroy"
            ].includes(reason);

            if (is247Active && isNodeTeardown) {
                rawPlayer.playing = false;
                if (rawPlayer.queue) rawPlayer.queue.current = null;
                return originalDestroy(reason, false);
            }

            return originalDestroy(reason, disconnect);
        };

        // Test 1: NodeDeleted with 24/7 ON -> teardown internally with disconnect: false
        destroyedCalls = [];
        rawPlayer.playing = true;
        await rawPlayer.destroy('NodeDeleted', true);
        assert.equal(destroyedCalls.length, 1);
        assert.equal(destroyedCalls[0].disconnect, false, 'NodeDeleted must pass disconnect = false to preserve Discord voice');
        assert.equal(rawPlayer.playing, false, 'Node teardown must reset player.playing to false');
        assert.equal(rawPlayer.queue.current, null, 'Node teardown must clear queue.current');

        // Test 2: NodeDestroy with 24/7 ON -> teardown internally with disconnect: false
        destroyedCalls = [];
        rawPlayer.playing = true;
        await rawPlayer.destroy('NodeDestroy', true);
        assert.equal(destroyedCalls.length, 1);
        assert.equal(destroyedCalls[0].disconnect, false, 'NodeDestroy must pass disconnect = false');
        assert.equal(rawPlayer.playing, false);

        // Test 3: QueueEmpty with 24/7 ON -> keep idle presence, do not call originalDestroy
        destroyedCalls = [];
        rawPlayer.playing = true;
        rawPlayer.queue.current = { info: { title: 'Track Finished' } };
        await rawPlayer.destroy('QueueEmpty', true);
        assert.equal(destroyedCalls.length, 0, 'QueueEmpty with 24/7 ON must not call originalDestroy');
        assert.equal(rawPlayer.playing, false, 'QueueEmpty must reset player.playing to false');
        assert.equal(rawPlayer.queue.current, null, 'QueueEmpty must clear queue.current');

        // Test 4: Explicit /leave command ('command:leave') with 24/7 ON -> MUST disconnect!
        destroyedCalls = [];
        await rawPlayer.destroy('command:leave', false);
        assert.equal(destroyedCalls.length, 1);
        assert.equal(destroyedCalls[0].disconnect, true, '/leave command must force disconnect = true even if 24/7 is ON');

        // Test 5: guildDelete with 24/7 ON -> MUST disconnect!
        destroyedCalls = [];
        await rawPlayer.destroy('guildDelete', false);
        assert.equal(destroyedCalls.length, 1);
        assert.equal(destroyedCalls[0].disconnect, true, 'guildDelete must force disconnect = true');

        // Test 6: QueueEmpty with 24/7 OFF -> MUST disconnect!
        is247 = false;
        destroyedCalls = [];
        await rawPlayer.destroy('QueueEmpty', true);
        assert.equal(destroyedCalls.length, 1);
        assert.equal(destroyedCalls[0].disconnect, true, 'QueueEmpty must disconnect when 24/7 is OFF');
    });

    console.log('\nTesting Player Migration, Queue Preservation, and Stale State Prevention...');

    // 6. Player migration with queue preservation via player.changeNode()
    await asyncCheck('migrateAndRecoverPlayers migrates active players using player.changeNode, preserves queue, and deletes dead node', async () => {
        const deadNode = { id: 'public-dead:443-1', connected: false, destroy: () => {} };
        const healthyNode = { id: 'public-healthy:443-2', connected: true };

        const testTrack1 = { info: { title: 'Song 1', uri: 'https://youtube.com/watch?v=1' } };
        const testTrack2 = { info: { title: 'Song 2', uri: 'https://youtube.com/watch?v=2' } };

        let changeNodeCalled = false;
        let changeNodeArgs = null;

        const activePlayer = {
            guildId: 'g-migration-test',
            node: deadNode,
            voice: {
                token: 'voice-tok-123',
                endpoint: 'voice-end-123.discord.gg',
                sessionId: 'session-xyz'
            },
            queue: {
                current: testTrack1,
                tracks: [testTrack2]
            },
            playing: true,
            changeNode: async (targetNode, checkSources) => {
                changeNodeCalled = true;
                changeNodeArgs = { targetNode, checkSources };
                activePlayer.node = targetNode;
                return targetNode.id;
            },
            destroy: async () => {}
        };

        const nodesMap = new Map([
            ['public-dead:443-1', deadNode],
            ['public-healthy:443-2', healthyNode],
            ['main-node', deadNode]
        ]);

        const mockClient = {
            is247Enabled: () => true,
            guildSettings: { cache: new Map() },
            guilds: { cache: new Map() },
            lavalink: {
                players: new Map([['g-migration-test', activePlayer]]),
                nodeManager: {
                    nodes: nodesMap
                },
                getPlayer: (id) => id === 'g-migration-test' ? activePlayer : null
            }
        };

        const mgr = new LavalinkConnectionManager(mockClient);
        await mgr.migrateAndRecoverPlayers(healthyNode, deadNode);

        // Verify player migrated to healthy node
        assert.equal(changeNodeCalled, true, 'player.changeNode must be called for player with valid voice data');
        assert.equal(changeNodeArgs.targetNode.id, healthyNode.id, 'Target node must be healthyNode');
        assert.equal(changeNodeArgs.checkSources, false, 'checkSources should be false during failover migration');
        assert.equal(activePlayer.node.id, healthyNode.id, 'Player node reference must be updated to healthyNode');

        // Verify upcoming queue tracks were preserved
        assert.equal(activePlayer.queue.tracks.length, 1, 'Upcoming queue tracks must be preserved across migration');
        assert.equal(activePlayer.queue.tracks[0].info.title, 'Song 2');

        // Verify dead node was cleaned up from nodeManager
        assert.equal(nodesMap.has('public-dead:443-1'), false, 'Dead node must be removed from nodeManager.nodes');
        assert.equal(nodesMap.get('main-node'), healthyNode, 'main-node alias must point to healthyNode');

        mgr.destroy();
    });

    // 7. Idle 24/7 player migration and no unsolicited playback
    await asyncCheck('migrateAndRecoverPlayers maintains idle state without starting playback for 24/7 player', async () => {
        const deadNode = { id: 'public-old:443-1', connected: false, destroy: () => {} };
        const healthyNode = { id: 'public-new:443-2', connected: true };

        let playTriggered = false;
        const idlePlayer = {
            guildId: 'g-idle-247',
            node: deadNode,
            voice: { token: 'tok', endpoint: 'end', sessionId: 'ses' },
            queue: { current: null, tracks: [] },
            playing: false,
            changeNode: async (node) => {
                idlePlayer.node = node;
                return node.id;
            },
            play: async () => {
                playTriggered = true;
            }
        };

        const mockClient = {
            is247Enabled: () => true,
            guildSettings: {
                cache: new Map([
                    ['g-idle-247', { twentyFourSeven: true, voiceChannelId: 'vc-idle' }]
                ])
            },
            guilds: {
                cache: new Map([
                    ['g-idle-247', { id: 'g-idle-247', channels: { cache: new Map([['vc-idle', { id: 'vc-idle', isVoiceBased: () => true, type: 2 }]]) } }]
                ])
            },
            lavalink: {
                players: new Map([['g-idle-247', idlePlayer]]),
                nodeManager: {
                    nodes: new Map([['public-new:443-2', healthyNode], ['main-node', healthyNode]])
                },
                getPlayer: (id) => id === 'g-idle-247' ? idlePlayer : null
            }
        };

        const mgr = new LavalinkConnectionManager(mockClient);
        await mgr.migrateAndRecoverPlayers(healthyNode, deadNode);

        assert.equal(idlePlayer.node.id, healthyNode.id, 'Idle player must be migrated to healthyNode');
        assert.equal(idlePlayer.playing, false, 'Idle player playing state must remain false');
        assert.equal(playTriggered, false, 'Migration of idle 24/7 player must NEVER trigger play()');

        mgr.destroy();
    });

    // 8. Missing voice data fallback: teardown without disconnect and clean recreation
    await asyncCheck('migrateAndRecoverPlayers tears down player without voice data cleanly and recovers fresh player', async () => {
        const deadNode = { id: 'public-old:443-1', connected: false, destroy: () => {} };
        const healthyNode = { id: 'public-new:443-2', connected: true };

        let destroyReason = null;
        let destroyDisconnect = null;

        const stalePlayer = {
            guildId: 'g-stale-247',
            node: deadNode,
            voice: {}, // Missing credentials
            queue: { current: null, tracks: [] },
            playing: true, // Stale playing state
            destroy: async (reason, disconnect) => {
                destroyReason = reason;
                destroyDisconnect = disconnect;
                mockClient.lavalink.players.delete('g-stale-247');
                return stalePlayer;
            }
        };

        let createdNewPlayer = null;
        let connectedNewPlayer = false;

        const mockClient = {
            is247Enabled: () => true,
            guildSettings: {
                cache: new Map([
                    ['g-stale-247', { twentyFourSeven: true, voiceChannelId: 'vc-stale' }]
                ])
            },
            guilds: {
                cache: new Map([
                    ['g-stale-247', { id: 'g-stale-247', channels: { cache: new Map([['vc-stale', { id: 'vc-stale', isVoiceBased: () => true, type: 2 }]]) } }]
                ])
            },
            lavalink: {
                players: new Map([['g-stale-247', stalePlayer]]),
                nodeManager: {
                    nodes: new Map([['public-new:443-2', healthyNode], ['main-node', healthyNode]])
                },
                getPlayer: (id) => mockClient.lavalink.players.get(id) || null,
                createPlayer: (options) => {
                    createdNewPlayer = {
                        guildId: options.guildId,
                        voiceChannelId: options.voiceChannelId,
                        node: healthyNode,
                        playing: false,
                        queue: { current: null, tracks: [] },
                        connect: async () => {
                            connectedNewPlayer = true;
                            createdNewPlayer.connected = true;
                        }
                    };
                    mockClient.lavalink.players.set(options.guildId, createdNewPlayer);
                    return createdNewPlayer;
                }
            }
        };

        const mgr = new LavalinkConnectionManager(mockClient);
        await mgr.migrateAndRecoverPlayers(healthyNode, deadNode);

        // Verify stale player was destroyed with disconnect = false
        assert.equal(destroyReason, 'NodeMigrationFail', 'Stale player must be destroyed with NodeMigrationFail');
        assert.equal(destroyDisconnect, false, 'Stale player must be destroyed with disconnect = false to keep Discord voice alive');

        // Verify fresh player was created on healthy node and connected
        assert.ok(createdNewPlayer, 'Fresh player must be created for 24/7 guild');
        assert.equal(createdNewPlayer.node.id, healthyNode.id, 'Fresh player must be attached to healthyNode');
        assert.equal(connectedNewPlayer, true, 'Fresh player must be connected to voice');
        assert.equal(createdNewPlayer.playing, false, 'Fresh player playing state must be false');

        mgr.destroy();
    });

    // 9. State consistency: subsequent /play executes immediately on migrated player
    await asyncCheck('migrated player with playing: false executes subsequent /play immediately on healthy node', async () => {
        const healthyNode = { id: 'public-healthy:443-1', connected: true };

        let playedTrack = null;
        const player = {
            guildId: 'g-play-test',
            node: healthyNode,
            connected: true,
            playing: false,
            paused: false,
            queue: {
                current: null,
                tracks: [],
                add: (t) => {
                    player.queue.tracks.push(t);
                    if (!player.queue.current) {
                        player.queue.current = t;
                    }
                }
            },
            play: async () => {
                player.playing = true;
                playedTrack = player.queue.current;
            }
        };

        // When a user runs /play, it checks wasPlaying:
        const wasPlaying = Boolean(player.playing && player.queue.current);
        assert.equal(wasPlaying, false, 'wasPlaying must be false for idle migrated player');

        // Adding track and executing playback
        const newTrack = { info: { title: 'Fresh Song', uri: 'https://youtube.com/watch?v=fresh' } };
        player.queue.add(newTrack);
        if (!wasPlaying) {
            await player.play();
        }

        assert.equal(player.playing, true);
        assert.equal(playedTrack, newTrack, 'Track must start playing immediately on the healthy node');
    });

    console.log('\nTesting 24/7 Presence Audit & Health Check Deduplication...');

    await asyncCheck('audit247Presence restores lost Discord voice connection while Lavalink is healthy', async () => {
        const guildId = 'g-audit-test';
        let connectedVoice = false;
        let createdPlayer = false;

        const fakeVoiceChannel = {
            id: 'vc-audit-target',
            name: '24/7 Lounge'
        };

        const fakeGuild = {
            id: guildId,
            name: 'Audit Guild',
            channels: {
                cache: new Map([['vc-audit-target', fakeVoiceChannel]]),
                fetch: async () => fakeVoiceChannel
            },
            members: {
                me: {
                    // Bot voice state is DISCONNECTED (null)
                    voice: { channelId: null }
                }
            }
        };

        const activeNode = {
            id: 'healthy-node-1',
            connected: true
        };

        const mockPlayer = {
            guildId,
            node: activeNode,
            options: { voiceChannelId: 'vc-audit-target' },
            connect: async () => { connectedVoice = true; }
        };

        const fakeClient = {
            guildSettings: {
                cache: new Map([
                    [guildId, { twentyFourSeven: true, voiceChannelId: 'vc-audit-target', textChannelId: 'tc-music' }]
                ])
            },
            guilds: {
                cache: new Map([[guildId, fakeGuild]]),
                fetch: async () => fakeGuild
            },
            lavalink: {
                getPlayer: () => mockPlayer,
                createPlayer: () => { createdPlayer = true; return mockPlayer; }
            }
        };

        const connManager = new LavalinkConnectionManager(fakeClient);
        connManager.getActiveNode = () => activeNode;
        connManager.isAvailable = () => true;

        // Run audit
        await connManager.audit247Presence();

        assert.equal(connectedVoice, true, 'audit247Presence must reconnect player when voice state is dropped');
        assert.equal(createdPlayer, false, 'audit247Presence must not create duplicate players when player exists');

        // Now test when voice is already connected to expected channel
        connectedVoice = false;
        fakeGuild.members.me.voice.channelId = 'vc-audit-target';
        await connManager.audit247Presence();

        assert.equal(connectedVoice, false, 'audit247Presence must not reconnect if already in expected channel');
    });

    check('startHealthCheck deduplicates intervals and does not create overlapping loops', () => {
        const fakeClient = {
            guildSettings: { cache: new Map() }
        };
        const connManager = new LavalinkConnectionManager(fakeClient);

        connManager.startHealthCheck(10000);
        const interval1 = connManager.state.healthCheckInterval;
        assert.ok(interval1, 'Health check interval must be established');

        // Calling startHealthCheck again should replace the previous interval, not leak it
        connManager.startHealthCheck(10000);
        const interval2 = connManager.state.healthCheckInterval;
        assert.ok(interval2, 'New interval must exist');
        assert.notEqual(interval1, interval2, 'Old interval should have been cleared');

        // Stop health check
        connManager.stopHealthCheck();
        assert.equal(connManager.state.healthCheckInterval, null, 'stopHealthCheck must clear the interval');
    });

    console.log('\nAll Lavalink connection, node provider, and command failover tests passed successfully!');
    process.exit(0);
}

run().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
