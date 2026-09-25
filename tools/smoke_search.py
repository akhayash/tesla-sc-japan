"""Headless smoke test for the map search box (local index + GSI/Photon fallback)."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/").rstrip("/") + "/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)

errors: list[str] = []


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, geolocation={"latitude": 35.681, "longitude": 139.767}, permissions=["geolocation"])
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and "404" not in m.text and errors.append(m.text))
    page.goto(BASE)
    page.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    box = page.locator("#map-search-input")
    if not box.is_visible():
        errors.append("search box not visible")

    def at():
        return [float(v) for v in page.evaluate("new URLSearchParams(location.hash.slice(1)).get('at')").split(",")]

    def settle():
        page.wait_for_timeout(1600)

    # 1) local suggestion (hiragana query matches katakana names; poi.json loads on focus)
    box.click()
    box.fill("いおんもーる")
    page.wait_for_selector(".ms-list li.kind-mall", timeout=8000)
    first = page.inner_text(".ms-list li[data-i]").replace("\n", " ")
    print("suggest いおんもーる:", first)
    box.fill("箱根")
    page.wait_for_selector(".ms-list li.kind-muni", timeout=5000)
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    settle()
    lon, lat, z = at()
    print("箱根 ->", lon, lat, z)
    if not (138.9 < lon < 139.2 and 35.1 < lat < 35.35):
        errors.append(f"箱根 not centred: {lon},{lat}")
    if not page.is_visible(".ms-card"):
        errors.append("result card not shown")
    else:
        print("card:", page.inner_text(".ms-card").replace("\n", " ")[:160])
    page.screenshot(path=str(OUT / "search_hakone.png"))

    # 2) local road facility (SA)
    box.fill("海老名")
    page.wait_for_selector(".ms-list li.kind-sa", timeout=5000)
    page.click(".ms-list li.kind-sa")
    settle()
    lon, lat, _ = at()
    print("海老名SA ->", lon, lat)
    if not (139.3 < lon < 139.45 and 35.4 < lat < 35.5):
        errors.append(f"海老名SA not centred: {lon},{lat}")

    # 3) charger (English Tesla name) opens popup
    box.fill("honmoku")
    page.wait_for_selector(".ms-list li.kind-tesla", timeout=5000)
    page.keyboard.press("Enter")
    page.wait_for_selector(".maplibregl-popup-content", timeout=10000)
    print("charger popup:", page.inner_text(".maplibregl-popup-content")[:60].replace("\n", " "))

    # 4) remote: address (GSI) and facility (Photon) in parallel
    box.fill("姫路市安田")
    page.keyboard.press("Enter")
    page.wait_for_selector(".ms-list li.kind-gsi", timeout=8000)
    settle()
    lon, lat, _ = at()
    print("姫路市安田 ->", lon, lat)
    if not (134.6 < lon < 134.75 and 34.78 < lat < 34.88):
        errors.append(f"姫路市安田 not centred: {lon},{lat}")
    box.fill("東京駅")
    page.keyboard.press("Enter")
    page.wait_for_function("!document.querySelector('.ms-status')", timeout=8000)
    settle()
    lon, lat, _ = at()
    kinds = page.eval_on_selector_all(".ms-list li[data-i]", "els => els.map(e => e.className)")
    print("東京駅 ->", lon, lat, kinds[:6])
    if not (139.76 < lon < 139.775 and 35.675 < lat < 35.687):
        errors.append(f"東京駅 not centred on the station: {lon},{lat}")
    page.screenshot(path=str(OUT / "search_tokyo_station.png"))

    # 5) hazard info in mode C
    page.click(".tabs button[data-mode=C]")
    page.wait_for_selector(".ms-hz .ms-hz-title", timeout=15000)
    print("hazard:", page.inner_text(".ms-hz").replace("\n", " "))

    # 6) geolocation
    page.click(".ms-geo")
    page.wait_for_selector(".ms-pin.here", timeout=10000)
    settle()
    print("geo ->", at()[:2])
    page.click(".ms-card-close")
    if page.locator(".ms-pin").count():
        errors.append("pin not removed after closing the card")

    # 7) clearing while remote searches are in flight must not bring results back
    box.fill("大阪城")
    page.keyboard.press("Enter")
    page.click(".ms-clear")
    page.wait_for_timeout(4000)
    if page.locator(".ms-pin").count() or page.is_visible(".ms-card") or box.input_value():
        errors.append("stale remote result reappeared after clearing")

    # 8) charger results follow the panel's network toggles
    net = ctx.new_page()
    net.goto(BASE + "#mode=B&tesla=1&flash=0")
    net.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    nbox = net.locator("#map-search-input")
    nbox.fill("wash")
    net.wait_for_timeout(400)
    if net.locator(".ms-list li.kind-flash").count():
        errors.append("FLASH chargers suggested while FLASH is off")
    nbox.fill("札幌市")
    net.wait_for_selector(".ms-list li.kind-muni", timeout=5000)
    net.keyboard.press("Enter")
    net.wait_for_selector(".ms-card", timeout=5000)
    card_txt = net.inner_text(".ms-card")
    if net.locator(".ms-near-list i.flash").count() or "FLASH" in card_txt:
        errors.append("FLASH shown in nearest list while FLASH is off")
    net.click("label.network-option.flash")
    net.wait_for_timeout(500)
    if "FLASH" not in net.inner_text(".ms-card"):
        errors.append("card did not refresh after enabling FLASH")
    nbox.fill("wash")
    net.wait_for_selector(".ms-list li.kind-flash", timeout=5000)
    print("network filter: ok")

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile.goto(BASE)
    mobile.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    mobile.fill("#map-search-input", "札幌")
    mobile.wait_for_selector(".ms-list li[data-i]", timeout=5000)
    mobile.screenshot(path=str(OUT / "search_mobile.png"))
    browser.close()

print("errors:", errors or "none")
sys.exit(1 if errors else 0)
