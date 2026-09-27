// Route and expressway fare between two points (IC, POI, charger or any map point).
// Routing and tolls come from HERE through the relay in api/ (the key stays server-side).
// Results are kept only in memory for the current view (HERE terms forbid caching/sharing results).
(() => {
  'use strict';

  const API = String(window.ROUTE_API || '').replace(/\/$/, '');
  const IC_CODES = new Set([2941, 2945]);
  // IC, smart IC, or a combined junction such as 「春日ＪＣＴ・ＩＣ」
  const isIc = (code, name) => IC_CODES.has(Number(code)) || (Number(code) === 2942 && /IC/.test(String(name || '').normalize('NFKC')));
  const MAX_NAME = 40;

  const S = { o: null, d: null, t: '', result: null, loading: false, error: '', seq: 0, stop: 30, detours: new Map(), smartVisits: new Map(), smartPairs: null, detourSel: null, routes: [], routeIdx: 0, q: { o: '', d: '' } };
  // read before app.js rewrites the hash on the first map move
  const initialHash = new URLSearchParams(location.hash.slice(1));
  let map = null, popup = null, ctx = null, card = null;
  let gates = null, gatesPromise = null;
  const markers = {};

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (v) => (v == null ? '—' : `${new Intl.NumberFormat('ja-JP').format(v)}円`);
  const km = (a, b) => {
    const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.57);
  };
  const baseName = (name) => String(name || '').normalize('NFKC').replace(/JCT[・/]?/i, '').replace(/(スマートIC|SIC|IC)$/i, '').trim();

  // ---------- endpoints ----------
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
  const f5 = (x) => Number(x).toFixed(5);
  function apiParam(ep) {
    if (ep.gate) return `${f5(ep.gate.approach[1])},${f5(ep.gate.approach[0])}~${f5(ep.gate.gate[1])},${f5(ep.gate.gate[0])}`;
    return `${f5(ep.ll[1])},${f5(ep.ll[0])}`;
  }
  function encodeEp(ep) {
    return `${ep.kind}~${f5(ep.ll[0])},${f5(ep.ll[1])}~${ep.name.slice(0, MAX_NAME)}`;
  }
  function decodeEp(str) {
    const m = /^(ic|place)~(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)~(.{0,40})$/.exec(str || '');
    if (!m) return null;
    const ll = [Number(m[2]), Number(m[3])];
    if (!(ll[0] > 122 && ll[0] < 154 && ll[1] > 20 && ll[1] < 46)) return null;
    return { kind: m[1], ll, name: m[4] || '選択した地点' };
  }
  async function withGate(ep) {
    if (ep.kind !== 'ic') return ep;
    await loadGates();
    return { ...ep, gate: gateFor(ep.name, ep.ll) };
  }

  // ---------- public helpers for popups ----------
  function buttonsHtml({ kind = 'place', name, ll }) {
    if (!API || !ll) return '';
    const attrs = `data-kind="${esc(kind)}" data-name="${esc(String(name || '').slice(0, MAX_NAME))}" data-ll="${f5(ll[0])},${f5(ll[1])}"`;
    return `<div class="route-set" aria-label="経路・料金">
      <button type="button" data-route-set="o" ${attrs}><b>S</b>ここから</button>
      <button type="button" data-route-set="d" ${attrs}><b>G</b>ここまで</button>
      ${navigator.geolocation ? `<button type="button" class="route-from-here" data-route-from-here ${attrs}>${LOCATE_ICON}現在地からここまで</button>` : ''}
    </div>`;
  }
  function facilityButtonsHtml(props, ll) {
    return isIc(props.code, props.name) ? buttonsHtml({ kind: 'ic', name: props.name, ll }) : '';
  }

  async function setEndpoint(role, ep) {
    S[role] = await withGate(ep);
    resetResult();
    S.error = '';
    popup?.remove();
    ctx.writeHash();
    draw();
    renderCard();
    if (S.o && S.d) compute();
    else fitEndpoints();
  }

  // ---------- current location ----------
  const LOCATE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="7" fill="none"/></svg>';
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
      S[role === 'o' ? 'd' : 'o'] = await withGate(other);
      resetResult();
      popup?.remove();
    }
    S.locating = role;
    S.error = '';
    draw();
    renderCard();
    try {
      const ll = await locate();
      if (!(ll[0] > 122 && ll[0] < 154 && ll[1] > 20 && ll[1] < 46)) throw Object.assign(new Error('outside'), { code: 'outside' });
      S.locating = null;
      await setEndpoint(role, { kind: 'place', name: '現在地', ll, here: true });
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

  function resetResult() {
    S.result = null;
    S.routes = [];
    S.routeIdx = 0;
    S.detours = new Map();
    S.smartVisits = new Map();
    S.detourSel = null;
  }

  // ---------- API ----------
  async function compute(fit = true) {
    if (!S.o || !S.d) return;
    if (km(S.o.ll, S.d.ll) < 0.2) {
      S.seq++;
      S.loading = false;
      resetResult();
      S.error = '出発地と到着地が同じです。';
      draw();
      renderCard();
      return;
    }
    const seq = ++S.seq;
    resetResult();
    S.loading = true;
    S.error = '';
    renderCard();
    const q = new URLSearchParams({ o: apiParam(S.o), d: apiParam(S.d), alt: '1' });
    if (S.t) q.set('t', S.t);
    try {
      const res = await fetch(`${API}/route?${q}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (seq !== S.seq) return;
      if (!res.ok) throw Object.assign(new Error(body.error || String(res.status)), { status: res.status, code: body.error });
      const alts = body.alternatives || [];
      delete body.alternatives;
      S.routes = [body, ...alts.map((a) => ({ ...a, used: body.used, departure: body.departure }))];
      S.routeIdx = 0;
      S.result = body;
    } catch (e) {
      if (seq !== S.seq) return;
      resetResult();
      S.error = errorText(e);
    }
    S.loading = false;
    draw();
    renderCard();
    if (fit) fitRoute();
  }
  function selectRoute(i) {
    if (!S.routes[i] || i === S.routeIdx) return;
    S.routeIdx = i;
    S.result = S.routes[i];
    S.detours = new Map();
    S.smartVisits = new Map();
    S.detourSel = null;
    draw();
    renderCard();
  }
  function errorText(e) {
    if (e.status === 429) return '短時間のリクエストが多すぎます。1分ほど待ってから再試行してください。';
    if (e.code === 'daily_cap') return '本日の経路計算の上限に達しました。明日あらためてお試しください。';
    if (e.status === 404) return '経路が見つかりませんでした。';
    if (e.status === 400) return '指定した地点では計算できません。';
    if (!e.status) return '経路サーバーに接続できません。';
    return '経路の計算に失敗しました。時間をおいて再試行してください。';
  }

  // ---------- temporary exit for charging ----------
  const SAPA_CODES = new Set([2943, 2944]);
  const CANDIDATE_KM = 5;
  const MAX_CANDIDATES = 12;
  let smartPromise = null;
  function loadSmartToll() {
    smartPromise ??= fetch('data/smart_toll.json', { cache: 'no-cache' }).then((r) => r.json()).then((j) => j.pairs || []).catch(() => []);
    return smartPromise;
  }
  function segDistKm(p, a, b) {
    const kx = 111.32 * Math.cos(p[1] * Math.PI / 180), ky = 110.57;
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const u = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    return Math.hypot(ax + u * dx, ay + u * dy);
  }
  /** Chargers near the toll part of the route: `off` needs leaving the expressway, `on` is at an SA/PA. */
  function chargerCandidates() {
    const r = S.result;
    if (!r?.hasToll || !r.tollSpans?.length) return { off: [], on: [] };
    const line = r.line;
    const filter = ctx.getChargerFilter?.() || { tesla: true, flash: true, planned: false };
    const data = ctx.getData();
    const sapa = (data.roadFacilities?.features || []).filter((f) => SAPA_CODES.has(f.properties.code)).map((f) => f.geometry.coordinates);
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + km(line[i - 1], line[i]));
    const segs = [];
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [a, b] of r.tollSpans) {
      for (let i = a; i < b; i++) {
        segs.push(i);
        for (const p of [line[i], line[i + 1]]) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        }
      }
    }
    const pad = 0.07;
    const off = [], on = [];
    for (const f of data.sc?.features || []) {
      const p = f.properties;
      const net = p.network || 'tesla';
      if (!(net === 'tesla' ? filter.tesla : filter.flash)) continue;
      if (p.group !== 'open' && !filter.planned) continue;
      const c = f.geometry.coordinates;
      if (c[0] < minX - pad || c[0] > maxX + pad || c[1] < minY - pad || c[1] > maxY + pad) continue;
      if (km(c, S.o.ll) < 2 || km(c, S.d.ll) < 2) continue;
      let best = Infinity, at = 0;
      for (const i of segs) {
        const d = segDistKm(c, line[i], line[i + 1]);
        if (d < best) { best = d; at = i; }
      }
      if (best > CANDIDATE_KM) continue;
      const label = `${p.name || ''} ${p.facility || ''}`.normalize('NFKC');
      const atSapa = sapa.some((s) => km(s, c) < 0.4) || /(SA|PA|サービスエリア|パーキングエリア)/.test(label);
      const item = { id: String(p.id), name: p.name, network: net, ll: c, d: best, along: cum[at] };
      if (atSapa) { if (best < 1) on.push(item); } else off.push(item);
    }
    off.sort((a, b) => a.along - b.along);
    on.sort((a, b) => a.along - b.along);
    return { off: off.slice(0, MAX_CANDIDATES), on };
  }
  function icNameAt(p) {
    return p ? nearestIc(p) : null;
  }
  const AT_STATION_KM = 0.3;
  const STATION_STOP_MIN = 5;
  const smartLimit = (pr) => pr.minutes || 120;
  /**
   * 賢い料金 (ETC2.0): leave at the designated IC, pass the antenna at the designated 道の駅 and
   * re-enter at the same IC in the same direction within the time limit. The charger may be at the
   * 道の駅 itself or elsewhere (then the 道の駅 must be visited too). EV路外充電 pairs are excluded:
   * they require charging at the 道の駅's own charger, not SC/FLASH.
   */
  async function smartTollMatch(item, exitIc) {
    if (!exitIc) return null;
    const pairs = (await loadSmartToll()).filter((pr) => pr.kind !== 'ev' && baseName(pr.ic) === baseName(exitIc));
    const at = pairs.find((pr) => km(pr.station_coords, item.ll) <= AT_STATION_KM);
    if (at) return { pair: at, atStation: true };
    return pairs[0] ? { pair: pairs[0], atStation: false } : null;
  }
  async function fetchRoute(q) {
    const res = await fetch(`${API}/route?${q}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || String(res.status)), { status: res.status, code: body.error });
    return body;
  }
  const waitOf = (b) => b.sections.reduce((a, s) => a + (s.wait || 0), 0);
  function baseQuery(base) {
    const q = new URLSearchParams({ o: `${base.used.o[0]},${base.used.o[1]}`, d: `${base.used.d[0]},${base.used.d[1]}` });
    if (S.t) q.set('t', S.t);
    return q;
  }
  /**
   * Route that leaves at the 賢い料金 IC, passes the 道の駅 antenna first, charges, and returns to the
   * same IC. Eligible (ETC2.0: same fare as not leaving) when both gates are that IC and the time
   * off the expressway fits the limit.
   */
  async function evalSmartVisit(base, q0, pair, charger, stop) {
    const st = pair.station_coords;
    const q = new URLSearchParams(q0);
    const core = [`${f5(st[1])},${f5(st[0])},${STATION_STOP_MIN}`, `${f5(charger.ll[1])},${f5(charger.ll[0])},${stop}`];
    // pin the exit and the re-entry to the designated IC via its local-road approach point
    // (the mirrored point is tried when the derived approach turns out to be on the mainline side)
    await loadGates();
    const g = gateFor(pair.ic, pair.ic_coords);
    const pins = g ? [g.approach, [2 * g.gate[0] - g.approach[0], 2 * g.gate[1] - g.approach[1]]] : [null];
    let res = null;
    for (const pin of pins) {
      const ap = pin && `${f5(pin[1])},${f5(pin[0])},0`;
      q.set('v', (ap ? [ap, ...core, ap] : core).join('|'));
      const b = await fetchRoute(q);
      const last = b.sections.length - 1;
      const exitIc = icNameAt(b.tolls.filter((t) => t.section === 0).at(-1)?.exit);
      const entryIc = icNameAt(b.tolls.filter((t) => t.section === last)[0]?.entry);
      const sameIc = !!exitIc && exitIc === entryIc && baseName(exitIc) === baseName(pair.ic);
      res = { b, exitIc, entryIc, sameIc };
      if (sameIc) break;
    }
    const { b, exitIc, entryIc, sameIc } = res;
    const wait = waitOf(b);
    const dMin = b.min - wait - base.min;
    const offMin = Math.max(0, dMin) + wait;
    return {
      pair,
      result: b,
      stops: [st, charger.ll],
      dEtc: b.etc - base.etc,
      dKm: Math.round((b.km - base.km) * 10) / 10,
      dMin,
      offMin,
      exitIc, entryIc,
      ok: sameIc && offMin <= smartLimit(pair),
      reason: !sameIc ? 'ic' : offMin > smartLimit(pair) ? 'time' : '',
    };
  }

  // 賢い料金 ICs on the route and chargers reachable from their 道の駅 (proactive suggestions)
  const SMART_IC_KM = 1.5;
  const SMART_CHARGER_KM = 15;
  const SMART_PER_PAIR = 3;
  function tollGeometry(r) {
    const line = r.line;
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + km(line[i - 1], line[i]));
    const segs = [];
    for (const [a, b] of r.tollSpans || []) for (let i = a; i < b; i++) segs.push(i);
    const nearest = (p) => {
      let best = Infinity, at = 0;
      for (const i of segs) {
        const d = segDistKm(p, line[i], line[i + 1]);
        if (d < best) { best = d; at = i; }
      }
      return { d: best, along: cum[at] };
    };
    return { nearest };
  }
  function smartCandidates() {
    const r = S.result;
    if (!r?.hasToll || !S.smartPairs) return [];
    const { nearest } = tollGeometry(r);
    const filter = ctx.getChargerFilter?.() || { tesla: true, flash: true, planned: false };
    const chargers = (ctx.getData().sc?.features || []).filter((f) => {
      const p = f.properties, net = p.network || 'tesla';
      return (net === 'tesla' ? filter.tesla : filter.flash) && (p.group === 'open' || filter.planned);
    });
    const out = [];
    for (const pair of S.smartPairs) {
      if (pair.kind === 'ev' || !pair.ic_coords) continue;
      const onRoute = nearest(pair.ic_coords);
      if (onRoute.d > SMART_IC_KM) continue;
      if (km(pair.ic_coords, S.o.ll) < 1 || km(pair.ic_coords, S.d.ll) < 1) continue;
      const near = chargers
        .map((f) => ({ f, d: km(f.geometry.coordinates, pair.station_coords) }))
        .filter((x) => x.d <= SMART_CHARGER_KM)
        .sort((a, b) => a.d - b.d)
        .slice(0, SMART_PER_PAIR);
      for (const { f, d } of near) {
        const p = f.properties;
        out.push({
          key: `${pair.station}|${p.id}`,
          pair,
          dStation: d,
          along: onRoute.along,
          charger: { id: String(p.id), name: p.name, network: p.network || 'tesla', ll: f.geometry.coordinates },
        });
      }
    }
    return out.sort((a, b) => a.along - b.along || a.dStation - b.dStation);
  }
  async function computeSmart(item) {
    const base = S.result;
    if (!base?.used) return;
    const seq = S.seq, visits = S.smartVisits, stop = S.stop;
    visits.set(item.key, { loading: true });
    S.detourSel = `sv:${item.key}`;
    renderCard();
    let entry;
    try {
      entry = await evalSmartVisit(base, baseQuery(base), item.pair, item.charger, stop);
    } catch (e) {
      entry = { error: errorText(e) };
    }
    if (seq !== S.seq || visits !== S.smartVisits || stop !== S.stop) return;
    visits.set(item.key, entry);
    draw();
    renderCard();
  }
  async function computeDetour(item) {
    const base = S.result;
    if (!base?.used) return;
    const seq = S.seq;
    const detours = S.detours;
    const stop = S.stop;
    detours.set(item.id, { loading: true });
    S.detourSel = item.id;
    renderCard();
    const q = baseQuery(base);
    q.set('v', `${f5(item.ll[1])},${f5(item.ll[0])},${stop}`);
    let entry;
    try {
      const body = await fetchRoute(q);
      const before = body.tolls.filter((t) => t.section === 0);
      const after = body.tolls.filter((t) => t.section === 1);
      const exitIc = icNameAt(before.at(-1)?.exit);
      const entryIc = icNameAt(after[0]?.entry);
      const dMin = body.min - waitOf(body) - base.min;
      const match = await smartTollMatch(item, exitIc);
      entry = {
        result: body,
        stops: [item.ll],
        dEtc: body.etc - base.etc,
        dKm: Math.round((body.km - base.km) * 10) / 10,
        dMin,
        exitIc, entryIc,
        smart: match?.atStation && entryIc === exitIc && stop + Math.max(0, dMin) <= smartLimit(match.pair) ? match.pair : null,
      };
      if (match && !match.atStation) {
        entry.visit = await evalSmartVisit(base, q, match.pair, item, stop);
      }
    } catch (e) {
      if (entry) entry.visitError = errorText(e);
      else entry = { error: errorText(e) };
    }
    // drop results for an older base route or charging duration
    if (seq !== S.seq || detours !== S.detours || stop !== S.stop) return;
    detours.set(item.id, entry);
    draw();
    renderCard();
  }

  // ---------- map ----------
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
        'line-color': ['case', ['get', 'toll'], '#1d4ed8', '#60a5fa'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 12, 6],
      },
    });
    map.addLayer({
      id: 'route-detour', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'detour'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ea580c', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 5], 'line-dasharray': [1.5, 1.2] },
    });
    map.addLayer({
      id: 'route-stop', type: 'circle', source: 'route', filter: ['==', ['get', 'role'], 'stop'],
      paint: { 'circle-radius': 8, 'circle-color': 'rgba(234,88,12,0.15)', 'circle-stroke-color': '#ea580c', 'circle-stroke-width': 2.5 },
    });
    map.addLayer({
      id: 'route-gates', type: 'circle', source: 'route', filter: ['==', ['get', 'role'], 'gate'],
      paint: { 'circle-radius': 4.5, 'circle-color': '#ffffff', 'circle-stroke-color': '#1d4ed8', 'circle-stroke-width': 2.5 },
    });
    map.addLayer({
      id: 'route-cand', type: 'circle', source: 'route', filter: ['==', ['get', 'role'], 'cand'],
      paint: {
        'circle-radius': 9,
        'circle-color': ['case', ['get', 'smart'], '#16a34a', '#ea580c'],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'route-cand-label', type: 'symbol', source: 'route', filter: ['==', ['get', 'role'], 'cand'],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#ffffff' },
    });
    for (const id of ['route-alt', 'route-cand']) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', 'route-alt', (e) => selectRoute(Number(e.features[0].properties.idx)));
    map.on('click', 'route-cand', (e) => {
      const p = e.features[0].properties;
      if (p.smart) {
        const item = smartCandidates().find((c) => c.key === p.key);
        if (item) computeSmart(item);
      } else {
        const item = candidates().off.find((c) => c.id === p.key);
        if (item) computeDetour(item);
      }
      S.collapsed = false;
      card?.querySelector(`[data-cand="${CSS.escape(p.key)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
  const letter = (i) => String.fromCharCode(65 + (i % 26));
  function draw() {
    if (!map?.getSource('route')) return;
    const features = [];
    const r = S.result;
    S.routes.forEach((alt, i) => {
      if (i !== S.routeIdx && alt.line?.length) features.push({ type: 'Feature', properties: { role: 'alt', idx: i }, geometry: { type: 'LineString', coordinates: alt.line } });
    });
    if (r?.line?.length) {
      const inToll = new Uint8Array(r.line.length);
      for (const [a, b] of r.tollSpans || []) for (let i = a; i <= b; i++) inToll[i] = 1;
      // split into toll / non-toll runs so the toll part can be styled
      let start = 0;
      for (let i = 1; i <= r.line.length; i++) {
        if (i === r.line.length || inToll[i] !== inToll[start]) {
          const end = Math.min(i, r.line.length - 1);
          if (end > start) features.push({ type: 'Feature', properties: { role: 'main', toll: !!inToll[start] }, geometry: { type: 'LineString', coordinates: r.line.slice(start, end + 1) } });
          start = i;
        }
      }
      for (const t of r.tolls || []) {
        for (const p of [t.entry, t.exit]) if (p) features.push({ type: 'Feature', properties: { role: 'gate' }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
      }
      if (r.hasToll) {
        candidates().off.forEach((c, i) => features.push({ type: 'Feature', properties: { role: 'cand', smart: false, key: c.id, label: String(i + 1) }, geometry: { type: 'Point', coordinates: c.ll } }));
        smartCandidates().forEach((c, i) => features.push({ type: 'Feature', properties: { role: 'cand', smart: true, key: c.key, label: letter(i) }, geometry: { type: 'Point', coordinates: c.charger.ll } }));
      }
      const selId = String(S.detourSel || '');
      const det = selId && !selId.startsWith('sv:') && S.detours.get(selId.replace(/:visit$/, ''));
      const shown = selId.startsWith('sv:') ? S.smartVisits.get(selId.slice(3)) : selId.endsWith(':visit') ? det?.visit : det;
      if (shown?.result?.line?.length) {
        features.push({ type: 'Feature', properties: { role: 'detour' }, geometry: { type: 'LineString', coordinates: shown.result.line } });
        for (const stop of shown.stops || []) features.push({ type: 'Feature', properties: { role: 'stop' }, geometry: { type: 'Point', coordinates: stop } });
      }
    }
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
    let b = new maplibregl.LngLatBounds(line[0], line[0]);
    for (const p of line) b.extend(p);
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    map.fitBounds(b, { padding: narrow ? { top: 110, bottom: 30, left: 20, right: 20 } : { top: 60, bottom: 60, left: 380, right: 60 }, maxZoom: 12, duration: 700 });
  }
  function fitEndpoints() {
    const ep = S.o || S.d;
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
  function nearestIc(p) {
    const data = ctx.getData().roadFacilities;
    let best = null, bestD = 2.5;
    for (const f of data?.features || []) {
      if (!isIc(f.properties.code, f.properties.name)) continue;
      const d = km(f.geometry.coordinates, [p.lng, p.lat]);
      if (d < bestD) { best = f.properties.name; bestD = d; }
    }
    return best;
  }
  function gateLabel(p) {
    if (!p) return '—';
    const ic = nearestIc(p);
    return ic ? esc(ic.normalize('NFKC')) : `${esc(p.name)}料金所`;
  }
  function defaultTime() {
    const d = new Date(Date.now() + 3600e3);
    d.setMinutes(0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  }
  function fmtMin(m) {
    const h = Math.floor(m / 60);
    return h ? `${h}時間${m % 60}分` : `${m}分`;
  }
  function links() {
    const out = [];
    if (S.o && S.d) {
      out.push(`<a href="https://www.google.com/maps/dir/?api=1&origin=${S.o.ll[1]},${S.o.ll[0]}&destination=${S.d.ll[1]},${S.d.ll[0]}&travelmode=driving" target="_blank" rel="noopener">Googleマップ</a>`);
      if (S.o.kind === 'ic' && S.d.kind === 'ic') {
        const t = (S.t || defaultTime()).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
        const q = new URLSearchParams({
          startPlaceKana: baseName(S.o.name), arrivePlaceKana: baseName(S.d.name), searchHour: String(Number(t[4])), searchMinute: '0',
          kind: '1', carType: '1', priority: '2', roadType1: 'on', roadType2: 'on',
          searchYear: t[1], searchMonth: String(Number(t[2])), searchDay: String(Number(t[3])), selectickindflg: '0',
        });
        out.push(`<a href="https://www.driveplaza.com/dp/SearchQuick?${q}" target="_blank" rel="noopener">公式料金（ドラぷら）</a>`);
      }
    }
    const share = S.o && S.d && !S.o.here && !S.d.here ? '<button type="button" class="share-link" data-route-share>🔗 この経路のリンクをコピー</button>' : '';
    return (out.length ? `<div class="popup-links route-links">${out.join('')}</div>` : '') + share;
  }
  function epRow(role) {
    const ep = S[role];
    const label = role === 'o' ? '出発' : '到着';
    if (!ep) {
      const here = S.locating === role
        ? '<span class="muted route-locating">取得中…</span>'
        : navigator.geolocation ? `<button type="button" class="route-here" data-route-here="${role}" title="現在地を${label}地にする">${LOCATE_ICON}現在地</button>` : '';
      return `<div class="route-ep empty"><span class="route-pin-mini ${role}">${role === 'o' ? 'S' : 'G'}</span>
        <div class="route-search"><input type="search" class="route-q" data-route-q="${role}" value="${esc(S.q[role])}" placeholder="${label}地を検索、または地図で選択" autocomplete="off" spellcheck="false" aria-label="${label}地を検索" aria-autocomplete="list" aria-controls="route-sug-${role}">
        <ul class="route-sug" id="route-sug-${role}" data-route-sug="${role}" role="listbox" hidden></ul></div>${here}</div>`;
    }
    const warn = ep.kind === 'ic' && !ep.gate ? '<span class="route-warn" title="料金所の位置が見つからないため、IC付近の地点から計算します">位置は概略</span>' : '';
    return `<div class="route-ep"><span class="route-pin-mini ${role}">${role === 'o' ? 'S' : 'G'}</span><span class="name">${esc(ep.name.normalize('NFKC'))}</span>${warn}<button type="button" class="route-x" data-route-clear="${role}" aria-label="${label}地を解除">×</button></div>`;
  }
  function renderCard() {
    if (!card) return;
    const focused = document.activeElement?.dataset?.routeQ;
    const idle = !S.o && !S.d;
    card.hidden = false;
    card.classList.toggle('idle', idle);
    const r = S.result;
    let body = '';
    if (idle) {
      body = S.error ? `<p class="route-error">${esc(S.error)}</p>` : '';
    } else if (!S.o || !S.d) {
      body = S.error ? `<p class="route-error">${esc(S.error)}</p>` : '<p class="route-hint">検索のほか、IC・施設・充電器のポップアップや地図の右クリック／長押しでも指定できます。</p>';
    } else if (S.loading) {
      body = '<p class="route-hint">計算中…</p>';
    } else if (S.error) {
      body = `<p class="route-error">${esc(S.error)}</p><button type="button" class="route-retry" data-route-retry>再試行</button>`;
    } else if (r) {
      const tolls = (r.tolls || []).map((t) => `<tr><td>${gateLabel(t.entry)} → ${gateLabel(t.exit)}<br><span class="muted">${esc(t.system)}</span></td><td>${yen(t.etc)}</td></tr>`).join('');
      body = `
        ${altTabs()}
        <div class="route-summary">
          <div><span class="muted">ETC</span><b>${yen(r.etc)}</b></div>
          <div><span class="muted">距離</span><b>${r.km} km</b></div>
          <div><span class="muted">所要</span><b>${fmtMin(r.min)}</b></div>
        </div>
        ${r.cash != null && r.cash !== r.etc ? `<div class="muted route-cash">現金 ${yen(r.cash)}</div>` : ''}
        ${r.hasToll ? `<table class="route-tolls">${tolls}</table>${detourHtml()}` : '<p class="route-hint">この経路は有料道路を使いません（HEREの経路選択による）。</p>'}`;
    }
    const head = `
      <div class="route-head"><h3>経路・料金</h3>
        ${idle ? '' : '<button type="button" class="route-swap" data-route-swap aria-label="出発と到着を入れ替え" title="入れ替え">⇅</button>'}
        <button type="button" class="route-x" data-route-collapse aria-expanded="${!S.collapsed}" aria-label="${S.collapsed ? '開く' : '折りたたむ'}">${S.collapsed ? '▸' : '▾'}</button>
        ${idle ? '' : '<button type="button" class="route-x" data-route-close aria-label="経路をクリア" title="クリア">×</button>'}</div>`;
    if (S.collapsed) {
      const epName = (ep) => (ep ? esc(ep.name.normalize('NFKC')) : '未選択');
      const mini = r && !S.loading && !S.error
        ? `${yen(r.etc)} · ${r.km} km · ${fmtMin(r.min)}`
        : !idle ? `${epName(S.o)} → ${epName(S.d)}` : '';
      card.innerHTML = head + (mini ? `<div class="route-mini">${mini}</div>` : '');
      return;
    }
    if (idle) {
      card.innerHTML = `${head}${epRow('o')}${epRow('d')}${body}`;
    } else {
      card.innerHTML = `${head}
      ${epRow('o')}${epRow('d')}
      <label class="route-time">出発日時 <input type="datetime-local" step="3600" value="${esc(S.t || defaultTime())}" data-route-time></label>
      ${body}
      ${links()}
      <div class="muted route-note">経路・料金：© HERE（所要時間が最短の経路での目安。普通車・ETC。公式の料金と異なる場合があります）｜<a href="about.html#route" target="_blank" rel="noopener">詳しく</a></div>`;
    }
    if (focused) {
      const el = card.querySelector(`[data-route-q="${focused}"]`);
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
  }

  function altTabs() {
    if (S.routes.length < 2) return '';
    return `<div class="route-alts" role="tablist" aria-label="経路の候補">${S.routes.map((rt, i) => `<button type="button" role="tab" aria-selected="${i === S.routeIdx}" class="${i === S.routeIdx ? 'active' : ''}" data-route-alt="${i}">
        <span>ルート${i + 1}</span><b>${yen(rt.etc)}</b><small>${fmtMin(rt.min)} · ${rt.km}km</small></button>`).join('')}</div>`;
  }
  function candidates() {
    const r = S.result;
    const key = JSON.stringify(ctx.getChargerFilter?.() || {});
    if (r._candKey !== key) {
      r._cands = chargerCandidates();
      r._candKey = key;
    }
    return r._cands;
  }
  const signedYen = (v) => (v > 0 ? `+${yen(v)}` : v < 0 ? `−${yen(-v)}` : '±0円');
  function detourRow(item, i) {
    const det = S.detours.get(item.id);
    const dot = `<i class="route-net ${item.network === 'flash' ? 'flash' : 'tesla'}"></i>`;
    let res = `<button type="button" class="route-calc" data-route-detour="${esc(item.id)}">追加料金を計算</button>`;
    if (det?.loading) res = '<span class="muted">計算中…</span>';
    else if (det?.error) res = `<span class="route-error">${esc(det.error)}</span>`;
    else if (det?.result) {
      const exitTxt = det.exitIc && det.entryIc ? `${esc(det.exitIc.normalize('NFKC'))}で降りて${det.entryIc === det.exitIc ? '同じICから戻る' : `${esc(det.entryIc.normalize('NFKC'))}から戻る`}` : '';
      const smart = det.smart
        ? `<div class="route-smart">ETC2.0なら追加料金なし（賢い料金：この充電器は道の駅「${esc(det.smart.station)}」にあり、2時間以内に同じICから戻れば直行と同じ料金）</div>`
        : '';
      const v = det.visit;
      const visit = v
        ? v.ok
          ? `<button type="button" class="route-smart route-visit${S.detourSel === `${item.id}:visit` ? ' active' : ''}" data-route-show="${esc(item.id)}:visit">
              <span>先に道の駅「${esc(v.pair.station)}」に寄ってから充電すれば、ETC2.0で追加料金なし（賢い料金）</span>
              <small>±0円 · ${v.dKm >= 0 ? '+' : '−'}${Math.abs(v.dKm)}km · ${v.dMin >= 0 ? '+' : '−'}${Math.abs(v.dMin)}分（停車時間を除く）· 充電と道の駅${STATION_STOP_MIN}分を含め、降りてから約${Math.round(v.offMin)}分で戻る</small>
            </button>`
          : `<div class="muted route-exit">道の駅「${esc(v.pair.station)}」に寄っても、賢い料金の条件（${esc(String(v.pair.ic).normalize('NFKC'))}で降りて同じICから${smartLimit(v.pair) / 60}時間以内に戻る）を満たさない見込みです</div>`
        : det.visitError ? `<div class="muted route-exit">賢い料金（道の駅経由）の計算に失敗しました</div>` : '';
      res = `<button type="button" class="route-det-result${S.detourSel === item.id ? ' active' : ''}" data-route-show="${esc(item.id)}">
          <b class="${det.dEtc > 0 ? 'up' : ''}">${signedYen(det.dEtc)}</b>
          <span>${det.dKm >= 0 ? '+' : '−'}${Math.abs(det.dKm)}km · ${det.dMin >= 0 ? '+' : '−'}${Math.abs(det.dMin)}分</span>
        </button>${exitTxt ? `<div class="muted route-exit">${exitTxt}</div>` : ''}${smart}${visit}`;
    }
    return `<li data-cand="${esc(item.id)}"><div class="route-cand"><span class="route-num">${i + 1}</span>${dot}<span class="name" title="${esc(item.name)}">${esc(item.name)}</span><span class="muted">${item.d.toFixed(1)}km</span></div>${res}</li>`;
  }
  function smartRow(item, i) {
    const v = S.smartVisits.get(item.key);
    const c = item.charger;
    const dot = `<i class="route-net ${c.network === 'flash' ? 'flash' : 'tesla'}"></i>`;
    const where = item.dStation <= AT_STATION_KM ? '道の駅内' : `道の駅から${item.dStation.toFixed(1)}km`;
    let res = `<button type="button" class="route-calc" data-route-smart="${esc(item.key)}">寄り道を計算</button>`;
    if (v?.loading) res = '<span class="muted">計算中…</span>';
    else if (v?.error) res = `<span class="route-error">${esc(v.error)}</span>`;
    else if (v?.result) {
      const sel = S.detourSel === `sv:${item.key}` ? ' active' : '';
      const detail = `${v.dKm >= 0 ? '+' : '−'}${Math.abs(v.dKm)}km · ${v.dMin >= 0 ? '+' : '−'}${Math.abs(v.dMin)}分（停車時間を除く）· 降りてから約${Math.round(v.offMin)}分で戻る`;
      res = v.ok
        ? `<button type="button" class="route-smart route-visit${sel}" data-route-show="sv:${esc(item.key)}"><span>ETC2.0なら直行と同じ料金（±0円）</span><small>${detail}</small></button>`
        : `<button type="button" class="route-det-result${sel}" data-route-show="sv:${esc(item.key)}"><b class="${v.dEtc > 0 ? 'up' : ''}">${signedYen(v.dEtc)}</b><span>${v.dKm >= 0 ? '+' : '−'}${Math.abs(v.dKm)}km · ${v.dMin >= 0 ? '+' : '−'}${Math.abs(v.dMin)}分</span></button>
           <div class="muted route-exit">${v.reason === 'time' ? `戻るまで約${Math.round(v.offMin)}分で、${smartLimit(item.pair) / 60}時間を超えるため対象外の見込み（充電時間を短くすると対象になる場合があります）` : `同じIC（${esc(String(item.pair.ic).normalize('NFKC'))}）から戻る経路にならないため対象外の見込み`}</div>`;
    }
    return `<li data-cand="${esc(item.key)}"><div class="route-cand"><span class="route-num smart">${letter(i)}</span>${dot}<span class="name" title="${esc(c.name)}">${esc(c.name)}</span><span class="muted">${where}</span></div>${res}</li>`;
  }
  function smartHtml() {
    const list = smartCandidates();
    if (!list.length) return '';
    const groups = [];
    for (const it of list) {
      const g = groups.at(-1);
      if (g && g.pair === it.pair) g.items.push(it);
      else groups.push({ pair: it.pair, items: [it] });
    }
    return `<div class="route-smart-list">
      <div class="route-smart-head">賢い料金で寄れる充電器<small>ETC2.0車：${groups.length === 1 ? '' : '各'}ICで降りて、先に道の駅に寄ってから充電し、2時間以内に同じICから同じ方向へ戻れば直行と同じ料金</small></div>
      ${groups.map((g) => `<div class="route-smart-pair">${esc(String(g.pair.ic).normalize('NFKC'))} ⇄ 道の駅「${esc(g.pair.station)}」</div>
        <ul class="route-cands">${g.items.map((it) => smartRow(it, list.indexOf(it))).join('')}</ul>`).join('')}
    </div>`;
  }
  function detourHtml() {
    const { off, on } = candidates();
    const stopOpts = [15, 20, 30, 45, 60, 90].map((m) => `<option value="${m}"${m === S.stop ? ' selected' : ''}>${m}分</option>`).join('');
    const onTxt = on.length
      ? `<div class="muted route-onhw">SA/PAの充電器（降りずに充電）：${on.slice(0, 4).map((c) => esc(c.name)).join('、')}${on.length > 4 ? ` ほか${on.length - 4}件` : ''}</div>`
      : '';
    return `<details class="route-detour" open>
      <summary>充電で一時退出したときの料金</summary>
      <label class="route-stop">充電時間 <select data-route-stop>${stopOpts}</select></label>
      ${smartHtml()}
      ${off.length ? `<ul class="route-cands">${off.map((c, i) => detourRow(c, i)).join('')}</ul>` : '<p class="route-hint">経路の有料区間から5km以内に、高速道路を降りて使う充電器はありません。</p>'}
      ${onTxt}
      <div class="muted route-note">一度降りると料金が2回分に分かれ、ターミナルチャージや長距離逓減の分だけ高くなることがあります。直行した場合との差額です（距離・時間は充電時間を除く）。「賢い料金」はETC2.0車で、対象の道の駅の出入口にあるアンテナの通過が条件です。</div>
    </details>`;
  }

  // ---------- search (same index and sources as the map search) ----------
  const sugState = { o: { rows: [], active: -1, seq: 0 }, d: { rows: [], active: -1, seq: 0 } };
  let sugTimer = null;
  const sugEl = (role) => card?.querySelector(`[data-route-sug="${role}"]`);
  function renderSug(role, rows, { loading = false, empty = false } = {}) {
    const st = sugState[role];
    st.rows = rows;
    if (st.active >= rows.length) st.active = -1;
    const el = sugEl(role);
    if (!el) return;
    const info = (k) => window.MapSearch?.kindInfo?.(k) || { icon: '📍', label: '' };
    let html = rows.map((r, i) => `<li role="option" data-i="${i}" class="${i === st.active ? 'on' : ''}"><span class="k" aria-hidden="true">${info(r.kind).icon}</span><span class="t"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></li>`).join('');
    if (loading) html += '<li class="st">住所・地名・施設を検索中…</li>';
    else if (empty) html += '<li class="st">見つかりませんでした</li>';
    else if (!rows.some((r) => r.kind === 'gsi' || r.kind === 'osm')) html += '<li class="st more" data-more>↵ 住所・地名・施設（駅など）をさらに検索</li>';
    el.innerHTML = html;
    el.hidden = false;
  }
  function closeSug(role) {
    const el = sugEl(role);
    if (el) el.hidden = true;
    sugState[role].seq++;
    sugState[role].active = -1;
  }
  function suggestLocal(role) {
    const q = S.q[role].trim();
    if (!q || !window.MapSearch?.local) { closeSug(role); return; }
    sugState[role].seq++;
    renderSug(role, window.MapSearch.local(q));
  }
  async function searchRemote(role) {
    const q = S.q[role].trim();
    if (!q || !window.MapSearch?.remote) return;
    const st = sugState[role];
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
    if (r.kind === 'ic' && isIc(r.code, r.label)) return { kind: 'ic', name: r.label, ll: r.coords };
    return { kind: 'place', name: String(r.label).slice(0, MAX_NAME), ll: r.coords };
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
    sugState[role].active = -1;
    clearTimeout(sugTimer);
    sugTimer = setTimeout(() => suggestLocal(role), 80);
  }
  function onSearchKey(e) {
    const role = e.target.dataset?.routeQ;
    if (!role) return;
    e.stopPropagation();
    const st = sugState[role];
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
      const ll = set.dataset.ll.split(',').map(Number);
      setEndpoint(set.dataset.routeSet, { kind: set.dataset.kind === 'ic' ? 'ic' : 'place', name: set.dataset.name || '選択した地点', ll });
      return;
    }
    const fromHere = e.target.closest('[data-route-from-here]');
    if (fromHere) {
      const ll = fromHere.dataset.ll.split(',').map(Number);
      useHere('o', { kind: fromHere.dataset.kind === 'ic' ? 'ic' : 'place', name: fromHere.dataset.name || '選択した地点', ll });
      return;
    }
    if (!card?.contains(e.target)) return;
    const sug = e.target.closest('[data-route-sug]');
    if (sug) {
      const role = sug.dataset.routeSug;
      const li = e.target.closest('li[data-i]');
      if (li) pickResult(role, sugState[role].rows[Number(li.dataset.i)]);
      else if (e.target.closest('[data-more]')) searchRemote(role);
      return;
    }
    const here = e.target.closest('[data-route-here]');
    if (here) {
      useHere(here.dataset.routeHere);
      return;
    }
    const clear = e.target.closest('[data-route-clear]');
    if (clear) {
      S[clear.dataset.routeClear] = null;
      resetResult();
      S.error = '';
      S.seq++;
      S.loading = false;
      update();
    } else if (e.target.closest('[data-route-close]')) {
      clearAll();
    } else if (e.target.closest('[data-route-swap]')) {
      [S.o, S.d] = [S.d, S.o];
      resetResult();
      update();
      compute();
    } else if (e.target.closest('[data-route-collapse]')) {
      S.collapsed = !S.collapsed;
      renderCard();
    } else if (e.target.closest('[data-route-retry]')) {
      compute();
    } else if (e.target.closest('[data-route-detour]')) {
      const id = e.target.closest('[data-route-detour]').dataset.routeDetour;
      const item = S.result && candidates().off.find((c) => c.id === id);
      if (item) computeDetour(item);
    } else if (e.target.closest('[data-route-alt]')) {
      selectRoute(Number(e.target.closest('[data-route-alt]').dataset.routeAlt));
    } else if (e.target.closest('[data-route-share]')) {
      copyRouteLink(e.target.closest('[data-route-share]'));
    } else if (e.target.closest('[data-route-smart]')) {
      const key = e.target.closest('[data-route-smart]').dataset.routeSmart;
      const item = S.result && smartCandidates().find((c) => c.key === key);
      if (item) computeSmart(item);
    } else if (e.target.closest('[data-route-show]')) {
      const id = e.target.closest('[data-route-show]').dataset.routeShow;
      S.detourSel = S.detourSel === id ? null : id;
      draw();
      renderCard();
    }
  }
  async function copyRouteLink(button) {
    ctx.writeHash();
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = '✓ リンクをコピーしました';
      button.classList.add('copied');
      setTimeout(() => { button.textContent = '🔗 この経路のリンクをコピー'; button.classList.remove('copied'); }, 2000);
    } catch {
      window.prompt('このURLをコピーしてください', url);
    }
  }
  function onChange(e) {
    if (e.target.matches('[data-route-stop]')) {
      S.stop = Number(e.target.value) || 30;
      S.detours = new Map();
      S.smartVisits = new Map();
      S.detourSel = null;
      draw();
      renderCard();
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
    resetResult();
    S.error = '';
    S.loading = false;
    S.seq++;
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
    if ((S.o || S.d) && S.t) p.set('rt', S.t);
  }
  async function restore() {
    const p = initialHash;
    const o = decodeEp(p.get('ro'));
    const d = decodeEp(p.get('rd'));
    const t = p.get('rt') || '';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) S.t = t;
    if (!o && !d) return;
    S.o = o ? await withGate(o) : null;
    S.d = d ? await withGate(d) : null;
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
      if (S.q[role].trim()) suggestLocal(role);
    });
    card.addEventListener('focusout', (e) => {
      const role = e.target.dataset?.routeQ;
      if (role) setTimeout(() => { if (document.activeElement !== e.target) closeSug(role); }, 150);
    });
    // compact by default on small screens so the map stays usable
    S.collapsed = window.matchMedia('(max-width: 760px)').matches;
    bindPointPicking();
    loadSmartToll().then((pairs) => { S.smartPairs = pairs; if (S.result) renderCard(); });
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
