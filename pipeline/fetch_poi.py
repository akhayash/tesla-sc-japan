"""Fetch convenience stores, michi-no-eki and shopping malls in Japan from OpenStreetMap.

Convenience stores and malls use OSM facility-type tags (shop=convenience / shop=mall).
Michi-no-eki have no dedicated OSM tag, so they are matched by their registered name
prefix "道の駅" and merged per station (a station is often mapped as several objects).

Output: docs/data/poi.json (compact arrays; loaded lazily by the map).
Usage: python fetch_poi.py [--cached]   (--cached reuses the last raw Overpass responses in data/work)
Data © OpenStreetMap contributors, ODbL 1.0.
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone

import requests

from common import OUT, WORK

OVERPASS = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "tesla-sc-japan (https://github.com/akhayash/tesla-sc-japan)"}
AREA = 'area["ISO3166-1"="JP"][admin_level=2]->.jp;'

BRANDS = [
    ("セブン-イレブン", ("7-eleven", "7 eleven", "セブン-イレブン", "セブンイレブン", "seven-eleven")),
    ("ファミリーマート", ("familymart", "family mart", "ファミリーマート", "ファミマ")),
    ("ローソン", ("lawson", "ローソン")),
    ("ミニストップ", ("ministop", "ミニストップ")),
    ("デイリーヤマザキ", ("daily yamazaki", "デイリーヤマザキ", "ヤマザキデイリーストアー", "ヤマザキショップ")),
    ("セイコーマート", ("seicomart", "セイコーマート")),
    ("NewDays", ("newdays", "ニューデイズ")),
    ("ポプラ", ("poplar", "ポプラ", "生活彩家")),
]
SUFFIXES = re.compile(
    r"(第?\d*(駐車場|パーキング)|公衆?トイレ|トイレ|売店|レストラン|物産館|情報館|情報コーナー|農産物直売所|直売所|"
    r"案内所|入口|入り口|EV.*|バス停|停留所)$"
)


def overpass_csv(name: str, query: str, fields: list[str], *, retries: int = 5) -> list[dict]:
    cache = WORK / f"poi_{name}.tsv"
    if "--cached" in sys.argv and cache.exists():
        return list(csv.DictReader(io.StringIO(cache.read_text(encoding="utf-8")), delimiter="\t"))
    header = ",".join(f'"{f}"' if not f.startswith("::") else f for f in fields)
    body = f'[out:csv({header};true;"\t")][timeout:300];{AREA}{query}out center tags;'
    delay = 30.0
    for attempt in range(retries):
        try:
            r = requests.post(OVERPASS, data={"data": body}, headers=HEADERS, timeout=400)
            if r.status_code in (429, 504) or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            r.encoding = "utf-8"
            rows = list(csv.DictReader(io.StringIO(r.text), delimiter="\t"))
            if not rows:
                raise ValueError("empty Overpass response")
            cache.write_text(r.text, encoding="utf-8")
            return rows
        except (requests.RequestException, ValueError) as exc:
            if attempt == retries - 1:
                raise
            print(f"Overpass retry {attempt + 1}: {exc}")
            time.sleep(delay)
            delay *= 2
    return []


def coords(row: dict) -> tuple[float, float] | None:
    try:
        return round(float(row["@lon"]), 5), round(float(row["@lat"]), 5)
    except (KeyError, ValueError):
        return None


def dist_m(a, b) -> float:
    kx = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)


def dedupe(points: list[tuple], key, radius_m: float) -> list[tuple]:
    """Drop points that share a key with an already-kept point within radius_m."""
    cell = radius_m / 111000
    grid: dict[tuple, list] = defaultdict(list)
    kept = []
    for p in points:
        gx, gy = int(p[0] / cell), int(p[1] / cell)
        k = key(p)
        near = [q for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in grid[(gx + dx, gy + dy)]]
        if any(key(q) == k and dist_m(p, q) <= radius_m for q in near):
            continue
        grid[(gx, gy)].append(p)
        kept.append(p)
    return kept


def brand_index(row: dict) -> int:
    text = " ".join(row.get(k, "") for k in ("brand", "brand:ja", "brand:en", "name")).lower()
    for i, (_, keys) in enumerate(BRANDS):
        if any(k.lower() in text for k in keys):
            return i
    return -1


def convenience() -> list[list]:
    rows = overpass_csv("convenience", 'nwr["shop"="convenience"](area.jp);', ["::lat", "::lon", "brand", "brand:ja", "brand:en", "name"])
    points = [(*c, brand_index(r)) for r in rows if (c := coords(r))]
    points = dedupe(points, key=lambda p: p[2], radius_m=30)
    return [list(p) for p in points]


def station_key(name: str) -> str:
    base = re.sub(r"^道の駅[\s　]*", "", name)
    base = re.sub(r"[「」『』]", "", base)
    base = re.split(r"[\s　（(・/;；]", base, maxsplit=1)[0]
    for _ in range(2):
        base = SUFFIXES.sub("", base)
    return base


def michinoeki() -> list[list]:
    rows = overpass_csv("michinoeki", 'nwr["name"~"^道の駅"](area.jp);', ["::lat", "::lon", "::type", "name", "highway", "amenity", "tourism", "public_transport"])
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r.get("highway") in ("bus_stop", "platform") or r.get("public_transport"):
            continue
        key = station_key(r.get("name", ""))
        if len(key) >= 2 and not re.fullmatch(r"[A-Za-zＡ-Ｚａ-ｚ0-9０-９]+", key) and coords(r):
            groups[key].append(r)

    def rank(r: dict) -> int:
        if r.get("highway") in ("services", "rest_area"):
            return 0
        if r.get("amenity") not in ("", None, "parking", "toilets", "charging_station", "vending_machine"):
            return 1
        if r.get("tourism"):
            return 2
        return 3 if r.get("amenity") in ("parking", "toilets") else 2

    stations = []
    for key, members in groups.items():
        clusters: list[list[dict]] = []
        for r in sorted(members, key=rank):
            c = coords(r)
            for cl in clusters:
                if any(dist_m(c, coords(o)) <= 2000 for o in cl):
                    cl.append(r)
                    break
            else:
                clusters.append([r])
        for cl in clusters:
            best = min(cl, key=rank)
            stations.append((rank(best), -len(cl), *coords(best), f"道の駅 {key}"))
    # Sub-facilities of one station are sometimes mapped under a different name; keep the
    # most station-like object when differently named stations are almost on top of each other.
    stations.sort()
    kept = dedupe([s[2:] for s in stations], key=lambda p: 0, radius_m=400)
    return [list(p) for p in kept]


def malls() -> list[list]:
    rows = overpass_csv("mall", 'nwr["shop"="mall"]["name"](area.jp);', ["::lat", "::lon", "name"])
    points = [(*c, r["name"].strip()) for r in rows if (c := coords(r)) and r.get("name", "").strip()]
    points = dedupe(points, key=lambda p: p[2], radius_m=500)
    return [list(p) for p in points]


def main() -> None:
    out = {
        "source": "OpenStreetMap contributors",
        "license": "ODbL 1.0",
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "brands": [name for name, _ in BRANDS],
    }
    out["convenience"] = convenience()
    time.sleep(10)
    out["michinoeki"] = michinoeki()
    time.sleep(10)
    out["mall"] = malls()
    path = OUT / "poi.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    branded = sum(p[2] >= 0 for p in out["convenience"])
    print(
        f"convenience {len(out['convenience'])} (branded {branded}), "
        f"michinoeki {len(out['michinoeki'])}, mall {len(out['mall'])}; "
        f"{path.stat().st_size / 1e6:.2f} MB"
    )


if __name__ == "__main__":
    main()
