# -*- coding: utf-8 -*-
"""pytest 공통 설정.

`pipeline/` 에는 `__init__.py` 가 없고 모듈끼리 평면 임포트(`import risk`)를 쓴다
(`python pipeline/process.py` 스크립트 실행 전용 구조). 테스트도 같은 구조를
그대로 흉내 내야 하므로 `pipeline/` 을 sys.path 에 직접 얹는다 —
`from pipeline import ...` 로 바꾸지 말 것. 그 형태는 프로덕션 실행 경로가 아니다.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / "pipeline"
for p in (str(PIPELINE), str(Path(__file__).resolve().parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

import process  # noqa: E402
import synth  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_process_globals():
    """process 는 모듈 전역(SERIES/WARNINGS/MERGED_KEYS)에 상태를 쌓는다.

    테스트가 서로 오염되지 않도록 매번 비운다.
    """
    process.SERIES.clear()
    process.WARNINGS.clear()
    process.MERGED_KEYS.clear()
    yield
    process.SERIES.clear()
    process.WARNINGS.clear()
    process.MERGED_KEYS.clear()


@pytest.fixture(scope="session")
def synth_dir(tmp_path_factory):
    """3종 합성 워크북이 들어 있는 디렉터리 (세션당 한 번만 생성 — 수 초 걸린다)."""
    d = tmp_path_factory.mktemp("synthdata")
    synth.build_all(d)
    return d


@pytest.fixture
def parsed(synth_dir):
    """합성 워크북을 파싱한 뒤의 (files_report, process 모듈)."""
    report = process.load_data_dir(synth_dir)
    return report, process
