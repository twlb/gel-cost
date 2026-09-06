const $=id=>document.getElementById(id);
const C=GelCore;
const fmt=(n,d=2)=>Number(n).toLocaleString("ru-RU",{minimumFractionDigits:d,maximumFractionDigits:d});
const money=(value,d=2)=>Math.abs(value)>9999999?Number(value).toLocaleString("ru-RU",{notation:"compact",maximumFractionDigits:2}):fmt(value,d);
const numberValue=C.number;
const inputValue=value=>Number(value)>0?String(value):"";
let storage;
try{storage=localStorage}catch{storage={getItem(){throw Error()},setItem(){throw Error()}}}
const loaded=C.load(storage);
const state=loaded.state;
function notice(text){$("storageNotice").textContent=text;$("storageNotice").hidden=!text;}
notice(loaded.warning);
$("migrationNotice").hidden=!state.legacyActualAdjusted;
let banks=null,bankFailed=false,bankBusy=false,officialFailed=false,officialBusy=false;
let offices=null,officeFailed=false,officeBusy=false;
let currentView="purchase",selectedOffer="",allOffers=false,statusTimer;
const QUOTE_TTL=2*3600000;
function announce(message){
  $("actionStatus").textContent=message;
  clearTimeout(statusTimer);statusTimer=setTimeout(()=>$("actionStatus").textContent="",6000);
}
function showView(view){
  if(!["purchase","exchange","data"].includes(view))return;
  currentView=view;
  for(const name of ["purchase","exchange","data"]){
    $(name+"View").hidden=name!==view;
    $(name+"Nav").setAttribute("aria-current",name===view?"page":"false");
  }
  // Section changes leave unfinished fields intact.
  if(view==="exchange")renderOffers();
  $(view+"Heading").focus({preventScroll:true});
  window.scrollTo?.({top:0,behavior:"instant"});
}
function togglePurchaseChooser(){
  $("purchaseChooser").hidden=!$("purchaseChooser").hidden;
  $("buyCurrencyButton").setAttribute("aria-expanded",String(!$("purchaseChooser").hidden));
}
const checkedText=time=>new Date(time).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
function officeFresh(id){
  const item=offices?.offers.find(o=>o.id===id);
  return Boolean(item&&!officeFailed&&!offices.failures.includes(id)&&C.fresh(item.checkedAt,QUOTE_TTL));
}

let purchaseKind="usd";
let rateKind="cash";
let rateMode="quote";
let officialReady=false;
let pendingReset=null;
let resetTimer=null;
let resetButton=null;
let resetOriginal="";
let resetPurchases="";
let purchaseSaving=false,rateSaving=false,resetSaving=false;
let personalQueue=Promise.resolve(),volatilePersonal=false;

function readPersonal(){
  const latest=C.load(storage);
  if(latest.readBlocked)throw Error("Saved history cannot be read safely");
  return C.personal(latest.state);
}
function applyCurrentBankQuote(){
  if(state.cashOfficeId){
    const item=offices?.offers.find(o=>o.id===state.cashOfficeId);
    if(item&&officeFresh(item.id)&&(!state.cashGelUpdated||Date.parse(item.checkedAt)>=Number(state.cashGelUpdated))){
      state.cashGelRate=item.buy;state.cashGelUpdated=Date.parse(item.checkedAt);
    }
    return;
  }
  const selected=banks?.offers.find(o=>o.id===state.cashBankId);
  if(selected&&!bankFailed&&C.fresh(banks.fetchedAt,2*3600000)&&(!state.cashGelUpdated||Date.parse(banks.fetchedAt)>=Number(state.cashGelUpdated))){
    state.cashGelRate=selected.buy;state.cashGelUpdated=Date.parse(banks.fetchedAt);
    state.cashBankName=selected.bank;
  }
}
function displayPersonal(next){
  Object.assign(state,next);
  applyCurrentBankQuote();
  $("migrationNotice").hidden=!state.legacyActualAdjusted;
  calc();renderBanks();
}
function syncPersonal(){
  // Never silently discard unsaved changes after a storage/lock failure.
  if(volatilePersonal)return;
  try{displayPersonal(readPersonal());}
  catch{notice("Не удалось синхронизировать историю. Сохранённые записи не перезаписаны. Скачайте резервную копию перед перезагрузкой.");}
}
function changePersonal(change){
  const run=async()=>{
    let next,accepted=true,persisted=false;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    try{
      if(volatilePersonal||!navigator.locks?.request)throw Error("Safe persistence unavailable");
      await navigator.locks.request(C.STORAGE_KEY,{signal:controller.signal},()=>{
        // Read + change + write are synchronous under the same cross-tab lock.
        next=readPersonal();
        accepted=change(next)!==false;
        if(accepted){storage.setItem(C.STORAGE_KEY,JSON.stringify(next));persisted=true;}
      });
    }catch{
      volatilePersonal=true;
      notice("Не удалось сохранить данные безопасно. Изменения работают только в этой вкладке и могут пропасть после закрытия. Скачайте резервную копию в настройках. Откройте приложение по HTTPS в современном браузере; если адрес уже защищён — проверьте доступ к хранилищу и перезагрузите страницу после экспорта.");
      if(!next){next=C.personal(state);accepted=change(next)!==false;}
    }finally{clearTimeout(timer);}
    // A different writer may have completed while our lock was being released.
    if(persisted){try{next=readPersonal();}catch{/* Keep the successfully saved copy. */}}
    displayPersonal(next);
    return accepted;
  };
  const result=personalQueue.then(run);
  personalQueue=result.catch(()=>{});
  return result;
}
function readCache(key,validate){
  try{return validate(JSON.parse(storage.getItem(key)));}catch{return null;}
}
function cachePublic(key,data,validate){
  // Cache failures must never fall back to writing the personal state.
  try{
    const previous=readCache(key,validate);
    if(!previous||Date.parse(data.fetchedAt)>=Date.parse(previous.fetchedAt))storage.setItem(key,JSON.stringify(data));
  }catch{/* A public cache is optional; the current calculation still works. */}
}

const weighted=C.weighted;

const routeValues=()=>C.routes(state);

function freshnessText(timestamp,label){
  if(!timestamp||!Number.isFinite(new Date(timestamp).getTime())||new Date(timestamp).getTime()>Date.now()+300000)return {text:`Дата курса ${label} неизвестна — обновите перед расчётом`,stale:true};
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
  const bestName=cash<=bybit?"Наличные":"Bybit";
  const rawQuantity=numberValue($("quickGel").value);
  const invalidQuantity=!(rawQuantity>0)||rawQuantity>1e9||[cash,bybit].some(rate=>Number.isFinite(rate)&&!Number.isFinite(rawQuantity*rate));
  const quantity=!invalidQuantity?rawQuantity:0;
  $("quickError").textContent=invalidQuantity?"Введите положительную сумму в лари, например 100 или 12,50.":"";
  $("quickError").classList.toggle("show",invalidQuantity);
  $("quickGel").setAttribute("aria-invalid",String(invalidQuantity));
  const cashStale=state.cashOfficeId?(!officeFresh(state.cashOfficeId)||!C.fresh(state.cashGelUpdated,QUOTE_TTL)):Boolean(state.cashBankId)
    ?(bankFailed||!banks||!C.fresh(banks.fetchedAt,2*3600000)||!C.fresh(state.cashGelUpdated,2*3600000)||!banks.offers.some(o=>o.id===state.cashBankId))
    :!C.fresh(state.cashGelUpdated);
  const bybitStale=!C.fresh(state.bybitGelUpdated);
  const comparisonStale=(Number.isFinite(cash)&&cashStale)||(Number.isFinite(bybit)&&bybitStale);

  $("cashAvgLabel").textContent=Number.isFinite(usdAvg)?"Средняя покупок USD":"Оценка доллара";
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
  if(state.cashBankId){
    $("cashFreshness").textContent=cashStale?"Банковские данные устарели или не подтверждены — проверьте курс":"Витрина проверена "+new Date(state.cashGelUpdated).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
    $("cashFreshness").classList.toggle("stale",cashStale);
  }
  $("cashSource").textContent=state.cashBankId?`${state.cashBankName} · отделение · запрос на 1 000 GEL в витрине НБГ. Для вашей суммы и наличного обмена условия нужно подтвердить в банке.`:"Ваш ручной курс обмена. Можно выбрать автоматическую котировку банка.";

  if(state.cashOfficeId){
    $("cashSource").textContent=(C.OFFICES[state.cashOfficeId]?.name||"Обменник")+" · публичный курс сети, не гарантия курса конкретной кассы. До возможных комиссий.";
    $("cashFreshness").textContent=cashStale?"Курс обменника устарел или не подтверждён":"Источник проверен "+checkedText(state.cashGelUpdated);
    $("cashFreshness").classList.toggle("stale",cashStale);
  }
  const both=Number.isFinite(cash)&&Number.isFinite(bybit);
  $("cashTotal").textContent=Number.isFinite(cash)&&!invalidQuantity?"≈ "+money(quantity*cash,0)+" ₽":"— ₽";
  $("bybitTotal").textContent=Number.isFinite(bybit)&&!invalidQuantity?"≈ "+money(quantity*bybit,0)+" ₽":"— ₽";
  const cashSource=state.cashOfficeId?(C.OFFICES[state.cashOfficeId]?.name||"Обменник"):(state.cashBankId?state.cashBankName:"Ваш курс");
  $("cashSummary").textContent=!(usdCost>0)?"Добавьте покупку USD — кнопка ниже":!(Number(state.cashGelRate)>0)?"Выберите курс USD → лари":cashSource+" · "+(cashStale?"нужна проверка":checkedText(state.cashGelUpdated))+(Number.isFinite(usdAvg)?"":" · цена USD — оценка");
  $("bybitSummary").textContent=!Number.isFinite(usdtAvg)?"Добавьте покупку USDT — кнопка ниже":!(bybitRate>0)?"Укажите списание по покупке в Bybit":(state.bybitRateMode==="actual"?"По операции":"Прогноз")+" · "+(bybitStale?"обновите Bybit":checkedText(state.bybitGelUpdated));
  $("cashSummary").classList.toggle("stale",Number.isFinite(cash)&&cashStale);
  $("bybitSummary").classList.toggle("stale",Number.isFinite(bybit)&&bybitStale);
  $("dataUsdAvg").textContent=(!Number.isFinite(usdAvg)&&usdCost>0?"Оценка: ":"")+$("cashAvg").textContent;
  $("dataUsdtAvg").textContent=$("usdtAvg").textContent;
  $("cashCard").classList.toggle("best",both&&!comparisonStale&&!invalidQuantity&&cash<bybit);
  $("bybitCard").classList.toggle("best",both&&!comparisonStale&&!invalidQuantity&&bybit<cash);
  $("quickRub").textContent=Number.isFinite(best)&&!invalidQuantity?`${fmt(quantity*best,0)} ₽`:"— ₽";

  if(Number.isFinite(cash)&&Number.isFinite(bybit)){
    const saving=(Math.max(cash,bybit)-best)*quantity;
    $("heroRoute").textContent=saving<1
      ?"Оба способа сейчас почти одинаковы"
      :`${bestName} дешевле примерно на ${fmt(saving,0)} ₽`;
    $("heroDetail").textContent="Оценка по вашим данным.";
  }else if(Number.isFinite(best)){
    $("heroRoute").textContent=`Расчёт по способу «${bestName}»`;
    $("heroDetail").textContent="Добавьте данные второго способа для сравнения.";
  }else{
    $("heroRoute").textContent="Начните с «Купил валюту»";
    $("heroDetail").textContent="Затем выберите курс наличных или обновите Bybit.";
  }

  $("heroRoute").classList.toggle("caution",comparisonStale||invalidQuantity);
  if(comparisonStale){
    $("heroRoute").textContent="Оценка по сохранённым курсам — обновите их перед обменом";
    $("heroDetail").textContent="Свежесть не подтверждена. Выгодный способ пока не выбираем.";
  }else if(state.bybitRateMode==="quote"&&Number.isFinite(bybit)){
    $("heroDetail").textContent+=" · Bybit — прогноз с указанными процентами";
  }
  if(state.cashBankId&&Number.isFinite(cash)&&!comparisonStale)$("heroDetail").textContent+=" · банк: до возможных комиссий";
  if(invalidQuantity)$("heroRoute").textContent="Укажите стоимость покупки в лари";

  $("marketPrice").textContent=Number.isFinite(benchmark)?`${fmt(benchmark)} ₽/₾`:"—";
  if(state.officialUpdated&&Number.isFinite(benchmark)){
    const sourceDate=key=>state.officialSnapshot?.sources?.[key]?.date?.slice(0,10)||"неизвестна";
    const old=officialFailed||!C.fresh(state.officialSnapshot?.fetchedAt,2*C.DAY)||[sourceDate("usdRub"),sourceDate("usdGel")].some(d=>Date.now()-Date.parse(d)>7*C.DAY);
    $("marketStamp").textContent=`ЦБ РФ: ${sourceDate("usdRub")} · НБГ: ${sourceDate("usdGel")}${old?" · сохранённые данные":""}`;
    $("marketStatus").textContent=Number.isFinite(best)
      ?`${best/benchmark-1>=0?"+":""}${fmt((best/benchmark-1)*100,1)}%`
      :"ориентир";
    if(Number.isFinite(best)){
      const difference=(best-benchmark)*quantity;
      $("marketNote").textContent=`По официальному курсу ${fmt(quantity,0)} ₾ ≈ ${fmt(quantity*benchmark,0)} ₽. Минимальная оценка по вашим данным ${difference>=0?"дороже":"ниже"} на ${fmt(Math.abs(difference),0)} ₽.${comparisonStale?" Личные курсы тоже требуют обновления.":""}`;
    }else{
      $("marketNote").textContent="Это справочная цена. Добавьте личные данные, чтобы сравнить её с вашими затратами.";
    }
    if(old){$("marketStatus").textContent="сохранённый";$("marketNote").textContent+=" Свежесть не подтверждена; показан последний корректный набор.";}
    if(invalidQuantity)$("marketNote").textContent="Справочный ориентир, не предложение обмена. Введите сумму покупки для сравнения.";
  }else{
    $("marketStamp").textContent="официальные данные недоступны";
    $("marketStatus").textContent="нет данных";
    $("marketNote").textContent="Ваш личный расчёт продолжает работать независимо от официального ориентира.";
  }

  renderHistory("usd");
  renderHistory("usdt");
  if(currentView==="exchange")renderOffers();
}

function renderHistory(kind){
  const box=$(kind+"History");
  const list=(kind==="usd"?state.usdPurchases:state.usdtPurchases).filter(item=>item&&C.positive(item.rub)&&C.positive(item.qty)).slice().reverse();
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
  const host=$(currentView==="data"?"purchaseDataHost":"purchaseHomeHost");
  const willOpen=!panel.classList.contains("show")||panel.parentElement!==host||purchaseKind!==kind;
  closeAllInline("purchasePanel");
  purchaseKind=kind;
  $("purchaseTitle").textContent=kind==="usd"?"Купил наличные USD":"Купил USDT";
  $("purchaseUnit").textContent=kind.toUpperCase();
  $("purchaseRub").value="";
  $("purchaseQty").value="";
  $("purchasePreview").textContent="Цена покупки рассчитается автоматически.";
  $("purchaseError").classList.remove("show");
  host.appendChild(panel);
  panel.classList.toggle("show",willOpen);
  $("purchaseChooser").hidden=true;$("buyCurrencyButton").setAttribute("aria-expanded","false");
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

async function savePurchase(){
  if(purchaseSaving)return;
  const rub=numberValue($("purchaseRub").value);
  const quantity=numberValue($("purchaseQty").value);
  if(!(rub>0&&quantity>0&&rub<=1e12&&quantity<=1e12&&Number.isFinite(rub/quantity))){
    $("purchaseError").textContent="Введите, сколько рублей потратили и сколько валюты получили.";
    $("purchaseError").classList.add("show");
    return;
  }
  const field=purchaseKind==="usd"?"usdPurchases":"usdtPurchases";
  const item={rub,qty:quantity,ts:Date.now()};
  purchaseSaving=true;
  closeInline("purchasePanel");
  try{await changePersonal(next=>{next[field].push(item);});announce(volatilePersonal?"Покупка добавлена только в этой вкладке":"Покупка сохранена. Средняя цена пересчитана.");}
  finally{purchaseSaving=false;}
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
  const host=$(kind==="cash"&&currentView==="exchange"?"cashRateHost":kind==="cash"?"cashCard":"bybitCard");
  const willOpen=!panel.classList.contains("show")||panel.parentElement!==host||rateKind!==kind;
  closeAllInline("ratePanel");
  rateKind=kind;
  $("rateTitle").textContent=kind==="cash"?"Обновить USD → ₾":"Обновить Bybit → ₾";
  $("rateLabel").textContent=kind==="cash"?"Сейчас за 1 USD дают":"Сейчас за 1 USDT дают";
  $("bybitModeSwitch").hidden=kind==="cash";
  $("quoteHelp").hidden=kind==="cash";
  $("rateValue").value=inputValue(kind==="cash"?state.cashGelRate:state.bybitGelRate);
  $("actualGel").value="";
  $("actualUsdt").value="";
  $("actualReward").value="";
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
      const effective=C.actualRate(gel,charged,$("actualReward").value.trim()||"0");
      if(!Number.isFinite(effective))return $("ratePreview").textContent="Возврат должен быть не меньше 0 и меньше списания.";
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

async function saveRate(){
  if(rateSaving)return;
  let patch;
  if(rateKind==="cash"){
    const value=numberValue($("rateValue").value);
    if(!(value>0))return showRateError("Введите, сколько лари сейчас дают за 1 USD.");
    patch={cashGelRate:value,cashGelUpdated:Date.now(),cashBankId:null,cashBankName:null,cashOfficeId:null};
  }else if(rateMode==="quote"){
    const value=numberValue($("rateValue").value);
    if(!(value>0))return showRateError("Введите, сколько лари Bybit даёт за 1 USDT.");
    patch={bybitGelRate:value,bybitRateMode:"quote",bybitGelUpdated:Date.now()};
  }else{
    const gel=numberValue($("actualGel").value);
    const charged=numberValue($("actualUsdt").value);
    if(!(gel>0&&charged>0))return showRateError("Введите сумму покупки в лари и фактически списанные USDT.");
    const reward=numberValue($("actualReward").value.trim()||"0");
    const effective=C.actualRate(gel,charged,reward);
    if(!Number.isFinite(effective))return showRateError("Полученный cashback должен быть от 0 до суммы списания, не включая её.");
    patch={bybitActual:{gel,charged,reward},bybitActualGelRate:effective,
      legacyActualAdjusted:false,bybitRateMode:"actual",bybitGelUpdated:Date.now()};
  }
  rateSaving=true;
  closeInline("ratePanel");
  try{await changePersonal(next=>Object.assign(next,patch));announce(volatilePersonal?"Курс изменён только в этой вкладке":"Курс сохранён. Расчёт обновлён.");}
  finally{rateSaving=false;}
}

function openSettings(){
  const panel=$("settingsPanel");
  const willOpen=!panel.classList.contains("show");
  closeAllInline("settingsPanel");
  $("officialRub").value=officialReady?(state.officialUsdRub??""):"";
  $("officialGel").value=officialReady?(state.officialUsdGel??""):"";
  $("feePct").value=String(state.feePct);
  $("cashbackPct").value=String(state.cashbackPct);
  panel.classList.toggle("show",willOpen);
}

function resetPeriod(kind,button){
  if(resetSaving)return;
  if(pendingReset!==kind||resetButton!==button){
    syncPersonal();
    if(resetButton)resetButton.textContent=resetOriginal;
    pendingReset=kind;
    const original=button.textContent;
    resetButton=button;resetOriginal=original;
    resetPurchases=JSON.stringify(state[kind==="usd"?"usdPurchases":"usdtPurchases"]);
    button.textContent="Нажмите ещё раз для подтверждения";
    clearTimeout(resetTimer);
    resetTimer=setTimeout(()=>{pendingReset=null;resetButton=null;button.textContent=original},4000);
    return;
  }
  pendingReset=null;
  resetButton=null;
  clearTimeout(resetTimer);
  const field=kind==="usd"?"usdPurchases":"usdtPurchases",expected=resetPurchases;
  resetSaving=true;button.disabled=true;
  return changePersonal(next=>{
    if(JSON.stringify(next[field])!==expected){
      notice("История изменилась в другой вкладке. Проверьте покупки и подтвердите очистку заново.");
      return false;
    }
    next[field]=[];
    if(kind==="usd")next.usdEstimate=null;
  }).then(accepted=>{
    button.textContent=accepted?"Покупки очищены":`Очистить покупки ${kind.toUpperCase()}`;
    setTimeout(()=>{button.textContent=`Очистить покупки ${kind.toUpperCase()}`},1200);
  }).finally(()=>{resetSaving=false;button.disabled=false;});
}

async function refreshOfficial(){
  if(officialBusy)return;
  officialBusy=true;$("marketStatus").textContent="обновление…";
  try{
    const data=C.official(await fetchJson("./rates.json"));
    if(state.officialSnapshot&&Date.parse(data.fetchedAt)<Date.parse(state.officialSnapshot.fetchedAt))throw Error("Source snapshot moved backwards");
    if(!state.officialSnapshot||Date.parse(data.fetchedAt)>=Date.parse(state.officialSnapshot.fetchedAt))state.officialSnapshot=data;
    officialFailed=false;cachePublic(C.CACHE_KEYS.official,state.officialSnapshot,C.official);
  }catch{officialFailed=true;}
  finally{officialBusy=false;}
  restoreOfficial();calc();
  if($("settingsPanel").classList.contains("show")){
    $("officialRub").value=officialReady?state.officialUsdRub:"";
    $("officialGel").value=officialReady?state.officialUsdGel:"";
  }
}
function restoreOfficial(){
  try{
    const data=C.official(state.officialSnapshot);
    state.officialUsdRub=data.usdRub;state.officialUsdGel=data.usdGel;
    state.officialUpdated=data.fetchedAt;officialReady=true;
  }catch{officialReady=false;}
}
async function fetchJson(url){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(url,{cache:"no-store",signal:controller.signal});
    if(!response.ok)throw Error("Источник недоступен");
    return await response.json();
  }finally{clearTimeout(timer);}
}
function openBanks(){
  showView("exchange");renderBanks();
}
function renderBanks(){
  const selected=$("bankChoice").value||state.cashBankId||"";
  $("bankChoice").replaceChildren(new Option("Выберите банк",""));
  if(banks){
    for(const item of banks.offers){
      const cost=routeValues().usdCost;
      $("bankChoice").add(new Option(item.bank+" · "+fmt(item.buy,4)+" ₾"+(cost>0?" · "+fmt(cost/item.buy)+" ₽/₾":""),item.id));
    }
    $("bankChoice").value=selected;
  }
  const fresh=banks&&C.fresh(banks.fetchedAt,2*3600000)&&!bankFailed;
  $("bankStatus").textContent=bankBusy?"Проверяем опубликованный набор…":banks
    ?banks.offers.length+" банков · проверено "+new Date(banks.fetchedAt).toLocaleString("ru-RU")+"."+(fresh?"":" Набор устарел или обновление не удалось; применение отключено.")
    :"Банковские данные пока недоступны. Ваш ручной курс продолжает работать.";
  updateBankPreview();renderOffers();
}
function updateBankPreview(){
  const item=banks?.offers.find(o=>o.id===$("bankChoice").value);
  const enabled=Boolean(item&&C.fresh(banks.fetchedAt,2*3600000)&&!bankFailed);
  $("applyBankButton").disabled=!enabled;
  $("bankPreview").textContent=item?item.bank+": за 100 USD ≈ "+fmt(item.buy*100)+" GEL до возможных комиссий. После выбора курс этого банка будет обновляться из опубликованных данных.":"Список отсортирован по курсу покупки USD: больше лари за доллар — выше в списке.";
  if(item&&!enabled)$("bankPreview").textContent="Применение отключено: набор устарел или источник недоступен. Проверьте данные либо укажите свой курс вручную.";
}
async function applyBank(){
  const item=banks?.offers.find(o=>o.id===$("bankChoice").value);
  if(!item||bankFailed||!C.fresh(banks.fetchedAt,2*3600000))return;
  const patch={cashBankId:item.id,cashBankName:item.bank,cashOfficeId:null,cashGelRate:item.buy,cashGelUpdated:Date.parse(banks.fetchedAt)};
  closeInline("bankPanel");
  await changePersonal(next=>Object.assign(next,patch));
  showView("purchase");announce(volatilePersonal?"Курс изменён только в этой вкладке":"Выбран "+item.bank+". Курс будет обновляться автоматически.");
}
async function refreshBanks(){
  if(bankBusy)return;
  bankBusy=true;renderBanks();
  try{
    const data=C.bankSnapshot(await fetchJson("./market-rates.json"));
    if(banks&&Date.parse(data.fetchedAt)<Date.parse(banks.fetchedAt))throw Error("Source snapshot moved backwards");
    if(!banks||Date.parse(data.fetchedAt)>=Date.parse(banks.fetchedAt))banks=data;
    bankFailed=false;cachePublic(C.CACHE_KEYS.banks,banks,C.bankSnapshot);
    applyCurrentBankQuote();
  }catch{bankFailed=true;}
  finally{bankBusy=false;renderBanks();calc();}
}
async function saveSettings(){
  const fee=numberValue($("feePct").value),cashback=numberValue($("cashbackPct").value);
  if(!(fee>=0&&fee<100&&cashback>=0&&cashback<100)){
    $("settingsError").textContent="Введите проценты от 0 до 100, не включая 100.";
    $("settingsError").classList.add("show");return;
  }
  $("settingsError").classList.remove("show");
  await changePersonal(next=>{next.feePct=fee;next.cashbackPct=cashback;});
  announce(volatilePersonal?"Условия изменены только в этой вкладке":"Условия прогноза сохранены.");
}
async function exportData(){
  await personalQueue;
  syncPersonal();
  const blob=new Blob([JSON.stringify({app:"GEL Cost",exportedAt:new Date().toISOString(),state},null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download="gel-cost-backup.json";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// Public sources are a separate cache; no background fetch writes personal history.
function offersForCity(){
  const city=$("exchangeCity").value||"tbilisi";
  const officeRows=(offices?.offers||[]).filter(row=>city==="all"||C.OFFICES[row.id].cities.includes(city)).map(row=>({
    key:"office:"+row.id,id:row.id,name:C.OFFICES[row.id].name,buy:row.buy,
    checkedAt:row.checkedAt,fresh:officeFresh(row.id),kind:"office",
    url:C.OFFICES[row.id].url,branches:C.OFFICES[row.id].branches
  }));
  const bankRows=(banks?.offers||[]).map(row=>({
    key:"bank:"+row.id,id:row.id,name:row.bank,buy:row.buy,checkedAt:banks.fetchedAt,
    fresh:!bankFailed&&C.fresh(banks.fetchedAt,QUOTE_TTL),kind:"bank",
    url:"https://nbg.gov.ge/en/currency-rates",branches:null
  }));
  return [...officeRows,...bankRows].sort((a,b)=>Number(b.fresh)-Number(a.fresh)||b.buy-a.buy||a.name.localeCompare(b.name));
}
function selectOffer(key){
  if(!offersForCity().some(row=>row.key===key))return;
  selectedOffer=key;renderOffers();
}
function toggleAllOffers(){allOffers=!allOffers;renderOffers();}
function renderOffers(){
  const rows=offersForCity();
  if(!rows.some(row=>row.key===selectedOffer)){
    const active=state.cashOfficeId?"office:"+state.cashOfficeId:state.cashBankId?"bank:"+state.cashBankId:"";
    selectedOffer=rows.some(row=>row.key===active)?active:rows[0]?.key||"";
  }
  const amount=numberValue($("exchangeAmount").value);
  const valid=amount>0&&amount<=1e9;
  $("exchangeError").textContent=valid?"":"Введите сумму от 0 до 1 млрд USD, больше нуля.";
  $("exchangeError").classList.toggle("show",!valid);
  $("exchangeAmount").setAttribute("aria-invalid",String(!valid));
  const shown=allOffers?rows:rows.slice(0,3);
  // Keep a user's focused row during a background re-render.
  const focused=document.activeElement?.dataset?.offerKey;
  const nodes=shown.map(item=>{
    const button=document.createElement("button");button.type="button";button.className="offer-row";
    button.dataset.offerKey=item.key;button.setAttribute("aria-pressed",String(item.key===selectedOffer));
    const top=document.createElement("span");top.className="offer-top";
    const name=document.createElement("strong");name.textContent=item.name;
    const total=document.createElement("b");total.textContent=valid?money(amount*item.buy)+" ₾":"— ₾";
    top.appendChild(name);top.appendChild(total);button.appendChild(top);
    const detail=document.createElement("small");
    detail.textContent=(item.kind==="office"?"Обменник · курс сети":"Банк · город уточните")+" · "+fmt(item.buy,4)+" ₾/$"+(item.fresh?"":" · нужна проверка");
    button.appendChild(detail);button.addEventListener("click",()=>selectOffer(item.key));return button;
  });
  $("offerList").replaceChildren(...nodes);$("offerList").hidden=!rows.length;
  if(focused)nodes.find(node=>node.dataset.offerKey===focused)?.focus({preventScroll:true});
  $("moreOffers").hidden=rows.length<=3;
  $("moreOffers").textContent=allOffers?"Свернуть список":"Все предложения ("+rows.length+")";
  $("moreOffers").setAttribute("aria-expanded",String(allOffers));
  const available=rows.filter(row=>row.fresh).length;
  $("offerStatus").textContent=available?"Проверено предложений: "+available+". До комиссий.":officeBusy||bankBusy?"Загружаем курсы…":"Свежие предложения недоступны. Сохранённые — только для справки.";
  if(officeFailed||offices?.failures.length)$("offerStatus").textContent+=" Часть обменников не прошла проверку.";
  const item=rows.find(row=>row.key===selectedOffer);
  $("exchangeReceive").textContent=item&&valid?"≈ "+money(amount*item.buy)+" ₾":"— ₾";
  $("exchangeResultLabel").textContent=item?(item.fresh?"По предложению ":"Сохранённый курс · ")+item.name:"Выберите предложение";
  const usdCost=routeValues().usdCost;
  $("exchangeBasis").textContent=valid&&item?(usdCost>0?"Эти USD стоили вам ≈ "+money(amount*usdCost)+" ₽ · 1 ₾ ≈ "+fmt(usdCost/item.buy)+" ₽":"Добавьте покупку USD, чтобы увидеть стоимость в рублях."):"";
  $("selectedOfferDetail").textContent=item?"Проверено "+checkedText(item.checkedAt)+". "+(item.kind==="office"?"Курс сети. Наличие и условия уточните в отделении.":"Витрина НБГ: отделение, запрос на 1 000 GEL. Для вашей суммы условия могут отличаться.")+(item.fresh?"":" Применение отключено: данные устарели или не подтверждены."):"Можно ввести свой проверенный курс ниже.";
  $("selectedSource").hidden=!item;$("selectedBranches").hidden=!item?.branches;
  $("selectedSource").href=item?.url||"";$("selectedBranches").href=item?.branches||"";
  $("applyOfferButton").disabled=!(item?.fresh&&valid);
  $("applyOfferButton").textContent=item?"Использовать курс "+item.name:"Использовать курс для покупок";
}
async function applyOffer(){
  const item=offersForCity().find(row=>row.key===selectedOffer);
  const amount=numberValue($("exchangeAmount").value);
  if(!item?.fresh||!(amount>0&&amount<=1e9))return;
  const patch={cashOfficeId:item.kind==="office"?item.id:null,cashBankId:item.kind==="bank"?item.id:null,
    cashBankName:item.kind==="bank"?item.name:null,cashGelRate:item.buy,cashGelUpdated:Date.parse(item.checkedAt)};
  await changePersonal(next=>Object.assign(next,patch));
  showView("purchase");announce(volatilePersonal?"Курс изменён только в этой вкладке":"Выбран "+item.name+". Курс будет обновляться автоматически.");
}
async function refreshOffices(){
  if(officeBusy)return;
  officeBusy=true;
  try{
    const data=C.officeSnapshot(await fetchJson("./exchange-rates.json"));
    if(offices&&Date.parse(data.fetchedAt)<Date.parse(offices.fetchedAt))throw Error("Office snapshot moved backwards");
    for(const row of data.offers){
      const old=offices?.offers.find(item=>item.id===row.id);
      if(old&&Date.parse(row.checkedAt)<Date.parse(old.checkedAt))throw Error("Provider timestamp moved backwards");
    }
    offices=data;officeFailed=false;cachePublic(C.CACHE_KEYS.offices,offices,C.officeSnapshot);
    applyCurrentBankQuote();
  }catch{officeFailed=true;}
  finally{officeBusy=false;renderOffers();calc();}
}
function refreshAllRates(){return Promise.all([refreshOfficial(),refreshBanks(),refreshOffices()]);}

$("exchangeAmount").addEventListener("input",renderOffers);
$("exchangeCity").addEventListener("change",()=>{selectedOffer="";allOffers=false;renderOffers();});
$("quickGel").addEventListener("input",calc);
$("purchaseRub").addEventListener("input",updatePurchasePreview);
$("purchaseQty").addEventListener("input",updatePurchasePreview);
$("rateValue").addEventListener("input",updateRatePreview);
$("actualGel").addEventListener("input",updateRatePreview);
$("actualUsdt").addEventListener("input",updateRatePreview);
$("actualReward").addEventListener("input",updateRatePreview);
$("bankChoice").addEventListener("change",updateBankPreview);

const cachedOfficial=readCache(C.CACHE_KEYS.official,C.official);
if(cachedOfficial)state.officialSnapshot=cachedOfficial;
else if(state.officialSnapshot){try{cachePublic(C.CACHE_KEYS.official,C.official(state.officialSnapshot),C.official);}catch{}}
banks=readCache(C.CACHE_KEYS.banks,C.bankSnapshot);
offices=readCache(C.CACHE_KEYS.offices,C.officeSnapshot);
applyCurrentBankQuote();
restoreOfficial();
calc();
refreshAllRates();
let lastRefresh=Date.now();
const REFRESH_INTERVAL=5*60000;
function refreshRatesIfDue(minAge=REFRESH_INTERVAL){
  if(document.hidden||Date.now()-lastRefresh<minAge)return;
  lastRefresh=Date.now();
  return refreshAllRates();
}
window.addEventListener("storage",event=>{
  if(event.storageArea&&event.storageArea!==storage)return;
  if(event.key===C.STORAGE_KEY||event.key===null)syncPersonal();
});
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden){syncPersonal();refreshRatesIfDue(60000);}
});
window.addEventListener("online",()=>refreshRatesIfDue(0));
setInterval(()=>{calc();renderBanks();return refreshRatesIfDue();},60000);
