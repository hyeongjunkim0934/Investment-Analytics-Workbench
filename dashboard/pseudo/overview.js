globalThis.PSEUDO_DOCS = globalThis.PSEUDO_DOCS || {};
globalThis.PSEUDO_DOCS.overview = {
  id: "overview",
  title: "Overview",
  updated: "2026-11-06",
  summary: "원천 데이터에서 의사결정 참고값까지, 코드의 책임과 연결을 한 장의 지도에서 시작합니다. 아래 네 모듈은 같은 데이터를 일부 공유하지만 질문·목적함수·출력의 의미가 다릅니다.",
  inputs: "비공개 Data의 시장 파일·모형B 산출물, Workbench 계산 코드, 브라우저에서 적용한 가정·제약·컨센서스.",
  outputs: "리스크 진단, 조건부 자산배분, 환헤지 비교, 환율전망. 자동 주문·공통 단일 추천 포트폴리오를 생성하지 않습니다.",
  readingGuide: [
    "먼저 코드스페이스에서 계산 위치와 데이터 계약을 확인하고, 리스크 → 자산배분 → 환헤지 → 환율전망으로 읽습니다.",
    "각 절은 목적 → 수식과 기호·단위 → 처리 순서 → 판단 경계 → 인수 검증으로 이어집니다. 왼쪽 목차로 필요한 절에 바로 이동할 수 있습니다.",
    "수식은 현재 구현의 설명이며 유사코드는 실행 가능한 소스가 아닙니다. 코드 링크에서 실제 함수·예외 처리를 확인하고, 문서 검토일과 데이터 기준일은 구분합니다."
  ],
  diagram: {
    title: "코드스페이스 · 입력에서 화면까지",
    caption: "상자는 책임 경계, 아래 방향은 산출물 전달입니다. 네 모듈의 배열은 설명 순서이며 실행 순서나 인과관계를 뜻하지 않습니다.",
    layers: [
      { title: "원천과 수집", nodes: [
        { title: "Data · 비공개 원천", detail: "시장 XLSX/XLSM · 모형B 오프라인 산출물. 실제 파일은 CI의 source-data에 체크아웃됩니다." },
        { title: "process.py · 공용 진입점", detail: "load_data_dir → SERIES. 원천 이름·단위·관측일을 보존하고 각 모듈 빌더로 전달합니다." }
      ], next: "동일 원천을 목적별 표본·정제 규칙으로 계산" },
      { title: "Python 계산과 게시 계약", nodes: [
        { title: "리스크", detail: "risk.py · regime.py → risk.json. 현재/잠재 점수·주간 이력·참고 국면.", target: "risk" },
        { title: "자산배분", detail: "alloc.py · port.py · bm.py → alloc.json. 공분산·CMA·7개 자산 통계.", target: "alloc" },
        { title: "환헤지", detail: "hedge.py · hedge_cip.py · hedge_tail.py → hedge.json. 비용·공동 충격·CIP·꼬리손실 집계.", target: "hedge" },
        { title: "환율전망", detail: "fx_outlook.py · fx_markov.py · fx_simulation.py · fx_model_c/d.py · fx_lstm_xgb.py → fx.json.", target: "fx" }
      ], next: "필수 키·단위·표본·정합성을 배포 전에 검사" },
      { title: "검증과 배포", nodes: [
        { title: "check_output.py · JSON 계약", detail: "필수 산출물 누락과 형식 오류를 차단합니다. 일부 모형의 active:false는 사유와 함께 계약상 허용됩니다." },
        { title: "GitHub Actions → Pages", detail: "test → build → gate → deploy. dashboard와 검증된 data/*.json을 함께 게시합니다." }
      ], next: "브라우저가 게시 결과를 읽고 적용된 사용자 가정을 결합" },
      { title: "브라우저 분석과 표시", nodes: [
        { title: "app.js · 각 모듈 JS", detail: "조회기간·최적화·카드·차트·CSV. 자산배분은 port-constraints.js, 헤지 B/C는 전용 optimizer를 호출합니다." },
        { title: "CMA·SAA/TAA·헤지·컨센서스", detail: "사용자 입력은 브라우저 상태입니다. 모듈별 초안/적용 시점과 저장 범위를 확인하며 Python 재학습과 구분합니다." },
        { title: "Pseudo · 읽기 전용 설명", detail: "pseudo/*.js → pseudo.js → 로컬 KaTeX. 시장 JSON 없이 열리며 금융 입력·저장값을 수정하지 않습니다." }
      ] }
    ],
    relations: [
      "리스크 → 자산배분 리스크 연계: 주간 현재/잠재 점수를 λ로 매핑합니다. 두 점수와 두 결과를 별도로 유지합니다.",
      "CMA → 자산배분: 적용 가정이 수기 μ·σ에 우선하며, 공분산 구성 후 자산별 환헤지를 반영합니다.",
      "환헤지 ↔ 자산배분: 금리·FX·헤지비용 원천을 공유합니다. 헤지 B/C의 선택비율을 자산배분에 자동 입력하는 연결은 없습니다.",
      "환율전망 → 요약카드: 모형별 결과를 표시합니다. 컨센서스·A/B/C/D를 자동 결합하거나 리스크 등급·최적화 기대수익에 자동 주입하지 않습니다."
    ]
  },
  sources: [
    { path: "pipeline/process.py", symbols: ["load_data_dir", "main", "build_fx"] },
    { path: "pipeline/check_output.py", symbols: ["main"] },
    { path: "dashboard/app.js", symbols: ["boot", "renderSection", "portModelInputs", "allocRiskOptimize"] },
    { path: "dashboard/pseudo.js", symbols: ["renderPseudoDocs", "pseudoText", "pseudoFormula"] }
  ],
  sections: [
    {
      id: "responsibility",
      title: "질문과 책임 · 네 모듈을 하나의 판단으로 섞지 않기",
      purpose: "어느 계산이 어떤 질문에 답하는지 먼저 정합니다. 화면의 숫자가 비슷해 보여도 정의·시간축·손실 방향이 다르면 같은 지표로 인수하지 않습니다.",
      formulas: [],
      code: `identify_question_and_decision_owner()
read_source_units_asof_and_sample_window()
choose_risk_allocation_hedge_or_fx_module()
follow_published_inputs_and_applied_browser_state()
read_model_assumptions_and_unavailable_reasons()
return_result_with_scope_without_automatic_trade()`,
      note: "리스크는 시장 상태의 점수, 자산배분은 가정·제약하의 비중, 환헤지는 비용·위험의 절충, 환율전망은 조건부 경로·분포입니다. 최종 투자 판단과 모델 변경의 채택은 담당자가 결정합니다.",
      decisions: ["리스크 80점은 손실확률 80%가 아닙니다. 최적 비중은 참인 기대수익을 알아냈다는 뜻이 아닙니다.", "모형 간 목적함수가 다르다는 사실로 통계적 독립성·예측 우월성을 주장하지 않습니다."],
      checks: ["같은 결과를 인수자가 입력·표본·부호·단위·기준일과 함께 설명할 수 있는지 확인합니다.", "추정값·설계 가정·사용자 입력·단순 항등식을 구분하여 검토합니다."]
    },
    {
      id: "units",
      title: "공용 단위 · 경계에서 한 번만 변환",
      purpose: "화면의 %와 엔진의 소수, 연율과 누적값 사이의 변환을 명시합니다. 단위 변환이 중복되거나 빠지면 최적화의 경제적 의미까지 바뀝니다.",
      formulas: [
        { expression: "r(%) = 100r(소수); C(%²) = 10,000C(소수²); 1%p = 100bp", latex: String.raw`r_{\%}=100r_{\mathrm{dec}},\qquad C_{\%^{2}}=10^{4}C_{\mathrm{dec}^{2}},\qquad 1\,\mathrm{pp}=100\,\mathrm{bp}`, legend: "%는 수익률·금리 수준, %p는 두 백분율의 차이, bp는 %p의 1/100입니다. 공분산은 변환 배율을 제곱합니다." },
        { expression: "w = 입력 비중(%) / 100; h = 입력 헤지비율(%) / 100", latex: String.raw`w_i=\frac{w_{i,\%}}{100},\qquad h=\frac{h_{\%}}{100}`, legend: "w와 h는 계산상의 소수 비중입니다. 모듈마다 입력·출력 단위를 확인하며 소수비중에 다시 /100을 적용하지 않습니다." }
      ],
      code: `read_unit_metadata_at_module_boundary()
convert_percent_weights_to_decimal_once()
convert_covariance_units_with_squared_scale()
retain_signed_hedge_premium_and_loss_definition()
keep_full_precision_during_all_calculations()
round_only_for_display_or_explicit_model_rule()`,
      note: "헤지 프리미엄은 양수 수취·음수 지불입니다. 월간 경험 ES, 연 변동성, 분기 누적수익률은 서로 다른 시간축입니다. 화면 소수 자릿수와 내부 계산 정밀도를 구분합니다.",
      decisions: ["USD/KRW 상승은 달러 자산의 원화 평가에 플러스입니다. 장기 USD 보유자의 손실 VaR은 환율 하단에서 계산하므로 부호를 뒤집지 않습니다.", "로그수익률과 단순수익률, 수준 평균과 수익률 평균을 같은 이름으로 대체하지 않습니다."],
      checks: ["2%를 0.02로 변환한 뒤 되돌리면 2%인지, 1%p 차이가 100bp인지 확인합니다.", "h=0과 h=1, 비중합=1, 공분산 대칭·PSD 경계에서 결과를 대조합니다."]
    },
    {
      id: "time-contract",
      title: "시점과 결측 · 데이터 기준일을 계산의 일부로 보존",
      purpose: "실시간으로 이용 가능했던 정보와 사후 표시용 처리를 분리합니다. 표본을 맞추는 방식이 모형의 경제적 가정이 될 수 있습니다.",
      formulas: [],
      code: `record_code_revision_build_time_and_observation_asof()
apply_the_module_specific_join_and_cleaning_policy()
retain_sample_start_end_and_valid_count()
fit_only_labels_realized_by_the_forecast_origin()
if_insufficient_or_stale_return_unavailable_with_reason()
display_future_target_dates_separately_from_observation_dates()`,
      note: "각 모듈의 공통일 정렬·월말 선택·결측 허용·극단값 처리는 동일하지 않습니다. 현재 구현을 먼저 보존하고 공용화는 표본과 결과의 차이를 검토한 뒤 진행합니다.",
      decisions: ["문서 검토일·배포일이 최신이어도 데이터 관측일은 과거일 수 있습니다. 오래된 전망의 목표일이 지나면 해당 정책에 따라 보류합니다.", "국채 메리트의 사후 차트 정제는 다음 관측을 사용할 수 있습니다. 이를 실시간 신호나 백테스트 전처리로 옮기지 않습니다.", "관측 없는 값을 0으로 대체하거나, 비활성 모형을 유효한 0% 위험으로 처리하지 않습니다."],
      checks: ["미래 입력을 바꿔도 과거 예측이 달라지지 않는지 검사합니다. 단, 사후 표시용 정제는 별도 검증합니다.", "누락·상수·짧은 표본·완료되지 않은 월·관측일 불일치를 각각 넣어 사유와 출력 제거를 확인합니다."]
    },
    {
      id: "state-contract",
      title: "상태 경계 · 게시 데이터와 사용자의 적용값",
      purpose: "인수인계에서 재현해야 할 것은 코드뿐 아니라 해당 결과를 만든 입력 상태입니다. 저장값이 같아도 미적용 편집값과 적용 결과를 혼동하면 비교가 어긋납니다.",
      formulas: [],
      code: `load_published_JSON_and_validate_required_fields()
restore_module_specific_browser_settings()
keep_editable_draft_separate_where_apply_is_required()
validate_and_commit_only_the_requested_module_inputs()
recompute_dependent_views_using_applied_state()
export_values_with_units_dates_and_assumptions()`,
      note: "CMA·SAA/TAA·헤지 B/C 등은 각 적용 규칙을 따릅니다. 컨센서스와 조회기간은 별도 상태이며 모든 화면에 동일한 적용 버튼 규칙이 있다고 가정하지 않습니다. Pseudo의 복사는 문서만 내보냅니다.",
      decisions: ["사용자 가정 변경과 시장 데이터 갱신은 별개입니다. 같은 표본을 유지한 비교인지 먼저 확인합니다.", "브라우저 저장값은 중앙 서버의 기관 공통 설정이나 Data 저장소 원본 수정이 아닙니다."],
      checks: ["입력 편집만 했을 때와 적용을 눌렀을 때의 결과를 구분하고 새로고침·테마 변경·탭 재진입을 점검합니다.", "Pseudo를 읽고 복사하는 동안 금융 데이터와 localStorage의 금융 키가 바뀌지 않는지 확인합니다."]
    },
    {
      id: "change-protocol",
      title: "변경과 인수 · 구현 보존에서 확장 검증까지",
      purpose: "개발팀은 동작 재현과 모형의 경제적 타당성을 별도로 검토합니다. 새로운 요구를 추가해도 기존 판단 근거와 실패 사유를 추적할 수 있게 남깁니다.",
      formulas: [],
      code: `freeze_reference_commit_inputs_and_expected_outputs()
classify_change_as_display_contract_or_model_change()
map_impacted_consumers_from_the_codespace()
compare_old_and_new_under_identical_inputs()
run_boundary_contract_and_independent_numeric_checks()
record_known_limits_and_update_the_Pseudo_document()
deploy_only_after_repository_checks_and_requested_merge()`,
      note: "모형 변경 시 동일 입력의 구·신 버전 비교가 첫 단계입니다. 투자 성과 개선 주장은 추가로 미사용 기간·동일 정보시점·비용·국면별 실패를 확인해야 합니다. 아래 검증 목록은 인수 기준이며 모두 실행 완료했다는 표시가 아닙니다.",
      decisions: ["향후 공용 스키마·새 모델 인터페이스·중앙 설정 저장은 확장 방향입니다. 현재 자동으로 제공되는 기능으로 인계하지 않습니다.", "의미가 바뀌면 해당 모듈의 문서·계약·소비 화면을 함께 수정하고, 입력과 코드 버전으로 복구 가능한 기준을 남깁니다.", "JSON 게이트 통과는 금융 모형의 타당성이나 OOS 우월성을 증명하지 않습니다."],
      checks: ["독립 계산 또는 작은 경계 사례로 수치 일치 확인 후, 탭·복사·수식·결측·좁은 화면의 회귀검사를 수행합니다.", "PR에 대상 저장소·기본 브랜치·기준 커밋·변경 파일·검증 환경·미해결 범위를 기록합니다."]
    }
  ]
};
