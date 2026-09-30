/* Keep this handoff synchronized with the implementation named in sources. */
globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.alloc = {
  id: "alloc",
  title: "자산배분",
  updated: "2026-09-30",
  summary: "7자산군 CMA·최소/최대 제약 → 경계선·비중1/비중2 비교 → 리스크 연계 비중",
  inputs: "월말 지수·USDKRW, 연 μ·σ(%), CMA 시나리오 확률(%), 상관계수, h(0~1), 그룹 최소·최대(%), 자산별 최소(%). 공분산은 게시 소수² → 계산 %²(×10,000)",
  outputs: "포트폴리오 μ·σ, 경계선, Conservative·Optimistic, 현재·잠재 리스크 연계 비중",
  sources: [
    { path: "dashboard/port-constraints.js", symbols: ["portConstraintSpec", "portConstrainedModel"] },
    { path: "pipeline/port.py", symbols: ["build", "_stats", "_fx_stats", "_hedge_cost"] },
    { path: "dashboard/cma.js", symbols: ["cmaMoments", "cmaAssetAssumption", "renderCma", "cmaAssetLabel"] },
    { path: "dashboard/app.js", symbols: ["portRiskInputs", "portModelInputs", "portRobustModel", "portFrontiers", "portHedgeInputs", "allocRiskObservations", "allocRiskOptimize"] }
  ],
  sections: [
    {
      id: "estimates",
      title: "표본·입력",
      formulas: [
        { expression: "rₜ = Pₜ / Pₜ₋₁ − 1;  Pₜ(KRW) = Pₜ(USD) × USDKRWₜ", legend: "P: 월말 지수. 해외시가·해외주식·대체투자는 원화 환산. 해외장부는 bm:장부가 해외채권의 원화 지수를 그대로 사용." },
        { expression: "μ̂ = 100 × 12 × 평균(r);  C = 10,000 × C게시", legend: "r: 월간 소수 수익률. C게시: 월 표본공분산(N−1 분모)의 12배, 연 소수². 화면 C는 연 %²." },
        { expression: "σᵢ = √Cᵢᵢ;  Cᵢⱼ(가정) = σᵢ × ρᵢⱼ × σⱼ", legend: "ρ: 입력 또는 표본 상관계수. 수기·CMA 수정이 없으면 게시 공분산을 ×10,000 단위 변환만 하여 사용." }
      ],
      code: [
        "levels ← completed_month_end_levels()",
        "convert_USD_assets_to_KRW(levels)",
        "returns ← common_asset_monthly_returns(levels)",
        "window ← selected_published_window(returns)",
        "mu ← applied_scenario_else_key_in_else_published_CMA_else_sample_mean(window)",
        "baseC ← decimal_squared_to_percent_squared(window.cov)",
        "C ← baseC",
        "if scenario_or_manual_sigma_or_corr: C ← covariance_from_sigma_corr()",
        "validate_finite_inputs_and_PSD_correlation(C)",
        "return_portfolio_model(window, mu, C)"
      ].join("\n"),
      note: "국내시가·국내장부·해외시가·해외장부·국내주식·해외주식·대체투자 7축. 적용 CMA는 수기 μ·σ에 우선하며 해제하면 수기로 복귀. 해외장부 원천 헤지 상태 미검증으로 추가 헤지 제외. 평균은 산술 연환산, 10년 참고값은 공통 공분산에 섞지 않음.",
      sources: [
        { path: "pipeline/port.py", symbols: ["_me_levels", "_stats", "build"] },
        { path: "dashboard/app.js", symbols: ["portRiskInputs", "portModelInputs"] }
      ]
    },
    {
      id: "cma-scenarios",
      title: "CMA · 낙관·중립·비관",
      formulas: [
        { expression: "μᵢ = Σₛpᵢₛμᵢₛ;  Σₛpᵢₛ = 1", legend: "s: 낙관·중립·비관. 입력 확률(%)을 100으로 나눈 p, μ는 추가 환헤지 전 원화 기준 연 %. 자산별 확률 합계 100%일 때 적용." },
        { expression: "σᵢ² = Σₛpᵢₛ[σᵢₛ² + (μᵢₛ − μᵢ)²]", legend: "총분산: 시나리오 내부 분산과 시나리오 평균 차이의 분산을 합산. σ는 연 %, 공분산 계산에는 기존 자산 간 ρ를 유지." }
      ],
      code: [
        "draft ← asset_optimistic_neutral_pessimistic_inputs()",
        "draft.pessimistic_probability ← 100 - optimistic_probability - neutral_probability",
        "require_finite_probability_mean_sigma(draft)",
        "require_nonnegative_probability_sigma_and_probability_sum_100(draft)",
        "mu, sigma ← mixture_mean_and_total_variance(draft)",
        "on_apply: persist_valid_draft_as_applied_asset_assumption()",
        "if enabled: replace_asset_mu_sigma_and_retain_correlation()",
        "else: restore_underlying_manual_or_published_inputs()",
        "apply_existing_hedge_after_unhedged_CMA()",
        "show_applied_scenarios_on_allocation_asset_label_hover()"
      ].join("\n"),
      note: "비관 확률은 잔여값으로 자동 산출하며 낙관·중립 합계 100% 초과·빈칸은 적용 불가. 초안과 적용값은 분리 저장. 접힌 카드는 초안 μ·σ와 자산별 120개월 연환산 참고 μ·σ를 표시하며 표본 부족은 공란. 초기 25/50/25%는 편집 시작값. 자산별 주변분포 가정이며 공통 거시 상태·자산 간 독립성을 뜻하지 않음.",
      sources: [
        { path: "dashboard/cma.js", symbols: ["cmaSyncDraftProbability", "cmaMoments", "cmaAssetAssumption", "renderCma", "cmaAssetLabel"] },
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
        "on_update: validate_all_draft_inputs_and_commit_applied_snapshot()",
        "model ← validated_mu_and_covariance(applied_snapshot)",
        "bounds ← validate_group_min_max_and_asset_floors()",
        "enumerate_affine_faces_of_feasible_portfolios(model, bounds)",
        "for theta in frontier_grid_plus_minimum_variance:",
        "  candidate ← solve_each_feasible_face(theta)",
        "  certify_dual_gap_over_feasible_vertices(candidate)",
        "  keep_best_certified_candidate(candidate)",
        "frontier ← remove_dominated_points(candidates)",
        "compare_weight1_weight2_and_60_40_benchmark(frontier)"
      ].join("\n"),
      note: "하단 입력은 업데이트 시 검증·저장하고 경계선·비교·리스크 연계에 함께 반영. 제약조건 적용은 검증 후 업데이트 대기. 축·팔레트는 마지막 업데이트 결과를 다시 표시. 비중1/비중2는 각각 합계 100%를 검사하고 제약 밖도 비교용으로 표시. 비중합 오류·불가능한 제약·유효하지 않은 입력이면 마지막 업데이트 결과 유지.",
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
      note: "CMA의 사용자 낙관·중립·비관 입력과 별개의 평균 불확실성 경계선이며 통계적 신뢰구간이 아님. 두 경계선의 최적 비중은 서로 다를 수 있음.",
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
        { expression: "cᵢ(가정) = cᵢ(과거) × σᵢ(가정) / σᵢ(과거)", legend: "수기·CMA 변동성 수정 시 과거 자산·환율 상관 유지. 과거 σ가 0이면 cᵢ=0." }
      ],
      code: [
        "h ← enabled_USD_asset_hedge_ratios()",
        "if no_positive_ratio(h): return unhedged_inputs",
        "require_same_window_FX_moments_and_HP_cost()",
        "cross, variance ← decimal_squared_to_percent_squared(FX_moments)",
        "cross ← rescale_asset_FX_covariance_if_manual_or_CMA(cross)",
        "require_PSD_joint_asset_FX_matrix(cross)",
        "muH, CH ← apply_hedge_return_and_covariance(h)",
        "require_PSD_adjusted_covariance(CH)",
        "compare_unhedged_and_hedged_frontiers(muH, CH)"
      ].join("\n"),
      note: "CMA 적용 뒤 헤지 대상 자산의 기존 환헤지를 반영. 해외장부는 원천 헤지 상태가 미검증되어 추가 헤지 제외. 월초 명목액 고정·기대 환율변화 0·비용 확정값 가정이며 표준편차를 직접 차감하지 않음.",
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
