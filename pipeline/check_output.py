#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""배포 게이트 — 빌드 산출물이 JSON 계약을 지키는지 검사하고, 아니면 exit 1.

왜 필요한가: `process.py` 는 `risk.build` / `hedge.build` 를 각각 try/except 로
격리한다. 계산이 깨지면 traceback 을 찍고 경고만 남긴 뒤 **그 JSON 없이** 나머지를
정상 종료(exit 0)로 내보낸다. CI 는 초록으로 끝나고, 대시보드는 해당 섹션이
사라진 채 배포된다. 이 스크립트는 build 와 deploy 사이에서 그 상태를 잡는다.

    python pipeline/check_output.py --out _site/data --max-warnings 20 --min-series 100

표준 라이브러리만 쓴다 — 의존성 설치가 깨진 상황에서도 돌아야 한다.

검사 항목
    1. JSON 파일 집합이 계약의 13개와 **정확히** 일치 (부족·초과 모두 실패)
    2. 전부 파싱 가능한 JSON 이고 비어 있지 않음
    3. meta.json 필수 필드 존재
    4. meta.json.warnings 개수 <= --max-warnings   (등호가 아니라 **상한**:
       경고 수는 데이터에서 오는 수라 정상적으로 변한다)
    5. meta.json.series_count >= --min-series      (고정값이 아니라 **바닥**)
    6. 모든 시계열 페이로드에서 len(t) == len(v)
    7. catalog.json 에 값 배열이 실려 있지 않음 (값 없이 메타데이터만 — 공개 범위 가드)
    8. --dashboard 를 주면 dashboard/app.js 의 FILES 상수와 파일 집합이 일치하는지
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# process.py 의 payloads 딕셔너리 = dashboard/app.js 의 FILES 상수 = 이 목록.
# 셋 중 하나만 고치면 안 된다.
EXPECTED = [
    "meta", "overview", "risk", "events", "panel", "hedge", "alloc", "rates",
    "irs", "credit", "fx", "inflation", "acwi", "macro", "catalog",
]
META_FIELDS = ["built_at_utc", "last_observation", "series_count", "files", "warnings"]

_errors: list[str] = []
_notes: list[str] = []


def fail(msg: str) -> None:
    _errors.append(msg)


def note(msg: str) -> None:
    _notes.append(msg)


def _walk_ts(obj, path, seen):
    """페이로드 어디에 있든 {"t": [...], "v": [...]} 를 찾아 길이를 대조한다."""
    if isinstance(obj, dict):
        if isinstance(obj.get("t"), list) and isinstance(obj.get("v"), list):
            seen[0] += 1
            if len(obj["t"]) != len(obj["v"]):
                fail(f"{path}: t/v 길이 불일치 ({len(obj['t'])} vs {len(obj['v'])})")
        for k, v in obj.items():
            _walk_ts(v, f"{path}.{k}", seen)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _walk_ts(v, f"{path}[{i}]", seen)


def check(out: Path, max_warnings: int, min_series: int, dashboard: Path | None) -> int:
    if not out.is_dir():
        fail(f"출력 디렉터리가 없습니다: {out}")
        return report()

    found = sorted(p.stem for p in out.glob("*.json"))
    expected = sorted(EXPECTED)
    if found != expected:
        missing = sorted(set(expected) - set(found))
        extra = sorted(set(found) - set(expected))
        if missing:
            fail("JSON 누락 %d개: %s — risk/hedge 계산이 조용히 실패했을 때 나타나는 "
                 "전형적인 증상입니다 (빌드 로그의 traceback 확인)" % (len(missing), ", ".join(missing)))
        if extra:
            fail("계약에 없는 JSON %d개: %s — payloads/FILES/EXPECTED 세 곳을 함께 "
                 "고쳤는지 확인하세요" % (len(extra), ", ".join(extra)))
    else:
        note(f"JSON {len(found)}/{len(expected)}개")

    payloads = {}
    for name in found:
        p = out / f"{name}.json"
        if p.stat().st_size == 0:
            fail(f"{p.name}: 빈 파일")
            continue
        try:
            payloads[name] = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            fail(f"{p.name}: JSON 파싱 실패 — {e}")

    meta = payloads.get("meta")
    if meta is None:
        fail("meta.json 을 읽지 못했습니다")
    else:
        for f in META_FIELDS:
            if f not in meta:
                fail(f"meta.json: 필수 필드 없음 — {f}")
        warns = meta.get("warnings", [])
        if len(warns) > max_warnings:
            fail(f"경고 {len(warns)}건 > 상한 {max_warnings}건 — 파서가 시리즈를 "
                 f"대량으로 놓쳤을 수 있습니다. 첫 3건: {warns[:3]}")
        else:
            note(f"경고 {len(warns)}건 (상한 {max_warnings})")
        n = meta.get("series_count", 0)
        if not isinstance(n, int) or n < min_series:
            fail(f"시리즈 {n}개 < 바닥 {min_series}개 — 업로드가 깨졌을 수 있습니다")
        else:
            note(f"시리즈 {n}개 (바닥 {min_series})")

    seen = [0]
    for name, obj in payloads.items():
        _walk_ts(obj, name, seen)
    note(f"시계열 페이로드 {seen[0]}개 t/v 길이 확인")

    cat = payloads.get("catalog")
    if isinstance(cat, dict):
        rows = cat.get("series", [])
        bad = [r.get("key") for r in rows
               if isinstance(r, dict) and any(k in r for k in ("t", "v", "values"))]
        if bad:
            fail(f"catalog.json 에 값이 실렸습니다 ({len(bad)}건, 예: {bad[:3]}) — "
                 "카탈로그는 값 없이 메타데이터만 게시해야 합니다")
        note(f"카탈로그 {len(rows)}행 (값 없음 확인)")

    if dashboard is not None:
        if not dashboard.is_file():
            fail(f"대시보드 파일이 없습니다: {dashboard}")
        else:
            src = dashboard.read_text(encoding="utf-8")
            m = re.search(r"FILES\s*=\s*\[(.*?)\]", src, re.S)
            if not m:
                fail(f"{dashboard.name}: FILES 상수를 찾지 못했습니다")
            else:
                files = sorted(re.findall(r'["\']([A-Za-z_]+)["\']', m.group(1)))
                if files != expected:
                    fail(f"{dashboard.name} 의 FILES({len(files)}) 와 계약({len(expected)}) 불일치: "
                         f"only-in-app={sorted(set(files) - set(expected))} "
                         f"only-in-contract={sorted(set(expected) - set(files))}")
                else:
                    note(f"app.js FILES {len(files)}개 일치")
    return report()


def report() -> int:
    for n in _notes:
        print(f"  ok  {n}")
    if _errors:
        print("", file=sys.stderr)
        for e in _errors:
            print(f"::error::배포 게이트: {e}", file=sys.stderr)
        print(f"\n배포 게이트 실패 — {len(_errors)}건. 배포하지 않습니다.", file=sys.stderr)
        return 1
    print("배포 게이트 통과.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="빌드 산출물 JSON 계약 검사")
    ap.add_argument("--out", required=True, type=Path, help="process.py 의 --out 디렉터리")
    ap.add_argument("--max-warnings", type=int, default=20,
                    help="meta.json.warnings 개수 상한 (등호 아님). 현재 기준선 7건")
    ap.add_argument("--min-series", type=int, default=100,
                    help="meta.json.series_count 바닥 (고정값 아님). 현재 기준선 444개")
    ap.add_argument("--dashboard", type=Path, default=None,
                    help="dashboard/app.js 경로 — 주면 FILES 상수까지 대조")
    a = ap.parse_args()
    return check(a.out, a.max_warnings, a.min_series, a.dashboard)


if __name__ == "__main__":
    sys.exit(main())
