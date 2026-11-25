const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    compactSuggestionContext,
    suggestionContextBudget,
    suggestionPrompt,
} = require('../services/book-suggestions');
const {
    createBookGenerator,
    BookGenerationError,
} = require('../services/book-generation');
const { reviewContext, reviewResult } = require('../services/writing-review');
function manuscript(extra = {}) {
    return {
        task: 'book-suggestions-next',
        mode: 'next',
        length: 'paragraph',
        count: 3,
        includeContext: false,
        book: 'A story',
        template: 'fiction',
        language: 'English',
        genre: 'Fiction',
        chapter: 20,
        chapterTitle: 'Chapter 20',
        brief: 'Mira owes Jonas 42 coins. Preserve their agreement.',
        outline: Array.from({ length: 40 }, (_, i) => ({
            title: 'Chapter ' + (i + 1),
            outline: 'A careful journey. '.repeat(20),
        })),
        previousChapters: Array.from({ length: 5 }, (_, i) => ({
            title: 'Earlier ' + i,
            ending: 'The travelers remembered the agreement. '.repeat(30),
        })),
        opening: 'The first journey began beside a river. '.repeat(70),
        currentDraft:
            'Mira owes Jonas 42 coins.\n\n' +
            'An earlier quiet passage. '.repeat(2500) +
            '\n\nMira and Jonas reached the station. Their next choice concerned the 42 coins.',
        ...extra,
    };
}
test('long suggestions stay within a fixed context budget and retain the exact ending, book facts and nearby outline', () => {
    const value = manuscript(),
        original = structuredClone(value),
        result = compactSuggestionContext(value);
    assert(JSON.stringify(result).length <= suggestionContextBudget);
    assert(
        result.currentDraft.endsWith(
            'Their next choice concerned the 42 coins.',
        ),
    );
    assert.match(result.brief, /42 coins/);
    assert.match(result.earlierChapterOpening, /Mira owes Jonas/);
    assert.deepEqual(
        result.outline.map((item) => item.title),
        ['Chapter 19', 'Chapter 20', 'Chapter 21'],
    );
    assert.equal(result.previousChapters.length, 2);
    assert(result.contextSelection);
    assert.deepEqual(value, original);
    assert(JSON.stringify(result).length < JSON.stringify(value).length / 3);
    assert.match(suggestionPrompt(value), /omitted events/);
});
test('short suggestions keep their complete supplied context and unexpected fields never enter prompts', () => {
    const value = manuscript({
        outline: [],
        previousChapters: [],
        opening: 'First chapter.',
        currentDraft: 'The full short draft.',
        brief: 'Brief.',
    });
    const result = compactSuggestionContext({
        ...value,
        unexpected: 'private '.repeat(100000),
    });
    assert.equal(result.currentDraft, value.currentDraft);
    assert.equal(result.opening, value.opening);
    assert.equal(result.contextSelection, undefined);
    assert.doesNotMatch(
        suggestionPrompt({ ...value, unexpected: 'UNEXPECTED_PRIVATE_FIELD' }),
        /UNEXPECTED_PRIVATE_FIELD/,
    );
});
test('selection expansion and alternatives keep all approved selected text and neighboring context', () => {
    for (const mode of ['expand', 'alternatives']) {
        const value = {
            ...manuscript(),
            mode,
            includeContext: true,
            selectedPassage: 'Selected original.',
            previousParagraph: 'Before.',
            nextParagraph: 'After.',
        };
        const result = compactSuggestionContext(value);
        assert.equal(result.selectedPassage, value.selectedPassage);
        assert.equal(result.previousParagraph, 'Before.');
        assert.equal(result.nextParagraph, 'After.');
        assert.equal(result.currentDraft, undefined);
        assert.equal(result.outline, undefined);
    }
});
test('unicode context and legacy clients remain bounded without inventing a chapter index', () => {
    const result = compactSuggestionContext(
        manuscript({
            chapter: undefined,
            chapterTitle: undefined,
            currentDraft: '旅の話。'.repeat(18000) + '\n最後の駅。',
        }),
    );
    assert(JSON.stringify(result).length <= suggestionContextBudget);
    assert(result.currentDraft.endsWith('最後の駅。'));
});
test('Book AI retries transient status codes with bounded jitter and Retry-After, then stops', async () => {
    let calls = 0;
    const waits = [];
    const generate = createBookGenerator({
        complete: async () => {
            calls++;
            throw Object.assign(Error('Busy'), {
                status: 429,
                headers: { 'retry-after': '2' },
            });
        },
        sleep: async (ms) => waits.push(ms),
        random: () => 0,
    });
    await assert.rejects(generate(8000, 'source'), /Busy/);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 2000]);
});
test('permanent failures and long Retry-After pauses do not create extra provider requests', async () => {
    for (const error of [
        Object.assign(Error('Credentials'), { status: 401 }),
        Object.assign(Error('Paused'), {
            status: 429,
            headers: { 'retry-after': '60' },
        }),
    ]) {
        let calls = 0;
        const generate = createBookGenerator({
            complete: async () => {
                calls++;
                throw error;
            },
            sleep: async () => assert.fail('must not sleep'),
        });
        await assert.rejects(generate(8000, 'source'));
        assert.equal(calls, 1);
    }
});
test('cancellation and persistent attempt limits stop before another provider call', async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    const generate = createBookGenerator({
        complete: async () => {
            calls++;
        },
        getSignal: () => abort.signal,
    });
    await assert.rejects(generate(8000, 'source'));
    assert.equal(calls, 0);
    const limited = createBookGenerator({
        complete: async () => {
            calls++;
        },
    });
    await assert.rejects(
        limited(8000, 'source', {
            beforeAttempt: async () => {
                throw new BookGenerationError('Budget reached');
            },
        }),
        /Budget/,
    );
    assert.equal(calls, 0);
});
const fullReview = (text, extra = {}) =>
    reviewContext({
        writingReviewVersion: 1,
        writingReviewPolicyVersion: 2,
        bookPageBillingVersion: 1,
        bookPageQuote: 1,
        context: JSON.stringify({
            task: 'writing-review-revise',
            pages: [{ number: 1, ids: ['s0'] }],
            segments: [{ id: 's0', text }],
            ...extra,
        }),
    });
test('whole revision shrinkage and growth budget are rejected before a charge can be finalized', () => {
    const original =
            'The traveler remembered every choice on the long journey. '.repeat(
                30,
            ),
        ctx = fullReview(original);
    assert.throws(
        () => reviewResult('{"edits":[{"id":"s0","text":"A summary."}]}', ctx),
        /omitted/,
    );
    const bounded = fullReview('She went home.', { revisionMaxGrowth: 0 });
    assert.throws(
        () =>
            reviewResult(
                '{"edits":[{"id":"s0","text":"She went back home."}]}',
                bounded,
            ),
        /size limit/,
    );
    assert.doesNotThrow(() => reviewResult('{"edits":[]}', bounded));
    assert.throws(
        () =>
            reviewResult(
                '{"edits":[{"id":"s0","text":"She went home*"}]}',
                bounded,
            ),
        /size limit/,
    );
});

test('heavy escaping remains bounded and the full author brief is retained when it fits', () => {
    const value = manuscript({
        brief: 'Author plan. '.repeat(250) + 'END_OF_AUTHOR_PLAN',
    });
    const result = compactSuggestionContext(value);
    assert(result.brief.endsWith('END_OF_AUTHOR_PLAN'));
    const escaped = compactSuggestionContext(
        manuscript({
            brief: '"'.repeat(4000),
            currentDraft: '"\\'.repeat(35000) + 'Exact ending.',
        }),
    );
    assert(JSON.stringify(escaped).length <= suggestionContextBudget);
    assert(escaped.currentDraft.endsWith('Exact ending.'));
});

test('unapproved nested metadata does not leak through short chapter context', () => {
    const value = manuscript({
        outline: [
            { title: 'Chapter', outline: 'Plan', private: 'NESTED_PRIVATE' },
        ],
        previousChapters: [
            { title: 'Before', ending: 'Ending', private: 'NESTED_PRIVATE' },
        ],
        opening: 'Start',
        currentDraft: 'Short draft.',
    });
    assert.doesNotMatch(suggestionPrompt(value), /NESTED_PRIVATE/);
});

test('a truncated local dialogue cannot hide inside an otherwise intact chapter', () => {
    const { reviewResult } = require('../services/writing-review');
    const sentence = 'The report says that Mira and Daniel Vale are — are — that they are — missing.';
    const context = { task: 'writing-review-revise', pages: [{ number: 1, ids: ['s0', 's1'] }], segments: [
        { id: 's0', text: sentence }, { id: 's1', text: 'Unchanged surrounding prose. '.repeat(100) },
    ] };
    assert.throws(() => reviewResult(JSON.stringify({ edits: [{ id: 's0', text: 'The report says that Mira and missing.' }] }), context), /omitted too much/);
    assert.equal(reviewResult(JSON.stringify({ edits: [{ id: 's0', text: sentence.replace('says that', 'says') }] }), context).edits.length, 1);
});

test('a 5000-word chapter keeps every source segment exactly once across batch boundaries', () => {
    const { reviewBatches, reviewResult } = require('../services/writing-review');
    const segments = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, text: `Section ${index} ` + 'carefully documented facts remain in their original order '.repeat(16) }));
    const context = { task: 'writing-review-revise', segments, pages: segments.map((s,index) => ({ number: index + 1, ids: [s.id] })) };
    assert(segments.map(s => s.text).join(' ').split(/\s+/u).length > 5000);
    const batches = reviewBatches(context);
    assert(batches.length > 1);
    assert.deepEqual(batches.flatMap(batch => batch.segments), segments);
    const combined = batches.flatMap(batch => reviewResult(JSON.stringify({ edits: batch.segments.map(s => ({ id: s.id, text: s.text })) }), batch).edits);
    assert.equal(reviewResult(JSON.stringify({ edits: combined }), context).edits.length, segments.length);
    assert.throws(() => reviewResult(JSON.stringify({ edits: [combined[0],combined[0]] }), context), /matched safely/);
});
