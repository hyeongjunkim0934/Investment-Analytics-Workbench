"""환율모형B — 러너의 결정론적 부품(날짜 해석·NS 요인·결합·라벨 정렬·지표)과 산출물 로더 계약.

torch·xgboost 는 CI 에 없다 — 모형 적합은 몽키패치로 대체하고 **정렬·산식만** 검증한다.
벤더 값은 한 톨도 없다(합성 수치).
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import check_output
import fx_lstm_xgb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline" / "research"))
import fx_lstm_xgb_runner as runner  # noqa: E402


# --------------------------------------------------------------------------
# 러너 — 입력 해석
# --------------------------------------------------------------------------
@pytest.mark.parametrize("text, expected", [
    ("01-Jan", "2001-01"), ("Jan-01", "2001-01"), ("26-May", "2026-05"), ("May-26", "2026-05"),
    ("2026-05", "2026-05"), ("2026/05/31", "2026-05"), ("2026.05", "2026-05"), ("Jan-2001", "2001-01"),
    ("", None), (None, None), ("abc", None),
])
def test_bop_month_parsing_accepts_both_ecos_layouts(text, expected):
    period = runner.parse_bop_month(text)
    assert (str(period) if period is not None else None) == expected


def test_thousands_separator_strings_become_floats():
    out = runner.to_number(pd.Series(["1,509.40", "-672.9", "", "-", "2,320.30"]))
    assert out.tolist()[:2] == [1509.4, -672.9]
    assert np.isnan(out.iloc[2]) and np.isnan(out.iloc[3]) and out.iloc[4] == 2320.3


def _rates_table(n=12, seed=3):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2020-01-31", periods=n, freq="BME")
    cols = {}
    for name in ["usa_3m", "usa_1y", "usa_3y", "usa_10y", "kr_3m", "kr_1y", "kr_3y", "kr_10y"]:
        cols[name] = 2 + rng.normal(0, 1, n)
    cols["spot"] = 1200 + np.cumsum(rng.normal(0, 10, n))
    return pd.DataFrame(cols, index=idx)


def test_ns_factors_match_independent_least_squares_and_never_fill_forward_from_future():
    table = _rates_table()
    factors = runner.ns_factors(table, fill="none")
    lam, mats = runner.NS_LAMBDA, runner.NS_MATURITIES
    x = lam * mats
    loadings = np.column_stack([np.ones(4), (1 - np.exp(-x)) / x, (1 - np.exp(-x)) / x - np.exp(-x)])
    for i, (t, row) in enumerate(table.iterrows()):
        y = np.array([row["usa_3m"] - row["kr_3m"], row["usa_1y"] - row["kr_1y"],
                      row["usa_3y"] - row["kr_3y"], row["usa_10y"] - row["kr_10y"]])
        beta, *_ = np.linalg.lstsq(loadings, y, rcond=None)
        assert factors.iloc[i].to_numpy() == pytest.approx(beta, abs=1e-10)
    # 결측 달: ffill 은 직전 값, interpolate 는 미래값을 섞는다 — 러너 기본값은 ffill.
    table.loc[table.index[4:7], "kr_1y"] = np.nan
    table.loc[table.index[4:7], "kr_3y"] = np.nan      # 유효 만기 2개 → 결측
    ff = runner.ns_factors(table, fill="ffill")
    li = runner.ns_factors(table, fill="interpolate")
    assert ff.iloc[5].to_numpy() == pytest.approx(ff.iloc[3].to_numpy())
    assert not np.allclose(li.iloc[5].to_numpy(), ff.iloc[5].to_numpy())
    assert np.isnan(runner.ns_factors(table, fill="none").iloc[5]).all()


def test_bop_join_uses_publication_lag_by_month_not_row_position():
    table = _rates_table(6)
    months = pd.period_range("2019-11", periods=8, freq="M")
    bop = pd.DataFrame({"경상수지": np.arange(8, dtype=float)}, index=months)
    joined, info = runner.join_bop(table, bop, bop_lag=2)
    # 2020-01 행은 2019-11 값(=0), 2020-03 행은 2020-01 값(=2)
    assert joined.loc["2020-01-31", "경상수지"] == 0
    assert joined.loc["2020-03-31", "경상수지"] == 2
    assert info == {"bop_lag_months": 2, "matched_months": 6, "unmatched_months": 0}
    joined0, _ = runner.join_bop(table, bop, bop_lag=0)
    assert joined0.loc["2020-01-31", "경상수지"] == 2
    assert np.isnan(runner.join_bop(table, bop.iloc[:3], bop_lag=0)[0].loc["2020-06-30", "경상수지"])


def test_walk_forward_trains_only_on_labels_realized_by_the_base_date(monkeypatch):
    n = 40
    idx = pd.date_range("2020-01-31", periods=n, freq="BME")
    feature = pd.DataFrame({name: np.arange(n, dtype=float) + k for k, name in enumerate(runner.FEATURES)}, index=idx)
    feature["spot"] = 1000 + np.arange(n, dtype=float)    # spot = 1000 + 행번호 → 라벨에서 행을 읽어낼 수 있다
    seen = []

    def fake_xgb(train_X, train_y, test_X, seed):
        seen.append(("xgb", int(test_X[0]) - 1000, int(train_y.max()) - 1000))
        return float(test_X[0] + 1000)

    def fake_lstm(train_X, train_y, seq_X, **kw):
        seen.append(("lstm", int(seq_X[-1][0]) - 1000, int(train_y.max()) - 1000, len(seq_X)))
        return float(seq_X[-1][0] + 1000)

    monkeypatch.setattr(runner, "fit_predict_xgb", fake_xgb)
    monkeypatch.setattr(runner, "fit_predict_lstm", fake_lstm)
    lag, window, seq_len = 3, 12, 6
    rows = runner.walk_forward(feature, lag=lag, window=window, seq_len=seq_len, hidden_size=1,
                               num_layers=1, epochs=1, lr=1e-3, seed=1)
    assert rows[0]["t_base"] == idx[lag + window - 1]
    assert rows[-1]["t_base"] == idx[-1]
    for kind, base_row, max_label_row, *rest in seen:
        assert max_label_row == base_row, f"{kind}: 기준 행 {base_row} 학습에 {max_label_row} 행 환율이 쓰였다"
        if kind == "lstm":
            assert rest == [seq_len]
    realized = [r for r in rows if r["actual"] is not None]
    pending = [r for r in rows if r["actual"] is None]
    assert len(pending) == lag and all(r["t_target"] > idx[-1] for r in pending)
    assert realized[-1]["actual"] == 1000 + (n - 1) and realized[-1]["t_target"] == idx[-1]
    assert all(r["ensemble"] == (r["xgb"] + r["lstm"]) / 2 for r in rows)
    # 원 노트북 정렬을 켜면 라벨이 기준일 뒤 환율까지 들어간다(look-ahead 재현 플래그).
    seen.clear()
    runner.walk_forward(feature, lag=lag, window=window, seq_len=seq_len, hidden_size=1, num_layers=1,
                        epochs=1, lr=1e-3, seed=1, replicate_notebook=True)
    assert all(max_label_row == min(base_row + lag - 1, n - 1) for _, base_row, max_label_row, *_ in seen)


def test_summary_metrics_by_hand():
    rows = [
        {"base": 100.0, "actual": 110.0, "xgb": 105.0, "lstm": 115.0, "ensemble": 110.0},
        {"base": 100.0, "actual": 90.0, "xgb": 105.0, "lstm": 85.0, "ensemble": 95.0},
        {"base": 100.0, "actual": None, "xgb": 101.0, "lstm": 99.0, "ensemble": 100.0},
    ]
    s = runner.summarize(rows)
    assert s["rw"]["n"] == 2 and s["rw"]["rmse"] == pytest.approx(10.0)
    assert s["xgb"]["rmse"] == pytest.approx(np.sqrt((25 + 225) / 2))
    assert s["xgb"]["theil_u"] == pytest.approx(s["xgb"]["rmse"] / 10.0)
    assert s["xgb"]["hit_rate"] == 0.5 and s["lstm"]["hit_rate"] == 1.0 and s["ensemble"]["hit_rate"] == 1.0
    assert s["lstm"]["bias"] == pytest.approx(0.0) and s["xgb"]["mae"] == pytest.approx(10.0)
    assert s["rw"]["hit_rate"] is None   # 랜덤워크는 방향을 걸지 않는다
    assert runner.summarize([rows[2]])["xgb"] == {"n": 0}


# --------------------------------------------------------------------------
# 로더 — 산출물 계약
# --------------------------------------------------------------------------
def _artifact(n=5, lag=3, window=24):
    t_base = [1704067200 + 2592000 * i for i in range(n)]
    actual = [1300.0 + i for i in range(n - lag)] + [None] * lag
    return {
        "schema": fx_lstm_xgb.SCHEMA, "generated_at": "2026-10-19T00:00:00Z",
        "runner": {"version": "1", "seed": 7, "replicate_notebook": False, "label_alignment": "realized_by_base_date",
                   "secret_note": "drop me"},
        "model": {"name": "lstm_xgb_walk_forward", "features": ["spot"], "bop_lag_months": 2, "extra": 1},
        "data": {"n_feature_rows": n},
        "grid": {"lags": [lag], "windows": [window]},
        "regime_defaults": {"low_below": 1100, "high_above": 1300},
        "combos": [{"key": f"l{lag}_w{window}", "lag": lag, "window": window,
                    "t_base": t_base, "t_target": [t + 86400 * 90 for t in t_base],
                    "base": [1290.0 + i for i in range(n)], "actual": actual,
                    "pred": {m: [1295.0 + i for i in range(n)] for m in fx_lstm_xgb.MODELS},
                    "summary": {m: {"n": n - lag, "rmse": 1.0, "mae": 1.0, "bias": 0.0, "theil_u": 1.0,
                                    "hit_rate": 0.5, "n_direction": 2} for m in (*fx_lstm_xgb.MODELS, "rw")},
                    "features_private": [[1, 2, 3]]}],
    }


def test_skeleton_keys_match_the_gate_contract():
    assert set(check_output.REQUIRED_NESTED_KEYS[("fx", "lstm_xgb")]) <= set(fx_lstm_xgb.skeleton())
    assert "lstm_xgb" in check_output.REQUIRED_KEYS["fx"]


def test_missing_artifact_publishes_inactive_block_with_reason(tmp_path):
    warnings = []
    out = fx_lstm_xgb.load(tmp_path, warnings.append)
    assert out["active"] is False and fx_lstm_xgb.ARTIFACT in out["reason"] and out["combos"] == []
    assert set(out) == set(fx_lstm_xgb.skeleton()) and not warnings


def test_valid_artifact_is_published_with_known_keys_only(tmp_path):
    folder = tmp_path / "models" / "fx_lstm_xgb"
    folder.mkdir(parents=True)
    (folder / fx_lstm_xgb.ARTIFACT).write_text(json.dumps(_artifact()), encoding="utf-8")
    warnings = []
    out = fx_lstm_xgb.load(tmp_path, warnings.append)
    assert out["active"] is True and out["reason"] is None and not warnings
    assert out["path"] == str(Path("models") / "fx_lstm_xgb" / fx_lstm_xgb.ARTIFACT)
    assert "secret_note" not in out["runner"] and "extra" not in out["model"]
    combo = out["combos"][0]
    assert "features_private" not in combo and combo["n"] == 5 and combo["n_realized"] == 2
    assert set(combo["summary"]) == {"xgb", "lstm", "ensemble", "rw"}
    assert out["grid"] == {"lags": [3], "windows": [24]} and out["regime_defaults"] == {"low_below": 1100, "high_above": 1300}
    assert set(out) == set(fx_lstm_xgb.skeleton())
    json.dumps(out)   # 직렬화 가능


@pytest.mark.parametrize("mutate, fragment", [
    (lambda d: d.update(schema="fx_lstm_xgb/0"), "schema"),
    (lambda d: d["combos"][0]["actual"].pop(), "길이"),
    (lambda d: d["combos"][0]["t_base"].reverse(), "오름차순"),
    (lambda d: d["combos"][0]["actual"].__setitem__(4, 1310.0), "미실현"),
    (lambda d: d["combos"][0]["pred"]["lstm"].__setitem__(0, -1.0), "pred.lstm"),
    (lambda d: d["grid"].update(lags=[1]), "grid"),
    (lambda d: d.update(combos=[]), "combos"),
    (lambda d: d["combos"].append(dict(d["combos"][0])), "중복"),
    (lambda d: d.pop("generated_at"), "generated_at"),
])
def test_malformed_artifact_is_inactive_with_reason_and_warning(tmp_path, mutate, fragment):
    doc = _artifact()
    mutate(doc)
    (tmp_path / fx_lstm_xgb.ARTIFACT).write_text(json.dumps(doc), encoding="utf-8")
    warnings = []
    out = fx_lstm_xgb.load(tmp_path, warnings.append)
    assert out["active"] is False and fragment in out["reason"] and out["combos"] == []
    assert len(warnings) == 1 and fragment in warnings[0]


def test_unreadable_json_and_duplicate_artifacts_are_reported(tmp_path):
    (tmp_path / fx_lstm_xgb.ARTIFACT).write_text("{not json", encoding="utf-8")
    warnings = []
    out = fx_lstm_xgb.load(tmp_path, warnings.append)
    assert out["active"] is False and "읽기 실패" in out["reason"] and warnings
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / fx_lstm_xgb.ARTIFACT).write_text(json.dumps(_artifact()), encoding="utf-8")
    (tmp_path / fx_lstm_xgb.ARTIFACT).write_text(json.dumps(_artifact()), encoding="utf-8")
    warnings.clear()
    out = fx_lstm_xgb.load(tmp_path, warnings.append)
    assert out["active"] is True and any("2개" in w for w in warnings)


def test_runner_artifact_round_trips_through_the_loader(tmp_path, monkeypatch):
    """러너 build_artifact → 로더 validate 가 같은 계약을 말하는지(합성 행)."""
    monkeypatch.setattr(runner, "fit_predict_xgb", lambda tx, ty, x, s: float(x[0] + 1000))
    monkeypatch.setattr(runner, "fit_predict_lstm", lambda tx, ty, sq, **kw: float(sq[-1][0] + 1000))
    n = 30
    idx = pd.date_range("2020-01-31", periods=n, freq="BME")
    feature = pd.DataFrame({name: np.arange(n, dtype=float) for name in runner.FEATURES}, index=idx)
    feature["spot"] = 1000 + np.arange(n, dtype=float)
    rows = runner.walk_forward(feature, lag=1, window=8, seq_len=6, hidden_size=1, num_layers=1,
                               epochs=1, lr=1e-3, seed=1)

    class Args:
        seed, replicate_notebook, ns_fill, arma_window, bop_lag = 1, False, "ffill", 36, 2
        hidden_size, num_layers, seq_len, epochs, lr = 32, 1, 6, 100, 1e-3

    combo = {"key": "l1_w8", "lag": 1, "window": 8, "n": len(rows),
             "t_base": [runner.epoch(r["t_base"]) for r in rows], "t_target": [runner.epoch(r["t_target"]) for r in rows],
             "base": [r["base"] for r in rows], "actual": [r["actual"] for r in rows],
             "pred": {m: [r[m] for r in rows] for m in runner.MODELS}, "summary": runner.summarize(rows)}
    doc = runner.build_artifact([combo], info={"n_feature_rows": n}, args=Args, lags=[1], windows=[8])
    clean, error = fx_lstm_xgb.validate(json.loads(json.dumps(doc)))
    assert error is None and clean["active"] and clean["combos"][0]["n_realized"] == len(rows) - 1
    assert clean["model"]["bop_lag_months"] == 2 and clean["runner"]["label_alignment"] == "realized_by_base_date"
