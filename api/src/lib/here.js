import { decodeFlexPolyline } from './flexpolyline.js';

export const HERE_ROUTES = 'https://router.hereapi.com/v8/routes';

export function buildHereUrl({ o, d, vias, departure, alternatives = 0 }, apiKey) {
  const p = new URLSearchParams();
  p.set('transportMode', 'car');
  p.set('origin', `${o[0]},${o[1]}`);
  p.set('destination', `${d[0]},${d[1]}`);
  for (const v of vias) p.append('via', `${v.at[0]},${v.at[1]}!stopDuration=${v.minutes * 60}`);
  p.set('return', 'polyline,summary,tolls');
  p.set('spans', 'tollSystems');
  p.set('currency', 'JPY');
  p.set('tolls[transponders]', 'all');
  p.set('departureTime', departure);
  if (alternatives > 0) p.set('alternatives', String(alternatives));
  p.set('apikey', apiKey);
  return `${HERE_ROUTES}?${p}`;
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;

/** Douglas-Peucker on [lng, lat] points; returns the kept indices (ascending). */
export function simplifyIndices(line, tol = 0.00012) {
  const n = line.length;
  if (n <= 2) return [...Array(n).keys()];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = line[a];
    const [bx, by] = line[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let farD = t2;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = line[i];
      let u = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      u = Math.max(0, Math.min(1, u));
      const ex = ax + u * dx - px;
      const ey = ay + u * dy - py;
      const d = ex * ex + ey * ey;
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(i);
  return out;
}

/** Discount implied by a fare's applicableTimes (HERE time-domain syntax). */
export function discountOf(applicableTimes) {
  const t = String(applicableTimes || '');
  if (/\(h0\)\{h4\}/.test(t)) return 'night'; // 深夜割引 (0-4時)
  if (/\(t1\)\{d1\}|\(t7\)\{d1\}/.test(t)) return 'holiday'; // 休日割引 (土日祝)
  return null;
}

function fareOf(toll) {
  const fares = toll.fares || [];
  const tr = fares.filter((f) => (f.paymentMethods || []).includes('transponder'));
  const cash = fares.filter((f) => !(f.paymentMethods || []).includes('transponder')).map((f) => f.price.value);
  const etcFare = tr.length ? tr.reduce((a, b) => (b.price.value > a.price.value ? b : a)) : null;
  return {
    etc: etcFare ? etcFare.price.value : cash.length ? Math.min(...cash) : 0,
    cash: cash.length ? Math.max(...cash) : null,
    discount: etcFare ? discountOf(etcFare.applicableTimes) : null,
  };
}

/** Reduce a HERE Routing v8 response to what the map needs (first route + alternatives). */
export function summarize(json) {
  const routes = json?.routes || [];
  if (!routes.length) return null;
  const first = summarizeRoute(routes[0]);
  const alternatives = routes.slice(1).map(summarizeRoute);
  return alternatives.length ? { ...first, alternatives } : first;
}

function summarizeRoute(route) {
  const line = [];
  const tollSpans = [];
  const tolls = [];
  const sections = [];
  let km = 0;
  let sec = 0;
  let etc = 0;
  let cash = 0;
  let cashKnown = true;
  route.sections.forEach((s, si) => {
    const pts = decodeFlexPolyline(s.polyline);
    const base = line.length;
    // consecutive sections share their joint point; keep it once
    const skip = base > 0 ? 1 : 0;
    for (const [lat, lng] of pts.slice(skip)) line.push([round5(lng), round5(lat)]);
    const offset = (i) => base + Math.max(0, i - skip);
    const spans = s.spans || [];
    spans.forEach((sp, k) => {
      if (!sp.tollSystems?.length) return;
      const end = k + 1 < spans.length ? spans[k + 1].offset : pts.length - 1;
      // [start, end, toll system name] so the map can colour each operator's stretch
      const sys = s.tollSystems?.[sp.tollSystems[0]]?.name || '';
      tollSpans.push([offset(sp.offset), offset(end), sys]);
    });
    let sEtc = 0;
    let sCash = 0;
    for (const t of s.tolls || []) {
      const f = fareOf(t);
      sEtc += f.etc;
      if (f.cash === null) cashKnown = false;
      else sCash += f.cash;
      const locs = (t.tollCollectionLocations || []).map((l) => ({ name: l.name || '', lng: round5(l.location.lng), lat: round5(l.location.lat) }));
      tolls.push({ section: si, system: t.tollSystem || '', etc: f.etc, cash: f.cash, discount: f.discount, entry: locs[0] || null, exit: locs.length > 1 ? locs[locs.length - 1] : null });
    }
    etc += sEtc;
    cash += sCash;
    // summary.duration already includes the stop (postActions wait) of this section
    const wait = (s.postActions || []).filter((a) => a.action === 'wait').reduce((a, b) => a + b.duration, 0);
    sections.push({ km: s.summary.length / 1000, min: (s.summary.duration - wait) / 60, etc: sEtc, wait: wait / 60 });
    km += s.summary.length / 1000;
    sec += s.summary.duration;
  });
  const kept = new Set(simplifyIndices(line));
  for (const [a, b] of tollSpans) {
    kept.add(a);
    kept.add(b);
  }
  const idx = [...kept].sort((a, b) => a - b);
  const remap = new Map(idx.map((old, i) => [old, i]));
  return {
    km: Math.round(km * 10) / 10,
    min: Math.round(sec / 60),
    etc: Math.round(etc),
    cash: cashKnown ? Math.round(cash) : null,
    hasToll: tolls.length > 0,
    line: idx.map((i) => line[i]),
    tollSpans: tollSpans.map(([a, b, sys]) => [remap.get(a), remap.get(b), sys]),
    tolls,
    sections: sections.map((s) => ({ km: Math.round(s.km * 10) / 10, min: Math.round(s.min), etc: Math.round(s.etc), wait: Math.round(s.wait) })),
  };
}
