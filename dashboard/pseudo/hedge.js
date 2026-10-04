globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.hedge = {
  id: 'hedge',
  title: '환헤지',
  updated: '2026-10-04',
  summary: '현재 비용 → 환 변동성 → 국채 메리트 → 과거 분포 → 1년 조건부 범위',
  inputs: 'HP 3M·6M·12M, SMB USD 3M, 10년 국채금리: 연 % · 환율: 외화당 원(JPY는 100엔당 원)',
  outputs: '비용·금리·연 변동성: % · 메리트·변동성 감소: %p · 국채 1년 경로: 누적수익률 % · 환율전망: 원/달러',
  sources: [
    { path: 'pipeline/common.py', symbols: ['hp_curve'] },
    { path: 'pipeline/hedge.py', symbols: ['build', 'build_fx_volatility', 'despike', 'clean_merit_daily', 'build_bond_merit', 'build_bond_merits', 'build_cost_distribution', 'par_modified_duration', 'build_bond_outlook'] },
    { path: 'dashboard/app.js', symbols: ['hedgeCostSnapshot', 'renderHedgeDistribution', 'renderHedgeMeritChart'] },
    { path: 'pipeline/fx_outlook.py', symbols: ['build'] },
    { path: 'dashboard/fx-outlook.js', symbols: ['fxOutlookQuarters', 'fxOutlookSelection', 'renderFxOutlook'] }
  ],
  sections: [
    {
      id: 'cost',
      title: '헤지비용 · 부호와 평균',
      formulas: [
        { expression: 'cₘ = round₂(median(만기 m의 최근 최대 5개 유효 HP 관측))', legend: 'm = 3M·6M·12M · c: 연 % · 양수는 받음, 음수는 지불' },
        { expression: 'c̄ = (c₃ᴹ + c₆ᴹ + c₁₂ᴹ) / 3', legend: '각 만기의 중앙값을 소수 2자리 반올림한 뒤 단순평균' },
        { expression: 'c프록시 = 한국 3개월 금리 − 해당국 3개월 금리', legend: 'HP 커브가 없고 금리차 관측이 있을 때만 사용 · 연 %' }
      ],
      code: `for currency in USD, AUD, JPY, EUR:
  curve = hp_curve(currency, window=5)
  if curve is missing:
    curve = rate_difference_proxy_if_available(currency)
  snapshot = read_three_tenors(curve)
  mean = mean_if_all_three_present(snapshot)
  publish(snapshot, mean, source, tenor_dates)`,
      note: 'USD 과거 이력은 SMB 3M, 현재 비용은 HP다. 1년 범위는 HP가 없으면 계산하지 않는다.'
    },
    {
      id: 'fx-volatility',
      title: '장기 환 변동성',
      formulas: [
        { expression: 'rₜ = ln(Sₜ / Sₜ₋₁)', legend: 'S: 원화 표시 환율 · 인접 유효 관측 간 로그수익률' },
        { expression: 'σFX = 100 × std표본(r) × √252', legend: '전체 가용 이력 · 표본 표준편차 ddof=1 · 연 %' }
      ],
      code: `levels = positive_finite_weekday_levels(source)
levels = keep_last_valid_observation_per_date(levels)
levels = remove_opposite_moves_over_10pct(levels)
returns = log_returns(levels)
returns = keep_calendar_gaps_between_1_and_7_days(returns)
if count(returns) < 252: return inactive
publish(annual_sample_volatility(returns), sample_dates)`,
      note: '10% 초과 급변 뒤 반대 방향 10% 초과 변동은 단일 스파이크로 제거한다. σFX는 포트폴리오 위험 감소량이 아니다.'
    },
    {
      id: 'merit',
      title: '국채 메리트 · 표시용 3σ 정제',
      formulas: [
        { expression: 'zₜ = (xₜ − mean(x)) / std표본(x)', legend: 'x: 외국채·국고채·3M 비용 각각의 전체 공통 일별 수준' },
        { expression: 'x̃ₜ = (xₜ₋₁ + xₜ₊₁) / 2  if |zₜ| ≥ 3 and 고립·양옆 정상', legend: '양옆이 연속 평일 관측일 때만 대체 · 나머지 이상치는 해당 행 제외' },
        { expression: '헤지 후 금리 = 외국 10년 금리 + 3M 비용; 메리트 = 헤지 후 금리 − 국고 10년 금리', legend: '금리·비용: 연 % · 메리트: %p · UST는 SMB, JPY·AUD·GER는 HP 원호가' }
      ],
      code: `daily = align_finite_weekday_bond_ktb_cost()
for column in daily:
  flags = full_sample_level_z_at_least_3(column)
  replace_isolated_adjacent_normal_neighbors(column, flags)
  mark_other_flagged_values_missing(column, flags)
daily = drop_incomplete_rows(daily)
weekly = last_observation_each_friday_week(daily)
weekly = label_dates(weekly, "W-FRI" if market == UST else "observed")
publish(hedged_yield_and_ktb_spread(weekly))`,
      note: '사후 차트 정제이며 다음 관측을 사용한다. 실시간 판정·백테스트·공분산·분포에는 재사용하지 않는다. 메리트는 총수익률이 아니다.'
    },
    {
      id: 'distribution',
      title: '과거 헤지비용 분포',
      formulas: [
        { expression: '구간 빈도ⱼ = 100 × 구간 j의 관측 수 / 전체 관측 수', legend: '전체 가용 3M 원호가의 일별 빈도 % · 구간은 NumPy Freedman–Diaconis 규칙' },
        { expression: 'zₜ = (cₜ − μ전체) / σ전체; 표시 범위 |zₜ| < 5', legend: '전체 일별 평균·표본 표준편차(ddof=1) · 축 단위는 연 % 유지 · 상수·단일표본은 단일 구간' },
        { expression: '과거 최저 = min(cₜ); 과거 최고 = max(cₜ)', legend: '부호 있는 연 % · 더 큰 지불 비용은 더 음수인 관측' }
      ],
      code: `source = SMB_USD_3M if market == UST else HP_currency_3M
daily = finite_weekday_observations(source)
daily = keep_last_valid_observation_per_date(daily)
if daily is empty: return inactive
bins = histogram(daily, rule="fd")
display_bins = clip_bin_edges_and_recount(daily, bins, abs_z_less_than=5)
publish(bins, display_bins, full_sample_stats)
plot_solid_line(bin_midpoints(display_bins), frequency_divided_by_full_n)
overlay_current_mean_only_inside_display_bounds()`,
      note: '5σ 이상 꼬리는 화면에서만 생략하며 빈도를 재정규화하지 않는다. 전체 통계·표·CSV는 유지한다. 현재 평균선은 3개 만기, 과거 분포는 3M이다.'
    },
    {
      id: 'outlook',
      title: '1년 범위 · 100% 헤지와 미헤지',
      formulas: [
        { expression: 'D = [1 − (1 + y₀)⁻¹⁰] / y₀; y₀ = 0이면 D = 10', legend: 'y₀: 현재 10년 금리의 소수값 · D: 연 1회 이자 지급 액면채 수정듀레이션(년)' },
        { expression: 'bₘ = −D × Δyₘ; fₘ = Δln(Sₘ); Σ = 12 × Cov표본(b, f)', legend: '같은 관측일의 월간 금리·환율 충격 · 금리·수익률은 소수값 · D는 현재 값으로 고정' },
        { expression: 'σH = 100√Σbb; σU = 100√(Σbb + 2Σbf + Σff); 감소 = σU − σH', legend: 'H: 100% 헤지 · U: 미헤지 · 연 σ: % · 감소: %p이며 음수도 가능' },
        { expression: 'μH = 100y₀ + c̄; μU = 100y₀; 경로(τ) = μτ ± σ√τ', legend: 'τ = 0, 1/12, …, 1년 · 중심·상하단: 누적수익률 % · c̄는 현재 HP 3개 만기 평균' }
      ],
      code: `current = latest_bond_yield_and_hp_curve()
anchor = later_of(bond_last_date, hp_latest_date)  # 오늘 날짜 아님
if any_current_input_age_from(anchor) > 7: return inactive
monthly = completed_month_last_joint_bond_and_despiked_fx(anchor)  # 기준월 제외
monthly = keep_month_end_lag_at_most_7_days(monthly)
shocks = consecutive_month_shocks_at_current_duration(monthly)
if count(shocks) < 36 or sample_age_from(anchor) > 62: return inactive
paths = conditional_paths_for_months_0_to_12(current, annualize_covariance(shocks))
publish(paths, risk_reduction, assumptions, sample_dates)
display_anchor = latest_finite_hedged_yield_point(market)
align_right_axis_zero_to_left_axis(display_anchor.yield)
plot_unchanged_returns(paths, calendar_months_0_to_12(display_anchor.date))`,
      note: '각 시장 최근 헤지 후 금리 위치에서 시작하도록 날짜·우축 0%를 정렬한다. 추정 기준일·수익률은 유지하며 금리 전망이나 재추정이 아니다. 환율·금리 변화 기대 0, 현재 비용 고정, 월별 충격 무상관 가정. 확률 보장 구간이 아니며 볼록성·롤다운·거래비용·스왑 MTM을 제외한다.'
    },
    {
      id: 'fx-outlook',
      title: '환율전망 · 전체 표본과 1년 범위',
      formulas: [
        { expression: 'rₜ = ln(Sₜ / Sₜ₋₁); σ = std표본(r) × √252', legend: 'S: 원/달러 · σ: 소수 단위 연 로그변동성 · 전체 가용 일별 표본, ddof=1' },
        { expression: '하단(τ) = S₀ exp(−σ√τ); 기준(τ) = S₀; 상단(τ) = S₀ exp(+σ√τ)', legend: '파란 범위 · τ = 0, 1/12, …, 1년 · S₀: 최신 유효 호가 · 기준은 조건부 중앙값, 산술 기대값 아님' }
      ],
      code: `levels = full_positive_finite_weekday_bb_usdkrw()
if levels are empty: levels = explicit_info_usdkrw_fallback()
levels = keep_last_valid_observation_per_date(levels)  # 급등락 유지
returns = log_returns_with_calendar_gap_between_1_and_7_days(levels)
publish(full_history, source, sample_dates)
if count(returns) >= 252:
  range = latest_quote_times_exp_plus_minus_sigma_sqrt_time(months=0..12)
  publish(range)
plot_history_and_unchanged_blue_range()`,
      note: 'Bloomberg 전체 계열이 정본이며 원천을 이어 붙이지 않는다. 표시기간·분기 수·컨센서스 입력은 파란 1년 범위를 재추정하지 않는다. 로그 추세 0·충격 무상관·고정 변동성 근사이며 보정된 예측구간이나 경로 전체의 확률 보장이 아니다. 급변값을 삭제하는 환헤지 σ와 정제 정책이 다르다.'
    },
    {
      id: 'fx-consensus',
      title: '환율전망 · 분기 컨센서스',
      formulas: [
        { expression: 'μq = Σᵢ xq,i / Nq; σq = √[Σᵢ(xq,i − μq)² / Nq]', legend: 'xq,i: 분기 q의 유효 양수 입력(원/달러) · 동일 가중 평균 · σq: 입력 수준의 모집단 표준편차, 평균 표준오차 아님' },
        { expression: '컨센서스 하단q = μq − σq; 상단q = μq + σq', legend: '붉은 범위 · Nq ≥ 2인 인접 분기 사이 선형 보간 · 최신 관측에서 폭 0 · 빈 분기나 단일 입력에서는 범위를 끊음' }
      ],
      code: `state = load_v2_or_migrate_v1_forecasts_to_first_inputs()
quarters = next_quarter_ends_after(max(latest_quote_date, today_KST), count=1..12)
for quarter in quarters:
  inputs = valid_positive_inputs_from_numbered_rows(state[quarter])
  mean, sigma = arithmetic_mean_and_population_sd(inputs)
  emit_mean_point(mean)
  if count(inputs) >= 2: emit_consensus_bounds(mean, sigma)
red_band = interpolate_adjacent_valid_bounds_from_zero_width_latest_anchor()
break_red_band_at_empty_or_single_input_quarters()
plot(history, blue_1year_range, consensus_mean_points, red_band)
display_fx_as_integers_without_rounding_calculations_or_raw_csv()
persist_arrays_and_quarter_count_in_browser_only(keep_hidden_quarters=True)`,
      note: '붉은 σ는 입력된 전망 수준의 괴리로 σ/√N이나 예측오차가 아니며, 같은 입력 2개는 σ=0이다. 각 유효 분기에 ±σ 세로선도 표시하여 고립된 분기의 괴리를 보여준다. 첫 분기에 범위가 있으면 최신 관측에서 폭 0으로 연결한다. 보정된 예측구간이 아니며 파란 1년 범위와 합산하지 않는다. 입력은 브라우저에만 저장한다. 기본 6개 분기이며 축소 후 숨긴 값도 보존한다. 환율은 정수로 표시하고 계산·저장·raw CSV는 원래 정밀도를 유지한다.'
    }
  ]
};
