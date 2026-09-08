(()=>{
  'use strict';
  const $=id=>document.getElementById(id),C=window.InsuranceCore;
  const previewBenefits=[['outpatient','Приёмы и анализы'],['emergency_hospital','Экстренный стационар']];
  const benefitOrder=['waiting_periods','approval','outpatient','medications','emergency_hospital','planned_hospital','dental','children'];
  let catalog=null,selected=new Set(),busy=false;
  function el(tag,text,className){const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n;}
  function benefit(p,b,host){
    host.append(el('p',b.text));
    if(b.condition)host.append(el('p',b.condition,'note'));
    if(b.status==='conflict')host.append(el('p','В источнике есть расхождение — уточните у страховой.','insurance-caution'));
    const s=catalog.sources[b.sourceId];
    if(s){const a=el('a','Источник','insurance-source');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label','Источник: '+b.label+', '+p.insurer+' '+p.plan);host.append(a);}
  }
  function source(p,host){
    const s=catalog.sources[p.sourceIds[0]],a=el('a','Условия на сайте');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';host.append(a,el('p','Источник прочитан '+s.checkedOn+'. Дата действия тарифа не установлена.','note'));
  }
  function detail(p,host,includeBenefits=true){
    if(p.priceOptions)for(const v of p.priceOptions)host.append(el('p',(v.scheme==='family_doctor'?'Через семейного врача':'Свободный выбор')+': на сайте от '+v.value+' ₾; период не указан.','note'));
    if(p.id==='ardi-vitamin-a')host.append(el('p','Связанная памятка относится к гражданам Грузии. Не переносим её условия на иностранцев.','note'));
    if(p.minimumChildAge)host.append(el('p','Для линейки указано: с 1 года. Условия страхования ребёнка нужно уточнить.','note'));
    if(includeBenefits)for(const b of p.benefits||[]){const section=el('section',null,'insurance-benefit');section.append(el('h3',b.label));benefit(p,b,section);host.append(section);}
    source(p,host);
  }
  function controls(){
    $('insuranceSelectedCount').setAttribute('role','status');
    $('insuranceSelectedCount').textContent=selected.size?'Выбрано '+selected.size+' из 2':'Выберите два плана';
    $('insuranceCompare').disabled=selected.size!==2;
    $('insuranceClear').hidden=!selected.size;
    let chips=$('insuranceSelectedPlans');if(!chips){chips=el('div',null,'insurance-selected-plans');chips.id='insuranceSelectedPlans';$('insuranceSelectedCount').after(chips);}
    chips.replaceChildren();
    for(const p of catalog.products.filter(p=>selected.has(p.id))){const b=el('button',p.insurer+' · '+p.plan+' — убрать','text-button');b.setAttribute('aria-label','Убрать из сравнения: '+p.insurer+' '+p.plan);b.addEventListener('click',()=>{selected.delete(p.id);render();$('insuranceCompare').disabled?$('insuranceCompany').focus():$('insuranceCompare').focus();});chips.append(b);}
  }
  function render(){
    if(!catalog)return;
    const host=$('insuranceList');host.replaceChildren();
    const rows=catalog.products.filter(p=>!$('insuranceCompany').value||p.insurer===$('insuranceCompany').value);
    for(const p of rows){
      const card=el('article',null,'insurance-card');card.append(el('h2',p.insurer+' · '+p.plan),el('p',C.caution(p),'insurance-caution'));
      const conflicts=(p.benefits||[]).filter(b=>b.status==='conflict');
      if(conflicts.length)card.append(el('p','Есть расхождения: '+conflicts.map(b=>b.label).join(', ')+'. Уточните у страховой.','insurance-caution'));
      card.append(el('p',C.priceText(p),'insurance-price'),el('p','Цена на сайте, не персональный расчёт.','note'));
      for(const [id,label] of previewBenefits){
        const b=(p.benefits||[]).find(item=>item.id===id);
        if(!b){card.append(el('p',label+': Нет проверенных данных.','insurance-preview'));continue;}
        card.append(el('p',b.label+': '+b.text,'insurance-preview'));if(b.condition)card.append(el('p',b.condition,'note'));if(b.status==='conflict')card.append(el('p','Данные источника расходятся. Подробности в условиях.','insurance-caution'));
      }
      if((p.benefits||[]).some(b=>b.percentageMeaning==='as_published_not_payout_quote'))card.append(el('p','Проценты — как в источнике, не расчёт вашей доплаты. Период лимита уточните в договоре.','note'));
      const waiting=(p.benefits||[]).find(b=>b.id==='waiting_periods');
      if(waiting){const section=el('section',null,'insurance-benefit');section.append(el('h3',waiting.label));benefit(p,waiting,section);card.append(section);}
      const b=el('button',selected.has(p.id)?'Убрать из сравнения':'В сравнение','secondary');b.dataset.plan=p.id;b.setAttribute('aria-pressed',String(selected.has(p.id)));b.setAttribute('aria-label',b.textContent+': '+p.insurer+' '+p.plan);b.disabled=selected.size===2&&!selected.has(p.id);
      b.addEventListener('click',()=>{selected.has(p.id)?selected.delete(p.id):selected.add(p.id);render();host.querySelector('[data-plan="'+p.id+'"]')?.focus({preventScroll:true});});card.append(b);
      const more=el('details'),summary=el('summary','Условия и источник');more.append(summary);detail(p,more);card.append(more);host.append(card);
    }
    controls();
  }
  function browseVisible(show){$('insuranceBrowseIntro').hidden=!show;$('insuranceSelection').hidden=!show;$('insuranceList').hidden=!show;$('insuranceView').setAttribute('aria-labelledby',show?'insuranceHeading':'insuranceCompareHeading');}
  function back(){ $('insuranceComparison').hidden=true;browseVisible(true);$('insuranceCompany').disabled=false;render();$('insuranceCompare').focus(); }
  $('insuranceCompany').addEventListener('change',render);
  $('insuranceClear').addEventListener('click',()=>{selected.clear();back();render();$('insuranceCompany').focus();});
  $('insuranceBack').addEventListener('click',back);
  function compare(focusHeading=true){
    if(selected.size!==2)return;
    const host=$('insuranceComparisonRows');host.replaceChildren();
    const plans=Array.from(selected,id=>catalog.products.find(p=>p.id===id));
    const selectors=el('div',null,'insurance-plan-selectors');
    plans.forEach((p,i)=>{const cell=el('div'),label=el('label','План '+(i+1)),select=el('select');select.id='insurancePlan'+i;label.htmlFor=select.id;for(const optionPlan of catalog.products){const option=el('option',optionPlan.insurer+' · '+optionPlan.plan);option.value=optionPlan.id;option.selected=optionPlan.id===p.id;option.disabled=optionPlan.id===plans[1-i].id;select.append(option);}select.addEventListener('change',()=>{selected=new Set(plans.map((plan,index)=>index===i?select.value:plan.id));controls();compare(false);$('insurancePlan'+i).focus();});cell.append(label,select,el('p',p.insurer+' · '+p.plan,'insurance-plan-name'));selectors.append(cell);});host.append(selectors,el('p','Сравниваем опубликованные условия. Приём иностранцев, семейную цену и клиники Батуми уточните у страховой.','note'));
    host.append(el('p','Проценты и лимиты приведены как в источнике — это не расчёт вашей доплаты. Лимиты нельзя складывать; период и применимость уточняются по договору.','note'));
    for(const [name,get] of [['Важные ограничения',C.caution],['Опубликованная цена',C.priceText]]){
      const section=el('section',null,'insurance-compare-row');section.append(el('h3',name));
      for(const p of plans){const cell=el('div');cell.append(el('strong',p.insurer+' · '+p.plan),el('p',get(p)));section.append(cell);}host.append(section);
    }
    const benefits=new Map();for(const p of plans)for(const b of p.benefits||[])if(!benefits.has(b.id))benefits.set(b.id,b.label);
    const orderedBenefits=[...benefitOrder,...Array.from(benefits.keys()).filter(id=>!benefitOrder.includes(id)).sort()].filter(id=>benefits.has(id));
    if(!benefits.size)host.append(el('p','Подробные условия этих планов пока не проверены. Сравнение покрытия недоступно.','insurance-caution'));
    for(const id of orderedBenefits){const section=el('section',null,'insurance-compare-row');section.append(el('h3',benefits.get(id)));for(const p of plans){const cell=el('div');cell.append(el('strong',p.insurer+' · '+p.plan));const b=(p.benefits||[]).find(item=>item.id===id);if(b)benefit(p,b,cell);else cell.append(el('p','Пока нет проверенных данных. Это не означает, что услуга исключена.','note'));section.append(cell);}host.append(section);}
    for(const p of plans){const item=el('details',null,'insurance-source-details');item.append(el('summary','Ограничения и источник: '+p.insurer+' · '+p.plan));detail(p,item,false);host.append(item);}
    $('insuranceComparison').hidden=false;browseVisible(false);$('insuranceCompany').disabled=true;if(focusHeading){$('insuranceCompareHeading').focus();$('insuranceComparison').scrollIntoView({block:'start'});}
  }
  $('insuranceCompare').addEventListener('click',()=>compare());
  async function load(){
    if(busy)return;busy=true;$('insuranceRetry').hidden=true;$('insuranceStatus').textContent='Загрузка справочника…';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{if(!C)throw Error('module');const response=await fetch('./insurance-data.json',{signal:controller.signal,cache:'no-cache'});if(!response.ok)throw Error('network');catalog=C.validate(await response.json());$('insuranceStatus').textContent=catalog.products.length+' планов · опубликованные условия';render();}
    catch{catalog=null;$('insuranceStatus').textContent='Не удалось загрузить проверенный справочник. Обмен и калькулятор доступны.';$('insuranceRetry').hidden=false;}
    finally{clearTimeout(timer);busy=false;}
  }
  $('insuranceRetry').addEventListener('click',load);load();
})();
