// Debug tool: verify extractors + search + stream resolution without logging into Discord
const { Client } = require('discord.js');
const { Player, QueryType } = require('discord-player');
const { YoutubeExtractor } = require('discord-player-youtubei');

async function main() {
  const client = new Client({ intents: [] });
  const player = new Player(client);

  const def = await player.extractors.loadDefault((ext) => ext !== 'YouTubeExtractor', {
    SpotifyExtractor: {
      clientId: process.env.DP_SPOTIFY_CLIENT_ID || undefined,
      clientSecret: process.env.DP_SPOTIFY_CLIENT_SECRET || undefined,
    },
  });
  console.log('loadDefault:', def);
  await player.extractors.register(YoutubeExtractor, {});
  console.log('registered extractors:', player.extractors.store.map((e) => e.identifier).join(', '));

  // 1) plain name search (same path the bot's music.js uses)
  const t0 = Date.now();
  const res = await player
    .search('Alan Walker Faded', { requestedBy: null, searchEngine: QueryType.YOUTUBE_SEARCH })
    .catch(() => ({ tracks: [] }));
  console.log(`name search: ${res.tracks.length} tracks in ${Date.now() - t0}ms`);
  if (res.tracks.length) {
    const t = res.tracks[0];
    console.log('  first:', t.title, '| by', t.author, '|', t.duration, '| source:', t.source, '| ext:', t.extractor?.identifier);
  }

  // 2) youtube url
  const yt = await player.search('https://www.youtube.com/watch?v=60ItHLz5WEA', { requestedBy: null });
  console.log('yt url:', yt.tracks[0]?.title, '| ext:', yt.tracks[0]?.extractor?.identifier);

  // 3) spotify url (may fail without credentials)
  try {
    const sp = await player.search('https://open.spotify.com/track/4cOdK2wEJKp6aa8d7t2v3m', { requestedBy: null });
    console.log('spotify url:', sp.tracks[0]?.title, '| ext:', sp.tracks[0]?.extractor?.identifier);
  } catch (e) {
    console.log('spotify url failed (expected without creds):', String(e).slice(0, 120));
  }

  // 4) stream resolution for first track (checks innertube streaming works)
  const track = res.tracks[0];
  const t1 = Date.now();
  if (!track) {
    console.log('stream skipped: no track found in step 1');
  } else {
    try {
      const ext = player.extractors.get('com.retrouser955.discord-player.discord-player-youtubei');
      const stream = await ext.stream(track);
      if (stream == null) {
        console.log(
          'stream resolved to NOTHING in',
          Date.now() - t1,
          'ms — YouTube is gating this IP (datacenter/free-host IPs get this).',
          'On your home PC it usually works; on free hosts set YOUTUBE_COOKIE (docs/SETUP.md).'
        );
      } else {
        console.log('stream ok in', Date.now() - t1, 'ms, type:', typeof stream, stream?.constructor?.name);
        if (typeof stream === 'string') console.log('  -> url stream');
        if (typeof stream.destroy === 'function') stream.destroy();
      }
    } catch (e) {
      console.log('stream failed:', String(e).slice(0, 200));
    }
  }

  client.destroy();
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
