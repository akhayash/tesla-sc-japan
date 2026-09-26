"""Locate the toll gate of each expressway IC so routing can start/end on the local-road side.

The GSI road-facility points (docs/data/road_facilities.geojson) mark an IC near the
mainline junction. A router given such a point snaps to the mainline and reports no toll
(or picks the wrong gate). This script matches each IC / smart IC to OpenStreetMap
barrier=toll_booth objects by name and distance, then extends the IC point -> gate vector
a little beyond the gate to get an "approach" point on the local-road side.

Output: docs/data/ic_gates.json
  {"generated": ..., "source": ..., "ics": [[name, lon, lat, gate_lon, gate_lat, app_lon, app_lat, q], ...]}
  q: 1 = gate matched by name, 2 = nearest unnamed gate (lower confidence).
  ICs without a usable gate are omitted (the client falls back to the IC point).

Usage: python build_ic_gates.py [--cached]
Data © OpenStreetMap contributors, ODbL 1.0; 国土地理院.
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone

import requests

from common import OUT, WORK

OVERPASS = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "tesla-sc-japan (https://github.com/akhayash/tesla-sc-japan)"}
QUERY = '[out:json][timeout:300];area["ISO3166-1"="JP"][admin_level=2]->.jp;nwr["barrier"="toll_booth"](area.jp);out center tags;'
RAW = WORK / "osm_toll_booth.json"
IC_CODES = {2941, 2945}  # IC, smart IC
NAME_RADIUS_KM = 4.0
UNNAMED_RADIUS_KM = 1.5
APPROACH_KM = 0.35
# GSI IC name -> OSM toll booth name where they differ
ALIASES = {"練馬": "大泉"}

SUFFIX = re.compile(r"(スマートインターチェンジ|スマートIC|インターチェンジ|本線料金所|料金所|インター|IC|TB|出口|入口)")


def norm(name: str | None) -> str:
    s = unicodedata.normalize("NFKC", name or "").upper()
    s = re.sub(r"[(（].*?[)）]", "", s)
    return SUFFIX.sub("", s).replace(" ", "").strip()


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    return math.hypot((lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)) * 111.32, (lat2 - lat1) * 110.57)


def fetch_booths() -> list[dict]:
    if "--cached" in sys.argv and RAW.exists():
        return json.loads(RAW.read_text(encoding="utf-8"))["elements"]
    delay = 30.0
    for attempt in range(5):
        try:
            r = requests.post(OVERPASS, data={"data": QUERY}, headers=HEADERS, timeout=400)
            if r.status_code in (429, 504) or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            els = r.json()["elements"]
            if not els:
                raise ValueError("empty Overpass response")
            RAW.write_text(r.text, encoding="utf-8")
            return els
        except (requests.RequestException, ValueError) as exc:
            if attempt == 4:
                raise
            print(f"Overpass retry {attempt + 1}: {exc}")
            time.sleep(delay)
            delay *= 2
    return []


def main() -> None:
    booths = []
    for e in fetch_booths():
        lat = e.get("lat", e.get("center", {}).get("lat"))
        lon = e.get("lon", e.get("center", {}).get("lon"))
        if lat is None or lon is None:
            continue
        tags = e.get("tags", {})
        booths.append((norm(tags.get("name") or tags.get("name:ja")), lat, lon))

    facilities = json.loads((OUT / "road_facilities.geojson").read_text(encoding="utf-8"))["features"]
    rows, named, unnamed, missing = [], 0, 0, []
    for f in facilities:
        p = f["properties"]
        if p.get("code") not in IC_CODES:
            continue
        lon, lat = f["geometry"]["coordinates"]
        key = norm(p["name"])
        key = ALIASES.get(key, key)
        best, q = None, 0
        for b, blat, blon in booths:
            d = km(lat, lon, blat, blon)
            if b and key and (b == key) and d <= NAME_RADIUS_KM and (best is None or q != 1 or d < best[0]):
                best, q = (d, blat, blon), 1
            elif not b and d <= UNNAMED_RADIUS_KM and q != 1 and (best is None or d < best[0]):
                best, q = (d, blat, blon), 2
        if best is None:
            missing.append(p["name"])
            continue
        d, glat, glon = best
        if d > 0.05:
            ux, uy = (glon - lon) / d, (glat - lat) / d
            alon, alat = glon + ux * APPROACH_KM, glat + uy * APPROACH_KM
        else:
            alon, alat = glon, glat
        named += q == 1
        unnamed += q == 2
        rows.append([p["name"], round(lon, 6), round(lat, 6), round(glon, 6), round(glat, 6), round(alon, 6), round(alat, 6), q])

    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "OpenStreetMap barrier=toll_booth (ODbL) × 国土地理院 道路施設",
        "fields": ["name", "lon", "lat", "gate_lon", "gate_lat", "approach_lon", "approach_lat", "q"],
        "ics": rows,
    }
    (OUT / "ic_gates.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    total = named + unnamed + len(missing)
    print(f"ICs {total}: named gate {named}, unnamed gate {unnamed}, no gate {len(missing)}")


if __name__ == "__main__":
    main()
