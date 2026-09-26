import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFlexPolyline } from '../src/lib/flexpolyline.js';
import { attempts, BadRequest, parseDeparture, parseEndpoint, parseRequest, parseVias } from '../src/lib/params.js';
import { buildHereUrl, simplifyIndices, summarize } from '../src/lib/here.js';
import { clientIp, IpLimiter, jstDay, MemoryCounter, TableCounter } from '../src/lib/limits.js';
import { handleRoute } from '../src/lib/handler.js';

test('decodes the reference flexible polyline', () => {
  // example from https://github.com/heremaps/flexible-polyline
  const pts = decodeFlexPolyline('BFoz5xJ67i1B1B7PzIhaxL7Y');
  assert.deepEqual(pts, [
    [50.10228, 8.69821],
    [50.10201, 8.69567],
    [50.10063, 8.6915],
    [50.09878, 8.68752],
  ]);
});

test('rejects malformed polylines', () => {
  assert.throws(() => decodeFlexPolyline('B!'), /invalid/);
});

test('parses places and IC endpoints with mirrored approach', () => {
  assert.deepEqual(parseEndpoint('35.1,139.2', 'o'), { kind: 'place', candidates: [[35.1, 139.2]] });
  const ic = parseEndpoint('35.001,139.001~35.003,139.002', 'o');
  assert.equal(ic.kind, 'ic');
  assert.deepEqual(ic.candidates, [[35.001, 139.001], [35.005, 139.003]]);
});

test('rejects bad endpoints', () => {
  for (const bad of [undefined, '', 'abc', '35,139,1', '10,139', '35,170', '35.1,139.2~36.5,139.2', 'x'.repeat(80)]) {
    assert.throws(() => parseEndpoint(bad, 'o'), BadRequest, String(bad));
  }
});

test('parses charging stops', () => {
  assert.deepEqual(parseVias(['34.85,137.95,30']), [{ at: [34.85, 137.95], minutes: 30 }]);
  assert.throws(() => parseVias(['34.85,137.95']), BadRequest);
  assert.throws(() => parseVias(['34.85,137.95,999']), BadRequest);
  assert.throws(() => parseVias(['35,139,1', '35,139,1', '35,139,1', '35,139,1']), BadRequest);
});

test('parses departure time in JST', () => {
  const now = new Date('2026-09-26T00:00:00Z');
  assert.equal(parseDeparture('2026-09-29T10:00', now), '2026-09-29T10:00:00+09:00');
  assert.equal(parseDeparture('', now), '2026-09-26T09:00:00+09:00');
  assert.throws(() => parseDeparture('2026-09-29 10:00', now), BadRequest);
  assert.throws(() => parseDeparture('2030-01-01T00:00', now), BadRequest);
});

test('tries IC approach combinations in order', () => {
  const req = parseRequest(new URLSearchParams('o=35.001,139.001~35.003,139.002&d=34.9,137.9&t=2026-09-29T10:00'));
  const list = attempts(req);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].o, [35.001, 139.001]);
  assert.deepEqual(list[1].o, [35.005, 139.003]);
});

test('builds the HERE request without leaking extra params', () => {
  const url = new URL(buildHereUrl({ o: [35, 139], d: [34, 137], vias: [{ at: [34.5, 138], minutes: 30 }], departure: '2026-09-29T10:00:00+09:00' }, 'KEY'));
  assert.equal(url.origin + url.pathname, 'https://router.hereapi.com/v8/routes');
  assert.equal(url.searchParams.get('via'), '34.5,138!stopDuration=1800');
  assert.equal(url.searchParams.get('return'), 'polyline,summary,tolls');
  assert.equal(url.searchParams.get('tolls[transponders]'), 'all');
  assert.equal(url.searchParams.get('apikey'), 'KEY');
});

// Synthetic response in the HERE Routing v8 shape (values are made up).
export function fakeHere({ fare = 1200, cashFare = 1300, wait = 0 } = {}) {
  const sec = (poly, tolls, spans, extra = {}) => ({
    polyline: poly,
    summary: { length: 30000, duration: 1800 + (extra.wait || 0) },
    spans,
    tolls,
    ...(extra.wait ? { postActions: [{ action: 'wait', duration: extra.wait }] } : {}),
  });
  const toll = {
    tollSystem: 'NEXCO',
    fares: [
      { price: { value: fare }, paymentMethods: ['transponder'] },
      { price: { value: cashFare }, paymentMethods: ['cash'] },
    ],
    tollCollectionLocations: [
      { name: 'A', location: { lat: 50.10228, lng: 8.69821 } },
      { name: 'B', location: { lat: 50.09878, lng: 8.68752 } },
    ],
  };
  return {
    routes: [{
      sections: [
        sec('BFoz5xJ67i1B1B7PzIhaxL7Y', [], [{ offset: 0 }], { wait }),
        sec('BFoz5xJ67i1B1B7PzIhaxL7Y', [toll], [{ offset: 0 }, { offset: 1, tollSystems: [0] }, { offset: 3 }]),
      ],
    }],
  };
}

test('summarizes sections, tolls and toll spans', () => {
  const s = summarize(fakeHere({ wait: 1800 }));
  assert.equal(s.km, 60);
  assert.equal(s.min, 90);
  assert.equal(s.etc, 1200);
  assert.equal(s.cash, 1300);
  assert.equal(s.hasToll, true);
  assert.equal(s.line.length, 7);
  assert.deepEqual(s.line[0], [8.69821, 50.10228]);
  assert.deepEqual(s.tollSpans, [[4, 6]]);
  assert.equal(s.tolls[0].entry.name, 'A');
  assert.equal(s.sections[0].wait, 30);
  assert.equal(s.sections[0].min, 30);
});

test('simplifies nearly straight lines but keeps corners', () => {
  const line = [[0, 0], [0.5, 0.00001], [1, 0], [1, 1]];
  assert.deepEqual(simplifyIndices(line), [0, 2, 3]);
});

test('client IP parsing trusts only the platform-appended entry', () => {
  assert.equal(clientIp({ 'x-forwarded-for': 'spoofed, 1.2.3.4:5678' }), '1.2.3.4');
  assert.equal(clientIp({ 'x-forwarded-for': '[2001:db8::1]:443' }), '2001:db8::1');
  assert.equal(clientIp({}), 'unknown');
});

test('IC endpoints whose approach equals the gate have a single candidate', () => {
  assert.equal(parseEndpoint('35.001,139.001~35.001,139.001', 'o').candidates.length, 1);
});

test('table counter retries table creation after a failure', async () => {
  let calls = 0;
  const client = {
    createTable: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('forbidden'), { statusCode: 403 }); },
    getEntity: async () => { throw Object.assign(new Error('nf'), { statusCode: 404 }); },
    createEntity: async () => {},
  };
  const c = new TableCounter(client);
  await assert.rejects(c.incrementIfBelow('20260101', 10));
  assert.equal(await c.incrementIfBelow('20260101', 10), true);
  assert.equal(calls, 2);
});

test('per-IP limiter', () => {
  let t = 0;
  const l = new IpLimiter({ perMinute: 2, perDay: 3, now: () => t });
  assert.ok(l.take('a'));
  assert.ok(l.take('a'));
  assert.ok(!l.take('a'));
  assert.ok(l.take('b'));
  t += 61e3;
  assert.ok(l.take('a'));
  t += 61e3;
  assert.ok(!l.take('a'), 'daily limit');
});

test('JST day key', () => {
  assert.equal(jstDay(new Date('2026-09-26T15:30:00Z')), '20260927');
});

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    apiKey: 'KEY',
    limiter: new IpLimiter(),
    counter: new MemoryCounter(),
    dailyCap: 100,
    fetch: async (url) => {
      calls.push(new URL(url));
      return { ok: true, status: 200, json: async () => fakeHere() };
    },
    ...overrides,
  };
}

const request = (qs) => ({ query: new URLSearchParams(qs), headers: new Headers({ 'x-forwarded-for': '1.2.3.4' }) });

test('handler returns a summarized route and never echoes the key', async () => {
  const d = deps();
  const res = await handleRoute(request('o=35,139&d=34.9,137.9&t=2026-09-29T10:00'), d);
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.etc, 1200);
  assert.equal(res.jsonBody.attribution, 'HERE');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(!JSON.stringify(res.jsonBody).includes('KEY'));
  assert.equal(d.calls.length, 1);
});

test('handler retries IC endpoints until tolls appear', async () => {
  let n = 0;
  const d = deps({
    fetch: async () => {
      n += 1;
      const body = n < 3 ? { routes: [{ sections: [{ polyline: 'BFoz5xJ67i1B1B7PzIhaxL7Y', summary: { length: 1000, duration: 60 } }] }] } : fakeHere();
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const res = await handleRoute(request('o=35.001,139.001~35.003,139.002&d=34.901,137.901~34.903,137.902'), d);
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.attempts, 3);
  assert.equal(res.jsonBody.hasToll, true);
  assert.deepEqual(res.jsonBody.used.o, [35.001, 139.001]);
  assert.deepEqual(res.jsonBody.used.d, [34.905, 137.903]);
});

test('handler does not retry plain places', async () => {
  const d = deps({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ routes: [{ sections: [{ polyline: 'BFoz5xJ67i1B1B7PzIhaxL7Y', summary: { length: 1000, duration: 60 } }] }] }) }) });
  const res = await handleRoute(request('o=35,139&d=34.9,137.9'), d);
  assert.equal(res.jsonBody.attempts, 1);
  assert.equal(res.jsonBody.hasToll, false);
});

test('handler enforces validation, rate limit and daily cap', async () => {
  assert.equal((await handleRoute(request('o=1,1&d=34.9,137.9'), deps())).status, 400);
  assert.equal((await handleRoute(request('o=35,139&d=34.9,137.9'), deps({ apiKey: '' }))).status, 500);
  const limited = deps({ limiter: new IpLimiter({ perMinute: 0 }) });
  assert.equal((await handleRoute(request('o=35,139&d=34.9,137.9'), limited)).status, 429);
  const capped = deps({ dailyCap: 0 });
  const res = await handleRoute(request('o=35,139&d=34.9,137.9'), capped);
  assert.equal(res.status, 503);
  assert.equal(capped.calls.length, 0);
});

test('handler fails closed when the usage counter is unavailable', async () => {
  const d = deps({ counter: { incrementIfBelow: async () => { throw new Error('down'); } } });
  const res = await handleRoute(request('o=35,139&d=34.9,137.9'), d);
  assert.equal(res.status, 503);
  assert.equal(d.calls.length, 0);
});

test('handler keeps a route already found when a retry hits HERE limits', async () => {
  let n = 0;
  const noToll = { routes: [{ sections: [{ polyline: 'BFoz5xJ67i1B1B7PzIhaxL7Y', summary: { length: 1000, duration: 60 } }] }] };
  const d = deps({
    fetch: async () => {
      n += 1;
      return n === 1 ? { ok: true, status: 200, json: async () => noToll } : { ok: false, status: 429, json: async () => ({}) };
    },
  });
  const res = await handleRoute(request('o=35.001,139.001~35.003,139.002&d=34.9,137.9'), d);
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.hasToll, false);
});

test('per-IP budget counts HERE calls, including IC retries', async () => {
  const noToll = { routes: [{ sections: [{ polyline: 'BFoz5xJ67i1B1B7PzIhaxL7Y', summary: { length: 1000, duration: 60 } }] }] };
  const d = deps({ limiter: new IpLimiter({ perMinute: 3 }), fetch: async () => ({ ok: true, status: 200, json: async () => noToll }) });
  const res = await handleRoute(request('o=35.001,139.001~35.003,139.002&d=34.901,137.901~34.903,137.902'), d);
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.attempts, 3);
  assert.equal((await handleRoute(request('o=35,139&d=34.9,137.9'), d)).status, 429);
});

test('handler maps upstream errors', async () => {
  const d = deps({ fetch: async () => ({ ok: false, status: 400, json: async () => ({}) }) });
  assert.equal((await handleRoute(request('o=35,139&d=34.9,137.9'), d)).status, 502);
  const busy = deps({ fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  assert.equal((await handleRoute(request('o=35,139&d=34.9,137.9'), busy)).status, 503);
});
