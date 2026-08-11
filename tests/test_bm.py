# -*- coding: utf-8 -*-
"""BM(자산군 전략 벤치마크) 파서 + CMA 사전계산 계약 (`pipeline/bm.py`).

실파일의 형태 특성(2행 헤더·YYYYMMDD 문자열 날짜·주말 캐리포워드·0=미개시)은
`tests/synth.py` 의 `write_bm` 이 흉내 낸다 — 벤더/기관 값은 한 톨도 없다.
CMA 게시물의 수학(연환산·공분산 대칭·헤지 재구성 항등식)은 여기서 손계산과
독립 재계산으로 대조한다.
"""

from __future__ import annotations

import json
import shutil

import numpy as np
import pandas as pd

import bm
import process
import synth


def _store(**series):
    """build_cma 가 기대하는 최소 형태의 시리즈 저장소."""
    return {k: {"s": v} for k, v in series.items()}


# --------------------------------------------------------------------------
# 파서 — 라우팅·헤더·결측 규약
# --------------------------------------------------------------------------

def test_bm_routing_is_filename_prefix_case_insensitive(tmp_path, synth_dir):
    """`bm`/`BM` 접두사면 확장자 앞 내용과 무관하게 벤치마크 파서로 간다."""
    shutil.copy(synth_dir / "BM지수_synth_20991231.xlsx",
                tmp_path / "bm_소문자_사본.xlsx")
    report = process.load_data_dir(tmp_path)
    assert [r["kind"] for r in report] == ["benchmark"]
    assert set(process.SERIES) == set(synth.BM_KEYS)


def test_bm_group_row_carries_forward_like_merged_cells(parsed):
    """1행 그룹 라벨은 구간 첫 칸에만 있고 빈 칸은 왼쪽을 계승한다.

    계승이 깨지면 `시가` 그룹의 뒷열들이 `장부가` 로 흡수되거나 그룹이 빈다 —
    같은 자산군 이름(국내채권)이 두 그룹에 있으므로 키 충돌로 관측이 사라진다.
    """
    _, P = parsed
    assert "bm:장부가 국내채권" in P.SERIES
    assert "bm:시가 국내채권" in P.SERIES
    a = P.SERIES["bm:장부가 국내채권"]["s"]
    b = P.SERIES["bm:시가 국내채권"]["s"]
    # 두 키는 서로 다른 시리즈여야 한다 (실파일 실측: 전 구간 상이)
    common = a.index.intersection(b.index)
    assert len(common) > 0 and not a[common].equals(b[common])


def test_bm_zero_prefix_is_missing_not_observation(parsed):
    """값 0 = 미개시 결측. 0 이 관측으로 새면 개시일에 ±100% 급변이 생긴다."""
    _, P = parsed
    late = P.SERIES["bm:시가 국내주식"]["s"]
    assert late.index.min() >= pd.Timestamp(synth.BM_LATE_START)
    assert (late > 0).all()
    full = P.SERIES["bm:장부가 국내채권"]["s"]
    assert full.index.min() == pd.Timestamp(synth.BM_START)


def test_bm_dates_are_yyyymmdd_strings_and_junk_rows_skipped(parsed):
    """A열은 YYYYMMDD **문자열**이고, 날짜가 아닌 행(합계 등)은 조용히 무시된다."""
    _, P = parsed
    cal = pd.date_range(synth.BM_START, synth.END)
    s = P.SERIES["bm:장부가 국내채권"]["s"]
    assert len(s) == len(cal)                 # 잡음 행이 관측으로 새지 않았다
    assert s.index.min() == cal[0] and s.index.max() == cal[-1]


# --------------------------------------------------------------------------
# 월말 수익률 — 부분월 가드
# --------------------------------------------------------------------------

def test_month_end_returns_drops_partial_final_month():
    """마지막 달은 관측이 달력 월말에 도달했을 때만 표본에 들어간다.

    실측 동기: BM 파일은 8/10까지, 달러원은 7/20까지였는데 리샘플 라벨(월말)만
    믿으면 그 부분월 수익률이 월간으로 둔갑해 σ·평균이 왜곡된다.
    """
    idx = pd.date_range("2024-01-01", "2024-03-15")
    s = pd.Series(np.linspace(100.0, 130.0, len(idx)), index=idx)
    r = bm._month_end_returns(s)
    assert list(r.index) == [pd.Timestamp("2024-02-29")]   # 3월(부분월)은 없다

    idx2 = pd.date_range("2024-01-01", "2024-03-31")
    s2 = pd.Series(np.linspace(100.0, 130.0, len(idx2)), index=idx2)
    r2 = bm._month_end_returns(s2)
    assert list(r2.index) == [pd.Timestamp("2024-02-29"), pd.Timestamp("2024-03-31")]


# --------------------------------------------------------------------------
# CMA — 비활성 경로 (체인 안전장치)
# --------------------------------------------------------------------------

def test_build_cma_inactive_without_bm_series():
    """BM 파일이 없으면 active:false + 안내 문구 — 게이트·배포는 계속 살아야 한다."""
    out = bm.build_cma(_store(), lambda m: None)
    assert out["active"] is False
    assert "BM" in out["reason"]


def test_build_cma_inactive_below_min_sample():
    """공통 월간 표본 12개월 미만이면 통계를 내지 않는다 (극소표본 CMA 금지)."""
    me = pd.date_range("2025-01-31", periods=8, freq="ME")
    a = pd.Series(np.linspace(100.0, 108.0, 8), index=me)
    warns = []
    out = bm.build_cma(_store(**{"bm:시가 국내주식": a}), warns.append)
    assert out["active"] is False
    assert "개월" in out["reason"]


# --------------------------------------------------------------------------
# CMA — 수학 (손계산 대조)
# --------------------------------------------------------------------------

def test_build_cma_annualization_is_exact():
    """연환산 규약: 평균 ×12, σ ×√12 — +1%/+2% 교대 수익률로 손계산과 대조."""
    me = pd.date_range("2020-01-31", periods=25, freq="ME")
    lvl = [100.0]
    for i in range(24):
        lvl.append(lvl[-1] * (1.01 if i % 2 == 0 else 1.02))
    a = pd.Series(lvl, index=me)
    b = pd.Series(list(reversed(lvl)), index=me)
    out = bm.build_cma(
        _store(**{"bm:장부가 국내채권": a, "bm:시가 국내채권": b}), lambda m: None)
    assert out["active"] is True
    assert out["fx_col"] is None and out["cols"] == out["labels"]
    # 장부가 국내채권 → 시가 국내채권 (경제적 실질 관점 치환쌍)
    assert out["econ_map"]["장부가 국내채권"] == "시가 국내채권"

    w = out["windows"][-1]
    assert w["key"] == "all" and w["n_months"] == 24
    r = np.array([0.01, 0.02] * 12)
    # 게시값은 % 소수 4자리 반올림(rd(·,4)) — 허용오차는 그 양자화 반칸(5e-5)
    assert abs(w["mean_pct"][0] - r.mean() * 12 * 100) < 5e-5
    assert abs(w["vol_pct"][0] - r.std(ddof=1) * np.sqrt(12) * 100) < 5e-5


def test_build_cma_shape_on_parsed_store(parsed):
    """합성 전체 저장소에서: 열 순서·행렬 크기·대칭·σ↔공분산 정합·창 그리드."""
    _, P = parsed
    out = bm.build_cma(P.SERIES, lambda m: None)
    assert out["active"] is True
    assert out["labels"] == [k[3:] for k in synth.BM_KEYS]
    assert out["cols"] == out["labels"] + ["_fx"]     # 달러원이 있으니 환율 축 포함

    keys = [w["key"] for w in out["windows"]]
    assert keys[-1] == "all" and len(keys) == len(set(keys))
    assert set(keys[:-1]) <= {str(y) for y in bm.WINDOW_YEARS}

    n = len(out["cols"])
    for w in out["windows"]:
        assert len(w["mean_pct"]) == n and len(w["vol_pct"]) == n
        assert len(w["corr"]) == n and all(len(row) == n for row in w["corr"])
        assert len(w["cov"]) == n and all(len(row) == n for row in w["cov"])
        for i in range(n):
            assert abs(w["corr"][i][i] - 1.0) < 1e-9
            assert abs(w["cov"][i][i] - (w["vol_pct"][i] / 100.0) ** 2) < 1e-5
            for j in range(n):
                assert abs(w["cov"][i][j] - w["cov"][j][i]) < 1e-12

    # 공통 표본은 늦개시 자산(0 채움) 이후 + 완결월만
    w_all = out["windows"][-1]
    assert w_all["start"] >= synth.BM_LATE_START
    assert w_all["n_months"] >= 12
    for c in out["coverage"]:
        assert set(c) == {"label", "group", "first", "last", "n_months"}


def test_cma_fx_column_supports_hedged_reconstruction(parsed):
    """`_fx` 축의 존재 이유 — 헤지 반영 분산의 폐형 재구성이 실제로 맞는지.

    같은 공통 표본에서 h=1 완전헤지 수익률(r − r_fx)의 분산을 직접 계산한 값과,
    게시된 공분산 행렬로 재구성한 Σii − 2Σif + Σff 가 일치해야 한다. 이게 깨지면
    `_fx` 열이 자리만 차지하는 오라벨이라는 뜻이다.
    """
    _, P = parsed
    out = bm.build_cma(P.SERIES, lambda m: None)
    w = out["windows"][-1]
    cols = out["cols"]
    i, f = cols.index("시가 해외주식"), cols.index("_fx")

    rets = {"a": bm._month_end_returns(P.SERIES["bm:시가 해외주식"]["s"]),
            "f": bm._month_end_returns(P.SERIES[bm.FX_KEY]["s"])}
    df = pd.DataFrame(rets).dropna()
    df = df.loc[pd.Timestamp(w["start"]):pd.Timestamp(w["end"])]
    assert len(df) == w["n_months"]        # 표본이 다르면 아래 비교는 무의미하다

    direct = float((df["a"] - df["f"]).var(ddof=1) * 12.0)
    rebuilt = w["cov"][i][i] - 2.0 * w["cov"][i][f] + w["cov"][f][f]
    assert abs(direct - rebuilt) < 1e-6


# --------------------------------------------------------------------------
# CMA — 유출 가드 (원본 수익률·수준 미게시)
# --------------------------------------------------------------------------

def test_cma_block_publishes_no_timeseries(parsed):
    """cma 블록의 수치 배열은 열 수(K+1)를 넘을 수 없다 — 넘으면 시계열 유출이다.

    `test_contract.py` 의 alloc 유출 가드(상한 25)보다 촘촘한 전용 상한이다.
    """
    _, P = parsed
    out = bm.build_cma(P.SERIES, lambda m: None)
    cap = len(out["cols"])

    def walk(o, path="cma"):
        if isinstance(o, list):
            if o and all(isinstance(x, (int, float)) for x in o):
                assert len(o) <= cap, f"{path}: 수치 배열 길이 {len(o)} — 유출 의심"
            for k, v in enumerate(o):
                walk(v, f"{path}[{k}]")
        elif isinstance(o, dict):
            assert "t" not in o and "v" not in o, f"{path}: 시계열 페이로드 금지"
            for k, v in o.items():
                walk(v, f"{path}.{k}")

    walk(out)
    json.dumps(out)    # 직렬화 가능 = 넘파이 스칼라 누수 없음
