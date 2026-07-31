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
