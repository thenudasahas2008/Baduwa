// Test the /play autocomplete handler with a mock interaction
const { Client } = require('discord.js');
const { Player } = require('discord-player');
const { YoutubeExtractor } = require('discord-player-youtubei');
const playCmd = require('../src/commands/play');

async function main() {
  const client = new Client({ intents: [] });
  const player = new Player(client);
  await player.extractors.loadDefault((ext) => ext !== 'YouTubeExtractor', {});
  await player.extractors.register(YoutubeExtractor, {});

  const ctx = { client, player, music: null, store: null, config: null, commands: null };

  let responded = null;
  const mockInteraction = {
    commandName: 'play',
    options: {
      getFocused: () => ({ value: 'alan walker' }),
    },
    respond: async (list) => {
      responded = list;
    },
  };

  const t0 = Date.now();
  await playCmd.autocomplete(mockInteraction, ctx);
  console.log('autocomplete responded in', Date.now() - t0, 'ms with', responded ? responded.length : 0, 'options');
  if (responded && responded.length) {
    for (const r of responded.slice(0, 3)) {
      console.log('  -', r.name.slice(0, 80), '| value len:', String(r.value).length);
    }
    const bad = responded.filter((r) => r.name.length > 100 || String(r.value).length > 100);
    console.log('invalid lengths:', bad.length);
  }

  // second call should hit the cache
  const t1 = Date.now();
  await playCmd.autocomplete(mockInteraction, ctx);
  console.log('cached call took', Date.now() - t1, 'ms');

  client.destroy();
  process.exit(0);
}

main().catch((e) => {
  console.error('AUTOCOMPLETE TEST FAILED:', e);
  process.exit(1);
});
