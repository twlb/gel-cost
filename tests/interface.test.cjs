// Structural and lightweight DOM regression checks. These are not browser/visual QA.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const C=require('../insurance-core.js');
const catalogue=require('../insurance-data.json');
const block=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end));

test('HTML keeps unique IDs and one complete planner feedback block before editable steps',()=>{
  const ids=Array.from(html.matchAll(/\bid="([^"]+)"/g),m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,'Moving UI must not clone bound IDs');
  const planner=block('<section id="calculatorView"','<section id="purchaseView"');
  assert.ok(planner.indexOf('id="planPath"')<planner.indexOf('class="plan-feedback"'));
  assert.ok(planner.indexOf('class="plan-feedback"')<planner.indexOf('id="planStep0"'));
  const feedback=planner.slice(planner.indexOf('class="plan-feedback"'),planner.indexOf('id="planStep0"'));
  for(const id of ['planResultBox','planResultLabel','planResult','planNext','planRounding','planError','planCaution'])assert.ok(feedback.includes('id="'+id+'"'),id+' must move with feedback');
  assert.equal((html.match(/id="planResultBox"/g)||[]).length,1);
});

test('personal data remains reachable from calculator and exchange with an explicit return',()=>{
  const header=block('<header>','</header>');assert.ok(!header.includes('id="dataNav"'));
  const planner=block('<section id="calculatorView"','<section id="purchaseView"');
  assert.match(planner,/<button[^>]+id="dataNav"[^>]+onclick="showView\('data'\)"/);
  const data=block('<section id="dataView"','<section id="insuranceView"');
  assert.match(data,/<button[^>]+id="returnDataCalculator"[^>]+onclick="showView\('calculator'\)"/);
  const legacy=block('<details class="disclosure" id="legacyOfferDetails"','<p class="footnote">Перед поездкой');
  assert.match(legacy,/showView\('(?:data|purchase)'\)/);
  for(const action of ['exportData()','resetPeriod(','openSettings(','openPurchase('])assert.ok(data.includes(action),action+' remains accessible');
});

class Node {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attrs={};this.events={};this.hidden=false;this.disabled=false;this.value='';this._text='';this.className='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  after(node){if(this.parentElement){const list=this.parentElement.children;list.splice(list.indexOf(this)+1,0,node);node.parentElement=this.parentElement;}else this.append(node);}
  setAttribute(k,v){this.attrs[k]=String(v);}
  addEventListener(k,fn){this.events[k]=fn;}
  focus(){this.focused=true;}
  scrollIntoView(options){this.scrolled=options;}
  querySelector(selector){const id=selector.match(/data-plan="([^"]+)"/)?.[1];return walk(this).find(n=>n.dataset.plan===id);}
}
function walk(n){return [n,...n.children.flatMap(walk)];}
const cardDetails=card=>card.children.find(n=>n.tagName==='DETAILS');
async function insurance(data=catalogue,options={}){
  const roots=Array.from(html.matchAll(/\bid="([^"]+)"/g),m=>{const n=new Node();n.id=m[1];return n;});
  const get=id=>roots.flatMap(walk).find(n=>n.id===id);
  get('insuranceCompany').disabled=true;get('insuranceSelection').hidden=true;get('insuranceRetry').hidden=true;
  get('insuranceStatus').textContent='Раздел страховок не загрузился.';
  get('insuranceSelection').append(get('insuranceSelectedCount'),get('insuranceCompare'),get('insuranceClear'));
  const ctx={window:{InsuranceCore:options.missingCore?undefined:C},document:{getElementById:get,createElement:tag=>new Node(tag)},fetch:async()=>({ok:!options.fetchError,json:async()=>structuredClone(data)}),AbortController,setTimeout:()=>1,clearTimeout:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'insurance.js'),'utf8'),ctx);
  await new Promise(resolve=>setImmediate(resolve));
  const cards=()=>get('insuranceList').children;
  const choose=id=>{const button=cards().flatMap(walk).find(n=>n.dataset.plan===id);assert.ok(button);assert.equal(button.disabled,false);button.events.click();};
  return {get,cards,choose};
}

test('missing insurance script has a truthful static fallback and a working page reload action',()=>{
  const section=block('<section id="insuranceView"','</main>');
  assert.match(section,/<p id="insuranceStatus"[^>]*>Раздел страховок не загрузился\./);
  assert.match(section,/<button id="insuranceReload"[^>]*onclick="window\.location\.reload\(\)"[^>]*>Обновить страницу<\/button>/);
  assert.match(section,/<select id="insuranceCompany" disabled>/);
  assert.match(section,/<div id="insuranceSelection"[^>]* hidden>/);
});

test('insurance module replaces static fallback only with genuine loading, data error or loaded controls',async()=>{
  const a=await insurance();
  assert.equal(a.get('insuranceReload').hidden,true);
  assert.equal(a.get('insuranceCompany').disabled,false);
  assert.equal(a.get('insuranceSelection').hidden,false);
  assert.match(a.get('insuranceStatus').textContent,/15 планов/);
  const failed=await insurance(catalogue,{fetchError:true});
  assert.equal(failed.get('insuranceReload').hidden,true);
  assert.equal(failed.get('insuranceCompany').disabled,true);
  assert.equal(failed.get('insuranceSelection').hidden,true);
  assert.equal(failed.get('insuranceRetry').hidden,false);
  assert.match(failed.get('insuranceStatus').textContent,/Не удалось загрузить/);
  const missingCore=await insurance(catalogue,{missingCore:true});
  assert.equal(missingCore.get('insuranceReload').hidden,false);
  assert.equal(missingCore.get('insuranceRetry').hidden,true);
  assert.equal(missingCore.get('insuranceCompany').disabled,true);
  assert.equal(missingCore.get('insuranceSelection').hidden,true);
  assert.match(missingCore.get('insuranceStatus').textContent,/Раздел страховок не загрузился/);
});

test('insurance selection preserves card nodes and expanded conditions while updating every button',async()=>{
  const a=await insurance(),cards=[...a.cards()];
  const details=cards[0].children.find(n=>n.tagName==='DETAILS');details.open=true;
  a.choose('unison-classic');a.choose('unison-premium');
  cards.forEach((card,i)=>assert.ok(a.cards()[i]===card,'Selection must not replace a card being read'));
  assert.equal(details.open,true);
  const button=id=>a.cards().flatMap(walk).find(n=>n.dataset.plan===id);
  assert.equal(button('unison-classic').attrs['aria-pressed'],'true');
  assert.equal(button('unison-advance').disabled,true);
  a.choose('unison-classic');
  assert.equal(button('unison-classic').attrs['aria-pressed'],'false');
  assert.equal(button('unison-advance').disabled,false);
  assert.ok(a.cards()[0]===cards[0]);assert.equal(details.open,true);
});

test('insurance filtering shows the visible count and restores expanded conditions',async()=>{
  const a=await insurance(),classic=a.cards()[0],details=classic.children.find(n=>n.tagName==='DETAILS');
  details.open=true;a.choose('unison-classic');
  for(const [company,count,text] of [['ARDI',5,'5 планов'],['GPI Holding',3,'3 плана'],['Unison',7,'7 планов'],['',15,'15 планов']]){
    a.get('insuranceCompany').value=company;a.get('insuranceCompany').events.change();
    assert.equal(a.cards().length,count);assert.equal(a.get('insuranceStatus').textContent,text+' · опубликованные условия');
    assert.equal(a.get('insuranceSelectedCount').textContent,'Выбрано 1 из 2');
  }
  assert.ok(a.cards()[0]===classic);assert.equal(classic.children.find(n=>n.tagName==='DETAILS').open,true);
});

test('comparison, replacement and clear preserve the catalogue reading state',async()=>{
  const a=await insurance(),classic=a.cards()[0],details=classic.children.find(n=>n.tagName==='DETAILS');details.open=true;
  a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  a.get('insurancePlan1').value='gpi-medi-classic';a.get('insurancePlan1').events.change();
  a.get('insuranceBack').events.click();
  assert.ok(a.cards()[0]===classic);assert.equal(details.open,true);
  a.get('insuranceClear').events.click();
  assert.ok(a.cards()[0]===classic);assert.equal(details.open,true);assert.equal(a.get('insuranceCompare').disabled,true);
  // Closing is deliberate state too: selection must not force conditions open.
  details.open=false;a.choose('unison-classic');assert.equal(details.open,false);
});

test('comparison topic navigation reaches every visible criterion and refreshes after plan replacement',async()=>{
  const a=await insurance();a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const jump=a.get('insuranceJump');assert.ok(jump,'Comparison needs a labelled topic control');
  const keys=()=>jump.children.filter(n=>n.value).map(n=>n.value);
  for(const key of ['restrictions','price','waiting_periods','outpatient','medications','sources'])assert.ok(keys().includes(key),key);
  assert.equal(new Set(keys()).size,keys().length);
  for(const key of keys())assert.equal(a.get('insuranceCondition-'+key).children[0].tagName,'H2','Comparison criteria follow its H1 without skipping a heading level');
  jump.value='medications';jump.events.change();
  assert.equal(a.get('insuranceCondition-medications').focused,true);
  assert.equal(a.get('insuranceCondition-medications').scrolled.block,'start');
  assert.equal(jump.value,'','Topic selector can be reused for the same destination');
  a.get('insurancePlan1').value='gpi-medi-classic';a.get('insurancePlan1').events.change();
  assert.ok(keys().includes('approval'),'New plan brings its approval criterion');
  jump.value='approval';jump.events.change();
  assert.equal(a.get('insuranceCondition-approval').focused,true);
});

test('unknown insurance details do not acquire fabricated topics or prices',async()=>{
  const a=await insurance();a.choose('ardi-vitamin-a');a.choose('ardi-vitamin-b');a.get('insuranceCompare').events.click();
  const keys=a.get('insuranceJump').children.filter(n=>n.value).map(n=>n.value);
  assert.deepEqual(keys,['restrictions','price','sources']);
  assert.match(a.get('insuranceComparisonRows').textContent,/Сравнение покрытия недоступно/);
  assert.match(a.get('insuranceCondition-price').textContent,/Период цены не подтверждён/);
  a.get('insuranceJump').value='missing';assert.doesNotThrow(()=>a.get('insuranceJump').events.change());
});

test('waiting periods remain before card selection but are not repeated inside expanded details',async()=>{
  const a=await insurance();
  for(const [i,p] of catalogue.products.entries()){
    const waiting=p.benefits?.find(b=>b.id==='waiting_periods');if(!waiting)continue;
    const card=a.cards()[i],texts=walk(card).filter(n=>n.tagName==='P').map(n=>n._text);
    assert.equal(texts.filter(text=>text===waiting.text).length,1,p.id+': no duplicate waiting paragraph');
    assert.equal(texts.filter(text=>text===waiting.condition).length,1,p.id+': complete scope once');
  }
});

test('compact cards retain warnings outside disclosure and full preview scope before selection inside it',async()=>{
  const original=JSON.stringify(catalogue),a=await insurance();
  assert.equal(a.cards().length,catalogue.products.length);
  for(const [i,p] of catalogue.products.entries()){
    const card=a.cards()[i],details=cardDetails(card),cta=details.children.findIndex(n=>n.dataset.plan===p.id);
    assert.ok(cta>0,p.id+': CTA is only available inside expanded conditions');
    assert.equal(card.children.some(n=>n.dataset.plan),false,p.id+': no detached selection button');
    assert.equal(walk(details).filter(n=>n.tagName==='DETAILS').length,1,p.id+': one level of disclosure');
    assert.ok(card.children.filter(n=>n.tagName!=='DETAILS').map(n=>n.textContent).join('\n').includes(C.caution(p)),p.id+': important caution remains outside disclosure');
    const before=details.children.slice(0,cta),summary=before.map(n=>n.textContent).join('\n');
    const previews=before.filter(n=>n.className.includes('insurance-preview'));
    assert.equal(previews.length,2,p.id+': exactly two comparable service previews');
    for(const [j,id] of ['outpatient','emergency_hospital'].entries()){
      const benefit=(p.benefits||[]).find(b=>b.id===id);
      if(benefit){assert.ok(previews[j].textContent.includes(benefit.text),p.id+': '+id);if(benefit.condition)assert.ok(summary.includes(benefit.condition),p.id+': preserves condition');}
      else assert.match(previews[j].textContent,/нет проверенных данных/i,p.id+': explicit unknown');
    }
  }
  assert.equal(JSON.stringify(catalogue),original,'Rendering must not mutate catalogue');
});

test('insurance comparison puts restrictions before price and preserves the complete canonical benefit union',async()=>{
  const a=await insurance();a.choose('gpi-medi-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const sections=a.get('insuranceComparisonRows').children.filter(n=>n.tagName==='SECTION');
  assert.equal(sections[0].children[0].textContent,'Важные ограничения');
  assert.equal(sections[1].children[0].textContent,'Опубликованная цена');
  const plans=['gpi-medi-classic','unison-premium'].map(id=>catalogue.products.find(p=>p.id===id));
  const union=new Map();for(const p of plans)for(const b of p.benefits||[])if(!union.has(b.id))union.set(b.id,b.label);
  const fixed=['waiting_periods','approval','outpatient','medications','emergency_hospital','planned_hospital','dental','children'];
  const order=[...fixed.filter(id=>union.has(id)),...Array.from(union.keys()).filter(id=>!fixed.includes(id)).sort()];
  assert.deepEqual(sections.slice(2).map(n=>n.children[0].textContent),order.map(id=>union.get(id)));
  for(const p of plans)for(const b of p.benefits||[]){const text=a.get('insuranceComparisonRows').textContent;assert.ok(text.includes(b.text));if(b.condition)assert.ok(text.includes(b.condition));}
  assert.equal(a.get('insuranceList').hidden,true);assert.equal(a.get('insuranceComparison').hidden,false);
  a.get('insuranceBack').events.click();assert.equal(a.get('insuranceList').hidden,false);assert.equal(a.get('insuranceCompare').disabled,false);
  assert.match(a.get('insuranceSelectedCount').textContent,/2/);
});

test('insurance comparison plan replacement preserves two distinct selections and updates visible conditions',async()=>{
  const a=await insurance();a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const select=a.get('insurancePlan0');assert.ok(select.children.find(n=>n.value==='unison-premium').disabled);
  select.value='gpi-medi-classic';select.events.change();
  assert.ok(a.get('insuranceComparisonRows').textContent.includes('GPI Holding'));
  a.get('insuranceBack').events.click();
  const selected=a.cards().flatMap(walk).filter(n=>n.dataset.plan&&n.attrs['aria-pressed']==='true').map(n=>n.dataset.plan);
  assert.deepEqual(selected.sort(),['gpi-medi-classic','unison-premium'].sort());
});

test('insurance comparison does not discard additional valid service keys outside its fixed order',async()=>{
  const data=structuredClone(catalogue),p=data.products.find(p=>p.id==='unison-classic');
  const template=p.benefits[0];
  p.benefits.push({...template,id:'zzz_test_service',label:'ZZZ fixture service',text:'Synthetic Z condition'}, {...template,id:'aaa_test_service',label:'AAA fixture service',text:'Synthetic A condition'});
  const a=await insurance(data);a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const rows=a.get('insuranceComparisonRows').children.filter(n=>n.tagName==='SECTION');
  const labels=rows.map(n=>n.children[0].textContent);
  assert.ok(labels.indexOf('AAA fixture service')>=0);
  assert.ok(labels.indexOf('ZZZ fixture service')>labels.indexOf('AAA fixture service'));
  assert.ok(a.get('insuranceComparisonRows').textContent.includes('Synthetic A condition'));
  assert.ok(a.get('insuranceComparisonRows').textContent.includes('Synthetic Z condition'));
  const unknownRow=rows.find(n=>n.children[0].textContent==='AAA fixture service');
  assert.match(unknownRow.children[2].textContent,/нет проверенных данных/i);
});

test('Advance waiting-period conflict outside fixed previews is visible before price and selection',async()=>{
  const a=await insurance(),index=catalogue.products.findIndex(p=>p.id==='unison-advance');
  const product=catalogue.products[index],conflict=product.benefits.find(b=>b.id==='waiting_periods');
  assert.equal(conflict.status,'conflict','Fixture must exercise a real non-preview conflict');
  const card=a.cards()[index],price=card.children.findIndex(n=>n.className.includes('insurance-price'));
  const cta=card.children.indexOf(cardDetails(card));
  const visible=card.children.findIndex(n=>n.tagName!=='DETAILS'&&n.className.includes('insurance-caution')&&n.textContent.includes('Есть расхождения:')&&n.textContent.includes(conflict.label));
  assert.ok(visible>=0,'Waiting conflict must be a visible card child, not hidden in details');
  assert.ok(visible<price&&visible<cta,'Conflict appears before price and selection');
  assert.match(card.children[visible].textContent,/Уточните у страховой/);
});

test('cards expose existing waiting periods with their complete scope and source before selection',async()=>{
  const a=await insurance();
  for(const [i,p] of catalogue.products.entries()){
    const waiting=(p.benefits||[]).find(b=>b.id==='waiting_periods');
    const card=cardDetails(a.cards()[i]),cta=card.children.findIndex(n=>n.dataset.plan===p.id);
    const sections=card.children.slice(0,cta).filter(n=>n.tagName==='SECTION');
    if(!waiting){assert.equal(sections.length,0,p.id+': do not invent a waiting period');continue;}
    const section=sections.find(n=>n.children[0]?.textContent===waiting.label);
    assert.ok(section,p.id+': selection cannot be shown without the preceding waiting terms');
    assert.ok(section.children.some(n=>n.textContent===waiting.text),p.id+': full published periods');
    if(waiting.condition)assert.ok(section.children.some(n=>n.textContent===waiting.condition),p.id+': full scope and exceptions');
    assert.ok(walk(section).some(n=>n.tagName==='A'&&n.href===catalogue.sources[waiting.sourceId].url),p.id+': original source retained');
  }
});

test('cards with published percentages explain copayment and limit uncertainty before selection',async()=>{
  const a=await insurance();
  for(const [i,p] of catalogue.products.entries()){
    if(!(p.benefits||[]).some(b=>b.percentageMeaning==='as_published_not_payout_quote'))continue;
    const card=cardDetails(a.cards()[i]),cta=card.children.findIndex(n=>n.dataset.plan===p.id);
    assert.ok(card.children.slice(0,cta).some(n=>n.tagName==='P'&&n.textContent==='Проценты — как в источнике, не расчёт вашей доплаты. Период лимита уточните в договоре.'),p.id+': percentage caveat is visible in catalogue, not only comparison');
  }
});

test('catalogue disclosures have distinct names and never duplicate benefit text or lose original links',async()=>{
  const a=await insurance();
  for(const [i,p] of catalogue.products.entries()){
    const card=a.cards()[i],details=cardDetails(card);
    assert.equal(details.children[0].attrs['aria-label'],'Условия и сравнение: '+p.insurer+' '+p.plan);
    const paragraphs=walk(card).filter(n=>n.tagName==='P').map(n=>n._text);
    for(const b of p.benefits||[]){
      const preview=['outpatient','emergency_hospital'].includes(b.id);
      const fields=preview?walk(card).filter(n=>n.className==='insurance-preview'&&n._text===b.label+': '+b.text):walk(card).filter(n=>n.tagName==='SECTION'&&n.children[0]?.textContent===b.label);
      assert.equal(fields.length,1,p.id+' '+b.id+': one labelled benefit, even when values match another service');
      assert.ok(fields[0].textContent.includes(b.text),p.id+' '+b.id+': complete published text');
      if(b.condition)assert.ok(paragraphs.includes(b.condition),p.id+' '+b.id+': scope retained');
      assert.equal(walk(card).filter(n=>n.tagName==='A'&&n.href===catalogue.sources[b.sourceId].url&&n.attrs['aria-label']==='Источник: '+b.label+', '+p.insurer+' '+p.plan).length,1,p.id+' '+b.id+': original source appears once');
    }
    const cta=details.children.findIndex(n=>n.dataset.plan===p.id),before=details.children.slice(0,cta).map(n=>n.textContent).join('\n');
    if(p.id==='ardi-vitamin-a')assert.match(before,/гражданам Грузии.*Не переносим её условия на иностранцев/);
    if(p.minimumChildAge)assert.match(before,/Условия страхования ребёнка нужно уточнить/);
  }
});

test('removing a collapsed selected card focuses its visible disclosure and updates its selection marker',async()=>{
  const a=await insurance(),card=a.cards()[0],details=cardDetails(card),badge=card.children.find(n=>n.className==='insurance-chosen');
  assert.equal(badge.hidden,true);a.choose('unison-classic');assert.equal(badge.hidden,false);
  details.open=false;
  a.get('insuranceSelectedPlans').children[0].events.click();
  assert.equal(badge.hidden,true);assert.equal(details.children[0].focused,true);
  assert.equal(details.open,false,'Removing a plan must not force its conditions open');
  a.choose('unison-classic');a.get('insuranceCompany').value='ARDI';a.get('insuranceCompany').events.change();
  a.get('insuranceSelectedPlans').children[0].events.click();
  assert.equal(a.get('insuranceCompany').focused,true,'A filtered-out card must not receive focus');
});

test('closing conditions is an explicit action that keeps selection and focuses the disclosure',async()=>{
  const a=await insurance(),details=cardDetails(a.cards()[0]);details.open=true;a.choose('unison-classic');
  const close=details.children.find(n=>n.tagName==='BUTTON'&&n.attrs['aria-label']==='Свернуть условия: Unison Classic');
  assert.ok(close);close.events.click();
  assert.equal(details.open,false);assert.equal(details.children[0].focused,true);
  assert.equal(a.cards()[0].scrolled.block,'start','The plan name must remain visible when returning to its collapsed card');
  assert.equal(a.get('insuranceSelectedCount').textContent,'Выбрано 1 из 2');
});
