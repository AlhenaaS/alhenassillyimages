/**
 * Inline Image Generation Extension for SillyTavern
 * 
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible, Gemini-compatible (nano-banana), and Naistera endpoints.
 * 
 * v2.0 - Smart references, generation queue, timeouts, caching, lightbox
 */

const MODULE_NAME = 'inline_image_gen';

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

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

// Default settings
const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai', // 'openai' | 'gemini' | 'naistera'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    generationTimeout: 120000, // 2 minutes
    concurrency: 1, // How many images to generate simultaneously
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
    naisteraReferenceMode: 'tag_controls', // 'always' | 'tag_controls' | 'never'
});

// Image model detection keywords
const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

// Video model keywords to exclude
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

// Valid aspect ratios for Gemini/nano-banana
const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
// Valid image sizes for Gemini/nano-banana
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Check if model ID is an image generation model
 */
function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    
    if (mid.includes('vision') && mid.includes('preview')) return false;
    
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }
    
    return false;
}

/**
 * Check if model is Gemini/nano-banana type
 */
function isGeminiModel(modelId) {
    const mid = modelId.toLowerCase();
    return mid.includes('nano-banana');
}

/**
 * Get extension settings
 */
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

/**
 * Save settings
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

/**
 * Get current character name
 */
function getCharacterName() {
    const context = SillyTavern.getContext();
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        return context.characters[context.characterId].name || 'Character';
    }
    return 'Character';
}

/**
 * Get current user name
 */
function getUserName() {
    const context = SillyTavern.getContext();
    return context.name1 || 'User';
}

/**
 * Generate a cache key for an image generation request
 */
function getCacheKey(prompt, style, aspectRatio, imageSize) {
    return `${style || ''}||${aspectRatio || ''}||${imageSize || ''}||${prompt}`;
}

/**
 * Sanitize prompt text - remove potential HTML/script injection
 */
function sanitizePrompt(text) {
    if (!text) return '';
    return text
        .replace(/<[^>]*>/g, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .trim();
}

/**
 * Sanitize text for safe HTML display
 */
function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Таймаут запроса (${timeoutMs / 1000}с)`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Fetch models list from endpoint
 */
async function fetchModels() {
    const settings = getSettings();
    
    if (!settings.endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }
    
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    
    try {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
            }
        }, 15000);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const models = data.data || [];
        
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

/**
 * Fetch list of user avatars from /User Avatars/ directory
 */
async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

/**
 * Convert image URL to base64
 */
async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

/**
 * Convert image URL to data URL (data:image/...;base64,...)
 */
async function imageUrlToDataUrl(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();

        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to data URL:', error);
        return null;
    }
}

/**
 * Save base64 image to file via SillyTavern API
 */
async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid data URL format');
    }
    
    const format = match[1];
    const base64Data = match[2];
    
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    
    const result = await response.json();
    iigLog('INFO', 'Image saved to:', result.path);
    return result.path;
}

/**
 * Get character avatar as base64
 */
async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        
        if (context.characterId === undefined || context.characterId === null) {
            return null;
        }
        
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) {
                return await imageUrlToBase64(avatarUrl);
            }
        }
        
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            return await imageUrlToBase64(avatarUrl);
        }
        
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

/**
 * Get character avatar as data URL
 */
async function getCharacterAvatarDataUrl() {
    try {
        const context = SillyTavern.getContext();

        if (context.characterId === undefined || context.characterId === null) {
            return null;
        }

        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) {
                return await imageUrlToDataUrl(avatarUrl);
            }
        }

        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            return await imageUrlToDataUrl(avatarUrl);
        }

        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar data URL:', error);
        return null;
    }
}

/**
 * Get user avatar as base64 (full resolution)
 */
async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        
        if (!settings.userAvatarFile) {
            return null;
        }
        
        const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
        return await imageUrlToBase64(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

/**
 * Get user avatar as data URL
 */
async function getUserAvatarDataUrl() {
    try {
        const settings = getSettings();
        if (!settings.userAvatarFile) {
            return null;
        }
        const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
        return await imageUrlToDataUrl(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar data URL:', error);
        return null;
    }
}

/**
 * Build smart reference instruction based on which references are included and their roles
 */
function buildReferenceInstruction(referenceImages, tagInfo = {}) {
    if (referenceImages.length === 0) return '';
    
    const parts = [];
    
    for (const ref of referenceImages) {
        if (ref.role === 'char') {
            const charName = getCharacterName();
            parts.push(
                `One reference image shows the character "${charName}". ` +
                `Use it ONLY to match this character's appearance (face, hair, body, clothing) ` +
                `IF "${charName}" appears in the scene. Do NOT apply this appearance to other characters.`
            );
        } else if (ref.role === 'user') {
            const userName = getUserName();
            parts.push(
                `One reference image shows the user "${userName}". ` +
                `Use it ONLY to match the user's appearance IF they appear in the scene. ` +
                `Do NOT apply this appearance to other characters.`
            );
        }
    }
    
    // If the tag provided its own hint, add it
    if (tagInfo.reference_hint) {
        parts.push(tagInfo.reference_hint);
    }
    
    return `[Reference guidance: ${parts.join(' ')} IMPORTANT: Characters NOT shown in reference images should have their OWN unique appearances as described in the prompt. Never blend reference appearances onto unrelated characters.]`;
}

/**
 * Collect reference images based on settings, reference mode, and tag request
 * @param {object} tag - Parsed tag with optional references field
 * @param {string} mode - 'gemini' or 'naistera'
 * @returns {Array} Array of {image, role} objects (or data URLs for naistera)
 */
async function collectReferences(tag, mode = 'gemini') {
    const settings = getSettings();
    const referenceImages = [];
    
    // Determine reference mode
    const refMode = mode === 'naistera' ? settings.naisteraReferenceMode : settings.referenceMode;
    
    // If mode is 'never', return empty
    if (refMode === 'never') {
        iigLog('INFO', 'Reference mode is "never", skipping all references');
        return referenceImages;
    }
    
    // Determine which references to include
    let sendChar = false;
    let sendUser = false;
    
    if (refMode === 'tag_controls') {
        // Tag decides — check tag.references array
        const refs = tag.references || [];
        if (refs.length > 0) {
            sendChar = refs.includes('char');
            sendUser = refs.includes('user');
            iigLog('INFO', `Tag requested references: ${refs.join(', ')}`);
        } else {
            // Tag didn't specify — don't send anything
            iigLog('INFO', 'Tag has no "references" field, skipping references (tag_controls mode)');
            return referenceImages;
        }
    } else if (refMode === 'always') {
        // Always send what's enabled in settings
        if (mode === 'naistera') {
            sendChar = settings.naisteraSendCharAvatar;
            sendUser = settings.naisteraSendUserAvatar;
        } else {
            sendChar = settings.sendCharAvatar;
            sendUser = settings.sendUserAvatar;
        }
    }
    
    // Collect based on mode
    if (mode === 'naistera') {
        // Naistera uses data URLs
        if (sendChar) {
            const d = await getCharacterAvatarDataUrl();
            if (d) {
                referenceImages.push({ image: d, role: 'char' });
                iigLog('INFO', 'Added char avatar reference (naistera)');
            }
        }
        if (sendUser) {
            const d = await getUserAvatarDataUrl();
            if (d) {
                referenceImages.push({ image: d, role: 'user' });
                iigLog('INFO', 'Added user avatar reference (naistera)');
            }
        }
    } else {
        // Gemini/OpenAI use base64
        if (sendChar) {
            const charAvatar = await getCharacterAvatarBase64();
            if (charAvatar) {
                referenceImages.push({ image: charAvatar, role: 'char' });
                iigLog('INFO', 'Added char avatar reference');
            }
        }
        if (sendUser) {
            const userAvatar = await getUserAvatarBase64();
            if (userAvatar) {
                referenceImages.push({ image: userAvatar, role: 'user' });
                iigLog('INFO', 'Added user avatar reference');
            }
        }
    }
    
    iigLog('INFO', `Collected ${referenceImages.length} reference(s) for mode=${mode}, refMode=${refMode}`);
    return referenceImages;
}

/**
 * Generate image via OpenAI-compatible endpoint
 */
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1792x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1792';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }
    
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size: size,
        quality: options.quality || settings.quality,
        response_format: 'b64_json'
    };
    
    // Add reference image if supported
    if (referenceImages.length > 0) {
        const firstRef = referenceImages[0];
        const imgData = typeof firstRef === 'string' ? firstRef : firstRef.image;
        body.image = `data:image/png;base64,${imgData}`;
    }
    
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }, settings.generationTimeout);
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }
    
    const imageObj = dataList[0];
    
    if (imageObj.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    
    return imageObj.url;
}

/**
 * Generate image via Gemini-compatible endpoint (nano-banana)
 */
async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}", falling back to default`);
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }
    
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN', `Invalid image_size "${imageSize}", falling back to default`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }
    
    iigLog('INFO', `Gemini: aspect=${aspectRatio}, size=${imageSize}, refs=${referenceImages.length}`);
    
    const parts = [];
    
    // Add reference images first (up to 4)
    for (const ref of referenceImages.slice(0, 4)) {
        const imgData = typeof ref === 'string' ? ref : ref.image;
        parts.push({
            inlineData: {
                mimeType: 'image/png',
                data: imgData
            }
        });
    }
    
    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    // Smart reference instruction
    if (referenceImages.length > 0) {
        const refInstruction = buildReferenceInstruction(referenceImages, options.tagInfo || {});
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }
    
    parts.push({ text: fullPrompt });
    
    iigLog('INFO', `Gemini request: ${referenceImages.length} ref(s), prompt ${fullPrompt.length} chars`);
    
    const body = {
        contents: [{
            role: 'user',
            parts: parts
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: aspectRatio,
                imageSize: imageSize
            }
        }
    };
    
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }, settings.generationTimeout);
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        throw new Error('No candidates in response');
    }
    
    const responseParts = candidates[0].content?.parts || [];
    
    for (const part of responseParts) {
        if (part.inlineData) {
            return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.inline_data) {
            return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
    }
    
    throw new Error('No image found in Gemini response');
}

/**
 * Generate image via Naistera custom endpoint
 */
async function generateImageNaistera(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const endpoint = settings.endpoint.replace(/\/$/, '');
    const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;

    const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
    const preset = options.preset || settings.naisteraPreset || null;

    const body = {
        prompt: fullPrompt,
        aspect_ratio: aspectRatio,
    };
    if (preset) body.preset = preset;
    
    // Extract data URLs from reference objects
    if (referenceImages.length > 0) {
        body.reference_images = referenceImages.slice(0, 4).map(ref => 
            typeof ref === 'string' ? ref : ref.image
        );
    }

    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }, settings.generationTimeout);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }

    const result = await response.json();
    if (!result?.data_url) {
        throw new Error('No data_url in response');
    }

    return result.data_url;
}

/**
 * Validate settings before generation
 */
function validateSettings() {
    const settings = getSettings();
    const errors = [];
    
    if (!settings.endpoint) {
        errors.push('URL эндпоинта не настроен');
    }
    if (!settings.apiKey) {
        errors.push('API ключ не настроен');
    }
    if (settings.apiType !== 'naistera' && !settings.model) {
        errors.push('Модель не выбрана');
    }
    
    if (errors.length > 0) {
        throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
    }
}

/**
 * Generate image with retry logic
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;
    
    // Collect references using smart mode
    const tag = options.tagInfo || {};
    let referenceImages = [];
    
    if (settings.apiType === 'naistera') {
        referenceImages = await collectReferences(tag, 'naistera');
    } else if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
        referenceImages = await collectReferences(tag, 'gemini');
    } else {
        // OpenAI - also supports references in some models
        referenceImages = await collectReferences(tag, 'gemini'); // Same base64 format
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            
            if (settings.apiType === 'naistera') {
                return await generateImageNaistera(prompt, style, referenceImages, {
                    ...options,
                });
            } else if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, referenceImages, {
                    ...options,
                    tagInfo: tag,
                });
            } else {
                return await generateImageOpenAI(prompt, style, referenceImages, options);
            }
        } catch (error) {
            lastError = error;
            iigLog('ERROR', `Generation attempt ${attempt + 1} failed:`, error.message);
            
            const isRetryable = error.message?.includes('429') ||
                               error.message?.includes('503') ||
                               error.message?.includes('502') ||
                               error.message?.includes('504') ||
                               error.message?.includes('timeout') ||
                               error.message?.includes('Таймаут') ||
                               error.message?.includes('network');
            
            if (!isRetryable || attempt === maxRetries) {
                break;
            }
            
            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

/**
 * Check if a file exists on the server
 */
async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

/**
 * Parse image generation tags from message text
 */
async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];
    
    // === NEW FORMAT: <img data-iig-instruction="{...}" src="[IMG:GEN]"> ===
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) {
            searchPos = markerPos + 1;
            continue;
        }
        
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find matching closing brace
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        imgEnd++;
        
        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';
        
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        
        if (hasErrorImage && !forceAll) {
            iigLog('INFO', `Skipping error image: ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (forceAll) {
            needsGeneration = true;
        } else if (hasMarker || !srcValue) {
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                iigLog('WARN', `File does not exist (hallucination?): ${srcValue}`);
                needsGeneration = true;
            }
        } else if (hasPath) {
            searchPos = imgEnd;
            continue;
        }
        
        if (!needsGeneration) {
            searchPos = imgEnd;
            continue;
        }
        
        try {
            let normalizedJson = instructionJson
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&#39;/g, "'")
                .replace(/&#34;/g, '"')
                .replace(/&amp;/g, '&');
            
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: fullImgTag,
                index: imgStart,
                style: sanitizePrompt(data.style || ''),
                prompt: sanitizePrompt(data.prompt || ''),
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                references: data.references || [], // NEW: ["char"], ["user"], ["char","user"], []
                reference_hint: sanitizePrompt(data.reference_hint || ''), // NEW
                isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });
            
            iigLog('INFO', `Found NEW tag: prompt="${data.prompt?.substring(0, 50)}", refs=${JSON.stringify(data.references || [])}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }
        
        searchPos = imgEnd;
    }
    
    // === LEGACY FORMAT: [IMG:GEN:{...}] ===
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        
        const jsonStart = markerIndex + marker.length;
        
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchStart = jsonStart;
            continue;
        }
        
        const jsonStr = text.substring(jsonStart, jsonEnd);
        
        const afterJson = text.substring(jsonEnd);
        if (!afterJson.startsWith(']')) {
            searchStart = jsonEnd;
            continue;
        }
        
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        
        try {
            const normalizedJson = jsonStr.replace(/'/g, '"');
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: tagOnly,
                index: markerIndex,
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
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy JSON: ${jsonStr.substring(0, 100)}`, e.message);
        }
        
        searchStart = jsonEnd + 1;
    }
    
    return tags;
}

/**
 * Create loading placeholder element
 */
function createLoadingPlaceholder(tagId, tagIndex, totalTags) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">Картинка ${(tagIndex || 0) + 1}/${totalTags || '?'}: Генерация...</div>
    `;
    return placeholder;
}

// Error image path
const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

/**
 * Create error placeholder element
 */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
        }
    }
    
    return img;
}

/**
 * Create lightbox for viewing generated images fullscreen
 */
function showLightbox(imageSrc, prompt, style) {
    // Remove existing lightbox if any
    const existing = document.querySelector('.iig-lightbox');
    if (existing) existing.remove();
    
    const lightbox = document.createElement('div');
    lightbox.className = 'iig-lightbox';
    lightbox.innerHTML = `
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
    
    // Close on click overlay or close button
    lightbox.querySelector('.iig-lightbox-overlay').addEventListener('click', () => lightbox.remove());
    lightbox.querySelector('.iig-lightbox-close').addEventListener('click', () => lightbox.remove());
    
    // Close on Escape
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            lightbox.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
    
    document.body.appendChild(lightbox);
}

/**
 * Process tags in batches with configurable concurrency
 */
async function processInBatches(items, processFn, concurrency = 1) {
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        await Promise.all(batch.map((item, j) => processFn(item, i + j)));
    }
}

/**
 * Process image tags in a message
 */
async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    if (!settings.enabled) return;
    
    if (processingMessages.has(messageId)) {
        iigLog('WARN', `Message ${messageId} already processing, skipping`);
        return;
    }
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length === 0) return;
    
    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        iigLog('ERROR', 'Message element not found for ID:', messageId);
        processingMessages.delete(messageId);
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    const totalTags = tags.length;
    
    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        
        iigLog('INFO', `Processing tag ${index}: ${tag.prompt.substring(0, 50)}`);
        
        // Check cache first
        if (settings.enableCache) {
            const cacheKey = getCacheKey(tag.prompt, tag.style, tag.aspectRatio, tag.imageSize);
            if (imageCache.has(cacheKey)) {
                const cachedPath = imageCache.get(cacheKey);
                const exists = await checkFileExists(cachedPath);
                if (exists) {
                    iigLog('INFO', `Cache hit for tag ${index}: ${cachedPath}`);
                    
                    // Find and replace the target element with cached image
                    const targetElement = findTargetElement(mesTextEl, tag, tagId);
                    if (targetElement) {
                        const img = createGeneratedImage(cachedPath, tag);
                        targetElement.replaceWith(img);
                        
                        // Update message.mes
                        updateMessageText(message, tag, cachedPath);
                        
                        toastr.success(`Картинка ${index + 1}/${totalTags} (кэш)`, 'Генерация картинок', { timeOut: 2000 });
                        return;
                    }
                } else {
                    imageCache.delete(cacheKey);
                }
            }
        }
        
        // Create loading placeholder
        const loadingPlaceholder = createLoadingPlaceholder(tagId, index, totalTags);
        const targetElement = findTargetElement(mesTextEl, tag, tagId);
        
        if (targetElement) {
            const parent = targetElement.parentElement;
            if (parent) {
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'flex' || parentStyle.display === 'grid') {
                    loadingPlaceholder.style.alignSelf = 'center';
                }
            }
            targetElement.replaceWith(loadingPlaceholder);
        } else {
            iigLog('WARN', `Could not find target element, appending as fallback`);
            mesTextEl.appendChild(loadingPlaceholder);
        }
        
        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        
        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = `Картинка ${index + 1}/${totalTags}: ${status}`; },
                {
                    aspectRatio: tag.aspectRatio,
                    imageSize: tag.imageSize,
                    quality: tag.quality,
                    preset: tag.preset,
                    tagInfo: tag // Pass full tag for smart references
                }
            );
            
            statusEl.textContent = `Картинка ${index + 1}/${totalTags}: Сохранение...`;
            const imagePath = await saveImageToFile(dataUrl);
            
            // Cache the result
            if (settings.enableCache) {
                const cacheKey = getCacheKey(tag.prompt, tag.style, tag.aspectRatio, tag.imageSize);
                imageCache.set(cacheKey, imagePath);
            }
            
            const img = createGeneratedImage(imagePath, tag);
            loadingPlaceholder.replaceWith(img);
            
            // Update message.mes
            updateMessageText(message, tag, imagePath);
            
            iigLog('INFO', `Successfully generated image for tag ${index}`);
            toastr.success(`Картинка ${index + 1}/${totalTags} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
            
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            
            // Mark as failed in message.mes
            if (tag.isNewFormat) {
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                message.mes = message.mes.replace(tag.fullMatch, errorMarker);
            }
            
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };
    
    try {
        await processInBatches(tags, processTag, settings.concurrency);
    } finally {
        processingMessages.delete(messageId);
        iigLog('INFO', `Finished processing message ${messageId}`);
    }
    
    await context.saveChat();
    
    if (typeof context.messageFormatting === 'function') {
        const formattedMessage = context.messageFormatting(
            message.mes,
            message.name,
            message.is_system,
            message.is_user,
            messageId
        );
        mesTextEl.innerHTML = formattedMessage;
    }
}

/**
 * Find the target DOM element for a tag
 */
function findTargetElement(mesTextEl, tag, tagId) {
    let targetElement = null;
    
    if (tag.isNewFormat) {
        const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
        const searchPrompt = tag.prompt.substring(0, 30);
        
        for (const img of allImgs) {
            const instruction = img.getAttribute('data-iig-instruction');
            const src = img.getAttribute('src') || '';
            
            if (instruction) {
                const decodedInstruction = instruction
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&#34;/g, '"')
                    .replace(/&amp;/g, '&');
                
                const normalizedSearchPrompt = searchPrompt
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&#34;/g, '"')
                    .replace(/&amp;/g, '&');
                
                if (decodedInstruction.includes(normalizedSearchPrompt)) {
                    targetElement = img;
                    break;
                }
                
                try {
                    const normalizedJson = decodedInstruction.replace(/'/g, '"');
                    const instructionData = JSON.parse(normalizedJson);
                    if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                        targetElement = img;
                        break;
                    }
                } catch (e) { /* continue */ }
                
                if (instruction.includes(searchPrompt)) {
                    targetElement = img;
                    break;
                }
            }
        }
        
        if (!targetElement) {
            for (const img of allImgs) {
                const src = img.getAttribute('src') || '';
                if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                    targetElement = img;
                    break;
                }
            }
        }
        
        if (!targetElement) {
            const allImgsInMes = mesTextEl.querySelectorAll('img');
            for (const img of allImgsInMes) {
                const src = img.getAttribute('src') || '';
                if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                    targetElement = img;
                    break;
                }
            }
        }
    } else {
        // Legacy format
        const tagEscaped = tag.fullMatch
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/"/g, '(?:"|&quot;)');
        const tagRegex = new RegExp(tagEscaped, 'g');
        
        const beforeReplace = mesTextEl.innerHTML;
        mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
            tagRegex,
            `<span data-iig-placeholder="${tagId}"></span>`
        );
        
        if (beforeReplace !== mesTextEl.innerHTML) {
            targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
        }
        
        if (!targetElement) {
            const allImgs = mesTextEl.querySelectorAll('img');
            for (const img of allImgs) {
                if (img.src && img.src.includes('[IMG:GEN:')) {
                    targetElement = img;
                    break;
                }
            }
        }
    }
    
    return targetElement;
}

/**
 * Create a generated image element with lightbox click handler
 */
function createGeneratedImage(imagePath, tag) {
    const img = document.createElement('img');
    img.className = 'iig-generated-image';
    img.src = imagePath;
    img.alt = tag.prompt;
    img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
    
    // Preserve instruction for future regenerations
    if (tag.isNewFormat) {
        const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
        }
    }
    
    // Lightbox on click
    img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showLightbox(imagePath, tag.prompt, tag.style);
    });
    img.style.cursor = 'pointer';
    
    return img;
}

/**
 * Update message.mes text after image generation
 */
function updateMessageText(message, tag, imagePath) {
    if (tag.isNewFormat) {
        const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
        message.mes = message.mes.replace(tag.fullMatch, updatedTag);
    } else {
        const completionMarker = `[IMG:✓:${imagePath}]`;
        message.mes = message.mes.replace(tag.fullMatch, completionMarker);
    }
}

/**
 * Regenerate all images in a message (user-triggered)
 */
async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error('Сообщение не найдено', 'Генерация картинок');
        return;
    }
    
    const tags = await parseImageTags(message.mes, { forceAll: true });
    
    if (tags.length === 0) {
        toastr.warning('Нет тегов для перегенерации', 'Генерация картинок');
        return;
    }
    
    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
    
    processingMessages.add(messageId);
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        processingMessages.delete(messageId);
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        
        try {
            const existingImg = mesTextEl.querySelector(`img[data-iig-instruction]`);
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                
                const loadingPlaceholder = createLoadingPlaceholder(tagId, index, tags.length);
                existingImg.replaceWith(loadingPlaceholder);
                
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                
                const dataUrl = await generateImageWithRetry(
                    tag.prompt,
                    tag.style,
                    (status) => { statusEl.textContent = `Картинка ${index + 1}/${tags.length}: ${status}`; },
                    {
                        aspectRatio: tag.aspectRatio,
                        imageSize: tag.imageSize,
                        quality: tag.quality,
                        preset: tag.preset,
                        tagInfo: tag
                    }
                );
                
                statusEl.textContent = `Картинка ${index + 1}/${tags.length}: Сохранение...`;
                const imagePath = await saveImageToFile(dataUrl);
                
                // Update cache
                if (settings.enableCache) {
                    const cacheKey = getCacheKey(tag.prompt, tag.style, tag.aspectRatio, tag.imageSize);
                    imageCache.set(cacheKey, imagePath);
                }
                
                const img = createGeneratedImage(imagePath, tag);
                if (instruction) {
                    img.setAttribute('data-iig-instruction', instruction);
                }
                loadingPlaceholder.replaceWith(img);
                
                updateMessageText(message, tag, imagePath);
                
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }
    
    processingMessages.delete(messageId);
    await context.saveChat();
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}

/**
 * Add regenerate button to message extra menu
 */
function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateMessageImages(messageId);
    });
    
    extraMesButtons.appendChild(btn);
}

/**
 * Add regenerate buttons to all existing AI messages in chat
 */
function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const messageElements = document.querySelectorAll('#chat .mes');
    let addedCount = 0;
    
    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        
        if (message && !message.is_user) {
            addRegenerateButton(messageElement, messageId);
            addedCount++;
        }
    }
    
    iigLog('INFO', `Added regenerate buttons to ${addedCount} existing messages`);
}

/**
 * Handle CHARACTER_MESSAGE_RENDERED event
 */
async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);
    
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    
    addRegenerateButton(messageElement, messageId);
    
    await processMessageTags(messageId);
}

/**
 * Create settings UI
 */
function createSettingsUI() {
    const settings = getSettings();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }
    
    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Вкл/Выкл -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>
                    
                    <hr>
                    
                    <h4>Настройки API</h4>
                    
                    <!-- Тип эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                            <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera/Grok (naistera.org)</option>
                        </select>
                    </div>
                    
                    <!-- URL эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1" 
                               value="${settings.endpoint}" 
                               placeholder="https://api.example.com">
                    </div>
                    
                    <!-- API ключ -->
                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" 
                               value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>
                    <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Для Naistera/Grok: вставьте токен из Telegram бота. Модель не требуется.</p>
                    
                    <!-- Модель -->
                    <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Параметры генерации</h4>
                    
                    <!-- Параллельность -->
                    <div class="flex-row">
                        <label for="iig_concurrency">Параллельных генераций</label>
                        <input type="number" id="iig_concurrency" class="text_pole flex1" 
                               value="${settings.concurrency}" min="1" max="4">
                    </div>
                    <p class="hint">Сколько картинок генерировать одновременно. 1 = последовательно (безопаснее).</p>
                    
                    <!-- Размер (OpenAI) -->
                    <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_size_row">
                        <label for="iig_size">Размер</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Квадрат)</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Альбомная)</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Портретная)</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Маленький)</option>
                        </select>
                    </div>
                    
                    <!-- Качество (OpenAI) -->
                    <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_quality_row">
                        <label for="iig_quality">Качество</label>
                        <select id="iig_quality" class="flex1">
                            <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                            <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                        </select>
                    </div>

                    <!-- Naistera params -->
                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                        <label for="iig_naistera_aspect_ratio">Соотношение сторон</label>
                        <select id="iig_naistera_aspect_ratio" class="flex1">
                            <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                            <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                            <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                        </select>
                    </div>
                    <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                        <label for="iig_naistera_preset">Пресеты</label>
                        <select id="iig_naistera_preset" class="flex1">
                            <option value="" ${!settings.naisteraPreset ? 'selected' : ''}>без пресета</option>
                            <option value="digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>digital</option>
                            <option value="realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>realism</option>
                        </select>
                    </div>

                    <!-- Naistera references -->
                    <div class="iig-naistera-refs ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_refs_section">
                        <h4>Референсы (Naistera)</h4>
                        
                        <div class="flex-row">
                            <label for="iig_naistera_reference_mode">Режим референсов</label>
                            <select id="iig_naistera_reference_mode" class="flex1">
                                <option value="always" ${settings.naisteraReferenceMode === 'always' ? 'selected' : ''}>Всегда отправлять</option>
                                <option value="tag_controls" ${settings.naisteraReferenceMode === 'tag_controls' ? 'selected' : ''}>Тег решает (рекомендуется)</option>
                                <option value="never" ${settings.naisteraReferenceMode === 'never' ? 'selected' : ''}>Никогда</option>
                            </select>
                        </div>
                        <p class="hint">«Тег решает» — ИИ указывает "references":["char"] в теге, когда персонаж нужен на картинке.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_naistera_send_char_avatar" ${settings.naisteraSendCharAvatar ? 'checked' : ''}>
                            <span>Аватар {{char}} доступен для отправки</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_naistera_send_user_avatar" ${settings.naisteraSendUserAvatar ? 'checked' : ''}>
                            <span>Аватар {{user}} доступен для отправки</span>
                        </label>

                        <div id="iig_naistera_user_avatar_row" class="flex-row ${!settings.naisteraSendUserAvatar ? 'iig-hidden' : ''}" style="margin-top: 5px;">
                            <label for="iig_naistera_user_avatar_file">Аватар {{user}}</label>
                            <select id="iig_naistera_user_avatar_file" class="flex1">
                                <option value="">-- Не выбран --</option>
                                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                            </select>
                            <div id="iig_naistera_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить список">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Опции для Nano-Banana -->
                    <div id="iig_avatar_section" class="iig-avatar-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>
                        
                        <!-- Aspect Ratio -->
                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Портрет)</option>
                                <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Альбом)</option>
                                <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Портрет)</option>
                                <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Альбом)</option>
                                <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикальный)</option>
                                <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                            </select>
                        </div>
                        
                        <!-- Image Size -->
                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                                <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                            </select>
                        </div>
                        
                        <hr>
                        
                        <h5>Референсы</h5>
                        
                        <div class="flex-row">
                            <label for="iig_reference_mode">Режим референсов</label>
                            <select id="iig_reference_mode" class="flex1">
                                <option value="always" ${settings.referenceMode === 'always' ? 'selected' : ''}>Всегда отправлять</option>
                                <option value="tag_controls" ${settings.referenceMode === 'tag_controls' ? 'selected' : ''}>Тег решает (рекомендуется)</option>
                                <option value="never" ${settings.referenceMode === 'never' ? 'selected' : ''}>Никогда</option>
                            </select>
                        </div>
                        <p class="hint">«Тег решает» — ИИ указывает "references":["char"] в теге, когда персонаж нужен на картинке. Это предотвращает наложение внешности на других персонажей.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                            <span>Аватар {{char}} доступен для отправки</span>
                        </label>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                            <span>Аватар {{user}} доступен для отправки</span>
                        </label>
                        
                        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px;">
                            <label for="iig_user_avatar_file">Аватар {{user}}</label>
                            <select id="iig_user_avatar_file" class="flex1">
                                <option value="">-- Не выбран --</option>
                                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                            </select>
                            <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить список">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Обработка ошибок</h4>
                    
                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" 
                               value="${settings.maxRetries}" min="0" max="5">
                    </div>
                    
                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" 
                               value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>
                    
                    <div class="flex-row">
                        <label for="iig_generation_timeout">Таймаут генерации (мс)</label>
                        <input type="number" id="iig_generation_timeout" class="text_pole flex1" 
                               value="${settings.generationTimeout}" min="30000" max="600000" step="10000">
                    </div>
                    <p class="hint">Максимальное время ожидания ответа от API.</p>
                    
                    <hr>
                    
                    <h4>Кэш</h4>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enable_cache" ${settings.enableCache ? 'checked' : ''}>
                        <span>Кэшировать результаты (не перегенерировать одинаковые промпты)</span>
                    </label>
                    
                    <div class="flex-row">
                        <div id="iig_clear_cache" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-trash"></i> Очистить кэш (<span id="iig_cache_size">${imageCache.size}</span> записей)
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Отладка</h4>
                    
                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                    <p class="hint">Экспортировать логи расширения для отладки проблем.</p>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    bindSettingsEvents();
}

/**
 * Bind settings event handlers
 */
function bindSettingsEvents() {
    const settings = getSettings();

    const updateVisibility = () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        const isOpenAI = apiType === 'openai';

        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_refs_section')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_user_avatar_row')?.classList.toggle('iig-hidden', !(isNaistera && settings.naisteraSendUserAvatar));
        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);

        const avatarSection = document.getElementById('iig_avatar_section');
        if (avatarSection) {
            avatarSection.classList.toggle('hidden', !isGemini);
        }
    };
    
    // Enable toggle
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });
    
    // API Type
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        updateVisibility();
    });
    
    // Endpoint
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });
    
    // API Key
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });
    
    // API Key toggle
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });
    
    // Model
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
        
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            updateVisibility();
        }
    });
    
    // Refresh models
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const currentModel = settings.model;
            
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Size
    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });
    
    // Quality
    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });
    
    // Concurrency
    document.getElementById('iig_concurrency')?.addEventListener('input', (e) => {
        settings.concurrency = Math.max(1, Math.min(4, parseInt(e.target.value) || 1));
        saveSettings();
    });
    
    // Aspect Ratio (nano-banana)
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });
    
    // Image Size (nano-banana)
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });
    
    // Reference Mode (nano-banana)
    document.getElementById('iig_reference_mode')?.addEventListener('change', (e) => {
        settings.referenceMode = e.target.value;
        saveSettings();
    });

    // Naistera aspect ratio
    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => {
        settings.naisteraAspectRatio = e.target.value;
        saveSettings();
    });

    // Naistera preset
    document.getElementById('iig_naistera_preset')?.addEventListener('change', (e) => {
        settings.naisteraPreset = e.target.value;
        saveSettings();
    });
    
    // Naistera reference mode
    document.getElementById('iig_naistera_reference_mode')?.addEventListener('change', (e) => {
        settings.naisteraReferenceMode = e.target.value;
        saveSettings();
    });

    // Naistera references
    document.getElementById('iig_naistera_send_char_avatar')?.addEventListener('change', (e) => {
        settings.naisteraSendCharAvatar = e.target.checked;
        saveSettings();
    });
    document.getElementById('iig_naistera_send_user_avatar')?.addEventListener('change', (e) => {
        settings.naisteraSendUserAvatar = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_naistera_user_avatar_file')?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_naistera_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');

        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_naistera_user_avatar_file');
            const currentAvatar = settings.userAvatarFile;

            select.innerHTML = '<option value="">-- Не выбран --</option>';

            for (const avatar of avatars) {
                const option = document.createElement('option');
                option.value = avatar;
                option.textContent = avatar;
                option.selected = avatar === currentAvatar;
                select.appendChild(option);
            }

            toastr.success(`Найдено аватаров: ${avatars.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Send char avatar
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked;
        saveSettings();
    });
    
    // Send user avatar
    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked;
        saveSettings();
        
        const avatarRow = document.getElementById('iig_user_avatar_row');
        if (avatarRow) {
            avatarRow.classList.toggle('hidden', !e.target.checked);
        }
    });
    
    // User avatar file selection
    document.getElementById('iig_user_avatar_file')?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        saveSettings();
    });
    
    // Refresh user avatars
    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_user_avatar_file');
            const currentAvatar = settings.userAvatarFile;
            
            select.innerHTML = '<option value="">-- Не выбран --</option>';
            
            for (const avatar of avatars) {
                const option = document.createElement('option');
                option.value = avatar;
                option.textContent = avatar;
                option.selected = avatar === currentAvatar;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено аватаров: ${avatars.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Max retries
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 0;
        saveSettings();
    });
    
    // Retry delay
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });
    
    // Generation timeout
    document.getElementById('iig_generation_timeout')?.addEventListener('input', (e) => {
        settings.generationTimeout = parseInt(e.target.value) || 120000;
        saveSettings();
    });
    
    // Enable cache
    document.getElementById('iig_enable_cache')?.addEventListener('change', (e) => {
        settings.enableCache = e.target.checked;
        saveSettings();
    });
    
    // Clear cache
    document.getElementById('iig_clear_cache')?.addEventListener('click', () => {
        const count = imageCache.size;
        imageCache.clear();
        document.getElementById('iig_cache_size').textContent = '0';
        toastr.success(`Кэш очищен (${count} записей)`, 'Генерация картинок');
    });
    
    // Export logs
    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });

    updateVisibility();
}

/**
 * Initialize extension
 */
(function init() {
    const context = SillyTavern.getContext();
    
    console.log('[IIG] Available event_types:', context.event_types);
    
    getSettings();
    
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation extension loaded (v2.0)');
    });
    
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event');
        setTimeout(() => {
            addButtonsToExistingMessages();
        }, 100);
    });
    
    const handleMessage = async (messageId) => {
        console.log('[IIG] Event triggered for message:', messageId);
        await onMessageReceived(messageId);
    };
    
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    
    console.log('[IIG] Inline Image Generation extension initialized (v2.0)');
})();
