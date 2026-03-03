/**
 * Inline Image Generation Extension for SillyTavern
 *
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible, Gemini-compatible (nano-banana), and Naistera endpoints.
 *
 * v2.1 — Smart references, generation queue, timeouts, caching, lightbox,
 *         generation modes (auto / confirm / manual), src-parse fix for spaces.
 */

const MODULE_NAME = 'inline_image_gen';

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

// Track messages already checked this session (prevent re-processing on chat load)
const checkedMessages = new Set();

// Track whether the initial chat load is complete
let initialLoadComplete = false;

// Image cache: prompt+style+aspect → saved file path
const imageCache = new Map();

// Log buffer for debugging
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }

    if (level === 'ERROR') {
        console.error('[IIG]', ...args);
    } else if (level === 'WARN') {
        console.warn('[IIG]', ...args);
    } else {
        console.log('[IIG]', ...args);
    }
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
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
    generationMode: 'auto', // 'auto' | 'confirm' | 'manual'
    apiType: 'openai',      // 'openai' | 'gemini' | 'naistera'
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
    // Nano-banana specific
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    referenceMode: 'tag_controls', // 'always' | 'tag_controls' | 'never'
    // Naistera specific
    naisteraAspectRatio: '1:1',
    naisteraPreset: '',
    naisteraSendCharAvatar: false,
    naisteraSendUserAvatar: false,
    naisteraReferenceMode: 'tag_controls',
});

// ─── Model detection keywords ────────────────────────────────────────────────

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

// Error image path
const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) { if (mid.includes(kw)) return false; }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) { if (mid.includes(kw)) return true; }
    return false;
}

function isGeminiModel(modelId) {
    return modelId.toLowerCase().includes('nano-banana');
}

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getCharacterName() {
    const ctx = SillyTavern.getContext();
    return ctx.characters?.[ctx.characterId]?.name || 'Character';
}

function getUserName() {
    return SillyTavern.getContext().name1 || 'User';
}

function getCacheKey(prompt, style, aspectRatio, imageSize) {
    return `${style || ''}||${aspectRatio || ''}||${imageSize || ''}||${prompt}`;
}

function sanitizePrompt(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').replace(/on\w+\s*=/gi, '').trim();
}

function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Fetch with timeout ──────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === 'AbortError') throw new Error(`Таймаут запроса (${timeoutMs / 1000}с)`);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) return [];
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        }, 15000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

async function fetchUserAvatars() {
    try {
        const ctx = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', { method: 'POST', headers: ctx.getRequestHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

// ─── Image conversion helpers ────────────────────────────────────────────────

async function imageUrlToBase64(url) {
    try {
        const blob = await (await fetch(url)).blob();
        return await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onloadend = () => resolve(r.result.split(',')[1]);
            r.onerror = reject;
            r.readAsDataURL(blob);
        });
    } catch (e) { console.error('[IIG] imageUrlToBase64 failed:', e); return null; }
}

async function imageUrlToDataUrl(url) {
    try {
        const blob = await (await fetch(url)).blob();
        return await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onloadend = () => resolve(r.result);
            r.onerror = reject;
            r.readAsDataURL(blob);
        });
    } catch (e) { console.error('[IIG] imageUrlToDataUrl failed:', e); return null; }
}

// ─── Save image to server ────────────────────────────────────────────────────

async function saveImageToFile(dataUrl) {
    const ctx = SillyTavern.getContext();
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');
    const [, format, base64Data] = match;
    let charName = 'generated';
    if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
        charName = ctx.characters[ctx.characterId].name || 'generated';
    }
    const filename = `iig_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Upload failed: ${response.status}`);
    }
    const result = await response.json();
    iigLog('INFO', 'Image saved to:', result.path);
    return result.path;
}

// ─── Avatar getters ──────────────────────────────────────────────────────────

async function getCharacterAvatarBase64() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId == null) return null;
        if (typeof ctx.getCharacterAvatar === 'function') {
            const u = ctx.getCharacterAvatar(ctx.characterId);
            if (u) return await imageUrlToBase64(u);
        }
        const ch = ctx.characters?.[ctx.characterId];
        if (ch?.avatar) return await imageUrlToBase64(`/characters/${encodeURIComponent(ch.avatar)}`);
        return null;
    } catch (e) { console.error('[IIG] getCharacterAvatarBase64:', e); return null; }
}

async function getCharacterAvatarDataUrl() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId == null) return null;
        if (typeof ctx.getCharacterAvatar === 'function') {
            const u = ctx.getCharacterAvatar(ctx.characterId);
            if (u) return await imageUrlToDataUrl(u);
        }
        const ch = ctx.characters?.[ctx.characterId];
        if (ch?.avatar) return await imageUrlToDataUrl(`/characters/${encodeURIComponent(ch.avatar)}`);
        return null;
    } catch (e) { console.error('[IIG] getCharacterAvatarDataUrl:', e); return null; }
}

async function getUserAvatarBase64() {
    try {
        const s = getSettings();
        if (!s.userAvatarFile) return null;
        return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(s.userAvatarFile)}`);
    } catch (e) { console.error('[IIG] getUserAvatarBase64:', e); return null; }
}

async function getUserAvatarDataUrl() {
    try {
        const s = getSettings();
        if (!s.userAvatarFile) return null;
        return await imageUrlToDataUrl(`/User Avatars/${encodeURIComponent(s.userAvatarFile)}`);
    } catch (e) { console.error('[IIG] getUserAvatarDataUrl:', e); return null; }
}

// ─── Smart reference helpers ─────────────────────────────────────────────────

function buildReferenceInstruction(referenceImages, tagInfo = {}) {
    if (referenceImages.length === 0) return '';
    const parts = [];
    for (const ref of referenceImages) {
        if (ref.role === 'char') {
            parts.push(
                `One reference image shows the character "${getCharacterName()}". ` +
                `Use it ONLY to match this character's appearance IF "${getCharacterName()}" appears in the scene. ` +
                `Do NOT apply this appearance to other characters.`
            );
        } else if (ref.role === 'user') {
            parts.push(
                `One reference image shows the user "${getUserName()}". ` +
                `Use it ONLY to match the user's appearance IF they appear in the scene. ` +
                `Do NOT apply this appearance to other characters.`
            );
        }
    }
    if (tagInfo.reference_hint) parts.push(tagInfo.reference_hint);
    return `[Reference guidance: ${parts.join(' ')} IMPORTANT: Characters NOT shown in reference images should have their OWN unique appearances as described in the prompt. Never blend reference appearances onto unrelated characters.]`;
}

async function collectReferences(tag, mode = 'gemini') {
    const settings = getSettings();
    const refs = [];
    const refMode = mode === 'naistera' ? settings.naisteraReferenceMode : settings.referenceMode;
    if (refMode === 'never') { iigLog('INFO', 'refMode=never, skipping'); return refs; }

    let sendChar = false, sendUser = false;
    if (refMode === 'tag_controls') {
        const r = tag.references || [];
        if (r.length === 0) { iigLog('INFO', 'Tag has no "references", skipping (tag_controls)'); return refs; }
        sendChar = r.includes('char');
        sendUser = r.includes('user');
        iigLog('INFO', `Tag requested references: ${r.join(', ')}`);
    } else {
        if (mode === 'naistera') { sendChar = settings.naisteraSendCharAvatar; sendUser = settings.naisteraSendUserAvatar; }
        else { sendChar = settings.sendCharAvatar; sendUser = settings.sendUserAvatar; }
    }

    if (mode === 'naistera') {
        if (sendChar) { const d = await getCharacterAvatarDataUrl(); if (d) refs.push({ image: d, role: 'char' }); }
        if (sendUser) { const d = await getUserAvatarDataUrl(); if (d) refs.push({ image: d, role: 'user' }); }
    } else {
        if (sendChar) { const d = await getCharacterAvatarBase64(); if (d) refs.push({ image: d, role: 'char' }); }
        if (sendUser) { const d = await getUserAvatarBase64(); if (d) refs.push({ image: d, role: 'user' }); }
    }
    iigLog('INFO', `Collected ${refs.length} reference(s), mode=${mode}, refMode=${refMode}`);
    return refs;
}

// ─── Generation functions ────────────────────────────────────────────────────

async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const s = getSettings();
    const url = `${s.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    let size = s.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1792x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1792';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }
    const body = { model: s.model, prompt: fullPrompt, n: 1, size, quality: options.quality || s.quality, response_format: 'b64_json' };
    if (referenceImages.length > 0) {
        const img = referenceImages[0];
        body.image = `data:image/png;base64,${typeof img === 'string' ? img : img.image}`;
    }
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }, s.generationTimeout);
    if (!response.ok) { const t = await response.text(); throw new Error(`API Error (${response.status}): ${t}`); }
    const result = await response.json();
    const dl = result.data || [];
    if (dl.length === 0) { if (result.url) return result.url; throw new Error('No image data in response'); }
    const obj = dl[0];
    return obj.b64_json ? `data:image/png;base64,${obj.b64_json}` : obj.url;
}

async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const s = getSettings();
    const model = s.model;
    const url = `${s.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    let aspectRatio = options.aspectRatio || s.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = VALID_ASPECT_RATIOS.includes(s.aspectRatio) ? s.aspectRatio : '1:1';
    let imageSize = options.imageSize || s.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = VALID_IMAGE_SIZES.includes(s.imageSize) ? s.imageSize : '1K';
    iigLog('INFO', `Gemini: aspect=${aspectRatio}, size=${imageSize}, refs=${referenceImages.length}`);
    const parts = [];
    for (const ref of referenceImages.slice(0, 4)) {
        parts.push({ inlineData: { mimeType: 'image/png', data: typeof ref === 'string' ? ref : ref.image } });
    }
    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    if (referenceImages.length > 0) {
        fullPrompt = `${buildReferenceInstruction(referenceImages, options.tagInfo || {})}\n\n${fullPrompt}`;
    }
    parts.push({ text: fullPrompt });
    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio, imageSize } }
    };
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }, s.generationTimeout);
    if (!response.ok) { const t = await response.text(); throw new Error(`API Error (${response.status}): ${t}`); }
    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');
    for (const part of (candidates[0].content?.parts || [])) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('No image found in Gemini response');
}

async function generateImageNaistera(prompt, style, referenceImages = [], options = {}) {
    const s = getSettings();
    const endpoint = s.endpoint.replace(/\/$/, '');
    const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    const body = { prompt: fullPrompt, aspect_ratio: options.aspectRatio || s.naisteraAspectRatio || '1:1' };
    const preset = options.preset || s.naisteraPreset || null;
    if (preset) body.preset = preset;
    if (referenceImages.length > 0) {
        body.reference_images = referenceImages.slice(0, 4).map(r => typeof r === 'string' ? r : r.image);
    }
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }, s.generationTimeout);
    if (!response.ok) { const t = await response.text(); throw new Error(`API Error (${response.status}): ${t}`); }
    const result = await response.json();
    if (!result?.data_url) throw new Error('No data_url in response');
    return result.data_url;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateSettings() {
    const s = getSettings();
    const errors = [];
    if (!s.endpoint) errors.push('URL эндпоинта не настроен');
    if (!s.apiKey) errors.push('API ключ не настроен');
    if (s.apiType !== 'naistera' && !s.model) errors.push('Модель не выбрана');
    if (errors.length) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

// ─── Generate with retry ─────────────────────────────────────────────────────

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const s = getSettings();
    const tag = options.tagInfo || {};
    let refs = [];
    if (s.apiType === 'naistera') refs = await collectReferences(tag, 'naistera');
    else if (s.apiType === 'gemini' || isGeminiModel(s.model)) refs = await collectReferences(tag, 'gemini');
    else refs = await collectReferences(tag, 'gemini');

    let lastError;
    for (let attempt = 0; attempt <= s.maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${s.maxRetries})` : ''}...`);
            if (s.apiType === 'naistera') return await generateImageNaistera(prompt, style, refs, { ...options });
            if (s.apiType === 'gemini' || isGeminiModel(s.model)) return await generateImageGemini(prompt, style, refs, { ...options, tagInfo: tag });
            return await generateImageOpenAI(prompt, style, refs, options);
        } catch (error) {
            lastError = error;
            iigLog('ERROR', `Attempt ${attempt + 1} failed:`, error.message);
            const retryable = /429|503|502|504|timeout|Таймаут|network/i.test(error.message);
            if (!retryable || attempt === s.maxRetries) break;
            const delay = s.retryDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

// ─── File existence check ────────────────────────────────────────────────────

async function checkFileExists(path) {
    try { return (await fetch(path, { method: 'HEAD' })).ok; } catch { return false; }
}

// ─── Tag parser ──────────────────────────────────────────────────────────────

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // ── NEW FORMAT: <img data-iig-instruction='{...}' src="..."> ──
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }

        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }

        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
        imgEnd++;

        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);

        // Parse src correctly — handle quoted values with spaces
        const srcMatch = fullImgTag.match(/src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const srcValue = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '') : '';

        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }

        if (forceAll) {
            needsGeneration = true;
        } else if (hasMarker || !srcValue) {
            needsGeneration = true;
        } else if (hasPath) {
            if (checkExistence) {
                const exists = await checkFileExists(srcValue);
                if (!exists) { iigLog('WARN', `File does not exist: ${srcValue}`); needsGeneration = true; }
                else { iigLog('INFO', `Image exists, skipping: ${srcValue.substring(0, 60)}`); searchPos = imgEnd; continue; }
            } else {
                searchPos = imgEnd; continue;
            }
        }

        if (!needsGeneration) { searchPos = imgEnd; continue; }

        try {
            let nj = instructionJson.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(nj);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: sanitizePrompt(data.style || ''),
                prompt: sanitizePrompt(data.prompt || ''),
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                references: data.references || [],
                reference_hint: sanitizePrompt(data.reference_hint || ''),
                isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });
            iigLog('INFO', `Found NEW tag: prompt="${data.prompt?.substring(0, 50)}", refs=${JSON.stringify(data.references || [])}`);
        } catch (e) { iigLog('WARN', `JSON parse error: ${instructionJson.substring(0, 100)}`, e.message); }
        searchPos = imgEnd;
    }

    // ── LEGACY FORMAT: [IMG:GEN:{...}] ──
    const marker = '[IMG:GEN:';
    let ss = 0;
    while (true) {
        const mi = text.indexOf(marker, ss);
        if (mi === -1) break;
        const js = mi + marker.length;
        let braceCount = 0, je = -1, inString = false, escapeNext = false;
        for (let i = js; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { je = i + 1; break; } }
            }
        }
        if (je === -1) { ss = js; continue; }
        const jsonStr = text.substring(js, je);
        if (!text.substring(je).startsWith(']')) { ss = je; continue; }
        const tagOnly = text.substring(mi, je + 1);
        try {
            const data = JSON.parse(jsonStr.replace(/'/g, '"'));
            tags.push({
                fullMatch: tagOnly, index: mi,
                style: sanitizePrompt(data.style || ''),
                prompt: sanitizePrompt(data.prompt || ''),
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                references: data.references || [],
                reference_hint: sanitizePrompt(data.reference_hint || ''),
                isNewFormat: false
            });
            iigLog('INFO', `Found LEGACY tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) { iigLog('WARN', `Legacy JSON parse error: ${jsonStr.substring(0, 100)}`, e.message); }
        ss = je + 1;
    }

    return tags;
}

// ─── DOM element finders & creators ──────────────────────────────────────────

function findTargetElement(mesTextEl, tag, tagId) {
    let target = null;
    if (tag.isNewFormat) {
        const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
        const sp = tag.prompt.substring(0, 30);
        for (const img of allImgs) {
            const instr = img.getAttribute('data-iig-instruction');
            if (!instr) continue;
            const decoded = instr.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const nsp = sp.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            if (decoded.includes(nsp)) { target = img; break; }
            try {
                const d = JSON.parse(decoded.replace(/'/g, '"'));
                if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { target = img; break; }
            } catch {}
            if (instr.includes(sp)) { target = img; break; }
        }
        if (!target) {
            for (const img of allImgs) {
                const src = img.getAttribute('src') || '';
                if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') { target = img; break; }
            }
        }
        if (!target) {
            for (const img of mesTextEl.querySelectorAll('img')) {
                const src = img.getAttribute('src') || '';
                if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { target = img; break; }
            }
        }
    } else {
        const escaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '(?:"|&quot;)');
        const before = mesTextEl.innerHTML;
        mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(escaped, 'g'), `<span data-iig-placeholder="${tagId}"></span>`);
        if (before !== mesTextEl.innerHTML) target = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
        if (!target) {
            for (const img of mesTextEl.querySelectorAll('img')) {
                if (img.src?.includes('[IMG:GEN:')) { target = img; break; }
            }
        }
    }
    return target;
}

function createGeneratedImage(imagePath, tag) {
    const img = document.createElement('img');
    img.className = 'iig-generated-image';
    img.src = imagePath;
    img.alt = tag.prompt;
    img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
    if (tag.isNewFormat) {
        const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (m) img.setAttribute('data-iig-instruction', m[2]);
    }
    img.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showLightbox(imagePath, tag.prompt, tag.style); });
    img.style.cursor = 'pointer';
    return img;
}

function updateMessageText(message, tag, imagePath) {
    if (tag.isNewFormat) {
        const updated = tag.fullMatch.replace(/src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${imagePath}"`);
        message.mes = message.mes.replace(tag.fullMatch, updated);
    } else {
        message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`);
    }
}

// ─── Placeholders ────────────────────────────────────────────────────────────

function createLoadingPlaceholder(tagId, tagIndex, totalTags) {
    const el = document.createElement('div');
    el.className = 'iig-loading-placeholder';
    el.dataset.tagId = tagId;
    el.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">Картинка ${(tagIndex || 0) + 1}/${totalTags || '?'}: Генерация...</div>
    `;
    return el;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (m) img.setAttribute('data-iig-instruction', m[2]);
    }
    return img;
}

function createConfirmPlaceholder(tagId, tag, tagIndex, totalTags, onConfirm) {
    const el = document.createElement('div');
    el.className = 'iig-confirm-placeholder';
    el.dataset.tagId = tagId;
    const preview = tag.prompt.length > 120 ? tag.prompt.substring(0, 120) + '…' : tag.prompt;
    el.innerHTML = `
        <div class="iig-confirm-header">
            <span class="iig-confirm-icon">🖼️</span>
            <span class="iig-confirm-title">Картинка ${tagIndex + 1}/${totalTags}</span>
        </div>
        <div class="iig-confirm-prompt">${sanitizeForHtml(preview)}</div>
        ${tag.style ? `<div class="iig-confirm-style">🎨 ${sanitizeForHtml(tag.style)}</div>` : ''}
        <div class="iig-confirm-meta">
            ${tag.aspectRatio ? `<span>${tag.aspectRatio}</span>` : ''}
            ${tag.imageSize ? `<span>${tag.imageSize}</span>` : ''}
            ${tag.references?.length ? `<span>📎 ${tag.references.join(', ')}</span>` : ''}
        </div>
        <div class="iig-confirm-actions">
            <button class="iig-confirm-btn iig-btn-generate" title="Сгенерировать">
                <i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать
            </button>
            <button class="iig-confirm-btn iig-btn-skip" title="Пропустить">
                <i class="fa-solid fa-forward"></i> Пропустить
            </button>
        </div>
    `;
    el.querySelector('.iig-btn-generate').addEventListener('click', (e) => { e.stopPropagation(); onConfirm(true); });
    el.querySelector('.iig-btn-skip').addEventListener('click', (e) => { e.stopPropagation(); onConfirm(false); });
    return el;
}

function createManualPlaceholder(tagId, tag, tagIndex, totalTags) {
    const el = document.createElement('div');
    el.className = 'iig-manual-placeholder';
    el.dataset.tagId = tagId;
    const preview = tag.prompt.length > 80 ? tag.prompt.substring(0, 80) + '…' : tag.prompt;
    el.innerHTML = `
        <span class="iig-manual-icon">🖼️</span>
        <span class="iig-manual-text">${sanitizeForHtml(preview)}</span>
    `;
    el.title = 'Используйте кнопку 🖼️ в меню сообщения для генерации';
    return el;
}

// ─── Lightbox ────────────────────────────────────────────────────────────────

function showLightbox(imageSrc, prompt, style) {
    const existing = document.querySelector('.iig-lightbox');
    if (existing) existing.remove();
    const lb = document.createElement('div');
    lb.className = 'iig-lightbox';
    lb.innerHTML = `
        <div class="iig-lightbox-overlay"></div>
        <div class="iig-lightbox-content">
            <img src="${imageSrc}" class="iig-lightbox-image" alt="${sanitizeForHtml(prompt)}">
            <div class="iig-lightbox-info">
                ${style ? `<div class="iig-lightbox-style">🎨 ${sanitizeForHtml(style)}</div>` : ''}
                <div class="iig-lightbox-prompt">${sanitizeForHtml(prompt)}</div>
            </div>
            <div class="iig-lightbox-close" title="Закрыть">✕</div>
        </div>
    `;
    lb.querySelector('.iig-lightbox-overlay').addEventListener('click', () => lb.remove());
    lb.querySelector('.iig-lightbox-close').addEventListener('click', () => lb.remove());
    const esc = (e) => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);
    document.body.appendChild(lb);
}

// ─── Batch processing ────────────────────────────────────────────────────────

async function processInBatches(items, processFn, concurrency = 1) {
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map((item, j) => processFn(item, i + j)));
    }
}

// ─── Single-tag generation (shared by confirm + auto modes) ──────────────────

async function generateSingleTag(tag, index, totalTags, mesTextEl, message, tagIdPrefix) {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    const tagId = `${tagIdPrefix}-${index}`;

    // Check cache
    if (settings.enableCache) {
        const ck = getCacheKey(tag.prompt, tag.style, tag.aspectRatio, tag.imageSize);
        if (imageCache.has(ck)) {
            const cached = imageCache.get(ck);
            if (await checkFileExists(cached)) {
                iigLog('INFO', `Cache hit for tag ${index}`);
                const target = findTargetElement(mesTextEl, tag, tagId);
                if (target) { target.replaceWith(createGeneratedImage(cached, tag)); }
                updateMessageText(message, tag, cached);
                toastr.success(`Картинка ${index + 1}/${totalTags} (кэш)`, 'Генерация картинок', { timeOut: 2000 });
                return;
            }
            imageCache.delete(ck);
        }
    }

    const loading = createLoadingPlaceholder(tagId, index, totalTags);
    const target = findTargetElement(mesTextEl, tag, tagId);
    if (target) {
        const p = target.parentElement;
        if (p) { const ps = window.getComputedStyle(p); if (ps.display === 'flex' || ps.display === 'grid') loading.style.alignSelf = 'center'; }
        target.replaceWith(loading);
    } else {
        mesTextEl.appendChild(loading);
    }
    const statusEl = loading.querySelector('.iig-status');

    try {
        const dataUrl = await generateImageWithRetry(
            tag.prompt, tag.style,
            (s) => { statusEl.textContent = `Картинка ${index + 1}/${totalTags}: ${s}`; },
            { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, tagInfo: tag }
        );
        statusEl.textContent = `Картинка ${index + 1}/${totalTags}: Сохранение...`;
        const path = await saveImageToFile(dataUrl);
        if (settings.enableCache) imageCache.set(getCacheKey(tag.prompt, tag.style, tag.aspectRatio, tag.imageSize), path);
        loading.replaceWith(createGeneratedImage(path, tag));
        updateMessageText(message, tag, path);
        iigLog('INFO', `Generated image for tag ${index}`);
        toastr.success(`Картинка ${index + 1}/${totalTags} готова`, 'Генерация картинок', { timeOut: 2000 });
    } catch (error) {
        iigLog('ERROR', `Generation failed for tag ${index}:`, error.message);
        loading.replaceWith(createErrorPlaceholder(tagId, error.message, tag));
        if (tag.isNewFormat) {
            const errTag = tag.fullMatch.replace(/src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${ERROR_IMAGE_PATH}"`);
            message.mes = message.mes.replace(tag.fullMatch, errTag);
        } else {
            message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
        }
        toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
    }
}

// ─── Main processing ─────────────────────────────────────────────────────────

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) { iigLog('WARN', `Message ${messageId} already processing`); return; }

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length === 0) return;

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    // ── Manual mode ──
    if (settings.generationMode === 'manual') {
        iigLog('INFO', `Manual mode — ${tags.length} placeholder(s)`);
        tags.forEach((tag, i) => {
            const tagId = `iig-manual-${messageId}-${i}`;
            const t = findTargetElement(mesTextEl, tag, tagId);
            if (t) t.replaceWith(createManualPlaceholder(tagId, tag, i, tags.length));
        });
        return;
    }

    // ── Confirm mode ──
    if (settings.generationMode === 'confirm') {
        iigLog('INFO', `Confirm mode — ${tags.length} confirmation placeholder(s)`);
        tags.forEach((tag, i) => {
            const tagId = `iig-confirm-${messageId}-${i}`;
            const t = findTargetElement(mesTextEl, tag, tagId);
            if (!t) return;
            const placeholder = createConfirmPlaceholder(tagId, tag, i, tags.length, async (shouldGenerate) => {
                if (!shouldGenerate) {
                    placeholder.replaceWith(createManualPlaceholder(tagId, tag, i, tags.length));
                    iigLog('INFO', `User skipped tag ${i}`);
                    return;
                }
                iigLog('INFO', `User confirmed tag ${i}`);
                processingMessages.add(messageId);
                try {
                    await generateSingleTag(tag, i, tags.length, mesTextEl, message, `iig-confirmed-${messageId}`);
                    await context.saveChat();
                } finally {
                    processingMessages.delete(messageId);
                }
            });
            t.replaceWith(placeholder);
        });
        return;
    }

    // ── Auto mode ──
    processingMessages.add(messageId);
    iigLog('INFO', `Auto mode — generating ${tags.length} image(s)`);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    try {
        await processInBatches(tags, (tag, i) => generateSingleTag(tag, i, tags.length, mesTextEl, message, `iig-${messageId}`), settings.concurrency);
    } finally {
        processingMessages.delete(messageId);
        iigLog('INFO', `Finished processing message ${messageId}`);
    }

    await context.saveChat();
    if (typeof context.messageFormatting === 'function') {
        mesTextEl.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
    }
}

// ─── Regenerate ──────────────────────────────────────────────────────────────

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено', 'Генерация картинок'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации', 'Генерация картинок'); return; }

    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');

    processingMessages.add(messageId);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const tagId = `iig-regen-${messageId}-${i}`;
        try {
            const existingImg = mesTextEl.querySelector('img[data-iig-instruction]');
            if (!existingImg) continue;
            const instr = existingImg.getAttribute('data-iig-instruction');

            const loading = createLoadingPlaceholder(tagId, i, tags.length);
            existingImg.replaceWith(loading);
            const statusEl = loading.querySelector('.iig-status');

            const dataUrl = await generateImageWithRetry(
                tag.prompt, tag.style,
                (s) => { statusEl.textContent = `Картинка ${i + 1}/${tags.length}: ${s}`; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, tagInfo: tag }
            );
            statusEl.textContent = `Картинка ${i + 1}/${tags.length}: Сохранение...`;
            const path = await saveImageToFile(dataUrl);

            if (settings.enableCache) imageCache.set(getCacheKey(tag.prompt, tag.style, tag.aspectRatio, tag.imageSize), path);

            const img = createGeneratedImage(path, tag);
            if (instr) img.setAttribute('data-iig-instruction', instr);
            loading.replaceWith(img);
            updateMessageText(message, tag, path);
            toastr.success(`Картинка ${i + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Regen failed for tag ${i}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }

    processingMessages.delete(messageId);
    await context.saveChat();
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}

// ─── Message menu button ─────────────────────────────────────────────────────

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extra = messageElement.querySelector('.extraMesButtons');
    if (!extra) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extra.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat?.length) return;
    let count = 0;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mid = el.getAttribute('mesid');
        if (mid === null) continue;
        const id = parseInt(mid, 10);
        const msg = ctx.chat[id];
        if (msg && !msg.is_user) { addRegenerateButton(el, id); count++; }
    }
    iigLog('INFO', `Added regenerate buttons to ${count} messages`);
}

// ─── Event handler ───────────────────────────────────────────────────────────

async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);
    const settings = getSettings();
    if (!settings.enabled) return;

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    addRegenerateButton(messageElement, messageId);

    // Prevent re-processing already checked messages
    if (checkedMessages.has(messageId)) {
        iigLog('INFO', `Message ${messageId} already checked, skipping`);
        return;
    }
    checkedMessages.add(messageId);

    // During initial load, only process the very last (newest) message
    if (!initialLoadComplete) {
        const lastId = SillyTavern.getContext().chat.length - 1;
        if (messageId !== lastId) {
            iigLog('INFO', `Skipping message ${messageId} during initial load (not last)`);
            return;
        }
    }

    await processMessageTags(messageId);
}

// ─── Settings UI ─────────────────────────────────────────────────────────────

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) { console.error('[IIG] Settings container not found'); return; }

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Enable -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    <!-- Generation Mode -->
                    <div class="flex-row">
                        <label for="iig_generation_mode">Режим генерации</label>
                        <select id="iig_generation_mode" class="flex1">
                            <option value="auto" ${settings.generationMode === 'auto' ? 'selected' : ''}>Автоматически</option>
                            <option value="confirm" ${settings.generationMode === 'confirm' ? 'selected' : ''}>С подтверждением</option>
                            <option value="manual" ${settings.generationMode === 'manual' ? 'selected' : ''}>Только вручную</option>
                        </select>
                    </div>
                    <p class="hint" id="iig_mode_hint"></p>

                    <hr>

                    <h4>Настройки API</h4>

                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini (nano-banana)</option>
                            <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera / Grok</option>
                        </select>
                    </div>

                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com">
                    </div>

                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div>
                    </div>
                    <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Для Naistera: вставьте токен из Telegram бота.</p>

                    <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
                    </div>

                    <hr>

                    <h4>Параметры генерации</h4>

                    <div class="flex-row">
                        <label for="iig_concurrency">Параллельных генераций</label>
                        <input type="number" id="iig_concurrency" class="text_pole flex1" value="${settings.concurrency}" min="1" max="4">
                    </div>
                    <p class="hint">1 = последовательно (безопаснее для rate-limits).</p>

                    <!-- OpenAI -->
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
                        <select id="iig_quality" class="flex1">
                            <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Standard</option>
                            <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                        </select>
                    </div>

                    <!-- Naistera -->
                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                        <label for="iig_naistera_aspect_ratio">Соотношение сторон</label>
                        <select id="iig_naistera_aspect_ratio" class="flex1">
                            <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                            <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                            <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                        </select>
                    </div>
                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                        <label for="iig_naistera_preset">Пресет</label>
                        <select id="iig_naistera_preset" class="flex1">
                            <option value="" ${!settings.naisteraPreset ? 'selected' : ''}>без пресета</option>
                            <option value="digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>digital</option>
                            <option value="realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>realism</option>
                        </select>
                    </div>

                    <!-- Naistera refs -->
                    <div class="iig-naistera-refs ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_refs_section">
                        <h4>Референсы (Naistera)</h4>
                        <div class="flex-row">
                            <label for="iig_naistera_reference_mode">Режим</label>
                            <select id="iig_naistera_reference_mode" class="flex1">
                                <option value="always" ${settings.naisteraReferenceMode === 'always' ? 'selected' : ''}>Всегда</option>
                                <option value="tag_controls" ${settings.naisteraReferenceMode === 'tag_controls' ? 'selected' : ''}>Тег решает</option>
                                <option value="never" ${settings.naisteraReferenceMode === 'never' ? 'selected' : ''}>Никогда</option>
                            </select>
                        </div>
                        <p class="hint">«Тег решает» — ИИ указывает "references":["char"] когда нужно.</p>
                        <label class="checkbox_label"><input type="checkbox" id="iig_naistera_send_char_avatar" ${settings.naisteraSendCharAvatar ? 'checked' : ''}><span>Аватар {{char}}</span></label>
                        <label class="checkbox_label"><input type="checkbox" id="iig_naistera_send_user_avatar" ${settings.naisteraSendUserAvatar ? 'checked' : ''}><span>Аватар {{user}}</span></label>
                        <div id="iig_naistera_user_avatar_row" class="flex-row ${!settings.naisteraSendUserAvatar ? 'iig-hidden' : ''}" style="margin-top:5px;">
                            <label for="iig_naistera_user_avatar_file">Аватар</label>
                            <select id="iig_naistera_user_avatar_file" class="flex1">
                                <option value="">-- Не выбран --</option>
                                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                            </select>
                            <div id="iig_naistera_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
                        </div>
                    </div>

                    <hr>

                    <!-- Nano-Banana section -->
                    <div id="iig_avatar_section" class="iig-avatar-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>
                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                ${VALID_ASPECT_RATIOS.map(r => `<option value="${r}" ${settings.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}
                            </select>
                        </div>
                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                ${VALID_IMAGE_SIZES.map(s => `<option value="${s}" ${settings.imageSize === s ? 'selected' : ''}>${s}</option>`).join('')}
                            </select>
                        </div>
                        <hr>
                        <h5>Референсы</h5>
                        <div class="flex-row">
                            <label for="iig_reference_mode">Режим</label>
                            <select id="iig_reference_mode" class="flex1">
                                <option value="always" ${settings.referenceMode === 'always' ? 'selected' : ''}>Всегда</option>
                                <option value="tag_controls" ${settings.referenceMode === 'tag_controls' ? 'selected' : ''}>Тег решает</option>
                                <option value="never" ${settings.referenceMode === 'never' ? 'selected' : ''}>Никогда</option>
                            </select>
                        </div>
                        <p class="hint">«Тег решает» — предотвращает наложение внешности на чужих персонажей.</p>
                        <label class="checkbox_label"><input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}><span>Аватар {{char}}</span></label>
                        <label class="checkbox_label"><input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}><span>Аватар {{user}}</span></label>
                        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top:5px;">
                            <label for="iig_user_avatar_file">Аватар</label>
                            <select id="iig_user_avatar_file" class="flex1">
                                <option value="">-- Не выбран --</option>
                                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                            </select>
                            <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
                        </div>
                    </div>

                    <hr>

                    <h4>Обработка ошибок</h4>
                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
                    </div>
                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>
                    <div class="flex-row">
                        <label for="iig_generation_timeout">Таймаут (мс)</label>
                        <input type="number" id="iig_generation_timeout" class="text_pole flex1" value="${settings.generationTimeout}" min="30000" max="600000" step="10000">
                    </div>

                    <hr>

                    <h4>Кэш</h4>
                    <label class="checkbox_label"><input type="checkbox" id="iig_enable_cache" ${settings.enableCache ? 'checked' : ''}><span>Кэшировать результаты</span></label>
                    <div class="flex-row">
                        <div id="iig_clear_cache" class="menu_button" style="width:100%;"><i class="fa-solid fa-trash"></i> Очистить (<span id="iig_cache_size">${imageCache.size}</span>)</div>
                    </div>

                    <hr>

                    <h4>Отладка</h4>
                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width:100%;"><i class="fa-solid fa-download"></i> Экспорт логов</div>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();
}

// ─── Settings event binding ──────────────────────────────────────────────────

function bindSettingsEvents() {
    const settings = getSettings();

    const modeHints = {
        auto: 'Картинки генерируются автоматически при появлении сообщения.',
        confirm: 'Для каждой картинки показывается превью и кнопка подтверждения.',
        manual: 'Картинки не генерируются автоматически. Используйте кнопку 🖼️ в меню сообщения.'
    };

    const updateModeHint = () => {
        const h = document.getElementById('iig_mode_hint');
        if (h) h.textContent = modeHints[settings.generationMode] || '';
    };
    updateModeHint();

    const updateVisibility = () => {
        const isN = settings.apiType === 'naistera';
        const isG = settings.apiType === 'gemini';
        const isO = settings.apiType === 'openai';
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isN);
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isO);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isO);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_naistera_refs_section')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_naistera_user_avatar_row')?.classList.toggle('iig-hidden', !(isN && settings.naisteraSendUserAvatar));
        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isN);
        document.getElementById('iig_avatar_section')?.classList.toggle('hidden', !isG);
    };

    const bind = (id, event, handler) => document.getElementById(id)?.addEventListener(event, handler);

    bind('iig_enabled', 'change', (e) => { settings.enabled = e.target.checked; saveSettings(); });
    bind('iig_generation_mode', 'change', (e) => { settings.generationMode = e.target.value; saveSettings(); updateModeHint(); });
    bind('iig_api_type', 'change', (e) => { settings.apiType = e.target.value; saveSettings(); updateVisibility(); });
    bind('iig_endpoint', 'input', (e) => { settings.endpoint = e.target.value; saveSettings(); });
    bind('iig_api_key', 'input', (e) => { settings.apiKey = e.target.value; saveSettings(); });

    bind('iig_key_toggle', 'click', () => {
        const inp = document.getElementById('iig_api_key');
        const ico = document.querySelector('#iig_key_toggle i');
        if (inp.type === 'password') { inp.type = 'text'; ico.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { inp.type = 'password'; ico.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    bind('iig_model', 'change', (e) => {
        settings.model = e.target.value; saveSettings();
        if (isGeminiModel(e.target.value)) { document.getElementById('iig_api_type').value = 'gemini'; settings.apiType = 'gemini'; updateVisibility(); }
    });

    bind('iig_refresh_models', 'click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const sel = document.getElementById('iig_model');
            sel.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) { const o = document.createElement('option'); o.value = m; o.textContent = m; o.selected = m === settings.model; sel.appendChild(o); }
            toastr.success(`Моделей: ${models.length}`, 'Генерация картинок');
        } catch { toastr.error('Ошибка загрузки', 'Генерация картинок'); }
        finally { btn.classList.remove('loading'); }
    });

    bind('iig_size', 'change', (e) => { settings.size = e.target.value; saveSettings(); });
    bind('iig_quality', 'change', (e) => { settings.quality = e.target.value; saveSettings(); });
    bind('iig_concurrency', 'input', (e) => { settings.concurrency = Math.max(1, Math.min(4, parseInt(e.target.value) || 1)); saveSettings(); });
    bind('iig_aspect_ratio', 'change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    bind('iig_image_size', 'change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    bind('iig_reference_mode', 'change', (e) => { settings.referenceMode = e.target.value; saveSettings(); });
    bind('iig_naistera_aspect_ratio', 'change', (e) => { settings.naisteraAspectRatio = e.target.value; saveSettings(); });
    bind('iig_naistera_preset', 'change', (e) => { settings.naisteraPreset = e.target.value; saveSettings(); });
    bind('iig_naistera_reference_mode', 'change', (e) => { settings.naisteraReferenceMode = e.target.value; saveSettings(); });
    bind('iig_naistera_send_char_avatar', 'change', (e) => { settings.naisteraSendCharAvatar = e.target.checked; saveSettings(); });
    bind('iig_naistera_send_user_avatar', 'change', (e) => { settings.naisteraSendUserAvatar = e.target.checked; saveSettings(); updateVisibility(); });
    bind('iig_naistera_user_avatar_file', 'change', (e) => { settings.userAvatarFile = e.target.value; saveSettings(); });

    bind('iig_naistera_refresh_avatars', 'click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const avatars = await fetchUserAvatars();
            const sel = document.getElementById('iig_naistera_user_avatar_file');
            sel.innerHTML = '<option value="">-- Не выбран --</option>';
            for (const a of avatars) { const o = document.createElement('option'); o.value = a; o.textContent = a; o.selected = a === settings.userAvatarFile; sel.appendChild(o); }
            toastr.success(`Аватаров: ${avatars.length}`, 'Генерация картинок');
        } catch { toastr.error('Ошибка', 'Генерация картинок'); }
        finally { btn.classList.remove('loading'); }
    });

    bind('iig_send_char_avatar', 'change', (e) => { settings.sendCharAvatar = e.target.checked; saveSettings(); });
    bind('iig_send_user_avatar', 'change', (e) => {
        settings.sendUserAvatar = e.target.checked; saveSettings();
        document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked);
    });
    bind('iig_user_avatar_file', 'change', (e) => { settings.userAvatarFile = e.target.value; saveSettings(); });

    bind('iig_refresh_avatars', 'click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const avatars = await fetchUserAvatars();
            const sel = document.getElementById('iig_user_avatar_file');
            sel.innerHTML = '<option value="">-- Не выбран --</option>';
            for (const a of avatars) { const o = document.createElement('option'); o.value = a; o.textContent = a; o.selected = a === settings.userAvatarFile; sel.appendChild(o); }
            toastr.success(`Аватаров: ${avatars.length}`, 'Генерация картинок');
        } catch { toastr.error('Ошибка', 'Генерация картинок'); }
        finally { btn.classList.remove('loading'); }
    });

    bind('iig_max_retries', 'input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    bind('iig_retry_delay', 'input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    bind('iig_generation_timeout', 'input', (e) => { settings.generationTimeout = parseInt(e.target.value) || 120000; saveSettings(); });
    bind('iig_enable_cache', 'change', (e) => { settings.enableCache = e.target.checked; saveSettings(); });
    bind('iig_clear_cache', 'click', () => {
        const n = imageCache.size; imageCache.clear();
        document.getElementById('iig_cache_size').textContent = '0';
        toastr.success(`Кэш очищен (${n})`, 'Генерация картинок');
    });
    bind('iig_export_logs', 'click', exportLogs);

    updateVisibility();
}

// ─── Init ────────────────────────────────────────────────────────────────────

(function init() {
    const context = SillyTavern.getContext();

    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        setTimeout(() => { initialLoadComplete = true; iigLog('INFO', 'Initial load complete'); }, 2000);
        console.log('[IIG] Inline Image Generation v2.1 loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED');
        checkedMessages.clear();
        initialLoadComplete = false;
        setTimeout(() => addButtonsToExistingMessages(), 100);
        setTimeout(() => { initialLoadComplete = true; iigLog('INFO', 'Chat load complete'); }, 2000);
    });

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        console.log('[IIG] CHARACTER_MESSAGE_RENDERED:', messageId);
        await onMessageReceived(messageId);
    });

    console.log('[IIG] Inline Image Generation v2.1 initialized');
})();
