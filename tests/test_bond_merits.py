# -*- coding: utf-8 -*-
"""4개국 국채 메리트: EUR/GER 출처 매핑과 기존 JSON 호환 계약."""
import copy
import json

import pandas as pd
import pytest

import hedge


def _sources():
    dates = pd.to_datetime(["2026-09-11", "2026-09-16"])
    vals = {"info:한국_10y": [3., 3.],
            "info:JPY10y": [1., 1.], "info:JPYKRW_HP_3M": [1.5, 2.5],
            "info:AUD10y": [5., 5.], "info:AUDKRW_HP_3M": [-3., -1.],
            "info:GER10y": [2., 2.], "info:EURKRW_HP_3M": [0.5, -1.5],
            # Distractors expose GER/EUR identifier or cost cross-wiring.
            "info:EUR10y": [99., 99.], "info:GERKRW_HP_3M": [88., 88.],
            "info:SMB_USDKRW_3M": [77., 77.]}
    return {key: pd.Series(values, index=dates) for key, values in vals.items()}


def _legacy_ust():
    # Existing UST timestamps and values are a pass-through contract.
    return {"active": True, "asof": "2026-09-18", "freq": "W-FRI",
            "start": "2026-09", "n_weeks": 2, "t": [1789084800, 1789689600],
            "ust": [4., 4.], "ktb": [3., 3.], "cost": [-1.5, 0.5],
            "hedged": [2.5, 4.5], "spread": [-0.5, 1.5],
            "series": {"ust": "미국채 10년", "ktb": "국고 10년", "cost": "SMB"},
            "now": {"ust": 4., "ktb": 3., "cost": 0.5, "hedged": 4.5,
                    "spread": 1.5, "spread_pctile": 100.}}


def test_four_merits_preserve_legacy_ust_and_use_german_yield_with_eur_carry():
    old = _legacy_ust()
    saved = copy.deepcopy(old)
    warnings = []
    got = hedge.build_bond_merits(_sources(), warnings.append, old)
    assert list(got) == ["UST", "JPY", "AUD", "GER"]
    expected = {"JPY": ([2.5, 3.5], [-0.5, 0.5]),
                "AUD": ([2., 4.], [-1., 1.]), "GER": ([2.5, 0.5], [-0.5, -2.5])}
    for code, (hedged, spread) in expected.items():
        m = got[code]
        assert m["hedged"] == hedged and m["spread"] == spread
        assert m["asof"] == "2026-09-16"
        assert m["now"]["spread"] == spread[-1]
    assert got["GER"]["currency"] == "EUR"
    assert got["GER"]["sources"]["cost"] == "info:EURKRW_HP_3M"
    assert got["GER"]["sources"]["bond"] == "info:GER10y"
    assert got["GER"]["series"]["bond"] == "독일 국채 10년"
    assert got["GER"]["now"]["spread_pctile"] == 50.
    assert got["UST"]["cost_source"] == "SMB"
    assert got["GER"]["cost_source"] == "HP 원호가"
    assert got["UST"]["bond"] == old["ust"]
    for key in ("t", "ktb", "cost", "hedged", "spread", "n_weeks", "asof"):
        assert got["UST"][key] == old[key]
    assert old == saved  # Renaming generic fields must not mutate the legacy object.
    assert not warnings


@pytest.mark.parametrize("case", ["missing", "nonfinite", "disjoint"])
def test_german_merit_requires_actual_eur_cost_without_currency_substitution(case):
    src = _sources()
    if case == "missing":
        del src["info:EURKRW_HP_3M"]
    elif case == "nonfinite":
        src["info:EURKRW_HP_3M"][:] = float("inf")
    else:
        src["info:EURKRW_HP_3M"].index += pd.Timedelta(days=30)
    warnings = []
    got = hedge.build_bond_merits(src, warnings.append, _legacy_ust())
    assert got["GER"]["active"] is False and got["GER"]["reason"]
    assert all(got[k]["active"] for k in ("UST", "JPY", "AUD"))
    assert len(warnings) == 1 and "GER" in warnings[0]
    json.dumps(got, allow_nan=False)


def test_bond_merits_pipeline_wiring_keeps_existing_payloads(parsed):
    _, process = parsed
    dates = process.SERIES["info:한국_10y"]["s"].index[-2:]
    for key, s in _sources().items():
        if key in ("info:한국_10y", "info:SMB_USDKRW_3M"):
            continue
        s.index = dates
        process.SERIES[key] = {"s": s}
    got = hedge.build(process.SERIES, lambda _: None)
    for legacy_key, code, value_key in (("ust_merit", "UST", "ust"),
                                       ("jgb_merit", "JPY", "foreign"),
                                       ("agb_merit", "AUD", "foreign")):
        old, new = got[legacy_key], got["bond_merits"][code]
        assert old["active"] and new["active"]
        assert old[value_key] == new["bond"]
        assert old["now"][value_key] == new["now"]["bond"]
        for key in ("t", "ktb", "cost", "hedged", "spread", "n_weeks", "asof"):
            assert old[key] == new[key]
    assert got["bond_merits"]["GER"]["active"]
