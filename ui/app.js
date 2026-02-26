/**
 * tracethis UI — vanilla JS, no framework, no build step.
 *
 * Connects to /api/stream via EventSource and renders:
 *   • left panel: list of recent traces (color-coded by duration)
 *   • right panel: three-tab detail panel + waterfall timeline
 *     - Tab 1: Summary (external deps, DB stats, N+1 warning, route sparkline)
 *     - Tab 2: Request / Response (headers + body)
 *     - Tab 3: Span Inspector (populated when a span is clicked)
 */

'use strict';

// ─── Config (match server defaults) ──────────────────────────────────────────
const THRESHOLDS = { green: 200, yellow: 1000 }; // ms

// ─── State ────────────────────────────────────────────────────────────────────
/** @type {Map<string, object>} traceId → Trace */
const traces = new Map();
/** @type {string[]} ordered newest-first */
let traceOrder = [];
let selectedTraceId = null;
let selectedSpanId  = null;
let currentTab      = 'summary';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const liveDot         = document.getElementById('liveDot');
const liveLabel       = document.getElementById('liveLabel');
const clearBtn        = document.getElementById('clearBtn');
const traceList       = document.getElementById('traceList');
const traceCount      = document.getElementById('traceCount');
const emptyState      = document.getElementById('emptyState');
const placeholder     = document.getElementById('placeholder');
const detail          = document.getElementById('detail');
const traceMeta       = document.getElementById('traceMeta');
const timelineRuler   = document.getElementById('timelineRuler');
const waterfallRows   = document.getElementById('waterfallRows');

// Tab elements
const tabBtns         = document.querySelectorAll('.tab-btn');
const tabSummary      = document.getElementById('tabSummary');
const tabRequest      = document.getElementById('tabRequest');
const tabInspector    = document.getElementById('tabInspector');

// Summary tab elements
const n1Banner        = document.getElementById('n1Banner');
const n1Patterns      = document.getElementById('n1Patterns');
const depsLoading     = document.getElementById('depsLoading');
const noDepsMsg       = document.getElementById('noDepsMsg');
const depTable        = document.getElementById('depTable');
const depTableBody    = document.getElementById('depTableBody');
const dbLoading       = document.getElementById('dbLoading');
const dbStats         = document.getElementById('dbStats');
const sparklineLoading = document.getElementById('sparklineLoading');
const sparklineRow    = document.getElementById('sparklineRow');

// Request/Response tab elements
const reqHeadersTable = document.getElementById('reqHeadersTable');
const resHeadersTable = document.getElementById('resHeadersTable');
const reqBody         = document.getElementById('reqBody');
const resBody         = document.getElementById('resBody');
const reqBodyTruncated = document.getElementById('reqBodyTruncated');
const resBodyTruncated = document.getElementById('resBodyTruncated');

// Span Inspector tab elements
const inspectorEmpty      = document.getElementById('inspectorEmpty');
const inspectorContent    = document.getElementById('inspectorContent');
const inspectorAttrs      = document.getElementById('inspectorAttrs');
const inspectorHttpIO     = document.getElementById('inspectorHttpIO');
const outReqHeadersTable  = document.getElementById('outReqHeadersTable');
const outResHeadersTable  = document.getElementById('outResHeadersTable');
const outReqBody          = document.getElementById('outReqBody');
const outResBody          = document.getElementById('outResBody');
const outResBodyTruncated = document.getElementById('outResBodyTruncated');

// ─── SSE ──────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('trace-updated', (e) => {
    const trace = JSON.parse(e.data);
    upsertTrace(trace);
  });

  es.onopen = () => {
    setLiveStatus('connected');
  };

  es.onerror = () => {
    setLiveStatus('error');
    setTimeout(() => {
      if (es.readyState !== EventSource.CLOSED) setLiveStatus('connecting');
    }, 3000);
  };
}

function setLiveStatus(status) {
  liveDot.className = `live-dot ${status}`;
  liveLabel.textContent = status;
}

// ─── Trace management ─────────────────────────────────────────────────────────
function upsertTrace(trace) {
  const isNew = !traces.has(trace.id);
  traces.set(trace.id, trace);

  if (isNew) {
    traceOrder = traceOrder.filter(id => id !== trace.id);
    traceOrder.unshift(trace.id);
    renderTraceRow(trace, true);
  } else {
    updateTraceRow(trace);
  }

  traceCount.textContent = traces.size;
  emptyState.style.display = 'none';

  if (selectedTraceId === trace.id) {
    renderWaterfall(trace);
    // Refresh request/response tab if it's active (data may have arrived)
    if (currentTab === 'request') {
      renderRequestResponseTab(trace);
    }
  }
}

// ─── Sidebar rendering ────────────────────────────────────────────────────────
function speedClass(duration) {
  if (duration == null) return 'running';
  if (duration < THRESHOLDS.green)  return 'fast';
  if (duration < THRESHOLDS.yellow) return 'medium';
  return 'slow';
}

function statusClass(code) {
  if (!code) return 'running';
  if (code < 300) return 's2xx';
  if (code < 400) return 's3xx';
  if (code < 500) return 's4xx';
  return 's5xx';
}

function formatDuration(ms) {
  if (ms == null) return '…';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function speedBarWidth(duration) {
  if (!duration) return 0;
  const pct = Math.min(100, (Math.log10(Math.max(1, duration)) / Math.log10(5000)) * 100);
  return pct.toFixed(1);
}

function renderTraceRow(trace, prepend = false) {
  const sc  = speedClass(trace.duration);
  const stc = statusClass(trace.statusCode);

  const li = document.createElement('li');
  li.className = 'trace-row';
  li.dataset.id = trace.id;
  li.innerHTML = traceRowHTML(trace, sc, stc);
  li.addEventListener('click', () => selectTrace(trace.id));

  if (prepend && traceList.firstChild !== emptyState) {
    traceList.insertBefore(li, traceList.firstChild);
  } else {
    if (traceList.contains(emptyState)) traceList.removeChild(emptyState);
    traceList.appendChild(li);
  }
}

function traceRowHTML(trace, sc, stc) {
  const dur   = formatDuration(trace.duration);
  const time  = formatTime(trace.startTime);
  const bw    = speedBarWidth(trace.duration);
  const code  = trace.statusCode ?? (trace.status === 'running' ? '…' : '');

  return `
    <div class="trace-row-top">
      <span class="trace-method ${trace.method}">${esc(trace.method)}</span>
      <span class="trace-route" title="${esc(trace.route)}">${esc(trace.route)}</span>
      <span class="trace-status ${stc}">${code}</span>
    </div>
    <div class="trace-row-bottom">
      <span class="trace-duration ${sc}">${dur}</span>
      <span class="trace-time">${time}</span>
    </div>
    <div class="trace-speed-bar ${sc}" style="width:${bw}%"></div>
  `;
}

function updateTraceRow(trace) {
  const li = traceList.querySelector(`[data-id="${trace.id}"]`);
  if (!li) return;
  const sc  = speedClass(trace.duration);
  const stc = statusClass(trace.statusCode);
  li.innerHTML = traceRowHTML(trace, sc, stc);
  li.addEventListener('click', () => selectTrace(trace.id));
  if (selectedTraceId === trace.id) li.classList.add('active');
}

// ─── Trace selection ──────────────────────────────────────────────────────────
function selectTrace(id) {
  if (selectedTraceId) {
    const prev = traceList.querySelector(`[data-id="${selectedTraceId}"]`);
    if (prev) prev.classList.remove('active');
  }
  selectedTraceId = id;
  const li = traceList.querySelector(`[data-id="${id}"]`);
  if (li) li.classList.add('active');

  const trace = traces.get(id);
  if (!trace) return;

  placeholder.hidden = true;
  detail.hidden = false;

  // Reset inspector state when switching traces
  selectedSpanId = null;
  clearInspector();

  // Default to Summary tab
  switchTab('summary');

  renderWaterfall(trace);
  loadSummaryTab(trace);
  renderRequestResponseTab(trace);
}

// ─── Tab management ──────────────────────────────────────────────────────────
function switchTab(name) {
  currentTab = name;

  tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });

  tabSummary.hidden   = name !== 'summary';
  tabRequest.hidden   = name !== 'request';
  tabInspector.hidden = name !== 'inspector';
}

// ─── Summary tab ──────────────────────────────────────────────────────────────
async function loadSummaryTab(trace) {
  // Reset loading states
  depsLoading.hidden = false;
  noDepsMsg.hidden = true;
  depTable.hidden = true;
  depTableBody.innerHTML = '';
  dbLoading.hidden = false;
  dbStats.hidden = true;
  sparklineLoading.hidden = false;
  sparklineRow.hidden = true;
  n1Banner.hidden = true;

  try {
    const summaryRes = await fetch(`/api/traces/${trace.id}/summary`);
    if (summaryRes.ok) {
      const { external, db } = await summaryRes.json();
      renderDependencies(external);
      renderDbStats(db);
    }
  } catch {
    depsLoading.hidden = true;
    dbLoading.hidden = true;
  }

  try {
    const historyRes = await fetch(`/api/routes/${encodeURIComponent(trace.route)}/history`);
    if (historyRes.ok) {
      const history = await historyRes.json();
      renderSparkline(history);
    }
  } catch {
    sparklineLoading.hidden = true;
  }
}

function renderDependencies(external) {
  depsLoading.hidden = true;
  if (!external || external.length === 0) {
    noDepsMsg.hidden = false;
    return;
  }
  depTable.hidden = false;
  depTableBody.innerHTML = '';
  for (const dep of external) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="host-col">${esc(dep.host)}</td>
      <td class="num-col">${dep.callCount}</td>
      <td class="num-col">${formatDuration(dep.totalDuration)}</td>
      <td class="num-col">${formatDuration(dep.avgDuration)}</td>
    `;
    depTableBody.appendChild(tr);
  }
}

function renderDbStats(db) {
  dbLoading.hidden = true;
  if (!db || db.totalQueries === 0) {
    dbStats.innerHTML = '<div class="no-data">No database queries</div>';
    dbStats.hidden = false;
    return;
  }

  let html = `
    <div class="db-stat-row">
      <span class="stat-key">Total queries</span>
      <span class="stat-val">${db.totalQueries}</span>
    </div>
    <div class="db-stat-row">
      <span class="stat-key">Total DB time</span>
      <span class="stat-val">${formatDuration(db.totalDuration)}</span>
    </div>
  `;
  dbStats.innerHTML = html;
  dbStats.hidden = false;

  // N+1 banner
  if (db.hasNPlusOne) {
    const n1s = db.patterns.filter(p => p.isNPlusOne);
    n1Patterns.innerHTML = n1s
      .map(p => `<div class="n1-pattern-row"><code>${esc(p.pattern)}</code> — ${p.count}×</div>`)
      .join('');
    n1Banner.hidden = false;
  }
}

function renderSparkline(history) {
  sparklineLoading.hidden = true;
  sparklineRow.hidden = false;

  const { durations, trend } = history;
  if (!durations || durations.length === 0) {
    sparklineRow.innerHTML = '<span class="no-data">No history yet</span>';
    return;
  }

  const trendColor = trend === 'faster' ? 'var(--green)' : trend === 'slower' ? 'var(--red)' : 'var(--gray)';
  const trendLabel = trend === 'faster' ? '↓ faster' : trend === 'slower' ? '↑ slower' : '→ stable';

  const w = 120, h = 32;
  const max = Math.max(...durations);
  const min = Math.min(...durations);
  const range = max - min || 1;
  const n = durations.length;

  const points = durations.map((d, i) => {
    const x = n > 1 ? (i / (n - 1)) * (w - 6) + 3 : w / 2;
    const y = h - 3 - ((d - min) / range) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const dots = durations.map((d, i) => {
    const x = n > 1 ? (i / (n - 1)) * (w - 6) + 3 : w / 2;
    const y = h - 3 - ((d - min) / range) * (h - 6);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${trendColor}"/>`;
  }).join('');

  sparklineRow.innerHTML = `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="flex-shrink:0">
      <polyline points="${points}" fill="none" stroke="${trendColor}" stroke-width="1.5"
        stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
    <span class="sparkline-trend" style="color:${trendColor}">${trendLabel}</span>
  `;
}

// ─── Request / Response tab ───────────────────────────────────────────────────
function renderRequestResponseTab(trace) {
  renderHeadersTable(reqHeadersTable, trace.request?.headers);
  renderHeadersTable(resHeadersTable, trace.response?.headers);

  renderBodyPanel(reqBody, reqBodyTruncated, trace.request?.body, trace.request?.bodyTruncated);
  renderBodyPanel(resBody, resBodyTruncated, trace.response?.body, trace.response?.bodyTruncated);
}

function renderHeadersTable(tableEl, headers) {
  const tbody = tableEl.querySelector('tbody');
  tbody.innerHTML = '';
  if (!headers || Object.keys(headers).length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="2" style="color:var(--text-dim);font-style:italic;font-size:11px">None captured</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const [k, v] of Object.entries(headers)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(k)}</td><td>${esc(String(v))}</td>`;
    tbody.appendChild(tr);
  }
}

function renderBodyPanel(preEl, truncatedEl, body, truncated) {
  if (!body) {
    preEl.textContent = '(none)';
    preEl.classList.add('empty');
    truncatedEl.hidden = true;
    return;
  }
  preEl.classList.remove('empty');
  // Try to pretty-print JSON
  try {
    const parsed = JSON.parse(body);
    preEl.textContent = JSON.stringify(parsed, null, 2);
  } catch {
    preEl.textContent = body;
  }
  truncatedEl.hidden = !truncated;
}

// ─── Span Inspector tab ───────────────────────────────────────────────────────
function openInspector(span, traceStartTime) {
  selectedSpanId = span.id;

  // Highlight selected span row
  waterfallRows.querySelectorAll('.span-row').forEach(r => r.classList.remove('selected'));
  const row = waterfallRows.querySelector(`[data-span-id="${span.id}"]`);
  if (row) row.classList.add('selected');

  switchTab('inspector');

  inspectorEmpty.hidden = true;
  inspectorContent.hidden = false;
  inspectorAttrs.innerHTML = '';

  const startOffset = span.startTime - traceStartTime;

  const entries = [
    ['name',     span.name],
    ['type',     span.type],
    ['status',   span.status],
    ['duration', formatDuration(span.duration)],
    ['start offset', formatDuration(startOffset)],
  ];

  // Type-specific enrichment
  if (span.type === 'http-outgoing') {
    const method   = span.attributes?.method ?? '';
    const host     = span.attributes?.host ?? '';
    const path     = span.attributes?.path ?? '';
    const protocol = span.attributes?.protocol ?? 'http';
    const url      = `${protocol}://${host}${path}`;
    const status   = span.attributes?.statusCode;
    if (url !== '://') entries.push(['url', url]);
    if (method)  entries.push(['method', method]);
    if (status)  entries.push(['response status', String(status)]);
  } else if (span.type === 'db') {
    const query = span.attributes?.query ?? span.name;
    entries.push(['query', query]);
    if (span.attributes?.db) entries.push(['db', String(span.attributes.db)]);
    if (span.attributes?.command) entries.push(['command', String(span.attributes.command)]);
  } else if (span.type === 'function') {
    for (const [k, v] of Object.entries(span.attributes ?? {})) {
      entries.push([k, v]);
    }
    if (span.args?.length) {
      if (span.args.length === 1) {
        entries.push(['argument', span.args[0]]);
      } else {
        span.args.forEach((a, i) => entries.push([`arg[${i}]`, a]));
      }
    }
    if (span.returnValue !== undefined) {
      entries.push(['return value', span.returnValue]);
    }
  } else {
    // http-incoming: show common attributes
    for (const [k, v] of Object.entries(span.attributes ?? {})) {
      entries.push([k, v]);
    }
  }

  if (span.error) entries.push(['error', span.error]);

  // Populate HTTP I/O section (request/response headers + body)
  if (span.type === 'http-outgoing' && (span.request || span.response)) {
    inspectorHttpIO.hidden = false;
    renderHeadersTable(outReqHeadersTable, span.request?.headers);
    renderHeadersTable(outResHeadersTable, span.response?.headers);
    renderBodyPanel(outReqBody, { hidden: true }, span.request?.body, false);
    renderBodyPanel(outResBody, outResBodyTruncated, span.response?.body, span.response?.bodyTruncated);
  } else {
    inspectorHttpIO.hidden = true;
  }

  for (const [k, v] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    const strVal = String(v ?? '');
    // Multi-line values (queries, errors) get a pre-styled block
    if (strVal.includes('\n') || strVal.length > 80) {
      dd.className = 'pre-val';
      dd.textContent = strVal;
    } else {
      dd.textContent = strVal;
    }
    if (k === 'error') dd.className = 'error-val';
    inspectorAttrs.appendChild(dt);
    inspectorAttrs.appendChild(dd);
  }
}

function clearInspector() {
  inspectorEmpty.hidden = false;
  inspectorContent.hidden = true;
  inspectorAttrs.innerHTML = '';
  inspectorHttpIO.hidden = true;
  waterfallRows.querySelectorAll('.span-row').forEach(r => r.classList.remove('selected'));
}

// ─── Waterfall rendering ──────────────────────────────────────────────────────
function renderWaterfall(trace) {
  renderTraceMeta(trace);

  const totalDuration = trace.duration ?? (Date.now() - trace.startTime);
  renderRuler(totalDuration);
  renderSpanRows(trace, totalDuration);
}

function renderTraceMeta(trace) {
  const sc  = speedClass(trace.duration);
  const stc = statusClass(trace.statusCode);
  const dur = formatDuration(trace.duration);

  traceMeta.innerHTML = `
    <span class="meta-badge method ${trace.method}">${esc(trace.method)}</span>
    <span class="meta-badge route">${esc(trace.route)}</span>
    ${trace.statusCode ? `<span class="meta-badge status ${stc}">${trace.statusCode}</span>` : ''}
    <span class="meta-badge">${formatTime(trace.startTime)}</span>
    <span class="meta-badge">${trace.spans.length} spans</span>
    <span class="meta-duration ${sc}">${dur}</span>
  `;
}

function renderRuler(totalMs) {
  timelineRuler.innerHTML = '';
  if (totalMs <= 0) return;

  const steps = 5;
  const stepMs = niceStep(totalMs / steps);

  for (let t = 0; t <= totalMs; t += stepMs) {
    const pct = (t / totalMs) * 100;
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = `${pct}%`;
    tick.style.position = 'absolute';
    tick.innerHTML = `
      <div class="ruler-tick-line"></div>
      <div class="ruler-tick-label">${t === 0 ? '0' : formatDuration(t)}</div>
    `;
    timelineRuler.appendChild(tick);
  }
}

function niceStep(ms) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(ms)));
  const normalized = ms / magnitude;
  if (normalized < 1.5) return magnitude;
  if (normalized < 3.5) return 2 * magnitude;
  if (normalized < 7.5) return 5 * magnitude;
  return 10 * magnitude;
}

function buildDepthMap(spans) {
  const depthMap = new Map();
  const parentMap = new Map(spans.map(s => [s.id, s.parentId]));

  function getDepth(id) {
    if (depthMap.has(id)) return depthMap.get(id);
    const parentId = parentMap.get(id);
    if (!parentId) { depthMap.set(id, 0); return 0; }
    const d = getDepth(parentId) + 1;
    depthMap.set(id, d);
    return d;
  }

  for (const span of spans) getDepth(span.id);
  return depthMap;
}

function renderSpanRows(trace, totalDuration) {
  waterfallRows.innerHTML = '';
  if (!trace.spans.length) return;

  const traceStart   = trace.startTime;
  const depthMap     = buildDepthMap(trace.spans);
  const safeDuration = Math.max(totalDuration, 1);

  for (const span of trace.spans) {
    const depth      = depthMap.get(span.id) ?? 0;
    const offsetMs   = span.startTime - traceStart;
    const durationMs = span.duration ?? (Date.now() - span.startTime);
    const leftPct    = (offsetMs / safeDuration) * 100;
    const widthPct   = Math.max((durationMs / safeDuration) * 100, 0.1);
    const isError    = span.status === 'error';
    const isRunning  = span.status === 'running';

    const row = document.createElement('div');
    row.className = `span-row${isError ? ' has-error' : ''}${selectedSpanId === span.id ? ' selected' : ''}`;
    row.dataset.spanId = span.id;

    const indentPx = depth * 14;

    row.innerHTML = `
      <div class="span-label">
        <span class="span-indent" style="display:inline-block;width:${indentPx}px;flex-shrink:0"></span>
        <span class="span-type-dot ${isError ? 'type-error' : 'type-' + span.type}"></span>
        <span class="span-name" title="${esc(span.name)}">${esc(span.name)}</span>
      </div>
      <div class="span-timeline">
        <div class="span-bar ${isError ? 'has-error' : ''} type-${span.type}${isRunning ? ' running' : ''}"
             style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%"
             title="${esc(span.name)} — ${formatDuration(span.duration)}">
          ${!isRunning ? `<span class="span-duration-label">${formatDuration(span.duration)}</span>` : ''}
        </div>
      </div>
    `;

    // Clicking a span switches to Span Inspector tab
    row.addEventListener('click', () => openInspector(span, traceStart));
    waterfallRows.appendChild(row);
  }
}

// ─── Misc utilities ──────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Tab bar clicks
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

clearBtn.addEventListener('click', () => {
  traces.clear();
  traceOrder = [];
  selectedTraceId = null;
  selectedSpanId  = null;
  currentTab      = 'summary';
  traceList.innerHTML = '';
  traceList.appendChild(emptyState);
  emptyState.style.display = '';
  traceCount.textContent = '0';
  placeholder.hidden = false;
  detail.hidden = true;
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
setLiveStatus('connecting');
connectSSE();
