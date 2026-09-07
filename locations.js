/* Public branch addresses, separate from quotes and personal purchase data.
   Original catalog checked on 2026-09-06; new cities checked on 2026-09-07.
   Coordinates are only taken from unambiguous POI links or checked map results.
   No inferred opening hours or branch-specific exchange rates. */
(function(root){
  "use strict";
  const checkedAt="2026-09-06T00:00:00Z";
  const cities={
    tbilisi:{name:"Тбилиси",map:"Tbilisi"},batumi:{name:"Батуми",map:"Batumi"},
    rustavi:{name:"Рустави",map:"Rustavi"},kobuleti:{name:"Кобулети",map:"Kobuleti"},
    poti:{name:"Поти",map:"Poti"},kutaisi:{name:"Кутаиси",map:"Kutaisi"}
  };
  const directories={
    // Apple web place cards reverse-geocode this POI to a street and lose the
    // destination in Directions. Use a verified Google coordinate pin for this branch only.
    inteli:{source:"https://inteliexpress.com/local-addresses/",appleFallback:"google",checkedByCity:{batumi:"2026-09-07T00:00:00Z"},
      addresses:{batumi:["25 Baratashvili Street"]}},
    mjc:{source:"https://mjc.ge/contact",addresses:{
      tbilisi:["89/91 Davit Aghmashenebeli Avenue"],
      rustavi:["3 Leonidze Street"]
    }},
    rico:{source:"https://www.rico.ge/en/branches/",checkedByCity:{
      kobuleti:"2026-09-07T00:00:00Z",poti:"2026-09-07T00:00:00Z",kutaisi:"2026-09-07T00:00:00Z"
    },addresses:{
      tbilisi:[
        "70 Ilia Chavchavadze Avenue","12 Ilia Chavchavadze Avenue","24 Kostava Street",
        "21 Pushkin Street","9 Tamar Mepe Avenue","131a Akaki Tsereteli Avenue",
        "114a Akaki Tsereteli Avenue","77 Dadiani Street","39 Dadiani Street",
        "321 Tsotne Dadiani Street","25 Davit Guramishvili Avenue","41 Kazbegi Avenue",
        "5 Pekini Street","4 Alexander Kalandadze Street","2 Javakheti Street",
        "112 Kakheti Highway","18 Khizanishvili Street","1b Gobronidze Street",
        "3 Teofane Davitaia Street","13 Ioane Petritsi Street","44 Mirian Mepe Street",
        "7a Evgni Mikeladze Street","45 Guramishvili Street","39 Gorgasali Street",
        "1 Moscow Avenue","42 Moscow Avenue"
      ],
      batumi:["25 Ilia Chavchavadze Street","18 Baratashvili Street","64 Airport Highway",
        "8a Kobaladze Street","15 Severiane Achareli Street","1 Sherif Khimshiashvili Street"],
      rustavi:["3 Megobroba Avenue","19 Kostava Street","12 Leonidze Street"],
      kobuleti:["3 Rustaveli Street"],
      poti:["2 Lolua Street"],
      // Only unambiguous street/building addresses from the official directory.
      // The Bukia intersection and ambiguously numbered microdistrict are omitted.
      kutaisi:["62 Ilia Chavchavadze Avenue","2 Davit Agmashenebeli Square",
        "2 Nikea Street","50 Ilia Chavchavadze Avenue","101 A. Tsereteli Street"]
    }}
  };
  // Rico: single !3d/!4d POI in the official branch's map link, not the @ map centre.
  // Multi-POI links (e.g. Chavchavadze 12 linking to Basisbank) are excluded.
  // MJC Tbilisi: Google Maps resolved the officially listed building 89/91;
  // Yandex text search matched a different Aghmashenebeli street, so never route by that text.
  const points={
    // Google Maps POI 0x406787eaed51f111:0xa1bb5f621cb58bcb, checked 2026-09-07:
    // INTELIEXPRESS, 25 Nikoloz Baratashvili Street, Batumi. !3d/!4d POI, not viewport.
    "inteli:batumi:25 Baratashvili Street":[41.6492744,41.6374353],
    "mjc:tbilisi:89/91 Davit Aghmashenebeli Avenue":[41.7102279,44.7970808],
    "rico:tbilisi:70 Ilia Chavchavadze Avenue":[41.7112122,44.7558822],
    "rico:tbilisi:9 Tamar Mepe Avenue":[41.718854,44.792886],
    "rico:tbilisi:131a Akaki Tsereteli Avenue":[41.749116,44.7779241],
    "rico:tbilisi:114a Akaki Tsereteli Avenue":[41.7375386,44.7813377],
    "rico:tbilisi:77 Dadiani Street":[41.728218,44.798883],
    "rico:tbilisi:41 Kazbegi Avenue":[41.7244004,44.7458483],
    "rico:tbilisi:5 Pekini Street":[41.72028,44.776227],
    "rico:tbilisi:4 Alexander Kalandadze Street":[41.7262456,44.7708106],
    "rico:tbilisi:2 Javakheti Street":[41.6872734,44.8708114],
    "rico:tbilisi:112 Kakheti Highway":[41.692877,45.001136],
    "rico:tbilisi:18 Khizanishvili Street":[41.793761,44.81646],
    "rico:tbilisi:1b Gobronidze Street":[41.790875,44.816746],
    "rico:tbilisi:3 Teofane Davitaia Street":[41.7001078,44.8520311],
    "rico:tbilisi:13 Ioane Petritsi Street":[41.7927226,44.7577841],
    "rico:tbilisi:7a Evgni Mikeladze Street":[41.7623412,44.7753137],
    "rico:tbilisi:1 Moscow Avenue":[41.6848816,44.8545502],
    "rico:rustavi:19 Kostava Street":[41.54332,45.010431],
    "rico:batumi:25 Ilia Chavchavadze Street":[41.645256,41.6385689],
    // Official Rico directory links rechecked in Maps on 2026-09-07:
    // https://maps.app.goo.gl/aLMEC9cvijJhmrkc8 — building 8a, not a street centre.
    "rico:batumi:8a Kobaladze Street":[41.6338869,41.6068395],
    // https://maps.app.goo.gl/dtiDK5PHHqwisTYt7 — explicit coordinate pin.
    "rico:batumi:15 Severiane Achareli Street":[41.643279,41.654425],
    // Official directory's See Location links verified on 2026-09-07.
    // Extracted single !3d/!4d POI, never the distinct @ viewport centre.
    // Kobuleti's official POI (41.810982,41.78012) resolves to Javakhishvili
    // Street in Apple Maps, not the listed Rustaveli 3. Keep address search
    // until this mismatch is resolved; a source link alone is not verification.
    // Poti: place 0x405db80ba5c490ef:0x70f08a67563e12ea.
    "rico:poti:2 Lolua Street":[42.145482,41.677306],
    // Kutaisi, Chavchavadze 62: place 0x405c8cc969988cd5:0x1e1b2afb5bc4fba8.
    "rico:kutaisi:62 Ilia Chavchavadze Avenue":[42.2579718,42.6691528]
  };
  function branches(office,city="batumi"){
    const directory=Object.hasOwn(directories,office)?directories[office]:null;
    if(!directory)return [];
    return Object.entries(directory.addresses).flatMap(([key,addresses])=>
      city!=="all"&&city!==key?[]:addresses.map((address,index)=>({
        id:office+":"+key+":"+index,city:key,address:cities[key].name+", "+address,
        destination:address+", "+cities[key].map+", Georgia",source:directory.source,
        checkedAt:directory.checkedByCity?.[key]||checkedAt,
        point:points[office+":"+key+":"+address]||null,
        appleFallback:directory.appleFallback||null
      })));
  }
  // Open a place, never directions with an implicit/guessed starting point.
  // The user can choose and verify the route origin inside their map app.
  function mapLinks(destination){
    if(typeof destination!=="string"||!destination.trim())return null;
    const query=encodeURIComponent(destination);
    return {
      google:"https://www.google.com/maps/search/?api=1&query="+query,
      apple:"https://maps.apple.com/?q="+query,
      yandex:"https://yandex.ru/maps/?text="+query
    };
  }
  function branchLinks(branch){
    if(!branch)return null;
    if(!validPoint(branch.point))return mapLinks(branch.destination);
    const [lat,lon]=branch.point;
    const latLon=encodeURIComponent(lat+","+lon),lonLat=encodeURIComponent(lon+","+lat);
    const google="https://www.google.com/maps/search/?api=1&query="+latLon;
    return {
      google,
      apple:branch.appleFallback==="google"?google:"https://maps.apple.com/place?coordinate="+latLon+"&name="+encodeURIComponent(branch.address),
      // Yandex place cards use longitude,latitude (unlike route/search coordinates).
      yandex:"https://yandex.ru/maps/?whatshere%5Bpoint%5D="+lonLat+"&whatshere%5Bzoom%5D=17"
    };
  }
  function validPoint(point){
    return Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)&&Math.abs(point[0])<=90&&Math.abs(point[1])<=180;
  }
  // Generic Android geo Intent: Android, not this site, resolves installed handlers.
  // An HTTPS fallback avoids dead-end custom-scheme probes. No package enumeration.
  function deviceMapLink(links){
    try{
      const url=new URL(links?.google);
      if(url.protocol!=="https:"||url.hostname!=="www.google.com"||url.pathname!=="/maps/search/")return null;
      const query=url.searchParams.get("query");
      if(!query)return null;
      return "intent:0,0?q="+encodeURIComponent(query)+"#Intent;scheme=geo;action=android.intent.action.VIEW;S.browser_fallback_url="+encodeURIComponent(url.href)+";end";
    }catch{return null;}
  }
  function bankSearch(name,city){
    const place=Object.hasOwn(cities,city)?cities[city].map:"Georgia";
    return mapLinks(String(name).slice(0,120)+" bank branches, "+place+(place==="Georgia"?"":", Georgia"));
  }
  const api={checkedAt,branches,mapLinks,branchLinks,bankSearch,validPoint,deviceMapLink};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.GelLocations=api;
})(typeof window!=="undefined"?window:this);
