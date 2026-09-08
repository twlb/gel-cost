/* Open-Meteo model current conditions, not a local station observation.
 * https://open-meteo.com/en/docs (current, WMO codes, Unix UTC time)
 * https://open-meteo.com/en/terms: free endpoint NON-COMMERCIAL only; CC-BY 4.0.
 * City centres verified with geocoding-api.open-meteo.com/v1/search on 2026-09-08.
 * Kobuleti is GeoNames 613762/PPLA2, not the similarly named village or airfield.
 * No geolocation, personal storage, cookies, API key or financial data is used.
 */
(function(root){
  'use strict';
  const cities=Object.freeze({
    batumi:Object.freeze({name:'Батуми',latitude:41.64077,longitude:41.63060}),
    kobuleti:Object.freeze({name:'Кобулети',latitude:41.83283,longitude:41.77823}),
    poti:Object.freeze({name:'Поти',latitude:42.14272,longitude:41.67384}),
    kutaisi:Object.freeze({name:'Кутаиси',latitude:42.26791,longitude:42.69459}),
    tbilisi:Object.freeze({name:'Тбилиси',latitude:41.69143,longitude:44.83412})
  });
  const descriptions={0:'Ясно',1:'Малооблачно',2:'Переменная облачность',3:'Пасмурно',45:'Туман',48:'Изморозь и туман',51:'Слабая морось',53:'Морось',55:'Сильная морось',56:'Ледяная морось',57:'Сильная ледяная морось',61:'Небольшой дождь',63:'Дождь',65:'Сильный дождь',66:'Ледяной дождь',67:'Сильный ледяной дождь',71:'Небольшой снег',73:'Снег',75:'Сильный снег',77:'Снежные зёрна',80:'Небольшой ливень',81:'Ливень',82:'Сильный ливень',85:'Снежный ливень',86:'Сильный снежный ливень',95:'Гроза',96:'Гроза с градом',99:'Сильная гроза с градом'};
  const MAX_AGE=60*60*1000,REFRESH=15*60*1000,TIMEOUT=8000;
  function iconName(code,isDay){
    if(code===0)return isDay?'sun':'moon';
    if(code===1||code===2)return isDay?'cloud-sun':'cloud-moon';
    if(code===3)return 'cloud';
    if(code===45||code===48)return 'cloud-fog';
    if(code>=95)return 'cloud-lightning';
    if([71,73,75,77,85,86].includes(code))return 'cloud-snow';
    return Object.hasOwn(descriptions,code)?'cloud-rain':null;
  }
  function city(key){return Object.hasOwn(cities,key)?cities[key]:null;}
  function requestURL(key){
    const place=city(key);if(!place)return null;
    const url=new URL('https://api.open-meteo.com/v1/forecast');
    for(const [k,v] of Object.entries({latitude:place.latitude,longitude:place.longitude,current:'temperature_2m,weather_code,is_day',temperature_unit:'celsius',timeformat:'unixtime',timezone:'GMT',forecast_days:1}))url.searchParams.set(k,v);
    return url.href;
  }
  function validate(data,key,now=Date.now()){
    const place=city(key),value=data?.current,units=data?.current_units;
    if(!place||data.error||!value||units?.temperature_2m!=='°C'||units.time!=='unixtime')throw Error('weather format');
    if(!Number.isFinite(data.latitude)||!Number.isFinite(data.longitude)||Math.abs(data.latitude-place.latitude)>.3||Math.abs(data.longitude-place.longitude)>.3)throw Error('weather location');
    if(!Number.isFinite(value.temperature_2m)||value.temperature_2m< -90||value.temperature_2m>65||!Number.isInteger(value.weather_code)||!Object.hasOwn(descriptions,value.weather_code)||![0,1].includes(value.is_day))throw Error('weather value');
    if(!Number.isInteger(value.time)||value.time*1000>now+15*60*1000||now-value.time*1000>MAX_AGE)throw Error('weather age');
    return {city:key,temperature:value.temperature_2m,code:value.weather_code,isDay:value.is_day===1,time:value.time*1000,description:descriptions[value.weather_code]};
  }
  function mount(env=root){
    const doc=env.document,status=doc?.getElementById('weatherStatus'),description=doc?.getElementById('weatherDescription'),temperature=doc?.getElementById('weatherTemperature'),icon=doc?.getElementById('weatherIcon'),select=doc?.getElementById('exchangeCity');
    if(!status||!description||!temperature||!select)return null;
    const cache=new Map();let sequence=0,controller=null,shown=null,disposed=false;
    const now=()=>env.Date.now(),key=()=>select.value||'batumi';
    function message(text){description.textContent=text;status.setAttribute('aria-label',text);temperature.textContent='—';status.title=text+' · Open-Meteo';if(icon)icon.hidden=true;shown=null;}
    function paint(value){
      const place=city(value.city),rounded=Math.round(value.temperature),degrees=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Object.is(rounded,-0)?0:rounded);
      description.textContent=place.name+' · '+value.description;
      temperature.textContent=degrees+'°';
      status.setAttribute('aria-label',place.name+' · '+value.description+' · '+degrees+' градусов Цельсия');
      status.title='По модели Open-Meteo · '+new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Tbilisi',hour:'2-digit',minute:'2-digit'}).format(value.time)+' (Грузия)';
      if(icon){icon.alt='';icon.setAttribute('aria-hidden','true');icon.onerror=()=>{icon.hidden=true;};icon.src='brand/icons/weather/'+iconName(value.code,value.isDay)+'.svg';icon.hidden=false;}
      shown=value;
    }
    async function refresh(force=false){
      if(disposed)return;
      const selected=key(),place=city(selected),ticket=++sequence;controller?.abort();controller=null;
      if(!place){message('Погода: выберите город');return;}
      const saved=cache.get(selected);
      if(!force&&saved&&now()-saved.fetchedAt<REFRESH&&now()-saved.value.time<=MAX_AGE){paint(saved.value);return;}
      message(place.name+' · Погода загружается');
      controller=new env.AbortController();const ownController=controller;
      let timer;
      const timeout=new Promise((resolve,reject)=>{timer=env.setTimeout(()=>{ownController.abort();reject(Error('weather timeout'));},TIMEOUT);});
      try{
        const request=(async()=>{const response=await env.fetch(requestURL(selected),{signal:ownController.signal,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});if(!response.ok)throw Error('weather HTTP');return response.json();})();
        const data=await Promise.race([request,timeout]);
        if(disposed||ticket!==sequence||key()!==selected)return;
        const value=validate(data,selected,now());cache.set(selected,{value,fetchedAt:now()});paint(value);
      }catch(error){
        if(disposed||ticket!==sequence||key()!==selected)return;
        cache.delete(selected);message(place.name+' · Погода недоступна');
      }finally{env.clearTimeout(timer);if(controller===ownController)controller=null;}
    }
    const onChange=()=>refresh();
    const onVisible=()=>{if(!doc.hidden)refresh();};
    select.addEventListener('change',onChange);doc.addEventListener('visibilitychange',onVisible);
    // Check expiry even when a request cannot complete; never leave an old number as current.
    const tick=env.setInterval(()=>{if(doc.hidden)return;if(shown&&(shown.city!==key()||now()-shown.time>MAX_AGE))message('Погода требует обновления');refresh();},REFRESH);
    refresh();
    return {refresh,destroy(){disposed=true;sequence++;controller?.abort();env.clearInterval(tick);select.removeEventListener?.('change',onChange);doc.removeEventListener?.('visibilitychange',onVisible);}};
  }
  const api={cities,requestURL,validate,iconName,mount,MAX_AGE,REFRESH,TIMEOUT};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.GamarjiWeather=api;const instance=mount(root);api.refresh=()=>instance?.refresh();}
})(typeof window==='object'?window:globalThis);
