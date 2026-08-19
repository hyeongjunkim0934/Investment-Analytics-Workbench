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
import re

import numpy as np
import pandas as pd
import pytest

from pathlib import Path

import common
import hedge
import process
import risk

ROOT_PIPE = Path(__file__).resolve().parents[1] / "pipeline"


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


def _rand_cov(seed=17):
    rng = np.random.default_rng(seed)
    n = len(alloc.SOURCE_LABELS)
    A = rng.normal(size=(n, n)) * 0.01
    return A @ A.T


def test_alloc_hedge_levers_collapse_to_one_axis_exactly():
    """같은 Xe 를 만드는 (h채, h주) 는 위험이 **정확히** 같다 — 근사가 아니라 항등식.

    이 성질이 깨지면 '최적 헤지비율' 한 점을 적어도 되지만, 성립하는 한 한 점을
    고르는 것은 무한한 동점 중 임의 선택이다. 화면 문구가 그 위에 서 있다.
    """
    covS = _rand_cov()
    w = np.array([0.4, 0.2, 0.05, 0.05, 0.12, 0.03, 0.03])
    k = 0.7
    sig = lambda hb, he: math.sqrt(float((w @ alloc.loadings(hb, he, k)) @ covS
                                         @ (w @ alloc.loadings(hb, he, k))))
    target = alloc.unhedged_fx(w, 0.35, 1.00)
    base = sig(0.35, 1.00)
    seen = 0
    for hb in np.arange(0.0, 1.0001, 0.01):
        he = 1 - (target - w[1] * (1 - hb)) / w[3]
        if he < -1e-9 or he > 1 + 1e-9:
            continue
        seen += 1
        assert abs(alloc.unhedged_fx(w, hb, he) - target) < 1e-12
        assert abs(sig(hb, he) - base) < 1e-14, f"({hb},{he}) 에서 동률이 깨짐"
    assert seen >= 10, "동률 능선 위의 표본이 너무 적어 검사가 무의미하다"


def test_alloc_hedge_xe_min_is_the_true_minimum():
    """폐형 Xe* 가 모든 (h채,h주) 조합보다 낮거나 같다 — 격자 argmin 을 대체한 근거."""
    covS = _rand_cov(5)
    w = np.array([0.4, 0.2, 0.05, 0.05, 0.12, 0.03, 0.03])
    k = 0.7
    xe, smin = alloc.hedge_xe_min(covS, w, k)
    for hb in np.arange(0, 1.0001, 0.02):
        for he in np.arange(0, 1.0001, 0.02):
            x = w @ alloc.loadings(hb, he, k)
            assert math.sqrt(max(float(x @ covS @ x), 0)) >= smin - 1e-12
    a0, a1, a2 = alloc.hedge_quad(covS, w, k)
    assert a2 > 0                                     # 볼록 — 밴드 절단이 곧 제약 하 최소
    assert abs(a0 + 2 * a1 * xe + a2 * xe * xe - smin ** 2) < 1e-18


def test_alloc_hedge_xe_min_clips_to_band():
    """밴드가 물면 제약 하 최소는 잘린 끝점이다(볼록이므로)."""
    covS = _rand_cov(9)
    w = np.array([0.4, 0.2, 0.05, 0.05, 0.12, 0.03, 0.03])
    k = 0.7
    free, _ = alloc.hedge_xe_min(covS, w, k)
    lo, hi = free + 0.01, free + 0.05                 # 자유 최소점의 오른쪽만 허용
    xe, s = alloc.hedge_xe_min(covS, w, k, xe_lo=lo, xe_hi=hi)
    assert abs(xe - lo) < 1e-12
    a0, a1, a2 = alloc.hedge_quad(covS, w, k)
    assert abs(a0 + 2 * a1 * lo + a2 * lo * lo - s ** 2) < 1e-18


def test_alloc_xe_range_matches_band_corners():
    w = np.array([0.4, 0.2, 0.05, 0.05, 0.12, 0.03, 0.03])
    bands = ((0.7, 1.0), (0.0, 0.2))
    lo, hi = alloc.xe_range(w, bands)
    assert abs(lo - alloc.unhedged_fx(w, 1.0, 0.2)) < 1e-15
    assert abs(hi - alloc.unhedged_fx(w, 0.7, 0.0)) < 1e-15
    assert lo < hi


def test_alloc_hedge_pair_for_xe_is_the_closest_feasible_point():
    """대표점 규칙 = 밴드 ∩ 등Xe 직선 위에서 현재값에 가장 가까운 점 (임의 계수 0개)."""
    w = np.array([0.4, 0.2, 0.05, 0.05, 0.12, 0.03, 0.03])
    bands = ((0.0, 1.0), (0.0, 1.0))
    cur = (0.98, 0.0)
    xe = alloc.unhedged_fx(w, 0.35, 1.00)
    hb, he = alloc.hedge_pair_for_xe(w, xe, cur, bands)
    assert abs(alloc.unhedged_fx(w, hb, he) - xe) < 1e-12         # 같은 Xe 를 만든다
    assert bands[0][0] <= hb <= bands[0][1] and bands[1][0] <= he <= bands[1][1]
    d = (hb - cur[0]) ** 2 + (he - cur[1]) ** 2
    for g in np.arange(0.0, 1.0001, 0.005):                        # 무차별 대조
        h2 = 1 - (xe - w[1] * (1 - g)) / w[3]
        if h2 < 0 or h2 > 1:
            continue
        assert (g - cur[0]) ** 2 + (h2 - cur[1]) ** 2 >= d - 1e-12
    # 현재값이 이미 그 Xe 위에 있으면 움직이지 않는다
    same = alloc.hedge_pair_for_xe(w, alloc.unhedged_fx(w, *cur), cur, bands)
    assert abs(same[0] - cur[0]) < 1e-12 and abs(same[1] - cur[1]) < 1e-12


def test_alloc_hedge_pair_for_xe_reports_infeasible_instead_of_guessing():
    """밴드 안에서 만들 수 없는 Xe 는 None — 조용히 아무 점이나 돌려주지 않는다."""
    w = np.array([0.4, 0.2, 0.05, 0.05, 0.12, 0.03, 0.03])
    bands = ((0.7, 1.0), (0.0, 0.2))
    lo, hi = alloc.xe_range(w, bands)
    assert alloc.hedge_pair_for_xe(w, hi + 0.01, (0.98, 0.0), bands) is None
    assert alloc.hedge_pair_for_xe(w, lo - 0.01, (0.98, 0.0), bands) is None
    assert alloc.hedge_pair_for_xe(w, (lo + hi) / 2, (0.98, 0.0), bands) is not None


def test_alloc_hedge_pair_handles_missing_foreign_sleeve():
    """해외주식이 0이면 주식헤지는 정보가 없다 — 현재값을 그대로 둔다(0 으로 만들지 않는다)."""
    w = np.array([0.5, 0.3, 0.05, 0.0, 0.08, 0.02, 0.05])
    bands = ((0.0, 1.0), (0.0, 1.0))
    hb, he = alloc.hedge_pair_for_xe(w, alloc.unhedged_fx(w, 0.6, 0.4), (0.98, 0.4), bands)
    assert abs(he - 0.4) < 1e-12
    assert abs(hb - 0.6) < 1e-12


def test_alloc_split_alt_shares_proxy_row_exactly():
    """대체투자 지분형/대출형(§7.7.9) — 프록시층에서는 같은 행을 공유한다.

    행이 동일하므로 두 분류는 완전상관이고, 합계 비중이 같으면 어떤 분할이든
    총위험이 **정확히** 같다 — 구 단일 「대체투자」 축과의 연속성 근거다.
    (분류별 위험 구분은 CMA 층의 팩터 매핑 몫 — app.js cmaAltRows.)
    """
    covS = _rand_cov(21)
    B = alloc.loadings(0.9, 0.9, 0.7)
    assert B.shape == (len(alloc.ECON_ASSETS), len(alloc.SOURCE_LABELS))
    i_eq = alloc.ECON_ASSETS.index("대체투자(지분형)")
    i_dt = alloc.ECON_ASSETS.index("대체투자(대출형)")
    assert (B[i_eq] == B[i_dt]).all()
    n = len(alloc.ECON_ASSETS)
    w1 = np.zeros(n)
    w1[i_eq] = 0.15
    w2 = np.zeros(n)
    w2[i_eq], w2[i_dt] = 0.06, 0.09
    sig2 = lambda w: float((w @ B) @ covS @ (w @ B))
    assert abs(sig2(w1) - sig2(w2)) < 1e-18
    # 삽입 위치 계약 — 해외채권 1·해외주식 3 이 밀리면 Xe 산식이 조용히 틀어진다
    assert alloc.ECON_ASSETS.index("해외채권") == 1
    assert alloc.ECON_ASSETS.index("해외주식") == 3


def test_alloc_anchor_definition():
    """앵커 = 국내·해외 채권의 자국통화 (초과보상 ÷ σ) 평균 (승인 ⑤-ⓑ) — 손 재계산 대조.

    자국통화 기준이므로 환율·스왑 분산이 아무리 커도 앵커에 못 들어온다 —
    e_usd 에 큰 분산을 심어 두고 그 무관성까지 함께 단정한다.
    """
    n = len(alloc.SOURCE_LABELS)
    covS = np.zeros((n, n))
    i_kr, i_us, i_e = alloc.IX["kr_bond"], alloc.IX["us_bond"], alloc.IX["e_usd"]
    covS[i_kr, i_kr] = (0.04) ** 2
    covS[i_us, i_us] = (0.05) ** 2
    covS[i_e, i_e] = (0.50) ** 2          # 일부러 크게 — 앵커에 새면 아래 단정이 깨진다
    rates = {"kr3m": {"v": 2.0}, "kr5y": {"v": 4.0},
             "us_ytm": {"v": 5.0}, "us3m": {"v": 3.0}}
    a = alloc.anchor_of(covS, rates)
    expected = ((4.0 - 2.0) / 4.0 + (5.0 - 3.0) / 5.0) / 2
    assert abs(a["value"] - expected) < 1e-12
    assert a["us"]["sigma"] == 5.0        # 달러표시 σ 그대로 — 환노출 미포함


def test_alloc_hp_interpolation():
    """HP 곡선 보간 — 격자점 재현·중간 선형·12M 초과 고정(구현 산식과 독립 판정)."""
    curve = {"3M": -0.60, "6M": -0.90, "12M": -1.50}
    assert alloc.hp_cost_at(curve, 3) == -0.60
    assert alloc.hp_cost_at(curve, 6) == -0.90
    assert alloc.hp_cost_at(curve, 12) == -1.50
    assert abs(alloc.hp_cost_at(curve, 9) - (-1.20)) < 1e-12    # 6M·12M 중점
    assert alloc.hp_cost_at(curve, 24) == -1.50                 # 12M 초과 → 12M 고정
    assert alloc.hp_cost_at(curve, 1) == -0.60                  # 3M 미만 → 3M 고정


def _rand_problem(rng, n=6):
    """임의의 양정치 문제 — KKT·다중시작 검증용 (구현을 베끼지 않은 독립 판정)."""
    G = rng.normal(size=(n, n))
    cov = G @ G.T + n * np.eye(n)
    mu = rng.uniform(2, 10, n)
    lo = np.zeros(n)
    hi = rng.uniform(0.3, 0.8, n)
    total = 0.9 * float(hi.sum()) / 2
    return mu, cov, lo, hi, total


def _kkt_ok(w, mu, cov, lo, hi, lam, tol=1e-3):
    """정지 조건: 내부점은 잔차 0, 하한 활성은 잔차 ≥ 0, 상한 활성은 ≤ 0."""
    g = cov @ w - lam * mu
    interior = (w > lo + 1e-7) & (w < hi - 1e-7)
    if interior.sum() == 0:
        return True
    nu = float(g[interior].mean())          # 예산 제약의 승수
    r = g - nu
    for i in range(len(w)):
        if interior[i] and abs(r[i]) > tol:
            return False
        if w[i] <= lo[i] + 1e-7 and r[i] < -tol:
            return False
        if w[i] >= hi[i] - 1e-7 and r[i] > tol:
            return False
    return True


def test_alloc_optimize_minvar_kkt_and_multistart():
    """격자 전수조사(3자산)와 별개로, 임의 6자산 문제에서 KKT + 무작위 3000점 대조."""
    rng = np.random.default_rng(3)
    for _ in range(3):
        mu, cov, lo, hi, total = _rand_problem(rng)
        w = alloc.optimize(mu, cov, lo, hi, total, iters=3000)
        assert abs(w.sum() - total) < 1e-6
        assert (w >= lo - 1e-9).all() and (w <= hi + 1e-9).all()
        assert _kkt_ok(w, mu, cov, lo, hi, lam=0.0)
        W0 = rng.dirichlet(np.ones(len(mu)), 3000) * total
        W = np.array([alloc.project(x, lo, hi, total) for x in W0])
        risks = np.einsum("bi,ij,bj->b", W, cov, W)
        assert float(w @ cov @ w) <= risks.min() + 1e-6


def test_alloc_optimize_target_binds_and_costs_risk():
    """최소분산보다 높은 목표수익 → 목표가 묶이고 위험은 그만큼 커진다."""
    rng = np.random.default_rng(4)
    mu, cov, lo, hi, total = _rand_problem(rng)
    wmv = alloc.optimize(mu, cov, lo, hi, total, iters=3000)
    target = float(mu @ wmv) + 0.5
    w = alloc.optimize(mu, cov, lo, hi, total, target=target, iters=3000)
    assert float(mu @ w) >= target - 1e-3
    assert float(w @ cov @ w) >= float(wmv @ cov @ wmv) - 1e-9


def test_alloc_infeasible_bands_raise():
    """실행 불가능한 밴드는 침묵이 아니라 명시적 ValueError (app.js 와 같은 규칙)."""
    with pytest.raises(ValueError):
        alloc.check_feasible(np.array([0.5, 0.5, 0.3]), np.ones(3), 1.0)
    with pytest.raises(ValueError):
        alloc.check_feasible(np.zeros(3), np.array([0.2, 0.2, 0.2]), 1.0)
    alloc.check_feasible(np.zeros(3), np.ones(3), 1.0)   # 정상 — 예외 없음


# ---------------------------------------------------------------------------
# HP 커브 읽기 — hedge.py 와 alloc.py 의 유일한 경로 (B-7)
#
# 예전에는 두 모듈이 같은 시리즈를 각자 `iloc[-1]` 로 읽었다. 두 산식이 우연히
# 같아 9개월에서 −0.9750 으로 일치했을 뿐이고, 한쪽만 읽는 법을 바꾸면 **같은
# 화면의 두 숫자가 조용히 갈라진다.** 통합이 중앙값 도입의 선행 조건이었다.
# ---------------------------------------------------------------------------

def _hp_store(vals: dict, days: int = 30) -> dict:
    idx = pd.bdate_range("2030-01-01", periods=days)
    return {f"info:USDKRW_HP_{m}": pd.Series(v, index=idx) for m, v in vals.items()}


def test_hp_curve_takes_the_median_of_the_last_n_days():
    """홀수창 중앙값 — 마지막 값 하나가 튀어도 게시값이 따라가지 않아야 한다."""
    base = [-1.0] * 25 + [-1.0, -1.0, -1.0, -1.0, -5.5]     # 마지막 날만 −5.5 로 튐
    S = _hp_store({"3M": base, "6M": base, "12M": base}, days=30)
    got = common.hp_curve(S, "USD", n=5)
    assert got["curve"] == {"3M": -1.0, "6M": -1.0, "12M": -1.0}, got["curve"]
    assert got["window"] == 5 and got["n_used"] == 5
    # N=1 이면 예전의 최신 호가와 정확히 같다 — 되돌리기가 상수 한 글자인 근거
    assert common.hp_curve(S, "USD", n=1)["curve"]["3M"] == -5.5


def test_hp_curve_is_the_plain_median_not_a_mean():
    """평균이면 튄 값이 섞여 들어온다 — 중앙값이어야 한다."""
    vals = [1.0, 1.0, 1.0, 1.0, 100.0]
    S = _hp_store({m: vals for m in common.HP_TENORS}, days=5)
    assert common.hp_curve(S, "USD", n=5)["curve"]["3M"] == 1.0


def test_hp_curve_skips_nan_and_reports_what_it_used():
    """NaN 은 제거하고, 관측이 창보다 짧으면 있는 만큼만 쓴다(조용히 실패하지 않는다)."""
    v = [float("nan"), float("nan"), 2.0, 4.0, 6.0]
    S = _hp_store({m: v for m in common.HP_TENORS}, days=5)
    got = common.hp_curve(S, "USD", n=5)
    assert got["curve"]["3M"] == 4.0, "NaN 을 값으로 셌다"
    assert got["n_used"] == 3, got["n_used"]


def test_hp_curve_returns_none_when_a_tenor_is_missing():
    """세 만기 중 하나라도 없으면 커브가 아니다 — 부분 커브를 내보내면 보간이 거짓말한다."""
    S = _hp_store({"3M": [1.0] * 5, "6M": [1.0] * 5}, days=5)
    assert common.hp_curve(S, "USD", n=5) is None
    assert common.hp_curve({}, "USD") is None


def test_hp_curve_maps_currency_codes_to_series_keys():
    """USD 만 키가 `USDKRW` 로 예외다 — 나머지는 `<코드>KRW`."""
    idx = pd.bdate_range("2030-01-01", periods=5)
    S = {f"info:JPYKRW_HP_{m}": pd.Series([2.0] * 5, index=idx) for m in common.HP_TENORS}
    assert common.hp_curve(S, "JPY")["curve"]["3M"] == 2.0
    assert common.hp_curve(S, "USD") is None


def test_hedge_and_alloc_read_the_same_hp_curve():
    """두 모듈이 **같은 헬퍼를 부르고 같은 값을 낸다.**

    이것이 깨지면 `#hedge` 매트릭스의 12개월 값과 `#alloc` 방법론 패널의 헤지비용이
    조용히 갈라진다. 소스 검사가 아니라 두 모듈을 실제로 돌려서 대조한다.
    """
    import alloc
    src = (ROOT_PIPE / "hedge.py").read_text(encoding="utf-8")
    src_a = (ROOT_PIPE / "alloc.py").read_text(encoding="utf-8")
    for name, txt in (("hedge.py", src), ("alloc.py", src_a)):
        assert "common.hp_curve(" in txt, f"{name} 가 공유 헬퍼를 쓰지 않습니다"
        assert "_HP_3M" not in txt or "hp_curve" in txt, f"{name} 가 HP 를 직접 읽습니다"
    # 값 대조 — 같은 store 를 두 경로에 태운다
    idx = pd.bdate_range("2030-01-01", periods=20)
    vals = {"3M": -0.60, "6M": -0.78, "12M": -0.82}
    S = {f"info:USDKRW_HP_{m}": pd.Series([v] * 20, index=idx) for m, v in vals.items()}
    from_common = common.hp_curve(S, "USD")["curve"]
    assert from_common == vals
    # alloc 의 보간은 그 커브 위에서 돈다 — 9개월은 6M~12M 구간의 선형 보간
    expect = vals["6M"] + (vals["12M"] - vals["6M"]) * (9 - 6) / 6
    assert alloc.hp_cost_at(from_common, 9) == round(expect, 3)


def test_hp_median_window_is_odd_and_documented():
    """창은 홀수여야 중앙값이 실제 관측 하나가 된다(짝수면 두 값의 평균 = 없는 값).

    그리고 이 상수는 **근거가 소스에 적혀 있어야** 한다 — 자의적 상수 금지 규약.
    """
    assert common.HP_MEDIAN_N % 2 == 1, f"창이 짝수다: {common.HP_MEDIAN_N}"
    src = (ROOT_PIPE / "common.py").read_text(encoding="utf-8")
    block = src.split("HP_MEDIAN_N =")[0][-2000:]
    assert "자기상관" in block and "임의 상수가 아니다" in block, (
        "HP_MEDIAN_N 의 근거가 소스에 없습니다 — 자의적 상수 금지"
    )


def test_cma_fx_baseline_is_per_series_not_one_size(  # noqa: D401
):
    """BM 계열마다 **자체 헤지 스탠스 h₀** 가 다르다 — §7.7.19.

    기관이 자산군별 실제 정책 그대로 지수를 산출하므로 해외채권 BM 은 환헤지 반영
    (h₀=1), 해외주식 BM 은 미헤지(h₀=0)다(2026-08-17 사용자 확인). 노출은
    `BM + (h₀ − h)·_fx` 이고 h = h₀ 면 보정이 0 이다.

    예전 코드는 전 계열을 h₀=1 로 읽어 해외주식에 `(1 − he)` 를 더했고, 그 계열은
    이미 환을 이고 있었으므로 **환노출을 w주식 만큼 이중계상**했다. 그러면 헤지 축이
    한 칸 밀려 화면의 「완전헤지」가 실제로는 「완전오픈」이 된다.

    오진의 원인은 **단순상관으로 판정한 것**이다 — ACWI 가 달러원과 음의 상관이라
    미헤지 해외주식도 단순상관이 0 근처로 상쇄된다. 갈라내려면 다변량 회귀라야 한다.
    이 테스트는 계열별 h₀ 와 그 근거 서술이 소스에 남아 있는지만 본다(동작 검증은
    프로브 `cmaLayer` 의 equityAtOpenIsRawBm/bondAtFullHedgeIsRawBm 이 한다).
    """
    src = (Path(__file__).resolve().parents[1] / "dashboard" / "app.js").read_text(
        encoding="utf-8")

    m = re.search(r"const CMA_BM_H0 = \{([^}]*)\}", src)
    assert m, "CMA_BM_H0 상수가 없습니다 — 계열별 환 기준이 정본이어야 합니다"
    body = m.group(1)
    assert re.search(r'"시가 해외채권"\s*:\s*1', body), "해외채권 h₀ 가 1(헤지)이 아닙니다"
    assert re.search(r'"시가 해외주식"\s*:\s*0', body), "해외주식 h₀ 가 0(미헤지)이 아닙니다"

    # 로딩이 상수를 실제로 쓰는가 — `1 - heX` 로 되돌아가면 여기서 걸린다
    assert 'CMA_BM_H0["시가 해외주식"] - heX' in src, (
        "해외주식 행이 계열별 h₀ 를 쓰지 않습니다 — (1 − he) 로 되돌아갔는지 확인"
    )
    assert 'CMA_BM_H0["시가 해외채권"] - hbX' in src, (
        "해외채권 행이 계열별 h₀ 를 쓰지 않습니다"
    )
    # 옛 규약은 **로딩 행**에서만 금지다 — xeOf/xeOfW 의 `(1 − he)` 는 정당하다
    # (Xe = 슬리브의 미헤지 비율이라 h₀ 와 무관하다).
    assert "withFx(base(\"시가 해외주식\"), 1 - heX)" not in src, (
        "해외주식 로딩이 옛 (1 − he) 규약으로 되돌아갔습니다"
    )

    # withFx 는 **음수를 통과**시켜야 한다 — h₀=0 계열을 헤지하면 뺄셈이다
    w = re.search(r"const withFx = \(r, (\w+)\) => \{([^;]*);", src)
    assert w, "withFx 를 찾지 못했습니다"
    assert "Math.abs" in w.group(2), (
        "withFx 가 음수를 버립니다 — `open > 1e-12` 가드가 되살아났는지 확인"
    )

    # 틀린 단언이 화면에 되살아나지 않았는가
    assert "환노출 포함이면 나올 수 없는" not in src, (
        "단순상관 오진 문구가 되살아났습니다 — ACWI 와 달러원의 음의 상관이 상쇄합니다"
    )
    # 오진의 원인이 소스에 기록돼 있어야 같은 실수를 반복하지 않는다
    assert "단순상관으로 판정하지 말 것" in src, "§7.7.19 오진 경위가 소스에서 사라졌습니다"


def test_total_fx_exposure_is_separated_from_xe():
    """매핑 대체투자는 팩터(시가 해외주식 — 미헤지)를 통해 환을 진다 — §7.7.19.

    `_fx` 열 적재량은 0 인데도 실제 환노출이 있어서, Xe(헤지 레버가 닿는 몫)만 적으면
    총 환노출이 실제의 절반 아래로 나간다(실측 대표 배분에서 2.33배 차이). 그래서
    엔진이 `fxLoadW` 로 총 노출을 따로 내고 화면이 Xe 와 **구분해서** 적는다.
    """
    src = (Path(__file__).resolve().parents[1] / "dashboard" / "app.js").read_text(
        encoding="utf-8")
    assert "fxLoadW(w)" in src, "총 환노출 계산(fxLoadW)이 없습니다"
    # 내재분까지 세는가 — (1 − h₀) 가중이 빠지면 _fx 열만 세어 대체투자를 놓친다
    blk = src.split("fxLoadW(w) {")[1][:700]
    assert "CMA_BM_H0" in blk and "1 - CMA_BM_H0" in blk, (
        "fxLoadW 가 팩터 내재 환을 세지 않습니다 — _fx 열만 세면 매핑 대체투자를 놓칩니다"
    )
    assert 'layer !== "cma"' in blk and "return null" in blk, (
        "프록시 층에서 0 을 지어내고 있습니다 — 기저가 달라 null 이어야 합니다"
    )
    # §7.7.20 이후 이 몫도 조절할 수 있게 됐다 — 다만 **다른 슬라이더**다.
    # "조절되지 않습니다"로 되돌아가면 사용자를 없는 제약으로 안내하게 된다.
    assert "이 몫은 위 두 슬라이더가 아니라 「대체투자 환헤지 비율」이 움직입니다" in src, (
        "총 환노출과 Xe 의 차이를 화면이 설명하지 않거나, 어느 레버가 움직이는지 적지 않습니다"
    )
    assert "헤지 슬라이더로 조절되지 않습니다" not in src, (
        "§7.7.20 이후 이 몫은 「대체투자 환헤지 비율」로 조절됩니다 — 옛 문장이 되살아났습니다"
    )


def test_alt_fx_hedge_is_a_model_input_outside_xe():
    """대체투자 환헤지 비율(§7.7.20 — 2026-08-19 사용자 지시) 계약.

    사용자가 「유동적으로 환헤지 중, 현재 90% 정도」라고 확인해 화면 입력이 됐다.
    규약은 사용자가 고른 것이라 코드가 임의로 바꾸지 말 것:
    ① **모형 입력**이라 즉시 저장한다(μ·σ·λ 와 같은 칸 — 최적화가 고르는 레버가 아니다)
    ② **두 분류에 한 비율**을 건다(지분형·대출형 분리 없음)
    ③ **Xe 에는 들어가지 않는다** — 합치면 최적 헤지쌍이 사용자가 정한 값을 덮어쓴다.

    값 자체(90)는 자리표시자이며 기관 수치가 아니다 — 실제 값은 브라우저
    localStorage 에만 남는다(공개 저장소).
    """
    root = Path(__file__).resolve().parents[1]
    src = (root / "dashboard" / "app.js").read_text(encoding="utf-8")
    alloc = (root / "pipeline" / "alloc.py").read_text(encoding="utf-8")

    assert re.search(r'"h_alt"\s*:\s*\d+', alloc), (
        "alloc.py DEFAULTS 에 h_alt 가 없습니다 — 화면 폴백만으로는 디폴트가 두 벌이 됩니다"
    )
    assert "h_alt: d.h_alt == null" in src, "allocDefaults 가 h_alt 를 승계하지 않습니다"

    # 팩터 행에서 실제로 빼는가 — 더하면 헤지가 노출을 늘리는 반대 모형이다
    blk = src.split("const hAlt =")[1][:900]
    assert "r[fxi] -= hAlt * (we / 100)" in blk, (
        "대체투자 헤지가 _fx 를 빼지 않습니다 — 부호가 뒤집혔는지 확인"
    )
    # 슬라이더는 즉시 저장하고 dirty 배지를 켜지 않는다(모형 입력 규약)
    box = src.split("const altHedgeBox = () => {")[1][:1200]
    assert "allocSaveState(st)" in box, "대체투자 헤지가 즉시 저장되지 않습니다"
    assert "markDirty()" not in box, (
        "모형 입력인데 「저장 안 됨」 배지를 켭니다 — 저장했으므로 거짓 표시입니다"
    )
    # Xe 산식에 섞이지 않았는가 — xeOf/xeOfW 는 h_bond/h_eq 만 본다
    for fn in ("xeOf(hbX, heX)", "xeOfW(w, hbX, heX)"):
        body = src.split(fn + " {")[1][:200]
        assert "h_alt" not in body and "hAlt" not in body, (
            f"{fn} 가 대체투자 헤지를 Xe 에 넣고 있습니다 — 최적 헤지쌍이 사용자 값을 덮어씁니다"
        )
