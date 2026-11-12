const { subscriptionUsage } = require('./subscription-usage');
const { createHash, randomInt } = require('node:crypto');
const {
    CreditError,
    recoveryCode,
    positiveAmount,
    policy,
    balance,
} = require('./credit-policy');

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 8 }, () => chars[randomInt(chars.length)]).join(
        '',
    );
}

function createCredits({
    User,
    CreditRegistration,
    PurchaseClaim,
    getAppConfig,
    now = () => new Date(),
}) {
    const currentPolicy = async () => policy(await getAppConfig());
    const byCode = async (value) => {
        const user = await User.findOne({
            recoveryCode: recoveryCode(value),
        }).lean();
        if (!user) throw new CreditError(404, 'User not found');
        return user;
    };
    const expected = (user, field) =>
        user[field] === undefined ? { $exists: false } : user[field];

    async function ensureAllowance(user, rules) {
        balance(user, rules);
        if (
            user.welcomePackVersion != null &&
            (!Number.isSafeInteger(user.welcomePackVersion) ||
                user.welcomePackVersion < 0)
        ) {
            throw new CreditError(
                503,
                'This welcome allowance needs support review',
            );
        }
        if (rules.daily) {
            const timestamp = now();
            const midnight = new Date(timestamp);
            midnight.setUTCHours(0, 0, 0, 0);
            await User.updateOne(
                {
                    _id: user._id,
                    $or: [
                        { lastFreeCreditsReset: { $lt: midnight } },
                        { lastFreeCreditsReset: null },
                    ],
                },
                {
                    $set: {
                        freeCreditsRemaining: rules.dailyLimit,
                        lastFreeCreditsReset: timestamp,
                    },
                },
            );
        } else {
            // Mark legacy welcome packs as claimed without topping them up or reducing them.
            // Never use a version increase as permission to grant another pack.
            for (
                let attempt = 0;
                attempt < 20 && !user.welcomeGrantClaimedAt;
                attempt++
            ) {
                const claimedBefore =
                    (user.welcomePackVersion || 0) > 0 ||
                    (user.totalFreeCredits || 0) > 0;
                const updated = await User.findOneAndUpdate(
                    {
                        _id: user._id,
                        welcomeGrantClaimedAt: null,
                        welcomePackVersion: expected(
                            user,
                            'welcomePackVersion',
                        ),
                        totalFreeCredits: expected(user, 'totalFreeCredits'),
                    },
                    {
                        $set: {
                            totalFreeCredits: claimedBefore
                                ? user.totalFreeCredits || 0
                                : rules.welcomeCredits,
                            welcomePackVersion: Math.max(
                                1,
                                user.welcomePackVersion || 0,
                            ),
                            welcomeGrantClaimedAt: now(),
                        },
                    },
                    { returnDocument: 'after' },
                ).lean();
                if (updated) return updated;
                user = await byCode(user.recoveryCode);
            }
            if (!user.welcomeGrantClaimedAt)
                throw new CreditError(409, 'Balance changed; please try again');
        }
        return byCode(user.recoveryCode);
    }

    async function prepared(code, rules) {
        return ensureAllowance(await byCode(code), rules);
    }

    async function register(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new CreditError(400, 'Invalid registration');
        const { platform = 'other', deviceId } = input;
        if (
            typeof platform !== 'string' ||
            !['ios', 'android', 'web', 'other'].includes(platform.toLowerCase())
        ) {
            throw new CreditError(400, 'Invalid platform');
        }
        if (
            deviceId != null &&
            (typeof deviceId !== 'string' ||
                !deviceId.trim() ||
                deviceId.length > 512)
        ) {
            throw new CreditError(400, 'Invalid device identity');
        }
        const rules = await currentPolicy();
        let existing = deviceId
            ? await User.findOne({ deviceId }).lean()
            : null;
        let code = existing?.recoveryCode || generateCode();
        let registration;
        if (deviceId) {
            const key = createHash('sha256').update(deviceId).digest('hex');
            try {
                registration = await CreditRegistration.findOneAndUpdate(
                    { _id: key },
                    {
                        $setOnInsert: { recoveryCode: code, createdAt: now() },
                    },
                    { upsert: true, returnDocument: 'after' },
                );
            } catch (error) {
                if (error.code !== 11000) throw error;
                registration = await CreditRegistration.findById(key);
                if (!registration) throw error;
            }
            code = registration.recoveryCode;
        }
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                const initial = {
                    recoveryCode: code,
                    deviceId: deviceId || null,
                    platform: platform.toLowerCase(),
                    credits: 0,
                    adCredits: 0,
                    freeCreditsRemaining: rules.daily ? rules.dailyLimit : 0,
                    lastFreeCreditsReset: now(),
                    totalFreeCredits: rules.daily ? 0 : rules.welcomeCredits,
                    welcomePackVersion: rules.daily ? 0 : 1,
                    welcomeGrantClaimedAt: rules.daily ? null : now(),
                };
                const inserted = deviceId
                    ? await User.findOneAndUpdate(
                          { recoveryCode: code, deviceId },
                          {
                              $setOnInsert: initial,
                          },
                          {
                              upsert: true,
                              returnDocument: 'after',
                              setDefaultsOnInsert: true,
                          },
                      ).lean()
                    : (await User.create(initial)).toObject();
                const user = await ensureAllowance(inserted, rules);
                return {
                    ...balance(user, rules),
                    recoveryCode: user.recoveryCode,
                    isExistingDevice: !!existing,
                };
            } catch (error) {
                if (error.code !== 11000) throw error;
                // An identical device registration may have inserted the same user concurrently.
                const registered = await User.findOne({
                    recoveryCode: code,
                }).lean();
                if (
                    deviceId &&
                    registered &&
                    registered.deviceId === deviceId
                ) {
                    return {
                        ...balance(
                            await ensureAllowance(registered, rules),
                            rules,
                        ),
                        recoveryCode: code,
                        isExistingDevice: true,
                    };
                }
                // A rare generated-code collision must never expose another device's account.
                const replacement = generateCode();
                if (registration) {
                    registration =
                        (await CreditRegistration.findOneAndUpdate(
                            { _id: registration._id, recoveryCode: code },
                            {
                                $set: { recoveryCode: replacement },
                            },
                            { returnDocument: 'after' },
                        )) ||
                        (await CreditRegistration.findById(registration._id));
                    code = registration.recoveryCode;
                } else code = replacement;
            }
        }
        throw new CreditError(
            409,
            'Could not finish registration; please try again',
        );
    }

    async function getBalance(code) {
        const rules = await currentPolicy();
        const user = await prepared(code, rules);
        await User.updateOne(
            { _id: user._id },
            { $set: { lastActive: now() } },
        );
        const confirmed = await byCode(code);
        return {
            ...balance(confirmed, rules),
            ...subscriptionUsage(confirmed, await getAppConfig(), now()),
        };
    }

    async function use(code, amount) {
        positiveAmount(amount);
        const rules = await currentPolicy();
        let user = await prepared(code, rules);
        for (let attempt = 0; attempt < 30; attempt++) {
            const before = balance(user, rules);
            if (before.totalAvailable < amount) {
                throw new CreditError(400, 'Insufficient credits', {
                    available: before.totalAvailable,
                    required: amount,
                });
            }
            const free = Math.min(before.freeCreditsRemaining, amount);
            const ad = Math.min(before.adCredits, amount - free);
            const paid = amount - free - ad;
            const updated = await User.findOneAndUpdate(
                {
                    _id: user._id,
                    [rules.field]: expected(user, rules.field),
                    adCredits: expected(user, 'adCredits'),
                    credits: expected(user, 'credits'),
                },
                {
                    $inc: {
                        [rules.field]: -free,
                        adCredits: -ad,
                        credits: -paid,
                    },
                    $set: { lastActive: now() },
                },
                { returnDocument: 'after' },
            ).lean();
            if (updated) {
                const after = balance(updated, rules);
                return {
                    ...after,
                    creditsUsed: amount,
                    remainingCredits: after.credits,
                    remainingAdCredits: after.adCredits,
                    remainingFreeCredits: after.freeCreditsRemaining,
                };
            }
            user = await byCode(code);
        }
        throw new CreditError(409, 'Balance changed; please try again');
    }

    async function recover(code, currentCode) {
        const target = recoveryCode(code);
        const previous = currentCode == null ? null : recoveryCode(currentCode);
        const rules = await currentPolicy();
        await prepared(target, rules);
        // Switching accounts must never delete a device's registration or remaining allowance.
        await User.updateOne(
            { recoveryCode: target },
            { $set: { lastActive: now() } },
        );
        const user = await byCode(target);
        return {
            ...balance(user, rules),
            recoveryCode: target,
            message:
                target === previous
                    ? 'Already using this account!'
                    : 'Account recovered successfully!',
        };
    }

    async function grantPurchase(code, transactionIds, amount, source) {
        positiveAmount(amount);
        const clean = recoveryCode(code);
        const aliases = [
            ...new Set(
                transactionIds.filter(
                    (id) =>
                        typeof id === 'string' &&
                        id.length > 0 &&
                        id.length <= 512,
                ),
            ),
        ];
        if (!aliases.length)
            throw new CreditError(
                400,
                'Verified transaction identity is required',
            );
        const account = await byCode(clean);
        if (
            !Number.isSafeInteger(account.credits ?? 0) ||
            (account.credits ?? 0) < 0 ||
            (account.credits ?? 0) > Number.MAX_SAFE_INTEGER - amount
        ) {
            throw new CreditError(
                503,
                'This credit balance needs support review',
            );
        }
        const previousOwner = await User.findOne({
            recoveryCode: { $ne: clean },
            $or: [
                { 'processedTransactions.transactionId': { $in: aliases } },
                { processedPurchaseAliases: { $in: aliases } },
            ],
        })
            .select('recoveryCode')
            .lean();
        if (previousOwner)
            throw new CreditError(
                409,
                'This purchase is already linked to another account',
            );
        for (const alias of [...aliases].sort()) {
            const key = createHash('sha256').update(alias).digest('hex');
            let claim;
            try {
                claim = await PurchaseClaim.findOneAndUpdate(
                    { _id: key },
                    {
                        $setOnInsert: { recoveryCode: clean, createdAt: now() },
                    },
                    { upsert: true, returnDocument: 'after' },
                );
            } catch (error) {
                if (error.code !== 11000) throw error;
                claim = await PurchaseClaim.findById(key);
                if (!claim) throw error;
            }
            if (claim.recoveryCode !== clean)
                throw new CreditError(
                    409,
                    'This purchase is already linked to another account',
                );
        }
        const updated = await User.findOneAndUpdate(
            {
                recoveryCode: clean,
                'processedTransactions.transactionId': { $nin: aliases },
                processedPurchaseAliases: { $nin: aliases },
                $or: [
                    { credits: { $exists: false } },
                    {
                        credits: {
                            $gte: 0,
                            $lte: Number.MAX_SAFE_INTEGER - amount,
                        },
                    },
                ],
            },
            {
                $inc: { credits: amount },
                $addToSet: { processedPurchaseAliases: { $each: aliases } },
                $push: {
                    processedTransactions: {
                        $each: aliases.map((transactionId, i) => ({
                            transactionId,
                            credits: i === 0 ? amount : 0,
                            source,
                            processedAt: now(),
                        })),
                    },
                },
            },
            { returnDocument: 'after' },
        );
        if (updated) return { applied: true, user: updated };
        const latest = await byCode(clean);
        if (
            !aliases.some(
                (alias) =>
                    latest.processedPurchaseAliases?.includes(alias) ||
                    latest.processedTransactions?.some(
                        (tx) => tx.transactionId === alias,
                    ),
            )
        ) {
            throw new CreditError(
                503,
                'This credit balance needs support review',
            );
        }
        // Learn additional verified aliases even when the legacy transaction was
        // already credited, so a later webhook cannot credit it under another ID.
        await User.updateOne(
            { recoveryCode: clean },
            { $addToSet: { processedPurchaseAliases: { $each: aliases } } },
        );
        return { applied: false, user: await byCode(clean) };
    }

    async function claimAd(code) {
        const config = await getAppConfig();
        const rules = policy(config);
        if (!config.adRewards?.enabled || !config.adRewards?.active) {
            throw new CreditError(403, 'Ad rewards are currently unavailable');
        }
        const reward = config.adRewards.specialOfferActive
            ? config.adRewards.specialReward
            : config.adRewards.standardReward;
        positiveAmount(reward);
        const user = await prepared(code, rules);
        const timestamp = now();
        const midnight = new Date(timestamp);
        midnight.setUTCHours(0, 0, 0, 0);
        const updated = await User.findOneAndUpdate(
            {
                _id: user._id,
                $or: [
                    { lastAdRewardDate: null },
                    { lastAdRewardDate: { $lt: midnight } },
                ],
            },
            {
                $inc: { adCredits: reward },
                $set: { lastAdRewardDate: timestamp },
            },
            { returnDocument: 'after' },
        );
        if (!updated)
            return {
                success: false,
                alreadyClaimed: true,
                message: 'You have already claimed your daily ad reward!',
                nextClaimTime: 'tomorrow',
            };
        return {
            ...balance(updated, rules),
            creditsAdded: reward,
            newBalance: updated.adCredits,
            message: `You earned ${reward} credit${reward === 1 ? '' : 's'}!`,
        };
    }

    return {
        register,
        balance: getBalance,
        use,
        recover,
        grantPurchase,
        claimAd,
        byCode,
        async syncWelcomePack(code) {
            const result = await getBalance(code);
            return {
                ...result,
                newBalance: result.freeCreditsRemaining,
                version: result.userServerVersion,
            };
        },
    };
}

module.exports = { createCredits, generateCode };
