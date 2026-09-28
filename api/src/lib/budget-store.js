import { Budget, MemoryStore, TableStore } from './budget.js';

let store = null;
async function getStore() {
  if (store) return store;
  const conn = process.env.ROUTE_TABLE_CONNECTION;
  const endpoint = process.env.ROUTE_TABLE_ENDPOINT;
  if (conn || endpoint) {
    const { TableClient } = await import('@azure/data-tables');
    let client;
    if (conn) {
      client = TableClient.fromConnectionString(conn, 'routebudget', { allowInsecureConnection: conn.includes('UseDevelopmentStorage') || conn.includes('127.0.0.1') });
    } else {
      const { DefaultAzureCredential } = await import('@azure/identity');
      client = new TableClient(endpoint, 'routebudget', new DefaultAzureCredential());
    }
    store = new TableStore(client);
  } else {
    store = new MemoryStore();
  }
  return store;
}

// A malformed setting must never lift the cap: fall back to the safe default.
const num = (v, d, min = 0) => {
  if (v === undefined || v === '') return d;
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : d;
};

export async function getBudget() {
  return new Budget({
    store: await getStore(),
    monthlyCap: num(process.env.ROUTE_MONTHLY_TX_CAP, 29400),
    dailyMax: num(process.env.ROUTE_DAILY_TX_MAX, Infinity),
    paused: process.env.ROUTE_PAUSED === '1',
  });
}

export const txPerCall = () => num(process.env.ROUTE_TX_PER_CALL, 2, 1);
