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
    # timeout 은 성능 단정이 아니라 **행걸림 가드**다. CPU 스로틀링이 심한 컨테이너에서
    # 프로브가 100초를 넘는 것을 실측했다(GitHub 러너에서는 수십 초) — 120으로 두면
    # 느린 환경에서 117개가 가짜로 죽는다. 무한 대기만 막을 만큼 넉넉히 둔다.
    r = subprocess.run([node, str(PROBE)], capture_output=True, text=True, timeout=420)
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


# ---- 이벤트 브리핑 카드 + 기기 내 TTS (실행해서 확인) ------------------------
def test_brief_card_shows_the_pipeline_script_verbatim(probe):
    """원고는 파이프라인(risk.compose_brief)이 조립한다 — 화면은 표시·낭독만.

    문장이 한 글자라도 바뀌면 "원고와 타임라인이 어긋날 수 없다"는 계약이 깨진다.
    원고가 없으면(파이프라인 실패) 카드째 숨는다.
    """
    b = probe["eventsBrief"]
    assert b["hiddenWithoutBrief"] is True
    assert b["shownWithBrief"] is True
    assert b["linesVerbatim"] is True


def test_brief_tts_refuses_cloud_voices(probe):
    """기기 내(localService) 한국어 음성만 쓴다 — 사용자 승인 규약(2026-08-11).

    Chrome 의 "Google 한국의" 같은 클라우드 음성은 문장을 외부 서버로 보내므로
    「외부 요청 0」 규약을 조용히 깬다. 그 경우 재생하지 않고 이유를 화면에 적는다.
    """
    b = probe["eventsBrief"]
    assert b["cloudOnlyDisables"] is True, "클라우드 음성뿐인데 버튼이 살아 있다"
    assert b["cloudOnlyNoteShown"] is True and b["noteMentionsWhy"] is True
    assert b["cloudOnlySpeaks"] == 0, "클라우드 음성으로 재생했다 — 외부 요청 0 위반"


def test_brief_tts_reads_every_line_with_the_local_korean_voice(probe):
    b = probe["eventsBrief"]
    assert b["localEnables"] is True and b["noteHiddenWithLocal"] is True
    assert len(b["spokenTexts"]) == 4, "원고 문장 수와 발화 수가 다르다"
    assert b["allLang"] == ["ko-KR"]
    assert b["allLocalVoice"] is True, "클라우드가 목록 앞에 있으면 그쪽이 잡히는 회귀"
    assert b["pressedWhileSpeaking"] == "true"
    assert "정지" in b["labelWhileSpeaking"]


def test_brief_tts_stops_when_leaving_the_screen(probe):
    """재생 중 화면을 떠나면 목소리가 따라오지 않는다 (routeView 의 stopBrief).
    마지막 문장이 끝나도 스스로 정지 상태로 돌아온다."""
    b = probe["eventsBrief"]
    assert b["cancelledOnLeave"] is True
    assert b["pressedAfterLeave"] == "false"
    assert "듣기" in b["labelAfterLeave"]
    assert b["labelAfterEnd"] == b["labelAfterLeave"]


def test_brief_container_exists_in_markup():
    """프로브 뼈대가 아니라 실제 index.html 에도 컨테이너가 있어야 한다."""
    html = INDEX_HTML.read_text(encoding="utf-8")
    assert 'id="events-brief"' in html


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


# ---- 시뮬레이터 금액의 출처 (지시 3) ---------------------------------------
def test_amount_source_badges_match_the_value_used(probe):
    """배지가 **실제로 쓰인 금액의 출처**와 일치해야 한다.

    ① 표 직접 입력 ② 총자산 × 자산배분 비중 ③ 예시값. 배지와 값이 어긋나면
    배지가 거짓말이 되고, 그러면 "이 숫자 어디서 왔나"에 답할 수 없다.
    유도 매핑은 달러 두 줄뿐이다 — `iaw-alloc` 에 통화 구성 정보가 없기 때문이다
    (§7.3 미구현). 다른 통화는 유도하지 않고 0 으로 둔다.
    """
    a = probe["hedgeAmounts"]
    # ③ 아무것도 없으면 예시값
    assert a["sampleUsdB"] == 5000 and a["sampleUsdE"] == 3000
    assert a["sampleUsdBSrc"] == "예시값"
    # 총자산만 있고 자산배분 저장값이 없으면 유도할 수 없다 → 여전히 예시값
    assert a["aumOnlySrc"] == "예시값", "비중 없이 유도했다 — 어디서 온 수인가"
    # ② 유도: 20000 × (12+6)/100 = 3600, 20000 × 5/100 = 1000
    assert a["derivedUsdB"] == 3600, a["derivedUsdB"]
    assert a["derivedUsdE"] == 1000, a["derivedUsdE"]
    assert a["derivedUsdBSrc"] == "자산배분에서 유도"
    assert a["derivedUsdESrc"] == "자산배분에서 유도"
    # 통화 구성 정보가 없는 통화는 유도하지 않는다
    assert a["jpyAmt"] == 0 and a["jpySrc"] == "예시값"
    # 최초 렌더 시점 — 총자산을 아직 안 넣었으므로 예시값이다.
    # (이 확인이 없으면 배지를 상수로 박아 두는 변경이 통과한다 — 뮤테이션으로 확인했다.)
    assert a["badgeAtOpen"] == "예시값", a["badgeAtOpen"]
    assert a["badgeAtOpenJpy"] == "예시값", a["badgeAtOpenJpy"]
    # 화면에서도 같은 대응 — 총자산을 넣으면 칸과 배지가 함께 바뀐다
    assert a["rowAmtAfterAum"] == "3600", a["rowAmtAfterAum"]
    assert a["badgeAfterAum"] == "자산배분에서 유도", a["badgeAfterAum"]
    # ① 직접 고치면 그 값이 이기고 배지도 따라온다
    assert a["badgeAfterEdit"] == "우리 값", a["badgeAfterEdit"]


def test_hedge_inputs_never_leave_the_browser(probe):
    """시뮬레이터 입력은 이 브라우저를 벗어나지 않는다.

    사용자가 넣는 것은 **실제 운용 규모**다. "코드에 fetch 가 없다"가 아니라
    시뮬레이터를 실제로 굴리면서 네트워크 호출 횟수를 세고, 해시에 숫자가 실리지
    않는지 본다(딥링크로 값이 새는 경로 차단).
    """
    a = probe["hedgeAmounts"]
    assert a["fetchCalls"] == 0, f"시뮬레이터 실행 중 네트워크 호출 {a['fetchCalls']}건"
    assert a["hashHasNoNumbers"] is True, "URL 해시에 숫자가 실린다"
    assert a["aumInputExists"] and a["aumHasLabel"], "총자산 칸에 접근 가능한 이름이 없다"


def test_hedge_sim_does_not_write_alloc_storage(probe):
    """`iaw-alloc` 은 **읽기 전용**이다.

    `allocSaveState()` 가 저장 시 state 전체를 덮어쓰므로, hedge 가 alloc 에 쓰면
    자산배분 화면의 다음 저장에 조용히 지워진다 — 사라지는 쪽이 사용자가 자산배분
    화면에서 직접 넣은 값이라 특히 나쁘다.
    """
    a = probe["hedgeAmounts"]
    assert a["wroteAllocStore"] is False, "시뮬레이터가 자산배분 저장소에 썼다"
    assert a["storageKeysWritten"] == ["iaw-hedge-input"], a["storageKeysWritten"]
    assert a["savedTotalAum"] == 20000, "총자산이 hedge 저장소에 남지 않았다"


def test_no_dead_ternary_in_hedge_rows():
    """`m.active ? 0 : 0` 같은 죽은 삼항 재발 방지 — 읽는 사람을 오도한다."""
    src = APP_JS.read_text(encoding="utf-8")
    dead = re.findall(r"\?\s*([^:?\n]{1,20}?)\s*:\s*\1\s*[,;)]", src)
    assert not dead, f"양 가지가 같은 삼항: {dead}"


def test_every_row_sign_matches_the_computed_carry(probe):
    """행별 부호가 **계산된 값의 부호와 대응**해야 한다 (E-6).

    지금까지 이 자리는 "받음/지불 이라는 글자가 있는가"만 봤다. 그러면 부호를
    통째로 뒤집어도 글자는 남아 통과한다 — 이 저장소는 부호 반전으로 최악월을
    1.8배 과소 발표한 전력이 있다. 여기서는 같은 입력에서 산식이 내는 값
    (캐리 = 금액 × 헤지비율 × 헤지비용)과 화면에 찍힌 부호·크기를 대조한다.
    """
    for tenor_key in ("atDefault", "at12"):
        rows = probe["hedgeSim"][tenor_key]["perRow"]
        for rid, r in rows.items():
            shown, expect = r["shown"], r["expect"]
            neg_shown = shown.startswith("−")            # U+2212, carryTxt 가 쓰는 문자
            assert neg_shown == (expect < 0), (
                f"[{tenor_key}/{rid}] 화면 {shown!r} vs 계산값 {expect:.3f} — 부호가 어긋난다"
            )
            # 크기도 본다 — 부호만 맞고 값이 딴 데서 오면 안 된다(반올림 1억 허용)
            mag = float(re.sub(r"[^\d.]", "", shown) or 0)
            assert abs(mag - abs(expect)) <= 1.0, f"[{tenor_key}/{rid}] {shown} vs {expect:.3f}"
            # 비용 셀의 받음/지불도 같은 부호를 따른다
            word = "받음" if r["expectCost"] >= 0 else "지불"
            assert word in r["costShown"], (
                f"[{tenor_key}/{rid}] 비용 {r['costShown']!r} 이 {r['expectCost']:+.2f} 와 어긋난다"
            )


def test_receiving_currencies_list_only_contains_positive_costs(probe):
    """「받는 통화」 목록에 든 통화는 전부 `cost_12m > 0` 이어야 한다 (E-6).

    분류가 뒤집히면 "내는 통화"가 "받는 통화"로 발표된다. 픽스처는 엔만 양수다.
    """
    lead = probe["hedgeScreen"]["lead"]
    pos = [m["name"] for m in probe["hedgeScreen"]["matrixCosts"] if (m["cost"] or 0) > 0]
    neg = [m["name"] for m in probe["hedgeScreen"]["matrixCosts"] if (m["cost"] or 0) < 0]
    assert pos and neg, "테스트 전제가 깨졌다 — 픽스처에 양수·음수가 다 있어야 한다"
    recv = lead.split("받는 통화")[1].split("내는 통화")[0] if "받는 통화" in lead else ""
    assert recv, f"결론 상자에 「받는 통화」가 없다: {lead[:160]}"
    for name in pos:
        assert name in recv, f"{name}(양수)가 받는 통화 목록에 없다: {recv}"
    for name in neg:
        assert name not in recv, f"{name}(음수)가 받는 통화 목록에 있다: {recv}"


# ---- 미국 시장 폭 카드 (실행해서 확인) --------------------------------------
def test_breadth_card_draws_no_chart_from_a_single_observation(probe):
    """관측 1일이면 차트를 그리지 않는다.

    원본이 데일리 리포트라 이력은 날짜별 파일이 쌓여야 생긴다. 점 하나짜리
    차트는 정보가 0인데 화면에서는 "이력이 있다"로 읽힌다 — 보이는 것이 곧
    가진 것이어야 한다. 대신 왜 없는지와 어떻게 하면 생기는지를 글자로 적는다.
    """
    b = probe["breadth"]
    assert b["oneDayCharts"] == 0, "관측 1일인데 차트를 그렸다"
    assert b["oneDaySaysSoManyDays"] is True, "관측 일수를 화면에 적지 않는다"
    assert b["oneDaySaysItIsOneDayOnly"] is True, "하루치라는 사실을 말하지 않는다"
    assert b["twoDayCharts"] == 1, "이력이 2일인데 추이를 안 그린다"
    assert b["twoDayStillSaysOneDayOnly"] is False, "이력이 있는데 '하루치' 안내가 남았다"


def test_breadth_verdict_follows_the_numbers_not_a_fixed_string(probe):
    """판정 문구는 **두 수의 대소**에서 나와야 한다.

    이 카드가 답하는 질문은 "넓은 상승인가 좁은 상승인가" 하나다. 문구를 고정하면
    데이터가 반대로 가도 같은 말이 나가고, 그건 틀린 말이다. 같은 화면 코드에
    반대 상황을 태워 문구가 뒤집히는지 본다.
    """
    b = probe["breadth"]
    # 상승 우세(3.0배)인데 신고가 − 신저가가 음수 → 갈라짐
    assert b["verdictOnDivergence"] is True, "괴리 상황에서 갈라짐 판정이 안 나온다"
    # 같은 상승 우세인데 신고가가 더 많으면 → 넓은 상승
    assert b["verdictOnBroadRally"] is True, "정상 상황에서 판정이 안 바뀐다"


def test_breadth_chart_never_shows_an_internal_key_as_a_legend(probe):
    """범례에 `net_new_high_pct` 같은 **내부 키**가 찍히면 안 된다.

    이름을 만들 수 없는 계열은 "모든 숫자는 그 자리에서 한 줄로 설명한다" 규약을
    지킬 수 없으므로 아예 그리지 않는다(프로브에서 실제로 키가 찍혔던 자리다).
    """
    b = probe["breadth"]
    for chart in b["twoDaySeries"] + b["orphanSeries"]:
        for label in chart:
            assert not re.fullmatch(r"[a-z0-9_]+", label), f"내부 키가 범례에 있다: {label}"


def test_breadth_card_hides_itself_when_there_is_no_report(probe):
    """리포트를 안 올렸으면 카드를 숨긴다 — 빈 카드는 고장으로 읽힌다."""
    assert probe["breadth"]["hiddenWhenAbsent"] is True


# ---- 헤지 레버의 자유도 (실행해서 확인) --------------------------------------
def test_hedge_levers_collapse_to_one_axis_exactly(probe):
    """같은 Xe 를 만드는 (채권헤지, 주식헤지) 는 총위험이 **정확히** 같다.

    이 성질이 성립하는 한 "최적 헤지비율 (35%, 100%)" 처럼 한 점을 적는 것은
    무한한 동점 중 임의 선택이다 — 실제로 그렇게 적었다가 가장 반직관적인
    구석(주식 100% 헤지)이 화면에 나갔다. 문구가 아니라 **이 성질**이 근거이므로
    여기서 실행으로 잰다.
    """
    h = probe["hedgeXe"]
    assert h["tieCount"] >= 5, f"동률 능선 위의 표본이 너무 적다: {h['tieCount']}"
    # 항등식은 정확하지만 부동소수 합산 순서가 (hb,he)마다 달라 1 ULP(≈4e-16)가
    # 생길 수 있다 — 예시 비중이 42/18 이던 시절엔 우연히 정확히 0 이었다.
    # 1e-12 는 σ(≈수 %) 대비 10⁻¹⁰% 수준으로, 성질 위반과는 10자리 이상 떨어져 있다.
    assert h["tieSpread"] <= 1e-12, f"같은 Xe 인데 위험이 갈린다: {h['tieSpread']}"


def test_hedge_xe_quadratic_reproduces_the_risk_function(probe):
    """σ²(Xe) 계수를 3점으로 잡아낸 것이 sigmaHedge 와 일치해야 한다.

    로딩 산식을 화면에서 다시 쓰지 않았다는 증거다 — 다시 썼다면 둘이 갈라진다.
    """
    assert probe["hedgeXe"]["quadFitMaxErr"] < 1e-12


def test_hedge_closed_form_optimum_is_not_worse_than_a_grid(probe):
    """폐형 Xe* 가 격자 전수보다 낮거나 같다 — 격자 argmin 을 버린 근거."""
    assert probe["hedgeXe"]["closedFormBeatsGrid"] is True


def test_unhedged_foreign_equity_is_the_low_risk_side(probe):
    """해외주식은 달러/원과 음의 상관이라 **열어 두는 쪽**이 위험이 낮다.

    실무 통념(위험자산이 빠질 때 달러 강세가 완충)과 같은 방향이며, 화면이
    이것을 뒤집어 보여주던 것이 이 작업의 발단이다. 부호가 뒤집히면 실패한다.
    """
    h = probe["hedgeXe"]
    assert h["equityFullHedgeIsWorse"] is True, "전량헤지가 오픈보다 낫게 나온다 — 부호 확인"
    assert h["equityOnlyHedgePct"] < 50, (
        f"해외주식만 담은 포트폴리오의 위험최소 헤지비율이 {h['equityOnlyHedgePct']:.1f}% — "
        "자연헤지 방향과 반대다"
    )


def test_hedge_representative_pair_is_the_closest_feasible_point(probe):
    """동점 중 화면에 적는 한 점은 **현재값 최근접**이어야 한다(임의 계수 0개)."""
    h = probe["hedgeXe"]
    assert h["pairKeepsXe"] is True, "대표점이 목표 Xe 를 만들지 못한다"
    assert h["pairIsClosest"] is True, "더 가까운 실행 가능점이 있는데 다른 점을 골랐다"
    assert h["pairStaysPutWhenAlreadyOnTarget"] is True, (
        "현재값이 이미 최적 Xe 위인데 헤지비율을 움직이라고 한다"
    )


def test_hedge_bands_clip_and_report_infeasibility(probe):
    """밴드는 Xe 를 자르고, 만들 수 없는 Xe 는 조용히 아무 점이나 주지 않는다."""
    h = probe["hedgeXe"]
    assert h["bandClips"] is True
    assert h["bandActuallyBinds"] is True, "밴드를 걸었는데 아무것도 물지 않는다 — 검사가 무의미"
    assert h["infeasibleReturnsNull"] is True


def test_hedge_band_defaults_do_not_hardcode_an_institution(probe):
    """헤지 밴드 기본값은 **중립(0~100)** 이다 — 기관 내규는 공개 저장소에 박지 않는다."""
    assert probe["hedgeXe"]["defaultBandsAreNeutral"] is True, (
        f"기본 밴드가 중립이 아니다: {probe['hedgeXe']['bandsRead']}"
    )


def test_universe_is_single_market_value_7axis(probe):
    """장부가 축 제거(§7.7.11) — 우주는 시가 7축 하나이고, 구 저장분의 view:"acct" 가
    남아 있어도 장부가 축이 되살아나지 않는다(구 xeQuad 회계 가드는 관점 폐지와 함께
    내렸다 — 붕괴가 성립하지 않는 축 자체가 없어졌다)."""
    assert probe["hedgeXe"]["universeIs7"] is True
    assert probe["hedgeXe"]["noBookAxis"] is True


def test_no_arbitrary_flatness_threshold_survives():
    """「차이 0.02%p 미만이면 평평」 같은 **임의 임계값**을 되살리지 않는다.

    붕괴가 항등식이라 임계값 자체가 필요 없다 — 다시 등장하면 자의성 금지 위반이다.
    """
    src = (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")
    assert "사실상 평평합니다" not in src
    assert "hb_star" not in src and "he_star" not in src, (
        "동점 중 임의의 한 점이던 hb_star/he_star 가 화면 코드에 되살아났다"
    )


def test_lever_text_states_the_one_axis_not_a_single_optimal_pair(probe):
    """화면에 실제로 그려지는 문단을 읽는다 — 엔진이 옳아도 문구가 옛말이면 소용없다.

    P17 은 엔진만 본다. 이 검사는 #alloc 을 실제로 렌더해서 #alloc-levers 의
    텍스트를 읽으므로, "최적 헤지비율은 (35%, 100%)" 류가 되살아나면 잡힌다.
    """
    t = probe["hedgeLeverText"]
    assert t["rendered"] is True and t["renderErrors"] == 0
    assert t["mentionsXe"] is True, "총 미헤지 환노출(Xe)을 말하지 않는다"
    assert t["saysRiskIsOneAxis"] is True, "위험이 보는 축이 하나라는 사실을 적지 않는다"
    assert t["saysTiesAreEqual"] is True, "동점 조합의 위험이 같다는 사실을 적지 않는다"
    assert t["labelsPairAsRepresentative"] is True, (
        "헤지비율 쌍을 적으면서 그것이 **대표점**임을 밝히지 않는다 — 한 점을 최적으로 읽힌다"
    )
    assert t["noFlatnessThreshold"] is True


def test_lever_text_warns_when_the_band_is_what_picks_the_answer(probe):
    """밴드가 물면 그 사실을 화면에 적어야 한다 — 그 숫자는 모형이 아니라 내규가 정한 값이다."""
    assert probe["hedgeLeverText"]["warnsWhenBandBinds"] is True


# ---- ALM 듀레이션 갭 (실행해서 확인) ----------------------------------------
def test_asset_duration_is_computed_from_the_allocation(probe):
    """자산 듀레이션 = Σ(비중 × 자산군 듀레이션) — 손 재계산과 일치해야 한다.

    수기 `dur_asset` 한 칸만 쓰던 시절에는 배분을 바꿔도 갭이 그대로였다.
    갭 축소가 내부 목표인데 그러면 화면이 그 목표에 아무 답도 못 준다.
    """
    d = probe["durationGap"]
    assert abs(d["assetDuration"] - d["assetDurationHand"]) < 1e-12
    assert abs(d["gap"] - d["gapHand"]) < 1e-12
    assert d["movesWithAllocation"] is True, "배분을 채권 쪽으로 옮겼는데 자산 듀레이션이 안 는다"


def test_duration_inputs_are_never_invented(probe):
    """입력이 없으면 계산하지 않는다 — 0 이나 임의값을 만들어내지 않는다."""
    d = probe["durationGap"]
    assert d["nullWithoutInputs"] is True
    assert d["gapNullWithoutLiability"] is True


def test_equity_and_alternatives_carry_no_duration(probe):
    """주식·대체는 표준 근사대로 듀레이션 0 이다."""
    assert probe["durationGap"]["equityHasNoDuration"] is True


def test_foreign_bond_duration_can_be_separated(probe):
    """해외채권 듀레이션은 해외 금리 민감도라 원화 부채와 같은 위험요인이 아니다.

    사용자가 0 으로 두어 갭에서 뺄 수 있어야 하고, 빠지는 양이 정확히 그 항이어야 한다.
    """
    assert probe["durationGap"]["foreignCanBeExcluded"] is True


def test_duration_gap_is_shown_as_an_outcome_not_a_constraint(probe):
    """내규 한도가 없으므로 제약으로 걸지 않는다 — 화면이 그 사실을 밝혀야 한다.

    허용 괴리폭 α 를 지어내 제약으로 걸면 「자의성 금지」 위반이다.
    """
    d = probe["durationGap"]
    assert d["renderErrors"] == 0
    assert d["cardShown"] is True
    assert d["saysNotAConstraint"] is True, "갭이 제약이 아니라 결과 표시임을 화면이 말하지 않는다"
    assert d["showsReferenceGaps"] is True, "참고치 배분의 갭을 같이 보여주지 않으면 비교가 안 된다"


def test_alloc_state_survives_states_saved_by_older_versions(probe):
    """신규 입력 키가 없던 시절의 localStorage 로도 화면이 죽지 않아야 한다."""
    assert probe["durationGap"]["survivesLegacyState"] is True


# ---- 관문 암구호 (실행해서 확인) --------------------------------------------
def test_gate_asks_on_every_visit(probe):
    """통과 사실을 저장하지 않는다 — 사용자 지시(2026-08-05)로 접속할 때마다 묻는다.

    예전에는 localStorage `iaw-gate` 에 영구 저장해 **처음 한 번만** 물었다.
    "저장하지 않는다"는 문구가 아니라 동작으로 지켜져야 한다.
    """
    g = probe["passGate"]
    assert g["shownEvenWithLegacyKey"] is True, "예전 버전이 남긴 기억 키가 있으면 관문을 건너뛴다"
    assert g["legacyKeyCleared"] is True, "옛 키를 지우지 않으면 예전 방문자는 계속 통과된다"
    assert g["nothingRemembered"] is True, "통과 후 무언가를 저장한다 — 다음 접속에 안 묻게 된다"


def test_gate_rejects_a_wrong_passphrase(probe):
    """틀린 암구호는 막고, 그 사실을 화면에 적어야 한다."""
    g = probe["passGate"]
    assert g["wrongSettled"] is True, "제출 판정이 끝나지 않았다 — 검사가 성립하지 않는다"
    assert g["blockedOnWrong"] is True
    assert g["errShown"] is True
    assert g["errText"] == "암구호가 다릅니다.", g["errText"]


def test_gate_opens_on_the_right_passphrase(probe):
    g = probe["passGate"]
    assert g["rightSettled"] is True
    assert g["opensOnRight"] is True


def test_gate_forgives_stray_whitespace_but_not_case(probe):
    """암구호에 **공백이 들어 있다** — 앞뒤·연속 공백은 오타이지 다른 암구호가 아니다.

    반대로 대소문자까지 접으면 값 공간이 실제로 줄어드므로 접지 않는다.
    (모바일 자동 대문자화는 입력칸의 autocapitalize/autocorrect 로 막는다.)
    """
    g = probe["passGate"]
    assert g["sloppySettled"] is True
    assert g["opensOnSloppyWhitespace"] is True, "앞뒤·연속 공백 때문에 막힌다"
    assert g["caseStillMatters"] is True, "대소문자를 접고 있다 — 값 공간이 줄었다"


def test_gate_input_disables_mobile_autocapitalize():
    """공백이 든 암구호라 모바일 키보드가 첫 글자를 대문자로 바꾸면 그대로 막힌다."""
    html = (ROOT / "dashboard" / "index.html").read_text(encoding="utf-8")
    m = re.search(r"<input[^>]*id=\"gate-pw\"[^>]*>", html, re.S)
    assert m, "#gate-pw 입력칸을 찾지 못했다"
    assert 'autocapitalize="none"' in m.group(0), m.group(0)
    assert 'autocorrect="off"' in m.group(0), m.group(0)


def test_gate_uses_a_wide_hash(probe):
    """SHA-256 이어야 한다 — 옛 FNV-1a 32bit 은 값 공간이 43억뿐이라
    **충돌하는 다른 문자열로도 열렸다**. 알려진 시험 벡터로 구현 자체를 확인한다."""
    g = probe["passGate"]
    assert g["sha256Known"] == g["sha256Expected"], "SHA-256 구현이 표준 벡터와 다르다"
    assert g["hashIsWide"] is True, "관문 해시 상수가 64자리 16진수(SHA-256)가 아니다"


def test_recent_event_title_is_never_squeezed_to_one_character(probe):
    """긴 값이 붙은 이벤트에서 제목이 세로로 쌓이면 안 된다.

    실측 사고: 시장 폭 이벤트(값 문장이 길다)가 들어오자 `.evmini` 의 제목 span 이
    flex 기본 `min-width:auto` → min-content 로 풀려 **16px × 413px** 이 됐다
    (한글 한 글자씩 세로로). 값(`b`)이 `white-space:nowrap` 이라 행 폭을 다 먹은 탓이다.
    """
    css = (ROOT / "dashboard" / "style.css").read_text(encoding="utf-8")
    m = re.search(r"\.evmini\s*\{([^}]*)\}", css)
    assert m, ".evmini 규칙이 없다"
    assert "flex-wrap" in m.group(1) and "wrap" in m.group(1), (
        "`.evmini` 가 줄바꿈하지 않으면 긴 값이 제목을 min-content 까지 짜부라뜨린다"
    )
    t = re.search(r"\.evmini\s+\.t\s*\{([^}]*)\}", css)
    assert t, "`.evmini .t` 규칙이 없다 — 제목에 최소폭을 주지 않으면 다시 세로로 쌓인다"
    assert "min-width" in t.group(1), "`.evmini .t` 에 min-width 가 없다"
    # 값 셀이 nowrap 으로 되돌아가면 좁은 화면에서 카드를 뚫는다(실측 390px 에서 186px 넘침)
    for sel in [r"\.evmini\s+b", r"\.ecard\s+\.v"]:
        r = re.search(sel + r"\s*\{([^}]*)\}", css)
        assert r, f"{sel} 규칙이 없다"
        assert "nowrap" not in r.group(1), (
            f"{sel} 가 다시 nowrap 이다 — 좁은 화면에서 가로로 넘친다"
        )


def test_event_title_span_carries_the_class_the_css_targets():
    """CSS 가 `.evmini .t` 를 잡으므로 마크업이 그 클래스를 붙여야 한다.

    한쪽만 고치면 스타일이 조용히 안 걸리고 예전 증상으로 돌아간다.
    """
    src = (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")
    m = re.search(r"function evMini\(e\)\s*\{.*?\n\}", src, re.S)
    assert m, "evMini 를 찾지 못했다"
    assert 'class: "t"' in m.group(0), "evMini 의 제목 span 에 class:\"t\" 가 없다"


# ---- 벤치마크(CMA) 데이터층 — §7.7 1-2c (실행해서 확인) ----------------------
def test_cma_layer_is_default_and_falls_back_loudly(probe):
    """위험 원천은 CMA 가 기본이고, 비활성이면 **사유를 적으며** 프록시로 물러난다.

    조용한 대체는 금지다 — 어느 층으로 계산했는지 화면이 항상 밝혀야 한다.
    """
    c = probe["cmaLayer"]
    assert c["defaultLayerIsCma"] is True
    assert c["fallsBackWithoutCma"] is True
    assert c["fallbackKeepsReason"] is True, "폴백 사유(payload 의 reason)가 layerNote 에 없다"
    assert c["fallbackNoteRendered"] is True, "폴백 사유가 화면에 렌더되지 않는다"


def test_cma_matrix_entries_are_benchmark_covariances_verbatim(probe):
    """CMA 층의 행렬 원소가 벤치마크 공분산(+환노출 로딩) 손계산과 일치한다.

    프록시 재조립이 남아 있으면 여기서 갈라진다 — 층 스위치가 이름만 바꾸는
    회귀를 막는 자리다. 국내채권은 시가 쌍 통계를 받아야 한다(경제 관점 병합).
    """
    c = probe["cmaLayer"]
    assert c["domesticEquityVarExact"] is True
    assert c["foreignBondVarWithFxExact"] is True, "환노출 (1−h) 로딩이 행렬에 없다"
    assert c["krBondUsesMarketTwin"] is True


def test_cma_alt_factor_mapping_matches_closed_form(probe):
    """대체투자 분류별 매핑(§7.7.9 — 지분형 65/35·대출형 0/100) — 잔차분산까지 폐형
    손계산과 일치한다. 잔차는 두 팩터 스팬 회귀에서 오고 분류마다 **독립**으로
    들어간다 — 공유(완전상관)로 넣으면 네 행이 3차원에 갇혀 행렬이 도로 특이해진다
    (실측: 완전헤지 촐레스키 피벗 −2.3e−14). 잔차 없이 팩터만 넣어도 특이(−1.8e−18).
    """
    c = probe["cmaLayer"]
    assert c["idioIsPositive"] is True
    assert c["defaultMappingIsFiftyFifty"] is True, "기본 매핑이 50/50(기관 방식, 2026-08-12)이 아니다"
    assert c["altVarIsFactorPlusIdio"] is True
    assert c["altDebtVarIsFactorPlusIdio"] is True
    assert c["altClassCrossIsFactorOnly"] is True, "두 분류의 교차항은 팩터 교차만이어야 한다(잔차 독립)"
    assert c["altAggregateIdioIsIndependent"] is True, "합산 분산이 (w₁²+w₂²) 잔차와 어긋난다"
    assert c["altCrossIsFactorCross"] is True
    assert c["econMatrixIsPD"] is True, "잔차를 더했는데도 행렬이 정칙이 아니다"
    assert c["bmModeUsesRawAlt"] is True, "「벤치마크 그대로(진단)」 모드가 관측 σ 로 돌아가지 않는다"
    assert c["bmModeClassesIdentical"] is True, "bm 진단 모드에서 두 분류가 같은 행이 아니다"


def test_cma_mu_keyin_window_and_anchor(probe):
    """기대수익 키인 = 최종치(§7.7.10) · 디폴트 = 사용자 지정 CMA · 창 전환·기본 5년 ·
    앵커 σ 출처. 캐리 중복 가산이 되살아나면 사용자 정본 숫자가 화면에서 달라진다."""
    c = probe["cmaLayer"]
    assert c["muOverridePlain"] is True
    assert c["muOverrideIsFinal"] is True, "키인에 캐리가 다시 더해진다 — §7.7.10 최종치 계약 위반"
    assert c["defaultMuIsUserCma"] is True, "μ 디폴트가 사용자 지정 수치와 다르다"
    assert c["universeOrderIsEcon7"] is True, "우주가 시가 7축(삽입 위치 계약)이 아니다"
    assert c["windowSwitchChangesSample"] is True
    assert c["defaultWinIsFive"] is True, "위험 디폴트 창이 5년이 아니다"
    assert c["unpublishedWinFallsBackToLongest"] is True, "5년 창 미게시 시 최장 창 폴백이 깨졌다"
    assert c["anchorSigmaFromBm"] is True, "앵커 σ 가 활성 층(벤치마크)에서 오지 않는다"


def test_cma_xe_collapse_holds_and_hedge_is_live(probe):
    """CMA 층에서도 Xe 붕괴가 **정확히** 성립하고 헤지 슬라이더가 σ 를 움직인다."""
    c = probe["cmaLayer"]
    assert c["xeQuadExactOnCma"] is True
    assert c["hedgeSliderMatters"] is True


def test_book_axis_and_cap_book_are_gone(probe):
    """장부가 축 제거(§7.7.11) — 구 저장분의 cap_book 이 그룹을 되살리지 않고,
    view:"acct" 저장분으로도 단일 요약(회계 제목 없음)이 그대로 렌더된다."""
    c = probe["cmaLayer"]
    assert c["capBookGone"] is True, "폐지된 cap_book 그룹이 되살아났다"
    assert c["legacyViewSummaryHasReference"] is True
    assert c["legacyViewNoAcctTitle"] is True
    assert c["legacyViewRenderErrors"] == 0


def test_cma_screen_shows_layer_mapping_and_provenance(probe):
    """층 스위치·매핑 콘솔·[매핑] 출처 태그·환노출 근거·제외 자산군이 실제로 렌더된다."""
    c = probe["cmaLayer"]
    assert c["renderErrors"] == 0
    assert c["controlsShowSource"] is True
    assert c["controlsShowMapping"] is True
    assert c["controlsShowPerClassMapping"] is True, "매핑 콘솔에 지분형/대출형 분류가 없다"
    assert c["tableShowsMappingTag"] is True
    assert c["methodShowsFxBasis"] is True
    assert c["methodShowsExcluded"] is True
    assert c["headlineShowsLayer"] is True


def test_tv_lambda_utility_optimizer_is_sane(probe):
    """λ-효용 MVO — 단조성·목적함수 검산·같은 표본 = 같은 해.

    λ↑ 면 위험·기대수익이 함께 줄어야 하고(위험회피), λ=1 해는 λ=1 효용에서
    다른 해보다 낮지 않아야 하며, 같은 행렬에는 같은 답이 나와야 한다.
    """
    c = probe["cmaTv"]
    assert c["lambdaMonotoneRisk"] is True
    assert c["lambdaMonotoneReturn"] is True
    assert c["lambda1SolutionHasHigherUtility"] is True
    assert c["sameMatrixSameSolution"] is True


def test_tv_weights_respond_to_risk_structure_not_bands(probe):
    """시변의 요점 — σ 가 커진 자산의 비중이 실제로 줄어야 한다.

    단 밴드에 붙은 자산은 표본이 바뀌어도 못 움직인다(λ=1 의 국내주식 상한 붙음
    확인) — 방향성은 내부해가 되는 λ 에서 잰다. 이 구분이 없으면 "시변인데 왜
    안 움직이나"를 코드 결함으로 오진한다. 프로브는 μ 를 앵커 폴백으로 고정해
    잰다 — 검사 대상은 최적화기의 성질이지 μ 디폴트 숫자가 아니다(§7.7.10).
    """
    c = probe["cmaTv"]
    assert c["bandPinnedAtLowLambda"] is True
    assert c["riskierAssetGetsLess"] is True


def test_tv_card_renders_and_states_what_is_frozen(probe):
    """시변·창 민감도 카드 — 롤링 차트·창 표가 렌더되고, 고정된 입력(μ·제약·매핑·
    헤지)과 ①②와 다른 목적함수임을 화면이 스스로 밝힌다. 프록시 층에서는 안내문."""
    c = probe["cmaTv"]
    assert c["renderErrors"] == 0
    assert c["rollCardRendered"] is True
    assert c["saysInputsAreFrozen"] is True
    assert c["saysThirdObjective"] is True
    assert c["winModeRendersTable"] is True
    assert c["proxyLayerShowsGuidance"] is True


def test_char_metrics_match_hand_calc(probe):
    """포트폴리오 특성 — 샤프·E[MDD]·ρ(포트,자산)·상관 대각·분산비를 손계산과 대조.

    E[MDD] 상수 √(π/2)=1.2533 은 무추세 브라운 운동의 표준 결과이지 조정 모수가
    아니다. 분산비는 한 자산 몰빵에서 정확히 1 이어야 한다(분산효과 0 의 정의).
    """
    c = probe["allocChar"]
    assert c["sharpeHand"] is True
    assert c["emddHand"] is True
    assert c["rhoHand"] is True and c["rhoBounded"] is True
    assert c["corrDiagOnes"] is True
    assert c["drAtLeastOne"] is True
    assert c["drOneWhenConcentrated"] is True


def test_char_card_renders_with_honest_mdd_labels(probe):
    """특성 카드 — 샤프·분산비·효율 갭·상관 행렬이 렌더되고, MDD 는 정직하게 나뉜다.

    포트폴리오 MDD 는 [모형](실측 경로는 원본 미게시 계약상 불가), 자산별은 실측,
    매핑된 대체투자는 원지수 실측이 대표하지 않으므로 **비운다**.
    """
    c = probe["allocChar"]
    assert c["renderErrors"] == 0
    assert c["cardRendered"] is True
    assert c["mddLabeledAsModel"] is True
    assert c["showsEfficiencyGap"] is True
    assert c["hasCorrMatrix"] is True
    assert c["mappedAltRowCount"] == 2, "자산군 표에 대체투자 두 분류가 없다"
    assert c["mappedAltMddBlank"] is True


def test_alloc_toc_navigates_without_touching_the_hash(probe):
    """컨텐츠 탭 — 버튼 8개가 있고 눌러도 죽지 않는다.

    해시 앵커(href="#…")를 쓰면 섹션 라우팅 축과 충돌해 마을로 튕긴다 — 버튼 +
    scrollIntoView 여야 한다. index.html 쪽 검사는 계약 테스트(id 대조)가 맡는다.
    """
    c = probe["allocChar"]
    assert c["tocButtonCount"] == 9      # 시뮬레이터가 첫 항목 (§7.7.8)
    assert c["tocClicksSafe"] is True


def test_char_emdd_is_geometric_and_bounded(probe):
    """E[MDD] 는 기하 정합형 1−e^(−√(π/2)·σ√T) — 라벨("기하브라운")과 산식이 일치하고
    100% 상한이 구조적으로 지켜진다. 재점검 몬테카를로: 원식(1.2533·σ√T)은 주식
    몰빵+장기 표본에서 −100% 를 넘는 불가능한 낙폭을 표시했다."""
    c = probe["allocChar"]
    assert c["emddHand"] is True
    assert c["emddBelow100"] is True


# ---- 재점검(2026-08-11) 수정 — 축 부재·소독·정직 문구 (실행해서 확인) --------
def test_audit_no_fx_axis_means_no_hedge_reference(probe):
    """환율 축(_fx)이 없으면 모든 헤지비율이 동점 — 참고치를 내지 않고 사유를 적는다.

    재점검 실측: 예전에는 이 상태에서 "완전헤지 100/100 최적"이 나갔다 — 무한
    동점 중 임의 구석이며, 격자 argmin 사고(§7.5)와 같은 병의 재발이었다.
    """
    c = probe["cmaAudit"]
    assert c["fxLiveFalse"] is True and c["hedgeIsFlat"] is True
    assert c["noFxSummaryExplains"] is True
    assert c["noFxNoHedgeColumn"] is True
    assert c["noFxLeverExplains"] is True
    assert c["noFxSrcTagHonest"] is True, "출처 태그가 없는 환노출을 계속 주장한다"
    assert c["noFxRenderErrors"] == 0


def test_audit_missing_alt_axis_is_loud_and_full_hedge_stays_pd(probe):
    """_alt 부재 시 잔차 미가산을 화면이 밝히고, 잔차가 있으면 완전헤지에서도 정칙."""
    c = probe["cmaAudit"]
    assert c["noAltWarns"] is True
    assert c["noAltIdioZero"] is True
    assert c["pdAtFullHedge"] is True, "완전헤지(fx 로딩 0)에서 행렬이 특이 — 잔차 가산 확인"


def test_audit_state_sanitation_blocks_nan_propagation(probe):
    """손상 저장("abc" 상한·문자열 비중·숫자형 창 키)이 NaN 으로 퍼지지 않는다.

    재점검 실측: NaN 상한은 모든 비교를 통과해 참고치가 사유 없이 전부 "–"가 됐다.
    """
    c = probe["cmaAudit"]
    assert c["badCapSanitized"] is True
    assert c["stringMixCoerced"] is True
    assert c["numericWinCoerced"] is True
    assert c["sanitizedRenderErrors"] == 0 and c["sanitizedHasReference"] is True


def test_audit_honesty_badges(probe):
    """매핑 가중 합≠100 배지 · 목표 μ 도달 불가 문구 · 복구 시 고장 배너 제거."""
    c = probe["cmaAudit"]
    assert c["sumBadgeShown"] is True
    assert c["gapUnreachableFlagged"] is True, "밴드 밖 배분에서 효율 갭이 '같은 기대수익'이라 거짓말한다"
    assert c["bannerClearedAfterRecovery"] is True



# ---- 포트폴리오 시뮬레이터 §7.7.8 (실행해서 확인) -----------------------------
def test_sim_panel_redistribution_is_exact(probe):
    """「합계 100% 유지」 재분배 — 합 유지·값 고정·클램프·0-나머지 균등을 손계산 대조.

    명시적 모드이므로 몰래-맞추기 금지 규약과 충돌하지 않는다(기본은 자유 조정).
    """
    c = probe["simPanel"]
    assert c["lockKeepsSum"] is True and c["lockSetsValue"] is True
    assert c["lockValuesAre1dp"] is True, "재분배 결과가 0.1%p 단위가 아니다(2026-08-12)"
    assert c["lockClamps"] is True
    assert c["lockSplitsEquallyWhenOthersZero"] is True
    assert c["lockModeRedistributesInUi"] is True


def test_sim_panel_sigma_keyin_scales_variance_not_correlation(probe):
    """σ 키인의 계약 — 분산은 (키인/실측)² 배, **상관은 벤치마크 실측 ρ 불변**,
    앵커는 관측 σ 유지(출처 오염 금지). μ 키인(디폴트 포함)이 있으면 μ 는 최종치라
    σ 키인과 무관하고, μ 키인을 비운 폴백에서만 주식 μ(샤프×σ)가 유효 σ 를 따른다."""
    c = probe["simPanel"]
    assert c["sigmaScales"] is True
    assert c["corrPreserved"] is True, "σ 키인이 상관을 건드렸다 — 키인 σ × 실측 ρ 계약 위반"
    assert c["anchorUnpolluted"] is True
    assert c["equityMuFollowsKeyedSigma"] is True
    assert c["keyedMuUnaffectedBySigma"] is True, "키인 μ(최종치)가 σ 키인에 흔들린다"


def test_sim_panel_renders_bars_markers_donuts_cards(probe):
    """패널 렌더 — 목차 첫 버튼 = 시뮬레이터, 막대 7(시가 7축 — 장부가 축 제외),
    ▼ 마커 = λ-MVO 산출 위치, 도넛 2(최적·시뮬), 카드 2(최적·시뮬), 상관 정책 문구."""
    c = probe["simPanel"]
    assert c["renderErrors"] == 0
    assert c["tocFirstIsSim"] is True
    assert c["barCount"] == 7 and c["markerVisibleCount"] == 7
    assert c["donutCount"] == 2
    assert c["hasOptCard"] is True and c["hasSimCard"] is True
    assert c["statesCorrPolicy"] is True
    assert c["markerMatchesOptimum"] is True, "막대 위 ▼ 가 최적화 산출과 어긋난다"


def test_sim_panel_donuts_sit_under_their_cards(probe):
    """도넛 배치(2026-08-12 사용자 지시) — 최적 카드 아래 최적 도넛, 시뮬 카드 아래
    시뮬 도넛이 **같은 열**에 있고, 도넛이 210px 로 커졌다(구 132)."""
    c = probe["simPanel"]
    assert c["donutColumns"] == 2
    assert c["optDonutUnderOptCard"] is True, "최적 도넛이 최적 카드의 열에 없다"
    assert c["simDonutUnderSimCard"] is True, "시뮬 도넛이 시뮬 카드의 열에 없다"
    assert c["donutSize"] == 210


def test_sim_panel_alt_sigma_keyin_is_owned_by_the_mapping(probe):
    """CMA 층에서 대체투자 두 분류의 σ 키인만 비활성 — 위험은 분류별 매핑 콘솔이
    정하고, 두 회계 키가 같은 벤치마크 라벨을 공유해 σ 배율이 충돌하기 때문이다."""
    assert probe["simPanel"]["cmaAltSigDisabled"] is True


def test_sim_optimum_is_pinned_to_target_total(probe):
    """① 최적은 목표 합계 100% 기준 — 자유 조정으로 합계가 표류해도 흔들리지 않는다.

    2026-08-12 사용자 발견: 예산이 현재 합계를 따라가 μ·σ 를 안 건드려도 드래그마다
    "최적"이 움직였다. 엔진(같은 해)과 화면(▼ 위치 불변) 둘 다 실행으로 잰다.
    """
    c = probe["simPanel"]
    assert c["optimumIgnoresMixDrift"] is True, "합계 표류가 최적 해를 바꾼다 — 예산이 목표 100%에 고정되지 않았다"
    assert c["optMarkersStableUnderDrift"] is True, "드래그 후 ▼ 마커가 움직였다"


def test_sim_apply_optimum_button(probe):
    """「막대를 최적 비중으로」 — 누르면 막대 = 최적 해, 합계 정확히 100(경고 없음),
    그리고 저장되지 않는다(조정/저장 분리 승계 — 저장은 명시적 버튼만)."""
    c = probe["simPanel"]
    assert c["applyButtonExists"] is True
    assert c["applyMakesSum100"] is True
    assert c["applyMatchesOptimum"] is True
    assert c["applyValuesAre1dp"] is True, "최적 적용 결과가 0.1%p 단위가 아니다(2026-08-12)"
    assert c["applyClearsSumWarning"] is True
    assert c["applyDoesNotSave"] is True, "최적 적용이 몰래 저장한다 — 조정/저장 분리 위반"


def test_sim_sigma_placeholder_reads_as_applied(probe):
    """위험 칸의 회색 숫자는 장식이 아니라 **적용 중인 실측 σ** 다 — "적용 중"이 붙어
    미반영으로 오독되지 않아야 한다(2026-08-12 사용자 질문). 실제 반영 여부 자체는
    행렬 원소 = 벤치마크 공분산 손계산(cmaLayer 프로브)이 별도로 고정한다."""
    assert probe["simPanel"]["sigPlaceholderSaysApplied"] is True


def test_lambda_is_selectable_and_monotone(probe):
    """λ(위험회피계수) 선택 — 2026-08-12 사용자 지시.

    λ 는 관측되지 않는 선호 모수라 **권장 상수를 코드에 박지 않는다**(자의성 금지).
    대신 ① 화면에서 고를 수 있고 ② σ*(λ) 가 단조 감소하며 ③ 관측 앵커(현재 위험)를
    재현하는 λ 를 역산해 준다. 이 셋이 깨지면 λ 는 "아무 숫자나 넣는 칸"이 된다.
    """
    c = probe["lambdaControl"]
    assert c["sigmaMonotoneInLambda"] is True, "λ↑ 인데 최적 위험이 줄지 않는다 — 이분법 전제 붕괴"
    assert c["sigmaActuallyMoves"] is True, "λ 를 바꿔도 최적이 움직이지 않는다"
    assert c["inputExists"] is True
    assert c["savesImmediately"] is True, "λ 는 모형 입력이라 즉시 저장돼야 한다(비중과 반대)"
    assert c["optimumFollowsLambda"] is True, "화면의 최적 카드가 λ 를 따라가지 않는다"
    assert c["badLambdaSanitized"] is True
    assert c["renderErrors"] == 0


def test_lambda_reverse_optimization_reproduces_risk(probe):
    """「현재 위험과 같은 λ 찾기」 — 역산값을 **다시 최적화에 넣어** 위험을 대조한다.

    손계산 상수 없이 왕복으로 재는 자기무결성 검사다. 도달 불가한 목표는 끝값을
    조용히 "정답"이라 적지 않고 bounded 로 알려야 한다(정직성).
    """
    c = probe["lambdaControl"]
    assert c["fitFound"] is True
    assert c["fitReproducesSigma"] is True, "역산 λ 가 목표 위험을 재현하지 못한다"
    assert c["fitLambdaCloseToTruth"] is True, "왕복 역산이 원래 λ 로 돌아오지 않는다"
    assert c["boundedHigh"] is True and c["boundedLow"] is True, "도달 불가를 bounded 로 알리지 않는다"
    assert c["rejectsBadTarget"] is True
    assert c["fitButtonExists"] is True
    assert c["fitButtonSavedLambda"] is True
    assert c["fitButtonReproducesCurrentRisk"] is True, "버튼이 저장한 λ 가 현재 위험을 재현하지 못한다"


def test_sim_panel_proxy_layer_degrades_loudly(probe):
    """프록시층 — σ 키인 7칸 전부 비활성 + 최적 「보류」 안내(조용한 강등 금지)."""
    c = probe["simPanel"]
    assert c["proxySigDisabled"] is True
    assert c["proxyOptDeferred"] is True


def test_alt_split_legacy_state_migrates_preserving_totals(probe):
    """§7.7.9 이관 — 구 저장분의 단일 「대체투자」 키가 분할 축으로 옮겨진다:
    비중은 합계 보존 분할, μ 키인은 두 분류 복사(어떤 분할에서도 합계 μ 보존),
    σ 키인·구 매핑은 폐기(새 정본이 화면에 그대로 보이므로 조용한 변경이 아니다)."""
    c = probe["cmaAudit"]
    assert c["migSplitsMixPreservingSum"] is True
    assert c["migCopiesMuToBothClasses"] is True
    assert c["migDropsLegacySigOver"] is True
    assert c["migMapsBandsToEquityClass"] is True
    assert c["migAltMapGetsClassKeys"] is True
    assert c["migRenderErrors"] == 0


def test_20260812_migration_loan_defaults_and_map(probe):
    """2026-08-12 이관 — 대출금 강제 0(7개 자산군 합 100), 구 「예시」 그대로인
    저장분만 새 예시(합 100)로 교체, 구 매핑 기본값(65/35·0/100)은 새 기본 50/50 으로,
    μ 미입력은 사용자 지정 디폴트로 채움. 사용자가 만진 값은 건드리지 않는다.
    장부가 축 제거(§7.7.11) — 회계 9축 저장분은 채권 쌍 합산으로 접히고(합계 보존),
    구 스키마 키(mix_acct·bands_acct·by_kr·by_fx·view)는 폐기된다."""
    c = probe["cmaAudit"]
    assert c["migLoanForcedZero"] is True
    assert c["migOldExampleMixReplacedTo100"] is True
    assert c["migOldDefaultMapBecomesFiftyFifty"] is True
    assert c["migFillsMuDefaults"] is True
    assert c["migDropsLegacyFields"] is True, "구 스키마 키가 저장 상태에 남아 다음 저장을 오염시킨다"
    assert c["migFoldsBondPairs"] is True, "회계 9축 저장분이 시가 7축으로 접히지 않는다"
    assert c["migKeepsUserTunedMap"] is True


def test_mu_default_updates_reach_untouched_keys(probe):
    """게시 디폴트를 갱신하면 **사용자가 손대지 않은 칸**만 따라와야 한다.

    2026-08-12 실측 사고: 옛 저장분이 새 μ 디폴트를 영영 덮어 대체투자 두 분류가
    같은 값(4.39)으로 굳어 있었다 — 지분형 게시 디폴트는 6.86. `mu_dflt` 스냅숏이
    "우리가 채운 값"과 "사용자 키인"을 구분해 이 전파를 가능하게 한다.
    """
    c = probe["cmaAudit"]
    assert c["dfltFillsAndStamps"] is True
    assert c["dfltUpdatePropagates"] is True, "디폴트를 바꿔도 옛 저장분이 계속 덮는다"
    assert c["dfltKeepsUserKeyedValue"] is True, "사용자가 키인한 값을 디폴트가 덮어썼다"


def test_stale_state_is_visible_and_resettable(probe):
    """스냅숏이 없는 옛 저장분은 **조용히 덮어쓰지 않는다**(사용자 입력일 수 있으므로).
    대신 화면이 「디폴트와 다름」을 표시하고, 명시적 버튼이 한 번에 정리한다."""
    c = probe["cmaAudit"]
    assert c["legacyStaleStateSurvivesUntilReset"] is True
    assert c["offDefaultIsMarked"] is True, "디폴트와 다른 키인 값이 화면에 표시되지 않는다"
    assert c["muResetButtonExists"] is True
    assert c["muResetRestoresDefaults"] is True
    assert c["muResetClearsSigOver"] is True, "σ 키인이 비워지지 않아 실측 디폴트로 못 돌아간다"


def test_sum_badge_drops_the_loan_clause(probe):
    """합계 배지에 「대출 N% 제외」 문구가 없어야 한다 — 대출금은 배분 우주에서 제외됐다."""
    assert probe["simConsole"]["badgeHasNoLoanClause"] is True


# ---- 통화 구성 (실행해서 확인) ----------------------------------------------
def test_currency_mix_is_empty_until_the_user_enters_it(probe):
    """벤치마크를 몰래 적용하지 않는다 — 기본은 미입력이다.

    기관 실제 비중은 수기입력이고, 벤치마크는 사용자가 「채우기」를 눌러야 들어간다.
    """
    assert probe["ccyMix"]["emptyByDefault"] is True


def test_currency_set_matches_the_hedge_model():
    """화면의 통화 집합이 hedge.py CURRENCIES 와 같아야 한다.

    한쪽만 늘리면 입력칸은 생기는데 계산이 못 받는 통화가 조용히 생긴다.
    """
    src = (ROOT / "pipeline" / "hedge.py").read_text(encoding="utf-8")
    m = re.search(r"^CURRENCIES\s*=\s*\[([^\]]*)\]", src, re.M)
    assert m, "hedge.py CURRENCIES 를 찾지 못했다"
    py = [x.strip().strip('"\'') for x in m.group(1).split(",") if x.strip()]
    assert probe_currencies() == py, f"화면 {probe_currencies()} vs hedge.py {py}"


def probe_currencies():
    src = (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")
    m = re.search(r"const ALLOC_CCY\s*=\s*\[([^\]]*)\]", src)
    assert m, "app.js ALLOC_CCY 를 찾지 못했다"
    return [x.strip().strip('"\'') for x in m.group(1).split(",") if x.strip()]


def test_currency_coverage_is_counted_not_hidden(probe):
    """합계를 100%로 강제하거나 임의 비례배분하지 않는다.

    모형이 덮지 못하는 부분(원화·기타)을 따로 세어야 커버리지가 화면에 드러난다.
    부분 입력이면 부분 합계 그대로여야 한다.
    """
    c = probe["ccyMix"]
    assert c["bondTotal"] == 100 and c["eqTotal"] == 100, "벤치마크 표가 100%로 안 맞는다"
    assert c["bondInModel"] + c["bondKrw"] + c["bondOther"] == c["bondTotal"]
    assert c["partialStaysPartial"] is True, "부분 입력을 100%로 부풀리고 있다"


def test_bond_currency_evidence_is_stronger_than_equity(probe):
    """채권은 표시통화 직접 집계(커버리지 ~95%), 주식은 국가→통화 근사(~81%)다.

    이 차이를 화면이 숨기면 두 값이 같은 품질로 읽힌다.
    """
    c = probe["ccyMix"]
    assert c["bondCoverageBeatsEquity"] is True
    assert c["bondInModel"] > 90, c["bondInModel"]
    assert c["eqInModel"] < 90, c["eqInModel"]


def test_currency_state_survives_older_saved_states(probe):
    assert probe["ccyMix"]["legacyStateGetsCcy"] is True


def test_benchmark_currency_tables_carry_provenance():
    """공개 벤치마크 값은 **출처·기준일·근거 방식**을 함께 싣는다.

    두 표의 기준일이 다르고(채권 2026-08, 주식 2026-06) 근거 품질도 다르므로,
    숫자만 두면 같은 자료로 오해된다.
    """
    src = (ROOT / "pipeline" / "alloc.py").read_text(encoding="utf-8")
    m = re.search(r"CCY_BENCH\s*=\s*\{.*?\n\}", src, re.S)
    assert m, "CCY_BENCH 를 찾지 못했다"
    block = m.group(0)
    for sleeve in ["해외채권", "해외주식"]:
        assert sleeve in block
    for field in ['"asof"', '"src"', '"basis"', '"krw"', '"other"']:
        assert field in block, f"CCY_BENCH 에 {field} 가 없다"
    # 기관 내부 정보가 섞여 들어가지 않았는지 — 공개 저장소 가드
    assert "우정" not in block and "보험사업단" not in block


def test_manual_input_fields_are_labelled_for_screen_readers():
    """수기 입력칸은 aria-label 을 갖는다 — 표의 행 머리글은 자동으로 이어지지 않는다."""
    src = (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")
    m = re.search(r"const numIn = \(.*?\n    \};", src, re.S)
    assert m, "numIn 을 찾지 못했다"
    assert "aria-label" in m.group(0), "numIn 이 aria-label 을 붙이지 않는다"
    assert '"id"' in m.group(0) or "id:" in m.group(0), "numIn 이 id 를 붙이지 않는다"


def test_gate_binds_its_submit_listener_only_once(probe):
    """bindGate 를 두 번 불러도 리스너는 한 벌이어야 한다.

    두 벌이면 제출 한 번에 async 핸들러가 두 번 돌고, 늦게 끝난 쪽이 뒤늦게
    관문 상태를 덮어써 판정이 뒤집힌다 — 실제로 이 검사가 간헐 실패해서 찾았다.
    """
    assert probe["passGate"]["listenerBoundOnce"] is True


# ---- 시뮬레이션 콘솔 (실행해서 확인) — 담당자의 두 메인 용례 ------------------
def test_summary_answers_both_optima_in_one_table(probe):
    """기능 1: "최적 배분·최적 헤지가 얼마인가"의 답이 최상단 표 **한 자리**에 있다.

    예전에는 최적 배분이 카드·표에, 최적 헤지가 레버 **문단 속**에 흩어져 있었다.
    """
    s = probe["simConsole"]
    assert s["summaryRendered"] is True
    assert s["summaryHasBothAnswers"] is True, "요약에 배분 참고치와 헤지(Xe·대표점)가 함께 없다"


def test_summary_admits_the_answers_are_partial_optima(probe):
    """배분 참고치는 헤지 고정, 헤지 참고치는 배분 고정 — **동시 최적해가 아니다.**

    이 사실을 숨기면 두 부분해가 동시해로 읽힌다(패널 검증에서 동시화 순이득
    +0.38%p·|t| 4.13 이 확인돼 있으므로 차이는 실재한다).
    """
    assert probe["simConsole"]["summaryAdmitsPartiality"] is True


def test_allocation_inputs_recalc_immediately_without_saving(probe):
    """기능 2: 배분을 바꾸면 **즉시** 다시 계산되고, 저장은 일어나지 않는다.

    예전 동선은 수기입력 오버레이 → 저장 → 복귀의 왕복이라 시뮬레이션이 아니라
    설정 변경이었다. 조정과 저장의 분리가 이 콘솔의 계약이다.
    """
    s = probe["simConsole"]
    assert s["mixInputExists"] is True
    assert s["recalcIsImmediate"] is True, "배분 입력이 즉시 반영되지 않는다"
    assert s["notSavedOnChange"] is True, "조정이 몰래 저장된다 — 저장은 버튼으로만"
    assert s["sliderNotAutoSaved"] is True, "헤지 슬라이더가 예전처럼 자동 저장한다"


def test_adjustment_is_visibly_marked_and_compared_to_baseline(probe):
    """조정 중임이 배지로 보이고, 요약에 기준(저장값) 행이 함께 나타나야 한다.

    비교 대상 없이 숫자만 바뀌면 "지금 보는 게 저장값인가 조정값인가"를 알 수 없다.
    """
    s = probe["simConsole"]
    assert s["dirtyBadgeShown"] is True
    assert s["showsBaselineRowWhenDirty"] is True


def test_sum_guard_warns_and_never_silently_fixes(probe):
    """합계가 목표 100(대출금 제외 확정)과 다르면 경고한다. 잔여 채우기는 **명시적 버튼**이고,
    과다 배분은 버튼으로도 못 맞추므로 경고가 남아야 한다 — 조용히 맞추면
    "합계가 맞는 줄 알았다"는 사고가 된다."""
    s = probe["simConsole"]
    assert s["sumBadgeWarns"] is True
    assert s["fillCashCannotFixOverAllocation"] is True
    assert s["fillCashFixesUnderAllocation"] is True


def test_save_and_revert_are_explicit_buttons(probe):
    """저장 버튼이 눌린 뒤에야 localStorage 에 남고, 기준선이 갱신되며,
    되돌리기는 저장 안 된 조정을 버리고 저장값으로 복귀한다."""
    s = probe["simConsole"]
    assert s["saveButtonExists"] is True
    assert s["saveWritesStorage"] is True
    assert s["saveSchemaHasNoLegacyKeys"] is True, "저장 스키마에 구 회계 축 키가 남는다"
    assert s["baselineResetAfterSave"] is True
    assert s["revertRestoresSaved"] is True
