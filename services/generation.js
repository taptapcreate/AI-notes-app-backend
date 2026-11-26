const { suggestionContext, suggestionResult, suggestionPrompt } = require('./book-suggestions');
const { reviewContext, reviewResult, reviewPrompt, reviewBatches } = require('./writing-review');
const { monthlyUsage, reserveMonthly, settleMonthly } = require('./subscription-credit-ledger');
const { generationUnits } = require('./media-note-billing');
const { validateImageBatch } = require('./image-attachments');
const { canUseAppleRecord } = require('./apple-subscriptions');
const { requestHistoryUsage } = require('./subscription-usage');
const { validateNarration } = require('./walkthrough');
const { createHash } = require('node:crypto');
const { context } = require('./generation-context');
const { createNoteStream } = require('./note-stream');
const {
    CreditError,
    policy,
    balance,
    recoveryCode,
} = require('./credit-policy');

const PATHS = new Set([
    '/notes',
    '/reply',
    '/followup',
    '/translate',
    '/polish',
    '/sentiment',
]);
const REQUEST_ID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const APP_FEATURES = new Set(['text', 'image', 'screenshot', 'voice', 'pdf', 'website', 'import', 'documents', 'video', 'location', 'calendar', 'sketch']);
const MOBILE_PRO_FORMATS = new Set(['meeting', 'study', 'quiz', 'blog', 'social', 'code']);
const PRO_SOURCES = new Set(['location', 'calendar', 'sketch']);
const requiresPro = (body) => body.bookSuggestionsVersion === 1 || body.writingReviewVersion === 1 || body.desktopProFormatVersion === 1 || PRO_SOURCES.has(body.appFeature) || Boolean(body.replyTool) ||
    (body.featurePolicyVersion === 1 && (body.noteLength === 'in-depth' || body.format === 'book' || MOBILE_PRO_FORMATS.has(body.format)));

function validateInput(endpoint, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new CreditError(400, 'Invalid AI request');
    if (Buffer.byteLength(JSON.stringify(body)) > 23 * 1024 * 1024)
        throw new CreditError(413, 'The source is too large');
    if (body.additionalImages !== undefined && endpoint !== '/notes')
        throw new CreditError(400, 'Image batches require an image note.');
    validateImageBatch(body);
    if (body.billingMode !== undefined && !['free', 'purchased', ...(body.desktopMediaBilling === 1 || body.mobileMediaBilling === 1 || body.bookSuggestionsVersion === 1 || body.bookPageBillingVersion === 1 ? ['mixed'] : [])].includes(body.billingMode))
        throw new CreditError(400, 'Invalid billing mode');
    const text = (value, max = 2000000) => {
        if (typeof value !== 'string' || !value.trim() || value.length > max)
            throw new CreditError(400, 'Enter valid source content');
    };
    try {
        const suggestions = suggestionContext(body);
        if (suggestions && endpoint !== '/notes') throw Error('Book suggestions require the notes endpoint.');
    } catch (error) { throw new CreditError(400, error.message); }
    if ((body.writingReviewVersion !== undefined || body.bookPageBillingVersion !== undefined) && endpoint !== '/followup')
        throw new CreditError(400, 'Writing reviews require the review endpoint.');
    if (body.desktopProFormatVersion !== undefined && (body.desktopProFormatVersion !== 1 || endpoint !== '/notes' || !['email', 'recipe'].includes(body.format)))
        throw new CreditError(400, 'Invalid desktop Pro format.');
    if (endpoint === '/followup') {
        try { reviewContext(body); } catch (error) { throw new CreditError(400, error.message); }
    }
    if (body.featurePolicyVersion !== undefined && body.featurePolicyVersion !== 1)
        throw new CreditError(400, 'Invalid feature policy');
    if (body.appFeature !== undefined && (endpoint !== '/notes' || !APP_FEATURES.has(body.appFeature)))
        throw new CreditError(400, 'Invalid note source');
    if (body.appFeature === 'video' && body.type !== 'image')
        throw new CreditError(400, 'Video notes require reviewed still frames');
    if (body.replyTool !== undefined && !(
        (endpoint === '/followup' && ['explain', 'sound'].includes(body.replyTool)) ||
        (endpoint === '/reply' && body.replyTool === 'attachment' && body.mode === 'reply')
    )) throw new CreditError(400, 'Invalid reply tool');
    if (body.replyTool === 'attachment') text(body.attachmentText, 24000);
    else if (body.attachmentText !== undefined) throw new CreditError(400, 'Unexpected reply attachment');
    if (body.narration !== undefined && (endpoint !== '/notes' || body.type !== 'image')) throw new CreditError(400, 'Narration requires walkthrough image frames');
    if (endpoint === '/notes') {
        if (body.sourceKind !== undefined && (!['compare', 'walkthrough', 'screenshot', 'sketch', 'image'].includes(body.sourceKind) || body.type !== 'image')) throw new CreditError(400, 'Invalid visual source kind');
        try { validateNarration(body.narration); } catch (e) { throw new CreditError(400, e.message); }
        if (
            !['text', 'image', 'voice', 'pdf', 'website', 'youtube'].includes(
                body.type,
            )
        )
            throw new CreditError(400, 'Unsupported source type');
        text(
            body.content,
            ['image', 'voice', 'pdf'].includes(body.type)
                ? 22 * 1024 * 1024
                : 2000000,
        );
        if (
            ['image', 'voice', 'pdf'].includes(body.type) &&
            !/^[A-Za-z0-9+/]+={0,2}$/.test(body.content)
        )
            throw new CreditError(400, 'Invalid attachment');
        if (['website', 'youtube'].includes(body.type)) {
            let url;
            try {
                url = new URL(body.content);
            } catch {
                throw new CreditError(400, 'Enter a valid website URL');
            }
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password
            )
                throw new CreditError(400, 'Enter a valid website URL');
        }
        if (body.websiteText !== undefined &&
            (body.type !== 'website' || typeof body.websiteText !== 'string' || body.websiteText.length > 12000))
            throw new CreditError(400, 'Invalid website preview text');
    } else if (endpoint === '/reply') text(body.message);
    else if (endpoint === '/followup') {
        text(body.context);
        text(body.question, 20000);
    } else if (endpoint === '/sentiment') text(body.message ?? body.text);
    else text(body.text);
    require('./smart-note-safety').validateNoteSource(endpoint, body);
    for (const field of [
        'language',
        'targetLanguage',
        'tone',
        'format',
        'style',
        'mode',
        'noteLength',
        'length',
    ]) {
        if (
            body[field] !== undefined &&
            (typeof body[field] !== 'string' || body[field].length > 200)
        )
            throw new CreditError(400, `Invalid ${field}`);
    }
    if (
        body.instruction !== undefined &&
        (typeof body.instruction !== 'string' ||
            body.instruction.length > 20000)
    )
        throw new CreditError(400, 'Instructions are too long');
}
function validResult(endpoint, value, body) {
    if (Buffer.byteLength(JSON.stringify(value ?? null)) > 2 * 1024 * 1024)
        return false;
    if (endpoint === '/notes' && body) {
        try {
            const suggestions = suggestionContext(body);
            if (suggestions) { suggestionResult(value?.notes, suggestions); return true; }
        } catch { return false; }
    }
    if (endpoint === '/followup' && body) {
        try {
            const review = reviewContext(body);
            if (review) { reviewResult(value?.response, review); return true; }
        } catch { return false; }
    }
    const text = (x) =>
        typeof x === 'string' && !!x.trim() && x.length <= 2000000;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    if (endpoint === '/reply')
        return (
            Array.isArray(value.replies) &&
            value.replies.length > 0 &&
            value.replies.length <= 30 &&
            value.replies.every(text)
        );
    if (endpoint === '/sentiment') return text(value.sentiment || value.type);
    return text(
        value[
            {
                '/notes': 'notes',
                '/followup': 'response',
                '/polish': 'polishedText',
                '/translate': 'translatedText',
            }[endpoint]
        ],
    );
}
function stable(value, skipKeys = ['isPro']) {
    if (Array.isArray(value)) return value.map(item => stable(item, skipKeys));
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .filter((k) => !skipKeys.includes(k))
                .map((k) => [k, stable(value[k], skipKeys)]),
        );
    return value;
}
function bookCacheFingerprint(endpoint, body) {
    const cacheable =
        (endpoint === '/followup' && body?.writingReviewVersion === 1) ||
        (endpoint === '/notes' && body?.bookSuggestionsVersion === 1);
    if (!cacheable) return undefined;
    return createHash('sha256')
        .update(JSON.stringify(stable({ endpoint, body,
            compatibility: require('./book-review').reviewCompatibility,
            model: require('./openrouter').MODEL,
            prompts: endpoint === '/followup' ? reviewBatches(reviewContext(body)).map(reviewPrompt) : suggestionPrompt(suggestionContext(body)),
        }, ['isPro', 'billingMode'])))
        .digest('hex');
}
function failureScopeFor(endpoint, body) {
    if (
        endpoint === '/followup' &&
        body?.bookPageBillingVersion === 1 &&
        Number(body?.bookPageQuote) > 3
    )
        return 'book-bulk-review:' + (reviewContext(body)?.task || 'unknown');
    if (endpoint === '/followup' && body?.writingReviewVersion === 1)
        return 'book-small-review:' + (reviewContext(body)?.task || 'unknown');
    if (endpoint === '/notes' && body?.bookSuggestionsVersion === 1)
        return 'book-suggestions';
    return endpoint;
}
function summarizeTelemetry(reqState, status, record, noEditsSuggested = false) {
    if (!reqState) return undefined;
    const held = record?.reservation || {};
    const reserved =
        (held.pro ? held.proUnits ?? 1 : 0) + (held.free ?? 0) + (held.ad ?? 0) + (held.paid ?? 0);
    const charged = record?.state === 'succeeded' ? reserved : 0;
    const refunded = record?.state === 'failed' ? reserved : 0;
    const outcome =
        record?.state === 'succeeded'
            ? noEditsSuggested
                ? 'succeeded_no_edits'
                : 'succeeded'
            : status === 504
              ? 'expired'
              : 'failed';
    return {
        requestId: reqState.requestId,
        endpoint: reqState.endpoint,
        operation: reqState.bookOperation || (reqState.endpoint === '/notes' ? 'note' : 'followup'),
        outcome,
        noEditsSuggested,
        cacheHit: false,
        eligiblePages: reqState.eligiblePages ?? null,
        batchCount: reqState.batchCount ?? 1,
        reusedChunks: reqState.reusedChunks ?? 0,
        recoveredSegments: reqState.recoveredSegments ?? 0,
        providerCalls: reqState.providerCalls ?? 0,
        retryCount: reqState.retryCount ?? 0,
        validationRetries: reqState.validationRetries ?? 0,
        validationFailureCount: reqState.validationFailureCount ?? 0,
        reviewValidationFailures: reqState.reviewValidationFailures ?? [],
        models: [...(reqState.models || [])],
        finishReasons: [...(reqState.finishReasons || [])],
        inputTokens: reqState.inputTokens ?? 0,
        outputTokens: reqState.outputTokens ?? 0,
        cachedTokens: reqState.cachedTokens ?? 0,
        reasoningTokens: reqState.reasoningTokens ?? 0,
        providerCostUSD: Number((reqState.providerCostUSD ?? 0).toFixed(6)),
        costSource: reqState.hasProviderCost ? 'provider' : 'unavailable',
        creditsReserved: reserved,
        creditsCharged: charged,
        creditsRefunded: refunded,
        durationMs: Math.max(0, Math.round(performance.now() - (reqState.startedAt ?? performance.now()))),
    };
}

function createGeneration({
    User,
    GenerationRequest,
    Subscription,
    credits,
    getAppConfig,
    entitlement,
    resolveStoreKitScope = async () => undefined,
    now = () => new Date(),
    leaseMs = 180000,
    onTiming = () => {},
}) {
    const subscriptionRecovery = Subscription && require('./account-recovery').createAccountRecovery({
        Account: Subscription, Backup: require('../models/AccountRecovery'), kind: 'subscription', now,
    });
    const key = (code, id) =>
        createHash('sha256').update(`${code}:${id}`).digest('hex');
    const transaction = async (work) => {
        const session = await User.db.startSession();
        try {
            return await session.withTransaction(() => work(session));
        } finally {
            await session.endSession();
        }
    };
    async function authenticate(header) {
        if (typeof header !== 'string' || !header.startsWith('Bearer '))
            throw new CreditError(
                426,
                'Update AI Notes to continue using AI. This version requires secure credit charging.',
            );
        let code;
        try {
            code = recoveryCode(header.slice(7));
            await credits.byCode(code);
        } catch (error) {
            if (![400, 404].includes(error.status))
                throw new CreditError(
                    503,
                    'Your AI account could not be verified. Please try again.',
                );
            throw new CreditError(
                401,
                'Reconnect or recover your AI Notes account',
            );
        }
        return code;
    }
    async function finish(id, status, result, unchangedReview = false, observability = undefined, failureCode = undefined) {
        return transaction(async (session) => {
            const record = await GenerationRequest.findById(id)
                .session(session)
                .lean();
            if (!record) throw new CreditError(404, 'AI request was not found');
            if (record.state !== 'pending') return record;
            if (record.leaseUntil <= now() && status < 400) {
                status = 504;
                result = {
                    error: 'The AI request expired. Your credit was returned; please try again.',
                };
            }
            // Only failed/invalid operations release credits; completed AI reviews stay billable.
            const billable = status < 400 && !unchangedReview;
            const held = record.reservation;
            let subscription;
            if (held.ledger || (!billable && held.subscriptionId)) {
                try { subscription = await subscriptionRecovery.ensure(held.subscriptionId, session); }
                catch (error) { if (error.status !== 404) throw error; }
            }
            if (held.ledger)
                await settleMonthly(held.ledger, id, billable, subscription, now(), session);
            if (!billable) {
                if (!held.subscriptionId || held.free || held.ad || held.paid)
                    await credits.ensureAccount(record.recoveryCode, session);
                if (held.pro && !held.ledger) {
                    await (held.subscriptionId ? Subscription : User).updateOne(
                        {
                            ...(held.subscriptionId ? { _id: held.subscriptionId } : { recoveryCode: record.recoveryCode }),
                            ...(held.subscriptionId ? { quotaEpoch: held.quotaEpoch ?? { $exists: false } } : {}),
                            ...(held.periodTransactionId
                                ? { periodUsageTransactionId: held.periodTransactionId, periodRequestCount: { $gte: held.proUnits ?? 1 } }
                                : { lastRequestReset: new Date(held.day), dailyRequestCount: { $gte: held.proUnits ?? 1 } }),
                        },
                        { $inc: { [held.periodTransactionId ? 'periodRequestCount' : 'dailyRequestCount']: -(held.proUnits ?? 1) } },
                        { session },
                    );
                }
                if (held.free || held.ad || held.paid) {
                    await User.updateOne(
                        { recoveryCode: record.recoveryCode },
                        {
                            $inc: {
                                [held.field]: held.free,
                                adCredits: held.ad,
                                credits: held.paid,
                            },
                        },
                        { session },
                    );
                }
            }
            if (!billable) {
                if (record.reservation.subscriptionId) {
                    if (await Subscription.exists({ _id: record.reservation.subscriptionId }).session(session))
                        await subscriptionRecovery.checkpoint(record.reservation.subscriptionId, session);
                }
                if (!record.reservation.subscriptionId || record.reservation.free || record.reservation.ad || record.reservation.paid)
                    await credits.checkpointAccount(record.recoveryCode, session);
            }
            return GenerationRequest.findOneAndUpdate(
                { _id: id, state: 'pending' },
                {
                    $set: {
                        state: status >= 400 ? 'failed' : unchangedReview ? 'unchanged' : 'succeeded',
                        result,
                        httpStatus: status,
                        ...(status >= 400 && failureCode && { failureCode }),
                        ...(observability && { observability }),
                        expiresAt: new Date(now().getTime() + 86400000),
                    },
                },
                { returnDocument: 'after', session },
            ).lean();
        });
    }
    async function recoverExpired(code) {
        // The background sweep purges results. A request only reconciles its own wallet.
        if (!code) {
            await GenerationRequest.updateMany(
                {
                    state: { $ne: 'pending' },
                    expiresAt: { $lte: now() },
                    result: { $exists: true },
                },
                { $unset: { result: 1, expiresAt: 1 } },
            );
        }
        const records = await GenerationRequest.find({
            state: 'pending',
            leaseUntil: { $lte: now() },
            ...(code ? { recoveryCode: code } : {}),
        })
            .limit(100)
            .lean();
        for (const record of records)
            await finish(record._id, 504, {
                error: 'The AI request expired. Your credit was returned; please try again.',
            });
    }
    async function begin(code, requestId, endpoint, body, storeKitProofs, requestConfig, { regenerate = false } = {}) {
        if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))
            throw new CreditError(400, 'A unique AI request ID is required');
        validateInput(endpoint, body);
        const id = key(code, requestId);
        const bodyHash = createHash('sha256')
            .update(JSON.stringify(stable({ endpoint, body })))
            .digest('hex');
        const contentHash = bookCacheFingerprint(endpoint, body);
        await recoverExpired(code);
        const check = (record) => {
            if (record.bodyHash !== bodyHash || record.endpoint !== endpoint)
                throw new CreditError(
                    409,
                    'This request ID belongs to different content',
                );
            if (record.state === 'pending')
                throw new CreditError(
                    409,
                    'This AI request is still running. Please wait.',
                    { requestId },
                );
            return { record, cached: true };
        };
        const existing = await GenerationRequest.findById(id).lean();
        if (existing) return check(existing);
        if (!regenerate && contentHash) {
            const cachedHit = await GenerationRequest.findOne({
                recoveryCode: code,
                endpoint,
                contentHash,
                state: 'succeeded',
                result: { $exists: true },
                expiresAt: { $gt: now() },
            })
                .sort({ createdAt: -1 })
                .lean();
            if (cachedHit && validResult(endpoint, cachedHit.result, body)) {
                return {
                    record: { ...cachedHit, requestId, httpStatus: cachedHit.httpStatus || 200 },
                    cached: true,
                    contentCacheHit: true,
                };
            }
        }
        const failureScope = failureScopeFor(endpoint, body);
        await require('./generation-safety').checkFailureCooldown(GenerationRequest, code, now(), { failureScope, endpoint, contentHash });
        if (endpoint === '/followup' && body.writingReviewPolicyVersion === 2)
            await require('./generation-safety').checkUnchangedReviewLimit(GenerationRequest, code, bodyHash, now());
        const config = requestConfig ?? await getAppConfig();
        const units = await generationUnits(endpoint, body, config);
        await credits.balance(code, undefined, config); // Initialize any legacy allowance before reserving.
        const rules = policy(config);
        const account = await credits.byCode(code);
        const sandboxIds = await resolveStoreKitScope(storeKitProofs, account);
        const membership = await entitlement(account, sandboxIds);
        try {
            return await transaction(async (session) => {
                const duplicate = await GenerationRequest.findById(id)
                    .session(session)
                    .lean();
                if (duplicate) return check(duplicate);
                const user = await credits.ensureAccount(code, session);
                await require('./generation-safety').checkConcurrentRequests(GenerationRequest, code, now(), session);
                if (!user)
                    throw new CreditError(401, 'Reconnect your AI account');
                const timestamp = now();
                let pro = membership.isPro === true;
                let quota = user;
                let quotaId = membership.quotaId;
                if (user.appleSubscriptionIds?.length) {
                    if (!Subscription)
                        throw new CreditError(503, 'Your subscription could not be checked. Please try again.');
                    // A restore, renewal or expiration can occur after the earlier
                    // provider lookup. Reserve against the current shared record.
                    for (const id of user.appleSubscriptionIds) {
                        try { await subscriptionRecovery.ensure(id, session); }
                        catch (error) { if (error.status !== 404) throw error; }
                    }
                    const records = await Subscription.find({
                        _id: { $in: user.appleSubscriptionIds },
                    }).sort({ expiresAt: -1 }).session(session).lean();
                    const active = records.find(record =>
                        canUseAppleRecord(record, sandboxIds) &&
                        !record.revokedAt && !record.isUpgraded &&
                        Math.max(
                            new Date(record.expiresAt || 0).getTime(),
                            new Date(record.graceExpiresAt || 0).getTime(),
                        ) > timestamp.getTime(),
                    );
                    pro = !!active;
                    quota = active || user;
                    quotaId = active?._id;
                } else if (pro && quotaId) {
                    // This wallet was unlinked while the provider lookup ran.
                    pro = false;
                    quotaId = undefined;
                }
                if (requiresPro(body) && !pro)
                    throw new CreditError(403, 'This feature is available with AI Notes Pro.', { code: 'PRO_REQUIRED' });
                // Both tracking modes serialize reservations by updating this quota document.
                // The history count runs inside the same transaction, so parallel requests cannot overdraw.
                const usage = (quotaId ? await monthlyUsage(quota, config, timestamp, session, GenerationRequest) : null) ??
                    await requestHistoryUsage(quota, config, timestamp, session, GenerationRequest);
                const { billingMode } = body;
                const proUnits = pro ? Math.min(units, usage.subscriberDailyRemaining) : 0;
                const walletUnits = units - proUnits;
                const current = balance(user, rules);
                const selectedBalance = billingMode === 'free' ? current.freeCreditsRemaining
                    : billingMode === 'purchased' ? current.credits
                    : current.freeCreditsRemaining + current.credits;
                if (walletUnits && pro && (!billingMode || selectedBalance < walletUnits))
                    throw new CreditError(
                        429,
                        'Your Pro allowance does not cover this request. Wait for the reset or choose credits to finish it.',
                        {
                            code: 'SUBSCRIPTION_DAILY_LIMIT',
                            ...usage,
                            requiredWalletCredits: walletUnits,
                            freeCreditsAvailable: current.freeCreditsRemaining,
                            freeCreditPolicy: current.freeCreditPolicy,
                            purchasedCreditsAvailable: current.credits,
                        },
                    );
                if (walletUnits && billingMode && selectedBalance < walletUnits)
                    throw new CreditError(402, 'The selected credit balance does not cover this request.');
                if (current.totalAvailable < walletUnits)
                    throw new CreditError(
                        402,
                        membership.sandbox
                            ? 'This Apple sandbox subscription has no test allowance enabled, and your credit balance is insufficient.'
                            : 'No AI credits remain. Recover an existing account or purchase more credits.',
                        membership.sandbox ? { code: 'SANDBOX_PRO_ALLOWANCE_DISABLED' } : undefined,
                    );
                const reservation = { pro: proUnits > 0 };
                if (proUnits && usage.subscriberCreditBuckets) {
                    const ledger = await reserveMonthly(quota, proUnits, id, timestamp, session);
                    Object.assign(reservation, { ledger, subscriptionId: quotaId, proUnits,
                        periodTransactionId: quota.transactionId, limit: usage.subscriberDailyLimit,
                        ...(quota.quotaEpoch ? { quotaEpoch: quota.quotaEpoch } : {}) });
                } else if (proUnits) {
                    const day = new Date(timestamp);
                    day.setUTCHours(0, 0, 0, 0);
                    const { subscriberDailyUsage: count, subscriberDailyLimit: limit } = usage;
                    const previous = quota.lastRequestReset && new Date(quota.lastRequestReset);
                    const sameDay = previous && previous >= day && previous < new Date(usage.subscriberResetAt);
                    const reset = sameDay ? previous : timestamp;
                    const periodTransactionId = usage.subscriberAllowancePeriod !== 'daily' ? quota.transactionId : null;
                    await (quotaId ? Subscription : User).updateOne(
                        { _id: quota._id },
                        { $set: periodTransactionId
                            ? { periodRequestCount: count + proUnits, periodUsageTransactionId: periodTransactionId }
                            : { dailyRequestCount: count + proUnits, lastRequestReset: reset } },
                        { session },
                    );
                    Object.assign(reservation, {
                        ...(proUnits > 1 ? { proUnits } : {}),
                        ...(quotaId ? { subscriptionId: quotaId, ...(quota.quotaEpoch ? { quotaEpoch: quota.quotaEpoch } : {}) } : {}),
                        ...(periodTransactionId ? { periodTransactionId } : { day: reset.toISOString() }),
                        limit,
                    });
                }
                if (walletUnits) {
                    const free = billingMode === 'purchased' ? 0 : Math.min(current.freeCreditsRemaining, walletUnits);
                    const ad = billingMode ? 0 : Math.min(current.adCredits, walletUnits - free);
                    const paid = walletUnits - free - ad;
                    await User.updateOne(
                        { _id: user._id },
                        { $inc: { [rules.field]: -free, adCredits: -ad, credits: -paid } },
                        { session },
                    );
                    Object.assign(reservation, { field: rules.field, free, ad, paid });
                }
                // The held credit/quota and its recovery snapshot commit atomically.
                if (reservation.subscriptionId) await subscriptionRecovery.checkpoint(reservation.subscriptionId, session);
                await credits.checkpointAccount(code, session);
                const [record] = await GenerationRequest.create(
                    [
                        {
                            _id: id,
                            recoveryCode: code,
                            requestId,
                            endpoint,
                            bodyHash,
                            ...(contentHash && { contentHash }),
                            failureScope,
                            state: 'pending',
                            createdAt: timestamp,
                            reservation: {
                                ...reservation,
                                membershipPro: pro,
                                ...(sandboxIds === undefined ? {} : { sandboxIds }),
                            },
                            leaseUntil: new Date(timestamp.getTime() + leaseMs),
                            expiresAt: new Date(timestamp.getTime() + 86400000),
                        },
                    ],
                    { session },
                );
                return { record: record.toObject(), cached: false };
            });
        } catch (error) {
            if (error.code === 11000) {
                const duplicate = await GenerationRequest.findById(id).lean();
                if (duplicate) return check(duplicate);
            }
            throw error;
        }
    }
    async function response(record, { contentCacheHit = false } = {}) {
        if (!record.result || (record.expiresAt && record.expiresAt <= now()))
            throw new CreditError(
                410,
                'This request completed earlier, but its saved result expired. No additional credit was charged. Start a new generation if you need another result.',
            );
        const current = credits.receiptBalance
            ? await credits.receiptBalance(record.recoveryCode, record.reservation.sandboxIds)
            : await credits.balance(record.recoveryCode, record.reservation.sandboxIds);
        const held = record.reservation;
        const succeeded = !contentCacheHit && record.state === 'succeeded';
        const walletCost = succeeded ? (held.free ?? 0) + (held.ad ?? 0) + (held.paid ?? 0) : 0;
        const subscriptionCost = succeeded && held.pro ? held.proUnits ?? 1 : 0;
        const noEditsSuggested = Boolean(record.observability?.noEditsSuggested);
        return {
            ...record.result,
            billing: {
                version: 2,
                ...(record.reservation.sandboxIds === undefined ? {} : { storeKitScopeVersion: 1 }),
                requestId: record.requestId,
                charged: succeeded,
                status: contentCacheHit ? 'cached' : record.state === 'failed' ? 'refunded' : succeeded ? 'charged' : 'no-charge',
                ...(record.state === 'failed' && { refundedCredits: (held.pro ? held.proUnits ?? 1 : 0) + (held.free ?? 0) + (held.ad ?? 0) + (held.paid ?? 0) }),
                ...(contentCacheHit && { cached: true, noChargeReason: 'cached-review-hit' }),
                ...(!contentCacheHit && record.state === 'unchanged' && { noChargeReason: 'unchanged-writing-review' }),
                ...(noEditsSuggested && { noEditsSuggested: true }),
                creditCost: walletCost,
                subscriptionCreditCost: subscriptionCost,
                totalCreditCost: walletCost + subscriptionCost,
                hasProSubscription: record.reservation.membershipPro ?? record.reservation.pro,
                creditBalance: current,
                ...Object.fromEntries(Object.entries(current).filter(([key]) => key.startsWith('subscriber') || ['serverTime', 'subscriptionUsageKey'].includes(key))),
            },
        };
    }
    function middleware(req, res, next) {
        const endpoint = req.path.toLowerCase().replace(/\/+$/, '');
        if (
            req.method !== 'POST' ||
            (!PATHS.has(endpoint) && endpoint !== '/notes/stream')
        )
            return next();
        const startedAt = performance.now();
        const send = res.json.bind(res);
        let timer, stream;
        const abort = new AbortController();
        let finishing = false;
        let reqState;
        const complete = async (status, value, id, unchangedReview = false, noEditsSuggested = false, failureCode = undefined) => {
            if (finishing) return;
            finishing = true;
            if (status >= 400) abort.abort();
            clearTimeout(timer);
            const finalizationStarted = performance.now();
            let settlementMs;
            const timing = receiptCompleted => {
                const elapsed = performance.now() - finalizationStarted;
                try { onTiming({ endpoint, status, receiptCompleted,
                    ...(settlementMs === undefined ? {} : {
                        settlementMs: Math.round(settlementMs), receiptMs: Math.round(elapsed - settlementMs),
                    }), finalizationMs: Math.round(elapsed) }); } catch { /* Diagnostics cannot lose a paid result. */ }
            };
            try {
                const preliminary = summarizeTelemetry(
                    reqState,
                    status,
                    { state: status >= 400 ? 'failed' : 'succeeded', reservation: reqState?.reservation },
                    noEditsSuggested,
                );
                const record = await finish(id, status, value, unchangedReview, preliminary, failureCode);
                const telemetry = summarizeTelemetry(reqState, status, record, noEditsSuggested);
                if (telemetry) console.info('AI financial telemetry', telemetry);
                status = record.httpStatus;
                settlementMs = performance.now() - finalizationStarted;
                const body = await response(record);
                timing(true);
                if (stream) stream.finish(record.httpStatus, body);
                else if (!res.destroyed && !res.writableEnded) { res.status(record.httpStatus); send(body); }
            } catch (error) {
                timing(false);
                if (!res.destroyed && !res.writableEnded) {
                    const body = { error: 'Your AI request is being reconciled. Retry with the same request ID to check its result.' };
                    if (stream) stream.finish(503, body);
                    else { res.status(503); send(body); }
                }
            }
        };
        (async () => {
            if (endpoint === '/notes/stream')
                throw new CreditError(
                    410,
                    'Use the authenticated notes endpoint in the latest AI Notes app',
                );
            const config = await getAppConfig();
            res.locals.appConfig = config;
            // All AI requests require authenticated credit reservation, including legacy request shapes.
            const code = await authenticate(req.headers.authorization);
            validateInput(endpoint, req.body);
            const { storeKitProofs, ...body } = req.body;
            const regenerate = req.get('X-AI-Regenerate') === '1';
            const { record, cached, contentCacheHit = false } = await begin(
                code,
                req.headers['idempotency-key'],
                endpoint,
                body,
                storeKitProofs,
                config,
                { regenerate },
            );
            if (endpoint === '/notes' && req.get('Accept')?.includes('text/event-stream')) {
                stream = createNoteStream(res, record.requestId);
                req.noteStream = stream;
            }
            if (cached) {
                const body = await response(record, { contentCacheHit });
                console.info('AI financial telemetry', {
                    requestId: record.requestId,
                    endpoint,
                    operation: record.observability?.operation || endpoint,
                    outcome: contentCacheHit ? 'cached_hit' : 'idempotent_replay',
                    cacheHit: true,
                    providerCalls: 0,
                    creditsReserved: 0,
                    creditsCharged: 0,
                    creditsRefunded: 0,
                    durationMs: Math.round(performance.now() - startedAt),
                });
                if (stream) return stream.finish(record.httpStatus, body);
                res.status(record.httpStatus);
                return send(body);
            }
            req.body.isPro = record.reservation.membershipPro ?? record.reservation.pro;
            if (endpoint === '/sentiment')
                req.body.message = req.body.message ?? req.body.text;
            let reviewPagesCount = null;
            if (endpoint === '/followup' && req.body.bookPageBillingVersion === 1) {
                try { reviewPagesCount = reviewContext(req.body)?.pages?.length ?? null; } catch {}
            }
            res.json = (value) => {
                let status = res.statusCode;
                if (status < 400 && !validResult(endpoint, value, req.body)) {
                    status = 502;
                    value = {
                        error: 'The AI server returned an empty or invalid result. Your credit was returned.',
                    };
                }
                let noEditsSuggested = false;
                if (status < 400 && endpoint === '/followup' && req.body.writingReviewPolicyVersion === 2) {
                    const review = reviewContext(req.body);
                    if (review) noEditsSuggested = reviewResult(value.response, review).edits.every(edit =>
                        edit.text.trim() === review.segments.find(segment => segment.id === edit.id).text.trim());
                }
                void complete(status, value, record._id, false, noEditsSuggested, status >= 400 ? value?.code : undefined);
                return res;
            };
            timer = setTimeout(
                () =>
                    void complete(
                        504,
                        {
                            error: 'The AI request timed out. Your credit was returned.',
                        },
                        record._id,
                    ),
                leaseMs,
            );
            timer.unref?.();
            reqState = {
                signal: abort.signal,
                endpoint,
                startedAt,
                generationId: record._id,
                requestId: record.requestId,
                leaseUntil: record.leaseUntil,
                reservation: record.reservation,
                eligiblePages: reviewPagesCount,
                accountScope: createHash('sha256').update(code).digest('hex'),
                providerCalls: 0,
                retryCount: 0,
                validationRetries: 0,
                inputTokens: 0,
                outputTokens: 0,
                cachedTokens: 0,
                reasoningTokens: 0,
                providerCostUSD: 0,
                hasProviderCost: false,
                models: new Set(),
                finishReasons: new Set(),
            };
            context.run(reqState, () => next());
        })().catch((error) => {
            const status = error.status || 503;
            const body = { error: error.status ? error.message : 'AI charging is temporarily unavailable. Please try again.', ...(error.details || {}) };
            if (['AI_FAILURE_COOLDOWN','UNCHANGED_REVIEW_LIMIT','UNCHANGED_REVIEW_COOLDOWN','AI_CONCURRENCY_LIMIT'].includes(body.code))
                body.billing = { version: 2, requestId: req.headers['idempotency-key'], charged: false, creditCost: 0, subscriptionCreditCost: 0, totalCreditCost: 0, noChargeReason: 'request-not-started' };
            if (stream) stream.finish(status, body);
            else { res.status(status); send(body); }
        });
    }
    return {
        authenticate,
        begin,
        finish,
        response,
        recoverExpired,
        middleware,
    };
}

module.exports = { createGeneration, validateInput, validResult };
