/* SAA/TAA slot isolation, explicit application, and residual weights through DOM events. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const fixture = source.slice(source.indexOf('const ALLOC_FIXTURE = (() => {'), source.indexOf('\nsafe("hedgeXe"'));
const comparison = fs.readFileSync(path.join(repo, 'tests/port_comparison_ui_probe.js'), 'utf8');
const modernFixture = comparison.slice(comparison.indexOf('const old=ALLOC_FIXTURE.port'), comparison.indexOf('// Removed liquidity caps'));
const code = String.raw`
const assert = require('node:assert/strict');
const same=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
const near=(a,b,tol=1e-8)=>assert(Math.abs(a-b)<tol,a+' != '+b);
const {portCorrKey}=vm.runInContext('({portCorrKey})',sandbox);
shim.UPlotStub.prototype.destroy=function(){this.dead=true;};
const legacy={mix:{국내채권:30,국내장부:10,해외채권:20,국내주식:15,해외주식:15,대체투자:10},
  mix2:{국내채권:25,국내장부:10,해외채권:20,국내주식:15,해외주식:15,대체투자:15},
  mu:{국내채권:4.2,해외채권:5.1},sig:{해외채권:9.1},
  corr:{[portCorrKey('국내채권','해외채권')]:.23},
  hedge:{해외채권:{enabled:false,ratio:70}},
  constraints:{groupMin:{주식:10},groupMax:{주식:80},assetMin:{}}};
shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(legacy));
P.DATA.alloc=alloc;P.renderPortPanel(alloc);
const panel=DOC.getElementById('alloc-port-panel'),byId=id=>DOC.getElementById(id);
const tab=(kind,key)=>byId('port-'+kind+'-tab-'+key);
const select=(kind,key)=>{const n=tab(kind,key);assert(n,kind+' '+key+' tab missing');n.click();};
const input=label=>Array.from(panel.querySelectorAll('input')).find(n=>n.getAttribute('aria-label')===label);
const edit=(label,value)=>{const n=input(label);assert(n,label+' missing');assert(!n.hasAttribute('readonly'),label+' unexpectedly readonly');
  n.value=String(value);n.dispatchEvent({type:'input'});};
const update=()=>byId('port-update-btn').click();
const stored=()=>shim.localStorage.getItem(P.PORT_LS_KEY);
const state=()=>P.portState(p);
const chart=()=>shim.UPlotStub.made.filter(n=>!n.dead&&n.opts.series.some(s=>s.label==='Baseline'||s.label==='경계선')).at(-1);
const chartData=()=>JSON.stringify(chart().data);
const linked=()=>JSON.stringify(P.portRiskAllocationEngine(alloc));
const inspect=vm.runInContext('({applied:()=>portPanelDraft.applied})',sandbox);
const firstState=state(),firstStore=stored(),firstData=chartData(),firstLinked=linked();

for(const [kind,keys,labels] of [['saa',['current','saa1','saa2'],['현재','SAA 1','SAA 2']],
                              ['taa',['current','taa1','taa2'],['현재','TAA 1','TAA 2']]]){
  keys.forEach((key,i)=>{assert.equal(tab(kind,key).textContent,labels[i]);
    assert.equal(tab(kind,key).getAttribute('role'),'tab');
    assert.equal(tab(kind,key).getAttribute('aria-selected'),String(i===0));});
}
assert.equal(firstState.mu.국내시가,4.2);
assert.equal(firstState.sig.해외시가,9.1);
assert.equal(firstState.mix.해외장부,0);
assert.equal(firstState.mix2.국내시가,25);
assert.equal(firstState.corr[portCorrKey('국내시가','해외시가')],.23);
assert(input('대체투자 비중1').hasAttribute('readonly'));
assert(input('대체투자 비중2').hasAttribute('readonly'));
near(Number(input('대체투자 비중1').value),10);
near(Number(input('대체투자 비중2').value),15);

// Residuals follow raw weight edits immediately, independently in both columns.
edit('국내시가 비중1',27.5);
near(Number(input('대체투자 비중1').value),12.5);
near(Number(input('대체투자 비중2').value),15);
edit('국내시가 비중2',20.25);
near(Number(input('대체투자 비중2').value),19.75);
edit('국내시가 변동성',-1);
edit('국내시가 · 해외시가 상관계수',1.5);
assert.equal(stored(),firstStore);
assert.equal(chartData(),firstData);
assert.equal(linked(),firstLinked);

// A new slot is detached from uncommitted edits in 현재, including error text.
select('taa','taa1');
assert.equal(input('국내시가 비중1').value,'30');
assert.equal(input('국내시가 비중2').value,'25');
assert.equal(input('국내시가 변동성').value,'');
near(Number(input('국내시가 · 해외시가 상관계수').value),.23);
assert.equal(input('해외시가 헤지비중 %').value,'70');
edit('국내시가 기대수익',7.125);
edit('해외시가 변동성',8.75);
edit('국내시가 · 해외시가 상관계수',.12);
input('해외시가 환헤지').checked=true;
input('해외시가 환헤지').dispatchEvent({type:'change'});
edit('해외시가 헤지비중 %',42);
input('해외시가 환헤지').checked=false;
input('해외시가 환헤지').dispatchEvent({type:'change'});
select('saa','saa1');
edit('주식 최대제약 %',65);
assert.equal(input('국내시가 기대수익').value,'7.125');
assert.equal(input('해외시가 변동성').value,'8.75');
near(Number(input('국내시가 · 해외시가 상관계수').value),.12);
select('taa','current');
assert.equal(input('국내시가 비중1').value,'27.5');
assert.equal(input('국내시가 비중2').value,'20.25');
assert.equal(input('국내시가 변동성').value,'-1');
assert.equal(input('국내시가 변동성').getAttribute('aria-invalid'),'true');
assert.equal(input('국내시가 · 해외시가 상관계수').value,'1.5');
assert.equal(input('해외시가 헤지비중 %').value,'70');
assert.equal(input('주식 최대제약 %').value,'65');
select('saa','current');
assert.equal(input('주식 최대제약 %').value,'80');
assert.equal(input('국내시가 변동성').value,'-1');
assert.equal(stored(),firstStore);
assert.equal(chartData(),firstData);
assert.equal(linked(),firstLinked);

// Save only the active pair; an invalid inactive TAA draft must not leak as null.
select('taa','taa1');select('saa','saa1');
update();
const oneState=state(),oneStore=stored(),oneData=chartData(),oneLinked=linked();
assert.equal(oneState.mu.국내시가,7.125);
assert.equal(oneState.sig.해외시가,8.75);
assert.equal(oneState.corr[portCorrKey('국내시가','해외시가')],.12);
assert.equal(oneState.constraints.groupMax.주식,65);
assert.equal(oneState.hedge.해외시가.ratio,42);
assert.equal(oneState.hedge.해외시가.enabled,false);
assert.notEqual(oneStore,firstStore);
assert.notEqual(oneData,firstData);
assert.notEqual(oneLinked,firstLinked);
same(inspect.applied().mu,oneState.mu);
select('taa','current');
assert.equal(input('국내시가 변동성').value,'-1');
assert.equal(input('국내시가 · 해외시가 상관계수').value,'1.5');
assert.equal(chartData(),oneData);
assert.equal(linked(),oneLinked);
assert.equal(stored(),oneStore);
select('saa','saa2');
assert.equal(input('주식 최대제약 %').value,'80');
select('taa','taa2');
assert.equal(input('국내시가 기대수익').value,'4.2');
assert.equal(input('해외시가 변동성').value,'9.1');

// Restoring saved values discards unsaved slots and restores the committed pair.
P.renderPortPanel(alloc);
assert.equal(tab('saa','saa1').getAttribute('aria-selected'),'true');
assert.equal(tab('taa','taa1').getAttribute('aria-selected'),'true');
assert.equal(input('국내시가 기대수익').value,'7.125');
select('taa','current');select('saa','current');
assert.equal(input('국내시가 비중1').value,'30');
assert.equal(input('국내시가 변동성').value,'');
near(Number(input('국내시가 · 해외시가 상관계수').value),.23);
assert.equal(input('주식 최대제약 %').value,'80');
assert.equal(stored(),oneStore);

// Residual overflow and missing weights reject the entire active pair atomically.
select('taa','taa2');select('saa','saa2');
edit('주식 최대제약 %',60);
edit('국내시가 비중1',100);
near(Number(input('대체투자 비중1').value),-60);
const beforeInvalid=chartData();update();
assert.equal(stored(),oneStore);
assert.equal(chartData(),beforeInvalid);
assert.equal(linked(),oneLinked);
assert(byId('port-risk-status').textContent.length>0);
edit('국내시가 비중1','');update();
assert.equal(stored(),oneStore);
assert.equal(chartData(),beforeInvalid);
select('taa','taa1');select('taa','taa2');
assert.equal(input('국내시가 비중1').value,'');
assert.equal(input('주식 최대제약 %').value,'60');
edit('국내시가 비중1',31.25);
edit('국내시가 비중2',28.25);
edit('국내시가 기대수익',6.625);
near(Number(input('대체투자 비중1').value),8.75);
near(Number(input('대체투자 비중2').value),11.75);
update();
const twoState=state();
assert.equal(twoState.constraints.groupMax.주식,60);
assert.equal(twoState.mu.국내시가,6.625);
near(twoState.mix.대체투자,8.75);near(twoState.mix2.대체투자,11.75);
near(Object.values(twoState.mix).reduce((a,b)=>a+b,0),100);
near(Object.values(twoState.mix2).reduce((a,b)=>a+b,0),100);

// Both saved non-current scenarios survive reload with no reference aliasing.
P.renderPortPanel(alloc);
assert.equal(tab('saa','saa2').getAttribute('aria-selected'),'true');
assert.equal(tab('taa','taa2').getAttribute('aria-selected'),'true');
select('saa','saa1');select('taa','taa1');
assert.equal(input('주식 최대제약 %').value,'65');
assert.equal(input('국내시가 기대수익').value,'7.125');
assert.equal(input('해외시가 변동성').value,'8.75');
assert.equal(input('해외시가 헤지비중 %').value,'42');
select('saa','current');select('taa','current');
assert.equal(input('주식 최대제약 %').value,'80');
assert.equal(input('국내시가 기대수익').value,'4.2');
assert.equal(input('해외시가 변동성').value,'9.1');
assert.equal(input('해외시가 헤지비중 %').value,'70');
console.log(JSON.stringify({pass:true,legacyMigration:true,detachedSlots:true,crossAxisDrafts:true,
  activePairCommit:true,invalidInactiveIsolation:true,residualWeights:true,atomicOverflowRejection:true,
  missingWeightPreserved:true,committedReload:true,linkedRiskIsolation:true}));
`;
const filename=path.join(repo,'tests/port_scenarios_ui_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+modernFixture+'\n'+code,filename);
