"""Headless smoke test: load the map in each mode and save screenshots."""
from __future__ import annotations

import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)

CASES = {
    "default": "",
    "a_pref": "#mode=A&unit=pref&metric=p&tesla=1&flash=0",
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
    "route_here": "#mode=B&layer=none&at=138.2,34.9,10",
    "route_search": "#mode=B&layer=none",
    "route_via": "#mode=B&layer=none&ro=ic~137.78770,34.74793~浜松ＩＣ&rd=ic~138.39152,34.94767~静岡ＩＣ&rv=place~138.30248,34.88001~Yaizu~30&rt=2026-09-29T10:00",
    "route_visit": "#mode=B&layer=none&tesla=1&flash=1&ro=place~135.17947,35.06208~A&rd=place~135.17439,35.28213~B&rv=place~135.10114,35.16890~丹波市役所春日庁舎~30",
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
# Synthetic route through 春日JCT・IC (a 賢い料金 IC) for the 道の駅-visit scenario.
KASUGA = {"name": "k", "lng": 135.11638, "lat": 35.16452}
TAMBA_BASE = dict(FAKE_ROUTE, km=32.6, min=26, etc=700,
                  line=[[135.1795, 35.0621], [135.17, 35.10], [135.12, 35.16], [135.15, 35.22], [135.1744, 35.2821]],
                  tollSpans=[[1, 4]],
                  tolls=[{"section": 0, "system": "NEXCO", "etc": 700, "cash": None, "entry": {"name": "a", "lng": 135.1789, "lat": 35.0652}, "exit": {"name": "b", "lng": 135.1769, "lat": 35.2845}}],
                  used={"o": [35.06208, 135.17947], "d": [35.28213, 135.17439]})
route_requests: list[str] = []
route_status = {"code": 200}


def fake_relay(route):
    import json as _json
    route_requests.append(route.request.url)
    if route_status["code"] != 200:
        route.fulfill(status=route_status["code"], content_type="application/json", body=_json.dumps({"error": route_status.get("error", "rate_limited")}),
                      headers={"Access-Control-Allow-Origin": "*"})
        return
    url = route.request.url.replace("%2C", ",").replace("%7C", "|")
    if "o=35.06" in url:
        m = re.search(r"[?&]v=([^&]*)", url)
        if m:
            stops = m.group(1).split("|")
            n = len(stops) + 1
            sections = [{"km": 5, "min": 5, "etc": 0, "wait": int(x.split(",")[2])} for x in stops] + [{"km": 20, "min": 20, "etc": 0, "wait": 0}]
            body = dict(TAMBA_BASE, km=37.8, min=26 + 20 + sum(int(x.split(",")[2]) for x in stops), etc=820, sections=sections,
                        tolls=[{"section": 0, "system": "NEXCO", "etc": 380, "cash": None, "entry": None, "exit": KASUGA},
                               {"section": n - 1, "system": "NEXCO", "etc": 440, "cash": None, "entry": KASUGA, "exit": None}])
        else:
            body = TAMBA_BASE
        route.fulfill(status=200, content_type="application/json", body=_json.dumps(body), headers={"Access-Control-Allow-Origin": "*"})
        return
    if "v=" in route.request.url:
        detour = dict(FAKE_ROUTE, etc=2170, km=73.1, min=96,
                      line=FAKE_ROUTE["line"][:3] + [[138.3025, 34.8800]] + FAKE_ROUTE["line"][3:],
                      sections=[{"km": 40.0, "min": 30, "etc": 1000, "wait": 30}, {"km": 33.1, "min": 36, "etc": 1170, "wait": 0}],
                      tolls=[{"section": 0, "system": "NEXCO", "etc": 1000, "cash": None, "entry": {"name": "x", "lng": 137.789, "lat": 34.745}, "exit": {"name": "yz", "lng": 138.2735, "lat": 34.8743}},
                             {"section": 1, "system": "NEXCO", "etc": 1170, "cash": None, "entry": {"name": "yz", "lng": 138.2735, "lat": 34.8743}, "exit": {"name": "y", "lng": 138.3915, "lat": 34.9475}}])
        route.fulfill(status=200, content_type="application/json", body=_json.dumps(detour), headers={"Access-Control-Allow-Origin": "*"})
        return
    main = dict(FAKE_ROUTE)
    if "alt=1" in route.request.url:
        main["alternatives"] = [dict(FAKE_ROUTE, km=75.5, min=56, etc=2280, line=[[137.7877, 34.7479], [137.9, 34.9], [138.1, 34.95], [138.39, 34.947]], tollSpans=[[0, 3]])]
    route.fulfill(status=200, content_type="application/json", body=_json.dumps(main), headers={"Access-Control-Allow-Origin": "*"})

errors: list[str] = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 900}, geolocation={"latitude": 34.75, "longitude": 137.80}, permissions=["geolocation", "clipboard-read", "clipboard-write"])
    page.on("console", lambda m: m.type == "error" and "status of 429" not in m.text and "status of 503" not in m.text and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/api/route?*", fake_relay)
    page.route("**/api/usage", lambda r: r.fulfill(status=200, content_type="application/json", body='{"month":"2026-09","used":412,"cap":2450,"todayLeft":79,"paused":false}', headers={"Access-Control-Allow-Origin": "*"}))
    for name, h in CASES.items():
        page.goto("about:blank")
        page.goto(BASE + h)
        page.wait_for_selector("#loading[hidden]", state="attached", timeout=60000)
        if name == "default" and ("panel-collapsed" not in (page.get_attribute("body", "class") or "") or not page.is_checked("#use-flash") or "status=a" not in page.url):
            errors.append("side panel should start collapsed and FLASH should be on by default")
        if name == "default":
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / "default_collapsed.png"))
        if "panel-collapsed" in (page.get_attribute("body", "class") or ""):
            page.click("#panel-toggle")
            page.wait_for_timeout(250)
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
            if page.locator("[data-route-alt]").count() != 2 or "alt=1" not in route_requests[-1]:
                errors.append("alternative routes were not offered")
            else:
                page.click('[data-route-alt="1"]')
                page.wait_for_timeout(300)
                if "2,280円" not in page.inner_text(".route-summary") or page.get_attribute('[data-route-alt="1"]', "aria-selected") != "true":
                    errors.append("switching to the alternative route did not update the card")
                page.click('[data-route-alt="0"]')
                page.wait_for_timeout(300)
            page.click("[data-route-share]")
            page.wait_for_timeout(300)
            if "コピーしました" not in page.inner_text("[data-route-share]"):
                errors.append("route share button did not copy the link")
            if not page.locator("[data-route-insert]").count():
                errors.append("add-waypoint button missing")
            page.click("[data-route-close]")
            if page.is_visible(".route-card") or not page.is_visible(".ms-route") or "ro=" in page.url:
                errors.append("closing the route did not return to the place search only")
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
            route_status.update(code=429, error="rate_limited")
            page.click("[data-route-swap]")
            page.wait_for_selector(".route-error", timeout=10000)
            if "1分" not in page.inner_text(".route-error"):
                errors.append("rate-limit error message was not shown")
            route_status["code"] = 200
            page.click("[data-route-retry]")
            page.wait_for_selector(".route-summary", timeout=10000)
            page.screenshot(path=str(OUT / "route_point_done.png"))
            if page.inner_text(".route-note .route-usage") != "412/2,450" or "本日の残り 79回" not in (page.get_attribute(".route-usage", "title") or ""):
                errors.append("HERE usage was not shown next to the attribution")
            route_status.update(code=503, error="monthly_cap")
            page.click("[data-route-swap]")
            page.wait_for_selector(".route-error", timeout=10000)
            page.screenshot(path=str(OUT / "route_monthly_cap.png"))
            if "今月" not in page.inner_text(".route-error") or page.query_selector("[data-route-retry]") or not page.query_selector(".route-actions a[href*='google.com/maps']"):
                errors.append("monthly cap should show a final message with the Google Maps link and no retry")
            route_status.update(code=200, error="rate_limited")
        if name == "route_here":
            n0 = len(route_requests)
            page.mouse.click(1000, 400, button="right")
            page.wait_for_timeout(400)
            page.click(".maplibregl-popup-content [data-route-from-here]")
            page.wait_for_selector(".route-summary", timeout=10000)
            card = page.inner_text(".route-card")
            if "現在地" not in card or len(route_requests) != n0 + 1 or "o=34.75000%2C137.80000" not in route_requests[-1]:
                errors.append(f"'current location to here' did not route from the device location: {route_requests[-1:]}")
            if "ro=" in page.url or "rd=" not in page.url:
                errors.append("device location leaked into the URL (or destination was not kept)")
            page.click('[data-route-clear="o"]')
            page.click('[data-route-here="o"]')
            page.wait_for_selector(".route-summary", timeout=10000)
            if "現在地" not in page.inner_text(".route-card") or len(route_requests) > n0 + 2:
                errors.append("card 'current location' button did not restore the route")
            page.screenshot(path=str(OUT / "route_here.png"))
        if name == "default":
            if page.is_visible(".route-card") or not page.is_visible(".ms-route"):
                errors.append("only the place search (with a directions button) should be shown at first")
            page.click(".ms-route")
            page.wait_for_timeout(300)
            if not page.is_visible('.route-card.idle [data-route-q="o"]') or page.evaluate("document.activeElement?.dataset?.routeQ") != "o":
                errors.append("directions button did not open the route card with the start field focused")
            page.screenshot(path=str(OUT / "default_route_open.png"))
        if name == "default" and page.inner_text(".route-card.idle .route-usage") != "412/2,450":
            errors.append("HERE usage was not shown on the idle route card")
        if name == "route_search":
            page.click(".ms-route")
            n0 = len(route_requests)
            page.fill('[data-route-q="o"]', "浜松IC")
            page.press('[data-route-q="o"]', "Enter")
            page.wait_for_timeout(600)
            if "浜松IC" not in page.inner_text(".route-card"):
                errors.append("exact search match did not set the origin")
            page.fill('[data-route-q="d"]', "静岡")
            page.wait_for_selector('[data-route-sug="d"] li[data-i]', timeout=5000)
            labels = page.locator('[data-route-sug="d"] li[data-i] b').all_inner_texts()
            target = next((i for i, l in enumerate(labels) if l == "静岡IC"), None)
            if target is None:
                errors.append(f"destination suggestions missing 静岡IC: {labels}")
            else:
                page.locator('[data-route-sug="d"] li[data-i]').nth(target).click()
                page.wait_for_selector(".route-summary", timeout=10000)
                last = route_requests[-1].replace("%7E", "~") if len(route_requests) > n0 else ""
                if last.count("~") != 2:
                    errors.append(f"searched ICs were not sent as toll-gate endpoints: {last}")
            page.click('[data-route-edit="d"]')
            page.wait_for_timeout(200)
            if page.input_value('[data-route-q="d"]') != "静岡IC":
                errors.append("clicking a set place did not open it for editing")
            page.fill('[data-route-q="d"]', "浜松IC")
            page.press('[data-route-q="d"]', "Escape")
            page.wait_for_timeout(300)
            if "静岡IC" not in page.inner_text(".route-card"):
                errors.append("Escape did not keep the previous place")
            page.click('[data-route-edit="d"]')
            page.fill('[data-route-q="d"]', "豊川IC")
            page.press('[data-route-q="d"]', "Enter")
            page.wait_for_timeout(800)
            if "豊川IC" not in page.inner_text(".route-card"):
                errors.append("editing a set place did not replace it")
            page.screenshot(path=str(OUT / "route_search.png"))
        if name == "route_via":
            card = page.inner_text(".route-card")
            if "Yaizu" not in card or "+160円" not in card or not page.locator(".route-io .chip").count():
                errors.append(f"waypoint fare split was not shown: {card[:300]!r}")
            tabs = page.locator("[data-route-alt]").all_inner_texts()
            if len(tabs) != 2 or "直行" not in tabs[0] or "寄り道" not in tabs[1]:
                errors.append(f"waypoint route should offer 直行 / 寄り道 tabs: {tabs}")
            else:
                page.click('[data-route-alt="0"]')
                page.wait_for_timeout(300)
                if "2,010円" not in page.inner_text(".route-summary") or page.locator(".route-io .chip").count():
                    errors.append("直行 tab did not show the direct route")
                page.click('[data-route-alt="1"]')
                page.wait_for_timeout(300)
            if not any("v=" in u and "Yaizu" not in u for u in route_requests[-2:]):
                errors.append("waypoint request was not sent")
            if "rv=" not in page.url:
                errors.append("waypoints were not kept in the URL")
            page.select_option('[data-route-stop="0"]', "15")
            page.wait_for_timeout(800)
            if ",15" not in route_requests[-1].replace("%2C", ","):
                errors.append("changing the stop time did not recompute")
            page.click('[data-route-remove="0"]')
            page.wait_for_selector(".route-summary", timeout=10000)
            if "rv=" in page.url or page.locator(".route-io").count():
                errors.append("removing the waypoint did not return to the direct route")
            page.click('[data-route-insert="0"]')
            page.fill('[data-route-q="v0"]', "Yaizu")
            page.wait_for_selector('[data-route-sug="v0"] li[data-i]', timeout=5000)
            page.locator('[data-route-sug="v0"] li[data-i]').first.click()
            page.wait_for_selector(".route-io", timeout=10000)
            page.click('[data-route-insert="0"]')
            if not page.locator('.route-ep.via:first-of-type [data-route-q="v0"], [data-route-q="v0"]').count() or page.locator(".route-ep.via").count() != 2:
                errors.append("insert button did not add an empty stop at that position")
            page.screenshot(path=str(OUT / "route_via.png"))
        if name == "route_visit":
            if not page.locator("[data-route-add-station]").count() or "丹波おばあちゃんの里" not in page.inner_text("[data-route-add-station]"):
                errors.append("賢い料金 道の駅 hint was not offered for a charger near 春日IC")
            else:
                page.click("[data-route-add-station]")
                page.wait_for_selector(".route-io .chip.smart", timeout=10000)
                txt = page.inner_text(".route-card")
                last = route_requests[-1].replace("%7C", "|").replace("%2C", ",")
                if "±0円" not in txt or "賢い料金" not in txt:
                    errors.append(f"賢い料金 was not applied after adding the 道の駅: {txt[:400]!r}")
                if not any(u.replace("%7C", "|").count("|") >= 3 for u in route_requests[-3:]):
                    errors.append("IC pins were not added around the 道の駅 stretch")
                page.screenshot(path=str(OUT / "route_visit.png"))
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
