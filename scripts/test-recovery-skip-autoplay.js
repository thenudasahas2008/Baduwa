const assert = require('assert');
const path = require('path');
const { handleAutoplay } = require('../src/utils/autoplay');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const guildSettings = require('../src/utils/guildSettings');

async function runTests() {
    console.log('--- Testing Recovery Skip & Autoplay Continuity ---');

    // Test 1: guildSettings isAutoplay can be set to true
    const testGuildId = 'guild-test-autoplay-default';
    guildSettings.setAutoplay(testGuildId, true);
    assert.strictEqual(guildSettings.isAutoplay(testGuildId), true, 'isAutoplay should be true when enabled');

    // Test 2: explicit false is respected
    guildSettings.setAutoplay(testGuildId, false);
    assert.strictEqual(guildSettings.isAutoplay(testGuildId), false, 'isAutoplay false must be respected');

    // Reset back
    guildSettings.setAutoplay(testGuildId, true);
    assert.strictEqual(guildSettings.isAutoplay(testGuildId), true, 'isAutoplay true must be respected');

    // Test 3: handleAutoplay with reason='recovery_skip' succeeds even if player.playing and player.queue.current exist
    let skipCalled = false;
    let stopCalled = false;
    let addedTracks = [];

    const mockPlayer = {
        guildId: testGuildId,
        playing: true,
        queue: {
            current: {
                info: {
                    identifier: 'dead-track-id',
                    title: 'Mal Pita Mal',
                    author: 'Amal Perera'
                }
            },
            tracks: [],
            previous: [],
            add: async (tracks) => {
                addedTracks.push(...tracks);
            }
        },
        search: async () => ({
            tracks: [{
                info: {
                    identifier: 'new-autoplay-track-id',
                    title: 'New Autoplay Song',
                    author: 'New Artist',
                    duration: 200000
                }
            }]
        }),
        skip: async () => {
            skipCalled = true;
            mockPlayer.queue.current = addedTracks[0] || null;
            return true;
        },
        stopPlaying: async () => {
            stopCalled = true;
        },
        getData: () => null,
        setData: () => {}
    };

    const mockClient = {
        autoplayEnabled: {
            get: () => true
        },
        guildSettings
    };

    const autoplayResult = await handleAutoplay(mockClient, mockPlayer, 'recovery_skip', mockPlayer.queue.current);
    assert.strictEqual(autoplayResult, true, 'handleAutoplay should succeed on recovery_skip');
    assert.strictEqual(addedTracks.length, 1, 'candidate track must be added to queue');
    assert.strictEqual(skipCalled, true, 'player.skip() must be called to skip the dead track');
    assert.strictEqual(stopCalled, false, 'player.stopPlaying() must not be called');
    console.log('  ok - 1. handleAutoplay with recovery_skip bypasses active playing check and calls player.skip()');

    // Test 4: advanceOrAutoplay does not enter stopped state when autoplay is active
    let stoppedStateShown = false;
    const clientWithController = {
        autoplayEnabled: {
            get: () => true
        },
        guildSettings,
        playerController: {
            showStoppedState: () => {
                stoppedStateShown = true;
            }
        }
    };

    const monitor = new AudioPlaybackMonitor(clientWithController);
    skipCalled = false;
    stopCalled = false;
    addedTracks = [];

    const advanceResult = await monitor.advanceOrAutoplay(mockPlayer, mockPlayer.queue.current);
    assert.strictEqual(advanceResult, true, 'advanceOrAutoplay must return true when autoplay takes over');
    assert.strictEqual(stoppedStateShown, false, 'showStoppedState must not be called when autoplay is active');
    console.log('  ok - 2. advanceOrAutoplay seamlessly advances to new autoplay track without showing stopped state');

    console.log('\n========================================');
    console.log('All Recovery Skip & Autoplay tests passed!');
    console.log('========================================\n');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
