# -*- coding: utf-8 -*-
"""포트폴리오 구성(6자산군) — 프록시 통계 + CMA 입력 파일 로드 (§7.14 인프라).

게시물은 `alloc.json.port`. 원본 수준·수익률은 게시하지 않는다 — 창별 연환산
평균·σ·상관·공분산·MDD 와 표본 메타만 나간다(alloc 유출 가드가 강제).

CMA 입력 파일(선택): Data 저장소 어디든 `port_cma.json` 하나.
    {"asof": "YYYY-MM-DD", "mu_pct": {"국내채권": 3.2, ...}, ...}
자산군 이름은 ASSETS 와 문자 단위 일치, 값은 연 % (−50~50).
구 입력의 원화유동성은 국내장부로 읽고 달러유동성은 제외한다.

공개 경계(2026-08-22 사용자 지시): 게시되는 것은 **최종 수치(asof·mu_pct)뿐**이다.
파일에 빌딩블록·산출 과정·메모 등 다른 필드가 있어도 파이프라인은 읽지 않고
게시하지 않는다 — 산출 프로세스는 비공개 저장소 안에서만 존재한다.
"""

from __future__ import annotations

import json
import math

import pandas as pd

ASSETS = ["국내채권", "국내장부", "해외채권", "국내주식", "해외주식", "대체투자"]
PROXY = {
    "국내채권": "bb:한국종합",
    "국내장부": "bb:원화유동성",
    "해외채권": "bb:미국종합",
    "국내주식": "bb:한국_KOSPI_TR",
    "해외주식": "bb:미국_S&P500_TR",
    "대체투자": "bb:S&P GSCI TR CME",
}
# 국내장부는 기존 원화유동성의 표시 이름만 변경한다. 프록시·환 기준은 그대로다.
USD_ASSETS = frozenset(["해외채권", "해외주식", "대체투자"])
FX_KEY = "bb:달러원"
WINDOW_YEARS = [1, 3, 5, 10]
REF_YEARS = 10
BENCH_W = {"해외주식": 0.6, "국내채권": 0.4}

GROUPS = {"주식": ["국내주식", "해외주식"], "채권": ["국내채권", "해외채권"],
          "대체": ["대체투자"], "유동성": ["국내장부"]}
GROUP_DEFAULT = {"주식": 50.0, "채권": 30.0, "대체": 20.0}
LIQ_DEFAULT = 10.0
LIQ_RANGE = [0.0, 20.0]

CMA_FILE = "port_cma.json"
MU_BAND = (-50.0, 50.0)
KRW_LIQ_CD_KEY = "bb:한국_크레딧_CD_AAA_3m"


def _me_levels(s: pd.Series) -> pd.Series:
    s = s.sort_index()
    me = s.resample("ME").last().dropna()
    if len(me) and s.index.max() < me.index[-1]:
        me = me.iloc[:-1]
    return me


def _mdd(sub: pd.DataFrame) -> pd.Series:
    cum = (1.0 + sub).cumprod()
    peak = cum.cummax().clip(lower=1.0)
    return (1.0 - cum / peak).max()


def _rd(x, n=8):
    return float(round(float(x), n))


def _stats(sub: pd.DataFrame) -> dict:
    cols = list(sub.columns)
    m = sub.mean() * 12.0
    v = sub.std(ddof=1) * math.sqrt(12.0)
    cov = sub.cov(ddof=1) * 12.0
    corr = sub.corr()
    mdd = _mdd(sub)
    bw = pd.Series(0.0, index=cols)
    for k, w in BENCH_W.items():
        bw[k] = w
    rb = sub.mul(bw, axis=1).sum(axis=1)
    return {
        "n_months": int(len(sub)),
        "start": str(sub.index.min().date()), "end": str(sub.index.max().date()),
        "mean_pct": [_rd(m[c] * 100, 4) for c in cols],
        "vol_pct": [_rd(v[c] * 100, 4) for c in cols],
        "mdd_pct": [_rd(mdd[c] * 100, 4) for c in cols],
        "corr": [[_rd(corr.loc[a, b]) if pd.notna(corr.loc[a, b]) else None
                  for b in cols] for a in cols],
        "cov": [[_rd(cov.loc[a, b]) for b in cols] for a in cols],
        "bench": {"mean_pct": _rd(rb.mean() * 12.0 * 100, 4),
                  "vol_pct": _rd(rb.std(ddof=1) * math.sqrt(12.0) * 100, 4),
                  "mdd_pct": _rd(_mdd(rb.to_frame("b"))["b"] * 100, 4)},
    }


def load_cma_input(data_dir, warn) -> dict | None:
    if data_dir is None:
        return None
    hits = sorted(data_dir.rglob(CMA_FILE))
    if not hits:
        return None
    p = hits[0]
    if len(hits) > 1:
        warn(f"port: {CMA_FILE} 이 {len(hits)}개 — {p} 만 사용")
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        warn(f"port: {p.name} 파싱 실패({e}) — CMA 입력 무시")
        return None
    mu_in = raw.get("mu_pct")
    if not isinstance(mu_in, dict):
        warn(f"port: {p.name} 에 mu_pct 객체가 없음 — CMA 입력 무시")
        return None
    mu = {}
    for k, v in mu_in.items():
        # Data 저장소의 기존 입력을 그대로 읽는다. 새 이름이 있으면 입력 순서와
        # 무관하게 우선하며, 삭제한 달러유동성은 유효성 경고 대상에서도 제외한다.
        if k == "달러유동성":
            continue
        if k == "원화유동성":
            if "국내장부" in mu_in:
                continue
            k = "국내장부"
        if k not in ASSETS:
            warn(f"port: {p.name} 의 알 수 없는 자산군 '{k}' 무시")
            continue
        if (not isinstance(v, (int, float)) or isinstance(v, bool)
                or not (MU_BAND[0] <= v <= MU_BAND[1])):
            warn(f"port: {p.name} 의 {k}={v!r} 는 범위 밖({MU_BAND[0]}~{MU_BAND[1]}%) — 무시")
            continue
        mu[k] = _rd(v, 4)
    if not mu:
        warn(f"port: {p.name} 에 유효한 mu_pct 항목이 없음 — CMA 입력 무시")
        return None
    return {"asof": raw.get("asof") if isinstance(raw.get("asof"), str) else None,
            "mu_pct": {k: mu.get(k) for k in ASSETS}}


def build(series_store: dict, warn, data_dir=None) -> dict:
    defaults = {
        "groups": GROUPS, "group_default": GROUP_DEFAULT,
        "liq_default": LIQ_DEFAULT, "liq_range": LIQ_RANGE,
        "split_note": "그룹 내 국내/해외 균등 분할은 기본값 가정 — 화면에서 조정",
    }
    missing = [PROXY[a] for a in ASSETS if PROXY[a] not in series_store]
    if missing:
        warn(f"port: 프록시 시리즈 없음 — {', '.join(missing)}")
        return {"active": False, "assets": ASSETS, "proxies": PROXY,
                "defaults": defaults, "bench_w": BENCH_W,
                "reason": f"프록시 시리즈 없음: {', '.join(missing)}"}
    if FX_KEY not in series_store:
        warn(f"port: 환율 시리즈({FX_KEY}) 없음 — 원화 환산 불가")
        return {"active": False, "assets": ASSETS, "proxies": PROXY,
                "defaults": defaults, "bench_w": BENCH_W,
                "reason": f"환율 시리즈 없음: {FX_KEY} — 원화 환산 불가"}

    fx_me = _me_levels(series_store[FX_KEY]["s"])
    rets, cover = {}, []
    for a in ASSETS:
        me = _me_levels(series_store[PROXY[a]]["s"])
        if a in USD_ASSETS:
            me = (me * fx_me).dropna()
        r = me.pct_change().dropna()
        rets[a] = r
        ccy = "USD→KRW" if a in USD_ASSETS else "KRW"
        cover.append({"asset": a, "key": PROXY[a], "currency": ccy,
                      "first": str(r.index.min().date()) if len(r) else None,
                      "last": str(r.index.max().date()) if len(r) else None,
                      "n_months": int(len(r))})

    df = pd.DataFrame(rets).dropna()
    if len(df) < 12:
        warn(f"port: 공통 월간 표본 {len(df)}개월 — 비활성 게시")
        return {"active": False, "assets": ASSETS, "proxies": PROXY,
                "defaults": defaults, "bench_w": BENCH_W, "coverage": cover,
                "reason": f"공통 표본 {len(df)}개월 — 최소 12개월 필요"}

    windows = []
    for y in WINDOW_YEARS:
        need = y * 12
        if len(df) <= need:
            continue
        st = _stats(df.iloc[-need:])
        st["key"] = str(y)
        windows.append(st)
    st_all = _stats(df)
    st_all["key"] = "all"
    windows.append(st_all)

    have = {int(w["key"]) for w in windows if w["key"] != "all"}
    missing_windows = [y for y in WINDOW_YEARS if y not in have and y * 12 > len(df)]
    if missing_windows:
        shortest = min(cover, key=lambda c: c["n_months"])
        warn(f"port: 공통 표본 {len(df)}개월 — {'·'.join(map(str, missing_windows))}년 창 미충족 "
             f"(최단 자산 {shortest['asset']} {shortest['first']}~)")

    ref = {}
    need_ref = REF_YEARS * 12
    for a in ASSETS:
        r = rets[a]
        if len(r) < need_ref:
            ref[a] = None
            continue
        rr = r.iloc[-need_ref:]
        ref[a] = {"mean_pct": _rd(rr.mean() * 12.0 * 100, 4),
                  "vol_pct": _rd(rr.std(ddof=1) * math.sqrt(12.0) * 100, 4),
                  "start": str(rr.index.min().date()), "end": str(rr.index.max().date()),
                  "n_months": int(len(rr))}
    bench_pair = pd.DataFrame({k: rets[k] for k in BENCH_W}).dropna()
    bench_ref = None
    if len(bench_pair) >= need_ref:
        bp = bench_pair.iloc[-need_ref:]
        rb = sum(bp[k] * w for k, w in BENCH_W.items())
        bench_ref = {"mean_pct": _rd(rb.mean() * 12.0 * 100, 4),
                     "vol_pct": _rd(rb.std(ddof=1) * math.sqrt(12.0) * 100, 4),
                     "mdd_pct": _rd(_mdd(rb.to_frame("b"))["b"] * 100, 4),
                     "start": str(bp.index.min().date()), "end": str(bp.index.max().date()),
                     "n_months": int(len(bp))}

    cma_input = load_cma_input(data_dir, warn)

    # 국내장부(기존 원화유동성) CD 적립 참고 — 실ETF(2022-04~)보다
    # 긴 CD(AAA) 3M 일할 적립 지수의 10년 μ·σ 와 겹침 검증치를 참고로만 게시한다.
    # 공통 행렬에는 넣지 않는다 — 위험 축은 실ETF 그대로다.
    krw_liq_ref = None
    if KRW_LIQ_CD_KEY in series_store:
        cd = series_store[KRW_LIQ_CD_KEY]["s"].sort_index().dropna()
        if len(cd) >= 24:
            dd = cd.index.to_series().diff().dt.days.iloc[1:]
            acc = (1.0 + cd.shift(1).iloc[1:] / 100.0 * dd / 365.0).cumprod()
            r_cd = _me_levels(acc).pct_change().dropna()
            if len(r_cd) >= 12:
                rr = r_cd.iloc[-REF_YEARS * 12:]
                ov = pd.concat([r_cd.rename("cd"), rets["국내장부"].rename("etf")],
                               axis=1, sort=True).dropna()
                krw_liq_ref = {
                    "key": KRW_LIQ_CD_KEY, "years": REF_YEARS,
                    "mean_pct": _rd(rr.mean() * 12.0 * 100, 4),
                    "vol_pct": _rd(rr.std(ddof=1) * math.sqrt(12.0) * 100, 4),
                    "start": str(rr.index.min().date()), "end": str(rr.index.max().date()),
                    "n_months": int(len(rr)),
                    "overlap": ({"n_months": int(len(ov)),
                                 "corr": _rd(float(ov["cd"].corr(ov["etf"])), 4),
                                 "mean_diff_pa_pct": _rd(float((ov["etf"] - ov["cd"]).mean() * 12 * 100), 4)}
                                if len(ov) >= 12 else None),
                    "note": "CD(AAA) 3M 일할 적립 지수 — 참고 전용(공통 행렬 미포함)",
                }

    return {
        "active": True,
        "asof": str(df.index.max().date()),
        "assets": ASSETS,
        "proxies": PROXY,
        "usd_assets": sorted(USD_ASSETS),
        "fx_key": FX_KEY,
        "basis": "KRW 원화 환산(미헤지) — USD 지수는 월말 달러원 환율로 환산",
        "defaults": defaults,
        "bench_w": BENCH_W,
        "coverage": cover,
        "windows": windows,
        "window_years": WINDOW_YEARS,
        "missing_windows": missing_windows,
        "ref10y": {"years": REF_YEARS, "per_asset": ref, "bench": bench_ref,
                   "note": "자산별 자체 이력 최근 120개월 — 공통 표본이 아니라 행렬 없음(참고 전용)"},
        "cma_input": cma_input,
        "krw_liq_ref": krw_liq_ref,
        "method": "월말 수준 → 월간 수익률 → 연환산(평균 ×12, σ ×√12, 공분산 ×12) · "
                  "마지막 부분월 폐기 · USD 표시 자산(해외채권·해외주식·대체투자)은 "
                  "월말 달러원 곱으로 원화 환산(미헤지) · "
                  "창 종료 = 공통 표본 마지막 월말(경계 포함) · "
                  "대체투자 프록시 = S&P GSCI TR CME(2026-08-22 사용자 확정 — 롤·담보수익 "
                  "포함 총수익. 스팟(S&P GSCI SPOT)은 지시 문자열과 티커가 일치하나 TR 로 확정) · "
                  "벤치마크 = S&P500_TR(원화 환산) 60 / 한국종합 40, 월별 리밸런싱 · "
                  "기대수익률은 계산하지 않는다 — 화면 키인이 정본(과거 평균·CMA 파일은 디폴트)",
    }
