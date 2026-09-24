"""Headless smoke test: load the map in each mode and save screenshots."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)

CASES = {
    "a_pref": "#mode=A&unit=pref&metric=p",
    "a_muni_access": "#mode=A&unit=muni_city&metric=a&rankMin=100000",
    "a_ward_dist": "#mode=A&unit=muni_ward&metric=d&rankMin=100000",
    "a_muni_count": "#mode=A&unit=muni_ward&metric=n&weight=s",
    "bad_hash": "#mode=Z&unit=x&bw=20&metric=q",
    "b_ratio": "#mode=B&layer=ratio&bw=30",
    "b_pop": "#mode=B&layer=pop&bw=30&base=photo",
    "a_std": "#mode=A&unit=pref&base=std",
    "b_sc": "#mode=B&layer=sc&bw=10&status=a&weight=s",
}

errors: list[str] = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    for name, h in CASES.items():
        page.goto("about:blank")
        page.goto(BASE + h)
        page.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / f"{name}.png"))
        info = page.evaluate("() => ({legend: document.querySelector('#legend').innerText.slice(0,120), rank: document.querySelector('#rank-list').innerText.slice(0,200), summary: document.querySelector('#summary').innerText})")
        print(name, info)
        if name == "a_muni_access":
            page.click("#rank-list li:first-child")
            page.wait_for_timeout(2500)
            page.screenshot(path=str(OUT / "a_rank_click.png"))
            print("popup:", page.inner_text(".maplibregl-popup-content")[:200].replace("\n", " "))
        if name == "b_ratio":
            page.mouse.move(1000, 520)
            for _ in range(6):
                page.mouse.wheel(0, -400)
                page.wait_for_timeout(300)
            page.wait_for_timeout(2000)
            tips = []
            for pt in [(1000, 520), (1010, 500), (800, 600), (700, 450)]:
                page.mouse.move(*pt)
                page.wait_for_timeout(500)
                tips.append(page.inner_text("#tooltip").replace("\n", " "))
            page.screenshot(path=str(OUT / "b_ratio_zoom.png"))
            print("tooltip:", tips)
            if not any(tips):
                errors.append("mesh tooltip never appeared")
    browser.close()

print("errors:", errors or "none")
sys.exit(1 if errors else 0)




