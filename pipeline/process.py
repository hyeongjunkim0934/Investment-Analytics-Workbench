#!/usr/bin/env python3
"""Investment Analytics Workbench — data pipeline.

Reads vendor Excel exports from the (private) data repository checkout and
emits the JSON datasets consumed by the static dashboard.

공개 범위: 원본 엑셀 파일과 전체 시리즈는 비공개 저장소에만 존재한다.
이 스크립트가 게시하는 것은 패널 정의(OVERVIEW_CARDS, CURVES 등)에 선별된
시리즈의 값(최근 구간 일별, 과거 구간 주별 축약)과 파생 지표(스프레드 등)이며,
카탈로그는 값 없이 메타데이터만 게시한다. 게시된 값은 공개 페이지에서 누구나
접근 가능하므로, 공개해도 되는 시리즈만 패널에 넣어야 한다.

Usage:
    python pipeline/process.py --data-dir source-data --out _site/data
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import openpyxl
import pandas as pd

import hedge
import risk
# 재수출(re-export): 예전 process.epoch_seconds 를 쓰던 호출부를 그대로 두면서
# 정의는 common 한 곳만 남긴다. tests/test_formulas.py 가 동일성을 단정한다.
from common import epoch_seconds

# --------------------------------------------------------------------------
# series store
# --------------------------------------------------------------------------

SERIES: dict[str, dict] = {}   # key -> {source, category, name, s: pd.Series}
WARNINGS: list[str] = []
MERGED_KEYS: set[str] = set()


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    print(f"[warn] {msg}", file=sys.stderr)


def add_series(key: str, source: str, category: str, name: str, pairs) -> None:
    if not pairs:
        return
    idx = pd.DatetimeIndex([p[0] for p in pairs])
    s = pd.Series([p[1] for p in pairs], index=idx, dtype="float64")
    s = s.sort_index()
    s = s[~s.index.duplicated(keep="last")].dropna()
    if s.empty:
        return
    if key in SERIES:
        # 같은 시리즈가 여러 파일에 존재하면 병합하되, 마지막 관측일이
        # 늦은(더 최신인) 쪽이 겹치는 날짜에서 우선한다.
        old = SERIES[key]["s"]
        loser, winner = (old, s) if s.index[-1] >= old.index[-1] else (s, old)
        merged = pd.concat([loser, winner])
        merged = merged[~merged.index.duplicated(keep="last")].sort_index()
        SERIES[key]["s"] = merged
        MERGED_KEYS.add(key)
        return
    SERIES[key] = {"source": source, "category": category, "name": name, "s": s}


def get(key: str) -> pd.Series | None:
    entry = SERIES.get(key)
    if entry is None:
        warn(f"series not found: {key}")
        return None
    return entry["s"]


# --------------------------------------------------------------------------
# cell helpers
# --------------------------------------------------------------------------

def to_num(v):
    """Vendor cell -> float or None. '#N/A N/A', '#NAME?', '' -> None."""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(v, str):
        t = v.strip().replace(",", "")
        if not t or t.startswith("#"):
            return None
        try:
            return float(t)
        except ValueError:
            return None
    return None


def is_dt(v) -> bool:
    return isinstance(v, datetime)


def cell_label(v) -> str | None:
    return v.strip() if isinstance(v, str) else None


# --------------------------------------------------------------------------
# parsers
# --------------------------------------------------------------------------

CAT_LABELS = {"카테고리", "Category", "CATEGORY"}
NOTATION_LABELS = {"Notation", "NOTATION", "노테이션"}


def parse_wide(path: Path, source_tag: str) -> int:
    """Parse a wide export (Bloomberg / Infomax style).

    Layout: a header block somewhere in the first rows containing a category
    row (col A == 카테고리/Category) and a notation row (col A == Notation),
    followed by data rows whose col A is a datetime. Everything else is
    ignored, so extra vendor rows (Ticker, field, item labels, broken formula
    rows) are harmless.
    """
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    added = 0
    try:
        for ws in wb.worksheets:
            cats = notations = None
            cols: list[tuple[int, str, str]] = []   # (col_idx, category, name)
            data: dict[int, list] = {}
            dates: list[datetime] = []
            started = False
            for row in ws.iter_rows(values_only=True):
                if not row:
                    continue
                a = row[0]
                if not started:
                    label = cell_label(a)
                    if label in CAT_LABELS:
                        cats = row
                    elif label in NOTATION_LABELS:
                        notations = row
                    elif is_dt(a) and notations is not None:
                        # header block complete -> build column map, start data
                        seen: set[str] = set()
                        for j, name in enumerate(notations):
                            if j == 0:
                                continue
                            nm = cell_label(name)
                            if not nm:
                                continue
                            if nm in seen:
                                warn(f"{path.name}/{ws.title}: duplicate column '{nm}' skipped")
                                continue
                            seen.add(nm)
                            cat = ""
                            if cats is not None and j < len(cats):
                                cat = cell_label(cats[j]) or ""
                            cols.append((j, cat, nm))
                            data[j] = []
                        started = True
                    else:
                        continue
                if started and is_dt(a):
                    dates.append(a)
                    n = len(row)
                    for j, _, _ in cols:
                        data[j].append(to_num(row[j]) if j < n else None)
            for j, cat, nm in cols:
                key = f"{source_tag}:{nm}"
                pairs = [(d, v) for d, v in zip(dates, data[j])]
                before = len(SERIES)
                add_series(key, source_tag, cat, nm, pairs)
                added += len(SERIES) - before
    finally:
        wb.close()
    return added


def parse_index_export(path: Path) -> tuple[str | None, list]:
    """Parse a vendor index export (name in A1, '일자/종가/...' table below)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    name = None
    pairs = []
    try:
        ws = wb.worksheets[0]
        header_seen = False
        for row in ws.iter_rows(values_only=True):
            if not row:
                continue
            a = row[0]
            if name is None:
                lbl = cell_label(a)
                if lbl:
                    name = lbl.split()[0]
                continue
            if not header_seen:
                if cell_label(a) == "일자":
                    header_seen = True
                continue
            if is_dt(a):
                close = to_num(row[1]) if len(row) > 1 else None
                if close is not None:
                    pairs.append((a, close))
    finally:
        wb.close()
    return name, pairs


def load_data_dir(data_dir: Path) -> list[dict]:
    """Discover and parse every workbook in the data repo checkout."""
    files_report = []
    all_paths = [p for p in data_dir.rglob("*")
                 if p.is_file() and not p.name.startswith("~$")]
    # 대소문자 무관 확장자 매칭 (DATA_BB.XLSX 등도 인식)
    xlsx = sorted(p for p in all_paths if p.suffix.lower() in (".xlsx", ".xlsm"))
    for p in all_paths:
        if p.suffix.lower() == ".xls":
            warn(f"legacy .xls 형식은 지원되지 않아 건너뜀: {p.name} — .xlsx로 다시 저장해 업로드하세요")
            files_report.append({"file": p.name, "kind": "skipped-xls", "series": 0})
    if not xlsx:
        print(f"error: no .xlsx files under {data_dir}", file=sys.stderr)
        sys.exit(1)

    index_files = []   # (name, pairs, max_date, filename)
    for p in xlsx:
        low = p.name.lower()
        if low.startswith("data_bb"):
            n = parse_wide(p, "bb")
            files_report.append({"file": p.name, "kind": "bloomberg-wide", "series": n})
        elif low.startswith("data_info"):
            n = parse_wide(p, "info")
            files_report.append({"file": p.name, "kind": "infomax-wide", "series": n})
        else:
            name, pairs = parse_index_export(p)
            if name and pairs:
                mx = max(d for d, _ in pairs)
                index_files.append((name, pairs, mx, p.name))
                files_report.append({"file": p.name, "kind": f"index:{name}",
                                     "series": 1, "rows": len(pairs)})
            else:
                warn(f"unrecognized workbook skipped: {p.name}")
                files_report.append({"file": p.name, "kind": "skipped", "series": 0})

    # merge index exports per index name; the file with the later end date
    # wins on overlapping dates
    by_name: dict[str, list] = {}
    for name, pairs, mx, fname in sorted(index_files, key=lambda x: x[2]):
        by_name.setdefault(name, []).append(pairs)
    for name, chunks in by_name.items():
        merged: dict = {}
        for pairs in chunks:
            for d, v in pairs:
                merged[d] = v
        add_series(f"idx:{name}", "idx", "Index", name, list(merged.items()))

    if MERGED_KEYS:
        warn(f"{len(MERGED_KEYS)}개 시리즈가 여러 파일에 중복되어 병합됨(최신 파일 우선)")
    return files_report


# --------------------------------------------------------------------------
# analytics helpers
# --------------------------------------------------------------------------

def asof(s: pd.Series, ts) -> tuple[pd.Timestamp | None, float | None]:
    sub = s.loc[:ts]
    if len(sub) == 0:
        return None, None
    return sub.index[-1], float(sub.iloc[-1])


def pack(s: pd.Series | None, round_to: int = 4,
         daily_years: int = 5) -> dict | None:
    """Series -> {t:[unix sec], v:[...]}.

    최근 daily_years년은 일별 그대로, 그 이전 구간은 주별(금요일 라벨)로
    축약한다 — 공개 페이로드를 줄이고 문서의 축약 정책과 일치시킨다.
    """
    if s is None or len(s) == 0:
        return None
    s = s.dropna()
    if len(s) == 0:
        return None
    cutoff = s.index[-1] - pd.DateOffset(years=int(daily_years))
    old = s[s.index < cutoff]
    if len(old):
        old = old.resample("W-FRI").last().dropna()
        # 마지막 부분 주의 금요일 라벨이 경계를 넘어 일별 구간과 겹치거나
        # 역순 타임스탬프를 만들지 않도록 잘라낸다.
        old = old[old.index < cutoff]
        s = pd.concat([old, s[s.index >= cutoff]])
    return {"t": epoch_seconds(s.index),
            "v": [round(float(v), round_to) for v in s.values]}


def spark(s: pd.Series | None, points: int = 30) -> dict | None:
    if s is None or len(s) == 0:
        return None
    w = s.resample("W-FRI").last().dropna().tail(points)
    if len(w) < 2:
        w = s.tail(points)
    return {"t": epoch_seconds(w.index),
            "v": [round(float(v), 4) for v in w.values]}


def series_group(defs: list[tuple[str, str]], **pack_kw) -> list[dict]:
    """[(key, label), ...] -> [{key,label,t,v}, ...], skipping missing."""
    out = []
    for key, label in defs:
        p = pack(get(key), **pack_kw)
        if p:
            out.append({"key": key, "label": label, **p})
    return out


HORIZONS = [("d1", "1일"), ("w1", "1주"), ("m1", "1개월"),
            ("m3", "3개월"), ("ytd", "YTD"), ("y1", "1년")]


def changes(s: pd.Series, kind: str) -> dict:
    """kind: 'rate' -> bp diffs, 'price' -> % change, 'level' -> point diffs."""
    last_ts = s.index[-1]
    last_v = float(s.iloc[-1])
    targets = {
        "d1": s.index[-2] if len(s) > 1 else None,
        "w1": last_ts - timedelta(days=7),
        "m1": last_ts - pd.DateOffset(months=1),
        "m3": last_ts - pd.DateOffset(months=3),
        "ytd": pd.Timestamp(year=last_ts.year - 1, month=12, day=31),
        "y1": last_ts - pd.DateOffset(years=1),
    }
    out = {}
    for h, tgt in targets.items():
        if tgt is None:
            out[h] = None
            continue
        _, v0 = asof(s, tgt)
        if v0 is None:
            out[h] = None
        elif kind == "rate":
            out[h] = round((last_v - v0) * 100, 1)          # bp
        elif kind == "price":
            out[h] = round((last_v / v0 - 1) * 100, 2) if v0 else None   # %
        else:
            out[h] = round(last_v - v0, 2)                   # points
    return out


# --------------------------------------------------------------------------
# panel builders
# --------------------------------------------------------------------------

OVERVIEW_CARDS = [
    # key, label, kind, decimals, unit suffix on value
    ("idx:ACWI",                 "MSCI ACWI",        "price", 1, ""),
    ("info:USDKRW",              "달러/원",           "price", 1, ""),
    ("info:한국_3y",             "국고 3년",          "rate",  3, "%"),
    ("info:한국_10y",            "국고 10년",         "rate",  3, "%"),
    ("info:UST10y",              "미국채 10년",       "rate",  3, "%"),
    ("info:한국_기준금리",        "한국 기준금리",     "rate",  2, "%"),
    ("bb:미국_기준금리",          "미국 기준금리",     "rate",  2, "%"),
    ("bb:달러지수",               "달러지수(DXY)",     "price", 1, ""),
    ("bb:미국_변동성지수_VIX",    "VIX",              "level", 1, ""),
    ("info:VKOSPI",              "VKOSPI",           "level", 1, ""),
    ("bb:WTI유가",                "WTI 유가",         "price", 1, "$"),
    ("bb:미국_하이일드_스프레드", "미 HY 스프레드",    "rate",  2, "%p"),
]


def build_overview() -> dict:
    cards = []
    for key, label, kind, dec, unit in OVERVIEW_CARDS:
        s = get(key)
        if s is None:
            continue
        cards.append({
            "key": key, "label": label, "kind": kind, "unit": unit,
            "value": round(float(s.iloc[-1]), dec),
            "date": s.index[-1].strftime("%Y-%m-%d"),
            "chg": changes(s, kind),
            "spark": spark(s),
        })
    return {"cards": cards}


CURVES = {
    "KR": {"label": "한국 국고", "src": "info", "prefix": "한국_",
           "tenors": ["3m", "6m", "9m", "1y", "1.5y", "2y", "3y", "4y", "5y",
                      "7y", "10y", "15y", "20y", "30y"]},
    "US": {"label": "미국 국채", "src": "info", "prefix": "UST",
           "tenors": ["3m", "6m", "1y", "2y", "3y", "5y", "7y", "10y",
                      "20y", "30y"]},
    "JP": {"label": "일본 국채", "src": "info", "prefix": "JPY",
           "tenors": ["1y", "2y", "3y", "4y", "5y", "7y", "10y", "15y",
                      "20y", "30y", "40y"]},
    "DE": {"label": "독일 국채", "src": "info", "prefix": "GER",
           "tenors": ["1y", "2y", "3y", "5y", "7y", "10y", "20y", "30y"]},
    "AU": {"label": "호주 국채", "src": "info", "prefix": "AUD",
           "tenors": ["1y", "2y", "3y", "5y", "7y", "10y", "20y", "30y"]},
}

def curve_series_key(code: str, tenor: str) -> str:
    cfg = CURVES[code]
    return f"{cfg['src']}:{cfg['prefix']}{tenor}"


def tenor_years(t: str) -> float:
    t = t.lower()
    if t.endswith("m"):
        return float(t[:-1]) / 12
    return float(t[:-1])


def build_rates() -> dict:
    curves = {}
    for code, cfg in CURVES.items():
        tenors, xs, series_list = [], [], []
        for t in cfg["tenors"]:
            s = get(curve_series_key(code, t))
            if s is not None:
                tenors.append(t)
                xs.append(round(tenor_years(t), 4))
                series_list.append(s)
        if not series_list:
            continue
        last_ts = max(s.index[-1] for s in series_list)
        snap_defs = [("최근", last_ts), ("1개월 전", last_ts - pd.DateOffset(months=1)),
                     ("1년 전", last_ts - pd.DateOffset(years=1))]
        snaps = []
        for lbl, tgt in snap_defs:
            vals, dt = [], None
            for s in series_list:
                d, v = asof(s, tgt)
                vals.append(None if v is None else round(v, 3))
                if d is not None and (dt is None or d > dt):
                    dt = d
            snaps.append({"label": lbl,
                          "date": dt.strftime("%Y-%m-%d") if dt is not None else None,
                          "v": vals})
        curves[code] = {"label": cfg["label"], "tenors": tenors, "x": xs,
                        "snaps": snaps}

    ts10 = series_group([
        ("info:한국_10y", "한국"), ("info:UST10y", "미국"),
        ("info:JPY10y", "일본"), ("info:GER10y", "독일"),
    ])
    policy = series_group([
        ("info:한국_기준금리", "한국"), ("bb:미국_기준금리", "미국"),
        ("bb:유로_기준금리", "유로"), ("bb:일본_기준금리", "일본"),
    ])

    spreads = []
    for label, a_key, b_key in [
        ("한국 10년−3년", "info:한국_10y", "info:한국_3y"),
        ("미국 10년−2년", "info:UST10y", "info:UST2y"),
        ("한미 10년 금리차", "info:한국_10y", "info:UST10y"),
    ]:
        a, b = get(a_key), get(b_key)
        if a is None or b is None:
            continue
        sp = ((a - b) * 100).dropna()     # bp
        p = pack(sp, round_to=1)
        if p:
            spreads.append({"label": label, **p})
    return {"curves": curves, "ts10": ts10, "policy": policy, "spreads": spreads}


IRS_TENORS = ["1y3m", "1y1y", "2y1y", "3y1y", "4y1y", "5y1y", "5y5y", "5y10y"]
IRS_COUNTRIES = [("미국", "미국"), ("한국", "한국"), ("일본", "일본"), ("유로", "유로")]


def build_irs() -> dict:
    fwd = {}
    for code, label in IRS_COUNTRIES:
        tenors, series_list = [], []
        for t in IRS_TENORS:
            s = get(f"bb:{code}_IRS_{t}")
            if s is not None:
                tenors.append(t)
                series_list.append(s)
        if not series_list:
            continue
        last_ts = max(s.index[-1] for s in series_list)
        snaps = []
        for lbl, tgt in [("최근", last_ts),
                         ("1개월 전", last_ts - pd.DateOffset(months=1)),
                         ("1년 전", last_ts - pd.DateOffset(years=1))]:
            vals, dt = [], None
            for s in series_list:
                d, v = asof(s, tgt)
                vals.append(None if v is None else round(v, 3))
                if d is not None and (dt is None or d > dt):
                    dt = d
            snaps.append({"label": lbl,
                          "date": dt.strftime("%Y-%m-%d") if dt is not None else None,
                          "v": vals})
        fwd[code] = {"label": label, "tenors": tenors, "snaps": snaps}

    ts = series_group([
        ("bb:미국_IRS_1y1y", "미국 1y1y"), ("bb:미국_IRS_5y5y", "미국 5y5y"),
        ("bb:한국_IRS_1y1y", "한국 1y1y"), ("bb:한국_IRS_5y5y", "한국 5y5y"),
    ])
    return {"fwd": fwd, "ts": ts}


KR_CREDIT_3Y = [
    ("info:Public_AAA_3y", "공사채 AAA"),
    ("info:KDB_AAA_3y", "산금채 AAA"),
    ("info:Bank_AAA_3y", "은행채 AAA"),
    ("info:Corp_AAA_3y", "회사채 AAA"),
    ("info:Corp_AA_zero_3y", "회사채 AA0"),
    ("info:Corp_A_plus_3y", "회사채 A+"),
    ("info:Card_AA_plus_3y", "카드채 AA+"),
    ("info:capital_A_plus_3y", "캐피탈채 A+"),
]


def build_credit() -> dict:
    base = get("info:한국_3y")
    kr = []
    if base is not None:
        for key, label in KR_CREDIT_3Y:
            s = get(key)
            if s is None:
                continue
            sp = ((s - base) * 100).dropna()   # bp over KTB 3y
            p = pack(sp, round_to=1)
            if p:
                kr.append({"key": key, "label": label, **p})
    us = series_group([
        ("bb:미국_투자등급_스프레드", "미국 IG"),
        ("bb:미국_하이일드_스프레드", "미국 HY"),
    ])
    cds = series_group([
        ("bb:한국_CDS_5년물", "한국"), ("bb:일본_CDS_5년물", "일본"),
        ("bb:중국_CDS_5년물", "중국"), ("bb:독일_CDS_5년물", "독일"),
        ("bb:프랑스_CDS_5년물", "프랑스"),
    ])
    return {"kr": kr, "us": us, "cds": cds}


def build_fx() -> dict:
    ts = series_group([
        ("info:USDKRW", "달러/원"), ("info:DXY", "달러지수"),
        ("info:USDJPY", "달러/엔"), ("info:EURKRW", "유로/원"),
    ])
    hedge_rows = []
    for cur, label in [("USDKRW", "달러"), ("JPYKRW", "엔"),
                       ("EURKRW", "유로"), ("AUDKRW", "호주달러")]:
        row = {"label": label}
        any_val = False
        for hz in ["3M", "6M", "12M"]:
            s = get(f"info:{cur}_HP_{hz}")
            if s is not None:
                row[hz] = round(float(s.iloc[-1]), 3)
                row["date"] = s.index[-1].strftime("%Y-%m-%d")
                any_val = True
            else:
                row[hz] = None
        if any_val:
            hedge_rows.append(row)
    hedge_ts = series_group([
        ("info:USDKRW_HP_3M", "3개월"), ("info:USDKRW_HP_6M", "6개월"),
        ("info:USDKRW_HP_12M", "12개월"),
    ])
    return {"ts": ts, "hedge": hedge_rows, "hedge_ts": hedge_ts}


def build_inflation() -> dict:
    bei = series_group([
        ("info:KTB_BEI10y", "한국"), ("info:UST_BEI10y", "미국"),
        ("info:JGB_BEI10y", "일본"), ("info:GER_BEI10y", "독일"),
        ("info:AUD_BEI10y", "호주"),
    ])
    tips = series_group([
        ("bb:미국_TIPS_10y", "미국 TIPS 10y"), ("bb:한국_TIPS_10y", "한국 TIPS 10y"),
    ])
    return {"bei": bei, "tips": tips}


def build_acwi() -> dict:
    s = get("idx:ACWI")
    if s is None:
        return {}
    price = pack(s, round_to=3, daily_years=8)
    peak = s.cummax()
    dd = ((s / peak - 1) * 100).round(2)
    drawdown = pack(dd, round_to=2, daily_years=8)

    last_ts = s.index[-1]
    first_ts = s.index[0]
    years = (last_ts - first_ts).days / 365.25
    cagr = ((float(s.iloc[-1]) / float(s.iloc[0])) ** (1 / years) - 1) * 100 if years > 0 else None
    daily_ret = s.pct_change().dropna()
    vol = float(daily_ret.tail(252).std()) * math.sqrt(252) * 100 if len(daily_ret) > 30 else None
    stats = {
        "last": round(float(s.iloc[-1]), 2),
        "date": last_ts.strftime("%Y-%m-%d"),
        "first_date": first_ts.strftime("%Y-%m-%d"),
        "cagr": round(cagr, 2) if cagr is not None else None,
        "vol_1y": round(vol, 2) if vol is not None else None,
        "mdd": round(float(dd.min()), 2),
        "high_52w": round(float(s.loc[last_ts - timedelta(days=365):].max()), 2),
        "low_52w": round(float(s.loc[last_ts - timedelta(days=365):].min()), 2),
        "chg": changes(s, "price"),
    }
    return {"price": price, "drawdown": drawdown, "stats": stats}


MACRO_DEFS = [
    ("bb:한국_GDP_real_yoy", "한국 실질 GDP YoY", "%"),
    ("bb:미국_GDP_real_yoy", "미국 실질 GDP YoY", "%"),
    ("bb:한국_core_CPI_yoy", "한국 근원 CPI YoY", "%"),
    ("bb:미국_core_PCE_CPI_yoy", "미국 근원 PCE YoY", "%"),
    ("bb:미국_실업률", "미국 실업률", "%"),
    ("bb:미국_NonFarm_Payrolls_mom", "미국 비농업고용 MoM", "천명"),
]


def build_macro() -> dict:
    items = []
    for key, label, unit in MACRO_DEFS:
        s = get(key)
        if s is None:
            continue
        # 벤더 데이터는 발표값이 일별로 이월되므로 월말 기준으로 표본화한다.
        s = s.dropna()
        last_obs_date = s.index[-1]
        s = s.resample("ME").last().dropna()
        # 이미 월별로 희소한 데이터이므로 주별 축약을 적용하지 않는다.
        p = pack(s.tail(60), round_to=3, daily_years=100)
        if p:
            items.append({"key": key, "label": label, "unit": unit,
                          "last": round(float(s.iloc[-1]), 3),
                          "date": last_obs_date.strftime("%Y-%m-%d"), **p})
    return {"items": items}


def build_catalog() -> dict:
    rows = []
    for key, e in sorted(SERIES.items()):
        s = e["s"]
        rows.append({
            "key": key, "source": e["source"], "category": e["category"],
            "name": e["name"],
            "first": s.index[0].strftime("%Y-%m-%d"),
            "last": s.index[-1].strftime("%Y-%m-%d"),
            "n": int(len(s)),
        })
    return {"series": rows}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    files_report = load_data_dir(args.data_dir)
    total = len(SERIES)
    print(f"parsed {total} series from {len(files_report)} files")
    if total < 10:
        print("error: too few series parsed — aborting so a broken upload "
              "does not wipe the dashboard", file=sys.stderr)
        sys.exit(1)

    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    now_utc = datetime.now(timezone.utc)
    kst = now_utc.astimezone(timezone(timedelta(hours=9)))
    last_obs = max(e["s"].index[-1] for e in SERIES.values())

    payloads = {
        "overview.json": build_overview(),
    }

    # 리스크 스코어보드 — 계산 실패가 대시보드 전체 빌드를 막지 않도록 격리
    try:
        risk_payload, events_payload = risk.build(SERIES, warn)
        payloads["risk.json"] = risk_payload
        payloads["events.json"] = events_payload
    except Exception:
        import traceback
        traceback.print_exc()
        warn("risk: 스코어보드 계산 실패 — 해당 섹션 없이 배포됩니다")

    try:
        payloads["hedge.json"] = hedge.build(SERIES, warn)
    except Exception:
        import traceback
        traceback.print_exc()
        warn("hedge: 환헤지 계산 실패 — 해당 섹션 없이 배포됩니다")

    payloads.update({
        "rates.json": build_rates(),
        "irs.json": build_irs(),
        "credit.json": build_credit(),
        "fx.json": build_fx(),
        "inflation.json": build_inflation(),
        "acwi.json": build_acwi(),
        "macro.json": build_macro(),
        "catalog.json": build_catalog(),
    })
    payloads["meta.json"] = {
        "built_at_utc": now_utc.strftime("%Y-%m-%d %H:%M UTC"),
        "built_at_kst": kst.strftime("%Y-%m-%d %H:%M KST"),
        "last_observation": last_obs.strftime("%Y-%m-%d"),
        "series_count": total,
        "files": files_report,
        "warnings": WARNINGS,
        "note": "선별된 시리즈만 게시됩니다. 최근 구간(기본 5년)은 일별, 그 이전 구간은 주별로 축약됩니다.",
    }

    for fname, obj in payloads.items():
        p = out / fname
        with p.open("w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False)
        print(f"wrote {p} ({p.stat().st_size:,} bytes)")

    if WARNINGS:
        print(f"{len(WARNINGS)} warning(s) — see meta.json", file=sys.stderr)


if __name__ == "__main__":
    main()
