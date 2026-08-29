// aidlc-usage.ts - the single token-usage + cost extraction seam.
//
// One place owns: the model rate table (framework-default public list prices,
// overridable), the Claude transcript readers (main + sibling sub-agent files),
// the pure cost math, and the durable per-file-cursor ledger. Everything else
// (audit rollup fields, metrics magnitude lines, the statusline segment)
// CONSUMES this module and never re-parses a transcript itself.
//
// HARNESS SCOPE. The transcript reader is Claude-Code-format-specific: only the
// Claude harness wires a producer (the PreToolUse + PostToolUse fold hook and
// the Stop-hook flush). On Kiro / Codex / opencode no producer is wired, so the
// ledger is never written and every consumer here degrades silently to no-data:
// the statusline renders no cost segment, and the audit rollup adds no fields.
// See docs/reference/06-hooks-and-tools.md.
//
// ROBUSTNESS CONTRACT. Nothing here throws on malformed or missing input. A
// half-written last JSONL line is normal for a live transcript, so a bad line
// is skipped silently; an absent or corrupt file yields [] / a fresh empty
// ledger. Unknown model => tokens recorded, cost `null` - never a fabricated
// number.
//
// The verified transcript facts this module encodes (separate sub-agent files,
// .meta.json sidecars, per-token cache costs on the converse API, converse/ +
// region model prefixes, and the per-file cursor requirement - uuids collide
// across concurrent sub-agent files, so `(sourceFile, uuid)` is the only unique
// key) are documented in docs/reference/06-hooks-and-tools.md.

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  intentUuidForSelection,
  modelRatesPath,
  readSessionIntentUuid,
  resolveWorkflowSelection,
  sessionsDir,
  withAuditLock,
  writeFileAtomic,
} from "./aidlc-lib.ts";

// ===========================================================================
// Task 1 - Rate table + pure cost math (no transcript I/O)
// ===========================================================================

// A per-million-token price row. `input`/`output` price ordinary prompt and
// completion tokens; `cacheWrite5m`/`cacheWrite1h` price cache CREATION at the
// two ephemeral TTLs; `cacheRead` prices a cache HIT.
export type PriceRow = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

// FRAMEWORK-DEFAULT rates, USD / 1e6 tokens. These are PUBLIC Anthropic list
// prices, shipped as DEFAULTS only, and are the pure dev-checkout fallback used
// when no shipped `tools/data/model-rates.json` is present (an authored core/
// tree carries the JSON, so an installed harness always reads that). The cache
// fields follow the standard multipliers: cacheWrite5m = 1.25x input,
// cacheWrite1h = 2x input, cacheRead = 0.1x input.
//
// GENERATION-DISCRETE keys (a row per model GENERATION, NOT one per family):
// verified real sessions mix generations, and a family-collapse silently
// misprices them onto whatever the "current" row happens to be. Key off the
// generation token, not the account/region variant.
//
// To OVERRIDE: set AIDLC_MODEL_RATES to a rates file (same shape as
// tools/data/model-rates.json), or edit the shipped model-rates.json in your
// install. The override layers ON TOP of these defaults - a partial file only
// changes the models it names; an unknown model stays tokens-with-null-cost.
export const DEFAULT_RATES: Record<string, PriceRow> = {
  "opus-5": { input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.5 },
  "opus-4-8": { input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.5 },
  "opus-4-7": { input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.5 },
  "opus-4-6": { input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.5 },
  "sonnet-5": { input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.3 },
  "sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.3 },
  "haiku-4-5": { input: 1.0, output: 5.0, cacheWrite5m: 1.25, cacheWrite1h: 2.0, cacheRead: 0.1 },
  "fable-5": { input: 10.0, output: 50.0, cacheWrite5m: 12.5, cacheWrite1h: 20.0, cacheRead: 1.0 },
};

// Validate one parsed JSON object into a PriceRow, or null when it is not a
// well-formed row (any missing/non-finite field). Keeps a malformed override
// file from poisoning a real rate with NaN - the offending row is dropped and
// the default (or nothing) stands.
function coercePriceRow(raw: unknown): PriceRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const input = num(o.input);
  const output = num(o.output);
  const cacheWrite5m = num(o.cacheWrite5m);
  const cacheWrite1h = num(o.cacheWrite1h);
  const cacheRead = num(o.cacheRead);
  if (
    input === null ||
    output === null ||
    cacheWrite5m === null ||
    cacheWrite1h === null ||
    cacheRead === null
  ) {
    return null;
  }
  return { input, output, cacheWrite5m, cacheWrite1h, cacheRead };
}

// Read a rates file's `rates` map into overlay rows. Missing/corrupt/ill-shaped
// file => {} (no overlay). Never throws.
function readRatesFile(path: string): Record<string, PriceRow> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { rates?: unknown };
    const rates = parsed?.rates;
    if (!rates || typeof rates !== "object") return {};
    const out: Record<string, PriceRow> = {};
    for (const [key, value] of Object.entries(rates as Record<string, unknown>)) {
      const row = coercePriceRow(value);
      if (row) out[key] = row;
    }
    return out;
  } catch {
    return {};
  }
}

// The usage-tracking kill switch. Set AIDLC_DISABLE_USAGE_TRACKING=1 to stop
// the ledger producer from writing and every consumer from reading: the fold
// hooks and Stop-hook flush become no-ops, the statusline renders no cost
// segment, and STAGE_COMPLETED / WORKFLOW_COMPLETED add no rollup fields.
// Follows the AIDLC_DISABLE_* hook-flag convention (exact string "1"). Read at
// call time, never cached - each hook/tool is a fresh process, and tests
// toggle it mid-process.
export function usageTrackingDisabled(): boolean {
  return process.env.AIDLC_DISABLE_USAGE_TRACKING === "1";
}

let _rates: Record<string, PriceRow> | null = null;

// The effective rate table, built in three layers (each overlays the previous,
// per-model, so a partial file only changes the models it names):
//   1. DEFAULT_RATES        - hardcoded public list prices (the dev-checkout floor)
//   2. tools/data/model-rates.json - the shipped framework default (an install edits this)
//   3. $AIDLC_MODEL_RATES   - a user/project-supplied override file
// Cached at first use - a per-line computeCost never re-reads the files. Robust:
// a missing or malformed source contributes nothing and the layers below stand.
export function loadRates(): Record<string, PriceRow> {
  if (_rates !== null) return _rates;
  const merged: Record<string, PriceRow> = { ...DEFAULT_RATES };
  // Layer 2: the shipped default file (present in an installed harness; absent
  // in a dev checkout's core/, where DEFAULT_RATES is the only source).
  try {
    for (const [k, v] of Object.entries(readRatesFile(modelRatesPath()))) merged[k] = v;
  } catch {
    /* no shipped file / unresolvable data dir - DEFAULT_RATES stands */
  }
  // Layer 3: the AIDLC_MODEL_RATES override file, on top of everything.
  const override = process.env.AIDLC_MODEL_RATES;
  if (override) {
    for (const [k, v] of Object.entries(readRatesFile(override))) merged[k] = v;
  }
  _rates = merged;
  return _rates;
}

// TEST SEAM: drop the cached rate table so a test that mutates AIDLC_MODEL_RATES
// mid-process re-reads it. Not used at runtime (each tool/hook is a fresh
// process). Pure.
export function _resetRatesCacheForTest(): void {
  _rates = null;
}

// Bare family aliases with NO generation token. Matched only on an EXACT
// residual equality (never as a substring), so `opus` resolves but `opus-6`
// (a would-be new generation) does NOT match and stays null. These are a
// defensive convenience for hand-typed / test inputs; the wire form always
// carries a generation token. `opus`/`sonnet`/`haiku` map to the generation
// this harness ships as its default model set.
const BARE_ALIASES: Record<string, string> = {
  opus: "opus-4-8",
  sonnet: "sonnet-4-6",
  haiku: "haiku-4-5",
  fable: "fable-5",
};

// Map a transcript `message.model` to a rate-table key, or null if unknown.
//
// Handles the real Bedrock forms verified in transcripts:
//   converse/us.anthropic.claude-opus-4-8   (main thread)
//   us.anthropic.claude-opus-4-8            (some sub-agents)
//   claude-haiku-4-5-20251001               (sub-agent, dated, no region)
//   converse/au.anthropic.claude-haiku-4-5-20251001-v1:0
//   global.anthropic.claude-opus-4-8[1m]    (this harness's settings alias)
//
// UNKNOWN-GENERATION POLICY: a Claude model whose GENERATION is not in the rate
// table (e.g. a future `opus-6`, or an `opus-4-9` we haven't priced) returns
// `null` => the caller records the tokens but withholds cost. An honest
// "unknown" (made visible by the audit's `Cost USD: null`) beats a
// confidently-wrong number from an old generation's rate. `<synthetic>`, empty,
// malformed provider/model shapes, and non-Claude models => null too. Generation
// keys come from the EFFECTIVE rate table, so an AIDLC_MODEL_RATES override can
// add a new generation without a source-code matcher change.
export function normalizeModel(modelId: string): string | null {
  if (!modelId || typeof modelId !== "string") return null;
  let s = modelId.trim().toLowerCase();
  if (BARE_ALIASES[s]) return BARE_ALIASES[s];
  // 1. Drop a leading `converse/` provider tag. MUST run before step 2 - the
  //    region wildcard is anchored at the string start.
  const hadConversePrefix = s.startsWith("converse/");
  if (hadConversePrefix) s = s.slice("converse/".length);
  // 2. Drop an inference-profile region prefix + `anthropic.`. WILDCARDED:
  //    `<region>` is any `[a-z0-9-]+` token, so a new region (eu/apac/global/
  //    ... or one not yet seen) never silently breaks normalization. The
  //    `\.anthropic\.` anchor keeps the wildcard from eating a region-less model
  //    (bare `claude-opus-4-8` has no `.anthropic.`, so it is untouched here).
  const provider = s.match(/^(?:[a-z0-9-]+\.)?anthropic\./);
  if (provider) {
    s = s.slice(provider[0].length);
  } else if (hadConversePrefix) {
    return null;
  }
  // 3. Accept only a real Anthropic/Claude shape or one of the documented bare
  // family aliases handled above. Exact rate keys are not wire model IDs:
  // accepting them after `converse/` or `anthropic.` would price malformed
  // provider shapes such as `converse/opus-4-8`.
  const rates = loadRates();
  if (!s.startsWith("claude-")) return null;
  s = s.slice("claude-".length);

  // 4. Match a generation key only at a token boundary. Keys are longest-first
  // so an override containing related keys resolves the most specific one.
  for (const key of Object.keys(rates).sort((a, b) => b.length - a.length)) {
    if (s === key || s.startsWith(`${key}-`) || s.startsWith(`${key}[`)) {
      return key;
    }
  }
  // Unknown generation / non-Claude => null (tokens recorded, cost withheld).
  return null;
}

// The token magnitudes we price. Cache creation is split by ephemeral TTL;
// cache reads are a single bucket.
export type TokenCounts = {
  input: number;
  output: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
};

// Price a token bundle for a model. Unknown model => `{ usd: null, model: null }`
// (tokens are preserved by the caller; only the cost is withheld). Cache reads
// price at `cacheRead`; cache creation splits across the 5m / 1h rows.
export function computeCost(
  counts: TokenCounts,
  modelId: string,
): { usd: number | null; model: string | null } {
  const key = normalizeModel(modelId);
  if (!key) return { usd: null, model: null };
  const r = loadRates()[key];
  if (!r) return { usd: null, model: null };
  const usd =
    (counts.input / 1e6) * r.input +
    (counts.output / 1e6) * r.output +
    (counts.cacheCreate5m / 1e6) * r.cacheWrite5m +
    (counts.cacheCreate1h / 1e6) * r.cacheWrite1h +
    (counts.cacheRead / 1e6) * r.cacheRead;
  return { usd, model: key };
}

// One priced assistant turn. `sourceKey` identifies the file the row came from
// (`"main"` or `"agent-<agentId>"`) and is the PER-FILE cursor key in Task 3.
// `agentId` is filled during extraction (Task 2) for sub-agent rows; `agentType`
// is filled during attribution (Task 4).
export type UsageRow = {
  uuid: string;
  // The Claude `message.id`. Claude Code splits ONE llm call (one message.id)
  // across MULTIPLE JSONL lines - one per content block (thinking/text/tool_use)
  // - stamping the SAME `message.usage` on every line. `msgId` lets
  // dedupeByMessageId collapse a contiguous run of same-id lines into ONE row so
  // the shared usage is counted ONCE, not 2-3x. `""` when a line carries no
  // `message.id` (hand-authored fixtures, older transcripts): an id-less row is
  // NEVER merged - each such line stays its own row.
  msgId: string;
  timestamp: string;
  model: string;
  isSidechain: boolean;
  sourceKey: string;
  agentId: string | null;
  agentType: string | null;
  counts: TokenCounts;
  usd: number | null;
};

// ===========================================================================
// Task 2 - Transcript extraction (Claude main + sub-agent files)
// ===========================================================================

// Parse one JSONL object's `message.usage` into a TokenCounts. The 5m/1h split
// lives under `cache_creation`; when that object is absent we treat the flat
// `cache_creation_input_tokens` total as 5m (its pre-split form).
function countsFromUsage(usage: Record<string, unknown>): TokenCounts {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cc = (usage.cache_creation ?? {}) as Record<string, unknown>;
  const e5 = num(cc.ephemeral_5m_input_tokens);
  const e1 = num(cc.ephemeral_1h_input_tokens);
  const flat = num(usage.cache_creation_input_tokens);
  // Trust the nested 5m/1h split only when it actually accounts for cache
  // creation. Bedrock's converse API ships the split present-but-zeroed with
  // the real total in the flat cache_creation_input_tokens field; native
  // Anthropic always has flat == e5 + e1, so this is a no-op there. When the
  // split is absent or zeroed we fall back to the flat total, attributing it
  // to 5m: the harness only ever issues 5m-TTL cache writes, so a Bedrock
  // creation is a 5m write in practice. (A hypothetical 1h Bedrock write
  // would be under-priced at the 5m rate - but that beats the old behavior,
  // which dropped the flat value entirely and priced the write at zero.)
  const splitSum = e5 + e1;
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheCreate5m: splitSum > 0 ? e5 : flat,
    cacheCreate1h: splitSum > 0 ? e1 : 0,
    cacheRead: num(usage.cache_read_input_tokens),
  };
}

// Parse ONE JSONL line into a UsageRow, or null when it is not a priced
// assistant turn (non-assistant, no usage, malformed). Pure - the shared per-
// line parse used by both the whole-file reader (readClaudeTranscript) and the
// offset-aware fold reader. `sourceKey`/`fallbackAgentId` supply the file
// identity when the line does not carry its own `agentId`.
function parseTranscriptLine(
  line: string,
  sourceKey: string,
  fallbackAgentId: string | null,
): UsageRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null; // half-written / malformed line - skip, don't throw
  }
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;
  if (message.role !== "assistant") return null;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const counts = countsFromUsage(usage);
  const model = typeof message.model === "string" ? message.model : "";
  const agentId =
    typeof obj.agentId === "string" ? obj.agentId : fallbackAgentId;
  return {
    uuid: typeof obj.uuid === "string" ? obj.uuid : "",
    msgId: typeof message.id === "string" ? message.id : "",
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
    model,
    isSidechain: obj.isSidechain === true,
    sourceKey,
    agentId,
    agentType: null,
    counts,
    usd: computeCost(counts, model).usd,
  };
}

// covers: function:dedupeByMessageId
// Collapse the split-line overcount (the CRITICAL bug): Claude Code writes one
// llm call (one `message.id`) as MULTIPLE contiguous JSONL lines - one per
// content block (thinking/text/tool_use). Left alone that inflates input ~2x and
// output ~2.6x. Verified invariants this relies on: (a) split lines of one
// message.id are always CONTIGUOUS; (b) the group's usage must be taken ONCE.
//
// TWO transcript styles exist (both handled by taking the group's usage as the
// MAXIMUM-usage line of the run):
//   OLD-style: every split line repeats the SAME usage => max == any line.
//   NEW-style: leading lines (thinking/text) carry usage=0; the REAL usage
//     appears on the LAST line(s) of the run (identical when several trail) =>
//     max == that real-usage line, so the zeros never mask the real count.
// The representative is the max-usage row (ties => the LAST such row, so its
// uuid/timestamp is the real end-of-turn line and the per-file cursor advances
// correctly). On OLD-style all lines tie so this is the last line, matching the
// prior behaviour exactly.
//
// FALLBACK: a row with an empty `msgId` (no `message.id` - hand-authored
// fixtures, older transcripts) is NEVER merged; each such row passes through
// as-is, preserving one-row-per-line behaviour. A `seen` Set guards against a
// (non-contiguous) reappearance of an already-emitted non-empty msgId so a
// second run of the same id can never double-count. Pure.
export function dedupeByMessageId(rows: UsageRow[]): UsageRow[] {
  const out: UsageRow[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!row.msgId) {
      // Id-less line - never merged, always its own row.
      out.push(row);
      i++;
      continue;
    }
    if (seen.has(row.msgId)) {
      // A non-contiguous reappearance of an already-collapsed id - drop it (its
      // usage was already counted once). Defensive; verified runs are contiguous.
      i++;
      continue;
    }
    // Consume the contiguous run sharing this msgId; take the group's usage ONCE
    // from the MAX-usage line (ties => last, the real end-of-turn line).
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].msgId === row.msgId) j++;
    seen.add(row.msgId);
    out.push(representativeOfRun(rows, i, j));
    i = j + 1;
  }
  return out;
}

// The representative of a contiguous same-msgId run `rows[start..end]`: the row
// with the greatest total usage magnitude, breaking ties toward the LAST such
// row. This is what makes both transcript styles collapse losslessly - NEW-style
// leading usage=0 lines lose to the trailing real-usage line, OLD-style ties
// resolve to the last line (the real end-of-turn uuid/timestamp). Pure.
function representativeOfRun(rows: UsageRow[], start: number, end: number): UsageRow {
  let best = rows[start];
  let bestMag = usageMagnitude(best.counts);
  for (let k = start + 1; k <= end; k++) {
    const mag = usageMagnitude(rows[k].counts);
    if (mag >= bestMag) {
      // `>=` breaks ties toward the later row (real end-of-turn line).
      best = rows[k];
      bestMag = mag;
    }
  }
  return best;
}

// Total token magnitude of a bundle - the tie-break/selection key for a split
// run's representative. Sums every priced magnitude so a line carrying real
// usage always outranks a leading usage=0 line. Pure.
function usageMagnitude(c: TokenCounts): number {
  return c.input + c.output + c.cacheCreate5m + c.cacheCreate1h + c.cacheRead;
}

// Read a single Claude JSONL transcript into priced UsageRows. `opts.sourceKey`
// and `opts.agentId` default to a main-thread read; readClaudeSession supplies
// the sub-agent identity. Emits one row per assistant LLM CALL (message.id) -
// contiguous split lines sharing a message.id are collapsed via
// dedupeByMessageId so the shared usage is counted once. Malformed lines (incl.
// a half-written trailing line) are skipped silently - never throws on a bad
// line or a missing file.
export function readClaudeTranscript(
  path: string,
  opts?: { sourceKey?: string; agentId?: string | null },
): UsageRow[] {
  const sourceKey = opts?.sourceKey ?? "main";
  const fallbackAgentId = opts?.agentId ?? null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const rows: UsageRow[] = [];
  for (const line of raw.split("\n")) {
    const row = parseTranscriptLine(line, sourceKey, fallbackAgentId);
    if (row) rows.push(row);
  }
  return dedupeByMessageId(rows);
}

// Resolve the sibling `subagents/` directory for a main transcript. Layout:
// main is `<projects>/<slug>/<session>.jsonl`; sub-agents are
// `<projects>/<slug>/<session>/subagents/agent-<agentId>.jsonl`.
export function subagentDir(mainTranscriptPath: string): string {
  const dir = dirname(mainTranscriptPath);
  const session = basename(mainTranscriptPath).replace(/\.jsonl$/, "");
  return join(dir, session, "subagents");
}

// Read one `agent-<id>.meta.json` sidecar; return its parsed object or null.
function readMetaSidecar(jsonlPath: string): { agentType?: string } | null {
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as { agentType?: string };
  } catch {
    return null;
  }
}

// Read a full Claude session: the main transcript plus every sibling
// `subagents/agent-*.jsonl`. Main rows carry `agentId: null`,
// `sourceKey: "main"`; sub-agent rows carry their file's `agentId` and
// `sourceKey: "agent-<agentId>"`. Each sub-agent's `.meta.json` sidecar is read
// for its `agentType`, and agent attribution (Task 4) is applied before
// returning. A missing `subagents/` dir => just the main rows. Never throws.
export function readClaudeSession(mainPath: string): UsageRow[] {
  const rows: UsageRow[] = readClaudeTranscript(mainPath, {
    sourceKey: "main",
    agentId: null,
  });
  const metaByAgentId: Record<string, string> = {};
  const subDir = subagentDir(mainPath);
  let entries: string[] = [];
  try {
    if (existsSync(subDir)) {
      entries = readdirSync(subDir).filter(
        (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
      );
    }
  } catch {
    entries = [];
  }
  for (const file of entries) {
    const agentId = file.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    const full = join(subDir, file);
    const meta = readMetaSidecar(full);
    if (meta && typeof meta.agentType === "string" && meta.agentType) {
      metaByAgentId[agentId] = meta.agentType;
    }
    rows.push(
      ...readClaudeTranscript(full, {
        sourceKey: `agent-${agentId}`,
        agentId,
      }),
    );
  }
  return attributeAgents(rows, metaByAgentId);
}

// Sniff the transcript format from its first non-empty line and dispatch.
// Claude lines carry `message`/`uuid` => readClaudeSession. Any other shape
// (empty, non-Claude) => []. Only the Claude Code transcript format is
// supported - Kiro/Codex/opencode wire no producer, so their transcripts (if
// any) are never read here.
export function readTranscript(path: string): UsageRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if ("message" in obj || "uuid" in obj) {
      return readClaudeSession(path);
    }
    // Sniffed a line we don't recognise - keep looking at subsequent lines.
  }
  return [];
}

// ===========================================================================
// Task 4 - Agent-type attribution (declared before Task 3's fold so
// readClaudeSession can call it)
// ===========================================================================

// Attribute each row to an agentType. Main-thread rows => "main". Sub-agent rows
// => the sidecar `agentType` for their agentId, falling back to "subagent" when
// no sidecar/field exists (never null, never dropped). Pure.
export function attributeAgents(
  rows: UsageRow[],
  metaByAgentId: Record<string, string>,
): UsageRow[] {
  for (const row of rows) {
    if (row.sourceKey === "main") {
      row.agentType = "main";
    } else {
      const id = row.agentId ?? "";
      row.agentType = metaByAgentId[id] ?? "subagent";
    }
  }
  return rows;
}

// Fallback join: build `agentId -> subagent_type` from a parent transcript's
// lines. A `Task`/`Agent` tool_use carries an `id` (tool_use_id) and
// `input.subagent_type`; the matching `toolUseResult` line carries `agentId`
// for that same tool_use_id. Used ONLY for agentIds absent from the sidecar map
// (the sidecar `agentType` is present in ~100% of sampled sidecars; `toolUseId`
// only ~86%). Never throws.
export function buildAgentTypeMapFromParent(
  parentLines: string[],
): Record<string, string> {
  const typeByToolUseId: Record<string, string> = {};
  const map: Record<string, string> = {};
  for (const line of parentLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    // (a) Collect subagent_type per tool_use id from assistant tool_use blocks.
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (
          b.type === "tool_use" &&
          (b.name === "Task" || b.name === "Agent") &&
          typeof b.id === "string"
        ) {
          const input = (b.input ?? {}) as Record<string, unknown>;
          if (typeof input.subagent_type === "string") {
            typeByToolUseId[b.id] = input.subagent_type;
          }
        }
      }
    }
    // (b) Join a toolUseResult's agentId back to the tool_use's subagent_type.
    const tur = obj.toolUseResult as Record<string, unknown> | undefined;
    const toolUseId =
      typeof obj.tool_use_id === "string"
        ? obj.tool_use_id
        : typeof tur?.tool_use_id === "string"
          ? (tur.tool_use_id as string)
          : undefined;
    const agentId =
      typeof tur?.agentId === "string" ? (tur.agentId as string) : undefined;
    if (toolUseId && agentId && typeByToolUseId[toolUseId]) {
      map[agentId] = typeByToolUseId[toolUseId];
    }
  }
  return map;
}

// ===========================================================================
// Task 3 - Per-file-cursor ledger
// ===========================================================================

// Summed token magnitudes + total USD for a bucket.
export type Totals = {
  tokens: TokenCounts;
  usd: number;
};

// A per-stage bucket. `totals` is the flat stage sum; `byModel`/`byAgent` are
// the stage's OWN per-model / per-agent sub-splits - stage-scoped, NOT the
// global session buckets. This is what lets STAGE_COMPLETED show a By Model line
// that agrees with its stage-scoped Cost USD (a global By Model would sum every
// stage and contradict a single-stage cost).
export type StageBucket = {
  totals: Totals;
  byModel: Record<string, Totals>;
  byAgent: Record<string, Totals>;
};

// One aggregate at a particular ownership boundary. The top-level ledger keeps
// a workspace aggregate for diagnostics, while `workflows[workflow].sessions`
// provides the authoritative workflow/session intersection.
export type UsageAggregate = {
  totals: Totals;
  byStage: Record<string, StageBucket>;
  byModel: Record<string, Totals>;
  byAgent: Record<string, Totals>;
};

export type WorkflowUsage = UsageAggregate & {
  sessions: Record<string, UsageAggregate>;
};

// The current on-disk ledger schema version. BUMP THIS whenever the token
// COUNTING semantics change so old, differently-counted totals are discarded
// rather than re-added onto. v2 is the first schema whose totals were produced
// by the HOLDBACK fold (a group is counted once, when provably complete); every
// pre-v2 ledger was produced by the buggy per-split-line counter (input ~2x,
// output ~2.6x inflated), so its totals are unreliable and loadLedger resets
// them (see the migration in loadLedger). v3 adds session/intent ownership and
// pending-group attribution; v2's workspace-only totals cannot be partitioned
// retrospectively, so they are rebuilt too.
const CURRENT_SCHEMA_VERSION = 3 as const;

// The durable rollup. `cursors` is keyed by SOURCE FILE identity - the OFFSET
// FOLD (foldFileIntoLedger) keys each cursor by the transcript FILE PATH (the
// main transcript's path; each sub-agent file's full path), which is unique
// ACROSS sessions so a cumulative workspace ledger never reuses one session's
// byteOffset against a different session's file. The row-based updateLedger -
// which has no file path - keys by the row's `sourceKey` (`"main"` /
// `"agent-<agentId>"`) instead; the two schemes coexist without collision
// because a file path never equals `"main"`. Verified: uuids collide across
// concurrent sub-agent files, so a global-uuid cursor would drop real turns or
// count the 0-token broadcast copies - per-file cursors are the whole mechanism.
// `byStage` carries stage-scoped sub-splits (StageBucket); top-level totals and
// splits span the workspace and are diagnostic only.
export type LedgerCursor = {
  lastUuid: string;
  lastTimestamp: string;
  // Byte position in the source file already folded. The offset-aware fold
  // reads only bytes `[byteOffset, size)` each call.
  byteOffset?: number;
  // The `message.id` of the last folded group (diagnostics only).
  lastMessageId?: string;
  // A non-flush fold retains the last message group. Its ownership is captured
  // NOW, before a lifecycle tool can advance state, and reused when the group
  // is eventually folded.
  pending?: {
    byteOffset: number;
    messageId: string;
    stageSlug: string | null;
    sessionKey: string;
    workflowKey: string;
  };
};

export type Ledger = UsageAggregate & {
  // Schema version of the totals below. Absent/`< CURRENT_SCHEMA_VERSION` on
  // disk => produced by an older, differently-counted fold => loadLedger
  // discards it and rebuilds from the transcript.
  schemaVersion: number;
  cursors: Record<string, LedgerCursor>;
  workflows: Record<string, WorkflowUsage>;
};

function emptyTokenCounts(): TokenCounts {
  return { input: 0, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 };
}

function emptyTotals(): Totals {
  return { tokens: emptyTokenCounts(), usd: 0 };
}

function emptyStageBucket(): StageBucket {
  return { totals: emptyTotals(), byModel: {}, byAgent: {} };
}

function emptyUsageAggregate(): UsageAggregate {
  return { totals: emptyTotals(), byStage: {}, byModel: {}, byAgent: {} };
}

function emptyLedger(): Ledger {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    cursors: {},
    ...emptyUsageAggregate(),
    workflows: {},
  };
}

// The gitignored runtime ledger path: `aidlc/.aidlc-sessions/usage-ledger.json`.
export function ledgerPath(projectDir: string): string {
  return join(sessionsDir(projectDir), "usage-ledger.json");
}

export type UsageContext = {
  sessionId?: string;
  sessionKey?: string;
  workflowKey?: string;
};

// The transcript path is the stable session identity available to both the fold
// hook and statusline. A caller without a transcript can supply an explicit
// session key (the row-based test/utility seam) or fall back to session_id.
export function sessionUsageKey(
  transcriptPath?: string,
  sessionId?: string,
): string {
  const transcript = transcriptPath?.trim();
  if (transcript) return `transcript:${transcript}`;
  const session = safeSessionSegment(sessionId ?? "");
  return session ? `session:${session}` : "session:unknown";
}

// Resolve the active intent to a stable UUID when possible. Legacy/orphan
// records fall back to their space + record-dir identity.
export function intentUsageKey(
  projectDir: string,
  sessionId?: string,
): string {
  try {
    if (sessionId) {
      const stamped = readSessionIntentUuid(projectDir, sessionId);
      if (stamped) return `intent:${stamped}`;
    }
    const selection = resolveWorkflowSelection(projectDir, { sessionId });
    const uuid = intentUuidForSelection(projectDir, selection);
    if (uuid) return `intent:${uuid}`;
    return `record:${selection.space}/${selection.intent ?? "legacy"}`;
  } catch {
    return "record:default/legacy";
  }
}

// Coerce a possibly-old-shape byStage map into the StageBucket shape. An older
// ledger stored a flat Totals per stage; treat that as `{ totals, byModel:{},
// byAgent:{} }`. A missing sub-map on a new-shape entry becomes {}. Never throws.
function normalizeByStage(
  raw: Record<string, unknown> | undefined,
): Record<string, StageBucket> {
  const out: Record<string, StageBucket> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [slug, val] of Object.entries(raw)) {
    const v = (val ?? {}) as Record<string, unknown>;
    if (v.totals && typeof v.totals === "object") {
      // New shape (StageBucket) - tolerate missing sub-maps.
      out[slug] = {
        totals: v.totals as Totals,
        byModel: (v.byModel as Record<string, Totals>) ?? {},
        byAgent: (v.byAgent as Record<string, Totals>) ?? {},
      };
    } else if (v.tokens && typeof v.tokens === "object") {
      // Old shape (flat Totals) - wrap it, no per-model/agent history available.
      out[slug] = { totals: v as unknown as Totals, byModel: {}, byAgent: {} };
    } else {
      out[slug] = emptyStageBucket();
    }
  }
  return out;
}

function normalizeUsageAggregate(raw: unknown): UsageAggregate {
  if (!raw || typeof raw !== "object") return emptyUsageAggregate();
  const value = raw as Partial<UsageAggregate> & {
    byStage?: Record<string, unknown>;
  };
  return {
    totals: value.totals ?? emptyTotals(),
    byStage: normalizeByStage(value.byStage),
    byModel: value.byModel ?? {},
    byAgent: value.byAgent ?? {},
  };
}

function normalizeAggregateMap(
  raw: Record<string, unknown> | undefined,
): Record<string, UsageAggregate> {
  const out: Record<string, UsageAggregate> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    out[key] = normalizeUsageAggregate(value);
  }
  return out;
}

function normalizeWorkflowMap(
  raw: Record<string, unknown> | undefined,
): Record<string, WorkflowUsage> {
  const out: Record<string, WorkflowUsage> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const aggregate = normalizeUsageAggregate(value);
    const sessions =
      value && typeof value === "object"
        ? normalizeAggregateMap(
            (value as { sessions?: Record<string, unknown> }).sessions,
          )
        : {};
    out[key] = { ...aggregate, sessions };
  }
  return out;
}

// Whether an on-disk ledger's cursors are all pre-v2 shaped (belt-and-suspenders
// migration signal). A current fold cursor ALWAYS carries a numeric
// `byteOffset`; a
// pre-v2 ledger's cursors carry only `lastUuid`/`lastMessageId`. If ANY cursor
// lacks a byteOffset the totals below it were produced (at least partly) by the
// legacy per-line counter, so we treat the whole ledger as pre-v2. An empty
// cursors map is NOT a downgrade signal (a fresh ledger has none yet); the
// schemaVersion check is authoritative there.
function cursorsLackByteOffset(
  cursors: Record<string, unknown> | undefined,
): boolean {
  if (!cursors || typeof cursors !== "object") return false;
  for (const c of Object.values(cursors)) {
    if (
      c === null ||
      typeof c !== "object" ||
      typeof (c as { byteOffset?: unknown }).byteOffset !== "number"
    ) {
      return true;
    }
  }
  return false;
}

// Load the ledger, or a fresh empty one on missing/corrupt/invalid-shape input
// (rebuild-on-corruption). Never throws, logs nothing.
//
// MIGRATION. A ledger whose on-disk `schemaVersion` is missing or
// `< CURRENT_SCHEMA_VERSION` - or (belt-and-suspenders) whose cursors lack a
// numeric byteOffset - had its totals produced by the buggy per-split-line
// counter. Those totals are UNRELIABLE and must not be re-added onto, so we
// DISCARD the whole file and return a fresh current-schema ledger; the next fold
// rebuilds totals/byStage/byModel/byAgent/cursors cleanly from the
// transcript(s). This resets, rather than migrates, because the old numbers
// cannot be corrected in place.
export function loadLedger(projectDir: string): Ledger {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(projectDir), "utf-8");
  } catch {
    return emptyLedger();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger> & {
      byStage?: Record<string, unknown>;
      schemaVersion?: unknown;
      cursors?: Record<string, unknown>;
      workflows?: Record<string, unknown>;
    };
    if (!parsed || typeof parsed !== "object") return emptyLedger();
    // Migration reset: an older ledger cannot supply the current ownership and
    // counting guarantees, so discard and rebuild rather than folding onto it.
    const onDiskVersion =
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
    if (
      onDiskVersion < CURRENT_SCHEMA_VERSION ||
      cursorsLackByteOffset(parsed.cursors)
    ) {
      return emptyLedger();
    }
    // Merge onto an empty ledger so a partial/old file can't crash a consumer.
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      cursors: (parsed.cursors as Record<string, LedgerCursor>) ?? {},
      totals: parsed.totals ?? emptyTotals(),
      byStage: normalizeByStage(parsed.byStage),
      byModel: parsed.byModel ?? {},
      byAgent: parsed.byAgent ?? {},
      workflows: normalizeWorkflowMap(parsed.workflows),
    };
  } catch {
    return emptyLedger();
  }
}

// Fold one row's counts + usd into a Totals accumulator (mutates + returns it).
function addInto(t: Totals, row: UsageRow): Totals {
  t.tokens.input += row.counts.input;
  t.tokens.output += row.counts.output;
  t.tokens.cacheCreate5m += row.counts.cacheCreate5m;
  t.tokens.cacheCreate1h += row.counts.cacheCreate1h;
  t.tokens.cacheRead += row.counts.cacheRead;
  if (typeof row.usd === "number" && Number.isFinite(row.usd)) t.usd += row.usd;
  return t;
}

// The bucket key for byModel: the normalized rate-table key when known, else the
// raw model string, else "unknown". Keeps unknown-model tokens visible.
function modelBucketKey(row: UsageRow): string {
  return normalizeModel(row.model) ?? row.model ?? "unknown";
}

function foldRowIntoAggregate(
  aggregate: UsageAggregate,
  row: UsageRow,
  stageSlug: string | null,
): void {
  addInto(aggregate.totals, row);
  const mk = modelBucketKey(row);
  const ak = row.agentType ?? "subagent";
  aggregate.byModel[mk] = addInto(aggregate.byModel[mk] ?? emptyTotals(), row);
  aggregate.byAgent[ak] = addInto(aggregate.byAgent[ak] ?? emptyTotals(), row);
  if (stageSlug) {
    const stage = aggregate.byStage[stageSlug] ?? emptyStageBucket();
    addInto(stage.totals, row);
    // Stage-scoped sub-splits mirror the aggregate folds so By Model / By Agent
    // on STAGE_COMPLETED agree with the stage's own Cost USD.
    stage.byModel[mk] = addInto(stage.byModel[mk] ?? emptyTotals(), row);
    stage.byAgent[ak] = addInto(stage.byAgent[ak] ?? emptyTotals(), row);
    aggregate.byStage[stageSlug] = stage;
  }
}

// Fold one row into the workspace diagnostic aggregate and the authoritative
// session + intent aggregates.
function foldRowIntoLedger(
  ledger: Ledger,
  row: UsageRow,
  stageSlug: string | null,
  sessionKey: string,
  workflowKey: string,
): void {
  foldRowIntoAggregate(ledger, row, stageSlug);
  const workflow = ledger.workflows[workflowKey] ?? {
    ...emptyUsageAggregate(),
    sessions: {},
  };
  foldRowIntoAggregate(workflow, row, stageSlug);
  const session = workflow.sessions[sessionKey] ?? emptyUsageAggregate();
  foldRowIntoAggregate(session, row, stageSlug);
  workflow.sessions[sessionKey] = session;
  ledger.workflows[workflowKey] = workflow;
}

const USAGE_LOCK_INTENT = "__usage-ledger__";
const USAGE_LOCK_SPACE = "__runtime__";

function withUsageLedgerLock(projectDir: string, fn: () => Ledger): Ledger {
  return withAuditLock(
    projectDir,
    fn,
    USAGE_LOCK_INTENT,
    USAGE_LOCK_SPACE,
    200,
    25,
  );
}

// Incrementally fold new rows into the ledger and advance the per-file cursors.
//
// 1. Group rows by sourceKey (file identity).
// 2. Rows are already in file order from extraction - do NOT re-sort across
//    files by timestamp (timestamps collide across concurrent sub-agents).
// 3. If a group has a cursor, drop rows up to AND INCLUDING lastUuid (append-only
//    files => everything after the checkpoint is new). No cursor => all new.
// 4. Fold survivors into totals / byModel / byAgent, and byStage[stageSlug] when
//    a stage is supplied.
// 5. Advance cursors[sourceKey] to each group's last folded row.
// 6. Write atomically.
//
// Duplicate-turn guard: a broadcast turn appears in several files with
// output_tokens:0 in the copies; folding stays correct because each file is
// counted ONLY against its own cursor. Do NOT dedupe by uuid across files - that
// would drop the one real-token copy.
export function updateLedger(
  projectDir: string,
  rows: UsageRow[],
  stageSlug: string | null,
  context: UsageContext = {},
): Ledger {
  return withUsageLedgerLock(projectDir, () => {
    const ledger = loadLedger(projectDir);
    const sessionKey =
      context.sessionKey ?? sessionUsageKey(undefined, context.sessionId);
    const workflowKey =
      context.workflowKey ?? intentUsageKey(projectDir, context.sessionId);

    // 1. Group by sourceKey, preserving file order within each group.
    const groups = new Map<string, UsageRow[]>();
    for (const row of rows) {
      const arr = groups.get(row.sourceKey) ?? [];
      arr.push(row);
      groups.set(row.sourceKey, arr);
    }

    for (const [sourceKey, rawGroupRows] of groups) {
      // Collapse split-line overcount WITHIN this file's group (a caller may pass
      // raw split rows). Per-group so the dedup never crosses files - a broadcast
      // turn sharing an id across concurrent sub-agent files must still count once
      // per file (the per-file-cursor invariant). Reuses the same pure helper the
      // whole-file reader uses.
      const groupRows = dedupeByMessageId(rawGroupRows);
      const cursor = ledger.cursors[sourceKey];
      let fresh = groupRows;
      if (cursor?.lastUuid) {
        const idx = groupRows.findIndex((r) => r.uuid === cursor.lastUuid);
        // Everything AFTER the checkpoint row is new. If the checkpoint uuid isn't
        // in this batch (e.g. the batch is entirely older, or the file was
        // truncated), keep all rows - a re-fold is harmless per idempotency.
        fresh = idx >= 0 ? groupRows.slice(idx + 1) : groupRows;
      }
      if (fresh.length === 0) continue;

      for (const row of fresh) {
        foldRowIntoLedger(ledger, row, stageSlug, sessionKey, workflowKey);
      }

      const last = fresh[fresh.length - 1];
      // Preserve any byteOffset the file-fold layer set for this source - the
      // row-based API advances uuid/timestamp/msgId but does not track bytes.
      // ALWAYS write a numeric byteOffset (default 0) so this API produces a
      // cursor-complete current-schema ledger. This is safe alongside the fold
      // layer because the two keyspaces are disjoint: updateLedger keys by
      // row.sourceKey (`"main"`/`"agent-<id>"`) while foldFileIntoLedger keys by
      // FILE PATH, so a 0 here is never read by a fold.
      const prevOffset = ledger.cursors[sourceKey]?.byteOffset ?? 0;
      ledger.cursors[sourceKey] = {
        lastUuid: last.uuid,
        lastTimestamp: last.timestamp,
        lastMessageId:
          last.msgId || ledger.cursors[sourceKey]?.lastMessageId || "",
        byteOffset: prevOffset,
      };
    }

    // 6. Persist atomically (mkdir the sessions dir first).
    try {
      mkdirSync(sessionsDir(projectDir), { recursive: true });
    } catch {
      /* dir may already exist */
    }
    writeFileAtomic(ledgerPath(projectDir), JSON.stringify(ledger, null, 2));
    return ledger;
  });
}

// ===========================================================================
// Task 5 - Audit per-stage rollup fields (ledger read only, NO transcript I/O)
// ===========================================================================

// Compact token count for audit field values: 1234 -> "1.2k", 3_400_000 ->
// "3.4M", sub-1000 -> the integer, 0/negative/non-finite -> "0". Mirrors
// aidlc-statusline.ts fmtTokens exactly (kept a LOCAL copy - usage.ts must not
// import a hook, and the metrics reader un-abbreviates this same form). One
// decimal at k/M scale, trailing ".0" trimmed.
function fmtTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const trim = (s: string): string => s.replace(/\.0$/, "");
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `${trim((n / 1e3).toFixed(1))}k`;
  return String(Math.round(n));
}

// Format a per-key COST breakdown for the `By Agent` line - `k=1.23; k2=0.45`,
// USD to 2dp, only buckets with a positive cost. Empty -> "". (Agent buckets
// can't classify unknown-vs-zero at agent granularity, so zero-cost agents are
// simply omitted here; their TOKENS still surface via the token-breakdown
// fields below, so no agent is hidden.)
function formatByCost(buckets: Record<string, Totals>): string {
  const parts: string[] = [];
  for (const [key, t] of Object.entries(buckets)) {
    if (t.usd > 0) parts.push(`${key}=${t.usd.toFixed(2)}`);
  }
  return parts.join("; ");
}

// Format the per-MODEL cost breakdown with null-visibility: a known
// (rate-keyed) model prints its cost `opus-4-8=1.23` (even `=0.00`); an
// unknown-model bucket prints `<rawModel>=null` so an unpriceable slice is
// VISIBLE, never silently dropped. Empty map -> "".
function formatModelCost(buckets: Record<string, Totals>): string {
  const rates = loadRates();
  const parts: string[] = [];
  for (const [key, t] of Object.entries(buckets)) {
    parts.push(key in rates ? `${key}=${t.usd.toFixed(2)}` : `${key}=null`);
  }
  return parts.join("; ");
}

// Format a per-key TOKEN breakdown - `k=in/out/cacheRead/cacheWrite; k2=...`
// with each count in compact form (`12.3k/4.1k/2k/79.6k`). The quad order is
// input / output / cacheRead / cacheWrite, documented in
// docs/reference/06-hooks-and-tools.md. cacheWrite = cacheCreate5m +
// cacheCreate1h - both TTLs summed into one bucket, mirroring the single Cache
// Read bucket (the harness issues 5m-TTL writes in practice, but summing is
// correct for either TTL and matches computeCost, which prices both). A bucket
// whose four counts are all zero is skipped. Empty -> "". This is what makes the
// four token counts visible per model AND per agent, not just cost. The metrics
// reader parses this exact shape (un-abbreviating the compact values) into
// per-model / per-agent token magnitude lines.
function formatByTokens(buckets: Record<string, Totals>): string {
  const parts: string[] = [];
  for (const [key, t] of Object.entries(buckets)) {
    const { input, output, cacheRead } = t.tokens;
    const cacheWrite = t.tokens.cacheCreate5m + t.tokens.cacheCreate1h;
    if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) continue;
    parts.push(
      `${key}=${fmtTokensCompact(input)}/${fmtTokensCompact(output)}/${fmtTokensCompact(cacheRead)}/${fmtTokensCompact(cacheWrite)}`,
    );
  }
  return parts.join("; ");
}

// Whether a stage bucket carries any priceable (known-model) sub-bucket.
function hasKnownModel(byModel: Record<string, Totals>): boolean {
  const rates = loadRates();
  return Object.keys(byModel).some((k) => k in rates);
}

// Whether a stage recorded any tokens at all.
function hasAnyTokens(t: Totals): boolean {
  const c = t.tokens;
  return (
    c.input > 0 ||
    c.output > 0 ||
    c.cacheCreate5m > 0 ||
    c.cacheCreate1h > 0 ||
    c.cacheRead > 0
  );
}

// Compact usage summaries for STAGE_COMPLETED / WORKFLOW_COMPLETED, read from
// the authoritative workflow aggregate - no transcript re-parse or time-slicing.
//
// THREE cost states are distinguished:
//   (a) no usage data for the stage      => {} (no fields; caller stays clean)
//   (b) usage recorded but UNPRICEABLE   => `Cost USD: null` (all unknown-model)
//   (c) priced                           => `Cost USD: 1.23`
// A mixed known+unknown stage prices the KNOWN portion (state c) and the
// `By Model` line shows the unknown slice as `<model>=null` - no fabricated cost.
//
// `Tokens By Model` / `Tokens By Agent` carry the four token counts
// (in/out/cacheRead/cacheWrite) per model and per agent, so the breakdowns are
// token-aware, not cost-only.
function aggregateUsageAuditFields(
  stage: Pick<UsageAggregate, "totals" | "byModel" | "byAgent">,
): Record<string, string> {
  const t = stage.totals;
  const fields: Record<string, string> = {
    "Tokens In": String(t.tokens.input),
    "Tokens Out": String(t.tokens.output),
    "Cache Read": String(t.tokens.cacheRead),
    "Cache Write": String(t.tokens.cacheCreate5m + t.tokens.cacheCreate1h),
  };
  // Cost USD - three-state. Priced => 2dp; unpriceable-but-used => "null";
  // genuinely no usage => omitted.
  if (t.usd > 0 || hasKnownModel(stage.byModel)) {
    fields["Cost USD"] = t.usd.toFixed(2);
  } else if (hasAnyTokens(t)) {
    fields["Cost USD"] = "null"; // recorded usage, all unknown-model => unpriceable
  }
  // Stage-scoped breakdowns - read the stage's OWN sub-maps, never the global
  // byModel/byAgent (those sum every stage and would contradict Cost USD).
  const byModel = formatModelCost(stage.byModel);
  if (byModel) fields["By Model"] = byModel;
  const byAgent = formatByCost(stage.byAgent);
  if (byAgent) fields["By Agent"] = byAgent;
  // Token counts grouped by model and by agent (in/out/cacheRead/cacheWrite).
  const tokModel = formatByTokens(stage.byModel);
  if (tokModel) fields["Tokens By Model"] = tokModel;
  const tokAgent = formatByTokens(stage.byAgent);
  if (tokAgent) fields["Tokens By Agent"] = tokAgent;
  return fields;
}

export function stageUsageAuditFields(
  projectDir: string,
  stageSlug: string,
  workflowKey: string = intentUsageKey(projectDir),
): Record<string, string> {
  if (usageTrackingDisabled()) return {};
  const stage =
    loadLedger(projectDir).workflows[workflowKey]?.byStage[stageSlug];
  return stage ? aggregateUsageAuditFields(stage) : {};
}

export function workflowUsageAuditFields(
  projectDir: string,
  workflowKey: string = intentUsageKey(projectDir),
): Record<string, string> {
  if (usageTrackingDisabled()) return {};
  const workflow = loadLedger(projectDir).workflows[workflowKey];
  return workflow && hasAnyTokens(workflow.totals)
    ? aggregateUsageAuditFields(workflow)
    : {};
}

export function sessionUsageAggregate(
  projectDir: string,
  transcriptPath?: string,
  workflowKey?: string,
  sessionId?: string,
): UsageAggregate | null {
  if (usageTrackingDisabled()) return null;
  const resolvedTranscript =
    transcriptPath ?? (sessionId ? readCurrentTranscriptPath(projectDir, sessionId) : null);
  const sessionKey = sessionUsageKey(resolvedTranscript ?? undefined, sessionId);
  const resolvedWorkflowKey =
    workflowKey ?? intentUsageKey(projectDir, sessionId);
  return (
    loadLedger(projectDir).workflows[resolvedWorkflowKey]?.sessions[sessionKey] ??
    null
  );
}

// ===========================================================================
// Task 6 - Persisted transcript path + runtime ledger producer (usage.ts half)
// ===========================================================================

// Normalise a session id to a safe filename segment (mirrors aidlc-lib's
// sessionRecordPath sanitisation) so a host-supplied id can't escape the dir.
function safeSessionSegment(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

// Atomically persist the live transcript path so transcript-blind CLI tools
// (state, statusline) can find it. Writes both a session-scoped
// `<sessionId>.transcript` (safe for concurrent sessions) AND a
// `current.transcript` convenience pointer for readers that lack a session id.
// Best-effort: swallows write errors (never breaks a hook).
export function writeCurrentTranscriptPath(
  projectDir: string,
  sessionId: string,
  transcriptPath: string,
): void {
  // Only usage consumers read these pointers, so the kill switch covers them.
  if (usageTrackingDisabled()) return;
  if (!transcriptPath) return;
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
  } catch {
    /* dir may already exist */
  }
  const seg = safeSessionSegment(sessionId);
  try {
    if (seg) {
      writeFileAtomic(
        join(sessionsDir(projectDir), `${seg}.transcript`),
        transcriptPath,
      );
    }
    writeFileAtomic(
      join(sessionsDir(projectDir), "current.transcript"),
      transcriptPath,
    );
  } catch {
    /* best-effort */
  }
}

// Read back the persisted transcript path. With a sessionId, reads the
// session-scoped file; without one, falls back to `current.transcript`. Returns
// null if absent/empty. Never throws.
export function readCurrentTranscriptPath(
  projectDir: string,
  sessionId?: string,
): string | null {
  const candidates: string[] = [];
  if (sessionId) {
    const seg = safeSessionSegment(sessionId);
    if (seg) candidates.push(join(sessionsDir(projectDir), `${seg}.transcript`));
  } else {
    candidates.push(join(sessionsDir(projectDir), "current.transcript"));
  }
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8").trim();
      if (raw) return raw;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

// The result of an offset-aware chunk read: the COMPLETE (newline-terminated)
// lines newly available since `byteOffset`, the ABSOLUTE byte start position of
// each of those lines (parallel to `lines`, so the caller can rewind the offset
// to where a held-back group begins), and the byte position up to which those
// complete lines run. A trailing partial line (no final `\n` - a half-written
// append) is DROPPED and left for the next fold. `reset` signals a
// truncation/rotation was detected (size < byteOffset) so the caller resets the
// per-file checkpoint too. `null` means nothing to do (file gone, or
// size === byteOffset with no new bytes).
type ChunkRead = {
  lines: string[];
  lineByteStarts: number[];
  newByteOffset: number;
  reset: boolean;
  trailingPartial: boolean;
};

// Read only bytes `[byteOffset, size)` of a file, BYTE-accurately (UTF-8 multi-
// byte safe - offsets are byte positions, never char indices). Returns the
// complete lines in that window, each line's absolute byte start, and the
// advanced byte offset. Never throws.
function readChunkFromOffset(
  path: string,
  byteOffset: number,
  flush: boolean,
): ChunkRead | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null; // file absent / unreadable
  }
  try {
    const size = fstatSync(fd).size;
    let reset = false;
    let start = byteOffset;
    if (size === start) return null; // no new bytes - zero parse
    if (size < start) {
      // Truncation / rotation - start over from the top.
      reset = true;
      start = 0;
    }
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const chunk = buf.subarray(0, read);
    // Find the LAST newline byte in the chunk. Everything up to and including it
    // is complete lines; any bytes after it are a partial trailing write we drop
    // until the next fold completes the line.
    const lastNl = chunk.lastIndexOf(0x0a); // '\n'
    // Split the complete region on newline bytes, recording each line's ABSOLUTE
    // byte start (start + relative offset). Byte-accurate: we scan the raw buffer
    // rather than string-splitting so a multi-byte char never skews an offset.
    const lines: string[] = [];
    const lineByteStarts: number[] = [];
    let lineStart = 0;
    for (let idx = 0; idx <= lastNl; idx++) {
      if (chunk[idx] === 0x0a) {
        lines.push(chunk.subarray(lineStart, idx).toString("utf-8"));
        lineByteStarts.push(start + lineStart);
        lineStart = idx + 1;
      }
    }
    let newByteOffset = lastNl >= 0 ? start + lastNl + 1 : start;
    let trailingPartial = lineStart < chunk.length;
    // A final flush may observe a fully-written JSON object whose writer never
    // appended `\n`. Parse only syntactically complete JSON at EOF; malformed
    // trailing bytes keep the old offset so a later append can complete them.
    if (flush && trailingPartial) {
      const trailing = chunk.subarray(lineStart).toString("utf-8");
      try {
        JSON.parse(trailing);
        lines.push(trailing);
        lineByteStarts.push(start + lineStart);
        newByteOffset = start + chunk.length;
        trailingPartial = false;
      } catch {
        // partial final JSON - retain it for a later fold
      }
    }
    return { lines, lineByteStarts, newByteOffset, reset, trailingPartial };
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

// Offset-aware fold of ONE source file into the ledger. Reads only the new bytes
// since the file's cursor, parses+groups them, HOLDS BACK the last (not-yet-
// provably-complete) group, folds the rest via the shared accumulation path, and
// advances the per-file cursor (byteOffset + lastUuid/lastTimestamp). Mutates
// `ledger`.
//
// CURSOR KEY. The cursor is keyed by the transcript FILE PATH (`path`), NOT the
// constant `sourceKey`. The workspace ledger is cumulative across sessions and
// each session is a DIFFERENT file, so a constant `"main"` key made one
// session's byteOffset get read against another session's longer file, skipping
// its early turns. A file path is unique per session, so cursors never collide.
// `sourceKey` ("main"/"agent-<id>") is still stamped on every ROW for
// byModel/byAgent attribution - only the CURSOR key changed.
//
// HOLDBACK. Claude Code splits one llm call (one message.id) across contiguous
// JSONL lines; a mid-turn fold may land on a chunk boundary INSIDE such a group,
// before its real-usage line is written (new-style transcripts carry usage=0 on
// the leading lines and the real usage on the LAST line of the run). The fix:
// never count a group until it is provably COMPLETE. A group is complete only if
// a DIFFERENT-msgId group follows it in this chunk (so a new group has started,
// closing the prior one), OR the caller passed `flush=true` (the turn truly
// ended - the Stop hook). The LAST group in a non-flush chunk is held back: it
// is NOT folded, and byteOffset is rewound to the BYTE START of that group so
// its lines are re-read in full next fold. Because a held-back group is never
// counted until complete and is always re-read whole, incremental folding equals
// a single whole-file flush fold for BOTH transcript styles, regardless of where
// a chunk boundary falls (mid-group or mid-line).
function foldFileIntoLedger(
  ledger: Ledger,
  sourceKey: string,
  path: string,
  fallbackAgentId: string | null,
  metaByAgentId: Record<string, string>,
  stageSlug: string | null,
  sessionKey: string,
  workflowKey: string,
  flush: boolean,
): void {
  // The cursor is keyed by FILE PATH, unique across sessions.
  const cursorKey = path;
  const cursor = ledger.cursors[cursorKey];
  const prevOffset = cursor?.byteOffset ?? 0;
  const chunk = readChunkFromOffset(path, prevOffset, flush);
  if (chunk === null) return; // no new bytes / unreadable

  // Parse each complete line, keeping the parallel byte-start so a held-back
  // group can rewind the offset to where its FIRST line begins.
  const parsed: UsageRow[] = [];
  const parsedByteStarts: number[] = [];
  for (let i = 0; i < chunk.lines.length; i++) {
    const row = parseTranscriptLine(chunk.lines[i], sourceKey, fallbackAgentId);
    if (row) {
      parsed.push(row);
      parsedByteStarts.push(chunk.lineByteStarts[i]);
    }
  }

  // Group contiguous same-msgId runs (the split-line collapse), recording each
  // group's representative row (max-usage line of the run) and its first line's
  // byte start. Id-less rows are singleton groups (never merged). Within one
  // chunk, same-msgId lines are always contiguous (verified), so a contiguous
  // grouping matches dedupeByMessageId exactly here.
  const groups: { rep: UsageRow; byteStart: number }[] = [];
  {
    let i = 0;
    while (i < parsed.length) {
      const row = parsed[i];
      const byteStart = parsedByteStarts[i];
      if (!row.msgId) {
        groups.push({ rep: row, byteStart });
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < parsed.length && parsed[j + 1].msgId === row.msgId) j++;
      groups.push({ rep: representativeOfRun(parsed, i, j), byteStart });
      i = j + 1;
    }
  }

  // HOLDBACK. Fold every complete group; on a non-flush fold the LAST group is
  // not provably complete => hold it back and rewind the offset to its start so
  // it is re-read whole next time. A flush closes it only when EOF is clean: a
  // malformed trailing fragment may be another split line for the same message.
  const closeLastGroup = flush && !chunk.trailingPartial;
  let foldCount = groups.length;
  let newByteOffset = chunk.newByteOffset;
  if (!closeLastGroup && groups.length > 0) {
    foldCount = groups.length - 1;
    newByteOffset = groups[groups.length - 1].byteStart;
  }
  const toFold = groups.slice(0, foldCount).map((g) => g.rep);

  // Attribute agent types BEFORE folding (main -> "main", sub -> sidecar type,
  // else "subagent"), reusing the shared attributor.
  attributeAgents(toFold, metaByAgentId);

  const newCursor = {
    lastUuid: cursor?.lastUuid ?? "",
    lastTimestamp: cursor?.lastTimestamp ?? "",
    lastMessageId: cursor?.lastMessageId ?? "",
    byteOffset: newByteOffset,
    pending: chunk.reset ? undefined : cursor?.pending,
  };

  const priorPending = chunk.reset ? undefined : cursor?.pending;
  for (let i = 0; i < toFold.length; i++) {
    const group = groups[i];
    const captured =
      i === 0 &&
      priorPending !== undefined &&
      priorPending.byteOffset === group.byteStart
        ? priorPending
        : null;
    foldRowIntoLedger(
      ledger,
      toFold[i],
      captured?.stageSlug ?? stageSlug,
      captured?.sessionKey ?? sessionKey,
      captured?.workflowKey ?? workflowKey,
    );
  }
  if (toFold.length > 0) {
    const last = toFold[toFold.length - 1];
    newCursor.lastUuid = last.uuid;
    newCursor.lastTimestamp = last.timestamp;
    if (last.msgId) newCursor.lastMessageId = last.msgId; // diagnostics only
  }
  if (!closeLastGroup && groups.length > 0) {
    const held = groups[groups.length - 1];
    newCursor.pending =
      priorPending?.byteOffset === held.byteStart
        ? priorPending
        : {
            byteOffset: held.byteStart,
            messageId: held.rep.msgId,
            stageSlug,
            sessionKey,
            workflowKey,
          };
  } else if (closeLastGroup) {
    newCursor.pending = undefined;
  }
  ledger.cursors[cursorKey] = newCursor;
}

// The runtime ledger PRODUCER: read the transcript (main + sub-agents) and fold
// its NEW bytes into the ledger under the current stage. This is the runtime
// caller wired from the PreToolUse, PostToolUse, and Stop hooks (Claude only).
// Offset-aware: each fold reads only bytes appended since the last fold per file
// (main + each sub-agent sidecar), so a per-tool-call fold never re-parses whole
// files. Fully guarded - never throws into a hook; on any failure returns the
// existing ledger unchanged and persists nothing.
//
// Fold modes. `holdback` retains every file's last group for PostToolUse;
// `seal-main` closes only the main group; `flush-all` closes every complete
// group at an engine boundary or Stop.
export type FoldMode = "holdback" | "seal-main" | "flush-all";

export function foldTranscriptIntoLedger(
  projectDir: string,
  transcriptPath: string,
  stageSlug: string | null,
  modeOrFlush: FoldMode | boolean = "holdback",
  context: UsageContext = {},
): Ledger {
  // Kill switch: the producer writes nothing (existing ledger left untouched).
  if (usageTrackingDisabled()) return emptyLedger();
  try {
    return withUsageLedgerLock(projectDir, () => {
      const mode: FoldMode =
        typeof modeOrFlush === "boolean"
          ? modeOrFlush
            ? "flush-all"
            : "holdback"
          : modeOrFlush;
      const sessionKey =
        context.sessionKey ??
        sessionUsageKey(transcriptPath, context.sessionId);
      const workflowKey =
        context.workflowKey ?? intentUsageKey(projectDir, context.sessionId);
      const ledger = loadLedger(projectDir);

      // Main transcript.
      foldFileIntoLedger(
        ledger,
        "main",
        transcriptPath,
        null,
        {},
        stageSlug,
        sessionKey,
        workflowKey,
        mode !== "holdback",
      );

      // Each sibling sub-agent file, with its sidecar agentType map (rebuilt each
      // fold - sidecars are tiny and the set can grow between folds).
      const subDir = subagentDir(transcriptPath);
      let entries: string[] = [];
      try {
        if (existsSync(subDir)) {
          entries = readdirSync(subDir).filter(
            (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
          );
        }
      } catch {
        entries = [];
      }
      for (const file of entries) {
        const agentId = file.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        const full = join(subDir, file);
        const metaByAgentId: Record<string, string> = {};
        const meta = readMetaSidecar(full);
        if (meta && typeof meta.agentType === "string" && meta.agentType) {
          metaByAgentId[agentId] = meta.agentType;
        }
        foldFileIntoLedger(
          ledger,
          `agent-${agentId}`,
          full,
          agentId,
          metaByAgentId,
          stageSlug,
          sessionKey,
          workflowKey,
          mode === "flush-all",
        );
      }

      // Persist atomically (mkdir the sessions dir first).
      try {
        mkdirSync(sessionsDir(projectDir), { recursive: true });
      } catch {
        /* dir may already exist */
      }
      writeFileAtomic(ledgerPath(projectDir), JSON.stringify(ledger, null, 2));
      return ledger;
    });
  } catch {
    return loadLedger(projectDir);
  }
}
