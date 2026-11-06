# -*- coding: utf-8 -*-
"""data_bb reference portfolios: aggregate KRW monthly moments only.

No price levels, individual returns, or portfolio paths leave this module.
Unavailable proxies retain their slots as nulls; they are never substituted.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

ASSETS = [
    {"key": "kr_bond", "label": "국내채권", "source": "bb:한국종합", "currency": "KRW"},
    {"key": "us_bond", "label": "미국채권", "source": "bb:미국종합", "currency": "USD→KRW"},
    {"key": "kr_equity", "label": "국내주식", "source": "bb:한국_KOSPI_TR", "currency": "KRW"},
    {"key": "us_equity", "label": "미국주식", "source": "bb:미국_S&P500_TR", "currency": "USD→KRW"},
    {"key": "commodity", "label": "원자재", "source": "bb:S&P GSCI TR CME", "currency": "USD→KRW"},
]
FX_KEY = "bb:달러원"
RF_KEY = "bb:한국_크레딧_CD_AAA_3m"
WINDOW_YEARS = [1, 3, 5, 10]


def _series(store, key, positive=True):
    entry = store.get(key)
    if not isinstance(entry, dict) or not isinstance(entry.get("s"), pd.Series):
        return None, f"원천 시리즈 없음: {key}"
    s = entry["s"].copy().sort_index()
    s.index = pd.DatetimeIndex(s.index).normalize()
    s = s[~s.index.duplicated(keep="last")].dropna()
    if s.empty:
        return None, f"관측 없음: {key}"
    if not np.isfinite(s.to_numpy(dtype=float)).all() or (positive and (s <= 0).any()):
        return None, f"유한한 양수 수준 필요: {key}" if positive else f"비유한 금리: {key}"
    return s.astype(float), ""


def _day(t):
    return pd.Timestamp(t).strftime("%Y-%m-%d")


def inactive(reason):
    return {"version": 1, "active": False, "reason": reason,
            "assets": [{**a, "available": False, "reason": reason} for a in ASSETS],
            "windows": [], "defaults": {"window": None}, "asof": None,
            "data_asof": None, "common_observation": None,
            "frequency": "monthly", "annualization": 12, "ddof": 1,
            "basis": "KRW · USD 자산 미헤지 · 월별 목표비중 재조정",
            "rf_source": RF_KEY, "rf_label": "CD(AAA) 3M 대용금리",
            "source_observations": {}, "unavailable_windows": WINDOW_YEARS.copy()}


def build(series_store: dict, warn) -> dict:
    result = inactive("")
    assets, levels = [], {}
    for spec in ASSETS:
        s, reason = _series(series_store, spec["source"])
        assets.append({**spec, "available": s is not None, "reason": reason})
        if s is not None:
            levels[spec["key"]] = s
            result["source_observations"][spec["source"]] = {
                "first": _day(s.index.min()), "last": _day(s.index.max()), "n": len(s)}

    # Different currency-labelled bond sources must not be duplicate histories.
    # Do not pretend an exact copy of the USD series is a verified KRW bond index.
    if "kr_bond" in levels and "us_bond" in levels:
        pair = pd.concat([levels["kr_bond"], levels["us_bond"]], axis=1).dropna()
        if len(pair) >= 24 and pair.iloc[:, 0].nunique() > 1 and np.array_equal(pair.iloc[:, 0], pair.iloc[:, 1]):
            assets[0].update(available=False, reason="한국종합·미국종합 원천값 완전 중복 — 국내채권 원천 확인 필요")
            del levels["kr_bond"]

    fx, fx_reason = _series(series_store, FX_KEY)
    if fx is not None:
        result["source_observations"][FX_KEY] = {
            "first": _day(fx.index.min()), "last": _day(fx.index.max()), "n": len(fx)}
    for a in assets:
        if a["available"] and a["currency"] == "USD→KRW" and fx is None:
            a.update(available=False, reason=fx_reason)
            del levels[a["key"]]
    result["assets"] = assets
    if len(levels) < 2:
        result["reason"] = "검증 가능한 자산 원천 2개 이상 필요"
        return result

    needs_fx = any(a["available"] and a["currency"] == "USD→KRW" for a in assets)
    daily = pd.concat({**levels, **({"fx": fx} if needs_fx else {})}, axis=1, sort=True)
    source_last = [s.index.max() for s in levels.values()] + ([fx.index.max()] if needs_fx else [])
    source_cutoff = min(source_last)
    # A source's last calendar month is always partial for this feature. This is
    # conservative even if an input ends exactly on its month-end date.
    cutoff = source_cutoff.to_period("M").start_time
    result["data_asof"] = _day(source_cutoff)
    common = daily.dropna()
    if common.empty:
        result["reason"] = "자산·환율의 동일 관측일 없음"
        return result
    result["common_observation"] = _day(common.index.max())
    common = common.loc[common.index < cutoff].copy()
    if common.empty:
        result["reason"] = "완료월 공동 관측 없음"
        return result
    for a in assets:
        if a["available"] and a["currency"] == "USD→KRW":
            common[a["key"]] = common[a["key"]] * common["fx"]
    common = common[list(levels)]
    monthly = common.resample("ME").last()
    # Keep calendar holes in the frame until returns have been computed. A hole
    # invalidates its month and the following return, rather than bridging it.
    returns = monthly.pct_change(fill_method=None)
    valid = returns.notna().all(axis=1)
    if not valid.any():
        result["reason"] = "연속 월간 공동 수익률 없음"
        return result
    last = valid[valid].index[-1]
    last_pos = returns.index.get_loc(last)
    first_pos = last_pos
    while first_pos > 0 and bool(valid.iloc[first_pos - 1]):
        first_pos -= 1
    trailing = returns.iloc[first_pos:last_pos + 1]
    result["asof"] = _day(last)
    result["contiguous_months"] = len(trailing)
    result["sample_start"] = _day(trailing.index.min())
    if len(trailing) < 12:
        result["reason"] = f"연속 공동 표본 {len(trailing)}개월 — 최소 12개월 필요"
        return result

    rf, rf_reason = _series(series_store, RF_KEY, positive=False)
    if rf is not None:
        result["source_observations"][RF_KEY] = {
            "first": _day(rf.index.min()), "last": _day(rf.index.max()), "n": len(rf)}
        # Beginning-month annual CD yield approximates a monthly cash return /12.
        rf_monthly = rf.loc[rf.index < cutoff].resample("ME").last().shift(1)
    else:
        rf_monthly = None
    present = [i for i, a in enumerate(assets) if a["available"]]
    windows = []
    for years in WINDOW_YEARS:
        n = 12 * years
        if len(trailing) < n:
            continue
        sub = trailing.iloc[-n:]
        means, vols = [None] * len(assets), [None] * len(assets)
        covariance = [[None] * len(assets) for _ in assets]
        cov = sub.cov(ddof=1) * 12
        for i in present:
            key = assets[i]["key"]
            means[i] = round(float(sub[key].mean() * 1200), 8)
            vols[i] = round(float(sub[key].std(ddof=1) * math.sqrt(12) * 100), 8)
            for j in present:
                covariance[i][j] = round(float(cov.loc[key, assets[j]["key"]]), 14)
        rf_sub = rf_monthly.reindex(sub.index) if rf_monthly is not None else None
        rf_available = rf_sub is not None and rf_sub.notna().all() and np.isfinite(rf_sub).all()
        windows.append({"key": f"y{years}", "label": f"{years}년", "n_months": n,
                        "start": _day(sub.index.min()), "end": _day(sub.index.max()),
                        "mean_pct": means, "vol_pct": vols, "cov": covariance,
                        "rf_mean_pct": round(float(rf_sub.mean()), 8) if rf_available else None,
                        "rf_reason": "" if rf_available else rf_reason or "동일 표본의 전월 말 CD 금리 부족"})
    result.update(active=True, reason="", windows=windows,
                  defaults={"window": windows[-1]["key"]},
                  unavailable_windows=[y for y in WINDOW_YEARS if 12 * y > len(trailing)])
    return result


SNAPSHOT_FILE = "reference_portfolio_snapshot.json"


def prefer_snapshot(computed: dict, data_dir, warn) -> dict:
    """Read a validated aggregate snapshot from this Data checkout, never a URL.

    Raw computations win on equal/newer data_asof. The snapshot supplements only
    this feature while newer workbook data have not reached the deployment repo.
    """
    if data_dir is None:
        return computed
    import json
    from datetime import date
    from pathlib import Path
    import check_output

    root = Path(data_dir).resolve()
    path = root / SNAPSHOT_FILE
    if not path.exists():
        return computed
    try:
        if not path.resolve().is_relative_to(root) or path.stat().st_size > 256_000:
            raise ValueError("snapshot 경로·크기 규약 위반")
        wrapper = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(wrapper, dict) or set(wrapper) != {"source", "reference"}:
            raise ValueError("source/reference 객체 필요")
        if not check_output._valid_reference_snapshot_source(wrapper["source"]):
            raise ValueError("snapshot 출처 메타데이터 위반")
        snapshot = wrapper["reference"]
        if not isinstance(snapshot, dict) or "source_snapshot" in snapshot:
            raise ValueError("원천 snapshot 중첩 금지")
        errors = []
        check_output._check_reference_portfolio(snapshot, errors)
        if errors:
            raise ValueError(errors[0])
        snapshot_day = date.fromisoformat(snapshot["data_asof"])
        computed_day = date.fromisoformat(computed["data_asof"]) if computed.get("data_asof") else None
        if computed_day is not None and computed_day >= snapshot_day:
            return computed
        return {**snapshot, "source_snapshot": wrapper["source"]}
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as exc:
        warn(f"reference: {SNAPSHOT_FILE} 무시 — {exc}")
        return computed


def build_for_data_dir(series_store: dict, warn, data_dir=None) -> dict:
    """Build current raw moments, then choose a strictly newer checked snapshot."""
    return prefer_snapshot(build(series_store, warn), data_dir, warn)
