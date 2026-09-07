# -*- coding: utf-8 -*-
"""리스크 점수 → λ 대용치 → 월별 λ-효용 MVO — 비중 경로 검토 하네스 (2026-08-31 사용자 요청).

    python pipeline/research/risk_lambda_alloc.py --data-dir <data 저장소 경로> [--dump 경로.json]

CI 빌드에 포함되지 않는다. `wf_validation.py`·`regime_layer.py` 와 같은 위치·같은 성격의
수동 하네스다. **오프라인 검토 전용** — HANDOVER §5.1 의 λ_dynamic 연동(ⓑ)은 미채택
그대로이고, 이 하네스는 배포 코드·화면 어디에도 연결되지 않는다. λ 는 여전히 사용자
모형 입력이다(§7.7.12) — 여기서 하는 일은 "리스크 모듈의 측정치를 λ 로 썼다면 최적
배분이 어떻게 움직였을까"를 눈으로 보는 것뿐이다.

설계 결정 — 전부 기존 규약의 재사용이고, 새로 정한 것은 매핑 하나다:

1. **점수 → λ 매핑 두 벌 — 같은 앵커(점수 50 ↔ λ 1), 기울기만 다르다.** 앵커 두 값은
   기존 상수의 재사용이다: 점수 50 은 0~100 백분위 척도의 중앙이자 등급 4등분
   (risk.GRADE_BANDS)의 보통↔주의 경계, λ = 1 은 엔진 기본값(app.js `mvo_lambda: 1`,
   소수 단위). ① **선형** λ = 점수/50 (발명 상수 0개). 실측 결과 이 매핑의 치역
   λ∈[0,2] 는 **전부 최대수익 코너**다 — 기본 μ 스프레드(2.09~6.86%p)와 밴드 아래서
   위험 페널티가 배분을 움직이기 시작하는 문턱이 λ≈2.5 라서, 선형 매핑으로는 25년
   내내 비중이 한 번도 안 변한다(그 자체가 이 실험의 발견 1). ② **로그** λ =
   10^((점수−50)/25) — 등급 한 칸(25점)당 λ ×10, 치역 [0.01, 100] 이 w*(λ) 의 실효
   구간(코너~최소위험, 실측 λ 2.5~100)을 덮는다. 기울기 "한 등급 = 한 자릿수"가 이
   하네스가 새로 정한 유일한 상수이고, 그 민감도는 w*(λ) 프로파일 출력으로 보인다 —
   매핑 확정은 사용자 몫이다(λ 소유권 §7.7.12).
2. **μ·Σ 는 현재 CMA 로 고정하고 λ 만 시간을 탄다.** 이 실험의 질문이 "λ 채널"이라
   Σ 까지 롤링하면 두 효과가 섞인다(Σ 민감도는 시변·창 카드가 이미 따로 본다).
   따라서 이것은 과거 시점 정보만 쓴 백테스트가 **아니다** — 같은 오늘의 μ·Σ 에
   그날의 λ 를 꽂은 정적 단면의 나열이다.
3. **엔진은 app.js CMA 층의 1:1 복제다.** 공분산 조립은 `buildCmaFrom`(계열별 h₀ —
   해외채권 1·해외주식 0, 대체투자 분류별 팩터 매핑 50/50 + 스팬 잔차 독립 가산,
   h_alt 반영), 최적화는 `amOptimizeUtil`(투영 경사법, 소수 단위 λ) 그대로.
   실행 조건은 alloc.DEFAULTS 자리표시자(μ=mu_over 7키 최종치, 밴드, hb=he=90,
   h_alt=90)에 화면 기본 창 5년 — 단 게시 창에 "5" 가 없으면 화면과 같은 규칙으로
   마지막 창(전체 공통 표본)에 폴백한다(2026-08-31 실행 시 실제로 그 경우 — 시가
   국내주식 개시 2021-12 라 공통 표본 48개월, "all" 창만 게시됨). 그룹 상한
   (cap_foreign 등)은 기본 null 이라 범위 밖. 복제 정확성은 node 로 app.js 원본
   함수를 그대로 돌려 교차검증했다(아래 실행 기록).
4. **리스크 점수 = risk.build 재구성** (regime_layer.py 와 같은 방식) —
   rw["weekly"]["stress"](현재 위험, IC가중+바닥)·rw["weekly"]["vuln"](잠재 위험,
   동일가중). 월별 값은 각 달의 마지막 주간 관측(ME last)이고 마지막 달은
   월중까지의 값이다.

실행 기록 (2026-08-31, 실데이터 483 시리즈, exit 0):
  - node 교차검증: 같은 C·μ·λ 9조합(0.1~100)에서 파이썬 복제 vs app.js 원본
    amOptimizeUtil(vm 실행) 최대 |Δw| = 6.7e-16 — 부동소수 잡음 수준까지 일치.
    수렴 스팟체크(iters 3000 vs 12000) 0.0000%p.
  - w*(λ) 실효 구간(기본 μ·밴드): λ≲2.5 최대수익 코너 고정 / λ≈100 에서 최소위험
    코너(국내채권 55·해외채권 30·단기 15) 도달. σ* 2.72~7.54%, 단조 감소 assert 통과.
  - 현재 위험(2009-01~2026-07, 211개월, 점수 21~91): 매핑 ① λ 0.42~1.83 → **턴오버
    0.00%p, 전 기간 코너 그대로**(발견 1 실증). 매핑 ② λ 0.07~44.9 → 월평균 편측
    턴오버 3.44%p, 국내채권 38→55·단기 2→15 로 확장되는 방어 전환이 위기 국면에만 발생.
  - 잠재 위험(2006-03~2026-08, 246개월, 점수 0~85): 매핑 ① 동일하게 무변화. 매핑 ②
    λ ≤25.8 라 지분형 25 상한이 끝까지 유지 — 취약성 축은 방어 전환이 더 얕다.
  - 결과 요약은 stdout 표 + (옵션) --dump JSON — 저장소 안에 파일을 남기지 않는다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import alloc as AL   # noqa: E402  (DEFAULTS — μ·밴드·헤지 자리표시자)
import bm            # noqa: E402
import process as P  # noqa: E402
import risk          # noqa: E402

# app.js ALLOC_ECON 과 같은 순서 — tests/test_formulas.py 가 인덱스(해외채권 1·해외주식 3)를
# 고정하는 그 축이다. 대출형 4·지분형 5 (buildCmaFrom 의 rDt·rEq 순서).
ASSETS = ["국내채권", "해외채권", "국내주식", "해외주식",
          "대체투자(대출형)", "대체투자(지분형)", "단기자금"]

# 점수 → λ 매핑 앵커 (docstring 1번 — 앵커 두 개 모두 기존 상수의 재사용)
LAM_ANCHOR_SCORE = 50.0   # 백분위 중앙 = 등급 보통↔주의 경계 (risk.GRADE_BANDS)
LAM_AT_ANCHOR = 1.0       # 엔진 기본 λ (app.js mvo_lambda 기본값, 소수 단위)
GRADE_BAND_W = 25.0       # 등급 한 칸의 폭 (0~100 의 4등분) — 로그 매핑의 기울기 단위


def lam_lin(score: float) -> float:
    """매핑 ① 선형 — λ = 점수/50. 발명 상수 0개, 치역 [0,2] (실측: 전부 코너)."""
    return max(float(score), 0.0) * LAM_AT_ANCHOR / LAM_ANCHOR_SCORE


def lam_log(score: float) -> float:
    """매핑 ② 로그 — 등급 한 칸당 λ ×10, 치역 [0.01, 100] (w*(λ) 실효 구간을 덮음)."""
    return LAM_AT_ANCHOR * 10 ** ((float(score) - LAM_ANCHOR_SCORE) / GRADE_BAND_W)


# ---------------------------------------------------------------------------
# app.js 수학 엔진 복제 — amProject / amOptimizeUtil (그룹 상한 없음 = 기본 상태)
# ---------------------------------------------------------------------------

def project(w: np.ndarray, lo: np.ndarray, hi: np.ndarray, total: float) -> np.ndarray:
    """박스 ∩ {합=total} 유클리드 투영 — 이분 40회 (app.js amProject 와 동일)."""
    a, b = -2.0, 2.0
    for _ in range(40):
        m = (a + b) / 2
        if np.clip(w + m, lo, hi).sum() > total:
            b = m
        else:
            a = m
    return np.clip(w + (a + b) / 2, lo, hi)


def optimize_util(mu: np.ndarray, C: np.ndarray, lo: np.ndarray, hi: np.ndarray,
                  total: float, lam: float, iters: int = 3000) -> np.ndarray:
    """λ-효용 MVO: max μ'w − (λ/2)·w'Σw — app.js amOptimizeUtil 1:1 (C %²·μ %·λ 소수)."""
    w = project(np.full(len(mu), total / len(mu)), lo, hi, total)
    for _ in range(iters):
        g = lam * (C @ w) / 1e4 - mu / 100.0
        gm = max(1e-12, np.abs(g).max())
        w = project(w - 0.02 * g / gm, lo, hi, total)
    return w


# ---------------------------------------------------------------------------
# CMA 층 조립 — app.js buildCmaFrom 복제 (기본 상태: 창 5년, hb=he=0.9, h_alt=0.9,
# 분류별 매핑 50/50, σ 키인 없음)
# ---------------------------------------------------------------------------

def build_engine(cma: dict, warn):
    if not cma.get("active"):
        raise SystemExit(f"CMA 비활성 — {cma.get('reason')}")
    win = next((w for w in cma["windows"] if w["key"] == "5"), cma["windows"][-1])
    cols = cma["cols"]
    ci = {c: i for i, c in enumerate(cols)}
    need = ["시가 국내채권", "시가 해외채권", "시가 국내주식", "시가 해외주식",
            "시가 대체투자", "장부가 단기자금", "_alt", "_fx"]
    missing = [c for c in need if c not in ci]
    if missing:
        raise SystemExit(f"CMA 열 누락: {missing}")
    M = np.array(win["cov"], dtype=float)          # 연율 (소수)²

    d = AL.DEFAULTS
    hb, he, h_alt = d["h_bond"] / 100, d["h_eq"] / 100, d["h_alt"] / 100
    H0 = {"시가 해외채권": 1.0, "시가 해외주식": 0.0}   # app.js CMA_BM_H0

    def base(lb):
        r = np.zeros(len(cols))
        r[ci[lb]] = 1.0
        return r

    def with_fx(r, add):
        if abs(add) > 1e-12:
            r[ci["_fx"]] += add
        return r

    def alt_row(we, wb):
        r = np.zeros(len(cols))
        r[ci["시가 해외주식"]] += we / 100
        r[ci["시가 국내채권"]] += wb / 100
        if we != 0 and h_alt != 0:
            r[ci["_fx"]] -= h_alt * (we / 100)     # 뺄셈이 정상 — §7.7.20
        return r

    # 스팬 잔차 (app.js cmaAltRows 의 idio 폐형)
    iE, iB, ai = ci["시가 해외주식"], ci["시가 국내채권"], ci["_alt"]
    fEE, fEB, fBB = M[iE, iE], M[iE, iB], M[iB, iB]
    cE, cB = M[iE, ai], M[iB, ai]
    det = fEE * fBB - fEB * fEB
    expl = ((fBB * cE * cE - 2 * fEB * cE * cB + fEE * cB * cB) / det
            if det > 1e-18 else (cE * cE / fEE if fEE > 1e-18 else 0.0))
    idio = max(M[ai, ai] - expl, 0.0)

    rows = np.stack([base("시가 국내채권"),
                     with_fx(base("시가 해외채권"), H0["시가 해외채권"] - hb),
                     base("시가 국내주식"),
                     with_fx(base("시가 해외주식"), H0["시가 해외주식"] - he),
                     alt_row(50, 50),              # 대출형 (기본 매핑)
                     alt_row(50, 50),              # 지분형 (기본 매핑)
                     base("장부가 단기자금")])
    C = rows @ M @ rows.T * 1e4                    # %² 단위 (app.js 와 동일)
    for k in ("대체투자(지분형)", "대체투자(대출형)"):
        i = ASSETS.index(k)
        C[i, i] += idio * 1e4

    mu = np.array([d["mu_over"][k] for k in ASSETS], dtype=float)   # 연 % (최종치)
    lo = np.array([d["bands"][k][0] for k in ASSETS]) / 100
    hi = np.array([d["bands"][k][1] for k in ASSETS]) / 100
    meta = {"window": {k: win[k] for k in ("key", "start", "end", "n_months")},
            "hb": hb, "he": he, "h_alt": h_alt, "alt_map": "50/50 (기본)",
            "mu_pct": dict(zip(ASSETS, mu.tolist())),
            "bands_pct": {k: d["bands"][k] for k in ASSETS},
            "idio_sig_pct": float(np.sqrt(idio) * 100)}
    return mu, C, lo, hi, meta


def sigma_w(w: np.ndarray, C: np.ndarray) -> float:
    return float(np.sqrt(max(w @ C @ w, 0.0)))     # % (C 가 %²)


def main() -> None:
    apr = argparse.ArgumentParser()
    apr.add_argument("--data-dir", required=True)
    apr.add_argument("--dump", default=None,
                     help="차트용 JSON 을 쓸 경로(저장소 밖) — 기본은 stdout 표만")
    apr.add_argument("--iters", type=int, default=3000)
    args = apr.parse_args()

    warn = lambda m: None   # noqa: E731 — 검토 하네스: 경고는 파이프라인 실행이 정본
    P.load_data_dir(Path(args.data_dir))
    print("[1] CMA 조립 (bm.build_cma — 화면 기본 창 5 · 없으면 마지막 창 폴백, DEFAULTS 자리표시자 상태)")
    mu, C, lo, hi, meta = build_engine(bm.build_cma(P.SERIES, warn), warn)
    w = meta["window"]
    print(f"    창 {w['key']} · 표본 {w['start']} ~ {w['end']} ({w['n_months']}개월) · "
          f"hb/he/h_alt = {meta['hb']:.0%}/{meta['he']:.0%}/{meta['h_alt']:.0%} · "
          f"잔차 σ {meta['idio_sig_pct']:.2f}%")

    print(f"[2] 리스크 점수 재구성 (risk.build — regime_layer.py 와 동일 경로)")
    _, _, rw = risk.build(P.SERIES, warn)
    layers = {"stress": ("현재 위험", rw["weekly"]["stress"].dropna()),
              "vuln": ("잠재 위험", rw["weekly"]["vuln"].dropna())}

    cache: dict[float, np.ndarray] = {}

    def w_star(lam: float) -> np.ndarray:
        if lam not in cache:
            cache[lam] = optimize_util(mu, C, lo, hi, 1.0, lam, args.iters)
        return cache[lam]

    # 수렴 스팟체크 — 3000 vs 12000
    dev = max(np.abs(optimize_util(mu, C, lo, hi, 1.0, l, args.iters)
                     - optimize_util(mu, C, lo, hi, 1.0, l, args.iters * 4)).max()
              for l in (0.1, 1.0, 10.0))
    print(f"    수렴 스팟체크 max|Δw| (iters {args.iters} vs {args.iters * 4}) = {dev * 100:.4f}%p")

    out = {"meta": {**meta,
                    "mapping": {"lin": "λ = 점수/50 (앵커: 점수 50 ↔ λ 1)",
                                "log": "λ = 10^((점수−50)/25) — 등급 한 칸당 ×10, 같은 앵커"},
                    "objective": "max μ'w − (λ/2)·w'Σw · 합계 100% · 밴드 = DEFAULTS",
                    "fixed": "μ·Σ 현재 CMA 고정 — λ 만 시간 축 (백테스트 아님)"},
           "assets": ASSETS, "series": {}, "profile": {}}

    for key, (label, weekly) in layers.items():
        monthly = weekly.resample("ME").last().dropna()
        entry = {"label": label,
                 "dates": [d.strftime("%Y-%m-%d") for d in monthly.index],
                 "score": [round(float(v), 1) for v in monthly]}
        for mk, fn in (("lin", lam_lin), ("log", lam_log)):
            lams = [fn(v) for v in monthly.to_numpy()]
            W = np.stack([w_star(l) for l in lams]) * 100   # %
            turn = float(np.abs(np.diff(W, axis=0)).sum(axis=1).mean() / 2)
            print(f"[3] {label} · 매핑 {mk}: {monthly.index[0].date()} ~ "
                  f"{monthly.index[-1].date()} ({len(monthly)}개월) · "
                  f"점수 {monthly.min():.0f}~{monthly.max():.0f} · "
                  f"λ {min(lams):.3g}~{max(lams):.3g} · 월평균 편측 턴오버 {turn:.2f}%p")
            rng = " | ".join(f"{a[:4]} {W[:, i].min():.1f}~{W[:, i].max():.1f}"
                             for i, a in enumerate(ASSETS))
            print(f"    비중 범위(%) {rng}")
            entry[mk] = {"lam": [round(l, 4) for l in lams],
                         "w": [[round(float(x), 2) for x in row] for row in W]}
        out["series"][key] = entry

    # w*(λ) 프로파일 — 매핑을 바꾸면 어디로 가는지 보이는 참고 축 (로그 격자)
    grid = np.geomspace(0.02, 100, 49)
    PW = np.stack([w_star(float(l)) for l in grid]) * 100
    sig = [sigma_w(cache[float(l)], C) for l in grid]
    assert all(sig[i] >= sig[i + 1] - 1e-9 for i in range(len(sig) - 1)), \
        "σ*(λ) 단조 감소 위반 — 엔진 복제 오류"
    out["profile"] = {"lam": [round(float(l), 4) for l in grid],
                      "w": [[round(float(x), 2) for x in row] for row in PW],
                      "sigma": [round(s, 3) for s in sig]}
    print(f"[4] w*(λ) 프로파일: λ 0.02~100 · σ* {sig[-1]:.2f}~{sig[0]:.2f}% (단조 확인)")

    if args.dump:
        Path(args.dump).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        print(f"[5] dump → {args.dump}")


if __name__ == "__main__":
    main()
