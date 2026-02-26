import { describe, it, expect, beforeEach } from '@jest/globals';
import { TraceThis } from '../src/decorator';
import { runWithContext } from '../src/context';
import { collector } from '../src/collector';

beforeEach(() => collector.clear());

// ─── helpers ──────────────────────────────────────────────────────────────────

function setup(route = '/dec') {
  const trace = collector.createTrace('GET', route);
  const root  = collector.createSpan(trace.id, 'root', 'http-incoming');
  return { trace, root };
}

function getSpan(traceId: string, name: string) {
  return collector.getTrace(traceId)!.spans.find(s => s.name === name);
}

// ─── basic behaviour ──────────────────────────────────────────────────────────

describe('@TraceThis — basic behaviour', () => {
  it('creates a span with the method name', async () => {
    class Svc {
      @TraceThis()
      async greet(name: string) { return `hello ${name}`; }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().greet('world'));

    const span = getSpan(trace.id, 'greet');
    expect(span).toBeDefined();
    expect(span!.type).toBe('function');
    expect(span!.status).toBe('ok');
  });

  it('uses a custom name when provided', async () => {
    class Svc {
      @TraceThis({ name: 'custom-op' })
      async run() { return 1; }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().run());

    expect(getSpan(trace.id, 'custom-op')).toBeDefined();
    expect(getSpan(trace.id, 'run')).toBeUndefined();
  });

  it('no-ops outside of a trace context', async () => {
    class Svc {
      @TraceThis()
      async compute(n: number) { return n * 2; }
    }
    const result = await new Svc().compute(5);
    expect(result).toBe(10);
    expect(collector.getAllTraces()).toHaveLength(0);
  });

  it('marks the span as error and re-throws', async () => {
    class Svc {
      @TraceThis()
      async boom() { throw new Error('kaboom'); }
    }
    const { trace, root } = setup();
    await expect(
      runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().boom())
    ).rejects.toThrow('kaboom');

    const span = getSpan(trace.id, 'boom');
    expect(span!.status).toBe('error');
    expect(span!.error).toBe('kaboom');
  });
});

// ─── argument capture ─────────────────────────────────────────────────────────

describe('@TraceThis — argument capture', () => {
  it('captures a single string argument', async () => {
    class Svc {
      @TraceThis()
      async getUser(id: string) { return { id }; }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().getUser('usr_1'));

    const span = getSpan(trace.id, 'getUser');
    expect(span!.args).toEqual(['"usr_1"']);
  });

  it('captures multiple arguments', async () => {
    class Svc {
      @TraceThis()
      async createOrder(userId: string, amount: number, rush: boolean) {
        return { userId, amount, rush };
      }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () =>
      new Svc().createOrder('usr_1', 99, true)
    );

    const span = getSpan(trace.id, 'createOrder');
    expect(span!.args).toEqual(['"usr_1"', '99', 'true']);
  });

  it('captures an object argument as pretty-printed JSON', async () => {
    class Svc {
      @TraceThis()
      async save(payload: { name: string; value: number }) { return payload; }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () =>
      new Svc().save({ name: 'tax', value: 8 })
    );

    const span = getSpan(trace.id, 'save');
    expect(span!.args![0]).toContain('"name": "tax"');
    expect(span!.args![0]).toContain('"value": 8');
  });

  it('does not set args when the method takes no parameters', async () => {
    class Svc {
      @TraceThis()
      async ping() { return 'pong'; }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().ping());

    const span = getSpan(trace.id, 'ping');
    expect(span!.args).toBeUndefined();
  });

  it('does not set args on error', async () => {
    class Svc {
      @TraceThis()
      async fail(id: string) { throw new Error(`not found: ${id}`); }
    }
    const { trace, root } = setup();
    await expect(
      runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().fail('x'))
    ).rejects.toThrow();

    // args should still be captured even when the method throws
    const span = getSpan(trace.id, 'fail');
    expect(span!.args).toEqual(['"x"']);
  });
});

// ─── return value capture ─────────────────────────────────────────────────────

describe('@TraceThis — return value capture', () => {
  it('captures returnValue for a sync method', () => {
    class Svc {
      @TraceThis()
      double(n: number) { return n * 2; }
    }
    const { trace, root } = setup();
    runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().double(6));

    const span = getSpan(trace.id, 'double');
    expect(span!.returnValue).toBe('12');
  });

  it('captures returnValue for an async method', async () => {
    class Svc {
      @TraceThis()
      async fetchItem(id: string) { return { id, name: 'Widget' }; }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () =>
      new Svc().fetchItem('itm_1')
    );

    const span = getSpan(trace.id, 'fetchItem');
    expect(span!.returnValue).toContain('"id": "itm_1"');
    expect(span!.returnValue).toContain('"name": "Widget"');
  });

  it('does not set returnValue when the method returns undefined', async () => {
    class Svc {
      @TraceThis()
      async doWork(_id: string): Promise<void> { /* no return */ }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () =>
      new Svc().doWork('x')
    );

    const span = getSpan(trace.id, 'doWork');
    expect(span!.returnValue).toBeUndefined();
  });

  it('does not set returnValue when the method throws', async () => {
    class Svc {
      @TraceThis()
      async fail() { throw new Error('oops'); }
    }
    const { trace, root } = setup();
    await expect(
      runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().fail())
    ).rejects.toThrow('oops');

    const span = getSpan(trace.id, 'fail');
    expect(span!.returnValue).toBeUndefined();
    expect(span!.status).toBe('error');
  });

  it('truncates large return values at 1000 chars', async () => {
    class Svc {
      @TraceThis()
      async bigData() { return 'x'.repeat(2000); }
    }
    const { trace, root } = setup();
    await runWithContext({ traceId: trace.id, spanId: root.id }, () => new Svc().bigData());

    const span = getSpan(trace.id, 'bigData');
    expect(span!.returnValue!.length).toBeLessThanOrEqual(1020);
    expect(span!.returnValue).toContain('truncated');
  });
});
