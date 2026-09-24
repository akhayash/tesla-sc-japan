"""Headless smoke test for the 災害リスク tab (mode C) of the main map."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/").rstrip("/") + "/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)

errors: list[str] = []


def watch(page):
    page.on("pageerror", lambda e: errors.append(str(e)))
    # Hazard tiles legitimately return 404 where no hazard area exists.
    page.on("console", lambda m: m.type == "error" and "404" not in m.text and errors.append(m.text))


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    watch(page)
    page.goto(BASE)
    page.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    if page.is_visible("#hazard-card"):
        errors.append("hazard card visible outside the hazard tab")
    page.click(".tabs button[data-mode=C]")
    page.wait_for_function("document.querySelector('#hz-summary').innerText.includes('か所')", timeout=30000)
    print("default:", page.inner_text("#hz-summary").replace("\n", " "))
    if "hz=flood" not in page.evaluate("location.hash"):
        errors.append("flood layer not enabled by default in hazard tab")
    for layer in ("tsunami", "steep", "avalanche"):
        page.click(f"[data-hz={layer}]")
    page.wait_for_timeout(800)
    print("multi:", page.inner_text("#hz-summary").replace("\n", " "))
    page.screenshot(path=str(OUT / "hazard_tab.png"))
    page.click("[data-hzkey=hzPal] button[data-v=official]")
    page.wait_for_timeout(1500)
    page.click("[data-hzkey=hzPal] button[data-v=vis]")
    page.evaluate("document.querySelector('#hz-list-wrap').open = true")
    if page.locator("#hz-list li").count():
        page.click("#hz-list li")
        page.wait_for_selector(".maplibregl-popup-content .hz-pop", timeout=15000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / "hazard_tab_zoom.png"))
        print("popup:", page.inner_text(".hz-pop")[:160].replace("\n", " "))
    else:
        errors.append("hazard list is empty")
    page.click(".tabs button[data-mode=B]")
    page.wait_for_timeout(500)
    if page.is_visible("#hazard-card"):
        errors.append("hazard card still visible after leaving the tab")

    legacy = browser.new_page()
    watch(legacy)
    legacy.goto(BASE + "hazard.html")
    legacy.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    if "mode=C" not in legacy.url:
        errors.append(f"legacy hazard.html did not redirect: {legacy.url}")
    bad = browser.new_page()
    watch(bad)
    bad.goto(BASE + "#mode=C&hz=bogus,steep&hzOp=999&hzPal=x")
    bad.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    h = bad.evaluate("location.hash")
    if "bogus" in h or "hzOp=999" in h:
        errors.append(f"invalid hazard hash values were not rejected: {h}")
    browser.close()

print("errors:", errors or "none")
sys.exit(1 if errors else 0)
