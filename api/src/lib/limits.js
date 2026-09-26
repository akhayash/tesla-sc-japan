// Abuse protection: a per-IP limiter (per instance, in memory) and a global daily cap on
// HERE calls (shared through Azure Table Storage when configured) so the HERE free tier
// cannot be exceeded. No routing results are stored anywhere (HERE terms).

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

export class MemoryCounter {
  constructor() {
    this.counts = new Map();
  }

  async incrementIfBelow(day, cap) {
    const n = this.counts.get(day) || 0;
    if (n >= cap) return false;
    this.counts.set(day, n + 1);
    return true;
  }
}

/** Daily counter in Azure Table Storage with optimistic concurrency. */
export class TableCounter {
  constructor(client) {
    this.client = client;
    this.ready = null;
  }

  async init() {
    this.ready ??= this.client.createTable().catch((e) => {
      if (e.statusCode !== 409) throw e;
    });
    return this.ready;
  }

  async incrementIfBelow(day, cap) {
    await this.init();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let entity = null;
      try {
        entity = await this.client.getEntity('here', day);
      } catch (e) {
        if (e.statusCode !== 404) throw e;
      }
      const n = entity ? Number(entity.count) : 0;
      if (n >= cap) return false;
      try {
        if (entity) {
          await this.client.updateEntity({ partitionKey: 'here', rowKey: day, count: n + 1 }, 'Replace', { etag: entity.etag });
        } else {
          await this.client.createEntity({ partitionKey: 'here', rowKey: day, count: 1 });
        }
        return true;
      } catch (e) {
        if (e.statusCode !== 409 && e.statusCode !== 412) throw e;
      }
    }
    return false;
  }
}

export function clientIp(headers) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
  const xff = get('x-forwarded-for') || '';
  const first = xff.split(',')[0].trim();
  if (!first) return 'unknown';
  // strip :port from IPv4 ("1.2.3.4:5678") and brackets from IPv6 ("[::1]:5678")
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(first);
  if (v6) return v6[1];
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(first) ? first.split(':')[0] : first;
}
