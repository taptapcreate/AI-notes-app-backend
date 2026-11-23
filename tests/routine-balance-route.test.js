const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { createCreditRouter } = require('../routes/credits');
const { createPurchases } = require('../services/purchases');

test('HTTP balance polling skips repeated provider work but returns current balance every time', async t => {
    let balance = 7, providerReads = 0, accountReads = 0;
    const credits = {
        readAccount: async code => { accountReads++; return { recoveryCode: code }; },
        refreshBalance: async () => ({ totalAvailable: balance }),
        byCode: () => { throw Error('Polling must not rewrite the account checkpoint'); },
        balance: () => { throw Error('Polling must use the lightweight balance path'); },
    };
    const purchases = createPurchases({ credits, apiKey: 'test', axios: { get: async () => {
        providerReads++;
        return { data: { subscriber: { non_subscriptions: {} } } };
    } } });
    const app = express();
    app.use('/api/credits', createCreditRouter({ credits, purchases }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}/api/credits/balance/TESTCODE`;
    assert.equal((await (await fetch(url)).json()).totalAvailable, 7);
    balance = 3;
    assert.equal((await (await fetch(url)).json()).totalAvailable, 3);
    assert.equal(providerReads, 1);
    assert.equal(accountReads, 2);
});
