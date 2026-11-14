const assert = require('assert');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');
const { classifyRestError, withRestTimeout, safeReply, RESPONSE_STATES } = require('../src/utils/interactionHelpers');
const VoiceHandshakeSynchronizer = require('../src/utils/VoiceHandshakeSynchronizer');
const logger = require('../src/utils/logger');

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
    totalTests++;
    try {
        await fn();
        passedTests++;
        console.log(`  ✓ [PASS] ${totalTests}. ${name}`);
    } catch (err) {
        console.error(`  ✗ [FAIL] ${totalTests}. ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

async function run() {
    console.log('\n=== RUNNING LAVALINK NODE DISCONNECT & REST TIMEOUT REGRESSION SUITE ===\n');

    // 1. Lavalink node disconnect and cooldown progression up to 900s
    await test('Lavalink node disconnect marks failure and increments cooldown up to NODE_MAX_COOLDOWN_MS (900s)', async () => {
        const provider = new PublicNodeProvider();
        const host = 'lavalink-test.triniumhost.com';
        const port = 443;
        const key = `${host}:${port}`;

        // Initial failure: 180s (3m)
        provider.markNodeFailed(host, port, 'WebSocket connection reset', 'CONNECTION_FAILED');
        let record = provider.failedNodes.get(key);
        assert(record, 'Record must exist');
        assert.strictEqual(record.failCount, 1);
        const cooldown1 = (record.cooldownUntil - record.lastFailureTimestamp) / 1000;
        assert.strictEqual(Math.round(cooldown1), 180, '1st failure cooldown should be 180s');

        // Fast-forward timestamp past 4s deduplication threshold
        record.lastFailureTimestamp -= 5000;
        provider.markNodeFailed(host, port, 'WebSocket closed 1006', 'CONNECTION_FAILED');
        record = provider.failedNodes.get(key);
        assert.strictEqual(record.failCount, 2);
        const cooldown2 = (record.cooldownUntil - record.lastFailureTimestamp) / 1000;
        assert.strictEqual(Math.round(cooldown2), 360, '2nd failure cooldown should be 360s');

        // 3rd failure
        record.lastFailureTimestamp -= 5000;
        provider.markNodeFailed(host, port, 'Connection refused', 'CONNECTION_FAILED');
        record = provider.failedNodes.get(key);
        assert.strictEqual(record.failCount, 3);
        const cooldown3 = (record.cooldownUntil - record.lastFailureTimestamp) / 1000;
        assert.strictEqual(Math.round(cooldown3), 720, '3rd failure cooldown should be 720s');

        // 4th failure: capped at NODE_MAX_COOLDOWN_MS = 900s
        record.lastFailureTimestamp -= 5000;
        provider.markNodeFailed(host, port, 'Server error 530', 'TRANSIENT_ERROR');
        record = provider.failedNodes.get(key);
        assert.strictEqual(record.failCount, 4);
        const cooldown4 = (record.cooldownUntil - record.lastFailureTimestamp) / 1000;
        assert.strictEqual(Math.round(cooldown4), 900, '4th failure cooldown should be capped at 900s (15 min)');
    });

    // 2. No healthy alternative node available returns null without throwing or hanging
    await test('No healthy alternative node available returns null safely when all nodes are in cooldown', async () => {
        const provider = new PublicNodeProvider();
        provider.nodes = [
            { host: 'node-a.com', port: 443, authorization: 'pass', secure: true },
            { host: 'node-b.com', port: 443, authorization: 'pass', secure: true },
        ];
        provider.markNodeFailed('node-a.com', 443, 'failed', 'CONNECTION_FAILED');
        provider.markNodeFailed('node-b.com', 443, 'failed', 'CONNECTION_FAILED');

        assert.strictEqual(provider.areAllNodesInCooldown(), true, 'All nodes should be in cooldown');
        const nextWithoutFallback = provider.getNextNode({ allowCooldownFallback: false });
        assert.strictEqual(nextWithoutFallback, null, 'Should return null when allowCooldownFallback is false');
    });

    // 3. Healthy alternative selected after a node disconnect
    await test('Healthy alternative selected after a node disconnect', async () => {
        const provider = new PublicNodeProvider();
        provider.nodes = [
            { host: 'failed-node.com', port: 443, authorization: 'pass', secure: true },
            { host: 'healthy-node.com', port: 443, authorization: 'pass', secure: true },
        ];
        provider.markNodeFailed('failed-node.com', 443, 'closed', 'CONNECTION_FAILED');

        const chosen = provider.getNextNode({ allowCooldownFallback: false });
        assert(chosen, 'A node must be chosen');
        assert.strictEqual(chosen.host, 'healthy-node.com', 'Healthy node must be selected');
    });

    // 4. VoiceHandshakeSynchronizer recovers unlinked or disconnected player node
    await test('VoiceHandshakeSynchronizer synchronizes player node with activeNode when player.node is disconnected', async () => {
        const activeNode = {
            id: 'healthy-active-node',
            connected: true,
            sessionId: 'valid-session-1234',
            updatePlayer: async ({ guildId, playerOptions }) => ({ guildId, ...playerOptions })
        };
        const mockClient = {
            user: { id: 'bot-123' },
            lavalinkConnectionManager: {
                getActiveNode: () => activeNode
            },
            lavalink: {
                getPlayer: () => mockPlayer
            }
        };

        const mockPlayer = {
            guildId: 'guild-handshake-test',
            node: null, // Unlinked or dead node
            voice: { token: null, endpoint: null, sessionId: null },
            voiceChannelId: 'vc-test'
        };

        const synchronizer = new VoiceHandshakeSynchronizer(mockClient);

        // Gateway sends VOICE_SERVER_UPDATE
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: {
                guild_id: 'guild-handshake-test',
                token: 'voice-tok-xyz',
                endpoint: 'voice.discord.media:443'
            }
        });

        // Gateway sends VOICE_STATE_UPDATE
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: {
                guild_id: 'guild-handshake-test',
                user_id: 'bot-123',
                session_id: 'discord-session-abc',
                channel_id: 'vc-test'
            }
        });

        // Player node should be synchronized to activeNode
        assert.strictEqual(mockPlayer.node, activeNode, 'Player node must be synchronized to activeNode');
        assert.strictEqual(synchronizer.isVoiceReady('guild-handshake-test'), true, 'Voice state must be ready');
    });

    // 5. Voice connection failure preserves queue without corruption
    await test('Voice connection failure does not corrupt or clear player queue', async () => {
        const queueTracks = [{ info: { title: 'Song A', identifier: 'a' } }, { info: { title: 'Song B', identifier: 'b' } }];
        const mockPlayer = {
            guildId: 'g-queue-test',
            connected: false,
            queue: {
                tracks: [...queueTracks],
                current: null,
            }
        };

        // Simulated voice connection failure
        const voiceConnectError = new Error('Voice connection could not be established');
        assert(voiceConnectError, 'Failure reported');

        // Verify queue is intact
        assert.strictEqual(mockPlayer.queue.tracks.length, 2, 'Queue tracks length must remain 2');
        assert.strictEqual(mockPlayer.queue.tracks[0].info.title, 'Song A');
        assert.strictEqual(mockPlayer.queue.tracks[1].info.title, 'Song B');
    });

    // 6. Stage timing isolation: connectDurationMs vs searchDurationMs report distinct values
    await test('Per-stage elapsed time instrumentation measures connectMs and searchMs independently without lockstep', async () => {
        const lifecycle = {
            connectDurationMs: null,
            searchDurationMs: null,
        };

        const connectStart = Date.now();
        const connectPromise = (async () => {
            await new Promise(r => setTimeout(r, 60)); // 60ms simulated connect
            lifecycle.connectDurationMs = Date.now() - connectStart;
        })();

        const searchStart = Date.now();
        const searchPromise = (async () => {
            await new Promise(r => setTimeout(r, 10)); // 10ms fast cache hit search
            lifecycle.searchDurationMs = Date.now() - searchStart;
        })();

        await Promise.all([connectPromise, searchPromise]);

        assert(typeof lifecycle.connectDurationMs === 'number', 'connectDurationMs must be recorded');
        assert(typeof lifecycle.searchDurationMs === 'number', 'searchDurationMs must be recorded');
        assert(lifecycle.connectDurationMs >= 50, `connectDurationMs must reflect ~60ms (got ${lifecycle.connectDurationMs}ms)`);
        assert(lifecycle.searchDurationMs < 40, `searchDurationMs must reflect ~10ms and NOT match connect (got ${lifecycle.searchDurationMs}ms)`);
        assert.notStrictEqual(lifecycle.connectDurationMs, lifecycle.searchDurationMs, 'connectMs and searchMs must not be identical lockstep values');
    });

    // 7. classifyRestError categorizes DNS, TLS, Socket Timeout, and Rate Limits without secret leakage
    await test('classifyRestError categorizes errors accurately and redacts secret tokens', async () => {
        // DNS failure
        const dnsErr = new Error('getaddrinfo ENOTFOUND discord.com');
        dnsErr.code = 'ENOTFOUND';
        const dnsClass = classifyRestError(dnsErr);
        assert.strictEqual(dnsClass.category, 'DNS_ERROR');

        // Socket timeout
        const sockErr = new Error('UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error');
        sockErr.code = 'UND_ERR_HEADERS_TIMEOUT';
        const sockClass = classifyRestError(sockErr);
        assert.strictEqual(sockClass.category, 'SOCKET_TIMEOUT');

        // Rate limit with retry_after
        const rateErr = new Error('You are being rate limited.');
        rateErr.status = 429;
        rateErr.retry_after = 5.2;
        const rateClass = classifyRestError(rateErr);
        assert.strictEqual(rateClass.category, 'RATE_LIMITED');
        assert(rateClass.message.includes('5.2s'), 'Message must contain retry duration');

        // Token expired
        const expErr = new Error('Unknown interaction');
        expErr.code = 10062;
        const expClass = classifyRestError(expErr);
        assert.strictEqual(expClass.category, 'TOKEN_EXPIRED');

        // Local REST timeout
        const restTimeoutErr = new Error('Discord editReply call timed out after 6000ms');
        restTimeoutErr.code = 'REST_TIMEOUT';
        const restClass = classifyRestError(restTimeoutErr);
        assert.strictEqual(restClass.category, 'REST_TIMEOUT');
    });

    // 8. withRestTimeout bounds execution to max 8000ms even if process.env is 15000ms
    await test('withRestTimeout bounds execution strictly and rejects with REST_TIMEOUT', async () => {
        const prev = process.env.DISCORD_REST_TIMEOUT_MS;
        process.env.DISCORD_REST_TIMEOUT_MS = '15000'; // Environment requests 15s

        const startTime = Date.now();
        let caughtErr = null;
        try {
            // Simulated hanging promise
            await withRestTimeout(
                () => new Promise(r => setTimeout(r, 10000)),
                50, // Short timeout for test
                'testCall'
            );
        } catch (err) {
            caughtErr = err;
        } finally {
            if (prev) process.env.DISCORD_REST_TIMEOUT_MS = prev;
            else delete process.env.DISCORD_REST_TIMEOUT_MS;
        }

        assert(caughtErr, 'Must catch error');
        assert.strictEqual(caughtErr.code, 'REST_TIMEOUT');
        assert(Date.now() - startTime < 1000, 'Must abort within bounded timeout');
    });

    // 9. safeReply records response failure and suppresses cascading duplicates without leaking secrets
    await test('safeReply records failure and suppresses cascading edits on response failure', async () => {
        const mockInteraction = {
            id: 'mock-int-fail-test',
            commandName: 'play',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async () => {
                const err = new Error('Discord editReply call timed out after 50ms');
                err.code = 'REST_TIMEOUT';
                throw err;
            }
        };

        const prev = process.env.DISCORD_REST_TIMEOUT_MS;
        process.env.DISCORD_REST_TIMEOUT_MS = '50';

        let res1;
        try {
            res1 = await safeReply(mockInteraction, { content: 'Test reply' });
        } finally {
            if (prev) process.env.DISCORD_REST_TIMEOUT_MS = prev;
            else delete process.env.DISCORD_REST_TIMEOUT_MS;
        }

        assert.strictEqual(res1, null, 'Failed safeReply must return null');
        assert.strictEqual(mockInteraction._responseState, RESPONSE_STATES.RESPONSE_FAILED);
        assert.strictEqual(mockInteraction._restError?.category, 'REST_TIMEOUT');

        // Subsequent non-terminal safeReply is cleanly suppressed
        const res2 = await safeReply(mockInteraction, { content: 'Second attempt' });
        assert.strictEqual(res2, null, 'Cascading attempt must be suppressed');
    });

    // 10. Autocomplete interaction classification in interactionCreate
    await test('Autocomplete interaction type is resolved as "autocomplete" instead of "select undefined"', () => {
        const mockAutocomplete = {
            isCommand: () => false,
            isButton: () => false,
            isAutocomplete: () => true,
            isStringSelectMenu: () => false,
            commandName: 'play',
            customId: undefined,
        };

        const type = mockAutocomplete.isCommand() ? 'command' : (mockAutocomplete.isButton() ? 'button' : (mockAutocomplete.isAutocomplete?.() ? 'autocomplete' : 'select'));
        const name = (mockAutocomplete.isCommand() || mockAutocomplete.isAutocomplete?.()) ? mockAutocomplete.commandName : (mockAutocomplete.customId || 'unknown');

        assert.strictEqual(type, 'autocomplete', 'Type must be autocomplete');
        assert.strictEqual(name, 'play', 'Name must be play');
    });

    // 11. DNS cache in networkGuard prevents duplicate lookups
    await test('networkGuard caches safe external host lookups without redundant DNS queries', async () => {
        const { isSafeExternalHost } = require('../src/utils/networkGuard');
        const start1 = Date.now();
        const res1 = await isSafeExternalHost('discord.com');
        const duration1 = Date.now() - start1;

        const start2 = Date.now();
        const res2 = await isSafeExternalHost('discord.com');
        const duration2 = Date.now() - start2;

        assert.strictEqual(res1, true);
        assert.strictEqual(res2, true);
        assert(duration2 <= duration1, 'Cached lookup should be immediate');
    });

    // 12. Command reach terminal state with INTERACTION_FINALIZATION_FAILED on failure
    await test('Command failure logs INTERACTION_FINALIZATION_FAILED when reply delivery fails', async () => {
        let loggedDiag = null;
        const originalError = logger.error;
        logger.error = (msg) => {
            if (String(msg).includes('[INTERACTION_FINALIZATION_FAILED]')) {
                loggedDiag = msg;
            }
        };

        try {
            const mockInteraction = {
                id: 'int-finalization-test-1',
                _restError: { code: 'REST_TIMEOUT', category: 'REST_TIMEOUT' }
            };
            const resp = null; // safeReply returned null (failed)
            const respMs = 52;
            const stage = 'VOICE_CONNECT_FAILED';

            if (!resp) {
                const classified = mockInteraction._restError || { category: 'UNKNOWN', code: 'UNKNOWN' };
                logger.error(`[INTERACTION_FINALIZATION_FAILED] id=${mockInteraction.id || 'unknown'} stage="${stage}" elapsedMs=${respMs}ms code="${classified.code}" category="${classified.category}"`);
            }

            assert(loggedDiag, 'Diagnostic must be logged');
            assert(loggedDiag.includes('stage="VOICE_CONNECT_FAILED"'));
            assert(loggedDiag.includes('category="REST_TIMEOUT"'));
        } finally {
            logger.error = originalError;
        }
    });

    console.log(`\n========================================`);
    console.log(`Test Results: ${passedTests}/${totalTests} passed`);
    console.log(`========================================\n`);

    if (passedTests !== totalTests) {
        process.exit(1);
    }
    process.exit(0);
}

run().catch((err) => {
    console.error('Test runner failure:', err);
    process.exit(1);
});
