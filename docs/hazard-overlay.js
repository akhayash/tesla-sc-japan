/* Hazard overlay for the main map: MLIT "Kasaneru Hazard Map" tiles + per-charger risk rings.
 * Exposes window.HazardOverlay; app.js calls init() once the map is ready and update() on every render.
 */
(() => {
  'use strict';

  // Official legend colours (as served in the tiles) paired with a higher-contrast palette.
  const DEPTH = {
    official: ['#ffffb3', '#f7f5a9', '#f8e1a6', '#ffd8c0', '#ffb7b7', '#ff9191', '#f285c9', '#dc7adc'],
    vis: ['#fdbe85', '#fd9f55', '#f98032', '#ea5f14', '#c94407', '#9a3006', '#6b1f04', '#4a1486'],
    labels: ['0.3m未満', '0.5m未満', '0.5〜1m', '0.5〜3m（1〜3m）', '3〜5m', '5〜10m', '10〜20m', '20m以上'],
  };
  const DURATION = {
    official: ['#a0d2ff', '#0041ff', '#faf500', '#ff9900', '#ff2800', '#b40068', '#600060'],
    vis: ['#c6b4e0', '#a58ad0', '#8761bd', '#6a3fa8', '#522b8f', '#3b1b73', '#260f52'],
    labels: ['12時間未満', '12時間〜1日', '1日〜3日', '3日〜1週間', '1週間〜2週間', '2週間〜4週間', '4週間以上'],
  };
  const zone = (official, vis, labels = ['警戒区域', '特別警戒区域']) => ({ official, vis, labels });
  const LAYERS = {
    flood: { name: '洪水', full: '洪水浸水想定区域（想定最大規模）', group: '水害', path: '01_flood_l2_shinsuishin_data', legend: DEPTH },
    duration: { name: '浸水継続時間', full: '浸水継続時間（想定最大規模）', group: '水害', path: '01_flood_l2_keizoku_data', legend: DURATION },
    collapse_flow: { name: '家屋倒壊（氾濫流）', full: '家屋倒壊等氾濫想定区域（氾濫流）', group: '水害', path: '01_flood_l2_kaokutoukai_hanran_data', legend: zone(['#ff0000'], ['#d6007a'], ['想定区域']) },
    collapse_erosion: { name: '家屋倒壊（河岸侵食）', full: '家屋倒壊等氾濫想定区域（河岸侵食）', group: '水害', path: '01_flood_l2_kaokutoukai_kagan_data', legend: zone(['#ff0000'], ['#8e0152'], ['想定区域']) },
    inland: { name: '内水', full: '内水（雨水出水）浸水想定区域', group: '水害', path: '02_naisui_data', legend: DEPTH },
    hightide: { name: '高潮', full: '高潮浸水想定区域', group: '水害', path: '03_hightide_l2_shinsuishin_data', legend: DEPTH },
    tsunami: { name: '津波', full: '津波浸水想定', group: '水害', path: '04_tsunami_newlegend_data', legend: DEPTH },
    debris: { name: '土石流', full: '土砂災害警戒区域（土石流）', group: '土砂・雪崩', path: '05_dosekiryukeikaikuiki', legend: zone(['#e6c832', '#a50021'], ['#a0522d', '#4d2106']) },
    steep: { name: '急傾斜地', full: '土砂災害警戒区域（急傾斜地の崩壊）', group: '土砂・雪崩', path: '05_kyukeishakeikaikuiki', legend: zone(['#fae600', '#fa2800'], ['#b8860b', '#6b4400']) },
    landslide: { name: '地すべり', full: '土砂災害警戒区域（地すべり）', group: '土砂・雪崩', path: '05_jisuberikeikaikuiki', legend: zone(['#ff9900', '#b40028'], ['#1b7837', '#00441b']) },
    avalanche: { name: '雪崩', full: '雪崩危険箇所', group: '土砂・雪崩', path: '05_nadarekikenkasyo', legend: zone(['#ffff65'], ['#2c7fb8'], ['危険箇所']) },
  };
  const LEVEL = { 3: { label: '高', color: '#b91c1c' }, 2: { label: '中', color: '#ea580c' }, 1: { label: '低', color: '#a16207' } };
  const ALONE_KM = 30;
  const MATCH_DIST = 42;

  const st = { layers: [], op: '70', pal: 'vis' };
  let map, opts, data = null, loaded = false, active = false;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  // ---------- tile recolouring protocol ----------
  const byPath = Object.fromEntries(Object.entries(LAYERS).map(([k, l]) => [l.path, k]));
  let emptyTile = null;
  async function getEmptyTile() {
    if (!emptyTile) {
      const c = new OffscreenCanvas(1, 1);
      c.getContext('2d');
      emptyTile = await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
    }
    return emptyTile.slice(0);
  }
  const colorCache = {};
  function remap(key, r, g, b) {
    const cache = (colorCache[key] ||= new Map());
    const k = (r << 16) | (g << 8) | b;
    if (cache.has(k)) return cache.get(k);
    const lg = LAYERS[key].legend;
    let best = -1, bd = Infinity;
    lg.official.forEach((h, i) => {
      const [R, G, B] = hex(h);
      const d = Math.hypot(r - R, g - G, b - B);
      if (d < bd) { bd = d; best = i; }
    });
    const out = bd <= MATCH_DIST ? hex(lg.vis[best]) : lg === DEPTH || lg === DURATION ? null : hex(lg.vis[0]);
    cache.set(k, out);
    return out;
  }
  maplibregl.addProtocol('hz', async (params, abort) => {
    const u = new URL(params.url.replace(/^hz:\/\//, 'https://'));
    const pal = u.searchParams.get('p');
    u.search = '';
    const res = await fetch(u.href, { signal: abort.signal });
    if (res.status === 404) return { data: await getEmptyTile() };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (pal !== 'vis') return { data: buf };
    const key = byPath[u.pathname.split('/')[2]];
    const bmp = await createImageBitmap(new Blob([buf]));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      if (!px[i + 3]) continue;
      const c = remap(key, px[i], px[i + 1], px[i + 2]);
      if (c) { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
    }
    ctx.putImageData(img, 0, 0);
    return { data: await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer() };
  });
  const tileUrl = (l) => `hz://disaportaldata.gsi.go.jp/raster/${l.path}/{z}/{x}/{y}.png?p=${st.pal}`;

  // ---------- state ----------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('hz')) st.layers = p.get('hz').split(',').filter((k) => k in LAYERS);
    const op = Number(p.get('hzOp'));
    if (op >= 20 && op <= 100 && op % 5 === 0) st.op = String(op);
    if (['vis', 'official'].includes(p.get('hzPal'))) st.pal = p.get('hzPal');
  }
  function writeHash(params) {
    if (st.layers.length) params.set('hz', st.layers.join(','));
    if (st.op !== '70') params.set('hzOp', st.op);
    if (st.pal !== 'vis') params.set('hzPal', st.pal);
  }
  function commit() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const k of ['hz', 'hzOp', 'hzPal']) p.delete(k);
    writeHash(p);
    history.replaceState(null, '', '#' + p.toString());
    update();
  }

  // ---------- init ----------
  function init(o) {
    opts = o; map = o.map;
    readHash();
    for (const [id, l] of Object.entries(LAYERS)) {
      map.addSource(`hz-${id}`, {
        type: 'raster', tiles: [tileUrl(l)], tileSize: 256, minzoom: 2, maxzoom: 17,
        attribution: '<a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener">ハザードマップポータルサイト</a>を加工',
      });
      map.addLayer({ id: `hz-${id}`, type: 'raster', source: `hz-${id}`, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' } }, o.beforeId);
    }
    map.addSource('hz-risk', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'hz-risk', type: 'circle', source: 'hz-risk',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6.5, 7, 11, 12, 20],
        'circle-color': ['match', ['get', 'level'], 3, LEVEL[3].color, 2, LEVEL[2].color, LEVEL[1].color],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['match', ['get', 'level'], 3, LEVEL[3].color, 2, LEVEL[2].color, LEVEL[1].color],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 10, 3],
      },
    }, o.ringBeforeId);
    buildPanel();
    fetch('data/sc_hazard.json', { cache: 'no-cache' }).then((r) => r.json()).then((d) => { data = d; loaded = true; update(); })
      .catch(() => { $('#hz-summary').innerHTML = '<p class="muted">判定データを読み込めませんでした。</p>'; });
  }
  function bottomLayerId() { return 'hz-flood'; }
  function setActive(on) {
    active = on;
    if (on && !st.layers.length) { st.layers = ['flood']; commit(); return; }
    update();
  }

  function buildPanel() {
    const groups = {};
    for (const [id, l] of Object.entries(LAYERS)) (groups[l.group] ||= []).push([id, l]);
    $('#hz-options').innerHTML = Object.entries(groups).map(([g, items]) => `
      <div class="hz-group"><div class="hz-group-title">${g}</div><div class="hz-chips">
        ${items.map(([id, l]) => `<button type="button" class="hz-chip" data-hz="${id}" aria-pressed="false" title="${esc(l.full)}"><span class="sw"></span>${esc(l.name)}</button>`).join('')}
      </div></div>`).join('');
    document.querySelectorAll('[data-hz]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.hz;
      st.layers = st.layers.includes(k) ? st.layers.filter((x) => x !== k) : [...st.layers, k];
      commit();
    }));
    document.querySelectorAll('[data-hzkey="hzPal"] button').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (st.pal === b.dataset.v) return;
      st.pal = b.dataset.v;
      for (const [id, l] of Object.entries(LAYERS)) map.getSource(`hz-${id}`).setTiles([tileUrl(l)]);
      commit();
    }, true));
    $('#hz-opacity').addEventListener('input', (e) => { st.op = e.target.value; commit(); });
  }

  // ---------- computation ----------
  function km(a, b) {
    const r = Math.PI / 180;
    const x = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r), y = (b[1] - a[1]) * r;
    return Math.hypot(x, y) * 6371;
  }
  function assess() {
    const sites = opts.getActiveSites();
    return sites.map((f) => {
      const hz = data?.sites?.[String(f.properties.id)]?.hazards || {};
      let level = 0;
      for (const k of st.layers) if (hz[k]) level = Math.max(level, hz[k].level);
      return { f, hz, level };
    }).map((s, _, all) => {
      if (s.level < 2) return s;
      const c = s.f.geometry.coordinates;
      s.alone = !all.some((o) => o !== s && km(c, o.f.geometry.coordinates) <= ALONE_KM);
      return s;
    });
  }

  // ---------- render ----------
  function update() {
    if (!map) return;
    const on = st.layers.length > 0;
    for (const id of Object.keys(LAYERS)) {
      map.setLayoutProperty(`hz-${id}`, 'visibility', active && st.layers.includes(id) ? 'visible' : 'none');
      map.setPaintProperty(`hz-${id}`, 'raster-opacity', Number(st.op) / 100);
    }
    document.querySelectorAll('[data-hz]').forEach((b) => {
      const k = b.dataset.hz, active = st.layers.includes(k);
      b.classList.toggle('on', active);
      b.setAttribute('aria-pressed', String(active));
      const lg = LAYERS[k].legend;
      b.querySelector('.sw').style.background = lg[st.pal][Math.min(lg[st.pal].length - 1, Math.floor(lg[st.pal].length / 2))];
    });
    document.querySelectorAll('[data-hzkey="hzPal"] button').forEach((b) => b.classList.toggle('active', b.dataset.v === st.pal));
    $('#hz-opacity').value = st.op;
    $('#hz-opacity-v').textContent = `${st.op}%`;
    $('#hz-badge').textContent = on ? `${st.layers.length}件を表示中` : '複数選択できます';
    renderLegend();

    if (!active) { map.getSource('hz-risk').setData({ type: 'FeatureCollection', features: [] }); return; }
    if (!on || !loaded) {
      map.getSource('hz-risk').setData({ type: 'FeatureCollection', features: [] });
      $('#hz-summary').innerHTML = on ? '<p class="muted">判定データを読み込み中…</p>' : '<p class="muted">重ねたい災害情報を選んでください。複数選べます。</p>';
      $('#hz-list-wrap').hidden = true;
      return;
    }
    const res = assess();
    const hit = res.filter((s) => s.level > 0);
    map.getSource('hz-risk').setData({
      type: 'FeatureCollection',
      features: hit.map((s) => ({ type: 'Feature', geometry: s.f.geometry, properties: { level: s.level } })),
    });
    const cnt = { 1: 0, 2: 0, 3: 0 };
    hit.forEach((s) => cnt[s.level]++);
    const alone = hit.filter((s) => s.alone).length;
    $('#hz-summary').innerHTML = `
      <div>表示中の充電器 ${res.length}か所のうち <b>${hit.length}か所</b> が想定区域内</div>
      <div class="hz-stats">
        ${[3, 2, 1].map((lv) => `<span class="hz-stat"><i style="border-color:${LEVEL[lv].color}"></i>${LEVEL[lv].label} ${cnt[lv]}</span>`).join('')}
      </div>
      ${alone ? `<div class="muted">リスク中以上で${ALONE_KM}km以内に代わりがない：${alone}か所</div>` : ''}
      <div class="muted">地図上の充電器の外側の輪がリスクの段階です。</div>`;
    const rows = hit.filter((s) => s.level >= 2)
      .sort((a, b) => b.level - a.level || Number(!!b.alone) - Number(!!a.alone) || String(a.f.properties.name).localeCompare(String(b.f.properties.name), 'ja'));
    const wrap = $('#hz-list-wrap');
    wrap.hidden = !rows.length;
    wrap.querySelector('summary').textContent = `想定区域内の充電器（リスク中以上 ${rows.length}か所）`;
    const ol = $('#hz-list');
    ol.innerHTML = rows.map((s) => `
      <li data-id="${esc(s.f.properties.id)}">
        <i class="lv" style="border-color:${LEVEL[s.level].color}"></i>
        <span class="nm">${esc(s.f.properties.name)}${s.alone ? '<span class="hz-alone">代替なし</span>' : ''}</span>
        <span class="meta">${esc(st.layers.filter((k) => s.hz[k]).map((k) => `${LAYERS[k].name} ${s.hz[k].label}`).join('、'))}</span>
      </li>`).join('');
    ol.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => opts.openCharger(li.dataset.id)));
  }

  function renderLegend() {
    const el = $('#hz-legend');
    if (!st.layers.length) { el.innerHTML = ''; return; }
    const blocks = [];
    const depth = st.layers.filter((k) => LAYERS[k].legend === DEPTH);
    const done = new Set();
    for (const k of st.layers) {
      const lg = LAYERS[k].legend;
      if (lg === DEPTH) {
        if (done.has('depth')) continue;
        done.add('depth');
        blocks.push([`浸水深（${depth.map((x) => LAYERS[x].name).join('・')}）`, lg]);
      } else blocks.push([LAYERS[k].full, lg]);
    }
    el.innerHTML = blocks.map(([t, lg]) => `<div class="hz-lg"><div class="hz-lg-title">${esc(t)}</div><div class="hz-lg-rows">
      ${lg.labels.map((lab, i) => `<span><i style="background:${lg[st.pal][i]}"></i>${esc(lab)}</span>`).join('')}</div></div>`).join('');
  }

  function popupHtml(id) {
    if (!data) return '';
    const hz = data.sites?.[String(id)]?.hazards || {};
    const keys = Object.keys(LAYERS).filter((k) => hz[k]);
    if (!keys.length) return '<div class="hz-pop"><div class="hz-pop-title">災害想定</div><div class="muted">重ねるハザードマップの想定区域外（登録位置）</div></div>';
    return `<div class="hz-pop"><div class="hz-pop-title">災害想定（登録位置）</div><table>${keys.map((k) => `<tr class="${st.layers.includes(k) ? 'on' : ''}"><td><i style="border-color:${LEVEL[hz[k].level].color}"></i>${esc(LAYERS[k].full)}</td><td>${esc(hz[k].label)}</td></tr>`).join('')}</table></div>`;
  }

  window.HazardOverlay = { init, update, writeHash, popupHtml, bottomLayerId, setActive, isActive: () => active };
})();
