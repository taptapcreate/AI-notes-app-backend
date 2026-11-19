const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createRequestConfig } = require('../services/request-config');

test('one generation shares one config load across middleware, concurrent checks and settlement, but the next request is fresh', async t => {
    let reads = 0, revision = 1;
    const config = createRequestConfig(async () => { reads++; return { revision }; });
    const app = express();
    app.use('/api', config.middleware);
    app.use('/api', async (_req, res, next) => { res.locals.first = await config.getAppConfig(); next(); });
    app.post('/api/notes', async (_req, res) => {
        const values = await Promise.all([config.getAppConfig(), config.getAppConfig()]);
        await new Promise(resolve => setImmediate(resolve));
        const settled = await config.getAppConfig();
        assert.equal(values[0], res.locals.first); assert.equal(settled, values[1]);
        res.json(settled);
    });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/notes`;
    assert.equal((await (await fetch(url, { method: 'POST' })).json()).revision, 1);
    assert.equal(reads, 1);
    revision = 2;
    assert.equal((await (await fetch(url, { method: 'POST' })).json()).revision, 2);
    assert.equal(reads, 2);
    await config.getAppConfig(); await config.getAppConfig();
    assert.equal(reads, 4, 'non-generation operations are not cached');
});

test('independent concurrent requests cannot share configuration snapshots', async () => {
    let reads = 0;
    const config = createRequestConfig(async () => ({ revision: ++reads }));
    const one = () => new Promise((resolve, reject) => config.middleware({ method: 'POST', path: '/followup' }, {}, () => {
        Promise.all([config.getAppConfig(), config.getAppConfig()]).then(resolve, reject);
    }));
    const [a, b] = await Promise.all([one(), one()]);
    assert.equal(a[0], a[1]); assert.equal(b[0], b[1]); assert.notEqual(a[0], b[0]); assert.equal(reads, 2);
});
