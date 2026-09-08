// Regression checks use the existing unit DOM harness, not a real browser.
// Extract only the helper preamble: do not register or run app.test.cjs tests here.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const harnessSource=fs.readFileSync(path.join(__dirname,'app.test.cjs'),'utf8');
const boundary=harnessSource.indexOf('\nfunction inteliResponses(){');
assert.ok(boundary>0,'Existing app harness boundary must be reviewed if its layout changes');
const preamble=harnessSource.slice(0,boundary);
assert.ok(!/^test\(/m.test(preamble),'Only harness helpers may be imported');
const {app,C}=new Function('require','__dirname',preamble+'\nreturn {app,C};')(require,__dirname);

function goal(a,{from='GEL',to='EUR',via='USD',amount='123,45',fees={GELEUR:{fixed:'6',pct:'10'}}}={}){
  a.run(`Object.assign(plan,${JSON.stringify({from,to,via,mode:'want',fees,initialized:true})});showView('calculator')`);
  a.els.planAmount.value=amount;a.run('renderPlanner()');
}
function intent(a){return JSON.parse(a.run('JSON.stringify({from:plan.from,to:plan.to,via:plan.via,mode:plan.mode,fees:plan.fees,amount:$("planAmount").value})'));}
function fullPlan(a){return JSON.parse(a.run('JSON.stringify(plan)'));}

test('choosing EUR sell quote preserves reverse target, exact amount and directed fees',async()=>{
  const a=await app();goal(a);
  const before=intent(a),personal=a.writes[C.STORAGE_KEY];
  a.run('choosePlanOffice()');
  assert.equal(a.run('currentView'),'exchange');assert.equal(a.els.exchangeCurrency.value,'EUR');
  a.els.exchangeAmount.value='999';a.run('selectOffer("office:EUR:rico");useOfferForPlan()');
  assert.equal(a.run('currentView'),'calculator');assert.deepEqual(intent(a),before);
  assert.equal(a.els.planQuote0.value,'3,0600');
  // Want 123.45 EUR: (123.45*3.06)/0.9+6 = 425.73 GEL.
  assert.equal(a.els.planResult.textContent,'≈ 425,73 ₾');
  assert.equal(a.writes[C.STORAGE_KEY],personal);
});

test('choosing RUB direct sell quote preserves target and nominal-aware direction',async()=>{
  const a=await app();goal(a,{to:'RUB',via:'direct',amount:'10000',fees:{}});
  const before=intent(a);a.run('choosePlanOffice();selectOffer("office:RUB:rico");useOfferForPlan()');
  assert.deepEqual(intent(a),before);assert.equal(a.els.planQuote0.value,'3,3500');
  assert.equal(a.els.planResult.textContent,'≈ 335,00 ₾');
});

test('choosing a USD cash source preserves both-step target and the manually entered ruble quote',async()=>{
  const a=await app();goal(a,{from:'RUB',to:'GEL',via:'USD',amount:'261',fees:{}});
  a.run('plan.quotes.rubBuy="100,0000";renderPlanner()');const before=intent(a);
  a.run('choosePlanOffice();selectOffer("office:rico");useOfferForPlan()');
  assert.deepEqual(intent(a),before);assert.equal(a.run('plan.quotes.rubBuy'),'100,0000');
  // 261 GEL / 2.61 GEL per USD * 100 RUB per USD = 10000 RUB.
  assert.equal(a.els.planResult.textContent,'≈ 10\u00a0000,00 ₽');
});

test('compatible manual buy quote updates only the rate of a pending forward target',async()=>{
  const a=await app();a.run('changeExchangeCurrency("EUR");openExchangeManual()');
  a.els.exchangeManualValue.value='3,25';a.els.exchangeManualValue.events.input();await a.run('saveExchangeManual()');
  goal(a,{from:'EUR',to:'GEL',amount:'650',fees:{}});a.run('choosePlanOffice()');
  const before=intent(a),saved=JSON.stringify(a.writes);
  a.run('selectOffer("manual:EUR");useOfferForPlan()');
  assert.equal(a.run('currentView'),'calculator');assert.deepEqual(intent(a),before);
  assert.equal(a.els.planQuote0.value,'3,2500');assert.equal(a.els.planResult.textContent,'≈ 200,00 EUR');
  assert.equal(JSON.stringify(a.writes),saved);
});

test('mismatched currency cannot replace a pending planner goal',async()=>{
  const a=await app();goal(a);a.run('choosePlanOffice()');const before=fullPlan(a),original=intent(a);
  a.run('changeExchangeCurrency("USD");selectOffer("office:rico");useOfferForPlan()');
  assert.equal(a.run('currentView'),'exchange');assert.deepEqual(fullPlan(a),before);assert.deepEqual(intent(a),original);
  assert.equal(a.writes[C.STORAGE_KEY],undefined);
});

test('buy-only manual quote cannot satisfy pending reverse sell goal',async()=>{
  const a=await app();
  a.run('changeExchangeCurrency("EUR");openExchangeManual()');a.els.exchangeManualValue.value='3,25';a.els.exchangeManualValue.events.input();await a.run('saveExchangeManual()');
  goal(a);a.run('choosePlanOffice()');const before=fullPlan(a),original=intent(a),saved=JSON.stringify(a.writes);
  a.run('selectOffer("manual:EUR");useOfferForPlan()');
  assert.equal(a.run('currentView'),'exchange');assert.deepEqual(fullPlan(a),before);assert.deepEqual(intent(a),original);
  assert.equal(JSON.stringify(a.writes),saved);
});

test('leaving quote selection cancels its context; ordinary exchange still starts a new calculation',async()=>{
  const a=await app();goal(a);a.run('choosePlanOffice();showView("data");showView("exchange");changeExchangeCurrency("EUR")');
  a.els.exchangeAmount.value='200';a.run('selectOffer("office:EUR:rico");useOfferForPlan()');
  assert.equal(a.run('currentView'),'exchange');assert.equal(a.els.planReplacePanel.hidden,false);
  a.run('confirmOfferPlan()');
  assert.equal(a.run('currentView'),'calculator');assert.equal(a.els.planAmount.value,'200');
  assert.equal(a.run('plan.from'),'EUR');assert.equal(a.run('plan.to'),'GEL');assert.equal(a.run('plan.mode'),'give');
  assert.equal(a.els.planResult.textContent,'≈ 602,00 ₾');
});

test('return to insurance focuses visible comparison heading, or catalogue heading when browsing',async()=>{
  const a=await app(),focused=[];
  a.els.insuranceHeading.focus=()=>focused.push('catalogue');
  a.els.insuranceCompareHeading.focus=()=>focused.push('comparison');
  // Mimic the visible state set by insurance.js compare(), without claiming browser coverage.
  a.els.insuranceComparison.hidden=false;a.els.insuranceBrowseIntro.hidden=true;
  a.run('showView("exchange");showView("insurance")');assert.equal(focused.at(-1),'comparison');
  a.els.insuranceComparison.hidden=true;a.els.insuranceBrowseIntro.hidden=false;
  a.run('showView("exchange");showView("insurance")');assert.equal(focused.at(-1),'catalogue');
});

test('sell selector orders fresh offers by lowest sell and renders sell, not buy totals',async()=>{
  const a=await app();goal(a);a.run('choosePlanOffice()');
  const rows=a.els.offerList.children.filter(node=>node.dataset.offerKey);
  assert.equal(rows[0].dataset.offerKey,'office:EUR:rico');
  assert.equal(rows[0].children[0].children[1].textContent,'3,0600 ₾');
  assert.match(rows[0].children[1].textContent,/Продажа · за 1 EUR/);
  assert.equal(a.els.exchangeAmountGroup.hidden,true);assert.equal(a.els.exchangeSummary.hidden,true);
  assert.equal(a.els.returnToPlan.hidden,false);
});

test('hidden invalid exchange amount cannot block selecting a quote for a valid planner target',async()=>{
  const a=await app();goal(a);a.run('choosePlanOffice()');a.els.exchangeAmount.value='bad';
  a.run('selectOffer("office:EUR:rico")');assert.equal(a.els.planOfferButton.disabled,false);
  a.run('useOfferForPlan()');assert.equal(a.els.planResult.textContent,'≈ 425,73 ₾');
});

test('expired sell quote is rejected without changing the pending goal or source',async()=>{
  const a=await app();goal(a);a.run('choosePlanOffice();selectOffer("office:EUR:rico")');
  const before=fullPlan(a);a.advance(3*3600000);a.run('renderOffers()');
  assert.equal(a.els.planOfferButton.disabled,true);a.run('useOfferForPlan()');
  assert.equal(a.run('currentView'),'exchange');assert.deepEqual(fullPlan(a),before);
});

test('explicit return from selection keeps goal and restores ordinary exchange controls',async()=>{
  const a=await app();goal(a);const before=intent(a);
  a.run('choosePlanOffice();selectOffer("office:EUR:rico");showView("calculator")');
  assert.deepEqual(intent(a),before);a.run('showView("exchange")');
  assert.equal(a.els.returnToPlan.hidden,true);assert.equal(a.els.exchangeAmountGroup.hidden,false);
  assert.equal(a.els.exchangeSummary.hidden,false);assert.equal(a.els.planOfferButton.textContent,'Рассчитать эту сумму');
});

test('nested financial screens keep their calculator parent active without a fourth main tab',async()=>{
  const a=await app();
  for(const view of ['calculator','data','purchase','exchange','insurance']){
    a.run(`showView(${JSON.stringify(view)})`);
    const active=['exchangeNav','purchaseNav','insuranceNav'].filter(id=>a.els[id].attrs['aria-current']==='page');
    assert.deepEqual(active,[view==='exchange'?'exchangeNav':view==='insurance'?'insuranceNav':'purchaseNav']);
  }
});

test('insurance captures before hiding and a successful context return keeps its focus and scroll',async()=>{
  const a=await app();
  a.run('const contextCalls=[];window.GamarjiInsurance={captureContext(){contextCalls.push(["capture",$("insuranceView").hidden])},restoreContext(){contextCalls.push(["restore",$("insuranceView").hidden]);return true}};window.scrollTo=()=>contextCalls.push(["top"]);$("insuranceHeading").focus=()=>contextCalls.push(["heading"]);showView("insurance");contextCalls.length=0;showView("calculator");showView("insurance")');
  assert.equal(a.run('JSON.stringify(contextCalls)'),JSON.stringify([['capture',false],['top'],['restore',false]]));
});

test('reselecting active insurance cannot replay an older reading context',async()=>{
  const a=await app();
  a.run('showView("insurance");const repeatCalls=[];window.GamarjiInsurance={restoreContext(){repeatCalls.push("restore");return true}};window.scrollTo=()=>repeatCalls.push("scroll");showView("insurance")');
  assert.equal(a.run('JSON.stringify(repeatCalls)'),'[]');
});

test('sell selection cannot invite saving a buy-only personal rate',async()=>{
  const a=await app();goal(a);a.run('choosePlanOffice()');
  assert.ok(a.els.manualRateButton.hidden||a.els.manualRateButton.disabled,'Buy-only editor must not be offered for a sell-rate request');
});

test('USD quote selection hides legacy purchase-cost disclosure with its unrelated buy arithmetic',async()=>{
  const a=await app();goal(a,{to:'USD',amount:'100',fees:{}});a.run('choosePlanOffice()');
  assert.equal(a.els.legacyOfferDetails.hidden,true);
});
