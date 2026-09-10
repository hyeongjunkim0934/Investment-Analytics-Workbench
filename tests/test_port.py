# -*- coding: utf-8 -*-
"""포트폴리오 구성(port.py) — 6자산군 프록시 통계·CMA 입력 파일 계약."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

import port
import synth


def _mk_series(vals, dates):
    return {"s": pd.Series(vals, index=pd.DatetimeIndex(dates), dtype="float64")}


def _full_store(n_me=40, fx_start=1000.0, usd_growth=0.01, fx_growth=0.005):
    dates = pd.date_range("2020-01-31", periods=n_me, freq="ME")
    store = {}
    for a, key in port.PROXY.items():
        g = 0.004 if a in ("국내채권", "국내장부") else 0.008
        store[key] = _mk_series([100.0 * (1 + g) ** k for k in range(n_me)], dates)
    store[port.FX_KEY] = _mk_series([fx_start * (1 + fx_growth) ** k for k in range(n_me)], dates)
    store[port.PROXY["해외주식"]] = _mk_series(
        [100.0 * (1 + usd_growth) ** k for k in range(n_me)], dates)
    return store, dates


def test_inactive_without_proxies_or_fx():
    warns = []
    out = port.build({}, warns.append)
    assert out["active"] is False and "프록시" in out["reason"]
    assert out["defaults"]["group_default"] == {"주식": 50.0, "채권": 30.0, "대체": 20.0}

    store, _ = _full_store()
    del store[port.FX_KEY]
    out = port.build(store, warns.append)
    assert out["active"] is False and "환율" in out["reason"]
    assert any("환율" in w for w in warns)


def test_defaults_block_shape():
    groups = port.GROUPS
    flat = [a for g in groups.values() for a in g]
    assert port.ASSETS == ["국내채권", "국내장부", "해외채권", "국내주식", "해외주식", "대체투자"]
    assert sorted(flat) == sorted(port.ASSETS) and len(flat) == 6
    assert sum(port.GROUP_DEFAULT.values()) == 100.0
    assert port.LIQ_RANGE[0] <= port.LIQ_DEFAULT <= port.LIQ_RANGE[1]
    assert groups["유동성"] == ["국내장부"]
    assert port.PROXY["국내장부"] == "bb:원화유동성"


def test_krw_conversion_via_return_identity():
    """USD 자산의 원화 수익률 = (1+r_usd)(1+r_fx)−1 — 구현과 다른 경로로 재구성."""
    store, dates = _full_store(usd_growth=0.02, fx_growth=-0.003)
    warns = []
    out = port.build(store, warns.append)
    assert out["active"] is True
    w = next(w for w in out["windows"] if w["key"] == "all")
    i = out["assets"].index("해외주식")
    r_krw = (1 + 0.02) * (1 - 0.003) - 1.0
    assert abs(w["mean_pct"][i] - r_krw * 12 * 100) < 1e-2
    assert w["vol_pct"][i] < 1e-6  # 등비 성장 — 수익률 상수라 σ=0
    j = out["assets"].index("국내장부")
    assert abs(w["mean_pct"][j] - 0.004 * 12 * 100) < 1e-2
    kr = [c for c in out["coverage"] if c["asset"] == "국내장부"][0]
    assert kr["currency"] == "KRW"
    us = [c for c in out["coverage"] if c["asset"] == "해외주식"][0]
    assert us["currency"] == "USD→KRW"


def test_domestic_book_proxy_not_reconverted():
    """국내장부는 원화유동성 프록시를 유지하고 환율을 곱하지 않는다."""
    store, dates = _full_store()
    rng = np.random.default_rng(7)
    fx = 1000.0 * np.exp(np.cumsum(rng.normal(0, 0.03, 40)))
    store[port.FX_KEY] = _mk_series(fx, dates)
    flat = [100.0 * (1.003) ** k for k in range(40)]
    store[port.PROXY["국내장부"]] = _mk_series(flat, dates)
    out = port.build(store, lambda m: None)
    w = next(w for w in out["windows"] if w["key"] == "all")
    i = out["assets"].index("국내장부")
    assert w["vol_pct"][i] < 1e-6, "국내장부의 원화 프록시에 환율이 곱해졌다"


def test_removed_dollar_liquidity_does_not_gate_sample():
    """삭제한 계열이 없거나 표본이 짧아도 남은 6자산군 표본에 영향을 주지 않는다."""
    store, dates = _full_store()
    assert "bb:달러유동성" not in store
    out = port.build(store, lambda m: None)
    assert out["active"] is True
    assert "달러유동성" not in out["assets"]
    assert "usd_liq_check" not in out
    store["bb:달러유동성"] = _mk_series([100.0, 102.0], dates[-2:])
    with_removed = port.build(store, lambda m: None)
    assert with_removed == out
    assert next(w for w in out["windows"] if w["key"] == "all")["n_months"] == 39


def test_covariance_keeps_new_asset_order():
    """정해 둔 수익률에서 NumPy 표본 공분산을 직접 재구성해 행·열 순서를 대조한다."""
    assets = ["국내채권", "국내장부", "해외채권", "국내주식", "해외주식", "대체투자"]
    dates = pd.date_range("2020-01-31", periods=41, freq="ME")
    rng = np.random.default_rng(106)
    returns = rng.normal(size=(40, 6)) * np.array([0.004, 0.001, 0.01, 0.03, 0.02, 0.025])
    returns += np.array([0.003, 0.002, 0.004, 0.006, 0.007, 0.005])
    store = {port.FX_KEY: _mk_series([1000.0] * len(dates), dates)}
    for i, asset in enumerate(assets):
        levels = np.r_[100.0, 100.0 * np.cumprod(1.0 + returns[:, i])]
        store[port.PROXY[asset]] = _mk_series(levels, dates)
    out = port.build(store, lambda m: None)
    assert out["assets"] == assets
    assert [c["asset"] for c in out["coverage"]] == assets
    w = next(w for w in out["windows"] if w["key"] == "all")
    C = np.asarray(w["cov"])
    assert C.shape == (6, 6)
    np.testing.assert_allclose(C, np.cov(returns, rowvar=False, ddof=1) * 12, atol=5.1e-9)
    np.testing.assert_allclose(w["corr"], np.corrcoef(returns, rowvar=False), atol=5.1e-9)
    np.testing.assert_allclose(w["mean_pct"], returns.mean(axis=0) * 1200, atol=5.1e-5)
    np.testing.assert_allclose(w["vol_pct"], returns.std(axis=0, ddof=1) * np.sqrt(12) * 100, atol=5.1e-5)


def test_partial_month_dropped():
    dates = list(pd.date_range("2020-01-31", periods=30, freq="ME"))
    mid = pd.Timestamp("2022-07-15")
    store = {}
    for a, key in port.PROXY.items():
        store[key] = _mk_series([100.0 + k for k in range(31)], dates + [mid])
    store[port.FX_KEY] = _mk_series([1000.0 + k for k in range(31)], dates + [mid])
    out = port.build(store, lambda m: None)
    assert out["active"] is True
    assert out["asof"] == "2022-06-30", "부분월(7월 중순까지)이 월간 표본에 섞였다"


def test_cma_input_file_validation(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    (d / "port_cma.json").write_text(json.dumps({
        "asof": "2026-08-01",
        "mu_pct": {"국내채권": 3.2, "해외주식": 6.5, "없는자산군": 1.0, "국내주식": 999.0},
        "note": "테스트",
        "building_blocks": {"국내채권": {"금리": 2.8, "롤다운": 0.4}},
        "process": "비공개 산출 과정 메모",
    }), encoding="utf-8")
    warns = []
    got = port.load_cma_input(d, warns.append)
    assert got is not None
    # 공개 경계(2026-08-22) — 최종 수치만: 파일에 빌딩블록·산출 과정이 있어도
    # 게시물 키는 정확히 {asof, mu_pct} 뿐이다
    assert set(got) == {"asof", "mu_pct"}, "CMA 게시 화이트리스트가 깨졌다"
    assert got["asof"] == "2026-08-01"
    assert got["mu_pct"]["국내채권"] == 3.2 and got["mu_pct"]["해외주식"] == 6.5
    assert got["mu_pct"]["국내주식"] is None, "범위 밖 값이 통과했다"
    assert "없는자산군" not in got["mu_pct"]
    assert set(got["mu_pct"]) == set(port.ASSETS)
    assert any("없는자산군" in w for w in warns) and any("999" in w for w in warns)

    # NaN 리터럴·비유한·bool 독극물 — 전부 경고 후 드롭, 유효 값만 남는다
    (d / "port_cma.json").write_text(
        '{"mu_pct": {"국내채권": NaN, "해외채권": 1e9, "대체투자": true, "국내주식": 3.0}}',
        encoding="utf-8")
    warns2 = []
    got = port.load_cma_input(d, warns2.append)
    assert got is not None
    assert got["mu_pct"]["국내주식"] == 3.0
    assert got["mu_pct"]["국내채권"] is None, "NaN 이 통과했다"
    assert got["mu_pct"]["해외채권"] is None, "1e9 가 통과했다"
    assert got["mu_pct"]["대체투자"] is None, "bool 이 숫자로 통과했다"
    assert json.dumps(got, allow_nan=False)  # 게시 JSON 에 NaN 리터럴이 실릴 수 없다
    assert len(warns2) == 3

    (d / "port_cma.json").write_text("{broken", encoding="utf-8")
    assert port.load_cma_input(d, warns.append) is None
    assert port.load_cma_input(None, warns.append) is None


def test_cma_input_flows_into_pipeline(tmp_path):
    """데이터 디렉터리에 port_cma.json 을 두면 build 가 실어 나른다 — 최종 수치만."""
    store, _ = _full_store()
    (tmp_path / "port_cma.json").write_text(json.dumps(
        {"asof": "2026-08-01", "mu_pct": {a: 3.0 for a in port.ASSETS},
         "building_blocks": {"국내주식": [1, 2, 3]}}), encoding="utf-8")
    out = port.build(store, lambda m: None, tmp_path)
    assert out["active"] is True
    assert out["cma_input"]["mu_pct"] == {a: 3.0 for a in port.ASSETS}
    assert set(out["cma_input"]) == {"asof", "mu_pct"}, (
        "빌딩블록·산출 과정 필드가 공개 게시물에 새어 나갔다 (2026-08-22 공개 경계)"
    )


def test_legacy_cma_asset_migration(tmp_path):
    """기존 Data 입력은 새 6자산 순서로 게시하고 새 이름의 값은 항상 우선한다."""
    path = tmp_path / "port_cma.json"
    legacy = {"국내채권": 3.2, "해외채권": 4.0, "국내주식": 8.0,
              "해외주식": 8.5, "대체투자": 7.0, "달러유동성": 5.0, "원화유동성": 2.7}
    path.write_text(json.dumps({"asof": "2026-09-01", "mu_pct": legacy}), encoding="utf-8")
    warns = []
    got = port.load_cma_input(tmp_path, warns.append)
    assert list(got["mu_pct"]) == port.ASSETS
    assert got["mu_pct"]["국내장부"] == 2.7
    assert got["mu_pct"]["국내채권"] == 3.2
    assert "달러유동성" not in got["mu_pct"] and "원화유동성" not in got["mu_pct"]
    assert warns == []
    for mixed in ({**legacy, "국내장부": 3.1}, {"국내장부": 3.1, **legacy}):
        path.write_text(json.dumps({"mu_pct": mixed}), encoding="utf-8")
        got = port.load_cma_input(tmp_path, warns.append)
        assert got["mu_pct"]["국내장부"] == 3.1
    assert warns == []


def test_krw_liq_cd_reference():
    """CD 적립 참고 — 상수 금리 r 이면 연환산 μ ≈ r, σ ≈ 0. 겹침 검증치도 게시."""
    store, dates = _full_store(n_me=40)
    cd_days = pd.bdate_range("2019-06-01", "2023-05-31")
    store[port.KRW_LIQ_CD_KEY] = _mk_series([3.65] * len(cd_days), cd_days)
    out = port.build(store, lambda m: None)
    ref = out["krw_liq_ref"]
    assert ref is not None and ref["key"] == port.KRW_LIQ_CD_KEY
    # 일할 적립 (1 + 3.65%/365 × Δ일) 의 연환산 평균은 3.65% 근방 (복리 오차 허용)
    assert abs(ref["mean_pct"] - 3.65) < 0.15
    assert ref["vol_pct"] < 0.1, "상수 금리인데 σ 가 크다 — 적립 산식이 깨졌다"
    assert "참고 전용" in ref["note"], "공통 행렬 미포함(참고 전용) 표기가 없다"
    ov = ref["overlap"]
    assert ov is not None and ov["n_months"] >= 12
    assert set(ov) == {"n_months", "corr", "mean_diff_pa_pct"}

    # CD 시리즈가 없으면 조용히 None — 블록 부재가 빌드를 막지 않는다
    store2, _ = _full_store()
    out2 = port.build(store2, lambda m: None)
    assert out2["active"] is True and out2["krw_liq_ref"] is None


def test_synth_fixture_has_port_proxies():
    """픽스처 우주가 프록시 6 + 환율을 전부 덮는다 — 어긋나면 e2e 가 비활성으로 돈다."""
    for key in list(port.PROXY.values()) + [port.FX_KEY]:
        assert key in synth.BB_KEYS, key
