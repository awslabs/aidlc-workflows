// covers: subcommand:aidlc-utility:doctor, function:classifyStateVersion
//
// PR #711 finding (apackeer, round 2): the v8 state-version gate must actually
// REJECT a pre-v8 state. v8 renamed the Inception `application-design` stage to
// `domain-design` and inserted `contract-design`, so a v7 state file's stage
// rows no longer match the graph and cannot be advanced safely. `/aidlc
// --doctor` must surface a failing "state version current" row (not the
// happy-path "State Version: 8" row) and exit non-zero, and its remediation
// must point at the CURRENT `aidlc/` workspace layout — never the retired flat
// `aidlc-docs/` root. This pins both the failing and passing paths.

import { describe, expect, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function stateWithVersion(version: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: state-version doctor test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: ${version}
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0

## Stage Progress

### INCEPTION PHASE
- [-] domain-design — EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: domain-design
- **Status**: Running
`;
}

function runDoctor(version: string): { status: number; out: string } {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), stateWithVersion(version), "utf-8");
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

describe("t282 state-version doctor gate", () => {
  test("a pre-v8 (v7) state fails the state-version row and exits non-zero", () => {
    const { status, out } = runDoctor("7");
    // Failing row, not the happy-path pass row.
    expect(out).toMatch(/state version current/);
    expect(out).not.toMatch(/State Version: 8/);
    // Remediation names the CURRENT workspace layout, not the retired aidlc-docs/.
    expect(out).toContain("mv aidlc aidlc.v7-archive");
    expect(out).not.toContain("aidlc-docs");
    // The message explains WHY (the renamed Inception graph).
    expect(out).toMatch(/domain-design/);
    expect(status).not.toBe(0);
  });

  test("a current v8 state passes the state-version row", () => {
    const { out } = runDoctor("8");
    expect(out).toMatch(/State Version: 8/);
    expect(out).not.toMatch(/state version current/); // the fail-row label is absent
  });

  // leandro round-3 follow-up (P2): doctor must classify malformed and future
  // numeric versions the SAME way the runtime guard does (both call the shared
  // classifyStateVersion in aidlc-lib). Malformed values must NOT receive
  // stale-version wording, and future values must receive upgrade guidance
  // (not archive-and-reinit).
  test("a MALFORMED (non-numeric) state fails the readable row, not the past-version row", () => {
    const { status, out } = runDoctor("not-a-number");
    expect(out).toMatch(/state version readable/);
    expect(out).not.toMatch(/state version current/); // past-version label absent
    expect(out).toMatch(/missing, empty, or unparseable/);
    expect(status).not.toBe(0);
  });

  test("a FUTURE (v9) state fails the compatible row with upgrade guidance, not archive-and-reinit", () => {
    const { status, out } = runDoctor("9");
    expect(out).toMatch(/state version compatible/);
    expect(out).not.toMatch(/state version current/); // past-version label absent
    expect(out).toMatch(/is newer than the current/);
    expect(out).toMatch(/Upgrade the framework/);
    // The past-version's archive path template ('mv aidlc aidlc.v9-archive')
    // MUST NOT appear — that would be the wrong remediation for a future state.
    expect(out).not.toMatch(/aidlc\.v9-archive/);
    expect(status).not.toBe(0);
  });

  test("a state with TRAILING CONTENT on the version line is unparseable, not v8", () => {
    const { status, out } = runDoctor("8 garbage");
    expect(out).toMatch(/state version readable/);
    expect(out).toMatch(/missing, empty, or unparseable/);
    expect(out).not.toMatch(/State Version: 8/); // did NOT slip through as the happy row
    expect(status).not.toBe(0);
  });
});

// PR #711 finding (leandro, re-review): the v8 gate must ALSO fire on
// runtime/mutating commands, not only `doctor`. Before the fix, `next` against a
// v7 state exited 0 with a normal load-steering directive and advanced until it
// hit the removed `application-design` row. `next` and `report` must refuse a
// stale state up front with an error directive.
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

function runOrchestrate(sub: string, version: string): { status: number; kind: string; out: string } {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), stateWithVersion(version), "utf-8");
  const args = sub === "report"
    ? [ORCH, "report", "--stage", "domain-design", "--result", "approved", "--project-dir", proj]
    : [ORCH, "next", "--project-dir", proj];
  const res = spawnSync(BUN, args, { encoding: "utf-8", env: { ...process.env } });
  const out = `${res.stdout ?? ""}`;
  let kind = "";
  try { kind = JSON.parse(out.trim()).kind ?? ""; } catch { kind = ""; }
  return { status: res.status ?? -1, kind, out: `${out}${res.stderr ?? ""}` };
}

function runOrchestrateWithState(sub: string, stateContent: string): { status: number; kind: string; out: string } {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), stateContent, "utf-8");
  const args = sub === "report"
    ? [ORCH, "report", "--stage", "domain-design", "--result", "approved", "--project-dir", proj]
    : [ORCH, "next", "--project-dir", proj];
  const res = spawnSync(BUN, args, { encoding: "utf-8", env: { ...process.env } });
  const out = `${res.stdout ?? ""}`;
  let kind = "";
  try { kind = JSON.parse(out.trim()).kind ?? ""; } catch { kind = ""; }
  return { status: res.status ?? -1, kind, out: `${out}${res.stderr ?? ""}` };
}

describe("t282 runtime state-version guard (next / report)", () => {
  test("`next` refuses a pre-v8 (v7) state with an error directive, not load-steering", () => {
    const r = runOrchestrate("next", "7");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/State Version 7 predates the current/);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`report` refuses a pre-v8 (v7) state with an error directive", () => {
    const r = runOrchestrate("report", "7");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/State Version 7 predates the current/);
  });

  test("a current v8 state is NOT blocked by the runtime guard", () => {
    const r = runOrchestrate("next", "8");
    // v8 is accepted — the guard is silent; next proceeds to its normal directive.
    expect(r.kind).not.toBe("error");
  });

  // leandro follow-up (P2): runtime must align with `--doctor`, which rejects a
  // state whose version is missing, empty, or unparseable — not only an explicit
  // stale one. Assertions pin the EXACT remediation branch, not generic wording,
  // so a future regression that trips the wrong branch is caught.
  const UNPARSEABLE = /State Version field is missing, empty, or unparseable/;

  test("`next` refuses a state whose State Version field is MISSING (exact unparseable remediation)", () => {
    const stateNoVersion = stateWithVersion("8").replace(
      /^- \*\*State Version\*\*:.*\n/m,
      "",
    );
    const r = runOrchestrateWithState("next", stateNoVersion);
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`next` refuses a state whose State Version value is EMPTY (and does not capture the next bullet's `-`)", () => {
    const r = runOrchestrate("next", "");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    // The `[ \t]*` parser must NOT span the newline and capture "-" from the
    // next state bullet as a bogus version, mislabeling it as a stale version.
    expect(r.out).not.toMatch(/State Version - predates/);
  });

  test("`report` refuses a state whose State Version value is MALFORMED (non-numeric → unparseable)", () => {
    const r = runOrchestrate("report", "not-a-number");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
  });

  test("`next` refuses a PRESENT but zero-byte state file (not skipped as absent)", () => {
    const r = runOrchestrateWithState("next", "");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`report` refuses a PRESENT but zero-byte state file", () => {
    const r = runOrchestrateWithState("report", "");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
  });

  // A FUTURE numeric schema (v9) is incompatible with THIS build's v8 graph, but
  // it does not "predate" v8 — it must be reported as newer, with upgrade (not
  // archive-and-reinit) guidance.
  test("`next` refuses a FUTURE (v9) state as newer, not as predating v8", () => {
    const r = runOrchestrate("next", "9");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/State Version 9 is newer than the current/);
    expect(r.out).not.toMatch(/predates the current/);
  });

  // leandro round-3 follow-up (P2): the previous parser captured only the first
  // non-whitespace token and accepted anything on the rest of the line, so
  // "State Version: 8 garbage" passed as v8. The anchored parser rejects any
  // trailing content on the schema-token line and routes it through the
  // unparseable branch.
  test("`next` refuses trailing content on the State Version line as unparseable, not as v8", () => {
    const r = runOrchestrate("next", "8 garbage");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
    expect(r.out).not.toMatch(/is newer than the current/);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`report` refuses trailing content on the State Version line as unparseable", () => {
    const r = runOrchestrate("report", "8 garbage");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
  });

  // A stale numeric with trailing content ("7 archived") must also fall through
  // the unparseable branch rather than being mistaken for a plain v7 state.
  test("`next` treats `7 <trailing>` as unparseable, not as a pre-v8 state", () => {
    const r = runOrchestrate("next", "7 archived");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
  });
});
