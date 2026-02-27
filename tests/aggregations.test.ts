import { describe, it, expect } from '@jest/globals';
import {
  getExternalDependencySummary,
  getDbSummary,
  getRouteHistory,
  getHttpNPlusOne,
  SLOW_QUERY_THRESHOLD_MS,
} from '../src/aggregations';
import type { Trace, Span } from '../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: 'trace-1',
    route: '/api/orders',
    method: 'GET',
    startTime: Date.now(),
    status: 'ok',
    statusCode: 200,
    duration: 100,
    spans: [],
    ...overrides,
  };
}

function makeSpan(overrides: Partial<Span>): Span {
  return {
    id: Math.random().toString(36).slice(2),
    traceId: 'trace-1',
    name: 'unnamed',
    startTime: Date.now(),
    endTime: Date.now() + 10,
    duration: 10,
    status: 'ok',
    type: 'function',
    attributes: {},
    ...overrides,
  };
}

// ─── getExternalDependencySummary ─────────────────────────────────────────────

describe('getExternalDependencySummary', () => {
  it('returns empty array when no http-outgoing spans', () => {
    const trace = makeTrace({
      spans: [makeSpan({ type: 'db', name: 'SELECT 1' })],
    });
    expect(getExternalDependencySummary(trace)).toEqual([]);
  });

  it('groups multiple calls to the same host', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'http-outgoing', name: 'GET api.example.com/a', duration: 100, attributes: { host: 'api.example.com', method: 'GET', path: '/a' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET api.example.com/b', duration: 200, attributes: { host: 'api.example.com', method: 'GET', path: '/b' } }),
      ],
    });
    const result = getExternalDependencySummary(trace);
    expect(result).toHaveLength(1);
    expect(result[0].host).toBe('api.example.com');
    expect(result[0].callCount).toBe(2);
    expect(result[0].totalDuration).toBe(300);
    expect(result[0].avgDuration).toBe(150);
    expect(result[0].slowestCall).toBe(200);
  });

  it('handles multiple distinct hosts', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'http-outgoing', name: 'GET alpha.io/x', duration: 50,  attributes: { host: 'alpha.io', method: 'GET', path: '/x' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET beta.io/y',  duration: 200, attributes: { host: 'beta.io',  method: 'GET', path: '/y' } }),
      ],
    });
    const result = getExternalDependencySummary(trace);
    expect(result).toHaveLength(2);
    // sorted by totalDuration descending
    expect(result[0].host).toBe('beta.io');
    expect(result[1].host).toBe('alpha.io');
  });

  it('uses attributes.host when available', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'http-outgoing', name: 'fetch GET payments.svc/charge', duration: 80, attributes: { host: 'payments.svc', method: 'GET', path: '/charge' } }),
      ],
    });
    const result = getExternalDependencySummary(trace);
    expect(result[0].host).toBe('payments.svc');
  });
});

// ─── getDbSummary ─────────────────────────────────────────────────────────────

describe('getDbSummary', () => {
  it('returns zeros when no db spans', () => {
    const trace = makeTrace({ spans: [] });
    const result = getDbSummary(trace);
    expect(result.totalQueries).toBe(0);
    expect(result.totalDuration).toBe(0);
    expect(result.hasNPlusOne).toBe(false);
    expect(result.patterns).toHaveLength(0);
  });

  it('counts queries and sums duration', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT * FROM users WHERE id = 1', duration: 10 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM orders', duration: 20 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.totalQueries).toBe(2);
    expect(result.totalDuration).toBe(30);
  });

  it('normalises query patterns (strips numbers, UUIDs, quoted strings)', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: "SELECT * FROM users WHERE id = 42",            duration: 5 }),
        makeSpan({ type: 'db', name: "SELECT * FROM users WHERE id = 99",            duration: 5 }),
        makeSpan({ type: 'db', name: "SELECT * FROM users WHERE id = 7",             duration: 5 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].count).toBe(3);
    expect(result.patterns[0].pattern).toBe('SELECT * FROM users WHERE id = ?');
  });

  it('strips UUID values in patterns', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT * FROM items WHERE uuid = 550e8400-e29b-41d4-a716-446655440000', duration: 5 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM items WHERE uuid = 550e8400-e29b-41d4-a716-446655440001', duration: 5 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM items WHERE uuid = 550e8400-e29b-41d4-a716-446655440002', duration: 5 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].count).toBe(3);
    expect(result.patterns[0].isNPlusOne).toBe(true);
  });

  it('flags N+1 when a pattern appears 3 or more times', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'pg: SELECT name FROM products WHERE id = 1', duration: 5 }),
        makeSpan({ type: 'db', name: 'pg: SELECT name FROM products WHERE id = 2', duration: 5 }),
        makeSpan({ type: 'db', name: 'pg: SELECT name FROM products WHERE id = 3', duration: 5 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.hasNPlusOne).toBe(true);
    expect(result.patterns[0].isNPlusOne).toBe(true);
  });

  it('does NOT flag N+1 for pattern appearing fewer than 3 times', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT * FROM users WHERE id = 1', duration: 5 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM users WHERE id = 2', duration: 5 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.hasNPlusOne).toBe(false);
    expect(result.patterns[0].isNPlusOne).toBe(false);
  });

  it('sorts patterns by totalDuration descending', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT 1', duration: 5 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM big_table', duration: 500 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.patterns[0].pattern).toBe('SELECT * FROM big_table');
  });

  it('flags highDbTimeRatio when DB time >= 80% of trace duration', () => {
    const now = Date.now();
    const trace = makeTrace({
      duration: 100,
      spans: [makeSpan({ type: 'db', name: 'SELECT 1', startTime: now, endTime: now + 85, duration: 85 })],
    });
    const result = getDbSummary(trace);
    expect(result.highDbTimeRatio).toBe(true);
    expect(result.dbTimePct).toBe(85);
  });

  it('does NOT flag highDbTimeRatio when DB time is below 80%', () => {
    const now = Date.now();
    const trace = makeTrace({
      duration: 100,
      spans: [makeSpan({ type: 'db', name: 'SELECT 1', startTime: now, endTime: now + 50, duration: 50 })],
    });
    const result = getDbSummary(trace);
    expect(result.highDbTimeRatio).toBe(false);
    expect(result.dbTimePct).toBe(50);
  });

  it('uses wall-clock (merged) time for ratio — parallel queries never exceed 100%', () => {
    const now = Date.now();
    // Three parallel queries that each take 300ms but overlap completely
    const trace = makeTrace({
      duration: 400,
      spans: [
        makeSpan({ type: 'db', name: 'SELECT a', startTime: now,      endTime: now + 300, duration: 300 }),
        makeSpan({ type: 'db', name: 'SELECT b', startTime: now + 10,  endTime: now + 310, duration: 300 }),
        makeSpan({ type: 'db', name: 'SELECT c', startTime: now + 20,  endTime: now + 320, duration: 300 }),
      ],
    });
    const result = getDbSummary(trace);
    // Sum would be 900ms / 400ms = 225% — wall-clock merged is ~320ms / 400ms = 80%
    expect(result.dbTimePct).toBeLessThanOrEqual(100);
    expect(result.dbTimePct).toBe(80);
  });

  it('does NOT flag highDbTimeRatio when trace has no duration', () => {
    const trace = makeTrace({
      duration: undefined,
      spans: [makeSpan({ type: 'db', name: 'SELECT 1', duration: 85 })],
    });
    const result = getDbSummary(trace);
    expect(result.highDbTimeRatio).toBe(false);
    expect(result.dbTimePct).toBe(0);
  });

  it('flags isSlow and hasSlowQuery when avg duration >= threshold', () => {
    const trace = makeTrace({
      spans: [makeSpan({ type: 'db', name: 'SELECT * FROM reports', duration: SLOW_QUERY_THRESHOLD_MS })],
    });
    const result = getDbSummary(trace);
    expect(result.hasSlowQuery).toBe(true);
    expect(result.patterns[0].isSlow).toBe(true);
    expect(result.patterns[0].avgDuration).toBe(SLOW_QUERY_THRESHOLD_MS);
  });

  it('does NOT flag isSlow when avg duration is below threshold', () => {
    const trace = makeTrace({
      spans: [makeSpan({ type: 'db', name: 'SELECT 1', duration: SLOW_QUERY_THRESHOLD_MS - 1 })],
    });
    const result = getDbSummary(trace);
    expect(result.hasSlowQuery).toBe(false);
    expect(result.patterns[0].isSlow).toBe(false);
  });

  it('uses avg duration across multiple executions of the same pattern', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT * FROM orders WHERE id = 1', duration: 50 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM orders WHERE id = 2', duration: 150 }),
      ],
    });
    const result = getDbSummary(trace);
    // avg = (50 + 150) / 2 = 100 — exactly at threshold
    expect(result.patterns[0].avgDuration).toBe(100);
    expect(result.patterns[0].isSlow).toBe(true);
  });

  it('detects sequential queries under the same parent', () => {
    const now = Date.now();
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT * FROM users', parentId: 'parent-1', startTime: now,      endTime: now + 20,  duration: 20 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM orders', parentId: 'parent-1', startTime: now + 20, endTime: now + 40,  duration: 20 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.hasSequentialQueries).toBe(true);
    expect(result.sequentialGroupCount).toBe(1);
  });

  it('does NOT flag parallel queries as sequential', () => {
    const now = Date.now();
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT * FROM users',  parentId: 'parent-1', startTime: now,      endTime: now + 30,  duration: 30 }),
        makeSpan({ type: 'db', name: 'SELECT * FROM orders', parentId: 'parent-1', startTime: now + 5,  endTime: now + 35,  duration: 30 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.hasSequentialQueries).toBe(false);
  });

  it('does NOT flag a single query per parent as sequential', () => {
    const now = Date.now();
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'db', name: 'SELECT 1', parentId: 'parent-a', startTime: now,      endTime: now + 10, duration: 10 }),
        makeSpan({ type: 'db', name: 'SELECT 2', parentId: 'parent-b', startTime: now + 15, endTime: now + 25, duration: 10 }),
      ],
    });
    const result = getDbSummary(trace);
    expect(result.hasSequentialQueries).toBe(false);
  });
});

// ─── getHttpNPlusOne ──────────────────────────────────────────────────────────

describe('getHttpNPlusOne', () => {
  it('returns no patterns when no http-outgoing spans', () => {
    const trace = makeTrace({ spans: [] });
    const result = getHttpNPlusOne(trace);
    expect(result.hasNPlusOne).toBe(false);
    expect(result.patterns).toHaveLength(0);
  });

  it('flags N+1 when 3+ calls hit the same normalised path', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'http-outgoing', name: 'GET api.svc/users/1', attributes: { host: 'api.svc', path: '/users/1', method: 'GET' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET api.svc/users/2', attributes: { host: 'api.svc', path: '/users/2', method: 'GET' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET api.svc/users/3', attributes: { host: 'api.svc', path: '/users/3', method: 'GET' } }),
      ],
    });
    const result = getHttpNPlusOne(trace);
    expect(result.hasNPlusOne).toBe(true);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].pattern).toBe('api.svc/users/?');
    expect(result.patterns[0].count).toBe(3);
  });

  it('does NOT flag N+1 for fewer than 3 calls to the same pattern', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'http-outgoing', name: 'GET svc/items/1', attributes: { host: 'svc', path: '/items/1', method: 'GET' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET svc/items/2', attributes: { host: 'svc', path: '/items/2', method: 'GET' } }),
      ],
    });
    const result = getHttpNPlusOne(trace);
    expect(result.hasNPlusOne).toBe(false);
  });

  it('normalises query parameter values', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'http-outgoing', name: 'GET svc/comments?postId=1', attributes: { host: 'svc', path: '/comments?postId=1', method: 'GET' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET svc/comments?postId=2', attributes: { host: 'svc', path: '/comments?postId=2', method: 'GET' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET svc/comments?postId=3', attributes: { host: 'svc', path: '/comments?postId=3', method: 'GET' } }),
      ],
    });
    const result = getHttpNPlusOne(trace);
    expect(result.hasNPlusOne).toBe(true);
    expect(result.patterns[0].pattern).toBe('svc/comments?postId=?');
  });

  it('treats different hosts as different patterns', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'http-outgoing', name: 'GET a.svc/users/1', attributes: { host: 'a.svc', path: '/users/1', method: 'GET' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET a.svc/users/2', attributes: { host: 'a.svc', path: '/users/2', method: 'GET' } }),
        makeSpan({ type: 'http-outgoing', name: 'GET b.svc/users/3', attributes: { host: 'b.svc', path: '/users/3', method: 'GET' } }),
      ],
    });
    const result = getHttpNPlusOne(trace);
    expect(result.hasNPlusOne).toBe(false);
  });
});

// ─── getRouteHistory ──────────────────────────────────────────────────────────

describe('getRouteHistory', () => {
  it('returns empty durations when no matching traces', () => {
    const result = getRouteHistory([], '/api/users');
    expect(result.durations).toHaveLength(0);
    expect(result.trend).toBe('stable');
  });

  it('returns durations for matching route only', () => {
    const traces: Trace[] = [
      makeTrace({ route: '/api/users',  duration: 100, status: 'ok' }),
      makeTrace({ route: '/api/orders', duration: 200, status: 'ok' }),
      makeTrace({ route: '/api/users',  duration: 120, status: 'ok' }),
    ];
    const result = getRouteHistory(traces, '/api/users');
    expect(result.durations).toHaveLength(2);
    expect(result.durations).toContain(100);
    expect(result.durations).toContain(120);
  });

  it('excludes still-running traces', () => {
    const traces: Trace[] = [
      makeTrace({ route: '/api/x', duration: 50,        status: 'ok' }),
      makeTrace({ route: '/api/x', duration: undefined, status: 'running' }),
    ];
    const result = getRouteHistory(traces, '/api/x');
    expect(result.durations).toHaveLength(1);
  });

  it('caps at 10 most recent entries', () => {
    const traces: Trace[] = Array.from({ length: 15 }, (_, i) =>
      makeTrace({ route: '/api/test', duration: (i + 1) * 10, status: 'ok' }),
    );
    // getAllTraces returns newest first; getRouteHistory slices first 10 then reverses
    const result = getRouteHistory(traces, '/api/test');
    expect(result.durations).toHaveLength(10);
  });

  it('detects slower trend when recent half is >10% slower', () => {
    // oldest-first after reversal inside getRouteHistory
    // getAllTraces() returns newest-first, so we put slow traces at the start (newest)
    const traces: Trace[] = [
      makeTrace({ route: '/r', duration: 500, status: 'ok' }), // newest
      makeTrace({ route: '/r', duration: 500, status: 'ok' }),
      makeTrace({ route: '/r', duration: 100, status: 'ok' }), // oldest
      makeTrace({ route: '/r', duration: 100, status: 'ok' }),
    ];
    const result = getRouteHistory(traces, '/r');
    // After slice(0,10)+reverse: [100,100,500,500] — second half avg (500) > first half avg (100)
    expect(result.trend).toBe('slower');
  });

  it('detects faster trend when recent half is >10% faster', () => {
    const traces: Trace[] = [
      makeTrace({ route: '/r', duration: 100, status: 'ok' }), // newest
      makeTrace({ route: '/r', duration: 100, status: 'ok' }),
      makeTrace({ route: '/r', duration: 500, status: 'ok' }), // oldest
      makeTrace({ route: '/r', duration: 500, status: 'ok' }),
    ];
    const result = getRouteHistory(traces, '/r');
    // After slice(0,10)+reverse: [500,500,100,100] — second half avg (100) < first half avg (500)
    expect(result.trend).toBe('faster');
  });

  it('returns stable when fewer than 4 data points', () => {
    const traces: Trace[] = [
      makeTrace({ route: '/r', duration: 100, status: 'ok' }),
      makeTrace({ route: '/r', duration: 900, status: 'ok' }),
    ];
    const result = getRouteHistory(traces, '/r');
    expect(result.trend).toBe('stable');
  });
});
