/* Keep this handoff synchronized with the implementation named in sources. */
globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.alloc = {
  id: "alloc",
  title: "자산배분",
  updated: "2026-09-30",
  summary: "7자산군·최소/최대 제약 → 경계선·비중1/비중2 비교 → 리스크 연계 비중",
  inputs: "월말 지수·USDKRW, 연 μ·σ(%), 상관계수, h(0~1), 그룹 최소·최대(%), 자산별 최소(%). 공분산은 게시 소수² → 계산 %²(×10,000)",
  outputs: "포트폴리오 μ·σ, 경계선, Conservative·Optimistic, 현재·잠재 리스크 연계 비중",
  sources: [
    { path: "dashboard/port-constraints.js", symbols: ["portConstraintSpec", "portConstrainedModel"] },
    { path: "pipeline/port.py", symbols: ["build", "_stats", "_fx_stats", "_hedge_cost"] },
    { path: "dashboard/app.js", symbols: ["portRiskInputs", "portModelInputs", "portRobustModel", "portFrontiers", "portHedgeInputs", "allocRiskObservations", "allocRiskOptimize"] }
  ],
  sections: [
    {
      id: "estimates",
      title: "표본·입력",
      formulas: [
        { expression: "rₜ = Pₜ / Pₜ₋₁ − 1;  Pₜ(KRW) = Pₜ(USD) × USDKRWₜ", legend: "P: 월말 지수. 해외시가·해외주식·대체투자는 원화 환산. 해외장부는 bm:장부가 해외채권의 원화 지수를 그대로 사용." },
        { expression: "μ̂ = 100 × 12 × 평균(r);  C = 10,000 × C게시", legend: "r: 월간 소수 수익률. C게시: 월 표본공분산(N−1 분모)의 12배, 연 소수². 화면 C는 연 %²." },
        { expression: "σᵢ = √Cᵢᵢ;  Cᵢⱼ(수기) = σᵢ × ρᵢⱼ × σⱼ", legend: "ρ: 상관계수. 수기 입력이 없으면 게시 공분산을 ×10,000 단위 변환만 하여 사용." }
      ],
      code: [
        "levels ← completed_month_end_levels()",
        "convert_USD_assets_to_KRW(levels)",
        "returns ← common_asset_monthly_returns(levels)",
        "window ← selected_published_window(returns)",
        "mu ← key_in_else_CMA_else_sample_mean(window)",
        "baseC ← decimal_squared_to_percent_squared(window.cov)",
        "C ← baseC",
        "if manual_sigma_or_corr: C ← covariance_from_sigma_corr()",
        "validate_finite_inputs_and_PSD_correlation(C)",
        "return_portfolio_model(window, mu, C)"
      ].join("\n"),
      note: "국내시가·국내장부·해외시가·해외장부·국내주식·해외주식·대체투자 7축. 해외장부 원천 헤지 상태 미검증으로 추가 헤지 제외. 평균은 산술 연환산, 10년 참고값은 공통 공분산에 섞지 않음.",
      sources: [
        { path: "pipeline/port.py", symbols: ["_me_levels", "_stats", "build"] },
        { path: "dashboard/app.js", symbols: ["portRiskInputs", "portModelInputs"] }
      ]
    },
    {
      id: "frontier",
      title: "포트폴리오·경계선",
      formulas: [
        { expression: "m(w) = μᵀw;  σ(w) = √(wᵀCw)", legend: "w: 소수 비중. m·σ는 연 %. μ·C는 선택한 입력 가정." },
        { expression: "w*(θ) = argmax [μᵀw − θ × wᵀCw / 2];  wᵢ ≥ 0,  Σᵢwᵢ = 1", legend: "θ≥0: 경계선 탐색 계수. % 단위 목적함수이며 리스크 연계 λ와 스케일이 다름." },
        { expression: "Lɡ ≤ Σᵢ∈ɡ wᵢ ≤ Uɡ;  wᵢ ≥ lᵢ", legend: "Lɡ·Uɡ: 주식·채권·대체 그룹 최소·최대. lᵢ: 개별자산 최소. 입력 %를 100으로 나눈 소수 비중." },
        { expression: "수익기여ᵢ = 100 × wᵢμᵢ / m(w);  위험기여ᵢ = 100 × wᵢ(Cw)ᵢ / (wᵀCw)", legend: "호버 기여도(%). 분모가 0에 가까우면 표시 보류; 음의 기여도도 가능." }
      ],
      code: [
        "model ← validated_mu_and_covariance()",
        "bounds ← validate_group_min_max_and_asset_floors()",
        "enumerate_affine_faces_of_feasible_portfolios(model, bounds)",
        "for theta in frontier_grid_plus_minimum_variance:",
        "  candidate ← solve_each_feasible_face(theta)",
        "  certify_dual_gap_over_feasible_vertices(candidate)",
        "  keep_best_certified_candidate(candidate)",
        "frontier ← remove_dominated_points(candidates)",
        "compare_weight1_weight2_and_60_40_benchmark(frontier)"
      ].join("\n"),
      note: "제약 적용은 일반·Conservative·Optimistic·환헤지 경계선과 리스크 연계에 같은 한도를 적용. 비중1/비중2는 각각 합계 100%를 검사하고 제약 밖도 비교용으로 표시. 불가능한 제약은 적용하지 않음.",
      sources: [
        { path: "dashboard/app.js", symbols: ["portRobustModel", "portFrontiers", "portContributions", "portEngine"] }
      ]
    },
    {
      id: "scenarios",
      title: "Conservative·Optimistic",
      formulas: [
        { expression: "a = κ × √(12 / N);  m₋(w) = μᵀw − aσ(w);  m₊(w) = μᵀw + aσ(w)", legend: "N: 선택 표본의 월수. 현재 화면 κ=1. 평균 불확실성의 역사적 크기를 가정." },
        { expression: "Conservative: argmax [m₋(w) − θσ(w)² / 2]", legend: "같은 그룹·개별 최소 제약, 공매도 금지·합계 100% 조건에서 하단 수익 시나리오를 최적화." },
        { expression: "Optimistic(s): max μᵀw + a × s,  단 σ(w)=s", legend: "위험 s별로 가능한 최고 평균을 계산하고 지배되는 점을 제거." }
      ],
      code: [
        "a ← scenario_scale(month_count, kappa=1)",
        "conservative ← solve_lower_mean_frontier(a)",
        "for risk in sampled_risk_levels:",
        "  w ← maximum_mean_at_fixed_risk(risk)",
        "  optimistic.add(upper_mean(w, a))",
        "include_vertices_and_frontier_endpoints()",
        "remove_dominated_points_without_bridging_gaps()",
        "draw_scenarios_and_interpolate_valid_segments()"
      ].join("\n"),
      note: "키인·CMA의 통계적 신뢰구간이 아닌 시나리오. 두 경계선의 최적 비중은 서로 다를 수 있음.",
      sources: [
        { path: "dashboard/app.js", symbols: ["portDefaults", "portState", "portRobustModel", "portFrontiers"] }
      ]
    },
    {
      id: "hedge-overlay",
      title: "환헤지 반영",
      formulas: [
        { expression: "rᴴᵢ = rᵁᵢ − hᵢe;  μᴴᵢ = μᵁᵢ + hᵢk", legend: "e: USDKRW 월 수익률. h: 헤지비중. k: 최신 HP 3M·6M·12M 단순평균(연 %, 양수 수취·음수 지급)." },
        { expression: "Cᴴᵢⱼ = Cᵁᵢⱼ − hᵢcⱼ − hⱼcᵢ + hᵢhⱼv", legend: "cᵢ: 자산·환율 연 공분산, v: 환율 연 분산. 게시 fx.cov_asset·fx.var(소수²)를 ×10,000 하여 %²로 통일. 자산과 같은 월 표본." },
        { expression: "cᵢ(수기) = cᵢ(과거) × σᵢ(수기) / σᵢ(과거)", legend: "변동성 수정 시 과거 자산·환율 상관 유지. 과거 σ가 0이면 cᵢ=0." }
      ],
      code: [
        "h ← enabled_USD_asset_hedge_ratios()",
        "if no_positive_ratio(h): return unhedged_inputs",
        "require_same_window_FX_moments_and_HP_cost()",
        "cross, variance ← decimal_squared_to_percent_squared(FX_moments)",
        "cross ← rescale_asset_FX_covariance_if_manual(cross)",
        "require_PSD_joint_asset_FX_matrix(cross)",
        "muH, CH ← apply_hedge_return_and_covariance(h)",
        "require_PSD_adjusted_covariance(CH)",
        "compare_unhedged_and_hedged_frontiers(muH, CH)"
      ].join("\n"),
      note: "월초 명목액 고정·기대 환율변화 0·비용 확정값 가정. 표준편차를 직접 차감하지 않음.",
      sources: [
        { path: "pipeline/port.py", symbols: ["_fx_stats", "_hedge_cost"] },
        { path: "dashboard/app.js", symbols: ["portHedgeInputs", "portModelInputs"] }
      ]
    },
    {
      id: "risk-allocation",
      title: "현재·잠재 리스크 연계",
      formulas: [
        { expression: "λₜ = b × scoreₜ;  b ∈ {1, 0.1}", legend: "score: 현재 또는 잠재 리스크 점수(0~100). 기본 배율 b=1, 화면에서 ×0.1 선택 가능." },
        { expression: "w*ₜ = argmax [μᵀw / 100 − λₜ × wᵀCw / 20,000]", legend: "μ는 연 %, C는 연 %²를 소수 수익률 단위로 환산. 포트폴리오와 동일한 최소·최대 한도, w≥0, 합계 1." }
      ],
      code: [
        "mu, C ← current_portfolio_inputs_including_hedge()",
        "for layer in [current_risk, potential_risk]:",
        "  history ← selected_weekly_scores_and_latest(layer)",
        "  validate_score_range_and_ordered_dates(history)",
        "  for point in history:",
        "    lambda ← point.score * selected_scale",
        "    w ← active_set_QP(mu, C, lambda)",
        "    require_constraint_and_KKT_certificate(w)",
        "  draw_asset_weights(history)"
      ].join("\n"),
      note: "현재 μ·C를 과거 전 기간에 고정 적용한 시나리오 경로. 시점별 재추정·실현수익 백테스트가 아님.",
      sources: [
        { path: "dashboard/app.js", symbols: ["portRiskAllocationEngine", "allocRiskViewState", "allocRiskObservations", "allocRiskOptimize"] }
      ]
    }
  ]
};
