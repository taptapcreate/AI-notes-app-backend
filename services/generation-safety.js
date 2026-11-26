const { CreditError } = require('./credit-policy');
const internalFailures = ['BOOK_REVIEW_RETRY_LIMIT', 'BOOK_REVIEW_BUSY', 'BOOK_REVIEW_LEASE_LOST', 'BOOK_REVIEW_STATE_INVALID', 'PROVIDER_POLICY_REJECTION'];
// Failures retain their records after refund, so changing request IDs or restarting
// the service cannot reset these cooldowns. Cached receipts bypass these checks.
async function checkFailureCooldown(Request, code, now, { failureScope, endpoint, contentHash } = {}) {
    const windowMs = 15 * 60000;
    const windowStart = new Date(now.getTime() - windowMs);
    const scope = failureScope || endpoint;
    const bookScope = scope?.startsWith('book-');
    const scopedFilter = scope
        ? bookScope
            ? { failureScope: scope, ...(contentHash && { contentHash }) }
            : { $or: [{ failureScope: scope }, { failureScope: { $exists: false }, endpoint: scope }] }
        : {};
    const scopedFailures = await Request.find(
        { state: 'failed', recoveryCode: code, createdAt: { $gte: windowStart },
          failureCode: { $nin: internalFailures }, ...scopedFilter },
        { createdAt: 1 },
    )
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();
    if (scopedFailures.length >= 3) {
        const oldest = scopedFailures[scopedFailures.length - 1];
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((new Date(oldest.createdAt).getTime() + windowMs - now.getTime()) / 1000),
        );
        const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
        const waitText = minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
        throw new CreditError(
            429,
            `AI requests are paused after repeated failures. Please try again in ${waitText}. Your credits have not been charged.`,
            { code: 'AI_FAILURE_COOLDOWN', retryAfterSeconds },
        );
    }
    const accountProviderFailures = await Request.find(
        {
            state: 'failed',
            recoveryCode: code,
            failureCode: { $nin: internalFailures },
            $or: [{ failureCode: { $ne: 'BOOK_REVIEW_INVALID' } }, { 'observability.providerCalls': { $gt: 0 } }],
            createdAt: { $gte: windowStart },
        },
        { createdAt: 1 },
    )
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
    if (accountProviderFailures.length >= 5) {
        const oldest = accountProviderFailures[accountProviderFailures.length - 1];
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((new Date(oldest.createdAt).getTime() + windowMs - now.getTime()) / 1000),
        );
        const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
        const waitText = minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
        throw new CreditError(
            429,
            `AI requests are paused after repeated failures. Please try again in ${waitText}. Your credits have not been charged.`,
            { code: 'AI_FAILURE_COOLDOWN', retryAfterSeconds },
        );
    }
    if (
        (await Request.countDocuments({
            state: 'failed',
            httpStatus: { $gte: 500 },
            failureCode: { $nin: [...internalFailures, 'BOOK_REVIEW_INVALID'] },
            createdAt: { $gte: new Date(now.getTime() - 5 * 60000) },
        })) >= 20
    )
        throw new CreditError(
            503,
            'AI processing is temporarily paused after repeated failures. Please try again in 5 minutes. Your credits have not been charged.',
            { code: 'AI_FAILURE_COOLDOWN', retryAfterSeconds: 300 },
        );
}
async function checkConcurrentRequests(Request, code, now, session) {
    if (
        (await Request.countDocuments({
            recoveryCode: code,
            state: 'pending',
            leaseUntil: { $gt: now },
        }).session(session)) >= 2
    )
        throw new CreditError(
            429,
            'Two AI requests are already running. Wait for one to finish before starting another.',
            { code: 'AI_CONCURRENCY_LIMIT' },
        );
}
async function checkUnchangedReviewLimit(Request, code, bodyHash, now) {
    if (
        (await Request.countDocuments({
            recoveryCode: code,
            bodyHash,
            state: 'unchanged',
            createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60000) },
        })) >= 2
    )
        throw new CreditError(
            429,
            'This exact text already passed review with no changes needed. Edit the text before running another review.',
            { code: 'UNCHANGED_REVIEW_LIMIT', retryAfterSeconds: 3600 },
        );
    if (
        (await Request.countDocuments({
            recoveryCode: code,
            state: 'unchanged',
            createdAt: { $gte: new Date(now.getTime() - 15 * 60000) },
        })) >= 6
    )
        throw new CreditError(
            429,
            'Too many consecutive no-change reviews were requested in a short time. Wait a few minutes or edit your text before trying again.',
            { code: 'UNCHANGED_REVIEW_COOLDOWN', retryAfterSeconds: 900 },
        );
}
module.exports = { checkFailureCooldown, checkConcurrentRequests, checkUnchangedReviewLimit };
