import { app } from '@azure/functions';
import { handleRoute } from '../lib/handler.js';
import { IpLimiter } from '../lib/limits.js';
import { getBudget, txPerCall } from '../lib/budget-store.js';

const limiter = new IpLimiter({
  perMinute: Number(process.env.ROUTE_PER_IP_PER_MINUTE || 20),
  perDay: Number(process.env.ROUTE_PER_IP_PER_DAY || 80),
});

app.http('route', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'route',
  handler: async (request, context) =>
    handleRoute(request, {
      apiKey: process.env.HERE_API_KEY,
      fetch,
      limiter,
      budget: await getBudget(),
      txPerCall: txPerCall(),
      log: (m) => context.warn(m),
    }),
});
