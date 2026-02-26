import { describe, it, expect } from '@jest/globals';
import { getContext, runWithContext, childContext } from '../src/context';

describe('context', () => {
  it('returns undefined outside a traced context', () => {
    expect(getContext()).toBeUndefined();
  });

  it('provides context inside runWithContext', () => {
    const ctx = { traceId: 'trace-1', spanId: 'span-1' };
    runWithContext(ctx, () => {
      expect(getContext()).toEqual(ctx);
    });
  });

  it('context is isolated to the async chain', async () => {
    const ctx = { traceId: 'trace-2', spanId: 'span-2' };

    const inner = new Promise<void>(resolve => {
      runWithContext(ctx, async () => {
        await Promise.resolve();
        expect(getContext()).toEqual(ctx);
        resolve();
      });
    });

    // Outside the runWithContext call, context must still be undefined
    expect(getContext()).toBeUndefined();
    await inner;
  });

  it('childContext preserves traceId and updates spanId', () => {
    const parent = { traceId: 'trace-3', spanId: 'span-parent' };
    const child = childContext(parent, 'span-child');
    expect(child.traceId).toBe('trace-3');
    expect(child.spanId).toBe('span-child');
  });

  it('nested runWithContext scopes are independent', () => {
    const ctxA = { traceId: 'A', spanId: 'sa' };
    const ctxB = { traceId: 'B', spanId: 'sb' };

    runWithContext(ctxA, () => {
      expect(getContext()!.traceId).toBe('A');

      runWithContext(ctxB, () => {
        expect(getContext()!.traceId).toBe('B');
      });

      // Back to A after the inner scope exits
      expect(getContext()!.traceId).toBe('A');
    });
  });

  it('propagates through Promise.all', async () => {
    const ctx = { traceId: 'pa', spanId: 'sp' };

    await runWithContext(ctx, async () => {
      const results = await Promise.all([
        Promise.resolve(getContext()!.traceId),
        Promise.resolve(getContext()!.traceId),
      ]);
      expect(results).toEqual(['pa', 'pa']);
    });
  });
});
