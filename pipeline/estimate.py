# -*- coding: utf-8 -*-
"""수익률 추정 화면(§7.8)의 데이터층 — `estimate.json`.

**이 모듈은 수익률을 계산하지 않는다.** 계산(연환산·기여도·포트폴리오 합산)은 전부
사용자 입력에 의존하므로 브라우저가 한다(`dashboard/app.js` 의 `estEngine`).
여기서 하는 일은 하나뿐이다 — **기준일 수익률 자동 채움에 쓸 지수를 싣는 것**.

자동 채움이 왜 파이프라인 일인가: 화면이 임의 기준일의 연초이후 수익률을 내려면
`지수(기준일) / 지수(전년 12/31) − 1` 이 필요하고, 그러려면 일별 수준값과 **정확한
연말 앵커**가 있어야 한다. 앵커를 축약된 계열에서 뽑으면 분모가 조용히 어긋나
모든 YTD 가 함께 틀린다 — 그래서 연말값은 **축약 전 원본**에서 따로 뽑아 싣는다.

## 게시하지 않는 것 — 그리고 그 이유를 함께 싣는 이유

사용자 요청은 「국내주식=KOSPI TR · 해외주식=ACWI TR · 해외채권=미국채」였다.
셋 중 **하나만 요청과 정확히 일치한다**:

| 요청 | 보유 시리즈 | 판정 |
|---|---|---|
| KOSPI TR | `bb:한국_KOSPI_TR` (TOT_RETURN_INDEX_GROSS_DVDS) | 일치 |
| ACWI **TR** | `idx:ACWI` — **가격지수(PR)** | 배당 미포함 |
| 미국채 수익률 | `info:UST*` · `bb:미국_국채_10년_일드` — **전부 금리(yield)** | 수익률 산출 불가 |

ACWI 가 PR 이라는 것은 이 저장소가 이미 판정해 둔 사실이다(`alloc.py` 의
`SRC_DESC["acwi"]` = "달러표시·현재 PR"). PR 로 TR 칸을 채우면 **배당수익률만큼
계통적으로 낮은 값**이 보고 숫자로 들어간다 — 그래서 채우되 `basis_matches_request`
를 false 로 실어 화면이 경고를 달게 한다(조용한 대체 금지).

미국채는 **근사조차 하지 않는다.** 금리와 듀레이션으로 `−D·Δy` 근사를 만들 수는
있지만, 그것은 실현 수익률이 아니라 우리가 지어낸 추정치다. 실제 운용성과 칸에
지어낸 수를 자동으로 넣는 것은 「자의성 금지」 정면 위반이다. 대신 부재와 사유를
`unavailable` 로 실어 화면이 「왜 이 칸만 수기인가」에 답하게 한다.
"""

from __future__ import annotations

import pandas as pd

from common import epoch_seconds

# 자동 채움 대상 — `asset` 이 `app.js` 의 `EST_ASSETS` 이름과 **문자 단위로** 같아야
# 화면이 행을 찾는다(회귀 테스트가 두 파일을 대조한다).
INDICES = [
    {
        "key": "kospi_tr",
        "asset": "국내주식",
        "label": "KOSPI TR",
        "src": "bb:한국_KOSPI_TR",
        "basis": "총수익 지수(배당 포함)",
        "basis_matches_request": True,
        "caveat": "",
    },
    {
        "key": "acwi",
        "asset": "해외주식",
        "label": "MSCI ACWI",
        "src": "idx:ACWI",
        # `alloc.py` SRC_DESC 가 이미 "달러표시·현재 PR" 로 판정해 둔 계열이다.
        "basis": "가격지수(배당 미포함, PR)",
        "basis_matches_request": False,
        "caveat": ("요청하신 ACWI **TR** 이 아니라 가격지수(PR)입니다 — "
                   "배당수익률만큼 낮게 나옵니다. TR 익스포트가 들어오면 자동으로 바뀝니다."),
    },
]

# 자동 채움을 **하지 않는** 자리와 그 사유. 화면이 그대로 적는다.
UNAVAILABLE = [
    {
        "assets": ["시가 해외채권 직접", "시가 해외채권 간접", "장부가 해외채권"],
        "want": "미국채 총수익 지수",
        "reason": ("보유한 미국채 시리즈는 전부 금리(yield)입니다 — 금리만으로는 "
                   "기간 수익률을 만들 수 없습니다. 듀레이션으로 −D·Δy 근사를 만들 수는 "
                   "있으나 그것은 실현 성과가 아니라 추정치라 자동으로 채우지 않습니다."),
        "have_kind": "금리(yield)",
    },
]

# ── 추정일 시나리오 축(§7.10, 2026-08-13 사용자 지시) ─────────────────────────
# "추정일자의 시장데이터가 data 레포지토리에 있으면 그거 쓰고, 아니면(미래) 수기 입력".
# 여기서는 **축이 될 시리즈만** 싣는다 — 기준일→추정일 변화량 계산과 시나리오 적용은
# 브라우저(`estScenario`)가 한다(계산이 전부 사용자 입력에 달려 있기 때문).
#
# `kind` 가 변화량의 뜻을 정한다:
#   rate  → Δ = v(추정일) − v(기준일)  (금리·스왑레이트. 화면 단위는 bp)
#   price → Δ = v(추정일)/v(기준일) − 1 (지수·환율. 화면 단위는 %)
# 이 구분을 화면이 스스로 정하게 두면 금리를 비율로 나누는 사고가 조용히 난다.
#
# `index` 가 있는 축은 **`indices` 의 그 항목을 그대로 쓴다**(중복 게시 방지) —
# KOSPI TR·ACWI 는 이미 연말 앵커까지 실려 있어 두 번 실을 이유가 없다.
# `level_unit`/`level_dp` 는 **수준 표시**용이다(§7.12 — 사용자가 변화량 대신 추정일
# **수준**을 친다: "국고 10년이 3.50% 가 될 것"). 화면이 단위를 스스로 정하게 두면
# 달러원을 % 로, 금리를 원으로 적는 사고가 난다.
SCENARIO_AXES = [
    {"key": "kr_rate", "label": "국고 10년", "src": "info:한국_10y",
     "kind": "rate", "unit": "bp", "level_unit": "%", "level_dp": 2,
     "note": "시가 국내채권(직접·간접)의 Δy 자동 채움에 씁니다"},
    {"key": "us_rate", "label": "미국채 10년", "src": "info:UST10y",
     "kind": "rate", "unit": "bp", "level_unit": "%", "level_dp": 2,
     "note": "시가 해외채권(직접·간접)의 Δy 자동 채움에 씁니다"},
    {"key": "usdkrw", "label": "달러/원", "src": "bb:달러원",
     "kind": "price", "unit": "%", "level_unit": "원", "level_dp": 1,
     "note": "해외자산의 미헤지분 환효과에 씁니다"},
    {"key": "swap", "label": "스왑레이트 3개월", "src": "info:SMB_USDKRW_3M",
     "kind": "rate", "unit": "bp", "level_unit": "%", "level_dp": 2,
     "note": "헤지분의 스왑 MTM(회계모형 ⑤)에 씁니다"},
    {"key": "kospi", "label": "KOSPI TR", "index": "kospi_tr",
     "kind": "price", "unit": "%", "level_unit": "", "level_dp": 1,
     "note": "국내주식의 주가 변화"},
    {"key": "acwi", "label": "MSCI ACWI", "index": "acwi",
     "kind": "price", "unit": "%", "level_unit": "", "level_dp": 1,
     "note": "해외주식의 주가 변화"},
]

# ── 추정일 수익률을 자산군마다 어떻게 내는가 (§7.12, 2026-08-13 사용자 지시) ──────
#
# 사용자가 자산군을 **하나하나 지정했다.** 「계산해 주는 것」과 「기준일과 같게 두고
# 필요하면 수기」를 가르는 선은 **가격 축이 있느냐**이고, 그 판정은 우리가 아니라
# 사용자가 내린 것이다 — 임의로 옮기지 말 것.
#
#   calc  : 화면이 시장 축으로 계산한다(수기 덮어쓰기 불가 — 산식이 정본)
#   carry : 기준일 수익률을 그대로 승계하고, **필요하면 사용자가 수기로 덮는다**
#
# 실행 매핑은 `app.js` 의 `EST_SCEN`/`EST_MODE` 이고 여기 표는 **화면이 적는 설명이자
# 계약**이다. 둘이 갈리면 `tests/test_estimate.py` 가 잡는다(이름 대조).
ROW_MODES = [
    {"asset": "장부가 국내채권", "mode": "carry",
     "why": "원가법이라 가격효과가 없습니다 — 기준일 수익률을 그대로 씁니다(수기 덮어쓰기 가능)"},
    {"asset": "장부가 해외채권", "mode": "calc",
     "why": "원가법이라 가격효과는 없지만 환헤지 스왑은 파생이라 MTM 이 납니다 — 환·스왑으로 계산합니다"},
    {"asset": "단기자금", "mode": "carry",
     "why": "가격 축이 없습니다 — 기준일 수익률을 그대로 씁니다(수기 덮어쓰기 가능)"},
    {"asset": "대출금", "mode": "carry",
     "why": "가격 축이 없습니다 — 기준일 수익률을 그대로 씁니다(수기 덮어쓰기 가능)"},
    {"asset": "국내주식", "mode": "calc",
     "why": "기준일 수익률 + KOSPI TR 상승률"},
    {"asset": "해외주식", "mode": "calc",
     "why": "기준일 수익률 + ACWI 상승률 + 미헤지분 환효과"},
    {"asset": "시가 국내채권 직접", "mode": "calc",
     "why": "듀레이션 × 국고 10년 금리 변화(−D×Δy)"},
    {"asset": "시가 국내채권 간접", "mode": "calc",
     "why": "듀레이션 × 국고 10년 금리 변화(−D×Δy)"},
    {"asset": "시가 해외채권 직접", "mode": "calc",
     "why": "듀레이션 × 미국채 10년 금리 변화 + 환·스왑"},
    {"asset": "시가 해외채권 간접", "mode": "calc",
     "why": "듀레이션 × 미국채 10년 금리 변화 + 환·스왑"},
    {"asset": "대체투자", "mode": "carry",
     "why": "가격 축이 없습니다 — 기준일 수익률을 그대로 씁니다(수기 덮어쓰기 가능)"},
]

# 헤지비율 입력 범위(§7.12 — 2026-08-13 사용자 지시 "0~105% 범위에서 선택").
# **기본값은 두지 않는다** — 기관의 현재 헤지 정책은 운용 정보라 공개 저장소에 박지
# 않고, 사용자가 화면에서 한 번 고르면 브라우저에만 남는다(같은 날 사용자 확인).
# 105% 상한은 오버헤지(펀드 NAV 변동에 따른 일시 초과)를 담기 위한 것이다.
HEDGE_BAND = {
    "lo": 0, "hi": 105, "step": 1,
    "note": ("해외자산 자산군을 눌러 헤지비율을 고르십시오(0~105%). **기본값이 없습니다** — "
             "고르기 전에는 환효과·스왑 MTM 을 0 으로 지어내지 않고 「헤지비율 미입력」이라고 "
             "적습니다. 고른 값은 이 브라우저에만 저장됩니다."),
}

# 연환산 규약 — 2026-08-13 사용자 지시. 두 번 바뀐 자리라 경위를 남긴다.
#   1차: 화면이 입력값에 계수를 곱해 연환산했다.
#   2차(현행): **입력값이 그 자체로 연환산 수익률**이다(주식 제외) — 담당자가 기관
#              시스템에서 이미 연환산해 들고 오므로 화면이 다시 곱하면 이중 연환산이다.
# 계수(365 ÷ 경과일수)가 사라진 것은 아니다 — **추정일 시나리오에서만** 쓴다:
#   ① 기준일 연환산율 → 기간수익 되돌리기(× 경과일수 ÷ 365)
#   ② 연초→추정일 기간수익 → 추정일 기준 재연환산(× 365 ÷ 연초→추정일 일수)
# 되돌리기는 사용자 규칙의 정확한 역이지 새 가정이 아니다.
ANNUALIZE = {
    "basis": "days",
    "day_count": 365,
    "input_is_annualized": True,
    "note": ("기준일 수익률은 **이미 연환산된 값**을 넣습니다(주식 제외) — 화면이 다시 "
             "연환산하지 않습니다. **주식(국내·해외)은 연환산하지 않는 연초이후 수익률**입니다. "
             "일수 기준 계수(365 ÷ 경과일수, 연초 = 전년 12/31)는 추정일 시나리오에서만 씁니다."),
}

# 추정 산식 — **화면이 이 문장을 그대로 적는다.** 방법론을 코드 주석에만 두면 화면과
# 어긋나도 아무도 모른다(§7.7.14 에서 겪은 자리).
#
# 부호 규약 둘이 이 모형의 심장이다:
#   · 금리가 **오르면** 채권 가격은 **떨어진다** → 가격효과 = **−D × Δy** (사용자 지시에는
#     부호가 빠져 있었다 — 뒤집히면 금리 상승기에 채권이 이익 나는 것으로 나온다)
#   · 스왑레이트가 **오르면** 스왑 MTM 은 **손실** → MTM = h × τ × (**−**Δ스왑)
#     (`hedge.py` 의 회계모형 ⑤ 와 같은 부호 — 새 모형을 만들지 않고 그것을 쓴다)
SCENARIO_MODEL = {
    "formula": "추정 기간수익률 = 캐리 + 가격효과 + 환효과 + 스왑 MTM",
    "terms": [
        "캐리 = 기준일 수익률(연환산 — 입력값 그대로) × 추정 구간일수 ÷ 365 — 주식은 캐리 없음(가격이 곧 수익)",
        "가격효과 = −듀레이션 × Δ금리 (시가 채권만) · 주식은 지수 변화율 · 그 외 0",
        "환효과 = (1 − 헤지비율) × Δ환율 (해외자산만)",
        "스왑 MTM = 헤지비율 × 스왑 잔존만기 × (−Δ스왑레이트) — hedge.py 회계모형 ⑤",
    ],
    # 화면이 기준일·추정일을 **나란히** 놓으므로 두 열이 같은 기준(연환산)이어야 한다.
    # 캐리가 기준일 연환산율을 그대로 보존하기 때문에 아래 항등식이 성립하고, 그래서
    # 두 열의 차이가 곧 시장효과의 연환산분이 된다(대수적으로 정확 — 근사가 아니다).
    "cumulative": ("추정일 수익률(연환산) = 기준일 수익률(연환산) + (가격효과 + 환효과 + 스왑 MTM) "
                   "× 365 ÷ (연초→추정일 일수). 캐리가 기준일 연환산율을 그대로 보존하므로 "
                   "**두 열의 차이가 곧 시장효과의 연환산분**입니다. 주식은 양쪽 다 연환산하지 "
                   "않아 차이 = 지수 변화(+환효과)입니다."),
    # 추정일이 다음 해면 「연초 이후」의 연초 자체가 달라져 두 열을 이을 수 없다.
    # 그 구간(1/1 → 추정일)의 수익을 우리는 모르기 때문이다 — 지어내지 않고 비운다.
    "cross_year": ("추정일이 기준일과 **다른 해**면 연초 기준이 달라져 연초이후 누적을 잇지 "
                   "못합니다 — 그때는 추정 구간(기준일 → 추정일)만 냅니다."),
    "book_value": ("장부가 자산은 원가법이라 **가격효과가 0** 입니다 — 금리가 움직여도 평가손익이 "
                   "생기지 않습니다(이 저장소 실측: 장부가 BM 손익변동 σ 0.18%/0.17%). "
                   "장부가 해외채권은 환·스왑 항으로만 움직입니다."),
    # §7.12 — 추정일 규모는 **따로 넣지 않으면 기준일 규모를 승계한다**(사용자 지시).
    # 승계인지 수기인지를 화면이 밝혀야 한다: 조용히 같은 수를 보여 주면 사용자는
    # 리밸런싱을 반영한 줄 알고 넘어간다.
    "size_carry": ("추정일 규모를 비워 두면 **기준일 규모를 그대로 승계**합니다(화면이 「승계」라고 "
                   "적습니다). 리밸런싱 계획이 있으면 추정일 규모를 직접 넣으십시오 — 비중이 "
                   "바뀌면 포트폴리오 수익률의 가중치도 함께 바뀝니다."),
    # §7.12 — 자산군마다 추정일 수익률을 내는 방식이 다르다. 위 ROW_MODES 가 정본이고
    # 화면이 자산군 옆에 그 사유를 적는다.
    "row_modes": ROW_MODES,
    "hedge_band": HEDGE_BAND,
    "limits": ("1차 근사입니다 — 볼록성(convexity)은 반영하지 않으므로 Δ금리가 커질수록 오차가 "
               "커집니다(금리 하락 시 과소, 상승 시 과대 추정). 금리 시나리오는 **평행이동** 가정이며 "
               "자동 채움은 벤치마크 만기(국고 10년·미국채 10년) 변화를 씁니다 — 포트폴리오 듀레이션과 "
               "만기가 다르면 실제 곡선 변화와 어긋납니다. 신용스프레드 변화는 별도 축이 없습니다."),
}

DAILY_YEARS = 5           # 이 구간은 일별 그대로, 그 이전은 주별로 축약(`process.pack` 과 같은 정책)


def _pack(s: pd.Series, round_to: int = 4) -> dict:
    """최근 DAILY_YEARS 년은 일별, 그 이전은 주별(W-FRI). `process.pack` 과 같은 정책.

    여기 따로 둔 이유는 순환 import 회피뿐이다(`process` 가 이 모듈을 import 한다).
    """
    s = s.dropna()
    cutoff = s.index[-1] - pd.DateOffset(years=DAILY_YEARS)
    old = s[s.index < cutoff]
    if len(old):
        old = old.resample("W-FRI").last().dropna()
        old = old[old.index < cutoff]
        s = pd.concat([old, s[s.index >= cutoff]])
    return {"t": epoch_seconds(s.index),
            "v": [round(float(v), round_to) for v in s.values]}


def _year_end_levels(s: pd.Series) -> dict:
    """연도별 **마지막 관측**과 그 날짜 — YTD 의 분모 앵커.

    `_pack` 이 축약하기 **전 원본**에서 뽑는다. 축약된 계열에서 뽑으면 5년보다 오래된
    연말이 주별 라벨로 밀려 분모가 조용히 어긋나고, 그 해의 모든 YTD 가 함께 틀린다.
    값과 **실제 관측일**을 함께 싣는다 — 12/31 이 휴장이면 앵커는 12/30 이나 12/29 이고,
    화면이 어느 날을 썼는지 밝혀야 하기 때문이다.
    """
    out = {}
    for y, grp in s.dropna().groupby(s.dropna().index.year):
        if len(grp):
            out[str(int(y))] = {"v": round(float(grp.iloc[-1]), 4),
                                "d": str(grp.index[-1].date())}
    return out


def build(series_store: dict, warn) -> dict:
    """`estimate.json` — 자동 채움용 지수 + 부재 사유 + 연환산 규약.

    시리즈가 하나도 없어도 `active:false` 로 **항상 게시한다**(체인 안전장치 —
    화면은 이 블록이 없으면 자동 채움 자리를 통째로 못 그린다. `bm.build_cma` 와 같은 규약).
    """
    out = []
    for spec in INDICES:
        entry = series_store.get(spec["src"])
        if entry is None or entry.get("s") is None or len(entry["s"].dropna()) == 0:
            warn(f"estimate: 자동 채움 시리즈 없음 — {spec['src']} ({spec['asset']}) 수기 입력으로 남습니다")
            continue
        s = entry["s"].dropna()
        rec = {k: spec[k] for k in
               ("key", "asset", "label", "src", "basis", "basis_matches_request", "caveat")}
        rec.update(_pack(s))
        rec["year_end"] = _year_end_levels(s)
        rec["first"] = str(s.index[0].date())
        rec["last"] = str(s.index[-1].date())
        out.append(rec)

    # 추정일 시나리오 축 — 과거 추정일이면 실제 변화량을 조회할 수 있게 계열을 싣는다.
    # `index` 축은 위 `indices` 를 참조만 하고 값을 다시 싣지 않는다.
    have_idx = {r["key"] for r in out}
    axes = []
    for spec in SCENARIO_AXES:
        # level_unit/level_dp 를 빠뜨리면 화면 폴백이 달러원 수준 입력을 단위 없이
        # 소수 2자리로 그린다(§7.12 — "화면이 스스로 정하면 달러원을 % 로 적는다"의
        # 실측 변형). 스펙에 있는 표시 메타는 **전부** 게시한다.
        rec = {k: spec[k] for k in
               ("key", "label", "kind", "unit", "note", "level_unit", "level_dp")}
        if spec.get("index"):
            if spec["index"] not in have_idx:
                warn(f"estimate: 시나리오 축 {spec['key']} 의 지수({spec['index']})가 없어 수기 입력만 됩니다")
                continue
            rec["index"] = spec["index"]              # 값은 indices 에서 읽는다
            axes.append(rec)
            continue
        entry = series_store.get(spec["src"])
        if entry is None or entry.get("s") is None or len(entry["s"].dropna()) == 0:
            warn(f"estimate: 시나리오 축 시리즈 없음 — {spec['src']} ({spec['label']}) 수기 입력만 됩니다")
            continue
        s = entry["s"].dropna()
        rec["src"] = spec["src"]
        rec.update(_pack(s))
        rec["first"] = str(s.index[0].date())
        rec["last"] = str(s.index[-1].date())
        axes.append(rec)

    if not out:
        return {"active": False,
                "reason": "자동 채움에 쓸 지수 시리즈가 하나도 없습니다 — 전부 수기 입력입니다",
                "indices": [], "axes": axes,
                "unavailable": UNAVAILABLE, "annualize": ANNUALIZE, "scenario": SCENARIO_MODEL}

    return {
        "active": True,
        # 데이터가 가장 멀리 간 날 (참고용 — 화면 기본값으로 쓰면 안 된다)
        "asof": max(r["last"] for r in out),
        # **모든 지수가 도달한 마지막 날.** 화면 기본 기준일은 이쪽이다 —
        # max 를 기본값으로 두면 늦게 끝나는 지수 하나 때문에 다른 지수의 자동값이
        # 처음부터 묵은 채로 뜬다(실측: 기본 2026-08-06 에서 ACWI 는 2026-07-21 값,
        # 16일 묵음). 첫 화면부터 어긋난 값을 보여줄 이유가 없다.
        "asof_all": min(r["last"] for r in out),
        "indices": out,
        "axes": axes,
        "unavailable": UNAVAILABLE,
        "annualize": ANNUALIZE,
        "scenario": SCENARIO_MODEL,
    }
