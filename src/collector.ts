import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { Span, Trace } from './types.js';

export type { Span, Trace };

class Collector extends EventEmitter {
  private traces: Map<string, Trace> = new Map();
  private order: string[] = [];   // insertion order for circular eviction
  private maxTraces: number = 100;

  configure(maxTraces: number): void {
    this.maxTraces = maxTraces;
  }

  // ── Trace lifecycle ────────────────────────────────────────────────────────

  createTrace(method: string, route: string): Trace {
    const id = randomUUID();
    const trace: Trace = {
      id,
      route,
      method,
      startTime: Date.now(),
      status: 'running',
      spans: [],
    };
    this.traces.set(id, trace);
    this.order.push(id);

    // Evict oldest when over limit
    while (this.order.length > this.maxTraces) {
      const evict = this.order.shift()!;
      this.traces.delete(evict);
    }

    this.emit('trace:updated', trace);
    return trace;
  }

  finalizeTrace(traceId: string, statusCode: number, durationMs: number): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.statusCode = statusCode;
    trace.duration = durationMs;
    trace.status = statusCode >= 500 ? 'error' : 'ok';
    this.emit('trace:updated', trace);
  }

  // ── Span lifecycle ─────────────────────────────────────────────────────────

  createSpan(
    traceId: string,
    name: string,
    type: Span['type'],
    parentId?: string,
    attributes: Span['attributes'] = {},
  ): Span {
    const span: Span = {
      id: randomUUID(),
      traceId,
      parentId,
      name,
      startTime: Date.now(),
      status: 'running',
      type,
      attributes,
    };

    const trace = this.traces.get(traceId);
    if (trace) {
      trace.spans.push(span);
      this.emit('trace:updated', trace);
    }

    return span;
  }

  finalizeSpan(span: Span, error?: string): void {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = error ? 'error' : 'ok';
    if (error) span.error = error;

    const trace = this.traces.get(span.traceId);
    if (trace) this.emit('trace:updated', trace);
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  getTrace(id: string): Trace | undefined {
    return this.traces.get(id);
  }

  getAllTraces(): Trace[] {
    // Return newest first
    return [...this.order]
      .reverse()
      .map(id => this.traces.get(id))
      .filter((t): t is Trace => t !== undefined);
  }

  clear(): void {
    this.traces.clear();
    this.order = [];
  }
}

// Singleton shared across the whole process
export const collector = new Collector();

// Re-export id generator for other modules
export { randomUUID as generateId };
