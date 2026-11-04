// A git worktree of a project starts without the git-ignored per-user cursors
// (aidlc/active-space, a space's active-intent). Until its own first switch it
// reads the ones its main checkout holds, so it finds the project's space and
// intent as the main checkout does; a separate clone does not, a worktree's own
// cursor wins once it has one, and an archive there stops the record resolving.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeIntent,
  activeSpace,
  clearActiveIntentCursor,
  ensureActiveSpaceCursor,
  readActiveIntentCursor,
} from "../../core/tools/aidlc-lib.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

// A main checkout with two intents in space demo-space, its cursors set, and
// the cursors git-ignored as every project's .gitignore has them.
function project(): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), "aidlc-wt-cursors-"));
  roots.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  git(main, ["config", "user.name", "t"]);
  git(main, ["config", "user.email", "t@example.test"]);
  for (const record of ["261015-demo-one-aaaaaaaa", "261016-demo-two-bbbbbbbb"]) {
    const dir = join(main, "aidlc", "spaces", "demo-space", "intents", record);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "aidlc-state.md"), "# State\n");
  }
  mkdirSync(join(main, "aidlc", "spaces", "default"), { recursive: true });
  writeFileSync(join(main, "aidlc", "spaces", "default", ".keep"), "");
  writeFileSync(join(main, ".gitignore"), "aidlc/active-space\naidlc/spaces/*/intents/active-intent\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-qm", "records"]);
  writeFileSync(join(main, "aidlc", "active-space"), "demo-space\n");
  writeFileSync(join(main, "aidlc", "spaces", "demo-space", "intents", "active-intent"), "261016-demo-two-bbbbbbbb\n");
  return { root, main };
}

describe("a git worktree reads its main checkout's cursors until it has its own", () => {
  test("a fresh worktree resolves the main checkout's space and intent", () => {
    const { root, main } = project();
    const worktree = join(root, "main", ".claude", "worktrees", "fresh");
    git(main, ["worktree", "add", "-q", "--detach", worktree, "main"]);
    expect(activeSpace(main)).toBe("demo-space");
    expect(activeSpace(worktree)).toBe("demo-space");
    expect(readActiveIntentCursor(worktree)).toBe("261016-demo-two-bbbbbbbb");
    expect(activeIntent(worktree)).toBe("261016-demo-two-bbbbbbbb");
    // SessionStart writes the resolved space as the worktree's own cursor.
    ensureActiveSpaceCursor(worktree);
    expect(readFileSync(join(worktree, "aidlc", "active-space"), "utf-8")).toBe("demo-space\n");
  });

  test("the worktree's own cursor wins, and a main cursor naming a space it lacks is not read", () => {
    const { root, main } = project();
    const worktree = join(root, "wt");
    git(main, ["worktree", "add", "-q", "--detach", worktree, "main"]);
    writeFileSync(join(worktree, "aidlc", "active-space"), "default\n");
    expect(activeSpace(worktree)).toBe("default");
    rmSync(join(worktree, "aidlc", "active-space"));
    writeFileSync(join(main, "aidlc", "active-space"), "elsewhere\n");
    expect(activeSpace(worktree)).toBe("default");
  });

  test("an archive in the worktree stops the record resolving there, and leaves the main checkout's cursor", () => {
    const { root, main } = project();
    const two = "261016-demo-two-bbbbbbbb";
    const mainCursor = join(main, "aidlc", "spaces", "demo-space", "intents", "active-intent");
    const borrowed = join(root, "borrowed");
    git(main, ["worktree", "add", "-q", "--detach", borrowed, "main"]);
    expect(readActiveIntentCursor(borrowed)).toBe(two);
    clearActiveIntentCursor(borrowed, "demo-space", two);
    expect(readActiveIntentCursor(borrowed)).toBeNull();
    expect(activeIntent(borrowed)).toBeNull();
    const own = join(root, "own");
    git(main, ["worktree", "add", "-q", "--detach", own, "main"]);
    writeFileSync(join(own, "aidlc", "spaces", "demo-space", "intents", "active-intent"), `${two}\n`);
    clearActiveIntentCursor(own, "demo-space", two);
    expect(readActiveIntentCursor(own)).toBeNull();
    expect(readFileSync(mainCursor, "utf-8")).toBe(`${two}\n`);
    expect(readActiveIntentCursor(main)).toBe(two);
  });

  test("a separate clone is another project and keeps the default", () => {
    const { root, main } = project();
    const clone = join(root, "clone");
    git(root, ["clone", "-q", main, clone]);
    expect(activeSpace(clone)).toBe("default");
    expect(readActiveIntentCursor(clone, "demo-space")).toBeNull();
  });
});
