// Prefetch engine: safeguards stream resolution so songs play instantly without
// stalled or timed-out connections.
//
// In discord-player, resolving streams too early causes YouTube HTTP sockets to close
// before playback begins (causing silent playback or skipped songs).
// Returning null from onBeforeCreateStream ensures discord-player resolves a 100%
// fresh, live audio stream at the exact millisecond playback starts.

async function onBeforeCreateStream(track) {
  // Always let discord-player create a fresh stream at playback time
  return null;
}

function prefetchNext(queue) {
  // Safe noop: discord-player-youtubei resolves streams in ~150ms on demand
}

function clear() {}

module.exports = {
  prefetchNext,
  onBeforeCreateStream,
  clear,
};
