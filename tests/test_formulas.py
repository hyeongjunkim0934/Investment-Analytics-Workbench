# -*- coding: utf-8 -*-
"""산식 회귀.

원칙: 구현을 그대로 베낀 기대값을 쓰지 않는다. 각 산식을 **정의로부터** 독립
구현(느려도 됨)해 두고 그것과 맞춘다 — 구현을 베낀 기대값은 같은 버그를 함께
통과시키므로 회귀 테스트가 아니다.
"""

from __future__ import annotations

import calendar
import itertools
import math

import numpy as np
import pandas as pd
import pytest

import common
import hedge
import process
import risk


# --------------------------------------------------------------------------
# epoch_seconds — 정의: UTC 기준 1970-01-01 이후 초. calendar.timegm 으로 대조.
# --------------------------------------------------------------------------

def test_epoch_seconds_matches_calendar_timegm():
    idx = pd.DatetimeIndex(["1970-01-01", "1999-12-31", "2026-07-24",
                            "2000-02-29", "2038-01-19"])
    expected = [calendar.timegm(ts.to_pydatetime().timetuple()) for ts in idx]
    assert common.epoch_seconds(idx) == expected


def test_epoch_seconds_single_definition_shared():
    """process/risk/hedge 는 각자 복제본이 아니라 common 의 한 함수를 쓴다."""
    assert process.epoch_seconds is common.epoch_seconds
    assert risk.epoch_seconds is common.epoch_seconds
    assert hedge.epoch_seconds is common.epoch_seconds
    assert risk.spearman is common.spearman
    assert risk.auc is common.auc


def test_epoch_seconds_is_monotonic_and_int():
    idx = pd.bdate_range("2020-01-01", periods=50)
    e = common.epoch_seconds(idx)
    assert all(isinstance(x, int) for x in e)
    assert e == sorted(e)
    # 연속 영업일 간격은 1일 또는 3일(주말 건너뜀)뿐
    assert set(int(x) for x in np.diff(e)) <= {86400, 3 * 86400}


# --------------------------------------------------------------------------
# spearman — 정의: 순위의 피어슨 상관.
# --------------------------------------------------------------------------

def _pearson(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    xm, ym = x - x.mean(), y - y.mean()
    return float((xm @ ym) / math.sqrt((xm @ xm) * (ym @ ym)))


def _rank_avg_ties(v):
    """평균 순위(동점은 평균) — pandas .rank() 기본과 같은 정의."""
    order = sorted(range(len(v)), key=lambda i: v[i])
    out = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            out[order[k]] = r
        i = j + 1
    return out


def test_spearman_equals_pearson_of_ranks():
    rng = np.random.default_rng(7)
    a = pd.Series(rng.normal(size=40))
    b = pd.Series(rng.normal(size=40) + 0.5 * a.values)
    expected = _pearson(_rank_avg_ties(list(a)), _rank_avg_ties(list(b)))
    assert common.spearman(a, b) == pytest.approx(expected, abs=1e-12)


def test_spearman_monotone_transform_is_plus_one():
    a = pd.Series(np.arange(1.0, 31.0))
    assert common.spearman(a, a ** 3) == pytest.approx(1.0)
    assert common.spearman(a, -a) == pytest.approx(-1.0)


def test_spearman_needs_ten_common_observations():
    a = pd.Series(range(9), dtype=float)
    assert math.isnan(common.spearman(a, a))
    b = pd.Series(range(10), dtype=float)
    assert common.spearman(b, b) == pytest.approx(1.0)


def test_spearman_uses_only_overlapping_index():
    """정렬은 index 기준 — 겹치는 관측만 쓴다."""
    a = pd.Series(np.arange(20.0), index=pd.RangeIndex(0, 20))
    b = pd.Series(np.arange(20.0), index=pd.RangeIndex(10, 30))
    # 겹침 = index 10..19 -> 10개 (하한 통과), 두 쪽 모두 단조 증가 -> +1
    assert common.spearman(a, b) == pytest.approx(1.0)
    c = pd.Series(np.arange(20.0), index=pd.RangeIndex(11, 31))
    assert math.isnan(common.spearman(a, c))     # 겹침 9개 -> 하한 미달


# --------------------------------------------------------------------------
# auc — 정의: 무작위 양성 1개가 무작위 음성 1개보다 높은 점수를 받을 확률
#             (동점은 0.5). 전수 쌍 비교로 대조한다.
# --------------------------------------------------------------------------

def _auc_pairwise(scores, flags):
    pos = [s for s, f in zip(scores, flags) if f]
    neg = [s for s, f in zip(scores, flags) if not f]
    if not pos or not neg:
        return float("nan")
    wins = sum((1.0 if p > n else 0.5 if p == n else 0.0)
               for p, n in itertools.product(pos, neg))
    return wins / (len(pos) * len(neg))


def test_auc_matches_pairwise_definition():
    rng = np.random.default_rng(11)
    n = 60
    flags = rng.integers(0, 2, n)
    scores = rng.normal(size=n) + 0.8 * flags
    a = pd.Series(scores)
    f = pd.Series(flags)
    assert common.auc(a, f) == pytest.approx(_auc_pairwise(list(scores), list(flags)), abs=1e-12)


def test_auc_handles_ties_as_half():
    scores = pd.Series([1.0, 1.0, 1.0, 1.0])
    flags = pd.Series([1, 1, 0, 0])
    assert common.auc(scores, flags) == pytest.approx(0.5)


def test_auc_perfect_and_inverted():
    scores = pd.Series([1.0, 2.0, 3.0, 4.0])
    flags = pd.Series([0, 0, 1, 1])
    assert common.auc(scores, flags) == pytest.approx(1.0)
    assert common.auc(-scores, flags) == pytest.approx(0.0)


def test_auc_single_class_is_nan():
    s = pd.Series([1.0, 2.0, 3.0])
    assert math.isnan(common.auc(s, pd.Series([1, 1, 1])))
    assert math.isnan(common.auc(s, pd.Series([0, 0, 0])))


# --------------------------------------------------------------------------
# risk 점수 변환 / 등급
# --------------------------------------------------------------------------

@pytest.mark.parametrize("pct,mode,expected", [
    (80.0, "hi", 80.0), (20.0, "hi", 20.0),
    (80.0, "lo", 20.0), (20.0, "lo", 80.0),
    (80.0, "up", 60.0), (50.0, "up", 0.0), (20.0, "up", 0.0), (100.0, "up", 100.0),
])
def test_transform_modes(pct, mode, expected):
    out = risk.transform(pd.Series([pct]), mode)
    assert float(out.iloc[0]) == pytest.approx(expected)


def test_transform_rejects_unknown_mode():
    with pytest.raises(ValueError):
        risk.transform(pd.Series([50.0]), "sideways")


@pytest.mark.parametrize("score,band", [
    (0, "낮음"), (24.9, "낮음"), (25, "보통"), (49.9, "보통"),
    (50, "주의"), (74.9, "주의"), (75, "경계"), (100, "경계"),
])
def test_grade_bands(score, band):
    assert risk.grade(score) == band


def test_expanding_pctl_has_no_lookahead():
    """확장창 백분위는 각 시점까지의 이력만 쓴다 — 뒤 데이터를 붙여도 앞값 불변."""
    rng = np.random.default_rng(3)
    idx = pd.bdate_range("2010-01-01", periods=1200)
    s = pd.Series(rng.normal(size=1200), index=idx)
    first = risk.expanding_pctl(s, 1000)
    longer = risk.expanding_pctl(pd.concat([s, pd.Series(
        rng.normal(size=200), index=pd.bdate_range(idx[-1] + pd.Timedelta(days=1),
                                                   periods=200))]), 1000)
    pd.testing.assert_series_equal(first.dropna(), longer.loc[first.dropna().index])


# --------------------------------------------------------------------------
# process.pack / changes
# --------------------------------------------------------------------------

def test_pack_payload_shape_and_compaction():
    """최근 daily_years 는 일별, 그 이전은 주별(W-FRI) 축약. t 는 단조 증가."""
    idx = pd.bdate_range("2000-01-03", "2026-07-24")
    s = pd.Series(np.arange(float(len(idx))), index=idx)
    p = process.pack(s, daily_years=5)
    assert set(p) == {"t", "v"} and len(p["t"]) == len(p["v"])
    assert p["t"] == sorted(p["t"]) and len(set(p["t"])) == len(p["t"])
    cutoff = idx[-1] - pd.DateOffset(years=5)
    daily = int((idx >= cutoff).sum())
    assert len(p["t"]) < len(idx)          # 축약이 실제로 일어났다
    assert len(p["t"]) >= daily            # 최근 5년은 하루도 잃지 않았다
    assert p["v"][-1] == pytest.approx(float(len(idx) - 1))


def test_pack_none_and_empty():
    assert process.pack(None) is None
    assert process.pack(pd.Series(dtype=float)) is None


def test_changes_rate_price_level():
    idx = pd.to_datetime(["2025-12-31", "2026-07-23", "2026-07-24"])
    s = pd.Series([1.00, 2.00, 3.00], index=idx)
    r = process.changes(s, "rate")
    assert r["d1"] == pytest.approx((3.00 - 2.00) * 100)      # bp
    assert r["ytd"] == pytest.approx((3.00 - 1.00) * 100)
    p = process.changes(s, "price")
    assert p["d1"] == pytest.approx((3.00 / 2.00 - 1) * 100)  # %
    lv = process.changes(s, "level")
    assert lv["d1"] == pytest.approx(1.0)                     # points


def test_asof_takes_last_at_or_before():
    idx = pd.to_datetime(["2026-01-05", "2026-02-05", "2026-03-05"])
    s = pd.Series([1.0, 2.0, 3.0], index=idx)
    ts, v = process.asof(s, pd.Timestamp("2026-02-20"))
    assert ts == pd.Timestamp("2026-02-05") and v == 2.0
    assert process.asof(s, pd.Timestamp("2025-01-01")) == (None, None)


def test_to_num_rejects_vendor_error_strings():
    for bad in ("#N/A N/A", "#NAME?", "", "  ", None, True, False, "abc"):
        assert process.to_num(bad) is None
    assert process.to_num("1,234.5") == pytest.approx(1234.5)
    assert process.to_num(7) == 7.0
    assert process.to_num(float("nan")) is None
    assert process.to_num(float("inf")) is None


# --------------------------------------------------------------------------
# hedge 산식
# --------------------------------------------------------------------------

def test_synth_bond_tr_handles_zero_yield():
    """y=0 (2022년 일본 등)에서 0/0 대신 듀레이션 극한 D->T 를 쓴다."""
    idx = pd.date_range("2020-01-31", periods=8, freq="ME")
    y = pd.Series([0.0] * 8, index=idx)
    out = hedge.synth_bond_tr(y, T=5)
    assert len(out) > 0 and out.notna().all() and (out == 0).all()


def test_despike_removes_single_day_spike_and_reversal():
    idx = pd.bdate_range("2026-01-01", periods=6)
    s = pd.Series([100.0, 100.0, 130.0, 100.0, 100.0, 100.0], index=idx)
    out = hedge.despike(s, thr=0.10)
    assert idx[2] not in out.index
    assert len(out) == 5


# --------------------------------------------------------------------------
# alloc — 투영·최적화·헤지 격자·앵커. 전부 정의로부터 독립 검산.
# --------------------------------------------------------------------------

import alloc


def test_alloc_project_is_euclidean_projection():
    """투영 정의: 박스 ∩ {합=total} 안에서 w 와의 거리 최소점. 촘촘한 격자와 대조."""
    rng = np.random.default_rng(7)
    lo = np.array([0.1, 0.0, 0.2])
    hi = np.array([0.6, 0.5, 0.7])
    total = 1.0
    for _ in range(5):
        w = rng.uniform(-0.5, 1.2, 3)
        p = alloc.project(w, lo, hi, total)
        # 제약 충족
        assert (p >= lo - 1e-9).all() and (p <= hi + 1e-9).all()
        assert abs(p.sum() - total) < 1e-6
        # 격자 전수조사보다 거리가 크지 않다
        g1 = np.arange(lo[0], hi[0] + 1e-12, 0.004)
        g2 = np.arange(lo[1], hi[1] + 1e-12, 0.004)
        G1, G2 = np.meshgrid(g1, g2, indexing="ij")
        G3 = total - G1 - G2
        ok = (G3 >= lo[2] - 1e-12) & (G3 <= hi[2] + 1e-12)
        d2 = (G1 - w[0]) ** 2 + (G2 - w[1]) ** 2 + (G3 - w[2]) ** 2
        best = d2[ok].min()
        mine = ((p - w) ** 2).sum()
        assert mine <= best + 1e-4


def _feasible_grid(lo, hi, total, step=0.005):
    g1 = np.arange(lo[0], hi[0] + 1e-12, step)
    g2 = np.arange(lo[1], hi[1] + 1e-12, step)
    G1, G2 = np.meshgrid(g1, g2, indexing="ij")
    G3 = total - G1 - G2
    ok = (G3 >= lo[2] - 1e-12) & (G3 <= hi[2] + 1e-12)
    return np.stack([G1[ok], G2[ok], G3[ok]], axis=1)


def test_alloc_optimize_minvar_matches_gridsearch():
    rng = np.random.default_rng(11)
    A = rng.normal(size=(3, 3))
    cov = A @ A.T + np.eye(3) * 0.1
    mu = np.array([3.0, 5.0, 7.0])
    lo, hi, total = np.array([0.1, 0.0, 0.2]), np.array([0.6, 0.5, 0.7]), 1.0
    w = alloc.optimize(mu, cov, lo, hi, total)
    W = _feasible_grid(lo, hi, total)
    grid_min = np.einsum("ki,ij,kj->k", W, cov, W).min()
    assert float(w @ cov @ w) <= grid_min + 1e-3


def test_alloc_optimize_target_return_holds_and_is_efficient():
    rng = np.random.default_rng(13)
    A = rng.normal(size=(3, 3))
    cov = A @ A.T + np.eye(3) * 0.1
    mu = np.array([3.0, 5.0, 7.0])
    lo, hi, total = np.array([0.1, 0.0, 0.2]), np.array([0.6, 0.5, 0.7]), 1.0
    target = 5.2
    w = alloc.optimize(mu, cov, lo, hi, total, target=target)
    assert float(mu @ w) >= target - 0.02
    W = _feasible_grid(lo, hi, total)
    keep = W[np.einsum("ki,i->k", W, mu) >= target - 1e-9]
    grid_min = np.einsum("ki,ij,kj->k", keep, cov, keep).min()
    assert float(w @ cov @ w) <= grid_min + 1e-3


def test_alloc_hedge_grid_min_matches_direct_loadings():
    """닫힌꼴 2차식 격자 = 로딩을 직접 만들어 계산한 값 (정의 대조)."""
    rng = np.random.default_rng(17)
    n = len(alloc.SOURCE_LABELS)
    A = rng.normal(size=(n, n)) * 0.01
    covS = A @ A.T
    w = np.array([0.4, 0.2, 0.05, 0.05, 0.15, 0.03])
    k = 0.7
    hb, he, smin = alloc.hedge_grid_min(covS, w, k)
    direct = math.inf
    for hbx in np.arange(0, 101, 5) / 100:
        for hex_ in np.arange(0, 101, 5) / 100:
            x = w @ alloc.loadings(hbx, hex_, k)
            direct = min(direct, math.sqrt(max(float(x @ covS @ x), 0)) * 100)
    assert abs(smin - direct) < 1e-9
    x = w @ alloc.loadings(hb / 100, he / 100, k)
    assert abs(math.sqrt(float(x @ covS @ x)) * 100 - smin) < 1e-9


def test_alloc_anchor_definition():
    """앵커 = 국내·해외 채권의 (초과보상 ÷ σ) 평균 — 손으로 재계산해 대조."""
    n = len(alloc.SOURCE_LABELS)
    covS = np.zeros((n, n))
    i_kr, i_us, i_e, i_sw = (alloc.IX["kr_bond"], alloc.IX["us_bond"],
                             alloc.IX["e_usd"], alloc.IX["swap"])
    covS[i_kr, i_kr] = (0.04) ** 2
    covS[i_us, i_us] = (0.05) ** 2
    covS[i_e, i_e] = (0.10) ** 2
    rates = {"kr3m": {"v": 2.0}, "kr5y": {"v": 4.0}, "us_ytm": {"v": 5.0}}
    a = alloc.anchor_of(covS, rates, h_bond=0.8, cost=-0.5)
    sig_kr = 4.0
    x = np.zeros(n); x[i_us], x[i_e], x[i_sw] = 1, 0.2, 0.8
    sig_us = math.sqrt(float(x @ covS @ x)) * 100
    expected = ((4.0 - 2.0) / sig_kr + (5.0 + 0.8 * -0.5 - 2.0) / sig_us) / 2
    assert abs(a["value"] - expected) < 1e-12
