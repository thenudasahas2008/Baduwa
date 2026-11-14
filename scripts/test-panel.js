// Test suite for ZYRO-style now-playing panel:
// Asserts progress-bar math (50% marker centered), button counts (<= 5 per row),
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

  // 1) 50% marker at half duration with default size 9
  const bar50 = createProgressBar(150_000, 300_000, 9);
  console.log('  50% bar:', bar50);
  assert(bar50.includes('▬▬▬▬●▬▬▬▬'), 'Expected 50% bar to have marker centered: ▬▬▬▬●▬▬▬▬');
  const [left, right] = bar50.split(' ')[0].split('●');
  assert.strictEqual(left.length, right.length, 'Expected equal number of bars on both sides of marker at 50%');

  // 2) 0% marker at beginning
  const bar0 = createProgressBar(0, 100_000, 9);
  console.log('  0% bar:', bar0);
  assert(bar0.startsWith('●▬▬▬▬▬▬▬▬'), 'Expected marker at start for 0%');

  // 3) 100% marker at end
  const bar100 = createProgressBar(100_000, 100_000, 9);
  console.log('  100% bar:', bar100);
  assert(bar100.split(' ')[0].endsWith('●'), 'Expected marker at end for 100%');

  console.log('  -> Progress bar tests PASSED');
}

function testButtonsAndRows() {
  console.log('Testing button counts and IDs...');
  const rows = buildPanelButtons({ isPaused: false, autoplay: true, loopMode: 0 });
  assert.strictEqual(rows.length, 2, 'Expected exactly 2 action rows');

  const row1 = rows[0].components;
  const row2 = rows[1].components;

  assert(row1.length <= 5, 'Row 1 cannot exceed 5 buttons');
  assert(row2.length <= 5, 'Row 2 cannot exceed 5 buttons');
  assert.strictEqual(row1.length, 5, 'Expected 5 buttons in Row 1');
  assert.strictEqual(row2.length, 5, 'Expected 5 buttons in Row 2');

  const row1Ids = row1.map((b) => b.data.custom_id);
  const row2Ids = row2.map((b) => b.data.custom_id);

  assert.deepStrictEqual(row1Ids, ['panel_pause', 'panel_skip', 'panel_previous', 'panel_stop', 'panel_shuffle']);
  assert.deepStrictEqual(row2Ids, ['panel_autoplay', 'panel_loop', 'panel_queue', 'panel_volup', 'panel_voldown']);

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
    title: 'Gaulois - Jolie feat. @ninho',
    author: 'Gaulois officiel',
    url: 'https://www.youtube.com/watch?v=fake123',
    thumbnail: 'https://i.ytimg.com/vi/fake123/hqdefault.jpg',
    durationMS: 261_000,
    requestedBy: { id: '999999999' },
  };

  const fakeQueue = {
    guild: { id: 'guild-123' },
    client: { user: { username: 'Baduwa' } },
    currentTrack: fakeTrack,
    node: {
      volume: 100,
      isPaused: () => false,
      getTimestamp: () => ({ current: { value: 187_000 }, total: { value: 261_000 } }),
    },
    tracks: { size: 3 },
    repeatMode: 0,
  };

  const panel = buildPanel(fakeQueue, fakeTrack);
  assert(panel.embeds && panel.embeds.length === 1, 'Expected 1 embed');
  assert(panel.components && panel.components.length === 2, 'Expected 2 action rows');

  const embed = panel.embeds[0].data;
  assert(embed.title.includes('Gaulois - Jolie'), 'Embed title must include song name');
  assert(embed.description.includes('Gaulois officiel'), 'Embed description must include artist');
  assert.strictEqual(embed.image.url, fakeTrack.thumbnail, 'Embed image must match track thumbnail');

  const fieldNames = embed.fields.map((f) => f.name);
  assert(fieldNames.includes('Volume'), 'Embed must include Volume field');
  assert(fieldNames.includes('Queue'), 'Embed must include Queue field');
  assert(fieldNames.includes('Loop'), 'Embed must include Loop field');
  assert(fieldNames.includes('Autoplay Radio'), 'Embed must include Autoplay Radio field');

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
