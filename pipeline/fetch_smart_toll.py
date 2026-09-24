"""Build IC ⇄ michi-no-eki pairs where leaving the expressway costs nothing extra (ETC2.0).

- 賢い料金（道の駅一時退出）: list published on the ETC portal (go-etc.jp/michinoeki).
- EV路外充電サービス 社会実験: NEXCO中日本 press release (currently one site).

IC coordinates come from the GSI facility snapshot (road_facilities.geojson) and michi-no-eki
coordinates from the OSM snapshot (poi.json), matched by name. Output: docs/data/smart_toll.json
Usage: python fetch_smart_toll.py
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from datetime import datetime, timezone

import requests

from common import OUT

PORTAL = "https://www.go-etc.jp/michinoeki"
EV_RELEASE = "https://www.c-nexco.co.jp/corporate/pressroom/news_release/6508.html"
HEADERS = {"User-Agent": "tesla-sc-japan (https://github.com/akhayash/tesla-sc-japan)"}

EV_PAIRS = [
    {
        "kind": "ev", "ic": "大野神戸IC", "station": "パレットピアおおの", "minutes": 60,
        "charger": "急速充電器 最大150kW・4台同時", "source": EV_RELEASE,
    },
]
# Names that differ between the official list and the map snapshots.
STATION_ALIASES = {
    "舞ロードIC千代田": ["舞ロード", "舞ロードIC千代田"],
    "都城NiQLL": ["都城NiQLL", "都城"],
    "アグリの郷栗東": ["アグリの郷栗東", "アグリの郷りっとう"],
}
IC_ALIASES = {"春日IC": "春日JCT・IC"}
# Not in the OSM snapshot: GSI address search for the official address (丹波市春日町七日市710).
MANUAL_COORDS: dict[str, list[float]] = {"丹波おばあちゃんの里": [135.116119, 35.165867]}


def norm(s: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or ""))


def dist_km(a, b) -> float:
    kx = 111.32 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.54)


def fetch_portal_pairs() -> list[dict]:
    r = requests.get(PORTAL, headers=HEADERS, timeout=60)
    r.raise_for_status()
    r.encoding = "utf-8"
    text = re.sub(r"<[^>]+>", "\n", re.sub(r"(?s)<script.*?</script>", "", r.text))
    pairs = []
    for line in text.splitlines():
        m = re.match(r"(.+?(?:SIC|IC))/道の駅「(.+?)」", norm(line))
        if m:
            pairs.append({"kind": "kashikoi", "ic": m.group(1), "station": m.group(2), "minutes": 120, "source": PORTAL})
    if len(pairs) < 10:
        raise RuntimeError(f"unexpected portal format: only {len(pairs)} pairs found")
    return pairs


def main() -> None:
    facilities = json.loads((OUT / "road_facilities.geojson").read_text(encoding="utf-8"))["features"]
    ics = [(norm(f["properties"]["name"]), f["geometry"]["coordinates"]) for f in facilities if f["properties"]["code"] in (2941, 2942, 2945)]
    stations = [(norm(n), [lon, lat]) for lon, lat, n in json.loads((OUT / "poi.json").read_text(encoding="utf-8"))["michinoeki"]]

    pairs = fetch_portal_pairs() + EV_PAIRS
    problems = []
    for p in pairs:
        names = [norm(n) for n in STATION_ALIASES.get(norm(p["station"]), [p["station"]])]
        cands = [c for n, c in stations if any(k in n for k in names)]
        station = MANUAL_COORDS.get(p["station"]) or (cands[0] if len(cands) == 1 else None)
        ic_name = norm(IC_ALIASES.get(p["ic"], p["ic"]))
        ic_cands = [c for n, c in ics if n == ic_name]
        if not station and cands and ic_cands:
            station = min(cands, key=lambda c: min(dist_km(c, i) for i in ic_cands))
        if not station or not ic_cands:
            problems.append(f"{p['ic']} / {p['station']}: station={bool(station)} ic={len(ic_cands)}")
            continue
        ic = min(ic_cands, key=lambda c: dist_km(c, station))
        p["station_coords"], p["ic_coords"] = [round(v, 5) for v in station], [round(v, 5) for v in ic]
        p["distance_km"] = round(dist_km(station, ic), 2)
        if p["distance_km"] > 4:
            problems.append(f"{p['ic']} / {p['station']}: {p['distance_km']} km apart")
    for line in problems:
        print("CHECK:", line)
    ok = [p for p in pairs if "station_coords" in p and p.get("distance_km", 99) <= 4]
    out = {
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "sources": {"kashikoi": PORTAL, "ev": EV_RELEASE},
        "pairs": ok,
    }
    (OUT / "smart_toll.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"pairs: {len(ok)} / {len(pairs)} (kashikoi {sum(p['kind'] == 'kashikoi' for p in ok)}, ev {sum(p['kind'] == 'ev' for p in ok)})")


if __name__ == "__main__":
    main()
