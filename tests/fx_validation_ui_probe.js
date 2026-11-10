"use strict";
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const repo = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(repo, "tests/dashboard_probe.js"), "utf8");
const bootstrap = source.slice(0, source.indexOf("/* ============ P1."));
const code = String.raw`
const assert = require('node:assert/strict');
const host = DOC.getElementById('fx-validation-content');
assert(host);
const horizon = h => ({horizon_months:h,n_common:1,rows:[{
  origin_date:'2020-01-31',target_date:'2020-04-30',base:100,actual:110,model_steps:64,
  points:{a:105.12345,c:108,d:100,rw:100,equal_ac_rw:104.37448,shrink_ac_rw:103.28086},
  intervals:Object.fromEntries(['a','c','d','constant','ewma'].map(k=>[k,{lower95:80,upper95:120}])),
  variance:{d:.01,constant:.02,ewma:.03,realized:.009}
}],metrics:{sample:{n:1,origin_start:'2020-01-31',origin_end:'2020-01-31',target_start:'2020-04-30',target_end:'2020-04-30'},
  point:{a:{n:1,rmse:h+0.1234,mae:4.5,theil_u_rw:.98765},rw:{n:1,rmse:10,mae:10,theil_u_rw:1}},
  interval:{'95':{sample:{n:1,target_start:'2020-04-30',target_end:'2020-04-30'},models:{a:{n:1,coverage:1,interval_score:40},c:{n:1,coverage:0,interval_score:88}}}},
  variance:{d:{n:1,qlike:-9.123456},ewma:{n:1,qlike:-8.123456}}}});
P.DATA.fx={validation:{schema:'fx_validation_v1',active:true,config:{max_origins:36,path_count:1000},horizons:[horizon(3),horizon(12)]}};
const original=JSON.stringify(P.DATA.fx);
vm.runInContext('renderFxValidation(document.getElementById("fx-validation-content"))',sandbox);
assert.equal(host.querySelectorAll('table').length,3);
assert(host.textContent.includes('3.12'));
assert(host.textContent.includes('0.988'));
assert(host.textContent.includes('-9.1235'));
assert(host.textContent.includes('100.00'));
const select=DOC.getElementById('fx-validation-horizon');select.value='12';select.dispatchEvent({type:'change'});
assert(host.textContent.includes('12.12'));
host.querySelectorAll('button').find(n=>n.textContent==='CSV').click();
assert(CSV_DOWNLOADS.at(-1).includes('105.12345'));
assert.equal(JSON.stringify(P.DATA.fx),original);
P.DATA.fx.validation={schema:'fx_validation_v1',active:false,reason:'공통 표본 부족'};
vm.runInContext('renderFxValidation(document.getElementById("fx-validation-content"))',sandbox);
assert.equal(host.querySelectorAll('table').length,0);assert(host.textContent.includes('공통 표본 부족'));
console.log(JSON.stringify({mapping:true,horizon:true,csvPrecision:true,inactive:true,inputUnchanged:true}));
`;
const harness = new Module(path.join(repo, "tests/.fx-validation-inline.js"), module);
harness.filename=path.join(repo,"tests/.fx-validation-inline.js");harness.paths=Module._nodeModulePaths(path.join(repo,"tests"));
harness._compile(bootstrap+code,harness.filename);
