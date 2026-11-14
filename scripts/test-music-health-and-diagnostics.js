const assert = require('assert');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const musicLogsCommand = require('../src/commands/music-logs');
const musicInfoCommand = require('../src/commands/music-info');

console.log('🧪 Starting ZYRO Live Music Health & Audio Diagnostics Test Suite...\n');

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASSED: ${name}`);
        testsPassed++;
    } catch (err) {
        console.error(`  ❌ FAILED: ${name}`);
        console.error(`     Error: ${err.message}`);
        testsFailed++;
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASSED: ${name}`);
        testsPassed++;
    } catch (err) {
        console.error(`  ❌ FAILED: ${name}`);
        console.error(`     Error: ${err.message}`);
        testsFailed++;
    }
}

// Mock Client Generator
function createMockClient() {
    const players = new Map();
    const guilds = new Map();

    const client = {
        lavalink: {
            getPlayer: (guildId) => players.get(guildId) || null,
            nodeManager: {
                nodes: new Map([
                    ['test-node-1', {
                        id: 'test-node-1',
                        connected: true,
                        connectionStatus: 'connected',
                        version: '4.0.8',
                        heartBeatPing: 28,
                        stats: {
                            uptime: 86400000,
                            cpu: { lavalinkLoad: 0.12, systemLoad: 0.35 },
                            memory: { used: 150 * 1024 * 1024, allocated: 512 * 1024 * 1024, free: 362 * 1024 * 1024 },
                            frameStats: { sent: 3000, nulled: 0, deficit: 0 }
                        }
                    }]
                ])
            }
        },
        guilds: {
            cache: guilds
        },
        ws: {
            ping: 35
        },
        autoplayEnabled: {
            get: () => false
        },
        guildSettings: {
            get247: () => null
        },
        performanceMonitor: {
            getMetricsSummary: () => ({
                eventLoop: { lagMeanMs: 4.2, lagP95Ms: 12.5, lagMaxMs: 38.0 },
                interactions: { total: 120, avgDurationMs: 45.2, timeouts: 0 },
                searches: { avgDurationMs: 110.5, cacheHitRatePct: 82.5 }
            })
        }
    };

    client.audioPlaybackMonitor = new AudioPlaybackMonitor(client);
    return { client, players, guilds };
}

(async () => {
    // 1. IDLE State Detection
    runTest('1. IDLE status correctly detected when no track is active', () => {
        const { client } = createMockClient();
        const health = client.audioPlaybackMonitor.getGuildHealth('guild-idle');
        assert.strictEqual(health.status, 'IDLE');
        assert.strictEqual(health.player.state, 'IDLE');
        assert.strictEqual(health.player.isProgressing, false);
        assert.strictEqual(health.player.trackTitle, 'None');
        assert(health.hosting.uptime !== 'Unavailable');
        assert(health.hosting.rss.includes('MB'));
    });

    // 2. HEALTHY Playback Detection with Progressing Position
    runTest('2. HEALTHY status correctly detected when server position is advancing', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-healthy';

        guilds.set(guildId, {
            id: guildId,
            members: {
                me: {
                    voice: { channelId: 'vc-1', sessionId: 'discord-session-1' }
                }
            },
            channels: {
                cache: new Map([['vc-1', { id: 'vc-1', name: 'Music Lounge' }]])
            }
        });

        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            voiceChannelId: 'vc-1',
            position: 12000,
            lastPosition: 12000,
            volume: 100,
            repeatMode: 'off',
            queue: {
                current: {
                    info: {
                        title: 'Blinding Lights',
                        author: 'The Weeknd',
                        duration: 200000,
                        identifier: 'track-blinding-lights',
                        sourceName: 'youtube'
                    }
                },
                tracks: []
            },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, player);

        client.audioPlaybackMonitor.onTrackStart(player, player.queue.current);

        // Advance position
        client.audioPlaybackMonitor.onPlayerUpdate(player, {
            ...player,
            position: 15000,
            lastPosition: 15000
        });

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(health.status, 'HEALTHY');
        assert.strictEqual(health.player.state, 'PLAYING');
        assert.strictEqual(health.player.isProgressing, true);
        assert.strictEqual(health.player.trackTitle, 'Blinding Lights');
        assert.strictEqual(health.voice.channelName, 'Music Lounge');
        assert.strictEqual(health.node.connected, true);
        assert.strictEqual(health.node.pingMs, '28ms');
    });

    // 3. Genuine Position Stall Detection
    runTest('3. POSITION_STALLED status triggered when server-reported position stops progressing', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-stalled';

        guilds.set(guildId, {
            id: guildId,
            members: { me: { voice: { channelId: 'vc-1', sessionId: 'sess-1' } } },
            channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'General Voice' }]]) }
        });

        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            voiceChannelId: 'vc-1',
            position: 45000,
            lastPosition: 45000,
            queue: {
                current: {
                    info: {
                        title: 'Frozen Track',
                        author: 'Artist',
                        duration: 180000,
                        identifier: 'track-frozen',
                        sourceName: 'youtube'
                    }
                },
                tracks: []
            },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, player);

        const state = client.audioPlaybackMonitor.getOrCreateState(guildId);
        state.trackStartTime = Date.now() - 30000; // Past initial grace period
        state.lastProgressTimestamp = Date.now() - 25000; // 25s without position change (> 18s)
        state.stalledChecks = 2; // Verified stalled checks

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(health.status, 'POSITION_STALLED');
        assert.strictEqual(health.player.isProgressing, false);
        assert(health.diagnosis.confirmedCauses.some(c => c.includes('position frozen')));
    });

    // 4. Paused Playback Not Falsely Marked Stalled
    runTest('4. Paused playback is NOT falsely classified as stalled', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-paused';

        guilds.set(guildId, {
            id: guildId,
            members: { me: { voice: { channelId: 'vc-1', sessionId: 'sess-1' } } },
            channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'Chill Room' }]]) }
        });

        const player = {
            guildId,
            playing: true,
            paused: true, // Paused by user
            connected: true,
            voiceChannelId: 'vc-1',
            position: 30000,
            queue: {
                current: {
                    info: {
                        title: 'Paused Song',
                        author: 'Artist',
                        duration: 180000,
                        identifier: 'track-paused'
                    }
                },
                tracks: []
            },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, player);

        const state = client.audioPlaybackMonitor.getOrCreateState(guildId);
        state.trackStartTime = Date.now() - 60000;
        state.lastProgressTimestamp = Date.now() - 40000; // Paused for 40s

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(health.status, 'HEALTHY'); // Paused is healthy!
        assert.strictEqual(health.player.state, 'PAUSED');
        assert.strictEqual(health.player.paused, true);
        assert(health.statusDetail.includes('paused'));
    });

    // 5. Source Failure Distinguish from Voice Disconnect
    runTest('5. Source failure is correctly distinguished from voice disconnect', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-src-fail';

        guilds.set(guildId, {
            id: guildId,
            members: { me: { voice: { channelId: 'vc-1', sessionId: 'sess-1' } } },
            channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'Voice 1' }]]) }
        });

        const player = {
            guildId,
            playing: false,
            paused: false,
            connected: true, // Voice is completely fine
            voiceChannelId: 'vc-1',
            queue: { current: null, tracks: [] },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, player);

        // Record source level error: This video requires login
        client.audioPlaybackMonitor.recordGuildEvent(guildId, 'SOURCE_UNAVAILABLE', {
            trackTitle: 'Private Track',
            trackIdentifier: 'track-restricted',
            detail: 'This video requires login to confirm your age',
            level: 'warn'
        });

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(health.status, 'SOURCE_FAILURE');
        assert(health.statusDetail.includes('requires login'));
        assert(health.diagnosis.confirmedCauses.some(c => c.includes('requires login')));
        assert.strictEqual(health.voice.botConnected, true);
    });

    // 6. Voice Disconnect Correctly Detected
    runTest('6. Voice disconnect correctly detected when bot leaves voice or session drops', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-voice-dropped';

        guilds.set(guildId, {
            id: guildId,
            members: { me: { voice: { channelId: null } } }, // Not in voice
            channels: { cache: new Map() }
        });

        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: false, // Voice connection dropped
            queue: {
                current: { info: { title: 'Some Song', duration: 120000, identifier: 'song-1' } },
                tracks: []
            },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, player);

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(health.status, 'VOICE_DISCONNECTED');
        assert.strictEqual(health.voice.botConnected, false);
    });

    // 7. Node Ping and Node Unhealthy when Disconnected
    runTest('7. Node ping reports Unavailable and NODE_UNHEALTHY when node disconnects', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-node-down';

        guilds.set(guildId, {
            id: guildId,
            members: { me: { voice: { channelId: 'vc-1', sessionId: 'sess-1' } } },
            channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'VC' }]]) }
        });

        const offlineNode = {
            id: 'dead-node',
            connected: false,
            connectionStatus: 'disconnected',
            heartBeatPing: null,
            ping: null,
            stats: null
        };

        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            voiceChannelId: 'vc-1',
            queue: {
                current: { info: { title: 'Track', duration: 120000, identifier: 'id-1' } },
                tracks: []
            },
            node: offlineNode
        };
        players.set(guildId, player);

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(health.status, 'NODE_UNHEALTHY');
        assert.strictEqual(health.node.connected, false);
        assert.strictEqual(health.node.pingMs, 'Unavailable');
        assert.strictEqual(health.node.cpu.lavalinkLoad, 'Unavailable');
        assert(health.diagnosis.confirmedCauses.some(c => c.includes('disconnected')));
    });

    // 8. Audio Frame Metrics Handled Correctly When Supported or Absent
    runTest('8. Lavalink frame statistics correctly interpreted or marked Unavailable', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-frame-stats';

        guilds.set(guildId, {
            id: guildId,
            members: { me: { voice: { channelId: 'vc-1', sessionId: 'sess-1' } } },
            channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'VC' }]]) }
        });

        // 8a. Node with real frameStats payload
        const playerWithStats = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            voiceChannelId: 'vc-1',
            queue: { current: { info: { title: 'Song', duration: 100000 } }, tracks: [] },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, playerWithStats);

        const healthWithStats = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(healthWithStats.node.frameStats.data.sent, 3000);
        assert.strictEqual(healthWithStats.node.frameStats.data.nulled, 0);
        assert.strictEqual(healthWithStats.node.frameStats.data.deficit, 0);
        assert(healthWithStats.node.frameStats.interpretation.includes('3000 sent'));
        assert(healthWithStats.node.frameStats.interpretation.includes('silence buffer'));

        // 8b. Node without frameStats payload
        const nodeWithoutFrameStats = {
            id: 'legacy-node',
            connected: true,
            version: '4.0.0',
            stats: { uptime: 10000 } // No frameStats
        };
        playerWithStats.node = nodeWithoutFrameStats;

        const healthWithoutStats = client.audioPlaybackMonitor.getGuildHealth(guildId);
        assert.strictEqual(healthWithoutStats.node.frameStats.data, null);
        assert.strictEqual(healthWithoutStats.node.frameStats.interpretation, 'Unavailable (node does not report frame telemetry)');
    });

    // 9. Sensitive Tokens and Credentials NEVER Leaked
    runTest('9. Sensitive tokens, Discord session secrets, and Lavalink passwords NEVER appear in diagnostic output', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-security';

        guilds.set(guildId, {
            id: guildId,
            members: {
                me: {
                    voice: {
                        channelId: 'vc-1',
                        sessionId: 'SUPER_SECRET_DISCORD_VOICE_SESSION_ID',
                        token: 'SUPER_SECRET_DISCORD_TOKEN'
                    }
                }
            },
            channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'Secure Room' }]]) }
        });

        const player = {
            guildId,
            playing: true,
            connected: true,
            voiceChannelId: 'vc-1',
            voice: {
                sessionId: 'SECRET_LAVALINK_SESSION',
                token: 'SECRET_LAVALINK_TOKEN',
                endpoint: 'secret.discord.gg'
            },
            queue: { current: { info: { title: 'Track', duration: 100000 } }, tracks: [] },
            node: {
                id: 'secure-node',
                connected: true,
                options: {
                    authorization: 'TOP_SECRET_LAVALINK_PASSWORD',
                    password: 'TOP_SECRET_PASSWORD'
                }
            }
        };
        players.set(guildId, player);

        const health = client.audioPlaybackMonitor.getGuildHealth(guildId);
        const serialized = JSON.stringify(health);

        assert(!serialized.includes('SUPER_SECRET_DISCORD_TOKEN'), 'Leaked discord token!');
        assert(!serialized.includes('SUPER_SECRET_DISCORD_VOICE_SESSION_ID'), 'Leaked discord session secret!');
        assert(!serialized.includes('TOP_SECRET_LAVALINK_PASSWORD'), 'Leaked lavalink password!');
        assert(!serialized.includes('TOP_SECRET_PASSWORD'), 'Leaked lavalink password!');
        assert(!serialized.includes('SECRET_LAVALINK_TOKEN'), 'Leaked lavalink voice token!');
        assert.strictEqual(health.voice.hasCredentialsExposed, false);
    });

    // 10. Monitoring Requests are Strictly Read-Only
    runTest('10. Diagnostics requests are strictly read-only and do NOT interrupt music', () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-readonly';

        let playCalled = false;
        let skipCalled = false;
        let stopCalled = false;

        const player = {
            guildId,
            playing: true,
            connected: true,
            voiceChannelId: 'vc-1',
            position: 50000,
            play: async () => { playCalled = true; },
            skip: async () => { skipCalled = true; },
            stopPlaying: async () => { stopCalled = true; },
            queue: { current: { info: { title: 'Current Song', duration: 150000 } }, tracks: [] },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, player);

        // Fetch health multiple times
        client.audioPlaybackMonitor.getGuildHealth(guildId);
        client.audioPlaybackMonitor.getGuildHealth(guildId);

        assert.strictEqual(playCalled, false, 'play() was unexpectedly called!');
        assert.strictEqual(skipCalled, false, 'skip() was unexpectedly called!');
        assert.strictEqual(stopCalled, false, 'stopPlaying() was unexpectedly called!');
        assert.strictEqual(player.playing, true);
    });

    // 11. /music-logs Permission Gating
    await runAsyncTest('11. /music-logs command rejects unauthorized users and allows admins', async () => {
        const { client } = createMockClient();

        // 11a: Unauthorized user without permissions
        let unauthorizedReply = null;
        const mockUnauthorizedInteraction = {
            client,
            guild: { id: 'guild-perms', name: 'Test Guild' },
            guildId: 'guild-perms',
            member: {
                permissions: { has: () => false },
                roles: { cache: new Map() }
            },
            channel: { name: 'general' },
            user: { tag: 'regular_user#0001', id: 'user-1' },
            options: { getBoolean: () => false },
            reply: async (msg) => { unauthorizedReply = msg; },
            isReplied: false,
            deferred: false
        };

        await musicLogsCommand.execute(mockUnauthorizedInteraction);
        assert(unauthorizedReply, 'No reply was sent!');
        assert(unauthorizedReply.content.includes('Access Denied'));

        // 11b: Authorized admin user
        let authorizedReply = null;
        const mockAuthorizedInteraction = {
            client,
            guild: { id: 'guild-perms', name: 'Test Guild' },
            guildId: 'guild-perms',
            member: {
                permissions: { has: (perm) => true }, // Has Admin
                roles: { cache: new Map() }
            },
            channel: { name: 'general' },
            user: { tag: 'admin_user#0001', id: 'admin-1' },
            options: { getBoolean: () => false },
            reply: async (msg) => { authorizedReply = msg; },
            isReplied: false,
            deferred: false
        };

        await musicLogsCommand.execute(mockAuthorizedInteraction);
        assert(authorizedReply, 'Admin reply was not sent!');
        assert(authorizedReply.embeds && authorizedReply.embeds.length > 0);
        const embedTitle = authorizedReply.embeds[0].data?.title || '';
        assert(embedTitle.includes('ZYRO Music Health & Audio Quality Diagnostics'));
    });

    // 12. /music-info Accessible to Listeners
    await runAsyncTest('12. /music-info provides a concise summary for current playback', async () => {
        const { client, players, guilds } = createMockClient();
        const guildId = 'guild-info-cmd';

        guilds.set(guildId, {
            id: guildId,
            members: { me: { voice: { channelId: 'vc-1', sessionId: 'sess-1' } } },
            channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'Music Channel' }]]) }
        });

        const player = {
            guildId,
            playing: true,
            paused: false,
            connected: true,
            voiceChannelId: 'vc-1',
            position: 60000,
            queue: {
                current: {
                    info: {
                        title: 'Starboy',
                        author: 'The Weeknd ft. Daft Punk',
                        duration: 230000,
                        identifier: 'starboy-id'
                    }
                },
                tracks: [{ info: { title: 'Next Song' } }]
            },
            node: client.lavalink.nodeManager.nodes.get('test-node-1')
        };
        players.set(guildId, player);

        let sentReply = null;
        const mockInteraction = {
            client,
            guild: { id: guildId, name: 'Info Guild' },
            guildId,
            channel: { name: 'music-chat' },
            user: { tag: 'listener#1234', id: 'listener-1' },
            reply: async (msg) => { sentReply = msg; },
            isReplied: false,
            deferred: false
        };

        await musicInfoCommand.execute(mockInteraction);
        assert(sentReply, 'No reply sent for /music-info!');
        assert(sentReply.embeds && sentReply.embeds.length > 0);
        const embed = sentReply.embeds[0].data;
        assert(embed.title.includes('Current Song Playback Health'));
        assert(embed.description.includes('Starboy'));
        assert(embed.description.includes('The Weeknd ft. Daft Punk'));
    });

    console.log(`\n======================================================`);
    console.log(`🏆 Music Health & Diagnostics Suite Results: ${testsPassed} PASSED, ${testsFailed} FAILED`);
    console.log(`======================================================\n`);

    if (testsFailed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
