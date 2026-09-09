/* Official provider directory, NOT an outage feed. No subscriber IDs, location,
 * credentials, third-party requests or financial storage. Sources and limits:
 * qa/city-services-ux-1/SOURCES.md, checked 2026-09-08. */
(function(root){
  'use strict';
  const providers=Object.freeze({
    energo:{name:'Energo-Pro Georgia',url:'https://my.energo-pro.ge/ow/#/disconns',action:'Объявления об отключениях',note:'Выберите город и проверьте улицу в списке поставщика.'},
    telasi:{name:'Telasi',url:'https://www.telasi.ge/ka/company-news/power-outage',action:'Объявления об отключениях',note:'Список у поставщика загружается отдельно. Пустая страница не подтверждает отсутствие отключений.'},
    socar:{name:'SOCAR Georgia Gas',url:'https://mygas.ge/',action:'Объявления об отключениях',note:'Проверьте населённый пункт и дату объявления.'},
    tbilisiEnergy:{name:'Tbilisi Energy',url:'https://te.ge/',action:'Сайт поставщика',note:'Доступ к сайту при нашей проверке был ограничен. Актуальный график не подтверждён.'},
    batumiWater:{name:'Batumi Water',url:'https://bats.ge/',action:'Сайт поставщика',phone:'1152',note:'Актуальный график не подтверждён. Сайт открывается без защищённого соединения. Не вводите личные данные.'},
    kobuletiWater:{name:'Кобулетский водоканал',url:'https://kobuleti.gov.ge/?p=1659',action:'Контакты водоканала',note:'Контакты на сайте мэрии. Актуальный график не подтверждён.'},
    unitedWater:{name:'United Water Supply Company',url:'https://www.water.gov.ge/page/full/107',action:'Объявления об отключениях',note:'Проверьте город, адрес и время работ у поставщика.'},
    gwp:{name:'Georgian Water and Power',url:'https://www.gwp.ge/',action:'Сайт поставщика',note:'Доступность сайта при нашей проверке не подтверждена. Текущие отключения нужно уточнить у поставщика.'}
  });
  const cities=Object.freeze({
    batumi:{name:'Батуми',power:'energo',water:'batumiWater',gas:'socar'},
    kobuleti:{name:'Кобулети',power:'energo',water:'kobuletiWater',gas:'socar'},
    poti:{name:'Поти',power:'energo',water:'unitedWater',gas:'socar'},
    kutaisi:{name:'Кутаиси',power:'energo',water:'unitedWater',gas:'socar'},
    tbilisi:{name:'Тбилиси',power:'telasi',water:'gwp',gas:'tbilisiEnergy'}
  });
  const kinds=[{key:'power',name:'Свет',icon:'zap'},{key:'water',name:'Вода',icon:'droplet'},{key:'gas',name:'Газ',icon:'flame'}];
  function forCity(key){
    if(!Object.hasOwn(cities,key))return null;
    const city=cities[key];
    return {name:city.name,rows:kinds.map(kind=>({...kind,...providers[city[kind.key]]}))};
  }
  function mount(env=root){
    const doc=env.document,$=id=>doc?.getElementById(id);
    const view=$('servicesView'),cityLabel=$('servicesCity'),list=$('servicesList'),select=$('exchangeCity');
    if(![view,cityLabel,list,select].every(Boolean))return null;
    function render(){
      const data=forCity(select.value);
      cityLabel.textContent=data?data.name:'Выберите город в шапке';
      list.replaceChildren(...(data?.rows||[]).map(row=>{
        const card=doc.createElement('article');card.className='service-row';
        const title=doc.createElement('h2'),icon=doc.createElement('img');
        icon.className='ui-icon';icon.src='brand/icons/interface/'+row.icon+'.svg';icon.alt='';icon.width=22;icon.height=22;
        const label=doc.createElement('span');label.textContent=row.key==='power'?'Свет':row.key==='water'?'Вода':'Газ';title.append(icon,label);
        const provider=doc.createElement('p');provider.textContent=row.name;
        const note=doc.createElement('p');note.textContent=row.note;
        const link=doc.createElement('a');link.href=row.url;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';link.textContent=row.action;link.setAttribute('aria-label',row.action+' — '+row.name+' (новая вкладка)');
        card.append(title,provider,note,link);
        if(row.phone){const phone=doc.createElement('a');phone.href='tel:'+row.phone;phone.textContent='Позвонить '+row.phone;phone.setAttribute('aria-label','Позвонить в '+row.name+': '+row.phone);card.append(phone);}
        return card;
      }));
      const unavailable=$('servicesUnavailable');if(unavailable)unavailable.hidden=true;
    }
    const onCity=()=>{if(!view.hidden)render();};
    select.addEventListener('change',onCity);
    render();
    return {render,destroy(){select.removeEventListener('change',onCity);}};
  }
  const api={forCity,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.GamarjiServices=api;const instance=mount(root);api.render=()=>instance?.render();}
})(typeof window==='object'?window:globalThis);
