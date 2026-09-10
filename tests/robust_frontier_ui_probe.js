/* Robust frontier interaction and canvas geometry regression using synthetic data. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.argv[2] || path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = src.slice(0, src.indexOf('/* ============ P1.')).replace('vm.createContext(sandbox);',
  'if (process.env.IAW_TEST_AXIS_STATE) shim.localStorage.setItem("iaw-port-axis", process.env.IAW_TEST_AXIS_STATE);\nif (process.env.IAW_TEST_SIGMA_STATE) shim.localStorage.setItem("iaw-port-range-sigma", process.env.IAW_TEST_SIGMA_STATE);\nvm.createContext(sandbox);');
const fixture = src.slice(src.indexOf('const ALLOC_FIXTURE = (() => {'), src.indexOf('\nsafe("hedgeXe"'));
// Preserve the old shared fixture for historical regression coverage elsewhere. Here
// remove the dollar asset and reorder every vector/matrix by the same explicit map.
const sixFixture = String.raw`
const SIX_ASSET_FIXTURE = (() => {
  const old = ALLOC_FIXTURE.port, indexes = [0, 6, 1, 2, 3, 4];
  const rename = (a) => a === '원화유동성' ? '국내장부' : a;
  const assetMap = (m) => Object.fromEntries(Object.entries(m || {})
    .filter(([a]) => a !== '달러유동성').map(([a,v]) => [rename(a),v]));
  const port = {
    ...old, assets: indexes.map(i => rename(old.assets[i])), proxies: assetMap(old.proxies),
    defaults: {...old.defaults, groups: {주식:['국내주식','해외주식'], 채권:['국내채권','해외채권'],
      대체:['대체투자'], 유동성:['국내장부']}},
    coverage: indexes.map(i => ({...old.coverage[i], asset: rename(old.coverage[i].asset)})),
    ref10y: {...old.ref10y, per_asset: assetMap(old.ref10y.per_asset)},
    cma_input: {...old.cma_input, mu_pct: assetMap(old.cma_input.mu_pct)},
    windows: old.windows.map(w => ({...w,
      mean_pct: indexes.map(i => w.mean_pct[i]), vol_pct: indexes.map(i => w.vol_pct[i]),
      mdd_pct: indexes.map(i => w.mdd_pct[i]),
      cov: indexes.map(i => indexes.map(j => w.cov[i][j])),
      corr: indexes.map(i => indexes.map(j => w.corr[i][j])),
    })),
  };
  return {...ALLOC_FIXTURE, port};
})();
`;
const reloadCode = String.raw`
const assert = require('node:assert/strict');
P.DATA.alloc = SIX_ASSET_FIXTURE;
P.renderPortPanel(SIX_ASSET_FIXTURE);
const c = shim.UPlotStub.made.filter(n => n.opts.series.some(s => s.label === '경계선')).pop();
const expected = JSON.parse(process.env.IAW_TEST_AXIS_EXPECTED);
assert.deepEqual(Array.from(c.opts.scales.x.range), expected.x);
assert.deepEqual(Array.from(c.opts.scales.y.range()), expected.y);
assert(DOC.getElementById('alloc-port-panel').querySelector('.port-axis-controls').hidden);
assert.equal(DOC.getElementById('port-axis-toggle').getAttribute('aria-expanded'), 'false');
console.log(JSON.stringify({reloadPass:true}));
`;
const sigmaReloadCode = String.raw`
const assert = require('node:assert/strict');
P.DATA.alloc = SIX_ASSET_FIXTURE;P.renderPortPanel(SIX_ASSET_FIXTURE);
assert.equal(Number(DOC.getElementById('port-range-sigma').value),Number(process.env.IAW_TEST_SIGMA_EXPECTED));
console.log(JSON.stringify({reloadPass:true}));
`;
const code = process.argv.includes('--axis-reload') ? reloadCode : process.argv.includes('--sigma-reload') ? sigmaReloadCode : String.raw`
const assert = require('node:assert/strict');
const inspect = vm.runInContext('({live:()=>uplots})', sandbox);
const panel = DOC.getElementById('alloc-port-panel');
const card=()=>panel.querySelector('.port-frontier');
const button=(text)=>Array.from(card().querySelectorAll('button')).find(n=>n.textContent===text);
const click=(text)=>{const n=button(text);assert(n,text+' missing');n.click();};
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const chart=()=>shim.UPlotStub.made.filter(n=>!n.dead&&n.opts.series.some(s=>s.label==='경계선')).pop();
const live=()=>shim.UPlotStub.made.filter(n=>!n.dead);
function draw(c,dpr=1){
  const commands=[],bbox={left:50*dpr,top:10*dpr,width:650*dpr,height:300*dpr};
  const textBounds=[],strokes=[],symbols=[],stack=[];
  let path=[],stage='drawClear';
  // Model Canvas state instead of merely recording save/restore. Real uPlot leaves
  // its left y-axis alignment (right/middle) behind before custom draw hooks run.
  const state={textAlign:'right',textBaseline:'middle',font:'12px sans-serif',
    fillStyle:'#000000',strokeStyle:'#000000',lineWidth:1,globalAlpha:1,clipBox:null};
  const metrics=(text)=>{
    const size=parseFloat(ctx.font),width=Array.from(text).reduce((n,ch)=>n+(ch.charCodeAt(0)>255?1:.58)*size,0);
    return {width,actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.2};
  };
  const recordShape=(kind)=>{
    commands.push([kind]);
    if(kind==='stroke')strokes.push({path:path.map(p=>p.slice()),stage,color:ctx.strokeStyle,
      width:ctx.lineWidth,alpha:ctx.globalAlpha,clip:ctx.clipBox&&{...ctx.clipBox}});
    if(stage!=='draw')return;
    const points=path.flatMap(p=>p[0]==='arc'?[[p[1]-p[3],p[2]-p[3]],[p[1]+p[3],p[2]+p[3]]]
      :['moveTo','lineTo'].includes(p[0])?[[p[1],p[2]]]:[]);
    if(points.length){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
      symbols.push({x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)});}
  };
  const target={...state,
    save(){stack.push(Object.fromEntries(Object.keys(state).map(k=>[k,this[k]])));commands.push(['save']);},
    restore(){Object.assign(this,stack.pop());commands.push(['restore']);},
    beginPath(){path=[];commands.push(['beginPath']);},
    measureText:metrics,
    stroke(){recordShape('stroke');},fill(){recordShape('fill');},
    fillText(text,x,y){
      const m=metrics(text),size=parseFloat(this.font);
      const left=x-(['right','end'].includes(this.textAlign)?m.width:this.textAlign==='center'?m.width/2:0);
      const top=y-(this.textBaseline==='middle'?size/2:this.textBaseline==='top'?0:this.textBaseline==='bottom'?size:m.actualBoundingBoxAscent);
      textBounds.push({text,x:left,y:top,w:m.width,h:size,align:this.textAlign,baseline:this.textBaseline});
      commands.push(['fillText',text,x,y]);
    },
    createLinearGradient(...a){commands.push(['gradient',...a]);return {addColorStop(...b){commands.push(['stop',...b]);}};},
  };
  target.clip=function(){const r=path.find(p=>p[0]==='rect');this.clipBox=r?{left:r[1],top:r[2],width:r[3],height:r[4]}:this.clipBox;commands.push(['clip']);};
  const ctx=new Proxy(target,{get(o,k){return k in o?o[k]:(...a)=>{
    commands.push([k,...a]);if(['moveTo','lineTo','rect','arc','closePath'].includes(k))path.push([k,...a]);
  };},set(o,k,v){o[k]=v;return true;}});
  const xr=c.opts.scales.x.range,yr=c.opts.scales.y.range();
  const u={ctx,bbox,valToPos(v,axis,canvas=false){
    const ratio=axis==='x'?(v-xr[0])/(xr[1]-xr[0]):(yr[1]-v)/(yr[1]-yr[0]);
    const length=axis==='x'?bbox.width:bbox.height,offset=axis==='x'?bbox.left:bbox.top;
    return canvas?offset+ratio*length:ratio*length/dpr;
  }};
  const oldDpr=sandbox.devicePixelRatio;sandbox.devicePixelRatio=dpr;
  try{(c.opts.hooks.drawClear||[]).forEach(fn=>fn(u));stage='draw';(c.opts.hooks.draw||[]).forEach(fn=>fn(u));}
  finally{sandbox.devicePixelRatio=oldDpr;}
  assert(commands.filter(x=>['lineTo','moveTo'].includes(x[0])).every(x=>x.slice(1).every(Number.isFinite)));
  Object.assign(commands,{textBounds,strokes,symbols,bbox,u,dpr,
    value:(p)=>[xr[0]+(p[0]-bbox.left)/bbox.width*(xr[1]-xr[0]),yr[1]-(p[1]-bbox.top)/bbox.height*(yr[1]-yr[0])]});
  return commands;
}
function moveCursor(c,paint,left,top){
  const oldDpr=sandbox.devicePixelRatio;sandbox.devicePixelRatio=paint.dpr;
  try{paint.u.cursor={left,top};(c.opts.hooks.setCursor||[]).forEach(fn=>fn(paint.u));}
  finally{sandbox.devicePixelRatio=oldDpr;}
}
function assertContained(c){
  const xr=c.opts.scales.x.range,yr=c.opts.scales.y.range();
  assert(c.data[0].every(x=>x>=xr[0]&&x<=xr[1]));
  const ys=c.data.slice(1).flat().filter(Number.isFinite);
  assert(ys.every(y=>y>=yr[0]&&y<=yr[1]));
  assert(Math.min(...ys)>yr[0]);
}
P.DATA.alloc=SIX_ASSET_FIXTURE;shim.localStorage.removeItem(P.PORT_LS_KEY);P.renderPortPanel(SIX_ASSET_FIXTURE);
const initial=chart(),allRange=initial.opts.scales.x.range.slice();
assert.equal(DOC.getElementById('port-range-sigma').value,'0.5');
assert.equal(DOC.getElementById('port-range-sigma').getAttribute('step'),'0.25');
assert.equal(DOC.getElementById('port-range-sigma').getAttribute('min'),'0');
assert.equal(DOC.getElementById('port-range-sigma').getAttribute('max'),'10');
const expectedAssets=['국내채권','국내장부','해외채권','국내주식','해외주식','대체투자'];
assert.deepEqual(SIX_ASSET_FIXTURE.port.assets,expectedAssets);
assert.deepEqual(Array.from(panel.querySelectorAll('.port-table tbody tr'),row=>row.querySelector('td').textContent),expectedAssets);
assert(!/달러유동성|원화유동성/.test(panel.textContent));
assert(!button('전체')&&!button('강건 구간'));
assert.equal(card().querySelector('.port-axis-controls').querySelectorAll('input').length,4);
assert(card().querySelector('.port-axis-controls').hidden);
assert.equal(DOC.getElementById('port-axis-toggle').getAttribute('aria-expanded'),'false');
DOC.getElementById('port-axis-toggle').click();
assert(!card().querySelector('.port-axis-controls').hidden);
assert.equal(DOC.getElementById('port-axis-toggle').getAttribute('aria-expanded'),'true');
DOC.getElementById('port-axis-toggle').click();
assert(card().querySelector('.port-axis-controls').hidden);
assert(!/오차 강도|합계 100%|공매도 금지|Robust 기준|경계선에 마우스|점선 ·/.test(card().textContent));
assert(draw(initial).filter(x=>x[0]==='arc').length>5000);
assert(card().querySelector('.port-sharpe-scale').textContent.includes('6,006'));
assert(card().querySelector('.port-frontier-key').textContent.includes('샤프 최대'));
assert(draw(initial).filter(x=>x[0]==='arc').every(x=>x.slice(1).every(Number.isFinite)));
click('표');
assert(card().querySelector('.chart-table').textContent.includes('Conservative 기대수익%'));
assert(card().querySelector('.chart-table').textContent.includes('Optimistic 기대수익%'));
vm.runInContext('downloadCSV = (...args) => { globalThis.robustCSV = args; }', sandbox);
click('CSV');
assert(sandbox.robustCSV[2].some(row=>row[0]==='Conservative' && typeof row[2]==='number' && row[4]<=row[3]));
assert(sandbox.robustCSV[2].some(row=>row[0]==='Optimistic' && typeof row[2]==='number' && row[5]>=row[3]));
assert(!sandbox.robustCSV[2].some(row=>row[0]==='Robust'));
assert.deepEqual(Array.from(initial.opts.series,s=>s.label).slice(1),['경계선','Conservative','Optimistic']);
assert.equal(initial.opts.series[3].spanGaps,false);
const E0=P.portEngine(SIX_ASSET_FIXTURE.port,P.portState(SIX_ASSET_FIXTURE.port));
for(const p of E0.optimistic){
  const index=initial.data[0].findIndex(x=>Math.abs(x-p.sig)<1e-7);
  assert(index>=0 && Math.abs(initial.data[3][index]-p.best)<1e-7);
}
for(const row of sandbox.robustCSV[2].filter(r=>r[0]==='Conservative'||r[0]==='Optimistic')){
  assert(Math.abs((row[5]-row[3])-(row[3]-row[4]))<1e-9);
  assert(Math.abs(row.slice(6).reduce((a,b)=>a+b,0)-100)<1e-7);
}
assert.equal(P.portState(SIX_ASSET_FIXTURE.port).robust_k,1);assertContained(initial);
assert.equal(draw(initial).filter(x=>x[0]==='gradient').length,1);assert.equal(draw(initial).filter(x=>x[0]==='stop').length,3);
// Old saved slider values cannot silently choose a different scenario once the control is gone.
for(const k of [0,0.75,3]){
  const saved={...P.portState(SIX_ASSET_FIXTURE.port),robust_k:k};
  shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(saved));
  P.renderPortPanel(SIX_ASSET_FIXTURE);
  assert.equal(P.portState(SIX_ASSET_FIXTURE.port).robust_k,1);
  assert.deepEqual(chart().data,initial.data);
  assert.deepEqual(chart().opts.scales.x.range,allRange);
  assert.deepEqual(P.portState(SIX_ASSET_FIXTURE.port).mix,saved.mix);
}
for(const [i,s] of chart().opts.series.entries()){
  assert.equal(s.value(null,1.23456789),i===0?'1.23':'1.23%');
  assert.equal(s.value(null,0),i===0?'0.00':'0.00%');
  assert.equal(s.value(null,-1.236),i===0?'-1.24':'-1.24%');
  assert.equal(s.value(null,null),'–');
}
const hover=card().querySelector('.port-hover.port-portfolio-tooltip');assert(hover&&hover.hidden);
assert.equal(chart().opts.cursor.x,false);assert.equal(chart().opts.cursor.y,false);
assert.equal(chart().opts.cursor.points.show,false);assert.equal(chart().opts.legend.show,false);
const hoverWeights=(tip)=>Array.from(tip.querySelectorAll('.port-tooltip-weight'),row=>parseFloat(row.querySelector('b').textContent));
// A separate finite-difference oracle verifies Euler volatility contributions,
// including their sign. It does not call the implementation's new helper.
const contributionOracle=(w,mu,C)=>{
  const mean=(v)=>v.reduce((sum,x,i)=>sum+x*mu[i],0);
  const volatility=(v)=>Math.sqrt(Math.max(0,v.reduce((sum,wi,i)=>sum+
    v.reduce((part,wj,j)=>part+wi*wj*C[i][j],0),0)));
  const m=mean(w),s=volatility(w),eps=1e-6;
  const marginal=(fn,i)=>{const up=Array.from(w),down=Array.from(w);up[i]+=eps;down[i]-=eps;
    return (fn(up)-fn(down))/(2*eps);};
  return {mu:m,sig:s,
    returnPct:m===0?null:Array.from(w,(wi,i)=>100*wi*marginal(mean,i)/m),
    riskPct:s===0?null:Array.from(w,(wi,i)=>100*wi*marginal(volatility,i)/s)};
};
const checkContributions=(tip,w,mu,C)=>{
  const expected=contributionOracle(w,mu,C),rows=Array.from(tip.querySelectorAll('.port-tooltip-weight'));
  assert.equal(rows.length,w.length);
  for(const [field,key] of [['return','returnPct'],['risk','riskPct']]){
    const actual=rows.map(row=>{const cell=row.querySelector('.port-tooltip-'+field);
      assert(cell,field+' contribution missing');
      if(expected[key]===null){assert.equal(cell.textContent,'—');return null;}
      assert(/^-?\d+\.\d{2}%$/.test(cell.textContent),cell.textContent);
      return parseFloat(cell.textContent);});
    if(expected[key]!==null){
      actual.forEach((v,i)=>assert(Math.abs(v-expected[key][i])<=.00501,
        field+' contribution '+v+' differs from '+expected[key][i]));
      assert(Math.abs(actual.reduce((a,b)=>a+b,0)-100)<=rows.length*.00501);
    }
  }
};
const checkPortfolio=(tip,p,y=p.mu,E=E0)=>{
  assert(!tip.hidden);assert(/배분/.test(tip.textContent));
  assert.deepEqual(hoverWeights(tip),Array.from(p.w,v=>+Number(v*100).toFixed(2)));
  assert(tip.querySelector('.port-tooltip-metrics').textContent.includes('기대수익 '+Number(y).toFixed(2)+'%'));
  assert(tip.querySelector('.port-tooltip-metrics').textContent.includes('변동성 '+Number(p.sig).toFixed(2)+'%'));
  checkContributions(tip,p.w,E.mu,E.risk.C);
};
const checkAsset=(tip,label,mu,sig,k)=>{
  assert(!tip.hidden&&tip.classList.contains('port-asset-tooltip'));
  assert.equal(tip.querySelector('.port-tooltip-title').textContent,label);
  assert(tip.querySelector('.port-tooltip-metrics').textContent.includes('기대수익 '+mu.toFixed(2)+'%'));
  assert(tip.querySelector('.port-tooltip-metrics').textContent.includes('변동성 '+sig.toFixed(2)+'%'));
  assert(tip.querySelector('.port-tooltip-range').textContent.includes('범위 ±'+k.toFixed(2)+'σ'));
  const increment=tip.querySelector('.port-tooltip-range').textContent.match(/가산폭 ±(\d+\.\d{2})%p/);
  assert(increment&&Math.abs(Number(increment[1])-k*sig)<=.00501);
  const bounds=Object.fromEntries(Array.from(tip.querySelectorAll('.port-tooltip-bound'),row=>
    [row.querySelector('span').textContent,row.querySelector('b').textContent]));
  for(const [key,value] of [['하단',mu-k*sig],['상단',mu+k*sig]]){
    assert(/^-?\d+\.\d{2}%$/.test(bounds[key]));
    assert(Math.abs(parseFloat(bounds[key])-value)<=.00501);
  }
  assert.equal(tip.querySelectorAll('.port-tooltip-weight').length,0);
};
for(const dpr of [1,2]){
  const paint=draw(chart(),dpr),p=E0.minVar;
  moveCursor(chart(),paint,paint.u.valToPos(p.sig,'x'),paint.u.valToPos(p.mu,'y'));
  checkPortfolio(hover,p);
  assert(hover.textContent.match(/-?\d+(?:\.\d+)?/g).every(v=>/^-?\d+\.\d{2}$/.test(v)));
  moveCursor(chart(),paint,-1,-1);assert(hover.hidden);assert.equal(hover.textContent,'');
}
card().querySelector('.chart-box').dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});assert(!hover.hidden&&/배분/.test(hover.textContent));
card().querySelector('.chart-box').dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});assert(hover.hidden);
card().querySelector('.chart-box').dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});
card().querySelector('.chart-box').dispatchEvent({type:'mouseleave'});assert(hover.hidden);
// A feasible portfolio's tooltip must retain its original sampled weights. Choose
// an interior point away from symbols/curves; recompute moments independently.
const cloudPaint=draw(chart()),screen=(p,y=p.mu)=>[cloudPaint.u.valToPos(p.sig,'x'),cloudPaint.u.valToPos(y,'y')];
const currentW=SIX_ASSET_FIXTURE.port.assets.map(a=>(P.portState(SIX_ASSET_FIXTURE.port).mix[a]||0)/100);
const symbols=[E0.minVar,E0.maxSharpe,E0.bench,{w:currentW,mu:E0.muOf(currentW),sig:E0.sig(currentW)},
  ...E0.mu.map((mu,i)=>({mu,sig:E0.risk.sig[i]}))].filter(Boolean);
for(const [label,curve,field] of [['Conservative',E0.robust,'worst'],['Optimistic',E0.optimistic,'best']]){
  // This fixture's Conservative branch occupies under 2 screen pixels on its
  // default full-asset axis. Magnify the projection to identify its actual points.
  const p=curve[Math.floor(curve.length/2)],c=chart(),oldX=c.opts.scales.x.range,oldY=c.opts.scales.y.range;
  try{
    const dx=Math.max(.01,p.sig*.1),dy=Math.max(.01,Math.abs(p[field])*.01);
    c.opts.scales.x.range=[p.sig-dx,p.sig+dx];c.opts.scales.y.range=()=>[p[field]-dy,p[field]+dy];
    const paint=draw(c);
    moveCursor(c,paint,paint.u.valToPos(p.sig,'x'),paint.u.valToPos(p[field],'y'));
    checkPortfolio(hover,p,p[field]);assert(hover.querySelector('.port-tooltip-title').textContent.startsWith(label));
    assert(hover.textContent.includes('입력 기대수익 '+p.mu.toFixed(2)+'% · 기여율 기준'));
  }finally{c.opts.scales.x.range=oldX;c.opts.scales.y.range=oldY;}
}
const currentPoint={w:currentW,mu:E0.muOf(currentW),sig:E0.sig(currentW)};
for(const dpr of [1,2]){
  const paint=draw(chart(),dpr),x=paint.u.valToPos(currentPoint.sig,'x',true),y=paint.u.valToPos(currentPoint.mu,'y',true);
  assert(paint.some(cmd=>cmd[0]==='arc'&&Math.abs(cmd[1]-x)<1e-8&&Math.abs(cmd[2]-y)<1e-8&&cmd[3]===4.5*dpr),
    'current portfolio ring radius must be 4.5 CSS pixels');
  moveCursor(chart(),paint,paint.u.valToPos(currentPoint.sig,'x'),paint.u.valToPos(currentPoint.mu,'y'));
  checkPortfolio(hover,currentPoint);assert(hover.querySelector('.port-tooltip-title').textContent.startsWith('현재'));
}
// Restore the DPR 1 projection before querying the point cloud below.
draw(chart());
const curveScreens=[...E0.front.map(p=>screen(p)),...E0.robust.map(p=>screen(p,p.worst)),...E0.optimistic.map(p=>screen(p,p.best))];
const cloudPoint=E0.cloud.points.find(p=>{
  const xy=screen(p),dist=(other)=>(xy[0]-other[0])**2+(xy[1]-other[1])**2;
  return symbols.every(q=>dist(screen(q))>16**2)&&curveScreens.every(q=>dist(q)>16**2);
});
assert(cloudPoint,'no isolated feasible point in synthetic fixture');
assert(Math.abs(cloudPoint.w.reduce((a,b)=>a+b,0)-1)<1e-12);
const muCheck=cloudPoint.w.reduce((a,w,i)=>a+w*E0.mu[i],0);
const varianceCheck=cloudPoint.w.reduce((a,wi,i)=>a+cloudPoint.w.reduce((b,wj,j)=>b+wi*wj*E0.risk.C[i][j],0),0);
assert(Math.abs(cloudPoint.mu-muCheck)<1e-10&&Math.abs(cloudPoint.sig**2-varianceCheck)<1e-10);
moveCursor(chart(),cloudPaint,...screen(cloudPoint));checkPortfolio(hover,cloudPoint);
// Empty chart space must not select a portfolio merely sharing the same x index.
moveCursor(chart(),cloudPaint,0,0);assert(hover.hidden);
const bench=panel.querySelector('.port-benchmark');
assert.equal(bench.querySelectorAll('th').length,7);
assert.equal(bench.querySelectorAll('tbody tr').length,4);
assert(!/실현 성과\(/.test(panel.textContent));

// View bounds affect only the drawing, including zero/negative bounds and cropped markers.
const originalData=JSON.stringify(chart().data),originalStore=shim.localStorage.getItem(P.PORT_LS_KEY);
const reloadWith=(saved,expected)=>{
  const result=require('node:child_process').execFileSync(process.execPath,[path.join(ROOT,'tests/robust_frontier_ui_probe.js'),ROOT,'--axis-reload'],{
    encoding:'utf8',env:{...process.env,IAW_TEST_AXIS_STATE:saved||'null',IAW_TEST_AXIS_EXPECTED:JSON.stringify(expected)},
  });
  assert(JSON.parse(result).reloadPass);
};
const setBounds=(values)=>{
  if(card().querySelector('.port-axis-controls').hidden) DOC.getElementById('port-axis-toggle').click();
  ['x-min','x-max','y-min','y-max'].forEach((key,i)=>{DOC.getElementById('port-'+key).value=String(values[i]);});
  click('축 적용');
};
setBounds([0,12,-2,8]);
assert.deepEqual(Array.from(chart().opts.scales.x.range),[0,12]);
assert.deepEqual(Array.from(chart().opts.scales.y.range()),[-2,8]);
assert.equal(JSON.stringify(chart().data),originalData);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),originalStore);
assert.equal(DOC.activeElement,DOC.getElementById('port-axis-apply'));
assert(!card().querySelector('.port-axis-controls').hidden);
const savedAxis=shim.localStorage.getItem('iaw-port-axis');
assert.deepEqual(JSON.parse(savedAxis),{x:[0,12],y:[-2,8]});
reloadWith(savedAxis,{x:[0,12],y:[-2,8]});
draw(chart());
const applied=chart();
for(const bad of [[12,0,-2,8],[0,12,8,8],['',12,-2,8],[0,'Infinity',-2,8]]){
  setBounds(bad);
  assert.equal(chart(),applied);
  assert(!DOC.getElementById('port-axis-status').hidden);
  assert.equal(shim.localStorage.getItem('iaw-port-axis'),savedAxis);
}
setBounds([-5,15,-10,15]);
assert.deepEqual(Array.from(chart().opts.scales.x.range),[-5,15]);
P.renderPortPanel(SIX_ASSET_FIXTURE,{preserveDraft:true});
assert.deepEqual(Array.from(chart().opts.scales.x.range),[-5,15]);
assert.deepEqual(Array.from(chart().opts.scales.y.range()),[-10,15]);
reloadWith(shim.localStorage.getItem('iaw-port-axis'),{x:[-5,15],y:[-10,15]});
click('자동');
assert.deepEqual(chart().opts.scales.x.range,allRange);
assert.deepEqual(chart().opts.scales.y.range(),initial.opts.scales.y.range());
assert.equal(JSON.stringify(chart().data),originalData);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),originalStore);
assert.equal(DOC.activeElement,DOC.getElementById('port-axis-auto'));
assert.equal(shim.localStorage.getItem('iaw-port-axis'),null);
reloadWith(null,{x:allRange,y:Array.from(initial.opts.scales.y.range())});
for(const invalid of ['{broken',JSON.stringify({x:[12,0],y:[-2,8]}),JSON.stringify({x:[0,null],y:[-2,8]}),JSON.stringify({x:[0,12,15],y:[-2,8]})]){
  reloadWith(invalid,{x:allRange,y:Array.from(initial.opts.scales.y.range())});
}
// External axis titles consume plot space. Both titles must instead paint within
// the chart's pixel bounding box (50,10)–(700,310), without an outer axis label.
assert.equal(chart().opts.axes[0].label,undefined);
assert.equal(chart().opts.axes[1].label,undefined);
for(const label of ['변동성 · 연 %','기대수익 · 연 %']){
  const paintedTitle=draw(chart()).find(c=>c[0]==='fillText'&&c[1]===label);
  assert(paintedTitle,label+' missing inside plot');
  assert(paintedTitle[2]>50&&paintedTitle[2]<700&&paintedTitle[3]>10&&paintedTitle[3]<310);
}
DOC.getElementById('port-axis-toggle').click();
assert(card().querySelector('.port-axis-controls').hidden);
assert.equal(DOC.getElementById('port-axis-toggle').getAttribute('aria-expanded'),'false');
DOC.getElementById('port-axis-toggle').click();
assert.equal(DOC.activeElement,DOC.getElementById('port-x-min'));
card().querySelector('.port-axis').dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});
assert(card().querySelector('.port-axis-controls').hidden);
assert.equal(DOC.activeElement,DOC.getElementById('port-axis-toggle'));
assert.equal(live().length,1);assert.equal(inspect.live().length,1);assert(live().every(c=>DOC.contains(c.root)));
// Independent two-asset identities: annual percent inputs, no extra 12 or 10,000 factor.
const R=vm.runInContext('({portRiskInputs,portCorrKey,portChartColors,portRobustModel,portContributions})',sandbox);
// Exact two-asset examples and independent directional derivatives test the
// percent-point units, cancellation, negative risk budgets and Euler identity.
const contributionCases=[
  {w:[.5,.5],mu:[4,8],C:[[100,50],[50,400]],r:[100/3,200/3],s:[25,75]},
  {w:[.1,.9],mu:[4,8],C:[[100,-30],[-30,25]],s:[-1.7/15.85*100,17.55/15.85*100]},
  {w:[.5,.5],mu:[-4,4],C:[[100,50],[50,400]],r:null},
  {w:[.5,.5],mu:[-4,-8],C:[[100,50],[50,400]],r:[100/3,200/3]},
  {w:[.5,.5],mu:[4,8],C:[[0,0],[0,0]],s:null},
  {w:[1,0],mu:[4,8],C:[[100,50],[50,400]],r:[100,0],s:[100,0]},
  {w:[.2,.3,.5],mu:[-2,5,9],C:[[9,-1,2],[-1,4,.5],[2,.5,16]]},
];
for(const c of contributionCases){
  const got=R.portContributions(c.w,c.mu,c.C),expected=contributionOracle(c.w,c.mu,c.C);
  assert(Math.abs(got.mu-expected.mu)<1e-10);assert(Math.abs(got.sig-expected.sig)<1e-10);
  for(const [key,exact] of [['returnPct','r'],['riskPct','s']]){
    const want=Object.hasOwn(c,exact)?c[exact]:expected[key];
    if(want===null){assert.deepEqual(Array.from(got[key]),c.w.map(()=>null));continue;}
    assert.equal(got[key].length,c.w.length);
    Array.from(got[key]).forEach((v,i)=>assert(Math.abs(v-want[i])<2e-7,key+' mismatch'));
    assert(Math.abs(Array.from(got[key]).reduce((a,b)=>a+b,0)-100)<1e-8);
  }
}
// Isolated screen geometry distinguishes same-x scenarios and verifies clamping
// without relying on the optimizer's placement or the existing plot's x array.
const makeHover=vm.runInContext('portPortfolioHover',sandbox);
const hoverHost=DOC.createElement('div');DOC.body.append(hoverHost);
hoverHost.clientWidth=300;hoverHost.clientHeight=220;
hoverHost.getBoundingClientRect=()=>({left:100,top:70,width:300,height:220});
const isolatedPoints=[
  {x:3,y:2,label:'Conservative',w:[.8,.2]},
  {x:3,y:7,label:'Optimistic',w:[.2,.8]},
  {x:7,y:5,label:'포트폴리오',w:[.3,.7],cloud:true},
  {x:7.04,y:5.04,label:'현재',w:[.6,.4],hitRadius:7.5},
  {x:10.05,y:5,label:'범위 밖',w:[1,0]},
  ...[[0,0],[0,10],[10,0],[10,10]].map(([x,y])=>({x,y,label:'모서리',w:[.45,.55]})),
];
const isolatedHooks=makeHover(hoverHost,['A','B'],isolatedPoints,{mu:[4,8],C:[[100,50],[50,400]]});
const isolatedTip=hoverHost.querySelector('.port-portfolio-tooltip');
isolatedTip.offsetWidth=120;isolatedTip.offsetHeight=100;
for(const dpr of [1,2]){
  const oldDpr=sandbox.devicePixelRatio;sandbox.devicePixelRatio=dpr;
  try{
    const u={bbox:{left:12*dpr,top:16*dpr,width:280*dpr,height:180*dpr},
      over:{getBoundingClientRect:()=>({left:112,top:86})},
      valToPos(v,axis,canvas=false){
        assert.equal(canvas,false,'tooltip must project CSS pixels');
        return axis==='x'?v*28:(10-v)*18;
      }};
    isolatedHooks.draw(u);
    const at=(x,y)=>{u.cursor={left:x*28,top:(10-y)*18};isolatedHooks.setCursor(u);};
    at(3,2);assert.deepEqual(hoverWeights(isolatedTip),[80,20]);assert(isolatedTip.textContent.startsWith('Conservative'));
    at(3,7);assert.deepEqual(hoverWeights(isolatedTip),[20,80]);assert(isolatedTip.textContent.startsWith('Optimistic'));
    at(7,5);assert.deepEqual(hoverWeights(isolatedTip),[60,40]);assert(isolatedTip.textContent.startsWith('현재'));
    at(9.99,5);assert(isolatedTip.hidden,'cropped candidate selected across plot boundary');
    at(5,5);assert(isolatedTip.hidden,'empty space selected distant portfolio');
    for(const [x,y] of [[0,0],[0,10],[10,0],[10,10]]){
      at(x,y);assert(!isolatedTip.hidden);
      const left=parseFloat(isolatedTip.style.left),top=parseFloat(isolatedTip.style.top);
      assert(left>=6&&left+120<=294&&top>=6&&top+100<=214,'tooltip exceeds compact host');
    }
    u.cursor={left:null,top:null};isolatedHooks.setCursor(u);assert(isolatedTip.hidden);
    hoverHost.dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});assert(!isolatedTip.hidden);
    isolatedHooks.setSize();assert(isolatedTip.hidden);
  }finally{sandbox.devicePixelRatio=oldDpr;}
}
isolatedHooks.destroy();assert(!hoverHost.querySelector('.port-portfolio-tooltip'));hoverHost.remove();
// Zero denominators must render unavailable shares; hedging assets retain a
// negative risk share in the actual tooltip, rather than being clipped to zero.
for(const c of contributionCases){
  const host=DOC.createElement('div');DOC.body.append(host);
  host.clientWidth=400;host.clientHeight=300;
  const expected=contributionOracle(c.w,c.mu,c.C);
  const hooks=makeHover(host,c.w.map((_,i)=>'자산'+i),
    [{x:expected.sig,y:expected.mu,label:'현재',w:c.w}],{mu:c.mu,C:c.C});
  const u={bbox:{left:0,top:0,width:400,height:300},
    valToPos:(_,axis)=>axis==='x'?40:60,cursor:{left:40,top:60}};
  hooks.draw(u);hooks.setCursor(u);
  const tip=host.querySelector('.port-portfolio-tooltip');
  assert(!tip.hidden);checkContributions(tip,c.w,c.mu,c.C);
  assert.deepEqual(hoverWeights(tip),c.w.map(v=>v*100));
  hooks.destroy();host.remove();
}
const pair={assets:['A','B'],windows:[{key:'all',n_months:60,cov:[[.01,.005],[.005,.04]],mean_pct:[4,8]}]};
const two={mu:{},sig:{A:10,B:20},corr:{[R.portCorrKey('A','B')]:.25}};
const risk=R.portRiskInputs(pair,pair.windows[0],two);
assert(risk.valid);assert.equal(JSON.stringify(risk.C),'[[100,50],[50,400]]');
const engine=P.portEngine(pair,two);
assert(Math.abs(engine.sig([.5,.5])-Math.sqrt(150))<1e-10);
const exactMin=R.portRobustModel(risk.C,[4,8],60).solve(Infinity);
assert(Math.abs(exactMin.w[0]-.875)<1e-9);
assert(Math.abs(exactMin.sig-Math.sqrt(93.75))<1e-8);
for(const rho of [-1,0,1]){
  const s={...two,corr:{[R.portCorrKey('A','B')]:rho}};
  assert(R.portRiskInputs(pair,pair.windows[0],s).valid);
}
const zero=R.portRiskInputs(pair,pair.windows[0],{...two,sig:{A:0,B:20}});
assert(zero.valid&&zero.C[0].every(v=>v===0)&&zero.C[1][0]===0);
for(const v of [-1,Infinity,NaN,'',true]) assert(!R.portRiskInputs(pair,pair.windows[0],{...two,sig:{A:v,B:20}}).valid);
const triple={assets:['A','B','C']},tw={cov:[[.01,0,0],[0,.04,0],[0,0,.09]]};
const badCorr=Object.fromEntries([['A','B',.9],['A','C',.9],['B','C',-.9]].map(([a,b,v])=>[R.portCorrKey(a,b),v]));
assert(!R.portRiskInputs(triple,tw,{sig:{A:0},corr:badCorr}).valid);
const base=P.portEngine(SIX_ASSET_FIXTURE.port,P.portDefaults(SIX_ASSET_FIXTURE.port));
assert.equal(JSON.stringify(base.risk.C),JSON.stringify(base.W.cov.map(row=>row.map(v=>v*1e4))));
// Asset labels are drawn at model coordinates and all assets appear in the exact-value table.
assert.equal(card().querySelectorAll('.port-asset-position').length,6);
const painted=draw(chart());
for(const a of SIX_ASSET_FIXTURE.port.assets) assert(painted.some(c=>c[0]==='fillText'&&c[1]===a));
click('CSV');assert(sandbox.robustCSV[2].some(row=>row[0]==='국내채권'&&Math.abs(row[2]-base.risk.sig[0])<1e-12));
const field=(label)=>Array.from(panel.querySelectorAll('input')).find(n=>n.getAttribute('aria-label')===label);
const edit=(label,v)=>{const n=field(label);assert(n,label);n.value=String(v);n.dispatchEvent({type:'input'});return n;};
const state=()=>P.portState(SIX_ASSET_FIXTURE.port);
const currentSnapshot=()=>{
  const E=P.portEngine(SIX_ASSET_FIXTURE.port,state());
  const w=expectedAssets.map(a=>(state().mix[a]||0)/100),p={w,mu:E.muOf(w),sig:E.sig(w)};
  const paint=draw(chart());moveCursor(chart(),paint,paint.u.valToPos(p.sig,'x'),paint.u.valToPos(p.mu,'y'));
  const tip=card().querySelector('.port-portfolio-tooltip');
  checkPortfolio(tip,p,p.mu,E);
  return {E,w,returns:Array.from(tip.querySelectorAll('.port-tooltip-return'),n=>n.textContent),
    risks:Array.from(tip.querySelectorAll('.port-tooltip-risk'),n=>n.textContent)};
};
edit('국내채권 변동성',10);
assert.equal(state().sig.국내채권,10);assert.notEqual(JSON.stringify(chart().data),originalData);
assert(card().querySelector('.port-asset-key').textContent.includes('10.00'));
currentSnapshot();
const validData=JSON.stringify(chart().data),validSaved=shim.localStorage.getItem(P.PORT_LS_KEY);
const bad=edit('국내채권 변동성',-2);
assert.equal(bad.getAttribute('aria-invalid'),'true');assert.equal(JSON.stringify(chart().data),validData);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),validSaved);assert(/마지막 적용값/.test(DOC.getElementById('port-risk-status').textContent));
edit('국내채권 변동성','');assert.equal(state().sig.국내채권,undefined);
assert(!DOC.getElementById('port-frontier-panel').hidden&&!DOC.getElementById('port-correlation-panel').hidden);
const flow=Array.from(panel.children);
assert(flow.indexOf(panel.querySelector('.port-input-table-wrap'))<flow.indexOf(DOC.getElementById('port-correlation-panel')));
assert(flow.indexOf(DOC.getElementById('port-correlation-panel'))<flow.indexOf(DOC.getElementById('port-frontier-panel')));
assert(!DOC.getElementById('port-tab-corr')&&!DOC.getElementById('port-tab-frontier'));
assert.equal(panel.querySelectorAll('.port-corr-table input').length,15);
edit('국내채권 · 해외채권 상관계수',.1234);
P.renderPortPanel(SIX_ASSET_FIXTURE,{preserveDraft:true});
assert.equal(field('국내채권 · 해외채권 상관계수').value,'0.1234');
assert.equal(DOC.getElementById('port-corr-status').textContent,'미적용');
const unfinished=field('국내채권 · 해외채권 상관계수');
unfinished.value='';unfinished.validity={badInput:true};unfinished.dispatchEvent({type:'input'});
P.renderPortPanel(SIX_ASSET_FIXTURE,{preserveDraft:true});
const beforeBadNumber=shim.localStorage.getItem(P.PORT_LS_KEY);
DOC.getElementById('port-corr-apply').click();
assert.equal(field('국내채권 · 해외채권 상관계수').getAttribute('aria-invalid'),'true');
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),beforeBadNumber);
const corrFields=Array.from(panel.querySelectorAll('.port-corr-table input'));
corrFields.forEach(n=>{n.value='0';n.dispatchEvent({type:'input'});});
edit('국내채권 · 해외채권 상관계수',.9);edit('국내채권 · 국내주식 상관계수',.9);edit('해외채권 · 국내주식 상관계수',-.9);
const beforeInvalid=shim.localStorage.getItem(P.PORT_LS_KEY);
DOC.getElementById('port-corr-apply').click();
assert(/조합이 유효하지/.test(DOC.getElementById('port-corr-status').textContent));
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),beforeInvalid);
edit('국내채권 · 해외채권 상관계수',0);edit('국내채권 · 국내주식 상관계수',0);edit('해외채권 · 국내주식 상관계수',0);
DOC.getElementById('port-corr-apply').click();
assert.equal(Object.keys(state().corr).length,15);assert(Object.values(state().corr).every(v=>v===0));
assert.equal(P.portEngine(SIX_ASSET_FIXTURE.port,state()).risk.C[0][1],0);
edit('국내채권 변동성',10);
P.renderPortPanel(SIX_ASSET_FIXTURE,{preserveDraft:true});
assert.equal(field('국내채권 변동성').value,'10');assert.equal(field('국내채권 · 해외채권 상관계수').value,'0');
assert(!DOC.getElementById('port-frontier-panel').hidden&&!DOC.getElementById('port-correlation-panel').hidden);
const beforeMean=currentSnapshot();
edit('국내채권 기대수익',6.25);
assert.equal(state().mu.국내채권,6.25);
const afterMean=currentSnapshot();
assert.notDeepEqual(afterMean.returns,beforeMean.returns);
assert.deepEqual(afterMean.risks,beforeMean.risks);
edit('국내채권 · 해외채권 상관계수',.35);
assert.deepEqual(currentSnapshot().risks,afterMean.risks,'unapplied correlation changed contributions');
DOC.getElementById('port-corr-apply').click();
const afterCorr=currentSnapshot();
assert.notDeepEqual(afterCorr.risks,afterMean.risks);
assert.deepEqual(afterCorr.returns,afterMean.returns);
assert(Math.abs(afterCorr.E.risk.C[0][2]-.35*10*afterCorr.E.risk.sig[2])<1e-10);
// Palette mutations only affect drawing and persist separately from financial inputs.
const financial=shim.localStorage.getItem(P.PORT_LS_KEY),chartValues=JSON.stringify(chart().data);
DOC.getElementById('port-palette-toggle').click();assert(!DOC.getElementById('port-palette-panel').hidden);
const color=DOC.getElementById('port-color-nominal');color.value='#55aaff';color.dispatchEvent({type:'change'});
assert.equal(chart().opts.series[1].stroke,'#55aaff');assert.equal(JSON.stringify(chart().data),chartValues);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),financial);
assert.equal(R.portChartColors().nominal,'#55aaff');
const optimisticColor=DOC.getElementById('port-color-optimistic');
optimisticColor.value='#b5809c';optimisticColor.dispatchEvent({type:'change'});
assert.equal(chart().opts.series[3].stroke,'#b5809c');
assert.equal(R.portChartColors().optimistic,'#b5809c');
assert.equal(JSON.stringify(chart().data),chartValues);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),financial);
assert.equal(DOC.getElementById('port-color-robust').getAttribute('aria-label'),'Conservative 색상');
card().querySelector('.port-palette').dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});
assert(DOC.getElementById('port-palette-panel').hidden);assert.equal(DOC.activeElement,DOC.getElementById('port-palette-toggle'));
assert.equal(live().length,1);assert.equal(inspect.live().length,1);
// Previously entered KRW assumptions follow the renamed asset. Removing a 5%
// dollar position must leave 95%, without silently redistributing the other rows.
const legacySaved={...P.portDefaults(ALLOC_FIXTURE.port),
  mix:{국내채권:30,해외채권:15,국내주식:10,해외주식:20,대체투자:15,달러유동성:5,원화유동성:5},
  mu:{국내채권:3.4,원화유동성:2.25,달러유동성:9},
  sig:{해외채권:9.25,원화유동성:.6,달러유동성:22},
  corr:{[R.portCorrKey('원화유동성','국내채권')]:.11,
    [R.portCorrKey('달러유동성','국내채권')]:-.2,[R.portCorrKey('국내채권','해외채권')]:.3},
};
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(legacySaved));
P.renderPortPanel(SIX_ASSET_FIXTURE);
const migrated=state();
assert.deepEqual(JSON.parse(JSON.stringify(migrated.mix)),{국내채권:30,국내장부:5,해외채권:15,국내주식:10,해외주식:20,대체투자:15});
assert.equal(Object.values(migrated.mix).reduce((a,b)=>a+b,0),95);
assert.equal(migrated.mu.국내장부,2.25);assert.equal(migrated.sig.국내장부,.6);
assert.equal(migrated.corr[R.portCorrKey('국내장부','국내채권')],.11);
assert.equal(migrated.corr[R.portCorrKey('국내채권','해외채권')],.3);
for(const key of ['mix','mu','sig','corr']) assert(!/달러유동성|원화유동성/.test(JSON.stringify(migrated[key])));
assert.equal(field('국내장부 비중').value,'5');assert.equal(field('국내장부 기대수익').value,'2.25');
assert.equal(field('국내장부 변동성').value,'0.6');
assert(!Array.from(card().querySelectorAll('.port-marker-key')).some(n=>n.textContent.endsWith('현재')));
assert(!panel.querySelector('.port-benchmark').textContent.includes('현재 배분'));
click('CSV');assert(!sandbox.robustCSV[2].some(row=>row[0]==='현재'));
assert(sandbox.robustCSV[2].some(row=>row[0]==='국내장부'&&row[2]===.6&&row[3]===2.25));
edit('국내장부 비중',10);
assert(Array.from(card().querySelectorAll('.port-marker-key')).some(n=>n.textContent.endsWith('현재')));
assert(panel.querySelector('.port-benchmark').textContent.includes('현재 배분'));
edit('국내장부 기대수익',2.3);
const savedMigration=JSON.parse(shim.localStorage.getItem(P.PORT_LS_KEY));
for(const key of ['mix','mu','sig','corr']) assert(!/달러유동성|원화유동성/.test(JSON.stringify(savedMigration[key])));
assert.equal(savedMigration.mu.국내장부,2.3);assert.equal(savedMigration.mix.국내채권,30);
assert.equal(savedMigration.mix.국내장부,10);
P.renderPortPanel(SIX_ASSET_FIXTURE);
assert.equal(field('국내장부 기대수익').value,'2.3');
// Already saved new names win if an imported legacy copy contains both aliases.
const canonicalPair=R.portCorrKey('국내장부','국내채권');
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify({...legacySaved,
  mu:{...legacySaved.mu,국내장부:2.8},sig:{...legacySaved.sig,국내장부:.8},
  corr:{...legacySaved.corr,[canonicalPair]:.22}}));
assert.equal(state().mu.국내장부,2.8);assert.equal(state().sig.국내장부,.8);
assert.equal(state().corr[canonicalPair],.22);
// Annual percentage endpoints are checked from painted coordinates, independently
// of the interval objects. Equal asset coordinates exercise collision placement.
const dispersionState={...P.portDefaults(SIX_ASSET_FIXTURE.port),
  mu:{국내채권:4,국내장부:3,해외채권:4,국내주식:8,해외주식:8,대체투자:11},
  sig:{국내채권:4.41,국내장부:2,해외채권:4.41,국내주식:25,해외주식:13.75,대체투자:22.15}};
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(dispersionState));P.renderPortPanel(SIX_ASSET_FIXTURE);
const expectedIntervals=[[4.41,1.795,6.205],[2,2,4],[4.41,1.795,6.205],[25,-4.5,20.5],[13.75,1.125,14.875],[22.15,-.075,22.075]];
const intervalStrokes=(paint)=>paint.strokes.filter(s=>s.stage==='drawClear'&&s.path.length===6
  &&s.path.every((p,i)=>p[0]===(i%2?'lineTo':'moveTo')));
const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-9,actual+' differs from '+expected);
for(const dpr of [1,2]){
  const paint=draw(chart(),dpr),bars=intervalStrokes(paint);
  assert.equal(bars.length,6);
  bars.forEach((s,i)=>{
    const top=paint.value(s.path[0].slice(1)),bottom=paint.value(s.path[1].slice(1));
    near(top[0],expectedIntervals[i][0]);near(bottom[0],expectedIntervals[i][0]);
    near(top[1],expectedIntervals[i][2]);near(bottom[1],expectedIntervals[i][1]);
    assert.deepEqual(s.clip,paint.bbox);near(s.width,1.6*dpr);assert(/,0\.55\)$/.test(s.color));
  });
  const labels=paint.textBounds.filter(t=>expectedAssets.includes(t.text));
  assert.equal(labels.length,6);
  const overlaps=(a,b)=>Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)
    &&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y);
  labels.forEach((t,i)=>{
    assert.equal(t.align,'left');assert.equal(t.baseline,'alphabetic');
    assert(!paint.symbols.some(s=>overlaps(t,s)),t.text+' overlaps a painted marker');
    assert(!labels.slice(i+1).some(other=>overlaps(t,other)),t.text+' overlaps another label');
    assert(t.x>=paint.bbox.left&&t.x+t.w<=paint.bbox.left+paint.bbox.width);
    assert(t.y>=paint.bbox.top&&t.y+t.h<=paint.bbox.top+paint.bbox.height);
  });
  const tip=card().querySelector('.port-portfolio-tooltip');
  for(const a of ['국내주식','해외주식','대체투자']){
    const mu=dispersionState.mu[a],sig=dispersionState.sig[a];
    for(const ordinate of [mu,mu-.5*sig,mu+.5*sig,mu+.35*sig]){
      moveCursor(chart(),paint,paint.u.valToPos(sig,'x'),paint.u.valToPos(ordinate,'y'));
      checkAsset(tip,a,mu,sig,.5);
    }
  }
}
assert(chart().opts.scales.y.range()[0]<-4.5&&chart().opts.scales.y.range()[1]>22.075);
// Sigma controls only the asset dispersion display, including 0 and fractional
// values. The original financial state, covariance and plotted portfolios survive.
const sigmaData=JSON.stringify(chart().data),sigmaSaved=shim.localStorage.getItem(P.PORT_LS_KEY);
const sigmaCov=JSON.stringify(P.portEngine(SIX_ASSET_FIXTURE.port,state()).risk.C);
const setSigma=(value,enter=false)=>{
  const input=DOC.getElementById('port-range-sigma');input.value=String(value);
  input.dispatchEvent(enter?{type:'keydown',key:'Enter',preventDefault(){}}:{type:'change'});
};
for(const value of [.25,.5,.75,1.25,0,10,.7,1]){
  setSigma(value,value===1.25);
  assert.equal(DOC.getElementById('port-range-sigma').value,String(value));
  assert.equal(JSON.parse(shim.localStorage.getItem('iaw-port-range-sigma')),value);
  assert.equal(JSON.stringify(chart().data),sigmaData);assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),sigmaSaved);
  assert.equal(JSON.stringify(P.portEngine(SIX_ASSET_FIXTURE.port,state()).risk.C),sigmaCov);
  const paint=draw(chart()),bars=intervalStrokes(paint);assert.equal(bars.length,6);
  bars.forEach((bar,i)=>{
    const a=expectedAssets[i],mu=dispersionState.mu[a],sig=dispersionState.sig[a];
    near(paint.value(bar.path[0].slice(1))[1],mu+value*sig);
    near(paint.value(bar.path[1].slice(1))[1],mu-value*sig);
  });
}
const sigmaApplied=chart(),sigmaValid=shim.localStorage.getItem('iaw-port-range-sigma');
for(const value of ['',-1,'Infinity',11]){
  setSigma(value);assert.equal(chart(),sigmaApplied);
  assert.equal(DOC.getElementById('port-range-sigma').getAttribute('aria-invalid'),'true');
  assert.equal(shim.localStorage.getItem('iaw-port-range-sigma'),sigmaValid);
}
P.renderPortPanel(SIX_ASSET_FIXTURE,{preserveDraft:true});assert.equal(DOC.getElementById('port-range-sigma').value,'1');
for(const [saved,expected] of [['1.25',1.25],['0',0],['-1',.5],['null',.5],['"2"',.5],['{broken',.5]]){
  const output=require('node:child_process').execFileSync(process.execPath,[path.join(ROOT,'tests/robust_frontier_ui_probe.js'),ROOT,'--sigma-reload'],{
    encoding:'utf8',env:{...process.env,IAW_TEST_SIGMA_STATE:saved,IAW_TEST_SIGMA_EXPECTED:String(expected)},
  });assert(JSON.parse(output).reloadPass);
}
const dispersionData=JSON.stringify(chart().data),dispersionSaved=shim.localStorage.getItem(P.PORT_LS_KEY);
setBounds([0,30,20,22]);
setSigma(.5);assert.deepEqual(Array.from(chart().opts.scales.y.range()),[20,22]);
setSigma(1);assert.deepEqual(Array.from(chart().opts.scales.y.range()),[20,22]);
const cropped=draw(chart()),croppedBars=intervalStrokes(cropped);
// No mean is in this view, but three return-dispersion bars still cross it.
assert.equal(cropped.textBounds.filter(t=>expectedAssets.includes(t.text)).length,0);
assert.equal(croppedBars.length,6);
const stockBar=croppedBars.find(s=>Math.abs(cropped.value(s.path[0].slice(1))[0]-25)<1e-9);
assert(stockBar.path[0][2]<cropped.bbox.top&&stockBar.path[1][2]>cropped.bbox.top+cropped.bbox.height);
assert.deepEqual(stockBar.clip,cropped.bbox);
moveCursor(chart(),cropped,cropped.u.valToPos(25,'x'),cropped.u.valToPos(21,'y'));
checkAsset(card().querySelector('.port-portfolio-tooltip'),'국내주식',8,25,1);
assert.deepEqual(Array.from(chart().opts.scales.y.range()),[20,22]);
assert.equal(JSON.stringify(chart().data),dispersionData);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),dispersionSaved);
edit('국내주식 변동성',0);
assert.deepEqual(Array.from(chart().opts.scales.y.range()),[20,22]);
const zeroPaint=draw(chart()),zeroBar=intervalStrokes(zeroPaint).find(s=>Math.abs(zeroPaint.value(s.path[0].slice(1))[0])<1e-9);
assert(zeroBar);near(zeroPaint.value(zeroBar.path[0].slice(1))[1],8);near(zeroPaint.value(zeroBar.path[1].slice(1))[1],8);
click('자동');assert(shim.localStorage.getItem('iaw-port-axis')===null);
assert.equal(live().length,1);assert.equal(inspect.live().length,1);
console.log(JSON.stringify({pass:true,allRange,liveCharts:live().length,hoverDecimals:2,assets:expectedAssets,axisReload:true,legacyMigration:true}));
`;
const filename = path.join(repo, 'tests/robust_frontier_ui_regression.js');
const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap + '\n' + fixture + '\n' + sixFixture + '\n' + code, filename);
