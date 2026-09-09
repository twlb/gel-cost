const {test}=require('node:test');
const assert=require('node:assert/strict');
const L=require('../locations.js');

test('verified Batumi street vocabulary is display-only and keeps building suffixes',()=>{
  const samples=[['25 Ilia Chavchavadze Street','ул. И. Чавчавадзе, 25'],['18 Baratashvili Street','ул. Бараташвили, 18'],['64 Airport Highway','Аэропортовое шоссе, 64'],['8a Kobaladze Street','ул. Кобаладзе, 8a'],['15 Severiane Achareli Street','ул. Святого Севериана Аджарели, 15'],['1 Sherif Khimshiashvili Street','ул. Шерифа Химшиашвили, 1']];
  for(const [original,display] of samples){
    const actual=L.localizeAddress(original,'batumi');
    assert.equal(actual.original,original);assert.equal(actual.display,display);
    assert.equal(actual.status,'verified-street');assert.equal(actual.source,'https://www.rico.ge/ru/branches/');
    assert.equal(actual.house,original.split(' ')[0]);
  }
});

test('unknown names, cities and complex notices are preserved without partial guesses',()=>{
  for(const original of ['8 Unknown Street','Kobaladze Street','8a Kobaladze Street, apartment 4','8a Kobaladze Street / Airport Highway','8a Kobaladze Street\n18 Baratashvili Street','ქ. ბათუმი, ქუჩა','8a Kobaladze Street  ']){
    const result=L.localizeAddress(original,'batumi');assert.equal(result.display,original);assert.equal(result.status,'unverified');assert.equal(result.source,null);
  }
  for(const city of ['kutaisi','__proto__','constructor',undefined])assert.equal(L.localizeAddress('8a Kobaladze Street',city).status,'unverified');
});

test('Rico and Inteli share the street label but never building, ID, point or routing query',()=>{
  const [inteli]=L.branches('inteli','batumi'),rico=L.branches('rico','batumi').find(b=>b.address.includes('18 Baratashvili'));
  assert.equal(inteli.displayAddress,'Батуми, ул. Бараташвили, 25');
  assert.equal(rico.displayAddress,'Батуми, ул. Бараташвили, 18');
  assert.notEqual(inteli.id,rico.id);
  assert.deepEqual(inteli.point,[41.6492744,41.6374353]);assert.equal(rico.point,null);
  for(const office of ['rico','inteli','mjc'])for(const branch of L.branches(office,'all')){
    const untranslated={...branch};delete untranslated.displayAddress;delete untranslated.addressTranslation;
    assert.deepEqual(L.branchLinks(branch),L.branchLinks(untranslated));
    assert.equal(L.yandexGoLink(branch),L.yandexGoLink(untranslated));
    assert.ok(branch.destination.endsWith(', Georgia'));
  }
  const noPoint=L.branchLinks(rico).google;
  assert.equal(new URL(noPoint).searchParams.get('query'),'18 Baratashvili Street, Batumi, Georgia');
});

test('other cities retain their existing source address and verification is not invented',()=>{
  for(const city of ['tbilisi','kobuleti','poti','kutaisi','rustavi'])for(const b of L.branches('rico',city)){
    assert.equal(b.displayAddress,b.address);assert.equal(b.addressTranslation.status,'unverified');
  }
});
