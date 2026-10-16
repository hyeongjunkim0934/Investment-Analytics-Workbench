# -*- coding: utf-8 -*-
"""USD interest differentials versus the observed signed hedge premium.

This is a descriptive comparison with the first-order CIP benchmark, not an
arbitrage test: policy/government yields and an average of hedge tenors do not
constitute maturity-matched borrowing/lending and forward quotes. No coefficients
are fitted. Rates and the premium retain only exact common observation dates.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common


TENOR_SOURCES = (
    ("PR", "PR", "info:한국_기준금리", "bb:미국_기준금리"),
    ("3M", "3M", "info:한국_3m", "info:UST3m"),
    ("1Y", "1Y", "info:한국_1y", "info:UST1y"),
    ("2Y", "2Y", "info:한국_2y", "info:UST2y"),
    ("3Y", "3Y", "info:한국_3y", "info:UST3y"),
)
PREMIUM_SOURCES = {m: f"info:USDKRW_HP_{m}" for m in common.HP_TENORS}


def _daily_observations(raw: pd.Series | None) -> pd.Series:
    """Finite weekday values; preserve negative/zero rates and signed carry.

    Sorting is stable so the last valid duplicate within a date wins. An invalid
    duplicate does not erase an observed value. No interpolation or filling.
    """
    if raw is None:
        return pd.Series(dtype=float, index=pd.DatetimeIndex([]))
    dates = pd.to_datetime(raw.index, errors="coerce")
    values = pd.to_numeric(raw, errors="coerce").to_numpy(dtype=float)
    out = pd.Series(values, index=dates).sort_index(kind="stable")
    out = out[out.index.notna() & np.isfinite(out)]
    out.index = out.index.normalize()
    out = out[out.index.dayofweek < 5]
    return out[~out.index.duplicated(keep="last")]


def premium_history(series: dict) -> pd.Series:
    """Past-only daily counterpart of ``common.hp_curve`` for USD.

    Each tenor uses its latest HP_MEDIAN_N valid observations through that day,
    including the current quote, and Python round(median, 2), exactly as the
    monitoring curve. Short initial windows use all available past observations.
    Only dates with all three actual quotes survive the inner join: the last
    published curve or another tenor's date must never be carried forward.
    """
    medians = {}
    window = max(1, common.HP_MEDIAN_N)
    for tenor, key in PREMIUM_SOURCES.items():
        raw = _daily_observations(series.get(key))
        if raw.empty:
            return pd.Series(dtype=float, index=pd.DatetimeIndex([]), name="premium")
        # pandas/numpy rounding differs from Python round at decimal boundaries;
        # hp_curve is canonical, including its per-tenor two-decimal rounding.
        medians[tenor] = raw.rolling(window, min_periods=1).median().map(
            lambda value: round(float(value), 2))
    joined = pd.concat(medians, axis=1, join="inner").dropna()
    return joined.mean(axis=1).rename("premium")


def _has_variation(values: pd.Series) -> bool:
    """Exclude floating-point noise from an otherwise constant difference.

    Equal decimal rate differences can differ by a few binary rounding bits
    after subtraction. The scale-relative tolerance only governs whether a
    correlation or gap Z score is defined; published values, gaps and RMSE
    remain untouched.
    """
    scale = max(1., float(values.abs().max()))
    return float(values.max() - values.min()) > 1e-12 * scale


def build(series: dict) -> dict:
    """Return five stable modules, including explicit inactive missing-data rows.

    Rates and premium use annualized percent; spread and gap use percentage
    points. Difference = Korea minus US; gap = signed premium minus that
    difference. Current gap and RMSE are bp.
    Pearson correlation uses levels; RMSE measures distance from the 1:1 line,
    not regression residuals or out-of-sample forecasting performance.
    The gap Z score compares the latest gap with the same full sample's mean
    and sample standard deviation (ddof=1); it is not a predictive score.
    """
    premium = premium_history(series)
    window = max(1, common.HP_MEDIAN_N)
    result = {
        "currency": "USD",
        "premium_method": {
            "label": f"HP 3M·6M·12M 최근 {window}유효관측 중앙값의 단순평균",
            "window": window, "min_periods": 1,
            "tenors": list(common.HP_TENORS), "rounding_decimals": 2,
            "sign": "positive_received", "unit": "pct_pa",
            "date_policy": "all_three_raw_quotes_observed_on_same_date",
            "history": "past_only_valid_observations",
        },
        "tenors": [],
    }
    missing_hp = [key for key in PREMIUM_SOURCES.values()
                  if _daily_observations(series.get(key)).empty]
    for tenor, label, kr_key, us_key in TENOR_SOURCES:
        kr = _daily_observations(series.get(kr_key))
        us = _daily_observations(series.get(us_key))
        row = {
            "tenor": tenor, "label": label, "active": False, "reason": None,
            "sources": {"kr": kr_key, "us": us_key, "premium": PREMIUM_SOURCES.copy()},
            "t": [], "kr": [], "us": [], "spread": [], "premium": [], "gap": [],
            "sample": {"start": None, "end": None, "n": 0},
            "stats": {"correlation": None, "gap_bp": None, "gap_zscore": None,
                      "rmse_bp": None, "asof": None},
        }
        missing_rates = [key for key, values in ((kr_key, kr), (us_key, us)) if values.empty]
        missing = missing_rates + missing_hp
        if missing:
            row["reason"] = "유효 원천 관측 없음: " + " / ".join(missing)
        else:
            joined = pd.concat({"kr": kr, "us": us, "premium": premium},
                               axis=1, join="inner").dropna()
            if joined.empty:
                row["reason"] = "한미 금리·HP 3M·6M·12M의 동일 날짜 공통 관측 없음"
            else:
                spread = joined["kr"] - joined["us"]
                carry = joined["premium"]
                gap = carry - spread
                correlation = None
                if len(joined) >= 2 and _has_variation(spread) and _has_variation(carry):
                    value = float(spread.corr(carry))
                    if math.isfinite(value):
                        correlation = max(-1., min(1., value))
                gap_zscore = None
                if len(joined) >= 2 and _has_variation(gap):
                    value = float((gap.iloc[-1] - gap.mean()) / gap.std(ddof=1))
                    if math.isfinite(value):
                        gap_zscore = value
                start, end = (joined.index[i].strftime("%Y-%m-%d") for i in (0, -1))
                row.update({
                    "active": True,
                    "t": common.epoch_seconds(joined.index),
                    "kr": joined["kr"].tolist(), "us": joined["us"].tolist(),
                    "spread": spread.tolist(), "premium": carry.tolist(), "gap": gap.tolist(),
                    "sample": {"start": start, "end": end, "n": int(len(joined))},
                    "stats": {"correlation": correlation, "gap_bp": float(gap.iloc[-1] * 100),
                              "gap_zscore": gap_zscore,
                              "rmse_bp": float(np.sqrt(np.mean(np.square(gap))) * 100),
                              "asof": end},
                })
        result["tenors"].append(row)
    return result
