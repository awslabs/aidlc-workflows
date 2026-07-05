// covers: subcommand:aidlc-utility:doctor
//
// The doctor's Submodules advisory row (added alongside the workspace-detection
// submodule signal). Four states, all pass:true (an uninitialized submodule is a
// user-environment pre-flight state, not framework breakage, and doctor's exit
// code feeds CI/scripts):
//   - no .gitmodules            -> "no .gitmodules at workspace root"
//   - uninitialized entries     -> advisory naming count + paths + the remedy
//   - all initialized           -> "N declared, all initialized"
//   - present but unparseable   -> "no parseable submodule entries"
//
// Follows t83's spawn-and-grep-stdout pattern. Asserts on the report LABEL text,
// never on doctor's exit code — a bare temp project fails unrelated checks
// (hooks, shell), so the exit code is not a submodule observable.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const created: string[] = [];

afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function proj(): string {
  const p = createTestProject();
  created.push(p);
  return p;
}

/** `bun UTIL doctor --project-dir <proj>` captured 2>&1, exit code swallowed. */
function runDoctor(proj: string): string {
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

const GITMODULES_TWO = `[submodule "services/api"]
\tpath = services/api
\turl = https://example.com/api.git
[submodule "services/web"]
\tpath = services/web
\turl = https://example.com/web.git
`;

describe("t212 aidlc-utility doctor — Submodules advisory row", () => {
  test("1: no .gitmodules -> 'no .gitmodules at workspace root' row", () => {
    const out = runDoctor(proj());
    expect(out).toContain("Submodules: no .gitmodules at workspace root");
  }, 30000);

  test("2: uninitialized entries -> advisory naming count, paths, remedy", () => {
    const p = proj();
    writeFileSync(join(p, ".gitmodules"), GITMODULES_TWO, "utf-8");
    const out = runDoctor(p);
    expect(out).toContain("Submodules: 2 declared, 2 uninitialized (advisory)");
    expect(out).toContain("services/api, services/web");
    expect(out).toContain("git submodule update --init --recursive");
    // Advisory renders as a passing row (✓), never a failed (✗) one.
    expect(out).toContain("✓  Submodules: 2 declared, 2 uninitialized");
  }, 30000);

  test("3: all initialized -> 'all initialized' row", () => {
    const p = proj();
    writeFileSync(join(p, ".gitmodules"), GITMODULES_TWO, "utf-8");
    for (const sub of ["services/api", "services/web"]) {
      mkdirSync(join(p, sub), { recursive: true });
      writeFileSync(join(p, sub, ".git"), "gitdir: ../../.git/modules/x\n", "utf-8");
    }
    const out = runDoctor(p);
    expect(out).toContain("Submodules: 2 declared, all initialized");
  }, 30000);

  test("4: malformed .gitmodules -> 'no parseable submodule entries' row, no crash", () => {
    const p = proj();
    writeFileSync(
      join(p, ".gitmodules"),
      "this is not valid ini @#$%\n=headerless\n[core]\nfoo=bar\n",
      "utf-8",
    );
    const out = runDoctor(p);
    expect(out).toContain(
      "Submodules: .gitmodules present but no parseable submodule entries",
    );
  }, 30000);
});
