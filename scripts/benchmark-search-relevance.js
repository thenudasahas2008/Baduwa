/**
 * Benchmark Script for ZYRO Music Search & Autocomplete Relevance
 * Measures baseline and post-fix ranking, candidate scores, modifier handling, and Sinhala support.
 */

const assert = require('node:assert/strict');
const {
    parseSearchQuery,
    calculateScore,
    rankTracks,
    cleanQueryString,
    CONFIDENCE_LEVELS
} = require('../src/utils/searchEngine');
const {
    getAutocompleteChoices,
    makeTrackDeduplicationKey
} = require('../src/utils/searchAutocomplete');

const BENCHMARK_CASES = [
    {
        id: 'title_artist_delimited',
        description: 'Title - Artist delimited query ("Shape of You - Ed Sheeran")',
        query: 'Shape of You - Ed Sheeran',
        candidates: [
            { info: { title: 'Shape of You', author: 'Ed Sheeran', duration: 233000, identifier: 'shape_studio' } },
            { info: { title: 'Ed Sheeran - Bad Habits', author: 'Ed Sheeran', duration: 230000, identifier: 'bad_habits' } },
            { info: { title: 'Shape of You (Cover)', author: 'Indie Artist', duration: 220000, identifier: 'shape_cover' } }
        ],
        expectedTopId: 'shape_studio'
    },
    {
        id: 'artist_title_delimited',
        description: 'Artist - Title delimited query ("Ed Sheeran - Shape of You")',
        query: 'Ed Sheeran - Shape of You',
        candidates: [
            { info: { title: 'Shape of You', author: 'Ed Sheeran', duration: 233000, identifier: 'shape_studio' } },
            { info: { title: 'Ed Sheeran - Perfect', author: 'Ed Sheeran', duration: 263000, identifier: 'perfect' } },
            { info: { title: 'Ed Sheeran - Shape of You (Live)', author: 'Ed Sheeran', duration: 250000, identifier: 'shape_live' } }
        ],
        expectedTopId: 'shape_studio'
    },
    {
        id: 'sinhala_spelling_variation',
        description: 'Sinhala query with spelling variation ("දගකාර හීනේ" matching "දඟකාර හීනේ")',
        query: 'දගකාර හීනේ',
        candidates: [
            { info: { title: 'දඟකාර හීනේ', author: 'Centigradz', duration: 250000, identifier: 'sinhala_alt_spelling' } },
            { info: { title: 'Random Sinhala Song', author: 'Artist X', duration: 200000, identifier: 'unrelated_sinhala' } },
            { info: { title: 'English Song 2024', author: 'Pop Band', duration: 180000, identifier: 'english_pop' } }
        ],
        expectedTopId: 'sinhala_alt_spelling'
    },
    {
        id: 'sinhala_english_mixed',
        description: 'Mixed Sinhala-English query ("දගකාර හීනේ centigradz")',
        query: 'දගකාර හීනේ centigradz',
        candidates: [
            { info: { title: 'දගකාර හීනේ (Dagakara Heene) - Centigradz', author: 'Centigradz', duration: 250000, identifier: 'sinhala_centigradz_exact' } },
            { info: { title: 'Centigradz Nonstop Mix', author: 'DJ Mixes', duration: 1800000, identifier: 'centigradz_mix' } },
            { info: { title: 'Other Artist - Dagakara', author: 'Unknown', duration: 210000, identifier: 'other_artist' } }
        ],
        expectedTopId: 'sinhala_centigradz_exact'
    },
    {
        id: 'modifier_slowed_reverb',
        description: 'Explicit compound modifier query ("After Hours (Slowed + Reverb)")',
        query: 'After Hours (Slowed + Reverb)',
        candidates: [
            { info: { title: 'The Weeknd - After Hours (Slowed + Reverb)', author: 'Aesthetic Remixes', duration: 380000, identifier: 'slowed_reverb_match' } },
            { info: { title: 'The Weeknd - After Hours', author: 'The Weeknd', duration: 360000, identifier: 'studio_original' } },
            { info: { title: 'The Weeknd - After Hours (Remix)', author: 'Club Remix', duration: 280000, identifier: 'club_remix' } }
        ],
        expectedTopId: 'slowed_reverb_match'
    },
    {
        id: 'unwanted_modifier_rejection',
        description: 'Studio track requested, penalize remix and cover ("Levitating")',
        query: 'Levitating',
        candidates: [
            { info: { title: 'Dua Lipa - Levitating', author: 'Dua Lipa - Topic', duration: 203000, identifier: 'original_levitating' } },
            { info: { title: 'Dua Lipa - Levitating (Remix feat. DaBaby)', author: 'Dua Lipa', duration: 203000, identifier: 'remix_levitating' } },
            { info: { title: 'Levitating - Acoustic Guitar Cover', author: 'CoverArtist', duration: 210000, identifier: 'cover_levitating' } }
        ],
        expectedTopId: 'original_levitating'
    },
    {
        id: 'parenthesis_clean_preservation',
        description: 'Query with trailing parenthesis preserved ("Creep (Acoustic)")',
        query: 'Creep (Acoustic)',
        candidates: [
            { info: { title: 'Radiohead - Creep (Acoustic)', author: 'Radiohead', duration: 259000, identifier: 'creep_acoustic' } },
            { info: { title: 'Radiohead - Creep', author: 'Radiohead', duration: 238000, identifier: 'creep_original' } }
        ],
        expectedTopId: 'creep_acoustic'
    },
    {
        id: 'no_match_calibration',
        description: 'Gibberish / no match query calibrated to LOW confidence',
        query: 'zyro_random_gibberish_query_xyz999',
        candidates: [
            { info: { title: 'Top 100 Hits 2024', author: 'Music Channel', duration: 300000, identifier: 'generic_hits' } },
            { info: { title: 'Chill Lo-fi Beats', author: 'Lofi Girl', duration: 300000, identifier: 'lofi_beats' } }
        ],
        expectedConfidence: CONFIDENCE_LEVELS.LOW
    }
];

function runBenchmark() {
    console.log('=== RUNNING RELEVANCE BENCHMARK ===\n');
    let passed = 0;
    const results = [];

    for (const testCase of BENCHMARK_CASES) {
        const cleaned = cleanQueryString(testCase.query);
        const ranked = rankTracks(testCase.candidates, testCase.query);
        const top = ranked[0];
        const isTopMatch = testCase.expectedTopId ? top?.info?.identifier === testCase.expectedTopId : true;
        const isConfMatch = testCase.expectedConfidence ? ranked.confidence === testCase.expectedConfidence : true;
        const success = isTopMatch && isConfMatch;

        if (success) passed++;

        results.push({
            id: testCase.id,
            description: testCase.description,
            cleanedQuery: cleaned,
            topRankedId: top?.info?.identifier,
            topTitle: top?.info?.title,
            topScore: ranked.topScore,
            confidence: ranked.confidence,
            success
        });

        console.log(`[${success ? 'PASS' : 'FAIL'}] ${testCase.id}: ${testCase.description}`);
        console.log(`       Cleaned Query: "${cleaned}"`);
        console.log(`       Top Ranked: "${top?.info?.title}" (Score: ${ranked.topScore}, Confidence: ${ranked.confidence})`);
        if (!success) {
            if (testCase.expectedTopId) console.log(`       Expected Top ID: ${testCase.expectedTopId}, Got: ${top?.info?.identifier}`);
            if (testCase.expectedConfidence) console.log(`       Expected Confidence: ${testCase.expectedConfidence}, Got: ${ranked.confidence}`);
        }
        console.log('');
    }

    console.log(`Benchmark Summary: ${passed} / ${BENCHMARK_CASES.length} passed (${Math.round((passed / BENCHMARK_CASES.length) * 100)}%)`);
    return { passed, total: BENCHMARK_CASES.length, results };
}

if (require.main === module) {
    runBenchmark();
}

module.exports = { runBenchmark, BENCHMARK_CASES };
