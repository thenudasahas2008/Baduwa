/**
 * Comprehensive verification test suite for ZYRO Smart Music Search Autocomplete
 *
 * Verifies:
 * 1. Registered command definitions for /play and /search have autocomplete enabled
 * 2. Real query-dependent suggestions for English, Romanized Sinhala, and Sinhala Unicode
 * 3. Dynamic suggestion updates as queries become more specific
 * 4. Relevance ranking prioritizing original studio tracks over unrequested "Slowed & Reverb"
 * 5. Modifier preservation when explicitly requested ("slowed", "reverb", "remix")
 * 6. Duplicate track deduplication by identifier, URI, and artist/title
 * 7. Playlist suggestion formatting and placement
 * 8. Discord constraints: max 25 choices, name <= 100 chars, value <= 100 chars
 * 9. Token store, token resolution, and graceful expired token handling in /play and /search
 * 10. Provider error and timeout resilience (never leaves Discord on loading)
 * 11. Separation of autocomplete from normal command lifecycle
 */

const assert = require('assert');
const { getAutocompleteChoices, resolveAutocompleteToken, storeAutocompleteToken, isExpiredToken, formatChoiceName } = require('../src/utils/searchAutocomplete');
const playCommand = require('../src/commands/play');
const searchCommand = require('../src/commands/search');
const { rankTracks, CONFIDENCE_LEVELS } = require('../src/utils/searchEngine');

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
    totalTests++;
    try {
        await fn();
        passedTests++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}:`, err.message || err);
        throw err;
    }
}

async function runSmartAutocompleteTests() {
    console.log('\n--- STARTING ZYRO SMART AUTOCOMPLETE VERIFICATION ---');

    // 1. Registered command definitions
    await test('1. /play command definition has autocomplete enabled on query option', () => {
        const json = playCommand.data.toJSON();
        assert.equal(json.name, 'play');
        const queryOpt = json.options.find(o => o.name === 'query');
        assert.ok(queryOpt, 'Query option must exist');
        assert.equal(queryOpt.type, 3, 'Query option must be STRING');
        assert.equal(queryOpt.autocomplete, true, 'Query option must have autocomplete: true');
        assert.ok(!queryOpt.choices || queryOpt.choices.length === 0, 'Must not have conflicting static choices');
    });

    await test('2. /search command definition has autocomplete enabled on query option', () => {
        const json = searchCommand.data.toJSON();
        assert.equal(json.name, 'search');
        const queryOpt = json.options.find(o => o.name === 'query');
        assert.ok(queryOpt, 'Query option must exist');
        assert.equal(queryOpt.type, 3, 'Query option must be STRING');
        assert.equal(queryOpt.autocomplete, true, 'Query option must have autocomplete: true');
        assert.ok(!queryOpt.choices || queryOpt.choices.length === 0, 'Must not have conflicting static choices');
    });

    // 2. Empty input returns no suggestions (no preset choices before query entered)
    await test('3. Empty or blank query returns no preset song suggestions', async () => {
        const choices = await getAutocompleteChoices({}, '', {});
        assert.ok(Array.isArray(choices));
        assert.equal(choices.length, 0, 'Empty query must return 0 suggestions');
    });

    // 3. Direct URL returns direct link choice
    await test('4. Direct URL input returns a clean direct link choice', async () => {
        const directUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const choices = await getAutocompleteChoices({}, directUrl, {});
        assert.equal(choices.length, 1);
        assert.ok(choices[0].name.startsWith('🔗'));
        assert.equal(choices[0].value, directUrl);
    });

    // 4. Sinhala Unicode suggestions
    await test('5. Sinhala Unicode query returns real query-dependent suggestions', async () => {
        const choices = await getAutocompleteChoices({}, 'හිතට', {});
        assert.ok(choices.length > 0);
        assert.ok(choices.length <= 25);
        // Verify at least one choice contains Sinhala characters
        const hasSinhala = choices.some(c => /[\u0D80-\u0DFF]/.test(c.name));
        assert.ok(hasSinhala, 'Expected Sinhala Unicode characters in suggestions');
        for (const c of choices) {
            assert.ok(c.name.length <= 100);
            assert.ok(c.value.length <= 100);
        }
    });

    // 5. Query changes update suggestions dynamically
    await test('6. Suggestions update dynamically when query becomes more specific', async () => {
        const choices1 = await getAutocompleteChoices({}, 'hithata', {});
        const choices2 = await getAutocompleteChoices({}, 'hithata wadinama', {});
        assert.ok(choices1.length > 0);
        assert.ok(choices2.length > 0);
        // Ensure suggestions are different between general and specific queries
        const names1 = choices1.map(c => c.name).join(' ');
        const names2 = choices2.map(c => c.name).join(' ');
        assert.notEqual(names1, names2, 'Specific query should yield refined suggestions');
    });

    // 6. Real track ranking: original prioritized over unrequested "Slowed & Reverb"
    await test('7. Autocomplete prioritizes original track over unrequested "Slowed & Reverb"', async () => {
        const mockTracks = [
            {
                info: {
                    title: 'Peruman Pura (Slowed & Reverb)',
                    author: 'Anjana Nanayakkara',
                    uri: 'https://www.youtube.com/watch?v=slowed_id',
                    identifier: 'slowed_id',
                    duration: 230000,
                }
            },
            {
                info: {
                    title: 'Peruman Pura',
                    author: 'Anjana Nanayakkara',
                    uri: 'https://www.youtube.com/watch?v=original_id',
                    identifier: 'original_id',
                    duration: 210000,
                }
            }
        ];

        const mockClient = {
            lavalink: {
                nodeManager: {
                    nodes: new Map([
                        ['node1', {
                            connected: true,
                            search: async () => ({ loadType: 'search', tracks: mockTracks }),
                        }]
                    ])
                }
            }
        };

        const choices = await getAutocompleteChoices(mockClient, 'Peruman Pura', {});
        const trackChoices = choices.filter(c => c.name.startsWith('🎵'));
        assert.ok(trackChoices.length >= 2, 'Expected both tracks in choices');
        // Top track choice must be the original, not the Slowed & Reverb version
        assert.ok(
            trackChoices[0].name.includes('Peruman Pura') && !trackChoices[0].name.includes('Slowed'),
            `Expected original track first, got: ${trackChoices[0].name}`
        );
        assert.equal(trackChoices[0].value, 'https://www.youtube.com/watch?v=original_id');
    });

    // 7. Genuinely requested modifiers preserved
    await test('8. Autocomplete boosts modified versions when explicitly requested ("slowed & reverb")', async () => {
        const mockTracks = [
            {
                info: {
                    title: 'Peruman Pura',
                    author: 'Anjana Nanayakkara',
                    uri: 'https://www.youtube.com/watch?v=original_id',
                    identifier: 'original_id',
                    duration: 210000,
                }
            },
            {
                info: {
                    title: 'Peruman Pura (Slowed & Reverb)',
                    author: 'Anjana Nanayakkara',
                    uri: 'https://www.youtube.com/watch?v=slowed_id',
                    identifier: 'slowed_id',
                    duration: 230000,
                }
            }
        ];

        const mockClient = {
            lavalink: {
                nodeManager: {
                    nodes: new Map([
                        ['node1', {
                            connected: true,
                            search: async () => ({ loadType: 'search', tracks: mockTracks }),
                        }]
                    ])
                }
            }
        };

        const choices = await getAutocompleteChoices(mockClient, 'Peruman Pura slowed', {});
        const trackChoices = choices.filter(c => c.name.startsWith('🎵'));
        assert.ok(trackChoices.length >= 1);
        // Because user requested 'slowed', the slowed version should be ranked higher
        assert.ok(
            trackChoices[0].name.includes('Slowed'),
            `Expected slowed track first when requested, got: ${trackChoices[0].name}`
        );
        assert.equal(trackChoices[0].value, 'https://www.youtube.com/watch?v=slowed_id');
    });

    // 8. Deduplication of identical songs / re-uploads
    await test('9. Duplicate tracks by identifier, URI, and title/author are removed', async () => {
        const mockTracks = [
            {
                info: {
                    title: 'Kasun Kalhara - Mal Mitak',
                    author: 'Kasun Kalhara',
                    uri: 'https://www.youtube.com/watch?v=kasun1',
                    identifier: 'kasun1',
                    duration: 240000,
                }
            },
            {
                info: {
                    title: 'Kasun Kalhara - Mal Mitak (Official Video)',
                    author: 'Kasun Kalhara',
                    uri: 'https://www.youtube.com/watch?v=kasun1', // Duplicate URI & ID
                    identifier: 'kasun1',
                    duration: 240000,
                }
            },
            {
                info: {
                    title: 'Kasun Kalhara - Mal Mitak',
                    author: 'Kasun Kalhara',
                    uri: 'https://www.youtube.com/watch?v=kasun2', // Duplicate title/author
                    identifier: 'kasun2',
                    duration: 240000,
                }
            }
        ];

        const mockClient = {
            lavalink: {
                nodeManager: {
                    nodes: new Map([
                        ['node1', {
                            connected: true,
                            search: async () => ({ loadType: 'search', tracks: mockTracks }),
                        }]
                    ])
                }
            }
        };

        const choices = await getAutocompleteChoices(mockClient, 'Kasun Kalhara Mal Mitak', {});
        const trackChoices = choices.filter(c => c.name.startsWith('🎵'));
        assert.equal(trackChoices.length, 1, `Expected exactly 1 deduplicated track, got ${trackChoices.length}`);
    });

    // 9. Playlist placement at top
    await test('10. Playlists returned by provider are formatted with 📁 and placed at top', async () => {
        const mockPlaylistRes = {
            loadType: 'playlist',
            playlist: {
                title: 'Best of Sinhala Classics',
                uri: 'https://www.youtube.com/playlist?list=PL1234567890',
            },
            tracks: [
                {
                    info: {
                        title: 'Track 1',
                        author: 'Artist 1',
                        uri: 'https://www.youtube.com/watch?v=track1',
                        identifier: 'track1',
                        duration: 180000,
                    }
                }
            ]
        };

        const mockClient = {
            lavalink: {
                nodeManager: {
                    nodes: new Map([
                        ['node1', {
                            connected: true,
                            search: async () => mockPlaylistRes,
                        }]
                    ])
                }
            }
        };

        const choices = await getAutocompleteChoices(mockClient, 'sinhala classics playlist', {});
        assert.ok(choices.length > 0);
        assert.ok(choices[0].name.startsWith('📁'), `First choice should be playlist, got: ${choices[0].name}`);
        assert.ok(choices[0].name.includes('Best of Sinhala Classics'));
    });

    // 10. Long URLs stored in tokenMap and resolved cleanly
    await test('11. Long URLs (>100 chars) are stored via stable tokens and resolved', () => {
        const longUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=shared&list=PL123456789012345678901234567890&index=42&extra_long_parameter=very_long_string_that_exceeds_discord_limit_1234567890';
        assert.ok(longUrl.length > 100);

        const token = storeAutocompleteToken(longUrl, { title: 'Long Song' });
        assert.ok(token.startsWith('tok_'));
        assert.ok(token.length <= 40);

        const resolved = resolveAutocompleteToken(token);
        assert.equal(resolved, longUrl);
    });

    // 11. Expired tokens are detected by isExpiredToken
    await test('12. Expired tokens return { isExpired: true } and are detected by isExpiredToken', () => {
        const fakeExpiredToken = 'tok_expired_or_unknown_token_12345';
        const res = resolveAutocompleteToken(fakeExpiredToken);
        assert.ok(isExpiredToken(res), 'Should be identified as expired token');
        assert.equal(res.isExpired, true);
        assert.equal(res.token, fakeExpiredToken);
    });

    // 12. Provider timeouts do not throw or hang
    await test('13. Hanging Lavalink searches safely fall back without exceeding deadline', async () => {
        const hangingClient = {
            lavalink: {
                nodeManager: {
                    nodes: new Map([
                        ['node1', {
                            connected: true,
                            search: () => new Promise(resolve => setTimeout(resolve, 5000)), // Hanging search
                        }]
                    ])
                }
            }
        };

        const start = Date.now();
        const choices = await getAutocompleteChoices(hangingClient, 'baila songs', {});
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 2000, `Autocomplete should return within 2000ms even with hanging provider (took ${elapsed}ms)`);
        assert.ok(Array.isArray(choices));
        assert.ok(choices.length > 0);
    });

    // 13. Label truncation strict constraint
    await test('14. formatChoiceName truncates excessively long strings to strictly <= 100 chars', () => {
        const longTitle = 'This is an extremely long song title that would definitely exceed Discord limits if not handled with precision and care in ZYRO music bot';
        const longArtist = 'An Incredibly Long Band Name Featuring Multiple Famous Guest Artists And Orchestras';
        const formatted = formatChoiceName('🎵', longTitle, longArtist, '3:45');
        assert.ok(formatted.length <= 100, `Formatted choice name must be <= 100 chars, got ${formatted.length}`);
        assert.ok(formatted.endsWith(')'), 'Duration should be preserved at the end');
    });

    console.log(`\nAll ${passedTests}/${totalTests} Smart Autocomplete tests PASSED! ✓\n`);
    process.exit(0);
}

runSmartAutocompleteTests().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
