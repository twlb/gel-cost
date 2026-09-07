const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../core.js'),L=require('../locations.js');
const now=Date.now(),stamp=new Date(now).toISOString();
function snapshot(currency='RUB',version=2){
  return {schemaVersion:version,currency,unit:'GEL per '+currency,nominal:1,channel:'Cash',side:'buy',fetchedAt:stamp,failures:[],
    offers:(version===1?['mjc','rico']:['mjc','rico','inteli']).map(id=>({id,buy:currency==='RUB'?(id==='inteli'?.027:.0263):2.609,sell:currency==='RUB'?.0303:2.614,nominal:1,sourceNominal:C.currencyMeta[currency].sourceNominals[id],sourceUpdatedAt:null,checkedAt:stamp}))};
}
test('V1 cache and V2 three providers both validate without changing personal data',()=>{
  for(const currency of ['USD','EUR','RUB']){
    assert.equal(C.officeSnapshot(snapshot(currency,1),now,currency).offers.length,2);
    assert.equal(C.officeSnapshot(snapshot(currency),now,currency).offers.length,3);
  }
});
test('V2 requires explicit source status; rejects duplicates and wrong nominal',()=>{
  for(const edit of [s=>s.offers.pop(),s=>s.offers.push(s.offers[2]),s=>s.offers[2].sourceNominal=100,s=>s.offers[2].id='unknown',s=>s.schemaVersion=1]){
    const s=snapshot();edit(s);assert.throws(()=>C.officeSnapshot(s,now,'RUB'));
  }
  const s=snapshot();s.offers.pop();s.failures=['inteli'];assert.equal(C.officeSnapshot(s,now,'RUB').offers.length,2);
});
test('failed retained Inteli data stays failed with its original age',()=>{
  const s=snapshot();s.failures=['inteli'];s.offers[2].checkedAt=new Date(now-3*3600000).toISOString();
  const result=C.officeSnapshot(s,now,'RUB');assert.equal(result.failures[0],'inteli');
  assert.equal(C.fresh(result.offers[2].checkedAt,2*3600000,now),false);
});
test('Inteli Batumi maps use verified POI, never street search or a route origin',()=>{
  const [b]=L.branches('inteli','batumi');assert.ok(b.address.includes('25 Baratashvili Street'));
  assert.deepEqual(b.point,[41.6492744,41.6374353]);assert.equal(L.branches('inteli','kobuleti').length,0);
  for(const link of Object.values(L.branchLinks(b))){
    const u=new URL(link);assert.ok(decodeURIComponent(link).includes('41.6492744'));assert.ok(decodeURIComponent(link).includes('41.6374353'));
    for(const key of ['origin','saddr','daddr','rtext','ll'])assert.equal(u.searchParams.has(key),false);
  }
  assert.deepEqual(C.OFFICES.inteli.cities,['batumi']);
});
test('Apple fallback is limited to Inteli; other providers keep Apple Maps',()=>{
  const [inteli]=L.branches('inteli','batumi'),[rico]=L.branches('rico','batumi');
  assert.equal(L.branchLinks(inteli).apple,L.branchLinks(inteli).google);
  assert.equal(new URL(L.branchLinks(rico).apple).hostname,'maps.apple.com');
  assert.equal(new URL(L.mapLinks('Unknown address').apple).hostname,'maps.apple.com');
  assert.match(L.deviceMapLink(L.branchLinks(inteli)),/^intent:0,0\?q=41\.6492744%2C41\.6374353#/);
});
