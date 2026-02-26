import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContext {
  traceId: string;
  spanId: string;  // the currently-active span (parent for new child spans)
}

// Single global store — one context per async call chain
const storage = new AsyncLocalStorage<TraceContext>();

/** Read the currently active context (may be undefined outside a traced request) */
export function getContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Run a function inside a new context derived from the given values */
export function runWithContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Create a child context: same traceId, new active spanId */
export function childContext(parentCtx: TraceContext, newSpanId: string): TraceContext {
  return { traceId: parentCtx.traceId, spanId: newSpanId };
}
