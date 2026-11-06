"""Static handoff contracts and fast execution of the real Pseudo UI (no market data)."""
from __future__ import annotations

import ast
from datetime import date
import json
from pathlib import Path
import re
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def pseudo():
    node = shutil.which("node")
    assert node, "Pseudo 화면 동작 검증에는 node가 필요합니다."
    result = subprocess.run([node, str(Path(__file__).with_name("pseudo_ui_probe.js"))],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-5000:]
    return json.loads(result.stdout)


def test_pseudo_navigation_is_next_to_hedge_and_routes(pseudo):
    navigation = pseudo["navigation"]
    assert navigation["adjacent"] and navigation["registered"] and navigation["visible"]
    assert navigation["active"] == ["#pseudo"]
    assert navigation["noBackLink"]
    html = (ROOT / "dashboard/index.html").read_text()
    scripts = re.findall(r'<script\b[^>]*\bsrc="([^"?]+)', html)
    expected = ["vendor/katex/katex.min.js", "pseudo/overview.js", "pseudo/risk.js",
                "pseudo/alloc.js", "pseudo/hedge.js", "pseudo/fx.js", "pseudo.js", "app.js"]
    assert [script for script in scripts if script in expected] == expected
    assert 'href="vendor/katex/katex.min.css' in html
    assert re.search(r'<section\b[^>]*\bid="pseudo"', html)
    assert 'id="pseudo-content"' in html


def test_overview_then_four_accessible_module_tabs(pseudo):
    initial = pseudo["initial"]
    assert [tab["text"] for tab in initial["tabs"]] == ["Overview", "리스크", "자산배분", "환헤지", "환율전망"]
    assert [tab["selected"] for tab in initial["tabs"]] == ["true", "false", "false", "false", "false"]
    assert [tab["tabIndex"] for tab in initial["tabs"]] == ["0", "-1", "-1", "-1", "-1"]
    assert all(tab["controls"] == "pseudo-panel" for tab in initial["tabs"])
    assert initial["panelRole"] == "tabpanel"
    assert initial["panelLabel"] == "pseudo-tab-overview"


def test_keyboard_arrows_wrap_and_home_end_move_focus(pseudo):
    expected_ids = ["risk", "alloc", "hedge", "fx", "overview", "fx", "overview", "fx"]
    for actual, expected in zip(pseudo["keyboard"], expected_ids, strict=True):
        tab = f"pseudo-tab-{expected}"
        assert actual == {"selected": [tab], "focus": tab, "prevented": True}


def test_overview_map_connects_to_modules_and_copies_full_context(pseudo):
    actual = pseudo["overview"]
    assert actual["accessible"] and actual["allNodesVisible"] and actual["allRelationsVisible"]
    assert set(actual["targets"]) == {"risk", "alloc", "hedge", "fx"}
    for route in actual["routes"]:
        tab = f"pseudo-tab-{route['target']}"
        assert route["selected"] == [tab]
        assert route["focus"] == tab
    diagram = pseudo["docs"]["overview"]["diagram"]
    for layer in diagram["layers"]:
        assert layer["title"] in actual["copy"]
        for node in layer["nodes"]:
            assert node["title"] in actual["copy"]
            assert node["detail"] in actual["copy"]
    for relation in diagram["relations"]:
        assert relation in actual["copy"]


def test_copy_success_and_denied_clipboard_fallback(pseudo):
    copied = pseudo["copy"]
    assert copied["status"] == "복사됨"
    assert copied["text"].startswith("# 환율전망 · Pseudo")
    for guide in pseudo["docs"]["fx"].get("readingGuide", []):
        assert guide in copied["text"]
    for section in pseudo["docs"]["fx"]["sections"]:
        assert section["code"] in copied["text"]
        for text in [section["purpose"], *section["decisions"], *section["checks"]]:
            assert text in copied["text"]
        for formula in section["formulas"]:
            assert f"\\[\n{formula['latex']}\n\\]" in copied["text"]
            assert formula["legend"] in copied["text"]
    fallback = pseudo["fallback"]
    assert fallback["text"] == copied["text"]
    assert fallback["readonly"] and fallback["focused"]
    assert fallback["label"] == "복사용 Pseudo 문서"
    assert fallback["status"] == "아래 내용을 선택해 복사하세요."
    assert fallback["count"] == 1


def test_pseudo_does_not_change_financial_state_or_fetch(pseudo):
    assert pseudo["unchanged"] == {"data": True, "storage": True, "writes": 0, "fetches": 0}


def test_theme_rerender_preserves_selected_module(pseudo):
    theme = pseudo["theme"]
    assert theme["changed"] and theme["noRenderError"] and theme["dataUnchanged"] and theme["onlyThemeSaved"]
    assert theme["selected"] == ["pseudo-tab-alloc"]
    assert theme["panelLabel"] == "pseudo-tab-alloc"


def test_missing_document_is_explicit_and_clears_stale_content(pseudo):
    assert "문서를 불러오지 못했습니다" in pseudo["missing"]["message"]
    assert pseudo["missing"]["codeCount"] == 0
    assert pseudo["missing"]["noRenderError"]


def test_pseudo_and_hash_routing_work_when_all_market_requests_fail(pseudo):
    assert all(pseudo["bootFailure"].values()), pseudo["bootFailure"]


def test_document_schema_and_formula_code_separation(pseudo):
    assert set(pseudo["docs"]) == {"overview", "risk", "alloc", "hedge", "fx"}
    for key, doc in pseudo["docs"].items():
        assert doc["id"] == key
        assert date.fromisoformat(doc["updated"])
        for field in ["title", "summary", "inputs", "outputs"]:
            assert isinstance(doc[field], str) and doc[field].strip(), (key, field)
        assert doc["sections"] and doc["sources"]
        assert len({section["id"] for section in doc["sections"]}) == len(doc["sections"])
        for section in doc["sections"]:
            assert section["title"] and section["note"] and section["purpose"]
            assert section["decisions"] and section["checks"]
            assert all(isinstance(item, str) and item.strip()
                       for item in section["decisions"] + section["checks"])
            assert section["code"].strip(), (key, section["id"])
            for formula in section["formulas"]:
                assert formula["expression"] and formula["latex"] and formula["legend"]
                assert formula["expression"] not in section["code"]
                assert formula["latex"] not in section["code"]
        for card in pseudo["rendered"][key]:
            assert all(card.values()), (key, card)
        assert len(pseudo["rendered"][key]) == len(doc["sections"])


def test_forecast_models_have_their_own_document(pseudo):
    fx_ids = {section["id"] for section in pseudo["docs"]["fx"]["sections"]}
    hedge_ids = {section["id"] for section in pseudo["docs"]["hedge"]["sections"]}
    forecast_sections = {"fx-outlook", "fx-consensus", "fx-markov", "fx-lstm-xgb", "fx-model-c", "fx-model-d"}
    assert forecast_sections <= fx_ids
    assert not forecast_sections & hedge_ids
    assert {"usd-cip", "hedge-model-b", "hedge-model-c", "cost", "merit", "distribution", "outlook"} <= hedge_ids


def test_latex_renderer_receives_safe_options_and_preserves_accessibility(pseudo):
    renderer = pseudo["mathRenderer"]
    assert renderer["noRenderError"] and renderer["accessible"]
    assert [call["latex"] for call in renderer["calls"]] == renderer["expectedLatex"]
    assert renderer["calls"]
    for call in renderer["calls"]:
        assert call["options"]["displayMode"] is True
        assert call["options"]["throwOnError"] is True
        assert call["options"]["trust"] is False
        assert call["options"]["output"] == "htmlAndMathml"


def test_renderer_failure_keeps_readable_formulas_and_document(pseudo):
    assert pseudo["mathFailure"]["noRenderError"]
    assert pseudo["mathFailure"]["expressions"] == pseudo["mathFailure"]["expected"]
    assert pseudo["mathFailure"]["fallbackMarked"]
    assert "일부 수식을 일반 텍스트로 표시합니다" in pseudo["mathFailure"]["status"]


def test_all_latex_parses_with_bundled_renderer(pseudo):
    """Actual local KaTeX parser, distinct from the renderer integration mock."""
    node = shutil.which("node")
    script = r"""
const katex = require('./dashboard/vendor/katex/katex.min.js');
const formulas = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
for (const formula of formulas) {
  try {
    const html = katex.renderToString(formula.latex, {
      displayMode: true, throwOnError: true, trust: false,
      output: 'htmlAndMathml', strict: 'error'
    });
    if (!html.includes('<math') || !html.includes('application/x-tex'))
      throw new Error('MathML / original TeX absent');
  } catch (error) { throw new Error(formula.id + ': ' + error.message); }
}
process.stdout.write(String(formulas.length));
"""
    formulas = [{"id": f"{key}/{section['id']}/{index}", "latex": formula["latex"]}
                for key, doc in pseudo["docs"].items()
                for section in doc["sections"]
                for index, formula in enumerate(section["formulas"])]
    assert formulas
    result = subprocess.run([node, "-e", script], cwd=ROOT, input=json.dumps(formulas),
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-5000:]
    assert int(result.stdout) == len(formulas)


def test_renderer_fonts_are_local_and_present():
    stylesheet = ROOT / "dashboard/vendor/katex/katex.min.css"
    css = stylesheet.read_text()
    urls = re.findall(r"url\(([^)]+)\)", css)
    assert urls
    for url in urls:
        path = url.strip('"\'')
        assert not re.match(r"(?:https?:)?//", path), path
        assert (stylesheet.parent / path).is_file(), path


def test_source_paths_and_function_symbols_exist(pseudo):
    """Catch renamed/deleted handoff targets without claiming formula equivalence."""
    for doc in pseudo["docs"].values():
        sources = doc["sources"] + [source for section in doc["sections"] for source in section.get("sources", [])]
        for source in sources:
            relative = Path(source["path"])
            assert not relative.is_absolute() and ".." not in relative.parts
            assert relative.parts[0] in {"pipeline", "dashboard"}
            target = ROOT / relative
            assert target.is_file(), source
            text = target.read_text()
            if target.suffix == ".py":
                symbols = {node.name for node in ast.walk(ast.parse(text))
                           if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
            else:
                symbols = set(re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(", text))
                symbols.update(re.findall(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", text))
            assert source["symbols"] and set(source["symbols"]) <= symbols, source
