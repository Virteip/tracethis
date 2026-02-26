/**
 * Local UI server — pure Node.js http module, zero external dependencies.
 *
 * Routes:
 *   GET /                           → serves ui/index.html
 *   GET /app.js                     → serves ui/app.js
 *   GET /styles.css                 → serves ui/styles.css
 *   GET /api/traces                 → JSON snapshot of all in-memory traces
 *   GET /api/traces/:id/summary     → ExternalDependencySummary + DbSummary for one trace
 *   GET /api/routes/:route/history  → RouteHistory for a route (route is URL-encoded)
 *   GET /api/stream                 → SSE stream, emits `trace-updated` events
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { collector } from './collector.js';
import { getExternalDependencySummary, getDbSummary, getRouteHistory } from './aggregations.js';
import type { Trace } from './types.js';

// Resolve the ui/ directory relative to this compiled file.
// __dirname works for CJS; for ESM we use import.meta.url (handled at build).
function getUiDir(): string {
  try {
    // CJS
    // eslint-disable-next-line no-undef
    return path.join(__dirname, '..', '..', 'ui');
  } catch {
    return path.join(process.cwd(), 'ui');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResponse(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function startServer(port: number): void {
  const uiDir = getUiDir();

  // SSE clients
  const clients = new Set<http.ServerResponse>();

  // Push to all SSE clients whenever a trace changes
  collector.on('trace:updated', (trace: Trace) => {
    const payload = `event: trace-updated\ndata: ${JSON.stringify(trace)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  });

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    setCorsHeaders(res);

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── SSE stream ───────────────────────────────────────────────────────────
    if (url === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
      });
      res.write('retry: 2000\n\n'); // auto-reconnect hint

      clients.add(res);

      // Send current snapshot immediately so the UI is populated on connect
      const snapshot = collector.getAllTraces();
      if (snapshot.length > 0) {
        const payload = snapshot
          .map(t => `event: trace-updated\ndata: ${JSON.stringify(t)}\n\n`)
          .join('');
        res.write(payload);
      }

      req.on('close', () => clients.delete(res));
      return;
    }

    // ── REST API ─────────────────────────────────────────────────────────────
    if (url === '/api/traces') {
      jsonResponse(res, collector.getAllTraces());
      return;
    }

    // GET /api/traces/:id/summary
    const traceSummaryMatch = url.match(/^\/api\/traces\/([^/]+)\/summary$/);
    if (traceSummaryMatch) {
      const trace = collector.getTrace(traceSummaryMatch[1]);
      if (!trace) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      jsonResponse(res, {
        external: getExternalDependencySummary(trace),
        db: getDbSummary(trace),
      });
      return;
    }

    // GET /api/routes/:route/history  (route param is URL-encoded, may contain %2F etc.)
    const routeHistoryMatch = url.match(/^\/api\/routes\/(.+)\/history$/);
    if (routeHistoryMatch) {
      let route: string;
      try {
        route = decodeURIComponent(routeHistoryMatch[1]);
      } catch {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      jsonResponse(res, getRouteHistory(collector.getAllTraces(), route));
      return;
    }

    // ── Static files ─────────────────────────────────────────────────────────
    if (url === '/' || url === '/index.html') {
      serveFile(res, path.join(uiDir, 'index.html'));
      return;
    }

    // Map /app.js → ui/app.js, /styles.css → ui/styles.css, etc.
    const safeName = path.basename(url); // strip any directory traversal
    const candidate = path.join(uiDir, safeName);
    // Ensure we stay inside uiDir
    if (candidate.startsWith(uiDir)) {
      serveFile(res, candidate);
    } else {
      res.writeHead(403);
      res.end('Forbidden');
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[tracethis] Port ${port} is already in use. UI server not started.`);
    } else {
      console.error('[tracethis] Server error:', err.message);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[tracethis] UI → http://localhost:${port}`);
  });
}
