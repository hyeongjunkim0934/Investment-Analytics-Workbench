/* Robust frontier interaction and canvas geometry regression using synthetic data. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.argv[2] || path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = src.slice(0, src.indexOf('/* ============ P1.'));
const fixture = src.slice(src.indexOf('const ALLOC_FIXTURE = (() => {'), src.indexOf('\nsafe("hedgeXe"'));
const code = String.raw`
const assert = require('node:assert/strict');
const inspect = vm.runInContext('({live:()=>uplots})', sandbox);
const panel = DOC.getElementById('alloc-port-panel');
const card=()=>panel.querySelector('.port-frontier');
const button=(text)=>Array.from(card().querySelectorAll('button')).find(n=>n.textContent===text);
const click=(text)=>{const n=button(text);assert(n,text+' missing');n.click();};
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const chart=()=>shim.UPlotStub.made.filter(n=>!n.dead&&n.opts.series.some(s=>s.label==='경계선')).pop();
const live=()=>shim.UPlotStub.made.filter(n=>!n.dead);
function draw(c){
  const commands=[],bbox={left:50,top:10,width:650,height:300};
  const ctx=new Proxy({createLinearGradient(...a){commands.push(['gradient',...a]);return {addColorStop(...b){commands.push(['stop',...b]);}};}},{get(o,k){return k in o?o[k]:(...a)=>commands.push([k,...a]);},set(o,k,v){o[k]=v;return true;}});
  const xr=c.opts.scales.x.range,yr=c.opts.scales.y.range();
  const u={ctx,bbox,valToPos(v,axis){return axis==='x'?bbox.left+(v-xr[0])/(xr[1]-xr[0])*bbox.width:bbox.top+(yr[1]-v)/(yr[1]-yr[0])*bbox.height;}};
  (c.opts.hooks.drawClear||[]).forEach(fn=>fn(u));(c.opts.hooks.draw||[]).forEach(fn=>fn(u));
  assert(commands.filter(x=>['lineTo','moveTo'].includes(x[0])).every(x=>x.slice(1).every(Number.isFinite)));
  return commands;
}
function assertContained(c){
  const xr=c.opts.scales.x.range,yr=c.opts.scales.y.range();
  assert(c.data[0].every(x=>x>=xr[0]&&x<=xr[1]));
  assert(c.data.slice(1).flat().every(y=>y>=yr[0]&&y<=yr[1]));
  assert(Math.min(...c.data.slice(1).flat())>yr[0]);
}
P.DATA.alloc=ALLOC_FIXTURE;shim.localStorage.removeItem(P.PORT_LS_KEY);P.renderPortPanel(ALLOC_FIXTURE);
const initial=chart(),allRange=initial.opts.scales.x.range.slice();
assert(!button('전체')&&!button('강건 구간'));
assert.equal(card().querySelectorAll('input').length,0);
assert(!/오차 강도|합계 100%|공매도 금지|Robust 기준|경계선에 마우스|점선 ·/.test(card().textContent));
assert(draw(initial).filter(x=>x[0]==='arc').length>5000);
assert(card().querySelector('.port-sharpe-scale').textContent.includes('6,007'));
assert(card().querySelector('.port-frontier-key').textContent.includes('샤프 최대'));
assert(draw(initial).filter(x=>x[0]==='arc').every(x=>x.slice(1).every(Number.isFinite)));
click('표');
assert(card().querySelector('.chart-table').textContent.includes('최악 기대수익%'));
vm.runInContext('downloadCSV = (...args) => { globalThis.robustCSV = args; }', sandbox);
click('CSV');
assert(sandbox.robustCSV[2].some(row=>row[0]==='Robust' && typeof row[2]==='number' && row[4]<=row[3]));
assert.equal(P.portState(ALLOC_FIXTURE.port).robust_k,1);assertContained(initial);
assert.equal(draw(initial).filter(x=>x[0]==='gradient').length,1);assert.equal(draw(initial).filter(x=>x[0]==='stop').length,3);
// Old saved slider values cannot silently choose a different scenario once the control is gone.
for(const k of [0,0.75,3]){
  const saved={...P.portState(ALLOC_FIXTURE.port),robust_k:k};
  shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(saved));
  P.renderPortPanel(ALLOC_FIXTURE);
  assert.equal(P.portState(ALLOC_FIXTURE.port).robust_k,1);
  assert.deepEqual(chart().data,initial.data);
  assert.deepEqual(chart().opts.scales.x.range,allRange);
  assert.deepEqual(P.portState(ALLOC_FIXTURE.port).mix,saved.mix);
}
for(const [i,s] of chart().opts.series.entries()){
  assert.equal(s.value(null,1.23456789),i===0?'1.23':'1.23%');
  assert.equal(s.value(null,0),i===0?'0.00':'0.00%');
  assert.equal(s.value(null,-1.236),i===0?'-1.24':'-1.24%');
  assert.equal(s.value(null,null),'–');
}
const hover=card().querySelector('.port-hover');chart().opts.hooks.setCursor[0]({cursor:{idx:2}});assert(/최악/.test(hover.textContent));
assert(hover.textContent.match(/-?\d+(?:\.\d+)?/g).every(v=>/^-?\d+\.\d{2}$/.test(v)));
card().querySelector('.chart-box').dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});assert(/배분/.test(hover.textContent));
chart().opts.hooks.setCursor[0]({cursor:{idx:null}});assert.equal(hover.textContent,'');
const bench=panel.querySelector('.port-benchmark');
assert.equal(bench.querySelectorAll('th').length,7);
assert.equal(bench.querySelectorAll('tbody tr').length,4);
assert(!/실현 성과\(/.test(panel.textContent));
assert.equal(live().length,1);assert.equal(inspect.live().length,1);assert(live().every(c=>DOC.contains(c.root)));
console.log(JSON.stringify({pass:true,allRange,liveCharts:live().length,hoverDecimals:2}));
`;
const filename = path.join(repo, 'tests/robust_frontier_ui_regression.js');
const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap + '\n' + fixture + '\n' + code, filename);
