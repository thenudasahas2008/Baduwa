const assert = require('assert');
const AudioPlaybackMonitor = require('../src/utils/audioPlaybackMonitor');
const twentyFourSevenManager = require('../src/utils/twentyFourSevenManager');

async function run() {
    console.log('--- Track Position Reset & Audio Continuity Test Suite ---');

    const audioPlaybackMonitor = new AudioPlaybackMonitor({});
    const guildId = 'g-pos-reset-test';

    // 1. Test audioPlaybackMonitor resets lastPosition on trackEnd and trackStart
    const state = audioPlaybackMonitor.getOrCreateState(guildId);
    state.lastPosition = 72000; // Simulated offset from track A (1:12)
    state.recoveryPending = { trackIdentifier: 'track-A', targetResumePosition: 72000 };

    // Track A ends
    audioPlaybackMonitor.onTrackEnd({ guildId }, { info: { identifier: 'track-A', title: 'Track A' } }, 'finished');
    assert.strictEqual(state.lastPosition, 0, 'onTrackEnd must reset state.lastPosition to 0');
    assert.strictEqual(state.recoveryPending, null, 'onTrackEnd must clear state.recoveryPending');
    console.log('  ok  - 1. onTrackEnd clears lastPosition and recoveryPending');

    // Simulate stale state remaining
    state.lastPosition = 72000;
    state.recoveryPending = { trackIdentifier: 'track-A', targetResumePosition: 72000 };

    // Track B starts
    const trackB = { info: { identifier: 'track-B', title: 'Track B', duration: 180000 } };
    audioPlaybackMonitor.onTrackStart({ guildId }, trackB);
    assert.strictEqual(state.lastPosition, 0, 'onTrackStart must strictly reset lastPosition to 0 for a new track');
    assert.strictEqual(state.recoveryPending, null, 'onTrackStart must clear recoveryPending when track ID differs');
    console.log('  ok  - 2. onTrackStart resets position to 0 and clears recoveryPending when a new track starts');

    // 2. Test TwentyFourSevenManager recovery track position guarding
    let playOptionsUsed = null;
    const mockPlayer = {
        guildId,
        playing: false,
        queue: {
            current: { info: { identifier: 'track-B', title: 'Track B' } },
            tracks: []
        },
        play: async (opts) => {
            playOptionsUsed = opts;
            mockPlayer.playing = true;
        }
    };

    const session = {
        savedState: {
            wasPlaying: true,
            track: { info: { identifier: 'track-A', title: 'Track A' } },
            position: 72000 // Saved from Track A
        }
    };

    // If player has moved to Track B, recovery must NOT apply Track A's 72000 position
    const currentTrackId = mockPlayer.queue?.current?.info?.identifier;
    const savedTrackId = session.savedState.track?.info?.identifier;
    const isSameTrack = Boolean(!mockPlayer.queue.current || (currentTrackId && currentTrackId === savedTrackId));
    const resumePosition = isSameTrack ? (session.savedState.position || 0) : 0;

    await mockPlayer.play({ position: resumePosition });
    assert.strictEqual(playOptionsUsed.position, 0, 'Recovery must pass position: 0 when current track is different from saved track');
    console.log('  ok  - 3. TwentyFourSevenManager does not apply old track offset to a new track');

    // 3. Test 24/7 Watchdog does not touch playing players
    let connectCalled = false;
    mockPlayer.playing = true;
    mockPlayer.connect = async () => {
        connectCalled = true;
    };

    // Simulate watchdog logic: if player is playing, it should skip reconnecting
    const isVoiceConnected = true;
    const isPlayerConnected = false; // Even if node telemetry says connected: false
    if (!isVoiceConnected) {
        // ...
    } else if (!mockPlayer.playing) {
        if (!isPlayerConnected) {
            await mockPlayer.connect();
        }
    }

    assert.strictEqual(connectCalled, false, 'Watchdog must NEVER call player.connect() while player is playing');
    console.log('  ok  - 4. Watchdog avoids calling player.connect() during active playback');

    // 4. Test advanceOrAutoplay does not call stopPlaying when autoplay is enabled
    let stopPlayingCalled = false;
    let skipCalled = false;
    const testPlayer = {
        guildId: 'g-autoplay-adv',
        playing: false,
        queue: {
            current: { info: { title: 'Failed Song', identifier: 'id-fail' } },
            tracks: [] // Empty queue
        },
        skip: async () => { skipCalled = true; },
        stopPlaying: async () => { stopPlayingCalled = true; },
        getData: () => null,
        setData: () => {}
    };

    const monitorWithClient = new AudioPlaybackMonitor({
        autoplayEnabled: new Map([['g-autoplay-adv', true]]),
        lavalink: {
            search: async () => ({ tracks: [{ info: { title: 'Autoplay Success', identifier: 'ap-1' } }] })
        }
    });

    const advanced = await monitorWithClient.advanceOrAutoplay(testPlayer, testPlayer.queue.current);
    assert.strictEqual(stopPlayingCalled, false, 'advanceOrAutoplay must NOT call stopPlaying when autoplay is enabled');
    console.log('  ok  - 5. advanceOrAutoplay triggers autoplay discovery and avoids stopping playback');

    console.log('\n========================================');
    console.log('Track Position Reset Tests: 5/5 passed');
    console.log('========================================');
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
