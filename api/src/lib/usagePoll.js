import { getBudget } from './budget-store.js';
import { getMonthUsage } from './hereUsage.js';

// Hourly: pull HERE's own usage for this UTC month and raise the relay's counter to it (and
// pause for the rest of the month at the cap). A failure here never pauses: the relay's
// real-time counter still guards the budget.
export async function pollUsage(context, { env = process.env, fetchImpl = fetch, budget } = {}) {
  const keyId = env.HERE_ACCESS_KEY_ID?.trim();
  const keySecret = env.HERE_ACCESS_KEY_SECRET?.trim();
  const orgId = env.HERE_ORG_ID?.trim();
  if (!keyId || !keySecret || !orgId) {
    context.warn('HERE usage poll skipped: HERE_ACCESS_KEY_ID / HERE_ACCESS_KEY_SECRET / HERE_ORG_ID not set');
    return null;
  }
  const b = budget || (await getBudget());
  try {
    const now = new Date();
    const usage = await getMonthUsage({ keyId, keySecret, orgId, fetch: fetchImpl, now });
    const before = await b.state(now);
    const after = await b.reconcile(usage.total, now);
    context.log(`HERE usage ${now.toISOString().slice(0, 7)}: here=${usage.total} relay=${before.count} -> ${after.count} cap=${b.monthlyCap}${after.paused ? ' PAUSED' : ''} ${JSON.stringify(usage.byName)}`);
    return after;
  } catch (e) {
    context.warn(`HERE usage poll failed: ${e.message}`);
    return null;
  }
}
