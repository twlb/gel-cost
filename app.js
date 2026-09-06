const $=id=>document.getElementById(id);
const C=GelCore;
const L=typeof GelLocations!=="undefined"?GelLocations:null;
const D=C.decimal;
const fmt=(n,d=2)=>Number(n).toLocaleString("ru-RU",{minimumFractionDigits:d,maximumFractionDigits:d});
// Rates use four decimal places only for display; calculations keep full precision.
const fmtRate=value=>fmt(value,4);
// Ruble amounts always include kopecks, even for large totals.
const fmtRub=value=>D.format(value);
const money=value=>{
  const exact=D.from(value),approx=exact?Number(exact.n)/Number(exact.d):NaN;
  return Math.abs(approx)>9999999?approx.toLocaleString("ru-RU",{notation:"compact",maximumFractionDigits:2}):fmtRub(exact);
};
const numberValue=C.number;
const inputValue=value=>{
  if(!C.positive(value))return "";
  let text=String(C.number(value));
  if(text.includes("e")){
    const [coefficient,exponent]=text.split("e"),[whole,fraction=""]=coefficient.split(".");
    const digits=whole+fraction,point=whole.length+Number(exponent);
    text=point<=0?"0."+"0".repeat(-point)+digits:point>=digits.length?digits+"0".repeat(point-digits.length):digits.slice(0,point)+"."+digits.slice(point);
  }
  // Pad short editable quotes, but do not truncate a more precise saved quote.
  if(!/^\d+(?:\.\d+)?$/.test(text))return text;
  const [whole,fraction=""]=text.split(".");
  return whole+","+fraction.padEnd(4,"0");
};
let storage;
try{storage=localStorage}catch{storage={getItem(){throw Error()},setItem(){throw Error()}}}
const loaded=C.load(storage);
const state=loaded.state;
function notice(text){$("storageNotice").textContent=text;$("storageNotice").hidden=!text;}
notice(loaded.warning);
$("migrationNotice").hidden=!state.legacyActualAdjusted;
let banks=null,bankFailed=false,bankBusy=false,officialFailed=false,officialBusy=false;
let offices=null,officeFailed=false,officeBusy=false;
let currentView="exchange",selectedPayment="cash",selectedOffer="",offerSelectionExplicit=false,allOffers=false,statusTimer;
let expandedOffer="",branchOptionsKey="";
const branchSelection={};
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
function setPayment(method){
  if(!["cash","bybit"].includes(method))return;
  // This is a view choice, not a change to the user's stored purchases or rates.
  if(method!==selectedPayment){
    if($("purchasePanel").parentElement===$("rublesEditorHost")&&purchaseKind!==(method==="cash"?"usd":"usdt"))closeInline("purchasePanel");
    if($("ratePanel").parentElement===$("rublesEditorHost")&&rateKind!==method)closeInline("ratePanel");
  }
  selectedPayment=method;
  calc();
}
function editPaymentBasis(){openPurchase(selectedPayment==="cash"?"usd":"usdt");}
function editPaymentRate(){
  if(selectedPayment!=="cash")return openRate("bybit");
  if(C.positive(state.cashGelRate)&&!state.cashBankId&&!state.cashOfficeId)openRate("cash");
  else openBanks();
}
function editComparison(method){
  setPayment(method);
  const values=routeValues(),basis=method==="cash"?values.usdCost:values.usdtAvg;
  if(!(Number.isFinite(basis)&&basis>0))editPaymentBasis();else editPaymentRate();
}
function continueRublesSetup(){
  if($("rublesNextAction").dataset.action==="basis")editPaymentBasis();
  else editPaymentRate();
}
const checkedText=time=>new Date(time).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
function officeFresh(id){
  const item=offices?.offers.find(o=>o.id===id);
  return Boolean(item&&!officeFailed&&!offices.failures.includes(id)&&C.fresh(item.checkedAt,QUOTE_TTL));
}

let purchaseKind="usd";
let rateKind="cash";
let rateMode="quote";
// Drafts live only in this tab, separately for each currency and rate type.
const purchaseDrafts={},rateDrafts={};
let purchaseEditorReady=false,rateEditorReady=false;
let purchaseEditorSequence=0;
let rateDraftBaseline="";
let officialReady=false;
let pendingReset=null;
let resetTimer=null;
let resetButton=null;
let resetOriginal="";
let resetPurchases="";
let rateSaving=false,resetSaving=false;
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
  const {usdAvg,usdtAvg,usdCost,cash,bybit,bybitRate,exact}=routeValues();
  const hasOfficial=officialReady&&Number(state.officialUsdRub)>0&&Number(state.officialUsdGel)>0;
  const benchmark=hasOfficial?Number(state.officialUsdRub)/Number(state.officialUsdGel):Infinity;
  const cashOrder=exact.cash&&exact.bybit?D.compare(exact.cash,exact.bybit):cash===bybit?0:cash<bybit?-1:1;
  const best=cashOrder<=0?cash:bybit;
  const bestName=cashOrder<=0?"Наличные":"Bybit";
  const rawQuantity=numberValue($("quickGel").value);
  const invalidQuantity=!(rawQuantity>0)||rawQuantity>1e9||[cash,bybit].some(rate=>Number.isFinite(rate)&&!Number.isFinite(rawQuantity*rate));
  const quantity=!invalidQuantity?rawQuantity:0;
  const totals={cash:D.mul(exact.cash,quantity),bybit:D.mul(exact.bybit,quantity)};
  const bestTotal=cashOrder<=0?totals.cash:totals.bybit;
  $("quickError").textContent=invalidQuantity?"Введите положительную сумму в лари, например 100 или 12,50.":"";
  $("quickError").classList.toggle("show",invalidQuantity);
  $("quickGel").setAttribute("aria-invalid",String(invalidQuantity));
  const cashStale=state.cashOfficeId?(!officeFresh(state.cashOfficeId)||!C.fresh(state.cashGelUpdated,QUOTE_TTL)):Boolean(state.cashBankId)
    ?(bankFailed||!banks||!C.fresh(banks.fetchedAt,2*3600000)||!C.fresh(state.cashGelUpdated,2*3600000)||!banks.offers.some(o=>o.id===state.cashBankId))
    :!C.fresh(state.cashGelUpdated);
  const bybitStale=!C.fresh(state.bybitGelUpdated);
  const comparisonStale=(Number.isFinite(cash)&&cashStale)||(Number.isFinite(bybit)&&bybitStale);

  $("cashAvgLabel").textContent=Number.isFinite(usdAvg)?"Средняя покупок USD":"Оценка доллара";
  $("cashAvg").textContent=usdCost>0?`${fmtRate(usdCost)} ₽/$`:"Добавьте покупку";
  $("usdtAvg").textContent=Number.isFinite(usdtAvg)?`${fmtRate(usdtAvg)} ₽/USDT`:"Добавьте покупку";
  $("cashGelRate").textContent=Number(state.cashGelRate)>0?`${fmtRate(state.cashGelRate)} ₾`:"Обновите курс";
  $("bybitGelRate").textContent=bybitRate>0?`${fmtRate(bybitRate)} ₾`:"Обновите курс";
  $("bybitRateLabel").textContent=state.bybitRateMode==="actual"?"Эффективно за 1 USDT":"Bybit за 1 USDT";
  $("cashPrice").textContent=Number.isFinite(cash)?`${fmtRate(cash)} ₽/₾`:"—";
  $("bybitPrice").textContent=Number.isFinite(bybit)?`${fmtRate(bybit)} ₽/₾`:"—";
  $("cashExplain").textContent=Number.isFinite(cash)?`${fmtRate(cash)} ₽`:"Недостаточно данных";
  $("bybitExplain").textContent=Number.isFinite(bybit)?`${fmtRate(bybit)} ₽`:"Недостаточно данных";
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
  $("cashTotal").textContent=Number.isFinite(cash)&&!invalidQuantity?"≈ "+fmtRub(totals.cash)+" ₽":"— ₽";
  $("bybitTotal").textContent=Number.isFinite(bybit)&&!invalidQuantity?"≈ "+fmtRub(totals.bybit)+" ₽":"— ₽";
  fitMoney($("cashTotal"));fitMoney($("bybitTotal"));
  const cashSource=state.cashOfficeId?(C.OFFICES[state.cashOfficeId]?.name||"Обменник"):(state.cashBankId?state.cashBankName:"Ваш курс");
  $("cashSummary").textContent=!(usdCost>0)?"Не указана цена покупки USD":!(Number(state.cashGelRate)>0)?"Выберите курс USD → лари":cashSource+" · "+(cashStale?"нужна проверка":checkedText(state.cashGelUpdated))+(Number.isFinite(usdAvg)?"":" · цена USD — оценка");
  $("bybitSummary").textContent=!Number.isFinite(usdtAvg)?"Не указана цена покупки USDT":!(bybitRate>0)?"Укажите списание по покупке в Bybit":(state.bybitRateMode==="actual"?"По операции":"Прогноз")+" · "+(bybitStale?"обновите Bybit":checkedText(state.bybitGelUpdated));
  $("cashCompareAction").textContent=!(usdCost>0)?"Добавить покупку USD":"Изменить курс";
  $("bybitCompareAction").textContent=!Number.isFinite(usdtAvg)?"Добавить покупку USDT":"Обновить Bybit";
  $("cashSummary").classList.toggle("stale",Number.isFinite(cash)&&cashStale);
  $("bybitSummary").classList.toggle("stale",Number.isFinite(bybit)&&bybitStale);
  $("dataUsdAvg").textContent=(!Number.isFinite(usdAvg)&&usdCost>0?"Оценка: ":"")+$("cashAvg").textContent;
  $("dataUsdtAvg").textContent=$("usdtAvg").textContent;
  $("cashCard").classList.toggle("best",both&&!comparisonStale&&!invalidQuantity&&cashOrder<0);
  $("bybitCard").classList.toggle("best",both&&!comparisonStale&&!invalidQuantity&&cashOrder>0);
  $("quickRub").textContent=Number.isFinite(best)&&!invalidQuantity?`${fmtRub(bestTotal)} ₽`:"— ₽";

  if(Number.isFinite(cash)&&Number.isFinite(bybit)){
    const saving=D.abs(D.sub(totals.cash,totals.bybit));
    $("heroRoute").textContent=D.compare(saving,0.005)<0
      ?"Оба способа одинаковы с точностью до копейки"
      :`${bestName} дешевле примерно на ${fmtRub(saving)} ₽`;
    $("heroDetail").textContent="Оценка по вашим данным.";
  }else if(Number.isFinite(best)){
    $("heroRoute").textContent=`Расчёт по способу «${bestName}»`;
    $("heroDetail").textContent="Добавьте данные второго способа для сравнения.";
  }else{
    $("heroRoute").textContent="Сначала укажите покупку USD или USDT";
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

  renderRubles({usdAvg,usdCost,usdtAvg,cash,bybit,bybitRate,cashStale,bybitStale,totals,invalidQuantity});

  $("marketPrice").textContent=Number.isFinite(benchmark)?`${fmtRate(benchmark)} ₽/₾`:"—";
  if(state.officialUpdated&&Number.isFinite(benchmark)){
    const sourceDate=key=>state.officialSnapshot?.sources?.[key]?.date?.slice(0,10)||"неизвестна";
    const old=officialFailed||!C.fresh(state.officialSnapshot?.fetchedAt,2*C.DAY)||[sourceDate("usdRub"),sourceDate("usdGel")].some(d=>Date.now()-Date.parse(d)>7*C.DAY);
    $("marketStamp").textContent=`ЦБ РФ: ${sourceDate("usdRub")} · НБГ: ${sourceDate("usdGel")}${old?" · сохранённые данные":""}`;
    $("marketStatus").textContent=Number.isFinite(best)
      ?`${best/benchmark-1>=0?"+":""}${fmt((best/benchmark-1)*100,1)}%`
      :"ориентир";
    if(Number.isFinite(best)){
      const benchmarkTotal=D.mul(D.div(state.officialUsdRub,state.officialUsdGel),quantity);
      const difference=D.sub(bestTotal,benchmarkTotal);
      $("marketNote").textContent=`По официальному курсу ${fmt(quantity)} ₾ ≈ ${fmtRub(benchmarkTotal)} ₽. Минимальная оценка по вашим данным ${D.compare(difference,0)>=0?"дороже":"ниже"} на ${fmtRub(D.abs(difference))} ₽.${comparisonStale?" Личные курсы тоже требуют обновления.":""}`;
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

function fitMoney(element){
  const length=element.textContent.length;
  element.dataset.moneySize=length>24?"extra-long":length>18?"long":length>12?"medium":"normal";
}
function renderRubles(values){
  const {usdAvg,usdCost,usdtAvg,cash,bybit,bybitRate,cashStale,bybitStale,totals,invalidQuantity}=values;
  const isCash=selectedPayment==="cash";
  const rate=isCash?cash:bybit;
  const basis=isCash?usdCost:usdtAvg;
  const conversion=isCash?Number(state.cashGelRate):bybitRate;
  const hasBasis=Number.isFinite(basis)&&basis>0;
  const hasRate=Number.isFinite(conversion)&&conversion>0;
  const estimated=isCash&&hasBasis&&!Number.isFinite(usdAvg);
  const stale=isCash?cashStale:bybitStale;
  const ready=Number.isFinite(rate)&&rate>0;
  const currency=isCash?"USD":"USDT";
  $("cashPaymentButton").setAttribute("aria-pressed",String(isCash));
  $("bybitPaymentButton").setAttribute("aria-pressed",String(!isCash));
  $("rublesResultLabel").textContent=invalidQuantity?"Введите цену в лари":ready?"Для вас это примерно":"Для пересчёта нужны ваши данные";
  $("rublesResult").textContent=ready&&!invalidQuantity?"≈ "+fmtRub(isCash?totals.cash:totals.bybit)+" ₽":"— ₽";
  fitMoney($("rublesResult"));
  $("rublesRate").textContent=ready?"1 ₾ = "+fmtRate(rate)+" ₽ · "+(isCash?"наличными":"картой Bybit"):isCash?"Рубли → доллары → лари":"Рубли → USDT → оплата картой";
  let status;
  if(!hasBasis)status=isCash?"Укажите, сколько рублей потратили на доллары. Тогда посчитаем вашу цену, а не официальный курс.":"Укажите, сколько рублей потратили на USDT для карты.";
  else if(!hasRate)status=isCash?"Выберите обменник во вкладке «Обмен». Его курс подставится сюда.":"Укажите сумму прошлой покупки в лари и списание в USDT из Bybit.";
  else if(stale)status=isCash?(state.cashBankId||state.cashOfficeId?"Расчёт по сохранённому курсу. Проверьте его во вкладке «Обмен».":"Расчёт по сохранённому курсу. Обновите свой USD → GEL перед обменом."):"Расчёт по сохранённым данным Bybit. Обновите курс или укажите недавнюю операцию.";
  else status=isCash?"Учтены цена ваших долларов и выбранный курс обмена.":state.bybitRateMode==="actual"?"Учтены цена ваших USDT и списание по прошлой операции.":"Это прогноз по введённому курсу и вашим процентам, не гарантия списания.";
  if(isCash&&hasRate)status+=" Источник: "+(state.cashOfficeId?(C.OFFICES[state.cashOfficeId]?.name||"обменник"):state.cashBankId?state.cashBankName:"мой ручной курс")+".";
  if(estimated&&hasRate)status+=" Цена доллара пока взята из вашей оценки, не из покупок.";
  $("rublesStatus").textContent=status;
  $("rublesStatus").classList.toggle("stale",ready&&(stale||estimated));
  const action=!hasBasis?"basis":!hasRate||stale?"rate":estimated?"basis":"";
  $("rublesNextAction").hidden=!action||invalidQuantity;
  $("rublesNextAction").dataset.action=action;
  const editRateLabel=isCash?(hasRate&&!state.cashBankId&&!state.cashOfficeId?"Обновить мой курс":"Выбрать курс обмена"):state.bybitRateMode==="quote"&&hasRate?"Обновить курс Bybit":"Указать списание Bybit";
  $("rublesNextAction").textContent=action==="basis"?"Указать покупку "+currency:editRateLabel;
  $("paymentSetupTitle").textContent=ready?"Мой курс: откуда взялась сумма":"Что нужно для расчёта";
  $("paymentSetupHelp").textContent=isCash?"Сначала вы купили доллары за рубли, затем обменяли их на лари. Учитываем оба обмена.":"Сначала вы купили USDT за рубли, затем оплатили покупку картой. Учитываем цену USDT и фактическое списание или ваш прогноз.";
  $("basisStepTitle").textContent=isCash?"За сколько купили доллары":"За сколько купили USDT";
  $("basisStepValue").textContent=hasBasis?(estimated?"Ваша оценка: ":"Средняя ваших покупок: ")+fmtRate(basis)+" ₽ за 1 "+currency:"Пока нет данных о покупке за рубли.";
  $("basisStepButton").textContent="Добавить покупку "+currency;
  $("rateStepTitle").textContent=isCash?"Сколько лари дают за доллар":"Сколько USDT списывает карта";
  $("rateStepValue").textContent=hasRate?"1 "+currency+" = "+fmtRate(conversion)+" ₾"+(stale?" · нужно обновить":"")+(isCash?"":state.bybitRateMode==="actual"?" · по операции":" · прогноз"):isCash?"Возьмём курс из вкладки «Обмен».":"Нужна прошлая операция или введённый вами курс.";
  $("rateStepButton").textContent=editRateLabel;
}

function renderHistory(kind){
  const box=$(kind+"History");
  const list=(kind==="usd"?state.usdPurchases:state.usdtPurchases).filter(item=>item&&C.positive(item.rub)&&C.positive(item.qty)).slice().reverse();
  box.innerHTML=list.length?list.map(item=>{
    const rate=item.qty?item.rub/item.qty:0;
    return `<div class="row"><div>${fmtRub(item.rub)} ₽ → ${fmt(item.qty,kind==="usd"?2:4)} ${kind.toUpperCase()}</div><div class="r">${fmtRate(rate)} ₽<br>${new Date(item.ts).toLocaleDateString("ru-RU")}</div></div>`;
  }).join(""):'<div class="note">Покупок пока нет.</div>';
}

function closeAllInline(exceptId=""){
  document.querySelectorAll(".inline.show,.history.show").forEach(element=>{
    if(element.id!==exceptId)closeInline(element.id);
  });
}

function rateFields(){
  return {mode:rateMode,value:$("rateValue").value,gel:$("actualGel").value,charged:$("actualUsdt").value,reward:$("actualReward").value};
}
function rememberEditor(id){
  if(id==="purchasePanel"&&purchaseEditorReady)purchaseDrafts[purchaseKind]={rub:$("purchaseRub").value,qty:$("purchaseQty").value};
  if(id==="ratePanel"&&rateEditorReady){
    const fields=rateFields();
    if(JSON.stringify(fields)!==rateDraftBaseline)rateDrafts[rateKind]={...fields,baseline:rateDraftBaseline,rewardOpen:$("rewardDetails").open};
    else delete rateDrafts[rateKind];
  }
}
function closeInline(id){rememberEditor(id);$(id).classList.remove("show")}

function toggleHistory(id){
  const box=$(id);
  const willOpen=!box.classList.contains("show");
  closeAllInline(id);
  box.classList.toggle("show",willOpen);
}

function openPurchase(kind){
  if(currentView==="exchange")showView("purchase");
  if(currentView==="purchase")setPayment(kind==="usd"?"cash":"bybit");
  const panel=$("purchasePanel");
  const host=$(currentView==="data"?"purchaseDataHost":"rublesEditorHost");
  const willOpen=!panel.classList.contains("show")||panel.parentElement!==host||purchaseKind!==kind;
  if(!willOpen){closeInline("purchasePanel");return;}
  rememberEditor("purchasePanel");
  closeAllInline("purchasePanel");
  purchaseKind=kind;
  purchaseEditorSequence++;
  purchaseEditorReady=true;
  $("purchaseTitle").textContent=kind==="usd"?"Купил наличные USD":"Купил USDT";
  $("purchaseUnit").textContent=kind.toUpperCase();
  $("purchaseRub").value=purchaseDrafts[kind]?.rub||"";
  $("purchaseQty").value=purchaseDrafts[kind]?.qty||"";
  updatePurchasePreview();
  $("purchaseError").classList.remove("show");
  host.appendChild(panel);
  panel.classList.toggle("show",willOpen);
  $("purchaseChooser").hidden=true;$("buyCurrencyButton").setAttribute("aria-expanded","false");
  focusEditor("purchasePanel","purchaseRub");
}

function focusEditor(panelId,inputId){
  setTimeout(()=>{
    const panel=$(panelId),host=panel.parentElement;
    if(!panel.classList.contains("show")||!host)return;
    const view=host===$("rublesEditorHost")?"purchase":host===$("cashRateHost")?"exchange":"data";
    if(currentView!==view)return;
    $(inputId).focus({preventScroll:true});
    panel.scrollIntoView?.({block:"start",behavior:"instant"});
  },50);
}

function updatePurchasePreview(){
  const rub=numberValue($("purchaseRub").value);
  const quantity=numberValue($("purchaseQty").value);
  if(rub>0&&quantity>0){
    const list=purchaseKind==="usd"?state.usdPurchases:state.usdtPurchases;
    const newAverage=weighted([...list,{rub,qty:quantity}]);
    $("purchasePreview").textContent=`Эта покупка: ${fmtRate(rub/quantity)} ₽/${purchaseKind.toUpperCase()} · новая средняя: ${fmtRate(newAverage)} ₽`;
  }else{
    $("purchasePreview").textContent="Цена покупки рассчитается автоматически.";
  }
  $("purchaseError").classList.remove("show");
}

async function savePurchase(){
  // Consume one editor submission, not all future editors while a write is pending.
  // The personal queue already serializes distinct purchases safely.
  if(!purchaseEditorReady)return;
  const rub=numberValue($("purchaseRub").value);
  const quantity=numberValue($("purchaseQty").value);
  if(!(rub>0&&quantity>0&&rub<=1e12&&quantity<=1e12&&Number.isFinite(rub/quantity))){
    $("purchaseError").textContent="Введите, сколько рублей потратили и сколько валюты получили.";
    $("purchaseError").classList.add("show");
    return;
  }
  const field=purchaseKind==="usd"?"usdPurchases":"usdtPurchases";
  const item={rub,qty:quantity,ts:Date.now()};
  const submittedEditor=purchaseEditorSequence,returnView=currentView;
  closeInline("purchasePanel");
  delete purchaseDrafts[purchaseKind];purchaseEditorReady=false;
  await changePersonal(next=>{next[field].push(item);});
  if(returnView==="purchase"&&currentView===returnView&&purchaseEditorSequence===submittedEditor&&!purchaseEditorReady){
    setPayment(field==="usdPurchases"?"cash":"bybit");showView("purchase");
  }
  announce(volatilePersonal?"Покупка добавлена только в этой вкладке":"Покупка сохранена. Цена в рублях пересчитана.");
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
  if(currentView==="data"||(kind==="bybit"&&currentView==="exchange"))showView("purchase");
  if(currentView==="purchase")setPayment(kind==="cash"?"cash":"bybit");
  const panel=$("ratePanel");
  const host=$(kind==="cash"&&currentView==="exchange"?"cashRateHost":"rublesEditorHost");
  const willOpen=!panel.classList.contains("show")||panel.parentElement!==host||rateKind!==kind;
  if(!willOpen){closeInline("ratePanel");return;}
  rememberEditor("ratePanel");
  closeAllInline("ratePanel");
  rateKind=kind;
  rateEditorReady=true;
  $("rateTitle").textContent=kind==="cash"?"Обновить USD → ₾":"Обновить Bybit → ₾";
  $("rateLabel").textContent=kind==="cash"?"Сейчас за 1 USD дают":"Сейчас за 1 USDT дают";
  $("bybitModeSwitch").hidden=kind==="cash";
  $("quoteHelp").hidden=kind==="cash";
  const draft=rateDrafts[kind];
  $("rateValue").value=draft?.value??inputValue(kind==="cash"?state.cashGelRate:state.bybitGelRate);
  $("actualGel").value=draft?.gel??"";
  $("actualUsdt").value=draft?.charged??"";
  $("actualReward").value=draft?.reward??"";
  $("rewardDetails").open=draft?.rewardOpen||false;
  $("rateError").classList.remove("show");
  setRateMode(kind==="cash"?"quote":draft?.mode||(state.bybitRateMode==="quote"&&C.positive(state.bybitGelRate)?"quote":"actual"));
  rateDraftBaseline=draft?.baseline??JSON.stringify(rateFields());
  host.appendChild(panel);
  panel.classList.toggle("show",willOpen);
  focusEditor("ratePanel",rateMode==="quote"?"rateValue":"actualGel");
}

function updateRatePreview(){
  const {usdCost,usdtAvg,mult}=routeValues();
  let text="";
  if(rateKind==="cash"){
    const rate=numberValue($("rateValue").value);
    const amount=numberValue($("exchangeAmount").value);
    if(rate>0&&currentView==="exchange"&&amount>0&&amount<=1e9)text=`За ${fmt(amount)} USD получите ≈ ${money(D.mul(amount,rate))} ₾ по этому курсу.`;
    if(rate>0&&usdCost>0)text+=(text?" ":"")+`При этом курсе 1 ₾ будет стоить вам ${fmtRate(usdCost/rate)} ₽.`;
  }else if(rateMode==="quote"){
    const rate=numberValue($("rateValue").value);
    if(rate>0&&Number.isFinite(usdtAvg))text=`С учётом комиссии и cashback 1 ₾ ≈ ${fmtRate(usdtAvg*mult/rate)} ₽.`;
  }else{
    const gel=numberValue($("actualGel").value);
    const charged=numberValue($("actualUsdt").value);
    if(gel>0&&charged>0){
      const effective=C.actualRate(gel,charged,$("actualReward").value.trim()||"0");
      if(!Number.isFinite(effective))return $("ratePreview").textContent="Возврат должен быть не меньше 0 и меньше списания.";
      text=`Эффективный курс: 1 USDT = ${fmtRate(effective)} ₾`;
      if(Number.isFinite(usdtAvg))text+=` · 1 ₾ ≈ ${fmtRate(usdtAvg/effective)} ₽`;
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
  const savedKind=rateKind,returnView=currentView;
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
  delete rateDrafts[savedKind];rateEditorReady=false;
  try{
    await changePersonal(next=>Object.assign(next,patch));
    if(savedKind==="cash"){selectedOffer="manual";offerSelectionExplicit=true;}
    setPayment(savedKind==="cash"?"cash":"bybit");
    if(currentView===returnView)showView(savedKind==="cash"&&returnView==="exchange"?"exchange":"purchase");
    announce(volatilePersonal?"Курс изменён только в этой вкладке":savedKind==="cash"&&returnView==="exchange"?"Мой курс сохранён. Сумма обмена пересчитана.":"Курс сохранён. Введите цену покупки в лари.");
  }
  finally{rateSaving=false;}
}

function openSettings(){
  const panel=$("settingsPanel");
  const willOpen=!panel.classList.contains("show");
  closeAllInline("settingsPanel");
  $("officialRub").value=officialReady?fmtRate(state.officialUsdRub):"";
  $("officialGel").value=officialReady?fmtRate(state.officialUsdGel):"";
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
    $("officialRub").value=officialReady?fmtRate(state.officialUsdRub):"";
    $("officialGel").value=officialReady?fmtRate(state.officialUsdGel):"";
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
      $("bankChoice").add(new Option(item.bank+" · "+fmtRate(item.buy)+" ₾"+(cost>0?" · "+fmtRate(cost/item.buy)+" ₽/₾":""),item.id));
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
  $("bankPreview").textContent=item?item.bank+": за 100 USD ≈ "+money(D.mul(item.buy,100))+" GEL до возможных комиссий. После выбора курс этого банка будет обновляться из опубликованных данных.":"Список отсортирован по курсу покупки USD: больше лари за доллар — выше в списке.";
  if(item&&!enabled)$("bankPreview").textContent="Применение отключено: набор устарел или источник недоступен. Проверьте данные либо укажите свой курс вручную.";
}
async function applyBank(){
  const item=banks?.offers.find(o=>o.id===$("bankChoice").value);
  if(!item||bankFailed||!C.fresh(banks.fetchedAt,2*3600000))return;
  const patch={cashBankId:item.id,cashBankName:item.bank,cashOfficeId:null,cashGelRate:item.buy,cashGelUpdated:Date.parse(banks.fetchedAt)};
  closeInline("bankPanel");
  await changePersonal(next=>Object.assign(next,patch));
  selectedOffer="bank:"+item.id;offerSelectionExplicit=false;
  setPayment("cash");showView("purchase");announce(volatilePersonal?"Курс изменён только в этой вкладке":"Курс "+item.bank+" выбран. Введите цену покупки в лари.");
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
  const manualRows=!state.cashBankId&&!state.cashOfficeId&&C.positive(state.cashGelRate)?[{
    key:"manual",id:"manual",name:"Мой курс",buy:C.number(state.cashGelRate),checkedAt:state.cashGelUpdated,
    fresh:C.fresh(state.cashGelUpdated),kind:"manual",url:null,branches:null
  }]:[];
  // The personal quote is not a bank recommendation and is never sorted as one.
  return [...manualRows,...[...officeRows,...bankRows].sort((a,b)=>Number(b.fresh)-Number(a.fresh)||b.buy-a.buy||a.name.localeCompare(b.name))];
}
function selectOffer(key){
  if(!offersForCity().some(row=>row.key===key))return;
  expandedOffer=expandedOffer===key?"":key;
  selectedOffer=key;offerSelectionExplicit=true;renderOffers();
}
function closeOfferLocation(){
  const key=expandedOffer;expandedOffer="";renderOffers();
  [...$("offerList").children].find(node=>node.dataset.offerKey===key)?.focus({preventScroll:true});
}
function renderOfferLocation(item){
  const panel=$("offerLocationPanel");panel.hidden=!item;
  if(!item)return;
  const city=$("exchangeCity").value||"tbilisi";
  const branches=item.kind==="office"&&L?L.branches(item.id,city):[];
  $("branchHeading").textContent=item.name+" · адреса";
  $("branchChoiceGroup").hidden=branches.length<2;
  $("branchSource").hidden=!item.branches;
  $("branchSource").href=item.branches||"";
  const optionsKey=item.key+":"+city;
  if(branchOptionsKey!==optionsKey){
    $("branchChoice").replaceChildren(...branches.map(row=>new Option(row.address,row.id)));
    branchOptionsKey=optionsKey;
  }
  const branch=branches.find(row=>row.id===branchSelection[optionsKey])||branches[0];
  $("branchChoice").value=branch?.id||"";
  $("branchAddress").hidden=!branch;
  $("branchAddress").textContent=branch?.address||"";
  $("branchNotice").textContent=item.kind==="office"
    ?"Адрес сети — не подтверждение курса в этой кассе. Уточните курс, наличие валюты и часы работы."
    :item.kind==="bank"?"Источник курса не указывает конкретное отделение. На карте — поиск банка, не подтверждённая касса с этим курсом."
    :"Ваш ручной курс не привязан к обменному пункту. Выберите обменник из списка, чтобы увидеть адреса.";
  if(item.kind==="office"&&!branch)$("branchNotice").textContent+=" Адреса для выбранного города недоступны в приложении. Откройте официальный список отделений.";
  const links=branch?L.branchLinks(branch):item.kind==="bank"&&L?L.bankSearch(item.name,city):null;
  $("branchMapActions").hidden=!links;
  for(const [id,key] of [["branchGoogle","google"],["branchApple","apple"],["branchYandex","yandex"]]){
    $(id).href=links?.[key]||"";
    $(id).setAttribute("aria-label",$(id).textContent+" — "+(branch?.address||"поиск отделений "+item.name));
  }
  $("branchMapHint").textContent=branch?(branch.point?"Маршрут к точке на карте. Проверьте вход в отделение.":"Точная точка не подтверждена. Кнопки открывают поиск адреса, не готовый маршрут: проверьте найденное здание."):links?"Выберите отделение в картах и уточните условия обмена.":"";
  $("branchChecked").textContent=branch?"Адрес сверён "+new Date(branch.checkedAt).toLocaleDateString("ru-RU")+" · список неполный."+(C.fresh(branch.checkedAt,90*C.DAY)?"":" Адрес давно не проверялся — уточните его у сети."):"";
}
function selectBranch(){
  const item=offersForCity().find(row=>row.key===expandedOffer);
  if(!item||!L)return;
  const city=$("exchangeCity").value||"tbilisi";
  if(!L.branches(item.id,city).some(row=>row.id===$("branchChoice").value))return;
  branchSelection[item.key+":"+city]=$("branchChoice").value;
  renderOfferLocation(item);
}
function toggleAllOffers(){allOffers=!allOffers;renderOffers();}
function renderOffers(){
  const rows=offersForCity();
  if(!offerSelectionExplicit||!rows.some(row=>row.key===selectedOffer)){
    const active=state.cashOfficeId?"office:"+state.cashOfficeId:state.cashBankId?"bank:"+state.cashBankId:C.positive(state.cashGelRate)?"manual":"";
    selectedOffer=rows.some(row=>row.key===active)?active:rows[0]?.key||"";
  }
  const amount=numberValue($("exchangeAmount").value);
  const valid=amount>0&&amount<=1e9;
  $("exchangeError").textContent=valid?"":"Введите сумму от 0 до 1 млрд USD, больше нуля.";
  $("exchangeError").classList.toggle("show",!valid);
  $("exchangeAmount").setAttribute("aria-invalid",String(!valid));
  const shown=allOffers?rows:rows.slice(0,3);
  if(!shown.some(row=>row.key===expandedOffer))expandedOffer="";
  // Keep a user's focused row during a background re-render.
  const focused=document.activeElement?.dataset?.offerKey;
  const focusedBranch=document.activeElement?.id;
  const locationPanel=$("offerLocationPanel");
  $("locationPanelHome").appendChild(locationPanel);
  const nodes=shown.map(item=>{
    const button=document.createElement("button");button.type="button";button.className="offer-row";
    button.dataset.offerKey=item.key;button.setAttribute("aria-pressed",String(item.key===selectedOffer));
    button.setAttribute("aria-expanded",String(item.key===expandedOffer));
    button.setAttribute("aria-controls","offerLocationPanel");
    const top=document.createElement("span");top.className="offer-top";
    const name=document.createElement("strong");name.textContent=item.name;
    const total=document.createElement("b");total.textContent=valid?money(D.mul(amount,item.buy))+" ₾":"— ₾";
    top.appendChild(name);top.appendChild(total);button.appendChild(top);
    const detail=document.createElement("small");
    detail.textContent=(item.kind==="manual"?"Введён вами":item.kind==="office"?"Обменник · курс сети":"Банк · город уточните")+" · "+fmtRate(item.buy)+" ₾/$"+(item.fresh?"":" · нужна проверка");
    button.appendChild(detail);button.addEventListener("click",()=>selectOffer(item.key));return button;
  });
  const withLocation=nodes.flatMap(node=>node.dataset.offerKey===expandedOffer?[node,locationPanel]:[node]);
  $("offerList").replaceChildren(...withLocation);$("offerList").hidden=!rows.length;
  renderOfferLocation(rows.find(row=>row.key===expandedOffer));
  if(focused)nodes.find(node=>node.dataset.offerKey===focused)?.focus({preventScroll:true});
  else if(expandedOffer&&focusedBranch&&["branchChoice","branchGoogle","branchApple","branchYandex","branchSource","closeLocationButton"].includes(focusedBranch))$(focusedBranch).focus({preventScroll:true});
  $("moreOffers").hidden=rows.length<=3;
  $("moreOffers").textContent=allOffers?"Свернуть список":"Все предложения ("+rows.length+")";
  $("moreOffers").setAttribute("aria-expanded",String(allOffers));
  const available=rows.filter(row=>row.kind!=="manual"&&row.fresh).length;
  $("offerStatus").textContent=available?"Проверено предложений: "+available+". До комиссий.":officeBusy||bankBusy?"Загружаем курсы…":"Свежие предложения банков и обменников недоступны. Их сохранённые курсы — только для справки.";
  if(officeFailed||offices?.failures.length)$("offerStatus").textContent+=" Часть обменников не прошла проверку.";
  const item=rows.find(row=>row.key===selectedOffer);
  $("exchangeReceive").textContent=item&&valid?"≈ "+money(D.mul(amount,item.buy))+" ₾":"— ₾";
  $("exchangeResultLabel").textContent=item?(item.kind==="manual"?"Мой курс · "+fmtRate(item.buy)+" ₾/$"+(item.fresh?"":" · нужна проверка"):(item.fresh?"По предложению ":"Сохранённый курс · ")+item.name):"Выберите предложение";
  const {usdCost,exact}=routeValues();
  $("exchangeBasis").textContent=valid&&item?(usdCost>0?"Эти USD стоили вам ≈ "+fmtRub(D.mul(amount,exact.usdCost))+" ₽ · 1 ₾ ≈ "+fmtRate(usdCost/item.buy)+" ₽":"Добавьте покупку USD, чтобы увидеть стоимость в рублях."):"";
  $("selectedOfferDetail").textContent=item?(item.kind==="manual"?freshnessText(item.checkedAt,"USD→GEL").text+". Введён вами, не котировка банка или обменника."+(item.fresh?"":" Проверьте перед обменом."):"Проверено "+checkedText(item.checkedAt)+". "+(item.kind==="office"?"Курс сети. Наличие и условия уточните в отделении.":"Витрина НБГ: отделение, запрос на 1 000 GEL. Для вашей суммы условия могут отличаться.")+(item.fresh?"":" Применение отключено: данные устарели или не подтверждены.")):"Можно ввести свой проверенный курс ниже.";
  $("selectedSource").hidden=!item?.url;$("selectedBranches").hidden=!item?.branches;
  $("selectedSource").href=item?.url||"";$("selectedBranches").href=item?.branches||"";
  $("applyOfferButton").disabled=!(item&&(item.kind==="manual"||item.fresh)&&valid);
  $("applyOfferButton").textContent=item?.kind==="manual"?"Открыть расчёт в ₽ по моему курсу":item?"Выбрать "+item.name+" для расчёта в ₽":"Выбрать курс для пересчёта в ₽";
}
async function applyOffer(){
  const item=offersForCity().find(row=>row.key===selectedOffer);
  const amount=numberValue($("exchangeAmount").value);
  if(!item||!(amount>0&&amount<=1e9))return;
  if(item.kind==="manual"){
    // Already saved: opening the RUB view must not refresh the manual timestamp.
    setPayment("cash");showView("purchase");return;
  }
  if(!item.fresh)return;
  const patch={cashOfficeId:item.kind==="office"?item.id:null,cashBankId:item.kind==="bank"?item.id:null,
    cashBankName:item.kind==="bank"?item.name:null,cashGelRate:item.buy,cashGelUpdated:Date.parse(item.checkedAt)};
  await changePersonal(next=>Object.assign(next,patch));
  selectedOffer=item.key;offerSelectionExplicit=false;
  setPayment("cash");showView("purchase");announce(volatilePersonal?"Курс изменён только в этой вкладке":"Курс "+item.name+" выбран. Введите цену покупки в лари.");
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

$("exchangeAmount").addEventListener("input",()=>{renderOffers();if(rateKind==="cash"&&$("ratePanel").classList.contains("show"))updateRatePreview();});
$("exchangeCity").addEventListener("change",()=>{selectedOffer="";expandedOffer="";offerSelectionExplicit=false;allOffers=false;renderOffers();});
$("branchChoice").addEventListener("change",selectBranch);
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
