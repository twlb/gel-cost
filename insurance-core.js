(function(root){
  'use strict';
  const allowedHosts=new Set(['unison.ge','ardi.ge','www.gpih.ge']);
  function validate(data){
    if(data?.schemaVersion!==1||!Array.isArray(data.products)||!data.products.length||data.products.length>100||!data.sources)throw Error('catalog');
    const ids=new Set();
    for(const s of Object.values(data.sources)){
      const u=new URL(s.url);
      if(u.protocol!=='https:'||!allowedHosts.has(u.hostname)||u.username||u.password||!/^\d{4}-\d{2}-\d{2}$/.test(s.checkedOn))throw Error('source');
    }
    for(const p of data.products){
      if(typeof p.id!=='string'||!/^[-a-z0-9]+$/.test(p.id)||ids.has(p.id)||typeof p.plan!=='string'||typeof p.insurer!=='string'||!Array.isArray(p.sourceIds)||!p.sourceIds.length||p.sourceIds.some(id=>!data.sources[id]))throw Error('product');
      ids.add(p.id);
      if(p.personalizedRankingAllowed!==false||p.foreignResidentEligibility?.status!=='unknown'||p.batumiNetwork?.status!=='unknown')throw Error('unsupported scope');
      if(p.familyQuote?.value!==null||p.batumiNetwork.clinics!==null||p.foreignResidentEligibility.value!==null)throw Error('unsupported data');
      for(const price of [p.price,...(p.priceOptions||[])].filter(Boolean)){
        if(!data.sources[price.sourceId]||price.currency!=='GEL'||price.annualTotal!==null||!['month',null].includes(price.period)||!['published_not_personal_quote','ambiguous','ambiguous_mapping'].includes(price.status)||price.value!==null&&(!Number.isFinite(price.value)||price.value<=0))throw Error('price');
      }
    }
    return data;
  }
  function priceText(p){
    if(p.price?.status==='ambiguous_mapping')return 'Стоимость семьи — уточнить';
    if(p.price?.status==='ambiguous')return 'Цена требует уточнения';
    if(p.price?.status==='published_not_personal_quote'&&p.price.period==='month'&&Number.isFinite(p.price.value))return new Intl.NumberFormat('ru-RU').format(p.price.value)+' ₾/мес.';
    return 'Период цены не подтверждён';
  }
  function caution(p){
    if(p.id==='unison-premium')return 'Плановая госпитализация: в карточке 100%, в таблице 90%. Условия нужно уточнить.';
    if(p.id.startsWith('unison-family-'))return 'В таблице источника повторяются названия столбцов. Семейный тариф нельзя определить однозначно.';
    if(p.id==='gpi-medi-standard')return 'На странице разные начальные цены и акция. Применимый тариф нужно уточнить.';
    if(p.id.startsWith('ardi-'))return 'Цены разных схем не подтверждены для иностранцев; период оплаты в карточке не указан.';
    return 'Лимиты, доплаты, ожидание и исключения уточните в условиях выбранного полиса.';
  }
  const api={validate,priceText,caution};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.InsuranceCore=api;
})(typeof window==='object'?window:globalThis);
