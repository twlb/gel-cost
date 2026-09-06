const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const date=new Date().toISOString().slice(0,10)+'T00:00:00Z';
const snapshot=()=>({usdRub:88,usdGel:2.62,updatedAt:date,fetchedAt:new Date().toISOString(),sources:{usdRub:{date},usdGel:{date}}});
const banks=()=>({schemaVersion:1,currency:'USD',unit:'GEL per USD',channel:'Branch',userType:'PhysicalPerson',queryAmountGel:1000,fetchedAt:new Date().toISOString(),offers:[{id:'1',bank:'A',buy:2.6,sell:2.7},{id:'2',bank:'B',buy:2.61,sell:2.7},{id:'3',bank:'C',buy:2.62,sell:2.7}]});

test('strict decimal input supports comma, spaces and dots',()=>{
  for(const [text,n] of [['1 234,50',1234.5],['0',0],['2.62',2.62],['88\u202f000',88000]])assert.equal(C.number(text),n);
  for(const text of ['',null,undefined,'12abc','1,2,3','1e309','Infinity',true,{},'-1','0x10'])assert.ok(Number.isNaN(C.number(text)),String(text));
});
test('weighted basis uses sums, not mean of exchange rates',()=>near(C.weighted([{rub:8800,qty:100},{rub:18000,qty:200}]),26800/300));
test('empty, negative and invalid purchases do not become zero-cost funds',()=>{
  assert.ok(Number.isNaN(C.weighted([])));
  near(C.weighted([null,{rub:-500,qty:10},{rub:8800,qty:100}]),88);
  assert.ok(Number.isNaN(C.weighted([{rub:1e308,qty:1},{rub:1e308,qty:1}])));
});
test('cash and Bybit routes use separate RUB purchase bases',()=>{
  const s={...C.defaults(),usdPurchases:[{rub:8800,qty:100}],usdtPurchases:[{rub:8655,qty:100}],cashGelRate:2.62,bybitRateMode:'quote',bybitGelRate:2.58,feePct:2,cashbackPct:0};
  near(C.routes(s).cash,88/2.62);near(C.routes(s).bybit,86.55*1.02/2.58);
});
test('actual charge never deducts unreceived or percentage cashback',()=>{
  near(C.actualRate(50,19.78),50/19.78);
  near(C.actualRate(50,19.78,0.3),50/19.48);
  const s={...C.defaults(),usdtPurchases:[{rub:8655,qty:100}],bybitActual:{gel:50,charged:19.78,reward:0},feePct:5,cashbackPct:9};
  near(C.routes(s).bybit,86.55*19.78/50);
  for(const reward of [-1,19.78,20,'bogus'])assert.ok(Number.isNaN(C.actualRate(50,19.78,reward)));
});
test('migrates V5.4 effective rate once without changing purchases',()=>{
  const raw={schemaVersion:54,usdPurchases:[{rub:8800,qty:100}],bybitRateMode:'actual',bybitActualGelRate:50/(19.78*.98),cashbackPct:2};
  const migrated=C.migrate(raw);
  near(migrated.bybitActualGelRate,50/19.78);
  assert.deepEqual(migrated.usdPurchases,raw.usdPurchases);
  near(C.migrate(migrated).bybitActualGelRate,50/19.78);
  assert.equal(migrated.legacyActualAdjusted,true);
});
test('legacy real purchase is not guessed to be a demo and deleted',()=>assert.equal(C.migrate({usdPurchases:[{rub:8800,qty:100}]}).usdPurchases.length,1));
test('loads canonical state, then the actual V5.4 writer before stale named keys',()=>{
  const values={'gelcost-v5':JSON.stringify({schemaVersion:54,usdEstimate:90}),'gelcost-v5.4':JSON.stringify({schemaVersion:54,usdEstimate:80})};
  const storage={getItem:k=>values[k]};
  assert.equal(C.load(storage).state.usdEstimate,90);
  values[C.STORAGE_KEY]=JSON.stringify({schemaVersion:55,usdEstimate:95});
  assert.equal(C.load(storage).state.usdEstimate,95);
});
test('corrupt or denied storage produces a warning, not a crash',()=>{
  assert.ok(C.load({getItem(){throw Error('denied')}}).warning);
  assert.ok(C.load({getItem(){return '[]'}}).warning);
});
test('freshness rejects unknown, invalid, future and expired timestamps',()=>{
  const now=Date.now();assert.equal(C.fresh(now,1000,now),true);
  for(const value of [null,'invalid',0,now+600000,now-1001])assert.equal(C.fresh(value,1000,now),false);
});
test('official snapshots require both effective dates and valid values',()=>{
  assert.equal(C.official(snapshot()).usdRub,88);
  assert.throws(()=>C.official({...snapshot(),usdRub:'88abc'}));
  assert.throws(()=>C.official({...snapshot(),sources:{}}));
  assert.throws(()=>C.official({...snapshot(),fetchedAt:new Date(Date.now()+86400000).toISOString()}));
  const s=snapshot();s.sources.usdGel.date='2099-01-01';assert.throws(()=>C.official(s));
});
test('bank snapshots validate side, channel, sample size, duplicates and spread',()=>{
  assert.equal(C.bankSnapshot(banks()).offers[0].id,'3');
  for(const edit of [s=>s.channel='InternetBank',s=>s.offers.pop(),s=>s.offers[1].id='1',s=>s.offers[0].buy=3,s=>s.offers[0].buy=0,s=>s.fetchedAt='invalid',s=>s.currency='RUB']){
    const s=banks();edit(s);assert.throws(()=>C.bankSnapshot(s));
  }
});

test('office snapshots require known identities, explicit failures, correct units and individual dates',()=>{
  const stamp=new Date().toISOString();
  const valid={schemaVersion:1,currency:'USD',unit:'GEL per USD',channel:'Cash',side:'buy',fetchedAt:stamp,offers:[{id:'mjc',buy:2.613,sell:2.616,nominal:1,checkedAt:stamp,sourceUpdatedAt:null}],failures:['rico']};
  assert.equal(C.officeSnapshot(valid).offers[0].buy,2.613);
  for(const edit of [s=>s.currency='RUB',s=>s.side='sell',s=>s.offers[0].id='constructor',s=>s.offers[0].nominal=100,s=>s.offers[0].buy=3,s=>s.offers[0].checkedAt='bad',s=>s.failures=[],s=>s.offers.push({...s.offers[0]})]){
    const s=structuredClone(valid);edit(s);assert.throws(()=>C.officeSnapshot(s));
  }
});
test('corrupt authoritative V5.5 storage cannot be silently replaced by an older fallback',()=>{
  const values={'gelcost-v5.5-personal':'broken','gelcost-v5.3':JSON.stringify({usdEstimate:88})};
  assert.equal(C.load({getItem:key=>values[key]}).readBlocked,true);
});
