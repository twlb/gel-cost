(()=>{
  'use strict';
  const $=id=>document.getElementById(id),C=window.InsuranceCore;
  let catalog=null,selected=new Set(),busy=false;
  function el(tag,text,className){const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n;}
  function source(p,host){
    const s=catalog.sources[p.sourceIds[0]],a=el('a','Условия на сайте');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';host.append(a,el('p','Источник прочитан '+s.checkedOn+'. Дата действия тарифа не установлена.','note'));
  }
  function detail(p,host){
    host.append(el('p',C.caution(p),'insurance-caution'));
    if(p.priceOptions)for(const v of p.priceOptions)host.append(el('p',(v.scheme==='family_doctor'?'Через семейного врача':'Свободный выбор')+': на сайте от '+v.value+' ₾; период не указан.','note'));
    if(p.id==='ardi-vitamin-a')host.append(el('p','Связанная памятка относится к гражданам Грузии. Не переносим её условия на иностранцев.','note'));
    if(p.minimumChildAge)host.append(el('p','Для линейки указано: с 1 года. Условия страхования ребёнка нужно уточнить.','note'));
    source(p,host);
  }
  function controls(){
    $('insuranceSelectedCount').textContent=selected.size?'Выбрано '+selected.size+' из 2: '+catalog.products.filter(p=>selected.has(p.id)).map(p=>p.insurer+' '+p.plan).join(', '):'Выберите два плана';
    $('insuranceCompare').disabled=selected.size!==2;
    $('insuranceClear').hidden=!selected.size;
  }
  function render(){
    if(!catalog)return;
    const host=$('insuranceList');host.replaceChildren();
    const rows=catalog.products.filter(p=>!$('insuranceCompany').value||p.insurer===$('insuranceCompany').value);
    for(const p of rows){
      const card=el('article',null,'insurance-card');card.append(el('h2',p.insurer+' · '+p.plan),el('p',C.priceText(p),'insurance-price'),el('p','Цена на сайте, не персональный расчёт.','note'));
      const more=el('details'),summary=el('summary','Условия и источник');more.append(summary);detail(p,more);card.append(more);
      const b=el('button',selected.has(p.id)?'Убрать из сравнения':'В сравнение','secondary');b.dataset.plan=p.id;b.setAttribute('aria-pressed',String(selected.has(p.id)));b.setAttribute('aria-label',b.textContent+': '+p.insurer+' '+p.plan);b.disabled=selected.size===2&&!selected.has(p.id);
      b.addEventListener('click',()=>{selected.has(p.id)?selected.delete(p.id):selected.add(p.id);render();host.querySelector('[data-plan="'+p.id+'"]')?.focus({preventScroll:true});});card.append(b);host.append(card);
    }
    controls();
  }
  function back(){ $('insuranceComparison').hidden=true;$('insuranceList').hidden=false;$('insuranceCompany').disabled=false;$('insuranceCompare').focus(); }
  $('insuranceCompany').addEventListener('change',render);
  $('insuranceClear').addEventListener('click',()=>{selected.clear();back();render();$('insuranceCompany').focus();});
  $('insuranceBack').addEventListener('click',back);
  $('insuranceCompare').addEventListener('click',()=>{
    if(selected.size!==2)return;
    const host=$('insuranceComparisonRows');host.replaceChildren();
    const plans=catalog.products.filter(p=>selected.has(p.id));
    for(const [name,get] of [['Опубликованная цена',C.priceText],['Приём иностранцев',()=> 'Нужно уточнить'],['Клиники Батуми',()=> 'Не подтверждены для пакета'],['Важные ограничения',C.caution]]){
      const section=el('section',null,'insurance-compare-row');section.append(el('h3',name));
      for(const p of plans){const cell=el('div');cell.append(el('strong',p.insurer+' · '+p.plan),el('p',get(p)));section.append(cell);}host.append(section);
    }
    for(const p of plans){const item=el('section',null,'insurance-compare-row');item.append(el('h3',p.insurer+' · '+p.plan));detail(p,item);host.append(item);}
    $('insuranceComparison').hidden=false;$('insuranceList').hidden=true;$('insuranceCompany').disabled=true;$('insuranceCompareHeading').focus();
  });
  async function load(){
    if(busy)return;busy=true;$('insuranceRetry').hidden=true;$('insuranceStatus').textContent='Загрузка справочника…';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{if(!C)throw Error('module');const response=await fetch('./insurance-data.json',{signal:controller.signal,cache:'no-cache'});if(!response.ok)throw Error('network');catalog=C.validate(await response.json());$('insuranceStatus').textContent='15 планов · справочная версия · без расчёта семейной цены';render();}
    catch{catalog=null;$('insuranceStatus').textContent='Не удалось загрузить проверенный справочник. Обмен и калькулятор доступны.';$('insuranceRetry').hidden=false;}
    finally{clearTimeout(timer);busy=false;}
  }
  $('insuranceRetry').addEventListener('click',load);load();
})();
