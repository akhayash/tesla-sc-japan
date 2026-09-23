"""Run the whole data pipeline: fetch -> aggregate -> web assets."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

from common import OUT, WORK

import build_admin
import build_mesh
import fetch_inputs
import fetch_sc


def build_topojson() -> None:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        sys.exit("npx is required to build boundaries.topojson (mapshaper).")
    cmd = [
        npx, "-y", "mapshaper@0.6",
        "-i", "pref_web.geojson", "muni_city_web.geojson", "muni_ward_web.geojson", "combine-files",
        "-rename-layers", "pref,muni_city,muni_ward",
        "-o", str(OUT / "boundaries.topojson"), "format=topojson", "quantization=100000",
    ]
    subprocess.run(cmd, cwd=WORK, check=True, env=os.environ.copy())


def main() -> None:
    fetch_sc.main()
    fetch_inputs.main()
    build_admin.main()
    build_mesh.main()
    build_topojson()


if __name__ == "__main__":
    main()
