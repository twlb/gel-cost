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
const euroBankData=()=>({...bankData(),currency:'EUR',unit:'GEL per EUR',nominal:1,sourceNominal:1,offers:[{id:'1',bank:'EUR A',buy:2.99,sell:3.1},{id:'2',bank:'EUR B',buy:3,sell:3.1},{id:'3',bank:'EUR C',buy:3.01,sell:3.1}]});
const currencyOfficeData=currency=>{
  const stamp=new Date().toISOString(),rub=currency==='RUB';
  return {schemaVersion:1,currency,unit:'GEL per '+currency,nominal:1,channel:'Cash',side:'buy',fetchedAt:stamp,offers:[
    {id:'mjc',buy:rub?0.033:3.02,sell:rub?0.034:3.07,nominal:1,sourceNominal:1,checkedAt:stamp,sourceUpdatedAt:null},
    {id:'rico',buy:rub?0.0325:3.01,sell:rub?0.0335:3.06,nominal:1,sourceNominal:rub?100:1,checkedAt:stamp,sourceUpdatedAt:null}
  ],failures:[]};
};
const allSourceData=()=>({'./rates.json':official(),'./market-rates.json':bankData(),'./exchange-rates.json':officeData(),'./market-rates-eur.json':euroBankData(),'./exchange-rates-eur.json':currencyOfficeData('EUR'),'./exchange-rates-rub.json':currencyOfficeData('RUB')});
class Element{
  constructor(){this.dataset={};this.value='';this.textContent='';this.hidden=false;this.innerHTML='';this.children=[];this.events={};this.attrs={};this.classes=new Set();this.classList={contains:k=>this.classes.has(k),add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),toggle:(k,on)=>{if(on===undefined)on=!this.classes.has(k);on?this.classes.add(k):this.classes.delete(k);}};}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,fn){this.events[k]=fn;}
  appendChild(node){
    if(node.parentElement){const old=node.parentElement.children,index=old.indexOf(node);if(index>=0)old.splice(index,1);}
    node.parentElement=this;this.children.push(node);return node;
  }
  replaceChildren(...nodes){
    for(const child of this.children)if(child.parentElement===this)child.parentElement=null;
    this.children=[];for(const node of nodes)this.appendChild(node);
    this.value=nodes[0]?.value||'';
  }
  add(node){this.appendChild(node);}
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
  const els={};for(const id of html.matchAll(/\bid="([^"]+)"/g)){els[id[1]]=new Element();els[id[1]].id=id[1];}
  // Existing calculation fixtures explicitly use Tbilisi; default-city tests use the HTML selection.
  const citySelect=html.match(/<select\b[^>]*\bid="exchangeCity"[^>]*>([\s\S]*?)<\/select>/)[1];
  els.quickGel.value='100';els.exchangeAmount.value='100';els.exchangeCurrency.value='USD';els.exchangeCity.value=options.city===null?citySelect.match(/<option value="([^"]+)" selected>/)[1]:options.city||'tbilisi';
  const responses={...allSourceData(),...options.responses};
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
    localStorage:store,navigator:{locks:options.noLocks?undefined:shared.locks,geolocation:options.geolocation,userAgent:options.userAgent||''},
    addEventListener:(name,fn)=>events[name]=fn,
    document:{getElementById:id=>els[id],hidden:false,addEventListener:(name,fn)=>documentEvents[name]=fn,createElement:tag=>{const e=new Element();if(tag==='a')downloads.push(e);return e;},querySelectorAll:()=>['purchasePanel','ratePanel','exchangeManualPanel','settingsPanel','usdHistory','usdtHistory'].map(id=>els[id]).filter(e=>e.classes.has('show'))},
    setTimeout:(fn,ms)=>{const id=++tid;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>timers.set(++tid,{fn,ms,interval:true}),
    fetch:async(url,options)=>{requests.push(url);if(responses[url] instanceof Error)throw responses[url];if(responses[url]==='hang')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));const data=await responses[url];return {ok:Boolean(data),json:async()=>{if(data==='malformed-json')throw new SyntaxError('Intentional malformed JSON response');return structuredClone(data);}};},
  });
  ctx.window=ctx;
  vm.runInContext(fs.readFileSync(path.join(root,'core.js'),'utf8'),ctx);
  if(!options.noLocations)vm.runInContext(fs.readFileSync(path.join(root,'locations.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'app.js'),'utf8'),ctx);
  const run=code=>vm.runInContext(code,ctx);
  const settle=()=>new Promise(resolve=>setImmediate(resolve));await settle();
  return {els,run,settle,responses,writes,timers,downloads,requests,shared,events,documentEvents,
    advance:ms=>{now+=ms;},state:()=>JSON.parse(run('JSON.stringify(state)'))};
}
const purchase=(a,kind,rub,qty)=>{a.run(`openPurchase('${kind}')`);a.els.purchaseRub.value=String(rub);a.els.purchaseQty.value=String(qty);return a.run('savePurchase()');};
const cash=(a,rate)=>{a.run('openRate("cash")');a.els.rateValue.value=String(rate);return a.run('saveRate()');};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

function inteliResponses(){
  const responses=allSourceData();
  for(const [currency,file] of [['USD','./exchange-rates.json'],['EUR','./exchange-rates-eur.json'],['RUB','./exchange-rates-rub.json']]){
    const data=responses[file];data.schemaVersion=2;data.nominal=1;
    data.offers.forEach(row=>row.sourceNominal=C.currencyMeta[currency].sourceNominals[row.id]);
    if(currency==='RUB')data.offers.forEach(row=>{row.buy=.0263;row.sell=.0303;});
    data.offers.push({id:'inteli',buy:currency==='RUB'?.027:2.609,sell:currency==='RUB'?.03:2.614,nominal:1,sourceNominal:1,checkedAt:data.fetchedAt,sourceUpdatedAt:null});
  }
  return responses;
}
test('Inteli Apple link explains Google fallback and does not invent a route origin',async()=>{
  const a=await app({},false,{city:'batumi',responses:inteliResponses(),userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)'});
  a.run('selectOffer("office:inteli");toggleOfferLocation()');
  assert.equal(new URL(a.els.openDeviceMap.href).hostname,'www.google.com');
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'41.6492744,41.6374353');
  assert.match(a.els.branchMapHint.textContent,/Google Maps/);
  a.run('selectOffer("office:rico");toggleOfferLocation()');
  assert.equal(new URL(a.els.openDeviceMap.href).hostname,'maps.apple.com');
  assert.doesNotMatch(a.els.branchMapHint.textContent,/Apple Maps неточно/);
});
test('Inteli RUB best in Batumi transfers exact quote to planner and preserves personal input',async()=>{
  const a=await app({},false,{city:'batumi',responses:inteliResponses()});
  a.run('changeExchangeCurrency("RUB")');a.els.exchangeAmount.value='10000';a.run('renderOffers()');
  assert.equal(a.run('offersForCity()[0].id'),'inteli');assert.equal(a.els.exchangeReceive.textContent,'≈ 270,00 ₾');
  const saved=a.writes[C.STORAGE_KEY];a.run('selectOffer("office:RUB:inteli");useOfferForPlan()');
  assert.equal(a.els.planResult.textContent,'≈ 270,00 ₾');assert.equal(a.writes[C.STORAGE_KEY],saved);
  a.els.exchangeCity.value='kobuleti';a.run('renderOffers()');assert.equal(a.run('offersForCity().some(o=>o.id==="inteli")'),false);
});
test('Inteli USD selection survives reload, outage isolates source, own quote remains untouched',async()=>{
  const responses=inteliResponses(),a=await app({},false,{city:'batumi',responses});
  await purchase(a,'usd',8800,100);a.run('selectOffer("office:inteli")');await a.run('applyOffer()');
  assert.equal(a.state().cashOfficeId,'inteli');near(a.run('routeValues().cash'),88/2.609);
  const b=await app(a.writes,false,{city:'batumi',responses});assert.equal(b.state().cashOfficeId,'inteli');
  a.responses['./exchange-rates.json'].failures=['inteli'];await a.run('refreshOffices()');
  assert.equal(a.run('officeFresh("inteli")'),false);assert.equal(a.run('officeFresh("rico")'),true);
  await cash(a,2.7);await a.run('refreshOffices()');assert.equal(a.state().cashOfficeId,null);assert.equal(a.state().cashGelRate,2.7);
  assert.equal(a.state().usdPurchases.length,1);
});

test('planner continues the cash amount and quote without creating a purchase',async()=>{
  const a=await app(),before=a.writes[C.STORAGE_KEY];a.run('selectOffer("office:mjc");useOfferForPlan()');
  assert.equal(a.run('currentView'),'calculator');assert.equal(a.els.calculatorView.hidden,false);
  assert.equal(a.els.planFrom.value,'USD');assert.equal(a.els.planAmount.value,'100');
  assert.equal(a.els.planResult.textContent,'≈ 261,30 ₾');assert.equal(a.els.planQuote0.value,'2,6130');
  assert.equal(a.writes[C.STORAGE_KEY],before);assert.equal(a.state().usdPurchases.length,0);
});
test('planner finishes a rate at four places without truncating extra precision',async()=>{
  const a=await app();a.run('showView("calculator")');
  for(const [input,expected] of [['100','100,0000'],['87.1234567890123','87,1234567890123'],['',''],['bad','bad']]){
    a.els.planQuote0.value=input;a.run('editPlanQuote(0);finishPlanQuote(0)');assert.equal(a.els.planQuote0.value,expected);
  }
});
test('personal price source selection keeps its application action visible',async()=>{
  const a=await app();a.run('showView("purchase");openBanks()');assert.equal(a.els.legacyOfferDetails.open,true);
  assert.equal(a.run('currentView'),'exchange');
  a.run('showView("calculator")');a.els.planAmount.value='999999999,99';a.run('renderPlanner()');assert.equal(a.els.planAmount.dataset.amountSize,'medium');
  a.els.planAmount.value='0,1234567890123456';a.run('renderPlanner()');assert.equal(a.els.planAmount.dataset.amountSize,'long');
});
test('new calculator handles RUB forward, target and actual reverse with separate sell quotes',async()=>{
  const a=await app();a.run('selectOffer("office:mjc");showView("calculator")');
  a.els.planAmount.value='100000';a.els.planQuote0.value='100';a.run('editPlanQuote(0)');
  assert.equal(a.els.planResult.textContent,'≈ 2\u00a0613,00 ₾');
  a.run('setPlanMode("want")');a.els.planAmount.value='2613';a.run('renderPlanner()');
  assert.equal(a.els.planResult.textContent,'≈ 100\u00a0000,00 ₽');
  a.run('setPlanMode("give");reversePlan()');a.els.planAmount.value='2616';
  assert.equal(a.els.planQuote0.value,'2,6160');assert.equal(a.els.planQuote1.value,'');
  a.els.planQuote1.value='90';a.run('editPlanQuote(1)');
  assert.equal(a.els.planResult.textContent,'≈ 90\u00a0000,00 ₽');
});
test('USDT route never inherits cash rates; fees and typed quotes remain directed drafts',async()=>{
  const a=await app();a.run('showView("calculator")');a.els.planVia.value='USDT';a.run('changePlanRoute()');
  a.els.planAmount.value='10100';assert.equal(a.els.planQuote1.value,'');assert.equal(a.els.planChooseOffice.hidden,true);
  a.els.planQuote0.value='100';a.run('editPlanQuote(0)');a.els.planQuote1.value='2,5';a.run('editPlanQuote(1)');
  a.els.planPct0.value='1';a.els.planFixed0.value='100';a.run('editPlanFee(0)');
  a.els.planPct1.value='2';a.els.planFixed1.value='1';a.run('editPlanFee(1)');
  assert.equal(a.els.planResult.textContent,'≈ 240,10 ₾');
  a.run('showView("exchange");showView("calculator");reversePlan()');
  assert.equal(a.els.planQuote0.value,'');assert.equal(a.els.planPct0.value,'0');
  a.run('reversePlan()');assert.equal(a.els.planQuote1.value,'2,5');assert.equal(a.els.planPct1.value,'2');
  a.els.planPct0.value='100';a.run('editPlanFee(0)');assert.match(a.els.planNext.textContent,/комиссию/);assert.equal(a.els.planResult.textContent,'— ₾');
  a.els.planPct0.value='1';a.run('editPlanFee(0)');assert.equal(a.els.planResult.textContent,'≈ 240,10 ₾');
  assert.equal(a.state().usdtPurchases.length,0);
});
test('stale automatic cash quote stops calculation, explicit override works and survives refresh',async()=>{
  const a=await app();a.run('selectOffer("office:mjc");useOfferForPlan()');
  a.advance(3*3600000);a.run('calc()');assert.equal(a.els.planResult.textContent,'— ₾');assert.match(a.els.planSource0.textContent,/свежесть не подтверждена/);
  a.els.planQuote0.value='2,70001';a.run('editPlanQuote(0)');assert.equal(a.els.planResult.textContent,'≈ 270,00 ₾');
  a.responses['./exchange-rates.json']=new Error('offline');await a.run('refreshOffices()');
  assert.equal(a.els.planQuote0.value,'2,70001');assert.equal(a.els.planResult.textContent,'≈ 270,00 ₾');
  assert.equal(a.els.planAddress.hidden,true);
});
test('planner address action selects the source without modifying saved personal rates',async()=>{
  const a=await app({},false,{city:'batumi'});await cash(a,3);const before=a.writes[C.STORAGE_KEY];
  a.run('selectOffer("office:rico");useOfferForPlan();showPlanLocation()');
  assert.equal(a.run('currentView'),'exchange');assert.equal(a.run('expandedOffer'),'office:rico');
  assert.equal(a.els.offerLocationPanel.hidden,false);assert.equal(a.writes[C.STORAGE_KEY],before);
});
test('planner rejects invalid amount, same currencies and manual buy reused as sell',async()=>{
  const a=await app();await cash(a,3);a.run('selectOffer("manual");useOfferForPlan()');
  assert.equal(a.els.planResult.textContent,'≈ 300,00 ₾');assert.equal(a.els.planQuote0.value,'3,0000');a.run('reversePlan()');assert.equal(a.els.planQuote0.value,'');
  a.els.planAmount.value='abc';a.run('renderPlanner()');assert.equal(a.els.planError.classes.has('show'),true);
  a.els.planAmount.value='100';a.els.planTo.value='GEL';a.run('changePlanRoute()');
  assert.equal(a.els.planNext.textContent,'Выберите разные валюты.');
  const b=await app({...a.writes});b.run('showView("calculator")');assert.equal(b.els.planAmount.value,'');
  assert.equal(b.state().cashGelRate,3);
});

test('polished empty, successful and invalid states keep one next action without a fake result',async()=>{
  const a=await app();a.run('showView("calculator")');
  assert.equal(a.els.planResultBox.classes.has('is-pending'),true);
  assert.equal(a.els.planNext.textContent,'Введите сумму обмена.');
  assert.equal(a.els.planQuote0.attrs['aria-invalid'],'false');
  a.run('setPlanMode("want")');assert.equal(a.els.planNext.textContent,'Введите сумму, которую хотите получить.');
  a.els.planAmount.value='260';a.els.planQuote0.value='100';a.run('editPlanQuote(0)');
  a.els.planQuote1.value='2.6';a.run('editPlanQuote(1)');
  assert.equal(a.els.planResultLabel.textContent,'Понадобится');
  assert.equal(a.els.planResult.textContent,'≈ 10\u00a0000,00 ₽');
  assert.equal(a.els.planNext.hidden,true);assert.equal(a.els.planError.textContent,'');
  assert.equal(a.els.planResultBox.classes.has('is-pending'),false);
  a.els.planAmount.value='bad';a.run('renderPlanner()');
  assert.equal(a.els.planResultBox.hidden,true);assert.equal(a.els.planError.classes.has('show'),true);
  a.els.planAmount.value='260';a.run('renderPlanner()');assert.equal(a.els.planResultBox.hidden,false);
});
test('fee disclosure summary exposes configured and invalid fees without changing arithmetic',async()=>{
  const a=await app();a.run('showView("calculator")');
  a.els.planAmount.value='10100';a.els.planQuote0.value='100';a.run('editPlanQuote(0)');a.els.planQuote1.value='2,5';a.run('editPlanQuote(1)');
  a.els.planPct0.value='1';a.els.planFixed0.value='100';a.run('editPlanFee(0)');
  assert.equal(a.els.planFeeSummary0.textContent,'Комиссия: 100,00 ₽ + 1%');
  assert.equal(a.els.planResult.textContent,'≈ 247,50 ₾');
  a.els.planFee0.open=false;a.run('renderPlanner()');assert.equal(a.els.planFeeSummary0.textContent,'Комиссия: 100,00 ₽ + 1%');
  a.els.planFixed0.value='1000000001';a.run('editPlanFee(0)');
  assert.equal(a.els.planFeeSummary0.textContent,'Проверьте комиссию');assert.equal(a.els.planFixed0.attrs['aria-invalid'],'true');
  a.els.planFixed0.value='';a.els.planPct0.value='';a.run('editPlanFee(0)');
  assert.equal(a.els.planFeeSummary0.textContent,'Комиссия');assert.equal(a.els.planResult.textContent,'≈ 252,50 ₾');
});
test('swap preserves the amount and mode, restores directed drafts, and never writes purchases',async()=>{
  const a=await app();a.run('showView("calculator");setPlanMode("want")');
  const saved=a.writes[C.STORAGE_KEY];a.els.planAmount.value='123,45';
  a.els.planQuote0.value='87,12345';a.run('editPlanQuote(0)');a.els.planPct0.value='0,5';a.run('editPlanFee(0)');
  a.run('reversePlan()');assert.equal(a.els.planFrom.value,'GEL');assert.equal(a.els.planTo.value,'RUB');
  assert.equal(a.els.planWant.attrs['aria-pressed'],'true');assert.equal(a.els.planAmount.value,'123,45');assert.equal(a.els.planQuote1.value,'');
  a.run('reversePlan()');assert.equal(a.els.planQuote0.value,'87,12345');assert.equal(a.els.planPct0.value,'0,5');
  assert.equal(a.els.planAmount.value,'123,45');assert.equal(a.writes[C.STORAGE_KEY],saved);
});
test('stale warnings remain visible outside help and a manual override removes stale styling',async()=>{
  const a=await app();a.run('selectOffer("office:mjc");useOfferForPlan()');
  a.els.planHelp.open=false;a.advance(3*3600000);a.run('calc()');
  assert.match(a.els.planSource0.textContent,/свежесть не подтверждена/);assert.equal(a.els.planSource0.classes.has('stale'),true);
  assert.equal(a.els.planNext.textContent,'Введите курс на шаге 1.');
  a.els.planQuote0.value='2,6';a.run('editPlanQuote(0)');assert.equal(a.els.planSource0.textContent,'Свой курс');
  assert.equal(a.els.planSource0.classes.has('stale'),false);assert.equal(a.els.planResult.textContent,'≈ 260,00 ₾');
});
test('long amount typography also fits price and exchange fields without altering input',async()=>{
  const a=await app();
  for(const id of ['quickGel','exchangeAmount']){
    for(const [value,size] of [['999999999,99','medium'],['0,1234567890123456','long'],['100','normal']]){
      a.els[id].value=value;a.run('calc()');
      assert.equal(a.els[id].dataset.amountSize,size);assert.equal(a.els[id].value,value);
    }
  }
});
test('fresh profile has no invented purchases and both sources load',async()=>{
  const a=await app();assert.equal(a.state().usdPurchases.length,0);assert.equal(a.state().usdtPurchases.length,0);
  assert.equal(a.els.quickRub.textContent,'— ₽');assert.match(a.els.marketPrice.textContent,/33,5878/);assert.match(a.els.bankStatus.textContent,/3 банков/);
});

test('first purchase feedback names the missing second step, not a nonexistent RUB result',async()=>{
  const a=await app();a.run('showView("purchase")');
  assert.match(a.els.setupProgress.textContent,/Шаг 1 из 2/);assert.equal(a.els.comparisonDetails.hidden,true);
  await purchase(a,'usd','8800,50','100');
  assert.equal(a.els.rublesResult.textContent,'— ₽');
  assert.equal(a.els.actionStatus.textContent,'Покупка сохранена. Осталось выбрать курс USD → GEL.');
  assert.match(a.els.setupProgress.textContent,/Шаг 2 из 2/);
  await cash(a,3);assert.equal(a.els.rublesResult.textContent,'≈ 2\u00a0933,50 ₽');
  assert.match(a.els.actionStatus.textContent,/Цена в рублях пересчитана/);
  assert.equal(a.els.setupProgress.hidden,true);assert.equal(a.els.comparisonDetails.hidden,false);
  await purchase(a,'usdt',8655,100);
  assert.match(a.els.actionStatus.textContent,/Осталось указать списание USDT/);
  assert.doesNotMatch(a.els.actionStatus.textContent,/пересчитана/);
});
test('saving a rate before the purchase asks for the correct currency and respects an invalid price',async()=>{
  const a=await app();a.run('showView("purchase")');await cash(a,3);
  assert.match(a.els.actionStatus.textContent,/Осталось указать покупку USD за рубли/);
  a.els.quickGel.value='bad';await purchase(a,'usd',8800,100);
  assert.match(a.els.actionStatus.textContent,/Введите корректную цену в лари/);
  assert.equal(a.els.rublesResult.textContent,'— ₽');
  a.run('showView("exchange")');a.els.exchangeAmount.value='';await cash(a,2.7);
  assert.equal(a.els.actionStatus.textContent,'Свой курс сохранён. Введите сумму обмена.');
  a.run('showView("data")');await purchase(a,'usd',9000,100);
  assert.equal(a.els.actionStatus.textContent,'Покупка сохранена.');
});
test('bank and office application without a purchase do not claim a complete price',async()=>{
  const a=await app();a.run('selectOffer("office:mjc")');await a.run('applyOffer()');
  assert.match(a.els.actionStatus.textContent,/Курс MJC выбран.*Осталось указать покупку USD/);
  a.els.bankChoice.value='2';await a.run('applyBank()');
  assert.match(a.els.actionStatus.textContent,/Курс B выбран.*Осталось указать покупку USD/);
});
test('a preview click never opens addresses; the address action neither selects nor persists a rate',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,3);
  const before=a.writes[C.STORAGE_KEY];
  a.els.offerList.children.find(e=>e.dataset.offerKey==='office:mjc').events.click();
  assert.equal(a.run('selectedOffer'),'office:mjc');assert.equal(a.run('expandedOffer'),'');
  assert.equal(a.els.offerLocationPanel.hidden,true);
  const amount=a.els.exchangeReceive.textContent;
  a.run('toggleOfferLocation()');assert.equal(a.run('expandedOffer'),'office:mjc');
  assert.equal(a.els.exchangeReceive.textContent,amount);assert.equal(a.writes[C.STORAGE_KEY],before);
  a.run('closeOfferLocation()');assert.equal(a.run('selectedOffer'),'office:mjc');
  a.run('toggleOfferLocation();selectOffer("bank:3")');assert.equal(a.els.offerLocationPanel.hidden,true);
  assert.equal(a.els.openDeviceMap.hidden,true);assert.equal(a.els.offerAddressButton.textContent,'Отделения C');
  a.run('selectOffer("manual")');assert.equal(a.els.offerAddressButton.hidden,true);
});
test('USDT editor describes operation and forecast distinctly and retains drafts when switching modes',async()=>{
  const a=await app();a.run('openRate("bybit")');
  assert.equal(a.els.rateTitle.textContent,'Последняя оплата USDT');
  assert.equal(a.els.saveRateButton.textContent,'Использовать операцию');
  a.els.actualGel.value='50';a.els.actualUsdt.value='19,78';a.run('setRateMode("quote")');
  assert.equal(a.els.saveRateButton.textContent,'Сохранить прогноз');
  a.run('setRateMode("actual")');assert.equal(a.els.actualUsdt.value,'19,78');
});
test('address and manual editors do not stack; the unsaved manual draft survives viewing addresses',async()=>{
  const a=await app();a.run('selectOffer("office:mjc");toggleOfferLocation();openRate("cash")');
  assert.equal(a.els.offerLocationPanel.hidden,true);a.els.rateValue.value='2,7500';
  a.run('toggleOfferLocation()');assert.equal(a.els.ratePanel.classes.has('show'),false);
  assert.equal(a.els.offerLocationPanel.hidden,false);assert.equal(a.state().cashGelRate,null);
  a.run('openRate("cash")');assert.equal(a.els.rateValue.value,'2,7500');assert.equal(a.els.offerLocationPanel.hidden,true);
});
test('editing a manual quote cannot accidentally apply the previously previewed provider',async()=>{
  const a=await app();a.run('selectOffer("office:mjc");openRate("cash")');a.els.rateValue.value='2,7500';
  assert.equal(a.els.applyOfferButton.hidden,true);assert.equal(a.els.applyOfferButton.disabled,true);
  await a.run('applyOffer()');assert.equal(a.state().cashOfficeId,null);assert.equal(a.run('currentView'),'exchange');
  a.run('closeInline("ratePanel")');assert.equal(a.els.applyOfferButton.hidden,false);assert.equal(a.els.applyOfferButton.disabled,false);
});
test('completion of an earlier rate save cannot switch away from a newly opened editor',async()=>{
  const a=await app();a.run('showView("purchase");openRate("cash")');a.els.rateValue.value='3';
  const saving=a.run('saveRate()');a.run('openRate("bybit")');a.els.actualGel.value='55';
  await saving;
  assert.equal(a.run('selectedPayment'),'bybit');assert.equal(a.run('rateKind'),'bybit');
  assert.equal(a.els.ratePanel.classes.has('show'),true);assert.equal(a.els.actualGel.value,'55');
  assert.equal(a.state().cashGelRate,3);assert.equal(a.els.saveRateButton.textContent,'Использовать операцию');
});

test('best fresh public quote leads the list; a better personal quote stays visible and selected without a badge',async()=>{
  const a=await app();await purchase(a,'usd',8800.5,100);await cash(a,3);
  const saved=a.writes[C.STORAGE_KEY];await a.run('refreshAllRates()');
  assert.equal(a.run('offersForCity()[0].key'),'bank:3');
  assert.equal(a.run('offersForCity()[0].best'),true);
  assert.equal(a.run('offersForCity()[1].key'),'manual');
  assert.equal(a.run('Boolean(offersForCity()[1].best)'),false);
  assert.equal(a.run('selectedOffer'),'manual');assert.equal(a.els.exchangeReceive.textContent,'≈ 300,00 ₾');
  const first=a.els.offerList.children[0];
  assert.equal(first.children[0].children[0].children[1].textContent,'Лучший курс');
  assert.equal(first.attrs['aria-describedby'],'bestOfferHelp');
  assert.equal(a.els.bestOfferHelp.hidden,false);assert.equal(a.writes[C.STORAGE_KEY],saved);
  const b=await app(a.writes);assert.equal(b.run('selectedOffer'),'manual');assert.equal(b.state().cashGelRate,3);
});
test('a higher stale public quote never receives best; stale manual cannot displace fresh best',async()=>{
  const a=await app();await cash(a,3);a.advance(2*C.DAY);
  a.responses['./market-rates.json']=new Error('offline');await a.run('refreshBanks()');
  a.responses['./exchange-rates.json']=officeData();await a.run('refreshOffices()');
  // The harness clock is advanced, so explicitly give the office snapshot its current time.
  a.responses['./exchange-rates.json'].offers.forEach(row=>row.checkedAt=a.run('new Date().toISOString()'));
  a.responses['./exchange-rates.json'].fetchedAt=a.run('new Date().toISOString()');await a.run('refreshOffices()');
  assert.equal(a.run('offersForCity()[0].key'),'office:mjc');
  assert.equal(a.run('offersForCity().find(row=>row.key==="bank:3").best'),false);
  assert.equal(a.run('offersForCity()[1].key'),'manual');
});
test('no fresh public offers means no badge, with or without a personal quote',async()=>{
  const a=await app();a.advance(3*C.DAY);a.run('renderOffers()');
  assert.equal(a.run('offersForCity().some(row=>row.best)'),false);assert.equal(a.els.bestOfferHelp.hidden,true);
  await cash(a,3);assert.equal(a.run('offersForCity()[0].key'),'manual');assert.equal(a.els.bestOfferHelp.hidden,true);
  a.run('banks=null;offices=null;renderOffers()');assert.equal(a.els.exchangeReceive.textContent,'≈ 300,00 ₾');
  assert.equal(a.els.applyOfferButton.disabled,false);
});
test('ties are all labelled and city changes recompute the best without introducing another city office',async()=>{
  const a=await app();Object.assign(a.responses['./exchange-rates.json'].offers[0],{buy:2.64,sell:2.65});await a.run('refreshOffices()');
  assert.equal(a.run('offersForCity()[0].key'),'office:mjc');
  a.els.exchangeCity.value='batumi';a.els.exchangeCity.events.change();
  assert.equal(a.run('offersForCity()[0].key'),'bank:3');assert.equal(a.run('offersForCity().some(row=>row.id==="mjc")'),false);
  Object.assign(a.responses['./exchange-rates.json'].offers[1],{buy:2.62,sell:2.63});await a.run('refreshOffices()');
  assert.equal(a.run('offersForCity().filter(row=>row.best).length'),2);
  assert.equal(a.run('offersForCity().filter(row=>row.best).every(row=>row.buy===2.62&&row.fresh)'),true);
});
test('refresh moves the best without silently applying it or closing an already visible selected location',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,3);
  a.run('toggleAllOffers();selectOffer("office:rico");toggleOfferLocation("office:rico")');const saved=a.writes[C.STORAGE_KEY];
  Object.assign(a.responses['./exchange-rates.json'].offers[0],{buy:2.64,sell:2.65});await a.run('refreshOffices()');
  assert.equal(a.run('offersForCity()[0].key'),'office:mjc');assert.equal(a.run('selectedOffer'),'office:rico');
  assert.equal(a.run('expandedOffer'),'office:rico');assert.equal(a.els.offerLocationPanel.hidden,false);
  assert.equal(a.writes[C.STORAGE_KEY],saved);assert.equal(a.state().cashGelRate,3);
  a.els.exchangeAmount.value='200,50';a.els.exchangeAmount.events.input();
  assert.equal(a.els.exchangeReceive.textContent,'≈ 523,31 ₾');
});

test('a separate address action opens the location panel without saving a quote',async()=>{
  const a=await app(),before=JSON.stringify(a.state());
  assert.equal(a.els.offerLocationPanel.hidden,true);
  a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
  assert.equal(a.els.offerLocationPanel.hidden,false);
  assert.match(a.els.branchAddress.textContent,/Тбилиси, 89\/91/);
  assert.equal(a.els.branchChoiceGroup.hidden,true);
  assert.equal(a.els.offerLocationPanel.parentElement,a.els.locationPanelHome);
  assert.equal(a.els.offerAddressButton.attrs['aria-expanded'],'true');
  assert.equal(a.els.branchSource.href,'https://mjc.ge/contact');
  assert.match(a.els.branchNotice.textContent,/не подтверждение курса/);
  a.run('closeOfferLocation()');assert.equal(a.els.offerLocationPanel.hidden,true);
  assert.equal(JSON.stringify(a.state()),before);assert.equal(a.writes[C.STORAGE_KEY],undefined);
});
test('branch selection survives amount changes and refreshes without changing purchases or the rate',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,3);
  const before=a.writes[C.STORAGE_KEY];a.run('toggleAllOffers();selectOffer("office:rico");toggleOfferLocation("office:rico")');
  assert.equal(a.els.branchChoiceGroup.hidden,false);
  a.els.branchChoice.value='rico:tbilisi:1';a.run('selectBranch()');
  assert.match(a.els.branchAddress.textContent,/12 Ilia Chavchavadze/);
  const destination=new URL(a.els.openDeviceMap.href).searchParams.get('query');
  assert.equal(destination,'12 Ilia Chavchavadze Avenue, Tbilisi, Georgia');
  a.els.exchangeAmount.value='200,50';a.run('renderOffers()');await a.run('refreshOffices()');
  assert.equal(a.els.branchChoice.value,'rico:tbilisi:1');
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),destination);
  assert.equal(a.writes[C.STORAGE_KEY],before);
  a.run('selectOffer("office:rico");toggleOfferLocation("office:rico")');assert.equal(a.els.offerLocationPanel.hidden,true);
  a.run('selectOffer("office:rico");toggleOfferLocation("office:rico")');assert.equal(a.els.branchChoice.value,'rico:tbilisi:1');
});
test('city changes close the old panel and cannot reuse an address from another city',async()=>{
  const a=await app();a.run('selectOffer("office:rico");toggleOfferLocation("office:rico")');
  a.els.branchChoice.value='rico:tbilisi:1';a.run('selectBranch()');
  a.els.exchangeCity.value='batumi';a.els.exchangeCity.events.change();
  assert.equal(a.els.offerLocationPanel.hidden,true);
  a.run('selectOffer("office:rico");toggleOfferLocation("office:rico")');
  assert.equal(a.els.branchChoice.children.length,6);
  assert.match(a.els.branchAddress.textContent,/^Батуми,/);
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'41.645256,41.6385689');
  a.els.branchChoice.value='mjc:rustavi:0';a.run('selectBranch()');
  assert.match(a.els.branchAddress.textContent,/^Батуми,/);
  a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');assert.equal(a.run('expandedOffer'),'office:rico');
});
test('banks offer an explicitly labelled search, not an invented branch route',async()=>{
  const a=await app();a.els.exchangeCity.value='batumi';a.run('toggleAllOffers();selectOffer("bank:1");toggleOfferLocation("bank:1")');
  assert.equal(a.els.branchAddress.hidden,true);assert.equal(a.els.branchChoiceGroup.hidden,true);
  assert.match(a.els.branchNotice.textContent,/не указывает конкретное отделение/);
  const url=new URL(a.els.openDeviceMap.href);
  assert.equal(url.pathname,'/maps/search/');assert.equal(url.searchParams.has('destination'),false);
  assert.equal(url.searchParams.get('query'),'A bank branches, Batumi, Georgia');
  assert.equal(a.els.branchSource.hidden,true);
  a.els.exchangeCity.value='all';a.run('renderOffers()');
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'A bank branches, Georgia');
});
test('manual rate has no fabricated address, and stale network quotes do not block address viewing',async()=>{
  const a=await app();await cash(a,3);a.run('selectOffer("manual");toggleOfferLocation("manual")');
  assert.match(a.els.branchNotice.textContent,/не привязан/);
  assert.equal(a.els.openDeviceMap.hidden,true);assert.equal(a.els.branchSource.hidden,true);
  a.responses['./exchange-rates.json'].fetchedAt=new Date(Date.now()-3*3600000).toISOString();
  for(const row of a.responses['./exchange-rates.json'].offers)row.checkedAt=a.responses['./exchange-rates.json'].fetchedAt;
  await a.run('refreshOffices()');a.run('toggleAllOffers();selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
  assert.equal(a.els.applyOfferButton.disabled,true);assert.equal(a.els.openDeviceMap.hidden,false);
  assert.match(a.els.branchChecked.textContent,/06\.09\.2026/);
});
test('a missing location bundle does not break calculations and keeps the official directory link',async()=>{
  const a=await app({},false,{noLocations:true});await purchase(a,'usd',8800,100);await cash(a,3);
  a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
  assert.equal(a.els.openDeviceMap.hidden,true);assert.match(a.els.branchNotice.textContent,/недоступны/);
  assert.equal(a.els.branchSource.href,'https://mjc.ge/contact');near(a.run('routeValues().cash'),88/3);
});
test('branch catalog and map pins stay source-bound and disclose their date',()=>{
  const L=require('../locations.js');
  assert.equal(L.branches('mjc','batumi').length,0);
  assert.equal(L.branches('mjc','all').length,2);
  assert.equal(L.branches('rico','batumi').length,6);
  assert.equal(L.branches('__proto__','all').length,0);
  const rows=[...L.branches('mjc','all'),...L.branches('rico','all')];
  assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
  for(const row of rows){
    assert.equal(row.checkedAt,['kobuleti','poti','kutaisi'].includes(row.city)?'2026-09-07T00:00:00Z':'2026-09-06T00:00:00Z');assert.match(row.destination,/, (Tbilisi|Batumi|Rustavi|Kobuleti|Poti|Kutaisi), Georgia$/);
    assert.ok(['https://mjc.ge/contact','https://www.rico.ge/en/branches/'].includes(row.source));
    const links=L.branchLinks(row);
    if(row.point){assert.equal(row.point.length,2);assert.ok(row.point[0]>41&&row.point[0]<43);assert.ok(row.point[1]>41&&row.point[1]<46);}
    for(const [provider,parameter] of [['google','query'],['apple',row.point?'coordinate':'q'],['yandex',row.point?'whatshere[point]':'text']]){
      const url=new URL(links[provider]);assert.equal(url.protocol,'https:');
      assert.equal(url.searchParams.get(parameter),row.point?(provider==='yandex'?[row.point[1],row.point[0]]:row.point).join(','):row.destination);
      for(const forbidden of ['origin','saddr','daddr','destination','rtext','dir_action','rtt'])assert.equal(url.searchParams.has(forbidden),false,`${provider}: ${forbidden}`);
      if(provider==='google')assert.equal(url.pathname,'/maps/search/');
      if(provider==='apple'&&row.point){assert.equal(url.pathname,'/place');assert.equal(url.searchParams.get('name'),row.address);}
      if(provider==='yandex'&&row.point)assert.equal(url.searchParams.get('whatshere[zoom]'),'17');
    }
  }
  assert.equal(L.mapLinks(''),null);
  const hostile=new URL(L.bankSearch('A & query=<script>alert(1)</script>','batumi').google);
  assert.equal(hostile.hostname,'www.google.com');assert.match(hostile.searchParams.get('query'),/A & query=<script>/);
  assert.equal([...hostile.searchParams.keys()].join(','),'api,query');
});
test('ambiguous text and multi-place source links never become precise directions',()=>{
  const L=require('../locations.js');
  const mjc=L.branches('mjc','tbilisi')[0];
  assert.deepEqual(mjc.point,[41.7102279,44.7970808]);
  assert.equal(new URL(L.branchLinks(mjc).yandex).searchParams.get('whatshere[point]'),'44.7970808,41.7102279');
  const ambiguous=L.branches('rico','tbilisi').find(b=>b.id==='rico:tbilisi:1');
  assert.equal(ambiguous.point,null);
  assert.equal(new URL(L.branchLinks(ambiguous).google).pathname,'/maps/search/');
  assert.equal(new URL(L.branchLinks(ambiguous).apple).searchParams.has('daddr'),false);
});
test('one direct map link needs no chooser, location permission, app detection or save',async()=>{
  let requests=0;const a=await app({},false,{geolocation:{getCurrentPosition(){requests++;}}});
  a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
  assert.equal(a.els.openDeviceMap.hidden,false);assert.equal(a.els.openDeviceMap.target,'_blank');
  assert.match(a.els.openDeviceMap.href,/^https:/);assert.equal(a.els.openDeviceMap.events.click,undefined);
  assert.equal(requests,0);assert.equal(a.writes[C.STORAGE_KEY],undefined);
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.doesNotMatch(source,/navigator\.geolocation|watchPosition|getInstalledRelatedApps|window\.open|toggleMapChooser|gelcost-map-preference/);
  assert.match(html,/<a[^>]*id="openDeviceMap"[^>]*>Смотреть на карте<\/a>/);
  assert.doesNotMatch(html,/id="(?:mapChooser|rememberMap|openMapChooser|changeMapChoice|mapSystem)"/);
  assert.match(a.els.branchMapHint.textContent,/«Моё местоположение»/);
});
test('Batumi remains the HTML default and empty-city fallback',async()=>{
  const a=await app({},false,{city:null});assert.equal(a.els.exchangeCity.value,'batumi');
  a.els.exchangeCity.value='';a.run('selectOffer("office:rico");toggleOfferLocation("office:rico")');assert.match(a.els.branchAddress.textContent,/^Батуми,/);
  assert.equal(require('../locations.js').branches('rico')[0].city,'batumi');assert.equal(a.writes[C.STORAGE_KEY],undefined);
});
test('Android hands the same point or search to the OS without choosing a package or origin',async()=>{
  const L=require('../locations.js');
  for(const row of [...L.branches('mjc','all'),...L.branches('rico','all')]){
    const links=L.branchLinks(row),intent=L.deviceMapLink(links);
    assert.ok(intent.startsWith('intent:0,0?q='));
    const [data,extras]=intent.split('#Intent;');
    assert.equal(decodeURIComponent(data.split('?q=')[1]),new URL(links.google).searchParams.get('query'));
    assert.match(extras,/scheme=geo;action=android.intent.action.VIEW;/);
    assert.equal(decodeURIComponent(extras.split('S.browser_fallback_url=')[1].split(';')[0]),links.google);
    assert.doesNotMatch(intent,/package=|component=|origin=|rtext=|daddr=|destination=/);
  }
  assert.equal(L.deviceMapLink(null),null);
  assert.equal(L.deviceMapLink({google:'javascript:alert(1)'}),null);
  assert.equal(L.deviceMapLink({google:'https://evil.example/maps/search/?query=a'}),null);
  const injected=L.deviceMapLink(L.mapLinks('A #Intent;package=evil;end & extra=value'));
  assert.equal(injected.split('#Intent;').length,2);
  assert.equal(injected.split(';package=').length,1);
  const a=await app({},false,{userAgent:'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile'});
  a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
  assert.equal(a.els.openDeviceMap.hidden,false);assert.equal(a.els.openDeviceMap.target,'_self');
  assert.equal(a.els.openDeviceMap.href,L.deviceMapLink(L.branchLinks(L.branches('mjc','tbilisi')[0])));
});
test('Apple devices get a direct Apple place link; other desktops get Google',async()=>{
  const L=require('../locations.js'),branch=L.branches('mjc','tbilisi')[0];
  for(const userAgent of ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)','iPad','iPod','Mozilla/5.0 (Macintosh; Intel Mac OS X)','Windows NT 10.0','Linux x86_64','']){
    const a=await app({},false,{userAgent});a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
    const provider=/(iPhone|iPad|iPod|Macintosh)/.test(userAgent)?'apple':'google';
    assert.equal(a.els.openDeviceMap.href,L.branchLinks(branch)[provider]);
    assert.equal(a.els.openDeviceMap.target,'_blank');
  }
});
test('old preferences cannot override direct Android maps or alter financial history',async()=>{
  const L=require('../locations.js'),branch=L.branches('mjc','tbilisi')[0];
  for(const saved of ['google','apple','yandex','system','__proto__','javascript:alert(1)']){
    const a=await app({'gelcost-map-preference':saved},false,{userAgent:'Android'});
    await purchase(a,'usd',8800,100);await cash(a,3);const before=a.writes[C.STORAGE_KEY];
    a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
    assert.equal(a.els.openDeviceMap.href,L.deviceMapLink(L.branchLinks(branch)));
    assert.equal(a.els.openDeviceMap.target,'_self');
    assert.equal(a.writes[C.STORAGE_KEY],before);assert.equal(a.writes['gelcost-map-preference'],saved);
    const b=await app(a.writes,false,{userAgent:'Android'});b.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
    assert.equal(b.els.openDeviceMap.href,a.els.openDeviceMap.href);assert.equal(b.writes[C.STORAGE_KEY],before);
  }
});
test('direct Android maps follow the branch and clear when no address is shown',async()=>{
  const a=await app({},false,{userAgent:'Android'}),L=require('../locations.js');
  a.run('toggleAllOffers();selectOffer("office:rico");toggleOfferLocation("office:rico")');
  a.els.branchChoice.value='rico:tbilisi:1';a.run('selectBranch()');
  assert.equal(a.els.openDeviceMap.href,L.deviceMapLink(L.branchLinks(L.branches('rico','tbilisi')[1])));
  a.els.exchangeCity.value='batumi';a.els.exchangeCity.events.change();
  assert.equal(a.els.openDeviceMap.hidden,true);assert.equal(a.els.openDeviceMap.href,'');
  a.run('selectOffer("office:rico");toggleOfferLocation("office:rico")');a.els.branchChoice.value='rico:batumi:3';a.run('selectBranch()');
  const expected=L.deviceMapLink(L.branchLinks(L.branches('rico','batumi')[3]));
  assert.equal(a.els.openDeviceMap.href,expected);
  a.run('showView("purchase");showView("data");showView("exchange")');assert.equal(a.els.openDeviceMap.href,expected);
  await cash(a,3);a.run('selectOffer("manual");toggleOfferLocation("manual")');
  assert.equal(a.els.openDeviceMap.hidden,true);assert.equal(a.els.openDeviceMap.href,'');
});
test('denied storage cannot prevent direct map opening',async()=>{
  for(const userAgent of ['Android','iPhone','Windows']){
    const a=await app({},true,{userAgent});a.run('selectOffer("office:mjc");toggleOfferLocation("office:mjc")');
    assert.equal(a.els.openDeviceMap.hidden,false);
    assert.match(a.els.openDeviceMap.href,userAgent==='Android'?/^intent:/:/^https:/);
    assert.equal(a.els.openDeviceMap.events.click,undefined);
  }
});
test('malformed point coordinates fall back to address search rather than an incorrect pin',()=>{
  const L=require('../locations.js'),branch=L.branches('mjc','tbilisi')[0];
  for(const point of [{},[],[41],[41,44,10],[NaN,44],[41,Infinity],[91,44],[41,181],['41',44]]){
    assert.deepEqual(L.branchLinks({...branch,point}),L.mapLinks(branch.destination));
  }
  assert.equal(L.branchLinks(null),null);
});
test('Batumi pins from the official Rico links are exact, while street and ATM links are not guessed',()=>{
  const L=require('../locations.js'),rows=L.branches('rico','batumi');
  assert.deepEqual(rows.find(r=>r.id==='rico:batumi:3').point,[41.6338869,41.6068395]);
  assert.deepEqual(rows.find(r=>r.id==='rico:batumi:4').point,[41.643279,41.654425]);
  for(const id of ['rico:batumi:1','rico:batumi:2','rico:batumi:5']){
    const branch=rows.find(r=>r.id===id);assert.equal(branch.point,null);assert.match(new URL(L.branchLinks(branch).google).searchParams.get('query'),/Batumi, Georgia$/);
  }
});
test('a newly opened purchase can save while the previous editor submission is still pending',async()=>{
  const a=await app();a.run('showView("data")');
  const first=purchase(a,'usd',8800,100);
  const second=purchase(a,'usd',2700,25);
  await Promise.all([first,second]);
  assert.equal(a.state().usdPurchases.length,2);
  near(a.run('routeValues().usdCost'),92);
});
test('a completed earlier purchase cannot hide a later editor or switch its currency',async()=>{
  const a=await app();a.run('showView("purchase")');
  const first=purchase(a,'usd',8800,100);
  a.run('openPurchase("usdt")');a.els.purchaseRub.value='8655';a.els.purchaseQty.value='100';
  await first;
  assert.equal(a.run('selectedPayment'),'bybit');assert.equal(a.run('purchaseKind'),'usdt');
  assert.equal(a.els.purchasePanel.classList.contains('show'),true);
  assert.equal(a.els.purchaseRub.value,'8655');assert.equal(a.els.purchaseQty.value,'100');
  await a.run('savePurchase()');assert.equal(a.state().usdtPurchases.length,1);
});
test('exchange rates have four decimals while ruble amounts include kopecks',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await purchase(a,'usdt',8655,100);await cash(a,2.62);
  assert.equal(a.els.cashAvg.textContent,'88,0000 ₽/$');
  assert.equal(a.els.usdtAvg.textContent,'86,5500 ₽/USDT');
  assert.equal(a.els.cashGelRate.textContent,'2,6200 ₾');
  assert.equal(a.els.cashPrice.textContent,'33,5878 ₽/₾');
  assert.match(a.els.cashTotal.textContent,/^≈ 3\s358,78 ₽$/);
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
test('ruble kopecks are visible in the result, history and official comparison without changing stored amounts',async()=>{
  const a=await app();await purchase(a,'usd','8800,37',100);await cash(a,2.62);
  const saved=a.writes[C.STORAGE_KEY];a.els.quickGel.value='12,50';a.run('calc()');
  assert.equal(a.els.rublesResult.textContent,'≈ 419,86 ₽');
  assert.equal(a.els.cashTotal.textContent,'≈ 419,86 ₽');assert.equal(a.els.quickRub.textContent,'419,86 ₽');
  assert.match(a.els.usdHistory.innerHTML,/8\s800,37 ₽/);
  assert.match(a.els.marketNote.textContent,/12,50 ₾ ≈ 419,85 ₽/);
  assert.equal(a.state().usdPurchases[0].rub,8800.37);assert.equal(a.writes[C.STORAGE_KEY],saved);
  near(a.run('routeValues().cash'),88.0037/2.62);
});
test('large ruble totals keep kopecks instead of abbreviating millions',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  a.els.quickGel.value='1000000';a.run('calc()');
  assert.match(a.els.rublesResult.textContent,/^≈ 33\s587\s786,26 ₽$/);
  assert.equal(a.els.cashTotal.textContent,a.els.rublesResult.textContent);
  a.els.exchangeAmount.value='1000000';a.run('selectOffer("office:mjc")');
  assert.match(a.els.exchangeBasis.textContent,/88\s000\s000,00 ₽/);
});
test('comparison shows savings smaller than one ruble with kopecks',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);await purchase(a,'usdt',8655,100);
  a.run('openRate("bybit")');a.els.actualGel.value='100';a.els.actualUsdt.value='38.75';await a.run('saveRate()');
  a.els.quickGel.value='12,50';a.run('calc()');assert.match(a.els.heroRoute.textContent,/USDT дешевле примерно на 0,62 ₽/);
});
test('actual USDT preview displays four decimal rates without rounding its calculation',async()=>{
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
  assert.match(a.els.quickRub.textContent,/3\s358,78/);
  const b=await app(a.writes);near(b.run('routeValues().cash'),88/2.62);assert.equal(b.state().usdPurchases.length,1);
});
test('trailing text, blank and overflow inputs cannot silently save',async()=>{
  const a=await app();await purchase(a,'usd','8800abc','100');assert.equal(a.state().usdPurchases.length,0);
  assert.equal(a.els.purchaseError.classList.contains('show'),true);
  await cash(a,'2.6bad');assert.equal(a.state().cashGelRate,null);
  await purchase(a,'usd','8800','100');await cash(a,'2.62');
  for(const amount of ['-20','abc','','1e300']){a.els.quickGel.value=amount;a.run('calc()');assert.equal(a.els.quickRub.textContent,'— ₽');assert.equal(a.els.quickError.classList.contains('show'),true);}
});
test('actual USDT charge includes only the explicit received reward',async()=>{
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
test('regression: active tab fetches all six sources every five minutes without writing purchases',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);a.els.bankChoice.value='2';await a.run('applyBank()');
  const saved=a.writes[C.STORAGE_KEY],timer=[...a.timers.values()].find(t=>t.interval);
  for(let minute=1;minute<5;minute++){a.advance(60000);await timer.fn();}
  assert.equal(a.requests.length,6);assert.deepEqual([...a.requests].sort(),Object.keys(allSourceData()).sort());
  a.advance(60000);
  for(const data of Object.values(a.responses))data.fetchedAt=new Date(a.run('Date.now()')).toISOString();
  a.responses['./market-rates.json'].offers[1].buy=2.63;
  await timer.fn();assert.equal(a.requests.length,12);assert.equal(a.state().cashGelRate,2.63);
  assert.equal(a.writes[C.STORAGE_KEY],saved);
  await timer.fn();assert.equal(a.requests.length,12);
  a.advance(5*60000);await timer.fn();assert.equal(a.requests.length,18);
});
test('hidden tab skips polling, then refreshes on return without repeated requests',async()=>{
  const a=await app(),timer=[...a.timers.values()].find(t=>t.interval);
  a.run('document.hidden=true');a.advance(10*60000);await timer.fn();assert.equal(a.requests.length,6);
  a.run('document.hidden=false');a.documentEvents.visibilitychange();await a.settle();assert.equal(a.requests.length,12);
  a.documentEvents.visibilitychange();await a.settle();assert.equal(a.requests.length,12);
});
test('network recovery retries immediately and busy requests are not duplicated',async()=>{
  const a=await app();for(const url of Object.keys(a.responses))a.responses[url]='hang';
  const pending=a.events.online();await a.settle();assert.equal(a.requests.length,12);
  a.advance(5*60000);await [...a.timers.values()].find(t=>t.interval).fn();assert.equal(a.requests.length,12);
  for(const timer of [...a.timers.values()].filter(t=>t.ms===10000))timer.fn();await pending;
  Object.assign(a.responses,allSourceData());
  await a.events.online();assert.equal(a.requests.length,18);assert.equal(a.els.marketStatus.textContent,'ориентир');
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
  assert.match(a.els.cashTotal.textContent,/3\s358,78/);assert.match(a.els.bybitTotal.textContent,/3\s288,90/);assert.match(a.els.heroRoute.textContent,/USDT дешевле/);
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
  assert.equal(a.els.rublesNextAction.hidden,true);assert.match(a.els.rublesResult.textContent,/^≈ 3\s367,78 ₽$/);
  assert.match(a.els.rublesRate.textContent,/33,6778/);near(a.run('routeValues().cash'),88/2.613);
});
test('single answer uses the selected method, not the cheaper or stale alternative',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  await purchase(a,'usdt',8655,100);a.run('openRate("bybit")');a.els.actualGel.value='100';a.els.actualUsdt.value='38';await a.run('saveRate()');
  a.run('state.bybitGelUpdated=0;setPayment("cash")');
  assert.match(a.els.rublesResult.textContent,/3\s358,78/);assert.equal(a.els.rublesStatus.classes.has('stale'),false);
  assert.equal(a.els.rublesNextAction.hidden,true);
  a.run('setPayment("bybit")');assert.match(a.els.rublesResult.textContent,/3\s288,90/);
  assert.equal(a.els.rublesStatus.classes.has('stale'),true);assert.equal(a.els.rublesNextAction.textContent,'Указать списание USDT');
});
test('USDT setup opens a visible editor without requiring the optional comparison',async()=>{
  const a=await app();a.run('showView("purchase");setPayment("bybit");continueRublesSetup()');
  assert.equal(a.run('purchaseKind'),'usdt');await purchase(a,'usdt',8655,100);
  a.run('continueRublesSetup()');assert.equal(a.run('rateKind'),'bybit');
  assert.equal(a.els.ratePanel.parentElement,a.els.rublesEditorHost);assert.equal(a.els.ratePanel.classes.has('show'),true);
  a.els.actualGel.value='100';a.els.actualUsdt.value='38.75';await a.run('saveRate()');
  assert.equal(a.els.rublesNextAction.hidden,true);assert.match(a.els.rublesResult.textContent,/3\s353,81/);
  a.els.quickGel.value='12,50';a.run('calc()');assert.equal(a.els.rublesResult.textContent,'≈ 419,23 ₽');
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
test('applying a bank returns to cash even when the previous payment was USDT',async()=>{
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
test('V5.5 canonical history and USDT actual rate migrate without a second reward adjustment',async()=>{
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

test('manual exchange previews and saves without a RUB purchase or a view change',async()=>{
  const a=await app();a.run('openRate("cash")');a.els.rateValue.value='3,0000';a.run('updateRatePreview()');
  assert.match(a.els.ratePreview.textContent,/100,00 USD.*300,00 ₾/);
  assert.equal(a.state().cashGelRate,null,'the preview does not save a draft');
  await a.run('saveRate()');assert.equal(a.run('currentView'),'exchange');
  assert.equal(a.els.exchangeReceive.textContent,'≈ 300,00 ₾');
  assert.equal(a.els.exchangeResultLabel.textContent,'Свой курс · 1 USD = 3,0000 ₾');
  assert.equal(a.els.selectedSource.hidden,true);assert.equal(a.els.selectedBranches.hidden,true);
  assert.equal(a.els.applyOfferButton.disabled,false);
  assert.equal(a.run('offersForCity().filter(row=>row.kind==="manual").length'),1);
  assert.match(a.els.offerStatus.textContent,/Актуальные предложения: 5/,'manual is not counted as a verified public offer');
});
test('manual exchange remains usable without providers, on reload and after refresh',async()=>{
  const a=await app();await cash(a,3);const saved=a.writes[C.STORAGE_KEY];
  const b=await app(a.writes);assert.equal(b.els.exchangeReceive.textContent,'≈ 300,00 ₾');
  b.run('banks=null;offices=null;bankFailed=true;officeFailed=true;renderOffers()');
  assert.equal(b.els.exchangeReceive.textContent,'≈ 300,00 ₾');
  assert.equal(b.els.applyOfferButton.disabled,false);
  b.els.exchangeAmount.value='125,50';b.run('renderOffers()');assert.equal(b.els.exchangeReceive.textContent,'≈ 376,50 ₾');
  b.els.exchangeCity.value='batumi';b.els.exchangeCity.events.change();assert.equal(b.run('selectedOffer'),'manual');
  await b.run('refreshAllRates()');assert.equal(b.els.exchangeReceive.textContent,'≈ 376,50 ₾');assert.equal(b.writes[C.STORAGE_KEY],saved);
});
test('editing the exchange amount updates the open manual preview; cancel and invalid input never replace a saved rate',async()=>{
  const a=await app();await cash(a,3);const before=a.writes[C.STORAGE_KEY];
  a.run('openRate("cash")');a.els.rateValue.value='2,5000';a.els.exchangeAmount.value='200';a.els.exchangeAmount.events.input();
  assert.match(a.els.ratePreview.textContent,/500,00 ₾/);assert.equal(a.els.exchangeReceive.textContent,'≈ 600,00 ₾');
  a.run('closeInline("ratePanel")');assert.equal(a.writes[C.STORAGE_KEY],before);
  await cash(a,'bad');assert.equal(a.run('currentView'),'exchange');assert.equal(a.writes[C.STORAGE_KEY],before);
});
test('a stale manual quote opens RUB calculation with a warning and without extending its timestamp',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,3);a.advance(2*C.DAY);a.run('showView("exchange")');
  const stamp=a.state().cashGelUpdated,saved=a.writes[C.STORAGE_KEY];
  assert.match(a.els.exchangeResultLabel.textContent,/нужна проверка/);
  await a.run('applyOffer()');assert.equal(a.run('currentView'),'purchase');
  assert.match(a.els.rublesStatus.textContent,/сохранённому/);assert.match(a.els.rublesStatus.textContent,/мой ручной курс/);
  assert.equal(a.state().cashGelUpdated,stamp);assert.equal(a.writes[C.STORAGE_KEY],saved);
});
test('manual to provider to manual selection preserves history and follows the saved source on reload',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,3);const history=JSON.stringify(a.state().usdPurchases);
  a.run('selectOffer("office:mjc")');assert.equal(a.state().cashGelRate,3,'browsing is only a preview');
  a.run('selectOffer("manual")');assert.equal(a.els.exchangeReceive.textContent,'≈ 300,00 ₾');
  a.els.bankChoice.value='2';await a.run('applyBank()');a.run('showView("exchange")');
  assert.equal(a.run('selectedOffer'),'bank:2');assert.equal(a.state().cashGelRate,2.61);
  assert.equal(a.run('offersForCity().some(row=>row.kind==="manual")'),false);
  const b=await app(a.writes);assert.equal(b.run('selectedOffer'),'bank:2');
  await cash(b,2.7);assert.equal(b.run('selectedOffer'),'manual');assert.equal(b.state().cashBankId,null);
  assert.equal(JSON.stringify(b.state().usdPurchases),history);
});
test('a saved source is selected after its asynchronous public snapshot arrives',async()=>{
  const a=await app();a.run('selectOffer("bank:2")');await a.run('applyOffer()');
  // Simulate an early partial load followed by the bank response.
  a.run('showView("exchange");banks=null;offerSelectionExplicit=false;renderOffers()');
  await a.run('refreshBanks()');assert.equal(a.run('selectedOffer'),'bank:2');
});
test('saving a rate started on Exchange does not hijack a later navigation',async()=>{
  const a=await app();a.run('openRate("cash")');a.els.rateValue.value='3';
  const saving=a.run('saveRate()');a.run('showView("data")');await saving;
  assert.equal(a.run('currentView'),'data');assert.equal(a.state().cashGelRate,3);
});
test('half-kopeck rounding is exact across cash, USDT, comparison, official and USD basis totals',async()=>{
  const a=await app();await purchase(a,'usd',8005,100);await cash(a,2.5);await purchase(a,'usdt',8000,100);
  a.run('openRate("bybit");setRateMode("quote")');a.els.rateValue.value='2.5';await a.run('saveRate()');
  a.els.quickGel.value='0,25';a.run('setPayment("cash")');
  assert.equal(a.els.rublesResult.textContent,'≈ 8,01 ₽');assert.equal(a.els.cashTotal.textContent,'≈ 8,01 ₽');
  assert.match(a.els.heroRoute.textContent,/USDT дешевле примерно на 0,01 ₽/);
  a.responses['./rates.json'].usdRub=80.05;a.responses['./rates.json'].usdGel=2.5;await a.run('refreshOfficial()');
  assert.match(a.els.marketNote.textContent,/≈ 8,01 ₽/);
  a.els.exchangeAmount.value='0,1';a.run('showView("exchange")');assert.match(a.els.exchangeBasis.textContent,/8,01 ₽/);
  const b=await app();await purchase(b,'usdt',8005,100);b.run('openRate("bybit");setRateMode("quote")');b.els.rateValue.value='2.5';await b.run('saveRate()');
  b.els.quickGel.value='0,25';b.run('calc()');assert.equal(b.els.rublesResult.textContent,'≈ 8,01 ₽');
  b.run('openRate("bybit");setRateMode("actual")');b.els.actualGel.value='0.25';b.els.actualUsdt.value='0.1';await b.run('saveRate()');
  assert.equal(b.els.rublesResult.textContent,'≈ 8,01 ₽');assert.equal(b.els.bybitTotal.textContent,'≈ 8,01 ₽');
});
test('very small decimal quotes round-trip through the editor without exponent notation',async()=>{
  const a=await app();await cash(a,'0,00000001');a.run('openRate("cash")');
  assert.equal(a.els.rateValue.value,'0,00000001');await a.run('saveRate()');assert.equal(a.state().cashGelRate,0.00000001);
});

test('switching payment hides an incompatible rate editor but retains its exact draft',async()=>{
  const a=await app();a.run('openRate("bybit");setRateMode("quote")');
  a.els.rateValue.value='2,65001234';const before=a.writes[C.STORAGE_KEY];
  a.run('setPayment("cash")');assert.equal(a.els.ratePanel.classes.has('show'),false);
  a.run('openRate("bybit")');assert.equal(a.run('rateMode'),'quote');
  assert.equal(a.els.rateValue.value,'2,65001234');assert.equal(a.run('selectedPayment'),'bybit');
  assert.equal(a.writes[C.STORAGE_KEY],before);
});
test('USD and USDT purchase drafts never mix when switching the selected payment',async()=>{
  const a=await app();a.run('openPurchase("usd")');a.els.purchaseRub.value='8 800,37';a.els.purchaseQty.value='100';
  a.run('setPayment("bybit")');assert.equal(a.els.purchasePanel.classes.has('show'),false);
  a.run('openPurchase("usdt")');assert.equal(a.els.purchaseRub.value,'');
  a.els.purchaseRub.value='8655';a.els.purchaseQty.value='100,50';
  a.run('openPurchase("usd")');assert.equal(a.els.purchaseRub.value,'8 800,37');assert.equal(a.els.purchaseQty.value,'100');
  assert.equal(a.run('selectedPayment'),'cash');
  a.run('openPurchase("usdt")');assert.equal(a.els.purchaseQty.value,'100,50');assert.equal(a.run('selectedPayment'),'bybit');
  assert.equal(a.state().usdPurchases.length,0);assert.equal(a.state().usdtPurchases.length,0);
});
test('closing and toggling a purchase form preserves a draft; saving starts the next purchase empty',async()=>{
  const a=await app();a.run('openPurchase("usd")');a.els.purchaseRub.value='8800';a.els.purchaseQty.value='100';
  a.run('openPurchase("usd")');assert.equal(a.els.purchasePanel.classes.has('show'),false);
  a.run('openPurchase("usd")');assert.equal(a.els.purchaseRub.value,'8800');
  a.run('closeInline("purchasePanel");openPurchase("usd")');assert.equal(a.els.purchaseQty.value,'100');
  await a.run('savePurchase()');a.run('openPurchase("usd")');
  assert.equal(a.els.purchaseRub.value,'');assert.equal(a.els.purchaseQty.value,'');assert.equal(a.state().usdPurchases.length,1);
});
test('rate drafts survive close and reopen, without changing the active calculation until saved',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);const before=a.writes[C.STORAGE_KEY];
  a.run('openRate("cash")');a.els.rateValue.value='3,0123';a.run('openRate("cash")');
  assert.equal(a.els.ratePanel.classes.has('show'),false);
  a.run('openRate("cash")');assert.equal(a.els.rateValue.value,'3,0123');assert.equal(a.writes[C.STORAGE_KEY],before);
  await a.run('saveRate()');a.run('openRate("cash")');assert.equal(a.els.rateValue.value,'3,0123');assert.equal(a.state().cashGelRate,3.0123);
});
test('actual USDT draft and cashback disclosure survive a visit to cash editing',async()=>{
  const a=await app();a.run('openRate("bybit")');a.els.actualGel.value='50';a.els.actualUsdt.value='19,78';a.els.actualReward.value='0,30';a.els.rewardDetails.open=true;
  a.run('openRate("cash")');a.els.rateValue.value='2,6200';
  a.run('openRate("bybit")');assert.equal(a.run('rateMode'),'actual');assert.equal(a.els.actualGel.value,'50');assert.equal(a.els.actualUsdt.value,'19,78');assert.equal(a.els.actualReward.value,'0,30');assert.equal(a.els.rewardDetails.open,true);
  a.run('openRate("cash")');assert.equal(a.els.rateValue.value,'2,6200');assert.equal(a.run('rateMode'),'quote');
});
test('saved USDT forecast reopens in quote mode including after reload',async()=>{
  const a=await app();await purchase(a,'usdt',8655,100);a.run('openRate("bybit");setRateMode("quote")');a.els.rateValue.value='2,65123456';await a.run('saveRate()');
  for(const tab of [a,await app(a.writes)]){
    tab.run('openRate("bybit")');assert.equal(tab.run('rateMode'),'quote');assert.equal(tab.els.rateValue.value,'2,65123456');
    assert.equal(tab.els.quoteModeButton.attrs['aria-pressed'],'true');
  }
});
test('unchanged closed rate forms do not become stale drafts after an external rate change',async()=>{
  const a=await app();await cash(a,2.62);a.run('openRate("cash");closeInline("ratePanel")');
  a.els.bankChoice.value='2';await a.run('applyBank()');a.run('openRate("cash")');
  assert.equal(a.els.rateValue.value,'2,6100');
});
test('manual rate can be changed directly from the ruble screen without losing its entered price',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  a.els.quickGel.value='12,50';a.run('showView("purchase");setPayment("cash");editPaymentRate()');
  assert.equal(a.run('currentView'),'purchase');assert.equal(a.els.ratePanel.parentElement,a.els.rublesEditorHost);
  a.els.rateValue.value='2,5';await a.run('saveRate()');assert.equal(a.els.rublesResult.textContent,'≈ 440,00 ₽');assert.equal(a.els.quickGel.value,'12,50');
});
test('comparison actions request the missing purchase first and then the rate',async()=>{
  const a=await app();a.run('showView("purchase");editComparison("bybit")');
  assert.equal(a.els.purchasePanel.classes.has('show'),true);assert.equal(a.run('purchaseKind'),'usdt');
  assert.equal(a.els.bybitCompareAction.textContent,'Добавить покупку USDT');
  a.els.purchaseRub.value='8655';a.els.purchaseQty.value='100';await a.run('savePurchase()');
  a.run('editComparison("bybit")');assert.equal(a.els.ratePanel.classes.has('show'),true);assert.equal(a.run('rateKind'),'bybit');
  a.run('editComparison("cash")');assert.equal(a.run('purchaseKind'),'usd');assert.equal(a.run('selectedPayment'),'cash');
});
test('long result typography preserves all digits and resets when returning to a small price',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await cash(a,2.62);
  a.els.quickGel.value='1000000';a.run('calc()');assert.equal(a.els.rublesResult.dataset.moneySize,'medium');
  assert.match(a.els.rublesResult.textContent,/33\s587\s786,26 ₽/);
  a.els.quickGel.value='1';a.run('calc()');assert.equal(a.els.rublesResult.dataset.moneySize,'normal');assert.equal(a.els.rublesResult.textContent,'≈ 33,59 ₽');
});
test('delayed editor focus cannot steal focus after navigating or closing the form',async()=>{
  const a=await app();let focused=0;a.els.purchaseRub.focus=()=>focused++;
  a.run('openPurchase("usd")');a.run('showView("exchange")');
  for(const timer of a.timers.values())if(timer.ms===50)timer.fn();assert.equal(focused,0);
  a.run('showView("purchase");closeInline("purchasePanel")');
  for(const timer of a.timers.values())if(timer.ms===50)timer.fn();assert.equal(focused,0);
});

test('imported stale personal quote retains its date and caution across refresh and reversed drafts',async()=>{
  const a=await app();await cash(a,'2,6000');a.advance(2*C.DAY);
  const saved=a.writes[C.STORAGE_KEY],stamp=a.state().cashGelUpdated;
  a.run('showView("exchange");selectOffer("manual");useOfferForPlan()');
  assert.equal(a.run('plan.quoteMeta.gelBuy.checkedAt'),stamp);
  assert.match(a.els.planSource0.textContent,/Свой сохранённый курс.*нужна проверка/);
  assert.ok(a.els.planSource0.textContent.includes(a.run(`checkedText(${stamp})`)));
  assert.equal(a.els.planSource0.classes.has('stale'),true);
  assert.equal(a.els.planCaution.hidden,false);
  assert.match(a.els.planCaution.textContent,/старый личный курс/);
  assert.equal(a.els.planResult.textContent,'≈ 260,00 ₾');
  await a.run('refreshAllRates()');
  assert.equal(a.els.planCaution.hidden,false);
  a.run('reversePlan()');
  assert.equal(a.els.planQuote0.value,'','A personal BUY is not a reverse SELL quote');
  assert.equal(a.els.planCaution.hidden,true,'A warning only describes a quote used by the active route');
  a.els.planQuote0.value='2,7000';a.run('editPlanQuote(0);reversePlan()');
  assert.equal(a.els.planQuote0.value,'2,6000');
  assert.equal(a.run('plan.quoteMeta.gelBuy.checkedAt'),stamp,'Editing SELL must not clear BUY provenance');
  assert.equal(a.els.planCaution.hidden,false);
  assert.equal(a.writes[C.STORAGE_KEY],saved,'Transfer, refresh and reversal do not restamp personal data');
});

test('editing another leg keeps stale personal provenance; editing that exact quote clears it',async()=>{
  const a=await app();await cash(a,2.6);a.advance(2*C.DAY);
  a.run('selectOffer("manual");useOfferForPlan()');
  a.els.planFrom.value='RUB';a.run('changePlanRoute()');
  a.els.planQuote0.value='90';a.run('editPlanQuote(0)');
  assert.equal(a.els.planCaution.hidden,false);
  assert.match(a.els.planSource1.textContent,/нужна проверка/);
  a.els.planQuote1.value='2,65';a.run('editPlanQuote(1)');
  assert.equal(a.els.planSource1.textContent,'Свой курс');
  assert.equal(a.els.planSource1.classes.has('stale'),false);
  assert.equal(a.els.planCaution.hidden,true);
  assert.equal(a.run('Object.hasOwn(plan.quoteMeta,"gelBuy")'),false);
  await a.run('refreshAllRates()');assert.equal(a.els.planQuote1.value,'2,65');
  assert.equal(a.els.planCaution.hidden,true);
});

test('fresh imported personal quote becomes visibly stale when its own timestamp expires',async()=>{
  const a=await app();await cash(a,2.6);a.run('selectOffer("manual");useOfferForPlan()');
  assert.match(a.els.planSource0.textContent,/Свой сохранённый курс/);
  assert.equal(a.els.planCaution.hidden,true);
  a.advance(2*C.DAY);a.run('calc()');
  assert.equal(a.els.planCaution.hidden,false);assert.match(a.els.planSource0.textContent,/нужна проверка/);
  a.els.exchangeAmount.value='100';a.run('showView("exchange")');
  a.responses['./exchange-rates.json']=officeData();
  a.responses['./exchange-rates.json'].fetchedAt=a.run('new Date().toISOString()');
  a.responses['./exchange-rates.json'].offers.forEach(row=>row.checkedAt=a.run('new Date().toISOString()'));
  await a.run('refreshOffices()');a.run('selectOffer("office:mjc");useOfferForPlan()');
  assert.equal(a.els.planCaution.hidden,true);assert.equal(a.run('Object.hasOwn(plan.quoteMeta,"gelBuy")'),false);
  assert.match(a.els.planSource0.textContent,/MJC/);
});

test('want display prepares enough money and explains ceiling, while give keeps ordinary rounding',async()=>{
  const a=await app();a.run('showView("calculator")');
  a.els.planFrom.value='USD';a.els.planTo.value='GEL';a.run('changePlanRoute();setPlanMode("want")');
  a.els.planAmount.value='100';a.els.planQuote0.value='2,61';a.run('editPlanQuote(0)');
  assert.equal(a.els.planResult.textContent,'≈ 38,32 USD');
  assert.equal(a.els.planRounding.hidden,false);assert.match(a.els.planRounding.textContent,/вверх до 0,01 USD/);
  assert.equal(a.els.planStepResult0.textContent,'','Do not show a contradictory rounded-down payment breakdown');
  a.els.planAmount.value='261';a.run('renderPlanner()');
  assert.equal(a.els.planResult.textContent,'≈ 100,00 USD');assert.equal(a.els.planRounding.hidden,true);
  a.run('setPlanMode("give")');a.els.planAmount.value='38,31';a.run('renderPlanner()');
  assert.equal(a.els.planResult.textContent,'≈ 99,99 ₾');assert.equal(a.els.planRounding.hidden,true);
  assert.match(a.els.planStepResult0.textContent,/38,31 USD → 99,99 ₾/);
  a.els.planAmount.value='bad';a.run('renderPlanner()');assert.equal(a.els.planRounding.hidden,true);
});

test('settings draft survives toggle and another editor, then saves and reloads explicitly',async()=>{
  const a=await app();a.run('showView("data");openSettings()');
  a.els.feePct.value='1,5';a.els.cashbackPct.value='0,5';
  const saved=a.writes[C.STORAGE_KEY];
  a.run('openSettings();openSettings()');
  assert.equal(a.els.feePct.value,'1,5');assert.equal(a.els.cashbackPct.value,'0,5');
  a.run('openPurchase("usd");closeInline("purchasePanel");openSettings()');
  assert.equal(a.els.feePct.value,'1,5');assert.equal(a.els.cashbackPct.value,'0,5');
  a.run('showView("exchange");showView("data")');
  assert.equal(a.els.feePct.value,'1,5');assert.equal(a.writes[C.STORAGE_KEY],saved);
  await a.run('saveSettings()');
  assert.equal(a.state().feePct,1.5);assert.equal(a.state().cashbackPct,0.5);
  a.run('closeInline("settingsPanel");openSettings()');
  assert.equal(C.number(a.els.feePct.value),1.5);assert.equal(C.number(a.els.cashbackPct.value),0.5);
  const b=await app(a.writes);b.run('showView("data");openSettings()');
  assert.equal(b.els.feePct.value,'1.5');assert.equal(b.els.cashbackPct.value,'0.5');
});

test('untouched settings forms use external changes instead of stale draft values',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  a.run('showView("data");openSettings();closeInline("settingsPanel")');
  b.run('showView("data");openSettings()');b.els.feePct.value='2';b.els.cashbackPct.value='1';
  await b.run('saveSettings()');shared.flush();
  a.run('openSettings()');assert.equal(a.els.feePct.value,'2');assert.equal(a.els.cashbackPct.value,'1');
  b.els.feePct.value='3';await b.run('saveSettings()');shared.flush();
  a.run('closeInline("settingsPanel");openSettings()');
  assert.equal(a.els.feePct.value,'3');assert.equal(a.els.cashbackPct.value,'1');
});

test('dirty settings survive external synchronization and invalid input remains editable',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  a.run('showView("data");openSettings()');a.els.feePct.value='1,5';a.els.cashbackPct.value='0,5';
  a.run('closeInline("settingsPanel")');
  b.run('showView("data");openSettings()');b.els.feePct.value='3';b.els.cashbackPct.value='1';await b.run('saveSettings()');shared.flush();
  a.run('openSettings()');assert.equal(a.els.feePct.value,'1,5');assert.equal(a.els.cashbackPct.value,'0,5');
  a.els.feePct.value='bad';await a.run('saveSettings()');
  assert.equal(a.els.settingsError.classes.has('show'),true);assert.equal(a.state().feePct,3);
  a.run('openPurchase("usdt");closeInline("purchasePanel");openSettings()');assert.equal(a.els.feePct.value,'bad');
  a.els.feePct.value='1,5';await a.run('saveSettings()');
  assert.equal(a.els.settingsError.classes.has('show'),false);assert.equal(a.state().feePct,1.5);
});

test('entering an amount does not invalidate an empty quote and bad quotes get a local error',async()=>{
  const a=await app();a.run('showView("calculator")');
  a.els.planAmount.value='100';a.run('renderPlanner()');
  assert.equal(a.els.planQuote0.value,'');assert.equal(a.els.planQuote0.attrs['aria-invalid'],'false');
  assert.equal(a.els.planQuoteError0.classes.has('show'),false);
  assert.equal(a.els.planNext.textContent,'Введите курс на шаге 1.');
  for(const value of ['bad','0','0,000000001','1000000001']){
    a.els.planQuote0.value=value;a.run('editPlanQuote(0)');
    assert.equal(a.els.planQuote0.attrs['aria-invalid'],'true');
    assert.equal(a.els.planQuoteError0.classes.has('show'),true);
    assert.match(a.els.planQuoteError0.textContent,/Курс — от/);
    assert.equal(a.els.planResult.textContent,'— ₾');
  }
  a.els.planQuote0.value='90';a.run('editPlanQuote(0)');
  assert.equal(a.els.planQuoteError0.classes.has('show'),false);
  assert.equal(a.els.planQuote0.attrs['aria-invalid'],'false');
  a.els.planQuote0.value='';a.run('editPlanQuote(0)');
  assert.equal(a.els.planQuote0.attrs['aria-invalid'],'false');assert.equal(a.els.planQuoteError0.textContent,'');
});

test('a single action panel follows the selected row, including after list collapse and refresh',async()=>{
  const a=await app();
  const assertAdjacent=()=>{
    const list=a.els.offerList.children,index=list.findIndex(row=>row.dataset.offerKey===a.run('selectedOffer'));
    assert.ok(index>=0);assert.equal(list[index+1],a.els.offerActions);
    assert.equal(a.els.offerActions.parentElement,a.els.offerList);
    assert.equal(a.els.offerActions.hidden,false);
    assert.equal(list.filter(node=>node===a.els.offerActions).length,1);
    assert.equal(a.els.offerActionsHome.children.includes(a.els.offerActions),false);
  };
  assertAdjacent();a.run('toggleAllOffers();selectOffer("bank:1")');assertAdjacent();
  a.run('toggleAllOffers()');assert.equal(a.run('allOffers'),false);assertAdjacent();
  assert.equal(a.els.offerList.children.filter(row=>row.dataset.offerKey).length,4,'Top three plus an explicitly selected lower row remain visible');
  for(let i=0;i<3;i++){await a.run('refreshAllRates()');assertAdjacent();}
  a.run('selectOffer("office:mjc")');assertAdjacent();
  assert.equal(a.els.offerList.children.some(node=>node.children.includes(a.els.offerActions)),false,'Actions must not be nested in a rate button');
});

test('moving selected actions retains expanded branch, destination and focused action on refresh',async()=>{
  const a=await app();a.run('toggleAllOffers();selectOffer("office:rico");toggleOfferLocation()');
  a.els.branchChoice.value='rico:tbilisi:1';a.run('selectBranch()');
  const destination=a.els.openDeviceMap.href,before=a.writes[C.STORAGE_KEY];
  let focuses=0;a.els.planOfferButton.focus=()=>focuses++;
  a.run('document.activeElement=document.getElementById("planOfferButton");toggleAllOffers()');
  await a.run('refreshAllRates()');
  assert.equal(a.run('expandedOffer'),'office:rico');assert.equal(a.els.offerLocationPanel.hidden,false);
  assert.equal(a.els.branchChoice.value,'rico:tbilisi:1');assert.equal(a.els.openDeviceMap.href,destination);
  assert.ok(focuses>0);assert.equal(a.writes[C.STORAGE_KEY],before);
  const index=a.els.offerList.children.findIndex(row=>row.dataset.offerKey==='office:rico');
  assert.equal(a.els.offerList.children[index+1],a.els.offerActions);
});

test('invalid exchange amounts disable and guard transfer to the calculator',async()=>{
  const a=await app();a.run('selectOffer("office:mjc")');
  const before=a.run('JSON.stringify(plan)'),saved=a.writes[C.STORAGE_KEY];
  for(const value of ['','bad','0','-1','1000000001']){
    a.els.exchangeAmount.value=value;a.els.exchangeAmount.events.input();
    assert.equal(a.els.planOfferButton.disabled,true);
    assert.equal(a.els.offerActionNote.hidden,false);assert.match(a.els.offerActionNote.textContent,/Введите сумму/);
    a.run('useOfferForPlan()');assert.equal(a.run('currentView'),'exchange');
    assert.equal(a.run('JSON.stringify(plan)'),before);
  }
  a.els.exchangeAmount.value='125,50';a.els.exchangeAmount.events.input();
  assert.equal(a.els.planOfferButton.disabled,false);assert.equal(a.els.offerActionNote.hidden,true);
  a.run('useOfferForPlan()');assert.equal(a.els.planAmount.value,'125,50');
  assert.equal(a.writes[C.STORAGE_KEY],saved);
});

test('visible offer refresh action remains busy until both offer sources finish',async()=>{
  const a=await app();let releaseBanks,releaseOffices;
  const bank=bankData(),office=officeData();
  a.responses['./market-rates.json']=new Promise(resolve=>releaseBanks=resolve);
  a.responses['./exchange-rates.json']=new Promise(resolve=>releaseOffices=resolve);
  const pending=a.run('refreshAllRates()');await a.settle();
  assert.equal(a.els.refreshOffersButton.disabled,true);assert.equal(a.els.refreshOffersButton.textContent,'Проверяем…');
  releaseBanks(bank);await a.settle();assert.equal(a.els.refreshOffersButton.disabled,true);
  releaseOffices(office);await pending;
  assert.equal(a.els.refreshOffersButton.disabled,false);assert.equal(a.els.refreshOffersButton.textContent,'Обновить курсы');
  a.responses['./market-rates.json']=new Error('offline');a.responses['./exchange-rates.json']=new Error('offline');
  await a.run('refreshAllRates()');assert.equal(a.els.refreshOffersButton.disabled,false);
  assert.equal(a.els.offerStatus.classes.has('stale'),true);assert.match(a.els.offerStatus.textContent,/Нет свежих курсов банков и обменников/);
});

test('an open untouched settings form reflects external updates before it can overwrite them',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  a.run('showView("data");openSettings()');
  b.run('showView("data");openSettings()');b.els.feePct.value='3';b.els.cashbackPct.value='1';
  await b.run('saveSettings()');shared.flush();
  assert.equal(a.state().feePct,3,'The application state already received the new value');
  const shown={fee:a.els.feePct.value,cashback:a.els.cashbackPct.value};
  await a.run('saveSettings()');
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).feePct,3,'Saving an untouched form must not overwrite an external update');
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).cashbackPct,1);
  assert.deepEqual(shown,{fee:'3',cashback:'1'},'The visible clean fields must follow their synchronized values');
});

test('an open dirty settings form retains its draft through external updates and repeated saves',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  a.run('showView("data");openSettings()');a.els.feePct.value='1,5';a.els.cashbackPct.value='0,5';
  b.run('showView("data");openSettings()');b.els.feePct.value='3';b.els.cashbackPct.value='1';
  await b.run('saveSettings()');shared.flush();
  assert.equal(a.state().feePct,3);assert.equal(a.els.feePct.value,'1,5');assert.equal(a.els.cashbackPct.value,'0,5');
  await a.run('saveSettings()');shared.flush();
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).feePct,1.5);
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).cashbackPct,0.5);
  await a.run('saveSettings()');shared.flush();
  assert.equal(a.state().feePct,1.5);assert.equal(a.run('settingsDraft'),null);
  b.els.feePct.value='4';b.els.cashbackPct.value='2';await b.run('saveSettings()');shared.flush();
  assert.equal(a.els.feePct.value,'4');assert.equal(a.els.cashbackPct.value,'2');
  await a.run('saveSettings()');
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).feePct,4);
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).cashbackPct,2);
});

test('completion of a settings save cannot replace a newer draft, even if it matches the old baseline',async()=>{
  const a=await app();a.run('showView("data");openSettings()');
  a.els.feePct.value='1,5';a.els.cashbackPct.value='0,5';
  const pending=a.run('saveSettings()');
  a.els.feePct.value='0';a.els.cashbackPct.value='0';
  await pending;
  assert.equal(a.state().feePct,1.5);assert.equal(a.state().cashbackPct,0.5);
  assert.equal(a.els.feePct.value,'0');assert.equal(a.els.cashbackPct.value,'0');
  a.run('closeInline("settingsPanel");openSettings()');
  assert.equal(a.els.feePct.value,'0');assert.equal(a.els.cashbackPct.value,'0');
  await a.run('saveSettings()');assert.equal(a.state().feePct,0);assert.equal(a.state().cashbackPct,0);
  assert.equal(a.run('settingsDraft'),null);
  // Restoring and saving the old baseline while the first save still waits is
  // an intentional second edit, not a clean-form no-op.
  const b=await app();b.run('showView("data");openSettings()');
  b.els.feePct.value='1,5';const first=b.run('saveSettings()');
  b.els.feePct.value='0';const second=b.run('saveSettings()');
  await Promise.all([first,second]);assert.equal(b.state().feePct,0);
  assert.equal(b.run('settingsDraft'),null);assert.equal(b.run('settingsPending'),0);
});

test('saving a clean settings form is a no-op even before an external storage event arrives',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  a.run('showView("data");openSettings()');
  b.run('showView("data");openSettings()');b.els.feePct.value='3';b.els.cashbackPct.value='1';
  await b.run('saveSettings()');
  const latest=shared.writes[C.STORAGE_KEY];
  assert.equal(a.state().feePct,0,'The delayed storage event has intentionally not been delivered');
  await a.run('saveSettings()');
  assert.equal(shared.writes[C.STORAGE_KEY],latest,'Untouched fields cannot replace newer persisted settings');
  assert.equal(a.els.feePct.value,'3');assert.equal(a.els.cashbackPct.value,'1');
  assert.equal(a.state().feePct,3);assert.equal(a.state().cashbackPct,1);
  assert.match(a.els.actionStatus.textContent,/не изменились/);
  a.els.feePct.value='4';await a.run('saveSettings()');
  assert.equal(JSON.parse(shared.writes[C.STORAGE_KEY]).feePct,4,'An intentional dirty edit still saves');
});

// V5.7 independent cash currencies: fixtures are normalized GEL per one unit.
const manualCurrencyKey=currency=>'gelcost-v5.7-manual-'+currency;
function saveCurrencyManual(a,currency,value){
  a.run(`changeExchangeCurrency('${currency}');openExchangeManual()`);
  a.els.exchangeManualValue.value=value;a.els.exchangeManualValue.events.input();
  a.run('saveExchangeManual()');
}

test('V5.7 all six sources load separately and currency UI preserves legacy USD by default',async()=>{
  const a=await app({},false,{city:null});
  assert.equal(a.els.exchangeCurrency.value,'USD');assert.equal(a.els.exchangeCity.value,'batumi');
  assert.equal(a.run('offersForCity().every(row=>row.currency==="USD")'),true);
  assert.deepEqual([...a.requests].sort(),Object.keys(allSourceData()).sort());
  for(const currency of ['EUR','RUB']){
    a.run(`changeExchangeCurrency('${currency}')`);
    assert.equal(a.run(`offersForCity().every(row=>row.currency==='${currency}')`),true);
    assert.equal(a.run('offersForCity().filter(row=>row.kind==="office").length'),1,'Only Rico in Batumi');
    assert.equal(a.els.legacyOfferDetails.hidden,true);
  }
  assert.equal(a.run('offersForCity().some(row=>row.kind==="bank")'),false,'RUB must not borrow another currency bank feed');
  assert.match(a.els.currencyCoverage.textContent,/Банковские курсы пока не подключены/);
  a.run('changeExchangeCurrency("USD")');assert.equal(a.els.legacyOfferDetails.hidden,false);
  assert.equal(a.writes[C.STORAGE_KEY],undefined);
});

test('V5.7 switching currencies retains independent amounts, selection and unsaved raw drafts',async()=>{
  const a=await app();a.els.exchangeAmount.value='123,45';
  a.run('selectOffer("office:rico");openExchangeManual()');a.els.rateValue.value='2,7';
  a.run('changeExchangeCurrency("EUR")');a.els.exchangeAmount.value='234,56';
  a.run('selectOffer("office:EUR:rico");openExchangeManual()');a.els.exchangeManualValue.value='3,';
  a.run('changeExchangeCurrency("RUB")');a.els.exchangeAmount.value='76543,21';
  a.run('openExchangeManual()');a.els.exchangeManualValue.value='4,125';
  a.run('changeExchangeCurrency("EUR");openExchangeManual()');
  assert.equal(a.els.exchangeAmount.value,'234,56');assert.equal(a.els.exchangeManualValue.value,'3,');
  assert.equal(a.run('selectedOffer'),'office:EUR:rico');
  a.run('changeExchangeCurrency("USD");openExchangeManual()');
  assert.equal(a.els.exchangeAmount.value,'123,45');assert.equal(a.els.rateValue.value,'2,7');assert.equal(a.run('selectedOffer'),'office:rico');
  a.run('changeExchangeCurrency("RUB");openExchangeManual()');
  assert.equal(a.els.exchangeAmount.value,'76543,21');assert.equal(a.els.exchangeManualValue.value,'4,125');
  assert.match(a.els.exchangeManualLabel.textContent,/100 ₽/);
  assert.equal(a.writes[manualCurrencyKey('EUR')],undefined);assert.equal(a.writes[manualCurrencyKey('RUB')],undefined);
  assert.equal(a.writes[C.STORAGE_KEY],undefined);
});

test('V5.7 new manual rates save independently and cannot change USD or USDT personal history',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await purchase(a,'usdt',8655,100);await cash(a,2.62);
  a.run('showView("exchange")');const personal=a.writes[C.STORAGE_KEY];
  saveCurrencyManual(a,'EUR','3,25');
  assert.equal(a.els.exchangeReceive.textContent,'≈ 325,00 ₾');
  assert.equal(a.run('selectedOffer'),'manual:EUR');
  const euro=a.writes[manualCurrencyKey('EUR')];assert.equal(JSON.parse(euro).rate,'3.25');
  a.run('changeExchangeCurrency("RUB")');a.els.exchangeAmount.value='100000';saveCurrencyManual(a,'RUB','3,5');
  assert.equal(a.els.exchangeReceive.textContent,'≈ 3\u00a0500,00 ₾');
  assert.equal(JSON.parse(a.writes[manualCurrencyKey('RUB')]).rate,'0.035');
  assert.equal(a.writes[manualCurrencyKey('EUR')],euro);
  assert.equal(a.writes[C.STORAGE_KEY],personal);
  a.run('applyOffer()');assert.equal(a.writes[C.STORAGE_KEY],personal,'Non-USD apply cannot alter old personal cash basis');
  a.run('changeExchangeCurrency("USD")');assert.equal(a.state().cashGelRate,2.62);
  assert.equal(a.els.exchangeReceive.textContent,'≈ 262,00 ₾');
});

test('V5.7 saved manual currency selection restores on reload instead of silently choosing a public quote',async()=>{
  const a=await app();saveCurrencyManual(a,'EUR','3,25');saveCurrencyManual(a,'RUB','3,5');
  const b=await app(a.writes);
  for(const [currency,result] of [['EUR','≈ 325,00 ₾'],['RUB','≈ 350,00 ₾']]){
    b.run(`changeExchangeCurrency('${currency}')`);
    assert.equal(b.run('selectedOffer'),'manual:'+currency,`${currency}: explicitly saved personal quote should remain selected`);
    assert.equal(b.els.exchangeReceive.textContent,result);
  }
  assert.equal(b.writes[manualCurrencyKey('EUR')],a.writes[manualCurrencyKey('EUR')]);
  assert.equal(b.writes[manualCurrencyKey('RUB')],a.writes[manualCurrencyKey('RUB')]);
});

test('V5.7 manual forms preserve errors and input on invalid, blocked or corrupt storage',async()=>{
  const a=await app();saveCurrencyManual(a,'EUR','3,25');const saved=a.writes[manualCurrencyKey('EUR')];
  a.run('openExchangeManual()');
  for(const input of ['', 'bad', '-1', '0', '1000000001']){
    a.els.exchangeManualValue.value=input;a.run('saveExchangeManual()');
    assert.equal(a.writes[manualCurrencyKey('EUR')],saved);assert.equal(a.els.exchangeManualPanel.classes.has('show'),true);
    assert.equal(a.els.exchangeManualError.classes.has('show'),true);assert.equal(a.els.exchangeManualValue.value,input);
  }
  a.shared.failWrites=true;a.els.exchangeManualValue.value='3,3';a.run('saveExchangeManual()');
  assert.equal(a.writes[manualCurrencyKey('EUR')],saved);assert.equal(a.els.exchangeManualValue.value,'3,3');
  assert.match(a.els.exchangeManualError.textContent,/не сохранён/);
  const b=await app({[manualCurrencyKey('RUB')]:'broken'});
  saveCurrencyManual(b,'RUB','3,25');assert.equal(b.writes[manualCurrencyKey('RUB')],'broken');
  assert.match(b.els.exchangeManualError.textContent,/не перезаписан/);
  assert.equal(b.els.exchangeManualPanel.classes.has('show'),true);
});

test('V5.7 manual forms close around maps and navigation but retain their currency draft',async()=>{
  const a=await app({},false,{city:'batumi'});
  a.run('changeExchangeCurrency("EUR");selectOffer("office:EUR:rico");openExchangeManual()');
  a.els.exchangeManualValue.value='3,14159';a.run('toggleOfferLocation()');
  assert.equal(a.els.exchangeManualPanel.classes.has('show'),false);assert.equal(a.els.offerLocationPanel.hidden,false);
  a.run('openExchangeManual()');assert.equal(a.els.offerLocationPanel.hidden,true);assert.equal(a.els.exchangeManualValue.value,'3,14159');
  a.run('showView("calculator");showView("exchange");openExchangeManual()');
  assert.equal(a.els.exchangeManualValue.value,'3,14159');
  a.els.exchangeCity.value='kobuleti';a.els.exchangeCity.events.change();
  assert.equal(a.els.exchangeManualValue.value,'3,14159');assert.equal(a.writes[manualCurrencyKey('EUR')],undefined);
});

test('V5.7 EUR source failure is isolated from RUB and USD, retains dated quotes, and blocks application',async()=>{
  const a=await app();a.run('changeExchangeCurrency("EUR");selectOffer("office:EUR:rico")');
  const before=a.run('JSON.stringify(plan)');
  a.responses['./market-rates-eur.json']=new Error('offline');a.responses['./exchange-rates-eur.json']=new Error('offline');
  await a.run('refreshAllRates()');
  assert.equal(a.els.planOfferButton.disabled,true);assert.match(a.els.offerStatus.textContent,/Нет свежих курсов банков и обменников/);
  assert.equal(a.run('offersForCity().filter(row=>row.fresh).length'),0);
  a.run('useOfferForPlan()');assert.equal(a.run('JSON.stringify(plan)'),before);
  a.run('toggleOfferLocation()');assert.equal(a.els.offerLocationPanel.hidden,false,'An old quote can still expose an explicitly dated address');
  for(const currency of ['RUB','USD']){
    a.run(`changeExchangeCurrency('${currency}')`);assert.ok(a.run('offersForCity().filter(row=>row.fresh).length')>0);
    assert.equal(a.els.planOfferButton.disabled,false);
  }
  a.run('changeExchangeCurrency("EUR")');Object.assign(a.responses,allSourceData());
  await a.run('refreshAllRates()');assert.equal(a.els.planOfferButton.disabled,false);assert.equal(a.els.exchangeCurrency.value,'EUR');
});

test('V5.7 stale cached EUR remains dated on offline reload and never borrows fresh USD rates',async()=>{
  const stale=currencyOfficeData('EUR'),stamp=new Date(Date.now()-3*3600000).toISOString();
  stale.fetchedAt=stamp;for(const row of stale.offers)row.checkedAt=stamp;
  const a=await app({'gelcost-v5.7-offices-EUR':JSON.stringify(stale)},false,{responses:{'./exchange-rates-eur.json':new Error('offline'),'./market-rates-eur.json':new Error('offline')}});
  a.run('changeExchangeCurrency("EUR");selectOffer("office:EUR:rico")');
  assert.equal(a.els.planOfferButton.disabled,true);assert.match(a.els.exchangeResultLabel.textContent,/Нужна проверка/);
  assert.equal(a.run('offersForCity().every(row=>row.currency==="EUR"&&!row.fresh)'),true);
  assert.equal(a.run('offersForCity().find(row=>row.id==="rico").checkedAt'),stamp);
  a.run('changeExchangeCurrency("USD")');assert.equal(a.els.planOfferButton.disabled,false);
});

test('V5.7 mismatched currencies, missing nominal and malformed responses cannot enter another feed',async()=>{
  for(const bad of [officeData(),{...currencyOfficeData('EUR'),nominal:100},'malformed-json']){
    const a=await app({},false,{responses:{'./exchange-rates-eur.json':bad,'./market-rates-eur.json':new Error('offline')}});
    a.run('changeExchangeCurrency("EUR")');assert.equal(a.run('offersForCity().length'),0);
    assert.equal(a.els.exchangeReceive.textContent,'— ₾');assert.equal(a.els.planOfferButton.disabled,true);
  }
  const rub=currencyOfficeData('RUB');delete rub.offers[1].sourceNominal;
  const b=await app({},false,{responses:{'./exchange-rates-rub.json':rub}});
  b.run('changeExchangeCurrency("RUB")');assert.equal(b.run('offersForCity().length'),0);
  b.run('changeExchangeCurrency("EUR")');assert.ok(b.run('offersForCity().length')>0);
});

test('V5.7 new-city addresses stay city-bound for every currency while bank searches remain unscoped',async()=>{
  const a=await app(),L=require('../locations.js');
  for(const currency of ['USD','EUR','RUB'])for(const city of ['batumi','kobuleti','poti','kutaisi','tbilisi']){
    a.run(`changeExchangeCurrency('${currency}')`);a.els.exchangeCity.value=city;a.els.exchangeCity.events.change();
    const key=currency==='USD'?'office:rico':'office:'+currency+':rico';
    a.run(`selectOffer('${key}');toggleOfferLocation()`);
    assert.equal(a.els.branchAddress.textContent,L.branches('rico',city)[0].address);
    assert.equal(a.els.openDeviceMap.href,L.branchLinks(L.branches('rico',city)[0]).google);
    if(city!=='tbilisi')assert.equal(a.run('offersForCity().some(row=>row.id==="mjc")'),false);
    assert.equal(a.els.offerLocationPanel.hidden,false);
  }
  a.run('changeExchangeCurrency("EUR");selectOffer("bank:EUR:1");toggleOfferLocation()');
  assert.match(a.els.branchNotice.textContent,/не подтверждённая касса/);
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'EUR A bank branches, Tbilisi, Georgia');
  assert.equal(a.writes[C.STORAGE_KEY],undefined);
});

test('V5.7 EUR public quote passes to a direct planner and reverse uses a separate sell quote with fees',async()=>{
  const a=await app();a.run('changeExchangeCurrency("EUR");selectOffer("office:EUR:rico");useOfferForPlan()');
  assert.equal(a.els.planFrom.value,'EUR');assert.equal(a.els.planTo.value,'GEL');assert.equal(a.els.planStep1.hidden,true);
  assert.equal(a.els.planQuote0.value,'3,0100');assert.equal(a.els.planResult.textContent,'≈ 301,00 ₾');
  assert.match(a.els.planSource0.textContent,/покупает EUR/);
  a.run('reversePlan()');a.els.planAmount.value='306';a.run('renderPlanner()');
  assert.equal(a.els.planQuote0.value,'3,0600');assert.equal(a.els.planResult.textContent,'≈ 100,00 EUR');
  a.els.planFixed0.value='6';a.els.planPct0.value='10';a.run('editPlanFee(0)');
  assert.equal(a.els.planResult.textContent,'≈ 88,24 EUR');assert.match(a.els.planFixedLabel0.textContent,/₾/);
  a.run('setPlanMode("want")');a.els.planAmount.value='100';a.run('renderPlanner()');
  assert.equal(a.els.planResult.textContent,'≈ 346,00 ₾');
  assert.equal(a.writes[C.STORAGE_KEY],undefined);
});

test('V5.7 RUB public quote is normalized once, shown per100, transferred directly and reversed with its sell side',async()=>{
  const a=await app();a.run('changeExchangeCurrency("RUB");selectOffer("office:RUB:rico")');a.els.exchangeAmount.value='100000';a.run('renderOffers()');
  assert.equal(a.els.exchangeReceive.textContent,'≈ 3\u00a0250,00 ₾');
  const row=a.els.offerList.children.find(node=>node.dataset.offerKey==='office:RUB:rico');
  assert.match(row.children[1].textContent,/100 ₽ = 3,2500 ₾/);
  a.run('useOfferForPlan()');assert.equal(a.els.planFrom.value,'RUB');assert.equal(a.els.planVia.value,'direct');
  assert.equal(a.els.planStep1.hidden,true);assert.match(a.els.planQuoteLabel0.textContent,/100 ₽/);
  assert.equal(a.els.planQuote0.value,'3,2500');assert.equal(a.els.planResult.textContent,'≈ 3\u00a0250,00 ₾');
  a.els.planFixed0.value='1000';a.els.planPct0.value='1';a.run('editPlanFee(0)');
  assert.equal(a.els.planResult.textContent,'≈ 3\u00a0185,33 ₾');
  a.run('reversePlan()');a.els.planAmount.value='3350';a.run('renderPlanner()');
  assert.equal(a.els.planQuote0.value,'3,3500');assert.equal(a.els.planResult.textContent,'≈ 100\u00a0000,00 ₽');
  assert.equal(a.els.planFixed0.value,'0');assert.equal(a.els.planPct0.value,'0','Forward fees must not become reverse fees');
  a.run('reversePlan()');assert.equal(a.els.planFixed0.value,'1000');assert.equal(a.els.planPct0.value,'1');
});

test('V5.7 RUB per100 presentation does not invent binary digits on reopening or source transfer',async()=>{
  const a=await app();saveCurrencyManual(a,'RUB','3,3');a.run('openExchangeManual()');
  assert.equal(a.els.exchangeManualValue.value,'3,3000');
  a.run('closeInline("exchangeManualPanel");selectOffer("office:RUB:mjc");useOfferForPlan()');
  assert.equal(a.els.planQuote0.value,'3,3000');assert.equal(a.els.planResult.textContent,'≈ 330,00 ₾');
});

test('V5.7 imported new manual quotes retain provenance, do not become a reverse quote, and leave old purchases alone',async()=>{
  const a=await app();saveCurrencyManual(a,'RUB','3,25');
  const key=manualCurrencyKey('RUB'),saved=a.writes[key];a.advance(2*86400000);
  a.run('renderOffers();useOfferForPlan()');assert.match(a.els.planSource0.textContent,/нужна проверка/);
  assert.equal(a.els.planResult.textContent,'≈ 325,00 ₾');assert.equal(a.els.planCaution.hidden,false);
  a.run('reversePlan()');assert.equal(a.els.planQuote0.value,'');assert.equal(a.els.planResult.textContent,'— ₽');
  a.els.planQuote0.value='3,35';a.run('editPlanQuote(0)');a.run('reversePlan()');
  assert.equal(a.els.planQuote0.value,'3,2500');assert.match(a.els.planSource0.textContent,/нужна проверка/);
  assert.equal(a.writes[key],saved);assert.equal(a.writes[C.STORAGE_KEY],undefined);
});

test('V5.7 planner keeps its source currency and city when exchange filters change, then returns to the correct map',async()=>{
  const a=await app({},false,{city:'kobuleti'});
  a.run('changeExchangeCurrency("EUR");selectOffer("office:EUR:rico");useOfferForPlan()');
  const result=a.els.planResult.textContent;
  a.run('changeExchangeCurrency("USD")');a.els.exchangeCity.value='poti';a.els.exchangeCity.events.change();
  a.run('showView("calculator")');assert.equal(a.els.planResult.textContent,result);assert.equal(a.els.planQuote0.value,'3,0100');
  a.run('showPlanLocation()');assert.equal(a.els.exchangeCurrency.value,'EUR');assert.equal(a.els.exchangeCity.value,'kobuleti');
  assert.equal(a.els.branchAddress.textContent,'Кобулети, 3 Rustaveli Street');assert.equal(a.run('selectedOffer'),'office:EUR:rico');
  assert.equal(a.writes[C.STORAGE_KEY],undefined);
});

test('V5.7 storage events refresh separate manual records without replacing another currency or an open draft',async()=>{
  const shared=sharedBrowser(),a=await app({},false,{shared}),b=await app({},false,{shared});
  a.run('changeExchangeCurrency("EUR");openExchangeManual()');a.els.exchangeManualValue.value='3,14159';
  saveCurrencyManual(b,'EUR','3,25');shared.flush();
  assert.equal(a.els.exchangeManualValue.value,'3,14159');assert.equal(a.run('manualRecords.EUR.rate'),'3.25');
  saveCurrencyManual(b,'RUB','3,5');shared.flush();
  assert.equal(a.els.exchangeCurrency.value,'EUR');assert.equal(a.els.exchangeManualValue.value,'3,14159');
  assert.equal(a.run('manualRecords.EUR.rate'),'3.25');assert.equal(a.run('manualRecords.RUB.rate'),'0.035');
  assert.equal(shared.writes[C.STORAGE_KEY],undefined);
});

test('V5.7 manual RUB per100 keeps an exact half-tetri through save, reload, planner and reopening',async()=>{
  const a=await app();saveCurrencyManual(a,'RUB','3,01235');
  assert.equal(a.els.exchangeReceive.textContent,'≈ 301,24 ₾');
  assert.equal(JSON.parse(a.writes[manualCurrencyKey('RUB')]).rate,'0.0301235');
  a.run('openExchangeManual()');assert.equal(a.els.exchangeManualValue.value,'3,01235');
  assert.match(a.els.exchangeManualPreview.textContent,/301,24 ₾/);
  a.run('closeInline("exchangeManualPanel");useOfferForPlan()');
  assert.equal(a.els.planQuote0.value,'3,01235');assert.equal(a.els.planResult.textContent,'≈ 301,24 ₾');
  const b=await app(a.writes);b.run('changeExchangeCurrency("RUB")');
  assert.equal(b.els.exchangeReceive.textContent,'≈ 301,24 ₾');b.run('openExchangeManual()');
  assert.equal(b.els.exchangeManualValue.value,'3,01235');
});

test('V5.7 hidden direct route is cleared when changing from RUB to USD or USDT',async()=>{
  for(const currency of ['USD','USDT']){
    const a=await app();a.run('changeExchangeCurrency("RUB");selectOffer("office:RUB:rico");useOfferForPlan()');
    assert.equal(a.els.planVia.value,'direct');
    a.els.planFrom.value=currency;a.run('changePlanRoute("from")');
    assert.equal(a.els.planFrom.value,currency);assert.equal(a.els.planTo.value,'GEL');
    assert.equal(a.els.planViaGroup.hidden,true);assert.equal(a.els.planVia.value,'USD');
    assert.equal(a.els.planQuote0.value,'','A RUB quote must not become a USD or USDT quote');
    a.els.planAmount.value='100';a.els.planQuote0.value='2,5';a.run('editPlanQuote(0)');
    assert.equal(a.els.planResult.textContent,'≈ 250,00 ₾');assert.equal(a.els.planError.classes.has('show'),false);
  }
});

test('V5.7 untouched new manual forms cannot overwrite later values before or after their storage event',async()=>{
  for(const currency of ['EUR','RUB'])for(const deliverEvent of [false,true]){
    const key=manualCurrencyKey(currency),nominal=currency==='RUB'?100:1;
    const seed={version:1,currency,rate:currency==='RUB'?'0.03':'3',updatedAt:Date.now()};
    const shared=sharedBrowser({[key]:JSON.stringify(seed)}),a=await app({},false,{shared}),b=await app({},false,{shared});
    a.run(`changeExchangeCurrency('${currency}');openExchangeManual()`);
    assert.equal(a.els.exchangeManualValue.value,'3,0000');
    saveCurrencyManual(b,currency,'3,2');const latest=shared.writes[key];
    if(deliverEvent){shared.flush();assert.equal(a.els.exchangeManualValue.value,'3,2000');}
    a.run('saveExchangeManual()');
    assert.equal(shared.writes[key],latest,`${currency}: a clean form cannot revert a later saved rate`);
    assert.equal(Number(a.run(`manualRecords.${currency}.rate`))*nominal,3.2);
    assert.equal(a.els.exchangeManualPanel.classes.has('show'),false);
    assert.match(a.els.actionStatus.textContent,/не изменён/);
    a.run('openExchangeManual()');assert.equal(a.els.exchangeManualValue.value,'3,2000');
  }
});

test('V5.7 dirty new manual forms survive external changes and save only the intended currency',async()=>{
  for(const currency of ['EUR','RUB']){
    const key=manualCurrencyKey(currency),other=currency==='EUR'?'RUB':'EUR';
    const seed={version:1,currency,rate:currency==='RUB'?'0.03':'3',updatedAt:Date.now()};
    const shared=sharedBrowser({[key]:JSON.stringify(seed)}),a=await app({},false,{shared}),b=await app({},false,{shared});
    a.run(`changeExchangeCurrency('${currency}');openExchangeManual()`);a.els.exchangeManualValue.value='3,1';
    saveCurrencyManual(b,currency,'3,2');saveCurrencyManual(b,other,'3,4');shared.flush();
    const otherSaved=shared.writes[manualCurrencyKey(other)];
    assert.equal(a.els.exchangeManualValue.value,'3,1');
    a.run('saveExchangeManual()');
    assert.equal(JSON.parse(shared.writes[key]).rate,currency==='RUB'?'0.031':'3.1');
    assert.equal(shared.writes[manualCurrencyKey(other)],otherSaved);
    assert.equal(shared.writes[C.STORAGE_KEY],undefined);
    a.run('openExchangeManual()');assert.equal(a.els.exchangeManualValue.value,'3,1000');
  }
});

test('V5.7 completion of an earlier USD save cannot switch currency, discard EUR draft, or select a USD offer',async()=>{
  const a=await app();a.run('openExchangeManual()');a.els.rateValue.value='2,9';
  const pending=a.run('saveRate()');
  a.run('changeExchangeCurrency("EUR");selectOffer("office:EUR:rico");openExchangeManual()');
  a.els.exchangeManualValue.value='3,14159';a.els.exchangeAmount.value='123,45';
  await pending;
  assert.equal(a.state().cashGelRate,2.9);assert.equal(a.els.exchangeCurrency.value,'EUR');
  assert.equal(a.run('currentView'),'exchange');assert.equal(a.run('selectedOffer'),'office:EUR:rico');
  assert.equal(a.els.exchangeManualPanel.classes.has('show'),true);assert.equal(a.els.exchangeManualValue.value,'3,14159');
  assert.equal(a.els.exchangeAmount.value,'123,45');assert.equal(a.writes[manualCurrencyKey('EUR')],undefined);
});

test('V5.7 export includes independent exact EUR and RUB rates without changing the legacy personal state',async()=>{
  const a=await app();await purchase(a,'usd',8800,100);await purchase(a,'usdt',8655,100);
  const personal=a.writes[C.STORAGE_KEY];a.run('showView("exchange")');
  saveCurrencyManual(a,'EUR','3,25');saveCurrencyManual(a,'RUB','3,01235');
  await a.run('exportData()');assert.equal(a.downloads.length,1);
  const url=a.downloads[0].href;
  try{
    const backup=await (await fetch(url)).json();
    assert.equal(backup.cashExchangeRates.EUR.rate,'3.25');assert.equal(backup.cashExchangeRates.RUB.rate,'0.0301235');
    assert.equal(backup.cashExchangeRates.EUR.currency,'EUR');assert.equal(backup.cashExchangeRates.RUB.currency,'RUB');
    assert.deepEqual(backup.state.usdPurchases,JSON.parse(personal).usdPurchases);
    assert.deepEqual(backup.state.usdtPurchases,JSON.parse(personal).usdtPurchases);
    assert.equal(backup.state.cashExchangeRates,undefined);assert.equal(a.writes[C.STORAGE_KEY],personal);
  }finally{URL.revokeObjectURL(url);}
});

test('V5.7 copy: generic exchange feedback follows the amount, not USD, for every cash currency',async()=>{
  for(const currency of ['USD','EUR','RUB']){
    const a=await app();a.run(`changeExchangeCurrency('${currency}')`);
    for(const amount of ['','bad','0','1000000001']){
      a.els.exchangeAmount.value=amount;
      const message=a.run('calculationFeedback("Курс сохранён.","cash")');
      assert.equal(message,'Курс сохранён. Введите сумму обмена.');
      assert.doesNotMatch(message,/USD|доллар|пересчитана/);
    }
    a.els.exchangeAmount.value='12,50';
    assert.equal(a.run('calculationFeedback("Курс сохранён.","cash")'),'Курс сохранён. Сумма обмена пересчитана.');
    if(currency!=='USD')for(const [amount,quote,normalized] of [['','3,01235','0.0301235'],['bad','3,01245','0.0301245']]){
      a.els.exchangeAmount.value=amount;saveCurrencyManual(a,currency,quote);
      assert.equal(a.els.actionStatus.textContent,`Свой курс ${currency} сохранён. Введите сумму обмена.`);
      assert.equal(a.els.exchangeReceive.textContent,'— ₾');
      assert.equal(a.els.planOfferButton.disabled,true);
      assert.equal(JSON.parse(a.writes[manualCurrencyKey(currency)]).rate,currency==='RUB'?normalized:quote.replace(',','.'));
    }
    assert.equal(a.writes[C.STORAGE_KEY],undefined);
  }
});

test('V5.7 copy: price-in-rubles instruction names the actual disclosure and explicit apply action',async()=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const disclosure=html.match(/<details\b[^>]*id="legacyOfferDetails"[^>]*>([\s\S]*?)<\/details>/)[1];
  assert.match(disclosure,/<summary>Цена в рублях<\/summary>/);
  assert.match(disclosure,/<button\b[^>]*id="applyOfferButton"[^>]*onclick="applyOffer\(\)"[^>]*>Применить курс<\/button>/);
  assert.match(disclosure,/стоимости ваших USD/);
  const a=await app({},false,{city:'batumi'});await purchase(a,'usd',8800,100);a.run('showView("purchase")');
  assert.equal(a.els.rublesStatus.textContent,'В «Обмене» выберите USD и предложение. Раскройте «Цена в рублях» и нажмите «Применить курс».');
  const purchases=JSON.stringify(a.state().usdPurchases);
  a.run('openBanks();selectOffer("office:rico")');
  assert.equal(a.els.exchangeCurrency.value,'USD');assert.equal(a.els.legacyOfferDetails.hidden,false);assert.equal(a.els.legacyOfferDetails.open,true);
  assert.equal(a.state().cashOfficeId,null,'Selecting a row is only a preview');
  assert.equal(a.els.applyOfferButton.textContent,'Применить курс');assert.equal(a.els.applyOfferButton.disabled,false);
  await a.run('applyOffer()');
  assert.equal(a.run('currentView'),'purchase');assert.equal(a.state().cashOfficeId,'rico');assert.equal(a.state().cashGelRate,2.61);
  assert.equal(JSON.stringify(a.state().usdPurchases),purchases);assert.equal(a.els.cashTotal.textContent,'≈ 3\u00a0371,65 ₽');
});

test('V5.7 copy: stale public rates remain inspectable with maps, while transfer has a truthful next step',async()=>{
  for(const [currency,result] of [['USD','≈ 261,00 ₾'],['EUR','≈ 301,00 ₾'],['RUB','≈ 325,00 ₾']]){
    const a=await app({},false,{city:'batumi'});a.run(`changeExchangeCurrency('${currency}');selectOffer('${currency==='USD'?'office:rico':'office:'+currency+':rico'}')`);
    a.advance(3*3600000);a.run('renderOffers()');
    const plan=a.run('JSON.stringify(plan)'),personal=a.writes[C.STORAGE_KEY];
    assert.equal(a.els.exchangeReceive.textContent,result,'A dated estimate stays visible');
    assert.equal(a.els.exchangeResultLabel.textContent,'Нужна проверка · Rico');assert.equal(a.els.exchangeResultLabel.classes.has('stale'),true);
    assert.match(a.els.selectedOfferDetail.textContent,/Проверено .*Курс нельзя применить: данные устарели или не подтверждены\./);
    assert.equal(a.els.offerActionNote.hidden,false);
    assert.equal(a.els.offerActionNote.textContent,'Чтобы применить курс, обновите данные или введите свой.');
    assert.equal(a.els.planOfferButton.disabled,true);assert.equal(a.els.offerAddressButton.hidden,false);
    a.run('toggleOfferLocation()');assert.equal(a.els.offerLocationPanel.hidden,false);assert.ok(a.els.openDeviceMap.href);
    assert.equal(a.els.branchNotice.textContent,'Адрес сети — не подтверждение курса в этой кассе. Уточните курс, наличие валюты и часы работы.');
    a.run('useOfferForPlan()');await a.run('applyOffer()');
    assert.equal(a.run('currentView'),'exchange');assert.equal(a.run('JSON.stringify(plan)'),plan);assert.equal(a.writes[C.STORAGE_KEY],personal);
  }
});

test('V5.7 copy: RUB describes an unconnected bank integration, not the absence of a market',async()=>{
  const a=await app({},false,{city:'batumi'});a.run('changeExchangeCurrency("RUB")');
  assert.equal(a.els.currencyCoverage.hidden,false);
  assert.equal(a.els.currencyCoverage.textContent,'RUB: курсы обменников. Банковские курсы пока не подключены.');
  assert.doesNotMatch(a.els.currencyCoverage.textContent,/предложений.*нет|не существует|не обменивают/);
  assert.equal(a.requests.some(url=>url.includes('market-rates-rub')),false);
  assert.equal(a.run('offersForCity().some(row=>row.kind==="bank")'),false);
  assert.equal(a.els.exchangeReceive.textContent,'≈ 325,00 ₾');
  for(const currency of ['USD','EUR']){a.run(`changeExchangeCurrency('${currency}')`);assert.equal(a.els.currencyCoverage.hidden,true);assert.ok(a.run('offersForCity().some(row=>row.kind==="bank")'));}
});
