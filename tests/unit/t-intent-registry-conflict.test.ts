// covers: function:readIntentRegistry, function:appendIntentToRegistry, function:updateIntentStatus, function:writeIntentRegistry
//
// Two clones of one shared workspace each start work in one space and the
// second pulls: git leaves intents.json conflicted. The list of work then reads
// every row of both sides, any write keeps them all, and the person hears once
// that every row was kept, in words still true if they ran git add before the
// line is said. Their git is never touched.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendIntentToRegistry,
  pendingPersonLines,
  readIntentRegistry,
  updateIntentStatus,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, DEFAULT_INTENT_UUID } from "../harness/fixtures.ts";

const SESSION = "01995100-0000-7000-8000-00000000c0f1";
const LINE =
  "Your list of work, aidlc/spaces/default/intents/intents.json, had a git conflict: every piece of work " +
  "from both sides was kept. If git still shows the file as conflicted, git add marks it resolved.";

const roots: string[] = [];
let seed = "";
afterEach(() => {
  cleanupTestProject(seed);
  seed = "";
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
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

function row(slug: string, uuid: string) {
  return { uuid, slug, dirName: `261013-${slug}`, scope: "feature", status: "in-flight" };
}

const CHECKOUT = "01a133cc-bd6c-73a2-bf0f-8bef147badc5";
const BILLING = "01a133cc-be8e-77d8-9e9f-edae9bb18bcf";

// Alex and Blair clone one shared workspace, each start work, Alex pushes,
// and Blair pulls into the conflict. Returns Blair's clone.
const unmergedIn = new Map<string, () => string>();
function conflictedClone(style: string, pull: "--no-rebase" | "--rebase", cloneArgs: string[] = []): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-registry-conflict-")));
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
  seed = createTestProject();
  ok(seed, "init", "-q", "-b", "main");
  ok(seed, "config", "user.name", "AI-DLC Tests");
  ok(seed, "config", "user.email", "tests@example.com");
  ok(seed, "add", "-A");
  ok(seed, "commit", "-qm", "workspace with one piece of work");
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
  appendIntentToRegistry(alex, row("checkout", CHECKOUT), "default");
  ok(alex, "commit", "-qam", "alex: checkout");
  ok(alex, "push", "-q", "origin", "main");
  appendIntentToRegistry(blair, row("billing", BILLING), "default");
  ok(blair, "commit", "-qam", "blair: billing");
  const pulled = git(blair, "-c", `merge.conflictStyle=${style}`, "pull", pull, "origin", "main");
  expect(pulled.out).toContain("CONFLICT");
  expect(registryText(blair)).toContain("<<<<<<<");
  unmergedIn.set(blair, () => git(blair, "diff", "--name-only", "--diff-filter=U").out.trim());
  return blair;
}

function registryText(proj: string): string {
  return readFileSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8");
}

const uuids = (proj: string) => readIntentRegistry(proj, "default").map((entry) => entry.uuid).sort();
const ALL = [DEFAULT_INTENT_UUID, CHECKOUT, BILLING].sort();

describe("a list of work git left conflicted", () => {
  for (const [style, pull] of [
    ["merge", "--no-rebase"],
    ["diff3", "--no-rebase"],
    ["zdiff3", "--no-rebase"],
    ["merge", "--rebase"],
  ] as const) {
    test(`reads every row of both sides once (${style}, pull ${pull})`, () => {
      expect(uuids(conflictedClone(style, pull))).toEqual(ALL);
    });
  }

  test("reads every row of both sides in a checkout with CRLF line ends", () => {
    const blair = conflictedClone("merge", "--no-rebase", ["-c", "core.autocrlf=true"]);
    expect(registryText(blair)).toContain("\r\n=======\r\n");
    expect(uuids(blair)).toEqual(ALL);
  });

  test("new work keeps every row and leaves a list that parses", () => {
    const blair = conflictedClone("merge", "--no-rebase");
    appendIntentToRegistry(blair, row("reports", "01a133cc-c1f4-7a5c-93b1-43f58eeb82c3"), "default");
    const written = JSON.parse(registryText(blair)) as Array<{ uuid: string }>;
    expect(written.map((entry) => entry.uuid).sort()).toEqual([...ALL, "01a133cc-c1f4-7a5c-93b1-43f58eeb82c3"].sort());
    // The person's git is theirs: the file is still theirs to resolve.
    expect(unmergedIn.get(blair)!()).toBe("aidlc/spaces/default/intents/intents.json");
  });

  test("a status change on the other side's work lands and keeps every row", () => {
    const blair = conflictedClone("merge", "--no-rebase");
    expect(updateIntentStatus(blair, "261013-checkout", "complete", "default")).toBe(true);
    const rows = readIntentRegistry(blair, "default");
    expect(rows.map((entry) => entry.uuid).sort()).toEqual(ALL);
    expect(rows.find((entry) => entry.uuid === CHECKOUT)?.status).toBe("complete");
    expect(registryText(blair)).not.toContain("<<<<<<<");
  });

  test("the person hears once that every row was kept, in words true after their own git add", () => {
    const blair = conflictedClone("merge", "--no-rebase");
    const saved = { override: process.env.AIDLC_SESSION_OVERRIDE, source: process.env.AIDLC_SESSION_OVERRIDE_SOURCE };
    process.env.AIDLC_SESSION_OVERRIDE = SESSION;
    process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
    try {
      appendIntentToRegistry(blair, row("reports", "01a133cc-c1f4-7a5c-93b1-43f58eeb82c3"), "default");
      expect(pendingPersonLines(blair, SESSION).lines).toEqual([LINE]);
      appendIntentToRegistry(blair, row("search", "01a133cc-c2a0-7b11-8a22-5d1f2e3a4b5c"), "default");
      expect(pendingPersonLines(blair, SESSION).lines).toEqual([LINE]);
    } finally {
      if (saved.override === undefined) delete process.env.AIDLC_SESSION_OVERRIDE;
      else process.env.AIDLC_SESSION_OVERRIDE = saved.override;
      if (saved.source === undefined) delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
      else process.env.AIDLC_SESSION_OVERRIDE_SOURCE = saved.source;
    }
  });
});
