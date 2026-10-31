# USDKRW 환율모형B — LSTM·XGBoost walk-forward (퀀트팀 모형 이식)

## 범위와 경계

퀀트팀이 전달한 `fx_predict.py`·`fx.ipynb` 의 원/달러 **수준** 예측 모형을 환율전망 › 환율모형B 에
싣는다. 모형A 는 2026-10-16 부터 3국면 마코브 전환이 차지하고 있어 **빈 슬롯인 B** 에 연결했다
(탭 이름은 화면에서 편집할 수 있다 — `iaw-fx-outlook-workspaces-v1`).

세 층으로 나뉜다.

| 층 | 파일 | 실행 위치 |
|---|---|---|
| 러너 | `pipeline/research/fx_lstm_xgb_runner.py` | **오프라인**(CI 미실행). torch·xgboost·statsmodels·scikit-learn 필요 — `pipeline/research/requirements-fx-lstm-xgb.txt`. 파이프라인 고정 의존성 3개와 섞지 말 것 |
| 로더 | `pipeline/fx_lstm_xgb.py` | 파이프라인. `fx_lstm_xgb.json` 을 Data 저장소 재귀 탐색으로 찾아 스키마 검증 후 `fx.json.lstm_xgb` 로 게시. 표준 라이브러리만 |
| 화면 | `dashboard/fx-lstm-xgb.js` | 브라우저. 랜덤워크 대조·오차·지표·국면 분해를 게시된 행에서 계산 |

모형은 브라우저에서도 CI 에서도 다시 추정하지 않는다. JSON 15개 계약은 그대로다(`fx.json` 안의 블록).

### 게시 경계 (공개 저장소)

러너 입력 CSV 3개(블룸버그 월말 테이블, ECOS 국제수지 2종)는 비공개 Data 저장소 `models/fx_lstm_xgb/`
에만 둔다. 산출물 JSON 에 실리는 것은 **기준일·예측시점·기준 환율·실제 환율·모형 예측치·요약
지표·모형 설정 메타**뿐이다. 국제수지·금리 피처값은 러너가 싣지 않고, 로더는 알려진 키만 통과시키며
(`MODEL_META_KEYS`·`RUNNER_KEYS`·`SUMMARY_KEYS`), `tests/test_fx_lstm_xgb_ui.py` 가 화면 코드에
피처 필드명이 없음을 검사한다. 원/달러 수준 자체는 이미 `fx.json.ts`·`outlook` 으로 게시되는 값이다.

## 입력과 피처 (원 코드 그대로)

- `table.csv`(월말): date, dollar_index, spot, future, usa_3m/1y/3y/10y, kr_3m/1y/3y/10y
  (sofr·30y 열은 있어도 쓰지 않는다). 마지막 행은 원 코드와 같이 버린다(`--keep-last-row` 로 유지).
- `국제수지_1.csv`: 경상수지·증권투자(자산) 등, `국제수지_2.csv`: 투자소득수익·직접투자소득수익·
  증권투자소득수익 등. '변환' 열의 월 표기(01-Jan / Jan-01 / 2001-01 …)를 해석해 **월 기준으로
  조인**한다 — 원 코드는 행 위치로 붙였다.
- 피처 10개: spot · 경상수지 · 증권투자(자산) · 직접투자비율(수익) = 직접투자소득수익/투자소득수익 ·
  증권투자비율(수익) = 증권투자소득수익/투자소득수익 · Nelson–Siegel level/slope/curvature
  (λ=0.7308, 만기 0.25/1/3/10년의 미국−한국 금리 스프레드에 최소제곱) · AR(1)·MA(1)
  (ARIMA(1,1,1) 36개월 롤링 계수).
- 타깃: `lag` 개월 뒤 원/달러 수준.

## 학습·평가 설계

기준일 t 마다 직전 `window` 개월을 학습창으로 삼아 XGBoost(기본 파라미터)와 LSTM(hidden 32·1층·
seq 6·100 epoch·Adam 1e-3·StandardScaler·전체배치)을 **다시 학습**하고 t 의 피처로 t+lag 수준을
예측한다. 앙상블은 두 예측의 단순평균. 기본 그리드 `--lags 1,3,6,9,12 × --windows 24,36` 열 조합을 한
JSON 에 싣는다 — 화면의 「파라미터 변경」은 이 격자에서 고르는 것이고 브라우저 재학습은 없다.
기존 산출물에 9·12개월이 없으면 해당 전망은 재실행한 산출물을 게시한 뒤 제공되며, 짧은 지평을 외삽하지 않는다.
기존 6조합 실행 비용(실측, 4코어 CPU): 100 epoch 기준 스텝당 약 1.5초 → 300개월 자료 × 6조합 약 40분. 확장한 10조합의 실행시간은 별도 측정하지 않았다.
`--epochs 5 --max-steps 10` 스모크는 몇 초다.

### 원 코드 대비 바뀐 점 — 전부 플래그로 되돌릴 수 있다

| 항목 | 원 코드 | 러너 기본 | 복원 플래그 |
|---|---|---|---|
| 학습 라벨 정렬 | 행 t−1 까지의 타깃(= t+lag−1 시점 환율)을 학습 → look-ahead | 기준일에 **실현된** 타깃(행 ≤ t−lag)만 학습 | `--replicate-notebook` |
| 국제수지 공표 지연 | 0 | 2개월 뒤로 밀기 | `--bop-lag 0` |
| NS 요인 결측 | 양방향 선형보간(미래값 사용) | 앞채움 | `--ns-fill interpolate` |
| 국제수지 조인 | 행 위치 | 월(YYYY-MM) 키 | 없음 — 위치 조인은 열 길이가 다르면 조용히 틀린다 |
| 난수 | 미고정 | `--seed 20261019`(torch 스텝별 `seed+t`, XGB `random_state`, `n_jobs=1`) | `--seed` |

산식(NS·ARIMA·피처·하이퍼파라미터·앙상블)은 바꾸지 않았다. 러너는 `label_alignment` 와
`replicate_notebook` 을 JSON 에 적고 화면이 그대로 표시한다 — 어느 설정의 결과인지 숨기지 않는다.

## 산출물 스키마 `fx_lstm_xgb/1`

```
{schema, generated_at, runner{version, seed, replicate_notebook, label_alignment},
 model{name, target, unit, frequency, features[], ns{lambda, maturities_years, fill}, arma{order, window_months},
       bop_lag_months, lstm{hidden_size, num_layers, seq_len, epochs, lr}, xgb, ensemble, benchmark},
 data{table, bop, join, feature_start, feature_end, n_feature_rows},
 grid{lags[], windows[]}, regime_defaults{low_below, high_above},
 combos[{key, lag, window, n, n_realized, t_base[], t_target[], base[], actual[],
         pred{xgb[], lstm[], ensemble[]}, summary{<model>: {n, rmse, mae, bias, theil_u, hit_rate, n_direction}}}]}
```

- 시각은 epoch 초(`t_base` 오름차순). `actual` 은 아직 실현되지 않은 마지막 `lag` 행이 `null` 이며
  실현 행 뒤에 다시 실현 행이 올 수 없다.
- 로더 검증: schema · grid 와 combos 의 lag/window 일치 · 배열 길이 · 오름차순 · 유한 양수 · pred 세
  모형 존재 · `generated_at` 날짜. 하나라도 어긋나면 **사유와 함께 `active:false`** 로 게시한다(다른
  모형 대체 없음). 파일이 여러 개면 정렬 첫 번째를 쓰고 경고한다.
- 게이트: `REQUIRED_KEYS["fx"]` 의 `lstm_xgb` 와 `REQUIRED_NESTED_KEYS[("fx","lstm_xgb")]`. 파일이 없어도
  블록은 항상 있다(체인 안전장치).

## 화면 (`renderFxLstmXgb`)

- 조작: lag·window 콤보(산출물의 그리드만) · 모형(앙상블/XGBoost/LSTM) · 기간(1Y/3Y/5Y/전체) · 국면 경계
  두 값(기본은 노트북의 1100/1300 — 사용자 입력은 `iaw-fx-lstm-xgb-v1` 에 브라우저만 저장. 저장된
  조합이 새 산출물에 없으면 기본 조합으로 물러나며 그 사실을 적는다).
- 랜덤워크 = 기준일 환율 유지. 오차 = 예측 − 실제. 지표: N·RMSE·MAE·편향·Theil U(= RMSE ÷ 랜덤워크
  RMSE)·방향 적중률(기준 환율 대비 부호 일치, 랜덤워크는 방향이 없어 —). 국면은 **기준일 환율
  수준**으로 나눈다(저환율 < 하한 ≤ 중립 ≤ 상한 < 고환율).
- 차트 둘(실제·예측·랜덤워크 / 오차), 표·CSV 는 선택 조합의 전 행(미실현 행 포함). 환율 표시는 정수,
  CSV 는 원 정밀도.
- 참고 표시 전용 — 등급·경보·자산배분·컨센서스 입력에 연결되지 않는다.

## 검증

- `tests/test_fx_lstm_xgb.py`: 월 표기 해석, NS 최소제곱 독립 대조, 국제수지 지연 정렬, walk-forward
  라벨 정렬(정직 모드는 학습 라벨 행 ≤ 기준일, 복제 모드는 원 노트북과 같은 t+lag−1), 요약 지표
  손계산, 로더 스키마·오류·중복 처리, 러너→로더 왕복.
- `tests/test_fx_lstm_xgb_ui.py` + `tests/fx_lstm_xgb_ui_probe.js`: 지표 오라클 대조, 국면 경계 검증·저장,
  조합/모형/기간 전환, CSV/표, 호버, 재렌더 정리, 탭 리사이즈·이름 편집·컨센서스 보존, 깨진 산출물
  9종이 차트를 그리지 않음.
- 합성 CSV 로 러너 완주(스모크·48스텝 격자)와 NS 요인의 원 노트북 행 일치를 확인했고, 그 산출물을 임시
  데이터 디렉터리에 넣어 파이프라인·게이트를 통과시킨 뒤 실브라우저(Chromium)에서 패널 렌더를 캡처했다.
  실데이터 파이프라인(503계열·13경고·JSON 15개)은 산출물 부재 상태에서 비활성 블록을 게시하고 게이트를 통과한다. **실제 CSV 는 아직 받지
  못해 실성과 수치는 없다** — Data 저장소에 CSV 3개를 올리고 러너를 돌려 JSON 을 커밋하면 화면이
  켜진다(Data `CLAUDE.md` 「환율모형B 입력·산출물」).

## 한계

- 표본 외 우월성은 화면 지표로만 판단한다. 24~36개월 창의 LSTM 은 표본이 매우 작고 결과가 시드에
  민감할 수 있다(시드 고정은 재현성이지 안정성이 아니다). 원 자료 어디에도 표본 외 성과 수치가
  없었다.
- 국면 경계(1100/1300)는 노트북의 고정값이며 추정값이 아니다 — 사용자가 바꾸면 분해만 바뀐다.
- 국제수지 공표 지연 2개월은 ECOS 월별 공표 관행에 맞춘 근사다. 실제 공표일 달력은 쓰지 않는다.
- 산출물은 러너를 돌린 시점의 스냅숏이다. 새 월이 쌓이면 러너를 다시 돌려 커밋해야 한다(자동 갱신
  없음). 평가 자료로 창·lag·시드를 다시 고르면 표본 외 평가가 아니다.
