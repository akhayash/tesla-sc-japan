// Route and expressway fare between two points (IC, POI, charger or any map point).
// Routing and tolls come from HERE through the relay in api/ (the key stays server-side).
// Results are kept only in memory for the current view (HERE terms forbid caching/sharing results).
(() => {
  'use strict';

  const API = String(window.ROUTE_API || '').replace(/\/$/, '');
  const IC_CODES = new Set([2941, 2945]);
  const MAX_NAME = 40;

  const S = { o: null, d: null, t: '', result: null, loading: false, error: '', seq: 0, stop: 30, detours: new Map(), detourSel: null };
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
  const baseName = (name) => String(name || '').normalize('NFKC').replace(/(スマートIC|SIC|IC)$/i, '').trim();

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
    for (const g of gates || []) {
      const d = km([g[1], g[2]], ll);
      if (g[0] === name && d < 3 && d < bestD) { best = g; bestD = d; }
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
    return IC_CODES.has(Number(props.code)) ? buttonsHtml({ kind: 'ic', name: props.name, ll }) : '';
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
    S.detours = new Map();
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
    const q = new URLSearchParams({ o: apiParam(S.o), d: apiParam(S.d) });
    if (S.t) q.set('t', S.t);
    try {
      const res = await fetch(`${API}/route?${q}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (seq !== S.seq) return;
      if (!res.ok) throw Object.assign(new Error(body.error || String(res.status)), { status: res.status, code: body.error });
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
  async function smartTollMatch(item, exitIc, entryIc, stop) {
    if (!exitIc || exitIc !== entryIc) return null;
    const pairs = await loadSmartToll();
    const ic = baseName(exitIc);
    const limit = (pr) => pr.minutes || (pr.kind === 'ev' ? 60 : 120);
    return pairs.find((pr) => baseName(pr.ic) === ic && km(pr.station_coords, item.ll) <= 2 && stop <= limit(pr)) || null;
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
    const q = new URLSearchParams({
      o: `${base.used.o[0]},${base.used.o[1]}`,
      d: `${base.used.d[0]},${base.used.d[1]}`,
      v: `${f5(item.ll[1])},${f5(item.ll[0])},${stop}`,
    });
    if (S.t) q.set('t', S.t);
    let entry;
    try {
      const res = await fetch(`${API}/route?${q}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error || String(res.status)), { status: res.status, code: body.error });
      const before = body.tolls.filter((t) => t.section === 0);
      const after = body.tolls.filter((t) => t.section === 1);
      const exitIc = icNameAt(before.at(-1)?.exit);
      const entryIc = icNameAt(after[0]?.entry);
      const wait = body.sections.reduce((a, s) => a + (s.wait || 0), 0);
      entry = {
        result: body,
        stopLl: item.ll,
        dEtc: body.etc - base.etc,
        dKm: Math.round((body.km - base.km) * 10) / 10,
        dMin: body.min - wait - base.min,
        exitIc, entryIc,
        smart: await smartTollMatch(item, exitIc, entryIc, stop),
      };
    } catch (e) {
      entry = { error: errorText(e) };
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
  }
  function draw() {
    if (!map?.getSource('route')) return;
    const features = [];
    const r = S.result;
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
      const det = S.detourSel && S.detours.get(S.detourSel);
      if (det?.result?.line?.length) {
        features.push({ type: 'Feature', properties: { role: 'detour' }, geometry: { type: 'LineString', coordinates: det.result.line } });
        const stop = det.stopLl;
        if (stop) features.push({ type: 'Feature', properties: { role: 'stop' }, geometry: { type: 'Point', coordinates: stop } });
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
      if (!IC_CODES.has(f.properties.code)) continue;
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
    return out.length ? `<div class="popup-links route-links">${out.join('')}</div>` : '';
  }
  function epRow(role) {
    const ep = S[role];
    const label = role === 'o' ? '出発' : '到着';
    if (!ep) {
      const here = S.locating === role
        ? '<span class="muted route-locating">現在地を取得中…</span>'
        : navigator.geolocation ? `<button type="button" class="route-here" data-route-here="${role}">${LOCATE_ICON}現在地</button>` : '';
      return `<div class="route-ep empty"><span class="route-pin-mini ${role}">${role === 'o' ? 'S' : 'G'}</span><span class="name">${label}地を選んでください</span>${here}</div>`;
    }
    const warn = ep.kind === 'ic' && !ep.gate ? '<span class="route-warn" title="料金所の位置が見つからないため、IC付近の地点から計算します">位置は概略</span>' : '';
    return `<div class="route-ep"><span class="route-pin-mini ${role}">${role === 'o' ? 'S' : 'G'}</span><span class="name">${esc(ep.name.normalize('NFKC'))}</span>${warn}<button type="button" class="route-x" data-route-clear="${role}" aria-label="${label}地を解除">×</button></div>`;
  }
  function renderCard() {
    if (!card) return;
    const active = !!(S.o || S.d);
    card.hidden = !active;
    if (!active) return;
    const r = S.result;
    let body = '';
    if (!S.o || !S.d) {
      body = '<p class="route-hint">IC・施設・充電器のポップアップ、または地図の右クリック／長押しで地点を指定できます。</p>';
    } else if (S.loading) {
      body = '<p class="route-hint">計算中…</p>';
    } else if (S.error) {
      body = `<p class="route-error">${esc(S.error)}</p><button type="button" class="route-retry" data-route-retry>再試行</button>`;
    } else if (r) {
      const tolls = (r.tolls || []).map((t) => `<tr><td>${gateLabel(t.entry)} → ${gateLabel(t.exit)}<br><span class="muted">${esc(t.system)}</span></td><td>${yen(t.etc)}</td></tr>`).join('');
      body = `
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
        <button type="button" class="route-swap" data-route-swap aria-label="出発と到着を入れ替え" title="入れ替え">⇅</button>
        <button type="button" class="route-x" data-route-collapse aria-expanded="${!S.collapsed}" aria-label="${S.collapsed ? '詳細を開く' : '折りたたむ'}">${S.collapsed ? '▸' : '▾'}</button>
        <button type="button" class="route-x" data-route-close aria-label="経路を閉じる">×</button></div>`;
    if (S.collapsed) {
      card.innerHTML = head + (r && !S.loading && !S.error ? `<div class="route-mini">${yen(r.etc)} · ${r.km} km · ${fmtMin(r.min)}</div>` : '');
      return;
    }
    card.innerHTML = `${head}
      ${epRow('o')}${epRow('d')}
      <label class="route-time">出発日時 <input type="datetime-local" step="3600" value="${esc(S.t || defaultTime())}" data-route-time></label>
      ${body}
      ${links()}
      <div class="muted route-note">経路・料金：© HERE（所要時間が最短の経路での目安。普通車・ETC。公式の料金と異なる場合があります）｜<a href="about.html#route" target="_blank" rel="noopener">詳しく</a></div>`;
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
  function detourRow(item) {
    const det = S.detours.get(item.id);
    const dot = `<i class="route-net ${item.network === 'flash' ? 'flash' : 'tesla'}"></i>`;
    let res = `<button type="button" class="route-calc" data-route-detour="${esc(item.id)}">追加料金を計算</button>`;
    if (det?.loading) res = '<span class="muted">計算中…</span>';
    else if (det?.error) res = `<span class="route-error">${esc(det.error)}</span>`;
    else if (det?.result) {
      const exitTxt = det.exitIc && det.entryIc ? `${esc(det.exitIc.normalize('NFKC'))}で降りて${det.entryIc === det.exitIc ? '同じICから戻る' : `${esc(det.entryIc.normalize('NFKC'))}から戻る`}` : '';
      const smart = det.smart
        ? `<div class="route-smart">ETC2.0なら追加料金なし（${det.smart.kind === 'ev' ? 'EV路外充電・60分以内' : '賢い料金・2時間以内'}）</div>`
        : '';
      res = `<button type="button" class="route-det-result${S.detourSel === item.id ? ' active' : ''}" data-route-show="${esc(item.id)}">
          <b class="${det.dEtc > 0 ? 'up' : ''}">${signedYen(det.dEtc)}</b>
          <span>${det.dKm >= 0 ? '+' : '−'}${Math.abs(det.dKm)}km · ${det.dMin >= 0 ? '+' : '−'}${Math.abs(det.dMin)}分</span>
        </button>${exitTxt ? `<div class="muted route-exit">${exitTxt}</div>` : ''}${smart}`;
    }
    return `<li><div class="route-cand">${dot}<span class="name" title="${esc(item.name)}">${esc(item.name)}</span><span class="muted">${item.d.toFixed(1)}km</span></div>${res}</li>`;
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
      ${off.length ? `<ul class="route-cands">${off.map(detourRow).join('')}</ul>` : '<p class="route-hint">経路の有料区間から5km以内に、高速道路を降りて使う充電器はありません。</p>'}
      ${onTxt}
      <div class="muted route-note">一度降りると料金が2回分に分かれ、ターミナルチャージや長距離逓減の分だけ高くなることがあります。直行した場合との差額です（距離・時間は充電時間を除く）。</div>
    </details>`;
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
    } else if (e.target.closest('[data-route-show]')) {
      const id = e.target.closest('[data-route-show]').dataset.routeShow;
      S.detourSel = S.detourSel === id ? null : id;
      draw();
      renderCard();
    }
  }
  function onChange(e) {
    if (e.target.matches('[data-route-stop]')) {
      S.stop = Number(e.target.value) || 30;
      S.detours = new Map();
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
    bindPointPicking();
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
