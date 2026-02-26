import { getContext, childContext, runWithContext } from './context.js';
import { collector } from './collector.js';
import { serializeValue } from './serialize.js';
import type { TraceItOptions } from './types.js';

type TraceConfig = string | TraceItOptions;

function resolveConfig(config: TraceConfig): { name: string; attrs: Record<string, string | number | boolean> } {
  return typeof config === 'string'
    ? { name: config, attrs: {} }
    : { name: config.name, attrs: config.attributes ?? {} };
}

function _trace<T>(config: TraceConfig, fn: () => T, callArgs?: unknown[]): T {
  const { name, attrs } = resolveConfig(config);
  const ctx = getContext();

  // No active trace — execute normally, skip span creation
  if (!ctx) return fn();

  const span = collector.createSpan(ctx.traceId, name, 'function', ctx.spanId, attrs);

  // Capture call arguments when the caller supplies them (traced / @TraceThis)
  if (callArgs !== undefined && callArgs.length > 0) {
    span.args = callArgs.map(a => serializeValue(a) ?? 'undefined');
  }

  const childCtx = childContext(ctx, span.id);

  let result: T;
  try {
    result = runWithContext(childCtx, fn);
  } catch (err) {
    collector.finalizeSpan(span, err instanceof Error ? err.message : String(err));
    throw err;
  }

  // Handle async functions
  if (result instanceof Promise) {
    return result.then(
      (v) => {
        const rv = serializeValue(v);
        if (rv !== undefined) span.returnValue = rv;
        collector.finalizeSpan(span);
        return v;
      },
      (err) => {
        collector.finalizeSpan(span, err instanceof Error ? err.message : String(err));
        throw err;
      },
    ) as T;
  }

  const rv = serializeValue(result);
  if (rv !== undefined) span.returnValue = rv;
  collector.finalizeSpan(span);
  return result;
}

/**
 * traceIt() — call-site span wrapper.
 *
 * Wraps a single expression inside a named span. Use this when you want to
 * trace one specific call inline without permanently modifying the function.
 *
 * Both sync and async functions are supported; the return type is inferred.
 *
 * Usage:
 *   const result = await traceIt('calculate-pricing', () => calculatePricing(cart));
 *
 *   const result = await traceIt(
 *     { name: 'calculate-pricing', attributes: { layer: 'service' } },
 *     () => calculatePricing(cart),
 *   );
 */
export function traceIt<T>(config: TraceConfig, fn: () => T): T {
  return _trace(config, fn);
}

/**
 * traced() — definition-site function wrapper.
 *
 * Wraps a function once at definition time and returns a permanently-traced
 * version with the same signature. Every call to the returned function
 * automatically creates a child span — callers never need to know about tracing.
 *
 * Both sync and async functions are supported. Parameter types and return type
 * are fully inferred from the wrapped function.
 *
 * Usage:
 *   const chargeCard = traced('charge-card', async (amount: number) => {
 *     return stripe.charges.create({ amount });
 *   });
 *
 *   // Called like a normal function — tracing is invisible to callers
 *   await chargeCard(99);
 *
 *   // With options:
 *   const getUser = traced(
 *     { name: 'get-user', attributes: { layer: 'db' } },
 *     async (id: string) => db.users.findById(id),
 *   );
 */
export function traced<A extends unknown[], R>(
  config: TraceConfig,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => _trace(config, () => fn(...args), args);
}

/** @deprecated Use traceIt */
export const watchThis = traceIt;
