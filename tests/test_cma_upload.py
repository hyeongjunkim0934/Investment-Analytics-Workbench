"""Read genuine Excel files and check CMA import units and atomic updates."""
from pathlib import Path
import json
import shutil
import subprocess

from openpyxl import Workbook


def test_cma_workbook_import(tmp_path):
    node = shutil.which("node")
    assert node, "CMA 엑셀 업로드 검증에는 Node.js가 필요합니다."
    book = Workbook()
    sheet = book.active
    sheet.title = "CMA"
    sheet.append(["자산군", "기대수익률 (%)", "변동성 (%)"])
    sheet.append(["국내시가", 0.0412, 0.0358])
    sheet["B2"].number_format = "0.00%"
    sheet["C2"].number_format = "0.00%"
    sheet.append(["해외시가", -1.25, 0])
    fixture = tmp_path / "cma-independent.xlsx"
    book.save(fixture)
    probe = Path(__file__).with_name("cma_upload_probe.js")
    run = subprocess.run([node, str(probe), str(fixture)], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr[-8000:]
    assert all(json.loads(run.stdout).values())
