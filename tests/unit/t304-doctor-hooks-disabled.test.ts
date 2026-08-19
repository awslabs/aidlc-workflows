// covers: subcommand:aidlc-utility:doctor (disableAllHooks detection)
//
// Issue #802: during a workshop a regulated-industry customer had hooks
// disabled by IT policy (`"disableAllHooks": true`). `/aidlc --doctor` reported
// every check green, yet the workflow was blocked at runtime because no hook
// could fire. Doctor only verified the hook FILES were present and wired — it
// never checked that Claude Code was allowed to RUN them. This pins the new
// "Hooks enabled" row: it must FAIL loudly (exit non-zero) when a resolved
// `disableAllHooks: true` is present, follow Claude Code's layer precedence so
// a higher-precedence `false` suppresses a lower `true`, and pass otherwise.

import { describe, expect, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

// Merge a patch into the project's copied .claude/settings.json so the base
// shipped hook wiring stays intact (we only toggle disableAllHooks).
function patchProjectSettings(proj: string, patch: Record<string, unknown>): void {
  const path = join(proj, ".claude", "settings.json");
  const current = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

function writeFile(proj: string, rel: string, content: string): void {
  writeFileSync(join(proj, rel), content, "utf-8");
}

// Run doctor with HOME pinned to the project so the user-settings layer
// (~/.claude/settings.json) resolves to a path under the project, keeping the
// test hermetic against the developer's real ~/.claude/settings.json.
function runDoctor(proj: string): { status: number; out: string } {
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env, HOME: proj, USERPROFILE: proj },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

describe("t283 doctor disableAllHooks gate", () => {
  test("a clean install passes the Hooks-enabled row", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    const { out } = runDoctor(proj);
    expect(out).toMatch(/Hooks enabled \(no disableAllHooks override\)/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });

  test("disableAllHooks:true in .claude/settings.json fails loudly and exits non-zero", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    patchProjectSettings(proj, { disableAllHooks: true });
    const { status, out } = runDoctor(proj);
    expect(out).toMatch(/Hooks DISABLED/);
    expect(out).toMatch(/\.claude\/settings\.json/);
    // The remedy explains the engine is hook-driven, not a cosmetic warning.
    expect(out).toMatch(/hook-driven/);
    expect(status).not.toBe(0);
  });

  test("disableAllHooks:false is not flagged (explicit enable)", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    patchProjectSettings(proj, { disableAllHooks: false });
    const { out } = runDoctor(proj);
    expect(out).toMatch(/Hooks enabled/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });

  test("settings.local.json disableAllHooks:true fails even when settings.json is silent", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    writeFile(proj, ".claude/settings.local.json", JSON.stringify({ disableAllHooks: true }, null, 2));
    const { status, out } = runDoctor(proj);
    expect(out).toMatch(/Hooks DISABLED/);
    expect(out).toMatch(/settings\.local\.json/);
    expect(status).not.toBe(0);
  });

  test("higher-precedence settings.local.json:false SUPPRESSES a lower settings.json:true", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    patchProjectSettings(proj, { disableAllHooks: true });
    writeFile(proj, ".claude/settings.local.json", JSON.stringify({ disableAllHooks: false }, null, 2));
    const { out } = runDoctor(proj);
    // The local layer wins → hooks are enabled → no disabled warning.
    expect(out).toMatch(/Hooks enabled/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });
});
