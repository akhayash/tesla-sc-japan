"""Fetch Tesla Supercharger sites in Japan from supercharge.info."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from common import OUT, WORK, get_json, to_lcc_km

URL = "https://supercharge.info/service/supercharge/allSites"

OPEN = {"OPEN", "EXPANDING", "CLOSED_TEMP"}
PLANNED = {"CONSTRUCTION", "PERMIT", "PLAN", "VOTING"}


def main() -> None:
    sites = get_json(URL)
    jp = [s for s in sites if (s.get("address") or {}).get("country") == "Japan"]
    features = []
    for s in jp:
        status = s.get("status")
        if status in OPEN:
            group = "open"
        elif status in PLANNED:
            group = "planned"
        else:
            continue
        lon, lat = s["gps"]["longitude"], s["gps"]["latitude"]
        x, y = to_lcc_km(lon, lat)
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                "properties": {
                    "id": s["id"],
                    "name": s.get("name"),
                    "facility": s.get("facilityName"),
                    "status": status,
                    "group": group,
                    "stalls": int(s.get("stallCount") or 0),
                    "kw": s.get("powerKilowatt"),
                    "opened": s.get("dateOpened"),
                    "x": round(float(x), 3),
                    "y": round(float(y), 3),
                },
            }
        )
    # Planned sites usually have no stall count yet; use the median of open sites as an estimate.
    open_stalls = sorted(f["properties"]["stalls"] for f in features if f["properties"]["group"] == "open")
    median = open_stalls[len(open_stalls) // 2] if open_stalls else 0
    for f in features:
        p = f["properties"]
        p["stalls_est"] = p["stalls"] == 0
        if p["stalls_est"]:
            p["stalls"] = median
    fetched = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    fc = {"type": "FeatureCollection", "fetched": fetched, "features": features}
    for path in (WORK / "sc.geojson", OUT / "sc.geojson"):
        path.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_open = sum(f["properties"]["group"] == "open" for f in features)
    print(f"Japan sites: {len(features)} (open {n_open}, planned {len(features) - n_open})")


if __name__ == "__main__":
    main()

