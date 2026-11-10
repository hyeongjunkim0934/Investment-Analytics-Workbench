"""Seoul display-day expiry and exact-date realized quotes, without model refits."""
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_seoul_boundary_and_exact_realized_quote_only():
    source = r"""
const {fxForecastToday,fxForecastStatus}=require('./dashboard/fx-forecast-status.js');
const t=Date.parse('2026-10-30T00:00:00Z')/1000;
const history={t:[t-86400,t,t+86400],v:[1300,1340,9000]};
const before=fxForecastToday(new Date('2026-10-29T14:59:59.999Z'));
const boundary=fxForecastToday(new Date('2026-10-29T15:00:00Z'));
const status=(h,today=boundary,actual=null)=>fxForecastStatus(t,1350,h,1320,1380,today,actual);
console.log(JSON.stringify({before,boundary,t,
 future:status(history,before),exact:status(history),
 missing:status({t:[t-86400,t+86400],v:[1300,9000]}),
 invalid:status({t:[t],v:[0]}),published:status(null,boundary,1330),
 futurePublished:status(null,before,1330),outside:status(null,boundary,1400)}));
"""
    result = subprocess.run(["node", "-e", source], cwd=ROOT, capture_output=True,
                            text=True, check=True, timeout=30)
    r = json.loads(result.stdout)
    assert r["before"] == r["t"] - 86400
    assert r["boundary"] == r["t"]
    assert r["future"]["state"] == "future"
    assert r["future"]["actual"] is None
    assert r["exact"]["state"] == "realized"
    assert (r["exact"]["actual"], r["exact"]["error"], r["exact"]["covered"]) == (1340, 10, True)
    for key in ("missing", "invalid"):
        assert r[key]["state"] == "expired_pending"
        assert r[key]["actual"] is None
    assert r["published"]["actual"] == 1330
    assert r["futurePublished"]["actual"] is None
    assert r["outside"]["covered"] is False
