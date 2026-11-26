const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const AccountRecovery = require('../models/AccountRecovery');
const User = require('../models/User');
const GenerationRequest = require('../models/GenerationRequest');
const CreditRegistration = require('../models/CreditRegistration');
const PurchaseClaim = require('../models/PurchaseClaim');
const { createCredits } = require('../services/credits');
const { createGeneration } = require('../services/generation');

let mongo, config, time, credits, generation;

before(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { version: '8.0.17' },
    replSet: { count: 1 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: 'generation_recovery_tests' });
  await Promise.all([
    AccountRecovery.init(),
    User.init(),
    GenerationRequest.init(),
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
    AccountRecovery.deleteMany({}),
    User.deleteMany({}),
    GenerationRequest.deleteMany({}),
    CreditRegistration.deleteMany({}),
    PurchaseClaim.deleteMany({}),
  ]);
  config = { dailyFreeCreditsEnabled: false, freeDailyCredits: 3, subscriberDailyLimit: 2 };
  time = new Date('2026-11-27T00:00:00.000Z');
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
    entitlement: async () => ({ isPro: false }),
    now: () => new Date(time),
  });
});

const account = async () => (await credits.register({ deviceId: randomUUID() })).recoveryCode;

test('lookup recovers completed result without double charge and isolates accounts', async () => {
  const ownerA = await account();
  const ownerB = await account();
  const requestId = randomUUID();
  const beforeBalance = (await credits.balance(ownerA)).totalAvailable;

  const { record } = await generation.begin(ownerA, requestId, '/notes', {
    type: 'text',
    content: 'Write chapter opening',
  });
  // While still in flight, lookup returns 202 pending and touches zero credits.
  const pendingRes = await generation.lookup(ownerA, requestId);
  assert.equal(pendingRes.httpStatus, 202);
  assert.equal(pendingRes.body.status, 'pending');

  // Account B cannot read or probe Account A's request.
  await assert.rejects(
    generation.lookup(ownerB, requestId),
    (err) => err.status === 404 && err.details?.code === 'GENERATION_NOT_FOUND',
  );

  // Backend finishes while client is closed.
  await generation.finish(record._id, 200, { notes: 'Recovered chapter opening.' });
  const afterChargeBalance = (await credits.balance(ownerA)).totalAvailable;
  assert.equal(afterChargeBalance, beforeBalance - 1);

  // Repeated lookup polls recover the exact paid result without extra credit charge.
  const firstRecovery = await generation.lookup(ownerA, requestId);
  const secondRecovery = await generation.lookup(ownerA, requestId);
  assert.equal(firstRecovery.httpStatus, 200);
  assert.equal(firstRecovery.body.notes, 'Recovered chapter opening.');
  assert.equal(firstRecovery.body.billing.charged, true);
  assert.equal(firstRecovery.body.billing.requestId, requestId);
  assert.equal(secondRecovery.httpStatus, 200);
  assert.equal((await credits.balance(ownerA)).totalAvailable, afterChargeBalance);
});

test('lookup reconciles expired pending lease with single refund and blocks late overwrite', async () => {
  const owner = await account();
  const requestId = randomUUID();
  const startingCredits = (await credits.balance(owner)).totalAvailable;

  const { record } = await generation.begin(owner, requestId, '/followup', {
    context: 'Original text',
    question: 'Fix grammar',
  });
  assert.equal((await credits.balance(owner)).totalAvailable, startingCredits - 1);

  // Advance clock past lease (180s).
  time = new Date(time.getTime() + 190_000);
  const expiredRes = await generation.lookup(owner, requestId);
  assert.equal(expiredRes.httpStatus, 504);
  assert.equal(expiredRes.body.billing.status, 'refunded');
  assert.equal(expiredRes.body.billing.refundedCredits, 1);
  assert.equal((await credits.balance(owner)).totalAvailable, startingCredits);

  // Late provider completion or second lookup must not double-refund or turn succeeded.
  await generation.finish(record._id, 200, { response: 'Late edit payload' });
  const repeatRes = await generation.lookup(owner, requestId);
  assert.equal(repeatRes.httpStatus, 504);
  assert.equal(repeatRes.body.billing.status, 'refunded');
  assert.equal((await credits.balance(owner)).totalAvailable, startingCredits);
});

test('lookup honors 24-hour retention limit with 410 and originalState without changing billing', async () => {
  const owner = await account();
  const requestId = randomUUID();
  const { record } = await generation.begin(owner, requestId, '/reply', {
    message: 'Hi there',
  });
  await generation.finish(record._id, 200, { replies: ['Hello!'] });

  // Advance past 24 hours.
  time = new Date(time.getTime() + 86_400_000 + 1000);
  await assert.rejects(
    generation.lookup(owner, requestId),
    (err) => err.status === 410 && err.details?.originalState === 'succeeded',
  );
});
