"""Hazard exposure of each Supercharger from MLIT 'Kasaneru Hazard Map' raster tiles.

For every site the z17 tile pixel under the site is read for each hazard layer and
matched to the official legend colours. Results are cached in docs/data/sc_hazard.json
and only recomputed for new/moved sites or entries older than RECHECK_DAYS.
"""
from __future__ import annotations

import io
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

import requests
from PIL import Image

from common import OUT

TILE = "https://disaportaldata.gsi.go.jp/raster/{layer}/{z}/{x}/{y}.png"
Z = 17
RECHECK_DAYS = 90

DEPTH = [  # (rgb, label, level)
    ((255, 255, 179), "0.3m未満", 1),
    ((247, 245, 169), "0.5m未満", 1),
    ((248, 225, 166), "0.5〜1m", 2),
    ((255, 216, 192), "0.5〜3m", 2),
    ((255, 183, 183), "3〜5m", 3),
    ((255, 145, 145), "5〜10m", 3),
    ((242, 133, 201), "10〜20m", 3),
    ((220, 122, 220), "20m以上", 3),
]
DURATION = [
    ((160, 210, 255), "12時間未満", 1),
    ((0, 65, 255), "12時間〜1日", 1),
    ((250, 245, 0), "1日〜3日", 2),
    ((255, 153, 0), "3日〜1週間", 2),
    ((255, 40, 0), "1週間〜2週間", 3),
    ((180, 0, 104), "2週間〜4週間", 3),
    ((96, 0, 96), "4週間以上", 3),
]


def zone(warn, special):
    return [(warn, "警戒区域", 2), (special, "特別警戒区域", 3)]


LAYERS = {
    "flood": ("01_flood_l2_shinsuishin_data", DEPTH),
    "duration": ("01_flood_l2_keizoku_data", DURATION),
    "collapse_flow": ("01_flood_l2_kaokutoukai_hanran_data", [((255, 0, 0), "区域内", 3)]),
    "collapse_erosion": ("01_flood_l2_kaokutoukai_kagan_data", [((255, 0, 0), "区域内", 3)]),
    "inland": ("02_naisui_data", DEPTH),
    "hightide": ("03_hightide_l2_shinsuishin_data", DEPTH),
    "tsunami": ("04_tsunami_newlegend_data", DEPTH),
    "debris": ("05_dosekiryukeikaikuiki", zone((230, 200, 50), (165, 0, 33))),
    "steep": ("05_kyukeishakeikaikuiki", zone((250, 230, 0), (250, 40, 0))),
    "landslide": ("05_jisuberikeikaikuiki", zone((255, 153, 0), (180, 0, 40))),
    "avalanche": ("05_nadarekikenkasyo", [((255, 255, 101), "危険箇所", 2)]),
}
MAX_COLOR_DIST = 30

_session = requests.Session()
_tiles: dict[tuple, Image.Image | None] = {}


def tile_xy(lon: float, lat: float, z: int) -> tuple[int, int, int, int]:
    n = 2**z
    fx = (lon + 180) / 360 * n
    r = math.radians(lat)
    fy = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n
    x, y = int(fx), int(fy)
    return x, y, int((fx - x) * 256), int((fy - y) * 256)


def fetch_tile(layer: str, x: int, y: int) -> Image.Image | None:
    key = (layer, x, y)
    if key in _tiles:
        return _tiles[key]
    url = TILE.format(layer=layer, z=Z, x=x, y=y)
    delay = 2.0
    img = None
    for attempt in range(5):
        try:
            r = _session.get(url, timeout=30)
            if r.status_code == 404:
                break
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            img = Image.open(io.BytesIO(r.content)).convert("RGBA")
            break
        except requests.RequestException:
            if attempt == 4:
                raise
            time.sleep(delay)
            delay *= 2
    _tiles[key] = img
    return img


def classify(rgba, legend):
    if rgba is None or rgba[3] < 128:
        return None
    best, bd = None, 1e9
    for rgb, label, level in legend:
        d = math.dist(rgba[:3], rgb)
        if d < bd:
            best, bd = (label, level), d
    if bd > MAX_COLOR_DIST:
        return {"label": "区域内（区分不明）", "level": 1}
    return {"label": best[0], "level": best[1]}


def assess(lon: float, lat: float) -> dict:
    x, y, px, py = tile_xy(lon, lat, Z)
    res = {}
    for key, (layer, legend) in LAYERS.items():
        img = fetch_tile(layer, x, y)
        c = classify(img.getpixel((px, py)) if img else None, legend)
        if c:
            res[key] = c
    return res


def main(force: bool = False) -> None:
    sc = json.loads((OUT / "sc.geojson").read_text(encoding="utf-8"))
    path = OUT / "sc_hazard.json"
    prev_doc = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    prev = prev_doc.get("sites", {})
    if set(prev_doc.get("layers", {})) != set(LAYERS):
        force = True  # layer set changed: re-assess every site
    today = date.today()

    todo, sites = [], {}
    for f in sc["features"]:
        sid = str(f["properties"]["id"])
        lon, lat = f["geometry"]["coordinates"]
        old = prev.get(sid)
        fresh = (
            old and not force and old["lon"] == lon and old["lat"] == lat
            and (today - date.fromisoformat(old["checked"])).days < RECHECK_DAYS
        )
        if fresh:
            sites[sid] = old
        else:
            todo.append((sid, lon, lat))

    def work(item):
        sid, lon, lat = item
        return sid, {"lon": lon, "lat": lat, "checked": today.isoformat(), "hazards": assess(lon, lat)}

    with ThreadPoolExecutor(max_workers=4) as ex:
        for sid, rec in ex.map(work, todo):
            sites[sid] = rec

    sites = dict(sorted(sites.items(), key=lambda kv: kv[0]))
    if path.exists() and sites == prev and not force:
        print(f"hazard: no change ({len(sites)} sites up to date)")
        return False
    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "zoom": Z,
        "layers": {k: v[0] for k, v in LAYERS.items()},
        "sites": sites,
    }
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    exposed = sum(1 for s in sites.values() if s["hazards"])
    print(f"hazard: assessed {len(todo)} site(s), {exposed}/{len(sites)} sites inside at least one hazard area")
    return True


if __name__ == "__main__":
    import sys

    main(force="--force" in sys.argv)

