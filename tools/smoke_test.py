"""Headless smoke test: load the map in each mode and save screenshots."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)

CASES = {
    "default": "",
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
    "share_charger": "#mode=B&layer=none&at=139.63,35.46,13&sel=c:6564",
    "b_ratio_bw3": "#mode=B&layer=ratio&bw=3&at=139.7,35.68,10",
    "b_sc_bw20": "#mode=B&layer=sc&bw=20",
    "b_near": "#mode=B&layer=near&tesla=1&flash=1&at=139.7,35.68,10",
    "route_ic": "#mode=B&layer=none&ro=ic~137.78770,34.74793~浜松ＩＣ&rd=ic~138.39152,34.94767~静岡ＩＣ&rt=2026-09-29T10:00",
    "route_point": "#mode=B&layer=none&at=137.9,34.85,10",
}

# Synthetic relay responses (the real relay calls HERE; smoke tests never do).
FAKE_ROUTE = {
    "km": 70.0, "min": 50, "etc": 2010, "cash": None, "hasToll": True,
    "line": [[137.7877, 34.7479], [137.80, 34.75], [138.0, 34.80], [138.30, 34.878], [138.39, 34.947]],
    "tollSpans": [[1, 4]],
    "tolls": [{"section": 0, "system": "NEXCO", "etc": 2010, "cash": None,
               "entry": {"name": "x", "lng": 137.789, "lat": 34.745}, "exit": {"name": "y", "lng": 138.3915, "lat": 34.9475}}],
    "sections": [{"km": 70.0, "min": 50, "etc": 2010, "wait": 0}],
    "used": {"o": [34.74, 137.78], "d": [34.95, 138.39]}, "departure": "2026-09-29T10:00:00+09:00", "attempts": 1, "attribution": "HERE",
}
route_requests: list[str] = []
route_status = {"code": 200}


def fake_relay(route):
    import json as _json
    route_requests.append(route.request.url)
    if route_status["code"] != 200:
        route.fulfill(status=route_status["code"], content_type="application/json", body=_json.dumps({"error": "rate_limited"}),
                      headers={"Access-Control-Allow-Origin": "*"})
        return
    if "v=" in route.request.url:
        detour = dict(FAKE_ROUTE, etc=2170, km=73.1, min=96,
                      line=FAKE_ROUTE["line"][:3] + [[138.3025, 34.8800]] + FAKE_ROUTE["line"][3:],
                      sections=[{"km": 40.0, "min": 30, "etc": 1000, "wait": 30}, {"km": 33.1, "min": 36, "etc": 1170, "wait": 0}],
                      tolls=[{"section": 0, "system": "NEXCO", "etc": 1000, "cash": None, "entry": {"name": "x", "lng": 137.789, "lat": 34.745}, "exit": None},
                             {"section": 1, "system": "NEXCO", "etc": 1170, "cash": None, "entry": None, "exit": {"name": "y", "lng": 138.3915, "lat": 34.9475}}])
        route.fulfill(status=200, content_type="application/json", body=_json.dumps(detour), headers={"Access-Control-Allow-Origin": "*"})
        return
    route.fulfill(status=200, content_type="application/json", body=_json.dumps(FAKE_ROUTE), headers={"Access-Control-Allow-Origin": "*"})

errors: list[str] = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.on("console", lambda m: m.type == "error" and "status of 429" not in m.text and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/api/route?*", fake_relay)
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
            if "名称" not in page.inner_text(".key-row ~ .field-note"):
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
            if page.get_attribute("#smart-toll-toggle", "aria-pressed") != "true" or not page.is_visible("#toll-key"):
                errors.append("smart toll layer should be on by default with its key visible")
            page.click("#smart-toll-toggle")
            if page.get_attribute("#smart-toll-toggle", "aria-pressed") != "false" or "smartToll=0" not in page.url or page.is_visible("#toll-key"):
                errors.append("smart toll toggle did not update state")
            page.click("#smart-toll-toggle")
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
        if name == "default" and (page.locator('[data-key="layer"] button.active').count() or "layer=none" not in page.url):
            errors.append("mesh layer should be off by default")
        if name == "share_charger":
            popup = page.locator(".maplibregl-popup-content")
            if not popup.count() or not popup.locator("[data-share]").count():
                errors.append("shared charger link did not reopen its popup with a share button")
            elif "sel=c%3A6564" not in page.url and "sel=c:6564" not in page.url:
                errors.append("selected place was not kept in the URL")
        if name == "b_ratio_bw3":
            if page.inner_text("#bw-value") != "σ=3km" or "0.5 未満" not in info["summary"]:
                errors.append("σ=3km ratio did not render")
            page.eval_on_selector("#bw-slider", "el => { el.value = '6'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }")
            page.wait_for_timeout(2000)
            if "bw=20" not in page.url or page.inner_text("#bw-value") != "σ=20km" or "σ=20km" not in page.text_content("#metric-note"):
                errors.append("bandwidth slider did not update state")
        if name == "b_sc_bw20" and "σ=20km" not in page.text_content("#metric-note"):
            errors.append("σ=20km charger density did not render")
        if name == "b_near":
            if "10km 以上" not in info["summary"] or "40km 以上" not in info["legend"]:
                errors.append("nearest-charger layer did not render its legend and summary")
            if page.is_visible("#ctl-bw") or page.is_visible("#ctl-weight") or not page.is_visible("#ctl-pop-alpha"):
                errors.append("nearest-charger layer showed the wrong controls")
            page.mouse.move(1000, 450)
            page.wait_for_timeout(500)
            if "最寄り" not in page.inner_text("#tooltip"):
                errors.append("nearest-charger tooltip did not appear")
        if name == "route_ic":
            card = page.inner_text(".route-card") if page.locator(".route-card").count() else ""
            if "2,010円" not in card or "浜松IC" not in card or "静岡IC" not in card or "ドラぷら" not in card:
                errors.append("IC-to-IC route card did not render the fare")
            last = route_requests[-1].replace("%7E", "~") if route_requests else ""
            if "~" not in last or "t=2026-09-29T10%3A00" not in last:
                errors.append(f"IC route request did not use toll-gate points and departure time: {route_requests[-1:]}")
            if "ro=" not in page.url or "rd=" not in page.url:
                errors.append("route endpoints were not kept in the URL")
            names = page.locator(".route-cand .name").all_inner_texts()
            if "Yaizu, Japan" not in names:
                errors.append(f"off-expressway charger candidates were not listed: {names}")
            else:
                i = names.index("Yaizu, Japan")
                page.locator(".route-cands li").nth(i).locator("[data-route-detour]").click()
                page.wait_for_selector(".route-det-result", timeout=10000)
                res = page.inner_text(".route-cands li:nth-child(%d)" % (i + 1))
                if "+160円" not in res or "+16分" not in res or "v=" not in route_requests[-1]:
                    errors.append(f"temporary-exit fare difference was wrong: {res!r}")
                page.screenshot(path=str(OUT / "route_detour.png"))
            page.click("[data-route-close]")
            if page.is_visible(".route-card") or "ro=" in page.url:
                errors.append("closing the route card did not clear the route")
        if name == "route_point":
            n0 = len(route_requests)
            page.mouse.click(700, 450, button="right")
            page.wait_for_timeout(400)
            page.click('.maplibregl-popup-content [data-route-set="o"]')
            page.mouse.click(1100, 350, button="right")
            page.wait_for_timeout(400)
            page.click('.maplibregl-popup-content [data-route-set="d"]')
            page.wait_for_selector(".route-summary", timeout=10000)
            if len(route_requests) != n0 + 1 or "~" in route_requests[-1].replace("%7E", "~"):
                errors.append("map-point route did not send a single plain-point request")
            if "place~" not in page.url.replace("%7E", "~"):
                errors.append("map-point endpoints were not kept in the URL")
            route_status["code"] = 429
            page.click("[data-route-swap]")
            page.wait_for_selector(".route-error", timeout=10000)
            if "1分" not in page.inner_text(".route-error"):
                errors.append("rate-limit error message was not shown")
            route_status["code"] = 200
            page.click("[data-route-retry]")
            page.wait_for_selector(".route-summary", timeout=10000)
            page.screenshot(path=str(OUT / "route_point_done.png"))
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
