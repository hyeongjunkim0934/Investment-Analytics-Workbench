# Pseudo 갱신 규칙

홈페이지 `#pseudo`는 네 모듈의 IT 인수인계 문서다.
금융 계산의 정본은 Python/JavaScript 계산 함수이며 Pseudo는 검토하여 유지하는 문서다.
시장 JSON과 독립적으로 로드하며 계산 입력과 브라우저의 포트폴리오 저장값을 바꾸지 않는다.

| 화면 | 문서 | 주 계산 원본 |
|---|---|---|
| 리스크 | `dashboard/pseudo/risk.js` | `pipeline/risk.py` |
| 자산배분·CMA | `dashboard/pseudo/alloc.js` | `pipeline/port.py`, `dashboard/cma.js`, `dashboard/app.js` |
| 환헤지 | `dashboard/pseudo/hedge.js` | `pipeline/hedge.py`, `dashboard/app.js` |
| 환율전망 · 컨센서스·A/B/C/D·요약 | `dashboard/pseudo/fx.js` | `pipeline/fx_*.py`, `pipeline/research/fx_lstm_xgb_runner.py`(오프라인), `dashboard/fx-*.js`, `dashboard/summary-fx.js` |

각 문서는 `id`, `title`, `updated`, `summary`, `inputs`, `outputs`, `sources`, `sections`를 갖는다.
각 절은 `id`, `title`, `purpose`, `formulas`(latex·expression·legend), `code`, `note`,
`decisions`, `checks`로 구성한다. 비수학 절은 `formulas: []`를 허용한다.
`latex`는 KaTeX로 렌더하는 LaTeX, `expression`은 접근성 라벨·오류 대체용 일반 수식,
`legend`는 기호·단위·표본 설명이다. 세 표현의 의미를 함께 대조한다.
수식과 기호·단위 설명은 코드 블록 밖에 두며, 유사코드는 입력→검사→계산→출력 순서로 쓴다.
장기 인수인계 설명은 `purpose`·`note`·`decisions`에, 구체 인수 조건은 `checks`에 둔다.
검증 기준을 썼다는 사실을 실행 완료로 표현하지 않는다. 한 절에 5~12줄을 강제하지 않는다.
`sources`에는 실제 경로와 함수명을 적는다. 원자료·수치 시계열·기관 포트폴리오를 기록하지 않는다.

CMA는 자산배분 문서의 별도 절에서 관리한다. 하위 탭은
**리스크 → 자산배분 → 환헤지 → 환율전망**, 기본 선택은 리스크다.
`readingGuide`는 모듈 읽기 안내, 절별 목차는 포커스와 스크롤을 함께 이동시킨다.
적용된 자산별 CMA → 기존 수기 입력 → 게시 CMA/표본의 우선순위와 미헤지 CMA 이후 환헤지
반영 순서를 기록한다. 시나리오 확률가중 평균·총분산, 초안/적용값 분리, 기존 상관 유지,
사용자 3시나리오와 Conservative/Optimistic 경계선의 구분이 달라지면 함께 갱신한다.

## 모듈 변경 시

1. 수식, 입력 원천, 표본, 단위, 부호, 결측·이상치, 제약조건, 출력 의미 변경 여부를 확인한다.
2. 의미가 바뀌면 같은 PR에서 해당 문서의 수식·유사코드·짧은 주석·검토일을 갱신한다.
3. 연계 변경이면 상대 모듈도 대조한다. 예: 헤지비용 부호·환 공분산 변경은 자산배분도 확인한다.
4. `dashboard/index.html`의 수정한 문서 스크립트 `?v=`를 갱신한다.
5. `python -m pytest tests/test_pseudo.py`와 변경 계산에 해당하는 회귀검사를 실행한다.
6. 네 하위 탭, 목차, 복사, 라이트/다크·좁은 화면을 확인한다. PR에 문서 변경 또는 변경 불필요 이유를 적는다.

색상·배치만 바뀌고 계산 의미가 같으면 문서를 억지로 바꾸지 않는다.
검사는 문서 구조·참조 함수·실제 탭 동작을 점검하며 수식의 의미적 일치를 자동 증명하지 않는다.
UI는 `dashboard/pseudo.js`, 스타일은 `dashboard/style.css`에서 관리한다.
LaTeX는 `dashboard/vendor/katex/`의 **0.19.1 고정 배포본**으로 렌더한다.
JS·CSS·폰트·MIT 라이선스를 저장소에 포함하며 CDN·auto-render·외부 폰트 요청은 없다.
옵션은 `displayMode:true`, `throwOnError:true`, `trust:false`, `output:'htmlAndMathml'`다.
수식 실패나 라이브러리 누락 시 해당 식만 일반 텍스트로 되돌리고 화면에 상태를 알린다.
복사 결과에는 LaTeX `\[ … \]`, 판단 경계·검증 조건·절별 코드 링크가 포함된다.
긴 식은 식 영역에서 가로 스크롤하며 본문은 한 열로 읽는다. 스타일은 기존 테마 토큰을 따른다.

## 현재 구현에서 확인한 한계

2026-11-06 소스 대조 중 모형B 오프라인 러너의 LSTM 학습 시 마지막 입력과 라벨 사이가
`lag+1`행인 반면, 추론 결과의 게시 목표는 `lag`행임을 실제 `make_sequences` 함수의 작은
입력으로 확인했다. 결측 제거 후의 행 간격은 달력개월과 다를 수 있고, 표준화는 LSTM에만
적용된다. Pseudo는 이 현재 동작을 명시한다. 금융 코드를 이 문서 변경에 포함하지 않으며,
모형 수정 시 정렬 교정·산출물 재생성·동일 표본 재평가가 별도로 필요하다.
