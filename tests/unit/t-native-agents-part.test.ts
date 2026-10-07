// covers: file:scripts/package.ts, tool:aidlc-init
//
// A native release ships each root file AI-DLC merges into (AGENTS.md, the
// .gitignore part) twice: at the project root, and as the part config and the
// engine take AI-DLC's text from (tools/data/root-blocks/). The native build
// rewrote the root file into the native wording ("Framework commands run
// through `aidlc`") but left the part in the copy channel's ("bun ... must be on
// your PATH"), so a native Copilot install was told it needs bun from its first
// refresh on. The part is the root file's text, in both channels.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyChannelOmits, projectionFiles, rootBlockPath, walkFiles } from "../../core/tools/aidlc-distribution.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const NATIVE_LINE = "Framework commands run through `aidlc`";
const COPY_LINE = "must be on your PATH";

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function config(project: string, from: string, harness: string): { status: number; out: string } {
  const machine = temp("aidlc-t-native-part-machine-");
  const result = spawnSync(
    BUN,
    [INIT, "config", "--project-dir", project, "--from", from, "--harness", harness, "--mcp", "none", "--yes"],
    {
      cwd: project,
      env: { ...process.env, AIDLC_INSTALL_ROOT: join(machine, "share"), AIDLC_BIN_DIR: join(machine, "bin") },
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("a root file's part is the root file's text", () => {
  test("in every harness's native release and copy runtime", () => {
    let checked = 0;
    for (const harness of HARNESS_MATRIX) {
      for (const channel of ["dist-release", "dist"]) {
        const root = join(REPO_ROOT, channel, harness.name);
        const { descriptor } = projectionFiles(root);
        for (const integration of descriptor.rootIntegrations) {
          if (integration.policy !== "managed-block") continue;
          const file = join(root, integration.path);
          const part = rootBlockPath(join(root, descriptor.harnessDir), integration);
          if (!existsSync(file) || !existsSync(part)) continue;
          expect(readFileSync(part, "utf-8"), `${channel}/${harness.name} ${integration.path}`).toBe(
            readFileSync(file, "utf-8"),
          );
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  for (const harness of ["copilot", "claude"] as const) {
    const onboarding = harness === "copilot" ? "AGENTS.md" : join(".claude", "CLAUDE.md");
    test(`${harness}: a native install keeps its native wording through a refresh`, () => {
      const project = temp(`aidlc-t-native-part-${harness}-`);
      mkdirSync(join(project, ".git"));
      const release = join(REPO_ROOT, "dist-release", harness);
      for (const step of ["install", "refresh"]) {
        const run = config(project, release, harness);
        expect(run.status, `${step}: ${run.out}`).toBe(0);
        const text = readFileSync(join(project, onboarding), "utf-8");
        expect(text, step).toContain(NATIVE_LINE);
        expect(text, step).not.toContain(COPY_LINE);
      }
    });
  }

  // A copied project config never ran in (the copy channel's setup line is
  // optional) moves to the native install of the same release: every file is
  // the copy's, untouched, so config adopts them all (troubleshooting).
  test("copilot: an untouched copied project with no record configures from the native release", () => {
    const copy = join(REPO_ROOT, "dist", "copilot");
    const omitted = copyChannelOmits(projectionFiles(copy).descriptor);
    const project = temp("aidlc-t-native-part-copied-");
    mkdirSync(join(project, ".git"));
    for (const rel of walkFiles(copy)) {
      if (omitted.has(rel.replaceAll("\\", "/"))) continue;
      mkdirSync(dirname(join(project, rel)), { recursive: true });
      cpSync(join(copy, rel), join(project, rel));
    }
    expect(existsSync(join(project, ".aidlc", "tools", "data", "aidlc-manifest.json"))).toBe(false);
    const configured = config(project, join(REPO_ROOT, "dist-release", "copilot"), "copilot");
    expect(configured.status, configured.out).toBe(0);
    expect(configured.out).not.toContain("locally modified or unowned");
    expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toContain(NATIVE_LINE);
  });

  test("copilot: a native project already told it needs bun refreshes to the native wording", () => {
    // What a refresh wrote before this fix: AI-DLC's part in the copy wording.
    const earlier = join(temp("aidlc-t-native-part-earlier-"), "copilot");
    cpSync(join(REPO_ROOT, "dist-release", "copilot"), earlier, { recursive: true });
    const { descriptor } = projectionFiles(earlier);
    const agents = descriptor.rootIntegrations.find((item) => item.path === "AGENTS.md");
    expect(agents).toBeDefined();
    const copyPart = readFileSync(
      rootBlockPath(join(REPO_ROOT, "dist", "copilot", descriptor.harnessDir), agents!),
      "utf-8",
    );
    for (const path of [join(earlier, "AGENTS.md"), rootBlockPath(join(earlier, descriptor.harnessDir), agents!)]) {
      writeFileSync(path, copyPart);
    }
    const project = temp("aidlc-t-native-part-old-");
    mkdirSync(join(project, ".git"));
    expect(config(project, earlier, "copilot").status).toBe(0);
    expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toContain(COPY_LINE);
    const refreshed = config(project, join(REPO_ROOT, "dist-release", "copilot"), "copilot");
    expect(refreshed.status, refreshed.out).toBe(0);
    expect(refreshed.out).not.toContain("conflict(s)");
    const text = readFileSync(join(project, "AGENTS.md"), "utf-8");
    expect(text).toContain(NATIVE_LINE);
    expect(text).not.toContain(COPY_LINE);
  });
});
