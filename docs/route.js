// Route and expressway fare between a start, a goal and up to 3 waypoints (IC, POI, charger or any map point).
// Routing and tolls come from HERE through the relay in api/ (the key stays server-side).
// Results are kept only in memory for the current view (HERE terms forbid caching/sharing results).
//
// Leaving the expressway at a waypoint (e.g. to charge) splits the fare in two; HERE's per-section
// tolls already reflect that. 賢い料金 (ETC2.0): when the designated 道の駅 is one of the waypoints
// in the same off-expressway stretch and the car returns to the same IC within the time limit, the
// stretch is charged as if the car had not left, so that stretch's extra fare is removed.
(() => {
  'use strict';

  const API = String(window.ROUTE_API || '').replace(/\/$/, '');
  const IC_CODES = new Set([2941, 2945]);
  // IC, smart IC, or a combined junction such as 「春日ＪＣＴ・ＩＣ」
  const isIc = (code, name) => IC_CODES.has(Number(code)) || (Number(code) === 2942 && /IC/.test(String(name || '').normalize('NFKC')));
  const MAX_NAME = 40;
  const MAX_VIAS = 3;
  const STOP_OPTIONS = [0, 5, 15, 30, 45, 60, 90];
  const AT_STATION_KM = 0.3;
  const SMART_GROUP_KM = 15;
  const OFFROAD_KMH = 30;

  const S = {
    o: null, d: null, vias: [], t: '',
    direct: null, directKey: '', result: null, analysis: null, routes: [], routeIdx: 0,
    loading: false, error: '', seq: 0, q: {}, locating: null, collapsed: false, smartPairs: null,
  };
  // read before app.js rewrites the hash on the first map move
  const initialHash = new URLSearchParams(location.hash.slice(1));
  let map = null, popup = null, ctx = null, card = null;
  let gates = null, gatesPromise = null;
  const markers = {};

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (v) => (v == null ? '—' : `${new Intl.NumberFormat('ja-JP').format(v)}円`);
  const signedYen = (v) => (v > 0 ? `+${yen(v)}` : v < 0 ? `−${yen(-v)}` : '±0円');
  const km = (a, b) => {
    const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.57);
  };
  const baseName = (name) => String(name || '').normalize('NFKC').replace(/JCT[・/]?/i, '').replace(/(スマートIC|SIC|IC)$/i, '').trim();
  const nfkc = (s) => String(s || '').normalize('NFKC');
  const f5 = (x) => Number(x).toFixed(5);
  const inJapan = (ll) => ll[0] > 122 && ll[0] < 154 && ll[1] > 20 && ll[1] < 46;

  // ---------- place categories (icon + label in the panel) ----------
  const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
  const CAT = {
    tesla: { label: 'テスラSC', cls: 'tesla', icon: BOLT },
    flash: { label: 'FLASH', cls: 'flash', icon: BOLT },
    michinoeki: { label: '道の駅', cls: 'michi', icon: '駅' },
    ic: { label: 'IC', cls: 'ic', icon: 'IC' },
    sa: { label: 'SA/PA', cls: 'sa', icon: 'P' },
    mall: { label: 'モール', cls: 'mall', icon: 'M' },
    here: { label: '現在地', cls: 'here', icon: '◎' },
  };
  const CAT_KEYS = Object.keys(CAT);
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    swap: svg('<path d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3"/>'),
    collapse: svg('<path d="m6 15 6-6 6 6"/>'),
    expand: svg('<path d="m6 9 6 6 6-6"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  };
  const catIcon = (cat) => (CAT[cat] ? `<span class="route-cat ${CAT[cat].cls}" title="${CAT[cat].label}">${CAT[cat].icon}</span>` : '');
  function displayName(ep) {
    const n = nfkc(ep.name);
    return ep.cat === 'tesla' || ep.cat === 'flash' ? n.replace(/, Japan\b/, '') : n;
  }
  /** Where a charger is (the 道の駅 / SA / mall it sits in), shown under its name. */
  function describe(ep) {
    if (ep.cat !== 'tesla' && ep.cat !== 'flash') return;
    const st = stationPair(ep.ll);
    if (st) { ep.sub = `道の駅 ${st.station}内`; return; }
    Promise.resolve(window.MapSearch?.loadPoi?.()).then(() => {
      const near = window.MapSearch?.nearest?.(ep.ll, ['michinoeki', 'sa', 'mall'], 0.35);
      if (!near) return;
      ep.sub = `${near.kind === 'michinoeki' && !/^道の駅/.test(near.label) ? '道の駅 ' : ''}${near.label}内`;
      renderCard();
    });
  }

  // ---------- roles: 'o', 'd', 'v0'..'v2' ----------
  const viaIndex = (role) => (/^v\d$/.test(role) ? Number(role.slice(1)) : -1);
  function epOf(role) {
    if (role === 'o') return S.o;
    if (role === 'd') return S.d;
    const v = S.vias[viaIndex(role)];
    return v && !v.empty ? v : null;
  }
  const realVias = () => S.vias.filter((v) => !v.empty);

  // ---------- IC gates ----------
  function loadGates() {
    gatesPromise ??= fetch('data/ic_gates.json', { cache: 'no-cache' })
      .then((r) => r.json())
      .then((j) => { gates = j.ics; return gates; })
      .catch(() => { gates = []; return gates; });
    return gatesPromise;
  }
  function gateFor(name, ll) {
    let best = null, bestD = Infinity;
    const key = baseName(name);
    for (const g of gates || []) {
      const d = km([g[1], g[2]], ll);
      if (baseName(g[0]) === key && d < 3 && d < bestD) { best = g; bestD = d; }
    }
    return best ? { approach: [best[5], best[6]], gate: [best[3], best[4]] } : null;
  }
  function apiParam(ep) {
    if (ep.gate) return `${f5(ep.gate.approach[1])},${f5(ep.gate.approach[0])}~${f5(ep.gate.gate[1])},${f5(ep.gate.gate[0])}`;
    return `${f5(ep.ll[1])},${f5(ep.ll[0])}`;
  }
  async function withGate(ep) {
    if (ep.kind !== 'ic') return ep;
    await loadGates();
    return { ...ep, gate: gateFor(ep.name, ep.ll) };
  }
  let smartPromise = null;
  function loadSmartToll() {
    smartPromise ??= fetch('data/smart_toll.json', { cache: 'no-cache' }).then((r) => r.json()).then((j) => j.pairs || []).catch(() => []);
    return smartPromise;
  }
  const smartLimit = (pr) => pr.minutes || 120;
  // EV路外充電 needs charging at the 道の駅's own charger, so only 賢い料金 pairs apply to SC/FLASH stops
  const stationPair = (ll) => (S.smartPairs || []).find((pr) => pr.kind !== 'ev' && km(pr.station_coords, ll) <= AT_STATION_KM) || null;

  // ---------- hash encoding ----------
  const cleanName = (s) => String(s || '').replace(/[~|]/g, ' ').slice(0, MAX_NAME);
  function encodeEp(ep, stop = '') {
    return `${ep.kind}~${f5(ep.ll[0])},${f5(ep.ll[1])}~${cleanName(ep.name)}~${stop}~${CAT[ep.cat] ? ep.cat : ''}`;
  }
  function decodeEp(str) {
    const m = /^(ic|place)~(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)~([^~|]{0,40})(?:~(\d{0,2}))?(?:~([a-z]{0,12}))?$/.exec(str || '');
    if (!m) return null;
    const ll = [Number(m[2]), Number(m[3])];
    if (!inJapan(ll)) return null;
    const ep = { kind: m[1], ll, name: m[4] || '選択した地点' };
    if (m[5] && STOP_OPTIONS.includes(Number(m[5]))) ep.stop = Number(m[5]);
    if (CAT_KEYS.includes(m[6])) ep.cat = m[6];
    else if (ep.kind === 'ic') ep.cat = 'ic';
    return ep;
  }

  // ---------- public helpers for popups ----------
  const LOCATE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="7" fill="none"/></svg>';
  /** stop: default stop minutes when used as a waypoint (charger 30, 道の駅 5). */
  function buttonsHtml({ kind = 'place', name, ll, stop = 0, cat = '' }) {
    if (!API || !ll) return '';
    const attrs = `data-kind="${esc(kind)}" data-name="${esc(cleanName(name))}" data-ll="${f5(ll[0])},${f5(ll[1])}" data-stop="${Number(stop) || 0}" data-cat="${CAT[cat] ? cat : kind === 'ic' ? 'ic' : ''}"`;
    return `<div class="route-set" aria-label="経路・料金">
      <button type="button" data-route-set="o" ${attrs}><b>S</b>ここから</button>
      <button type="button" data-route-set="v" ${attrs} title="経路の途中に立ち寄る"><b class="v">+</b>経由地</button>
      <button type="button" data-route-set="d" ${attrs}><b>G</b>ここまで</button>
      ${navigator.geolocation ? `<button type="button" class="route-from-here" data-route-from-here ${attrs}>${LOCATE_ICON}現在地からここまで</button>` : ''}
    </div>`;
  }
  function facilityButtonsHtml(props, ll) {
    return isIc(props.code, props.name) ? buttonsHtml({ kind: 'ic', name: props.name, ll }) : '';
  }
  function epFromDataset(ds) {
    return {
      kind: ds.kind === 'ic' ? 'ic' : 'place',
      name: ds.name || '選択した地点',
      ll: ds.ll.split(',').map(Number),
      stop: Number(ds.stop) || 0,
      cat: CAT[ds.cat] ? ds.cat : '',
    };
  }

  // ---------- editing ----------
  function invalidate() {
    S.result = null;
    S.analysis = null;
    S.routes = [];
    S.routeIdx = 0;
    S.error = '';
  }
  async function setRole(role, ep) {
    const withG = await withGate(ep);
    describe(withG);
    if (role === 'o') S.o = withG;
    else if (role === 'd') S.d = withG;
    else {
      const i = viaIndex(role);
      const stop = STOP_OPTIONS.includes(ep.stop) ? ep.stop : 0;
      S.vias[i] = { ...withG, stop };
    }
  }
  async function setEndpoint(role, ep) {
    await setRole(role, ep);
    popup?.remove();
    changed();
  }
  async function addVia(ep, at = S.vias.length) {
    const empty = S.vias.findIndex((v) => v.empty);
    if (empty >= 0 && at === S.vias.length) at = empty;
    else if (S.vias.length >= MAX_VIAS) { S.error = `経由地は${MAX_VIAS}か所までです。`; renderCard(); return; }
    else S.vias.splice(at, 0, { empty: true });
    await setRole(`v${at}`, ep);
    popup?.remove();
    S.collapsed = false;
    changed();
  }
  function changed() {
    invalidate();
    ctx.writeHash();
    draw();
    renderCard();
    if (S.o && S.d) compute();
    else fitEndpoints();
  }

  // ---------- current location ----------
  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(Object.assign(new Error('unsupported'), { code: 'unsupported' })); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve([p.coords.longitude, p.coords.latitude]),
        reject,
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
      );
    });
  }
  /** Sets `role` to the device location; `other` (optional) is set as the opposite endpoint first. */
  async function useHere(role, other) {
    if (other) {
      await setRole(role === 'o' ? 'd' : 'o', other);
      invalidate();
      popup?.remove();
    }
    S.locating = role;
    S.error = '';
    draw();
    renderCard();
    try {
      const ll = await locate();
      if (!inJapan(ll)) throw Object.assign(new Error('outside'), { code: 'outside' });
      S.locating = null;
      await setEndpoint(role, { kind: 'place', name: '現在地', ll, here: true, cat: 'here' });
    } catch (e) {
      S.locating = null;
      S.error = e.code === 1 ? '位置情報の利用が許可されていません。ブラウザの設定を確認してください。'
        : e.code === 'outside' ? '現在地が日本国外のため計算できません。'
          : '現在地を取得できませんでした。';
      ctx.writeHash();
      draw();
      renderCard();
    }
  }

  // ---------- API ----------
  async function fetchRoute(q) {
    const res = await fetch(`${API}/route?${q}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || String(res.status)), { status: res.status, code: body.error });
    return body;
  }
  function errorText(e) {
    if (e.status === 429) return '短時間のリクエストが多すぎます。1分ほど待ってから再試行してください。';
    if (e.code === 'daily_cap') return '本日の経路計算の上限に達しました。明日あらためてお試しください。';
    if (e.status === 404) return '経路が見つかりませんでした。';
    if (e.status === 400) return '指定した地点では計算できません。';
    if (!e.status) return '経路サーバーに接続できません。';
    return '経路の計算に失敗しました。時間をおいて再試行してください。';
  }
  const stopParam = (s) => `${f5(s.ll[1])},${f5(s.ll[0])},${s.min}`;
  /**
   * Waypoints sent to HERE. Around a 賢い料金 道の駅 (and the waypoints next to it within
   * SMART_GROUP_KM, e.g. the charger) the designated IC's local-road point is added before and
   * after, so the route leaves and re-enters the expressway at that IC.
   */
  function smartRanges(vias) {
    const ranges = [];
    vias.forEach((v, i) => {
      const pair = stationPair(v.ll);
      if (!pair) return;
      const near = (k) => k >= 0 && k < vias.length && !stationPair(vias[k].ll) && km(vias[k].ll, pair.station_coords) <= SMART_GROUP_KM;
      let a = i, b = i;
      while (near(a - 1) && !ranges.some((x) => x.b >= a - 1)) a--;
      while (near(b + 1)) b++;
      ranges.push({ a, b, pair, gate: gateFor(pair.ic, pair.ic_coords) });
    });
    return ranges;
  }
  function buildStops(vias, ranges, flip = false) {
    const pinOf = (g) => (flip ? [2 * g.gate[0] - g.approach[0], 2 * g.gate[1] - g.approach[1]] : g.approach);
    const stops = [];
    vias.forEach((v, i) => {
      const r1 = ranges.find((x) => x.a === i && x.gate);
      if (r1) stops.push({ ll: pinOf(r1.gate), min: 0, pin: true });
      stops.push({ ll: v.ll, min: v.stop, via: i });
      const r2 = ranges.find((x) => x.b === i && x.gate);
      if (r2) stops.push({ ll: pinOf(r2.gate), min: 0, pin: true });
    });
    return stops;
  }  function nearestIc(p) {
    if (!p) return null;
    const data = ctx.getData().roadFacilities;
    let best = null, bestD = 2.5;
    for (const f of data?.features || []) {
      if (!isIc(f.properties.code, f.properties.name)) continue;
      const d = km(f.geometry.coordinates, [p.lng, p.lat]);
      if (d < bestD) { best = f.properties.name; bestD = d; }
    }
    return best;
  }
  /** Off-expressway stretches: consecutive stops with no toll road between them. */
  function analyze(r, stops, vias) {
    const tollsIn = (s) => (r.tolls || []).filter((t) => t.section === s);
    const groups = [];
    let j = 0;
    while (j < stops.length) {
      let k = j;
      while (k + 1 < stops.length && !tollsIn(k + 1).length) k++;
      const exitT = tollsIn(j).at(-1) || null;
      const entryT = tollsIn(k + 1)[0] || null;
      if (exitT?.exit && entryT?.entry) {
        const members = stops.slice(j, k + 1).filter((s) => !s.pin).map((s) => s.via);
        const exitIc = nearestIc(exitT.exit);
        const entryIc = nearestIc(entryT.entry);
        const sameIc = !!exitIc && exitIc === entryIc;
        const first = stops[j].ll, last = stops[k].ll;
        let drive = 0, wait = 0;
        for (let s = j + 1; s <= k; s++) drive += r.sections[s]?.min || 0;
        for (let s = j; s <= k; s++) wait += stops[s].min;
        // gate ↔ first/last stop legs are inside sections shared with the expressway: estimate them
        const legs = (km([exitT.exit.lng, exitT.exit.lat], first) + km(last, [entryT.entry.lng, entryT.entry.lat])) * 1.3 / OFFROAD_KMH * 60;
        const offMin = Math.round(drive + wait + legs);
        const station = members.map((i) => stationPair(vias[i].ll)).find(Boolean) || null;
        // a 賢い料金 道の駅 near this stretch's waypoints can make the stretch free with ETC2.0
        const hintPair = station ? null : (S.smartPairs || []).find((pr) => pr.kind !== 'ev'
          && members.some((i) => km(vias[i].ll, pr.station_coords) <= SMART_GROUP_KM)) || null;
        const smart = station && sameIc && baseName(station.ic) === baseName(exitIc)
          ? { pair: station, ok: offMin <= smartLimit(station) }
          : null;
        groups.push({ from: j, to: k, members, exitIc, entryIc, sameIc, offMin, smart, stationPair: station, hintPair });
      }
      j = k + 1;
    }
    return groups;
  }

  async function compute(fit = true) {
    if (!S.o || !S.d) return;
    if (km(S.o.ll, S.d.ll) < 0.2 && !realVias().length) {
      S.seq++;
      S.loading = false;
      invalidate();
      S.error = '出発地と到着地が同じです。';
      draw();
      renderCard();
      return;
    }
    const seq = ++S.seq;
    invalidate();
    S.loading = true;
    renderCard();
    try {
      if (!S.smartPairs) S.smartPairs = await loadSmartToll();
      await loadGates();
      // 1) direct route (also resolves the IC gate points used for everything else)
      const key = `${apiParam(S.o)}|${apiParam(S.d)}|${S.t}`;
      if (S.directKey !== key || !S.direct) {
        const q = new URLSearchParams({ o: apiParam(S.o), d: apiParam(S.d), alt: '1' });
        if (S.t) q.set('t', S.t);
        const body = await fetchRoute(q);
        if (seq !== S.seq) return;
        const alts = body.alternatives || [];
        delete body.alternatives;
        S.direct = { body, alts: alts.map((a) => ({ ...a, used: body.used, departure: body.departure })) };
        S.directKey = key;
      }
      const direct = S.direct.body;
      const vias = realVias();
      if (!vias.length) {
        S.routes = [direct, ...S.direct.alts];
        S.routeIdx = 0;
        S.result = direct;
      } else {
        // 2) with waypoints (from the resolved start/goal points)
        const base = new URLSearchParams({ o: `${direct.used.o[0]},${direct.used.o[1]}`, d: `${direct.used.d[0]},${direct.used.d[1]}` });
        if (S.t) base.set('t', S.t);
        const ranges = smartRanges(vias);
        const qualifies = (gs) => gs.filter((g) => g.smart).length;
        let stops = buildStops(vias, ranges);
        const q = new URLSearchParams(base);
        q.set('v', stops.map(stopParam).join('|'));
        let r = await fetchRoute(q);
        if (seq !== S.seq) return;
        let groups = analyze(r, stops, vias);
        // the derived IC approach point can sit on the mainline side: try the mirrored point once
        if (ranges.some((x) => x.gate) && qualifies(groups) < ranges.length) {
          const stops2 = buildStops(vias, ranges, true);
          const q2 = new URLSearchParams(base);
          q2.set('v', stops2.map(stopParam).join('|'));
          const r2 = await fetchRoute(q2);
          if (seq !== S.seq) return;
          const groups2 = analyze(r2, stops2, vias);
          if (qualifies(groups2) > qualifies(groups)) { r = r2; stops = stops2; groups = groups2; }
        }
        // 3) 賢い料金: fare as if the qualifying stretches had not left the expressway
        let effective = r.etc;
        const drop = new Set();
        for (const g of groups) if (g.smart?.ok) for (let s = g.from; s <= g.to; s++) drop.add(s);
        if (drop.size) {
          const rest = stops.filter((_, s) => !drop.has(s));
          if (rest.length) {
            const q3 = new URLSearchParams(base);
            q3.set('v', rest.map(stopParam).join('|'));
            effective = (await fetchRoute(q3)).etc;
            if (seq !== S.seq) return;
          } else {
            effective = direct.etc;
          }
        }
        S.result = r;
        S.routes = [r];
        S.analysis = { groups, stops, directEtc: direct.etc, effective, smartApplied: drop.size > 0 };
      }
    } catch (e) {
      if (seq !== S.seq) return;
      invalidate();
      S.error = errorText(e);
    }
    S.loading = false;
    draw();
    renderCard();
    if (fit) fitRoute();
  }
  function selectRoute(i) {
    if (!S.routes[i] || i === S.routeIdx || realVias().length) return;
    S.routeIdx = i;
    S.result = S.routes[i];
    draw();
    renderCard();
  }

  // ---------- map ----------
  const SYSTEM_COLORS = ['#1d4ed8', '#7c3aed', '#0e7490', '#be185d', '#4d7c0f', '#b45309'];
  /** Stable index of a toll system within a route (order of first appearance in the fares). */
  function systemIndex(r, sys) {
    r._systems ??= [...new Set([...(r.tolls || []).map((t) => t.system), ...(r.tollSpans || []).map((s) => s[2])].filter(Boolean))];
    const i = r._systems.indexOf(sys || '');
    return i >= 0 ? i : 0;
  }
  function setupLayers() {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'route-alt', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'alt'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#94a3b8', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 12, 6], 'line-opacity': 0.8 },
    });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'main'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5, 12, 10] },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'main'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['case', ['get', 'toll'], ['coalesce', ['get', 'color'], '#1d4ed8'], '#93c5fd'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 12, 6],
      },
    });
    map.addLayer({
      id: 'route-gates', type: 'circle', source: 'route', filter: ['==', ['get', 'role'], 'gate'],
      paint: { 'circle-radius': 4.5, 'circle-color': '#ffffff', 'circle-stroke-color': '#1d4ed8', 'circle-stroke-width': 2.5 },
    });
    map.addLayer({
      id: 'route-via', type: 'circle', source: 'route', filter: ['==', ['get', 'role'], 'via'],
      paint: { 'circle-radius': 9, 'circle-color': ['case', ['get', 'smart'], '#16a34a', '#ea580c'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: 'route-via-label', type: 'symbol', source: 'route', filter: ['==', ['get', 'role'], 'via'],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#ffffff' },
    });
    map.on('mouseenter', 'route-alt', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'route-alt', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'route-alt', (e) => selectRoute(Number(e.features[0].properties.idx)));
  }
  function draw() {
    if (!map?.getSource('route')) return;
    const features = [];
    const r = S.result;
    S.routes.forEach((alt, i) => {
      if (i !== S.routeIdx && alt.line?.length) features.push({ type: 'Feature', properties: { role: 'alt', idx: i }, geometry: { type: 'LineString', coordinates: alt.line } });
    });
    if (r?.line?.length) {
      // colour each toll operator's stretch (spans carry the toll system name)
      const sysAt = new Int16Array(r.line.length).fill(-1);
      for (const [a, b, sys] of r.tollSpans || []) for (let i = a; i <= b; i++) sysAt[i] = systemIndex(r, sys);
      let start = 0;
      for (let i = 1; i <= r.line.length; i++) {
        if (i === r.line.length || sysAt[i] !== sysAt[start]) {
          const end = Math.min(i, r.line.length - 1);
          const si = sysAt[start];
          if (end > start) features.push({ type: 'Feature', properties: { role: 'main', toll: si >= 0, color: si >= 0 ? SYSTEM_COLORS[si % SYSTEM_COLORS.length] : null }, geometry: { type: 'LineString', coordinates: r.line.slice(start, end + 1) } });
          start = i;
        }
      }
      for (const t of r.tolls || []) {
        for (const p of [t.entry, t.exit]) if (p) features.push({ type: 'Feature', properties: { role: 'gate' }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
      }
    }
    let n = 0;
    S.vias.forEach((v) => {
      if (v.empty) return;
      n += 1;
      features.push({ type: 'Feature', properties: { role: 'via', label: String(n), smart: !!stationPair(v.ll) }, geometry: { type: 'Point', coordinates: v.ll } });
    });
    map.getSource('route').setData({ type: 'FeatureCollection', features });
    for (const role of ['o', 'd']) {
      const ep = S[role];
      if (!ep) { markers[role]?.remove(); delete markers[role]; continue; }
      if (!markers[role]) {
        const el = document.createElement('div');
        el.className = `route-pin ${role}`;
        el.innerHTML = `<span>${role === 'o' ? 'S' : 'G'}</span>`;
        markers[role] = new maplibregl.Marker({ element: el, anchor: 'bottom' });
      }
      markers[role].setLngLat(ep.ll).addTo(map);
    }
  }
  function fitRoute() {
    const line = S.result?.line;
    if (!line?.length) return;
    const b = new maplibregl.LngLatBounds(line[0], line[0]);
    for (const p of line) b.extend(p);
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    map.fitBounds(b, { padding: narrow ? { top: 110, bottom: 30, left: 20, right: 20 } : { top: 60, bottom: 60, left: 380, right: 60 }, maxZoom: 12, duration: 700 });
  }
  function fitEndpoints() {
    const ep = S.o || S.d || realVias()[0];
    if (ep && !map.getBounds().contains(ep.ll)) map.easeTo({ center: ep.ll, duration: 500 });
  }

  // ---------- card ----------
  class CardControl {
    onAdd() {
      card = document.createElement('section');
      card.className = 'maplibregl-ctrl route-card';
      card.hidden = true;
      card.setAttribute('aria-live', 'polite');
      return card;
    }
    onRemove() { card?.remove(); }
  }
  function gateLabel(p) {
    if (!p) return '—';
    const ic = nearestIc(p);
    return ic ? esc(nfkc(ic)) : `${esc(p.name)}料金所`;
  }
  function defaultTime() {
    const d = new Date(Date.now() + 3600e3);
    d.setMinutes(0, 0, 0);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  }
  function fmtMin(m) {
    const h = Math.floor(m / 60);
    return h ? `${h}時間${m % 60}分` : `${m}分`;
  }
  function links() {
    const out = [];
    const vias = realVias();
    if (S.o && S.d) {
      const wp = vias.length ? `&waypoints=${vias.map((v) => `${v.ll[1]},${v.ll[0]}`).join('%7C')}` : '';
      out.push(`<a href="https://www.google.com/maps/dir/?api=1&origin=${S.o.ll[1]},${S.o.ll[0]}&destination=${S.d.ll[1]},${S.d.ll[0]}${wp}&travelmode=driving" target="_blank" rel="noopener">Googleマップ</a>`);
      if (S.o.kind === 'ic' && S.d.kind === 'ic' && !vias.length) {
        const t = (S.t || defaultTime()).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
        const q = new URLSearchParams({
          startPlaceKana: baseName(S.o.name), arrivePlaceKana: baseName(S.d.name), searchHour: String(Number(t[4])), searchMinute: '0',
          kind: '1', carType: '1', priority: '2', roadType1: 'on', roadType2: 'on',
          searchYear: t[1], searchMonth: String(Number(t[2])), searchDay: String(Number(t[3])), selectickindflg: '0',
        });
        out.push(`<a href="https://www.driveplaza.com/dp/SearchQuick?${q}" target="_blank" rel="noopener">公式料金（ドラぷら）</a>`);
      }
    }
    if (S.o && S.d && !S.o.here && !S.d.here) out.push('<button type="button" data-route-share>リンクをコピー</button>');
    return out.length ? `<div class="route-actions">${out.join('')}</div>` : '';
  }
  function searchBox(role, placeholder) {
    return `<div class="route-search"><input type="search" class="route-q" data-route-q="${role}" value="${esc(S.q[role] || '')}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" aria-label="${placeholder}" aria-autocomplete="list" aria-controls="route-sug-${role}">
      <ul class="route-sug" id="route-sug-${role}" data-route-sug="${role}" role="listbox" hidden></ul></div>`;
  }
  function epRow(role) {
    const ep = epOf(role);
    const label = role === 'o' ? '出発' : '到着';
    const pin = `<span class="route-pin-mini ${role}">${role === 'o' ? 'S' : 'G'}</span>`;
    if (!ep) {
      const here = S.locating === role
        ? '<span class="muted route-locating">取得中…</span>'
        : navigator.geolocation ? `<button type="button" class="route-here" data-route-here="${role}" title="現在地を${label}地にする">${LOCATE_ICON}現在地</button>` : '';
      return `<div class="route-ep empty">${pin}${searchBox(role, `${label}地を検索、または地図で選択`)}${here}</div>`;
    }
    const warn = ep.kind === 'ic' && !ep.gate ? '<span class="route-warn" title="料金所の位置が見つからないため、IC付近の地点から計算します">位置は概略</span>' : '';
    return `<div class="route-ep">${pin}${catIcon(ep.cat)}${nameHtml(ep)}${warn}<button type="button" class="route-x" data-route-clear="${role}" aria-label="${label}地を解除">×</button></div>`;
  }
  function nameHtml(ep) {
    const n = displayName(ep);
    const tag = CAT[ep.cat] && ep.cat !== 'ic' && ep.cat !== 'here' && !n.startsWith(CAT[ep.cat].label) ? `<em>${CAT[ep.cat].label}</em>` : '';
    return `<span class="name" title="${esc(n)}"><span class="n">${esc(n)}${tag}</span>${ep.sub ? `<small>${esc(ep.sub)}</small>` : ''}</span>`;
  }
  function viaRow(i, n) {
    const v = S.vias[i];
    const role = `v${i}`;
    const pin = `<span class="route-pin-mini v${v.empty || !stationPair(v.ll) ? '' : ' smart'}">${n}</span>`;
    const remove = `<button type="button" class="route-x" data-route-remove="${i}" aria-label="経由地${n}を削除">×</button>`;
    if (v.empty) return `<div class="route-ep empty via">${pin}${searchBox(role, '経由地（充電器・道の駅など）を検索')}${remove}</div>`;
    const opts = STOP_OPTIONS.map((m) => `<option value="${m}"${m === v.stop ? ' selected' : ''}>${m ? `${m}分` : '通過'}</option>`).join('');
    const smart = stationPair(v.ll) ? '<span class="route-tag smart" title="賢い料金の対象の道の駅">賢い料金</span>' : '';
    return `<div class="route-ep via">${pin}${catIcon(v.cat)}${nameHtml(v)}${smart}
      <select class="route-stop-sel" data-route-stop="${i}" aria-label="経由地${n}での停車時間">${opts}</select>${remove}</div>`;
  }
  function waypointRows() {
    let n = 0;
    const vias = S.vias.map((v, i) => viaRow(i, v.empty ? '·' : ++n)).join('');
    const add = S.vias.length < MAX_VIAS ? '<button type="button" class="route-add-via" data-route-add-via>＋ 経由地を追加</button>' : '';
    return `<div class="route-stops">${epRow('o')}${vias}${epRow('d')}</div>${add}`;
  }
  function altTabs() {
    if (S.routes.length < 2) return '';
    return `<div class="route-alts" role="tablist" aria-label="経路の候補">${S.routes.map((rt, i) => `<button type="button" role="tab" aria-selected="${i === S.routeIdx}" class="${i === S.routeIdx ? 'active' : ''}" data-route-alt="${i}">
        <span>ルート${i + 1}</span><b>${yen(rt.etc)}</b><small>${fmtMin(rt.min)} · ${rt.km}km</small></button>`).join('')}</div>`;
  }
  function discountHtml(r) {
    const kinds = new Set((r.tolls || []).map((t) => t.discount).filter(Boolean));
    if (!kinds.size) return '';
    const label = { night: '深夜割引（0〜4時）', holiday: '休日割引' };
    return `<div class="route-disc">${[...kinds].map((k) => `<span>${label[k] || k}</span>`).join('')}適用（出発日時で変わります）</div>`;
  }
  function viaName(i) {
    const v = realVias()[i];
    return v ? esc(displayName(v)) : '';
  }
  function analysisHtml() {
    const a = S.analysis;
    if (!a) return '';
    const r = S.result;
    const rows = [`<div><span>直行</span><b>${yen(a.directEtc)}</b></div>`,
      `<div><span>寄り道あり</span><b>${yen(r.etc)}</b><em class="${r.etc > a.directEtc ? 'up' : ''}">${signedYen(r.etc - a.directEtc)}</em></div>`];
    if (a.smartApplied) rows.push(`<div class="smart"><span>賢い料金（ETC2.0）</span><b>${yen(a.effective)}</b><em>${signedYen(a.effective - a.directEtc)}</em></div>`);
    const groups = a.groups.map((g) => {
      const names = g.members.map(viaName).filter(Boolean).join('・');
      const where = g.sameIc ? `${esc(nfkc(g.exitIc))}で降りて同じICから戻る` : `${esc(nfkc(g.exitIc || '?'))}で降りて${esc(nfkc(g.entryIc || '?'))}から戻る`;
      let note = '<span class="route-tag split">料金が2回に分かれます</span>';
      if (g.smart?.ok) {
        const inside = g.members.some((i) => realVias()[i] && realVias()[i].cat !== 'michinoeki' && km(realVias()[i].ll, g.smart.pair.station_coords) <= AT_STATION_KM);
        const visited = g.members.some((i) => realVias()[i]?.cat === 'michinoeki');
        const why = visited ? `道の駅「${esc(g.smart.pair.station)}」に立ち寄り` : inside ? `充電器が道の駅「${esc(g.smart.pair.station)}」の敷地内にあるため立ち寄り条件を満たす` : `道の駅「${esc(g.smart.pair.station)}」に立ち寄り`;
        note = `<span class="route-tag smart">賢い料金：降りなかった扱い（${why}・約${g.offMin}分で戻る）</span><div class="muted route-smart-cond">条件：ETC2.0車で、道の駅の出入口のアンテナを通過し、${esc(nfkc(g.smart.pair.ic))}から同じ方向へ${smartLimit(g.smart.pair) / 60}時間以内に戻ること</div>`;
      }
      else if (g.smart) note = `<span class="route-tag split">戻るまで約${g.offMin}分で${smartLimit(g.smart.pair) / 60}時間を超えるため、賢い料金の対象外の見込み</span>`;
      else if (g.stationPair) note = `<span class="route-tag split">${esc(nfkc(g.stationPair.ic))}で降りて同じICに戻る経路にならないため、賢い料金の対象外の見込み</span>`;
      const hint = g.hintPair && realVias().length < MAX_VIAS
        ? `<div class="route-hint-smart">近くに賢い料金の道の駅「${esc(g.hintPair.station)}」（${esc(nfkc(g.hintPair.ic))}）があります。経由地に加えると、${esc(nfkc(g.hintPair.ic))}で降りて同じICに戻る経路にし、ETC2.0なら降りなかった扱いになります（${smartLimit(g.hintPair) / 60}時間以内）。
            <button type="button" data-route-add-station="${esc(g.hintPair.station)}" data-at="${g.members[0] ?? 0}">道の駅を経由地に追加</button></div>`
        : '';
      return `<li><div class="route-exit-where">${where}</div><div class="muted">寄り道：${names || '—'}</div>${note}${hint}</li>`;
    }).join('');
    return `<div class="route-compare">${rows.join('')}</div>${groups ? `<ul class="route-groups">${groups}</ul>` : ''}`;
  }
  function renderCard() {
    if (!card) return;
    const focused = document.activeElement?.dataset?.routeQ;
    const idle = !S.o && !S.d && !S.vias.length;
    card.hidden = false;
    card.classList.toggle('idle', idle);
    const r = S.result;
    let body = '';
    if (!S.o || !S.d) {
      body = S.error ? `<p class="route-error">${esc(S.error)}</p>` : idle ? '' : '<p class="route-hint">検索のほか、IC・施設・充電器のポップアップや地図の右クリック／長押しでも指定できます。</p>';
    } else if (S.loading) {
      body = '<p class="route-hint">計算中…</p>';
    } else if (S.error) {
      body = `<p class="route-error">${esc(S.error)}</p><button type="button" class="route-retry" data-route-retry>再試行</button>`;
    } else if (r) {
      const etc = S.analysis?.smartApplied ? S.analysis.effective : r.etc;
      const discLabel = { night: '深夜', holiday: '休日' };
      const tolls = (r.tolls || []).map((t) => {
        const color = SYSTEM_COLORS[systemIndex(r, t.system) % SYSTEM_COLORS.length];
        return `<li><i style="background:${color}"></i><span class="seg"><b>${gateLabel(t.entry)} → ${gateLabel(t.exit)}</b><small>${esc(t.system)}${t.discount ? `・${discLabel[t.discount] || ''}割引` : ''}</small></span><span class="fare">${yen(t.etc)}</span></li>`;
      }).join('');
      body = `
        ${altTabs()}
        <div class="route-summary">
          <div class="price"><b>${yen(etc)}</b><span>${S.analysis?.smartApplied ? 'ETC2.0・賢い料金' : 'ETC'}</span></div>
          <div class="meta">${r.km} km · ${fmtMin(r.min)}${realVias().length ? '（停車を含む）' : ''}</div>
          ${discountHtml(r)}
        </div>
        ${r.cash != null && r.cash !== r.etc && !S.analysis ? `<div class="muted route-cash">現金 ${yen(r.cash)}</div>` : ''}
        ${analysisHtml()}
        ${r.hasToll ? `<div class="route-breakdown"><div class="route-breakdown-head">料金の内訳<small>色は地図の線と対応</small></div><ol>${tolls}</ol></div>` : '<p class="route-hint">この経路は有料道路を使いません（HEREの経路選択による）。</p>'}`;
    }
    const head = `
      <div class="route-head"><h3>経路・料金</h3>
        ${idle ? '' : `<button type="button" class="route-icon" data-route-swap aria-label="出発と到着を入れ替え" title="入れ替え">${ICON.swap}</button>`}
        <button type="button" class="route-icon" data-route-collapse aria-expanded="${!S.collapsed}" aria-label="${S.collapsed ? '開く' : '折りたたむ'}" title="${S.collapsed ? '開く' : '折りたたむ'}">${S.collapsed ? ICON.expand : ICON.collapse}</button>
        ${idle ? '' : `<button type="button" class="route-icon" data-route-close aria-label="経路をクリア" title="クリア">${ICON.close}</button>`}</div>`;
    if (S.collapsed) {
      const epName = (ep) => (ep ? esc(nfkc(ep.name)) : '未選択');
      const etc = S.analysis?.smartApplied ? S.analysis.effective : r?.etc;
      const mini = r && !S.loading && !S.error
        ? `${yen(etc)} · ${r.km} km · ${fmtMin(r.min)}`
        : !idle ? `${epName(S.o)} → ${epName(S.d)}` : '';
      card.innerHTML = head + (mini ? `<div class="route-mini">${mini}</div>` : '');
      return;
    }
    if (idle) {
      card.innerHTML = `${head}<div class="route-stops">${epRow('o')}${epRow('d')}</div>${body}`;
    } else {
      card.innerHTML = `${head}
      ${waypointRows()}
      <label class="route-time"><span>出発</span><input type="datetime-local" step="3600" value="${esc(S.t || defaultTime())}" data-route-time></label>
      ${body}
      ${links()}
      <details class="route-note"><summary>経路・料金 © HERE · 料金について</summary>所要時間が最短の経路での目安です（普通車・ETC）。公式の料金と異なる場合があります。経由地で高速道路を降りると料金が分かれます。「賢い料金」は ETC2.0 車で、対象の道の駅の出入口のアンテナ通過が条件です。<a href="about.html#route" target="_blank" rel="noopener">詳しく</a></details>`;
    }
    if (focused) {
      const el = card.querySelector(`[data-route-q="${focused}"]`);
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
  }

  // ---------- search (same index and sources as the map search) ----------
  const sugState = {};
  const sug = (role) => (sugState[role] ??= { rows: [], active: -1, seq: 0 });
  let sugTimer = null;
  const sugEl = (role) => card?.querySelector(`[data-route-sug="${role}"]`);
  function renderSug(role, rows, { loading = false, empty = false } = {}) {
    const st = sug(role);
    st.rows = rows;
    if (st.active >= rows.length) st.active = -1;
    const el = sugEl(role);
    if (!el) return;
    const info = (k) => window.MapSearch?.kindInfo?.(k) || { icon: '📍', label: '' };
    const subOf = (r) => {
      if (r.sub || (r.kind !== 'tesla' && r.kind !== 'flash')) return r.sub;
      const st = stationPair(r.coords);
      if (st) return `道の駅 ${st.station}内`;
      const near = window.MapSearch?.nearest?.(r.coords, ['michinoeki', 'sa', 'mall'], 0.35);
      return near ? `${near.kind === 'michinoeki' && !/^道の駅/.test(near.label) ? '道の駅 ' : ''}${near.label}内` : '';
    };
    let html = rows.map((r, i) => `<li role="option" data-i="${i}" class="${i === st.active ? 'on' : ''}"><span class="k" aria-hidden="true">${CAT[r.kind] ? catIcon(r.kind) : info(r.kind).icon}</span><span class="t"><b>${esc(r.label)}</b>${subOf(r) ? `<small>${esc(subOf(r))}</small>` : ''}</span><em class="kl">${esc(info(r.kind).label || '')}</em></li>`).join('');
    if (loading) html += '<li class="st">住所・地名・施設を検索中…</li>';
    else if (empty) html += '<li class="st">見つかりませんでした</li>';
    else if (!rows.some((r) => r.kind === 'gsi' || r.kind === 'osm')) html += '<li class="st more" data-more>↵ 住所・地名・施設（駅など）をさらに検索</li>';
    el.innerHTML = html;
    el.hidden = false;
  }
  function closeSug(role) {
    const el = sugEl(role);
    if (el) el.hidden = true;
    sug(role).seq++;
    sug(role).active = -1;
  }
  function suggestLocal(role) {
    const q = (S.q[role] || '').trim();
    if (!q || !window.MapSearch?.local) { closeSug(role); return; }
    sug(role).seq++;
    renderSug(role, window.MapSearch.local(q));
  }
  async function searchRemote(role) {
    const q = (S.q[role] || '').trim();
    if (!q || !window.MapSearch?.remote) return;
    const st = sug(role);
    const my = ++st.seq;
    const local = window.MapSearch.local(q);
    if (local.length && local[0].score === 0) { pickResult(role, local[0]); return; }
    renderSug(role, local, { loading: true });
    const remote = await window.MapSearch.remote(q).catch(() => []);
    if (my !== st.seq) return;
    const rows = [...local, ...remote];
    renderSug(role, rows, { empty: !rows.length });
  }
  function toEndpoint(r) {
    const stop = r.kind === 'tesla' || r.kind === 'flash' ? 30 : r.kind === 'michinoeki' ? 5 : 0;
    const cat = CAT[r.kind] && r.kind !== 'here' ? r.kind : '';
    if (r.kind === 'ic' && isIc(r.code, r.label)) return { kind: 'ic', name: r.label, ll: r.coords, stop, cat: 'ic' };
    return { kind: 'place', name: cleanName(r.label), ll: r.coords, stop, cat: cat === 'ic' ? '' : cat };
  }
  function pickResult(role, r) {
    closeSug(role);
    S.q[role] = '';
    setEndpoint(role, toEndpoint(r));
  }
  function onSearchInput(e) {
    const role = e.target.dataset?.routeQ;
    if (!role) return;
    S.q[role] = e.target.value;
    sug(role).active = -1;
    clearTimeout(sugTimer);
    sugTimer = setTimeout(() => suggestLocal(role), 80);
  }
  function onSearchKey(e) {
    const role = e.target.dataset?.routeQ;
    if (!role) return;
    e.stopPropagation();
    const st = sug(role);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!st.rows.length) return;
      e.preventDefault();
      st.active = (st.active + (e.key === 'ArrowDown' ? 1 : -1) + st.rows.length) % st.rows.length;
      renderSug(role, st.rows);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.isComposing || e.keyCode === 229) return;
      if (st.active >= 0 && st.rows[st.active]) pickResult(role, st.rows[st.active]);
      else searchRemote(role);
    } else if (e.key === 'Escape') {
      closeSug(role);
    }
  }

  // ---------- events ----------
  function onClick(e) {
    const set = e.target.closest('[data-route-set]');
    if (set) {
      const ep = epFromDataset(set.dataset);
      if (set.dataset.routeSet === 'v') addVia(ep);
      else setEndpoint(set.dataset.routeSet, ep);
      return;
    }
    const fromHere = e.target.closest('[data-route-from-here]');
    if (fromHere) {
      useHere('o', epFromDataset(fromHere.dataset));
      return;
    }
    if (!card?.contains(e.target)) return;
    const sugList = e.target.closest('[data-route-sug]');
    if (sugList) {
      const role = sugList.dataset.routeSug;
      const li = e.target.closest('li[data-i]');
      if (li) pickResult(role, sug(role).rows[Number(li.dataset.i)]);
      else if (e.target.closest('[data-more]')) searchRemote(role);
      return;
    }
    const here = e.target.closest('[data-route-here]');
    if (here) { useHere(here.dataset.routeHere); return; }
    const clear = e.target.closest('[data-route-clear]');
    const remove = e.target.closest('[data-route-remove]');
    const addStation = e.target.closest('[data-route-add-station]');
    if (clear) {
      S[clear.dataset.routeClear] = null;
      S.seq++;
      S.loading = false;
      invalidate();
      update();
    } else if (remove) {
      const i = Number(remove.dataset.routeRemove);
      const wasEmpty = S.vias[i]?.empty;
      S.vias.splice(i, 1);
      if (wasEmpty) renderCard();
      else changed();
    } else if (e.target.closest('[data-route-add-via]')) {
      if (S.vias.length < MAX_VIAS) S.vias.push({ empty: true });
      renderCard();
      card.querySelector(`[data-route-q="v${S.vias.length - 1}"]`)?.focus();
    } else if (addStation) {
      const pair = (S.smartPairs || []).find((pr) => pr.station === addStation.dataset.routeAddStation);
      // insert the 道の駅 just before the first waypoint of that off-expressway stretch
      const slot = S.vias.indexOf(realVias()[Number(addStation.dataset.at)]);
      if (pair) addVia({ kind: 'place', name: `道の駅 ${pair.station}`, ll: pair.station_coords, stop: 5, cat: 'michinoeki' }, slot < 0 ? S.vias.length : slot);
    } else if (e.target.closest('[data-route-close]')) {
      clearAll();
    } else if (e.target.closest('[data-route-swap]')) {
      [S.o, S.d] = [S.d, S.o];
      S.vias.reverse();
      changed();
    } else if (e.target.closest('[data-route-collapse]')) {
      S.collapsed = !S.collapsed;
      renderCard();
    } else if (e.target.closest('[data-route-retry]')) {
      compute();
    } else if (e.target.closest('[data-route-alt]')) {
      selectRoute(Number(e.target.closest('[data-route-alt]').dataset.routeAlt));
    } else if (e.target.closest('[data-route-share]')) {
      copyRouteLink(e.target.closest('[data-route-share]'));
    }
  }
  async function copyRouteLink(button) {
    ctx.writeHash();
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = '✓ コピーしました';
      button.classList.add('copied');
      setTimeout(() => { button.textContent = 'リンクをコピー'; button.classList.remove('copied'); }, 2000);
    } catch {
      window.prompt('このURLをコピーしてください', url);
    }
  }
  function onChange(e) {
    if (e.target.matches('[data-route-stop]')) {
      const v = S.vias[Number(e.target.dataset.routeStop)];
      if (v && !v.empty) { v.stop = Number(e.target.value) || 0; changed(); }
      return;
    }
    if (!e.target.matches('[data-route-time]')) return;
    S.t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.target.value) ? e.target.value : '';
    ctx.writeHash();
    compute();
  }
  function update() {
    ctx.writeHash();
    draw();
    renderCard();
  }
  function clearAll() {
    S.o = S.d = null;
    S.vias = [];
    S.direct = null;
    S.directKey = '';
    S.loading = false;
    S.seq++;
    invalidate();
    update();
  }
  function pointPopup(lngLat) {
    const ll = [lngLat.lng, lngLat.lat];
    popup.setLngLat(lngLat).setHTML(`<div class="charger-popup"><h3>選択した地点</h3><div class="muted">${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}</div>${buttonsHtml({ kind: 'place', name: '選択した地点', ll })}</div>`).addTo(map);
  }
  function bindPointPicking() {
    map.on('contextmenu', (e) => {
      e.preventDefault();
      pointPopup(e.lngLat);
    });
    let timer = null;
    const cancel = () => { clearTimeout(timer); timer = null; };
    map.on('touchstart', (e) => {
      cancel();
      if (e.originalEvent.touches?.length !== 1) return;
      const lngLat = e.lngLat;
      timer = setTimeout(() => { timer = null; pointPopup(lngLat); }, 650);
    });
    for (const ev of ['touchend', 'touchcancel', 'touchmove', 'movestart']) map.on(ev, cancel);
  }

  // ---------- hash ----------
  function writeHash(p) {
    // the device location is never written to the URL (it would leak through shared links)
    if (S.o && !S.o.here) p.set('ro', encodeEp(S.o));
    if (S.d && !S.d.here) p.set('rd', encodeEp(S.d));
    const vias = realVias();
    if (vias.length) p.set('rv', vias.map((v) => encodeEp(v, v.stop)).join('|'));
    if ((S.o || S.d) && S.t) p.set('rt', S.t);
  }
  async function restore() {
    const p = initialHash;
    const o = decodeEp(p.get('ro'));
    const d = decodeEp(p.get('rd'));
    const vias = (p.get('rv') || '').split('|').map(decodeEp).filter(Boolean).slice(0, MAX_VIAS);
    const t = p.get('rt') || '';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) S.t = t;
    if (!o && !d && !vias.length) return;
    if (o) await setRole('o', o);
    if (d) await setRole('d', d);
    for (let i = 0; i < vias.length; i++) {
      S.vias.push({ empty: true });
      await setRole(`v${i}`, vias[i]);
    }
    ctx.writeHash();
    draw();
    renderCard();
    if (S.o && S.d) compute(!p.has('at'));
  }

  function init(opts) {
    if (!API) return;
    ({ map, popup } = opts);
    ctx = opts;
    setupLayers();
    map.addControl(new CardControl(), 'top-left');
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    card.addEventListener('input', onSearchInput);
    card.addEventListener('keydown', onSearchKey);
    card.addEventListener('mousedown', (e) => { if (e.target.closest('[data-route-sug]')) e.preventDefault(); });
    card.addEventListener('focusin', (e) => {
      const role = e.target.dataset?.routeQ;
      if (!role) return;
      window.MapSearch?.loadPoi?.();
      if ((S.q[role] || '').trim()) suggestLocal(role);
    });
    card.addEventListener('focusout', (e) => {
      const role = e.target.dataset?.routeQ;
      if (role) setTimeout(() => { if (document.activeElement !== e.target) closeSug(role); }, 150);
    });
    // compact by default on small screens so the map stays usable
    S.collapsed = window.matchMedia('(max-width: 760px)').matches;
    bindPointPicking();
    loadSmartToll().then((pairs) => { S.smartPairs = pairs; draw(); renderCard(); });
    renderCard();
    restore();
  }

  window.RouteTool = {
    init,
    buttonsHtml,
    facilityButtonsHtml,
    writeHash,
    get enabled() { return !!API; },
    get state() { return S; },
  };
})();
