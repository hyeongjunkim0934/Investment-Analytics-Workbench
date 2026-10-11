/* Baseline and optional frontier display against the real render path. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const robust = fs.readFileSync(path.join(repo, 'tests/robust_frontier_ui_probe.js'), 'utf8');
const sixFixture = robust.slice(robust.indexOf('const SIX_ASSET_FIXTURE = (() => {'), robust.indexOf('\n`;\nconst reloadCode'));
const code = String.raw`
const assert=require('node:assert/strict'),plain=x=>JSON.parse(JSON.stringify(x));
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
vm.runInContext('const originalRatioChart=makeRatioChart; makeRatioChart=(box,opts)=>{globalThis.lastRatioConfig=opts;return originalRatioChart(box,opts);}; downloadCSV=(...args)=>{globalThis.frontierCSV=args;};',sandbox);
P.DATA.alloc=SIX_ASSET_FIXTURE;P.renderPortPanel(SIX_ASSET_FIXTURE);
const panel=DOC.getElementById('alloc-port-panel'),byId=id=>DOC.getElementById(id);
const card=()=>panel.querySelector('.port-frontier');
const chart=()=>shim.UPlotStub.made.filter(c=>!c.dead&&c.opts.series.some(s=>s.label==='Baseline')).at(-1);
const cfg=()=>sandbox.lastRatioConfig;
const selected=()=>Array.from(chart().opts.series,s=>s.label).slice(1);
const checkbox=key=>byId('port-scenario-'+key);
const change=(key,enabled)=>{const input=checkbox(key);input.checked=enabled;input.dispatchEvent({type:'change'});};
const exportRows=()=>{Array.from(panel.querySelector('.port-result-tools').querySelectorAll('button')).find(b=>b.textContent==='CSV').click();return sandbox.frontierCSV[2];};
const baseline=P.portEngine(SIX_ASSET_FIXTURE.port,P.portState(SIX_ASSET_FIXTURE.port));
const initial=JSON.stringify(chart().data),initialBounds=[...cfg().xRange,...cfg().yRange];
const saved=shim.localStorage.getItem(P.PORT_LS_KEY),beforeEngine=JSON.stringify(baseline);
assert.deepEqual(selected(),['Baseline']);
assert.equal(checkbox('conservative').checked,false);assert.equal(checkbox('optimistic').checked,false);
assert(byId('port-scenarios-panel').hidden);
assert.equal(byId('port-scenarios-toggle').getAttribute('aria-expanded'),'false');
assert.equal(cfg().area,null);assert.equal(cfg().reference,undefined);
const assertVisible=(conservative,optimistic)=>{
  assert.deepEqual(selected(),['Baseline',...(conservative?['Conservative']:[]),...(optimistic?['Optimistic']:[])]);
  const key=card().querySelector('.port-frontier-key').textContent;
  assert(key.includes('Baseline'));assert.equal(key.includes('Conservative'),conservative);assert.equal(key.includes('Optimistic'),optimistic);
  const hover=cfg().portfolioHover.points;
  assert.equal(hover.some(p=>p.label==='Conservative'),conservative);
  assert.equal(hover.some(p=>p.label==='Optimistic'),optimistic);
  const rows=exportRows();assert(rows.some(row=>row[0]==='Baseline'));
  assert.equal(rows.some(row=>row[0]==='Conservative'),conservative);
  assert.equal(rows.some(row=>row[0]==='Optimistic'),optimistic);
  assert.equal(!!cfg().area,conservative);
  // Every nominal solution remains the unadjusted E.front point, even when
  // other frontiers add x samples to the uPlot grid.
  const base=cfg().seriesDefs[0];
  for(const p of baseline.front){
    const i=base.x.findIndex(x=>Math.abs(x-p.sig)<1e-7);
    assert(i>=0&&Math.abs(base.v[i]-p.mu)<1e-7);
  }
  assert.equal(hover.filter(p=>p.label==='Baseline').length,baseline.front.length);
  assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),saved);
  assert.equal(JSON.stringify(P.portEngine(SIX_ASSET_FIXTURE.port,P.portState(SIX_ASSET_FIXTURE.port))),beforeEngine);
};
assertVisible(false,false);
byId('port-scenarios-toggle').click();
assert(!byId('port-scenarios-panel').hidden);assert.equal(byId('port-scenarios-toggle').getAttribute('aria-expanded'),'true');
change('optimistic',true);assertVisible(false,true);
assert(!byId('port-scenarios-panel').hidden);assert.equal(DOC.activeElement,checkbox('optimistic'));
assert(cfg().yRange[1]>initialBounds[3]);
const optimisticOnlyBounds=[...cfg().xRange,...cfg().yRange];
change('conservative',true);assertVisible(true,true);
change('optimistic',false);assertVisible(true,false);
assert(cfg().yRange[1]<optimisticOnlyBounds[3]);
change('conservative',false);assertVisible(false,false);
assert.equal(JSON.stringify(chart().data),initial);assert.deepEqual([...cfg().xRange,...cfg().yRange],initialBounds);
panel.querySelector('.port-scenarios').dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});
assert(byId('port-scenarios-panel').hidden);assert.equal(byId('port-scenarios-toggle').getAttribute('aria-expanded'),'false');
assert.equal(DOC.activeElement,byId('port-scenarios-toggle'));
change('optimistic',true);P.renderPortPanel(SIX_ASSET_FIXTURE,{preserveDraft:true});assertVisible(false,true);
// Display changes must leave unsubmitted financial edits in the draft.
const muInput=Array.from(panel.querySelectorAll('input')).find(n=>n.getAttribute('aria-label')==='국내채권 기대수익');
muInput.value='12.75';muInput.dispatchEvent({type:'input'});
change('optimistic',false);assertVisible(false,false);
assert.equal(muInput.value,'12.75');
assert.equal(byId('port-update-btn').getAttribute('data-pending'),'true');
// Explicit axes override auto fitting during both optional scenario changes.
byId('port-axis-toggle').click();
for(const [id,value] of [['x-min',0],['x-max',40],['y-min',-10],['y-max',30]]){
  const input=byId('port-'+id);input.value=String(value);
}
byId('port-axis-apply').click();
change('conservative',true);change('optimistic',true);
assert.deepEqual([...cfg().xRange,...cfg().yRange],[0,40,-10,30]);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),saved);
assert.equal(shim.UPlotStub.made.filter(c=>!c.dead).length,1);
console.log(JSON.stringify({pass:true,baselineUsesNominalFrontier:true,defaultsUnchecked:true,independentToggles:true,
  seriesLegendHoverExportAgree:true,hiddenScenariosDoNotExpandAxes:true,displayOnly:true,draftsPreserved:true,keyboardAndFocus:true,manualAxesPreserved:true}));
`;
const filename=path.join(repo,'tests/frontier_visibility_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+sixFixture+'\n'+code,filename);
