// covers: function:settleConflictedState, subcommand:aidlc-orchestrate:next
//
// Two clones advance the same piece of work and the second brings the other's
// commit in: a pull that merges, a pull that rebases, or a stash popped after
// the pull. Git leaves its conflict in AI-DLC's record of the work. The engine
// carries on from the person's own side, read from git's own state, writes the
// record back without git's markers, and says once where the other side stands
// and the git command that takes it. Git's index is never touched.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getField, settleConflictedState } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  DEFAULT_RECORD_DIR,
  runOrchestrateNext,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const SESSION = "01995100-0000-7000-8000-00000000c0f3";
const STATE = `aidlc/spaces/default/intents/${DEFAULT_RECORD_DIR}/aidlc-state.md`;
const STASH_SIDE = /^>{7} Stashed changes\r?$/m;

const roots: string[] = [];
const seeds: string[] = [];
afterEach(() => {
  while (seeds.length > 0) cleanupTestProject(seeds.pop());
  while (roots.length > 0) {
    const root = roots.pop()!;
    try {
      chmodSync(join(root, "blair", STATE), 0o644);
    } catch {
      // no read-only record in this case
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function gitEnv(root: string): NodeJS.ProcessEnv {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "", "utf-8");
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_SYSTEM: empty,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
  };
}

type Bring = "merge" | "diff3" | "zdiff3" | "rebase" | "stash";

interface Clone {
  blair: string;
  git: (...args: string[]) => { code: number; out: string };
  env: NodeJS.ProcessEnv;
}

// Alex finishes Requirements Analysis and pushes. Blair, still in it, changes
// the record too and brings Alex's commit in: the record is left conflicted.
function conflictedClone(bring: Bring, cloneArgs: string[] = [], beforeBring?: (blair: string) => void): Clone {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-state-conflict-")));
  roots.push(root);
  const env = gitEnv(root);
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf-8" });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const ok = (cwd: string, ...args: string[]) => {
    const r = git(cwd, ...args);
    expect(r.code, `git ${args.join(" ")}: ${r.out}`).toBe(0);
  };
  const remote = join(root, "shared.git");
  ok(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
  seeds.push(seed);
  ok(seed, "init", "-q", "-b", "main");
  ok(seed, "config", "user.name", "AI-DLC Tests");
  ok(seed, "config", "user.email", "tests@example.com");
  ok(seed, "add", "-A");
  ok(seed, "commit", "-qm", "work at Requirements Analysis");
  ok(seed, "push", "-q", remote, "main");
  const clone = (name: string) => {
    const dir = join(root, name);
    ok(root, "clone", "-q", ...cloneArgs, remote, dir);
    ok(dir, "config", "user.name", name);
    ok(dir, "config", "user.email", `${name}@example.com`);
    return dir;
  };
  const alex = clone("alex");
  const blair = clone("blair");
  const edit = (dir: string, change: (text: string) => string) => {
    const path = join(dir, STATE);
    writeFileSync(path, change(readFileSync(path, "utf-8")), "utf-8");
  };
  edit(alex, (text) =>
    text
      .replace(/^- \[-\] requirements-analysis /m, "- [x] requirements-analysis ")
      .replace(/^(- \*\*Current Stage\*\*:) requirements-analysis/m, "$1 code-generation")
      .replace(/^(- \*\*Last Updated\*\*:) .*?(\r?)$/m, "$1 2025-07-16T09:00:00Z$2"));
  ok(alex, "commit", "-qam", "alex: Requirements Analysis approved");
  ok(alex, "push", "-q", "origin", "main");
  edit(blair, (text) => text.replace(/^(- \*\*Last Updated\*\*:) .*?(\r?)$/m, "$1 2025-07-16T09:30:00Z$2"));
  beforeBring?.(blair);
  if (bring === "stash") {
    ok(blair, "stash", "-q");
    ok(blair, "pull", "-q", "--no-rebase", "origin", "main");
    expect(git(blair, "stash", "pop").out).toContain("CONFLICT");
  } else {
    ok(blair, "commit", "-qam", "blair: still in Requirements Analysis");
    const style = bring === "rebase" ? "merge" : bring;
    const pulled = git(blair, "-c", `merge.conflictStyle=${style}`, "pull", bring === "rebase" ? "--rebase" : "--no-rebase", "origin", "main");
    expect(pulled.out).toContain("CONFLICT");
  }
  expect(readFileSync(join(blair, STATE), "utf-8")).toContain("<<<<<<<");
  return { blair, git: (...args: string[]) => git(blair, ...args), env };
}

const state = (clone: Clone) => readFileSync(join(clone.blair, STATE), "utf-8");
const unmerged = (clone: Clone) => clone.git("ls-files", "-u", "--", STATE).out.trim().split("\n").filter(Boolean).length;

function line(command: string | null, resolved: boolean): string {
  const other = command ? `is still in git, and \`${command}\` takes it instead.` : "is in your git history.";
  return `Git left a conflict in AI-DLC's record of this work (${STATE}): AI-DLC carried on from your side ` +
    `(at Requirements Analysis); the other side (at Code Generation) ${other}` +
    (resolved ? " If git still shows the file as conflicted, git add marks it resolved." : "");
}

describe("a record of the work git left conflicted", () => {
  for (const bring of ["merge", "diff3", "zdiff3"] as const) {
    test(`after a pull that merges (${bring}), the record is your own side, with no markers`, () => {
      const clone = conflictedClone(bring);
      const said = settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
      const text = state(clone);
      expect(text).not.toMatch(/^(<{7}|={7}|>{7}|\|{7})/m);
      expect(getField(text, "Current Stage")).toBe("requirements-analysis");
      expect(getField(text, "Last Updated")).toBe("2025-07-16T09:30:00Z");
      expect(said).toBe(line(`git checkout --theirs -- ${STATE}`, true));
    });
  }

  test("after a pull that rebases, the record is your own commit's side, not the teammate's", () => {
    const clone = conflictedClone("rebase");
    const said = settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
    expect(getField(state(clone), "Current Stage")).toBe("requirements-analysis");
    expect(getField(state(clone), "Last Updated")).toBe("2025-07-16T09:30:00Z");
    expect(said).toBe(line(`git checkout --ours -- ${STATE}`, false));
  });

  test("after a stash popped over the pull, the record is your stashed side", () => {
    const clone = conflictedClone("stash");
    expect(state(clone)).toMatch(STASH_SIDE);
    const said = settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
    expect(getField(state(clone), "Current Stage")).toBe("requirements-analysis");
    expect(getField(state(clone), "Last Updated")).toBe("2025-07-16T09:30:00Z");
    expect(said).toBe(line(`git checkout --ours -- ${STATE}`, true));
  });

  test("a stash popped with git's markers set longer than seven is still your stashed side", () => {
    const clone = conflictedClone("stash", [], (blair) =>
      writeFileSync(join(blair, ".git", "info", "attributes"), "aidlc-state.md conflict-marker-size=32\n", "utf-8"));
    expect(state(clone)).toMatch(/^>{32} Stashed changes$/m);
    const said = settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
    expect(state(clone)).not.toMatch(/^[<=>|]{7}/m);
    expect(getField(state(clone), "Last Updated")).toBe("2025-07-16T09:30:00Z");
    expect(said).toBe(line(`git checkout --ours -- ${STATE}`, true));
  });

  test("a checkout with Windows line ends keeps them", () => {
    const clone = conflictedClone("merge", ["-c", "core.autocrlf=true"]);
    expect(state(clone)).toContain("\r\n=======\r\n");
    settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
    const text = state(clone);
    expect(text).not.toContain("<<<<<<<");
    expect(text.split("\n").slice(0, -1).every((row) => row.endsWith("\r"))).toBe(true);
  });

  test("git's index is untouched: the file stays conflicted until you add it, and the named command takes the other side", () => {
    const clone = conflictedClone("merge");
    expect(unmerged(clone)).toBe(3);
    settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
    expect(unmerged(clone)).toBe(3);
    expect(clone.git("checkout", "--theirs", "--", STATE).code).toBe(0);
    expect(getField(state(clone), "Current Stage")).toBe("code-generation");
  });

  test("markers you already added are settled from your side of each conflict, and the line names no command", () => {
    const clone = conflictedClone("merge");
    expect(clone.git("add", "--", STATE).code).toBe(0);
    const said = settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
    const text = state(clone);
    expect(text).not.toContain("<<<<<<<");
    // Git merged the teammate's lines that did not clash; each clash keeps yours.
    expect(getField(text, "Last Updated")).toBe("2025-07-16T09:30:00Z");
    expect(said).toBe(
      `Git left a conflict in AI-DLC's record of this work (${STATE}): both sides stand at Code Generation, ` +
        "and AI-DLC carried on from yours; the other side is in your git history.",
    );
  });

  test("a stash popped over the pull and added with its markers is still your stashed side", () => {
    const clone = conflictedClone("stash");
    expect(clone.git("add", "--", STATE).code).toBe(0);
    const said = settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default");
    expect(getField(state(clone), "Last Updated")).toBe("2025-07-16T09:30:00Z");
    expect(said).toContain("in your git history.");
    expect(said).not.toContain("git checkout");
  });

  test("the line is one line", () => {
    const said = settleConflictedState(conflictedClone("merge").blair, DEFAULT_RECORD_DIR, "default");
    expect(typeof said).toBe("string");
    expect(said).not.toMatch(/[\r\n]/);
  });

  test("a record the person made read-only is left as it is, and nothing claims a write", () => {
    const clone = conflictedClone("merge");
    const before = state(clone);
    chmodSync(join(clone.blair, STATE), 0o444);
    expect(settleConflictedState(clone.blair, DEFAULT_RECORD_DIR, "default")).toBeNull();
    expect(state(clone)).toBe(before);
  });

  test("a record with no conflict is never written by the check", () => {
    const seed = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
    seeds.push(seed);
    const path = seededStateFile(seed);
    chmodSync(path, 0o444);
    try {
      expect(settleConflictedState(seed, DEFAULT_RECORD_DIR, "default")).toBeNull();
    } finally {
      chmodSync(path, 0o644);
    }
  });
});

describe("the next step on a record git left conflicted", () => {
  for (const flag of ["--status", "--help", "--version"]) {
    test(`a read-only next ${flag} leaves the record and git's index as they are`, () => {
      const clone = conflictedClone("merge");
      const before = state(clone);
      const env = { ...clone.env, CLAUDE_PROJECT_DIR: clone.blair, AIDLC_PROJECT_DIR: clone.blair, AIDLC_SESSION_OVERRIDE: SESSION };
      const run = runOrchestrateNext(join(clone.blair, ".claude", "tools", "aidlc-orchestrate.ts"), clone.blair, [flag], { cwd: clone.blair, env });
      expect(run.status, run.out).toBe(0);
      expect(state(clone)).toBe(before);
      expect(unmerged(clone)).toBe(3);
      expect(run.out).not.toContain("Git left a conflict");
    });
  }

  for (const bring of ["merge", "rebase"] as const) {
    test(`after a pull that ${bring === "merge" ? "merges" : "rebases"}, next carries on at your own stage and says so once`, () => {
      const clone = conflictedClone(bring);
      const env = { ...clone.env, CLAUDE_PROJECT_DIR: clone.blair, AIDLC_PROJECT_DIR: clone.blair, AIDLC_SESSION_OVERRIDE: SESSION };
      const tool = join(clone.blair, ".claude", "tools", "aidlc-orchestrate.ts");
      const first = runOrchestrateNext(tool, clone.blair, [], { cwd: clone.blair, env });
      expect(first.status, first.out).toBe(0);
      expect(first.directive?.kind, first.out).toBe("run-stage");
      expect(first.directive?.stage).toBe("requirements-analysis");
      expect(state(clone)).not.toContain("<<<<<<<");
      const command = `git checkout ${bring === "merge" ? "--theirs" : "--ours"} -- ${STATE}`;
      expect(first.out).toContain(line(command, bring === "merge"));
      const again = runOrchestrateNext(tool, clone.blair, [], { cwd: clone.blair, env });
      expect(again.out).not.toContain("Git left a conflict");
    });
  }
});
