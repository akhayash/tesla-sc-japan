import { attempts, BadRequest, parseRequest } from './params.js';
import { buildHereUrl, summarize } from './here.js';
import { clientIp, jstDay } from './limits.js';

const json = (status, body, extra = {}) => ({
  status,
  jsonBody: body,
  headers: { 'Cache-Control': 'no-store', ...extra },
});

/**
 * deps: { apiKey, fetch, limiter (IpLimiter), counter (MemoryCounter|TableCounter), dailyCap, log }
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
  if (!deps.limiter.take(clientIp(request.headers))) {
    return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  }

  let tried = 0;
  let best = null;
  for (const { o, d } of attempts(req)) {
    let allowed;
    try {
      allowed = await deps.counter.incrementIfBelow(jstDay(), deps.dailyCap);
    } catch (e) {
      // fail closed: without the counter the HERE budget cannot be protected
      deps.log?.(`usage counter failed: ${e.message}`);
      if (best) break;
      return json(503, { error: 'counter_unavailable' });
    }
    if (!allowed) {
      if (best) break;
      return json(503, { error: 'daily_cap' });
    }
    tried += 1;
    let res;
    try {
      res = await deps.fetch(buildHereUrl({ o, d, vias: req.vias, departure: req.departure }, deps.apiKey));
    } catch (e) {
      deps.log?.(`HERE fetch failed: ${e.message}`);
      return json(502, { error: 'upstream' });
    }
    if (res.status === 429) return json(503, { error: 'upstream_busy' }, { 'Retry-After': '30' });
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
