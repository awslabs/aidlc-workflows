// Metrics emission helper for AI-DLC audit events.
//
// Called from the shared metrics tap in aidlc-audit.ts immediately after
// structured audit writes, giving real-time coverage of both single and batch
// event appends. OPT-IN and DISABLED by default: it emits ONLY when
// AIDLC_METRICS_ENDPOINT is set. No endpoint is shipped in any harness's
// settings, so an untouched install emits nothing and the audit path is
// byte-unchanged.
//
// Sends a StatsD counter per event over HTTP to the configured endpoint:
//   <prefix>.<event_type>:1|c|#tag1:v1,...
// where <prefix> is AIDLC_METRICS_PREFIX (default "aidlc"). STAGE_COMPLETED /
// WORKFLOW_COMPLETED additionally emit token/cost magnitude lines built from the
// usage rollup fields aidlc-state.ts merged into the event (see aidlc-usage.ts).
//
// Always resolves (never throws). Metric loss is preferable to blocking or
// breaking the audit write that called us.
//
import { existsSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import {
  getField,
  harnessDir,
  resolveWorkflowSelection,
  stateFilePath,
} from "./aidlc-lib.ts";
import { compiledExecutable } from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

// ---------------------------------------------------------------------------
// Metric-name prefix
// ---------------------------------------------------------------------------

// The StatsD metric-name namespace. AIDLC_METRICS_PREFIX overrides the default
// "aidlc"; an empty/whitespace value falls back to "aidlc". Sanitised to a
// StatsD-safe token (StatsD metric names allow alnum, `.`, `_`, `-`). Dots are
// KEPT so a caller can namespace as e.g. "myorg.aidlc". Pure.
export function metricPrefix(): string {
  const raw = (process.env.AIDLC_METRICS_PREFIX ?? "").trim();
  const p = raw || "aidlc";
  return p.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// Tag resolution
// ---------------------------------------------------------------------------

// Resolved once at module load; failures fall back silently.
const _user = (() => {
  try { return userInfo().username || "unknown"; } catch { return "unknown"; }
})();

const _host = (() => {
  try { return hostname() || "unknown"; } catch { return "unknown"; }
})();

// Safely read scope from state file. Returns null on any failure (pre-init,
// missing file, etc.) - state may not exist yet for SESSION_STARTED events.
function readScope(projectDir: string): string | null {
  try {
    const p = stateFilePath(projectDir);
    if (!existsSync(p)) return null;
    const content = readFileSync(p, "utf-8");
    return getField(content, "Scope");
  } catch {
    return null;
  }
}

// Strip StatsD-reserved characters and other problematic chars from tag values.
// Strips |,#: (StatsD delimiters), + (SemVer build-metadata separator), / (a
// commonly normalised tag character), and whitespace.
function sanitizeTag(v: string): string {
  return v.replace(/[|,#:+/\s]/g, "_");
}

export interface MetricContext {
  env: string;
  space: string;
  scope: string | null;
  stage: string | null;
  phase: string | null;
  user: string;
  host: string;
  harness: string;
}

function resolveContext(
  fields: Record<string, string>,
  projectDir: string,
): MetricContext {
  const env = process.env.AIDLC_ENV ?? process.env.NODE_ENV ?? "dev";

  let space = "unknown";
  try {
    space = resolveWorkflowSelection(projectDir).space;
  } catch { /* pre-init */ }

  const stage = fields.Stage ?? null;
  const phase = fields.Phase ?? null;
  const scope = readScope(projectDir);

  return {
    env,
    space,
    scope,
    stage,
    phase,
    user: _user,
    host: _host,
    harness: harnessDir(),
  };
}

// ---------------------------------------------------------------------------
// StatsD payload
// ---------------------------------------------------------------------------

function toMetricName(eventType: string, prefix: string): string {
  // STAGE_STARTED => <prefix>.stage_started
  return `${prefix}.${eventType.toLowerCase()}`;
}

// covers: function:buildTagString
// The shared tag list for every StatsD line of one event, formatted as the
// comma-joined `#tag:value,...` body (WITHOUT the leading `#`). Pure. Both the
// counter line (buildStatsdLine) and the magnitude lines (buildMagnitudeLines)
// build on this so an event's tags stay identical across all its lines.
export function buildTagString(ctx: MetricContext): string {
  const tags: string[] = [
    `service:aidlc`,
    `env:${sanitizeTag(ctx.env)}`,
    `version:${sanitizeTag(AIDLC_VERSION)}`,
    `space:${sanitizeTag(ctx.space)}`,
    `harness:${sanitizeTag(ctx.harness)}`,
    `user:${sanitizeTag(ctx.user)}`,
    `host:${sanitizeTag(ctx.host)}`,
  ];
  if (ctx.scope) tags.push(`scope:${sanitizeTag(ctx.scope)}`);
  if (ctx.stage) tags.push(`stage:${sanitizeTag(ctx.stage)}`);
  if (ctx.phase) tags.push(`phase:${sanitizeTag(ctx.phase)}`);
  return tags.join(",");
}

function buildStatsdLine(metricName: string, ctx: MetricContext): string {
  return `${metricName}:1|c|#${buildTagString(ctx)}`;
}

// ---------------------------------------------------------------------------
// Magnitude lines - token/cost gauges + counters
//
// Alongside the unchanged `:1|c` counter, STAGE_COMPLETED / WORKFLOW_COMPLETED
// carry the per-stage usage rollup aidlc-state.ts merged into their audit
// `fields`. This turns those pre-computed field STRINGS into StatsD magnitude
// lines so tokens and spend can be graphed. Purely string parsing - NO
// transcript I/O, NO ledger read - so it stays microsecond-cheap under the
// audit lock.
// ---------------------------------------------------------------------------

// Parse a whole-number token field (e.g. "1234"); non-numeric / absent => null.
function parseIntField(v: string | undefined): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Parse a USD float field (e.g. "1.23"); non-numeric / absent => null.
function parseFloatField(v: string | undefined): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

// Parse a `By Model` / `By Agent` COST breakdown string -
// `opus-4-8=1.23; sonnet-4-6=0.45` - into [{key, usd}, ...]. Malformed segments
// and non-numeric costs (e.g. `unknown-model=null`, an unpriceable slice) are
// skipped, so an unknown model emits NO fabricated cost gauge. The key is
// sanitised for use as a tag value at emit time.
function parseBreakdown(v: string | undefined): { key: string; usd: number }[] {
  if (typeof v !== "string" || !v.trim()) return [];
  const out: { key: string; usd: number }[] = [];
  for (const seg of v.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const key = seg.slice(0, eq).trim();
    const usd = Number(seg.slice(eq + 1).trim());
    if (key && Number.isFinite(usd)) out.push({ key, usd });
  }
  return out;
}

// Un-abbreviate a compact token count (`12.3k` => 12300, `3.4M` => 3400000,
// `500` => 500). Inverse of aidlc-usage.ts fmtTokensCompact - the token
// breakdown fields carry compact strings, but StatsD counters want the whole
// number. Non-numeric => null.
function parseCompactTokens(s: string): number | null {
  const m = s.trim().match(/^([0-9]*\.?[0-9]+)([kM]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale = m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  return Math.round(n * scale);
}

// Parse a `Tokens By Model` / `Tokens By Agent` breakdown -
// `opus-4-8=12.3k/4.1k/2k/79.6k; main=...` - into per-key token quads
// {input, output, cacheRead, cacheWrite}. The quad order matches aidlc-usage.ts
// formatByTokens: input / output / cacheRead / cacheWrite. Lenient on arity: a
// 3-part legacy triple (input/output/cacheRead) is accepted with cacheWrite
// defaulting to 0; a 4-part quad is the current shape. Any other length or an
// unparseable count skips the segment.
function parseTokenBreakdown(
  v: string | undefined,
): { key: string; input: number; output: number; cacheRead: number; cacheWrite: number }[] {
  if (typeof v !== "string" || !v.trim()) return [];
  const out: {
    key: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[] = [];
  for (const seg of v.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const key = seg.slice(0, eq).trim();
    if (!key) continue;
    const parts = seg.slice(eq + 1).trim().split("/");
    if (parts.length !== 3 && parts.length !== 4) continue;
    const input = parseCompactTokens(parts[0]);
    const output = parseCompactTokens(parts[1]);
    const cacheRead = parseCompactTokens(parts[2]);
    // 3-part legacy triple => cacheWrite defaults to 0; 4-part quad parses it.
    const cacheWrite = parts.length === 4 ? parseCompactTokens(parts[3]) : 0;
    if (input === null || output === null || cacheRead === null || cacheWrite === null) continue;
    out.push({ key, input, output, cacheRead, cacheWrite });
  }
  return out;
}

// covers: function:buildMagnitudeLines
// Emit token/cost magnitude StatsD lines for an event that carries the usage
// rollup fields, under the given metric-name `prefix`. Tokens are counters
// (`|c`), cost is a gauge (`|g`). The aggregate lines carry the event's base
// `tags`; the `By Model` / `By Agent` COST breakdowns emit per-model / per-agent
// cost gauges, and the `Tokens By Model` / `Tokens By Agent` breakdowns emit
// per-model / per-agent TOKEN counters, each with an extra `model:<x>` /
// `agent:<x>` tag. The token counters cover input, output, cache.read AND
// cache.write. An event WITHOUT usage fields (i.e. no `Tokens In`) => `[]`, so
// ordinary events emit only their counter line. Purely string parsing - no I/O,
// no ledger read.
export function buildMagnitudeLines(
  _eventType: string,
  fields: Record<string, string>,
  tags: string,
  prefix: string,
): string[] {
  const tokensIn = parseIntField(fields["Tokens In"]);
  const tokensOut = parseIntField(fields["Tokens Out"]);
  const cacheRead = parseIntField(fields["Cache Read"]);
  const cacheWrite = parseIntField(fields["Cache Write"]);
  const costUsd = parseFloatField(fields["Cost USD"]);

  // No usage rollup on this event => nothing to emit. (Cost USD may be the
  // literal "null" - the unpriceable state - which parseFloatField maps to
  // null, so an unpriceable stage still emits its token lines below.)
  if (
    tokensIn === null &&
    tokensOut === null &&
    cacheRead === null &&
    cacheWrite === null &&
    costUsd === null
  ) {
    return [];
  }

  const lines: string[] = [];
  const suffix = tags ? `|#${tags}` : "";
  if (tokensIn !== null) lines.push(`${prefix}.tokens.input:${tokensIn}|c${suffix}`);
  if (tokensOut !== null) lines.push(`${prefix}.tokens.output:${tokensOut}|c${suffix}`);
  if (cacheRead !== null) lines.push(`${prefix}.cache.read:${cacheRead}|c${suffix}`);
  if (cacheWrite !== null) lines.push(`${prefix}.cache.write:${cacheWrite}|c${suffix}`);
  if (costUsd !== null) lines.push(`${prefix}.cost.usd:${costUsd}|g${suffix}`);

  // Per-model / per-agent COST gauges, tagged with the extra dimension.
  for (const { key, usd } of parseBreakdown(fields["By Model"])) {
    const t = tags ? `${tags},model:${sanitizeTag(key)}` : `model:${sanitizeTag(key)}`;
    lines.push(`${prefix}.cost.usd:${usd}|g|#${t}`);
  }
  for (const { key, usd } of parseBreakdown(fields["By Agent"])) {
    const t = tags ? `${tags},agent:${sanitizeTag(key)}` : `agent:${sanitizeTag(key)}`;
    lines.push(`${prefix}.cost.usd:${usd}|g|#${t}`);
  }

  // Per-model / per-agent TOKEN counters, tagged with the extra dimension.
  // Emitted from the token-breakdown fields, so tokens - not only cost - are
  // visible per model and per agent.
  for (const { key, input, output, cacheRead: cr, cacheWrite: cw } of parseTokenBreakdown(
    fields["Tokens By Model"],
  )) {
    const t = tags ? `${tags},model:${sanitizeTag(key)}` : `model:${sanitizeTag(key)}`;
    lines.push(`${prefix}.tokens.input:${input}|c|#${t}`);
    lines.push(`${prefix}.tokens.output:${output}|c|#${t}`);
    lines.push(`${prefix}.cache.read:${cr}|c|#${t}`);
    lines.push(`${prefix}.cache.write:${cw}|c|#${t}`);
  }
  for (const { key, input, output, cacheRead: cr, cacheWrite: cw } of parseTokenBreakdown(
    fields["Tokens By Agent"],
  )) {
    const t = tags ? `${tags},agent:${sanitizeTag(key)}` : `agent:${sanitizeTag(key)}`;
    lines.push(`${prefix}.tokens.input:${input}|c|#${t}`);
    lines.push(`${prefix}.tokens.output:${output}|c|#${t}`);
    lines.push(`${prefix}.cache.read:${cr}|c|#${t}`);
    lines.push(`${prefix}.cache.write:${cw}|c|#${t}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// HTTP dispatch via an unreferenced Bun worker
//
// Why a Bun subprocess and NOT an in-process fetch():
//
//  1. This runs under the audit lock. The structured append paths call
//     emitMetricForAuditEvent WHILE holding the OS-level audit lock (a ~5s retry
//     budget). The dispatch MUST return immediately or every audit write across
//     the framework stalls behind network latency. Bun.spawn().unref() hands the
//     request to a detached child without waiting for the network.
//
//  2. The tool process is short-lived. AI-DLC tools/hooks are per-invocation
//     `bun aidlc-*.ts` processes that frequently exit within milliseconds of
//     the audit write. Bun keeps an un-awaited fetch alive until its response,
//     adding collector latency to the caller; forcing exit can drop the request.
//     An unreferenced child outlives the parent and completes independently.
//
// In a source install the worker is this TypeScript module launched through Bun.
// In a compiled install the same executable handles a private worker route.
// Metrics therefore add no executable or package dependency beyond Bun itself.
// ---------------------------------------------------------------------------

const METRIC_WORKER_ARG = "--internal-metrics-send";

interface MetricDispatchEnvelope {
  endpoint: string;
  body: string;
  headers: string[];
}

// Optional extra HTTP headers from AIDLC_METRICS_HEADERS. Header values must
// not enter process argv or the child environment, where local process
// inspection can expose them. Blank lines are skipped; malformed headers fail
// best-effort in the worker's standard Headers parser.
function extraHeaderLines(): string[] {
  const raw = process.env.AIDLC_METRICS_HEADERS;
  if (!raw) return [];
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const h = line.trim();
    if (h) lines.push(h);
  }
  return lines;
}

function isMetricDispatchEnvelope(value: unknown): value is MetricDispatchEnvelope {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.endpoint === "string" &&
    obj.endpoint.length > 0 &&
    typeof obj.body === "string" &&
    Array.isArray(obj.headers) &&
    obj.headers.every((header) => typeof header === "string")
  );
}

export async function sendMetricFromStdin(): Promise<void> {
  try {
    const envelope: unknown = JSON.parse(await Bun.stdin.text());
    if (!isMetricDispatchEnvelope(envelope)) return;
    const headers = new Headers({ "Content-Type": "text/plain" });
    for (const line of envelope.headers) {
      const colon = line.indexOf(":");
      if (colon <= 0) return;
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const response = await fetch(envelope.endpoint, {
      method: "POST",
      headers,
      body: envelope.body,
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
  } catch {
    // Delivery is best-effort and never reports back into the audit caller.
  }
}

function metricWorkerCommand(): string[] {
  const executable = compiledExecutable();
  return executable
    ? [executable, METRIC_WORKER_ARG]
    : [process.execPath, fileURLToPath(import.meta.url), METRIC_WORKER_ARG];
}

function postMetric(endpoint: string, body: string): void {
  try {
    const envelope: MetricDispatchEnvelope = {
      endpoint,
      body,
      headers: extraHeaderLines(),
    };
    const childEnv = { ...process.env };
    for (const name of Object.keys(childEnv)) {
      const normalized = name.toUpperCase();
      if (
        normalized === "AIDLC_METRICS_HEADERS" ||
        normalized === "AIDLC_METRICS_ENDPOINT"
      ) {
        delete childEnv[name];
      }
    }
    const child = Bun.spawn(metricWorkerCommand(), {
      env: childEnv,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
    child.unref();
  } catch {
    // Transport setup is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Public entry point - called from aidlc-audit's shared metrics tap
// ---------------------------------------------------------------------------

export function emitMetricForAuditEvent(
  eventType: string,
  fields: Record<string, string>,
  projectDir: string,
): void {
  const metricsEndpoint = process.env.AIDLC_METRICS_ENDPOINT;
  if (!metricsEndpoint) return;

  try {
    const prefix = metricPrefix();
    const ctx = resolveContext(fields, projectDir);
    // The unchanged per-event counter line, plus any token/cost magnitude lines
    // when this event carries the usage rollup fields (STAGE/WORKFLOW_COMPLETED).
    // All lines share the event's tags and are POSTed together - a single
    // newline-separated StatsD body keeps this one detached spawn, still
    // microsecond-cheap under the audit lock (string parsing only, no I/O).
    const lines = [buildStatsdLine(toMetricName(eventType, prefix), ctx)];
    lines.push(...buildMagnitudeLines(eventType, fields, buildTagString(ctx), prefix));
    postMetric(metricsEndpoint, lines.join("\n"));
  } catch {
    // Never propagate - metric loss must not affect audit writes.
  }
}

if (import.meta.main && process.argv[2] === METRIC_WORKER_ARG) {
  void sendMetricFromStdin();
}
