const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { maintenanceState, publicMaintenance, createMaintenanceGate } = require('../services/maintenance');

test('maintenance normalization uses explicit boolean, bounds messages, and preserves legacy alerts', () => {
 assert.equal(maintenanceState({}).enabled,false);
 assert.equal(maintenanceState({maintenance:{enabled:false},globalAlert:{active:true,isBlocking:true}}).enabled,false);
 assert.equal(maintenanceState({globalAlert:{active:true,isBlocking:true}}).enabled,true);
 assert.equal(maintenanceState({globalAlert:{active:true,isBlocking:false}}).enabled,false);
 assert.equal(maintenanceState({maintenance:{enabled:true,title:'x'.repeat(200),message:'x'.repeat(3000)}}).message.length,2000);
 assert.equal(publicMaintenance({maintenance:{enabled:true,title:'Work',message:'Later'}}).globalAlert.isBlocking,true);
 assert.equal(publicMaintenance({maintenance:{enabled:false},globalAlert:{active:true,isBlocking:true}}).globalAlert.active,false);
});

test('maintenance blocks user operations before billing, keeps reconciliation available, and switches off dynamically', async (t) => {
 let config={maintenance:{enabled:false}}, charges=0, lookups=0;
 const app=express();
 app.use('/api',createMaintenanceGate({ getAppConfig:async()=>{lookups++;return config;} }));
 app.use('/api',(_req,res)=>{charges++;res.json({ok:true});});
 const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api`;
 assert.equal((await fetch(base+'/notes',{method:'POST'})).status,200);
 assert.equal(charges,1);
 config={maintenance:{enabled:true,title:'Scheduled update',message:'Back soon'}};
 for(const route of ['/notes','/notes/stream','/reply','/followup','/polish','/translate','/sentiment','/credits/use','/credits/register','/credits/recover','/credits/claim-ad-reward']) {
   const response=await fetch(base+route,{method:'POST'});
   assert.equal(response.status,503,route); assert.equal(response.headers.get('retry-after'),'30');
   const body=await response.json();assert.equal(body.code,'APP_MAINTENANCE');assert.equal(body.maintenance.message,'Back soon');
 }
 assert.equal(charges,1,'no protected handler or billing may run');
 const before=lookups;
 for (const route of ['/config','/health','/webhooks/revenuecat','/credits/add','/credits/subscription','/credits/balance/EXAMPLE','/admin/support']) {
   assert.equal((await fetch(base+route)).status,200,route);
 }
 assert.equal(lookups,before,'recovery paths must work even if config cannot be read');
 config={maintenance:{enabled:false}};
 assert.equal((await fetch(base+'/notes',{method:'POST'})).status,200);
});
