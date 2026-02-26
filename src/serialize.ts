/**
 * Safe value serializer for the Span Inspector.
 * Converts any runtime value to a display string that is:
 *   - JSON pretty-printed where possible
 *   - Capped at MAX_CHARS to avoid flooding the span store
 *   - Resilient to circular references and unserializable objects
 */

const MAX_CHARS = 1000;

export function serializeValue(val: unknown): string | undefined {
  if (val === undefined) return undefined;
  if (val === null) return 'null';
  if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
  try {
    const s = typeof val === 'string'
      ? JSON.stringify(val)            // show strings with quotes so type is clear
      : JSON.stringify(val, null, 2);
    if (s === undefined) return String(val);
    if (s.length > MAX_CHARS) return s.slice(0, MAX_CHARS) + '\n… (truncated)';
    return s;
  } catch {
    // Circular reference or BigInt etc.
    try { return String(val); } catch { return '[unserializable]'; }
  }
}
