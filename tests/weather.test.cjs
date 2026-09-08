const {test}=require('node:test');
const assert=require('node:assert/strict');
const W=require('../weather.js');
const NOW=Date.UTC(2026,8,8,9);
function response(key='batumi',overrides={}){const c=W.cities[key];return {latitude:c.latitude,longitude:c.longitude,current_units:{time:'unixtime',temperature_2m:'°C'},current:{time:NOW/1000,temperature_2m:21.4,weather_code:2,is_day:1,...overrides}};}
function harness(fetcher=async()=>({ok:true,json:async()=>response()})){
  const elements=Object.fromEntries(['weatherStatus','weatherDescription','weatherTemperature','weatherIcon','exchangeCity'].map(id=>[id,{textContent:'',value:id==='exchangeCity'?'batumi':'',attrs:{},events:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.events[k]=fn;},removeEventListener(k){delete this.events[k];}}]));
  const timers=new Map(),intervals=new Map(),calls=[];let id=0,time=NOW;
  const doc={hidden:false,events:{},getElementById:id=>elements[id],addEventListener(k,fn){this.events[k]=fn;},removeEventListener(k){delete this.events[k];}};
  const env={document:doc,Date:{now:()=>time},AbortController,fetch:async(...args)=>{calls.push(args);return fetcher(...args);},setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);},setInterval(fn){intervals.set(++id,fn);return id;},clearInterval(id){intervals.delete(id);}};
  return {env,e:elements,timers,intervals,calls,advance(ms){time+=ms;},settle:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('five explicit Georgian city centres produce Celsius UTC requests without user location or keys',()=>{
  assert.deepEqual(Object.keys(W.cities),['batumi','kobuleti','poti','kutaisi','tbilisi']);
  for(const [key,city] of Object.entries(W.cities)){const u=new URL(W.requestURL(key));assert.equal(u.hostname,'api.open-meteo.com');assert.equal(u.searchParams.get('latitude'),String(city.latitude));assert.equal(u.searchParams.get('longitude'),String(city.longitude));assert.equal(u.searchParams.get('temperature_unit'),'celsius');assert.equal(u.searchParams.get('timeformat'),'unixtime');assert.equal(u.searchParams.has('apikey'),false);}
  for(const key of ['all','unknown','__proto__','constructor'])assert.equal(W.requestURL(key),null);
});
test('validated weather retains measured precision, zero, night and WMO meaning',()=>{
  assert.equal(W.validate(response(), 'batumi',NOW).temperature,21.4);
  const zero=W.validate(response('batumi',{temperature_2m:0,is_day:0,weather_code:0}),'batumi',NOW);
  assert.equal(zero.temperature,0);assert.equal(zero.isDay,false);assert.equal(zero.description,'Ясно');
});
test('malformed, missing, old, future, wrong-location and wrong-unit data cannot become current weather',()=>{
  for(const mutate of [d=>d.current.temperature_2m=null,d=>d.current.temperature_2m='21',d=>d.current.temperature_2m=Infinity,d=>d.current.weather_code=1000,d=>d.current.is_day=2,d=>d.current.time=(NOW-W.MAX_AGE-1)/1000,d=>d.current.time=(NOW+16*60*1000)/1000,d=>d.current.time=null,d=>d.current_units.temperature_2m='°F',d=>d.latitude=0,d=>d.longitude=null,d=>delete d.current]){const d=response();mutate(d);assert.throws(()=>W.validate(d,'batumi',NOW));}
  assert.throws(()=>W.validate(response(),'all',NOW));
});
test('mount displays real supplied conditions and memory cache avoids duplicate requests',async()=>{
  const h=harness(),app=W.mount(h.env);await h.settle();
  assert.match(h.e.weatherDescription.textContent,/Батуми · Переменная облачность/);assert.equal(h.e.weatherTemperature.textContent,'21°');
  assert.match(h.e.weatherStatus.title,/Open-Meteo/);assert.equal(h.e.weatherIcon.hidden,false);
  assert.equal(h.calls[0][1].credentials,'omit');assert.equal(h.calls[0][1].referrerPolicy,'no-referrer');
  await app.refresh();assert.equal(h.calls.length,1);app.destroy();assert.equal(h.intervals.size,0);
});
test('unknown city clears previous conditions rather than masquerading as Batumi',async()=>{
  const h=harness(),app=W.mount(h.env);await h.settle();h.e.exchangeCity.value='unknown';await h.e.exchangeCity.events.change();
  assert.equal(h.e.weatherTemperature.textContent,'—');assert.match(h.e.weatherDescription.textContent,/выберите город/);assert.equal(h.calls.length,1);app.destroy();
});
test('a delayed former-city response cannot replace the new city, even if fetch ignores abort',async()=>{
  let complete;const h=harness(async url=>{const u=new URL(url);if(u.searchParams.get('latitude')===String(W.cities.batumi.latitude))return new Promise(resolve=>complete=resolve);return {ok:true,json:async()=>response('tbilisi',{temperature_2m:25})};});
  const app=W.mount(h.env);h.e.exchangeCity.value='tbilisi';await h.e.exchangeCity.events.change();
  assert.match(h.e.weatherDescription.textContent,/Тбилиси/);complete({ok:true,json:async()=>response()});await h.settle();
  assert.match(h.e.weatherDescription.textContent,/Тбилиси/);assert.equal(h.e.weatherTemperature.textContent,'25°');assert.equal(h.calls[0][1].signal.aborted,true);app.destroy();
});
test('request timeout settles even a non-cooperative fetch and exposes no guessed weather',async()=>{
  const h=harness(()=>new Promise(()=>{})),app=W.mount(h.env);
  for(const fn of [...h.timers.values()])fn();await h.settle();
  assert.equal(h.e.weatherTemperature.textContent,'—');assert.match(h.e.weatherDescription.textContent,/Погода недоступна/);assert.equal(h.calls[0][1].signal.aborted,true);app.destroy();
});
test('HTTP and JSON failures clear an earlier number, and recovery uses a new request',async()=>{
  let failure=false;const h=harness(async()=>failure?{ok:false}:{ok:true,json:async()=>response()}),app=W.mount(h.env);await h.settle();
  failure=true;await app.refresh(true);assert.equal(h.e.weatherTemperature.textContent,'—');assert.match(h.e.weatherDescription.textContent,/недоступна/);
  failure=false;await app.refresh();assert.equal(h.e.weatherTemperature.textContent,'21°');assert.equal(h.calls.length,3);app.destroy();
  const bad=harness(async()=>({ok:true,json:async()=>{throw Error('invalid JSON');}})),other=W.mount(bad.env);await bad.settle();assert.equal(bad.e.weatherTemperature.textContent,'—');other.destroy();
});
test('expiry or return from a background tab cannot leave old weather looking current',async()=>{
  const h=harness(),app=W.mount(h.env);await h.settle();h.advance(W.MAX_AGE+1000);h.env.document.events.visibilitychange();await h.settle();
  assert.equal(h.e.weatherTemperature.textContent,'—');assert.match(h.e.weatherDescription.textContent,/недоступна/);app.destroy();
});
test('no widget DOM means no network request and no interference with calculator',()=>{
  let requested=false;assert.equal(W.mount({document:{getElementById:()=>null},fetch:()=>{requested=true;}}),null);assert.equal(requested,false);
});

test('weather container children and source link survive loading, success and failure',async()=>{
  let fail=false;const h=harness(async()=>({ok:!fail,json:async()=>response()}));
  const source={href:'https://open-meteo.com/',textContent:'Open-Meteo'};
  h.e.weatherStatus.children=[h.e.weatherIcon,h.e.weatherTemperature,h.e.weatherDescription,source];
  Object.defineProperty(h.e.weatherStatus,'textContent',{set(){throw Error('Replacing weather container destroys nested DOM');},get(){return this.children.map(c=>c.textContent).join('');}});
  const children=[...h.e.weatherStatus.children],app=W.mount(h.env);await h.settle();
  assert.equal(h.e.weatherTemperature.textContent,'21°');assert.match(h.e.weatherStatus.attrs['aria-label'],/градусов Цельсия/);
  assert.deepEqual(h.e.weatherStatus.children,children);assert.equal(source.href,'https://open-meteo.com/');
  fail=true;await app.refresh(true);assert.deepEqual(h.e.weatherStatus.children,children);assert.equal(h.e.weatherIcon.hidden,true);app.destroy();
});

test('all WMO icon mappings use existing local Lucide assets and distinguish clear night',()=>{
  const fs=require('node:fs'),path=require('node:path');
  for(const code of [0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99])for(const day of [true,false]){
    const svg=fs.readFileSync(path.join(__dirname,'../brand/icons/weather',W.iconName(code,day)+'.svg'),'utf8');assert.match(svg,/<svg/);assert.doesNotMatch(svg,/<script|href=/i);
  }
  assert.equal(W.iconName(0,true),'sun');assert.equal(W.iconName(0,false),'moon');assert.equal(W.iconName(12,true),null);
});

test('browser API refresh synchronizes programmatic city changes without mounting duplicate timers',async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const h=harness(async url=>({ok:true,json:async()=>response(new URL(url).searchParams.get('latitude')===String(W.cities.tbilisi.latitude)?'tbilisi':'batumi')}));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../weather.js'),'utf8'),{window:h.env,URL});
  await h.settle();assert.equal(typeof h.env.GamarjiWeather.refresh,'function');assert.equal(h.intervals.size,1);
  h.e.exchangeCity.value='tbilisi';await h.env.GamarjiWeather.refresh();
  assert.match(h.e.weatherDescription.textContent,/Тбилиси/);assert.equal(h.intervals.size,1);assert.equal(h.calls.length,2);
});

test('missing icon leaves verified weather text and temperature intact',async()=>{
  const h=harness(),app=W.mount(h.env);await h.settle();h.e.weatherIcon.onerror();
  assert.equal(h.e.weatherIcon.hidden,true);assert.equal(h.e.weatherTemperature.textContent,'21°');assert.match(h.e.weatherDescription.textContent,/Переменная облачность/);app.destroy();
});
