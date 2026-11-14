// Test suite for ZYRO Master Performance Fix:
// 1. Concurrency of multiple rapid commands in same & cross guilds.
// 2. Lock timeout guard in PlayerController (runWithGuildLock).
// 3. In-flight membership check deduplication and cache resolution in supportGate.
// 4. Lavalink node requestTimeout default.
// 5. interactionCreate completion guarantee preventing stuck "Thinking..." states.
// 6. Fast local command auto-acknowledgement failsafe timer.
//
// Run: node scripts/test-performance-concurrency.js

const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const PlayerController = require('../src/utils/PlayerController');
const { checkOwnerMembership, inFlightMembershipChecks, invalidateOwner } = require('../src/utils/supportGate');
const { validateAndFormatNodeOption } = require('../src/utils/lavalinkNodeOptions');
const interactionCreate = require('../src/events/interactionCreate');

let passed = 0;
let total = 0;

async function test(name, fn) {
    total++;
    try {
        await fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err?.stack || err}`);
        process.exitCode = 1;
    }
}

function createMockInteraction(options = {}) {
    let deferred = false;
    let replied = false;
    let lastPayload = null;
    let lastMethod = null;

    return {
        id: options.id || `inter_${Math.random().toString(36).slice(2, 9)}`,
        commandName: options.commandName || 'testcmd',
        guildId: options.guildId || 'guild_001',
        guild: {
            id: options.guildId || 'guild_001',
            name: 'Test Guild',
            ownerId: options.ownerId || 'owner_001',
            members: { me: { voice: { channelId: 'vc_1' } } }
        },
        channel: { id: 'chan_001', name: 'music' },
        user: { id: options.userId || 'user_001', tag: 'Tester#0001' },
        member: {
            voice: { channel: { id: 'vc_1', permissionsFor: () => ({ has: () => true }) } },
            user: { tag: 'Tester#0001' }
        },
        options: {
            getString: () => 'test',
            getBoolean: () => false,
            getInteger: () => 50,
        },
        get deferred() { return deferred; },
        get replied() { return replied; },
        get lastPayload() { return lastPayload; },
        get lastMethod() { return lastMethod; },
        isCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        async deferReply(opts = {}) {
            if (deferred || replied) {
                const err = new Error('Interaction already acknowledged');
                err.code = 40060;
                throw err;
            }
            deferred = true;
            lastMethod = 'deferReply';
            return { id: 'msg_deferred' };
        },
        async editReply(payload) {
            replied = true;
            lastPayload = payload;
            lastMethod = 'editReply';
            return { id: 'msg_final', ...payload };
        },
        async reply(payload) {
            if (deferred || replied) {
                const err = new Error('Interaction already acknowledged');
                err.code = 40060;
                throw err;
            }
            replied = true;
            lastPayload = payload;
            lastMethod = 'reply';
            return { id: 'msg_direct', ...payload };
        }
    };
}

async function run() {
    console.log('--- Test 1: Guild Lock Concurrency and Timeout Guard ---');

    await test('runWithGuildLock protects concurrent execution in same guild', async () => {
        const controller = new PlayerController({});
        const order = [];

        const op1 = controller.runWithGuildLock('guild-A', async () => {
            await new Promise(r => setTimeout(r, 40));
            order.push('A1');
        });

        const op2 = controller.runWithGuildLock('guild-A', async () => {
            order.push('A2');
        });

        const op3 = controller.runWithGuildLock('guild-B', async () => {
            order.push('B1'); // Independent guild should run concurrently
        });

        await Promise.all([op1, op2, op3]);

        assert.equal(order.indexOf('A1') < order.indexOf('A2'), true, 'Operations on same guild must serialize');
        assert.equal(controller.guildLocks.has('guild-A'), false, 'Guild lock map must be cleaned up');
        assert.equal(controller.guildLocks.has('guild-B'), false, 'Guild lock map must be cleaned up');
    });

    await test('runWithGuildLock breaks deadlock if prior lock promise hangs', async () => {
        const controller = new PlayerController({});

        // Intentionally hang guild lock
        let releaseHanging;
        const hangingOp = controller.runWithGuildLock('guild-hang', () => {
            return new Promise((resolve) => {
                releaseHanging = resolve;
            });
        });

        // Second operation should not wait indefinitely; lock timeout is 2500ms
        const start = Date.now();
        let secondOpExecuted = false;

        const secondOp = controller.runWithGuildLock('guild-hang', async () => {
            secondOpExecuted = true;
        });

        // Clean up hanging op after 2700ms
        setTimeout(() => releaseHanging(), 2700);

        await secondOp;
        const elapsed = Date.now() - start;

        assert.equal(secondOpExecuted, true, 'Second op must execute even if first hung');
        assert.ok(elapsed >= 2400 && elapsed <= 3200, `Expected lock guard timeout around 2500ms, took ${elapsed}ms`);

        await hangingOp;
    });

    console.log('\n--- Test 2: Support Gate Deduplication and Cache ---');

    process.env.SUPPORT_GUILD_ID = 'support-guild-123';

    await test('checkOwnerMembership deduplicates concurrent in-flight checks for same owner', async () => {
        invalidateOwner('owner-dedup-1');

        let fetchCount = 0;
        const mockClient = {
            guilds: {
                cache: new Map([
                    ['support-guild-123', {
                        id: 'support-guild-123',
                        members: {
                            cache: new Map(),
                            fetch: async (uid) => {
                                fetchCount++;
                                await new Promise(r => setTimeout(r, 50));
                                return { id: uid };
                            }
                        }
                    }]
                ])
            }
        };

        const check1 = checkOwnerMembership(mockClient, 'owner-dedup-1');
        const check2 = checkOwnerMembership(mockClient, 'owner-dedup-1');
        const check3 = checkOwnerMembership(mockClient, 'owner-dedup-1');

        assert.equal(inFlightMembershipChecks.has('owner-dedup-1'), true, 'In-flight check must be tracked in map');

        const [r1, r2, r3] = await Promise.all([check1, check2, check3]);

        assert.equal(r1.isMember, true);
        assert.equal(r2.isMember, true);
        assert.equal(r3.isMember, true);
        assert.equal(fetchCount, 1, 'Concurrent checks must make only 1 network fetch');
        assert.equal(inFlightMembershipChecks.has('owner-dedup-1'), false, 'In-flight check must be cleared after resolution');
    });

    await test('checkOwnerMembership uses client member cache for 0ms resolution', async () => {
        invalidateOwner('cached-owner-99');

        let fetchCalled = false;
        const mockMember = { id: 'cached-owner-99' };
        const memberCache = new Map([['cached-owner-99', mockMember]]);

        const mockClient = {
            guilds: {
                cache: new Map([
                    ['support-guild-123', {
                        id: 'support-guild-123',
                        members: {
                            cache: memberCache,
                            fetch: async () => {
                                fetchCalled = true;
                                return mockMember;
                            }
                        }
                    }]
                ])
            }
        };

        const start = Date.now();
        const result = await checkOwnerMembership(mockClient, 'cached-owner-99');
        const elapsed = Date.now() - start;

        assert.equal(result.isMember, true);
        assert.equal(result.reason, 'VERIFIED_MEMBER');
        assert.equal(fetchCalled, false, 'Fetch must not be called when member is in cache');
        assert.ok(elapsed < 20, `Cache lookup should be instantaneous, took ${elapsed}ms`);
    });

    console.log('\n--- Test 3: Lavalink Node Options Fail-Fast Request Timeout ---');

    await test('validateAndFormatNodeOption injects requestTimeout = 7500 by default', () => {
        const option = {
            host: '127.0.0.1',
            port: 2333,
            authorization: 'youshallnotpass',
        };

        const validated = validateAndFormatNodeOption(option);
        assert.equal(validated.requestTimeout, 7500, 'Default requestTimeout should be 7500ms to fail fast');

        // Preserves custom timeout if explicitly configured
        const customOption = {
            host: '127.0.0.1',
            port: 2333,
            authorization: 'youshallnotpass',
            requestTimeout: 4000,
        };
        const validatedCustom = validateAndFormatNodeOption(customOption);
        assert.equal(validatedCustom.requestTimeout, 4000);
    });

    console.log('\n--- Test 4: interactionCreate Stuck "Thinking..." Prevention ---');

    await test('interactionCreate guarantees deferred commands are completed if command forgets to reply', async () => {
        const commands = new Map();
        // A command that defers but never calls reply/editReply
        commands.set('forgetful', {
            execute: async (inter) => {
                // Command does some work and finishes without calling safeReply
                await new Promise(r => setTimeout(r, 20));
            }
        });

        const mockClient = {
            commands,
            defaultLanguage: 'en',
            languageManager: { get: () => 'Command execution completed.' }
        };

        const interaction = createMockInteraction({ commandName: 'forgetful' });
        interaction.client = mockClient;

        await interactionCreate.execute(interaction);

        assert.equal(interaction.deferred, true, 'Command was deferred');
        assert.equal(interaction.replied, true, 'Completion guarantee must finalize reply');
        assert.equal(interaction.lastMethod, 'editReply');
        const embedTitle = interaction.lastPayload?.embeds?.[0]?.data?.title || interaction.lastPayload?.embeds?.[0]?.title;
        assert.ok(embedTitle?.includes('Command Completed'), 'Fallback completion message was dispatched');
    });

    console.log(`\n========================================`);
    console.log(`Concurrency & Performance Fix Tests: ${passed}/${total} passed`);
    console.log(`========================================\n`);

    if (passed !== total) process.exit(1);
    process.exit(0);
}

run().catch((err) => {
    console.error('Fatal error during performance concurrency tests:', err);
    process.exit(1);
});
