/* Keep this handoff synchronized with the implementation named in sources. */
globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.alloc = {
  id: "alloc",
  title: "자산배분",
  updated: "2026-10-12",
  summary: "SAA 제약·TAA 입력 시나리오 → Baseline·비중1/비중2 비교 → 리스크 연계 비중",
  inputs: "월말 지수·USDKRW, 연 μ·σ(%), CMA 시나리오 확률(%), 상관계수, h(0~1), 그룹 최소·최대(%), 자산별 최소(%). 공분산은 게시 소수² → 계산 %²(×10,000)",
  outputs: "포트폴리오 μ·σ, Baseline, 선택 Conservative·Optimistic, 현재·잠재 리스크 연계 비중",
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
      note: "비관 확률은 잔여값으로 자동 산출하며 낙관·중립 합계 100% 초과·빈칸은 적용 불가. 초안과 적용값은 분리 저장. 변동성 입력은 0.01 단위·두 자리 표시이며 기존 저장 원정밀도는 유지. 접힌 카드는 초안 μ·σ와 자산별 120개월 연환산 참고 μ·σ를 표시하며 표본 부족은 공란. 초기 25/50/25%는 편집 시작값. 자산별 주변분포 가정이며 공통 거시 상태·자산 간 독립성을 뜻하지 않음.",
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
        "on_tab_switch: retain_SAA_TAA_drafts_without_changing_results()",
        "alternative_weight_pct ← 100 - sum(other_asset_weights_pct)",
        "on_update: validate_active_SAA_TAA_pair_and_commit_applied_snapshot()",
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
      note: "SAA(현재/SAA 1/SAA 2)는 그룹·개별 제약, TAA(현재/TAA 1/TAA 2)는 비중1/비중2·μ/σ·상관·헤지를 별도 보존. 기간과 적용 CMA는 공통. 탭 선택은 초안이며 업데이트 시 활성 SAA/TAA 쌍만 검증·저장하여 경계선·비교·리스크 연계에 반영. 비활성 초안은 메모리에 보존하며 저장값 복원/새로고침 시 폐기. 각 비중열의 대체투자는 100%에서 다른 자산 비중 합계를 뺀 자동값이며 음수·빈칸·범위 오류는 업데이트 거부. SAA 최소·최대 한도는 자동 잔여 배분 대상이 아님. 불가능 제약·입력 오류는 마지막 결과 유지.",
      sources: [
        { path: "dashboard/app.js", symbols: ["portRobustModel", "portFrontiers", "portContributions", "portEngine"] }
      ]
    },
    {
      id: "summary-cards",
      title: "요약카드 · 입력 3안·최적화 3안·담당자 묶음",
      formulas: [
        { expression: "Min volatility: min wᵀCw;  Target Return: min wᵀCw, μᵀw = 4.0", legend: "같은 적용 입력·환헤지·그룹 및 개별 제약 사용. μ 단위는 연 %. 4.0% 정확 목표가 불가능하면 해당 카드의 결과를 보류." },
        { expression: "Max Sharpe Ratio: max (μᵀw − r𝒇) / √(wᵀCw)", legend: "기존 자산배분 최대 샤프 해를 공유. r𝒇는 기존 엔진의 국내장부(구 원화유동성) 기대수익 입력으로 별도 무위험 수익률 추정치가 아님." },
        { expression: "1년 수익률 범위 = m(w) ± Φ⁻¹((1+p)/2) × σ(w);  α = 1 − p", legend: "정규분포 가정의 중앙 포함확률 p=68·90·95·99%. μ·σ 모두 연 %, 표준오차나 표본수로 축소하지 않음. 양측 이탈확률 α=32·10·5·1%." }
      ],
      code: [
        "input_cards ← evaluate_saved_TAA_slots(current, taa1, taa2, weight_1, common_period, applied_CMA)",
        "model ← portfolio_engine(last_applied_inputs)",
        "cards ← input_cards + [minimum_variance, minimum_variance_at_exact_return(4.0), maximum_sharpe]",
        "validate_feasibility_and_finite_moments(cards)",
        "display_weights ← integer_percent_by_largest_remainders(original_weights)",
        "show_all_assets_and_total_100_without_changing_original_weights()",
        "show_mu_sigma_from_original_weights_with_two_decimals()",
        "ranges ← central_normal_return_ranges(mu, sigma, probabilities=[0.68, 0.90, 0.95, 0.99])",
        "show_two_decimal_ranges_between_moments_and_weights()",
        "if sigma_is_zero: label_degenerate_return_with_model_probability_100()",
        "on_explicit_save: freeze_six_cards_assets_original_weights_moments_ranges_and_context_into_owner_bundle()",
        "on_owner_or_bundle_select: display_saved_snapshot_without_changing_portfolio_inputs()"
      ].join("\n"),
      note: "현재/TAA 1/TAA 2는 각 저장 슬롯의 비중1·기대수익·변동성·상관·헤지를 사용하고 최적화 3안은 마지막 적용 SAA/TAA를 사용. 기간·적용 CMA는 공통이며 미적용 초안은 제외. 입력 포트폴리오는 SAA 최적화 가능성과 별도로 평가하며 비중을 보정하지 않음. 현재 입력의 CMA 적용/해제는 즉시 반영하지만 담당자 A/B/C의 저장 묶음은 명시적 갱신 전까지 고정. 담당자 이름·선택·복수 묶음은 iaw-summary-groups-v1에 브라우저별 저장되며 계정 간 공유 기능은 아님. 저장 실패·손상은 기존 저장값 보존. 범위는 평균 추정의 신뢰구간이나 실증 검증된 달성확률이 아님. 정확한 중앙 68% 분위수를 쓰며 1σ(약68.27%)로 대체하지 않음. 음의 하단은 보존하고 불가능 목표·결측·음수 변동성은 범위를 표시하지 않음. σ=0이면 모든 범위가 μ로 수렴(모형상100%). 카드 클릭은 상세 열기이며 입력 비중을 변경하지 않음. 정수 표시는 표시용이라 원비중의 소수 제약 및 정확 목표를 그대로 재현하지 않을 수 있음.",
      sources: [
        { path: "dashboard/app.js", symbols: ["portEngine", "portSummaryWeights", "portSummaryReturnRanges", "portSummaryResults", "portSummaryBundle", "summaryGroupsRead", "summaryGroupControls", "renderSummaryCards"] },
        { path: "dashboard/port-constraints.js", symbols: ["portConstrainedModel"] }
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
        "draw_baseline_without_mean_uncertainty_adjustment()",
        "draw_only_checked_scenarios_and_interpolate_valid_segments()"
      ].join("\n"),
      note: "CMA의 사용자 낙관·중립·비관 입력과 별개의 평균 불확실성 경계선이며 통계적 신뢰구간이 아님. 두 경계선의 최적 비중은 서로 다를 수 있음. Baseline은 평균 불확실성 가산/차감이 없는 기본 경계선. 두 추가 경계선 체크는 초기 해제이며 표시 선택은 금융 입력을 바꾸지 않음. 적용된 CMA 가정은 Baseline에도 공통 사용.",
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
