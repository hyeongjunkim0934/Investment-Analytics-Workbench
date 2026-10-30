globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.hedge = {
  id: 'hedge',
  title: '환헤지',
  updated: '2026-10-30',
  summary: '모니터링: 비용·환 변동성·국채 메리트 · 모델A: USD 금리차와 헤지 프리미엄 · 모델B: 단일시장 헤지비율별 비용·위험 비교 · 환율전망: 컨센서스·3국면 마코브(A)·LSTM/XGBoost walk-forward(B)',
  inputs: 'HP 3M·6M·12M, SMB USD 3M, 10년 국채금리: 연 % · 환율: 외화당 원(JPY는 100엔당 원)',
  outputs: '비용·금리·연 변동성: % · 메리트·변동성 감소: %p · 국채 1년 경로: 누적수익률 % · 환율전망: 원/달러',
  sources: [
    { path: 'dashboard/hedge-optimizer.js', symbols: ['hedgeModelBCompute', 'hedgeModelBValidateOptions'] },
    { path: 'dashboard/hedge-model-b.js', symbols: ['renderHedgeModelB'] },
    { path: 'pipeline/hedge_cip.py', symbols: ['build'] },
    { path: 'dashboard/hedge-cip.js', symbols: ['hedgeCipStats', 'hedgeCipSelection', 'renderHedgeCip'] },
    { path: 'pipeline/common.py', symbols: ['hp_curve'] },
    { path: 'pipeline/hedge.py', symbols: ['build', 'build_fx_volatility', 'despike', 'clean_merit_daily', 'build_bond_merit', 'build_bond_merits', 'build_cost_distribution', 'par_modified_duration', 'build_bond_outlook'] },
    { path: 'dashboard/app.js', symbols: ['hedgeCostSnapshot', 'renderHedgeDistribution', 'renderHedgeMeritChart'] },
    { path: 'pipeline/fx_outlook.py', symbols: ['build'] },
    { path: 'pipeline/fx_markov.py', symbols: ['build', 'fit_markov', 'hamilton_filter', 'forecast_moments'] },
    { path: 'pipeline/fx_simulation.py', symbols: ['simulate_markov_paths', 'summarize_paths', 'forecast'] },
    { path: 'dashboard/fx-markov.js', symbols: ['renderFxMarkov'] },
    { path: 'pipeline/fx_lstm_xgb.py', symbols: ['load', 'validate', 'skeleton'] },
    { path: 'pipeline/research/fx_lstm_xgb_runner.py', symbols: ['join_bop', 'ns_factors', 'arma_factors', 'walk_forward', 'summarize'] },
    { path: 'dashboard/fx-lstm-xgb.js', symbols: ['renderFxLstmXgb', 'fxLxMetrics', 'fxLxValid'] },
    { path: 'dashboard/fx-outlook.js', symbols: ['fxOutlookQuarters', 'fxOutlookSelection', 'renderFxOutlook'] }
  ],
  sections: [
    {
      id: 'hedge-model-b',
      title: '환헤지모델B · 비용·위험과 헤지비율',
      formulas: [
        { expression: 'R(h) ≈ b + (1−h)f + hc; μ(h) = y + (1−h)μFX + hc', legend: 'h: 헤지비율 · b: 현지 채권수익 · f: 원화 표시 외화수익 · y: 현재 국채금리 · c: signed HP 평균(양수 수취·음수 지불) · μFX: 사용자 환율변화 가정 · 모든 계산은 연 소수수익률' },
        { expression: 'V(h) = Σbb + 2(1−h)Σbf + (1−h)²Σff; σ(h) = √V(h)', legend: '동일 관측일의 월간 금리·FX 충격 표본 공분산 × 12 · 현재 듀레이션 고정 · 자연헤지에 따라 전액헤지가 총위험을 높일 수 있음' },
        { expression: 'hMV = clip(1 + Σbf/Σff, hmin, hmax)', legend: 'Σff > 0일 때의 최소분산 해 · 고정 헤지비용은 최소분산 해에 영향 없음' },
        { expression: 'CE(h) = μ(h) − λV(h)/2; hCE = clip(1 + Σbf/Σff + (c−μFX)/(λΣff), hmin, hmax)', legend: 'λ > 0: 사용자 위험회피도(기본 5는 가정) · 입력 연 %는 100으로 나눈 뒤 계산 · CE 출력 %는 100배 · 비용 반영 비율은 이 목적함수 아래의 조건부 해' },
        { expression: '위험감소(h) = 100[σ(0)−σ(h)]; 헤지 캐리(h) = 100hc', legend: '위험감소 %p · 캐리 연 % · 감소값은 음수 허용 · 최소분산·비용 반영·0/50/100%·현재 비율 모두 같은 표본 사용' }
      ],
      code: `outlook = published_bond_analytics[selected_market].outlook
if inactive_or_missing_required_inputs(outlook): return unavailable_with_reason
validate_options_and_covariance_units_symmetry_PSD()
convert_percent_yield_carry_fx_to_decimal_returns()
if fx_variance_is_zero: mark_flat_risk_and_choose_return_boundary_or_tie
else: compute_closed_form_minimum_variance_and_CE_solutions()
clip_solutions_to_user_minimum_and_maximum_hedge_bounds()
evaluate_current_zero_half_full_minimum_variance_and_cost_adjusted()
evaluate_0_to_100_percent_grid_and_fx_scenarios_minus2_to_plus2_pp()
render_cards_charts_table_and_raw_precision_CSV_from_same_results()
save_only_valid_user_assumptions_locally_on_apply()`,
      note: 'UST·JPY·AUD·GER 각각의 단일시장 조건부 비교이며 시장 간 공분산을 이용한 통합 포트폴리오 최적화가 아니다. 현재 HP 3개 만기 평균을 1년 고정하고 채권금리 변화 기대는 0으로 둔다. FX변화 기본 0은 예측치가 아니다. 실제 총수익률·볼록성·롤다운·거래비용·선물 MTM·표본외 성과를 포함하지 않는다. FX분산이 0이면 최소분산 해는 동률이며 하한은 계산상 대표값이다. 현재비율과 0/50/100% 비교값은 사용자 제약 밖이어도 참고용으로 남긴다. 허용 저장소에 KG 본체·최근 정독 기록이 없어 논문 재현이나 최근 KG 정독 반영을 주장하지 않는다.'
    },
    {
      id: 'fx-markov',
      title: '환율모형A · USDKRW 3국면 마코브 전환',
      formulas: [
        { expression: 'rₜ = ln(Sₜ / Sₜ₋₁) = μzₜ + σzₜ εₜ; εₜ ~ N(0,1)', legend: 'S: 원/달러 · z: 저/중/고변동 3국면 · Pᵢⱼ: 현재 i에서 다음 관측 j로의 전이확률, 행 합=1' },
        { expression: 'p예측 = p현재 P; p필터,j ∝ p예측,j × N(rₜ; μj, σj²)', legend: '현재까지 관측한 수익률의 Hamilton 필터 · 모수는 최신 표본으로 추정, 과거 실시간 확률이나 OOS 성과로 해석하지 않음' },
        { expression: 'z₀⁽ᵇ⁾ ~ Cat(p필터); zₕ⁽ᵇ⁾ ~ Cat(P[zₕ₋₁⁽ᵇ⁾,:]); Sₕ⁽ᵇ⁾ = S₀ exp(Σᵤ₌₁ʰ[μzᵤ + σzᵤ εᵤ⁽ᵇ⁾])', legend: '경로별 현재 국면을 유지하며 전이 후 다음 수익률 추출 · 로그수익률 평균에 추가 −σ²/2 보정 없음' },
        { expression: '평균ₕ = Σᵦ Sₕ⁽ᵇ⁾ / B; 중앙값ₕ = Qₕ(0.5); I68 = [Qₕ(0.16), Qₕ(0.84)]; I95 = [Qₕ(0.025), Qₕ(0.975)]', legend: 'B=20,000개 경로의 시점별 환율 수준 통계 · 모수 조건부 중앙 구간 · exp(로그평균)과 구별' },
        { expression: 'g₀=p필터; gₕ=(gₕ₋₁P)⊙exp(μ+σ²/2); E[Sₕ]=S₀Σⱼgₕ,ⱼ; MC SEₕ=s(Sₕ)/√B', legend: '정확한 산술 기대값으로 MC 평균 검증 · MC 표준오차는 수치오차이며 예측분포 폭 아님' }
      ],
      code: `levels = canonical_bb_usdkrw_or_info_fallback_only_if_empty()
returns = last_2520_valid_daily_log_returns(levels, max_calendar_gap=7)
reset_filter_and_transition_counts_after_excluded_gaps()
if count(returns) < 756 or latest_quote_has_no_valid_return: return inactive
fits = gaussian_3state_EM(three_fixed_starts, uniform_block_initial_probability)
fit = highest_final_likelihood_among_converged_nondegenerate_fits(fits); if absent: return inactive_with_diagnostics
sort_states_by_sigma_and_reorder_transition_and_filtered_probabilities()
paths = simulate_markov_paths(fit, steps=252, path_count=20000, seed=20261020)
simulation = summarize_levels(paths, quantiles=[.025,.16,.5,.84,.975])
retain_exact_log_and_exponential_moments_as_diagnostic_benchmark()
map_21_model_steps_to_each_calendar_month(); publish_v1(simulation, first_12_paths)
plot_history_mean_median_selected_interval_and_optional_sample_paths()`,
      note: '추정창은 최근 최대 2,520 유효 일간수익률(최소 756개), 표시기간과 독립적이다. 급변값을 삭제하지 않는다. 월당 21개 모형 관측을 1달력개월로 대응한다. 시점별 68/95% 모형 구간은 경로 전체 커버리지를 보장하지 않는다. 모수·모형 불확실성은 제외하며 OOS 우월성·실현 커버리지는 미검증이다. 평균·중앙값에 임의의 굴곡을 넣지 않는다. 세 국면은 변동성 순서이며 원화 강세·중립·약세라는 인과 상태가 아니다. 허용 저장소에 KG 본체가 없어 기존 MSM 구현·검증 기록을 참고했다.'
    },
    {
      id: 'fx-lstm-xgb',
      title: '환율모형B · USDKRW LSTM/XGBoost walk-forward',
      formulas: [
        { expression: 'ŷₜ₊ₗ = ½[XGB(xₜ) + LSTM(xₜ₋₅ … xₜ)]; 학습표본 = {(xₛ, Sₛ₊ₗ) : t−w−l < s ≤ t−l}', legend: 'l: 예측 lag 개월(1/3/6) · w: 학습창 개월(24/36) · x: 피처 10개(표준화) · S: 원/달러 수준 · 기준일 t 에 실현된 라벨만 학습, 오프라인 러너가 매 기준일 재학습 · 브라우저 재추정 없음' },
        { expression: 'sₘ(τ) = rUS,τ − rKR,τ = β₀ + β₁·(1−e^(−λτ))/(λτ) + β₂·[(1−e^(−λτ))/(λτ) − e^(−λτ)]', legend: 'Nelson–Siegel λ=0.7308 · τ = 0.25/1/3/10년 · 최소제곱 β = level/slope/curvature · 결측은 앞채움(원 코드는 양방향 보간) · 국제수지 피처는 공표 지연 2개월' },
        { expression: 'eₜ = ŷₜ₊ₗ − Sₜ₊ₗ; eRW,ₜ = Sₜ − Sₜ₊ₗ', legend: '랜덤워크 = 기준일 환율 유지 · 실현된 행만 · 원/달러 · 기준일 수준 < 하한 / > 상한으로 저·중·고환율 국면 분해(기본 1100/1300, 노트북 고정값)' },
        { expression: 'U = RMSE / RMSE_RW; 적중률 = #{sign(ŷₜ₊ₗ − Sₜ) = sign(Sₜ₊ₗ − Sₜ)} / N', legend: 'Theil U < 1 이면 랜덤워크보다 작은 RMSE · 방향은 기준 환율 대비 부호 · 랜덤워크는 방향이 없어 비움 · 선택 기간·조합·국면별로 화면이 재계산' }
      ],
      code: `artifact = first_sorted_fx_lstm_xgb_json_in_private_data_repo()  # 오프라인 러너 산출물
if artifact is missing or schema_grid_lengths_order_or_pending_tail_invalid(artifact): return inactive_with_reason
publish_known_keys_only(dates, base_spot, actual_spot, predictions, summary, model_meta)  # 피처값 미게시
combo = select(lag, window) from published_grid; rows = rows_in_period(combo, model, period)
rw = base_spot; errors = prediction - actual; errors_rw = rw - actual  # 실현 행만
metrics = rmse_mae_bias_theil_u_hit_rate(rows); by_regime = split_by_base_level(rows, low, high)
plot_actual_prediction_rw_and_errors(); table_csv_all_rows_including_pending()`,
      note: '모형은 브라우저·CI 어디서도 재추정하지 않는다. 러너 기본값은 원 코드와 네 곳이 다르다(실현 라벨만 학습·국제수지 공표 지연 2개월·NS 앞채움·시드 고정) — 전부 플래그로 복원되며 어느 설정인지 JSON 과 화면에 적힌다. 학습창 24~36개월의 LSTM 은 표본이 매우 작아 결과가 시드에 민감할 수 있다. 국면 경계는 추정값이 아니다. 참고 표시 전용이고 등급·경보·자산배분·컨센서스에 연결되지 않는다. 실제 CSV 수령·러너 실행 전까지 사유를 적은 보류 상태다.'
    },
    {
      id: 'usd-cip',
      title: 'USD 모델A · 금리차와 헤지 프리미엄',
      formulas: [
        { expression: 'F / S = (1 + rKR × τ) / (1 + rUS × τ)', legend: '동일 만기·조달 조건의 단리 CIP · S/F: 현물/선물 원·달러 환율 · r: 소수 금리 · τ: 연 단위 만기' },
        { expression: 'h = 100 × (F / S − 1) / τ ≈ 100 × (rKR − rUS)', legend: '연율 signed 프리미엄 % · 양수 수취, 음수 지불 · 금리차 일치는 1차 근사' },
        { expression: 'Δₘ = 금리KR,ₘ − 금리US,ₘ; gₘ = h̄ − Δₘ', legend: 'm: PR·3M·1Y·2Y·3Y · 원금리 입력 연 % · h̄: 각 HP 3M·6M·12M의 과거 최대 5개 유효관측 중앙값을 소수 2자리 반올림한 뒤 단순평균 · g: %p' },
        { expression: '현재 괴리 = 100 × g마지막; RMSE = 100 × √mean(g²); ρ = Corr(h̄, Δₘ)', legend: '괴리·RMSE: bp · 선택기간 같은 날짜 유효쌍 · Pearson 수준 상관 · 회귀잔차나 예측오차 RMSE가 아님' },
        { expression: 'Z = (g마지막 − mean(g)) / s(g); s(g) = √[Σ(g − mean(g))² / (N − 1)]', legend: '최신 관측을 포함한 선택기간의 괴리 · 표본 표준편차 · 무단위 · N < 2 또는 일정한 괴리는 계산하지 않음' }
      ],
      code: `for date in observed_dates:
  premium = mean(three_trailing_hp_medians_on_date)  # 세 원호가 모두 당일 관측
for tenor in PR, 3M, 1Y, 2Y, 3Y:
  pairs = inner_join_by_date(premium, korean_rate, us_rate)  # 보간·앞채움 없음
  selected = pairs_in_selected_period(pairs)
  latest_inputs = last(selected.korean_rate, selected.us_rate, selected.spread, selected.premium)
  gap_zscore = standardize_latest_gap(selected.gap, ddof=1)
  publish(latest_inputs, correlation, latest_gap_bp, gap_zscore, identity_rmse_bp, sample, chart)`,
      note: '카드의 한국·미국 금리, 금리차, 헤지비용(평균)은 같은 최신 공통일 값이다. 헤지비용은 프리미엄 부호를 유지해 음수 지불·양수 수취로 표시한다. PR은 만기 조달금리가 아니며 국채금리와 평균 HP는 상품·만기가 다르다. 이 비교는 엄밀한 CIP 베이시스가 아니다. 만기별 가용 표본의 날짜·관측수를 표시한다. 수치 정밀도 범위 내 상수계열·표본 2개 미만은 상관을 비우며 괴리와 RMSE는 한 쌍부터 계산한다. Z Score는 괴리의 선택기간 내 상대적 위치이며 예측 신호·유의확률이 아니다. HP가 없으면 금리차 프록시나 SMB로 대체하지 않는다. 과거 방향 중앙값으로 미래 관측을 쓰지 않는다.'
    },
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
plot_histogram(display_bins.low, display_bins.high, frequency_divided_by_full_n)
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
