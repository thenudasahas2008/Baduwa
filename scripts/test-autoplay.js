// Deterministic test for the autoplay recommendation engine. No Lavalink/network required.
// Tests deduplication, multi-seed accumulation, artist diversity, per-guild cooldowns,
// collaboration handling, channel diversity, and graceful fallbacks.
// Run: node scripts/test-autoplay.js  (exits non-zero on any failed assertion)

const assert = require('node:assert/strict');
const {
    normalizeString,
    normalizeArtist,
    extractCollaborators,
    detectMusicContext,
} = require('../src/utils/trackText');

// Pin the target before loading autoplay — it reads AUTOPLAY_TARGET_COUNT at require time.
process.env.AUTOPLAY_TARGET_COUNT = '25';
const { findAutoplayTracks, historyManager } = require('../src/utils/autoplay');

let passed = 0;
function check(name, fn) {
    return fn().then(() => { passed++; console.log(`  ok  - ${name}`); })
        .catch((err) => { console.error(`FAIL - ${name}\n      ${err.message}`); process.exitCode = 1; });
}

function track(id, title, opts = {}) {
    return {
        info: {
            identifier: id,
            title,
            author: opts.author || 'Artist',
            sourceName: opts.sourceName || 'youtube',
            isrc: opts.isrc || null,
            isStream: opts.isStream || false,
        },
    };
}

// Fake player whose search() returns canned RD mixes and complementary searches
function makePlayer({ previous = [], mixes = {}, searches = {}, guildId = 'test-guild' }) {
    return {
        guildId,
        queue: { current: null, previous, tracks: [] },
        async search({ query }) {
            const m = query.match(/list=RD([^&]+)/);
            if (m) {
                const id = m[1];
                const tracks = (mixes[id] || []).map((t) => track(t.id, t.title, t));
                return { loadType: 'playlist', tracks };
            }
            for (const [key, list] of Object.entries(searches)) {
                if (query.includes(key)) {
                    const tracks = (list || []).map((t) => track(t.id, t.title, t));
                    return { loadType: 'search', tracks };
                }
            }
            return { loadType: 'empty', tracks: [] };
        },
    };
}

function ids(list) { return list.map((t) => t.info.identifier); }
function hasUnique(arr) { return new Set(arr).size === arr.length; }

async function main() {
    // ── Scenario 1: dedup + multi-seed accumulation + non-music + ISRC ──
    await check('1. Dedups ids/titles/isrc, excludes seed+recent, accumulates across seeds, drops non-music', async () => {
        const seed = track('s1', 'Seed Song');
        const recent = track('h1', 'Old Song');
        const player = makePlayer({
            previous: [recent],
            mixes: {
                s1: [
                    { id: 's1', title: 'Seed Song' },                 // the seed itself -> excluded
                    { id: 'h1', title: 'Old Song' },                  // recent history -> excluded
                    { id: 'a1', title: 'Alpha' },
                    { id: 'a2', title: 'Alpha' },                     // same title -> dedup
                    { id: 'b1', title: 'Beta (Live)' },
                    { id: 'b2', title: 'Beta (Official Video)' },     // same recording -> dedup
                    { id: 'g1', title: 'Eta', isrc: 'ISRC0001' },
                    { id: 'g2', title: 'Totally Different Name', isrc: 'ISRC0001' }, // same ISRC -> dedup
                    { id: 'r1', title: 'Alpha Song Reaction!' },      // non-music -> excluded from collected
                    { id: 'c1', title: 'Gamma' },
                    { id: 'd1', title: 'Delta' },
                ],
                h1: [
                    { id: 'a1', title: 'Alpha' },                     // cross-seed dup -> excluded
                    { id: 'c1', title: 'Gamma' },                     // cross-seed dup -> excluded
                    { id: 'e1', title: 'Epsilon' },                  // new, only reachable via 2nd seed
                    { id: 'f1', title: 'Zeta' },                     // new
                ],
            },
        });

        const out = await findAutoplayTracks(player, seed);
        const outIds = ids(out);

        assert.ok(!outIds.includes('s1') && !outIds.includes('h1'), 'must exclude seed and recent history');
        assert.ok(hasUnique(outIds), `ids must be unique, got ${outIds}`);
        assert.ok(hasUnique(out.map((t) => normalizeString(t.info.title))), 'normalized titles must be unique');
        const isrcs = out.map((t) => t.info.isrc).filter(Boolean);
        assert.ok(hasUnique(isrcs), 'isrcs must be unique');
        assert.ok(!outIds.includes('r1'), 'non-music reaction must be excluded');
        // Reachable only from the 2nd seed -> proves accumulation across seeds.
        assert.ok(outIds.includes('e1') && outIds.includes('f1'), 'must accumulate from second seed');
        assert.equal(out.length, 7, `expected 7 unique tracks, got ${out.length} (${outIds})`);
    });

    // ── Scenario 2: caps at AUTOPLAY_TARGET (25) ──
    await check('2. Caps the batch at 25', async () => {
        const big = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `Song ${i}` }));
        const player = makePlayer({ previous: [], mixes: { seedBig: big } });
        const out = await findAutoplayTracks(player, track('seedBig', 'Seed'));
        assert.equal(out.length, 25, `expected cap of 25, got ${out.length}`);
        assert.ok(hasUnique(ids(out)), 'ids unique under cap');
    });

    // ── Scenario 3: only non-music available -> fall back rather than return silence ──
    await check('3. Falls back to non-music only when nothing else is available', async () => {
        const player = makePlayer({
            previous: [],
            mixes: { onlyjunk: [{ id: 'x1', title: 'Live Stream', isStream: true }, { id: 'x2', title: 'Gameplay Highlights' }] },
        });
        const out = await findAutoplayTracks(player, track('onlyjunk', 'Seed'));
        assert.ok(out.length >= 1, 'should return a fallback rather than nothing');
    });

    // ── Scenario 4: non-YouTube seed with no YT history -> empty (no search fallback) ──
    await check('4. Returns [] for a non-YouTube seed with no usable history', async () => {
        const player = makePlayer({ previous: [], mixes: {} });
        const out = await findAutoplayTracks(player, track('sp1', 'Spotify Song', { sourceName: 'spotify' }));
        assert.equal(out.length, 0, 'no YT seed -> no recommendations');
    });

    // ── Scenario 5: title normaliser collapses version variants ──
    await check('5. normalizeString collapses common version variants', async () => {
        const base = normalizeString('Blinding Lights');
        for (const v of [
            'Blinding Lights (Official Video)',
            'Blinding Lights (Official Music Video)',
            'Blinding Lights [Lyric Video]',
            'Blinding Lights (Live)',
            'Blinding Lights - Topic',
            'Blinding Lights (sped up)',
            'Blinding Lights (feat. Someone)',
            'Blinding Lights (Remastered 2020)',
        ]) {
            assert.equal(normalizeString(v), base, `"${v}" should normalize to "${base}"`);
        }
        assert.notEqual(normalizeString('Video Games'), normalizeString('Games'), 'distinct titles must stay distinct');
    });

    // ── Scenario 6: Artist diversity prevents single artist domination (Zany Inzane fix) ──
    await check('6. Artist diversity prioritizes diverse artists and avoids artist domination', async () => {
        historyManager.clearGuild('g-zany');
        const seed = track('seedZ', 'Seed Song', { author: 'Zany Inzane' });
        const player = makePlayer({
            guildId: 'g-zany',
            mixes: {
                seedZ: [
                    { id: 'z1', title: 'Zany Track 1', author: 'Zany Inzane' },
                    { id: 'z2', title: 'Zany Track 2', author: 'Zany Inzane' },
                    { id: 'z3', title: 'Zany Track 3', author: 'Zany Inzane' },
                    { id: 'z4', title: 'Zany Track 4', author: 'Zany Inzane' },
                    { id: 'c1', title: 'Chitral Hit', author: 'Chitral Somapala' },
                    { id: 'b1', title: 'Baila Classic', author: 'Baila Boy' },
                    { id: 's1', title: 'Sunil Song', author: 'Sunil Perera' },
                ],
            },
        });

        const out = await findAutoplayTracks(player, seed);
        const authors = out.map((t) => t.info.author);

        // Zany Inzane was the seed track, so Chitral, Baila Boy, Sunil must come before any Zany track!
        const top3Authors = authors.slice(0, 3);
        assert.ok(!top3Authors.includes('Zany Inzane'), `Top recommendations must be diverse artists, got ${top3Authors}`);
        assert.ok(top3Authors.includes('Chitral Somapala'), 'Chitral must be recommended');
        assert.ok(top3Authors.includes('Baila Boy'), 'Baila Boy must be recommended');
        assert.ok(top3Authors.includes('Sunil Perera'), 'Sunil Perera must be recommended');
    });

    // ── Scenario 7: Recent artist cooldown (next 3 autoplay selections) ──
    await check('7. Avoids the same artist for the next 3 autoplay selections when alternatives exist', async () => {
        historyManager.clearGuild('g-cooldown');
        const seed = track('seedA', 'Track A', { author: 'Overplayed Artist' });
        // Simulate played history with Overplayed Artist
        historyManager.recordTrack('g-cooldown', seed);

        const player = makePlayer({
            guildId: 'g-cooldown',
            mixes: {
                seedA: [
                    { id: 'op1', title: 'Another Song', author: 'Overplayed Artist' },
                    { id: 'alt1', title: 'Fresh Song 1', author: 'Fresh Artist 1' },
                    { id: 'alt2', title: 'Fresh Song 2', author: 'Fresh Artist 2' },
                ],
            },
        });

        const out = await findAutoplayTracks(player, seed);
        assert.equal(out[0].info.author, 'Fresh Artist 1', 'First track must be Fresh Artist 1');
        assert.equal(out[1].info.author, 'Fresh Artist 2', 'Second track must be Fresh Artist 2');
    });

    // ── Scenario 8: Collaboration handling ──
    await check('8. Collaboration handling correctly extracts all contributing artists and enforces diversity', async () => {
        historyManager.clearGuild('g-collab');
        const seed = track('seedCollab', 'Original Hit', { author: 'Zany Inzane' });
        historyManager.recordTrack('g-collab', seed);

        // Candidate with collaboration in author and in title
        const player = makePlayer({
            guildId: 'g-collab',
            mixes: {
                seedCollab: [
                    { id: 'col1', title: 'Collab Song (feat. Alston)', author: 'Zany Inzane' }, // Features Zany -> on cooldown
                    { id: 'col2', title: 'Duo Track', author: 'Zany Inzane & Friend' },         // Features Zany -> on cooldown
                    { id: 'clean1', title: 'Solo Jam', author: 'Alston' },                        // Independent artist
                ],
            },
        });

        const out = await findAutoplayTracks(player, seed);
        assert.equal(out[0].info.identifier, 'clean1', 'Clean artist without cooldown must be chosen first');

        // Verify collaborator extraction unit logic
        const extracted1 = extractCollaborators('Song Name (feat. Drake & Future)', 'DJ Khaled');
        assert.ok(extracted1.includes('dj khaled'), 'dj khaled extracted');
        assert.ok(extracted1.includes('drake'), 'drake extracted');
        assert.ok(extracted1.includes('future'), 'future extracted');

        const extracted2 = extractCollaborators('I Dont Care', 'Ed Sheeran & Justin Bieber');
        assert.ok(extracted2.includes('ed sheeran'), 'ed sheeran extracted');
        assert.ok(extracted2.includes('justin bieber'), 'justin bieber extracted');
    });

    // ── Scenario 9: Channel diversity limits channel domination in Tier 1 ──
    await check('9. Channel diversity prevents a single YouTube channel from dominating the batch', async () => {
        historyManager.clearGuild('g-channel');
        const seed = track('seedCh', 'Seed Song', { author: 'Mega Channel' });

        const player = makePlayer({
            guildId: 'g-channel',
            mixes: {
                seedCh: [
                    { id: 'mc1', title: 'Song 1', author: 'Mega Channel' },
                    { id: 'mc2', title: 'Song 2', author: 'Mega Channel' },
                    { id: 'oc1', title: 'Song 3', author: 'Other Channel 1' },
                    { id: 'oc2', title: 'Song 4', author: 'Other Channel 2' },
                ],
            },
        });

        const out = await findAutoplayTracks(player, seed);
        // The diverse channels must be selected ahead of duplicate channel entries
        const topChannels = out.slice(0, 2).map((t) => t.info.author);
        assert.ok(topChannels.includes('Other Channel 1') && topChannels.includes('Other Channel 2'), 'Diverse channels chosen in Tier 1');
    });

    // ── Scenario 10: Complementary discovery strategies when RD mix is narrow ──
    await check('10. Triggers complementary discovery when RD mix contains too few diverse artists', async () => {
        historyManager.clearGuild('g-comp');
        const seed = track('seedNarrow', 'Lofi Chill Hop Beats', { author: 'Single Producer' });

        const player = makePlayer({
            guildId: 'g-comp',
            mixes: {
                seedNarrow: [
                    { id: 'narrow1', title: 'Beats Part 2', author: 'Single Producer' },
                ],
            },
            searches: {
                'lofi': [
                    { id: 'comp1', title: 'Coffee Shop Lofi', author: 'Chillhop Music' },
                    { id: 'comp2', title: 'Rainy Night Lofi', author: 'Lofi Girl' },
                ],
            },
        });

        const out = await findAutoplayTracks(player, seed);
        const outIds = ids(out);
        assert.ok(outIds.includes('comp1') || outIds.includes('comp2'), 'Complementary search results must be included');
    });

    // ── Scenario 11: Per-guild recommendation history isolation ──
    await check('11. Per-guild isolation: Cooldowns in Guild A do not affect Guild B', async () => {
        historyManager.clearGuild('guild-A');
        historyManager.clearGuild('guild-B');

        const trackA = track('tA', 'Song A', { author: 'Special Artist' });
        historyManager.recordTrack('guild-A', trackA);

        assert.equal(historyManager.isArtistOnCooldown('guild-A', ['special artist']), true, 'Guild A has artist on cooldown');
        assert.equal(historyManager.isArtistOnCooldown('guild-B', ['special artist']), false, 'Guild B does NOT have artist on cooldown');
    });

    // ── Scenario 12: Graceful fallback when only single artist candidates exist ──
    await check('12. Falls back gracefully to available tracks when no alternative artists exist', async () => {
        historyManager.clearGuild('g-onlyone');
        const seed = track('seedSolo', 'Only Track 1', { author: 'Solo Artist' });
        historyManager.recordTrack('g-onlyone', seed);

        const player = makePlayer({
            guildId: 'g-onlyone',
            mixes: {
                seedSolo: [
                    { id: 's2', title: 'Only Track 2', author: 'Solo Artist' },
                ],
            },
        });

        const out = await findAutoplayTracks(player, seed);
        assert.equal(out.length, 1, 'Should return available candidate rather than silence');
        assert.equal(out[0].info.identifier, 's2', 'Correct fallback candidate returned');
    });

    console.log(`\n${passed} check(s) passed${process.exitCode ? ', with failures' : ''}.`);
}

main();
