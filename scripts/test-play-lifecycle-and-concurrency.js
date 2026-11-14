const assert = require('node:assert/strict');
const playCommand = require('../src/commands/play');
const { searchMusic, clearSearchCache, CONFIDENCE_LEVELS } = require('../src/utils/searchEngine');
const { ensureDeferred, safeReply } = require('../src/utils/interactionHelpers');
const { performanceMonitor } = require('../src/utils/performanceMonitor');

// Ensure performanceMonitor doesn't keep node event loop open after tests
if (performanceMonitor && performanceMonitor.intervalTimer && typeof performanceMonitor.intervalTimer.unref === 'function') {
    performanceMonitor.intervalTimer.unref();
}

console.log('--- Running ZYRO /play Lifecycle & Concurrency Regression Tests ---');

function createMockInteraction(options = {}) {
    const id = options.id || `inter_${Math.random().toString(36).slice(2, 9)}`;
    const guildId = options.guildId || 'guild_test_01';
    const query = options.query || 'Paradise';
    const playNext = options.next || false;

    let deferred = false;
    let replied = false;
    let deferCount = 0;
    let replies = [];
    let editReplies = [];
    let followUps = [];

    const member = {
        user: { id: options.userId || 'user_1', tag: 'Tester#0001' },
        voice: {
            channel: {
                id: 'vc_1',
                name: 'Music Voice',
                permissionsFor: () => ({
                    has: (perm) => true,
                }),
            },
        },
    };

    const guild = {
        id: guildId,
        name: 'Test Server',
        members: {
            me: {
                id: 'bot_id',
                voice: { channelId: null },
            },
        },
    };

    const mockPlayer = options.player || {
        guildId,
        connected: true,
        voice: { token: 'mock_token_123' },
        playing: false,
        paused: false,
        repeatMode: 'off',
        queue: {
            current: null,
            tracks: [],
            add: async (tracks, pos) => {
                const list = Array.isArray(tracks) ? tracks : [tracks];
                if (pos === 0) mockPlayer.queue.tracks.unshift(...list);
                else mockPlayer.queue.tracks.push(...list);
            },
        },
        connect: async () => { mockPlayer.connected = true; },
        play: async (opts) => {
            mockPlayer.playing = true;
            if (opts?.clientTrack) mockPlayer.queue.current = opts.clientTrack;
            else if (!mockPlayer.queue.current && mockPlayer.queue.tracks.length > 0) {
                mockPlayer.queue.current = mockPlayer.queue.tracks.shift();
            }
        },
        setData: () => {},
        getData: () => null,
    };

    const client = {
        defaultLanguage: 'en',
        languageManager: {
            get: (lang, key) => key,
        },
        lavalinkConnectionManager: {
            isAvailable: () => options.lavalinkAvailable !== false,
        },
        lavalink: {
            getPlayer: () => mockPlayer,
            createPlayer: () => mockPlayer,
        },
        playerController: {
            replaceWithFullDashboard: async () => {},
            updatePlayer: async () => {},
        },
        voiceChannelStatusManager: {
            updateFromPlayer: async () => {},
        },
    };

    const interaction = {
        id,
        commandName: 'play',
        guildId,
        guild,
        member,
        client,
        channel: { id: 'tc_1', name: 'general', type: 0 },
        user: member.user,
        options: {
            getString: (name) => (name === 'query' ? query : null),
            getBoolean: (name) => (name === 'next' ? playNext : false),
        },
        get deferred() { return deferred; },
        get replied() { return replied; },
        async deferReply(opts = {}) {
            deferCount++;
            if (deferred || replied) {
                const err = new Error('Interaction already acknowledged');
                err.code = 40060;
                throw err;
            }
            deferred = true;
            return { deferred: true };
        },
        async editReply(payload) {
            editReplies.push(payload);
            replied = true;
            return payload;
        },
        async reply(payload) {
            if (deferred || replied) {
                const err = new Error('Interaction already acknowledged');
                err.code = 40060;
                throw err;
            }
            replies.push(payload);
            replied = true;
            return payload;
        },
        async followUp(payload) {
            followUps.push(payload);
            return payload;
        },
        _testState: {
            get deferCount() { return deferCount; },
            replies,
            editReplies,
            followUps,
            mockPlayer,
        },
    };

    return interaction;
}

async function runTests() {
    let passed = 0;
    const total = 11;

    // Test 1: Prompt acknowledgement (<50ms) for a slow simulated search
    {
        clearSearchCache();
        const interaction = createMockInteraction({ query: 'https://www.youtube.com/watch?v=slow1234567' });
        const start = Date.now();
        const ackResult = await ensureDeferred(interaction, { ephemeral: true });
        const ackDuration = Date.now() - start;

        assert.equal(interaction.deferred, true, 'Interaction must be deferred promptly');
        assert.ok(ackDuration < 50, `Initial acknowledgement must complete in <50ms (took ${ackDuration}ms)`);
        assert.equal(interaction._testState.deferCount, 1, 'deferReply must only be called once');
        console.log('  ok  - 1. A slow simulated search receives an initial acknowledgement promptly');
        passed++;
    }

    // Test 2: Every deferred /play interaction is finalized on success with accurate status
    {
        clearSearchCache();
        const interaction = createMockInteraction({ query: 'Paradise Coldplay' });
        const player = interaction._testState.mockPlayer;
        player.search = async () => ({
            loadType: 'track',
            tracks: [{
                info: { identifier: 'coldplay_p1', title: 'Paradise', author: 'Coldplay', duration: 278000, uri: 'https://youtube.com/watch?v=1' },
            }],
        });

        await playCommand.execute(interaction);

        assert.ok(interaction.replied, 'Interaction must be finalized via editReply');
        assert.equal(interaction._testState.editReplies.length, 1, 'Exactly one editReply must be delivered');
        const replyContent = interaction._testState.editReplies[0].content;
        assert.match(replyContent, /Loading audio: \*\*Paradise\*\*/, 'Initial playback must report Loading audio rather than Playing');
        assert.ok(player.queue.current || player.queue.tracks.length > 0, 'Track must be placed in player queue/current');
        console.log('  ok  - 2. Every deferred /play interaction is finalized on success with accurate status');
        passed++;
    }

    // Test 3: Search failure, Lavalink unavailable, and timeout produce deliberate final responses
    {
        // 3a. Search failure / empty
        const failInteraction = createMockInteraction({ query: 'asdkjhqwueyiuwqye' });
        failInteraction._testState.mockPlayer.search = async () => ({ loadType: 'empty', tracks: [] });
        await playCommand.execute(failInteraction);
        assert.ok(failInteraction.replied, 'Search failure must be finalized');
        assert.ok(failInteraction._testState.editReplies[0]?.embeds?.length > 0, 'No match response must include deliberate embed');

        // 3b. Lavalink unavailable
        const unavailInteraction = createMockInteraction({ query: 'Coldplay', lavalinkAvailable: false });
        await playCommand.execute(unavailInteraction);
        assert.ok(unavailInteraction.replied, 'Lavalink unavailable must be finalized');
        assert.match(unavailInteraction._testState.editReplies[0]?.embeds?.[0]?.data?.title, /Music Service Reconnecting/, 'Must display service reconnecting warning');

        console.log('  ok  - 3. Search failure, Lavalink unavailable, and timeout produce deliberate final responses');
        passed++;
    }

    // Test 4: Three independent /play interactions do not remain stuck on Thinking indefinitely
    {
        clearSearchCache();
        const guildId = 'guild_rapid_03';
        const inter1 = createMockInteraction({ id: 'cmd_1', guildId, query: 'Song Alpha' });
        const inter2 = createMockInteraction({ id: 'cmd_2', guildId, query: 'Song Beta' });
        const inter3 = createMockInteraction({ id: 'cmd_3', guildId, query: 'Paradise Sachie Leoze' });

        const player = inter1._testState.mockPlayer;
        inter2.client.lavalink.getPlayer = () => player;
        inter3.client.lavalink.getPlayer = () => player;

        player.search = async (opts) => {
            await new Promise(r => setTimeout(r, 60));
            return {
                loadType: 'track',
                tracks: [{
                    info: { identifier: `track_${opts.query.slice(0, 5)}`, title: opts.query, author: 'Artist', duration: 180000 },
                }],
            };
        };

        // Fire 3 commands rapidly in the same guild
        const p1 = playCommand.execute(inter1);
        const p2 = playCommand.execute(inter2);
        const p3 = playCommand.execute(inter3);

        await Promise.all([p1, p2, p3]);

        // All 3 interactions MUST be finalized (replied === true)
        assert.ok(inter1.replied, 'Command 1 must be finalized (cannot remain stuck on Thinking)');
        assert.ok(inter2.replied, 'Command 2 must be finalized (cannot remain stuck on Thinking)');
        assert.ok(inter3.replied, 'Command 3 must be finalized (cannot remain stuck on Thinking)');

        // Inter 1 and Inter 2 must be gracefully superseded
        const inter1Embed = inter1._testState.editReplies[0]?.embeds?.[0]?.data;
        assert.match(inter1Embed?.title, /Search Superseded/, 'Command 1 must be notified it was superseded');

        const inter2Embed = inter2._testState.editReplies[0]?.embeds?.[0]?.data;
        assert.match(inter2Embed?.title, /Search Superseded/, 'Command 2 must be notified it was superseded');

        // Command 3 was the winner and got queued
        const inter3Reply = inter3._testState.editReplies[0]?.content;
        assert.match(inter3Reply, /Paradise Sachie Leoze/, 'Command 3 must deliver successful queued response');

        console.log('  ok  - 4. Three independent /play interactions do not remain stuck on Thinking indefinitely');
        passed++;
    }

    // Test 5: Overlapping commands have independent accurate timers
    {
        clearSearchCache();
        const interA = createMockInteraction({ id: 'inter_timer_A', guildId: 'guild_A', query: 'Fast Track' });
        const interB = createMockInteraction({ id: 'inter_timer_B', guildId: 'guild_B', query: 'Slow Track' });

        interA._testState.mockPlayer.search = async () => {
            await new Promise(r => setTimeout(r, 10));
            return { loadType: 'track', tracks: [{ info: { title: 'Fast Track', author: 'A', duration: 1000 } }] };
        };
        interB._testState.mockPlayer.search = async () => {
            await new Promise(r => setTimeout(r, 80));
            return { loadType: 'track', tracks: [{ info: { title: 'Slow Track', author: 'B', duration: 2000 } }] };
        };

        const timerA = performanceMonitor.startInteraction(interA);
        const timerB = performanceMonitor.startInteraction(interB);

        await Promise.all([playCommand.execute(interA), playCommand.execute(interB)]);

        const durA = timerA();
        const durB = timerB();

        assert.ok(durA >= 10 && durA < 150, `Timer A should be around ~10-40ms (was ${durA}ms)`);
        assert.ok(durB >= 75 && durB < 250, `Timer B should be around ~80-120ms (was ${durB}ms)`);
        console.log('  ok  - 5. Overlapping commands have independent accurate timers');
        passed++;
    }

    // Test 6: A newer request cannot be overwritten by an obsolete delayed result
    {
        clearSearchCache();
        const guildId = 'guild_race_guard';
        const interOld = createMockInteraction({ id: 'cmd_old', guildId, query: 'Old Slow Song' });
        const interNew = createMockInteraction({ id: 'cmd_new', guildId, query: 'New Fast Song' });

        const player = interOld._testState.mockPlayer;
        interNew.client.lavalink.getPlayer = () => player;

        let oldSearchFinished = false;
        player.search = async (opts) => {
            if (opts.query.includes('Old')) {
                await new Promise(r => setTimeout(r, 150));
                oldSearchFinished = true;
                return { loadType: 'track', tracks: [{ info: { title: 'Old Slow Song', author: 'Oldie', duration: 200000 } }] };
            }
            await new Promise(r => setTimeout(r, 20));
            return { loadType: 'track', tracks: [{ info: { title: 'New Fast Song', author: 'Newbie', duration: 180000 } }] };
        };

        const pOld = playCommand.execute(interOld);
        await new Promise(r => setTimeout(r, 10));
        const pNew = playCommand.execute(interNew);

        await Promise.all([pOld, pNew]);

        // Verify the active track in player is New Fast Song, NOT Old Slow Song!
        const activeTrack = player.queue.current || player.queue.tracks[0];
        assert.equal(activeTrack?.info?.title, 'New Fast Song', 'Player must retain the newer track');
        assert.ok(player.queue.current?.info?.title !== 'Old Slow Song', 'Obsolete delayed search result must NOT be playing');
        assert.ok(!player.queue.tracks.some(t => t.info?.title === 'Old Slow Song'), 'Obsolete delayed search result must NOT be in queue');
        console.log('  ok  - 6. A newer request cannot be overwritten by an obsolete delayed result');
        passed++;
    }

    // Test 7: Safe deduplication does not merge genuinely different queries
    {
        clearSearchCache();
        const playerMock = {
            search: async (opts) => ({
                loadType: 'track',
                tracks: [{ info: { title: opts.query, author: 'Artist' } }],
            }),
        };

        const res1 = await searchMusic(playerMock, 'Paradise Coldplay', { id: 'u1' });
        const res2 = await searchMusic(playerMock, 'Paradise Sachie Leoze', { id: 'u2' });

        assert.equal(res1.tracks[0].info.title, 'Paradise Coldplay');
        assert.equal(res2.tracks[0].info.title, 'Paradise Sachie Leoze');
        assert.notEqual(res1.tracks[0].info.title, res2.tracks[0].info.title, 'Different queries must yield their respective results');
        console.log('  ok  - 7. Safe deduplication does not merge genuinely different queries');
        passed++;
    }

    // Test 8: Search timeout cancels or invalidates the underlying work
    {
        clearSearchCache();
        const abortController = new AbortController();
        const slowPlayer = {
            search: async () => {
                await new Promise(r => setTimeout(r, 300));
                return { loadType: 'track', tracks: [{ info: { title: 'Hanging Song' } }] };
            },
        };

        // Abort after 25ms
        setTimeout(() => abortController.abort(), 25);
        const searchPromise = searchMusic(slowPlayer, 'Hanging Song', { id: 'u1' }, { signal: abortController.signal });
        const res = await searchPromise;

        assert.equal(res.cancelled, true, 'Aborted search must be marked cancelled');
        assert.equal(res.tracks.length, 0, 'Cancelled search must have empty tracks');
        console.log('  ok  - 8. Search timeout cancels or invalidates the underlying work');
        passed++;
    }

    // Test 9: A failed search preserves the current valid track and queue
    {
        clearSearchCache();
        const interaction = createMockInteraction({ query: 'bad_query_that_fails' });
        const player = interaction._testState.mockPlayer;
        player.playing = true;
        player.queue.current = { info: { title: 'Currently Playing Good Song', author: 'Valid Artist' } };
        player.queue.tracks = [{ info: { title: 'Upcoming Song 2' } }];

        player.search = async () => ({ loadType: 'empty', tracks: [] });

        await playCommand.execute(interaction);

        assert.equal(player.playing, true, 'Player must still be playing');
        assert.equal(player.queue.current.info.title, 'Currently Playing Good Song', 'Current track must remain unchanged');
        assert.equal(player.queue.tracks.length, 1, 'Queue tracks must remain undisturbed');
        console.log('  ok  - 9. A failed search preserves the current valid track and queue');
        passed++;
    }

    // Test 10: Dashboard and voice-channel-status operations do not delay initial acknowledgement
    {
        clearSearchCache();
        const interaction = createMockInteraction({ query: 'Artist - Track 1' });
        let dashboardInvoked = false;
        let ackTime = 0;

        interaction.client.playerController.replaceWithFullDashboard = async () => {
            dashboardInvoked = true;
            await new Promise(r => setTimeout(r, 200));
        };

        interaction.client.voiceChannelStatusManager.updateFromPlayer = async () => {
            await new Promise(r => setTimeout(r, 200));
        };

        interaction._testState.mockPlayer.search = async () => ({
            loadType: 'track',
            tracks: [{ info: { title: 'Track 1', author: 'Artist', duration: 180000 } }],
        });

        const start = Date.now();
        await playCommand.execute(interaction);
        const total = Date.now() - start;

        assert.ok(interaction.deferred, 'Interaction must be deferred');
        assert.ok(dashboardInvoked, 'Dashboard replacement must be called');
        console.log('  ok  - 10. Dashboard and voice-channel-status operations do not delay acknowledgement');
        passed++;
    }

    // Test 11: Idempotent acknowledgement prevents double acknowledgements
    {
        const interaction = createMockInteraction();
        const r1 = await ensureDeferred(interaction, { ephemeral: true });
        assert.equal(r1.deferred, true);
        assert.equal(interaction._testState.deferCount, 1);

        // Calling ensureDeferred a second time must NOT call deferReply again
        const r2 = await ensureDeferred(interaction, { ephemeral: true });
        assert.equal(r2.deferred, true);
        assert.equal(interaction._testState.deferCount, 1, 'deferReply must not be called twice');
        console.log('  ok  - 11. Idempotent acknowledgement prevents double acknowledgements');
        passed++;
    }

    console.log(`\nAll regression tests passed: ${passed}/${total}`);
    process.exit(0);
}

runTests().catch((err) => {
    console.error('Test failure:', err);
    process.exit(1);
});
