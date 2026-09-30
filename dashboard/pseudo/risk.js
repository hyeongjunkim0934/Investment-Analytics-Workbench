globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.risk = {
  id: "risk",
  title: "리스크",
  updated: "2026-09-30",
  summary: "과거 분포로 지표를 점수화하고 현재 위험·잠재 위험을 별도 합성한다.",
  inputs: "주가·환율·VIX·CDS·금리·스프레드·12M 선행 EPS·미국 실업률. 금리는 %, 스프레드는 %p 또는 bp, 월별 지표는 월말값.",
  outputs: "risk.json: 0–100점, 등급, 요인 가중치, 주간 이력. 현재 위험 6요인·잠재 위험 5요인 중 활성 요인 사용.",
  sources: [
    { path: "pipeline/risk.py", symbols: ["derive_inputs", "factor_specs", "expanding_pctl", "transform", "build", "pack_alloc_history"] },
    { path: "pipeline/common.py", symbols: ["spearman"] }
  ],
  sections: [
    {
      id: "risk-inputs",
      title: "원천 지표 → 파생 지표",
      formulas: [
        { expression: "환율 변동성 = 100 × √252 × SD₂₀(Sₜ / Sₜ₋₁ − 1)", legend: "S: 달러/원. 최근 20개 수익률의 표본 표준편차, 연 %." },
        { expression: "낙폭 = 100 × (Pₜ / 누적최고(P) − 1)  ·  이격 = 100 × (Pₜ / MAₙ(P) − 1)", legend: "P: 주가 또는 환율. 주가 이격 n=120·200, 환율 n=200개 관측; 단위 %." },
        { expression: "커브 = 100 × (장기금리 − 단기금리)  ·  카드채 스프레드 = 100 × (카드채 AA+ 3Y − 국고 3Y)", legend: "입력 금리 %, 결과 bp. 미국 10Y−2Y, 한국 10Y−3Y." },
        { expression: "PER = 가격지수 / EPS  ·  EPS 리비전 = 100 × (EPSₜ / EPSₜ₋₃개월 − 1)", legend: "KOSPI·S&P 500의 양수 12M 선행 EPS. 3개월 전 또는 직전 관측 사용; PER 배, 리비전 %." }
      ],
      code: `load configured market series
derive volatility, drawdown, spread and moving-average gaps
for market in [KOSPI, S&P 500]:
  select first available price and EPS source
  keep positive EPS; pair price and EPS on common dates
  require full-history median PER within [3, 60]
  derive EPS revision using calendar-three-month as-of lookup
if either market fails: hold both valuation and revision factors
load monthly unemployment and compute Sahm reference`,
      note: "삼 룰은 참고 표시다. 잠재 위험의 사이클 점수에는 낮은 실업률만 반영한다.",
      sources: [{ path: "pipeline/risk.py", symbols: ["derive_inputs", "_per_block", "factor_specs"] }]
    },
    {
      id: "risk-score",
      title: "백분위 → 지표·요인 점수",
      formulas: [
        { expression: "pₜ = 100 × 평균동순위(xₜ; x₁…xₜ) / 유효관측수ₜ", legend: "지표별 당일까지 확장 창. 일별 최소 1,000개, 월별 최소 60개 관측; 백분위 %." },
        { expression: "높을수록 위험: q=p  ·  낮을수록 위험: q=100−p  ·  상방 과열: q=max(0, 2(p−50))", legend: "낙폭·커브·EPS 리비전·스프레드 압축·실업률은 낮을수록 위험. 주가 이격만 상방 과열, 나머지는 높을수록 위험." },
        { expression: "주간 요인 Fⱼ,ₜ = 해당 주 유효 지표 점수의 평균", legend: "금요일 기준 마지막 값. 시작 전 지표는 제외하고, 이미 시작한 지표가 빠진 주는 요인 전체 제외." },
        { expression: "최신 요인 Fⱼ,현재 = round₁(mean(round₁(qᵢ,각 지표 최신일)))", legend: "round₁: 소수점 1자리. 최신 스냅숏은 지표별 관측일이 다를 수 있다." }
      ],
      code: `drop missing observations; sample monthly series at month-end
compute expanding average-tie percentile after minimum sample
apply the configured risk direction
discard indicators with no valid score
sample weekly last scores; fill monthly gaps for at most 6 weeks
for each factor and week:
  omit indicators that have not started
  publish mean only if every started indicator is present
build current factor from each indicator's rounded latest score`,
      note: "현재 위험: 변동성·낙폭·스프레드 확대·CDS·환율·커브. 결측은 0점으로 채우지 않는다.",
      sources: [{ path: "pipeline/risk.py", symbols: ["expanding_pctl", "transform", "build"] }]
    },
    {
      id: "risk-current",
      title: "현재 위험 → IC 가중 합성",
      formulas: [
        { expression: "yₜ = mean시장(100 × √252 × SD(미래 가격 구간 내부의 일간 수익률))", legend: "KOSPI TR·ACWI. t 이후 최대 22개 가격, 최소 15개 필요; 첫 가격 이전 수익률 제외. 유효 시장 평균, 연 %." },
        { expression: "aⱼ = max(0, Spearman(Fⱼ, y))  ·  uⱼ = aⱼ / Σa", legend: "모든 현재 위험 요인이 있는 주만 학습. IC 결측은 0, 양의 IC 합이 0이면 가중 갱신 생략." },
        { expression: "wⱼ = max(uⱼ, 0.08) / Σₖ max(uₖ, 0.08)  ·  현재 위험ₜ = Σⱼ wⱼ,ₜ Fⱼ,ₜ", legend: "완전관측 주 4행마다 재학습. t−5주 이하 확장 표본, 최소 156주. 그때 확보한 가중치로 이력 계산." }
      ],
      code: `align current-risk factors on complete weeks
build future realized-volatility target for each week
for each complete week t:
  every fourth row, select training dates no later than t minus 5 weeks
  if at least 156 training rows: estimate positive IC weights
  if valid: apply floor then renormalize; retain new weights
  if weights exist: publish that week's weighted score
if no fit ever succeeded: warn and use equal-weight history
apply latest retained weights to latest factor snapshots; round to 1 digit`,
      note: "8%는 재정규화 전 바닥이므로 최종 가중치는 8% 미만일 수 있다. 점수는 손실확률이 아니다.",
      sources: [
        { path: "pipeline/risk.py", symbols: ["build"] },
        { path: "pipeline/common.py", symbols: ["spearman"] }
      ]
    },
    {
      id: "risk-potential",
      title: "잠재 위험·등급·배분 전달",
      formulas: [
        { expression: "잠재 위험ₜ = 해당 주 유효 요인의 평균  ·  잠재 위험현재 = round₁(활성 요인의 최신 점수 평균)", legend: "밸류에이션·과열 이격·이익 리비전·스프레드 압축·사이클. 주간 이력은 최소 2요인, 최신값은 활성 요인이 있으면 계산." },
        { expression: "0≤점수<25: 낮음  ·  25≤점수<50: 보통  ·  50≤점수<75: 주의  ·  75≤점수≤100: 경계", legend: "현재·잠재 위험에 동일 적용. 미래 수익률·손실의 확률 구간이 아니다." }
      ],
      code: `select active potential-risk factors
for each week: average available factors only when at least two exist
average latest active-factor scores; round to 1 digit
assign fixed score-band labels to both layers
publish recent 115 weekly rows as chart history
for allocation history: retain all weeks no later than as-of date
deduplicate and sort dates; append current score at actual as-of date`,
      note: "잠재 위험은 축적 감시용 동일가중이다. 배분용 이력은 발표·개정 당시 정보를 복원한 백테스트가 아니다.",
      sources: [{ path: "pipeline/risk.py", symbols: ["build", "grade", "pack_alloc_history"] }]
    }
  ]
};
