const assert = require('node:assert/strict');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const { attachNodeProtection } = require('../src/utils/lavalinkNodeOptions');

let passed = 0;
function check(name, fn) {
    try {
        const res = fn();
        if (res && typeof res.then === 'function') {
            return res.then(() => {
                passed++;
                console.log(`  ok  - ${name}`);
            }).catch((err) => {
                console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
                process.exitCode = 1;
            });
        }
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.stack || err.message}`);
        process.exitCode = 1;
    }
}

async function runTests() {
    console.log('--- Lavalink Node Compatibility & Audio Recovery Regression Tests ---');

    const originalFetch = global.fetch;

    try {
        // Test 1: A compatible Lavalink v4 node returns valid /v4/info JSON and is eligible
        await check('1. A compatible Lavalink v4 node returns valid /v4/info JSON and is eligible', async () => {
            const provider = new PublicNodeProvider();

            global.fetch = async (url) => {
                if (url.includes('/v4/info')) {
                    return {
                        ok: true,
                        status: 200,
                        statusText: 'OK',
                        headers: new Map([['content-type', 'application/json']]),
                        text: async () => JSON.stringify({
                            version: {
                                semver: '4.0.8',
                                major: 4,
                                minor: 0,
                                patch: 8
                            },
                            buildTime: 1700000000,
                            sourceManagers: ['youtube', 'soundcloud', 'spotify']
                        })
                    };
                }
                throw new Error(`Unexpected URL: ${url}`);
            };

            const candidate = {
                host: 'compatible-node.lava.test',
                port: 443,
                password: 'secret-password',
                secure: true
            };

            const result = await provider.checkNodeCompatibility(candidate);
            assert.equal(result.compatible, true, 'Compatible v4 node must be marked compatible');
            assert.equal(result.category, 'COMPATIBLE_V4');
            assert.equal(result.status, 200);
            assert.equal(result.version, '4.0.8');

            provider.destroy();
        });

        // Test 2: A plain-text "does not provide any /v4/info" response is handled without JSON.parse crashing
        await check('2. Plain-text "does not provide any /v4/info" is handled cleanly without JSON.parse SyntaxError', async () => {
            const provider = new PublicNodeProvider();

            // Simulate the exact Jirayu production plain-text failure
            global.fetch = async (url) => {
                if (url.includes('/v4/info')) {
                    return {
                        ok: true,
                        status: 200,
                        statusText: 'OK',
                        headers: new Map([['content-type', 'text/plain']]),
                        text: async () => 'Lavalink Node (http://lavalink.jirayu.net:13592) does not provide any /v4/info'
                    };
                }
                throw new Error(`Unexpected URL: ${url}`);
            };

            const candidate = {
                host: 'lavalink.jirayu.net',
                port: 13592,
                password: 'youshallnotpass',
                secure: false
            };

            // checkNodeCompatibility must safely return typed failure, NEVER throw SyntaxError
            const result = await provider.checkNodeCompatibility(candidate);
            assert.equal(result.compatible, false, 'Plain-text response must not be marked compatible');
            assert.equal(result.category, 'INCOMPATIBLE_API', 'Category must be INCOMPATIBLE_API');
            assert.equal(result.status, 200);
            assert.ok(result.reason.includes('Non-JSON'), 'Reason must indicate non-JSON body');

            provider.destroy();
        });

        // Test 3: An incompatible candidate is rejected and placed on cooldown
        await check('3. An incompatible candidate is rejected and placed on long cooldown', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [
                { host: 'incompatible.lava.test', port: 8080, password: 'pw', secure: false, version: 'v4' }
            ];

            // Simulate 404 Not Found on /v4/info
            global.fetch = async (url) => {
                if (url.includes('/v4/info')) {
                    return {
                        ok: false,
                        status: 404,
                        statusText: 'Not Found',
                        headers: new Map(),
                        text: async () => 'Not Found'
                    };
                }
                throw new Error(`Unexpected URL: ${url}`);
            };

            const validated = await provider.getNextValidatedNode({ maxCandidates: 1, probeTimeoutMs: 1000 });
            assert.equal(validated, null, 'Incompatible candidate must not be returned');

            // Verify node entered cooldown
            assert.equal(provider.isNodeInCooldown('incompatible.lava.test', 8080), true, 'Node must be placed in cooldown');
            const record = provider.failedNodes.get('incompatible.lava.test:8080');
            assert.ok(record, 'Failure record must exist');
            assert.equal(record.category, 'INCOMPATIBLE_API');
            // 30 minute cooldown for INCOMPATIBLE_API
            assert.ok(record.cooldownUntil > Date.now() + 25 * 60 * 1000, 'Must have 30 minute cooldown for incompatible API');

            provider.destroy();
        });

        // Test 4: Temporary HTTP errors and rate limits are distinguished from incompatible API
        await check('4. Temporary rate limits and server errors are distinguished from incompatible API', async () => {
            const provider = new PublicNodeProvider();

            // 1. Rate-limited node (HTTP 429)
            global.fetch = async () => ({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: new Map(),
                text: async () => 'Rate limited'
            });

            const rateResult = await provider.checkNodeCompatibility({ host: 'ratelimited.test', port: 443, password: 'pw', secure: true });
            assert.equal(rateResult.compatible, false);
            assert.equal(rateResult.category, 'RATE_LIMITED');
            assert.equal(rateResult.temporary, true, 'Rate limit must be marked temporary');

            provider.markNodeFailed('ratelimited.test', 443, rateResult.reason, rateResult.category);
            const rateRecord = provider.failedNodes.get('ratelimited.test:443');
            // 1 minute cooldown for rate limit
            assert.ok(rateRecord.cooldownUntil <= Date.now() + 65 * 1000, 'Rate limited node should have short 60s cooldown');

            // 2. Server 502 Bad Gateway
            global.fetch = async () => ({
                ok: false,
                status: 502,
                statusText: 'Bad Gateway',
                headers: new Map(),
                text: async () => 'Gateway error'
            });

            const srvResult = await provider.checkNodeCompatibility({ host: 'servererror.test', port: 443, password: 'pw', secure: true });
            assert.equal(srvResult.compatible, false);
            assert.equal(srvResult.category, 'TRANSIENT_ERROR');
            assert.equal(srvResult.temporary, true, 'Server error must be marked temporary');

            // 3. Auth failure (HTTP 401)
            global.fetch = async () => ({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Map(),
                text: async () => 'Unauthorized'
            });

            const authResult = await provider.checkNodeCompatibility({ host: 'badauth.test', port: 443, password: 'pw', secure: true });
            assert.equal(authResult.compatible, false);
            assert.equal(authResult.category, 'AUTH_FAILED');

            provider.destroy();
        });

        // Test 5: One invalid public node does not prevent healthy candidates from being tried
        await check('5. One invalid public node does not prevent healthy candidates from being tried', async () => {
            const provider = new PublicNodeProvider();
            provider.nodes = [
                { host: 'bad-node.test', port: 13592, password: 'pw1', secure: false, version: 'v4' },
                { host: 'good-node.test', port: 443, password: 'pw2', secure: true, version: 'v4' }
            ];

            global.fetch = async (url) => {
                if (url.includes('bad-node.test')) {
                    // Plain-text non-JSON error
                    return {
                        ok: true,
                        status: 200,
                        headers: new Map([['content-type', 'text/plain']]),
                        text: async () => 'Lavalink Node (http://bad-node.test:13592) does not provide any /v4/info'
                    };
                }
                if (url.includes('good-node.test')) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Map([['content-type', 'application/json']]),
                        text: async () => JSON.stringify({
                            version: { major: 4, semver: '4.0.0' }
                        })
                    };
                }
                throw new Error(`Unexpected URL: ${url}`);
            };

            const selected = await provider.getNextValidatedNode({ maxCandidates: 2 });
            assert.ok(selected, 'A healthy candidate must be returned');
            assert.equal(selected.host, 'good-node.test', 'Must skip bad-node and select good-node');
            assert.equal(selected.port, 443);
            assert.equal(selected.secure, true);

            // Bad node must be on cooldown
            assert.equal(provider.isNodeInCooldown('bad-node.test', 13592), true);
            // Good node must NOT be on cooldown
            assert.equal(provider.isNodeInCooldown('good-node.test', 443), false);

            provider.destroy();
        });

        // Test 6: In-flight node protection prevents unhandled promise rejections and SyntaxError crashes
        await check('6. In-flight node protection intercepts open rejections without unhandled rejection crashes', async () => {
            let errorEmitted = null;
            const fakeNode = {
                host: 'lavalink.jirayu.net',
                port: 13592,
                restAddress: 'http://lavalink.jirayu.net:13592',
                options: { host: 'lavalink.jirayu.net', port: 13592, authorization: 'pw' },
                connected: true,
                NodeManager: {
                    emit: (evt, node, err) => {
                        if (evt === 'error') errorEmitted = err;
                    }
                },
                rawRequest: async () => ({
                    response: {
                        status: 200,
                        text: async () => 'Lavalink Node (http://lavalink.jirayu.net:13592) does not provide any /v4/info'
                    },
                    options: { method: 'GET', path: '/info' }
                }),
                request: async function () {
                    // Overridden by attachNodeProtection
                },
                open: async function () {
                    // Simulates lavalink-client open() throwing when fetchInfo returns non-JSON or null
                    await this.request('/info');
                    throw new Error(`Lavalink Node (${this.restAddress}) does not provide any /v4/info`);
                }
            };

            attachNodeProtection(fakeNode);

            // When node.open() is invoked (as it is from ws.on('open')), it must NOT throw an unhandled rejection
            let unhandledCaught = false;
            const unhandledListener = () => { unhandledCaught = true; };
            process.on('unhandledRejection', unhandledListener);

            try {
                await fakeNode.open();
            } finally {
                process.off('unhandledRejection', unhandledListener);
            }

            assert.equal(unhandledCaught, false, 'Must not emit unhandledRejection');
            assert.ok(errorEmitted, 'Error must be emitted cleanly via NodeManager.emit');
            assert.ok(errorEmitted.message.includes('INCOMPATIBLE_API'), 'Error must be classified as INCOMPATIBLE_API');
        });

        // Test 7: WebSocket connection success does not falsely report playback recovery until position advances
        await check('7. WebSocket connection success does not falsely report playback recovery until position advances', async () => {
            let recoveredEvents = [];
            const mockTrack = {
                info: { identifier: 'track-recovery-1', title: 'Stalled Song', duration: 200000 }
            };

            const mockPlayer = {
                guildId: 'g-rec-test',
                position: 5000,
                playing: true,
                paused: false,
                node: { id: 'node-migrated', host: 'migrated.lava.test', port: 443, connected: true },
                queue: { current: mockTrack, tracks: [] },
                changeNode: async () => true,
                play: async () => {}
            };

            const mockClient = {
                lavalinkMode: 'public',
                lavalink: { getPlayer: () => mockPlayer },
                lavalinkConnectionManager: {
                    migratePlayerToHealthyNode: async () => true // Node connection succeeded
                }
            };

            const monitor = new AudioPlaybackMonitor(mockClient);
            monitor.logDiagnostic = (event, data) => {
                if (event === 'RECOVERY_SUCCEEDED' || event === 'RECOVERY_PENDING') {
                    recoveredEvents.push({ event, data });
                }
            };

            monitor.onTrackStart(mockPlayer, mockTrack);

            // Trigger recovery (e.g. stalled position)
            await monitor.recoverPlayback(mockPlayer, mockTrack, { reason: 'stalledPosition' });

            // CRITICAL: Immediately after recovery initiation, RECOVERY_SUCCEEDED must NOT be logged!
            const succeededImmediately = recoveredEvents.filter(e => e.event === 'RECOVERY_SUCCEEDED');
            assert.equal(succeededImmediately.length, 0, 'RECOVERY_SUCCEEDED must NOT be logged before position progresses');

            const pendingEvent = recoveredEvents.find(e => e.event === 'RECOVERY_PENDING');
            assert.ok(pendingEvent, 'RECOVERY_PENDING must be logged while waiting for playback verification');

            // Case A: Position does not advance (stalled at 5000ms)
            monitor.onPlayerUpdate(mockPlayer, { ...mockPlayer, position: 5000 });
            assert.equal(recoveredEvents.filter(e => e.event === 'RECOVERY_SUCCEEDED').length, 0, 'Still must not log RECOVERY_SUCCEEDED when position is frozen');

            // Case B: Position advances forward (e.g. to 5500ms)
            monitor.onPlayerUpdate(mockPlayer, { ...mockPlayer, position: 5500 });
            const succeededAfterProgress = recoveredEvents.filter(e => e.event === 'RECOVERY_SUCCEEDED');
            assert.equal(succeededAfterProgress.length, 1, 'RECOVERY_SUCCEEDED must be logged ONLY after position actually advances');
            assert.equal(succeededAfterProgress[0].data.position, 5500);

            monitor.destroy();
        });

        // Test 8: Frozen position past verification deadline triggers RECOVERY_FAILED and bounded retry
        await check('8. Frozen position past verification deadline triggers RECOVERY_FAILED and bounded retry', async () => {
            let failedEvents = [];
            const mockTrack = {
                info: { identifier: 'track-frozen-1', title: 'Permanently Broken Song', duration: 200000 }
            };

            const mockPlayer = {
                guildId: 'g-frozen-test',
                position: 2000,
                playing: true,
                paused: false,
                node: { id: 'node-1', host: 'node.test', port: 443, connected: true },
                queue: { current: mockTrack, tracks: [] },
                play: async () => {},
                skip: async () => {},
                stopPlaying: async () => {}
            };

            const mockClient = {
                lavalinkMode: 'local',
                lavalink: { getPlayer: () => mockPlayer },
            };

            const monitor = new AudioPlaybackMonitor(mockClient);
            monitor.logDiagnostic = (event, data) => {
                if (event === 'RECOVERY_FAILED' || event === 'RECOVERY_EXHAUSTED') {
                    failedEvents.push({ event, data });
                }
            };

            monitor.onTrackStart(mockPlayer, mockTrack);
            await monitor.recoverPlayback(mockPlayer, mockTrack, { reason: 'stalledPosition' });

            const state = monitor.getOrCreateState('g-frozen-test');
            assert.ok(state.recoveryPending, 'Recovery must be pending verification');

            // Fast-forward past verification deadline (15 seconds)
            state.recoveryPending.initiatedAt = Date.now() - 20000;
            state.trackStartTime = Date.now() - 30000;

            await monitor.checkPlayersForStalls();

            const failed = failedEvents.find(e => e.event === 'RECOVERY_FAILED');
            assert.ok(failed, 'RECOVERY_FAILED must be logged when position failed to advance within verification window');

            monitor.destroy();
        });

    } finally {
        global.fetch = originalFetch;
    }

    console.log(`\n========================================`);
    console.log(`Lavalink Node Compatibility & Audio Recovery Tests: ${passed}/8 passed`);
    console.log(`========================================\n`);

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

runTests().catch((err) => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
});
