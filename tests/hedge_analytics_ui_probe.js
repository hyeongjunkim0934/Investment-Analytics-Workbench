/* Exercise the real hedge renderer without running unrelated allocation probes. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const near = (a,b,tol=1e-9) => assert(Math.abs(a-b)<tol,a+' != '+b);
const same = (a,b) => assert.equal(JSON.stringify(a),JSON.stringify(b));
const stamp = date => Date.parse(date+'T00:00:00Z')/1000;
const iso = t => new Date(t*1000).toISOString().slice(0,10);
const CODES=['UST','JPY','AUD','GER'];
const currencies={UST:'USD',JPY:'JPY',AUD:'AUD',GER:'EUR'};
const dates=['2020-01-02','2022-09-23','2023-09-25','2024-09-25','2025-09-25','2026-08-25','2026-09-25'];
const history=dates.map(stamp), forecast=Array.from({length:13},(_,m)=>Date.UTC(2026,8+m,25)/1000);
const paths=(mean,vol)=>({mean_pct:mean,vol_pct:vol,
  center:forecast.map((_,m)=>mean*m/12),
  lower:forecast.map((_,m)=>mean*m/12-vol*Math.sqrt(m/12)),
  upper:forecast.map((_,m)=>mean*m/12+vol*Math.sqrt(m/12))});
const fixture={matrix:[],cost_dashboard:{},bond_merits:{},bond_analytics:{}};
CODES.forEach((code,i)=>{
  const cost=-1.25+i*.25, hv=i===1?6:3+i, uv=i===1?2:9+i;
  const curve={'3M':cost-.5,'6M':cost,'12M':cost+.5};
  const costDates=Object.fromEntries(Object.keys(curve).map(k=>[k,'2026-09-25']));
  fixture.cost_dashboard[currencies[code]]={curve,dates:costDates,src:'HP',label:'최근 5개 관측 평균'};
  fixture.bond_merits[code]={active:true,currency:currencies[code],cost_source:code==='UST'?'SMB':'HP',
    t:history,hedged:history.map((_,j)=>2+i+j*.1),ktb:history.map((_,j)=>2.4+j*.05),
    spread:history.map((_,j)=>-.4+i+j*.05),now:{cost,hedged:2.6+i,ktb:2.7,spread:-.1+i}};
  fixture.bond_analytics[code]={currency:currencies[code],
    distribution:{active:true,cost_source:code==='UST'?'SMB':'HP 원호가',start:'2000-01-03',end:'2026-09-25',
      n:10,min_pct:-5,max_pct:3,mean_pct:-2,bins:[
        {low:-5,high:-3,count:1,frequency_pct:10},{low:-3,high:-1,count:3,frequency_pct:30},
        {low:-1,high:1,count:5,frequency_pct:50},{low:1,high:3,count:1,frequency_pct:10}]},
    outlook:{active:true,asof:'2026-09-25',t:forecast,months:Array.from({length:13},(_,m)=>m),
      horizon_months:12,duration_years:8.25,yield_pct:4+i,cost:{mean_pct:cost,curve,dates:costDates},
      sample:{start:'2001-01-31',end:'2026-08-31',n_months:307},
      risk:{hedged_vol_pct:hv,unhedged_vol_pct:uv,reduction_pp:uv-hv},
      hedged:paths(4+i+cost,hv),unhedged:paths(4+i,uv)}};
});
// The drawing stub records scale changes. It deliberately does not recompute models.
shim.UPlotStub.prototype.setScale=function(key,bounds){(this.scales??={})[key]={...bounds};};
shim.UPlotStub.prototype.setSeries=function(index,state){Object.assign(this.series[index],state);};
const render=payload=>{
  const before=shim.UPlotStub.made.length;
  P.DATA.hedge=payload;P.renderHedge();
  const made=shim.UPlotStub.made.slice(before);
  made.forEach(u=>{u.series=u.opts.series.map(s=>({...s}));});return made;
};
const card=code=>DOC.getElementById('hedge-merit-'+code);
const charts=render(fixture);
assert.equal(charts.length,8);
const time=code=>charts.find(u=>card(code).contains(u.root)&&u.opts.series.length===10);
const hist=code=>charts.find(u=>card(code).contains(u.root)&&u.opts.series.length===2);
const button=(host,label)=>Array.from(host.querySelectorAll('button')).find(n=>n.textContent===label);
const input=(code,part)=>DOC.getElementById('hedge-merit-'+code+'-'+part);
const apply=(code,start,end)=>{input(code,'start').value=start;input(code,'end').value=end;input(code,'apply').click();};
const checkbox=code=>Array.from(card(code).querySelectorAll('input')).find(n=>n.getAttribute('type')==='checkbox');
const hasFuture=u=>u.data.slice(4).some(row=>row.some(Number.isFinite));
// An affine screen-coordinate invariant, independent of the renderer's scale formula.
const aligned=(u,anchor)=>{
  const {y,return:r}=u.scales;
  near((anchor-y.min)/(y.max-y.min),(0-r.min)/(r.max-r.min),1e-12);
  u.data.slice(4).flat().filter(Number.isFinite).forEach(v=>assert(v>=r.min&&v<=r.max));
};
const tableRows=host=>Array.from(host.querySelectorAll('tbody tr')).map(row=>Array.from(row.querySelectorAll('td')).map(c=>c.textContent));
const csvRows=()=>CSV_DOWNLOADS.at(-1).replace(/^\uFEFF/,'').split('\n').map(row=>row.split(','));
CODES.forEach(code=>{
  const c=card(code),u=time(code),h=hist(code),o=fixture.bond_analytics[code].outlook;
  assert(u&&h,code+' needs both chart types');
  assert.equal(input(code,'start').value,'2023-09-25');
  assert.equal(u.data[0][0],stamp('2023-09-25'));
  const timeBox=u.root.parentElement.parentElement,histBox=h.root.parentElement.parentElement;
  for(const box of [timeBox,histBox]){
    const legend=box.querySelector('.hedge-chart-legend'),host=box.querySelector('.hedge-plot-host');
    assert(legend&&box.children.indexOf(legend)<box.children.indexOf(host),'legend above plot');
  }
  assert.equal(u.opts.legend.show,false);assert.equal(h.opts.legend.show,false);
  assert(u.opts.axes[1].label.includes('금리'));assert(u.opts.axes[1].label.includes('%p'));
  assert.equal(u.opts.axes[2].scale,'return');assert.equal(u.opts.axes[2].side,1);
  assert(u.opts.axes[2].label.includes('누적 원화수익률'));
  u.opts.series.slice(1,4).forEach(s=>assert.equal(s.scale,'y'));
  u.opts.series.slice(4).forEach(s=>assert.equal(s.scale,'return'));
  u.opts.series.slice(1,4).forEach(s=>assert.equal(s.spanGaps,false));
  u.opts.series.slice(4).forEach(s=>assert.equal(s.spanGaps,true));
  assert.equal(u.data[0].at(-1),forecast.at(-1));assert.equal(u.scales.x.max,forecast.at(-1));
  for(const [high,low] of u.opts.bands.map(b=>b.series)){
    const center=low-1;
    assert([4,7].includes(center));
    assert.equal(u.opts.series[high].scale,'return');
    u.data[high].forEach((v,j)=>{
      if(v==null)return;
      assert(u.data[low][j]<=u.data[center][j]&&u.data[center][j]<=v,'ordered shaded interval');
    });
  }
  const at0=u.data[0].indexOf(forecast[0]);
  u.data.slice(4).forEach(row=>assert.equal(row[at0],0));
  // Historical yield is retained at the shared anchor, and stops before all future returns.
  assert.equal(u.data[1][at0],fixture.bond_merits[code].hedged.at(-1));
  aligned(u,fixture.bond_merits[code].hedged.at(-1));
  for(let j=at0+1;j<u.data[0].length;j++)u.data.slice(1,4).forEach(row=>assert.equal(row[j],null));
  near(u.data[4].at(-1),o.hedged.mean_pct);near(u.data[7].at(-1),o.unhedged.mean_pct);
  const D=fixture.bond_analytics[code].distribution;
  same(h.data[1],D.bins.map(b=>b.frequency_pct));
  assert.equal(h.opts.series[1].paths,undefined);assert(h.opts.series[1].width>0);
  assert.equal(h.opts.series[1].fill,undefined);assert(!h.opts.series[1].dash?.length);
  near(h.data[1].reduce((a,b)=>a+b,0),100);
  const distribution=c.querySelector('.hedge-distribution');
  assert(c.children.indexOf(distribution)>c.children.indexOf(timeBox.parentElement));
  assert(distribution.textContent.includes('2000-01-03'));assert(distribution.textContent.includes('최고 3.00%'));
  // Read the marker's requested data coordinate, not pixel output or duplicated UI arithmetic.
  const marker=[];
  h.valToPos=(value,scale)=>{marker.push({value,scale});return 12;};
  h.bbox={top:0,height:100};
  h.ctx=new Proxy({}, {get:(_,key)=>()=>{},set:()=>true});
  h.opts.hooks.draw.forEach(fn=>fn(h));
  assert.equal(marker.length,1);assert.equal(marker[0].scale,'x');near(marker[0].value,o.cost.mean_pct);
  h.cursor={idx:2,left:50,top:40};h.opts.hooks.setCursor.forEach(fn=>fn(h));
  const histTip=histBox.querySelector('.time-chart-tooltip');
  assert(!histTip.hidden&&histTip.textContent.includes('5일')&&histTip.textContent.includes('50.00%'));
});
assert(card('JPY').querySelector('.hedge-outlook-summary').textContent.includes('증가 4.00%p'));

// Tables and CSV must export the very same joined data as the plotted series.
const ust=time('UST'),ustBox=ust.root.parentElement.parentElement,ustHost=ustBox.parentElement;
button(ustHost,'표').click();button(ustHost,'CSV').click();
let exported=csvRows(),rows=tableRows(ustHost),headers=exported.shift();
assert.equal(headers.length,10);assert.equal(new Set(headers).size,10);
assert(headers[1].includes('(%)'));assert(headers[3].includes('(%p)'));
assert(headers[4].includes('누적수익률'));assert(headers[5].includes('하단'));assert(headers[6].includes('상단'));
assert.equal(exported.length,ust.data[0].length);assert.equal(rows.length,exported.length);
exported.forEach((row,i)=>{
  const j=ust.data[0].length-1-i;assert.equal(row[0],iso(ust.data[0][j]));
  row.slice(1).forEach((v,col)=>{
    const plotted=ust.data[col+1][j];
    if(plotted==null){assert.equal(v,'');assert.equal(rows[i][col+1],'–');}
    else{near(+v,plotted);near(+rows[i][col+1],plotted,.0051);}
  });
});
const dh=card('UST').querySelector('.hedge-distribution');
button(dh,'표').click();button(dh,'CSV').click();
exported=csvRows();assert(exported[0][0].includes('연 %'));assert(exported[0][3].includes('빈도 (%)'));
near(exported.slice(1).reduce((sum,row)=>sum+Number(row[2]),0),10);
near(exported.slice(1).reduce((sum,row)=>sum+Number(row[3]),0),100);
assert.equal(tableRows(dh).length,4);
ust.cursor={idx:ust.data[0].length-1,left:50,top:40};
ust.opts.hooks.setCursor.forEach(fn=>fn(ust));
const tip=ustBox.querySelector('.time-chart-tooltip');
assert(!tip.hidden&&tip.textContent.includes('2027-09-25'));
assert(tip.textContent.includes('100% 헤지 누적수익률')&&tip.textContent.includes('미헤지 누적수익률'));
assert(tip.textContent.includes('2.75%')&&/[-−]0\.25 ~ 5\.75%/.test(tip.textContent),tip.textContent);
assert(!tip.textContent.includes('국고 10년'));
// A band legend controls center and both edges together, including hover content.
const hedgeLegend=ustBox.querySelector('.hedge-chart-legend').querySelectorAll('button')[3];
hedgeLegend.click();[4,5,6].forEach(i=>assert.equal(ust.series[i].show,false));
assert.equal(hedgeLegend.getAttribute('aria-pressed'),'false');
ust.opts.hooks.setCursor.forEach(fn=>fn(ust));
assert(!tip.textContent.includes('100% 헤지 누적수익률')&&tip.textContent.includes('미헤지 누적수익률'));
hedgeLegend.click();[4,5,6].forEach(i=>assert.equal(ust.series[i].show,true));

// Period controls, toggle, invalid edits, and independent market state.
const jpyBefore=JSON.stringify(time('JPY').data);
apply('UST','2026-09-25','2026-09-25');
assert(hasFuture(ust)&&ust.data[0].at(-1)===forecast.at(-1));
aligned(ust,fixture.bond_merits.UST.hedged.at(-1));
assert.equal(ust.data[0].length,13);assert.equal(tableRows(ustHost).length,13);
apply('UST','2020-01-02','2025-09-25');
assert(!hasFuture(ust));assert.equal(ust.data[0].at(-1),stamp('2025-09-25'));
assert.equal(time('JPY').data[0].at(-1),forecast.at(-1));assert.equal(JSON.stringify(time('JPY').data),jpyBefore);
const oldData=JSON.stringify(ust.data),oldScale=JSON.stringify(ust.scales);
apply('UST','2025-09-25','2020-01-02');
assert(!input('UST','status').hidden);assert.equal(JSON.stringify(ust.data),oldData);assert.equal(JSON.stringify(ust.scales),oldScale);
apply('UST','2026-02-30','2026-09-25');
assert(!input('UST','status').hidden);assert.equal(JSON.stringify(ust.data),oldData);
apply('UST','2030-01-01','2030-02-01');
assert(!hasFuture(ust));assert.equal(ust.data[0].length,0);
assert(!ustBox.querySelector('p').hidden);assert.equal(tableRows(ustHost).length,0);
button(card('UST'),'최근 3년').click();
assert.equal(input('UST','start').value,'2023-09-25');assert.equal(input('UST','end').value,'2026-09-25');
assert(hasFuture(ust));assert(ustBox.querySelector('p').hidden);
checkbox('UST').checked=false;checkbox('UST').dispatchEvent({type:'change'});
assert(!hasFuture(ust));assert.equal(ust.data[0].at(-1),history.at(-1));assert.equal(tableRows(ustHost).length,5);
checkbox('UST').checked=true;checkbox('UST').dispatchEvent({type:'change'});
assert(hasFuture(ust));assert.equal(ust.data[0].at(-1),forecast.at(-1));
input('UST','all').click();assert.equal(input('UST','start').value,dates[0]);

// Rerenders keep explicit windows; an explicit full-history selection follows refreshes.
apply('JPY','2024-09-25','2025-09-25');
const refreshed=JSON.parse(JSON.stringify(fixture));
CODES.forEach(c=>{
  const m=refreshed.bond_merits[c],o=refreshed.bond_analytics[c].outlook;
  m.t.push(stamp('2026-09-28'));
  ['hedged','ktb','spread'].forEach(key=>m[key].push(m[key].at(-1)+.1));
  o.t=Array.from({length:13},(_,month)=>Date.UTC(2026,8+month,28)/1000);o.asof='2026-09-28';
});
let refreshedCharts=render(refreshed);
assert.equal(input('UST','start').value,dates[0]);assert.equal(input('UST','end').value,'2026-09-28');
assert.equal(input('JPY','start').value,'2024-09-25');assert.equal(input('JPY','end').value,'2025-09-25');
assert.equal(input('AUD','start').value,'2023-09-28');
assert.equal(refreshedCharts.find(u=>card('UST').contains(u.root)&&u.data.length===10).data[0].at(-1),stamp('2027-09-28'));
assert(!hasFuture(refreshedCharts.find(u=>card('JPY').contains(u.root)&&u.data.length===10)));
vm.runInContext('Object.keys(HEDGE_MERIT_RANGES).forEach(k=>delete HEDGE_MERIT_RANGES[k])',sandbox);

// Each market owns its anchor, even when model and weekly chart vintages differ.
// Month ends are clamped (Jan 31 -> Feb 28), and a missing final quote is skipped.
const staggered=JSON.parse(JSON.stringify(fixture));
const ends={UST:'2026-01-31',JPY:'2026-09-23',AUD:'2026-09-28',GER:'2026-09-24'};
CODES.forEach((c,i)=>{
  const m=staggered.bond_merits[c];
  m.t=[stamp('2025-01-01'),stamp(ends[c]),stamp(ends[c])+86400];
  m.hedged=[1,-2+i,null];m.ktb=[2,3,3.1];m.spread=[-1,-5+i,null];
});
let staggeredCharts=render(staggered);
CODES.forEach((c,i)=>{
  const u=staggeredCharts.find(u=>card(c).contains(u.root)&&u.data.length===10);
  const at=u.data[0].indexOf(stamp(ends[c]));
  u.data.slice(4).forEach(row=>assert.equal(row[at],0));
  aligned(u,-2+i);
  assert.equal(u.data[0].at(-1),stamp(ends[c].replace('2026','2027')));
  const forecastStart=u.data[0].findIndex((_,j)=>u.data[4][j]!=null);
  assert.equal(forecastStart,at);
  assert(card(c).querySelector('.hedge-outlook-method').textContent.includes('추정 기준 2026-09-25'));
  assert(card(c).querySelector('.hedge-outlook-method').textContent.includes('표시 시작 '+ends[c]));
});
const jan=staggeredCharts.find(u=>card('UST').contains(u.root)&&u.data.length===10);
assert(jan.data[0].includes(stamp('2026-02-28')));assert(!jan.data[0].includes(stamp('2026-03-03')));
apply('UST','2025-01-01','2026-01-30');assert(!hasFuture(jan));

// Display-only tail crop does not renormalize or corrupt full-history exports.
const clipped=JSON.parse(JSON.stringify(fixture));
CODES.forEach(c=>Object.assign(clipped.bond_analytics[c].distribution,{
  std_pct:.5,display_sigma_limit:5,display_low_pct:-4.5,display_high_pct:.5,display_n:8,
  display_bins:[{low:-4.5,high:-3,count:1,frequency_pct:10},
    {low:-3,high:-1,count:3,frequency_pct:30},{low:-1,high:.5,count:4,frequency_pct:40}]}));
clipped.cost_dashboard.EUR.curve={'3M':9,'6M':9,'12M':9};
const clippedCharts=render(clipped);
CODES.forEach(c=>{
  const u=clippedCharts.find(u=>card(c).contains(u.root)&&u.data.length===2);
  same(u.opts.scales.x.range(),[-4.5,.5]);same(u.data[1],[10,30,40]);
  assert(u.data[0].every(v=>v>=-4.5&&v<=.5));
  const host=card(c).querySelector('.hedge-distribution');
  assert(host.textContent.includes('표시 ±5σ')&&host.textContent.includes('2일 생략'));
  button(host,'CSV').click();
  near(csvRows().slice(1).reduce((sum,row)=>sum+Number(row[2]),0),10);
  const markers=[];u.valToPos=v=>{markers.push(v);return 12;};
  u.bbox={top:0,height:100};u.ctx=new Proxy({},{get:()=>()=>{},set:()=>true});
  u.opts.hooks.draw.forEach(fn=>fn(u));
  assert.equal(markers.length,c==='GER'?0:1,'out-of-range mean must not expand axis');
});
vm.runInContext('Object.keys(HEDGE_MERIT_RANGES).forEach(k=>delete HEDGE_MERIT_RANGES[k])',sandbox);

// Existing published datasets and inactive statistics still render historical curves.
for(const analytics of [undefined,null,Object.fromEntries(CODES.map(c=>[c,{outlook:{active:false,reason:'공통 표본 부족'},distribution:{active:false,reason:'분포 없음'}}]))]){
  const legacy={...fixture,bond_analytics:analytics};const made=render(legacy);
  assert.equal(made.length,4);
  CODES.forEach(c=>{
    const u=made.find(x=>card(c).contains(x.root));assert.equal(u.data.length,4);same(u.data[0],history);
    assert(!checkbox(c));assert(!card(c).querySelector('.hedge-outlook-summary'));
    if(analytics)assert(card(c).textContent.includes('공통 표본 부족'));
  });
}
// Partially published active statistics must degrade to the historical view.
for(const missing of ['risk','cost','sample','hedged']){
  const broken=JSON.parse(JSON.stringify(fixture));
  CODES.forEach(c=>{broken.bond_analytics[c].outlook[missing]=null;});
  const made=render(broken);assert.equal(made.length,8);
  CODES.forEach(c=>{
    const u=made.find(x=>card(c).contains(x.root)&&x.opts.series.length===4);
    assert(u);assert.equal(u.data.length,4);assert(!checkbox(c));
    assert(card(c).textContent.includes('예상 범위 데이터가 불완전합니다.'));
  });
}
// A nonzero cumulative-return origin and absent historical anchor fail closed.
for(const mode of ['nonzero','missing-anchor']){
  const broken=JSON.parse(JSON.stringify(fixture));
  CODES.forEach(c=>{
    if(mode==='nonzero')broken.bond_analytics[c].outlook.hedged.upper[0]=1;
    else broken.bond_merits[c].hedged.fill(null);
  });
  const made=render(broken);
  CODES.forEach(c=>{
    assert(made.find(u=>card(c).contains(u.root)&&u.data.length===4));
    assert(!checkbox(c));
  });
}
console.log(JSON.stringify({fourMarkets:true,topLegends:true,separateUnitsAndScales:true,
  bandIndicesAndZeroAnchor:true,fullHorizonAtLatestDate:true,periodToggleAndIsolation:true,
  plotTableCsvAgreement:true,futureHover:true,fullHistoryDistribution:true,
  currentMeanMarker:true,naturalHedgeIncrease:true,legacyFallback:true,
  endpointAxisAlignment:true,marketSpecificDates:true,monthEndClamp:true,
  solidFrequencyLine:true,fiveSigmaDisplayCrop:true,fullTailExports:true}));
`;
const filename=path.join(repo,'tests/hedge_analytics_ui_runtime.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+code,filename);
