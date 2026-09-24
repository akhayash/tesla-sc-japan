"""Method A: per-capita supercharger metrics by prefecture / municipality.

Metrics per unit, for status set o (open) / a (open + planned) and weight
s (sites) / t (stalls):
  n  : count inside the unit
  p  : count per 100k residents
  a  : 30km two-step floating catchment (2SFCA) access per 100k residents,
       population-weighted over the unit's 1km meshes
  d  : population-weighted mean distance to the nearest site (km)
"""
from __future__ import annotations

import json

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from common import LCC, OUT, WORK, mesh3_center, to_lcc_km

CATCHMENT_KM = 30.0


def load_sc() -> gpd.GeoDataFrame:
    fc = json.loads((WORK / "sc.geojson").read_text(encoding="utf-8"))
    gdf = gpd.GeoDataFrame.from_features(fc["features"], crs="EPSG:4326")
    return gdf


def assign(points: gpd.GeoDataFrame, polys: gpd.GeoDataFrame) -> pd.Series:
    """Unit code for each point; points outside simplified coastlines snap to nearest unit."""
    pts = points.to_crs(LCC)
    pl = polys[["code", "geometry"]].to_crs(LCC)
    j = gpd.sjoin(pts, pl, how="left", predicate="within")
    j = j[~j.index.duplicated(keep="first")]
    miss = j["code"].isna()
    if miss.any():
        near = gpd.sjoin_nearest(pts[miss], pl, how="left")
        near = near[~near.index.duplicated(keep="first")]
        j.loc[miss, "code"] = near["code"]
    return j["code"].reindex(points.index)


def load_mesh() -> pd.DataFrame:
    m = pd.read_csv(WORK / "mesh_pop.csv")
    lon, lat = mesh3_center(m["mesh"].to_numpy())
    m["lon"], m["lat"] = lon, lat
    m["x"], m["y"] = to_lcc_km(lon, lat)
    return m


def site_sets(sc: gpd.GeoDataFrame) -> dict[str, gpd.GeoDataFrame]:
    network = sc["network"].fillna("tesla") if "network" in sc else pd.Series("tesla", index=sc.index)
    tesla = sc[network == "tesla"]
    flash = sc[network == "flash"]
    return {
        "o": tesla[tesla["group"] == "open"],
        "a": tesla,
        "fo": flash[flash["group"] == "open"],
        "fa": flash,
        "bo": sc[sc["group"] == "open"],
        "ba": sc,
    }


def mesh_access(mesh: pd.DataFrame, sc: gpd.GeoDataFrame) -> pd.DataFrame:
    """Per-mesh nearest distance and 2SFCA access for each status/weight combination."""
    mxy = mesh[["x", "y"]].to_numpy()
    pop = mesh["pop"].to_numpy()
    mtree = cKDTree(mxy)
    out = pd.DataFrame(index=mesh.index)
    for st, sub in site_sets(sc).items():
        sxy = sub[["x", "y"]].to_numpy()
        stree = cKDTree(sxy)
        out[f"{st}_d"], _ = stree.query(mxy)
        neigh = mtree.query_ball_point(sxy, CATCHMENT_KM)
        catch_pop = np.array([pop[idx].sum() for idx in neigh])
        for w, weights in (("s", np.ones(len(sub))), ("t", sub["stalls"].to_numpy(float))):
            ratio = np.where(catch_pop > 0, weights / np.maximum(catch_pop, 1), 0.0)
            acc = np.zeros(len(mesh))
            for j, idx in enumerate(neigh):
                acc[idx] += ratio[j]
            out[f"{st}_a_{w}"] = acc * 1e5
    return out


def summarise(units: pd.DataFrame, mesh: pd.DataFrame, acc: pd.DataFrame, key: str,
              sc: gpd.GeoDataFrame, sc_key: str) -> pd.DataFrame:
    res = units.set_index("code").copy()
    w = mesh["pop"]
    grp = mesh[key]
    for col in acc.columns:
        num = (acc[col] * w).groupby(grp).sum()
        den = w.groupby(grp).sum()
        res[col] = (num / den).reindex(res.index)
    for st, sub in site_sets(sc).items():
        res[f"{st}_n_s"] = sub.groupby(sc_key).size().reindex(res.index).fillna(0).astype(int)
        res[f"{st}_n_t"] = sub.groupby(sc_key)["stalls"].sum().reindex(res.index).fillna(0).astype(int)
        for w_ in ("s", "t"):
            res[f"{st}_p_{w_}"] = res[f"{st}_n_{w_}"] / res["pop"] * 1e5
    return res.reset_index()


def to_records(df: pd.DataFrame) -> dict:
    recs = {}
    for r in df.to_dict(orient="records"):
        code = r.pop("code")
        clean = {}
        for k, v in r.items():
            if isinstance(v, float):
                clean[k] = None if np.isnan(v) else round(v, 3)
            elif isinstance(v, (np.integer,)):
                clean[k] = int(v)
            else:
                clean[k] = v
        recs[code] = clean
    return recs


def main() -> None:
    sc = load_sc()
    pop = pd.read_csv(WORK / "muni_pop.csv", dtype={"code": str})
    ward = gpd.read_file(WORK / "muni_ward.gpkg")
    city = gpd.read_file(WORK / "muni_city.gpkg")
    ward["code"] = ward["code"].str.zfill(5)
    city["code"] = city["code"].str.zfill(5)

    pop_by_code = pop.set_index("code")
    for name, gdf in (("muni_ward", ward), ("muni_city", city)):
        missing = sorted(set(gdf["code"]) - set(pop_by_code.index))
        print(f"{name}: {len(missing)} boundary units without population -> dropped: {missing}")
    ward = ward[ward["code"].isin(pop_by_code.index)].copy()
    city = city[city["code"].isin(pop_by_code.index)].copy()

    mesh = load_mesh()
    mesh_pts = gpd.GeoDataFrame(mesh, geometry=gpd.points_from_xy(mesh["lon"], mesh["lat"]), crs="EPSG:4326")
    mesh["ward"] = assign(mesh_pts, ward)
    mesh["city"] = assign(mesh_pts, city)
    mesh["pref"] = mesh["city"].str.slice(0, 2)

    sc["ward"] = assign(sc, ward)
    sc["city"] = assign(sc, city)
    sc["pref"] = sc["city"].str.slice(0, 2)

    acc = mesh_access(mesh, sc)

    def unit_table(codes: pd.Series) -> pd.DataFrame:
        t = pop_by_code.loc[codes, ["pref", "name", "pop"]].reset_index()
        return t

    ward_units = unit_table(ward["code"])
    city_units = unit_table(city["code"])
    pref_codes = pd.Series(sorted(city["code"].str.slice(0, 2).unique()))
    pref_units = pop_by_code.loc[pref_codes + "000", ["pref", "name", "pop"]].reset_index()
    pref_units["code"] = pref_units["code"].str.slice(0, 2)

    stats = {
        "pref": to_records(summarise(pref_units, mesh, acc, "pref", sc, "pref")),
        "muni_city": to_records(summarise(city_units, mesh, acc, "city", sc, "city")),
        "muni_ward": to_records(summarise(ward_units, mesh, acc, "ward", sc, "ward")),
    }
    fc = json.loads((WORK / "sc.geojson").read_text(encoding="utf-8"))
    sets = site_sets(sc)
    meta = {
        "sc_fetched": fc["fetched"],
        "flash_fetched": fc.get("fetched_flash"),
        "catchment_km": CATCHMENT_KM,
        "population_total": int(pop_by_code.loc["00000", "pop"]),
        "sites": {key: int(len(sub)) for key, sub in sets.items()},
        "stalls": {key: int(sub["stalls"].sum()) for key, sub in sets.items()},
    }
    (OUT / "admin_stats.json").write_text(
        json.dumps({"meta": meta, **stats}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    # Boundaries for the web map (converted to TopoJSON by build_topo).
    ward[["code", "geometry"]].to_file(WORK / "muni_ward_web.geojson", driver="GeoJSON")
    city[["code", "geometry"]].to_file(WORK / "muni_city_web.geojson", driver="GeoJSON")
    pref = city.assign(code=city["code"].str.slice(0, 2)).dissolve(by="code", as_index=False)[["code", "geometry"]]
    pref.to_file(WORK / "pref_web.geojson", driver="GeoJSON")

    # Sanity checks
    for key in ("pref", "muni_city", "muni_ward"):
        tot_sites = sum(v["o_n_s"] for v in stats[key].values())
        tot_pop = sum(v["pop"] for v in stats[key].values())
        flash_sites = sum(v["fo_n_s"] for v in stats[key].values())
        print(f"{key}: units={len(stats[key])} open_sc={tot_sites} open_flash={flash_sites} pop={tot_pop:,}")
    print(f"mesh pop unassigned: {mesh['city'].isna().sum()}")


if __name__ == "__main__":
    main()
