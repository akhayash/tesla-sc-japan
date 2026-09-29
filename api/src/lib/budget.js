// Monthly budget of HERE requests. HERE has no hard cap (only alerts) and keeps billing past
// the free tier, so the relay (the only holder of the key) stops itself.
// Each route request is billed once as "Time Aware Routing" (free 5,000/month, because a
// departure time is sent) and once as "Toll Cost" (free 2,500/month); alternatives don't add.
// Toll Cost is the tighter one, so the cap is in requests: 2,450 (98% of 2,500).
//  - every HERE request is counted *before* it is made,
//  - month = UTC calendar month (HERE bills in UTC), capped at `monthlyCap`,
//  - each UTC day may use (remaining in month) / (days left), so unused budget carries over,
//  - an hourly poller raises the count to HERE's own usage figure when that is higher and can
//    pause the relay for the rest of the month.
// State is one entity per month so the month and day counters change atomically.
export function utcMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function daysLeftInMonth(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return last - now.getUTCDate() + 1;
}

export function dayAllowance(count, cap, now = new Date(), dailyMax = Infinity) {
  return Math.max(0, Math.min(dailyMax, Math.floor((cap - count) / daysLeftInMonth(now))));
}

const blank = () => ({ count: 0, day: '', dayCount: 0, dayAllowance: 0, actual: 0, paused: false });

export class MemoryStore {
  constructor() {
    this.rows = new Map();
  }

  /** Read-modify-write; `fn` returns the new value or null to leave it unchanged. */
  async update(key, fn) {
    const cur = this.rows.get(key) || null;
    const next = fn(cur ? { ...cur } : null);
    if (next) this.rows.set(key, next);
    return next || cur;
  }

  async get(key) {
    return this.rows.get(key) || null;
  }
}

/** Azure Table Storage with optimistic concurrency (etag). */
export class TableStore {
  constructor(client) {
    this.client = client;
    this.ready = null;
  }

  async init() {
    this.ready ??= this.client.createTable().catch((e) => {
      if (e.statusCode === 409) return;
      this.ready = null; // retry on the next request (e.g. identity/role not ready at cold start)
      throw e;
    });
    return this.ready;
  }

  async get(key) {
    await this.init();
    try {
      const e = await this.client.getEntity('budget', key);
      return JSON.parse(e.state);
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  async update(key, fn) {
    await this.init();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let entity = null;
      try {
        entity = await this.client.getEntity('budget', key);
      } catch (e) {
        if (e.statusCode !== 404) throw e;
      }
      const cur = entity ? JSON.parse(entity.state) : null;
      const next = fn(cur ? { ...cur } : null);
      if (!next) return cur;
      const row = { partitionKey: 'budget', rowKey: key, state: JSON.stringify(next) };
      try {
        if (entity) await this.client.updateEntity(row, 'Replace', { etag: entity.etag });
        else await this.client.createEntity(row);
        return next;
      } catch (e) {
        if (e.statusCode !== 409 && e.statusCode !== 412) throw e;
      }
    }
    throw new Error('budget update contention');
  }
}

export class Budget {
  constructor({ store, monthlyCap = 2450, dailyMax = Infinity, paused = false, now = () => new Date() }) {
    this.store = store;
    this.monthlyCap = monthlyCap;
    this.dailyMax = dailyMax;
    this.paused = paused;
    this.now = now;
  }

  /** Reserve `tx` transactions. Returns null when allowed, else an error code. Throws if the store fails. */
  async take(tx) {
    if (this.paused) return 'paused';
    const now = this.now();
    const day = utcDay(now);
    let denied = null;
    await this.store.update(utcMonth(now), (s) => {
      s = { ...blank(), ...s };
      if (s.paused) { denied = 'paused'; return null; }
      if (s.count + tx > this.monthlyCap) { denied = 'monthly_cap'; return null; }
      const rolled = s.day !== day;
      if (rolled) {
        s.day = day;
        s.dayCount = 0;
        s.dayAllowance = dayAllowance(s.count, this.monthlyCap, now, this.dailyMax);
      }
      if (s.dayCount + tx > s.dayAllowance) { denied = 'daily_cap'; return rolled ? s : null; }
      s.count += tx;
      s.dayCount += tx;
      return s;
    });
    return denied;
  }

  /** Apply HERE's own usage figure for the month (from the Usage API). */
  async reconcile(actual, now = this.now()) {
    return this.store.update(utcMonth(now), (s) => {
      s = { ...blank(), ...s };
      s.actual = actual;
      s.count = Math.max(s.count, actual);
      if (s.count >= this.monthlyCap) s.paused = true;
      s.checkedAt = now.toISOString();
      return s;
    });
  }

  async state(now = this.now()) {
    return { ...blank(), ...(await this.store.get(utcMonth(now))) };
  }

  /** Public usage figures (no HERE call). */
  async summary(now = this.now()) {
    const s = await this.state(now);
    const today = s.day === utcDay(now);
    const allowance = today ? s.dayAllowance : dayAllowance(s.count, this.monthlyCap, now, this.dailyMax);
    const dayUsed = today ? s.dayCount : 0;
    return {
      month: utcMonth(now),
      used: s.count,
      cap: this.monthlyCap,
      todayLeft: Math.max(0, allowance - dayUsed),
      paused: this.paused || s.paused,
      checkedAt: s.checkedAt || null,
    };
  }
}
