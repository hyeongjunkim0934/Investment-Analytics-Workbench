/* Portfolio constraints. UI values are percent; all weights here are fractions.
   Three disjoint groups, individual floors, full investment and no shorting.
   No input is silently rescaled to make an infeasible mandate appear feasible. */
function portConstraintSpec(P, values = {}) {
  const assets = P?.assets, fail = (error) => ({ ok: false, error, active: true });
  if (!Array.isArray(assets) || !assets.length || assets.length > 10
      || new Set(assets).size !== assets.length) return fail("자산 구성을 확인하십시오.");
  const names = ["주식", "채권", "대체"], n = assets.length;
  const known = { 국내주식: "주식", 해외주식: "주식", 국내채권: "채권", 해외채권: "채권",
    국내시가: "채권", 해외시가: "채권", 국내장부: "채권", 해외장부: "채권",
    원화유동성: "채권", 달러유동성: "채권", 대체투자: "대체" };
  const memberships = assets.map((asset) => known[asset] || names.find((g) => P.defaults?.groups?.[g]?.includes(asset)));
  if (memberships.some((g) => !g)) return fail("분류되지 않은 자산의 제약조건을 확인하십시오.");
  const read = (raw, fallback) => raw == null ? fallback
    : (typeof raw === "number" || typeof raw === "string") && String(raw).trim() !== "" ? Number(raw) : NaN;
  const validPct = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
  const lower = assets.map((a) => read(values?.assetMin?.[a], 0) / 100);
  if (lower.some((v) => !validPct(v * 100))) return fail("개별자산 최소제약은 0~100%로 입력하십시오.");
  const groups = names.map((name) => ({ name, ids: memberships.map((g, i) => g === name ? i : -1).filter((i) => i >= 0),
    min: read(values?.groupMin?.[name], 0) / 100, max: read(values?.groupMax?.[name], 100) / 100 }));
  for (const g of groups) {
    if (!validPct(g.min * 100) || !validPct(g.max * 100)) return fail(`${g.name} 제약은 0~100%로 입력하십시오.`);
    if (g.min > g.max + 1e-12) return fail(`${g.name} 최소제약이 최대제약보다 큽니다.`);
    g.floor = Math.max(g.min, g.ids.reduce((s, i) => s + lower[i], 0));
    if (!g.ids.length && g.min > 1e-12) return fail(`${g.name} 최소제약을 충족할 자산이 없습니다.`);
    if (g.floor > g.max + 1e-12) return fail(`${g.name} 개별자산 최소제약 합이 최대제약을 초과합니다.`);
  }
  if (groups.reduce((s, g) => s + g.floor, 0) > 1 + 1e-12) return fail("최소제약 합이 100%를 초과합니다.");
  if (groups.reduce((s, g) => s + (g.ids.length ? g.max : 0), 0) < 1 - 1e-12)
    return fail("최대제약 합이 100%보다 작습니다.");
  const contains = (w, tol = 2e-8) => Array.isArray(w) && w.length === n && w.every(Number.isFinite)
    && Math.abs(w.reduce((s, v) => s + v, 0) - 1) <= tol
    && w.every((v, i) => v >= lower[i] - tol && v <= 1 + tol)
    && groups.every((g) => { const sum = g.ids.reduce((s, i) => s + w[i], 0); return sum >= g.min - tol && sum <= g.max + tol; });
  // A deterministic feasible starting point; this does not modify either comparison portfolio.
  const totals = groups.map((g) => g.floor);
  let remaining = 1 - totals.reduce((s, v) => s + v, 0);
  for (let pass = 0; pass < groups.length && remaining > 1e-12; pass++) {
    const open = groups.map((g, i) => g.ids.length && g.max - totals[i] > 1e-12 ? i : -1).filter((i) => i >= 0);
    if (!open.length) break;
    const increment = remaining / open.length;
    open.forEach((i) => { const add = Math.min(increment, groups[i].max - totals[i]); totals[i] += add; remaining -= add; });
  }
  const seed = lower.slice();
  groups.forEach((g, k) => { const extra = totals[k] - g.ids.reduce((s, i) => s + seed[i], 0);
    g.ids.forEach((i) => { seed[i] += extra / g.ids.length; }); });
  if (!contains(seed)) return fail("제약조건을 충족하는 비중을 계산할 수 없습니다.");
  const caps = [];
  groups.forEach((g) => {
    if (g.ids.length && g.max < 1) caps.push({ ids: g.ids.slice(), idx: g.ids.slice(), max: g.max, cap: g.max, label: `${g.name} 최대` });
    if (g.min > 0) { const ids = assets.map((_, i) => i).filter((i) => !g.ids.includes(i));
      caps.push({ ids, idx: ids.slice(), max: 1 - g.min, cap: 1 - g.min, label: `${g.name} 최소` }); }
  });
  const upper = assets.map(() => 1);
  return { ok: true, error: null, active: lower.some((v) => v > 0) || groups.some((g) => g.min > 0 || g.max < 1),
    n, assets: assets.slice(), lower, upper, lo: lower, hi: upper, groups, caps, contains, seed };
}

/* Enumerate affine faces of the constrained polytope (at most seven live assets).
   On a face, w(t)=w0+t*d and variance=v0+t²*d'Cd. The same scalar equation
   solves nominal and conservative utility. Optimistic fixed-risk sections use
   both stationary directions and every boundary face; they are not treated as
   a concave utility. Original C is used for all reported moments. */
function portConstrainedModel(C, mu, months, spec) {
  const n = mu?.length, dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const mv = (M, w) => M.map((r) => dot(r, w));
  if (!spec?.ok || n !== spec.n || !Number.isFinite(months) || months < 2
      || !Array.isArray(C) || C.length !== n || mu.some((v) => !Number.isFinite(v))
      || C.some((r, i) => !Array.isArray(r) || r.length !== n || r.some((v, j) =>
        !Number.isFinite(v) || Math.abs(v - C[j]?.[i]) > 1e-8))) return null;
  const scale = Math.max(1, ...C.map((r, i) => Math.abs(r[i]))), meanScale = Math.sqrt(12 / months);
  const N = C.map((r, i) => r.map((v, j) => v / scale + (i === j ? 1e-12 : 0)));
  const chol = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let v = N[i][j]; for (let k = 0; k < j; k++) v -= chol[i][k] * chol[j][k];
    if (i === j && !(v > 0)) return null;
    chol[i][j] = i === j ? Math.sqrt(v) : v / chol[j][j];
  }
  const inverse = (M) => {
    const d = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: d }, (_, j) => +(i === j))]);
    for (let c = 0; c < d; c++) {
      let p = c; for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (!(Math.abs(A[p][c]) > 1e-15)) return null;
      [A[p], A[c]] = [A[c], A[p]];
      const pivot = A[c][c]; for (let j = 0; j < 2 * d; j++) A[c][j] /= pivot;
      for (let r = 0; r < d; r++) if (r !== c) { const f = A[r][c];
        for (let j = 0; j < 2 * d; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map((r) => r.slice(d));
  };
  const independentRows = (rows, rhs) => {
    const basis = [], kept = [], target = [];
    for (let i = 0; i < rows.length; i++) {
      const v = [...rows[i], rhs[i]];
      for (const b of basis) { const f = v[b.pivot]; for (let j = 0; j < v.length; j++) v[j] -= f * b.v[j]; }
      const pivot = v.slice(0, -1).findIndex((x) => Math.abs(x) > 1e-10);
      if (pivot < 0) { if (Math.abs(v[v.length - 1]) > 1e-9) return null; continue; }
      const divisor = v[pivot]; for (let j = 0; j < v.length; j++) v[j] /= divisor;
      basis.push({ v, pivot }); kept.push(rows[i]); target.push(rhs[i]);
    }
    // Reduce the geometry, not the covariance: form a particular solution and
    // a basis for all free directions without subtracting inverse projections.
    const reduced = basis.map((b) => ({ v: b.v.slice(), pivot: b.pivot }));
    for (let k = reduced.length - 1; k >= 0; k--) for (let j = 0; j < k; j++) {
      const f = reduced[j].v[reduced[k].pivot];
      for (let c = 0; c < reduced[j].v.length; c++) reduced[j].v[c] -= f * reduced[k].v[c];
    }
    const width = rows[0].length, x = Array(width).fill(0), pivots = reduced.map((b) => b.pivot);
    reduced.forEach((b) => { x[b.pivot] = b.v[width]; });
    const Z = [];
    for (let j = 0; j < width; j++) if (!pivots.includes(j)) {
      const z = Array(width).fill(0); z[j] = 1;
      reduced.forEach((b) => { z[b.pivot] = -b.v[j]; }); Z.push(z);
    }
    return { E: kept, b: target, x, Z };
  };
  const groups = spec.groups.filter((g) => g.ids.length), choices = groups.map((g) => {
    if (Math.abs(g.min - g.max) <= 1e-12) return [g.min];
    const options = [null]; if (g.min > 0) options.push(g.min); if (g.max < 1) options.push(g.max); return options;
  });
  const combinations = [];
  const combine = (k, a) => { if (k === choices.length) { combinations.push(a); return; }
    choices[k].forEach((v) => combine(k + 1, [...a, v])); };
  combine(0, []);
  const faces = [], vertices = [], vertexKeys = new Set();
  const point = (w) => ({ w, mu: dot(mu, w), sig: Math.sqrt(Math.max(0, dot(w, mv(C, w)))) });
  const addVertex = (w) => { if (!spec.contains(w)) return; const key = w.map((v) => v.toFixed(9)).join(",");
    if (!vertexKeys.has(key)) { vertexKeys.add(key); vertices.push(point(w)); } };
  for (let mask = 1; mask < (1 << n); mask++) {
    const ids = mu.map((_, i) => i).filter((i) => mask & (1 << i));
    const fixed = mu.map((_, i) => i).filter((i) => !(mask & (1 << i)));
    for (const bounds of combinations) {
      const rows = [ids.map(() => 1)], rhs = [1 - fixed.reduce((s, i) => s + spec.lower[i], 0)];
      bounds.forEach((v, k) => { if (v != null) { const group = groups[k]; rows.push(ids.map((i) => +group.ids.includes(i)));
        rhs.push(v - fixed.reduce((s, i) => s + (group.ids.includes(i) ? spec.lower[i] : 0), 0)); } });
      const independent = independentRows(rows, rhs); if (!independent) continue;
      const { x, Z } = independent, dimension = Z.length;
      const w0 = spec.lower.slice(), d = Array(n).fill(0);
      ids.forEach((id, i) => { w0[id] = x[i]; });
      if (dimension) {
        const fullZ = Z.map((z) => { const row = Array(n).fill(0); ids.forEach((id, i) => { row[id] = z[i]; }); return row; });
        const NZ = fullZ.map((z) => mv(N, z));
        const hessian = fullZ.map((z) => NZ.map((v) => dot(z, v)));
        const inv = inverse(hessian); if (!inv) continue;
        const adjust = mv(inv, fullZ.map((z) => dot(z, mv(N, w0))));
        const direction = mv(inv, fullZ.map((z) => dot(z, mu.map((v) => v - mu[0]))));
        for (let i = 0; i < n; i++) { w0[i] -= fullZ.reduce((s, z, k) => s + z[i] * adjust[k], 0);
          d[i] = fullZ.reduce((s, z, k) => s + z[i] * direction[k], 0) / scale; }
      }
      if (w0.some((v) => !Number.isFinite(v)) || d.some((v) => !Number.isFinite(v))) continue;
      const v0 = Math.max(0, dot(w0, mv(N, w0)) * scale), curvature = Math.max(0, dot(d, mv(N, d)) * scale);
      const member = (w) => fixed.every((i) => Math.abs(w[i] - spec.lower[i]) < 1e-8)
        && bounds.every((v, k) => v == null || Math.abs(groups[k].ids.reduce((s, i) => s + w[i], 0) - v) < 1e-8);
      faces.push({ w0, d, v0, curvature, dimension, member, gmv: spec.contains(w0) ? w0 : null });
      if (!dimension) addVertex(w0);
    }
  }
  if (!vertices.length || !faces.length) return null;
  const robustK = (k) => k != null && Number.isFinite(+k) ? Math.max(0, Math.min(3, +k)) : 1;
  const solve = (lam, kappa = 0) => {
    if (!(lam >= 0) && lam !== Infinity) return null;
    const a = robustK(kappa) * meanScale;
    let best = null;
    for (const f of faces) {
      let t = lam === Infinity || lam === 0 ? 0 : 1 / lam;
      if (lam === 0 && f.curvature > 1e-12) { if (a * a <= f.curvature) continue;
        t = Math.sqrt(f.v0 / (a * a - f.curvature)); }
      if (lam > 0 && Number.isFinite(lam) && a > 0 && t > 0) {
        let lo = 0, hi = t;
        for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2, sd = Math.sqrt(f.v0 + mid * mid * f.curvature);
          if (mid * (lam + a / sd) > 1) hi = mid; else lo = mid; }
        t = (lo + hi) / 2;
      }
      const w = f.w0.map((v, i) => v + t * f.d[i]); if (!spec.contains(w)) continue;
      const sd = Math.sqrt(Math.max(0, dot(w, mv(N, w)) * scale)), p = point(w);
      const objective = lam === Infinity ? sd * sd / 2 : lam * sd * sd / 2 + a * sd - p.mu;
      if (!best || objective < best.objective) best = { ...p, worst: p.mu - a * p.sig, lam, objective, sd };
    }
    if (!best) return null;
    const g = mv(N, best.w).map((v, i) => lam === Infinity ? v * scale
      : (lam + (a > 0 ? a / best.sd : 0)) * v * scale - mu[i]);
    best.gap = Math.max(0, dot(g, best.w) - Math.min(...vertices.map((v) => dot(g, v.w))));
    // Vertices certify the global linearized gap over this whole polytope.
    return Number.isFinite(best.gap) && best.gap <= 1e-5 ? best : null;
  };
  const atRisk = (sigma) => {
    if (!Number.isFinite(sigma) || sigma < 0) return null;
    const target = sigma * sigma, tolerance = scale * 1e-10;
    let best = null;
    const add = (w) => { if (!spec.contains(w)) return; const p = point(w);
      if (Math.abs(p.sig * p.sig - target) <= tolerance * 4 && (!best || p.mu > best.mu)) best = p; };
    for (const f of faces) {
      if (!f.dimension) { add(f.w0); continue; }
      const delta = target - f.v0; if (delta < -tolerance) continue;
      if (f.curvature > 1e-24) { const t = Math.sqrt(Math.max(0, delta) / f.curvature);
        for (const sign of [1, -1]) add(f.w0.map((v, i) => v + sign * t * f.d[i])); }
      else {
        // Equal means on a face: any attainable risk has the same return.
        // Follow a segment from its constrained GMV to its highest-risk vertex.
        if (f.flat === undefined) {
          const candidates = faces.filter((q) => q.gmv && f.member(q.gmv));
          const start = candidates.reduce((p, q) => !p || q.v0 < p.v0 ? q : p, null)?.gmv;
          const end = vertices.filter((p) => f.member(p.w)).reduce((p, q) => !p || q.sig > p.sig ? q : p, null)?.w;
          f.flat = start && end ? { start, end } : null;
        }
        if (!f.flat) continue;
        const { start, end } = f.flat, direction = end.map((v, i) => v - start[i]);
        const qa = dot(direction, mv(C, direction)), qb = 2 * dot(start, mv(C, direction));
        const dv = target - dot(start, mv(C, start)); if (dv < -tolerance) continue;
        if (Math.abs(dv) <= tolerance) { add(start); continue; }
        const disc = qb * qb + 4 * qa * dv; if (disc < 0 || qa <= 0) continue;
        const t = 2 * dv / (qb + Math.sqrt(disc));
        if (t >= -1e-9 && t <= 1 + 1e-9) add(start.map((v, i) => v + t * direction[i]));
      }
    }
    return best;
  };
  return { solve, atRisk, meanScale, vertices,
    atReturn: (target) => portTargetReturnFromFaces(C, mu, faces, target, spec.contains) };
}

/* Minimum variance subject to a return floor. Every affine face supplies its
   GMV and its covariance-adjusted mean direction; intersect that direction
   with the target-return plane, then compare all feasible faces. This also
   handles tied maximum-return assets without choosing an arbitrary vertex. */
function portTargetReturnFromFaces(C, mu, faces, target, contains = null) {
  if (!Number.isFinite(target)) return null;
  const n = mu.length, dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const shiftedMu = mu.map((v) => v - mu[0]);
  const tolerance = 1e-8 * Math.max(1, Math.abs(target), ...mu.map(Math.abs));
  const valid = contains || ((w) => w.length === n && w.every((v) => Number.isFinite(v) && v >= -1e-9)
    && Math.abs(w.reduce((sum, v) => sum + v, 0) - 1) <= 1e-8);
  let best = null;
  const add = (w) => {
    if (!valid(w)) return;
    const mean = dot(mu, w);
    if (!Number.isFinite(mean) || mean < target - tolerance) return;
    const variance = dot(w, C.map((row) => dot(row, w)));
    if (!Number.isFinite(variance) || variance < -1e-8) return;
    if (!best || variance < best.variance) best = { w, mu: mean, sig: Math.sqrt(Math.max(0, variance)), variance };
  };
  for (const f of faces) {
    const w0 = Array(n).fill(0), d = Array(n).fill(0);
    if (f.ids) f.ids.forEach((id, i) => { w0[id] = f.w0[i]; d[id] = (f.riskD || f.d)[i]; });
    else { f.w0.forEach((v, i) => { w0[i] = v; d[i] = f.d[i]; }); }
    const mean = dot(mu, w0);
    if (mean >= target - tolerance) add(w0);
    const slope = dot(shiftedMu, d);
    if (Number.isFinite(slope) && Math.abs(slope) > 1e-24) {
      const t = (target - mean) / slope;
      add(w0.map((v, i) => v + t * d[i]));
    }
  }
  if (!best) return null;
  return { w: best.w, mu: best.mu, sig: best.sig };
}

const PORT_TARGET_RETURN_CACHE = new WeakMap();
function portTargetReturn(model, target) {
  const fail = (error) => ({ point: null, target, error });
  if (!Number.isFinite(target)) return fail("Target Return을 숫자로 입력하십시오.");
  if (!model?.solve || !model.atReturn) return fail("Target Return 계산 불가 — 공분산 또는 제약조건을 확인하십시오.");
  const cached = PORT_TARGET_RETURN_CACHE.get(model);
  if (cached && cached.target === target) return cached;
  const minimum = model.solve(Infinity, 0), maximum = model.solve(0, 0);
  let result;
  if (!minimum || !maximum) result = fail("Target Return 계산 불가 — 최적화 수렴을 확인하십시오.");
  else {
    const tolerance = 1e-8 * Math.max(1, Math.abs(target), Math.abs(maximum.mu));
    if (target > maximum.mu + tolerance)
      result = fail(`목표수익률이 제약조건 내 최대 기대수익률 ${maximum.mu.toFixed(2)}%를 초과합니다.`);
    else {
      const point = target <= minimum.mu ? minimum : model.atReturn(Math.min(target, maximum.mu));
      result = point ? { point, target, error: "" } : fail("Target Return 계산 불가 — 목표수익률 또는 제약조건을 확인하십시오.");
    }
  }
  PORT_TARGET_RETURN_CACHE.set(model, result);
  return result;
}
