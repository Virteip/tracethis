/**
 * Lazy monkey-patches for:
 *   - http.ClientRequest / https.ClientRequest prototype (covers axios, got,
 *     superagent, node-fetch v2 — anything that ultimately creates a ClientRequest)
 *   - globalThis.fetch               (Node 18+ native fetch / undici)
 *   - pg                             (node-postgres)
 *   - mongoose                       (Query.prototype.exec)
 *   - ioredis / redis                (sendCommand)
 *   - mysql2                         (Connection.prototype.execute)
 *
 * Each patch is applied at most once (guarded by a _tracethis_patched flag).
 * If a module is not installed the patch silently no-ops.
 *
 * NOTE: In Node 20+, http.request is a non-configurable, non-writable getter
 * so we cannot replace it directly. We patch ClientRequest.prototype.end()
 * instead — this intercepts every outgoing request at the moment it is sent,
 * with the same AsyncLocalStorage context as the call site.
 */

import * as http from 'http';
import * as https from 'https';
import { getContext, childContext, runWithContext } from './context.js';
import { collector } from './collector.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024; // 10 KB

function normaliseHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function collectBody(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

function tryRequire(id: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(id);
  } catch {
    return null;
  }
}

// ─── http / https ─────────────────────────────────────────────────────────────
// Both http and https share the same http.ClientRequest class at runtime,
// so a single prototype patch covers all outgoing TCP/TLS requests.

function patchClientRequest(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = http.ClientRequest.prototype as any;
  if (proto._tracethis_patched) return;

  const originalEnd = proto.end as Function;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.end = function (this: http.ClientRequest, ...args: any[]) {
    const ctx = getContext();
    if (!ctx) return originalEnd.apply(this, args);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    const host     = (self.host ?? self.hostname ?? 'unknown') as string;
    const path     = (self.path ?? '/') as string;
    const method   = ((self.method ?? 'GET') as string).toUpperCase();
    // Detect protocol from the agent (https.Agent sets protocol to 'https:')
    const protocol = ((self._defaultAgent?.protocol ?? self.agent?.protocol ?? 'http:') as string).replace(':', '');

    const span = collector.createSpan(
      ctx.traceId,
      `${method} ${host}${path}`,
      'http-outgoing',
      ctx.spanId,
      { host, path, method, protocol },
    );

    // Capture outgoing request headers
    try {
      span.request = { headers: normaliseHeaders(this.getHeaders() as Record<string, string | string[] | undefined>) };
    } catch { /* ignore */ }

    // Capture request body — the chunk passed directly to end() covers the
    // common single-shot case (e.g. JSON POST bodies sent via end(body))
    const endChunk = args[0];
    if (endChunk != null && endChunk !== '') {
      try {
        const buf = Buffer.isBuffer(endChunk) ? endChunk : Buffer.from(String(endChunk));
        if (span.request) span.request.body = buf.slice(0, MAX_BODY_BYTES).toString('utf8');
      } catch { /* ignore */ }
    }

    let finalized = false;
    const fail = (err: Error) => { if (!finalized) { finalized = true; collector.finalizeSpan(span, err.message); } };

    this.once('response', (res: http.IncomingMessage) => {
      span.attributes['statusCode'] = res.statusCode ?? 0;

      // Capture response headers
      const resHeaders = normaliseHeaders(res.headers as Record<string, string | string[] | undefined>);

      // Capture response body — listening to 'data' also puts the stream in
      // flowing mode, so res.resume() is no longer needed
      const bufs: Buffer[] = [];
      let bodyTotal = 0;
      let bodyTruncated = false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.on('data', (chunk: any) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const space = MAX_BODY_BYTES - bodyTotal;
        if (space > 0) {
          bufs.push(buf.subarray(0, space));
          bodyTotal += Math.min(buf.length, space);
        }
        if (buf.length > space) bodyTruncated = true;
      });

      res.on('end', () => {
        span.response = {
          headers: resHeaders,
          body: collectBody(bufs),
          bodyTruncated,
        };
        if (!finalized) { finalized = true; collector.finalizeSpan(span); }
      });
      res.on('error', fail);
    });
    this.once('error', fail);

    return originalEnd.apply(this, args);
  };

  proto._tracethis_patched = true;
}

// ─── native fetch ─────────────────────────────────────────────────────────────

function patchFetch(): void {
  const g = globalThis as { fetch?: typeof fetch & { _tracethis_patched?: boolean } };
  if (!g.fetch || g.fetch._tracethis_patched) return;

  const originalFetch = g.fetch;

  const patchedFetch: typeof fetch = async function (input, init) {
    const ctx = getContext();
    if (!ctx) return originalFetch(input, init);

    let url = 'unknown';
    try {
      url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    } catch { /* ignore */ }

    let host = url;
    let path = '';
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch { /* relative URL */ }

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    const span = collector.createSpan(
      ctx.traceId,
      `fetch ${method} ${host}${path}`,
      'http-outgoing',
      ctx.spanId,
      { host, path, method },
    );
    const childCtx = childContext(ctx, span.id);

    // Capture outgoing request headers
    try {
      const reqHeaders: Record<string, string> = {};
      const h = init?.headers ?? (input instanceof Request ? input.headers : undefined);
      if (h instanceof Headers) {
        h.forEach((v, k) => { reqHeaders[k] = v; });
      } else if (h && typeof h === 'object') {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          reqHeaders[k.toLowerCase()] = v;
        }
      }
      span.request = { headers: reqHeaders };
    } catch { /* ignore */ }

    // Capture request body (string and URLSearchParams only; skip Blob/stream)
    try {
      const rawBody = init?.body;
      if (typeof rawBody === 'string' && rawBody) {
        if (span.request) span.request.body = rawBody.slice(0, MAX_BODY_BYTES);
      } else if (rawBody instanceof URLSearchParams) {
        if (span.request) span.request.body = rawBody.toString().slice(0, MAX_BODY_BYTES);
      }
    } catch { /* ignore */ }

    try {
      let res!: Response;
      await runWithContext(childCtx, async () => {
        res = await originalFetch(input, init);
      });
      span.attributes['statusCode'] = res.status;

      // Capture response headers
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });

      // Capture response body by cloning — the original Response is returned
      // untouched so the caller can still read it normally
      let resBodyText = '';
      let resBodyTruncated = false;
      try {
        const text = await res.clone().text();
        if (text.length > MAX_BODY_BYTES) {
          resBodyText = text.slice(0, MAX_BODY_BYTES);
          resBodyTruncated = true;
        } else {
          resBodyText = text;
        }
      } catch { /* ignore */ }

      span.response = { headers: resHeaders, body: resBodyText, bodyTruncated: resBodyTruncated };
      collector.finalizeSpan(span);
      return res;
    } catch (err) {
      collector.finalizeSpan(span, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  (patchedFetch as unknown as { _tracethis_patched: boolean })._tracethis_patched = true;
  g.fetch = patchedFetch;
}

// ─── pg ───────────────────────────────────────────────────────────────────────

function patchPg(): void {
  const pg = tryRequire('pg') as { Client?: { prototype: { query: unknown } } } | null;
  if (!pg?.Client?.prototype) return;

  const proto = pg.Client.prototype as {
    query: Function;
    _tracethis_patched?: boolean;
  };
  if (proto._tracethis_patched) return;

  const originalQuery = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const ctx = getContext();
    if (!ctx) return originalQuery.apply(this, args);

    const queryText = typeof args[0] === 'string'
      ? args[0].slice(0, 120)
      : (args[0] as { text?: string })?.text?.slice(0, 120) ?? 'query';

    const span = collector.createSpan(
      ctx.traceId,
      `pg: ${queryText}`,
      'db',
      ctx.spanId,
      { db: 'postgres', query: queryText },
    );

    const result = originalQuery.apply(this, args);
    if (result && typeof result.then === 'function') {
      return result.then(
        (v: unknown) => { collector.finalizeSpan(span); return v; },
        (e: Error) => { collector.finalizeSpan(span, e.message); throw e; },
      );
    }
    // callback style — last arg is callback
    if (typeof args[args.length - 1] === 'function') {
      const cb = args[args.length - 1] as Function;
      args[args.length - 1] = (err: Error | null, ...rest: unknown[]) => {
        if (err) collector.finalizeSpan(span, err.message);
        else collector.finalizeSpan(span);
        cb(err, ...rest);
      };
    }
    return result;
  };

  proto._tracethis_patched = true;
}

// ─── mongoose ─────────────────────────────────────────────────────────────────

function patchMongoose(): void {
  const mongoose = tryRequire('mongoose') as {
    Query?: { prototype: { exec: Function; _tracethis_patched?: boolean; op?: string; model?: { modelName?: string } } }
  } | null;
  if (!mongoose?.Query?.prototype) return;

  const proto = mongoose.Query.prototype;
  if (proto._tracethis_patched) return;

  const originalExec = proto.exec;
  proto.exec = function (this: { op?: string; model?: { modelName?: string } }, ...args: unknown[]) {
    const ctx = getContext();
    if (!ctx) return originalExec.apply(this, args);

    const op = this.op ?? 'query';
    const model = this.model?.modelName ?? 'unknown';
    const span = collector.createSpan(
      ctx.traceId,
      `mongoose: ${op} ${model}`,
      'db',
      ctx.spanId,
      { db: 'mongodb', operation: op, model },
    );

    const result = originalExec.apply(this, args);
    if (result && typeof result.then === 'function') {
      return result.then(
        (v: unknown) => { collector.finalizeSpan(span); return v; },
        (e: Error) => { collector.finalizeSpan(span, e.message); throw e; },
      );
    }
    return result;
  };

  proto._tracethis_patched = true;
}

// ─── ioredis ──────────────────────────────────────────────────────────────────

function patchIoredis(): void {
  const ioredis = tryRequire('ioredis') as {
    default?: { prototype: { sendCommand: Function; _tracethis_patched?: boolean } };
    prototype?: { sendCommand: Function; _tracethis_patched?: boolean };
  } | null;
  if (!ioredis) return;

  const proto = (ioredis.default?.prototype ?? ioredis.prototype) as {
    sendCommand: Function;
    _tracethis_patched?: boolean;
  } | undefined;
  if (!proto || proto._tracethis_patched) return;

  const originalSend = proto.sendCommand;
  proto.sendCommand = function (this: unknown, command: { name?: string }, ...rest: unknown[]) {
    const ctx = getContext();
    if (!ctx) return originalSend.apply(this, [command, ...rest]);

    const name = command?.name ?? 'command';
    const span = collector.createSpan(
      ctx.traceId,
      `redis: ${name.toUpperCase()}`,
      'db',
      ctx.spanId,
      { db: 'redis', command: name },
    );

    const result = originalSend.apply(this, [command, ...rest]);
    if (result && typeof result.then === 'function') {
      return result.then(
        (v: unknown) => { collector.finalizeSpan(span); return v; },
        (e: Error) => { collector.finalizeSpan(span, e.message); throw e; },
      );
    }
    return result;
  };

  proto._tracethis_patched = true;
}

// ─── redis (node-redis v4) ────────────────────────────────────────────────────

function patchRedis(): void {
  const redis = tryRequire('redis') as {
    createClient?: Function & { _tracethis_patched?: boolean };
    commandOptions?: unknown;
  } | null;
  if (!redis?.createClient || (redis.createClient as { _tracethis_patched?: boolean })._tracethis_patched) return;

  const originalCreate = redis.createClient;
  redis.createClient = function (...args: unknown[]) {
    const client = originalCreate(...args) as {
      sendCommand?: Function & { _tracethis_patched?: boolean };
    };

    if (client?.sendCommand && !client.sendCommand._tracethis_patched) {
      const originalSend = client.sendCommand.bind(client);
      client.sendCommand = function (args2: string[], ...rest: unknown[]) {
        const ctx = getContext();
        if (!ctx) return originalSend(args2, ...rest);

        const cmd = Array.isArray(args2) ? args2[0] : 'command';
        const span = collector.createSpan(
          ctx.traceId,
          `redis: ${cmd?.toUpperCase() ?? 'COMMAND'}`,
          'db',
          ctx.spanId,
          { db: 'redis', command: cmd ?? '' },
        );

        const result = originalSend(args2, ...rest);
        if (result && typeof result.then === 'function') {
          return result.then(
            (v: unknown) => { collector.finalizeSpan(span); return v; },
            (e: Error) => { collector.finalizeSpan(span, e.message); throw e; },
          );
        }
        return result;
      };
      client.sendCommand._tracethis_patched = true;
    }

    return client;
  };
  (redis.createClient as { _tracethis_patched?: boolean })._tracethis_patched = true;
}

// ─── mysql2 ───────────────────────────────────────────────────────────────────

function patchMysql2(): void {
  const mysql2 = tryRequire('mysql2') as {
    Connection?: { prototype: { execute: Function; _tracethis_patched?: boolean } }
  } | null;
  if (!mysql2?.Connection?.prototype) return;

  const proto = mysql2.Connection.prototype;
  if (proto._tracethis_patched) return;

  const originalExecute = proto.execute;
  proto.execute = function (this: unknown, sql: string | { sql?: string }, ...rest: unknown[]) {
    const ctx = getContext();
    if (!ctx) return originalExecute.apply(this, [sql, ...rest]);

    const query = (typeof sql === 'string' ? sql : sql?.sql ?? 'query').slice(0, 120);
    const span = collector.createSpan(
      ctx.traceId,
      `mysql: ${query}`,
      'db',
      ctx.spanId,
      { db: 'mysql', query },
    );

    const result = originalExecute.apply(this, [sql, ...rest]);
    if (result && typeof result.then === 'function') {
      return result.then(
        (v: unknown) => { collector.finalizeSpan(span); return v; },
        (e: Error) => { collector.finalizeSpan(span, e.message); throw e; },
      );
    }
    // callback style
    const cbIndex = rest.findIndex(a => typeof a === 'function');
    if (cbIndex !== -1) {
      const cb = rest[cbIndex] as Function;
      rest[cbIndex] = (err: Error | null, ...cbRest: unknown[]) => {
        if (err) collector.finalizeSpan(span, err.message);
        else collector.finalizeSpan(span);
        cb(err, ...cbRest);
      };
    }
    return result;
  };

  proto._tracethis_patched = true;
}

// ─── public entry ─────────────────────────────────────────────────────────────

export function applyPatches(): void {
  patchClientRequest();
  patchFetch();
  patchPg();
  patchMongoose();
  patchIoredis();
  patchRedis();
  patchMysql2();
}
