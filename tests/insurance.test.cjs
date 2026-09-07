const {test}=require('node:test');
const a=require('node:assert/strict');
const C=require('../insurance-core.js');
const data=require('../insurance-data.json');
test('reference catalogue and all sources validate',()=>{a.equal(C.validate(data).products.length,15);});
test('ambiguous, family and missing periods never become monthly quotes',()=>{
  for(const p of data.products){const s=C.priceText(p);if(p.id.startsWith('ardi'))a.doesNotMatch(s,/мес/);if(p.price?.status==='ambiguous'||p.price?.status==='ambiguous_mapping')a.doesNotMatch(s,/\d/);}
  a.equal(C.priceText(data.products[0]),'49 ₾/мес.');
});
test('unsafe source, duplicate, unknown status and invalid price rejected',()=>{
  for(const change of [d=>d.sources.unison.url='javascript:alert(1)',d=>d.products.push(d.products[0]),d=>d.products[0].price.status='approved',d=>d.products[0].price.value=-1,d=>d.products[0].personalizedRankingAllowed=true]){const d=structuredClone(data);change(d);a.throws(()=>C.validate(d));}
});
test('conflicting percentages and family mapping stay explicit',()=>{
  a.match(C.caution(data.products.find(p=>p.id==='unison-premium')),/100%.*90%/);
  a.match(C.caution(data.products.find(p=>p.id==='unison-family-1')),/нельзя определить однозначно/);
});
