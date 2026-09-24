"""'If Japan were a village of 100 people' figures, regenerated with every data update.

Writes docs/data/village.json from docs/data/admin_stats.json, the 1km mesh population
and the current Supercharger list.
"""
from __future__ import annotations

import json
import math

import numpy as np
from scipy.spatial import cKDTree

import build_admin as ba
from common import OUT

REGIONS = {
    "北海道": ["01"],
    "東北": ["02", "03", "04", "05", "06", "07"],
    "関東": ["08", "09", "10", "11", "12", "13", "14"],
    "中部": ["15", "16", "17", "18", "19", "20", "21", "22", "23"],
    "近畿": ["24", "25", "26", "27", "28", "29", "30"],
    "中国": ["31", "32", "33", "34", "35"],
    "四国": ["36", "37", "38", "39"],
    "九州・沖縄": ["40", "41", "42", "43", "44", "45", "46", "47"],
}
METROS = ["13", "14", "23", "27"]  # 東京・神奈川・愛知・大阪
BIG_CITY = 200_000
BANDS_KM = [10, 30, 50]
SIGMA_KM = 30.0


def per100(x: float) -> int:
    return int(math.floor(x * 100 + 0.5))


def largest_remainder(shares: list[float]) -> list[int]:
    raw = [s * 100 for s in shares]
    base = [int(math.floor(r)) for r in raw]
    order = sorted(range(len(raw)), key=lambda i: raw[i] - base[i], reverse=True)
    for i in order[: 100 - sum(base)]:
        base[i] += 1
    return base


def smoothed_ratio(mesh, sites, pd30) -> np.ndarray:
    tree = cKDTree(mesh[["x", "y"]].to_numpy())
    w = sites["stalls"].to_numpy(float)
    sd = np.zeros(len(mesh))
    mx, my = mesh["x"].to_numpy(), mesh["y"].to_numpy()
    for (x, y), wt in zip(sites[["x", "y"]].to_numpy(), w):
        idx = np.asarray(tree.query_ball_point([x, y], 4 * SIGMA_KM), dtype=int)
        d2 = (mx[idx] - x) ** 2 + (my[idx] - y) ** 2
        sd[idx] += wt * np.exp(-d2 / (2 * SIGMA_KM**2)) / (2 * np.pi * SIGMA_KM**2)
    expected = pd30 * w.sum() / mesh["pop"].sum()
    return sd / expected


def main() -> None:
    stats = json.loads((OUT / "admin_stats.json").read_text(encoding="utf-8"))
    pref, city = stats["pref"], stats["muni_city"]
    total_pop = sum(v["pop"] for v in pref.values())
    total_stalls = sum(v["o_n_t"] for v in pref.values())

    def share(codes, key):
        tot = total_pop if key == "pop" else total_stalls
        return sum(pref[c][key] for c in codes) / tot

    regions = [
        {"name": n, "people": per100(share(cs, "pop")), "chargers": per100(share(cs, "o_n_t")),
         "ratio": round(share(cs, "o_n_t") / share(cs, "pop"), 2)}
        for n, cs in REGIONS.items()
    ]
    metros = {"people": per100(share(METROS, "pop")), "chargers": per100(share(METROS, "o_n_t"))}

    mesh = ba.load_mesh()
    sc = ba.load_sc()
    all_sets = ba.site_sets(sc)
    sets = {"o": all_sets["o"], "a": all_sets["a"]}
    pop = mesh["pop"].to_numpy()
    xy = mesh[["x", "y"]].to_numpy()
    dist = {st: cKDTree(sub[["x", "y"]].to_numpy()).query(xy)[0] for st, sub in sets.items()}
    edges = [0, *BANDS_KM, np.inf]
    band_shares = [pop[(dist["o"] > lo if lo else dist["o"] >= 0) & (dist["o"] <= hi)].sum() / pop.sum()
                   for lo, hi in zip(edges[:-1], edges[1:])]
    bands = [{"from_km": lo, "to_km": None if np.isinf(hi) else hi, "people": n}
             for lo, hi, n in zip(edges[:-1], edges[1:], largest_remainder(band_shares))]
    within30 = {st: per100(pop[d <= 30].sum() / pop.sum()) for st, d in dist.items()}

    zero_prefs = [c for c, v in pref.items() if v["o_n_s"] == 0]
    isolated = sorted((c for c, v in city.items() if v["pop"] >= BIG_CITY and v["o_a_t"] == 0),
                      key=lambda c: -city[c]["pop"])
    still_isolated = [c for c in isolated if city[c]["a_a_t"] == 0]

    buf = np.fromfile(OUT / "mesh.bin", dtype="<f4")
    n = len(mesh)
    meta = json.loads((OUT / "mesh_meta.json").read_text(encoding="utf-8"))
    k = meta["columns"].index(f"pd{int(SIGMA_KM)}")
    ratio = smoothed_ratio(mesh, sets["o"], buf[k * n:(k + 1) * n])
    low = ratio < 0.5
    import geopandas as gpd
    city_gdf = gpd.read_file(ba.WORK / "muni_city.gpkg")
    city_gdf["code"] = city_gdf["code"].str.zfill(5)
    pts = gpd.GeoDataFrame(mesh, geometry=gpd.points_from_xy(mesh["lon"], mesh["lat"]), crs="EPSG:4326")
    mesh["city"] = ba.assign(pts, city_gdf)
    low_by_city = mesh[low].groupby("city")["pop"].sum().sort_values(ascending=False)
    low_cities = [c for c in low_by_city.index if c in city][:3]

    name = lambda c: city[c]["name"]  # noqa: E731
    out = {
        "as_of": stats["meta"]["sc_fetched"],
        "sites": stats["meta"]["sites"]["o"],
        "stalls": int(total_stalls),
        "people_per_stall": int(round(total_pop / total_stalls, -3)),
        "metros": metros,
        "regions": regions,
        "bands": bands,
        "zero_prefs": {"names": [pref[c]["name"] for c in zero_prefs],
                       "people": per100(sum(pref[c]["pop"] for c in zero_prefs) / total_pop)},
        "isolated_cities": {"names": [name(c) for c in isolated], "min_pop": BIG_CITY,
                            "people": per100(sum(city[c]["pop"] for c in isolated) / total_pop)},
        "low_ratio": {"people": per100(pop[low].sum() / pop.sum()), "examples": [name(c) for c in low_cities]},
        "planned": {"within30_now": within30["o"], "within30_all": within30["a"],
                    "planned_sites": int((sets["a"]["group"] == "planned").sum()),
                    "still_isolated": [name(c) for c in still_isolated]},
    }
    (OUT / "village.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
