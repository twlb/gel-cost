// Official-provider directory contracts. These tests do not verify live outages,
// provider reachability, browser rendering or physical phones.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const services=require('../services.js');
const source=fs.readFileSync(path.join(root,'services.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const cityCases={
  batumi:['Батуми','Energo-Pro Georgia','Batumi Water','SOCAR Georgia Gas'],
  kobuleti:['Кобулети','Energo-Pro Georgia','Кобулетский водоканал','SOCAR Georgia Gas'],
  poti:['Поти','Energo-Pro Georgia','United Water Supply Company','SOCAR Georgia Gas'],
  kutaisi:['Кутаиси','Energo-Pro Georgia','United Water Supply Company','SOCAR Georgia Gas'],
  tbilisi:['Тбилиси','Telasi','Georgian Water and Power','Tbilisi Energy']
};
const allowedHosts=new Set(['my.energo-pro.ge','www.telasi.ge','mygas.ge','te.ge','bats.ge','kobuleti.gov.ge','www.water.gov.ge','www.gwp.ge']);
const walk=n=>[n,...n.children.flatMap(walk)];

class Node {
  constructor(tag,doc){this.tagName=tag.toUpperCase();this.doc=doc;this.children=[];this.events=new Map();this.attrs={};this.hidden=false;this.value='';this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  set innerHTML(_){throw Error('Directory must construct text nodes, never HTML from source data');}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(key,value){this.attrs[key]=String(value);}
  addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}
  removeEventListener(name,fn){this.events.get(name)?.delete(fn);}
  emit(name,event={}){for(const fn of [...this.events.get(name)||[]])fn(event);}
  focus(){this.doc.activeElement=this;}
}
function dom(city='batumi',missing){
  const document={activeElement:null,events:new Map(),
    getElementById:id=>nodes[id]||null,
    createElement:tag=>new Node(tag,document),
    addEventListener:Node.prototype.addEventListener,removeEventListener:Node.prototype.removeEventListener,emit:Node.prototype.emit};
  const nodes={};for(const id of ['servicesView','servicesHeading','servicesCity','servicesList','servicesUnavailable','exchangeCity']){nodes[id]=new Node('div',document);nodes[id].id=id;}
  nodes.servicesView.hidden=true;nodes.exchangeCity.value=city;
  if(missing)delete nodes[missing];
  const scrolls=[],env={document,scrollTo:options=>scrolls.push(options)};
  return {document,nodes,env,scrolls,enter(){nodes.servicesView.hidden=false;},leave(){nodes.servicesView.hidden=true;},change(value){nodes.exchangeCity.value=value;nodes.exchangeCity.emit('change');}};
}

test('directory maps five supported cities to their explicit three provider categories',()=>{
  for(const [key,[name,...providers]] of Object.entries(cityCases)){
    const data=services.forCity(key);assert.equal(data.name,name);
    assert.deepEqual(data.rows.map(r=>r.key),['power','water','gas']);assert.deepEqual(data.rows.map(r=>r.name),providers);
    for(const row of data.rows){const url=new URL(row.url);assert.equal(url.protocol,'https:');assert.ok(allowedHosts.has(url.hostname));assert.equal(url.username,'');assert.equal(url.password,'');}
  }
});

test('invalid city keys fail closed and cannot inherit another city or an object prototype',()=>{
  for(const key of ['',null,undefined,'all','rustavi','BATUMI','__proto__','constructor','toString','<script>'])assert.equal(services.forCity(key),null,String(key));
  const a=dom('all');services.mount(a.env);
  assert.equal(a.nodes.servicesList.children.length,0);assert.equal(a.nodes.servicesCity.textContent,'Выберите город в шапке');
  assert.doesNotMatch(a.nodes.servicesList.textContent,/Батуми|отключений нет|всё работает/i);
});

test('provider records returned to a caller cannot mutate future directory lookups',()=>{
  const a=services.forCity('batumi');a.name='Changed';a.rows[0].url='javascript:alert(1)';a.rows[1].name='Wrong';
  const b=services.forCity('batumi');assert.equal(b.name,'Батуми');assert.equal(b.rows[1].name,'Batumi Water');assert.equal(new URL(b.rows[0].url).protocol,'https:');
});

test('mount renders the directory but leaves section visibility, focus and scrolling to application navigation',()=>{
  const a=dom();a.nodes.exchangeCity.focus();const mounted=services.mount(a.env);
  assert.equal(a.nodes.servicesView.hidden,true);assert.equal(a.document.activeElement,a.nodes.exchangeCity);assert.equal(a.scrolls.length,0);
  assert.equal(a.nodes.servicesList.children.length,3);assert.equal(a.nodes.servicesCity.textContent,'Батуми');
  a.enter();mounted.render();assert.equal(a.nodes.servicesView.hidden,false);assert.equal(a.document.activeElement,a.nodes.exchangeCity);
  assert.equal(a.scrolls.length,0);assert.equal(mounted.close,undefined,'A full section is not a dismissible panel');
});

test('a completed directory render hides its static failure notice without accessing browser storage',()=>{
  const a=dom();let reads=0;
  for(const key of ['localStorage','sessionStorage'])Object.defineProperty(a.env,key,{get(){reads++;throw Error('Rendering must not access '+key);}});
  assert.equal(a.nodes.servicesUnavailable.hidden,false);
  const mounted=services.mount(a.env);assert.equal(a.nodes.servicesList.children.length,3);assert.equal(a.nodes.servicesUnavailable.hidden,true);
  a.nodes.servicesUnavailable.hidden=false;mounted.render();assert.equal(a.nodes.servicesUnavailable.hidden,true);
  assert.equal(reads,0);
});

test('an interrupted initial render cannot hide the failure notice before content is ready',()=>{
  const a=dom();a.nodes.servicesList.replaceChildren=()=>{throw Error('Interrupted render');};
  assert.throws(()=>services.mount(a.env),/Interrupted render/);
  assert.equal(a.nodes.servicesUnavailable.hidden,false);
});

test('Escape cannot dismiss the full services section or prevent the browser default',()=>{
  const a=dom();services.mount(a.env);let prevented=0;
  const event={key:'Escape',preventDefault(){prevented++;}};
  a.document.emit('keydown',event);assert.equal(prevented,0);
  a.enter();a.nodes.exchangeCity.focus();a.document.emit('keydown',{key:'Enter',preventDefault(){throw Error('Unrelated key');}});
  a.document.emit('keydown',event);assert.equal(prevented,0);assert.equal(a.nodes.servicesView.hidden,false);assert.equal(a.document.activeElement,a.nodes.exchangeCity);
  assert.equal(a.document.events.get('keydown')?.size||0,0);
});

test('city changes refresh visible providers without taking focus, and hidden sections catch up on entry',()=>{
  const a=dom();const mounted=services.mount(a.env);a.enter();a.nodes.exchangeCity.focus();a.change('tbilisi');
  assert.equal(a.nodes.servicesCity.textContent,'Тбилиси');assert.equal(a.document.activeElement,a.nodes.exchangeCity);
  assert.ok(a.nodes.servicesList.textContent.includes('Telasi'));assert.ok(!a.nodes.servicesList.textContent.includes('Energo-Pro'));
  a.change('bad');assert.equal(a.nodes.servicesList.children.length,0);
  a.leave();a.change('kobuleti');assert.equal(a.nodes.servicesList.children.length,0,'Hidden directory does not rerender behind the user');
  a.enter();mounted.render();assert.equal(a.nodes.servicesCity.textContent,'Кобулети');assert.ok(a.nodes.servicesList.textContent.includes('Кобулетский водоканал'));
  assert.equal(a.document.activeElement,a.nodes.exchangeCity);
});

test('directory links and decorative icons are safe, local and distinctly labelled',()=>{
  for(const city of Object.keys(cityCases)){
    const a=dom(city);services.mount(a.env);const nodes=walk(a.nodes.servicesList),allLinks=nodes.filter(n=>n.tagName==='A'),links=allLinks.filter(n=>n.href.startsWith('https:')),phones=allLinks.filter(n=>n.href.startsWith('tel:')),icons=nodes.filter(n=>n.tagName==='IMG');
    assert.equal(links.length,3);assert.equal(icons.length,3);
    assert.equal(nodes.filter(n=>n.tagName==='H2').length,3,'Category headings follow the page H1 without skipping a level');
    assert.equal(allLinks.length,links.length+phones.length);assert.equal(phones.length,city==='batumi'?1:0);
    for(const phone of phones){assert.equal(phone.href,'tel:1152');assert.match(phone.attrs['aria-label'],/Batumi Water.*1152/);assert.ok(!phone.events.size,'Opening the directory must not automatically dial');}
    assert.equal(new Set(links.map(n=>n.attrs['aria-label'])).size,3);
    for(const link of links){assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.equal(link.referrerPolicy,'no-referrer');assert.match(link.attrs['aria-label'],/новая вкладка/);assert.equal(new URL(link.href).protocol,'https:');}
    for(const icon of icons){assert.match(icon.src,/^brand\/icons\/interface\/(zap|droplet|flame)\.svg$/);assert.equal(icon.alt,'');assert.equal(icon.width,22);assert.equal(icon.height,22);}
  }
});

test('all directory icons exist and contain no scripts, remote resources or event handlers',()=>{
  for(const icon of ['zap','droplet','flame','house-plug','x']){
    const svg=fs.readFileSync(path.join(root,'brand/icons/interface',icon+'.svg'),'utf8');
    assert.match(svg,/<svg\b/);assert.doesNotMatch(svg,/<script\b|<foreignObject\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|javascript:|data:)/i);
  }
});

test('mount has no network, geolocation or browser-storage dependencies',()=>{
  const a=dom();let forbidden=0;
  for(const name of ['fetch','localStorage','sessionStorage','navigator','XMLHttpRequest','WebSocket'])Object.defineProperty(a.env,name,{get(){forbidden++;throw Error(name+' must not be accessed');}});
  const context={window:a.env};for(const name of ['fetch','localStorage','sessionStorage','navigator','XMLHttpRequest','WebSocket'])Object.defineProperty(context,name,{get(){forbidden++;throw Error(name+' must not be accessed');}});
  vm.runInNewContext(source,context);a.enter();a.change('tbilisi');a.env.GamarjiServices.render();
  assert.equal(forbidden,0);assert.equal(a.nodes.servicesView.hidden,false);
  assert.doesNotMatch(source,/\b(?:fetch|localStorage|sessionStorage|XMLHttpRequest|WebSocket)\s*[.(]/);
});

test('destroy removes its city listener without hiding the section or taking focus',()=>{
  const a=dom();const mounted=services.mount(a.env);a.enter();a.nodes.exchangeCity.focus();const before=a.nodes.servicesList.textContent;
  mounted.destroy();a.change('tbilisi');assert.equal(a.nodes.servicesList.textContent,before);
  assert.equal(a.nodes.servicesView.hidden,false);assert.equal(a.document.activeElement,a.nodes.exchangeCity);
  assert.equal(a.nodes.exchangeCity.events.get('change').size,0);assert.equal(a.document.events.get('keydown')?.size||0,0);
});

test('missing optional directory markup is a safe no-op',()=>{
  assert.equal(services.mount({}),null);
  for(const missing of ['servicesView','servicesCity','servicesList','exchangeCity']){
    const a=dom('batumi',missing);assert.equal(services.mount(a.env),null);
  }
});

test('static copy distinguishes supplier announcements from confirmed household supply',()=>{
  const start=html.indexOf('<section id="servicesView"'),end=html.indexOf('</section>',start),panel=html.slice(start,end);
  assert.match(panel,/объявления поставщика, не проверка света в доме/i);
  assert.match(panel,/Отсутствие объявления не означает, что отключений нет/);
  assert.doesNotMatch(panel,/отключений:\s*0|всё работает/i);
  assert.match(panel,/<label for="outageSearch">Улица или адрес<\/label>/);
  assert.ok(start>html.indexOf('<main '));assert.ok(end<html.indexOf('</main>'));
  assert.match(panel,/<h1 id="servicesHeading" tabindex="-1">Отключения<\/h1>/);
  for(const id of ['servicesView','servicesNav','servicesHeading','servicesCity','servicesList'])assert.equal((html.match(new RegExp('\\bid="'+id+'"','g'))||[]).length,1);
  for(const id of ['servicesToggle','servicesPanel','servicesClose'])assert.ok(!html.includes('id="'+id+'"'),'Obsolete panel control: '+id);
  assert.match(services.forCity('batumi').rows.find(r=>r.key==='water').note,/без защищённого соединения.*не вводите.*личные данные/i);
});

const appHarness=fs.readFileSync(path.join(__dirname,'app.test.cjs'),'utf8');
const appBoundary=appHarness.indexOf('\nfunction inteliResponses(){');assert.ok(appBoundary>0);
const appPreamble=appHarness.slice(0,appBoundary);assert.ok(!/^test\(/m.test(appPreamble));
const {app,purchase}=new Function('require','__dirname',appPreamble+'\nreturn {app,purchase};')(require,__dirname);
test('application navigation renders services on entry and keeps it mutually exclusive with every other section',async()=>{
  const a=await app();const writes=JSON.stringify(a.writes),views=['exchange','calculator','data','purchase','insurance','services'];
  a.run('const directoryCalls=[];window.GamarjiServices={render(){directoryCalls.push(["render",$("servicesView").hidden])},close(){throw Error("Navigation must not dismiss a section")}};$("servicesHeading").focus=()=>directoryCalls.push(["focus",$("servicesView").hidden]);window.scrollTo=()=>directoryCalls.push(["scroll"])');
  for(const view of views){
    a.run(`showView(${JSON.stringify(view)})`);
    assert.deepEqual(views.filter(name=>!a.els[name+'View'].hidden),[view]);
  }
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(directoryCalls.filter(row=>row[0]!=="scroll"))')),[['render',false],['focus',false]]);
  const calls=a.run('directoryCalls.length');a.run('showView("invalid")');assert.equal(a.run('directoryCalls.length'),calls);
  assert.equal(a.run('currentView'),'services');
  assert.equal(JSON.stringify(a.writes),writes);
});

test('without the services module, navigation retains a visible honest fallback and leaves personal data unchanged',async()=>{
  const notice=html.match(/<p\b[^>]*\bid="servicesUnavailable"[^>]*>([^<]*)<\/p>/);
  assert.ok(notice,'Failure copy must exist in the HTML, independently of services.js');
  assert.doesNotMatch(notice[0].split('>')[0],/(?:^|\s)hidden(?:\s|=|$)/);
  assert.match(notice[0],/role="status"/);assert.match(notice[1],/Не удалось загрузить справочник/);
  assert.match(notice[1],/Перезагрузите страницу/);assert.match(notice[1],/не означает, что отключений нет/);
  const a=await app();await purchase(a,'usd',9000,100);await purchase(a,'usdt',4600,50);
  const saved=JSON.stringify(a.writes),before=JSON.stringify(a.state());
  a.els.servicesHeading.focus=()=>{a.els.servicesHeading.focused=true;};
  assert.equal(a.run('typeof window.GamarjiServices'),'undefined');
  assert.doesNotThrow(()=>a.run('showView("services")'));
  assert.equal(a.els.servicesView.hidden,false);assert.equal(a.els.servicesUnavailable.hidden,false);
  assert.equal(a.els.servicesHeading.focused,true);assert.equal(a.els.servicesNav.attrs['aria-current'],'page');
  assert.equal(a.els.servicesList.children.length,0);assert.equal(JSON.stringify(a.writes),saved);assert.equal(JSON.stringify(a.state()),before);
  a.run('showView("calculator")');assert.equal(a.els.servicesView.hidden,true);assert.equal(a.els.calculatorView.hidden,false);
  assert.equal(JSON.stringify(a.writes),saved);assert.equal(JSON.stringify(a.state()),before);
});

test('outage entry is independent from a missing directory module',async()=>{
  const a=await app();
  a.run('const feedCalls=[];window.GamarjiOutages={render(){feedCalls.push($("servicesView").hidden)}}');
  assert.equal(a.run('typeof window.GamarjiServices'),'undefined');
  a.run('showView("services")');
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(feedCalls)')),[false]);
  a.run('showView("services")');
  assert.equal(a.run('feedCalls.length'),1,'Re-entering the active tab does not duplicate render');
});
