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
PREF_BIG_CITY = 50_000
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


def wquantile(v: np.ndarray, w: np.ndarray, q: float) -> float:
    o = np.argsort(v)
    cw = np.cumsum(w[o])
    return float(v[o][np.searchsorted(cw, q * cw[-1])])


def wbox(lon: np.ndarray, lat: np.ndarray, w: np.ndarray) -> list[float]:
    """Bounding box of where people live (1st–99th weighted percentile), ignoring remote islets."""
    return [round(wquantile(lon, w, .01), 3), round(wquantile(lat, w, .01), 3),
            round(wquantile(lon, w, .99), 3), round(wquantile(lat, w, .99), 3)]


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

    meta = json.loads((OUT / "mesh_meta.json").read_text(encoding="utf-8"))
    pd_sigma = np.fromfile(OUT / meta["pd_files"][str(int(SIGMA_KM))], dtype="<f4")
    ratio = smoothed_ratio(mesh, sets["o"], pd_sigma)
    low = ratio < 0.5
    import geopandas as gpd
    city_gdf = gpd.read_file(ba.WORK / "muni_city.gpkg")
    city_gdf["code"] = city_gdf["code"].str.zfill(5)
    pts = gpd.GeoDataFrame(mesh, geometry=gpd.points_from_xy(mesh["lon"], mesh["lat"]), crs="EPSG:4326")
    mesh["city"] = ba.assign(pts, city_gdf)
    low_by_city = mesh[low].groupby("city")["pop"].sum().sort_values(ascending=False)
    low_cities = [c for c in low_by_city.index if c in city][:3]

    name = lambda c: city[c]["name"]  # noqa: E731

    # ---------- prefecture-level figures for the split story page ----------
    mesh["pref"] = mesh["city"].str.slice(0, 2)
    mesh["d_o"], mesh["d_a"], mesh["low"] = dist["o"], dist["a"], low
    lon, lat = mesh["lon"].to_numpy(), mesh["lat"].to_numpy()

    def centroid(mask) -> list[float]:
        w = pop[mask]
        return [round(float((lon[mask] * w).sum() / w.sum()), 4), round(float((lat[mask] * w).sum() / w.sum()), 4)]

    city_pts = {}
    for c in set(isolated) | {c for c, v in city.items() if v["pop"] >= PREF_BIG_CITY and v["o_a_t"] == 0}:
        m = (mesh["city"] == c).to_numpy()
        if m.any():
            city_pts[c] = centroid(m)

    rank_order = sorted(pref, key=lambda c: -pref[c]["o_p_t"])
    prefs = {}
    for code, v in pref.items():
        m = (mesh["pref"] == code).to_numpy()
        pp = pop[m]
        d = mesh["d_o"].to_numpy()[m]
        shares = [pp[((d > lo) | (lo == 0)) & (d <= hi)].sum() / pp.sum() for lo, hi in zip(edges[:-1], edges[1:])]
        iso = sorted((c for c, cv in city.items() if c[:2] == code and cv["pop"] >= PREF_BIG_CITY and cv["o_a_t"] == 0),
                     key=lambda c: -city[c]["pop"])
        low_pref = mesh[m & low].groupby("city")["pop"].sum().sort_values(ascending=False)
        prefs[code] = {
            "name": v["name"],
            "pop": int(v["pop"]),
            "people_share": round(v["pop"] / total_pop * 100, 1),
            "charger_share": round(v["o_n_t"] / total_stalls * 100, 1),
            "sites": int(v["o_n_s"]),
            "stalls": int(v["o_n_t"]),
            "planned_sites": int(v["a_n_s"] - v["o_n_s"]),
            "people_per_stall": int(round(v["pop"] / v["o_n_t"], -3)) if v["o_n_t"] else None,
            "rank": rank_order.index(code) + 1,
            "mean_km": round(float((d * pp).sum() / pp.sum()), 1),
            "bands": largest_remainder(shares),
            "isolated": [{"name": city[c]["name"], "pop": int(city[c]["pop"]), "pt": city_pts.get(c),
                          "still": city[c]["a_a_t"] == 0} for c in iso],
            "low_ratio": per100(pp[mesh["low"].to_numpy()[m]].sum() / pp.sum()),
            "low_examples": [city[c]["name"] for c in low_pref.index if c in city][:3],
            "within30_now": per100(pp[d <= 30].sum() / pp.sum()),
            "within30_all": per100(pp[mesh["d_a"].to_numpy()[m] <= 30].sum() / pp.sum()),
            "bbox": wbox(lon[m], lat[m], pp),
        }
    map_data = {
        "metros": METROS,
        "regions": {n: cs for n, cs in REGIONS.items()},
        "zero": zero_prefs,
        "near10": {c: p["bands"][0] for c, p in prefs.items()},
        "low": {c: p["low_ratio"] for c, p in prefs.items()},
        "per_stall": {c: p["people_per_stall"] for c, p in prefs.items()},
        "isolated": [{"name": city[c]["name"], "pt": city_pts.get(c), "still": c in still_isolated} for c in isolated],
    }
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
        "map": map_data,
        "prefs": dict(sorted(prefs.items())),
    }
    (OUT / "village.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"village.json: {len(prefs)} prefectures, national within30 {within30['o']}%")


if __name__ == "__main__":
    main()
