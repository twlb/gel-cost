// Preference/DOM contracts only; contrast and real browser interaction need separate QA.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'theme.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const C=require('../core.js');
const preference='gamarji.theme';

test('dark primary styling applies only to enabled buttons so disabled labels remain readable',()=>{
  const css=fs.readFileSync(path.join(root,'theme.css'),'utf8');
  assert.match(css,/\[data-theme="dark"\]\s+\.primary:not\(:disabled\)/);
  assert.doesNotMatch(css,/\[data-theme="dark"\]\s+\.primary\s*\{/);
  assert.match(css,/button:disabled\s*\{[^}]*color:\s*var\(--muted\)/);
});

function theme(saved={},options={}){
  const store={...saved},reads=[],writes=[],events={};
  const documentElement={dataset:{}};
  const meta=options.noMeta?null:{content:'initial'};
  const button={textContent:'',attrs:{},events:{},
    setAttribute(name,value){this.attrs[name]=value;},
    addEventListener(name,callback){this.events[name]=callback;}};
  const icon={attrs:{},setAttribute(name,value){this.attrs[name]=value;}};
  let ready=false;
  const document={documentElement,
    querySelector(selector){assert.equal(selector,'meta[name="theme-color"]');return meta;},
    getElementById(id){assert.ok(['themeToggle','themeIcon'].includes(id));return ready&&!options.noButton?(id==='themeToggle'?button:icon):null;},
    addEventListener(name,callback){events[name]=callback;}};
  const localStorage={
    getItem(key){reads.push(key);if(options.getBlocked)throw Error('Storage unavailable');return store[key]??null;},
    setItem(key,value){writes.push([key,value]);if(options.setBlocked)throw Error('Storage unavailable');store[key]=value;}
  };
  vm.runInNewContext(source,{document,localStorage});
  return {store,reads,writes,documentElement,meta,button,icon,
    ready(){ready=true;assert.equal(typeof events.DOMContentLoaded,'function');events.DOMContentLoaded();},
    click(){assert.equal(typeof button.events.click,'function');button.events.click();}};
}

function assertAppearance(a,value){
  assert.equal(a.documentElement.dataset.theme,value);
  if(a.meta)assert.equal(a.meta.content,value==='dark'?'#11151b':'#faf9f6');
  assert.equal(a.button.textContent,'','Theme changes must not erase the icon DOM');
  assert.equal(a.icon.attrs.src,'brand/icons/weather/'+(value==='dark'?'sun':'moon')+'.svg');
  assert.equal(a.button.attrs['aria-label'],value==='dark'?'Включить светлую тему':'Включить тёмную тему');
  assert.equal(a.button.attrs.title,a.button.attrs['aria-label']);
}

test('theme starts light before body parsing and initializes its button on DOMContentLoaded',()=>{
  const a=theme();
  assert.equal(a.documentElement.dataset.theme,'light');
  assert.equal(a.meta.content,'#faf9f6');
  assert.equal(a.button.events.click,undefined,'The head script must not require a parsed button');
  assert.deepEqual(a.writes,[],'Default appearance must not create preferences');
  a.ready();assertAppearance(a,'light');
});

test('saved dark theme is applied before DOMContentLoaded and retained afterward',()=>{
  const a=theme({[preference]:'dark'});
  assert.equal(a.documentElement.dataset.theme,'dark');
  assert.equal(a.meta.content,'#11151b');
  a.ready();assertAppearance(a,'dark');
  assert.deepEqual(a.reads,[preference]);assert.deepEqual(a.writes,[]);
});

test('invalid theme preferences fall back to light without rewriting storage',()=>{
  for(const value of ['','LIGHT','dark ','system','null','<script>']){
    const a=theme({[preference]:value});a.ready();assertAppearance(a,'light');
    assert.equal(a.store[preference],value);assert.deepEqual(a.writes,[]);
  }
});

test('blocked preference reads preserve usable default appearance and toggle',()=>{
  const a=theme({[preference]:'dark'},{getBlocked:true});a.ready();assertAppearance(a,'light');
  a.click();assertAppearance(a,'dark');assert.equal(a.store[preference],'dark');
});

test('blocked preference writes still switch appearance and accessible action labels',()=>{
  const a=theme({[preference]:'light'},{setBlocked:true});a.ready();
  a.click();assertAppearance(a,'dark');assert.equal(a.store[preference],'light');
  a.click();assertAppearance(a,'light');
});

test('blocked reads and writes never prevent changing the theme in this page',()=>{
  const a=theme({}, {getBlocked:true,setBlocked:true});a.ready();
  a.click();assertAppearance(a,'dark');a.click();assertAppearance(a,'light');
  assert.deepEqual(a.store,{});
});

test('theme toggles persist only the theme key and leave financial data byte-identical',()=>{
  const financial={
    [C.STORAGE_KEY]:'{"fixture":"personal purchases and settings"}',
    ...Object.fromEntries(Object.values(C.CACHE_KEYS).map(key=>[key,'{"fixture":"public rates"}'])),
    'gelcost-v5.5-personal':'{"fixture":"legacy purchases"}'
  };
  const a=theme(financial);a.ready();a.click();assertAppearance(a,'dark');
  const b=theme(a.store);b.ready();assertAppearance(b,'dark');
  a.click();assertAppearance(a,'light');
  assert.deepEqual(a.reads,[preference]);
  assert.deepEqual(a.writes,[[preference,'dark'],[preference,'light']]);
  for(const [key,value] of Object.entries(financial))assert.equal(a.store[key],value,key);
  assert.deepEqual(Object.keys(a.store).sort(),[...Object.keys(financial),preference].sort());
});

test('missing optional theme metadata or button does not crash initialization',()=>{
  const a=theme({}, {noMeta:true});a.ready();a.click();assertAppearance(a,'dark');
  const b=theme({}, {noButton:true});assert.doesNotThrow(()=>b.ready());
  assert.equal(b.documentElement.dataset.theme,'light');
});

test('theme script runs once from the head and its toggle is not a submit button',()=>{
  const scripts=Array.from(html.matchAll(/<script\b[^>]*\bsrc="theme\.js[^\"]*"[^>]*>/g));
  assert.equal(scripts.length,1);
  assert.ok(scripts[0].index<html.indexOf('</head>'));
  assert.doesNotMatch(scripts[0][0],/\b(?:async|defer)\b/);
  const toggle=html.match(/<button\b[^>]*\bid="themeToggle"[^>]*>/g)||[];
  assert.equal(toggle.length,1);assert.match(toggle[0],/\btype="button"/);
});

test('exchange answer moves as one live region inside the existing selected-offer action panel',()=>{
  for(const id of ['offerActions','exchangeSummary','exchangeResultLabel','exchangeReceive']){
    assert.equal((html.match(new RegExp('\\bid="'+id+'"','g'))||[]).length,1,id+' must not be cloned');
  }
  assert.match(html,/<div\b[^>]*\bid="offerActions"[^>]*>\s*<div\b[^>]*\bid="exchangeSummary"[^>]*\baria-live="polite"[^>]*>/);
  const start=html.indexOf('id="exchangeSummary"');
  const summary=html.slice(start,html.indexOf('</div>',start));
  assert.match(summary,/id="exchangeResultLabel"/);
  assert.match(summary,/id="exchangeReceive"/);
  assert.doesNotMatch(summary,/<button\b/,'The answer is not nested in an actionable rate row');
});

// Reuse only the existing app harness helpers, without registering its test suite.
const harnessSource=fs.readFileSync(path.join(__dirname,'app.test.cjs'),'utf8');
const harnessBoundary=harnessSource.indexOf('\nfunction inteliResponses(){');
assert.ok(harnessBoundary>0);
const harnessPreamble=harnessSource.slice(0,harnessBoundary);
assert.ok(!/^test\(/m.test(harnessPreamble));
const {app}=new Function('require','__dirname',harnessPreamble+'\nreturn {app};')(require,__dirname);

test('selected offer total is hidden only outside quote-selection mode',async()=>{
  const css=fs.readFileSync(path.join(root,'theme.css'),'utf8');
  const hiding=Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(([,selector,declarations])=>selector.includes('.offer-top b')&&/display\s*:\s*none\b/.test(declarations));
  assert.ok(hiding.length>0,'Ordinary exchange should not duplicate its selected total');
  for(const [,selector] of hiding){
    for(const part of selector.split(','))assert.match(part,/#exchangeView:not\(\.is-selecting\)/,'Never suppress selected quote in selection mode');
  }
  const a=await app();assert.equal(a.els.exchangeView.classes.has('is-selecting'),false);
  a.run('showView("calculator");reversePlan();choosePlanOffice();selectOffer("office:rico")');
  assert.equal(a.els.exchangeView.classes.has('is-selecting'),true);
  assert.equal(a.els.exchangeSummary.hidden,true,'Unrelated buy total stays hidden');
  const row=a.els.offerList.children.find(n=>n.dataset.offerKey==='office:rico');
  assert.ok(row);assert.equal(row.attrs['aria-pressed'],'true');
  assert.equal(row.children[0].children[1].textContent,'2,6150 ₾','Selected sell quote retains its number');
  a.run('showView("calculator");showView("exchange")');
  assert.equal(a.els.exchangeView.classes.has('is-selecting'),false);
  assert.equal(a.els.exchangeSummary.hidden,false);
});

test('exchange tools and manual editor have one stable static parent structure',()=>{
  const parents={},stack=[];
  for(const [,closing,attributes] of html.matchAll(/<(\/?)div\b([^>]*)>/g)){
    if(closing){stack.pop();continue;}
    const id=attributes.match(/\bid="([^"]+)"/)?.[1]||null;
    if(id)parents[id]=stack.at(-1);
    stack.push(id);
  }
  for(const id of ['offerToolsHome','offerToolsPanel','cashRateHost','exchangeManualPanel'])
    assert.equal((html.match(new RegExp('\\bid="'+id+'"','g'))||[]).length,1,id+' must not be cloned');
  assert.equal(parents.offerToolsPanel,'offerToolsHome');
  assert.equal(parents.cashRateHost,'offerToolsPanel');
});

test('tools follow selected offer and fall back home without offers, preserving the manual draft',async()=>{
  const a=await app(),tools=a.els.offerToolsPanel;
  assert.equal(tools.parentElement,a.els.offerActions);
  // The lightweight harness does not parse descendants: attach the statically verified editor.
  tools.appendChild(a.els.cashRateHost);
  a.els.exchangeManualValue.value='2,7777';
  a.run('selectOffer("office:rico");renderOffers()');
  assert.equal(tools.parentElement,a.els.offerActions);
  assert.equal(a.els.offerActions.children.filter(n=>n===tools).length,1);
  a.run('banks=null;offices=null;state.cashGelRate=0;renderOffers()');
  assert.equal(a.els.offerList.hidden,true);
  assert.equal(tools.parentElement,a.els.offerToolsHome,'No offers must not hide refresh/manual tools with the action panel');
  assert.equal(a.els.offerToolsHome.children.filter(n=>n===tools).length,1);
  assert.equal(a.els.cashRateHost.parentElement,tools);
  assert.equal(a.els.exchangeManualValue.value,'2,7777');
  await a.run('refreshAllRates()');
  assert.equal(tools.parentElement,a.els.offerActions);
  assert.equal(a.els.offerToolsHome.children.includes(tools),false);
  assert.equal(a.els.exchangeManualValue.value,'2,7777');
});
