// Boot test: loads every module the same way index.js does, but stops before login.
// Verifies wiring and command loading without a token.
const assert = require('node:assert');

async function main() {
  const commands = require('../src/commands');
  console.log('commands loaded:', commands.size);
  console.log('  ->', [...commands.keys()].join(', '));
  assert(commands.size >= 20, 'expected at least 20 commands');

  // simulate bot context with a fake client object
  const fakeClient = {
    isReady: () => false,
    guilds: { cache: new Map() },
    ws: { ping: -1 },
    user: null,
    channels: { cache: new Map() },
    application: { commands: { fetch: async () => new Map(), set: async () => {} } },
    on: () => {},
    once: () => {},
    incrementMaxListeners: () => {},
    decrementMaxListeners: () => {},
    destroy: () => {},
  };
  const { Player } = require('discord-player');
  const player = new Player(fakeClient);
  const { createEngine, baseQueueOptions } = require('../src/bot/music');
  const music = createEngine(player);
  const context = require('../src/bot/context');
  context.setContext({ client: fakeClient, player, music, store: require('../src/bot/store'), config: require('../src/config'), commands });

  console.log('boot test OK — context:', Boolean(context.tryGetContext() && context.tryGetContext().music));
}

main().catch((e) => {
  console.error('BOOT TEST FAILED:', e);
  process.exit(1);
});
