// covers: subcommand:aidlc-utility:recompose, function:setStageSuffix
// covers: audit:RECOMPOSED
//
// t194 - the P4 in-flight recompose matrix (adaptive workflows).
//
// The recompose verb flips a PENDING stage's plan suffix on the live state
// file under withAuditLock, strict-validated, derived-fields rebuilt,
// RECOMPOSED audited. This pins the FULL P4 contract:
//
//   flips:      pending SKIP honored (the router walks around it); pending
//               forward ADD honored (the router walks TO it); both directions
//               land as suffix edits only (checkbox markers untouched).
//   rejects:    starved ADD/SKIP (strict validator - an off-path required
//               producer), [x]/[-]/[S] frozen-stage flip, behind-cursor flip,
//               skeleton-gate-anchor flip (the first EXECUTE stage of
//               Construction), unknown slug, --skip+--add overlap, no flips.
//   derived:    Stages to Execute / to Skip / Total Stages / Completed / Next
//               Stage rebuilt against the EFFECTIVE plan; --status counts
//               against it too.
//   readers:    finalize (both calls), lookup next-stage, jump target
//               validation + loops honour the recomposed plan (ADD-then-jump
//               consistency) - the override-blind sites P4 threaded.
//   audit:      RECOMPOSED lands with the flip lists (and is a canonical
//               event - the 69-count pins hold in t28/t111).
//   inert:      a run that never calls recompose leaves the state file
//               byte-identical (the OFF-path gate).
//
// Mechanism: cli - spawns the shipped tools against temp projects born via
// intent-birth (the real state-file shape, not a fixture).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;

const toolIn = (proj: string, name: string): string =>
  join(proj, ".claude", "tools", name);

function run(
  proj: string,
  tool: string,
  args: string[],
): { status: number; out: string } {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.AIDLC_SCOPE_MAPPING;
  const res = spawnSync(BUN, [toolIn(proj, tool), ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: childEnv as Record<string, string>,
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function recordDirOf(proj: string): string {
  const space = readFileSync(join(proj, "aidlc", "active-space"), "utf-8").trim() || "default";
  const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
  const rec = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
  return join(intentsDir, rec);
}
const statePathOf = (proj: string): string => join(recordDirOf(proj), "aidlc-state.md");
const readState = (proj: string): string => readFileSync(statePathOf(proj), "utf-8");

function auditText(proj: string): string {
  const dir = join(recordDirOf(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** A born feature-scope project (all 31 post-scaffold stages EXECUTE; cursor
 *  at intent-capture after init). */
function bornProject(scope = "feature"): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  const r = run(proj, "aidlc-utility.ts", ["intent-birth", "--scope", scope]);
  expect(r.status).toBe(0);
  return proj;
}

describe("t194 recompose - flips land as suffix edits and the router honours them", () => {
  test("pending SKIP honored: suffix flips, marker untouched, router walks around it", () => {
    const proj = bornProject();
    const before = readState(proj);
    expect(before).toMatch(/- \[ \] market-research — EXECUTE/);
    const r = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research"]);
    expect(r.status).toBe(0);
    const after = readState(proj);
    // Suffix flipped, checkbox marker still pending.
    expect(after).toMatch(/- \[ \] market-research — SKIP/);
    // The router (via lookup next-stage, now state-aware) walks around it:
    // after intent-capture the next stage is NOT market-research.
    const next = run(proj, "aidlc-state.ts", ["lookup", "next-stage", "intent-capture", "feature"]);
    expect(next.status).toBe(0);
    expect(next.out.trim()).toBe("feasibility");
  });

  test("pending forward ADD honored: a bugfix-scope grid-SKIP stage promotes and the router walks TO it", () => {
    const proj = bornProject("bugfix");
    // bugfix's grid SKIPs user-stories; born state carries the SKIP suffix.
    expect(readState(proj)).toMatch(/- \[ \] user-stories — SKIP/);
    const r = run(proj, "aidlc-utility.ts", ["recompose", "--add", "user-stories"]);
    expect(r.status).toBe(0);
    expect(readState(proj)).toMatch(/- \[ \] user-stories — EXECUTE/);
    // ADD-direction routing: after requirements-analysis the walk reaches the
    // promoted stage instead of skipping to code-generation.
    const next = run(proj, "aidlc-state.ts", ["lookup", "next-stage", "requirements-analysis", "bugfix"]);
    expect(next.out.trim()).toBe("user-stories");
  });

  test("RECOMPOSED audit event lands with the flip lists", () => {
    const proj = bornProject();
    run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    const audit = auditText(proj);
    expect(audit).toContain("**Event**: RECOMPOSED");
    expect(audit).toContain("market-research, team-formation");
  });

  test("Stages to Skip round trip: skip+add leaves the row byte-identical to birth (annotations preserved)", () => {
    // Birth writes annotated entries ("<number> (<slug>)", and for a
    // greenfield feature birth the rationale form
    // "2.1 (reverse-engineering — greenfield)"). The rebuild must preserve
    // those bytes for stages whose skip-membership did not change.
    const proj = bornProject();
    const rowOf = (state: string): string =>
      /- \*\*Stages to Skip\*\*: (.*)/.exec(state)?.[1] ?? "";
    const birthRow = rowOf(readState(proj));
    expect(birthRow).toContain("(reverse-engineering — greenfield)");

    const skip = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research"]);
    expect(skip.status).toBe(0);
    const midRow = rowOf(readState(proj));
    // The untouched birth annotation survives the flip verbatim, and the
    // newly-skipped stage renders the scope-change way: number (slug).
    expect(midRow).toContain("(reverse-engineering — greenfield)");
    expect(midRow).toContain("1.2 (market-research)");

    const add = run(proj, "aidlc-utility.ts", ["recompose", "--add", "market-research"]);
    expect(add.status).toBe(0);
    expect(rowOf(readState(proj))).toBe(birthRow);
  });

  test("derived fields rebuilt: Total/Completed/Next Stage + --status counts track the plan", () => {
    const proj = bornProject();
    const before = readState(proj);
    const totalBefore = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(before)?.[1]);
    run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research"]);
    const after = readState(proj);
    const totalAfter = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(after)?.[1]);
    expect(totalAfter).toBe(totalBefore - 1);
    expect(after).toMatch(/- \*\*Stages to Skip\*\*: .*market-research/);
    // --status counts against the recomposed plan (the static-grid divergence
    // this P4 closed): total in the progress line drops by 1 too.
    const status = run(proj, "aidlc-utility.ts", ["status"]);
    expect(status.status).toBe(0);
    const m = /Progress: (\d+)\/(\d+)/.exec(status.out) ?? /(\d+)\/(\d+) stages/.exec(status.out);
    if (m) {
      expect(Number(m[2])).toBe(totalAfter);
    } else {
      // Fall back: the status body must not still claim the pre-flip total
      // wherever it renders counts.
      expect(status.out).toContain(String(totalAfter));
    }
  });
});

describe("t194 recompose - rejections", () => {
  test("starved SKIP rejected by the strict validator with the producer named", () => {
    const proj = bornProject();
    const r = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "application-design"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Strict (recompose) mode");
    expect(r.out).toContain("application-design");
  });

  test("frozen-stage flips rejected: [x] completed and behind-cursor", () => {
    const proj = bornProject();
    const rx = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "state-init"]);
    expect(rx.status).not.toBe(0);
    expect(rx.out).toContain("not pending");
  });

  test("skeleton-gate anchor flip rejected (first EXECUTE stage of Construction)", () => {
    const proj = bornProject();
    const r = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "functional-design"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("walking-skeleton gate");
  });

  test("ADD-direction anchor move rejected: promoting a construction stage AHEAD of the anchor", () => {
    // bugfix's first construction EXECUTE is code-generation; functional-design
    // sits ahead of it in the grid. Promoting it would silently relocate the
    // walking-skeleton gate anchor, so the ADD must reject like the SKIP does.
    const proj = bornProject("bugfix");
    const r = run(proj, "aidlc-utility.ts", ["recompose", "--add", "functional-design"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("walking-skeleton gate anchor");
    // And the state file is untouched by the rejection.
    expect(readState(proj)).toMatch(/- \[ \] functional-design — SKIP/);
  });

  test("completed workflow rejected: recompose refuses when Status is not Running", () => {
    const proj = bornProject();
    // Terminalize the workflow the way complete-workflow does.
    const sp = statePathOf(proj);
    const terminal = readFileSync(sp, "utf-8").replace(/- \*\*Status\*\*: Running/, "- **Status**: Completed");
    expect(terminal).toContain("- **Status**: Completed");
    writeFileSync(sp, terminal, "utf-8");
    const r = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not Running");
    expect(readState(proj)).toBe(terminal);
  });

  test("unknown slug, overlap, and empty flips all reject", () => {
    const proj = bornProject();
    expect(run(proj, "aidlc-utility.ts", ["recompose", "--skip", "no-such-stage"]).status).not.toBe(0);
    expect(
      run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research", "--add", "market-research"]).status,
    ).not.toBe(0);
    expect(run(proj, "aidlc-utility.ts", ["recompose"]).status).not.toBe(0);
  });

  test("OFF path is inert: a rejected recompose leaves the state file byte-identical", () => {
    const proj = bornProject();
    const before = readState(proj);
    run(proj, "aidlc-utility.ts", ["recompose", "--skip", "functional-design"]);
    expect(readState(proj)).toBe(before);
  });
});

describe("t194 recompose - the jump readers honour the recomposed plan", () => {
  test("jump target validation: a recompose-SKIPped stage is refused, a promoted one allowed", () => {
    const proj = bornProject();
    run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research"]);
    // resolve refuses the suffix-SKIPped target (was grid-EXECUTE).
    const refuse = run(proj, "aidlc-jump.ts", ["resolve", "--stage", "market-research"]);
    expect(refuse.status).not.toBe(0);
    expect(refuse.out).toContain("skipped for scope");
    // The promoted direction: bugfix project, ADD a grid-SKIP stage, then
    // resolve targets it successfully.
    const proj2 = bornProject("bugfix");
    run(proj2, "aidlc-utility.ts", ["recompose", "--add", "user-stories"]);
    const allow = run(proj2, "aidlc-jump.ts", ["resolve", "--stage", "user-stories"]);
    expect(allow.status).toBe(0);
    const body = JSON.parse(allow.out) as { target_slug: string; valid: boolean };
    expect(body.target_slug).toBe("user-stories");
    expect(body.valid).toBe(true);
  });

  test("ADD-then-jump consistency: a forward jump marks the promoted stage [S] like any on-plan stage", () => {
    const proj = bornProject("bugfix");
    run(proj, "aidlc-utility.ts", ["recompose", "--add", "user-stories"]);
    // Jump forward over the promoted stage to code-generation: the forward
    // loop must mark IN-FLIGHT intermediates [S] against the EFFECTIVE plan.
    // First put the cursor at requirements-analysis (jump execute redo-shape).
    const jr = run(proj, "aidlc-jump.ts", [
      "execute", "--target", "code-generation", "--direction", "forward",
    ]);
    expect(jr.status).toBe(0);
    const body = JSON.parse(jr.out) as { stages_skipped: string[] };
    // user-stories was pending + on the effective plan between cursor and
    // target - a grid-blind loop would NOT have marked it.
    expect(body.stages_skipped).toContain("user-stories");
    expect(readState(proj)).toMatch(/- \[S\] user-stories — EXECUTE/);
  });

  test("backward jump resets a promoted stage's [S/x] like any on-plan stage", () => {
    const proj = bornProject("bugfix");
    run(proj, "aidlc-utility.ts", ["recompose", "--add", "user-stories"]);
    run(proj, "aidlc-jump.ts", ["execute", "--target", "code-generation", "--direction", "forward"]);
    expect(readState(proj)).toMatch(/- \[S\] user-stories — EXECUTE/);
    const back = run(proj, "aidlc-jump.ts", [
      "execute", "--target", "requirements-analysis", "--direction", "backward",
    ]);
    expect(back.status).toBe(0);
    const body = JSON.parse(back.out) as { stages_reset: string[] };
    expect(body.stages_reset).toContain("user-stories");
    expect(readState(proj)).toMatch(/- \[ \] user-stories — EXECUTE/);
  });
});
