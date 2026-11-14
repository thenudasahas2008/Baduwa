const logger = require('./logger');
const { performanceMonitor } = require('./performanceMonitor');
const { searchBulkhead } = require('./bulkheadManager');

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SEARCH_CACHE_SIZE = 150;
const searchCache = new Map();
const inFlightSearches = new Map();

const CONFIDENCE_LEVELS = {
    HIGH: 'HIGH',       // Strong, clear match -> Auto-play
    MEDIUM: 'MEDIUM',   // Plausible, multiple candidates -> Show interactive selector
    LOW: 'LOW',         // Unreliable / no good match -> Safe fallback notice
};

const CONFIDENCE_THRESHOLDS = {
    HIGH_SCORE: 75,
    MIN_SCORE: 35,
    AMBIGUITY_DELTA: 8, // If top 2 candidates are within 8 points, consider ambiguous
};

function cloneSearchResult(res, requestUser) {
    if (!res) return res;
    const cloned = { ...res };
    if (Array.isArray(res.tracks)) {
        cloned.tracks = res.tracks.map(t => {
            const copy = { ...t };
            if (t.info) copy.info = { ...t.info };
            if (t.userData) copy.userData = { ...t.userData };
            if (t.requester && requestUser) {
                copy.requester = { ...t.requester, ...requestUser };
            } else if (requestUser) {
                copy.requester = requestUser;
            } else if (t.requester) {
                copy.requester = t.requester;
            }
            return copy;
        });
    }
    cloned.bestMatch = cloned.tracks?.[0] || null;
    return cloned;
}

function clearSearchCache() {
    searchCache.clear();
    inFlightSearches.clear();
    if (searchBulkhead && typeof searchBulkhead.clear === 'function') {
        searchBulkhead.clear();
    }
}

// Meaningful modifiers that must be preserved and accurately matched
const MODIFIERS = [
    'slowed + reverb',
    'slowed and reverb',
    'slowed & reverb',
    'sped up',
    'speed up',
    'bass boosted',
    'radio edit',
    'club mix',
    'remix',
    'live',
    'acoustic',
    'unplugged',
    'instrumental',
    'karaoke',
    'cover',
    'slowed',
    'nightcore',
    'reverb',
    '8d',
    'lyrics',
    'lyric',
    'extended',
    'clean',
    'explicit',
    'orchestral',
    'piano',
    'guitar',
    'lofi',
    'lo-fi',
];

const JUNK_TERMS = [
    'reaction',
    'reacts to',
    'review',
    'tutorial',
    'how to play',
    '10 hours',
    '1 hour',
    'parody',
    'meme',
    'tik tok',
    'shorts',
    'teaser',
    'trailer',
    'interview',
    'behind the scenes',
];

// Common video noise patterns in titles (excluding version modifiers like remix/cover/live)
const NOISE_REGEX = /\s*[\(\[\{]?(?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video|lyrics|hd|4k|hq)?|video\s*clip|clip\s*officiel|lyric\s*video|visualizer|audio\s*only|full\s*song|hd|4k|hq|remastered|out\s*now)[\)\]\}]?\s*/gi;

function isUrl(str) {
    if (!str) return false;
    return /^https?:\/\//i.test(str.trim());
}

function cleanQueryString(rawQuery) {
    if (!rawQuery) return '';
    let q = String(rawQuery).trim();
    // Remove wrapping quotes or brackets ONLY if they wrap the entire query
    if ((q.startsWith('"') && q.endsWith('"')) ||
        (q.startsWith("'") && q.endsWith("'")) ||
        (q.startsWith('`') && q.endsWith('`')) ||
        (q.startsWith('<') && q.endsWith('>')) ||
        (q.startsWith('(') && q.endsWith(')') && !q.slice(1, -1).includes('(')) ||
        (q.startsWith('[') && q.endsWith(']') && !q.slice(1, -1).includes('['))) {
        q = q.slice(1, -1).trim();
    }
    // Normalize consecutive whitespace
    q = q.replace(/\s+/g, ' ');
    return q.normalize('NFC');
}

/**
 * Folds Sinhala Unicode characters to harmonize orthographic spelling variations
 * (e.g. Sanyaka / prenasalized letters vs plain letters, Murdhaja vs Dantaja)
 * and strips zero-width joiners / non-joiners.
 */
function normalizeSinhala(str = '') {
    if (!str || !/[\u0D80-\u0DFF]/.test(str)) return str;
    return str
        .normalize('NFC')
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
        .replace(/ඟ/g, 'ග')
        .replace(/ඳ/g, 'ද')
        .replace(/ඹ/g, 'බ')
        .replace(/ඬ/g, 'ඩ')
        .replace(/ණ/g, 'න')
        .replace(/ළ/g, 'ල')
        .replace(/[ශෂ]/g, 'ස')
        .replace(/ඝ/g, 'ග')
        .replace(/ඡ/g, 'ච')
        .replace(/ඣ/g, 'ජ')
        .replace(/ඨ/g, 'ට')
        .replace(/ඪ/g, 'ඩ')
        .replace(/ථ/g, 'ත')
        .replace(/ධ/g, 'ද')
        .replace(/ඵ/g, 'ප')
        .replace(/භ/g, 'බ');
}

/**
 * Phonetically transliterates Sinhala script to simplified Latin characters
 * for seamless cross-script matching between Sinhala queries and Romanized track titles.
 */
function sinhalaToLatin(sinhala = '') {
    if (!sinhala || !/[\u0D80-\u0DFF]/.test(sinhala)) return sinhala;
    const cons = {
        'ක':'k','ඛ':'kh','ග':'g','ඝ':'gh','ඟ':'g',
        'ච':'ch','ඡ':'ch','ජ':'j','ඣ':'j','ඤ':'n','ඥ':'gn',
        'ට':'t','ඨ':'th','ඩ':'d','ඪ':'dh','ණ':'n','ඬ':'d',
        'ත':'th','ථ':'th','ද':'d','ධ':'dh','න':'n','ඳ':'d',
        'ප':'p','ඵ':'p','බ':'b','භ':'b','ම':'m','ඹ':'b',
        'ය':'y','ර':'r','ල':'l','ළ':'l','ව':'w','ශ':'s','ෂ':'s','ස':'s','හ':'h','ෆ':'f'
    };
    const vowels = {
        'අ':'a','ආ':'a','ඇ':'a','ඈ':'a','ඉ':'i','ඊ':'i','උ':'u','ඌ':'u',
        'ඍ':'ru','එ':'e','ඒ':'e','ඓ':'ai','ඔ':'o','ඕ':'o','ඖ':'au'
    };
    const diacritics = {
        'ා':'a','ැ':'a','ෑ':'a','ි':'i','ී':'e','ු':'u','ූ':'u',
        'ෘ':'ru','ෙ':'e','ේ':'e','ෛ':'ai','ො':'o','ෝ':'o','ඖ':'au'
    };
    let res = '';
    const cleaned = String(sinhala).replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
    const chars = Array.from(cleaned);
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (vowels[c]) {
            res += vowels[c];
        } else if (cons[c]) {
            const next = chars[i+1];
            if (next === '්') {
                res += cons[c];
                i++;
            } else if (diacritics[next]) {
                res += cons[c] + diacritics[next];
                i++;
            } else {
                res += cons[c] + 'a';
            }
        } else if (c === 'ං') {
            res += 'n';
        } else if (c === 'ඃ') {
            res += 'h';
        } else {
            res += c;
        }
    }
    return res;
}

/**
 * Phonetically transliterates Romanized Singlish (Latin) to Sinhala Unicode script.
 * Enables cross-matching when users search in Romanized Sinhala against Sinhala track titles.
 */
function latinToSinhala(latin = '') {
    if (!latin || /[\u0D80-\u0DFF]/.test(latin)) return latin;
    const l = String(latin).toLowerCase();
    const consMap = {
        'ch': 'ච', 'sh': 'ශ', 'th': 'ත', 'dh': 'ද', 'kh': 'ඛ', 'gh': 'ඝ',
        'ph': 'ඵ', 'bh': 'භ', 'gn': 'ඥ', 'ng': 'ඟ',
        'k': 'ක', 'g': 'ග', 'c': 'ක', 'j': 'ජ', 't': 'ට', 'd': 'ඩ',
        'n': 'න', 'p': 'ප', 'b': 'බ', 'm': 'ම', 'y': 'ය', 'r': 'ර',
        'l': 'ල', 'w': 'ව', 'v': 'ව', 's': 'ස', 'h': 'හ', 'f': 'ෆ'
    };
    const vowMap = {
        'aa': 'ආ', 'ai': 'ඓ', 'au': 'ඖ', 'ee': 'ඊ', 'oo': 'ඌ', 'ii': 'ඊ', 'uu': 'ඌ',
        'a': 'අ', 'e': 'එ', 'i': 'ඉ', 'o': 'ඔ', 'u': 'උ'
    };
    const diacrMap = {
        'aa': 'ා', 'ai': 'ෛ', 'au': 'ෞ', 'ee': 'ේ', 'oo': 'ෝ', 'ii': 'ී', 'uu': 'ූ',
        'a': '', 'e': 'ෙ', 'i': 'ි', 'o': 'ො', 'u': 'ු'
    };

    let result = '';
    let i = 0;
    while (i < l.length) {
        if (!/[a-z]/.test(l[i])) {
            result += l[i];
            i++;
            continue;
        }

        const twoCharCons = l.slice(i, i + 2);
        const oneCharCons = l[i];
        let cChar = '';
        let cLen = 0;

        if (consMap[twoCharCons]) {
            cChar = consMap[twoCharCons];
            cLen = 2;
        } else if (consMap[oneCharCons]) {
            cChar = consMap[oneCharCons];
            cLen = 1;
        }

        if (cChar) {
            i += cLen;
            const twoCharVow = l.slice(i, i + 2);
            const oneCharVow = l[i];
            if (diacrMap[twoCharVow] !== undefined) {
                result += cChar + diacrMap[twoCharVow];
                i += 2;
            } else if (diacrMap[oneCharVow] !== undefined) {
                result += cChar + diacrMap[oneCharVow];
                i += 1;
            } else {
                if (i >= l.length || /[a-z]/.test(l[i])) {
                    result += cChar + '්';
                } else {
                    result += cChar;
                }
            }
        } else {
            const twoCharVow = l.slice(i, i + 2);
            const oneCharVow = l[i];
            if (vowMap[twoCharVow]) {
                result += vowMap[twoCharVow];
                i += 2;
            } else if (vowMap[oneCharVow]) {
                result += vowMap[oneCharVow];
                i += 1;
            } else {
                result += l[i];
                i++;
            }
        }
    }
    return result;
}

/**
 * Phonetically harmonizes Romanized text across common South Asian and English transcription variations
 * (e.g. "th" -> "t", "w" -> "v", double vowels, double consonants).
 */
function normalizePhoneticLatin(str = '') {
    if (!str) return '';
    return String(str)
        .toLowerCase()
        .normalize('NFC')
        .replace(/th/g, 't')
        .replace(/dh/g, 'd')
        .replace(/kh/g, 'k')
        .replace(/gh/g, 'g')
        .replace(/ph/g, 'p')
        .replace(/bh/g, 'b')
        .replace(/sh/g, 's')
        .replace(/v/g, 'w')
        .replace(/c(?=[eiy])/g, 's')
        .replace(/c/g, 'k')
        .replace(/aa+/g, 'a')
        .replace(/ee+/g, 'e')
        .replace(/oo+/g, 'o')
        .replace(/ii+/g, 'i')
        .replace(/uu+/g, 'u')
        .replace(/([a-z])\1+/g, '$1')
        .trim();
}

/**
 * Normalizes consecutive repeating vowels in Latin tokens (e.g. "heenee" -> "hene", "heene" -> "hene")
 * to eliminate spelling variations in phonetic Romanizations.
 */
function collapseVowels(str = '') {
    return String(str || '').toLowerCase()
        .replace(/aa+/g, 'a')
        .replace(/ee+/g, 'e')
        .replace(/oo+/g, 'o')
        .replace(/ii+/g, 'i')
        .replace(/uu+/g, 'u');
}

function tokenize(text = '') {
    if (!text) return [];
    // Unicode-aware word tokenization preserving words in any script (Sinhala, Tamil, Devanagari, etc.)
    const normalized = String(text).toLowerCase().normalize('NFC');
    return normalized
        .split(/[\s,_\-–—/\\|:;()[\]{}<>"“”‘’`«»+&]+/)
        .map(t => t.trim())
        .filter(t => t.length > 0);
}

const DESCRIPTOR_TERMS = new Set([
    'rap', 'hiphop', 'hip-hop', 'drill', 'trap', 'edm', 'r&b', 'pop', 'rock',
    'song', 'songs', 'sindu', 'sindhu', 'geetha', 'geethe', 'pada', 'track', 'tracks',
    'music', 'audio', 'video', 'full', 'sinhala', 'sri', 'lanka', 'srilanka',
    'new', 'latest', 'original', 'official', 'mv', 'ost', 'theme', 'instrumental',
    'mp3', 'hd', '4k'
]);

/**
 * Parses user search query into structured components (artist, title, featured artists, modifiers).
 * Handles:
 * - "Artist - Song Title" vs "Song Title - Artist"
 * - "Song Title by Artist"
 * - "Artist ft. Featured - Song Title"
 * - Non-Latin titles (Sinhala, Tamil, Hindi, etc.)
 *
 * @param {string} rawQuery
 * @returns {Object} Structured query features
 */
function parseSearchQuery(rawQuery) {
    const cleaned = cleanQueryString(rawQuery);
    const lower = cleaned.toLowerCase();
    const tokens = tokenize(cleaned);

    let expectedArtist = '';
    let expectedTitle = cleaned;
    let delimiterPartA = '';
    let delimiterPartB = '';
    let featuredArtists = [];
    let hasDelimiter = false;

    // 1. Check for "Title by Artist" pattern
    const byMatch = cleaned.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) {
        expectedTitle = byMatch[1].trim();
        expectedArtist = byMatch[2].trim();
        hasDelimiter = true;
    } else {
        // 2. Check for "Part A - Part B" (hyphen, en-dash, em-dash, pipe, colon)
        const delimiterMatch = cleaned.match(/^(.+?)\s+[-–—|:]\s+(.+)$/);
        if (delimiterMatch) {
            delimiterPartA = delimiterMatch[1].trim();
            delimiterPartB = delimiterMatch[2].trim();
            expectedArtist = delimiterPartA;
            expectedTitle = delimiterPartB;
            hasDelimiter = true;
        }
    }

    // 3. Extract featuring artists from artist part or title part
    const featRegex = /[\(\[\{]?(?:ft\.?|feat\.?|featuring|with)\s+([^\)\]\}]+)[\)\]\}]?/i;
    const featMatch = (expectedArtist || cleaned).match(featRegex) || expectedTitle.match(featRegex);
    if (featMatch) {
        featuredArtists = featMatch[1].split(/[,&/]/).map(a => a.trim()).filter(Boolean);
        if (expectedArtist) {
            expectedArtist = expectedArtist.replace(featRegex, '').trim();
        }
        expectedTitle = expectedTitle.replace(featRegex, '').trim();
    }

    // 4. Extract active modifiers (remix, live, acoustic, slowed, reverb, etc.)
    const activeModifiers = new Set();
    for (const mod of MODIFIERS) {
        if (lower.includes(mod)) {
            activeModifiers.add(mod);
            // If compound modifier matched (e.g. slowed + reverb), also ensure individual parts are recognized
            if (mod.includes('slowed') && mod.includes('reverb')) {
                activeModifiers.add('slowed');
                activeModifiers.add('reverb');
            }
            if (mod.includes('sped up') || mod.includes('speed up')) {
                activeModifiers.add('sped up');
                activeModifiers.add('speed up');
            }
        }
    }

    // Extract core tokens and descriptor terms (e.g. "rap", "song", "sinhala")
    const descriptorTokens = [];
    const coreTokens = [];
    for (const tok of tokens) {
        if (DESCRIPTOR_TERMS.has(tok.toLowerCase())) {
            descriptorTokens.push(tok.toLowerCase());
        } else {
            coreTokens.push(tok);
        }
    }
    const coreTitle = coreTokens.length > 0 ? coreTokens.join(' ') : cleaned;

    // Check if query contains non-Latin scripts (e.g. Sinhala, Tamil, Hindi, Cyrillic, CJK)
    const isNonLatin = /[^\u0000-\u007F]/.test(cleaned);
    const isSinhala = /[\u0D80-\u0DFF]/.test(cleaned);

    return {
        raw: rawQuery,
        cleaned,
        expectedArtist,
        expectedTitle,
        delimiterPartA,
        delimiterPartB,
        featuredArtists,
        hasDelimiter,
        tokens,
        coreTokens,
        descriptorTokens,
        coreTitle,
        titleTokens: tokenize(expectedTitle),
        artistTokens: tokenize(expectedArtist),
        activeModifiers,
        isNonLatin,
        isSinhala,
        isUrl: isUrl(cleaned),
    };
}

function extractQueryFeatures(query) {
    return parseSearchQuery(query);
}

/**
 * Normalizes author/channel string by stripping common YouTube channel suffixes
 */
function cleanAuthor(author = '') {
    return String(author || '')
        .toLowerCase()
        .normalize('NFC')
        .replace(/\s*-\s*topic$/i, '')
        .replace(/vevo$/i, '')
        .replace(/\s*(?:official(?:\s*channel)?|music|records|audio|media)$/i, '')
        .trim();
}

/**
 * Internal single-orientation scorer evaluating title similarity, artist match, modifiers, and duration.
 */
function scoreSingleOrientation(track, targetTitleStr, targetArtistStr, features) {
    if (!track?.info) return -100;

    const rawTitle = String(track.info.title || '').normalize('NFC');
    const rawAuthor = String(track.info.author || '').normalize('NFC');
    const titleLower = rawTitle.toLowerCase();
    const authorLower = rawAuthor.toLowerCase();
    const cleanedAuthor = cleanAuthor(rawAuthor);
    const combined = `${titleLower} ${authorLower}`;

    // Clean YouTube video noise from candidate title
    const cleanedTitle = rawTitle.replace(NOISE_REGEX, ' ').trim().toLowerCase();
    const candidateTokens = new Set([...tokenize(rawTitle), ...tokenize(rawAuthor)]);

    let score = 0;

    // --- 1. TITLE SIMILARITY ---
    const targetTitle = (targetTitleStr || features.cleaned).toLowerCase().trim();
    const targetTitleTokens = tokenize(targetTitle);

    // YouTube titles commonly follow "Artist - Title", "Title - Artist", "Artist | Title", etc.
    const candidateParts = cleanedTitle.split(/\s*[-–—|:]\s*/).map(p => p.trim()).filter(Boolean);
    if (candidateParts.length === 0) candidateParts.push(cleanedTitle);

    const coreCandA = candidateParts[0] || '';
    const coreCandB = candidateParts.length > 1 ? candidateParts[1] : '';
    const coreCandidateTitle = candidateParts.length > 1 ? candidateParts[1] : cleanedTitle;

    const candVariants = [cleanedTitle, ...candidateParts];
    const foldedCandVariants = candVariants.map(normalizeSinhala);
    const latinCandVariants = candVariants.map(sinhalaToLatin);
    const phoneticCandVariants = latinCandVariants.map(normalizePhoneticLatin);

    const foldedQueryTitle = normalizeSinhala(targetTitle);
    const latinQuery = sinhalaToLatin(targetTitle);
    const latinQueryNorm = collapseVowels(latinQuery);
    const phoneticQuery = normalizePhoneticLatin(latinQuery);

    const coreQuery = (features.hasDelimiter ? targetTitle : (features.coreTitle || targetTitle)).toLowerCase().trim();
    const coreQueryFolded = normalizeSinhala(coreQuery);
    const coreQueryLatin = sinhalaToLatin(coreQuery);
    const coreQueryNorm = collapseVowels(coreQueryLatin);
    const coreQueryPhonetic = normalizePhoneticLatin(coreQueryLatin);

    // Subtitle exact check when author is in query (e.g. "faded alan walker")
    let subTitleExact = false;
    if (!features.hasDelimiter && cleanedAuthor) {
        const authorToks = tokenize(cleanedAuthor);
        if (authorToks.length > 0 && authorToks.every(t => features.tokens.includes(t))) {
            const nonAuthorTokens = features.tokens.filter(t => !authorToks.includes(t));
            if (nonAuthorTokens.length > 0) {
                const subTitleStr = nonAuthorTokens.join(' ');
                for (const cVar of candVariants) {
                    if (cVar === subTitleStr || normalizeSinhala(cVar) === normalizeSinhala(subTitleStr) ||
                        sinhalaToLatin(cVar) === sinhalaToLatin(subTitleStr) ||
                        normalizePhoneticLatin(sinhalaToLatin(cVar)) === normalizePhoneticLatin(subTitleStr)) {
                        subTitleExact = true;
                        break;
                    }
                }
            }
        }
    }

    let isExactTitle = subTitleExact;
    let isFoldedExact = false;
    let isLatinExact = false;
    let isPhoneticExact = false;

    if (!isExactTitle) {
        for (let i = 0; i < candVariants.length; i++) {
            const cVar = candVariants[i];
            const fVar = foldedCandVariants[i];
            const lVar = latinCandVariants[i];
            const pVar = phoneticCandVariants[i];

            if (cVar === targetTitle || cVar === coreQuery || titleLower === targetTitle || titleLower === coreQuery) {
                isExactTitle = true;
                break;
            }
            if (fVar === foldedQueryTitle || fVar === coreQueryFolded) {
                isFoldedExact = true;
            }
            const lNorm = collapseVowels(lVar);
            if (lNorm === latinQueryNorm || lNorm === coreQueryNorm) {
                isLatinExact = true;
            }
            if (pVar && (pVar === phoneticQuery || pVar === coreQueryPhonetic)) {
                isPhoneticExact = true;
            }
        }
    }

    let isContainment = false;
    let isQueryContainsCandidate = false;

    if (!isExactTitle && !isFoldedExact && !isLatinExact && !isPhoneticExact) {
        for (let i = 0; i < candVariants.length; i++) {
            const cVar = candVariants[i];
            const fVar = foldedCandVariants[i];
            const lVar = latinCandVariants[i];
            const pVar = phoneticCandVariants[i];

            if (cVar.startsWith(targetTitle) || cVar.includes(targetTitle) ||
                (coreQuery.length >= 3 && (cVar.startsWith(coreQuery) || cVar.includes(coreQuery))) ||
                fVar.startsWith(foldedQueryTitle) || fVar.includes(foldedQueryTitle) ||
                (coreQueryFolded.length >= 3 && (fVar.startsWith(coreQueryFolded) || fVar.includes(coreQueryFolded))) ||
                (lVar && latinQuery && lVar.includes(latinQuery)) ||
                (lVar && coreQueryLatin && coreQueryLatin.length >= 3 && lVar.includes(coreQueryLatin)) ||
                (pVar && phoneticQuery && pVar.includes(phoneticQuery)) ||
                (pVar && coreQueryPhonetic && coreQueryPhonetic.length >= 3 && pVar.includes(coreQueryPhonetic))) {
                isContainment = true;
                break;
            }

            if (targetTitle.startsWith(cVar) || targetTitle.includes(cVar) ||
                (cVar.length >= 3 && (coreQuery.startsWith(cVar) || coreQuery.includes(cVar))) ||
                foldedQueryTitle.includes(fVar) ||
                (fVar.length >= 3 && coreQueryFolded.includes(fVar)) ||
                (latinQuery && lVar && latinQuery.includes(lVar)) ||
                (coreQueryLatin && lVar && lVar.length >= 3 && coreQueryLatin.includes(lVar)) ||
                (phoneticQuery && pVar && phoneticQuery.includes(pVar)) ||
                (coreQueryPhonetic && pVar && pVar.length >= 3 && coreQueryPhonetic.includes(pVar))) {
                isQueryContainsCandidate = true;
                break;
            }
        }
    }

    if (isExactTitle) {
        score += 100; // Perfect title match
    } else if (isFoldedExact) {
        score += 98; // Exact Sinhala folded orthographic match (e.g. ඟ vs ග)
    } else if (isLatinExact) {
        score += 95; // Exact Sinhala <-> Latin cross-script match
    } else if (isPhoneticExact) {
        score += 92; // Phonetic Romanized match
    } else if (isContainment) {
        score += 55; // Phrase containment
        const extraTokens = Math.max(0, tokenize(cleanedTitle).length - targetTitleTokens.length);
        if (extraTokens > 0) {
            score -= Math.min(30, extraTokens * 5);
        }
    } else if (isQueryContainsCandidate) {
        score += 65; // User query contains candidate title part
        let matchedPartToks = false;
        for (const part of candidateParts) {
            const candToks = tokenize(part);
            if (candToks.length > 0 && candToks.every(t => targetTitleTokens.includes(t) || features.tokens.includes(t))) {
                matchedPartToks = true;
                break;
            }
        }
        if (matchedPartToks) {
            score += 20;
        }
    } else {
        // Token overlap ratio for title
        let matchedTitleTokens = 0;
        const latinCandTokens = tokenize(latinCandVariants.join(' '));
        const latinQueryTokens = tokenize(latinQuery);
        const phoneticCandTokens = tokenize(phoneticCandVariants.join(' '));
        const phoneticQueryTokens = tokenize(phoneticQuery);

        for (const token of targetTitleTokens) {
            const foldedTok = normalizeSinhala(token);
            const pTok = normalizePhoneticLatin(sinhalaToLatin(token));
            if (candidateTokens.has(token) || cleanedTitle.includes(token) ||
                foldedCandVariants.some(f => f.includes(foldedTok)) ||
                latinCandTokens.includes(token) ||
                phoneticCandTokens.includes(pTok)) {
                matchedTitleTokens++;
            }
        }
        for (const lTok of latinQueryTokens) {
            if (latinCandTokens.includes(lTok)) {
                matchedTitleTokens = Math.max(matchedTitleTokens, 1);
            }
        }

        const titleTokenRatio = targetTitleTokens.length > 0
            ? matchedTitleTokens / targetTitleTokens.length
            : 0;

        // Candidate title tokens in query
        const candTitleTokens = tokenize(coreCandB || coreCandA || cleanedTitle);
        let matchedCandTokens = 0;
        for (const token of candTitleTokens) {
            if (targetTitleTokens.includes(token) || targetTitle.includes(token) ||
                (!features.hasDelimiter && features.tokens.includes(token))) {
                matchedCandTokens++;
            }
        }
        const candTokenRatio = candTitleTokens.length > 0
            ? matchedCandTokens / candTitleTokens.length
            : 0;

        score += Math.round(Math.max(titleTokenRatio, candTokenRatio) * 50);

        if (features.hasDelimiter && targetTitleTokens.length >= 2 && titleTokenRatio < 0.5) {
            score -= 50;
        } else if (matchedTitleTokens === 0 && matchedCandTokens === 0) {
            score -= 50;
        }
    }

    // Descriptor terms bonus (e.g. "rap", "hip hop", "song")
    if (features.descriptorTokens && features.descriptorTokens.length > 0) {
        for (const desc of features.descriptorTokens) {
            if (combined.includes(desc)) {
                score += 10;
                break;
            }
        }
    }

    // --- 2. ARTIST MATCHING ---
    const targetArtist = (targetArtistStr || '').toLowerCase().trim();
    if (targetArtist) {
        const cleanedTargetArtist = cleanAuthor(targetArtist);
        const latinTargetArtist = sinhalaToLatin(targetArtist);
        const artistTokens = tokenize(targetArtist);

        let artistMatched = false;

        // Check if author matches target artist
        if (cleanedAuthor === cleanedTargetArtist || authorLower.includes(cleanedTargetArtist) || cleanedAuthor.includes(cleanedTargetArtist) ||
            (latinTargetArtist && (cleanedAuthor.includes(latinTargetArtist) || authorLower.includes(latinTargetArtist)))) {
            score += 45;
            artistMatched = true;
        } else if ((candidateParts.length > 1 || rawTitle.toLowerCase().trim() !== targetArtist) && (rawTitle.toLowerCase().includes(targetArtist) || (latinTargetArtist && rawTitle.toLowerCase().includes(latinTargetArtist)))) {
            score += 40;
            artistMatched = true;
        } else if (candidateParts.length > 1 && candidateParts.some(p => p.toLowerCase().includes(targetArtist) || targetArtist.includes(p.toLowerCase()) || (latinTargetArtist && p.toLowerCase().includes(latinTargetArtist)))) {
            score += 40;
            artistMatched = true;
        } else {
            let matchedArtistTokens = 0;
            for (const token of artistTokens) {
                if (candidateTokens.has(token) || cleanedAuthor.includes(token)) {
                    matchedArtistTokens++;
                }
            }
            if (artistTokens.length > 0 && matchedArtistTokens / artistTokens.length >= 0.7) {
                score += 35;
                artistMatched = true;
            }
        }

        // Heavy penalty if user explicitly asked for an artist, but candidate is from an unrelated artist
        if (!artistMatched) {
            // When query is non-Latin/Sinhala and title matched, channel is often Romanized
            const isNonLatinTitleMatch = features.isNonLatin && (
                rawTitle.includes(features.cleaned) ||
                cleanedTitle.includes(targetTitle) ||
                normalizeSinhala(cleanedTitle).includes(normalizeSinhala(targetTitle)) ||
                sinhalaToLatin(cleanedTitle).includes(sinhalaToLatin(targetTitle))
            );

            if (!isNonLatinTitleMatch) {
                score -= 60;
            }
        }
    } else {
        // When hasDelimiter is false (e.g. user typed "blinding lights the weeknd")
        const authorTokens = tokenize(cleanedAuthor);
        const authorMatchesQuery = Boolean(
            cleanedAuthor && (
                features.cleaned.toLowerCase().includes(cleanedAuthor) ||
                features.tokens.join(' ').includes(cleanedAuthor)
            )
        );
        const authorTokensMatch = authorTokens.length > 0 && authorTokens.every(tok => features.tokens.includes(tok));

        if (authorMatchesQuery || authorTokensMatch) {
            score += 40; // Artist matched within query string
        } else if (authorLower.includes('topic') || authorLower.includes('vevo') || authorLower.includes('official')) {
            if (score > 35) {
                score += 15;
            }
        }
    }

    // Featured artists bonus
    for (const feat of features.featuredArtists) {
        if (combined.includes(feat.toLowerCase())) {
            score += 15;
        }
    }

    // --- 3. VERSION / MODIFIER ALIGNMENT ---
    const userWantedSlowed = features.activeModifiers.has('slowed');
    const userWantedReverb = features.activeModifiers.has('reverb');
    const userWantedSlowedReverb = (userWantedSlowed && userWantedReverb) ||
        features.activeModifiers.has('slowed + reverb') ||
        features.activeModifiers.has('slowed & reverb') ||
        features.activeModifiers.has('slowed and reverb');
    const userWantedRemix = features.activeModifiers.has('remix');
    const userWantedLive = features.activeModifiers.has('live');
    const userWantedCover = features.activeModifiers.has('cover');
    const userWantedAcoustic = features.activeModifiers.has('acoustic');
    const userHasAnyModifier = features.activeModifiers.size > 0;

    const candHasSlowed = combined.includes('slowed');
    const candHasReverb = combined.includes('reverb');
    const candHasRemix = combined.includes('remix');
    const candHasLive = combined.includes('live');
    const candHasCover = combined.includes('cover');
    const candHasAcoustic = combined.includes('acoustic');

    if (userWantedSlowedReverb) {
        if (candHasSlowed && candHasReverb) {
            score += 50; // Exact match for slowed + reverb
        } else if (candHasSlowed) {
            score += 30; // Acceptable slowed variant
        } else {
            score -= 40; // Studio original when slowed+reverb was explicitly requested
        }
    } else if (userWantedSlowed) {
        if (candHasSlowed) {
            score += 45; // Candidate has slowed (with or without reverb)
        } else {
            score -= 40;
        }
    } else if (userWantedRemix) {
        if (candHasRemix) {
            score += 45;
        } else {
            score -= 40;
        }
    } else if (userWantedLive) {
        if (candHasLive) {
            score += 45;
        } else {
            score -= 40;
        }
    } else if (userWantedCover) {
        if (candHasCover) {
            score += 45;
        } else {
            score -= 35;
        }
    } else if (userWantedAcoustic) {
        if (candHasAcoustic) {
            score += 45;
        } else {
            score -= 35;
        }
    } else if (!userHasAnyModifier) {
        // User requested studio original recording: penalize unrequested variants so original wins,
        // but avoid excessive stacking that would completely wipe valid alternative recordings
        if (candHasCover) {
            score -= 55;
        } else if (candHasRemix) {
            score -= 40;
        } else if (candHasSlowed || candHasReverb) {
            score -= 30; // Mild penalty so studio original wins, but slowed version is not wiped out
        } else if (candHasLive) {
            score -= 30;
        } else if (candHasAcoustic) {
            score -= 20;
        }
    }

    // --- 4. PENALIZE JUNK TERMS ---
    for (const junk of JUNK_TERMS) {
        if (!features.cleaned.toLowerCase().includes(junk) && combined.includes(junk)) {
            score -= 90;
        }
    }

    // --- 5. NON-LATIN SCRIPT ACCURACY ---
    if (features.isNonLatin) {
        if (rawTitle.includes(features.cleaned) || rawTitle.includes(features.expectedTitle) ||
            normalizeSinhala(rawTitle).includes(normalizeSinhala(features.cleaned))) {
            score += 50;
        }
    }

    // --- 6. DURATION SANITY ---
    const durationMs = track.info.duration || 0;
    if (durationMs > 0 && durationMs < 30000 && !features.cleaned.toLowerCase().includes('short') && !features.cleaned.toLowerCase().includes('meme')) {
        score -= 35; // Too short (< 30s)
    }
    if (durationMs > 3600000 && !features.cleaned.toLowerCase().includes('hour') && !features.cleaned.toLowerCase().includes('mix') && !features.cleaned.toLowerCase().includes('album')) {
        score -= 40; // Too long (> 1 hour)
    }
    if (durationMs >= 90000 && durationMs <= 420000) {
        score += 10; // Plausible music track duration bonus (1.5 - 7 minutes)
    }

    return score;
}

/**
 * Calculates a balanced confidence score (0 to 100+) for a candidate track against query features.
 * Evaluates bidirectional "Artist - Title" vs "Title - Artist" orientations when delimiter is present.
 *
 * @param {Object} track - Lavalink candidate track
 * @param {Object} features - Parsed query features
 * @returns {number} Composite relevance score
 */
function calculateScore(track, features) {
    if (!track?.info) return -100;

    if (!features.hasDelimiter || !features.delimiterPartA || !features.delimiterPartB) {
        return scoreSingleOrientation(track, features.expectedTitle, features.expectedArtist, features);
    }

    // Bidirectional scoring: test both (Part A = Artist, Part B = Title) and (Part A = Title, Part B = Artist)
    const scoreOrientation1 = scoreSingleOrientation(track, features.delimiterPartB, features.delimiterPartA, features);
    const scoreOrientation2 = scoreSingleOrientation(track, features.delimiterPartA, features.delimiterPartB, features);

    return Math.max(scoreOrientation1, scoreOrientation2);
}

/**
 * Evaluates candidate tracks, calculates scores, and assigns a confidence level.
 *
 * @param {Array<Object>} tracks - Array of candidate tracks
 * @param {string} query - Raw search query
 * @returns {Array<Object>} Ranked tracks with confidence metadata
 */
function rankTracks(tracks, query) {
    if (!tracks || !tracks.length) return [];
    if (isUrl(query)) return tracks; // Direct URLs retain provider's exact load order

    const features = extractQueryFeatures(query);

    const scored = tracks.map(track => {
        const score = calculateScore(track, features);
        if (track && typeof track === 'object') {
            track._relevanceScore = score;
        }
        return { track, score };
    }).sort((a, b) => b.score - a.score);

    const topTrack = scored[0]?.track;
    const secondTrack = scored[1]?.track;
    const topScore = scored[0]?.score ?? -Infinity;
    const secondScore = scored[1]?.score ?? -Infinity;

    let sameArtist = false;
    if (topTrack && secondTrack) {
        const topAuthor = cleanAuthor(topTrack.info?.author || '');
        const secondAuthor = cleanAuthor(secondTrack.info?.author || '');
        if (topAuthor && secondAuthor && (topAuthor === secondAuthor || topAuthor.includes(secondAuthor) || secondAuthor.includes(topAuthor))) {
            sameArtist = true;
        }
    }

    let confidence = CONFIDENCE_LEVELS.LOW;

    // Evaluate confidence:
    // HIGH: Top score >= 75 and clear lead (or same artist), OR top score >= 50 with clear lead, OR single candidate >= 45
    // MEDIUM: Score >= 35 (plausible match / ambiguous candidates)
    // LOW: Top score < 35 or topScore <= 0 (unreliable)
    if (topScore <= 0) {
        confidence = CONFIDENCE_LEVELS.LOW;
    } else if (topScore >= CONFIDENCE_THRESHOLDS.HIGH_SCORE && (sameArtist || (topScore - secondScore) >= CONFIDENCE_THRESHOLDS.AMBIGUITY_DELTA)) {
        confidence = CONFIDENCE_LEVELS.HIGH;
    } else if (topScore >= 50 && (topScore - secondScore) >= 15) {
        confidence = CONFIDENCE_LEVELS.HIGH;
    } else if (topScore >= 45 && scored.length === 1) {
        confidence = CONFIDENCE_LEVELS.HIGH;
    } else if (topScore >= CONFIDENCE_THRESHOLDS.MIN_SCORE) {
        confidence = CONFIDENCE_LEVELS.MEDIUM;
    } else {
        confidence = CONFIDENCE_LEVELS.LOW;
    }

    const result = scored.map(item => item.track);
    result.confidence = confidence;
    result.topScore = topScore;
    result.queryFeatures = features;

    return result;
}

/**
 * Searches Lavalink with intelligent fallback between YouTube Music and YouTube
 *
 * @param {Object} player - Lavalink player instance
 * @param {string} rawQuery - Search query or URL
 * @param {Object} requestUser - Discord user requesting the search
 * @returns {Promise<Object>} Lavalink search result with ranked tracks and confidence metadata
 */
async function searchMusic(player, rawQuery, requestUser, options = {}) {
    const trimmed = cleanQueryString(rawQuery);
    if (!trimmed) {
        return { loadType: 'empty', tracks: [], playlist: null, confidence: CONFIDENCE_LEVELS.LOW };
    }

    if (options.signal?.aborted) {
        return { loadType: 'error', exception: { message: 'Audio search cancelled' }, tracks: [], cancelled: true };
    }

    const cacheKey = (options.source ? `${options.source}:` : '') + trimmed.toLowerCase();

    // 1. Check TTL cache
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        if (typeof performanceMonitor?.recordSearch === 'function') {
            performanceMonitor.recordSearch(0.5, true);
        }
        return cloneSearchResult(cached.result, requestUser);
    }

    // 2. Check in-flight deduplication
    if (inFlightSearches.has(cacheKey)) {
        if (typeof performanceMonitor?.recordInFlightDeduplicated === 'function') {
            performanceMonitor.recordInFlightDeduplicated();
        }
        const sharedPromise = inFlightSearches.get(cacheKey);
        let sharedResult;
        if (options?.signal) {
            if (options.signal.aborted) {
                return { loadType: 'error', exception: { message: 'Audio search cancelled' }, tracks: [], cancelled: true };
            }
            sharedResult = await Promise.race([
                sharedPromise,
                new Promise((_, reject) => {
                    options.signal.addEventListener('abort', () => {
                        const err = new Error('Audio search cancelled');
                        err.name = 'AbortError';
                        reject(err);
                    }, { once: true });
                })
            ]).catch((err) => {
                if (err?.name === 'AbortError' || err?.message === 'Audio search cancelled') {
                    return { loadType: 'error', exception: { message: 'Audio search cancelled' }, tracks: [], cancelled: true };
                }
                throw err;
            });
        } else {
            sharedResult = await sharedPromise;
        }
        return cloneSearchResult(sharedResult, requestUser);
    }

    // 3. Execute search with performance tracking
    const stopTimer = typeof performanceMonitor?.startSearch === 'function'
        ? performanceMonitor.startSearch()
        : null;

    const searchPromise = (async () => {
        try {
            let result;
            try {
                result = await searchBulkhead.run(
                    () => executeSearchMusic(player, trimmed, requestUser, options),
                    { signal: options?.signal, timeoutMs: 10_000 }
                );
            } catch (err) {
                if (err?.code === 'BULKHEAD_BUSY' || err?.isBusy) {
                    return {
                        loadType: 'error',
                        isBusy: true,
                        exception: { message: 'Music search service is currently at maximum capacity. Please try again shortly.' },
                        tracks: [],
                        confidence: CONFIDENCE_LEVELS.LOW,
                    };
                }
                if (err?.name === 'AbortError' || err?.message === 'Audio search cancelled') {
                    return { loadType: 'error', exception: { message: 'Audio search cancelled' }, tracks: [], cancelled: true };
                }
                throw err;
            }

            // Cache successful track or playlist results
            if (result && !result.cancelled && !result.isBusy && (result.loadType === 'track' || result.loadType === 'playlist' || (result.tracks && result.tracks.length > 0))) {
                if (searchCache.size >= MAX_SEARCH_CACHE_SIZE) {
                    const oldestKey = searchCache.keys().next().value;
                    searchCache.delete(oldestKey);
                }
                searchCache.set(cacheKey, {
                    result,
                    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
                });
            }
            return result;
        } finally {
            inFlightSearches.delete(cacheKey);
            if (stopTimer) stopTimer(false);
        }
    })();

    inFlightSearches.set(cacheKey, searchPromise);
    const finalResult = await searchPromise;
    return cloneSearchResult(finalResult, requestUser);
}

async function searchWithTimeout(player, searchOptions, requestUser, timeoutMs = 8000, signal = null) {
    if (!player || typeof player.search !== 'function') return null;
    if (signal?.aborted) {
        const err = new Error('Audio search cancelled');
        err.name = 'AbortError';
        throw err;
    }
    let timeoutId;
    let abortListener;
    const searchPromise = player.search(searchOptions, requestUser);
    const abortPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const err = new Error(`Audio search timed out after ${timeoutMs}ms`);
            err.name = 'TimeoutError';
            reject(err);
        }, timeoutMs);
        if (signal) {
            abortListener = () => {
                const err = new Error('Audio search cancelled');
                err.name = 'AbortError';
                reject(err);
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }
    });

    try {
        return await Promise.race([searchPromise, abortPromise]);
    } finally {
        clearTimeout(timeoutId);
        if (signal && abortListener) {
            signal.removeEventListener('abort', abortListener);
        }
    }
}

function isRateLimitError(errOrRes) {
    if (!errOrRes) return false;
    const msg = String(errOrRes.message || errOrRes.exception?.message || errOrRes.error || errOrRes || '');
    const status = errOrRes.status || errOrRes.exception?.status || errOrRes.code;
    return status === 429 || /429|RATE_LIMITED|rate\s*limited|Too Many Requests/i.test(msg);
}

function markPlayerNodeRateLimited(player, reason = 'YouTube HTTP 429 Rate Limited') {
    const node = player?.node;
    const host = node?.options?.host || node?.host;
    const port = node?.options?.port || node?.port;
    if (host && port && player?.client?.publicNodeProvider) {
        player.client.publicNodeProvider.markNodeFailed(host, port, reason, 'RATE_LIMITED');
    }
}

async function fetchYouTubeMetadata(urlOrId) {
    if (!urlOrId) return null;
    try {
        const idMatch = String(urlOrId).match(/(?:v=|\/vi\/|\/embed\/|youtu\.be\/|\/v\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
        const id = idMatch ? idMatch[1] : (String(urlOrId).length === 11 ? urlOrId : null);
        const targetUrl = id ? `https://www.youtube.com/watch?v=${id}` : urlOrId;
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
        const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const data = await res.json();
            return {
                title: data.title || '',
                author: data.author_name || '',
                thumbnail: data.thumbnail_url || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
                id,
            };
        }
    } catch (err) {
        logger.debug(`YouTube oEmbed metadata fetch failed for ${urlOrId}:`, err?.message || err);
    }
    return null;
}

async function executeSearchMusic(player, trimmed, requestUser, options = {}) {
    const { classifyInput, SUPPORTED_TYPES } = require('./urlClassifier');
    const classification = classifyInput(trimmed);

    // 1. Unsupported external URLs: reject with helpful error
    if (classification.type === SUPPORTED_TYPES.UNSUPPORTED_URL) {
        logger.debug(`Unsupported URL rejected: "${trimmed}" (${classification.error})`);
        return {
            loadType: 'error',
            exception: { message: classification.error || 'Unsupported URL' },
            tracks: [],
            confidence: CONFIDENCE_LEVELS.LOW,
            isUnsupportedUrl: true,
        };
    }

    // 2. YouTube Single Video / YouTube Music Track Link
    if (classification.type === SUPPORTED_TYPES.YOUTUBE_TRACK) {
        let res = null;
        let lastError = null;

        try {
            res = await searchWithTimeout(player, { query: classification.canonicalUrl }, requestUser, 8000, options.signal);
        } catch (err) {
            lastError = err;
        }

        const isRateLimited = isRateLimitError(res) || isRateLimitError(lastError);
        if (isRateLimited) {
            logger.warn(`[SEARCH] Lavalink node rate-limited on YouTube for "${trimmed}". Marking node and migrating...`);
            markPlayerNodeRateLimited(player, 'YouTube HTTP 429 Rate Limited');
            if (player?.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode) {
                const migrated = await player.client.lavalinkConnectionManager.migratePlayerToHealthyNode(player, 'youtube-429-rate-limit').catch(() => false);
                if (migrated) {
                    try {
                        res = await searchWithTimeout(player, { query: classification.canonicalUrl }, requestUser, 8000, options.signal);
                        lastError = null;
                    } catch (retryErr) {
                        lastError = retryErr;
                    }
                }
            }
        }

        if (res && res.tracks && res.tracks.length > 0) {
            // Ensure exact match by video identifier
            const exactMatch = classification.id
                ? res.tracks.find(t => t.info?.identifier === classification.id)
                : res.tracks[0];

            if (exactMatch) {
                return {
                    loadType: 'track',
                    tracks: [exactMatch],
                    playlist: null,
                    confidence: CONFIDENCE_LEVELS.HIGH,
                };
            }

            // If an exact YouTube video ID was requested and Lavalink returned tracks but none matched that ID,
            // reject with error to prevent playing an unrelated video.
            if (classification.id) {
                return {
                    loadType: 'error',
                    exception: { message: `Requested YouTube track is unavailable or private (ID: ${classification.id})` },
                    tracks: [],
                    confidence: CONFIDENCE_LEVELS.LOW,
                };
            }
        }

        // Direct YouTube URL load failed (HTTP 429 rate limit or unavailable): Fallback to YouTube oEmbed metadata + search
        const ytMeta = await fetchYouTubeMetadata(classification.canonicalUrl || classification.id);
        if (ytMeta && ytMeta.title) {
            logger.info(`[SEARCH] Direct load failed; falling back to oEmbed search for "${ytMeta.title}" by "${ytMeta.author}"`);
            const fallbackQuery = `${ytMeta.title} ${ytMeta.author}`.trim();
            let matchedRes = null;
            try {
                matchedRes = await searchWithTimeout(player, { query: fallbackQuery, source: 'ytmsearch' }, requestUser, 5000, options.signal).catch(() => null);
                if (!matchedRes?.tracks?.length && !options.signal?.aborted) {
                    matchedRes = await searchWithTimeout(player, { query: fallbackQuery, source: 'ytsearch' }, requestUser, 5000, options.signal).catch(() => null);
                }
            } catch (fallbackErr) {
                logger.debug(`oEmbed search query failed:`, fallbackErr?.message || fallbackErr);
            }

            if (matchedRes?.tracks?.length) {
                const matchedTrack = classification.id
                    ? matchedRes.tracks.find(t => t.info?.identifier === classification.id)
                    : matchedRes.tracks[0];
                if (matchedTrack) {
                    if (ytMeta.thumbnail && !matchedTrack.info?.artworkUrl) {
                        matchedTrack.info = { ...matchedTrack.info, artworkUrl: ytMeta.thumbnail };
                    }
                    return {
                        loadType: 'track',
                        tracks: [matchedTrack],
                        playlist: null,
                        confidence: CONFIDENCE_LEVELS.HIGH,
                    };
                }
            }
        }

        return {
            loadType: 'error',
            exception: { message: lastError?.message || res?.exception?.message || 'YouTube track unavailable or private' },
            tracks: [],
            confidence: CONFIDENCE_LEVELS.LOW,
        };
    }

    // 3. YouTube Playlist Link
    if (classification.type === SUPPORTED_TYPES.YOUTUBE_PLAYLIST) {
        let res = null;
        let lastError = null;

        try {
            res = await searchWithTimeout(player, { query: classification.canonicalUrl }, requestUser, 8000, options.signal);
        } catch (err) {
            lastError = err;
        }

        if (isRateLimitError(res) || isRateLimitError(lastError)) {
            logger.warn(`[SEARCH] Lavalink node rate-limited on YouTube playlist "${trimmed}". Marking node and migrating...`);
            markPlayerNodeRateLimited(player, 'YouTube HTTP 429 Rate Limited (Playlist)');
            if (player?.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode) {
                const migrated = await player.client.lavalinkConnectionManager.migratePlayerToHealthyNode(player, 'youtube-playlist-429-rate-limit').catch(() => false);
                if (migrated) {
                    try {
                        res = await searchWithTimeout(player, { query: classification.canonicalUrl }, requestUser, 8000, options.signal);
                        lastError = null;
                    } catch (retryErr) {
                        lastError = retryErr;
                    }
                }
            }
        }

        if (res && res.tracks && res.tracks.length > 0) {
            res.confidence = CONFIDENCE_LEVELS.HIGH;
            return res;
        }
        return {
            loadType: 'error',
            exception: { message: lastError?.message || res?.exception?.message || 'YouTube playlist unavailable or empty' },
            tracks: [],
            confidence: CONFIDENCE_LEVELS.LOW,
        };
    }

    // 4. Spotify Track Link
    if (classification.type === SUPPORTED_TYPES.SPOTIFY_TRACK) {
        try {
            const nativeRes = await searchWithTimeout(player, { query: classification.canonicalUrl }, requestUser, 5000, options.signal).catch(() => null);
            if (nativeRes && nativeRes.tracks && nativeRes.tracks.length > 0) {
                nativeRes.confidence = CONFIDENCE_LEVELS.HIGH;
                return nativeRes;
            }
        } catch (err) {
            logger.debug(`Native Lavalink search for Spotify track failed: ${err?.message || err}`);
        }

        const { getSpotifyTrackMetadata, matchSpotifyTrackToYouTube } = require('./spotifyResolver');
        const targetTrackId = classification.isShortLink ? classification.canonicalUrl : classification.id;
        const meta = await getSpotifyTrackMetadata(targetTrackId);
        if (!meta || !meta.title) {
            return {
                loadType: 'error',
                exception: { message: 'Could not retrieve metadata for Spotify track' },
                tracks: [],
                confidence: CONFIDENCE_LEVELS.LOW,
            };
        }

        const matchedTrack = await matchSpotifyTrackToYouTube(player, meta, requestUser, options);
        if (!matchedTrack) {
            return {
                loadType: 'error',
                exception: { message: `Could not find a reliable audio match for "${meta.title}" by "${meta.artists}"` },
                tracks: [],
                confidence: CONFIDENCE_LEVELS.LOW,
            };
        }

        return {
            loadType: 'track',
            tracks: [matchedTrack],
            playlist: null,
            confidence: CONFIDENCE_LEVELS.HIGH,
        };
    }

    // 5. Spotify Album / Playlist Link
    if (classification.type === SUPPORTED_TYPES.SPOTIFY_ALBUM || classification.type === SUPPORTED_TYPES.SPOTIFY_PLAYLIST) {
        try {
            const nativeRes = await searchWithTimeout(player, { query: classification.canonicalUrl }, requestUser, 5000, options.signal).catch(() => null);
            if (nativeRes && nativeRes.tracks && nativeRes.tracks.length > 0) {
                nativeRes.confidence = CONFIDENCE_LEVELS.HIGH;
                return nativeRes;
            }
        } catch (err) {
            logger.debug(`Native Lavalink search for Spotify collection failed: ${err?.message || err}`);
        }

        const { getSpotifyAlbumTracks, getSpotifyPlaylistTracks, resolveTracksBounded } = require('./spotifyResolver');
        let collection = null;
        if (classification.type === SUPPORTED_TYPES.SPOTIFY_ALBUM) {
            collection = await getSpotifyAlbumTracks(classification.id);
        } else {
            collection = await getSpotifyPlaylistTracks(classification.id);
        }

        if (!collection || !collection.tracks?.length) {
            return {
                loadType: 'error',
                exception: { message: 'Could not retrieve Spotify album/playlist entries' },
                tracks: [],
                confidence: CONFIDENCE_LEVELS.LOW,
            };
        }

        const matchedTracks = await resolveTracksBounded(player, collection.tracks, requestUser, 4, options);
        if (!matchedTracks.length) {
            return {
                loadType: 'error',
                exception: { message: 'No playable tracks could be matched for this Spotify collection' },
                tracks: [],
                confidence: CONFIDENCE_LEVELS.LOW,
            };
        }

        const totalDuration = matchedTracks.reduce((acc, t) => acc + (t.info?.duration || 0), 0);
        return {
            loadType: 'playlist',
            playlist: {
                title: collection.title,
                name: collection.title,
                thumbnail: collection.thumbnail,
                duration: totalDuration,
                uri: classification.canonicalUrl,
            },
            tracks: matchedTracks,
            confidence: CONFIDENCE_LEVELS.HIGH,
        };
    }

    // 6. Explicit Search Prefix or Source Check (e.g. ytmsearch:, ytsearch:, or options.source)
    const hasExplicitPrefix = /^[a-z0-9_-]+:/i.test(trimmed);
    if (hasExplicitPrefix || options.source) {
        try {
            const searchOpts = hasExplicitPrefix
                ? { query: trimmed }
                : { query: trimmed, source: options.source };
            const res = await searchWithTimeout(player, searchOpts, requestUser, 8000, options.signal);
            if (res && res.tracks && res.tracks.length > 0) {
                const queryText = hasExplicitPrefix ? trimmed.replace(/^[a-z0-9_-]+:/i, '') : trimmed;
                const ranked = rankTracks(res.tracks, queryText);
                res.tracks = ranked;
                res.confidence = ranked.confidence || CONFIDENCE_LEVELS.MEDIUM;
                res.topScore = ranked.topScore;
                return res;
            }
            return res || { loadType: 'empty', tracks: [], confidence: CONFIDENCE_LEVELS.LOW };
        } catch (err) {
            logger.debug(`Explicit search failed for "${trimmed}":`, err?.message || err);
            return { loadType: 'error', exception: { message: err?.message || 'Search failed' }, tracks: [], confidence: CONFIDENCE_LEVELS.LOW };
        }
    }

    // 7. Text Search: Parallel combined search (YouTube Music + YouTube)
    const features = parseSearchQuery(trimmed);
    const searchStart = Date.now();

    try {
        const [primaryResult, fallbackResult] = await Promise.all([
            searchWithTimeout(player, { query: trimmed, source: 'ytmsearch' }, requestUser, 7000, options.signal).catch((err) => {
                logger.debug(`ytmsearch failed for "${trimmed}":`, err?.message || err);
                return null;
            }),
            searchWithTimeout(player, { query: trimmed, source: 'ytsearch' }, requestUser, 7000, options.signal).catch((err) => {
                logger.debug(`ytsearch failed for "${trimmed}":`, err?.message || err);
                return null;
            }),
        ]);

        if (options.signal?.aborted) {
            return { loadType: 'error', exception: { message: 'Audio search cancelled' }, tracks: [], cancelled: true };
        }

        // Combine primary (ytmsearch) and fallback (ytsearch) candidates without duplicates
        const combinedTracks = [];
        const seenIds = new Set();
        const seenKeys = new Set();

        const addCandidate = (t) => {
            if (!t?.info) return;
            const id = t.info.identifier || t.info.uri;
            const titleLower = String(t.info.title || '').toLowerCase();
            const modTag = (titleLower.includes('remix') ? 'remix' : (titleLower.includes('live') ? 'live' : (titleLower.includes('cover') ? 'cover' : (titleLower.includes('slowed') ? 'slowed' : 'studio'))));
            const dedupKey = `${titleLower.replace(/[^a-z0-9\u0D80-\u0DFF]/g, '')}::${String(t.info.author || '').toLowerCase().replace(/[^a-z0-9\u0D80-\u0DFF]/g, '')}::${modTag}`;
            if (id && seenIds.has(id)) return;
            if (dedupKey && seenKeys.has(dedupKey)) return;
            if (id) seenIds.add(id);
            if (dedupKey) seenKeys.add(dedupKey);
            combinedTracks.push(t);
        };

        if (primaryResult?.tracks) {
            for (const t of primaryResult.tracks) addCandidate(t);
        }
        if (fallbackResult?.tracks) {
            for (const t of fallbackResult.tracks) addCandidate(t);
        }

        // Check if node is rate limited on YouTube
        const isRateLimited = isRateLimitError(primaryResult) || isRateLimitError(fallbackResult);
        if (isRateLimited) {
            logger.warn(`[SEARCH] Lavalink node rate-limited on YouTube text search for "${trimmed}". Marking node and migrating...`);
            markPlayerNodeRateLimited(player, 'YouTube HTTP 429 Rate Limited (Text Search)');
            if (player?.client?.lavalinkConnectionManager?.migratePlayerToHealthyNode) {
                const migrated = await player.client.lavalinkConnectionManager.migratePlayerToHealthyNode(player, 'text-search-429-rate-limit').catch(() => false);
                if (migrated) {
                    try {
                        const [retryYtm, retryYt] = await Promise.all([
                            searchWithTimeout(player, { query: trimmed, source: 'ytmsearch' }, requestUser, 6000, options.signal).catch(() => null),
                            searchWithTimeout(player, { query: trimmed, source: 'ytsearch' }, requestUser, 6000, options.signal).catch(() => null),
                        ]);
                        if (retryYtm?.tracks) for (const t of retryYtm.tracks) addCandidate(t);
                        if (retryYt?.tracks) for (const t of retryYt.tracks) addCandidate(t);
                    } catch (_) {}
                }
            }
        }

        let ranked = combinedTracks.length > 0 ? rankTracks(combinedTracks, trimmed) : [];

        // If no candidates or low confidence match, initiate smart cascading fallbacks
        if (!options.signal?.aborted && (!ranked.length || (ranked.topScore ?? 0) < 35)) {
            const fallbackPromises = [];

            // Fallback 1: Query stripped of descriptor terms (e.g. "kolaniya gama rap" -> "kolaniya gama")
            if (features.coreTitle && features.coreTitle !== trimmed) {
                fallbackPromises.push(
                    searchWithTimeout(player, { query: features.coreTitle, source: 'ytsearch' }, requestUser, 5000, options.signal)
                        .catch(() => null)
                );
            }

            // Fallback 2: Cross-script transliteration
            if (features.isSinhala) {
                const latinQuery = sinhalaToLatin(trimmed);
                if (latinQuery && latinQuery !== trimmed) {
                    fallbackPromises.push(
                        searchWithTimeout(player, { query: latinQuery, source: 'ytsearch' }, requestUser, 5000, options.signal)
                            .catch(() => null)
                    );
                }
            } else if (!features.isNonLatin) {
                // Romanized Singlish -> Sinhala Unicode
                const sinhalaQuery = latinToSinhala(features.coreTitle || trimmed);
                if (sinhalaQuery && sinhalaQuery !== trimmed && /[\u0D80-\u0DFF]/.test(sinhalaQuery)) {
                    fallbackPromises.push(
                        searchWithTimeout(player, { query: sinhalaQuery, source: 'ytsearch' }, requestUser, 5000, options.signal)
                            .catch(() => null)
                    );
                }
            }

            // Fallback 3: Alternative Lavalink source (SoundCloud)
            fallbackPromises.push(
                searchWithTimeout(player, { query: trimmed, source: 'scsearch' }, requestUser, 5000, options.signal)
                    .catch(() => null)
            );

            // Fallback 4: External song metadata lookup via iTunes to resolve title & artist
            if (!combinedTracks.length && !features.isUrl) {
                try {
                    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(trimmed)}&media=music&entity=song&limit=3`;
                    const itunesRes = await fetch(itunesUrl, { signal: AbortSignal.timeout(3000) });
                    if (itunesRes.ok) {
                        const itunesData = await itunesRes.json();
                        if (Array.isArray(itunesData?.results) && itunesData.results.length > 0) {
                            const firstSong = itunesData.results[0];
                            const resolvedQuery = `${firstSong.trackName} ${firstSong.artistName}`.trim();
                            fallbackPromises.push(
                                searchWithTimeout(player, { query: resolvedQuery, source: 'ytmsearch' }, requestUser, 5000, options.signal)
                                    .catch(() => null),
                                searchWithTimeout(player, { query: resolvedQuery, source: 'ytsearch' }, requestUser, 5000, options.signal)
                                    .catch(() => null)
                            );
                        }
                    }
                } catch (_) {}
            }

            const fallbackResults = await Promise.all(fallbackPromises);
            for (const fbRes of fallbackResults) {
                if (fbRes?.tracks) {
                    for (const t of fbRes.tracks) addCandidate(t);
                }
            }

            if (combinedTracks.length > 0) {
                ranked = rankTracks(combinedTracks, trimmed);
            }
        }

        if (combinedTracks.length > 0 && ranked.length > 0) {
            const chosenResult = fallbackResult || primaryResult || { loadType: 'track', tracks: [] };
            chosenResult.tracks = ranked;
            chosenResult.confidence = ranked.confidence;
            chosenResult.topScore = ranked.topScore;
            const topTrack = ranked[0];
            const providerUsed = (primaryResult?.tracks?.length > 0 && fallbackResult?.tracks?.length > 0)
                ? 'combined (ytmsearch+ytsearch)'
                : (fallbackResult?.tracks?.length > 0 ? 'ytsearch' : 'ytmsearch');

            logger.info(`[SEARCH-DIAG] query="${trimmed}" provider=${providerUsed} candidates=${ranked.length} topCandidate="${topTrack?.info?.title}" uploader="${topTrack?.info?.author}" duration=${topTrack?.info?.duration}ms score=${ranked.topScore} confidence=${ranked.confidence} elapsed=${Date.now() - searchStart}ms`);
            return chosenResult;
        }

        const emptyRes = fallbackResult || primaryResult || { loadType: 'empty', tracks: [], confidence: CONFIDENCE_LEVELS.LOW };
        emptyRes.confidence = CONFIDENCE_LEVELS.LOW;
        return emptyRes;
    } catch (err) {
        logger.debug(`Text search failed for "${trimmed}":`, err?.message || err);
        return { loadType: 'error', exception: { message: err?.message || 'Search failed' }, tracks: [], confidence: CONFIDENCE_LEVELS.LOW };
    }
}

/**
 * Resolves an alternative valid audio stream for a failing or expired track.
 * Searches YouTube (ytsearch) using the song title and artist, ensuring the candidate
 * matches the intended song and preserving requester and metadata.
 *
 * @param {Object} player - Lavalink player instance
 * @param {Object} track - The track that encountered a failure
 * @returns {Promise<Object|null>} The alternative track or null if no reliable match found
 */
async function resolveAlternativeTrack(player, track) {
    if (!player || !track?.info?.title) return null;

    const originalTitle = track.info.title;
    const originalAuthor = track.info.author || '';
    const query = `${originalTitle} ${originalAuthor}`.trim();

    try {
        const searchResult = await player.search({
            query,
            source: 'ytsearch'
        }, track.requester);

        if (!searchResult?.tracks?.length) return null;

        const ranked = rankTracks(searchResult.tracks, query);
        if (!ranked.length) return null;

        const originalId = track.info.identifier;
        const features = extractQueryFeatures(query);
        const candidate = ranked.find(t => {
            if (t.info?.identifier === originalId) return false;
            const score = calculateScore(t, features);
            if (score < 40) return false;
            // Duration check: candidate duration should be within +/- 30s or +/- 25%
            if (track.info.duration > 0 && t.info?.duration > 0) {
                const diff = Math.abs(t.info.duration - track.info.duration);
                if (diff > 30000 && (diff / track.info.duration) > 0.25) return false;
            }
            return true;
        });

        if (!candidate) return null;

        candidate.requester = track.requester;
        candidate._queueId = track._queueId;
        if (track.userData) candidate.userData = { ...track.userData };

        logger.info(`Resolved alternative track for "${originalTitle}" -> "${candidate.info?.title}" (${candidate.info?.identifier})`);
        return candidate;
    } catch (err) {
        logger.debug(`Failed to resolve alternative track for "${originalTitle}":`, err?.message || err);
        return null;
    }
}

module.exports = {
    MODIFIERS,
    JUNK_TERMS,
    CONFIDENCE_LEVELS,
    CONFIDENCE_THRESHOLDS,
    isUrl,
    cleanQueryString,
    normalizeText: cleanQueryString,
    tokenize,
    parseSearchQuery,
    extractQueryFeatures,
    extractModifiers: (q) => extractQueryFeatures(q).activeModifiers,
    calculateScore,
    scoreSingleOrientation,
    scoreTrack: (track, query) => calculateScore(track, extractQueryFeatures(query)),
    rankTracks,
    searchMusic,
    clearSearchCache,
    searchCache,
    normalizeSinhala,
    sinhalaToLatin,
    latinToSinhala,
    normalizePhoneticLatin,
    DESCRIPTOR_TERMS,
    resolveAlternativeTrack,
    fetchYouTubeMetadata,
    isRateLimitError,
    markPlayerNodeRateLimited,
};
