"""Headless smoke test for the on-map basemap switcher."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/").rstrip("/") + "/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)
errors: list[str] = []


def base(page):
    return page.evaluate("new URLSearchParams(location.hash.slice(1)).get('base')")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and "404" not in m.text and errors.append(m.text))
    page.goto(BASE + "#at=139.70,35.60,11")
    page.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    if page.locator("#basemap").count():
        errors.append("old panel basemap select still present")
    main = page.locator(".base-switcher .bs-main")
    print("main label:", main.inner_text())
    main.click()
    page.wait_for_timeout(1200)
    if base(page) != "photo":
        errors.append(f"one-click switch to aerial failed: {base(page)}")
    print("after click:", base(page), "| main label:", main.inner_text())
    page.hover(".base-switcher")
    page.wait_for_selector(".bs-panel button[data-id=std]", state="visible", timeout=3000)
    page.screenshot(path=str(OUT / "basemap_open.png"))
    page.click(".bs-panel button[data-id=std]")
    page.wait_for_timeout(800)
    if base(page) != "std":
        errors.append(f"panel choice failed: {base(page)}")
    page.mouse.move(900, 400)
    page.wait_for_timeout(300)
    if page.is_visible(".bs-panel"):
        errors.append("panel did not close")
    page.reload()
    page.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    if page.locator(".bs-panel button.active").get_attribute("data-id") != "std":
        errors.append("basemap not restored from URL")

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    mobile.on("pageerror", lambda e: errors.append(str(e)))
    mobile.goto(BASE)
    mobile.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
    mobile.tap(".bs-more")
    mobile.wait_for_selector(".bs-panel button[data-id=blank]", state="visible", timeout=3000)
    mobile.screenshot(path=str(OUT / "basemap_mobile.png"))
    mobile.tap(".bs-panel button[data-id=blank]")
    mobile.wait_for_timeout(500)
    if base(mobile) != "blank":
        errors.append(f"mobile choice failed: {base(mobile)}")
    browser.close()

print("errors:", errors or "none")
sys.exit(1 if errors else 0)
