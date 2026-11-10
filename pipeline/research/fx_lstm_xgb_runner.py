# -*- coding: utf-8 -*-
"""환율모형B 별도 학습 러너 — LSTM·XGBoost walk-forward 원/달러 수준 예측 (퀀트팀 모형 이식).

직접 실행하거나 CSV 세 개가 준비된 빌드에서 실행한다. torch·xgboost·statsmodels·scikit-learn 이 필요하다
(`pipeline/research/requirements-fx-lstm-xgb.txt`). 파이프라인 고정 의존성 3개와 섞지 말 것.

입력 CSV 3개는 비공개 Data 저장소 `models/fx_lstm_xgb/` 에 둔다 (파이프라인은 .xlsx 만
재귀 탐색하므로 CSV 는 시리즈로 흘러들지 않는다):
  table.csv      — date, dollar_index, spot, future, usa_3m, usa_1y, usa_3y, usa_10y, kr_3m, kr_1y, kr_3y, kr_10y (월말)
  국제수지_1.csv — 변환, 경상수지, 증권투자(자산), 부채성증권(자산), 증권투자(부채), 부채성증권(부채)
  국제수지_2.csv — 변환, 투자소득수익, 직접투자소득수익, 증권투자소득수익, 기타투자소득수익, 재투자소득수익
산출물 `fx_lstm_xgb.json` 을 같은 폴더에 쓰고 커밋하면 `pipeline/fx_lstm_xgb.py` 가
`fx.json.lstm_xgb` 로 게시하고 `dashboard/fx-lstm-xgb.js` 가 환율전망 › 환율모형B 에 그린다.
게시되는 것은 기준일·예측시점·기준 환율·실제 환율·모형 예측치뿐이다 — 국제수지·금리
피처값은 JSON 에 싣지 않는다(비공개 원자료).

운영 v2의 정보시점·시간축 규칙:
  · 국제수지 결합: 행 위치가 아니라 월(YYYY-MM) 기준 조인. '변환' 의 01-Jan / Jan-01 두 표기 모두 해석.
  · 국제수지 공표 지연: --bop-lag (기본 2개월) 만큼 피처를 뒤로 민다 — 월말 기준일에 그 달·전달
    국제수지는 아직 공표 전이다. 원 코드는 0.
  · NS 요인 결측: 앞채움(ffill) 또는 결측 유지(none). 미래값을 섞는 interpolate는 운영에서 거부한다.
  · 달력 월 격자: 없는 달·피처 결측을 삭제하지 않으며 ARIMA·LSTM 창도 월 간격을 보존한다.
  · 학습 라벨: 기준월 t에서 실현된 t−lag 이하 기준월의 타깃만 쓴다. 누수 재현 플래그는 거부한다.
  · LSTM: 마지막 입력 기준월과 라벨 기준월이 같다. v1의 한 행 추가 지평을 교정했다.
  · 시드 고정: --seed 기본 20261019 (torch는 기준월 키를 더함, XGBRegressor(random_state, n_jobs=1)).
  · 그리드: --lags 1,3,6,9,12 × --windows 24,36 을 전부 walk-forward 로 돌려 한 JSON 에 싣는다.
그 밖의 산식은 원 코드 그대로다: NS λ=0.7308·만기 0.25/1/3/10년, ARIMA(1,1,1) 36개월 롤링 계수,
피처 10개(spot·경상수지·증권투자(자산)·직접투자비율(수익)·증권투자비율(수익)·NS 3·AR(1)·MA(1)),
StandardScaler, XGBRegressor 기본값, LSTM hidden 32·1층·seq 6·100 epoch·Adam 1e-3·전체배치,
앙상블 = XGB·LSTM 단순평균. 랜덤워크(기준일 환율 유지)는 화면 대조용으로 기준 환율을 싣는다.

실행 예:
  python pipeline/research/fx_lstm_xgb_runner.py --data-dir ../Data/models/fx_lstm_xgb
  python pipeline/research/fx_lstm_xgb_runner.py --data-dir ../Data/models/fx_lstm_xgb --epochs 5 --max-steps 10  # 스모크
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

SCHEMA = "fx_lstm_xgb/2"
RUNNER_VERSION = "2"
LABEL_ALIGNMENT = "calendar_month_target_realized_by_base_date"
SEQUENCE_ALIGNMENT = "last_input_month_matches_label_origin"
TRAIN_WINDOW = "consecutive_calendar_origin_months"
ARTIFACT = "fx_lstm_xgb.json"
MODELS = ("xgb", "lstm", "ensemble")
FEATURES = ["spot", "경상수지", "증권투자(자산)", "직접투자비율(수익)", "증권투자비율(수익)",
            "ns_level", "ns_slope", "ns_curvature", "AR(1)", "MA(1)"]
NS_LAMBDA = 0.7308
NS_MATURITIES = np.array([0.25, 1.0, 3.0, 10.0])
NS_SPREADS = [("3m_spread", "usa_3m", "kr_3m"), ("1y_spread", "usa_1y", "kr_1y"),
              ("3y_spread", "usa_3y", "kr_3y"), ("10y_spread", "usa_10y", "kr_10y")]
BOP1_COLS = ["경상수지", "증권투자(자산)", "부채성증권(자산)", "증권투자(부채)", "부채성증권(부채)"]
BOP2_COLS = ["투자소득수익", "직접투자소득수익", "증권투자소득수익", "기타투자소득수익", "재투자소득수익"]
REGIME_DEFAULTS = {"low_below": 1100.0, "high_above": 1300.0}   # 노트북의 국면 경계(원/달러)
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


# ----------------------------------------------------------------------
# 1. 입력 — 날짜·숫자 해석
# ----------------------------------------------------------------------
def parse_bop_month(text) -> pd.Period | None:
    """ECOS '변환' 셀 → 월 Period. 01-Jan(YY-Mon) · Jan-01(Mon-YY) · 2001-01 · 2001/01 · 2001.01 · 2001-01-31."""
    if text is None or (isinstance(text, float) and math.isnan(text)):
        return None
    s = str(text).strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d{4})[-./]?(\d{1,2})(?:[-./]\d{1,2})?", s)
    if m:
        return pd.Period(year=int(m.group(1)), month=int(m.group(2)), freq="M")
    m = re.fullmatch(r"(\d{2})-([A-Za-z]{3})", s)             # 01-Jan
    if m and m.group(2).lower() in MONTHS:
        return pd.Period(year=2000 + int(m.group(1)), month=MONTHS[m.group(2).lower()], freq="M")
    m = re.fullmatch(r"([A-Za-z]{3})-(\d{2,4})", s)            # Jan-01 / Jan-2001
    if m and m.group(1).lower() in MONTHS:
        year = int(m.group(2))
        return pd.Period(year=year + 2000 if year < 100 else year, month=MONTHS[m.group(1).lower()], freq="M")
    try:
        return pd.Timestamp(s).to_period("M")
    except (ValueError, TypeError):
        return None


def to_number(series: pd.Series) -> pd.Series:
    """'1,509.40' 같은 천단위 문자열 → float. 빈 칸·'-' 은 NaN."""
    if series.dtype.kind in "fi":
        return series.astype(float)
    cleaned = series.astype(str).str.replace(",", "", regex=False).str.strip()
    cleaned = cleaned.replace({"": np.nan, "-": np.nan, "nan": np.nan, "None": np.nan})
    return pd.to_numeric(cleaned, errors="coerce")


def monthly_grid(frame: pd.DataFrame) -> pd.DataFrame:
    """One observation per month, dated at month-end; absent months stay missing.

    Input dates identify an observation month (e.g. its last business day).
    Decisions are made at calendar month-end, never before that observation.
    Duplicate months cannot be resolved without an explicit source rule.
    """
    if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.hasnans:
        raise ValueError("유효한 월별 DatetimeIndex가 필요합니다")
    if frame.index.tz is not None:
        raise ValueError("월별 입력 날짜는 시간대 없는 날짜여야 합니다")
    ordered = frame.sort_index().copy()
    months = ordered.index.to_period("M")
    if months.has_duplicates:
        raise ValueError("같은 달이 두 번 나옵니다")
    if not len(ordered):
        return ordered
    ordered.index = months
    ordered = ordered.reindex(pd.period_range(months[0], months[-1], freq="M"))
    ordered.index = ordered.index.to_timestamp(how="end").normalize()
    ordered.index.name = "date"
    return ordered


def load_table(path: Path, drop_last_row: bool = True) -> tuple[pd.DataFrame, dict]:
    table = pd.read_csv(path)
    table.columns = [str(c).strip() for c in table.columns]
    if "date" not in table.columns or "spot" not in table.columns:
        raise ValueError("table.csv 에 date·spot 열이 필요합니다")
    table["date"] = pd.to_datetime(table["date"])
    table = table.sort_values("date").reset_index(drop=True)
    if table["date"].isna().any() or table["date"].dt.to_period("M").duplicated().any():
        raise ValueError("table.csv에 유효하지 않은 날짜 또는 중복 월이 있습니다")
    dropped = None
    if drop_last_row and len(table):
        dropped = table["date"].iloc[-1].strftime("%Y-%m-%d")
        table = table.iloc[:-1, :]                      # 원 코드: 마지막 행(미완성 월) 제거
    table = table.set_index("date", drop=True)
    for col in table.columns:
        table[col] = to_number(table[col])
    observed_rows = len(table)
    table = monthly_grid(table)
    return table, {"rows": int(observed_rows), "calendar_months": len(table),
                   "missing_months": len(table) - observed_rows, "dropped_last_row": dropped,
                   "start": table.index[0].strftime("%Y-%m-%d") if len(table) else None,
                   "end": table.index[-1].strftime("%Y-%m-%d") if len(table) else None}


def load_bop(data_dir: Path) -> tuple[pd.DataFrame, dict]:
    """국제수지 두 파일을 월 기준으로 결합하고 비율 피처를 만든다."""
    frames = []
    for name, cols in (("국제수지_1.csv", BOP1_COLS), ("국제수지_2.csv", BOP2_COLS)):
        df = pd.read_csv(data_dir / name)
        df.columns = [str(c).strip() for c in df.columns]
        if "변환" not in df.columns:
            raise ValueError(f"{name} 에 '변환' 열이 없습니다")
        missing = [c for c in cols if c not in df.columns]
        if missing:
            raise ValueError(f"{name} 에 열이 없습니다: {missing}")
        df["month"] = [parse_bop_month(v) for v in df["변환"]]
        bad = df["month"].isna().sum()
        if bad:
            raise ValueError(f"{name}: 해석 불가한 '변환' 값 {bad}건")
        df = df.set_index("month")[cols].apply(to_number)
        if df.index.duplicated().any():
            raise ValueError(f"{name}: 같은 달이 두 번 나옵니다")
        frames.append(df)
    bop = pd.concat(frames, axis=1, join="inner").sort_index()
    bop["재투자비율(수익)"] = bop["재투자소득수익"] / bop["직접투자소득수익"]
    bop["직접투자비율(수익)"] = bop["직접투자소득수익"] / bop["투자소득수익"]
    bop["증권투자비율(수익)"] = bop["증권투자소득수익"] / bop["투자소득수익"]
    bop["본원소득수지"] = (bop["증권투자(자산)"] + bop["부채성증권(자산)"]
                        - bop["증권투자(부채)"] - bop["부채성증권(부채)"])
    return bop, {"months": int(len(bop)), "start": str(bop.index[0]) if len(bop) else None,
                 "end": str(bop.index[-1]) if len(bop) else None}


def join_bop(table: pd.DataFrame, bop: pd.DataFrame, bop_lag: int) -> tuple[pd.DataFrame, dict]:
    """월말 표(table) 에 국제수지를 월 기준으로 붙인다. bop_lag 개월 전 자료를 쓴다(공표 지연)."""
    months = table.index.to_period("M")
    shifted = bop.copy()
    shifted.index = shifted.index + bop_lag
    aligned = shifted.reindex(months)
    aligned.index = table.index
    matched = int(aligned["경상수지"].notna().sum())
    return pd.concat([aligned, table], axis=1), {"bop_lag_months": int(bop_lag), "matched_months": matched,
                                                  "unmatched_months": int(len(table) - matched)}


# ----------------------------------------------------------------------
# 2. 피처 — Nelson–Siegel 금리차 요인 · 롤링 ARIMA 계수
# ----------------------------------------------------------------------
def ns_loadings(lambda_: float = NS_LAMBDA, maturities: np.ndarray = NS_MATURITIES) -> np.ndarray:
    x = lambda_ * maturities
    slope = (1 - np.exp(-x)) / x
    return np.column_stack([np.ones_like(maturities), slope, slope - np.exp(-x)])


def ns_factors(table: pd.DataFrame, fill: str = "ffill") -> pd.DataFrame:
    """미국−한국 금리차 4개를 NS 3요인으로 최소자승 적합. 유효 만기 3개 미만인 달은 결측."""
    spreads = pd.DataFrame({name: table[us] - table[kr] for name, us, kr in NS_SPREADS}, index=table.index)
    X = ns_loadings()
    out = np.full((len(spreads), 3), np.nan)
    for i, row in enumerate(spreads.to_numpy(dtype=float)):
        valid = np.isfinite(row)
        if valid.sum() < 3:
            continue
        out[i] = np.linalg.lstsq(X[valid], row[valid], rcond=None)[0]
    factors = pd.DataFrame(out, index=table.index, columns=["ns_level", "ns_slope", "ns_curvature"])
    if fill == "ffill":
        factors = factors.ffill()
    elif fill == "interpolate":                       # 원 코드 — 양방향 보간(미래값 사용)
        factors = factors.interpolate(method="linear")
    elif fill != "none":
        raise ValueError(f"unknown ns fill: {fill}")
    return factors


def arma_factors(spot: pd.Series, window: int = 36) -> pd.DataFrame:
    """롤링 ARIMA(1,1,1) 의 AR(1)·MA(1) 계수 — 원 코드 그대로(창 미달·적합 실패는 NaN)."""
    from statsmodels.tsa.arima.model import ARIMA  # 지연 import — 테스트가 피처 함수만 쓸 수 있게
    import warnings
    spot = monthly_grid(spot.to_frame("spot"))["spot"]
    rows = []
    for i in range(window, len(spot) + 1):
        y = spot.iloc[i - window:i].dropna()
        if len(y) < window:
            continue
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                fit = ARIMA(y.to_numpy(dtype=float), order=(1, 1, 1)).fit()
            params = dict(zip(fit.model.param_names, fit.params))
            rows.append({"date": spot.index[i - 1], "AR(1)": params.get("ar.L1", np.nan),
                         "MA(1)": params.get("ma.L1", np.nan)})
        except Exception:
            rows.append({"date": spot.index[i - 1], "AR(1)": np.nan, "MA(1)": np.nan})
    if not rows:
        return pd.DataFrame(columns=["AR(1)", "MA(1)"])
    return pd.DataFrame(rows).set_index("date")


def build_features(data_dir: Path, *, bop_lag: int, ns_fill: str, arma_window: int,
                   drop_last_row: bool) -> tuple[pd.DataFrame, dict]:
    if bop_lag < 2 or ns_fill not in ("ffill", "none"):
        raise ValueError("운영 모형은 bop_lag ≥ 2 및 NS ffill/none만 허용합니다")
    table, table_info = load_table(data_dir / "table.csv", drop_last_row=drop_last_row)
    bop, bop_info = load_bop(data_dir)
    total, join_info = join_bop(table, bop, bop_lag)
    ns = ns_factors(table, fill=ns_fill)
    arma = arma_factors(table["spot"], window=arma_window)
    base = total[["spot", "경상수지", "증권투자(자산)", "직접투자비율(수익)", "증권투자비율(수익)"]]
    feature_data = pd.concat([base, ns, arma], axis=1).replace([np.inf, -np.inf], np.nan)
    feature_data = feature_data[FEATURES]
    complete = feature_data.dropna()
    info = {"table": table_info, "bop": bop_info, "join": join_info,
            "feature_start": complete.index[0].strftime("%Y-%m-%d") if len(complete) else None,
            "feature_end": complete.index[-1].strftime("%Y-%m-%d") if len(complete) else None,
            "n_feature_rows": int(len(complete)), "n_calendar_months": len(feature_data),
            "n_incomplete_feature_months": len(feature_data) - len(complete),
            "date_convention": "calendar_month_end_decision"}
    return feature_data, info


# ----------------------------------------------------------------------
# 3. 모형 — 원 코드의 LSTM · XGBoost 를 한 스텝 함수로
# ----------------------------------------------------------------------
def make_sequences(X: np.ndarray, y: np.ndarray, seq_len: int):
    """A sequence ending at origin t receives that origin's h-month target y[t]."""
    if seq_len < 1 or len(X) != len(y):
        raise ValueError("유효한 seq_len과 동일 길이 X/y가 필요합니다")
    xs, ys = [], []
    for i in range(len(X) - seq_len + 1):
        xs.append(X[i:i + seq_len])
        ys.append(y[i + seq_len - 1])
    return np.array(xs), np.array(ys)


def fit_predict_xgb(train_X: np.ndarray, train_y: np.ndarray, test_X: np.ndarray, seed: int) -> float:
    from xgboost import XGBRegressor
    model = XGBRegressor(random_state=seed, n_jobs=1)          # 그 밖의 파라미터는 원 코드처럼 기본값
    model.fit(train_X, train_y)
    return float(model.predict(test_X.reshape(1, -1))[0])


def fit_predict_lstm(train_X: np.ndarray, train_y: np.ndarray, seq_X: np.ndarray, *, seq_len: int,
                     hidden_size: int, num_layers: int, epochs: int, lr: float, seed: int) -> float:
    """train_X/train_y = 학습창(실현 라벨), seq_X = 예측 시점까지의 피처 seq_len 행(마지막 행이 기준일)."""
    import torch
    import torch.nn as nn
    from sklearn.preprocessing import StandardScaler

    class LSTMRegressor(nn.Module):
        def __init__(self, input_size, hidden_size=32, num_layers=1):
            super().__init__()
            self.lstm = nn.LSTM(input_size=input_size, hidden_size=hidden_size,
                                num_layers=num_layers, batch_first=True)
            self.fc = nn.Linear(hidden_size, 1)

        def forward(self, x):
            out, _ = self.lstm(x)
            return self.fc(out[:, -1, :]).squeeze(-1)

    torch.manual_seed(seed)
    x_scaler, y_scaler = StandardScaler(), StandardScaler()
    train_X_scaled = x_scaler.fit_transform(train_X)
    train_y_scaled = y_scaler.fit_transform(train_y.reshape(-1, 1)).ravel()
    seq_scaled = x_scaler.transform(seq_X)
    train_seq_X, train_seq_y = make_sequences(train_X_scaled, train_y_scaled, seq_len)
    if not len(train_seq_X):
        raise ValueError(f"학습창이 seq_len({seq_len})보다 짧습니다")
    tx = torch.tensor(train_seq_X, dtype=torch.float32)
    ty = torch.tensor(train_seq_y, dtype=torch.float32)
    test = torch.tensor(seq_scaled[np.newaxis, :, :], dtype=torch.float32)
    model = LSTMRegressor(tx.shape[-1], hidden_size=hidden_size, num_layers=num_layers)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.MSELoss()
    model.train()
    for _ in range(epochs):
        optimizer.zero_grad()
        loss = criterion(model(tx), ty)
        loss.backward()
        optimizer.step()
    model.eval()
    with torch.no_grad():
        pred_scaled = model(test).numpy()
    return float(y_scaler.inverse_transform(pred_scaled.reshape(-1, 1)).ravel()[0])


# ----------------------------------------------------------------------
# 4. walk-forward — 기준일마다 실현 라벨만으로 학습해 lag 개월 뒤 수준을 예측
# ----------------------------------------------------------------------
def walk_forward(feature_data: pd.DataFrame, *, lag: int, window: int, seq_len: int, hidden_size: int,
                 num_layers: int, epochs: int, lr: float, seed: int, replicate_notebook: bool = False,
                 max_steps: int | None = None, progress=None) -> list[dict]:
    """반환: 기준일별 {t_base, t_target, base, actual|None, xgb, lstm, ensemble}.

    모든 날짜는 달력 월말 의사결정일이다. 누락 월을 포함한 월 격자에서
    타깃은 정확히 lag개월 뒤 spot, 학습창은 기준월−lag까지의 연속 window개
    피처 기준월이다. XGB는 window쌍, LSTM은 window−seq_len+1개 연속 시퀀스를
    학습한다. 피처·실현 라벨·현재 시퀀스가 불완전하면 그 기준월은 건너뛴다.
    실제 타깃 월의 spot만 있으면 그 달 피처가 결측이어도 실현값은 보존한다.
    """
    if replicate_notebook:
        raise ValueError("notebook look-ahead 재현 모드는 운영 러너에서 허용하지 않습니다")
    df = monthly_grid(feature_data)
    X = df[FEATURES].to_numpy(dtype=float)
    spot = df["spot"].to_numpy(dtype=float)
    n = len(df)
    if lag < 1 or window < seq_len + 1:
        raise ValueError("lag ≥ 1, window > seq_len 이어야 합니다")
    rows = []
    if max_steps is not None and max_steps < 1:
        raise ValueError("max_steps는 양의 정수여야 합니다")
    first = lag + window - 1
    first = max(first, seq_len - 1)
    steps = list(range(first, n))
    if max_steps is not None:
        steps = steps[-max_steps:]
    for k, i in enumerate(steps):
        end = i - lag
        start = end - window + 1
        if start < 0 or end < 0:
            continue
        train_idx = np.arange(start, end + 1)
        train_X, train_y = X[train_idx], spot[train_idx + lag]
        seq_X = X[i - seq_len + 1:i + 1]
        if (not np.isfinite(train_X).all() or not np.isfinite(train_y).all()
                or not np.isfinite(seq_X).all() or np.any(train_y <= 0)
                or np.any(train_X[:, 0] <= 0) or np.any(seq_X[:, 0] <= 0)):
            continue
        xgb = fit_predict_xgb(train_X, train_y, X[i], seed)
        # Calendar-key seed is invariant to adding older data or a missing month.
        origin_seed = seed + df.index[i].year * 12 + df.index[i].month
        lstm = fit_predict_lstm(train_X, train_y, seq_X, seq_len=seq_len, hidden_size=hidden_size,
                                num_layers=num_layers, epochs=epochs, lr=lr, seed=origin_seed)
        if not all(math.isfinite(value) and value > 0 for value in (xgb, lstm)):
            raise ValueError("모형 예측이 유한 양수가 아닙니다")
        actual = (float(spot[i + lag]) if i + lag < n
                  and math.isfinite(spot[i + lag]) and spot[i + lag] > 0 else None)
        t_target = (df.index[i].to_period("M") + lag).to_timestamp(how="end").normalize()
        rows.append({"t_base": df.index[i], "t_target": t_target, "base": float(spot[i]), "actual": actual,
                     "xgb": xgb, "lstm": lstm, "ensemble": (xgb + lstm) / 2})
        if progress:
            progress(k + 1, len(steps))
    return rows


def summarize(rows: list[dict]) -> dict:
    """실현된 행만으로 모형별 RMSE·MAE·편향·Theil U(랜덤워크 대비)·방향 적중률."""
    realized = [r for r in rows if r["actual"] is not None]
    out = {}
    rw_err = np.array([r["base"] - r["actual"] for r in realized], dtype=float)
    rmse_rw = float(np.sqrt(np.mean(rw_err ** 2))) if len(realized) else None
    for name in (*MODELS, "rw"):
        if not realized:
            out[name] = {"n": 0}
            continue
        pred = np.array([r["base"] if name == "rw" else r[name] for r in realized], dtype=float)
        actual = np.array([r["actual"] for r in realized], dtype=float)
        base = np.array([r["base"] for r in realized], dtype=float)
        err = pred - actual
        move = np.sign(actual - base)
        guess = np.sign(pred - base)
        judged = move != 0
        # 랜덤워크는 방향을 걸지 않는다(예측 = 기준 환율) — 적중률 자체가 정의되지 않는다.
        hit = (float(np.mean(guess[judged] == move[judged]))
               if name != "rw" and judged.any() else None)
        rmse = float(np.sqrt(np.mean(err ** 2)))
        out[name] = {"n": int(len(realized)), "rmse": rmse, "mae": float(np.mean(np.abs(err))),
                     "bias": float(np.mean(err)), "theil_u": (rmse / rmse_rw) if rmse_rw else None,
                     "hit_rate": hit, "n_direction": int(judged.sum()) if name != "rw" else 0}
    return out


def epoch(ts: pd.Timestamp) -> int:
    return int(pd.Timestamp(ts).normalize().tz_localize("UTC").timestamp())


def build_artifact(combos: list[dict], *, info: dict, args, lags: list[int], windows: list[int]) -> dict:
    if args.replicate_notebook or args.ns_fill not in ("ffill", "none") or args.bop_lag < 2:
        raise ValueError("누수 재현 설정으로 운영 산출물을 만들 수 없습니다")
    return {
        "schema": SCHEMA,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runner": {"version": RUNNER_VERSION, "seed": int(args.seed),
                   "replicate_notebook": False, "label_alignment": LABEL_ALIGNMENT,
                   "sequence_alignment": SEQUENCE_ALIGNMENT, "horizon_unit": "calendar_month",
                   "train_window": TRAIN_WINDOW},
        "model": {"name": "lstm_xgb_walk_forward", "target": "spot", "unit": "KRW/USD", "frequency": "monthly",
                  "features": FEATURES,
                  "ns": {"lambda": NS_LAMBDA, "maturities_years": NS_MATURITIES.tolist(), "fill": args.ns_fill},
                  "arma": {"order": [1, 1, 1], "window_months": int(args.arma_window)},
                  "bop_lag_months": int(args.bop_lag),
                  "lstm": {"hidden_size": int(args.hidden_size), "num_layers": int(args.num_layers),
                           "seq_len": int(args.seq_len), "epochs": int(args.epochs), "lr": float(args.lr),
                           "scaler": "standard", "optimizer": "adam", "loss": "mse"},
                  "xgb": {"params": "XGBRegressor defaults", "random_state": int(args.seed), "n_jobs": 1},
                  "ensemble": "mean(xgb, lstm)", "benchmark": "random_walk_base_level"},
        "data": info,
        "grid": {"lags": [int(x) for x in lags], "windows": [int(x) for x in windows]},
        "regime_defaults": REGIME_DEFAULTS,
        "combos": combos,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="환율모형B — LSTM·XGBoost walk-forward 러너")
    parser.add_argument("--data-dir", required=True, help="table.csv·국제수지_1.csv·국제수지_2.csv 가 있는 폴더")
    parser.add_argument("--out", default=None, help=f"산출 JSON 경로 (기본: <data-dir>/{ARTIFACT})")
    parser.add_argument("--lags", default="1,3,6,9,12", help="예측 지평(개월) 목록")
    parser.add_argument("--windows", default="24,36", help="학습창(개월) 목록")
    parser.add_argument("--seq-len", type=int, default=6)
    parser.add_argument("--hidden-size", type=int, default=32)
    parser.add_argument("--num-layers", type=int, default=1)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--arma-window", type=int, default=36)
    parser.add_argument("--bop-lag", type=int, default=2, help="국제수지 공표 지연(개월). 원 코드 = 0")
    parser.add_argument("--ns-fill", choices=["ffill", "interpolate", "none"], default="ffill")
    parser.add_argument("--seed", type=int, default=20261019)
    parser.add_argument("--replicate-notebook", action="store_true", help="폐기된 누수 재현 옵션 — 운영 v2에서는 거부")
    parser.add_argument("--keep-last-row", action="store_true", help="table.csv 마지막 행을 버리지 않는다(원 코드는 버림)")
    parser.add_argument("--max-steps", type=int, default=None, help="스모크용 — 조합당 마지막 N 스텝만")
    args = parser.parse_args(argv)
    if args.replicate_notebook or args.ns_fill == "interpolate" or args.bop_lag < 2:
        parser.error("운영 v2는 notebook look-ahead·양방향 보간·bop-lag<2를 허용하지 않습니다")

    data_dir = Path(args.data_dir)
    out = Path(args.out) if args.out else data_dir / ARTIFACT
    lags = [int(x) for x in args.lags.split(",") if x.strip()]
    windows = [int(x) for x in args.windows.split(",") if x.strip()]
    started = time.time()
    print(f"[1/3] 피처 생성 — {data_dir}")
    feature_data, info = build_features(data_dir, bop_lag=args.bop_lag, ns_fill=args.ns_fill,
                                        arma_window=args.arma_window, drop_last_row=not args.keep_last_row)
    print(f"      피처 {info['n_feature_rows']}행 {info['feature_start']} ~ {info['feature_end']} · "
          f"국제수지 매칭 {info['join']['matched_months']}개월 (지연 {args.bop_lag}개월)")
    combos = []
    for lag in lags:
        for window in windows:
            key = f"l{lag}_w{window}"
            print(f"[2/3] walk-forward {key} (lag {lag}개월 · 창 {window}개월)")

            def progress(done, total, key=key):
                if done % 25 == 0 or done == total:
                    print(f"      {key}: {done}/{total}", flush=True)

            rows = walk_forward(feature_data, lag=lag, window=window, seq_len=args.seq_len,
                                hidden_size=args.hidden_size, num_layers=args.num_layers, epochs=args.epochs,
                                lr=args.lr, seed=args.seed, replicate_notebook=args.replicate_notebook,
                                max_steps=args.max_steps, progress=progress)
            summary = summarize(rows)
            if not rows:
                raise ValueError(f"{key}: 연속 월 학습창·실현 라벨을 갖춘 기준월이 없습니다")
            combos.append({
                "key": key, "lag": lag, "window": window, "n": len(rows),
                "n_realized": sum(1 for r in rows if r["actual"] is not None),
                "t_base": [epoch(r["t_base"]) for r in rows], "t_target": [epoch(r["t_target"]) for r in rows],
                "base": [r["base"] for r in rows], "actual": [r["actual"] for r in rows],
                "pred": {m: [r[m] for r in rows] for m in MODELS},
                "summary": summary,
            })
            s = summary
            if s["rw"].get("n"):
                print("      " + " · ".join(f"{m} RMSE {s[m]['rmse']:.1f} U "
                                            + (f"{s[m]['theil_u']:.3f}" if s[m]['theil_u'] is not None else "–") + " "
                                            f"적중 {100 * (s[m]['hit_rate'] or 0):.0f}%" for m in MODELS)
                      + f" · RW RMSE {s['rw']['rmse']:.1f} (n={s['rw']['n']})")
    artifact = build_artifact(combos, info=info, args=args, lags=lags, windows=windows)
    out.write_text(json.dumps(artifact, ensure_ascii=False, indent=1, allow_nan=False), encoding="utf-8")
    print(f"[3/3] wrote {out} ({out.stat().st_size:,} bytes) in {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
