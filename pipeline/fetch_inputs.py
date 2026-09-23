"""Download boundaries, municipal population and 1km mesh population."""
from __future__ import annotations

import io
import zipfile
from concurrent.futures import ThreadPoolExecutor

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
from shapely.geometry import box

from common import RAW, WORK, download

TOPO_BASE = "https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/geojson/s0010"
BOUNDARIES = {
    "muni_ward": f"{TOPO_BASE}/N03-21_210101.json",
    "muni_city": f"{TOPO_BASE}/N03-21_210101_designated_city.json",
}
POP_URL = "https://www.e-stat.go.jp/stat-search/file-download?statInfId=000032143614&fileKind=0"
MESH_URL = "https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001140&code={code}&downloadType=2"


def fetch_boundaries() -> dict[str, gpd.GeoDataFrame]:
    out = {}
    for key, url in BOUNDARIES.items():
        path = download(url, RAW / f"{key}.geojson")
        gdf = gpd.read_file(path)
        gdf = gdf[gdf["N03_007"].notna()].copy()
        gdf["code"] = gdf["N03_007"].astype(str).str.zfill(5)
        gdf["pref"] = gdf["N03_001"]
        gdf = gdf.dissolve(by="code", aggfunc="first", as_index=False)[["code", "pref", "geometry"]]
        out[key] = gdf
        print(f"{key}: {len(gdf)} units")
    return out


def fetch_population() -> pd.DataFrame:
    path = download(POP_URL, RAW / "muni_pop_2020.xlsx")
    df = pd.read_excel(path, sheet_name=0, header=None, skiprows=9)
    df = df.iloc[:, [0, 1, 3, 4]]
    df.columns = ["pref", "area", "kind", "pop"]
    df = df[df["area"].notna()]
    df["code"] = df["area"].astype(str).str.slice(0, 5)
    df["name"] = df["area"].astype(str).str.slice(6)
    df["pref"] = df["pref"].astype(str).str.slice(3)
    df["pop"] = pd.to_numeric(df["pop"], errors="coerce")
    df = df[df["code"].str.fullmatch(r"\d{5}") & df["pop"].notna()]
    df["pop"] = df["pop"].astype(int)
    df = df[["code", "pref", "name", "kind", "pop"]].drop_duplicates("code")
    df.to_csv(WORK / "muni_pop.csv", index=False, encoding="utf-8")
    print(f"population rows: {len(df)}")
    return df


def mesh1_codes(gdf: gpd.GeoDataFrame) -> list[int]:
    codes = set()
    geom = gdf.geometry.union_all()
    minx, miny, maxx, maxy = geom.bounds
    for p in range(int(miny * 1.5), int(maxy * 1.5) + 1):
        for u in range(int(minx) - 100, int(maxx) - 100 + 1):
            cell = box(u + 100, p / 1.5, u + 101, (p + 1) / 1.5)
            if geom.intersects(cell):
                codes.add(p * 100 + u)
    return sorted(codes)


def _fetch_mesh(code: int) -> pd.DataFrame | None:
    path = RAW / "mesh" / f"{code}.zip"
    path.parent.mkdir(exist_ok=True)
    try:
        download(MESH_URL.format(code=code), path)
    except FileNotFoundError:
        return None  # no populated meshes in this 1st-level mesh
    except requests.RequestException as e:
        print(f"mesh {code}: {e}")
        return None
    try:
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.lower().endswith(".txt"))
            raw = z.read(name)
    except (zipfile.BadZipFile, StopIteration):
        path.unlink(missing_ok=True)
        return None
    df = pd.read_csv(io.BytesIO(raw), encoding="cp932", skiprows=[1], dtype=str)
    df = df[["KEY_CODE", "T001140001"]]
    df.columns = ["mesh", "pop"]
    df["pop"] = pd.to_numeric(df["pop"], errors="coerce").fillna(0)
    return df


def fetch_mesh(gdf: gpd.GeoDataFrame) -> pd.DataFrame:
    codes = mesh1_codes(gdf)
    print(f"1st-level meshes to fetch: {len(codes)}")
    with ThreadPoolExecutor(max_workers=6) as ex:
        parts = [p for p in ex.map(_fetch_mesh, codes) if p is not None]
    df = pd.concat(parts, ignore_index=True)
    df["mesh"] = df["mesh"].astype(np.int64)
    df = df.groupby("mesh", as_index=False)["pop"].sum()
    df = df[df["pop"] > 0]
    df.to_csv(WORK / "mesh_pop.csv", index=False)
    print(f"populated 1km meshes: {len(df)}, population {df['pop'].sum():,.0f}")
    return df


def main() -> None:
    b = fetch_boundaries()
    for key, gdf in b.items():
        gdf.to_file(WORK / f"{key}.gpkg", driver="GPKG")
    fetch_population()
    fetch_mesh(b["muni_city"])


if __name__ == "__main__":
    main()
