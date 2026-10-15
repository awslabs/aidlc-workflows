// covers: test:t48-audit-event-emitters
//
// Meta-test on t48-audit-event-emitters.test.ts.
//
// SUBJECT: the t48 drift test's detection LOGIC. t48 enforces doc/code
// consistency for the audit-event taxonomy with five checks — forward
// (every doc (event, emitter) row has a matching call site), reverse (every
// source emission site is documented), tertiary (deleted events stay deleted),
// pairing (handlers emit their paired events), and MD↔MD (audit-format.md and
// 12-state-machine.md agree). This meta-test verifies t48 actually CATCHES each
// failure mode by injecting a synthetic regression into a sandboxed copy of the
// source tree, running t48 against it, and asserting t48 fails (`(fail)`) with
// the relevant diagnostic. Without this guard, a bug in t48's detection could
// let real drift slip through silently - so a happy-path-only test would NOT
// be enough: the failure event must actually fire.
//
// MECHANISM: cli. The subject is the t48 drift DETECTOR, so this stays a bun
// test that SHELLS OUT (spawns the detector as a subprocess) and asserts in TS.
// Each case stands up a sandbox copy of dist/claude + docs + tests in a fresh
// temp dir, mutates ONE file in dist/claude, then runs t48 from inside that
// sandbox.
//
// The t48 twin (tests/integration/t48-audit-event-emitters.test.ts) resolves
// its scan roots via tests/harness/fixtures.ts REPO_ROOT (= HARNESS_DIR/../..,
// harness-relative - NOT cwd). So running the twin from inside the sandbox
// tree (sandbox/tests/integration/...) makes its REPO_ROOT/AIDLC_SRC resolve
// to the sandbox (the mutate-and-detect contract). We drive the twin with
// `bun test` and parse bun's `(fail) <name>` rows (whose names carry the
// check keyword: forward/reverse/tertiary/pairing/md-md) instead of bash TAP
// `not ok`. bun resolves bun:test + node builtins natively, so the sandbox needs
// no node_modules. The injected event/token surfaces in bun's assertion diff
// (the twin asserts `toEqual([])` over arrays of offending event names).
//
// Source under test:
//   - tests/integration/t48-audit-event-emitters.test.ts (the detector)
//       * forward check    -> t48 (ok/not_ok "forward: ...")
//       * reverse check     -> t48 (ok/not_ok "reverse: ...")
//       * tertiary check    -> t48 (DELETED_EVENTS incl. JUMP_AUTO_STOPPED)
//       * pairing check     -> t48 (check_pairing handleApprove ...)
//       * md-md check       -> t48 (audit-format.md <-> 12-state-machine.md)
//   - dist/claude/.claude/tools/aidlc-state.ts handleApprove
//       * emitAudit(pd, "GATE_APPROVED", gateFields) (injection 1 target)
//       * function handleApprove(args: string[]): void (injection 4 target)
//   - dist/claude/.claude/knowledge/aidlc-shared/audit-format.md
//       * | `ARTIFACT_REUSED` | ... | row (injection 5 target)
//   - docs/reference/12-state-machine.md retains ARTIFACT_REUSED (drift partner)
//
// Each case below asserts BOTH (a) t48 prints a `(fail)` row for the TARGETED
// check AND (b) the injected token / diagnostic appears, so a token mention
// alone cannot pass. A clean sandbox baseline is verified once in a guard test
// so a structurally-broken copy can't make every case trivially "catch".

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../harness/fixtures.ts";

// The default also governs afterAll removal of multiple dist-sized sandboxes,
// which exceeds bun's 5s hook default under --parallel 4.
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const T48_REL = join("tests", "integration", "t48-audit-event-emitters.test.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Copy the source surfaces t48 scans plus its detector and harness imports.
 * Never copy tests/logs: other runners can be writing or removing transient
 * workers there, and their retained artifacts are not detector inputs.
 */
function makeSandbox(): string {
  const sb = mkdtempSync(join(tmpdir(), "aidlc-t52-sandbox-"));
  tempDirs.push(sb);
  cpSync(join(REPO_ROOT, "dist", "claude"), join(sb, "dist", "claude"), {
    recursive: true,
  });
  cpSync(join(REPO_ROOT, "docs"), join(sb, "docs"), { recursive: true });
  mkdirSync(join(sb, "tests", "integration"), { recursive: true });
  mkdirSync(join(sb, "tests", "harness"), { recursive: true });
  for (const file of [
    T48_REL,
    join("tests", "harness", "fixtures.ts"),
    join("tests", "harness", "custom-harness.ts"),
    join("tests", "harness", "test-budget.ts"),
  ]) {
    cpSync(join(REPO_ROOT, file), join(sb, file));
  }
  return sb;
}

interface T48Result {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/**
 * Run the t48 twin from the sandbox root so its REPO_ROOT/AIDLC_SRC (resolved
 * via tests/harness/fixtures.ts, HARNESS_DIR-relative) point at the sandbox copy.
 * The twin may exit non-zero (a failed check) — we capture status but assert on
 * the combined output (bun writes its pass/fail report to stderr).
 */
function runT48(sandbox: string): T48Result {
  const res = spawnSync(BUN, ["test", T48_REL], {
    cwd: sandbox,
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function distFile(sandbox: string, rel: string): string {
  return join(sandbox, "dist", "claude", ".claude", rel);
}

function docFile(sandbox: string, rel: string): string {
  return join(sandbox, "docs", rel);
}

/** The failing-test lines from the t48 twin's bun output. bun prints
 *  `(fail) <describe> > <test name> [Nms]` for each failure; the test name
 *  carries the check keyword (forward/reverse/tertiary/pairing/md-md), so a
 *  keyword filter on these lines isolates the targeted check. */
function notOkLines(out: string): string[] {
  return out.split("\n").filter((l: string) => /\(fail\)/.test(l));
}

const STATE_TS = join("tools", "aidlc-state.ts");
const AUDIT_FORMAT = join("knowledge", "aidlc-shared", "audit-format.md");

describe("t52 — meta-test on t48 drift detection (migrated from t52-drift-meta-validation.sh, plan 5)", () => {
  // A clean sandbox: t48 against an UNMUTATED copy. Used as the baseline so each
  // injection case can confirm its targeted check flips green->red.
  let cleanResult: T48Result;

  beforeAll(() => {
    cleanResult = runT48(makeSandbox());
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("guard: t48 passes clean against an unmutated sandbox copy", () => {
    // If the sandbox copy were structurally broken, every injection would
    // trivially "catch" — so anchor on a green baseline first. t48 exits 0 and
    // prints zero `(fail)` rows when the source tree is consistent.
    expect(cleanResult.status).toBe(0);
    expect(notOkLines(cleanResult.out)).toEqual([]);
  });

  test("forward check catches a renamed emission [.sh test 1]", () => {
    const sb = makeSandbox();
    // Rename the GATE_APPROVED emission at its call site. The forward check then
    // loses the emission site for the GATE_APPROVED doc row (aidlc-state.ts
    // handleApprove).
    const f = distFile(sb, STATE_TS);
    const before = readFileSync(f, "utf-8");
    const after = before.replaceAll(
      'emitAudit(pd, "GATE_APPROVED"',
      'emitAudit(pd, "GATE_APPROVED_RENAMED"',
    );
    expect(after).not.toBe(before); // the pattern must have actually matched
    writeFileSync(f, after);

    const r = runT48(sb);
    // Require a `(fail)` row whose subject is the forward check, AND that
    // GATE_APPROVED is named.
    const fwdNotOk = notOkLines(r.out).filter((l) => /forward/i.test(l));
    expect(fwdNotOk.length).toBeGreaterThan(0);
    expect(r.out).toContain("GATE_APPROVED");
    expect(r.status).not.toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("reverse check catches an undocumented emission [.sh test 2]", () => {
    const sb = makeSandbox();
    // Append a stray emission with an event name in neither VALID_EVENT_TYPES
    // nor the doc registry. A real emitAudit(...) line bypasses the
    // comment-stripping decommented() helper (t48-audit-event-emitters.test.ts).
    const f = distFile(sb, STATE_TS);
    writeFileSync(
      f,
      `${readFileSync(f, "utf-8")}\nemitAudit(pd, "PHANTOM_EVENT", { x: "y" });\n`,
    );

    const r = runT48(sb);
    const revNotOk = notOkLines(r.out).filter((l) => /reverse/i.test(l));
    expect(revNotOk.length).toBeGreaterThan(0);
    expect(r.out).toContain("PHANTOM_EVENT");
    expect(r.status).not.toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("tertiary check catches a resurrected deleted event [.sh test 3]", () => {
    const sb = makeSandbox();
    // JUMP_AUTO_STOPPED is one of the deleted events the tertiary check guards (the
    // `deleted` list in t48-audit-event-emitters.test.ts). Re-introducing an
    // emission site for it must trip the resurrected-event diagnostic.
    const f = distFile(sb, STATE_TS);
    writeFileSync(
      f,
      `${readFileSync(f, "utf-8")}\nemitAudit(pd, "JUMP_AUTO_STOPPED", { x: "y" });\n`,
    );

    const r = runT48(sb);
    const terNotOk = notOkLines(r.out).filter((l) => /tertiary/i.test(l));
    expect(terNotOk.length).toBeGreaterThan(0);
    expect(r.out).toContain("JUMP_AUTO_STOPPED");
    expect(r.status).not.toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("pairing check catches a renamed handler [.sh test 4]", () => {
    const sb = makeSandbox();
    // Rename handleApprove (t48-audit-event-emitters.test.ts pairingMissing). The
    // functionBody lookup then returns null and pairing reports
    // "handler handleApprove not found (renamed/deleted?)".
    const f = distFile(sb, STATE_TS);
    const before = readFileSync(f, "utf-8");
    const after = before.replace(
      "function handleApprove(args",
      "function handleApproveRenamed(args",
    );
    expect(after).not.toBe(before);
    writeFileSync(f, after);

    const r = runT48(sb);
    const pairNotOk = notOkLines(r.out).filter((l) => /pairing/i.test(l));
    expect(pairNotOk.length).toBeGreaterThan(0);
    expect(r.out).toContain("handleApprove");
    expect(r.status).not.toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("md-md check catches audit-format ⇄ 12-state-machine drift [.sh test 5]", () => {
    const sb = makeSandbox();
    // Remove the ARTIFACT_REUSED row from audit-format.md ONLY.
    // 12-state-machine.md still carries it, so the two catalogs
    // diverge and the md-md check must flag the difference.
    const f = distFile(sb, AUDIT_FORMAT);
    const before = readFileSync(f, "utf-8");
    const after = before
      .split("\n")
      .filter((l: string) => !l.includes("| `ARTIFACT_REUSED` |"))
      .join("\n");
    expect(after).not.toBe(before);
    writeFileSync(f, after);

    expect(readFileSync(docFile(sb, join("reference", "12-state-machine.md")), "utf-8")).toContain(
      "ARTIFACT_REUSED",
    );

    const r = runT48(sb);
    const mdNotOk = notOkLines(r.out).filter((l) => /md-md/i.test(l));
    expect(mdNotOk.length).toBeGreaterThan(0);
    expect(r.out).toContain("ARTIFACT_REUSED");
    expect(r.status).not.toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
