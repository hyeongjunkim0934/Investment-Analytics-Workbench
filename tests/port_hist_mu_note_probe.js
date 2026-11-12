/* Table-level warning when expected returns fall back to the realized sample mean. */
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
const byId=id=>DOC.getElementById(id);
const render=(port,saved)=>{shim.localStorage.removeItem(P.PORT_LS_KEY);
  if(saved)shim.localStorage.setItem(P.PORT_LS_KEY,JSON.stringify(saved));
  const a={...alloc,port};P.DATA.alloc=a;P.renderPortPanel(a);
  const panel=byId('alloc-port-panel');
  const input=label=>Array.from(panel.querySelectorAll('input')).find(n=>n.getAttribute('aria-label')===label);
  return {note:byId('port-hist-mu-note'),input};};
const edit=(n,v)=>{n.value=String(v);n.dispatchEvent({type:'input'});};

// 1. Full CMA file: no fallback, note hidden and empty.
let r=render(p);
assert(r.note,'note element missing');
assert.equal(r.note.hidden,true);assert.equal(r.note.textContent,'');

// 2. No CMA file and no key-ins: every asset falls back; note names count, window and sample size.
const bare={...p,cma_input:null},W=bare.windows[bare.windows.length-1];
r=render(bare);
assert.equal(r.note.hidden,false);
assert(r.note.textContent.includes('미입력 '+bare.assets.length+'개'),r.note.textContent);
assert(r.note.textContent.includes(W.start)&&r.note.textContent.includes(W.end),r.note.textContent);
assert(r.note.textContent.includes(W.n_months+'개월'),r.note.textContent);
assert(r.note.textContent.includes('예측치가 아니'),r.note.textContent);

// 3. Partial CMA file: only the uncovered assets are listed.
const partial={...p,cma_input:{asof:'2030-06-01',mu_pct:Object.fromEntries(p.assets.slice(1).map(a=>[a,3]))}};
r=render(partial);
assert(r.note.textContent.includes('미입력 1개 자산('+p.assets[0]+')'),r.note.textContent);

// 4. Live key-in clears the note; blanking it restores the note. Nothing is stored.
const before=shim.localStorage.getItem(P.PORT_LS_KEY);
edit(r.input(p.assets[0]+' 기대수익'),4.5);
assert.equal(r.note.hidden,true);
edit(r.input(p.assets[0]+' 기대수익'),'');
assert.equal(r.note.hidden,false);
assert.equal(shim.localStorage.getItem(P.PORT_LS_KEY),before);

// 5. The note agrees with the engine's own source resolution.
const E=vm.runInContext('portModelInputs',sandbox)(bare,P.portState(bare));
assert.equal(E.src.filter(s=>s==='과거 평균(참고)').length,bare.assets.length);
console.log(JSON.stringify({pass:true,hiddenWithCma:true,fullFallback:true,partialFallback:true,liveKeyIn:true,engineAgrees:true}));
`;
const filename=path.join(repo,'tests/port_hist_mu_note_regression.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(bootstrap+'\n'+fixture+'\n'+modernFixture+'\n'+code,filename);
