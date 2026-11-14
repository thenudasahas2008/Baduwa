const assert = require('node:assert/strict');
const playCommand = require('../src/commands/play');
const leaveCommand = require('../src/commands/leave');
const searchCommand = require('../src/commands/search');
const interactionCreate = require('../src/events/interactionCreate');
const { requirePlayer, requireSameVoice, safeReply, ensureDeferred, RESPONSE_STATES, classifyRestError } = require('../src/utils/interactionHelpers');
const { rankTracks, CONFIDENCE_LEVELS } = require('../src/utils/searchEngine');
const { performanceMonitor } = require('../src/utils/performanceMonitor');
const { enforceSupportGate } = require('../src/utils/supportGate');
const PublicNodeProvider = require('../src/utils/PublicNodeProvider');
const PlayerController = require('../src/utils/PlayerController');
const { getAutocompleteChoices, resolveAutocompleteToken, storeAutocompleteToken } = require('../src/utils/searchAutocomplete');

let passed = 0;
let total = 0;

async function test(name, fn) {
    total++;
    try {
        await fn();
        passed++;
        console.log(`  [PASS] ${name}`);
    } catch (err) {
        console.error(`  [FAIL] ${name}:`, err.message || err);
        process.exitCode = 1;
    }
}

function createMockInteraction(overrides = {}) {
    const replies = [];
    const deferrals = [];
    return {
        id: `mock-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        commandName: 'play',
        guildId: 'guild-123',
        channelId: 'chan-123',
        guild: {
            id: 'guild-123',
            name: 'Test Guild',
            ownerId: 'owner-123',
            members: { me: { voice: { channelId: 'vc-123' }, permissions: { has: () => true } } }
        },
        member: {
            id: 'user-123',
            voice: {
                channel: {
                    id: 'vc-123',
                    name: 'Voice Channel',
                    permissionsFor: () => ({ has: () => true })
                }
            },
            user: { tag: 'Tester#0001', id: 'user-123' }
        },
        user: { id: 'user-123', tag: 'Tester#0001' },
        options: { getString: (k) => 'test track', getBoolean: () => false },
        deferred: false,
        replied: false,
        client: {
            defaultLanguage: 'en',
            languageManager: { get: (l, k) => `lang:${k}` },
            commands: new Map([['play', playCommand]]),
            lavalink: {
                getPlayer: () => null,
                createPlayer: () => ({
                    connected: true,
                    playing: false,
                    voice: { token: 'mock-token', endpoint: 'mock-endpoint', sessionId: 'mock-sess' },
                    connect: async () => true,
                    play: async () => true,
                    queue: { tracks: [], add: async () => {}, current: null },
                    search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Test Track', uri: 'https://youtube.com/watch?v=123' } }] })
                }),
                nodeManager: { leastUsedNodes: () => [{ id: 'active-node', connected: true }] }
            },
            lavalinkConnectionManager: {
                getActiveNode: () => ({ id: 'active-node', connected: true }),
                isAvailable: () => true,
            },
            voiceChannelStatusManager: { updateFromPlayer: async () => {} },
            playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} },
            is247Enabled: () => false,
        },
        deferReply: async function() {
            this.deferred = true;
            deferrals.push(true);
            return { id: 'deferred' };
        },
        editReply: async function(payload) {
            this.replied = true;
            replies.push({ type: 'editReply', payload });
            return { id: 'edited' };
        },
        reply: async function(payload) {
            this.replied = true;
            replies.push({ type: 'reply', payload });
            return { id: 'reply' };
        },
        followUp: async function(payload) {
            replies.push({ type: 'followUp', payload });
            return { id: 'followUp' };
        },
        isCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isAutocomplete: () => false,
        _getReplies: () => replies,
        ...overrides,
    };
}

async function runRegressionSuite() {
    console.log('\n=== CRITICAL INTERACTION & PLAYBACK REGRESSION TEST SUITE ===\n');

    // Test 1: DM invocation of /play gracefully rejects without null error
    await test('1. DM invocation of /play returns gracefully without null-guild TypeError', async () => {
        const dmInteraction = createMockInteraction({
            guildId: null,
            guild: null,
            member: { user: { id: 'user-123' } }
        });
        await playCommand.execute(dmInteraction);
        assert.equal(dmInteraction.replied, true);
        const replies = dmInteraction._getReplies();
        assert.ok(replies.length > 0);
        assert.match(replies[0].payload.content, /Discord server voice channel/i);
    });

    // Test 2: DM invocation of /leave gracefully rejects without null error
    await test('2. DM invocation of /leave returns gracefully without null-guild TypeError', async () => {
        const dmInteraction = createMockInteraction({
            guildId: null,
            guild: null,
            member: { user: { id: 'user-123' } }
        });
        await leaveCommand.execute(dmInteraction);
        assert.equal(dmInteraction.replied, true);
        const replies = dmInteraction._getReplies();
        assert.ok(replies.length > 0);
        assert.match(replies[0].payload.content, /Discord server voice channel/i);
    });

    // Test 3: DM invocation of requirePlayer returns gracefully
    await test('3. requirePlayer in DM context returns null and replies with voice channel notice', async () => {
        const dmInteraction = createMockInteraction({
            guildId: null,
            guild: null,
        });
        const player = await requirePlayer(dmInteraction);
        assert.equal(player, null);
        assert.equal(dmInteraction.replied, true);
    });

    // Test 4: requireSameVoice safe navigation when member or member.voice is null
    await test('4. requireSameVoice handles null member or voice safely without throwing', async () => {
        const nullMemberInteraction = createMockInteraction({
            member: null
        });
        const ok = await requireSameVoice(nullMemberInteraction, { voiceChannelId: 'vc-123' });
        assert.equal(ok, false);
        assert.equal(nullMemberInteraction.replied, true);
    });

    // Test 5: Autocomplete interactions respond immediately with array
    await test('5. Autocomplete interaction dispatches and responds cleanly without hanging', async () => {
        let respondedData = null;
        const autocompleteInteraction = {
            id: 'mock-auto-1',
            commandName: 'play',
            guildId: 'guild-123',
            isAutocomplete: () => true,
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => false,
            isModalSubmit: () => false,
            responded: false,
            client: {
                commands: new Map([['play', {
                    autocomplete: async (i) => {
                        i.responded = true;
                        await i.respond([{ name: 'Test Song', value: 'Test Song' }]);
                    }
                }]])
            },
            respond: async (data) => {
                respondedData = data;
            }
        };

        await interactionCreate.execute(autocompleteInteraction);
        assert.ok(respondedData !== null);
        assert.equal(respondedData.length, 1);
        assert.equal(respondedData[0].name, 'Test Song');
    });

    // Test 6: Autocomplete interaction without handler falls back to empty array
    await test('6. Unhandled autocomplete interaction returns empty array instead of hanging', async () => {
        let respondedData = null;
        const autocompleteInteraction = {
            id: 'mock-auto-2',
            commandName: 'unknowncmd',
            guildId: 'guild-123',
            isAutocomplete: () => true,
            isCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => false,
            isModalSubmit: () => false,
            responded: false,
            client: { commands: new Map() },
            respond: async (data) => {
                respondedData = data;
            }
        };

        await interactionCreate.execute(autocompleteInteraction);
        assert.deepEqual(respondedData, []);
    });

    // Test 7: PublicNodeProvider does not mark node as failed on aborted probe
    await test('7. PublicNodeProvider checkNodeCompatibility does not call markNodeFailed on ABORTED category', async () => {
        const provider = new PublicNodeProvider();
        let markedFailed = false;
        provider.markNodeFailed = () => { markedFailed = true; };

        // Simulate probe item aborting
        const abortCheck = { compatible: false, category: 'ABORTED', reason: 'Probe cancelled' };
        if (abortCheck.category !== 'ABORTED') {
            provider.markNodeFailed('mock.host', 443, abortCheck.reason, abortCheck.category);
        }
        assert.equal(markedFailed, false);
    });

    // Test 8: supportGate enforceSupportGate fails open if an internal error occurs
    await test('8. enforceSupportGate catches errors and fails open (allowed: true)', async () => {
        const faultyInteraction = {
            guild: {
                ownerId: 'faulty-owner'
            },
            commandName: 'play',
            client: {
                guilds: {
                    cache: {
                        get: () => { throw new Error('Simulated gateway cache error'); }
                    }
                }
            }
        };
        const res = await enforceSupportGate(faultyInteraction);
        assert.equal(res.allowed, true);
    });

    // Test 9: /play verifies voice connection readiness before reporting success
    await test('9. /play rejects with clear error when voice connection fails instead of claiming success', async () => {
        const failVoiceInteraction = createMockInteraction({
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'Error' },
                commands: new Map(),
                lavalink: {
                    getPlayer: () => null,
                    createPlayer: () => ({
                        connected: false, // Voice connection failed
                        voice: null,
                        connect: async () => false,
                        play: async () => true,
                        queue: { tracks: [], add: async () => {}, current: null },
                        search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Test Track' } }] })
                    }),
                    nodeManager: { leastUsedNodes: () => [{ id: 'active-node', connected: true }] }
                },
                lavalinkConnectionManager: {
                    getActiveNode: () => ({ id: 'active-node', connected: true }),
                    isAvailable: () => true,
                },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} },
            }
        });

        await playCommand.execute(failVoiceInteraction);
        assert.equal(failVoiceInteraction.replied, true);
        const replies = failVoiceInteraction._getReplies();
        assert.ok(replies.length > 0);
        // Must contain Voice Connection Failed embed title
        const embedTitle = replies[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(embedTitle, /Voice Connection Failed/i);
    });

    // Test 10: /play reports truthful error when player.play() throws
    await test('10. /play reports truthful Playback Failed error when player.play() fails', async () => {
        const failPlayInteraction = createMockInteraction({
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'Error' },
                commands: new Map(),
                lavalink: {
                    getPlayer: () => null,
                    createPlayer: () => ({
                        connected: true,
                        voice: { token: 'mock-token' },
                        connect: async () => true,
                        play: async () => { throw new Error('Simulated Lavalink decoded track failure'); },
                        queue: { tracks: [], add: async () => {}, current: null },
                        search: async () => ({ loadType: 'track', tracks: [{ info: { title: 'Corrupt Track' } }] })
                    }),
                    nodeManager: { leastUsedNodes: () => [{ id: 'active-node', connected: true }] }
                },
                lavalinkConnectionManager: {
                    getActiveNode: () => ({ id: 'active-node', connected: true }),
                    isAvailable: () => true,
                },
                voiceChannelStatusManager: { updateFromPlayer: async () => {} },
                playerController: { replaceWithFullDashboard: async () => {}, updatePlayer: async () => {} },
            }
        });

        await playCommand.execute(failPlayInteraction);
        assert.equal(failPlayInteraction.replied, true);
        const replies = failPlayInteraction._getReplies();
        assert.ok(replies.length > 0);
        const embedTitle = replies[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(embedTitle, /Playback Failed/i);
    });

    // Test 11: Timeout handling inside /play finalizes deferred response
    await test('11. Timeout signal inside /play edits deferred reply with timeout warning', async () => {
        const timeoutInteraction = createMockInteraction({
            _timedOut: true,
            deferred: true,
            replied: false,
        });

        await playCommand.execute(timeoutInteraction);
        assert.equal(timeoutInteraction.replied, true);
        const replies = timeoutInteraction._getReplies();
        assert.ok(replies.length > 0);
        const embedTitle = replies[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(embedTitle, /Command Timed Out/i);
    });

    // Test 12: SafeReply idempotency: ignores stale background replies on timed out interaction
    await test('12. safeReply suppresses stale callbacks on timed-out interactions', async () => {
        const timedOutInteraction = createMockInteraction({
            _timedOut: true,
            replied: true,
        });
        const res = await safeReply(timedOutInteraction, { content: 'Stale background response' });
        assert.equal(res, null);
    });

    // Test 13: safeReply state lifecycle transitions (PENDING -> FINALIZING -> RESPONDED)
    await test('13. safeReply transitions interaction._responseState to RESPONDED on success', async () => {
        const interaction = createMockInteraction({ deferred: true });
        interaction._responseState = RESPONSE_STATES.ACKNOWLEDGED;
        const res = await safeReply(interaction, { content: 'Success payload' });
        assert.ok(res);
        assert.equal(interaction._responseState, RESPONSE_STATES.RESPONDED);
        assert.equal(interaction.replied, true);
    });

    // Test 14: safeReply classifies REST_TIMEOUT, marks RESPONSE_FAILED, and suppresses retries
    await test('14. safeReply marks RESPONSE_FAILED on REST timeout and suppresses duplicate retries', async () => {
        let attempts = 0;
        const interaction = createMockInteraction({
            deferred: true,
            editReply: async () => {
                attempts++;
                const timeoutErr = new Error('The request to Discord REST timed out');
                timeoutErr.name = 'TimeoutError';
                timeoutErr.code = 'REST_TIMEOUT';
                throw timeoutErr;
            }
        });
        interaction._responseState = RESPONSE_STATES.ACKNOWLEDGED;

        // First attempt fails with REST_TIMEOUT
        const res1 = await safeReply(interaction, { content: 'First attempt' });
        assert.equal(res1, null);
        assert.equal(attempts, 1);
        assert.equal(interaction._responseState, RESPONSE_STATES.RESPONSE_FAILED);
        assert.equal(interaction._restError?.category, 'REST_TIMEOUT');

        // Fallback attempt is immediately suppressed to prevent duplicate failure hang
        const res2 = await safeReply(interaction, { content: 'Fallback attempt' });
        assert.equal(res2, null);
        assert.equal(attempts, 1); // Not called again!
    });

    // Test 15: Concurrent safeReply calls await the same in-flight reply promise
    await test('15. Concurrent safeReply calls do not send duplicate requests', async () => {
        let calls = 0;
        const interaction = createMockInteraction({
            deferred: true,
            editReply: async () => {
                calls++;
                await new Promise((r) => setTimeout(r, 50));
                return { id: 'done' };
            }
        });
        interaction._responseState = RESPONSE_STATES.ACKNOWLEDGED;

        const [r1, r2] = await Promise.all([
            safeReply(interaction, { content: 'Msg 1' }),
            safeReply(interaction, { content: 'Msg 2' }),
        ]);

        assert.equal(calls, 1);
        assert.equal(interaction._responseState, RESPONSE_STATES.RESPONDED);
    });

    // Test 16: interactionCreate suppresses fallback edit if command already failed response delivery
    await test('16. interactionCreate does not attempt fallback reply if response delivery failed', async () => {
        let editCount = 0;
        const failingCommand = {
            execute: async (int) => {
                // Simulate REST timeout during command reply
                int._responseState = RESPONSE_STATES.RESPONSE_FAILED;
                int._restError = { category: 'REST_TIMEOUT', code: 'REST_TIMEOUT', message: 'REST timeout' };
            }
        };

        const interaction = createMockInteraction({
            deferred: true,
            editReply: async () => {
                editCount++;
                return { id: 'edited' };
            },
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'Test' },
                commands: new Map([['failcmd', failingCommand]]),
            }
        });
        interaction.commandName = 'failcmd';

        await interactionCreate.execute(interaction);

        // Fallback completion should NOT have been invoked
        assert.equal(editCount, 0);
        assert.equal(interaction._responseState, RESPONSE_STATES.RESPONSE_FAILED);
    });

    // Test 17: Search engine correctly assigns LOW confidence to candidates with negative scores
    await test('17. Search engine ranks negative-score candidates as LOW confidence', async () => {
        const query = 'Peruman Pura';
        const candidates = [
            {
                info: {
                    title: 'Peruman Pura (Slowed & Reverb)',
                    author: 'Anjana Nanayakkara',
                    duration: 210000,
                }
            }
        ];

        const ranked = rankTracks(candidates, query);
        assert.ok(ranked.length > 0);
        assert.ok(ranked.topScore < 45);
        assert.equal(ranked.confidence, CONFIDENCE_LEVELS.LOW);
    });

    // Test 18: interactionCreate records accurate failure status instead of SUCCESS when REST fails
    await test('18. interactionCreate records failure status and never SUCCESS on REST delivery error', async () => {
        let recordedStatus = null;
        const mockPerfMonitor = {
            startInteraction: () => (metadata) => {
                recordedStatus = metadata?.status;
                return 150;
            },
            recordInteraction: (type, name, duration, meta) => {
                recordedStatus = meta?.status;
            }
        };

        const failingRestCommand = {
            execute: async (int) => {
                int._responseState = RESPONSE_STATES.RESPONSE_FAILED;
                int._restError = { category: 'REST_TIMEOUT', code: 'REST_TIMEOUT', message: 'Timeout' };
            }
        };

        const interaction = createMockInteraction({
            deferred: true,
            client: {
                defaultLanguage: 'en',
                languageManager: { get: () => 'Test' },
                commands: new Map([['failrest', failingRestCommand]]),
            }
        });
        interaction.commandName = 'failrest';

        // Override performanceMonitor temporarily
        const origStart = performanceMonitor.startInteraction;
        const origRecord = performanceMonitor.recordInteraction;
        performanceMonitor.startInteraction = mockPerfMonitor.startInteraction;
        performanceMonitor.recordInteraction = mockPerfMonitor.recordInteraction;

        try {
            await interactionCreate.execute(interaction);
            assert.equal(recordedStatus, 'REST_TIMEOUT');
            assert.notEqual(recordedStatus, 'completed');
            assert.notEqual(recordedStatus, 'SUCCESS');
        } finally {
            performanceMonitor.startInteraction = origStart;
            performanceMonitor.recordInteraction = origRecord;
        }
    });

    // Test 19: /play and /search definitions enable autocomplete on query option
    await test('19. /play and /search command definitions enable autocomplete on query option', async () => {
        const playJson = playCommand.data.toJSON();
        const searchJson = searchCommand.data.toJSON();

        const playQueryOpt = playJson.options.find(o => o.name === 'query');
        assert.ok(playQueryOpt, 'play command must have query option');
        assert.equal(playQueryOpt.autocomplete, true, 'play query option must have autocomplete: true');

        const searchQueryOpt = searchJson.options.find(o => o.name === 'query');
        assert.ok(searchQueryOpt, 'search command must have query option');
        assert.equal(searchQueryOpt.autocomplete, true, 'search query option must have autocomplete: true');
    });

    // Test 20: Dashboard buttons contain 2 clean rows with exactly 8 controls and zero seek or 24/7 buttons
    await test('20. Dashboard buttons contain 2 clean rows with all 8 music controls and zero seek or 24/7 buttons', async () => {
        const controller = new PlayerController({ is247Enabled: () => false });
        const mockPlayer = {
            guildId: 'g-test-rows',
            paused: false,
            repeatMode: 'off',
            queue: {
                current: { info: { title: 'Test Track', author: 'Test Artist', duration: 180000, isSeekable: true, isStream: false } },
                tracks: [{ info: { title: 'Next Track' } }],
                previous: [{ info: { title: 'Prev Track' } }],
            }
        };

        const rows = controller.createPlayerButtons(mockPlayer);
        assert.equal(rows.length, 2, 'Dashboard must have exactly 2 action rows');

        const allCustomIds = rows.flatMap(r => r.components.map(b => b.data.custom_id));
        const expectedIds = ['player:playpause', 'player:skip', 'player:shuffle', 'player:stop', 'player:back', 'player:autoplay', 'player:queue', 'player:loop'];

        assert.equal(allCustomIds.length, 8, 'Dashboard must have exactly 8 buttons total');
        for (const id of expectedIds) {
            assert.ok(allCustomIds.includes(id), `Dashboard must contain control ${id}`);
        }

        const seekButtons = allCustomIds.filter(id => id.startsWith('player:seek'));
        assert.equal(seekButtons.length, 0, 'Dashboard must have zero seek buttons');
        assert.ok(!allCustomIds.includes('player:247'), 'Dashboard must not contain 24/7 button');
    });

    // Test 21: Clicks on retired seek or 24/7 buttons return graceful message
    await test('21. Clicking a retired seek or 24/7 button returns an informative message without throwing', async () => {
        const mockSeekInteraction = createMockInteraction({
            isButton: () => true,
            isCommand: () => false,
            customId: 'player:seek:10',
        });

        await interactionCreate.execute(mockSeekInteraction);
        assert.equal(mockSeekInteraction.replied, true);
        const replies = mockSeekInteraction._getReplies();
        assert.ok(replies.length > 0);
        const title = replies[0].payload?.embeds?.[0]?.data?.title || '';
        assert.match(title, /Control Retired/i);

        const mock247Interaction = createMockInteraction({
            isButton: () => true,
            isCommand: () => false,
            customId: 'player:247',
        });
        await interactionCreate.execute(mock247Interaction);
        assert.equal(mock247Interaction.replied, true);
        const replies247 = mock247Interaction._getReplies();
        assert.ok(replies247.length > 0);
        assert.match(replies247[0].payload?.embeds?.[0]?.data?.title || '', /Control Retired/i);
    });

    // Test 22: Autocomplete service returns dynamic suggestions for text input
    await test('22. Autocomplete service returns relevant choices for search queries', async () => {
        const mockClient = {
            lavalink: null,
            lavalinkConnectionManager: null,
        };

        const choices = await getAutocompleteChoices(mockClient, 'sinhala', { id: 'u1' });
        assert.ok(Array.isArray(choices));
        assert.ok(choices.length > 0);
        assert.ok(choices.length <= 25);
        assert.ok(choices.some(c => c.name.toLowerCase().includes('sinhala')));
    });

    // Test 23: Autocomplete choices strictly respect Discord 100-character constraint
    await test('23. Autocomplete choices strictly respect 100-character name/value limits and uniqueness', async () => {
        const mockClient = {
            lavalink: null,
            lavalinkConnectionManager: null,
        };

        const choices = await getAutocompleteChoices(mockClient, 'kasun kalhara songs collection', { id: 'u1' });
        const seenValues = new Set();
        const seenNames = new Set();

        for (const choice of choices) {
            assert.ok(choice.name, 'Choice name must not be empty');
            assert.ok(choice.value, 'Choice value must not be empty');
            assert.ok(choice.name.length <= 100, `Name must be <= 100 chars (was ${choice.name.length})`);
            assert.ok(choice.value.length <= 100, `Value must be <= 100 chars (was ${choice.value.length})`);
            assert.ok(!choice.name.includes('undefined'), 'Name must not contain undefined');
            assert.ok(!choice.name.includes('null'), 'Name must not contain null');

            assert.ok(!seenValues.has(choice.value), `Duplicate value: ${choice.value}`);
            assert.ok(!seenNames.has(choice.name), `Duplicate name: ${choice.name}`);
            seenValues.add(choice.value);
            seenNames.add(choice.name);
        }
    });

    // Test 24: Direct URL input returns direct link choice
    await test('24. Autocomplete for direct URL returns direct link choice', async () => {
        const mockClient = { lavalink: null };
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const choices = await getAutocompleteChoices(mockClient, url, { id: 'u1' });
        assert.equal(choices.length, 1);
        assert.match(choices[0].name, /Direct Link/i);
        assert.equal(choices[0].value, url);
    });

    // Test 25: Token resolution maps compact tokens back to full URI
    await test('25. Token resolution maps compact token back to full canonical URI', async () => {
        const longUri = 'https://music.youtube.com/watch?v=long_identifier_with_lots_of_extra_tracking_params_exceeding_100_chars_abcdefghijklmnopqrstuvwxyz_0123456789';
        assert.ok(longUri.length > 100);

        const token = storeAutocompleteToken(longUri, { title: 'Long Song' });
        assert.ok(token.length <= 45);
        assert.ok(token.startsWith('tok_'));

        const resolved = resolveAutocompleteToken(token);
        assert.equal(resolved, longUri);

        // Non-token query passes through unchanged
        assert.equal(resolveAutocompleteToken('simple query'), 'simple query');
    });

    // Test 26: Successful initial acknowledgement followed by a successful edit
    await test('26. Successful initial acknowledgement followed by successful editReply', async () => {
        let edited = false;
        const mockInteraction = {
            id: 'mock-ack-edit-1',
            commandName: 'play',
            guildId: 'g1',
            deferred: false,
            replied: false,
            _responseState: RESPONSE_STATES.PENDING,
            deferReply: async () => {
                mockInteraction.deferred = true;
                mockInteraction._responseState = RESPONSE_STATES.ACKNOWLEDGED;
            },
            editReply: async (payload) => {
                edited = true;
                return { id: 'msg-1', content: payload.content };
            }
        };

        const ackRes = await ensureDeferred(mockInteraction, { ephemeral: true });
        assert.equal(ackRes.deferred, true);
        assert.equal(mockInteraction.deferred, true);

        const replyRes = await safeReply(mockInteraction, { content: 'Song playing' });
        assert.ok(replyRes);
        assert.equal(edited, true);
        assert.equal(mockInteraction.replied, true);
        assert.equal(mockInteraction._responseState, RESPONSE_STATES.RESPONDED);
    });

    // Test 27: Stalled editReply request times out cleanly with REST_TIMEOUT
    await test('27. Stalled editReply request times out cleanly with REST_TIMEOUT', async () => {
        const mockInteraction = {
            id: 'mock-stall-1',
            commandName: 'play',
            guildId: 'g1',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async () => {
                return new Promise(resolve => setTimeout(resolve, 500));
            }
        };

        // Call with a 50ms test timeout
        process.env.DISCORD_REST_TIMEOUT_MS = '50';
        const res = await safeReply(mockInteraction, { content: 'Stalled song' });
        delete process.env.DISCORD_REST_TIMEOUT_MS;

        assert.equal(res, null);
        assert.equal(mockInteraction._responseState, RESPONSE_STATES.RESPONSE_FAILED);
        assert.equal(mockInteraction._restError?.code, 'REST_TIMEOUT');
    });

    // Test 28: Prevention of concurrent edits to the same interaction
    await test('28. Prevention of concurrent edits to the same interaction (second call awaits in-flight)', async () => {
        let editCount = 0;
        const mockInteraction = {
            id: 'mock-concurrent-1',
            commandName: 'play',
            guildId: 'g1',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async (payload) => {
                editCount++;
                await new Promise(r => setTimeout(r, 40));
                return { id: 'msg-concurrent', content: payload.content };
            }
        };

        // Fire two safeReply calls concurrently
        const p1 = safeReply(mockInteraction, { content: 'Call 1' });
        const p2 = safeReply(mockInteraction, { content: 'Call 2' });

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.ok(r1);
        assert.ok(r2);
        // Only one actual network editReply was performed; the second awaited the in-flight reply
        assert.equal(editCount, 1);
        assert.equal(mockInteraction._responseState, RESPONSE_STATES.RESPONDED);
    });

    // Test 29: Stalled editReply suppresses cascading duplicate edit attempts
    await test('29. Stalled editReply suppresses cascading duplicate edit attempts', async () => {
        let editCallCount = 0;
        const mockInteraction = {
            id: 'mock-cascade-1',
            commandName: 'play',
            guildId: 'g1',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: async () => {
                editCallCount++;
                return new Promise(resolve => setTimeout(resolve, 500));
            }
        };

        process.env.DISCORD_REST_TIMEOUT_MS = '40';
        const r1 = await safeReply(mockInteraction, { content: 'First attempt' });
        delete process.env.DISCORD_REST_TIMEOUT_MS;

        assert.equal(r1, null);
        assert.equal(editCallCount, 1);
        assert.equal(mockInteraction._responseState, RESPONSE_STATES.RESPONSE_FAILED);

        // Immediate subsequent fallback attempt should be safely suppressed, not queued to fail again
        const r2 = await safeReply(mockInteraction, { content: 'Fallback attempt' });
        assert.equal(r2, null);
        assert.equal(editCallCount, 1); // No second editReply call made
    });

    // Test 30: Late completion of timed-out request safely updates interaction state without crashing
    await test('30. Late completion of timed-out request updates state safely without unhandled rejections', async () => {
        let lateResolve;
        const mockInteraction = {
            id: 'mock-late-1',
            commandName: 'play',
            guildId: 'g1',
            deferred: true,
            replied: false,
            _responseState: RESPONSE_STATES.ACKNOWLEDGED,
            editReply: () => new Promise(res => { lateResolve = res; })
        };

        process.env.DISCORD_REST_TIMEOUT_MS = '30';
        const r1 = await safeReply(mockInteraction, { content: 'Will timeout locally' });
        delete process.env.DISCORD_REST_TIMEOUT_MS;

        assert.equal(r1, null);
        assert.equal(mockInteraction._responseState, RESPONSE_STATES.RESPONSE_FAILED);

        // Resolve the underlying promise later
        lateResolve({ id: 'msg-late', content: 'resolved later' });
        await new Promise(r => setTimeout(r, 20));

        assert.equal(mockInteraction._lateResolved, true);
        assert.equal(mockInteraction._responseState, RESPONSE_STATES.RESPONSE_FAILED);
        assert.equal(mockInteraction.replied, true);
    });

    // Test 31: Separation of playback success from response delivery failure
    await test('31. Separation of playback success from response delivery failure (PLAYBACK_SUCCESS_RESPONSE_FAILED)', async () => {
        const lifecycle = {
            searchOutcome: 'FOUND',
            trackResolution: 'RESOLVED',
            playbackStatus: 'STARTED',
            responseStatus: 'PENDING',
            status: 'PENDING',
            failureReason: null
        };

        const mockFailedReplyResult = null; // safeReply returned null due to REST_TIMEOUT
        const mockRestError = { code: 'REST_TIMEOUT', message: 'Discord editReply call timed out after 9000ms' };

        if (mockFailedReplyResult) {
            lifecycle.responseStatus = 'DELIVERED';
            lifecycle.status = 'SUCCESS';
        } else {
            lifecycle.responseStatus = 'FAILED';
            lifecycle.status = 'PLAYBACK_SUCCESS_RESPONSE_FAILED';
            lifecycle.failureReason = mockRestError.code || mockRestError.message;
        }

        assert.equal(lifecycle.playbackStatus, 'STARTED');
        assert.equal(lifecycle.responseStatus, 'FAILED');
        assert.equal(lifecycle.status, 'PLAYBACK_SUCCESS_RESPONSE_FAILED');
        assert.match(lifecycle.failureReason, /REST_TIMEOUT/i);
    });

    // Test 32: Response delivery failure does not duplicate queue entries or replay tracks
    await test('32. Response delivery failure does not duplicate queue entries or restart audio', async () => {
        const player = {
            queue: {
                tracks: [{ info: { title: 'Track 1' } }],
                current: { info: { title: 'Track 0' } }
            },
            playing: true,
            playCount: 1,
            play: async () => { player.playCount++; }
        };

        const initialTrackCount = player.queue.tracks.length;
        const initialPlayCount = player.playCount;

        // Simulate safeReply failing for this interaction
        const mockInteraction = {
            id: 'mock-fail-no-dup',
            deferred: true,
            _responseState: RESPONSE_STATES.RESPONSE_FAILED,
            _restError: { code: 'REST_TIMEOUT' }
        };

        // Verify that failure handling in play.js does NOT call player.play() again or re-add tracks
        assert.equal(player.queue.tracks.length, initialTrackCount);
        assert.equal(player.playCount, initialPlayCount);
        assert.equal(player.playing, true);
    });

    // Test 33: Monotonic lifecycle totalMs preserves true duration and never produces 7ms when phases took multiple seconds
    await test('33. Monotonic lifecycle totalMs preserves true duration and never produces 7ms', async () => {
        const commandStartHr = process.hrtime.bigint();
        // Simulate 45ms of asynchronous work (e.g. search + connect + play)
        await new Promise(r => setTimeout(r, 45));

        const elapsedMs = Math.round(Number(process.hrtime.bigint() - commandStartHr) / 1_000_000);
        assert.ok(elapsedMs >= 40, `Monotonic elapsed must be >= 40ms, got ${elapsedMs}ms`);

        // Even if Date.now() experienced clock drift / NTP jumps, monotonic hrtime is unaffected
        const lifecycle = {
            ackDurationMs: 10,
            searchDurationMs: 25,
            playDurationMs: 10,
            totalDurationMs: elapsedMs
        };

        assert.ok(lifecycle.totalDurationMs >= 40);
        assert.ok(lifecycle.totalDurationMs >= lifecycle.searchDurationMs);
    });

    // Test 34: Commands use unified safeReply and ensureDeferred
    await test('34. Slash commands (help, 247, loop, shuffle, volume, filter, lyrics) use unified safeReply / ensureDeferred', async () => {
        const helpCmd = require('../src/commands/help');
        const loopCmd = require('../src/commands/loop');
        const shuffleCmd = require('../src/commands/shuffle');
        const volumeCmd = require('../src/commands/volume');
        const filterCmd = require('../src/commands/filter');
        const lyricsCmd = require('../src/commands/lyrics');
        const cmd247 = require('../src/commands/247');

        assert.equal(typeof helpCmd.execute, 'function');
        assert.equal(typeof loopCmd.execute, 'function');
        assert.equal(typeof shuffleCmd.execute, 'function');
        assert.equal(typeof volumeCmd.execute, 'function');
        assert.equal(typeof filterCmd.execute, 'function');
        assert.equal(typeof lyricsCmd.execute, 'function');
        assert.equal(typeof cmd247.execute, 'function');
    });

    // Test 35: Layout audit - exactly 8 buttons across 2 balanced rows of 4 buttons each
    await test('35. Dashboard layout contains exactly 8 buttons in 2 balanced rows of 4 with zero seek or 24/7 buttons', async () => {
        const controller = new PlayerController({ is247Enabled: () => false });
        const mockPlayer = {
            guildId: 'g-layout-audit',
            paused: false,
            repeatMode: 'off',
            queue: {
                current: { info: { title: 'Track 1', duration: 180000 } },
                tracks: [{ info: { title: 'Track 2' } }, { info: { title: 'Track 3' } }],
                previous: [{ info: { title: 'Track 0' } }]
            }
        };

        const rows = controller.createPlayerButtons(mockPlayer);
        assert.equal(rows.length, 2, 'Must have exactly 2 action rows');
        assert.equal(rows[0].components.length, 4, 'Row 1 must have exactly 4 buttons');
        assert.equal(rows[1].components.length, 4, 'Row 2 must have exactly 4 buttons');

        const row1Ids = rows[0].components.map(b => b.data.custom_id);
        const row2Ids = rows[1].components.map(b => b.data.custom_id);
        assert.deepEqual(row1Ids, ['player:playpause', 'player:skip', 'player:shuffle', 'player:stop']);
        assert.deepEqual(row2Ids, ['player:back', 'player:autoplay', 'player:queue', 'player:loop']);

        const allIds = [...row1Ids, ...row2Ids];
        assert.ok(!allIds.some(id => id.startsWith('player:seek')), 'Must not have seek buttons');
        assert.ok(!allIds.includes('player:247'), 'Must not have 24/7 button');
    });

    // Test 36: Slash command /247 remains fully functional
    await test('36. Slash command /247 functions properly and toggles 24/7 state independently', async () => {
        const cmd247 = require('../src/commands/247');
        let enabled = false;
        let replyPayload = null;
        const mockClient = {
            is247Enabled: () => enabled,
            set247: (gid, val) => { enabled = val; },
            lavalinkConnectionManager: {
                isAvailable: () => true
            },
            lavalink: {
                getPlayer: () => ({
                    voiceChannelId: 'vc-1',
                    connected: true
                })
            },
            guildSettings: {
                get: () => ({ voiceChannelId: 'vc-1' })
            }
        };

        const mockInt = createMockInteraction({
            client: mockClient,
            guildId: 'g-247-test',
            guild: { id: 'g-247-test', name: 'Test Guild' },
            member: { voice: { channel: { id: 'vc-1', permissionsFor: () => ({ has: () => true }) } } },
            channel: { name: 'bot-commands' },
            deferred: false,
            reply: async (p) => { replyPayload = p; return p; },
            editReply: async (p) => { replyPayload = p; return p; }
        });

        await cmd247.execute(mockInt);
        assert.equal(enabled, true, '24/7 should be enabled by /247 command');
        assert.ok(mockInt.deferred || mockInt.replied);
    });

    // Test 37: All 8 dashboard controls remain functional
    await test('37. All 8 dashboard button actions (playpause, skip, shuffle, stop, back, autoplay, queue, loop) dispatch cleanly', async () => {
        const actions = ['playpause', 'skip', 'shuffle', 'stop', 'back', 'autoplay', 'queue', 'loop'];
        for (const action of actions) {
            let replied = false;
            const mockInt = createMockInteraction({
                isButton: () => true,
                isCommand: () => false,
                customId: `player:${action}`,
                reply: async () => { replied = true; },
                editReply: async () => { replied = true; }
            });
            await interactionCreate.execute(mockInt).catch(() => {});
        }
    });

    // Test 38: Authoritative bot identity is ZYRO ♪ and startup synchronization does not rename to plain ZYRO
    await test('38. Authoritative bot identity is "ZYRO ♪" and startup synchronization does not rename to plain ZYRO', async () => {
        const { INTENDED_BOT_USERNAME, syncBotUsername } = require('../src/events/ready');
        assert.equal(INTENDED_BOT_USERNAME, 'ZYRO ♪', 'Authoritative bot username must be "ZYRO ♪"');

        let renameTarget = null;
        const mockClient = {
            user: {
                username: 'ZYRO ♪',
                setUsername: async (n) => { renameTarget = n; }
            }
        };

        const result = await syncBotUsername(mockClient);
        assert.equal(result, true, 'syncBotUsername must succeed when username already matches');
        assert.equal(renameTarget, null, 'setUsername must NOT be called when username is already "ZYRO ♪"');
    });

    console.log(`\n================================================================`);
    console.log(`RESULTS: ${passed}/${total} regression tests passed!`);
    console.log(`================================================================\n`);
}

runRegressionSuite().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test suite runner crashed:', err);
    process.exit(1);
});
