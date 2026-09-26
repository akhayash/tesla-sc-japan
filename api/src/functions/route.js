import { app } from '@azure/functions';
import { handleRoute } from '../lib/handler.js';
import { IpLimiter, MemoryCounter, TableCounter } from '../lib/limits.js';

const limiter = new IpLimiter({
  perMinute: Number(process.env.ROUTE_PER_IP_PER_MINUTE || 10),
  perDay: Number(process.env.ROUTE_PER_IP_PER_DAY || 150),
});

let counter = null;
async function getCounter() {
  if (counter) return counter;
  const conn = process.env.ROUTE_TABLE_CONNECTION;
  const endpoint = process.env.ROUTE_TABLE_ENDPOINT;
  if (conn || endpoint) {
    const { TableClient } = await import('@azure/data-tables');
    let client;
    if (conn) {
      client = TableClient.fromConnectionString(conn, 'routeusage', { allowInsecureConnection: conn.includes('UseDevelopmentStorage') || conn.includes('127.0.0.1') });
    } else {
      const { DefaultAzureCredential } = await import('@azure/identity');
      client = new TableClient(endpoint, 'routeusage', new DefaultAzureCredential());
    }
    counter = new TableCounter(client);
  } else {
    counter = new MemoryCounter();
  }
  return counter;
}

app.http('route', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'route',
  handler: async (request, context) =>
    handleRoute(request, {
      apiKey: process.env.HERE_API_KEY,
      fetch,
      limiter,
      counter: await getCounter(),
      dailyCap: Number(process.env.ROUTE_DAILY_CAP || 900),
      log: (m) => context.warn(m),
    }),
});
