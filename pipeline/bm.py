# -*- coding: utf-8 -*-
"""자산군 전략 벤치마크(BM) — 파싱 + 자본시장가정(CMA) 사전계산.

사용자(기관)가 Data 저장소에 올리는 `BM*.xlsx` 를 읽어, 자산배분 최적화의
입력이 되는 CMA(위험·상관·공분산)를 **미리 계산해 게시**한다. 기대수익률은
게시하지 않는 값이 아니라 애초에 계산하지 않는 값이다 — 화면에서 사용자가
키인한다(과거 평균은 참고 배지로만 게시). 2026-08-11 사용자 지시.

파일 규약 (정본 — Data 저장소 CLAUDE.md 에도 같은 표가 있다):
- 파일명이 (대소문자 무관) `bm` 으로 시작하면 이 파서가 맡는다. 날짜가 박힌
  이름(`BM지수_20260811.xlsx`)도 접두사만 지키면 된다 — 데일리 리포트와 달리
  내용 판정이 아닌 이유는, 이 파일은 사용자가 의도적으로 올리는 단일 계열이라
  이름을 통제할 수 있어서다.
- **첫 시트만** 읽는다. 헤더는 2행: 1행 = 회계 그룹(장부가/시가 — 병합 셀처럼
  빈 칸은 왼쪽 값을 계승), 2행 = 자산군 이름. A열은 조회일자(YYYYMMDD 문자열
  또는 날짜형). 그 아래는 일자별 지수 수준.
- **값 0 은 결측(벤치마크 미개시)이다.** 실측: 시가 국내주식은 2021-12-17 이전이
  전부 0 으로 채워져 있다. 0 을 수익률 계산에 넣으면 ±100% 급변이 생긴다.
- 주말·휴일에도 직전 값이 이월돼 있다(캐리포워드). 그래서 CMA 는 일별이 아니라
  **월말 표본**으로 계산한다 — 일별로 재면 0% 수익률이 주 2회 섞여 연환산 σ 가
  계통적으로 과소평가된다(실측 근거로 정한 규칙이지 취향이 아니다).

게시물(`alloc.json.cma`)에는 **지수 원본 값이 실리지 않는다** — 창(window)별
연환산 σ·상관·공분산·과거 평균과 표본 메타데이터만 나간다. 원본 수익률 미게시
규약(alloc 유출 가드)과 같은 계약이다.
"""

from __future__ import annotations

import math

import numpy as np
import openpyxl
import pandas as pd

# 환율 축 — 헤지비율 반영용. BM 자산과 달러원 수익률의 공분산까지 한 행렬에
# 실어(K+1 × K+1), 화면이 임의의 헤지비율 h 에 대해
#   Σ_h[i][j] = Σ[i][j] − h_i·cov(j,fx) − h_j·cov(i,fx) + h_i·h_j·σ_fx²
# 로 헤지 반영 공분산을 폐형 재구성할 수 있게 한다 (r_h = r − h·r_fx 항등식).
FX_KEY = "bb:달러원"

# 창 후보(년). 공통 표본이 꽉 채우는 창만 게시된다 — 짧은 자산(시가 국내주식
# 2021-12~)이 늘어나면 긴 창이 자동으로 열린다. "all" = 전체 공통 표본.
WINDOW_YEARS = [1, 2, 3, 5, 7, 10]

# 배분 대상에서 제외하는 자산군 (2026-08-11 사용자 지시). 배분 레버가 아니므로
# 공분산 행렬에 자리를 차지할 이유가 없다. **파싱은 계속 한다** — 키·카탈로그·
# coverage 에는 남고 CMA 행렬에서만 빠진다(자산이 사라진 게 아니라 최적화
# 대상이 아니라는 뜻이라, 게시물에서 지워 버리면 그 구분이 안 보인다).
# 이 둘을 빼면 남는 8개가 §7.7 합의문의 자산군 8개와 정확히 일치한다.
EXCLUDED = ("장부가 금융상품", "장부가 대출금")


def is_bm(path) -> bool:
    return path.name.lower().startswith("bm")


def parse(path, warn) -> list[tuple[str, str, list]]:
    """→ [(자산군 이름, 그룹, [(Timestamp, 값), …]), …] (열 순서 유지)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        ws = wb.worksheets[0]
        rows = ws.iter_rows(values_only=True)
        try:
            g_row = next(rows)
            n_row = next(rows)
        except StopIteration:
            warn(f"{path.name}: 헤더 2행이 없어 건너뜀")
            return []
        # 그룹 행: 빈 칸은 왼쪽 값 계승 (병합 셀 대응)
        groups, cur = [], ""
        for v in g_row[1:]:
            if v is not None and str(v).strip():
                cur = str(v).strip()
            groups.append(cur)
        names = [str(v).strip() if v is not None else "" for v in n_row[1:]]
        cols = [(i, groups[i], names[i]) for i in range(len(names)) if names[i]]
        if not cols:
            warn(f"{path.name}: 2행에서 자산군 이름을 찾지 못해 건너뜀")
            return []
        out = {i: [] for i, _, _ in cols}
        for r in rows:
            if not r or r[0] is None:
                continue
            raw = r[0]
            if isinstance(raw, pd.Timestamp):
                dt = raw
            else:
                s = str(raw).strip()
                if not s.isdigit() or len(s) != 8:
                    continue        # 합계·주석 행 등은 조용히 무시
                dt = pd.Timestamp(f"{s[:4]}-{s[4:6]}-{s[6:8]}")
            for i, _, _ in cols:
                v = r[i + 1] if i + 1 < len(r) else None
                # 0 = 미개시 결측. 음수 지수도 데이터 오류로 보고 버린다.
                if isinstance(v, (int, float)) and v > 0:
                    out[i].append((dt, float(v)))
        return [(name, grp, out[i]) for i, grp, name in cols]
    finally:
        wb.close()


def _month_end_returns(s: pd.Series) -> pd.Series:
    """월말 수준 → 월간 수익률. 캐리포워드 일별 데이터의 표준 처리.

    **마지막 달은 관측이 달력 월말에 도달했을 때만 완결로 본다.** 리샘플 라벨(ME)은
    항상 달력 월말이지만 실제 마지막 관측은 월중일 수 있고(실측: BM 파일 8/10까지 ·
    달러원 7/20까지), 그 부분월 수익률을 월간으로 두면 σ·평균이 왜곡된다.
    마지막이 아닌 달은 정의상 뒤 관측이 존재하므로 항상 완결이다. 영업일 계열이
    주말 월말(예: 5/31 일요일)로 끝나면 완결인데도 한 달이 보수적으로 빠진다 —
    다음 갱신이 오면 저절로 복구되므로 판별 규칙을 더 얹지 않는다(자의성 금지).
    """
    s = s.sort_index()
    me = s.resample("ME").last().dropna()
    if len(me) and s.index.max() < me.index[-1]:
        me = me.iloc[:-1]
    return me.pct_change().dropna()


def build_cma(series_store: dict, warn) -> dict:
    """SERIES 의 `bm:*` 시리즈로 CMA 블록을 만든다. BM 파일이 없으면
    `active:false` 로 게시한다 — Data 저장소 기본 브랜치에 BM 파일이 아직 없어도
    게이트·배포가 깨지지 않게 하는 체인 안전장치다."""
    S = {k: v["s"] for k, v in series_store.items()}
    all_bm = [k for k in series_store if k.startswith("bm:")]
    if not all_bm:
        return {"active": False,
                "reason": "BM 파일 없음 — Data 저장소 raw/ 에 BM*.xlsx 를 올리면 활성화됩니다"}
    bm_keys = [k for k in all_bm if k[3:] not in EXCLUDED]
    if not bm_keys:
        return {"active": False,
                "reason": "배분 대상 자산군 없음 — 전부 EXCLUDED 에 걸렸습니다"}

    labels = [k[3:] for k in bm_keys]                       # "장부가 국내채권" …
    groups = [lb.split()[0] for lb in labels]
    rets = {k: _month_end_returns(S[k]) for k in bm_keys}

    fx = S.get(FX_KEY)
    fx_ret = _month_end_returns(fx) if fx is not None else None
    if fx_ret is None:
        warn(f"cma: 환율 시리즈({FX_KEY}) 없음 — 헤지 반영 축 없이 게시")

    # 경제적 실질 관점 매핑 — 같은 이름의 「시가」 상대가 있으면 그쪽 통계로
    # 치환한다(장부가 국내채권 → 시가 국내채권). 상대가 없는 자산(단기자금·
    # 금융상품·대출금)은 자기 자신 — 화면이 그 사실을 밝힌다.
    econ_map = {}
    for i, lb in enumerate(labels):
        grp, name = groups[i], lb.split(maxsplit=1)[1] if " " in lb else lb
        twin = f"시가 {name}"
        econ_map[lb] = twin if (grp == "장부가" and twin in labels) else lb

    # 자산별 가용 구간 (표본 정직성 — 화면 표에 그대로 나간다). 제외 자산군도
    # `included:false` 로 함께 싣는다 — 파일에는 있는데 배분에 없다는 사실이
    # 화면에서 보여야 "왜 8개인가"에 답이 된다.
    coverage = []
    for k in all_bm:
        lb = k[3:]
        r = _month_end_returns(S[k])
        coverage.append({"label": lb, "group": lb.split()[0],
                         "first": str(r.index.min().date()) if len(r) else None,
                         "last": str(r.index.max().date()) if len(r) else None,
                         "n_months": int(len(r)),
                         "included": lb not in EXCLUDED})

    # 공통 표본 (전 자산 + 환율)
    frames = {lb: rets[k] for k, lb in zip(bm_keys, labels)}
    if fx_ret is not None:
        frames["_fx"] = fx_ret
    df = pd.DataFrame(frames).dropna()
    if len(df) < 12:
        warn(f"cma: 공통 월간 표본이 {len(df)}개월뿐 — CMA 비활성 게시")
        return {"active": False,
                "reason": f"공통 표본 {len(df)}개월 — 최소 12개월 필요"}

    asof = df.index.max()
    windows = []
    for y in WINDOW_YEARS:
        need = y * 12
        if len(df) < need:
            continue
        windows.append((str(y), df.iloc[-need:]))
    windows.append(("all", df))

    def stats(sub: pd.DataFrame) -> dict:
        cols = list(sub.columns)
        m = sub.mean() * 12.0
        v = sub.std(ddof=1) * math.sqrt(12.0)
        cov = sub.cov(ddof=1) * 12.0
        corr = sub.corr()
        rd = lambda x, n=8: float(round(float(x), n))
        return {
            "n_months": int(len(sub)),
            "start": str(sub.index.min().date()), "end": str(sub.index.max().date()),
            "mean_pct": [rd(m[c] * 100, 4) for c in cols],
            "vol_pct": [rd(v[c] * 100, 4) for c in cols],
            "corr": [[rd(corr.loc[a, b]) for b in cols] for a in cols],
            # 공분산은 소수(연율 분산) 단위 — 화면 σ 재구성·헤지 공식이 이걸 쓴다
            "cov": [[rd(cov.loc[a, b]) for b in cols] for a in cols],
        }

    out_windows = []
    for name, sub in windows:
        st = stats(sub)
        st["key"] = name
        out_windows.append(st)

    return {
        "active": True,
        "asof": str(asof.date()),
        "labels": labels,
        "groups": groups,
        "fx_col": "_fx" if fx_ret is not None else None,
        # 행렬 열 순서 = labels + (있으면) "_fx" 마지막 열. 화면은 이 순서로 집는다.
        "cols": labels + (["_fx"] if fx_ret is not None else []),
        "econ_map": econ_map,
        "coverage": coverage,
        "excluded": [lb for lb in (k[3:] for k in all_bm) if lb in EXCLUDED],
        "windows": out_windows,
        "method": ("월말 수준 → 월간 수익률 → 연환산(σ ×√12, 평균 ×12, 공분산 ×12). "
                   "일별을 쓰지 않는 이유: 주말 캐리포워드로 σ 과소평가. "
                   "0 값은 벤치마크 미개시 결측으로 제외. "
                   "금융상품·대출금은 배분 대상이 아니라 행렬에서 제외(coverage 에는 남음). "
                   "기대수익률은 계산하지 않는다 — 화면에서 키인(과거 평균은 참고)."),
    }
