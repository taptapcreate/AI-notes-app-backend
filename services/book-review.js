const { createHash, randomUUID } = require('node:crypto');
const {
    reviewBatches,
    reviewPrompt,
    reviewResult,
    parseReviewJson,
    isSplitContinuation,
} = require('./writing-review');
const { BookGenerationError } = require('./book-generation');
const { reviewDiagnostic } = require('./book-review-diagnostics');
const retentionMs = 24 * 60 * 60 * 1000;
const maxChunkAttempts = 4;
const attemptWindowMs = 15 * 60 * 1000;
const reviewCompatibility = 'book-integrity-v3';
const maxBatchValidationAttempts = 2;
const batchConcurrency = 3;

function createBookReview({
    Checkpoint,
    GenerationRequest,
    generate,
    model,
    getRequest = () => ({}),
    now = () => new Date(),
    onValidation = diagnostic => console.warn('Book review validation', diagnostic),
}) {
    return async function run(context) {
        const batches = reviewBatches(context);
        const request = getRequest() || {};
        request.bookOperation = context.task;
        request.batchCount = batches.length;
        const diagnose = (error, stage, batchIndex, attempt) => {
            const diagnostic = reviewDiagnostic(error, stage, batchIndex, attempt);
            error.reviewDiagnostic = diagnostic;
            request.validationFailureCount = (request.validationFailureCount || 0) + 1;
            request.reviewValidationFailures = [...(request.reviewValidationFailures || []), diagnostic].slice(-12);
            // Logging must never alter retry, validation, billing or manuscript behavior.
            try { onValidation({ requestId: request.requestId, operation: context.task, ...diagnostic }); } catch {}
            return diagnostic;
        };
        const wrapReviewError = (error, fallback = 'The AI review could not be validated.') => {
            if (error instanceof BookGenerationError) return error;
            if (error?.name === 'AbortError' || request.signal?.aborted) return error;
            const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 502;
            // HTTP 400 from the provider indicates a deterministic prompt rejection (e.g. policy),
            // not a transient failure. Use a distinct code so it is not counted toward the
            // failure-cooldown that would block unrelated operations.
            const code = status === 400 ? 'PROVIDER_POLICY_REJECTION' : 'BOOK_REVIEW_INVALID';
            const message =
                error instanceof SyntaxError
                    ? 'The AI returned an unreadable review. Your credits are returned.'
                    : /Empty AI completion|Incomplete AI stream|APIConnection|timeout/i.test(error?.message || error?.name || '')
                      ? 'AI Notes could not complete this writing review right now. Your credits are returned. Please try again.'
                      : error?.message || fallback;
            const wrapped = new BookGenerationError(message, code, status);
            if (error.reviewValidation) wrapped.reviewValidation = error.reviewDiagnostic || reviewDiagnostic(error, 'batch');
            return wrapped;
        };
        const nonRetryableValidation = (message = '') =>
            /exceeds the chapter size limit|Choose valid/i.test(message);
        const repairBatch = async (rawText, batch, error, beforeAttempt, repairs = 0) => {
            const parsed = parseReviewJson(rawText);
            const affected = new Set(error.segmentIds || []);
            if (!affected.size || !parsed?.edits?.length) return null;
            const editedIds = new Set(parsed.edits.map(edit => edit.id));
            // Expand affected IDs across immediately connected edited split-line neighbors
            // so shifted wrapped boundaries are repaired together instead of fighting kept edits.
            for (const id of [...affected]) {
                const idx = batch.segments.findIndex(segment => segment.id === id);
                if (idx > 0 && editedIds.has(batch.segments[idx - 1].id) &&
                    isSplitContinuation(batch.segments[idx - 1].text, batch.segments[idx].text)) {
                    affected.add(batch.segments[idx - 1].id);
                }
                if (idx >= 0 && idx + 1 < batch.segments.length && editedIds.has(batch.segments[idx + 1].id) &&
                    isSplitContinuation(batch.segments[idx].text, batch.segments[idx + 1].text)) {
                    affected.add(batch.segments[idx + 1].id);
                }
            }
            const segments = batch.segments.filter(segment => affected.has(segment.id));
            if (!segments.length) return null;
            const first = batch.segments.indexOf(segments[0]);
            const last = batch.segments.indexOf(segments.at(-1));
            const keptText = new Map(parsed.edits.filter(edit => !affected.has(edit.id) && typeof edit.text === 'string').map(edit => [edit.id, edit.text]));
            const repair = { ...batch, segments,
                ...(batch.pages && { pages: batch.pages.map(page => ({ ...page, ids: page.ids.filter(id => affected.has(id)) })).filter(page => page.ids.length) }),
                readOnlyContext: {
                    description: 'Original selected prose only. Correct this affected span; do not rewrite the surrounding context.',
                    preceding: batch.segments.slice(0, first).map(s => keptText.get(s.id) ?? s.text).join('\n').slice(-1200),
                    following: batch.segments.slice(last + 1).map(s => keptText.get(s.id) ?? s.text).join('\n').slice(0, 1200),
                },
            };
            request.validationRetries = (request.validationRetries || 0) + 1;
            const result = await generate(8000, reviewPrompt(repair), { beforeAttempt, json: true });
            if (result.finishReason === 'length') return null;
            const repaired = reviewResult(result.text, repair).edits;
            const combined = [...parsed.edits.filter(edit => !affected.has(edit.id)), ...repaired];
            try {
                const validated = reviewResult(JSON.stringify({ edits: combined }), batch);
                request.recoveredSegments = (request.recoveredSegments || 0) + segments.length;
                return validated.edits;
            } catch (combinedError) {
                if (repairs === 0 && !(combinedError instanceof SyntaxError) &&
                    (combinedError.segmentIds || []).some(id => !affected.has(id))) {
                    return repairBatch(JSON.stringify({ edits: combined }), batch, combinedError, beforeAttempt, 1);
                }
                throw combinedError;
            }
        };
        const maxValidationAttempts = batches.length === 1 ? 2 : maxBatchValidationAttempts;
        const runBatch = async (batch, beforeAttempt, batchIndex = 0) => {
            const basePrompt = reviewPrompt(batch);
            let lastReason = '';
            for (let attempt = 0; attempt < maxValidationAttempts; attempt++) {
                if (attempt > 0) request.validationRetries = (request.validationRetries || 0) + 1;
                const prompt =
                    attempt === 0
                        ? basePrompt
                        : `IMPORTANT: Your previous response could not be validated (${lastReason}). Return ONLY valid JSON using the exact segment IDs in SOURCE.segments, keep each segment aligned strictly to its own original ID without shifting text or duplicating adjacent words, keep every line break unchanged, and keep comparable passage length.\n\n${basePrompt}`;
                let result;
                try {
                    result = await generate(8000, prompt, {
                        beforeAttempt,
                        json: true,
                    });
                } catch (error) {
                    const wrapped = wrapReviewError(error, 'AI Notes could not complete this writing review right now. Your credits are returned. Please try again.');
                    if (!(error instanceof BookGenerationError) && wrapped.code !== 'PROVIDER_POLICY_REJECTION') wrapped.code = 'BOOK_REVIEW_PROVIDER_FAILURE';
                    throw wrapped;
                }
                if (result.finishReason === 'length') {
                    lastReason = 'output truncated before finishing JSON';
                    if (
                        attempt + 1 < maxValidationAttempts &&
                        (batches.length > 1 || (request.providerCalls || 0) < 3)
                    )
                        continue;
                    throw new BookGenerationError(
                        'The revision was incomplete. Your credits are returned.',
                        'BOOK_REVIEW_INCOMPLETE',
                        502,
                    );
                }
                try {
                    return reviewResult(result.text, batch).edits;
                } catch (error) {
                    diagnose(error, 'batch', batchIndex, attempt + 1);
                    lastReason =
                        error instanceof SyntaxError
                            ? 'invalid JSON'
                            : error.message;
                    if (
                        attempt + 1 < maxValidationAttempts &&
                        !nonRetryableValidation(lastReason) &&
                        (batches.length > 1 || (request.providerCalls || 0) < 3)
                    )
                        continue;
                    if (!nonRetryableValidation(lastReason) && !(error instanceof SyntaxError)) {
                        try {
                            const repaired = await repairBatch(result.text, batch, error, beforeAttempt);
                            if (repaired) return repaired;
                        } catch (repairError) {
                            if (repairError.reviewValidation) diagnose(repairError, 'repair', batchIndex);
                            if (repairError instanceof BookGenerationError) throw repairError;
                            if (repairError.status || /APIConnection/.test(repairError.name || '')) throw wrapReviewError(repairError);
                            // Never deliver an undisclosed subset: all combined edits must validate.
                        }
                    }
                    throw wrapReviewError(error);
                }
            }
        };
        // Small operations retain one request and do not create persistent job records.
        if (batches.length === 1) {
            let singleAttempt = 0;
            const edits = await runBatch(batches[0], async () => {
                if (++singleAttempt > 4)
                    throw new BookGenerationError(
                        'The retry limit for this review was reached. Your credits are returned.',
                        'BOOK_REVIEW_RETRY_LIMIT',
                    );
            });
            return reviewResult(JSON.stringify({ edits }), context);
        }
        if (!request.accountScope || !request.generationId)
            throw new BookGenerationError(
                'The revision account could not be verified.',
            );
        request.signal?.throwIfAborted();
        await Checkpoint.init();
        const fingerprint = createHash('sha256')
            .update(
                JSON.stringify({
                    compatibility: reviewCompatibility,
                    owner: request.accountScope,
                    model,
                    context,
                    prompts: batches.map(reviewPrompt),
                    outputLimit: 8000,
                }),
            )
            .digest('hex');
        const token = randomUUID();
        const fresh = () => ({
            _id: fingerprint,
            generationId: request.generationId,
            token,
            leaseUntil: new Date(
                Math.min(
                    now().getTime() + 180000,
                    request.leaseUntil?.getTime() ?? Infinity,
                ),
            ),
            expiresAt: new Date(now().getTime() + retentionMs),
            attemptWindowEndsAt: new Date(now().getTime() + attemptWindowMs),
            chunks: Array(batches.length).fill(null),
            attempts: Array(batches.length).fill(0),
            invalid: false,
        });
        let checkpoint;
        for (let race = 0; race < 4 && !checkpoint; race++) {
            const existing = await Checkpoint.findById(fingerprint).lean();
            if (!existing) {
                try {
                    checkpoint = (await Checkpoint.create(fresh())).toObject();
                } catch (error) {
                    if (error.code !== 11000) throw error;
                }
                continue;
            }
            const previous = await GenerationRequest.findById(
                existing.generationId,
            ).lean();
            if (
                existing.leaseUntil > now() ||
                (previous?.state === 'pending' && previous.leaseUntil > now())
            )
                throw new BookGenerationError(
                    'This revision is already running. Please wait before retrying.',
                    'BOOK_REVIEW_BUSY',
                    409,
                );
            // Explicit fresh polish after a delivered result must produce a fresh generation.
            const reset =
                existing.expiresAt <= now() ||
                ['succeeded', 'unchanged'].includes(previous?.state);
            const next = reset
                ? fresh()
                : {
                      ...fresh(),
                      expiresAt: existing.expiresAt,
                      chunks: Array.isArray(existing.chunks) ? existing.chunks : Array(batches.length).fill(null),
                      attempts: existing.attemptWindowEndsAt > now()
                          ? Array.from({ length: batches.length }, (_, i) => Number.isSafeInteger(existing.attempts?.[i]) && existing.attempts[i] >= 0 ? existing.attempts[i] : 0)
                          : Array(batches.length).fill(0),
                      attemptWindowEndsAt: existing.attemptWindowEndsAt > now() ? existing.attemptWindowEndsAt : new Date(now().getTime() + attemptWindowMs),
                  };
            const { _id, ...fields } = next;
            checkpoint = await Checkpoint.findOneAndUpdate(
                {
                    _id: fingerprint,
                    token: existing.token,
                    leaseUntil: { $lte: now() },
                },
                { $set: fields },
                { returnDocument: 'after', runValidators: true },
            ).lean();
        }
        if (!checkpoint)
            throw new BookGenerationError(
                'The revision is updating. Please retry shortly.',
            );
        const owned = () => ({
            _id: fingerprint,
            token,
            leaseUntil: { $gt: now() },
        });
        let invalid = false;
        try {
            const results = Array(batches.length);
            const pending = [];
            let reusedChunks = 0;
            for (let index = 0; index < batches.length; index++) {
                const saved = checkpoint.chunks[index];
                // Empty edit arrays are complete, validated no-change chunks too.
                if (Array.isArray(saved)) {
                    try {
                        reviewResult(JSON.stringify({ edits: saved }), batches[index]);
                        results[index] = saved;
                        reusedChunks += 1;
                    } catch (error) {
                        diagnose(error, 'checkpoint', index);
                        // Repair only this stale chunk; retain independently valid completed work.
                        await Checkpoint.updateOne(owned(), { $set: { [`chunks.${index}`]: null } });
                        pending.push(index);
                    }
                } else {
                    pending.push(index);
                }
            }
            request.reusedChunks = reusedChunks;
            const processChunk = async (index) => {
                request.signal?.throwIfAborted();
                const saved = await runBatch(batches[index], async () => {
                    request.signal?.throwIfAborted();
                    const attempt = await Checkpoint.updateOne(
                        {
                            ...owned(),
                            [`attempts.${index}`]: {
                                $lt: maxChunkAttempts,
                            },
                        },
                        { $inc: { [`attempts.${index}`]: 1 } },
                    );
                    if (attempt.modifiedCount !== 1) {
                        const current = await Checkpoint.findById(fingerprint).lean();
                        if (!current || current.token !== token || !(current.leaseUntil > now()))
                            throw new BookGenerationError('The review lease expired or changed. Your credits are returned; retry to resume completed sections.', 'BOOK_REVIEW_LEASE_LOST', 409);
                        if (!Number.isSafeInteger(current.attempts?.[index]))
                            throw new BookGenerationError('The saved review needs recovery. Your credits are returned; retry to resume.', 'BOOK_REVIEW_STATE_INVALID', 409);
                        const seconds = Math.max(1, Math.ceil((current.attemptWindowEndsAt - now()) / 1000));
                        const error = new BookGenerationError(`The provider retry budget for this passage is temporarily paused. Your credits are returned. Try again in about ${Math.max(1, Math.ceil(seconds / 60))} minutes.`, 'BOOK_REVIEW_RETRY_LIMIT', 429);
                        error.retryAfterSeconds = seconds;
                        throw error;
                    }
                }, index);
                request.signal?.throwIfAborted();
                const stored = await Checkpoint.updateOne(owned(), {
                    $set: { [`chunks.${index}`]: saved },
                });
                if (stored.modifiedCount !== 1)
                    throw new BookGenerationError(
                        'The revision was interrupted. Retry to recover completed sections.',
                    );
                results[index] = saved;
            };
            if (pending.length) {
                // Run the first pending chunk before fanning out so persistent chunk failures
                // stop at the attempt limit without burning attempts on later chunks.
                await processChunk(pending.shift());
                if (pending.length) {
                    let cursor = 0;
                    let firstError = null;
                    const workers = Array.from(
                        { length: Math.min(batchConcurrency, pending.length) },
                        async () => {
                            while (!firstError) {
                                const next = cursor++;
                                if (next >= pending.length) break;
                                try {
                                    await processChunk(pending[next]);
                                } catch (error) {
                                    firstError ||= error;
                                    break;
                                }
                            }
                        },
                    );
                    await Promise.allSettled(workers);
                    if (firstError) throw firstError;
                }
            }
            const edits = results.flat();
            let result;
            try {
                result = reviewResult(JSON.stringify({ edits }), context);
            } catch (error) {
                diagnose(error, 'final');
                const affected = new Set(error.segmentIds || context.segments.map(s => s.id));
                const changes = {};
                batches.forEach((batch, index) => {
                    if (batch.segments.some(segment => affected.has(segment.id))) changes[`chunks.${index}`] = null;
                });
                await Checkpoint.updateOne(owned(), { $set: changes });
                throw wrapReviewError(error);
            }
            return result;
        } finally {
            // Fencing prevents a late process from altering a newer attempt's checkpoint.
            await Checkpoint.updateOne(
                { _id: fingerprint, token },
                { $set: { leaseUntil: now(), invalid } },
            );
        }
    };
}
module.exports = { createBookReview, retentionMs, maxChunkAttempts, attemptWindowMs, reviewCompatibility };
