// Explicit close-button focus contracts. Geometry is modelled here; the real
// browser Enter/Tab scenario must also be repeated on the final build.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const harnessSource=fs.readFileSync(path.join(__dirname,'app.test.cjs'),'utf8');
const boundary=harnessSource.indexOf('\nfunction inteliResponses(){');
assert.ok(boundary>0);
const preamble=harnessSource.slice(0,boundary);
assert.ok(!/^test\(/m.test(preamble));
const {app,Element,C}=new Function('require','__dirname',preamble+'\nreturn {app,Element,C};')(require,__dirname);
const panelIds=new Set(['settingsPanel','purchasePanel','ratePanel','exchangeManualPanel']);

function focusModel(a){
  const focused=[];
  function enhance(id){
    const node=a.els[id]||(a.els[id]=new Element());node.id=id;node.isConnected=true;node.tagName='BUTTON';
    node.contains=target=>{for(let n=target;n;n=n.parentElement)if(n===node)return true;return false;};
    node.getClientRects=()=>{
      for(let n=node;n;n=n.parentElement)if(n.hidden||n.isConnected===false||panelIds.has(n.id)&&!n.classList.contains('show'))return [];
      return [{}];
    };
    node.focus=()=>{focused.push(node);a.run('document.activeElement=$('+JSON.stringify(id)+')');};
    return node;
  }
  for(const id of Object.keys(a.els))enhance(id);
  a.els.insuranceComparison.hidden=true; // Static HTML visibility is not parsed by the shared harness.
  for(const view of ['data','purchase','calculator','exchange','insurance','services'])a.els[view+'View'].appendChild(a.els[view+'Heading']);
  a.els.dataView.appendChild(a.els.settingsPanel);
  a.els.dataView.appendChild(a.els.purchaseDataHost);
  a.els.purchaseView.appendChild(a.els.rublesEditorHost);
  a.els.exchangeView.appendChild(a.els.cashRateHost);
  a.els.cashRateHost.appendChild(a.els.exchangeManualPanel);
  a.els.exchangeManualPanel.appendChild(a.els.exchangeManualValue);
  a.els.settingsPanel.appendChild(a.els.feePct);
  a.els.purchasePanel.appendChild(a.els.purchaseRub);
  a.els.purchasePanel.appendChild(a.els.purchaseQty);
  function control(id,parent){const node=enhance(id);a.els[parent].appendChild(node);return node;}
  function closeButton(panel){return control('close'+panel,panel);}
  return {focused,control,closeButton};
}

test('explicit settings dismissal returns to its opener and retains the unsaved draft',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('settingsToggle','dataView');
  a.run('showView("data")');opener.focus();a.run('openSettings()');
  assert.equal(opener.attrs['aria-expanded'],'true');
  a.els.feePct.value='1,5';a.els.cashbackPct.value='0,25';
  const before=JSON.stringify(a.writes);m.closeButton('settingsPanel').focus();
  a.run('dismissInline("settingsPanel")');
  assert.equal(m.focused.at(-1),opener);assert.equal(opener.attrs['aria-expanded'],'false');
  assert.equal(a.els.settingsPanel.classList.contains('show'),false);
  assert.equal(JSON.stringify(a.writes),before);
  a.run('openSettings()');assert.equal(a.els.feePct.value,'1,5');assert.equal(a.els.cashbackPct.value,'0,25');
});

for(const currency of ['USD','EUR','RUB'])test(currency+' manual close restores the same live source control without saving its draft',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('manualRateButton','exchangeView');
  a.run('changeExchangeCurrency('+JSON.stringify(currency)+');showView("exchange")');
  opener.focus();a.run('openExchangeManual()');
  const id=currency==='USD'?'ratePanel':'exchangeManualPanel',field=currency==='USD'?'rateValue':'exchangeManualValue';
  a.els[field].value='3,';const before=JSON.stringify(a.writes);
  m.closeButton(id).focus();a.run('dismissInline('+JSON.stringify(id)+')');
  assert.equal(m.focused.at(-1),opener);assert.equal(JSON.stringify(a.writes),before);
  assert.equal(a.els[id].classList.contains('show'),false);
  a.run('openExchangeManual()');assert.equal(a.els[field].value,'3,');
});

test('purchase close records the newest actual opener, including controls without DOM IDs',async()=>{
  const a=await app(),m=focusModel(a),first=m.control('firstPurchaseTrigger','dataView'),second=m.control('secondPurchaseTrigger','dataView');
  // The harness lookup key is not a DOM ID; production restoration keeps the node.
  first.id='';second.id='';
  a.run('showView("data")');first.focus();a.run('openPurchase("usd")');
  a.els.purchaseRub.value='9000';a.els.purchaseQty.value='100';
  m.closeButton('purchasePanel').focus();a.run('dismissInline("purchasePanel")');assert.equal(m.focused.at(-1),first);
  second.focus();a.run('openPurchase("usdt")');m.closeButton('purchasePanel').focus();
  a.run('dismissInline("purchasePanel")');assert.equal(m.focused.at(-1),second);
  assert.equal(a.writes[C.STORAGE_KEY],undefined);
  first.focus();a.run('openPurchase("usd")');assert.equal(a.els.purchaseRub.value,'9000');assert.equal(a.els.purchaseQty.value,'100');
});

for(const unavailable of ['hidden','detached','disabled','no-layout'])test('a '+unavailable+' opener is never focused by explicit close',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('settingsToggle','dataView');
  a.run('showView("data")');opener.focus();a.run('openSettings()');
  if(unavailable==='hidden')opener.hidden=true;
  if(unavailable==='detached')opener.isConnected=false;
  if(unavailable==='disabled')opener.disabled=true;
  if(unavailable==='no-layout')opener.getClientRects=()=>[];
  m.closeButton('settingsPanel').focus();const count=m.focused.length;
  a.run('dismissInline("settingsPanel")');
  assert.ok(!m.focused.slice(count).includes(opener));assert.equal(m.focused.at(-1),a.els.dataHeading);
});

test('a source hidden by an intentional view transition cannot receive rate-editor focus',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('oldDataRateTrigger','dataView');
  a.run('showView("data")');opener.focus();a.run('openRate("bybit")');
  assert.equal(a.run('currentView'),'purchase');
  m.closeButton('ratePanel').focus();const count=m.focused.length;a.run('dismissInline("ratePanel")');
  assert.ok(!m.focused.slice(count).includes(opener));assert.equal(m.focused.at(-1),a.els.purchaseHeading);
});

test('explicit close never pulls focus back after the user has changed sections',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('settingsToggle','dataView');
  a.run('showView("data")');opener.focus();a.run('openSettings();showView("insurance")');
  const count=m.focused.length;a.run('dismissInline("settingsPanel")');
  assert.equal(m.focused.length,count);assert.equal(m.focused.at(-1),a.els.insuranceHeading);
});

test('internal closes, editor switching and repeated dismissals never restore old focus',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('settingsToggle','dataView'),next=m.control('purchaseTrigger','dataView');
  a.run('showView("data")');opener.focus();a.run('openSettings()');
  next.focus();const count=m.focused.length;
  a.run('openPurchase("usd")');assert.equal(m.focused.length,count,'closeAllInline is not an explicit dismissal');
  a.run('closeInline("purchasePanel");dismissInline("purchasePanel")');
  assert.equal(m.focused.length,count,'A no-longer-open panel cannot restore a stale initiator');
});

test('saving a purchase keeps its normal completion behavior instead of restoring the opener',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('purchaseTrigger','dataView');
  a.run('showView("data")');opener.focus();a.run('openPurchase("usd")');
  a.els.purchaseRub.value='9000';a.els.purchaseQty.value='100';m.closeButton('purchasePanel').focus();const count=m.focused.length;
  await a.run('savePurchase()');
  assert.ok(!m.focused.slice(count).includes(opener));assert.equal(a.state().usdPurchases.length,1);
});

const pendingFocus=a=>[...a.timers.values()].filter(timer=>timer.ms===50);

test('deferred editor focus still works when the user has not moved on',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('purchaseTrigger','dataView');let scrolls=0;
  a.els.purchasePanel.scrollIntoView=()=>scrolls++;
  a.run('showView("data")');opener.focus();a.run('openPurchase("usd")');
  pendingFocus(a).at(-1).fn();
  assert.equal(m.focused.at(-1),a.els.purchaseRub);assert.equal(scrolls,1);
});

test('deferred purchase autofocus cannot override a newer focus on the quantity field',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('purchaseTrigger','dataView');let scrolls=0;
  a.els.purchasePanel.scrollIntoView=()=>scrolls++;
  a.run('showView("data")');opener.focus();a.run('openPurchase("usd")');
  a.els.purchaseRub.value='10000';a.els.purchaseQty.value='100';a.els.purchaseQty.focus();
  const count=m.focused.length,before=JSON.stringify(a.writes);pendingFocus(a).at(-1).fn();
  assert.equal(m.focused.length,count);assert.equal(m.focused.at(-1),a.els.purchaseQty);assert.equal(scrolls,0);
  assert.equal(a.els.purchaseRub.value,'10000');assert.equal(a.els.purchaseQty.value,'100');assert.equal(JSON.stringify(a.writes),before);
});

test('quick reopening invalidates the previous autofocus even when the active opener is the same',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('purchaseTrigger','dataView');let scrolls=0;
  a.els.purchasePanel.scrollIntoView=()=>scrolls++;
  a.run('showView("data")');opener.focus();a.run('openPurchase("usd")');
  const previous=pendingFocus(a).at(-1);
  a.run('closeInline("purchasePanel");openPurchase("usdt")');const latest=pendingFocus(a).at(-1),count=m.focused.length;
  previous.fn();assert.equal(m.focused.length,count);assert.equal(scrolls,0,'The old callback cannot move the replacement editor');
  latest.fn();assert.equal(m.focused.at(-1),a.els.purchaseRub);assert.equal(m.focused.length,count+1);assert.equal(scrolls,1);
  assert.equal(a.run('purchaseKind'),'usdt');assert.equal(a.state().usdPurchases.length,0);assert.equal(a.state().usdtPurchases.length,0);
});

for(const state of ['closed','hidden-input','other-section'])test('deferred editor focus ignores a '+state+' target',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('purchaseTrigger','dataView');let scrolls=0;
  a.els.purchasePanel.scrollIntoView=()=>scrolls++;
  a.run('showView("data")');opener.focus();a.run('openPurchase("usd")');const pending=pendingFocus(a).at(-1);
  if(state==='closed')a.run('closeInline("purchasePanel")');
  if(state==='hidden-input')a.els.purchaseRub.hidden=true;
  if(state==='other-section')a.run('showView("services")');
  const count=m.focused.length;pending.fn();assert.equal(m.focused.length,count);assert.equal(scrolls,0);
});

test('a fast valid submit is saved once and cannot be reopened or refocused by its pending timer',async()=>{
  const a=await app(),m=focusModel(a),opener=m.control('purchaseTrigger','dataView');let scrolls=0;
  a.els.purchasePanel.scrollIntoView=()=>scrolls++;
  a.run('showView("data")');opener.focus();a.run('openPurchase("usd")');
  a.els.purchaseRub.value='10000';a.els.purchaseQty.value='100';const pending=pendingFocus(a).at(-1),count=m.focused.length;
  const saving=a.run('savePurchase()');assert.equal(a.els.purchasePanel.classList.contains('show'),false);
  pending.fn();await saving;
  assert.equal(m.focused.length,count);assert.equal(scrolls,0);assert.equal(a.state().usdPurchases.length,1);
  assert.equal(a.state().usdPurchases[0].rub,10000);assert.equal(a.run('purchaseDrafts.usd'),undefined);
});
