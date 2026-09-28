// Abuse protection: a per-IP limiter (per instance, in memory). The global HERE budget is in
// budget.js. No routing results are stored anywhere (HERE terms).

export class IpLimiter {
  constructor({ perMinute = 10, perDay = 150, now = () => Date.now() } = {}) {
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.now = now;
    this.hits = new Map();
  }

  /** Returns true if the request is allowed (and records it). */
  take(ip) {
    const t = this.now();
    const day = Math.floor((t + 9 * 3600e3) / 86400e3);
    let h = this.hits.get(ip);
    if (!h || h.day !== day) h = { day, dayCount: 0, recent: [] };
    h.recent = h.recent.filter((x) => t - x < 60e3);
    if (h.recent.length >= this.perMinute || h.dayCount >= this.perDay) {
      this.hits.set(ip, h);
      return false;
    }
    h.recent.push(t);
    h.dayCount += 1;
    this.hits.set(ip, h);
    if (this.hits.size > 5000) this.prune(t);
    return true;
  }

  prune(t) {
    for (const [ip, h] of this.hits) {
      if (!h.recent.some((x) => t - x < 60e3)) this.hits.delete(ip);
    }
  }
}

export function jstDay(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10).replaceAll('-', '');
}

export function clientIp(headers) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
  const xff = get('x-forwarded-for') || '';
  // The platform front end appends the real client address to whatever the client sent,
  // so only the last entry is trustworthy.
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return 'unknown';
  // strip :port from IPv4 ("1.2.3.4:5678") and brackets from IPv6 ("[::1]:5678")
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(last);
  if (v6) return v6[1];
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(last) ? last.split(':')[0] : last;
}
