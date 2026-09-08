// Reading-context contract in a small geometry-aware DOM, not browser/visual QA.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const C=require('../insurance-core.js');
const catalogue=require('../insurance-data.json');
const walk=n=>[n,...n.children.flatMap(walk)];

async function setup(){
  let win,doc;
  class Node {
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attrs={};this.events={};this.hidden=false;this.disabled=false;this.value='';this._text='';this.className='';this.position='static';}
    set textContent(value){this._text=String(value);this.replaceChildren();}
    get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
    append(...nodes){for(const n of nodes){if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(x=>x!==n);n.parentElement=this;this.children.push(n);}}
    replaceChildren(...nodes){for(const n of this.children)n.parentElement=null;this.children=[];this.append(...nodes);}
    after(node){const p=this.parentElement;if(!p)return;node.parentElement=p;p.children.splice(p.children.indexOf(this)+1,0,node);}
    setAttribute(k,v){this.attrs[k]=String(v);}
    addEventListener(k,fn){this.events[k]=fn;}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    matches(selector){return selector.split(',').some(part=>{const s=part.trim();if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));if(s==='[tabindex]')return Object.hasOwn(this.attrs,'tabindex');if(s==='[id^="insuranceCondition-"]')return this.id?.startsWith('insuranceCondition-');if(s==='a[href]')return this.tagName==='A'&&Boolean(this.href);const plan=s.match(/^\[data-plan="(.+)"\]$/);return plan?this.dataset.plan===plan[1]:this.tagName===s.toUpperCase();});}
    querySelectorAll(s){return this.children.flatMap(walk).filter(n=>n.matches(s));}
    querySelector(s){return this.querySelectorAll(s)[0]||null;}
    closest(s){for(let n=this;n;n=n.parentElement)if(n.matches(s))return n;return null;}
    getClientRects(){if(!this.rect||!doc.body.contains(this))return [];for(let n=this;n;n=n.parentElement){if(n.hidden&&!this.phantomRect)return [];if(n.tagName==='DETAILS'&&!n.open&&!this.phantomRect){const summary=n.children.find(c=>c.tagName==='SUMMARY');if(!summary?.contains(this))return [];}}return [this.getBoundingClientRect()];}
    getBoundingClientRect(){const r=this.rect||{top:0,height:0,width:0};let top=this.position==='fixed'?r.top:r.top-win.scrollY;if(this.position==='sticky')top=Math.max(0,top);return {...r,top,bottom:top+r.height,left:0,right:r.width};}
    focus(options){if(this.disabled||this.refuseFocus)return;for(let n=this;n;n=n.parentElement){if(n.hidden)return;if(n.tagName==='DETAILS'&&!n.open&&!n.children.find(c=>c.tagName==='SUMMARY')?.contains(this))return;}doc.activeElement=this;this.focusOptions=options;const view=doc.getElementById('insuranceView');if(view.contains(this))view.events.focusin?.({target:this});}
    scrollIntoView(){this.scrolled=true;}
  }
  const body=new Node('body');
  for(const id of html.matchAll(/\bid="([^"]+)"/g)){const n=new Node();n.id=id[1];body.append(n);}
  doc={body,getElementById:id=>walk(body).find(n=>n.id===id),createElement:tag=>new Node(tag),querySelector:s=>body.querySelector(s)};
  const get=doc.getElementById,view=get('insuranceView');
  get('insuranceHeading').tagName='H1';get('insuranceCompareHeading').tagName='H1';
  get('insuranceBrowseIntro').append(get('insuranceHeading'),get('insuranceCompany'),get('insuranceStatus'),get('insuranceRetry'));
  get('insuranceSelection').className='insurance-selection';
  get('insuranceSelection').append(get('insuranceSelectedCount'),get('insuranceCompare'),get('insuranceClear'));
  const tools=new Node();tools.className='insurance-comparison-tools';tools.append(get('insuranceBack'),get('insuranceJump'));
  get('insuranceComparison').append(get('insuranceCompareHeading'),tools,get('insuranceComparisonRows'));get('insuranceComparison').hidden=true;
  view.append(get('insuranceBrowseIntro'),get('insuranceSelection'),get('insuranceComparison'),get('insuranceList'));
  const nav=new Node('nav');nav.className='bottom-nav';nav.position='fixed';nav.rect={top:776,height:68,width:390};body.append(nav);
  win={InsuranceCore:C,innerHeight:844,scrollY:0,getComputedStyle:n=>({position:n.position}),scrollTo(options){this.scrollY=options.top;this.lastScroll=options;}};
  view.rect={top:200,width:390,height:10000};
  const ctx={window:win,document:doc,fetch:async()=>({ok:true,json:async()=>structuredClone(catalogue)}),AbortController,setTimeout:()=>1,clearTimeout:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'insurance.js'),'utf8'),ctx);
  await new Promise(resolve=>setImmediate(resolve));
  const position=(node,top,height=30,width=390)=>{node.rect={top,height,width};return node;};
  const choose=id=>{const b=get('insuranceList').querySelector('[data-plan="'+id+'"]');assert.ok(b);b.events.click();};
  return {get,view,doc,win,api:win.GamarjiInsurance,position,choose,tools,Node};
}

test('insurance context is optional and a first visit has nothing to restore',async()=>{
  const a=await setup();assert.equal(a.api.restoreContext(),false);
  a.view.querySelectorAll=undefined;
  assert.equal(a.api.captureContext(),false);assert.equal(a.api.restoreContext(),false);
});

test('a nav click restores the visible source focus and paragraph at its previous offset',async()=>{
  const a=await setup();a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const section=a.get('insuranceCondition-medications'),paragraph=section.querySelector('p'),source=section.querySelector('a');
  a.position(a.tools,200,66);a.tools.position='sticky';
  a.position(section,1600,700);a.position(paragraph,1610,100);a.position(source,1720,44);
  a.win.scrollY=1500;source.focus();a.doc.activeElement=a.get('purchaseNav');
  assert.equal(a.api.captureContext(),true);
  a.view.hidden=true;a.win.scrollY=0;assert.equal(a.api.restoreContext(),false);
  a.view.hidden=false;assert.equal(a.api.restoreContext(),true);
  assert.equal(a.win.scrollY,1500);assert.equal(a.doc.activeElement,source);assert.equal(source.focusOptions.preventScroll,true);
});

test('wheel scrolling past the old focus resumes the visible text rather than the old control',async()=>{
  const a=await setup(),card=a.get('insuranceList').children[0],details=card.querySelector('details');details.open=true;
  const summary=details.querySelector('summary'),paragraph=details.querySelector('p');
  a.position(summary,500,44);a.win.scrollY=400;summary.focus();
  a.position(paragraph,1500,150);a.win.scrollY=1400;a.doc.activeElement=a.get('purchaseNav');
  assert.equal(a.api.captureContext(),true);a.win.scrollY=0;
  assert.equal(a.api.restoreContext(),true);assert.equal(a.win.scrollY,1400);assert.equal(a.doc.activeElement,paragraph);
  assert.equal(paragraph.attrs.tabindex,'-1','A reading anchor enters focus order without creating a new Tab stop');
});

test('a formerly focused large criterion does not steal focus after its heading scrolls away',async()=>{
  const a=await setup();a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const section=a.get('insuranceCondition-waiting_periods'),paragraph=section.querySelector('p');
  a.position(section,1000,1600);a.position(paragraph,1510,300);a.win.scrollY=900;section.focus();
  a.win.scrollY=1450;a.doc.activeElement=a.get('insuranceNav');
  assert.equal(a.api.captureContext(),true);a.win.scrollY=0;assert.equal(a.api.restoreContext(),true);
  assert.equal(a.doc.activeElement,paragraph);
});

test('reflow resumes the same paragraph below the toolbar, not an old line offset',async()=>{
  const a=await setup();a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const section=a.get('insuranceCondition-medications'),paragraph=section.querySelector('p');
  a.position(a.tools,200,66);a.tools.position='sticky';a.position(paragraph,1500,500);a.win.scrollY=1600;
  assert.equal(a.api.captureContext(),true);
  a.view.rect.width=768;a.position(paragraph,1000,180,768);a.win.scrollY=0;
  assert.equal(a.api.restoreContext(),true);assert.equal(paragraph.getBoundingClientRect().top,74);assert.equal(a.doc.activeElement,paragraph);
});

test('an introductory reading position does not acquire a nonexistent sticky inset',async()=>{
  const a=await setup();a.position(a.get('insuranceHeading'),250,30);a.position(a.get('insuranceSelection'),400,66);a.get('insuranceSelection').position='sticky';
  a.win.scrollY=200;assert.equal(a.api.captureContext(),true);a.win.scrollY=0;
  assert.equal(a.api.restoreContext(),true);assert.equal(a.win.scrollY,200);
});

test('a short-screen reflow with static tools returns to the paragraph without hidden sticky space',async()=>{
  const a=await setup();a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const paragraph=a.get('insuranceCondition-medications').querySelector('p');
  a.position(a.tools,200,66);a.tools.position='sticky';a.position(paragraph,1500,500);a.win.scrollY=1450;
  assert.equal(a.api.captureContext(),true);a.win.innerHeight=400;a.tools.position='static';a.win.scrollY=0;
  assert.equal(a.api.restoreContext(),true);assert.equal(paragraph.getBoundingClientRect().top,0);
});

test('a closed card falls back to its visible title without reopening conditions',async()=>{
  const a=await setup(),card=a.get('insuranceList').children[0],details=card.querySelector('details'),title=card.querySelector('h2');
  details.open=true;a.position(title,600,30);a.position(details.querySelector('p'),1200,150);a.win.scrollY=1100;
  assert.equal(a.api.captureContext(),true);details.open=false;a.win.scrollY=0;
  assert.equal(a.api.restoreContext(),true);assert.equal(a.doc.activeElement,title);assert.equal(details.open,false);
});

test('a removed comparison paragraph falls back to its stable criterion heading',async()=>{
  const a=await setup();a.choose('unison-classic');a.choose('unison-premium');a.get('insuranceCompare').events.click();
  const section=a.get('insuranceCondition-medications'),paragraph=section.querySelector('p'),heading=section.querySelector('h2');
  a.position(heading,900,30);a.position(paragraph,1200,150);a.win.scrollY=1100;
  assert.equal(a.api.captureContext(),true);paragraph.parentElement.replaceChildren();a.win.scrollY=0;
  assert.equal(a.api.restoreContext(),true);assert.equal(a.doc.activeElement,heading);
});

test('an unavailable card or a different insurance mode returns false for ordinary navigation',async()=>{
  const a=await setup(),card=a.get('insuranceList').children[0];a.position(card.querySelector('h2'),900,30);a.win.scrollY=800;
  assert.equal(a.api.captureContext(),true);a.get('insuranceList').replaceChildren();assert.equal(a.api.restoreContext(),false);
  const b=await setup();b.position(b.get('insuranceHeading'),250,30);assert.equal(b.api.captureContext(),true);
  b.get('insuranceComparison').hidden=false;assert.equal(b.api.restoreContext(),false);
});

test('positive phantom rectangles inside closed details never become reading anchors',async()=>{
  const a=await setup(),cards=a.get('insuranceList').children;
  const closed=cards[0].querySelector('details'),phantom=closed.querySelector('p'),visible=cards[1].querySelector('h2');
  closed.open=false;phantom.phantomRect=true;a.position(phantom,1010,300);a.position(visible,1120,30);a.win.scrollY=1000;
  assert.equal(phantom.getClientRects().length,1,'Model the actual Chromium closed-details rectangle');
  assert.equal(a.api.captureContext(),true);a.win.scrollY=0;a.doc.activeElement=a.get('insuranceNav');
  assert.equal(a.api.restoreContext(),true);assert.equal(a.win.scrollY,1000);assert.equal(a.doc.activeElement,visible);
  assert.equal(phantom.attrs.tabindex,undefined,'Invisible text must not receive focus attributes');
});

test('the direct summary of closed details remains eligible while hidden ancestors do not',async()=>{
  const a=await setup(),card=a.get('insuranceList').children[0],closed=card.querySelector('details'),summary=closed.querySelector('summary');
  closed.open=false;a.position(summary,1100,44);a.win.scrollY=1000;
  assert.equal(a.api.captureContext(),true);a.win.scrollY=0;assert.equal(a.api.restoreContext(),true);assert.equal(a.doc.activeElement,summary);
  card.hidden=true;summary.phantomRect=true;assert.equal(summary.getClientRects().length,1);
  assert.equal(a.api.captureContext(),false,'Explicit hidden ancestors override stale geometry');
});

test('restore falls back to the visible anchor when the saved focus refuses focus',async()=>{
  const a=await setup(),card=a.get('insuranceList').children[0],details=card.querySelector('details');details.open=true;
  const paragraph=details.querySelector('p'),source=details.querySelector('a');a.position(paragraph,1100,100);a.position(source,1220,44);a.win.scrollY=1000;
  source.focus();a.doc.activeElement=a.get('insuranceNav');assert.equal(a.api.captureContext(),true);
  source.refuseFocus=true;a.win.scrollY=0;assert.equal(a.api.restoreContext(),true);assert.equal(a.doc.activeElement,paragraph);
});

test('restore reports false when no reading target actually acquires focus',async()=>{
  const a=await setup(),title=a.get('insuranceList').children[0].querySelector('h2');a.position(title,1100,30);a.win.scrollY=1000;
  assert.equal(a.api.captureContext(),true);title.refuseFocus=true;a.doc.activeElement=a.get('insuranceNav');a.win.scrollY=0;
  assert.equal(a.api.restoreContext(),false);assert.equal(a.doc.activeElement,a.get('insuranceNav'));
});
