// covers: scope:bugfix, scope:express, scope:feature, scope:mvp, scope:security-patch
//
// Structural conformance of the GENERATED scope-runner skills. This test
// credits the five `scope:` units it exercises (bugfix / express / feature /
// mvp / security-patch, the default batch the generator ships a runner for)
// through their on-disk packaging surface, a DIFFERENT subject from the
// integration t130's engine-routing surface.
//
// WHAT THE .sh PROVED (t130-scope-runners.sh prose + the loop):
//   The five first-batch scope-runner skills are STRUCTURALLY conformant on disk,
//   the generator's scope-drift guard is clean over the shipped tree, runners are
//   a CURATED subset (a non-batch scope ships no runner), and the generator emits
//   a runner for a freshly-dropped scope file with no code change. Concretely,
//   per runner (5 checks x 5 scopes = 25):
//     (a) skills/aidlc-<scope>/SKILL.md exists,
//     (b) its frontmatter `name` == the dir name `aidlc-<scope>`,
//     (c) a `description:` field is present,
//     (d) it carries NO `hooks:` block (the spine hooks live project-wide in
//         settings.json; a runner inherits, never copies),
//     (e) the body is within the 500-line Agent-Skills ceiling.
//   Plus 4 more: (f) bugfix's shell drives the engine with `--scope bugfix`,
//   (g) `aidlc-runner-gen.ts scopes --check` is drift-clean, (h) a non-batch
//   scope (`refactor`) has no runner dir, (i) the generator emits a runner for a
//   newly-dropped scope file via the AIDLC_SCOPES_DIR + `--all --out` env seams.
//
// MECHANISM = mixed (body-derived):
//   - The structural conformance + curated-subset checks read the SHIPPED
//     skills/aidlc-<scope>/SKILL.md bytes in process AND import the generator's
//     exported renderRunner / discoverScopes / defaultScopeBatch; the name,
//     no-hooks and forwarding-loop checks are asserted against BOTH the on-disk
//     bytes AND the generator's own render output, so a drift between the two
//     also fails here.
//   - Two checks are genuine PROCESS / ENV seams that must be SPAWNED (mechanism
//     cli): the drift-guard EXIT CODE (`scopes --check` exits 0 iff in sync,
//     aidlc-runner-gen.ts) and the env-seam GENERATION (`AIDLC_SCOPES_DIR`
//     points the reader at an isolated tree, `--out` points the writer at an
//     isolated skills dir) - both are the SAME shipped tool the .sh
//     shelled out to (`bun GEN scopes …`). An in-process twin would lose the
//     process.exit drift contract and the env-seam isolation. spawnsShippedTool.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-runner-gen.ts):
//   defaultScopeBatch(discoverScopes()) - the curated set that ships a typeable
//        runner; every other scope runs via --scope.
//   renderRunner(scope, description) - emits the SKILL.md body: `name:
//        aidlc-<scope>` frontmatter, a `description: >` folded block, NO `hooks:`
//        block, and the `aidlc-orchestrate.ts next --scope <scope>` forwarding
//        loop. Spec-conformant: name == dir == aidlc-<scope>.
//   discoverScopes() - reads the `.md` files under `.claude/scopes/`
//        (AIDLC_SCOPES_DIR seam via scopesDir), keyed by frontmatter `name`.
//   handleScopes - `--check` (drift guard, exits 1 listing the drifted runners)
//        / `--all` (emit a runner per shipped scope, resolveBatch) /
//        `--out <dir>` (write into an isolated skills dir).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  defaultScopeBatch,
  discoverScopes,
  renderRunner,
} from "../../dist/claude/.claude/tools/aidlc-runner-gen.ts";

const BUN = process.execPath;
const SKILLS_DIR = join(AIDLC_SRC, "skills");
const GEN = join(AIDLC_SRC, "tools", "aidlc-runner-gen.ts");

function runnerPath(scope: string): string {
  return join(SKILLS_DIR, `aidlc-${scope}`, "SKILL.md");
}

function frontmatterName(skillMd: string): string {
  const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : "";
  const nm = fm.match(/^name:\s*(.*)$/m);
  return nm ? nm[1].trim().replace(/^["']|["']$/g, "") : "";
}

// Discovered scope frontmatter (drives the renderRunner co-assertion below; the
// generator keys discovery by frontmatter `name`, discoverScopes).
const DISCOVERED = discoverScopes();

// The default batch the generator ships. Read through the exported function so
// a batch change can never drift the test out from under the tool.
const BATCH = defaultScopeBatch(DISCOVERED);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("t130 scope-runners — structural conformance of the shipped first-batch runners (migrated from t130-scope-runners.sh, plan 24)", () => {
  // ===========================================================================
  // Per-runner structural conformance: 5 checks x 5 scopes = 25. The name /
  // no-hooks / forwarding-loop checks are asserted against the on-disk bytes AND
  // the generator's own renderRunner output, so a divergence between the two
  // also fails.
  // ===========================================================================
  for (const scope of BATCH) {
    const dir = `aidlc-${scope}`;

    test(`${dir}: SKILL.md exists [.sh per-scope test a]`, () => {
      expect(existsSync(runnerPath(scope))).toBe(true);
    });

    test(`${dir}: frontmatter name == dir name [.sh per-scope test b]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      expect(frontmatterName(body)).toBe(dir);
      const rendered = renderRunner(scope, DISCOVERED[scope]?.description ?? "");
      expect(frontmatterName(rendered)).toBe(dir);
    });

    test(`${dir}: has a description: field [.sh per-scope test c]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      expect(/^description:/m.test(body)).toBe(true);
    });

    test(`${dir}: carries no hooks: block [.sh per-scope test d]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      // The spine hooks live in settings.json.
      expect(/^hooks:/m.test(body)).toBe(false);
      const rendered = renderRunner(scope, DISCOVERED[scope]?.description ?? "");
      expect(/^hooks:/m.test(rendered)).toBe(false);
    });

    test(`${dir}: body <= 500 lines (Agent-Skills ceiling) [.sh per-scope test e]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      // Count split lines, excluding a trailing empty segment. This matches wc -l
      // for newline-terminated files and also counts an unterminated final line.
      const lines = body.split("\n");
      const wcLines = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
      expect(wcLines).toBeLessThanOrEqual(500);
    });
  }

  // ===========================================================================
  // The shell drives the engine with the baked scope (1 test).
  // Spot-check bugfix carries the engine forwarding-loop call with its scope —
  // the Bun source-channel form for an orchestrate next call.
  // ===========================================================================
  test("aidlc-bugfix: shell drives the engine with --scope bugfix [.sh test f]", () => {
    const body = readFileSync(runnerPath("bugfix"), "utf-8");
    expect(body).toContain(
      "bun .claude/tools/aidlc-orchestrate.ts next --scope bugfix",
    );
    const rendered = renderRunner("bugfix", DISCOVERED.bugfix?.description ?? "");
    expect(rendered).toContain(
      "bun .claude/tools/aidlc-orchestrate.ts next --scope bugfix",
    );
  });

  // ===========================================================================
  // New-work escape hatch is present in EVERY scope-runner.
  // A scope-runner forwards to `done` when the active intent is complete; without
  // the new-work section the conductor dead-ends there with no path to start a
  // second, unrelated intent. renderRunner is the single source, so assert the
  // recognise, offer, `next --new-intent` guidance is rendered for every
  // first-batch scope, that the offer proposes THIS runner's scope as the default
  // (correctable to a different scope for genuinely unrelated work), and that the
  // confirmed scope, not a hardcoded one, flows onto the creation command.
  // ===========================================================================
  for (const scope of BATCH) {
    test(`aidlc-${scope}: carries the new-work offer routed through next --new-intent`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      // The section header + the AskUserQuestion offer (never auto-create) + the
      // --new-intent escape hatch driven by the CONFIRMED scope.
      expect(body).toContain("Starting unrelated new work?");
      expect(body).toContain("AskUserQuestion");
      expect(body).toContain("next --new-intent --scope <the confirmed scope>");
      expect(body).toContain("`intent-create` command");
      const retiredIntentCommand = "intent-" + "b" + "irth";
      expect(body).not.toContain(`\`${retiredIntentCommand}\``);
      // The offer defaults the proposed scope to THIS runner's baked scope
      // (same-flavour follow-up) while allowing a different one, so the runner's
      // own scope is named in the offer prose. (Asserted on newline-collapsed
      // text: the prose wraps, so `baked` and the backticked scope can land on
      // adjacent lines.)
      const collapsed = body.replace(/\s+/g, " ");
      expect(collapsed).toContain(`baked \`${scope}\``);
      expect(collapsed).toContain("carry on into the new work's first stage in this chat");
      expect(collapsed.toLowerCase()).not.toContain("fresh session");
      expect(collapsed).not.toContain("**STOP**");
      const rendered = renderRunner(scope, DISCOVERED[scope]?.description ?? "");
      expect(rendered).toContain("next --new-intent --scope <the confirmed scope>");
      expect(rendered).toContain("`intent-create` command");
      expect(rendered).not.toContain(`\`${retiredIntentCommand}\``);
      expect(rendered.replace(/\s+/g, " ")).toContain(`baked \`${scope}\``);
      expect(rendered).toContain("carry on into the new work's first stage in this chat");
    });
  }

  // ===========================================================================
  // A recorded step continues with a bare `next` (#1411). Re-sending the
  // runner's own arguments would repeat a jump or a setting the person already
  // asked for; a person who asked to stop there gets `park`.
  // ===========================================================================
  for (const scope of BATCH) {
    test(`aidlc-${scope}: continues a recorded step with bare next and parks when asked`, () => {
      const rendered = renderRunner(scope, DISCOVERED[scope]?.description ?? "");
      for (const body of [readFileSync(runnerPath(scope), "utf-8"), rendered]) {
        const collapsed = body.replace(/\s+/g, " ");
        // $ARGUMENTS reach only the first next; every later pass is bare.
        expect(collapsed).toContain(
          "Pass `$ARGUMENTS` only to the first `next` in step 1: every later pass runs bare `bun .claude/tools/aidlc-orchestrate.ts next`, with no `--scope` and no `$ARGUMENTS`",
        );
        expect(collapsed).not.toContain("Repeat from step 1");
        expect(collapsed).toContain("A `done` that carries it only recorded a step: run that bare `next` at once");
        expect(collapsed).toContain(
          "also asked to stop the workflow there for now (not to pause on one decision inside the work), run `bun .claude/tools/aidlc-orchestrate.ts park --person-asked` instead",
        );
      }
    });
  }

  // ===========================================================================
  // Generator drift guard is clean over the shipped tree (1 test, mechanism cli).
  // The exit code is a process.exit contract (handleScopes exits 1 on drift), so
  // it is spawned, not imported.
  // ===========================================================================
  test("runner-gen scopes --check is drift-clean on the shipped tree [.sh test g]", () => {
    const r = spawnSync(BUN, [GEN, "scopes", "--check"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(`${r.stdout ?? ""}`).toContain("scope-runner(s) in sync");
  }, 30000);

  // ===========================================================================
  // Negative — a non-batch scope ships no runner (1 test). `refactor` is a
  // shipped scope (.claude/scopes/aidlc-refactor.md) but NOT in the default batch, so
  // it must run via `--scope`, never a runner. Pins runners as a curated subset.
  // ===========================================================================
  test("non-batch scope (refactor) has no runner — runs via --scope [.sh test h]", () => {
    expect(existsSync(runnerPath("refactor"))).toBe(false);
    // refactor IS a discovered scope (so its absence is a deliberate
    // curation, not a missing scope file) and it is genuinely NOT in the default batch.
    expect("refactor" in DISCOVERED).toBe(true);
    expect(BATCH.includes("refactor")).toBe(false);
  });

  // ===========================================================================
  // Generator emits a runner for a newly-dropped scope file (1 test, mechanism
  // cli + env seam). Drop a fixture scope into an isolated tree, point the
  // generator at it with AIDLC_SCOPES_DIR + `--all --out <isolated>`, and confirm
  // it emits the runner driving that scope. Proves "add a scope file -> generator
  // emits its runner" with no code change. Both env seams are evaluated inside
  // the subprocess (scopesDir reader, handleScopes writer), so this is spawned.
  // ===========================================================================
  test("AIDLC_SCOPES_DIR + --all --out emits a runner for a dropped scope file (no code change) [.sh test i]", () => {
    const tmpScopes = mkdtempSync(join(tmpdir(), "t130-scopes-"));
    const tmpOut = mkdtempSync(join(tmpdir(), "t130-out-"));
    tempDirs.push(tmpScopes, tmpOut);

    // A leaner-than-bugfix urgent-patch scope file with a name/description the
    // generator reads.
    writeFileSync(
      join(tmpScopes, "aidlc-hotfix.md"),
      [
        "---",
        "name: hotfix",
        "depth: Minimal",
        "keywords:",
        "  - hotfix",
        "description: Urgent production patch",
        "---",
        "# hotfix scope",
        "A leaner-than-bugfix urgent patch path.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const r = spawnSync(BUN, [GEN, "scopes", "--all", "--out", tmpOut], {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_SCOPES_DIR: tmpScopes },
    });
    expect(r.status).toBe(0);

    const emitted = join(tmpOut, "aidlc-hotfix", "SKILL.md");
    expect(existsSync(emitted)).toBe(true);
    const emittedBody = readFileSync(emitted, "utf-8");
    expect(emittedBody).toContain("next --scope hotfix");
    expect(frontmatterName(emittedBody)).toBe("aidlc-hotfix");
  }, 30000);
});
