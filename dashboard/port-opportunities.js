/* Quiet, deterministic annotations for the existing nominal frontier.
   Inputs and coordinates use annual percent / percent-squared covariance.
   These are display candidates, independent of the random portfolio cloud:
   - gap: an actual frontier allocation far from individual asset coordinates;
   - diversification: that SAME allocation under a stated correlation scenario.
   The latter is not a newly optimized frontier or an attainable asset forecast. */
function portOpportunityHints(front, C, mu, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const alpha = Number.isFinite(opts.correlationShrink)
    ? Math.max(0, Math.min(1, opts.correlationShrink)) : 0.2;
  const maxCount = Number.isFinite(opts.maxPerKind)
    ? Math.max(0, Math.floor(opts.maxPerKind)) : 3;
  const empty = () => ({ gaps: [], diversification: [], scenarioC: null, correlationShrink: alpha });
  if (!Array.isArray(mu) || !mu.length || mu.some((v) => !Number.isFinite(v))
      || !Array.isArray(C) || C.length !== mu.length || !Array.isArray(front)) return empty();
  const n = mu.length;
  if (C.some((r) => !Array.isArray(r) || r.length !== n || r.some((v) => !Number.isFinite(v)))
      || C.some((r, i) => r[i] < 0)) return empty();
  const scale = Math.max(1, ...C.map((r, i) => r[i]));
  if (C.some((r, i) => r.some((v, j) => Math.abs(v - C[j][i]) > 1e-10 * scale))) return empty();
  // A tiny ridge is used ONLY to test positive semidefiniteness, never to
  // calculate a displayed point or repair a materially invalid covariance.
  const L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let v = (C[i][j] + C[j][i]) / (2 * scale) + (i === j ? 1e-12 : 0);
    for (let k = 0; k < j; k++) v -= L[i][k] * L[j][k];
    if (i === j && !(v > 0)) return empty();
    L[i][j] = i === j ? Math.sqrt(v) : v / L[j][j];
  }
  // Convex combination with the diagonal preserves PSD and asset variances;
  // every off-diagonal correlation is multiplied by (1-alpha), towards zero.
  const scenarioC = C.map((r, i) => r.map((v, j) => i === j ? v : (1 - alpha) * v));
  const result = { gaps: [], diversification: [], scenarioC, correlationShrink: alpha };
  if (n < 2 || !maxCount || !front.length) return result;
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const variance = (M, w) => dot(w, M.map((r) => dot(r, w)));
  const close = (a, b) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
  const points = front.filter((p) => {
    if (!p || !Number.isFinite(p.sig) || p.sig < 0 || !Number.isFinite(p.mu)
        || !Array.isArray(p.w) || p.w.length !== n
        || p.w.some((v) => !Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9)
        || Math.abs(p.w.reduce((a, b) => a + b, 0) - 1) > 1e-7) return false;
    const v = variance(C, p.w), m = dot(mu, p.w);
    return v >= -scale * 1e-10 && close(p.sig, Math.sqrt(Math.max(0, v))) && close(p.mu, m);
  }).sort((a, b) => a.sig - b.sig || b.mu - a.mu);
  // Supplied points must still have their original moments. Do not interpolate
  // weights, fill missing points, or annotate dominated/duplicate samples.
  const efficient = [];
  for (const p of points) {
    const last = efficient[efficient.length - 1];
    if (!last) efficient.push(p);
    else if (close(p.sig, last.sig)) {
      if (p.mu > last.mu) efficient[efficient.length - 1] = p;
    } else if (p.mu > last.mu + 1e-9) efficient.push(p);
  }
  if (!efficient.length) return result;
  const assets = mu.map((m, i) => ({ x: Math.sqrt(C[i][i]), y: m }));
  const xs = [...assets.map((p) => p.x), ...efficient.map((p) => p.sig)];
  const ys = [...mu, ...efficient.map((p) => p.mu)];
  const xSpan = Math.max(...xs) - Math.min(...xs), ySpan = Math.max(...ys) - Math.min(...ys);
  // Normalize by the actual data ranges, not the viewport or Monte Carlo draw.
  const distance = (a, b) => Math.hypot(xSpan > 1e-9 ? (a.x - b.x) / xSpan : 0,
    ySpan > 1e-9 ? (a.y - b.y) / ySpan : 0);
  const select = (candidates, score) => {
    const chosen = [];
    candidates.sort((a, b) => score(b) - score(a) || a.x - b.x || a.y - b.y);
    for (const p of candidates) {
      // Display spacing, not a test of economic or statistical significance.
      if (chosen.every((q) => distance(p, q) >= 0.24)) chosen.push(p);
      if (chosen.length >= maxCount) break;
    }
    return chosen.sort((a, b) => a.x - b.x);
  };
  const base = (p) => ({ x: p.sig, y: p.mu, baseX: p.sig, w: p.w.slice() });
  // A collapsed mean axis or one effective asset location has no meaningful
  // two-dimensional coverage gap. An isolated sample cannot locate a gap.
  if (efficient.length >= 3 && ySpan > 1e-9
      && assets.some((p) => distance(p, assets[0]) > 1e-8)) {
    const candidates = efficient.map((p) => {
      const hint = base(p);
      return { ...hint, kind: "gap", label: "자산 공백",
        note: "개별 자산점이 드문 구간 · 현재 자산 조합으로 도달하는 경계점",
        nearestAssetDistance: Math.min(...assets.map((a) => distance(hint, a))) };
    }).filter((p) => p.nearestAssetDistance >= 0.18);
    result.gaps = select(candidates, (p) => p.nearestAssetDistance);
  }
  if (alpha > 0) {
    const candidates = efficient.map((p) => {
      const scenarioVariance = variance(scenarioC, p.w);
      if (scenarioVariance < -scale * 1e-10) return null;
      const x = Math.sqrt(Math.max(0, scenarioVariance)), riskReduction = p.sig - x;
      // Omit numerical noise and imperceptible shifts. The renderer also tests
      // screen distance so a manual axis zoom cannot make noisy markers appear.
      if (!(riskReduction >= Math.max(0.05, p.sig * 0.01))) return null;
      return { ...base(p), x, kind: "diversification", label: "상관 완화 · 가정",
        note: `상관계수 절대값 ${Number((alpha * 100).toFixed(2))}% 축소 가정 · 동일 비중·기대수익 유지`,
        riskReduction, riskReductionPct: 100 * riskReduction / p.sig };
    }).filter(Boolean);
    result.diversification = select(candidates, (p) => p.riskReduction);
  }
  return result;
}
