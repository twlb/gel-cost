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
  for(const action of ['exportData()','resetPeriod(','openSettings()','openPurchase('])assert.ok(data.includes(action),action+' remains accessible');
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
  scrollIntoView(){}
  querySelector(selector){const id=selector.match(/data-plan="([^"]+)"/)?.[1];return walk(this).find(n=>n.dataset.plan===id);}
}
function walk(n){return [n,...n.children.flatMap(walk)];}
async function insurance(data=catalogue){
  const roots=Array.from(html.matchAll(/\bid="([^"]+)"/g),m=>{const n=new Node();n.id=m[1];return n;});
  const get=id=>roots.flatMap(walk).find(n=>n.id===id);
  const ctx={window:{InsuranceCore:C},document:{getElementById:get,createElement:tag=>new Node(tag)},fetch:async()=>({ok:true,json:async()=>structuredClone(data)}),AbortController,setTimeout:()=>1,clearTimeout:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'insurance.js'),'utf8'),ctx);
  await new Promise(resolve=>setImmediate(resolve));
  const cards=()=>get('insuranceList').children;
  const choose=id=>{const button=cards().flatMap(walk).find(n=>n.dataset.plan===id);assert.ok(button);assert.equal(button.disabled,false);button.events.click();};
  return {get,cards,choose};
}

test('insurance cards put fixed service previews and cautions before selection, details after it',async()=>{
  const original=JSON.stringify(catalogue),a=await insurance();
  assert.equal(a.cards().length,catalogue.products.length);
  for(const [i,p] of catalogue.products.entries()){
    const card=a.cards()[i],cta=card.children.findIndex(n=>n.dataset.plan===p.id),details=card.children.findIndex(n=>n.tagName==='DETAILS');
    assert.ok(cta>=0&&details>cta,p.id+': CTA precedes long details');
    const before=card.children.slice(0,cta),summary=before.map(n=>n.textContent).join('\n');
    assert.ok(summary.includes(C.caution(p)),p.id+': important caution visible before CTA');
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
  const cta=card.children.findIndex(n=>n.dataset.plan===product.id);
  const visible=card.children.findIndex(n=>n.tagName!=='DETAILS'&&n.className.includes('insurance-caution')&&n.textContent.includes('Есть расхождения:')&&n.textContent.includes(conflict.label));
  assert.ok(visible>=0,'Waiting conflict must be a visible card child, not hidden in details');
  assert.ok(visible<price&&visible<cta,'Conflict appears before price and selection');
  assert.match(card.children[visible].textContent,/Уточните у страховой/);
});

test('cards expose existing waiting periods with their complete scope and source before selection',async()=>{
  const a=await insurance();
  for(const [i,p] of catalogue.products.entries()){
    const waiting=(p.benefits||[]).find(b=>b.id==='waiting_periods');
    const card=a.cards()[i],cta=card.children.findIndex(n=>n.dataset.plan===p.id);
    const sections=card.children.slice(0,cta).filter(n=>n.tagName==='SECTION');
    if(!waiting){assert.equal(sections.length,0,p.id+': do not invent a waiting period');continue;}
    const section=sections.find(n=>n.children[0]?.textContent===waiting.label);
    assert.ok(section,p.id+': waiting terms visible without opening details');
    assert.ok(section.children.some(n=>n.textContent===waiting.text),p.id+': full published periods');
    if(waiting.condition)assert.ok(section.children.some(n=>n.textContent===waiting.condition),p.id+': full scope and exceptions');
    assert.ok(walk(section).some(n=>n.tagName==='A'&&n.href===catalogue.sources[waiting.sourceId].url),p.id+': original source retained');
  }
});

test('cards with published percentages explain copayment and limit uncertainty before selection',async()=>{
  const a=await insurance();
  for(const [i,p] of catalogue.products.entries()){
    if(!(p.benefits||[]).some(b=>b.percentageMeaning==='as_published_not_payout_quote'))continue;
    const card=a.cards()[i],cta=card.children.findIndex(n=>n.dataset.plan===p.id);
    assert.ok(card.children.slice(0,cta).some(n=>n.tagName==='P'&&n.textContent==='Проценты — как в источнике, не расчёт вашей доплаты. Период лимита уточните в договоре.'),p.id+': percentage caveat is visible in catalogue, not only comparison');
  }
});
