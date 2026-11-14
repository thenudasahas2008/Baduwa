// Diagnostic: test the exact search paths the bot's music.js uses.
const { Client } = require('discord.js');
const { Player, QueryType } = require('discord-player');
const { YoutubeExtractor } = require('discord-player-youtubei');

(async () => {
  const client = new Client({ intents: [] });
  const player = new Player(client);
  player.on('debug', (msg) => {
    const s = typeof msg === 'string' ? msg : (msg && msg.message) || JSON.stringify(msg);
    console.log('[dbg]', String(s).slice(0, 500));
  });
  await player.extractors.loadDefault((ext) => ext !== 'YouTubeExtractor');
  await player.extractors.register(YoutubeExtractor, {});

  // path A: explicit youtube search engine (what music.js + autocomplete use)
  const a = await player.search('Alan Walker Faded', { searchEngine: QueryType.YOUTUBE_SEARCH }).catch((e) => ({ err: e.message }));
  console.log('A explicit youtubeSearch ->', a.err ? 'ERR ' + a.err : `${a.tracks.length} tracks`, '|', a.tracks && a.tracks[0] && a.tracks[0].title);

  // path B: default engine (no searchEngine option)
  const b = await player.search('Alan Walker Faded', {}).catch((e) => ({ err: e.message }));
  console.log('B default engine ->', b.err ? 'ERR ' + b.err : `${b.tracks.length} tracks`, '|', b.tracks && b.tracks[0] && b.tracks[0].title);

  // path C: youtube video url
  const c = await player.search('https://www.youtube.com/watch?v=60ItHLz5WEA', {}).catch((e) => ({ err: e.message }));
  console.log('C yt url ->', c.err ? 'ERR ' + c.err : `${c.tracks.length} tracks`, '|', c.tracks && c.tracks[0] && c.tracks[0].title);

  // path D: stream resolution for first found track
  const track = (a.tracks && a.tracks[0]) || (c.tracks && c.tracks[0]);
  if (track) {
    try {
      const ext = player.extractors.get('com.retrouser955.discord-player.discord-player-youtubei');
      const s = await ext.stream(track);
      console.log('D stream ->', typeof s, '|', s && s.constructor && s.constructor.name);
      if (typeof s.destroy === 'function') s.destroy();
    } catch (e) {
      console.log('D stream ERR', String(e).slice(0, 200));
    }
  }

  client.destroy();
  process.exit(0);
})();
