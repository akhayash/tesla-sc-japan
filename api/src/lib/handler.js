import { attempts, BadRequest, parseRequest } from './params.js';
import { buildHereUrl, summarize } from './here.js';
import { clientIp } from './limits.js';

const json = (status, body, extra = {}) => ({
  status,
  jsonBody: body,
  headers: { 'Cache-Control': 'no-store', ...extra },
});

/**
 * deps: { apiKey, fetch, limiter (IpLimiter), budget (Budget), txPerCall, log }
 */
export async function handleRoute(request, deps) {
  if (!deps.apiKey) return json(500, { error: 'not_configured' });
  let req;
  try {
    req = parseRequest(request.query);
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: 'bad_request', message: e.message });
    throw e;
  }
  const ip = clientIp(request.headers);
  if (req.legs && req.vias.length) return handleLegs(req, ip, deps);
  let tried = 0;
  let best = null;
  for (const { o, d } of attempts(req)) {
    // the per-IP budget counts HERE calls, not requests (IC retries cost more)
    if (!deps.limiter.take(ip)) {
      if (best) break;
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    }
    // alternatives may be billed as separate routes: count them too (conservative)
    const denied = await reserve(deps, 1 + (req.alternatives || 0));
    if (denied) {
      if (best) break;
      return denied;
    }
    tried += 1;
    let res;
    try {
      res = await deps.fetch(buildHereUrl({ o, d, vias: req.vias, departure: req.departure, alternatives: req.alternatives }, deps.apiKey));
    } catch (e) {
      deps.log?.(`HERE fetch failed: ${e.message}`);
      if (best) break;
      return json(502, { error: 'upstream' });
    }
    if (res.status === 429) {
      if (best) break;
      return json(503, { error: 'upstream_busy' }, { 'Retry-After': '30' });
    }
    if (!res.ok) {
      deps.log?.(`HERE status ${res.status}`);
      if (best) break;
      return json(502, { error: 'upstream', status: res.status });
    }
    const summary = summarize(await res.json());
    if (!summary) {
      if (best) break;
      return json(404, { error: 'no_route' });
    }
    best = { ...summary, used: { o, d } };
    // Only IC endpoints need retries: stop once the route actually uses a toll road.
    if (summary.hasToll || (req.origin.kind !== 'ic' && req.destination.kind !== 'ic')) break;
  }
  return json(200, { ...best, departure: req.departure, attempts: tried, attribution: 'HERE' });
}

/** Reserve HERE routes in the monthly budget. Returns null or an error response. */
async function reserve(deps, routes) {
  let code;
  try {
    code = await deps.budget.take((deps.txPerCall ?? 2) * routes);
  } catch (e) {
    // fail closed: without the counter the HERE budget cannot be protected
    deps.log?.(`usage counter failed: ${e.message}`);
    return json(503, { error: 'counter_unavailable' });
  }
  return code ? json(503, { error: code }) : null;
}

/** One budgeted HERE call. Returns { summary } or { error: <response> }. */
async function callHere(url, ip, deps) {
  if (!deps.limiter.take(ip)) return { error: json(429, { error: 'rate_limited' }, { 'Retry-After': '60' }) };
  const denied = await reserve(deps, 1);
  if (denied) return { error: denied };
  let res;
  try {
    res = await deps.fetch(url);
  } catch (e) {
    deps.log?.(`HERE fetch failed: ${e.message}`);
    return { error: json(502, { error: 'upstream' }) };
  }
  if (res.status === 429) return { error: json(503, { error: 'upstream_busy' }, { 'Retry-After': '30' }) };
  if (!res.ok) {
    deps.log?.(`HERE status ${res.status}`);
    return { error: json(502, { error: 'upstream', status: res.status }) };
  }
  const summary = summarize(await res.json());
  return summary ? { summary } : { error: json(404, { error: 'no_route' }) };
}

/** "YYYY-MM-DDTHH:MM:SS+09:00" shifted by `minutes`. */
export function shiftDeparture(iso, minutes) {
  const t = new Date(Date.parse(iso) + minutes * 60e3 + 9 * 3600e3);
  return `${t.toISOString().slice(0, 19)}+09:00`;
}

/**
 * Waypoints computed leg by leg (start→v1, v1→v2, …→goal) and stitched into one route.
 * A single HERE request with vias avoids U-turns at the vias, so "leave at an IC, charge,
 * re-enter at the same IC" came back as a detour via the next IC. Separate legs don't have that.
 */
export async function handleLegs(req, ip, deps) {
  const points = [req.origin.candidates[0], ...req.vias.map((v) => v.at), req.destination.candidates[0]];
  const legs = [];
  let elapsed = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const departure = shiftDeparture(req.departure, elapsed);
    const url = buildHereUrl({ o: points[i], d: points[i + 1], vias: [], departure }, deps.apiKey);
    const r = await callHere(url, ip, deps);
    if (r.error) return r.error;
    legs.push(r.summary);
    const wait = i < req.vias.length ? req.vias[i].minutes : 0;
    elapsed += r.summary.min + wait;
  }
  return json(200, { ...stitchLegs(legs, req.vias), used: { o: points[0], d: points.at(-1) }, departure: req.departure, attempts: legs.length, attribution: 'HERE' });
}

export function stitchLegs(legs, vias) {
  const line = [];
  const tollSpans = [];
  const tolls = [];
  const sections = [];
  let km = 0, min = 0, etc = 0, cash = 0, cashKnown = true;
  legs.forEach((leg, i) => {
    const base = line.length;
    const skip = base > 0 ? 1 : 0;
    line.push(...leg.line.slice(skip));
    const at = (k) => base + Math.max(0, k - skip);
    for (const [a, b, sys] of leg.tollSpans) tollSpans.push([at(a), at(b), sys]);
    for (const t of leg.tolls) tolls.push({ ...t, section: i });
    const wait = i < vias.length ? vias[i].minutes : 0;
    sections.push({ km: leg.km, min: leg.min, etc: leg.etc, wait });
    km += leg.km;
    min += leg.min + wait;
    etc += leg.etc;
    if (leg.cash == null) cashKnown = false;
    else cash += leg.cash;
  });
  return {
    km: Math.round(km * 10) / 10,
    min: Math.round(min),
    etc: Math.round(etc),
    cash: cashKnown ? Math.round(cash) : null,
    hasToll: tolls.length > 0,
    line,
    tollSpans,
    tolls,
    sections,
  };
}