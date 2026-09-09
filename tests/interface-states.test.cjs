// Content and computed-token contracts; browser geometry is checked separately.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const html=read('index.html'),css=read('theme.css');

test('only explicit close controls restore focus and direct openers pass their node',()=>{
  for(const id of ['settingsPanel','purchasePanel','ratePanel','exchangeManualPanel'])
    assert.match(html,new RegExp('onclick="dismissInline\\(\''+id+'\'\\)"'));
  assert.doesNotMatch(html,/onclick="closeInline\(/);
  const openers=Array.from(html.matchAll(/onclick="(openPurchase|openSettings|openExchangeManual)\(([^)]*)\)"/g));
  assert.equal(openers.length,6);
  for(const [,name,args] of openers)assert.match(args,/(?:^|,)this$/,name);
});

test('general insurance warnings never assume Batumi or promise city-specific cover',()=>{
  const intro=html.split('id="insuranceBrowseIntro"')[1].split('id="insuranceSelection"')[0];
  assert.match(intro,/не персональный подбор/);
  assert.match(intro,/клиники в вашем городе уточните у страховой/);
  assert.doesNotMatch(intro,/клиники Батуми/);
  assert.match(read('insurance.js'),/семейную цену и клиники в вашем городе уточните у страховой/);
});

test('USDT settings name their own tool and keep the calculator commission boundary explicit',()=>{
  const panel=html.split('id="settingsPanel"')[1].split('id="settingsError"')[0];
  assert.match(panel,/Пересчитать цену в рубли/);
  assert.match(panel,/Комиссии калькулятора задаются отдельно/);
  assert.match(panel,/Оба процента — от базовой стоимости/);
  assert.match(panel,/«По операции» повторно не учитываются/);
});

test('current navigation adds a non-colour marker without covering pointer targets',()=>{
  const marker=css.match(/\.bottom-nav button\[aria-current=page\]::before\s*\{([^}]+)\}/)?.[1];
  assert.ok(marker);
  assert.match(marker,/position:\s*absolute/);
  assert.match(marker,/border:\s*1px solid var\(--accent\)/);
  assert.match(marker,/background:\s*var\(--selected\)/);
  assert.match(marker,/pointer-events:\s*none/);
  assert.doesNotMatch(css,/\.bottom-nav button\[aria-current=page\][^{]*\{[^}]*outline:\s*(?:none|0)/);
});

function luminance(hex){
  const rgb=hex.match(/[a-f\d]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
}
test('best-rate badge text clears 4.5:1 with the actual tokens in both themes',()=>{
  const badge=css.match(/\.offer-best\s*\{([^}]+)\}/)?.[1];
  assert.match(badge,/color:\s*var\(--text\)/);
  assert.match(badge,/background:\s*var\(--selected\)/);
  for(const selector of [':root',':root[data-theme="dark"]']){
    const block=css.slice(css.indexOf(selector+' {')).split('}')[0];
    const token=name=>block.match(new RegExp('--'+name+':\\s*(#[a-f\\d]{6})','i'))[1];
    const values=[luminance(token('text')),luminance(token('selected'))].sort((a,b)=>a-b);
    assert.ok((values[1]+.05)/(values[0]+.05)>=4.5,selector);
  }
});
