/* 최소 DOM 셰이드 — `dashboard/app.js` 를 node 안에서 **실제로 실행**시키기 위한 것.

   왜 필요한가: 이 저장소의 대시보드 회귀 테스트는 지금까지 전부 app.js 를 *문자열로*
   읽어 특정 토큰이 있는지 보는 방식이었다. 그 방식은 "이름은 남기고 동작만 뒤집는"
   변경을 하나도 잡지 못한다 — 실제로 뮤테이션 10건을 걸어 본 결과 9건이 통과했다.
   (예: 눈금 재포맷 함수가 인자를 무시하게 만들어도, 오버레이의 inert 를 영구히 켜
   화면을 먹통으로 만들어도, 테스트는 초록불이었다.)

   그래서 값을 실제로 계산시키는 하네스를 둔다. npm 의존성은 **0** 이다 — node 와
   표준 라이브러리만 쓴다(`pipeline/check_output.py` 가 표준 라이브러리만 쓰는 것과 같은 규범).
   브라우저를 흉내 내는 것이 목적이 아니라, app.js 가 만지는 만큼만 구현한다.
   app.js 가 새 DOM API 를 쓰기 시작하면 여기가 먼저 터지므로 그때 채워 넣으면 된다. */

"use strict";

/* ---------- 선택자 ---------- */
/* app.js 가 실제로 쓰는 형태만 지원한다:
   `#id` · `.cls` · `tag` · `tag.cls` · `#id tag`(자손) · `a > b`(자식) · 콤마 목록.
   실제 사용 목록은 `grep -oE 'querySelectorAll?\("[^"]+"\)' dashboard/app.js`. */
function matchSimple(node, sel) {
  sel = sel.trim();
  if (!sel) return false;
  if (sel === "*") return true;
  /* id 에 한글이 들어간다 — 시뮬레이션 콘솔 입력칸이 `#sim-mix-해외주식` 처럼
     자산군 이름을 그대로 쓰기 때문이다. `\w` 만 받으면 그 선택자가 조용히 0건이 된다. */
  const parts = sel.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w가-힣-]+)*)$/);
  if (!parts) return false;
  const [, tag, rest] = parts;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const tok of rest.match(/[.#][\w가-힣-]+/g) || []) {
    if (tok[0] === "#") { if (node.id !== tok.slice(1)) return false; }
    else if (!node.classList.contains(tok.slice(1))) return false;
  }
  return true;
}

function matchCompound(node, sel) {
  /* 오른쪽부터 왼쪽으로 올라가며 맞춘다. `>` 는 부모, 공백은 조상. */
  const toks = sel.trim().split(/\s+/);
  let i = toks.length - 1;
  if (!matchSimple(node, toks[i])) return false;
  let cur = node.parentElement;
  i--;
  while (i >= 0) {
    if (toks[i] === ">") {
      i--;
      if (!cur || !matchSimple(cur, toks[i])) return false;
      cur = cur.parentElement; i--;
    } else {
      let found = null;
      for (let p = cur; p; p = p.parentElement) if (matchSimple(p, toks[i])) { found = p; break; }
      if (!found) return false;
      cur = found.parentElement; i--;
    }
  }
  return true;
}

const matches = (node, sel) => sel.split(",").some((s) => matchCompound(node, s));

/* ---------- 노드 ---------- */
class ClassList {
  constructor(node) { this.node = node; }
  get _set() { return new Set((this.node.className || "").split(/\s+/).filter(Boolean)); }
  _write(s) { this.node.className = [...s].join(" "); }
  add(...c) { const s = this._set; c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set; c.forEach((x) => s.delete(x)); this._write(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, on) { const want = on === undefined ? !this.contains(c) : !!on; want ? this.add(c) : this.remove(c); return want; }
}

class Style {
  constructor() { this._p = {}; }
  setProperty(k, v) { this._p[k] = v; }
  getPropertyValue(k) { return this._p[k] || ""; }
}

let NODE_SEQ = 0;

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentElement = null;
    this.className = "";
    this.attrs = new Map();
    this.classList = new ClassList(this);
    this.style = new Style();
    this.listeners = {};
    this.scrollTop = 0;
    this.clientWidth = 800;
    this._seq = NODE_SEQ++;
    this.dataset = {};
  }
  get id() { return this.attrs.get("id") || ""; }
  set id(v) { this.attrs.set("id", v); }
  /* `value` 는 속성과 프로퍼티가 갈린다 — HTML 도 그렇다(속성 = 초기값,
     프로퍼티 = 현재값이며 사용자가 건드리면 속성과 무관해진다). 예전 셰이드는
     프로퍼티를 항상 `""` 로 두어, `el("input", {value: "5000"})` 로 만든 칸을
     app.js 가 `+node.value` 로 읽으면 **0 이 나왔다** — "사용자가 이미 고쳤다"로
     오판하는 코드 경로가 프로브에서 검증 불가였다. */
  get value() { return this._value !== undefined ? this._value : (this.attrs.get("value") || ""); }
  set value(v) { this._value = v == null ? "" : String(v); }
  /* `hidden`/`inert` 는 프로퍼티로 읽고 쓴다 — app.js 가 `node.hidden = true` 로 쓴다. */
  get hidden() { return this.attrs.get("hidden") === true; }
  set hidden(v) { this.attrs.set("hidden", !!v); }
  get inert() { return this.attrs.get("inert") === true; }
  set inert(v) { this.attrs.set("inert", !!v); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get offsetParent() { return this.hidden ? null : (this.parentElement || DOC.body); }

  setAttribute(k, v) { if (k === "class") this.className = v; else this.attrs.set(k, String(v)); }
  getAttribute(k) { if (k === "class") return this.className; const v = this.attrs.get(k); return v === undefined ? null : String(v); }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }

  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      const n = k.nodeType ? k : DOC.createTextNode(String(k));
      if (n.parentElement) n.parentElement.childNodes = n.parentElement.childNodes.filter((x) => x !== n);
      n.parentElement = this;
      this.childNodes.push(n);
    }
  }
  appendChild(k) { this.append(k); return k; }
  prepend(...kids) {
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k == null) continue;
      const n = k.nodeType ? k : DOC.createTextNode(String(k));
      if (n.parentElement) n.parentElement.childNodes = n.parentElement.childNodes.filter((x) => x !== n);
      n.parentElement = this;
      this.childNodes.unshift(n);
    }
  }
  insertBefore(n, ref) {
    const i = this.childNodes.indexOf(ref);
    if (n.parentElement) n.parentElement.childNodes = n.parentElement.childNodes.filter((x) => x !== n);
    n.parentElement = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter((x) => x !== this); this.parentElement = null; }
  /* 마을 영상(상시 루프·장면 전환)이 `$("#village-map").after(v)` 로 자기를 끼워 넣는다. */
  after(...kids) {
    const p = this.parentElement;
    if (!p) return;
    let at = p.childNodes.indexOf(this) + 1;
    for (const k of kids) {
      if (k == null) continue;
      const n = k.nodeType ? k : DOC.createTextNode(String(k));
      if (n.parentElement) n.parentElement.childNodes = n.parentElement.childNodes.filter((x) => x !== n);
      n.parentElement = p;
      p.childNodes.splice(at++, 0, n);
    }
  }
  /* <video> 최소 셰이드. app.js 는 반환값에 .catch() 를 거므로 프로미스여야 한다.
     `_playing` 은 "실제로 재생을 요청받았는가"를 테스트가 확인하는 자리다. */
  play() { this._playing = true; return Promise.resolve(); }
  pause() { this._playing = false; }

  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    this.childNodes.forEach((c) => { c.parentElement = null; });
    this.childNodes = [];
    if (v !== "" && v != null) this.append(DOC.createTextNode(String(v)));
  }

  _walk(out) { for (const c of this.childNodes) if (c.nodeType === 1) { out.push(c); c._walk(out); } return out; }
  querySelectorAll(sel) { return this._walk([]).filter((n) => matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(n) { for (let p = n; p; p = p.parentElement) if (p === this) return true; return false; }
  closest(sel) { for (let p = this; p; p = p.parentElement) if (matches(p, sel)) return p; return null; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  /* 실제 이벤트 흐름 대신 "이 노드에서 위로 버블" 만 구현한다 — app.js 의 위임 핸들러
     (`#range-group` 클릭 → e.target.closest("button")) 가 이 경로로 돈다. */
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (let p = this; p; p = p.parentElement) {
      ev.currentTarget = p;
      (p.listeners[ev.type] || []).slice().forEach((f) => f.call(p, ev));
    }
    return !ev.defaultPrevented;
  }
  click() { this.dispatchEvent({ type: "click", target: this, preventDefault() { this.defaultPrevented = true; } }); }
  focus() { DOC.activeElement = this; }
  blur() { if (DOC.activeElement === this) DOC.activeElement = DOC.body; }
  /* 관문이 틀린 암구호에서 입력칸 전체를 다시 선택한다(재입력 편의). 선택 범위 자체는
     측정 대상이 아니라 초점만 옮기면 충분하다 — 없으면 그 자리에서 TypeError 로 죽는다. */
  select() { DOC.activeElement = this; }
  getBoundingClientRect() { return { top: 0, left: 0, width: this.clientWidth, height: 20, bottom: 20, right: this.clientWidth }; }
  scrollIntoView() {}
  getContext() { return null; }
}

class TextNode {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentElement = null; this.childNodes = []; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  _walk(out) { return out; }
}

/* ---------- document / window ---------- */
class Document {
  constructor() {
    this.nodeType = 9;
    this.documentElement = new Node("html");
    this.body = new Node("body");
    this.head = new Node("head");
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
    /* 마을 자동 순환 가드가 백그라운드 탭을 이 값으로 판정한다 — 없으면
       undefined 라 "항상 백그라운드"가 되어 가드 테스트가 무의미해진다. */
    this.visibilityState = "visible";
    this.listeners = {};
  }
  createElement(t) { return new Node(t); }
  createTextNode(t) { return new TextNode(t); }
  createElementNS(_ns, t) { return new Node(t); }
  getElementById(id) { return this.body.querySelectorAll(`#${id}`)[0] || null; }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  contains(n) { return this.body.contains(n) || n === this.body; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
}

const DOC = new Document();

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const location = { hash: "", href: "http://localhost/", replace() {} };

const windowListeners = {};
const win = {
  addEventListener: (t, f) => { (windowListeners[t] = windowListeners[t] || []).push(f); },
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (f) => setTimeout(() => f(0), 0),
  cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => "", display: "block" }),
  devicePixelRatio: 1,
  innerWidth: 1440,
  innerHeight: 900,
  scrollTo() {},
};

/* uPlot 대역품 — 실제 그리기는 하지 않고, 옵션(axes.values 콜백 포함)과 데이터를
   그대로 보관만 한다. 축 라벨 재포맷 검사가 이 보관본을 직접 호출한다. */
class UPlotStub {
  constructor(opts, data, box) {
    this.opts = opts; this.data = data; this.root = new Node("div");
    if (box && box.append) box.append(this.root);
    UPlotStub.made.push(this);
  }
  setData(d) { this.data = d; }
  setScale() {}
  setSize() {}
  destroy() {}
  static tzDate(d) { return d; }
}
UPlotStub.made = [];
UPlotStub.paths = { stepped: () => () => {}, bars: () => () => {} };
UPlotStub.tzDate = (d) => d;

module.exports = {
  document: DOC, Node, TextNode, localStorage, location, win, windowListeners,
  UPlotStub, matches,
};
