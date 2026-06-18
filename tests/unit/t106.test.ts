// covers: function:stateFilePath, function:auditFilePath
//
// t106 — path builders stateFilePath() / auditFilePath() in aidlc-lib.ts.
// Mechanism: none (pure functions, zero I/O, zero LLM, zero tokens).
// Technique: example-based.
//
// Source (dist/claude/.claude/tools/aidlc-lib.ts), P9 end state — NO flat
// aidlc-docs/ fallback. With no intent record on disk, both builders resolve
// under the BARE SPACE record root (aidlc/spaces/<space>/intents/):
//   stateFilePath(d) => join(d, "aidlc/spaces/default/intents", "aidlc-state.md")
//   auditFilePath(d) => join(d, "aidlc/spaces/default/intents", "audit", "<host>-<clone>.md")
// (audit is now a per-clone SHARD under audit/, not a single audit.md.)
//
// Why this file exists: both builders are one-character-typo-fragile. A silent
// edit of "intents"->"intent", or "aidlc-state.md"->"state.md", or a dropped
// path component breaks every downstream consumer (state read/write, audit
// append) and nothing else catches it.
//
// Test-design note (house style): assert the OBSERVABLE CONTRACT, never
// path.join() parity. PROJ is a synthetic absolute dir with no on-disk record,
// so activeIntent() resolves null and the helpers fall back to the bare space
// root — a deterministic, projectDir-anchored path (the state filename is
// fixed; the audit leaf is the non-deterministic shard name, so we pin its DIR
// + .md extension rather than the full leaf).
//
// worktreePath() is deliberately NOT tested here — it is covered elsewhere.

import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { auditFilePath, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// A known native-absolute projectDir with NO on-disk aidlc/ record — so the
// helpers resolve the bare space record root. Native paths, so pin POSIX
// literals on POSIX and Windows literals on Windows.
const IS_WINDOWS = process.platform === "win32";
const SEP = IS_WINDOWS ? "\\" : "/";
const PROJ = IS_WINDOWS ? "C:\\Users\\aidlc\\myproject" : "/home/user/myproject";

// The bare space record root the no-intent fallback resolves to.
const INTENTS_ROOT = join(PROJ, "aidlc", "spaces", "default", "intents");
const EXPECTED_STATE = join(INTENTS_ROOT, "aidlc-state.md");
const EXPECTED_STATE_SUFFIX = `intents${SEP}aidlc-state.md`;
const EXPECTED_AUDIT_DIR = join(INTENTS_ROOT, "audit");
const EXPECTED_DATA_SENTINEL = `${SEP}intents${SEP}`;

describe("stateFilePath()", () => {
  test("returns the exact full path for a known absolute projectDir", () => {
    // Pins the literal. Catches "intents"->"intent", "aidlc-state.md"->
    // "state.md", a dropped/extra path component, or a stray separator. The
    // load-bearing assertion.
    expect(stateFilePath(PROJ)).toBe(EXPECTED_STATE);
  });

  test("ends with the intents/aidlc-state.md suffix", () => {
    // Suffix contract independent of projectDir. The filename literal
    // "aidlc-state.md" (NOT "state.md") is what every state consumer relies on.
    expect(stateFilePath(PROJ).endsWith(EXPECTED_STATE_SUFFIX)).toBe(true);
  });

  test("returns an absolute path when projectDir is absolute", () => {
    expect(isAbsolute(stateFilePath(PROJ))).toBe(true);
  });

  test("preserves the projectDir prefix verbatim", () => {
    // The whole projectDir must survive at the head. Catches a builder that
    // re-rooted the path or trimmed the prefix.
    expect(stateFilePath(PROJ).startsWith(PROJ)).toBe(true);
  });

  test("never falls back to the flat aidlc-docs/ root (P9 end state)", () => {
    expect(stateFilePath(PROJ)).not.toBe(join(PROJ, "aidlc-docs", "aidlc-state.md"));
    expect(stateFilePath(PROJ).includes(`${SEP}aidlc-docs${SEP}`)).toBe(false);
  });
});

describe("auditFilePath()", () => {
  test("resolves a per-clone shard under the intents audit/ dir", () => {
    // The audit leaf is the non-deterministic shard name (<host>-<clone>.md),
    // so pin the DIR + the .md extension rather than a fixed audit.md.
    const audit = auditFilePath(PROJ);
    expect(audit.startsWith(`${EXPECTED_AUDIT_DIR}${SEP}`)).toBe(true);
    expect(audit.endsWith(".md")).toBe(true);
  });

  test("returns an absolute path when projectDir is absolute", () => {
    expect(isAbsolute(auditFilePath(PROJ))).toBe(true);
  });

  test("preserves the projectDir prefix verbatim", () => {
    expect(auditFilePath(PROJ).startsWith(PROJ)).toBe(true);
  });

  test("never falls back to the flat aidlc-docs/audit.md (P9 end state)", () => {
    expect(auditFilePath(PROJ)).not.toBe(join(PROJ, "aidlc-docs", "audit.md"));
    expect(auditFilePath(PROJ).includes(`${SEP}aidlc-docs${SEP}`)).toBe(false);
  });
});

describe("stateFilePath() / auditFilePath() relationship", () => {
  test("both build under the same intents record root but DIFFER", () => {
    // Guards against a copy-paste regression that points both builders at the
    // same file. They share the intents/ data root yet resolve to distinct
    // paths (state is a file directly under it; audit is a shard under audit/).
    const state = stateFilePath(PROJ);
    const audit = auditFilePath(PROJ);

    expect(state).not.toBe(audit);
    expect(state.includes(EXPECTED_DATA_SENTINEL)).toBe(true);
    expect(audit.includes(EXPECTED_DATA_SENTINEL)).toBe(true);

    const stateLeaf = state.slice(state.lastIndexOf(SEP) + 1);
    expect(stateLeaf).toBe("aidlc-state.md");
    // The audit shard lives one level deeper, under audit/.
    expect(audit.includes(`${SEP}audit${SEP}`)).toBe(true);
    expect(state.includes(`${SEP}audit${SEP}`)).toBe(false);
  });
});
