import type { Trace } from './types.js';

// ─── External dependency summary ───────────────────────────────────────────────

export interface ExternalDependency {
  host: string;
  callCount: number;
  totalDuration: number;
  avgDuration: number;
  slowestCall: number;
}

/**
 * Groups http-outgoing spans by hostname.
 * Sorted by totalDuration descending.
 */
export function getExternalDependencySummary(trace: Trace): ExternalDependency[] {
  const hostMap = new Map<string, { callCount: number; totalDuration: number; slowestCall: number }>();

  for (const span of trace.spans) {
    if (span.type !== 'http-outgoing') continue;

    // patches.ts stores host explicitly in attributes
    const host = String(span.attributes?.host ?? span.name).split('/')[0].split(':')[0] || span.name;
    const dur = span.duration ?? 0;

    const entry = hostMap.get(host) ?? { callCount: 0, totalDuration: 0, slowestCall: 0 };
    entry.callCount++;
    entry.totalDuration += dur;
    entry.slowestCall = Math.max(entry.slowestCall, dur);
    hostMap.set(host, entry);
  }

  return [...hostMap.entries()]
    .map(([host, data]) => ({
      host,
      callCount: data.callCount,
      totalDuration: data.totalDuration,
      avgDuration: Math.round(data.totalDuration / data.callCount),
      slowestCall: data.slowestCall,
    }))
    .sort((a, b) => b.totalDuration - a.totalDuration);
}

// ─── HTTP N+1 detection ────────────────────────────────────────────────────────

export interface HttpNPlusOnePattern {
  pattern: string;
  count: number;
}

export interface HttpNPlusOneSummary {
  hasNPlusOne: boolean;
  patterns: HttpNPlusOnePattern[];
}

/**
 * Normalises a URL path by replacing numeric segments and UUIDs with ?.
 * e.g. /users/123/orders → /users/?/orders
 */
function normalizeHttpPath(path: string): string {
  return path
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '?')
    .replace(/\/\d+/g, '/?')   // path segments: /users/123 → /users/?
    .replace(/=\d+/g, '=?')    // query params:  ?id=123    → ?id=?
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects N+1-style patterns in http-outgoing spans: 3+ calls to the same
 * host with the same normalised path pattern within a single trace.
 */
export function getHttpNPlusOne(trace: Trace): HttpNPlusOneSummary {
  const patternMap = new Map<string, number>();

  for (const span of trace.spans) {
    if (span.type !== 'http-outgoing') continue;

    const host = String(span.attributes?.host ?? '').split(':')[0];
    const path = String(span.attributes?.path ?? '');
    const key = host ? `${host}${normalizeHttpPath(path)}` : normalizeHttpPath(span.name);

    patternMap.set(key, (patternMap.get(key) ?? 0) + 1);
  }

  const patterns: HttpNPlusOnePattern[] = [...patternMap.entries()]
    .filter(([, count]) => count >= 3)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);

  return {
    hasNPlusOne: patterns.length > 0,
    patterns,
  };
}

// ─── DB summary ────────────────────────────────────────────────────────────────

export const SLOW_QUERY_THRESHOLD_MS = 100;

export interface DbQueryPattern {
  pattern: string;
  count: number;
  totalDuration: number;
  avgDuration: number;
  isNPlusOne: boolean;
  isSlow: boolean;
}

export interface DbSummary {
  totalQueries: number;
  totalDuration: number;
  patterns: DbQueryPattern[];
  hasNPlusOne: boolean;
  highDbTimeRatio: boolean;
  dbTimePct: number;
  hasSlowQuery: boolean;
  hasSequentialQueries: boolean;
  sequentialGroupCount: number;
}

/**
 * Replaces dynamic values (numbers, UUIDs, quoted strings) with ? to produce a
 * normalised query pattern for N+1 detection.
 */
function normalizeQuery(query: string): string {
  return query
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/'[^']*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

// Allow 5 ms of scheduling jitter before treating two spans as truly sequential
const SEQUENTIAL_JITTER_MS = 5;

/**
 * Counts parent-span groups where 2+ db spans ran one-after-another instead of
 * in parallel. Uses timing: if any consecutive pair (sorted by startTime) within
 * the same parent finished before the next one started, they were sequential.
 */
function countSequentialGroups(trace: Trace): number {
  const groups = new Map<string, Array<{ startTime: number; endTime: number }>>();

  for (const span of trace.spans) {
    if (span.type !== 'db' || span.endTime == null) continue;
    const key = span.parentId ?? '';
    const group = groups.get(key) ?? [];
    group.push({ startTime: span.startTime, endTime: span.endTime });
    groups.set(key, group);
  }

  let count = 0;
  for (const spans of groups.values()) {
    if (spans.length < 2) continue;
    const sorted = [...spans].sort((a, b) => a.startTime - b.startTime);
    const hasSequentialPair = sorted.some((span, i) =>
      i > 0 && sorted[i - 1].endTime <= span.startTime + SEQUENTIAL_JITTER_MS,
    );
    if (hasSequentialPair) count++;
  }
  return count;
}

/**
 * Returns the wall-clock time the process was "in the database" by merging
 * overlapping db span intervals. Parallel queries are counted once, not summed,
 * so the result is always ≤ the trace duration.
 */
function dbWallClockMs(trace: Trace): number {
  const intervals = trace.spans
    .filter(s => s.type === 'db' && s.endTime != null)
    .map(s => ({ start: s.startTime, end: s.endTime! }))
    .sort((a, b) => a.start - b.start);

  let covered = 0;
  let curEnd = -Infinity;
  for (const { start, end } of intervals) {
    if (start >= curEnd) {
      covered += end - start;
      curEnd = end;
    } else if (end > curEnd) {
      covered += end - curEnd;
      curEnd = end;
    }
  }
  return covered;
}

/**
 * Aggregates db spans. Flags any pattern that appears 3+ times as N+1.
 */
export function getDbSummary(trace: Trace): DbSummary {
  const patternMap = new Map<string, { count: number; totalDuration: number }>();
  let totalQueries = 0;
  let totalDuration = 0;

  for (const span of trace.spans) {
    if (span.type !== 'db') continue;
    totalQueries++;
    const dur = span.duration ?? 0;
    totalDuration += dur;

    const pattern = normalizeQuery(span.name);
    const entry = patternMap.get(pattern) ?? { count: 0, totalDuration: 0 };
    entry.count++;
    entry.totalDuration += dur;
    patternMap.set(pattern, entry);
  }

  const patterns: DbQueryPattern[] = [...patternMap.entries()]
    .map(([pattern, data]) => {
      const avgDuration = Math.round(data.totalDuration / data.count);
      return {
        pattern,
        count: data.count,
        totalDuration: data.totalDuration,
        avgDuration,
        isNPlusOne: data.count >= 3,
        isSlow: avgDuration >= SLOW_QUERY_THRESHOLD_MS,
      };
    })
    .sort((a, b) => b.totalDuration - a.totalDuration);

  const dbTimePct = (trace.duration && trace.duration > 0)
    ? Math.min(100, Math.round(dbWallClockMs(trace) / trace.duration * 100))
    : 0;

  const sequentialGroupCount = countSequentialGroups(trace);

  return {
    totalQueries,
    totalDuration,
    patterns,
    hasNPlusOne: patterns.some(p => p.isNPlusOne),
    highDbTimeRatio: dbTimePct >= 80 && totalQueries > 0,
    dbTimePct,
    hasSlowQuery: patterns.some(p => p.isSlow),
    hasSequentialQueries: sequentialGroupCount > 0,
    sequentialGroupCount,
  };
}

// ─── Route history ──────────────────────────────────────────────────────────────

export interface RouteHistory {
  route: string;
  durations: number[]; // up to 10 entries, oldest first
  trend: 'faster' | 'slower' | 'stable';
}

/**
 * Returns the last 10 completed durations for a given route (oldest first)
 * and a trend computed by comparing the first half average to the second half.
 * Trend thresholds: >10% slower → 'slower', <-10% → 'faster', otherwise 'stable'.
 */
export function getRouteHistory(traces: Trace[], route: string): RouteHistory {
  // getAllTraces() returns newest-first; we want oldest-first for the sparkline
  const routeTraces = traces
    .filter(t => t.route === route && t.status !== 'running' && t.duration != null)
    .slice(0, 10)
    .reverse(); // now oldest first

  const durations = routeTraces.map(t => t.duration!);

  let trend: 'faster' | 'slower' | 'stable' = 'stable';
  if (durations.length >= 4) {
    const half = Math.floor(durations.length / 2);
    const firstHalf = durations.slice(0, half);
    const secondHalf = durations.slice(durations.length - half);
    const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
    const diff = (secondAvg - firstAvg) / (firstAvg || 1);
    if (diff > 0.1) trend = 'slower';
    else if (diff < -0.1) trend = 'faster';
  }

  return { route, durations, trend };
}
