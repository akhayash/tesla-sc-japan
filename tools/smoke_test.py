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
    "a_flash_only": "#mode=A&unit=pref&metric=p&tesla=0&flash=1",
    "a_both": "#mode=A&unit=pref&metric=a&tesla=1&flash=1",
    "bad_hash": "#mode=Z&unit=x&bw=20&metric=q",
    "b_ratio": "#mode=B&layer=ratio&bw=30",
    "b_pop": "#mode=B&layer=pop&bw=30&base=photo",
    "a_std": "#mode=A&unit=pref&base=std",
    "b_sc": "#mode=B&layer=sc&bw=10&status=a&weight=s",
    "b_none": "#mode=B&layer=none",
    "b_flash_ratio": "#mode=B&layer=ratio&bw=30&tesla=0&flash=1",
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
        if name == "a_pref":
            if page.is_visible("#ctl-bw") or page.is_visible("#ctl-pop-alpha"):
                errors.append("mesh-only controls were visible in administrative mode")
            page.click("#panel-toggle")
            page.wait_for_timeout(250)
            if "panel-collapsed" not in (page.get_attribute("body", "class") or ""):
                errors.append("side panel did not collapse")
            if page.get_attribute("#panel-toggle", "aria-expanded") != "false":
                errors.append("side panel toggle accessibility state was not updated")
            page.click("#panel-toggle")
            page.wait_for_timeout(250)
            if "panel-collapsed" in (page.get_attribute("body", "class") or ""):
                errors.append("side panel did not reopen")
            page.click(".network-option.tesla")
            if not page.is_checked("#use-tesla"):
                errors.append("both charger networks could be disabled")
            page.click("#show-expressway")
            if page.is_checked("#show-expressway") or "expressway=0" not in page.url:
                errors.append("expressway visibility toggle did not update state")
            page.click("#show-road-facilities")
            if page.is_checked("#show-road-facilities") or "roadFacilities=0" not in page.url:
                errors.append("road facility visibility toggle did not update state")
            page.click("#show-road-facilities")
            page.click('[data-facility="facilitySa"]')
            if page.get_attribute('[data-facility="facilitySa"]', "aria-pressed") != "false" or "facilitySa=0" not in page.url:
                errors.append("SA legend toggle did not update state")
            page.click('[data-facility="facilitySa"]')
            if page.get_attribute('[data-facility="facilitySa"]', "aria-pressed") != "true":
                errors.append("SA legend toggle did not restore state")
            if "名称" not in page.inner_text(".key-row + .field-note"):
                errors.append("zoom label guidance is missing")
            if page.locator("#power-key img").count() != 3:
                errors.append("charger power tier legend is missing")
            if page.locator('[data-poi][aria-pressed="true"]').count():
                errors.append("POI layers should be off by default")
            page.click('[data-poi="poiMichinoeki"]')
            page.wait_for_timeout(2500)
            if page.get_attribute('[data-poi="poiMichinoeki"]', "aria-pressed") != "true" or "poiMichinoeki=1" not in page.url:
                errors.append("michi-no-eki toggle did not update state")
            page.click('[data-poi="poiMichinoeki"]')
        if name == "a_flash_only" and (page.is_checked("#use-tesla") or not page.is_checked("#use-flash")):
            errors.append("FLASH-only state was not restored from URL")
        if name == "a_both" and (not page.is_checked("#use-tesla") or not page.is_checked("#use-flash")):
            errors.append("combined charger state was not restored from URL")
        if name == "a_muni_access":
            page.click("#rank-list li:first-child")
            page.wait_for_timeout(2500)
            page.screenshot(path=str(OUT / "a_rank_click.png"))
            print("popup:", page.inner_text(".maplibregl-popup-content")[:200].replace("\n", " "))
        if name == "b_ratio":
            page.click('[data-key="layer"] [data-v="ratio"]')
            if page.locator('[data-key="layer"] button.active').count() or "layer=none" not in page.url:
                errors.append("active mesh layer could not be toggled off")
            if page.is_visible("#ctl-bw") or page.is_visible("#ctl-weight") or page.is_visible("#ctl-pop-alpha"):
                errors.append("mesh controls remained visible after toggling the layer off")
            page.click('[data-key="layer"] [data-v="ratio"]')
            if not page.locator('[data-key="layer"] [data-v="ratio"]').evaluate("el => el.classList.contains('active')"):
                errors.append("mesh layer could not be toggled back on")
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
        if name == "b_none":
            if page.locator('[data-key="layer"] button.active').count():
                errors.append("no-mesh state was not restored from URL")
            if page.inner_text("#legend").strip() or page.inner_text("#summary").strip():
                errors.append("no-mesh state retained mesh results")
            if page.is_visible("#ctl-bw") or page.is_visible("#ctl-weight") or page.is_visible("#ctl-pop-alpha"):
                errors.append("no-mesh state retained irrelevant mesh controls")
    browser.close()

print("errors:", errors or "none")
sys.exit(1 if errors else 0)
