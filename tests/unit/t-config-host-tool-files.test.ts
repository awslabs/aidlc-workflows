// covers: function:hostToolPath
//
// A host tool installs things for itself inside a directory AI-DLC manages:
// opencode, at its first start, writes .opencode/package.json and .gitignore
// and installs its plugin dependencies under .opencode/node_modules, whose
// .bin entries are links. A copied project's config reads the project's own
// files as its source, so those used to stop every config command ("links and
// special files are not valid projection content"), and without a link they
// were taken over as AI-DLC's own files. config now leaves them where they are,
// never owns them, and never removes them. Any other link still stops config
// (t304), since a rule read through one would be left out of the plan.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hostToolPath, sha256File } from "../../core/tools/aidlc-distribution.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BUN = process.execPath;
const DIST = join(REPO_ROOT, "dist");
// Links need a privilege on Windows; there the regular-file half still runs.
const LINKS = process.platform !== "win32";

const created: string[] = [];
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

function cleanEnv(machine: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("AIDLC_") || name.startsWith("CLAUDE_") || name.startsWith("KIRO_")) delete env[name];
  }
  return { ...env, AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"), AIDLC_BIN_DIR: join(machine, "bin") };
}

// A copied opencode project with open work, after opencode has started once.
function startedOpencodeProject(): { project: string; machine: string } {
  const project = temp("aidlc-host-tool-project-");
  cpSync(join(DIST, "opencode"), project, { recursive: true });
  mkdirSync(join(project, ".git"));
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  mkdirSync(join(intents, "261004-open-work"), { recursive: true });
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{
    uuid: "deadbeef-0000-4000-8000-000000001765",
    slug: "open-work",
    dirName: "261004-open-work",
    scope: "feature",
    status: "in-flight",
  }], null, 2)}\n`);
  writeFileSync(
    join(intents, "261004-open-work", "aidlc-state.md"),
    "# AI-DLC State Tracking\n\n## Current Status\n- **Status**: Running\n",
  );
  const tool = join(project, ".opencode");
  writeFileSync(join(tool, "package.json"), `${JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.18.34" } })}\n`);
  writeFileSync(join(tool, ".gitignore"), "node_modules\npackage.json\nbun.lock\n");
  mkdirSync(join(tool, "node_modules", "msgpackr", "bin"), { recursive: true });
  mkdirSync(join(tool, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(tool, "node_modules", "msgpackr", "bin", "download.js"), "console.log('prebuilds');\n");
  if (LINKS) {
    symlinkSync("../msgpackr/bin/download.js", join(tool, "node_modules", ".bin", "download-msgpackr-prebuilds"));
  }
  return { project, machine: temp("aidlc-host-tool-machine-") };
}

function config(project: string, machine: string, args: string[]) {
  const result = spawnSync(BUN, [join(project, ".aidlc", "tools", "aidlc.ts"), "config", ...args], {
    cwd: project,
    env: cleanEnv(machine),
    encoding: "utf-8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "" };
}

function owned(project: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(project, ".aidlc", "tools", "data", "aidlc-manifest.json"), "utf-8"),
  ) as { files: Record<string, string> };
  return Object.keys(manifest.files);
}

describe("config leaves what a host tool installed for itself alone", () => {
  test("a model change in a copied opencode project opencode has started in is done", () => {
    const { project, machine } = startedOpencodeProject();
    const packageBefore = readFileSync(join(project, ".opencode", "package.json"), "utf-8");
    const result = config(project, machine, ["models", "--agent", "developer", "--effort", "high", "--project", "--yes"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("not valid projection content");
    expect(result.stdout).toContain("Recorded developer effort high in aidlc.settings.json.");
    expect(readFileSync(join(project, ".opencode", "agents", "aidlc-developer-agent.md"), "utf-8")).toContain("variant: high");
    // opencode's own files stay as they are and are not taken over.
    expect(owned(project).filter(hostToolPath)).toEqual([]);
    expect(readFileSync(join(project, ".opencode", "package.json"), "utf-8")).toBe(packageBefore);
    if (LINKS) {
      expect(lstatSync(join(project, ".opencode", "node_modules", ".bin", "download-msgpackr-prebuilds")).isSymbolicLink()).toBe(true);
    }
  });

  test("files an earlier config took over from opencode are never removed or reported as changed", () => {
    const { project, machine } = startedOpencodeProject();
    expect(config(project, machine, ["models", "--agent", "developer", "--effort", "high", "--project", "--yes"]).status).toBe(0);
    // As an earlier release wrote it: opencode's files recorded as owned.
    const manifestPath = join(project, ".aidlc", "tools", "data", "aidlc-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { files: Record<string, string> };
    for (const rel of [".opencode/package.json", ".opencode/.gitignore", ".opencode/node_modules/msgpackr/bin/download.js"]) {
      manifest.files[rel] = sha256File(join(project, rel));
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // opencode then updates its own dependency list.
    writeFileSync(join(project, ".opencode", "package.json"), `${JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.18.40" } })}\n`);
    const result = config(project, machine, ["models", "--agent", "developer", "--effort", "max", "--project", "--yes"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("conflict");
    expect(readFileSync(join(project, ".opencode", "package.json"), "utf-8")).toContain("1.18.40");
    expect(readFileSync(join(project, ".opencode", ".gitignore"), "utf-8")).toContain("node_modules");
    expect(owned(project).filter(hostToolPath)).toEqual([]);
  });

  test.skipIf(!LINKS)("a linked rule file still stops config rather than leaving the rule out of the plan", () => {
    const { project, machine } = startedOpencodeProject();
    const team = join(project, "aidlc", "spaces", "default", "memory", "team.md");
    const shared = join(temp("aidlc-host-tool-shared-"), "team.md");
    writeFileSync(shared, readFileSync(team, "utf-8"));
    rmSync(team);
    symlinkSync(shared, team);
    const result = config(project, machine, ["models", "--agent", "developer", "--effort", "high", "--project", "--yes"]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("memory/team.md: links and special files are not valid projection content");
  });

  test("no release ships a file the host-tool rule leaves out", () => {
    // The rule must never hide AI-DLC's own files: every shipped file in every
    // harness tree's managed directories is outside it.
    const harnesses = readdirSync(DIST).filter((name) => lstatSync(join(DIST, name)).isDirectory()).sort();
    expect(harnesses).toContain("opencode");
    for (const harness of harnesses) {
      const root = join(DIST, harness);
      const files: string[] = [];
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (lstatSync(path).isDirectory()) visit(path);
          else files.push(relative(root, path).replaceAll("\\", "/"));
        }
      };
      visit(root);
      expect(files.length).toBeGreaterThan(0);
      expect(files.filter(hostToolPath), harness).toEqual([]);
    }
    expect(hostToolPath(".gitignore")).toBe(false);
    expect(hostToolPath(".opencode/.gitignore")).toBe(true);
    expect(hostToolPath(".opencode/node_modules/.bin/x")).toBe(true);
    expect(hostToolPath(".opencode/agents/aidlc-developer-agent.md")).toBe(false);
  });
});
