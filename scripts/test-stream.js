// CRITICAL test: does streaming work for a search-derived track?
const { Client } = require('discord.js');
const { Player } = require('discord-player');
const { YoutubeExtractor } = require('discord-player-youtubei');

async function main() {
  const client = new Client({ intents: [] });
  const player = new Player(client);
  await player.extractors.loadDefault((ext) => ext !== 'YouTubeExtractor', {});
  await player.extractors.register(YoutubeExtractor, {});

  const res = await player.search('Alan Walker Faded', { searchEngine: 'youtubeSearch' });
  const track = res.tracks[0];
  console.log('track:', track.title, track.url);

  const ext = player.extractors.get('com.retrouser955.discord-player.discord-player-youtubei');
  const t0 = Date.now();
  try {
    const stream = await ext.stream(track);
    console.log('STREAM OK in', Date.now() - t0, 'ms');
    console.log('type:', typeof stream, '| ctor:', stream?.constructor?.name);
    if (typeof stream === 'string') {
      console.log('  url stream (adaptive):', stream.slice(0, 90));
    } else if (stream?.readableLength !== undefined || stream instanceof require('stream').Readable) {
      // consume a chunk to prove it flows
      const chunk = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no data in 15s')), 15000);
        stream.once('data', (d) => { clearTimeout(t); resolve(d); });
        stream.once('error', (e) => { clearTimeout(t); reject(e); });
      });
      console.log('  got first chunk:', chunk.length, 'bytes');
      stream.destroy();
    }
  } catch (e) {
    console.error('STREAM FAILED:', String(e).slice(0, 300));
  }

  client.destroy();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
