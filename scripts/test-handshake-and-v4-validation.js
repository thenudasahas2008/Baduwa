const assert = require('node:assert/strict');
const { LavalinkManager } = require('lavalink-client');
const { attachNodeProtection, validateAndFormatNodeOption, sanitizeError } = require('../src/utils/lavalinkNodeOptions');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
        process.exitCode = 1;
    }
}

async function run() {
    console.log('--- Lavalink Handshake & v4 Validation Regression Suite ---');

    // Setup dummy LavalinkManager to create real LavalinkNode instances from lavalink-client
    const manager = new LavalinkManager({
        nodes: [
            {
                host: '127.0.0.1',
                port: 2333,
                authorization: 'youshallnotpass',
                secure: false,
                id: 'test-node-1'
            }
        ],
        sendToShard: () => {},
        client: { id: '123456789012345678', username: 'ZYRO' }
    });

    const originalFetch = global.fetch;

    try {
        // Test 1: Stack trace reproduction & fix - node.request during fetchInfo() / open() handshake
        await test('1. fetchInfo() during open() handshake does not throw "The node is not connected" error', async () => {
            const node = manager.nodeManager.createNode({
                host: '127.0.0.1',
                port: 2333,
                authorization: 'youshallnotpass',
                secure: false,
                id: 'handshake-node-1'
            });

            attachNodeProtection(node);

            // Mock socket in OPEN state (as it is when ws 'open' event fires)
            node.socket = {
                readyState: 1, // OPEN
                on: () => {},
                once: () => {},
                close: () => {},
                listenerCount: () => 1
            };

            // Mock global.fetch returning valid v4 info
            global.fetch = async (url) => {
                if (url.includes('/v4/info')) {
                    return {
                        status: 200,
                        text: async () => JSON.stringify({
                            version: { major: 4, minor: 0, patch: 8, semver: '4.0.8' },
                            sourceManagers: ['youtube'],
                            plugins: []
                        })
                    };
                }
                throw new Error(`Unexpected url: ${url}`);
            };

            // Before our fix, calling node.fetchInfo() threw:
            // "The node is not connected to the Lavalink Server! Please call node.connect() first!"
            const info = await node.fetchInfo();
            assert.ok(info, 'fetchInfo must return parsed info');
            assert.equal(info.version.major, 4);
            assert.equal(info.version.semver, '4.0.8');
        });

        // Test 2: Successful Lavalink v4 handshake initializes internal state (info, isNodelink, connected)
        await test('2. Successful Lavalink v4 handshake initializes node.info and isNodelink without TypeError', async () => {
            const node = manager.nodeManager.createNode({
                host: '127.0.0.1',
                port: 2333,
                authorization: 'youshallnotpass',
                secure: false,
                id: 'handshake-node-2'
            });

            attachNodeProtection(node);

            node.socket = {
                readyState: 1, // OPEN
                on: () => {},
                once: () => {},
                close: () => {},
                listenerCount: () => 1
            };

            global.fetch = async (url) => {
                if (url.includes('/v4/info')) {
                    return {
                        status: 200,
                        text: async () => JSON.stringify({
                            version: { major: 4, minor: 0, patch: 8, semver: '4.0.8' },
                            isNodelink: false,
                            sourceManagers: ['youtube', 'soundcloud'],
                            plugins: []
                        })
                    };
                }
                throw new Error(`Unexpected url: ${url}`);
            };

            let connectEmitted = false;
            node.NodeManager.once('connect', (n) => {
                if (n.id === node.id) connectEmitted = true;
            });

            // Call open()
            await node.open();

            assert.ok(node.info, 'node.info must be populated');
            assert.equal(node.info.isNodelink, false, 'node.info.isNodelink must be boolean false');
            assert.equal(connectEmitted, true, 'NodeManager must emit "connect" event');
            assert.equal(node.connected, true, 'node.connected must be true');
        });

        // Test 3: Genuine incompatible node response is rejected cleanly
        await test('3. Genuine incompatible node response (v3/non-v4) is rejected cleanly with INCOMPATIBLE_API', async () => {
            const provider = new PublicNodeProvider();

            // Simulate v3 node response
            global.fetch = async (url) => {
                if (url.includes('/v4/info')) {
                    return {
                        status: 200,
                        text: async () => JSON.stringify({
                            version: { major: 3, minor: 7, patch: 0, semver: '3.7.0' }
                        })
                    };
                }
                throw new Error(`Unexpected url: ${url}`);
            };

            const result = await provider.checkNodeCompatibility({
                host: 'v3-node.test',
                port: 2333,
                password: 'pw'
            });

            assert.equal(result.compatible, false, 'v3 node must be rejected');
            assert.equal(result.category, 'INCOMPATIBLE_API', 'Category must be INCOMPATIBLE_API');
            assert.ok(result.reason.includes('expected v4'), 'Reason must indicate expected v4');

            provider.destroy();
        });

        // Test 4: Plain-text or HTML response does not cause an unhandled JSON parsing rejection
        await test('4. Plain-text or HTML response on node.request is caught cleanly without SyntaxError crash', async () => {
            const node = manager.nodeManager.createNode({
                host: '127.0.0.1',
                port: 2333,
                authorization: 'youshallnotpass',
                secure: false,
                id: 'html-node-4'
            });

            attachNodeProtection(node);

            node.socket = {
                readyState: 1,
                on: () => {},
                once: () => {},
                close: () => {},
                listenerCount: () => 1
            };

            global.fetch = async () => ({
                status: 502,
                text: async () => '<html><body>502 Bad Gateway - Cloudflare</body></html>'
            });

            let caughtError = null;
            try {
                await node.request('/info');
            } catch (err) {
                caughtError = err;
            }

            assert.ok(caughtError, 'Request must throw a typed error');
            assert.ok(caughtError.message.includes('returned non-JSON response'), 'Error must specify non-JSON response');
            assert.ok(!caughtError.message.includes('SyntaxError'), 'Must not leak raw SyntaxError');
        });

        // Test 5: Failed handshake cleans up socket safely
        await test('5. Failed handshake closes socket with 4000 and emits error on NodeManager without unhandled rejection', async () => {
            const node = manager.nodeManager.createNode({
                host: '127.0.0.1',
                port: 2333,
                authorization: 'youshallnotpass',
                secure: false,
                id: 'failed-handshake-node-5'
            });

            attachNodeProtection(node);

            let closedCode = null;
            let closedReason = null;
            node.socket = {
                readyState: 1,
                on: () => {},
                once: () => {},
                close: (code, reason) => {
                    closedCode = code;
                    closedReason = reason;
                },
                listenerCount: () => 1
            };

            // Server returns 404
            global.fetch = async () => ({
                status: 404,
                text: async () => 'Not Found'
            });

            let errorEmitted = null;
            node.NodeManager.once('error', (n, err) => {
                if (n.id === node.id) errorEmitted = err;
            });

            // open() handles error locally without throwing unhandled rejection
            await node.open();

            assert.equal(closedCode, 4000, 'Socket must be closed with code 4000');
            assert.equal(closedReason, 'HandshakeValidationFailed', 'Close reason must be HandshakeValidationFailed');
            assert.ok(errorEmitted, 'Error event must be emitted on NodeManager');
            assert.ok(errorEmitted.message.includes('INCOMPATIBLE_API') || errorEmitted.message.includes('HANDSHAKE_ERROR'));
        });

        // Test 6: Local wrapper error does not place public node on 30m incompatibility cooldown
        await test('6. Local wrapper error (TypeError / WRAPPER_ERROR) does not trigger 30-minute INCOMPATIBLE_API cooldown', async () => {
            const provider = new PublicNodeProvider();

            const testHost = 'wrapper-error.test';
            const testPort = 443;

            // Mark node failed with WRAPPER_ERROR
            provider.markNodeFailed(testHost, testPort, 'TypeError: Cannot read properties of null (reading "isNodelink")', 'WRAPPER_ERROR');

            const key = `${testHost}:${testPort}`;
            const record = provider.failedNodes.get(key);
            assert.ok(record, 'Failure record must exist');
            assert.equal(record.category, 'WRAPPER_ERROR');

            // Standard base cooldown is 3 minutes (180,000ms), NOT 30 minutes (1,800,000ms)
            const remainingCooldownMs = record.cooldownUntil - Date.now();
            assert.ok(remainingCooldownMs <= 3.5 * 60 * 1000, 'WRAPPER_ERROR must have normal backoff <= 3.5m, not 30m cooldown');
            assert.ok(remainingCooldownMs > 2.5 * 60 * 1000);

            provider.destroy();
        });

        // Test 7: Dedicated Lavalink configuration remains functional
        await test('7. Dedicated Lavalink configuration is validated and formatted correctly', () => {
            const dedicated = validateAndFormatNodeOption({
                host: 'lavalink.internal.lan',
                port: 2333,
                authorization: 'my-dedicated-password',
                secure: false,
                id: 'main-node'
            });

            assert.ok(dedicated, 'Dedicated node configuration must be valid');
            assert.equal(dedicated.host, 'lavalink.internal.lan');
            assert.equal(dedicated.port, 2333);
            assert.equal(dedicated.authorization, 'my-dedicated-password');
            assert.equal(dedicated.secure, false);
            assert.equal(dedicated.id, 'main-node');
            assert.equal(dedicated.retryAmount, 3);
        });

        // Test 8: Failover selects next eligible candidate without duplicate loops
        await test('8. Failover uses next eligible candidate and does not get stuck on cooling candidate', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [
                { host: 'failed-candidate.test', port: 443, password: 'pw1', secure: true, version: 'v4' },
                { host: 'healthy-candidate.test', port: 443, password: 'pw2', secure: true, version: 'v4' }
            ];

            // Mark first candidate failed
            provider.markNodeFailed('failed-candidate.test', 443, 'Connection timeout', 'TIMEOUT');

            global.fetch = async (url) => {
                if (url.includes('healthy-candidate.test')) {
                    return {
                        status: 200,
                        text: async () => JSON.stringify({
                            version: { major: 4, semver: '4.0.8' }
                        })
                    };
                }
                throw new Error(`Unexpected url: ${url}`);
            };

            const selected = await provider.getNextValidatedNode({ maxCandidates: 2 });
            assert.ok(selected, 'Healthy candidate must be selected');
            assert.equal(selected.host, 'healthy-candidate.test', 'Must select healthy-candidate');
            assert.equal(selected.port, 443);

            provider.destroy();
        });

        // Test 9: Git commit hash in /v4/info response is NOT confused with version
        await test('9. git.commit hash starting with digits is not misinterpreted as Lavalink major version', async () => {
            const provider = new PublicNodeProvider();

            // Node response with NO info.version, but git.commit = "4f8a29b"
            global.fetch = async () => ({
                status: 200,
                text: async () => JSON.stringify({
                    git: {
                        branch: 'master',
                        commit: '4f8a29b'
                    },
                    buildTime: 1700000000
                })
            });

            const result = await provider.checkNodeCompatibility({
                host: 'git-commit-only.test',
                port: 443,
                password: 'pw'
            });

            assert.equal(result.compatible, false, 'Must NOT treat git.commit as Lavalink version');
            assert.equal(result.category, 'INCOMPATIBLE_API');
            assert.ok(result.reason.includes('Missing version object'));

            provider.destroy();
        });

        // Test 10: Disconnected requests after initialization are safely blocked
        await test('10. Disconnected search or player requests after initialization throw safety error', async () => {
            const node = manager.nodeManager.createNode({
                host: '127.0.0.1',
                port: 2333,
                authorization: 'youshallnotpass',
                secure: false,
                id: 'safety-node-10'
            });

            attachNodeProtection(node);

            // Node is NOT connected and has no socket
            node.socket = null;
            node.info = { isNodelink: false }; // info exists, meaning post-handshake

            let caughtError = null;
            try {
                await node.request('/loadtracks?identifier=test');
            } catch (err) {
                caughtError = err;
            }

            assert.ok(caughtError, 'Must throw error when disconnected');
            assert.ok(caughtError.message.includes('The node is not connected to the Lavalink Server'));
        });

        // Test 11: v4 info object containing Git commit hash alongside valid semver
        await test('11. v4 info containing Git commit hash uses semantic version and never git.commit', async () => {
            const provider = new PublicNodeProvider();

            global.fetch = async () => ({
                status: 200,
                text: async () => JSON.stringify({
                    version: {
                        major: 4,
                        minor: 0,
                        patch: 8,
                        semver: '4.0.8'
                    },
                    git: {
                        branch: 'master',
                        commit: '47c0c5fddc6d23f6a9503437c59d74e57a626630',
                        commitTime: 1718000000000
                    },
                    sourceManagers: ['youtube', 'soundcloud'],
                    plugins: []
                })
            });

            const result = await provider.checkNodeCompatibility({
                host: 'official-v4.test',
                port: 443,
                password: 'pw'
            });

            assert.equal(result.compatible, true, 'Official v4 node must be compatible');
            assert.equal(result.category, 'COMPATIBLE_V4');
            assert.equal(result.version, '4.0.8', 'Version must be semver 4.0.8, not git commit hash');

            provider.destroy();
        });

        // Test 12: Lavalink git build with commit hash in version is accepted as v4 and NOT placed on 30m cooldown
        await test('12. Lavalink git build with commit hash in version is accepted as v4 without 30m cooldown', async () => {
            const provider = new PublicNodeProvider();

            global.fetch = async () => ({
                status: 200,
                text: async () => JSON.stringify({
                    version: {
                        semver: '47c0c5fddc6d23f6a9503437c59d74e57a626630'
                    },
                    sourceManagers: ['youtube'],
                    plugins: []
                })
            });

            const result = await provider.checkNodeCompatibility({
                host: 'git-build.test',
                port: 443,
                password: 'pw'
            });

            assert.equal(result.compatible, true, 'Git build responding with v4 structure must be compatible');
            assert.equal(result.category, 'COMPATIBLE_V4');
            assert.ok(result.version.startsWith('v4-git-47c0c5f'), 'Version reflects git build without parsing hash as major 47');

            provider.destroy();
        });

        // Test 13: Genuinely incompatible server (Lavalink v3) is rejected with INCOMPATIBLE_API
        await test('13. Genuinely incompatible server (Lavalink v3) is rejected with INCOMPATIBLE_API', async () => {
            const provider = new PublicNodeProvider();

            global.fetch = async () => ({
                status: 200,
                text: async () => JSON.stringify({
                    version: {
                        major: 3,
                        minor: 7,
                        patch: 12,
                        semver: '3.7.12'
                    }
                })
            });

            const result = await provider.checkNodeCompatibility({
                host: 'v3-incompatible.test',
                port: 443,
                password: 'pw'
            });

            assert.equal(result.compatible, false, 'v3 node must be rejected');
            assert.equal(result.category, 'INCOMPATIBLE_API');
            assert.ok(result.reason.includes('3.7.12'));

            provider.destroy();
        });

        // Test 14: HTTP 401, 429, 502, and timeout classification
        await test('14. HTTP 401, 429, 502, and timeouts are distinguished from API incompatibility', async () => {
            const provider = new PublicNodeProvider();

            // 401 Unauthorized
            global.fetch = async () => ({ status: 401, text: async () => 'Unauthorized' });
            const authResult = await provider.checkNodeCompatibility({ host: 'auth-fail.test', port: 443, password: 'pw' });
            assert.equal(authResult.category, 'AUTH_FAILED');
            assert.equal(authResult.status, 401);

            // 429 Rate Limited
            global.fetch = async () => ({ status: 429, text: async () => 'Too Many Requests' });
            const rateResult = await provider.checkNodeCompatibility({ host: 'rate-limit.test', port: 443, password: 'pw' });
            assert.equal(rateResult.category, 'RATE_LIMITED');
            assert.equal(rateResult.temporary, true);

            // 502 Bad Gateway
            global.fetch = async () => ({ status: 502, text: async () => 'Bad Gateway' });
            const serverResult = await provider.checkNodeCompatibility({ host: 'bad-gateway.test', port: 443, password: 'pw' });
            assert.equal(serverResult.category, 'TRANSIENT_ERROR');
            assert.equal(serverResult.status, 502);
            assert.equal(serverResult.temporary, true);

            // Timeout
            global.fetch = async () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                throw err;
            };
            const timeoutResult = await provider.checkNodeCompatibility({ host: 'timeout.test', port: 443, password: 'pw' });
            assert.equal(timeoutResult.category, 'TIMEOUT');
            assert.equal(timeoutResult.temporary, true);

            provider.destroy();
        });

    } finally {
        global.fetch = originalFetch;
        manager.nodeManager.nodes.clear();
    }

    console.log(`\nAll regression tests passed: ${passed}/14`);
    if (passed !== 14) {
        process.exit(1);
    }
    process.exit(0);
}

run().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});
