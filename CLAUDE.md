# CLAUDE.md — Investment Analytics Workbench

> 이 문서는 **코드가 어떻게 생겼나**를 다룬다. **무엇을 왜 이렇게 만들기로 했고 다음에 뭘 할
> 차례인가**(사용자와의 합의 사항·거부된 시도·미해결 데이터 요청·로드맵)는
> **`docs/HANDOVER.md`** 에 있다. 새 세션은 둘 다 읽고 시작할 것.

이 저장소는 **공개** 저장소이며, 비공개 데이터에서 공개 대시보드를 만들어내는 사슬의 가운데 토막이다.
비공개 저장소 `hyeongjunkim0934/data`(로컬 체크아웃 `../Data`)의 `raw/*.xlsx` 가 갱신되면 그쪽
`notify-workbench.yml` 이 `repository_dispatch(data-updated)` 를 이 저장소로 쏘고, 여기 CI가 그 비공개
저장소를 `source-data/` 로 체크아웃 → `pipeline/process.py` 로 파생 JSON 생성 → `dashboard/` 와 함께
GitHub Pages 배포까지 수행한다. 즉 **원본은 여기 없고, 여기 있는 것은 가공 코드와 표시 코드뿐**이다.
세 번째 저장소 `AIs`(검증 패널 에이전트 정의)는 이 코드와 런타임 의존이 없다.

## 저장소 지도

| 경로 | 역할 |
|---|---|
| `pipeline/process.py` | CLI 진입점. 엑셀 파싱 → 시리즈 저장소(`SERIES`) → 패널 빌더 → JSON 15개 출력 |
| `pipeline/risk.py` | `build(SERIES, warn)` → `risk.json` + `events.json` + 관계분석용 주간 프레임 (요인 점수·IC가중 합성·이벤트 검출) |
| `pipeline/hedge.py` | `build(SERIES, warn)` → `hedge.json` (7통화 헤지 매트릭스·백테스트·시뮬레이터 공분산) |
| `pipeline/alloc.py` | `build(SERIES, warn)` → `alloc.json` (자산배분 원천 10개 공분산·현재 금리·동일 샤프 앵커·블록 부트스트랩 사전계산. **원본 수익률 미게시** — 공분산·평균·분위수만) |
| `pipeline/panel.py` | `build(SERIES, risk_weekly, warn)` → `panel.json` (관계분석용 주간 정렬 패널. 공개 변수는 `VARS` 화이트리스트로만 통제) |
| `pipeline/breadth.py` | 미국 증시 데일리 리포트 → **집계 지표만** (`us:*` 12개). 파일 하나 = 관측 하루라 이력은 날짜별 파일이 쌓여야 생긴다. **종목 단위(티커·회사명·현재가)는 한 줄도 읽지 않는다** — 공개 저장소이므로 그 계약이 값 정확도만큼 중요하고, `tests/test_breadth.py` 가 상세 시트를 일부러 넣고 유출이 없는지 확인한다 |
| `pipeline/common.py` | 공용 산식 한 벌 — `epoch_seconds`/`pack_values`/`spearman`/`auc`. 위 넷과 연구 하네스가 전부 여기서 가져온다 |
| `pipeline/check_output.py` | **배포 게이트**. 산출물이 JSON 계약을 지키는지 보고 아니면 exit 1. 표준 라이브러리만 씀 |
| `pipeline/research/wf_validation.py` | 가중치 방식 비교용 수동 연구 하네스. **CI에서 실행되지 않음**. 요인 정의는 `risk.factor_specs` 에서 import |
| `pipeline/requirements.txt` | 파이프라인이 직접 import 하는 3개를 `==` 로 고정 |
| `tests/` | pytest 스위트 + 합성 엑셀 픽스처 생성기(`synth.py`). **비공개 데이터 불필요** |
| `tests/test_dashboard_ux.py` | 대시보드 UI 회귀 — **값을 실제로 계산**해서 본다. 색·크기는 CSS를 파싱해 WCAG 수식으로 직접 계산하고, 동작은 아래 두 파일로 app.js를 실행시켜 확인한다 |
| `tests/domshim.js` `tests/dashboard_probe.js` | `dashboard/app.js` 를 **node 안에서 실제로 실행**시키는 최소 DOM 셰이드와 측정 하네스. npm 의존성 0(node 표준 라이브러리만). 소스 문자열만 보는 테스트가 "이름은 남기고 동작만 뒤집는" 회귀를 못 잡아서 만든 것이다 — 이 하네스를 만들 때 쓴 뮤테이션 18건은 18/18을 잡는다. **다만 이것을 전면 커버리지로 읽지 말 것**: 독립적으로 만든 뮤테이션 32건으로 다시 재면 24/32다. 지금 **안 잡히는 것이 확인된 자리** — ① `stampLatest` 의 다계열 최신 인덱스 선택(`Math.max` → `Math.min`) ② `baseAxes` 의 refmt 를 조건 없이 항상 적용 ③ 오버레이 닫을 때 `body.style.overflow` 미복구 ④ `aria-current` 미설정 ⑤ 뒤에 오는 CSS 규칙으로 `:focus-visible` outline 무력화(테스트가 첫 규칙만 본다) ⑥ `stampLatest` 의 중복 표기 가드 제거 ⑦ index.html 의 본문 바로가기 링크 삭제(마크업 검사 없음) ⑧ 모션 축소 블록 뒤에서 `scroll-behavior: smooth` 재활성화. 이 여덟은 지금 코드에서는 정상이지만 **회귀가 조용히 통과한다** — 손댈 때 테스트를 먼저 붙일 것. app.js가 새 DOM API를 쓰면 셰이드가 먼저 터지므로 그때 채워 넣으면 된다(그렇게 `after()`·`play()`/`pause()`·`visibilityState` 를 채웠다). **장면 자동 순환 검사도 여기 있다** — `setInterval` 을 기록만 하도록 바꿔 15초를 기다리지 않고 틱 본문을 직접 돌린다(자작 뮤테이션 20/20, 같은 이유로 과대평가로 읽을 것). **환헤지 2차 패스(141개)에도 같은 성격의 공백 10곳이 실측돼 있다** — 그중 넷이 부호·단위 자리다(`carryTxt` 의 ± · `index.html` `#fx` 의 정적 부호 문장 · `#hedge-lead` 의 받는/내는 분류 · MTM 연율화 `√12`). 목록은 `docs/HANDOVER.md` §5.3.1 |
| `tests/requirements.txt` | 테스트 전용 의존성(pytest). `pipeline/requirements.txt` 와 분리. **node 는 여기 없다** — `test_dashboard_ux.py` 가 쓰는 node 는 GitHub 호스팅 러너 기본 탑재분이며, 없으면 skip 이 아니라 **실패**한다(조용히 건너뛰면 막으려던 회귀가 되살아난다) |
| `pytest.ini` | `testpaths = tests` |
| `dashboard/index.html` `app.js` `style.css` | 정적 대시보드 (섹션 14개, **다크 기본**+라이트, 기간 필터, 마을 홈+관문. 명암과 마을 낮/밤은 **별개 축** — 아래 「어디를 고치면 무엇이 바뀌나」). **app.js 가 DOM 으로 조립하는 표에는 `<tbody>` 가 없다** — `createElement("table")` 에 `<tr>` 을 직접 붙이면 브라우저가 tbody 를 끼워 넣지 않기 때문이다. 그래서 `style.css` 에는 `thead th`/`tbody td` 와 `table > tr > th|td` **두 벌**이 있어야 한다. 한 벌만 두면 조립 표(#hedge·#alloc·#panel)의 숫자 셀이 조용히 padding 1px·왼쪽 정렬로 렌더된다 (실제로 117칸이 그 상태였다). 회귀 테스트 있음 |
| `dashboard/assets/` | 마을 지도 이미지(`village-day.webp`·`village-night.webp`)를 두는 자리. 넣는 법·금지 사항은 같은 폴더 `README.md` |
| `dashboard/vendor/uplot.min.{js,css}` | 벤더링된 유일한 프런트 의존성 (외부 네트워크 요청 없음) |
| `.github/workflows/build-dashboard.yml` | dispatch/수동/push 트리거 → **test → build(+배포 게이트) → deploy**. build 잡은 게이트 뒤에 `Build summary` 단계로 시리즈 수·최종 관측일·JSON 수·경고를 `$GITHUB_STEP_SUMMARY` 에 표로 붙인다(`if: always()` — 게이트가 막아 실패한 실행에서도 남는다) |
| `.github/workflows/tests.yml` | PR·push 에서 pytest 만 (비공개 데이터·Pages 권한 없음) |
| `.github/dependabot.yml` | `pipeline/`·`tests/` pip + Actions 주간 업그레이드 PR |
| `docs/SETUP.md` | 토큰·시크릿·Pages 초기 설정 (GitHub 웹에서만 하는 작업) |
| `docs/HANDOVER.md` | 설계 합의·거부된 시도·미해결 데이터 요청·다음 작업 (세션 인수인계) |

## 자주 쓰는 명령 (아래 여섯은 모두 실제 실행으로 확인함)

```bash
pip install -r pipeline/requirements.txt
pip install -r tests/requirements.txt      # 테스트를 돌릴 때만

# 테스트 (합성 픽스처 — ../Data 없이 돈다, 약 67초). 현재 265개.
#   대시보드 동작 검사만 따로:  python -m pytest tests/test_dashboard_ux.py   (1초 미만)
#   하네스 단독 실행(디버깅용): node tests/dashboard_probe.js
python -m pytest

# 배포 게이트 — 파이프라인 출력이 JSON 계약을 지키는지. 실패하면 exit 1
python pipeline/check_output.py --out _site/data --max-warnings 20 --min-series 100 \
  --dashboard dashboard/app.js

# 파이프라인 — --data-dir 는 data 저장소 체크아웃(재귀 탐색), --out 은 JSON을 쏟을 디렉터리
python pipeline/process.py --data-dir ../Data --out _site/data

# 대시보드 로컬 서빙 (JSON은 index.html 옆 data/ 에 있어야 한다)
cp -r dashboard/. _site/
cd _site && python -m http.server 8000     # http://localhost:8000

# 연구 하네스 (표만 stdout으로 출력, 파일 안 씀 — 약 30초)
python pipeline/research/wf_validation.py --data-dir ../Data
```

- 파이프라인 정상 출력: 약 **40~55초**(자산배분 표본 재추출 사전계산 포함), exit 0, `parsed N series from M files` 뒤에 `wrote …` **15줄**
  (합계 약 2.1MB), 마지막 줄 `N warning(s) — see meta.json`.
- **15는 코드가 정한 수**(아래 JSON 계약)라 달라지면 그 자체가 버그다. 반대로 `N`·`M`·경고 건수는
  `--data-dir` 의 엑셀에서 오는 수라 데이터를 갱신하면 정상적으로 바뀐다 — 현재 `../Data` 기준선은
  **456 시리즈 / 5 파일 / 경고 7건**(전부 stderr의 `data_bb.xlsx/D: duplicate column …`)이며, 이 기준선의
  정본은 Data 저장소 쪽(`../Data/CLAUDE.md`)이다. 급감이나 경고 성격 변화만 신호로 볼 것.
  데일리 리포트를 더 올려도 **시리즈 수는 456 그대로**이고 각 `us:*` 의 관측 수만 는다 —
  파일 하나가 하루치이기 때문이다(파일 수와 `meta.json.files` 항목은 는다).
- 서빙 확인: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/data/meta.json` → `200`.
- `python -m pipeline.process` 는 **실패한다**(`No module named 'hedge'`). `pipeline/` 에 `__init__.py` 가
  없고 `process.py` 가 `import risk` / `import hedge` 를 평면으로 하므로 반드시 스크립트 경로로 실행할 것.

## 출력 JSON 계약

`process.py` 의 `payloads` 딕셔너리와 `dashboard/app.js` 의 `FILES` 상수가 **같은 15개**로 1:1 대응한다:
`meta` `overview` `risk` `events` `panel` `hedge` `alloc` `rates` `irs` `credit` `fx` `inflation` `acwi` `macro` `catalog`.
JSON을 추가/삭제하면 **양쪽을 같이 고쳐야 한다.**

- 대시보드는 `fetch("data/<이름>.json")` 상대경로로 읽는다 → `--out` 은 항상 `index.html` 옆 `data/` 여야 하고,
  CI도 `--out _site/data` 를 준다. 이 `fetch` 때문에 `index.html` 을 `file://` 로 여는 것으로는 부족하고,
  위 `http.server` 처럼 HTTP로 서빙해야 한다.
- 로딩은 `Promise.allSettled` — JSON 하나가 없거나 깨져도 나머지 섹션은 렌더된다.
- 시계열 페이로드 형식은 전부 `{"t": [unix초], "v": [값]}`. `pack()` 이 최근 5년(`daily_years`)은 일별,
  그 이전은 주별(W-FRI)로 축약한다.
- `meta.json` 은 빌드 시각·최종 관측일·시리즈 수·파일별 파싱 결과·경고 목록을 담는다. 경고는 페이지
  **푸터**에서 `#build-line` **바로 다음 형제** `<div id="build-warnings">` 안에 `<details>` 로
  붙어 화면에서 펼쳐 볼 수 있고, 콘솔(`pipeline warnings:`)에도 그대로 찍힌다.
  **이 `<details>` 를 `<p id="build-line">` 안으로 옮기지 말 것** — 펼치는 순간 문단 높이가
  18px→209px 로 늘며 빌드 메타 줄과 설명 문장이 같은 시각적 줄에 겹치고, `<p>` 안의
  `<ul>`/`<p>` 는 HTML 콘텐츠 모델 위반이다(둘 다 실제 클릭으로 재현함. 회귀 테스트 있음). 헤더(`#meta-line`)에는 기준일·빌드·시리즈 수만 나오고 경고는 없다.
- `catalog.json` 은 **값 없이 메타데이터만**(키·출처·카테고리·기간·관측 수). 여기에 값을 넣지 말 것.

## 시리즈 키 규약

`load_data_dir()` 은 `.xlsx`·`.xlsm` **양쪽**을 대상으로 삼고, 확장자와 무관하게 소문자 파일명 **접두사**로만
파서를 고른다(`data_bb2.xlsm` 도 1행). 고른 파서가 곧 키 접두사를 정한다.

| 판정 | 파서 | 키 형식 |
|---|---|---|
| 파일명이 `data_bb` 로 시작 | `parse_wide(p, "bb")` | `bb:<Notation>` |
| 파일명이 `data_info` 로 시작 | `parse_wide(p, "info")` | `info:<Notation>` |
| **시트에 `Market Overview` 가 있음** | `breadth.parse(p, warn)` | `us:<지표>` (집계만) |
| 그 외 전부 | `parse_index_export(p)` | `idx:<A1 첫 공백 토큰>` (예: `ACWI08.xlsx` → `idx:ACWI`) |

- **데일리 리포트만 파일명이 아니라 내용으로 판정한다**(`breadth.is_stock_report`). 그 파일은
  `Daily_Stock_Report_26.08.04.xlsx` 처럼 **날짜가 박힌 이름으로 배포**되므로 접두사 규약을 매일
  지키게 하면 언젠가 반드시 잊고, 잊은 날의 파일은 조용히 지수 익스포트 파서로 흘러가 버려진다.
- **리포트의 관측일은 파일명이 아니라 본문**("미국 2026-08-03 종가 기준")에서 온다. 파일명 날짜는
  작성일이라 하루 뒤다 — 파일명을 믿으면 모든 관측이 하루씩 밀린다.

- 키의 뒷부분은 엑셀 헤더 문자열 **그대로**다 — 한글·`&`·`_` 가 그대로 들어간다(`bb:미국_S&P500_TR`).
  코드에 키를 적을 때 정규화하지 말 것.
- 같은 시트에 같은 Notation이 두 번 나오면 두 번째는 경고 후 버려진다.
  **이 경고를 "무해한 중복"으로 읽지 말 것** — 현재 기준선의 경고 7건을 실측한 결과 버려지는 컬럼
  7개 중 **6개는 값이 서로 다른 별개 시리즈**였다(같은 라벨을 공유할 뿐). 즉 파서는 조용히 실데이터를
  버리고 있고, 라벨이 겹치는 한 어느 쪽이 채택되는지는 **컬럼 순서**가 정한다. 어떤 라벨이 어떤
  상품이었는지는 비공개 `../Data` 의 CLAUDE.md 에 실측 표로 적어 두었다(벤더 값이라 여기에는 옮기지
  않는다). 그중 **하나는 채택되는 컬럼 자체가 오라벨**이라 `catalog.json` 에 나가는 키 이름이 실제
  내용과 다르다 — 다행히 그 키를 읽는 코드가 없어 게시된 **값**은 영향받지 않지만, **공개 메타데이터가
  틀린 상태**다. 고치는 자리는 이 저장소가 아니라 **벤더 익스포트 템플릿의 Notation 라벨**이다.
  같은 키가 여러 파일에 있으면
  **마지막 관측일이 더 늦은 쪽이 겹치는 날짜에서 이긴다**(`add_series`).
- `.xls` 는 경고만 남기고 스킵, `~$` 임시 파일은 무시.
- `get(key)` 는 없는 키에 경고를 남기고 `None` 을 돌려준다 → 패널 빌더는 그 항목만 조용히 건너뛴다.
  차트가 통째로 비어 있으면 대개 키 오타이고, 로그의 `series not found:` 가 답이다.

## 어디를 고치면 무엇이 바뀌나

- **공개되는 시리즈 목록은 한 곳에 모여 있지 않다.** 이름 붙은 상수(`OVERVIEW_CARDS`, `CURVES`,
  `IRS_TENORS`/`IRS_COUNTRIES`, `KR_CREDIT_3Y`, `MACRO_DEFS`)와, `build_rates` / `build_irs` /
  `build_credit` / `build_fx` / `build_inflation` 안에 **인라인으로 박힌 `series_group([...])`
  리스트**에 절반씩 흩어져 있다(전수는 `grep -n "series_group(\[" pipeline/process.py`).
  여기에 더해 `risk.py` 의 `Indicator` `spark` 와 `hedge.py` 의 `cost_hist_usd`·`cost_hist_curve`,
  그리고 **`panel.py` 의 `VARS`** (관계분석용 30개 변수의 주간 수준값 전 구간)도 원본 값을
  그대로 싣는다. `alloc.py` 는 예외적으로 **원본 값을 싣지 않는다**
  — 게시물은 원천 10개의 공분산·평균·부트스트랩 분위수뿐이다(`tests/test_contract.py` 의 유출 가드가 이를 강제).
  어느 경로든 넣은 시리즈의 **값이 Pages로 나간다** — 상수만 훑고 공개 범위를 판단하면 크게 과소평가한다.
- **리스크 요인 구성·가중** = `risk.py` 의 **모듈 수준** `derive_inputs()`(원천·파생 시리즈)와
  `factor_specs()`(요인 11개 = 스트레스 6 + 취약성 5, 각 `Indicator` 모드 `hi`/`lo`/`up`),
  상수 `FLOOR`/`EMBARGO_W`/`REFIT_EVERY_W`. 등급 밴드는 `GRADE_BANDS`.
  이 둘은 `risk.build()` 안에 있던 것을 밖으로 뺀 것이다 — `research/wf_validation.py` 가
  **같은 정의를 import** 해 쓰기 위해서다. 요인을 고치면 배포 코드와 검증 하네스가 함께 바뀐다.
- **이벤트 규칙**은 두 곳이다. 시계열 기반(급변 2.5σ·백분위·커브·삼 룰·데이터 지연)은
  `risk.py` 의 `detect_events()`, **시장 폭**(`시장폭` 카테고리)은 `breadth.py` 의
  `detect_events()` 다. 후자는 **이력이 필요 없다** — 같은 날 안에서 두 수를 비교하는
  횡단면 조건이라 관측 1일로도 성립하고, 그래서 **임의 기준이 하나도 없다**(부호 비교와
  만장일치 조건뿐). 둘을 합치는 자리는 `process.py` 이며 **서로 다른 try 블록**이다.
  아래는 시계열 쪽 설명이다 — `risk.py` 의 `detect_events()` (급변 2.5σ·백분위 90% 교차·커브 역전·삼 룰·데이터 지연).
  규칙을 바꾸면 화면에 노출되는 `catalog` 설명 문구도 같은 함수 안에서 같이 고칠 것.
- **헤지 레버의 자유도는 실질 1개다 — 「최적 헤지비율 한 점」을 적지 말 것.**
  `alloc.py` 의 `loadings()` 에서 두 레버는 **같은 방향 벡터 `FX_DIR = e_usd − swap` 의
  스칼라배**로만 들어간다: `x(hb,he) = x1 + [w채(1−hb) + w주(1−he)]·g = x1 + Xe·g`.
  따라서 **경제 관점 위험은 총 미헤지 환노출 `Xe` 하나로만 결정되고, 같은 Xe 를 만드는
  모든 (hb,he) 의 σ 가 정확히 같다**(근사가 아니라 항등식. 실측 확인: 소수 6자리까지 동일).
  이 성질을 모르고 격자 `argmin` 으로 한 점을 골라 「최적」이라 적었더니 **동점 중 스캔
  순서가 먼저 만난 구석**이 나갔고, 하필 「해외주식 100% 헤지」라는 가장 반직관적인 값이라
  사용자가 자연헤지 통념과 어긋난다고 지적해 발견됐다. 지금 코드는
  ① `hedge_xe_min()` 이 **폐형**으로 Xe\* 를 구하고(격자 없음 → 양자화 오차 0),
  ② 화면에 적는 (hb,he) 쌍은 `hedge_pair_for_xe()` 가 고른 **현재값 최근접 대표점**임을
  명시하며(유클리드 정사영 — 임의 계수 0개), ③ 밴드가 물면 그 사실을 화면에 적는다.
  **`hb_star`/`he_star` 를 되살리지 말 것** — 그 분위수는 임의 선택의 분포였다.
  게시되는 것은 `boot.rows[].xe_star`/`xe_open`/`share_xe_interior` 다.
  **회계 관점은 예외** — `d_swap` 의 `−h·τ` 때문에 붕괴하지 않는다. `app.js` 의 `xeQuad()` 는
  주석이 아니라 **실제 가드**로 회계 관점 호출을 막는다(회귀 테스트 있음).
- **헤지비율 밴드(내규)는 기관 내부정보라 코드 기본값이 중립(0~100)이다.** `alloc.py`
  `DEFAULTS["h_bands"]`/`["h_tol_hi"]` 와 `app.js` `allocHBands()` 가 정본이며, 특정 기관의
  내규 숫자를 여기 박지 말 것(공개 저장소 — 사용자 입력은 브라우저 localStorage 에만 남는다).
  `h_tol_hi`(일시 초과 허용선)는 **결정범위와 다른 칸**이다: 펀드 NAV 감소로 헤지 계약을
  즉시 줄이지 못해 생기는 운영 허용오차이지 최적화가 고를 선택지가 아니다.
- **ALM 듀레이션 갭은 제약이 아니라 결과 표시다.** 사용자 확인 결과 내규 한도가 없어
  허용 괴리폭을 지어낼 수 없다(자의성 금지). `app.js` 의 `ALLOC_DUR_KEYS`/
  `allocAssetDuration()`/`allocDurGap()` 이 정본이며, 자산 듀레이션을 **배분에서 계산**하므로
  배분을 바꾸면 갭이 따라 움직인다. 자산군별 듀레이션(`dur_by`)을 하나도 입력하지 않으면
  `null` 을 돌려주고 화면이 수기 `dur_asset` 으로 물러난다 — **0 을 만들어내지 않는다.**
  주식·대체는 표준 근사대로 0이고, 해외채권은 해외 금리 민감도라 원화 부채와 같은
  위험요인이 아니어서 사용자가 0으로 빼도록 화면에 안내한다(우리가 정하지 않는다).
- **환헤지 통화·프록시** = `hedge.py` 의 `CURRENCIES`/`FX`/`BONDS`/`R3M`.
- **헤지비용의 이름·부호는 파이프라인이 정한다.** `hedge.py` 의 `cost_curve`/`cost_12m` 을 문서·`limits` 가 일관되게 「헤지비용」이라 부르고 `alloc.py` 도 같다 — 화면에서 새 이름을 만들면 방법론 패널이 출력하는 `limits` 문장과 어긋난다. 부호는 산식이 정한다(캐리 = A×h×cost, 회계모형 ④, 백테스트 `+h*f`) → **양수 = 받음**. 화면 쪽 정본은 `app.js` 의 `COST_SIGN_KEY` **한 상수**이며 #hedge·#fx·#alloc·시뮬레이터·방법론이 공유한다. 값을 표시하는 모든 문장은 **자기 만기를 밝혀야 한다** — 매트릭스는 12개월, 시뮬레이터는 `default_tenor_m`(9개월) 보간이라 같은 통화가 다른 숫자로 나온다(엔 +2.30% vs +2.3550%).
- **관계분석 변수 목록·기본 선택** = `panel.py` 의 `VARS`/`DEFAULT_VARS`. 통계(상관·교차상관·OLS+HAC)는
  파이썬이 아니라 `app.js` 의 통계 엔진(`pearson`/`crossCorr`/`ols`/`normInv`)에서 브라우저가 돌린다 —
  방법론을 바꾸려면 그쪽을 고친다.
- `wf_validation.py` 는 `process.load_data_dir()` + `risk.derive_inputs`/`risk.factor_specs` +
  `risk` 의 상수 + `common.spearman`/`common.auc` 를 import 한다. 이 파일이 스스로 정하는 것은
  **평가 설계**(가중 방식·타깃·표본 외 구간)뿐이다.
- **JSON 15개 계약은 세 곳에 적혀 있다**: `process.py` 의 `payloads`, `dashboard/app.js` 의 `FILES`,
  `pipeline/check_output.py` 의 `EXPECTED`. 하나만 고치면 `tests/test_contract.py` 가 잡는다.
- **화면 전환·마을 내비게이션** = `app.js` 의 `routeView()`. 섹션은 **한 번에 하나만** 보인다
  (마을 또는 섹션 1개) — 14개를 세로로 쌓지 않는 것이 이 구조의 요점이다. 섹션을 추가하면
  `SECTION_IDS`·`VILLAGE_ZONES`·`index.html` 세 곳을 함께 고쳐야 하고, 오버레이 해시를 추가하면
  `underlyingSection()` 에 그 아래 깔릴 섹션을 등록해야 딥링크가 산다.
  `tests/test_contract.py` 의 마을 계약 테스트가 이 대응을 강제한다.
- **테마는 축이 둘이고 서로 무관하다** (2026-08-04 사용자 지시). ① **명암**(chrome) =
  `data-theme` — **속성이 없는 상태가 다크이고 그게 기본값**이다. CSS 에는 `:root`(다크) 와
  `:root[data-theme="light"]` 두 벌만 있고 `prefers-color-scheme` 도 `[data-theme="dark"]` 도
  **없다**(있으면 토큰이 두 벌로 갈라진다 — 실제로 한 번 프로덕션에 나간 사고다).
  ② **마을 장면** = `data-scene="day"|"night"` — 지도 이미지·상시 루프·전환 영상·`.vz-label`·
  주변 SVG 효과가 이 축에 달린다. JS 진입점은 `currentTheme()` / `currentScene()` 두 함수다.
  섞으면 "대시보드를 어둡게" 가 곧 "마을이 밤" 이 되던 예전 상태로 돌아간다.
  토글 버튼(`#theme-btn`)은 **보고 있는 화면에 따라 다른 축을 바꾼다** — 마을이면 장면,
  섹션이면 명암(`syncThemeButton()` 이 라벨을 맞춘다).
  마을은 그냥 두면 **15초마다 낮↔밤이 자동으로 바뀐다**(`SCENE_CYCLE_MS` — 사용자가 정한 수).
  `sceneCycleAllowed()` 가드 5개(reduced-motion·마을 비가시·관문·백그라운드 탭·좁은 화면)를
  전부 통과할 때만 돌고, 시작/정지 훅은 `routeView`·`bindGate`·`enterZone`·`visibilitychange`·
  reduced-motion `change` 다. 순환은 `renderAll()` 이 아니라 `renderVillage()` 만 부른다.
  **「자동 낮밤순환 금지」 규약은 이 지시로 해제된 것**이며(`docs/HANDOVER.md` §3.3),
  `prefers-reduced-motion` 은 해제되지 않았다.

## 실패 처리 규약 (새 계산 블록도 이 패턴을 따를 것)

- xlsx가 하나도 없으면 `load_data_dir()` 이 즉시 `exit 1` — `--out` 디렉터리는 아직 만들어지지도 않는다.
- 파싱된 시리즈가 10개 미만이면 `main()` 이 `too few series parsed` 로 `exit 1`. 망가진 업로드가 기존
  대시보드를 지우는 것을 막는 가드다.
- `risk.build` / `hedge.build` 는 각각 `try/except` 로 격리된다 — 실패하면 traceback을 찍고 `warn()` 만
  남긴 뒤 **해당 JSON 없이** 나머지를 만든다. `process.py` 자체는 여전히 exit 0 이다.
  **이 상태를 잡는 것이 `pipeline/check_output.py` 배포 게이트**이며, `build-dashboard.yml` 의
  build 잡 마지막(artifact 업로드 직전)에서 돈다. 게이트가 막으면 deploy 잡은 시작되지 않는다.
- `warn()` 은 stderr 출력 + `WARNINGS` 누적 → `meta.json.warnings` 로 표면화된다. 조용히 삼키지 말 것.

## 함정

- **`hidden` 속성은 클래스의 `display` 선언에 진다.** UA 스타일이라 우선순위가 가장 낮다 —
  `.gate{display:flex}` 때문에 `hidden` 인 관문이 화면을 계속 덮고 클릭을 가로챈 적이 있다
  (JS 는 정상이었고 브라우저에서만 드러났다). `style.css` 맨 위 전역
  `[hidden]{display:none!important}` 이 방어선이며 회귀 테스트가 붙어 있다.
- **이 컨테이너 헤드리스 Chromium 의 로케일은 `en-US@posix`** 라 uPlot 이 로드 도중
  `Invalid language tag` 로 죽고, 그 뒤 `renderAll()` 이 통째로 실패해 화면이 빈다. Playwright 로
  확인할 때는 `newPage({ locale: 'en-US' })` 를 줄 것 — 코드 결함으로 오진하기 쉽다.
- **테스트는 합성 픽스처로만 돈다.** `tests/synth.py` 가 만드는 워크북에는 벤더 값이 한 톨도 없다 —
  공개 저장소이므로 `../Data` 의 값이나 그 파생물을 픽스처로 커밋하지 말 것. 실데이터 회귀는 여전히
  파이프라인을 완주시켜 시리즈 수·JSON 15개·경고 건수를 변경 전과 비교하는 방식으로 한다.
- **기본 브랜치는 아직 기계 생성 세션명**(`claude/data-repo-dashboard-automation-cj8y59`)이다.
  `main` 으로의 rename 은 **아직 하지 않았다** — GitHub 웹 Settings 작업이라 사람이 해야 한다.
  `build-dashboard.yml` 의 `push:` 트리거는 `[main, master, "claude/…cj8y59"]` 세 이름을 모두 담고
  있어 rename 전후 어느 쪽에서도 트리거가 끊기지 않는다. **rename 을 마친 뒤에** 세션명 한 줄을
  지우면 된다. rename 시 진짜로 빠뜨리기 쉬운 것은 **Settings → Environments → github-pages →
  Deployment branches** 에 새 이름을 추가하는 일이고, 빠뜨리면 build 는 성공하고 deploy 단계만
  실패한다 (`docs/SETUP.md`「참고 — 브랜치 관련」). `dependabot.yml` 은 일부러 브랜치를 안 적는다.
- **`../Data` 는 아직 LFS 가 아니다 — 소비자 쪽 준비만 되어 있다.** `build-dashboard.yml` 의 data
  체크아웃에 `lfs: true` + `git lfs pull` 이 이미 들어 있고, 현재 상태에서는 둘 다 no-op 이다.
  먼저 넣어 둔 이유는 순서 위험 제거다 — data 가 LFS 로 전환된 순간 이 두 줄이 없으면 파이프라인이
  130바이트 포인터를 읽고 `zipfile.BadZipFile` 로 죽는다. 뒤따르는 "PK 로 시작하는지" 확인 단계는
  LFS 와 무관하게 잘린 업로드·오류 페이지까지 명시적 오류로 잡아 준다.
  data 저장소의 LFS 전환 여부는 **미결 상태**다 (`../Data/CLAUDE.md`「LFS — 아직 적용 전」).
- CI는 **Python 3.12** 고정. 로컬 인터프리터가 다르면 pandas 동작 차이가 날 수 있다.
- 의존성은 `pipeline/requirements.txt`(런타임 3개)와 `tests/requirements.txt`(pytest)에 `==` 로
  **고정되어 있다**. 둘을 섞지 말 것 — pytest 는 런타임 의존이 아니다. 손으로 숫자를 바꾸지 말고
  dependabot이 여는 주간 PR로 올릴 것. 버전 숫자를 다른 문서에 복사해 두지도 말 것.
- `_site/`, `source-data/`, `__pycache__/` 는 `.gitignore` 대상이다. CI가 비공개 데이터를 체크아웃하는 이름이
  `source-data/` 이므로, 로컬에서도 그 이름을 쓰면 실수로 커밋될 일이 없다.

## 하지 말아야 할 것

- **원본 엑셀·비공개 데이터·토큰 값을 이 저장소에 두지 말 것.** 공개 저장소다. 로컬 실행 시 `--data-dir` 는
  저장소 **밖**(`../Data`)을 가리키고, `--out` 은 `_site/` 아래로만 보낼 것.
- 파이프라인이 만든 JSON을 커밋하지 말 것 — 빌드 산출물이며 CI가 매번 새로 만든다.
- 패널 정의에 시리즈를 추가하는 것은 **그 값을 공개하는 행위**다. 벤더 약관상 값 공개가 곤란한 시리즈는
  넣지 말 것 (카탈로그에는 값 없이 메타데이터만 실린다).
- `dashboard/` 에 CDN 스크립트를 추가하지 말 것 — 현재 외부 요청이 0이고 uPlot은 `vendor/` 에 벤더링되어 있다.
