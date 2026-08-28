# -*- coding: utf-8 -*-
"""장기 지평 타깃 학습 실험 — "선행하는 위험지수"가 가능한가 (모델 랩 1호 종자).

2026-08-28 사용자 관찰("우리 리스크 지표가 선행의 느낌이 전혀 없어")의 후속 실험.
실측으로 현재 위험은 동행 지표였다(KOSPI 10영업일 급락과의 상관 봉우리가 시차 0,
2주만 앞서도 +0.04). 가설: 학습 타깃이 「향후 1개월」이라 동행성 짙은 요인(VIX·낙폭)에
가중이 몰린다 — 타깃을 3·6개월로 늘리면 느린 요인(커브·스프레드 압축·사이클)이
떠오르고 합성지수에 선행성이 생기는가.

    python pipeline/research/horizon_lead.py --data-dir <data 저장소 경로>

설계 (여기서 정하는 것은 평가 설계뿐 — 요인 정의는 배포 코드에서 가져온다):
  - 학습 우주 = 스트레스 6 + **활성 취약성 3**(이격·압축·사이클). 취약성 층이
    선행하라고 만든 층인데 배포 합성에는 학습이 없다 — 여기서 처음으로 학습에 넣는다.
    시장 폭(us:*)은 이력이 한 달뿐이라 백테스트 불가로 제외(쌓이면 재검토).
  - 타깃 = 향후 k영업일 실현변동성 (k = 22/66/132 ≈ 1/3/6개월, KOSPI TR·ACWI 평균).
  - walk-forward 규약은 배포와 동일(4주 재학습·최초 156주)하되 **엠바고를 지평에
    맞춰 늘린다**(⌈k/5⌉+1주) — 1개월용 5주 엠바고를 그대로 쓰면 3·6개월 타깃이
    학습 구간과 겹쳐 미래가 샌다.
  - 판정은 타깃 IC가 아니라 **선행 프로파일**: 합성지수_t 와 「t+L주 시점의
    KOSPI 10영업일 수익률(주간 최저)」의 순위상관(L = 0~26주), 그리고
    「다음 13/26주 안에 −10% 돌파」 AUC. 선행성이 목적이므로 동행 상관이 아니라
    L ≥ 4주 쪽이 올라야 성공이다.

주요 결과 (2026-08-28, 환율 요인 이격 교체 후 데이터 · 표본 외 2010~):
    선행 프로파일(합성_t vs t+L주 급락지표, + = 설명):
        전 변형이 사실상 동일 — L=0 +0.21~0.25, L=2 +0.02, **L≥4 전부 음수**(−0.03~−0.07).
        타깃 지평을 6개월로 늘려도, 급락 타깃으로 바꿔도 선행 상관은 생기지 않는다.
    학습 가중은 실제로 이동한다(6개월·최저수익 타깃):
        변동성 34→17% · 커브 0→11.8% · 사이클 0→11.8% (느린 요인이 떠오름)
        그러나 그 가중 이동이 선행성으로 이어지지 않았다 — AUC(26주내 −10%)가
        0.620→0.636 으로 손톱만큼 오를 뿐. 과열 이격도·스프레드 압축은 어느
        타깃에서도 0%(이 표본에서 예측 IC ≤ 0).
    L≥4 의 일관된 음수는 평균회귀의 그림자다 — 위험이 높다 = 급락이 이미 진행 중이라
    이후 4~26주엔 오히려 덜 떨어진다. 즉 **현 지표 우주(시장가격 파생 9요인)로는
    선행 위험지수를 만들 수 없다**. 방법론(지평·타깃·학습)의 문제가 아니라 재료의
    문제 — 선행성은 가격 밖 데이터(포워드 PER·이익 리비전, 시장 폭 이력, 신용여건)가
    확보돼야 시도할 수 있다. §6 데이터 요청(포워드 PER)이 선결 과제.
"""

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import process as P  # noqa: E402
import risk as R  # noqa: E402

spearman, auc = common.spearman, common.auc
REFIT_W, TRAIN_MIN_W = R.REFIT_EVERY_W, R.TRAIN_MIN_W
HORIZONS = [("1개월", 22), ("3개월", 66), ("6개월", 132)]
LEADS = [0, 1, 2, 4, 8, 13, 26]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    args = ap.parse_args()
    P.load_data_dir(args.data_dir)
    S = {k: v["s"] for k, v in P.SERIES.items()}

    D = R.derive_inputs(S)
    facs = [f for f in R.factor_specs(D) if not f.get("pending")]
    keys = [f["name"] for f in facs]
    F = pd.DataFrame({f["name"]: pd.concat([i.weekly() for i in f["inds"]],
                                           axis=1, sort=True).mean(axis=1)
                      for f in facs}).dropna()
    print("요인 9개(스트레스 6 + 활성 취약성 3): " + " / ".join(keys))
    print(f"주별 점수: {F.index[0].date()} ~ {F.index[-1].date()} ({len(F)}주)")

    kospi, acwi = D["kospi"], D["acwi"]

    def fwd_stats(price, k):
        p = price.dropna()
        vol, mn = {}, {}
        for d in F.index:
            i = p.index.searchsorted(d, side="right")
            seg = p.iloc[i:i + k]
            if len(seg) >= int(k * 0.7) and i > 0:
                vol[d] = float(seg.pct_change().dropna().std() * math.sqrt(252) * 100)
                mn[d] = float(seg.min() / p.iloc[i - 1] - 1) * 100
        return pd.Series(vol), pd.Series(mn)

    # 선행 판정축 — KOSPI(PR) 10영업일 전 대비 수익률의 주간 최저(대시보드 대조 축과 동일)
    pr = S.get("bb:한국_KOSPI_PR", kospi).dropna()
    wm = (pr.pct_change(10) * 100).resample("W-FRI").min().dropna()

    def wf_composite(target, embargo_w, sign=1.0):
        """sign=+1: 타깃이 클수록 위험(변동성). sign=-1: 작을수록 위험(최저 수익률)."""
        data = F.join(target.rename("tgt")).dropna()
        X = data[keys]
        marks = set(data.index[::REFIT_W])
        comp, cur = pd.Series(index=data.index, dtype=float), None
        for t in data.index:
            if t in marks:
                train = data[data.index <= t - pd.Timedelta(weeks=embargo_w)]
                if len(train) >= TRAIN_MIN_W:
                    ics = sign * np.array([spearman(train[k], train["tgt"]) for k in keys])
                    w = np.clip(np.nan_to_num(ics), 0, None)
                    if w.sum() > 0:
                        cur = w / w.sum()
            if cur is not None:
                comp[t] = float(X.loc[t].values @ cur)
        return comp.dropna(), cur

    oos_from = pd.Timestamp("2010-01-01")

    def lead_profile(comp):
        j = pd.concat([comp.rename("c"), wm.rename("wm")], axis=1, sort=True)
        j = j[j.index >= oos_from]
        out = []
        for L in LEADS:
            pair = pd.concat([j["c"], j["wm"].shift(-L)], axis=1).dropna()
            out.append(-spearman(pair.iloc[:, 0], pair.iloc[:, 1]))
        return out

    def crash_auc(comp, kw):
        flag = (wm.rolling(kw).min().shift(-kw) <= -10).astype(float)
        j = pd.concat([comp.rename("c"), flag.rename("f")], axis=1, sort=True).dropna()
        j = j[j.index >= oos_from]
        return auc(j["c"], j["f"].astype(int)), int(j["f"].sum())

    fs = {k_: fwd_stats(kospi, k_) for _, k_ in HORIZONS}
    fs_a = {k_: fwd_stats(acwi, k_) for _, k_ in HORIZONS}
    variants = []
    for nm, k in HORIZONS:
        emb = math.ceil(k / 5) + 1
        t_vol = pd.concat([fs[k][0], fs_a[k][0]], axis=1, sort=True).mean(axis=1).dropna()
        t_min = pd.concat([fs[k][1], fs_a[k][1]], axis=1, sort=True).mean(axis=1).dropna()
        variants.append((f"{nm}·변동성", wf_composite(t_vol, emb)))
        variants.append((f"{nm}·최저수익", wf_composite(t_min, emb, sign=-1.0)))

    print(f"\n선행 프로파일 — 합성_t vs t+L주 KOSPI 10영업일 수익률(주간 최저), 2010~")
    print(f"{'타깃':<12}" + "".join(f"L={l:<5}" for l in LEADS)
          + "  AUC(13주내 -10%)  AUC(26주내)")
    for nm, (comp, _) in variants:
        prof = lead_profile(comp)
        a13, n13 = crash_auc(comp, 13)
        a26, n26 = crash_auc(comp, 26)
        print(f"{nm:<12}" + "".join(f"{v:+.2f}  " for v in prof)
              + f"   {a13:.3f} ({n13}주)      {a26:.3f} ({n26}주)")

    print("\n마지막 재학습 가중 (타깃별):")
    print(f"{'요인':<14}" + "".join(f"{nm:>12}" for nm, _ in variants))
    for i, kname in enumerate(keys):
        row = "".join(f"{w[i]:>12.1%}" if w is not None else f"{'–':>12}"
                      for _, (_, w) in variants)
        print(f"{kname:<14}" + row)


if __name__ == "__main__":
    main()
