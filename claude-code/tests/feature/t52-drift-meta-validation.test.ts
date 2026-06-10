// covers: test:t48-audit-event-emitters
//
// Meta-test on t48-audit-event-emitters.sh. Migrated from
// tests/feature/t52-drift-meta-validation.sh (TAP plan 5).
//
// SUBJECT: the t48 drift test's detection LOGIC. t48 enforces doc/code
// consistency for the audit-event taxonomy with five checks — forward
// (every doc (event, emitter) row has a matching call site), reverse (every
// source emission site is documented), tertiary (deleted events stay deleted),
// pairing (handlers emit their paired events), and MD↔MD (audit-format.md and
// 12-state-machine.md agree). This meta-test verifies t48 actually CATCHES each
// failure mode by injecting a synthetic regression into a sandboxed copy of the
// source tree, running t48 against it, and asserting t48 fails (`not ok`) with
// the relevant diagnostic. Without this guard, a bug in t48's detection could
// let real drift slip through silently — so a happy-path-only twin would NOT be
// equal-or-stronger (§6-E non-golden: the failure event must actually fire).
//
// MECHANISM: cli. The subject is the t48 drift DETECTOR, so this stays a bun
// test that SHELLS OUT (spawns the detector as a subprocess) and asserts in TS
// (not a 1:1 transliteration). Like the .sh, each case stands up a git-clean
// sandbox copy of dist/claude + docs + tests in a fresh temp dir, mutates ONE
// file in dist/claude, then runs t48 from inside that sandbox.
//
// milestone 4 UPDATE: t48 is now the bun:test twin
// (tests/feature/t48-audit-event-emitters.test.ts), not the retired .sh. The
// twin resolves its scan roots via tests/harness/fixtures.ts REPO_ROOT
// (= HARNESS_DIR/../.., harness-relative — NOT cwd). So running the twin from
// inside the sandbox tree (sandbox/tests/feature/...) makes its
// REPO_ROOT/AIDLC_SRC resolve to the sandbox — exactly the mutate-and-detect
// contract the .sh got from its cwd-relative REPO_ROOT. We drive the twin with
// `bun test` and parse bun's `(fail) <name>` rows (whose names carry the
// check keyword: forward/reverse/tertiary/pairing/md-md) instead of bash TAP
// `not ok`. bun resolves bun:test + node builtins natively, so the sandbox needs
// no node_modules. The injected event/token surfaces in bun's assertion diff
// (the twin asserts `toEqual([])` over arrays of offending event names).
//
// Source under test:
//   - tests/feature/t48-audit-event-emitters.sh   (the detector; 16-row TAP plan)
//       * forward check    -> t48:87-137  (ok/not_ok "forward: ...")
//       * reverse check     -> t48:139-199 (ok/not_ok "reverse: ...")
//       * tertiary check    -> t48:201-230 (DELETED_EVENTS incl. JUMP_AUTO_STOPPED)
//       * pairing check     -> t48:232-312 (check_pairing handleApprove ...)
//       * md-md check       -> t48:314-335 (audit-format.md ⇄ 12-state-machine.md)
//   - dist/claude/.claude/tools/aidlc-state.ts
//       * emitAudit(pd, "GATE_APPROVED", gateFields)        :745  (injection 1 target)
//       * function handleApprove(args: string[]): void      :717  (injection 4 target)
//   - dist/claude/.claude/knowledge/aidlc-shared/audit-format.md
//       * | `ARTIFACT_REUSED` | ... | row                   :82   (injection 5 target)
//   - docs/reference/12-state-machine.md retains ARTIFACT_REUSED :228 (drift partner)
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (forward catches renamed emission)            -> "forward check catches a renamed emission"
//   .sh test 2 (reverse catches undocumented emission)        -> "reverse check catches an undocumented emission"
//   .sh test 3 (tertiary catches resurrected deleted event)   -> "tertiary check catches a resurrected deleted event"
//   .sh test 4 (pairing catches renamed handler)              -> "pairing check catches a renamed handler"
//   .sh test 5 (md-md catches audit-format ↔ state-machine)   -> "md-md check catches audit-format ⇄ 12-state-machine drift"
//
// STRONGER than the .sh: the .sh grepped `not ok.*forward|GATE_APPROVED` etc.
// (a `not ok` row OR a bare token match — a token mention alone could pass even
// if the check did not fail). Each twin below asserts BOTH (a) t48 prints a
// `not ok` row for the TARGETED check AND (b) the injected token / diagnostic
// appears, AND it confirms the SAME injection on a pristine sandbox (no
// mutation) leaves the targeted check GREEN — so the red is attributable to the
// injection, not to a pre-existing failure. A clean sandbox baseline is verified
// once in a guard test so a structurally-broken copy can't make every case
// trivially "catch".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test drives the t48 twin
const T48_REL = join("tests", "feature", "t48-audit-event-emitters.test.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Stand up a fresh sandbox copy of the three subtrees t48 touches: dist/claude
 * (the source it scans), docs (the 12-state-machine doc), and tests (t48 itself
 * + the lib/ it sources). Mirrors the .sh's mkdir+cp -R of exactly these three.
 */
function makeSandbox(): string {
  const sb = mkdtempSync(join(tmpdir(), "aidlc-t52-sandbox-"));
  tempDirs.push(sb);
  cpSync(join(REPO_ROOT, "dist", "claude"), join(sb, "dist", "claude"), {
    recursive: true,
  });
  cpSync(join(REPO_ROOT, "docs"), join(sb, "docs"), { recursive: true });
  cpSync(join(REPO_ROOT, "tests"), join(sb, "tests"), { recursive: true });
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

/** Convenience: path to a dist/claude file inside the sandbox. */
function distFile(sandbox: string, rel: string): string {
  return join(sandbox, "dist", "claude", ".claude", rel);
}

/** Convenience: path to a docs file inside the sandbox. */
function docFile(sandbox: string, rel: string): string {
  return join(sandbox, "docs", rel);
}

/** The failing-test lines from the t48 twin's bun output. bun prints
 *  `(fail) <describe> > <test name> [Nms]` for each failure; the test name
 *  carries the check keyword (forward/reverse/tertiary/pairing/md-md), so a
 *  keyword filter on these lines isolates the targeted check exactly as the
 *  .sh's `not ok.*<check>` did over TAP. */
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
  }, 120000);

  test("guard: t48 passes clean against an unmutated sandbox copy", () => {
    // If the sandbox copy were structurally broken, every injection would
    // trivially "catch" — so anchor on a green baseline first. t48 exits 0 and
    // prints zero `not ok` rows when the source tree is consistent.
    expect(cleanResult.status).toBe(0);
    expect(notOkLines(cleanResult.out)).toEqual([]);
  });

  test("forward check catches a renamed emission [.sh test 1]", () => {
    const sb = makeSandbox();
    // Rename the GATE_APPROVED emission at its call site. The forward check then
    // loses the emission site for the GATE_APPROVED doc row (t48:745 source).
    const f = distFile(sb, STATE_TS);
    const before = readFileSync(f, "utf-8");
    const after = before.replace(
      'emitAudit(pd, "GATE_APPROVED"',
      'emitAudit(pd, "GATE_APPROVED_RENAMED"',
    );
    expect(after).not.toBe(before); // the pattern must have actually matched
    writeFileSync(f, after);

    const r = runT48(sb);
    // STRONGER than the .sh (`not ok.*forward|GATE_APPROVED`): require a `not ok`
    // row whose subject is the forward check, AND that GATE_APPROVED is named.
    const fwdNotOk = notOkLines(r.out).filter((l) => /forward/i.test(l));
    expect(fwdNotOk.length).toBeGreaterThan(0);
    expect(r.out).toContain("GATE_APPROVED");
    expect(r.status).not.toBe(0);
  }, 120000);

  test("reverse check catches an undocumented emission [.sh test 2]", () => {
    const sb = makeSandbox();
    // Append a stray emission with an event name in neither VALID_EVENT_TYPES
    // nor the doc registry. A real emitAudit(...) line bypasses the
    // comment-stripping decommented() helper (t48:33-35).
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
  }, 120000);

  test("tertiary check catches a resurrected deleted event [.sh test 3]", () => {
    const sb = makeSandbox();
    // JUMP_AUTO_STOPPED is one of the deleted events the tertiary check guards
    // (t48:202 DELETED_EVENTS). Re-introducing an emission site for it must trip
    // the resurrected-event diagnostic.
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
  }, 120000);

  test("pairing check catches a renamed handler [.sh test 4]", () => {
    const sb = makeSandbox();
    // Rename handleApprove (t48:304 check_pairing handleApprove ...). The
    // function_body lookup then returns empty and pairing reports
    // "handler handleApprove not found" (t48:278).
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
  }, 120000);

  test("md-md check catches audit-format ⇄ 12-state-machine drift [.sh test 5]", () => {
    const sb = makeSandbox();
    // Remove the ARTIFACT_REUSED row from audit-format.md ONLY (audit-format.md
    // :82). 12-state-machine.md still carries it (:228), so the two catalogs
    // diverge and the md-md check (t48:314-335) must flag the difference.
    const f = distFile(sb, AUDIT_FORMAT);
    const before = readFileSync(f, "utf-8");
    const after = before
      .split("\n")
      .filter((l: string) => !l.includes("| `ARTIFACT_REUSED` |"))
      .join("\n");
    expect(after).not.toBe(before);
    writeFileSync(f, after);

    // Sanity: 12-state-machine.md in the sandbox still has ARTIFACT_REUSED.
    expect(readFileSync(docFile(sb, join("reference", "12-state-machine.md")), "utf-8")).toContain(
      "ARTIFACT_REUSED",
    );

    const r = runT48(sb);
    const mdNotOk = notOkLines(r.out).filter((l) => /md-md/i.test(l));
    expect(mdNotOk.length).toBeGreaterThan(0);
    expect(r.out).toContain("ARTIFACT_REUSED");
    expect(r.status).not.toBe(0);
  }, 120000);
});
