"""Method B: smoothed population density on the 1km mesh.

Population is rasterised onto a 1km grid in a Japan-centred LCC projection and
smoothed with Gaussian kernels. Supercharger density is computed in the browser
with the same kernel (sites are few), so status / weight toggles are instant.

Output docs/data/mesh.bin: little-endian float32, column-major blocks of length N:
  lon, lat, pop, pd_<bw> for each bandwidth (people per km2)
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from scipy.ndimage import gaussian_filter

from common import OUT, WORK, mesh3_center, to_lcc_km

BANDWIDTHS_KM = [10, 30, 50]
CELL_KM = 1.0


def main() -> None:
    m = pd.read_csv(WORK / "mesh_pop.csv")
    lon, lat = mesh3_center(m["mesh"].to_numpy())
    x, y = to_lcc_km(lon, lat)
    pop = m["pop"].to_numpy(float)

    pad = 4 * max(BANDWIDTHS_KM)
    x0, y0 = x.min() - pad, y.min() - pad
    ix = np.floor((x - x0) / CELL_KM).astype(int)
    iy = np.floor((y - y0) / CELL_KM).astype(int)
    grid = np.zeros((iy.max() + pad + 1, ix.max() + pad + 1), dtype=np.float32)
    np.add.at(grid, (iy, ix), pop)
    print(f"grid {grid.shape}, pop {grid.sum():,.0f}")

    cols = [lon, lat, pop]
    for bw in BANDWIDTHS_KM:
        sm = gaussian_filter(grid, sigma=bw / CELL_KM, mode="constant", truncate=4.0)
        cols.append(sm[iy, ix] / (CELL_KM * CELL_KM))
        print(f"bandwidth {bw}km done")

    arr = np.stack([np.asarray(c, dtype=np.float32) for c in cols])
    (OUT / "mesh.bin").write_bytes(arr.astype("<f4").tobytes())
    meta = {
        "n": int(len(m)),
        "columns": ["lon", "lat", "pop"] + [f"pd{bw}" for bw in BANDWIDTHS_KM],
        "bandwidths_km": BANDWIDTHS_KM,
        "population_total": float(pop.sum()),
        "lcc": "+proj=lcc +lat_1=30 +lat_2=42 +lat_0=36 +lon_0=137 +datum=WGS84 +units=m",
    }
    (OUT / "mesh_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(f"mesh.bin: {arr.nbytes / 1e6:.1f} MB, n={len(m)}")


if __name__ == "__main__":
    main()

