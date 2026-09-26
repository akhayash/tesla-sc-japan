// Route and expressway fare between two points (IC, POI, charger or any map point).
// Routing and tolls come from HERE through the relay in api/ (the key stays server-side).
// Results are kept only in memory for the current view (HERE terms forbid caching/sharing results).
(() => {
  'use strict';

  const API = String(window.ROUTE_API || '').replace(/\/$/, '');
  const IC_CODES = new Set([2941, 2945]);
  const MAX_NAME = 40;

  const S = { o: null, d: null, t: '', result: null, loading: false, error: '', seq: 0 };
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
  const baseName = (name) => String(name || '').normalize('NFKC').replace(/(スマートIC|IC)$/i, '').trim();

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
    </div>`;
  }
  function facilityButtonsHtml(props, ll) {
    return IC_CODES.has(Number(props.code)) ? buttonsHtml({ kind: 'ic', name: props.name, ll }) : '';
  }

  async function setEndpoint(role, ep) {
    S[role] = await withGate(ep);
    S.result = null;
    S.error = '';
    popup?.remove();
    ctx.writeHash();
    draw();
    renderCard();
    if (S.o && S.d) compute();
    else fitEndpoints();
  }

  // ---------- API ----------
  async function compute(fit = true) {
    if (!S.o || !S.d) return;
    if (km(S.o.ll, S.d.ll) < 0.2) {
      S.error = '出発地と到着地が同じです。';
      renderCard();
      return;
    }
    const seq = ++S.seq;
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
      S.result = null;
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
    map.fitBounds(b, { padding: narrow ? { top: 60, bottom: 260, left: 30, right: 30 } : { top: 60, bottom: 60, left: 380, right: 60 }, maxZoom: 12, duration: 700 });
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
    if (!ep) return `<div class="route-ep empty"><span class="route-pin-mini ${role}">${role === 'o' ? 'S' : 'G'}</span><span>${label}地を選んでください</span></div>`;
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
        ${r.hasToll ? `<table class="route-tolls">${tolls}</table>` : '<p class="route-hint">この経路は有料道路を使いません（HEREの経路選択による）。</p>'}`;
    }
    card.innerHTML = `
      <div class="route-head"><h3>経路・料金</h3>
        <button type="button" class="route-swap" data-route-swap aria-label="出発と到着を入れ替え" title="入れ替え">⇅</button>
        <button type="button" class="route-x" data-route-close aria-label="経路を閉じる">×</button></div>
      ${epRow('o')}${epRow('d')}
      <label class="route-time">出発日時 <input type="datetime-local" step="3600" value="${esc(S.t || defaultTime())}" data-route-time></label>
      ${body}
      ${links()}
      <div class="muted route-note">経路・料金：HERE（所要時間が最短の経路での目安。普通車・ETC。公式の料金と異なる場合があります）</div>`;
  }

  // ---------- events ----------
  function onClick(e) {
    const set = e.target.closest('[data-route-set]');
    if (set) {
      const ll = set.dataset.ll.split(',').map(Number);
      setEndpoint(set.dataset.routeSet, { kind: set.dataset.kind === 'ic' ? 'ic' : 'place', name: set.dataset.name || '選択した地点', ll });
      return;
    }
    if (!card?.contains(e.target)) return;
    const clear = e.target.closest('[data-route-clear]');
    if (clear) {
      S[clear.dataset.routeClear] = null;
      S.result = null;
      S.error = '';
      S.seq++;
      S.loading = false;
      update();
    } else if (e.target.closest('[data-route-close]')) {
      clearAll();
    } else if (e.target.closest('[data-route-swap]')) {
      [S.o, S.d] = [S.d, S.o];
      S.result = null;
      update();
      compute();
    } else if (e.target.closest('[data-route-retry]')) {
      compute();
    }
  }
  function onChange(e) {
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
    S.o = S.d = S.result = null;
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
    if (S.o) p.set('ro', encodeEp(S.o));
    if (S.d) p.set('rd', encodeEp(S.d));
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
