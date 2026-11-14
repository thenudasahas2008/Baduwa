/**
 * test-new-music-commands.js
 * Verification suite for the 14 new real music commands added in the upgrade:
 * - /resume
 * - /previous
 * - /join
 * - /disconnect
 * - /clearqueue
 * - /jump
 * - /remove
 * - /removedupes
 * - /move
 * - /grab
 * - /bassboost
 * - /speed
 * - /pitch
 * - /nodes
 */

const assert = require('assert');

function createMockInteraction(overrides = {}) {
    let deferred = false;
    let replied = false;
    const replies = [];

    const mockVoiceChannel = {
        id: 'vc-1',
        name: 'Voice Channel',
        permissionsFor: () => ({ has: () => true })
    };

    const interaction = {
        id: `mock-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        commandName: 'test',
        user: {
            id: 'user-1',
            tag: 'Tester#0001',
            username: 'Tester',
            send: async (payload) => ({ id: 'dm-1', payload })
        },
        member: {
            voice: {
                channel: mockVoiceChannel
            },
            permissions: {
                has: () => true
            }
        },
        guild: {
            id: 'guild-123',
            name: 'Test Guild',
            members: {
                me: {
                    voice: { channel: mockVoiceChannel },
                    permissions: { has: () => true }
                }
            }
        },
        guildId: 'guild-123',
        channel: {
            id: 'tc-1',
            name: 'bot-commands',
            send: async (payload) => ({ id: 'msg-1', ...payload })
        },
        channelId: 'tc-1',
        options: {
            getInteger: () => null,
            getString: () => null,
            getNumber: () => null,
        },
        isChatInputCommand: () => true,
        isButton: () => false,
        isCommand: () => true,
        deferReply: async () => { deferred = true; interaction.deferred = true; },
        editReply: async (payload) => { replies.push(payload); return { id: 'reply-1', ...payload }; },
        reply: async (payload) => { replied = true; interaction.replied = true; replies.push(payload); return { id: 'reply-1', ...payload }; },
        followUp: async (payload) => { replies.push(payload); return { id: 'follow-1', ...payload }; },
        client: null,
        _getReplies: () => replies,
        ...overrides
    };

    return interaction;
}

function createMockPlayer(overrides = {}) {
    const queue = [];
    const previous = [];
    const currentTrack = {
        info: {
            title: 'Test Song',
            author: 'Test Artist',
            uri: 'https://youtube.com/watch?v=123',
            artworkUrl: 'https://img.youtube.com/vi/123/default.jpg',
            duration: 210000
        },
        requester: { tag: 'Tester#0001' }
    };

    const player = {
        guildId: 'guild-123',
        voiceChannelId: 'vc-1',
        textChannelId: 'tc-1',
        playing: true,
        paused: false,
        volume: 100,
        current: currentTrack,
        queue: {
            tracks: queue,
            add: (t) => queue.push(t),
            remove: (idx) => queue.splice(idx, 1)[0],
            clear: () => { queue.length = 0; },
            shuffle: () => {},
            splice: (start, deleteCount, ...items) => queue.splice(start, deleteCount, ...items),
            get: (idx) => queue[idx],
            size: () => queue.length,
            current: currentTrack,
            previous: previous
        },
        filterManager: {
            filters: {},
            setEQ: async function(eq) { this.filters.eq = eq; },
            setTimescale: async function(ts) { this.filters.timescale = ts; }
        },
        pause: async function(bool) { this.paused = bool; },
        resume: async function() { this.paused = false; },
        stop: async function() { this.playing = false; },
        skip: async function() { return true; },
        seek: async function(pos) { this.position = pos; },
        play: async function() { this.playing = true; },
        setVolume: async function(vol) { this.volume = vol; },
        ...overrides
    };

    return player;
}

function createMockClient(player, overrides = {}) {
    return {
        lavalinkConnectionManager: {
            isAvailable: () => true
        },
        lavalink: {
            getPlayer: () => player,
            createPlayer: () => ({ ...player, connect: async () => {} })
        },
        voiceChannelStatusManager: {
            syncGuildPlayerStatus: async () => {},
            updateFromPlayer: async () => {}
        },
        playerController: {
            replaceWithFullDashboard: async () => {},
            playPrevious: async () => true
        },
        ...overrides
    };
}

async function runCommandTests() {
    console.log('--- Testing New Music Commands Suite ---');
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`  [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`  [FAIL] ${name}:`, err.message);
            failed++;
        }
    }

    // 1. /resume
    await test('1. /resume unpauses player and reports SUCCESS', async () => {
        const resumeCmd = require('../src/commands/resume');
        assert.ok(resumeCmd.data.name === 'resume');
        const mockPlayer = createMockPlayer({ paused: true });
        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({ client: mockClient });
        await resumeCmd.execute(int);
        assert.strictEqual(mockPlayer.paused, false, 'Player should be resumed');
        const replies = int._getReplies();
        assert.ok(replies.length > 0);
    });

    // 2. /previous
    await test('2. /previous checks history and delegates to playPrevious safely', async () => {
        const prevCmd = require('../src/commands/previous');
        assert.ok(prevCmd.data.name === 'previous');
        const mockPlayer = createMockPlayer();
        mockPlayer.queue.previous.push({ info: { title: 'Old Song' } });
        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({ client: mockClient });
        await prevCmd.execute(int);
        assert.strictEqual(mockPlayer.queue.previous.length, 0, 'Previous track should be popped from history');
        assert.strictEqual(mockPlayer.playing, true, 'Player should be playing replayed track');
    });

    // 3. /join
    await test('3. /join connects bot to user voice channel', async () => {
        const joinCmd = require('../src/commands/join');
        assert.ok(joinCmd.data.name === 'join');
        let joinCalled = false;
        const mockClient = createMockClient(null, {
            lavalink: {
                getPlayer: () => null,
                createPlayer: () => {
                    joinCalled = true;
                    return { ...createMockPlayer(), connect: async () => {} };
                }
            }
        });
        const int = createMockInteraction({
            client: mockClient,
            guild: {
                id: 'guild-123',
                name: 'Test Guild',
                members: { me: { voice: { channel: null }, permissions: { has: () => true } } }
            }
        });
        await joinCmd.execute(int);
        assert.strictEqual(joinCalled, true);
    });

    // 4. /disconnect
    await test('4. /disconnect aliases leave command cleanly', async () => {
        const disconnectCmd = require('../src/commands/disconnect');
        assert.ok(disconnectCmd.data.name === 'disconnect');
        let leaveExecuted = false;
        const mockPlayer = createMockPlayer();
        const mockClient = createMockClient(mockPlayer, {
            commands: new Map([
                ['leave', { execute: async () => { leaveExecuted = true; } }]
            ])
        });
        const int = createMockInteraction({ client: mockClient });
        await disconnectCmd.execute(int);
        assert.strictEqual(leaveExecuted, true);
    });

    // 5. /clearqueue
    await test('5. /clearqueue aliases clear command cleanly', async () => {
        const clearqueueCmd = require('../src/commands/clearqueue');
        assert.ok(clearqueueCmd.data.name === 'clearqueue');
        let clearExecuted = false;
        const mockPlayer = createMockPlayer();
        const mockClient = createMockClient(mockPlayer, {
            commands: new Map([
                ['clear', { execute: async () => { clearExecuted = true; } }]
            ])
        });
        const int = createMockInteraction({ client: mockClient });
        await clearqueueCmd.execute(int);
        assert.strictEqual(clearExecuted, true);
    });

    // 6. /jump
    await test('6. /jump validates target track index and jumps cleanly', async () => {
        const jumpCmd = require('../src/commands/jump');
        assert.ok(jumpCmd.data.name === 'jump');
        const mockPlayer = createMockPlayer();
        mockPlayer.queue.tracks.push({ info: { title: 'Track 1' } });
        mockPlayer.queue.tracks.push({ info: { title: 'Track 2' } });

        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({
            client: mockClient,
            options: { getInteger: (name) => name === 'position' ? 2 : null }
        });
        await jumpCmd.execute(int);
        const replies = int._getReplies();
        assert.ok(replies.length > 0);
        assert.strictEqual(mockPlayer.queue.tracks.length, 1);
    });

    // 7. /remove
    await test('7. /remove removes specific 1-indexed track from queue', async () => {
        const removeCmd = require('../src/commands/remove');
        assert.ok(removeCmd.data.name === 'remove');
        const mockPlayer = createMockPlayer();
        mockPlayer.queue.tracks.push({ info: { title: 'Track 1' } });
        mockPlayer.queue.tracks.push({ info: { title: 'Track 2' } });

        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({
            client: mockClient,
            options: { getInteger: (name) => name === 'position' ? 1 : null }
        });
        await removeCmd.execute(int);
        assert.strictEqual(mockPlayer.queue.tracks.length, 1);
        assert.strictEqual(mockPlayer.queue.tracks[0].info.title, 'Track 2');
    });

    // 8. /removedupes
    await test('8. /removedupes removes duplicate tracks based on URI and title', async () => {
        const removedupesCmd = require('../src/commands/removedupes');
        assert.ok(removedupesCmd.data.name === 'removedupes');
        const mockPlayer = createMockPlayer();
        mockPlayer.queue.tracks.push(
            { info: { identifier: 'id1', title: 'Song A', author: 'Artist 1', uri: 'http://a' } },
            { info: { identifier: 'id2', title: 'Song B', author: 'Artist 2', uri: 'http://b' } },
            { info: { identifier: 'id1', title: 'Song A', author: 'Artist 1', uri: 'http://a' } }, // duplicate
            { info: { identifier: 'id3', title: 'Song C', author: 'Artist 3', uri: 'http://c' } }
        );

        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({ client: mockClient });
        await removedupesCmd.execute(int);
        assert.strictEqual(mockPlayer.queue.tracks.length, 3);
    });

    // 9. /move
    await test('9. /move correctly moves track position in queue', async () => {
        const moveCmd = require('../src/commands/move');
        assert.ok(moveCmd.data.name === 'move');
        const mockPlayer = createMockPlayer();
        mockPlayer.queue.tracks.push(
            { info: { title: 'Track 1' } },
            { info: { title: 'Track 2' } },
            { info: { title: 'Track 3' } }
        );

        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({
            client: mockClient,
            options: {
                getInteger: (name) => {
                    if (name === 'from') return 3;
                    if (name === 'to') return 1;
                    return null;
                }
            }
        });
        await moveCmd.execute(int);
        assert.strictEqual(mockPlayer.queue.tracks[0].info.title, 'Track 3');
        assert.strictEqual(mockPlayer.queue.tracks[1].info.title, 'Track 1');
        assert.strictEqual(mockPlayer.queue.tracks[2].info.title, 'Track 2');
    });

    // 10. /grab
    await test('10. /grab sends track details to user DM', async () => {
        const grabCmd = require('../src/commands/grab');
        assert.ok(grabCmd.data.name === 'grab');
        let dmSent = false;
        const mockPlayer = createMockPlayer();
        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({
            client: mockClient,
            user: {
                id: 'user-1',
                tag: 'Tester#0001',
                send: async (msg) => { dmSent = true; return msg; }
            }
        });
        await grabCmd.execute(int);
        assert.strictEqual(dmSent, true);
    });

    // 11. /bassboost
    await test('11. /bassboost sets 15-band EQ gain presets on player', async () => {
        const bbCmd = require('../src/commands/bassboost');
        assert.ok(bbCmd.data.name === 'bassboost');
        const mockPlayer = createMockPlayer();
        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({
            client: mockClient,
            options: { getString: (name) => name === 'level' ? 'high' : null }
        });
        await bbCmd.execute(int);
        assert.ok(Array.isArray(mockPlayer.filterManager.filters.eq));
        assert.strictEqual(mockPlayer.filterManager.filters.eq[0].gain, 0.50);
    });

    // 12. /speed
    await test('12. /speed sets timescale speed multiplier within valid bounds', async () => {
        const speedCmd = require('../src/commands/speed');
        assert.ok(speedCmd.data.name === 'speed');
        const mockPlayer = createMockPlayer();
        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({
            client: mockClient,
            options: { getNumber: (name) => name === 'multiplier' ? 1.25 : null }
        });
        await speedCmd.execute(int);
        assert.strictEqual(mockPlayer.filterManager.filters.timescale.speed, 1.25);
    });

    // 13. /pitch
    await test('13. /pitch sets timescale pitch multiplier within valid bounds', async () => {
        const pitchCmd = require('../src/commands/pitch');
        assert.ok(pitchCmd.data.name === 'pitch');
        const mockPlayer = createMockPlayer();
        const mockClient = createMockClient(mockPlayer);
        const int = createMockInteraction({
            client: mockClient,
            options: { getNumber: (name) => name === 'multiplier' ? 0.9 : null }
        });
        await pitchCmd.execute(int);
        assert.strictEqual(mockPlayer.filterManager.filters.timescale.pitch, 0.9);
    });

    // 14. /nodes
    await test('14. /nodes returns read-only Lavalink node telemetry without exposing credentials', async () => {
        const nodesCmd = require('../src/commands/nodes');
        assert.ok(nodesCmd.data.name === 'nodes');
        const mockClient = {
            lavalink: {
                nodeManager: {
                    nodes: new Map([
                        ['Main-Node', {
                            options: { id: 'Main-Node', host: 'lavalink.example.com', port: 2333, authorization: 'SUPER_SECRET_PW' },
                            connected: true,
                            stats: {
                                players: 2,
                                playingPlayers: 1,
                                uptime: 3600000,
                                memory: { used: 104857600, reservable: 536870912 },
                                cpu: { lavalinkLoad: 0.05, systemLoad: 0.15 }
                            },
                            ping: async () => 18
                        }]
                    ])
                }
            }
        };
        const int = createMockInteraction({ client: mockClient });
        await nodesCmd.execute(int);
        const replies = int._getReplies();
        assert.ok(replies.length > 0);
        const embed = replies[0].embeds[0].data;
        assert.ok(embed.title.includes('Lavalink Node Telemetry'));
        const json = JSON.stringify(embed);
        assert.ok(!json.includes('SUPER_SECRET_PW'), 'Must NEVER expose node authorization password in embeds');
        assert.ok(json.includes('Main-Node'));
    });

    console.log(`\n========================================`);
    console.log(`NEW COMMANDS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log(`========================================\n`);

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runCommandTests().catch(err => {
    console.error('Fatal error in command tests:', err);
    process.exit(1);
});
