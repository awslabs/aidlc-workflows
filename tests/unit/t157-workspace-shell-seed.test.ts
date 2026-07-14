// covers: function:loadRules
//
// t157 — the seeded workspace SHELL + re-rooted .gitignore (SEED).
//
// WHAT. dist/<harness>/ must ship a READY workspace shell so the very first
// /aidlc resolves with no --init (vision §9, three seeding moments — the SHELL
// is the install-time moment). SEED owns four shell pieces on top of P5's
// relocated method tree:
//   (1) aidlc/spaces/default/memory/      — the method DEFAULTS (P5 emits the
//       org/team/project + phases/<p>.md; SEED adds the templates/ FLOOR).
//   (2) aidlc/spaces/default/memory/templates/  — the TPL override-resolution
//       floor (empty but present, via a .gitkeep, so the sensor's default
//       lookup <projectDir>/aidlc/memory/templates is a clean miss, not a
//       missing-dir edge — aidlc-sensor.ts).
//   (3) aidlc/active-space                — the per-user space CURSOR, shipped
//       pointed at the always-present "default" so a fresh copy resolves the
//       default space with zero ceremony. GITIGNORED in the user's workspace
//       (§5.1), yet SHIPPED as part of the shell (the dist .gitignore ignores
//       it for the END USER; our repo commits it once via git add -f).
//   (4) the per-harness NATIVE INCLUDE that points the CLI at the method tree
//       (Claude @-stub, Kiro resources glob, Codex AGENTS.md/AIDLC_RULES_DIR) —
//       P5 authored these; SEED proves a FRESH COPY resolves through them.
//
// Plus the re-rooted .gitignore — now a PER-HARNESS artifact (net-new for
// Kiro/Codex, which shipped none): the committed-vs-ignored split re-rooted
// under aidlc/spaces/* (vision §5.1). Cursors (active-space, active-intent) +
// machine-local runtime (runtime-graph.json, .aidlc-*) are IGNORED; the shared
// work — memory, codekb, registry, state, AUDIT (per-clone shards under
// audit/), artifacts — is COMMITTED. The audit shards are committed WITHOUT a
// .gitattributes merge=union (which was proven to corrupt the multi-line audit
// blocks — the RESOLVED audit-shards decision).
//
// SCOPE BOUNDARY. SEED ships the SHELL only. The lazy per-space skeleton
// (intents/codekb/knowledge ensure-exists) + the workspace-scaffold→ensure-
// exists rename is P4's auto-birth territory; the audit-shard WRITER/READER
// mechanism is P1 Step B's. This test asserts ONLY what SEED ships: the shell
// resolves + the gitignore split is correct. It must NOT assert a .migrated
// marker or a dummy intents/*/aidlc-state.md (that would defeat P1's
// flat-layout migration detection).
//
// Mechanism: file-inspection over the committed dist trees (zero tokens) +
// in-process loadRules() against a freshly-copied shell via the documented
// AIDLC_RULES_DIR seam (no LLM, no subprocess).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetGraphCache, loadRules } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const HARNESSES = HARNESS_MATRIX.map((harness) => harness.name);

// The shipped method tree for a harness: dist/<h>/aidlc/spaces/default/memory/.
const mem = (h: string, ...parts: string[]): string =>
  join(REPO_ROOT, "dist", h, "aidlc", "spaces", "default", "memory", ...parts);
// The shipped active-space cursor: dist/<h>/aidlc/active-space.
const activeSpace = (h: string): string =>
  join(REPO_ROOT, "dist", h, "aidlc", "active-space");
// The shipped per-harness gitignore: dist/<h>/.gitignore.
const gitignore = (h: string): string => join(REPO_ROOT, "dist", h, ".gitignore");

const tempDirs: string[] = [];
let savedRulesDir: string | undefined;
beforeEach(() => {
  savedRulesDir = process.env.AIDLC_RULES_DIR;
});
afterEach(() => {
  if (savedRulesDir === undefined) delete process.env.AIDLC_RULES_DIR;
  else process.env.AIDLC_RULES_DIR = savedRulesDir;
  __resetGraphCache();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("t157 seeded workspace shell + re-rooted .gitignore (SEED)", () => {
  // === (a) dist-shell — every harness ships the full method DEFAULTS ========
  test("1: every harness ships the method defaults at aidlc/spaces/default/memory/", () => {
    for (const h of HARNESSES) {
      // The renamed method files (P5) — neutral names, NOT aidlc-*.md.
      for (const f of ["org.md", "team.md", "project.md"]) {
        expect(existsSync(mem(h, f)), `${h}: ${f}`).toBe(true);
      }
      for (const p of ["ideation", "inception", "construction", "operation"]) {
        expect(existsSync(mem(h, "phases", `${p}.md`)), `${h}: phases/${p}.md`).toBe(true);
      }
    }
  });

  // === (a) dist-shell — the TPL templates FLOOR ships (empty but present) ===
  test("2: every harness ships the templates/ floor (TPL override-resolution root)", () => {
    for (const h of HARNESSES) {
      const dir = mem(h, "templates");
      expect(existsSync(dir), `${h}: templates/ dir`).toBe(true);
      // The floor is empty-but-present — only the .gitkeep keeps the dir, NO
      // framework default templates ship (resolution falls through to the
      // sensor's >=2-H2 floor when a template is absent).
      const entries = readdirSync(dir);
      expect(entries, `${h}: templates/ holds only .gitkeep`).toEqual([".gitkeep"]);
    }
  });

  // === (a) dist-shell — the active-space cursor ships pointed at "default" ==
  test("3: every harness ships aidlc/active-space → \"default\"", () => {
    for (const h of HARNESSES) {
      expect(existsSync(activeSpace(h)), `${h}: active-space present`).toBe(true);
      // Exactly the bare space name + a trailing newline — a fresh copy resolves
      // the always-present default space with zero ceremony.
      expect(readFileSync(activeSpace(h), "utf-8").trim(), `${h}: active-space value`).toBe(
        "default",
      );
    }
  });

  // === (a) dist-shell — the per-harness NATIVE INCLUDE ships ================
  test("4: every harness ships its native include pointing at the method tree", () => {
    for (const harness of HARNESS_MATRIX) {
      if (harness.capabilities.memoryInclude === "claude-import") {
        const stub = readFileSync(join(harness.engineRoot, "rules", "aidlc.md"), "utf-8");
        expect(stub).toContain("@../../aidlc/spaces/default/memory/org.md");
      } else if (harness.capabilities.memoryInclude === "kiro-resources") {
        const agent = JSON.parse(
          readFileSync(join(harness.engineRoot, "agents", "aidlc.json"), "utf-8"),
        ) as { resources: string[] };
        expect(agent.resources, harness.name).toContain(
          "file://aidlc/spaces/default/memory/**/*.md",
        );
      } else {
        const config = readFileSync(join(harness.engineRoot, "config.toml"), "utf-8");
        expect(config).toContain('AIDLC_RULES_DIR = "aidlc/spaces/default/memory"');
        expect(existsSync(harness.onboardingDist)).toBe(true);
      }
    }
  });

  // === (a) dist-shell — SEED ships ONLY the shell, not P1/P4 territory ======
  test("5: SEED ships an EMPTY shell — no lazy intents/codekb/knowledge, no migration marker", () => {
    // The vision §9 / plan boundary: SEED ships memory defaults + include +
    // active-space + templates floor + gitignore. It does NOT ship the lazy
    // per-space skeleton (intents/codekb/knowledge — P4 ensure-exists) and must
    // NOT ship anything P1's flat-layout migration detection keys off (a
    // .migrated marker, or a dummy intents/*/aidlc-state.md) — that would
    // silently orphan a legacy aidlc-docs/ tree on upgrade.
    for (const h of HARNESSES) {
      const spaceDefault = join(REPO_ROOT, "dist", h, "aidlc", "spaces", "default");
      // The ONLY thing under spaces/default/ is memory/ (the shipped method).
      expect(readdirSync(spaceDefault).sort(), `${h}: spaces/default/ holds only memory/`).toEqual([
        "memory",
      ]);
      // No detection-defeating signals anywhere under the shipped aidlc/ shell.
      const aidlcRoot = join(REPO_ROOT, "dist", h, "aidlc");
      expect(existsSync(join(aidlcRoot, "spaces", "default", "intents")), `${h}: no intents/`).toBe(
        false,
      );
      expect(existsSync(join(aidlcRoot, ".migrated")), `${h}: no .migrated marker`).toBe(false);
    }
  });

  // === (b) fresh-copy readiness — the shell + include resolve on a copy =====
  test("6: a FRESH COPY of dist/<h>/ resolves the method through the shipped shell", () => {
    // Simulate the install moment: copy the whole dist tree into an empty
    // workspace, then resolve the method the way AIDLC's own resolver does —
    // point loadRules at the copied shell's memory tree (the AIDLC_RULES_DIR
    // seam is exactly what the packager / a real install set). A ready shell
    // resolves the four-layer chain (org→team→project→phase) with no --init.
    for (const h of HARNESSES) {
      const ws = mkdtempSync(join(tmpdir(), `aidlc-t157-${h}-`));
      tempDirs.push(ws);
      cpSync(join(REPO_ROOT, "dist", h), ws, { recursive: true });
      const copiedMemory = join(ws, "aidlc", "spaces", "default", "memory");
      expect(existsSync(copiedMemory), `${h}: copied shell has the method tree`).toBe(true);
      process.env.AIDLC_RULES_DIR = copiedMemory;
      __resetGraphCache();
      const scopes = loadRules()
        .map((r) => r.scope)
        .sort();
      // org/team/project are always present in the shipped defaults; phase rules
      // attach the four phase files — so the resolved set spans all four layers.
      expect(scopes, `${h}: resolved layers on a fresh copy`).toContain("org");
      expect(scopes, `${h}: resolved layers on a fresh copy`).toContain("team");
      expect(scopes, `${h}: resolved layers on a fresh copy`).toContain("project");
      expect(scopes, `${h}: resolved layers on a fresh copy`).toContain("phase");
    }
  });

  // === (c) the re-rooted .gitignore — every harness ships one ===============
  test("7: every harness ships exactly its declared project-root regular files", () => {
    for (const harness of HARNESS_MATRIX) {
      const actualRootFiles = readdirSync(harness.distRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
      expect(actualRootFiles, `${harness.name}: project-root regular files`).toEqual(
        [...harness.capabilities.rootFiles].sort(),
      );
    }
  });

  // === (c) the re-rooted .gitignore — CURSORS + runtime IGNORED =============
  test("8: the gitignore IGNORES the per-user cursors + machine-local runtime", () => {
    for (const h of HARNESSES) {
      const gi = readFileSync(gitignore(h), "utf-8");
      const lines = gi.split("\n").map((l) => l.trim());
      // The two session cursors (re-rooted under aidlc/).
      expect(lines, `${h}: ignores aidlc/active-space`).toContain("aidlc/active-space");
      expect(lines, `${h}: ignores active-intent`).toContain(
        "aidlc/spaces/*/intents/active-intent",
      );
      // Machine-local runtime / derived.
      expect(lines, `${h}: ignores per-intent runtime-graph.json`).toContain(
        "aidlc/spaces/*/intents/*/runtime-graph.json",
      );
      expect(lines, `${h}: ignores per-intent .aidlc-*`).toContain(
        "aidlc/spaces/*/intents/*/.aidlc-*",
      );
      // The flat-layout ignore rules are GONE (no leftover aidlc-docs/ leaf).
      const hasActiveIgnore = (pat: string): boolean =>
        lines.some((l) => l === pat); // an ignore rule, not the in-comment mention
      expect(hasActiveIgnore("aidlc-docs/audit.md"), `${h}: no flat aidlc-docs/audit.md ignore`).toBe(
        false,
      );
      expect(
        hasActiveIgnore("aidlc-docs/runtime-graph.json"),
        `${h}: no flat aidlc-docs/runtime-graph.json ignore`,
      ).toBe(false);
    }
  });

  // === (c) the re-rooted .gitignore — audit SHARDS committed, NO merge=union =
  test("9: audit shards (audit/*.md) are COMMITTED — no active ignore rule, no merge=union", () => {
    for (const h of HARNESSES) {
      const gi = readFileSync(gitignore(h), "utf-8");
      const lines = gi.split("\n").map((l) => l.trim());
      // The shard path must NOT have an ACTIVE ignore rule (a bare leaf line);
      // it may only appear inside a comment documenting the committed set.
      const isIgnoreRule = (l: string): boolean => l.length > 0 && !l.startsWith("#");
      const ignoresAuditShards = lines.some(
        (l) => isIgnoreRule(l) && /audit\/.*\.md$/.test(l),
      );
      expect(ignoresAuditShards, `${h}: audit/*.md must stay committed (no ignore rule)`).toBe(
        false,
      );
      const ignoresWholeAudit = lines.some(
        (l) => isIgnoreRule(l) && (l === "aidlc-docs/audit.md" || /\/audit\.md$/.test(l)),
      );
      expect(ignoresWholeAudit, `${h}: no single-audit-file ignore`).toBe(false);
    }
    // The RESOLVED decision forbids a .gitattributes merge=union driver anywhere
    // in the shipped trees (it corrupts the multi-line audit blocks; per-clone
    // shards make a merge driver unnecessary).
    for (const h of HARNESSES) {
      const distRoot = join(REPO_ROOT, "dist", h);
      const ga = join(distRoot, ".gitattributes");
      if (existsSync(ga)) {
        expect(readFileSync(ga, "utf-8")).not.toContain("merge=union");
      }
    }
    // And no .gitattributes was authored alongside any gitignore in harness/.
    for (const h of HARNESSES) {
      expect(
        existsSync(join(REPO_ROOT, "harness", h, "dot-gitattributes")),
        `${h}: no authored .gitattributes`,
      ).toBe(false);
    }
  });

  // === (c) the re-rooted .gitignore — the committed-truth COMMENT is present =
  test("10: the gitignore documents the committed set (memory/codekb/registry/state/audit/artifacts)", () => {
    // The committed paths carry no ignore rule, so they are documented in a
    // comment for the human reader — assert that record is present + complete so
    // a future edit can't silently drop a committed family into the ignore set.
    for (const h of HARNESSES) {
      const gi = readFileSync(gitignore(h), "utf-8");
      for (const token of [
        "memory/**",
        "codekb/**",
        "intents.json",
        "aidlc-state.md",
        "audit/*.md",
      ]) {
        expect(gi, `${h}: gitignore documents committed ${token}`).toContain(token);
      }
      // The merge=union prohibition is stated in the gitignore prose too.
      expect(gi, `${h}: gitignore states the no-merge=union rationale`).toContain("merge=union");
    }
  });
});
