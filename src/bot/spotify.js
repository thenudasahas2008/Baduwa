// Spotify resolver: turns open.spotify.com links into playable queries via the official Web API.
// Falls back to `player.search(url)` (spotify-url-info scraper) when credentials are absent.
const config = require('../config');

const API = 'https://api.spotify.com/v1';

let token = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (!config.spotify.enabled) return null;
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;

  const basic = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);
  const json = await res.json();
  token = json.access_token;
  tokenExpiresAt = Date.now() + json.expires_in * 1000;
  return token;
}

// parse a spotify url / uri -> { kind: 'track'|'album'|'playlist', id } | null
function parseSpotifyUrl(input) {
  const str = String(input || '').trim();
  let m = str.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)$/);
  if (m) return { kind: m[1], id: m[2] };
  m = str.match(/https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i);
  if (m) return { kind: m[1], id: m[2] };
  return null;
}

function isSpotifyUrl(input) {
  return parseSpotifyUrl(input) != null;
}

function artistLine(item) {
  return (item.artists || []).map((a) => a.name).filter(Boolean).join(', ');
}

function itemToQuery(item) {
  const title = item.name || item.title;
  if (!title) return null;
  const artist = artistLine(item);
  return artist ? `${title} ${artist}` : title;
}

async function apiGet(kind, id) {
  const tok = await getToken();
  if (!tok) return null;
  const endpoints = {
    track: `${API}/tracks/${id}`,
    album: `${API}/albums/${id}`,
    playlist: `${API}/playlists/${id}`,
  };
  const url = endpoints[kind] + (kind === 'playlist' ? '/tracks?limit=100' : '');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) throw new Error(`Spotify API ${res.status} for ${kind}/${id}`);
  return res.json();
}

/**
 * Resolve a spotify link into a list of search queries.
 * @returns {Promise<{kind, title, count, queries: string[], thumbnail?}|null>} null when credentials missing
 */
async function resolveLink(input) {
  if (!config.spotify.enabled) return null;
  const parsed = parseSpotifyUrl(input);
  if (!parsed) return null;

  if (parsed.kind === 'track') {
    const data = await apiGet('track', parsed.id);
    const q = itemToQuery(data);
    if (!q) return null;
    return {
      kind: 'track',
      title: `${data.name} — ${artistLine(data)}`,
      count: 1,
      queries: [q],
      thumbnail: (data.album && data.album.images && data.album.images[0] && data.album.images[0].url) || undefined,
    };
  }

  if (parsed.kind === 'album') {
    const data = await apiGet('album', parsed.id);
    const queries = (data.tracks && data.tracks.items ? data.tracks.items : []).map(itemToQuery).filter(Boolean);
    if (!queries.length) return null;
    return {
      kind: 'album',
      title: data.name || 'Spotify Album',
      count: queries.length,
      queries,
      thumbnail: (data.images && data.images[0] && data.images[0].url) || undefined,
    };
  }

  const data = await apiGet('playlist', parsed.id);
  const items = (data.items || []).map((i) => i.track).filter(Boolean);
  const queries = items.map(itemToQuery).filter(Boolean);
  if (!queries.length) return null;
  return {
    kind: 'playlist',
    title: data.name || 'Spotify Playlist',
    count: queries.length,
    queries,
    thumbnail: (data.images && data.images[0] && data.images[0].url) || undefined,
  };
}

module.exports = { isSpotifyUrl, parseSpotifyUrl, resolveLink, getToken };
