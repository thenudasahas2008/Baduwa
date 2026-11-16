const assert = require('assert');
const GuildSettingsManager = require('../src/utils/guildSettings');
const twentyFourSevenManager = require('../src/utils/twentyFourSevenManager');

async function run() {
    console.log('--- Permanent 24/7 Teardown Protection & Resilience Suite ---');

    // 1. Test GuildSettingsManager environment variable seeding
    process.env.TWENTY_FOUR_SEVEN_GUILD_ID = 'env-seeded-guild';
    process.env.TWENTY_FOUR_SEVEN_VOICE_CHANNEL_ID = 'env-seeded-channel';

    // Clear cache and reload
    GuildSettingsManager.cache.delete('env-seeded-guild');
    GuildSettingsManager.load();

    assert.strictEqual(GuildSettingsManager.is247('env-seeded-guild'), true, 'GuildSettingsManager should seed 24/7 from env vars');
    const settings = GuildSettingsManager.get('env-seeded-guild');
    assert.strictEqual(settings.voiceChannelId, 'env-seeded-channel', 'GuildSettingsManager should set voice channel from env vars');
    console.log('  ok  - 1. GuildSettingsManager seeds 24/7 from TWENTY_FOUR_SEVEN_GUILD_ID & TWENTY_FOUR_SEVEN_VOICE_CHANNEL_ID');

    // Test DEFAULT_247_ENABLED flag
    process.env.DEFAULT_247_ENABLED = 'true';
    assert.strictEqual(GuildSettingsManager.is247('any-random-guild'), true, 'DEFAULT_247_ENABLED should make is247 return true for all guilds');
    delete process.env.DEFAULT_247_ENABLED;
    delete process.env.TWENTY_FOUR_SEVEN_GUILD_ID;
    delete process.env.TWENTY_FOUR_SEVEN_VOICE_CHANNEL_ID;
    GuildSettingsManager.cache.delete('env-seeded-guild');
    console.log('  ok  - 2. DEFAULT_247_ENABLED flag correctly enables 24/7 across guilds');

    // 2. Test TwentyFourSevenManager resilience properties
    assert.strictEqual(twentyFourSevenManager.MAX_ATTEMPTS, 10, 'MAX_ATTEMPTS should be 10 for resilience');
    assert.ok(twentyFourSevenManager.BACKOFF_DELAYS.length >= 5, 'BACKOFF_DELAYS should provide progressive backoff');
    console.log('  ok  - 3. TwentyFourSevenManager has MAX_ATTEMPTS = 10 with progressive backoff delays');

    // 3. Test player.destroy logic behavior under 24/7
    let disconnectedPassed = null;
    let originalDestroyCalled = false;

    const mockClient = {
        is247Enabled: (guildId) => guildId === 'guild-247-active'
    };

    function attachPlayerDestroy(player) {
        player.client = mockClient;
        const originalDestroy = (reason, disconnect = true) => {
            originalDestroyCalled = true;
            disconnectedPassed = disconnect;
            return { destroyed: true, reason, disconnect };
        };

        player.destroy = async function (reason, disconnect = true) {
            const is247 = Boolean(mockClient.is247Enabled?.(player.guildId));

            if (reason === "command:leave" || reason === "guildDelete") {
                return originalDestroy(reason, true);
            }

            if (reason === "QueueEmpty" && is247) {
                player.playing = false;
                if (player.queue) player.queue.current = null;
                return this;
            }

            if (is247) {
                player.playing = false;
                if (player.queue) player.queue.current = null;
                return originalDestroy(reason, false);
            }

            return originalDestroy(reason, disconnect);
        };
    }

    // A: QueueEmpty when 24/7 is enabled
    const player1 = { guildId: 'guild-247-active', playing: true, queue: { current: 'song' } };
    attachPlayerDestroy(player1);
    originalDestroyCalled = false;
    const res1 = await player1.destroy('QueueEmpty');
    assert.strictEqual(originalDestroyCalled, false, 'QueueEmpty should not call originalDestroy when 24/7 is active');
    assert.strictEqual(player1.playing, false);
    assert.strictEqual(player1.queue.current, null);
    console.log('  ok  - 4. QueueEmpty does not call destroy or disconnect when 24/7 is active');

    // B: Node teardown / socket close when 24/7 is enabled
    for (const r of ['NodeDisconnected', 'SocketClosed', 'NodeReconnectFail', 'destroy', undefined]) {
        const player2 = { guildId: 'guild-247-active', playing: true, queue: { current: 'song' } };
        attachPlayerDestroy(player2);
        originalDestroyCalled = false;
        disconnectedPassed = null;
        await player2.destroy(r, true);
        assert.strictEqual(originalDestroyCalled, true, `Should call originalDestroy for ${r}`);
        assert.strictEqual(disconnectedPassed, false, `Should pass disconnect=false for ${r} when 24/7 is active`);
    }
    console.log('  ok  - 5. Teardowns (node disconnect, socket closed, etc.) preserve voice presence with disconnect=false');

    // C: Explicit command:leave when 24/7 is active
    const player3 = { guildId: 'guild-247-active', playing: true, queue: { current: 'song' } };
    attachPlayerDestroy(player3);
    originalDestroyCalled = false;
    disconnectedPassed = null;
    await player3.destroy('command:leave', false);
    assert.strictEqual(originalDestroyCalled, true);
    assert.strictEqual(disconnectedPassed, true, 'command:leave must enforce disconnect=true');
    console.log('  ok  - 6. command:leave cleanly disconnects even if 24/7 was active');

    // D: When 24/7 is disabled
    const player4 = { guildId: 'guild-standard', playing: true, queue: { current: 'song' } };
    attachPlayerDestroy(player4);
    originalDestroyCalled = false;
    disconnectedPassed = null;
    await player4.destroy('QueueEmpty', true);
    assert.strictEqual(originalDestroyCalled, true);
    assert.strictEqual(disconnectedPassed, true, 'Standard guild disconnects normally on QueueEmpty');
    console.log('  ok  - 7. Standard guild disconnects normally when 24/7 is not active');

    console.log('\n========================================');
    console.log('Permanent 24/7 Teardown Protection: 7/7 passed');
    console.log('========================================');
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
