"""Compare HERE Routing toll fares with the official NEXCO fare search (ドラぷら) for sample IC pairs.

Local-only evaluation tool for the route/fare feature. It needs the HERE_API_KEY environment
variable (never printed) and Playwright with Microsoft Edge.

Usage: python tools/toll_check.py [--refresh]
Results are cached in data/work/toll_check_cache.json (internal testing only).
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
import urllib.parse
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "work" / "toll_check_cache.json"
DATE = (2026, 9, 29)  # a Tuesday (no holiday discount)
DEPART = "2026-09-29T10:00:00+09:00"

# (GSI IC name, GSI IC name, ドラぷら name, ドラぷら name)
PAIRS = [
    ("横浜青葉", "厚木", None, None),
    ("練馬", "新潟中央", None, None),
    ("仙台宮城", "盛岡", None, None),
    ("東京", "名古屋", None, None),
    ("八王子", "甲府昭和", None, None),
    ("長岡", "新潟中央", None, None),
    ("吹田", "西宮", "吹田(名神高速)", "西宮(名神高速道路)"),
    ("東京", "岩槻", None, None),
    ("浜松", "静岡", None, None),
    ("三ヶ日", "豊川", None, None),
    ("豊田", "名古屋", None, None),
    ("京都東", "名古屋", None, None),
    ("福岡", "熊本", None, None),
    ("広島", "岡山", None, None),
    ("札幌南", "千歳", None, None),
    ("宇都宮", "那須", None, None),
    ("高崎", "前橋", None, None),
    ("所沢", "川越", None, None),
    ("鶴ヶ島", "花園", None, None),
    ("三郷", "水戸", None, None),
    ("厚木", "沼津", None, None),
    ("小牧", "一宮", None, None),
    ("金沢東", "富山", None, None),
    ("遠州森町", "浜松", None, None),
    ("浜松浜北", "袋井", None, None),
    ("岡崎", "浜松", None, None),
    ("横浜町田", "御殿場", None, None),
    ("富士", "静岡", None, None),
    ("一宮", "岐阜羽島", None, None),
    ("大津", "京都東", None, None),
]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").upper()
    s = re.sub(r"[(（].*?[)）]", "", s)
    return re.sub(r"(スマートIC|IC)$", "", s).strip()


def load_cache() -> dict:
    if CACHE.exists() and "--refresh" not in sys.argv:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    return {}


def official(pg, a: str, b: str, cache: dict) -> dict | None:
    key = f"dp|{a}|{b}"
    if key in cache:
        return cache[key]
    q = dict(startPlaceKana=a, arrivePlaceKana=b, searchHour=10, searchMinute=0, kind=1, carType=1, priority=2,
             roadType1="on", roadType2="on", searchYear=DATE[0], searchMonth=DATE[1], searchDay=DATE[2], selectickindflg=0)
    pg.goto("https://www.driveplaza.com/dp/SearchQuick?" + urllib.parse.urlencode(q), wait_until="domcontentloaded", timeout=60000)
    try:
        pg.wait_for_function("() => /ETC2\\.0料金\\s*[\\d,]+円|該当するIC/.test(document.body.innerText)", timeout=30000)
    except Exception:
        pass
    text = pg.inner_text("body")
    m = re.search(r"通常料金\s*([\d,]+)円\s*ETC料金\s*([\d,]+)円\s*ETC2\.0料金\s*([\d,]+)円[\s\S]*?距離\s*([\d.]+)km", text)
    res = None
    if m:
        cash, etc, etc2, dist = (int(m[1].replace(",", "")), int(m[2].replace(",", "")), int(m[3].replace(",", "")), float(m[4]))
        res = {"cash": cash, "etc": etc, "etc2": etc2, "km": dist}
    cache[key] = res
    return res


def here(points: list[tuple[float, float, bool]], cache: dict) -> dict | None:
    """points: (lat, lon, passThrough) - first is origin, last destination."""
    key = "here|" + "|".join(f"{la:.5f},{lo:.5f},{int(pt)}" for la, lo, pt in points)
    if key in cache:
        return cache[key]
    params = [("transportMode", "car"), ("origin", f"{points[0][0]},{points[0][1]}"),
              ("destination", f"{points[-1][0]},{points[-1][1]}"), ("return", "summary,tolls"),
              ("currency", "JPY"), ("tolls[transponders]", "all"), ("departureTime", DEPART),
              ("apikey", os.environ["HERE_API_KEY"])]
    for la, lo, pt in points[1:-1]:
        params.append(("via", f"{la},{lo}" + ("!passThrough=true" if pt else "")))
    r = requests.get("https://router.hereapi.com/v8/routes", params=params, timeout=30)
    if r.status_code != 200:
        cache[key] = None
        return None
    route = r.json()["routes"][0]
    cash = etc = 0
    for sec in route["sections"]:
        for t in sec.get("tolls", []):
            fares = t.get("fares", [])
            tr = [f["price"]["value"] for f in fares if "transponder" in f.get("paymentMethods", [])]
            ca = [f["price"]["value"] for f in fares if "transponder" not in f.get("paymentMethods", [])]
            etc += max(tr) if tr else (min(ca) if ca else 0)
            cash += max(ca) if ca else (max(tr) if tr else 0)
    res = {"etc": round(etc), "cash": round(cash), "km": round(sum(s["summary"]["length"] for s in route["sections"]) / 1000, 1)}
    cache[key] = res
    return res


def main() -> None:
    from playwright.sync_api import sync_playwright

    gates = json.loads((ROOT / "docs" / "data" / "ic_gates.json").read_text(encoding="utf-8"))["ics"]
    by_name: dict[str, list] = {}
    for g in gates:
        by_name.setdefault(norm(g[0]), []).append(g)
    cache = load_cache()
    ok = total = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        pg = browser.new_page()
        for a, b, da, db in PAIRS:
            ga, gb = by_name.get(norm(a)), by_name.get(norm(b))
            off = official(pg, da or a, db or b, cache)
            CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")
            if not ga or not gb:
                print(f"{a}→{b}: no gate ({'A' if not ga else ''}{'B' if not gb else ''})  official={off}")
                continue
            ga, gb = ga[0], gb[0]
            strat = os.environ.get("STRATEGY", "gatevia")
            if strat == "retry":
                def ap(r, flip):
                    al, aa = (2 * r[3] - r[5], 2 * r[4] - r[6]) if flip else (r[5], r[6])
                    return (aa, al, False)
                h = None
                for fa, fb in ((0, 0), (1, 0), (0, 1), (1, 1)):
                    h = here([ap(ga, fa), ap(gb, fb)], cache)
                    if h and h["etc"] > 0:
                        break
                pts = None
            elif strat == "gate":
                pts = [(ga[4], ga[3], False), (gb[4], gb[3], False)]
            elif strat == "approach":
                pts = [(ga[6], ga[5], False), (gb[6], gb[5], False)]
            elif strat == "appvia":
                pts = [(ga[6], ga[5], False), (ga[2], ga[1], True), (gb[2], gb[1], True), (gb[6], gb[5], False)]
            else:
                pts = [(ga[6], ga[5], False), (ga[4], ga[3], True), (gb[4], gb[3], True), (gb[6], gb[5], False)]
            if pts:
                h = here(pts, cache)
            if off is None or h is None:
                print(f"{a}→{b}: official={off} here={h}")
                continue
            total += 1
            hit = h["etc"] in (off["etc"], off["etc2"])
            ok += hit
            print(f"{'OK ' if hit else 'NG '}{a}→{b}: official ETC {off['etc']} ({off['km']}km)  HERE ETC {h['etc']} ({h['km']}km)  q={ga[7]}/{gb[7]}")
        browser.close()
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"match {ok}/{total}")


if __name__ == "__main__":
    main()
