import { applyPatches } from './patches.js';
import { startServer } from './server.js';
import { collector } from './collector.js';
import type { InitOptions } from './types.js';

let initialized = false;

/**
 * init() — call once at the top of your entry file.
 *
 * - In production (NODE_ENV === 'production') this is a silent no-op.
 * - Applies all monkey-patches (http, fetch, pg, mongoose, redis, mysql2).
 * - Starts the local UI server on the configured port (default 4321).
 */
export function init(options: InitOptions = {}): void {
  if (process.env.NODE_ENV === 'production') {
    console.warn('[tracethis] Running in production — tracing disabled.');
    return;
  }

  if (initialized) return;
  initialized = true;

  const port = options.port ?? 4321;
  const maxTraces = options.maxTraces ?? 100;

  collector.configure(maxTraces);
  applyPatches();
  startServer(port);
}
