# -*- coding: utf-8 -*-
"""USD hedge-premium path implied by the Korea–US forward rate differential.

Method (an outside research approach applied to the series this dashboard
already parses): a hedge premium is, to first order, the rate differential plus
a basis. The differential the two yield curves price for a future period is
their forward rate over that period; the basis is not forecast and is held at
today's observed gap. The result is a market-implied path, not a forecast with
demonstrated skill -- the published backtest compares it with "no change".

Government par yields at 1/2/3/5/10 years stand in for zero rates (annual
compounding). Only dates on which every input is actually observed are used;
nothing is interpolated, filled or carried forward.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common
import hedge_cip

SCHEMA = "hedge_forward_v1"
NODES = (
    (1, "info:한국_1y", "info:UST1y"),
    (2, "info:한국_2y", "info:UST2y"),
    (3, "info:한국_3y", "info:UST3y"),
    (5, "info:한국_5y", "info:UST5y"),
    (10, "info:한국_10y", "info:UST10y"),
)
SEGMENTS = tuple((a, b) for a, b in zip((0,) + tuple(n for n, _, _ in NODES), (n for n, _, _ in NODES)))
BACKTEST = ((12, (1, 2)), (24, (2, 3)))      # horizon months -> segment whose forward is the forecast
MIN_BACKTEST = 24
DIRECTION_EPS = 1e-9                            # pct points
ANCHOR_YEARS = 1                                # the basis is measured against the 1Y differential


def skeleton(reason: str = "입력 계열 없음") -> dict:
    return {
        "schema": SCHEMA, "active": False, "reason": reason, "currency": "USD", "asof": None,
        "method": {
            "name": "forward_rate_differential_plus_constant_basis",
            "curve": "government_par_yields_used_as_zero_rates_annual_compounding",
            "nodes_years": [n for n, _, _ in NODES],
            "segments_years": [list(s) for s in SEGMENTS],
            "sources": {"kr": [k for _, k, _ in NODES], "us": [u for _, _, u in NODES],
                        "premium": dict(hedge_cip.PREMIUM_SOURCES)},
            "differential": "korea_minus_us_pct_points",
            "premium_sign": "positive_received", "unit": "pct_pa",
            "basis": "current_premium_minus_current_1y_differential_held_constant",
            "date_policy": "all_inputs_observed_on_same_date_no_fill",
            "history_frequency": "weekly_last_actual_common_observation",
            "backtest": {"sampling": "last_common_observation_of_each_completed_calendar_month",
                         "target": "realized_1y_differential_h_months_later_by_calendar_month_key",
                         "benchmark": "no_change_in_1y_differential", "min_n": MIN_BACKTEST,
                         "overlapping_horizons": True, "vintage": "current_dataset_not_point_in_time"},
            "forecast_skill_claimed": False,
        },
        "current": None, "segments": [], "history": {"t": [], "segments": []}, "backtest": [],
    }


def forward_rate(short_pct, long_pct, a: float, b: float):
    """Annualised forward rate (pct) between year ``a`` and year ``b`` from two zero rates."""
    if a == 0:
        return long_pct
    grow_b, grow_a = (1.0 + long_pct / 100.0) ** b, (1.0 + short_pct / 100.0) ** a
    return ((grow_b / grow_a) ** (1.0 / (b - a)) - 1.0) * 100.0


def _yields(series: dict):
    cols, missing = {}, []
    for years, kr_key, us_key in NODES:
        for side, key in (("kr", kr_key), ("us", us_key)):
            values = hedge_cip._daily_observations(series.get(key))
            if values.empty:
                missing.append(key)
            cols[(side, years)] = values
    if missing:
        return None, missing
    frame = pd.concat(cols, axis=1, join="inner").dropna()
    # (1 + y) must stay positive for the compounding identity.
    frame = frame[(frame > -100.0).all(axis=1)]
    return frame, []


def _forwards(frame: pd.DataFrame) -> pd.DataFrame:
    out = {}
    for a, b in SEGMENTS:
        for side in ("kr", "us"):
            short = frame[(side, a)] if a else None
            out[(side, a, b)] = forward_rate(short, frame[(side, b)], a, b)
    forwards = pd.DataFrame(out)
    for a, b in SEGMENTS:
        forwards[("diff", a, b)] = forwards[("kr", a, b)] - forwards[("us", a, b)]
    return forwards


def _month_end(values: pd.DataFrame) -> pd.DataFrame:
    """Last actual observation of every calendar month before the latest one."""
    months = values.index.to_period("M")
    last = values.groupby(months).tail(1)
    last.index = last.index.to_period("M")
    return last[last.index < months[-1]]


def _backtest(forwards: pd.DataFrame) -> list:
    monthly = _month_end(forwards)
    spread = monthly[("diff", 0, ANCHOR_YEARS)]
    rows = []
    for horizon, (a, b) in BACKTEST:
        row = {"horizon_months": horizon, "segment_years": [a, b], "active": False, "reason": None,
               "n": 0, "first_origin": None, "last_origin": None, "rmse": None, "rw_rmse": None,
               "theil_u": None, "bias": None, "hit_rate": None, "hit_n": 0}
        forecast = monthly[("diff", a, b)]
        realized = spread.copy()
        realized.index = realized.index - horizon          # realized value keyed by its origin month
        table = pd.concat({"f": forecast, "now": spread, "real": realized}, axis=1, join="inner").dropna()
        row["n"] = int(len(table))
        if len(table) < MIN_BACKTEST:
            row["reason"] = f"실현된 평가 표본 {len(table)}개 — 최소 {MIN_BACKTEST}개 필요"
            rows.append(row)
            continue
        err, rw = table["f"] - table["real"], table["now"] - table["real"]
        rmse, rw_rmse = float(np.sqrt(np.mean(np.square(err)))), float(np.sqrt(np.mean(np.square(rw))))
        # A direction exists only beyond rounding noise of the compounding arithmetic.
        direction = lambda change: np.sign(change.where(change.abs() > DIRECTION_EPS, 0.0))
        called, moved = direction(table["f"] - table["now"]), direction(table["real"] - table["now"])
        judged = (called != 0) & (moved != 0)
        row.update(active=True, first_origin=str(table.index[0]), last_origin=str(table.index[-1]),
                   rmse=rmse, rw_rmse=rw_rmse, theil_u=(rmse / rw_rmse if rw_rmse > 0 else None),
                   bias=float(err.mean()), hit_n=int(judged.sum()),
                   hit_rate=(float((called[judged] == moved[judged]).mean()) if judged.any() else None))
        rows.append(row)
    return rows


def build(series: dict) -> dict:
    """Implied premium path today, its weekly history and the forward's track record."""
    out = skeleton()
    frame, missing = _yields(series)
    if missing:
        out["reason"] = "유효 원천 관측 없음: " + " / ".join(missing)
        return out
    if frame.empty:
        out["reason"] = "한미 1·2·3·5·10년 금리의 동일 날짜 공통 관측 없음"
        return out
    forwards = _forwards(frame)
    if not np.isfinite(forwards.to_numpy(dtype=float)).all():
        out["reason"] = "포워드 금리 계산 결과가 유한하지 않음"
        return out
    weekly = forwards.groupby(forwards.index.to_period("W-FRI")).tail(1)
    out["history"] = {"t": common.epoch_seconds(weekly.index),
                      "segments": [{"years": [a, b], "diff": weekly[("diff", a, b)].tolist()}
                                   for a, b in SEGMENTS]}
    out["backtest"] = _backtest(forwards)
    premium = hedge_cip.premium_history(series)
    joined = forwards.copy()
    joined[("premium", 0, 0)] = premium.reindex(joined.index)
    joined = joined.dropna()
    if joined.empty:
        out["reason"] = "금리 곡선과 HP 3M·6M·12M의 동일 날짜 공통 관측 없음"
        return out
    latest = joined.iloc[-1]
    spread = float(latest[("diff", 0, ANCHOR_YEARS)])
    carry = float(latest[("premium", 0, 0)])
    gap = carry - spread
    out["asof"] = joined.index[-1].strftime("%Y-%m-%d")
    out["current"] = {"premium": carry, "spread_1y": spread, "gap": gap, "gap_bp": gap * 100.0,
                      "t": common.epoch_seconds(joined.index[-1:])[0]}
    for a, b in SEGMENTS:
        diff = float(latest[("diff", a, b)])
        out["segments"].append({
            "years": [a, b], "kr": float(latest[("kr", a, b)]), "us": float(latest[("us", a, b)]),
            "diff": diff, "implied_premium": diff + gap,
            "change_vs_now": diff - spread,
        })
    if not all(math.isfinite(v) for seg in out["segments"] for k, v in seg.items() if k != "years"):
        return skeleton("내재 프리미엄 계산 결과가 유한하지 않음")
    out.update(active=True, reason=None)
    return out
