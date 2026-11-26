const { setTimeout: delay } = require('node:timers/promises');

class BookGenerationError extends Error {
    constructor(message, code = 'BOOK_AI_UNAVAILABLE', status = 503) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
function createBookGenerator({
    complete,
    getSignal = () => undefined,
    getRequest = () => undefined,
    maxRetriesPerRequest = 2,
    maxLogicalRetries = 4,
    sleep = delay,
    random = Math.random,
    onRetry = () => {},
}) {
    return async function generate(
        maxTokens,
        prompt,
        { beforeAttempt = async () => {}, json = false, schema = undefined } = {},
    ) {
        const signal = getSignal();
        for (let attempt = 0; ; attempt++) {
            signal?.throwIfAborted();
            await beforeAttempt();
            signal?.throwIfAborted();
            try {
                return json || schema
                    ? await complete(prompt, maxTokens, signal, undefined, {
                          ...(json && { json: true }),
                          ...(schema && { schema }),
                      })
                    : await complete(prompt, maxTokens, signal);
            } catch (error) {
                if (signal?.aborted) throw error;
                const request = getRequest();
                const status = Number(error.status || error.response?.status || error.code);
                const nonRetryableClient = [400, 401, 403, 404, 422].includes(status) || error?.type === 'invalid_request_error';
                const retryable =
                    !nonRetryableClient &&
                    ([408, 429, 500, 502, 503, 504].includes(status) ||
                    [
                        'APIConnectionError',
                        'APIConnectionTimeoutError',
                    ].includes(error.name));
                const usedLogicalRetries =
                    (request?.retryCount || 0) + (request?.validationRetries || 0);
                if (
                    !retryable ||
                    attempt >= maxRetriesPerRequest ||
                    (request && usedLogicalRetries >= maxLogicalRetries)
                )
                    throw error;
                const header =
                    error.headers?.get?.('retry-after') ??
                    error.headers?.['retry-after'];
                const retryAfter =
                    header == null
                        ? 0
                        : Number.isFinite(Number(header))
                          ? Number(header) * 1000
                          : Date.parse(header) - Date.now();
                // Long provider waits pause this operation instead of exhausting its request lease.
                if (retryAfter > 10000)
                    throw new BookGenerationError(
                        'AI is busy. Your credits are returned; please retry later.',
                    );
                const milliseconds = Math.max(
                    Number.isFinite(retryAfter) ? retryAfter : 0,
                    750 * 2 ** attempt + Math.floor(random() * 400),
                );
                onRetry({ attempt: attempt + 1, status, delayMs: milliseconds });
                await sleep(milliseconds, undefined, { signal });
            }
        }
    };
}
module.exports = { createBookGenerator, BookGenerationError };
