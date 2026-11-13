const MODEL = 'openai/gpt-6-luna';
const TRANSCRIPTION_MODEL = 'openai/whisper-large-v3-turbo';
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 16.5 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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

function pdfPart(content) {
    const message = 'Choose a valid PDF file up to 15 MB and try again.';
    const data = decodeAttachment(content, MAX_PDF_BYTES, message);
    if (!data.subarray(0, 1024).includes('%PDF-')) throw new InvalidSource(message);
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

function createOpenRouter(client) {
    return {
        async complete(content, maxTokens, signal) {
            let hasPdf = false;
            const parts = typeof content === 'string' ? content : content.map(item => {
                if (typeof item === 'string') return { type: 'text', text: item };
                const { mimeType, data } = item.inlineData;
                if (mimeType.startsWith('image/')) return imagePart(data);
                hasPdf = true;
                return pdfPart(data);
            });
            const response = await client.chat.completions.create({
                model: MODEL,
                messages: [{ role: 'user', content: parts }],
                max_completion_tokens: maxTokens,
                reasoning: { effort: 'none' },
                ...(hasPdf && { plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] }),
            }, { signal });
            const choice = response.choices?.[0];
            const text = choice?.message?.content;
            if (typeof text !== 'string' || !text.trim()) throw new Error('Empty AI completion');
            return { text, finishReason: choice.finish_reason };
        },
        async transcribe(content, signal) {
            const data = decodeAttachment(content, MAX_AUDIO_BYTES, 'Choose a valid audio recording up to 16.5 MB.');
            const format = audioFormat(data);
            const response = await client.post('/audio/transcriptions', {
                body: {
                    model: TRANSCRIPTION_MODEL,
                    input_audio: { data: content, format },
                },
                signal,
                timeout: 55000,
            });
            const transcript = response?.text;
            if (typeof transcript !== 'string' || !transcript.trim()) {
                throw new InvalidSource('No speech was detected. Try a recording with clear speech.');
            }
            return transcript.trim();
        },
    };
}

module.exports = { MODEL, InvalidSource, createOpenRouter };
