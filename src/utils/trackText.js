const TITLE_NOISE = /\s*[\(\[](official\s*(video|audio|music\s*video|lyric\s*video|visualizer)|lyric\s*video|lyrics?|audio|video|mv|hd|hq|4k|remaster(ed)?|live|ft\.?.*|feat\.?.*|prod\.?.*|visualizer)[\)\]]\s*/gi;
const ARTIST_NOISE = /\s*\b(official(?:\s*youtube)?\s*channel|official|vevo|records?|entertainment)\b\s*/gi;
const TOPIC_SUFFIX = /\s*-\s*Topic$/i;

// Version/edition qualifiers that mark the SAME recording across re-uploads
// (e.g. "Song (Live)" vs "Song (Official Video)"). Stripped only when trailing
// and not parenthesised, so real titles ending in these words stay rare-but-safe.
const TRAILING_QUALIFIER = /[\s\-_]+(official\s*(music\s*)?video|official\s*(music\s*)?audio|official\s*music\s*video|lyric\s*video|lyrics?|visualizer|audio|video|hd|hq|4k|remaster(?:ed)?(?:\s*\d{4})?|live|acoustic|unplugged|sped\s*up|slowed(?:\s*\+?\s*reverb)?|reverb|nightcore|8d(?:\s*audio)?|bass\s*boost(?:ed)?)\s*$/i;

function normalizeString(str = '') {
    let s = str.toLowerCase();
    // Drop featuring/production credits and everything trailing them.
    s = s.replace(/\b(feat|ft|featuring|prod)\b\.?.*$/i, '');
    // Drop bracketed/parenthesised noise — version tags, credits, etc.
    s = s.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '');
    // Drop auto-generated channel suffixes.
    s = s.replace(/\s*-\s*topic\s*$/i, '').replace(/vevo\s*$/i, '');
    // Repeatedly strip trailing version/edition qualifiers (handles stacked tags).
    let prev;
    do { prev = s; s = s.replace(TRAILING_QUALIFIER, ''); } while (s !== prev);
    return s.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function cleanAuthor(author = '') {
    return author
        .replace(/vevo$/i, '')
        .replace(/\s*-\s*topic$/i, '')
        .replace(/official$/i, '')
        .trim();
}

function cleanTitle(title = '') {
    return title.replace(TITLE_NOISE, '').trim();
}

function cleanArtist(artist = '') {
    return artist
        .replace(TOPIC_SUFFIX, '')
        .replace(ARTIST_NOISE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitArtistFromTitle(title, artist) {
    const dashMatch = title.match(/^(.+?)\s*[-\u2013\u2014]\s+(.+)$/);
    if (dashMatch) {
        return { title: dashMatch[2], artist: dashMatch[1] };
    }
    return { title, artist };
}

const GENERIC_ARTISTS = new Set([
    'artist',
    'various artists',
    'various',
    'unknown',
    'unknown artist',
    'va',
    'soundtrack',
    'ost',
]);

function normalizeArtist(name = '') {
    if (!name) return '';
    let s = String(name).replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase();
    s = s.replace(/\s*-\s*topic$/i, '')
         .replace(/vevo$/i, '')
         .replace(/\b(official(?:\s*youtube)?\s*channel|official|vevo|records?|entertainment)\b/gi, '')
         .replace(/\s+/g, ' ')
         .trim();
    return s.normalize('NFC')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isGenericArtist(name = '') {
    const norm = normalizeArtist(name);
    return !norm || GENERIC_ARTISTS.has(norm);
}

function extractCollaborators(title = '', author = '') {
    const found = new Set();

    if (author) {
        let cleanedAuthor = String(author)
            .replace(/\s*-\s*topic$/i, '')
            .replace(/vevo$/i, '')
            .replace(/\b(official(?:\s*youtube)?\s*channel|vevo)\b/gi, '')
            .trim();

        const parts = cleanedAuthor.split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|\+)\s+|\s*,\s*|\s+\/\s+/i);
        for (const p of parts) {
            const norm = normalizeArtist(p);
            if (norm && !isGenericArtist(norm)) {
                found.add(norm);
            }
        }
    }

    if (title) {
        const titleStr = String(title);
        const featMatches = titleStr.matchAll(/[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\]\)]+)[\)\]]/gi);
        for (const match of featMatches) {
            const featPart = match[1];
            const parts = featPart.split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|\+)\s+|\s*,\s*|\s+\/\s+/i);
            for (const p of parts) {
                const norm = normalizeArtist(p);
                if (norm && !isGenericArtist(norm)) {
                    found.add(norm);
                }
            }
        }

        const dashMatch = titleStr.match(/^(.+?)\s*[-\u2013\u2014]\s+(.+)$/);
        if (dashMatch) {
            const potentialArtist = dashMatch[1].trim();
            const parts = potentialArtist.split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|\+)\s+|\s*,\s*|\s+\/\s+/i);
            for (const p of parts) {
                const norm = normalizeArtist(p);
                if (norm && !isGenericArtist(norm)) {
                    found.add(norm);
                }
            }
        }

        const pipeParts = titleStr.split(/\s*\|\s*/);
        if (pipeParts.length > 1) {
            for (let i = 1; i < pipeParts.length; i++) {
                const seg = pipeParts[i].replace(/\b(official\s*(video|audio|music\s*video|lyric\s*video|visualizer)|lyric\s*video|lyrics?|audio|video|mv|hd|hq|4k|visualizer)\b/gi, '').trim();
                if (!seg || seg.length < 2) continue;
                const parts = seg.split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|\+)\s+|\s*,\s*|\s+\/\s+/i);
                for (const p of parts) {
                    const norm = normalizeArtist(p);
                    if (norm && !isGenericArtist(norm)) {
                        found.add(norm);
                    }
                }
            }
        }
    }

    return Array.from(found);
}

const SINHALA_ARTISTS_AND_TERMS = /\b(sinhala|baila|bailo|geeth|geetha|sindu|nonstop|derana|hiru|sarigama|torana|channa|amaradeva|victor\s*ratnayake|victor\s*rathnayake|clarence|jothipala|milton\s*mallawarachchi|rookantha|sanuka|kasun\s*kalhara|costa|smokio|kaizer|drill\s*team|iraj|ranidu|bathiya|santhush|bns|chamara\s*weerasinghe|senaka\s*batagoda|centigradz|kanchana\s*anuradhi|yohani|dinesh\s*gamage|ravi\s*jay|dilo|jayasri|jaya\s*sri|marians|gypsies|sunil\s*perera|nanda\s*malani|edward\s*jayakody|sunil\s*edirisinghe|karunarathna\s*divulgane|nadeemal|charitha\s*attalage|supun\s*perera|lahiru\s*perera|romesh\s*sugathapala|shihan\s*mihiranga|ashanthi|tehan\s*perera|manuranga|fill\s*t|master\s*d|prageeth|wasthi|amal\s*perera|muttiya|hibshi|warsha|pawi\s*yai|anda\s*manda|andamanda|grizzly\s*da\s*zombie|dilu\s*beats|sashi\s*music|dharshana|manjula\s*dilrukshi|aliona|rashini|ruwi\s*sri|uvindu|kaizer\s*kaiz|pradeep|mihiranga|amarasiri\s*peiris|gunadasa\s*kapuge|victor|malani|somathilaka|priyantha|indrachapa|nadeeka\s*guruge|kasun|nadeeka|sandun|chamara|damith\s*asanka|kingsly|shashika\s*nisansala|supun|dinesh|satheeshan|sachie\s*leoze|paradise|nuba\s*ha|maayam\s*tharu\s*rene|adare|manike|sanda|nethu|heena|thaniwee|hitha|oba|mage|sudu|mal|sihinaya)\b/i;
const HINDI_ARTISTS_AND_TERMS = /\b(hindi|bollywood|arijit|neha\s*kakkar|badshah|shreya\s*ghoshal|pritam|atif\s*aslam|jubin\s*nautiyal|sonu\s*nigam|alka\s*yagnik|kumar\s*sanu|udit\s*narayan|t-series|zeemusiccompany|yrf)\b/i;
const TAMIL_ARTISTS_AND_TERMS = /\b(tamil|kollywood|anirudh|ar\s*rahman|yuvan|sid\s*sriram|harris\s*jayaraj|ilayaraja|dhanush|santhosh\s*narayanan|sony\s*music\s*south)\b/i;
const PUNJABI_ARTISTS_AND_TERMS = /\b(punjabi|bhangra|diljit|sidhu\s*moose\s*wala|karan\s*aujla|ap\s*dhillon|shubh|amrit\s*maan)\b/i;
const KPOP_ARTISTS_AND_TERMS = /\b(kpop|k-pop|bts|blackpink|stray\s*kids|twice|newjeans|exo|seventeen|txt|itzy|aespa)\b/i;
const JPOP_ARTISTS_AND_TERMS = /\b(jpop|j-pop|anime|vocaloid|yoasobi|ado|lisa|kenshi\s*yonezu|radwimps|aimer)\b/i;
const LATIN_ARTISTS_AND_TERMS = /\b(reggaeton|bachata|salsa|cumbia|musica latina|bad\s*bunny|j\s*balvin|daddy\s*yankee|ozuna|maluma|karol\s*g|anuel|pesopluma)\b/i;

function detectMusicContext(track = {}) {
    const title = (track.info?.title || '').toLowerCase();
    const author = (track.info?.author || '').toLowerCase();
    const raw = `${title} ${author}`;

    let scene = null;
    if (/[\u0D80-\u0DFF]/.test(raw) || SINHALA_ARTISTS_AND_TERMS.test(raw)) {
        scene = 'sinhala';
    } else if (/[\u0900-\u097F]/.test(raw) || HINDI_ARTISTS_AND_TERMS.test(raw)) {
        scene = 'hindi';
    } else if (/[\u0B80-\u0BFF]/.test(raw) || TAMIL_ARTISTS_AND_TERMS.test(raw)) {
        scene = 'tamil';
    } else if (/[\u0A00-\u0A7F]/.test(raw) || PUNJABI_ARTISTS_AND_TERMS.test(raw)) {
        scene = 'punjabi';
    } else if (/[\uAC00-\uD7AF]/.test(raw) || KPOP_ARTISTS_AND_TERMS.test(raw)) {
        scene = 'k-pop';
    } else if (/[\u3040-\u30FF]/.test(raw) || JPOP_ARTISTS_AND_TERMS.test(raw)) {
        scene = 'j-pop';
    } else if (LATIN_ARTISTS_AND_TERMS.test(raw)) {
        scene = 'latin';
    }

    const genres = [
        'lofi', 'lo-fi', 'chillhop', 'synthwave', 'phonk',
        'hip hop', 'hip-hop', 'rap', 'trap', 'drill',
        'pop', 'rock', 'metal', 'punk', 'indie', 'alternative', 'grunge',
        'edm', 'house', 'techno', 'trance', 'dubstep', 'dnb', 'drum and bass', 'electronic',
        'acoustic', 'unplugged', 'piano', 'guitar',
        'r&b', 'soul', 'jazz', 'blues', 'reggae', 'classical', 'baila', 'calypso'
    ];
    let detectedGenre = null;
    for (const g of genres) {
        if (raw.includes(g)) {
            detectedGenre = g;
            break;
        }
    }

    const moods = ['chill', 'relax', 'party', 'workout', 'sleep', 'study', 'sad', 'happy', 'gym', 'vibe', 'slowed', 'reverb'];
    let detectedMood = null;
    for (const m of moods) {
        if (raw.includes(m)) {
            detectedMood = m;
            break;
        }
    }

    return { scene, genre: detectedGenre, mood: detectedMood };
}

module.exports = {
    normalizeString,
    cleanAuthor,
    cleanTitle,
    cleanArtist,
    splitArtistFromTitle,
    normalizeArtist,
    isGenericArtist,
    extractCollaborators,
    detectMusicContext,
};
