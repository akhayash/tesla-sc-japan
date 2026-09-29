import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget, dayAllowance, daysLeftInMonth, MemoryStore, utcMonth } from '../src/lib/budget.js';
import { billedRequests, oauthHeader } from '../src/lib/hereUsage.js';
import { pollUsage } from '../src/lib/usagePoll.js';

const at = (iso) => () => new Date(iso);

test('UTC month and days left, including leap February', () => {
  assert.equal(utcMonth(new Date('2026-09-30T23:59:59Z')), '2026-09');
  assert.equal(utcMonth(new Date('2026-09-30T15:00:00Z')), '2026-09', 'JST 10/1 00:00 is still September in UTC');
  assert.equal(daysLeftInMonth(new Date('2026-09-01T00:00:00Z')), 30);
  assert.equal(daysLeftInMonth(new Date('2026-09-30T12:00:00Z')), 1);
  assert.equal(daysLeftInMonth(new Date('2028-02-01T00:00:00Z')), 29);
  assert.equal(daysLeftInMonth(new Date('2027-02-01T00:00:00Z')), 28);
});

test('daily allowance spreads the remaining month and carries unused budget over', () => {
  assert.equal(dayAllowance(0, 29400, new Date('2026-09-01T00:00:00Z')), 980);
  assert.equal(dayAllowance(29000, 29400, new Date('2026-09-30T00:00:00Z')), 400);
  assert.equal(dayAllowance(30000, 29400, new Date('2026-09-30T00:00:00Z')), 0);
  assert.equal(dayAllowance(0, 29400, new Date('2026-09-01T00:00:00Z'), 500), 500);
});

test('budget counts weighted calls and stops at the daily allowance', async () => {
  const b = new Budget({ store: new MemoryStore(), monthlyCap: 60, now: at('2026-09-01T10:00:00Z') });
  assert.equal(await b.take(2), null); // allowance 60/30 = 2
  assert.equal(await b.take(2), 'daily_cap');
  const s = await b.state();
  assert.equal(s.count, 2);
  assert.equal(s.dayCount, 2);
});

test('budget carries over to the next day and stops at the monthly cap', async () => {
  let now = new Date('2026-09-29T10:00:00Z');
  const b = new Budget({ store: new MemoryStore(), monthlyCap: 10, now: () => now });
  for (let i = 0; i < 2; i += 1) assert.equal(await b.take(2), null); // allowance floor(10/2)=5 → 2 calls
  assert.equal(await b.take(2), 'daily_cap');
  now = new Date('2026-09-30T10:00:00Z'); // allowance = 10-4 = 6
  for (let i = 0; i < 3; i += 1) assert.equal(await b.take(2), null);
  assert.equal(await b.take(2), 'monthly_cap');
  now = new Date('2026-10-01T00:00:00Z');
  assert.equal((await b.state()).count, 0, 'new month starts fresh');
});

test('HERE usage raises the counter and pauses at the cap until the month ends', async () => {
  let now = new Date('2026-09-10T00:00:00Z');
  const b = new Budget({ store: new MemoryStore(), monthlyCap: 1000, now: () => now });
  assert.equal(await b.take(2), null);
  let s = await b.reconcile(1);
  assert.equal(s.count, 2, 'own counter kept when higher');
  s = await b.reconcile(600);
  assert.equal(s.count, 600);
  assert.equal(s.paused, false);
  s = await b.reconcile(1000);
  assert.equal(s.paused, true);
  assert.equal(await b.take(2), 'paused');
  now = new Date('2026-10-01T00:00:00Z');
  assert.equal(await b.take(2), null);
});

test('manual pause', async () => {
  const b = new Budget({ store: new MemoryStore(), paused: true });
  assert.equal(await b.take(2), 'paused');
});

test('OAuth 1.0 header is signed with HMAC-SHA256', () => {
  const h = oauthHeader({ keyId: 'id', keySecret: 's+cret', nonce: 'n', timestamp: 1700000000 });
  assert.match(h, /^OAuth oauth_consumer_key="id",oauth_nonce="n",oauth_signature_method="HMAC-SHA256",oauth_timestamp="1700000000",oauth_version="1.0",oauth_signature="[^"]+"$/);
  assert.equal(h, oauthHeader({ keyId: 'id', keySecret: 's+cret', nonce: 'n', timestamp: 1700000000 }));
  assert.notEqual(h, oauthHeader({ keyId: 'id', keySecret: 'other', nonce: 'n', timestamp: 1700000000 }));
});

test('billed requests come from the routing charge items only', () => {
  assert.equal(billedRequests([
    { name: 'Time Aware Routing', valueDriver: 'Transactions', usageValue: '362' },
    { name: 'Toll Cost', valueDriver: 'Transactions', usageValue: '362' },
    { name: 'Toll Cost', valueDriver: 'Transactions', usageValue: '3' },
    { name: 'Routing EV', valueDriver: 'Transactions', usageValue: '50' },
    { name: 'Autosuggest', valueDriver: 'Transactions', usageValue: '900' },
    { name: 'Data IO', valueDriver: 'GB', usageValue: '5000' },
  ]), 365);
  assert.equal(billedRequests([]), 0);
});
test('usage poll reconciles and never pauses on failure', async () => {
  const ctx = { log() {}, warn() {} };
  const env = { HERE_ACCESS_KEY_ID: 'id', HERE_ACCESS_KEY_SECRET: 'sec', HERE_ORG_ID: 'org1' };
  const b = new Budget({ store: new MemoryStore(), monthlyCap: 100 });
  const urls = [];
  const ok = async (url) => {
    urls.push(String(url));
    if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'T' }) };
    return { ok: true, json: async () => ({ items: [{ name: 'Toll Cost', valueDriver: 'Transactions', usageValue: '120' }, { name: 'Time Aware Routing', valueDriver: 'Transactions', usageValue: '120' }] }) };
  };
  const s = await pollUsage(ctx, { env, fetchImpl: ok, budget: b });
  assert.equal(s.paused, true);
  assert.ok(urls[1].startsWith('https://usage.bam.api.here.com/v2/usage/realms/org1?'));
  const b2 = new Budget({ store: new MemoryStore(), monthlyCap: 100 });
  assert.equal(await pollUsage(ctx, { env, fetchImpl: async () => ({ ok: false, status: 401 }), budget: b2 }), null);
  assert.equal(await b2.take(2), null);
  assert.equal(await pollUsage(ctx, { env: {}, fetchImpl: ok, budget: b2 }), null);
});

test('usage summary for the page', async () => {
  let now = new Date('2026-09-29T10:00:00Z');
  const b = new Budget({ store: new MemoryStore(), monthlyCap: 100, now: () => now });
  let s = await b.summary();
  assert.deepEqual(s, { month: '2026-09', used: 0, cap: 100, todayLeft: 50, paused: false, checkedAt: null });
  await b.take(1);
  s = await b.summary();
  assert.equal(s.used, 1);
  assert.equal(s.todayLeft, 49);
  now = new Date('2026-09-30T10:00:00Z');
  assert.equal((await b.summary()).todayLeft, 99, 'next day: remaining month');
  const { handleUsage } = await import('../src/lib/handler.js');
  const res = await handleUsage({ budget: b });
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.used, 1);
  const bad = await handleUsage({ budget: { summary: async () => { throw new Error('x'); } } });
  assert.equal(bad.status, 503);
});
