/* Exercise FX subtab events and persisted model names with the real renderer. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'tests/dashboard_probe.js'), 'utf8');
const bootstrap = source.slice(0, source.indexOf('/* ============ P1.'));
const code = String.raw`
const assert = require('node:assert/strict');
const namesKey='iaw-fx-outlook-workspaces-v1', forecastsKey='iaw-fx-outlook-v2';
const byId=id=>DOC.getElementById(id);
const tab=key=>byId('fx-outlook-tab-'+key);
const editor=()=>byId('fx-outlook-name-editor');
const input=()=>byId('fx-outlook-name-input');
const status=()=>byId('fx-outlook-name-status');
const title=key=>byId('fx-outlook-title-'+key);
const emit=(node,type,props={})=>{
  const event={type,...props,preventDefault(){this.defaultPrevented=true;}};
  node.dispatchEvent(event);return event;
};
const typeName=value=>{input().value=value;emit(input(),'input');};
const submit=()=>emit(editor(),'submit');
const cancel=()=>editor().querySelectorAll('button').find(n=>n.textContent==='취소').click();
const edit=key=>emit(tab(key),'dblclick');
const selected=key=>{
  const panels={consensus:'fxoutlook-content',modelA:'fxoutlook-model-a',modelB:'fxoutlook-model-b'};
  Object.entries(panels).forEach(([id,panel])=>{
    assert.equal(tab(id).getAttribute('role'),'tab');
    assert.equal(tab(id).getAttribute('aria-controls'),panel);
    assert.equal(tab(id).getAttribute('aria-selected'),String(id===key));
    assert.equal(tab(id).getAttribute('tabindex'),id===key?'0':'-1');
    assert.equal(byId(panel).hidden,id!==key);
  });
};
const workspace=()=>vm.runInContext('renderFxOutlookWorkspace()',sandbox);
const clearSession=()=>vm.runInContext('fxOutlookModelNames=null;fxOutlookNameDraft=null;fxOutlookWorkspace="consensus";',sandbox);
const snapshot=()=>shim.localStorage.getItem(namesKey);
const saved=()=>JSON.parse(snapshot());

// Fixed synthetic history is enough to establish chart/input identity. The
// numerical range itself is covered by the existing FX outlook probe.
P.DATA.fx={outlook:{active:false,source:'bb:달러원',history:{t:[1704067200,1735689600],v:[1300,1350]}}};
shim.localStorage.removeItem(namesKey);shim.localStorage.removeItem(forecastsKey);
P.RENDERERS.fxoutlook();
selected('consensus');
assert.equal(tab('consensus').textContent,'컨센서스');
assert.equal(tab('modelA').textContent,'환율모형A');
assert.equal(tab('modelB').textContent,'환율모형B');
assert(editor().hidden);
const chart=shim.UPlotStub.made.at(-1),chartCount=shim.UPlotStub.made.length;
const consensus=byId('fxoutlook-content'),consensusNodes=consensus.children.slice();
const forecast=consensus.querySelector('input');
forecast.value='1425';emit(forecast,'input');
const forecastSaved=shim.localStorage.getItem(forecastsKey);
const consensusData=JSON.stringify(chart.data);
const fetchCount=FETCH_CALLS.length;

// A real inactive-tab double click first generates two clicks on the same
// target. Replacing buttons on the first click would lose the dblclick event.
const target=tab('modelA');
target.click();selected('modelA');assert.strictEqual(tab('modelA'),target);
target.click();assert.strictEqual(tab('modelA'),target);
emit(target,'dblclick');
assert(!editor().hidden);assert.strictEqual(DOC.activeElement,input());
assert.equal(input().value,'환율모형A');
assert.strictEqual(shim.UPlotStub.made.at(-1),chart);
assert.equal(shim.UPlotStub.made.length,chartCount);
cancel();tab('modelB').click();selected('modelB');tab('consensus').click();selected('consensus');
assert.deepEqual(consensus.children,consensusNodes);
assert.strictEqual(consensus.querySelector('input'),forecast);
assert.equal(forecast.value,'1425');assert.equal(JSON.stringify(chart.data),consensusData);
assert.equal(shim.localStorage.getItem(forecastsKey),forecastSaved);
assert.equal(shim.UPlotStub.made.length,chartCount);

edit('modelA');typeName('  원화   모형 A  ');submit();
assert.equal(tab('modelA').textContent,'원화 모형 A');assert.equal(title('modelA').textContent,'원화 모형 A');
assert(editor().hidden);assert.strictEqual(DOC.activeElement,tab('modelA'));
assert.equal(saved().modelA,'원화 모형 A');assert.equal(saved().modelB,'환율모형B');
edit('modelB');typeName('금리차 모형');submit();
assert.equal(tab('modelA').textContent,'원화 모형 A');assert.equal(saved().modelB,'금리차 모형');
workspace();selected('modelB');assert.equal(tab('modelA').textContent,'원화 모형 A');
clearSession();workspace();selected('consensus');
assert.equal(tab('modelA').textContent,'원화 모형 A');assert.equal(tab('modelB').textContent,'금리차 모형');
assert.equal(shim.localStorage.getItem(forecastsKey),forecastSaved);

// Validation does not destroy the last saved name or silently truncate it.
const validSaved=snapshot();
for(const value of ['   ','가'.repeat(31)]){
  edit('modelA');typeName(value);submit();
  assert(!editor().hidden);assert.equal(input().getAttribute('aria-invalid'),'true');
  assert(status().textContent);assert.equal(snapshot(),validSaved);
  assert.equal(tab('modelA').textContent,'원화 모형 A');
}
typeName('가'.repeat(30));submit();assert.equal(saved().modelA,'가'.repeat(30));
edit('modelA');typeName('미저장');cancel();
assert.equal(tab('modelA').textContent,'가'.repeat(30));assert(editor().hidden);
edit('modelB');typeName('미저장');
assert(emit(input(),'keydown',{key:'Escape'}).defaultPrevented);
assert(editor().hidden);assert.equal(tab('modelB').textContent,'금리차 모형');
edit('modelA');typeName('다른 탭으로 전환');tab('consensus').click();
assert(editor().hidden);edit('modelA');assert.equal(input().value,'가'.repeat(30));cancel();

// Theme/data rerenders preserve a live draft, but do not persist it early.
edit('modelB');typeName('작성 중 모형');const beforeDraft=snapshot();
workspace();assert(!editor().hidden);assert.equal(input().value,'작성 중 모형');
assert.equal(snapshot(),beforeDraft);submit();assert.equal(saved().modelB,'작성 중 모형');

// An unavailable storage backend cannot claim success or replace the name.
edit('modelA');typeName('저장 실패 모형');const beforeFailure=snapshot();
const realSet=shim.localStorage.setItem;
shim.localStorage.setItem=()=>{throw new Error('storage disabled');};
try{submit();}finally{shim.localStorage.setItem=realSet;}
assert(!editor().hidden);assert(status().textContent.includes('저장하지 못했습니다'));
assert.equal(snapshot(),beforeFailure);assert.equal(tab('modelA').textContent,'가'.repeat(30));
submit();assert(editor().hidden);assert.equal(saved().modelA,'저장 실패 모형');

// Arbitrary display labels must never become DOM, CSS selectors or identities.
const markup='<img src=x onerror=alert(1)>';
edit('modelA');typeName(markup);submit();
assert.equal(tab('modelA').textContent,markup);assert.equal(title('modelA').textContent,markup);
assert.equal(tab('modelA').children.length,0);assert.equal(title('modelA').children.length,0);
clearSession();workspace();assert.equal(tab('modelA').textContent,markup);
assert.equal(tab('modelA').children.length,0);tab('modelA').click();selected('modelA');

// Roving tab focus and F2 provide the same editor without a pointing device.
tab('consensus').click();
assert(emit(tab('consensus'),'keydown',{key:'ArrowRight'}).defaultPrevented);
selected('modelA');assert.strictEqual(DOC.activeElement,tab('modelA'));
emit(tab('modelA'),'keydown',{key:'ArrowLeft'});selected('consensus');
emit(tab('consensus'),'keydown',{key:'ArrowLeft'});selected('modelB');
emit(tab('modelB'),'keydown',{key:'Home'});selected('consensus');
emit(tab('consensus'),'keydown',{key:'End'});selected('modelB');
emit(tab('modelB'),'keydown',{key:'F2',isComposing:true});assert(editor().hidden);
emit(tab('modelB'),'keydown',{key:'F2'});assert(!editor().hidden);
typeName('한글 조합');
assert(emit(input(),'keydown',{key:'Enter',isComposing:true}).defaultPrevented);
assert(!editor().hidden);assert.equal(saved().modelB,'작성 중 모형');
emit(input(),'keydown',{key:'Escape',isComposing:true});assert(!editor().hidden);
emit(input(),'keydown',{key:'Escape'});assert(editor().hidden);
emit(tab('modelB'),'keydown',{key:'ArrowRight',isComposing:true});selected('modelB');
tab('consensus').click();emit(tab('consensus'),'dblclick');emit(tab('consensus'),'keydown',{key:'F2'});
assert(editor().hidden);assert.equal(tab('consensus').textContent,'컨센서스');

// Malformed persisted entries use per-model defaults; one bad value cannot
// prevent the other valid name from loading.
shim.localStorage.setItem(namesKey,JSON.stringify({modelA:'  ',modelB:'복원 모형'}));
clearSession();workspace();assert.equal(tab('modelA').textContent,'환율모형A');assert.equal(tab('modelB').textContent,'복원 모형');
shim.localStorage.setItem(namesKey,'{invalid json');clearSession();workspace();
assert.equal(tab('modelA').textContent,'환율모형A');assert.equal(tab('modelB').textContent,'환율모형B');
assert.equal(FETCH_CALLS.length,fetchCount);assert.equal(shim.localStorage.getItem(forecastsKey),forecastSaved);
assert.equal(shim.UPlotStub.made.length,chartCount);
console.log(JSON.stringify({threeSubtabsAndAria:true,inactiveDoubleClickStableDom:true,
  consensusChartAndDraftPreserved:true,namesIndependentPersistRerenderReload:true,
  invalidNamesRejected:true,cancelEscapeAndDraftRerender:true,storageFailureRecovery:true,
  namesRenderedAsText:true,keyboardTabsAndIme:true,malformedStorageFallback:true}));
`;
const filename=path.join(repo,'tests/fx_workspace_ui_runtime.js');
const runtime=new Module(filename,module);runtime.filename=filename;
runtime.paths=Module._nodeModulePaths(path.dirname(filename));
runtime._compile(bootstrap+'\n'+code,filename);
