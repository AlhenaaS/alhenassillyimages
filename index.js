/**
 * Inline Image Generation Extension for SillyTavern
 *
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible, Gemini-compatible (nano-banana), and Naistera endpoints.
 *
 * v2.3 — Smart references, generation queue, timeouts, caching, lightbox,
 *         generation modes (auto / confirm / manual), editable prompts,
 *         src-parse fix for spaces, structured prompt conversion.
 */

const MODULE_NAME = 'inline_image_gen';

const processingMessages = new Set();
const checkedMessages = new Set();
let initialLoadComplete = false;
const imageCache = new Map();

const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    logBuffer.push(`[${timestamp}] [${level}] ${message}`);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    if (level === 'ERROR') console.error('[IIG]', ...args);
    else if (level === 'WARN') console.warn('[IIG]', ...args);
    else console.log('[IIG]', ...args);
}

function exportLogs() {
    const blob = new Blob([logBuffer.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// ─── Default settings ────────────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    generationMode: 'auto',
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    generationTimeout: 120000,
    concurrency: 1,
    enableCache: true,
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    referenceMode: 'tag_controls',
    naisteraAspectRatio: '1:1',
    naisteraPreset: '',
    naisteraSendCharAvatar: false,
    naisteraSendUserAvatar: false,
    naisteraReferenceMode: 'tag_controls',
    useStructuredPrompt: true,
});

// ─── Model detection ─────────────────────────────────────────────────────────

const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];
const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isImageModel(id) {
    const m = id.toLowerCase();
    for (const k of VIDEO_MODEL_KEYWORDS) if (m.includes(k)) return false;
    if (m.includes('vision') && m.includes('preview')) return false;
    for (const k of IMAGE_MODEL_KEYWORDS) if (m.includes(k)) return true;
    return false;
}

function isGeminiModel(id) { return id.toLowerCase().includes('nano-banana'); }

function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) ctx.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(ctx.extensionSettings[MODULE_NAME], k)) ctx.extensionSettings[MODULE_NAME][k] = defaultSettings[k];
    }
    return ctx.extensionSettings[MODULE_NAME];
}

function saveSettings() { SillyTavern.getContext().saveSettingsDebounced(); }
function getCharacterName() { const c = SillyTavern.getContext(); return c.characters?.[c.characterId]?.name || 'Character'; }
function getUserName() { return SillyTavern.getContext().name1 || 'User'; }
function getCacheKey(p, s, ar, is) { return `${s || ''}||${ar || ''}||${is || ''}||${p}`; }

function sanitizePrompt(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').replace(/on\w+\s*=/gi, '').trim();
}

function sanitizeForHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

// ─── Structured Prompt Converter ─────────────────────────────────────────────

/**
 * Converts a free-form text prompt into a structured JSON prompt.
 * Parses the text using NLP heuristics to extract camera, subject, environment,
 * lighting, and other structured fields.
 *
 * @param {string} textPrompt - The free-form text prompt (150-250 words)
 * @param {string} style - The style string from the tag
 * @param {object} tagInfo - Additional tag info (aspect_ratio, etc.)
 * @returns {string} - JSON string of the structured prompt
 */
function convertPromptToStructured(textPrompt, style = '', tagInfo = {}) {
    if (!textPrompt) return textPrompt;

    const text = textPrompt.trim();
    const textLower = text.toLowerCase();

    // ─── Parse Camera / Framing ───
    const cameraAngle = extractCameraAngle(textLower);
    const shotType = extractShotType(textLower);
    const dof = extractDepthOfField(textLower);
    const focalLength = extractFocalLength(textLower);
    const composition = extractComposition(textLower);

    // ─── Parse Subject ───
    const gender = extractGender(textLower);
    const age = extractAge(textLower);
    const skinTone = extractSkinTone(textLower);
    const bodyType = extractBodyType(textLower);
    const clothing = extractClothing(text);
    const accessories = extractAccessories(text);
    const hairDesc = extractHair(text);
    const faceDesc = extractFace(text);
    const expression = extractExpression(textLower);

    // ─── Parse Pose ───
    const pose = extractPose(text);

    // ─── Parse Environment ───
    const location = extractLocation(text);
    const envObjects = extractEnvironmentObjects(text);
    const weather = extractWeather(textLower);
    const timeOfDay = extractTimeOfDay(textLower);

    // ─── Parse Lighting & Atmosphere ───
    const lighting = extractLighting(text);
    const colorPalette = extractColorPalette(text);
    const atmosphere = extractAtmosphere(textLower);

    // ─── Parse Visual Style ───
    const realism = extractRealism(style, textLower);
    const cinematic = extractCinematic(style, textLower);

    // ─── Build focus progression ───
    const focusProgression = buildFocusProgression(text, shotType);

    // ─── Build visual emphasis ───
    const visualEmphasis = buildVisualEmphasis(text, style);

    // ─── Construct structured object ───
    const structured = {
        style: {
            realism: realism,
            cinematic: cinematic,
            camera_angle: cameraAngle || shotType || 'eye level medium shot',
            aspect_ratio: tagInfo.aspectRatio || '1:1',
            depth_of_field: dof || 'moderate',
            ...(focalLength ? { focal_length: focalLength } : {}),
            ...(style ? { visual_reference: style } : {}),
        },
        subject: {
            gender: gender || 'unspecified',
            appearance: {
                skin_tone: skinTone || extractFromText(text, /skin[^,.]*(?:tone|color|complexion)[^,.]*[,.]?/i) || 'natural',
                body_type: bodyType || 'average build',
                age: age || 'adult',
                ...(hairDesc ? { hair: hairDesc } : {}),
                ...(faceDesc ? { face: faceDesc } : {}),
                ...(expression ? { expression: expression } : {}),
            },
            clothing: clothing || extractLargeSegment(text, /(?:wear(?:ing|s)?|dressed in|clad in|outfit)[^.]*\./i) || 'casual clothing',
            ...(accessories.length ? { accessories: accessories } : {}),
        },
        pose: pose,
        framing: {
            composition: composition || 'centered subject',
            camera_position: `${shotType || 'medium shot'}, ${cameraAngle || 'eye level'}`,
            focus_progression: focusProgression,
        },
        environment: {
            location: location || 'unspecified interior',
            ...(envObjects.length ? { objects: envObjects } : {}),
            ...(weather ? { weather: weather } : {}),
            ...(timeOfDay ? { time_of_day: timeOfDay } : {}),
        },
        ...(visualEmphasis.length ? { visual_emphasis: visualEmphasis } : {}),
        ...(lighting ? { lighting: lighting } : {}),
        ...(colorPalette ? { color_palette: colorPalette } : {}),
        ...(atmosphere ? { atmosphere: atmosphere } : {}),
    };

    // Clean up undefined/null values recursively
    const cleaned = cleanObject(structured);

    iigLog('INFO', 'Structured prompt:', JSON.stringify(cleaned).substring(0, 500));
    return JSON.stringify(cleaned);
}

// ─── Extraction helpers ──────────────────────────────────────────────────────

function extractCameraAngle(text) {
    const angles = {
        'bird.?s?.?eye': "bird's eye view",
        'top.?down': 'top-down',
        'overhead': 'overhead',
        'high angle': 'high angle',
        'low angle': 'low angle',
        'worm.?s?.?eye': "worm's eye view",
        'dutch angle': 'dutch angle',
        'tilted': 'tilted angle',
        'eye level': 'eye level',
        'straight.?on': 'straight on',
        'three.?quarter': 'three-quarter angle',
        '3\\/4': 'three-quarter angle',
        'profile': 'profile view',
        'side view': 'side view',
        'from behind': 'from behind',
        'over.?the.?shoulder': 'over-the-shoulder',
        'pov': 'POV first-person',
        'first.?person': 'POV first-person',
        'aerial': 'aerial view',
        'isometric': 'isometric view',
    };
    for (const [pattern, value] of Object.entries(angles)) {
        if (new RegExp(pattern, 'i').test(text)) return value;
    }
    return null;
}

function extractShotType(text) {
    const shots = {
        'extreme close.?up': 'extreme close-up',
        'close.?up': 'close-up',
        'medium close.?up': 'medium close-up',
        'bust shot': 'bust shot',
        'medium shot': 'medium shot',
        'cowboy shot': 'cowboy shot',
        'american shot': 'american shot',
        'full.?body': 'full body shot',
        'full shot': 'full shot',
        'wide shot': 'wide shot',
        'long shot': 'long shot',
        'extreme long shot': 'extreme long shot',
        'establishing shot': 'establishing shot',
        'portrait': 'portrait',
        'headshot': 'headshot',
        'half.?body': 'half-body shot',
        'knee.?up': 'knee-up shot',
        'waist.?up': 'waist-up shot',
        'telephoto': 'telephoto compression',
    };
    for (const [pattern, value] of Object.entries(shots)) {
        if (new RegExp(pattern, 'i').test(text)) return value;
    }
    return null;
}

function extractDepthOfField(text) {
    if (/shallow\s*(?:depth|dof|d\.o\.f)/i.test(text)) return 'shallow';
    if (/deep\s*(?:depth|dof|d\.o\.f|focus)/i.test(text)) return 'deep';
    if (/bokeh/i.test(text)) return 'shallow with bokeh';
    if (/everything\s*in\s*focus/i.test(text)) return 'deep, everything in focus';
    if (/blurr(?:ed|y)\s*background/i.test(text)) return 'shallow, blurred background';
    if (/sharp\s*(?:throughout|across)/i.test(text)) return 'deep, sharp throughout';
    if (/tilt.?shift/i.test(text)) return 'tilt-shift miniature effect';
    return null;
}

function extractFocalLength(text) {
    const m = text.match(/(\d+)\s*mm/i);
    if (m) return `${m[1]}mm`;
    if (/wide.?angle/i.test(text)) return 'wide-angle (~24mm)';
    if (/telephoto/i.test(text)) return 'telephoto (~200mm)';
    if (/macro/i.test(text)) return 'macro lens';
    if (/fisheye/i.test(text)) return 'fisheye (~8mm)';
    return null;
}

function extractComposition(text) {
    const comps = [];
    if (/rule\s*of\s*thirds/i.test(text)) comps.push('rule of thirds');
    if (/center(?:ed)?(?:\s*(?:frame|composition|subject))?/i.test(text)) comps.push('centered');
    if (/(?:left|right).?third/i.test(text)) comps.push(text.match(/(left|right).?third/i)[0]);
    if (/symmetr/i.test(text)) comps.push('symmetrical');
    if (/asymmetr/i.test(text)) comps.push('asymmetrical');
    if (/golden\s*ratio/i.test(text)) comps.push('golden ratio');
    if (/leading\s*lines/i.test(text)) comps.push('leading lines');
    if (/negative\s*space/i.test(text)) comps.push('negative space');
    if (/frame\s*within/i.test(text)) comps.push('frame within frame');
    if (/diagonal/i.test(text)) comps.push('diagonal composition');
    return comps.length ? comps.join(', ') : null;
}

function extractGender(text) {
    if (/\b(?:woman|female|girl|lady|she|her\b|mother|sister|daughter|wife|girlfriend|queen|princess|actress|waitress|businesswoman|heroine)\b/i.test(text)) return 'female';
    if (/\b(?:man|male|boy|guy|he\b|his\b|father|brother|son|husband|boyfriend|king|prince|actor|waiter|businessman|hero)\b/i.test(text)) return 'male';
    if (/\b(?:non.?binary|androgynous|they\/them|genderqueer|agender)\b/i.test(text)) return 'non-binary';
    return null;
}

function extractAge(text) {
    const m = text.match(/\b(\d{1,3})\s*(?:year|yr)s?\s*old\b/i);
    if (m) return `${m[1]} years old`;
    if (/\b(?:child|kid|little)\b/i.test(text)) return 'child';
    if (/\b(?:teen(?:age)?|adolescent)\b/i.test(text)) return 'teenager';
    if (/\byoung\s*(?:adult|woman|man)\b/i.test(text)) return 'young adult';
    if (/\bmiddle.?aged?\b/i.test(text)) return 'middle-aged';
    if (/\b(?:elder|old|aged|senior|elderly)\b/i.test(text)) return 'elderly';
    if (/\b(?:twenties|20s)\b/i.test(text)) return 'in their 20s';
    if (/\b(?:thirties|30s)\b/i.test(text)) return 'in their 30s';
    if (/\b(?:forties|40s)\b/i.test(text)) return 'in their 40s';
    return null;
}

function extractSkinTone(text) {
    const tones = [
        'pale', 'fair', 'light', 'ivory', 'porcelain', 'alabaster',
        'olive', 'tan', 'tanned', 'bronze', 'bronzed', 'golden',
        'brown', 'dark', 'deep', 'ebony', 'mahogany', 'caramel',
        'warm', 'cool', 'neutral', 'rosy', 'sun-kissed', 'freckled',
        'weathered', 'ruddy'
    ];
    for (const tone of tones) {
        const re = new RegExp(`\\b${tone}\\s*(?:skin(?:ned)?|complex(?:ion|ted)|tone)\\b`, 'i');
        if (re.test(text)) return `${tone} skin`;
    }
    // Also check for "X-skinned" pattern
    const m = text.match(/(\w+)[- ]skinned/i);
    if (m) return `${m[1]} skin`;
    return null;
}

function extractBodyType(text) {
    const types = {
        'athletic': 'athletic', 'muscular': 'muscular', 'toned': 'toned',
        'slim': 'slim', 'slender': 'slender', 'thin': 'thin', 'lean': 'lean', 'lithe': 'lithe',
        'petite': 'petite', 'curvy': 'curvy', 'voluptuous': 'voluptuous', 'plump': 'plump',
        'heavyset': 'heavyset', 'stocky': 'stocky', 'burly': 'burly', 'broad': 'broad-shouldered',
        'tall': 'tall', 'short': 'short', 'average': 'average build',
        'wiry': 'wiry', 'lanky': 'lanky', 'compact': 'compact build',
    };
    for (const [pattern, value] of Object.entries(types)) {
        if (new RegExp(`\\b${pattern}\\b`, 'i').test(text)) return value;
    }
    return null;
}

function extractClothing(text) {
    // Try to find clothing descriptions
    const patterns = [
        /(?:wear(?:ing|s)?|dressed\s+in|clad\s+in)\s+([^.]{10,120})\./i,
        /(?:outfit|attire|costume|uniform|dress|suit|jacket|coat|shirt|blouse|skirt|pants|jeans|shorts|top)\s*(?:of|with|in)?\s*[^.]{5,80}\./i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1] ? m[1].trim() : m[0].trim().replace(/\.$/, '');
    }

    // Fallback: look for individual clothing items
    const items = [];
    const clothingWords = [
        'dress', 'gown', 'suit', 'tuxedo', 'jacket', 'blazer', 'coat', 'overcoat',
        'shirt', 'blouse', 'top', 't-shirt', 'sweater', 'hoodie', 'cardigan',
        'pants', 'trousers', 'jeans', 'shorts', 'skirt', 'leggings',
        'boots', 'shoes', 'heels', 'sneakers', 'sandals',
        'scarf', 'tie', 'hat', 'cap', 'gloves', 'vest', 'apron',
        'uniform', 'armor', 'armour', 'robe', 'kimono', 'yukata',
    ];
    for (const item of clothingWords) {
        const re = new RegExp(`(?:\\w+\\s+){0,3}${item}(?:\\s+\\w+){0,2}`, 'i');
        const m = text.match(re);
        if (m) items.push(m[0].trim());
    }
    return items.length ? items.join(', ') : null;
}

function extractAccessories(text) {
    const accessories = [];
    const accPatterns = [
        { re: /(?:necklace|pendant|chain|choker)\s*[^,.]{0,50}/i, type: 'necklace' },
        { re: /(?:earring|ear\s*ring|stud)s?\s*[^,.]{0,40}/i, type: 'earrings' },
        { re: /(?:bracelet|bangle|wristband|cuff)\s*[^,.]{0,40}/i, type: 'bracelet' },
        { re: /(?:ring(?:\s+on)?)\s*[^,.]{0,40}/i, type: 'ring' },
        { re: /(?:watch|wristwatch)\s*[^,.]{0,40}/i, type: 'watch' },
        { re: /(?:glasses|spectacles|sunglasses|shades)\s*[^,.]{0,40}/i, type: 'eyewear' },
        { re: /(?:hat|cap|beanie|beret|hood|crown|tiara|headband)\s*[^,.]{0,40}/i, type: 'headwear' },
        { re: /(?:tattoo)s?\s*[^,.]{0,50}/i, type: 'tattoo' },
        { re: /(?:piercing)s?\s*[^,.]{0,40}/i, type: 'piercing' },
        { re: /(?:bag|purse|backpack|satchel|handbag)\s*[^,.]{0,40}/i, type: 'bag' },
        { re: /(?:belt)\s*[^,.]{0,30}/i, type: 'belt' },
        { re: /(?:weapon|sword|gun|pistol|rifle|knife|dagger|blade)\s*[^,.]{0,40}/i, type: 'weapon' },
    ];
    for (const { re, type } of accPatterns) {
        const m = text.match(re);
        if (m) {
            accessories.push({
                type: type,
                description: m[0].trim(),
            });
        }
    }
    return accessories;
}

function extractHair(text) {
    const hairPatterns = [
        /(?:hair)\s*[^.]{5,80}\./i,
        /(?:\w+\s+){0,3}(?:hair|locks|tresses|curls|braids?|ponytail|bun|bangs|fringe)(?:\s+\w+){0,5}/i,
    ];
    for (const p of hairPatterns) {
        const m = text.match(p);
        if (m) return m[0].trim().replace(/\.$/, '');
    }
    return null;
}

function extractFace(text) {
    const facePatterns = [
        /(?:face|facial)\s+[^.]{5,60}\./i,
        /(?:eyes?|nose|lips?|mouth|jaw|chin|cheek|brow|forehead)\s+[^.]{3,50}/i,
    ];
    const parts = [];
    for (const p of facePatterns) {
        const m = text.match(p);
        if (m) parts.push(m[0].trim().replace(/\.$/, ''));
    }
    return parts.length ? parts.join('; ') : null;
}

function extractExpression(text) {
    const expressions = {
        'smil(?:e|ing)': 'smiling', 'grin(?:ning)?': 'grinning', 'laugh(?:ing)?': 'laughing',
        'frown(?:ing)?': 'frowning', 'scowl(?:ing)?': 'scowling', 'glare|glaring': 'glaring',
        'neutral': 'neutral', 'serious': 'serious', 'stern': 'stern',
        'sad|sorrow': 'sad', 'crying|tears': 'crying', 'weeping': 'weeping',
        'angry|furious': 'angry', 'rage|raging': 'enraged',
        'surprised|shocked': 'surprised', 'confused|puzzled': 'confused',
        'smirk(?:ing)?': 'smirking', 'pensive|thoughtful': 'pensive',
        'dreamy|wistful': 'dreamy', 'determined': 'determined',
        'fearful|afraid|scared': 'fearful', 'disgusted': 'disgusted',
        'bored|uninterested': 'bored', 'amused': 'amused',
        'contempt': 'contemptuous', 'nostalgic': 'nostalgic',
        'tired|exhausted|weary': 'tired', 'relaxed|calm|serene': 'relaxed',
    };
    for (const [pattern, value] of Object.entries(expressions)) {
        if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text)) return value;
    }
    return null;
}

function extractPose(text) {
    const pose = {
        overall_posture: 'standing naturally',
    };

    // Overall posture
    const postures = {
        'standing': 'standing', 'sitting': 'sitting', 'seated': 'seated',
        'kneeling': 'kneeling', 'crouching': 'crouching', 'squatting': 'squatting',
        'lying|laying': 'lying down', 'reclining': 'reclining', 'leaning': 'leaning',
        'walking': 'walking', 'running': 'running', 'jumping': 'jumping',
        'dancing': 'dancing', 'fighting': 'in fighting stance',
        'hunched|slouch': 'hunched/slouching', 'upright|straight': 'upright',
        'crossed.?(?:arms|legs)': 'arms/legs crossed',
        'hands?.?(?:on|in).?(?:hip|pocket)': 'hands on hips/in pockets',
    };
    for (const [pattern, value] of Object.entries(postures)) {
        if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text.toLowerCase())) {
            pose.overall_posture = value;
            break;
        }
    }

    // Arm/hand positions
    const armPatterns = [
        /(?:left|right)\s*(?:hand|arm)\s+[^,.]{3,50}/gi,
        /(?:hands?|arms?)\s+(?:raised|extended|folded|crossed|behind|above|resting|gripping|holding)[^,.]{0,40}/gi,
    ];
    for (const p of armPatterns) {
        const matches = text.match(p);
        if (matches) {
            for (const m of matches) {
                const lower = m.toLowerCase();
                if (lower.includes('left')) {
                    pose.left_arm = { position: m.trim(), interaction: extractInteraction(m) };
                } else if (lower.includes('right')) {
                    pose.right_arm = { position: m.trim(), interaction: extractInteraction(m) };
                } else {
                    if (!pose.arms) pose.arms = { position: m.trim(), interaction: extractInteraction(m) };
                }
            }
        }
    }

    // Gaze direction
    const gazeMatch = text.match(/(?:gaze|gazing|looking|staring|glancing)\s+(?:at|toward|into|away|down|up|off|directly)[^,.]{0,40}/i);
    if (gazeMatch) pose.gaze = gazeMatch[0].trim();

    return pose;
}

function extractInteraction(text) {
    const interactions = [
        'holding', 'gripping', 'touching', 'resting on', 'leaning against',
        'reaching for', 'pointing at', 'pressing against', 'wrapped around',
    ];
    for (const i of interactions) {
        if (text.toLowerCase().includes(i)) return i;
    }
    return 'natural position';
}

function extractLocation(text) {
    // Try to find location descriptions
    const locPatterns = [
        /(?:in\s+(?:a|an|the)\s+)([^,.]{5,80}(?:room|kitchen|bedroom|office|hallway|corridor|street|alley|garden|park|forest|beach|rooftop|balcony|bar|cafe|restaurant|church|temple|castle|palace|warehouse|factory|lab(?:oratory)?|hospital|school|library|museum|station|airport|market|bazaar|square|plaza|courtyard|apartment|flat|house|mansion|cabin|cottage|tent|bunker|basement|attic))/i,
        /(?:background|setting|scene|location|environment)(?:\s*:?\s*|\s+(?:is|shows|features)\s+)([^.]{10,100})/i,
    ];
    for (const p of locPatterns) {
        const m = text.match(p);
        if (m) return m[1].trim();
    }

    // Fallback: look for environment keywords
    const envKeywords = [
        'interior', 'exterior', 'indoor', 'outdoor', 'urban', 'rural',
        'city', 'countryside', 'forest', 'ocean', 'mountain', 'desert',
        'snow', 'rain', 'night', 'rooftop', 'underground', 'underwater',
    ];
    for (const kw of envKeywords) {
        if (text.toLowerCase().includes(kw)) return kw;
    }
    return null;
}

function extractEnvironmentObjects(text) {
    const objects = [];
    const objPatterns = [
        /(?:foreground|background|mid.?ground)\s*[^,.]{5,60}/gi,
        /(?:table|chair|desk|sofa|couch|bed|shelf|bookshelf|window|door|wall|floor|ceiling|mirror|lamp|candle|screen|monitor|phone|book|cup|mug|bottle|glass|plate|weapon|car|vehicle|tree|plant|flower|statue|painting|poster|sign|clock|fireplace)\s*[^,.]{0,40}/gi,
    ];
    const seen = new Set();
    for (const p of objPatterns) {
        const matches = text.match(p);
        if (matches) {
            for (const m of matches) {
                const trimmed = m.trim().substring(0, 80);
                if (!seen.has(trimmed.toLowerCase())) {
                    seen.add(trimmed.toLowerCase());
                    objects.push(trimmed);
                }
            }
        }
    }
    return objects.slice(0, 8);
}

function extractWeather(text) {
    const weather = {
        'rain(?:ing|y)?': 'rainy', 'storm(?:y)?|thunder': 'stormy',
        'snow(?:ing|y)?': 'snowy', 'fog(?:gy)?|mist(?:y)?': 'foggy/misty',
        'sunny|bright sun': 'sunny', 'cloud(?:y|s)': 'cloudy', 'overcast': 'overcast',
        'wind(?:y)?|breez(?:e|y)': 'windy', 'hail': 'hail',
        'clear sky': 'clear', 'humid': 'humid', 'dry': 'dry',
    };
    for (const [pattern, value] of Object.entries(weather)) {
        if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text)) return value;
    }
    return null;
}

function extractTimeOfDay(text) {
    const times = {
        'dawn|sunrise|early morning': 'dawn', 'morning': 'morning',
        'noon|midday': 'noon', 'afternoon': 'afternoon',
        'dusk|sunset|golden hour': 'golden hour/sunset',
        'twilight|blue hour': 'twilight', 'evening': 'evening',
        'night|midnight|late night': 'night',
    };
    for (const [pattern, value] of Object.entries(times)) {
        if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text)) return value;
    }
    return null;
}

function extractLighting(text) {
    const lightParts = [];
    const lightPatterns = {
        'natural light': 'natural light', 'artificial light': 'artificial light',
        'neon': 'neon lighting', 'fluorescent': 'fluorescent lighting',
        'candlelight|candle.?lit': 'candlelight', 'firelight|fire.?lit': 'firelight',
        'backli[gt]': 'backlighting', 'rim light': 'rim lighting',
        'side.?li[gt]': 'side lighting', 'top.?li[gt]': 'top lighting',
        'under.?li[gt]': 'under lighting',
        'harsh': 'harsh lighting', 'soft': 'soft lighting', 'diffused': 'diffused lighting',
        'dramatic': 'dramatic lighting', 'volumetric': 'volumetric lighting',
        'chiaroscuro': 'chiaroscuro', 'rembrandt': 'Rembrandt lighting',
        'spotlight': 'spotlight', 'ambient': 'ambient lighting',
        'warm light': 'warm light', 'cool light': 'cool light', 'cold light': 'cold light',
        'golden light': 'golden light', 'blue light': 'blue light',
        'shadow': 'prominent shadows', 'silhouette': 'silhouette',
        'lens flare': 'lens flare', 'god.?rays?|light.?rays?': 'god rays',
    };
    for (const [pattern, value] of Object.entries(lightPatterns)) {
        if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text.toLowerCase())) lightParts.push(value);
    }
    return lightParts.length ? lightParts.join(', ') : null;
}

function extractColorPalette(text) {
    const colorParts = [];
    const colorPatterns = {
        'desaturat': 'desaturated', 'saturat': 'saturated', 'muted': 'muted colors',
        'vibrant': 'vibrant colors', 'pastel': 'pastel tones', 'monochrome|monochromatic': 'monochrome',
        'sepia': 'sepia tones', 'black.?and.?white|b&w|grayscale': 'black and white',
        'warm\s*(?:tones?|colors?|palette)': 'warm palette', 'cool\s*(?:tones?|colors?|palette)': 'cool palette',
        'earth\s*(?:y\s*)?tones?': 'earthy tones', 'neon\s*colors?': 'neon colors',
        'high.?contrast': 'high contrast', 'low.?contrast': 'low contrast',
        'teal\s*(?:and|&)\s*orange': 'teal and orange grading',
        'cross.?process': 'cross-processed', 'bleach.?bypass': 'bleach bypass',
    };
    for (const [pattern, value] of Object.entries(colorPatterns)) {
        if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text.toLowerCase())) colorParts.push(value);
    }
    return colorParts.length ? colorParts.join(', ') : null;
}

function extractAtmosphere(text) {
    const atmospheres = [];
    const atmoPatterns = {
        'moody|somber|melanchol': 'moody/melancholic', 'eerie|creepy|sinister': 'eerie',
        'cozy|warm|intimate': 'cozy/intimate', 'tense|suspense|ominous': 'tense/suspenseful',
        'serene|peaceful|tranquil': 'serene', 'chaotic|frantic|frenzied': 'chaotic',
        'nostalgic|wistful': 'nostalgic', 'romantic': 'romantic',
        'mysterious|enigmatic': 'mysterious', 'gritty|raw': 'gritty/raw',
        'ethereal|dreamy|otherworldly': 'ethereal/dreamy', 'oppressive|suffocating': 'oppressive',
        'playful|whimsical': 'playful', 'solemn|grave': 'solemn',
        'desolate|abandoned|forsaken': 'desolate', 'lively|vibrant|energetic': 'lively/vibrant',
        'sterile|clinical': 'sterile/clinical', 'dusty|hazy|smoky': 'dusty/hazy',
    };
    for (const [pattern, value] of Object.entries(atmoPatterns)) {
        if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text)) atmospheres.push(value);
    }
    return atmospheres.length ? atmospheres.join(', ') : null;
}

function extractRealism(style, text) {
    if (/photorealis/i.test(style + ' ' + text)) return 'photorealistic';
    if (/hyperrealis/i.test(style + ' ' + text)) return 'hyperrealistic';
    if (/cartoon|anime|manga/i.test(style + ' ' + text)) return 'stylized/anime';
    if (/oil\s*paint|watercolor|illustration|drawn|sketch/i.test(style + ' ' + text)) return 'artistic/painted';
    if (/3d\s*render|cgi|unreal/i.test(style + ' ' + text)) return '3D rendered';
    if (/pixel\s*art/i.test(style + ' ' + text)) return 'pixel art';
    if (/comic/i.test(style + ' ' + text)) return 'comic style';
    if (/realis/i.test(style + ' ' + text)) return 'realistic';
    // Default based on style keywords
    if (/film|camera|lens|photo|35mm|fujifilm|kodak|polaroid|disposable|CCTV|surveillance/i.test(style)) return 'photographic';
    return 'balanced';
}

function extractCinematic(style, text) {
    if (/cinematic|film|movie|a24|blockbuster|anamorphic/i.test(style + ' ' + text)) return true;
    return false;
}

function buildFocusProgression(text, shotType) {
    const progression = [];
    const textLower = text.toLowerCase();

    // Start with overall composition
    if (shotType) progression.push(`${shotType} framing`);
    else progression.push('overall scene');

    // Subject focus
    if (/face|portrait|headshot|close.?up/i.test(textLower)) progression.push('facial features and expression');
    else if (/full.?body|wide/i.test(textLower)) progression.push('full figure and posture');
    else progression.push('subject center of interest');

    // Detail focus
    const details = [];
    if (/eye/i.test(textLower)) details.push('eyes');
    if (/hand/i.test(textLower)) details.push('hands');
    if (/hair/i.test(textLower)) details.push('hair');
    if (/cloth|fabric|outfit|dress/i.test(textLower)) details.push('clothing texture');
    if (/skin|pore|freckle|scar/i.test(textLower)) details.push('skin detail');
    if (/accessory|jewelry|watch|ring/i.test(textLower)) details.push('accessories');
    if (details.length) progression.push(details.join(', '));
    else progression.push('defining details');

    // Environment/background
    if (/background|environment|setting|scene/i.test(textLower)) progression.push('background environment');
    else progression.push('surrounding context');

    return progression.slice(0, 5);
}

function buildVisualEmphasis(text, style) {
    const emphasis = [];
    const combined = (text + ' ' + style).toLowerCase();

    if (/texture|material|fabric|surface/i.test(combined)) emphasis.push('material textures');
    if (/contrast|shadow|highlight/i.test(combined)) emphasis.push('light-shadow contrast');
    if (/color|palette|tone|hue/i.test(combined)) emphasis.push('color relationships');
    if (/detail|intricate|fine/i.test(combined)) emphasis.push('fine details');
    if (/emotion|mood|feeling|atmosphere/i.test(combined)) emphasis.push('emotional resonance');
    if (/movement|motion|dynamic|action/i.test(combined)) emphasis.push('sense of movement');
    if (/grain|noise|artifact|distortion/i.test(combined)) emphasis.push('textural imperfections');
    if (/reflection|mirror|glass|water/i.test(combined)) emphasis.push('reflections');
    if (/depth|dimension|space|layering/i.test(combined)) emphasis.push('spatial depth');

    if (!emphasis.length) {
        // Default emphasis based on context
        emphasis.push('subject presence');
        emphasis.push('atmospheric consistency');
    }

    return emphasis.slice(0, 4);
}

function extractFromText(text, regex) {
    const m = text.match(regex);
    return m ? m[0].trim() : null;
}

function extractLargeSegment(text, regex) {
    const m = text.match(regex);
    return m ? m[0].trim().replace(/\.$/, '') : null;
}

function cleanObject(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        const cleaned = obj.map(cleanObject).filter(v => v !== undefined && v !== null && v !== '');
        return cleaned.length ? cleaned : undefined;
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        const cleaned = cleanObject(value);
        if (cleaned !== undefined && cleaned !== null && cleaned !== '') {
            result[key] = cleaned;
        }
    }
    return Object.keys(result).length ? result : undefined;
}

// ─── Fetch with timeout ──────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: c.signal }); }
    catch (e) { if (e.name === 'AbortError') throw new Error(`Таймаут (${timeoutMs / 1000}с)`); throw e; }
    finally { clearTimeout(t); }
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchModels() {
    const s = getSettings();
    if (!s.endpoint || !s.apiKey) return [];
    try {
        const r = await fetchWithTimeout(`${s.endpoint.replace(/\/$/, '')}/v1/models`, {
            method: 'GET', headers: { 'Authorization': `Bearer ${s.apiKey}` }
        }, 15000);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return ((await r.json()).data || []).filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (e) { toastr.error(`Ошибка: ${e.message}`, 'Генерация картинок'); return []; }
}

async function fetchUserAvatars() {
    try {
        const r = await fetch('/api/avatars/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders() });
        return r.ok ? await r.json() : [];
    } catch { return []; }
}

// ─── Image conversion ────────────────────────────────────────────────────────

async function imageUrlToBase64(url) {
    try {
        const blob = await (await fetch(url)).blob();
        return await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
    } catch { return null; }
}

async function imageUrlToDataUrl(url) {
    try {
        const blob = await (await fetch(url)).blob();
        return await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
    } catch { return null; }
}

// ─── Save image ──────────────────────────────────────────────────────────────

async function saveImageToFile(dataUrl) {
    const ctx = SillyTavern.getContext();
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    const [, format, base64Data] = match;
    let charName = ctx.characters?.[ctx.characterId]?.name || 'generated';
    const filename = `iig_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const r = await fetch('/api/images/upload', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename })
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Upload failed: ${r.status}`); }
    const result = await r.json();
    iigLog('INFO', 'Saved:', result.path);
    return result.path;
}

// ─── Avatar getters ──────────────────────────────────────────────────────────

async function getCharacterAvatarBase64() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId == null) return null;
        if (typeof ctx.getCharacterAvatar === 'function') { const u = ctx.getCharacterAvatar(ctx.characterId); if (u) return await imageUrlToBase64(u); }
        const ch = ctx.characters?.[ctx.characterId]; if (ch?.avatar) return await imageUrlToBase64(`/characters/${encodeURIComponent(ch.avatar)}`);
        return null;
    } catch { return null; }
}

async function getCharacterAvatarDataUrl() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId == null) return null;
        if (typeof ctx.getCharacterAvatar === 'function') { const u = ctx.getCharacterAvatar(ctx.characterId); if (u) return await imageUrlToDataUrl(u); }
        const ch = ctx.characters?.[ctx.characterId]; if (ch?.avatar) return await imageUrlToDataUrl(`/characters/${encodeURIComponent(ch.avatar)}`);
        return null;
    } catch { return null; }
}

async function getUserAvatarBase64() {
    try { const s = getSettings(); if (!s.userAvatarFile) return null; return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(s.userAvatarFile)}`); } catch { return null; }
}

async function getUserAvatarDataUrl() {
    try { const s = getSettings(); if (!s.userAvatarFile) return null; return await imageUrlToDataUrl(`/User Avatars/${encodeURIComponent(s.userAvatarFile)}`); } catch { return null; }
}

// ─── Smart references ────────────────────────────────────────────────────────

function buildReferenceInstruction(refs, tagInfo = {}) {
    if (!refs.length) return '';
    const parts = [];
    for (const r of refs) {
        if (r.role === 'char') parts.push(`One reference image shows "${getCharacterName()}". Use ONLY for this character's appearance IF they appear. Do NOT apply to others.`);
        else if (r.role === 'user') parts.push(`One reference image shows "${getUserName()}". Use ONLY for the user IF they appear. Do NOT apply to others.`);
    }
    if (tagInfo.reference_hint) parts.push(tagInfo.reference_hint);
    return `[Reference guidance: ${parts.join(' ')} IMPORTANT: Unrelated characters must have their OWN unique appearances.]`;
}

async function collectReferences(tag, mode = 'gemini') {
    const s = getSettings();
    const refs = [];
    const rm = mode === 'naistera' ? s.naisteraReferenceMode : s.referenceMode;
    if (rm === 'never') return refs;
    let sendC = false, sendU = false;
    if (rm === 'tag_controls') {
        const r = tag.references || [];
        if (!r.length) return refs;
        sendC = r.includes('char'); sendU = r.includes('user');
    } else { if (mode === 'naistera') { sendC = s.naisteraSendCharAvatar; sendU = s.naisteraSendUserAvatar; } else { sendC = s.sendCharAvatar; sendU = s.sendUserAvatar; } }
    if (mode === 'naistera') {
        if (sendC) { const d = await getCharacterAvatarDataUrl(); if (d) refs.push({ image: d, role: 'char' }); }
        if (sendU) { const d = await getUserAvatarDataUrl(); if (d) refs.push({ image: d, role: 'user' }); }
    } else {
        if (sendC) { const d = await getCharacterAvatarBase64(); if (d) refs.push({ image: d, role: 'char' }); }
        if (sendU) { const d = await getUserAvatarBase64(); if (d) refs.push({ image: d, role: 'user' }); }
    }
    iigLog('INFO', `Collected ${refs.length} ref(s), mode=${mode}, rm=${rm}`);
    return refs;
}

// ─── Generation functions ────────────────────────────────────────────────────

/**
 * Prepares the final prompt string, optionally converting to structured format.
 * @param {string} prompt - Raw text prompt
 * @param {string} style - Style string
 * @param {object} tagInfo - Tag info with aspectRatio, imageSize, etc.
 * @returns {string} - Final prompt (either text or JSON string)
 */
function prepareFinalPrompt(prompt, style, tagInfo = {}) {
    const s = getSettings();
    if (s.useStructuredPrompt) {
        return convertPromptToStructured(prompt, style, tagInfo);
    }
    return style ? `[Style: ${style}] ${prompt}` : prompt;
}

async function generateImageOpenAI(prompt, style, refs = [], options = {}) {
    const s = getSettings();
    const url = `${s.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    const fp = prepareFinalPrompt(prompt, style, options);
    let size = s.size;
    if (options.aspectRatio === '16:9') size = '1792x1024';
    else if (options.aspectRatio === '9:16') size = '1024x1792';
    else if (options.aspectRatio === '1:1') size = '1024x1024';
    const body = { model: s.model, prompt: fp, n: 1, size, quality: options.quality || s.quality, response_format: 'b64_json' };
    if (refs.length) { const img = refs[0]; body.image = `data:image/png;base64,${typeof img === 'string' ? img : img.image}`; }
    const r = await fetchWithTimeout(url, { method: 'POST', headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, s.generationTimeout);
    if (!r.ok) throw new Error(`API Error (${r.status}): ${await r.text()}`);
    const result = await r.json();
    const dl = result.data || [];
    if (!dl.length) { if (result.url) return result.url; throw new Error('No image data'); }
    return dl[0].b64_json ? `data:image/png;base64,${dl[0].b64_json}` : dl[0].url;
}

async function generateImageGemini(prompt, style, refs = [], options = {}) {
    const s = getSettings();
    const url = `${s.endpoint.replace(/\/$/, '')}/v1beta/models/${s.model}:generateContent`;
    let ar = options.aspectRatio || s.aspectRatio || '1:1'; if (!VALID_ASPECT_RATIOS.includes(ar)) ar = '1:1';
    let is = options.imageSize || s.imageSize || '1K'; if (!VALID_IMAGE_SIZES.includes(is)) is = '1K';
    const parts = [];
    for (const ref of refs.slice(0, 4)) parts.push({ inlineData: { mimeType: 'image/png', data: typeof ref === 'string' ? ref : ref.image } });
    let fp = prepareFinalPrompt(prompt, style, { ...options, tagInfo: options.tagInfo });
    if (refs.length) fp = `${buildReferenceInstruction(refs, options.tagInfo || {})}\n\n${fp}`;
    parts.push({ text: fp });
    const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ar, imageSize: is } } };
    const r = await fetchWithTimeout(url, { method: 'POST', headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, s.generationTimeout);
    if (!r.ok) throw new Error(`API Error (${r.status}): ${await r.text()}`);
    const result = await r.json();
    const cands = result.candidates || []; if (!cands.length) throw new Error('No candidates');
    for (const p of (cands[0].content?.parts || [])) {
        if (p.inlineData) return `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`;
        if (p.inline_data) return `data:${p.inline_data.mime_type};base64,${p.inline_data.data}`;
    }
    throw new Error('No image in response');
}

async function generateImageNaistera(prompt, style, refs = [], options = {}) {
    const s = getSettings();
    const ep = s.endpoint.replace(/\/$/, '');
    const url = ep.endsWith('/api/generate') ? ep : `${ep}/api/generate`;
    const fp = prepareFinalPrompt(prompt, style, options);
    const body = { prompt: fp, aspect_ratio: options.aspectRatio || s.naisteraAspectRatio || '1:1' };
    const preset = options.preset || s.naisteraPreset; if (preset) body.preset = preset;
    if (refs.length) body.reference_images = refs.slice(0, 4).map(r => typeof r === 'string' ? r : r.image);
    const r = await fetchWithTimeout(url, { method: 'POST', headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, s.generationTimeout);
    if (!r.ok) throw new Error(`API Error (${r.status}): ${await r.text()}`);
    const result = await r.json(); if (!result?.data_url) throw new Error('No data_url'); return result.data_url;
}

function validateSettings() {
    const s = getSettings(); const e = [];
    if (!s.endpoint) e.push('URL не настроен');
    if (!s.apiKey) e.push('API ключ не настроен');
    if (s.apiType !== 'naistera' && !s.model) e.push('Модель не выбрана');
    if (e.length) throw new Error(e.join(', '));
}

async function generateImageWithRetry(prompt, style, onStatus, options = {}) {
    validateSettings();
    const s = getSettings();
    const tag = options.tagInfo || {};
    let refs = [];
    if (s.apiType === 'naistera') refs = await collectReferences(tag, 'naistera');
    else refs = await collectReferences(tag, s.apiType === 'gemini' || isGeminiModel(s.model) ? 'gemini' : 'gemini');
    let lastErr;
    for (let a = 0; a <= s.maxRetries; a++) {
        try {
            onStatus?.(`Генерация${a > 0 ? ` (${a}/${s.maxRetries})` : ''}...`);
            if (s.apiType === 'naistera') return await generateImageNaistera(prompt, style, refs, options);
            if (s.apiType === 'gemini' || isGeminiModel(s.model)) return await generateImageGemini(prompt, style, refs, { ...options, tagInfo: tag });
            return await generateImageOpenAI(prompt, style, refs, options);
        } catch (e) {
            lastErr = e; iigLog('ERROR', `Attempt ${a + 1} failed:`, e.message);
            if (!/429|503|502|504|timeout|Таймаут|network/i.test(e.message) || a === s.maxRetries) break;
            const d = s.retryDelay * Math.pow(2, a); onStatus?.(`Повтор через ${d / 1000}с...`); await new Promise(r => setTimeout(r, d));
        }
    }
    throw lastErr;
}

async function checkFileExists(path) { try { return (await fetch(path, { method: 'HEAD' })).ok; } catch { return false; } }

// ─── Tag parser ──────────────────────────────────────────────────────────────

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // NEW FORMAT
    const imgTagMarker = 'data-iig-instruction=';
    let pos = 0;
    while (true) {
        const mp = text.indexOf(imgTagMarker, pos);
        if (mp === -1) break;
        let imgStart = text.lastIndexOf('<img', mp);
        if (imgStart === -1 || mp - imgStart > 500) { pos = mp + 1; continue; }
        const am = mp + imgTagMarker.length;
        let js = text.indexOf('{', am);
        if (js === -1 || js > am + 10) { pos = mp + 1; continue; }
        let bc = 0, je = -1, inStr = false, esc = false;
        for (let i = js; i < text.length; i++) {
            const c = text[i];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (!inStr) { if (c === '{') bc++; else if (c === '}') { bc--; if (bc === 0) { je = i + 1; break; } } }
        }
        if (je === -1) { pos = mp + 1; continue; }
        let imgEnd = text.indexOf('>', je); if (imgEnd === -1) { pos = mp + 1; continue; } imgEnd++;
        const fullTag = text.substring(imgStart, imgEnd);
        const instrJson = text.substring(js, je);
        const srcM = fullTag.match(/src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const srcVal = srcM ? (srcM[1] ?? srcM[2] ?? srcM[3] ?? '') : '';
        let need = false;
        const hasMarker = srcVal.includes('[IMG:GEN]') || srcVal.includes('[IMG:');
        const hasError = srcVal.includes('error.svg');
        const hasPath = srcVal && srcVal.startsWith('/') && srcVal.length > 5;
        if (hasError && !forceAll) { pos = imgEnd; continue; }
        if (forceAll) need = true;
        else if (hasMarker || !srcVal) need = true;
        else if (hasPath) {
            if (checkExistence) { if (!(await checkFileExists(srcVal))) { iigLog('WARN', `Not found: ${srcVal}`); need = true; } else { pos = imgEnd; continue; } }
            else { pos = imgEnd; continue; }
        }
        if (!need) { pos = imgEnd; continue; }
        try {
            const nj = instrJson.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const d = JSON.parse(nj);
            tags.push({ fullMatch: fullTag, index: imgStart, style: sanitizePrompt(d.style || ''), prompt: sanitizePrompt(d.prompt || ''), aspectRatio: d.aspect_ratio || d.aspectRatio || null, preset: d.preset || null, imageSize: d.image_size || d.imageSize || null, quality: d.quality || null, references: d.references || [], reference_hint: sanitizePrompt(d.reference_hint || ''), isNewFormat: true, existingSrc: hasPath ? srcVal : null });
        } catch (e) { iigLog('WARN', `JSON parse error: ${e.message}`); }
        pos = imgEnd;
    }

    // LEGACY FORMAT
    const marker = '[IMG:GEN:';
    let ss = 0;
    while (true) {
        const mi = text.indexOf(marker, ss); if (mi === -1) break;
        const jss = mi + marker.length;
        let bc = 0, je = -1, inStr = false, esc = false;
        for (let i = jss; i < text.length; i++) {
            const c = text[i];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (!inStr) { if (c === '{') bc++; else if (c === '}') { bc--; if (bc === 0) { je = i + 1; break; } } }
        }
        if (je === -1) { ss = jss; continue; }
        if (!text.substring(je).startsWith(']')) { ss = je; continue; }
        const tagOnly = text.substring(mi, je + 1);
        try {
            const d = JSON.parse(text.substring(jss, je).replace(/'/g, '"'));
            tags.push({ fullMatch: tagOnly, index: mi, style: sanitizePrompt(d.style || ''), prompt: sanitizePrompt(d.prompt || ''), aspectRatio: d.aspect_ratio || d.aspectRatio || null, preset: d.preset || null, imageSize: d.image_size || d.imageSize || null, quality: d.quality || null, references: d.references || [], reference_hint: sanitizePrompt(d.reference_hint || ''), isNewFormat: false });
        } catch (e) { iigLog('WARN', `Legacy JSON error: ${e.message}`); }
        ss = je + 1;
    }
    return tags;
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function findTargetElement(mesTextEl, tag, tagId) {
    let t = null;
    if (tag.isNewFormat) {
        const imgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
        const sp = tag.prompt.substring(0, 30);
        for (const img of imgs) {
            const instr = img.getAttribute('data-iig-instruction'); if (!instr) continue;
            const dec = instr.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const nsp = sp.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            if (dec.includes(nsp)) { t = img; break; }
            try { const d = JSON.parse(dec.replace(/'/g, '"')); if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { t = img; break; } } catch {}
            if (instr.includes(sp)) { t = img; break; }
        }
        if (!t) for (const img of imgs) { const src = img.getAttribute('src') || ''; if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') { t = img; break; } }
        if (!t) for (const img of mesTextEl.querySelectorAll('img')) { const src = img.getAttribute('src') || ''; if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { t = img; break; } }
    } else {
        const esc = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '(?:"|&quot;)');
        const before = mesTextEl.innerHTML;
        mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(esc, 'g'), `<span data-iig-placeholder="${tagId}"></span>`);
        if (before !== mesTextEl.innerHTML) t = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
        if (!t) for (const img of mesTextEl.querySelectorAll('img')) { if (img.src?.includes('[IMG:GEN:')) { t = img; break; } }
    }
    return t;
}

function createGeneratedImage(path, tag) {
    const img = document.createElement('img');
    img.className = 'iig-generated-image'; img.src = path; img.alt = tag.prompt;
    img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
    if (tag.isNewFormat) { const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i); if (m) img.setAttribute('data-iig-instruction', m[2]); }
    img.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showLightbox(path, tag.prompt, tag.style); });
    img.style.cursor = 'pointer';
    return img;
}

function updateMessageText(message, tag, path) {
    if (tag.isNewFormat) message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${path}"`));
    else message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${path}]`);
}

// ─── Placeholders ────────────────────────────────────────────────────────────

function createLoadingPlaceholder(tagId, idx, total) {
    const el = document.createElement('div');
    el.className = 'iig-loading-placeholder'; el.dataset.tagId = tagId;
    el.innerHTML = `<div class="iig-spinner"></div><div class="iig-status">Картинка ${(idx || 0) + 1}/${total || '?'}: Генерация...</div>`;
    return el;
}

function createErrorPlaceholder(tagId, errMsg, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image'; img.src = ERROR_IMAGE_PATH; img.alt = 'Ошибка'; img.title = `Ошибка: ${errMsg}`; img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) { const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i); if (m) img.setAttribute('data-iig-instruction', m[2]); }
    return img;
}

function createConfirmPlaceholder(tagId, tag, idx, total, onConfirm) {
    const el = document.createElement('div');
    el.className = 'iig-confirm-placeholder'; el.dataset.tagId = tagId;

    const refsInfo = tag.references?.length ? tag.references.join(', ') : '';
    const metaParts = [tag.aspectRatio, tag.imageSize, refsInfo ? `📎 ${refsInfo}` : ''].filter(Boolean);

    el.innerHTML = `
        <div class="iig-confirm-header">
            <span class="iig-confirm-icon">🖼️</span>
            <span class="iig-confirm-title">Картинка ${idx + 1}/${total}</span>
        </div>
        <div class="iig-confirm-field">
            <label class="iig-confirm-label">Стиль</label>
            <input type="text" class="iig-confirm-style-input text_pole" value="${sanitizeForHtml(tag.style)}" placeholder="Стиль (опционально)">
        </div>
        <div class="iig-confirm-field">
            <label class="iig-confirm-label">Промпт</label>
            <textarea class="iig-confirm-prompt-input text_pole" rows="4" placeholder="Описание изображения">${sanitizeForHtml(tag.prompt)}</textarea>
        </div>
        ${metaParts.length ? `<div class="iig-confirm-meta">${metaParts.map(p => `<span>${p}</span>`).join('')}</div>` : ''}
        <div class="iig-confirm-actions">
            <button class="iig-confirm-btn iig-btn-generate" title="Сгенерировать"><i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать</button>
            <button class="iig-confirm-btn iig-btn-skip" title="Пропустить"><i class="fa-solid fa-forward"></i></button>
        </div>
    `;

    el.querySelector('.iig-btn-generate').addEventListener('click', (e) => {
        e.stopPropagation();
        const editedPrompt = el.querySelector('.iig-confirm-prompt-input').value.trim();
        const editedStyle = el.querySelector('.iig-confirm-style-input').value.trim();
        onConfirm(true, editedPrompt, editedStyle);
    });
    el.querySelector('.iig-btn-skip').addEventListener('click', (e) => { e.stopPropagation(); onConfirm(false); });
    return el;
}

function createManualPlaceholder(tagId, tag, idx, total, onGenerate) {
    const el = document.createElement('div');
    el.className = 'iig-manual-placeholder'; el.dataset.tagId = tagId;

    el.innerHTML = `
        <div class="iig-manual-header">
            <span class="iig-manual-icon">🖼️</span>
            <span class="iig-manual-title">Картинка ${idx + 1}/${total}</span>
        </div>
        <div class="iig-confirm-field">
            <label class="iig-confirm-label">Стиль</label>
            <input type="text" class="iig-manual-style-input text_pole" value="${sanitizeForHtml(tag.style)}" placeholder="Стиль">
        </div>
        <div class="iig-confirm-field">
            <label class="iig-confirm-label">Промпт</label>
            <textarea class="iig-manual-prompt-input text_pole" rows="4" placeholder="Описание">${sanitizeForHtml(tag.prompt)}</textarea>
        </div>
        <div class="iig-confirm-actions">
            <button class="iig-confirm-btn iig-btn-generate" title="Сгенерировать"><i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать</button>
        </div>
    `;

    el.querySelector('.iig-btn-generate').addEventListener('click', (e) => {
        e.stopPropagation();
        const editedPrompt = el.querySelector('.iig-manual-prompt-input').value.trim();
        const editedStyle = el.querySelector('.iig-manual-style-input').value.trim();
        if (onGenerate) onGenerate(editedPrompt, editedStyle);
    });
    return el;
}

// ─── Lightbox ────────────────────────────────────────────────────────────────

function showLightbox(src, prompt, style) {
    const old = document.querySelector('.iig-lightbox'); if (old) old.remove();
    const lb = document.createElement('div'); lb.className = 'iig-lightbox';
    lb.innerHTML = `
        <div class="iig-lightbox-overlay"></div>
        <div class="iig-lightbox-content">
            <img src="${src}" class="iig-lightbox-image" alt="${sanitizeForHtml(prompt)}">
            <div class="iig-lightbox-info">
                ${style ? `<div class="iig-lightbox-style">🎨 ${sanitizeForHtml(style)}</div>` : ''}
                <div class="iig-lightbox-prompt">${sanitizeForHtml(prompt)}</div>
            </div>
            <div class="iig-lightbox-close" title="Закрыть">✕</div>
        </div>`;
    lb.querySelector('.iig-lightbox-overlay').addEventListener('click', () => lb.remove());
    lb.querySelector('.iig-lightbox-close').addEventListener('click', () => lb.remove());
    const esc = (e) => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);
    document.body.appendChild(lb);
}

// ─── Batch processing ────────────────────────────────────────────────────────

async function processInBatches(items, fn, concurrency = 1) {
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map((item, j) => fn(item, i + j)));
    }
}

// ─── Core generation for a single tag ────────────────────────────────────────

async function generateAndReplace(tag, index, total, placeholderElement, message, prompt, style) {
    const settings = getSettings();
    const context = SillyTavern.getContext();

    const loadingEl = createLoadingPlaceholder(`iig-gen-${index}`, index, total);
    placeholderElement.replaceWith(loadingEl);
    const statusEl = loadingEl.querySelector('.iig-status');

    try {
        if (settings.enableCache) {
            const ck = getCacheKey(prompt, style, tag.aspectRatio, tag.imageSize);
            if (imageCache.has(ck)) {
                const cached = imageCache.get(ck);
                if (await checkFileExists(cached)) {
                    iigLog('INFO', `Cache hit for tag ${index}`);
                    loadingEl.replaceWith(createGeneratedImage(cached, { ...tag, prompt, style }));
                    updateMessageText(message, tag, cached);
                    await context.saveChat();
                    toastr.success(`Картинка ${index + 1}/${total} (кэш)`, 'Генерация картинок', { timeOut: 2000 });
                    return;
                }
                imageCache.delete(ck);
            }
        }

        const dataUrl = await generateImageWithRetry(
            prompt, style,
            (s) => { statusEl.textContent = `Картинка ${index + 1}/${total}: ${s}`; },
            { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, tagInfo: tag }
        );

        statusEl.textContent = `Картинка ${index + 1}/${total}: Сохранение...`;
        const path = await saveImageToFile(dataUrl);

        if (settings.enableCache) imageCache.set(getCacheKey(prompt, style, tag.aspectRatio, tag.imageSize), path);

        loadingEl.replaceWith(createGeneratedImage(path, { ...tag, prompt, style }));
        updateMessageText(message, tag, path);
        await context.saveChat();

        iigLog('INFO', `Generated tag ${index}`);
        toastr.success(`Картинка ${index + 1}/${total} готова`, 'Генерация картинок', { timeOut: 2000 });
    } catch (error) {
        iigLog('ERROR', `Tag ${index} failed:`, error.message);
        const errEl = createErrorPlaceholder(`iig-err-${index}`, error.message, tag);
        loadingEl.replaceWith(errEl);

        if (tag.isNewFormat) {
            const errTag = tag.fullMatch.replace(/src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${ERROR_IMAGE_PATH}"`);
            message.mes = message.mes.replace(tag.fullMatch, errTag);
        } else {
            message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
        }
        await context.saveChat();
        toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
    }
}

// ─── Main processing ─────────────────────────────────────────────────────────

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) return;

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags: ${tags.length} tags`);
    if (!tags.length) return;

    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) return;
    const mesText = mesEl.querySelector('.mes_text');
    if (!mesText) return;

    const total = tags.length;

    if (settings.generationMode === 'manual') {
        iigLog('INFO', `Manual mode — ${total} placeholder(s)`);
        tags.forEach((tag, i) => {
            const tagId = `iig-manual-${messageId}-${i}`;
            const target = findTargetElement(mesText, tag, tagId);
            if (!target) return;

            const placeholder = createManualPlaceholder(tagId, tag, i, total, async (editedPrompt, editedStyle) => {
                iigLog('INFO', `Manual generate tag ${i}`);
                processingMessages.add(messageId);
                try {
                    await generateAndReplace(tag, i, total, placeholder, message, editedPrompt || tag.prompt, editedStyle ?? tag.style);
                } finally { processingMessages.delete(messageId); }
            });
            target.replaceWith(placeholder);
        });
        return;
    }

    if (settings.generationMode === 'confirm') {
        iigLog('INFO', `Confirm mode — ${total} placeholder(s)`);
        tags.forEach((tag, i) => {
            const tagId = `iig-confirm-${messageId}-${i}`;
            const target = findTargetElement(mesText, tag, tagId);
            if (!target) return;

            const placeholder = createConfirmPlaceholder(tagId, tag, i, total, async (shouldGen, editedPrompt, editedStyle) => {
                if (!shouldGen) {
                    const manual = createManualPlaceholder(tagId, tag, i, total, async (ep, es) => {
                        processingMessages.add(messageId);
                        try { await generateAndReplace(tag, i, total, manual, message, ep || tag.prompt, es ?? tag.style); }
                        finally { processingMessages.delete(messageId); }
                    });
                    placeholder.replaceWith(manual);
                    iigLog('INFO', `Skipped tag ${i}`);
                    return;
                }
                iigLog('INFO', `Confirmed tag ${i}`);
                processingMessages.add(messageId);
                try {
                    await generateAndReplace(tag, i, total, placeholder, message, editedPrompt || tag.prompt, editedStyle ?? tag.style);
                } finally { processingMessages.delete(messageId); }
            });
            target.replaceWith(placeholder);
        });
        return;
    }

    processingMessages.add(messageId);
    iigLog('INFO', `Auto mode — ${total} image(s)`);
    toastr.info(`Тегов: ${total}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    try {
        await processInBatches(tags, async (tag, i) => {
            const tagId = `iig-auto-${messageId}-${i}`;
            const target = findTargetElement(mesText, tag, tagId);

            const loading = createLoadingPlaceholder(tagId, i, total);
            if (target) {
                const p = target.parentElement;
                if (p) { const ps = window.getComputedStyle(p); if (ps.display === 'flex' || ps.display === 'grid') loading.style.alignSelf = 'center'; }
                target.replaceWith(loading);
            } else { mesText.appendChild(loading); }

            await generateAndReplace(tag, i, total, loading, message, tag.prompt, tag.style);
        }, settings.concurrency);
    } finally {
        processingMessages.delete(messageId);
        iigLog('INFO', `Finished message ${messageId}`);
    }
}

// ─── Regenerate ──────────────────────────────────────────────────────────────

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Не найдено', 'Генерация картинок'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (!tags.length) { toastr.warning('Нет тегов', 'Генерация картинок'); return; }

    iigLog('INFO', `Regen ${tags.length} in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length}...`, 'Генерация картинок');

    processingMessages.add(messageId);
    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) { processingMessages.delete(messageId); return; }
    const mesText = mesEl.querySelector('.mes_text');
    if (!mesText) { processingMessages.delete(messageId); return; }

    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const existing = mesText.querySelector('img[data-iig-instruction]');
        if (!existing) continue;
        const instr = existing.getAttribute('data-iig-instruction');

        const loading = createLoadingPlaceholder(`iig-regen-${i}`, i, tags.length);
        existing.replaceWith(loading);
        const statusEl = loading.querySelector('.iig-status');

        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt, tag.style,
                (s) => { statusEl.textContent = `${i + 1}/${tags.length}: ${s}`; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, tagInfo: tag }
            );
            statusEl.textContent = `${i + 1}/${tags.length}: Сохранение...`;
            const path = await saveImageToFile(dataUrl);
            if (settings.enableCache) imageCache.set(getCacheKey(tag.prompt, tag.style, tag.aspectRatio, tag.imageSize), path);
            const img = createGeneratedImage(path, tag);
            if (instr) img.setAttribute('data-iig-instruction', instr);
            loading.replaceWith(img);
            updateMessageText(message, tag, path);
            toastr.success(`${i + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (e) {
            iigLog('ERROR', `Regen ${i} failed:`, e.message);
            toastr.error(`Ошибка: ${e.message}`, 'Генерация картинок');
        }
    }
    processingMessages.delete(messageId);
    await context.saveChat();
}

// ─── Message menu button ─────────────────────────────────────────────────────

function addRegenerateButton(el, id) {
    if (el.querySelector('.iig-regenerate-btn')) return;
    const extra = el.querySelector('.extraMesButtons'); if (!extra) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки'; btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(id); });
    extra.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const ctx = SillyTavern.getContext(); if (!ctx.chat?.length) return;
    let c = 0;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mid = el.getAttribute('mesid'); if (mid === null) continue;
        const msg = ctx.chat[parseInt(mid, 10)];
        if (msg && !msg.is_user) { addRegenerateButton(el, parseInt(mid, 10)); c++; }
    }
    iigLog('INFO', `Buttons added to ${c} messages`);
}

// ─── Event handler ───────────────────────────────────────────────────────────

async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);
    const s = getSettings(); if (!s.enabled) return;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`); if (!el) return;
    addRegenerateButton(el, messageId);
    if (checkedMessages.has(messageId)) { iigLog('INFO', `Already checked ${messageId}`); return; }
    checkedMessages.add(messageId);
    if (!initialLoadComplete) { const last = SillyTavern.getContext().chat.length - 1; if (messageId !== last) return; }
    await processMessageTags(messageId);
}

// ─── Settings UI ─────────────────────────────────────────────────────────────

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <label class="checkbox_label"><input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}><span>Включить</span></label>

                    <div class="flex-row">
                        <label for="iig_generation_mode">Режим</label>
                        <select id="iig_generation_mode" class="flex1">
                            <option value="auto" ${settings.generationMode === 'auto' ? 'selected' : ''}>Автоматически</option>
                            <option value="confirm" ${settings.generationMode === 'confirm' ? 'selected' : ''}>С подтверждением</option>
                            <option value="manual" ${settings.generationMode === 'manual' ? 'selected' : ''}>Только вручную</option>
                        </select>
                    </div>
                    <p class="hint" id="iig_mode_hint"></p>

                    <hr>
                    <h4>API</h4>

                    <div class="flex-row">
                        <label for="iig_api_type">Тип</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini (nano-banana)</option>
                            <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera / Grok</option>
                        </select>
                    </div>

                    <div class="flex-row"><label for="iig_endpoint">URL</label><input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com"></div>

                    <div class="flex-row">
                        <label for="iig_api_key">Ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать"><i class="fa-solid fa-eye"></i></div>
                    </div>
                    <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Токен из Telegram бота.</p>

                    <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">--</option>'}</select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
                    </div>

                    <hr>
                    <h4>Генерация</h4>

                    <label class="checkbox_label"><input type="checkbox" id="iig_use_structured_prompt" ${settings.useStructuredPrompt ? 'checked' : ''}><span>Структурированный промпт (JSON)</span></label>
                    <p class="hint">Конвертирует текстовый промпт в структурированный JSON перед отправкой в API.</p>

                    <div class="flex-row"><label for="iig_concurrency">Параллельно</label><input type="number" id="iig_concurrency" class="text_pole flex1" value="${settings.concurrency}" min="1" max="4"></div>

                    <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_size_row">
                        <label for="iig_size">Размер</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024×1024</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792×1024</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024×1792</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512×512</option>
                        </select>
                    </div>
                    <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_quality_row">
                        <label for="iig_quality">Качество</label>
                        <select id="iig_quality" class="flex1"><option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Standard</option><option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option></select>
                    </div>

                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                        <label for="iig_naistera_aspect_ratio">Стороны</label>
                        <select id="iig_naistera_aspect_ratio" class="flex1"><option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option><option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option><option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option></select>
                    </div>
                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                        <label for="iig_naistera_preset">Пресет</label>
                        <select id="iig_naistera_preset" class="flex1"><option value="" ${!settings.naisteraPreset ? 'selected' : ''}>нет</option><option value="digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>digital</option><option value="realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>realism</option></select>
                    </div>

                    <div class="iig-naistera-refs ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_refs_section">
                        <h4>Референсы (Naistera)</h4>
                        <div class="flex-row"><label for="iig_naistera_reference_mode">Режим</label><select id="iig_naistera_reference_mode" class="flex1"><option value="always" ${settings.naisteraReferenceMode === 'always' ? 'selected' : ''}>Всегда</option><option value="tag_controls" ${settings.naisteraReferenceMode === 'tag_controls' ? 'selected' : ''}>Тег решает</option><option value="never" ${settings.naisteraReferenceMode === 'never' ? 'selected' : ''}>Никогда</option></select></div>
                        <label class="checkbox_label"><input type="checkbox" id="iig_naistera_send_char_avatar" ${settings.naisteraSendCharAvatar ? 'checked' : ''}><span>{{char}}</span></label>
                        <label class="checkbox_label"><input type="checkbox" id="iig_naistera_send_user_avatar" ${settings.naisteraSendUserAvatar ? 'checked' : ''}><span>{{user}}</span></label>
                        <div id="iig_naistera_user_avatar_row" class="flex-row ${!settings.naisteraSendUserAvatar ? 'iig-hidden' : ''}">
                            <label for="iig_naistera_user_avatar_file">Аватар</label>
                            <select id="iig_naistera_user_avatar_file" class="flex1"><option value="">--</option>${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}</select>
                            <div id="iig_naistera_refresh_avatars" class="menu_button iig-refresh-btn"><i class="fa-solid fa-sync"></i></div>
                        </div>
                    </div>

                    <hr>

                    <div id="iig_avatar_section" class="iig-avatar-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Nano-Banana</h4>
                        <div class="flex-row"><label for="iig_aspect_ratio">Стороны</label><select id="iig_aspect_ratio" class="flex1">${VALID_ASPECT_RATIOS.map(r => `<option value="${r}" ${settings.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
                        <div class="flex-row"><label for="iig_image_size">Разрешение</label><select id="iig_image_size" class="flex1">${VALID_IMAGE_SIZES.map(s => `<option value="${s}" ${settings.imageSize === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
                        <hr>
                        <h5>Референсы</h5>
                        <div class="flex-row"><label for="iig_reference_mode">Режим</label><select id="iig_reference_mode" class="flex1"><option value="always" ${settings.referenceMode === 'always' ? 'selected' : ''}>Всегда</option><option value="tag_controls" ${settings.referenceMode === 'tag_controls' ? 'selected' : ''}>Тег решает</option><option value="never" ${settings.referenceMode === 'never' ? 'selected' : ''}>Никогда</option></select></div>
                        <label class="checkbox_label"><input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}><span>{{char}}</span></label>
                        <label class="checkbox_label"><input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}><span>{{user}}</span></label>
                        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}">
                            <label for="iig_user_avatar_file">Аватар</label>
                            <select id="iig_user_avatar_file" class="flex1"><option value="">--</option>${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}</select>
                            <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn"><i class="fa-solid fa-sync"></i></div>
                        </div>
                    </div>

                    <hr>
                    <h4>Ошибки</h4>
                    <div class="flex-row"><label for="iig_max_retries">Повторы</label><input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5"></div>
                    <div class="flex-row"><label for="iig_retry_delay">Задержка мс</label><input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500"></div>
                    <div class="flex-row"><label for="iig_generation_timeout">Таймаут мс</label><input type="number" id="iig_generation_timeout" class="text_pole flex1" value="${settings.generationTimeout}" min="30000" max="600000" step="10000"></div>

                    <hr>
                    <h4>Кэш</h4>
                    <label class="checkbox_label"><input type="checkbox" id="iig_enable_cache" ${settings.enableCache ? 'checked' : ''}><span>Кэшировать</span></label>
                    <div class="flex-row"><div id="iig_clear_cache" class="menu_button" style="width:100%"><i class="fa-solid fa-trash"></i> Очистить (<span id="iig_cache_size">${imageCache.size}</span>)</div></div>

                    <hr>
                    <h4>Отладка</h4>
                    <div class="flex-row"><div id="iig_export_logs" class="menu_button" style="width:100%"><i class="fa-solid fa-download"></i> Экспорт логов</div></div>
                </div>
            </div>
        </div>`;

    container.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();
}

function bindSettingsEvents() {
    const s = getSettings();

    const modeHints = {
        auto: 'Генерация при появлении сообщения.',
        confirm: 'Превью + кнопка подтверждения. Можно отредактировать промпт.',
        manual: 'Только вручную. Промпт можно отредактировать перед генерацией.'
    };
    const updateHint = () => { const h = document.getElementById('iig_mode_hint'); if (h) h.textContent = modeHints[s.generationMode] || ''; };
    updateHint();

    const updateVis = () => {
        const isN = s.apiType === 'naistera', isG = s.apiType === 'gemini', isO = s.apiType === 'openai';
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isN);
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isO);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isO);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_naistera_refs_section')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_naistera_user_avatar_row')?.classList.toggle('iig-hidden', !(isN && s.naisteraSendUserAvatar));
        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_avatar_section')?.classList.toggle('hidden', !isG);
    };

    const bind = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);

    bind('iig_enabled', 'change', e => { s.enabled = e.target.checked; saveSettings(); });
    bind('iig_generation_mode', 'change', e => { s.generationMode = e.target.value; saveSettings(); updateHint(); });
    bind('iig_api_type', 'change', e => { s.apiType = e.target.value; saveSettings(); updateVis(); });
    bind('iig_endpoint', 'input', e => { s.endpoint = e.target.value; saveSettings(); });
    bind('iig_api_key', 'input', e => { s.apiKey = e.target.value; saveSettings(); });
    bind('iig_key_toggle', 'click', () => { const i = document.getElementById('iig_api_key'), ic = document.querySelector('#iig_key_toggle i'); if (i.type === 'password') { i.type = 'text'; ic.classList.replace('fa-eye', 'fa-eye-slash'); } else { i.type = 'password'; ic.classList.replace('fa-eye-slash', 'fa-eye'); } });
    bind('iig_model', 'change', e => { s.model = e.target.value; saveSettings(); if (isGeminiModel(e.target.value)) { document.getElementById('iig_api_type').value = 'gemini'; s.apiType = 'gemini'; updateVis(); } });
    bind('iig_refresh_models', 'click', async e => { const b = e.currentTarget; b.classList.add('loading'); try { const ms = await fetchModels(); const sel = document.getElementById('iig_model'); sel.innerHTML = '<option value="">--</option>'; for (const m of ms) { const o = document.createElement('option'); o.value = m; o.textContent = m; o.selected = m === s.model; sel.appendChild(o); } toastr.success(`${ms.length} моделей`); } catch { toastr.error('Ошибка'); } finally { b.classList.remove('loading'); } });
    bind('iig_size', 'change', e => { s.size = e.target.value; saveSettings(); });
    bind('iig_quality', 'change', e => { s.quality = e.target.value; saveSettings(); });
    bind('iig_use_structured_prompt', 'change', e => { s.useStructuredPrompt = e.target.checked; saveSettings(); });
    bind('iig_concurrency', 'input', e => { s.concurrency = Math.max(1, Math.min(4, parseInt(e.target.value) || 1)); saveSettings(); });
    bind('iig_aspect_ratio', 'change', e => { s.aspectRatio = e.target.value; saveSettings(); });
    bind('iig_image_size', 'change', e => { s.imageSize = e.target.value; saveSettings(); });
    bind('iig_reference_mode', 'change', e => { s.referenceMode = e.target.value; saveSettings(); });
    bind('iig_naistera_aspect_ratio', 'change', e => { s.naisteraAspectRatio = e.target.value; saveSettings(); });
    bind('iig_naistera_preset', 'change', e => { s.naisteraPreset = e.target.value; saveSettings(); });
    bind('iig_naistera_reference_mode', 'change', e => { s.naisteraReferenceMode = e.target.value; saveSettings(); });
    bind('iig_naistera_send_char_avatar', 'change', e => { s.naisteraSendCharAvatar = e.target.checked; saveSettings(); });
    bind('iig_naistera_send_user_avatar', 'change', e => { s.naisteraSendUserAvatar = e.target.checked; saveSettings(); updateVis(); });
    bind('iig_naistera_user_avatar_file', 'change', e => { s.userAvatarFile = e.target.value; saveSettings(); });
    bind('iig_naistera_refresh_avatars', 'click', async e => { const b = e.currentTarget; b.classList.add('loading'); try { const a = await fetchUserAvatars(); const sel = document.getElementById('iig_naistera_user_avatar_file'); sel.innerHTML = '<option value="">--</option>'; for (const av of a) { const o = document.createElement('option'); o.value = av; o.textContent = av; o.selected = av === s.userAvatarFile; sel.appendChild(o); } toastr.success(`${a.length} аватаров`); } catch { toastr.error('Ошибка'); } finally { b.classList.remove('loading'); } });
    bind('iig_send_char_avatar', 'change', e => { s.sendCharAvatar = e.target.checked; saveSettings(); });
    bind('iig_send_user_avatar', 'change', e => { s.sendUserAvatar = e.target.checked; saveSettings(); document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked); });
    bind('iig_user_avatar_file', 'change', e => { s.userAvatarFile = e.target.value; saveSettings(); });
    bind('iig_refresh_avatars', 'click', async e => { const b = e.currentTarget; b.classList.add('loading'); try { const a = await fetchUserAvatars(); const sel = document.getElementById('iig_user_avatar_file'); sel.innerHTML = '<option value="">--</option>'; for (const av of a) { const o = document.createElement('option'); o.value = av; o.textContent = av; o.selected = av === s.userAvatarFile; sel.appendChild(o); } toastr.success(`${a.length} аватаров`); } catch { toastr.error('Ошибка'); } finally { b.classList.remove('loading'); } });
    bind('iig_max_retries', 'input', e => { s.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    bind('iig_retry_delay', 'input', e => { s.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    bind('iig_generation_timeout', 'input', e => { s.generationTimeout = parseInt(e.target.value) || 120000; saveSettings(); });
    bind('iig_enable_cache', 'change', e => { s.enableCache = e.target.checked; saveSettings(); });
    bind('iig_clear_cache', 'click', () => { const n = imageCache.size; imageCache.clear(); document.getElementById('iig_cache_size').textContent = '0'; toastr.success(`Очищено (${n})`); });
    bind('iig_export_logs', 'click', exportLogs);

    updateVis();
}

// ─── Init ────────────────────────────────────────────────────────────────────

(function init() {
    const ctx = SillyTavern.getContext();
    getSettings();

    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        setTimeout(() => { initialLoadComplete = true; iigLog('INFO', 'Initial load complete'); }, 2000);
        console.log('[IIG] v2.3 loaded');
    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED');
        checkedMessages.clear(); initialLoadComplete = false;
        setTimeout(() => addButtonsToExistingMessages(), 100);
        setTimeout(() => { initialLoadComplete = true; iigLog('INFO', 'Chat load complete'); }, 2000);
    });

    ctx.eventSource.makeLast(ctx.event_types.CHARACTER_MESSAGE_RENDERED, async (id) => {
        console.log('[IIG] MESSAGE_RENDERED:', id);
        await onMessageReceived(id);
    });

    console.log('[IIG] v2.3 initialized');
})();
