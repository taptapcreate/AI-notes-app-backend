const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenRouter, InvalidSource } = require('../services/openrouter');

const b64 = (text, encoding) => Buffer.from(text, encoding).toString('base64');

test('text, images, and PDFs use Luna with their original content', async () => {
    const requests = [];
    const router = createOpenRouter({
        chat: { completions: { create: async (body, options) => {
            requests.push({ body, options });
            return { choices: [{ message: { content: 'Summary' }, finish_reason: 'stop' }] };
        } } },
    });
    const signal = new AbortController().signal;
    assert.deepEqual(await router.complete('Draft a reply.', 512, signal), {
        text: 'Summary', finishReason: 'stop',
    });
    const png = b64('89504e470d0a1a0a', 'hex');
    const pdf = b64('%PDF-1.7\n');
    await router.complete(['Read the image.', { inlineData: { mimeType: 'image/jpeg', data: png } }], 900, signal);
    await router.complete(['Read the PDF.', { inlineData: { mimeType: 'application/pdf', data: pdf } }], 900, signal);

    for (const { body, options } of requests) {
        assert.equal(body.model, 'openai/gpt-6-luna');
        assert.deepEqual(body.reasoning, { effort: 'none' });
        assert.equal(options.signal, signal);
    }
    assert.equal(requests[0].body.max_completion_tokens, 512);
    assert.equal(requests[0].body.messages[0].content, 'Draft a reply.');
    assert.equal(requests[1].body.messages[0].content[1].image_url.url, `data:image/png;base64,${png}`);
    assert.equal(requests[1].body.plugins, undefined);
    assert.equal(requests[2].body.messages[0].content[1].file.file_data, `data:application/pdf;base64,${pdf}`);
    assert.deepEqual(requests[2].body.plugins, [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
});

test('voice uses Whisper and detects the recording container from the audio bytes', async () => {
    const signal = new AbortController().signal;
    const fixtures = { wav: b64('RIFF0000WAVE'), m4a: b64('0000ftypM4A '), mp3: b64('ID3audio') };
    const requests = [];
    const router = createOpenRouter({ post: async (path, options) => {
        requests.push({ path, ...options });
        return { text: '  A voice note.  ' };
    } });
    for (const audio of Object.values(fixtures)) {
        assert.equal(await router.transcribe(audio, signal), 'A voice note.');
    }
    for (const [index, [format, data]] of Object.entries(fixtures).entries()) {
        assert.equal(requests[index].path, '/audio/transcriptions');
        assert.equal(requests[index].signal, signal);
        assert.equal(requests[index].body.model, 'openai/whisper-large-v3-turbo');
        assert.deepEqual(requests[index].body.input_audio, { format, data });
    }
});

test('invalid attachments and empty upstream results fail instead of returning a billable note', async () => {
    const router = createOpenRouter({
        post: async () => ({ text: ' ' }),
        chat: { completions: { create: async () => ({ choices: [] }) } },
    });
    await assert.rejects(router.complete('Summarize.', 900), /Empty AI completion/);
    await assert.rejects(router.complete([{ inlineData: { mimeType: 'application/pdf', data: b64('not a PDF') } }], 900), InvalidSource);
    await assert.rejects(router.transcribe(b64('not audio')), InvalidSource);
    await assert.rejects(router.transcribe(b64('RIFF0000WAVE')), /No speech was detected/);
});
