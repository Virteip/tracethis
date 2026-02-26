# tracethis

> Local request tracing for Node.js/TypeScript. See exactly where time goes inside your HTTP requests — without Docker, cloud services, or config files.

**⚠️ Development only** — `tracethis` is a `devDependency`. It detects `NODE_ENV=production` and exits immediately without patching anything.

---

## Install

```bash
npm install --save-dev tracethis
```

---

## Quick start

```ts
// src/index.ts  (top of your entry file, before everything else)
import { init, traceMiddleware, TraceThis, watchThis } from 'tracethis';

init(); // starts the UI server on http://localhost:4321
```

### Express

```ts
import express from 'express';
import { init, traceMiddleware, TraceThis, watchThis } from 'tracethis';

init();

const app = express();
app.use(traceMiddleware); // creates a root span for every request

app.get('/orders/:id', async (req, res) => {
  const order = await orderService.process(req.params.id);
  res.json(order);
});
```

### @TraceThis decorator (class methods)

```ts
import { TraceThis } from 'tracethis';

class OrderService {
  @TraceThis()
  async processOrder(orderId: string) {
    // automatically timed as a child span
  }

  @TraceThis({ name: 'pricing-calculation', attributes: { layer: 'service' } })
  async calculatePricing(cart: Cart) {
    // custom span name and attributes
  }
}
```

### watchThis() utility (any function)

```ts
import { watchThis } from 'tracethis';

// basic — name as first arg
const result = await watchThis('calculatePricing', () => calculatePricing(cart));

// with attributes
const result = await watchThis(
  { name: 'calculatePricing', attributes: { layer: 'service' } },
  () => calculatePricing(cart),
);
```

Both sync and async functions are fully supported. TypeScript infers the return type automatically — no casting needed.

---

## Configuration

```ts
init({
  port: 4321,       // UI server port (default: 4321)
  maxTraces: 100,   // how many traces to keep in memory (default: 100)
});
```

---

## Framework support

| Framework | How to use |
|---|---|
| **Express** | `app.use(traceMiddleware)` |
| **Fastify** | `fastify.addHook('onRequest', traceMiddleware)` |
| **Koa** | `app.use(traceMiddleware)` |
| **Hono** | `app.use('*', traceMiddleware)` |
| **NestJS** | `@UseInterceptors(TraceInterceptor)` |

---

## Auto-instrumented libraries

The following are patched automatically when installed — no extra setup needed:

| Library | Span type |
|---|---|
| `http` / `https` (covers axios, got, superagent) | `http-outgoing` |
| `fetch` (Node 18+ native) | `http-outgoing` |
| `pg` (node-postgres) | `db` |
| `mongoose` | `db` |
| `ioredis` | `db` |
| `redis` (node-redis v4) | `db` |
| `mysql2` | `db` |

---

## UI

Open **[http://localhost:4321](http://localhost:4321)** after starting your server.

```
┌─────────────────────────────────────────────────────────────┐
│  tracethis                                   ● live  clear  │
├──────────────────┬──────────────────────────────────────────┤
│ Traces        3  │  POST /api/orders  201  42ms             │
│                  │  ─────────────────────────────────────── │
│ ● POST /orders   │  Span                  Timeline          │
│   201  42ms      │  ─────────────────────────────────────── │
│                  │  ▓ POST /api/orders    ████████████████  │
│ ● GET /products  │    ↳ processOrder      ███████           │
│   200  12ms      │    ↳ pricing-calc        ████            │
│                  │      ↳ pg: SELECT…         ██            │
│ ● GET /health    │    ↳ fetch POST stripe       ████        │
│   200  2ms       │                                          │
└──────────────────┴──────────────────────────────────────────┘
```

- **Left panel**: recent traces, color-coded green/yellow/red by duration
- **Right panel**: waterfall timeline — each span is a proportional bar
- **Click any span** to see its attributes, error message, and exact timing
- Updates in **real time** via SSE — no page refresh needed

---

## How it works

1. `init()` monkey-patches `http`, `https`, `fetch`, and any installed DB clients
2. `traceMiddleware` wraps each incoming request in a root span using `AsyncLocalStorage`
3. Every outgoing call or DB query within that request automatically creates a child span
4. `@TraceThis` / `watchThis()` let you add manual spans to any function
5. The UI server streams updates to the browser via Server-Sent Events

---

## Non-goals

- No production use — silently disabled when `NODE_ENV=production`
- No OpenTelemetry, Jaeger, or Zipkin — fully standalone
- No persistence — list clears on server restart
- No distributed tracing — single service only
- No automatic function discovery — use `@TraceThis` or `watchThis()` explicitly

---

## License

MIT
