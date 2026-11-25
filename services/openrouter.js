const MODEL = 'openai/gpt-6-luna';
const TRANSCRIPTION_MODEL = 'openai/whisper-large-v3-turbo';
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 16.5 * 1024 * 1024;
const PDF_ENGINE = 'mistral-ocr';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const { attachmentKey, createAttachmentCache } = require('./attachment-cache');
const { reusablePdfAnnotations } = require('./pdf-annotations');

class InvalidSource extends Error {}

function decodeAttachment(content, maxBytes, errorMessage) {
    if (typeof content !== 'string' || content.length > Math.ceil(maxBytes / 3) * 4 ||
        content.length % 4 !== 0 || !BASE64.test(content)) {
        throw new InvalidSource(errorMessage);
    }
    const data = Buffer.from(content, 'base64');
    if (data.length > maxBytes) throw new InvalidSource(errorMessage);
    return data;
}

function pdfPart(content, onBytes) {
    const message = 'Choose a valid PDF file up to 15 MB and try again.';
    const data = decodeAttachment(content, MAX_PDF_BYTES, message);
    if (!data.subarray(0, 1024).includes('%PDF-')) throw new InvalidSource(message);
    onBytes?.(data);
    return {
        type: 'file',
        file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${content}` },
    };
}

function imagePart(content) {
    const header = Buffer.from(content.slice(0, 16), 'base64');
    let mimeType = 'image/jpeg';
    if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mimeType = 'image/png';
    if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
    if (/^GIF8[79]a$/.test(header.toString('ascii', 0, 6))) mimeType = 'image/gif';
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${content}` } };
}

function audioFormat(data) {
    const signature = data.toString('ascii', 0, 4);
    if (signature === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    if (data.toString('ascii', 4, 8) === 'ftyp') return 'm4a'; // MP4-family containers from mobile and Mac
    if (signature === 'fLaC') return 'flac';
    if (signature === 'OggS') return 'ogg';
    if (data.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'webm';
    if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return 'aac';
    if (signature.startsWith('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return 'mp3';
    throw new InvalidSource('Choose a supported audio recording, such as M4A, MP3, or WAV.');
}

function measuredUsage(value) {
    if (!value || typeof value !== 'object') return undefined;
    const fields = {
        inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens,
        cachedTokens: value.prompt_tokens_details?.cached_tokens,
        cacheWriteTokens: value.prompt_tokens_details?.cache_write_tokens,
        reasoningTokens: value.completion_tokens_details?.reasoning_tokens, costUSD: value.cost,
    };
    const usage = Object.fromEntries(Object.entries(fields).filter(([, amount]) => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0));
    return Object.keys(usage).length ? usage : undefined;
}

function createOpenRouter(client, { onTiming = () => {}, getCacheScope = () => undefined,
    attachmentCache = createAttachmentCache() } = {}) {
    return {
        async complete(content, maxTokens, signal, onDelta) {
            const started = performance.now();
            let firstTextMs, success = false, usage;
            try {
                signal?.throwIfAborted();
                let hasPdf = false;
                const pdfKeys = [], files = [];
                const scope = getCacheScope();
                const parts = typeof content === 'string' ? content : content.map(item => {
                    if (typeof item === 'string') return { type: 'text', text: item };
                    const { mimeType, data } = item.inlineData;
                    if (mimeType.startsWith('image/')) return imagePart(data);
                    hasPdf = true;
                    const part = pdfPart(data, bytes => pdfKeys.push(attachmentKey(scope,
                        ['pdf-annotations-v1', MODEL, PDF_ENGINE], bytes)));
                    files.push(part);
                    return part;
                });
                const prompts = Array.isArray(parts) ? parts.filter(part => part.type !== 'file') : [];
                const pdfKey = files.length === 1 && prompts.length ? pdfKeys[0] : null;
                const cached = attachmentCache.get(pdfKey);
                let emitted = false;
                const request = async annotations => {
                    let parsed, conflicting = false;
                    const collect = items => {
                        const value = reusablePdfAnnotations(items);
                        if (!value) return;
                        // Streaming metadata must be a complete, stable parse. Fragmented or
                        // conflicting versions are a cache miss, never a partial document hit.
                        if (parsed && JSON.stringify(parsed) !== JSON.stringify(value)) conflicting = true;
                        parsed = value;
                    };
                    const response = await client.chat.completions.create({
                        model: MODEL,
                        messages: annotations ? [
                            { role: 'user', content: files },
                            { role: 'assistant', content: '', annotations },
                            { role: 'user', content: prompts },
                        ] : [{ role: 'user', content: parts }],
                        max_completion_tokens: maxTokens,
                        reasoning: { effort: 'none' },
                        ...(onDelta && { stream: true }),
                        ...(hasPdf && { plugins: [{ id: 'file-parser', pdf: { engine: PDF_ENGINE } }] }),
                    }, { signal });
                    if (onDelta) {
                        let text = '', finishReason;
                        for await (const chunk of response) {
                            usage = measuredUsage(chunk.usage) || usage;
                            const choice = chunk.choices?.[0];
                            if (chunk.error || choice?.finish_reason === 'error') {
                                const error = new Error('AI stream failed');
                                const status = Number(chunk.error?.code ?? chunk.error?.status);
                                if ([400, 422].includes(status)) error.status = status;
                                throw error;
                            }
                            collect(choice?.delta?.annotations ?? choice?.message?.annotations);
                            const delta = choice?.delta?.content;
                            if (typeof delta === 'string' && delta) {
                                text += delta;
                                if (text.length > 2000000) throw new Error('AI completion is too large');
                                firstTextMs ??= performance.now() - started;
                                emitted = true;
                                onDelta(delta);
                            }
                            if (choice?.finish_reason) finishReason = choice.finish_reason;
                        }
                        if (!text.trim() || !finishReason || !['stop', 'length'].includes(finishReason)) throw new Error('Incomplete AI stream');
                        signal?.throwIfAborted();
                        if (parsed && !conflicting) attachmentCache.set(pdfKey, parsed);
                        success = true;
                        return { text, finishReason, ...(usage && { usage }) };
                    }
                    usage = measuredUsage(response.usage);
                    const choice = response.choices?.[0];
                    const text = choice?.message?.content;
                    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty AI completion');
                    collect(choice?.message?.annotations);
                    signal?.throwIfAborted();
                    if (parsed && !conflicting && ['stop', 'length'].includes(choice.finish_reason)) attachmentCache.set(pdfKey, parsed);
                    success = true;
                    return { text, finishReason: choice.finish_reason, ...(usage && { usage }) };
                };
                try { return await request(cached); }
                catch (error) {
                    // A stale/unusable annotation gets one normal parse retry, before any preview.
                    if (!cached || emitted || ![400, 422].includes(error.status) || signal?.aborted) throw error;
                    attachmentCache.delete(pdfKey);
                    return await request();
                }
            } finally {
                try { onTiming({ model: MODEL, durationMs: Math.round(performance.now() - started),
                    ...(firstTextMs === undefined ? {} : { firstTextMs: Math.round(firstTextMs) }),
                    streamed: Boolean(onDelta), success, ...(usage && { usage }) }); } catch { /* Observability cannot lose a paid result. */ }
            }
        },
        async transcribe(content, signal) {
            signal?.throwIfAborted();
            const data = decodeAttachment(content, MAX_AUDIO_BYTES, 'Choose a valid audio recording up to 16.5 MB.');
            const format = audioFormat(data);
            const key = attachmentKey(getCacheScope(), ['transcription-v1', TRANSCRIPTION_MODEL, format], data);
            return attachmentCache.run(key, async sharedSignal => {
                const response = await client.post('/audio/transcriptions', {
                    body: {
                        model: TRANSCRIPTION_MODEL,
                        input_audio: { data: content, format },
                    },
                    signal: sharedSignal,
                    timeout: 55000,
                });
                const transcript = response?.text;
                if (typeof transcript !== 'string' || !transcript.trim()) {
                    throw new InvalidSource('No speech was detected. Try a recording with clear speech.');
                }
                return transcript.trim();
            }, signal);
        },
    };
}

module.exports = { MODEL, InvalidSource, createOpenRouter };
