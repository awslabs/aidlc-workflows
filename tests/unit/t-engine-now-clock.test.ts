// covers: subcommand:aidlc-utility:now, file:aidlc-common/protocols/stage-protocol.md, file:aidlc-common/protocols/stage-protocol-learnings.md, file:aidlc-common/stages/initialization/state-init.md, file:knowledge/aidlc-product-lead-agent/reviewing.md, file:knowledge/aidlc-architecture-reviewer-agent/reviewing.md
//
// One clock for every time AI-DLC asks the agent to write. The agent used to
// take a timestamp with `date -u`: a permission prompt on every tool that does
// not pre-approve it, and on Windows PowerShell local time with a Z on the end
// (`date` there is Get-Date, and `-u` is its -UFormat). `aidlc engine now`
// prints the engine's own UTC time, runs wherever engine commands run, and no
// shipped instruction or allowlist names `date -u` any more.
//
// Mechanism: the packaged Claude tree's dispatcher in a scratch project, then
// content checks over every generated tree (dist and dist-release).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const env = () => ({
  ...process.env, AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined, KIRO_PROJECT_DIR: undefined,
} as NodeJS.ProcessEnv);

describe("aidlc engine now prints the engine's UTC time", () => {
  test("one second-precision UTC timestamp, exit 0, inside a project", () => {
    const proj = createTestProject();
    projects.push(proj);
    const before = Date.now();
    const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "now"], {
      cwd: proj, env: env(), encoding: "utf-8",
    });
    const after = Date.now();
    expect(result.status, result.stderr).toBe(0);
    const printed = result.stdout.trim();
    expect(printed).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const at = Date.parse(printed);
    expect(at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(at).toBeLessThanOrEqual(after);
  });
});

// Every text file of every generated tree, AI-DLC's tool sources aside.
function shippedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "tools" && name !== "node_modules") walk(path);
      } else if (/\.(md|mdc|json|toml|yaml|yml|txt)$/.test(name)) {
        out.push(path);
      }
    }
  };
  for (const root of ["dist", "dist-release"]) {
    if (existsSync(join(REPO_ROOT, root))) walk(join(REPO_ROOT, root));
  }
  return out;
}

describe("no shipped file asks for or pre-approves date -u", () => {
  test("instructions, agent prompts, allowlists and onboarding name no date -u", () => {
    const files = shippedFiles();
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const file of files) {
      // The answer-logging rule says the tool stamps the row itself.
      const body = readFileSync(file, "utf-8").replaceAll("there is no `date -u` call", "");
      if (body.includes("date -u") || body.includes("[ISO timestamp from Bash]")) {
        hits.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(hits).toEqual([]);
  });

  test("the timestamp instructions name engine now", () => {
    for (const rel of [
      "aidlc-common/protocols/stage-protocol.md",
      "aidlc-common/protocols/stage-protocol-learnings.md",
      "aidlc-common/stages/initialization/state-init.md",
    ]) {
      expect(readFileSync(join(AIDLC_SRC, rel), "utf-8"), rel).toContain("bun .claude/tools/aidlc.ts engine now");
    }
  });

  // A reviewer is handed the time instead of asking for it: the review request
  // the conductor runs before every dispatch returns `reviewed_at`, the brief
  // carries it, and the reviewer writes its Date line from the brief. On Claude
  // Code the reviewer subagent used to spell the engine by absolute path, which
  // no allow rule covers, so the person was asked to approve an AI-DLC step
  // mid-review. The same clock still answers; nobody runs it for a date.
  test("the reviewer templates take the time from the brief and run nothing for it", () => {
    for (const rel of [
      "knowledge/aidlc-product-lead-agent/reviewing.md",
      "knowledge/aidlc-architecture-reviewer-agent/reviewing.md",
    ]) {
      const body = readFileSync(join(AIDLC_SRC, rel), "utf-8");
      expect(body, rel).toContain("the UTC time the dispatch brief names on its `Date for this review:` line");
      expect(body, rel).toContain("run no command for it");
      expect(body, rel).not.toContain("engine now");
      expect(body, rel).not.toContain("date -u");
    }
    // The engine's own side of the hand-off: the request returns the field the
    // brief carries, and the protocol step tells the conductor to carry it.
    expect(readFileSync(join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol-reviewer.md"), "utf-8"))
      .toContain("Date for this review: <reviewed_at>");
  });

  test("a Kiro IDE reviewer may run it on both channels", () => {
    for (const agent of ["aidlc-product-lead-agent", "aidlc-architecture-reviewer-agent"]) {
      const copy = readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents", `${agent}.md`), "utf-8");
      expect(copy, agent).toContain('        - "bun .kiro/tools/aidlc.ts engine now"');
      const native = readFileSync(join(REPO_ROOT, "dist-release", "kiro-ide", ".kiro", "agents", `${agent}.md`), "utf-8");
      expect(native, agent).toContain('        - "aidlc engine now"');
    }
  });
});
