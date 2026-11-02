"""Aggregate monthly historical tail-loss curves for currency hedge model C.

Only loss statistics on a hedge-ratio grid leave this module. The sample uses
the parent's same-date, completed-month bond/FX shocks. Each estimation window
is demeaned separately; it is a distributional stress experiment, not an FX
return forecast or an out-of-sample strategy backtest.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

CONFIDENCE = .95
MIN_MONTHS = 120
RECENT_OBSERVATIONS = 120


def expected_shortfall(losses, confidence: float = CONFIDENCE) -> float:
    """Exact equiprobable empirical upper-tail ES, including fractional mass.

    This is the integral of empirical loss quantiles above ``confidence``.
    Averaging only losses strictly greater than VaR is incorrect when there are
    ties or when n * (1 - confidence) is not an integer. Negative ES is retained.
    """
    values = np.asarray(losses, dtype=float)
    if (values.ndim != 1 or not len(values) or not np.isfinite(values).all()
            or not math.isfinite(confidence) or not 0 <= confidence < 1):
        raise ValueError("Expected shortfall requires finite losses and 0 <= confidence < 1")
    mass = len(values) * (1 - confidence)
    nearest = round(mass)
    if nearest > 0 and abs(mass - nearest) < 1e-12:
        mass = float(nearest)
    ordered = np.sort(values)[::-1]
    whole = int(math.floor(mass))
    total = float(ordered[:whole].sum())
    fraction = mass - whole
    if fraction > 0:
        total += fraction * float(ordered[whole])
    return total / mass


def build_tail_risk(shocks: pd.DataFrame, *, yield_pct: float, carry_pct: float,
                    asof: str, interval_starts: pd.Series | None = None,
                    interval_ends: pd.Series | None = None) -> dict:
    """Publish full-history/recent120 ES95 for h = 0..100%, in loss pct/month.

    The recent window means the last 120 retained monthly *observations*, so its
    calendar span and missing-month count are explicit. No horizon scaling is
    applied: a one-month ES must not be read as annual or quarterly loss.
    """
    meta = {"version": 1, "asof": asof, "horizon_months": 1,
            "confidence": CONFIDENCE, "unit": "monthly_loss_pct", "grid_step_pct": 1,
            "method": "centered_historical_joint_shocks", "min_months": MIN_MONTHS,
            "recent_observations": RECENT_OBSERVATIONS,
            "tail_mass_rule": "fractional_equiprobable_upper_tail",
            "window_centering": "separate_bond_and_fx_sample_means_per_window",
            "robust_rule": "maximum_full_and_recent_es",
            "calibrated_prediction_interval": False, "oos_validated": False,
            "grid": []}

    def inactive(reason):
        return {**meta, "active": False, "reason": reason}

    if not isinstance(shocks, pd.DataFrame) or not {"bond", "fx"}.issubset(shocks.columns):
        return inactive("공동 월간 채권·환율 충격이 필요합니다.")
    if not isinstance(shocks.index, pd.DatetimeIndex) or shocks.index.hasnans:
        return inactive("월간 충격의 유효한 날짜가 필요합니다.")
    if not shocks.index.is_monotonic_increasing or not shocks.index.is_unique:
        return inactive("월간 충격은 중복 없이 시간순이어야 합니다.")
    if len(shocks.index.to_period("M").unique()) != len(shocks):
        return inactive("같은 월의 충격은 하나만 허용합니다.")
    try:
        values = shocks[["bond", "fx"]].to_numpy(dtype=float)
        current = np.asarray([yield_pct, carry_pct], dtype=float)
        yield_pct, carry_pct = (float(value) for value in current)
        anchor = pd.Timestamp(asof)
    except (TypeError, ValueError, OverflowError):
        return inactive("월간 충격·현재 금리·헤지 캐리·기준일을 확인하십시오.")
    if not np.isfinite(values).all() or not np.isfinite(current).all() or pd.isna(anchor):
        return inactive("월간 충격·현재 금리·헤지 캐리는 유한한 값이어야 합니다.")
    if anchor.tzinfo is not None or shocks.index.tz is not None:
        return inactive("월간 충격과 기준일은 시간대 없는 날짜여야 합니다.")
    if len(shocks) and (shocks.index >= anchor.to_period("M").to_timestamp()).any():
        return inactive("기준월과 미래 월의 충격은 사용할 수 없습니다.")
    if len(shocks) < MIN_MONTHS:
        return inactive(f"꼬리위험 추정에는 공동 월간 표본 최소 {MIN_MONTHS}개가 필요합니다.")

    windows = {"full": shocks, "recent": shocks.iloc[-RECENT_OBSERVATIONS:]}
    result = {**meta, "active": True}
    centered = {}
    for name, frame in windows.items():
        first, last = frame.index[0], frame.index[-1]
        start = (pd.Timestamp(interval_starts.loc[first]) if interval_starts is not None
                 else first.to_period("M").start_time)
        end = pd.Timestamp(interval_ends.loc[last]) if interval_ends is not None else last
        calendar_span = int(last.to_period("M").ordinal - first.to_period("M").ordinal + 1)
        result[name] = {"n_months": int(len(frame)), "start": start.strftime("%Y-%m-%d"),
                        "end": end.strftime("%Y-%m-%d"), "tail_mass": float(len(frame) * .05),
                        "calendar_span_months": calendar_span,
                        "excluded_months": calendar_span - len(frame)}
        numbers = frame[["bond", "fx"]].to_numpy(dtype=float)
        centered[name] = numbers - numbers.mean(axis=0)
        if not np.isfinite(centered[name]).all():
            return inactive("공동 충격의 중심화 계산 범위를 초과했습니다.")

    grid = []
    for hedge_pct in range(101):
        h = hedge_pct / 100
        row = {"hedge_pct": hedge_pct}
        for name, numbers in centered.items():
            monthly_return_pct = (yield_pct + h * carry_pct) / 12 + (
                numbers[:, 0] + (1 - h) * numbers[:, 1]) * 100
            if not np.isfinite(monthly_return_pct).all():
                return inactive("월간 수익률 계산 범위를 초과했습니다.")
            row[f"{name}_es_pct"] = expected_shortfall(-monthly_return_pct)
        row["robust_es_pct"] = max(row["full_es_pct"], row["recent_es_pct"])
        grid.append(row)
    if not all(math.isfinite(value) for row in grid for value in row.values()):
        return inactive("꼬리위험 계산 범위를 초과했습니다.")
    result["grid"] = grid
    return result
