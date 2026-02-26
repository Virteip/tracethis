import { describe, it, expect, beforeEach } from '@jest/globals';
import { collector } from '../src/collector';

beforeEach(() => collector.clear());

describe('collector', () => {
  describe('createTrace', () => {
    it('creates a trace with running status', () => {
      const trace = collector.createTrace('GET', '/api/test');
      expect(trace.method).toBe('GET');
      expect(trace.route).toBe('/api/test');
      expect(trace.status).toBe('running');
      expect(trace.spans).toEqual([]);
      expect(typeof trace.id).toBe('string');
    });

    it('evicts oldest trace when over maxTraces', () => {
      collector.configure(3);

      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(collector.createTrace('GET', `/route-${i}`).id);
      }

      const all = collector.getAllTraces();
      expect(all.length).toBe(3);
      // The first trace should have been evicted
      expect(all.find(t => t.id === ids[0])).toBeUndefined();
      expect(all.find(t => t.id === ids[3])).toBeDefined();

      // Reset to default for other tests
      collector.configure(100);
    });
  });

  describe('finalizeTrace', () => {
    it('sets statusCode, duration, and status', () => {
      const trace = collector.createTrace('POST', '/submit');
      collector.finalizeTrace(trace.id, 200, 42);
      const updated = collector.getTrace(trace.id)!;
      expect(updated.statusCode).toBe(200);
      expect(updated.duration).toBe(42);
      expect(updated.status).toBe('ok');
    });

    it('marks status as error for 5xx', () => {
      const trace = collector.createTrace('GET', '/boom');
      collector.finalizeTrace(trace.id, 500, 10);
      expect(collector.getTrace(trace.id)!.status).toBe('error');
    });
  });

  describe('createSpan / finalizeSpan', () => {
    it('adds span to trace', () => {
      const trace = collector.createTrace('GET', '/path');
      const span = collector.createSpan(trace.id, 'my-fn', 'function', undefined, { tag: 'x' });
      expect(collector.getTrace(trace.id)!.spans).toHaveLength(1);
      expect(span.name).toBe('my-fn');
      expect(span.status).toBe('running');
      expect(span.attributes.tag).toBe('x');
    });

    it('finalizes span with duration and ok status', async () => {
      const trace = collector.createTrace('GET', '/path');
      const span = collector.createSpan(trace.id, 'op', 'db');
      await new Promise(r => setTimeout(r, 5));
      collector.finalizeSpan(span);
      expect(span.status).toBe('ok');
      expect(span.duration).toBeGreaterThanOrEqual(0);
      expect(span.endTime).toBeDefined();
    });

    it('finalizes span with error message', () => {
      const trace = collector.createTrace('GET', '/path');
      const span = collector.createSpan(trace.id, 'op', 'function');
      collector.finalizeSpan(span, 'something went wrong');
      expect(span.status).toBe('error');
      expect(span.error).toBe('something went wrong');
    });
  });

  describe('getAllTraces', () => {
    it('returns traces newest first', () => {
      const t1 = collector.createTrace('GET', '/one');
      const t2 = collector.createTrace('GET', '/two');
      const all = collector.getAllTraces();
      expect(all[0].id).toBe(t2.id);
      expect(all[1].id).toBe(t1.id);
    });
  });

  describe('events', () => {
    it('emits trace:updated on createTrace', (done) => {
      collector.once('trace:updated', (trace) => {
        expect(trace.route).toBe('/event-test');
        done();
      });
      collector.createTrace('GET', '/event-test');
    });

    it('emits trace:updated on finalizeSpan', (done) => {
      const trace = collector.createTrace('GET', '/span-event');
      const span = collector.createSpan(trace.id, 'op', 'function');

      collector.once('trace:updated', () => done());
      collector.finalizeSpan(span);
    });
  });
});
