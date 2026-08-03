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
        for k in ["anchor", "d1", "d2", "hb_star", "he_star"]:
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

def _app_js() -> str:
    return (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")


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
    js = _app_js()
    assert "prefers-reduced-motion" in js.split("function enterZone")[1].split("function ")[0], (
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


def test_village_video_disables_svg_fx_and_respects_reduced_motion():
    """영상 지도가 켜지면 SVG 모션은 꺼지고, reduced-motion 이면 영상을 시도조차 않는다.

    움직임이 겹치면(영상 속 새 + SVG 새) 어색하고, SMIL 과 달리 영상은 사용자
    접근성 설정을 코드가 직접 확인해야 한다.
    """
    css = (ROOT / "dashboard" / "style.css").read_text(encoding="utf-8")
    assert re.search(r"\.has-video \.village-fx\s*\{\s*display:\s*none", css), (
        "영상 재생 중 SVG 모션을 끄는 규칙(.has-video .village-fx)이 없습니다"
    )
    js = _app_js()
    mount = js.split("function mountVillageVideo")[1].split("\nfunction ")[0]
    assert "prefers-reduced-motion" in mount, (
        "mountVillageVideo 가 reduced-motion 을 확인하지 않습니다"
    )


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
