"""Fetch Tesla Supercharger and NACS-compatible FLASH sites in Japan."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from common import OUT, WORK, get_json, to_lcc_km
import fetch_flash

URL = "https://supercharge.info/service/supercharge/allSites"

OPEN = {"OPEN", "EXPANDING", "CLOSED_TEMP"}
PLANNED = {"CONSTRUCTION", "PERMIT", "PLAN", "VOTING"}
STALL_GENERATIONS = ("v2", "v3", "v4", "urban")
STALL_FEATURES = {"accessible": "accessible", "trailerFriendly": "trailer"}


def counts(raw: dict | None, keys) -> dict[str, int]:
    raw = raw or {}
    return {k: int(raw[k]) for k in keys if str(raw.get(k) or "").isdigit() and int(raw[k]) > 0}


def plug_counts(raw: dict | None) -> dict[str, int]:
    return {k: int(v) for k, v in (raw or {}).items() if str(v or "").isdigit() and int(v) > 0}


def previous_flash() -> tuple[list[dict] | None, str | None]:
    path = OUT / "sc.geojson"
    if not path.exists():
        return None, None
    fc = json.loads(path.read_text(encoding="utf-8"))
    features = [f for f in fc["features"] if f["properties"].get("network") == "flash"]
    return (features or None), fc.get("fetched_flash")


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
        stalls = s.get("stalls") or {}
        amenities = {name: int(stalls[key]) for key, name in STALL_FEATURES.items() if str(stalls.get(key) or "").isdigit() and int(stalls[key]) > 0}
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                "properties": {
                    "id": s["id"],
                    "network": "tesla",
                    "name": s.get("name"),
                    "facility": s.get("facilityName"),
                    "status": status,
                    "group": group,
                    "stalls": int(s.get("stallCount") or 0),
                    "kw": int(s["powerKilowatt"]) if str(s.get("powerKilowatt") or "").isdigit() else None,
                    "opened": s["dateOpened"] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(s.get("dateOpened") or "")) else None,
                    "hours": s.get("hours") or None,
                    "generations": counts(stalls, STALL_GENERATIONS),
                    "plugs": plug_counts(s.get("plugs")),
                    "amenities": amenities,
                    "location_note": s.get("addressNotes") or None,
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
    old_flash, old_flash_fetched = previous_flash()
    flash, fetched_flash = fetch_flash.fetch(old_flash, old_flash_fetched)
    fc = {
        "type": "FeatureCollection",
        "fetched": fetched,
        "fetched_flash": fetched_flash,
        "features": features + flash,
    }
    for path in (WORK / "sc.geojson", OUT / "sc.geojson"):
        path.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_open = sum(f["properties"]["group"] == "open" for f in features)
    print(f"Tesla sites: {len(features)} (open {n_open}, planned {len(features) - n_open})")


if __name__ == "__main__":
    main()
