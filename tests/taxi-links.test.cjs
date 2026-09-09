const {test}=require('node:test');
const assert=require('node:assert/strict');
const L=require('../locations.js');

test('Yandex Go receives each verified branch as destination, never pickup or a booking',()=>{
  let checked=0;
  for(const office of ['rico','mjc','inteli'])for(const branch of L.branches(office,'all')){
    const link=L.yandexGoLink(branch);
    if(!L.validPoint(branch.point)||branch.yandexGoIssue){assert.equal(link,null);continue;}
    const url=new URL(link);checked++;
    assert.equal(url.origin,'https://3.redirect.appmetrica.yandex.com');
    assert.equal(url.pathname,'/route');
    assert.equal(url.searchParams.get('end-lat'),String(branch.point[0]));
    assert.equal(url.searchParams.get('end-lon'),String(branch.point[1]));
    assert.deepEqual([...url.searchParams.keys()].sort(),['appmetrica_tracking_id','end-lat','end-lon','lang','ref']);
    assert.equal(url.searchParams.get('appmetrica_tracking_id'),'25395763362139037');
    assert.equal(url.searchParams.get('ref'),'gamarji');
    assert.equal(url.searchParams.get('lang'),'ru');
  }
  assert.ok(checked>10);
});

test('Taxi cannot guess a pin from an address, city, missing data or malformed coordinates',()=>{
  for(const branch of [null,undefined,{}, {destination:'Batumi bank'}, ...[{},[],[41],[41,44,10],[NaN,44],[41,Infinity],[91,44],[41,181],['41',44]].map(point=>({point}))]){
    assert.equal(L.yandexGoLink(branch),null);
  }
});

test('Inteli Batumi keeps its official address and map but blocks the mismatched Go destination',()=>{
  const branch=L.branches('inteli','batumi')[0];
  assert.match(branch.address,/25 Baratashvili Street/);
  assert.deepEqual(branch.point,[41.6492744,41.6374353]);
  assert.equal(L.yandexGoLink(branch),null);
  assert.match(L.branchLinks(branch).google,/41\.6492744%2C41\.6374353/);
});

test('Android map action is a maps HTTPS link, not the generic geo handler that also offers taxis',()=>{
  const branch=L.branches('rico','batumi')[0];
  const link=L.deviceMapLink(L.branchLinks(branch));
  assert.equal(link,L.branchLinks(branch).google);
  assert.doesNotMatch(link,/^intent:|^geo:/);
});
