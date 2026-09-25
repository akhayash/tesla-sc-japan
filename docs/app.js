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
  const NEAR_CLASSES = [
    { max: 2, color: [33, 102, 172], label: '2km 未満' },
    { max: 5, color: [146, 197, 222], label: '2 〜 5km' },
    { max: 10, color: [253, 219, 199], label: '5 〜 10km' },
    { max: 20, color: [244, 165, 130], label: '10 〜 20km' },
    { max: 40, color: [214, 96, 77], label: '20 〜 40km' },
    { max: Infinity, color: [103, 0, 31], label: '40km 以上' },
  ];
  const BW_STOPS = ['2', '3', '5', '7', '10', '15', '20', '30', '50'];
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
  const POI_TYPES = [
    { key: 'poiConvenience', type: 'convenience', label: 'コンビニ', color: '#475569', minzoom: 10.5, iconzoom: 12.5 },
    { key: 'poiMichinoeki', type: 'michinoeki', label: '道の駅', color: '#9a5b13', minzoom: 4, iconzoom: 7.5 },
    { key: 'poiMall', type: 'mall', label: 'ショッピングモール', color: '#a21caf', minzoom: 7, iconzoom: 10 },
  ];

  const state = {
    mode: 'B', unit: 'pref', metric: 'p', weight: 't', status: 'o',
    layer: 'none', bw: '10', tesla: true, flash: false,
    showSc: true, popAlpha: true, expressway: true, roadFacilities: true,
    facilityIc: true, facilityJct: true, facilitySmart: true, facilitySa: true, facilityPa: true,
    poiConvenience: false, poiMichinoeki: false, poiMall: false,
    smartToll: true,
    rankMin: '0', base: 'pale',
  };
  let initialView = null, pendingSel = null, selectedId = null, selectedCoords = null;
  let poiPromise = null, tollPromise = null;
  readHash();

  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('ja-JP');
  let stats, topo, sc, roadFacilityData, meshMeta, mesh, map, overlay, popup;
  const unitGeo = {};
  const chargerById = new Map();
  const scDensityCache = new Map();
  const nearestCache = new Map();
  const pdLoads = new Map();
  let bitmap = null, baseSwitcher = null;

  const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
  const GSI_VECTOR_ATTR = '<a href="https://github.com/gsi-cyberjapan/optimal_bvmap" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル</a>';
  const GSI_VECTOR_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles';
  const pmtilesProtocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
  const BASEMAPS = {
    pale: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxzoom: 18, label: '淡色地図', short: '地図' },
    std: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxzoom: 18, label: '標準地図' },
    photo: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxzoom: 18, label: '航空写真' },
    blank: { tiles: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', minzoom: 5, maxzoom: 14, label: '白地図', note: '白地図（拡大時に表示）' },
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
    center: initialView ? initialView.center : [137.5, 37.5], zoom: initialView ? Math.min(initialView.zoom, 13) : 4.6, minZoom: 3.5, maxZoom: 13,
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
    for (const f of sc.features) chargerById.set(String(f.properties.id), { props: f.properties, coords: f.geometry.coordinates });
    mesh = parseMesh(buf, mm);
    for (const k of ['pref', 'muni_city', 'muni_ward']) {
      unitGeo[k] = topojson.feature(topo, topo.objects[k]);
    }
    $('#fetched').textContent = sc.fetched;
    renderBrandMeta();
    setupMap();
    bindUi();
    window.MapSearch?.init({
      map, openCharger: flyToCharger, isHazardMode: () => state.mode === 'C',
      getChargerFilter: () => ({ tesla: state.tesla, flash: state.flash, planned: state.status === 'a' }),
      getData: () => ({ sc, roadFacilities: roadFacilityData, stats, unitGeo }),
    });
    render();
    $('#loading').hidden = true;
    restoreSelection();
  }).catch((e) => {
    $('#loading').textContent = 'データの読み込みに失敗しました。再読み込みしてください。';
    console.error(e);
  });

  // ---------- state / URL ----------
  function renderBrandMeta() {
    const open = sc.features.filter((f) => f.properties.group === 'open');
    const n = (net) => open.filter((f) => (f.properties.network || 'tesla') === net).length;
    const d = String(sc.fetched || '').split('-');
    const date = d.length === 3 ? `${Number(d[1])}/${Number(d[2])}` : sc.fetched;
    $('#brand-meta').innerHTML = `<span><i></i>Tesla <b>${n('tesla')}</b></span><span><i class="flash"></i>FLASH <b>${n('flash')}</b></span><span>${esc(date)} 更新</span>`;
  }

  // ---------- state / URL ----------
  function readHash() {
    const ALLOWED = {
      mode: ['A', 'B', 'C'], unit: ['pref', 'muni_city', 'muni_ward'], metric: ['p', 'a', 'd', 'n'],
      weight: ['s', 't'], status: ['o', 'a'], layer: ['ratio', 'pop', 'sc', 'near', 'none'], bw: BW_STOPS,
      rankMin: ['0', '50000', '100000', '300000'], showSc: ['0', '1'], popAlpha: ['0', '1'],
      tesla: ['0', '1'], flash: ['0', '1'], expressway: ['0', '1'], roadFacilities: ['0', '1'],
      facilityIc: ['0', '1'], facilityJct: ['0', '1'], facilitySmart: ['0', '1'],
      facilitySa: ['0', '1'], facilityPa: ['0', '1'],
      poiConvenience: ['0', '1'], poiMichinoeki: ['0', '1'], poiMall: ['0', '1'], smartToll: ['0', '1'],
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
    const at = (p.get('at') || '').split(',').map(Number);
    if (at.length === 3 && at.every(Number.isFinite) && at[0] > 120 && at[0] < 155 && at[1] > 20 && at[1] < 50 && at[2] >= 3.5 && at[2] <= 17) {
      initialView = { center: [at[0], at[1]], zoom: at[2] };
    }
    const sel = p.get('sel') || '';
    if (sel.length <= 160 && /^(c|toll|poi):/.test(sel)) pendingSel = sel;
  }
  function writeHash() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
    window.HazardOverlay?.writeHash(p);
    if (map) {
      const c = map.getCenter();
      p.set('at', `${c.lng.toFixed(4)},${c.lat.toFixed(4)},${map.getZoom().toFixed(2)}`);
    }
    if (selectedId) p.set('sel', selectedId);
    history.replaceState(null, '', '#' + p.toString());
  }

  // ---------- shareable place links ----------
  function openPlacePopup(id, coords, html) {
    popup.setLngLat(coords).setHTML(html).addTo(map);
    selectedId = id;
    selectedCoords = coords;
    writeHash();
  }
  function shareButtonHtml() {
    return '<button type="button" class="share-link" data-share>🔗 この場所のリンクをコピー</button>';
  }
  function shareUrl() {
    const url = new URL(location.href);
    const p = new URLSearchParams(url.hash.slice(1));
    if (selectedCoords) {
      const z = Math.min(Math.max(map.getZoom(), 12), map.getMaxZoom());
      p.set('at', `${selectedCoords[0].toFixed(5)},${selectedCoords[1].toFixed(5)},${z.toFixed(2)}`);
    }
    if (selectedId) p.set('sel', selectedId);
    url.hash = p.toString();
    return url.toString();
  }
  async function copyShareLink(button) {
    const url = shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      const label = button.textContent;
      button.textContent = '✓ リンクをコピーしました';
      button.classList.add('copied');
      setTimeout(() => { button.textContent = label; button.classList.remove('copied'); }, 2000);
    } catch {
      window.prompt('このURLをコピーしてください', url);
    }
  }
  async function restoreSelection() {
    if (initialView) map.jumpTo({ center: initialView.center, zoom: Math.min(initialView.zoom, map.getMaxZoom()) });
    const sel = pendingSel;
    pendingSel = null;
    if (!sel) return;
    const [kind, ...rest] = sel.split(':');
    const key = rest.join(':');
    let target = null;
    if (kind === 'c') {
      const c = chargerById.get(key);
      if (c) target = { id: sel, coords: c.coords, html: () => chargerPopupHtml(c.props, c.coords) };
    } else if (kind === 'toll') {
      if (!state.smartToll) { state.smartToll = true; render(); }
      renderSmartToll();
      await tollPromise;
      const i = tollData?.pairs.findIndex((p) => p.station === key) ?? -1;
      if (i >= 0) target = { id: sel, coords: tollData.pairs[i].station_coords, html: () => tollPopupHtml(i) };
    } else if (kind === 'poi') {
      const [type, ll] = [key.split(':')[0], key.split(':')[1] || ''];
      const t = POI_TYPES.find((x) => x.type === type);
      const [lon, lat] = ll.split(',').map(Number);
      if (t && Number.isFinite(lon) && Number.isFinite(lat)) {
        if (!state[t.key]) { state[t.key] = true; render(); }
        renderPoi();
        await poiPromise;
        const i = poiItems.findIndex((it) => it.t === type && Math.abs(it.coords[0] - lon) < 0.0003 && Math.abs(it.coords[1] - lat) < 0.0003);
        if (i >= 0) target = { id: sel, coords: poiItems[i].coords, html: () => poiPopupHtml(i) };
      }
    }
    if (!target) return;
    if (!initialView) map.jumpTo({ center: target.coords, zoom: 12 });
    openPlacePopup(target.id, target.coords, target.html());
  }
  const poiSelId = (item) => `poi:${item.t}:${item.coords[0].toFixed(5)},${item.coords[1].toFixed(5)}`;

  // ---------- data ----------
  function parseMesh(buf, meta) {
    const n = meta.n;
    const f = new Float32Array(buf);
    const col = (i) => f.subarray(i * n, (i + 1) * n);
    const m = { n, lon: col(0), lat: col(1), pop: col(2), pd: {} };
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

  function loadPd(bw) {
    const key = String(bw);
    if (mesh.pd[key]) return Promise.resolve(mesh.pd[key]);
    if (!pdLoads.has(key)) {
      const file = meshMeta.pd_files?.[key];
      const p = file
        ? fetch(`data/${file}`, { cache: 'no-cache' }).then((r) => {
          if (!r.ok) throw new Error(`${file}: ${r.status}`);
          return r.arrayBuffer();
        }).then((buf) => (mesh.pd[key] = new Float32Array(buf)))
        : Promise.reject(new Error(`no population density for σ=${key}km`));
      p.catch(() => pdLoads.delete(key));
      pdLoads.set(key, p);
    }
    return pdLoads.get(key);
  }

  // Straight-line distance (km) from each mesh cell to the nearest active charger.
  function nearestCharger(status) {
    const key = `${status}|${state.tesla}|${state.flash}`;
    if (nearestCache.has(key)) return nearestCache.get(key);
    const sites = activeSites();
    const sx = new Float64Array(sites.length), sy = new Float64Array(sites.length);
    sites.forEach((f, j) => { [sx[j], sy[j]] = f.geometry.coordinates; });
    const dist = new Float32Array(mesh.n), idx = new Int32Array(mesh.n).fill(-1);
    const ky = 110.574;
    for (let i = 0; i < mesh.n; i++) {
      const lon = mesh.lon[i], lat = mesh.lat[i];
      const kx = 111.32 * Math.cos(lat * Math.PI / 180);
      let best = Infinity, bj = -1;
      for (let j = 0; j < sx.length; j++) {
        const dy = (sy[j] - lat) * ky;
        const dy2 = dy * dy;
        if (dy2 >= best) continue;
        const dx = (sx[j] - lon) * kx;
        const d2 = dx * dx + dy2;
        if (d2 < best) { best = d2; bj = j; }
      }
      dist[i] = Math.sqrt(best);
      idx[i] = bj;
    }
    const res = { dist, idx, sites };
    nearestCache.set(key, res);
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
        'line-color': '#006e54',
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
        'circle-color': ['match', ['get', 'code'], 2942, '#334155', 2945, '#0284c7', '#7c3aed'],
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
    registerChargerIcons();
    const powerScale = ['step', ['coalesce', ['get', 'kw'], 0], 0.8, 100, 1, 200, 1.25];
    map.addLayer({
      id: 'sc-points', type: 'circle', source: 'sc',
      maxzoom: ICON_MIN_ZOOM,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['*', 3, powerScale], 10, ['*', 7, powerScale]],
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
      id: 'sc-icons', type: 'symbol', source: 'sc',
      minzoom: ICON_MIN_ZOOM,
      layout: {
        'icon-image': ['concat', 'charger-',
          ['coalesce', ['get', 'network'], 'tesla'], '-',
          ['step', ['coalesce', ['get', 'kw'], 0], 0, 1, 1, 100, 2, 200, 3], '-',
          ['get', 'group']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], ICON_MIN_ZOOM, 0.85, 12, 1.1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['coalesce', ['get', 'kw'], 0],
      },
    });
    map.addLayer({
      id: 'sc-labels', type: 'symbol', source: 'sc',
      minzoom: 9,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 12, 12],
        'text-offset': [0, 1.35],
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
    popup.on('close', () => { selectedId = null; selectedCoords = null; writeHash(); });
    map.on('moveend', writeHash);
    window.HazardOverlay?.init({
      map, beforeId: 'expressway-casing', ringBeforeId: 'sc-points',
      getActiveSites: activeSites,
      openCharger: flyToCharger,
    });

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
      if (map.queryRenderedFeatures(e.point, { layers: ['sc-points', 'sc-icons', 'road-service-areas', 'road-junctions', 'toll-station', 'toll-ic', ...POI_TYPES.flatMap((t) => [`poi-${t.type}`, `poi-${t.type}-dot`])].filter((id) => map.getLayer(id)) }).length) return;
      openUnitPopup(e.features[0].properties.code, e.lngLat);
    });
    for (const id of ['sc-points', 'sc-icons']) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
      map.on('click', id, (e) => {
        const c = chargerById.get(String(e.features[0].properties.id));
        if (!c) return;
        openPlacePopup(`c:${e.features[0].properties.id}`, c.coords, chargerPopupHtml(c.props, c.coords));
      });
    }
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

  function flyToCharger(id) {
    const c = chargerById.get(String(id));
    if (!c) return;
    map.flyTo({ center: c.coords, zoom: Math.max(map.getZoom(), 13), duration: 900 });
    map.once('moveend', () => openPlacePopup(`c:${id}`, c.coords, chargerPopupHtml(c.props, c.coords)));
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
    document.addEventListener('click', (e) => {
      const fig = e.target.closest('[data-aerial-id]');
      if (fig) openAerialViewer(fig.dataset.aerialId);
      const share = e.target.closest('[data-share]');
      if (share) copyShareLink(share);
    });
    document.addEventListener('keydown', (e) => {
      const fig = e.target.closest?.('[data-aerial-id]');
      if (fig && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openAerialViewer(fig.dataset.aerialId);
      }
      if (e.key === 'Escape' && !$('#aerial-viewer').hidden) closeAerialViewer();
    });
    $('#viewer-close').addEventListener('click', closeAerialViewer);
    $('#aerial-viewer').addEventListener('click', (e) => { if (e.target.id === 'aerial-viewer') closeAerialViewer(); });
    $('#panel-toggle').addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('panel-collapsed');
      $('#panel-toggle').setAttribute('aria-expanded', String(!collapsed));
      $('#panel-toggle').setAttribute('aria-label', collapsed ? 'サイドパネルを開く' : 'サイドパネルを閉じる');
      setTimeout(() => map.resize(), 220);
    });
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; render(); }));
    document.querySelectorAll('.seg[data-key]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        state[seg.dataset.key] = seg.dataset.key === 'layer' && state.layer === b.dataset.v ? 'none' : b.dataset.v;
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
    document.querySelectorAll('[data-poi]').forEach((button) => {
      button.addEventListener('click', () => {
        state[button.dataset.poi] = !state[button.dataset.poi];
        render();
      });
    });
    $('#smart-toll-toggle').addEventListener('click', () => {
      state.smartToll = !state.smartToll;
      render();
    });
    $('#toll-key').innerHTML = [['kashikoi', '賢い料金（ETC2.0全車・2時間以内）'], ['ev', 'EV路外充電（ETC2.0のEV・60分以内）']]
      .map(([kind, label]) => `<span><img src="${drawTollIcon(kind).toDataURL()}" alt="">${label}</span>`).join('');
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
    baseSwitcher = window.BaseSwitcher?.init({
      map,
      options: Object.entries(BASEMAPS).map(([id, b]) => ({ id, tiles: b.tiles, label: b.label, short: b.short, note: b.note })),
      get: () => state.base,
      set: (id) => {
        state.base = id;
        for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${k}`, 'visibility', k === state.base ? 'visible' : 'none');
        writeHash();
      },
    });
    $('#pop-alpha').addEventListener('change', (e) => { state.popAlpha = e.target.checked; render(); });
    const slider = $('#bw-slider');
    slider.addEventListener('input', () => { $('#bw-value').textContent = `σ=${BW_STOPS[slider.value]}km`; });
    slider.addEventListener('change', () => { state.bw = BW_STOPS[slider.value]; render(); });
  }

  function syncUi() {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    document.querySelectorAll('.seg[data-key]').forEach((seg) => {
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
    document.querySelectorAll('[data-poi]').forEach((button) => {
      const enabled = state[button.dataset.poi];
      button.classList.toggle('off', !enabled);
      button.setAttribute('aria-pressed', String(enabled));
    });
    $('#smart-toll-toggle').classList.toggle('off', !state.smartToll);
    $('#smart-toll-toggle').setAttribute('aria-pressed', String(state.smartToll));
    $('#toll-key').hidden = !state.smartToll;
    $('#use-tesla').checked = state.tesla;
    $('#use-flash').checked = state.flash;
    baseSwitcher?.sync();
    $('#pop-alpha').checked = state.popAlpha;
    $('#bw-slider').value = String(BW_STOPS.indexOf(state.bw));
    $('#bw-value').textContent = `σ=${state.bw}km`;
    const meshDensityShown = state.mode === 'B' && (state.layer === 'ratio' || state.layer === 'sc');
    $('#ctl-bw').hidden = !meshDensityShown;
    $('#ctl-pop-alpha').hidden = !(meshDensityShown || (state.mode === 'B' && state.layer === 'near'));
    const weightUsed = state.mode === 'A' ? state.metric !== 'd' : meshDensityShown;
    $('#ctl-weight').hidden = !weightUsed;
    $('#result-guide').hidden = state.mode === 'C' || (state.mode === 'B' && state.layer === 'none');
    syncPowerKey();
    syncBrandKey();
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
    for (const id of ['sc-points', 'sc-icons', 'sc-labels']) {
      map.setFilter(id, chargerFilter);
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
    renderPoi();
    renderSmartToll();
    window.HazardOverlay?.setActive(state.mode === 'C');
    map.setMaxZoom(state.mode === 'C' ? 17 : 13);
    if (state.mode === 'A') renderA();
    else if (state.mode === 'B') renderB();
    else renderC();
    window.MapSearch?.update();
  }

  // ---------- Hazard tab ----------
  function renderC() {
    overlay.setProps({ layers: [] });
    for (const id of ['units-fill', 'units-line', 'units-hl']) map.setLayoutProperty(id, 'visibility', 'none');
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
    if (state.layer === 'none') {
      overlay.setProps({ layers: [] });
      bitmap = null;
      $('#tooltip').hidden = true;
      $('#legend').innerHTML = '';
      $('#metric-note').textContent = '';
      $('#summary').innerHTML = '';
      return;
    }
    const bw = Number(state.bw);
    const pd = mesh.pd[state.bw];
    if (state.layer === 'ratio' && !pd) {
      $('#metric-note').textContent = `σ=${state.bw}km の人口分布を読み込んでいます…`;
      const want = state.bw;
      loadPd(want).then(() => {
        if (state.mode === 'B' && state.layer === 'ratio' && state.bw === want) renderB();
      }).catch((e) => {
        console.error(e);
        $('#metric-note').textContent = 'σの人口分布を読み込めませんでした。再読み込みしてください。';
      });
      return;
    }
    if (state.layer === 'near') return renderNear();
    if (!pd) loadPd(state.bw).catch(() => {});
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
          const ratio = pd ? sd[i] / (pd[i] * k) : NaN;
          const pdi = mesh.pd[state.bw]?.[i];
          const unit = state.weight === 't' ? 'ストール' : 'サイト';
          const r = map.getCanvas().getBoundingClientRect();
          showTip({ clientX: r.left + info.x, clientY: r.top + info.y }, `人口（このメッシュ）：${nf.format(Math.round(mesh.pop[i]))} 人<br>
            ${pdi === undefined ? '' : `平滑化人口密度：${nf.format(Math.round(pdi))} 人/km²<br>`}
            ${chargerLabel()}密度：${(sd[i] * 1000).toFixed(2)} ${unit}/1,000km²
            ${Number.isFinite(ratio) ? `<br>充足率：<b>${ratio < 0.01 ? '0.01 未満' : ratio.toFixed(2)}</b>` : ''}`);
        },
      })],
    });

    const unit = state.weight === 't' ? 'ストール' : 'サイト';
    if (state.layer === 'ratio') {
      legend(`充足率（実際の${chargerLabel()}密度 ÷ 人口比どおりの密度）`, RATIO_CLASSES.map((c) => ({ css: rgb(c.color), label: c.label })));
      $('#metric-note').textContent = `人口分布どおりに${chargerLabel()}が配置されていた場合の密度に対する、実際の密度の比です。1未満は人口のわりに少ない地域です。人口と充電器の双方を同じ幅（σ=${state.bw}km）のガウスカーネルで平滑化しています。${bw <= 5 ? '幅が小さいと充電器から離れたメッシュはほぼ0になり、まだらに見えます。空白地帯の把握には「最寄り距離」も参考にしてください。' : ''}`;
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

  function renderNear() {
    const { dist, idx, sites } = nearestCharger(state.status);
    const P = meshMeta.population_total;
    const { W, H, pix, lookup, bounds } = mesh.grid;
    const img = new ImageData(W, H);
    const d = img.data;
    const bandPop = new Float64Array(NEAR_CLASSES.length);
    for (let i = 0; i < mesh.n; i++) {
      let b = NEAR_CLASSES.findIndex((cl) => dist[i] < cl.max);
      if (b < 0) b = NEAR_CLASSES.length - 1;
      bandPop[b] += mesh.pop[i];
      const c = NEAR_CLASSES[b].color;
      const a = state.popAlpha ? 0.25 + 0.75 * Math.min(1, Math.log10(mesh.pop[i] + 1) / 3.5) : 0.9;
      const o = pix[i] * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = Math.round(a * 235);
    }
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d').putImageData(img, 0, 0);
    bitmap = canvas;
    overlay.setProps({
      layers: [new deck.BitmapLayer({
        id: `mesh-near-${state.status}-${state.tesla}-${state.flash}-${state.popAlpha}`,
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
          if (i < 0 || idx[i] < 0) { tip.hidden = true; return; }
          const s = sites[idx[i]].properties;
          const r = map.getCanvas().getBoundingClientRect();
          showTip({ clientX: r.left + info.x, clientY: r.top + info.y }, `最寄りの${chargerLabel()}まで：<b>${dist[i] < 10 ? dist[i].toFixed(1) : Math.round(dist[i])} km</b>（直線）<br>
            ${esc(s.name || '')}<br>
            人口（このメッシュ）：${nf.format(Math.round(mesh.pop[i]))} 人`);
        },
      })],
    });
    legend(`最寄りの${chargerLabel()}までの直線距離`, NEAR_CLASSES.map((c) => ({ css: rgb(c.color), label: c.label })));
    $('#metric-note').textContent = `各1kmメッシュの中心から、最寄りの${chargerLabel()}（${state.status === 'a' ? '計画・建設中を含む' : '営業中'}）までの直線距離です。道路距離や高速道路の出入口は考慮していません。平滑化はしていないので、密集地の数kmの空白もそのまま表れます。`;
    const far = (km) => bandPop.reduce((s, v, b) => s + (NEAR_CLASSES[b].max > km ? v : 0), 0);
    const row = (km) => { const v = far(km); return `${fmtPop(v)}（${(v / P * 100).toFixed(1)}%）`; };
    $('#summary').innerHTML = `
      <div>最寄りの充電器まで 10km 以上の地域に住む人口</div>
      <div class="big">${row(10)}</div>
      <div>20km 以上：${row(20)}</div>
      <div>40km 以上：${row(40)}</div>
      <div class="muted">5km 未満：${fmtPop(bandPop[0] + bandPop[1])}（${((bandPop[0] + bandPop[1]) / P * 100).toFixed(1)}%）／対象 ${nf.format(sites.length)} サイト</div>`;
  }

  // ---------- helpers ----------
  const BOLT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 4 14h7l-1.5 8L19 10h-7z"/></svg>';
  const STATUS_LABEL = { OPEN: '営業中', ADJUSTING: '調整中', EXPANDING: '営業中（拡張中）', CLOSED_TEMP: '一時休止', CONSTRUCTION: '建設中', PERMIT: '許認可中', PLAN: '計画中', VOTING: '候補' };
  const GENERATION_LABEL = { v2: 'V2', v3: 'V3', v4: 'V4', urban: 'Urban' };
  const PLUG_LABEL = { tpc: 'TPC', nacs: 'NACS' };
  const ICON_MIN_ZOOM = 7;
  const NETWORK_COLOR = { tesla: '#e31937', flash: '#0969da' };
  const BOLT_PATH = 'M13.5 2 4 14h7l-1.5 8L19 10h-7z';
  const AERIAL_ZOOM = 18;
  const AERIAL_BOX = { w: 272, h: 150 };

  function drawChargerIcon(network, tier, planned) {
    // Fixed-size round badge; higher tiers stack overlapping bolts inside it instead of widening it.
    const ratio = 2, pad = 2;
    const size = tier ? 20 : 12;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = (size + pad * 2) * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const color = NETWORK_COLOR[network];
    const bg = planned ? '#ffffff' : color;
    const fg = planned ? color : '#ffffff';
    const c = pad + size / 2;
    ctx.beginPath();
    ctx.arc(c, c, size / 2, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 2;
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = fg;
    ctx.stroke();
    if (!tier) return canvas;
    const bolt = new Path2D(BOLT_PATH);
    // BOLT_PATH spans x 4..19, y 2..22 in a 24-unit box.
    const scale = [0, 0.62, 0.56, 0.52][tier], step = [0, 0, 3.6, 3.2][tier];
    const w = 15 * scale, h = 20 * scale;
    const x0 = c - (w + step * (tier - 1)) / 2 - 4 * scale;
    const y0 = c - h / 2 - 2 * scale;
    ctx.fillStyle = fg;
    ctx.strokeStyle = bg;
    ctx.lineJoin = 'round';
    for (let i = 0; i < tier; i++) {
      ctx.save();
      ctx.translate(x0 + i * step, y0);
      ctx.scale(scale, scale);
      if (i) {
        ctx.lineWidth = 2.6 / scale;
        ctx.stroke(bolt);
      }
      ctx.fill(bolt);
      ctx.restore();
    }
    return canvas;
  }
  function registerChargerIcons() {
    for (const network of ['tesla', 'flash']) {
      for (const tier of [0, 1, 2, 3]) {
        for (const group of ['open', 'planned']) {
          const canvas = drawChargerIcon(network, tier, group === 'planned');
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
          map.addImage(`charger-${network}-${tier}-${group}`, data, { pixelRatio: 2 });
        }
      }
    }
  }
  const POI_GLYPH = {
    convenience: 'M4 4h16l1.6 5.2a2.6 2.6 0 0 1-5.2.3 2.6 2.6 0 0 1-4.8 0 2.6 2.6 0 0 1-4.8 0 2.6 2.6 0 0 1-5.2-.3zM5 13.2h14V20H5z',
    mall: 'M5.5 8h13l1 12.5h-15zM8.7 8V6.6a3.3 3.3 0 0 1 6.6 0V8h-1.8V6.6a1.5 1.5 0 0 0-3 0V8z',
  };
  const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  // mark: crop box [x, y, w, h] (fractions) of the text-free symbol inside the logo; null → brand-colour tile.
  const BRAND_STYLE = {
    'セブン-イレブン': { color: '#e8730c', letter: '7', short: 'セブン', logo: 'seven-eleven', mark: [0, 0, 1, 1] },
    'ファミリーマート': { color: '#0a8f45', letter: 'F', short: 'ファミマ', logo: 'familymart', mark: [0, 0, 0.176, 1] },
    'ローソン': { color: '#1f5fb8', letter: 'L', short: 'ローソン', logo: 'lawson', mark: null },
    'ミニストップ': { color: '#1e3a8a', letter: 'M', short: 'ミニストップ', logo: 'ministop', mark: [0, 0, 1, 1] },
    'デイリーヤマザキ': { color: '#d7261e', letter: 'D', short: 'デイリー', logo: 'daily-yamazaki', mark: null },
    'セイコーマート': { color: '#f08300', letter: 'S', short: 'セイコーマート', logo: 'seicomart', mark: null },
    NewDays: { color: '#79a91b', letter: 'N', short: 'NewDays', logo: 'newdays', mark: null },
    'ポプラ': { color: '#be123c', letter: 'P', short: 'ポプラ', logo: 'poplar', mark: [0, 0, 0.233, 0.72] },
  };
  const brandLogoUrl = (s) => `img/brands/${s.logo}.png`;
  const poiItems = [];
  let poiState = 'idle';

  function drawPoiIcon(type, color, letter) {
    const ratio = 2, size = 17;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = (size + 4) * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.beginPath();
    ctx.roundRect(2, 2, size, size, 4);
    ctx.shadowColor = 'rgba(0,0,0,.3)';
    ctx.shadowBlur = 2;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    if (letter || !POI_GLYPH[type]) {
      ctx.font = letter
        ? 'bold 11px Inter, "Segoe UI", Arial, sans-serif'
        : 'bold 10.5px "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter || '駅', 2 + size / 2, 2 + size / 2 + 0.5);
    } else {
      ctx.save();
      ctx.translate(4, 4);
      ctx.scale(13 / 24, 13 / 24);
      ctx.fill(new Path2D(POI_GLYPH[type]), 'evenodd');
      ctx.restore();
    }
    return canvas;
  }
  const canvasData = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

  // Text-free brand marks: the symbol part of the logo (original colours, uncropped aspect) on a white square badge.
  function drawMarkBadge(img, [fx, fy, fw, fh]) {
    const ratio = 2, size = 18, box = 14;
    const sx = img.naturalWidth * fx, sy = img.naturalHeight * fy;
    const sw = img.naturalWidth * fw, sh = img.naturalHeight * fh;
    const aspect = sw / sh;
    const w = aspect >= 1 ? box : box * aspect, h = aspect >= 1 ? box / aspect : box;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = (size + 4) * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.beginPath();
    ctx.roundRect(2, 2, size, size, 4);
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 2;
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(15,23,42,.18)';
    ctx.stroke();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 2 + (size - w) / 2, 2 + (size - h) / 2, w, h);
    return canvas;
  }
  function brandIcon(s) {
    return s.mark && s.img ? drawMarkBadge(s.img, s.mark) : drawPoiIcon('convenience', s.color);
  }
  async function loadBrandLogos() {
    await Promise.all(Object.values(BRAND_STYLE).map(async (s) => {
      try {
        const img = new Image();
        img.src = brandLogoUrl(s);
        await img.decode();
        s.img = img;
      } catch {
        s.img = null;
      }
    }));
  }

  async function loadPoi() {
    poiState = 'loading';
    try {
      const [d] = await Promise.all([fetch('data/poi.json', { cache: 'no-cache' }).then((r) => r.json()), loadBrandLogos()]);
      const features = [];
      const add = (t, lon, lat, n, brand) => {
        const i = poiItems.push({ t, n, coords: [lon, lat], brand }) - 1;
        const style = brand && BRAND_STYLE[brand];
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { t, n, i, k: style ? brand : '' } });
      };
      for (const [lon, lat, b] of d.convenience) add('convenience', lon, lat, b >= 0 ? d.brands[b] : 'コンビニ', b >= 0 ? d.brands[b] : null);
      for (const type of ['michinoeki', 'mall']) {
        for (const [lon, lat, name] of d[type]) add(type, lon, lat, name, null);
      }
      map.addSource('poi', { type: 'geojson', data: { type: 'FeatureCollection', features }, attribution: OSM_ATTR });
      for (const [brand, s] of Object.entries(BRAND_STYLE)) {
        map.addImage(`poi-convenience-${brand}`, canvasData(brandIcon(s)), { pixelRatio: 2 });
      }
      const brandMatch = (fallback, pick) => ['match', ['get', 'k'], ...Object.entries(BRAND_STYLE).flatMap(([brand, s]) => [brand, pick(brand, s)]), fallback];
      for (const t of POI_TYPES) {
        map.addImage(`poi-${t.type}`, canvasData(drawPoiIcon(t.type, t.color)), { pixelRatio: 2 });
        const dense = t.type === 'convenience';
        map.addLayer({
          id: `poi-${t.type}-dot`, type: 'circle', source: 'poi', minzoom: t.minzoom, maxzoom: t.iconzoom,
          filter: ['==', ['get', 't'], t.type],
          layout: { visibility: 'none' },
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], t.minzoom, dense ? 1.8 : 2.2, t.iconzoom, dense ? 3 : 3.6],
            'circle-color': dense ? brandMatch(t.color, (_, s) => s.color) : t.color,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 0.8,
          },
        }, 'road-service-areas');
        map.addLayer({
          id: `poi-${t.type}`, type: 'symbol', source: 'poi', minzoom: t.iconzoom,
          filter: ['==', ['get', 't'], t.type],
          layout: {
            visibility: 'none',
            'icon-image': dense ? brandMatch('poi-convenience', (brand) => `poi-convenience-${brand}`) : `poi-${t.type}`,
            'icon-size': ['interpolate', ['linear'], ['zoom'], t.iconzoom, 0.8, 13, 1],
            'icon-allow-overlap': !dense,
            'icon-padding': 1,
          },
        }, 'road-service-areas');
        for (const id of [`poi-${t.type}-dot`, `poi-${t.type}`]) {
          map.on('mousemove', id, (e) => {
            map.getCanvas().style.cursor = 'pointer';
            showTip(e.originalEvent, `<b>${esc(e.features[0].properties.n)}</b><br>${t.label}`);
          });
          map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; $('#tooltip').hidden = true; });
          map.on('click', id, (e) => {
            const item = poiItems[e.features[0].properties.i];
            $('#tooltip').hidden = true;
            if (item) openPlacePopup(poiSelId(item), item.coords, poiPopupHtml(e.features[0].properties.i));
          });
        }
      }
      map.addLayer({
        id: 'poi-labels', type: 'symbol', source: 'poi', minzoom: 10,
        filter: ['in', ['get', 't'], ['literal', []]],
        layout: {
          'text-field': ['get', 'n'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10.5,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
          'text-padding': 4,
        },
        paint: { 'text-color': '#3f3f46', 'text-halo-color': 'rgba(255,255,255,.95)', 'text-halo-width': 1.8 },
      }, 'road-service-areas');
      poiState = 'ready';
      renderPoi();
      syncBrandKey();
    } catch (err) {
      poiState = 'idle';
      console.error(err);
    }
  }

  function renderPoi() {
    const enabled = POI_TYPES.filter((t) => state[t.key]);
    if (poiState !== 'ready') {
      if (enabled.length && poiState === 'idle') poiPromise = loadPoi();
      return;
    }
    for (const t of POI_TYPES) {
      for (const id of [`poi-${t.type}-dot`, `poi-${t.type}`]) map.setLayoutProperty(id, 'visibility', state[t.key] ? 'visible' : 'none');
    }
    map.setFilter('poi-labels', ['in', ['get', 't'], ['literal', enabled.map((t) => t.type).filter((type) => type !== 'convenience')]]);
  }

  // ---------- 賢い料金 / EV路外充電 (leave the expressway at no extra toll) ----------
  const TOLL_KIND = {
    kashikoi: { color: '#16a34a', label: '賢い料金（道の駅一時退出）', short: '賢い料金', target: 'ETC2.0搭載車（全車種）' },
    ev: { color: '#f59e0b', label: 'EV路外充電サービス（社会実験）', short: 'EV路外充電', target: 'ETC2.0搭載のEV（セットアップ証明書の燃料種別が「電気」）' },
  };
  const ARROW_PATH = 'M12 5a7 7 0 1 1-6.7 5H3l3.5-4.2L10 10H7.4A5 5 0 1 0 12 7z';
  let tollState = 'idle', tollData = null;

  function drawTollIcon(kind) {
    const ratio = 2, base = 17, r = 6;
    const canvas = document.createElement('canvas');
    canvas.width = (base + r + 6) * ratio;
    canvas.height = (base + r + 4) * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.drawImage(drawPoiIcon('michinoeki', '#9a5b13'), 0, r - 1, base + 4, base + 4);
    const cx = base + 1, cy = r + 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = TOLL_KIND[kind].color;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.save();
    ctx.translate(cx - 4.4, cy - 4.4);
    ctx.scale(8.8 / 24, 8.8 / 24);
    ctx.fillStyle = '#ffffff';
    ctx.fill(new Path2D(kind === 'ev' ? BOLT_PATH : ARROW_PATH));
    ctx.restore();
    return canvas;
  }

  async function loadSmartToll() {
    tollState = 'loading';
    try {
      tollData = await fetch('data/smart_toll.json', { cache: 'no-cache' }).then((r) => r.json());
      const features = [];
      tollData.pairs.forEach((p, i) => {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [p.ic_coords, p.station_coords] }, properties: { kind: p.kind, i } });
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.ic_coords }, properties: { kind: p.kind, i, role: 'ic', n: p.ic } });
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.station_coords }, properties: { kind: p.kind, i, role: 'station', n: `道の駅 ${p.station}` } });
      });
      map.addSource('smart-toll', { type: 'geojson', data: { type: 'FeatureCollection', features } });
      for (const kind of Object.keys(TOLL_KIND)) map.addImage(`toll-${kind}`, canvasData(drawTollIcon(kind)), { pixelRatio: 2 });
      const colorByKind = ['match', ['get', 'kind'], 'ev', TOLL_KIND.ev.color, TOLL_KIND.kashikoi.color];
      map.addLayer({
        id: 'toll-line-kashikoi', type: 'line', source: 'smart-toll', minzoom: 8,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'kashikoi']],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': TOLL_KIND.kashikoi.color, 'line-width': 2.2, 'line-dasharray': [1.2, 1.6] },
      }, 'sc-points');
      map.addLayer({
        id: 'toll-line-ev', type: 'line', source: 'smart-toll', minzoom: 8,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'ev']],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': TOLL_KIND.ev.color, 'line-width': 3 },
      }, 'sc-points');
      map.addLayer({
        id: 'toll-ic', type: 'circle', source: 'smart-toll', minzoom: 8,
        filter: ['==', ['get', 'role'], 'ic'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 12, 9],
          'circle-color': 'rgba(255,255,255,0)',
          'circle-stroke-color': colorByKind,
          'circle-stroke-width': 2.5,
        },
      }, 'sc-points');
      map.addLayer({
        id: 'toll-station', type: 'symbol', source: 'smart-toll',
        filter: ['==', ['get', 'role'], 'station'],
        layout: {
          'icon-image': ['concat', 'toll-', ['get', 'kind']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 9, 1.05, 12, 1.3],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['step', ['zoom'], '', 9, ['get', 'n']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10.5,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: { 'text-color': '#3f3f46', 'text-halo-color': 'rgba(255,255,255,.95)', 'text-halo-width': 1.8 },
      }, 'sc-points');
      for (const id of ['toll-station', 'toll-ic']) {
        map.on('mousemove', id, (e) => {
          const f = e.features[0].properties, p = tollData.pairs[f.i];
          map.getCanvas().style.cursor = 'pointer';
          showTip(e.originalEvent, `<b>${esc(f.n)}</b><br>${TOLL_KIND[p.kind].short}：${esc(p.ic)} ⇄ 道の駅 ${esc(p.station)}`);
        });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; $('#tooltip').hidden = true; });
        map.on('click', id, (e) => {
          const i = e.features[0].properties.i;
          $('#tooltip').hidden = true;
          openPlacePopup(`toll:${tollData.pairs[i].station}`, tollData.pairs[i].station_coords, tollPopupHtml(i));
        });
      }
      tollState = 'ready';
      renderSmartToll();
    } catch (err) {
      tollState = 'idle';
      console.error(err);
    }
  }

  function renderSmartToll() {
    if (tollState !== 'ready') {
      if (state.smartToll && tollState === 'idle') tollPromise = loadSmartToll();
      return;
    }
    for (const id of ['toll-line-kashikoi', 'toll-line-ev', 'toll-ic', 'toll-station']) {
      map.setLayoutProperty(id, 'visibility', state.smartToll ? 'visible' : 'none');
    }
  }

  function nearbyChargers(coords, km) {
    return [...chargerById.values()]
      .map((c) => ({ c, d: distanceKm(coords, c.coords) }))
      .filter((x) => x.d <= km)
      .sort((a, b) => a.d - b.d);
  }
  function distanceKm(a, b) {
    const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.54);
  }

  function tollPopupHtml(i) {
    const p = tollData.pairs[i], k = TOLL_KIND[p.kind];
    const rule = p.kind === 'ev'
      ? `${esc(p.ic)}で降りてこの道の駅の${esc(p.charger)}で充電し、<b>60分以内</b>に同じICから同じ方向へ戻れば、高速道路を降りなかった場合と同じ料金です。`
      : `${esc(p.ic)}で降りてこの道の駅に立ち寄り（出入口のETC2.0アンテナを通過）、<b>2時間以内</b>に同じICから同じ方向へ戻れば、高速道路を降りなかった場合と同じ料金です。`;
    const near = nearbyChargers(p.station_coords, 2);
    const nearHtml = near.length
      ? near.map(({ c, d }) => `${c.props.network === 'flash' ? 'FLASH' : 'テスラ SC'} ${esc(c.props.name)}（${d.toFixed(1)}km）`).join('<br>')
      : 'なし（テスラ SC・FLASH）';
    return `<div class="charger-popup toll-popup">
      <h3>道の駅 ${esc(p.station)}</h3>
      <div class="toll-badge ${p.kind}"><img src="${drawTollIcon(p.kind).toDataURL()}" alt="">${k.label}</div>
      <p class="toll-rule">${rule}</p>
      <table>
        <tr><td>対象</td><td>${k.target}</td></tr>
        <tr><td>乗り降りするIC</td><td>${esc(p.ic)}（道の駅まで約${p.distance_km}km）</td></tr>
        <tr><td>2km以内の充電器</td><td>${nearHtml}</td></tr>
      </table>
      ${aerialHtml(`toll:${i}`, p.station_coords, { color: k.color })}
      ${linksHtml(placeLinks(p.station_coords))}
      ${shareButtonHtml()}
      <div class="muted poi-source">出典：<a href="${esc(p.source)}" target="_blank" rel="noopener">${p.kind === 'ev' ? 'NEXCO中日本' : 'ETC総合情報ポータル'}</a>（社会実験のため変更・終了の可能性あり）</div>
    </div>`;
  }

  function syncBrandKey() {
    const key = $('#brand-key');
    key.hidden = !state.poiConvenience;
    if (key.childElementCount || poiState !== 'ready') return;
    key.innerHTML = Object.values(BRAND_STYLE).slice(0, 6)
      .map((s) => `<span><img src="${brandIcon(s).toDataURL()}" alt="">${esc(s.short)}</span>`).join('') +
      `<span><img src="${drawPoiIcon('convenience', '#475569').toDataURL()}" alt="">その他</span>`;
  }

  function poiPopupHtml(index) {
    const item = poiItems[index];
    const type = POI_TYPES.find((t) => t.type === item.t);
    const style = item.brand && BRAND_STYLE[item.brand];
    return `<div class="charger-popup poi-popup">
      ${style ? `<img class="poi-logo" src="${brandLogoUrl(style)}" alt="">` : ''}
      <h3>${esc(item.n)}</h3>
      <div class="muted">${type.label}</div>
      ${aerialHtml(`poi:${index}`, item.coords, { color: style?.color || type.color })}
      ${linksHtml(placeLinks(item.coords))}
      ${shareButtonHtml()}
      <div class="muted poi-source">施設情報：${OSM_ATTR}</div>
    </div>`;
  }

  function viewerTarget(id) {
    if (String(id).startsWith('toll:')) {
      const p = tollData?.pairs[Number(String(id).slice(5))];
      if (!p) return null;
      const k = TOLL_KIND[p.kind];
      return {
        title: `道の駅 ${p.station}`, sub: `${k.label} · ${p.ic}`, coords: p.station_coords, color: k.color,
        note: '', links: placeLinks(p.station_coords),
      };
    }
    if (String(id).startsWith('poi:')) {
      const item = poiItems[Number(String(id).slice(4))];
      if (!item) return null;
      const type = POI_TYPES.find((t) => t.type === item.t);
      const style = item.brand && BRAND_STYLE[item.brand];
      return {
        title: item.n, sub: type.label, coords: item.coords, color: style?.color || type.color,
        note: '位置はOpenStreetMapの登録位置です', links: placeLinks(item.coords),
      };
    }
    const c = chargerById.get(String(id));
    if (!c) return null;
    const p = c.props, flash = p.network === 'flash';
    return {
      title: p.name || '', sub: [flash ? 'FLASH' : 'テスラ SC', p.facility].filter(Boolean).join(' · '),
      coords: c.coords, color: NETWORK_COLOR[flash ? 'flash' : 'tesla'],
      note: flash ? '位置はFLASH公式の住所から推定しています' : '', links: chargerLinks(p, c.coords),
    };
  }

  function syncPowerKey() {
    const network = state.tesla ? 'tesla' : 'flash';
    if ($('#power-key').dataset.network === network) return;
    $('#power-key').dataset.network = network;
    $('#power-key').innerHTML = [[3, '200kW以上'], [2, '100〜199kW'], [1, '100kW未満']]
      .map(([tier, label]) => `<span><img src="${drawChargerIcon(network, tier, false).toDataURL()}" alt="" height="14">${label}</span>`).join('');
  }

  let viewerMap = null, viewerMarker = null, viewerReturnFocus = null;
  function openAerialViewer(id) {
    const target = viewerTarget(id);
    if (!target) return;
    $('#viewer-title').textContent = target.title;
    $('#viewer-sub').textContent = target.sub;
    $('#viewer-note').textContent = target.note;
    $('#viewer-links').innerHTML = linksHtml(target.links);
    const c = { coords: target.coords };
    viewerReturnFocus = document.activeElement;
    $('#aerial-viewer').hidden = false;
    if (!viewerMap) {
      viewerMap = new maplibregl.Map({
        container: 'viewer-map',
        style: {
          version: 8,
          sources: { photo: { type: 'raster', tiles: [BASEMAPS.photo.tiles], tileSize: 256, maxzoom: 18, attribution: GSI_ATTR } },
          layers: [{ id: 'photo', type: 'raster', source: 'photo' }],
        },
        center: c.coords, zoom: 18, minZoom: 10, maxZoom: 20,
        dragRotate: false, pitchWithRotate: false,
      });
      viewerMap.touchZoomRotate.disableRotation();
      viewerMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      viewerMap.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    } else {
      viewerMap.resize();
      viewerMap.jumpTo({ center: c.coords, zoom: 18 });
    }
    viewerMarker?.remove();
    viewerMarker = new maplibregl.Marker({ color: target.color }).setLngLat(c.coords).addTo(viewerMap);
    $('#viewer-close').focus();
  }
  function closeAerialViewer() {
    $('#aerial-viewer').hidden = true;
    viewerReturnFocus?.focus?.();
  }

  function placeLinks(coords) {
    const [lon, lat] = coords;
    return {
      street: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`,
      maps: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
    };
  }
  function chargerLinks(p, coords) {
    const links = placeLinks(coords);
    if (p.network === 'flash' && /^https:\/\//.test(p.url || '')) links.maps = p.url;
    return links;
  }
  function linksHtml(links) {
    return `<div class="popup-links">
        <a href="${esc(links.street)}" target="_blank" rel="noopener">ストリートビュー ↗</a>
        <a href="${esc(links.maps)}" target="_blank" rel="noopener">Googleマップ ↗</a>
      </div>`;
  }

  function aerialHtml(id, coords, { note = '', color } = {}) {
    const [lon, lat] = coords;
    const n = 2 ** AERIAL_ZOOM;
    const fx = ((lon + 180) / 360) * n;
    const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const left = AERIAL_BOX.w / 2 - (fx - tx + 1) * 256;
    const top = AERIAL_BOX.h / 2 - (fy - ty + 1) * 256;
    const tiles = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        tiles.push(`<img src="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${AERIAL_ZOOM}/${tx + dx}/${ty + dy}.jpg" alt="" loading="lazy" style="left:${(dx + 1) * 256}px;top:${(dy + 1) * 256}px" onerror="this.style.visibility='hidden'">`);
      }
    }
    return `<figure class="aerial" data-aerial-id="${esc(id)}" role="button" tabindex="0" aria-label="航空写真を大きく表示">
        <div class="aerial-tiles" style="left:${left}px;top:${top}px">${tiles.join('')}</div>
        <span class="aerial-pin"${color ? ` style="background:${esc(color)}"` : ''}></span>
        <span class="aerial-expand" aria-hidden="true">⤢ 拡大</span>
        <figcaption>${note ? `${esc(note)} · ` : ''}航空写真：国土地理院</figcaption>
      </figure>`;
  }

  function powerTier(kw) {
    if (!kw) return 0;
    return kw >= 200 ? 3 : kw >= 100 ? 2 : 1;
  }
  function bolts(tier) {
    return `<span class="bolts tier-${tier}" title="${['出力不明', '100kW未満', '100〜199kW', '200kW以上'][tier]}">${
      [1, 2, 3].map((i) => `<i class="${i <= tier ? 'on' : ''}">${BOLT_SVG}</i>`).join('')}</span>`;
  }
  function countList(obj, labels) {
    return Object.entries(obj || {}).map(([k, v]) => `${esc(labels[k] || k.toUpperCase())} ×${v}`).join(' · ');
  }
  function chargerPopupHtml(p, coords) {
    const flash = p.network === 'flash';
    const kw = Number(p.kw) || null;
    const tier = powerTier(kw);
    const status = STATUS_LABEL[p.status] || p.status;
    const rows = [['状態', esc(status)], ['ストール数', p.stalls_est ? `${p.stalls}（推定）` : `${p.stalls}`]];
    if (flash) {
      if (p.output && /基/.test(p.output)) rows.push(['出力構成', esc(p.output)]);
      const connectors = (p.connectors || []).join(' / ');
      if (connectors) rows.push(['コネクター', `${esc(connectors)}${(p.connectors || []).length > 1 ? '<br><span class="muted">同じ充電器で同時利用不可</span>' : ''}`]);
    } else {
      if (Object.keys(p.generations || {}).length) rows.push(['充電器世代', countList(p.generations, GENERATION_LABEL)]);
      if (Object.keys(p.plugs || {}).length) rows.push(['コネクター', countList(p.plugs, PLUG_LABEL)]);
      const amenities = [];
      if (p.amenities?.accessible) amenities.push(`車いす対応 ${p.amenities.accessible}台`);
      if (p.amenities?.trailer) amenities.push(`トレーラー可 ${p.amenities.trailer}台`);
      if (amenities.length) rows.push(['設備', amenities.join(' · ')]);
      if (p.location_note) rows.push(['設置場所', esc(p.location_note)]);
    }
    if (p.opened) rows.push(['開設日', esc(p.opened)]);
    if (p.hours) rows.push(['営業時間', esc(p.hours)]);
    const sub = [flash ? 'FLASH' : 'テスラ SC', p.facility].filter(Boolean).map(esc).join(' · ');
    return `<div class="charger-popup ${flash ? 'flash' : 'tesla'}">
      <h3>${esc(p.name)}</h3>
      <div class="muted">${sub}</div>
      ${aerialHtml(p.id, coords, { note: flash ? '位置は住所から推定' : '', color: NETWORK_COLOR[flash ? 'flash' : 'tesla'] })}
      ${linksHtml(chargerLinks(p, coords))}
      ${shareButtonHtml()}
      <div class="spec-badges">${bolts(tier)}<span class="kw">${kw ? `最大 ${kw} kW` : '出力不明'}</span></div>
      <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      ${state.mode === 'C' && window.HazardOverlay ? window.HazardOverlay.popupHtml(p.id) : ''}
    </div>`;
  }

  function legend(title, rows) {
    $('#legend').innerHTML = `<div class="title">${title}</div>` +
      rows.map((r) => `<div class="row"><span class="sw" style="background:${r.css}"></span>${r.label}</div>`).join('');
  }
  function rgb(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
  function fmtPop(p) { return p >= 1e8 ? `${(p / 1e8).toFixed(2)}億人` : `${nf.format(Math.round(p / 1e4))}万人`; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
