const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js'),D=C.decimal;
const quotes={rubBuy:100,rubSell:90,gelBuy:2.5,gelSell:2.6,rubUsdtBuy:101,rubUsdtSell:91,gelUsdtBuy:2.4,gelUsdtSell:2.7,usdUsdtBuy:1.01,usdUsdtSell:0.99};
const solve=(args)=>C.exchangePlan({from:'RUB',to:'GEL',amount:100000,quotes,...args});
test('planning does not need history: forward and target use the same directed quotes',()=>{
  const a=solve({});assert.equal(a.ok,true);assert.equal(D.format(a.receive),'2\u00a0500,00');
  assert.equal(D.compare(solve({mode:'want',amount:2500}).give,100000),0);
  const reverse=solve({from:'GEL',to:'RUB',amount:2600});assert.equal(D.compare(reverse.receive,90000),0);
  assert.equal(D.compare(solve({from:'GEL',to:'RUB',mode:'want',amount:90000}).give,2600),0);
});
test('USDT has separate quotes, never the cash rate or an assumed dollar peg',()=>{
  assert.equal(solve({via:'USDT',quotes:{rubBuy:100,gelBuy:2.5}}).error,'quote');
  assert.equal(D.compare(solve({via:'USDT',amount:101000}).receive,2400),0);
  assert.equal(D.compare(solve({from:'USD',to:'USDT',amount:101}).receive,100),0);
  assert.equal(D.compare(solve({from:'USDT',to:'USD',amount:100}).receive,99),0);
});
test('fixed input fee, then percentage, then quote: independent forward and inverse examples',()=>{
  const fees={RUBUSD:{pct:1,fixed:100},USDGEL:{pct:2,fixed:1}};
  const a=solve({amount:10100,fees});assert.equal(D.compare(a.steps[0].output,99),0);
  assert.equal(D.compare(a.receive,'240.1'),0);
  assert.equal(D.compare(solve({amount:'240,10',mode:'want',fees}).give,10100),0);
});
for(const from of ['RUB','USD','USDT','GEL'])for(const to of ['RUB','USD','USDT','GEL'])if(from!==to){
  for(const via of ['USD','USDT'])test(`${from} → ${to} via ${via}: forward/target agree without intermediate rounding`,()=>{
    const fees=Object.fromEntries(['RUBUSD','USDRUB','USDGEL','GELUSD','RUBUSDT','USDTRUB','USDTGEL','GELUSDT','USDUSDT','USDTUSD'].map(k=>[k,{pct:'1,25',fixed:'0,03'}]));
    const a=solve({from,to,via,amount:'12345,6789',fees});assert.equal(a.ok,true);
    // Inverse verification uses an exact target, not a rounded display value.
    const factor=D.div(a.receive,a.give);assert.ok(D.compare(factor,0)>0);
    const b=solve({from,to,via,mode:'want',amount:'9876.54321',fees});assert.equal(b.ok,true);
    let value=b.give;
    for(const step of b.steps)value=D.mul(D.mul(D.sub(value,step.fixed),step.mult),step.factor);
    assert.equal(D.compare(value,'9876.54321'),0);
  });
}
test('invalid inputs and unavailable quotes stop the estimate',()=>{
  for(const amount of ['',0,-1,'abc','1e3','1,2,3',1000000001])assert.equal(solve({amount}).error,'amount');
  for(const q of ['',0,-1,'bad',1000000001])assert.equal(solve({quotes:{...quotes,rubBuy:q}}).error,'quote');
  for(const pct of [-1,100,'bad'])assert.equal(solve({fees:{RUBUSD:{pct}}}).error,'fee');
  assert.equal(solve({fees:{RUBUSD:{fixed:100000}}}).error,'consumed');
  assert.equal(solve({from:'RUB',to:'RUB'}).error,'direction');
  assert.equal(solve({via:'BTC'}).error,'direction');
  assert.equal(solve({mode:'other'}).error,'direction');
  assert.equal(solve({from:'GEL',to:'RUB',quotes:{gelBuy:2.5,rubBuy:100}}).error,'quote');
});
test('four-place input and very large totals retain kopecks',()=>{
  const a=solve({amount:'999999999,99',quotes:{...quotes,rubBuy:'87,1234',gelBuy:'2,6789'}});
  assert.equal(a.ok,true);
  assert.equal(D.compare(a.receive,D.div(D.mul('999999999.99','2.6789'),'87.1234')),0);
});

test('target payment presentation rounds up without changing the exact plan',()=>{
  const target=solve({from:'USD',to:'GEL',mode:'want',amount:100,quotes:{gelBuy:'2.61'}});
  const original=structuredClone(target);
  const prepared=D.ceil(target.give);
  assert.equal(D.format(prepared),'38,32');
  const funded=solve({from:'USD',to:'GEL',amount:D.format(prepared),quotes:{gelBuy:'2.61'}});
  assert.equal(funded.ok,true);
  assert.ok(D.compare(funded.receive,100)>=0);
  assert.deepEqual(target,original,'Presentation must not mutate give, receive, or any step');
  assert.equal(D.compare(target.give,D.div(100,'2.61')),0);
});

test('payment ceiling keeps exact money unchanged and handles tiny, huge, and negative fractions',()=>{
  for(const value of ['0','0.01','38.32','100','999999999999999999999999999999.99']){
    assert.equal(D.compare(D.ceil(value),value),0);
  }
  assert.equal(D.compare(D.ceil('0.000000000000000001'),'0.01'),0);
  assert.equal(D.compare(D.ceil('999999999999999999999999999999.00000001'),'999999999999999999999999999999.01'),0);
  assert.equal(D.compare(D.ceil(D.div(-1231,1000)),D.div(-123,100)),0);
  assert.equal(D.compare(D.ceil(D.div(-1,1000)),0),0);
});

test('payment ceiling has explicit precision and rejects invalid values or precision',()=>{
  assert.equal(D.compare(D.ceil('1.001',0),2),0);
  assert.equal(D.compare(D.ceil('0.123456789',8),'0.12345679'),0);
  assert.equal(D.compare(D.ceil('0.000000000000000001',18),'0.000000000000000001'),0);
  for(const value of ['',null,undefined,NaN,Infinity,'bad'])assert.equal(D.ceil(value),null);
  for(const places of [-1,0.5,19,Infinity,NaN,'2'])assert.equal(D.ceil('1.01',places),null);
});

test('rounded-up target payments fund every direction with both commissions',()=>{
  const fees=Object.fromEntries(['RUBUSD','USDRUB','USDGEL','GELUSD','RUBUSDT','USDTRUB','USDTGEL','GELUSDT','USDUSDT','USDTUSD'].map(k=>[k,{pct:'1,25',fixed:'0,03'}]));
  for(const from of ['RUB','USD','USDT','GEL'])for(const to of ['RUB','USD','USDT','GEL'])if(from!==to){
    for(const via of ['USD','USDT'])for(const amount of ['0.0001','1','100','9876.54321']){
      const target=solve({from,to,via,mode:'want',amount,fees});
      assert.equal(target.ok,true);
      const original=structuredClone(target),prepared=D.ceil(target.give);
      assert.ok(D.compare(prepared,target.give)>=0);
      assert.ok(D.compare(D.sub(prepared,target.give),'0.01')<0);
      const funded=solve({from,to,via,amount:D.format(prepared),fees});
      assert.equal(funded.ok,true);
      assert.ok(D.compare(funded.receive,amount)>=0,`${from} → ${to} via ${via}, target ${amount}`);
      assert.deepEqual(target,original,'The rounded presentation must not alter an exact step');
    }
  }
});
