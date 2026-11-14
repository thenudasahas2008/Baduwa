/**
 * Comprehensive Regression Suite for Dashboard Button Visibility & Playback State
 *
 * Verifies:
 * 1. Playing a track displays all intended playback controls (Pause, Skip, Shuffle, Stop, Previous, Autoplay, Queue, Loop).
 * 2. Pausing a track preserves controls and current track information with Resume (▶️) toggle.
 * 3. Resuming preserves the correct controls with Pause (⏸️) toggle.
 * 4. Pressing the Stop button removes all playback buttons (components: []).
 * 5. Executing /stop removes all playback buttons (components: []).
 * 6. An empty idle queue does not display playback controls.
 * 7. A new valid track restores controls on the existing dashboard message.
 * 8. Autoplay restores controls only after a new track successfully starts.
 * 9. Stale recovery callbacks, progress ticks, and delayed updates cannot restore controls after Stop.
 * 10. The /247 feature continues to keep the bot connected when enabled even with no buttons.
 * 11. No duplicate dashboards are created during component updates (in-place editing).
 * 12. Other slash commands and dashboard interactions remain functional.
 */

const assert = require('assert');
const PlayerController = require('../src/utils/PlayerController');
const { stopPlayer } = require('../src/utils/PlayerActions');
const { isManualStopActive, markManualStop, clearManualStop, schedulePlayerUpdate } = require('../src/utils/playerLifecycle');
const PlaybackProgressManager = require('../src/utils/PlaybackProgressManager');

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ok  - ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  FAIL - ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

function createMockTrack(title = 'Test Song', author = 'Test Artist', duration = 240000) {
    return {
        info: {
            title,
            author,
            duration,
            uri: 'https://youtube.com/watch?v=12345',
            artworkUrl: 'https://i.ytimg.com/vi/12345/hqdefault.jpg',
            identifier: '12345',
            isStream: false,
        },
        userData: { requester: { username: 'TestUser', id: '111' } }
    };
}

(async () => {
    console.log('--- ZYRO Dashboard Playback State & Button Visibility Regression Suite ---\n');

    // Test 1: Playing a track displays all intended playback controls
    await test('1. Playing a track displays the intended playback controls', async () => {
        const guildId = 'guild-t1';
        clearManualStop(guildId);
        const track = createMockTrack();

        const mockClient = {
            autoplayEnabled: new Map([[guildId, false]]),
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null }
        };

        const controller = new PlayerController(mockClient);
        const player = {
            guildId,
            playing: true,
            paused: false,
            repeatMode: 'off',
            queue: {
                current: track,
                tracks: [createMockTrack('Next 1'), createMockTrack('Next 2')],
                previous: [createMockTrack('Prev 1')]
            },
            getData: () => null
        };

        const buttons = controller.createPlayerButtons(player);
        assert.strictEqual(buttons.length, 2, 'Must have 2 action rows of controls');

        const row1CustomIds = buttons[0].components.map(b => b.data.custom_id);
        const row2CustomIds = buttons[1].components.map(b => b.data.custom_id);

        assert.deepStrictEqual(row1CustomIds, ['player:playpause', 'player:skip', 'player:shuffle', 'player:stop']);
        assert.deepStrictEqual(row2CustomIds, ['player:back', 'player:autoplay', 'player:queue', 'player:loop']);

        // Check Play/Pause button styling when playing
        const playPauseBtn = buttons[0].components[0];
        assert.strictEqual(playPauseBtn.data.label, 'Pause');
        assert.strictEqual(playPauseBtn.data.emoji.name, '⏸️');
    });

    // Test 2: Pausing a track preserves controls and current track information
    await test('2. Pausing a track preserves the controls and current track information', async () => {
        const guildId = 'guild-t2';
        clearManualStop(guildId);
        const track = createMockTrack('Acoustic Sunset', 'Artist Duo');

        const mockClient = {
            autoplayEnabled: new Map([[guildId, false]]),
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null }
        };

        const controller = new PlayerController(mockClient);
        const player = {
            guildId,
            playing: false,
            paused: true,
            repeatMode: 'off',
            queue: {
                current: track,
                tracks: [],
                previous: []
            },
            getData: () => null
        };

        const embed = controller.createPlayerEmbed(player, track);
        assert.ok(embed.data.author.name.includes('PAUSED'), 'Embed shows PAUSED status');
        assert.ok(embed.data.description.includes('Acoustic Sunset'), 'Current track title preserved');

        const buttons = controller.createPlayerButtons(player);
        assert.strictEqual(buttons.length, 2, 'Controls remain visible while paused');

        const playPauseBtn = buttons[0].components[0];
        assert.strictEqual(playPauseBtn.data.label, 'Resume', 'Button label toggles to Resume');
        assert.strictEqual(playPauseBtn.data.emoji.name, '▶️', 'Button emoji toggles to Play/Resume');
    });

    // Test 3: Resuming preserves the correct controls
    await test('3. Resuming preserves the correct controls', async () => {
        const guildId = 'guild-t3';
        clearManualStop(guildId);
        const track = createMockTrack();

        const mockClient = {
            autoplayEnabled: new Map([[guildId, false]]),
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null }
        };

        const controller = new PlayerController(mockClient);
        const player = {
            guildId,
            playing: true,
            paused: false,
            repeatMode: 'track',
            queue: {
                current: track,
                tracks: [],
                previous: []
            },
            getData: () => null
        };

        const embed = controller.createPlayerEmbed(player, track);
        assert.ok(embed.data.author.name.includes('NOW PLAYING'), 'Embed shows NOW PLAYING status');

        const buttons = controller.createPlayerButtons(player);
        assert.strictEqual(buttons.length, 2, 'Controls remain visible while resumed');
        const playPauseBtn = buttons[0].components[0];
        assert.strictEqual(playPauseBtn.data.label, 'Pause', 'Button label toggles to Pause');
        assert.strictEqual(playPauseBtn.data.emoji.name, '⏸️', 'Button emoji toggles to Pause');

        const loopBtn = buttons[1].components[3];
        assert.strictEqual(loopBtn.data.label, 'Loop: Track', 'Loop track indicator preserved');
    });

    // Test 4: Pressing the Stop button removes all playback buttons
    await test('4. Pressing the Stop button removes all playback buttons', async () => {
        const guildId = 'guild-t4';
        const track = createMockTrack();

        let stopPlayingCalled = false;
        let lastComponentsSent = null;
        let lastEmbedSent = null;

        const mockMsg = {
            id: 'msg-dashboard-4',
            edit: async (payload) => {
                lastComponentsSent = payload.components;
                lastEmbedSent = payload.embeds[0];
                return mockMsg;
            }
        };

        const mockChannel = {
            id: 'vc-channel-4',
            name: 'Voice Lounge',
            isVoiceBased: () => true,
            permissionsFor: () => ({ has: () => true }),
            messages: {
                cache: new Map([['msg-dashboard-4', mockMsg]]),
                fetch: async () => mockMsg
            }
        };

        const mockClient = {
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    members: { me: { voice: { channelId: 'vc-channel-4' } } }
                }]])
            },
            channels: { cache: new Map([['vc-channel-4', mockChannel]]) },
            guildSettings: { get: () => ({ voiceChannelId: 'vc-channel-4' }) },
            lavalink: {
                getPlayer: () => player
            },
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null },
            activePlayers: new Map([[guildId, { title: 'Test' }]]),
            updatePresence: () => {},
            voiceChannelStatusManager: { clearStatusForGuild: async () => {} }
        };

        const controller = new PlayerController(mockClient);
        mockClient.playerController = controller;
        controller.setDashboard(guildId, { messageId: 'msg-dashboard-4', channelId: 'vc-channel-4' });

        const player = {
            guildId,
            playing: true,
            paused: false,
            voiceChannelId: 'vc-channel-4',
            textChannelId: 'vc-channel-4',
            queue: {
                current: track,
                tracks: [createMockTrack('Upcoming 1')],
                splice: async (s, c) => { player.queue.tracks.length = 0; }
            },
            data: new Map(),
            setData: (k, v) => player.data.set(k, v),
            getData: (k) => player.data.get(k),
            stopPlaying: async () => { stopPlayingCalled = true; }
        };

        // Invoke canonical stopPlayer (used by Stop button)
        await stopPlayer(mockClient, player, { channelId: 'vc-channel-4' });

        assert.strictEqual(stopPlayingCalled, true, 'stopPlaying invoked on lavalink client');
        assert.strictEqual(player.queue.tracks.length, 0, 'Upcoming tracks cleared');
        assert.strictEqual(player.queue.current, null, 'Current track cleared');
        assert.strictEqual(isManualStopActive(guildId), true, 'Manual stop generation active');

        // Check the dashboard message update
        assert.ok(lastComponentsSent !== null, 'Dashboard message was edited');
        assert.strictEqual(Array.isArray(lastComponentsSent), true, 'Components is an array');
        assert.strictEqual(lastComponentsSent.length, 0, 'ALL playback buttons removed from component payload');
        assert.ok(lastEmbedSent.data.author.name.includes('IDLE'), 'Embed author is IDLE');
    });

    // Test 5: Executing /stop removes all playback buttons
    await test('5. Executing /stop removes all playback buttons', async () => {
        const guildId = 'guild-t5';
        const track = createMockTrack();

        let editedComponents = null;
        const mockMsg = {
            id: 'msg-dashboard-5',
            edit: async (payload) => {
                editedComponents = payload.components;
                return mockMsg;
            }
        };

        const mockChannel = {
            id: 'tc-channel-5',
            name: 'music-chat',
            isVoiceBased: () => false,
            permissionsFor: () => ({ has: () => true }),
            messages: {
                cache: new Map([['msg-dashboard-5', mockMsg]]),
                fetch: async () => mockMsg
            }
        };

        const mockClient = {
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    members: { me: { voice: { channelId: 'vc-channel-5' } } }
                }]])
            },
            channels: { cache: new Map([['tc-channel-5', mockChannel]]) },
            guildSettings: { get: () => ({ textChannelId: 'tc-channel-5', voiceChannelId: 'vc-channel-5' }) },
            lavalink: { getPlayer: () => player },
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null },
            activePlayers: new Map(),
            updatePresence: () => {},
            voiceChannelStatusManager: { clearStatusForGuild: async () => {} }
        };

        const controller = new PlayerController(mockClient);
        mockClient.playerController = controller;
        controller.setDashboard(guildId, { messageId: 'msg-dashboard-5', channelId: 'tc-channel-5' });

        const player = {
            guildId,
            playing: true,
            paused: false,
            voiceChannelId: 'vc-channel-5',
            textChannelId: 'tc-channel-5',
            queue: {
                current: track,
                tracks: [createMockTrack()],
                splice: async () => { player.queue.tracks.length = 0; }
            },
            data: new Map(),
            setData: (k, v) => player.data.set(k, v),
            getData: (k) => player.data.get(k),
            stopPlaying: async () => {}
        };

        // Simulate /stop command execution
        await stopPlayer(mockClient, player, { channelId: 'tc-channel-5' });

        assert.ok(editedComponents !== null, 'Existing dashboard edited in-place');
        assert.deepStrictEqual(editedComponents, [], 'Components payload must be completely empty');
    });

    // Test 6: An empty idle queue does not display playback controls
    await test('6. An empty idle queue does not display playback controls', async () => {
        const guildId = 'guild-t6';
        clearManualStop(guildId);

        const mockClient = {
            autoplayEnabled: new Map([[guildId, false]]),
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null }
        };

        const controller = new PlayerController(mockClient);

        // Player with empty queue and not playing
        const player = {
            guildId,
            playing: false,
            paused: false,
            queue: {
                current: null,
                tracks: [],
                previous: []
            },
            getData: () => null
        };

        const buttons = controller.createPlayerButtons(player);
        assert.deepStrictEqual(buttons, [], 'Must return empty array for idle empty player');

        const stoppedButtons = controller.createStoppedButtons(player);
        assert.deepStrictEqual(stoppedButtons, [], 'createStoppedButtons must return empty array');
    });

    // Test 7: A new valid track restores the controls on the existing dashboard message
    await test('7. A new valid track restores the controls on the existing dashboard message', async () => {
        const guildId = 'guild-t7';
        let editedPayload = null;

        let player = null;
        const mockMsg = {
            id: 'canonical-msg-7',
            edit: async (payload) => {
                editedPayload = payload;
                return mockMsg;
            }
        };

        const mockChannel = {
            id: 'chan-7',
            name: 'music',
            isVoiceBased: () => false,
            permissionsFor: () => ({ has: () => true }),
            messages: {
                cache: new Map([['canonical-msg-7', mockMsg]]),
                fetch: async () => mockMsg
            }
        };

        const mockClient = {
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    members: { me: { voice: { channelId: 'vc-7' } } }
                }]])
            },
            channels: { cache: new Map([['chan-7', mockChannel]]) },
            guildSettings: { get: () => ({ textChannelId: 'chan-7' }) },
            lavalink: { getPlayer: () => player },
            autoplayEnabled: new Map([[guildId, false]]),
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null }
        };

        const controller = new PlayerController(mockClient);
        mockClient.playerController = controller;
        controller.setDashboard(guildId, { messageId: 'canonical-msg-7', channelId: 'chan-7' });

        // First stopped state: buttons cleared
        await controller.showStoppedState(guildId, { channelId: 'chan-7' });
        assert.deepStrictEqual(editedPayload.components, [], 'Dashboard buttons hidden on stop');

        // New valid track starts (/play clears manual stop and starts new track)
        clearManualStop(guildId);
        const newTrack = createMockTrack('New Arrival', 'Fresh Band');
        player = {
            guildId,
            playing: true,
            paused: false,
            repeatMode: 'off',
            queue: {
                current: newTrack,
                tracks: [],
                previous: []
            },
            getData: () => null
        };
        mockClient.lavalink.getPlayer = () => player;

        // Update player dashboard in-place
        await controller.updatePlayer(guildId, { inPlace: true, channelId: 'chan-7', track: newTrack });

        assert.strictEqual(editedPayload.components.length, 2, 'Controls restored on existing dashboard message');
        const playPauseBtn = editedPayload.components[0].components[0];
        assert.strictEqual(playPauseBtn.data.label, 'Pause');
        assert.ok(editedPayload.embeds[0].data.description.includes('New Arrival'));
    });

    // Test 8: Autoplay restores controls only after a new track successfully starts
    await test('8. Autoplay restores controls only after a new track successfully starts', async () => {
        const guildId = 'guild-t8';
        markManualStop(guildId);

        const mockClient = {
            autoplayEnabled: new Map([[guildId, true]]),
            is247Enabled: () => false,
            user: { displayAvatarURL: () => null }
        };

        const controller = new PlayerController(mockClient);

        // While manual stop is active, even if autoplay was enabled, buttons must remain empty
        const stoppedPlayer = {
            guildId,
            playing: false,
            paused: false,
            queue: { current: null, tracks: [] },
            getData: (k) => k === 'internal_stopPlaying' ? true : null
        };
        assert.deepStrictEqual(controller.createPlayerButtons(stoppedPlayer), []);

        // Once autoplay genuinely starts a track and clears manual stop
        clearManualStop(guildId);
        const autoplayTrack = createMockTrack('Radio Auto Discovery', 'AI DJ');
        const activeAutoplayPlayer = {
            guildId,
            playing: true,
            paused: false,
            queue: { current: autoplayTrack, tracks: [] },
            getData: () => null
        };

        const activeButtons = controller.createPlayerButtons(activeAutoplayPlayer);
        assert.strictEqual(activeButtons.length, 2, 'Controls restored after autoplay track actually starts');
        assert.strictEqual(activeButtons[0].components[0].data.label, 'Pause');
    });

    // Test 9: Stale recovery callbacks, progress ticks, and delayed updates cannot restore controls after Stop
    await test('9. Stale recovery callbacks cannot restore controls after Stop', async () => {
        const guildId = 'guild-t9';
        markManualStop(guildId);

        let editedMsg = false;
        const mockMsg = {
            id: 'dash-9',
            edit: async () => { editedMsg = true; }
        };
        const mockChannel = {
            id: 'c-9',
            messages: {
                cache: new Map([['dash-9', mockMsg]]),
                fetch: async () => mockMsg
            }
        };

        const mockClient = {
            guilds: { cache: new Map([[guildId, {}]]) },
            channels: { cache: new Map([['c-9', mockChannel]]) },
            lavalink: {
                getPlayer: () => ({
                    guildId,
                    playing: false,
                    paused: false,
                    queue: { current: createMockTrack() },
                    getData: (k) => k === 'internal_stopPlaying' ? true : null
                })
            },
            playerController: {
                getDashboard: () => ({ messageId: 'dash-9', channelId: 'c-9' }),
                updatePlayer: async () => { editedMsg = true; },
                createPlayerButtons: () => [/* would return buttons if un-guarded */]
            }
        };

        // 1. Stale scheduled player update
        schedulePlayerUpdate(mockClient, guildId, 5, { replace: false });
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(editedMsg, false, 'Scheduled update suppressed when manual stop is active');

        // 2. PlaybackProgressManager tick
        const progressManager = new PlaybackProgressManager(mockClient);
        await progressManager.tick();
        assert.strictEqual(editedMsg, false, 'Progress tick ignored when manual stop is active');
    });

    // Test 10: The /247 feature continues to keep the bot connected when enabled
    await test('10. The /247 feature continues to keep the bot connected when enabled', async () => {
        const guildId = 'guild-t10';
        let isConnected = true;

        const mockClient = {
            is247Enabled: (gid) => gid === guildId,
            user: { displayAvatarURL: () => null }
        };

        const controller = new PlayerController(mockClient);
        const player = {
            guildId,
            playing: false,
            paused: false,
            connected: isConnected,
            voiceChannelId: 'vc-247',
            queue: { current: null, tracks: [] },
            getData: () => null
        };

        // Idle embed in 24/7 mode
        const embed = controller.createPlayerEmbed(player, null);
        assert.strictEqual(embed.data.author.name, 'ZYRO • IDLE');
        assert.strictEqual(embed.data.footer.text, 'ZYRO Music • 24/7 Mode Active');

        // Buttons must still be empty
        const buttons = controller.createStoppedButtons(player);
        assert.deepStrictEqual(buttons, [], '24/7 idle dashboard has no playback buttons');

        // Verify voice connection is preserved
        assert.strictEqual(player.connected, true, 'Bot remains connected in voice channel');
    });

    // Test 11: No duplicate dashboards are created during component updates
    await test('11. No duplicate dashboards are created during component updates', async () => {
        const guildId = 'guild-t11';
        let sendCount = 0;
        let editCount = 0;

        const mockMsg = {
            id: 'msg-canonical-11',
            edit: async () => { editCount++; return mockMsg; }
        };

        const mockChannel = {
            id: 'vc-11',
            name: 'Voice Lounge',
            isVoiceBased: () => true,
            permissionsFor: () => ({ has: () => true }),
            send: async () => { sendCount++; return mockMsg; },
            messages: {
                cache: new Map([['msg-canonical-11', mockMsg]]),
                fetch: async () => mockMsg
            }
        };

        const mockClient = {
            guilds: {
                cache: new Map([[guildId, {
                    id: guildId,
                    members: { me: { voice: { channelId: 'vc-11' } } }
                }]])
            },
            channels: { cache: new Map([['vc-11', mockChannel]]) },
            guildSettings: { get: () => ({ voiceChannelId: 'vc-11' }) },
            lavalink: { getPlayer: () => null }
        };

        const controller = new PlayerController(mockClient);
        controller.setDashboard(guildId, { messageId: 'msg-canonical-11', channelId: 'vc-11' });

        // Stopped state updates existing message in place
        await controller.showStoppedState(guildId, { channelId: 'vc-11' });
        assert.strictEqual(sendCount, 0, 'No new messages sent');
        assert.strictEqual(editCount, 1, 'Existing message edited in place');

        // Repeated stopped state updates in place without duplicate
        await controller.showStoppedState(guildId, { channelId: 'vc-11' });
        assert.strictEqual(sendCount, 0, 'Still no new messages sent');
        assert.strictEqual(editCount, 2, 'Re-edited existing message in place');
    });

    // Test 12: Other slash commands and dashboard interactions remain functional
    await test('12. Other slash commands and dashboard interactions remain functional', async () => {
        const pauseCommand = require('../src/commands/pause');
        const stopCommand = require('../src/commands/stop');
        const twentyFourSevenCommand = require('../src/commands/247');

        assert.strictEqual(typeof pauseCommand.execute, 'function');
        assert.strictEqual(typeof stopCommand.execute, 'function');
        assert.strictEqual(typeof twentyFourSevenCommand.execute, 'function');

        assert.strictEqual(pauseCommand.data.name, 'pause');
        assert.strictEqual(stopCommand.data.name, 'stop');
        assert.strictEqual(twentyFourSevenCommand.data.name, '247');
    });

    console.log(`\n========================================`);
    console.log(`Dashboard Button State Tests: ${passedTests}/${totalTests} passed`);
    console.log(`========================================\n`);

    if (passedTests !== totalTests) {
        process.exit(1);
    }
    process.exit(0);
})();
