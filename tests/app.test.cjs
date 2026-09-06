// Unit-level DOM harness. Real-browser interaction is a separate QA pass.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const C=require('../core.js');
const root=path.join(__dirname,'..');
const day=new Date().toISOString().slice(0,10)+'T00:00:00Z';
const official=()=>({usdRub:88,usdGel:2.62,updatedAt:day,fetchedAt:new Date().toISOString(),sources:{usdRub:{date:day},usdGel:{date:day}}});
const bankData=()=>({schemaVersion:1,currency:'USD',unit:'GEL per USD',channel:'Branch',userType:'PhysicalPerson',queryAmountGel:1000,fetchedAt:new Date().toISOString(),offers:[{id:'1',bank:'A',buy:2.6,sell:2.7},{id:'2',bank:'B',buy:2.61,sell:2.7},{id:'3',bank:'C',buy:2.62,sell:2.7}]});
const officeData=()=>{const stamp=new Date().toISOString();return {schemaVersion:1,currency:'USD',unit:'GEL per USD',channel:'Cash',side:'buy',fetchedAt:stamp,offers:[{id:'mjc',buy:2.613,sell:2.616,nominal:1,checkedAt:stamp,sourceUpdatedAt:null},{id:'rico',buy:2.61,sell:2.615,nominal:1,checkedAt:stamp,sourceUpdatedAt:null}],failures:[]};};
class Element{
  constructor(){this.dataset={};this.value='';this.textContent='';this.hidden=false;this.innerHTML='';this.children=[];this.events={};this.attrs={};this.classes=new Set();this.classList={contains:k=>this.classes.has(k),add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),toggle:(k,on)=>{if(on===undefined)on=!this.classes.has(k);on?this.classes.add(k):this.classes.delete(k);}};}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,fn){this.events[k]=fn;}
  appendChild(node){node.parentElement=this;this.children.push(node);}
  replaceChildren(...nodes){this.children=nodes;this.value=nodes[0]?.value||'';}
  add(node){this.children.push(node);}
  focus(){}
  click(){this.clicked=true;}
}
function sharedBrowser(saved={}){
  const shared={writes:{...saved},listeners:new Set(),events:[],failWrites:false};
  let queue=Promise.resolve();
  shared.locks={request:(name,options,fn)=>{
    const result=queue.then(()=>{if(options.signal.aborted)throw Error('aborted');return fn();});
    queue=result.catch(()=>{});return result;
  }};
  shared.flush=()=>{for(const fn of shared.events.splice(0))fn();};
  return shared;
}
async function app(saved={},blocked=false,options={}){
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const els={};for(const id of html.matchAll(/\bid="([^"]+)"/g))els[id[1]]=new Element();
  els.quickGel.value='100';els.exchangeAmount.value='100';els.exchangeCity.value='tbilisi';
  const responses={'./rates.json':official(),'./market-rates.json':bankData(),'./exchange-rates.json':officeData()};
  const shared=options.shared||sharedBrowser(saved);
  const timers=new Map();let tid=0,now=Date.now();const writes=shared.writes,downloads=[],requests=[];
  const events={},documentEvents={};
  const receive=event=>events.storage?.(event);
  shared.listeners.add(receive);
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const store={getItem:k=>{if(blocked)throw Error('denied');return writes[k]||null;},setItem:(k,v)=>{
    if(blocked||shared.failWrites)throw Error('denied');
    writes[k]=v;
    for(const listener of shared.listeners)if(listener!==receive)shared.events.push(()=>listener({key:k}));
  }};
  const ctx=vm.createContext({
    console,Intl,Date:Clock,Number,Math,JSON,Promise,AbortController,Blob,URL,Option:class{constructor(text,value){this.text=text;this.value=value;}},
    localStorage:store,navigator:{locks:options.noLocks?undefined:shared.locks},
    addEventListener:(name,fn)=>events[name]=fn,
    document:{getElementById:id=>els[id],hidden:false,addEventListener:(name,fn)=>documentEvents[name]=fn,createElement:tag=>{const e=new Element();if(tag==='a')downloads.push(e);return e;},querySelectorAll:()=>Object.values(els).filter(e=>e.classes.has('show'))},
    setTimeout:(fn,ms)=>{const id=++tid;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>timers.set(++tid,{fn,ms,interval:true}),
    fetch:async(url,options)=>{requests.push(url);if(responses[url] instanceof Error)throw responses[url];if(responses[url]==='hang')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));const data=await responses[url];return {ok:Boolean(data),json:async()=>structuredClone(data)};},
  });
  ctx.window=ctx;
  vm.runInContext(fs.readFileSync(path.join(root,'core.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'app.js'),'utf8'),ctx);
  const run=code=>vm.runInContext(code,ctx);
  const settle=()=>new Promise(resolve=>setImmediate(resolve));await settle();
  return {els,run,settle,responses,writes,timers,downloads,requests,shared,events,documentEvents,
    advance:ms=>{now+=ms;},state:()=>JSON.parse(run('JSON.stringify(state)'))};
}
const purchase=(a,kind,rub,qty)=>{a.run(`openPurchase('${kind}')`);a.els.purchaseRub.value=String(rub);a.els.purchaseQty.value=String(qty);return a.run('savePurchase()');};
const cash=(a,rate)=>{a.run('openRate("cash")');a.els.rateValue.value=String(rate);return a.run('saveRate()');};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('fresh profile has no invented purchases and both sources load',async()=>{
  const a=await app();assert.equal(a.state().usdPurchases.length,0);assert.equal(a.state().usdtPurchases.length,0);
  assert.equal(a.els.quickRub.textContent,'— ₽');assert.match(a.els.marketPrice.textContent,/33,5878/);assert.match(a.els.bankStatus.textContent,/3 банков/);
});
test('all displayed exchange rates have four decimals while money totals stay unchanged',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await purchase(a,'usdt',8655,100);await cash(a,2.62);
  assert.equal(a.els.cashAvg.textContent,'88,0000 ₽/$');
  assert.equal(a.els.usdtAvg.textContent,'86,5500 ₽/USDT');
  assert.equal(a.els.cashGelRate.textContent,'2,6200 ₾');
  assert.equal(a.els.cashPrice.textContent,'33,5878 ₽/₾');
  assert.match(a.els.cashTotal.textContent,/^≈ 3\s359 ₽$/);
  a.run('selectOffer("office:mjc")');
  assert.equal(a.els.exchangeReceive.textContent,'≈ 261,30 ₾');
  assert.match(a.els.exchangeBasis.textContent,/33,6778 ₽$/);
  a.run('openSettings()');
  assert.equal(a.els.officialRub.value,'88,0000');assert.equal(a.els.officialGel.value,'2,6200');
  near(a.run('routeValues().cash'),88/2.62);
});
test('editable rate pads four decimals without rounding a more precise saved quote',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  a.run('openRate("cash")');assert.equal(a.els.rateValue.value,'2,6200');await a.run('saveRate()');
  assert.equal(a.state().cashGelRate,2.62);
  await cash(a,2.62123456);const before=JSON.stringify(a.state().usdPurchases);
  a.run('openRate("cash")');assert.equal(a.els.rateValue.value,'2,62123456');await a.run('saveRate()');
  assert.equal(a.state().cashGelRate,2.62123456);assert.equal(a.els.cashGelRate.textContent,'2,6212 ₾');
  near(a.run('routeValues().cash'),88/2.62123456);
  assert.equal(JSON.stringify(a.state().usdPurchases),before);
});
test('actual Bybit preview displays four decimal rates without rounding its calculation',async()=>{
  const a=await app();await purchase(a,'usdt',8655,100);a.run('openRate("bybit")');
  a.els.actualGel.value='100';a.els.actualUsdt.value='38.75';a.run('updateRatePreview()');
  assert.match(a.els.ratePreview.textContent,/1 USDT = 2,5806 ₾/);
  assert.match(a.els.ratePreview.textContent,/1 ₾ ≈ 33,5381 ₽/);
  await a.run('saveRate()');
  assert.equal(a.els.bybitGelRate.textContent,'2,5806 ₾');assert.equal(a.els.bybitPrice.textContent,'33,5381 ₽/₾');
  near(a.run('routeValues().bybit'),86.55*38.75/100);
});
test('purchase, comma input, cash result and reload preserve canonical state',async()=>{
  const a=await app();await purchase(a,'usd','8 800,00','100');await cash(a,'2,62');
  assert.match(a.els.quickRub.textContent,/3\s359/);
  const b=await app(a.writes);near(b.run('routeValues().cash'),88/2.62);assert.equal(b.state().usdPurchases.length,1);
});
test('trailing text, blank and overflow inputs cannot silently save',async()=>{
  const a=await app();await purchase(a,'usd','8800abc','100');assert.equal(a.state().usdPurchases.length,0);
  assert.equal(a.els.purchaseError.classList.contains('show'),true);
  await cash(a,'2.6bad');assert.equal(a.state().cashGelRate,null);
  await purchase(a,'usd','8800','100');await cash(a,'2.62');
  for(const amount of ['-20','abc','','1e300']){a.els.quickGel.value=amount;a.run('calc()');assert.equal(a.els.quickRub.textContent,'— ₽');assert.equal(a.els.quickError.classList.contains('show'),true);}
});
test('actual Bybit charge includes only the explicit received reward',async()=>{
  const a=await app();await purchase(a,'usdt','8655','100');a.run('openRate("bybit")');a.els.actualGel.value='50';a.els.actualUsdt.value='19,78';await a.run('saveRate()');
  near(a.run('routeValues().bybit'),86.55*19.78/50);
  a.els.feePct.value='5';a.els.cashbackPct.value='9';await a.run('saveSettings()');near(a.run('routeValues().bybit'),86.55*19.78/50);
  a.run('openRate("bybit")');a.els.actualGel.value='50';a.els.actualUsdt.value='19.78';a.els.actualReward.value='0.30';await a.run('saveRate()');near(a.run('routeValues().bybit'),86.55*19.48/50);
  a.run('openRate("bybit")');a.els.actualGel.value='50';a.els.actualUsdt.value='19.78';a.els.actualReward.value='30';await a.run('saveRate()');assert.equal(a.els.rateError.classList.contains('show'),true);
});
test('quote mode uses configurable percentage assumptions and labels forecast',async()=>{
  const a=await app();await purchase(a,'usdt',8655,100);a.els.feePct.value='2';a.els.cashbackPct.value='0';await a.run('saveSettings()');a.run('openRate("bybit");setRateMode("quote")');a.els.rateValue.value='2.58';await a.run('saveRate()');
  near(a.run('routeValues().bybit'),86.55*1.02/2.58);assert.match(a.els.heroDetail.textContent,/прогноз/);
});
test('storage denial warns without stopping calculation',async()=>{
  const a=await app({},true);await purchase(a,'usd',8800,100);await cash(a,2.62);
  near(a.run('routeValues().cash'),88/2.62);assert.match(a.els.storageNotice.textContent,/Не удалось сохранить/);
});
test('invalid official response retains dated cached data and warns',async()=>{
  const a=await app();a.responses['./rates.json']={usdRub:0,usdGel:0};await a.run('refreshOfficial()');
  assert.match(a.els.marketPrice.textContent,/33,5878/);assert.equal(a.els.marketStatus.textContent,'сохранённый');assert.match(a.els.marketNote.textContent,/Свежесть не подтверждена/);
});
test('bank selection and refresh update quote without changing purchases',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.els.bankChoice.value='2';await a.run('applyBank()');near(a.run('routeValues().cash'),88/2.61);
  const before=JSON.stringify(a.state().usdPurchases);a.responses['./market-rates.json'].offers[1].buy=2.63;await a.run('refreshBanks()');
  near(a.run('routeValues().cash'),88/2.63);assert.equal(JSON.stringify(a.state().usdPurchases),before);
  await cash(a,2.64);assert.equal(a.state().cashBankId,null);
});
test('stale, missing and malformed bank snapshots cannot be newly applied',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.els.bankChoice.value='2';await a.run('applyBank()');
  a.responses['./market-rates.json'].fetchedAt=new Date(Date.now()-3*3600000).toISOString();await a.run('refreshBanks()');
  assert.equal(a.els.applyBankButton.disabled,true);assert.match(a.els.heroRoute.textContent,/сохранённым/);
  a.responses['./market-rates.json']=new Error('offline');await a.run('refreshBanks()');assert.match(a.els.heroRoute.textContent,/сохранённым/);
});
test('expired manual rate is not a current recommendation',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);a.run('state.cashGelUpdated=Date.now()-2*C.DAY;calc()');
  assert.match(a.els.heroRoute.textContent,/обновите/);assert.equal(a.els.cashCard.classList.contains('best'),false);
});
test('only one editor opens and reset requires matching confirmation',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.run('openPurchase("usd");openRate("cash")');
  assert.equal(a.els.purchasePanel.classList.contains('show'),false);assert.equal(a.els.ratePanel.classList.contains('show'),true);
  a.run('resetPeriod("usd",document.getElementById("cashCard"))');assert.equal(a.state().usdPurchases.length,1);
  await a.run('resetPeriod("usd",document.getElementById("cashCard"))');assert.equal(a.state().usdPurchases.length,0);
});
test('network wait is bounded and request is aborted',async()=>{
  const a=await app();a.responses.hang='hang';const promise=a.run('fetchJson("hang")');
  const abort=[...a.timers.values()].find(t=>t.ms===10000);assert.ok(abort);abort.fn();await assert.rejects(promise,/aborted/);
});
test('switching reset target restores the first button without deleting data',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await purchase(a,'usdt',8655,100);
  a.els.cashCard.textContent='Очистить покупки USD';a.els.bybitCard.textContent='Очистить покупки USDT';
  a.run('resetPeriod("usd",document.getElementById("cashCard"));resetPeriod("usdt",document.getElementById("bybitCard"))');
  assert.equal(a.els.cashCard.textContent,'Очистить покупки USD');assert.equal(a.state().usdPurchases.length,1);assert.equal(a.state().usdtPurchases.length,1);
});

test('regression: refreshing official rates in a stale tab never erases a purchase',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  await purchase(a,'usd',8800,100);
  const saved=shared.writes[C.STORAGE_KEY];
  // Deliberately withhold storage events: correctness must not depend on delivery.
  assert.equal(b.state().usdPurchases.length,0);
  await b.run('refreshOfficial()');
  assert.equal(shared.writes[C.STORAGE_KEY],saved);
  const reload=await app({},false,{shared});assert.equal(reload.state().usdPurchases.length,1);
  assert.equal(JSON.parse(saved).officialSnapshot,undefined);
  assert.ok(shared.writes[C.CACHE_KEYS.official]);
});
test('simultaneous purchases from two stale tabs are serialized and both survive',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  await Promise.all([purchase(a,'usd',8800,100),purchase(b,'usd',18000,200)]);
  shared.flush();
  for(const tab of [a,b]){assert.equal(tab.state().usdPurchases.length,2);near(tab.run('routeValues().usdAvg'),26800/300);}
  const reload=await app({},false,{shared});assert.equal(reload.state().usdPurchases.length,2);
});
test('simultaneous changes to different personal fields do not overwrite one another',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  b.els.feePct.value='3';b.els.cashbackPct.value='1';
  await Promise.all([purchase(a,'usdt',8655,100),b.run('saveSettings()'),cash(a,2.62)]);
  const s=JSON.parse(shared.writes[C.STORAGE_KEY]);
  assert.equal(s.usdtPurchases.length,1);assert.equal(s.feePct,3);assert.equal(s.cashbackPct,1);assert.equal(s.cashGelRate,2.62);
});
test('storage events update the history without replacing text being typed',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  b.run('openPurchase("usd")');b.els.purchaseRub.value='9000';b.els.purchaseQty.value='100';
  await purchase(a,'usd',8800,100);shared.flush();
  assert.equal(b.state().usdPurchases.length,1);assert.equal(b.els.purchaseRub.value,'9000');
  assert.equal(b.els.purchasePanel.classList.contains('show'),true);
  await b.run('savePurchase()');assert.equal(b.state().usdPurchases.length,2);
});
test('a stale tab cannot resurrect cleared purchases through rates or later edits',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared});await purchase(a,'usd',8800,100);
  const b=await app({},false,{shared});
  a.run('resetPeriod("usd",document.getElementById("cashCard"))');await a.run('resetPeriod("usd",document.getElementById("cashCard"))');
  await b.run('refreshOfficial()');await cash(b,2.64);await purchase(b,'usdt',8655,100);
  const s=JSON.parse(shared.writes[C.STORAGE_KEY]);assert.equal(s.usdPurchases.length,0);assert.equal(s.usdtPurchases.length,1);
});
test('reset confirmation is refused if a new purchase arrives before confirmation',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared});await purchase(a,'usd',8800,100);
  const b=await app({},false,{shared});
  a.run('resetPeriod("usd",document.getElementById("cashCard"))');
  await purchase(b,'usd',9000,100);
  await a.run('resetPeriod("usd",document.getElementById("cashCard"))');
  assert.equal(a.state().usdPurchases.length,2);assert.match(a.els.storageNotice.textContent,/История изменилась/);
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).usdPurchases.length,2);
});
test('bank refresh only writes the public cache and preserves a later manual choice',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared});await purchase(a,'usd',8800,100);
  a.els.bankChoice.value='2';await a.run('applyBank()');const b=await app({},false,{shared});
  await purchase(a,'usd',9000,100);await cash(a,2.65);const saved=shared.writes[C.STORAGE_KEY];
  b.responses['./market-rates.json'].offers[1].buy=2.63;await b.run('refreshBanks()');
  assert.equal(shared.writes[C.STORAGE_KEY],saved);shared.flush();
  assert.equal(b.state().cashBankId,null);assert.equal(b.state().cashGelRate,2.65);
});
test('V5.5 history is adopted without changing its legacy copy',async()=>{
  const legacy=JSON.stringify({...C.defaults(),usdPurchases:[{rub:8800,qty:100,ts:1},{rub:8800,qty:100,ts:1}]});
  const a=await app({'gelcost-v5.5':legacy});assert.equal(a.state().usdPurchases.length,2);
  await purchase(a,'usd',9000,100);
  assert.equal(a.writes['gelcost-v5.5'],legacy);assert.equal(JSON.parse(a.writes[C.STORAGE_KEY]).usdPurchases.length,3);
  // An older, still-open build cannot overwrite the newly adopted history.
  a.writes['gelcost-v5.5']=JSON.stringify(C.defaults());
  const reload=await app(a.writes);assert.equal(reload.state().usdPurchases.length,3);
});
test('missing cross-tab locks never fall back to unsafe whole-state writes',async()=>{
  const saved=JSON.stringify({...C.defaults(),usdPurchases:[{rub:8800,qty:100}]});
  const a=await app({[C.STORAGE_KEY]:saved},false,{noLocks:true});
  await purchase(a,'usd',9000,100);await cash(a,2.62);
  assert.equal(a.state().usdPurchases.length,2);assert.equal(a.writes[C.STORAGE_KEY],saved);
  assert.match(a.els.storageNotice.textContent,/только в этой вкладке/);
});
test('failed personal write preserves the disk copy and later sync preserves unsaved input',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared});await purchase(a,'usd',8800,100);
  const saved=shared.writes[C.STORAGE_KEY];shared.failWrites=true;
  await purchase(a,'usd',9000,100);assert.equal(shared.writes[C.STORAGE_KEY],saved);
  shared.failWrites=false;const b=await app({},false,{shared});await purchase(b,'usdt',8655,100);shared.flush();
  assert.equal(a.state().usdPurchases.length,2);
  await cash(a,2.62);assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).usdPurchases.length,1);
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).usdtPurchases.length,1);
});
test('corrupt canonical history is never overwritten with a fallback snapshot',async()=>{
  const a=await app({[C.STORAGE_KEY]:'broken','gelcost-v5.5':JSON.stringify({...C.defaults(),usdPurchases:[{rub:8800,qty:100}]})});
  await purchase(a,'usd',9000,100);assert.equal(a.writes[C.STORAGE_KEY],'broken');assert.equal(a.state().usdPurchases.length,2);
  assert.match(a.els.storageNotice.textContent,/Не удалось сохранить/);
});
test('lock acquisition is bounded and duplicate clicks do not duplicate a purchase',async()=>{
  const shared=sharedBrowser();
  shared.locks.request=(name,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
  const a=await app({},false,{shared});const pending=purchase(a,'usd',8800,100);
  await a.settle();await a.run('savePurchase()');
  const abort=[...a.timers.values()].find(t=>t.ms===8000);assert.ok(abort);abort.fn();await pending;
  assert.equal(a.state().usdPurchases.length,1);assert.equal(shared.writes[C.STORAGE_KEY],undefined);
  assert.match(a.els.storageNotice.textContent,/Не удалось сохранить/);
});
test('regression: active tab fetches both sources every five minutes without writing purchases',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.els.bankChoice.value='2';await a.run('applyBank()');
  const saved=a.writes[C.STORAGE_KEY],timer=[...a.timers.values()].find(t=>t.interval);
  for(let minute=1;minute<5;minute++){a.advance(60000);await timer.fn();}
  assert.equal(a.requests.length,3);
  a.advance(60000);
  for(const data of Object.values(a.responses))data.fetchedAt=new Date(a.run('Date.now()')).toISOString();
  a.responses['./market-rates.json'].offers[1].buy=2.63;
  await timer.fn();assert.equal(a.requests.length,6);assert.equal(a.state().cashGelRate,2.63);
  assert.equal(a.writes[C.STORAGE_KEY],saved);
  await timer.fn();assert.equal(a.requests.length,6);
  a.advance(5*60000);await timer.fn();assert.equal(a.requests.length,9);
});
test('hidden tab skips polling, then refreshes on return without repeated requests',async()=>{
  const a=await app(),timer=[...a.timers.values()].find(t=>t.interval);
  a.run('document.hidden=true');a.advance(10*60000);await timer.fn();assert.equal(a.requests.length,3);
  a.run('document.hidden=false');a.documentEvents.visibilitychange();await a.settle();assert.equal(a.requests.length,6);
  a.documentEvents.visibilitychange();await a.settle();assert.equal(a.requests.length,6);
});
test('network recovery retries immediately and busy requests are not duplicated',async()=>{
  const a=await app();a.responses['./rates.json']='hang';a.responses['./market-rates.json']='hang';a.responses['./exchange-rates.json']='hang';
  const pending=a.events.online();await a.settle();assert.equal(a.requests.length,6);
  a.advance(5*60000);await [...a.timers.values()].find(t=>t.interval).fn();assert.equal(a.requests.length,6);
  for(const timer of [...a.timers.values()].filter(t=>t.ms===10000))timer.fn();await pending;
  a.responses['./rates.json']=official();a.responses['./market-rates.json']=bankData();a.responses['./exchange-rates.json']=officeData();
  await a.events.online();assert.equal(a.requests.length,9);assert.equal(a.els.marketStatus.textContent,'ориентир');
});
test('export waits for pending personal saves and includes the latest purchase',async()=>{
  const a=await app();
  await Promise.all([purchase(a,'usd',8800,100),a.run('exportData()')]);
  assert.equal(a.downloads.length,1);
  const link=a.downloads[0],backup=await (await fetch(link.href)).json();
  assert.equal(backup.state.usdPurchases.length,1);assert.equal(backup.state.usdPurchases[0].rub,8800);
  URL.revokeObjectURL(link.href);
});
test('older bank cache in another tab cannot replace a more recent selected quote',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  a.responses['./market-rates.json'].fetchedAt=new Date(Date.now()+30000).toISOString();
  a.responses['./market-rates.json'].offers[1].buy=2.63;
  await a.run('refreshBanks()');a.els.bankChoice.value='2';await a.run('applyBank()');
  shared.flush();assert.equal(b.state().cashGelRate,2.63);
});

test('optional comparison shows both RUB totals and no winner for one route',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  assert.equal(a.els.cashCard.classes.has('best'),false);assert.equal(a.els.bybitTotal.textContent,'— ₽');
  await purchase(a,'usdt',8655,100);a.run('openRate("bybit")');a.els.actualGel.value='100';a.els.actualUsdt.value='38';await a.run('saveRate()');
  assert.match(a.els.cashTotal.textContent,/3\s359/);assert.match(a.els.bybitTotal.textContent,/3\s289/);assert.match(a.els.heroRoute.textContent,/Bybit дешевле/);
});
test('exchange is the initial view and changing payment never writes personal data',async()=>{
  const a=await app();assert.equal(a.run('currentView'),'exchange');
  const before=JSON.stringify(a.writes);
  a.run('showView("purchase");setPayment("bybit")');
  assert.equal(a.els.bybitPaymentButton.attrs['aria-pressed'],'true');
  assert.equal(a.els.cashPaymentButton.attrs['aria-pressed'],'false');
  a.run('showView("exchange");showView("purchase")');
  assert.equal(a.run('selectedPayment'),'bybit');assert.equal(JSON.stringify(a.writes),before);
});
test('first-use guidance leads from a real USD purchase to choosing an exchange quote',async()=>{
  const a=await app();a.run('showView("purchase")');
  assert.equal(a.els.rublesResult.textContent,'— ₽');assert.equal(a.els.rublesNextAction.textContent,'Указать покупку USD');
  a.run('continueRublesSetup()');assert.equal(a.run('purchaseKind'),'usd');assert.equal(a.els.purchasePanel.classes.has('show'),true);
  await purchase(a,'usd',8800,100);
  assert.equal(a.els.rublesNextAction.textContent,'Выбрать курс обмена');
  a.run('continueRublesSetup()');assert.equal(a.run('currentView'),'exchange');
  a.run('selectOffer("office:mjc")');await a.run('applyOffer()');
  assert.equal(a.run('currentView'),'purchase');assert.equal(a.run('selectedPayment'),'cash');
  assert.equal(a.els.rublesNextAction.hidden,true);assert.match(a.els.rublesResult.textContent,/^≈ 3\s368 ₽$/);
  assert.match(a.els.rublesRate.textContent,/33,6778/);near(a.run('routeValues().cash'),88/2.613);
});
test('single answer uses the selected method, not the cheaper or stale alternative',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  await purchase(a,'usdt',8655,100);a.run('openRate("bybit")');a.els.actualGel.value='100';a.els.actualUsdt.value='38';await a.run('saveRate()');
  a.run('state.bybitGelUpdated=0;setPayment("cash")');
  assert.match(a.els.rublesResult.textContent,/3\s359/);assert.equal(a.els.rublesStatus.classes.has('stale'),false);
  assert.equal(a.els.rublesNextAction.hidden,true);
  a.run('setPayment("bybit")');assert.match(a.els.rublesResult.textContent,/3\s289/);
  assert.equal(a.els.rublesStatus.classes.has('stale'),true);assert.equal(a.els.rublesNextAction.textContent,'Указать списание Bybit');
});
test('Bybit setup opens a visible editor without requiring the optional comparison',async()=>{
  const a=await app();a.run('showView("purchase");setPayment("bybit");continueRublesSetup()');
  assert.equal(a.run('purchaseKind'),'usdt');await purchase(a,'usdt',8655,100);
  a.run('continueRublesSetup()');assert.equal(a.run('rateKind'),'bybit');
  assert.equal(a.els.ratePanel.parentElement,a.els.rublesEditorHost);assert.equal(a.els.ratePanel.classes.has('show'),true);
  a.els.actualGel.value='100';a.els.actualUsdt.value='38.75';await a.run('saveRate()');
  assert.equal(a.els.rublesNextAction.hidden,true);assert.match(a.els.rublesResult.textContent,/3\s354/);
  a.els.quickGel.value='12,50';a.run('calc()');assert.equal(a.els.rublesResult.textContent,'≈ 419 ₽');
});
test('estimated dollar cost is labelled and never presented as an actual purchase',async()=>{
  const old={...C.defaults(),usdEstimate:88,cashGelRate:2.62,cashGelUpdated:Date.now()};
  const a=await app({[C.STORAGE_KEY]:JSON.stringify(old)});
  assert.match(a.els.rublesStatus.textContent,/оценки, не из покупок/);
  assert.equal(a.els.rublesNextAction.textContent,'Указать покупку USD');assert.equal(a.state().usdPurchases.length,0);
});
test('invalid price removes the single answer and keeps currencies separate',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  for(const value of ['', '0', '-1', '12abc', '1000000001']){
    a.els.quickGel.value=value;a.run('calc()');assert.equal(a.els.rublesResult.textContent,'— ₽');
    assert.equal(a.els.quickGel.attrs['aria-invalid'],'true');assert.equal(a.els.rublesNextAction.hidden,true);
  }
  a.els.quickGel.value='100';a.run('setPayment("bybit")');assert.equal(a.els.rublesResult.textContent,'— ₽');
  assert.equal(a.els.rublesNextAction.textContent,'Указать покупку USDT');
});
test('applying a bank returns to cash even when the previous payment was Bybit',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.run('setPayment("bybit");openBanks()');
  a.els.bankChoice.value='2';await a.run('applyBank()');
  assert.equal(a.run('currentView'),'purchase');assert.equal(a.run('selectedPayment'),'cash');
  assert.match(a.els.rublesRate.textContent,/33,7165/);
});
test('office selection persists, refreshes quote only, and manual override detaches it',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.run('selectOffer("office:mjc")');await a.run('applyOffer()');
  assert.equal(a.state().cashOfficeId,'mjc');assert.equal(a.state().cashBankId,null);near(a.run('routeValues().cash'),88/2.613);
  const saved=a.writes[C.STORAGE_KEY];a.responses['./exchange-rates.json'].offers[0].buy=2.614;
  await a.run('refreshOffices()');assert.equal(a.state().cashGelRate,2.614);assert.equal(a.writes[C.STORAGE_KEY],saved);
  const b=await app(a.writes);assert.equal(b.state().cashOfficeId,'mjc');
  await cash(a,2.62);assert.equal(a.state().cashOfficeId,null);await a.run('refreshOffices()');assert.equal(a.state().cashGelRate,2.62);
});
test('failure of one office disables only its quote, even with a new snapshot date',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.run('selectOffer("office:mjc")');await a.run('applyOffer()');
  a.responses['./exchange-rates.json'].failures=['mjc'];await a.run('refreshOffices()');
  a.run('selectOffer("office:mjc")');assert.equal(a.els.applyOfferButton.disabled,true);assert.match(a.els.heroRoute.textContent,/сохранённым/);
  assert.equal(a.run('officeFresh("rico")'),true);
  a.run('selectOffer("office:rico")');assert.equal(a.els.applyOfferButton.disabled,false);
});
test('stale provider time is not refreshed by a newer bundle timestamp',async()=>{
  const a=await app();a.responses['./exchange-rates.json'].offers[0].checkedAt=new Date(Date.now()-3*3600000).toISOString();
  // A backwards provider timestamp is rejected, even if another provider is fresh.
  await a.run('refreshOffices()');a.run('selectOffer("office:mjc")');assert.equal(a.els.applyOfferButton.disabled,true);
  assert.equal(a.state().usdPurchases.length,0);
});
test('city filtering hides offices without verified branches, but labels banks as unscoped',async()=>{
  const a=await app();a.els.exchangeCity.value='batumi';a.run('renderOffers()');
  assert.equal(a.run('offersForCity().some(o=>o.id==="mjc")'),false);assert.equal(a.run('offersForCity().some(o=>o.id==="rico")'),true);
  assert.equal(a.run('offersForCity().filter(o=>o.kind==="bank").length'),3);assert.ok(a.els.offerList.children.some(row=>row.children[1].textContent.includes('город уточните')));
});
test('exchange preview uses BUY times USD quantity; personal basis is optional',async()=>{
  const a=await app();a.run('selectOffer("office:mjc")');assert.match(a.els.exchangeReceive.textContent,/261,30/);
  assert.match(a.els.exchangeBasis.textContent,/Добавьте покупку/);
  await purchase(a,'usd',8800,100);a.els.exchangeAmount.value='200,5';a.run('renderOffers()');
  assert.match(a.els.exchangeReceive.textContent,/523,91/);assert.match(a.els.exchangeBasis.textContent,/17\s644/);
  a.els.exchangeAmount.value='abc';a.run('renderOffers()');assert.equal(a.els.applyOfferButton.disabled,true);await a.run('applyOffer()');assert.equal(a.state().cashOfficeId,null);
});
test('navigation preserves a draft and forms never move into a hidden home card from Data',async()=>{
  const a=await app();a.run('showView("data");openPurchase("usd")');a.els.purchaseRub.value='9012';
  assert.equal(a.els.purchasePanel.parentElement,a.els.purchaseDataHost);
  a.run('showView("exchange");showView("data")');assert.equal(a.els.purchaseRub.value,'9012');assert.equal(a.els.purchasePanel.classes.has('show'),true);
  assert.equal(a.els.dataView.hidden,false);assert.equal(a.els.purchaseView.hidden,true);
});
test('V5.5 canonical history and Bybit actual rate migrate without a second reward adjustment',async()=>{
  const old={...C.defaults(),cashOfficeId:undefined,usdPurchases:[{rub:8800,qty:100}],bybitActualGelRate:2.62,cashbackPct:2};
  const saved=JSON.stringify(old);const a=await app({'gelcost-v5.5-personal':saved});
  assert.equal(a.state().bybitActualGelRate,2.62);await purchase(a,'usd',9000,100);
  assert.equal(a.writes['gelcost-v5.5-personal'],saved);assert.equal(JSON.parse(a.writes[C.STORAGE_KEY]).usdPurchases.length,2);
});
test('public provider labels cannot inject markup and links use trusted metadata',async()=>{
  const a=await app();a.responses['./market-rates.json'].offers[0].bank='<img src=x onerror=alert(1)>';
  await a.run('refreshBanks()');a.run('selectOffer("bank:1")');
  assert.equal(a.els.selectedSource.href,'https://nbg.gov.ge/en/currency-rates');
  assert.equal(a.els.offerList.children.every(row=>row.innerHTML===''),true);
});
