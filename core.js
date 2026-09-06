/* Calculation and validation rules shared by the page and offline tests. */
(function(root){
  "use strict";
  const DAY=86400000;
  // A separate key also protects this history from an already-open older build.
  const STORAGE_KEY="gelcost-v5.6-personal";
  const CACHE_KEYS={official:"gelcost-v5.5-official",banks:"gelcost-v5.5-banks",offices:"gelcost-v5.6-offices"};
  const OFFICES={
    mjc:{name:"MJC",cities:["tbilisi","rustavi"],url:"https://mjc.ge/rates",branches:"https://mjc.ge/contact"},
    rico:{name:"Rico",cities:["tbilisi","batumi"],url:"https://www.rico.ge/en/",branches:"https://www.rico.ge/en/branches/"}
  };
  function number(value){
    if(typeof value==="number")return Number.isFinite(value)?value:NaN;
    if(typeof value!=="string")return NaN;
    const text=value.trim().replace(/[\s\u00a0\u202f]/g,"").replace(",",".");
    if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))return NaN;
    const result=Number(text);
    return Number.isFinite(result)?result:NaN;
  }
  const positive=value=>Number.isFinite(number(value))&&number(value)>0;
  // Exact decimal fractions for money. Never round rates or intermediate costs.
  // Numbers already stored by older versions retain their decimal representation.
  function fraction(n,d=1n){
    if(d===0n)return null;
    if(d<0n){n=-n;d=-d;}
    let a=n<0n?-n:n,b=d;
    while(b){const r=a%b;a=b;b=r;}
    return {n:n/a,d:d/a};
  }
  function decimalFrom(value){
    if(value&&typeof value.n==="bigint"&&typeof value.d==="bigint")return fraction(value.n,value.d);
    if(!Number.isFinite(number(value)))return null;
    const text=typeof value==="number"?String(value):value.trim().replace(/\s/g,"").replace(",",".");
    const match=/^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
    if(!match)return null;
    const digits=(match[2]||"0")+(match[3]||"");
    const scale=(match[3]||"").length-Number(match[4]||0);
    const n=BigInt(digits)*(match[1]? -1n:1n);
    return scale>=0?fraction(n,10n**BigInt(scale)):fraction(n*10n**BigInt(-scale));
  }
  function decimalOperation(a,b,operation){
    a=decimalFrom(a);b=decimalFrom(b);
    if(!a||!b)return null;
    if(operation==="add")return fraction(a.n*b.d+b.n*a.d,a.d*b.d);
    if(operation==="sub")return fraction(a.n*b.d-b.n*a.d,a.d*b.d);
    if(operation==="mul")return fraction(a.n*b.n,a.d*b.d);
    return fraction(a.n*b.d,a.d*b.n);
  }
  const decimal={
    from:decimalFrom,
    add:(a,b)=>decimalOperation(a,b,"add"),sub:(a,b)=>decimalOperation(a,b,"sub"),
    mul:(a,b)=>decimalOperation(a,b,"mul"),div:(a,b)=>decimalOperation(a,b,"div"),
    compare:(a,b)=>{a=decimalFrom(a);b=decimalFrom(b);if(!a||!b)return NaN;const n=a.n*b.d-b.n*a.d;return n<0n?-1:n>0n?1:0;},
    abs:value=>{const a=decimalFrom(value);return a?fraction(a.n<0n?-a.n:a.n,a.d):null;},
    format:value=>{
      const a=decimalFrom(value);if(!a)return "—";
      // Round half away from zero exactly once, at the kopeck/tetri boundary.
      const n=a.n<0n?-a.n:a.n,cents=(n*200n+a.d)/(2n*a.d);
      const whole=String(cents/100n).replace(/\B(?=(\d{3})+(?!\d))/g,"\u00a0");
      return (a.n<0n&&cents>0n?"−":"")+whole+","+String(cents%100n).padStart(2,"0");
    }
  };
  function weightedDecimal(list){
    const valid=(Array.isArray(list)?list:[]).filter(item=>item&&positive(item.rub)&&positive(item.qty));
    if(!valid.length)return null;
    return decimal.div(valid.reduce((sum,item)=>decimal.add(sum,item.rub),0),valid.reduce((sum,item)=>decimal.add(sum,item.qty),0));
  }
  const timestamp=value=>typeof value==="number"?value:Date.parse(value);
  function fresh(value,ttl=DAY,now=Date.now()){
    const time=timestamp(value);
    return Number.isFinite(time)&&time>0&&time<=now+300000&&now-time<=ttl;
  }
  function weighted(list){
    const valid=(Array.isArray(list)?list:[]).filter(item=>item&&positive(item.rub)&&positive(item.qty));
    const rub=valid.reduce((sum,item)=>sum+number(item.rub),0);
    const qty=valid.reduce((sum,item)=>sum+number(item.qty),0);
    return positive(rub)&&positive(qty)&&positive(rub/qty)?rub/qty:NaN;
  }
  function defaults(){return {
    schemaVersion:55,usdPurchases:[],usdtPurchases:[],usdEstimate:null,
    cashGelRate:null,cashGelUpdated:null,cashBankId:null,cashBankName:null,
    cashOfficeId:null,
    bybitGelRate:null,bybitActualGelRate:null,bybitActual:null,
    bybitRateMode:"actual",bybitGelUpdated:null,feePct:0,cashbackPct:0,
    officialSnapshot:null,legacyActualAdjusted:false
  };}
  function migrate(stored){
    const state={...defaults(),...stored,schemaVersion:55};
    state.usdPurchases=Array.isArray(state.usdPurchases)?state.usdPurchases:[];
    state.usdtPurchases=Array.isArray(state.usdtPurchases)?state.usdtPurchases:[];
    for(const key of ["feePct","cashbackPct"]){
      const value=number(state[key]);
      state[key]=Number.isFinite(value)&&value>=0&&value<100?value:0;
    }
    // V5.4 stored an effective rate after automatically deducting cashback.
    // Reconstruct the rate before that unconfirmed reward. Never erase purchases.
    if(stored&&stored.schemaVersion!==55&&positive(stored.bybitActualGelRate)){
      const reward=number(stored.cashbackPct??2);
      if(reward>=0&&reward<100){
        state.bybitActualGelRate=number(stored.bybitActualGelRate)*(1-reward/100);
        state.legacyActualAdjusted=reward>0;
      }else{
        state.bybitActualGelRate=null;
      }
      state.bybitActual=null;
    }
    return state;
  }
  function load(storage){
    const found={},errors=[];let warning="";
    for(const key of [STORAGE_KEY,"gelcost-v5.5-personal","gelcost-v5.5","gelcost-v5","gelcost-v5.4","gelcost-v5.3","gelcost-v5.2"]){
      try{
        const raw=storage.getItem(key);
        if(raw){const item=JSON.parse(raw);if(!item||typeof item!=="object"||Array.isArray(item))throw Error();found[key]=item;}
      }catch{errors.push(key);warning="Часть сохранённых данных не удалось прочитать. Старые записи не удалены.";}
    }
    // V5.4's actual writer used the generic key, even when a versioned key existed.
    const generic=found["gelcost-v5"];
    const stored=found[STORAGE_KEY]||found["gelcost-v5.5-personal"]||found["gelcost-v5.5"]||(generic?.schemaVersion>=54?generic:null)||found["gelcost-v5.4"]||found["gelcost-v5.3"]||found["gelcost-v5.2"]||generic;
    const state=migrate(stored);
    const invalid=[...state.usdPurchases,...state.usdtPurchases].some(item=>!item||!positive(item.rub)||!positive(item.qty));
    if(invalid)warning+=" Некорректные записи покупок сохранены в резервных данных, но не участвуют в средней.";
    return {state,warning,readBlocked:errors.includes(STORAGE_KEY)||(!found[STORAGE_KEY]&&errors.includes("gelcost-v5.5-personal"))||(!stored&&errors.length>0)};
  }
  function personal(state){
    const fields=Object.keys(defaults()).filter(key=>key!=="officialSnapshot");
    return JSON.parse(JSON.stringify(Object.fromEntries(fields.map(key=>[key,state[key]]))));
  }
  function actualRate(gel,charged,reward=0){
    gel=number(gel);charged=number(charged);reward=number(reward);
    if(!(gel>0&&charged>0&&reward>=0&&reward<charged))return NaN;
    const rate=gel/(charged-reward);
    return positive(rate)?rate:NaN;
  }
  function routes(state){
    const usdAvg=weighted(state.usdPurchases),usdtAvg=weighted(state.usdtPurchases);
    const usdCost=positive(usdAvg)?usdAvg:number(state.usdEstimate);
    const mult=1+number(state.feePct)/100-number(state.cashbackPct)/100;
    const bybitRate=state.bybitRateMode==="actual"
      ?(state.bybitActual?actualRate(state.bybitActual.gel,state.bybitActual.charged,state.bybitActual.reward):number(state.bybitActualGelRate))
      :number(state.bybitGelRate);
    const cash=positive(usdCost)&&positive(state.cashGelRate)?usdCost/number(state.cashGelRate):Infinity;
    const bybit=positive(usdtAvg)&&positive(bybitRate)&&mult>0
      ?usdtAvg/bybitRate*(state.bybitRateMode==="actual"?1:mult):Infinity;
    const usdBasis=weightedDecimal(state.usdPurchases)||(positive(state.usdEstimate)?decimalFrom(state.usdEstimate):null);
    const usdtBasis=weightedDecimal(state.usdtPurchases);
    const actual=state.bybitActual;
    const exactBybit=state.bybitRateMode==="actual"
      ?(actual?decimal.mul(usdtBasis,decimal.div(decimal.sub(actual.charged,actual.reward??0),actual.gel)):decimal.div(usdtBasis,state.bybitActualGelRate))
      :decimal.mul(decimal.div(usdtBasis,state.bybitGelRate),decimal.add(1,decimal.div(decimal.sub(state.feePct,state.cashbackPct),100)));
    const exact={usdCost:usdBasis,cash:Number.isFinite(cash)?decimal.div(usdBasis,state.cashGelRate):null,bybit:Number.isFinite(bybit)?exactBybit:null};
    return {usdAvg,usdtAvg,usdCost,cash,bybit,bybitRate,mult,exact};
  }
  function official(data,now=Date.now()){
    if(!data||!positive(data.usdRub)||!positive(data.usdGel))throw Error("Некорректные официальные курсы");
    const dates=[data.sources?.usdRub?.date,data.sources?.usdGel?.date];
    if(dates.some(date=>!/^\d{4}-\d{2}-\d{2}/.test(date||"")||!Number.isFinite(Date.parse(date))))throw Error("Не указаны даты источников");
    if(dates.some(date=>new Date(date.slice(0,10)+"T00:00:00Z").toISOString().slice(0,10)!==date.slice(0,10)))throw Error("Некорректная календарная дата");
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tbilisi"}).format(now);
    if(dates.some(date=>date.slice(0,10)>today))throw Error("Курс ещё не вступил в силу");
    const checked=data.fetchedAt??data.updatedAt;
    if(!Number.isFinite(timestamp(checked))||timestamp(checked)>now+300000)throw Error("Некорректное время проверки");
    return {...data,usdRub:number(data.usdRub),usdGel:number(data.usdGel),fetchedAt:checked};
  }
  function bankSnapshot(data,now=Date.now()){
    if(data?.schemaVersion!==1||data.currency!=="USD"||data.channel!=="Branch"||data.userType!=="PhysicalPerson"||data.unit!=="GEL per USD"||data.queryAmountGel!==1000)throw Error("Неизвестный формат банковских курсов");
    if(!Number.isFinite(timestamp(data.fetchedAt))||timestamp(data.fetchedAt)>now+300000)throw Error("Некорректная дата банковских курсов");
    if(!Array.isArray(data.offers)||data.offers.length<3||data.offers.length>100)throw Error("Недостаточно банков для проверки");
    const ids=new Set();
    for(const item of data.offers){
      if(!item||typeof item.id!=="string"||!/^\d+$/.test(item.id)||ids.has(item.id)||typeof item.bank!=="string"||item.bank.length>120||!item.bank.trim())throw Error("Неизвестный банк");
      ids.add(item.id);
      if(!(number(item.buy)>=0.5&&number(item.sell)<=10&&number(item.buy)<=number(item.sell)&&number(item.sell)/number(item.buy)<=1.3))throw Error("Некорректная пара банковских курсов");
    }
    const sorted=data.offers.map(o=>number(o.buy)).sort((a,b)=>a-b);
    const median=sorted[Math.floor(sorted.length/2)];
    if(sorted.some(value=>Math.abs(value/median-1)>0.15))throw Error("Выброс в банковских курсах");
    return {...data,offers:data.offers.map(item=>({...item,buy:number(item.buy),sell:number(item.sell)})).sort((a,b)=>b.buy-a.buy||a.bank.localeCompare(b.bank))};
  }
  function officeSnapshot(data,now=Date.now()){
    if(data?.schemaVersion!==1||data.currency!=="USD"||data.unit!=="GEL per USD"||data.channel!=="Cash"||data.side!=="buy")throw Error("Неизвестный формат обменников");
    if(!fresh(data.fetchedAt,Infinity,now)||!Array.isArray(data.offers)||data.offers.length>2||!Array.isArray(data.failures)||data.failures.some(id=>!Object.hasOwn(OFFICES,id))||new Set(data.failures).size!==data.failures.length)throw Error("Некорректный набор обменников");
    const ids=new Set();
    for(const row of data.offers){
      if(!row||!Object.hasOwn(OFFICES,row.id)||ids.has(row.id)||row.nominal!==1||row.sourceUpdatedAt!==null)throw Error("Неизвестная котировка");
      ids.add(row.id);
      if(!(number(row.buy)>=0.5&&number(row.buy)<=number(row.sell)&&number(row.sell)<=10&&number(row.sell)/number(row.buy)<=1.3))throw Error("Некорректный курс обменника");
      if(!fresh(row.checkedAt,Infinity,now)||timestamp(row.checkedAt)>timestamp(data.fetchedAt))throw Error("Некорректная дата обменника");
    }
    if(Object.keys(OFFICES).some(id=>!ids.has(id)&&!data.failures.includes(id)))throw Error("Пропущен статус источника");
    return {...data,offers:data.offers.map(row=>({...row,buy:number(row.buy),sell:number(row.sell)}))};
  }
  const api={DAY,STORAGE_KEY,CACHE_KEYS,OFFICES,number,positive,decimal,fresh,weighted,defaults,migrate,load,personal,actualRate,routes,official,bankSnapshot,officeSnapshot};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.GelCore=api;
})(typeof window!=="undefined"?window:this);
