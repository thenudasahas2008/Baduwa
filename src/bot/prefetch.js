// Prefetch engine: warms up the stream of the NEXT track while the current one is playing.
// This removes the biggest delay source (stream URL resolution + connection setup) so
// back-to-back songs feel instant.
//
// discord-player calls `queue.options.onBeforeCreateStream(track, queryType, queue)` before
// streaming a track. If we return a pre-resolved stream, it is used directly. The runtime
// accepts Readable streams AND plain URL strings (FFmpeg handles both).

const TTL_MS = 6 * 60 * 1000; // resolved streams live max 6 minutes
const MAX_ENTRIES = 3;

/** @type {Map<string, {stream: any, at: number}>} */
const cache = new Map();

function prune() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > TTL_MS) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    cache.delete(oldest[0]);
  }
}

function set(track, stream) {
  if (!track || stream == null) return;
  prune();
  cache.set(track.id, { stream, at: Date.now() });
}

function take(track) {
  if (!track) return null;
  const entry = cache.get(track.id);
  if (!entry) return null;
  cache.delete(track.id);
  if (Date.now() - entry.at > TTL_MS) return null;
  return entry.stream;
}

function clear() {
  cache.clear();
}

// Resolve the extractor stream for a track. Returns Readable | string | null.
async function resolveStream(track) {
  try {
    const ext = track.extractor;
    if (!ext || typeof ext.stream !== 'function') return null;
    const stream = await ext.stream(track);
    return stream == null ? null : stream;
  } catch {
    return null;
  }
}

// Kick off a prefetch for the next track in the queue (fire & forget).
function prefetchNext(queue) {
  try {
    if (!queue || queue.isEmpty() || !queue.tracks || queue.size < 1) return;
    const next = queue.tracks.at(0);
    if (!next || cache.has(next.id)) return;
    resolveStream(next).then((stream) => {
      if (stream != null) set(next, stream);
    });
  } catch {
    /* prefetch is best-effort only */
  }
}

// The hook passed to every queue via GuildNodeCreateOptions.onBeforeCreateStream
async function onBeforeCreateStream(track) {
  const pre = take(track);
  return pre || null;
}

module.exports = { prefetchNext, onBeforeCreateStream, resolveStream, clear, _cache: cache };
