(() => {
  'use strict';

  const C = { red: '#c8553d', sage: '#7f9f7a', sky: '#6f9fb8', mustard: '#dba53f', rose: '#cf8a86', plum: '#8e6d8f', idle: '#e3d6bd' };
  const IDLE_FILL = '#e9dfc7';
  const JAPAN = [[127.6, 26.0], [146.0, 45.6]];
  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('ja-JP');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mobile = () => matchMedia('(max-width: 900px)').matches;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let V, SC, map, prefGeo, activeFill = 'a', blinkTimer = null, currentScene = null, prefCode = null;
  const bboxOf = {};

  // ---------- small view helpers ----------
  const n = (v, unit = '人') => `<span class="num">${v}</span>${unit}`;
  const place = (s) => `<span class="place">${esc(s)}</span>`;
  const tags = (a) => `<ul class="tags">${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const share = (x) => (x >= 10 ? String(Math.round(x)) : x >= 0.05 ? x.toFixed(1).replace(/\.0$/, '') : '0');
  const man = (p) => nf.format(Math.round(p / 1000) / 10);
  function grid(icon, groups, caption, label) {
    let html = '', i = 0;
    for (const g of groups) {
      for (let k = 0; k < g.count && i < 100; k++, i++) html += `<svg data-kind="${g.cls || 'on'}" style="--c:${g.color}" viewBox="0 0 24 30"><use href="#i-${icon}"/></svg>`;
    }
    for (; i < 100; i++) html += `<svg viewBox="0 0 24 30"><use href="#i-${icon}"/></svg>`;
    return `<div class="grid-box"><p class="grid-cap">${caption}</p><div class="grid" role="img" aria-label="${esc(label)}">${html}</div></div>`;
  }
  const aside = (num, txt, of = '100人のうち') => `<div class="aside"><div class="of">${of}</div><div class="big">${num}</div><div class="txt">${txt}</div></div>`;
  const page = (no, color, scene, body, cls = '') => `<section class="page ${cls}" data-no="${no}" data-scene="${scene}" style="--c:${color}">${body}</section>`;

  // ---------- national story ----------
  function nationalPages() {
    const v = V;
    const reg = Object.fromEntries(v.regions.map((r) => [r.name, r]));
    const scarce = v.regions.filter((r) => r.ratio < 0.8).sort((a, b) => a.ratio - b.ratio).slice(0, 3);
    const [b10, b30, b50, bFar] = v.bands;
    const out = [];
    let no = 1;
    out.push(page(no++, C.red, 'metros', `
      <p class="verse">もし日本が100人の村だったら、</p>
      <p class="verse">${n(v.metros.people)}は、東京・神奈川・愛知・大阪に住んでいます。</p>
      <p class="verse">村に充電器が100基あるとすると、<br>そのうち ${n(v.metros.chargers, '基')} が、この人たちのそばにあります。</p>
      <div class="viz">
        ${grid('person', [{ count: v.metros.people, color: C.red }], '村の人たち', `100人中${v.metros.people}人`)}
        ${grid('charger', [{ count: v.metros.chargers, color: C.red }], '村の充電器', `100基中${v.metros.chargers}基`)}
      </div>`));
    const maxv = Math.max(...v.regions.flatMap((r) => [r.people, r.chargers]));
    out.push(page(no++, C.sky, 'regions', `
      <p class="verse">${n(reg['関東'].people)}は関東に住んでいて、充電器を ${n(reg['関東'].chargers, '基')} 使えます。</p>
      ${scarce.map((r) => `<p class="verse" style="--c:${C.plum}">${n(r.people)}は${place(r.name)}に住んでいますが、<br>充電器は ${n(r.chargers, '基')} しかありません。</p>`).join('')}
      <div class="regions">${v.regions.map((r) => `<div class="reg"><span>${esc(r.name)}</span><div class="bars">
        <div class="bar" style="--k:${C.sky};--w:${(r.people / maxv) * 100}%"></div>
        <div class="bar" style="--k:${r.ratio < 0.8 ? C.plum : C.mustard};--w:${(r.chargers / maxv) * 100}%"></div></div></div>`).join('')}</div>
      <div class="reg-legend"><i style="--k:${C.sky}"></i>住んでいる人<i style="--k:${C.mustard}"></i>充電器<i style="--k:${C.plum}"></i>人のわりに少ない地方</div>`));
    const near = [{ count: b10.people, color: C.sage }, { count: b30.people, color: C.mustard }, { count: b50.people, color: C.rose }, { count: bFar.people, color: C.plum }];
    out.push(page(no++, C.sage, 'distance', `
      <p class="verse">${n(b10.people)}は、10km以内に充電器があります。</p>
      <p class="verse" style="--c:${C.mustard}">${n(b30.people)}は、少し遠くても30km以内に充電器があります。</p>
      <p class="verse" style="--c:${C.rose}">${n(b50.people)}は、30〜50km走らないと充電器にたどり着けません。</p>
      <p class="verse" style="--c:${C.plum}">${n(bFar.people)}は、50km以上走らないと充電器がありません。</p>
      <div class="viz">${grid('person', near, 'いちばん近い充電器までの距離', `10km以内${b10.people}人`)}${aside(b10.people + b30.people, '人は、30km以内に<br>充電器があります')}</div>
      <div class="legend"><span style="--k:${C.sage}">10km以内</span><span style="--k:${C.mustard}">10〜30km</span><span style="--k:${C.rose}">30〜50km</span><span style="--k:${C.plum}">50km以上</span></div>`));
    if (v.zero_prefs.names.length) {
      out.push(page(no++, C.plum, 'zero', `
        <p class="verse">${n(v.zero_prefs.people)}は、${v.zero_prefs.names.map(place).join('、')}に住んでいます。</p>
        <p class="verse">ここにはまだ、営業中の充電器が一つもありません。</p>
        <div class="viz">${grid('person', [{ count: v.zero_prefs.people, color: C.plum }], '村の人たち', `100人中${v.zero_prefs.people}人`)}${aside(v.zero_prefs.names.length, 'つの県に、<br>まだ充電器がありません', '47都道府県のうち')}</div>`));
    } else {
      out.push(page(no++, C.sage, 'zero', '<p class="verse">いまでは、すべての都道府県に充電器があります。</p>'));
    }
    const big = nf.format(v.isolated_cities.min_pop / 10000);
    if (v.isolated_cities.names.length) {
      out.push(page(no++, C.rose, 'isolated', `
        <p class="verse">${n(v.isolated_cities.people)}は、人口${big}万人以上の大きな街に住んでいます。</p>
        ${tags(v.isolated_cities.names)}
        <p class="verse">でも、30km以内に充電器はありません。</p>
        <div class="viz">${grid('person', [{ count: v.isolated_cities.people, color: C.rose }], '村の人たち', `100人中${v.isolated_cities.people}人`)}${aside(v.isolated_cities.names.length, 'つの大きな街が、<br>充電器から30km以上<br>はなれています', `人口${big}万人以上の街のうち`)}</div>`));
    }
    out.push(page(no++, C.mustard, 'low', `
      <p class="verse">${n(v.low_ratio.people)}は、「人口のわりに充電器が半分もない」地域に住んでいます。</p>
      ${v.low_ratio.examples.length ? `<p class="verse">${v.low_ratio.examples.map(place).join('、')}の人たちも、そのなかにいます。</p>` : ''}
      <div class="viz">${grid('person', [{ count: v.low_ratio.people, color: C.mustard }], '村の人たち', `100人中${v.low_ratio.people}人`)}${aside(v.low_ratio.people, '人のまわりでは、<br>充電器が人口のわりに<br>半分もありません')}</div>`));
    if (v.planned.planned_sites) {
      const gain = Math.max(0, v.planned.within30_all - v.planned.within30_now);
      const still = v.planned.still_isolated;
      out.push(page(no++, C.sage, 'planned', `
        <p class="verse">計画中や候補の充電器（${v.planned.planned_sites}か所）が、ぜんぶできたとしたら、</p>
        <p class="verse">30km以内に充電器がある人は、${v.planned.within30_now}人から ${n(v.planned.within30_all)} に増えます。</p>
        ${still.length ? `<p class="verse" style="--c:${C.rose}">それでも、まだ計画が届いていない街があります。</p>${tags(still)}` : ''}
        <div class="viz">${grid('person', [{ count: v.planned.within30_now, color: C.sage }, { count: gain, color: C.mustard, cls: 'new' }], '30km以内に充電器がある人（黄色は計画で増える人）', `いま${v.planned.within30_now}人`)}${aside(`+${gain}`, '人が、新しく<br>30km圏に入ります', '計画がすべてできると')}</div>`));
    }
    out.push(page(no++, C.red, 'perstall', `
      <div class="finale">
        <p class="verse">ほんとうの日本では、</p>
        <p class="verse">充電器（ストール）1基を、<br>およそ ${n(man(v.people_per_stall), '万人')} で分けあっています。</p>
        ${finaleArt()}
      </div>`));
    out.push(choosePage(no++, 'あなたの県では、どうでしょう？'));
    return out.join('');
  }

  function finaleArt() {
    return `<svg viewBox="0 0 120 80" aria-hidden="true">
      <g transform="translate(49 8)"><rect width="22" height="44" rx="5" fill="${C.red}"/><rect x="4" y="5" width="14" height="9" rx="2" fill="#fffaf0" opacity=".9"/><path d="M12 18l-5 9h4l-1.5 7 6-9.5h-4z" fill="#fffaf0"/></g>
      ${[[14, 60, C.sky], [30, 66, C.mustard], [90, 66, C.plum], [106, 60, C.sage], [60, 70, C.rose]].map(([x, y, c]) => `<g fill="${c}"><circle cx="${x}" cy="${y - 12}" r="4.5"/><path d="M${x - 7} ${y + 8}c0-9 3-14 7-14s7 5 7 14z"/></g>`).join('')}
    </svg>`;
  }

  function choosePage(no, lead) {
    const codes = Object.keys(V.prefs).sort().filter((c) => c !== prefCode);
    return page(no, C.red, 'choose', `
      <div class="choose">
        <p class="verse">${lead}</p>
        <p class="verse">地図の県をクリックするか、下から選んでください。<br>その県が100人の村だったら、の絵本がひらきます。</p>
        <div class="pref-chips">${codes.map((c) => `<button type="button" data-pref="${c}">${esc(V.prefs[c].name)}</button>`).join('')}</div>
        ${prefCode ? '<p class="verse" style="margin-top:16px"><a href="#" data-pref="">← 全国の絵本にもどる</a></p>' : ''}
      </div>`, 'choose-page');
  }

  // ---------- prefecture story ----------
  function prefPages(code) {
    const p = V.prefs[code];
    const out = [];
    let no = 1;
    const ps = Math.max(p.people_share >= 0.5 ? Math.round(p.people_share) : 1, 0);
    const cs = Math.round(p.charger_share);
    out.push(page(no++, C.red, 'pref-focus', `
      <p class="verse">まずは、日本を100人の村にしてみます。</p>
      <p class="verse">そのうち、${place(p.name)}に住んでいるのは ${n(share(p.people_share))}。</p>
      <p class="verse">日本の充電器100基のうち、${esc(p.name)}にあるのは ${n(share(p.charger_share), '基')} です。</p>
      <div class="viz">
        ${grid('person', [{ count: ps, color: C.red }], '日本の100人のうち', `${share(p.people_share)}人`)}
        ${grid('charger', [{ count: cs, color: C.red }], '日本の充電器100基のうち', `${share(p.charger_share)}基`)}
      </div>`));
    if (p.stalls) {
      out.push(page(no++, C.sky, 'pref-sc', `
        <p class="verse">では、${p.name}を100人の村にしてみましょう。</p>
        <p class="verse">村の充電器（ストール）は ${n(p.stalls, '基')}、${p.sites}か所にあります。</p>
        <p class="verse">1基を、およそ ${n(man(p.people_per_stall), '万人')} で分けあっています。<br>（日本ぜんたいでは約${man(V.people_per_stall)}万人）</p>
        <p class="verse">人口あたりの充電器の多さは、47都道府県のなかで ${n(p.rank, '番目')} です。</p>`));
    } else {
      out.push(page(no++, C.plum, 'pref-sc', `
        <p class="verse">では、${p.name}を100人の村にしてみましょう。</p>
        <p class="verse">この村には、まだ営業中の充電器が一つもありません。</p>
        <p class="verse">住まいからいちばん近い充電器まで、平均 ${n(p.mean_km, 'km')}。</p>`));
    }
    const [b10, b30, b50, bFar] = p.bands;
    const near = [{ count: b10, color: C.sage }, { count: b30, color: C.mustard }, { count: b50, color: C.rose }, { count: bFar, color: C.plum }];
    out.push(page(no++, C.sage, 'pref-distance', `
      ${b10 ? `<p class="verse">${n(b10)}は、10km以内に充電器があります。</p>` : ''}
      ${b30 ? `<p class="verse" style="--c:${C.mustard}">${n(b30)}は、30km以内に充電器があります。</p>` : ''}
      ${b50 ? `<p class="verse" style="--c:${C.rose}">${n(b50)}は、30〜50km走らないと充電器にたどり着けません。</p>` : ''}
      ${bFar ? `<p class="verse" style="--c:${C.plum}">${n(bFar)}は、50km以上走らないと充電器がありません。</p>` : ''}
      <div class="viz">${grid('person', near, 'いちばん近い充電器までの距離', `10km以内${b10}人`)}${aside(b10 + b30, '人は、30km以内に<br>充電器があります')}</div>
      <div class="legend"><span style="--k:${C.sage}">10km以内</span><span style="--k:${C.mustard}">10〜30km</span><span style="--k:${C.rose}">30〜50km</span><span style="--k:${C.plum}">50km以上</span></div>`));
    if (p.isolated.length) {
      out.push(page(no++, C.rose, 'pref-isolated', `
        <p class="verse">人口5万人以上の街のうち、</p>
        ${tags(p.isolated.map((c) => c.name))}
        <p class="verse">には、30km以内に充電器がありません。</p>`));
    } else {
      out.push(page(no++, C.sage, 'pref-isolated', '<p class="verse">人口5万人以上の街なら、どこに住んでいても30km以内に充電器があります。</p>'));
    }
    out.push(page(no++, C.mustard, 'pref-low', `
      <p class="verse">${n(p.low_ratio)}は、「人口のわりに充電器が半分もない」地域に住んでいます。</p>
      ${p.low_ratio > 0 && p.low_examples.length ? `<p class="verse">${p.low_examples.map(place).join('、')}の人たちも、そのなかにいます。</p>` : ''}
      <div class="viz">${grid('person', [{ count: p.low_ratio, color: C.mustard }], '村の人たち', `100人中${p.low_ratio}人`)}</div>`));
    const gain = Math.max(0, p.within30_all - p.within30_now);
    const still = p.isolated.filter((c) => c.still).map((c) => c.name);
    out.push(page(no++, C.sage, 'pref-planned', p.planned_sites || gain ? `
      <p class="verse">計画中や候補の充電器が、${p.name}に ${n(p.planned_sites, 'か所')} あります。</p>
      <p class="verse">近くの県の計画もふくめて、ぜんぶできたとしたら、<br>30km以内に充電器がある人は ${p.within30_now}人から ${n(p.within30_all)} に。</p>
      ${still.length && p.isolated.length ? `<p class="verse" style="--c:${C.rose}">それでも、まだ計画が届いていない街があります。</p>${tags(still)}` : ''}
      <div class="viz">${grid('person', [{ count: p.within30_now, color: C.sage }, { count: gain, color: C.mustard, cls: 'new' }], '30km以内に充電器がある人（黄色は計画で増える人）', `いま${p.within30_now}人`)}</div>` : `
      <p class="verse">いま、${p.name}のまわりで計画中の充電器はありません。</p>
      <p class="verse">30km以内に充電器がある人は、${n(p.within30_now)}のままです。</p>`));
    out.push(choosePage(no++, 'ほかの県も、のぞいてみましょう。'));
    return out.join('');
  }

  // ---------- rendering the book ----------
  let pageObserver = null, showObserver = null;
  function renderBook() {
    const p = prefCode ? V.prefs[prefCode] : null;
    $('#title').textContent = p ? `もし${p.name}が100人の村だったら` : 'もし日本が100人の村だったら';
    document.title = `${$('#title').textContent}｜スーパーチャージャー編`;
    $('#pref-select').value = prefCode || '';
    $('#pages').innerHTML = p ? prefPages(prefCode) : nationalPages();
    $('#atlas-back').hidden = !p;
    const closing = $('#closing');
    closing.innerHTML = '充電器は、すこしずつ村にふえています。<br>この絵本は、新しい充電器ができるたびに書きかわります。';
    closing.hidden = false;
    $('#pages').querySelectorAll('[data-pref]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openPref(b.dataset.pref || null); }));
    observePages();
  }

  function reveal(sec) {
    if (sec.classList.contains('show')) return;
    sec.classList.add('show');
    sec.querySelectorAll('.grid svg[data-kind]').forEach((s, k) => {
      const on = () => s.classList.add(s.dataset.kind);
      if (reduced) return on();
      setTimeout(() => { on(); s.classList.add('pop'); setTimeout(() => s.classList.remove('pop'), 350); }, 250 + 12 * k);
    });
  }

  function observePages() {
    pageObserver?.disconnect(); showObserver?.disconnect();
    const pages = [...document.querySelectorAll('.page')];
    showObserver = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) reveal(e.target); }), { threshold: 0.2 });
    pageObserver = new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        pages.forEach((p) => p.classList.toggle('current', p === e.target));
        applyScene(e.target.dataset.scene);
      }
    }, { rootMargin: mobile() ? '-55% 0px -35% 0px' : '-45% 0px -45% 0px' });
    pages.forEach((p) => { showObserver.observe(p); pageObserver.observe(p); });
  }

  // ---------- map ----------
  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f3ead6' } }],
      },
      bounds: JAPAN, fitBoundsOptions: { padding: pad() },
      attributionControl: { compact: true, customAttribution: '境界：国土数値情報（国土交通省）を加工' },
      scrollZoom: false, dragPan: false, dragRotate: false, keyboard: false, doubleClickZoom: false, touchZoomRotate: false, boxZoom: false,
    });
    return new Promise((res) => map.on('load', res));
  }
  function pad() {
    return mobile() ? { top: 60, bottom: 40, left: 16, right: 16 } : { top: 110, bottom: 70, left: 40, right: 40 };
  }

  function setupLayers() {
    map.addSource('pref', { type: 'geojson', data: prefGeo, promoteId: 'code' });
    map.addLayer({ id: 'pref-shadow', type: 'fill', source: 'pref', paint: { 'fill-color': 'rgba(74,59,47,.16)', 'fill-translate': [3, 4] } });
    for (const id of ['a', 'b']) {
      map.addLayer({
        id: `pref-${id}`, type: 'fill', source: 'pref',
        paint: { 'fill-color': IDLE_FILL, 'fill-opacity': id === 'a' ? 0.92 : 0, 'fill-opacity-transition': { duration: reduced ? 0 : 650 } },
      });
    }
    map.addLayer({ id: 'pref-line', type: 'line', source: 'pref', paint: { 'line-color': '#fbf6ea', 'line-width': 1.3 } });
    map.addLayer({ id: 'pref-hover', type: 'line', source: 'pref', paint: { 'line-color': '#4a3b2f', 'line-width': 2 }, filter: ['==', ['get', 'code'], ''] });
    map.addLayer({ id: 'pref-focus', type: 'line', source: 'pref', paint: { 'line-color': C.red, 'line-width': 3 }, filter: ['==', ['get', 'code'], ''] });

    map.addSource('sc', { type: 'geojson', data: SC });
    map.addLayer({
      id: 'sc-open', type: 'circle', source: 'sc', filter: ['==', ['get', 'group'], 'open'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.6, 8, 5],
        'circle-color': C.red, 'circle-stroke-color': '#fffaf0', 'circle-stroke-width': 1.2,
        'circle-opacity': 0, 'circle-stroke-opacity': 0,
        'circle-opacity-transition': { duration: 500 }, 'circle-stroke-opacity-transition': { duration: 500 },
      },
    });
    map.addLayer({
      id: 'sc-plan', type: 'circle', source: 'sc', filter: ['==', ['get', 'group'], 'planned'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 8, 7],
        'circle-color': '#fffaf0', 'circle-stroke-color': C.mustard, 'circle-stroke-width': 2.5,
        'circle-opacity': 0, 'circle-stroke-opacity': 0,
        'circle-opacity-transition': { duration: 600 }, 'circle-stroke-opacity-transition': { duration: 600 },
      },
    });
    map.addSource('pins', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'pins', type: 'circle', source: 'pins',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 8, 8], 'circle-color': C.rose, 'circle-stroke-color': '#fffaf0', 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: 'pins-label', type: 'symbol', source: 'pins',
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': false },
      paint: { 'text-color': '#4a3b2f', 'text-halo-color': '#fbf6ea', 'text-halo-width': 2 },
    });

    const tip = $('#atlas-tip');
    for (const id of ['pref-a', 'pref-b']) {
      map.on('mousemove', id, (e) => {
        const code = e.features[0].properties.code;
        const p = V.prefs[code];
        if (!p) return;
        map.getCanvas().style.cursor = 'pointer';
        map.setFilter('pref-hover', ['==', ['get', 'code'], code]);
        tip.hidden = false;
        tip.style.left = `${e.point.x}px`; tip.style.top = `${e.point.y}px`;
        tip.innerHTML = `<b>${esc(p.name)}</b><br>${p.stalls ? `ストール ${p.stalls}基・約${man(p.people_per_stall)}万人で1基` : '営業中の充電器なし'}`;
      });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; map.setFilter('pref-hover', ['==', ['get', 'code'], '']); tip.hidden = true; });
      map.on('click', id, (e) => openPref(e.features[0].properties.code));
    }
  }

  function fillExpr(colors, fallback = IDLE_FILL) {
    const entries = Object.entries(colors);
    if (!entries.length) return fallback;
    return ['match', ['get', 'code'], ...entries.flat(), fallback];
  }
  function setFill(colors, fallback) {
    const next = activeFill === 'a' ? 'b' : 'a';
    map.setPaintProperty(`pref-${next}`, 'fill-color', fillExpr(colors, fallback));
    map.setPaintProperty(`pref-${next}`, 'fill-opacity', 0.92);
    map.setPaintProperty(`pref-${activeFill}`, 'fill-opacity', 0);
    activeFill = next;
  }
  function showSc(open, planned = false) {
    for (const [id, on] of [['sc-open', open], ['sc-plan', planned]]) {
      map.setPaintProperty(id, 'circle-opacity', on ? 1 : 0);
      map.setPaintProperty(id, 'circle-stroke-opacity', on ? 1 : 0);
    }
    clearInterval(blinkTimer);
    if (planned && !reduced) {
      let on = true;
      blinkTimer = setInterval(() => { on = !on; map.setPaintProperty('sc-plan', 'circle-stroke-opacity', on ? 1 : 0.25); }, 700);
    }
  }
  function setPins(list) {
    map.getSource('pins').setData({
      type: 'FeatureCollection',
      features: list.filter((c) => c.pt).map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c.pt }, properties: { name: c.name } })),
    });
  }
  const bins = (values, steps, colors, noneColor) => Object.fromEntries(Object.entries(values).map(([c, v]) => {
    if (v == null) return [c, noneColor];
    let i = steps.findIndex((s) => v < s);
    if (i < 0) i = steps.length;
    return [c, colors[i]];
  }));
  const legendHtml = (rows) => rows.map(([c, t, dot]) => `<span><i class="${dot ? 'dot' : ''}" style="background:${c}${dot ? `;border:2px solid ${dot}` : ''}"></i>${esc(t)}</span>`).join('');

  function camera(bounds) {
    map.fitBounds(bounds, { padding: pad(), duration: reduced ? 0 : 1100, essential: true });
  }

  function applyScene(scene) {
    if (!map || scene === currentScene) return;
    currentScene = scene;
    const M = V.map;
    let title = '', legend = [], colors = {}, fallback = IDLE_FILL;
    let sc = false, planned = false, pins = [], focus = '';
    const cam = prefCode ? prefBounds(prefCode) : JAPAN;
    $('#atlas-hint').classList.toggle('off', scene !== 'choose');
    switch (scene) {
      case 'metros':
        title = '東京・神奈川・愛知・大阪'; colors = Object.fromEntries(M.metros.map((c) => [c, C.red]));
        legend = [[C.red, '4都府県（人口の31%）']]; break;
      case 'regions': {
        const col = (r) => (r < 0.8 ? C.plum : r < 1.1 ? C.mustard : C.sky);
        for (const r of V.regions) for (const c of M.regions[r.name]) colors[c] = col(r.ratio);
        title = '地方ごとの「人口のわりの充電器の多さ」';
        legend = [[C.sky, '人口より多い'], [C.mustard, 'ほぼ人口どおり'], [C.plum, '人口のわりに少ない']]; break;
      }
      case 'distance':
        colors = bins(M.near10, [20, 40, 60, 80], ['#efe6d2', '#d3dfcd', '#a9c1a2', '#7f9f7a', '#4f7a4a']);
        title = '10km以内に充電器がある人（県の100人あたり）'; sc = true;
        legend = [['#4f7a4a', '80人以上'], ['#7f9f7a', '60〜79'], ['#a9c1a2', '40〜59'], ['#d3dfcd', '20〜39'], ['#efe6d2', '20人未満'], [C.red, '充電器', '#fffaf0']]; break;
      case 'zero':
        colors = Object.fromEntries(M.zero.map((c) => [c, C.plum])); sc = true;
        title = 'まだ充電器が一つもない県'; legend = [[C.plum, '充電器なし'], [C.red, '充電器', '#fffaf0']]; break;
      case 'isolated':
        pins = M.isolated; sc = true; fallback = '#ece3cf';
        title = '30km以内に充電器がない大きな街'; legend = [[C.rose, '人口20万人以上の街', '#fffaf0'], [C.red, '充電器', '#fffaf0']]; break;
      case 'low':
        colors = bins(M.low, [5, 20, 40, 60], ['#f3e7c7', '#ecd092', '#dba53f', '#c48a24', '#9a6a12']);
        title = '「人口のわりに充電器が半分もない」地域の人（県の100人あたり）';
        legend = [['#9a6a12', '60人以上'], ['#c48a24', '40〜59'], ['#dba53f', '20〜39'], ['#ecd092', '5〜19'], ['#f3e7c7', '5人未満']]; break;
      case 'planned':
        sc = true; planned = true; pins = M.isolated.filter((c) => c.still); fallback = '#ece3cf';
        title = '計画中・候補の充電器'; legend = [[C.red, 'いまある充電器', '#fffaf0'], ['#fffaf0', '計画中・候補', C.mustard], [C.rose, 'まだ計画が届かない街', '#fffaf0']]; break;
      case 'perstall':
        colors = bins(M.per_stall, [150000, 300000, 500000], ['#3f6f8c', '#6f9fb8', '#a7c4d4', '#d6e3e9'], C.plum);
        title = '充電器1基を何人で分けあっているか';
        legend = [['#3f6f8c', '15万人未満'], ['#6f9fb8', '15〜30万人'], ['#a7c4d4', '30〜50万人'], ['#d6e3e9', '50万人以上'], [C.plum, '充電器なし']]; break;
      case 'choose':
        for (const r of V.regions) for (const c of M.regions[r.name]) colors[c] = r.ratio < 0.8 ? '#e6d3de' : r.ratio < 1.1 ? '#f0dfb4' : '#d5e3ea';
        if (prefCode) colors[prefCode] = '#f0c9a0';
        title = prefCode ? 'ほかの県をえらぶ' : 'あなたの県をえらぶ'; legend = []; break;
      // ----- prefecture scenes -----
      case 'pref-focus':
        colors = { [prefCode]: C.red }; focus = prefCode; fallback = '#ece3cf';
        title = V.prefs[prefCode].name; legend = [[C.red, `日本の人口の${share(V.prefs[prefCode].people_share)}%`]]; break;
      case 'pref-sc':
        colors = { [prefCode]: '#f3dcb0' }; focus = prefCode; sc = true; fallback = '#ece3cf';
        title = `${V.prefs[prefCode].name}の充電器`; legend = [[C.red, 'いまある充電器', '#fffaf0']]; break;
      case 'pref-distance':
        colors = bins(M.near10, [20, 40, 60, 80], ['#efe6d2', '#d3dfcd', '#a9c1a2', '#7f9f7a', '#4f7a4a']); focus = prefCode; sc = true;
        title = '10km以内に充電器がある人（県の100人あたり）';
        legend = [['#4f7a4a', '80人以上'], ['#7f9f7a', '60〜79'], ['#a9c1a2', '40〜59'], ['#d3dfcd', '20〜39'], ['#efe6d2', '20人未満']]; break;
      case 'pref-isolated':
        colors = { [prefCode]: '#f3dcb0' }; focus = prefCode; sc = true; fallback = '#ece3cf';
        pins = V.prefs[prefCode].isolated; title = '30km以内に充電器がない街（人口5万人以上）';
        legend = [[C.rose, '充電器が遠い街', '#fffaf0'], [C.red, '充電器', '#fffaf0']]; break;
      case 'pref-low':
        colors = bins(M.low, [5, 20, 40, 60], ['#f3e7c7', '#ecd092', '#dba53f', '#c48a24', '#9a6a12']); focus = prefCode;
        title = '「人口のわりに充電器が半分もない」地域の人';
        legend = [['#9a6a12', '60人以上'], ['#c48a24', '40〜59'], ['#dba53f', '20〜39'], ['#ecd092', '5〜19'], ['#f3e7c7', '5人未満']]; break;
      case 'pref-planned':
        colors = { [prefCode]: '#f3dcb0' }; focus = prefCode; sc = true; planned = true; fallback = '#ece3cf';
        pins = V.prefs[prefCode].isolated.filter((c) => c.still);
        title = '計画中・候補の充電器'; legend = [[C.red, 'いまある充電器', '#fffaf0'], ['#fffaf0', '計画中・候補', C.mustard]]; break;
      default: break;
    }
    setFill(colors, fallback);
    showSc(sc, planned);
    setPins(pins);
    map.setFilter('pref-focus', ['==', ['get', 'code'], focus]);
    $('#atlas-title').textContent = title;
    $('#atlas-legend').innerHTML = legendHtml(legend);
    $('#atlas-card').classList.toggle('empty', !title);
    camera(cam);
  }

  function prefBounds(code) {
    const b = V.prefs[code]?.bbox;
    return b ? [[b[0], b[1]], [b[2], b[3]]] : JAPAN;
  }

  // ---------- navigation ----------
  function openPref(code) {
    prefCode = code && V.prefs[code] ? code : null;
    history.replaceState(null, '', prefCode ? `#pref=${prefCode}` : location.pathname);
    currentScene = null;
    renderBook();
    const first = document.querySelector('.page');
    window.scrollTo({ top: first ? first.getBoundingClientRect().top + window.scrollY - (mobile() ? window.innerHeight * 0.45 : 40) : 0, behavior: reduced ? 'auto' : 'smooth' });
    applyScene(first?.dataset.scene);
  }

  // ---------- boot ----------
  Promise.all([
    fetch('data/village.json', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('data/pref.topojson', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('data/sc.geojson', { cache: 'no-cache' }).then((r) => r.json()),
    initMap(),
  ]).then(([v, topo, sc]) => {
    V = v;
    prefGeo = topojson.feature(topo, topo.objects[Object.keys(topo.objects)[0]]);
    SC = { type: 'FeatureCollection', features: sc.features.filter((f) => (f.properties.network || 'tesla') === 'tesla') };
    $('#as-of').textContent = `${v.as_of} 時点のデータから、自動でつくっています`;
    const sel = $('#pref-select');
    sel.insertAdjacentHTML('beforeend', Object.entries(v.prefs).sort(([a], [b]) => a.localeCompare(b)).map(([c, p]) => `<option value="${c}">${esc(p.name)}</option>`).join(''));
    sel.addEventListener('change', () => openPref(sel.value || null));
    $('#atlas-back').addEventListener('click', () => openPref(null));
    setupLayers();
    const m = location.hash.match(/pref=(\d{2})/);
    prefCode = m && v.prefs[m[1]] ? m[1] : null;
    renderBook();
    applyScene(document.querySelector('.page')?.dataset.scene);
    $('#note').innerHTML = `数字は令和2年国勢調査の人口と、営業中のテスラ スーパーチャージャー ${v.sites}サイト・${nf.format(v.stalls)}ストール（${esc(v.as_of)}時点、<a href="https://supercharge.info/" target="_blank" rel="noopener">supercharge.info</a>）から計算し、100人あたりに四捨五入しています（距離の区分は合計が100人になるよう調整）。距離は住まい（1kmメッシュ）から最寄りの充電器までの直線距離です。「充電器が半分もない」は充足率（平滑化の幅30km）0.5未満の地域です。県版の「30km以内」は県境をこえた充電器もふくみます。地図の境界は「国土数値情報（行政区域データ）」（国土交通省）を加工して作成。イラストとアイコンは本サイトのオリジナルです。詳しくは<a href="about.html">データ出典と算出方法</a>をご覧ください。`;
    window.addEventListener('resize', () => { currentScene = null; observePages(); });
  }).catch((e) => {
    console.error(e);
    $('#as-of').textContent = 'データの読み込みに失敗しました。再読み込みしてください。';
  });
})();
