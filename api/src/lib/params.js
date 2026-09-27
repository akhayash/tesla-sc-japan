// Request validation for /api/route. Everything the client sends is untrusted.

export class BadRequest extends Error {}

const JP = { latMin: 20, latMax: 46, lngMin: 122, lngMax: 154 };
const MAX_VIAS = 3;
const MAX_STOP_MIN = 240;

function point(str, label) {
  const m = /^(-?\d{1,3}(?:\.\d{1,7})?),(-?\d{1,3}(?:\.\d{1,7})?)$/.exec(str || '');
  if (!m) throw new BadRequest(`${label}: expected lat,lng`);
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < JP.latMin || lat > JP.latMax || lng < JP.lngMin || lng > JP.lngMax) {
    throw new BadRequest(`${label}: outside Japan`);
  }
  return [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
}

/**
 * Endpoint: "lat,lng" (a plain place) or "lat,lng~lat,lng" (an IC: approach point ~ toll gate).
 * For an IC the candidates are the approach point and its mirror across the gate, because the
 * approach direction derived from map data is sometimes on the mainline side.
 */
export function parseEndpoint(str, label) {
  if (typeof str !== 'string' || str.length > 64) throw new BadRequest(`${label}: missing`);
  const parts = str.split('~');
  if (parts.length === 1) return { kind: 'place', candidates: [point(parts[0], label)] };
  if (parts.length !== 2) throw new BadRequest(`${label}: bad IC format`);
  const a = point(parts[0], label);
  const g = point(parts[1], label);
  if (Math.abs(a[0] - g[0]) > 0.02 || Math.abs(a[1] - g[1]) > 0.02) throw new BadRequest(`${label}: gate too far`);
  const flip = [Math.round((2 * g[0] - a[0]) * 1e5) / 1e5, Math.round((2 * g[1] - a[1]) * 1e5) / 1e5];
  const same = flip[0] === a[0] && flip[1] === a[1];
  return { kind: 'ic', candidates: same ? [a] : [a, flip] };
}

export function parseVias(list) {
  // several stops travel in one parameter separated by '|' (the Functions host merges repeated query keys)
  const vias = (list || []).flatMap((s) => String(s).split('|')).filter(Boolean);
  if (vias.length > MAX_VIAS) throw new BadRequest('too many stops');
  return vias.map((s, i) => {
    const m = /^(.+),(\d{1,3})$/.exec(s);
    if (!m) throw new BadRequest(`v${i}: expected lat,lng,minutes`);
    const minutes = Number(m[2]);
    if (minutes > MAX_STOP_MIN) throw new BadRequest(`v${i}: stop too long`);
    return { at: point(m[1], `v${i}`), minutes };
  });
}

/** "YYYY-MM-DDTHH:MM" in JST -> ISO string with +09:00. Defaults to now. */
export function parseDeparture(str, now = new Date()) {
  if (!str) {
    const jst = new Date(now.getTime() + 9 * 3600e3);
    return `${jst.toISOString().slice(0, 16)}:00+09:00`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(str);
  if (!m) throw new BadRequest('t: expected YYYY-MM-DDTHH:MM');
  const iso = `${str}:00+09:00`;
  const when = Date.parse(iso);
  if (Number.isNaN(when)) throw new BadRequest('t: invalid date');
  const days = (when - now.getTime()) / 86400e3;
  if (days < -31 || days > 400) throw new BadRequest('t: out of range');
  return iso;
}

export function parseRequest(query) {
  const get = (k) => (typeof query.get === 'function' ? query.get(k) : query[k]);
  const all = (k) => (typeof query.getAll === 'function' ? query.getAll(k) : [].concat(query[k] || []));
  return {
    origin: parseEndpoint(get('o'), 'o'),
    destination: parseEndpoint(get('d'), 'd'),
    vias: parseVias(all('v')),
    departure: parseDeparture(get('t')),
  };
}

/** Origin/destination combinations to try, in order, until a route with tolls is found. */
export function attempts(req) {
  const out = [];
  for (const d of req.destination.candidates.keys()) {
    for (const o of req.origin.candidates.keys()) {
      out.push([o, d]);
    }
  }
  // (0,0) first, then flip origin, flip destination, both.
  return out.map(([o, d]) => ({ o: req.origin.candidates[o], d: req.destination.candidates[d] }));
}
