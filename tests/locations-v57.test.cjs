'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const L=require('../locations.js');
const NEW_DATE='2026-09-07T00:00:00Z';
const OLD_DATE='2026-09-06T00:00:00Z';
const additions={
  kobuleti:{name:'Кобулети',map:'Kobuleti',address:'3 Rustaveli Street',point:null},
  poti:{name:'Поти',map:'Poti',address:'2 Lolua Street',point:[42.145482,41.677306],centre:[42.1453631,41.6772475]},
  kutaisi:{name:'Кутаиси',map:'Kutaisi',address:'62 Ilia Chavchavadze Avenue',point:[42.2579718,42.6691528],centre:[42.257724,42.669353]},
};

test('V5.7 new Rico cities have isolated official addresses with per-city verification dates',()=>{
  for(const [city,expected] of Object.entries(additions)){
    const rows=L.branches('rico',city);
    assert.ok(rows.length>0,city);
    assert.equal(rows[0].address,expected.name+', '+expected.address);
    for(const row of rows){
      assert.equal(row.city,city);
      assert.ok(row.id.startsWith('rico:'+city+':'));
      assert.ok(row.address.startsWith(expected.name+', '));
      assert.ok(row.destination.endsWith(', '+expected.map+', Georgia'));
      assert.equal(row.source,'https://www.rico.ge/en/branches/');
      assert.equal(row.checkedAt,NEW_DATE);
    }
    assert.deepEqual(L.branches('mjc',city),[],`No invented MJC branches in ${city}`);
  }
  assert.deepEqual(L.branches('rico','unknown-city'),[]);
  assert.deepEqual(L.branches('__proto__','kobuleti'),[]);
});

test('V5.7 default Batumi and all legacy addresses retain IDs, dates and existing map pins',()=>{
  const batumi=L.branches('rico');
  assert.equal(batumi.length,6);
  assert.deepEqual(batumi.map(row=>row.id),Array.from({length:6},(_,i)=>'rico:batumi:'+i));
  assert.deepEqual(batumi.map(row=>row.point),[
    [41.645256,41.6385689],null,null,[41.6338869,41.6068395],[41.643279,41.654425],null
  ]);
  for(const office of ['rico','mjc'])for(const city of ['batumi','tbilisi','rustavi']){
    for(const row of L.branches(office,city))assert.equal(row.checkedAt,OLD_DATE);
  }
  assert.equal(L.checkedAt,OLD_DATE,'Adding cities must not make the legacy catalog look newly checked');
  assert.equal(L.branches('rico','tbilisi').length,26);
  assert.equal(L.branches('mjc','tbilisi').length,1);
});

test('V5.7 new coordinates are the official single POI, not the Google viewport centre',()=>{
  for(const [city,expected] of Object.entries(additions)){
    if(!expected.point)continue;
    const row=L.branches('rico',city)[0];
    assert.deepEqual(row.point,expected.point);
    assert.notDeepEqual(row.point,expected.centre);
    assert.equal(L.validPoint(row.point),true);
    const links=L.branchLinks(row);
    assert.equal(new URL(links.google).searchParams.get('query'),expected.point.join(','));
    assert.equal(new URL(links.apple).searchParams.get('coordinate'),expected.point.join(','));
    assert.equal(new URL(links.apple).searchParams.get('name'),row.address);
    assert.equal(new URL(links.yandex).searchParams.get('whatshere[point]'),[expected.point[1],expected.point[0]].join(','));
  }
});

test('Kobuleti map-address mismatch cannot reintroduce an unverified precise pin',()=>{
  const row=L.branches('rico','kobuleti')[0],links=L.branchLinks(row);
  assert.equal(row.point,null);
  assert.equal(row.destination,'3 Rustaveli Street, Kobuleti, Georgia');
  assert.equal(new URL(links.apple).searchParams.get('q'),row.destination);
  assert.equal(new URL(links.google).searchParams.get('query'),row.destination);
  assert.equal(new URL(links.yandex).searchParams.get('text'),row.destination);
  for(const url of Object.values(links))assert.equal(/41\.810982|41\.78012/.test(url),false);
});

test('V5.7 Kutaisi unverified pins remain exact address searches and ambiguous entries are omitted',()=>{
  const rows=L.branches('rico','kutaisi');
  assert.equal(rows.length,5);
  assert.equal(rows.some(row=>/intersection|microdistrict/i.test(row.address)),false);
  for(const row of rows.slice(1)){
    assert.equal(row.point,null);
    const links=L.branchLinks(row);
    assert.equal(new URL(links.google).searchParams.get('query'),row.destination);
    assert.equal(new URL(links.apple).searchParams.get('q'),row.destination);
    assert.equal(new URL(links.yandex).searchParams.get('text'),row.destination);
    assert.match(row.destination,/, Kutaisi, Georgia$/);
  }
});

test('V5.7 bank searches use the selected new city without inventing a precise branch',()=>{
  for(const [city,expected] of Object.entries(additions)){
    const links=L.bankSearch('Tera Bank',city);
    assert.equal(new URL(links.google).searchParams.get('query'),`Tera Bank bank branches, ${expected.map}, Georgia`);
    assert.equal(new URL(links.apple).searchParams.get('q'),`Tera Bank bank branches, ${expected.map}, Georgia`);
    assert.equal(new URL(links.apple).searchParams.has('coordinate'),false);
  }
});

test('V5.7 all map URLs remain place/search links without a fixed or inferred route origin',()=>{
  for(const row of [...L.branches('rico','all'),...L.branches('mjc','all')]){
    for(const link of Object.values(L.branchLinks(row))){
      const url=new URL(link);
      assert.equal(url.protocol,'https:');
      assert.equal(url.pathname.includes('/dir'),false);
      for(const key of ['origin','saddr','daddr','destination','rtext','dir_action','rtt','start']){
        assert.equal(url.searchParams.has(key),false,`${row.id}: forbidden ${key}`);
      }
    }
  }
});

test('V5.7 Android intents carry only the new destination and keep exact HTTPS fallback',()=>{
  for(const city of Object.keys(additions))for(const row of L.branches('rico',city)){
    const links=L.branchLinks(row),intent=L.deviceMapLink(links);
    assert.match(intent,/^intent:0,0\?q=/);
    assert.ok(intent.includes('#Intent;scheme=geo;action=android.intent.action.VIEW;'));
    const query=intent.slice('intent:0,0?q='.length,intent.indexOf('#Intent;'));
    assert.equal(decodeURIComponent(query),row.point?row.point.join(','):row.destination);
    const fallback=/;S\.browser_fallback_url=([^;]+);end$/.exec(intent);
    assert.ok(fallback);
    assert.equal(decodeURIComponent(fallback[1]),links.google);
    assert.equal(/origin=|saddr=|rtext=|package=/.test(intent),false);
  }
});

test('V5.7 internal all-city compatibility is a unique union, without leaking into city filters',()=>{
  const cities=['tbilisi','batumi','rustavi',...Object.keys(additions)];
  const all=L.branches('rico','all');
  assert.equal(new Set(all.map(row=>row.id)).size,all.length);
  assert.deepEqual(all,cities.flatMap(city=>L.branches('rico',city)));
  for(const city of cities)assert.deepEqual(all.filter(row=>row.city===city),L.branches('rico',city));
});
