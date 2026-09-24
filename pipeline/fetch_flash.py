"""Fetch NACS-compatible FLASH chargers and geocode their addresses."""
from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from common import RAW, get_json, to_lcc_km

URL = "https://ev-charger.jp/area/locations.json"
GEOCODE_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="
CACHE = RAW / "flash_geocode.json"
COORDINATE_OVERRIDES = {
    # The published address omits its municipality; use the coordinates from its official map link.
    "山梨県中巨摩郡上河東字田之神田1302番1": [138.52725, 35.618583],
}


def load_cache() -> dict[str, list[float]]:
    if not CACHE.exists():
        return {}
    return json.loads(CACHE.read_text(encoding="utf-8"))


def save_cache(cache: dict[str, list[float]]) -> None:
    CACHE.write_text(
        json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True),
        encoding="utf-8",
    )


def geocode(address: str, cache: dict[str, list[float]]) -> list[float] | None:
    if address in COORDINATE_OVERRIDES:
        return COORDINATE_OVERRIDES[address]
    if address in cache:
        return cache[address]
    try:
        result = get_json(GEOCODE_URL + quote(address))
    except Exception as exc:
        print(f"WARNING: GSI geocoding failed: {exc}")
        return None
    if not result:
        return None
    lon, lat = result[0]["geometry"]["coordinates"]
    if not (122 <= lon <= 154 and 20 <= lat <= 46):
        return None
    cache[address] = [round(float(lon), 6), round(float(lat), 6)]
    save_cache(cache)
    time.sleep(0.05)
    return cache[address]


def nacs_stalls(output: str) -> int:
    """Count NACS-capable units; a shared CHAdeMO/NACS unit counts as one."""
    matches = re.findall(r"(\d+)基\s*\d+\s*kW（両規格対応）", output)
    return sum(map(int, matches)) if matches else 1


def max_kw(output: str) -> int | None:
    values = [int(v) for v in re.findall(r"(\d+)\s*kW", output)]
    return max(values) if values else None


def feature_id(name: str, address: str) -> str:
    digest = hashlib.sha256(f"{name}\0{address}".encode()).hexdigest()[:16]
    return f"flash-{digest}"


def fetch(previous: list[dict] | None = None, previous_fetched: str | None = None) -> tuple[list[dict], str]:
    try:
        locations = get_json(URL)
    except Exception as exc:
        if previous is None:
            raise
        print(f"WARNING: FLASH fetch failed; keeping previous data: {exc}")
        return previous, previous_fetched or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    cache = load_cache()
    features = []
    skipped = []
    seen = set()
    for item in locations:
        if "NACS" not in (item.get("types") or []):
            continue
        name = str(item.get("name") or "").strip()
        address = re.sub(r"\s+", " ", str(item.get("address") or "").strip())
        key = (name, address)
        if not address or key in seen:
            continue
        seen.add(key)
        coords = geocode(address, cache)
        if not coords:
            skipped.append(f"{name}: {address}")
            continue
        lon, lat = coords
        x, y = to_lcc_km(lon, lat)
        status = "ADJUSTING" if item.get("status") == "調整中" else "OPEN"
        output = str(item.get("output") or "")
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": coords},
                "properties": {
                    "id": feature_id(name, address),
                    "network": "flash",
                    "name": name,
                    "facility": None,
                    "address": address,
                    "status": status,
                    "group": "planned" if status == "ADJUSTING" else "open",
                    "stalls": nacs_stalls(output),
                    "stalls_est": False,
                    "kw": max_kw(output),
                    "output": output or None,
                    "connectors": [t for t in (item.get("types") or []) if t in ("NACS", "CHAdeMO")],
                    "opened": None,
                    "hours": item.get("hours"),
                    "url": item.get("map"),
                    "x": round(float(x), 3),
                    "y": round(float(y), 3),
                },
            }
        )
    if skipped:
        print(f"WARNING: {len(skipped)} FLASH address(es) could not be geocoded.")
    fetched = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    open_count = sum(f["properties"]["group"] == "open" for f in features)
    print(f"FLASH NACS sites: {len(features)} (open {open_count}, adjusting {len(features) - open_count})")
    return features, fetched
