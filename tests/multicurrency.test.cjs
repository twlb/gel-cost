const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js'),D=C.decimal;
const now=Date.now(),stamp=new Date(now).toISOString();
const office=(currency,checkedAt=stamp)=>({schemaVersion:1,currency,unit:'GEL per '+currency,nominal:1,channel:'Cash',side:'buy',fetchedAt:stamp,failures:[],offers:['mjc','rico'].map(id=>({id,nominal:1,sourceNominal:C.currencyMeta[currency].sourceNominals[id],buy:currency==='RUB'?0.0263:currency==='EUR'?3.032:2.609,sell:currency==='RUB'?0.0303:currency==='EUR'?3.042:2.614,checkedAt,sourceUpdatedAt:null}))});
const bank=currency=>({schemaVersion:1,currency,unit:'GEL per '+currency,nominal:1,sourceNominal:C.currencyMeta[currency].sourceNominals.banks,channel:'Branch',userType:'PhysicalPerson',queryAmountGel:1000,fetchedAt:stamp,offers:[1,2,3].map(id=>({id:String(id),bank:'Bank '+id,buy:currency==='RUB'?0.029:currency==='EUR'?3.03:2.61,sell:currency==='RUB'?0.0317:currency==='EUR'?3.05:2.62}))});

test('legacy USD snapshots and personal keys remain compatible',()=>{
  const b=bank('USD'),o=office('USD');delete b.nominal;delete b.sourceNominal;delete o.nominal;o.offers.forEach(row=>delete row.sourceNominal);
  assert.equal(C.bankSnapshot(b,now).currency,'USD');assert.equal(C.officeSnapshot(o,now).currency,'USD');
  assert.equal(C.STORAGE_KEY,'gelcost-v5.6-personal');assert.equal(C.CACHE_KEYS.banks,'gelcost-v5.5-banks');assert.equal(C.CACHE_KEYS.offices,'gelcost-v5.6-offices');
  const saved={...C.defaults(),usdPurchases:[{rub:8800,qty:100}],usdtPurchases:[{rub:9000,qty:100}],cashGelRate:2.6};
  const loaded=C.load({getItem:key=>key===C.STORAGE_KEY?JSON.stringify(saved):null});
  assert.deepEqual(C.personal(loaded.state),C.personal(saved));
});
test('expected currency and unit are explicit and cannot reuse another currency cache',()=>{
  for(const currency of ['USD','EUR','RUB'])for(const other of ['USD','EUR','RUB']){
    if(currency===other){assert.equal(C.bankSnapshot(bank(currency),now,currency).currency,currency);assert.equal(C.officeSnapshot(office(currency),now,currency).currency,currency);}
    else{assert.throws(()=>C.bankSnapshot(bank(currency),now,other));assert.throws(()=>C.officeSnapshot(office(currency),now,other));}
  }
  assert.throws(()=>C.officeSnapshot({...office('EUR'),unit:'GEL per USD'},now,'EUR'));
  assert.throws(()=>C.bankSnapshot(bank('EUR'),now));assert.throws(()=>C.officeSnapshot(office('RUB'),now));
});
test('new snapshots require normalized nominal and accurate provider source nominal',()=>{
  for(const currency of ['EUR','RUB']){
    for(const nominal of [undefined,0,100]){
      assert.throws(()=>C.bankSnapshot({...bank(currency),nominal},now,currency));
      assert.throws(()=>C.officeSnapshot({...office(currency),nominal},now,currency));
    }
    const o=office(currency);o.offers[0].sourceNominal=100;assert.throws(()=>C.officeSnapshot(o,now,currency));
    const b=bank(currency);delete b.sourceNominal;assert.throws(()=>C.bankSnapshot(b,now,currency));
  }
  const rub=office('RUB');assert.equal(rub.offers[0].sourceNominal,1);assert.equal(rub.offers[1].sourceNominal,100);
  for(const wrongRate of [2.63,0.000263]){rub.offers[0].buy=wrongRate;rub.offers[0].sell=wrongRate*1.01;assert.throws(()=>C.officeSnapshot(rub,now,'RUB'));}
});
test('currency and provider timestamps/failures are independent',()=>{
  const usd=office('USD'),eur=office('EUR'),rub=office('RUB');
  eur.offers[0].checkedAt=new Date(now-3*3600000).toISOString();eur.failures=['mjc'];
  const result=C.officeSnapshot(eur,now,'EUR');
  assert.equal(C.fresh(result.offers[0].checkedAt,2*3600000,now),false);
  assert.equal(C.fresh(result.offers[1].checkedAt,2*3600000,now),true);
  assert.deepEqual(result.failures,['mjc']);assert.deepEqual(C.officeSnapshot(usd,now).failures,[]);assert.deepEqual(C.officeSnapshot(rub,now,'RUB').failures,[]);
  assert.throws(()=>C.bankSnapshot({...bank('EUR'),refreshFailed:true},now,'EUR'));
  assert.equal(C.bankSnapshot(bank('USD'),now).currency,'USD');
});
test('USD/EUR quality gates are not relaxed for multicurrency',()=>{
  for(const currency of ['USD','EUR']){
    const b=bank(currency);b.offers[0].sell=b.offers[0].buy*1.31;assert.throws(()=>C.bankSnapshot(b,now,currency));
    const o=office(currency);o.offers[0].sell=o.offers[0].buy*1.31;assert.throws(()=>C.officeSnapshot(o,now,currency));
  }
});
test('direct RUB uses a quote per 100 RUB and keeps separate BUY/SELL directions',()=>{
  const quotes={gelRubBuy:'2.6300',gelRubSell:'3.0300'};
  const a=C.exchangePlan({from:'RUB',to:'GEL',via:'direct',amount:'10000',quotes});
  assert.equal(a.ok,true);assert.deepEqual(a.path,['RUB','GEL']);assert.equal(a.steps[0].nominal,100);assert.equal(D.compare(a.receive,263),0);
  const target=C.exchangePlan({from:'RUB',to:'GEL',via:'direct',mode:'want',amount:'263',quotes});assert.equal(D.compare(target.give,10000),0);
  const back=C.exchangePlan({from:'GEL',to:'RUB',via:'direct',amount:'303',quotes});assert.equal(D.compare(back.receive,10000),0);
  assert.equal(C.exchangePlan({from:'GEL',to:'RUB',via:'direct',amount:303,quotes:{gelRubBuy:2.63}}).error,'quote');
});
test('default RUB planning still goes through USD, and USDT stays independent',()=>{
  const quotes={rubBuy:100,gelBuy:2.6,gelRubBuy:2.63};
  const a=C.exchangePlan({from:'RUB',to:'GEL',amount:10000,quotes});assert.deepEqual(a.path,['RUB','USD','GEL']);assert.equal(D.compare(a.receive,260),0);
  assert.equal(C.exchangePlan({from:'RUB',to:'GEL',via:'USDT',amount:10000,quotes}).error,'quote');
  assert.equal(C.exchangePlan({from:'USD',to:'GEL',via:'direct',amount:100,quotes}).error,'direction');
});
test('EUR has a direct GEL pair but unsupported routes return direction rather than throw',()=>{
  const quotes={gelEurBuy:'3.032',gelEurSell:'3.042'};
  const a=C.exchangePlan({from:'EUR',to:'GEL',amount:'100',quotes});assert.equal(D.compare(a.receive,'303.2'),0);assert.equal(a.steps[0].nominal,1);
  const b=C.exchangePlan({from:'GEL',to:'EUR',amount:'304.2',quotes});assert.equal(D.compare(b.receive,100),0);
  for(const currency of ['RUB','USD','USDT','EUR'])for(const via of ['USD','USDT','direct']){
    assert.equal(C.exchangePlan({from:'EUR',to:currency,via,amount:1,quotes}).error,'direction');
    assert.equal(C.exchangePlan({from:currency,to:'EUR',via,amount:1,quotes}).error,'direction');
  }
});
test('direct nominal-aware steps apply input fixed fee then percentage without rounding',()=>{
  const quotes={gelRubBuy:'2.6300',gelRubSell:'3.0300',gelEurBuy:'3.0320',gelEurSell:'3.0420'};
  const pairs=[['RUB','GEL','RUBGEL','gelRubBuy',100,false],['GEL','RUB','GELRUB','gelRubSell',100,true],['EUR','GEL','EURGEL','gelEurBuy',1,false],['GEL','EUR','GELEUR','gelEurSell',1,true]];
  for(const [from,to,key,quote,nominal,invert] of pairs)for(const mode of ['give','want']){
    const result=C.exchangePlan({from,to,via:'direct',mode,amount:'100.55',quotes,fees:{[key]:{fixed:'0.05',pct:'1.25'}}});
    assert.equal(result.ok,true);
    // Independent unreduced integer fractions: amount=10055/100, fixed=5/100,
    // percent multiplier=9875/10000, and quoted rate in ten-thousandths.
    const rate4=BigInt(Math.round(Number(quotes[quote])*10000)),n=BigInt(nominal);
    let expected;
    const factor=invert?{n:n*10000n,d:rate4}:{n:rate4,d:n*10000n};
    if(mode==='give')expected={n:10050n*9875n*factor.n,d:100n*10000n*factor.d};
    else{const net={n:10055n*factor.d*10000n,d:100n*factor.n*9875n};expected={n:net.n*100n+5n*net.d,d:net.d*100n};}
    const actual=mode==='give'?result.receive:result.give;assert.equal(actual.n*expected.d,expected.n*actual.d);
    if(mode==='want'){
      const funded=C.exchangePlan({from,to,via:'direct',amount:D.format(D.ceil(result.give)),quotes,fees:{[key]:{fixed:'0.05',pct:'1.25'}}});
      assert.ok(D.compare(funded.receive,'100.55')>=0);
    }
  }
});
test('new routes neither mutate personal purchases nor conflate EUR/RUB with USD cost basis',()=>{
  const state={...C.defaults(),usdPurchases:[{rub:8800,qty:100}],usdtPurchases:[{rub:9100,qty:100}],cashGelRate:2.6};
  const before=JSON.stringify(state),cash=C.routes(state).exact.cash;
  C.exchangePlan({from:'EUR',to:'GEL',amount:100,quotes:{gelEurBuy:3}});
  C.exchangePlan({from:'RUB',to:'GEL',via:'direct',amount:10000,quotes:{gelRubBuy:2.63}});
  assert.equal(JSON.stringify(state),before);assert.equal(D.compare(C.routes(state).exact.cash,cash),0);
});
test('original quote strings retain long precision and half-tetri boundaries after nominal scaling',()=>{
  for(const [from,to,quote,nominal] of [['USD','GEL','gelBuy',1],['EUR','GEL','gelEurBuy',1],['RUB','GEL','gelRubBuy',100]]){
    const value='3.012299999999999999',amount=String(nominal);
    const result=C.exchangePlan({from,to,via:from==='RUB'?'direct':'USD',amount,quotes:{[quote]:value}});
    assert.equal(result.ok,true);assert.equal(D.compare(result.receive,value),0);
    assert.equal(D.compare(result.steps[0].rate,value),0);
  }
  // Exact 0.05 * (3.0123 / 100) = 0.00150615; exact 5000 RUB = 150.615 GEL.
  const plan=C.exchangePlan({from:'RUB',to:'GEL',via:'direct',amount:'5000',quotes:{gelRubBuy:'3.0123'}});
  assert.equal(D.compare(plan.receive,'150.615'),0);assert.equal(D.format(plan.receive),'150,62');
  const justBelow=C.exchangePlan({from:'RUB',to:'GEL',via:'direct',amount:'5000',quotes:{gelRubBuy:'3.012299999999999999'}});
  assert.equal(D.format(justBelow.receive),'150,61');
  const back=C.exchangePlan({from:'GEL',to:'RUB',via:'direct',amount:'150.615',quotes:{gelRubSell:'3.0123'}});
  assert.equal(D.compare(back.receive,'5000'),0);
});
