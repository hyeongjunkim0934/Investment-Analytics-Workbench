"""대시보드 UI/UX 회귀 테스트 — **값을 실제로 계산해서** 확인한다.

이 파일이 따로 있는 이유는 `test_contract.py` 의 기존 대시보드 테스트가 전부
app.js 를 *문자열로* 읽어 토큰 존재 여부만 보는 방식이기 때문이다. 그 방식은
"이름·주석·상수는 그대로 두고 동작만 뒤집는" 변경을 잡지 못한다. 실제로 뮤테이션
10건을 걸어 본 결과 문자열 검사만으로는 9건이 통과했다(축 재포맷 무력화, 오버레이
inert 영구 ON 으로 화면 먹통, 최신값 대신 첫값 표기, 안내문 죽은 가지 등).

그래서 여기서는 두 가지만 한다.
  1) `tests/dashboard_probe.js` 로 **진짜 app.js 를 node 안에서 실행**시키고 결과를 본다.
  2) style.css 의 색·크기를 **파싱해서 WCAG 수식으로 직접 계산**한다.

npm 의존성은 0 이다(node 표준 라이브러리 + 자체 DOM 셰이드). node 는 GitHub 호스팅
러너에 기본 탑재돼 있다 — 없으면 **조용히 건너뛰지 않고 실패**시킨다. 건너뛰면
이 파일이 막으려는 회귀가 아무 소리 없이 되살아나기 때문이다.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_JS = ROOT / "dashboard" / "app.js"
STYLE_CSS = ROOT / "dashboard" / "style.css"
INDEX_HTML = ROOT / "dashboard" / "index.html"
PROBE = Path(__file__).resolve().parent / "dashboard_probe.js"

AA_TEXT = 4.5      # WCAG 2.2 AA 본문 텍스트
AA_NONTEXT = 3.0   # WCAG 2.2 AA 비텍스트(1.4.11)
MIN_TARGET = 24    # WCAG 2.2 AA 최소 조작부(2.5.8)


# --------------------------------------------------------------------------
# node 하네스
# --------------------------------------------------------------------------
@pytest.fixture(scope="module")
def probe() -> dict:
    node = shutil.which("node")
    if node is None:
        pytest.fail(
            "node 를 찾지 못했다. 이 파일의 동작 검사는 dashboard/app.js 를 실제로 "
            "실행해서 확인하므로 node 가 필수다(GitHub 호스팅 러너에는 기본 탑재). "
            "건너뛰면 회귀가 조용히 통과하므로 skip 하지 않고 실패시킨다."
        )
    r = subprocess.run([node, str(PROBE)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"probe 실행 실패:\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}"
    data = json.loads(r.stdout)
    broken = {k: v["ERROR"] for k, v in data.items() if isinstance(v, dict) and "ERROR" in v}
    assert not broken, f"probe 안에서 예외가 났다: {json.dumps(broken, ensure_ascii=False)[:2000]}"
    return data


# ---- y축 눈금 -------------------------------------------------------------
def test_y_axis_ticks_are_never_duplicated(probe):
    """반올림으로 눈금이 뭉개지면 자릿수를 늘려 서로 다른 라벨이 되어야 한다.

    「이행 경로」의 실제 값역(2.60~2.75%, 소수 0자리)을 그대로 태워 확인한다.
    변경 전에는 눈금 4개가 전부 '3%' 였다.
    """
    a = probe["axis"]
    assert a["n"] == 4
    assert a["unique"] == a["n"], f"눈금이 중복된다: {a['labels']}"
    assert a["labels"] == ["2.60", "2.65", "2.70", "2.75"], a["labels"]


def test_y_axis_without_refmt_is_unchanged(probe):
    """refmt 를 넘기지 않는 호출자는 예전과 완전히 같아야 한다(불필요한 표기 변경 금지)."""
    a = probe["axis"]
    assert a["plain"] == ["3%", "3%", "3%", "3%"]
    assert a["plainUnique"] == 1


# ---- 기간 버튼 ------------------------------------------------------------
def test_range_filter_hidden_where_it_does_nothing(probe):
    """기간 버튼은 그 화면에 기간이 먹는 차트가 있을 때만 보인다."""
    g = probe["rangeGating"]
    assert g["noChart"] is True, "차트가 없는 화면에서 기간 줄이 그대로 떠 있다"
    assert g["withChart"] is False, "차트가 있는 화면에서 기간 줄이 사라졌다"
    assert g["otherSection"] is True
    assert g["helperTrue"] is True and g["helperFalse"] is False


def test_one_section_visible_at_a_time(probe):
    """섹션은 한 번에 하나만 — 이 구조의 요점이라 라우팅을 고칠 때 같이 확인한다."""
    assert probe["rangeGating"]["visibleSections"] == ["rates"]


# ---- 드릴다운 오버레이 ----------------------------------------------------
def test_overlay_is_a_real_dialog_when_open(probe):
    o = probe["overlay"]["openState"]
    assert o["hidden"] is False
    assert o["role"] == "dialog" and o["ariaModal"] == "true"
    assert o["ariaLabel"], "대화상자에 이름이 없다"
    assert o["inertHeader"] and o["inertMain"] and o["inertFooter"], \
        "배경이 inert 가 아니면 초점이 오버레이 밖으로 샌다"
    assert o["hasCloseButton"] and o["closeIsButton"] == "BUTTON"
    assert o["focusIsCloseButton"], "열 때 초점이 오버레이 안으로 들어가지 않는다"
    assert o["backHref"] == "#risk", "「돌아가기」가 href 없는 <a> 면 키보드로 못 잡는다"
    assert o["overlayItselfNotInert"], "오버레이 자신에게 inert 가 걸리면 아무것도 못 누른다"


def test_overlay_inerts_every_sibling_not_just_header_main_footer(probe):
    """body 직계 자식을 이름으로만 집으면 그 셋에 안 속한 형제로 초점이 샌다.

    실브라우저에서 Tab 16회 중 8회가 오버레이 밖으로 나갔고, 새는 통로가
    `.skip-link`(body 직계 <a>) 였다. 관문(#gate)도 같은 위치에 있다.
    """
    o = probe["overlay"]["openState"]
    assert o["inertSkipLink"] is True, "본문 바로가기 링크로 초점이 샌다"
    assert o["inertGate"] is True
    c = probe["overlay"]["closedState"]
    assert c["inertSkipLink"] is False and c["inertGate"] is False, "닫은 뒤 inert 가 남았다"


def test_overlay_releases_everything_when_closed(probe):
    """닫힘은 열림의 정확한 역이어야 한다.

    inert 가 남으면 화면 전체가 클릭·Tab 을 받지 않는 먹통이 된다 — 겉보기에는
    멀쩡해서 눈으로는 절대 못 잡는 자리다.
    """
    c = probe["overlay"]["closedState"]
    assert c["hidden"] is True
    assert c["role"] is None and c["ariaModal"] is None
    assert c["inertHeader"] is False and c["inertMain"] is False and c["inertFooter"] is False
    assert c["focusRestored"] is True, "닫은 뒤 초점이 열기 전 자리로 돌아가지 않는다"


# ---- 차트 제목줄의 "최근 …" -----------------------------------------------
def test_stamp_shows_last_observation_not_first(probe):
    s = probe["stamp"]
    assert s["lastNotFirst"] == "최근 -0.45% (2026-07-31)"
    assert s["skipsTrailingNull"] == "최근 -0.78% (2026-06-30)"
    assert s["multiSeries"] == "최근 2026-07-31 기준"


def test_stamp_never_prints_a_date_after_the_asof(probe):
    """월말 시계열(환헤지비용)은 마지막 점이 기준일보다 뒤다 — 그대로 찍으면
    한 화면에 미래 날짜가 나타나 관측일로 오독된다. 월까지만 적어야 한다."""
    s = probe["stamp"]
    assert s["futureDateDemoted"] == "최근 -0.45% (2026-07월)"
    assert s["stampDatePast"] == "2026-05-31", "기준일 이전 날짜는 그대로 찍어야 한다"


# ---- 카탈로그 -------------------------------------------------------------
def test_catalog_zero_results_explains_itself(probe):
    c = probe["catalogEmpty"]
    assert c["rowsAll"] == 2
    assert c["emptyShown"] is True, "검색 0건인데 표가 빈 채로 남는다(고장으로 읽힌다)"
    assert c["emptyColspan"] == "6"
    assert "없습니다" in c["emptyText"]


# ---- 등급 밴드 범례 --------------------------------------------------------
def test_grade_band_legend_text_passes_aa(probe):
    """네 밴드 모두 글자색을 계산해서 고르므로 AA 를 넘어야 한다.

    변경 전에는 넷 다 흰 글자였고 '주의'(노랑)는 2.17:1 로 사실상 안 보였다.
    """
    for b in probe["bandInk"]:
        assert b["contrast"] >= AA_TEXT, f"{b['band']} 밴드 글자 대비 {b['contrast']}"
    warn = next(b for b in probe["bandInk"] if b["band"] == "주의")
    assert warn["whiteContrast"] < AA_TEXT, "테스트 전제가 깨졌다 — 흰 글자는 원래 미달이었다"
    assert warn["ink"] == "#111111"


# ---- 요인 행 / 이벤트 칩 ---------------------------------------------------
def test_factor_row_is_a_real_link(probe):
    """마우스 없이도 상세로 들어갈 수 있어야 한다. <a href> 면 Tab·Enter·새 탭이 공짜다."""
    f = probe["factorRow"]
    assert f["tag"] == "A" and f["href"] == "#detail-vol"
    assert f["activeChevron"] == "›"


def test_factor_row_accessible_name_keeps_the_monthly_change(probe):
    """aria-label 은 행 안의 글자를 '대체'한다 — 화면에 있는 정보가 빠지면 안 된다."""
    f = probe["factorRow"]
    label = f["ariaLabel"]
    for piece in ("변동성", "시장이 얼마나 요동치나", "78", "경계"):
        assert piece in label, f"{piece} 가 접근가능한 이름에서 빠졌다: {label}"
    assert f["deltaTextInLabel"], f"1개월 변화가 빠졌다: {label}"
    assert f["deltaTexts"] == ["상승 8p", "하락 8p", "변화 없음", "자료 없음"]


def test_pending_factor_row_is_not_clickable_looking(probe):
    """대기 행은 갈 곳이 없다 — 링크도 아니고 셰브런도 없어야 한다."""
    f = probe["factorRow"]
    assert f["pendingTag"] == "DIV" and f["pendingHref"] is None
    assert f["pendingChevron"] == ""


def test_event_filter_chips_are_buttons_with_state(probe):
    e = probe["eventChips"]
    assert e["tags"] == ["BUTTON"], f"필터 칩이 버튼이 아니다: {e['tags']}"
    assert e["types"] == ["button"], "type 이 없으면 form 안에서 submit 으로 동작한다"
    assert e["allHaveAriaPressed"], "켜짐/꺼짐이 보조기술에 전달되지 않는다"
    assert e["ariaPressed"][0] == "true"


# ---- 푸터 빌드 경고 --------------------------------------------------------
def test_build_warnings_live_outside_the_build_line_paragraph(probe):
    """<p id="build-line"> **안**에 넣으면 펼치는 순간 문단이 18px→209px 로 늘며
    빌드 메타 줄과 설명 문장이 같은 시각적 줄에 겹친다(실제 클릭으로 재현). 게다가
    <p> 안의 <ul>/<p> 는 HTML 콘텐츠 모델 위반이다."""
    w = probe["footerWarnings"]
    assert w["detailsInsideBuildLine"] is False
    assert w["detailsParentId"] == "build-warnings"
    assert w["detailsParentTag"] != "P"
    assert w["listItems"] == 3, "경고 건수만큼 항목이 나와야 한다"
    assert "콘솔" not in w["buildLineText"], "빌드 줄이 아직 개발자 콘솔을 열라고 한다"


def test_build_warnings_container_exists_in_markup():
    html = INDEX_HTML.read_text(encoding="utf-8")
    m = re.search(r'<p id="build-line"></p>\s*(?:<!--.*?-->\s*)*<div id="build-warnings">', html, re.S)
    assert m, "#build-warnings 가 #build-line 의 형제 <div> 로 있어야 한다"


# --------------------------------------------------------------------------
# CSS — 색과 크기를 직접 계산한다
# --------------------------------------------------------------------------
def _srgb(c: float) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _lum(hx: str) -> float:
    h = hx.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _srgb(r) + 0.7152 * _srgb(g) + 0.0722 * _srgb(b)


def contrast(a: str, b: str) -> float:
    la, lb = _lum(a), _lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def _blend(fg: str, bg: str, alpha: float) -> str:
    f, b = fg.lstrip("#"), bg.lstrip("#")
    return "#" + "".join(
        f"{round(int(f[i:i+2],16)*alpha + int(b[i:i+2],16)*(1-alpha)):02x}" for i in (0, 2, 4)
    )


def _css() -> str:
    """주석을 **먼저 제거**한 CSS.

    이게 없으면 규칙을 주석 처리해 무력화한 변경을 테스트가 못 잡는다 —
    뮤테이션으로 실제로 확인했다(`/* html { scroll-behavior: auto; } */` 가 통과했다).
    """
    return re.sub(r"/\*.*?\*/", "", STYLE_CSS.read_text(encoding="utf-8"), flags=re.S)


def _tokens(block_re: str) -> dict[str, str]:
    """지정한 :root 블록 안의 `--var: #hex` 를 전부 뽑는다."""
    m = re.search(block_re + r"\s*\{(.*?)\n\}", _css(), re.S | re.M)
    assert m, f"CSS 블록을 찾지 못했다: {block_re}"
    return {k: v for k, v in re.findall(r"(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;", m.group(1))}


@pytest.fixture(scope="module")
def dark() -> dict[str, str]:
    """**기본** 테마(2026-08-04 지시). 속성이 하나도 없을 때 적용되는 한 벌이다.

    `_tokens` 가 정규식 뒤에 `\\s*\\{` 를 붙이므로 `^:root` 는 `:root {` 만 잡고
    `:root[data-theme="light"] {` 에는 걸리지 않는다 — 대괄호가 막는다.
    """
    return _tokens(r"^:root")


@pytest.fixture(scope="module")
def light() -> dict[str, str]:
    """토글로 고른 밝은 테마. 이제 이쪽이 속성을 다는 쪽이다."""
    return _tokens(r'^:root\[data-theme="light"\]')


def test_secondary_text_passes_aa_on_every_surface_it_lands_on(light, dark):
    """--ink-3 는 화면 설명글 대부분을 칠하는 색이다(전부 11.5~12.5px).

    페이지·카드면만 보면 놓친다 — 행 hover 틴트(accent 6%) 위에도 얹히므로
    네 바탕 모두에서 4.5:1 을 넘어야 한다. 예전 값 #898781 은 3.41:1 이었다.
    """
    for name, tk in (("light", light), ("dark", dark)):
        ink = tk["--ink-3"]
        surfaces = {
            "page": tk["--page"],
            "surface": tk["--surface"],
            "hover-on-page": _blend(tk["--accent"], tk["--page"], 0.06),
            "hover-on-surface": _blend(tk["--accent"], tk["--surface"], 0.06),
        }
        for where, bg in surfaces.items():
            cr = contrast(ink, bg)
            assert cr >= AA_TEXT, f"[{name}] --ink-3 {ink} on {where} {bg} = {cr:.3f}"


def test_accent_text_and_filled_controls_pass_aa(light, dark):
    """--accent 는 차트 색이라 못 건드린다. 글자용(--accent-ink)과 면용(--accent-solid)을
    따로 두고, 각각 대비를 만족해야 한다."""
    for name, tk in (("light", light), ("dark", dark)):
        for surf in ("--page", "--surface"):
            cr = contrast(tk["--accent-ink"], tk[surf])
            assert cr >= AA_TEXT, f"[{name}] --accent-ink on {surf} = {cr:.3f}"
        cr = contrast("#ffffff", tk["--accent-solid"])
        assert cr >= AA_TEXT, f"[{name}] 흰 글자 on --accent-solid = {cr:.3f}"
        # 채워진 컨트롤과 그 주변 면의 경계 (1.4.11)
        for surf in ("--page", "--surface"):
            cr = contrast(tk["--accent-solid"], tk[surf])
            assert cr >= AA_NONTEXT, f"[{name}] --accent-solid 경계 vs {surf} = {cr:.3f}"


def test_delta_text_passes_aa_including_the_hover_tint(light, dark):
    """상승/하락 델타 글자(`▲ 8p`)는 요인 행 위에 있어서 hover 틴트가 깔린다.

    --up(#d03b3b) 은 정지 상태 4.56:1 로 겨우 통과하지만 hover 틴트 위에서는
    4.35:1 로 내려가 AA 미달이었다(실렌더로 측정). 그래서 글자 전용 --up-ink 를 뒀다.
    --up 자체는 칩 배경 틴트 등에서 계속 쓰이므로 값이 그대로여야 한다.
    """
    assert light["--up"] == "#d03b3b" and light["--down"] == "#1c5cab", "시장 관례 색은 그대로"
    for name, tk in (("light", light), ("dark", dark)):
        for ink in (tk["--up-ink"], tk["--down-ink"]):
            for where in ("--page", "--surface"):
                bg = tk[where]
                for label, b in ((where, bg), (f"hover/{where}", _blend(tk["--accent"], bg, 0.06))):
                    cr = contrast(ink, b)
                    assert cr >= AA_TEXT, f"[{name}] 델타 글자 {ink} on {label} = {cr:.3f}"


def test_chart_accent_token_is_untouched(light, dark):
    """차트 색은 1비트도 바뀌면 안 된다 — 대비 개선이 데이터 표현을 건드리지 않았다는 증거."""
    assert light["--accent"] == "#2a78d6"
    assert dark["--accent"] == "#3987e5"


def test_focus_ring_is_visible(light):
    """포커스 링이 transparent/none 이 되면 키보드 조작이 사실상 불가능해진다."""
    m = re.search(r":focus-visible\s*\{([^}]*)\}", _css())
    assert m, ":focus-visible 규칙이 없다"
    body = m.group(1)
    om = re.search(r"outline:\s*(\d+)px\s+solid\s+var\((--[\w-]+)\)", body)
    assert om, f"outline 이 'Npx solid var(--토큰)' 형태가 아니다: {body!r}"
    width, token = int(om.group(1)), om.group(2)
    assert width >= 2, f"포커스 링 두께 {width}px"
    assert token in light, f"{token} 가 :root 에 없다"
    cr = contrast(light[token], light["--page"])
    assert cr >= AA_NONTEXT, f"포커스 링 {light[token]} 대비 {cr:.3f}"


# ---- 최소 조작부 크기 (뒤에 오는 선언까지 본다) ----------------------------
_GUARANTEED_TARGETS = [
    ".card-actions button",
    ".seg button",
    ".range-group button",
    ".filters button",
    ".detail-close",
    ".method summary",
    ".warn-box > summary",
]


def _rules() -> list[tuple[str, str]]:
    """(선택자목록, 선언블록) 을 **파일 순서대로**. @media 안쪽도 포함한다."""
    css = _css()
    return [(m.group(1).strip(), m.group(2)) for m in
            re.finditer(r"([^{}@][^{}]*?)\{([^{}]*)\}", css, re.S)]


def _effective_height_floor(target: str) -> float | None:
    """해당 선택자에 걸리는 height/min-height 를 소스 순서대로 접어 마지막 값을 낸다.

    min-height 로 바닥을 깔아 두고 **뒤에서** height 로 덮으면 바닥은 무의미해진다 —
    이 계산이 그걸 잡는다.
    """
    floor: float | None = None
    for sels, decl in _rules():
        parts = [re.sub(r"\s+", " ", s).strip() for s in sels.split(",")]
        if target not in parts:
            continue
        for prop, val in re.findall(r"(min-height|height)\s*:\s*([\d.]+)px", decl):
            floor = float(val)
    return floor


@pytest.mark.parametrize("target", _GUARANTEED_TARGETS)
def test_small_controls_meet_minimum_target_size(target):
    floor = _effective_height_floor(target)
    assert floor is not None, f"{target} 에 높이 바닥이 선언돼 있지 않다"
    assert floor >= MIN_TARGET, f"{target} 의 최종 높이 {floor}px < {MIN_TARGET}px"


# ---- 모션 축소 ------------------------------------------------------------
def test_reduced_motion_stops_scroll_animation():
    """routeView() 가 화면 전환마다 scrollTo(0,0) 를 부른다 — scroll-behavior 가
    smooth 로 남아 있으면 모션을 끄라고 한 사용자에게 그 이동이 애니메이션으로 보인다."""
    css = _css()
    assert re.search(r"html\s*\{[^}]*scroll-behavior:\s*smooth", css), "전제가 깨졌다"
    blocks = re.findall(r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(.*?)\n\}", css, re.S)
    assert blocks, "prefers-reduced-motion 블록이 없다"
    assert any(re.search(r"html\s*\{[^}]*scroll-behavior:\s*auto", b) for b in blocks), \
        "모션 축소에서 scroll-behavior 를 auto 로 되돌리지 않는다"


# ---- 마을 장면 자동 순환 (실행해서 확인) -----------------------------------
# 사용자 지시(2026-08-04): "그냥 놔두면 15초 간격으로 낮↔밤이 바뀌고, 수기로 바꿔도
# 그대로 두면 15초 뒤 다시 바뀐다." 이 지시가 옛 규약 「자동 낮밤순환 금지」를 해제했다.
# 해제되지 않은 것이 `prefers-reduced-motion` 이라 그 가드가 여기 핵심이다.
# 소스 문자열이 아니라 **타이머와 틱 본문을 실제로 돌려서** 본다 — 상수 이름만 남기고
# 가드를 빼는 변경은 문자열 검사로 잡히지 않는다.

def test_scene_cycle_interval_is_fifteen_seconds(probe):
    """주기는 사용자가 정한 15초다. 임의로 고를 수 있는 수가 아니다."""
    s = probe["sceneCycle"]
    assert s["cycleMs"] == 15000
    assert s["timerMs"] == [15000], f"실제로 걸린 타이머 주기: {s['timerMs']}"


def test_scene_cycle_runs_only_when_the_village_is_actually_on_screen(probe):
    """가드 5개 — 정상 상태 하나만 참이어야 한다.

    보이지도 않는 지도를 15초마다 갈아끼우면 배터리와 디코딩만 태운다. 특히
    ③ 관문(암구호 입력 중)은 화면을 덮고 있어 눈에 보이는 변화가 배경뿐인데도
    전환 영상이 돌아 입력을 방해했다.
    """
    s = probe["sceneCycle"]
    assert s["allowedOnVillage"] is True, "정상 상태에서 자동 순환이 안 돈다"
    assert s["allowedWithGateOpen"] is False, "관문이 떠 있는데 순환이 돈다"
    assert s["allowedOffVillage"] is False, "섹션 화면인데 마을 순환이 돈다"
    assert s["allowedInBackgroundTab"] is False, "백그라운드 탭에서 순환이 돈다"
    assert s["allowedWhenNarrow"] is False, "지도가 숨겨진 좁은 화면에서 순환이 돈다"


def test_scene_cycle_respects_reduced_motion(probe):
    """`prefers-reduced-motion` 은 해제되지 않았다 — 자동 순환은 명백한 모션이다.

    배경 이미지 교체는 CSS 로 못 막으므로 **타이머를 만드는 지점에 JS 가드**가
    있어야 한다. 판정만이 아니라 타이머가 실제로 안 걸리는 것까지 본다.
    """
    s = probe["sceneCycle"]
    assert s["allowedUnderReducedMotion"] is False
    assert s["timersUnderReducedMotion"] == 0, "reduced-motion 인데 타이머가 걸렸다"


def test_scene_cycle_never_leaves_two_timers_running(probe):
    """재시작은 언제나 stop 이 먼저다.

    수동 토글·마을 복귀·visibilitychange 가 전부 restart 를 부르므로, 걷어내지 않으면
    타이머가 누적되어 15초가 7.5초·5초로 빨라진다(누적될수록 더 빨라진다).
    """
    s = probe["sceneCycle"]
    assert s["liveAfterStart"] == 1
    assert s["liveAfterRestart"] == 1, "restart 가 앞 타이머를 걷어내지 않는다"
    assert s["liveAfterStop"] == 0, "stop 이 타이머를 걷어내지 않는다"


def test_scene_tick_flips_the_scene_without_touching_the_chrome_theme(probe):
    """틱 한 번이 낮→밤을 실제로 바꾸되, 대시보드 명암은 건드리지 않는다.

    두 축이 다시 합쳐지는 것을 막는 자리다 — 합치면 15초마다 대시보드가
    밝아졌다 어두워지는 화면이 된다.
    """
    s = probe["sceneCycle"]
    assert s["sceneBefore"] == "day" and s["sceneAfterOneTick"] == "night"
    assert s["themeUntouchedByTick"] is None, "장면 전환이 명암 축을 건드렸다"


def test_scene_tick_is_a_noop_while_a_transition_is_playing(probe):
    """전환 연출(약 4초) 중에 다음 틱이 겹치면 화면이 얼어붙는다 — 실제로 난 사고다.

    겹친 틱은 `data-transition` 요소를 엇갈리게 만들고, 그러면 mountVillageVideo 의
    가드가 영구히 막혀 스스로 회복하지 못한다. sceneBusy 가 그 자리다.
    """
    s = probe["sceneCycle"]
    assert s["sceneAfterOverlappingTick"] == "night", (
        "전환 중에 들어온 틱이 장면을 또 바꿨다 — sceneBusy 가드가 없다"
    )


def test_a_stale_scene_timer_stops_itself(probe):
    """마을을 떠났는데 타이머가 남아 있으면, 그 틱이 스스로 자기를 걷어야 한다.

    routeView 의 정지 훅이 유일한 방어선이면 새 이탈 경로가 생길 때마다 훅을
    빠뜨린다. 틱 본문 안의 재확인이 2차 방어선이다.
    """
    s = probe["sceneCycle"]
    assert s["staleTickChangedScene"] is False, "마을 밖인데 장면이 바뀌었다"
    assert s["staleTickClearedItself"] is True, "떠난 뒤에도 타이머가 계속 산다"


def test_scene_cycle_follows_the_user_in_and_out_of_the_village(probe):
    """routeView 훅 — 섹션으로 나가면 멈추고 마을로 돌아오면 다시 건다."""
    s = probe["sceneCycle"]
    assert s["liveBeforeLeaving"] == 1, "마을에 있는데 자동 순환이 안 걸렸다(측정 전제)"
    assert s["liveOnSection"] == 0, "섹션으로 나갔는데 마을 타이머가 산 채로 남았다"
    assert s["liveBackOnVillage"] == 1, "마을로 돌아왔는데 자동 순환이 안 돈다"


def test_theme_button_says_what_it_will_do_on_this_screen(probe):
    """토글 버튼은 화면에 따라 하는 일이 다르다 — 라벨이 따라가야 한다.

    마을에서는 장면(낮↔밤), 섹션에서는 명암(라이트↔다크)이다. 라벨이 고정이면
    한쪽 화면에서는 "눌러도 아무 일이 없는 버튼"으로 읽힌다.
    """
    s = probe["sceneCycle"]
    assert "낮" in s["labelOnVillage"] and "밤" in s["labelOnVillage"], s["labelOnVillage"]
    assert "15초" in s["labelOnVillage"], "자동 순환을 알리지 않으면 고장으로 읽힌다"
    assert s["labelOnSection"] in ("화면을 밝게 전환", "화면을 어둡게 전환"), s["labelOnSection"]
    assert "마을" not in s["labelOnSection"], "섹션에서 마을 장면 라벨이 나온다"


def test_dark_is_the_default_with_no_attribute(probe):
    """대시보드 기본 배경은 검정이다(사용자 지시 2026-08-04).

    속성이 **없는** 상태가 다크여야 한다 — `data-theme="dark"` 를 달아서 맞추면
    저장값이 없는 첫 방문자가 라이트로 떨어진다.
    """
    s = probe["sceneCycle"]
    assert s["defaultThemeAttr"] is None, (
        f"첫 방문 시 data-theme 이 붙어 있다: {s['defaultThemeAttr']!r}"
    )
    assert s["defaultScene"] == "day", "마을은 낮에서 시작한다"


# ---- 외부 요청 0 ----------------------------------------------------------
def test_dashboard_makes_no_external_requests():
    """현재 외부 요청이 0 이다 — CDN·웹폰트가 새로 들어오면 여기서 막는다."""
    for f in (APP_JS, STYLE_CSS, INDEX_HTML):
        src = f.read_text(encoding="utf-8")
        src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        src = re.sub(r"(?m)^\s*//.*$", "", src)
        # www.w3.org/2000/svg 는 XML 네임스페이스 식별자다 — 네트워크로 나가지 않는다.
        hits = [h for h in re.findall(r"https?://[^\s\"')]+", src)
                if not re.match(r"https?://(127\.0\.0\.1|localhost|www\.w3\.org/)", h)]
        assert not hits, f"{f.name} 에 외부 주소가 있다: {hits[:5]}"


# ---- 테마 축 --------------------------------------------------------------
# 예전에는 다크 토큰이 **두 벌**(@media 안 + [data-theme="dark"])이라 한쪽만 고치면
# 조용히 갈라졌고, 그래서 `test_both_dark_token_blocks_agree` 로 두 벌이 같은지만
# 확인했다. 2026-08-04 지시로 다크가 기본값이 되면서 그 두 벌 자체가 사라졌다 —
# 즉 **대조할 쌍이 없어졌으므로 그 테스트는 이제 아무것도 지키지 못한다.**
# 그 자리를 아래 셋이 대신한다: ① 중복이 되살아나는 것을 막고 ② 토큰 집합이
# 갈라지는 것을 막고 ③ 마을 낮/밤이 다시 명암 축에 얹히는 것을 막는다.

def test_theme_is_a_single_attribute_axis():
    """명암은 `data-theme` **하나**로만 정해진다.

    `prefers-color-scheme` 이 되살아나면 토큰이 다시 두 벌이 되고(과거에 실제로
    프로덕션까지 갈라져 나갔다), `[data-theme="dark"]` 가 되살아나면 "속성 없음 =
    다크" 라는 기본값 규칙이 깨져 기본 화면과 토글 화면이 서로 다른 블록을 받는다.
    주석은 지우고 본다 — 위 설명문에 든 이름에 걸리면 안 되기 때문이다.
    """
    css = _css()
    assert "prefers-color-scheme" not in css, \
        "다크 토큰이 두 벌로 갈라진다 — 기본값은 :root 한 벌이어야 한다"
    assert '[data-theme="dark"]' not in css, \
        '다크는 속성이 없는 상태다 — [data-theme="dark"] 블록을 두면 기본값과 갈라진다'
    assert '[data-theme="light"]' in css, "밝은 테마 블록이 없다"


def test_theme_blocks_declare_the_same_token_set(dark, light):
    """다크(기본)와 라이트가 **같은 토큰 이름**을 선언해야 한다.

    값은 당연히 다르지만 집합이 갈라지면 한쪽 테마에서만 변수가 미정의가 되어
    `var(--x)` 가 조용히 빈 값으로 떨어진다. 값 비교로는 절대 안 잡히는 자리다.
    등급 칩(`--g-*`)처럼 뒤에 따로 붙는 블록까지 전부 모아서 본다.
    """
    per_selector: dict[str, set[str]] = {}
    for m in re.finditer(r'^(:root(?:\[data-theme="light"\])?)\s*\{([^}]*)\}', _css(), re.M):
        per_selector.setdefault(m.group(1), set()).update(re.findall(r"(--[\w-]+)\s*:", m.group(2)))
    assert set(per_selector) == {":root", ':root[data-theme="light"]'}, sorted(per_selector)
    d, l = per_selector[":root"], per_selector[':root[data-theme="light"]']
    assert len(d) >= 20, f"토큰을 제대로 못 읽었다: {len(d)}개"
    assert d == l, f"다크에만: {sorted(d - l)} / 라이트에만: {sorted(l - d)}"
    # 픽스처가 같은 블록을 보고 있는지 — 정규식이 어긋나면 위 검사가 무의미해진다.
    assert dark["--page"] != light["--page"], "두 픽스처가 같은 블록을 읽고 있다"


def test_village_scene_is_a_separate_axis_from_chrome():
    """마을의 낮/밤은 `data-scene`, 대시보드 명암은 `data-theme` — 축이 둘이다.

    사용자 지시(2026-08-04): "대시보드 배경은 검은색을 디폴트로, 메인화면의 낮과
    밤이랑은 별개로." 하나로 합치면 그 지시가 그대로 되돌아간다.
    마을 전용 규칙(지도 라벨·주변 효과)이 명암 축에 얹히는 것을 막는다.
    """
    css = _css()
    assert '[data-scene="night"]' in css, "마을 밤 규칙이 장면 축에 없다"
    village_on_theme = [
        m.group(0)
        for m in re.finditer(r'^:root\[data-theme="[a-z]+"\][^{\n]*\{', css, re.M)
        if re.search(r"\.vz|\.fx-|village", m.group(0))
    ]
    assert not village_on_theme, f"마을 규칙이 명암 축에 얹혀 있다: {village_on_theme}"


# ==========================================================================
# 환헤지 — 표시 문구가 산식·부호·단위와 어긋나지 않는가
#
# 이 블록은 "이름은 남기고 동작만 뒤집는" 회귀를 겨냥한다. 아래 여섯은 실제로
# 뮤테이션을 넣어 전부 빨간불이 되는 것을 확인한 자리다:
#   ① 받음/지불 방향 반전  ② τ = 만기/2 → 만기  ③ ±억원 계수 변조
#   ④ 참고치 하드코딩 복귀  ⑤ 만기 표기 삭제    ⑥ 표 서식 CSS 규칙 삭제
# ==========================================================================

def test_dom_assembled_tables_get_the_same_formatting_as_parsed_ones():
    """`thead`/`tbody` 없이 조립된 표에도 서식이 붙는가.

    `document.createElement("table")` 에 `<tr>` 을 직접 붙이면 HTML 파서와 달리
    브라우저가 `<tbody>` 를 끼워 넣지 않는다. 그래서 `thead th` · `tbody td` 규칙이
    그 표들에는 **한 줄도 적용되지 않고 있었다** — pristine 빌드 실측으로 환헤지 60칸,
    자산배분 42칸, 관계분석 15칸, 합계 `td.num` 117칸이 padding 1px · border 0px ·
    왼쪽 정렬이었다(같은 페이지의 파싱된 표는 정상이라 서식이 갈렸다).
    """
    css = STYLE_CSS.read_text(encoding="utf-8")
    for sel, must in (
        (r"table\s*>\s*tr\s*>\s*th", ("padding", "border-bottom")),
        (r"table\s*>\s*tr\s*>\s*td", ("padding", "border-bottom")),
        (r"table\s*>\s*tr\s*>\s*td\.num", ("text-align: right",)),
    ):
        m = re.search(sel + r"\s*\{([^}]*)\}", css)
        assert m, f"DOM 조립 표용 규칙이 없다: {sel}"
        for token in must:
            assert token in m.group(1), f"{sel} 에 {token} 이 없다"
    # 조립 표를 만드는 코드가 아직 tbody 를 안 쓴다는 전제 자체를 못박아 둔다.
    app = APP_JS.read_text(encoding="utf-8")
    assert 'el("table", { class: "mini-table" }' in app


def test_hedge_reference_numbers_all_come_from_the_payload(probe):
    """화면의 참고치는 전부 hedge.json 에서 나온다 — 하드코딩 0.

    픽스처는 실데이터와 다르다(주식 곡선 최소 15%, MVH 71~118%, 만기 6개월,
    최악의 달 2019-03, 최저월 2021-07). 예전에 박혀 있던 "채권 88~102% · 주식
    10~30%" · "2008년 최악의 달" · 굵은 행 "9개월" 이 살아 있으면 여기서 잡힌다.
    특히 주식 10% 는 **어느 산식에서도 나오지 않는 수**였다.
    """
    h = probe["hedgeScreen"]
    assert "71~118%" in h["headline"] and "15%" in h["headline"]
    assert "88~102" not in h["headline"] and "10~30" not in h["headline"]
    assert "71~118%" in h["views"] and "15%" in h["views"]
    assert "채권 50% · 주식 15%" in h["curveSub"]
    assert "2021-07" in h["costSub"] and "2008" not in h["costSub"]
    assert "2019-03" in " ".join(h["mtmHeader"])
    assert h["boldRowText"].startswith("6개월"), h["boldRowText"]
    assert probe["hedgeSim"]["eqRef"] == "경제 15% (변동성 최소)"


def test_hedge_cost_sign_direction_is_spelled_out_not_just_coloured(probe):
    """헤지비용 부호는 **글자**로 나온다 — 방향이 뒤집히면 즉시 빨간불.

    계약이 지목한 함정 자리다("MTM 손실은 스왑레이트 상승 시", 과거에 부호를 뒤집어
    최악월을 1.8배 과소 발표한 전력). 산식이 정하는 방향은 하나다: 캐리 = A × h × cost
    이므로 **양수 = 받음 / 음수 = 지불**.
    """
    h = probe["hedgeScreen"]
    assert h["signKey"] == "＋받음 −지불"
    # 픽스처: 엔 +3.25(받음) · 달러 −0.50(지불)
    assert "+3.25%" in h["jpyCost"] and "받음" in h["jpyCost"] and "지불" not in h["jpyCost"]
    assert "-0.50%" in h["usdCost"] and "지불" in h["usdCost"] and "받음" not in h["usdCost"]
    assert "＋받음 −지불" in " ".join(h["matrixHeader"])
    s = probe["hedgeSim"]
    assert "받음" in s["atDefault"]["jpyCost"] and "지불" in s["atDefault"]["usdCost"]
    assert "받음" in s["atDefault"]["carry"]          # 캐리 합계 +43억
    # MTM 최악의 달은 손실이므로 음수로 찍힌다
    assert all(v.startswith("−") for v in h["mtmWorst"]), h["mtmWorst"]


def test_mtm_tau_is_half_the_tenor_everywhere(probe):
    """τ(잔존만기) = 만기 ÷ 2. 표·캡션·시뮬레이터가 같은 정의를 쓴다."""
    h = probe["hedgeScreen"]
    assert h["mtmTau"] == ["0.125", "0.250", "0.375", "0.500"], h["mtmTau"]
    assert "만기 ÷ 2" in " ".join(h["mtmHeader"])
    assert "만기 ÷ 2" in h["method"]
    # 최악의 달 평가손도 τ 에 정비례한다: 3.3%p × τ
    worst = [float(v.replace("−", "").replace("%", "")) for v in h["mtmWorst"]]
    for tau, w in zip((0.125, 0.25, 0.375, 0.5), worst):
        assert abs(w - tau * 3.3) < 0.006, (tau, w)   # toFixed(2) 반올림 폭
    assert "잔존만기 τ = 만기 ÷ 2" in probe["hedgeSim"]["tenorNote"]


def test_amount_line_matches_its_own_stated_formula(probe):
    """±억원 줄은 화면에 적힌 세 수를 그대로 곱한 값이다 — 독립 재계산으로 대조.

    화면 문구("입력 금액 합계 × 변동성(소수 둘째 자리)")와 코드가 글자 단위로 같아야
    한다. 계수를 조금이라도 바꾸면(예: ×1.5, 또는 소수 첫째 자리로 반올림) 여기서 잡힌다.
    """
    s = probe["hedgeSim"]
    labels, cov = s["covLabels"], s["cov"]
    ix = {l: i for i, l in enumerate(labels)}
    amt, hs, tenor = s["amounts"], s["hs"], 6
    tau = tenor / 24
    n = len(labels)
    xe = [0.0] * n
    xa = [0.0] * n
    tot = 0.0
    rows = [("USD_b", "USD", "bond", 0.7), ("USD_e", "USD", "eq", 0.0), ("JPY_b", "JPY", "bond", 1.0)]
    for rid, cur, kind, q in rows:
        A, hh = amt[rid], hs[rid]
        eK = ix.get(f"e_{cur}")
        bK = ix.get("eq") if kind == "eq" else ix.get(f"b_{cur}")
        dsK = ix.get(f"ds_{cur}")
        tot += A
        if kind == "eq":
            xe[bK] += A; xa[bK] += A
            xe[eK] += A * (1 - hh); xa[eK] += A * (1 - hh)
        else:
            xe[bK] += A; xa[bK] += A * (1 - q)
            xe[eK] += A * (1 - hh); xa[eK] += A * (1 - hh)
        if dsK is not None:
            xa[dsK] += -A * hh * tau

    def sig(x):
        acc = sum(x[i] * x[j] * cov[i][j] for i in range(n) for j in range(n))
        return math.sqrt(max(acc, 0.0)) / tot * 100

    for key, vec in (("econAmt", xe), ("acctAmt", xa)):
        s2 = round(sig(vec), 2)
        want = f"{tot:,.0f}억 × {s2:.2f}% = ±{round(tot * s2 / 100):,.0f}억/년"
        assert s["atDefault"][key] == want, (key, s["atDefault"][key], want)

    # 같은 산식을 큰 금액에서 한 번 더 — 여기서는 「반올림한 σ」와 「원값 σ」의 곱이
    # 억 단위에서 갈라지므로, 문구("소수 둘째 자리")와 코드가 어긋나면 잡힌다.
    scale = s["bigAmounts"]["USD_b"] / amt["USD_b"]
    tot_b = tot * scale
    for key, vec in (("econAmt", xe), ("acctAmt", xa)):
        raw = sig(vec)                       # σ 는 금액에 비례하지 않는다 (비율이라 불변)
        s2 = round(raw, 2)
        want = f"{tot_b:,.0f}억 × {s2:.2f}% = ±{round(tot_b * s2 / 100):,.0f}억/년"
        assert s["atBig"][key] == want, (key, s["atBig"][key], want,
                                         "원값으로 곱했다면", round(tot_b * raw / 100))


def test_every_worked_number_names_the_tenor_it_used(probe):
    """만기를 밝히지 않은 헤지비용 문장은 없다.

    매트릭스는 12개월, 시뮬레이터 기본값은 실무 평균(픽스처 6개월)이라 같은 통화가
    다른 숫자로 보인다 — 그래서 **모든** 문장이 자기 만기를 들고 있어야 한다.
    """
    h, s = probe["hedgeScreen"], probe["hedgeSim"]
    assert "12개월" in " ".join(h["matrixHeader"])
    assert "12개월 만기로 헤지한다면" in h["lead"]
    assert "만기 6개월" in s["atDefault"]["costHead"]
    assert "만기 12개월" in s["at12"]["costHead"], "만기를 바꾸면 열 제목이 따라와야 한다"
    assert "만기 6개월로 양 끝을" in s["atDefault"]["span"]
    # 열의 값도 만기를 따라 바뀐다. 기대값은 픽스처 커브에서 **테스트가 직접** 보간한다
    # — hedgeCostAt 으로 계산하면 그 함수가 망가져도 양쪽이 함께 움직여 안 잡힌다.
    jpy = {"3M": 3.4, "6M": 3.3, "12M": 3.25}
    usd = {"3M": -0.6, "6M": -0.55, "12M": -0.5}

    def interp(c, m):
        x = min(12, max(3, m))
        if x <= 6:
            return c["3M"] + (c["6M"] - c["3M"]) * (x - 3) / 3
        return c["6M"] + (c["12M"] - c["6M"]) * (x - 6) / 6

    assert abs(s["jpyAt6"] - interp(jpy, 6)) < 1e-9, (s["jpyAt6"], interp(jpy, 6))
    assert abs(s["jpyAt12"] - interp(jpy, 12)) < 1e-9
    assert abs(s["usdAt6"] - interp(usd, 6)) < 1e-9
    assert f"+{interp(jpy, 6):.2f}%" in s["atDefault"]["jpyCost"], s["atDefault"]["jpyCost"]
    assert f"+{interp(jpy, 12):.2f}%" in s["at12"]["jpyCost"], s["at12"]["jpyCost"]
    assert s["atDefault"]["jpyCost"] != s["at12"]["jpyCost"], "만기를 바꿔도 값이 그대로다"
    assert f"{interp(usd, 6):.2f}%" in s["atDefault"]["usdCost"]


def test_hedge_cost_is_called_the_same_thing_on_every_screen():
    """이름은 파이프라인이 정한다 — 「헤지비용」 한 이름으로 통일.

    `pipeline/hedge.py` 는 이 양을 `cost_curve`/`cost_12m` 으로 담고 문서·`limits`
    문자열에서 「헤지비용」이라 부른다(`alloc.py` 도 같다). 화면이 「헤지 손익」 같은
    새 이름을 만들면 방법론 패널이 출력하는 `limits` 문장(「…헤지비용 데이터 확보
    전까지 비활성」)과 어긋나고, 같은 화면 MTM 카드의 「평가손익」과도 충돌한다.
    """
    app = APP_JS.read_text(encoding="utf-8")
    assert "헤지 손익" not in app, "파이프라인이 쓰지 않는 이름이 화면에 생겼다"
    assert 'const COST_SIGN_KEY = "＋받음 −지불"' in app
    # 부호 열쇠가 네 화면 모두에 닿는지 — 상수를 참조하는 자리 수로 확인한다
    assert app.count("COST_SIGN_KEY") >= 8, app.count("COST_SIGN_KEY")
    hedge_py = (ROOT / "pipeline" / "hedge.py").read_text(encoding="utf-8")
    assert "헤지비용" in hedge_py, "파이프라인 어휘가 바뀌었다면 화면 이름도 함께 봐야 한다"


def test_fx_screen_is_pure_market_data_after_the_migration():
    """#fx 는 순수 시세 화면이다 — 헤지 카드는 2026-08-04 에 #hedge 로 이관됐다.

    이관 전 이 테스트는 `<h2>FX · 환율과 스왑포인트</h2>` 를 단정했다. 그 제목이
    남아 있으면 스왑포인트가 없는 화면이 스왑포인트를 약속하는 셈이다.
    같은 이유로 `#fx` 안에는 부호 규약 문장도 남으면 안 된다 — 부호 있는 값이
    이 화면에 하나도 없기 때문이다(그 정적 문장은 오래 미검출로 남아 있던 자리다).
    """
    html = INDEX_HTML.read_text(encoding="utf-8")
    assert "<h2>FX · 환헤지</h2>" not in html, "제목이 환헤지 섹션과 겹친다"
    assert "<h2>FX · 환율</h2>" in html
    fx_sec = html.split('<section id="fx"', 1)[1].split("</section>", 1)[0]
    assert 'href="#hedge"' in fx_sec, "헤지비용을 찾는 사람을 보낼 곳이 없다"
    for gone in ("card-hedge-ts", "card-hedge-table"):
        assert gone not in fx_sec, f"{gone} 가 아직 #fx 에 있습니다"
    assert "받고" not in fx_sec and "냅니다" not in fx_sec, (
        "#fx 에 부호 규약 문장이 남아 있습니다 — 이 화면에는 부호 있는 값이 없습니다"
    )


def test_cross_screen_pointers_are_true():
    """"저쪽 화면에 있습니다" 류 문장이 **실제로** 그 화면을 가리켜야 한다.

    이관에서 가장 위험한 자리다 — 이런 문장은 공간적 주장인데 이를 지키는 테스트가
    한 건도 없었다(저장소 전체에 `card-hedge` 문자열 0건). 옮기고 문장을 안 고쳐도
    전부 초록이었다. 여기서는 `#<섹션>` 링크 옆에 "…화면" 이라고 적힌 문장을 찾아,
    그 섹션이 약속한 카드를 실제로 갖고 있는지 본다.
    """
    app = APP_JS.read_text(encoding="utf-8")
    html = INDEX_HTML.read_text(encoding="utf-8")
    fx_sec = html.split('<section id="fx"', 1)[1].split("</section>", 1)[0]
    hedge_sec = html.split('<section id="hedge"', 1)[1].split("</section>", 1)[0]
    # 이관 뒤 #fx 를 "…에 있습니다" 로 가리키는 문장이 남아 있으면 거짓말이다.
    stale = re.findall(r'href: "#fx" \}, "FX 화면"\), "?[^)]{0,40}있습니다', app)
    assert not stale, f"#fx 로 보내는 문장이 남아 있습니다: {stale}"
    # 반대로 새 카드는 실제로 #hedge 안에 있어야 한다.
    assert 'id="hedge-ts-card"' in hedge_sec, "이관된 커브 카드가 #hedge 에 없습니다"
    assert 'id="hedge-ts-card"' not in fx_sec


def test_hedge_matrix_covers_all_three_tenors(probe):
    """매트릭스가 3·6·12개월을 전부 싣는가 — FX 화면 표를 흡수한 결과.

    흡수 이유: 그 표의 12M 열과 매트릭스 12M 열이 **완전히 같은 숫자**였다(실측 4/4).
    한 화면에 나란히 놓으면 순수 잉여가 된다. 흡수하면서 이관 표에 없던
    캐나다달러·파운드의 3·6개월이 처음으로 화면에 나온다.
    """
    h = probe["hedgeScreen"]
    head = " ".join(h["matrixHeader"])
    for tenor in ("3개월", "6개월", "12개월"):
        assert tenor in head, f"매트릭스에 {tenor} 열이 없다: {head}"
    # 픽스처 커브가 만기마다 다른 값이므로, 세 열이 같은 값이면 같은 열을 세 번 그린 것이다
    assert h["jpyCost3m"] != h["jpyCost6m"] != h["jpyCost"], (
        f"세 만기 열이 같은 값이다: {h['jpyCost3m']} / {h['jpyCost6m']} / {h['jpyCost']}"
    )
    assert "+3.40%" in h["jpyCost3m"] and "+3.30%" in h["jpyCost6m"]
    # 커브가 없는 통화는 세 열 모두 대시 — undefined 가 나가면 안 된다
    assert h["cnyCost3m"] == "—", h["cnyCost3m"]


def test_matrix_states_its_own_sample_per_row(probe):
    """행마다 표본 구간·월수를 적는다. 두 표본이 다르면 **둘 다** 적는다.

    같은 행 안에서도 열마다 표본이 다르다 — `vol_e` 는 조인 전에, `mvh`/`corr` 은
    채권 프록시와 조인한 뒤에 계산되므로 짧은 쪽에 맞춰 잘린다(실데이터 실측:
    EUR·JPY 305 vs 294, AUD 267/267). 표에는 「변동성·MVH·상관 = 월간 수익률」
    한 줄만 있어 **같은 표본으로 읽혔다.** 파이프라인만 고치고 화면을 안 고치면
    조용히 무시되므로, 렌더된 글자를 본다.
    """
    h = probe["hedgeScreen"]
    assert "표본" in " ".join(h["matrixHeader"])
    # 두 표본이 같은 행: 한 줄로 줄어야 한다(같은 말을 두 번 적지 않는다)
    assert h["usdSample"] == "2002-01~2029-12 (294)", h["usdSample"]
    # 다른 행: 둘 다 적혀야 하고 월수도 각각 나와야 한다
    assert "305" in h["jpySample"] and "294" in h["jpySample"], h["jpySample"]
    assert "변동성" in h["jpySample"] and "MVH" in h["jpySample"], h["jpySample"]
    # 적합 표본이 없는 행: 변동성만
    assert h["cnySample"].startswith("변동성") and "MVH" not in h["cnySample"], h["cnySample"]


def test_migrated_curve_card_says_what_it_is_for(probe):
    """이관된 커브 카드는 "왜 여기 있는지"를 스스로 말해야 한다.

    시세로 읽히면 #fx 로 되돌아갈 이유가 생긴다. 이 카드가 여기 있는 이유는
    세 계열이 **시뮬레이터의 만기 보간이 쓰는 곡선의 원자료**이기 때문이고,
    그러므로 기본 만기(픽스처 6개월)를 문장이 들고 있어야 한다.
    """
    t = probe["hedgeScreen"]["tsCardText"]
    assert "커브 추이" in t, t[:80]
    assert "3·6·12개월" in t or "3개월" in t
    assert "6개월을 보간" in t, "무엇에 쓰는 원자료인지 말하지 않는다"
    assert "＋받음 −지불" in t, "부호 규약이 카드에 없다"


def test_inactive_row_state_is_not_conveyed_by_opacity_alone(probe):
    """비활성 통화 행: opacity .5 는 대비 3.67:1 로 AA 미달이었고 색만으로 상태를 전했다."""
    h = probe["hedgeScreen"]
    assert h["cnyClass"] == "row-off"
    assert not h["cnyStyle"] or "opacity" not in h["cnyStyle"]
    assert "계산 대상 아님" in h["cnyText"]
    css = STYLE_CSS.read_text(encoding="utf-8")
    assert re.search(r"\.mini-table tr\.row-off td\s*\{[^}]*var\(--ink-3\)", css)
    assert not re.search(r"\.grid-inp tr\.dis\s*\{\s*opacity", css)


def test_simulator_inputs_all_have_accessible_names(probe):
    """예전에는 <label> 도 aria-label 도 없어 화면낭독기에 "편집" 만 늘어섰다."""
    s = probe["hedgeSim"]
    assert s["total"] >= 12 and s["labelled"] == s["total"], s["labels"]
    assert all(lbl and lbl.strip() for lbl in s["labels"])
    assert "스왑 평균 만기(개월)" in s["labels"]


def test_hedge_screen_survives_a_thin_payload(probe):
    """필드가 빠진 payload 로도 'undefined'/'NaN' 을 화면에 찍지 않는다.

    참고치를 데이터에서 뽑기 시작하면 예전에는 불가능했던 실패 모드가 생긴다 —
    리터럴 "9개월" 은 undefined 가 될 수 없었다.
    """
    m = probe["hedgeMissingFields"]
    assert m["threw"] is None, m["threw"]
    assert not m["hasUndefined"], m["where"]


def test_macro_cards_keep_the_unit_the_pipeline_supplied(probe):
    """macro.json 의 unit("천명")을 버려 「최근 57.00」 같은 카드가 나오고 있었다."""
    subs = probe["macroUnit"]["subs"]
    assert "천명" in subs[0], subs
    assert subs[1].endswith("(2030-01-31)") and "4.20%" in subs[1]


def test_section_notes_define_their_own_jargon():
    """화면 안에서 정의되지 않은 약어를 남기지 않는다(#irs·#credit)."""
    html = INDEX_HTML.read_text(encoding="utf-8")
    irs = html.split('<section id="irs"', 1)[1].split("</section>", 1)[0]
    assert "1년 뒤 시작하는 1년짜리" in irs and "5년 뒤 시작하는 5년짜리" in irs
    credit = html.split('<section id="credit"', 1)[1].split("</section>", 1)[0]
    for term in ("IG", "HY", "CDS", "1bp = 0.01%p"):
        assert term in credit, term


def test_signed_number_text_uses_the_text_only_ink_tokens(light, dark):
    """헤지비용·캐리 숫자는 hover 되는 표 안에 있다 — 델타 글자와 같은 규칙을 받아야 한다.

    `--up`(#d03b3b)은 행 hover 틴트 위에서 4.35:1 로 AA 미달인 것이 이미 실측·테스트돼
    있고(그래서 -ink 토큰이 따로 있다), `.pos`/`.neg` 는 그 hover 틴트 위에 놓인다.
    실렌더 측정: 밝은 테마 pos 6.00 / neg 6.57, 어두운 테마 5.28 / 5.05 (전부 AA 통과).
    """
    css = STYLE_CSS.read_text(encoding="utf-8")
    m = re.search(r"\.pos\s*\{([^}]*)\}\s*\.neg\s*\{([^}]*)\}", css)
    assert m, ".pos/.neg 선언을 못 찾았다"
    assert "--down-ink" in m.group(1), m.group(1)
    assert "--up-ink" in m.group(2), m.group(2)
    for name, tk in (("light", light), ("dark", dark)):
        for ink in (tk["--up-ink"], tk["--down-ink"]):
            for surf in ("--page", "--surface"):
                bg = tk[surf]
                for label, b in ((surf, bg), (f"hover/{surf}", _blend(tk["--accent"], bg, 0.06))):
                    cr = contrast(ink, b)
                    assert cr >= AA_TEXT, f"[{name}] 부호 글자 {ink} on {label} = {cr:.3f}"


# ---- 렌더 격리 (실행해서 확인) ---------------------------------------------
def test_a_failing_renderer_does_not_take_the_rest_of_the_page_with_it(probe):
    """렌더러 하나가 던져도 **그 뒤 섹션이 그려져야** 한다.

    JSON 로딩과 파이프라인은 이미 격리돼 있었는데 렌더 계층에만 그 규약이 없었다.
    실측으로 index.html 의 id 하나(`#card-curve`)를 지우자 렌더된 섹션이 10 → 5 로
    줄었고(rates·irs·credit·fx·inflation·acwi·macro 전멸) 화면은 오류 없이 그냥
    비어 보였다. SECTION_IDS 순서상 macro 는 catalog 보다 앞이므로, macro 가 던진
    뒤 catalog 가 그려졌다면 격리가 실제로 작동한 것이다.
    """
    r = probe["renderIsolation"]
    assert r["laterSectionStillRendered"] is True, (
        "앞 섹션이 던지자 뒤 섹션이 안 그려졌다 — 격리가 없거나 깨졌다"
    )


def test_a_failing_section_says_it_is_broken(probe):
    """빈 화면은 "데이터가 없다"로 읽힌다 — 고장임을 글자로 적어야 한다.

    색만으로 알리지 않고(1.4.1), 어느 섹션인지와 "다른 화면은 정상"임을 함께
    적어 사용자가 새로고침 말고 무엇을 할지 알 수 있게 한다.
    """
    r = probe["renderIsolation"]
    assert r["failedSectionIsMarked"] is True, "실패한 섹션에 아무 표시가 없다"
    assert r["noticeMentionsTheSection"] is True, "안내가 어느 섹션인지 말하지 않는다"
    assert r["noticeSaysOthersAreFine"] is True, "안내가 나머지 화면의 상태를 말하지 않는다"
    assert r["noticeNotDuplicated"] is True, "다시 그릴 때마다 안내가 겹쳐 쌓인다"


def test_screen_says_how_the_cost_curve_was_read(probe):
    """헤지비용을 **어떻게 읽었는지**를 화면이 말해야 하고, 그 문자열은 파이프라인 값이어야 한다.

    최근 5영업일 중앙값은 최신 호가와 다른 숫자를 낸다(실데이터 9개월 −0.975 →
    −0.800). 화면이 "최신 호가"라고 계속 적으면 게시값과 설명이 어긋난다.
    화면에 문자열을 박으면 `HP_MEDIAN_N` 을 되돌려도 문장만 남으므로,
    파이프라인의 `cost_read.label` 을 그대로 쓰는지 본다 — 픽스처는 실데이터와
    **일부러 다른** 라벨을 태운다.
    """
    h = probe["hedgeScreen"]
    assert "프로브전용읽기" in h["matrixSub"], (
        f"매트릭스 부제가 파이프라인의 읽는 법을 쓰지 않는다: {h['matrixSub']}"
    )
    assert "최신 호가" not in h["matrixSub"], "읽는 법이 화면에 박혀 있다"
    assert "프로브전용읽기" in h["costNote"], (
        f"비용 이력 카드가 읽는 법을 박아 두고 있다: {h['costNote'][:120]}"
    )


def test_screen_falls_back_when_the_read_method_is_missing(probe):
    """`cost_read` 가 없는 옛 payload 로도 "undefined" 를 안 찍는다."""
    m = probe["hedgeMissingFields"]
    assert not m["hasUndefined"], m["where"]


def test_cost_history_card_states_its_series_and_span(probe):
    """「25년 평균」은 **하드코딩이었다.**

    표본이 늘거나 줄어도 문장이 25년에 멈춰 있으면 거짓이 된다 — 이 저장소는
    「주식 10%는 어느 산식에서도 나오지 않는 수」로 같은 사고를 한 번 겪었다.
    픽스처는 실데이터(25.2년 · 303개월)와 **일부러 다른** 값을 태운다.
    """
    h = probe["hedgeScreen"]
    assert "25년" not in h["costSub"], f"표본 길이가 화면에 박혀 있다: {h['costSub']}"
    assert "3년 평균" in h["costSub"], h["costSub"]
    assert "프로브전용계열" in h["costSub"], "계열명을 payload 에서 가져오지 않는다"
    assert "2027-01~2029-12" in h["costSub"] and "36개월" in h["costSub"], h["costSub"]


def test_mtm_card_states_its_own_sample(probe):
    """MTM 통계도 자기 표본을 밝혀야 한다 — σ 와 최악월이 표본에 통째로 의존한다.

    HP 로 통일했다면 이 표본이 302 → 21개월로 줄어 σ 를 54% 과소평가하고 최악월이
    +4.92%p(2008-12) → +0.41%p(2025-12) 로 12분의 1이 됐을 것이다. 그래서 이력은
    SMB 로 남겼고, 남긴 이상 무엇을 쓰는지 화면이 말해야 한다.
    """
    h = probe["hedgeScreen"]
    assert "프로브전용MTM계열" in h["mtmSub"], h["mtmSub"]
    assert "2027-02~2029-12" in h["mtmSub"] and "35개월" in h["mtmSub"], h["mtmSub"]


def test_cost_history_overlays_the_hp_series(probe):
    """"같은 성격, 다른 계열" 이라는 주장을 그림이 증명해야 한다.

    이 카드는 SMB 월말, 바로 위 표는 HP 일별이라 숫자가 다르다. 문장만 있으면
    독자는 둘 중 하나가 틀렸다고 읽는다 — HP 3M 을 보조선으로 겹치고, 겹치는
    구간의 실측 상관·평균차를 함께 적는다(추가 공개 없음 — 같은 값이 옆 카드에 있다).
    """
    h = probe["hedgeScreen"]
    t = h["costNote"]
    assert "보조선으로 겹쳐" in t, "HP 보조선 설명이 없다"
    assert "0.9644" in t, "겹치는 구간의 실측 상관이 없다"
    assert "수준은 HP, 이력은 SMB" in t, "역할 분담을 말하지 않는다"
    # 문장이 아니라 **차트에 실제로 그려진 계열**을 센다 — "겹쳐 그렸다"고 적어 두고
    # 안 그리는 변경은 문장 검사로는 통과한다(뮤테이션으로 실제로 확인했다).
    cost_chart = next((c for c in h["chartSeries"]
                       if any("SMB" in l for l in c["labels"])), None)
    assert cost_chart, f"비용 이력 차트를 못 찾았다: {h['chartSeries']}"
    assert len(cost_chart["labels"]) == 2, (
        f"HP 보조선이 차트에 없다 — 그려진 계열: {cost_chart['labels']}"
    )
    assert any("HP" in l for l in cost_chart["labels"]), cost_chart["labels"]


def test_migrated_curve_chart_draws_all_three_tenors(probe):
    """이관된 커브 카드가 3·6·12개월을 **실제로 세 계열로** 그리는가."""
    h = probe["hedgeScreen"]
    curve = next((c for c in h["chartSeries"]
                  if c["labels"] == ["3개월", "6개월", "12개월"]), None)
    assert curve, f"커브 차트를 못 찾았다: {h['chartSeries']}"
    assert curve["rows"] > 0, "커브 차트에 점이 하나도 없다"
