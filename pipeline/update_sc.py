"""Refresh Supercharger data and rebuild the admin-level stats only when sites changed.

Population, boundaries and the mesh population grid are unchanged between censuses,
so only docs/data/sc.geojson, admin_stats.json and village.json are regenerated. The 1km mesh
view computes SC density in the browser and needs no rebuild.

Usage: python update_sc.py [--force]
Writes `changed=true|false` and a short summary to $GITHUB_OUTPUT when running in Actions.
"""
from __future__ import annotations

import json
import os
import sys

from common import OUT

KEYS = ("network", "name", "status", "stalls", "stalls_est")
SPEC_KEYS = ("kw", "hours", "generations", "plugs", "amenities", "location_note", "output", "connectors")


def load(path) -> dict:
    if not path.exists():
        return {}
    fc = json.loads(path.read_text(encoding="utf-8"))
    return {f["properties"]["id"]: f for f in fc["features"]}


def diff(old: dict, new: dict) -> list[str]:
    lines = []
    for sid in new.keys() - old.keys():
        p = new[sid]["properties"]
        lines.append(f"+ [{p.get('network', 'tesla')}] {p['name']} ({p['status']}, {p['stalls']} stalls)")
    for sid in old.keys() - new.keys():
        p = old[sid]["properties"]
        lines.append(f"- [{p.get('network', 'tesla')}] {p['name']}")
    for sid in new.keys() & old.keys():
        a, b = old[sid]["properties"], new[sid]["properties"]
        if old[sid]["geometry"] != new[sid]["geometry"] or any(a.get(k) != b.get(k) for k in KEYS):
            lines.append(
                f"~ [{b.get('network', 'tesla')}] {b['name']}: "
                f"{a['status']}/{a['stalls']} -> {b['status']}/{b['stalls']}"
            )
        elif any(a.get(k) != b.get(k) for k in SPEC_KEYS):
            lines.append(f"~ [{b.get('network', 'tesla')}] {b['name']}: charger details updated")
    return sorted(lines)


def write_output(changed: bool, summary: list[str]) -> None:
    gh = os.environ.get("GITHUB_OUTPUT")
    if not gh:
        return
    with open(gh, "a", encoding="utf-8") as f:
        f.write(f"changed={'true' if changed else 'false'}\n")
        f.write("summary<<EOF\n" + ("\n".join(summary) or "no site changes") + "\nEOF\n")


def main() -> None:
    import build_admin
    import build_hazard
    import build_village
    import fetch_inputs
    import fetch_sc

    force = "--force" in sys.argv
    sc_path = OUT / "sc.geojson"
    previous = sc_path.read_bytes() if sc_path.exists() else None
    old = load(sc_path)

    fetch_sc.main()
    changes = diff(old, load(sc_path))
    if not changes and not force:
        if previous is not None:
            sc_path.write_bytes(previous)  # keep the committed file (and its date) untouched
        print("No charger changes.")
        hazard_changed = build_hazard.main()  # re-checks sites whose assessment is stale
        write_output(hazard_changed, ["hazard assessment refreshed"] if hazard_changed else [])
        return

    print(f"{len(changes)} site change(s):")
    for line in changes:
        print("  " + line)
    fetch_inputs.main()
    build_admin.main()
    build_village.main()
    build_hazard.main()
    write_output(True, changes)


if __name__ == "__main__":
    main()
