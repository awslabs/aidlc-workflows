// covers: subcommand:aidlc-utility:doctor
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

describe("t282 runtime state-version guard (next / report)", () => {
  test("`next` refuses a pre-v8 (v7) state with an error directive, not load-steering", () => {
    const r = runOrchestrate("next", "7");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/State Version 7 predates|Incompatible workflow state/);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`report` refuses a pre-v8 (v7) state with an error directive", () => {
    const r = runOrchestrate("report", "7");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/Incompatible workflow state|predates the current/);
  });

  test("a current v8 state is NOT blocked by the runtime guard", () => {
    const r = runOrchestrate("next", "8");
    // v8 is accepted — the guard is silent; next proceeds to its normal directive.
    expect(r.kind).not.toBe("error");
  });
});
