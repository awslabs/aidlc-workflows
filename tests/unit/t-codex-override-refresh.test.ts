// Codex's existing root override gets the same owned block as AGENTS.md.
// covers: function:projectRootIntegrations, function:addRootBlocks
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRootIntegrations, sha256Bytes, type RootIntegration } from "../../core/tools/aidlc-distribution.ts";
import { addRootBlocks } from "../../core/tools/aidlc-includes.ts";
import { instructionFileDoctorCheck } from "../../core/tools/aidlc-config-diagnostics.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const REPO = join(import.meta.dir, "../..");
const temporary: string[] = [];
function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-codex-override-")));
  temporary.push(root);
  return root;
}
afterAll(() => {
  for (const root of temporary) rmSync(root, { recursive: true, force: true });
});
const integrations: RootIntegration[] = [{ path: "AGENTS.md", policy: "managed-block", marker: "agents", shared: "identical" }];
const descriptor = { distribution: "codex", rootIntegrations: integrations };
const read = (root: string, path: string): string => readFileSync(join(root, path), "utf-8");

function config(project: string, source: string, machine: string): void {
  const result = spawnSync(process.execPath, [
    join(REPO, "core/tools/aidlc-init.ts"), "config", "--project-dir", project,
    "--from", source, "--harness", "codex", "--mcp", "none", "--yes", "--json", "--offline",
  ], {
    cwd: project,
    env: { ...process.env, HOME: machine, USERPROFILE: machine, AIDLC_INSTALL_ROOT: join(machine, "install"), AIDLC_BIN_DIR: join(machine, "bin") },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function block(text: string): string {
  const begin = "<!-- BEGIN AI-DLC:agents -->";
  const end = "<!-- END AI-DLC:agents -->";
  return text.slice(text.indexOf(begin), text.indexOf(end) + end.length);
}

describe("Codex root override refresh", () => {
  test("does not create an override or select a directory, and leaves other harnesses alone", () => {
    const root = temp();
    expect(projectRootIntegrations(root, descriptor)).toEqual(integrations);
    expect(existsSync(join(root, "AGENTS.override.md"))).toBe(false);
    mkdirSync(join(root, "AGENTS.override.md"));
    expect(projectRootIntegrations(root, descriptor)).toEqual(integrations);
    rmSync(join(root, "AGENTS.override.md"), { recursive: true });
    writeFileSync(join(root, "AGENTS.override.md"), "");
    expect(projectRootIntegrations(root, descriptor).map((item) => item.path)).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    expect(projectRootIntegrations(root, { ...descriptor, distribution: "kiro" })).toEqual(integrations);
    expect(descriptor.rootIntegrations).toEqual(integrations);
  });

  test("an unconfigured copy adds the block once and preserves the team's override text", () => {
    const root = temp();
    cpSync(join(REPO, "dist/codex/.codex"), join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, "AGENTS.override.md"), "# Team instructions\n\nKeep this wording.\n");
    expect(addRootBlocks(root)).toContain("AGENTS.override.md");
    const text = read(root, "AGENTS.override.md");
    expect(text).toStartWith("# Team instructions\n\nKeep this wording.\n");
    expect(text).toContain("<!-- BEGIN AI-DLC:agents -->");
    expect(addRootBlocks(root)).toEqual([]);
    expect(read(root, "AGENTS.override.md")).toBe(text);
  });

  test("the copy bootstrap leaves malformed override markers unchanged", () => {
    const root = temp();
    cpSync(join(REPO, "dist/codex/.codex"), join(root, ".codex"), { recursive: true });
    const broken = "# Team\n<!-- BEGIN AI-DLC:agents -->\nKeep this unfinished text.\n";
    writeFileSync(join(root, "AGENTS.override.md"), broken);
    addRootBlocks(root);
    expect(read(root, "AGENTS.override.md")).toBe(broken);
  });

  for (const channel of ["dist-release", "dist"]) {
    test(`${channel}: config records the override, refresh keeps it, and its removal restores ordinary guidance`, () => {
      const root = temp();
      const machine = temp();
      const source = join(REPO, channel, "codex");
      writeFileSync(join(root, "AGENTS.override.md"), "# Team instructions\n");
      config(root, source, machine);
      const text = read(root, "AGENTS.override.md");
      expect(text).toStartWith("# Team instructions\n");
      const baselinePath = ".codex/tools/data/aidlc-manifest.json";
      const baseline = JSON.parse(read(root, baselinePath));
      expect(baseline.rootContributions["AGENTS.override.md"].policy).toBe("managed-block");
      writeFileSync(join(root, "AGENTS.override.md"), `${text}\nTeam's closing note.\n`);
      config(root, source, machine);
      expect(read(root, "AGENTS.override.md")).toBe(`${text}\nTeam's closing note.\n`);
      expect(instructionFileDoctorCheck(root, ".codex").pass).toBe(true);
      rmSync(join(root, "AGENTS.override.md"));
      expect(instructionFileDoctorCheck(root, ".codex").pass).toBe(true);
      config(root, source, machine);
      expect(existsSync(join(root, "AGENTS.override.md"))).toBe(false);
    });
  }

  test("refresh adopts only the exact older block already recorded for AGENTS.md", () => {
    const root = temp();
    const machine = temp();
    const source = join(REPO, "dist-release/codex");
    config(root, source, machine);
    const current = read(root, "AGENTS.md");
    const earlier = block(current).replace("<!-- END AI-DLC:agents -->", "An earlier release's line.\n<!-- END AI-DLC:agents -->");
    writeFileSync(join(root, "AGENTS.md"), `${earlier}\n`);
    const baselinePath = ".codex/tools/data/aidlc-manifest.json";
    const baseline = JSON.parse(read(root, baselinePath));
    baseline.rootContributions["AGENTS.md"].hash = sha256Bytes(earlier);
    writeFileSync(join(root, baselinePath), `${JSON.stringify(baseline)}\n`);
    writeFileSync(join(root, "AGENTS.override.md"), `# Keep our text\n\n${earlier}\n`);
    config(root, source, machine);
    expect(read(root, "AGENTS.override.md")).toStartWith("# Keep our text\n");
    expect(block(read(root, "AGENTS.override.md"))).toBe(block(current));
    expect(instructionFileDoctorCheck(root, ".codex").pass).toBe(true);
  });
});
