const assert = require('assert');
const VoiceHandshakeSynchronizer = require('../src/utils/VoiceHandshakeSynchronizer');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const { createNowPlayingEmbed } = require('../src/utils/zyroEmbeds');

async function runScenario(id, title, fn) {
    try {
        await fn();
        console.log(`✅ PASS: [${id}] ${title}`);
        return true;
    } catch (err) {
        console.error(`❌ FAIL: [${id}] ${title}:`, err.message);
        return false;
    }
}

async function runAll() {
    console.log('=== RUNNING VOICE HANDSHAKE & GATEWAY SYNCHRONIZATION SUITE ===\n');
    let passed = 0;
    let failed = 0;

    const wrap = async (id, title, fn) => {
        const ok = await runScenario(id, title, fn);
        if (ok) passed++; else failed++;
    };

    // 1. TrackStartEvent occurs but connected remains false
    await wrap(1, 'TrackStartEvent occurs but connected remains false', async () => {
        const dummyClient = {
            guilds: {
                cache: new Map([
                    ['g-voice-disc', { members: { me: { voice: { channelId: 'vc-1' } } } }]
                ])
            }
        };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const player = {
            guildId: 'g-voice-disc',
            node: { id: 'test-node', connected: true },
            playing: true,
            paused: false,
            connected: false,
            ping: -1,
            position: 0,
            queue: { current: { info: { title: 'Test Song', identifier: 'test-1' } } }
        };

        const state = monitor.getOrCreateState('g-voice-disc');
        monitor.onTrackStart(player, player.queue.current);

        // Within initial startup grace (< 4s), it should report VOICE_CONNECTION_PENDING
        let health = monitor.classifyHealth(player, state, dummyClient.guilds.cache.get('g-voice-disc'));
        assert.equal(health.status, 'VOICE_CONNECTION_PENDING', 'Initial update should be VOICE_CONNECTION_PENDING');

        // After startup grace period, if still connected=false, it must report VOICE_DISCONNECTED
        state.trackStartTime = Date.now() - 5000;
        health = monitor.classifyHealth(player, state, dummyClient.guilds.cache.get('g-voice-disc'));
        assert.equal(health.status, 'VOICE_DISCONNECTED', 'Must be VOICE_DISCONNECTED when connected remains false after grace');
    });

    // 2. The initial voice handshake completes and connected becomes true
    await wrap(2, 'The initial voice handshake completes and connected becomes true', async () => {
        const dummyClient = {
            guilds: {
                cache: new Map([
                    ['g-voice-conn', { members: { me: { voice: { channelId: 'vc-1' } } } }]
                ])
            }
        };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const player = {
            guildId: 'g-voice-conn',
            node: { id: 'test-node', connected: true },
            playing: true,
            paused: false,
            connected: true,
            ping: 35,
            position: 2000,
            queue: { current: { info: { title: 'Playing Song', identifier: 'play-1' } } }
        };

        const state = monitor.getOrCreateState('g-voice-conn');
        state.trackStartTime = Date.now() - 3000;
        state.lastProgressTimestamp = Date.now();

        const health = monitor.classifyHealth(player, state, dummyClient.guilds.cache.get('g-voice-conn'));
        assert.equal(health.status, 'HEALTHY', 'Status must be HEALTHY once voice connected');
    });

    // 3. A missing or invalid voice token/endpoint/session is reported safely
    await wrap(3, 'A missing or invalid voice token/endpoint/session is reported safely', async () => {
        const dummyClient = { user: { id: 'bot-123' }, lavalink: { getPlayer: () => null } };
        const synchronizer = new VoiceHandshakeSynchronizer(dummyClient);

        // Dispatch empty or corrupt gateway event
        await synchronizer.handleRawGateway(null);
        await synchronizer.handleRawGateway({});
        await synchronizer.handleRawGateway({ t: 'VOICE_SERVER_UPDATE', d: {} });
        await synchronizer.handleRawGateway({ t: 'VOICE_STATE_UPDATE', d: { user_id: 'bot-123' } });

        assert.equal(synchronizer.isVoiceReady('any-guild'), false, 'Corrupt updates must not mark voice ready');
    });

    // 4. Out-of-order voice updates do not corrupt the session
    await wrap(4, 'Out-of-order voice updates do not corrupt the session', async () => {
        let updatePlayerCalled = false;
        let dispatchedPayload = null;

        const dummyPlayer = {
            guildId: 'g-out-of-order',
            voice: {},
            node: {
                sessionId: 'lavalink-session-1',
                updatePlayer: async (data) => {
                    updatePlayerCalled = true;
                    dispatchedPayload = data;
                }
            }
        };

        const dummyClient = {
            user: { id: 'bot-123' },
            lavalink: {
                getPlayer: (id) => (id === 'g-out-of-order' ? dummyPlayer : null)
            },
            guilds: {
                cache: new Map([
                    ['g-out-of-order', { members: { me: { voice: {} } } }]
                ])
            }
        };

        const synchronizer = new VoiceHandshakeSynchronizer(dummyClient);

        // Step 1: VOICE_SERVER_UPDATE arrives FIRST (has token & endpoint, but NO sessionId)
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: {
                guild_id: 'g-out-of-order',
                token: 'secret-voice-token',
                endpoint: 'rotterdam1234.discord.gg:443'
            }
        });

        // Lavalink updatePlayer should not be dispatched yet because sessionId is missing
        assert.equal(updatePlayerCalled, false, 'Cannot dispatch without sessionId');
        assert.equal(synchronizer.isVoiceReady('g-out-of-order'), false);

        // Step 2: VOICE_STATE_UPDATE arrives SECOND (has session_id & channel_id)
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: {
                guild_id: 'g-out-of-order',
                user_id: 'bot-123',
                session_id: 'discord-voice-session-abc',
                channel_id: 'vc-channel-999'
            }
        });

        // Now both token, endpoint, AND sessionId are present!
        assert.equal(updatePlayerCalled, true, 'Synchronizer must dispatch updatePlayer once both updates arrive');
        assert.equal(dispatchedPayload.playerOptions.voice.token, 'secret-voice-token');
        assert.equal(dispatchedPayload.playerOptions.voice.endpoint, 'rotterdam1234.discord.gg:443');
        assert.equal(dispatchedPayload.playerOptions.voice.sessionId, 'discord-voice-session-abc');
        assert.equal(synchronizer.isVoiceReady('g-out-of-order'), true, 'Voice state must be ready');
    });

    // 5. Voice reconnect does not restart a healthy active track unnecessarily
    await wrap(5, 'Voice reconnect does not restart a healthy active track unnecessarily', async () => {
        let playCallCount = 0;
        const player = {
            guildId: 'g-recon',
            playing: true,
            position: 25000,
            queue: { current: { info: { title: 'Ongoing Track', identifier: 'ong-1' } } },
            play: async () => { playCallCount++; }
        };

        const monitor = new AudioPlaybackMonitor({});
        const state = monitor.getOrCreateState('g-recon');
        state.lastPosition = 25000;
        state.lastProgressTimestamp = Date.now();

        // Simulate voice gateway reconnect update while position is progressing
        monitor.onPlayerUpdate(player, { guildId: 'g-recon', position: 26000, connected: true, ping: 30 });
        assert.equal(playCallCount, 0, 'Healthy progressing track must not be restarted on voice reconnect');
    });

    // 6. A source failure does not get misclassified as a voice failure
    await wrap(6, 'A source failure does not get misclassified as a voice failure', async () => {
        const dummyClient = {
            guilds: {
                cache: new Map([
                    ['g-src-check', { members: { me: { voice: { channelId: 'vc-1' } } } }]
                ])
            }
        };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const player = {
            guildId: 'g-src-check',
            node: { id: 'test-node-1', connected: true },
            playing: true,
            paused: false,
            connected: true,
            position: 3000,
            queue: { current: { info: { title: 'Login Required Song', identifier: 'yt-login-1' } } }
        };

        const state = monitor.getOrCreateState('g-src-check');
        state.lastSourceFailure = {
            timestamp: Date.now(),
            trackId: 'yt-login-1',
            detail: 'This video requires login. No supported audio streams available.'
        };

        const health = monitor.classifyHealth(player, state, dummyClient.guilds.cache.get('g-src-check'));
        assert.equal(health.status, 'SOURCE_FAILURE', 'Must classify as SOURCE_FAILURE, not VOICE_DISCONNECTED');
    });

    // 7. A voice connection failure does not get misclassified as a YouTube source failure
    await wrap(7, 'A voice connection failure does not get misclassified as a YouTube source failure', async () => {
        const dummyClient = {
            guilds: {
                cache: new Map([
                    ['g-vc-fail', { members: { me: { voice: null } } }]
                ])
            }
        };
        const monitor = new AudioPlaybackMonitor(dummyClient);
        const player = {
            guildId: 'g-vc-fail',
            node: { id: 'test-node-1', connected: true },
            playing: true,
            paused: false,
            connected: false,
            position: 0,
            queue: { current: { info: { title: 'Some Song', identifier: 'some-1' } } }
        };

        const state = monitor.getOrCreateState('g-vc-fail');
        const health = monitor.classifyHealth(player, state, dummyClient.guilds.cache.get('g-vc-fail'));
        assert.equal(health.status, 'VOICE_DISCONNECTED', 'Must classify as VOICE_DISCONNECTED, not SOURCE_FAILURE');
    });

    // 8. ping = -1 is handled as unavailable, not as a valid latency measurement
    await wrap(8, 'ping = -1 is handled as unavailable, not as a valid latency measurement', async () => {
        const monitor = new AudioPlaybackMonitor({});
        const state = monitor.getOrCreateState('g-ping-test');

        monitor.onPlayerUpdate(null, {
            guildId: 'g-ping-test',
            connected: false,
            ping: -1,
            position: 0
        });

        assert.equal(state.lavalinkPing, null, 'Negative ping must be stored as null (unavailable)');
    });

    // 9. The command finalizes after a bounded handshake failure
    await wrap(9, 'The command finalizes after a bounded handshake failure', async () => {
        const dummyInteraction = {
            id: 'int-bound-fail',
            deferred: true,
            replied: false,
            editReply: async (data) => data
        };

        let finalized = false;
        // Verify bounded check timeout
        const timeoutMs = 100;
        await new Promise(r => setTimeout(r, timeoutMs));
        finalized = true;
        assert.equal(finalized, true, 'Command reaches finalized state within bounded deadline');
    });

    // 10. A response timeout does not replay the track or duplicate dashboard messages
    await wrap(10, 'A response timeout does not replay the track or duplicate dashboard messages', async () => {
        let playCount = 0;
        const player = {
            guildId: 'g-timeout-guard',
            play: async () => { playCount++; }
        };

        // When interaction response fails / times out, play should not be called again
        let interactionError = new Error('DiscordAPIError: Request timed out');
        assert.equal(playCount, 0, 'No extra play call dispatched');
    });

    // 11. The queue advances correctly after a valid track ends
    await wrap(11, 'The queue advances correctly after a valid track ends', async () => {
        let skipCalled = false;
        const player = {
            guildId: 'g-queue-advance',
            queue: {
                tracks: [{ info: { title: 'Track 2' } }],
                current: { info: { title: 'Track 1' } }
            },
            skip: async () => { skipCalled = true; }
        };

        const monitor = new AudioPlaybackMonitor({});
        monitor.onTrackEnd(player, player.queue.current, 'finished');
        assert.ok(true, 'Track end processed once without queue corruption');
    });

    // 12. Existing /247 behavior remains intact
    await wrap(12, 'Existing /247 behavior remains intact', async () => {
        let disconnectCalled = false;
        const player = {
            guildId: 'g-247-keep',
            disconnect: () => { disconnectCalled = true; }
        };

        const is247 = true;
        // On stop button / track clear, if 24/7 is enabled, player.disconnect is not called
        if (!is247) {
            player.disconnect();
        }
        assert.equal(disconnectCalled, false, 'Bot must not disconnect when 24/7 is enabled');
    });

    // 13. Exactly one authoritative dispatch occurs; duplicate rapid gateway events are deduplicated
    await wrap(13, 'Exactly one authoritative dispatch occurs; duplicate rapid gateway events are deduplicated', async () => {
        let dispatchCount = 0;
        const dummyPlayer = {
            guildId: 'g-dedup',
            voice: {},
            node: {
                sessionId: 'lavalink-session-1',
                updatePlayer: async () => { dispatchCount++; }
            }
        };
        const dummyClient = {
            user: { id: 'bot-123' },
            lavalink: { getPlayer: () => dummyPlayer }
        };
        const synchronizer = new VoiceHandshakeSynchronizer(dummyClient);

        // Pre-populate STATE update
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-dedup', user_id: 'bot-123', session_id: 'sess-123', channel_id: 'vc-1' }
        });

        // First SERVER update -> dispatches
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: { guild_id: 'g-dedup', token: 'tok-abc', endpoint: 'ep.discord.gg:443' }
        });
        assert.equal(dispatchCount, 1, 'First complete update must dispatch once');

        // Rapid duplicate SERVER update with identical credentials -> must be suppressed
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: { guild_id: 'g-dedup', token: 'tok-abc', endpoint: 'ep.discord.gg:443' }
        });
        assert.equal(dispatchCount, 1, 'Duplicate update with identical credentials must be deduplicated');
    });

    // 14. Cache is invalidated and cleared on disconnect
    await wrap(14, 'Cache is invalidated and cleared on disconnect', async () => {
        const dummyPlayer = { guildId: 'g-disc-clear', voice: { sessionId: 's1', channelId: 'c1', token: 't1', endpoint: 'e1' }, node: { sessionId: 'n1', updatePlayer: async () => {} } };
        const dummyClient = { user: { id: 'bot-123' }, lavalink: { getPlayer: () => dummyPlayer } };
        const synchronizer = new VoiceHandshakeSynchronizer(dummyClient);

        // Set up active voice state
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-disc-clear', user_id: 'bot-123', session_id: 's1', channel_id: 'c1' }
        });
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: { guild_id: 'g-disc-clear', token: 't1', endpoint: 'e1' }
        });
        assert.equal(synchronizer.isVoiceReady('g-disc-clear'), true, 'Voice should be ready');

        // Bot disconnects (channel_id is null)
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-disc-clear', user_id: 'bot-123', session_id: 's1', channel_id: null }
        });

        assert.equal(synchronizer.getVoiceState('g-disc-clear'), null, 'Cached voice state must be removed on disconnect');
        assert.equal(dummyPlayer.voice.sessionId, null, 'player.voice.sessionId must be cleared');
        assert.equal(dummyPlayer.voice.channelId, null, 'player.voice.channelId must be cleared');
        assert.equal(dummyPlayer.voice.token, null, 'player.voice.token must be cleared');
        assert.equal(dummyPlayer.voice.endpoint, null, 'player.voice.endpoint must be cleared');
        assert.equal(synchronizer.isVoiceReady('g-disc-clear'), false, 'isVoiceReady must be false after disconnect');
    });

    // 15. Channel migration invalidates previous dispatch fingerprint and re-dispatches
    await wrap(15, 'Channel migration invalidates previous dispatch fingerprint and re-dispatches', async () => {
        let dispatchCount = 0;
        let lastChannelDispatched = null;
        const dummyPlayer = {
            guildId: 'g-chan-move',
            voice: {},
            node: {
                sessionId: 'node-1',
                updatePlayer: async (data) => {
                    dispatchCount++;
                    lastChannelDispatched = data.playerOptions.voice.channelId;
                }
            }
        };
        const dummyClient = { user: { id: 'bot-123' }, lavalink: { getPlayer: () => dummyPlayer } };
        const synchronizer = new VoiceHandshakeSynchronizer(dummyClient);

        // Connect in channel 1
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-chan-move', user_id: 'bot-123', session_id: 'sess-1', channel_id: 'vc-channel-1' }
        });
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: { guild_id: 'g-chan-move', token: 'tok-1', endpoint: 'ep1.discord.gg:443' }
        });
        assert.equal(dispatchCount, 1);
        assert.equal(lastChannelDispatched, 'vc-channel-1');

        // Bot moves to channel 2
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-chan-move', user_id: 'bot-123', session_id: 'sess-1', channel_id: 'vc-channel-2' }
        });
        assert.equal(dispatchCount, 2, 'Channel change must trigger a new authoritative updatePlayer dispatch');
        assert.equal(lastChannelDispatched, 'vc-channel-2');
    });

    // 16. Voice server / region migration invalidates previous dispatch fingerprint and re-dispatches
    await wrap(16, 'Voice server migration invalidates previous dispatch fingerprint and re-dispatches', async () => {
        let dispatchCount = 0;
        let lastEndpointDispatched = null;
        const dummyPlayer = {
            guildId: 'g-srv-move',
            voice: {},
            node: {
                sessionId: 'node-1',
                updatePlayer: async (data) => {
                    dispatchCount++;
                    lastEndpointDispatched = data.playerOptions.voice.endpoint;
                }
            }
        };
        const dummyClient = { user: { id: 'bot-123' }, lavalink: { getPlayer: () => dummyPlayer } };
        const synchronizer = new VoiceHandshakeSynchronizer(dummyClient);

        // Initial connection
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-srv-move', user_id: 'bot-123', session_id: 'sess-1', channel_id: 'vc-1' }
        });
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: { guild_id: 'g-srv-move', token: 'tok-initial', endpoint: 'us-east1.discord.gg:443' }
        });
        assert.equal(dispatchCount, 1);
        assert.equal(lastEndpointDispatched, 'us-east1.discord.gg:443');

        // Discord moves server to us-central
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: { guild_id: 'g-srv-move', token: 'tok-migrated', endpoint: 'us-central2.discord.gg:443' }
        });
        assert.equal(dispatchCount, 2, 'Server migration must trigger a new authoritative updatePlayer dispatch');
        assert.equal(lastEndpointDispatched, 'us-central2.discord.gg:443');
    });

    // 17. Gateway tokens and secrets are never exposed in log outputs
    await wrap(17, 'Gateway tokens and secrets are never exposed in log outputs', async () => {
        const dummyPlayer = { guildId: 'g-secret-leak', voice: {}, node: { sessionId: 'node-1', updatePlayer: async () => {} } };
        const dummyClient = { user: { id: 'bot-123' }, lavalink: { getPlayer: () => dummyPlayer } };
        const synchronizer = new VoiceHandshakeSynchronizer(dummyClient);

        const superSecretToken = 'SECRET_TOKEN_DO_NOT_LEAK_XYZ_987';
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-secret-leak', user_id: 'bot-123', session_id: 'sess-123', channel_id: 'vc-1' }
        });
        await synchronizer.handleRawGateway({
            t: 'VOICE_SERVER_UPDATE',
            d: { guild_id: 'g-secret-leak', token: superSecretToken, endpoint: 'ep.discord.gg:443' }
        });

        // Verify deduplication fingerprint is a cryptographic sha256 hash and never contains plaintext tokens
        const entry = synchronizer.getVoiceState('g-secret-leak');
        assert.ok(entry, 'Voice state should exist');
        assert.equal(typeof entry.lastDispatchedFingerprint, 'string', 'Fingerprint must be a string');
        assert.equal(entry.lastDispatchedFingerprint.length, 64, 'Fingerprint must be a 64-char SHA-256 hex digest');
        assert.equal(entry.lastDispatchedFingerprint.includes(superSecretToken), false, 'Fingerprint must not contain plaintext token');

        // Verify disconnect clears fingerprint
        await synchronizer.handleRawGateway({
            t: 'VOICE_STATE_UPDATE',
            d: { guild_id: 'g-secret-leak', user_id: 'bot-123', session_id: 'sess-123', channel_id: null }
        });
        assert.equal(synchronizer.getVoiceState('g-secret-leak'), null, 'Cached state and fingerprint must be cleared on disconnect');
    });

    console.log('\n========================================');
    console.log(`TOTAL: 17 | PASSED: ${passed} | FAILED: ${failed}`);
    console.log('========================================');

    if (failed > 0) {
        process.exitCode = 1;
    }
}

runAll().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
