# -*- coding: utf-8 -*-
"""출력 JSON 계약 + 배포 게이트.

여기서 지키는 계약: `process.py` 의 `payloads` = `dashboard/app.js` 의 `FILES`
= `pipeline/check_output.py` 의 `EXPECTED` = **같은 15개**. 셋 중 하나만 고치면
대시보드의 한 섹션이 조용히 사라진다.

개수 assert 는 교차 대조와 별개로 남겨 둔다 — 세 곳을 일관되게 고치면 교차 대조는
통과하므로, 계약 크기가 바뀌었다는 사실 자체를 사람이 의식하게 만드는 것이 목적이다.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import check_output
import process
import risk

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


def test_alloc_sets_psd_and_boot_quantiles_monotone(built):
    """게시된 공분산은 전부 양반정치(PSD), 부트스트랩 분위수는 단조여야 한다.

    (대각·대칭 검사는 위에서 — 여기는 고유값을 직접 재계산한다. min_eig 필드가
    아니라 게시물 자체에서. spx02 세트는 ACWI 행·열이 0이라 고유값 0이 정상.)
    """
    import numpy as np
    out, _ = built
    A = json.loads((out / "alloc.json").read_text(encoding="utf-8"))
    for s in A["sets"]:
        C = np.array(s["cov"])
        eig = float(np.linalg.eigvalsh(C)[0])
        assert eig > -1e-8, f"{s['key']}: 비양반정치 (min eig {eig:.3g})"
    for r in A["boot"]["rows"]:
        for k in ["anchor", "d1", "d2", "xe_star"]:
            q = r[k]
            vals = [q["q05"], q["q25"], q["q50"], q["q75"], q["q95"]]
            assert vals == sorted(vals), f"boot {r['block_len']}/{k}: 분위수 비단조"
    # 최장 표본(spx02) — ACWI 를 뺀 S&P500 TR 전용 세트의 구조 계약
    sp = next((s for s in A["sets"] if s["key"] == "spx02"), None)
    assert sp is not None, "spx02 세트 없음"
    assert sp.get("proxy_only") == "spx"
    ia = A["sources"]["labels"].index("acwi")
    assert all(abs(v) < 1e-15 for v in sp["cov"][ia]), "spx02: acwi 행이 0 이 아님"
    assert all(abs(row[ia]) < 1e-15 for row in sp["cov"]), "spx02: acwi 열이 0 이 아님"
    full = next(s for s in A["sets"] if s["key"] == "full")
    assert sp["n_months"] >= full["n_months"], "spx02 는 공통 표본 이상이어야 한다"


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


# --------------------------------------------------------------------------
# 마을(홈) 내비게이션 계약 — 구역이 14개 섹션을 빠짐없이·중복 없이 덮는가.
# 지도 이미지는 글자가 없고 라벨을 코드가 얹으므로, 이 대응이 깨지면 화면에서
# 도달 불가능한 섹션이 조용히 생긴다. 사람 눈으로는 안 보이는 종류의 결함이다.
# --------------------------------------------------------------------------

def _app_js_raw() -> str:
    """주석까지 포함한 app.js 원문. **코드가 있는지** 보는 검사에는 쓰지 말 것."""
    return (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")


def _app_js() -> str:
    """주석을 걷어낸 app.js — 이 파일의 문자열 검사는 **전부** 이것을 쓴다.

    예전에는 이 함수가 원문을 돌려주고 `_strip_js_comments()` 를 **5개 중 2개**에만
    걸었다. 그 결과 `mountVillageVideo` 의 reduced-motion 가드를 지우고 주석만 남긴
    뮤테이션이 141개 전부 초록으로 통과했다 — 접근성 불변식이 실제로는 보호되지
    않고 있었다는 뜻이다. 기본값을 뒤집어 그 실수가 다시 나올 수 없게 한다.
    """
    return _strip_js_comments(_app_js_raw())


def _fn(name: str) -> str:
    """app.js 에서 함수 하나의 본문을 잘라 온다(주석 제거 후).

    같은 `split("function X")[1].split("\nfunction ")[0]` 관용구가 여덟 군데에
    복사돼 있었고, 그중 일부만 주석을 걷었다 — 한 곳으로 모아 그 갈림을 없앤다.
    """
    js = _app_js()
    # 이름 뒤에 `(` 를 요구한다 — 없으면 `renderAll` 이 `renderAlloc` 에 먼저 걸려
    # **엉뚱한 함수 본문**을 조용히 돌려준다(실제로 한 번 그랬다).
    m = re.search(rf"function {re.escape(name)}\s*\(", js)
    assert m, f"app.js 에 function {name}( 이 없습니다"
    return js[m.end():].split("\nfunction ")[0]


def _strip_js_comments(src: str) -> str:
    """JS 소스에서 주석을 걷어낸다 — 문자열 검사로 "호출이 있다"를 확인하기 전에 쓴다.

    app.js 는 주석이 아주 두꺼운 파일이라, 함수 본문을 통째로 `in` 검사하면 **주석에
    이름이 적혀 있다는 이유만으로 통과**한다. 실제로 `playSceneTransition` 의 재마운트
    검사가 그랬다: `mountVillageVideo(frame)` 호출을 지워도 바로 위 주석의 같은 낱말이
    검사를 만족시켜 테스트가 초록으로 남고, 화면에서는 테마 토글 뒤 배경이 스틸로
    돌아가 사용자가 처음 지적한 "안 움직이는 마을"이 되돌아왔다.
    """
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    return re.sub(r"(^|[\s;{}(])//[^\n]*", r"\1", src)


def _index_html() -> str:
    return (ROOT / "dashboard" / "index.html").read_text(encoding="utf-8")


def _village_targets() -> set[str]:
    """VILLAGE_ZONES 블록에서 target / menu 가 가리키는 섹션 id 를 전부 모은다."""
    src = _app_js()
    block = re.search(r"const VILLAGE_ZONES = \[(.*?)\n\];", src, re.S)
    assert block, "VILLAGE_ZONES 블록을 찾지 못했습니다"
    body = block.group(1)
    out = set(re.findall(r'target:\s*"([^"]+)"', body))
    for menu in re.findall(r"menu:\s*\[(.*?)\]\s*\}", body, re.S):
        out |= set(re.findall(r'\["([a-z]+)",', menu))
    return out


def test_village_zones_cover_every_section():
    """마을에서 14개 섹션 전부에 도달할 수 있어야 한다."""
    ids = set(re.findall(r'<section id="([a-z]+)" class="section">', _index_html()))
    assert len(ids) == 14, f"섹션 수가 14가 아닙니다: {sorted(ids)}"
    missing = ids - _village_targets()
    assert not missing, f"마을에서 도달할 수 없는 섹션: {sorted(missing)}"


def test_village_zone_targets_all_exist():
    """반대 방향 — 존재하지 않는 섹션을 가리키는 구역이 없어야 한다."""
    ids = set(re.findall(r'<section id="([a-z]+)" class="section">', _index_html()))
    dangling = _village_targets() - ids
    assert not dangling, f"실재하지 않는 섹션을 가리키는 구역: {sorted(dangling)}"


def test_village_zone_coords_are_in_frame():
    """핫스팟 좌표는 지도 안(0~100%)이어야 한다 — 밖이면 클릭이 불가능해진다."""
    src = _app_js()
    block = re.search(r"const VILLAGE_ZONES = \[(.*?)\n\];", src, re.S).group(1)
    coords = re.findall(r"x:\s*([\d.]+),\s*y:\s*([\d.]+)", block)
    assert len(coords) >= 8, f"핫스팟이 너무 적습니다: {len(coords)}"
    for x, y in coords:
        assert 0 < float(x) < 100 and 0 < float(y) < 100, f"좌표가 지도 밖: {x},{y}"


def test_village_map_has_no_baked_text_dependency():
    """지도 이미지에 글자를 굽지 않는다는 규약 — 라벨은 코드가 만든다."""
    src = _app_js()
    assert 'class: "vz-label"' in src, "라벨을 코드로 얹는 경로가 사라졌습니다"


def test_gate_states_it_is_not_access_control():
    """관문이 '접근 차단'인 척하면 안 된다 — 공개 정적 호스팅에서 사실이 아니다."""
    html = _index_html()
    assert "접근 차단이 아니라" in html, "관문의 한계 고지 문구가 없습니다"


def test_section_ids_constant_matches_html():
    """app.js 의 SECTION_IDS 와 index.html 의 섹션이 같아야 한다.

    routeView() 가 이 배열만 보고 섹션을 숨기고 보인다 — 어긋나면 섹션 하나가
    영영 안 뜨거나 마을 화면 위에 겹쳐 남는다.
    """
    block = re.search(r"const SECTION_IDS = \[(.*?)\];", _app_js(), re.S)
    assert block, "SECTION_IDS 를 찾지 못했습니다"
    js_ids = set(re.findall(r'"([a-z]+)"', block.group(1)))
    html_ids = set(re.findall(r'<section id="([a-z]+)" class="section">', _index_html()))
    assert js_ids == html_ids, f"SECTION_IDS ≠ HTML 섹션: {js_ids ^ html_ids}"


def test_village_fx_respects_reduced_motion():
    """앰비언트 모션은 prefers-reduced-motion 이면 꺼져야 한다.

    SMIL(SVG 내장 애니메이션)은 이 설정을 스스로 존중하지 않으므로, CSS 가 레이어째
    감추는 것이 유일한 방어선이다. 입장 연출(enterZone)도 같은 설정을 확인해야 한다.
    """
    css = (ROOT / "dashboard" / "style.css").read_text(encoding="utf-8")
    block = re.search(
        r"@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.village-fx[^}]*display:\s*none",
        css,
    )
    assert block, "reduced-motion 에서 .village-fx 를 감추는 규칙이 없습니다"
    assert "prefers-reduced-motion" in _fn("enterZone"), (
        "enterZone 이 reduced-motion 을 확인하지 않습니다"
    )


def test_village_fx_people_paths_all_exist():
    """행인의 mpath 가 가리키는 도로 id 가 전부 실재해야 한다.

    id 하나만 바꿔도 오류 없이 행인이 조용히 사라진다 — 눈으로는 잡기 어려운 결함.
    """
    js = _app_js()
    used = set(re.findall(r'<mpath href="#\$\{road\}"', js))
    assert used, "mpath 참조 코드가 사라졌습니다"
    roads_referenced = set(re.findall(r'\$\{person\("([a-z0-9-]+)"', js))
    roads_defined = set(re.findall(r'<path id="(fx-road\d+)"', js))
    missing = roads_referenced - roads_defined
    assert not missing, f"정의되지 않은 도로를 걷는 행인: {sorted(missing)}"


def test_scene_transition_disables_svg_fx_and_respects_reduced_motion():
    """전환 영상이 재생되는 동안 SVG 모션은 꺼지고, reduced-motion 이면 즉시 전환한다.

    움직임이 겹치면(영상 속 물결 + SVG 물결) 어색하고, SMIL 과 달리 영상은 사용자
    접근성 설정을 코드가 직접 확인해야 한다. 어느 시점에 실패해도 applyScene 는
    반드시 호출돼야 한다(장면 토글이 조용히 무시되면 안 된다).
    """
    css = (ROOT / "dashboard" / "style.css").read_text(encoding="utf-8")
    assert re.search(r"\.has-video \.village-fx\s*\{\s*display:\s*none", css), (
        "영상 재생 중 SVG 모션을 끄는 규칙(.has-video .village-fx)이 없습니다"
    )
    fn = _fn("playSceneTransition")
    assert "prefers-reduced-motion" in fn, (
        "playSceneTransition 이 reduced-motion 을 확인하지 않습니다"
    )
    for evt in ("playing", "ended", "error"):
        assert f'"{evt}"' in fn, f"전환 영상의 {evt} 이벤트 처리가 없습니다"


def test_village_idle_video_assets_exist_and_stay_small():
    """상시 앰비언트 루프 자산 4개(낮/밤 × webm/mp4)의 존재·포맷·용량 계약.

    app.js 의 IDLE_VIDEO 가 가리키는 base 는 실재하는 파일이어야 하고(오타 시 조용히
    스틸+SVG 폴백으로 떨어져 눈에 안 띈다), 저장소가 LFS 가 아니므로 파일당 1.5MB
    상한을 강제한다 — 루프를 다시 뽑을 때 용량 폭주를 여기서 잡는다. 포맷은 컨테이너
    매직 바이트로 확인한다(webm=EBML, mp4=ftyp): 확장자만 바꿔치기한 파일을 걸러 낸다.
    """
    js = _app_js()
    bases = set(re.findall(r'"assets/(village-[a-z]+-loop)"', js))
    assert bases == {"village-day-loop", "village-night-loop"}, (
        f"IDLE_VIDEO base 가 예상과 다릅니다: {sorted(bases)}"
    )
    assets = ROOT / "dashboard" / "assets"
    for base in sorted(bases):
        webm = assets / f"{base}.webm"
        mp4 = assets / f"{base}.mp4"
        assert webm.is_file() and mp4.is_file(), f"{base} 루프 자산(webm+mp4)이 없습니다"
        assert webm.read_bytes()[:4] == b"\x1a\x45\xdf\xa3", f"{webm.name} 이 webm(EBML)이 아닙니다"
        assert mp4.read_bytes()[4:8] == b"ftyp", f"{mp4.name} 이 mp4(ftyp)가 아닙니다"
        for p in (webm, mp4):
            size = p.stat().st_size
            assert 10_000 < size < 1_500_000, f"{p.name} 용량이 계약 밖입니다: {size}B"


def test_village_idle_video_respects_reduced_motion_and_falls_back():
    """상시 루프도 전환 영상과 같은 접근성·격리·폴백 규약을 지켜야 한다.

    ① reduced-motion 사용자에게는 마운트 자체를 하지 않는다 ② 전환 연출이 도는 동안
    이중 마운트하지 않는다(data-transition 가드 — 어기면 전환 영상 밑에서 새 테마
    루프가 겹쳐 돈다) ③ 소스 사다리(webm→mp4)가 다 실패하면 요소를 걷어 스틸+SVG 로
    물러난다 ④ 마을을 떠나면 디코딩을 세운다(pause).
    """
    fn = _fn("mountVillageVideo")
    assert "prefers-reduced-motion" in fn, "mountVillageVideo 가 reduced-motion 을 확인하지 않습니다"
    assert "data-transition" in fn or "[data-transition]" in fn, (
        "전환 연출 중 이중 마운트를 막는 가드가 없습니다"
    )
    for evt in ("error", "playing"):
        assert f'"{evt}"' in fn, f"상시 루프의 {evt} 이벤트 처리가 없습니다"
    assert re.search(r"mountVillageVideo\s*\(", _fn("renderVillage")), (
        "renderVillage 가 상시 루프를 마운트하지 않습니다"
    )
    assert re.search(r"mountVillageVideo\s*\(", _fn("playSceneTransition")), (
        "전환 연출이 끝난 뒤 새 장면의 루프를 재마운트하는 경로가 없습니다 — "
        "주석에 이름만 적혀 있고 실제 호출이 없으면 토글 후 배경이 스틸로 돌아간다"
    )
    route = _fn("routeView")
    assert "pause" in route, "마을을 떠날 때 상시 루프를 pause 하지 않습니다"


def test_leaving_village_does_not_pause_the_theme_transition():
    """마을을 떠날 때 **전환 영상까지** 멈추면 화면이 영구히 얼어붙는다 — 실제로 재현된 결함의 회귀 테스트.

    routeView 가 `video.village-video` 를 통째로 pause 하면 전환 영상도 멈추고, 멈춘 영상은
    `ended` 를 쏘지 못해 `done()` 이 영영 실행되지 않는다. 그러면 `data-transition` 표식이
    DOM 에 남고, 돌아왔을 때 mountVillageVideo 첫 가드가 그 표식을 보고 재마운트를 거부한다 —
    전환 영상이 중간 프레임에서 얼어붙은 채 SVG 모션까지 꺼진 완전 정지 화면이 되고 스스로
    회복하지 못한다(브라우저 실측: currentTime 2.5s 고정, 4초 후에도 동일). 사용자가 처음
    문제 삼은 "정지 화면" 그 자체이므로, pause 대상은 반드시 상시 루프로 한정한다.
    """
    route = _fn("routeView")
    assert "pause" in route, "routeView 에 pause 호출이 없습니다"
    assert "data-idle" in route, (
        "routeView 의 pause 대상이 상시 루프(data-idle)로 한정되지 않았습니다 — "
        "전환 영상까지 멈추면 ended 가 오지 않아 화면이 얼어붙습니다"
    )
    broad = [ln.strip() for ln in route.splitlines()
             if "village-video" in ln and "data-idle" not in ln]
    assert not broad, f"전환 영상까지 걸리는 넓은 선택자가 routeView 에 있습니다: {broad}"
    tt = _fn("playSceneTransition")
    assert '"ended"' in tt, "전환 영상의 ended 처리가 없습니다 — done() 이 실행될 경로가 필요합니다"


def test_hidden_attribute_is_not_defeated_by_display_rules():
    """전역 `[hidden]` 규칙이 있어야 한다 — 실제 브라우저에서 잡은 결함의 회귀 테스트.

    `hidden` 속성의 display:none 은 UA 스타일이라 클래스의 display 선언에 진다.
    `.gate{display:flex}` 때문에 암구호를 맞춰도 관문이 화면을 계속 덮고 있었다
    (요소는 '숨겨졌는데' 클릭을 가로챈다). display 를 선언하면서 hidden 으로도
    토글되는 요소가 있는 한 이 전역 규칙이 유일한 방어선이다.
    """
    css = (ROOT / "dashboard" / "style.css").read_text(encoding="utf-8")
    assert re.search(r"\[hidden\]\s*\{[^}]*display:\s*none\s*!important", css), (
        "style.css 에 전역 `[hidden] { display: none !important }` 규칙이 없습니다"
    )
    # 방어선이 실제로 필요한 상태인지도 함께 확인한다(규칙만 남고 이유가 사라지는 것 방지)
    js = _app_js() + _index_html()
    assert 'id="gate"' in js and re.search(r"\.gate\s*\{[^}]*display:\s*flex", css)


# --------------------------------------------------------------------------
# app.js 가 이름으로 집는 DOM id 가 index.html 에 실재하는가
#
# app.js 는 index.html 의 id 를 82곳에서 정적으로 참조하는데, 그중 실재를 확인하는
# 검사는 프로브 뼈대(tests/dashboard_probe.js)의 **수기 목록** 몇 개뿐이었다.
# id 하나를 지우거나 오타를 내면 `$("#x")` 가 null 을 돌려주고 그 다음 줄에서 죽는데,
# 죽는 자리가 렌더러 안이라 **그 섹션만 조용히 비고** 나머지는 정상으로 보인다.
# (실측: `#card-curve` 하나를 지우자 렌더된 섹션이 10 → 5 로 줄었다.)
# --------------------------------------------------------------------------

#: app.js 가 **자기가 만들어 붙이는** id — index.html 에 없는 것이 정상이다.
#: 여기에 이름을 더할 때는 아래 테스트가 "실제로 만드는지"까지 확인한다.
DYNAMIC_IDS = {
    "village-fx":  'setAttribute("id", "village-fx")',   # 마을 앰비언트 SVG 레이어
    "hg-econ":     'tile("hg-econ"',                     # 시뮬레이터 결과 타일 3개
    "hg-acct":     'tile("hg-acct"',
    "hg-carry":    'tile("hg-carry"',
    "hg-span":     'id: "hg-span"',                      # 시뮬레이터 표본기간 줄
    # 시뮬레이션 콘솔 배분 입력칸 — `"sim-mix-" + 자산군명` 으로 만들어 같은 접두사로 집는다.
    # (참조 정규식이 [A-Za-z0-9_-]+ 라 한글 뒷부분이 잘려 접두사만 남는다)
    "sim-mix-":    'id: "sim-mix-" + k.replace',
    "brief-play":  'id: "brief-play"',                   # 브리핑 듣기/정지 버튼
    "brief-note":  'id: "brief-note"',                   # 기기 내 음성 부재 안내
}


def _referenced_ids() -> set[str]:
    js = _app_js()          # 주석 제거본 — 주석에 적힌 id 는 참조가 아니다
    return (set(re.findall(r'\$\("#([A-Za-z0-9_-]+)', js))
            | set(re.findall(r'getElementById\("([A-Za-z0-9_-]+)"', js)))


def test_every_id_app_js_reaches_for_exists_in_index_html():
    """`$("#x")` / `getElementById("x")` 의 x 가 index.html 에 있거나 동적 생성이어야 한다."""
    html_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', _index_html()))
    missing = sorted(_referenced_ids() - html_ids - set(DYNAMIC_IDS))
    assert not missing, (
        f"app.js 가 집는데 index.html 에 없는 id: {missing} — 그 섹션이 조용히 빕니다. "
        "app.js 가 직접 만드는 id 라면 DYNAMIC_IDS 에 생성 근거와 함께 등록하세요."
    )


def test_dynamic_id_allowlist_is_not_a_dumping_ground():
    """허용 목록의 id 는 **실제로 app.js 가 만들어야** 한다.

    이 확인이 없으면 오타난 id 를 목록에 적어 넣는 것만으로 위 테스트가 무력화된다 —
    허용 목록은 검사를 끄는 스위치가 아니라 "여기 있다"는 주장이고, 주장은 검사한다.
    """
    js = _app_js()
    for name, evidence in DYNAMIC_IDS.items():
        assert evidence in js, f"{name} 을 만드는 코드({evidence!r})가 app.js 에 없습니다"
    stale = sorted(set(DYNAMIC_IDS) & set(re.findall(r'id="([A-Za-z0-9_-]+)"', _index_html())))
    assert not stale, f"index.html 에 실재하므로 허용 목록에서 빼야 합니다: {stale}"


def test_probe_skeleton_covers_the_ids_its_renderers_touch():
    """프로브 뼈대가 렌더러가 집는 id 를 갖고 있는지 — 수기 계약의 자동화.

    `tests/dashboard_probe.js` 는 index.html 구조를 손으로 흉내 낸다. 새 카드를
    index.html 에 추가하고 뼈대에 안 넣으면 프로브가 **그 자리에서 죽는데**, 그
    실패 메시지는 "Cannot read properties of null" 이라 원인이 안 보인다.
    여기서 먼저 이름으로 잡아 준다.
    """
    probe = (Path(__file__).resolve().parent / "dashboard_probe.js").read_text(encoding="utf-8")
    renderers = ("renderHedge", "renderMacro", "renderEvents", "renderCatalog", "renderVillage")
    need = set()
    for fn in renderers:
        need |= set(re.findall(r'\$\("#([A-Za-z0-9_-]+)', _fn(fn)))
    missing = sorted(i for i in need if f'"{i}"' not in probe and i not in DYNAMIC_IDS)
    assert not missing, (
        f"프로브 뼈대에 없는 id 를 렌더러가 집습니다: {missing} — "
        "tests/dashboard_probe.js 의 해당 섹션 뼈대에 추가하세요."
    )


# --------------------------------------------------------------------------
# 배포 게이트의 최소 스키마 — 파일이 있다고 내용이 온전한 것은 아니다
#
# 실측: `hedge.json` 에서 asof·curves·mtm·cost_stats·backtest·sim 을 통째로
# 지워도 게이트가 exit 0 이었다. 필드 하나를 개명한 뮤테이션은 pytest·프로브·게이트
# **세 관문 전부 초록**인데 화면의 헤지비용 열이 전 통화 `—` 로 비었다.
# --------------------------------------------------------------------------

def _run_gate(out: Path) -> int:
    """게이트를 서브프로세스로 돌린다 — 모듈 전역(_errors)이 테스트 간에 누적되므로."""
    r = subprocess.run(
        [sys.executable, str(ROOT / "pipeline" / "check_output.py"),
         # 합성 픽스처는 실데이터에 없는 시리즈를 대량으로 못 찾아 경고가 140건대다
         # (`series not found:`). 여기서 보려는 것은 경고 수가 아니라 **최소 스키마**이므로
         # 상한을 넉넉히 준다 — 경고 상한 자체는 CI 인자(20)가 지킨다.
         "--out", str(out), "--max-warnings", "1000", "--min-series", "10",
         "--dashboard", str(ROOT / "dashboard" / "app.js")],
        capture_output=True, text=True)
    return r.returncode


def test_gate_passes_on_a_healthy_build(built):
    out, _ = built
    assert _run_gate(out) == 0, "정상 산출물인데 게이트가 막습니다"


@pytest.mark.parametrize("payload,key", [
    ("hedge", "matrix"), ("hedge", "curves"), ("hedge", "mtm"),
    ("hedge", "cost_stats"), ("hedge", "sim"), ("hedge", "default_tenor_m"),
    ("alloc", "sources"), ("risk", "factors"), ("panel", "vars"),
    ("events", "brief"),
])
def test_gate_rejects_a_payload_missing_a_required_key(built, tmp_path, payload, key):
    """필수 키 하나만 사라져도 배포를 막아야 한다.

    이것이 실제로 일어나는 방식은 삭제가 아니라 **개명**이다 — 파이프라인만 고치고
    화면을 안 고치면 그 카드가 조용히 빈다. 게이트에서 키 이름을 못박아 둔다.
    """
    out, _ = built
    tmp = tmp_path / "data"
    shutil.copytree(out, tmp)
    p = tmp / f"{payload}.json"
    obj = json.loads(p.read_text(encoding="utf-8"))
    assert key in obj, f"테스트 전제가 깨졌다 — {payload}.json 에 {key} 가 원래 없다"
    del obj[key]
    p.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    assert _run_gate(tmp) == 1, f"{payload}.json 의 {key} 가 사라졌는데 게이트가 통과시켰습니다"


def test_gate_rejects_a_renamed_matrix_column(built, tmp_path):
    """매트릭스 행의 열 이름 개명 — B-4 조사에서 세 관문을 전부 통과했던 바로 그 뮤테이션."""
    out, _ = built
    tmp = tmp_path / "data"
    shutil.copytree(out, tmp)
    p = tmp / "hedge.json"
    obj = json.loads(p.read_text(encoding="utf-8"))
    for row in obj["matrix"]:
        row["swap_rate_12m"] = row.pop("cost_12m")
    p.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    assert _run_gate(tmp) == 1, "cost_12m 이 개명됐는데 게이트가 통과시켰습니다"


#: 화면이 이름으로 읽지 **않는데도** 게이트가 지키는 키 — 그 이유를 여기 적는다.
#: 목록에 넣는 것 자체가 "왜 지키는가"를 답하는 행위이므로, 이유 없이 늘어나지 않는다.
PUBLISH_ONLY_KEYS = {
    ("alloc", "anchor_ref"): "동일 샤프 앵커의 기준(자국통화)·값. 방법론 재현용 게시물",
    ("alloc", "checks"):     "자기검증 결과. 값이 사라지면 검증 없이 배포된 것과 같다",
    ("risk", "grade_bands"): "등급 밴드 정본(app.js 는 자체 BANDS 상수를 쓴다 — 3중 진실이 남아 있다)",
}


def test_required_keys_are_keys_the_dashboard_actually_reads():
    """게이트의 필수 키 목록이 **허구가 되지 않게** 한다.

    화면이 더 이상 읽지 않는 키를 지키면 게이트는 죽은 계약을 강제하는 셈이고,
    반대로 목록이 낡으면 아무것도 못 지킨다. 원칙은 "app.js 가 이 이름을 실제로
    집는가"이고(주석 제거본에서), 예외는 위 목록에 **이유와 함께** 적는다.
    """
    js = _app_js()
    for payload, keys in check_output.REQUIRED_KEYS.items():
        for k in keys:
            if (payload, k) in PUBLISH_ONLY_KEYS:
                continue
            assert re.search(rf"[.\[]\"?'?{re.escape(k)}\b", js), (
                f"check_output.REQUIRED_KEYS['{payload}'] 의 '{k}' 를 app.js 가 읽지 않습니다 — "
                "화면에서 사라진 키라면 목록에서 빼고, 게시 전용이라면 "
                "PUBLISH_ONLY_KEYS 에 이유와 함께 등록하세요"
            )


def test_publish_only_exceptions_are_still_required_keys():
    """예외 목록이 **검사를 끄는 스위치**가 되지 않게 한다.

    게이트가 더 이상 지키지 않는 키가 예외 목록에만 남아 있으면, 목록은 지키는
    척하는 문서가 된다. 예외는 반드시 REQUIRED_KEYS 안에 있어야 한다.
    """
    stale = [(p, k) for (p, k) in PUBLISH_ONLY_KEYS
             if k not in check_output.REQUIRED_KEYS.get(p, [])]
    assert not stale, f"REQUIRED_KEYS 에 없는 예외: {stale}"


# --------------------------------------------------------------------------
# 렌더 격리 — 렌더러 하나가 던져도 나머지 섹션은 그려져야 한다
#
# JSON 로딩(Promise.allSettled)과 파이프라인(risk/hedge 의 try/except)은 이미
# 격리돼 있는데 렌더 계층에만 그 규약이 없었다. 실측: index.html 의 id 하나
# (`#card-curve`)를 지우자 렌더된 섹션이 10 → 5 로 줄었다(rates·irs·credit·fx·
# inflation·acwi·macro 전멸). 화면은 오류 없이 그냥 비어 보였다.
# --------------------------------------------------------------------------

def _renderer_map() -> dict[str, str]:
    block = re.search(r"const RENDERERS = \{(.*?)\n\};", _app_js(), re.S)
    assert block, "app.js 에서 RENDERERS 를 찾지 못했습니다"
    return dict(re.findall(r"(\w+):\s*(\w+)", block.group(1)))


def test_every_section_has_a_renderer():
    """SECTION_IDS 의 14개가 전부 RENDERERS 에 있어야 한다.

    빠뜨리면 그 섹션은 **아무 오류 없이 영영 비어 있다** — 클릭해서 들어가야만
    보이는 구조라 눈으로 알아채기까지 오래 걸린다.
    """
    ids = re.findall(r'"([a-z]+)"', re.search(
        r"const SECTION_IDS = \[(.*?)\];", _app_js(), re.S).group(1))
    r = _renderer_map()
    assert set(ids) - set(r) == set(), f"렌더러가 없는 섹션: {sorted(set(ids) - set(r))}"
    assert set(r) - set(ids) == set(), f"섹션에 없는 렌더러: {sorted(set(r) - set(ids))}"
    assert len(ids) == 14


def test_renderers_named_in_the_map_actually_exist():
    """맵의 값이 실재하는 함수여야 한다 — 오타는 조용히 그 섹션만 지운다."""
    js = _app_js()
    for sec, fn in _renderer_map().items():
        assert f"function {fn}(" in js, f"{sec} 의 렌더러 {fn} 가 app.js 에 없습니다"


def test_render_all_isolates_each_section():
    """renderAll 이 섹션을 하나씩 가둬서 부르는지.

    예전처럼 `renderOverview(); renderRisk(); …` 를 나열하면 앞에서 던진 순간
    뒤가 통째로 멈춘다. 격리 함수를 거치고, 그 안에 try/catch 가 있어야 한다.
    """
    ra = _fn("renderAll")
    assert "SECTION_IDS.forEach(renderSection)" in ra, (
        "renderAll 이 섹션을 개별 호출로 나열합니다 — 하나가 던지면 뒤가 전부 멈춥니다"
    )
    rs = _fn("renderSection")
    assert "try {" in rs and "catch" in rs, "renderSection 에 try/catch 가 없습니다"
    assert "render-error" in rs, (
        "실패한 섹션에 안내를 붙이지 않습니다 — 빈 화면은 '데이터 없음'으로 읽힙니다"
    )


def test_no_payload_is_published_twice():
    """같은 값이 두 JSON 에 실리면 새 이중 진실이 된다.

    헤지비용 커브는 2026-08-04 에 `fx.json` → `hedge.json` 으로 이사했다. 옮기면서
    원본을 안 지우면 한쪽만 고치는 사고가 그대로 재발한다 — 이 저장소는 이미
    "같은 값이 두 이름으로 돌아다니는" 문제를 한 번 겪었다.
    """
    js = _app_js()
    assert "DATA.fx" in js, "테스트 전제가 깨졌다 — #fx 렌더러가 사라졌다"
    fx_fn = _fn("renderFX")
    for gone in ("hedge_ts", "hedge_rows", "card-hedge-ts", "card-hedge-table"):
        assert gone not in fx_fn, f"renderFX 가 아직 {gone} 를 그립니다"
    build_fx = (ROOT / "pipeline" / "process.py").read_text(encoding="utf-8")
    build_fx = build_fx.split("def build_fx()")[1].split("\ndef ")[0]
    for gone in ("hedge_ts", "hedge_rows"):
        assert gone not in build_fx, f"build_fx 가 아직 {gone} 를 싣습니다"
    hedge_py = (ROOT / "pipeline" / "hedge.py").read_text(encoding="utf-8")
    assert "cost_hist_curve" in hedge_py, "hedge.py 가 이사받은 커브를 싣지 않습니다"


def test_hedge_matrix_row_carries_its_sample(built):
    """매트릭스 각 행이 자기 표본을 들고 있어야 한다 (B-6).

    통일하지 않고 게시한다 — 짧은 쪽에 맞추면 변동성 표본을 버리고, 긴 쪽에 맞출
    방법은 없다. 게시만 하면 자의성이 0이다.
    """
    out, _ = built
    H = json.loads((out / "hedge.json").read_text(encoding="utf-8"))
    assert H["matrix"], "매트릭스가 비었습니다"
    for row in H["matrix"]:
        sp = row.get("sample")
        assert isinstance(sp, dict), f"{row['c']} 행에 sample 이 없습니다"
        assert "vol" in sp and "fit" in sp, f"{row['c']}: {sorted(sp)}"
        vol = sp["vol"]
        assert vol and {"start", "end", "n"} <= set(vol), f"{row['c']} vol: {vol}"
        assert isinstance(vol["n"], int) and vol["n"] > 0
        if row.get("mvh") is not None:
            assert sp["fit"], f"{row['c']}: MVH 는 있는데 적합 표본이 없습니다"
            assert sp["fit"]["n"] <= vol["n"], (
                f"{row['c']}: 적합 표본이 변동성 표본보다 깁니다 — 조인은 짧게만 만듭니다"
            )


@pytest.mark.parametrize("sub,key", [
    ("cost_stats", "series"), ("cost_stats", "n_months"), ("cost_stats", "years"),
    ("mtm", "series"), ("mtm", "n_months"), ("cost_read", "label"),
])
def test_gate_rejects_a_hedge_payload_missing_a_nested_key(built, tmp_path, sub, key):
    """중첩 객체의 필수 키도 지킨다.

    화면 부제가 이 값들로 **자기 표본을 밝힌다**. 빠지면 부제가 조용히 짧아지고,
    그 자리에 예전처럼 하드코딩된 「25년 평균」이 되돌아올 여지가 생긴다.
    """
    out, _ = built
    tmp = tmp_path / "data"
    shutil.copytree(out, tmp)
    p = tmp / "hedge.json"
    obj = json.loads(p.read_text(encoding="utf-8"))
    assert key in obj[sub], f"테스트 전제가 깨졌다 — hedge.json.{sub} 에 {key} 가 없다"
    del obj[sub][key]
    p.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    assert _run_gate(tmp) == 1, f"hedge.json.{sub}.{key} 가 사라졌는데 게이트가 통과시켰습니다"


# --------------------------------------------------------------------------
# 문서 드리프트 — 문서는 다음 세션의 유일한 지도인데 읽는 테스트가 하나도 없었다
#
# 이 저장소는 방향 이탈로 56커밋 프로젝트를 폐기한 전력이 있고, 뮤테이션 커버리지
# 주장을 이미 두 번 하향했다(2d2a46f · 9a34c2d). 기계로 확인 가능한 수만이라도
# 여기서 잠근다 — 사람이 세는 수는 반드시 어긋난다.
# --------------------------------------------------------------------------

def _docs() -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8")
            for p in [ROOT / "CLAUDE.md", ROOT / "docs" / "HANDOVER.md"]}


def test_docs_state_the_real_test_count():
    """문서가 적은 "N개 통과" 가 실제 수집 개수와 같아야 한다."""
    r = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q"],
                       cwd=ROOT, capture_output=True, text=True)
    m = re.search(r"(\d+) tests? collected", r.stdout)
    assert m, r.stdout[-1500:]
    real = int(m.group(1))
    for name, txt in _docs().items():
        for claimed in re.findall(r"(?:현재|정상)?\s*(\d+)개\s*(?:통과|테스트)", txt):
            assert int(claimed) == real, (
                f"{name} 이 테스트 {claimed}개라고 적었지만 실제는 {real}개입니다"
            )


def test_docs_state_the_real_json_contract_size():
    """JSON 계약 크기(15)는 코드가 정한 수다 — 문서의 다른 수를 잡는다."""
    n = len(check_output.EXPECTED)
    for name, txt in _docs().items():
        for claimed in re.findall(r"JSON\s*(\d+)개", txt):
            assert int(claimed) == n, f"{name}: JSON {claimed}개라고 적혀 있으나 계약은 {n}개"


def test_docs_do_not_point_at_line_numbers_of_moving_code():
    """`process.py` 의 행 번호를 문서에 적지 않는다.

    실측으로 11건이 전부 −1 만큼 어긋나 있었다. 코드가 한 줄만 움직여도 전부
    거짓이 되고, 어긋났다는 사실은 아무도 모른다 — 이름이나 grep 명령으로 적는다.
    """
    bad = []
    for name, txt in _docs().items():
        for m in re.finditer(r"`?(process|risk|hedge|alloc|panel|app)\.(py|js)`?[^\n]{0,40}?(\d{2,4})\s*행", txt):
            bad.append(f"{name}: {m.group(0)[:60]}")
        for m in re.finditer(r"(\d{2,4})(?:·\d{2,4})+\s*행", txt):
            bad.append(f"{name}: {m.group(0)[:60]}")
    assert not bad, "문서가 코드 행 번호를 가리킵니다(이름·grep 으로 바꾸세요): " + "; ".join(bad)


def test_ci_runs_tests_when_only_docs_change():
    """문서의 수치를 테스트가 검사하므로, 문서만 고친 커밋도 CI 를 타야 한다."""
    wf = (ROOT / ".github" / "workflows" / "tests.yml").read_text(encoding="utf-8")
    paths = wf.split("paths:", 1)[1].split("workflow_dispatch", 1)[0]
    for need in ('"docs/**"', '"CLAUDE.md"'):
        assert need in paths, f"tests.yml 의 paths 에 {need} 가 없습니다"


def test_single_day_breadth_publishes_no_chartable_series(built):
    """관측이 하루면 `ts` 를 싣지 않는다 — 점 하나짜리 시계열은 차트가 될 수 없다.

    실려 있으면 화면이 "이력이 있다"고 판단해 점 하나로 추이 차트를 그린다.
    합성 픽스처는 리포트를 **한 부**만 만들므로 여기가 그 조건이다.
    """
    out, _ = built
    A = json.loads((out / "acwi.json").read_text(encoding="utf-8"))
    b = A.get("breadth")
    assert b, "acwi.json 에 breadth 가 없습니다"
    assert b["n"] == 1, f"픽스처는 리포트 1부다: n={b['n']}"
    assert b["ts"] == {}, f"관측 1일인데 시계열이 실렸습니다: {sorted(b['ts'])}"
    assert b["rows"], "스냅샷 행이 비었습니다"
    for r in b["rows"]:
        assert r["label"] and r["unit"] is not None, r
        assert r["n"] == 1


def test_breadth_publishes_no_ticker_level_field(built):
    """파이프라인을 통과한 뒤에도 종목 단위 필드가 없어야 한다 (공개 범위 가드).

    파서 쪽 계약은 `tests/test_breadth.py` 가 지킨다. 여기서는 **게시물**을 본다 —
    파서를 고치지 않고 빌더에서 종목을 실어 버리는 경로를 막는다.
    """
    out, _ = built
    A = json.loads((out / "acwi.json").read_text(encoding="utf-8"))
    blob = json.dumps(A.get("breadth", {}), ensure_ascii=False)
    for banned in ("티커", "회사명", "ticker", "현재가", "시가총액"):
        assert banned not in blob, f"종목 단위 필드가 게시물에 있습니다: {banned}"
    cat = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
    us = [r for r in cat["series"] if r["key"].startswith("us:")]
    assert us, "카탈로그에 us: 시리즈가 없습니다"
    assert all(r["source"] == "kiwoom" for r in us)


def test_breadth_events_join_the_same_event_stream(built):
    """시장 폭 이벤트가 `events.json` 의 같은 스트림·같은 카탈로그에 들어간다.

    사용자 제안(2026-08-04): "그냥 최근 이벤트 같은 거에 사용하면 어때". 이벤트는
    **하루 안에서 판정**되므로 이력이 없어도 성립한다 — 위험 요인(백분위·워크포워드)과
    다른 점이 이것이다. 별도 화면을 만들지 않고 기존 스트림에 합친다.
    """
    out, _ = built
    E = json.loads((out / "events.json").read_text(encoding="utf-8"))
    cats = {c["cat"] for c in E["catalog"]}
    assert "시장폭" in cats, f"규칙 카탈로그에 없습니다: {sorted(cats)}"
    # 합성 픽스처는 상승 우세(3.0배) + 신고가−신저가 음수(200−500) 라 ① 이 걸린다
    b = [e for e in E["events"] if e["cat"] == "시장폭"]
    assert b, "합성 픽스처 조건에서 시장 폭 이벤트가 안 나왔습니다"
    for e in b:
        assert set(e) >= {"date", "sev", "cat", "title", "value", "rule", "tags"}
        assert e["sev"] in ("경계", "주의", "정보")
        assert "임계값 없음" in e["rule"] or "만장일치" in e["rule"], e["rule"]
    # 정렬은 전체 스트림 기준으로 유지된다
    dates = [e["date"] for e in E["events"]]
    assert dates == sorted(dates, reverse=True), "이벤트가 날짜 역순이 아닙니다"


def test_breadth_events_never_leak_ticker_names(built):
    """이벤트 문구에도 종목 단위가 들어가면 안 된다 — 공개 페이지로 나가는 글이다."""
    out, _ = built
    E = json.loads((out / "events.json").read_text(encoding="utf-8"))
    blob = json.dumps([e for e in E["events"] if e["cat"] == "시장폭"], ensure_ascii=False)
    for banned in ("티커", "회사명", "현재가", "시가총액"):
        assert banned not in blob, f"이벤트 문구에 종목 단위가 있습니다: {banned}"


def test_breadth_event_failure_does_not_lose_the_other_events(built, tmp_path, monkeypatch):
    """시장 폭 이벤트가 터져도 나머지 이벤트는 나가야 한다 (격리 규약).

    `risk.build` 는 이미 try/except 로 격리돼 있는데, 그 안에 새 계산을 넣으면서
    격리를 안 하면 시장 폭 하나 때문에 이벤트 화면이 통째로 사라진다.
    """
    src = (ROOT / "pipeline" / "process.py").read_text(encoding="utf-8")
    block = src.split("breadth.detect_events")[0].rsplit("try:", 1)[-1]
    assert "risk.build" not in block, (
        "breadth.detect_events 가 risk.build 와 같은 try 블록에 있습니다 — "
        "시장 폭 실패가 이벤트 전체를 날립니다"
    )
    after = src.split("breadth.detect_events", 1)[1].split("payloads[\"events.json\"]")[0]
    assert "except Exception" in after and "warn(" in after, (
        "시장 폭 이벤트 계산에 격리(try/except + warn)가 없습니다"
    )


# --------------------------------------------------------------------------
# 이벤트 브리핑 (events.json.brief) — 원고는 파이프라인이 조립한다 (LLM 없음)
#
# "AI 앵커"의 원고다. LLM 으로 쓰면 같은 데이터에서 다른 문장이 나와 「자의성 금지」
# 위반이므로, risk.compose_brief 가 이벤트 필드를 **원문 그대로** 템플릿에 끼운다.
# 여기서는 그 계약 — 경계·주의 전건 원문 포함, 정보 제목 미포함(C 선별형),
# 고지 문장, 빈 목록 처리 — 을 못박는다.
# --------------------------------------------------------------------------

def _ev(date, sev, title="t", value="v", cat="급변", rule="r"):
    return {"date": date, "sev": sev, "cat": cat, "title": title, "value": value,
            "rule": rule, "tags": []}


def test_brief_reads_every_alert_and_warning_verbatim():
    evs = [_ev("2026-06-23", "경계", "KOSPI TR 일간 급락", "-10.0%"),
           _ev("2026-07-01", "주의", "국고 10년 일간 급등", "+14.0bp"),
           _ev("2026-07-06", "정보", "달러/원 변동성 백분위 90% 이탈", "81%")]
    lines = risk.compose_brief(evs, "2026-07-27", 45)
    body = "\n".join(lines)
    assert "KOSPI TR 일간 급락 (-10.0%)" in body      # 제목·값이 원문 그대로
    assert "국고 10년 일간 급등 (+14.0bp)" in body
    assert "달러/원 변동성" not in body               # 정보는 건수로만 (C 선별형)
    assert "모두 3건" in lines[0]
    assert "경계 1 · 주의 1 · 정보 1" in lines[0]
    assert lines[-1].endswith("모델 참고치입니다.")   # 고지는 항상 마지막


def test_brief_orders_alerts_before_warnings_newest_first():
    evs = [_ev("2026-06-01", "주의", "w-old"), _ev("2026-07-01", "주의", "w-new"),
           _ev("2026-06-15", "경계", "a1")]
    items = [l for l in risk.compose_brief(evs, "2026-07-27", 45) if l.startswith("[")]
    assert [l[1:3] for l in items] == ["경계", "주의", "주의"]
    assert "w-new" in items[1] and "w-old" in items[2]


def test_brief_handles_empty_and_info_only_lists():
    empty = risk.compose_brief([], "2026-07-27", 45)
    assert "검출된 이벤트가 없습니다" in empty[0]
    assert empty[-1].endswith("모델 참고치입니다.")
    info = risk.compose_brief([_ev("2026-07-06", "정보", "i1")], "2026-07-27", 45)
    assert "경계·주의 단계는 없습니다" in info[0]
    assert not any(l.startswith("[") for l in info)


def test_brief_window_is_event_dates_not_asof():
    """여는 문장의 구간은 기준일(asof)이 아니라 실제 이벤트 날짜다 — 시장 폭 이벤트는
    데일리 리포트에서 와서 asof 보다 뒤일 수 있고, "asof 기준"이라 말하면 모순이 된다.
    해가 걸치면 연도를 붙이고, 하루면 "하루 동안"으로 읽는다(둘 다 기계적 규칙)."""
    cross = risk.compose_brief([_ev("2025-12-30", "주의", "a"),
                                _ev("2026-01-05", "경계", "b")], "2026-01-10", 45)
    assert "2025년 12월 30일부터 2026년 1월 5일까지" in cross[0]
    one = risk.compose_brief([_ev("2026-06-18", "주의", "a")], "2026-07-27", 45)
    assert "6월 18일 하루 동안" in one[0]


def test_built_brief_covers_its_own_events(built):
    """완주 산출물 자기정합 — 브리핑에 경계·주의 이벤트가 하나라도 빠지면 안 된다."""
    out, _ = built
    E = json.loads((out / "events.json").read_text(encoding="utf-8"))
    assert isinstance(E.get("brief"), list) and E["brief"], "events.json 에 brief 가 없습니다"
    assert all(isinstance(l, str) and l for l in E["brief"])
    body = "\n".join(E["brief"])
    for e in E["events"]:
        if e["sev"] in ("경계", "주의"):
            assert e["title"] in body, f"브리핑에서 빠진 이벤트: {e['title']}"
            assert e["value"] in body, f"브리핑에서 빠진 값: {e['value']}"
