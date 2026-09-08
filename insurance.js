(()=>{
  'use strict';
  const $=id=>document.getElementById(id),C=window.InsuranceCore;
  const previewBenefits=[['outpatient','Приёмы и анализы'],['emergency_hospital','Экстренный стационар']];
  const benefitOrder=['waiting_periods','approval','outpatient','medications','emergency_hospital','planned_hospital','dental','children'];
  let catalog=null,selected=new Set(),busy=false;
  // Keep cards alive while the user reads their conditions or filters companies.
  const cards=new Map();
  let readingContext=null,lastReadingFocus=null;
  const contextView=$('insuranceView');
  contextView.addEventListener?.('focusin',event=>{lastReadingFocus=event.target;});
  function contextReady(){return typeof contextView.querySelectorAll==='function'&&typeof contextView.contains==='function'&&typeof contextView.getBoundingClientRect==='function'&&typeof window.scrollTo==='function'&&Number.isFinite(window.innerHeight)&&window.innerHeight>0;}
  function readingRect(node){
    if(!node||!contextView.contains(node)||typeof node.getClientRects!=='function'||typeof node.getBoundingClientRect!=='function'||!node.getClientRects().length)return null;
    // Chromium can retain positive rectangles for descendants of a closed details.
    // Geometry alone therefore does not prove that the reader can see the content.
    for(let ancestor=node;ancestor;ancestor=ancestor.parentElement){
      if(ancestor.hidden)return null;
      if(ancestor!==node&&ancestor.tagName==='DETAILS'&&!ancestor.open){
        const summary=Array.from(ancestor.children).find(child=>child.tagName==='SUMMARY');
        if(!summary?.contains(node))return null;
      }
    }
    return node.getBoundingClientRect();
  }
  function readingBounds(predictSticky=false){
    let top=0,bottom=window.innerHeight;
    const bar=$('insuranceComparison').hidden?$('insuranceSelection'):contextView.querySelector('.insurance-comparison-tools');
    const barRect=bar?.getBoundingClientRect?.(),position=bar&&window.getComputedStyle?.(bar).position;
    if(barRect&&['sticky','fixed'].includes(position)&&(predictSticky||barRect.top<=1)&&barRect.bottom>0)top=barRect.height+8;
    const nav=document.querySelector?.('.bottom-nav'),navRect=nav?.getBoundingClientRect?.();
    if(navRect&&window.getComputedStyle?.(nav).position==='fixed'&&navRect.top<bottom)bottom=navRect.top;
    return {top,bottom};
  }
  function onReadingScreen(node,bounds){
    const rect=readingRect(node);
    return Boolean(rect&&rect.width>0&&rect.height>0&&rect.top<bounds.bottom-8&&rect.bottom>bounds.top+8);
  }
  function visibleReadingFocus(node,bounds){return Boolean(node&&!node.disabled&&onReadingScreen(node,bounds)&&readingRect(node).top>=bounds.top-1);}
  function contextContainer(node){
    for(const [id,entry] of cards)if(entry.card.contains?.(node))return {card:id};
    const section=node.closest?.('[id^="insuranceCondition-"]');
    return section?{section:section.id}:null;
  }
  function resolveContainer(key){return key?.card?cards.get(key.card)?.card:key?.section?$(key.section):null;}
  function captureContext(){
    readingContext=null;
    if(!contextReady()||contextView.hidden)return false;
    const bounds=readingBounds(),nodes=Array.from(contextView.querySelectorAll('h1,h2,h3,p,summary,button,select,a'));
    // The sticky controls are not the text the user was reading underneath them.
    const anchor=nodes.filter(node=>!node.disabled&&!node.closest?.('.insurance-selection,.insurance-comparison-tools')&&onReadingScreen(node,bounds))
      .sort((a,b)=>Math.abs(Math.max(readingRect(a).top,bounds.top)-bounds.top)-Math.abs(Math.max(readingRect(b).top,bounds.top)-bounds.top))[0];
    if(!anchor)return false;
    const active=contextView.contains(document.activeElement)?document.activeElement:lastReadingFocus;
    // A nav click already moved activeElement; a previous control is useful only while still visible.
    const focus=visibleReadingFocus(active,bounds)?active:null;
    readingContext={anchor,container:contextContainer(anchor),offset:readingRect(anchor).top-bounds.top,inset:bounds.top,focus,
      width:contextView.getBoundingClientRect().width,height:window.innerHeight,comparison:!$('insuranceComparison').hidden};
    return true;
  }
  function restoreContext(){
    if(!readingContext||!contextReady()||contextView.hidden||readingContext.comparison!==!$('insuranceComparison').hidden)return false;
    const saved=readingContext;
    let anchor=saved.anchor;
    if(!readingRect(anchor)){
      const container=resolveContainer(saved.container);
      anchor=container?.querySelector?.('h2,h3,summary')||container;
    }
    const rect=readingRect(anchor);if(!rect)return false;
    const sameLayout=Math.abs(contextView.getBoundingClientRect().width-saved.width)<1&&window.innerHeight===saved.height;
    const bounds=readingBounds(true);
    // Near the introductory heading the panel was not stuck yet; do not invent an inset on return.
    if(sameLayout&&anchor===saved.anchor&&saved.inset===0)bounds.top=0;
    // Reflow changes line positions: return to the same paragraph's start, not an obsolete pixel offset.
    const offset=anchor===saved.anchor&&sameLayout?saved.offset:0;
    const desiredTop=Math.min(bounds.bottom-44,bounds.top+offset);
    window.scrollTo({top:Math.max(0,(window.scrollY||0)+rect.top-desiredTop),behavior:'instant'});
    const actualBounds=readingBounds(),focus=visibleReadingFocus(saved.focus,actualBounds)?saved.focus:anchor;
    function focusReadingNode(node){
      if(typeof node?.focus!=='function'||!readingRect(node))return false;
      if(!node.matches?.('button,select,input,textarea,a[href],summary,[tabindex]'))node.setAttribute('tabindex','-1');
      node.focus({preventScroll:true});
      return document.activeElement===node;
    }
    return focusReadingNode(focus)||(focus!==anchor&&focusReadingNode(anchor));
  }
  window.GamarjiInsurance={captureContext,restoreContext};
  function el(tag,text,className){const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n;}
  function benefit(p,b,host){
    host.append(el('p',b.text));
    if(b.condition)host.append(el('p',b.condition,'note'));
    if(b.status==='conflict')host.append(el('p','В источнике есть расхождение — уточните у страховой.','insurance-caution'));
    benefitSource(p,b,host);
  }
  function benefitSource(p,b,host){
    const s=catalog.sources[b.sourceId];
    if(s){const a=el('a','Источник','insurance-source');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label','Источник: '+b.label+', '+p.insurer+' '+p.plan);host.append(a);}
  }
  function source(p,host){
    const s=catalog.sources[p.sourceIds[0]],a=el('a','Условия на сайте');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';host.append(a,el('p','Источник прочитан '+s.checkedOn+'. Дата действия тарифа не установлена.','note'));
  }
  function detail(p,host){
    if(p.priceOptions)for(const v of p.priceOptions)host.append(el('p',(v.scheme==='family_doctor'?'Через семейного врача':'Свободный выбор')+': на сайте от '+v.value+' ₾; период не указан.','note'));
    if(p.id==='ardi-vitamin-a')host.append(el('p','Связанная памятка относится к гражданам Грузии. Не переносим её условия на иностранцев.','note'));
    if(p.minimumChildAge)host.append(el('p','Для линейки указано: с 1 года. Условия страхования ребёнка нужно уточнить.','note'));
    source(p,host);
  }
  function controls(){
    $('insuranceSelectedCount').setAttribute('role','status');
    $('insuranceSelectedCount').textContent=selected.size?'Выбрано '+selected.size+' из 2':'Выберите два плана';
    $('insuranceCompare').disabled=selected.size!==2;
    $('insuranceClear').hidden=!selected.size;
    let chips=$('insuranceSelectedPlans');if(!chips){chips=el('div',null,'insurance-selected-plans');chips.id='insuranceSelectedPlans';$('insuranceSelectedCount').after(chips);}
    chips.replaceChildren();
    for(const p of catalog.products.filter(p=>selected.has(p.id))){const b=el('button',p.insurer+' · '+p.plan+' — убрать','text-button');b.setAttribute('aria-label','Убрать из сравнения: '+p.insurer+' '+p.plan);b.addEventListener('click',()=>{selected.delete(p.id);syncSelection();const target=$('insuranceList').querySelector('[data-plan="'+p.id+'"]'),entry=cards.get(p.id);(target?(entry.details.open?target:entry.summary):$('insuranceCompany')).focus();});chips.append(b);}
  }
  function syncSelection(){
    for(const p of catalog.products){
      const entry=cards.get(p.id);if(!entry)continue;
      const b=entry.button,chosen=selected.has(p.id);
      b.textContent=chosen?'Убрать из сравнения':'В сравнение';
      b.setAttribute('aria-pressed',String(chosen));
      b.setAttribute('aria-label',b.textContent+': '+p.insurer+' '+p.plan);
      b.disabled=selected.size===2&&!chosen;
      entry.badge.hidden=!chosen;
    }
    controls();
  }
  function render(){
    if(!catalog)return;
    const host=$('insuranceList');host.replaceChildren();
    const rows=catalog.products.filter(p=>!$('insuranceCompany').value||p.insurer===$('insuranceCompany').value);
    const n=rows.length,word=n%100>=11&&n%100<=14?'планов':n%10===1?'план':n%10>=2&&n%10<=4?'плана':'планов';
    $('insuranceStatus').textContent=n+' '+word+' · опубликованные условия';
    for(const p of rows){
      if(cards.has(p.id)){host.append(cards.get(p.id).card);continue;}
      const card=el('article',null,'insurance-card');card.append(el('h2',p.insurer+' · '+p.plan),el('p',C.caution(p),'insurance-caution'));
      const conflicts=(p.benefits||[]).filter(b=>b.status==='conflict');
      if(conflicts.length)card.append(el('p','Есть расхождения: '+conflicts.map(b=>b.label).join(', ')+'. Уточните у страховой.','insurance-caution'));
      card.append(el('p',C.priceText(p),'insurance-price'),el('p','Цена на сайте, не персональный расчёт.','note'));
      const badge=el('p','В сравнении','insurance-chosen');badge.hidden=!selected.has(p.id);card.append(badge);
      const more=el('details',null,'insurance-card-details'),summary=el('summary','Условия и сравнение');
      summary.setAttribute('aria-label','Условия и сравнение: '+p.insurer+' '+p.plan);
      more.append(summary);card.append(more);
      for(const [id,label] of previewBenefits){
        const b=(p.benefits||[]).find(item=>item.id===id);
        if(!b){more.append(el('p',label+': Нет проверенных данных.','insurance-preview'));continue;}
        more.append(el('p',b.label+': '+b.text,'insurance-preview'));if(b.condition)more.append(el('p',b.condition,'note'));if(b.status==='conflict')more.append(el('p','В источнике есть расхождение — уточните у страховой.','insurance-caution'));
        benefitSource(p,b,more);
      }
      if((p.benefits||[]).some(b=>b.percentageMeaning==='as_published_not_payout_quote'))more.append(el('p','Проценты — как в источнике, не расчёт вашей доплаты. Период лимита уточните в договоре.','note'));
      const waiting=(p.benefits||[]).find(b=>b.id==='waiting_periods');
      if(waiting){const section=el('section',null,'insurance-benefit');section.append(el('h3',waiting.label));benefit(p,waiting,section);more.append(section);}
      detail(p,more);
      const b=el('button',selected.has(p.id)?'Убрать из сравнения':'В сравнение','secondary');b.dataset.plan=p.id;b.setAttribute('aria-pressed',String(selected.has(p.id)));b.setAttribute('aria-label',b.textContent+': '+p.insurer+' '+p.plan);b.disabled=selected.size===2&&!selected.has(p.id);
      b.addEventListener('click',()=>{if(!selected.has(p.id)&&selected.size>=2)return;selected.has(p.id)?selected.delete(p.id):selected.add(p.id);syncSelection();});more.append(b);
      // Each benefit is presented once; there is no second, nested disclosure.
      for(const item of p.benefits||[]){if(item.id==='waiting_periods'||previewBenefits.some(([id])=>id===item.id))continue;const section=el('section',null,'insurance-benefit');section.append(el('h3',item.label));benefit(p,item,section);more.append(section);}
      const close=el('button','Свернуть условия','text-button');close.setAttribute('aria-label','Свернуть условия: '+p.insurer+' '+p.plan);close.addEventListener('click',()=>{more.open=false;summary.focus({preventScroll:true});card.scrollIntoView({block:'start'});});more.append(close);
      cards.set(p.id,{card,button:b,details:more,summary,badge});host.append(card);
    }
    syncSelection();
  }
  function browseVisible(show){$('insuranceBrowseIntro').hidden=!show;$('insuranceSelection').hidden=!show;$('insuranceList').hidden=!show;$('insuranceView').setAttribute('aria-labelledby',show?'insuranceHeading':'insuranceCompareHeading');}
  function back(){ $('insuranceComparison').hidden=true;browseVisible(true);$('insuranceCompany').disabled=false;render();$('insuranceCompare').focus(); }
  $('insuranceCompany').addEventListener('change',render);
  $('insuranceClear').addEventListener('click',()=>{selected.clear();syncSelection();$('insuranceCompany').focus();});
  $('insuranceBack').addEventListener('click',back);
  $('insuranceJump').addEventListener('change',()=>{
    const key=$('insuranceJump').value,target=key&&$('insuranceCondition-'+key);
    $('insuranceJump').value='';
    if(target){target.focus({preventScroll:true});target.scrollIntoView({block:'start'});}
  });
  function compare(focusHeading=true){
    if(selected.size!==2)return;
    const host=$('insuranceComparisonRows');host.replaceChildren();
    const plans=Array.from(selected,id=>catalog.products.find(p=>p.id===id));
    const jump=$('insuranceJump'),placeholder=el('option','К условию…');placeholder.value='';jump.replaceChildren(placeholder);jump.value='';jump.disabled=false;
    function topic(section,key,label){
      section.id='insuranceCondition-'+key;section.tabIndex=-1;
      const option=el('option',label);option.value=key;jump.append(option);
    }
    const selectors=el('div',null,'insurance-plan-selectors');
    plans.forEach((p,i)=>{const cell=el('div'),label=el('label','План '+(i+1)),select=el('select');select.id='insurancePlan'+i;label.htmlFor=select.id;for(const optionPlan of catalog.products){const option=el('option',optionPlan.insurer+' · '+optionPlan.plan);option.value=optionPlan.id;option.selected=optionPlan.id===p.id;option.disabled=optionPlan.id===plans[1-i].id;select.append(option);}select.addEventListener('change',()=>{selected=new Set(plans.map((plan,index)=>index===i?select.value:plan.id));controls();compare(false);$('insurancePlan'+i).focus();});cell.append(label,select,el('p',p.insurer+' · '+p.plan,'insurance-plan-name'));selectors.append(cell);});host.append(selectors,el('p','Сравниваем опубликованные условия. Приём иностранцев, семейную цену и клиники Батуми уточните у страховой.','note'));
    host.append(el('p','Проценты и лимиты приведены как в источнике — это не расчёт вашей доплаты. Лимиты нельзя складывать; период и применимость уточняются по договору.','note'));
    for(const [key,name,get] of [['restrictions','Важные ограничения',C.caution],['price','Опубликованная цена',C.priceText]]){
      const section=el('section',null,'insurance-compare-row');section.append(el('h2',name));
      topic(section,key,name);
      for(const p of plans){const cell=el('div');cell.append(el('strong',p.insurer+' · '+p.plan),el('p',get(p)));section.append(cell);}host.append(section);
    }
    const benefits=new Map();for(const p of plans)for(const b of p.benefits||[])if(!benefits.has(b.id))benefits.set(b.id,b.label);
    const orderedBenefits=[...benefitOrder,...Array.from(benefits.keys()).filter(id=>!benefitOrder.includes(id)).sort()].filter(id=>benefits.has(id));
    if(!benefits.size)host.append(el('p','Подробные условия этих планов пока не проверены. Сравнение покрытия недоступно.','insurance-caution'));
    for(const id of orderedBenefits){const section=el('section',null,'insurance-compare-row');section.append(el('h2',benefits.get(id)));topic(section,id,benefits.get(id));for(const p of plans){const cell=el('div');cell.append(el('strong',p.insurer+' · '+p.plan));const b=(p.benefits||[]).find(item=>item.id===id);if(b)benefit(p,b,cell);else cell.append(el('p','Пока нет проверенных данных. Это не означает, что услуга исключена.','note'));section.append(cell);}host.append(section);}
    const sources=el('div',null,'insurance-comparison-sources');topic(sources,'sources','Источники');sources.append(el('h2','Источники'));
    for(const p of plans){const item=el('details',null,'insurance-source-details');item.append(el('summary','Ограничения и источник: '+p.insurer+' · '+p.plan));detail(p,item);sources.append(item);}host.append(sources);
    $('insuranceComparison').hidden=false;browseVisible(false);$('insuranceCompany').disabled=true;if(focusHeading){$('insuranceCompareHeading').focus();$('insuranceComparison').scrollIntoView({block:'start'});}
  }
  $('insuranceCompare').addEventListener('click',()=>compare());
  async function load(){
    if(busy)return;busy=true;$('insuranceRetry').hidden=true;$('insuranceStatus').textContent='Загрузка справочника…';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{if(!C)throw Error('module');const response=await fetch('./insurance-data.json',{signal:controller.signal,cache:'no-cache'});if(!response.ok)throw Error('network');catalog=C.validate(await response.json());cards.clear();selected=new Set([...selected].filter(id=>catalog.products.some(p=>p.id===id)));render();}
    catch{catalog=null;$('insuranceStatus').textContent='Не удалось загрузить проверенный справочник. Обмен и калькулятор доступны.';$('insuranceRetry').hidden=false;}
    finally{clearTimeout(timer);busy=false;}
  }
  $('insuranceRetry').addEventListener('click',load);load();
})();
