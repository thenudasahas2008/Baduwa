// Diagnostic: why does innertube search return 0 tracks in this environment?
const { getInnertube } = require('discord-player-youtubei');

(async () => {
  try {
    const tube = await getInnertube({});
    console.log('innertube instance ok, actions:', typeof tube?.actions);
    const res = await tube.search('Alan Walker Faded');
    const list = res && res.results ? res.results : [];
    console.log('raw innertube search results:', list.length);
    for (const r of list.slice(0, 5)) {
      console.log(' -', r?.type, r?.title?.text || r?.title || '');
    }
  } catch (e) {
    console.error('innertube ERR:', e && (e.stack || e.message || e));
  }
  process.exit(0);
})();
