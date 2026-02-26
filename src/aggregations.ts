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

// ─── DB summary ────────────────────────────────────────────────────────────────

export interface DbQueryPattern {
  pattern: string;
  count: number;
  totalDuration: number;
  isNPlusOne: boolean;
}

export interface DbSummary {
  totalQueries: number;
  totalDuration: number;
  patterns: DbQueryPattern[];
  hasNPlusOne: boolean;
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
    .map(([pattern, data]) => ({
      pattern,
      count: data.count,
      totalDuration: data.totalDuration,
      isNPlusOne: data.count >= 3,
    }))
    .sort((a, b) => b.totalDuration - a.totalDuration);

  return {
    totalQueries,
    totalDuration,
    patterns,
    hasNPlusOne: patterns.some(p => p.isNPlusOne),
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
