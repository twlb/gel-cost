// TRIZ regression checks for an explicit Exchange → Calculator contract.
// This harness is a DOM model, not browser or physical-device evidence.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const harnessSource=fs.readFileSync(path.join(__dirname,'app.test.cjs'),'utf8');
const boundary=harnessSource.indexOf('\nfunction inteliResponses(){');
assert.ok(boundary>0,'Review the shared harness boundary if app.test.cjs changes');
const preamble=harnessSource.slice(0,boundary);
assert.ok(!/^test\(/m.test(preamble),'Do not register another file’s tests');
const {app,C,cash,purchase}=new Function('require','__dirname',preamble+'\nreturn {app,C,cash,purchase};')(require,__dirname);

const snapshot=a=>a.run('JSON.stringify({plan,amount:$("planAmount").value})');
const intent=a=>a.run('JSON.stringify({from:plan.from,to:plan.to,via:plan.via,mode:plan.mode,amount:$("planAmount").value,fees:plan.fees})');
const saved=a=>JSON.stringify(a.writes);
function trackFocus(a){
  // Model focus explicitly; the shared harness normally leaves focus() empty.
  for(const [id,element] of Object.entries(a.els))element.focus=()=>a.run(`document.activeElement=$(${JSON.stringify(id)})`);
}
function draft(a,overrides={}){
  const setup={from:'GEL',to:'EUR',via:'USD',mode:'want',quotes:{gelEurSell:'3,0600'},quoteMeta:{},fees:{GELEUR:{pct:'10',fixed:'6'}},initialized:true,...overrides};
  const amount=Object.hasOwn(setup,'amount')?setup.amount:'123,45';delete setup.amount;
  a.run(`Object.assign(plan,${JSON.stringify(setup)});showView("calculator")`);
  a.els.planAmount.value=amount;a.run('renderPlanner()');
}
function exchange(a,currency='USD',amount='123'){
  a.run(`showView("exchange");changeExchangeCurrency(${JSON.stringify(currency)})`);
  a.els.exchangeAmount.value=amount;
  a.run(`selectOffer(${JSON.stringify(currency==='USD'?'office:rico':'office:'+currency+':rico')})`);
}
function openReplacement(a){
  const before=snapshot(a),written=saved(a);
  a.run('useOfferForPlan()');
  assert.equal(a.run('currentView'),'exchange');
  assert.equal(a.els.planReplacePanel.hidden,false,'Meaningful work needs confirmation before replacement');
  assert.equal(snapshot(a),before,'Opening confirmation must not modify the old calculation');
  assert.equal(saved(a),written,'Opening confirmation must not save personal or public data');
  return before;
}
function assertNewPlan(a,currency,amount,result){
  assert.equal(a.run('currentView'),'calculator');
  assert.equal(a.run('plan.from'),currency);assert.equal(a.run('plan.to'),'GEL');
  assert.equal(a.run('plan.mode'),'give');assert.equal(a.els.planAmount.value,amount);
  assert.equal(a.run('JSON.stringify(plannerPath())'),JSON.stringify([currency,'GEL']));
  assert.equal(a.run('JSON.stringify(plan.fees)'),'{}','New exchange calculation must not inherit hidden fees');
  assert.equal(a.run('JSON.stringify(plan.quotes)'),'{}','A public source must not inherit older manual quotes');
  assert.equal(a.run('JSON.stringify(plan.quoteMeta)'),'{}');
  assert.equal(a.els.planResult.textContent,result);
}

test('ordinary exchange starts the visible USD, EUR or RUB amount without personal writes',async()=>{
  for(const [currency,amount,result] of [['USD','123','≈ 321,03 ₾'],['EUR','123','≈ 370,23 ₾'],['RUB','10000','≈ 325,00 ₾']]){
    const a=await app();exchange(a,currency,amount);const written=saved(a),visible=a.els.exchangeReceive.textContent;
    a.run('useOfferForPlan()');assertNewPlan(a,currency,amount,result);
    assert.equal(a.els.planResult.textContent,visible);assert.equal(saved(a),written);
  }
});

test('merely visiting a blank calculator does not demand replacement confirmation',async()=>{
  const a=await app();a.run('selectOffer("office:rico");showView("calculator")');
  assert.equal(a.els.planAmount.value,'');exchange(a,'USD','123');
  a.run('useOfferForPlan()');assertNewPlan(a,'USD','123','≈ 321,03 ₾');
});

test('ordinary transfer explains and confirms replacing a want draft for every offered currency',async()=>{
  for(const [currency,amount,result] of [['USD','123','≈ 321,03 ₾'],['EUR','123','≈ 370,23 ₾'],['RUB','10000','≈ 325,00 ₾']]){
    const a=await app();draft(a);exchange(a,currency,amount);const written=saved(a);openReplacement(a);
    const text=a.els.planReplaceText.textContent;
    assert.ok(text.replace(/[\s\u00a0\u202f]/g,'').includes(amount),text);
    assert.ok(text.includes(currency)||currency==='RUB'&&text.includes('₽'),text);
    assert.match(text,/GEL|₾|лари/);assert.match(text,/комисс/i);
    a.run('confirmOfferPlan()');assertNewPlan(a,currency,amount,result);assert.equal(saved(a),written);
    assert.equal(a.els.planReplacePanel.hidden,true);
  }
});

test('cancel keeps invalid or unfinished input, directed quotes, fees and focus intact',async()=>{
  const a=await app();draft(a,{amount:'123,',quotes:{gelEurSell:'3,',rubBuy:'bad'},fees:{GELEUR:{pct:'-',fixed:'6,'}}});
  exchange(a);const before=openReplacement(a),written=saved(a);let focused=0;
  a.els.planOfferButton.focus=()=>focused++;
  a.run('cancelOfferPlan()');
  assert.equal(snapshot(a),before);assert.equal(saved(a),written);
  assert.equal(a.run('currentView'),'exchange');assert.equal(a.els.planReplacePanel.hidden,true);assert.equal(focused,1);
});

test('partial quotes, fees, route or mode are work even with a cleared amount',async()=>{
  const cases=[
    {quotes:{rubBuy:'90,'}},
    {fees:{RUBUSD:{pct:'',fixed:'-'}}},
    {from:'USD',to:'GEL'},
    {via:'USDT'},
    {mode:'want'},
    {amount:'bad'}
  ];
  for(const fields of cases){
    const a=await app();draft(a,{from:'RUB',to:'GEL',via:'USD',mode:'give',quotes:{},fees:{},amount:'',...fields});
    exchange(a);openReplacement(a);
  }
});

test('an explicitly selected calculator source survives a cleared amount until replacement is confirmed',async()=>{
  const a=await app();exchange(a);a.run('useOfferForPlan()');
  a.els.planAmount.value='';
  // Put the route back at defaults so the explicit source, not another field,
  // is the remaining work. The source itself was chosen through the public API.
  a.run('plan.from="RUB";plan.to="GEL";plan.via="USD";plan.mode="give";renderPlanner()');
  exchange(a);openReplacement(a);
});

test('new USD work cannot reinterpret a USDT amount or silently retain a previous commission',async()=>{
  for(const fields of [
    {from:'USDT',to:'GEL',quotes:{gelUsdtBuy:'2,5'}},
    {from:'GEL',to:'USDT',mode:'want',quotes:{gelUsdtSell:'2,6'}},
    {from:'RUB',to:'GEL',via:'USDT',quotes:{rubUsdtBuy:'90',gelUsdtBuy:'2,5'}},
    {from:'USD',to:'GEL',quotes:{gelBuy:'2,8'},fees:{USDGEL:{pct:'10',fixed:'5'}}},
    {from:'USD',to:'USD',quotes:{}}
  ]){
    const a=await app();draft(a,{amount:'100',...fields});exchange(a);openReplacement(a);
    a.run('confirmOfferPlan()');assertNewPlan(a,'USD','123','≈ 321,03 ₾');
  }
});

test('addressed reverse EUR quote replacement preserves the target and directed commissions',async()=>{
  const a=await app();draft(a);const before=intent(a),written=saved(a);
  a.run('choosePlanOffice();selectOffer("office:EUR:rico");useOfferForPlan()');
  assert.equal(a.run('currentView'),'calculator');assert.equal(intent(a),before);
  assert.equal(a.els.planQuote0.value,'3,0600');assert.equal(a.els.planResult.textContent,'≈ 425,73 ₾');
  assert.equal(saved(a),written);
});

test('addressed USD quote replacement preserves a two-leg target, raw amount and ruble quote',async()=>{
  const a=await app();draft(a,{from:'RUB',to:'GEL',via:'USD',mode:'want',amount:'261,00',quotes:{rubBuy:'100,00001'},fees:{USDGEL:{pct:'2',fixed:'1'}}});
  const before=intent(a),written=saved(a),quote=a.run('plan.quotes.rubBuy');
  a.run('choosePlanOffice();selectOffer("office:rico");useOfferForPlan()');
  assert.equal(intent(a),before);assert.equal(a.run('plan.quotes.rubBuy'),quote);assert.equal(saved(a),written);
  assert.equal(a.els.planQuote1.value,'2,6100');
});

test('confirmation rejects changed amount, currency, city, source or old calculation',async()=>{
  const changes=[
    a=>{a.els.exchangeAmount.value='124';},
    a=>a.run('changeExchangeCurrency("EUR")'),
    a=>{a.els.exchangeCity.value='batumi';},
    a=>a.run('selectOffer("office:mjc")'),
    a=>{a.els.planAmount.value='999,99';},
    a=>a.run('plan.fees.GELEUR.pct="11"')
  ];
  for(const change of changes){
    const a=await app();draft(a);exchange(a);openReplacement(a);change(a);
    const before=snapshot(a),written=saved(a);a.run('confirmOfferPlan()');
    assert.equal(a.run('currentView'),'exchange');assert.equal(snapshot(a),before);assert.equal(saved(a),written);
  }
});

test('confirmation rejects changed quote, timestamp, expiry or provider disappearance',async()=>{
  const changes=[
    a=>a.run('offices.offers.find(row=>row.id==="rico").buy=2.62'),
    a=>a.run('offices.offers.find(row=>row.id==="rico").checkedAt=new Date(Date.now()-1000).toISOString()'),
    a=>a.advance(3*3600000),
    a=>a.run('offices.offers=offices.offers.filter(row=>row.id!=="rico")')
  ];
  for(const change of changes){
    const a=await app();draft(a);exchange(a);const before=openReplacement(a),written=saved(a);change(a);
    a.run('confirmOfferPlan()');assert.equal(a.run('currentView'),'exchange');
    assert.equal(snapshot(a),before);assert.equal(saved(a),written);
  }
});

test('an open editor or invalid amount cannot apply a previously requested intent',async()=>{
  for(const change of [a=>a.run('openExchangeManual()'),a=>{a.els.exchangeAmount.value='bad';},a=>{a.els.exchangeAmount.value='';}]){
    const a=await app();draft(a);exchange(a);const before=openReplacement(a),written=saved(a);change(a);
    a.run('confirmOfferPlan()');assert.equal(snapshot(a),before);assert.equal(saved(a),written);
    assert.equal(a.run('currentView'),'exchange');
  }
});

test('leaving exchange cancels a pending replacement rather than applying it from another section',async()=>{
  const a=await app();draft(a);exchange(a);openReplacement(a);
  a.run('showView("insurance")');const before=snapshot(a),written=saved(a);
  a.run('confirmOfferPlan()');
  assert.equal(a.run('currentView'),'insurance');assert.equal(snapshot(a),before);assert.equal(saved(a),written);
  assert.equal(a.els.planReplacePanel.hidden,true);
});

test('new manual RUB quote keeps its nominal, exact half-tetri and isolated history',async()=>{
  const a=await app();await cash(a,2.6);
  a.run('changeExchangeCurrency("RUB");openExchangeManual()');
  a.els.exchangeManualValue.value='3,3350';a.els.exchangeManualValue.events.input();await a.run('saveExchangeManual()');
  a.els.exchangeAmount.value='100';a.run('renderOffers()');const visible=a.els.exchangeReceive.textContent,written=saved(a),personal=a.writes[C.STORAGE_KEY];
  a.run('useOfferForPlan()');
  assert.equal(a.run('currentView'),'calculator');assert.equal(a.els.planResult.textContent,visible);
  assert.equal(a.els.planResult.textContent,'≈ 3,34 ₾');assert.equal(a.els.planQuote0.value,'3,3350');
  assert.equal(a.run('JSON.stringify(plan.fees)'),'{}');
  assert.equal(a.run('Object.keys(plan.quotes).join()'),'gelRubBuy');
  assert.equal(a.run('Object.keys(plan.quoteMeta).join()'),'gelRubBuy');
  assert.equal(saved(a),written);assert.equal(a.writes[C.STORAGE_KEY],personal);
  a.run('reversePlan()');assert.equal(a.els.planQuote0.value,'');assert.match(a.els.planResult.textContent,/^—/);
});

test('background rerender preserves confirmation focus unless the exact offer changes',async()=>{
  const a=await app();trackFocus(a);draft(a);exchange(a);const before=openReplacement(a);
  a.els.planReplaceConfirm.focus();a.run('renderOffers()');
  assert.equal(a.run('document.activeElement.id'),'planReplaceConfirm');
  assert.equal(a.els.planReplacePanel.hidden,false);assert.equal(snapshot(a),before);
  a.run('offices.offers.find(row=>row.id==="rico").buy=2.62;renderOffers()');
  assert.equal(a.els.planReplacePanel.hidden,true);assert.equal(snapshot(a),before);
  assert.equal(a.run('document.activeElement.id'),'planOfferButton');
  assert.equal(a.els.planOfferButton.hidden,false);assert.equal(a.els.planOfferButton.disabled,false);
});

test('background expiry does not leave focus inside a hidden replacement panel',async()=>{
  const a=await app();trackFocus(a);draft(a);exchange(a);const before=openReplacement(a);
  a.els.planReplaceCancel.focus();a.advance(3*3600000);a.run('renderOffers()');
  assert.equal(a.els.planReplacePanel.hidden,true);assert.equal(snapshot(a),before);
  const focused=a.run('document.activeElement.id');
  assert.ok(['exchangeHeading','refreshOffersButton','exchangeAmount'].includes(focused),'Expired confirmation needs an available fallback, got '+focused);
  assert.equal(a.els[focused].hidden,false);assert.equal(a.els[focused].disabled||false,false);
});

test('expiry at the confirm click also restores focus without applying or saving anything',async()=>{
  const a=await app();trackFocus(a);draft(a);exchange(a);const before=openReplacement(a),written=saved(a);
  a.els.planReplaceConfirm.focus();a.advance(3*3600000);
  // No render between the last valid screen and this click: it must validate
  // and recover keyboard focus itself, not rely on a background timer.
  a.run('confirmOfferPlan()');
  assert.equal(a.els.planReplacePanel.hidden,true);assert.equal(snapshot(a),before);assert.equal(saved(a),written);
  const focused=a.run('document.activeElement.id');
  assert.ok(['exchangeHeading','refreshOffersButton','exchangeAmount'].includes(focused),'Focus remained on hidden confirmation: '+focused);
  assert.equal(a.els[focused].hidden,false);assert.equal(a.els[focused].disabled||false,false);
});

test('replacing or cancelling a draft leaves populated USD and USDT history byte-for-byte unchanged',async()=>{
  for(const action of ['cancelOfferPlan()','confirmOfferPlan()']){
    const a=await app();await purchase(a,'usd','9000,25','100');await purchase(a,'usdt','9200,75','101');await cash(a,'2,65001');
    draft(a);exchange(a,'EUR','123,45');const written=saved(a),personal=a.writes[C.STORAGE_KEY];
    openReplacement(a);a.run(action);
    assert.equal(saved(a),written);assert.equal(a.writes[C.STORAGE_KEY],personal);
    assert.equal(a.state().usdPurchases.length,1);assert.equal(a.state().usdtPurchases.length,1);
  }
});

test('replacement confirmation describes the exact entered amount, including sub-kopeck precision',async()=>{
  for(const amount of ['0,001','123.4567']){
    const a=await app();draft(a);exchange(a,'USD',amount);openReplacement(a);
    const text=a.els.planReplaceText.textContent.replace(/[\s\u00a0\u202f]/g,'').replace(/\./g,',');
    assert.ok(text.includes(amount.replace('.',',')),'Confirmation rounded a different amount than it will transfer: '+a.els.planReplaceText.textContent);
    a.run('confirmOfferPlan()');assert.equal(a.els.planAmount.value,amount);
  }
});
