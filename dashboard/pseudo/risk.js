/* Maintained handoff: definitions, assumptions, exceptions and checks follow the referenced implementation. */
globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.risk = {
  "id": "risk",
  "title": "리스크",
  "updated": "2026-11-06",
  "summary": "원천·단위 확정 → 확장 백분위 → 요인 합성 → 현재/잠재 위험 → 자산배분용 이력. 각 단계의 결측 정책과 정보시점을 보존한다.",
  "inputs": "주가·환율·VIX·CDS·금리·스프레드·12M 선행 EPS·미국 실업률. 금리는 %, 스프레드는 %p 또는 bp, 월별 지표는 월말값.",
  "outputs": "risk.json: 0–100점, 등급, 요인 가중치, 주간 이력. 현재 위험 6요인·잠재 위험 5요인 중 활성 요인 사용.",
  "readingGuide": [
    "먼저 현재 위험(스트레스)과 잠재 위험(축적 상태)의 목적 및 가중 방식 차이를 읽는다.",
    "원천 선택·위험 방향·표본 기준을 확인한 뒤 수식과 유사코드를 함께 따라간다.",
    "배분 연계에서는 점수의 의미, 실제 기준일, hist_alloc의 범위를 자산배분 문서와 대조한다."
  ],
  "sources": [
    {
      "path": "pipeline/risk.py",
      "symbols": [
        "derive_inputs",
        "factor_specs",
        "expanding_pctl",
        "transform",
        "build",
        "pack_alloc_history"
      ]
    },
    {
      "path": "pipeline/common.py",
      "symbols": [
        "spearman"
      ]
    }
  ],
  "sections": [
    {
      "id": "risk-inputs",
      "title": "원천 지표 → 파생 지표",
      "formulas": [
        {
          "expression": "환율 변동성 = 100 × √252 × SD₂₀(Sₜ / Sₜ₋₁ − 1)",
          "legend": "S: 원/달러(USDKRW). 최근 20개 단순수익률의 표본 표준편차(ddof=1), 연 %.",
          "latex": String.raw`\sigma_{\mathrm{FX},t}=100\sqrt{252}\;\operatorname{SD}_{20}\!\left(\frac{S_t}{S_{t-1}}-1\right)`
        },
        {
          "expression": "낙폭 = 100 × (Pₜ / 누적최고(P) − 1)  ·  이격 = 100 × (Pₜ / MAₙ(P) − 1)",
          "legend": "P: 주가 또는 환율. 주가 이격 n=120·200, 환율 n=200개 관측; 단위 %.",
          "latex": String.raw`\mathrm{DD}_t=100\!\left(\frac{P_t}{\max_{u\le t}P_u}-1\right),\qquad d_{n,t}=100\!\left(\frac{P_t}{\operatorname{MA}_n(P)_t}-1\right)`
        },
        {
          "expression": "커브 = 100 × (장기금리 − 단기금리)  ·  카드채 스프레드 = 100 × (카드채 AA+ 3Y − 국고 3Y)",
          "legend": "입력 금리 %, 결과 bp. 미국 10Y−2Y, 한국 10Y−3Y.",
          "latex": String.raw`\mathrm{Curve}_t=100(y_{L,t}-y_{S,t}),\qquad \mathrm{Spread}_t=100(y_{\mathrm{Card\,AA+\,3Y},t}-y_{\mathrm{KTB\,3Y},t})`
        },
        {
          "expression": "PER = 가격지수 / EPS  ·  EPS 리비전 = 100 × (EPSₜ / EPSₜ₋₃개월 − 1)",
          "legend": "KOSPI·S&P 500의 양수 12M 선행 EPS. 3개월 전 또는 직전 관측 사용; PER 배, 리비전 %.",
          "latex": String.raw`\mathrm{PER}_t=\frac{P_t}{\mathrm{EPS}_t},\qquad \mathrm{Rev}_t=100\!\left(\frac{\mathrm{EPS}_t}{\mathrm{EPS}_{t-3\mathrm{m}}}-1\right)`
        }
      ],
      "code": "load configured market series\nderive volatility, drawdown, spread and moving-average gaps\nfor market in [KOSPI, S&P 500]:\n  select first available price and EPS source\n  keep positive EPS; pair price and EPS on common dates\n  require full-history median PER within [3, 60]\n  derive EPS revision using calendar-three-month as-of lookup\nif either market fails: hold both valuation and revision factors\nload monthly unemployment and compute Sahm reference",
      "note": "원천명만 바꿔 연결하는 작업도 값·단위·관측일 계약을 함께 대조해야 한다.",
      "sources": [
        {
          "path": "pipeline/risk.py",
          "symbols": [
            "derive_inputs",
            "_per_block",
            "factor_specs"
          ]
        }
      ],
      "purpose": "경제적으로 서로 다른 지표를 공통 점수로 바꾸기 전에 원천·방향·단위를 확정한다. 원천 선택이나 환율 표기 변경은 이후 요인과 배분 경로 전체에 영향을 준다.",
      "decisions": [
        "PER은 가격지수와 양수 12개월 선행 EPS의 날짜 교집합으로 계산한다. 후보 원천은 코드에 선언된 우선순위로 선택하고, 어느 시장이든 짝 검증에 실패하면 밸류에이션·리비전 두 요인을 함께 보류한다.",
        "PER 중앙값 3~60배는 전 이력을 대상으로 한 원천 정합성 검사다. 투자 적정가치 기준이나 실시간 빈티지 검증으로 해석하지 않는다.",
        "환율은 USDKRW(원/달러)이며 리스크에는 수준 자체 대신 200관측 이동평균 대비 이격을 넣는다. 삼 룰은 참고 정보이고 잠재 위험 사이클 점수에는 낮은 실업률을 반영한다."
      ],
      "checks": [
        "금리 차이 1%p가 100bp로 변환되는지, 낙폭이 고점에서 0이고 고점 아래에서 음수인지 확인한다.",
        "EPS 비양수·원천 누락·가격/EPS 짝 오류에서 숫자 대신 보류 사유가 유지되는지 확인한다.",
        "원천 키·최종 관측일·3개월 as-of 조회일을 보존해 동일 입력으로 파생 지표를 재현한다."
      ]
    },
    {
      "id": "risk-score",
      "title": "백분위 → 지표·요인 점수",
      "formulas": [
        {
          "expression": "pₜ = 100 × 평균동순위(xₜ; x₁…xₜ) / 유효관측수ₜ",
          "legend": "지표별 당일까지 확장 창. 일별 최소 1,000개, 월별 최소 60개 관측; 백분위 %.",
          "latex": String.raw`p_t=100\frac{\operatorname{rank}_{\mathrm{avg}}(x_t;\,x_1,\ldots,x_t)}{N_t}`
        },
        {
          "expression": "높을수록 위험: q=p  ·  낮을수록 위험: q=100−p  ·  상방 과열: q=max(0, 2(p−50))",
          "legend": "낙폭·커브·EPS 리비전·스프레드 압축·실업률은 낮을수록 위험. 주가 이격만 상방 과열, 나머지는 높을수록 위험.",
          "latex": String.raw`q_t=\begin{cases}p_t&\mathrm{high\ risk}\\100-p_t&\mathrm{low\ risk}\\\max[0,\,2(p_t-50)]&\mathrm{upper\ tail}\end{cases}`
        },
        {
          "expression": "주간 요인 Fⱼ,ₜ = 해당 주 유효 지표 점수의 평균",
          "legend": "금요일 기준 마지막 값. 시작 전 지표는 제외하고, 이미 시작한 지표가 빠진 주는 요인 전체 제외.",
          "latex": String.raw`F_{j,t}=\frac{1}{|I_{j,t}|}\sum_{i\in I_{j,t}}q_{i,t}`
        },
        {
          "expression": "최신 요인 Fⱼ,현재 = round₁(mean(round₁(qᵢ,각 지표 최신일)))",
          "legend": "round₁: 소수점 1자리. 최신 스냅숏은 지표별 관측일이 다를 수 있다.",
          "latex": String.raw`F_{j,\mathrm{now}}=\operatorname{round}_1\!\left[\frac{1}{|I_j|}\sum_{i\in I_j}\operatorname{round}_1(q_{i,t_i})\right]`
        }
      ],
      "code": "drop missing observations; sample monthly series at month-end\ncompute expanding average-tie percentile after minimum sample\napply the configured risk direction\ndiscard indicators with no valid score\nsample weekly last scores; fill monthly gaps for at most 6 weeks\nfor each factor and week:\n  omit indicators that have not started\n  publish mean only if every started indicator is present\nbuild current factor from each indicator's rounded latest score",
      "note": "백분위는 해당 이력에서의 상대 위치다. 점수 80을 손실확률 80%로 전달하지 않는다.",
      "sources": [
        {
          "path": "pipeline/risk.py",
          "symbols": [
            "expanding_pctl",
            "transform",
            "build"
          ]
        }
      ],
      "purpose": "규모와 단위가 다른 지표를 과거 분포상의 위치로 바꾸고, 경제적 위험 방향을 적용한 다음 요인 단위로 묶는다.",
      "decisions": [
        "일별은 최소 1,000개, 월별은 최소 60개 유효 관측이 있어야 백분위를 계산한다. 상방 과열 변환은 중앙값 이하를 0으로 처리한다.",
        "주간값은 금요일 라벨의 마지막 관측이다. 월별 지표만 최대 6주 앞채움을 허용하며, 이미 시작된 지표가 빠진 주는 해당 요인 전체를 제외한다.",
        "최신 요인은 지표별 최신 점수를 먼저 소수 1자리로 반올림한 뒤 평균·재반올림한다. 여러 원천의 최신일이 같다고 가정해서는 안 된다."
      ],
      "checks": [
        "동점 표본에서 평균 순위를 사용하고, 최소 표본 직전에는 점수가 비어 있는지 확인한다.",
        "높음/낮음/상방 변환의 경계 0·50·100을 대조하고 결과가 0~100 범위를 지키는지 확인한다.",
        "미탄생 지표는 제외하되 이미 시작된 지표의 누락은 요인 누락으로 이어지는지 확인한다."
      ]
    },
    {
      "id": "risk-current",
      "title": "현재 위험 → IC 가중 합성",
      "formulas": [
        {
          "expression": "yₜ = mean시장(100 × √252 × SD(미래 가격 구간 내부의 일간 수익률))",
          "legend": "KOSPI TR·ACWI. t 이후 최대 22개 가격, 최소 15개 필요; 첫 가격 이전 수익률 제외. 유효 시장 평균, 연 %.",
          "latex": String.raw`y_t=\frac{1}{|M_t|}\sum_{m\in M_t}100\sqrt{252}\;\operatorname{SD}\!\left(\frac{P_{m,u}}{P_{m,u-1}}-1\right)_{u\in\mathcal{T}_{m,t}}`
        },
        {
          "expression": "aⱼ = max(0, Spearman(Fⱼ, y))  ·  uⱼ = aⱼ / Σa",
          "legend": "모든 현재 위험 요인이 있는 주만 학습. IC 결측은 0, 양의 IC 합이 0이면 가중 갱신 생략.",
          "latex": String.raw`a_j=\max[0,\,\operatorname{Spearman}(F_j,y)],\qquad u_j=\frac{a_j}{\sum_k a_k}`
        },
        {
          "expression": "wⱼ = max(uⱼ, 0.08) / Σₖ max(uₖ, 0.08)  ·  현재 위험ₜ = Σⱼ wⱼ,ₜ Fⱼ,ₜ",
          "legend": "완전관측 주 4행마다 재학습. t−5주 이하 확장 표본, 최소 156주. 그때 확보한 가중치로 이력 계산.",
          "latex": String.raw`w_j=\frac{\max(u_j,0.08)}{\sum_k\max(u_k,0.08)},\qquad R_t=\sum_jw_{j,t}F_{j,t}`
        }
      ],
      "code": "align current-risk factors on complete weeks\nbuild future realized-volatility target for each week\nfor each complete week t:\n  every fourth row, select training dates no later than t minus 5 weeks\n  if at least 156 training rows: estimate positive IC weights\n  if valid: apply floor then renormalize; retain new weights\n  if weights exist: publish that week's weighted score\nif no fit ever succeeded: warn and use equal-weight history\napply latest retained weights to latest factor snapshots; round to 1 digit",
      "note": "현재 위험은 관측된 스트레스의 합성 점수다. IC는 예측 관련성의 추정치이며 인과효과가 아니다.",
      "sources": [
        {
          "path": "pipeline/risk.py",
          "symbols": [
            "build"
          ]
        },
        {
          "path": "pipeline/common.py",
          "symbols": [
            "spearman"
          ]
        }
      ],
      "purpose": "현재 위험 요인의 가중치를 향후 실현변동성과의 과거 순위상관으로 갱신한다. 점수와 가중치의 정보시점을 분리해 이해한다.",
      "decisions": [
        "타깃은 각 주 이후 최대 22개 가격 안의 수익률로 계산하며 최소 15개 가격이 필요하다. 첫 가격 이전의 수익률은 포함하지 않는다.",
        "완전관측 주의 네 번째 행마다 재학습하고 학습 원점은 현재보다 5주 이상 이전으로 제한한다. 최소 156개 주가 필요하다.",
        "음의 IC와 결측 IC는 0으로 처리한다. 양의 합이 0이면 기존 가중치를 유지하며, 한 번도 학습에 성공하지 못했으면 경고와 동일가중 이력을 사용한다.",
        "0.08은 재정규화 이전의 바닥이다. 최종 가중치가 8% 이상이라는 제약으로 이식하면 다른 모형이 된다."
      ],
      "checks": [
        "가중치가 음수가 아니고 합계가 1인지 확인한다. 재학습 실패 시 마지막 가중치가 유지되는지도 확인한다.",
        "학습 기준일·5주 cutoff·타깃 구성일을 함께 기록한다. 원천 공표·개정 빈티지까지 복원한 성능 검증과 구분한다.",
        "양의 IC가 하나도 없는 경우와 최초 학습 이전 구간을 별도 사례로 재현한다."
      ]
    },
    {
      "id": "risk-potential",
      "title": "잠재 위험·등급·배분 전달",
      "formulas": [
        {
          "expression": "잠재 위험ₜ = 해당 주 유효 요인의 평균  ·  잠재 위험현재 = round₁(활성 요인의 최신 점수 평균)",
          "legend": "밸류에이션·과열 이격·이익 리비전·스프레드 압축·사이클. 주간 이력은 최소 2요인, 최신값은 활성 요인이 있으면 계산.",
          "latex": String.raw`V_t=\frac{1}{|J_t|}\sum_{j\in J_t}F_{j,t}\quad(|J_t|\ge2),\qquad V_{\mathrm{now}}=\operatorname{round}_1\!\left(\frac{1}{|J|}\sum_{j\in J}F_{j,\mathrm{now}}\right)`
        },
        {
          "expression": "0≤점수<25: 낮음  ·  25≤점수<50: 보통  ·  50≤점수<75: 주의  ·  75≤점수≤100: 경계",
          "legend": "현재·잠재 위험에 동일 적용. 미래 수익률·손실의 확률 구간이 아니다.",
          "latex": String.raw`\operatorname{Grade}(s)=\begin{cases}\text{낮음}&0\le s<25\\\text{보통}&25\le s<50\\\text{주의}&50\le s<75\\\text{경계}&75\le s\le100\end{cases}`
        }
      ],
      "code": "select active potential-risk factors\nfor each week: average available factors only when at least two exist\naverage latest active-factor scores; round to 1 digit\nassign fixed score-band labels to both layers\npublish recent 115 weekly rows as chart history\nfor allocation history: retain all weeks no later than as-of date\ndeduplicate and sort dates; append current score at actual as-of date",
      "note": "이 이력은 현재 자료로 계산한 시나리오 입력이다. 원천의 발표·개정 당시 정보를 복원한 백테스트 이력은 아니다.",
      "sources": [
        {
          "path": "pipeline/risk.py",
          "symbols": [
            "build",
            "grade",
            "pack_alloc_history"
          ]
        }
      ],
      "purpose": "잠재 위험은 축적 상태를 동일가중으로 요약하고, 두 위험 층의 표시 이력과 자산배분 전달 이력을 용도에 맞게 게시한다.",
      "decisions": [
        "잠재 위험 주간값은 유효 요인이 최소 2개일 때 계산한다. 최신값은 활성 요인의 최신 점수가 하나 이상 있으면 계산하므로 두 집계의 표본 규칙이 다르다.",
        "25·50·75점 경계는 고정 분류 기준이다. 별도의 과거 구간별 실현 통계가 있어도 점수 자체가 보정된 손실확률로 바뀌지 않는다.",
        "화면 요약에는 최근 115주를 쓰고, 배분용 hist_alloc에는 기준일 이전 전체 주간 이력과 실제 기준일의 최신값을 넣는다. 아직 오지 않은 금요일 라벨은 배분용 이력에서 제외한다."
      ],
      "checks": [
        "24.9/25/50/75/100에서 등급의 포함 방향을 확인한다.",
        "배분용 날짜가 정렬·중복 제거되고 기준일 이후의 행이 없는지 확인한다.",
        "최신값이 실제 기준일에 한 번만 게시되는지, risk.json의 기준일과 일치하는지 확인한다."
      ]
    }
  ]
};
