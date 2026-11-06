/* Implementation-aligned handoff. Formula text remains available without the renderer. */
globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.hedge = {
  "id": "hedge",
  "title": "환헤지",
  "updated": "2026-11-06",
  "summary": "현재 캐리 관측 → 공동 채권·환 위험 → A의 금리차 진단 → B의 평균분산·C의 꼬리손실 의사결정 → 누적수익률 요약. 각 단계의 데이터·단위·가정·적용 범위를 분리한다.",
  "inputs": "HP 3M·6M·12M, SMB USD 3M, 10년 국채금리: 연 % · 환율: 외화당 원(JPY는 100엔당 원)",
  "outputs": "비용·금리·연 변동성: % · 메리트·위험감소: %p · A 괴리: bp·Z · B/C 헤지비율: % · 월간 ES: 손실 % · 요약: 누적수익률 %",
  "sources": [
    {
      "path": "pipeline/common.py",
      "symbols": [
        "hp_curve"
      ]
    },
    {
      "path": "pipeline/hedge.py",
      "symbols": [
        "build",
        "build_fx_volatility",
        "despike",
        "clean_merit_daily",
        "build_bond_merit",
        "build_bond_merits",
        "build_cost_distribution",
        "par_modified_duration",
        "build_bond_outlook"
      ]
    },
    {
      "path": "dashboard/app.js",
      "symbols": [
        "hedgeCostSnapshot",
        "renderHedgeMeritChart",
        "renderHedgeDistribution"
      ]
    },
    {
      "path": "pipeline/hedge_cip.py",
      "symbols": [
        "build"
      ]
    },
    {
      "path": "dashboard/hedge-cip.js",
      "symbols": [
        "hedgeCipStats",
        "hedgeCipSelection",
        "renderHedgeCip"
      ]
    },
    {
      "path": "dashboard/hedge-optimizer.js",
      "symbols": [
        "hedgeModelBCompute",
        "hedgeModelBValidateOptions"
      ]
    },
    {
      "path": "dashboard/hedge-model-b.js",
      "symbols": [
        "renderHedgeModelB"
      ]
    },
    {
      "path": "pipeline/hedge_tail.py",
      "symbols": [
        "build_tail_risk",
        "expected_shortfall"
      ]
    },
    {
      "path": "dashboard/hedge-tail-optimizer.js",
      "symbols": [
        "hedgeModelCCompute",
        "hedgeModelCValidateOptions"
      ]
    },
    {
      "path": "dashboard/summary-hedge.js",
      "symbols": [
        "summaryHedgeModels"
      ]
    }
  ],
  "sections": [
    {
      "id": "cost",
      "title": "헤지비용 · 부호와 평균",
      "formulas": [
        {
          "expression": "cₘ = round₂(median(만기 m의 최근 최대 5개 유효 HP 관측))",
          "legend": "m = 3M·6M·12M · c: 연 % · 양수는 받음, 음수는 지불",
          "latex": String.raw`c_m=\operatorname{round}_{2}\!\left(\operatorname{median}\{HP_{m,t}\}_{\text{last }\leq 5}\right)`
        },
        {
          "expression": "c̄ = (c₃ᴹ + c₆ᴹ + c₁₂ᴹ) / 3",
          "legend": "각 만기의 중앙값을 소수 2자리 반올림한 뒤 단순평균",
          "latex": String.raw`\bar c=\frac{c_{3M}+c_{6M}+c_{12M}}{3}`
        },
        {
          "expression": "c프록시 = 한국 3개월 금리 − 해당국 3개월 금리",
          "legend": "HP 커브가 없고 금리차 관측이 있을 때만 사용 · 연 %",
          "latex": String.raw`c_{\mathrm{proxy}}=r_{KR,3M}-r_{\mathrm{foreign},3M}`
        }
      ],
      "code": "for currency in USD, AUD, JPY, EUR:\n  curve = hp_curve(currency, window=5)\n  if curve is missing:\n    curve = rate_difference_proxy_if_available(currency)\n  snapshot = read_three_tenors(curve)\n  mean = mean_if_all_three_present(snapshot)\n  publish(snapshot, mean, source, tenor_dates)",
      "note": "USD 과거 이력은 SMB 3M, 현재 비용은 HP다. 1년 범위는 HP가 없으면 계산하지 않는다.",
      "purpose": "통화별 현재 헤지 캐리의 부호와 읽는 방식을 고정해, 모니터링과 자산배분에서 같은 숫자를 사용하도록 한다.",
      "decisions": [
        "HP는 각 만기 최근 최대 5개 유효 관측의 중앙값이다. 만기별 최신 관측일과 전체 기준일을 함께 확인한다.",
        "비용이라는 화면 이름에도 양수는 수취, 음수는 지불이다. 지불 비용을 양수로 다시 뒤집어 계산하지 않는다.",
        "HP 부재 시 금리차 프록시는 모니터링의 명시적 대체 표시다. 모형 A의 과거 비교나 B·C의 HP 전용 입력을 자동 대체하지 않는다."
      ],
      "checks": [
        "3개 만기의 반올림된 중앙값 평균이 모니터링·공유 hp_curve 사용처에서 일치하는지 확인한다.",
        "한 만기가 없거나 날짜가 다른 사례에서 출처·만기별 날짜·비활성 사유가 유지되는지 확인한다."
      ],
      "sources": [
        {
          "path": "pipeline/common.py",
          "symbols": [
            "hp_curve"
          ]
        },
        {
          "path": "pipeline/hedge.py",
          "symbols": [
            "build"
          ]
        },
        {
          "path": "dashboard/app.js",
          "symbols": [
            "hedgeCostSnapshot"
          ]
        }
      ]
    },
    {
      "id": "fx-volatility",
      "title": "장기 환 변동성",
      "formulas": [
        {
          "expression": "rₜ = ln(Sₜ / Sₜ₋₁)",
          "legend": "S: 원화 표시 환율 · 인접 유효 관측 간 로그수익률",
          "latex": String.raw`r_t=\ln\!\left(\frac{S_t}{S_{t-1}}\right)`
        },
        {
          "expression": "σFX = 100 × std표본(r) × √252",
          "legend": "전체 가용 이력 · 표본 표준편차 ddof=1 · 연 %",
          "latex": String.raw`\sigma_{FX}=100\sqrt{252}\,s(r),\qquad s(r)^2=\frac{\sum_t(r_t-\bar r)^2}{N-1}`
        }
      ],
      "code": "levels = positive_finite_weekday_levels(source)\nlevels = keep_last_valid_observation_per_date(levels)\nlevels = remove_opposite_moves_over_10pct(levels)\nreturns = log_returns(levels)\nreturns = keep_calendar_gaps_between_1_and_7_days(returns)\nif count(returns) < 252: return inactive\npublish(annual_sample_volatility(returns), sample_dates)",
      "note": "10% 초과 급변 뒤 반대 방향 10% 초과 변동은 단일 스파이크로 제거한다. σFX는 포트폴리오 위험 감소량이 아니다.",
      "purpose": "환율 자체의 장기 변동성을 같은 정제 규칙으로 요약하며, 채권과의 공분산 효과와 구분한다.",
      "decisions": [
        "환율 상승은 외화의 원화 가치 상승이다. JPY의 100엔 표시 배율은 로그수익률에서 소거된다.",
        "인접 반대 방향 10% 초과 급변은 호가 스파이크 후보로 제거한다. 이 규칙을 급변을 보존하는 환율전망 표본에 그대로 이식하지 않는다."
      ],
      "checks": [
        "유효 로그수익률 252개 경계와 관측 간 7일 초과 공백 제외를 점검한다.",
        "원화 환산 단위의 상수 배율을 바꿔도 변동성은 같고, 표본기간·제외 건수는 설명 가능해야 한다."
      ],
      "sources": [
        {
          "path": "pipeline/hedge.py",
          "symbols": [
            "build_fx_volatility",
            "despike"
          ]
        }
      ]
    },
    {
      "id": "merit",
      "title": "국채 메리트 · 표시용 3σ 정제",
      "formulas": [
        {
          "expression": "zₜ = (xₜ − mean(x)) / std표본(x)",
          "legend": "x: 외국채·국고채·3M 비용 각각의 전체 공통 일별 수준",
          "latex": String.raw`z_t=\frac{x_t-\bar x}{s(x)}`
        },
        {
          "expression": "x̃ₜ = (xₜ₋₁ + xₜ₊₁) / 2  if |zₜ| ≥ 3 and 고립·양옆 정상",
          "legend": "양옆이 연속 평일 관측일 때만 대체 · 나머지 이상치는 해당 행 제외",
          "latex": String.raw`\tilde x_t=\frac{x_{t-1}+x_{t+1}}{2}\quad\text{if }|z_t|\geq3\text{ and isolated}`
        },
        {
          "expression": "헤지 후 금리 = 외국 10년 금리 + 3M 비용; 메리트 = 헤지 후 금리 − 국고 10년 금리",
          "legend": "금리·비용: 연 % · 메리트: %p · UST는 SMB, JPY·AUD·GER는 HP 원호가",
          "latex": String.raw`y_H=y_{\mathrm{foreign},10Y}+c_{3M},\qquad M=y_H-y_{KR,10Y}`
        }
      ],
      "code": "daily = align_finite_weekday_bond_ktb_cost()\nfor column in daily:\n  flags = full_sample_level_z_at_least_3(column)\n  replace_isolated_adjacent_normal_neighbors(column, flags)\n  mark_other_flagged_values_missing(column, flags)\ndaily = drop_incomplete_rows(daily)\nweekly = last_observation_each_friday_week(daily)\nweekly = label_dates(weekly, \"W-FRI\" if market == UST else \"observed\")\npublish(hedged_yield_and_ktb_spread(weekly))",
      "note": "사후 차트 정제이며 다음 관측을 사용한다. 실시간 판정·백테스트·공분산·분포에는 재사용하지 않는다. 메리트는 총수익률이 아니다.",
      "purpose": "현재 금리와 헤지 캐리의 합을 국고채 금리와 비교하는 모니터링 지표를 만든다.",
      "decisions": [
        "외국채·국고채·3M 비용은 동일일 자료를 맞춘다. UST 비용은 SMB, JPY·AUD·GER는 HP로 원천이 다르다.",
        "3σ 정제는 전체 표본과 다음 관측을 사용하므로 사후 시각화 전용이다. 실제 의사결정 시점의 가용 정보처럼 재사용하면 안 된다.",
        "헤지 후 금리와 메리트는 총수익률이나 거래 가능한 차익거래 수익률을 뜻하지 않는다."
      ],
      "checks": [
        "고립된 이상치만 양옆 정상값으로 대체하고 연속 이상치는 누락 처리하는지 확인한다.",
        "국채금리·비용의 %와 메리트 %p를 구분하고, 정제 전 계열이 위험·분포 계산에 보존되는지 대조한다."
      ],
      "sources": [
        {
          "path": "pipeline/hedge.py",
          "symbols": [
            "clean_merit_daily",
            "build_bond_merit",
            "build_bond_merits"
          ]
        },
        {
          "path": "dashboard/app.js",
          "symbols": [
            "renderHedgeMeritChart"
          ]
        }
      ]
    },
    {
      "id": "distribution",
      "title": "과거 헤지비용 분포",
      "formulas": [
        {
          "expression": "구간 빈도ⱼ = 100 × 구간 j의 관측 수 / 전체 관측 수",
          "legend": "전체 가용 3M 원호가의 일별 빈도 % · 구간은 NumPy Freedman–Diaconis 규칙",
          "latex": String.raw`f_j=100\,\frac{n_j}{N_{\mathrm{full}}}`
        },
        {
          "expression": "zₜ = (cₜ − μ전체) / σ전체; 표시 범위 |zₜ| < 5",
          "legend": "전체 일별 평균·표본 표준편차(ddof=1) · 축 단위는 연 % 유지 · 상수·단일표본은 단일 구간",
          "latex": String.raw`z_t=\frac{c_t-\bar c_{\mathrm{full}}}{s(c)_{\mathrm{full}}},\qquad |z_t|<5`
        },
        {
          "expression": "과거 최저 = min(cₜ); 과거 최고 = max(cₜ)",
          "legend": "부호 있는 연 % · 더 큰 지불 비용은 더 음수인 관측",
          "latex": String.raw`c_{\min}=\min_t c_t,\qquad c_{\max}=\max_t c_t`
        }
      ],
      "code": "source = SMB_USD_3M if market == UST else HP_currency_3M\ndaily = finite_weekday_observations(source)\ndaily = keep_last_valid_observation_per_date(daily)\nif daily is empty: return inactive\nbins = histogram(daily, rule=\"fd\")\ndisplay_bins = clip_bin_edges_and_recount(daily, bins, abs_z_less_than=5)\npublish(bins, display_bins, full_sample_stats)\nplot_histogram(display_bins.low, display_bins.high, frequency_divided_by_full_n)\noverlay_current_mean_only_inside_display_bounds()",
      "note": "5σ 이상 꼬리는 화면에서만 생략하며 빈도를 재정규화하지 않는다. 전체 통계·표·CSV는 유지한다. 현재 평균선은 3개 만기, 과거 분포는 3M이다.",
      "purpose": "과거 3M 헤지 캐리의 빈도와 현재 3개 만기 평균의 위치를 함께 비교한다.",
      "decisions": [
        "분모는 전체 유효 관측수다. 화면에서 5σ 이상을 생략해도 남은 빈도를 100%로 다시 맞추지 않는다.",
        "현재 기준선은 3M·6M·12M 평균이고 과거 분포는 3M이다. 같은 상품·만기의 엄밀한 순위 비교로 해석하지 않는다."
      ],
      "checks": [
        "전체 구간 빈도 합은 100%이며, 잘린 화면 구간 합은 그 이하여야 한다.",
        "단일·상수 표본의 단일 구간, 마지막 상단 경계 포함, 표·CSV의 꼬리 관측 보존을 확인한다."
      ],
      "sources": [
        {
          "path": "pipeline/hedge.py",
          "symbols": [
            "build_cost_distribution"
          ]
        },
        {
          "path": "dashboard/app.js",
          "symbols": [
            "renderHedgeDistribution"
          ]
        }
      ]
    },
    {
      "id": "outlook",
      "title": "1년 범위 · 100% 헤지와 미헤지",
      "formulas": [
        {
          "expression": "D = [1 − (1 + y₀)⁻¹⁰] / y₀; y₀ = 0이면 D = 10",
          "legend": "y₀: 현재 10년 금리의 소수값 · D: 연 1회 이자 지급 액면채 수정듀레이션(년)",
          "latex": String.raw`D=\begin{cases}\dfrac{1-(1+y_0)^{-10}}{y_0},&y_0\ne0\\10,&y_0=0\end{cases}`
        },
        {
          "expression": "bₘ = −D × Δyₘ; fₘ = Δln(Sₘ); Σ = 12 × Cov표본(b, f)",
          "legend": "같은 관측일의 월간 금리·환율 충격 · 금리·수익률은 소수값 · D는 현재 값으로 고정",
          "latex": String.raw`b_m=-D\Delta y_m,\qquad f_m=\Delta\ln S_m,\qquad\Sigma=12\operatorname{Cov}_{N-1}(b,f)`
        },
        {
          "expression": "σH = 100√Σbb; σU = 100√(Σbb + 2Σbf + Σff); 감소 = σU − σH",
          "legend": "H: 100% 헤지 · U: 미헤지 · 연 σ: % · 감소: %p이며 음수도 가능",
          "latex": String.raw`\begin{aligned}\sigma_H&=100\sqrt{\Sigma_{bb}},\\\sigma_U&=100\sqrt{\Sigma_{bb}+2\Sigma_{bf}+\Sigma_{ff}},\\\Delta\sigma&=\sigma_U-\sigma_H\end{aligned}`
        },
        {
          "expression": "μH = 100y₀ + c̄; μU = 100y₀; 경로(τ) = μτ ± σ√τ",
          "legend": "τ = 0, 1/12, …, 1년 · 중심·상하단: 누적수익률 % · c̄는 현재 HP 3개 만기 평균",
          "latex": String.raw`\begin{aligned}\mu_H&=100y_0+\bar c,\quad\mu_U=100y_0,\\I(\tau)&=\mu\tau\pm\sigma\sqrt\tau,\quad\tau\in\{0,1/12,\ldots,1\}\end{aligned}`
        }
      ],
      "code": "current = latest_bond_yield_and_hp_curve()\nanchor = later_of(bond_last_date, hp_latest_date)  # 오늘 날짜 아님\nif any_current_input_age_from(anchor) > 7: return inactive\nmonthly = completed_month_last_joint_bond_and_despiked_fx(anchor)  # 기준월 제외\nmonthly = keep_month_end_lag_at_most_7_days(monthly)\nshocks = consecutive_month_shocks_at_current_duration(monthly)\nif count(shocks) < 36 or sample_age_from(anchor) > 62: return inactive\npaths = conditional_paths_for_months_0_to_12(current, annualize_covariance(shocks))\npublish(paths, risk_reduction, assumptions, sample_dates)\ndisplay_anchor = latest_finite_hedged_yield_point(market)\nalign_right_axis_zero_to_left_axis(display_anchor.yield)\nplot_unchanged_returns(paths, calendar_months_0_to_12(display_anchor.date))",
      "note": "각 시장 최근 헤지 후 금리 위치에서 시작하도록 날짜·우축 0%를 정렬한다. 추정 기준일·수익률은 유지하며 금리 전망이나 재추정이 아니다. 환율·금리 변화 기대 0, 현재 비용 고정, 월별 충격 무상관 가정. 확률 보장 구간이 아니며 볼록성·롤다운·거래비용·스왑 MTM을 제외한다.",
      "purpose": "공통 월간 채권·환율 충격으로 미헤지와 100% 헤지의 조건부 수익률 범위를 만든다.",
      "decisions": [
        "현재 국채금리와 세 HP 관측의 상대적 시차는 7일 이하여야 한다. 이 기준은 오늘 대비 최신성을 보장하지 않으므로 실제 기준일도 확인한다.",
        "기준월은 제외하고 월말 7일 이내 공동 관측과 연속 월간 충격만 사용한다. 최소 36개 충격과 기준일 대비 표본 종료 62일 이내가 필요하다.",
        "현재 수정듀레이션을 과거 전체 충격에 고정한다. 현재 금리·캐리 고정, 기대 FX·금리변화 0과 월 충격 무상관은 조건부 가정이다."
      ],
      "checks": [
        "0년 시점의 평균·범위는 0이고, 1년 시점은 게시 연 평균·변동성과 일치해야 한다.",
        "음의 채권·FX 공분산 사례에서 전액헤지가 위험을 높이는 결과를 보존하며 감소값을 0으로 자르지 않는다.",
        "기준월·미래 자료나 누락 월을 끼워 넣어 위험 표본을 늘리지 않는지 확인한다."
      ],
      "sources": [
        {
          "path": "pipeline/hedge.py",
          "symbols": [
            "par_modified_duration",
            "build_bond_outlook"
          ]
        },
        {
          "path": "dashboard/app.js",
          "symbols": [
            "renderHedgeMeritChart"
          ]
        }
      ]
    },
    {
      "id": "usd-cip",
      "title": "USD 모델A · 금리차와 헤지 프리미엄",
      "formulas": [
        {
          "expression": "F / S = (1 + rKR × τ) / (1 + rUS × τ)",
          "legend": "동일 만기·조달 조건의 단리 CIP · S/F: 현물/선물 원·달러 환율 · r: 소수 금리 · τ: 연 단위 만기",
          "latex": String.raw`\frac FS=\frac{1+r_{KR}\tau}{1+r_{US}\tau}`
        },
        {
          "expression": "p = 100 × (F / S − 1) / τ ≈ 100 × (rKR − rUS)",
          "legend": "연율 signed 프리미엄 % · 양수 수취, 음수 지불 · 금리차 일치는 1차 근사",
          "latex": String.raw`p=\frac{100}{\tau}\left(\frac FS-1\right)\approx100(r_{KR}-r_{US})`
        },
        {
          "expression": "Δₘ = 금리KR,ₘ − 금리US,ₘ; gₘ = p̄ − Δₘ",
          "legend": "m: PR·3M·1Y·2Y·3Y · 원금리 입력 연 % · p̄: 각 HP 3M·6M·12M의 과거 최대 5개 유효관측 중앙값을 소수 2자리 반올림한 뒤 단순평균 · g: %p",
          "latex": String.raw`\Delta_m=r_{KR,m}-r_{US,m},\qquad g_m=\bar p-\Delta_m`
        },
        {
          "expression": "현재 괴리 = 100 × g마지막; RMSE = 100 × √mean(g²); ρ = Corr(p̄, Δₘ)",
          "legend": "괴리·RMSE: bp · 선택기간 같은 날짜 유효쌍 · Pearson 수준 상관 · 회귀잔차나 예측오차 RMSE가 아님",
          "latex": String.raw`\begin{aligned}g_{\mathrm{last,bp}}&=100g_{\mathrm{last}},\\\mathrm{RMSE}_{bp}&=100\sqrt{\frac1N\sum_tg_t^2},\\\rho&=\operatorname{Corr}(\bar p,\Delta_m)\end{aligned}`
        },
        {
          "expression": "Z = (g마지막 − mean(g)) / s(g); s(g) = √[Σ(g − mean(g))² / (N − 1)]",
          "legend": "최신 관측을 포함한 선택기간의 괴리 · 표본 표준편차 · 무단위 · N < 2 또는 일정한 괴리는 계산하지 않음",
          "latex": String.raw`Z=\frac{g_{\mathrm{last}}-\bar g}{s(g)},\qquad s(g)=\sqrt{\frac{\sum_t(g_t-\bar g)^2}{N-1}}`
        }
      ],
      "code": "for date in observed_dates:\n  premium = mean(three_trailing_hp_medians_on_date)  # 세 원호가 모두 당일 관측\nfor tenor in PR, 3M, 1Y, 2Y, 3Y:\n  pairs = inner_join_by_date(premium, korean_rate, us_rate)  # 보간·앞채움 없음\n  selected = pairs_in_selected_period(pairs)\n  latest_inputs = last(selected.korean_rate, selected.us_rate, selected.spread, selected.premium)\n  gap_zscore = standardize_latest_gap(selected.gap, ddof=1)\n  publish(latest_inputs, correlation, latest_gap_bp, gap_zscore, identity_rmse_bp, sample, chart)",
      "note": "카드의 한국·미국 금리, 금리차, 헤지비용(평균)은 같은 최신 공통일 값이다. 헤지비용은 프리미엄 부호를 유지해 음수 지불·양수 수취로 표시한다. PR은 만기 조달금리가 아니며 국채금리와 평균 HP는 상품·만기가 다르다. 이 비교는 엄밀한 CIP 베이시스가 아니다. 만기별 가용 표본의 날짜·관측수를 표시한다. 수치 정밀도 범위 내 상수계열·표본 2개 미만은 상관을 비우며 괴리와 RMSE는 한 쌍부터 계산한다. Z Score는 괴리의 선택기간 내 상대적 위치이며 예측 신호·유의확률이 아니다. HP가 없으면 금리차 프록시나 SMB로 대체하지 않는다. 과거 방향 중앙값으로 미래 관측을 쓰지 않는다.",
      "purpose": "CIP 이론식과 화면의 금리차·헤지 프리미엄 비교가 일치하는 범위와 차이를 명확히 한다.",
      "decisions": [
        "이론식은 동일 만기·동일 조달 조건을 요구한다. 화면의 PR·국채금리와 평균 HP는 상품과 만기가 달라 엄밀한 CIP 베이시스가 아니다.",
        "한미 금리차는 한국−미국, 괴리는 프리미엄−금리차다. 수식의 p는 프리미엄이며 B·C의 h(헤지비율)와 구분한다.",
        "회귀를 적합하지 않는다. 상관은 수준 상관, RMSE는 1:1 일치선과의 괴리, Z는 선택기간 내 상대적 위치다."
      ],
      "checks": [
        "동일일 세 HP 원호가와 양국 금리가 모두 존재하는 행만 남고 보간·앞채움·SMB 대체가 없는지 점검한다.",
        "괴리 %p에 100을 곱하면 bp이며 N<2 또는 상수 괴리에서 Z는 비워야 한다.",
        "기간을 바꾸면 카드·통계·차트·CSV가 같은 만기별 표본을 사용하는지 확인한다."
      ],
      "sources": [
        {
          "path": "pipeline/hedge_cip.py",
          "symbols": [
            "build"
          ]
        },
        {
          "path": "dashboard/hedge-cip.js",
          "symbols": [
            "hedgeCipStats",
            "hedgeCipSelection",
            "renderHedgeCip"
          ]
        }
      ]
    },
    {
      "id": "hedge-model-b",
      "title": "환헤지모델B · 비용·위험과 헤지비율",
      "formulas": [
        {
          "expression": "R(h) ≈ b + (1−h)f + hc; μ(h) = y + (1−h)μFX + hc",
          "legend": "h: 헤지비율 · b: 현지 채권수익 · f: 원화 표시 외화수익 · y: 현재 국채금리 · c: signed HP 평균(양수 수취·음수 지불) · μFX: 사용자 환율변화 가정 · 모든 계산은 연 소수수익률",
          "latex": String.raw`\begin{aligned}R(h)&\approx b+(1-h)f+hc,\\\mu(h)&=y+(1-h)\mu_{FX}+hc\end{aligned}`
        },
        {
          "expression": "V(h) = Σbb + 2(1−h)Σbf + (1−h)²Σff; σ(h) = √V(h)",
          "legend": "동일 관측일의 월간 금리·FX 충격 표본 공분산 × 12 · 현재 듀레이션 고정 · 자연헤지에 따라 전액헤지가 총위험을 높일 수 있음",
          "latex": String.raw`V(h)=\Sigma_{bb}+2(1-h)\Sigma_{bf}+(1-h)^2\Sigma_{ff},\qquad\sigma(h)=\sqrt{V(h)}`
        },
        {
          "expression": "hMV = clip(1 + Σbf/Σff, hmin, hmax)",
          "legend": "Σff > 0일 때의 최소분산 해 · 고정 헤지비용은 최소분산 해에 영향 없음",
          "latex": String.raw`h_{MV}=\operatorname{clip}\!\left(1+\frac{\Sigma_{bf}}{\Sigma_{ff}},h_{\min},h_{\max}\right)`
        },
        {
          "expression": "CE(h) = μ(h) − λV(h)/2; hCE = clip(1 + Σbf/Σff + (c−μFX)/(λΣff), hmin, hmax)",
          "legend": "λ > 0: 사용자 위험회피도(기본 5는 가정) · 입력 연 %는 100으로 나눈 뒤 계산 · CE 출력 %는 100배 · 비용 반영 비율은 이 목적함수 아래의 조건부 해",
          "latex": String.raw`\begin{aligned}CE(h)&=\mu(h)-\frac\lambda2V(h),\\h_{CE}&=\operatorname{clip}\!\left(1+\frac{\Sigma_{bf}}{\Sigma_{ff}}+\frac{c-\mu_{FX}}{\lambda\Sigma_{ff}},h_{\min},h_{\max}\right)\end{aligned}`
        },
        {
          "expression": "위험감소(h) = 100[σ(0)−σ(h)]; 헤지 캐리(h) = 100hc",
          "legend": "위험감소 %p · 캐리 연 % · 감소값은 음수 허용 · 최소분산·비용 반영·0/50/100%·현재 비율 모두 같은 표본 사용",
          "latex": String.raw`\Delta\sigma(h)=100[\sigma(0)-\sigma(h)],\qquad\operatorname{Carry}(h)=100hc`
        }
      ],
      "code": "outlook = published_bond_analytics[selected_market].outlook\nif inactive_or_missing_required_inputs(outlook): return unavailable_with_reason\nvalidate_options_and_covariance_units_symmetry_PSD()\nconvert_percent_yield_carry_fx_to_decimal_returns()\nif fx_variance_is_zero: mark_flat_risk_and_choose_return_boundary_or_tie\nelse: compute_closed_form_minimum_variance_and_CE_solutions()\nclip_solutions_to_user_minimum_and_maximum_hedge_bounds()\nevaluate_current_zero_half_full_minimum_variance_and_cost_adjusted()\nevaluate_0_to_100_percent_grid_and_fx_scenarios_minus2_to_plus2_pp()\nrender_cards_charts_table_and_raw_precision_CSV_from_same_results()\nsave_only_valid_user_assumptions_locally_on_apply()",
      "note": "UST·JPY·AUD·GER 각각의 단일시장 조건부 비교이며 시장 간 공분산을 이용한 통합 포트폴리오 최적화가 아니다. 현재 HP 3개 만기 평균을 1년 고정하고 채권금리 변화 기대는 0으로 둔다. FX변화 기본 0은 예측치가 아니다. 실제 총수익률·볼록성·롤다운·거래비용·선물 MTM·표본외 성과를 포함하지 않는다. FX분산이 0이면 최소분산 해는 동률이며 하한은 계산상 대표값이다. 현재비율과 0/50/100% 비교값은 사용자 제약 밖이어도 참고용으로 남긴다.",
      "purpose": "사용자의 연 FX 변화·위험회피 가정 아래 단일시장의 비용과 총위험을 함께 고려한 헤지비율을 구한다.",
      "decisions": [
        "브라우저에서 적용한 입력만 계산에 쓴다. 위험회피계수 기본 5와 FX 변화 기본 0은 추정 결과가 아니다.",
        "게시 공분산은 연 소수수익률 제곱 단위다. 화면 연 % 입력을 한 번만 100으로 나눈 후 목적함수를 계산한다.",
        "FX 분산이 0이면 최소분산 해는 비식별이다. 캐리와 예상 FX가 같으면 CE도 동률이며 대표 하한값을 고유 최적해로 설명하지 않는다.",
        "UST·JPY·AUD·GER는 각각 계산한다. 여러 시장을 함께 최적화하거나 자산배분 비중을 자동 변경하는 엔진이 아니다."
      ],
      "checks": [
        "무제약 내부해는 목적함수 미분 0, 제약 밖 해는 경계값이며 독립 격자 탐색과 같은 최대 CE를 갖는지 확인한다.",
        "h=0과 h=1의 위험은 기존 미헤지·전액헤지 모멘트와 일치해야 한다.",
        "공분산 단위·대칭·PSD가 잘못되면 계산을 중단하고, 현재·0/50/100% 비교의 제약 위반 표시는 유지한다."
      ],
      "sources": [
        {
          "path": "dashboard/hedge-optimizer.js",
          "symbols": [
            "hedgeModelBCompute",
            "hedgeModelBValidateOptions"
          ]
        },
        {
          "path": "dashboard/hedge-model-b.js",
          "symbols": [
            "renderHedgeModelB"
          ]
        }
      ]
    },
    {
      "id": "hedge-model-c",
      "title": "환헤지모델C · 역사적 꼬리손실과 재조정",
      "formulas": [
        {
          "expression": "bᵢ = −D현재 Δyᵢ; fᵢ = 100 ln(Sᵢ/Sᵢ₋₁); b̃ᵢ,w = bᵢ−meanw(b); f̃ᵢ,w = fᵢ−meanw(f)",
          "legend": "동일일 월간 채권·FX 충격을 전체·최근120개 유효 관측 창별로 중심화 · b·f와 금리변화는 % 단위 · 현재 듀레이션 고정",
          "latex": String.raw`\begin{aligned}b_i&=-D_{\mathrm{current}}\Delta y_i,\quad f_i=100\ln(S_i/S_{i-1}),\\\tilde b_{i,w}&=b_i-\bar b_w,\quad\tilde f_{i,w}=f_i-\bar f_w\end{aligned}`
        },
        {
          "expression": "Rᵢ,w(h) = y/12 + b̃ᵢ,w + (1−h)f̃ᵢ,w + hc/12; Lᵢ,w = −Rᵢ,w",
          "legend": "h: 0~1 헤지비율 · y·c: 연 % · c는 양수 수취 · 1개월 선형 수익률 근사 · 역사적 평균을 환율 예측으로 사용하지 않음",
          "latex": String.raw`R_{i,w}(h)=\frac y{12}+\tilde b_{i,w}+(1-h)\tilde f_{i,w}+\frac{hc}{12},\qquad L_{i,w}(h)=-R_{i,w}(h)`
        },
        {
          "expression": "ES95,w(h) = minη {η + Σᵢ max(Lᵢ,w(h)−η,0)/(0.05nw)}",
          "legend": "정확히 최악 5%의 경험적 확률질량 평균 · 경계 관측은 부분 가중 · ES 음수 허용 · 정규근사·최대손실 아님",
          "latex": String.raw`ES_{.95,w}(h)=\min_\eta\left[\eta+\frac{\sum_{i=1}^{n_w}\max(L_{i,w}(h)-\eta,0)}{0.05n_w}\right]`
        },
        {
          "expression": "J(h) = max(ES95,전체(h), ES95,최근120(h)) + hs/12 + (k/100)|h−h₀|",
          "legend": "s: 비음수 캐리 악화 연 %p · k: 재조정 명목금액 대비 bp · 조정비용은 한 번만 적용 · 두 창의 최댓값은 설계 가정",
          "latex": String.raw`J(h)=\max\{ES_{.95,\mathrm{full}}(h),ES_{.95,120}(h)\}+\frac{hs}{12}+\frac k{100}|h-h_0|`
        },
        {
          "expression": "hC = argmin격자 J(h); hmin ≤ h ≤ hmax; 100|h−h₀| ≤ 최대조정폭(%p)",
          "legend": "1%p 격자 · 동률은 현재비율에 가까운 후보, 이후 낮은 비율 · 설정은 B와 별도 · 미식별 동률을 통계적 확신으로 해석하지 않음",
          "latex": String.raw`\begin{aligned}h_C&\in\operatorname*{arg\,min}_{h\in\{0,.01,\ldots,1\}}J(h),\\h_{\min}&\leq h\leq h_{\max},\qquad100|h-h_0|\leq\Delta h_{\max,pp}\end{aligned}`
        }
      ],
      "code": "reuse_exact_joint_monthly_shocks_and_current_yield_HP_anchor()\nrequire_120_valid_months_and_existing_input_freshness_gates()\nfor window in [full_sample, last_120_valid_observations]:\n  center_bond_and_FX_shocks_within_window()\n  compute_ES95_for_hedge_grid_0_to_100_with_fractional_tail_mass()\npublish_only_aggregate_tail_curves_and_sample_metadata()\nvalidate_independent_C_options_and_nonempty_feasible_grid()\nadd_carry_stress_and_one_off_turnover_cost_to_worst_window_ES()\nselect_lowest_objective_then_nearest_current_then_lower_ratio()\nkeep_C_unavailable_if_tail_payload_is_missing_or_invalid()\nproject_selected_ratio_separately_with_Gaussian_moments_for_quarterly_summary()",
      "note": "Rockafellar–Uryasev (2000, 2002)의 경험적 CVaR 정의를 사용하며, Lettau–Maggiori–Weber (2014)는 하방 위험을 별도로 보는 근거다. 전체·최근 창, 캐리 스트레스와 비용·조정 제약은 자체 설계다. Randl et al. (2025)의 회귀 직교화나 SDF를 재현하지 않는다. A는 투자비율 정책이 아니며 B·C는 원자료·정제·현재 듀레이션을 공유한다. 통계적 직교성·OOS 우월성 미검증. Jansen et al. (2026)의 담보·유동성 위험은 MTM 자료가 없어 제외한다. 출처·단위·가정은 docs/HEDGE_MODEL_C.md.",
      "purpose": "평균분산과 다른 손실 기준인 1개월 경험 ES95에 캐리 악화·재조정 비용을 더해 헤지비율을 선택한다.",
      "decisions": [
        "전체와 최근 120개 유효 월간 충격을 각 창 안에서 별도 중심화한다. 최근 120개는 달력상 연속 10년을 보장하지 않는다.",
        "ES는 최악 5%의 정확한 확률질량 평균이다. 경계 관측을 부분 가중하고 음수 ES도 보존한다.",
        "캐리 악화 s는 비음수 연 %p 입력이며 월 손실에 h×s/12를 더한다. bp 조정비용은 변경 명목에 한 번만 적용한다.",
        "1%p 격자·비율 상하한·최대 조정폭을 동시에 만족해야 한다. 동률은 현재비율에 가까운 값, 이후 낮은 값이며 고유해 여부도 별도 표시한다."
      ],
      "checks": [
        "독립 CVaR 변분식과 정렬 기반 ES가 분수 꼬리·동률 손실에서도 같은지 검증한다.",
        "전체·최근 창의 큰 ES를 썼는지, 비용 bp→% 변환과 월/연 단위가 한 번씩 적용되는지 확인한다.",
        "120개 미만·비어 있는 실행 가능 격자·잘못된 기준일은 C만 비활성화하고 B의 가정으로 대체하지 않는다."
      ],
      "sources": [
        {
          "path": "pipeline/hedge_tail.py",
          "symbols": [
            "build_tail_risk",
            "expected_shortfall"
          ]
        },
        {
          "path": "dashboard/hedge-tail-optimizer.js",
          "symbols": [
            "hedgeModelCCompute",
            "hedgeModelCValidateOptions"
          ]
        }
      ]
    },
    {
      "id": "hedge-quarterly-summary",
      "title": "요약카드 · 선택 헤지비율의 누적수익률",
      "purpose": "A의 전액헤지 참고안과 B·C의 선택 비율을 고정해 3/6/9/12개월 누적수익률 시나리오로 전달한다.",
      "formulas": [
        {
          "expression": "μH = μ연 × H/12 − K; σH = σ연 × √(H/12)",
          "latex": String.raw`\mu_H=\mu_{\mathrm{ann}}\frac H{12}-K,\qquad\sigma_H=\sigma_{\mathrm{ann}}\sqrt{\frac H{12}}`,
          "legend": "H=3/6/9/12개월 · 누적수익률 % · K는 C의 최초 조정비용(%)이며 A/B는 0 · C의 연 평균에는 캐리 스트레스를 이미 반영"
        },
        {
          "expression": "I95 = μH ± 1.95996398454σH; VaR97.5% = max(0, −하단95%)",
          "latex": String.raw`I_{95,H}=\mu_H\pm1.95996398454\sigma_H,\qquad\operatorname{VaR}_{.975}=\max(0,-I_{95,H}^{\mathrm{lower}})`,
          "legend": "고정 금리·캐리·FX가정·공분산·헤지비율의 정규근사 · 초기 원화 투자금 대비 누적손실 · 월간 ES나 비율 신뢰구간과 다름"
        }
      ],
      "code": "read_published_outlook_and_market_specific_applied_B_C_options()\nA = full_hedge_reference; B = existing_CE_optimum\nC = independent_ES_policy_with_its_own_bounds_and_turnover_limit()\nC_annual_moments = shared_covariance_at_C_ratio_with_zero_FX_and_stressed_carry()\nfor horizon in [3,6,9,12]:\n  scale_mean_by_time_and_volatility_by_sqrt_time()\n  subtract_C_initial_turnover_cost_once_from_each_cumulative_horizon()\n  suppress_elapsed_target_dates_and_publish_normal_95_bounds_and_VaR()\nretain_nonidentified_B_ratio_as_unavailable_and_disclose_C_tie_rule()",
      "note": "A는 CIP의 미래 예측이 아닌 100% 헤지 참고안이다. C는 월간 경험 ES로 비율을 정한 뒤 공분산 정규근사로 별도 요약하므로 월간 ES를 분기 VaR로 환산한 값이 아니다. 분기 전망은 다음 분기말이 아니라 원래 기준일에 달력개월을 더한 날짜다.",
      "decisions": [
        "B의 가정·제약과 C의 가정·제약을 분리한다. C는 예상 FX=0이며 B의 위험회피·FX 예상 입력을 물려받지 않는다.",
        "C 최초 조정비용은 각 지평의 누적수익률에서 한 번만 차감한다. 매월 또는 매분기 반복 차감하지 않는다.",
        "B 비식별이면 비율을 비우고, C의 복수 최소해는 명시된 동률 규칙으로 정한 행동과 고유해 여부를 구분한다."
      ],
      "checks": [
        "0 비용·스트레스 사례에서 B 공통 엔진의 해당 비율 모멘트와 C 요약 모멘트가 일치하는지 대조한다.",
        "기준일과 3/6/9/12개월 목표일, 비용 차감 횟수, σ의 제곱근 시간 스케일을 확인한다.",
        "전체 파이프라인 기준일이 오래된 경우 조회 시점보다 과거인 목표행을 새 전망으로 노출하지 않는다."
      ],
      "sources": [
        {
          "path": "dashboard/summary-hedge.js",
          "symbols": [
            "summaryHedgeModels"
          ]
        }
      ]
    }
  ],
  "readingGuide": [
    "먼저 signed 캐리와 원천·기준일을 확인하고, 모니터링용 정제와 위험 추정용 표본을 구분한다.",
    "A는 금리차 진단, B는 평균분산 선택, C는 경험 꼬리손실 선택이다. 같은 A/B/C 문자라도 환율전망 모형과 별개다.",
    "선택 비율은 사용자 가정에 따른 참고 결과다. 다른 모듈의 비중·주문에 자동 적용되는 것으로 인수인계하지 않는다."
  ]
};
