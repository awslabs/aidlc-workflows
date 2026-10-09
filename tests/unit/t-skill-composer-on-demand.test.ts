// covers: subcommand:aidlc-orchestrate:next
//
// The orchestrator SKILL loads in every chat, but its workflow-plan composer
// block (the dispatch, the proposal gate, what approval runs) is needed only
// when a plan is being composed. It lives in composer.md beside SKILL.md, and
// the engine's composer dispatch print tells the agent to read it at that
// moment. The plain-chat rules that sat beside it (reshape requests, named
// stage changes, project type, collaborators, the person's checks, settings,
// saving a plan) apply in any chat, so they stay in SKILL.md.
//
// Mechanism: readFileSync over every harness source and dist tree, plus one
// CLI spawn of the shipped dist engine for each dispatch mode; no LLM.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

// One phrase from each composer-only paragraph.
const COMPOSER_ONLY = [
  "COMPOSER DISPATCH",
  "Render that proposal to the human as a SHORT offer",
  "**Composition-moment authority.**",
  "**On approve (front/report), the write and the creation run in the SAME turn",
  "**In-flight recompose (a workflow is RUNNING):**",
  "The composer proposes; the human decides; the deterministic validator guards.",
];

// Rules a person can trigger in any chat: they stay in SKILL.md.
const ANY_CHAT = [
  "**Reshape requests arrive in plain chat too, not just as the literal verb.**",
  "**Named stage changes are done at once.**",
  "**New project or existing code, in plain chat.**",
  "**Collaborators in plain chat.**",
  "**The person's checks, off or on when they ask.**",
  "| review freeze | `guard.review-freeze` | `AIDLC_DISABLE_REVIEW_FREEZE_HOOK` |",
  "**Saving a plan for next time.**",
  "Mid-workflow, when the human asks in plain chat to turn sensors, learnings, summary confirmation, or reviews on or off, or plan approval on, just do it",
  "A review level set for the piece of work replaces its scope's ceiling",
  "After turning one on, check it with",
  "to skip plan approval, the harness records it and creation turns it off",
];

const TRIGGER = "read `composer.md` beside this file first";

function skillDirs(): Array<{ label: string; dir: string }> {
  const dirs: Array<{ label: string; dir: string }> = [];
  for (const harness of HARNESS_MATRIX) {
    dirs.push({ label: `harness/${harness.name}`, dir: join(harness.authoredRoot, "skills", "aidlc") });
    for (const channel of ["dist", "dist-release"]) {
      dirs.push({
        label: `${channel}/${harness.name}`,
        dir: join(REPO_ROOT, channel, harness.name, harness.capabilities.skillsRoot, "aidlc"),
      });
    }
  }
  return dirs;
}

describe("the composer block loads only when a plan is being composed", () => {
  test("no orchestrator SKILL.md carries the composer block", () => {
    const carrying: string[] = [];
    for (const { label, dir } of skillDirs()) {
      const skill = readFileSync(join(dir, "SKILL.md"), "utf-8");
      for (const phrase of COMPOSER_ONLY) {
        if (skill.includes(phrase)) carrying.push(`${label}: ${phrase}`);
      }
    }
    expect(carrying).toEqual([]);
  });

  test("every source and shipped tree has composer.md beside SKILL.md, with the whole block", () => {
    const gaps: string[] = [];
    for (const { label, dir } of skillDirs()) {
      const path = join(dir, "composer.md");
      if (!existsSync(path)) {
        gaps.push(`${label}: composer.md missing`);
        continue;
      }
      const composer = readFileSync(path, "utf-8");
      for (const phrase of COMPOSER_ONLY) {
        if (!composer.includes(phrase)) gaps.push(`${label}: composer.md lacks ${phrase}`);
      }
      if (!label.startsWith("harness/") && /\{\{[A-Z_]+\}\}/.test(composer)) {
        gaps.push(`${label}: composer.md keeps an unsubstituted token`);
      }
    }
    expect(gaps).toEqual([]);
  });

  test("every SKILL.md names composer.md and keeps the rules a person can trigger in any chat", () => {
    const gaps: string[] = [];
    for (const { label, dir } of skillDirs()) {
      const skill = readFileSync(join(dir, "SKILL.md"), "utf-8");
      if (!skill.includes(TRIGGER)) gaps.push(`${label}: no composer.md trigger`);
      for (const phrase of ANY_CHAT) {
        if (!skill.includes(phrase)) gaps.push(`${label}: SKILL.md lost ${phrase}`);
      }
    }
    expect(gaps).toEqual([]);
  });
});

describe("the composer dispatch tells the agent to read composer.md", () => {
  const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
  let proj = "";
  beforeAll(() => {
    resetAidlcEnv();
  });
  afterEach(() => {
    resetAidlcEnv();
    cleanupTestProject(proj);
    proj = "";
  });

  function dispatch(args: string[]): string {
    const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: process.env });
    const line = res.out.split("\n").find((l) => l.trim().startsWith("{"));
    expect(line, res.out).toBeDefined();
    const directive = JSON.parse(line as string) as { kind: string; message: string };
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain("aidlc-composer-agent");
    return directive.message;
  }

  test("before a workflow exists (compose a plan)", () => {
    proj = createTestProject();
    const message = dispatch(["compose", "add a hover tooltip to the chart"]);
    expect(message).toContain("composer.md");
    expect(message).not.toContain("composer block in SKILL.md");
  });

  test("while a workflow runs (recompose its remaining steps)", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const message = dispatch(["compose", "what else can we cut"]);
    expect(message).toContain("mode in-flight");
    expect(message).toContain("composer.md");
    expect(message).not.toContain("composer block in SKILL.md");
  });
});
