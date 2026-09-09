/* Same-origin, sanitized public projection only. No geolocation, user storage,
 * translation service or direct supplier requests. Financial modules untouched. */
(function(root){
  'use strict';
  const SOURCE='https://my.energo-pro.ge/ow/#/disconns';
  const STALE_MS=3*60*60*1000, REFRESH_MS=5*60*1000;
  const QUERY_NAMES={batumi:'Центр Батуми',khelvachauri:'Центр Хелвачаури — адреса Батуми'};
  const STATUSES=new Set(['ok','partial','error','blocked','missing']);
  const KINDS={planned:'Плановое',unplanned:'Внеплановое',unknown:'Тип не указан'};
  const TRANSLATIONS=new Set(['verified-dictionary','partial','original']);
  const utc=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)&&localTime(value.slice(0,-1).replace('T',' '))&&Number.isFinite(Date.parse(value));
  const safeText=value=>typeof value==='string'&&value.length>0&&value.length<=4000&&!/[<>\p{C}]/u.test(value);
  const digits=value=>(value.match(/[0-9]+/g)||[]).join('|');
  function localTime(value){
    if(value===null)return true;
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?$/.test(value))return false;
    if(value.length>16&&Number(value.slice(17,19))>59)return false;
    const base=value.slice(0,16),date=new Date(base.replace(' ','T')+':00Z');
    return Number.isFinite(date.getTime())&&date.toISOString().slice(0,16)===base.replace(' ','T');
  }
  function validate(raw,now=Date.now()){
    const fail=()=>{throw new Error('invalid_outage_snapshot');};
    if(!raw||raw.schemaVersion!==1||raw.stage!=='local-preview'||raw.city!=='batumi'||raw.coverage!=='partial'||!utc(raw.generatedAt)||Date.parse(raw.generatedAt)>now+60000)fail();
    if(!Array.isArray(raw.queries)||raw.queries.length!==2||!Array.isArray(raw.events)||raw.events.length>2000)fail();
    const queryKeys=new Set();
    const queries=raw.queries.map(q=>{
      if(!q||!Object.hasOwn(QUERY_NAMES,q.key)||queryKeys.has(q.key)||!STATUSES.has(q.status))fail();queryKeys.add(q.key);
      for(const key of ['lastAttemptAt','lastSuccessAt'])if(q[key]!==null&&(!utc(q[key])||Date.parse(q[key])>now+60000))fail();
      if(q.lastAttemptAt&&Date.parse(q.lastAttemptAt)>Date.parse(raw.generatedAt))fail();
      if(q.lastSuccessAt&&(!q.lastAttemptAt||Date.parse(q.lastSuccessAt)>Date.parse(q.lastAttemptAt)))fail();
      if(['ok','partial'].includes(q.status)&&!q.lastSuccessAt)fail();
      return {key:q.key,status:q.status,lastAttemptAt:q.lastAttemptAt,lastSuccessAt:q.lastSuccessAt};
    });
    const ids=new Set();
    const events=raw.events.map(e=>{
      if(!e||typeof e.id!=='string'||!/^energo:[a-f0-9]{32,64}$/.test(e.id)||ids.has(e.id)||!Object.hasOwn(KINDS,e.kind)||!e.startLocal||!localTime(e.startLocal)||!localTime(e.endLocal)||e.endMeaning!=='unconfirmed'||e.restoration!=='unconfirmed')fail();ids.add(e.id);
      if(e.endLocal&&Date.parse(e.startLocal.replace(' ','T')+'Z')>Date.parse(e.endLocal.replace(' ','T')+'Z'))fail();
      if(!utc(e.firstSeenAt)||!utc(e.lastSeenAt)||Date.parse(e.firstSeenAt)>Date.parse(e.lastSeenAt)||Date.parse(e.lastSeenAt)>now+60000)fail();
      if(!Array.isArray(e.addresses)||!e.addresses.length||e.addresses.length>100||!Array.isArray(e.provenance)||!e.provenance.length||e.provenance.length>2)fail();
      const addresses=e.addresses.map(a=>{
        if(!a||!safeText(a.original)||!safeText(a.display)||!TRANSLATIONS.has(a.translationStatus)||typeof a.needsReview!=='boolean'||!Array.isArray(a.houseTokens)||a.houseTokens.some(t=>!safeText(t))||digits(a.original)!==digits(a.display))fail();
        if(a.houseTokens.some(t=>!a.original.includes(t)||!a.display.includes(t)))fail();
        // Defense in depth, not a substitute for the structural collector gate.
        if(/ბინა|აბონენტ|\bapt\b|\bapartment\b|квартир|кв\.|\+?995[\s()-]*\d|\d{9,}/iu.test(a.original+' '+a.display))fail();
        return {original:a.original,display:a.display,translationStatus:a.translationStatus,houseTokens:a.houseTokens.slice(),needsReview:a.needsReview};
      });
      const seenQueries=new Set();
      const provenance=e.provenance.map(p=>{
        const q=queries.find(q=>q.key===p?.query);
        if(!q||seenQueries.has(p.query)||!utc(p.seenAt)||typeof p.inLatestResponse!=='boolean'||!q.lastSuccessAt||Date.parse(p.seenAt)>Date.parse(q.lastSuccessAt)||Date.parse(p.seenAt)>Date.parse(e.lastSeenAt))fail();
        seenQueries.add(p.query);return {query:p.query,seenAt:p.seenAt,inLatestResponse:p.inLatestResponse};
      });
      if(Date.parse(e.lastSeenAt)!==Math.max(...provenance.map(p=>Date.parse(p.seenAt)))||Date.parse(e.lastSeenAt)>Date.parse(raw.generatedAt))fail();
      return {id:e.id,kind:e.kind,addresses,startLocal:e.startLocal,endLocal:e.endLocal,firstSeenAt:e.firstSeenAt,lastSeenAt:e.lastSeenAt,provenance};
    });
    if(!Number.isSafeInteger(raw.quality?.omitted)||raw.quality.omitted<0)fail();
    return {generatedAt:raw.generatedAt,city:'batumi',queries,events,omitted:raw.quality.omitted};
  }
  function queryStale(q,now=Date.now()){return !q.lastSuccessAt||now-Date.parse(q.lastSuccessAt)>STALE_MS;}
  function eventState(e,queries,now=Date.now()){
    return {missing:e.provenance.every(p=>!p.inLatestResponse),stale:e.provenance.every(p=>{
      const q=queries.find(q=>q.key===p.query);
      return !q||queryStale(q,now)||now-Date.parse(p.seenAt)>STALE_MS;
    })};
  }
  function addressMatches(address,query){
    const tokens=String(query).toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
    const text=(address.display+' '+address.original).toLocaleLowerCase('ru');
    return tokens.every(token=>{
      if(!/\d/.test(token))return text.includes(token);
      // A whole address fragment: 8 != 18, 8а != 8a, 8/1 != 81.
      const escaped=token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp('(?<![\\p{L}\\p{N}/–—-])'+(/^\d/.test(token)?'(?:N\\s*)?':'')+escaped+'(?![\\p{L}\\p{N}/–—-])','iu').test(text);
    });
  }
  const stamp=value=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Tbilisi',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'не получены';
  function sourceTime(value){
    if(!value)return 'не указано';
    const [date,time]=value.split(' '),[year,month,day]=date.split('-');
    return `${day}.${month}.${year}, ${time.slice(0,5)}`;
  }
  const today=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tbilisi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  function mount(env=root){
    const doc=env.document,$=id=>doc?.getElementById(id);
    const view=$('servicesView'),list=$('outageList'),status=$('outageStatus'),controls=$('outageControls'),search=$('outageSearch'),refresh=$('outageRefresh'),meta=$('outageMetadata'),caution=$('outageCaution'),select=$('exchangeCity');
    if(![view,list,status,controls,search,refresh,meta,caution,select].every(Boolean))return null;
    let service='power',data=null,loading=false,error=false,attempted=false,lastLoad=0,metadataSignature='',listSignature='',lastCity=select.value;
    let disclosures=new Map(),focusTargets=new Map();
    const focusKeys=new WeakMap();
    const clock=()=>Date.now();
    const make=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
    function trackFocus(node,key){focusTargets.set(key,node);focusKeys.set(node,key);return node;}
    function disclosure(key,label,previous){const node=make('details'),summary=make('summary',label);node.open=!!previous.get(key)?.open;node.append(trackFocus(summary,key));disclosures.set(key,node);return node;}
    function sourceLink(key){const a=make('a','Оригинал у Energo-Pro','outage-source');a.href=SOURCE;a.target='_blank';a.rel='noopener noreferrer';a.referrerPolicy='no-referrer';a.setAttribute('aria-label','Оригинал у Energo-Pro (новая вкладка)');return trackFocus(a,key);}
    function renderMetadata(){
      if(!data){meta.replaceChildren();return;}
      const wasOpen=meta.children[0]?.open,oldSummary=meta.children[0]?.children[0],wasFocused=oldSummary===doc.activeElement;
      const details=make('details'),summary=make('summary','Об источнике и переводе');details.open=!!wasOpen;details.append(summary);
      for(const q of data.queries){const bad=queryStale(q,clock()),failed=!['ok','partial'].includes(q.status);details.append(make('p',QUERY_NAMES[q.key]+': '+stamp(q.lastSuccessAt)+(failed?' · последняя проверка не удалась':bad?' · сохранённая копия':'')));}
      details.append(make('p','Даты получения — по времени Грузии. Время начала и конца приведено как у поставщика: его часовой пояс и значение конца ещё уточняются. Это не подтверждение восстановления.'));
      details.append(make('p','Русский поиск доступен для переведённых улиц. Неизвестные названия и буквы в номерах домов остаются как у поставщика. Оригинал можно раскрыть в каждом объявлении.'));
      details.append(make('p','Сайт показывает подготовленную копию. Постоянный сбор ещё не запущен; кнопка проверяет только обновление файла.'));
      meta.replaceChildren(details);
      if(wasFocused&&!view.hidden)summary.focus({preventScroll:true});
    }
    function card(e,previous){
      const article=make('article',undefined,'outage-card'),kind=make('span',KINDS[e.kind],'outage-kind');
      article.append(kind,make('h3','Начало: '+sourceTime(e.startLocal)),make('p',e.endLocal?'Указанный конец: '+sourceTime(e.endLocal):'Конец не указан','note'));
      const filtered=e.addresses.filter(a=>addressMatches(a,search.value));
      const addresses=search.value.trim()?filtered:e.addresses;
      // The city is already labelled above. Only its exact display prefix is
      // omitted here; stored originals, street text and house tokens stay intact.
      const appendAddresses=(parent,rows)=>{const ul=make('ul');for(const a of rows){const li=make('li'),p=make('p',a.display.replace(/^Батуми(?:\/|,\s*)/,''),'outage-address');li.append(p);ul.append(li);}parent.append(ul);};
      appendAddresses(article,addresses.slice(0,2));
      if(addresses.length>2){const more=disclosure(e.id+':addresses','Все адреса · '+addresses.length,previous);appendAddresses(more,addresses.slice(2));article.append(more);}
      const original=disclosure(e.id+':original','Оригинал на грузинском',previous);
      for(const a of addresses){const p=make('p',a.original,'outage-address');p.lang='ka';original.append(p);}
      if(addresses.some(a=>a.translationStatus!=='verified-dictionary'))article.append(make('p',addresses.every(a=>a.translationStatus==='original')?'Адрес на языке источника':'Переведено частично','note'));
      article.append(original);
      const state=eventState(e,data.queries,clock());
      if(state.missing)article.append(make('p','Нет в последней выдаче. Восстановление не подтверждено.','note'));
      if(state.stale)article.append(make('p','Сохранённое объявление · получено '+stamp(e.lastSeenAt),'note'));
      article.append(sourceLink(e.id+':source'));return article;
    }
    function renderList(){
      if(!data){list.replaceChildren();return;}
      const signature=JSON.stringify([search.value,today(clock()),data.events.map(e=>[e.id,e.kind,e.addresses,e.startLocal,e.endLocal,eventState(e,data.queries,clock()),eventState(e,data.queries,clock()).stale?e.lastSeenAt:null])]);
      // An unchanged reload must not close disclosures or detach focused links.
      if(signature===listSignature)return;
      listSignature=signature;
      const previous=disclosures,focusedKey=focusKeys.get(doc.activeElement);disclosures=new Map();focusTargets=new Map();
      const events=data.events.filter(e=>e.addresses.some(a=>addressMatches(a,search.value))).sort((a,b)=>(b.startLocal||'').localeCompare(a.startLocal||'')||a.id.localeCompare(b.id));
      if(!events.length){list.replaceChildren(make('p',search.value.trim()?'По вашему запросу объявлений не найдено. Это не означает, что отключений нет.':'В полученной копии нет объявлений, которые можно безопасно показать. Проверьте сайт поставщика.','note'));return;}
      const current=[],older=[],date=today(clock());
      for(const e of events)((e.startLocal&&e.startLocal.slice(0,10)<date)?older:current).push(e);
      current.sort((a,b)=>a.startLocal.localeCompare(b.startLocal)||a.id.localeCompare(b.id));
      const nodes=current.map(e=>card(e,previous));
      if(older.length){const past=disclosure('older','Более ранние объявления · '+older.length,previous);past.className='outage-older';past.open=past.open||!!search.value.trim()||older.some(e=>focusedKey?.startsWith(e.id+':'));for(const e of older)past.append(card(e,previous));nodes.push(past);}
      list.replaceChildren(...nodes);
      if(focusedKey&&!view.hidden)focusTargets.get(focusedKey)?.focus({preventScroll:true});
    }
    function renderState(){
      const connected=select.value==='batumi'&&service==='power';
      controls.hidden=!connected;caution.hidden=!connected;
      if(!connected){status.textContent='Автоматическая лента пока не подключена. Сайты и телефоны — ниже.';status.className='note';list.replaceChildren();listSignature='';meta.replaceChildren();return;}
      let message=loading?'Загружаем объявления…':'';
      const stale=data?.queries.some(q=>queryStale(q,clock())),failed=data?.queries.some(q=>!['ok','partial'].includes(q.status));
      if(!loading){
        if(error)message=data?'Не удалось проверить обновления. Показана сохранённая копия.':'Не удалось загрузить объявления. Проверьте сайт поставщика.';
        else if(!data)message='Загружаем объявления…';
        else if(failed)message='Часть данных не обновилась. Список может быть неполным.';
        else if(stale)message='Данные давно не обновлялись. Показана сохранённая копия.';
        else message='Объявления Energo-Pro · тестовая лента.';
        if(data?.omitted)message+=' Часть записей пропущена при обработке.';
      }
      status.textContent=message;status.className='note'+((error||failed||stale)?' is-warning':'');
      // Keep keyboard focus on the refresh action while its request is pending.
      // load() guards repeat activation; native disabled would move focus to body.
      refresh.setAttribute('aria-disabled',String(loading));
      const signature=JSON.stringify([data?.queries,error,stale]);
      if(signature!==metadataSignature||!meta.children.length){renderMetadata();metadataSignature=signature;}
    }
    async function load(){
      if(loading)return;
      loading=true;attempted=true;lastLoad=clock();renderState();
      const controller=new env.AbortController(),timer=env.setTimeout(()=>controller.abort(),10000);
      try{
        const response=await env.fetch('outages.json',{cache:'no-store',credentials:'omit',signal:controller.signal});
        if(!response.ok)throw new Error('snapshot_unavailable');
        const body=await response.text();if(body.length>2000000)throw new Error('snapshot_too_large');
        const next=validate(JSON.parse(body),clock());
        if(data&&Date.parse(next.generatedAt)<Date.parse(data.generatedAt))throw new Error('snapshot_rollback');
        data=next;error=false;
      }catch(_){error=true;}finally{env.clearTimeout(timer);loading=false;}
      renderState();if(select.value==='batumi'&&service==='power')renderList();
    }
    function render(){
      if(view.hidden)return;
      if(lastCity!==select.value){search.value='';lastCity=select.value;}
      renderState();if(select.value==='batumi'&&service==='power'){
        renderList();if(!attempted||clock()-lastLoad>=REFRESH_MS)void load();
      }
    }
    const listeners=[];
    function on(node,type,fn){node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));}
    for(const [key,id] of [['power','outagePower'],['water','outageWater'],['gas','outageGas']]){
      const button=$(id);if(!button)continue;
      on(button,'click',()=>{service=key;for(const [k,i] of [['power','outagePower'],['water','outageWater'],['gas','outageGas']])$(i)?.setAttribute('aria-pressed',String(k===key));render();});
    }
    // The feed owns its city updates even when the directory module is absent.
    on(select,'change',render);
    on(search,'input',renderList);on(refresh,'click',()=>void load());
    const interval=env.setInterval(()=>{if(!view.hidden){renderState();if(select.value==='batumi'&&service==='power'&&clock()-lastLoad>=REFRESH_MS)void load();}},60000);
    render();
    return {render,destroy(){listeners.forEach(fn=>fn());env.clearInterval(interval);}};
  }
  const api={validate,queryStale,eventState,addressMatches,sourceTime,localTime,mount,STALE_MS};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {root.GamarjiOutages=api;const instance=mount(root);api.render=()=>instance?.render();}
})(typeof window==='object'?window:globalThis);
