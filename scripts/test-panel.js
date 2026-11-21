// Test suite for now-playing panel:
// Asserts progress-bar math (50% marker centered with clean line '─' and marker '🔵'),
// button counts (<= 5 per row, 4 rows total),
// label toggles (Pause<->Resume), loop cycle (Off->Track->Queue->Off),
// and volume clamping (0-150).
const assert = require('node:assert');
const {
  buildPanel,
  buildPanelButtons,
  createProgressBar,
  getNextLoopMode,
  getLoopModeLabel,
  clampVolume,
} = require('../src/bot/panel');

function testProgressBar() {
  console.log('Testing progress bar...');

  // 1) 50% marker at half duration with default size 12
  const bar50 = createProgressBar(150_000, 300_000, 12);
  console.log('  50% bar:', bar50);
  assert(bar50.includes('🔵'), 'Expected bar to have marker 🔵');
  assert(bar50.includes('─'), 'Expected bar to use smooth continuous line ─');
  const [left, right] = bar50.split('🔵');
  assert.strictEqual(left.length, right.length, 'Expected equal number of line characters on both sides at 50%');

  // 2) 0% marker at beginning
  const bar0 = createProgressBar(0, 100_000, 12);
  console.log('  0% bar:', bar0);
  assert(bar0.startsWith('🔵'), 'Expected marker at start for 0%');

  // 3) 100% marker at end
  const bar100 = createProgressBar(100_000, 100_000, 12);
  console.log('  100% bar:', bar100);
  assert(bar100.endsWith('🔵'), 'Expected marker at end for 100%');

  console.log('  -> Progress bar tests PASSED');
}

function testButtonsAndRows() {
  console.log('Testing button counts and IDs...');
  const rows = buildPanelButtons({ isPaused: false, autoplay: true, loopMode: 0 });
  assert.strictEqual(rows.length, 4, 'Expected exactly 4 action rows matching ZYRO card');

  for (let i = 0; i < rows.length; i++) {
    const comps = rows[i].components;
    assert(comps.length <= 5, `Row ${i + 1} cannot exceed 5 buttons`);
  }

  const row1 = rows[0].components;
  const row2 = rows[1].components;
  const row3 = rows[2].components;
  const row4 = rows[3].components;

  assert.strictEqual(row1.length, 3, 'Expected 3 buttons in Row 1 (Pause, Skip, Shuffle)');
  assert.strictEqual(row2.length, 1, 'Expected 1 button in Row 2 (Stop)');
  assert.strictEqual(row3.length, 3, 'Expected 3 buttons in Row 3 (Previous, Autoplay, Queue)');
  assert.strictEqual(row4.length, 3, 'Expected 3 buttons in Row 4 (Loop, Vol+, Vol-)');

  const row1Ids = row1.map((b) => b.data.custom_id);
  const row2Ids = row2.map((b) => b.data.custom_id);
  const row3Ids = row3.map((b) => b.data.custom_id);
  const row4Ids = row4.map((b) => b.data.custom_id);

  assert.deepStrictEqual(row1Ids, ['panel_pause', 'panel_skip', 'panel_shuffle']);
  assert.deepStrictEqual(row2Ids, ['panel_stop']);
  assert.deepStrictEqual(row3Ids, ['panel_previous', 'panel_autoplay', 'panel_queue']);
  assert.deepStrictEqual(row4Ids, ['panel_loop', 'panel_volup', 'panel_voldown']);

  console.log('  -> Button count and custom_id tests PASSED');
}

function testLabelToggles() {
  console.log('Testing Pause / Resume label toggle...');
  // Playing (not paused)
  const rowsPlaying = buildPanelButtons({ isPaused: false });
  const pauseBtn = rowsPlaying[0].components[0];
  assert.strictEqual(pauseBtn.data.label, 'Pause', 'Expected label to be Pause when playing');

  // Paused
  const rowsPaused = buildPanelButtons({ isPaused: true });
  const resumeBtn = rowsPaused[0].components[0];
  assert.strictEqual(resumeBtn.data.label, 'Resume', 'Expected label to be Resume when paused');

  console.log('  -> Pause/Resume toggle tests PASSED');
}

function testLoopCycle() {
  console.log('Testing Loop cycle (Off -> Track -> Queue -> Off)...');
  // 0 (Off) -> 1 (Track)
  const step1 = getNextLoopMode(0);
  assert.strictEqual(step1, 1, 'Expected 0 (Off) to cycle to 1 (Track)');
  assert.strictEqual(getLoopModeLabel(step1), 'Track');

  // 1 (Track) -> 2 (Queue)
  const step2 = getNextLoopMode(1);
  assert.strictEqual(step2, 2, 'Expected 1 (Track) to cycle to 2 (Queue)');
  assert.strictEqual(getLoopModeLabel(step2), 'Queue');

  // 2 (Queue) -> 0 (Off)
  const step3 = getNextLoopMode(2);
  assert.strictEqual(step3, 0, 'Expected 2 (Queue) to cycle to 0 (Off)');
  assert.strictEqual(getLoopModeLabel(step3), 'Off');

  console.log('  -> Loop cycle tests PASSED');
}

function testVolumeClamping() {
  console.log('Testing Volume clamping (0-150)...');
  assert.strictEqual(clampVolume(-50), 0, 'Volume below 0 must clamp to 0');
  assert.strictEqual(clampVolume(0), 0);
  assert.strictEqual(clampVolume(75), 75);
  assert.strictEqual(clampVolume(150), 150);
  assert.strictEqual(clampVolume(200), 150, 'Volume above 150 must clamp to 150');
  console.log('  -> Volume clamping tests PASSED');
}

function testPanelConstruction() {
  console.log('Testing buildPanel with fake queue...');
  const fakeTrack = {
    title: 'Bruno Mars - Just The Way You Are (Official Music Video)',
    author: 'Bruno Mars',
    url: 'https://www.youtube.com/watch?v=fake123',
    thumbnail: 'https://i.ytimg.com/vi/fake123/hqdefault.jpg',
    durationMS: 237_000,
    requestedBy: { id: '999999999' },
  };

  const fakeQueue = {
    guild: { id: 'guild-123' },
    client: { user: { username: 'Baduwa', displayAvatarURL: () => 'https://example.com/avatar.png' } },
    currentTrack: fakeTrack,
    node: {
      volume: 100,
      isPaused: () => false,
      getTimestamp: () => ({ current: { value: 52_000 }, total: { value: 237_000 } }),
    },
    tracks: { size: 0 },
    repeatMode: 0,
  };

  const panel = buildPanel(fakeQueue, fakeTrack);
  assert(panel.embeds && panel.embeds.length === 1, 'Expected 1 embed');
  assert(panel.components && panel.components.length === 4, 'Expected 4 action rows');

  const embed = panel.embeds[0].data;
  assert(embed.title.includes('Bruno Mars - Just The Way You Are'), 'Embed title must include song name');
  assert(embed.description.includes('Bruno Mars'), 'Embed description must include artist');
  assert(embed.description.includes('──🔵─────────'), 'Description must include smooth progress bar');
  assert(embed.description.includes('0:52 / 3:57'), 'Description must include formatted timestamps');
  assert(embed.description.includes('100%'), 'Description must include volume indicator');
  assert(embed.description.includes('`0` in queue'), 'Description must include queue indicator');
  assert(embed.description.includes('Loop: `Off`'), 'Description must include loop indicator');
  assert(embed.description.includes('Autoplay Radio'), 'Description must include autoplay radio indicator');
  assert.strictEqual(embed.thumbnail.url, fakeTrack.thumbnail, 'Embed thumbnail must match track thumbnail');
  assert.strictEqual(embed.color, 0x7b2cbf, 'Embed color must be purple (0x7b2cbf)');
  assert(embed.author.name.includes('NOW PLAYING'), 'Author must include NOW PLAYING');
  assert(embed.footer.text.includes('Baduwa Music'), 'Footer must contain bot name');

  console.log('  -> buildPanel tests PASSED');
}

function main() {
  testProgressBar();
  testButtonsAndRows();
  testLabelToggles();
  testLoopCycle();
  testVolumeClamping();
  testPanelConstruction();
  console.log('\n✅ ALL PANEL TESTS PASSED!');
}

main();
