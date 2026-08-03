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
def light() -> dict[str, str]:
    return _tokens(r"^:root")


@pytest.fixture(scope="module")
def dark() -> dict[str, str]:
    """테마 토글로 고른 어두운 테마."""
    return _tokens(r'^:root\[data-theme="dark"\]')


@pytest.fixture(scope="module")
def dark_media() -> dict[str, str]:
    """OS 가 어두운 테마이고 사용자가 토글을 만진 적 없을 때 적용되는 블록.

    토큰이 **두 벌** 있다는 것이 함정이다 — 한쪽만 고치면 토글로 들어온 사람은
    괜찮고 OS 설정으로 들어온 사람만 깨진다. 뮤테이션으로 실제로 이 구멍을 확인했다
    (미디어쿼리 쪽 값만 되돌렸더니 테스트가 통과했다). 두 벌을 같이 본다.
    """
    return _tokens(r'^  :root:not\(\[data-theme="light"\]\)')


def test_secondary_text_passes_aa_on_every_surface_it_lands_on(light, dark, dark_media):
    """--ink-3 는 화면 설명글 대부분을 칠하는 색이다(전부 11.5~12.5px).

    페이지·카드면만 보면 놓친다 — 행 hover 틴트(accent 6%) 위에도 얹히므로
    네 바탕 모두에서 4.5:1 을 넘어야 한다. 예전 값 #898781 은 3.41:1 이었다.
    """
    for name, tk in (("light", light), ("dark", dark), ("dark-media", dark_media)):
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


def test_accent_text_and_filled_controls_pass_aa(light, dark, dark_media):
    """--accent 는 차트 색이라 못 건드린다. 글자용(--accent-ink)과 면용(--accent-solid)을
    따로 두고, 각각 대비를 만족해야 한다."""
    for name, tk in (("light", light), ("dark", dark), ("dark-media", dark_media)):
        for surf in ("--page", "--surface"):
            cr = contrast(tk["--accent-ink"], tk[surf])
            assert cr >= AA_TEXT, f"[{name}] --accent-ink on {surf} = {cr:.3f}"
        cr = contrast("#ffffff", tk["--accent-solid"])
        assert cr >= AA_TEXT, f"[{name}] 흰 글자 on --accent-solid = {cr:.3f}"
        # 채워진 컨트롤과 그 주변 면의 경계 (1.4.11)
        for surf in ("--page", "--surface"):
            cr = contrast(tk["--accent-solid"], tk[surf])
            assert cr >= AA_NONTEXT, f"[{name}] --accent-solid 경계 vs {surf} = {cr:.3f}"


def test_delta_text_passes_aa_including_the_hover_tint(light, dark, dark_media):
    """상승/하락 델타 글자(`▲ 8p`)는 요인 행 위에 있어서 hover 틴트가 깔린다.

    --up(#d03b3b) 은 정지 상태 4.56:1 로 겨우 통과하지만 hover 틴트 위에서는
    4.35:1 로 내려가 AA 미달이었다(실렌더로 측정). 그래서 글자 전용 --up-ink 를 뒀다.
    --up 자체는 칩 배경 틴트 등에서 계속 쓰이므로 값이 그대로여야 한다.
    """
    assert light["--up"] == "#d03b3b" and light["--down"] == "#1c5cab", "시장 관례 색은 그대로"
    for name, tk in (("light", light), ("dark", dark), ("dark-media", dark_media)):
        for ink in (tk["--up-ink"], tk["--down-ink"]):
            for where in ("--page", "--surface"):
                bg = tk[where]
                for label, b in ((where, bg), (f"hover/{where}", _blend(tk["--accent"], bg, 0.06))):
                    cr = contrast(ink, b)
                    assert cr >= AA_TEXT, f"[{name}] 델타 글자 {ink} on {label} = {cr:.3f}"


def test_chart_accent_token_is_untouched(light, dark, dark_media):
    """차트 색은 1비트도 바뀌면 안 된다 — 대비 개선이 데이터 표현을 건드리지 않았다는 증거."""
    assert light["--accent"] == "#2a78d6"
    assert dark["--accent"] == "#3987e5"
    assert dark_media["--accent"] == "#3987e5"


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


def test_both_dark_token_blocks_agree(dark, dark_media):
    """어두운 테마 토큰은 두 곳에 중복 기재돼 있다 — 토글용과 OS 설정용.

    한쪽만 고치면 들어온 경로에 따라 화면이 달라진다. 두 벌이 같은지 못박아 둔다.
    """
    keys = set(dark) & set(dark_media)
    assert len(keys) >= 10, "토큰을 제대로 못 읽었다"
    diff = {k: (dark[k], dark_media[k]) for k in keys if dark[k] != dark_media[k]}
    assert not diff, f"두 어두운 테마 블록의 값이 다르다: {diff}"


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
    assert "헤지비용 12개월" in " ".join(h["matrixHeader"])
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


def test_fx_and_hedge_screens_point_at_each_other():
    """#hedge 와 #fx 는 같은 값을 다른 이름으로 부르고 있었고 링크가 0개였다."""
    html = INDEX_HTML.read_text(encoding="utf-8")
    assert "<h2>FX · 환헤지</h2>" not in html, "제목이 환헤지 섹션과 겹친다"
    assert "<h2>FX · 환율과 스왑포인트</h2>" in html
    fx_sec = html.split('<section id="fx"', 1)[1].split("</section>", 1)[0]
    assert 'href="#hedge"' in fx_sec
    app = APP_JS.read_text(encoding="utf-8")
    assert '"통화별 스왑포인트 = 헤지비용 (연율)"' in app


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


def test_signed_number_text_uses_the_text_only_ink_tokens(light, dark, dark_media):
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
    for name, tk in (("light", light), ("dark", dark), ("dark-media", dark_media)):
        for ink in (tk["--up-ink"], tk["--down-ink"]):
            for surf in ("--page", "--surface"):
                bg = tk[surf]
                for label, b in ((surf, bg), (f"hover/{surf}", _blend(tk["--accent"], bg, 0.06))):
                    cr = contrast(ink, b)
                    assert cr >= AA_TEXT, f"[{name}] 부호 글자 {ink} on {label} = {cr:.3f}"
