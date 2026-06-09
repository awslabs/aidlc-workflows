// covers: function:stateFilePath, function:auditFilePath
//
// t106 — path builders stateFilePath() / auditFilePath() in aidlc-lib.ts.
// Mechanism: none (pure functions, zero I/O, zero LLM, zero tokens).
// Technique: example-based.
//
// Source (dist/claude/.claude/tools/aidlc-lib.ts):
//   :136  stateFilePath(d)  => join(d, "aidlc-docs", "aidlc-state.md")
//   :140  auditFilePath(d)  => join(d, "aidlc-docs", "audit.md")
//
// Why this file exists: both builders are one-character-typo-fragile. A
// silent edit of "aidlc-docs" -> "aidlc_docs", or "aidlc-state.md" ->
// "state.md", or "audit.md" -> "aidlc-audit.md", breaks every downstream
// consumer (state read/write, audit append) and nothing catches it today.
//
// Test-design note (house style, per tests/unit/t69-worktree-path.sh):
// assert the OBSERVABLE CONTRACT, never path.join() parity. A test that
// re-derives the path with its own join() only catches deletion. Each
// assertion below hard-codes the EXPECTED literal independently of the
// source, so a typo in the source suffix is caught as a mismatch:
//   1. exact full constructed string for a known absolute projectDir
//   2. shape: absolute projectDir in -> absolute path out
//   3. suffix contract: output ends with the correct relative suffix
//   4. the two builders share the aidlc-docs parent but DIFFER in filename
//      (catches a copy-paste that points both at the same file)
//
// worktreePath() is deliberately NOT tested here — it is covered by
// tests/unit/t69-worktree-path.sh.

import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { auditFilePath, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// A known POSIX-absolute projectDir. The unit-test tier runs on macOS /
// Linux (path.sep === "/"), so the expected literals below use "/".
const PROJ = "/home/user/myproject";

// Expected full paths, hard-coded INDEPENDENTLY of the source. These are
// transcribed from the source suffix literals once, then frozen here; a
// drift in the source produces a string mismatch, not silent agreement.
const EXPECTED_STATE = "/home/user/myproject/aidlc-docs/aidlc-state.md";
const EXPECTED_AUDIT = "/home/user/myproject/aidlc-docs/audit.md";

describe("stateFilePath()", () => {
  test("returns the exact full path for a known absolute projectDir", () => {
    // Pins the literal. Catches "aidlc-docs"->"aidlc_docs",
    // "aidlc-state.md"->"state.md", a dropped/extra path component, or a
    // stray separator. This is the load-bearing assertion.
    expect(stateFilePath(PROJ)).toBe(EXPECTED_STATE);
  });

  test("ends with the aidlc-docs/aidlc-state.md suffix", () => {
    // Suffix contract independent of projectDir. The filename literal
    // "aidlc-state.md" (NOT "state.md") is what every state read/write
    // consumer relies on.
    expect(stateFilePath(PROJ).endsWith("aidlc-docs/aidlc-state.md")).toBe(true);
  });

  test("returns an absolute path when projectDir is absolute", () => {
    // Shape contract: an implementation that lost the projectDir prefix or
    // returned a relative path would fail here.
    expect(isAbsolute(stateFilePath(PROJ))).toBe(true);
  });

  test("preserves the projectDir prefix verbatim", () => {
    // The whole projectDir must survive at the head of the output. Catches
    // a builder that re-rooted the path or trimmed the prefix.
    expect(stateFilePath(PROJ).startsWith(PROJ)).toBe(true);
  });
});

describe("auditFilePath()", () => {
  test("returns the exact full path for a known absolute projectDir", () => {
    // Pins the literal. Catches "audit.md"->"aidlc-audit.md", the
    // aidlc-docs typo, or a dropped/extra component.
    expect(auditFilePath(PROJ)).toBe(EXPECTED_AUDIT);
  });

  test("ends with the aidlc-docs/audit.md suffix", () => {
    // Suffix contract. The filename literal "audit.md" (NOT
    // "aidlc-audit.md") is what the audit-append path relies on.
    expect(auditFilePath(PROJ).endsWith("aidlc-docs/audit.md")).toBe(true);
  });

  test("returns an absolute path when projectDir is absolute", () => {
    expect(isAbsolute(auditFilePath(PROJ))).toBe(true);
  });

  test("preserves the projectDir prefix verbatim", () => {
    expect(auditFilePath(PROJ).startsWith(PROJ)).toBe(true);
  });
});

describe("stateFilePath() / auditFilePath() relationship", () => {
  test("both build under the same aidlc-docs parent but DIFFER in filename", () => {
    // Guards against a copy-paste regression that points both builders at
    // the same file. They must share the aidlc-docs directory yet resolve
    // to distinct paths — distinct on the trailing filename specifically.
    const state = stateFilePath(PROJ);
    const audit = auditFilePath(PROJ);

    expect(state).not.toBe(audit);
    expect(state.includes("/aidlc-docs/")).toBe(true);
    expect(audit.includes("/aidlc-docs/")).toBe(true);

    // Their common prefix is exactly ".../aidlc-docs/"; they diverge only
    // at the filename. Pin that so a future edit can't accidentally route
    // state into the audit file or vice versa.
    const stateLeaf = state.slice(state.lastIndexOf("/") + 1);
    const auditLeaf = audit.slice(audit.lastIndexOf("/") + 1);
    expect(stateLeaf).toBe("aidlc-state.md");
    expect(auditLeaf).toBe("audit.md");
    expect(stateLeaf).not.toBe(auditLeaf);
  });
});
