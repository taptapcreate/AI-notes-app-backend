const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../models/User');
const GenerationRequest = require('../models/GenerationRequest');
const BookReviewCheckpoint = require('../models/BookReviewCheckpoint');
const CreditRegistration = require('../models/CreditRegistration');
const PurchaseClaim = require('../models/PurchaseClaim');
const { createCredits } = require('../services/credits');
const { createGeneration } = require('../services/generation');
const { noteOutputLimit } = require('../services/note-output-limits');
const { buildNotePrompt } = require('../services/note-prompts');

let mongo, config, time, credits, generation, member;

before(async () => {
    mongo = await MongoMemoryReplSet.create({
        binary: { version: '8.0.17' },
        replSet: { count: 1 },
    });
    await mongoose.connect(mongo.getUri(), { dbName: 'book_phase3c_openings_tests' });
    await Promise.all([
        User.init(),
        GenerationRequest.init(),
        BookReviewCheckpoint.init(),
        CreditRegistration.init(),
        PurchaseClaim.init(),
    ]);
});

after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});

beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        GenerationRequest.deleteMany({}),
        BookReviewCheckpoint.deleteMany({}),
        CreditRegistration.deleteMany({}),
        PurchaseClaim.deleteMany({}),
    ]);
    config = {
        dailyFreeCreditsEnabled: false,
        freeDailyCredits: 2,
        subscriberDailyLimit: 20,
    };
    time = new Date();
    member = { isPro: true };
    credits = createCredits({
        User,
        CreditRegistration,
        PurchaseClaim,
        getAppConfig: async () => config,
        now: () => new Date(time),
    });
    generation = createGeneration({
        User,
        GenerationRequest,
        credits,
        getAppConfig: async () => config,
        entitlement: async () => member,
        now: () => new Date(time),
    });
});

async function api(t) {
    const app = express();
    app.use(express.json({ limit: '25mb' }));
    app.use('/api', generation.middleware);
    app.post('/api/notes', (_req, res) => {
        res.json({ notes: 'Inspector Lin stepped onto the wet pier as the bell tolled once.' });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    return async (code, id, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/notes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${code}`,
                'Idempotency-Key': id,
            },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
}

test('Phase 3C: format=book openings require Pro even with brief/standard noteLength and bill 1 credit', async (t) => {
    const code = (await credits.register({ deviceId: randomUUID() })).recoveryCode;
    const call = await api(t);

    const openingBody = {
        type: 'text',
        format: 'book',
        featurePolicyVersion: 1,
        noteLength: 'brief',
        content: JSON.stringify({
            book: 'Harbor Fog',
            brief: 'A coastal lighthouse mystery.',
            outline: [{ number: 1, title: 'The Lock', outline: '- Inspector arrives at dawn' }],
            chapter: 1,
            openingTarget: { pageSize: 'A5', fontSize: 18, targetWords: 175, minWords: 131, maxWords: 219 },
        }),
        instruction: 'Draft only a grounded opening scene or section (131–219 words).',
    };

    member = { isPro: false };
    const denied = await call(code, randomUUID(), openingBody);
    assert.equal(denied.status, 403);

    member = { isPro: true };
    const result = await call(code, randomUUID(), openingBody);
    assert.equal(result.status, 200);
    assert.equal(result.body.billing.totalCreditCost, 1);
    assert.ok(noteOutputLimit({}, openingBody.noteLength) < noteOutputLimit({}, 'in-depth'));

    const prompt = buildNotePrompt({
        type: 'text',
        content: openingBody.content,
        instruction: openingBody.instruction,
        lengthInstruction: 'Keep the opening concise (~150–260 words), sized for a compact opening page without summarizing later outline points.',
        formatInstruction: 'Write readable Book Studio manuscript prose in Markdown matching the requested scope.',
        toneInstruction: 'Use engaging prose.',
        languageInstruction: 'Keep the output in English.',
        isPro: true,
    });
    assert.match(prompt, /Harbor Fog/);
    assert.match(prompt, /131/);
    assert.match(prompt, /Book Studio manuscript prose/);
});
