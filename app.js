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
  let text=typeof value==="string"?value.trim().replace(/\s/g,"").replace(",","."):String(C.number(value));
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
const exchangeMeta={USD:{name:"долларах",unit:"USD",nominal:1},EUR:{name:"евро",unit:"EUR",nominal:1},RUB:{name:"рублях",unit:"₽",nominal:100}};
let exchangeCurrency="USD",manualEditorCurrency="EUR",manualEditorBaseline="";
const exchangeDrafts={},manualDrafts={},manualRecords={},manualBlocked={};
const extraMarkets={EUR:{banks:null,offices:null,bankFailed:false,officeFailed:false,bankBusy:false,officeBusy:false},RUB:{banks:null,offices:null,bankFailed:false,officeFailed:false,bankBusy:false,officeBusy:false}};
const chosenCity=()=>$("exchangeCity").value||"batumi";
const marketFor=currency=>currency==="USD"?{banks,offices,bankFailed,officeFailed,bankBusy,officeBusy}:extraMarkets[currency];
const offerKey=(kind,currency,id="")=>kind+(currency==="USD"?"":":"+currency)+(id?":"+id:"");
const quoteText=(currency,rate)=>exchangeMeta[currency].nominal+" "+exchangeMeta[currency].unit+" = "+fmtRate(rate*exchangeMeta[currency].nominal)+" ₾";
// Currency nominal scaling is exact; serializing a binary division would lose half-tetri boundaries.
function decimalText(value){
  const exact=D.from(value);if(!exact)return "";
  let remainder=exact.n%exact.d,text=String(exact.n/exact.d);
  if(remainder)text+=".";
  while(remainder){remainder*=10n;text+=String(remainder/exact.d);remainder%=exact.d;}
  return text;
}
const nominalQuote=(rate,nominal)=>decimalText(D.mul(rate,nominal));
let currentView="exchange",selectedPayment="cash",selectedOffer="",offerSelectionExplicit=false,allOffers=false,statusTimer;
let expandedOffer="",branchOptionsKey="";
const branchSelection={};
const androidMaps=/Android/i.test(navigator.userAgent||"");
const appleMaps=/(iPhone|iPad|iPod|Macintosh)/i.test(navigator.userAgent||"");
const QUOTE_TTL=2*3600000;
const plan={from:"RUB",to:"GEL",via:"USD",mode:"give",quotes:{},quoteMeta:{},fees:{},sourceKey:"",sourceCurrency:"USD",sourceCity:"batumi",initialized:false};
let planQuoteSelection=null;
let planSourceChosen=false,planReplacement=null;
let settingsDraft=null,settingsBaseline="",settingsPending=0;
const planNames={RUB:"Рубли",USD:"Доллары",EUR:"Евро",USDT:"USDT",GEL:"Лари"};
const planUnits={RUB:"₽",USD:"USD",EUR:"EUR",USDT:"USDT",GEL:"₾"};
const planLegs={
  RUBUSD:{quote:"rubBuy",label:"Покупаю 1 USD за рубли",unit:"₽"},
  USDRUB:{quote:"rubSell",label:"Продаю 1 USD за рубли",unit:"₽"},
  USDGEL:{quote:"gelBuy",label:"Продаю 1 USD за лари",unit:"₾",side:"buy",currency:"USD",nominal:1},
  GELUSD:{quote:"gelSell",label:"Покупаю 1 USD за лари",unit:"₾",side:"sell",currency:"USD",nominal:1},
  EURGEL:{quote:"gelEurBuy",label:"Продаю 1 EUR за лари",unit:"₾",side:"buy",currency:"EUR",nominal:1},
  GELEUR:{quote:"gelEurSell",label:"Покупаю 1 EUR за лари",unit:"₾",side:"sell",currency:"EUR",nominal:1},
  RUBGEL:{quote:"gelRubBuy",label:"Продаю 100 ₽ за лари",unit:"₾",side:"buy",currency:"RUB",nominal:100},
  GELRUB:{quote:"gelRubSell",label:"Покупаю 100 ₽ за лари",unit:"₾",side:"sell",currency:"RUB",nominal:100},
  RUBUSDT:{quote:"rubUsdtBuy",label:"Покупаю 1 USDT за рубли",unit:"₽"},
  USDTRUB:{quote:"rubUsdtSell",label:"Продаю 1 USDT за рубли",unit:"₽"},
  USDTGEL:{quote:"gelUsdtBuy",label:"Продаю 1 USDT за лари",unit:"₾"},
  GELUSDT:{quote:"gelUsdtSell",label:"Покупаю 1 USDT за лари",unit:"₾"},
  USDUSDT:{quote:"usdUsdtBuy",label:"Покупаю 1 USDT за доллары",unit:"USD"},
  USDTUSD:{quote:"usdUsdtSell",label:"Продаю 1 USDT за доллары",unit:"USD"}
};
function plannerPath(){return plan.via!=="direct"&&[plan.from,plan.to].every(c=>c==="RUB"||c==="GEL")&&plan.from!==plan.to?[plan.from,plan.via,plan.to]:[plan.from,plan.to];}
function plannerRows(){const path=plannerPath();return path.slice(0,-1).map((from,i)=>({from,to:path[i+1],key:from+path[i+1],...planLegs[from+path[i+1]]}));}
function setPlanMode(mode){if(!["give","want"].includes(mode))return;plan.mode=mode;renderPlanner();}
function changePlanRoute(changed){
  plan.from=$("planFrom").value;plan.to=$("planTo").value;plan.via=$("planVia").value;
  if(changed&&[plan.from,plan.to].includes("EUR")&&![plan.from,plan.to].includes("GEL")){
    if(changed==="from")plan.to="GEL";else plan.from="GEL";
    announce("Для евро доступен обмен с лари.");
  }
  if(plan.via==="direct"&&![plan.from,plan.to].every(c=>c==="RUB"||c==="GEL")&&!([plan.from,plan.to].includes("EUR")&&[plan.from,plan.to].includes("GEL")))plan.via="USD";
  renderPlanner();
}
function reversePlan(){[plan.from,plan.to]=[plan.to,plan.from];renderPlanner();}
function editPlanQuote(index){const row=plannerRows()[index];if(row?.quote){plan.quotes[row.quote]=$("planQuote"+index).value;delete plan.quoteMeta[row.quote];renderPlanner();}}
function finishPlanQuote(index){
  const row=plannerRows()[index];if(!row?.quote||!Object.hasOwn(plan.quotes,row.quote)||!C.positive(plan.quotes[row.quote]))return;
  const [whole,fraction=""]=plan.quotes[row.quote].replace(/\s/g,"").replace(".",",").split(",");
  plan.quotes[row.quote]=whole+","+fraction.padEnd(4,"0");renderPlanner();
}
function editPlanFee(index){const row=plannerRows()[index];if(row?.quote){plan.fees[row.key]={pct:$("planPct"+index).value,fixed:$("planFixed"+index).value};renderPlanner();}}
function hasPlanDraft(){
  return Boolean($("planAmount").value.trim()||Object.keys(plan.quotes).length||Object.keys(plan.fees).length||planSourceChosen||
    plan.from!=="RUB"||plan.to!=="GEL"||plan.via!=="USD"||plan.mode!=="give");
}
function offerPlanIntent(){
  const item=offersForCity().find(row=>row.key===selectedOffer),amount=$("exchangeAmount").value;
  if(planQuoteSelection||editingExchangeRate()||!item||!C.positive(item.buy)||item.kind!=="manual"&&!item.fresh||!(C.number(amount)>0&&C.number(amount)<=1e9))return null;
  return {currency:exchangeCurrency,amount,city:chosenCity(),key:item.key,kind:item.kind,buy:item.buy,checkedAt:item.checkedAt,fresh:item.fresh};
}
function offerPlanFingerprint(intent){
  return JSON.stringify({intent,plan,amount:$("planAmount").value,sourceChosen:planSourceChosen});
}
function closePlanReplacement(){
  planReplacement=null;$("planReplacePanel").hidden=true;
  $("planOfferButton").setAttribute("aria-expanded","false");
}
function cancelOfferPlan(){closePlanReplacement();$("planOfferButton").focus();}
function startOfferPlan(intent){
  // A new calculation starts with exactly the exchange shown, without old fees or directed quotes.
  const leg=planLegs[intent.currency+"GEL"],manual=intent.kind==="manual";
  Object.assign(plan,{from:intent.currency,to:"GEL",via:intent.currency==="RUB"?"direct":"USD",mode:"give",
    quotes:manual?{[leg.quote]:inputValue(nominalQuote(intent.buy,leg.nominal))}:{},
    quoteMeta:manual?{[leg.quote]:{checkedAt:intent.checkedAt}}:{},fees:{},
    sourceKey:manual?"":intent.key,sourceCurrency:intent.currency,sourceCity:intent.city,initialized:true});
  $("planAmount").value=intent.amount;planSourceChosen=true;
  closePlanReplacement();showView("calculator");
}
function confirmOfferPlan(){
  if(!planReplacement)return;
  const intent=offerPlanIntent();
  if(currentView!=="exchange"||!intent||planReplacement!==offerPlanFingerprint(intent)){
    closePlanReplacement();announce("Данные изменились. Проверьте сумму и курс, затем начните расчёт снова.");
    if(currentView==="exchange"){
      renderOffers();
      ($("planOfferButton").hidden||$("planOfferButton").disabled?$("exchangeHeading"):$("planOfferButton")).focus();
    }
    return;
  }
  startOfferPlan(intent);
}
function useOfferForPlan(){
  const item=offersForCity().find(row=>row.key===selectedOffer);
  if(!item||editingExchangeRate()||item.kind!=="manual"&&!item.fresh)return;
  if(planQuoteSelection){
    const row=plannerRows().find(row=>row.key===planQuoteSelection.key);
    if(!row||exchangeCurrency!==row.currency){announce("Выберите курс для "+planQuoteSelection.currency+". Ваш расчёт сохранён.");return;}
    if((item.kind==="manual"&&row.side!=="buy")||!C.positive(item[row.side])){
      announce("Этот курс не подходит для направления вашего расчёта.");return;
    }
    plan.sourceCurrency=exchangeCurrency;plan.sourceCity=chosenCity();
    if(item.kind==="manual"){
      plan.sourceKey="";plan.quotes[row.quote]=inputValue(nominalQuote(item.buy,row.nominal));
      plan.quoteMeta[row.quote]={checkedAt:item.checkedAt};
    }else{
      plan.sourceKey=item.key;delete plan.quotes[row.quote];delete plan.quoteMeta[row.quote];
    }
    planSourceChosen=true;showView("calculator");return;
  }
  const intent=offerPlanIntent();if(!intent)return;
  if(!hasPlanDraft()){startOfferPlan(intent);return;}
  planReplacement=offerPlanFingerprint(intent);
  $("planReplaceText").textContent="Новый расчёт: "+intent.amount.trim().replace(".",",")+" "+planUnits[intent.currency]+" → лари, без учёта комиссий. Он заменит текущий черновик, включая его курсы и комиссии. Покупки и история сохранятся.";
  $("planReplacePanel").hidden=false;$("planOfferButton").setAttribute("aria-expanded","true");
  $("planReplaceText").focus();
}
function showPlanLocation(){
  const item=offersForCity(plan.sourceCurrency,plan.sourceCity).find(row=>row.key===plan.sourceKey);
  if(!item||item.kind==="manual")return;
  changeExchangeCurrency(plan.sourceCurrency);$("exchangeCity").value=plan.sourceCity;
  window.GamarjiWeather?.refresh?.();
  selectedOffer=item.key;offerSelectionExplicit=true;expandedOffer=item.key;
  showView("exchange");$("branchHeading").scrollIntoView?.({block:"start"});$("closeLocationButton").focus({preventScroll:true});
}
function choosePlanOffice(){
  const row=plannerRows().find(row=>row.side);
  if(!row){announce("Для этого направления введите свой курс в расчёте.");return;}
  planQuoteSelection={key:row.key,currency:row.currency,side:row.side};
  changeExchangeCurrency(row.currency);showView("exchange");
}
function renderPlanner(){
  $("planFrom").value=plan.from;$("planTo").value=plan.to;$("planVia").value=plan.via;
  const path=plannerPath(),rows=plannerRows(),source=offersForCity(plan.sourceCurrency,plan.sourceCity).find(row=>row.key===plan.sourceKey);
  const sourceOk=source&&source.kind!=="manual"&&source.fresh;
  const quotes={...plan.quotes},fees={};
  $("planViaGroup").hidden=!(plan.from!==plan.to&&[plan.from,plan.to].every(c=>c==="RUB"||c==="GEL"));
  $("planGive").setAttribute("aria-pressed",String(plan.mode==="give"));$("planWant").setAttribute("aria-pressed",String(plan.mode==="want"));
  $("planGive").classList.toggle("active",plan.mode==="give");$("planWant").classList.toggle("active",plan.mode==="want");
  const amountCurrency=plan.mode==="give"?plan.from:plan.to,resultCurrency=plan.mode==="give"?plan.to:plan.from;
  $("planAmountLabel").textContent=(plan.mode==="give"?"Отдаю · ":"Хочу получить · ")+planNames[amountCurrency];
  $("planAmountUnit").textContent=planUnits[amountCurrency];
  fitAmount($("planAmount"));
  $("planResultLabel").textContent=plan.mode==="give"?"Получите":"Понадобится";
  $("planPath").textContent=path.map(c=>planNames[c]).join(" → ");
  let usesPublic=false,stalePersonal=false;
  for(let i=0;i<2;i++){
    const row=rows[i];$("planStep"+i).hidden=!row?.quote;if(!row?.quote)continue;
    const manual=Object.hasOwn(plan.quotes,row.quote),auto=row.side&&!manual;
    const matchingSource=source?.currency===row.currency?source:null;
    if(auto){quotes[row.quote]=matchingSource&&sourceOk?nominalQuote(source[row.side],row.nominal):NaN;usesPublic=usesPublic||Boolean(matchingSource);}
    $("planStepTitle"+i).textContent=(i+1)+". "+planNames[row.from]+" → "+planNames[row.to];
    $("planQuoteLabel"+i).textContent=row.label;$("planQuoteUnit"+i).textContent=row.unit;
    $("planQuote"+i).value=manual?plan.quotes[row.quote]:auto&&matchingSource?inputValue(nominalQuote(source[row.side],row.nominal)):"";
    $("planQuote"+i).setAttribute("placeholder","Введите курс");
    const meta=plan.quoteMeta[row.quote],oldPersonal=Boolean(manual&&meta&&!C.fresh(meta.checkedAt));
    stalePersonal=stalePersonal||oldPersonal;
    $("planSource"+i).textContent=auto?(matchingSource?(source.name+" · "+(sourceOk?"проверено "+checkedText(source.checkedAt):"свежесть не подтверждена")+" · "+(row.side==="buy"?"покупает ":"продаёт ")+row.currency):"Выберите курс во вкладке «Обмен» или введите свой."):manual&&C.positive(plan.quotes[row.quote])?(meta?"Свой сохранённый курс · "+(meta.checkedAt?checkedText(meta.checkedAt):"дата неизвестна")+(oldPersonal?" · нужна проверка":""):"Свой курс"):"";
    $("planSource"+i).classList.toggle("stale",Boolean(auto&&matchingSource&&!sourceOk)||oldPersonal);
    const fee=plan.fees[row.key]||{pct:"0",fixed:"0"};fees[row.key]={pct:fee.pct===""?0:fee.pct,fixed:fee.fixed===""?0:fee.fixed};
    $("planPct"+i).value=fee.pct;$("planFixed"+i).value=fee.fixed;
    $("planFixedLabel"+i).textContent="Фиксированная, "+planUnits[row.from];
    $("planFeeHelp"+i).textContent="Сначала вычитаем фиксированную комиссию в "+planUnits[row.from]+", затем процент от остатка. Остальное обмениваем.";
    const pct=C.number(fees[row.key].pct),fixed=C.number(fees[row.key].fixed);
    const invalidPct=!Number.isFinite(pct)||pct<0||pct>=100,invalidFixed=!Number.isFinite(fixed)||fixed<0||fixed>1e9;
    const feeParts=[fixed>0?fmtRub(fees[row.key].fixed)+" "+planUnits[row.from]:"",pct>0?String(pct).replace(".",",")+"%":""].filter(Boolean);
    $("planFeeSummary"+i).textContent=invalidPct||invalidFixed?"Проверьте комиссию":feeParts.length?"Комиссия: "+feeParts.join(" + "):"Комиссия";
    $("planFeeSummary"+i).classList.toggle("stale",invalidPct||invalidFixed);
    $("planPct"+i).setAttribute("aria-invalid",String(invalidPct));$("planFixed"+i).setAttribute("aria-invalid",String(invalidFixed));
    $("planStepResult"+i).textContent="";
    const touched=$("planQuote"+i).value.trim()!=="";
    const quoteValue=C.number(quotes[row.quote]);
    const invalidQuote=touched&&!(quoteValue>=1e-8&&quoteValue<=1e9);
    $("planQuote"+i).setAttribute("aria-invalid",String(invalidQuote));
    $("planQuoteError"+i).textContent=invalidQuote?(auto&&source&&!sourceOk?"Курс не подтверждён. Выберите актуальный или введите свой.":"Курс — от 0,00000001 до 1 млрд."):"";
    $("planQuoteError"+i).classList.toggle("show",invalidQuote);
  }
  $("planChooseOffice").hidden=!rows.some(row=>row.side);
  $("planAddress").hidden=!usesPublic||!source;
  $("planAddress").textContent=source?"Адреса "+source.name:"Адреса обменника";
  const result=C.exchangePlan({from:plan.from,to:plan.to,via:plan.via,mode:plan.mode,amount:$("planAmount").value,quotes,fees});
  const messages={direction:"Выберите разные валюты.",amount:"Введите сумму больше нуля и не больше 1 млрд.",quote:"Введите курс на шаге "+((result.step??0)+1)+".",fee:"Проверьте комиссию шага "+((result.step??0)+1)+": процент от 0 до 100 (не включая 100), сумма неотрицательная.",consumed:"Комиссия шага "+((result.step??0)+1)+" забирает всю сумму. Увеличьте сумму или проверьте комиссию."};
  const message=result.ok?"":result.error==="amount"&&!$("planAmount").value.trim()?(plan.mode==="give"?"Введите сумму обмена.":"Введите сумму, которую хотите получить."):messages[result.error];
  // Only the amount to hand over is rounded upward. Quotes and intermediate math stay exact.
  const displayGive=result.ok?D.ceil(result.give):null;
  $("planResult").textContent=result.ok?"≈ "+fmtRub(plan.mode==="give"?result.receive:displayGive)+" "+planUnits[resultCurrency]:"— "+planUnits[resultCurrency];fitMoney($("planResult"));
  $("planRounding").hidden=!(result.ok&&plan.mode==="want"&&D.compare(displayGive,result.give)>0);
  $("planRounding").textContent="Сумма к обмену округлена вверх до 0,01 "+planUnits[plan.from]+", чтобы её хватило при указанных курсах.";
  $("planCaution").hidden=!stalePersonal;
  $("planCaution").textContent=stalePersonal?"В расчёте старый личный курс. Проверьте его перед обменом.":"";
  $("planNext").textContent=message;
  $("planNext").hidden=result.ok;
  $("planResultBox").classList.toggle("is-pending",!result.ok);
  const hasInput=$("planAmount").value.trim()!=="";
  $("planAmount").setAttribute("aria-invalid",String(hasInput&&result.error==="amount"));
  const showError=hasInput&&["amount","fee","consumed","direction"].includes(result.error);
  $("planError").textContent=showError?message:"";$("planError").classList.toggle("show",showError);
  $("planResultBox").hidden=showError;
  if(result.ok&&plan.mode==="give")result.steps.forEach((step,i)=>$("planStepResult"+i).textContent=fmtRub(step.input)+" "+planUnits[step.from]+" → "+fmtRub(step.output)+" "+planUnits[step.to]+(D.compare(step.commission,0)>0?" · комиссия "+fmtRub(step.commission)+" "+planUnits[step.from]:""));
}
function announce(message){
  $("actionStatus").textContent=message;
  clearTimeout(statusTimer);statusTimer=setTimeout(()=>$("actionStatus").textContent="",6000);
}
function calculationFeedback(message,method,view=currentView){
  // Saving a piece of data is not the same as having a complete calculation.
  if(currentView!==view||currentView==="data")return message;
  if(currentView==="exchange"){
    const amount=numberValue($("exchangeAmount").value);
    return message+(amount>0&&amount<=1e9?" Сумма обмена пересчитана.":" Введите сумму обмена.");
  }
  if(selectedPayment!==method)return message;
  const values=routeValues(),cash=method==="cash";
  const basis=cash?values.usdCost:values.usdtAvg,rate=cash?state.cashGelRate:values.bybitRate;
  if(!(basis>0&&Number.isFinite(basis)))return message+" Осталось указать покупку "+(cash?"USD":"USDT")+" за рубли.";
  if(!(rate>0&&Number.isFinite(Number(rate))))return message+(cash?" Осталось выбрать курс USD → GEL.":" Осталось указать списание USDT или прогнозный курс.");
  const price=numberValue($("quickGel").value),cost=cash?values.cash:values.bybit;
  return message+(price>0&&price<=1e9&&Number.isFinite(price*cost)?" Цена в рублях пересчитана.":" Введите корректную цену в лари для расчёта.");
}
function showView(view){
  if(!["purchase","exchange","data","calculator","insurance"].includes(view))return;
  if(view==="insurance"&&currentView===view)return;
  if(currentView==="insurance"&&view!=="insurance")window.GamarjiInsurance?.captureContext?.();
  if(view!=="exchange")closePlanReplacement();
  if(view!=="exchange")planQuoteSelection=null;
  currentView=view;
  for(const name of ["purchase","exchange","data"]){
    $(name+"View").hidden=name!==view;
    $(name+"Nav").setAttribute("aria-current",name===view?"page":"false");
  }
  $("calculatorView").hidden=view!=="calculator";
  $("insuranceView").hidden=view!=="insurance";
  $("insuranceNav").setAttribute("aria-current",view==="insurance"?"page":"false");
  $("purchaseNav").setAttribute("aria-current",["calculator","data","purchase"].includes(view)?"page":"false");
  if(view==="calculator"){
    if(!plan.initialized){const item=offersForCity("USD").find(row=>row.key===selectedOffer&&row.kind!=="manual"&&row.fresh);if(item){plan.sourceKey=item.key;plan.sourceCity=chosenCity();}plan.initialized=true;}
    renderPlanner();
  }
  // Section changes leave unfinished fields intact.
  renderOffers();
  if(view==="insurance"&&window.GamarjiInsurance?.restoreContext?.())return;
  (view==="insurance"&&!$("insuranceComparison").hidden?$("insuranceCompareHeading"):$(view+"Heading")).focus({preventScroll:true});
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
let rateEditorSequence=0;
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
function displayPersonal(next,syncFields=false){
  Object.assign(state,next);
  // Keep an untouched visible form in sync, but never replace a user's draft.
  const settingsFields={fee:$("feePct").value,cashback:$("cashbackPct").value};
  if(syncFields&&settingsBaseline&&$("settingsPanel").classList.contains("show")&&JSON.stringify(settingsFields)===settingsBaseline){
    const latest={fee:String(state.feePct),cashback:String(state.cashbackPct)};
    $("feePct").value=latest.fee;$("cashbackPct").value=latest.cashback;
    settingsBaseline=JSON.stringify(latest);settingsDraft=null;
  }
  applyCurrentBankQuote();
  $("migrationNotice").hidden=!state.legacyActualAdjusted;
  calc();renderBanks();
}
function syncPersonal(){
  // Never silently discard unsaved changes after a storage/lock failure.
  if(volatilePersonal)return;
  try{displayPersonal(readPersonal(),true);}
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
      notice("Не удалось сохранить данные безопасно. Изменения работают только в этой вкладке и могут пропасть после закрытия. До закрытия вкладки скачайте резервную копию в «Моих данных». Откройте приложение по HTTPS в современном браузере; если адрес уже защищён — проверьте доступ к хранилищу и перезагрузите страницу после экспорта.");
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
  const bestName=cashOrder<=0?"Наличные":"USDT";
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

  $("cashAvgLabel").textContent=Number.isFinite(usdAvg)?"Средняя цена USD":"Оценка доллара";
  $("cashAvg").textContent=usdCost>0?`${fmtRate(usdCost)} ₽/$`:"Добавьте покупку";
  $("usdtAvg").textContent=Number.isFinite(usdtAvg)?`${fmtRate(usdtAvg)} ₽/USDT`:"Добавьте покупку";
  $("cashGelRate").textContent=Number(state.cashGelRate)>0?`${fmtRate(state.cashGelRate)} ₾`:"Обновите курс";
  $("bybitGelRate").textContent=bybitRate>0?`${fmtRate(bybitRate)} ₾`:"Обновите курс";
  $("bybitRateLabel").textContent=state.bybitRateMode==="actual"?"Эффективно за 1 USDT":"Прогноз за 1 USDT";
  $("cashPrice").textContent=Number.isFinite(cash)?`${fmtRate(cash)} ₽/₾`:"—";
  $("bybitPrice").textContent=Number.isFinite(bybit)?`${fmtRate(bybit)} ₽/₾`:"—";
  $("cashExplain").textContent=Number.isFinite(cash)?`${fmtRate(cash)} ₽`:"Недостаточно данных";
  $("bybitExplain").textContent=Number.isFinite(bybit)?`${fmtRate(bybit)} ₽`:"Недостаточно данных";
  showFreshness("cashFreshness",state.cashGelUpdated,"USD→₾");
  showFreshness("bybitFreshness",state.bybitGelUpdated,"USDT");
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
  $("bybitSummary").textContent=!Number.isFinite(usdtAvg)?"Не указана цена покупки USDT":!(bybitRate>0)?"Укажите списание по оплате через USDT":(state.bybitRateMode==="actual"?"По операции":"Прогноз")+" · "+(bybitStale?"обновите USDT":checkedText(state.bybitGelUpdated));
  $("cashCompareAction").textContent=!(usdCost>0)?"Добавить покупку USD":"Изменить курс";
  $("bybitCompareAction").textContent=!Number.isFinite(usdtAvg)?"Добавить покупку USDT":"Уточнить курс USDT";
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
    $("heroDetail").textContent="Затем выберите курс наличных или обновите USDT.";
  }

  $("heroRoute").classList.toggle("caution",comparisonStale||invalidQuantity);
  if(comparisonStale){
    $("heroRoute").textContent="Оценка по сохранённым курсам — обновите их перед обменом";
    $("heroDetail").textContent="Свежесть не подтверждена. Выгодный способ пока не выбираем.";
  }else if(state.bybitRateMode==="quote"&&Number.isFinite(bybit)){
    $("heroDetail").textContent+=" · USDT — прогноз с указанными процентами";
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
  if(currentView==="calculator")renderPlanner();
}

function fitMoney(element){
  const length=element.textContent.length;
  element.dataset.moneySize=length>24?"extra-long":length>18?"long":length>12?"medium":"normal";
}
function fitAmount(element){
  element.dataset.amountSize=element.value.length>14?"long":element.value.length>10?"medium":"normal";
}
function renderRubles(values){
  fitAmount($("quickGel"));
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
  $("setupProgress").hidden=ready;
  $("setupProgress").textContent=!hasBasis?"Шаг 1 из 2 · покупка "+currency+" за рубли":"Шаг 2 из 2 · "+(isCash?"курс USD → GEL":"списание USDT");
  $("comparisonDetails").hidden=!Number.isFinite(cash)&&!Number.isFinite(bybit);
  $("rublesResult").textContent=ready&&!invalidQuantity?"≈ "+fmtRub(isCash?totals.cash:totals.bybit)+" ₽":"— ₽";
  fitMoney($("rublesResult"));
  $("rublesRate").textContent=ready?"1 ₾ = "+fmtRate(rate)+" ₽ · "+(isCash?"наличными":"через USDT"):isCash?"Рубли → доллары → лари":"Рубли → USDT → оплата картой";
  let status;
  if(!hasBasis)status=isCash?"Укажите, сколько рублей потратили на доллары. Тогда посчитаем вашу цену, а не официальный курс.":"Укажите, сколько рублей потратили на USDT для карты.";
  else if(!hasRate)status=isCash?"В «Обмене» выберите USD и предложение. Раскройте «Цена в рублях» и нажмите «Применить курс».":"Укажите сумму прошлой покупки в лари и списание в USDT из вашей операции.";
  else if(stale)status=isCash?(state.cashBankId||state.cashOfficeId?"Расчёт по сохранённому курсу. Проверьте его во вкладке «Обмен».":"Расчёт по сохранённому курсу. Обновите свой USD → GEL перед обменом."):"Расчёт по сохранённым данным USDT. Обновите курс или укажите недавнюю операцию.";
  else status=isCash?"Учтены цена ваших долларов и выбранный курс обмена.":state.bybitRateMode==="actual"?"Учтены цена ваших USDT и списание по прошлой операции.":"Это прогноз по введённому курсу и вашим процентам, не гарантия списания.";
  if(isCash&&hasRate)status+=" Источник: "+(state.cashOfficeId?(C.OFFICES[state.cashOfficeId]?.name||"обменник"):state.cashBankId?state.cashBankName:"мой ручной курс")+".";
  if(estimated&&hasRate)status+=" Цена доллара пока взята из вашей оценки, не из покупок.";
  $("rublesStatus").textContent=status;
  $("rublesStatus").classList.toggle("stale",ready&&(stale||estimated));
  const action=!hasBasis?"basis":!hasRate||stale?"rate":estimated?"basis":"";
  $("rublesNextAction").hidden=!action||invalidQuantity;
  $("rublesNextAction").dataset.action=action;
  const editRateLabel=isCash?(hasRate&&!state.cashBankId&&!state.cashOfficeId?"Обновить мой курс":"Выбрать курс обмена"):state.bybitRateMode==="quote"&&hasRate?"Обновить курс USDT":"Указать списание USDT";
  $("rublesNextAction").textContent=action==="basis"?"Указать покупку "+currency:editRateLabel;
  $("paymentSetupTitle").textContent=ready?"Из чего сложилась цена":"Что нужно для расчёта";
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
  if(id==="exchangeManualPanel"&&$(id).classList.contains("show")){
    if($("exchangeManualValue").value!==manualEditorBaseline)manualDrafts[manualEditorCurrency]=$("exchangeManualValue").value;
    else delete manualDrafts[manualEditorCurrency];
  }
  if(id==="settingsPanel"&&settingsBaseline){
    const fields={fee:$("feePct").value,cashback:$("cashbackPct").value};
    settingsDraft=JSON.stringify(fields)!==settingsBaseline?fields:null;
  }
  if(id==="purchasePanel"&&purchaseEditorReady)purchaseDrafts[purchaseKind]={rub:$("purchaseRub").value,qty:$("purchaseQty").value};
  if(id==="ratePanel"&&rateEditorReady){
    const fields=rateFields();
    if(JSON.stringify(fields)!==rateDraftBaseline)rateDrafts[rateKind]={...fields,baseline:rateDraftBaseline,rewardOpen:$("rewardDetails").open};
    else delete rateDrafts[rateKind];
  }
}
function closeInline(id){
  rememberEditor(id);$(id).classList.remove("show");
  if(["ratePanel","exchangeManualPanel"].includes(id)&&currentView==="exchange")renderOffers();
}

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
  announce(volatilePersonal?"Покупка добавлена только в этой вкладке":calculationFeedback("Покупка сохранена.",field==="usdPurchases"?"cash":"bybit",returnView));
}

function setRateMode(mode){
  rateMode=mode;
  $("rateTitle").textContent=rateKind==="cash"?"Свой курс USD → GEL":mode==="actual"?"Последняя оплата USDT":"Курс для прогноза USDT";
  $("saveRateButton").textContent=rateKind==="cash"?"Сохранить курс":mode==="actual"?"Использовать операцию":"Сохранить прогноз";
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
  rateEditorSequence++;
  rateEditorReady=true;
  $("rateTitle").textContent=kind==="cash"?"Свой курс USD → GEL":"Обновить USDT → ₾";
  $("rateLabel").textContent=kind==="cash"?"За 1 USD дают":"За 1 USDT дают";
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
  if(kind==="cash"&&currentView==="exchange"){expandedOffer="";renderOffers();}
  focusEditor("ratePanel",rateMode==="quote"?"rateValue":"actualGel");
}

function updateRatePreview(){
  const {usdCost,usdtAvg,mult}=routeValues();
  let text="";
  if(rateKind==="cash"){
    const rate=numberValue($("rateValue").value);
    const amount=numberValue($("exchangeAmount").value);
    if(rate>0&&currentView==="exchange"&&amount>0&&amount<=1e9)text=`За ${fmt(amount)} USD получите ≈ ${money(D.mul(amount,rate))} ₾.`;
    if(rate>0&&usdCost>0)text+=(text?" ":"")+`Для вас: 1 ₾ ≈ ${fmtRate(usdCost/rate)} ₽.`;
  }else if(rateMode==="quote"){
    const rate=numberValue($("rateValue").value);
    if(rate>0&&Number.isFinite(usdtAvg))text=`С учётом комиссии и кешбэка 1 ₾ ≈ ${fmtRate(usdtAvg*mult/rate)} ₽.`;
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
  const savedKind=rateKind,returnView=currentView,returnCurrency=exchangeCurrency,submittedEditor=rateEditorSequence;
  let patch;
  if(rateKind==="cash"){
    const value=numberValue($("rateValue").value);
    if(!(value>0))return showRateError("Введите, сколько лари сейчас дают за 1 USD.");
    patch={cashGelRate:value,cashGelUpdated:Date.now(),cashBankId:null,cashBankName:null,cashOfficeId:null};
  }else if(rateMode==="quote"){
    const value=numberValue($("rateValue").value);
    if(!(value>0))return showRateError("Введите, сколько лари получаете за 1 USDT.");
    patch={bybitGelRate:value,bybitRateMode:"quote",bybitGelUpdated:Date.now()};
  }else{
    const gel=numberValue($("actualGel").value);
    const charged=numberValue($("actualUsdt").value);
    if(!(gel>0&&charged>0))return showRateError("Введите сумму покупки в лари и фактически списанные USDT.");
    const reward=numberValue($("actualReward").value.trim()||"0");
    const effective=C.actualRate(gel,charged,reward);
    if(!Number.isFinite(effective))return showRateError("Полученный кешбэк должен быть от 0 до суммы списания, не включая её.");
    patch={bybitActual:{gel,charged,reward},bybitActualGelRate:effective,
      legacyActualAdjusted:false,bybitRateMode:"actual",bybitGelUpdated:Date.now()};
  }
  rateSaving=true;
  closeInline("ratePanel");
  delete rateDrafts[savedKind];rateEditorReady=false;
  try{
    await changePersonal(next=>Object.assign(next,patch));
    if(currentView===returnView&&(returnView!=="exchange"||returnCurrency===exchangeCurrency)&&rateEditorSequence===submittedEditor&&!rateEditorReady){
      if(savedKind==="cash"){selectedOffer="manual";expandedOffer="";offerSelectionExplicit=true;}
      setPayment(savedKind==="cash"?"cash":"bybit");
      showView(savedKind==="cash"&&returnView==="exchange"?"exchange":"purchase");
    }
    announce(volatilePersonal?"Курс изменён только в этой вкладке":calculationFeedback(savedKind==="cash"?"Свой курс сохранён.":patch.bybitRateMode==="actual"?"Операция сохранена.":"Прогноз сохранён.",savedKind,returnView));
  }
  finally{rateSaving=false;}
}

function openSettings(){
  const panel=$("settingsPanel");
  const willOpen=!panel.classList.contains("show");
  if(!willOpen){closeInline("settingsPanel");return;}
  closeAllInline("settingsPanel");
  $("officialRub").value=officialReady?fmtRate(state.officialUsdRub):"";
  $("officialGel").value=officialReady?fmtRate(state.officialUsdGel):"";
  if(!settingsDraft)settingsBaseline=JSON.stringify({fee:String(state.feePct),cashback:String(state.cashbackPct)});
  $("feePct").value=settingsDraft?.fee??String(state.feePct);
  $("cashbackPct").value=settingsDraft?.cashback??String(state.cashbackPct);
  panel.classList.add("show");
  $("feePct").focus();
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
  if(currentView==="purchase")$("legacyOfferDetails").open=true;
  changeExchangeCurrency("USD");
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
  $("bankStatus").textContent=bankBusy?"Проверяем курсы банков…":banks
    ?banks.offers.length+" банков · проверено "+new Date(banks.fetchedAt).toLocaleString("ru-RU")+"."+(fresh?"":" Курсы устарели или не прошли проверку. Применить их нельзя.")
    :"Банковские данные пока недоступны. Ваш ручной курс продолжает работать.";
  updateBankPreview();renderOffers();
}
function updateBankPreview(){
  const item=banks?.offers.find(o=>o.id===$("bankChoice").value);
  const enabled=Boolean(item&&C.fresh(banks.fetchedAt,2*3600000)&&!bankFailed);
  $("applyBankButton").disabled=!enabled;
  $("bankPreview").textContent=item?item.bank+": за 100 USD ≈ "+money(D.mul(item.buy,100))+" GEL до возможных комиссий. После выбора курс этого банка будет обновляться из опубликованных данных.":"Список отсортирован по курсу покупки USD: больше лари за доллар — выше в списке.";
  if(item&&!enabled)$("bankPreview").textContent="Курс нельзя применить: данные устарели или источник недоступен. Обновите курсы или введите свой.";
}
async function applyBank(){
  const item=banks?.offers.find(o=>o.id===$("bankChoice").value);
  if(!item||bankFailed||!C.fresh(banks.fetchedAt,2*3600000))return;
  const patch={cashBankId:item.id,cashBankName:item.bank,cashOfficeId:null,cashGelRate:item.buy,cashGelUpdated:Date.parse(banks.fetchedAt)};
  closeInline("bankPanel");
  await changePersonal(next=>Object.assign(next,patch));
  selectedOffer="bank:"+item.id;offerSelectionExplicit=false;
  setPayment("cash");showView("purchase");announce(volatilePersonal?"Курс изменён только в этой вкладке":calculationFeedback("Курс "+item.bank+" выбран.","cash"));
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
  const submitted={fee:$("feePct").value,cashback:$("cashbackPct").value};
  const submittedBaseline=settingsBaseline;
  const fee=numberValue($("feePct").value),cashback=numberValue($("cashbackPct").value);
  if(!(fee>=0&&fee<100&&cashback>=0&&cashback<100)){
    $("settingsError").textContent="Введите проценты от 0 до 100, не включая 100.";
    $("settingsError").classList.add("show");return;
  }
  $("settingsError").classList.remove("show");
  if(!settingsPending&&JSON.stringify(submitted)===settingsBaseline){
    syncPersonal();announce("Условия не изменились.");return;
  }
  settingsPending++;
  try{
    await changePersonal(next=>{next.feePct=fee;next.cashbackPct=cashback;});
    // A storage event may have synchronized a clean form while this save waited.
    const current={fee:$("feePct").value,cashback:$("cashbackPct").value};
    if(settingsBaseline===submittedBaseline||JSON.stringify(current)===JSON.stringify(submitted))settingsBaseline=JSON.stringify(submitted);
    rememberEditor("settingsPanel");
    announce(volatilePersonal?"Условия изменены только в этой вкладке":"Условия прогноза сохранены.");
  }finally{settingsPending--;}
}
async function exportData(){
  await personalQueue;
  syncPersonal();
  for(const currency of ["EUR","RUB"])readManual(currency);
  const blob=new Blob([JSON.stringify({app:"GEL Cost",exportedAt:new Date().toISOString(),state,cashExchangeRates:manualRecords},null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download="gel-cost-backup.json";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// New cash currencies have independent caches and manual rates. The USD purchase ledger is unchanged.
const manualKey=currency=>"gelcost-v5.7-manual-"+currency;
function readManual(currency){
  try{
    const raw=storage.getItem(manualKey(currency));
    if(!raw){manualRecords[currency]=null;manualBlocked[currency]=false;return;}
    const item=JSON.parse(raw);
    if(item.version!==1||item.currency!==currency||!C.positive(item.rate)||item.rate>1e9||!Number.isFinite(item.updatedAt)||item.updatedAt<=0)throw Error("Invalid manual record");
    manualRecords[currency]=item;manualBlocked[currency]=false;
  }catch{manualBlocked[currency]=true;manualRecords[currency]=null;}
}
function changeExchangeCurrency(currency=$("exchangeCurrency").value){
  if(!exchangeMeta[currency])return;
  if(currency!==exchangeCurrency){
    closeInline("ratePanel");closeInline("exchangeManualPanel");
    exchangeDrafts[exchangeCurrency]={amount:$("exchangeAmount").value,key:selectedOffer,explicit:offerSelectionExplicit};
    exchangeCurrency=currency;
    const draft=exchangeDrafts[currency];
    $("exchangeAmount").value=draft?.amount??(currency==="RUB"?"10000":"100");
    selectedOffer=draft?.key||"";offerSelectionExplicit=draft?.explicit||false;
    expandedOffer="";allOffers=false;
  }
  renderOffers();
}
function openExchangeManual(){
  if(exchangeCurrency==="USD")return openRate("cash");
  if($("exchangeManualPanel").classList.contains("show"))return closeInline("exchangeManualPanel");
  closeAllInline("exchangeManualPanel");manualEditorCurrency=exchangeCurrency;
  readManual(exchangeCurrency);
  const meta=exchangeMeta[exchangeCurrency],saved=manualRecords[exchangeCurrency];
  $("exchangeManualTitle").textContent="Свой курс "+exchangeCurrency+" → GEL";
  $("exchangeManualLabel").textContent="За "+meta.nominal+" "+meta.unit+" дают";
  manualEditorBaseline=saved?inputValue(nominalQuote(saved.rate,meta.nominal)):"";
  $("exchangeManualValue").value=manualDrafts[exchangeCurrency]??manualEditorBaseline;
  $("exchangeManualError").classList.remove("show");
  $("exchangeManualPanel").classList.add("show");expandedOffer="";
  updateExchangeManualPreview();renderOffers();focusEditor("exchangeManualPanel","exchangeManualValue");
}
function updateExchangeManualPreview(){
  const meta=exchangeMeta[manualEditorCurrency],rate=C.number($("exchangeManualValue").value),amount=C.number($("exchangeAmount").value);
  $("exchangeManualPreview").textContent=rate>0&&rate<=1e9&&amount>0&&amount<=1e9
    ?"За "+fmtRub($("exchangeAmount").value)+" "+meta.unit+" получите ≈ "+fmtRub(D.div(D.mul($("exchangeAmount").value,$("exchangeManualValue").value),meta.nominal))+" ₾. Перед обменом уточните комиссию.":"";
  $("exchangeManualError").classList.remove("show");
}
function saveExchangeManual(){
  const currency=manualEditorCurrency,rate=C.number($("exchangeManualValue").value);
  const fail=text=>{$("exchangeManualError").textContent=text;$("exchangeManualError").classList.add("show");};
  if(!(rate>0&&rate<=1e9))return fail("Введите курс больше нуля и не больше 1 млрд.");
  readManual(currency);
  if(manualBlocked[currency])return fail("Не удалось безопасно прочитать сохранённый курс. Он не перезаписан. Проверьте доступ к хранилищу браузера.");
  if($("exchangeManualValue").value===manualEditorBaseline){closeInline("exchangeManualPanel");announce("Курс не изменён.");return;}
  const record={version:1,currency,rate:decimalText(D.div($("exchangeManualValue").value,exchangeMeta[currency].nominal)),updatedAt:Date.now()};
  try{storage.setItem(manualKey(currency),JSON.stringify(record));}catch{return fail("Курс не сохранён: браузер не разрешил запись. Ваш ввод оставлен в форме.");}
  manualRecords[currency]=record;closeInline("exchangeManualPanel");delete manualDrafts[currency];
  selectedOffer=offerKey("manual",currency);offerSelectionExplicit=true;renderOffers();
  announce(calculationFeedback("Свой курс "+currency+" сохранён.","cash"));
}

// Public sources are a separate cache; no background fetch writes personal history.
function offersForCity(currency=exchangeCurrency,city=chosenCity()){
  const market=marketFor(currency);
  const officeRows=(market.offices?.offers||[]).filter(row=>city==="all"||C.OFFICES[row.id].cities.includes(city)).map(row=>({
    key:offerKey("office",currency,row.id),currency,id:row.id,name:C.OFFICES[row.id].name,buy:row.buy,sell:row.sell,
    checkedAt:row.checkedAt,fresh:!market.officeFailed&&!market.offices.failures.includes(row.id)&&C.fresh(row.checkedAt,QUOTE_TTL),kind:"office",
    url:C.OFFICES[row.id].url,branches:C.OFFICES[row.id].branches
  }));
  const bankRows=(market.banks?.offers||[]).map(row=>({
    key:offerKey("bank",currency,row.id),currency,id:row.id,name:row.bank,buy:row.buy,sell:row.sell,checkedAt:market.banks.fetchedAt,
    fresh:!market.bankFailed&&C.fresh(market.banks.fetchedAt,QUOTE_TTL),kind:"bank",
    url:"https://nbg.gov.ge/en/currency-rates",branches:null
  }));
  const manual=currency==="USD"?(!state.cashBankId&&!state.cashOfficeId&&C.positive(state.cashGelRate)?{rate:C.number(state.cashGelRate),updatedAt:state.cashGelUpdated}:null):manualRecords[currency];
  const manualRows=manual?[{
    key:offerKey("manual",currency),currency,id:"manual",name:"Свой курс",buy:manual.rate,checkedAt:manual.updatedAt,
    fresh:C.fresh(manual.updatedAt),kind:"manual",url:null,branches:null
  }]:[];
  const publicRows=[...officeRows,...bankRows].sort((a,b)=>Number(b.fresh)-Number(a.fresh)||b.buy-a.buy||a.name.localeCompare(b.name));
  const bestBuy=publicRows.find(row=>row.fresh)?.buy;
  for(const row of publicRows)row.best=row.fresh&&row.buy===bestBuy;
  // Promote a fresh public best, without overwriting or hiding the personal quote.
  // If no public quote is fresh, keep the usable manual quote first; no best badge.
  return publicRows[0]?.best
    ?[publicRows[0],...manualRows,...publicRows.slice(1)]
    :[...manualRows,...publicRows];
}
function selectOffer(key){
  if(!offersForCity().some(row=>row.key===key))return;
  if(selectedOffer!==key)expandedOffer="";
  selectedOffer=key;offerSelectionExplicit=true;renderOffers();
}
function toggleOfferLocation(key=selectedOffer){
  if(!offersForCity().some(row=>row.key===key))return;
  if(expandedOffer!==key&&$("ratePanel").classList.contains("show"))closeInline("ratePanel");
  if(expandedOffer!==key&&$("exchangeManualPanel").classList.contains("show"))closeInline("exchangeManualPanel");
  expandedOffer=expandedOffer===key?"":key;
  renderOffers();
}
function closeOfferLocation(){
  expandedOffer="";renderOffers();
  $("offerAddressButton").focus({preventScroll:true});
}
function renderOfferLocation(item){
  const panel=$("offerLocationPanel");panel.hidden=!item;
  if(!item){$("openDeviceMap").hidden=true;$("openDeviceMap").href="";return;}
  const city=$("exchangeCity").value||"batumi";
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
  // Direct user-gesture link: Android uses the former "Карты телефона" action.
  // Other platforms receive an HTTPS place link, never an Android-only Intent.
  const mapUrl=links?(androidMaps?L.deviceMapLink(links):appleMaps?links.apple:links.google):null;
  $("openDeviceMap").href=mapUrl||"";
  $("openDeviceMap").hidden=!mapUrl;
  $("openDeviceMap").target=androidMaps?"_self":"_blank";
  $("branchMapHint").textContent=branch?(L.validPoint(branch.point)?"В картах выберите «Маршрут» → «Моё местоположение».":"Точка не подтверждена: откроется поиск адреса. Проверьте здание, затем выберите «Маршрут» → «Моё местоположение»."):links?"Откроется поиск отделений банка.":"";
  if(appleMaps&&branch?.appleFallback==="google")$("branchMapHint").textContent="Эта точка откроется в Google Maps: Apple Maps неточно определяет адрес. В картах выберите маршрут от вашего местоположения.";
  $("branchChecked").textContent=branch?"Адрес сверён "+new Date(branch.checkedAt).toLocaleDateString("ru-RU")+" · список неполный."+(C.fresh(branch.checkedAt,90*C.DAY)?"":" Адрес давно не проверялся — уточните его у сети."):"";
}
function selectBranch(){
  const item=offersForCity().find(row=>row.key===expandedOffer);
  if(!item||!L)return;
  const city=$("exchangeCity").value||"batumi";
  if(!L.branches(item.id,city).some(row=>row.id===$("branchChoice").value))return;
  branchSelection[item.key+":"+city]=$("branchChoice").value;
  renderOfferLocation(item);
}
function toggleAllOffers(){allOffers=!allOffers;renderOffers();}
function editingExchangeRate(){return currentView==="exchange"&&($("exchangeManualPanel").classList.contains("show")||rateKind==="cash"&&$("ratePanel").classList.contains("show")&&$("ratePanel").parentElement===$("cashRateHost"));}
function renderOffers(){
  const meta=exchangeMeta[exchangeCurrency],market=marketFor(exchangeCurrency);
  const selecting=Boolean(planQuoteSelection),side=planQuoteSelection?.side||"buy";
  $("exchangeView").classList.toggle("is-selecting",selecting);
  $("returnToPlan").hidden=!selecting;
  $("exchangeAmountGroup").hidden=selecting;
  $("exchangeSummary").hidden=selecting;
  $("exchangeListNote").textContent=selecting?"Курс для расчёта":"За вашу сумму";
  $("exchangeListNote").hidden=!selecting;
  $("exchangeHeading").textContent=selecting?"Выберите курс для расчёта":"Обмен валют";
  $("exchangeCurrencyLabel").textContent=selecting?(side==="sell"?"Покупаю":"Продаю"):"Отдаю";
  $("exchangeCurrency").value=exchangeCurrency;
  $("exchangeAmountLabel").textContent="Отдаю";$("exchangeAmountUnit").textContent=meta.unit;
  $("currencyCoverage").hidden=exchangeCurrency!=="RUB";
  $("currencyCoverage").textContent="RUB: курсы обменников. Банковские курсы пока не подключены.";
  $("legacyOfferDetails").hidden=selecting||exchangeCurrency!=="USD";
  $("manualRateButton").hidden=selecting&&side==="sell";
  $("manualRateButton").setAttribute("aria-expanded",String(editingExchangeRate()));
  fitAmount($("exchangeAmount"));
  const rows=offersForCity().map(item=>({...item}));
  if(selecting){
    for(const item of rows)item.best=false;
    rows.sort((a,b)=>Number(Boolean(b.fresh&&C.positive(b[side])))-Number(Boolean(a.fresh&&C.positive(a[side])))||(side==="sell"?((a.sell||Infinity)-(b.sell||Infinity)):b.buy-a.buy));
  }
  if(!offerSelectionExplicit||!rows.some(row=>row.key===selectedOffer)){
    const active=exchangeCurrency==="USD"?(state.cashOfficeId?"office:"+state.cashOfficeId:state.cashBankId?"bank:"+state.cashBankId:C.positive(state.cashGelRate)?"manual":""):(manualRecords[exchangeCurrency]?offerKey("manual",exchangeCurrency):"");
    selectedOffer=rows.some(row=>row.key===active)?active:rows[0]?.key||"";
  }
  const amount=numberValue($("exchangeAmount").value);
  const valid=amount>0&&amount<=1e9;
  $("exchangeError").textContent=valid?"":"Введите сумму больше нуля и не больше 1 млрд "+meta.unit+".";
  $("exchangeError").classList.toggle("show",!valid);
  $("exchangeAmount").setAttribute("aria-invalid",String(!valid));
  const shown=allOffers?rows:rows.slice(0,3);
  if(!shown.some(row=>row.key===selectedOffer)){
    const selected=rows.find(row=>row.key===selectedOffer);if(selected)shown.push(selected);
  }
  // Keep the chosen offer and its answer together at the beginning of the list.
  // Remaining offers retain their rate order; selection never changes a quote.
  if(!selecting)shown.sort((a,b)=>Number(b.key===selectedOffer)-Number(a.key===selectedOffer));
  if(!rows.some(row=>row.key===expandedOffer))expandedOffer="";
  // Keep a user's focused row during a background re-render.
  const focused=document.activeElement?.dataset?.offerKey;
  const focusedBranch=document.activeElement?.id;
  const locationPanel=$("offerLocationPanel");
  const actionPanel=$("offerActions");
  $("offerActionsHome").appendChild(actionPanel);
  $("locationPanelHome").appendChild(locationPanel);
  const nodes=shown.map(item=>{
    const button=document.createElement("button");button.type="button";button.className="offer-row";
    button.dataset.offerKey=item.key;button.setAttribute("aria-pressed",String(item.key===selectedOffer));
    const top=document.createElement("span");top.className="offer-top";
    const heading=document.createElement("span");heading.className="offer-name";
    const name=document.createElement("strong");name.textContent=item.name;
    heading.appendChild(name);
    if(item.best){
      const badge=document.createElement("span");badge.className="offer-best";badge.textContent="Лучший курс";
      heading.appendChild(badge);button.setAttribute("aria-describedby","bestOfferHelp");
    }
    const total=document.createElement("b");total.textContent=selecting?(C.positive(item[side])?fmtRate(item[side]*meta.nominal)+" ₾":"Нет курса"):(valid?money(D.mul($("exchangeAmount").value,item.buy))+" ₾":"— ₾");
    top.appendChild(heading);top.appendChild(total);button.appendChild(top);
    const detail=document.createElement("small");
    detail.textContent=(item.kind==="manual"?"Введён вами":item.kind==="office"?"Обменник · курс сети":"Банк · город уточните")+" · "+(selecting?(side==="sell"?"Продажа":"Покупка")+" · за "+meta.nominal+" "+meta.unit:quoteText(exchangeCurrency,item.buy))+(item.fresh?"":" · нужна проверка");
    if(!selecting&&item.key===selectedOffer)detail.textContent=quoteText(exchangeCurrency,item.buy)+" · "+(item.kind==="manual"?"введён вами":item.kind==="office"?"курс сети":"город уточните");
    button.appendChild(detail);button.classList.toggle("is-stale",!item.fresh);
    button.addEventListener("click",()=>selectOffer(item.key));return button;
  });
  // One action panel follows the selected row; no nested buttons or duplicate IDs.
  const selectedShown=nodes.some(node=>node.dataset.offerKey===selectedOffer);
  actionPanel.hidden=!selectedShown;
  (selectedShown?actionPanel:$("offerToolsHome")).appendChild($("offerToolsPanel"));
  $("offerList").replaceChildren(...nodes.flatMap(node=>node.dataset.offerKey===selectedOffer?[node,actionPanel]:[node]));$("offerList").hidden=!rows.length;
  renderOfferLocation(rows.find(row=>row.key===expandedOffer));
  if(focused)nodes.find(node=>node.dataset.offerKey===focused)?.focus({preventScroll:true});
  else if(focusedBranch&&["branchChoice","openDeviceMap","branchSource","closeLocationButton","offerAddressButton","planOfferButton","planReplaceText","planReplaceConfirm","planReplaceCancel"].includes(focusedBranch))$(focusedBranch).focus({preventScroll:true});
  $("moreOffers").hidden=rows.length<=3;
  $("moreOffers").textContent=allOffers?"Свернуть список":"Все предложения ("+rows.length+")";
  $("moreOffers").setAttribute("aria-expanded",String(allOffers));
  const available=rows.filter(row=>row.kind!=="manual"&&row.fresh).length;
  $("bestOfferHelp").hidden=!available;
  const busy=market.officeBusy||market.bankBusy;
  $("offerStatus").textContent=available?"Актуальные предложения: "+available+" · до комиссий":busy?"Загружаем курсы…":"Нет свежих курсов банков и обменников. Старые — для справки.";
  if(market.officeFailed||market.offices?.failures.length)$("offerStatus").textContent+=" Часть обменников не прошла проверку.";
  if(market.bankFailed)$("offerStatus").textContent+=" Банковские курсы не прошли проверку.";
  $("offerStatus").classList.toggle("stale",!available&&!busy);
  $("refreshOffersButton").disabled=busy;
  $("refreshOffersButton").textContent=busy?"Проверяем…":"Обновить курсы";
  const item=rows.find(row=>row.key===selectedOffer);
  $("offerListHeading").textContent=selecting||!item?"Курсы и адреса":"Выбранное предложение";
  $("offerAddressButton").hidden=!item||item.kind==="manual";
  $("offerAddressButton").textContent=item?(item.kind==="bank"?"Отделения ":"Адреса ")+item.name:"Адреса";
  $("offerAddressButton").setAttribute("aria-expanded",String(Boolean(expandedOffer)));
  $("exchangeReceive").textContent=item&&valid?"≈ "+money(D.mul($("exchangeAmount").value,item.buy))+" ₾":"— ₾";
  $("exchangeResultLabel").textContent=item?(item.kind==="manual"?"Свой курс · "+quoteText(exchangeCurrency,item.buy)+(item.fresh?"":" · нужна проверка"):(item.fresh?"По курсу ":"Нужна проверка · ")+item.name):"Выберите предложение";
  $("exchangeResultLabel").classList.toggle("stale",Boolean(item&&!item.fresh));
  const {usdCost,exact}=routeValues();
  $("exchangeBasis").textContent=valid&&item?(usdCost>0?"Эти USD стоили вам ≈ "+fmtRub(D.mul(amount,exact.usdCost))+" ₽ · 1 ₾ ≈ "+fmtRate(usdCost/item.buy)+" ₽":"Добавьте покупку USD, чтобы увидеть стоимость в рублях."):"";
  $("selectedOfferDetail").textContent=item?(item.kind==="manual"?freshnessText(item.checkedAt,exchangeCurrency+"→GEL").text+". Введён вами, не котировка банка или обменника."+(item.fresh?"":" Проверьте перед обменом."):"Проверено "+checkedText(item.checkedAt)+". "+(item.kind==="office"?"Курс сети. Наличие и условия уточните в отделении.":"Витрина НБГ: отделение, запрос на 1 000 GEL. Для вашей суммы условия могут отличаться.")+(item.fresh?"":" Курс нельзя применить: данные устарели или не подтверждены.")):"Можно ввести свой проверенный курс выше.";
  $("selectedSource").hidden=!item?.url;$("selectedBranches").hidden=!item?.branches;
  $("selectedSource").href=item?.url||"";$("selectedBranches").href=item?.branches||"";
  $("applyOfferButton").hidden=selecting||exchangeCurrency!=="USD"||editingExchangeRate();
  $("applyOfferButton").disabled=editingExchangeRate()||!(item&&(item.kind==="manual"||item.fresh)&&valid);
  $("planOfferButton").hidden=editingExchangeRate()||Boolean(item&&item.kind!=="manual"&&!item.fresh);
  const incompatible=selecting&&(exchangeCurrency!==planQuoteSelection.currency||!item||!C.positive(item[side])||(item.kind==="manual"&&side==="sell"));
  $("planOfferButton").textContent=selecting?"Использовать курс":"Рассчитать эту сумму";
  $("planOfferButton").disabled=editingExchangeRate()||incompatible||!(item&&(item.kind==="manual"||item.fresh)&&(selecting||valid));
  $("offerActionNote").textContent=incompatible?"Нужен курс "+(side==="sell"?"продажи ":"покупки ")+planQuoteSelection.currency+". Расчёт сохранён.":!selecting&&!valid?"Введите сумму выше.":item&&item.kind!=="manual"&&!item.fresh?"Чтобы применить курс, обновите данные или введите свой.":selecting?"Сумма, направление и комиссии останутся прежними.":"";
  $("offerActionNote").hidden=!$("offerActionNote").textContent;
  if(planReplacement&&planReplacement!==offerPlanFingerprint(offerPlanIntent())){
    closePlanReplacement();announce("Данные изменились. Проверьте сумму и курс, затем начните расчёт снова.");
    if(["planReplaceText","planReplaceConfirm","planReplaceCancel"].includes(focusedBranch)){
      ($("planOfferButton").hidden||$("planOfferButton").disabled?$("exchangeHeading"):$("planOfferButton")).focus();
    }
  }
  $("applyOfferButton").textContent="Применить курс";
}
async function applyOffer(){
  if(exchangeCurrency!=="USD"||editingExchangeRate())return;
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
  setPayment("cash");showView("purchase");announce(volatilePersonal?"Курс изменён только в этой вкладке":calculationFeedback("Курс "+item.name+" выбран.","cash"));
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
const extraCacheKey=(currency,kind)=>"gelcost-v5.7-"+kind+"-"+currency;
async function refreshCurrencyMarket(currency,kind){
  const market=extraMarkets[currency],bank=kind==="banks";
  if(!market||currency==="RUB"&&bank)return;
  const busy=bank?"bankBusy":"officeBusy",failed=bank?"bankFailed":"officeFailed";
  if(market[busy])return;
  market[busy]=true;renderOffers();
  const validate=data=>(bank?C.bankSnapshot:C.officeSnapshot)(data,Date.now(),currency);
  try{
    const data=validate(await fetchJson("./"+(bank?"market":"exchange")+"-rates-"+currency.toLowerCase()+".json"));
    const old=market[kind];
    if(old&&Date.parse(data.fetchedAt)<Date.parse(old.fetchedAt))throw Error("Snapshot moved backwards");
    if(!bank)for(const row of data.offers){
      const previous=old?.offers.find(item=>item.id===row.id);
      if(previous&&Date.parse(row.checkedAt)<Date.parse(previous.checkedAt))throw Error("Provider timestamp moved backwards");
    }
    market[kind]=data;market[failed]=false;cachePublic(extraCacheKey(currency,kind),data,validate);
  }catch{market[failed]=true;}
  finally{market[busy]=false;renderOffers();if(currentView==="calculator")renderPlanner();}
}
function refreshAllRates(){return Promise.all([refreshOfficial(),refreshBanks(),refreshOffices(),refreshCurrencyMarket("EUR","banks"),refreshCurrencyMarket("EUR","offices"),refreshCurrencyMarket("RUB","offices")]);}

$("exchangeAmount").addEventListener("input",()=>{renderOffers();if(rateKind==="cash"&&$("ratePanel").classList.contains("show"))updateRatePreview();if($("exchangeManualPanel").classList.contains("show"))updateExchangeManualPreview();});
$("exchangeCurrency").addEventListener("change",()=>changeExchangeCurrency());
$("exchangeManualValue").addEventListener("input",updateExchangeManualPreview);
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
for(const currency of ["EUR","RUB"]){
  readManual(currency);
  for(const kind of ["banks","offices"]){
    if(currency==="RUB"&&kind==="banks")continue;
    extraMarkets[currency][kind]=readCache(extraCacheKey(currency,kind),data=>(kind==="banks"?C.bankSnapshot:C.officeSnapshot)(data,Date.now(),currency));
  }
}
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
  for(const currency of ["EUR","RUB"])if(event.key===manualKey(currency)||event.key===null){
    readManual(currency);
    if(manualEditorCurrency===currency&&$("exchangeManualPanel").classList.contains("show")&&$("exchangeManualValue").value===manualEditorBaseline){
      const record=manualRecords[currency];manualEditorBaseline=record?inputValue(nominalQuote(record.rate,exchangeMeta[currency].nominal)):"";
      $("exchangeManualValue").value=manualEditorBaseline;updateExchangeManualPreview();
    }
    renderOffers();if(currentView==="calculator")renderPlanner();
  }
});
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden){syncPersonal();refreshRatesIfDue(60000);}
});
window.addEventListener("online",()=>refreshRatesIfDue(0));
setInterval(()=>{calc();renderBanks();return refreshRatesIfDue();},60000);
