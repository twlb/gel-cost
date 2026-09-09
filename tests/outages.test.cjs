// Public-outage UI contracts. Fixtures are synthetic, not supplier incidents.
// Fake DOM tests do not verify browser rendering, phones or live source coverage.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const O=require('../outages.js');
const NOW=Date.now();
const iso=(age=0)=>new Date(NOW-age).toISOString();
const clone=value=>JSON.parse(JSON.stringify(value));
const street=(original='ბათუმი, კობალაძის ქუჩა 8',display='Батуми, улица Кобаладзе 8',translationStatus='verified-dictionary')=>({original,display,translationStatus,houseTokens:['8'],needsReview:translationStatus!=='verified-dictionary'});
function snapshot(){
  return {schemaVersion:1,stage:'local-preview',city:'batumi',coverage:'partial',generatedAt:iso(),
    queries:[{key:'batumi',status:'partial',lastAttemptAt:iso(),lastSuccessAt:iso()},{key:'khelvachauri',status:'partial',lastAttemptAt:iso(),lastSuccessAt:iso()}],
    events:[{id:'energo:'+'a'.repeat(32),kind:'planned',startLocal:'2026-09-09 11:00:00',endLocal:'2026-09-09 13:00:00',endMeaning:'unconfirmed',restoration:'unconfirmed',firstSeenAt:iso(60000),lastSeenAt:iso(),addresses:[street()],provenance:[{query:'batumi',seenAt:iso(),inLatestResponse:true}]}],quality:{omitted:0}};
}
const normalized=()=>O.validate(snapshot(),NOW);

class Node {
  constructor(tag,doc){this.tagName=tag.toUpperCase();this.doc=doc;this.children=[];this.events=new Map();this.attrs={};this.hidden=false;this.disabled=false;this.value='';this._text='';this.className='';this.open=false;}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  set innerHTML(_){throw Error('Public address must not enter innerHTML');}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){this._text='';this.children=[];this.append(...nodes);}
  setAttribute(key,value){this.attrs[key]=String(value);}
  addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}
  removeEventListener(name,fn){this.events.get(name)?.delete(fn);}
  emit(name,event={}){for(const fn of [...this.events.get(name)||[]])fn(event);}
  focus(){this.doc.activeElement=this;}
}
const walk=node=>[node,...node.children.flatMap(walk)];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const response=body=>({ok:true,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
function harness({city='batumi',hidden=false,responses=[response(snapshot())]}={}){
  const nodes={},timers=new Map(),intervals=new Map(),calls=[],queue=[...responses];let sequence=0,forbidden=0;
  const document={activeElement:null,getElementById:id=>nodes[id]||null,createElement:tag=>new Node(tag,document)};
  for(const id of ['servicesView','outageList','outageStatus','outageControls','outageSearch','outageRefresh','outageMetadata','outageCaution','exchangeCity','outagePower','outageWater','outageGas']){nodes[id]=new Node('div',document);nodes[id].id=id;}
  nodes.servicesView.hidden=hidden;nodes.exchangeCity.value=city;nodes.outagePower.attrs['aria-pressed']='true';nodes.outageWater.attrs['aria-pressed']='false';nodes.outageGas.attrs['aria-pressed']='false';
  const env={document,AbortController,fetch:async(url,options)=>{calls.push({url,options});const result=queue.shift();if(result instanceof Error)throw result;return typeof result==='function'?result(options):await result;},setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval(fn,ms){const id=++sequence;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id)};
  for(const key of ['localStorage','sessionStorage','navigator','state','appState'])Object.defineProperty(env,key,{get(){forbidden++;throw Error('Forbidden access: '+key);}});
  return {env,nodes,document,calls,queue,timers,intervals,get forbidden(){return forbidden;},fireTimeout(){const timer=[...timers.values()].find(t=>t.ms===10000);assert.ok(timer,'Timeout registered');timer.fn();},click(id){nodes[id].emit('click');},search(value){nodes.outageSearch.value=value;nodes.outageSearch.emit('input');}};
}

test('projection validation returns only allowed fields and preserves source dates and house fragments',()=>{
  const raw=snapshot();raw.privatePayload='not copied';raw.events[0].subscriber='not copied';raw.queries[0].secret='not copied';
  const data=O.validate(raw,NOW);assert.equal(data.events[0].startLocal,raw.events[0].startLocal);assert.equal(data.events[0].endLocal,raw.events[0].endLocal);assert.deepEqual(data.events[0].addresses[0].houseTokens,['8']);assert.equal(data.omitted,0);
  assert.equal(data.privatePayload,undefined);assert.equal(data.events[0].subscriber,undefined);assert.equal(data.queries[0].secret,undefined);
  raw.events[0].addresses[0].houseTokens.push('999');assert.deepEqual(data.events[0].addresses[0].houseTokens,['8']);
});

test('malformed public projections are rejected rather than appearing as an empty healthy feed',()=>{
  const cases=[r=>{r.stage='production';},r=>{r.coverage='complete';},r=>{r.city='tbilisi';},r=>{r.generatedAt=iso(-120000);},r=>{r.queries.pop();},r=>{r.queries[1].key='batumi';},r=>{r.queries[0].key='__proto__';},r=>{r.queries[0].status='working';},r=>{r.queries[0].lastSuccessAt=null;},r=>{r.queries[0].lastSuccessAt=iso(-1000);},r=>{r.events.push(clone(r.events[0]));},r=>{r.events[0].id='<script>';},r=>{r.events[0].kind='restored';},r=>{r.events[0].restoration='confirmed';},r=>{r.events[0].endMeaning='actual';},r=>{r.events[0].endLocal='2026-09-09 10:00';},r=>{r.events[0].firstSeenAt=iso(-1000);},r=>{r.events[0].addresses=[];},r=>{r.events[0].provenance=[];},r=>{r.events[0].provenance[0].query='unknown';},r=>{r.events[0].provenance[0].seenAt=iso(-1000);},r=>{r.events[0].provenance[0].inLatestResponse='yes';},r=>{r.quality.omitted=-1;}];
  for(const [index,mutate] of cases.entries()){const raw=snapshot();mutate(raw);assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/,'case '+index);}
});

test('address validation rejects markup, changed numbers and obvious subscriber data',()=>{
  for(const address of [street('<img src=x>','<img src=x>'),street('ბათუმი 8','Батуми 18'),street('ბათუმი, apt 8','Батуми, apt 8'),street('ბათუმი, бина 123456789','Батуми, бина 123456789'),street('ბათუმი +995 555 123456','Батуми +995 555 123456')]){const raw=snapshot();raw.events[0].addresses=[address];assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/);}
  const raw=snapshot();raw.events[0].addresses[0].houseTokens=['18'];assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/);
});

test('partial and original translations stay distinct without asserting geographic verification',()=>{
  const raw=snapshot();raw.events[0].addresses=[street('ბათუმი, უცნობი ქუჩა 8','Батуми, უცნობი ქუჩა 8','partial'),street('ბათუმი, უცნობი ქუჩა 8','ბათუმი, უცნობი ქუჩა 8','original')];
  const data=O.validate(raw,NOW);assert.deepEqual(data.events[0].addresses.map(a=>a.translationStatus),['partial','original']);assert.ok(data.events[0].addresses.every(a=>a.needsReview));
  assert.equal(data.events[0].addresses[1].display,data.events[0].addresses[1].original);
});

test('source local dates validate calendar days and preserve an unconfirmed timezone',()=>{
  for(const value of [null,'2024-02-29 23:59','2026-09-09 11:00:00','2026-09-09 11:00:00.1234567'])assert.equal(O.localTime(value),true,String(value));
  for(const value of [undefined,'','2026-02-29 11:00','2026-02-30 11:00','2026-13-01 11:00','2026-09-09 24:00','2026-09-09 11:60','2026-09-09T11:00:00Z','2026-09-09 11:00+04:00'])assert.equal(O.localTime(value),false,String(value));
  assert.equal(O.sourceTime('2026-09-09 11:15:30.123'),'09.09.2026, 11:15');assert.equal(O.sourceTime(null),'не указано');
});

test('source local timestamps reject impossible seconds, not just invalid minute prefixes',()=>{
  for(const value of ['2026-09-09 11:00:60','2026-09-09 11:00:99','2026-09-09 11:00:99.123'])assert.equal(O.localTime(value),false,value);
});

test('public events require a source start time while an unknown end is allowed',()=>{
  const raw=snapshot();raw.events[0].endLocal=null;assert.doesNotThrow(()=>O.validate(raw,NOW));raw.events[0].startLocal=null;assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/);
});

test('collection timestamps reject calendar overflow rather than Date.parse normalization',()=>{
  for(const field of ['generatedAt','firstSeenAt','lastSeenAt']){const raw=snapshot();(field==='generatedAt'?raw:raw.events[0])[field]='2026-02-30T00:00:00Z';assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/,field);}
});

test('query observation times cannot lie after the projection generation time',()=>{
  const raw=snapshot();raw.generatedAt=iso(60000);assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/);
});

test('event lastSeen must equal its newest provenance rather than a fabricated later timestamp',()=>{
  const raw=snapshot();raw.events[0].provenance[0].seenAt=iso(30000);assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/);
  raw.events[0].lastSeenAt=iso(30000);assert.doesNotThrow(()=>O.validate(raw,NOW));
  raw.events[0].provenance.push({query:'khelvachauri',seenAt:iso(),inLatestResponse:true});raw.events[0].lastSeenAt=iso();assert.doesNotThrow(()=>O.validate(raw,NOW));
});

test('event observation time must not be later than projection generation',()=>{
  const raw=snapshot();raw.generatedAt=iso(30000);for(const q of raw.queries){q.lastAttemptAt=iso(30000);q.lastSuccessAt=iso(30000);}raw.events[0].provenance[0].seenAt=iso(30000);assert.throws(()=>O.validate(raw,NOW),/invalid_outage_snapshot/);
});

test('equal source wall times with different allowed precision do not fail interval ordering',()=>{
  for(const [start,end] of [['2026-09-09 11:00:00','2026-09-09 11:00'],['2026-09-09 11:00:00.000','2026-09-09 11:00:00']]){
    const raw=snapshot();raw.events[0].startLocal=start;raw.events[0].endLocal=end;assert.doesNotThrow(()=>O.validate(raw,NOW));
  }
});

test('staleness is per query with an explicit three hour boundary',()=>{
  assert.equal(O.queryStale({lastSuccessAt:iso(O.STALE_MS)},NOW),false);assert.equal(O.queryStale({lastSuccessAt:iso(O.STALE_MS+1)},NOW),true);assert.equal(O.queryStale({lastSuccessAt:null},NOW),true);
});

test('fresh generatedAt and another fresh centre cannot refresh an old event',()=>{
  const raw=snapshot(),old=iso(O.STALE_MS+60000);raw.queries[0].lastSuccessAt=old;raw.events[0].firstSeenAt=old;raw.events[0].lastSeenAt=old;raw.events[0].provenance[0].seenAt=old;
  const data=O.validate(raw,NOW);assert.deepEqual(O.eventState(data.events[0],data.queries,NOW),{missing:false,stale:true});
  data.events[0].provenance.push({query:'khelvachauri',seenAt:iso(),inLatestResponse:true});assert.deepEqual(O.eventState(data.events[0],data.queries,NOW),{missing:false,stale:false});
});

test('disappearance and overdue source end never imply restoration or freshness',()=>{
  const data=normalized(),e=data.events[0];e.endLocal='2020-01-01 13:00';e.provenance[0].inLatestResponse=false;
  assert.deepEqual(O.eventState(e,data.queries,NOW),{missing:true,stale:false});
  e.provenance[0].seenAt=iso(O.STALE_MS+1);assert.deepEqual(O.eventState(e,data.queries,NOW),{missing:true,stale:true});
  e.provenance.push({query:'khelvachauri',seenAt:iso(),inLatestResponse:true});assert.equal(O.eventState(e,data.queries,NOW).missing,false);
});

test('address search supports Russian, Georgian, mixed case and whitespace',()=>{
  const address=street();for(const query of ['', '   ','кобаладзе','КОБАЛАДЗЕ 8','ბათუმი','კობალაძის 8','  Батуми   Кобаладзе  '])assert.equal(O.addressMatches(address,query),true,query);
  for(const query of ['Чавчавадзе','9','Кобаладзе 18'])assert.equal(O.addressMatches(address,query),false,query);
});

test('house queries do not confuse 8, 18, 8/1, Latin suffixes or range endpoints',()=>{
  const a=text=>({display:'Улица '+text,original:'ქუჩა '+text});
  for(const value of ['18','81','8/1','18/1','8a','8а','8-10','8–10','8—10'])assert.equal(O.addressMatches(a(value),'8'),false,value);
  for(const value of ['N8','№8','N 8'])assert.equal(O.addressMatches(a(value),'8'),true,value);
  assert.equal(O.addressMatches(a('8'),'8'),true);assert.equal(O.addressMatches(a('8/1'),'8/1'),true);assert.equal(O.addressMatches(a('81'),'8/1'),false);assert.equal(O.addressMatches(a('8а'),'8a'),false);
  assert.equal(O.addressMatches(a('8, 18'),'8'),true);assert.equal(O.addressMatches(a('8-10'),'8-10'),true);
});

test('initial visible feed fetches only a same-origin sanitized copy without credentials or personal state',async()=>{
  const a=harness();a.nodes.outageSearch.focus();const mounted=O.mount(a.env);assert.match(a.nodes.outageStatus.textContent,/Загружаем/);assert.equal(a.nodes.outageRefresh.attrs['aria-disabled'],'true');assert.equal(a.nodes.outageRefresh.disabled,false,'Native disabled must not discard keyboard focus');await settle();assert.equal(a.nodes.outageRefresh.attrs['aria-disabled'],'false');
  assert.equal(a.calls.length,1);assert.equal(a.calls[0].url,'outages.json');assert.equal(a.calls[0].options.credentials,'omit');assert.equal(a.calls[0].options.cache,'no-store');assert.ok(a.calls[0].options.signal);assert.equal(a.nodes.outageRefresh.disabled,false);assert.equal(a.forbidden,0);assert.equal(a.document.activeElement,a.nodes.outageSearch);assert.equal(a.nodes.servicesView.hidden,false);
  assert.match(a.nodes.outageList.textContent,/Кобаладзе 8/);assert.doesNotMatch(a.nodes.outageList.textContent,/всё работает|восстановлено|аварий: 0/i);mounted.destroy();
});

test('a hidden section does not fetch until entered and unsupported city does not fetch Batumi',async()=>{
  const a=harness({hidden:true});const mounted=O.mount(a.env);assert.equal(a.calls.length,0);a.nodes.servicesView.hidden=false;mounted.render();await settle();assert.equal(a.calls.length,1);mounted.destroy();
  for(const city of ['tbilisi','kobuleti','poti','kutaisi','unknown']){const b=harness({city});const m=O.mount(b.env);await settle();assert.equal(b.calls.length,0,city);assert.equal(b.nodes.outageControls.hidden,true);assert.match(b.nodes.outageStatus.textContent,/пока не подключена/);assert.equal(b.nodes.outageList.children.length,0);m.destroy();}
});

test('city change independently removes Batumi announcements without the directory module',async()=>{
  const a=harness();const mounted=O.mount(a.env);await settle();
  assert.match(a.nodes.outageList.textContent,/Кобаладзе/);
  a.search('Кобаладзе');a.nodes.exchangeCity.focus();
  a.nodes.exchangeCity.value='tbilisi';a.nodes.exchangeCity.emit('change');
  assert.equal(a.nodes.outageList.children.length,0);
  assert.equal(a.nodes.outageControls.hidden,true);
  assert.match(a.nodes.outageStatus.textContent,/пока не подключена/);
  assert.equal(a.document.activeElement,a.nodes.exchangeCity);
  a.nodes.exchangeCity.value='batumi';a.nodes.exchangeCity.emit('change');await settle();
  assert.match(a.nodes.outageList.textContent,/Кобаладзе/);
  assert.equal(a.nodes.outageSearch.value,'');
  assert.equal(a.calls.length,1,'Returning within the refresh interval must not duplicate requests');
  assert.equal(a.nodes.exchangeCity.events.get('change').size,1);
  mounted.destroy();assert.equal(a.nodes.exchangeCity.events.get('change').size,0);
});

test('metadata explicitly says that permanent collection has not started',async()=>{
  const a=harness();const mounted=O.mount(a.env);await settle();
  assert.match(a.nodes.outageMetadata.textContent,/Постоянный сбор ещё не запущен/);
  assert.doesNotMatch(a.nodes.outageMetadata.textContent,/Сбор источника работает отдельно/);
  mounted.destroy();
});

test('partial collection failures and older events remain visibly separate from fresh source data',async()=>{
  const raw=snapshot(),old=iso(O.STALE_MS+60000);raw.queries[0].status='error';raw.queries[0].lastSuccessAt=old;raw.events[0].firstSeenAt=old;raw.events[0].lastSeenAt=old;raw.events[0].provenance[0].seenAt=old;raw.quality.omitted=2;
  const a=harness({responses:[response(raw)]});const m=O.mount(a.env);await settle();assert.match(a.nodes.outageStatus.textContent,/Часть данных не обновилась/);assert.match(a.nodes.outageStatus.textContent,/Часть записей пропущена/);assert.match(a.nodes.outageList.textContent,/Сохранённое объявление/);assert.match(a.nodes.outageMetadata.textContent,/Центр Батуми.*последняя проверка не удалась/);assert.match(a.nodes.outageMetadata.textContent,/Центр Хелвачаури/);m.destroy();
});

test('missing record and partial/original translations retain distinct user-facing explanations',async()=>{
  const raw=snapshot();raw.events[0].provenance[0].inLatestResponse=false;raw.events[0].addresses=[street('ბათუმი, უცნობი ქუჩა 8','Батуми, უცნობი ქუჩა 8','partial')];
  const a=harness({responses:[response(raw)]});const m=O.mount(a.env);await settle();assert.match(a.nodes.outageList.textContent,/Переведено частично/);assert.match(a.nodes.outageList.textContent,/Нет в последней выдаче.*Восстановление не подтверждено/);assert.match(a.nodes.outageList.textContent,/Оригинал на грузинском/);
  const original=clone(raw);original.events[0].addresses=[street('ბათუმი, უცნობი ქუჩა 8','ბათუმი, უცნობი ქუჩა 8','original')];a.queue.push(response(original));a.click('outageRefresh');await settle();assert.match(a.nodes.outageList.textContent,/Адрес на языке источника/);m.destroy();
});

test('source links are explicit external handoffs and originals are text nodes with Georgian language',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();const nodes=walk(a.nodes.outageList),links=nodes.filter(n=>n.tagName==='A');assert.ok(links.length);for(const link of links){assert.equal(link.href,'https://my.energo-pro.ge/ow/#/disconns');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.equal(link.referrerPolicy,'no-referrer');assert.match(link.attrs['aria-label'],/новая вкладка/);}assert.ok(nodes.some(n=>n.lang==='ka'&&n.textContent.includes('კობალაძის')));m.destroy();
});

test('empty search differs from unavailable data and never claims there are no outages',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();a.search('18');assert.match(a.nodes.outageList.textContent,/По вашему запросу объявлений не найдено/);assert.match(a.nodes.outageList.textContent,/не означает, что отключений нет/);a.search('კობალაძის 8');assert.match(a.nodes.outageList.textContent,/Кобаладзе 8/);m.destroy();
  const raw=snapshot();raw.events=[];const b=harness({responses:[response(raw)]});const n=O.mount(b.env);await settle();assert.match(b.nodes.outageList.textContent,/нет объявлений, которые можно безопасно показать/);assert.doesNotMatch(b.nodes.outageList.textContent,/По вашему запросу/);n.destroy();
});

test('request failure, invalid JSON, malformed projection and rollback preserve the last valid copy',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();const before=a.nodes.outageList.textContent;
  const bad=snapshot();bad.events[0].restoration='confirmed';const older=snapshot();older.generatedAt=iso(60000);
  for(const next of [new Error('network'),{ok:false,text:async()=>''},response('{broken'),response(bad),response(older),response(' '.repeat(2000001))]){a.queue.push(next);a.click('outageRefresh');await settle();assert.equal(a.nodes.outageList.textContent,before);assert.match(a.nodes.outageStatus.textContent,/Не удалось проверить обновления.*сохранённая копия/);assert.equal(a.nodes.outageRefresh.disabled,false);}
  a.queue.push(response(snapshot()));a.click('outageRefresh');await settle();assert.doesNotMatch(a.nodes.outageStatus.textContent,/Не удалось/);m.destroy();
});

test('initial failure shows an honest fallback instead of an empty healthy list',async()=>{
  const a=harness({responses:[new Error('network')]});const m=O.mount(a.env);await settle();assert.match(a.nodes.outageStatus.textContent,/Не удалось загрузить объявления.*сайт поставщика/);assert.equal(a.nodes.outageList.children.length,0);assert.equal(a.nodes.outageRefresh.disabled,false);m.destroy();
});

test('ten second timeout aborts only the snapshot request and retains the last valid list',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();const before=a.nodes.outageList.textContent;
  a.queue.push(({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));a.click('outageRefresh');await settle();a.fireTimeout();await settle();assert.equal(a.calls.at(-1).options.signal.aborted,true);assert.equal(a.nodes.outageList.textContent,before);assert.match(a.nodes.outageStatus.textContent,/сохранённая копия/);assert.equal(a.nodes.outageRefresh.disabled,false);m.destroy();
});

test('duplicate refreshes share one in-flight request',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const a=harness({responses:[pending]});const m=O.mount(a.env);a.click('outageRefresh');a.click('outageRefresh');assert.equal(a.calls.length,1);resolve(response(snapshot()));await settle();assert.equal(a.nodes.outageRefresh.disabled,false);m.destroy();
});

test('late successful response after changing service does not leak power records into water or gas',async()=>{
  for(const service of ['outageWater','outageGas']){let resolve;const a=harness({responses:[new Promise(r=>resolve=r)]});const m=O.mount(a.env);a.click(service);assert.match(a.nodes.outageStatus.textContent,/пока не подключена/);resolve(response(snapshot()));await settle();assert.equal(a.nodes.outageList.children.length,0);assert.equal(a.nodes.outageControls.hidden,true);assert.equal(a.nodes.outageMetadata.children.length,0);assert.equal(a.nodes[service].attrs['aria-pressed'],'true');assert.equal(a.nodes.outagePower.attrs['aria-pressed'],'false');a.click('outagePower');assert.match(a.nodes.outageList.textContent,/Кобаладзе/);m.destroy();}
});

test('late response after changing city does not leak Batumi data and city change clears address query',async()=>{
  let resolve;const a=harness({responses:[new Promise(r=>resolve=r)]});const m=O.mount(a.env);a.search('Кобаладзе');a.nodes.exchangeCity.value='tbilisi';m.render();assert.equal(a.nodes.outageSearch.value,'');resolve(response(snapshot()));await settle();assert.equal(a.nodes.outageList.children.length,0);assert.equal(a.nodes.outageMetadata.children.length,0);assert.match(a.nodes.outageStatus.textContent,/пока не подключена/);a.nodes.exchangeCity.value='batumi';m.render();assert.match(a.nodes.outageList.textContent,/Кобаладзе/);m.destroy();
});

test('refresh preserves the search query, metadata disclosure and focus without touching financial state',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();a.search('Кобаладзе');a.nodes.outageSearch.focus();a.nodes.outageMetadata.children[0].open=true;a.queue.push(response(snapshot()));a.click('outageRefresh');await settle();assert.equal(a.nodes.outageSearch.value,'Кобаладзе');assert.equal(a.document.activeElement,a.nodes.outageSearch);assert.equal(a.nodes.outageMetadata.children[0].open,true);assert.equal(a.forbidden,0);m.destroy();
});

test('refresh of the same projection preserves an opened original rather than interrupting reading',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();
  const original=walk(a.nodes.outageList).find(n=>n.tagName==='DETAILS'&&n.children[0]?.textContent==='Оригинал на грузинском');assert.ok(original);original.open=true;
  a.queue.push(response(snapshot()));a.click('outageRefresh');await settle();
  const after=walk(a.nodes.outageList).find(n=>n.tagName==='DETAILS'&&n.children[0]?.textContent==='Оригинал на грузинском');assert.ok(after);assert.equal(after.open,true);m.destroy();
});

test('a newly received sibling announcement does not close an existing original being read',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();
  const findOriginal=()=>walk(a.nodes.outageList).find(n=>n.tagName==='DETAILS'&&n.children[0]?.textContent==='Оригинал на грузинском'&&n.textContent.includes('ქუჩა 8'));
  const original=findOriginal();assert.ok(original);original.open=true;
  const next=snapshot(),extra=clone(next.events[0]);extra.id='energo:'+'b'.repeat(32);extra.addresses=[{...street('ბათუმი, კობალაძის ქუჩა 18','Батуми, улица Кобаладзе 18'),houseTokens:['18']}];next.events.push(extra);
  a.queue.push(response(next));a.click('outageRefresh');await settle();
  assert.match(a.nodes.outageList.textContent,/Кобаладзе 18/);assert.equal(findOriginal().open,true);m.destroy();
});

test('changed announcements preserve focus on the same original summary or source link',async()=>{
  for(const target of ['original','source']){
    const a=harness();const m=O.mount(a.env);await settle();
    const find=()=>target==='source'?walk(a.nodes.outageList).find(n=>n.tagName==='A'):walk(a.nodes.outageList).find(n=>n.tagName==='SUMMARY'&&n.textContent==='Оригинал на грузинском');
    const before=find();assert.ok(before);before.focus();
    if(target==='original')before.parentElement.open=true;
    const next=snapshot();next.events[0].endLocal='2026-09-09 14:00:00';a.queue.push(response(next));a.click('outageRefresh');await settle();
    const after=find();assert.notEqual(after,before);assert.equal(a.document.activeElement,after,target);if(target==='original')assert.equal(after.parentElement.open,true);
    const older=walk(a.nodes.outageList).find(n=>n.className==='outage-older');if(older)assert.equal(older.open,true,'A retained focused record must not be hidden inside earlier announcements');m.destroy();
  }
});

test('all-addresses disclosure remains open and focused when another part of the announcement changes',async()=>{
  const raw=snapshot();raw.events[0].addresses=['8','18','28'].map(n=>({...street('ბათუმი, კობალაძის ქუჩა '+n,'Батуми, улица Кобаладзе '+n),houseTokens:[n]}));
  const a=harness({responses:[response(raw)]});const m=O.mount(a.env);await settle();const find=()=>walk(a.nodes.outageList).find(n=>n.tagName==='DETAILS'&&/^Все адреса/.test(n.children[0]?.textContent));const before=find();assert.ok(before);before.open=true;before.children[0].focus();
  const next=clone(raw);next.events[0].endLocal=null;a.queue.push(response(next));a.click('outageRefresh');await settle();const after=find();assert.equal(after.open,true);assert.equal(a.document.activeElement,after.children[0]);assert.match(after.textContent,/Кобаладзе 28/);m.destroy();
});

test('updated collection metadata keeps its disclosure and focused summary',async()=>{
  const a=harness();const m=O.mount(a.env);await settle();const before=a.nodes.outageMetadata.children[0];before.open=true;before.children[0].focus();
  const next=snapshot();next.queries[0].status='error';a.queue.push(response(next));a.click('outageRefresh');await settle();const after=a.nodes.outageMetadata.children[0];assert.notEqual(after,before);assert.equal(after.open,true);assert.equal(a.document.activeElement,after.children[0]);assert.match(after.textContent,/последняя проверка не удалась/);m.destroy();
});

test('a late update cannot reclaim focus from another control or a hidden section',async()=>{
  for(const hidden of [false,true]){
    const a=harness();const m=O.mount(a.env);await settle();let resolve;a.queue.push(new Promise(r=>resolve=r));a.click('outageRefresh');a.nodes.outageSearch.focus();a.nodes.servicesView.hidden=hidden;
    const next=snapshot();next.events[0].endLocal=null;resolve(response(next));await settle();assert.equal(a.document.activeElement,a.nodes.outageSearch);assert.equal(a.nodes.servicesView.hidden,hidden);m.destroy();
  }
});

test('missing module markup safely returns null and destroy removes its controls and interval',async()=>{
  assert.equal(O.mount({}),null);const incomplete=harness();delete incomplete.nodes.outageList;assert.equal(O.mount(incomplete.env),null);
  const a=harness();const m=O.mount(a.env);await settle();assert.equal(a.intervals.size,1);m.destroy();assert.equal(a.intervals.size,0);for(const id of ['outagePower','outageWater','outageGas','outageSearch','outageRefresh'])for(const fns of a.nodes[id].events.values())assert.equal(fns.size,0);
});

test('outage UI code has no personal-store, geolocation or financial-module dependency',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','outages.js'),'utf8');assert.doesNotMatch(source,/\b(?:localStorage|sessionStorage|navigator|GELCore|GamarjiInsurance|changePersonal|saveSettings|purchasePurchases)\s*[.(]/);
});
