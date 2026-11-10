"""Independent calendar and sequence oracles for the FX B v2 horizon contract.

These tests exercise the real sequence builder.  Only the expensive estimators
are replaced, and their actual training arrays are checked against month keys.
"""

from pathlib import Path
import sys

import numpy as np
import pandas as pd
import pytest

import fx_lstm_xgb

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline" / "research"))
import fx_lstm_xgb_runner as runner  # noqa: E402


def _features(n=48):
    # Business month ends deliberately differ from canonical calendar month ends.
    dates = pd.date_range("2020-01-31", periods=n, freq="BME")
    data = {name: 10.0 * k + np.arange(n, dtype=float)
            for k, name in enumerate(runner.FEATURES)}
    data["spot"] = 1000.0 + 7.0 * np.arange(n, dtype=float)
    return pd.DataFrame(data, index=dates)


def _install_estimators(monkeypatch):
    seen = []

    def xgb(train_x, train_y, test_x, seed):
        seen.append({"train_x": train_x.copy(), "train_y": train_y.copy(),
                     "test_x": test_x.copy(), "seed": seed})
        return float(np.mean(train_y) + test_x[0] * 0.01)

    def lstm(train_x, train_y, seq_x, **kwargs):
        seen[-1]["seq_x"] = seq_x.copy()
        seen[-1]["lstm_seed"] = kwargs["seed"]
        # Exercise the actual builder even when torch is not installed in CI.
        sequence_x, sequence_y = runner.make_sequences(train_x, train_y, kwargs["seq_len"])
        seen[-1]["sequence_x"] = sequence_x
        seen[-1]["sequence_y"] = sequence_y
        return float(np.mean(sequence_y) + seq_x[-1, 0] * 0.01)

    monkeypatch.setattr(runner, "fit_predict_xgb", xgb)
    monkeypatch.setattr(runner, "fit_predict_lstm", lstm)
    return seen


def _run(frame, **overrides):
    kwargs = dict(lag=3, window=8, seq_len=3, hidden_size=1, num_layers=1,
                  epochs=1, lr=0.001, seed=47)
    kwargs.update(overrides)
    return runner.walk_forward(frame, **kwargs)


def _month_end(period):
    return period.to_timestamp(how="end").normalize()


@pytest.mark.parametrize("length, seq_len, lag", [(8, 1, 1), (8, 3, 3), (12, 6, 12)])
def test_sequence_label_belongs_to_last_input_origin(length, seq_len, lag):
    origin = np.arange(length)
    features = np.column_stack([origin, origin * 10])
    targets = 1000 + origin + lag
    actual_x, actual_y = runner.make_sequences(features, targets, seq_len)

    endpoints = np.arange(seq_len - 1, length)
    assert actual_x.shape == (length - seq_len + 1, seq_len, 2)
    np.testing.assert_array_equal(actual_x[:, -1, 0], endpoints)
    np.testing.assert_array_equal(actual_y, 1000 + endpoints + lag)
    np.testing.assert_array_equal(actual_y - 1000 - actual_x[:, -1, 0], lag)


def test_walk_forward_matches_independent_calendar_training_oracle(monkeypatch):
    frame = _features()
    indexed = frame.copy()
    indexed.index = indexed.index.to_period("M")
    seen = _install_estimators(monkeypatch)
    rows = _run(frame)

    assert rows
    assert len(seen) == len(rows)
    for row, call in zip(rows, seen):
        origin = row["t_base"].to_period("M")
        target = origin + 3
        assert row["t_base"] == _month_end(origin)
        assert row["t_target"] == _month_end(target)
        train_months = pd.period_range(origin - 10, origin - 3, freq="M")
        target_months = train_months + 3
        sequence_months = pd.period_range(origin - 2, origin, freq="M")
        np.testing.assert_array_equal(call["train_x"], indexed.loc[train_months, runner.FEATURES])
        np.testing.assert_array_equal(call["train_y"], indexed.loc[target_months, "spot"])
        np.testing.assert_array_equal(call["seq_x"], indexed.loc[sequence_months, runner.FEATURES])
        # The latest realized training target is exactly the current origin.
        assert call["train_y"][-1] == row["base"]
        assert row["actual"] == (float(indexed.loc[target, "spot"]) if target in indexed.index else None)


def test_missing_calendar_month_never_compresses_training_or_horizon(monkeypatch):
    frame = _features(60)
    missing = frame.index[23].to_period("M")
    frame = frame.drop(frame.index[23])
    seen = _install_estimators(monkeypatch)
    rows = _run(frame)
    assert rows
    origins = {row["t_base"].to_period("M") for row in rows}
    # Recovery after the gap must occur; rejecting the entire sample is not a fix.
    assert frame.index[-1].to_period("M") in origins
    for row, call in zip(rows, seen):
        origin = row["t_base"].to_period("M")
        assert row["t_target"].to_period("M") == origin + 3
        train = pd.period_range(origin - 10, origin - 3, freq="M")
        sequence = pd.period_range(origin - 2, origin, freq="M")
        assert missing not in train
        assert missing not in train + 3
        assert missing not in sequence
        # First feature encodes the underlying calendar position, not retained row count.
        np.testing.assert_array_equal(np.diff(call["train_x"][:, 0]), np.full(7, 7.0))
        np.testing.assert_array_equal(np.diff(call["seq_x"][:, 0]), np.full(2, 7.0))


def test_target_spot_survives_missing_non_spot_features(monkeypatch):
    frame = _features(42)
    missing_date = frame.index[23]
    target_month = missing_date.to_period("M")
    expected_spot = float(frame.loc[missing_date, "spot"])
    frame.loc[missing_date, runner.FEATURES[1:]] = np.nan
    _install_estimators(monkeypatch)
    rows = _run(frame)
    row = next(row for row in rows if row["t_base"].to_period("M") == target_month - 3)
    assert row["t_target"] == _month_end(target_month)
    assert row["actual"] == expected_spot
    assert all(row["t_base"].to_period("M") != target_month for row in rows)


def test_future_feature_perturbations_do_not_change_prior_predictions(monkeypatch):
    original = _features(50)
    cutoff = original.index[30].to_period("M")
    changed = original.copy()
    changed.loc[changed.index.to_period("M") > cutoff] += 777.0
    _install_estimators(monkeypatch)
    baseline = _run(original)
    perturbed = _run(changed)
    prefix_only = _run(original.loc[original.index.to_period("M") <= cutoff])
    keys = ("t_base", "t_target", "base", "xgb", "lstm", "ensemble")

    def historical(rows):
        return [{key: row[key] for key in keys} for row in rows
                if row["t_base"].to_period("M") <= cutoff]

    assert historical(baseline)
    assert historical(baseline) == historical(perturbed) == historical(prefix_only)


def test_notebook_lookahead_mode_is_rejected_before_fitting(monkeypatch):
    seen = _install_estimators(monkeypatch)
    with pytest.raises(ValueError):
        _run(_features(), replicate_notebook=True)
    assert seen == []


def _artifact_v2():
    """Independent minimal publication fixture, including a missing realized quote."""
    def stamp(date):
        return int(pd.Timestamp(date, tz="UTC").timestamp())

    return {
        "schema": "fx_lstm_xgb/2", "generated_at": "2026-11-10T00:00:00Z",
        "runner": {"version": "2", "seed": 47, "replicate_notebook": False,
                   "label_alignment": "calendar_month_target_realized_by_base_date",
                   "sequence_alignment": "last_input_month_matches_label_origin",
                   "horizon_unit": "calendar_month", "train_window": "consecutive_calendar_origin_months"},
        "model": {"name": "lstm_xgb_walk_forward", "target": "spot", "unit": "KRW/USD",
                  "frequency": "monthly", "features": ["spot"], "ns": {"fill": "ffill"},
                  "bop_lag_months": 2, "lstm": {"seq_len": 6}},
        "data": {"table": {"end": "2021-06-30"},
                 "feature_start": "2020-01-31", "feature_end": "2021-06-30"},
        "grid": {"lags": [3], "windows": [24]},
        "regime_defaults": {"low_below": 1100.0, "high_above": 1300.0},
        "combos": [{"key": "l3_w24", "lag": 3, "window": 24,
                    "t_base": [stamp(d) for d in ("2021-01-31", "2021-02-28", "2021-03-31")],
                    "t_target": [stamp(d) for d in ("2021-04-30", "2021-05-31", "2021-06-30")],
                    "base": [1000.0, 1010.0, 1020.0], "actual": [1100.0, None, 1200.0],
                    "pred": {"xgb": [1050.0, 1060.0, 1070.0], "lstm": [1070.0, 1080.0, 1090.0],
                             "ensemble": [1060.0, 1070.0, 1080.0]}}],
    }


def test_v2_loader_accepts_exact_calendar_horizons_with_missing_actual_quote():
    clean, error = fx_lstm_xgb.validate(_artifact_v2())
    assert error is None
    assert clean["active"] is True
    assert clean["runner"]["sequence_alignment"] == "last_input_month_matches_label_origin"
    assert clean["combos"][0]["actual"] == [1100.0, None, 1200.0]
    assert clean["combos"][0]["n_realized"] == 2


@pytest.mark.parametrize("mutation", [
    lambda doc: doc.update(schema="fx_lstm_xgb/1"),
    lambda doc: doc["runner"].update(replicate_notebook=True),
    lambda doc: doc["runner"].update(label_alignment="notebook_lookahead"),
    lambda doc: doc["runner"].update(sequence_alignment="next_input_origin"),
    lambda doc: doc["runner"].update(horizon_unit="row"),
    lambda doc: doc["runner"].update(train_window="last_available_rows"),
    lambda doc: doc["model"]["ns"].update(fill="interpolate"),
    lambda doc: doc["model"].update(bop_lag_months=0),
    lambda doc: doc["model"].update(bop_lag_months=1),
    lambda doc: doc["runner"].pop("sequence_alignment"),
])
def test_v2_loader_rejects_legacy_or_unsafe_provenance(mutation):
    doc = _artifact_v2()
    mutation(doc)
    clean, error = fx_lstm_xgb.validate(doc)
    assert clean is None
    assert isinstance(error, str) and error


def test_v2_loader_rejects_compressed_or_mislabeled_month_horizon():
    doc = _artifact_v2()
    # 2021-01 plus lag=3 must be April, not the next retained row in May.
    doc["combos"][0]["t_target"][0] = int(pd.Timestamp("2021-05-31", tz="UTC").timestamp())
    clean, error = fx_lstm_xgb.validate(doc)
    assert clean is None
    assert isinstance(error, str) and error


@pytest.mark.parametrize("cutoff", ["2021-05-31", "2021-01-31", "2021-06-29", None])
def test_v2_loader_rejects_data_cutoff_inconsistent_with_published_rows(cutoff):
    doc = _artifact_v2()
    doc["data"]["table"]["end"] = cutoff
    clean, error = fx_lstm_xgb.validate(doc)
    assert clean is None
    assert isinstance(error, str) and error


def test_v2_loader_recomputes_metrics_from_shared_realized_rows():
    doc = _artifact_v2()
    doc["combos"][0]["summary"] = {name: {"n": 300, "rmse": 0.0, "theil_u": 0.0}
                                       for name in ("xgb", "lstm", "ensemble", "rw")}
    clean, error = fx_lstm_xgb.validate(doc)
    assert error is None
    metrics = clean["combos"][0]["summary"]
    expected_rw_rmse = np.sqrt((100.0 ** 2 + 180.0 ** 2) / 2)
    expected_xgb_rmse = np.sqrt((50.0 ** 2 + 130.0 ** 2) / 2)
    expected_ensemble_rmse = np.sqrt((40.0 ** 2 + 120.0 ** 2) / 2)
    assert metrics["xgb"]["n"] == metrics["lstm"]["n"] == metrics["rw"]["n"] == 2
    assert metrics["rw"]["rmse"] == pytest.approx(expected_rw_rmse)
    assert metrics["xgb"]["rmse"] == pytest.approx(expected_xgb_rmse)
    assert metrics["xgb"]["theil_u"] == pytest.approx(expected_xgb_rmse / expected_rw_rmse)
    assert metrics["ensemble"]["rmse"] == pytest.approx(expected_ensemble_rmse)
    assert metrics["ensemble"]["bias"] == pytest.approx(-80.0)
    assert metrics["rw"]["hit_rate"] is None
