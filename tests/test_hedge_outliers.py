"""국채 메리트 차트의 3σ 처리 계약. 모든 입력은 이 파일의 합성자료다."""

import statistics

import numpy as np
import pandas as pd
import pytest

import hedge


def _daily(n=80):
    return pd.DataFrame({"foreign": 2.0, "ktb": 3.0, "cost": 0.0},
                        index=pd.bdate_range("2030-01-07", periods=n))


def _assert_policy(meta, n):
    assert meta["policy"] == "full_sample_level_zscore"
    assert meta["threshold"] == 3.0
    assert meta["ddof"] == 1
    assert meta["scope"] == "chart_only"
    assert meta["n_observations"] == n


@pytest.mark.parametrize("sign", [1, -1])
def test_isolated_positive_and_negative_spikes_use_original_neighbor_mean(sign):
    daily = _daily()
    # Friday -> Monday continuity must permit the Friday spike to be repaired.
    i = 24
    assert daily.index[i].dayofweek == 4
    daily.iloc[i - 1, 2], daily.iloc[i, 2], daily.iloc[i + 1, 2] = 1., sign * 100., 3.
    original = daily.copy(deep=True)
    cleaned, meta = hedge.clean_merit_daily(daily)
    assert cleaned.loc[daily.index[i], "cost"] == 2.0
    expected = original.copy()
    expected.loc[daily.index[i], "cost"] = 2.0
    pd.testing.assert_frame_equal(cleaned, expected)
    pd.testing.assert_frame_equal(daily, original)
    _assert_policy(meta, len(daily))
    assert meta["n_rows_excluded"] == 0
    assert meta["columns"]["cost"] == {"n_flagged": 1, "n_replaced": 1, "n_excluded": 0}
    assert meta["columns"]["foreign"]["n_flagged"] == 0


@pytest.mark.parametrize("amplitude,flagged", [(3.0, 2), (2.999999, 0)])
def test_absolute_z_exactly_three_is_included_and_just_below_is_not(amplitude, flagged):
    daily = _daily(21)
    # Sum=0, sum of squares=20 at amplitude=3, hence sample σ=1 exactly.
    daily.loc[daily.index[[2, 5, 15, 18]], "cost"] = [1., amplitude, -amplitude, -1.]
    assert statistics.stdev(daily["cost"]) == pytest.approx(
        np.sqrt((2 * amplitude ** 2 + 2) / 20))
    cleaned, meta = hedge.clean_merit_daily(daily)
    assert meta["columns"]["cost"]["n_flagged"] == flagged
    assert cleaned.loc[daily.index[5], "cost"] == (0. if flagged else amplitude)
    assert cleaned.loc[daily.index[15], "cost"] == (0. if flagged else -amplitude)


def test_sample_sigma_does_not_flag_population_sigma_boundary():
    daily = _daily(10)
    daily.iloc[4, 2] = 1.
    # Population σ gives Z=3; the required sample σ gives Z=9/sqrt(10)<3.
    assert (1 - statistics.mean(daily["cost"])) / statistics.pstdev(daily["cost"]) == pytest.approx(3.)
    cleaned, meta = hedge.clean_merit_daily(daily)
    pd.testing.assert_frame_equal(cleaned, daily)
    assert meta["columns"]["cost"]["n_flagged"] == 0


@pytest.mark.parametrize("n", [0, 1, 2, 20])
def test_short_or_constant_samples_are_preserved(n):
    daily = _daily(n)
    if n == 2:
        daily.iloc[-1, 2] = 1_000.
    cleaned, meta = hedge.clean_merit_daily(daily)
    pd.testing.assert_frame_equal(cleaned, daily)
    _assert_policy(meta, n)
    assert meta["n_rows_excluded"] == 0
    assert all(item["n_flagged"] == 0 for item in meta["columns"].values())


@pytest.mark.parametrize("positions", [[0], [79], [20, 21]])
def test_endpoints_and_adjacent_spikes_are_excluded_without_cascading_repair(positions):
    daily = _daily()
    bad_dates = daily.index[positions]
    daily.loc[bad_dates, "cost"] = 100.
    # The row counter counts excluded dates, not the number of bad cells.
    daily.loc[bad_dates, "foreign"] = -100.
    cleaned, meta = hedge.clean_merit_daily(daily)
    pd.testing.assert_frame_equal(cleaned, daily.drop(bad_dates))
    assert meta["n_rows_excluded"] == len(positions)
    for column in ("cost", "foreign"):
        assert meta["columns"][column] == {
            "n_flagged": len(positions), "n_replaced": 0, "n_excluded": len(positions)}


@pytest.mark.parametrize("missing_offset", [-1, 1])
def test_missing_weekday_on_either_side_prevents_interpolation(missing_offset):
    daily = _daily()
    bad_date = daily.index[22]
    daily.loc[bad_date, "cost"] = 100.
    daily = daily.drop(daily.index[22 + missing_offset])
    cleaned, meta = hedge.clean_merit_daily(daily)
    pd.testing.assert_frame_equal(cleaned, daily.drop(bad_date))
    assert meta["n_observations"] == 79
    assert meta["columns"]["cost"] == {"n_flagged": 1, "n_replaced": 0, "n_excluded": 1}


def test_flags_are_fixed_before_repairs_and_are_independent_for_each_column():
    daily = _daily()
    daily.iloc[20, 2] = 100.
    daily.iloc[21, 0] = 100.
    daily.iloc[50, 2] = 10.
    cleaned, meta = hedge.clean_merit_daily(daily)
    assert cleaned.loc[daily.index[20], "cost"] == 0.
    assert cleaned.loc[daily.index[21], "foreign"] == 2.
    assert cleaned.loc[daily.index[50], "cost"] == 10.
    # Re-detection after the first repair would incorrectly remove this value.
    z_after_repair = (10. - statistics.mean(cleaned["cost"])) / statistics.stdev(cleaned["cost"])
    assert z_after_repair > 3.
    assert meta["n_rows_excluded"] == 0
    assert meta["columns"]["cost"]["n_flagged"] == 1
    assert meta["columns"]["foreign"]["n_flagged"] == 1


def test_only_finite_complete_weekdays_define_the_sample_before_sorting():
    daily = _daily(21)
    invalid_dates = daily.index[[1, 10, 19]]
    daily.loc[invalid_dates[0], "foreign"] = np.nan
    daily.loc[invalid_dates[1], "ktb"] = np.inf
    daily.loc[invalid_dates[2], "cost"] = -np.inf
    weekend = pd.Timestamp("2030-01-12")
    daily.loc[weekend] = [1e8, 1e8, 1e8]
    daily = daily.iloc[::-1]
    original = daily.copy(deep=True)
    cleaned, meta = hedge.clean_merit_daily(daily)
    expected = daily.drop([*invalid_dates, weekend]).sort_index()
    pd.testing.assert_frame_equal(cleaned, expected)
    pd.testing.assert_frame_equal(daily, original)
    _assert_policy(meta, 18)
    assert all(item["n_flagged"] == 0 for item in meta["columns"].values())


def _assert_merit_identity(merit, bond_key):
    assert merit["active"]
    assert merit["n_weeks"] == len(merit["t"])
    assert merit["hedged"] == pytest.approx(np.array(merit[bond_key]) + merit["cost"])
    assert merit["spread"] == pytest.approx(np.array(merit["hedged"]) - merit["ktb"])
    for key in (bond_key, "ktb", "cost", "hedged", "spread"):
        assert merit["now"][key] == merit[key][-1]


@pytest.mark.parametrize("country,currency", [("JPY", "JPY"), ("AUD", "AUD"), ("GER", "EUR")])
def test_merit_filter_runs_before_weekly_selection_and_retains_actual_dates(country, currency):
    daily = _daily()
    daily["cost"] = 0.5
    daily.iloc[[24, 79], 2] = 100.
    sources = {f"info:{country}10y": daily["foreign"],
               "info:한국_10y": daily["ktb"],
               f"info:{currency}KRW_HP_3M": daily["cost"]}
    originals = {key: series.copy(deep=True) for key, series in sources.items()}
    merit = hedge.build_bond_merit(sources, country, country, hedge_currency=currency)
    _assert_merit_identity(merit, "foreign")
    assert merit["cost"] == [0.5] * merit["n_weeks"]
    assert merit["asof"] == daily.index[-2].strftime("%Y-%m-%d")
    assert pd.to_datetime(merit["t"][-1], unit="s") == daily.index[-2]
    assert merit["outlier_filter"]["columns"]["cost"] == {
        "n_flagged": 2, "n_replaced": 1, "n_excluded": 1}
    for key, original in originals.items():
        pd.testing.assert_series_equal(sources[key], original)


def test_pipeline_cleans_legacy_ust_and_all_countries_without_mutating_raw_costs(parsed):
    _, process = parsed
    # The parsed fixture itself is generated by tests/synth.py, never vendor data.
    dates = process.SERIES["info:한국_10y"]["s"].index[:-2]
    assert dates[-1].dayofweek == 2  # Wednesday keeps the legacy UST W-FRI contract visible.
    spike_date = dates[dates.dayofweek == 4][-2]
    synthetic = {"info:한국_10y": pd.Series(3., index=dates)}
    for country, spec in hedge.BOND_MERIT_SOURCES.items():
        synthetic[spec["bond"]] = pd.Series(4., index=dates)
        cost = pd.Series(-0.5, index=dates)
        cost.loc[[spike_date, dates[-1]]] = -100.
        synthetic[spec["cost"]] = cost
    for key, series in synthetic.items():
        process.SERIES[key] = {"s": series.copy(deep=True)}
    result = hedge.build(process.SERIES, lambda _: None)
    for country, merit in result["bond_merits"].items():
        _assert_merit_identity(merit, "bond")
        assert merit["cost"] == [-0.5] * merit["n_weeks"]
        assert merit["outlier_filter"]["columns"]["cost"] == {
            "n_flagged": 2, "n_replaced": 1, "n_excluded": 1}
        expected_asof = dates[-1] + pd.Timedelta(days=2) if country == "UST" else dates[-2]
        assert merit["asof"] == expected_asof.strftime("%Y-%m-%d")
    for legacy_key, country, bond_key in (("ust_merit", "UST", "ust"),
                                          ("jgb_merit", "JPY", "foreign"),
                                          ("agb_merit", "AUD", "foreign")):
        legacy, modern = result[legacy_key], result["bond_merits"][country]
        _assert_merit_identity(legacy, bond_key)
        assert legacy[bond_key] == modern["bond"]
        for key in ("t", "cost", "hedged", "spread", "asof", "outlier_filter"):
            assert legacy[key] == modern[key]
    for key, original in synthetic.items():
        pd.testing.assert_series_equal(process.SERIES[key]["s"], original)
