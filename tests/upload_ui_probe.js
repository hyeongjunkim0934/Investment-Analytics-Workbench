/* Execute the upload workspace with real routing and controlled remote responses.
 * No credentials or source workbooks leave this synthetic harness. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const bootstrap = fs.readFileSync(path.join(__dirname, "dashboard_probe.js"), "utf8");
const boundary = bootstrap.indexOf("const EXPORTS = [");
assert(boundary > 0, "dashboard bootstrap boundary");
const load = new Function("require", "__dirname", bootstrap.slice(0, boundary) + `
const saved = new Map([["iaw-port", '{"mu":{"국내시가":3}}']]);
const writes = [];
const storage = {
  getItem: (key) => saved.has(key) ? saved.get(key) : null,
  setItem: (key, value) => { writes.push([key, String(value)]); saved.set(key, String(value)); },
  removeItem: (key) => { writes.push([key, null]); saved.delete(key); }
};
sandbox.localStorage = storage;
sandbox.sessionStorage = storage;
sandbox.AbortController = AbortController;
sandbox.IAWDataUploadClient = {};
const timers = [];
sandbox.setTimeout = (fn, ms) => { const timer = {fn, ms, live:true}; timers.push(timer); return timer; };
sandbox.clearTimeout = (timer) => { if (timer) timer.live = false; };
vm.runInContext(fs.readFileSync(path.join(ROOT, "dashboard/data-upload.js"), "utf8"), sandbox, {filename:"data-upload.js"});
const noBoot = APP.replace(/\\nboot\\(\\);\\s*$/, "\\n");
if (noBoot === APP) throw new Error("app boot boundary");
vm.runInContext(noBoot + "\\n;globalThis.__uploadProbe = {DATA, FILES, SECTION_IDS, RENDERERS, routeView, renderSection, bindTheme, currentTheme, boot};", sandbox);
return {P:sandbox.__uploadProbe,DOC,shim,sandbox,saved,writes,FETCH_CALLS,main,nav,elem,timers};
`);
const {P,DOC,shim,sandbox,saved,writes,FETCH_CALLS,main,nav,elem,timers} = load(require,__dirname);
const byId = (id) => DOC.getElementById(id);
const section = elem("section","upload","section");
section.append(elem("div","upload-content"));
main.append(section);
const html = fs.readFileSync(path.join(__dirname,"../dashboard/index.html"),"utf8");
const navHTML = html.match(/<nav\b[^>]*\bid="nav"[^>]*>([\s\S]*?)<\/nav>/);
assert(navHTML,"real navigation markup");
for (const match of navHTML[1].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
  const anchor = elem("a"); anchor.setAttribute("href",match[1]); anchor.textContent=match[2]; nav.append(anchor);
}
const nextTick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i=0;i<5;i++) await nextTick(); };
const event = (type) => ({type,preventDefault(){this.defaultPrevented=true;}});
const fire = (id,type="click") => byId(id).dispatchEvent(event(type));
const credential = "test-token-only-never-persist";
const sha = "a".repeat(40);
const snapshot = {
  repository:"hyeongjunkim0934/Data",branch:"test-default-branch",headSha:"b".repeat(40),treeSha:"c".repeat(40),
  candidates:{bb:[{path:"raw/data_bb_대체투자 (2).xlsx",sha:"d".repeat(40)}],info:[{path:"raw/data_info.xlsx",sha:"e".repeat(40)}]}
};
const calls = {inspect:[],publish:[],notification:[],fetch:[]};
let inspectError = null, inspectWait = null, publishError = null, publishWait = null, unchanged = false;
let meta = {data_source_sha:"f".repeat(40),last_observation:"2026-10-30",built_at_utc:"2026-11-06 01:00 UTC"};
let fetchError = null;
let reloads = 0;
sandbox.location.reload = () => { reloads++; };
Object.assign(sandbox.IAWDataUploadClient, {
  inspect:async token => { calls.inspect.push(token); if(inspectWait) await inspectWait; if(inspectError) throw inspectError; return snapshot; },
  validateFile:async (file,kind) => ({name:file.name,size:file.size,kind}),
  publish:async (token,snap,files,options={}) => {
    calls.publish.push({token,snapshot:snap,files});
    if(options.onProgress) options.onProgress("검증 중");
    if(publishWait) await publishWait;
    if(publishError) throw publishError;
    return {commitSha:sha,branch:snapshot.branch,repository:snapshot.repository,unchanged,
      commitUrl:`https://github.com/hyeongjunkim0934/Data/commit/${sha}`};
  },
  checkNotification:async(token,commitSha) => {
    calls.notification.push({token,commitSha}); return {status:"completed",conclusion:"success",url:"https://github.com/hyeongjunkim0934/Data/actions/runs/1"};
  }
});
sandbox.fetch = async (url,options={}) => {
  calls.fetch.push({url:String(url),options});
  if(fetchError) throw fetchError;
  return {ok:true,status:200,json:async()=>meta};
};
const results = {};

(async()=>{
  P.DATA.uploadTestSentinel={weights:[0.6,0.4],date:"2026-10-30"};
  const dataBefore=JSON.stringify(P.DATA), storageBefore=JSON.stringify([...saved]);
  P.renderSection("upload");
  sandbox.location.hash="#upload"; P.routeView();
  assert(byId("upload-connect"),"upload workspace should mount before market data arrives");
  const anchors=[...nav.querySelectorAll("a")], hashes=anchors.map(node=>node.getAttribute("href"));
  results.navigation={adjacent:hashes[hashes.indexOf("#pseudo")+1]==="#upload",
    registered:P.SECTION_IDS.includes("upload")&&typeof P.RENDERERS.upload==="function",
    visible:!section.hidden&&byId("village").hidden,
    active:anchors.filter(node=>node.getAttribute("aria-current")==="page").map(node=>node.getAttribute("href")),
    noBackLink:!section.querySelector(".village-back")};
  results.initial={password:byId("upload-token").getAttribute("type"),
    live:byId("upload-status").getAttribute("aria-live"),
    submitDisabled:!!byId("upload-submit").disabled,
    bbAccept:byId("upload-bb").getAttribute("accept"),infoAccept:byId("upload-info").getAttribute("accept")};

  // Remaining assertions below use user-visible state and actual events.
  fire("upload-connect"); await settle();
  results.blankToken={noRequest:calls.inspect.length===0,status:byId("upload-status").textContent};

  inspectError = new Error("인증에 실패했습니다.");
  byId("upload-token").value=credential;
  fire("upload-connect"); await settle();
  results.connectionFailure={status:byId("upload-status").textContent,
    tokenCleared:byId("upload-token").value==="",submitDisabled:!!byId("upload-submit").disabled,
    canReconnect:!byId("upload-connect").disabled};
  inspectError = null;
  byId("upload-token").value=credential;
  fire("upload-connect"); await settle();
  results.connection={tokenPassed:calls.inspect.at(-1)===credential,
    tokenCleared:byId("upload-token").value==="",submitEnabled:!byId("upload-submit").disabled,
    bbTarget:byId("upload-bb-target").value,infoTarget:byId("upload-info-target").value,
    destination:byId("upload-connection").textContent};
  fire("upload-submit"); await settle();
  const emptyPublishCount=calls.publish.length;
  const bbFile={name:"data_bb_new.xlsx",size:1048576},infoFile={name:"data_info_new.xlsx",size:524288};
  byId("upload-bb").files=[bbFile]; fire("upload-bb","change");
  fire("upload-submit"); await settle();
  results.pairRequired={emptyBlocked:emptyPublishCount===0,oneBlocked:calls.publish.length===0,
    message:byId("upload-status").textContent};
  byId("upload-info").files=[infoFile]; fire("upload-info","change");

  const originalInputs=[byId("upload-bb"),byId("upload-info")];
  P.bindTheme();
  const themeBefore=P.currentTheme();
  byId("theme-btn").click();
  sandbox.location.hash="#hedge"; P.routeView();
  sandbox.location.hash="#upload"; P.routeView();
  P.renderSection("upload");
  results.rerender={themeChanged:P.currentTheme()!==themeBefore,
    sameInputs:originalInputs[0]===byId("upload-bb")&&originalInputs[1]===byId("upload-info"),
    filesPreserved:byId("upload-bb").files[0]===bbFile&&byId("upload-info").files[0]===infoFile,
    targetPreserved:byId("upload-bb-target").value===snapshot.candidates.bb[0].path,
    connected:!byId("upload-submit").disabled,noRenderError:!section.querySelector(".render-error")};

  let release;
  publishWait=new Promise(resolve=>{release=resolve;});
  fire("upload-submit"); fire("upload-submit"); await settle();
  results.inFlight={oneRequest:calls.publish.length===1,
    controlsDisabled:!!byId("upload-submit").disabled&&!!byId("upload-connect").disabled&&!!byId("upload-bb").disabled,
    ariaBusy:byId("upload-content").getAttribute("aria-busy"),
    currentDataUnchanged:JSON.stringify(P.DATA)===dataBefore};
  release(); await settle(); publishWait=null;
  const request=calls.publish[0];
  results.saved={sameConnection:request.token===credential&&request.snapshot===snapshot,
    twoFiles:request.files.length===2&&request.files[0].file===bbFile&&request.files[1].file===infoFile,
    fixedTargets:request.files.map(item=>item.path),
    visible:!byId("upload-result").hidden,tokenCleared:byId("upload-token").value==="",
    disconnected:!!byId("upload-submit").disabled&& !byId("upload-connect").disabled,
    checkEnabled:!byId("upload-check").disabled,refreshDisabled:!!byId("upload-refresh").disabled,
    message:byId("upload-status").textContent,deployment:byId("upload-deployment").textContent,
    commitLink:byId("upload-commit").querySelector("a")?.getAttribute("href")};

  fire("upload-check"); await settle();
  results.unpublished={refreshDisabled:!!byId("upload-refresh").disabled,
    message:byId("upload-deployment").textContent};
  meta={...meta,built_at_utc:"2099-01-01 00:00 UTC",last_observation:"2099-01-01"};
  fire("upload-check"); await settle();
  results.unpublished.timestampCannotProvePublication=!!byId("upload-refresh").disabled;
  meta={...meta,data_source_sha:sha,last_observation:"2026-11-06"};
  fire("upload-check"); await settle();
  fire("upload-refresh");
  results.deployed={refreshEnabled:!byId("upload-refresh").disabled,reloaded:reloads===1,
    message:byId("upload-deployment").textContent,
    requestsCacheSafe:calls.fetch.every(call=>call.options.cache==="no-store"&&call.url.includes(sha)),
    noCredentials:calls.fetch.every(call=>call.options.credentials==="omit"&&!call.options.headers),
    currentDataUnchanged:JSON.stringify(P.DATA)===dataBefore};
  fetchError=new Error("offline"); fire("upload-check"); await settle();
  results.checkFailure={message:byId("upload-deployment").textContent,
    commitRetained:!byId("upload-result").hidden,currentDataUnchanged:JSON.stringify(P.DATA)===dataBefore};
  fetchError=null;

  byId("upload-token").value=credential; fire("upload-connect"); await settle();
  byId("upload-bb").files=[bbFile];byId("upload-info").files=[infoFile];
  publishError=new Error("다른 갱신과 충돌했습니다. 다시 연결하십시오.");
  fire("upload-submit"); await settle();
  results.publishFailure={message:byId("upload-status").textContent,
    noSuccessPanel:byId("upload-result").hidden,tokenCleared:byId("upload-token").value==="",
    disconnected:!!byId("upload-submit").disabled&& !byId("upload-connect").disabled,
    currentDataUnchanged:JSON.stringify(P.DATA)===dataBefore};
  publishError=null;

  // A lost ref-update response leaves an inspectable candidate, never a false success.
  byId("upload-token").value=credential; fire("upload-connect"); await settle();
  publishError=Object.assign(new Error("저장 결과를 확인하지 못했습니다."),{commitSha:sha});
  fire("upload-submit"); await settle();
  results.uncertain={visible:!byId("upload-result").hidden,
    message:byId("upload-commit").textContent,refreshDisabled:!!byId("upload-refresh").disabled,
    canCheck:!byId("upload-check").disabled};
  publishError=null;

  byId("upload-token").value=credential; fire("upload-connect"); await settle();
  fire("upload-disconnect");
  const countBefore=calls.publish.length;
  fire("upload-submit"); await settle();
  results.disconnect={cannotReuse:calls.publish.length===countBefore,
    tokenCleared:byId("upload-token").value==="",submitDisabled:!!byId("upload-submit").disabled,
    canReconnect:!byId("upload-connect").disabled};

  byId("upload-token").value=credential; fire("upload-connect"); await settle();
  for(const listener of shim.windowListeners.pagehide||[]) listener({type:"pagehide",persisted:true});
  for(const listener of shim.windowListeners.pageshow||[]) listener({type:"pageshow",persisted:true});
  const countBeforeExit=calls.publish.length;
  fire("upload-submit"); await settle();
  results.restoredPage={cannotReuse:calls.publish.length===countBeforeExit,
    tokenCleared:byId("upload-token").value==="",submitDisabled:!!byId("upload-submit").disabled,
    canReconnect:!byId("upload-connect").disabled};

  let releaseInspect;
  inspectWait=new Promise(resolve=>{releaseInspect=resolve;});
  byId("upload-token").value=credential; fire("upload-connect"); await settle();
  for(const listener of shim.windowListeners.pagehide||[]) listener({type:"pagehide",persisted:true});
  for(const listener of shim.windowListeners.pageshow||[]) listener({type:"pageshow",persisted:true});
  releaseInspect(); await settle(); inspectWait=null;
  const countBeforeStale=calls.publish.length;
  fire("upload-submit"); await settle();
  results.staleConnection={cannotReuse:calls.publish.length===countBeforeStale,
    tokenCleared:byId("upload-token").value==="",submitDisabled:!!byId("upload-submit").disabled,
    canReconnect:!byId("upload-connect").disabled,
    destinationCleared:!byId("upload-connection").textContent.includes(snapshot.branch)};

  byId("upload-token").value=credential; fire("upload-connect"); await settle();
  byId("upload-bb").files=[bbFile];byId("upload-info").files=[infoFile];
  unchanged=true; fire("upload-submit"); await settle(); unchanged=false;
  results.unchanged={visible:!byId("upload-result").hidden,
    message:byId("upload-status").textContent,deployment:byId("upload-deployment").textContent,
    commit:byId("upload-commit").textContent,
    refreshDisabled:!!byId("upload-refresh").disabled,canCheck:!byId("upload-check").disabled,
    tokenCleared:byId("upload-token").value===""};
  results.privacy={onlyThemeStored:writes.length===1&&writes[0][0]==="iaw-theme",
    originalSettingsRetained:saved.get("iaw-port")===JSON.parse(storageBefore)[0][1],
    noTokenInDOM:!section.textContent.includes(credential),noTokenInStorage:!JSON.stringify([...saved]).includes(credential),
    currentDataUnchanged:JSON.stringify(P.DATA)===dataBefore};

  process.stdout.write(JSON.stringify(results));
})().catch(error=>{process.stderr.write(String(error.stack||error));process.exitCode=1;});
