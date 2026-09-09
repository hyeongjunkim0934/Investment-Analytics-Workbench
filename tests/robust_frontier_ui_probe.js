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
const fire=(n,type)=>n.dispatchEvent({type,target:n,preventDefault(){}});
const card=()=>panel.querySelector('.port-frontier');
const button=(text)=>Array.from(card().querySelectorAll('button')).find(n=>n.textContent===text);
const click=(text)=>{const n=button(text);assert(n,text+' missing');n.click();if(['전체','강건 구간'].includes(text))assert.equal(DOC.activeElement,card().querySelector('.seg .active'));};
const input=()=>DOC.getElementById('port-robust-k');
const change=(value)=>{const n=input();n.value=String(value);fire(n,'input');fire(n,'change');assert.equal(DOC.activeElement,input());};
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const chart=()=>shim.UPlotStub.made.filter(n=>!n.dead&&n.opts.series.some(s=>s.label==='경계선')).pop();
const live=()=>shim.UPlotStub.made.filter(n=>!n.dead);
const width=(c)=>650*(Math.max(...c.data[0])-Math.min(...c.data[0]))/(c.opts.scales.x.range[1]-c.opts.scales.x.range[0]);
function draw(c){
  const commands=[],bbox={left:50,top:10,width:650,height:300};
  const ctx=new Proxy({createLinearGradient(...a){commands.push(['gradient',...a]);return {addColorStop(...b){commands.push(['stop',...b]);}};}},{get(o,k){return k in o?o[k]:(...a)=>commands.push([k,...a]);},set(o,k,v){o[k]=v;return true;}});
  const xr=c.opts.scales.x.range,yr=c.opts.scales.y.range();
  const u={ctx,bbox,valToPos(v,axis){return axis==='x'?bbox.left+(v-xr[0])/(xr[1]-xr[0])*bbox.width:bbox.top+(yr[1]-v)/(yr[1]-yr[0])*bbox.height;}};
  (c.opts.hooks.drawClear||[]).forEach(fn=>fn(u));(c.opts.hooks.draw||[]).forEach(fn=>fn(u));
  assert(commands.filter(x=>['lineTo','moveTo'].includes(x[0])).every(x=>x.slice(1).every(Number.isFinite)));
  return commands;
}
function visibleLabels(c){return draw(c).filter(x=>x[0]==='fillText').map(x=>x[1]);}
function assertContained(c){
  const xr=c.opts.scales.x.range,yr=c.opts.scales.y.range();
  assert(c.data[0].every(x=>x>=xr[0]&&x<=xr[1]));
  assert(c.data.slice(1).flat().every(y=>y>=yr[0]&&y<=yr[1]));
  assert(Math.min(...c.data.slice(1).flat())>yr[0]);
}
P.DATA.alloc=ALLOC_FIXTURE;shim.localStorage.removeItem(P.PORT_LS_KEY);P.renderPortPanel(ALLOC_FIXTURE);
const initial=chart(),allRange=initial.opts.scales.x.range.slice();
assert.equal(button('전체').getAttribute('aria-pressed'),'true');
assert(draw(initial).filter(x=>x[0]==='arc').length>5000);
assert(card().querySelector('.port-sharpe-scale').textContent.includes('6,007'));
assert(card().querySelector('.port-frontier-key').textContent.includes('샤프 최대'));
assert(draw(initial).filter(x=>x[0]==='arc').every(x=>x.slice(1).every(Number.isFinite)));
click('표');
assert(card().querySelector('.chart-table').textContent.includes('최악 기대수익%'));
vm.runInContext('downloadCSV = (...args) => { globalThis.robustCSV = args; }', sandbox);
click('CSV');
assert(sandbox.robustCSV[2].some(row=>row[0]==='Robust' && typeof row[2]==='number' && row[4]<=row[3]));
assert.equal(+input().value,1);assertContained(initial);
assert.equal(draw(initial).filter(x=>x[0]==='gradient').length,1);assert.equal(draw(initial).filter(x=>x[0]==='stop').length,3);
click('강건 구간');const zoom=chart(),zoomRange=zoom.opts.scales.x.range.slice();
assert.equal(button('강건 구간').getAttribute('aria-pressed'),'true');
assert(width(zoom)>200);assertContained(zoom);
const zoomWidth=width(zoom);
click('전체');const all=chart();
assert.equal(button('전체').getAttribute('aria-pressed'),'true');assert(allRange[1]>zoomRange[1]);
assert.deepEqual(chart().opts.scales.x.range,allRange);
change(2);assert.equal(JSON.parse(shim.localStorage.getItem(P.PORT_LS_KEY)).robust_k,2);assert.equal(button('전체').getAttribute('aria-pressed'),'true');
change(1);click('강건 구간');assert.deepEqual(chart().opts.scales.x.range,zoomRange);
change(3);const zoom3=chart();assert(width(zoom3)>200);assertContained(zoom3);assert.equal(button('강건 구간').getAttribute('aria-pressed'),'true');
const zoom3Width=width(zoom3);click('전체');assert(width(chart())<1);click('강건 구간');assert.equal(width(chart()),zoom3Width);
const hover=card().querySelector('.port-hover');chart().opts.hooks.setCursor[0]({cursor:{idx:2}});assert(/최악/.test(hover.textContent));
card().querySelector('.chart-box').dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});assert(/배분/.test(hover.textContent));
change(0);assert(chart().data[1].every((x,i)=>x===chart().data[2][i]));assert.equal(draw(chart()).filter(x=>x[0]==='gradient').length,0);assert(draw(chart()).filter(x=>x[0]==='arc').length>5000);
assert.equal(button('전체').getAttribute('aria-pressed'),'true');
const zeroKLegend=card().textContent;assert(zeroKLegend.includes('일반 평균–분산 경계선'));
change(1);for(let i=0;i<5;i++){click('전체');click('강건 구간');change((i%3)+1);}
assert.equal(live().length,1);assert.equal(inspect.live().length,1);assert(live().every(c=>DOC.contains(c.root)));
console.log(JSON.stringify({pass:true,zoomWidthK1:zoomWidth,zoomWidthK3:zoom3Width,allRange,zoomRange,liveCharts:live().length,zeroKLegend}));
`;
const filename = path.join(repo, 'tests/robust_frontier_ui_regression.js');
const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap + '\n' + fixture + '\n' + code, filename);
