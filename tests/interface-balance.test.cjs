// Interaction contracts in the existing unit DOM harness. Real browser/phone
// focus, keyboard, contrast and geometry require a separate verification pass.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const harnessSource=fs.readFileSync(path.join(__dirname,'app.test.cjs'),'utf8');
const boundary=harnessSource.indexOf('\nfunction inteliResponses(){');
assert.ok(boundary>0,'Review the shared harness boundary if its layout changes');
const preamble=harnessSource.slice(0,boundary);
assert.ok(!/^test\(/m.test(preamble),'Only helpers may be imported');
const {app,Element,cash,C}=new Function('require','__dirname',preamble+'\nreturn {app,Element,cash,C};')(require,__dirname);

const has=(element,name)=>element.classList.contains(name);
const saved=a=>JSON.stringify(a.writes);
function staleClasses(a){
  assert.equal(has(a.els.refreshOffersButton,'primary'),true,'An unconfirmed public quote needs a clear recovery action');
  assert.equal(has(a.els.refreshOffersButton,'text-button'),false);
  assert.equal(has(a.els.offerAddressButton,'secondary'),true,'Address browsing remains available but secondary');
  assert.equal(has(a.els.offerAddressButton,'primary'),false);
}
function ordinaryClasses(a){
  assert.equal(has(a.els.refreshOffersButton,'primary'),false);
  assert.equal(has(a.els.refreshOffersButton,'text-button'),true);
  assert.equal(has(a.els.offerAddressButton,'primary'),true);
  assert.equal(has(a.els.offerAddressButton,'secondary'),false);
}

test('expired public offers promote refresh without enabling application or losing addresses',async()=>{
  const a=await app();a.run('selectOffer("office:rico")');
  const before=saved(a),selected=a.run('selectedOffer');
  a.advance(3*3600000);a.run('renderOffers()');
  staleClasses(a);
  assert.equal(a.els.offerAddressButton.hidden,false);
  assert.equal(a.els.planOfferButton.hidden,true);
  assert.equal(a.els.applyOfferButton.disabled,true);
  assert.equal(a.run('selectedOffer'),selected);
  assert.equal(saved(a),before,'Changing visual priority must not save financial data');
});

test('freshness recovery restores the ordinary action hierarchy on the same offer',async()=>{
  const a=await app();a.run('selectOffer("office:rico")');
  const before=saved(a);a.advance(3*3600000);a.run('renderOffers()');staleClasses(a);
  a.run('offices.offers.forEach(row=>row.checkedAt=new Date(Date.now()).toISOString());offices.fetchedAt=new Date(Date.now()).toISOString();officeFailed=false;renderOffers()');
  ordinaryClasses(a);
  assert.equal(a.els.planOfferButton.hidden,false);
  assert.equal(a.els.planOfferButton.disabled,false);
  assert.equal(a.els.applyOfferButton.disabled,false);
  assert.equal(a.run('selectedOffer'),'office:rico');
  assert.equal(saved(a),before);
});

test('EUR and RUB stale-source actions preserve the selected currency and raw amount',async()=>{
  for(const currency of ['EUR','RUB']){
    const a=await app();a.run('changeExchangeCurrency('+JSON.stringify(currency)+');selectOffer("office:'+currency+':rico")');
    a.els.exchangeAmount.value='123,4567';const before=saved(a);
    a.advance(3*3600000);a.run('renderOffers()');staleClasses(a);
    assert.equal(a.els.exchangeAmount.value,'123,4567');
    assert.equal(a.els.exchangeCurrency.value,currency);
    assert.equal(a.run('selectedOffer'),'office:'+currency+':rico');
    assert.equal(a.els.planOfferButton.hidden,true);
    assert.equal(saved(a),before);
  }
});

test('a failed provider is unconfirmed even before TTL expiry and recovery remains disabled in flight',async()=>{
  const a=await app();a.run('selectOffer("office:rico");officeFailed=true;renderOffers()');
  const before=saved(a);staleClasses(a);
  assert.equal(a.els.refreshOffersButton.disabled,false);
  a.run('officeBusy=true;renderOffers()');
  staleClasses(a);assert.equal(a.els.refreshOffersButton.disabled,true);
  assert.equal(a.els.planOfferButton.hidden,true);
  a.run('officeBusy=false;renderOffers()');
  assert.equal(a.els.refreshOffersButton.disabled,false);
  assert.equal(saved(a),before);
});

test('a personal quote never becomes a public-source recovery action, including after ageing',async()=>{
  const a=await app();await cash(a,2.63);a.run('showView("exchange");selectOffer("manual")');
  const before=saved(a),record=a.writes[C.STORAGE_KEY];
  for(const age of [0,3*3600000]){
    a.advance(age);a.run('renderOffers()');
    ordinaryClasses(a);
    assert.equal(a.els.offerAddressButton.hidden,true);
    assert.equal(a.els.planOfferButton.hidden,false);
    assert.equal(a.els.planOfferButton.disabled,false);
    assert.equal(a.run('selectedOffer'),'manual');
  }
  assert.equal(a.writes[C.STORAGE_KEY],record);
  assert.equal(saved(a),before);
});

// Unlike the shared harness, model losing focus when a focused subtree is moved.
// This reproduces a browser risk, not the native keyboard itself. Descendant
// attachments below follow index.html; do not infer geometry from this model.
function focusHarness(a){
  const focusCalls=[],selectionCalls=[];
  for(const [id,node] of Object.entries(a.els)){
    node.contains=target=>{for(let current=target;current;current=current.parentElement)if(current===node)return true;return false;};
    node.focus=()=>{focusCalls.push(id);a.run('document.activeElement=$("'+id+'")');};
    node.setSelectionRange=(start,end,direction)=>{
      selectionCalls.push({id,start,end,direction});
      node.selectionStart=start;node.selectionEnd=end;node.selectionDirection=direction;
    };
  }
  a.els.offerToolsPanel.appendChild(a.els.cashRateHost);
  a.els.cashRateHost.appendChild(a.els.exchangeManualPanel);
  a.els.exchangeManualPanel.appendChild(a.els.exchangeManualValue);
  a.els.ratePanel.appendChild(a.els.rateValue);
  a.els.ratePanel.appendChild(a.els.saveRateButton);
  a.els.offerToolsPanel.appendChild(a.els.manualRateButton);
  a.els.offerToolsPanel.appendChild(a.els.refreshOffersButton);
  function withMovingFocusLoss(action){
    const original=Element.prototype.appendChild;
    Element.prototype.appendChild=function(node){
      let current=a.run('document.activeElement');
      while(current){
        if(current===node&&node.parentElement){a.run('document.activeElement=null');break;}
        current=current.parentElement;
      }
      return original.call(this,node);
    };
    try{return action();}finally{Element.prototype.appendChild=original;}
  }
  return {focusCalls,selectionCalls,withMovingFocusLoss};
}

for(const currency of ['USD','EUR','RUB'])test('background rendering preserves open '+currency+' manual input, focus and caret without saving',async()=>{
  const a=await app(),model=focusHarness(a);
  a.run('changeExchangeCurrency('+JSON.stringify(currency)+');openExchangeManual()');
  const input=currency==='USD'?a.els.rateValue:a.els.exchangeManualValue;
  input.value='3,14159';input.selectionStart=2;input.selectionEnd=5;input.selectionDirection='backward';
  input.focus();const before=saved(a);
  model.withMovingFocusLoss(()=>a.run('renderOffers()'));
  assert.equal(a.run('document.activeElement?.id'),input.id,'The open editor must retain keyboard focus');
  assert.equal(input.value,'3,14159');
  assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);assert.equal(input.selectionDirection,'backward');
  assert.ok(model.selectionCalls.some(call=>call.id===input.id&&call.start===2&&call.end===5),'Restore selection deliberately after DOM movement');
  assert.equal(saved(a),before);
});

test('background rendering preserves the visible manual-rate control without opening an editor or saving',async()=>{
  const a=await app(),model=focusHarness(a);a.run('showView("exchange")');
  a.els.manualRateButton.focus();const before=saved(a);
  model.withMovingFocusLoss(()=>a.run('renderOffers()'));
  assert.equal(a.run('document.activeElement?.id'),'manualRateButton');
  assert.equal(a.run('editingExchangeRate()'),false);
  assert.equal(saved(a),before);
});

test('background rendering preserves the focused submit control inside an open manual editor',async()=>{
  const a=await app(),model=focusHarness(a);a.run('showView("exchange");openExchangeManual()');
  a.els.rateValue.value='2,6';a.els.saveRateButton.focus();const before=saved(a);
  model.withMovingFocusLoss(()=>a.run('renderOffers()'));
  assert.equal(a.run('document.activeElement?.id'),'saveRateButton','Keyboard users must not lose the Save action while quotes refresh');
  assert.equal(a.els.rateValue.value,'2,6');
  assert.equal(saved(a),before);
});

test('an open EUR editor retains an anonymous action button without requiring new DOM IDs',async()=>{
  const a=await app(),model=focusHarness(a);a.run('changeExchangeCurrency("EUR");openExchangeManual()');
  const button=new Element();button.dataset.balanceAnonymous=true;
  a.els.exchangeManualPanel.appendChild(button);
  button.focus=()=>a.run('document.activeElement=$("exchangeManualPanel").children.find(node=>node.dataset.balanceAnonymous)');
  button.focus();const before=saved(a);
  model.withMovingFocusLoss(()=>a.run('renderOffers()'));
  assert.equal(a.run('document.activeElement?.dataset.balanceAnonymous'),true);
  assert.equal(saved(a),before);
});

test('a visible enabled refresh control retains focus when promoted for an unconfirmed source',async()=>{
  const a=await app(),model=focusHarness(a);a.run('selectOffer("office:rico");officeFailed=true;renderOffers()');
  a.els.refreshOffersButton.focus();const before=saved(a);
  model.withMovingFocusLoss(()=>a.run('renderOffers()'));
  staleClasses(a);assert.equal(a.els.refreshOffersButton.disabled,false);
  assert.equal(a.run('document.activeElement?.id'),'refreshOffersButton');
  assert.equal(saved(a),before);
});

test('background rendering never pulls focus from an unrelated visible amount field',async()=>{
  const a=await app(),model=focusHarness(a);a.run('changeExchangeCurrency("EUR");openExchangeManual()');
  a.els.exchangeManualValue.value='3,';a.els.exchangeAmount.focus();
  const before=saved(a),calls=model.focusCalls.length;
  model.withMovingFocusLoss(()=>a.run('renderOffers()'));
  assert.equal(a.run('document.activeElement?.id'),'exchangeAmount');
  assert.ok(!model.focusCalls.slice(calls).includes('exchangeManualValue'),'An open editor alone is not permission to steal focus');
  assert.equal(a.els.exchangeManualValue.value,'3,');
  assert.equal(saved(a),before);
});

test('background rates cannot return focus to an editor after navigation to another section',async()=>{
  const a=await app(),model=focusHarness(a);a.run('changeExchangeCurrency("EUR");openExchangeManual()');
  a.els.exchangeManualValue.value='3,';a.run('showView("insurance")');
  a.els.insuranceHeading.focus();const before=saved(a),calls=model.focusCalls.length;
  model.withMovingFocusLoss(()=>a.run('renderOffers()'));
  assert.equal(a.run('document.activeElement?.id'),'insuranceHeading');
  assert.ok(!model.focusCalls.slice(calls).includes('exchangeManualValue'));
  assert.equal(a.els.exchangeManualValue.value,'3,');
  assert.equal(saved(a),before);
});

test('localized Batumi addresses preserve routing and clear the Latin caption on city, bank and close transitions',async()=>{
  const stamp=new Date().toISOString();
  const a=await app({},false,{city:'batumi',responses:{'./exchange-rates.json':{
    schemaVersion:2,currency:'USD',unit:'GEL per USD',nominal:1,channel:'Cash',side:'buy',fetchedAt:stamp,
    offers:[
      {id:'rico',buy:2.61,sell:2.615,nominal:1,sourceNominal:1,checkedAt:stamp,sourceUpdatedAt:null},
      {id:'inteli',buy:2.609,sell:2.614,nominal:1,sourceNominal:1,checkedAt:stamp,sourceUpdatedAt:null}
    ],failures:['mjc']
  }}});
  const before=saved(a);
  const assertLatin=original=>{
    assert.equal(a.els.branchAddressLatin.hidden,false);
    assert.equal(a.els.branchAddressLatin.textContent,'Адрес латиницей: '+original);
  };
  const assertNoLatin=()=>{
    assert.equal(a.els.branchAddressLatin.hidden,true);
    assert.equal(a.els.branchAddressLatin.textContent,'','Never retain another branch caption in a hidden field');
  };
  const assertPoint=(lat,lon)=>{
    const map=new URL(a.els.openDeviceMap.href),taxi=new URL(a.els.openYandexGo.href);
    assert.equal(map.searchParams.get('query'),lat+','+lon);
    assert.equal(taxi.searchParams.get('end-lat'),String(lat));
    assert.equal(taxi.searchParams.get('end-lon'),String(lon));
    assert.equal(taxi.searchParams.has('start-lat'),false);assert.equal(taxi.searchParams.has('start-lon'),false);
  };
  a.run('selectOffer("office:rico");toggleOfferLocation()');
  assert.equal(a.els.branchAddress.textContent,'Батуми, ул. И. Чавчавадзе, 25');
  assertLatin('25 Ilia Chavchavadze Street');assertPoint(41.645256,41.6385689);
  const firstLinks=[a.els.openDeviceMap.href,a.els.openYandexGo.href];
  a.run('renderOffers()');assert.deepEqual([a.els.openDeviceMap.href,a.els.openYandexGo.href],firstLinks);
  assert.equal(a.els.branchChoice.children[0].text,'Батуми, ул. И. Чавчавадзе, 25');

  a.els.branchChoice.value='rico:batumi:1';a.run('selectBranch()');
  assert.equal(a.els.branchAddress.textContent,'Батуми, ул. Бараташвили, 18');
  assertLatin('18 Baratashvili Street');
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'18 Baratashvili Street, Batumi, Georgia','Unconfirmed point must retain its existing English address search');
  assert.equal(a.els.openYandexGo.hidden,true);assert.equal(a.els.openYandexGo.href,'');

  a.run('selectOffer("office:inteli");toggleOfferLocation()');
  assert.equal(a.els.branchAddress.textContent,'Батуми, ул. Бараташвили, 25');
  assertLatin('25 Baratashvili Street');
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'41.6492744,41.6374353');
  assert.equal(a.els.openYandexGo.hidden,true);assert.equal(a.els.openYandexGo.href,'');
  assert.match(a.els.branchTaxiHint.textContent,/Адрес в Яндекс Go не совпал/);
  a.els.exchangeCity.value='kobuleti';a.els.exchangeCity.events.change();assertNoLatin();
  a.run('selectOffer("office:rico");toggleOfferLocation()');
  assert.equal(a.els.branchAddress.textContent,'Кобулети, 3 Rustaveli Street');assertNoLatin();
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'3 Rustaveli Street, Kobuleti, Georgia');

  a.els.exchangeCity.value='batumi';a.els.exchangeCity.events.change();
  a.run('selectOffer("office:inteli");toggleOfferLocation()');assertLatin('25 Baratashvili Street');
  a.run('selectOffer("bank:3");toggleOfferLocation()');assertNoLatin();
  assert.equal(a.els.branchAddress.hidden,true);
  assert.equal(new URL(a.els.openDeviceMap.href).searchParams.get('query'),'C bank branches, Batumi, Georgia');
  assert.equal(a.els.openYandexGo.hidden,true);
  a.run('selectOffer("office:inteli");toggleOfferLocation()');assertLatin('25 Baratashvili Street');
  a.run('closeOfferLocation()');assertNoLatin();
  assert.equal(a.els.offerLocationPanel.hidden,true);
  assert.equal(a.els.openDeviceMap.href,'');assert.equal(a.els.openYandexGo.href,'');
  assert.equal(saved(a),before);
});
