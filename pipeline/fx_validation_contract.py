"""Standard-library publication checks, independent of the model fitting code."""
from __future__ import annotations

import calendar
from datetime import datetime, timedelta, timezone
import math

POINTS = ("a", "c", "d", "rw", "equal_ac_rw", "shrink_ac_rw")
INTERVALS = ("a", "c", "d", "constant", "ewma")
VARIANCES = ("d", "constant", "ewma")
HORIZONS = [1, 3, 6, 9, 12]


def errors(payload, *, history=None, model_c=None):
    issues = []
    def require(ok, message):
        if not ok:
            issues.append(message)
        return ok
    def finite(v):
        return type(v) in (int, float) and math.isfinite(v)
    def close(a, b):
        return a is None and b is None or finite(a) and finite(b) and math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
    def date_of(t):
        if type(t) is not int:
            raise ValueError("epoch must be integer")
        d = datetime.fromtimestamp(t, timezone.utc)
        if d.hour or d.minute or d.second or d.microsecond:
            raise ValueError("date must be midnight")
        return d.date()
    if not require(isinstance(payload, dict), "검증 블록 없음"):
        return issues
    require(payload.get("schema") == "fx_validation_v1", "schema 불일치")
    if not require(type(payload.get("active")) is bool, "active 형식 오류"):
        return issues
    require(payload.get("pair") == "USDKRW" and payload.get("unit") == "KRW/USD", "환율·단위 불일치")
    config = payload.get("config", {})
    require(isinstance(config, dict), "설정 누락")
    if not isinstance(config, dict):
        return issues
    require(config.get("horizons_months") == HORIZONS, "지평 불일치")
    require(type(config.get("max_origins")) is int and 1 <= config["max_origins"] <= 120, "기준일 상한 오류")
    require(type(config.get("path_count")) is int and 100 <= config["path_count"] <= 20000, "경로 수 오류")
    for flag in ("weights_fitted", "superiority_established", "coverage_guaranteed", "raw_training_returns_published"):
        require(config.get(flag) is False, f"{flag} 계약 불일치")
    require(config.get("equal_weights") == {"a": 1 / 3, "c": 1 / 3, "rw": 1 / 3}, "동일가중 변경")
    require(config.get("shrink_weights") == {"a": .25, "c": .25, "rw": .5}, "축소가중 변경")
    if not payload["active"]:
        require(bool(payload.get("reason")), "비활성 사유 없음")
        return issues
    try:
        end = datetime.strptime(payload["asof"], "%Y-%m-%d").date()
        selected = payload["selected_origins"]
        require(isinstance(selected, list) and selected == sorted(set(selected)) and len(selected) <= config["max_origins"], "기준일 선택 오류")
        hs = payload["horizons"]
        require([h["horizon_months"] for h in hs] == HORIZONS, "지평 배열 불일치")
        observed = dict(zip(history["t"], history["v"])) if history else None
        c_rows = {(h["horizon_months"], r["origin_t"], r["target_t"]): r
                  for h in model_c.get("horizons", []) for r in h.get("backtest", [])} if model_c else None
        total = 0
        for h in hs:
            months, rows = h["horizon_months"], h["rows"]
            require(h["n_common"] == len(rows), "공통 행수 불일치")
            require(0 <= h["n_common"] <= h["n_selected"] <= h["n_candidates"], "후보·선택·공통 행수 오류")
            origins = []
            for r in rows:
                origin, target = date_of(r["origin_t"]), date_of(r["target_t"])
                origins.append(r["origin_t"])
                require(origin.isoformat() == r["origin_date"] and target.isoformat() == r["target_date"], "날짜 표시 불일치")
                require(r["origin_date"] in selected, "선택되지 않은 기준일")
                require(origin < target <= end, "미실현·역방향 평가행")
                serial = origin.year * 12 + origin.month - 1 + months
                year, month = divmod(serial, 12); month += 1
                expected = origin.replace(year=year, month=month, day=calendar.monthrange(year, month)[1])
                while expected.weekday() >= 5:
                    expected -= timedelta(days=1)
                require(target == expected, "달력 목표일 불일치")
                count = sum((origin + timedelta(days=i)).weekday() < 5 for i in range(1, (target-origin).days + 1))
                require(type(r["model_steps"]) is int and r["model_steps"] == count, "예정 평일 수 불일치")
                require(all(finite(r[k]) and r[k] > 0 for k in ("base", "actual")), "유효 환율 없음")
                if observed is not None:
                    require(close(observed.get(r["origin_t"]), r["base"]) and close(observed.get(r["target_t"]), r["actual"]), "원천 관측일·값 불일치")
                ps = r["points"]
                require(set(ps) == set(POINTS) and all(finite(v) and v > 0 for v in ps.values()), "점예측 형식 오류")
                require(close(ps["rw"], r["base"]) and close(ps["d"], r["base"]), "RW·D 중심 불일치")
                require(close(ps["equal_ac_rw"], (ps["a"] + ps["c"] + r["base"])/3), "동일가중 계산 오류")
                require(close(ps["shrink_ac_rw"], .25*ps["a"] + .25*ps["c"] + .5*r["base"]), "축소조합 계산 오류")
                if c_rows is not None:
                    c = c_rows.get((months, r["origin_t"], r["target_t"]))
                    require(c is not None and close(c["model_c"], ps["c"]), "C 예측 기준행 불일치")
                    if c is not None:
                        require(close(c.get("base"), r["base"]) and close(c.get("actual"), r["actual"]),
                                "C 기준·실현환율 불일치")
                        calibration = c.get("n_calibration")
                        valid_calibration = type(calibration) is int and calibration >= 0
                        require(valid_calibration and type(r.get("n_calibration_c")) is int
                                and r["n_calibration_c"] == calibration, "C 교정 표본수 원천 불일치")
                        # Independently implement the publication rule: all four
                        # nested bounds or none. Partial/malformed bounds and fewer
                        # than 24 matured calibration errors never enter scoring.
                        band_keys = ("lower95", "lower68", "upper68", "upper95")
                        source_bands = [c.get(key) for key in band_keys]
                        usable = (valid_calibration and calibration >= 24
                                  and all(finite(value) and 0 < value <= 1e150 for value in source_bands)
                                  and source_bands == sorted(source_bands))
                        expected_bands = source_bands if usable else [None] * 4
                        require(all(close(r["intervals"]["c"].get(key), expected)
                                    for key, expected in zip(band_keys, expected_bands)),
                                "C 구간 원천·교정 표본 규칙 불일치")
                for key in INTERVALS:
                    b = r["intervals"][key]
                    values = [b[k] for k in ("lower95", "lower68", "upper68", "upper95")]
                    if key == "c" and all(v is None for v in values):
                        continue
                    require(all(finite(v) and v > 0 for v in values) and values == sorted(values), "구간 순서·양수 오류")
                vs = r["variance"]
                require(all(finite(vs[k]) and vs[k] > 0 for k in VARIANCES), "분산 오류")
                require(close(vs["realized"], math.log(r["actual"] / r["base"])**2), "실현 대용치 계산 오류")
            require(origins == sorted(set(origins)), "평가 기준일 중복·역순")
            total += len(rows)
            m = h["metrics"]
            def sample(rs):
                return {"n": len(rs), "origin_start": rs[0]["origin_date"] if rs else None,
                        "origin_end": rs[-1]["origin_date"] if rs else None,
                        "target_start": rs[0]["target_date"] if rs else None,
                        "target_end": rs[-1]["target_date"] if rs else None}
            require(m["sample"] == sample(rows), "점평가 표본기간 불일치")
            rmse_rw = math.hypot(*(r["base"]-r["actual"] for r in rows))/math.sqrt(len(rows)) if rows else None
            for key in POINTS:
                mm = m["point"][key]
                diffs = [r["points"][key]-r["actual"] for r in rows]
                rmse = math.hypot(*diffs)/math.sqrt(len(rows)) if rows else None
                mae = math.fsum(abs(e) for e in diffs)/len(rows) if rows else None
                require(mm["n"] == len(rows) and close(mm["rmse"], rmse) and close(mm["mae"], mae)
                        and close(mm["theil_u_rw"], rmse/rmse_rw if rmse_rw else None), "점평가 지표 계산 불일치")
            for level, alpha in (("68", .32), ("95", .05)):
                lo, hi = "lower"+level, "upper"+level
                valid = [r for r in rows if all(finite(r["intervals"][k][lo]) and finite(r["intervals"][k][hi]) for k in INTERVALS)]
                require(m["interval"][level]["sample"] == sample(valid), "구간 공통표본 불일치")
                for key in INTERVALS:
                    bands = [(r["actual"], r["intervals"][key][lo], r["intervals"][key][hi]) for r in valid]
                    coverage = sum(l <= y <= u for y,l,u in bands)/len(valid) if valid else None
                    score = math.fsum(u-l + 2/alpha*max(l-y,0)+2/alpha*max(y-u,0) for y,l,u in bands)/len(valid) if valid else None
                    mm = m["interval"][level]["models"][key]
                    require(mm["n"] == len(valid) and close(mm["coverage"], coverage) and close(mm["interval_score"], score), "구간 평가 계산 불일치")
            for key in VARIANCES:
                q = math.fsum(math.log(r["variance"][key])+r["variance"]["realized"]/r["variance"][key] for r in rows)/len(rows) if rows else None
                mm = m["variance"][key]
                require(mm["n"] == len(rows) and close(mm["qlike"], q), "QLIKE 계산 불일치")
        require(total > 0, "활성 검증에 평가행 없음")
    except (KeyError, TypeError, ValueError, OverflowError, OSError, ZeroDivisionError):
        issues.append("검증 계약의 필드·날짜·수치 형식 오류")
    return issues
