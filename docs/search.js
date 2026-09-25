/* Map search: local index (chargers, municipalities, road facilities, 道の駅, malls) first,
 * then GSI address search and Photon (OpenStreetMap) queried in parallel on Enter.
 * Exposes window.MapSearch; app.js calls init() once the data and map are ready and update() on every render.
 */
(() => {
  'use strict';

  const GSI_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
  const PHOTON_URL = 'https://photon.komoot.io/api/?limit=8&bbox=122,20,154,46&q=';
  const TIMEOUT_MS = 3000;
  const MAX_LOCAL = 8;
  const KIND = {
    pref: { icon: '🗾', label: '都道府県' },
    muni: { icon: '🏙️', label: '市区町村' },
    tesla: { icon: '⚡', label: 'Tesla SC' },
    flash: { icon: '⚡', label: 'FLASH' },
    sa: { icon: '🅿️', label: 'SA/PA' },
    ic: { icon: '🛣️', label: 'IC/JCT' },
    michinoeki: { icon: '🏞️', label: '道の駅' },
    mall: { icon: '🛍️', label: 'モール' },
    gsi: { icon: '📍', label: '住所・地名' },
    osm: { icon: '📌', label: '施設（OSM）' },
    here: { icon: '🎯', label: '現在地' },
  };
  const KIND_ORDER = ['pref', 'muni', 'sa', 'ic', 'michinoeki', 'tesla', 'flash', 'mall'];

  let map, opts, index = [], poiLoaded = false, marker = null, current = null;
  let seq = 0, inflight = null, active = -1, rows = [], timer = null;
  const cache = new Map();
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- normalisation ----------
  function norm(s) {
    return String(s ?? '').normalize('NFKC').toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[ゖヶケ]/g, 'け').replace(/[ゕヵ]/g, 'か')
      .replace(/[\s・･\-‐－ー—–_,.、。()（）「」'’"]/g, '');
  }
  const tokens = (q) => String(q).normalize('NFKC').split(/\s+/).map(norm).filter(Boolean);

  // ---------- local index ----------
  function ringArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(a / 2);
  }
  function mainShape(geom) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    let best = null, ba = -1;
    for (const p of polys) {
      const a = ringArea(p[0]);
      if (a > ba) { ba = a; best = p[0]; }
    }
    if (!best) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0;
    for (const [x, y] of best) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      cx += x; cy += y;
    }
    return { bbox: [minX, minY, maxX, maxY], center: [cx / best.length, cy / best.length] };
  }
  function add(kind, label, sub, coords, extra = {}) {
    if (!label || !coords) return;
    index.push({ kind, label, sub: sub || '', coords, n: norm(label), n2: norm(`${sub || ''} ${extra.alt || ''}`), ...extra });
  }
  function buildIndex() {
    const { sc, roadFacilities, stats, unitGeo } = opts.getData();
    for (const f of unitGeo.pref.features) {
      const s = mainShape(f.geometry), rec = stats.pref[f.properties.code];
      if (s && rec) add('pref', rec.name, '', s.center, { bbox: s.bbox });
    }
    const seen = new Set();
    for (const unit of ['muni_ward', 'muni_city']) {
      for (const f of unitGeo[unit].features) {
        const code = f.properties.code, rec = stats[unit][code];
        if (!rec || seen.has(code)) continue;
        seen.add(code);
        const s = mainShape(f.geometry);
        if (s) add('muni', rec.name, rec.pref, s.center, { bbox: s.bbox, alt: rec.pref + rec.name });
      }
    }
    for (const f of sc.features) {
      const p = f.properties;
      if (p.group === 'closed') continue;
      const net = p.network === 'flash' ? 'flash' : 'tesla';
      const label = String(p.name || '').replace(/, Japan\b/, '');
      const status = p.group === 'open' ? '' : '（計画中）';
      add(net, label + status, net === 'flash' ? p.address : p.facility, f.geometry.coordinates, { id: p.id, alt: `${p.facility || ''} ${p.address || ''}` });
    }
    for (const f of roadFacilities.features) {
      const p = f.properties;
      const kind = p.code === 2943 || p.code === 2944 ? 'sa' : 'ic';
      add(kind, String(p.name || '').normalize('NFKC'), p.type, f.geometry.coordinates);
    }
  }
  function loadPoi() {
    if (poiLoaded) return;
    poiLoaded = true;
    fetch('data/poi.json').then((r) => r.json()).then((d) => {
      for (const [lon, lat, name] of d.michinoeki || []) add('michinoeki', name, '', [lon, lat]);
      for (const [lon, lat, name] of d.mall || []) add('mall', name, '', [lon, lat]);
      if (input && document.activeElement === input && input.value.trim() && !(inflight && !inflight.signal.aborted)) suggest();
    }).catch(() => { poiLoaded = false; });
  }
  function searchLocal(q) {
    const tk = tokens(q);
    if (!tk.length) return [];
    const full = tk.join('');
    const out = [];
    for (const e of index) {
      let score;
      if (e.n === full) score = 0;
      else if (e.n.startsWith(full)) score = 1;
      else if (e.n.includes(full)) score = 2;
      else if (tk.every((t) => e.n.includes(t) || e.n2.includes(t))) score = 3;
      else continue;
      out.push({ e, score, k: KIND_ORDER.indexOf(e.kind), len: e.n.length });
    }
    out.sort((a, b) => a.score - b.score || a.k - b.k || a.len - b.len);
    return out.slice(0, MAX_LOCAL).map((o) => ({ ...o.e, score: o.score }));
  }

  // ---------- remote (parallel, cancellable) ----------
  async function fetchJson(url, signal) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  function stripAddressTail(s) {
    return s.replace(/[0-9０-９一二三四五六七八九十〇]+(丁目|番地?|号)?[0-9０-９\-－ー−の番地号]*$/u, '');
  }
  async function searchGsi(q, signal) {
    const key = `g:${q}`;
    if (cache.has(key)) return cache.get(key);
    const d = await fetchJson(GSI_URL + encodeURIComponent(q), signal);
    const tk = tokens(stripAddressTail(q.trim()) || q);
    const res = (d || []).slice(0, 30).map((f) => {
      const title = f.properties?.title || '';
      const n = norm(title);
      return { kind: 'gsi', label: title, sub: '国土地理院 住所検索', coords: f.geometry.coordinates, fine: tk.every((t) => n.includes(t)) };
    }).filter((r) => r.label && Array.isArray(r.coords));
    res.sort((a, b) => Number(b.fine) - Number(a.fine));
    const nq = tk.join('');
    const grams = new Set(Array.from({ length: Math.max(0, nq.length - 1) }, (_, i) => nq.slice(i, i + 2)));
    const related = (r) => { const n = norm(r.label); return [...grams].some((g) => n.includes(g)); };
    const out = res.some((r) => r.fine) ? res.filter((r) => r.fine).slice(0, 5) : res.filter(related).slice(0, 1);
    cache.set(key, out);
    return out;
  }
  const OSM_SKIP = new Set(['footway', 'steps', 'path', 'platform', 'bicycle_rental', 'parking_entrance', 'elevator', 'entrance']);
  async function searchPhoton(q, signal) {
    const key = `p:${q}`;
    if (cache.has(key)) return cache.get(key);
    const d = await fetchJson(PHOTON_URL + encodeURIComponent(q), signal);
    const nq = tokens(q).join('');
    const res = (d?.features || []).filter((f) => f.properties?.name && f.properties.countrycode === 'JP'
      && (!OSM_SKIP.has(f.properties.osm_value) || norm(f.properties.name) === nq))
      .map((f) => {
        const p = f.properties;
        const sub = [p.state, p.city || p.county, p.district || p.locality].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' ');
        return { kind: 'osm', label: p.name, sub: sub ? `${sub}（OpenStreetMap）` : 'OpenStreetMap', coords: f.geometry.coordinates, exact: norm(p.name) === nq };
      });
    res.sort((a, b) => Number(b.exact) - Number(a.exact));
    const seen = new Set();
    const out = res.filter((r) => { const k = r.label + r.sub; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
    cache.set(key, out);
    return out;
  }

  // ---------- UI ----------
  let root, input, list, card, hint;
  function buildUi() {
    root = document.createElement('div');
    root.className = 'maplibregl-ctrl map-search';
    root.innerHTML = `
      <div class="ms-bar" role="search">
        <svg class="ms-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
        <input type="search" id="map-search-input" placeholder="地名・住所・充電器・SA/PAを検索" autocomplete="off" spellcheck="false"
          role="combobox" aria-expanded="false" aria-controls="map-search-list" aria-autocomplete="list" aria-label="地図を検索">
        <button type="button" class="ms-clear" aria-label="検索をクリア" hidden>×</button>
        <button type="button" class="ms-geo" aria-label="現在地を表示" title="現在地">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
        </button>
      </div>
      <ul class="ms-list" id="map-search-list" role="listbox" hidden></ul>
      <div class="ms-hint" hidden></div>
      <div class="ms-card" hidden></div>`;
    input = $('input', root); list = $('.ms-list', root); card = $('.ms-card', root); hint = $('.ms-hint', root);
    const clearBtn = $('.ms-clear', root);
    input.addEventListener('input', () => {
      clearBtn.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(suggest, 80);
    });
    input.addEventListener('focus', () => { loadPoi(); if (input.value.trim()) suggest(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!rows.length) return;
        e.preventDefault();
        setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.isComposing || e.keyCode === 229) return;
        if (active >= 0 && rows[active]) pick(rows[active]);
        else submit();
      } else if (e.key === 'Escape') {
        cancelSearch();
        closeList();
      }
    });
    clearBtn.addEventListener('click', () => {
      input.value = ''; clearBtn.hidden = true; closeList(); clearSelection(); input.focus();
    });
    $('.ms-geo', root).addEventListener('click', locate);
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) pick(rows[Number(li.dataset.i)]);
      else if (e.target.closest('[data-more]')) submit();
    });
    input.addEventListener('blur', () => { cancelSearch(); setTimeout(closeList, 120); });
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-charger]');
      if (b) { opts.openCharger(b.dataset.charger); return; }
      if (e.target.closest('.ms-card-close')) clearSelection();
    });
    ['mousedown', 'touchstart', 'wheel', 'dblclick', 'click'].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));
    return root;
  }
  function itemHtml(r, i) {
    const k = KIND[r.kind];
    return `<li role="option" id="ms-opt-${i}" data-i="${i}" class="kind-${r.kind}"><span class="ms-k" aria-hidden="true">${k.icon}</span>
      <span class="ms-t"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span><em>${esc(k.label)}</em></li>`;
  }
  const rowKey = (r) => `${r.kind}|${r.label}|${r.coords}`;
  function renderList(groups, { loading = false, empty = false, keepActive = false } = {}) {
    const prev = keepActive && active >= 0 && rows[active] ? rowKey(rows[active]) : null;
    rows = groups.flat();
    active = prev ? rows.findIndex((r) => rowKey(r) === prev) : -1;
    let html = rows.map(itemHtml).join('');
    if (loading) html += '<li class="ms-status" aria-live="polite">住所・地名・施設を検索中…</li>';
    else if (empty) html += '<li class="ms-status">見つかりませんでした</li>';
    else if (!rows.some((r) => r.kind === 'gsi' || r.kind === 'osm')) html += '<li class="ms-more" data-more>↵ 住所・地名・施設（駅など）をさらに検索</li>';
    list.innerHTML = html;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(active);
  }
  function setActive(i) {
    active = i;
    list.querySelectorAll('li[data-i]').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === i));
    input.setAttribute('aria-activedescendant', i >= 0 ? `ms-opt-${i}` : '');
    list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }
  function closeList() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }
  function cancelSearch() {
    seq++;
    inflight?.abort();
    inflight = null;
    clearTimeout(timer);
  }
  function suggest() {
    cancelSearch();
    const q = input.value.trim();
    if (!q) { closeList(); rows = []; return; }
    renderList([searchLocal(q)]);
  }

  async function submit() {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return;
    const my = ++seq;
    inflight?.abort();
    const ctl = new AbortController();
    inflight = ctl;
    const local = searchLocal(q);
    if (local.length && local[0].n === tokens(q).join('')) { pick(local[0]); return; }
    let gsi = null, osm = null, decided = false;
    const draw = () => {
      if (my !== seq) return;
      const done = gsi !== null && osm !== null;
      renderList([local, gsi || [], osm || []], { keepActive: true, loading: !done, empty: done && !local.length && !gsi.length && !osm.length });
    };
    const decide = () => {
      if (decided || my !== seq || active >= 0) return;
      if (local.length && local[0].score <= 1) { decided = true; select(local[0], { keepList: true }); return; }
      if (gsi === null) return;
      const fine = gsi.find((r) => r.fine);
      if (fine) { decided = true; select(fine, { keepList: true }); return; }
      if (osm === null) return;
      const best = osm.find((r) => r.exact) || local[0] || osm[0] || gsi[0];
      if (best) { decided = true; select(best, { keepList: true }); }
    };
    draw();
    decide();
    const run = (fn, set) => fn(q, ctl.signal).catch(() => []).then((r) => { if (my !== seq) return; set(r); draw(); decide(); });
    await Promise.all([run(searchGsi, (r) => { gsi = r; }), run(searchPhoton, (r) => { osm = r; })]);
  }

  function pick(r) {
    cancelSearch();
    closeList();
    select(r);
  }

  // ---------- selection ----------
  function clearSelection() {
    cancelSearch();
    marker?.remove();
    marker = null;
    current = null;
    card.hidden = true;
  }
  function select(r, { keepList = false } = {}) {
    if (!keepList) closeList();
    current = { ...r, hz: null };
    input.value = r.kind === 'here' ? '' : r.label;
    $('.ms-clear', root).hidden = !input.value;
    marker?.remove();
    marker = null;
    const isCharger = r.kind === 'tesla' || r.kind === 'flash';
    if (!isCharger) {
      const el = document.createElement('div');
      el.className = `ms-pin${r.kind === 'here' ? ' here' : ''}`;
      marker = new maplibregl.Marker({ element: el, anchor: r.kind === 'here' ? 'center' : 'bottom' }).setLngLat(r.coords).addTo(map);
    }
    if (isCharger) {
      opts.openCharger(r.id);
    } else if (r.bbox) {
      map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 60, maxZoom: 12, duration: 900 });
    } else {
      map.flyTo({ center: r.coords, zoom: Math.max(map.getZoom(), r.kind === 'gsi' || r.kind === 'here' ? 13 : 12.5), duration: 900 });
    }
    renderCard();
  }
  function km(a, b) {
    const R = 6371, t = Math.PI / 180;
    const dLat = (b[1] - a[1]) * t, dLon = (b[0] - a[0]) * t;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtKm = (d) => (d < 1 ? `${Math.round(d * 1000)}m` : d < 10 ? `${d.toFixed(1)}km` : `${Math.round(d)}km`);
  function renderCard() {
    if (!current) { card.hidden = true; return; }
    const r = current;
    const { sc } = opts.getData();
    const open = sc.features.filter((f) => f.properties.group === 'open' && String(f.properties.id) !== String(r.id))
      .map((f) => ({ f, d: km(r.coords, f.geometry.coordinates) })).sort((a, b) => a.d - b.d);
    const nearest = (net) => open.find((o) => (o.f.properties.network || 'tesla') === net);
    const t = nearest('tesla'), fl = nearest('flash');
    const near3 = open.slice(0, 3).map(({ f, d }) => {
      const p = f.properties, net = p.network === 'flash' ? 'flash' : 'tesla';
      return `<li><button type="button" data-charger="${esc(p.id)}"><i class="${net}"></i><span>${esc(String(p.name).replace(/, Japan\b/, ''))}</span><b>${fmtKm(d)}</b></button></li>`;
    }).join('');
    const k = KIND[r.kind];
    const hzHits = (r.hz || []).filter((h) => !h.error);
    const hzFailed = (r.hz || []).some((h) => h.error);
    const hzTitle = '<div class="ms-hz-title">この地点の災害想定</div>';
    const hzHtml = !opts.isHazardMode() ? '' : r.hz === null
      ? '<div class="ms-hz muted">この地点の災害想定を確認中…</div>'
      : hzHits.length
        ? `<div class="ms-hz">${hzTitle}<ul>${hzHits.map((h) => `<li><i style="background:${esc(h.color)}"></i>${esc(h.name)}<b>${esc(h.label)}</b></li>`).join('')}</ul>${hzFailed ? '<div class="muted">一部の災害情報を取得できませんでした</div>' : ''}</div>`
        : hzFailed
          ? `<div class="ms-hz">${hzTitle}<div class="muted">災害情報を取得できませんでした（時間をおいて再度お試しください）</div></div>`
          : `<div class="ms-hz">${hzTitle}<div class="muted">重ねるハザードマップの想定区域外</div></div>`;
    card.innerHTML = `
      <div class="ms-card-head"><span class="ms-k" aria-hidden="true">${k.icon}</span><div><strong>${esc(r.label)}</strong><small>${esc(k.label)}${r.sub ? `・${esc(r.sub)}` : ''}</small></div>
        <button type="button" class="ms-card-close" aria-label="検索結果を閉じる">×</button></div>
      <div class="ms-near"><span><i class="tesla"></i>最寄りTesla SC <b>${t ? fmtKm(t.d) : '−'}</b></span><span><i class="flash"></i>最寄りFLASH <b>${fl ? fmtKm(fl.d) : '−'}</b></span></div>
      <ol class="ms-near-list">${near3}</ol>
      <div class="ms-note">距離は直線。${r.bbox ? '市区町村・都道府県は代表点から測定。' : ''}</div>
      ${hzHtml}`;
    card.hidden = false;
    if (opts.isHazardMode() && r.hz === null) loadHazard(r);
  }
  async function loadHazard(r) {
    if (r.hzLoading) return;
    r.hzLoading = true;
    const hz = await (window.HazardOverlay?.pointHazard?.(r.coords) ?? Promise.resolve([])).catch(() => [{ error: true }]);
    if (current !== r) return;
    r.hz = hz;
    renderCard();
  }
  function locate() {
    if (!navigator.geolocation) { showHint('このブラウザは位置情報に対応していません'); return; }
    cancelSearch();
    closeList();
    showHint('現在地を取得中…');
    navigator.geolocation.getCurrentPosition((pos) => {
      cancelSearch();
      showHint('');
      select({ kind: 'here', label: '現在地', sub: `精度 約${Math.round(pos.coords.accuracy)}m`, coords: [pos.coords.longitude, pos.coords.latitude] });
    }, (err) => {
      showHint(err.code === 1 ? '位置情報の利用が許可されていません' : '現在地を取得できませんでした');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }
  function showHint(msg) {
    hint.textContent = msg;
    hint.hidden = !msg;
    if (msg && !/中…$/.test(msg)) setTimeout(() => { if (hint.textContent === msg) hint.hidden = true; }, 4000);
  }

  // ---------- public ----------
  let lastHazardMode = false;
  function init(o) {
    opts = o;
    map = o.map;
    buildIndex();
    map.addControl({ onAdd: buildUi, onRemove: () => root.remove() }, 'top-left');
  }
  function update() {
    if (!opts) return;
    const hm = opts.isHazardMode();
    if (hm !== lastHazardMode) {
      lastHazardMode = hm;
      if (current) renderCard();
    }
  }
  window.MapSearch = { init, update, search: (q) => { input.value = q; return submit(); } };
})();
