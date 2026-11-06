// covers: subcommand:aidlc-unit:publish
//
// A team's publish commits its own work: its tracked changes, its record under
// aidlc/ and the new files its source manifest claims. AI-DLC's own install
// and other new files (an unignored node_modules and the like) stay on disk,
// uncommitted; the publish says once how many it left out, and the person's
// "include node_modules too" puts them in with --include. The team's
// .gitignore is never touched.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
  tempDirs,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

function write(dir: string, path: string, body = "untracked\n"): void {
  const file = join(dir, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

// A team's claimed checkout whose alpha Unit is done; `claims` is what its
// Code Generation source manifest lists (none: no manifest).
function claimedDone(claims?: string[]): string {
  const { remote } = makeSeed();
  const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
  if (claims !== undefined) {
    write(
      join(seededRecordDir(checkout), "construction", "alpha", "code-generation"),
      "source-manifest.json",
      `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: claims.map((path) => ({ path })) })}\n`,
    );
  }
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
  );
  return checkout;
}

// AI-DLC's own Codex install and an unignored node_modules and coverage
// report, none in the team's .gitignore: 54 new files that are not the Unit's.
function addInstallAndDependencies(dir: string): void {
  write(dir, ".codex/tools/aidlc-orchestrate.ts");
  write(dir, ".codex/hooks.json", "{}\n");
  write(dir, ".agents/skills/aidlc/SKILL.md");
  write(dir, "coverage/index.html");
  for (let i = 0; i < 50; i++) write(dir, `node_modules/pkg-${i}/index.js`);
}

function publish(dir: string, ...extra: string[]): Record<string, unknown> {
  const published = runMergeTool(UNIT, ["publish", "alpha", "--commit", ...extra], dir);
  expect(published.status, published.out).toBe(0);
  return JSON.parse(published.stdout) as Record<string, unknown>;
}

// -z: git spells every name as it is, a non-ASCII one too (core.quotepath).
function committed(dir: string): string[] {
  return git(dir, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

function stillNew(dir: string): string[] {
  return git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
}

describe("a team's publish commits its own work", () => {
  test("AI-DLC's install and node_modules stay out, on disk; the publish says how many and how to put any in", () => {
    const checkout = claimedDone(["src/alpha.ts", "src/alpha-extra.ts"]);
    write(checkout, "src/alpha-extra.ts", "export const extra = 1;\n");
    addInstallAndDependencies(checkout);
    const ignoreBefore = readFileSync(join(checkout, ".gitignore"), "utf-8");
    const result = publish(checkout);
    expect(result).toMatchObject({ published: true, unit: "alpha", left_out: 54 });
    const files = committed(checkout);
    expect(files).toContain("src/alpha-extra.ts");
    expect(files.some((path) => path.endsWith("/construction/alpha/code-generation/source-manifest.json"))).toBe(true);
    expect(files.filter((path) => /^(\.codex|\.agents|node_modules|coverage)\//.test(path))).toEqual([]);
    expect(stillNew(checkout)).toHaveLength(54);
    expect(existsSync(join(checkout, "node_modules", "pkg-0", "index.js"))).toBe(true);
    expect(readFileSync(join(checkout, ".gitignore"), "utf-8")).toBe(ignoreBefore);
    expect(result.left_out_note).toBe(
      "I left out 54 new files here that this Unit's build did not list as its own, like node_modules/, .codex/ and .agents/ " +
        "(`git status` shows them); tell me if you want any of them in.",
    );
    expect(String(result.left_out_include)).toMatch(/ unit publish alpha --commit --include '<path>'/);
    expect(String(result.left_out_include)).toContain("or `--include .` for all of them");
    // No loop: the step after is the done notice, never the question again.
    expect(nextDirective(checkout)).toMatchObject({ kind: "notice", unit: "alpha" });
  });

  for (const spelling of ["node_modules", "node_modules/", "node_modules\\"]) {
    test(`"include node_modules too" (--include ${spelling}): it goes in and the Unit is published again`, () => {
      const checkout = claimedDone(["src/alpha.ts"]);
      addInstallAndDependencies(checkout);
      publish(checkout);
      const again = publish(checkout, "--include", spelling);
      expect(again.recovered).toBeUndefined();
      expect(again.candidate_head_oid).toBe(git(checkout, ["rev-parse", "HEAD"]));
      expect(committed(checkout).filter((path) => path.startsWith("node_modules/"))).toHaveLength(50);
      expect(again.left_out).toBe(4);
      expect(stillNew(checkout).every((path) => !path.startsWith("node_modules/"))).toBe(true);
      expect(nextDirective(checkout)).toMatchObject({ kind: "notice", unit: "alpha" });
    });
  }

  test("two --include flags at once put both in", () => {
    const checkout = claimedDone(["src/alpha.ts"]);
    addInstallAndDependencies(checkout);
    const result = publish(checkout, "--include", "coverage", "--include", "node_modules");
    expect(result.left_out).toBe(3);
    expect(committed(checkout)).toContain("coverage/index.html");
    expect(committed(checkout)).toContain("node_modules/pkg-7/index.js");
  });

  test("--include . puts every new file it left out in", () => {
    const checkout = claimedDone(["src/alpha.ts"]);
    addInstallAndDependencies(checkout);
    const result = publish(checkout, "--include", ".");
    expect(result.left_out).toBeUndefined();
    expect(result.include_unmatched_note).toBeUndefined();
    expect(stillNew(checkout)).toEqual([]);
  });

  test("an --include that names no left-out file is said in one line; the publish still publishes", () => {
    const checkout = claimedDone(["src/alpha.ts"]);
    addInstallAndDependencies(checkout);
    const result = publish(checkout, "--include", "vendor", "--include", "node_modules");
    expect(result.published).toBe(true);
    expect(result.include_unmatched_note).toBe("No new file here is at `vendor`, so nothing from there went in.");
    expect(committed(checkout)).toContain("node_modules/pkg-7/index.js");
  });

  test("a Unit whose work adds a new top-level folder commits it", () => {
    const checkout = claimedDone(["src/alpha.ts", "services/alpha/"]);
    write(checkout, "services/alpha/api.ts", "export const api = 1;\n");
    write(checkout, "services/alpha/db/schema.sql", "create table refunds (id int);\n");
    addInstallAndDependencies(checkout);
    const result = publish(checkout);
    expect(committed(checkout)).toEqual(expect.arrayContaining(["services/alpha/api.ts", "services/alpha/db/schema.sql"]));
    expect(result.left_out).toBe(54);
  });

  test("a Unit file its manifest does not list is left out and said, and --include puts it in", () => {
    const checkout = claimedDone(["src/alpha.ts"]);
    write(checkout, "src/alpha-extra.ts", "export const extra = 1;\n");
    const first = publish(checkout);
    expect(first.left_out).toBe(1);
    expect(first.left_out_note).toBe(
      "I left out 1 new file here that this Unit's build did not list as its own: src/alpha-extra.ts " +
        "(`git status` shows it); tell me if you want it in.",
    );
    const again = publish(checkout, "--include", "src/alpha-extra.ts");
    expect(again.left_out).toBeUndefined();
    expect(committed(checkout)).toContain("src/alpha-extra.ts");
  });

  test("with no source manifest, every new file outside aidlc/ stays out and is said", () => {
    const checkout = claimedDone();
    write(checkout, "notes.txt");
    addInstallAndDependencies(checkout);
    const result = publish(checkout);
    expect(result.left_out).toBe(55);
    expect(committed(checkout)).not.toContain("notes.txt");
  });

  // Windows caps one command line at 32,767 characters: the paths go to git on
  // its standard input, so a publish of thousands commits them on every
  // platform, each name as it is.
  test("a publish of 2,000 new files of the Unit's own work commits every one, each name as it is", () => {
    const checkout = claimedDone(["src/alpha.ts", "generated/"]);
    const odd = ["with space.md", "it's.md", "r\u00e9sum\u00e9.md", "-draft.md", "[draft].md"].map((name) => `generated/${name}`);
    for (const path of odd) write(checkout, path);
    for (let i = odd.length; i < 2_000; i++) write(checkout, `generated/client/models/model-number-${i}.ts`, "export {};\n");
    const result = publish(checkout);
    expect(result.published).toBe(true);
    expect(result.left_out).toBeUndefined();
    const files = committed(checkout);
    expect(files.filter((path) => path.startsWith("generated/"))).toHaveLength(2_000);
    expect(files).toEqual(expect.arrayContaining(odd));
    expect(git(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  test("the team's own pre-commit hook runs on the publish, as before", () => {
    const checkout = claimedDone(["src/alpha.ts", "src/alpha-extra.ts"]);
    write(checkout, "src/alpha-extra.ts", "export const extra = 1;\n");
    const hooks = join(checkout, "..", `${checkout.split(/[\\/]/).pop()}-hooks`);
    mkdirSync(hooks, { recursive: true });
    tempDirs.push(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho ran > \"$(dirname \"$0\")/ran\"\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    git(checkout, ["config", "core.hooksPath", hooks]);
    publish(checkout);
    expect(existsSync(join(hooks, "ran"))).toBe(true);
    expect(committed(checkout)).toContain("src/alpha-extra.ts");
  });

  test("the publish question names only the Unit's own work", () => {
    const checkout = claimedDone(["src/alpha.ts", "src/alpha-extra.ts"]);
    write(checkout, "src/alpha-extra.ts", "export const extra = 1;\n");
    addInstallAndDependencies(checkout);
    const offer = nextDirective(checkout);
    expect(offer).toMatchObject({ kind: "ask", ask_type: "team-handover", handovers: ["publish"] });
    expect(String(offer.question)).toMatch(/I'd commit the \d+ changed files of its work here \(new: src\/alpha-extra\.ts\)\.$/);
  });
});
