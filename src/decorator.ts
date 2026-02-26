import { getContext, childContext, runWithContext } from './context.js';
import { collector } from './collector.js';
import { serializeValue } from './serialize.js';
import type { TraceThisOptions } from './types.js';

/**
 * @TraceThis() — method decorator that wraps the decorated method in a child span.
 *
 * Usage:
 *   @TraceThis()
 *   async processOrder(id: string) { ... }
 *
 *   @TraceThis({ name: 'pricing-calculation', attributes: { layer: 'service' } })
 *   async calculatePricing(cart: Cart) { ... }
 *
 * - Works on both sync and async methods.
 * - Silently no-ops (calls original) when invoked outside an active request context.
 */
export function TraceThis(options?: TraceThisOptions): MethodDecorator {
  return function (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original: Function = descriptor.value;
    const spanName = options?.name ?? String(propertyKey);
    const extraAttrs = options?.attributes ?? {};

    descriptor.value = function (this: unknown, ...args: unknown[]) {
      const ctx = getContext();

      // No active trace — execute normally, skip span creation
      if (!ctx) return original.apply(this, args);

      const span = collector.createSpan(
        ctx.traceId,
        spanName,
        'function',
        ctx.spanId,
        { ...extraAttrs, method: String(propertyKey) },
      );

      // Capture call arguments
      if (args.length > 0) {
        span.args = args.map(a => serializeValue(a) ?? 'undefined');
      }

      const childCtx = childContext(ctx, span.id);

      let result: unknown;
      try {
        result = runWithContext(childCtx, () => original.apply(this, args));
      } catch (err) {
        collector.finalizeSpan(span, err instanceof Error ? err.message : String(err));
        throw err;
      }

      // Handle async methods
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
        );
      }

      const rv = serializeValue(result);
      if (rv !== undefined) span.returnValue = rv;
      collector.finalizeSpan(span);
      return result;
    };

    return descriptor;
  };
}
