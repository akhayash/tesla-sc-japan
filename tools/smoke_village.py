"""Headless smoke test for village.html (split storybook + prefecture map)."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/").rstrip("/") + "/village.html"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)
errors: list[str] = []


def scenes(page) -> list[str]:
    seen = []
    for sec in page.query_selector_all(".page"):
        sec.scroll_into_view_if_needed()
        page.evaluate("window.scrollBy(0, -150)")
        page.wait_for_timeout(700)
        seen.append(page.inner_text("#atlas-title"))
    return seen


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    for label, vp in (("desktop", {"width": 1440, "height": 900}), ("mobile", {"width": 390, "height": 844})):
        page = browser.new_page(viewport=vp)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.goto(BASE)
        page.wait_for_selector(".page", timeout=60000)
        titles = scenes(page)
        print(label, "national scenes:", len(titles), [t[:8] for t in titles])
        if len(set(titles)) < 6:
            errors.append(f"{label}: map did not follow the story ({titles})")
        page.click(".pref-chips button[data-pref='01']")
        page.wait_for_timeout(1500)
        if "北海道" not in page.inner_text("#title") or "pref=01" not in page.url:
            errors.append(f"{label}: prefecture version did not open")
        print(label, "pref scenes:", [t[:10] for t in scenes(page)])
        page.screenshot(path=str(OUT / f"village_{label}.png"))
        page.select_option("#pref-select", "")
        page.wait_for_timeout(800)
        if "日本" not in page.inner_text("#title"):
            errors.append(f"{label}: could not return to the national version")
        page.close()
    browser.close()

print("errors:", errors or "none")
sys.exit(1 if errors else 0)
