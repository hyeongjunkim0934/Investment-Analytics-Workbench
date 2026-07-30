# Investment Analytics Workbench

보험사 자산운용(자산배분·리스크·운용 담당)을 위한 의사결정 보조 대시보드.
엑셀 업로드만으로 자동 갱신됩니다.

**현재 제공**: 리스크 스코어보드(현재 위험 = walk-forward 검증된 IC가중 + 최소바닥 —
`pipeline/research/wf_validation.py`, 잠재 위험 = 동일가중) · 이벤트 자동 검출(규칙 공개) ·
환헤지(7통화 — 경제/회계 이중 관점 참고치 + 시뮬레이터, 내부 수치는 브라우저에만 저장) ·
시장 모니터(금리/IRS/크레딧/FX/물가/지수/매크로) · 시리즈 카탈로그.
**로드맵**: 자산배분 시뮬레이터 → 모델 랩(전망 모델 백테스트).

**대시보드**: https://hyeongjunkim0934.github.io/Investment-Analytics-Workbench/

## 동작 방식

1. 비공개 저장소 [`hyeongjunkim0934/data`](https://github.com/hyeongjunkim0934/data)에 엑셀(.xlsx)을 업로드하면
2. 그 저장소의 `Notify workbench` 액션이 이 저장소로 `repository_dispatch(data-updated)` 이벤트를 보내고
3. 이 저장소의 [`Build & deploy dashboard`](.github/workflows/build-dashboard.yml) 액션이
   비공개 데이터를 체크아웃 → [`pipeline/process.py`](pipeline/process.py)로 파생 JSON 생성 →
   [`dashboard/`](dashboard/)와 함께 GitHub Pages에 배포합니다.

원본 엑셀은 이 공개 저장소에 **커밋되지 않습니다**. 빌드 러너 안에서만 읽히며,
Pages에 게시되는 것은 패널에 선별된 시리즈의 값(최근 구간 일별, 과거 구간 주별 축약)과
스프레드 등 파생 지표(JSON)입니다. **게시된 값은 공개 페이지에서 누구나 접근할 수
있으므로**, 벤더 약관상 값 공개가 곤란한 시리즈는 패널 정의에서 제외해야 합니다.
시리즈 카탈로그는 값 없이 메타데이터만 공개됩니다.

## 초기 설정

토큰·시크릿·Pages 설정(전부 GitHub 웹에서 가능)은 **[docs/SETUP.md](docs/SETUP.md)** 를 따라 진행하세요.

## 구성

| 경로 | 역할 |
|---|---|
| `pipeline/process.py` | 엑셀 파서(블룸버그/인포맥스 와이드, 지수 익스포트) + 파생 지표 계산 + JSON 출력 |
| `dashboard/` | 정적 대시보드 (uPlot, 라이트/다크, 기간 필터, 표/CSV 내보내기) |
| `.github/workflows/build-dashboard.yml` | dispatch 수신 → 빌드 → Pages 배포 |

## 대시보드에 공개되는 시리즈 바꾸기

`pipeline/process.py` 상단의 패널 정의를 수정하면 됩니다:

- `OVERVIEW_CARDS` — 개요 KPI 카드
- `CURVES` — 국채 커브 (국가/테너)
- `IRS_TENORS`, `IRS_COUNTRIES` — IRS 포워드 구조
- `KR_CREDIT_3Y` — 국내 크레딧 스프레드
- `MACRO_DEFS` — 매크로 지표

시리즈 키는 `bb:<Notation>`(data_bb), `info:<Notation>`(data_info), `idx:<지수명>` 형식이며,
전체 목록은 대시보드의 **카탈로그** 섹션에서 검색할 수 있습니다.

## 로컬 실행

```bash
pip install -r pipeline/requirements.txt
python pipeline/process.py --data-dir <data 저장소 경로> --out _site/data
cp -r dashboard/. _site/
cd _site && python -m http.server 8000   # http://localhost:8000
```
