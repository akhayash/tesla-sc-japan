(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('ja-JP');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DEPTH_LEGEND = [
    ['#ffffb3', '0.3m未満（津波・高潮）'], ['#f7f5a9', '0.5m未満'], ['#f8e1a6', '0.5〜1m'], ['#ffd8c0', '0.5〜3m（1〜3m）'],
    ['#ffb7b7', '3〜5m'], ['#ff9191', '5〜10m'], ['#f285c9', '10〜20m'], ['#dc7adc', '20m以上'],
  ];
  const DURATION_LEGEND = [
    ['#a0d2ff', '12時間未満'], ['#0041ff', '12時間〜1日'], ['#faf500', '1日〜3日'], ['#ff9900', '3日〜1週間'],
    ['#ff2800', '1週間〜2週間'], ['#b40068', '2週間〜4週間'], ['#600060', '4週間以上'],
  ];
  const LAYERS = {
    flood: { name: '洪水浸水想定区域', note: '想定最大規模', group: '水害', path: '01_flood_l2_shinsuishin_data', legend: DEPTH_LEGEND, sw: '#ffb7b7' },
    duration: { name: '浸水継続時間', note: '想定最大規模', group: '水害', path: '01_flood_l2_keizoku_data', legend: DURATION_LEGEND, sw: '#ff9900' },
    collapse_flow: { name: '家屋倒壊等氾濫想定区域（氾濫流）', note: '', group: '水害', path: '01_flood_l2_kaokutoukai_hanran_data', legend: [['#ff0000', '想定区域']], sw: '#ff0000' },
    collapse_erosion: { name: '家屋倒壊等氾濫想定区域（河岸侵食）', note: '', group: '水害', path: '01_flood_l2_kaokutoukai_kagan_data', legend: [['#ff0000', '想定区域']], sw: '#ff0000' },
    inland: { name: '内水（雨水出水）浸水想定区域', note: '', group: '水害', path: '02_naisui_data', legend: DEPTH_LEGEND, sw: '#f7f5a9' },
    hightide: { name: '高潮浸水想定区域', note: '', group: '水害', path: '03_hightide_l2_shinsuishin_data', legend: DEPTH_LEGEND, sw: '#ff9191' },
    tsunami: { name: '津波浸水想定', note: '', group: '水害', path: '04_tsunami_newlegend_data', legend: DEPTH_LEGEND, sw: '#f285c9' },
    debris: { name: '土石流', note: '警戒区域', group: '土砂災害・雪崩', path: '05_dosekiryukeikaikuiki', legend: [['#e6c832', '警戒区域'], ['#a50021', '特別警戒区域']], sw: '#e6c832' },
    steep: { name: '急傾斜地の崩壊', note: '警戒区域', group: '土砂災害・雪崩', path: '05_kyukeishakeikaikuiki', legend: [['#fae600', '警戒区域'], ['#fa2800', '特別警戒区域']], sw: '#fae600' },
    landslide: { name: '地すべり', note: '警戒区域', group: '土砂災害・雪崩', path: '05_jisuberikeikaikuiki', legend: [['#ff9900', '警戒区域'], ['#b40028', '特別警戒区域']], sw: '#ff9900' },
    avalanche: { name: '雪崩危険箇所', note: '', group: '土砂災害・雪崩', path: '05_nadarekikenkasyo', legend: [['#ffff65', '雪崩危険箇所']], sw: '#ffff65' },
  };
  const LEVEL = {
    3: { label: '高', color: '#b91c1c' }, 2: { label: '中', color: '#f97316' },
    1: { label: '低', color: '#facc15' }, 0: { label: '区域外', color: '#94a3b8' },
  };
  const BASEMAPS = {
    pale: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    std: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    photo: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  };
  const STATUS_LABEL = { OPEN: '営業中', ADJUSTING: '調整中', EXPANDING: '営業中（拡張中）', CLOSED_TEMP: '一時休止', CONSTRUCTION: '建設中', PERMIT: '許認可中', PLAN: '計画中', VOTING: '候補' };
  const ALONE_KM = 30;

  const state = { layers: ['flood'], op: '70', tesla: true, flash: true, status: 'o', base: 'pale', minLevel: '2' };
  readHash();

  let sc, hz, map, popup, sites = [];

  const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
  const HZ_ATTR = '<a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener">ハザードマップポータルサイト</a>';
  const sources = {}, layers = [];
  for (const [id, url] of Object.entries(BASEMAPS)) {
    sources[`base-${id}`] = { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 18, attribution: GSI_ATTR };
    layers.push({ id: `base-${id}`, type: 'raster', source: `base-${id}`, layout: { visibility: id === state.base ? 'visible' : 'none' } });
  }
  for (const [id, l] of Object.entries(LAYERS)) {
    sources[`hz-${id}`] = { type: 'raster', tiles: [`https://disaportaldata.gsi.go.jp/raster/${l.path}/{z}/{x}/{y}.png`], tileSize: 256, minzoom: 2, maxzoom: 17, attribution: HZ_ATTR };
    layers.push({ id: `hz-${id}`, type: 'raster', source: `hz-${id}`, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' } });
  }

  map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf', sources, layers },
    center: [137.5, 37.2], zoom: 4.7, minZoom: 3.5, maxZoom: 18,
    dragRotate: false, pitchWithRotate: false,
    attributionControl: { compact: false, customAttribution: '充電器: <a href="https://supercharge.info/" target="_blank" rel="noopener">supercharge.info</a>・<a href="https://ev-charger.jp/area/" target="_blank" rel="noopener">FLASH</a>' },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' });

  Promise.all([
    fetch('data/sc.geojson').then((r) => r.json()),
    fetch('data/sc_hazard.json').then((r) => r.json()),
    new Promise((res) => map.on('load', res)),
  ]).then(([s, h]) => {
    sc = s; hz = h;
    $('#fetched').textContent = [sc.fetched, sc.fetched_flash].filter(Boolean).join(' / ');
    $('#hz-updated').textContent = `判定日 ${hz.updated}`;
    sites = sc.features.map((f) => ({ f, p: f.properties, hazards: (hz.sites[String(f.properties.id)] || {}).hazards || {} }));
    setupMap();
    buildOptions();
    bindUi();
    render();
    $('#loading').hidden = true;
  }).catch((e) => {
    $('#loading').textContent = 'データの読み込みに失敗しました。再読み込みしてください。';
    console.error(e);
  });

  // ---------- state ----------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('layers')) state.layers = p.get('layers').split(',').filter((k) => k in LAYERS);
    if (/^\d+$/.test(p.get('op') || '') && +p.get('op') >= 20 && +p.get('op') <= 100) state.op = p.get('op');
    for (const k of ['tesla', 'flash']) if (p.has(k)) state[k] = p.get(k) === '1';
    if (['o', 'a'].includes(p.get('status'))) state.status = p.get('status');
    if (p.get('base') in BASEMAPS) state.base = p.get('base');
    if (['1', '2', '3'].includes(p.get('minLevel'))) state.minLevel = p.get('minLevel');
  }
  function writeHash() {
    const p = new URLSearchParams({
      layers: state.layers.join(','), op: state.op, tesla: state.tesla ? '1' : '0', flash: state.flash ? '1' : '0',
      status: state.status, base: state.base, minLevel: state.minLevel,
    });
    history.replaceState(null, '', '#' + p.toString());
  }

  // ---------- computation ----------
  function activeSites() {
    return sites.filter(({ p }) => {
      const net = p.network || 'tesla';
      if (!((net === 'tesla' && state.tesla) || (net === 'flash' && state.flash))) return false;
      return state.status === 'a' || p.group === 'open';
    });
  }
  function levelOf(s) {
    let lv = 0;
    for (const k of state.layers) if (s.hazards[k]) lv = Math.max(lv, s.hazards[k].level);
    return lv;
  }
  function km(a, b) {
    const [lon1, lat1] = a.f.geometry.coordinates, [lon2, lat2] = b.f.geometry.coordinates;
    const r = Math.PI / 180;
    const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r), y = (lat2 - lat1) * r;
    return Math.sqrt(x * x + y * y) * 6371;
  }
  function annotate(list) {
    for (const s of list) {
      s.level = levelOf(s);
      let nearest = Infinity, within = 0;
      for (const o of list) {
        if (o === s) continue;
        const d = km(s, o);
        if (d < nearest) nearest = d;
        if (d <= ALONE_KM) within++;
      }
      s.nearest = nearest; s.within = within; s.alone = within === 0;
    }
    return list;
  }

  // ---------- map ----------
  function setupMap() {
    map.addSource('sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'sites', type: 'circle', source: 'sites',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['+', 2.5, ['*', ['get', 'level'], 0.9]], 10, ['+', 6, ['*', ['get', 'level'], 1.5]]],
        'circle-color': ['match', ['get', 'level'], 3, LEVEL[3].color, 2, LEVEL[2].color, 1, LEVEL[1].color, LEVEL[0].color],
        'circle-stroke-color': ['case', ['==', ['get', 'network'], 'flash'], '#0969da', '#ffffff'],
        'circle-stroke-width': ['case', ['==', ['get', 'network'], 'flash'], 2, 1.5],
      },
    });
    map.addLayer({
      id: 'sites-label', type: 'symbol', source: 'sites', minzoom: 10,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#1f2328', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    });
    map.on('mouseenter', 'sites', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'sites', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'sites', (e) => openPopup(String(e.features[0].properties.id), e.lngLat));
  }

  function renderMap(list) {
    for (const id of Object.keys(LAYERS)) {
      const on = state.layers.includes(id);
      map.setLayoutProperty(`hz-${id}`, 'visibility', on ? 'visible' : 'none');
      map.setPaintProperty(`hz-${id}`, 'raster-opacity', Number(state.op) / 100);
    }
    for (const id of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${id}`, 'visibility', id === state.base ? 'visible' : 'none');
    const features = list
      .slice().sort((a, b) => a.level - b.level)
      .map((s) => ({ type: 'Feature', geometry: s.f.geometry, properties: { id: String(s.p.id), name: s.p.name, network: s.p.network || 'tesla', level: s.level } }));
    map.getSource('sites').setData({ type: 'FeatureCollection', features });
  }

  // ---------- panel ----------
  function buildOptions() {
    const groups = {};
    for (const [id, l] of Object.entries(LAYERS)) (groups[l.group] ||= []).push([id, l]);
    $('#hz-options').innerHTML = Object.entries(groups).map(([g, items]) => `
      <div class="hz-group"><p class="hz-group-title">${g}</p>
        ${items.map(([id, l]) => `<label class="hz-option"><input type="checkbox" data-layer="${id}"><span class="sw" style="background:${l.sw}"></span>${l.name}${l.note ? `<small>${l.note}</small>` : ''}</label>`).join('')}
      </div>`).join('');
  }

  function bindUi() {
    document.querySelectorAll('[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
      state.layers = [...document.querySelectorAll('[data-layer]:checked')].map((x) => x.dataset.layer);
      render();
    }));
    $('#hz-opacity').addEventListener('input', (e) => { state.op = e.target.value; render(); });
    $('#use-tesla').addEventListener('change', (e) => { state.tesla = e.target.checked; render(); });
    $('#use-flash').addEventListener('change', (e) => { state.flash = e.target.checked; render(); });
    $('#basemap').addEventListener('change', (e) => { state.base = e.target.value; render(); });
    document.querySelectorAll('.seg').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state[seg.dataset.key] = b.dataset.v; render();
    })));
    $('#panel-toggle').addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('panel-collapsed');
      $('#panel-toggle').setAttribute('aria-expanded', String(!collapsed));
      $('#panel-toggle').setAttribute('aria-label', collapsed ? 'サイドパネルを開く' : 'サイドパネルを閉じる');
      setTimeout(() => map.resize(), 220);
    });
  }

  function syncUi() {
    document.querySelectorAll('[data-layer]').forEach((cb) => { cb.checked = state.layers.includes(cb.dataset.layer); });
    $('#hz-opacity').value = state.op; $('#hz-opacity-v').textContent = `${state.op}%`;
    $('#use-tesla').checked = state.tesla; $('#use-flash').checked = state.flash;
    $('#basemap').value = state.base;
    document.querySelectorAll('.seg').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === state[seg.dataset.key])));
  }

  function render() {
    syncUi();
    writeHash();
    popup.remove();
    const list = annotate(activeSites());
    renderMap(list);
    renderSummary(list);
    renderList(list);
    renderLegend();
  }

  function renderSummary(list) {
    const el = $('#hz-summary');
    if (!state.layers.length) { el.innerHTML = '<p class="muted">左の「重ねる災害情報」から、確認したい想定を選んでください。</p>'; return; }
    if (!list.length) { el.innerHTML = '<p class="muted">対象の充電拠点がありません。ネットワークの選択を確認してください。</p>'; return; }
    const cnt = { 1: 0, 2: 0, 3: 0 };
    let alone = 0;
    for (const s of list) if (s.level) { cnt[s.level]++; if (s.alone && s.level >= 2) alone++; }
    const inside = cnt[1] + cnt[2] + cnt[3];
    const names = state.layers.map((k) => LAYERS[k].name).join('・');
    el.innerHTML = `
      <div>選択中の想定（${esc(names)}）の区域内にある充電拠点</div>
      <div><span class="big">${inside}</span> / ${list.length}か所（${(inside / list.length * 100).toFixed(0)}%）</div>
      <div class="stat-grid">
        <div class="stat l3"><b>${cnt[3]}</b><span>リスク高</span></div>
        <div class="stat l2"><b>${cnt[2]}</b><span>リスク中</span></div>
        <div class="stat l1"><b>${cnt[1]}</b><span>リスク低</span></div>
      </div>
      <div>リスク中以上で、${ALONE_KM}km以内に代わりの拠点がない：<b>${alone}か所</b></div>`;
  }

  function hazardSummary(s) {
    return state.layers.filter((k) => s.hazards[k]).map((k) => `${LAYERS[k].name} ${s.hazards[k].label}`).join('、');
  }

  function renderList(list) {
    const min = Number(state.minLevel);
    const rows = list.filter((s) => s.level >= min)
      .sort((a, b) => b.level - a.level || Number(b.alone) - Number(a.alone) || String(a.p.name).localeCompare(String(b.p.name), 'ja'));
    const ol = $('#hz-list');
    if (!state.layers.length) { ol.innerHTML = ''; return; }
    if (!rows.length) { ol.innerHTML = '<li class="muted" style="display:block;cursor:default">該当する充電拠点はありません</li>'; return; }
    ol.innerHTML = rows.slice(0, 300).map((s) => {
      const net = s.p.network || 'tesla';
      return `<li data-id="${esc(s.p.id)}">
        <span class="risk-dot" style="background:${LEVEL[s.level].color}"></span>
        <span class="nm">${esc(s.p.name)}<span class="badge ${net}">${net === 'flash' ? 'FLASH' : 'Tesla'}</span>${s.alone ? '<span class="badge alone">代替なし</span>' : ''}</span>
        <span class="meta">${esc(hazardSummary(s))}</span>
      </li>`;
    }).join('');
    ol.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => {
      const s = sites.find((x) => String(x.p.id) === li.dataset.id);
      const [lon, lat] = s.f.geometry.coordinates;
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14), duration: 900 });
      map.once('moveend', () => openPopup(li.dataset.id, { lng: lon, lat }));
    }));
  }

  function renderLegend() {
    const el = $('#hz-legend');
    if (!state.layers.length) { el.innerHTML = '<h3>凡例</h3><p class="muted">災害情報を選ぶと凡例が表示されます。</p>'; return; }
    const shown = new Set();
    const blocks = [];
    for (const k of state.layers) {
      const l = LAYERS[k];
      const key = l.legend === DEPTH_LEGEND ? 'depth' : k;
      if (shown.has(key)) continue;
      shown.add(key);
      const title = key === 'depth'
        ? `浸水深（${state.layers.filter((x) => LAYERS[x].legend === DEPTH_LEGEND).map((x) => LAYERS[x].name.replace(/浸水想定(区域)?/, '')).join('・')}）`
        : l.name;
      blocks.push(`<h3>${title}</h3>${l.legend.map(([c, t]) => `<div class="row"><span class="sw" style="background:${c}"></span>${t}</div>`).join('')}`);
    }
    el.innerHTML = blocks.join('');
  }

  function openPopup(id, lngLat) {
    const list = annotate(activeSites());
    const s = list.find((x) => String(x.p.id) === id) || sites.find((x) => String(x.p.id) === id);
    if (!s) return;
    const net = s.p.network || 'tesla';
    const rows = Object.entries(LAYERS).map(([k, l]) => {
      const h = s.hazards[k];
      const on = state.layers.includes(k);
      return `<tr class="${on ? '' : 'off'}"><td>${h ? `<span class="lv" style="background:${LEVEL[h.level].color}"></span>` : ''}${l.name}</td><td>${h ? esc(h.label) : '区域外'}</td></tr>`;
    }).join('');
    const nearTxt = Number.isFinite(s.nearest)
      ? `${ALONE_KM}km以内の他の拠点：${s.within}か所（最寄り ${s.nearest.toFixed(1)}km）`
      : '比較できる他の拠点がありません';
    popup.setLngLat(lngLat).setHTML(`
      <div class="hz-popup">
        <h3>${esc(s.p.name)}</h3>
        <div class="muted">${net === 'flash' ? 'FLASH' : 'テスラ SC'} · ${esc(STATUS_LABEL[s.p.status] || s.p.status)} · ${s.p.stalls}ストール</div>
        <div style="margin-top:6px">選択中の想定でのリスク：<b style="color:${LEVEL[s.level || 0].color}">${LEVEL[s.level || 0].label}</b></div>
        <table>${rows}</table>
        <div class="muted" style="margin-top:6px">${nearTxt}</div>
        <div class="muted">判定：登録位置1点、ズームレベル17のタイル</div>
      </div>`).addTo(map);
  }
})();
