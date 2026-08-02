# -*- coding: utf-8 -*-
"""출력 JSON 계약 + 배포 게이트.

여기서 지키는 계약: `process.py` 의 `payloads` = `dashboard/app.js` 의 `FILES`
= `pipeline/check_output.py` 의 `EXPECTED` = **같은 14개**. 셋 중 하나만 고치면
대시보드의 한 섹션이 조용히 사라진다.

개수 assert 는 교차 대조와 별개로 남겨 둔다 — 세 곳을 일관되게 고치면 교차 대조는
통과하므로, 계약 크기가 바뀌었다는 사실 자체를 사람이 의식하게 만드는 것이 목적이다.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

import check_output
import process

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "pipeline" / "check_output.py"
APP_JS = ROOT / "dashboard" / "app.js"


# --------------------------------------------------------------------------
# 세 곳의 목록이 같은가
# --------------------------------------------------------------------------

def _app_js_files() -> list[str]:
    m = re.search(r"FILES\s*=\s*\[(.*?)\]", APP_JS.read_text(encoding="utf-8"), re.S)
    assert m, "dashboard/app.js 에서 FILES 상수를 찾지 못했습니다"
    return re.findall(r'["\']([A-Za-z_]+)["\']', m.group(1))


def test_contract_is_fifteen():
    assert len(check_output.EXPECTED) == 15
    assert len(set(check_output.EXPECTED)) == 15


def test_app_js_files_match_contract():
    assert sorted(_app_js_files()) == sorted(check_output.EXPECTED)


def test_process_payload_keys_match_contract():
    """process.py 소스의 payloads 키를 실제로 읽어 계약과 대조한다."""
    src = (ROOT / "pipeline" / "process.py").read_text(encoding="utf-8")
    names = set(re.findall(r'payloads\[["\']([a-z]+)\.json["\']\]', src))
    names |= set(re.findall(r'["\']([a-z]+)\.json["\']\s*:', src))
    assert names == set(check_output.EXPECTED), (
        f"only-in-process={sorted(names - set(check_output.EXPECTED))} "
        f"only-in-contract={sorted(set(check_output.EXPECTED) - names)}")


# --------------------------------------------------------------------------
# 합성 데이터로 파이프라인 완주
# --------------------------------------------------------------------------

@pytest.fixture(scope="session")
def built(synth_dir, tmp_path_factory):
    """합성 워크북으로 process.py 를 통째로 돌린 산출물 디렉터리."""
    out = tmp_path_factory.mktemp("built") / "data"
    r = subprocess.run(
        [sys.executable, str(ROOT / "pipeline" / "process.py"),
         "--data-dir", str(synth_dir), "--out", str(out)],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-4000:]
    return out, r


def test_pipeline_writes_exactly_fifteen(built):
    out, r = built
    written = sorted(p.stem for p in out.glob("*.json"))
    assert written == sorted(check_output.EXPECTED), r.stdout[-2000:]
    assert r.stdout.count("wrote ") == 15


def test_risk_and_hedge_actually_ran(built):
    """risk/hedge 는 try/except 로 격리돼 있다 — 실패하면 조용히 빠진다.

    합성 픽스처는 두 모듈이 필요한 키를 전부 갖고 있으므로, 여기서 빠지면
    격리가 아니라 회귀다.
    """
    out, r = built
    assert (out / "risk.json").exists() and (out / "events.json").exists()
    assert (out / "hedge.json").exists()
    assert "계산 실패" not in r.stderr
    risk = json.loads((out / "risk.json").read_text(encoding="utf-8"))
    assert risk, "risk.json 이 비어 있습니다"


def test_alloc_publishes_covariance_not_returns(built):
    """alloc.json 공개 범위: 원천 공분산·평균·분위수만 — 원본 수익률 시계열 금지.

    수치 리스트 길이가 원천 개수(10)·격자(21)를 넘으면 시계열이 샌 것이다.
    """
    out, _ = built
    A = json.loads((out / "alloc.json").read_text(encoding="utf-8"))
    for top in ["sources", "sets", "rates", "cost_options", "anchor_ref",
                "defaults", "boot", "checks", "acct_model", "limits"]:
        assert top in A, f"alloc.json 필수 키 없음 — {top}"
    n_src = len(A["sources"]["labels"])
    assert n_src == 10

    def walk(o, path="alloc"):
        if isinstance(o, list):
            if o and all(isinstance(x, (int, float)) for x in o):
                assert len(o) <= max(n_src, 25), f"{path}: 수치 배열 길이 {len(o)} — 시계열 유출 의심"
            for i, v in enumerate(o):
                walk(v, f"{path}[{i}]")
        elif isinstance(o, dict):
            assert "t" not in o or not isinstance(o.get("t"), list), f"{path}: 시계열 페이로드 금지"
            for k, v in o.items():
                walk(v, f"{path}.{k}")
    walk(A)

    for s in A["sets"]:
        C = s["cov"]
        assert len(C) == n_src and all(len(row) == n_src for row in C)
        for i in range(n_src):
            assert C[i][i] >= 0
            for j in range(n_src):
                assert abs(C[i][j] - C[j][i]) < 1e-12, "공분산 비대칭"
        assert s["n_months"] >= 60


def test_catalog_has_metadata_only(built):
    """카탈로그는 값 없이 메타데이터만 (공개 범위 규약)."""
    out, _ = built
    cat = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
    assert cat["series"], "카탈로그가 비었습니다"
    for row in cat["series"]:
        assert set(row) == {"key", "source", "category", "name", "first", "last", "n"}


def test_meta_fields_present(built):
    out, _ = built
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    for f in check_output.META_FIELDS:
        assert f in meta
    assert meta["series_count"] == len(json.loads(
        (out / "catalog.json").read_text(encoding="utf-8"))["series"])


def test_timeseries_payload_shape(built):
    """모든 {"t":[...], "v":[...]} 에서 길이가 같고 t 는 단조 증가."""
    out, _ = built
    seen = 0
    for p in out.glob("*.json"):
        obj = json.loads(p.read_text(encoding="utf-8"))
        stack = [obj]
        while stack:
            o = stack.pop()
            if isinstance(o, dict):
                if isinstance(o.get("t"), list) and isinstance(o.get("v"), list):
                    seen += 1
                    assert len(o["t"]) == len(o["v"]), p.name
                    assert o["t"] == sorted(o["t"]), p.name
                stack.extend(o.values())
            elif isinstance(o, list):
                stack.extend(o)
    assert seen > 20, f"시계열 페이로드가 {seen}개뿐입니다"


def test_too_few_series_exits_1(tmp_path, synth_dir):
    """시리즈 10개 미만이면 JSON 을 쓰지 않고 exit 1 (망가진 업로드 가드)."""
    import synth
    tiny = tmp_path / "tiny"
    tiny.mkdir()
    synth.write_wide(tiny / "data_bb_tiny.xlsx", synth.BB_SPEC[:3])
    out = tmp_path / "out"
    r = subprocess.run(
        [sys.executable, str(ROOT / "pipeline" / "process.py"),
         "--data-dir", str(tiny), "--out", str(out)],
        capture_output=True, text=True)
    assert r.returncode == 1
    assert "too few series parsed" in r.stderr
    assert not out.exists(), "가드가 걸렸는데 --out 디렉터리가 만들어졌습니다"


# --------------------------------------------------------------------------
# 배포 게이트 — 통과 케이스와 **실패 케이스**
# --------------------------------------------------------------------------

def _gate(out: Path, *extra) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GATE), "--out", str(out),
         "--max-warnings", "200", "--min-series", "30", *extra],
        capture_output=True, text=True)


def test_gate_passes_on_good_build(built):
    out, _ = built
    r = _gate(out, "--dashboard", str(APP_JS))
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.parametrize("victim", ["hedge", "risk", "events", "macro", "alloc"])
def test_gate_blocks_when_a_json_is_missing(built, tmp_path, victim):
    """게이트의 존재 이유: risk/hedge 가 죽어 JSON 이 빠진 채 배포되는 것을 막는다."""
    out, _ = built
    broken = tmp_path / "broken"
    broken.mkdir()
    for p in out.glob("*.json"):
        if p.stem != victim:
            (broken / p.name).write_bytes(p.read_bytes())
    r = _gate(broken)
    assert r.returncode == 1
    assert victim in r.stderr


def test_gate_blocks_extra_json(built, tmp_path):
    out, _ = built
    d = tmp_path / "extra"
    d.mkdir()
    for p in out.glob("*.json"):
        (d / p.name).write_bytes(p.read_bytes())
    (d / "surprise.json").write_text("{}")
    r = _gate(d)
    assert r.returncode == 1 and "surprise" in r.stderr


def test_gate_blocks_warning_count_over_cap(built, tmp_path):
    """경고 수는 **상한**으로만 본다 — 등호로 박으면 데이터 갱신마다 깨진다."""
    out, _ = built
    d = tmp_path / "warned"
    d.mkdir()
    for p in out.glob("*.json"):
        (d / p.name).write_bytes(p.read_bytes())
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    base = len(meta["warnings"])
    meta["warnings"] = [f"w{i}" for i in range(base + 5)]
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    over = subprocess.run(
        [sys.executable, str(GATE), "--out", str(d),
         "--max-warnings", str(base + 4), "--min-series", "30"],
        capture_output=True, text=True)
    assert over.returncode == 1 and "상한" in over.stderr
    under = subprocess.run(
        [sys.executable, str(GATE), "--out", str(d),
         "--max-warnings", str(base + 5), "--min-series", "30"],
        capture_output=True, text=True)
    assert under.returncode == 0, under.stdout + under.stderr


def test_gate_blocks_series_floor(built, tmp_path):
    out, _ = built
    d = tmp_path / "thin"
    d.mkdir()
    for p in out.glob("*.json"):
        (d / p.name).write_bytes(p.read_bytes())
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    meta["series_count"] = 5
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    r = _gate(d)
    assert r.returncode == 1 and "바닥" in r.stderr


def test_gate_blocks_corrupt_json(built, tmp_path):
    out, _ = built
    d = tmp_path / "corrupt"
    d.mkdir()
    for p in out.glob("*.json"):
        (d / p.name).write_bytes(p.read_bytes())
    (d / "macro.json").write_text('{"broken": ')
    r = _gate(d)
    assert r.returncode == 1 and "파싱 실패" in r.stderr


def test_gate_blocks_values_in_catalog(built, tmp_path):
    """카탈로그에 값이 실리면 배포를 막는다 — 공개 범위 사고 방지."""
    out, _ = built
    d = tmp_path / "leaky"
    d.mkdir()
    for p in out.glob("*.json"):
        (d / p.name).write_bytes(p.read_bytes())
    cat = json.loads((d / "catalog.json").read_text(encoding="utf-8"))
    cat["series"][0]["v"] = [1.0, 2.0]
    cat["series"][0]["t"] = [0, 1]
    (d / "catalog.json").write_text(json.dumps(cat, ensure_ascii=False), encoding="utf-8")
    r = _gate(d)
    assert r.returncode == 1 and "카탈로그" in r.stderr


def test_gate_blocks_missing_out_dir(tmp_path):
    r = _gate(tmp_path / "nope")
    assert r.returncode == 1


def test_gate_blocks_app_js_drift(built, tmp_path):
    out, _ = built
    fake = tmp_path / "app.js"
    fake.write_text(APP_JS.read_text(encoding="utf-8")
                    .replace('"macro", "catalog"', '"macro", "catalog", "ghost"'),
                    encoding="utf-8")
    r = _gate(out, "--dashboard", str(fake))
    assert r.returncode == 1 and "ghost" in r.stderr


def test_gate_uses_stdlib_only():
    """게이트는 의존성 설치가 깨진 상황에서도 돌아야 한다."""
    src = GATE.read_text(encoding="utf-8")
    for banned in ("import pandas", "import numpy", "import openpyxl",
                   "import process", "import risk", "import hedge"):
        assert banned not in src, banned


def test_process_globals_are_not_leaked_by_tests():
    """conftest 의 autouse 픽스처가 모듈 전역을 비우는지 (테스트 간 오염 방지)."""
    assert process.SERIES == {} and process.WARNINGS == []
