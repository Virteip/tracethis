# tracethis — User Manual

> Local request tracing for Node.js / TypeScript.
> Visualise exactly where time goes inside every HTTP request — zero config, zero cloud, zero production risk.

---

## Table of contents

1. [Core concept](#1-core-concept)
2. [Installation](#2-installation)
3. [init()](#3-init)
4. [traceMiddleware](#4-tracemiddleware)
   - [Express](#41-express)
   - [Fastify](#42-fastify)
   - [Koa](#43-koa)
   - [Hono](#44-hono)
   - [NestJS — TraceInterceptor](#45-nestjs--traceinterceptor)
   - [Plain Node.js http server](#46-plain-nodejs-http-server)
5. [@TraceThis decorator](#5-tracethis-decorator)
6. [traceIt() and traced()](#6-traceit-and-traced)
7. [Choosing between @TraceThis, traceIt, and traced](#7-choosing-between-tracethis-traceit-and-traced)
8. [Auto-instrumented libraries](#8-auto-instrumented-libraries)
9. [The UI](#9-the-ui)
10. [Data model](#10-data-model)
11. [Common patterns](#11-common-patterns)
12. [TypeScript setup](#12-typescript-setup)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Core concept

tracethis works in three layers:

```
Incoming HTTP request
      │
      ▼
traceMiddleware                   ← creates the root "Trace" and its root span
      │  (AsyncLocalStorage context flows down through the entire call stack)
      ├── auto-patched libraries  ← http, fetch, pg, mongoose, redis, mysql2
      │      automatically attach child spans without any code change
      │
      ├── @TraceThis / traceIt / traced  ← manual child spans for your own functions
      │
      └── response sent           ← root span + trace finalised, UI updated via SSE
```

**Every span lives inside a Trace.** A Trace is one complete request cycle — from the moment the request arrives until the response is sent. Spans are the individual operations within that request: outgoing HTTP calls, database queries, and your own instrumented functions.

The connection between a running request and all the code it calls is maintained by Node's `AsyncLocalStorage`. As long as you stay within the same async call chain (no `setTimeout`/`setInterval` detached callbacks, no `new Worker` threads), context propagates automatically.

---

## 2. Installation

```bash
npm install --save-dev tracethis
```

tracethis is a **dev dependency**. It hard-checks `NODE_ENV` at runtime and becomes a complete no-op in production — no patches are applied, no server starts, and no overhead is added.

---

## 3. init()

`init()` must be called **once**, at the very top of your application entry point, before any other imports that might use `http`, `fetch`, or database clients. This ensures the monkey-patches are in place before any patched module is first used.

```ts
import { init } from 'tracethis';

init(); // safe defaults: port 4321, maxTraces 100
```

### Options

```ts
init({
  port?: number,       // Port for the local UI server. Default: 4321
  maxTraces?: number,  // How many traces to hold in memory before oldest are evicted. Default: 100
})
```

**`port`** — The UI is served at `http://localhost:<port>`. Change this if 4321 conflicts with another service.

```ts
init({ port: 9000 }); // UI at http://localhost:9000
```

**`maxTraces`** — tracethis keeps traces in a circular buffer. When the buffer is full, the oldest trace is evicted. This keeps memory usage bounded during long dev sessions.

```ts
init({ maxTraces: 50 }); // keep only the last 50 requests
```

### Production safety

```ts
// NODE_ENV=production → this line is a silent no-op
init();
```

When `NODE_ENV` is `production`, `init()` logs a single warning and returns immediately. **No patches are applied, no server is started.** You can safely call `init()` unconditionally in your entry file — it will never affect production behaviour.

### Idempotency

Calling `init()` more than once is safe. Only the first call takes effect.

---

## 4. traceMiddleware

`traceMiddleware` is a single export that works across all major Node.js HTTP frameworks. It detects which framework it is being called from by inspecting its arguments at runtime, so you always import the same function regardless of which framework you use.

What it does:
- Creates a new Trace for the incoming request
- Creates the root `http-incoming` span
- Pushes the trace context into `AsyncLocalStorage` so all downstream code can see it
- Captures the request headers and pre-parsed body (if a body-parser has already run)
- Intercepts the response to capture response headers and body (up to 10 KB each)
- Finalises the trace when the response finishes

### 4.1 Express

```ts
import express from 'express';
import { init, traceMiddleware } from 'tracethis';

init();

const app = express();

// Register as early as possible, before routes and other middleware
app.use(traceMiddleware);

app.get('/orders/:id', async (req, res) => {
  const order = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  res.json(order.rows[0]);
});

app.listen(3000);
```

If you use a body-parser, place it **before** `traceMiddleware` so the parsed body is available for capture:

```ts
app.use(express.json());          // body-parser runs first
app.use(express.urlencoded({ extended: true }));
app.use(traceMiddleware);         // now req.body is available to tracethis
```

The response body is captured by intercepting `res.write` and `res.end` — this is transparent to your application.

### 4.2 Fastify

```ts
import Fastify from 'fastify';
import { init, traceMiddleware } from 'tracethis';

init();

const fastify = Fastify();

// onRequest fires before routing, before body parsing
fastify.addHook('onRequest', traceMiddleware);

fastify.get('/health', async () => {
  return { status: 'ok' };
});

fastify.listen({ port: 3000 });
```

> **Note on body capture**: Fastify parses the body asynchronously after `onRequest`. The request body will not be present in the Summary panel for Fastify apps. Response body capture is handled via `reply.raw` and works correctly.

### 4.3 Koa

```ts
import Koa from 'koa';
import { init, traceMiddleware } from 'tracethis';

init();

const app = new Koa();

// Register first so it wraps all other middleware
app.use(traceMiddleware);

app.use(async (ctx) => {
  ctx.body = { message: 'hello' };
});

app.listen(3000);
```

With koa-bodyparser, place it **after** `traceMiddleware` and the parsed body will be captured (because `traceMiddleware` awaits `next()` before reading `ctx.request.body`):

```ts
import bodyParser from 'koa-bodyparser';

app.use(traceMiddleware);
app.use(bodyParser());

app.use(async (ctx) => {
  // ctx.request.body is available and will be captured in the Request tab
  ctx.body = { received: ctx.request.body };
});
```

### 4.4 Hono

```ts
import { Hono } from 'hono';
import { init, traceMiddleware } from 'tracethis';

init();

const app = new Hono();

app.use('*', traceMiddleware);

app.get('/users', (c) => {
  return c.json({ users: [] });
});

export default app;
```

> **Note on body capture**: Hono uses the Web Streams API. Reading a `ReadableStream` body consumes it, which would break the request. tracethis captures Hono request and response **headers** only; body capture is skipped for Hono.

### 4.5 NestJS — TraceInterceptor

NestJS uses a different interception model (RxJS observables) so tracethis exports a dedicated `TraceInterceptor` class.

**Global (applies to every controller and every route):**

```ts
// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TraceInterceptor } from 'tracethis';
import { init } from 'tracethis';

async function bootstrap() {
  init();
  const app = await NestFactory.create(AppModule);
  app.useGlobalInterceptors(new TraceInterceptor());
  await app.listen(3000);
}
bootstrap();
```

**Per-controller:**

```ts
import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { TraceInterceptor } from 'tracethis';

@UseInterceptors(TraceInterceptor)
@Controller('orders')
export class OrdersController {
  @Get()
  findAll() { ... }
}
```

**Per-route:**

```ts
@Get(':id')
@UseInterceptors(TraceInterceptor)
findOne(@Param('id') id: string) { ... }
```

### 4.6 Plain Node.js http server

When using Node's built-in `http.createServer` directly, you must pass the handler as the `next` argument to `traceMiddleware`. **Do not** wrap the handler in a Promise — this breaks `AsyncLocalStorage` context propagation in Node 20+.

```ts
import * as http from 'http';
import { init, traceMiddleware } from 'tracethis';

init();

// CORRECT — handler is passed directly as next()
const server = http.createServer((req, res) => {
  traceMiddleware(req, res, async () => {
    // All code here runs inside the trace context
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
});

server.listen(3000);
```

```ts
// WRONG — breaks AsyncLocalStorage in Node 20
const server = http.createServer((req, res) => {
  await new Promise(resolve => traceMiddleware(req, res, resolve));
  // ❌ context is lost here — spans created below won't be linked to the trace
  res.end('ok');
});
```

**Why**: In Node 20, `await new Promise(resolve => ...)` creates a new async context boundary. The continuation after `await` runs in the Promise's *creation* context, not the `resolve` call's context. Passing the handler directly as `next()` keeps everything in the same `AsyncLocalStorage` chain.

---

## 5. @TraceThis decorator

`@TraceThis()` is a method decorator that automatically wraps a class method in a child span. It works on both synchronous and asynchronous methods.

### Basic usage

```ts
import { TraceThis } from 'tracethis';

class OrderService {
  @TraceThis()
  async processOrder(orderId: string) {
    // This method is automatically timed as a span named "processOrder"
    const user = await this.getUser(orderId);
    return this.buildResponse(user);
  }

  @TraceThis()
  private getUser(id: string) {
    // sync methods work too
    return db.users.find(u => u.id === id);
  }
}
```

The span name defaults to the method name as it appears in the source code.

### Custom name and attributes

```ts
class PricingService {
  @TraceThis({ name: 'calculate-pricing', attributes: { layer: 'service', version: 2 } })
  async calculate(cart: Cart): Promise<Price> {
    // span will appear as "calculate-pricing" in the UI
    // attributes layer=service and version=2 are visible in the Span Inspector tab
  }
}
```

**`name`** — Overrides the span name. Useful when the method name is not descriptive enough, or when you have multiple implementations of the same interface and want distinct names.

**`attributes`** — Key-value pairs attached to the span. Values must be `string`, `number`, or `boolean`. Visible in the Span Inspector tab when you click the span in the waterfall.

### Arguments and return value

When you click a `@TraceThis` span in the Span Inspector, you will see:

- **`argument`** / **`arg[0]`**, **`arg[1]`**, … — each argument the method was called with, serialized as JSON (up to 1 000 characters per value)
- **`return value`** — the value the method returned, serialized as JSON; absent for `void`/`undefined` returns and when the method throws

```ts
class OrderService {
  @TraceThis()
  async getOrder(id: string, includeItems: boolean) {
    return { id, items: includeItems ? await this.loadItems(id) : [] };
  }
}
// Span Inspector shows:
//   arg[0]       "ord_abc"
//   arg[1]       true
//   return value { "id": "ord_abc", "items": [...] }
```

This is useful for debugging wrong inputs or unexpected return shapes without adding `console.log` calls.

### Error handling

If the decorated method throws, the span is automatically marked as `error` with the exception message, and the error is re-thrown. You don't need any special try/catch.

```ts
class PaymentService {
  @TraceThis()
  async charge(amount: number) {
    if (amount <= 0) throw new Error('Amount must be positive');
    // ↑ span status = 'error', span.error = 'Amount must be positive'
    // the error continues to propagate normally to the caller
  }
}
```

### Nested spans

Decorating multiple methods in a call chain produces a tree of nested spans. Each `@TraceThis` method becomes a child of whichever `@TraceThis` method called it.

```ts
class OrderService {
  @TraceThis()
  async processOrder(orderId: string) {
    await this.validateInventory(orderId);   // child span
    await this.chargeCard(orderId);          // child span
    await this.sendConfirmation(orderId);    // child span
  }

  @TraceThis()
  private async validateInventory(orderId: string) { ... }

  @TraceThis()
  private async chargeCard(orderId: string) { ... }

  @TraceThis()
  private async sendConfirmation(orderId: string) { ... }
}
```

In the waterfall you will see `processOrder` as the parent bar, with the three children indented beneath it.

### Outside a request context

If a decorated method is called outside of an active request (e.g. during application startup, in a background job, or in a test), it silently executes the original method without creating any spans. No errors, no side effects.

```ts
// During startup — no trace context, no span created, method runs normally
await orderService.processOrder('warmup');
```

### TypeScript configuration required

Decorators require the following in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}
```

---

## 6. traceIt() and traced()

These are the two functional alternatives to `@TraceThis`. Use them when you cannot use decorators — plain functions, arrow functions, callbacks, or any code outside a class.

They share the same config signature and the same span behaviour; the difference is *where* in your code you apply them.

---

### 6a. traceIt() — call-site wrapper

`traceIt()` traces a single expression inline, at the exact point you call it. You wrap the call every time you want tracing at that location.

#### Signature

```ts
function traceIt<T>(config: string | TraceItOptions, fn: () => T): T
```

The return type `T` is fully inferred from `fn`.

#### Basic usage

```ts
import { traceIt } from 'tracethis';

// Sync
const result = traceIt('parse-csv', () => parseCsv(rawData));

// Async
const user = await traceIt('fetch-user', async () => {
  return db.users.findById(userId);
});
```

#### With attributes

```ts
const report = await traceIt(
  { name: 'generate-report', attributes: { format: 'pdf', rows: 1500 } },
  async () => generateReport(params),
);
```

**`name`** *(required when using object form)* — The span name shown in the waterfall.

**`attributes`** *(optional)* — Additional key-value metadata shown in the Span Inspector. Values must be `string`, `number`, or `boolean`.

#### Wrapping a single call site

```ts
// Before
const price = await pricingEngine.calculate(cart);

// After — this specific call is now traced
const price = await traceIt('pricing-engine', () => pricingEngine.calculate(cart));
```

#### Nesting

`traceIt` calls inside each other produce nested spans:

```ts
const result = await traceIt('process-order', async () => {
  const user = await traceIt('load-user', () => db.getUser(userId));
  const inv  = await traceIt('check-inventory', () => inventory.check(sku));
  const pay  = await traceIt('charge-card', () => stripe.charge(amount));
  return { user, inv, pay };
});
// Waterfall: process-order (parent)
//              └─ load-user
//              └─ check-inventory
//              └─ charge-card
```

#### Parallel operations

```ts
const [inventory, pricing] = await traceIt('validate-order', async () => {
  return Promise.all([
    traceIt('check-inventory', () => inventory.check(sku)),
    traceIt('calculate-price', () => pricing.calculate(cart)),
  ]);
});
// Waterfall: validate-order
//              └─ check-inventory  (parallel)
//              └─ calculate-price  (parallel)
```

#### Error handling

If `fn` throws, the span is marked `error`, the message is stored, and the error is re-thrown:

```ts
try {
  await traceIt('risky-operation', async () => {
    throw new Error('connection refused');
  });
} catch (err) {
  // span shows red in UI; Span Inspector shows error = "connection refused"
}
```

#### Return value capture

When you click a `traceIt` span in the Span Inspector, the **`return value`** field shows what the traced expression returned, serialized as JSON. It is absent when the expression returns `undefined` or throws.

```ts
const price = await traceIt('calculate-price', () => pricingEngine.run(cart));
// Span Inspector → return value: { "total": 49.99, "currency": "usd" }
```

> **Note:** `traceIt` does not capture the arguments passed to the inner function because they are embedded in the closure. Use `traced()` if you need arguments visible in the inspector.

#### Outside a request context

Like `@TraceThis`, `traceIt` silently passes through when no trace is active:

```ts
// In a script, test, or background job — fn() runs normally, no span created
const result = await traceIt('startup-task', async () => loadConfig());
```

---

### 6b. traced() — definition-site wrapper

`traced()` wraps a function **once at definition time** and returns a permanently-traced version with the **same signature**. Every call to the returned function automatically creates a child span — callers never need to be aware of tracing.

#### Signature

```ts
function traced<A extends unknown[], R>(
  config: string | TraceItOptions,
  fn: (...args: A) => R,
): (...args: A) => R
```

Parameter types and return type are fully inferred from `fn`.

#### Basic usage

```ts
import { traced } from 'tracethis';

// Define once — trace is applied permanently
const chargeCard = traced('charge-card', async (amount: number) => {
  return stripe.charges.create({ amount });
});

// Call like a normal function — no tracing boilerplate at the call site
await chargeCard(99);
await chargeCard(199);
// Both calls produce a 'charge-card' span in the waterfall
```

#### Why use traced() instead of traceIt()

`traceIt` requires you to wrap *every call site*. If `chargeCard` is called from five different modules, you need `traceIt(...)` in all five places. With `traced`, you instrument it once at the definition and all callers are covered automatically:

```ts
// payments.ts
export const chargeCard = traced('charge-card', async (amount: number) => {
  return stripe.charges.create({ amount });
});

// orders.ts — no tracing code needed here
import { chargeCard } from './payments';
await chargeCard(order.total);  // ← traced automatically

// refunds.ts — no tracing code needed here either
import { chargeCard } from './payments';
await chargeCard(-refund.amount);  // ← also traced automatically
```

#### With attributes

```ts
const getUser = traced(
  { name: 'get-user', attributes: { layer: 'db' } },
  async (id: string) => db.users.findById(id),
);

await getUser('usr_123');  // span name = "get-user", attributes.layer = "db"
```

#### Wrapping third-party functions

```ts
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!);

// Wrap once; every caller gets tracing for free
export const createCharge = traced(
  { name: 'stripe-create-charge', attributes: { gateway: 'stripe' } },
  (amount: number, currency: string) =>
    stripe.charges.create({ amount, currency }),
);
```

#### Arguments and return value

Because `traced()` wraps a real function signature, it can capture both the call arguments and the return value. When you click a `traced` span in the Span Inspector you will see:

- **`argument`** (single arg) or **`arg[0]`**, **`arg[1]`**, … — every value passed to the function, JSON-serialized (up to 1 000 characters each)
- **`return value`** — JSON-serialized return value; absent for `void`/`undefined` returns

```ts
const getUser = traced('get-user', async (id: string, includeOrders: boolean) => {
  return { id, orders: includeOrders ? await fetchOrders(id) : [] };
});

await getUser('usr_1', true);
// Span Inspector shows:
//   arg[0]       "usr_1"
//   arg[1]       true
//   return value { "id": "usr_1", "orders": [...] }
```

Values larger than 1 000 characters are truncated with a `… (truncated)` marker. Circular references and other non-serializable values fall back to `String(value)`.

#### Error handling

Same as `traceIt` — throws are caught, the span is marked `error`, and the error is re-thrown:

```ts
const fetchUser = traced('fetch-user', async (id: string) => {
  const user = await db.users.findById(id);
  if (!user) throw new Error(`User ${id} not found`);
  return user;
});

// Caller just uses it normally — error propagates as usual
const user = await fetchUser('usr_999');
```

#### Outside a request context

```ts
// No active trace → fn runs normally, no span created
const result = await fetchUser('usr_1');
```

---

### 6c. watchThis() — deprecated alias

`watchThis` is an alias for `traceIt` kept for backwards compatibility. It behaves identically. New code should use `traceIt` or `traced`.

```ts
import { watchThis } from 'tracethis'; // still works
```

---

## 7. Choosing between @TraceThis, traceIt, and traced

| Situation | Use |
|---|---|
| Tracing a method on a class | `@TraceThis()` — cleaner, no call-site changes |
| Tracing one specific call site | `traceIt('name', () => fn(args))` |
| Tracing all calls to a function, from all callers | `traced('name', fn)` — instrument once at definition |
| Tracing a third-party or imported function | `traced('name', thirdParty.method.bind(thirdParty))` |
| Cannot enable `experimentalDecorators` in tsconfig | `traceIt()` or `traced()` |
| Per-call dynamic attributes (e.g. request ID) | `traceIt({ name, attributes: { id } }, () => fn())` |
| Shared utility called from many modules | `traced()` — wrap once, all callers automatically traced |

All three can be freely mixed in the same codebase.

---

## 8. Auto-instrumented libraries

After `init()` is called, the following libraries are automatically patched. Any call made within an active request trace context automatically creates a child `db` or `http-outgoing` span — no code changes required.

### HTTP clients

| What gets patched | Span name format | Covers |
|---|---|---|
| `http.ClientRequest.prototype.end` | `GET api.example.com/path` | `http`, `https`, `axios`, `got`, `superagent`, `node-fetch v2`, any library using Node's `http.ClientRequest` |
| `globalThis.fetch` | `fetch GET api.example.com/path` | Node 18+ native `fetch`, `undici` |

Span attributes for outgoing HTTP:
- `host` — the hostname (e.g. `api.stripe.com`)
- `path` — the URL path (e.g. `/v1/charges`)
- `method` — HTTP method in uppercase (e.g. `POST`)
- `protocol` — `http` or `https`
- `statusCode` — response status code (added when response arrives)

### Database clients

| Library | Span name format | Attributes |
|---|---|---|
| `pg` (node-postgres) | `pg: SELECT * FROM orders WHERE id = $1` | `db: 'postgres'`, `query` |
| `mongoose` | `mongoose: find User` | `db: 'mongodb'`, `operation`, `model` |
| `ioredis` | `redis: GET` | `db: 'redis'`, `command` |
| `redis` (node-redis v4) | `redis: SET` | `db: 'redis'`, `command` |
| `mysql2` | `mysql: SELECT * FROM orders` | `db: 'mysql'`, `query` |

> **Note on query truncation**: For pg and mysql2, the query text in the span name is truncated at 120 characters to avoid very long labels in the waterfall. The full query is still available in the span's `attributes.query` field, which the Span Inspector shows untruncated.

### Libraries without native patches

Some popular clients are covered indirectly:

- **axios** — built on `http.ClientRequest` → patched automatically
- **got** — built on `http.ClientRequest` → patched automatically
- **superagent** — built on `http.ClientRequest` → patched automatically
- **node-fetch v2** — built on `http.ClientRequest` → patched automatically
- **node-fetch v3 / undici** — uses `globalThis.fetch` → patched automatically
- **Prisma** — uses the underlying database driver (`pg`, `mysql2`) → patched automatically via the driver

---

## 9. The UI

Open **http://localhost:4321** (or your configured port) after starting the server.

### Left panel — Trace list

Shows the most recent traces, newest at the top. Each row shows:
- **Method badge** — colour-coded: GET=green, POST=blue, PUT/PATCH=yellow, DELETE=red
- **Route** — the URL path
- **Status code** badge
- **Duration** — colour-coded: <200ms=green, <1000ms=yellow, ≥1000ms=red
- **Timestamp** — when the request arrived
- **Speed bar** — thin colour stripe at the bottom of the row (logarithmic scale)

Click any trace row to select it and open the detail view on the right.

The **live dot** in the top-right corner shows the SSE connection status. Traces update in real time — no page refresh needed.

The **clear** button removes all traces from the list and the collector.

### Right panel — Detail view

Appears when a trace is selected. Contains:

#### Trace meta bar

Displays the method, route, status code, timestamp, span count, and total duration of the selected trace at a glance.

#### Tab bar

Three tabs sit below the meta bar. Click to switch between them.

---

#### Tab 1: Summary

Loaded automatically when a trace is selected. Contains three sections:

**External Dependencies table** — all outbound HTTP calls grouped by hostname. Columns: hostname, call count, total duration, average duration. Sorted by total duration (slowest host first). Useful for spotting which external service is your bottleneck.

**Database section** — total query count and total time spent in the database for this trace.

**N+1 warning banner** — appears in yellow if any database query pattern fires 3 or more times in the same trace. The pattern is shown with dynamic values replaced by `?` (numbers, UUIDs, and quoted strings are normalised). Example:

```
⚠ N+1 Query Detected
pg: SELECT * FROM products WHERE id = ?  — 47×
```

This indicates the same query was issued 47 times, typically caused by fetching related records in a loop. The fix is usually a JOIN or a batch query.

**Route sparkline** — a small line chart showing the response times for the last 10 completed requests to the same route. Includes a trend label:
- ↓ faster (green) — recent requests are >10% faster than earlier ones
- ↑ slower (red) — recent requests are >10% slower
- → stable (gray) — no significant trend

---

#### Tab 2: Request / Response

Shows the captured data from the HTTP conversation.

**Request section:**
- Headers table — all request headers as key/value pairs
- Body — the request body, pretty-printed if valid JSON. Shows `(none)` if no body was captured.

**Response section:**
- Headers table — response headers
- Body — the response body, pretty-printed if valid JSON

Both bodies are capped at **10 KB**. If a body was larger, a yellow "Truncated at 10 KB" notice appears below it.

> **Framework notes**: Body capture works for Express, Koa, and Fastify (response only). For Hono, only headers are captured. For frameworks without a body-parser, the request body will show `(none)` since the raw stream can only be consumed once.

---

#### Tab 3: Span Inspector

Default state: "Click a span in the waterfall to inspect it."

When you click a span in the waterfall, this tab activates and shows detailed information about that span. The content adapts to the span type:

**All spans:**
- Name, type, status, duration, start offset within the trace

**`http-outgoing` spans:**
- Full URL (protocol + host + path)
- HTTP method, response status code
- **Outgoing Request** section — captured request headers and body
- **Response** section — captured response headers and body (up to 10 KB, truncation notice if cut)

**`db` spans:**
- Full untruncated query text
- Database type (postgres, mongodb, redis, mysql)
- Command name (for Redis)

**`function` spans** (created by `@TraceThis` / `traced`):
- All custom attributes passed via the `attributes` option
- **`argument`** / **`arg[0]`**, **`arg[1]`**, … — call arguments, JSON-serialized (up to 1 000 chars each)
- **`return value`** — return value, JSON-serialized; absent for void returns and on error

**`function` spans** (created by `traceIt`):
- All custom attributes
- **`return value`** — return value, JSON-serialized; absent for void returns and on error
- *(arguments not shown — they are embedded in the closure passed to `traceIt`)*

**Error spans:**
- Error message, styled in red

The selected span row in the waterfall is highlighted with a blue outline.

---

#### Waterfall

Below the tabs, the waterfall renders all spans as proportional horizontal bars. Each bar starts at the span's actual start offset within the trace and has width proportional to the span's duration.

**Span colours:**
- Gray — `http-incoming` (the root request span)
- Blue — `http-outgoing`
- Purple — `db`
- Green — `function`
- Red — any span in `error` status

**Depth / nesting** — child spans are indented 14 px per level under their parent.

**Running spans** — spans that haven't finished yet show an animated shimmer.

Click any span row to inspect it in Tab 3.

---

## 10. Data model

Understanding the data types helps when writing custom tooling or reading the `/api/traces` endpoint directly.

### Trace

```ts
interface Trace {
  id: string;                  // UUID
  route: string;               // URL path, e.g. "/api/orders"
  method: string;              // HTTP method, e.g. "GET"
  statusCode?: number;         // HTTP response status code (set when response finishes)
  startTime: number;           // Unix timestamp ms (Date.now())
  duration?: number;           // Total ms (set when response finishes)
  status: 'running' | 'ok' | 'error';
  spans: Span[];

  request?: {
    headers: Record<string, string>;
    body?: string;             // Up to 10 KB of request body
    bodyTruncated?: boolean;   // true if body was cut at 10 KB
  };
  response?: {
    headers: Record<string, string>;
    body?: string;             // Up to 10 KB of response body
    bodyTruncated?: boolean;
  };
}
```

`status` is `'error'` if the response status code is >= 500; `'ok'` for everything else; `'running'` while the request is still in flight.

### Span

```ts
interface Span {
  id: string;                  // UUID
  traceId: string;             // ID of the parent Trace
  parentId?: string;           // ID of the parent Span (undefined for the root span)
  name: string;                // Display name, e.g. "GET api.stripe.com/v1/charges"
  startTime: number;           // Unix timestamp ms
  endTime?: number;            // Set when span finishes
  duration?: number;           // ms (set when span finishes)
  status: 'running' | 'ok' | 'error';
  error?: string;              // Error message if status is 'error'
  type: 'http-incoming' | 'http-outgoing' | 'db' | 'function';
  attributes: Record<string, string | number | boolean>;

  // function spans only
  args?: string[];             // Call arguments serialized as JSON (traced / @TraceThis only)
  returnValue?: string;        // Return value serialized as JSON; absent for void / error

  // http-outgoing spans only
  request?: {
    headers: Record<string, string>;
    body?: string;             // Up to 10 KB of request body
    bodyTruncated?: boolean;
  };
  response?: {
    headers: Record<string, string>;
    body?: string;             // Up to 10 KB of response body
    bodyTruncated?: boolean;
  };
}
```

### API endpoints

```
GET /api/traces                          → Trace[]  (newest first, up to maxTraces)
GET /api/traces/:id/summary              → { external: ExternalDependency[], db: DbSummary }
GET /api/routes/:encodedRoute/history    → RouteHistory
GET /api/stream                          → SSE stream, emits 'trace-updated' events
```

The summary endpoint computes aggregations at query time (not stored), so it always reflects the current span data.

For `/api/routes/:encodedRoute/history`, URL-encode the route. For example, route `/api/orders` becomes `/api/routes/%2Fapi%2Forders/history`.

---

## 11. Common patterns

### Service layer

The most common pattern: decorate service methods with `@TraceThis()` and let auto-patching handle database and outgoing HTTP calls.

```ts
// src/services/order.service.ts
import { TraceThis } from 'tracethis';

@Injectable()
export class OrderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly emailer: EmailService,
  ) {}

  @TraceThis()
  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const order = await this.db.orders.create(dto);       // db span auto-created
    await this.notifyUser(order);
    return order;
  }

  @TraceThis()
  private async notifyUser(order: Order): Promise<void> {
    await this.emailer.send(order.userEmail, 'Order confirmed'); // http-outgoing auto-created
  }
}
```

### Repository pattern

```ts
import { TraceThis } from 'tracethis';

class UserRepository {
  @TraceThis()
  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query(
      'SELECT * FROM users WHERE id = $1', [id]
    ); // pg span auto-created inside this call
    return result.rows[0] ?? null;
  }

  @TraceThis()
  async findByEmail(email: string): Promise<User | null> {
    const result = await this.pool.query(
      'SELECT * FROM users WHERE email = $1', [email]
    );
    return result.rows[0] ?? null;
  }
}
```

### Tracing a standalone utility function

```ts
import { traceIt } from 'tracethis';
import { parseCSV } from './csv-parser';

export async function importProducts(fileBuffer: Buffer) {
  const rows = await traceIt('parse-csv', () => parseCSV(fileBuffer));

  const products = await traceIt(
    { name: 'transform-rows', attributes: { count: rows.length } },
    () => rows.map(transformRow),
  );

  for (const batch of chunk(products, 100)) {
    await traceIt('insert-batch', () => db.products.insertMany(batch));
  }
}
```

### Tracing third-party code

Use `traced()` when you want all callers covered automatically, or `traceIt()` to wrap one specific call:

```ts
import { traced, traceIt } from 'tracethis';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!);

// traced() — wrap once, every call is automatically traced
export const createPaymentIntent = traced(
  { name: 'stripe-charge', attributes: { currency: 'usd' } },
  (amount: number, customerId: string) =>
    stripe.paymentIntents.create({ amount, currency: 'usd', customer: customerId }),
);

// traceIt() — trace one specific call site
async function chargeCustomer(customerId: string, amount: number) {
  return traceIt(
    { name: 'stripe-charge', attributes: { amount, currency: 'usd' } },
    () => stripe.paymentIntents.create({ amount, currency: 'usd', customer: customerId }),
  );
}
```

### Dynamic attributes

Attach request-specific data to spans for easier debugging:

```ts
@TraceThis({ name: 'process-payment', attributes: { gateway: 'stripe' } })
async processPayment(invoice: Invoice) { ... }
```

For truly dynamic values (e.g. the invoice ID), use `traceIt` at the call site:

```ts
const result = await traceIt(
  { name: 'process-payment', attributes: { invoiceId: invoice.id, amount: invoice.total } },
  () => paymentService.process(invoice),
);
```

### Parallel with independent spans

```ts
const [userProfile, orderHistory, recommendations] = await traceIt(
  'load-dashboard-data',
  () => Promise.all([
    traceIt('load-profile',         () => users.getProfile(userId)),
    traceIt('load-order-history',   () => orders.getHistory(userId)),
    traceIt('load-recommendations', () => ml.getRecommendations(userId)),
  ]),
);
```

The three inner spans will overlap in the waterfall, showing that they ran in parallel.

### Express with router

```ts
// app.ts
import express from 'express';
import { init, traceMiddleware } from 'tracethis';
import { ordersRouter } from './routes/orders';

init();

const app = express();
app.use(express.json());
app.use(traceMiddleware);      // ← apply once here, covers all routes
app.use('/api/orders', ordersRouter);

// routes/orders.ts — no tracethis imports needed here
import { Router } from 'express';
import { OrderService } from '../services/order.service';

export const ordersRouter = Router();
const service = new OrderService();

ordersRouter.post('/', async (req, res) => {
  const order = await service.createOrder(req.body); // @TraceThis on service handles spans
  res.status(201).json(order);
});
```

### Error tracing

tracethis records errors automatically — no extra code needed. But you can inspect them in the UI:

- **Red span** in the waterfall = that operation failed
- **Span Inspector tab** shows the error message when you click the red span
- **Trace status = error** (root trace turns red) when the response status is 5xx

```ts
@TraceThis()
async processRefund(orderId: string) {
  const order = await this.findOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  // ↑ span marked error, error message stored, re-thrown to caller
}
```

---

## 12. TypeScript setup

### experimentalDecorators

Required only if you use `@TraceThis`. `traceIt` and `traced` work without it.

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "experimentalDecorators": true,
    "strict": true
  }
}
```

### ESM / `"type": "module"` projects

tracethis ships both CJS (`dist/cjs/`) and ESM (`dist/esm/`) builds. Package managers and bundlers resolve the correct build automatically via the `exports` field in `package.json`.

### Import styles

```ts
// TypeScript / ESM
import { init, traceMiddleware, TraceThis, traceIt, traced } from 'tracethis';

// CommonJS
const { init, traceMiddleware, TraceThis, traceIt, traced } = require('tracethis');

// watchThis is still available as a deprecated alias for traceIt
import { watchThis } from 'tracethis';
```

### Type exports

All public types are re-exported from the package root:

```ts
import type { Span, Trace, InitOptions, TraceThisOptions, TraceItOptions } from 'tracethis';

// WatchThisOptions is kept as a deprecated alias for TraceItOptions
import type { WatchThisOptions } from 'tracethis';
```

---

## 13. Troubleshooting

### Spans are not appearing in the waterfall

**Most likely cause**: `init()` was not called before the module that makes http/db calls was first imported.

```ts
// WRONG — pg is imported before init() runs
import { Pool } from 'pg';
import { init } from 'tracethis';
init();

// CORRECT — init() patches pg before it is used
import { init } from 'tracethis';
init();
import { Pool } from 'pg'; // or dynamically require('pg')
```

If reordering imports is not practical, call `init()` in your entry point before any other application code.

---

### Spans are created but not linked to the trace (appear at root level or are missing)

**Cause**: An `await new Promise(resolve => ...)` boundary is breaking the `AsyncLocalStorage` context chain.

See [Plain Node.js http server](#46-plain-nodejs-http-server) for the correct pattern. The same issue can appear in any code that manually bridges callbacks with Promises:

```ts
// BREAKS context — the resolved callback runs in the wrong async context
await new Promise(resolve => someCallbackFn(args, resolve));

// PRESERVES context — promisify before the call, or use util.promisify
import { promisify } from 'util';
const someCallbackFnAsync = promisify(someCallbackFn);
await someCallbackFnAsync(args);
```

---

### @TraceThis spans are missing but traceIt/traced works

**Cause**: `experimentalDecorators` is not enabled in `tsconfig.json`.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}
```

---

### Request body shows "(none)" in the Request/Response tab

This is expected in the following cases:
- The request has no body (GET, DELETE, HEAD)
- Your framework's body-parser has not run before `traceMiddleware`
- You are using Hono (body capture not supported due to the Web Streams model)
- You are using Fastify (body is parsed asynchronously after `onRequest`)

For Express, ensure `express.json()` or `express.urlencoded()` is registered **before** `traceMiddleware`.

---

### The UI shows "connecting" and never updates

The UI uses SSE (`/api/stream`) to receive live updates. Check:
1. The tracethis server is running on the expected port (`http://localhost:4321`)
2. Nothing else is listening on that port (`lsof -i :4321`)
3. `init()` was called and did not print a production warning

---

### Traces disappear after a server restart

This is by design. tracethis keeps traces in memory only. There is no persistence layer. All traces are lost when the server process restarts.

---

### The N+1 warning fires but I am using batching

The detection is purely count-based: if the same normalised query pattern appears 3 or more times in a single trace, the warning fires. If you are correctly using batch queries but the normalisation matches them as the same pattern, you can ignore the warning — it is advisory only.

---

### Only request headers are captured for Hono, no body

This is a known limitation. Hono responses use the Web Streams `ReadableStream` API. Reading the stream to capture the body would consume it, breaking the actual response. tracethis skips body capture for Hono and captures headers only.

---

### Multiple init() calls in tests

Each test suite that calls `init()` will trigger the second-call guard and the server will already be running (or failing with `EADDRINUSE` if the previous test's server did not shut down). Avoid calling `init()` in tests. If you need to test traced behaviour, import the `collector` directly and assert on its state:

```ts
import { collector } from 'tracethis/src/collector'; // internal import for tests only
import { runWithContext } from 'tracethis/src/context';

beforeEach(() => collector.clear());
```
