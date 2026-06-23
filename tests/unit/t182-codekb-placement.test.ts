// covers: function:codekbDir, function:relativeCodekbDir, function:codekbRepoName, subcommand:aidlc-utility:codekb-path
//
// t182 — codekb placement (deterministic, no-LLM). The fast-tier guard for the
// codekb-determinism effort: it pins the SPACE-LEVEL placement the engine now
// resolves for the reverse-engineering stage's artifacts —
// `aidlc/spaces/<space>/codekb/<repo>/` — at three layers, with ZERO tokens.
//
//   1. The PURE lib helpers (imported in-process from the shipped dist tree):
//      relativeCodekbDir / codekbDir compose the space-level per-repo dir, and
//      codekbRepoName picks the deterministic repo NAME (0 recorded → basename,
//      1 → that name, >1 → basename fallback).
//   2. The `codekb-path` UTILITY VERB (spawned as the real CLI surface): it prints
//      exactly what relativeCodekbDir composes, honouring --repo and --json.
//   3. The isCodekb RESOLVER BRANCH (observed on the run-stage directive the
//      spawned engine emits): a brownfield reverse-engineering directive resolves
//      its produces[]/consumes[] under the space-level codekb dir, NOT the
//      per-intent record dir.
//
// MECHANISM = cli. The lib helpers are EXPORTED (importable in-process, the
// `none` floor), but the `codekb-path` subcommand is an argv-dispatch surface
// whose guarantee-principle minMechanism is `cli` — only a SPAWNED tool proves it
// routes. This file spawns BOTH `aidlc-utility.ts codekb-path` and
// `aidlc-orchestrate.ts next` (the t116 vehicle), so gen-coverage-registry.ts
// derives `cli` from the body and the subcommand claim clears its bar while the
// three function claims clear `none`.
//
// FIXTURE DISCIPLINE mirrors t116: a fresh temp project per spawn (createTestProject
// seeds ONE default intent with NO repos row), cleaned in afterAll. With no repos
// recorded, codekbRepoName(proj) === basename(proj), so the resolved repo segment
// is the temp dir's basename — captured per-emit, not hard-coded.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
  sedReplaceInFile,
} from "../harness/fixtures.ts";
import {
  codekbDir,
  codekbRepoName,
  relativeCodekbDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const ORCH = join(TOOLS, "aidlc-orchestrate.ts");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

// Clear AWS_AIDLC_DEFAULT_SCOPE so a leaked shell export can't shadow the fixture
// scope (the same reset t116 does).
resetAidlcEnv();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function freshProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  return proj;
}

// A fresh project whose ACTIVE-intent cursor actually resolves: createTestProject
// seeds the registry row + cursor but NO aidlc-state.md, and activeIntent only
// honours the cursor when the record dir holds a state file (aidlc-lib.ts
// activeIntent). Seeding one makes intentRepos read the recorded row, so the
// codekbRepoName cases below exercise the real registry path, not the null-cursor
// fallback. The fixture's repos field stays absent until rewriteIntentRepos sets it.
function seedRecordedIntent(): string {
  const proj = freshProject();
  seedStateFile(proj, join(FIXTURES_DIR, "state-brownfield-feature.md"));
  return proj;
}

const childEnv = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  delete e.AWS_AIDLC_DEFAULT_SCOPE;
  return e;
};

// ============================================================================
// 1. The PURE lib helpers — space-level shape (imported in-process).
// ============================================================================
describe("t182 codekb lib helpers — space-level per-repo placement", () => {
  test("relativeCodekbDir(proj, repo, space) === aidlc/spaces/<space>/codekb/<repo>", () => {
    const proj = freshProject();
    expect(relativeCodekbDir(proj, "repo-x", DEFAULT_SPACE)).toBe(
      `aidlc/spaces/${DEFAULT_SPACE}/codekb/repo-x`,
    );
  });

  test("codekbDir(proj, repo, space) ends with the join of spaces/<space>/codekb/<repo>", () => {
    const proj = freshProject();
    const tail = join("spaces", DEFAULT_SPACE, "codekb", "repo-x");
    expect(codekbDir(proj, "repo-x", DEFAULT_SPACE).endsWith(tail)).toBe(true);
  });

  test("relativeCodekbDir defaults the space to the active-space cursor (default)", () => {
    const proj = freshProject(); // the fixture cursor is `default`
    expect(relativeCodekbDir(proj, "repo-x")).toBe(
      `aidlc/spaces/${DEFAULT_SPACE}/codekb/repo-x`,
    );
  });

  // codekbRepoName resolves the recorded repo set via intentRepos, which keys off
  // the ACTIVE intent — and activeIntent only honours the cursor when the record
  // dir holds an aidlc-state.md (aidlc-lib.ts activeIntent). So these cases seed a
  // state file first (seedRecordedIntent) so the cursor resolves to the row whose
  // repos we then rewrite; without it intentRepos returns [] for the wrong reason.

  // codekbRepoName: 0 recorded repos -> basename(projectDir). The seeded row has
  // NO repos field (the genuine 0-repo case, cursor resolving).
  test("codekbRepoName: 0 recorded repos → basename(projectDir)", () => {
    const proj = seedRecordedIntent(); // active row present, no repos field
    expect(codekbRepoName(proj, DEFAULT_SPACE)).toBe(basename(proj));
  });

  // codekbRepoName: exactly 1 recorded repo -> that repo name.
  test("codekbRepoName: 1 recorded repo → that name", () => {
    const proj = seedRecordedIntent();
    rewriteIntentRepos(proj, ["only-repo"]);
    expect(codekbRepoName(proj, DEFAULT_SPACE)).toBe("only-repo");
  });

  // codekbRepoName: >1 recorded repos -> basename(projectDir) (the safe default;
  // a caller that knows the repo passes --repo explicitly).
  test("codekbRepoName: >1 recorded repos → basename(projectDir)", () => {
    const proj = seedRecordedIntent();
    rewriteIntentRepos(proj, ["repo-a", "repo-b"]);
    expect(codekbRepoName(proj, DEFAULT_SPACE)).toBe(basename(proj));
  });
});

// ============================================================================
// 2. The `codekb-path` VERB — the real CLI surface (spawned). Prints exactly
//    what relativeCodekbDir composes; honours --repo and --json.
// ============================================================================
describe("t182 codekb-path verb — prints the space-level per-repo dir", () => {
  test("codekb-path --repo <name> prints aidlc/spaces/<space>/codekb/<repo>/", () => {
    const proj = freshProject();
    const res = spawnSync(BUN, [UTILITY, "codekb-path", "--project-dir", proj, "--repo", "svc"], {
      encoding: "utf-8",
      env: childEnv(),
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(`aidlc/spaces/${DEFAULT_SPACE}/codekb/svc/`);
  });

  test("codekb-path --json carries {space, repo, dir} matching relativeCodekbDir", () => {
    const proj = freshProject();
    const res = spawnSync(
      BUN,
      [UTILITY, "codekb-path", "--project-dir", proj, "--repo", "svc", "--json"],
      { encoding: "utf-8", env: childEnv() },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as {
      space: string;
      repo: string;
      dir: string;
    };
    expect(parsed.space).toBe(DEFAULT_SPACE);
    expect(parsed.repo).toBe("svc");
    expect(parsed.dir).toBe(relativeCodekbDir(proj, "svc", DEFAULT_SPACE));
  });

  test("codekb-path with NO --repo resolves codekbRepoName (0 repos → basename)", () => {
    const proj = freshProject();
    const res = spawnSync(BUN, [UTILITY, "codekb-path", "--project-dir", proj], {
      encoding: "utf-8",
      env: childEnv(),
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(
      `aidlc/spaces/${DEFAULT_SPACE}/codekb/${basename(proj)}/`,
    );
  });
});

// ============================================================================
// 3. The isCodekb RESOLVER BRANCH — observed on the emitted run-stage directive.
//    A brownfield reverse-engineering directive resolves its artifacts under the
//    space-level codekb dir, NOT the per-intent record dir. Vehicle = the t116
//    emitFor pattern (seed a brownfield fixture, pivot Current Stage to
//    reverse-engineering, flip its checkbox in-flight, run bare `next`).
// ============================================================================
interface RunStageDirective {
  kind: string;
  stage: string;
  consumes: string[];
  produces: string[];
}

function emitReverseEngineering(): { dir: RunStageDirective; proj: string } {
  const proj = freshProject();
  seedStateFile(proj, join(FIXTURES_DIR, "state-brownfield-feature.md"));
  const state = seededStateFile(proj);
  sedReplaceInFile(
    state,
    /^- \*\*Current Stage\*\*:.*$/m,
    `- **Current Stage**: reverse-engineering`,
  );
  sedReplaceInFile(
    state,
    /^- \[.\] reverse-engineering — EXECUTE/m,
    `- [-] reverse-engineering — EXECUTE`,
  );
  const res = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: childEnv(),
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  let dir: RunStageDirective;
  try {
    dir = JSON.parse((res.stdout ?? "").trim());
  } catch {
    throw new Error(
      `emitReverseEngineering did not emit parseable JSON. status=${res.status}\n${out}`,
    );
  }
  expect(dir.kind).toBe("run-stage");
  expect(dir.stage).toBe("reverse-engineering");
  return { dir, proj };
}

describe("t182 isCodekb resolver — reverse-engineering artifacts land under space-level codekb", () => {
  test("every reverse-engineering produces resolves under aidlc/spaces/<space>/codekb/<repo>/ (NOT the record dir)", () => {
    const { dir, proj } = emitReverseEngineering();
    // 0 recorded repos → the resolver keys codekbRepoName = basename(proj).
    const codekbPrefix = `${relativeCodekbDir(proj, basename(proj), DEFAULT_SPACE)}/`;
    expect(dir.produces.length).toBeGreaterThan(0);
    for (const p of dir.produces) {
      expect(p.startsWith(codekbPrefix), `produces ${p} not under codekb`).toBe(true);
      // It must NOT carry the per-intent record tail the OLD placement used.
      expect(p.includes("/intents/")).toBe(false);
      expect(p.includes("/inception/reverse-engineering/")).toBe(false);
    }
  });

  test("the 9 RE artifacts resolve to space-level codekb (architecture.md, component-inventory.md, …)", () => {
    const { dir, proj } = emitReverseEngineering();
    const codekbPrefix = `${relativeCodekbDir(proj, basename(proj), DEFAULT_SPACE)}/`;
    for (const stem of ["architecture", "component-inventory", "reverse-engineering-timestamp"]) {
      expect(dir.produces).toContain(`${codekbPrefix}${stem}.md`);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: overwrite the seeded intent's `repos` row in intents.json so
// codekbRepoName reads the recorded set. Mirrors how the fixture seeds the
// registry (one row, slug derived from DEFAULT_RECORD_DIR) — we only add/replace
// the `repos` array on that lone row.
// ---------------------------------------------------------------------------
function rewriteIntentRepos(proj: string, repos: string[]): void {
  const regPath = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", "intents.json");
  const rows = JSON.parse(readFileSync(regPath, "utf-8")) as Array<Record<string, unknown>>;
  rows[0].repos = repos;
  writeFileSync(regPath, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
}
