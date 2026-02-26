export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  startTime: number;       // Date.now()
  endTime?: number;
  duration?: number;       // ms
  status: 'running' | 'ok' | 'error';
  error?: string;
  type: 'http-incoming' | 'http-outgoing' | 'db' | 'function';
  attributes: Record<string, string | number | boolean>;
  /** Captured for function spans: each argument serialized */
  args?: string[];
  /** Captured for function spans: return value serialized (absent when void) */
  returnValue?: string;
  /** Captured for http-outgoing spans */
  request?: {
    headers: Record<string, string>;
    body?: string;
    bodyTruncated?: boolean;
  };
  /** Captured for http-outgoing spans */
  response?: {
    headers: Record<string, string>;
    body?: string;
    bodyTruncated?: boolean;
  };
}

export interface Trace {
  id: string;
  route: string;
  method: string;
  statusCode?: number;
  startTime: number;
  duration?: number;
  status: 'running' | 'ok' | 'error';
  spans: Span[];
  request?: {
    headers: Record<string, string>;
    body?: string;
    bodyTruncated?: boolean;
  };
  response?: {
    headers: Record<string, string>;
    body?: string;
    bodyTruncated?: boolean;
  };
}

export interface InitOptions {
  port?: number;
  maxTraces?: number;
  thresholds?: {
    green?: number;   // ms — default 200
    yellow?: number;  // ms — default 1000
  };
}

export interface TraceThisOptions {
  name?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceItOptions {
  name: string;
  attributes?: Record<string, string | number | boolean>;
}

/** @deprecated Use TraceItOptions */
export type WatchThisOptions = TraceItOptions;
