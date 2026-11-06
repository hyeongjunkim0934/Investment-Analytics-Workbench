/* Maintained handoff: definitions, assumptions, exceptions and checks follow the referenced implementation. */
globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.alloc = {
  "id": "alloc",
  "title": "자산배분",
  "updated": "2026-11-06",
  "summary": "표본·적용 입력 확정 → CMA 합성 → 환헤지 조정 → SAA 제약 최적화 → 목표·요약카드 → 리스크 연계. 같은 입력 스냅숏을 기준으로 대안을 비교한다. 레퍼런스 포트폴리오는 별도 공통표본의 과거 모멘트를 비교한다.",
  "inputs": "월말 지수·USDKRW, 연 μ·σ(%), CMA 시나리오 확률(%), 상관계수, h(0~1), 그룹 최소·최대(%), 자산별 최소(%). 공분산은 게시 소수² → 계산 %²(×10,000)",
  "outputs": "포트폴리오 μ·σ, Baseline, 선택 Conservative·Optimistic, 현재·잠재 리스크 연계 비중; 레퍼런스 예시·직접비중의 과거 평균·변동성·CD 대비 샤프 근사·위험기여",
  "readingGuide": [
    "입력의 원천·기간·단위와 초안/적용 상태를 먼저 고정한다.",
    "CMA 이후 환헤지를 반영한 μ·C와 SAA 제약을 공통 입력으로 경계선·목표·카드를 계산한다.",
    "리스크 연계는 현재 μ·C를 고정한 민감도 분석이다. 과거 시점의 실제 운용성과와 분리해서 전달한다.",
    "레퍼런스 포트폴리오는 별도 과거 표본 비교이며 기존 SAA/TAA/CMA 입력을 바꾸지 않는다."
  ],
  "sources": [
    {
      "path": "dashboard/port-constraints.js",
      "symbols": [
        "portConstraintSpec",
        "portConstrainedModel"
      ]
    },
    {
      "path": "pipeline/port.py",
      "symbols": [
        "build",
        "_stats",
        "_fx_stats",
        "_hedge_cost"
      ]
    },
    {
      "path": "dashboard/cma.js",
      "symbols": [
        "cmaMoments",
        "cmaAssetAssumption",
        "renderCma",
        "cmaAssetLabel"
      ]
    },
    {
      "path": "dashboard/cma-upload.js",
      "symbols": [
        "cmaReadUpload",
        "cmaImportRows",
        "cmaParseWorkbook",
        "cmaUploadNumber"
      ]
    },
    {
      "path": "dashboard/app.js",
      "symbols": [
        "portRiskInputs",
        "portModelInputs",
        "portRobustModel",
        "portFrontiers",
        "portHedgeInputs",
        "allocRiskObservations",
        "allocRiskOptimize"
      ]
    }
  ],
  "sections": [
    {
      "id": "estimates",
      "title": "표본·입력",
      "formulas": [
        {
          "expression": "rₜ = Pₜ / Pₜ₋₁ − 1;  Pₜ(KRW) = Pₜ(USD) × USDKRWₜ",
          "legend": "P: 월말 지수. 해외시가·해외주식·대체투자는 원화 환산. 해외장부는 bm:장부가 해외채권의 원화 지수를 그대로 사용.",
          "latex": "r_t=\\frac{P_t}{P_{t-1}}-1,\\qquad P_t^{\\mathrm{KRW}}=P_t^{\\mathrm{USD}}S_t"
        },
        {
          "expression": "μ̂ = 100 × 12 × 평균(r);  C = 10,000 × C게시",
          "legend": "r: 월간 소수 수익률. C게시: 월 표본공분산(N−1 분모)의 12배, 연 소수². 화면 C는 연 %².",
          "latex": "\\hat{\\mu}=100\\cdot12\\,\\overline r,\\qquad C=10{,}000\\,C_{\\mathrm{published}}"
        },
        {
          "expression": "σᵢ = √Cᵢᵢ;  Cᵢⱼ(가정) = σᵢ × ρᵢⱼ × σⱼ",
          "legend": "ρ: 입력 또는 표본 상관계수. 수기·CMA 수정이 없으면 게시 공분산을 ×10,000 단위 변환만 하여 사용.",
          "latex": "\\sigma_i=\\sqrt{C_{ii}},\\qquad C_{ij}^{\\mathrm{assumed}}=\\sigma_i\\rho_{ij}\\sigma_j"
        }
      ],
      "code": "levels ← completed_month_end_levels()\nconvert_USD_assets_to_KRW(levels)\nreturns ← common_asset_monthly_returns(levels)\nwindow ← selected_published_window(returns)\nmu ← applied_scenario_else_key_in_else_published_CMA_else_sample_mean(window)\nbaseC ← decimal_squared_to_percent_squared(window.cov)\nC ← baseC\nif scenario_or_manual_sigma_or_corr: C ← covariance_from_sigma_corr()\nvalidate_finite_inputs_and_PSD_correlation(C)\nreturn_portfolio_model(window, mu, C)",
      "note": "평균은 월간 산술평균의 12배다. 복리수익률이나 실현 가능한 장기 기대수익률로 바꾸어 설명하지 않는다.",
      "sources": [
        {
          "path": "pipeline/port.py",
          "symbols": [
            "_me_levels",
            "_stats",
            "build"
          ]
        },
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portRiskInputs",
            "portModelInputs"
          ]
        }
      ],
      "purpose": "자산별 원화 수익률과 공통 표본을 확정하고, 게시 통계·수기 입력·적용 CMA 중 실제 계산에 쓰일 값을 정한다.",
      "decisions": [
        "7개 자산의 동시 관측 월을 사용한다. _me_levels는 달력 월말 라벨보다 원천 최종일이 이르면 마지막 월을 제외하므로 최신 표본 종료월을 함께 확인한다.",
        "기대수익률 우선순위는 적용된 CMA 시나리오 → 수기 입력 → 게시 CMA 파일 → 과거 평균이다. 변동성은 적용 CMA → 수기 → 게시 공분산에서 계산한 값이다.",
        "공분산 입력은 연 소수²이고 화면 엔진은 연 %²를 사용한다. 수기·CMA 변동성이나 상관 수정이 없으면 게시 공분산에 단위 변환만 적용한다.",
        "해외시가·해외주식·대체투자는 USD 지수를 원화 환산하고, 해외장부는 원화 BM을 그대로 사용한다. 자산별 10년 참고 통계는 공통 공분산의 대체재가 아니다."
      ],
      "checks": [
        "원본 연 소수² 공분산에 10,000을 곱하면 표준편차가 100배가 되는지 대조한다.",
        "변동성 음수·비유한 값과 불가능한 상관 조합에서 계산이 중단되는지 확인한다. PSD 허용오차는 검사에만 쓰고 입력 행렬을 조용히 수정하지 않는다.",
        "각 계산 결과에 자산 순서·기간·N·기대수익 원천을 연결해 같은 창을 재현한다."
      ]
    },
    {
      "id": "cma-scenarios",
      "title": "CMA · 낙관·중립·비관",
      "formulas": [
        {
          "expression": "μᵢ = Σₛpᵢₛμᵢₛ;  Σₛpᵢₛ = 1",
          "legend": "s: 낙관·중립·비관. 입력 확률(%)을 100으로 나눈 p, μ는 추가 환헤지 전 원화 기준 연 %. 자산별 확률 합계 100%일 때 적용.",
          "latex": "\\mu_i=\\sum_sp_{is}\\mu_{is},\\qquad\\sum_sp_{is}=1"
        },
        {
          "expression": "σᵢ² = Σₛpᵢₛ[σᵢₛ² + (μᵢₛ − μᵢ)²]",
          "legend": "총분산: 시나리오 내부 분산과 시나리오 평균 차이의 분산을 합산. σ는 연 %, 공분산 계산에는 기존 자산 간 ρ를 유지.",
          "latex": "\\sigma_i^2=\\sum_sp_{is}\\!\\left[\\sigma_{is}^2+(\\mu_{is}-\\mu_i)^2\\right]"
        }
      ],
      "code": "draft ← asset_optimistic_neutral_pessimistic_inputs()\ndraft.pessimistic_probability ← 100 - optimistic_probability - neutral_probability\nrequire_finite_probability_mean_sigma(draft)\nrequire_nonnegative_probability_sigma_and_probability_sum_100(draft)\nmu, sigma ← mixture_mean_and_total_variance(draft)\non_excel_upload: validate_all_rows_percent_units_and_existing_probabilities()\non_valid_upload: replace_imported_draft_mu_sigma_preserving_probabilities_and_applied_state()\non_asset_button: apply_only_that_asset_and_enable_CMA()\nif enabled: replace_asset_mu_sigma_and_retain_correlation()\nelse: restore_underlying_manual_or_published_inputs()\napply_existing_hedge_after_unhedged_CMA()\nshow_applied_scenarios_on_allocation_asset_label_hover()",
      "note": "접힌 카드의 현재 입력 요약과 자산배분의 적용값은 다를 수 있다. CMA Upload는 입력을 채우며 카드 우측 자산배분 모듈에 반영 버튼이 해당 자산만 적용한다. 내부 draft/applied 분리는 유지하지만 화면의 미적용 초안 문구는 표시하지 않는다.",
      "sources": [
        {
          "path": "dashboard/cma.js",
          "symbols": [
            "cmaSyncDraftProbability",
            "cmaMoments",
            "cmaAssetAssumption",
            "renderCma",
            "cmaAssetLabel"
          ]
        },
        {
          "path": "dashboard/cma-upload.js",
          "symbols": [
            "cmaReadUpload",
            "cmaImportRows",
            "cmaParseWorkbook",
            "cmaUploadNumber"
          ]
        },
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portRiskInputs",
            "portModelInputs"
          ]
        }
      ],
      "purpose": "사용자가 설정한 세 시나리오를 자산별 평균과 총분산으로 합성하고, 명시적으로 적용한 값만 자산배분 엔진에 전달한다.",
      "decisions": [
        "비관 확률은 100−낙관−중립이다. 빈칸·음수 확률·음수 변동성·합계 100% 위반은 적용을 거부하며 유효성 검사는 확률 0인 행에도 수행한다.",
        "총분산에는 각 시나리오 내부 분산과 시나리오 평균 차이의 분산이 모두 들어간다. 변동성의 단순 가중평균으로 바꾸지 않는다.",
        "초안과 적용값은 별도 저장하며 활성화된 적용값만 수기 입력보다 우선한다. 해제하면 기존 수기 또는 게시 입력으로 복귀하고, 환헤지는 이 단계 뒤에 적용한다.",
        "자산별 주변분포와 기존 자산 간 상관을 조합한다. 동일 이름의 낙관 시나리오가 모든 자산에 공통으로 실현된다는 결합분포 가정은 구현되어 있지 않다.",
        "기대수익률·변동성은 신규 편집 시 0.01 단위로 양자화하고 두 자리로 표시한다. 기존 저장값은 편집 전까지 원정밀도를 유지한다.",
        "CMA Upload는 5MB 이하 XLSX/XLS를 브라우저에서 읽는다. 모든 행·기존 확률을 검증한 뒤 대상 자산의 세 시나리오에 동일 μ·σ를 입력하며 기존 확률·applied·enabled를 유지한다. 한 오류라도 있으면 전체 교체를 보류한다.",
        "일반 숫자 4.12와 문자 4.12%는 연 4.12%다. Excel 숫자 0.0412에 백분율 서식이 있으면 100배 변환한다. 일반 서식 0.0412는 연 0.0412%로 읽고 두 자리로 반올림한다. 수치 크기로 단위를 추측하지 않는다.",
        "수식·날짜·오류·불리언 셀, 중복·미등록 자산, 중복 필수 열을 거부한다. 음수 σ는 반올림 전에 거부하며 CMA 시트 우선·1,000행·64열 제한을 따른다. 저장 실패는 알리고 현재 메모리 상태는 유지한다."
      ],
      "checks": [
        "모든 시나리오 평균이 같으면 시나리오 간 분산이 0인지 확인한다. 하나의 확률이 100%이면 그 행의 평균·변동성이 복원되어야 한다.",
        "초안 편집만으로 경계선이 달라지지 않고 적용/해제 시 입력 우선순위가 정확히 전환되는지 확인한다.",
        "초기 25/50/25%는 편집 시작값이며 추정된 확률이 아님을 유지한다. 저장 원정밀도와 화면 두 자리 표시를 구분한다.",
        "일반 숫자 4.12와 백분율 서식 0.0412가 동일하게 읽히는지, −0.001 변동성이 0으로 허용되지 않는지 확인한다.",
        "한 행 오류에서 모든 기존 입력·적용값이 유지되는지 확인한다. 정상 업로드만으로 적용값은 변하지 않고 한 자산 버튼을 누르면 해당 자산만 적용되어야 한다."
      ]
    },
    {
      "id": "hedge-overlay",
      "title": "환헤지 반영",
      "formulas": [
        {
          "expression": "rᴴᵢ = rᵁᵢ − hᵢe;  μᴴᵢ = μᵁᵢ + hᵢk",
          "legend": "e: USDKRW 월 수익률. h: 헤지비중. k: 최신 HP 3M·6M·12M 단순평균(연 %, 양수 수취·음수 지급).",
          "latex": "r_i^H=r_i^U-h_ie,\\qquad\\mu_i^H=\\mu_i^U+h_ik"
        },
        {
          "expression": "Cᴴᵢⱼ = Cᵁᵢⱼ − hᵢcⱼ − hⱼcᵢ + hᵢhⱼv",
          "legend": "cᵢ: 자산·환율 연 공분산, v: 환율 연 분산. 게시 fx.cov_asset·fx.var(소수²)를 ×10,000 하여 %²로 통일. 자산과 같은 월 표본.",
          "latex": "C_{ij}^H=C_{ij}^U-h_ic_j-h_jc_i+h_ih_jv"
        },
        {
          "expression": "cᵢ(가정) = cᵢ(과거) × σᵢ(가정) / σᵢ(과거)",
          "legend": "수기·CMA 변동성 수정 시 과거 자산·환율 상관 유지. 과거 σ가 0이면 cᵢ=0.",
          "latex": "c_i^{\\mathrm{assumed}}=\\begin{cases}c_i^{\\mathrm{hist}}\\dfrac{\\sigma_i^{\\mathrm{assumed}}}{\\sigma_i^{\\mathrm{hist}}}&\\sigma_i^{\\mathrm{hist}}>0\\\\0&\\sigma_i^{\\mathrm{hist}}=0\\end{cases}"
        }
      ],
      "code": "h ← enabled_USD_asset_hedge_ratios()\nif no_positive_ratio(h): return unhedged_inputs\nrequire_same_window_FX_moments_and_HP_cost()\ncross, variance ← decimal_squared_to_percent_squared(FX_moments)\ncross ← rescale_asset_FX_covariance_if_manual_or_CMA(cross)\nrequire_PSD_joint_asset_FX_matrix(cross)\nmuH, CH ← apply_hedge_return_and_covariance(h)\nrequire_PSD_adjusted_covariance(CH)\ncompare_unhedged_and_hedged_frontiers(muH, CH)",
      "note": "헤지 후 변동성은 전체 공분산에서 다시 계산한다. 자산 변동성에서 환율 변동성을 직접 빼면 다른 계산이 된다.",
      "sources": [
        {
          "path": "pipeline/port.py",
          "symbols": [
            "_fx_stats",
            "_hedge_cost"
          ]
        },
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portHedgeInputs",
            "portModelInputs"
          ]
        }
      ],
      "purpose": "원화 기준 미헤지 자산의 환위험을 고정 명목액 헤지로 조정한다. 기대수익률과 공분산을 같은 헤지비율로 일관되게 변환한다.",
      "decisions": [
        "대상 USD 자산의 비율만 사용한다. 해외장부는 원천 환노출 상태가 미검증되어 추가 헤지 대상에서 제외한다.",
        "양의 헤지비율이 있으면 자산과 동일한 월 표본의 환율 공분산 및 실측 USD HP 세 만기의 비용이 모두 필요하다. 누락 비용을 0이나 금리차로 대체하지 않는다.",
        "수기·CMA 변동성 변경 시 과거 자산/환율 상관이 유지되도록 교차 공분산을 조정한다. 자산 행렬뿐 아니라 환율을 합친 공동 행렬의 PSD도 검사한다.",
        "월초 명목액 고정·기대 환율변화 0·현재 캐리 확정값을 가정한다. 헤지 모델 B/C의 선택비율이 자동으로 여기 입력되는 구조는 아니다."
      ],
      "checks": [
        "모든 헤지비율이 0이면 미헤지 평균·공분산이 그대로 반환되는지 확인한다.",
        "순수 환율 자산을 100% 헤지하는 경계에서 환위험이 상쇄되는지, 일반 자산에서는 공분산 때문에 위험이 반드시 감소하지 않을 수 있음을 확인한다.",
        "음수 HP는 기대수익률을 낮추고 양수 HP는 높이는지 확인한다. 자산·FX 표본의 시작/끝/N이 일치해야 한다."
      ]
    },
    {
      "id": "frontier",
      "title": "포트폴리오·경계선",
      "formulas": [
        {
          "expression": "m(w) = μᵀw;  σ(w) = √(wᵀCw)",
          "legend": "w: 소수 비중. m·σ는 연 %. μ·C는 선택한 입력 가정.",
          "latex": "m(w)=\\mu^\\top w,\\qquad\\sigma(w)=\\sqrt{w^\\top Cw}"
        },
        {
          "expression": "w*(θ) = argmax [μᵀw − θ × wᵀCw / 2];  wᵢ ≥ 0,  Σᵢwᵢ = 1",
          "legend": "θ≥0: 경계선 탐색 계수. % 단위 목적함수이며 리스크 연계 λ와 스케일이 다름.",
          "latex": "w^*(\\theta)=\\underset{w\\in\\mathcal W}{\\arg\\max}\\!\\left[\\mu^\\top w-\\frac{\\theta}{2}w^\\top Cw\\right],\\qquad\\theta\\ge0"
        },
        {
          "expression": "Lɡ ≤ Σᵢ∈ɡ wᵢ ≤ Uɡ;  wᵢ ≥ lᵢ",
          "legend": "Lɡ·Uɡ: 주식·채권·대체 그룹 최소·최대. lᵢ: 개별자산 최소. 입력 %를 100으로 나눈 소수 비중.",
          "latex": "\\mathcal W=\\left\\{w:\\;\\sum_iw_i=1,\\;w_i\\ge\\max(0,l_i),\\;L_g\\le\\sum_{i\\in g}w_i\\le U_g\\right\\}"
        },
        {
          "expression": "수익기여ᵢ = 100 × wᵢμᵢ / m(w);  위험기여ᵢ = 100 × wᵢ(Cw)ᵢ / (wᵀCw)",
          "legend": "호버 기여도(%). 분모가 0에 가까우면 표시 보류; 음의 기여도도 가능.",
          "latex": "\\mathrm{RC}_i=100\\frac{w_i\\mu_i}{m(w)},\\qquad\\mathrm{VC}_i=100\\frac{w_i(Cw)_i}{w^\\top Cw}"
        }
      ],
      "code": "on_tab_switch: retain_SAA_TAA_drafts_without_changing_results()\nalternative_weight_pct ← 100 - sum(other_asset_weights_pct)\non_update: validate_active_SAA_TAA_pair_and_commit_applied_snapshot()\nmodel ← validated_mu_and_covariance(applied_snapshot)\nbounds ← validate_group_min_max_and_asset_floors()\nenumerate_affine_faces_of_feasible_portfolios(model, bounds)\nfor theta in frontier_grid_plus_minimum_variance:\n  candidate ← solve_each_feasible_face(theta)\n  certify_dual_gap_over_feasible_vertices(candidate)\n  keep_best_certified_candidate(candidate)\nfrontier ← remove_dominated_points(candidates)\ncompare_weight1_weight2_and_60_40_benchmark(frontier)",
      "note": "경계선 탐색 계수 θ와 리스크 연계 λ는 수익률 단위가 다르다. 같은 숫자를 그대로 교환하면 위험회피 강도가 달라진다.",
      "sources": [
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portRobustModel",
            "portFrontiers",
            "portContributions",
            "portEngine"
          ]
        }
      ],
      "purpose": "적용된 입력과 SAA 제약 안에서 위험·수익의 선택 가능 집합을 계산한다. 사용자의 현재 비중과 최적해의 역할을 구분한다.",
      "decisions": [
        "SAA는 그룹 최소·최대와 개별자산 최소 제약이다. TAA는 비교 비중·평균·변동성·상관·헤지 입력을 보관한다. 탭 선택은 초안이며 업데이트 시 활성 SAA/TAA 쌍만 적용한다.",
        "현재/비교 포트폴리오의 대체투자 비중은 100%에서 다른 비중 합계를 차감해 표시한다. 음수 잔여나 불가능 제약은 업데이트를 거부하고 마지막 결과를 유지한다.",
        "제약 다면체의 가능한 면을 열거해 후보를 계산하고 목적함수의 최적성 허용오차를 검사한다. 단순 난수 점군을 최적 경계선의 근거로 사용하지 않는다.",
        "수익/위험 기여도의 분모가 0에 가까우면 표시를 보류하고 음의 기여도는 보존한다. 기여도는 인과적 기여효과가 아니다."
      ],
      "checks": [
        "최소제약 합이 100%를 넘거나 최대제약 합이 100%에 못 미치면 적용을 거부하는지 확인한다.",
        "각 해가 합계 1·공매도 금지·개별 최소·그룹 최소/최대 조건을 만족하는지 확인한다.",
        "2자산의 직접 격자/해석 해 및 KKT 조건과 대조하고, 입력 오류 때 이전 적용 스냅숏이 보존되는지 확인한다."
      ]
    },
    {
      "id": "scenarios",
      "title": "Conservative·Optimistic",
      "formulas": [
        {
          "expression": "a = κ × √(12 / N);  m₋(w) = μᵀw − aσ(w);  m₊(w) = μᵀw + aσ(w)",
          "legend": "N: 선택 표본의 월수. 현재 화면 κ=1. 평균 불확실성의 역사적 크기를 가정.",
          "latex": "a=\\kappa\\sqrt{\\frac{12}{N}},\\qquad m_{\\pm}(w)=\\mu^\\top w\\pm a\\sigma(w)"
        },
        {
          "expression": "Conservative: argmax [m₋(w) − θσ(w)² / 2]",
          "legend": "같은 그룹·개별 최소 제약, 공매도 금지·합계 100% 조건에서 하단 수익 시나리오를 최적화.",
          "latex": "w_-^*(\\theta)=\\underset{w\\in\\mathcal W}{\\arg\\max}\\!\\left[m_-(w)-\\frac{\\theta}{2}\\sigma^2(w)\\right]"
        },
        {
          "expression": "Optimistic(s): max μᵀw + a × s,  단 σ(w)=s",
          "legend": "위험 s별로 가능한 최고 평균을 계산하고 지배되는 점을 제거.",
          "latex": "m_+^*(s)=\\underset{w\\in\\mathcal W,\\,\\sigma(w)=s}{\\max}\\!\\left[\\mu^\\top w+as\\right]"
        }
      ],
      "code": "a ← scenario_scale(month_count, kappa=1)\nconservative ← solve_lower_mean_frontier(a)\nfor risk in sampled_risk_levels:\n  w ← maximum_mean_at_fixed_risk(risk)\n  optimistic.add(upper_mean(w, a))\ninclude_vertices_and_frontier_endpoints()\nremove_dominated_points_without_bridging_gaps()\ndraw_baseline_without_mean_uncertainty_adjustment()\ndraw_only_checked_scenarios_and_interpolate_valid_segments()",
      "note": "CMA의 낙관·중립·비관 시나리오와 이 경계선의 평균 불확실성 가정을 별도로 관리한다.",
      "sources": [
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portDefaults",
            "portState",
            "portRobustModel",
            "portFrontiers"
          ]
        }
      ],
      "purpose": "기본 평균 추정의 불확실성 크기를 별도 가정하여 경계선이 어떻게 달라지는지 살펴본다.",
      "decisions": [
        "현재 κ=1이며 선택 표본 월수 N으로 평균 불확실성 크기를 조정한다. 통계적 신뢰구간의 포함확률을 추정한 절차는 아니다.",
        "Conservative는 하단 평균으로 최적화한다. Optimistic은 위험 수준을 고정한 상태에서 가능한 최대 평균을 구하고 상방 조정을 더하므로 두 경계의 비중은 다를 수 있다.",
        "기본 Baseline과 두 추가 경계는 같은 적용 CMA를 쓴다. 추가 경계의 체크 여부는 표시 선택이고 금융 입력이나 적용값을 바꾸지 않는다."
      ],
      "checks": [
        "κ=0에서 추가 평균 조정이 사라지는지 확인한다.",
        "N이 커지면 조정 크기가 1/√N에 비례해 줄어드는지 확인한다.",
        "지배되는 점을 제거하면서 불가능 구간을 선으로 연결하지 않는지 확인한다."
      ]
    },
    {
      "id": "target-return-ladder",
      "title": "Target Return · 5개 목표 비교",
      "formulas": [
        {
          "expression": "rⱼ = r중심 + 0.5j, j ∈ {−2, −1, 0, 1, 2}",
          "legend": "연 기대수익률 % 단위, 카드 간격 0.5%p. 중심 기본값 4.0%.",
          "latex": "r_j=r_0+0.5j,\\qquad j\\in\\{-2,-1,0,1,2\\}"
        },
        {
          "expression": "min wᵀCw, μᵀw = rⱼ, Σw = 1, w ∈ 적용 SAA 제약",
          "legend": "각 정확 목표에서 최소분산 비중. GMV보다 낮은 목표도 가능 범위 안이면 계산.",
          "latex": "w_j^*=\\underset{w\\in\\mathcal W,\\,\\mu^\\top w=r_j}{\\arg\\min}\\;w^\\top Cw"
        }
      ],
      "code": "inputs ← last_applied_TAA_CMA_hedge_and_SAA()\nmodel ← exact_return_model(inputs)\non_center_apply: validate_number_and_commit_center()\nfor target in center_plus_offsets: solve_exact_return_minimum_variance(model, target)\nif infeasible: show_unavailable_without_weights()\nelse: show_annual_moments_and_asset_weights()",
      "note": "표시용 두 자리 비중과 내부 원정밀도 비중을 구분해 전달한다.",
      "sources": [
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portTargetReturnResults",
            "renderPortPanel"
          ]
        },
        {
          "path": "dashboard/port-constraints.js",
          "symbols": [
            "portConstrainedModel"
          ]
        }
      ],
      "purpose": "사용자가 지정한 중심 목표 주변의 다섯 정확 목표를 동일한 입력·제약 아래 비교한다.",
      "decisions": [
        "중심 목표의 ±1.0·±0.5·0%p를 생성한다. 각 목표에서 기대수익을 정확히 맞추는 최소분산 문제를 풀며 GMV보다 낮은 목표도 실행 가능하면 허용한다.",
        "중심 입력의 적용 또는 Enter로 다섯 카드를 함께 갱신한다. 이 동작은 SAA/TAA 초안이나 실제 비중을 변경하지 않는다.",
        "같은 화면 세션에서는 중심값을 유지하지만 새로고침/저장값 복원 시 기본 4.0%로 초기화한다. 달성 불가 목표에는 근접한 비중을 대신 제시하지 않는다."
      ],
      "checks": [
        "계산된 원비중으로 재계산한 기대수익이 각 정확 목표와 허용오차 안에서 일치하는지 확인한다.",
        "실행 가능 범위 밖 목표는 사유와 함께 보류하고, 나머지 가능한 카드 결과는 유지하는지 확인한다.",
        "반올림 비중의 합계가 100%와 달라도 원비중의 제약 및 평균 계산이 유지되는지 확인한다."
      ]
    },
    {
      "id": "summary-cards",
      "title": "요약카드 · 5안·그룹별 카드 관리",
      "formulas": [
        {
          "expression": "Min volatility: min wᵀCw;  Target Return: min wᵀCw, μᵀw = 4.0",
          "legend": "같은 적용 입력·환헤지·그룹 및 개별 제약 사용. μ 단위는 연 %. 4.0% 정확 목표가 불가능하면 해당 카드의 결과를 보류.",
          "latex": "w_{\\mathrm{MV}}=\\underset{w\\in\\mathcal W}{\\arg\\min}\\;w^\\top Cw,\\qquad w_{4\\%}=\\underset{w\\in\\mathcal W,\\,\\mu^\\top w=4.0}{\\arg\\min}\\;w^\\top Cw"
        },
        {
          "expression": "Max Sharpe Ratio: max (μᵀw − r𝒇) / √(wᵀCw)",
          "legend": "기존 자산배분 최대 샤프 해를 공유. r𝒇는 기존 엔진의 국내장부(구 원화유동성) 기대수익 입력으로 별도 무위험 수익률 추정치가 아님.",
          "latex": "w_{\\mathrm{SR}}=\\underset{w\\in\\mathcal W}{\\arg\\max}\\;\\frac{\\mu^\\top w-r_f}{\\sqrt{w^\\top Cw}}"
        },
        {
          "expression": "1년 수익률 범위 = m(w) ± Φ⁻¹((1+p)/2) × σ(w);  α = 1 − p",
          "legend": "정규분포 가정의 중앙 포함확률 p=68·90·95·99%. μ·σ 모두 연 %, 표준오차나 표본수로 축소하지 않음. 양측 이탈확률 α=32·10·5·1%.",
          "latex": "\\mathcal I_p(w)=\\left[m(w)-\\Phi^{-1}\\!\\left(\\frac{1+p}{2}\\right)\\sigma(w),\\;m(w)+\\Phi^{-1}\\!\\left(\\frac{1+p}{2}\\right)\\sigma(w)\\right],\\quad\\alpha=1-p"
        }
      ],
      "code": "input_cards ← evaluate_saved_TAA_slots(current, taa1, taa2, weight_1, common_period, applied_CMA)\nmodel ← portfolio_engine(last_applied_inputs)\ncards ← input_cards + [minimum_variance, minimum_variance_at_exact_return(4.0), maximum_sharpe]\nvalidate_feasibility_and_finite_moments(cards)\ndisplay_weights ← integer_percent_by_largest_remainders(original_weights)\nshow_all_assets_total_100_and_two_decimal_original_mu_sigma()\nranges ← central_normal_return_ranges(mu, sigma, probabilities=[0.68, 0.90, 0.95, 0.99])\nshow_two_decimal_ranges_between_moments_and_weights_and_label_zero_sigma()\non_explicit_save: freeze_six_cards_assets_original_weights_moments_ranges_and_context_into_owner_bundle()\ndisplay_cards ← [current, TAA_from_saved_context_or_taa1, minimum_variance, target_return, maximum_sharpe]\non_group_card_add_or_delete: update_visible_types_without_changing_saved_rows()\non_group_or_bundle_select: display_selected_snapshot_or_latest_results_without_changing_portfolio_inputs()",
      "note": "입력 포트폴리오는 SAA 실행 가능성과 별도로 평가한다. 카드 범위는 실증 검증된 달성확률이나 평균 추정의 신뢰구간이 아니다.",
      "sources": [
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portEngine",
            "portSummaryWeights",
            "portSummaryReturnRanges",
            "portSummaryResults",
            "portSummaryBundle",
            "summaryGroupsRead",
            "summaryGroupControls",
            "renderSummaryCards"
          ]
        },
        {
          "path": "dashboard/port-constraints.js",
          "symbols": [
            "portConstrainedModel"
          ]
        }
      ],
      "purpose": "현재 비중과 최적화 대안을 같은 화면에서 비교하고, 특정 시점의 결과를 담당자별 그룹에 보존한다.",
      "decisions": [
        "현재/TAA 입력 카드는 각 저장 슬롯의 비중1과 해당 입력을 평가한다. 최적화 세 카드는 마지막 적용 SAA/TAA를 사용하며 적용 CMA와 기간은 공통이다.",
        "내부 저장에는 현재/TAA 1/TAA 2와 최적화 3안의 6행이 있다. 기본 화면은 현재·TAA·Min Volatility·Target Return 4.0%·Max Sharpe Ratio의 5종이며 그룹별 표시 목록만 조절한다.",
        "명시적으로 저장한 묶음은 원비중·평균·변동성·기간·적용 문맥을 고정한다. 최신 결과 갱신과 저장 묶음 갱신은 별개의 동작이며 브라우저 저장은 계정 간 공유가 아니다.",
        "수익률 범위는 정규분포 가정의 1년 수익률 범위다. 표준오차가 아니므로 √N으로 축소하지 않으며 중앙 68% 분위수를 정확히 사용한다."
      ],
      "checks": [
        "정수 비중 표시는 최대잔여법으로 합계 100%를 맞추고, 평균·변동성은 원비중으로 재계산하는지 확인한다.",
        "σ=0일 때 범위가 μ로 수렴하고 음의 하단은 보존되는지 확인한다. 목표 불가능·결측·음수 σ에서는 범위를 비운다.",
        "그룹 선택·카드 추가/삭제·상세 열기가 실제 포트폴리오 입력을 바꾸지 않는지 확인한다. 저장 실패/손상에서도 기존 저장값이 유지되어야 한다."
      ]
    },
    {
      "id": "risk-allocation",
      "title": "현재·잠재 리스크 연계",
      "formulas": [
        {
          "expression": "λₜ = b × scoreₜ;  b ∈ {1, 0.1}",
          "legend": "score: 현재 또는 잠재 리스크 점수(0~100). 기본 배율 b=1, 화면에서 ×0.1 선택 가능.",
          "latex": "\\lambda_t=b\\,\\mathrm{score}_t,\\qquad b\\in\\{1,\\,0.1\\}"
        },
        {
          "expression": "w*ₜ = argmax [μᵀw / 100 − λₜ × wᵀCw / 20,000]",
          "legend": "μ는 연 %, C는 연 %²를 소수 수익률 단위로 환산. 포트폴리오와 동일한 최소·최대 한도, w≥0, 합계 1.",
          "latex": "w_t^*=\\underset{w\\in\\mathcal W}{\\arg\\max}\\!\\left[\\frac{\\mu^\\top w}{100}-\\frac{\\lambda_t}{20{,}000}w^\\top Cw\\right]"
        }
      ],
      "code": "mu, C ← current_portfolio_inputs_including_hedge()\nfor layer in [current_risk, potential_risk]:\n  history ← selected_weekly_scores_and_latest(layer)\n  validate_score_range_and_ordered_dates(history)\n  for point in history:\n    lambda ← point.score * selected_scale\n    w ← active_set_QP(mu, C, lambda)\n    require_constraint_and_KKT_certificate(w)\n  draw_asset_weights(history)\n  delta_lambda ← adjacent_differences(selected_lambdas)\n  summarize_levels_and_changes(count, latest, mean, median, sample_std, min, max)",
      "note": "λ에 대한 비중 민감도는 현재 가정 아래의 조건부 결과다. 과거에 그 비중을 실제로 선택할 수 있었다는 뜻은 아니다.",
      "sources": [
        {
          "path": "dashboard/app.js",
          "symbols": [
            "portRiskAllocationEngine",
            "allocRiskViewState",
            "allocRiskObservations",
            "allocRiskOptimize",
            "allocRiskLambdaStats"
          ]
        }
      ],
      "purpose": "과거 위험 점수를 위험회피계수로 매핑하여, 현재의 동일한 수익·공분산·제약 아래 비중이 어떻게 달라지는지 비교한다.",
      "decisions": [
        "현재와 잠재 위험은 별도로 계산하고 λ=점수×배율을 쓴다. 기본 배율 1과 선택 배율 0.1은 설계 입력이며 손실확률이나 추정된 효용계수가 아니다.",
        "현재 적용 μ·C와 SAA 제약을 모든 과거 위험 시점에 고정한다. 시점별 재추정·실현수익률·거래비용을 포함한 운용 백테스트로 표현하지 않는다.",
        "선택 기간 안의 주간 및 최신 부분 주간 관측을 동일가중한다. Δλ는 선택 기간 내부의 인접 관측 차이이며 정규 주간 수익률처럼 연율화하지 않는다.",
        "표준편차는 각 열의 N−1 분모를 쓰고 관측수가 2 미만이면 비운다. 입력 날짜·점수 또는 최적화 검증 실패 시 경로와 통계 모두 유효한 결과로 게시하지 않는다."
      ],
      "checks": [
        "배율을 1에서 0.1로 바꾸면 λ와 Δλ의 평균·표준편차도 0.1배가 되는지 확인한다.",
        "선택 기간 밖의 직전 값이 첫 Δλ에 섞이지 않는지, Δλ 관측수가 λ보다 1개 적은지 확인한다.",
        "λ=0 및 상수 점수 경계, 제약/KKT 잔차, 동일 λ의 재사용 해가 동일 입력에 의존하는지 확인한다."
      ]
    },
    {
      "id": "reference-portfolio",
      "title": "레퍼런스 포트폴리오 · 과거 모멘트 비교",
      "formulas": [
        {
          "expression": "r(KRW) = (1 + r(USD)) × (1 + r(FX)) − 1",
          "legend": "동일 날짜 지수·달러원을 환산한 완료월 단순수익률. 월 누락 연결 금지.",
          "latex": "r_t^{\\mathrm{KRW}}=(1+r_t^{\\mathrm{USD}})(1+r_t^{\\mathrm{FX}})-1"
        },
        {
          "expression": "μp = wᵀμ; σp = 100√(wᵀΣw); RCᵢ = 100wᵢ(Σw)ᵢ/(wᵀΣw)",
          "legend": "μ는 과거 산술 연평균 %, Σ는 연 소수수익률². 매월 고정비중 재조정. RC는 분산 기여 비중 %.",
          "latex": "\\mu_p=w^\\top\\mu,\\qquad\\sigma_p=100\\sqrt{w^\\top\\Sigma w},\\qquad\\mathrm{RC}_i=100\\frac{w_i(\\Sigma w)_i}{w^\\top\\Sigma w}"
        },
        {
          "expression": "Sharpe(근사) = (μp − CD평균)/σp",
          "legend": "CD(AAA) 3M 전월 말 금리의 동일 표본 평균. 초과수익률 변동성 대신 포트폴리오 변동성 사용.",
          "latex": "\\mathrm{Sharpe}_{\\mathrm{approx}}=\\frac{\\mu_p-\\overline{y}_{\\mathrm{CD}}}{\\sigma_p}"
        }
      ],
      "code": "validate_source_levels_and_duplicate_bond_history()\nalign_assets_and_fx_on_same_dates()\nexclude_latest_source_month_and_keep_calendar_gaps()\npublish_1_3_5_10_year_aggregate_moments_only()\nreject_positive_weights_on_unavailable_assets()\ncompare_example_and_applied_custom_weights_without_changing_SAA_TAA_CMA()",
      "note": "원천은 data_bb. 국내·미국·한미 60/40, 분산50/40/10은 예시이며 전망·최적화 결과가 아니다. 원자재는 GSCI TR이고 spot 대체 금지. 단위·표본·비활성 사유는 CSV/화면에 포함. CAGR·MDD·누적경로는 집계 모멘트로 복원하지 않는다.",
      "sources": [
        {
          "path": "pipeline/reference_portfolio.py",
          "symbols": [
            "build"
          ]
        },
        {
          "path": "dashboard/reference-portfolio.js",
          "symbols": [
            "referenceMoments",
            "renderReferencePortfolio"
          ]
        }
      ],
      "purpose": "예시 또는 직접 입력한 고정비중을 동일한 과거 공통표본으로 비교한다. 전망 입력·최적화·실현 운용성과와 구분한다.",
      "decisions": [
        "data_bb 총수익 지수의 동일 날짜 원화 환산값으로 완료월 수익률을 만든다. 달력 월 누락을 이어 붙이지 않으며 해외자산의 환산은 한 번만 수행한다.",
        "선택한 1·3·5·10년 창의 공통 월 표본으로 산술 연평균(%)·연 공분산(소수²)을 계산한다. 매월 고정비중 재조정과 비용 미반영을 가정한다.",
        "국내채권의 미국채권 복제 원천과 원자재 총수익 지수 부재는 비활성 사유로 표시한다. 결측 자산에 양의 비중을 준 계산을 막고 원자재 spot으로 대체하지 않는다.",
        "CD 비교금리는 동일 표본의 전월 말 CD(AAA) 3M 연금리 평균이다. 샤프 분모는 포트폴리오 변동성이므로 초과수익률 변동성으로 계산한 샤프와 구분한다.",
        "엄격한 계약을 통과한 Data 집계 snapshot이 raw 계산보다 최신이면 이 탭에서만 사용한다. 직접비중 저장과 적용은 기존 SAA/TAA/CMA 입력을 변경하지 않는다.",
        "원본 수준·수익률·누적경로는 게시하지 않는다. 집계 모멘트만으로 CAGR·MDD·누적 성과를 복원하지 않는다."
      ],
      "checks": [
        "단일자산 100%에서 게시 평균·변동성이 복원되고, 양의 분산에서 위험기여도 합계가 100%인지 확인한다.",
        "합계 100% 위반·음수·비유한 비중, 결측 자산의 양의 비중에서는 적용을 거부하고 이전 적용값을 보존한다.",
        "동일 날짜 FX 환산·누락 월·최신 미완료월 배제와 snapshot 검증 실패 시 raw 복귀를 대조한다.",
        "US60/40 10년 통계를 별도 openpyxl·scalar 경로와 대조한다. 동일 원본을 사용한 구현 검증이며 독립 벤더 원천 검증은 아니다."
      ]
    }
  ]
};
