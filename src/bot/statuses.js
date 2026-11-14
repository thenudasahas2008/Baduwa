// Massive collection of music bot statuses (over 1,000 unique combinations).
// Categories: DJ vibes, aesthetic lo-fi, genre highlights, command tips, and dynamic combos.

const PREFIXES = [
  'Vibing to', 'Playing', 'Spinning', 'Streaming', 'Blasting', 'Mixing',
  'Jamming to', 'Cueing up', 'Dropping', 'Grooving to', 'Bumping', 'Echoing',
  'Tuned into', 'Lost in', 'Chilling with', 'Rocking out to', 'Diving into',
  'Serving up', 'Crafting', 'Curating', 'Pumping', 'Looping', 'Syncing with',
  'Cruising with', 'Vibing with', 'Hyping up', 'Floating to'
];

const GENRES_AND_THEMES = [
  'late night lo-fi beats 🌙', 'bass-boosted phonk 🚗💨', 'chill hop study session ☕',
  'high-energy EDM drops ⚡', 'heavy 808 trap rhythms 🔊', 'neon synthwave vibes 🌆',
  'smooth acoustic melodies 🎸', 'cyberpunk electronic beats 🤖', 'retro 80s pop anthems 🪩',
  'deep house club tunes 🕺', 'anime OST masterpieces 🌸', 'relaxing ambient waves 🌊',
  'hardstyle festival kicks 🎆', 'melodic progressive house 🎶', 'classic rock anthems ⚡',
  'jazzy coffeehouse rhythms 🎷', 'summer beach party hits 🏖️', 'heavy metal guitar solos 🎸',
  'atmospheric dream pop ✨', 'hyperpop sonic chaos 💥', 'underground indie tracks 📻',
  'orchestral epic battle music 🎻', 'soulful R&B grooves 💜', 'reggae sunshine vibes 🌴',
  'future bass melodies 🌈', 'drum & bass rollers 🥁', 'lo-fi rainy day nostalgia 🌧️',
  'hard techno rave beats 🏭', 'gaming hype anthems 🎮', 'midnight drive playlist 🌃',
  'golden era 90s hip-hop 🎤', 'funk groove sensations 🕶️', 'space ambient journeys 🚀',
  'tropical house poolside vibes 🍹', 'dark electro underground beats 🕷️',
  'acoustic guitar serenades 🌾', 'Eurobeat drift tracks 🏎️💨', 'kawaii future bass cute tunes 🎀',
  'chill piano meditations 🎹', 'synth-pop neon city dreams 🏙️'
];

const STATIC_STATUSES = [
  // --- Bot Identity & 24/7 ---
  '🎧 Baduwa Music — Live 24/7',
  '♾️ Never sleeping, always streaming',
  '🎛️ DJ Baduwa on the decks',
  '🎶 Nonstop beats for the server',
  '☕ Voice channel chill lounge',
  '🔊 Zero-lag crystal clear audio',
  '⚡ 24/7 party mode active',
  '🎵 Mixing some fresh tunes',
  '🔥 Cueing up the next banger',
  '📻 Your 24/7 community radio',
  '💜 Good vibes only in voice chat',
  '🌟 Bringing life to the server',
  '🚀 High-fidelity soundscapes',
  '📀 Spinning the finest vinyl',
  '🤖 AI-curated sonic perfection',

  // --- Command Helpers ---
  '👉 Type /play to drop a track',
  '🔮 Try /autoplay for infinite radio',
  '🔁 Cycle repeat modes with /loop',
  '📜 View upcoming songs with /queue',
  '🔀 Mix things up with /shuffle',
  '🔊 Pump up the sound with /volume',
  '⏮️ Replay your favorites with /previous',
  '⏭️ Skip to the next track with /skip',
  '⏹️ Type /stop to clear playback',
  '💡 Need help? Type /help for all commands',
  '🎛️ Click the buttons to control music!',
  '⚡ Use /247 to keep me in voice forever',
  '🔎 Fast search autocomplete in /play',
  '🎵 Supports YouTube, Spotify & SoundCloud',

  // --- Fun & Aesthetic ---
  '🎧 Headphones on, world off',
  '🚿 Singing loudly in the shower',
  '🔊 Neighbors called... they love the music!',
  '☕ Powered by coffee and bass',
  '🕺 Can you hear that rhythm?',
  '💃 Dancing like nobody is watching',
  '🌙 Midnight lo-fi & peaceful thoughts',
  '🚗 Driving into the neon sunset',
  '🌌 Lost in an ocean of sound waves',
  '🔥 This track is pure fire',
  '✨ Bass that shakes the channel',
  '🎶 The soundtrack to your victory',
  '🎮 Soundtrack for late-night gaming',
  '🎈 Floating on a cloud of melodies',
  '🌈 Painting the sky with frequencies',
  '💎 Pure audio gems only',
  '💥 When words fail, music speaks',
  '🎼 Every moment deserves a theme song',
  '🍕 Pizza, code & high-energy beats',
  '⚡ High voltage sound delivery',
  '🌸 Peaceful blossoms and gentle chords',
  '🪐 Orbiting through celestial frequencies',
  '🏖️ Golden hour on the soundwaves',
  '🕶️ Too cool for bad music',
  '🎤 Mic check, one two, one two'
];

function generateAllStatuses() {
  const set = new Set(STATIC_STATUSES);
  for (const prefix of PREFIXES) {
    for (const genre of GENRES_AND_THEMES) {
      set.add(`${prefix} ${genre}`);
      set.add(`Now ${prefix.toLowerCase()} ${genre}`);
    }
  }
  for (const genre of GENRES_AND_THEMES) {
    set.add(`Serving ${genre}`);
    set.add(`Vibes: ${genre}`);
    set.add(`Mood: ${genre}`);
    set.add(`Playlist: ${genre}`);
  }
  return Array.from(set);
}

const ALL_STATUSES = generateAllStatuses();

module.exports = {
  ALL_STATUSES,
  STATIC_STATUSES,
  TOTAL_STATUSES: ALL_STATUSES.length,
};
