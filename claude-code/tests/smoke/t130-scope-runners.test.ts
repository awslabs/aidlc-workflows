// covers: scope:bugfix, scope:feature, scope:mvp, scope:security-patch
//
// Structural-conformance port of tests/smoke/t130-scope-runners.sh (TAP plan
// 24), mechanism = mixed. The .sh carried NO `# covers:` header (its subject is
// the GENERATED scope-runner skills, and aidlc-runner-gen.ts enumerates no
// registry unit of its own — confirmed: tests/.coverage-registry.json has no
// function/subcommand id for aidlc-runner-gen). So this twin credits the four
// `scope:` units it genuinely exercises — bugfix / feature / mvp / security-patch,
// the FIRST_BATCH the generator ships a runner for (the same four registered
// scope units the feature-tier t130 twin credits; this smoke twin co-covers them
// through their on-disk packaging surface, a DIFFERENT subject from the feature
// twin's engine-routing surface).
//
// WHAT THE .sh PROVED (t130-scope-runners.sh:1-10 prose + the loop at :24-99):
//   The four first-batch scope-runner skills are STRUCTURALLY conformant on disk,
//   the generator's scope-drift guard is clean over the shipped tree, runners are
//   a CURATED subset (a non-batch scope ships no runner), and the generator emits
//   a runner for a freshly-dropped scope file with no code change. Concretely,
//   per runner (5 checks x 4 scopes = 20):
//     (a) skills/aidlc-<scope>/SKILL.md exists,
//     (b) its frontmatter `name` == the dir name `aidlc-<scope>`,
//     (c) a `description:` field is present,
//     (d) it carries NO `hooks:` block (the six spine hooks live project-wide in
//         settings.json post-move — Fork 2->B; a runner inherits, never copies),
//     (e) the body is within the 500-line Agent-Skills ceiling.
//   Plus 4 more: (f) bugfix's shell drives the engine with `--scope bugfix`,
//   (g) `aidlc-runner-gen.ts scopes --check` is drift-clean, (h) a non-batch
//   scope (`refactor`) has no runner dir, (i) the generator emits a runner for a
//   newly-dropped scope file via the AIDLC_SCOPES_DIR + `--all --out` env seams.
//
// MECHANISM = mixed (body-derived, milestone 3):
//   - The structural conformance + curated-subset checks read the SHIPPED
//     skills/aidlc-<scope>/SKILL.md bytes in process AND import the generator's
//     exported renderRunner / discoverScopes / FIRST_BATCH to assert the rendered
//     contract directly (mechanism none — zero process spawn). STRONGER than the
//     .sh's grep-on-disk: the frontmatter-name, description-present, no-hooks, and
//     forwarding-loop checks are asserted against BOTH the on-disk bytes AND the
//     generator's own render output, so a drift between the two also fails here.
//   - Two checks are genuine PROCESS / ENV seams that must be SPAWNED (mechanism
//     cli): the drift-guard EXIT CODE (`scopes --check` exits 0 iff in sync,
//     aidlc-runner-gen.ts:476/474) and the env-seam GENERATION (`AIDLC_SCOPES_DIR`
//     points the reader at an isolated tree, `--out` points the writer at an
//     isolated skills dir, :315/:449) — both are the SAME shipped tool the .sh
//     shelled out to (`bun GEN scopes …`). An in-process twin would lose the
//     process.exit drift contract and the env-seam isolation. spawnsShippedTool.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-runner-gen.ts):
//   :307 FIRST_BATCH = ["bugfix","feature","mvp","security-patch"] — the curated
//        set that ships a typeable runner; every other scope runs via --scope.
//   :384 renderRunner(scope, description) — emits the SKILL.md body: `name:
//        aidlc-<scope>` frontmatter, a `description: >` folded block, NO `hooks:`
//        block, and the `aidlc-orchestrate.ts next --scope <scope>` forwarding
//        loop. Spec-conformant: name == dir == aidlc-<scope> (:391).
//   :364 discoverScopes() — reads `.claude/scopes/aidlc-*.md` (AIDLC_SCOPES_DIR
//        seam, :315), keyed by frontmatter `name`.
//   :447 handleScopes — `--check` (drift guard, exits 1 with a diff on drift,
//        :474) / `--all` (emit a runner per shipped scope, resolveBatch :429) /
//        `--out <dir>` (write into an isolated skills dir, :449).
//
// Old TAP -> new test parity (1:1; the .sh emitted 24 `ok` lines -> 24 distinct
// expect()-bearing assertions here, several STRONGER via on-disk+render
// co-assertion). plan 24 = (5 per-runner checks x 4 scopes = 20) + 4 standalone:
//   .sh "<scope>: SKILL.md exists"                  -> per-scope "SKILL.md exists"
//   .sh "<scope>: frontmatter name == dir"          -> per-scope "name == aidlc-<scope>"
//   .sh "<scope>: has description"                  -> per-scope "description present"
//   .sh "<scope>: carries no hooks: block"          -> per-scope "no hooks: block"
//   .sh "<scope>: body <= 500 lines"                -> per-scope "body <= 500 lines"
//   .sh "aidlc-bugfix: shell drives --scope bugfix" -> "bugfix runner drives the engine with --scope bugfix"
//   .sh "scopes --check is drift-clean"             -> CLI "scopes --check exits 0 on the shipped tree"
//   .sh "non-batch scope (refactor) has no runner"  -> "non-batch scope refactor ships no runner dir"
//   .sh "generator emits a runner for a new scope"  -> CLI "AIDLC_SCOPES_DIR + --all --out emits a runner for a dropped scope file"

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
  discoverScopes,
  FIRST_BATCH,
  renderRunner,
} from "../../dist/claude/.claude/tools/aidlc-runner-gen.ts";

const BUN = process.execPath; // the bun running this test
const SKILLS_DIR = join(AIDLC_SRC, "skills");
const GEN = join(AIDLC_SRC, "tools", "aidlc-runner-gen.ts");

// The first batch the generator ships (mirrors aidlc-runner-gen.ts FIRST_BATCH,
// :307). Read from the exported constant so a batch change can never drift the
// test out from under the tool — the .sh hard-coded the same four names.
const BATCH = [...FIRST_BATCH];

/** The shipped runner SKILL.md path for one scope (skills/aidlc-<scope>/SKILL.md). */
function runnerPath(scope: string): string {
  return join(SKILLS_DIR, `aidlc-${scope}`, "SKILL.md");
}

/** The frontmatter `name:` scalar (mirrors the .sh's bun -e frontmatter parse at :32-39). */
function frontmatterName(skillMd: string): string {
  const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : "";
  const nm = fm.match(/^name:\s*(.*)$/m);
  return nm ? nm[1].trim().replace(/^["']|["']$/g, "") : "";
}

// Discovered scope frontmatter (drives the renderRunner co-assertion below; the
// generator keys discovery by frontmatter `name`, :364).
const DISCOVERED = discoverScopes();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("t130 scope-runners — structural conformance of the shipped first-batch runners (migrated from t130-scope-runners.sh, plan 24)", () => {
  // ===========================================================================
  // Per-runner structural conformance: 5 checks x 4 first-batch scopes = 20.
  // STRONGER than the .sh: the name / description-present / no-hooks /
  // forwarding-loop checks are asserted against the on-disk bytes AND the
  // generator's own renderRunner output, so a divergence between the two also
  // fails (the .sh only grepped the on-disk file).
  // ===========================================================================
  for (const scope of BATCH) {
    const dir = `aidlc-${scope}`;

    test(`${dir}: SKILL.md exists [.sh per-scope test a]`, () => {
      expect(existsSync(runnerPath(scope))).toBe(true);
    });

    test(`${dir}: frontmatter name == dir name [.sh per-scope test b]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      // .sh: got_name == "aidlc-$scope".
      expect(frontmatterName(body)).toBe(dir);
      // STRONGER: the generator's own render agrees (name == dir, :391).
      const rendered = renderRunner(scope, DISCOVERED[scope]?.description ?? "");
      expect(frontmatterName(rendered)).toBe(dir);
    });

    test(`${dir}: has a description: field [.sh per-scope test c]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      // .sh: assert_grep "^description:" — a description line is present.
      expect(/^description:/m.test(body)).toBe(true);
    });

    test(`${dir}: carries no hooks: block [.sh per-scope test d]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      // .sh: assert_not_grep "^hooks:" — the spine moved to settings.json.
      expect(/^hooks:/m.test(body)).toBe(false);
      // STRONGER: the generator never renders a hooks: block either.
      const rendered = renderRunner(scope, DISCOVERED[scope]?.description ?? "");
      expect(/^hooks:/m.test(rendered)).toBe(false);
    });

    test(`${dir}: body <= 500 lines (Agent-Skills ceiling) [.sh per-scope test e]`, () => {
      const body = readFileSync(runnerPath(scope), "utf-8");
      // .sh: wc -l < file <= 500. wc -l counts trailing newlines; split on "\n"
      // and subtract the trailing-empty element to match wc's line count.
      const lines = body.split("\n");
      const wcLines = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
      expect(wcLines).toBeLessThanOrEqual(500);
    });
  }

  // ===========================================================================
  // The shell drives the engine with the baked scope (1 test).
  // Spot-check bugfix carries the engine forwarding-loop call with its scope —
  // the .sh's substring grep for "aidlc-orchestrate.ts next --scope bugfix".
  // ===========================================================================
  test("aidlc-bugfix: shell drives the engine with --scope bugfix [.sh test f]", () => {
    const body = readFileSync(runnerPath("bugfix"), "utf-8");
    expect(body).toContain("aidlc-orchestrate.ts next --scope bugfix");
    // STRONGER: the generator renders the same forwarding-loop call.
    const rendered = renderRunner("bugfix", DISCOVERED.bugfix?.description ?? "");
    expect(rendered).toContain("aidlc-orchestrate.ts next --scope bugfix");
  });

  // ===========================================================================
  // Generator drift guard is clean over the shipped tree (1 test, mechanism cli).
  // The .sh: `bun GEN scopes --check >/dev/null 2>&1` exits 0. The exit code is a
  // process.exit contract (:474 exit 1 on drift / :476 returns clean), so it is
  // spawned, not imported.
  // ===========================================================================
  test("runner-gen scopes --check is drift-clean on the shipped tree [.sh test g]", () => {
    const r = spawnSync(BUN, [GEN, "scopes", "--check"], { encoding: "utf-8" });
    // .sh asserted only `ok` on exit 0; STRONGER: also assert the in-sync headline.
    expect(r.status).toBe(0);
    expect(`${r.stdout ?? ""}`).toContain("scope-runner(s) in sync");
  }, 30000);

  // ===========================================================================
  // Negative — a non-batch scope ships no runner (1 test). `refactor` is a
  // shipped scope (.claude/scopes/aidlc-refactor.md) but NOT in FIRST_BATCH, so
  // it must run via `--scope`, never a runner. Pins runners as a curated subset.
  // ===========================================================================
  test("non-batch scope (refactor) has no runner — runs via --scope [.sh test h]", () => {
    // .sh: assert_file_not_exists skills/aidlc-refactor/SKILL.md.
    expect(existsSync(runnerPath("refactor"))).toBe(false);
    // STRONGER: refactor IS a discovered scope (so its absence is a deliberate
    // curation, not a missing scope file) and it is genuinely NOT in FIRST_BATCH.
    expect("refactor" in DISCOVERED).toBe(true);
    expect(BATCH.includes("refactor")).toBe(false);
  });

  // ===========================================================================
  // Generator emits a runner for a newly-dropped scope file (1 test, mechanism
  // cli + env seam). Drop a fixture scope into an isolated tree, point the
  // generator at it with AIDLC_SCOPES_DIR + `--all --out <isolated>`, and confirm
  // it emits the runner driving that scope. Proves "add a scope file -> generator
  // emits its runner" with no code change. Both env seams are evaluated inside
  // the subprocess (:315 reader, :449 writer), so this is spawned.
  // ===========================================================================
  test("AIDLC_SCOPES_DIR + --all --out emits a runner for a dropped scope file (no code change) [.sh test i]", () => {
    const tmpScopes = mkdtempSync(join(tmpdir(), "t130-scopes-"));
    const tmpOut = mkdtempSync(join(tmpdir(), "t130-out-"));
    tempDirs.push(tmpScopes, tmpOut);

    // Byte-for-byte the .sh's hotfix heredoc (:82-92): a leaner-than-bugfix
    // urgent-patch scope file with a name/description the generator reads.
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
    // The .sh swallowed the exit code (`|| true`) and only checked the artefacts;
    // STRONGER: a successful generation exits 0.
    expect(r.status).toBe(0);

    // .sh: the runner file exists AND drives `next --scope hotfix`.
    const emitted = join(tmpOut, "aidlc-hotfix", "SKILL.md");
    expect(existsSync(emitted)).toBe(true);
    const emittedBody = readFileSync(emitted, "utf-8");
    expect(emittedBody).toContain("next --scope hotfix");
    // STRONGER: the emitted runner is spec-conformant (name == dir) too.
    expect(frontmatterName(emittedBody)).toBe("aidlc-hotfix");
  }, 30000);
});
