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
      return { ...hint, kind: "gap", label: "개선여지",
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

/* Sufficient conditions for a hypothetical NEW asset, not a security forecast
   or a new frontier optimization. The caller supplies actual nominal efficient
   allocations, with any active investment limits already accounted for.
   Expected return / volatility use annual percent; covariance uses percent^2.
   A fixed new-asset weight q preserves the reference mean when mu_new = mu_P.
   rho is correlation with the REFERENCE PORTFOLIO, not each existing asset.
   c = rho * sigma_new * Cw / sigma_P constructs its full covariance vector;
   the unexplained variance sigma_new^2 * (1-rho^2) makes the extension PSD. */
function portImprovementConditions(C, mu, references, options = {}) {
  const fail = (error) => ({ rows: [], error });
  if (!options || typeof options !== "object" || Array.isArray(options))
    return fail("가상자산 조건을 확인해 주세요.");
  const q = options.weight === undefined ? 0.1 : options.weight;
  const sigmaFactor = options.sigmaFactor === undefined ? 1 : options.sigmaFactor;
  const rho = options.correlation === undefined ? 0 : options.correlation;
  if (!Number.isFinite(q) || !(q > 0 && q < 1)
      || !Number.isFinite(sigmaFactor) || sigmaFactor < 0
      || !Number.isFinite(rho) || rho < -1 || rho > 1)
    return fail("편입 비중은 0~100% 사이, 변동성 배율은 0 이상, 상관계수는 -1~1이어야 합니다.");
  if (!Array.isArray(mu) || !mu.length || mu.some((v) => !Number.isFinite(v))
      || !Array.isArray(C) || C.length !== mu.length)
    return fail("기대수익률과 공분산 입력을 확인해 주세요.");
  const n = mu.length;
  if (C.some((r) => !Array.isArray(r) || r.length !== n || r.some((v) => !Number.isFinite(v)))
      || C.some((r, i) => r[i] < 0))
    return fail("공분산행렬의 차원과 수치를 확인해 주세요.");
  const scale = Math.max(1, ...C.map((r, i) => r[i]));
  if (C.some((r, i) => r.some((v, j) => Math.abs(v - C[j][i]) > 1e-10 * scale)))
    return fail("공분산행렬은 대칭이어야 합니다.");
  // Average only tolerated floating-point asymmetry. Never alter the input or
  // add the numerical PSD-check ridge to any reported covariance / moment.
  const M = C.map((r, i) => r.map((v, j) => v / 2 + C[j][i] / 2));
  const isPSD = (matrix) => {
    const size = matrix.length;
    const matrixScale = Math.max(1, ...matrix.map((r, i) => r[i]));
    const L = Array.from({ length: size }, () => Array(size).fill(0));
    for (let i = 0; i < size; i++) for (let j = 0; j <= i; j++) {
      let value = matrix[i][j] / matrixScale + (i === j ? 1e-12 : 0);
      for (let k = 0; k < j; k++) value -= L[i][k] * L[j][k];
      if (!Number.isFinite(value) || (i === j && !(value > 0))) return false;
      L[i][j] = i === j ? Math.sqrt(value) : value / L[j][j];
    }
    return true;
  };
  if (!isPSD(M)) return fail("공분산행렬이 양의 준정부호 조건을 충족하지 않습니다.");
  if (!Array.isArray(references) || references.length > 3)
    return fail("기준 포트폴리오는 최대 3개까지 비교할 수 있습니다.");
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const close = (a, b) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
  const rows = [];
  for (const reference of references) {
    if (!reference || !Array.isArray(reference.w) || reference.w.length !== n
        || reference.w.some((v) => !Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9)
        || Math.abs(reference.w.reduce((a, b) => a + b, 0) - 1) > 1e-7)
      return fail("기준 포트폴리오의 비중과 합계를 확인해 주세요.");
    const w = reference.w.slice();
    const Cw = M.map((r) => dot(r, w));
    const rawVariance = dot(w, Cw), baseMu = dot(mu, w);
    if (!Number.isFinite(rawVariance) || rawVariance < -scale * 1e-10 || !Number.isFinite(baseMu))
      return fail("기준 포트폴리오의 기대수익률과 변동성을 계산할 수 없습니다.");
    const baseVariance = Math.max(0, rawVariance), baseSigma = Math.sqrt(baseVariance);
    if ((reference.mu !== undefined && (!Number.isFinite(reference.mu) || !close(reference.mu, baseMu)))
        || (reference.sig !== undefined && (!Number.isFinite(reference.sig)
          || reference.sig < 0 || !close(reference.sig, baseSigma))))
      return fail("기준 포트폴리오와 입력 자산의 기대수익률·변동성이 일치하지 않습니다.");
    const assetMuMin = baseMu, assetSigma = baseSigma * sigmaFactor;
    const assetVariance = assetSigma * assetSigma;
    if (!Number.isFinite(assetSigma) || !Number.isFinite(assetVariance))
      return fail("가상자산 변동성이 계산 가능한 범위를 벗어났습니다.");
    const correlation = assetSigma > 0 && baseSigma > 0 ? rho : null;
    const covariance = Cw.map((v) => correlation === null ? 0 : rho * sigmaFactor * v);
    if (covariance.some((v) => !Number.isFinite(v)))
      return fail("가상자산 공분산을 계산할 수 없습니다.");
    const assetCorrelations = covariance.map((v, i) => {
      if (assetSigma === 0 || M[i][i] === 0) return null;
      return Math.max(-1, Math.min(1, v / assetSigma / Math.sqrt(M[i][i])));
    });
    const augmentedC = M.map((r, i) => [...r, covariance[i]]);
    augmentedC.push([...covariance, assetVariance]);
    if (!isPSD(augmentedC))
      return fail("확대 공분산행렬의 양의 준정부호 조건을 확인할 수 없습니다.");
    const mixWeights = [...w.map((v) => (1 - q) * v), q];
    const mixMu = dot([...mu, assetMuMin], mixWeights);
    const mixVariance = dot(mixWeights, augmentedC.map((r) => dot(r, mixWeights)));
    const outputScale = Math.max(scale, assetVariance);
    if (!Number.isFinite(mixMu) || !Number.isFinite(mixVariance) || mixVariance < -outputScale * 1e-10)
      return fail("혼합 포트폴리오의 기대수익률과 변동성을 계산할 수 없습니다.");
    const mixSigma = Math.sqrt(Math.max(0, mixVariance)), riskReduction = baseSigma - mixSigma;
    // Algebraically cancel q to avoid subtracting near-equal variances when q
    // is tiny. This is the STRICT rho upper bound at the selected fixed q;
    // retaining bounds outside [-1,1] distinguishes all / no feasible rhos.
    const rawLimit = assetSigma > 0 && baseSigma > 0
      ? ((2 - q) * baseVariance - q * assetVariance) / (2 * (1 - q) * baseSigma * assetSigma) : null;
    const correlationLimit = Number.isFinite(rawLimit) ? rawLimit : null;
    rows.push({
      label: typeof reference.label === "string" ? reference.label : `기준 ${rows.length + 1}`,
      w, baseMu, baseSigma, assetMuMin, assetSigma, correlation, assetCorrelations,
      covariance, augmentedC, mixWeights, mixMu, mixSigma, riskReduction, correlationLimit,
      improves: mixMu >= baseMu - 1e-9 * Math.max(1, Math.abs(baseMu), Math.abs(mixMu))
        && riskReduction > 1e-9 * Math.max(1, baseSigma, mixSigma),
      ...(baseSigma === 0 ? { reason: "기준 변동성이 0이므로 추가 위험 감소가 불가능합니다." } : {}),
    });
  }
  return { rows, error: null };
}
