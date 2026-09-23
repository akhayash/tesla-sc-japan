from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
WORK = ROOT / "data" / "work"
OUT = ROOT / "docs" / "data"
for d in (RAW, WORK, OUT):
    d.mkdir(parents=True, exist_ok=True)

# Lambert conformal conic centred on Japan; units are metres.
LCC = "+proj=lcc +lat_1=30 +lat_2=42 +lat_0=36 +lon_0=137 +datum=WGS84 +units=m +no_defs"
_to_lcc = Transformer.from_crs("EPSG:4326", LCC, always_xy=True)


def to_lcc_km(lon, lat):
    x, y = _to_lcc.transform(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))
    return np.asarray(x) / 1000.0, np.asarray(y) / 1000.0


def download(url: str, dest: Path, *, retries: int = 5, timeout: int = 120) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    delay = 2.0
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            if 400 <= r.status_code < 500:
                raise FileNotFoundError(f"HTTP {r.status_code}: {url}")
            r.raise_for_status()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(r.content)
            tmp.replace(dest)
            return dest
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(delay)
            delay *= 2
    return dest


def get_json(url: str, *, retries: int = 5, timeout: int = 120):
    delay = 2.0
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(delay)
            delay *= 2


def mesh3_center(codes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Centre lon/lat of JIS X 0410 3rd-level (approx. 1km) mesh codes."""
    c = np.asarray(codes, dtype=np.int64)
    p = c // 1000000
    u = (c // 10000) % 100
    q = (c // 1000) % 10
    r = (c // 100) % 10
    v = (c // 10) % 10
    w = c % 10
    lat = p / 1.5 + q * (5 / 60) + v * (30 / 3600) + 15 / 3600
    lon = u + 100 + r * (7.5 / 60) + w * (45 / 3600) + 22.5 / 3600
    return lon, lat
