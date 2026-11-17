// covers: tool:aidlc-init, file:scripts/package.ts, file:core/tools/aidlc-distribution.ts, file:scripts/copy-era-files.ts
//
// A project AI-DLC 2.1.1 to 2.7.0 set up by copying its tree carries no install
// record, so `aidlc config` tells AI-DLC's own unchanged files from the
// person's by the bytes those releases shipped (scripts/copy-era-files.json,
// merged into each harness's projection by scripts/package.ts). The fixtures
// are the files as 2.6.18, 2.6.20 and 2.3.0 shipped them: an agent this release still
// ships, the Application Design stage it no longer ships, and 2.3.0's own
// settings with a hook this release retired, and 2.6.18's own settings with
// its guard registrations. Unchanged, the first is refreshed and the others
// removed and listed, each once, and the old registrations become the native
// ones with every allow entry kept and no note that they had been changed;
// changed by the person, a file is kept and named, never overwritten.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const CLAUDE_COPY = join(REPO_ROOT, "dist", "claude");
const CLAUDE_RELEASE = join(REPO_ROOT, "dist-release", "claude");
const OLD = join(REPO_ROOT, "tests", "fixtures", "copy-era", "claude");
const AGENT = ".claude/agents/aidlc-architect-agent.md";
const RETIRED = ".claude/aidlc-common/stages/inception/application-design.md";

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// The copied tree as a person had it: the copy channel's files, with an agent
// as 2.6.18 shipped it and the stage 2.3.0 shipped that this release does not.
function copyEraProject(): string {
  const project = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-copy-era-"));
  temporary.push(project);
  cpSync(CLAUDE_COPY, project, { recursive: true });
  mkdirSync(join(project, ".git"));
  for (const rel of [AGENT, RETIRED]) {
    mkdirSync(join(project, rel, ".."), { recursive: true });
    cpSync(join(OLD, rel), join(project, rel));
  }
  return project;
}

function config(project: string): { status: number; out: string } {
  const r = spawnSync(BUN, [INIT, "config", "--project-dir", project, "--from", CLAUDE_RELEASE, "--harness", "claude"], {
    cwd: project, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("t-copy-era-refresh", () => {
  test("unchanged copy-era files are AI-DLC's own: the agent is refreshed, the retired stage removed and named once", () => {
    const project = copyEraProject();
    const r = config(project);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(project, AGENT))).toEqual(readFileSync(join(CLAUDE_RELEASE, AGENT)));
    expect(existsSync(join(project, RETIRED))).toBe(false);
    expect(r.out).not.toContain("locally modified or unowned");
    expect(r.out).not.toContain("schema validation failed");
    expect(r.out.match(/no longer part of AI-DLC/g)?.length).toBe(1);
    expect(r.out).toContain(RETIRED);
  });

  test("a 2.3.0 tree's own settings and retired hook: the hook is removed once and the refresh lands", () => {
    const project = copyEraProject();
    for (const rel of [".claude/settings.json", ".claude/hooks/aidlc-mint-presence.ts"]) cpSync(join(OLD, rel), join(project, rel));
    const r = config(project);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("transaction operations overlap");
    expect(existsSync(join(project, ".claude", "hooks", "aidlc-mint-presence.ts"))).toBe(false);
    expect(existsSync(join(project, RETIRED))).toBe(false);
  });

  test("2.6.18's own guard registrations go to the native ones, the person's allow list untouched", () => {
    const project = copyEraProject();
    const old = join(REPO_ROOT, "tests", "fixtures", "copy-era", "claude-2.6.18");
    cpSync(join(old, ".claude"), join(project, ".claude"), { recursive: true });
    const allowBefore = (JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf-8")) as {
      permissions: { allow: string[] };
    }).permissions.allow;
    const r = config(project);
    expect(r.status, r.out).toBe(0);
    const after = readFileSync(join(project, ".claude", "settings.json"), "utf-8");
    expect(after).not.toContain('bun \\"$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-');
    expect(after).toContain('"aidlc engine hook guard-tool-call"');
    // The old release wrote those registrations; nobody changed them.
    expect(r.out).not.toContain("they had been changed");
    const allowAfter = (JSON.parse(after) as { permissions: { allow: string[] } }).permissions.allow;
    for (const entry of allowBefore) expect(allowAfter).toContain(entry);
  });

  // The copy channel was the v2 branch, so a project can hold a version no tag
  // names: 2.6.20's own files are AI-DLC's too.
  test("files a copy of an untagged version shipped (2.6.20) are refreshed, not called the person's", () => {
    const project = copyEraProject();
    const old = join(REPO_ROOT, "tests", "fixtures", "copy-era", "claude-2.6.20");
    cpSync(join(old, ".claude"), join(project, ".claude"), { recursive: true });
    const r = config(project);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("locally modified or unowned");
    for (const rel of [".claude/tools/aidlc-version.ts", ".claude/skills/aidlc/SKILL.md"]) {
      expect(readFileSync(join(project, rel))).toEqual(readFileSync(join(CLAUDE_RELEASE, rel)));
    }
  });

  test("a copy-era file the person changed is kept and named, nothing overwritten", () => {
    const project = copyEraProject();
    appendFileSync(join(project, AGENT), "\nOur team reviews every design with the platform group first.\n");
    const before = readFileSync(join(project, AGENT));
    const r = config(project);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain(`${AGENT} (locally modified or unowned)`);
    expect(r.out.match(/locally modified or unowned/g)?.length).toBe(1);
    expect(readFileSync(join(project, AGENT))).toEqual(before);
  });
});
