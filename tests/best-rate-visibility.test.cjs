// Public-rate badge regressions. These deterministic fixtures are not live quotes
// and this DOM model cannot prove whether a badge is above a phone's fold.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const harnessSource=fs.readFileSync(path.join(__dirname,'app.test.cjs'),'utf8');
const boundary=harnessSource.indexOf('\nfunction inteliResponses(){');
assert.ok(boundary>0,'Review the shared harness boundary if app.test.cjs changes');
const preamble=harnessSource.slice(0,boundary);
assert.ok(!/^test\(/m.test(preamble));
const {app,C,cash,Element}=new Function('require','__dirname',preamble+'\nreturn {app,C,cash,Element};')(require,__dirname);
const walk=n=>[n,...n.children.flatMap(walk)];
const shown=a=>a.els.offerList.children.filter(n=>n.dataset.offerKey);
const badges=a=>shown(a).filter(n=>walk(n).some(child=>String(child.className||'').split(/\s+/).includes('offer-best'))).map(n=>n.dataset.offerKey);
const personal=a=>a.writes[C.STORAGE_KEY];
function selector(a,currency='USD',side='buy'){
  const from=side==='buy'?currency:'GEL',to=side==='buy'?'GEL':currency;
  a.run(`Object.assign(plan,{from:${JSON.stringify(from)},to:${JSON.stringify(to)},via:${JSON.stringify(currency==='RUB'?'direct':'USD')},mode:'give',quotes:{},fees:{},initialized:true});showView('calculator')`);
  a.els.planAmount.value='100';a.run('renderPlanner();choosePlanOffice()');
}

test('ordinary exchange preserves a higher selected personal quote while identifying the public best',async()=>{
  const a=await app();await cash(a,3);const saved=personal(a);a.run('renderOffers()');
  assert.equal(shown(a)[0].dataset.offerKey,'manual');
  assert.ok(!badges(a).includes('manual'));assert.ok(badges(a).includes('bank:3'));
  assert.equal(a.els.exchangeReceive.textContent,'≈ 300,00 ₾');assert.equal(personal(a),saved);
});

test('buy-rate selection retains a badge on the highest fresh public buy quote',async()=>{
  const a=await app();selector(a);const saved=personal(a);
  assert.deepEqual(badges(a),['bank:3']);
  assert.equal(shown(a)[0].dataset.offerKey,'bank:3');
  assert.equal(personal(a),saved);
});

test('sell-rate selection labels the lowest sell quote, not the highest buy quote',async()=>{
  const a=await app();selector(a,'USD','sell');
  assert.equal(shown(a)[0].dataset.offerKey,'office:rico');
  assert.deepEqual(badges(a),['office:rico']);
  assert.ok(!badges(a).includes('bank:3'));
});

test('EUR and RUB badges follow direction without confusing nominal-one and nominal-hundred rates',async()=>{
  for(const [currency,side,key] of [['EUR','buy','office:EUR:mjc'],['EUR','sell','office:EUR:rico'],['RUB','buy','office:RUB:mjc'],['RUB','sell','office:RUB:rico']]){
    const a=await app();selector(a,currency,side);
    assert.deepEqual(badges(a),[key],currency+' '+side);
    const first=shown(a)[0];assert.equal(first.dataset.offerKey,key);
    if(currency==='RUB')assert.match(first.children[0].children[1].textContent,side==='buy'?/3,3000/:/3,3500/);
  }
});

test('equally best public sell quotes receive equal badges, without breaking the selected source',async()=>{
  const a=await app();a.responses['./exchange-rates.json'].offers[0].sell=2.615;await a.run('refreshOffices()');
  selector(a,'USD','sell');a.run('selectOffer("office:mjc")');const selected=a.run('selectedOffer'),saved=personal(a);
  assert.deepEqual(new Set(badges(a)),new Set(['office:mjc','office:rico']));
  a.run('renderOffers()');assert.equal(a.run('selectedOffer'),selected);assert.equal(personal(a),saved);
});

test('a fresh public source remains best even if an unverified manual quote is numerically higher',async()=>{
  const a=await app();await cash(a,3);selector(a,'USD','buy');
  assert.ok(!badges(a).includes('manual'));assert.ok(badges(a).includes('bank:3'));
  assert.equal(a.state().cashGelRate,3);
});

test('failed providers and stale sources are excluded from directional badges',async()=>{
  const a=await app();a.responses['./exchange-rates.json'].failures=['rico'];await a.run('refreshOffices()');
  selector(a,'USD','sell');assert.deepEqual(badges(a),['office:mjc']);
  a.advance(3*3600000);a.run('renderOffers()');assert.deepEqual(badges(a),[]);
  assert.equal(a.els.bestOfferHelp.hidden,true);
});

test('no fresh public sources means no invented best, even with a usable manual quote',async()=>{
  for(const side of ['buy','sell']){
    const a=await app();a.advance(3*3600000);await cash(a,3);selector(a,'USD',side);
    assert.deepEqual(badges(a),[]);assert.equal(a.els.bestOfferHelp.hidden,true);
    assert.equal(a.state().cashGelRate,3);
  }
});

test('city filtering excludes another city office from the badge without pretending banks are city-specific',async()=>{
  const a=await app({},false,{city:'batumi'});selector(a,'USD','sell');
  assert.ok(!shown(a).some(n=>n.dataset.offerKey==='office:mjc'));
  assert.deepEqual(badges(a),['office:rico']);
  const bank=shown(a).find(n=>n.dataset.offerKey?.startsWith('bank:'));
  if(bank)assert.match(walk(bank).map(n=>n.textContent).join(' '),/город уточните/);
});

test('best-source jump focuses and scrolls the row without choosing its quote or overwriting personal data',async()=>{
  const a=await app();await cash(a,3);const saved=personal(a),selected=a.run('selectedOffer'),plan=a.run('JSON.stringify(plan)'),amount=a.els.exchangeAmount.value;
  assert.equal(a.els.bestOfferJump.hidden,false);assert.equal(a.els.bestOfferScope.hidden,false);
  assert.match(a.els.bestOfferScope.textContent,/Банки и обменники/);assert.match(a.els.bestOfferScope.textContent,/до комиссий/);
  const focused=[],scrolled=[],oldFocus=Element.prototype.focus,oldScroll=Element.prototype.scrollIntoView;
  Element.prototype.focus=function(options){focused.push({key:this.dataset.offerKey,options});};
  Element.prototype.scrollIntoView=function(options){scrolled.push({key:this.dataset.offerKey,options});};
  try{a.run('focusBestOffer()');}finally{Element.prototype.focus=oldFocus;if(oldScroll)Element.prototype.scrollIntoView=oldScroll;else delete Element.prototype.scrollIntoView;}
  assert.equal(focused.at(-1).key,'bank:3');assert.equal(scrolled.at(-1).key,'bank:3');
  assert.equal(a.run('selectedOffer'),selected);assert.equal(a.run('JSON.stringify(plan)'),plan);
  assert.equal(a.els.exchangeAmount.value,amount);assert.equal(a.els.exchangeReceive.textContent,'≈ 300,00 ₾');assert.equal(personal(a),saved);
});

test('best-source jump is absent for a selected best, a directed selector or stale public rates',async()=>{
  const a=await app();a.run('selectOffer("bank:3")');assert.equal(a.els.bestOfferJump.hidden,true);
  selector(a,'USD','sell');assert.equal(a.els.bestOfferJump.hidden,true);
  a.run('showView("exchange")');a.advance(3*3600000);a.run('renderOffers()');
  assert.equal(a.els.bestOfferJump.hidden,true);assert.equal(a.els.bestOfferScope.hidden,true);
});

test('a best-source jump recalculates eligibility if the old best expired before the click',async()=>{
  const a=await app();await cash(a,3);const saved=personal(a),selected=a.run('selectedOffer');
  assert.equal(a.els.bestOfferJump.hidden,false);a.advance(3*3600000);
  const focused=[],oldFocus=Element.prototype.focus;
  Element.prototype.focus=function(){focused.push(this.dataset.offerKey);};
  try{a.run('focusBestOffer()');}finally{Element.prototype.focus=oldFocus;}
  assert.equal(a.els.bestOfferJump.hidden,true);assert.equal(a.els.bestOfferScope.hidden,true);
  assert.ok(!focused.some(Boolean),'An expired public quote must not remain the jump target');
  assert.equal(a.run('selectedOffer'),selected);assert.equal(personal(a),saved);
});

test('RUB best-source explanation never claims an unavailable bank comparison',async()=>{
  const a=await app();a.run('changeExchangeCurrency("RUB");selectOffer("office:RUB:rico")');
  assert.equal(a.els.bestOfferJump.hidden,false);assert.equal(a.els.bestOfferScope.hidden,false);
  assert.match(a.els.bestOfferScope.textContent,/Обменники/);assert.doesNotMatch(a.els.bestOfferScope.textContent,/банки|банков/i);
  assert.doesNotMatch(a.els.bestOfferHelp.textContent,/банков/i);
});

test('expiry during the jump returns focus to the exchange heading instead of a hidden control',async()=>{
  const a=await app();await cash(a,3);a.advance(3*3600000);
  const focused=[],oldFocus=Element.prototype.focus;
  Element.prototype.focus=function(){focused.push(this.id);};
  try{a.run('focusBestOffer()');}finally{Element.prototype.focus=oldFocus;}
  assert.equal(focused.at(-1),'exchangeHeading');
});

test('selecting any equally best public rate hides the unnecessary best-source jump',async()=>{
  const a=await app();Object.assign(a.responses['./exchange-rates.json'].offers[0],{buy:2.62,sell:2.63});await a.run('refreshOffices()');
  a.run('selectOffer("office:mjc")');assert.ok(badges(a).includes('office:mjc'));
  assert.equal(a.els.bestOfferJump.hidden,true);assert.equal(a.els.bestOfferScope.hidden,true);
});

test('direction copy uses the customer perspective and preserves RUB nominal',async()=>{
  for(const [currency,side,copy] of [['USD','buy','Получаете за 1 USD'],['USD','sell','Платите за 1 USD'],['RUB','buy','Получаете за 100 ₽'],['RUB','sell','Платите за 100 ₽']]){
    const a=await app();selector(a,currency,side);
    assert.ok(shown(a).every(row=>row.children.at(-1).textContent.includes(copy)),currency+' '+side);
  }
});
