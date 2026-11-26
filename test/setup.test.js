// Client setup gaps (pm.setupGaps): which boosting clients have no service price, or spend with no order counted.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const { setupGaps } = require('../src/pm');

const clients = [
  { id: 1, name: 'A', service: { price: 79 } },  // priced, orders counted → fine
  { id: 2, name: 'B', service: {} },             // no price, orders counted
  { id: 3, name: 'C', service: { price: 79 } },  // priced, 0 orders
  { id: 4, name: 'D' },                          // no price, 0 orders, biggest spend
  { id: 5, name: 'E' },                          // under $20 in 7 days → ignored
  { id: 6, name: 'F', archived: true },          // paused → ignored
];
const spend = { 1: 50, 2: 30, 3: 25, 4: 900, 5: 19.99, 6: 500 }, orders = { 1: { orders: 4 }, 2: { orders: 1 } };
let g = setupGaps(clients, spend, orders, true);
assert.deepStrictEqual(g.map((x) => [x.name, x.missing]), [['D', ['price', 'orders']], ['B', ['price']], ['C', ['orders']]]);
g = setupGaps(clients, spend, orders, false); // orders are not counted at all → only the price is checked
assert.deepStrictEqual(g.map((x) => [x.name, x.missing]), [['D', ['price']], ['B', ['price']]]);
console.log('setup ok');
