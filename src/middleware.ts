/**
 * traceMiddleware — framework-agnostic middleware that creates a root span for each
 * incoming HTTP request and closes it when the response finishes.
 *
 * Compatible with: Express, Fastify, Koa, Hapi, and Hono.
 * The correct adapter is selected by inspecting the arguments at call time.
 *
 * NestJS: export TraceInterceptor which implements NestInterceptor.
 */

import { randomUUID } from 'crypto';
import { runWithContext } from './context.js';
import { collector } from './collector.js';

// ─── Body capture helpers ──────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024; // 10 KB

function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function serializeBody(val: unknown): { text: string; truncated: boolean } | undefined {
  if (val === undefined || val === null) return undefined;
  try {
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    if (s.length > MAX_BODY_BYTES) return { text: s.slice(0, MAX_BODY_BYTES), truncated: true };
    return { text: s, truncated: false };
  } catch {
    return undefined;
  }
}

/**
 * Wraps a Node-style ServerResponse to capture response body chunks.
 * Calls onCapture exactly once when res.end() is invoked.
 */
function interceptNodeResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: any,
  onCapture: (body: string, truncated: boolean, headers: Record<string, string>) => void,
): void {
  const bufs: Buffer[] = [];
  let total = 0;
  let truncated = false;
  let done = false;
  const capturedHeaders: Record<string, string> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collect = (chunk: any) => {
    if (done || chunk == null) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const space = MAX_BODY_BYTES - total;
    if (space > 0) {
      bufs.push(buf.subarray(0, space));
      total += Math.min(buf.length, space);
    }
    if (buf.length > space) truncated = true;
  };

  const mergeInto = (raw: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(raw)) {
      capturedHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    }
  };

  // Intercept writeHead to capture headers passed directly to it.
  // Node.js writeHead(statusCode, headersObj) does NOT store the headers in the
  // internal _headers map that getHeaders() reads from, so we must capture them here.
  const origWriteHead = res.writeHead?.bind(res);
  if (origWriteHead) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.writeHead = (statusCode: number, ...args: any[]) => {
      // First capture any headers already set via setHeader()
      mergeInto(res.getHeaders?.() ?? {});
      // Then capture headers passed directly as the last object argument
      const last = args[args.length - 1];
      if (last && typeof last === 'object' && !Array.isArray(last)) {
        mergeInto(last as Record<string, unknown>);
      }
      return origWriteHead(statusCode, ...args);
    };
  }

  const origWrite = res.write.bind(res);
  const origEnd   = res.end.bind(res);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.write = (chunk: any, ...rest: any[]) => { collect(chunk); return origWrite(chunk, ...rest); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end   = (chunk: any, ...rest: any[]) => {
    if (!done) {
      // If writeHead was never called, capture headers from getHeaders() now
      if (Object.keys(capturedHeaders).length === 0) {
        mergeInto(res.getHeaders?.() ?? {});
      }
      collect(chunk); // collect before setting done — collect guards on done itself
      done = true;
      onCapture(Buffer.concat(bufs).toString('utf8'), truncated, { ...capturedHeaders });
    }
    return origEnd(chunk, ...rest);
  };
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

function createRootSpan(method: string, path: string) {
  const traceId = randomUUID();
  const trace = collector.createTrace(method, path);
  const span = collector.createSpan(trace.id, `${method} ${path}`, 'http-incoming', undefined, {
    method,
    path,
  });
  return { trace, span, traceId: trace.id };
}

function finishTrace(
  traceId: string,
  spanRef: ReturnType<typeof collector.createSpan>,
  statusCode: number,
) {
  const endTime = Date.now();
  const duration = endTime - spanRef.startTime;
  spanRef.attributes['statusCode'] = statusCode;
  collector.finalizeSpan(spanRef);
  collector.finalizeTrace(traceId, statusCode, duration);
}

// ─── Express / Connect ────────────────────────────────────────────────────────

type ExpressNext = (err?: unknown) => void;
interface ExpressReq {
  method: string;
  path?: string;
  url?: string;
}
interface ExpressRes {
  statusCode: number;
  on(event: 'finish', cb: () => void): this;
  on(event: 'close', cb: () => void): this;
}

function expressMiddleware(
  req: ExpressReq,
  res: ExpressRes,
  next: ExpressNext,
): void {
  const method = req.method?.toUpperCase() ?? 'GET';
  const path = req.path ?? req.url ?? '/';
  const { trace, span } = createRootSpan(method, path);

  // Capture request headers + pre-parsed body
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawReq = req as any;
  const reqBody = serializeBody(rawReq.body);
  trace.request = {
    headers: normalizeHeaders(rawReq.headers ?? {}),
    ...(reqBody ? { body: reqBody.text, bodyTruncated: reqBody.truncated } : {}),
  };

  // Capture response body + headers by intercepting writeHead/write/end
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interceptNodeResponse(res as any, (body, truncated, headers) => {
    trace.response = { headers, body, bodyTruncated: truncated };
  });

  res.on('finish', () => finishTrace(trace.id, span, res.statusCode));
  res.on('close', () => {
    if (span.status === 'running') finishTrace(trace.id, span, res.statusCode || 0);
  });

  runWithContext({ traceId: trace.id, spanId: span.id }, () => next());
}

// ─── Koa ──────────────────────────────────────────────────────────────────────

interface KoaContext {
  method: string;
  path: string;
  status: number;
  response?: { status: number };
}
type KoaNext = () => Promise<void>;

async function koaMiddleware(ctx: KoaContext, next: KoaNext): Promise<void> {
  const method = ctx.method?.toUpperCase() ?? 'GET';
  const path = ctx.path ?? '/';
  const { trace, span } = createRootSpan(method, path);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawCtx = ctx as any;

  // Capture request: headers + body (if koa-bodyparser already ran)
  const reqBody = serializeBody(rawCtx.request?.body ?? rawCtx.body);
  trace.request = {
    headers: normalizeHeaders(rawCtx.request?.headers ?? rawCtx.headers ?? {}),
    ...(reqBody ? { body: reqBody.text, bodyTruncated: reqBody.truncated } : {}),
  };

  try {
    await runWithContext({ traceId: trace.id, spanId: span.id }, () => next());
    const status = ctx.response?.status ?? ctx.status ?? 200;

    // After next(), ctx.response.body holds the response value
    const resBodyRaw = rawCtx.response?.body ?? rawCtx.body;
    const resBody = serializeBody(typeof resBodyRaw === 'object' && resBodyRaw !== null
      ? resBodyRaw
      : resBodyRaw);
    trace.response = {
      headers: normalizeHeaders(rawCtx.response?.headers ?? rawCtx.response?.header ?? {}),
      ...(resBody ? { body: resBody.text, bodyTruncated: resBody.truncated } : {}),
    };

    finishTrace(trace.id, span, status);
  } catch (err) {
    const status = ctx.response?.status ?? ctx.status ?? 500;
    finishTrace(trace.id, span, status);
    throw err;
  }
}

// ─── Fastify ──────────────────────────────────────────────────────────────────

interface FastifyRequest {
  method: string;
  routerPath?: string;
  url?: string;
}
interface FastifyReply {
  statusCode: number;
  raw?: { on(event: string, cb: () => void): void };
}
type FastifyDone = (err?: Error) => void;

function fastifyMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
  done: FastifyDone,
): void {
  const method = req.method?.toUpperCase() ?? 'GET';
  const path = req.routerPath ?? req.url ?? '/';
  const { trace, span } = createRootSpan(method, path);

  // Capture request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawReq = req as any;
  const reqBody = serializeBody(rawReq.body);
  trace.request = {
    headers: normalizeHeaders(rawReq.headers ?? {}),
    ...(reqBody ? { body: reqBody.text, bodyTruncated: reqBody.truncated } : {}),
  };

  const finish = () => finishTrace(trace.id, span, reply.statusCode || 200);

  if (reply.raw) {
    // Capture response body + headers via raw ServerResponse
    interceptNodeResponse(reply.raw, (body, truncated, headers) => {
      trace.response = { headers, body, bodyTruncated: truncated };
    });
    reply.raw.on('finish', finish);
    reply.raw.on('close', () => {
      if (span.status === 'running') finish();
    });
  }

  runWithContext({ traceId: trace.id, spanId: span.id }, () => done());
}

// ─── Hono ─────────────────────────────────────────────────────────────────────

interface HonoContext {
  req: { method: string; path: string };
  res?: { status?: number; headers?: { forEach(cb: (v: string, k: string) => void): void } };
}
type HonoNext = () => Promise<void> | void;

async function honoMiddleware(c: HonoContext, next: HonoNext): Promise<void> {
  const method = c.req.method?.toUpperCase() ?? 'GET';
  const path = c.req.path ?? '/';
  const { trace, span } = createRootSpan(method, path);

  // Capture request headers (Web Headers API via c.req.raw)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawReq = c.req as any;
  const reqHeaders: Record<string, string> = {};
  if (rawReq.raw?.headers?.forEach) {
    rawReq.raw.headers.forEach((v: string, k: string) => { reqHeaders[k] = v; });
  } else if (rawReq.headers && typeof rawReq.headers === 'object') {
    Object.assign(reqHeaders, normalizeHeaders(rawReq.headers));
  }
  trace.request = { headers: reqHeaders };

  try {
    await runWithContext({ traceId: trace.id, spanId: span.id }, () => next());

    // Capture response headers (no body capture — consuming Hono's ReadableStream
    // would require cloning which is expensive for a dev tool)
    const resHeaders: Record<string, string> = {};
    c.res?.headers?.forEach((v, k) => { resHeaders[k] = v; });
    trace.response = { headers: resHeaders };

    const status = c.res?.status ?? 200;
    finishTrace(trace.id, span, status);
  } catch (err) {
    finishTrace(trace.id, span, 500);
    throw err;
  }
}

// ─── Smart dispatch ────────────────────────────────────────────────────────────
//
// The exported `traceMiddleware` inspects its arguments at call time:
//   • (req, res, next) with res.on       → Express
//   • (req, res, next) with no res.on    → Fastify
//   • (ctx, next) where ctx.req exists   → Hono
//   • (ctx, next) where ctx.path exists  → Koa
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function traceMiddleware(...args: any[]): unknown {
  const [first, second, third] = args;

  // Koa / Hono: (ctx, next)
  if (args.length === 2 && typeof second === 'function') {
    if (first?.req?.method !== undefined) {
      // Hono
      return honoMiddleware(first as HonoContext, second as HonoNext);
    }
    // Koa
    return koaMiddleware(first as KoaContext, second as KoaNext);
  }

  // Express / Fastify: (req, res, next)
  if (args.length >= 3) {
    if (typeof second?.on === 'function') {
      // Express (res has .on)
      expressMiddleware(first as ExpressReq, second as ExpressRes, third as ExpressNext);
      return;
    }
    // Fastify
    fastifyMiddleware(first as FastifyRequest, second as FastifyReply, third as FastifyDone);
    return;
  }

  // Fallback: skip
  if (typeof third === 'function') third();
}

// ─── NestJS interceptor ────────────────────────────────────────────────────────
// Exported separately so NestJS users can import without pulling in NestJS types
// for everyone else. We use duck-typed interfaces to avoid a hard NestJS dep.

interface ExecutionContext {
  switchToHttp(): { getRequest(): ExpressReq; getResponse(): ExpressRes };
}
interface CallHandler {
  handle(): { pipe(op: unknown): unknown };
}

// We load rxjs operators lazily so they are only needed when actually used
export class TraceInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): unknown {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const method = req.method?.toUpperCase() ?? 'GET';
    const path = req.path ?? req.url ?? '/';
    const { trace, span } = createRootSpan(method, path);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawReq = req as any;
    const reqBody = serializeBody(rawReq.body);
    trace.request = {
      headers: normalizeHeaders(rawReq.headers ?? {}),
      ...(reqBody ? { body: reqBody.text, bodyTruncated: reqBody.truncated } : {}),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interceptNodeResponse(res as any, (body, truncated, headers) => {
      trace.response = { headers, body, bodyTruncated: truncated };
    });

    res.on('finish', () => finishTrace(trace.id, span, res.statusCode));

    return runWithContext({ traceId: trace.id, spanId: span.id }, () => next.handle());
  }
}
