/**
 * tracethis demo server
 * Run:  node demo.js
 * Then: open http://localhost:4321 and trigger requests to http://localhost:3000
 */

'use strict';

const { init, traceMiddleware, traceIt, traced } = require('./dist/cjs/index.js');
const { collector } = require('./dist/cjs/collector.js');
const { getContext } = require('./dist/cjs/context.js');
init({ port: 4321 });

const http  = require('http');
const https = require('https');

// ── Helpers ────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Makes a real HTTPS GET and parses the JSON response.
// The outgoing request is auto-instrumented by tracethis as an http-outgoing span.
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Simulates a DB query with a realistic delay.
// Creates a proper 'db' span so N+1 detection and DB stats work correctly.
function fakeDbQuery(label, delayMs) {
  const ctx = getContext();
  if (!ctx) return delay(delayMs).then(() => ({ rows: [{ id: 1 }] }));

  const span = collector.createSpan(ctx.traceId, label, 'db', ctx.spanId);
  return delay(delayMs).then(
    () => { collector.finalizeSpan(span); return { rows: [{ id: 1 }] }; },
    (err) => { collector.finalizeSpan(span, err.message); throw err; },
  );
}

// ── Service functions defined with traced() ────────────────────────────────
// Wrapped once at definition time — every call produces a span automatically.

const fetchUserProfile = traced('fetch-user-profile', async (_userId) => {
  await delay(20);
  return { id: _userId, name: 'Alice Nguyen', email: 'alice@example.com', plan: 'pro' };
});

const fetchOrderHistory = traced('fetch-order-history', async (_userId) => {
  await delay(35);
  return [
    { id: 'ord_abc', total: 49.99,  status: 'delivered' },
    { id: 'ord_def', total: 129.00, status: 'processing' },
  ];
});

const fetchNotifications = traced('fetch-notifications', async (_userId) => {
  await delay(15);
  return [{ type: 'promo', message: '20% off your next order' }];
});

const fetchRecommendations = traced('fetch-recommendations', async (_userId) => {
  await delay(45);
  return [
    { sku: 'prod_x12', score: 0.92 },
    { sku: 'prod_y34', score: 0.87 },
  ];
});

// ── Route handlers ─────────────────────────────────────────────────────────

// /orders — nested spans, outgoing HTTPS, parallel work
async function processOrder(orderId) {
  return traceIt('processOrder', async () => {
    await fakeDbQuery('SELECT users WHERE id=1', 25);
    await fakeDbQuery('SELECT products WHERE active=true', 40);

    const [inventory, pricing] = await Promise.all([
      traceIt('validateInventory', async () => {
        await fakeDbQuery('SELECT inventory WHERE sku=?', 18);
        return { inStock: true };
      }),
      traceIt({ name: 'calculatePricing', attributes: { layer: 'service' } }, async () => {
        await fakeDbQuery('SELECT pricing_rules', 12);
        return { total: 99.99 };
      }),
    ]);

    await traceIt('chargeCard', async () => {
      await new Promise((resolve, reject) => {
        https.get('https://httpbin.org/delay/0', (res) => {
          res.resume();
          res.on('end', resolve);
        }).on('error', reject);
      });
    });

    return { orderId, inventory, pricing, status: 'confirmed' };
  });
}

// /health — lightweight trace, good for sparkline history
async function getHealth() {
  return traceIt('healthCheck', async () => {
    await fakeDbQuery('SELECT 1', 2);
    return { status: 'ok', uptime: process.uptime() };
  });
}

// /error — span marked error, cascades to trace status
async function failingRoute() {
  return traceIt('riskyOperation', async () => {
    await fakeDbQuery('SELECT * FROM locked_table', 15);
    await traceIt('innerStep', async () => {
      throw new Error('Deadlock detected on table "orders"');
    });
  });
}

// /dashboard — parallel fan-out using traced() functions
// Shows how traced() wraps each service once; the dashboard just calls them normally.
async function loadDashboard(userId) {
  return traceIt('load-dashboard', async () => {
    const [profile, orders, notifications, recommendations] = await Promise.all([
      fetchUserProfile(userId),
      fetchOrderHistory(userId),
      fetchNotifications(userId),
      fetchRecommendations(userId),
    ]);
    return { profile, orders, notifications, recommendations };
  });
}

// /n-plus-one — classic N+1 query pattern
// Fetches a list then issues a separate query per row.
// The UI should flag the repeated query pattern as N+1.
async function getUsersWithOrders() {
  return traceIt('get-users-with-orders', async () => {
    // One query to get all users
    await fakeDbQuery('SELECT id, name FROM users LIMIT 5', 10);

    // Then N separate queries — one per user (the N+1 problem)
    const userIds = [101, 102, 103, 104, 105];
    const results = [];
    for (const id of userIds) {
      const orders = await fakeDbQuery(
        `SELECT * FROM orders WHERE user_id = ${id}`, 8
      );
      results.push({ userId: id, orders });
    }
    return results;
  });
}

// /slow — heavy analytics query across three slow aggregations
// Good for seeing timing bars and the route-history sparkline degrade over time.
async function runAnalytics() {
  return traceIt('analytics-report', async () => {
    const [summary, breakdown, trends] = await Promise.all([
      fakeDbQuery(
        'SELECT COUNT(*), SUM(total) FROM orders WHERE created_at > NOW() - INTERVAL 30 DAY',
        210,
      ),
      fakeDbQuery(
        'SELECT category, SUM(total) FROM order_items GROUP BY category ORDER BY 2 DESC',
        380,
      ),
      fakeDbQuery(
        'SELECT DATE(created_at), COUNT(*) FROM orders GROUP BY 1 ORDER BY 1',
        290,
      ),
    ]);

    // Post-process in JS — shows a fast function span after the slow DB work
    const report = await traceIt('build-report-payload', async () => {
      await delay(5);
      return { summary, breakdown, trends, generatedAt: new Date().toISOString() };
    });

    return report;
  });
}

// /retry — simulates a flaky external service with a retry loop
// First two attempts fail with a transient error; the third succeeds.
// Each attempt appears as its own span so you can see the retry timeline.
let _retryCounter = 0;
async function callFlakyService() {
  _retryCounter++;
  const attempt = _retryCounter % 3; // cycles: 0=ok, 1=fail, 2=fail
  await delay(40);
  if (attempt !== 0) throw new Error('Service temporarily unavailable (503)');
  return { transactionId: 'txn_' + Math.random().toString(36).slice(2, 10) };
}

async function paymentWithRetry() {
  return traceIt('payment-with-retry', async () => {
    let lastErr;
    for (let i = 1; i <= 3; i++) {
      try {
        const result = await traceIt(`attempt-${i}`, () => callFlakyService());
        return { ...result, attempts: i, status: 'charged' };
      } catch (err) {
        lastErr = err;
        await traceIt(`backoff-${i}`, () => delay(20));
      }
    }
    throw lastErr;
  });
}

// /auth — cache-hit/miss pattern
// First call misses cache and falls back to DB. Second call hits cache.
const _sessionCache = new Map();

async function checkAuth(token) {
  return traceIt('auth-check', async () => {
    // Try the cache first
    const cached = await traceIt(
      { name: 'session-cache-lookup', attributes: { store: 'memory' } },
      async () => {
        await delay(2);
        return _sessionCache.get(token) ?? null;
      },
    );

    if (cached) {
      return { ...cached, source: 'cache' };
    }

    // Cache miss — query the DB and populate cache
    await fakeDbQuery(`SELECT user_id FROM sessions WHERE token = '${token.slice(0, 8)}...'`, 22);

    const session = { userId: 'usr_' + token.slice(0, 4), roles: ['user'] };
    await traceIt('session-cache-write', async () => {
      await delay(1);
      _sessionCache.set(token, session);
    });

    return { ...session, source: 'db' };
  });
}

// /posts — real outgoing HTTP calls to jsonplaceholder.typicode.com
// Fetches the posts list, then enriches the first 3 posts with their author
// data in parallel. Shows auto-instrumented http-outgoing spans alongside
// a traceIt parent, so you can see real network latency in the waterfall.
async function fetchPostsWithAuthors() {
  return traceIt('fetch-posts-with-authors', async () => {
    // Single call — auto-instrumented as one http-outgoing span
    const posts = await httpsGetJson('https://jsonplaceholder.typicode.com/posts');

    // Take the first 3 posts and fetch each author in parallel.
    // Produces 3 concurrent http-outgoing spans under the parent.
    const firstThree = posts.slice(0, 3);
    const uniqueUserIds = [...new Set(firstThree.map(p => p.userId))];

    const users = await traceIt('enrich-authors', () =>
      Promise.all(
        uniqueUserIds.map(id =>
          httpsGetJson(`https://jsonplaceholder.typicode.com/users/${id}`)
        )
      )
    );

    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    return firstThree.map(post => ({
      id:     post.id,
      title:  post.title,
      author: userMap[post.userId]?.name ?? 'unknown',
      email:  userMap[post.userId]?.email ?? '',
    }));
  });
}

// /http-n-plus-one — classic N+1 HTTP call pattern
// Fetches each post's comments in a serial loop instead of batching.
// Each loop iteration produces an auto-instrumented http-outgoing span with
// the same normalised path (/posts/?/comments), triggering the HTTP N+1 warning.
async function getPostsWithComments() {
  return traceIt('get-posts-with-comments', async () => {
    const postIds = [1, 2, 3, 4, 5];
    const results = [];
    for (const id of postIds) {
      const comments = await httpsGetJson(`https://jsonplaceholder.typicode.com/posts/${id}/comments`);
      results.push({ postId: id, commentCount: comments.length });
    }
    return results;
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────
// IMPORTANT: pass the async handler directly as next() so it runs inside
// traceMiddleware's runWithContext(). Using `await new Promise(resolve =>
// middleware(req, res, resolve))` breaks AsyncLocalStorage in Node 20.

const server = http.createServer((req, res) => {
  traceMiddleware(req, res, async () => {
    const url = req.url.split('?')[0];
    try {
      let body;

      if (url === '/' || url === '/orders') {
        body = await processOrder('ord_' + Math.random().toString(36).slice(2, 8));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/health') {
        body = await getHealth();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/error') {
        await failingRoute();
        res.writeHead(200);
        res.end('ok');

      } else if (url === '/dashboard') {
        body = await loadDashboard('usr_demo');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/n-plus-one') {
        body = await getUsersWithOrders();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/slow') {
        body = await runAnalytics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/retry') {
        body = await paymentWithRetry();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/posts') {
        body = await fetchPostsWithAuthors();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/http-n-plus-one') {
        body = await getPostsWithComments();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else if (url === '/auth') {
        // Alternate between a fresh token (cache miss) and a repeated one (cache hit)
        const token = Math.random() < 0.5
          ? 'fixed-token-abc123'
          : 'fresh-' + Math.random().toString(36).slice(2);
        body = await checkAuth(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));

      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
});

server.listen(3000, () => {
  console.log('');
  console.log('  Demo server  →  http://localhost:3000');
  console.log('  tracethis UI →  http://localhost:4321');
  console.log('');
  console.log('  Routes:');
  console.log('    GET /orders      — nested spans + parallel work + outgoing HTTPS');
  console.log('    GET /health      — lightweight trace (good for building sparkline history)');
  console.log('    GET /error       — error span + cascading trace failure');
  console.log('    GET /dashboard   — parallel fan-out with traced() service functions');
  console.log('    GET /n-plus-one       — N+1 query pattern (triggers N+1 warning in UI)');
  console.log('    GET /http-n-plus-one  — N+1 HTTP call pattern (triggers HTTP N+1 warning in UI)');
  console.log('    GET /slow        — three slow parallel aggregation queries');
  console.log('    GET /retry       — flaky service with retry loop and backoff spans');
  console.log('    GET /auth        — cache-hit vs cache-miss pattern');
  console.log('    GET /posts       — real outgoing HTTP to jsonplaceholder (auto-instrumented)');
  console.log('');
});
