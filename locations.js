/* Public branch addresses, separate from quotes and personal purchase data.
   Checked against the networks' official directories on 2026-09-06.
   Coordinates are only taken from unambiguous POI links or checked map results.
   No inferred opening hours or branch-specific exchange rates. */
(function(root){
  "use strict";
  const checkedAt="2026-09-06T00:00:00Z";
  const cities={tbilisi:{name:"Тбилиси",map:"Tbilisi"},batumi:{name:"Батуми",map:"Batumi"},rustavi:{name:"Рустави",map:"Rustavi"}};
  const directories={
    mjc:{source:"https://mjc.ge/contact",addresses:{
      tbilisi:["89/91 Davit Aghmashenebeli Avenue"],
      rustavi:["3 Leonidze Street"]
    }},
    rico:{source:"https://www.rico.ge/en/branches/",addresses:{
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
      rustavi:["3 Megobroba Avenue","19 Kostava Street","12 Leonidze Street"]
    }}
  };
  // Rico: single !3d/!4d POI in the official branch's map link, not the @ map centre.
  // Multi-POI links (e.g. Chavchavadze 12 linking to Basisbank) are excluded.
  // MJC Tbilisi: Google Maps resolved the officially listed building 89/91;
  // Yandex text search matched a different Aghmashenebeli street, so never route by that text.
  const points={
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
    "rico:batumi:25 Ilia Chavchavadze Street":[41.645256,41.6385689]
  };
  function branches(office,city="tbilisi"){
    const directory=Object.hasOwn(directories,office)?directories[office]:null;
    if(!directory)return [];
    return Object.entries(directory.addresses).flatMap(([key,addresses])=>
      city!=="all"&&city!==key?[]:addresses.map((address,index)=>({
        id:office+":"+key+":"+index,city:key,address:cities[key].name+", "+address,
        destination:address+", "+cities[key].map+", Georgia",source:directory.source,checkedAt,
        point:points[office+":"+key+":"+address]||null
      })));
  }
  function mapLinks(destination,searchOnly=true){
    if(typeof destination!=="string"||!destination.trim())return null;
    const query=encodeURIComponent(destination);
    return {
      google:"https://www.google.com/maps/"+(searchOnly?"search/?api=1&query=":"dir/?api=1&destination=")+query,
      apple:"https://maps.apple.com/?"+(searchOnly?"q=":"daddr=")+query,
      yandex:"https://yandex.ru/maps/?"+(searchOnly?"text=":"rtext=~")+query
    };
  }
  function branchLinks(branch){
    if(!branch)return null;
    return branch.point?mapLinks(branch.point.join(","),false):mapLinks(branch.destination,true);
  }
  function bankSearch(name,city){
    const place=Object.hasOwn(cities,city)?cities[city].map:"Georgia";
    return mapLinks(String(name).slice(0,120)+" bank branches, "+place+(place==="Georgia"?"":", Georgia"),true);
  }
  const api={checkedAt,branches,mapLinks,branchLinks,bankSearch};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.GelLocations=api;
})(typeof window!=="undefined"?window:this);
