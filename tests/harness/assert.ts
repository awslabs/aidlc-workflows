// assert.ts — deterministic-output assertion helpers for the SDK harness.
//
// These wrap a DriveResult (from sdk-drive.ts) and assert on the things that
// are byte-stable: tool_result content, written state fields, audit events,
// and the SDK's structured terminal event. They throw a plain Error on
// failure (bun:test's `expect` will surface it; callers can also use them
// outside bun:test). They are deliberately framework-agnostic — no import of
// bun:test here — so the calibrator can call them from any harness.
//
// Design rule baked in: an assertion over a collection must FIRST prove the
// collection is non-empty for the thing it's checking, otherwise an empty
// toolResults array would let every "contains" pass vacuously and a deleted
// behaviour would go unnoticed. assertToolResultContains enforces that.
//
// The ONE helper that reads the LLM's non-deterministic prose is named
// awkwardly on purpose — see assertAssistantTextContains__DANGER_NONDETERMINISTIC.

import type { DriveResult } from "./sdk-drive.ts";
import { readStateField } from "./sdk-drive.ts";

function fail(message: string): never {
  throw new Error(`[harness-assert] ${message}`);
}

// ---------------------------------------------------------------------------
// Tool-result assertions (the primary, deterministic surface)
// ---------------------------------------------------------------------------

/**
 * Assert that `toolName` was actually called at least once AND that at least
 * one of its tool_result blocks contains `substring` verbatim.
 *
 * The first check is load-bearing: without it, a run where the tool never
 * fired (empty toolResults for that tool) would pass vacuously — the exact
 * failure mode that lets a deleted behaviour slip through. We assert presence
 * of the call first, then assert the content.
 */
export function assertToolResultContains(
  result: DriveResult,
  toolName: string,
  substring: string,
): void {
  const calls = result.toolResults.filter((t) => t.toolName === toolName);
  if (calls.length === 0) {
    fail(
      `expected tool "${toolName}" to be called, but it never appeared in ` +
        `toolResults (saw: ${summarizeToolNames(result)}). ` +
        `Refusing to pass vacuously.`,
    );
  }
  const hit = calls.some((t) => t.resultText.includes(substring));
  if (!hit) {
    const preview = calls
      .map((t, i) => `  [${i}] ${truncate(t.resultText, 240)}`)
      .join("\n");
    fail(
      `tool "${toolName}" was called ${calls.length}x but no tool_result ` +
        `contained ${JSON.stringify(substring)}.\nResults:\n${preview}`,
    );
  }
}

/**
 * Assert a tool was called at least once (regardless of result content).
 * Useful when you only care that a stage reached a particular tool.
 */
export function assertToolCalled(result: DriveResult, toolName: string): void {
  const called = result.toolResults.some((t) => t.toolName === toolName);
  if (!called) {
    fail(
      `expected tool "${toolName}" to be called, but it never appeared ` +
        `(saw: ${summarizeToolNames(result)}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Audit-event assertions
// ---------------------------------------------------------------------------

/**
 * Assert the audit log recorded an event of type `event` (e.g. "STATE_FORKED").
 * Reads result.auditEvents, which sdk-drive parsed from the `**Event**:` lines of
 * the audit trail — P4: the per-intent shards under
 * aidlc/spaces/<space>/intents/<slug>-<id8>/audit/, or the flat aidlc-docs/audit.md
 * for a pre-migration fixture (sdk-drive's readAuditEvents resolves both). Fails
 * clearly when no audit was written.
 */
export function assertAuditEvent(result: DriveResult, event: string): void {
  if (result.auditEvents === undefined) {
    fail(
      `expected audit event "${event}", but no audit log was found ` +
        `(no per-intent audit shard nor flat aidlc-docs/audit.md — did the run write to the project dir?).`,
    );
  }
  if (!result.auditEvents.includes(event)) {
    fail(
      `expected audit event "${event}", but the log held: ` +
        `[${result.auditEvents.join(", ")}].`,
    );
  }
}

// ---------------------------------------------------------------------------
// Result-event assertions (the SDK's structured terminal event — NOT exit-124)
// ---------------------------------------------------------------------------

/**
 * Assert the run terminated cleanly: a `result` event arrived, its subtype is
 * 'success', and is_error is false. Reads the SDK's structured terminal event
 * (SDKResultSuccess, sdk.d.ts:3479), NOT a guessed exit code — the old
 * run_claude fixture's exit-124 heuristic is exactly what this replaces.
 */
export function assertResultOk(result: DriveResult): void {
  const ev = result.resultEvent;
  if (ev === undefined) {
    fail(
      `no terminal result event was emitted — the stream ended without a ` +
        `'result' message (likely a timeout/abort or a crash).`,
    );
  }
  if (ev.subtype !== "success" || ev.is_error) {
    const errs = ev.errors?.length ? ` errors: [${ev.errors.join("; ")}]` : "";
    fail(
      `expected a successful result, got subtype="${ev.subtype}" ` +
        `is_error=${ev.is_error}.${errs}`,
    );
  }
}

/**
 * Assert the run ended with a specific result subtype (e.g.
 * 'error_max_turns'). For tests that deliberately exercise an error terminal.
 */
export function assertResultSubtype(result: DriveResult, subtype: string): void {
  const ev = result.resultEvent;
  if (ev === undefined) {
    fail(`no terminal result event was emitted; expected subtype="${subtype}".`);
  }
  if (ev.subtype !== subtype) {
    fail(`expected result subtype="${subtype}", got "${ev.subtype}".`);
  }
}

// ---------------------------------------------------------------------------
// State-file assertions
// ---------------------------------------------------------------------------

/**
 * Assert a `- **<field>**: <value>` line in the post-run state file equals
 * `expected` (after trimming). Reads result.stateFile (verbatim contents of
 * aidlc-docs/aidlc-state.md). Fails clearly when the state file is absent or
 * the field is missing.
 */
export function assertStateField(
  result: DriveResult,
  field: string,
  expected: string,
): void {
  if (result.stateFile === undefined) {
    fail(
      `expected state field "${field}"="${expected}", but no state file was ` +
        `found (aidlc-docs/aidlc-state.md absent).`,
    );
  }
  const actual = readStateField(result.stateFile, field);
  if (actual === undefined) {
    fail(
      `state field "${field}" not present in aidlc-state.md ` +
        `(expected "${expected}").`,
    );
  }
  if (actual !== expected) {
    fail(`state field "${field}": expected "${expected}", got "${actual}".`);
  }
}

/**
 * Assert a state field equals a filesystem path after normalizing separator
 * style and Windows drive-letter casing. Use only for path fields; ordinary
 * state fields stay byte-exact through assertStateField().
 */
export function assertStateFieldPath(
  result: DriveResult,
  field: string,
  expected: string,
): void {
  if (result.stateFile === undefined) {
    fail(
      `expected state field "${field}"="${expected}", but no state file was ` +
        `found (aidlc-docs/aidlc-state.md absent).`,
    );
  }
  const actual = readStateField(result.stateFile, field);
  if (actual === undefined) {
    fail(
      `state field "${field}" not present in aidlc-state.md ` +
        `(expected path "${expected}").`,
    );
  }
  if (pathCompareKey(actual) !== pathCompareKey(expected)) {
    fail(`state field "${field}": expected path "${expected}", got "${actual}".`);
  }
}

function pathCompareKey(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * Assert a state field exists and contains `substring` (looser than equality —
 * useful for timestamps or composite values).
 */
export function assertStateFieldContains(
  result: DriveResult,
  field: string,
  substring: string,
): void {
  if (result.stateFile === undefined) {
    fail(
      `expected state field "${field}" to contain "${substring}", but no ` +
        `state file was found.`,
    );
  }
  const actual = readStateField(result.stateFile, field);
  if (actual === undefined) {
    fail(`state field "${field}" not present in aidlc-state.md.`);
  }
  if (!actual.includes(substring)) {
    fail(
      `state field "${field}"="${actual}" did not contain "${substring}".`,
    );
  }
}

// ---------------------------------------------------------------------------
// AskUserQuestion assertions
// ---------------------------------------------------------------------------

/**
 * Assert that at least one AskUserQuestion menu posed a question whose text
 * contains `substring`. Lets a test prove a gate actually fired without
 * scraping the rendered TUI.
 */
export function assertAskedQuestion(
  result: DriveResult,
  substring: string,
): void {
  const asked = result.askedQuestions.some((m) =>
    m.questions.some((q) => q.question.includes(substring)),
  );
  if (!asked) {
    const all = result.askedQuestions
      .flatMap((m) => m.questions.map((q) => q.question))
      .join(" | ");
    fail(
      `expected an AskUserQuestion containing "${substring}", but the run ` +
        `asked: [${all || "(none)"}].`,
    );
  }
}

// ---------------------------------------------------------------------------
// DANGER ZONE — prose assertion.
//
// This is the ONLY helper that reads the assistant's reworded prose. Its name
// is intentionally awkward so it stands out in a diff and a reviewer asks
// "why is a test asserting on non-deterministic LLM text?". Prefer the
// tool_result / state / audit helpers above for anything that must be stable.
// ---------------------------------------------------------------------------

/**
 * @deprecated NON-DETERMINISTIC. Asserts on assistantText — the LLM's reworded
 * rendering, which can change run-to-run on identical code. Use
 * assertToolResultContains / assertStateField / assertAuditEvent instead. Reach
 * for this ONLY when there is genuinely no deterministic surface to assert on.
 */
export function assertAssistantTextContains__DANGER_NONDETERMINISTIC(
  result: DriveResult,
  substring: string,
): void {
  if (!result.assistantText.includes(substring)) {
    fail(
      `assistantText did not contain "${substring}" — and remember this ` +
        `surface is non-deterministic, so a passing assertion here is not ` +
        `a stable guarantee.`,
    );
  }
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function summarizeToolNames(result: DriveResult): string {
  const names = result.toolResults.map((t) => t.toolName);
  return names.length ? `[${names.join(", ")}]` : "[no tool calls]";
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}
