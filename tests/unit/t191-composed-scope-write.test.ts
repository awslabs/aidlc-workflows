// covers: function:inferScopeFromText, function:validScopes, subcommand:aidlc-utility:intent-birth
//
// t191 - the P2 composed-scope write contract (adaptive workflows).
//
// The front composer authors TWO files after approval - scopes/aidlc-<name>.md
// + a scope-grid.json entry - and the runtime honors them at the next
// invocation with zero recompile (spike A). This test pins the deterministic
// half of that contract plus the KEYWORD-HYGIENE rule the review made a
// landing requirement:
//
//   - A composed scope written with `keywords: []` RESOLVES by --scope (birth
//     succeeds, the born state carries the scope, the authored grid drives
//     Stage Progress suffixes) but NEVER wins inference - the shadowing trap:
//     inference is first-alphabetical, so an authored keyword like `fix` on a
//     scope named e.g. "auth-fix" would permanently beat stock bugfix. With
//     keywords: [] the inference result for keyword text is UNCHANGED.
//   - The shadowing trap itself, pinned as the counterfactual: the SAME scope
//     WITH the stock keyword DOES shadow bugfix (alphabetical: "auth-fix" <
//     "bugfix"). This is why keywords: [] is the composed default and keyword
//     grants are an explicit human gate choice.
//   - BOTH files are required: a .md without a grid entry resolves as an
//     all-SKIP scope (loadScopeMapping tolerates it; the born workflow's
//     Stage Progress carries only the always-EXECUTE init stages).
//
// Mechanism: cli - spawns the shipped tools against a temp project's copied
// .claude/ tree (the t60 pattern: drop scope files into the COPIED tree, so
// the shipped registry is never touched).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;

const utilityIn = (proj: string): string =>
  join(proj, ".claude", "tools", "aidlc-utility.ts");

// Resolve the born record's state file via the active-space/intent cursors
// (the t60 recordDirOf pattern).
function statePath(proj: string): string {
  const spaceCursor = join(proj, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  const rec = existsSync(intentCursor)
    ? readFileSync(intentCursor, "utf-8").trim()
    : "";
  return join(intentsDir, rec, "aidlc-state.md");
}

// Author a composed scope the way the composer writes it: the .md into the
// copied .claude/scopes/ + (optionally) the grid entry into the copied
// .claude/tools/data/scope-grid.json. The grid mirrors bugfix but flips
// requirements-analysis to SKIP so the AUTHORED grid (not any stock one) is
// provably what the born state carries.
function authorComposedScope(
  proj: string,
  name: string,
  opts: { keywords?: string[]; withGridEntry?: boolean } = {},
): void {
  const kw =
    opts.keywords && opts.keywords.length > 0
      ? `keywords:\n${opts.keywords.map((k) => `  - ${k}`).join("\n")}`
      : "keywords: []";
  writeFileSync(
    join(proj, ".claude", "scopes", `aidlc-${name}.md`),
    `---\nname: ${name}\ndepth: Minimal\n${kw}\ndescription: composed by t191\n---\n\n# ${name}\n`,
    "utf-8",
  );
  if (opts.withGridEntry !== false) {
    const gridPath = join(proj, ".claude", "tools", "data", "scope-grid.json");
    const grid = JSON.parse(readFileSync(gridPath, "utf-8")) as Record<
      string,
      { stages: Record<string, string> }
    >;
    const stages = { ...grid.bugfix.stages, "requirements-analysis": "SKIP" };
    grid[name] = { stages };
    writeFileSync(gridPath, JSON.stringify(grid, null, 2), "utf-8");
  }
}

function run(
  proj: string,
  args: string[],
): { status: number; out: string } {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.AIDLC_SCOPE_MAPPING;
  const res = spawnSync(BUN, [utilityIn(proj), ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: childEnv as Record<string, string>,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function inferIn(proj: string, input: string): string {
  const res = spawnSync(
    BUN,
    [
      "-e",
      `import { inferScopeFromText } from ${JSON.stringify(utilityIn(proj))}; console.log(inferScopeFromText(process.env.T191_INPUT).scope);`,
    ],
    {
      encoding: "utf-8",
      env: { ...process.env, T191_INPUT: input, AIDLC_SCOPE_MAPPING: undefined } as unknown as Record<string, string>,
    },
  );
  return (res.stdout ?? "").trim();
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function freshProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  return proj;
}

describe("t191 composed-scope write contract + keyword hygiene", () => {
  test("keywords: [] scope resolves by --scope AND the authored grid drives the born state", () => {
    const proj = freshProject();
    authorComposedScope(proj, "composed-t191", {});
    const r = run(proj, ["intent-birth", "--scope", "composed-t191"]);
    expect(r.status).toBe(0);
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: composed-t191");
    // The AUTHORED grid (bugfix minus requirements-analysis) is what froze in:
    // the deviated stage carries the SKIP suffix (proof it is not stock bugfix)
    // and a stock-EXECUTE stage keeps EXECUTE.
    expect(state).toMatch(/requirements-analysis — SKIP/);
    expect(state).toMatch(/code-generation — EXECUTE/);
  });

  test("keywords: [] never wins inference - stock routing UNCHANGED (the hygiene rule)", () => {
    const proj = freshProject();
    authorComposedScope(proj, "aaa-composed", {}); // alphabetically FIRST if it had keywords
    // Keyword text that matches stock bugfix must still infer bugfix.
    expect(inferIn(proj, "fix bug")).toBe("bugfix");
    // And rich prose still falls to the feature default (inference unchanged).
    expect(inferIn(proj, "a long description of a brand new system to build")).toBe(
      "feature",
    );
  });

  test("counterfactual: an authored keyword DOES shadow stock inference (why [] is the default)", () => {
    const proj = freshProject();
    // "aaa-composed" sorts before "bugfix"; granting it the stock keyword
    // "fix" makes it win first-alphabetical - the spike-proven trap.
    authorComposedScope(proj, "aaa-composed", { keywords: ["fix"] });
    expect(inferIn(proj, "fix bug")).toBe("aaa-composed");
  });

  test("a .md WITHOUT a grid entry resolves as all-SKIP (both files required)", () => {
    const proj = freshProject();
    authorComposedScope(proj, "gridless-t191", { withGridEntry: false });
    // The scope is valid (presence = validity) so birth succeeds...
    const r = run(proj, ["intent-birth", "--scope", "gridless-t191"]);
    expect(r.status).toBe(0);
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: gridless-t191");
    // ...but with no grid column every non-init stage froze as SKIP - the
    // composer MUST write both files or the plan is empty.
    expect(state).toMatch(/code-generation — SKIP/);
    expect(state).toMatch(/requirements-analysis — SKIP/);
  });
});
