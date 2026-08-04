# -*- coding: utf-8 -*-
"""파이프라인 공용 헬퍼 — process/risk/hedge/research 가 함께 쓰는 산식 한 벌.

이 파일이 생기기 전에는 `epoch_seconds` 가 3벌(process·risk·hedge),
`spearman`/`auc` 가 2벌(risk·research/wf_validation) 복제돼 있었다. 복제본은
조용히 갈라진다 — 특히 연구 하네스(wf_validation)와 배포 코드(risk)가 갈라지면
"검증된 방법론"과 "실제 게시되는 점수"가 다른 것을 계산하게 된다.

임포트 규약: `pipeline/` 에 `__init__.py` 가 없고 `process.py` 는 스크립트
경로(`python pipeline/process.py`)로만 실행된다. 따라서 이 모듈도 평면 임포트
(`import common`)로만 쓴다. 패키지 임포트(`from pipeline import common`)를
도입하지 말 것 — `python -m pipeline.process` 는 원래 실패하는 실행 경로다.
"""

from __future__ import annotations

import pandas as pd

__all__ = ["epoch_seconds", "pack_values", "spearman", "auc"]

_EPOCH = pd.Timestamp("1970-01-01")


def epoch_seconds(index: pd.DatetimeIndex) -> list[int]:
    """DatetimeIndex -> [unix 초].

    산술로 계산한다: pandas 버전별 내부 해상도(ns/us) 차이에 영향받지 않는다.
    (`.astype("int64") // 10**9` 는 해상도가 바뀌면 값이 달라진다.)
    """
    delta = index - _EPOCH
    return [int(x) for x in (delta // pd.Timedelta(seconds=1))]


def pack_values(s: pd.Series, round_to: int) -> dict:
    """dropna 된 시리즈 -> 대시보드 시계열 페이로드 {"t": [...], "v": [...]}."""
    s = s.dropna()
    return {"t": epoch_seconds(s.index),
            "v": [round(float(v), round_to) for v in s.values]}


def spearman(a, b) -> float:
    """순위상관. 공통 관측이 10개 미만이면 nan."""
    j = pd.concat([a, b], axis=1).dropna()
    if len(j) < 10:
        return float("nan")
    return float(j.iloc[:, 0].rank().corr(j.iloc[:, 1].rank()))


def auc(score, flag) -> float:
    """이진 판별 AUC (Mann–Whitney U 통계량 정규화). 한쪽 클래스가 비면 nan."""
    j = pd.concat([score, flag], axis=1).dropna()
    s, f = j.iloc[:, 0], j.iloc[:, 1].astype(bool)
    pos, neg = int(f.sum()), int((~f).sum())
    if pos == 0 or neg == 0:
        return float("nan")
    r = s.rank()
    return float((r[f].sum() - pos * (pos + 1) / 2) / (pos * neg))


# ---------------------------------------------------------------------------
# 인포맥스 HP(헤지 포인트) 커브 읽기 — hedge.py 와 alloc.py 의 **유일한** 경로
# ---------------------------------------------------------------------------
#: 최근 N영업일 중앙값. **임의 상수가 아니다** — 두 독립 유도가 같은 수를 준다.
#:
#: ① 잡음 구조에서: 이 계열의 일간 변화 Δ 는 1차 자기상관이 **12계열 전부 음수**다
#:    (실측 −0.15 ~ −0.63. 순수 1일 측정잡음 MA(1) 의 이론 하한이 −0.5). 즉 호가는
#:    "튀었다 되돌아오는" 톱니이지 추세가 아니다. AR(2)≈0 이므로 잡음 기억은 1일이고,
#:    그 2배 이상을 덮는 **최소 홀수창이 5**다. 지연은 (N−1)/2 = 2영업일.
#: ② 게시 안정성에서: 최신 호가를 그대로 쓰면 **한 번의 빌드로 게시값이 최대 5.50%p**
#:    움직인다(EUR 3M 실측. USD 3M 1.75%p). N=5 면 최대 0.16 / 0.53%p 로 내려간다.
#:    N=20 은 더 안정적이지만 9.5영업일 지연이라 "최신 호가"라는 화면 성격과 충돌한다.
#:
#: **N=1 로 두면 예전의 최신 호가 방식과 정확히 같아진다** — 되돌리기는 이 한 글자다.
HP_MEDIAN_N = 5

HP_TENORS = ("3M", "6M", "12M")


def hp_curve(series: dict, cur: str, n: int = HP_MEDIAN_N) -> dict | None:
    """통화 `cur` 의 HP 커브(3/6/12M)를 최근 n영업일 중앙값으로 읽는다.

    `hedge.py` 와 `alloc.py` 가 **둘 다 이것만** 부른다. 예전에는 두 모듈이 같은
    시리즈를 각자 읽었고(둘 다 `iloc[-1]`), 우연히 같은 값이 나와 문제가 안 보였다.
    한쪽만 읽는 법을 바꾸면 **같은 화면의 두 숫자가 조용히 갈라진다** — 그래서
    읽는 자리를 하나로 합치는 것이 중앙값 도입의 선행 조건이었다.

    돌려주는 것: `{"curve": {"3M":…, "6M":…, "12M":…}, "asof": Timestamp,
    "window": n, "n_used": 실제로 쓴 관측 수}`. 세 만기 중 하나라도 없으면 None.
    """
    key = "USDKRW" if cur == "USD" else f"{cur}KRW"
    curve, last, used = {}, None, None
    for m in HP_TENORS:
        s = series.get(f"info:{key}_HP_{m}")
        if s is None:
            return None
        s = s.dropna()
        if not len(s):
            return None
        w = s.iloc[-max(1, n):]
        curve[m] = round(float(w.median()), 2)
        last = s.index[-1] if last is None else max(last, s.index[-1])
        used = len(w) if used is None else min(used, len(w))
    return {"curve": curve, "asof": last, "window": max(1, n), "n_used": used}


def hp_read_label(n: int = HP_MEDIAN_N) -> str:
    """화면·`src` 문자열이 공유하는 읽기 방식 이름. 한 곳에서만 정한다."""
    return "최신 호가" if n <= 1 else f"최근 {n}영업일 중앙값"
