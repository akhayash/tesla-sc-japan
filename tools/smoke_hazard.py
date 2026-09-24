"""Headless smoke test for hazard.html (layer toggles, list click, hash validation)."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/").rstrip("/") + "/hazard.html"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)

errors: list[str] = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    # Hazard tiles legitimately return 404 where no hazard area exists.
    page.on("console", lambda m: m.type == "error" and "404" not in m.text and errors.append(m.text))
    page.goto(BASE)
    page.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    page.wait_for_timeout(2000)
    page.screenshot(path=str(OUT / "hazard_default.png"))
    print("default:", page.inner_text("#hz-summary").replace("\n", " "))
    for layer in ("tsunami", "debris", "avalanche"):
        page.check(f"[data-layer={layer}]")
    page.wait_for_timeout(500)
    print("multi:", page.inner_text("#hz-summary").replace("\n", " "))
    if page.locator("#hz-list li[data-id]").count():
        page.click("#hz-list li[data-id]")
        page.wait_for_timeout(3500)
        page.screenshot(path=str(OUT / "hazard_zoom.png"))
        print("popup:", page.inner_text(".maplibregl-popup-content")[:160].replace("\n", " "))
    else:
        errors.append("hazard list is empty")
    bad = browser.new_page()
    bad.on("pageerror", lambda e: errors.append(str(e)))
    bad.goto(BASE + "#layers=bogus,steep&op=999&status=x&minLevel=9")
    bad.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    if "bogus" in bad.evaluate("location.hash"):
        errors.append("invalid hash values were not rejected")
    browser.close()

print("errors:", errors or "none")
sys.exit(1 if errors else 0)
