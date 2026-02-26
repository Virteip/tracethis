// Public API surface for tracethis

export { init } from './init.js';
export { traceMiddleware, TraceInterceptor } from './middleware.js';
export { TraceThis } from './decorator.js';
export { traceIt, traced, watchThis } from './watch.js';

// Re-export types for consumers
export type { Span, Trace, InitOptions, TraceThisOptions, TraceItOptions, WatchThisOptions } from './types.js';
