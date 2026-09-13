/* Actual dashboard DOM/canvas interactions for the quiet frontier hints. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const robust = fs.readFileSync(path.join(repo, 'tests/robust_frontier_ui_probe.js'), 'utf8');
const sixFixture = robust.slice(robust.indexOf('const SIX_ASSET_FIXTURE = (() => {'), robust.indexOf('\n`;\nconst reloadCode'));
const canvas = robust.slice(robust.indexOf('function draw(c,dpr=1){'), robust.indexOf('function assertContained(c){'));
const code = String.raw`
const assert = require('node:assert/strict');
const extra = vm.runInContext('({portCorrKey, portHintSettings, portContributions})', sandbox);
vm.runInContext(
  'const originalHints = portOpportunityHints, originalDrawHints = portDrawHints;' +
  'portOpportunityHints = (...args) => { const value = originalHints(...args); globalThis.hintCalculation = JSON.stringify(value); return value; };' +
  'portDrawHints = (u,hints,markers) => { globalThis.hintDraws=(globalThis.hintDraws||0)+1; globalThis.paintedHints=hints; globalThis.paintedMarkers=markers; return originalDrawHints(u,hints,markers); };', sandbox);
shim.UPlotStub.prototype.destroy = function(){ this.dead=true; };
const panel=DOC.getElementById('alloc-port-panel');
const card=()=>panel.querySelector('.port-frontier');
const chart=()=>shim.UPlotStub.made.filter(c=>!c.dead&&c.opts.series.some(s=>s.label==='경계선')).pop();
const byId=(id)=>DOC.getElementById(id);
const click=(text)=>{const b=Array.from(card().querySelectorAll('button')).find(n=>n.textContent===text);assert(b,text);b.click();};
const tip=()=>card().querySelector('.port-portfolio-tooltip');
const near=(a,b,tol=1e-8)=>assert(Math.abs(a-b)<=tol,a+' != '+b);
const assets=SIX_ASSET_FIXTURE.port.assets;
const expectedMeans=[4.6,3.9,6,21,16,15], expectedVols=[4,3,9,23,19,18];
const corr={};
assets.forEach((a,i)=>assets.slice(i+1).forEach(b=>{corr[extra.portCorrKey(a,b)]=.4;}));
const state={...P.portDefaults(SIX_ASSET_FIXTURE.port),
  mu:Object.fromEntries(assets.map((a,i)=>[a,expectedMeans[i]])),
  sig:Object.fromEntries(assets.map((a,i)=>[a,expectedVols[i]])),corr};
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(state));
shim.localStorage.removeItem('iaw-port-hints');
P.DATA.alloc=SIX_ASSET_FIXTURE;P.renderPortPanel(SIX_ASSET_FIXTURE);
const savedFinancial=shim.localStorage.getItem(P.PORT_LS_KEY);
const financial=()=>({data:chart().data, state:P.portState(SIX_ASSET_FIXTURE.port),
  cma:panel.querySelector('.port-export').value});
const initialFinancial=JSON.stringify(financial()), initialCalculation=sandbox.hintCalculation;
assert(byId('port-hints-panel').hidden);
assert.equal(byId('port-hints-toggle').getAttribute('aria-expanded'),'false');
assert(byId('port-hints-gaps').checked&&byId('port-hints-diversification').checked);
assert.equal(byId('port-hints-shrink').value,'20');
const base=JSON.parse(initialCalculation);
assert(base.gaps.length>0&&base.gaps.length<=3);
assert(base.diversification.length>0&&base.diversification.length<=3);
const E=P.portEngine(SIX_ASSET_FIXTURE.port,P.portState(SIX_ASSET_FIXTURE.port));
const quadratic=(C,w)=>w.reduce((s,wi,i)=>s+wi*C[i].reduce((t,cij,j)=>t+cij*w[j],0),0);
const mean=(w)=>w.reduce((s,wi,i)=>s+wi*expectedMeans[i],0);
function assertFinancial(){
  assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),savedFinancial);
  assert.equal(JSON.stringify(financial()),initialFinancial);
}
function painted(){draw(chart());return sandbox.paintedHints;}
function hover(p,paint){moveCursor(chart(),paint,paint.u.valToPos(p.x,'x'),paint.u.valToPos(p.y,'y'));}
for(const dpr of [1,2]){
  const paint=draw(chart(),dpr), hints=sandbox.paintedHints;
  for(const kind of ['gap','diversification']){
    const selected=hints.filter(p=>p.kind===kind);
    assert(selected.length<=3);
    assert(selected.some(p=>!p.hiddenForPlot),kind+' should have a visible example');
    for(const p of selected.filter(p=>!p.hiddenForPlot)){
      hover(p,paint);assert(!tip().hidden);
      assert.equal(tip().querySelector('.port-tooltip-title').textContent,p.label);
      near(p.y,mean(p.w));near(p.baseX,Math.sqrt(quadratic(E.risk.C,p.w)));
      const expectedC=E.risk.C.map((row,i)=>row.map((v,j)=>i===j?v:.8*v));
      const C=kind==='gap'?E.risk.C:expectedC;
      near(p.x,Math.sqrt(quadratic(C,p.w)));
      if(kind==='gap')assert(tip().textContent.includes('현재 자산 조합'));
      else {
        assert(tip().textContent.includes('가정')&&tip().textContent.includes('동일 비중'));
        assert(tip().textContent.includes('현재 달성 가능성을 뜻하지 않음'));
        assert(tip().textContent.includes('위험기여: 가정 상관 기준'));
        near(p.riskReduction,p.baseX-p.x);assert(p.riskReduction>0);
      }
      const rows=Array.from(tip().querySelectorAll('.port-tooltip-weight'));
      assert.equal(rows.length,assets.length);
      const displayedRisk=rows.map(r=>parseFloat(r.querySelector('.port-tooltip-risk').textContent));
      const displayedReturn=rows.map(r=>parseFloat(r.querySelector('.port-tooltip-return').textContent));
      const variance=quadratic(C,p.w),m=mean(p.w);
      rows.forEach((r,i)=>{
        near(parseFloat(r.querySelector('b').textContent),p.w[i]*100,.00501);
        const risk=100*p.w[i]*C[i].reduce((s,v,j)=>s+v*p.w[j],0)/variance;
        near(displayedRisk[i],risk,.00501);
        near(displayedReturn[i],100*p.w[i]*expectedMeans[i]/m,.00501);
      });
      near(displayedRisk.reduce((s,v)=>s+v,0),100,.031);
      near(displayedReturn.reduce((s,v)=>s+v,0),100,.031);
    }
  }
  const hintInk=paint.strokes.filter(s=>/,0\.42\)$/.test(s.color));
  assert(hintInk.length>0&&hintInk.every(s=>s.width<=1.1*dpr&&s.clip));
}
byId('port-hints-toggle').click();assert(!byId('port-hints-panel').hidden);
const toggle=(kind,value)=>{const n=byId('port-hints-'+kind);n.checked=value;n.dispatchEvent({type:'change'});};
toggle('gaps',false);assert(!painted().some(p=>p.kind==='gap'));assertFinancial();
toggle('diversification',false);assert(!card().querySelector('.port-hint-key'));assertFinancial();
const beforeDisabledDraw=sandbox.hintDraws,disabledPaint=draw(chart());
assert.equal(sandbox.hintDraws,beforeDisabledDraw);
hover(base.gaps[0],disabledPaint);assert.notEqual(tip().querySelector('.port-tooltip-title')?.textContent,'자산 공백');
P.renderPortPanel(SIX_ASSET_FIXTURE);
assert(!byId('port-hints-gaps').checked&&!byId('port-hints-diversification').checked);
assert(!byId('port-hints-panel').hidden);
toggle('gaps',true);toggle('diversification',true);
const shrink=(value,enter=false)=>{const n=byId('port-hints-shrink');n.value=String(value);
  n.dispatchEvent(enter?{type:'keydown',key:'Enter',preventDefault(){}}:{type:'change'});};
shrink(0);assert(!painted().some(p=>p.kind==='diversification'));
assert.equal(extra.portHintSettings().shrink,0);assertFinancial();
shrink(100,true);assert.equal(extra.portHintSettings().shrink,1);
let paint=draw(chart());
for(const p of sandbox.paintedHints.filter(p=>p.kind==='diversification')){
  near(p.x,Math.sqrt(p.w.reduce((s,w,i)=>s+w*w*expectedVols[i]**2,0)));
}
assertFinancial();
const validSettings=shim.localStorage.getItem('iaw-port-hints'), validChart=chart();
for(const bad of ['',-1,101,'Infinity','oops']){
  shrink(bad);assert.equal(chart(),validChart);
  assert.equal(byId('port-hints-shrink').getAttribute('aria-invalid'),'true');
  assert.equal(shim.localStorage.getItem('iaw-port-hints'),validSettings);
}
P.renderPortPanel(SIX_ASSET_FIXTURE);
assert.equal(byId('port-hints-shrink').value,'100');assertFinancial();
shrink(20);assert.equal(sandbox.hintCalculation,initialCalculation);
// A hidden overlapping point must also disappear from pointer hit tests.
paint=draw(chart());
const overlap=sandbox.paintedHints.find(p=>!p.hiddenForPlot&&p.kind==='gap');
assert(overlap);
const originalPosition={x:overlap.x,y:overlap.y};
const marker=sandbox.paintedMarkers.find(p=>p.asset);
overlap.x=marker.x;overlap.y=marker.y;
paint=draw(chart());assert(overlap.hiddenForPlot);
hover(overlap,paint);assert.notEqual(tip().querySelector('.port-tooltip-title')?.textContent,overlap.label);
Object.assign(overlap,originalPosition);draw(chart());
const setBounds=(values)=>{
  if(card().querySelector('.port-axis-controls').hidden)byId('port-axis-toggle').click();
  ['x-min','x-max','y-min','y-max'].forEach((key,i)=>{byId('port-'+key).value=String(values[i]);});
  click('축 적용');
};
const target=base.gaps.find(p=>p.x>0);
assert(target);
// Keep the center inside the viewport while deliberately clipping its 7px ring.
setBounds([target.x-.001,target.x+30,target.y-10,target.y+10]);
assert.equal(sandbox.hintCalculation,initialCalculation);assertFinancial();
paint=draw(chart());
const cropped=sandbox.paintedHints.find(p=>p.kind==='gap'&&Math.abs(p.x-target.x)<1e-9);
assert(cropped&&cropped.hiddenForPlot);
hover(cropped,paint);assert.notEqual(tip().querySelector('.port-tooltip-title')?.textContent,cropped.label);
setBounds([0,40,-20,45]);assert.equal(sandbox.hintCalculation,initialCalculation);assertFinancial();
click('자동');assert.equal(sandbox.hintCalculation,initialCalculation);
card().querySelector('.port-hints-control').dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});
assert(byId('port-hints-panel').hidden);
assert.equal(DOC.activeElement,byId('port-hints-toggle'));
assertFinancial();
assert.equal(shim.UPlotStub.made.filter(c=>!c.dead).length,1);
console.log(JSON.stringify({pass:true,gaps:base.gaps.length,diversification:base.diversification.length,
  independentMoments:true,unchangedFinancialInputs:true,hiddenHintsExcluded:true,persistence:true}));
`;
const filename=path.join(repo,'tests/port_opportunities_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+sixFixture+'\n'+canvas+'\n'+code,filename);
