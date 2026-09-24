(() => {
  'use strict';

  const WORST_TO_BEST = ['#b2182b', '#ef8a62', '#fddbc7', '#d1e5f0', '#67a9cf', '#2166ac'];
  const ZERO_COLOR = '#67001f';
  const NA_COLOR = '#d0d7de';
  const RATIO_CLASSES = [
    { max: 1 / 8, color: [103, 0, 31], label: '1/8 未満' },
    { max: 1 / 4, color: [178, 24, 43], label: '1/8 〜 1/4' },
    { max: 1 / 2, color: [214, 96, 77], label: '1/4 〜 1/2' },
    { max: 1, color: [244, 165, 130], label: '1/2 〜 1' },
    { max: 2, color: [146, 197, 222], label: '1 〜 2' },
    { max: 4, color: [67, 147, 195], label: '2 〜 4' },
    { max: Infinity, color: [33, 102, 172], label: '4 以上' },
  ];
  const POP_CLASSES = [
    { max: 10, color: [255, 245, 235], label: '10人未満' },
    { max: 100, color: [253, 208, 162], label: '10 〜 100人' },
    { max: 500, color: [253, 174, 107], label: '100 〜 500人' },
    { max: 1000, color: [253, 141, 60], label: '500 〜 1,000人' },
    { max: 5000, color: [230, 85, 13], label: '1,000 〜 5,000人' },
    { max: 10000, color: [166, 54, 3], label: '5,000 〜 10,000人' },
    { max: Infinity, color: [90, 20, 0], label: '10,000人以上' },
  ];
  const SC_CLASSES = [
    { max: 0.05, color: [247, 252, 245], label: '0.05 未満' },
    { max: 0.2, color: [199, 233, 192], label: '0.05 〜 0.2' },
    { max: 0.5, color: [161, 217, 155], label: '0.2 〜 0.5' },
    { max: 1, color: [116, 196, 118], label: '0.5 〜 1' },
    { max: 3, color: [65, 171, 93], label: '1 〜 3' },
    { max: 10, color: [35, 139, 69], label: '3 〜 10' },
    { max: Infinity, color: [0, 90, 50], label: '10 以上' },
  ];
  const UNIT_LABEL = { pref: '都道府県', muni_city: '市区町村', muni_ward: '市区町村（政令市は区）' };
  const WEIGHT_LABEL = { s: 'サイト', t: 'ストール' };
  const METRIC = {
    p: {
      label: '人口10万人あたりSC数', better: 'high',
      fmt: (v, w) => `${v.toFixed(2)} ${w === 't' ? 'ストール' : 'サイト'}/10万人`,
      note: '区域内のSC数を人口10万人あたりに換算した値です。市区町村単位では大半が0になるため、30km圏アクセスと併せて見てください。',
    },
    a: {
      label: '30km圏アクセス', better: 'high',
      fmt: (v, w) => `${v.toFixed(2)} ${w === 't' ? 'ストール' : 'サイト'}/10万人`,
      note: '各SCの容量をその半径30km圏の人口で割り、住民から30km以内にあるSCについて合計した値です（2SFCA法）。1kmメッシュ人口で加重平均しており、隣接自治体のSCも反映されます。',
    },
    d: {
      label: '最寄りSCまでの平均距離', better: 'low',
      fmt: (v) => `${v.toFixed(1)} km`,
      note: '区域内の住民（1kmメッシュ人口）から最寄りSCまでの直線距離の人口加重平均です。',
    },
    n: {
      label: 'SC数', better: 'high',
      fmt: (v, w) => `${Math.round(v)} ${w === 't' ? 'ストール' : 'サイト'}`,
      note: '区域内にあるSCの数です。',
    },
  };
  const FACILITY_TYPES = [
    { key: 'facilityIc', code: 2941 },
    { key: 'facilityJct', code: 2942 },
    { key: 'facilitySa', code: 2943 },
    { key: 'facilityPa', code: 2944 },
    { key: 'facilitySmart', code: 2945 },
  ];

  const state = {
    mode: 'B', unit: 'pref', metric: 'p', weight: 't', status: 'o',
    layer: 'ratio', bw: '10', tesla: true, flash: false,
    showSc: true, popAlpha: true, expressway: true, roadFacilities: true,
    facilityIc: true, facilityJct: true, facilitySmart: true, facilitySa: true, facilityPa: true,
    rankMin: '0', base: 'pale',
  };
  readHash();

  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('ja-JP');
  let stats, topo, sc, roadFacilityData, meshMeta, mesh, map, overlay, popup;
  const unitGeo = {};
  const scDensityCache = new Map();
  let bitmap = null;

  const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
  const GSI_VECTOR_ATTR = '<a href="https://github.com/gsi-cyberjapan/optimal_bvmap" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル</a>';
  const GSI_VECTOR_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles';
  const pmtilesProtocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
  const BASEMAPS = {
    pale: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxzoom: 18 },
    std: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxzoom: 18 },
    photo: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxzoom: 18 },
    blank: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', minzoom: 5, maxzoom: 14 },
  };
  const baseSources = {}, baseLayers = [];
  for (const [id, b] of Object.entries(BASEMAPS)) {
    baseSources[`base-${id}`] = { type: 'raster', tiles: [b.tiles], tileSize: 256, minzoom: b.minzoom || 0, maxzoom: b.maxzoom, attribution: GSI_ATTR };
    baseLayers.push({ id: `base-${id}`, type: 'raster', source: `base-${id}`, layout: { visibility: id === state.base ? 'visible' : 'none' } });
  }
  baseSources['gsi-vector'] = {
    type: 'vector',
    url: `pmtiles://${GSI_VECTOR_URL}`,
    attribution: GSI_VECTOR_ATTR,
  };

  const map0 = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: baseSources,
      layers: baseLayers,
    },
    center: [137.5, 37.5], zoom: 4.6, minZoom: 3.5, maxZoom: 13,
    dragRotate: false, pitchWithRotate: false,
    attributionControl: {
      compact: false,
      customAttribution: 'SC: <a href="https://supercharge.info/" target="_blank" rel="noopener">supercharge.info</a>｜FLASH: <a href="https://ev-charger.jp/area/" target="_blank" rel="noopener">公式設置場所一覧</a>｜人口: <a href="https://www.e-stat.go.jp/" target="_blank" rel="noopener">e-Stat</a> 令和2年国勢調査を加工｜境界: <a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener">国土数値情報（国土交通省）</a>を加工',
    },
  });
  map = map0;
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  Promise.all([
    fetch('data/admin_stats.json', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('data/boundaries.topojson', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('data/sc.geojson', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('data/road_facilities.geojson', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('data/mesh_meta.json', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('data/mesh.bin', { cache: 'no-cache' }).then((r) => r.arrayBuffer()),
    new Promise((res) => map.on('load', res)),
  ]).then(([s, t, c, rf, mm, buf]) => {
    stats = s; topo = t; sc = c; roadFacilityData = rf; meshMeta = mm;
    mesh = parseMesh(buf, mm);
    for (const k of ['pref', 'muni_city', 'muni_ward']) {
      unitGeo[k] = topojson.feature(topo, topo.objects[k]);
    }
    $('#fetched').textContent = sc.fetched;
    setupMap();
    bindUi();
    render();
    $('#loading').hidden = true;
  }).catch((e) => {
    $('#loading').textContent = 'データの読み込みに失敗しました。再読み込みしてください。';
    console.error(e);
  });

  // ---------- state / URL ----------
  function readHash() {
    const ALLOWED = {
      mode: ['A', 'B'], unit: ['pref', 'muni_city', 'muni_ward'], metric: ['p', 'a', 'd', 'n'],
      weight: ['s', 't'], status: ['o', 'a'], layer: ['ratio', 'pop', 'sc'], bw: ['10', '30', '50'],
      rankMin: ['0', '50000', '100000', '300000'], showSc: ['0', '1'], popAlpha: ['0', '1'],
      tesla: ['0', '1'], flash: ['0', '1'], expressway: ['0', '1'], roadFacilities: ['0', '1'],
      facilityIc: ['0', '1'], facilityJct: ['0', '1'], facilitySmart: ['0', '1'],
      facilitySa: ['0', '1'], facilityPa: ['0', '1'],
      base: ['pale', 'std', 'photo', 'blank'],
    };
    const p = new URLSearchParams(location.hash.slice(1));
    for (const k of Object.keys(state)) {
      if (!p.has(k)) continue;
      const v = p.get(k);
      if (!ALLOWED[k].includes(v)) continue;
      state[k] = typeof state[k] === 'boolean' ? v === '1' : v;
    }
    if (!state.tesla && !state.flash) state.tesla = true;
  }
  function writeHash() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
    history.replaceState(null, '', '#' + p.toString());
  }

  // ---------- data ----------
  function parseMesh(buf, meta) {
    const n = meta.n;
    const f = new Float32Array(buf);
    const col = (i) => f.subarray(i * n, (i + 1) * n);
    const m = { n, lon: col(0), lat: col(1), pop: col(2), pd: {} };
    meta.bandwidths_km.forEach((bw, k) => { m.pd[bw] = col(3 + k); });
    const dlon = 45 / 3600, dlat = 30 / 3600;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (let i = 0; i < n; i++) {
      if (m.lon[i] < minLon) minLon = m.lon[i];
      if (m.lon[i] > maxLon) maxLon = m.lon[i];
      if (m.lat[i] < minLat) minLat = m.lat[i];
      if (m.lat[i] > maxLat) maxLat = m.lat[i];
    }
    const W = Math.round((maxLon - minLon) / dlon) + 1;
    const H = Math.round((maxLat - minLat) / dlat) + 1;
    const pix = new Int32Array(n);
    const lookup = new Int32Array(W * H).fill(-1);
    for (let i = 0; i < n; i++) {
      const c = Math.round((m.lon[i] - minLon) / dlon);
      const r = Math.round((maxLat - m.lat[i]) / dlat);
      pix[i] = r * W + c;
      lookup[r * W + c] = i;
    }
    m.grid = {
      W, H, pix, lookup,
      bounds: [minLon - dlon / 2, maxLat + dlat / 2 - H * dlat, minLon - dlon / 2 + W * dlon, maxLat + dlat / 2],
    };
    return m;
  }

  function activeSites() {
    return sc.features.filter((f) => {
      const network = f.properties.network || 'tesla';
      return (state.status === 'a' || f.properties.group === 'open') &&
        ((network === 'tesla' && state.tesla) || (network === 'flash' && state.flash));
    });
  }

  function scDensity(bw, status, weight) {
    const key = `${bw}|${status}|${weight}|${state.tesla}|${state.flash}`;
    if (scDensityCache.has(key)) return scDensityCache.get(key);
    const sites = activeSites();
    const sigma = Number(bw);
    const r = 4 * sigma, r2 = r * r, inv2s2 = 1 / (2 * sigma * sigma), norm = 1 / (2 * Math.PI * sigma * sigma);
    const out = new Float32Array(mesh.n);
    let total = 0;
    for (const f of sites) {
      const [lon0, lat0] = f.geometry.coordinates;
      const w = weight === 't' ? f.properties.stalls : 1;
      if (!w) continue;
      total += w;
      const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
      const dLat = r / ky;
      for (let i = 0; i < mesh.n; i++) {
        const la = mesh.lat[i];
        if (la < lat0 - dLat || la > lat0 + dLat) continue;
        const dx = (mesh.lon[i] - lon0) * kx, dy = (la - lat0) * ky;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        out[i] += w * norm * Math.exp(-d2 * inv2s2);
      }
    }
    const res = { sd: out, total };
    scDensityCache.set(key, res);
    return res;
  }

  function statSet(status = state.status) {
    const prefix = state.tesla && state.flash ? 'b' : state.flash ? 'f' : '';
    return `${prefix}${status}`;
  }

  function statKey(m = state.metric) {
    const set = statSet();
    if (m === 'd') return `${set}_d`;
    if (m === 'a') return `${set}_a_${state.weight}`;
    return `${set}_${m}_${state.weight}`;
  }

  function chargerLabel() {
    if (state.tesla && state.flash) return 'NACS充電器';
    return state.flash ? 'FLASH' : 'SC';
  }

  function metricLabel(metric = state.metric) {
    return METRIC[metric].label.replaceAll('SC', chargerLabel());
  }

  // ---------- map ----------
  function setupMap() {
    map.addSource('units', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'units-fill', type: 'fill', source: 'units', paint: { 'fill-color': NA_COLOR, 'fill-opacity': 0.78 } });
    map.addLayer({ id: 'units-line', type: 'line', source: 'units', paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.2, 9, 1] } });
    map.addLayer({ id: 'units-hl', type: 'line', source: 'units', paint: { 'line-color': '#1f2328', 'line-width': 2 }, filter: ['==', ['get', 'code'], ''] });

    map.addLayer({
      id: 'expressway-casing', type: 'line', source: 'gsi-vector', 'source-layer': 'RdCL',
      minzoom: 4,
      filter: ['any', ['==', ['get', 'vt_rdctg'], '高速自動車国道等'], ['==', ['get', 'vt_motorway'], 1]],
      layout: { visibility: state.expressway ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(255,255,255,.96)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3.2, 8, 5, 12, 8],
      },
    });
    map.addLayer({
      id: 'expressway-line', type: 'line', source: 'gsi-vector', 'source-layer': 'RdCL',
      minzoom: 4,
      filter: ['any', ['==', ['get', 'vt_rdctg'], '高速自動車国道等'], ['==', ['get', 'vt_motorway'], 1]],
      layout: { visibility: state.expressway ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#0f172a',
        'line-opacity': 0.95,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 8, 3, 12, 5],
      },
    });
    map.addSource('road-facilities-data', { type: 'geojson', data: roadFacilityData });
    map.addLayer({
      id: 'road-service-areas', type: 'circle', source: 'road-facilities-data',
      minzoom: 4,
      filter: ['in', ['get', 'code'], ['literal', [2943, 2944]]],
      layout: { visibility: state.roadFacilities ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.3, 8, 4, 12, 6],
        'circle-color': ['match', ['get', 'code'], 2943, '#f97316', '#eab308'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.2,
      },
    });
    map.addLayer({
      id: 'road-junctions', type: 'circle', source: 'road-facilities-data',
      minzoom: 6.5,
      filter: ['in', ['get', 'code'], ['literal', [2941, 2942, 2945]]],
      layout: { visibility: state.roadFacilities ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          6.5, ['match', ['get', 'code'], 2942, 3, 2],
          10, ['match', ['get', 'code'], 2942, 6, 2941, 4.5, 4],
          12, ['match', ['get', 'code'], 2942, 7, 6]],
        'circle-color': ['match', ['get', 'code'], 2942, '#059669', 2945, '#0284c7', '#7c3aed'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['match', ['get', 'code'], 2942, 1.8, 1.2],
      },
    });
    map.addLayer({
      id: 'road-facility-labels', type: 'symbol', source: 'road-facilities-data',
      minzoom: 9,
      filter: ['in', ['get', 'code'], ['literal', FACILITY_TYPES.map((f) => f.code)]],
      layout: {
        visibility: state.roadFacilities ? 'visible' : 'none',
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 12, 12],
        'text-offset': [0, 1.15],
        'text-anchor': 'top',
        'text-padding': 3,
        'text-optional': true,
      },
      paint: {
        'text-color': '#111827',
        'text-halo-color': 'rgba(255,255,255,.96)',
        'text-halo-width': 2,
        'text-halo-blur': 0.5,
      },
    });
    map.addSource('sc', { type: 'geojson', data: sc });
    map.addLayer({
      id: 'sc-points', type: 'circle', source: 'sc',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 7],
        'circle-color': ['case',
          ['==', ['get', 'network'], 'flash'], ['case', ['==', ['get', 'group'], 'open'], '#0969da', '#ffffff'],
          ['case', ['==', ['get', 'group'], 'open'], '#e31937', '#ffffff']],
        'circle-stroke-color': ['case',
          ['==', ['get', 'network'], 'flash'], ['case', ['==', ['get', 'group'], 'open'], '#ffffff', '#0969da'],
          ['case', ['==', ['get', 'group'], 'open'], '#ffffff', '#e31937']],
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'sc-labels', type: 'symbol', source: 'sc',
      minzoom: 9,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 12, 12],
        'text-offset': [0, 1.25],
        'text-anchor': 'top',
        'text-padding': 3,
        'text-optional': true,
      },
      paint: {
        'text-color': '#111827',
        'text-halo-color': 'rgba(255,255,255,.96)',
        'text-halo-width': 2,
        'text-halo-blur': 0.5,
      },
    });

    overlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay);
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' });

    const tip = $('#tooltip');
    map.on('mousemove', 'units-fill', (e) => {
      if (state.mode !== 'A') return;
      const f = e.features[0];
      map.setFilter('units-hl', ['==', ['get', 'code'], f.properties.code]);
      map.getCanvas().style.cursor = 'pointer';
      const rec = stats[state.unit][f.properties.code];
      const v = rec ? rec[statKey()] : null;
      showTip(e.originalEvent, `<b>${unitName(state.unit, f.properties.code)}</b><br>${metricLabel()}：${v == null ? '−' : METRIC[state.metric].fmt(v, state.weight)}`);
    });
    map.on('mouseleave', 'units-fill', () => {
      map.setFilter('units-hl', ['==', ['get', 'code'], '']);
      map.getCanvas().style.cursor = '';
      tip.hidden = true;
    });
    map.on('click', 'units-fill', (e) => {
      if (state.mode !== 'A') return;
      if (map.queryRenderedFeatures(e.point, { layers: ['sc-points', 'road-service-areas', 'road-junctions'] }).length) return;
      openUnitPopup(e.features[0].properties.code, e.lngLat);
    });
    map.on('mouseenter', 'sc-points', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'sc-points', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'sc-points', (e) => {
      const p = e.features[0].properties;
      const network = p.network === 'flash' ? 'FLASH' : 'テスラ SC';
      const status = { OPEN: '営業中', ADJUSTING: '調整中', EXPANDING: '営業中（拡張中）', CLOSED_TEMP: '一時休止', CONSTRUCTION: '建設中', PERMIT: '許認可中', PLAN: '計画中', VOTING: '候補' }[p.status] || p.status;
      popup.setLngLat(e.lngLat).setHTML(
        `<h3>${esc(p.name)}</h3><div>${network}</div>${p.facility && p.facility !== 'null' ? `<div>${esc(p.facility)}</div>` : ''}
        <table>
          <tr><td>状態</td><td>${status}</td></tr>
          <tr><td>ストール数</td><td>${p.stalls_est ? `${p.stalls}（推定）` : p.stalls}</td></tr>
          ${p.kw && p.kw !== 'null' ? `<tr><td>最大出力</td><td>${esc(p.kw)} kW</td></tr>` : ''}
          ${p.opened && p.opened !== 'null' ? `<tr><td>開設日</td><td>${esc(p.opened)}</td></tr>` : ''}
          ${p.hours && p.hours !== 'null' ? `<tr><td>営業時間</td><td>${esc(p.hours)}</td></tr>` : ''}
        </table>`).addTo(map);
    });
    for (const id of ['road-service-areas', 'road-junctions']) {
      map.on('mousemove', id, (e) => {
        const p = e.features[0].properties;
        map.getCanvas().style.cursor = 'pointer';
        showTip(e.originalEvent, `<b>${esc(p.name || p.type)}</b><br>${esc(p.type)}`);
      });
      map.on('mouseleave', id, () => {
        map.getCanvas().style.cursor = '';
        $('#tooltip').hidden = true;
      });
      map.on('click', id, (e) => {
        const p = e.features[0].properties;
        popup.setLngLat(e.lngLat).setHTML(`<h3>${esc(p.name || p.type)}</h3><div>${esc(p.type)}</div>`).addTo(map);
      });
    }
  }

  function showTip(ev, html) {
    const tip = $('#tooltip');
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY + 14}px`;
  }

  function unitName(unit, code) {
    const r = stats[unit][code];
    if (!r) return code;
    return unit === 'pref' ? r.name : `${r.pref} ${r.name}`;
  }

  // ---------- UI ----------
  function bindUi() {
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; render(); }));
    document.querySelectorAll('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        state[seg.dataset.key] = b.dataset.v;
        if (seg.dataset.key === 'unit') state.rankMin = b.dataset.v === 'pref' ? '0' : '100000';
        render();
      }));
    });
    $('#metric').addEventListener('change', (e) => { state.metric = e.target.value; render(); });
    $('#rank-min').addEventListener('change', (e) => { state.rankMin = e.target.value; render(); });
    $('#show-sc').addEventListener('change', (e) => { state.showSc = e.target.checked; render(); });
    $('#show-expressway').addEventListener('change', (e) => { state.expressway = e.target.checked; render(); });
    $('#show-road-facilities').addEventListener('change', (e) => {
      state.roadFacilities = e.target.checked;
      if (state.roadFacilities && !FACILITY_TYPES.some((f) => state[f.key])) {
        for (const f of FACILITY_TYPES) state[f.key] = true;
      }
      render();
    });
    document.querySelectorAll('[data-facility]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.facility;
        state[key] = !state[key];
        if (state[key]) state.roadFacilities = true;
        else if (!FACILITY_TYPES.some((f) => state[f.key])) state.roadFacilities = false;
        render();
      });
    });
    for (const key of ['tesla', 'flash']) {
      $(`#use-${key}`).addEventListener('change', (e) => {
        state[key] = e.target.checked;
        if (!state.tesla && !state.flash) {
          state[key] = true;
          e.target.checked = true;
          return;
        }
        render();
      });
    }
    $('#basemap').addEventListener('change', (e) => {
      state.base = e.target.value;
      for (const id of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${id}`, 'visibility', id === state.base ? 'visible' : 'none');
      writeHash();
    });
    $('#pop-alpha').addEventListener('change', (e) => { state.popAlpha = e.target.checked; render(); });
  }

  function syncUi() {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    document.querySelectorAll('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === state[seg.dataset.key]));
    });
    document.querySelectorAll('[data-show]').forEach((el) => { el.hidden = el.dataset.show !== state.mode; });
    $('#metric').value = state.metric;
    $('#rank-min').value = state.rankMin;
    $('#rank-min').hidden = state.unit === 'pref';
    $('#show-sc').checked = state.showSc;
    $('#show-expressway').checked = state.expressway;
    $('#show-road-facilities').checked = state.roadFacilities;
    document.querySelectorAll('[data-facility]').forEach((button) => {
      const enabled = state[button.dataset.facility];
      button.classList.toggle('off', !enabled);
      button.setAttribute('aria-pressed', String(enabled));
    });
    $('#use-tesla').checked = state.tesla;
    $('#use-flash').checked = state.flash;
    $('#basemap').value = state.base;
    $('#pop-alpha').checked = state.popAlpha;
    const weightUsed = state.mode === 'A' ? state.metric !== 'd' : state.layer !== 'pop';
    $('#ctl-weight').hidden = !weightUsed;
  }

  function render() {
    syncUi();
    writeHash();
    popup && popup.remove();
    const filters = [];
    if (state.status !== 'a') filters.push(['==', ['get', 'group'], 'open']);
    if (!(state.tesla && state.flash)) {
      filters.push(['==', ['coalesce', ['get', 'network'], 'tesla'], state.flash ? 'flash' : 'tesla']);
    }
    const chargerFilter = filters.length ? ['all', ...filters] : null;
    map.setFilter('sc-points', chargerFilter);
    map.setFilter('sc-labels', chargerFilter);
    for (const id of ['sc-points', 'sc-labels']) {
      map.setLayoutProperty(id, 'visibility', state.showSc ? 'visible' : 'none');
    }
    for (const id of ['expressway-casing', 'expressway-line']) {
      map.setLayoutProperty(id, 'visibility', state.expressway ? 'visible' : 'none');
    }
    const enabledCodes = FACILITY_TYPES.filter((f) => state[f.key]).map((f) => f.code);
    map.setFilter('road-service-areas', ['in', ['get', 'code'], ['literal', enabledCodes.filter((c) => c === 2943 || c === 2944)]]);
    map.setFilter('road-junctions', ['in', ['get', 'code'], ['literal', enabledCodes.filter((c) => c === 2941 || c === 2942 || c === 2945)]]);
    map.setFilter('road-facility-labels', ['in', ['get', 'code'], ['literal', enabledCodes]]);
    for (const id of ['road-service-areas', 'road-junctions', 'road-facility-labels']) {
      map.setLayoutProperty(id, 'visibility', state.roadFacilities ? 'visible' : 'none');
    }
    if (state.mode === 'A') renderA(); else renderB();
  }

  // ---------- Method A ----------
  function quantileBreaks(values, k) {
    const v = values.slice().sort((a, b) => a - b);
    const min = v[0];
    const br = [];
    for (let i = 1; i < k; i++) {
      const q = v[Math.min(v.length - 1, Math.floor((i / k) * v.length))];
      if (q > min && (!br.length || q > br[br.length - 1])) br.push(q);
    }
    return br;
  }

  function spreadColors(n) {
    const p = WORST_TO_BEST;
    if (n <= 1) return [p[Math.floor((p.length - 1) / 2)]];
    return Array.from({ length: n }, (_, i) => p[Math.round((i * (p.length - 1)) / (n - 1))]);
  }

  function renderA() {
    overlay.setProps({ layers: [] });
    for (const id of ['units-fill', 'units-line', 'units-hl']) map.setLayoutProperty(id, 'visibility', 'visible');
    const recs = stats[state.unit];
    const key = statKey();
    const m = METRIC[state.metric];
    const features = unitGeo[state.unit].features.map((f) => {
      const r = recs[f.properties.code];
      return { type: 'Feature', geometry: f.geometry, properties: { code: f.properties.code, v: r ? r[key] : null } };
    });
    map.getSource('units').setData({ type: 'FeatureCollection', features });

    const vals = Object.values(recs).map((r) => r[key]).filter((v) => v != null);
    const hasZeroClass = m.better === 'high';
    const classVals = hasZeroClass ? vals.filter((v) => v > 0) : vals;
    const isCount = state.metric === 'n';
    let breaks;
    const distinct = [...new Set(classVals)].sort((a, b) => a - b);
    if (isCount && distinct.length <= WORST_TO_BEST.length) breaks = distinct.slice(1);
    else breaks = quantileBreaks(classVals, WORST_TO_BEST.length);
    const colors = spreadColors(breaks.length + 1);
    const ordered = m.better === 'high' ? colors : colors.slice().reverse();
    const step = ['step', ['get', 'v'], ordered[0]];
    breaks.forEach((b, i) => step.push(b, ordered[i + 1]));
    const expr = ['case', ['==', ['get', 'v'], null], NA_COLOR];
    if (hasZeroClass) expr.push(['<=', ['get', 'v'], 0], ZERO_COLOR);
    expr.push(step);
    map.setPaintProperty('units-fill', 'fill-color', expr);

    const fmtB = (v) => (isCount ? String(Math.round(v)) : v.toFixed(state.metric === 'd' ? 1 : 2));
    const rows = [];
    if (hasZeroClass) rows.push({ color: ZERO_COLOR, label: '0' });
    const lo = classVals.length ? Math.min(...classVals) : 0;
    const hi = classVals.length ? Math.max(...classVals) : 0;
    const edges = [lo, ...breaks, hi];
    for (let i = 0; i < ordered.length; i++) {
      const a = edges[i];
      const last = i === ordered.length - 1;
      const b = isCount && !last ? edges[i + 1] - 1 : edges[i + 1];
      rows.push({ color: ordered[i], label: isCount && a === b ? fmtB(a) : `${fmtB(a)} 〜 ${fmtB(b)}` });
    }
    const unitSuffix = state.metric === 'd' ? '（km）' : state.metric === 'n' ? `（${WEIGHT_LABEL[state.weight]}）` : `（${WEIGHT_LABEL[state.weight]}／10万人）`;
    legend(`${metricLabel()}${unitSuffix}　${m.better === 'high' ? '赤ほど少ない' : '赤ほど遠い'}`, rows.map((r) => ({ css: r.color, label: r.label })));
    $('#metric-note').textContent = m.note.replaceAll('SC', chargerLabel());
    renderRanking(recs, key, m);
  }

  function renderRanking(recs, key, m) {
    const min = Number(state.rankMin);
    const list = Object.entries(recs)
      .filter(([, r]) => r[key] != null && r.pop >= min)
      .sort(([, a], [, b]) => (m.better === 'high' ? a[key] - b[key] : b[key] - a[key]) || b.pop - a.pop)
      .slice(0, 30);
    $('#rank-title').textContent = `${m.better === 'high' ? '人口のわりに少ない' : `最寄り${chargerLabel()}が遠い`}${UNIT_LABEL[state.unit].replace('（政令市は区）', '')}`;
    const ol = $('#rank-list');
    ol.innerHTML = '';
    for (const [code, r] of list) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="nm">${esc(state.unit === 'pref' ? r.name : `${r.name}（${r.pref}）`)}</span><span class="pp">${nf.format(Math.round(r.pop / 1000) / 10)}万人</span><span>${r[key] === 0 && m.better === 'high' ? 'なし' : m.fmt(r[key], state.weight)}</span>`;
      li.addEventListener('click', () => flyToUnit(code));
      ol.appendChild(li);
    }
  }

  function flyToUnit(code) {
    const f = unitGeo[state.unit].features.find((x) => x.properties.code === code);
    if (!f) return;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
        b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
      } else c.forEach(walk);
    };
    walk(f.geometry.coordinates);
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 10, duration: 800 });
    map.once('moveend', () => openUnitPopup(code, { lng: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 }));
  }

  function openUnitPopup(code, lngLat) {
    const r = stats[state.unit][code];
    if (!r) return;
    const w = state.weight, set = statSet();
    const key = statKey();
    const m = METRIC[state.metric];
    const cur = r[key];
    const ranked = Object.values(stats[state.unit]).filter((x) => x[key] != null);
    const rank = 1 + ranked.filter((x) => (m.better === 'high' ? x[key] < cur : x[key] > cur)).length;
    const rows = [
      ['人口（2020年）', `${nf.format(r.pop)} 人`],
      [`${chargerLabel()}数（営業中）`, METRIC.n.fmt(r[`${statSet('o')}_n_${w}`], w)],
      [`${chargerLabel()}数（計画含む）`, METRIC.n.fmt(r[`${statSet('a')}_n_${w}`], w)],
      [`10万人あたり`, METRIC.p.fmt(r[`${set}_p_${w}`], w)],
      [`30km圏アクセス`, METRIC.a.fmt(r[`${set}_a_${w}`], w)],
      [`最寄り${chargerLabel()}平均距離`, METRIC.d.fmt(r[`${set}_d`])],
    ];
    popup.setLngLat(lngLat).setHTML(
      `<h3>${esc(unitName(state.unit, code))}</h3>
      <table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
      <div class="muted" style="margin-top:4px">${metricLabel()}：${m.better === 'high' ? '少ない' : '遠い'}順 ${rank}位／${ranked.length}</div>`
    ).addTo(map);
  }

  // ---------- Method B ----------
  function renderB() {
    for (const id of ['units-fill', 'units-line', 'units-hl']) map.setLayoutProperty(id, 'visibility', 'none');
    const bw = Number(state.bw);
    const pd = mesh.pd[bw];
    const { sd, total } = scDensity(bw, state.status, state.weight);
    const P = meshMeta.population_total;
    const k = total / P;
    const { W, H, pix, lookup, bounds } = mesh.grid;
    const img = new ImageData(W, H);
    const d = img.data;
    const classes = state.layer === 'ratio' ? RATIO_CLASSES : state.layer === 'pop' ? POP_CLASSES : SC_CLASSES;
    let popLow = 0, popVeryLow = 0, popOk = 0;
    for (let i = 0; i < mesh.n; i++) {
      let v;
      if (state.layer === 'ratio') {
        v = sd[i] / (pd[i] * k);
        if (v < 0.5) popLow += mesh.pop[i];
        if (v < 0.25) popVeryLow += mesh.pop[i];
        if (v >= 1) popOk += mesh.pop[i];
      } else if (state.layer === 'pop') v = mesh.pop[i];
      else v = sd[i] * 1000;
      let c = classes[classes.length - 1].color;
      for (const cl of classes) { if (v < cl.max) { c = cl.color; break; } }
      const a = state.popAlpha && state.layer !== 'pop'
        ? 0.25 + 0.75 * Math.min(1, Math.log10(mesh.pop[i] + 1) / 3.5) : 0.9;
      const o = pix[i] * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = Math.round(a * 235);
    }
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d').putImageData(img, 0, 0);
    bitmap = canvas;

    overlay.setProps({
      layers: [new deck.BitmapLayer({
        id: `mesh-${state.layer}-${state.bw}-${state.status}-${state.weight}-${state.popAlpha}`,
        image: bitmap,
        bounds,
        _imageCoordinateSystem: deck.COORDINATE_SYSTEM.LNGLAT,
        textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
        pickable: true,
        beforeId: 'expressway-casing',
        onHover: (info) => {
          const tip = $('#tooltip');
          if (!info.coordinate) { tip.hidden = true; return; }
          const px = Math.floor((info.coordinate[0] - bounds[0]) / (45 / 3600));
          const py = Math.floor((bounds[3] - info.coordinate[1]) / (30 / 3600));
          const i = px >= 0 && py >= 0 && px < W && py < H ? lookup[py * W + px] : -1;
          if (i < 0) { tip.hidden = true; return; }
          const ratio = sd[i] / (pd[i] * k);
          const unit = state.weight === 't' ? 'ストール' : 'サイト';
          const r = map.getCanvas().getBoundingClientRect();
          showTip({ clientX: r.left + info.x, clientY: r.top + info.y }, `人口（このメッシュ）：${nf.format(Math.round(mesh.pop[i]))} 人<br>
            平滑化人口密度：${nf.format(Math.round(pd[i]))} 人/km²<br>
            ${chargerLabel()}密度：${(sd[i] * 1000).toFixed(2)} ${unit}/1,000km²<br>
            充足率：<b>${ratio < 0.01 ? '0.01 未満' : ratio.toFixed(2)}</b>`);
        },
      })],
    });

    const unit = state.weight === 't' ? 'ストール' : 'サイト';
    if (state.layer === 'ratio') {
      legend(`充足率（実際の${chargerLabel()}密度 ÷ 人口比どおりの密度）`, RATIO_CLASSES.map((c) => ({ css: rgb(c.color), label: c.label })));
      $('#metric-note').textContent = `人口分布どおりに${chargerLabel()}が配置されていた場合の密度に対する、実際の密度の比です。1未満は人口のわりに少ない地域です。人口と充電器の双方を同じ幅（σ=${state.bw}km）のガウスカーネルで平滑化しています。`;
      $('#summary').innerHTML = `
        <div>充足率 0.5 未満の地域に住む人口</div>
        <div class="big">${fmtPop(popLow)}（${(popLow / P * 100).toFixed(1)}%）</div>
        <div>うち 0.25 未満：${fmtPop(popVeryLow)}（${(popVeryLow / P * 100).toFixed(1)}%）</div>
        <div>充足率 1 以上：${fmtPop(popOk)}（${(popOk / P * 100).toFixed(1)}%）</div>
        <div class="muted">全国 ${nf.format(total)} ${unit}／${fmtPop(P)}</div>`;
    } else if (state.layer === 'pop') {
      legend('人口（1kmメッシュあたり）', POP_CLASSES.map((c) => ({ css: rgb(c.color), label: c.label })));
      $('#metric-note').textContent = '令和2年国勢調査の1kmメッシュ人口です。';
      $('#summary').innerHTML = '';
    } else {
      legend(`${chargerLabel()}密度（${unit}／1,000km²）`, SC_CLASSES.map((c) => ({ css: rgb(c.color), label: c.label })));
      $('#metric-note').textContent = `${chargerLabel()}の${unit}数を幅σ=${state.bw}kmのガウスカーネルで平滑化した密度です。`;
      $('#summary').innerHTML = '';
    }
  }

  // ---------- helpers ----------
  function legend(title, rows) {
    $('#legend').innerHTML = `<div class="title">${title}</div>` +
      rows.map((r) => `<div class="row"><span class="sw" style="background:${r.css}"></span>${r.label}</div>`).join('');
  }
  function rgb(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
  function fmtPop(p) { return p >= 1e8 ? `${(p / 1e8).toFixed(2)}億人` : `${nf.format(Math.round(p / 1e4))}万人`; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
