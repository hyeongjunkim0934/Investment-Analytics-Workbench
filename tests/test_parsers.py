# -*- coding: utf-8 -*-
"""파서 스모크 — 합성 워크북 3종이 문서대로 시리즈/키가 되는지."""

from __future__ import annotations

import shutil

import pandas as pd
import pytest

import process
import synth


def test_series_count_and_files(parsed):
    """파싱 시리즈 수 = 스펙 길이의 합, 파일 5개. 중복 컬럼은 세지 않는다."""
    report, P = parsed
    assert len(report) == 5
    expected = (len(synth.BB_SPEC) + len(synth.INFO_SPEC)
                + 1                       # idx:ACWI
                + len(synth.BREADTH_KEYS)   # 데일리 리포트 집계 지표
                + len(synth.BM_KEYS))       # 자산군 전략 벤치마크
    assert len(P.SERIES) == expected
    kinds = {r["kind"] for r in report}
    assert kinds == {"bloomberg-wide", "infomax-wide", "index:ACWI",
                     "us-breadth", "benchmark"}


def test_key_prefixes_follow_filename(parsed):
    """키 접두사는 파서가 정한다.

    `data_bb*`/`data_info*`/`bm*` 는 **파일명**으로, 데일리 리포트(`us:`)는 **시트
    이름**으로, 나머지는 지수 익스포트(`idx:`)로 간다 — 리포트만 내용 판정인 이유는
    그 파일이 날짜가 박힌 이름으로 배포되기 때문이다(`pipeline/breadth.py` 참조).
    BM 파일도 날짜 박힌 이름이지만 사용자가 의도적으로 올리는 파일이라 접두사를
    통제할 수 있다(`pipeline/bm.py` docstring).
    """
    _, P = parsed
    for k in synth.ALL_KEYS:
        assert k in P.SERIES, f"missing {k}"
    assert all(k.split(":", 1)[0] in ("bb", "info", "idx", "us", "bm")
               for k in P.SERIES)


def test_stock_report_publishes_aggregates_only(parsed):
    """데일리 리포트에서 온 시리즈는 전부 집계이고, 관측일은 본문 날짜다.

    공개 저장소이므로 종목 단위가 섞이면 안 된다 — 파서 쪽 계약은
    `tests/test_breadth.py` 가 지키고, 여기서는 **파이프라인을 통과한 뒤에도**
    `us:` 키가 선언된 집계 지표뿐인지 본다.
    """
    _, P = parsed
    us = {k: v for k, v in P.SERIES.items() if k.startswith("us:")}
    assert us, "데일리 리포트에서 온 시리즈가 없다"
    assert set(us) == set(synth.BREADTH_KEYS), sorted(us)
    for k, entry in us.items():
        assert entry["source"] == "kiwoom" and entry["category"] == "US Breadth"
        assert len(entry["s"]) == 1, f"{k}: 파일 하나 = 관측 하루여야 한다"


def test_key_suffix_is_verbatim_header(parsed):
    """키 뒷부분은 엑셀 헤더 문자열 그대로 — 한글·`&`·`_` 를 정규화하지 않는다."""
    _, P = parsed
    assert "bb:미국_S&P500_TR" in P.SERIES
    assert "bb:한국_CDS_5년물" in P.SERIES
    assert "info:Card_AA_plus_3y" in P.SERIES


def test_duplicate_notation_warns_and_keeps_first(parsed):
    """같은 시트에 같은 Notation 이 두 번이면 두 번째는 경고 후 버려진다."""
    _, P = parsed
    dups = [w for w in P.WARNINGS if "duplicate column" in w]
    assert len(dups) == 1 and "달러원" in dups[0]
    s = P.SERIES["bb:달러원"]["s"]
    assert len(s) == len(synth.bdays())
    # 채택된 것은 **첫** 컬럼 — 두 번째 컬럼의 센티넬 값은 어디에도 없어야 한다
    assert not (s == synth.DUP_SENTINEL).any()


def test_index_key_is_first_token_of_a1(tmp_path):
    """지수 파일 키는 파일명이 아니라 A1 첫 공백 앞 토큰이다."""
    synth.write_index(tmp_path / "whatever_name.xlsx", a1="MYIDX  some label")
    name, pairs = process.parse_index_export(tmp_path / "whatever_name.xlsx")
    assert name == "MYIDX"
    assert len(pairs) > 0


def test_index_merge_later_end_date_wins(tmp_path):
    """같은 지수명 파일 2개 -> 병합, 겹치는 날짜는 종료일이 늦은 쪽이 이긴다."""
    synth.write_index(tmp_path / "ACWI_old.xlsx", start="2003-01-01", end="2015-12-31",
                      level=100.0, seed_offset=1)
    synth.write_index(tmp_path / "ACWI_new.xlsx", start="2010-01-01", end="2020-12-31",
                      level=200.0, seed_offset=2)
    process.load_data_dir(tmp_path)
    s = process.SERIES["idx:ACWI"]["s"]
    assert s.index[0] == pd.Timestamp("2003-01-01")
    assert s.index[-1] == pd.Timestamp("2020-12-31")
    # 겹치는 구간(2010~2015)의 값은 '새' 파일에서 왔어야 한다
    _, newpairs = process.parse_index_export(tmp_path / "ACWI_new.xlsx")
    newmap = dict(newpairs)
    probe = pd.Timestamp("2012-06-15")
    assert probe in newmap and s.loc[probe] == pytest.approx(newmap[probe])


def test_xlsm_and_case_insensitive_extension(tmp_path, synth_dir):
    """.xlsm 과 대문자 확장자도 같은 접두사 규칙으로 파싱된다."""
    shutil.copy(synth_dir / "data_bb_synth.xlsx", tmp_path / "DATA_BB_UPPER.XLSX")
    shutil.copy(synth_dir / "data_info_synth.xlsx", tmp_path / "data_info_two.xlsm")
    report = process.load_data_dir(tmp_path)
    kinds = sorted(r["kind"] for r in report)
    assert kinds == ["bloomberg-wide", "infomax-wide"]
    assert "bb:달러원" in process.SERIES and "info:VIX" in process.SERIES


def test_lock_files_ignored_and_xls_warns(tmp_path, synth_dir):
    """`~$` 잠금 파일은 무시, `.xls` 는 경고만 남기고 스킵."""
    shutil.copy(synth_dir / "data_bb_synth.xlsx", tmp_path / "data_bb_synth.xlsx")
    shutil.copy(synth_dir / "data_bb_synth.xlsx", tmp_path / "~$data_bb_synth.xlsx")
    (tmp_path / "legacy.xls").write_bytes(b"not really an xls")
    report = process.load_data_dir(tmp_path)
    files = {r["file"]: r["kind"] for r in report}
    assert "~$data_bb_synth.xlsx" not in files
    assert files["legacy.xls"] == "skipped-xls"
    assert any(".xls" in w for w in process.WARNINGS)


def test_recursive_discovery(tmp_path, synth_dir):
    """탐색은 저장소 전체 재귀 — raw/ 밖 어느 깊이에 있어도 읽힌다."""
    deep = tmp_path / "a" / "b" / "c"
    deep.mkdir(parents=True)
    shutil.copy(synth_dir / "data_bb_synth.xlsx", deep / "data_bb_synth.xlsx")
    report = process.load_data_dir(tmp_path)
    assert len(report) == 1 and report[0]["kind"] == "bloomberg-wide"


def test_no_xlsx_exits_1(tmp_path):
    """xlsx 가 하나도 없으면 즉시 exit 1 (--out 은 만들어지지도 않는다)."""
    (tmp_path / "readme.md").write_text("nothing here")
    with pytest.raises(SystemExit) as e:
        process.load_data_dir(tmp_path)
    assert e.value.code == 1


def test_get_missing_key_warns_and_returns_none(parsed):
    """없는 키는 경고 후 None — 패널 빌더는 그 항목만 조용히 건너뛴다."""
    _, P = parsed
    before = len(P.WARNINGS)
    assert P.get("bb:존재하지_않는_시리즈") is None
    assert len(P.WARNINGS) == before + 1
    assert "series not found" in P.WARNINGS[-1]
