const {test} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {once} = require('node:events');
const {createCreditRouter} = require('../routes/credits');
const {createPurchases} = require('../services/purchases');
const {CreditError} = require('../services/credit-policy');
test('subscription display verifies the requested account, exposes plan metadata, and rejects outages', async () => {
  let status = {isPro:true,plan:'monthly',expiresAt:'2027-01-01T00:00:00.000Z'};
  const app=express(); app.use(express.json());
  app.use(createCreditRouter({credits:{byCode:async code => {
    if(code!=='TESTCODE') throw new CreditError(404,'User not found');
    return {recoveryCode:code};
  }},purchases:{subscriptionStatus:async user => {
    assert.equal(user.recoveryCode,'TESTCODE');
    if(status instanceof Error) throw status;
    return status;
  }},logger:{error(){},warn(){}}}));
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const call=code => fetch(`http://127.0.0.1:${server.address().port}/subscription`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  try {
    assert.deepEqual(await (await call('TESTCODE')).json(),{status:'active',plan:'monthly',expiresAt:'2027-01-01T00:00:00.000Z'});
    status={isPro:false}; assert.equal((await (await call('TESTCODE')).json()).status,'inactive');
    status=new CreditError(503,'Verification unavailable'); assert.equal((await call('TESTCODE')).status,503);
    assert.equal((await call('UNKNOWN')).status,404);
  } finally {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
});
test('only a verified active subscription provides display metadata', async () => {
  const product='ai_notes_pro_weekly_subscription';
  const subscriber={entitlements:{pro:{product_identifier:product,expires_date:'2099-01-01T00:00:00Z'}},subscriptions:{[product]:{is_sandbox:false}}};
  const purchases=createPurchases({apiKey:'test',credits:{},axios:{get:async()=>({data:{subscriber}})}});
  assert.deepEqual(await purchases.subscriptionStatus({recoveryCode:'TESTCODE'}),{isPro:true,plan:'weekly',expiresAt:'2099-01-01T00:00:00.000Z'});
  subscriber.subscriptions[product].refunded_at='2026-01-01';
  assert.deepEqual(await purchases.subscriptionStatus({recoveryCode:'TESTCODE'}),{isPro:false});
});
