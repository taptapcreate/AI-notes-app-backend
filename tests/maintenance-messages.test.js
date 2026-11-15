const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Messages = require('../models/UserAnnouncement');
const AppConfig = require('../models/AppConfig');
const { maintenanceState, publicMaintenance, createMaintenanceGate } = require('../services/maintenance');
const { createUserAnnouncements } = require('../services/user-announcements');
const { CreditError } = require('../services/credit-policy');
const { createCreditRouter } = require('../routes/credits');
let mongo;
const credits={byCode:async code=>{
 if(!['USERAAAA','USERBBBB'].includes(code))throw new CreditError(404,'User not found');
 return {recoveryCode:code};
}};
before(async()=>{mongo=await MongoMemoryServer.create({binary:{version:'8.0.17'}});await mongoose.connect(mongo.getUri());await Messages.init();});
after(async()=>{await mongoose.disconnect();await mongo.stop();});
beforeEach(async()=>{await Messages.deleteMany({});});
test('global maintenance overrides platform settings and a local true affects only its platform', async t=>{
 const config={maintenance:{enabled:false,title:'Global title',message:'Global message',platforms:{ios:{enabled:true,message:'iOS work'}}}};
 assert.equal(maintenanceState(config,'ios').message,'iOS work');
 assert.equal(maintenanceState(config,'ios').enabled,true);
 for(const p of ['android','macos',undefined])assert.equal(maintenanceState(config,p).enabled,false);
 assert.equal(publicMaintenance(config).maintenance.platforms.ios.enabled,true);
 config.maintenance.enabled=true;assert.equal(maintenanceState(config,'android').enabled,true);assert.equal(maintenanceState(config,'ios').message,'Global message');config.maintenance.enabled=false;
 let charged=0;const app=express();app.use(createMaintenanceGate({getAppConfig:async()=>config}));app.use((_req,res)=>{charged++;res.json({ok:true});});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/notes`;
 assert.equal((await fetch(url,{method:'POST',headers:{'X-App-Platform':'ios'}})).status,503);assert.equal(charged,0);
 assert.equal((await fetch(url,{method:'POST',headers:{'X-App-Platform':'android'}})).status,200);assert.equal(charged,1);
 config.maintenance.platforms.ios.enabled=false;assert.equal((await fetch(url,{method:'POST',headers:{'X-App-Platform':'ios'}})).status,200);
});
test('private messages authenticate the account and ignore a different code in query parameters', async t=>{
 await Messages.create([{recoveryCode:'USERAAAA',active:true,message:'Private A'}, {recoveryCode:'USERBBBB',active:true,message:'Private B'}]);
 const app=express();app.use('/credits',createCreditRouter({credits,purchases:{}}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/credits/announcement`;
 assert.equal((await fetch(url)).status,401);
 const response=await fetch(url+'?recoveryCode=USERBBBB',{headers:{Authorization:'Bearer useraaaa','X-App-Platform':'ios'}});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const body=await response.json();assert.equal(body.announcement.message,'Private A');assert.equal(JSON.stringify(body).includes('Private B'),false);assert.match(body.accountScope,/^[a-f0-9]{64}$/);
 assert.equal((await fetch(url,{headers:{Authorization:'Bearer UNKNOWN1'}})).status,404);
});
test('inactive, expired and platform-restricted personal messages are omitted',async()=>{
 const read=createUserAnnouncements({Messages,credits,now:()=>new Date('2026-11-15')});
 const doc=await Messages.create({recoveryCode:'USERAAAA',message:'Private'});
 assert.equal((await read('Bearer USERAAAA','ios')).announcement,null);
 await Messages.updateOne({_id:doc._id},{$set:{active:true,platforms:['macos']}});
 assert.equal((await read('Bearer USERAAAA','ios')).announcement,null);
 assert.equal((await read('Bearer USERAAAA','macos')).announcement.displayMode,'banner');
 await Messages.updateOne({_id:doc._id},{$set:{expiresAt:new Date('2026-11-14')}});assert.equal((await read('Bearer USERAAAA','macos')).announcement,null);
});
test('new maintenance flags and personal messages default to inactive',()=>{
 const config=new AppConfig({maintenance:{}});
 for(const p of ['ios','android','macos'])assert.equal(config.maintenance.platforms[p].enabled,false);assert.equal(config.maintenance.enabled,false);
 const message=new Messages({recoveryCode:' useraaaa '});assert.equal(message.recoveryCode,'USERAAAA');assert.equal(message.active,false);assert.equal(message.displayMode,'banner');
});

test('initialization adds missing controls once and preserves operator switches and messages', async()=>{
 const { initializeMessageControls: initialize }=require('../services/message-controls-init');
 await AppConfig.deleteMany({});
 await AppConfig.collection.insertOne({key:'master_config',maintenance:{enabled:false,message:'Keep this',platforms:{ios:{enabled:true,message:'Keep iOS'}}}});
 await initialize({Config:AppConfig,Messages});await initialize({Config:AppConfig,Messages});
 const config=await AppConfig.collection.findOne({key:'master_config'});
 assert.equal(config.maintenance.enabled,false);assert.equal(config.maintenance.message,'Keep this');
 assert.equal(config.maintenance.platforms.ios.enabled,true);assert.equal(config.maintenance.platforms.ios.message,'Keep iOS');
 assert.equal(config.maintenance.platforms.android.enabled,false);assert.equal(config.maintenance.platforms.macos.enabled,false);
 await AppConfig.deleteMany({});await AppConfig.collection.insertOne({key:'master_config',globalAlert:{active:true,isBlocking:true,message:'Legacy outage'}});
 await initialize({Config:AppConfig,Messages});const legacy=await AppConfig.collection.findOne({key:'master_config'});
 assert.equal(legacy.maintenance.enabled,true);assert.equal(legacy.maintenance.message,'Legacy outage');
});
