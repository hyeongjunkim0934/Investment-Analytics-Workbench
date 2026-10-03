# -*- coding: utf-8 -*-
"""원달러 전체 일별 이력과 무추세 로그 랜덤워크의 1년 모형 범위.

환헤지의 일별 유효 관측·공백·최소표본 규칙을 공유한다. 유효한 양수 관측은
왕복 스파이크·수준 Z 필터 없이 전부 보존하고 표시용 주간 축약도 하지 않는다.
중심은 최신 호가(조건부 중앙값)로 고정하며
과거 평균 로그수익률을 추세로 외삽하지 않는다. ±1σ 모형 범위의 실현 커버리지는
보정·검증하지 않았으며 사용자 분기 전망은 이 통계 계산과 별개다.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common
import hedge

PRIMARY_SOURCE = hedge.FX_VOL_SOURCES["USD"]
FALLBACK_SOURCE = "info:USDKRW"
HORIZON_MONTHS = 12


def build(series: dict) -> dict:
    """Raw ``{key: pd.Series}`` -> additive ``fx.json.outlook`` payload.

    bb:달러원 is the shared hedge/portfolio FX source. If it has no valid levels,
    use info:USDKRW explicitly; never splice or substitute a merely longer export.
    Short histories still publish the complete cleaned graph and latest anchor.
    """
    source = PRIMARY_SOURCE
    levels = hedge._daily_observations(series.get(source), positive=True)
    fallback_used = False
    if levels.empty:
        candidate = hedge._daily_observations(series.get(FALLBACK_SOURCE), positive=True)
        if not candidate.empty:
            source, levels, fallback_used = FALLBACK_SOURCE, candidate, True

    gaps = levels.index.to_series().diff().dt.days
    returns = np.log(levels).diff()[gaps.between(1, hedge.MAX_FX_GAP_DAYS)].dropna()
    previous = levels.index.to_series().shift(1)
    history = {"t": common.epoch_seconds(levels.index),
               "v": [float(value) for value in levels.to_numpy()]}
    sample = {"start": levels.index[0].strftime("%Y-%m-%d") if len(levels) else None,
              "end": levels.index[-1].strftime("%Y-%m-%d") if len(levels) else None,
              "return_start": (previous.loc[returns.index[0]].strftime("%Y-%m-%d")
                               if len(returns) else None),
              "return_end": returns.index[-1].strftime("%Y-%m-%d") if len(returns) else None,
              "n_levels": int(len(levels)), "n_returns": int(len(returns)),
              "n_excluded_spikes": 0,
              "excluded_long_gaps": max(0, len(levels) - 1 - len(returns)),
              "scope": "full_history", "frequency": "daily", "return_type": "log",
              "annualization": 252, "ddof": 1,
              "max_gap_days": hedge.MAX_FX_GAP_DAYS,
              "min_returns": hedge.MIN_FX_RETURNS,
              "spike_policy": "retain_all_valid_positive_observations",
              "history_downsampled": False, "vol_pct": None}
    model = {"name": "no_drift_log_random_walk", "center": "median", "drift": 0,
             "horizon_months": HORIZON_MONTHS, "sigma_multiple": 1,
             "sigma_annual": None,
             "formula": "S0 exp(±sigma_annual sqrt(month/12))",
             "horizon_scaling": "sqrt_time_uncorrelated_daily_log_shocks",
             "coverage": "uncalibrated_model_range",
             "calibrated_prediction_interval": False}
    anchor = {"t": history["t"][-1], "v": history["v"][-1]} if len(levels) else None
    out = {"active": False, "source": source, "pair": "USDKRW", "unit": "KRW/USD",
           "source_selection": {"policy": "canonical_bb_explicit_info_fallback_if_no_valid_levels",
                                "primary": PRIMARY_SOURCE, "fallback": FALLBACK_SOURCE,
                                "fallback_used": fallback_used, "spliced": False},
           "asof": sample["end"], "history": history, "anchor": anchor,
           "sample": sample, "model": model, "range": None}
    if levels.empty:
        return {**out, "reason": "유효한 원달러 환율 시리즈 없음"}
    if len(returns) < hedge.MIN_FX_RETURNS:
        return {**out, "reason": f"일간 수익률 최소 {hedge.MIN_FX_RETURNS}개 필요"}

    sigma = float(returns.std(ddof=1) * math.sqrt(252))
    if not math.isfinite(sigma) or sigma < 0:
        return {**out, "reason": "환율 변동성 계산 불가"}
    sample["vol_pct"] = round(sigma * 100, 6)
    model["sigma_annual"] = sigma
    # Offset every knot from the original date: Jan 31 -> Feb end -> Mar 31,
    # rather than repeated offsets that would accidentally keep Feb's day number.
    knots = pd.DatetimeIndex([levels.index[-1] + pd.DateOffset(months=month)
                              for month in range(HORIZON_MONTHS + 1)])
    latest = anchor["v"]
    try:
        width = [sigma * math.sqrt(month / 12) for month in range(HORIZON_MONTHS + 1)]
        lower = [latest * math.exp(-value) for value in width]
        upper = [latest * math.exp(value) for value in width]
    except OverflowError:
        return {**out, "reason": "환율 모형 범위가 유한 수치 범위를 초과함"}
    if not all(math.isfinite(value) and value > 0 for value in [*lower, *upper]):
        return {**out, "reason": "환율 모형 범위 계산 불가"}
    out["active"] = True
    out["range"] = {"t": common.epoch_seconds(knots),
                    "center": [latest] * len(knots), "lower": lower, "upper": upper}
    return out
