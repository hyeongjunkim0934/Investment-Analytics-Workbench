/* Implementation-aligned handoff. */
globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.fx = {
  "id": "fx",
  "title": "환율전망",
  "updated": "2026-11-10",
  "summary": "정본 환율·컨센서스 → A 국면전환·B 달력 정렬 학습·C 축소추정·D 조건부 변동성 → 만기별 실현 평가와 공통 표본외 검증. 전망 중심·구간·평가 표본의 정의를 구분한다.",
  "inputs": "USDKRW 양수 관측(원/달러), 모형별 금리·피처·오프라인 artifact, 브라우저 컨센서스 입력 · 일/월 표본·정보 가용시점은 모형별 계약을 따른다.",
  "outputs": "환율 수준: 원/달러 · 로그수익률: 소수 · 연 변동성·달러 보유자의 손실 VaR/ES: % · 모형별 기준일·목표일·표본·가용 상태",
  "readingGuide": [
    "파란 범위는 역사적 변동성 참고 범위이고 붉은 범위는 입력 전망 간 의견 차이다. A/B/C/D의 모형 구간과 구분한다.",
    "모형 이름보다 원천·기준일·예측 지평·중심 정의·구간 산출법을 먼저 확인한다. 공통 원자료를 쓰므로 독립성은 별도 검증 대상이다.",
    "금리차·모멘텀·국면 기여도는 인과효과가 아니다. 자동 자산배분·헤지 입력 연결은 현재 구현된 것으로 간주하지 않는다."
  ],
  "sources": [
    {
      "path": "pipeline/fx_outlook.py",
      "symbols": [
        "build"
      ]
    },
    {
      "path": "dashboard/fx-outlook.js",
      "symbols": [
        "fxOutlookSelection",
        "renderFxOutlook",
        "fxOutlookQuarters"
      ]
    },
    {
      "path": "pipeline/fx_markov.py",
      "symbols": [
        "build",
        "fit_markov",
        "hamilton_filter",
        "forecast_moments"
      ]
    },
    {
      "path": "pipeline/fx_simulation.py",
      "symbols": [
        "simulate_markov_paths",
        "summarize_paths",
        "forecast"
      ]
    },
    {
      "path": "dashboard/fx-markov.js",
      "symbols": [
        "renderFxMarkov"
      ]
    },
    {
      "path": "pipeline/fx_lstm_xgb.py",
      "symbols": [
        "load",
        "validate",
        "skeleton"
      ]
    },
    {
      "path": "pipeline/research/fx_lstm_xgb_runner.py",
      "symbols": [
        "join_bop",
        "ns_factors",
        "arma_factors",
        "walk_forward",
        "summarize",
        "build_features",
        "make_sequences",
        "fit_predict_xgb",
        "fit_predict_lstm"
      ]
    },
    {
      "path": "dashboard/fx-lstm-xgb.js",
      "symbols": [
        "renderFxLstmXgb",
        "fxLxMetrics",
        "fxLxValid"
      ]
    },
    {
      "path": "pipeline/fx_model_c.py",
      "symbols": [
        "build",
        "_ridge_fit",
        "_horizon"
      ]
    },
    {
      "path": "dashboard/fx-model-c.js",
      "symbols": [
        "renderFxModelC"
      ]
    },
    {
      "path": "pipeline/fx_model_d.py",
      "symbols": [
        "build",
        "fit_garch",
        "expected_variances",
        "simulate_paths",
        "tail_risk",
        "backtest"
      ]
    },
    {
      "path": "dashboard/fx-model-d.js",
      "symbols": [
        "renderFxModelD",
        "fxModelDValid"
      ]
    },
    {
      "path": "dashboard/summary-fx.js",
      "symbols": [
        "summaryFxModels",
        "summaryFxVaR975",
        "summaryFxQuantile"
      ]
    },
    {
      "path": "pipeline/fx_validation.py",
      "symbols": [
        "build",
        "metrics",
        "interval_score"
      ]
    },
    {
      "path": "pipeline/fx_validation_contract.py",
      "symbols": [
        "errors"
      ]
    },
    {
      "path": "dashboard/fx-validation.js",
      "symbols": [
        "renderFxValidation",
        "fxValidationCsv"
      ]
    },
    {
      "path": "dashboard/fx-forecast-status.js",
      "symbols": [
        "fxForecastToday",
        "fxForecastStatus"
      ]
    }
  ],
  "sections": [
    {
      "id": "fx-outlook",
      "title": "환율전망 · 전체 표본과 1년 범위",
      "formulas": [
        {
          "expression": "rₜ = ln(Sₜ / Sₜ₋₁); σ = std표본(r) × √252",
          "legend": "S: 원/달러 · σ: 소수 단위 연 로그변동성 · 전체 가용 일별 표본, ddof=1",
          "latex": "r_t=\\ln(S_t/S_{t-1}),\\qquad\\sigma=\\sqrt{252}\\,s(r)"
        },
        {
          "expression": "하단(τ) = S₀ exp(−σ√τ); 기준(τ) = S₀; 상단(τ) = S₀ exp(+σ√τ)",
          "legend": "파란 범위 · τ = 0, 1/12, …, 1년 · S₀: 최신 유효 호가 · 기준은 조건부 중앙값, 산술 기대값 아님",
          "latex": "I(\\tau)=\\left[S_0e^{-\\sigma\\sqrt\\tau},\\ S_0e^{+\\sigma\\sqrt\\tau}\\right],\\qquad m(\\tau)=S_0"
        }
      ],
      "code": "levels = full_positive_finite_weekday_bb_usdkrw()\nif levels are empty: levels = explicit_info_usdkrw_fallback()\nlevels = keep_last_valid_observation_per_date(levels)  # 급등락 유지\nreturns = log_returns_with_calendar_gap_between_1_and_7_days(levels)\npublish(full_history, source, sample_dates)\nif count(returns) >= 252:\n  range = latest_quote_times_exp_plus_minus_sigma_sqrt_time(months=0..12)\n  publish(range)\nplot_history_and_unchanged_blue_range()",
      "note": "Bloomberg 전체 계열이 정본이며 원천을 이어 붙이지 않는다. 표시기간·분기 수·컨센서스 입력은 파란 1년 범위를 재추정하지 않는다. 로그 추세 0·충격 무상관·고정 변동성 근사이며 보정된 예측구간이나 경로 전체의 확률 보장이 아니다. 급변값을 삭제하는 환헤지 σ와 정제 정책이 다르다.",
      "purpose": "전체 환율 이력을 정본으로 고정하고, 최신 수준을 기준으로 한 파란 1년 참고 범위를 제공한다.",
      "decisions": [
        "원천은 Bloomberg USDKRW 우선이며 전체 계열이 비었을 때만 info 대체를 쓴다. 두 원천의 일부 구간을 이어 붙이지 않는다.",
        "급변을 보존하고 1~7일 간격 로그수익률을 쓴다. 정제 정책이 다른 환헤지 장기 변동성 수치와 동일할 필요가 없다.",
        "로그 추세 0의 중심 S₀는 조건부 중앙값이다. 수준 산술 평균과 다르며 이 범위를 검증된 예측구간으로 부르지 않는다."
      ],
      "checks": [
        "표시기간·분기 수·컨센서스 입력을 바꿔도 추정 표본과 파란 범위는 변하지 않아야 한다.",
        "시점 0의 상하단과 중심은 S₀로 일치하며, 수익률 252개 미만이면 이력과 범위의 가용성을 구분한다."
      ],
      "sources": [
        {
          "path": "pipeline/fx_outlook.py",
          "symbols": [
            "build"
          ]
        },
        {
          "path": "dashboard/fx-outlook.js",
          "symbols": [
            "fxOutlookSelection",
            "renderFxOutlook"
          ]
        }
      ]
    },
    {
      "id": "fx-consensus",
      "title": "환율전망 · 분기 컨센서스",
      "formulas": [
        {
          "expression": "μq = Σᵢ xq,i / Nq; σq = √[Σᵢ(xq,i − μq)² / Nq]",
          "legend": "xq,i: 분기 q의 유효 양수 입력(원/달러) · 동일 가중 평균 · σq: 입력 수준의 모집단 표준편차, 평균 표준오차 아님",
          "latex": "\\mu_q=\\frac1{N_q}\\sum_i x_{q,i},\\qquad\\sigma_q=\\sqrt{\\frac1{N_q}\\sum_i(x_{q,i}-\\mu_q)^2}"
        },
        {
          "expression": "컨센서스 하단q = μq − σq; 상단q = μq + σq",
          "legend": "붉은 범위 · Nq ≥ 2인 인접 분기 사이 선형 보간 · 최신 관측에서 폭 0 · 빈 분기나 단일 입력에서는 범위를 끊음",
          "latex": "I_q=[\\mu_q-\\sigma_q,\\ \\mu_q+\\sigma_q]\\qquad(N_q\\geq2)"
        }
      ],
      "code": "state = load_v2_or_migrate_v1_forecasts_to_first_inputs()\nquarters = next_quarter_ends_after(max(latest_quote_date, today_KST), count=1..12)\nfor quarter in quarters:\n  inputs = valid_positive_inputs_from_numbered_rows(state[quarter])\n  mean, sigma = arithmetic_mean_and_population_sd(inputs)\n  emit_mean_point(mean)\n  if count(inputs) >= 2: emit_consensus_bounds(mean, sigma)\nred_band = interpolate_adjacent_valid_bounds_from_zero_width_latest_anchor()\nbreak_red_band_at_empty_or_single_input_quarters()\nplot(history, blue_1year_range, consensus_mean_points, red_band)\ndisplay_fx_as_integers_without_rounding_calculations_or_raw_csv()\npersist_arrays_and_quarter_count_in_browser_only(keep_hidden_quarters=True)",
      "note": "붉은 σ는 입력된 전망 수준의 괴리로 σ/√N이나 예측오차가 아니며, 같은 입력 2개는 σ=0이다. 각 유효 분기에 ±σ 세로선도 표시하여 고립된 분기의 괴리를 보여준다. 첫 분기에 범위가 있으면 최신 관측에서 폭 0으로 연결한다. 보정된 예측구간이 아니며 파란 1년 범위와 합산하지 않는다. 입력은 브라우저에만 저장한다. 기본 6개 분기이며 축소 후 숨긴 값도 보존한다. 환율은 정수로 표시하고 계산·저장·raw CSV는 원래 정밀도를 유지한다.",
      "purpose": "담당자가 입력한 분기별 전망의 중심과 의견 차이를 모형 전망과 구분해 보여준다.",
      "decisions": [
        "각 분기의 유효 양수 입력을 동일 가중한다. 붉은 σ는 모집단 분모 N이며 평균의 표준오차가 아니다.",
        "컨센서스 목표일은 최신 관측일과 한국시간 오늘 중 늦은 날 이후의 달력 분기말이다. 모형 기준일 이후 3/6/9/12개월과 다를 수 있다.",
        "입력은 브라우저에만 저장된다. 분기 수를 줄여 숨긴 입력도 보존하며 새로 입력하기 전 적용 범위를 확인한다."
      ],
      "checks": [
        "입력 1개면 중심만 표시하고 범위는 끊으며, 같은 값 2개면 폭 0을 표시한다.",
        "평균·분산은 입력 원정밀도로 계산하고 환율 정수 표시는 마지막에만 수행한다.",
        "의견 차이로 계산한 σ를 예측오차로 바꾸거나 파란 범위에 합산하거나 VaR로 환산하지 않는다."
      ],
      "sources": [
        {
          "path": "dashboard/fx-outlook.js",
          "symbols": [
            "fxOutlookQuarters",
            "fxOutlookSelection",
            "renderFxOutlook"
          ]
        }
      ]
    },
    {
      "id": "fx-markov",
      "title": "환율모형A · USDKRW 3국면 마코브 전환",
      "formulas": [
        {
          "expression": "rₜ = ln(Sₜ / Sₜ₋₁) = μzₜ + σzₜ εₜ; εₜ ~ N(0,1)",
          "legend": "S: 원/달러 · z: 저/중/고변동 3국면 · Pᵢⱼ: 현재 i에서 다음 관측 j로의 전이확률, 행 합=1",
          "latex": "r_t=\\ln(S_t/S_{t-1})=\\mu_{z_t}+\\sigma_{z_t}\\varepsilon_t,\\qquad\\varepsilon_t\\sim N(0,1)"
        },
        {
          "expression": "p예측 = p현재 P; p필터,j ∝ p예측,j × N(rₜ; μj, σj²)",
          "legend": "현재까지 관측한 수익률의 Hamilton 필터 · 모수는 최신 표본으로 추정, 과거 실시간 확률이나 OOS 성과로 해석하지 않음",
          "latex": "\\begin{aligned}p_{t|t-1}&=p_{t-1|t-1}P,\\\\p_{t|t,j}&=\\frac{p_{t|t-1,j}\\,\\phi(r_t;\\mu_j,\\sigma_j^2)}{\\sum_kp_{t|t-1,k}\\,\\phi(r_t;\\mu_k,\\sigma_k^2)}\\end{aligned}"
        },
        {
          "expression": "z₀⁽ᵇ⁾ ~ Cat(p필터); zₕ⁽ᵇ⁾ ~ Cat(P[zₕ₋₁⁽ᵇ⁾,:]); Sₕ⁽ᵇ⁾ = S₀ exp(Σᵤ₌₁ʰ[μzᵤ + σzᵤ εᵤ⁽ᵇ⁾])",
          "legend": "경로별 현재 국면을 유지하며 전이 후 다음 수익률 추출 · 로그수익률 평균에 추가 −σ²/2 보정 없음",
          "latex": "\\begin{aligned}z_0^{(b)}&\\sim\\operatorname{Cat}(p_{t|t}),\\\\z_h^{(b)}&\\sim\\operatorname{Cat}(P_{z_{h-1}^{(b)},:}),\\\\S_h^{(b)}&=S_0\\exp\\!\\left[\\sum_{u=1}^h(\\mu_{z_u^{(b)}}+\\sigma_{z_u^{(b)}}\\varepsilon_u^{(b)})\\right]\\end{aligned}"
        },
        {
          "expression": "평균ₕ = Σᵦ Sₕ⁽ᵇ⁾ / B; 중앙값ₕ = Qₕ(0.5); I68 = [Qₕ(0.16), Qₕ(0.84)]; I95 = [Qₕ(0.025), Qₕ(0.975)]",
          "legend": "B=20,000개 경로의 시점별 환율 수준 통계 · 모수 조건부 중앙 구간 · exp(로그평균)과 구별",
          "latex": "\\begin{aligned}\\bar S_h&=\\frac1B\\sum_{b=1}^B S_h^{(b)},\\quad m_h=Q_h(.5),\\\\I_{68,h}&=[Q_h(.16),Q_h(.84)],\\\\I_{95,h}&=[Q_h(.025),Q_h(.975)]\\end{aligned}"
        },
        {
          "expression": "g₀=p필터; gₕ=(gₕ₋₁P)⊙exp(μ+σ²/2); E[Sₕ]=S₀Σⱼgₕ,ⱼ; MC SEₕ=s(Sₕ)/√B",
          "legend": "정확한 산술 기대값으로 MC 평균 검증 · MC 표준오차는 수치오차이며 예측분포 폭 아님",
          "latex": "\\begin{aligned}g_0&=p_{t|t},\\quad g_h=(g_{h-1}P)\\odot e^{\\mu+\\sigma^2/2},\\\\E[S_h]&=S_0\\sum_jg_{h,j},\\qquad SE_{MC,h}=\\frac{s(S_h)}{\\sqrt B}\\end{aligned}"
        }
      ],
      "code": "levels = canonical_bb_usdkrw_or_info_fallback_only_if_empty()\nreturns = last_2520_valid_daily_log_returns(levels, max_calendar_gap=7)\nreset_filter_and_transition_counts_after_excluded_gaps()\nif count(returns) < 756 or latest_quote_has_no_valid_return: return inactive\nfits = gaussian_3state_EM(three_fixed_starts, uniform_block_initial_probability)\nfit = highest_final_likelihood_among_converged_nondegenerate_fits(fits); if absent: return inactive_with_diagnostics\nsort_states_by_sigma_and_reorder_transition_and_filtered_probabilities()\npaths = simulate_markov_paths(fit, steps=252, path_count=20000, seed=20261020)\nsimulation = summarize_levels(paths, quantiles=[.025,.16,.5,.84,.975])\nretain_exact_log_and_exponential_moments_as_diagnostic_benchmark()\nmap_21_model_steps_to_each_calendar_month(); publish_v1(simulation, first_12_paths)\nplot_history_mean_median_selected_interval_and_optional_sample_paths()",
      "note": "추정창은 최근 최대 2,520 유효 일간수익률(최소 756개), 표시기간과 독립적이다. 급변값을 삭제하지 않는다. 월당 21개 모형 관측을 1달력개월로 대응한다. 시점별 68/95% 모형 구간은 경로 전체 커버리지를 보장하지 않는다. 모수·모형 불확실성은 제외하며 공통 표본외 검증에서는 과거 기준일까지 재추정해 실제 포함률을 평가하되 통계적 우월성이나 실시간 성과를 보장하지 않는다. 평균·중앙값에 임의의 굴곡을 넣지 않는다. 세 국면은 변동성 순서이며 원화 강세·중립·약세라는 인과 상태가 아니다.",
      "purpose": "변동성 국면의 지속·전환을 반영한 확률분포에서 환율 수준의 평균·중앙값과 시점별 구간을 생성한다.",
      "decisions": [
        "국면은 추정 σ 순서의 저·중·고변동이다. 원화 강세·중립·약세 상태로 이름을 바꾸면 경제적 의미가 달라진다.",
        "최신 표본 모수로 계산한 과거 filtered 확률은 당시 실시간 추정 결과가 아니다. 미래정보 없는 필터와 당시 모수 빈티지 복원은 별개다.",
        "각 경로는 직전 국면에서 전이한 다음 수익률을 뽑는다. 로그수익률 μ에 추가 −σ²/2를 넣으면 다른 모형이 된다.",
        "월당 21개 모형 관측을 달력 1개월에 대응한다. 68/95%는 시점별 모수 조건부 구간이며 경로 전체의 포함확률은 아니다."
      ],
      "checks": [
        "전이행렬 각 행과 필터 확률의 합이 1이며 국면 재정렬 시 평균·분산·전이·확률을 함께 재배열한다.",
        "MC 산술 평균을 지수 모멘트의 정확 재귀값과 MC 표준오차로 대조한다. MC 오차와 예측 불확실성은 별개다.",
        "고정 seed 재현, 7일 초과 공백의 전이 리셋, 최소 756개·최대 2520개 표본과 수렴·퇴화 조건을 확인한다."
      ],
      "sources": [
        {
          "path": "pipeline/fx_markov.py",
          "symbols": [
            "build",
            "fit_markov",
            "hamilton_filter",
            "forecast_moments"
          ]
        },
        {
          "path": "pipeline/fx_simulation.py",
          "symbols": [
            "simulate_markov_paths",
            "summarize_paths",
            "forecast"
          ]
        },
        {
          "path": "dashboard/fx-markov.js",
          "symbols": [
            "renderFxMarkov"
          ]
        }
      ]
    },
    {
      "id": "fx-lstm-xgb",
      "title": "환율모형B · USDKRW LSTM/XGBoost walk-forward",
      "formulas": [
        {
          "expression": "게시 Ŝᵢ₊ₗ = ½[XGB(xᵢ) + LSTM(x̃ᵢ₋₅:ᵢ)]; 학습행 i−w−l < j ≤ i−l",
          "latex": "\\begin{aligned}\\hat S_{i+l}^{\\mathrm{pub}}&=\\tfrac12[\\operatorname{XGB}(x_i)+\\operatorname{LSTM}(\\tilde x_{i-5:i})],\\\\\\mathcal T_i&=\\{(x_j,S_{j+l}):i-w-l<j\\leq i-l\\}\\end{aligned}",
          "legend": "i·j: 누락 월을 보존한 달력 월 번호 · l=1/3/6/9/12개월, w=24/36개월 · 라벨은 기준일까지 실현된 값만 · XGB 원피처, LSTM 학습창 표준화"
        },
        {
          "expression": "LSTM 학습: (x̃ⱼ,…,x̃ⱼ₊L₋₁) → Sⱼ₊L₋₁₊ₗ; 마지막 입력에서 정확히 l개월",
          "latex": "(\\tilde x_j,\\ldots,\\tilde x_{j+L-1})\\longmapsto S_{j+L-1+l},\\qquad L=6",
          "legend": "마지막 입력 월과 라벨 기준월 일치 · 학습·추론·게시의 달력 지평 동일 · 결측 월은 압축하지 않고 불완전 학습창은 제외"
        },
        {
          "expression": "sₘ(τ) = rUS,τ − rKR,τ ≈ β₀ + β₁·(1−e^(−λτ))/(λτ) + β₂·[(1−e^(−λτ))/(λτ) − e^(−λτ)]",
          "legend": "Nelson–Siegel λ=0.7308 · τ = 0.25/1/3/10년 · 최소제곱 β = level/slope/curvature · 결측은 앞채움(원 코드는 양방향 보간) · 국제수지 피처는 공표 지연 2개월",
          "latex": "\\begin{aligned}s_m(\\tau)&=r_{US,\\tau}-r_{KR,\\tau},\\\\s_m(\\tau)&\\approx\\beta_0+\\beta_1\\frac{1-e^{-\\lambda\\tau}}{\\lambda\\tau}\\\\&\\quad+\\beta_2\\left[\\frac{1-e^{-\\lambda\\tau}}{\\lambda\\tau}-e^{-\\lambda\\tau}\\right]\\end{aligned}"
        },
        {
          "expression": "eₜ = ŷₜ₊ₗ − Sₜ₊ₗ; eRW,ₜ = Sₜ − Sₜ₊ₗ",
          "legend": "랜덤워크 = 기준일 환율 유지 · 실현된 행만 · 원/달러 · 기준일 수준 < 하한 / > 상한으로 저·중·고환율 국면 분해(기본 1100/1300, 노트북 고정값)",
          "latex": "e_t=\\hat S_{t+l}-S_{t+l},\\qquad e_{RW,t}=S_t-S_{t+l}"
        },
        {
          "expression": "U = RMSE / RMSE_RW; 적중률 = #{sign(ŷₜ₊ₗ − Sₜ) = sign(Sₜ₊ₗ − Sₜ)} / N",
          "legend": "Theil U < 1 이면 랜덤워크보다 작은 RMSE · 방향은 기준 환율 대비 부호 · 랜덤워크는 방향이 없어 비움 · 선택 기간·조합·국면별로 화면이 재계산",
          "latex": "\\begin{aligned}U&=\\frac{\\mathrm{RMSE}}{\\mathrm{RMSE}_{RW}},\\\\\\operatorname{HitRate}&=\\frac1N\\sum_t\\mathbf1\\!\\left[\\operatorname{sgn}(\\hat S_{t+l}-S_t)=\\operatorname{sgn}(S_{t+l}-S_t)\\right]\\end{aligned}"
        }
      ],
      "code": "inspect_exact_three_private_monthly_CSV_inputs()\nif partial_inputs: fail_build_without_reusing_old_artifact()\nif complete_inputs: reuse_exact_hash_cache_or_train_v2_and_validate()\nmonthly_grid = retain_missing_calendar_months()\nfor origin in monthly_grid:\n  train = consecutive_complete_origin_months_with_labels_matured_by(origin)\n  sequence_label = target_of_last_input_month()\n  predict_both_models_at_exact_calendar_target()\nvalidate_v2_safety_calendar_cutoff_and_equal_weight_ensemble()\nrecompute_metrics_on_observed_targets_and_publish_only_forecast_metadata()",
      "note": "v2는 달력 월말 의사결정일·연속 월 학습창·시퀀스 마지막 입력 정렬을 강제한다. 작은 학습창·시드 민감성과 실제 공표일·자료 개정 빈티지의 한계는 남는다. 학습 입력이 없는 상태를 다른 모형으로 대체하지 않는다.",
      "purpose": "오프라인에서 생성한 LSTM·XGBoost 예측을 계약 검증 후 게시하고 같은 평가행에서 비교한다.",
      "decisions": [
        "기존 빌드는 CSV 3개가 모두 있으면 정확한 입력·코드·의존성 해시 캐시를 검증하거나 CPU 러너를 실행한다. 입력이 모두 없으면 수동 산출물 경로를 유지하고, 일부만 있으면 배포를 차단한다.",
        "v1·notebook 미래 라벨·NS 양방향 보간·국제수지 지연 2개월 미만은 운영 로더가 거부한다. 공표 지연은 실제 공표일 달력이 아닌 근사다.",
        "월 격자의 누락 월은 유지한다. 연속 학습창·현재 시퀀스가 불완전하면 그 기준일을 건너뛰고, 타깃 월 spot은 그 달 피처가 없어도 실현값으로 보존한다.",
        "XGB는 원피처, LSTM은 학습창으로만 표준화한다. 두 모형은 동일 달력 지평을 예측하며 단순평균 가중치를 표본 성과로 바꾸지 않는다.",
        "24/36개월 창과 6개월 시퀀스의 작은 표본·시드 민감성은 별도 검증 대상이다. 국면 경계1100/1300은 비교용 입력이며 추정된 상태가 아니다."
      ],
      "checks": [
        "시퀀스 마지막 입력 월부터 타깃까지 정확히 lag개월인지 실제 make_sequences와 달력 인덱스를 대조한다.",
        "결측 월·월말 주말·미래 자료 변경·과거 표본 절단에도 과거 예측의 입력과 목표일이 변하지 않는지 확인한다.",
        "자료 기준일 이후 실현값·구버전·누수 재현 옵션·앙상블 불일치를 차단하고 지표를 동일 실현 행에서 다시 계산한다.",
        "합성 입력의 실제 LSTM/XGBoost 적합과 게시 검증을 원자료 실성과 검증으로 혼동하지 않는다."
      ],
      "sources": [
        {
          "path": "pipeline/fx_lstm_xgb.py",
          "symbols": [
            "load",
            "validate",
            "skeleton"
          ]
        },
        {
          "path": "pipeline/research/fx_lstm_xgb_runner.py",
          "symbols": [
            "join_bop",
            "ns_factors",
            "arma_factors",
            "walk_forward",
            "summarize",
            "build_features",
            "make_sequences",
            "fit_predict_xgb",
            "fit_predict_lstm"
          ]
        },
        {
          "path": "dashboard/fx-lstm-xgb.js",
          "symbols": [
            "renderFxLstmXgb",
            "fxLxMetrics",
            "fxLxValid"
          ]
        }
      ]
    },
    {
      "id": "fx-model-c",
      "title": "환율모형C · 금리차·모멘텀 축소추정",
      "formulas": [
        {
          "expression": "yₜ,ₕ = ln(Sₜ₊ₕ/Sₜ); xₜ = [금리KR,1Y − 금리US,1Y, ln(Sₜ/Sₜ₋₁), ln(Sₜ/Sₜ₋₃)]",
          "legend": "S: 원/달러 · 금리차: %p · h=1/3/6/9/12달력개월 · 당월 실제 공통일의 최종값 · 월 누락을 행 번호로 압축하지 않음",
          "latex": "\\begin{aligned}y_{t,h}&=\\ln(S_{t+h}/S_t),\\\\x_t&=[r_{KR,1Y}-r_{US,1Y},\\ \\ln(S_t/S_{t-1}),\\ \\ln(S_t/S_{t-3})]\\end{aligned}"
        },
        {
          "expression": "(â, b̂) = argmin {mean[(y−a−z′b)²] + λb′b}; z = (x−mean학습)/std학습",
          "legend": "λ=1 고정 · 절편 벌점 제외 · 학습표본 안에서만 표준화 · 예측일에 실현된 라벨 최소60/최대120개 · 상수 열 0",
          "latex": "\\begin{aligned}(\\hat a,\\hat b)&=\\operatorname*{arg\\,min}_{a,b}\\left[\\frac1N\\sum_t(y_t-a-z_t^\\top b)^2+\\lambda b^\\top b\\right],\\\\z_t&=(x_t-\\bar x_{\\mathrm{train}})/s_{\\mathrm{train}}(x),\\quad\\lambda=1\\end{aligned}"
        },
        {
          "expression": "ŷC = 0.5(â+z′b̂); ŜC = Sₜ exp(ŷC); ŜRW = Sₜ",
          "legend": "축소50% 고정 · 축소 전 Ridge와 RW도 같은 평가 행 사용 · 로그 중심이며 수준 기대값·조건부 중앙값 보장 없음 · 기여도 합은 100ŷC",
          "latex": "\\hat y_C=0.5(\\hat a+z_t^\\top\\hat b),\\qquad\\hat S_C=S_te^{\\hat y_C},\\qquad\\hat S_{RW}=S_t"
        },
        {
          "expression": "eₜ,ₕ = ln(Sₜ₊ₕ/Sₜ)−ŷC; I68 = Sₜ exp(ŷC + [Q.16(e),Q.84(e)])",
          "legend": "예측일까지 실현된 동일 지평 OOS 오차24개 이상 · 95%는 .025/.975 · 당시 생성 가능한 구간만 적중률 평가 · 커버리지 보장 없음",
          "latex": "\\begin{aligned}e_{t,h}&=\\ln(S_{t+h}/S_t)-\\hat y_{C,t,h},\\\\I_{68}&=\\left[S_te^{\\hat y_C+Q_{.16}(e)},\\ S_te^{\\hat y_C+Q_{.84}(e)}\\right]\\end{aligned}"
        },
        {
          "expression": "RMSE = √mean[(Ŝ−S실제)²]; U = RMSE_C / RMSE_RW",
          "legend": "RMSE·MAE: 원/달러 · U: 무단위 · RW RMSE=0이면 U 결측 · 겹치는 다개월 오차는 독립 표본이 아님",
          "latex": "\\mathrm{RMSE}=\\sqrt{\\frac1N\\sum_t(\\hat S_t-S_t)^2},\\qquad U=\\frac{\\mathrm{RMSE}_C}{\\mathrm{RMSE}_{RW}}"
        }
      ],
      "code": "join_canonical_FX_and_KR_US_1Y_rates_on_actual_common_dates_without_fill()\nretain_only_actual_common_quotes_on_the_exact_last_weekday_of_each_month()\nrequire_quote_asof_equal_to_last_weekday_decision_date()\ncreate_1m_3m_momentum_and_h_month_targets_using_calendar_month_keys()\nfor horizon in [1,3,6,9,12]:\n  for origin in monthly_decision_dates:\n    train = last_120_labels_realized_by_origin; require_at_least_60(train)\n    fit_standardization_and_fixed_lambda_1_ridge_on_train_only()\n    predict_C_fixed_half_ridge_and_RW_from_same_base_quote()\n    calibrate_bounds_only_from_at_least_24_errors_matured_by_origin()\n  evaluate_C_Ridge_RW_on_identical_realized_rows_and_prequential_intervals()\npublish_forecasts_metrics_latest_contributions_and_table_CSV()",
      "note": "의사 표본 외 평가이며 당시 데이터 빈티지·공표 시각은 복원하지 않았다. 월말 마지막 평일에 세 입력의 실제 공통 관측이 있어야 하며, 휴일·결측 월은 제외한다. 근접일 대체·휴일 달력 보정은 없다. λ·축소비율은 고정 설계 가정이며 평가 결과로 재선택하지 않는다. 경험적 구간의 실제 포함률은 화면에 별도 표시한다. 기여도는 인과효과·구조적 위험프리미엄이 아니다. 금리차는 UIP나 CIP가 환율을 결정한다는 제약이 아닌 예측변수다. 자세한 정의는 docs/FX_MODEL_C.md.",
      "purpose": "금리차·모멘텀의 예측 정보를 Ridge로 추정하고 랜덤워크 쪽으로 고정 축소해 지평별 전망을 만든다.",
      "decisions": [
        "월말 마지막 평일에 환율·양국 1Y 금리의 실제 공통 관측이 있어야 한다. 누락 월을 행 번호로 압축하거나 가까운 날로 대체하지 않는다.",
        "표준화·추정에는 예측일에 실현된 라벨만 쓰며 최소 60·최대 120개다. λ=1과 50% 축소는 고정 설계 가정이다.",
        "구간은 해당 지평에서 예측일까지 실현된 OOS 로그오차 24개 이상으로 보정한다. 95% 분위수와 실제 포함률을 구분한다.",
        "금리차 계수와 기여도는 예측적 연관이며 인과효과나 UIP·CIP의 구조적 제약이 아니다."
      ],
      "checks": [
        "미래 자료를 변경해도 과거 origin의 학습·예측·당시 구간이 변하지 않는지 확인한다.",
        "C·축소 전 Ridge·RW의 대상·시점·평가행을 맞추고 학습/구간 보정/평가를 구분한다.",
        "겹치는 다개월 오차의 표본수를 독립 관측수로 해석하지 않고, 24개 미만이면 점 전망과 구간 가용성을 구분한다."
      ],
      "sources": [
        {
          "path": "pipeline/fx_model_c.py",
          "symbols": [
            "build",
            "_ridge_fit",
            "_horizon"
          ]
        },
        {
          "path": "dashboard/fx-model-c.js",
          "symbols": [
            "renderFxModelC"
          ]
        }
      ]
    },
    {
      "id": "fx-model-d",
      "title": "환율모형D · 방향 중립 조건부 변동성",
      "formulas": [
        {
          "expression": "rₜ = log(Sₜ/Sₜ₋₁); Eₜ[rₜ₊₁] = 0; hₜ₊₁ = (1−α−β)v̄ + αrₜ² + βhₜ",
          "legend": "고정 격자 GARCH · v̄=학습창 평균 r² · α+β<1 · 상수분산 후보 포함 · 최신 연속구간 최소504/최대2520 관측",
          "latex": "\\begin{aligned}r_t&=\\ln(S_t/S_{t-1}),\\qquad E_t[r_{t+1}]=0,\\\\h_{t+1}&=(1-\\alpha-\\beta)\\bar v+\\alpha r_t^2+\\beta h_t\\end{aligned}"
        },
        {
          "expression": "Eₜ[hₜ₊ₖ] = v̄ + (α+β)ᵏ⁻¹(hₜ₊₁−v̄); σ연,H = 100√(252 Σₖ Eₜ[hₜ₊ₖ]/H)",
          "legend": "지평 평균 일간분산의 연율 환산 · 누적 수익률 표준편차와 구분",
          "latex": "\\begin{aligned}E_t[h_{t+k}]&=\\bar v+(\\alpha+\\beta)^{k-1}(h_{t+1}-\\bar v),\\\\\\sigma_{\\mathrm{ann},H}&=100\\sqrt{\\frac{252}{H}\\sum_{k=1}^HE_t[h_{t+k}]}\\end{aligned}"
        },
        {
          "expression": "z* = ±|r/√h| / RMS(r/√h); S*ₕ = S₀ exp(Σₖ √h*ₖ z*ₖ)",
          "legend": "과거 표준화 잔차 크기 재추출 · 독립 대칭 부호 · 각 경로 분산 재귀 · 로그평균0과 수준평균을 구분",
          "latex": "z^*=\\frac{\\pm|r/\\sqrt h|}{\\operatorname{RMS}(r/\\sqrt h)},\\qquad S_H^*=S_0\\exp\\!\\left[\\sum_{k=1}^H\\sqrt{h_k^*}z_k^*\\right]"
        },
        {
          "expression": "L = 100(1−S*ₕ/S₀); VaR95 = Q.95(L); ES95 = 최악5% 확률질량 평균",
          "legend": "달러 보유자의 원화가치 손실률 · 원화강세가 손실 · 실현 포함률 보장 없음 · 요약카드 VaR97.5와 신뢰수준이 다름",
          "latex": "\\begin{aligned}L&=100(1-S_H^*/S_0),\\qquad\\operatorname{VaR}_{.95}=Q_{.95}(L),\\\\\\operatorname{ES}_{.95}&=\\frac1{.05}\\int_{.95}^{1}Q_u(L)\\,du\\end{aligned}"
        },
        {
          "expression": "환노출(%) = 100 min(1, 목표σ / 예측σ)",
          "legend": "사용자 입력 목표 · 비레버리지 FX 위험예산 참고값 · 비용·캐리·기초자산 공분산을 반영한 최적헤지 아님",
          "latex": "e_{FX}(\\%)=100\\min\\!\\left(1,\\frac{\\sigma_{\\mathrm{target}}}{\\sigma_{\\mathrm{forecast}}}\\right)"
        }
      ],
      "code": "select_canonical_FX_or_explicit_fallback_without_splicing()\nreset_after_gaps_over_7_calendar_days_and_require_504_returns()\nfit_fixed_grid_GARCH_by_training_only_Gaussian_quasi_likelihood()\nnormalize_residual_magnitudes_and_draw_independent_symmetric_signs()\nrecurse_10000_paths_for_252_model_observations_with_fixed_seed()\npublish_1_3_6_9_12_month_volatility_intervals_VaR_and_ES()\nrefit_at_past_origins_and_compare_next_21_squared_returns_on_same_rows()\nreport_D_constant_EWMA_QLIKE_MSE_and_prequential_interval_coverage()\ncompute_exposure_only_when_user_enters_a_valid_target_volatility()",
      "note": "A도 변동성을 추정하므로 변동성 집중 자체가 통계적 직교성의 증거는 아니다. D는 평균0·연속 조건부분산·꼬리분포로 목적을 구분한다. A/C와 공동 OOS 오차상관·결합 예측력은 미검증이다. 잔차 대칭화는 별도 설계 가정이며 원자료 빈티지·모수 불확실성·미관측 꼬리위험·거래비용은 미반영이다. 상세 정의와 원문 출처는 docs/FX_MODEL_D.md.",
      "purpose": "환율 방향 기대를 0으로 고정하고 조건부분산·분포 꼬리와 사용자 목표 변동성의 관계를 추정한다.",
      "decisions": [
        "최신 연속 구간의 최소 504·최대 2520개 수익률을 사용한다. 7일 초과 공백 전 표본을 이어 붙이지 않는다.",
        "평균 0·분산목표·고정 GARCH 격자·대칭화 잔차는 설계 가정이다. 같은 FX 원천을 공유하는 A/C와 통계적으로 직교한다고 단정하지 않는다.",
        "연율 변동성은 지평 평균 일간분산의 환산이고 구간은 누적 환율 수준 분포다. 달러 보유자의 손실은 원화 강세에서 양수다.",
        "사용자 목표변동성에 따른 환노출은 단일 FX 위험예산 참고값이다. 비용·캐리·기초자산 공분산을 고려한 최적헤지로 전달하지 않는다.",
        "기존 21관측 검증과 별도로 공통 검증은 A/C와 같은 월말 기준일·1/3/6/9/12개월 목표일을 사용한다. 미래 실현 관측 수를 전망 단계수로 역산하지 않는다."
      ],
      "checks": [
        "분산 재귀를 독립 유한합·상수분산·EWMA 경계와 대조하고 고정 seed 재현을 확인한다.",
        "D·상수·EWMA를 같은 과거 origin·다음 21개 수익률로 비교하며 미래 구간을 학습에 포함하지 않는다.",
        "상세 VaR95/ES95와 요약 VaR97.5의 수준·손실 부호를 구분하고 지난 목표일의 환노출을 비운다."
      ],
      "sources": [
        {
          "path": "pipeline/fx_model_d.py",
          "symbols": [
            "build",
            "fit_garch",
            "expected_variances",
            "simulate_paths",
            "tail_risk",
            "backtest"
          ]
        },
        {
          "path": "dashboard/fx-model-d.js",
          "symbols": [
            "renderFxModelD",
            "fxModelDValid"
          ]
        }
      ]
    },
    {
      "id": "quarterly-summary",
      "title": "요약카드 · 환율 전망의 기준과 VaR",
      "purpose": "A/B/C/D와 컨센서스를 같은 화면에서 읽되, 중심·구간·기준일이 다른 이유를 유지한다.",
      "formulas": [
        {
          "expression": "VaR97.5%,FX = max(0, 100 × (1 − Q.025(Sₕ)/S₀))",
          "latex": "\\operatorname{VaR}_{.975,FX}=\\max\\!\\left(0,100\\left[1-\\frac{Q_{.025}(S_H)}{S_0}\\right]\\right)",
          "legend": "기준일 달러 보유자의 원화 환손실률 · 중앙95% 하단과 대응 · 음수 손실 분위수는 화면에서 0으로 표시 · 최대손실 아님"
        },
        {
          "expression": "B 구간 = Ŝₕ × exp([Q.025(e), Q.975(e)]); e = ln(S실제/Ŝ)",
          "latex": "I_{95,B}=\\left[\\hat S_He^{Q_{.025}(e)},\\hat S_He^{Q_{.975}(e)}\\right],\\qquad e=\\ln(S_{\\mathrm{actual}}/\\hat S)",
          "legend": "선택 모형·창·정확한 지평 · 기준일까지 실현된 로그예측오차 최소 24개 · 유효 양수 쌍만 사용"
        }
      ],
      "code": "read_published_FX_A_B_C_D_and_saved_consensus_without_refitting()\nfor horizon in [3,6,9,12]:\n  A = MC_summary_at_step(horizon * 21)\n  B = exact_horizon_at_newest_origin_across_selected_window_horizons()\n  B_interval = calibrate_from_matured_positive_log_errors_if_at_least_24()\n  C = direct_horizon_output(horizon); D = volatility_MC_median(horizon * 21)\n  publish_actual_anchor_target_dates_point_intervals_and_USD_long_VaR()\nconsensus = next_four_calendar_quarter_mean_plus_minus_population_sigma()\nleave_consensus_VaR_unavailable_and_flag_elapsed_target_dates()",
      "note": "A의 산술 평균, B의 수준 예측, C의 로그 중심 환산값, D의 중앙값은 같은 종류의 기대값이 아니다. 모형의 조건부 구간·경험 보정 구간·컨센서스 의견 차이를 한 종류의 신뢰구간으로 합치지 않는다. 상세 정의는 docs/SUMMARY_FORECASTS.md.",
      "decisions": [
        "컨센서스는 달력 분기말이고 모형은 각 기준일 이후 지평이다. 같은 분기 라벨만 보고 동시점 전망으로 평균하지 않는다.",
        "모형 B는 선택 학습창의 지평들 중 가장 최신 기준일을 사용한다. 이 기준일이 없는 지평은 비우며 모두 존재하는 과거 공통일로 후퇴하거나 지평을 보간하지 않는다. 구간 표본이 부족해도 유효 점 전망은 별도로 유지한다.",
        "컨센서스 의견 분산은 예측오차 분포가 아니므로 VaR를 계산하지 않는다. 다른 모형의 결과로 결측을 대체하지 않는다.",
        "서울 날짜에서 목표일이 오늘 이하이면 현재 전망·VaR와 당시 전망을 분리한다. 정확한 목표일 실제 관측이 있으면 예측−실제 오차를 표시하고, 없으면 실현 대기로 둔다. 인접일이나 최신 환율로 대신하지 않는다."
      ],
      "checks": [
        "각 행의 기준·목표일과 사용한 모형·창·중심 종류가 원본 출력과 일치하는지 확인한다.",
        "달러 가치가 하락한 꼬리에서 손실이 양수가 되는지, 95% 중앙 하단이 단측 97.5%와 대응하는지 확인한다.",
        "지나간 목표일은 새 전망이 필요한 상태로 표시하며 현재 전망처럼 재라벨링하지 않는다."
      ],
      "sources": [
        {
          "path": "dashboard/summary-fx.js",
          "symbols": [
            "summaryFxModels",
            "summaryFxVaR975",
            "summaryFxQuantile"
          ]
        }
      ]
    },
    {
      "id": "fx-common-validation",
      "title": "공통 표본외 검증 · 동일 시점·고정 가중치",
      "purpose": "A/C/D와 기준모형을 동일 기준일·목표일에서 평가하여 구현 검증과 예측력 평가를 구분한다.",
      "formulas": [
        {
          "expression": "U = RMSE모형 / RMSE_RW",
          "latex": "U=\\frac{\\sqrt{N^{-1}\\sum_i(\\hat S_i-S_i)^2}}{\\sqrt{N^{-1}\\sum_i(S_{0,i}-S_i)^2}}",
          "legend": "같은 공통 평가행 · 환율 수준 오차 · RW 오차가0이면 비율은 미정"
        },
        {
          "expression": "동일가중 = (A+C+RW)/3; 축소 = 0.25A+0.25C+0.50RW",
          "latex": "\\hat S_{EW}=\\tfrac13(\\hat S_A+\\hat S_C+S_0),\\qquad\\hat S_{SH}=\\tfrac14\\hat S_A+\\tfrac14\\hat S_C+\\tfrac12S_0",
          "legend": "가중치 사전 고정 · A 중앙값·C 로그 중심·D/RW 기준환율 · C에는 자체 RW 축소가 이미 포함됨"
        },
        {
          "expression": "구간점수 = (상단−하단)+2/α·[(하단−실제)₊+(실제−상단)₊]",
          "latex": "IS_\\alpha=(U-L)+\\frac2\\alpha\\big[(L-y)_++(y-U)_+\\big]",
          "legend": "원/달러 · 폭과 구간 밖 오차를 함께 평가 · 작을수록 좋음 · 구간 가용 공통 부분표본"
        },
        {
          "expression": "QLIKE = log(v예측)+log(실제/기준)²/v예측",
          "latex": "Q=\\log(\\hat v)+\\frac{[\\log(S_T/S_0)]^2}{\\hat v}",
          "legend": "D·상수·EWMA의 누적로그분산 · 만기 로그변화 제곱은 분산 대용치이며 직접 관측한 분산은 아님"
        }
      ],
      "code": "select_recent_origin_dates_before_model_fitting(maximum=36)\nfor origin in origins:\n  refit_A_and_D_using_daily_history_through_origin_only()\n  reuse_C_matured_label_historical_prediction()\n  target = exact_last_weekday_of_target_calendar_month()\n  steps = predetermined_weekdays_after_origin_through_target()\n  retain_only_matching_source_anchor_target_quotes()\nscore_all_point_models_on_identical_rows()\nscore_intervals_on_common_available_interval_rows()\nverify_metrics_and_dates_with_independent_standard_library_gate()",
      "note": "현재 데이터 빈티지를 이용한 과거 재추정이다. 실제 실시간 운용 기록이 아니며 다개월 평가기간이 겹친다. 표본 수를 독립 관측 수로 해석하지 않는다. 공통 시간축은 상세 전망의21관측/월과 다르다. B는 별도 월간 아티팩트 경로로 이 비교에 포함하지 않는다.",
      "decisions": [
        "기준일 cap과 seed·경로 수는 성과와 무관하게 고정한다. A/D는 기준일까지의 prefix로 다시 추정한다.",
        "C의 역사적 예측과 일별 source·기준환율·실현환율이 정확히 맞는 행만 비교하고, 결측 목표일은 보간하지 않는다.",
        "점평가와 구간평가의 공통 표본 수·기간을 각각 공개한다. D 산술평균의 지수변환 상승을 방향 신호로 채택하지 않는다.",
        "가중치·구간 폭을 같은 평가표본에서 다시 고르지 않는다. 원자료 빈티지·모수 불확실성·실제 거래비용은 후속 검증 영역이다."
      ],
      "checks": [
        "미래 FX와 금리 자료를 바꿔도 과거 origin의 예측·구간·분산이 유지되는지 확인한다.",
        "누락 목표일·원천 불일치·모형 추정 실패를 명시적으로 제외하고 해당 행을 다른 모형에만 남기지 않는다.",
        "독립 scalar 산식으로 RMSE·MAE·구간점수·QLIKE와 고정 조합을 검산하고 배포 게이트에서 변조를 거부한다."
      ],
      "sources": [
        {
          "path": "pipeline/fx_validation.py",
          "symbols": [
            "build",
            "metrics",
            "interval_score"
          ]
        },
        {
          "path": "pipeline/fx_validation_contract.py",
          "symbols": [
            "errors"
          ]
        },
        {
          "path": "dashboard/fx-validation.js",
          "symbols": [
            "renderFxValidation",
            "fxValidationCsv"
          ]
        }
      ]
    }
  ]
};
