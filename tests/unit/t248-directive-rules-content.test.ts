// covers: subcommand:aidlc-orchestrate:next
//
// t248 — rules_content: the run-stage directive carries the CONTENT of each
// resolved rule file, not just its path (#495). Mechanism = cli.
//
// The defect: `buildRunStageDirective` shipped `rules_in_context` as paths only
// and nothing in the engine forced the conductor to read them, so per-stage
// steering (org / phase memory) could be skipped silently. The fix mirrors the
// existing `conductor_persona` injection: the engine reads each resolved rule
// file at directive-build time and bakes its text into a new optional
// `rules_content` array. `rules_in_context` is unchanged and stays
// authoritative; `rules_content` is an additive superset over the files that
// carried real content.
//
// Source under test (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   ruleTextIsSubstantive(text)   — a rule file counts only when it has at least
//                                   one line that is not blank / heading / `>`
//                                   blockquote / HTML-comment fence. The shipped
//                                   team.md + project.md seeds are pure
//                                   scaffolding and are therefore dropped.
//   readRuleContent(dir, relPath) — best-effort read; null on absent,
//                                   unreadable, or placeholder-only.
//   buildRunStageDirective(...)   — injects rules_content ONLY when codekbCtx is
//                                   present (the live path supplies projectDir)
//                                   and at least one file was substantive.
// None are exported, so the behaviour is observable only on the directive the
// spawned engine writes to stdout — hence MECHANISM = cli, matching t116's
// vehicle for the same builder.
//
// VEHICLE (same as t116): seed a fixture project, pivot `Current Stage` to the
// target slug, flip its checkbox to in-flight `[-]`, then run bare `next`. That
// lands Branch 10 and emits a run-stage for the target with rules resolved.
//
// NOTE on the fixture: createTestProject() only MKDIRs the memory dir — it does
// not populate it (seedWorkspaceShell creates the cursors + registry, not the
// method tree). The shipped rule layers must be copied in from AIDLC_MEMORY_SRC,
// exactly as setupIntegrationProject does. Without that copy every
// rules_in_context path resolves to a missing file and rules_content is
// correctly absent — which is itself the "6: no memory tree" case below.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_MEMORY_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
  sedReplaceInFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const ORCH = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-orchestrate.ts",
);
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

// The memory layer the workspace shell seeds, projectDir-relative — the same
// form rules_in_context (and therefore rules_content[].path) uses.
const MEM = `aidlc/spaces/${DEFAULT_SPACE}/memory`;
const ORG = `${MEM}/org.md`;
const TEAM = `${MEM}/team.md`;
const PROJECT = `${MEM}/project.md`;

resetAidlcEnv();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface RuleContent {
  path: string;
  text: string;
}
interface RunStageDirective {
  kind: string;
  stage: string;
  rules_in_context: string[];
  rules_content?: RuleContent[];
}

/**
 * Seed a fresh project from `fixture` WITH the shipped method tree, optionally
 * mutate its memory layer, pivot to `slug`, and return the parsed run-stage
 * directive from a bare `next`. Pass `seedMemory: false` to leave the memory dir
 * empty (the no-rules-on-disk case).
 */
function emitFor(
  fixture: string,
  slug: string,
  mutate?: (proj: string) => void,
  seedMemory = true,
): RunStageDirective {
  const proj = createTestProject();
  tempDirs.push(proj);
  // The rule layers live at the dist tree root beside .claude/; copy them in so
  // the resolved rules_in_context paths point at real files (setupIntegrationProject
  // does the same).
  if (seedMemory) {
    cpSync(AIDLC_MEMORY_SRC, join(proj, "aidlc"), { recursive: true });
  }
  seedStateFile(proj, join(FIXTURES_DIR, fixture));
  mutate?.(proj);
  const state = seededStateFile(proj);
  sedReplaceInFile(
    state,
    /^- \*\*Current Stage\*\*:.*$/m,
    `- **Current Stage**: ${slug}`,
  );
  sedReplaceInFile(
    state,
    new RegExp(`^- \\[.\\] ${slug} — EXECUTE`, "m"),
    `- [-] ${slug} — EXECUTE`,
  );
  const res = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  let dir: RunStageDirective;
  try {
    dir = JSON.parse((res.stdout ?? "").trim());
  } catch {
    throw new Error(
      `emitFor(${fixture}, ${slug}) emitted no parseable JSON. status=${res.status}\n${res.stdout ?? ""}${res.stderr ?? ""}`,
    );
  }
  expect(dir.kind).toBe("run-stage");
  expect(dir.stage).toBe(slug);
  return dir;
}

/** The rules_content entry for a projectDir-relative rule path, if present. */
function entryFor(dir: RunStageDirective, path: string): RuleContent | undefined {
  return (dir.rules_content ?? []).find((r) => r.path === path);
}

describe("t248 run-stage rules_content (#495 — steering arrives as content, not a path)", () => {
  // === 1. the field exists on a live emit, and carries real text ============
  test("1: a live run-stage carries rules_content with the org rule's full text", () => {
    const dir = emitFor("state-brownfield-feature.md", "application-design");
    expect(dir.rules_content).toBeDefined();
    const org = entryFor(dir, ORG);
    expect(org, `${ORG} must appear in rules_content`).toBeDefined();
    // Not a path, not a stub: the shipped org.md body, verbatim from disk.
    expect((org as RuleContent).text.length).toBeGreaterThan(100);
    expect((org as RuleContent).text).toContain("## ");
  });

  // === 2. rules_in_context stays authoritative and unchanged ===============
  test("2: every rules_content path is one of the resolved rules_in_context paths", () => {
    const dir = emitFor("state-brownfield-feature.md", "application-design");
    // rules_content is a SUBSET of rules_in_context (the substantive files) —
    // it never introduces a path the roster does not already carry.
    for (const entry of dir.rules_content ?? []) {
      expect(dir.rules_in_context, `${entry.path} must be in rules_in_context`).toContain(
        entry.path,
      );
    }
    // The paths roster itself is unaffected by the injection.
    expect(dir.rules_in_context).toContain(ORG);
    expect(dir.rules_in_context).toContain(TEAM);
    expect(dir.rules_in_context).toContain(PROJECT);
  });

  // === 3. placeholder-only seeds are dropped ===============================
  test("3: the shipped team.md / project.md seeds are excluded (scaffolding only)", () => {
    const dir = emitFor("state-brownfield-feature.md", "application-design");
    // Both are RESOLVED (they are in the roster) but carry no affirmed rule, so
    // injecting them would put pure noise — headings, `>` guidance, and HTML
    // comment examples — into every directive.
    expect(entryFor(dir, TEAM)).toBeUndefined();
    expect(entryFor(dir, PROJECT)).toBeUndefined();
  });

  // === 4. a team rule with real content IS injected ========================
  test("4: team.md is injected once it carries an affirmed rule", () => {
    const marker = "ALWAYS write commit messages in imperative mood.";
    const dir = emitFor("state-brownfield-feature.md", "application-design", (proj) => {
      appendFileSync(
        join(proj, ...TEAM.split("/")),
        `\n## Affirmed\n\n- ${marker}\n`,
        "utf-8",
      );
    });
    const team = entryFor(dir, TEAM);
    expect(team, "a substantive team.md must be injected").toBeDefined();
    expect((team as RuleContent).text).toContain(marker);
  });

  // === 5. an emptied rule file drops out without breaking the directive ====
  test("5: an emptied org.md drops from rules_content, directive stays well-formed", () => {
    const dir = emitFor("state-brownfield-feature.md", "application-design", (proj) => {
      // Heading + blockquote + comment only — the placeholder shape.
      writeFileSync(
        join(proj, ...ORG.split("/")),
        "# Org Rules\n\n> Guidance for this layer.\n\n<!-- example -->\n",
        "utf-8",
      );
    });
    expect(entryFor(dir, ORG)).toBeUndefined();
    // The roster still names it — resolution is unchanged, only the content
    // injection self-gates.
    expect(dir.rules_in_context).toContain(ORG);
    expect(dir.kind).toBe("run-stage");
  });

  // === 6. the phase rule follows the stage's phase =========================
  test("6: the injected phase rule is the one matching the stage's phase", () => {
    const dir = emitFor("state-brownfield-feature.md", "application-design");
    // application-design is an INCEPTION stage, so phases/inception.md is the
    // attached phase rule — not ideation's.
    const phaseRule = `${MEM}/phases/inception.md`;
    expect(dir.rules_in_context).toContain(phaseRule);
    const entry = entryFor(dir, phaseRule);
    expect(entry, "the stage's phase rule must be injected").toBeDefined();
    expect((entry as RuleContent).text.length).toBeGreaterThan(0);
  });

  // === 7. no memory tree on disk — resolution unchanged, no field ==========
  test("7: with no rule files on disk the field is absent and routing is unaffected", () => {
    const dir = emitFor("state-brownfield-feature.md", "application-design", undefined, false);
    // Every resolved path is missing, so nothing is injected. The roster and the
    // directive kind are untouched: the injection is strictly additive and never
    // a routing error.
    expect(dir.rules_content).toBeUndefined();
    expect(dir.rules_in_context).toContain(ORG);
    expect(dir.kind).toBe("run-stage");
  });
});
