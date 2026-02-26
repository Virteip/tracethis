import { describe, it, expect, beforeEach } from '@jest/globals';
import { traceIt, traced, watchThis } from '../src/watch';
import { runWithContext } from '../src/context';
import { collector } from '../src/collector';

beforeEach(() => collector.clear());

// ─── traceIt ──────────────────────────────────────────────────────────────────

describe('traceIt', () => {
  describe('type inference', () => {
    it('infers string return type from sync function', () => {
      const result = traceIt('op', () => 'hello');
      expect(result).toBe('hello');
    });

    it('infers Promise<number> from async function', async () => {
      const result = await traceIt('op', async () => 42);
      expect(result).toBe(42);
    });

    it('infers number from sync numeric function', () => {
      const result = traceIt('calc', () => 1 + 2);
      expect(result).toBe(3);
    });

    it('infers object return type', () => {
      const result = traceIt('obj', () => ({ x: 1, y: 2 }));
      expect(result).toEqual({ x: 1, y: 2 });
    });
  });

  describe('outside request context', () => {
    it('executes function normally without creating a span', async () => {
      let called = false;
      const result = await traceIt('no-context', async () => {
        called = true;
        return 99;
      });
      expect(called).toBe(true);
      expect(result).toBe(99);
      expect(collector.getAllTraces()).toHaveLength(0);
    });

    it('propagates sync errors without span', () => {
      expect(() =>
        traceIt('boom', () => { throw new Error('oops'); })
      ).toThrow('oops');
    });
  });

  describe('inside request context', () => {
    it('creates a function span under the active trace', async () => {
      const trace = collector.createTrace('GET', '/test');
      const rootSpan = collector.createSpan(trace.id, 'GET /test', 'http-incoming');

      await runWithContext({ traceId: trace.id, spanId: rootSpan.id }, async () => {
        await traceIt('my-operation', async () => {
          await new Promise(r => setTimeout(r, 10));
        });
      });

      const updated = collector.getTrace(trace.id)!;
      const span = updated.spans.find(s => s.name === 'my-operation');
      expect(span).toBeDefined();
      expect(span!.type).toBe('function');
      expect(span!.status).toBe('ok');
      expect(span!.duration).toBeGreaterThanOrEqual(0);
      expect(span!.parentId).toBe(rootSpan.id);
    });

    it('records error on the span and re-throws', async () => {
      const trace = collector.createTrace('GET', '/err');
      const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

      await expect(
        runWithContext({ traceId: trace.id, spanId: rootSpan.id }, async () => {
          await traceIt('failing-op', async () => {
            throw new Error('fail!');
          });
        })
      ).rejects.toThrow('fail!');

      const updated = collector.getTrace(trace.id)!;
      const span = updated.spans.find(s => s.name === 'failing-op');
      expect(span!.status).toBe('error');
      expect(span!.error).toBe('fail!');
    });

    it('accepts TraceItOptions object', async () => {
      const trace = collector.createTrace('GET', '/attrs');
      const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

      await runWithContext({ traceId: trace.id, spanId: rootSpan.id }, async () => {
        await traceIt(
          { name: 'custom-name', attributes: { layer: 'service', version: 2 } },
          async () => 'done',
        );
      });

      const updated = collector.getTrace(trace.id)!;
      const span = updated.spans.find(s => s.name === 'custom-name');
      expect(span).toBeDefined();
      expect(span!.attributes.layer).toBe('service');
      expect(span!.attributes.version).toBe(2);
    });

    it('correctly nests child spans', async () => {
      const trace = collector.createTrace('GET', '/nested');
      const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

      await runWithContext({ traceId: trace.id, spanId: rootSpan.id }, async () => {
        await traceIt('parent-op', async () => {
          await traceIt('child-op', async () => {
            await Promise.resolve();
          });
        });
      });

      const updated = collector.getTrace(trace.id)!;
      const parent = updated.spans.find(s => s.name === 'parent-op')!;
      const child  = updated.spans.find(s => s.name === 'child-op')!;

      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(child.parentId).toBe(parent.id);
    });

    it('works with sync functions inside context', () => {
      const trace = collector.createTrace('GET', '/sync');
      const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

      let result!: number;
      runWithContext({ traceId: trace.id, spanId: rootSpan.id }, () => {
        result = traceIt('sync-op', () => 42);
      });

      expect(result).toBe(42);
      const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'sync-op');
      expect(span!.status).toBe('ok');
    });
  });
});

// ─── traceIt — return value capture ──────────────────────────────────────────

describe('traceIt — return value capture', () => {
  it('captures returnValue for a sync function', () => {
    const trace = collector.createTrace('GET', '/rv-sync');
    const root  = collector.createSpan(trace.id, 'root', 'http-incoming');

    runWithContext({ traceId: trace.id, spanId: root.id }, () => {
      traceIt('op', () => ({ answer: 42 }));
    });

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toBe('{\n  "answer": 42\n}');
  });

  it('captures returnValue for an async function', async () => {
    const trace = collector.createTrace('GET', '/rv-async');
    const root  = collector.createSpan(trace.id, 'root', 'http-incoming');

    await runWithContext({ traceId: trace.id, spanId: root.id }, async () => {
      await traceIt('op', async () => 'hello');
    });

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toBe('"hello"');
  });

  it('does not set returnValue when the function returns undefined', () => {
    const trace = collector.createTrace('GET', '/rv-void');
    const root  = collector.createSpan(trace.id, 'root', 'http-incoming');

    runWithContext({ traceId: trace.id, spanId: root.id }, () => {
      traceIt('op', () => undefined);
    });

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toBeUndefined();
  });

  it('does not set args (traceIt receives a closure, not the original args)', () => {
    const trace = collector.createTrace('GET', '/rv-no-args');
    const root  = collector.createSpan(trace.id, 'root', 'http-incoming');

    runWithContext({ traceId: trace.id, spanId: root.id }, () => {
      traceIt('op', () => 'result');
    });

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.args).toBeUndefined();
  });

  it('does not set returnValue when an error is thrown', async () => {
    const trace = collector.createTrace('GET', '/rv-err');
    const root  = collector.createSpan(trace.id, 'root', 'http-incoming');

    await expect(
      runWithContext({ traceId: trace.id, spanId: root.id }, () =>
        traceIt('op', async () => { throw new Error('boom'); })
      )
    ).rejects.toThrow('boom');

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toBeUndefined();
    expect(span!.status).toBe('error');
  });
});

// ─── traced ───────────────────────────────────────────────────────────────────

describe('traced', () => {
  it('returns a function with the same arity', () => {
    const fn = traced('op', (a: number, b: number) => a + b);
    expect(fn).toBeInstanceOf(Function);
    expect(fn(2, 3)).toBe(5);
  });

  it('passes arguments through correctly', async () => {
    const greet = traced('greet', async (name: string) => `hello ${name}`);
    const result = await greet('world');
    expect(result).toBe('hello world');
  });

  it('does not create a span outside of request context', async () => {
    const fn = traced('no-ctx', async (x: number) => x * 2);
    const result = await fn(5);
    expect(result).toBe(10);
    expect(collector.getAllTraces()).toHaveLength(0);
  });

  it('creates a span for each call inside a request context', async () => {
    const trace = collector.createTrace('GET', '/traced');
    const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

    const processItem = traced('process-item', async (id: number) => id * 10);

    await runWithContext({ traceId: trace.id, spanId: rootSpan.id }, async () => {
      await processItem(1);
      await processItem(2);
    });

    const updated = collector.getTrace(trace.id)!;
    const spans = updated.spans.filter(s => s.name === 'process-item');
    expect(spans).toHaveLength(2);
    expect(spans[0].type).toBe('function');
    expect(spans[0].status).toBe('ok');
  });

  it('records errors and re-throws', async () => {
    const trace = collector.createTrace('GET', '/traced-err');
    const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

    const failFn = traced('will-fail', async (_id: string) => {
      throw new Error('traced error');
    });

    await expect(
      runWithContext({ traceId: trace.id, spanId: rootSpan.id }, () => failFn('x'))
    ).rejects.toThrow('traced error');

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'will-fail');
    expect(span!.status).toBe('error');
    expect(span!.error).toBe('traced error');
  });

  it('correctly sets parentId on each call', async () => {
    const trace = collector.createTrace('GET', '/parent');
    const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

    const fetch = traced('fetch-data', async (id: string) => id);

    await runWithContext({ traceId: trace.id, spanId: rootSpan.id }, async () => {
      await fetch('a');
      await fetch('b');
    });

    const spans = collector.getTrace(trace.id)!.spans.filter(s => s.name === 'fetch-data');
    expect(spans[0].parentId).toBe(rootSpan.id);
    expect(spans[1].parentId).toBe(rootSpan.id);
  });

  it('accepts TraceItOptions with attributes', async () => {
    const trace = collector.createTrace('GET', '/traced-opts');
    const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

    const lookup = traced(
      { name: 'db-lookup', attributes: { table: 'users' } },
      async (id: number) => ({ id }),
    );

    await runWithContext({ traceId: trace.id, spanId: rootSpan.id }, () => lookup(42));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'db-lookup');
    expect(span).toBeDefined();
    expect(span!.attributes.table).toBe('users');
  });

  it('works with sync functions', () => {
    const trace = collector.createTrace('GET', '/sync-traced');
    const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

    const double = traced('double', (n: number) => n * 2);

    let result!: number;
    runWithContext({ traceId: trace.id, spanId: rootSpan.id }, () => {
      result = double(7);
    });

    expect(result).toBe(14);
    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'double');
    expect(span!.status).toBe('ok');
  });
});

// ─── traced — argument and return value capture ───────────────────────────────

describe('traced — argument and return value capture', () => {
  function setup(route = '/traced-io') {
    const trace = collector.createTrace('GET', route);
    const root  = collector.createSpan(trace.id, 'root', 'http-incoming');
    return { trace, root };
  }

  it('captures a single string argument', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async (id: string) => id);

    await runWithContext({ traceId: trace.id, spanId: root.id }, () => fn('usr_1'));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.args).toEqual(['"usr_1"']);
  });

  it('captures a single number argument', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async (n: number) => n);

    await runWithContext({ traceId: trace.id, spanId: root.id }, () => fn(42));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.args).toEqual(['42']);
  });

  it('captures multiple arguments', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async (a: string, b: number, c: boolean) => `${a}${b}${c}`);

    await runWithContext({ traceId: trace.id, spanId: root.id }, () => fn('x', 7, true));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.args).toEqual(['"x"', '7', 'true']);
  });

  it('captures an object argument as pretty-printed JSON', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async (obj: { a: number }) => obj.a);

    await runWithContext({ traceId: trace.id, spanId: root.id }, () => fn({ a: 1 }));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.args![0]).toContain('"a": 1');
  });

  it('does not set args when called with no arguments', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async () => 'done');

    await runWithContext({ traceId: trace.id, spanId: root.id }, fn);

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.args).toBeUndefined();
  });

  it('captures returnValue for a sync function', () => {
    const { trace, root } = setup();
    const fn = traced('op', (n: number) => n * 2);

    runWithContext({ traceId: trace.id, spanId: root.id }, () => fn(5));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toBe('10');
  });

  it('captures returnValue for an async function returning an object', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async (id: string) => ({ id, ok: true }));

    await runWithContext({ traceId: trace.id, spanId: root.id }, () => fn('a'));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toContain('"id": "a"');
    expect(span!.returnValue).toContain('"ok": true');
  });

  it('does not set returnValue when the function returns undefined', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async (_x: number) => undefined);

    await runWithContext({ traceId: trace.id, spanId: root.id }, () => fn(1));

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toBeUndefined();
  });

  it('does not set returnValue on error', async () => {
    const { trace, root } = setup();
    const fn = traced('op', async () => { throw new Error('fail'); });

    await expect(
      runWithContext({ traceId: trace.id, spanId: root.id }, fn)
    ).rejects.toThrow('fail');

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue).toBeUndefined();
    expect(span!.status).toBe('error');
  });

  it('truncates large return values at 1000 chars', async () => {
    const { trace, root } = setup();
    const big = 'x'.repeat(2000);
    const fn = traced('op', async () => big);

    await runWithContext({ traceId: trace.id, spanId: root.id }, fn);

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    expect(span!.returnValue!.length).toBeLessThanOrEqual(1020); // 1000 chars + quotes + truncation marker
    expect(span!.returnValue).toContain('truncated');
  });

  it('handles circular references without throwing', async () => {
    const { trace, root } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circ: any = { a: 1 };
    circ.self = circ;
    const fn = traced('op', async () => circ);

    await runWithContext({ traceId: trace.id, spanId: root.id }, fn);

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'op');
    // Should not throw — value is safely serialized to a fallback string
    expect(span!.returnValue).toBeDefined();
  });
});

// ─── watchThis (backward-compat alias) ───────────────────────────────────────

describe('watchThis', () => {
  it('is an alias for traceIt', () => {
    expect(watchThis).toBe(traceIt);
  });

  it('still works as before', async () => {
    const trace = collector.createTrace('GET', '/compat');
    const rootSpan = collector.createSpan(trace.id, 'root', 'http-incoming');

    await runWithContext({ traceId: trace.id, spanId: rootSpan.id }, async () => {
      await watchThis('compat-op', async () => 'ok');
    });

    const span = collector.getTrace(trace.id)!.spans.find(s => s.name === 'compat-op');
    expect(span!.status).toBe('ok');
  });
});
