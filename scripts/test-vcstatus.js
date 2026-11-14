// Test for the two new features: voice channel status (image 1) + rotating bot
// presence (image 2). Simulates REST responses with a fake client.
const assert = require('node:assert');

async function main() {
  const vcStatus = require('../src/bot/vcStatus');

  // fake REST manager that records calls and can fail with a status code
  const calls = [];
  let failWith = null;
  const fakeClient = {
    rest: {
      put: async (route, opts) => {
        if (failWith) { failWith = null; const e = new Error('forbidden'); e.status = 403; throw e; }
        calls.push(['PUT', route, opts && opts.body]);
        return {};
      },
      delete: async (route) => {
        if (failWith) { const e = new Error('gone'); e.status = failWith; failWith = null; throw e; }
        calls.push(['DELETE', route, null]);
        return {};
      },
    },
    channels: { cache: new Map() },
  };

  vcStatus.init(fakeClient);
  vcStatus.reset();

  const fakeChannel = { id: '111222333444555666' };
  const fakeQueue = {
    channel: fakeChannel,
    guild: { id: '999' },
    client: fakeClient,
  };
  const fakeTrack = { title: 'Urmila Upadhyaya Songs Collection', author: 'Some Channel' };

  // 1) now playing -> PUT with song text
  let ok = await vcStatus.setNowPlaying(fakeQueue, fakeTrack);
  assert.strictEqual(ok, true, 'setNowPlaying should succeed');
  assert.deepStrictEqual(calls[0][0], 'PUT');
  assert.strictEqual(calls[0][1], '/channels/111222333444555666/voice-status');
  assert.strictEqual(calls[0][2].status, 'Urmila Upadhyaya Songs Collection • Some Channel');
  console.log('PASS: song title goes to PUT /channels/{id}/voice-status');

  // 2) standby texts
  ok = await vcStatus.setStandby(fakeQueue, 'twenty4seven');
  assert.strictEqual(ok, true);
  assert.ok(calls[1][2].status.includes('24/7'));
  ok = await vcStatus.setStandby(fakeQueue, 'autoplay');
  assert.ok(calls[2][2].status.includes('Autoplay'));
  console.log('PASS: standby texts (24/7 / autoplay)');

  // 3) clear -> DELETE
  ok = await vcStatus.clear(fakeQueue);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(calls[3][0], 'DELETE');
  console.log('PASS: clear -> DELETE /channels/{id}/voice-status');

  // 4) 404 while clearing is benign
  failWith = 404;
  ok = await vcStatus.clear(fakeQueue);
  assert.strictEqual(ok, true, '404 on clear should be treated as cleared');
  console.log('PASS: 404 on clear treated as success');

  // 5) 403 while clearing is benign (bot already left the channel)
  failWith = 403;
  ok = await vcStatus.clear(fakeQueue);
  assert.strictEqual(ok, false, '403 on clear should not throw');
  console.log('PASS: 403 on clear is ignored gracefully');

  // 6) 403 on SET counts toward disabling after GIVE_UP_AFTER
  vcStatus.reset();
  for (let i = 0; i < 4; i++) {
    failWith = 403;
    await vcStatus.setNowPlaying(fakeQueue, fakeTrack);
  }
  const countAfter = calls.length;
  await vcStatus.setNowPlaying(fakeQueue, fakeTrack); // disabled -> no call
  assert.strictEqual(calls.length, countAfter, 'no further REST calls after giving up');
  console.log('PASS: repeated 403s disable the feature (no endless failing calls)');

  // ---- presence ---------------------------------------------------------
  const { ActivityType } = require('discord.js');
  const presence = require('../src/bot/presence');
  const { Player } = require('discord-player');
  const { GuildQueueEvent } = require('discord-player');

  const presenceCalls = [];
  const fakeUser = {
    setPresence: (p) => presenceCalls.push(p),
  };
  const fakeClient2 = {
    user: fakeUser,
    guilds: { cache: new Map() },
    incrementMaxListeners: () => {},
    decrementMaxListeners: () => {},
    on: () => {},
    once: () => {},
  };
  const player2 = new Player(fakeClient2, { lagMonitor: 1000 });
  player2.nodes.get = () => null; // idle — no queues

  // idle queue (no tracks yet)
  const guildMap = fakeClient2.guilds.cache;
  guildMap.set('g1', { id: 'g1' });

  const handle = presence.start(fakeClient2, player2);
  assert.strictEqual(presenceCalls.length, 1, 'initial presence applied');
  const first = presenceCalls[0];
  const act = first.activities[0];
  assert.strictEqual(act.type, ActivityType.Custom);
  assert.strictEqual(act.state, 'Mixing some tunes');
  console.log('PASS: idle presence is a custom status (starts with "Mixing some tunes")');

  // fake a playing queue on the player -> next tick should switch to Listening
  guildMap.set('g2', { id: 'g2' });
  player2.nodes.get = () => ({
    isPlaying: () => true,
    currentTrack: { title: 'Kauda Bole' },
    node: { isPaused: () => false },
  });
  player2.events.emit(GuildQueueEvent.playerStart, { guild: { id: 'g2' }, id: 'g2' });
  // tick is pending now; wait for the 13s tick? no — force it via the returned handle? simplest: wait briefly with fake timers
  await new Promise((r) => setTimeout(r, 50));
  // presence tick interval is 13s, so manually apply once via a fresh start to check the playing shape:
  const presenceCalls2 = [];
  const fakeUser2 = { setPresence: (p) => presenceCalls2.push(p) };
  const client3 = { user: fakeUser2, guilds: { cache: guildMap }, incrementMaxListeners: () => {}, decrementMaxListeners: () => {}, on: () => {}, once: () => {} };
  const player3 = new Player(client3, { lagMonitor: 1000 });
  player3.nodes.get = () => ({
    isPlaying: () => true,
    currentTrack: { title: 'Kauda Bole' },
    node: { isPaused: () => false },
  });
  presence.start(client3, player3);
  const playingAct = presenceCalls2[0].activities[0];
  assert.strictEqual(playingAct.type, ActivityType.Listening);
  assert.strictEqual(playingAct.name, 'Kauda Bole');
  console.log('PASS: while playing -> "Listening to <song>" with purple-note activity type');

  handle.stop();
  console.log('VC STATUS + PRESENCE TESTS OK');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
