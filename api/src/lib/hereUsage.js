// HERE's own usage figure for the month, from the Cost Management Usage API
// (docs.here.com/usage). Needs OAuth credentials of an app in the same organization.
// Usage for location services arrives up to ~2 hours late, so this only corrects the relay's
// own real-time counter upwards; it never replaces it.
import { createHmac, randomBytes } from 'node:crypto';

export const TOKEN_URL = 'https://account.api.here.com/oauth2/token';
export const USAGE_URL = 'https://usage.bam.api.here.com/v2/usage/realms';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0 (HMAC-SHA256) Authorization header for the token request. */
export function oauthHeader({ keyId, keySecret, url = TOKEN_URL, body = { grant_type: 'client_credentials' }, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: keyId,
    oauth_nonce: nonce ?? randomBytes(12).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  const params = Object.entries({ ...oauth, ...body })
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = `POST&${enc(url)}&${enc(params)}`;
  const signature = createHmac('sha256', `${enc(keySecret)}&`).update(base).digest('base64');
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${k}="${enc(v)}"`).join(',')}`;
}

export async function getToken({ keyId, keySecret, fetch }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: oauthHeader({ keyId, keySecret }), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('token missing');
  return j.access_token;
}

/**
 * Route requests HERE has billed this month. Every relay request is billed once under each of
 * these charge items, so the largest of them is the request count (other services are ignored).
 */
export const ROUTE_ITEMS = /^(toll cost|time aware routing|routing( car.*)?)$/i;
export function billedRequests(items) {
  const byItem = {};
  for (const it of items || []) {
    if (!/transaction/i.test(it.valueDriver || '') || !ROUTE_ITEMS.test((it.name || '').trim())) continue;
    byItem[it.name] = (byItem[it.name] || 0) + (Number(it.usageValue) || 0);
  }
  return Math.max(0, ...Object.values(byItem));
}
export async function getMonthUsage({ keyId, keySecret, orgId, fetch, now = new Date() }) {
  const token = await getToken({ keyId, keySecret, fetch });
  const start = `${now.toISOString().slice(0, 7)}-01T00:00:00`;
  const end = now.toISOString().slice(0, 19);
  const all = [];
  const names = {};
  for (let offset = 0, page = 0; page < 20; page += 1) {
    const q = new URLSearchParams({ startDate: start, endDate: end, limit: '100', offset: String(offset) });
    const res = await fetch(`${USAGE_URL}/${encodeURIComponent(orgId)}?${q}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Correlation-ID': randomBytes(8).toString('hex') },
    });
    if (!res.ok) throw new Error(`usage HTTP ${res.status}`);
    const j = await res.json();
    const items = j.items || [];
    all.push(...items);
    for (const it of items) if (/transaction/i.test(it.valueDriver || '')) names[it.name] = (names[it.name] || 0) + Number(it.usageValue || 0);
    if (j.nextOffset == null || j.nextOffset <= offset || items.length === 0 || (j.lastOffset != null && offset >= j.lastOffset)) break;
    offset = j.nextOffset;
  }
  return { total: billedRequests(all), byName: names };
}
