const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>Number(n).toLocaleString("ru-RU",{minimumFractionDigits:d,maximumFractionDigits:d});
const numberValue=value=>{
  const normalized=String(value??"").trim().replace(/\s/g,"").replace(",",".");
  const parsed=Number.parseFloat(normalized);
  return Number.isFinite(parsed)?parsed:0;
};
const inputValue=value=>Number(value)>0?String(value):"";

const defaults={
  schemaVersion:54,
  usdPurchases:[],
  usdtPurchases:[],
  usdEstimate:null,
  cashGelRate:null,
  cashGelUpdated:null,
  bybitGelRate:null,
  bybitActualGelRate:null,
  bybitRateMode:"quote",
  bybitGelUpdated:null,
  feePct:2,
  cashbackPct:2,
  officialUsdRub:null,
  officialUsdGel:null,
  officialUpdated:null,
  officialSource:null
};

let stored=null;
for(const key of ["gelcost-v5.4","gelcost-v5.3","gelcost-v5.2","gelcost-v5"]){
  try{stored=JSON.parse(localStorage.getItem(key)||"null")}catch(error){stored=null}
  if(stored)break;
}
const storedSchemaVersion=stored?.schemaVersion;
const state={...defaults,...(stored||{})};
state.usdPurchases=Array.isArray(state.usdPurchases)?state.usdPurchases:[];
state.usdtPurchases=Array.isArray(state.usdtPurchases)?state.usdtPurchases:[];
if(!storedSchemaVersion&&state.usdPurchases.length===1){
  const item=state.usdPurchases[0];
  if(Number(item.rub)===8800&&Number(item.qty)===100){
    state.usdPurchases=[];
    state.usdEstimate=88;
  }
}
state.bybitRateMode=state.bybitRateMode==="actual"?"actual":"quote";
state.schemaVersion=54;

let purchaseKind="usd";
let rateKind="cash";
let rateMode="quote";
let officialReady=false;
let pendingReset=null;
let resetTimer=null;

function save(){localStorage.setItem("gelcost-v5",JSON.stringify(state))}

function weighted(list){
  const rub=list.reduce((sum,item)=>sum+Number(item.rub||0),0);
  const qty=list.reduce((sum,item)=>sum+Number(item.qty||0),0);
  return qty>0?rub/qty:NaN;
}

function routeValues(){
  const usdAvg=weighted(state.usdPurchases);
  const usdtAvg=weighted(state.usdtPurchases);
  const usdCost=Number.isFinite(usdAvg)?usdAvg:Number(state.usdEstimate);
  const cash=Number(state.cashGelRate)>0&&usdCost>0?usdCost/Number(state.cashGelRate):Infinity;
  const mult=1+Number(state.feePct||0)/100-Number(state.cashbackPct||0)/100;
  const bybitRate=state.bybitRateMode==="actual"?Number(state.bybitActualGelRate):Number(state.bybitGelRate);
  const bybit=bybitRate>0&&Number.isFinite(usdtAvg)
    ?(state.bybitRateMode==="actual"?usdtAvg/bybitRate:usdtAvg*mult/bybitRate)
    :Infinity;
  return {usdAvg,usdtAvg,usdCost,cash,bybit,bybitRate,mult};
}

function freshnessText(timestamp,label){
  if(!timestamp)return {text:`Дата курса ${label} не указана — обновите перед расчётом`,stale:true};
  const date=new Date(timestamp);
  const now=new Date();
  const sameDay=date.toDateString()===now.toDateString();
  return {
    text:sameDay
      ?`Курс обновлён сегодня в ${date.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}`
      :`Курс обновлён ${date.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})}`,
    stale:now-date>24*3600*1000
  };
}

function showFreshness(id,timestamp,label){
  const result=freshnessText(timestamp,label);
  const element=$(id);
  element.textContent=result.text;
  element.classList.toggle("stale",result.stale);
}

function calc(){
  const {usdAvg,usdtAvg,usdCost,cash,bybit,bybitRate}=routeValues();
  const hasOfficial=officialReady&&Number(state.officialUsdRub)>0&&Number(state.officialUsdGel)>0;
  const benchmark=hasOfficial?Number(state.officialUsdRub)/Number(state.officialUsdGel):Infinity;
  const best=Math.min(cash,bybit);
  const bestName=cash<=bybit?"Наличный USD":"Bybit / USDT";
  const quantity=numberValue($("quickGel").value);

  $("cashAvgLabel").textContent=Number.isFinite(usdAvg)?"Ваш доллар в среднем":"Оценка доллара";
  $("cashAvg").textContent=usdCost>0?`${fmt(usdCost)} ₽/$`:"Добавьте покупку";
  $("usdtAvg").textContent=Number.isFinite(usdtAvg)?`${fmt(usdtAvg)} ₽/USDT`:"Добавьте покупку";
  $("cashGelRate").textContent=Number(state.cashGelRate)>0?`${fmt(state.cashGelRate,4)} ₾`:"Обновите курс";
  $("bybitGelRate").textContent=bybitRate>0?`${fmt(bybitRate,4)} ₾`:"Обновите курс";
  $("bybitRateLabel").textContent=state.bybitRateMode==="actual"?"Эффективно за 1 USDT":"Bybit за 1 USDT";
  $("cashPrice").textContent=Number.isFinite(cash)?`${fmt(cash)} ₽/₾`:"—";
  $("bybitPrice").textContent=Number.isFinite(bybit)?`${fmt(bybit)} ₽/₾`:"—";
  $("cashExplain").textContent=Number.isFinite(cash)?`${fmt(cash)} ₽`:"Недостаточно данных";
  $("bybitExplain").textContent=Number.isFinite(bybit)?`${fmt(bybit)} ₽`:"Недостаточно данных";
  showFreshness("cashFreshness",state.cashGelUpdated,"USD→₾");
  showFreshness("bybitFreshness",state.bybitGelUpdated,"Bybit");

  $("cashCard").classList.toggle("best",Number.isFinite(cash)&&cash<=bybit);
  $("bybitCard").classList.toggle("best",Number.isFinite(bybit)&&bybit<cash);
  $("quickRub").textContent=Number.isFinite(best)?`${fmt(quantity*best,0)} ₽`:"— ₽";

  if(Number.isFinite(cash)&&Number.isFinite(bybit)){
    const saving=(Math.max(cash,bybit)-best)*quantity;
    $("heroRoute").textContent=saving<1
      ?"Оба способа сейчас почти одинаковы"
      :`${bestName} выгоднее на ${fmt(saving,0)} ₽ для ${fmt(quantity,0)} ₾`;
    $("heroDetail").textContent=`1 ₾ стоит вам ${fmt(best)} ₽ · сравнение по вашим данным`;
  }else if(Number.isFinite(best)){
    $("heroRoute").textContent=`Расчёт по способу «${bestName}»`;
    $("heroDetail").textContent=`1 ₾ стоит вам ${fmt(best)} ₽ · настройте второй способ для сравнения`;
  }else{
    $("heroRoute").textContent="Добавьте данные хотя бы одного способа";
    $("heroDetail").textContent="Нужны личная цена USD/USDT и текущий курс до лари.";
  }

  $("marketPrice").textContent=Number.isFinite(benchmark)?`${fmt(benchmark)} ₽/₾`:"—";
  if(state.officialUpdated&&Number.isFinite(benchmark)){
    const date=new Date(state.officialUpdated);
    $("marketStamp").textContent=`курс на ${date.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})}`;
    $("marketStatus").textContent=Number.isFinite(best)
      ?`${best/benchmark-1>=0?"+":""}${fmt((best/benchmark-1)*100,1)}%`
      :"ориентир";
    if(Number.isFinite(best)){
      const difference=(best-benchmark)*quantity;
      $("marketNote").textContent=`По официальному курсу ${fmt(quantity,0)} ₾ ≈ ${fmt(quantity*benchmark,0)} ₽. Ваш лучший способ ${difference>=0?"дороже":"выгоднее"} на ${fmt(Math.abs(difference),0)} ₽.`;
    }else{
      $("marketNote").textContent="Это справочная цена. Добавьте личные данные, чтобы сравнить её с вашими затратами.";
    }
  }else{
    $("marketStamp").textContent="официальные данные недоступны";
    $("marketStatus").textContent="нет данных";
    $("marketNote").textContent="Ваш личный расчёт продолжает работать независимо от официального ориентира.";
  }

  renderHistory("usd");
  renderHistory("usdt");
  save();
}

function renderHistory(kind){
  const box=$(kind+"History");
  const list=(kind==="usd"?state.usdPurchases:state.usdtPurchases).slice().reverse();
  box.innerHTML=list.length?list.map(item=>{
    const rate=item.qty?item.rub/item.qty:0;
    return `<div class="row"><div>${fmt(item.rub,0)} ₽ → ${fmt(item.qty,kind==="usd"?2:4)} ${kind.toUpperCase()}</div><div class="r">${fmt(rate)} ₽<br>${new Date(item.ts).toLocaleDateString("ru-RU")}</div></div>`;
  }).join(""):'<div class="note">Покупок пока нет.</div>';
}

function closeAllInline(exceptId=""){
  document.querySelectorAll(".inline.show,.history.show").forEach(element=>{
    if(element.id!==exceptId)element.classList.remove("show");
  });
}

function closeInline(id){$(id).classList.remove("show")}

function toggleHistory(id){
  const box=$(id);
  const willOpen=!box.classList.contains("show");
  closeAllInline(id);
  box.classList.toggle("show",willOpen);
}

function openPurchase(kind){
  const panel=$("purchasePanel");
  const host=$(kind==="usd"?"cashCard":"bybitCard");
  const willOpen=!panel.classList.contains("show")||panel.parentElement!==host||purchaseKind!==kind;
  closeAllInline("purchasePanel");
  purchaseKind=kind;
  $("purchaseTitle").textContent=kind==="usd"?"Пополнить запас USD":"Пополнить запас USDT";
  $("purchaseUnit").textContent=kind.toUpperCase();
  $("purchaseRub").value="";
  $("purchaseQty").value="";
  $("purchasePreview").textContent="Цена покупки рассчитается автоматически.";
  $("purchaseError").classList.remove("show");
  host.appendChild(panel);
  panel.classList.toggle("show",willOpen);
  if(willOpen)setTimeout(()=>$("purchaseRub").focus(),50);
}

function updatePurchasePreview(){
  const rub=numberValue($("purchaseRub").value);
  const quantity=numberValue($("purchaseQty").value);
  if(rub>0&&quantity>0){
    const list=purchaseKind==="usd"?state.usdPurchases:state.usdtPurchases;
    const newAverage=weighted([...list,{rub,qty:quantity}]);
    $("purchasePreview").textContent=`Эта покупка: ${fmt(rub/quantity)} ₽/${purchaseKind.toUpperCase()} · новая средняя: ${fmt(newAverage)} ₽`;
  }else{
    $("purchasePreview").textContent="Цена покупки рассчитается автоматически.";
  }
  $("purchaseError").classList.remove("show");
}

function savePurchase(){
  const rub=numberValue($("purchaseRub").value);
  const quantity=numberValue($("purchaseQty").value);
  if(!(rub>0&&quantity>0)){
    $("purchaseError").textContent="Введите, сколько рублей потратили и сколько валюты получили.";
    $("purchaseError").classList.add("show");
    return;
  }
  (purchaseKind==="usd"?state.usdPurchases:state.usdtPurchases).push({rub,qty:quantity,ts:Date.now()});
  closeInline("purchasePanel");
  calc();
}

function setRateMode(mode){
  rateMode=mode;
  $("quoteMode").classList.toggle("show",mode==="quote");
  $("actualMode").classList.toggle("show",mode==="actual");
  $("quoteModeButton").classList.toggle("active",mode==="quote");
  $("actualModeButton").classList.toggle("active",mode==="actual");
  $("quoteModeButton").setAttribute("aria-pressed",String(mode==="quote"));
  $("actualModeButton").setAttribute("aria-pressed",String(mode==="actual"));
  $("rateError").classList.remove("show");
  updateRatePreview();
}

function openRate(kind){
  const panel=$("ratePanel");
  const host=$(kind==="cash"?"cashCard":"bybitCard");
  const willOpen=!panel.classList.contains("show")||panel.parentElement!==host||rateKind!==kind;
  closeAllInline("ratePanel");
  rateKind=kind;
  $("rateTitle").textContent=kind==="cash"?"Обновить USD → ₾":"Обновить Bybit → ₾";
  $("rateLabel").textContent=kind==="cash"?"Сейчас за 1 USD дают":"Сейчас за 1 USDT дают";
  $("bybitModeSwitch").hidden=kind==="cash";
  $("rateValue").value=inputValue(kind==="cash"?state.cashGelRate:state.bybitGelRate);
  $("actualGel").value="";
  $("actualUsdt").value="";
  $("rateError").classList.remove("show");
  setRateMode(kind==="cash"?"quote":"actual");
  host.appendChild(panel);
  panel.classList.toggle("show",willOpen);
  if(willOpen)setTimeout(()=>$(kind==="cash"?"rateValue":"actualGel").focus(),50);
}

function updateRatePreview(){
  const {usdCost,usdtAvg,mult}=routeValues();
  let text="";
  if(rateKind==="cash"){
    const rate=numberValue($("rateValue").value);
    if(rate>0&&usdCost>0)text=`При этом курсе 1 ₾ будет стоить вам ${fmt(usdCost/rate)} ₽.`;
  }else if(rateMode==="quote"){
    const rate=numberValue($("rateValue").value);
    if(rate>0&&Number.isFinite(usdtAvg))text=`С учётом комиссии и cashback 1 ₾ ≈ ${fmt(usdtAvg*mult/rate)} ₽.`;
  }else{
    const gel=numberValue($("actualGel").value);
    const charged=numberValue($("actualUsdt").value);
    if(gel>0&&charged>0){
      const net=charged*(1-Number(state.cashbackPct||0)/100);
      const effective=gel/net;
      text=`Эффективный курс: 1 USDT = ${fmt(effective,4)} ₾`;
      if(Number.isFinite(usdtAvg))text+=` · 1 ₾ ≈ ${fmt(usdtAvg/effective)} ₽`;
    }
  }
  $("ratePreview").textContent=text;
  $("rateError").classList.remove("show");
}

function showRateError(message){
  $("rateError").textContent=message;
  $("rateError").classList.add("show");
}

function saveRate(){
  if(rateKind==="cash"){
    const value=numberValue($("rateValue").value);
    if(value<=0)return showRateError("Введите, сколько лари сейчас дают за 1 USD.");
    state.cashGelRate=value;
    state.cashGelUpdated=Date.now();
  }else if(rateMode==="quote"){
    const value=numberValue($("rateValue").value);
    if(value<=0)return showRateError("Введите, сколько лари Bybit даёт за 1 USDT.");
    state.bybitGelRate=value;
    state.bybitRateMode="quote";
    state.bybitGelUpdated=Date.now();
  }else{
    const gel=numberValue($("actualGel").value);
    const charged=numberValue($("actualUsdt").value);
    if(!(gel>0&&charged>0))return showRateError("Введите сумму покупки в лари и фактически списанные USDT.");
    const net=charged*(1-Number(state.cashbackPct||0)/100);
    state.bybitActualGelRate=gel/net;
    state.bybitRateMode="actual";
    state.bybitGelUpdated=Date.now();
  }
  closeInline("ratePanel");
  calc();
}

function openSettings(){
  const panel=$("settingsPanel");
  const willOpen=!panel.classList.contains("show");
  closeAllInline("settingsPanel");
  $("officialRub").value=officialReady?(state.officialUsdRub??""):"";
  $("officialGel").value=officialReady?(state.officialUsdGel??""):"";
  panel.classList.toggle("show",willOpen);
}

function resetPeriod(kind,button){
  if(pendingReset!==kind){
    pendingReset=kind;
    const original=button.textContent;
    button.textContent="Нажмите ещё раз для подтверждения";
    clearTimeout(resetTimer);
    resetTimer=setTimeout(()=>{pendingReset=null;button.textContent=original},4000);
    return;
  }
  pendingReset=null;
  clearTimeout(resetTimer);
  if(kind==="usd")state.usdPurchases=[];else state.usdtPurchases=[];
  button.textContent="Покупки очищены";
  setTimeout(()=>{button.textContent=`Очистить покупки ${kind.toUpperCase()}`},1200);
  calc();
}

async function refreshOfficial(){
  $("marketStatus").textContent="обновление…";
  let rubRate=null,gelRate=null,updatedAt=null,source=null;
  try{
    const response=await fetch("./rates.json",{cache:"no-store"});
    if(response.ok){
      const data=await response.json();
      rubRate=numberValue(data.usdRub??data.officialUsdRub??data?.rates?.USD_RUB);
      gelRate=numberValue(data.usdGel??data.officialUsdGel??data?.rates?.USD_GEL);
      updatedAt=Date.parse(data.updatedAt??data.date??data.timestamp)||Date.now();
      if(rubRate>0&&gelRate>0)source="rates.json";
    }
  }catch(error){}

  if(rubRate>0&&gelRate>0){
    state.officialUsdRub=rubRate;
    state.officialUsdGel=gelRate;
    state.officialUpdated=updatedAt||Date.now();
    state.officialSource=source;
    officialReady=true;
  }else{
    officialReady=false;
  }
  save();
  calc();
  if($("settingsPanel").classList.contains("show")){
    $("officialRub").value=officialReady?(state.officialUsdRub??""):"";
    $("officialGel").value=officialReady?(state.officialUsdGel??""):"";
  }
}

$("quickGel").addEventListener("input",calc);
$("purchaseRub").addEventListener("input",updatePurchasePreview);
$("purchaseQty").addEventListener("input",updatePurchasePreview);
$("rateValue").addEventListener("input",updateRatePreview);
$("actualGel").addEventListener("input",updateRatePreview);
$("actualUsdt").addEventListener("input",updateRatePreview);

calc();
refreshOfficial();
