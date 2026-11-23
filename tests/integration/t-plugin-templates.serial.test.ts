// covers: file:core/tools/aidlc-plugin.ts, function:mergePluginRules, function:stripPluginRules, function:copyPluginRulesToSpace, function:rulesRecordGaps, subcommand:aidlc-sensor-required-sections, subcommand:aidlc-utility:select-plugins, subcommand:aidlc-utility:space-create
//
// A plugin's section policy on a real install of Claude Code, Kiro CLI and
// Codex (test-pro shipping memory/templates/test-pro-integration-test-plan.md):
// one sync lands the template in every space and says so once; the shipped
// required-sections sensor then requires the plugin's `##` headings for that
// artifact exactly as the dispatcher threads them (missing section → finding,
// present → pass, emoji-insensitive); off takes the file out and on brings it
// back byte for byte; a new space starts with it; a person's own file at the
// path is kept, said once, and survives off/on; a deleted file is the gap
// doctor's Composed plugin surface row names, and one sync puts it back; a
// copy-channel refresh never takes it (the engine ships only the templates/
// floor).

import { NATIVE_RUNTIME_CASE_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(NATIVE_RUNTIME_CASE_TIMEOUT_MS * 6);

const BUN = process.execPath;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACT = "test-pro-integration-test-plan";
const PLACED_LINE = `test-pro's templates are in each space's memory/templates: ${ARTIFACT}.md`;
const HARNESSES = [
  { name: "claude", leaf: ".claude" },
  { name: "kiro", leaf: ".kiro" },
  { name: "codex", leaf: ".codex" },
] as const;
type Harness = (typeof HARNESSES)[number];

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

type Project = { proj: string; harness: Harness; root: string; env: NodeJS.ProcessEnv };

// A copy-channel install of the harness with test-pro installed (Kiro:
// folder-dropped into the project, as its install step does).
function installed(harness: Harness): Project {
  const base = mkdtempSync(join(tmpdir(), `aidlc-templates-${harness.name}-`));
  made.push(base);
  const proj = join(base, "proj");
  cpSync(join(REPO_ROOT, "dist", harness.name), proj, { recursive: true });
  const projection = join(REPO_ROOT, "dist", "plugins", "test-pro", harness.name);
  let root = projection;
  if (harness.name === "kiro") {
    cpSync(join(projection, ".kiro"), join(proj, ".kiro"), { recursive: true });
    root = join(proj, ".kiro", "aidlc-plugins", "aidlc-test-pro");
  }
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AIDLC_PROJECT_DIR: proj,
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_HARNESS_DIR: harness.leaf,
    AIDLC_PLUGIN_ROOT: root,
    AIDLC_INSTALL_ROOT: join(base, "install-root"),
    AIDLC_UNATTENDED: "1",
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  delete env.AIDLC_RULES_DIR;
  return { proj, harness, root, env };
}

function tool(p: Project, name: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(BUN, [join(p.proj, p.harness.leaf, "tools", name), ...args], {
    cwd: p.proj,
    encoding: "utf-8",
    env: p.env,
    timeout: remainingOperationTimeoutMs(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function ok(run: { status: number; out: string }): string {
  expect(run.status, run.out).toBe(0);
  return run.out;
}

const sync = (p: Project, ...args: string[]) => ok(tool(p, "aidlc-plugin.ts", ["sync", ...args]));
const select = (p: Project, ...args: string[]) => ok(tool(p, "aidlc-utility.ts", ["select-plugins", ...args, "--project-dir", p.proj]));

function templatePath(p: Project, space = "default"): string {
  return join(p.proj, "aidlc", "spaces", space, "memory", "templates", `${ARTIFACT}.md`);
}

function doctorComposedRow(p: Project): string {
  // Doctor exits 1 on any failed row; this reads the one row the templates join.
  const out = tool(p, "aidlc-utility.ts", ["doctor", "--json", "--project-dir", p.proj]).out;
  const report = JSON.parse(out.slice(out.indexOf("{"))) as { data?: { checks?: Array<{ label: string; fix?: string }> } };
  const row = report.data?.checks?.find((check) => check.label.startsWith("Composed plugin surface"));
  return row ? `${row.label}${row.fix ? ` - ${row.fix}` : ""}` : "";
}

// The per-sensor script spawned the way the gate dispatcher does, threading
// --templates-dir (the active space's memory/templates) and --template-eligible
// (the stage's prose produces).
function runSensor(p: Project, outputPath: string): {
  pass: boolean;
  template?: string;
  template_expected?: string[];
  template_missing?: string[];
  findings_count: number;
} {
  const r = tool(p, "aidlc-sensor-required-sections.ts", [
    "--stage", "test-pro-integration",
    "--output-path", outputPath,
    "--templates-dir", join(p.proj, "aidlc", "spaces", "default", "memory", "templates"),
    "--template-eligible", `test-pro-integration-test-plan,test-pro-integration-test-results,test-pro-cross-unit-contract-matrix`,
  ]);
  expect(r.status, r.out).toBe(0);
  return JSON.parse(r.out.trim());
}

// A copy-channel refresh: the runtime copied over the project, leaving out
// what copyChannelOmits leaves out of the archive.
function copyRefresh(p: Project): void {
  const runtime = join(REPO_ROOT, "dist", p.harness.name);
  const omit = new Set(["aidlc/spaces/default/memory/team.md", "aidlc/spaces/default/memory/project.md", "aidlc/active-space"]);
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const rel = relative(runtime, path).split(sep).join("/");
      if (statSync(path).isDirectory()) visit(path);
      else if (rel.includes("/") && !omit.has(rel)) {
        mkdirSync(dirname(join(p.proj, rel)), { recursive: true });
        cpSync(path, join(p.proj, rel));
      }
    }
  };
  visit(runtime);
}

describe.each([...HARNESSES])("$name: a plugin's section policy on a real install", (harness) => {
  test("placed everywhere and enforced at the sensor; kept when the person's; off, on, a new space, doctor, a copy refresh", () => {
    const p = installed(harness);
    const pluginBytes = readFileSync(join(p.root, "memory", "templates", `${ARTIFACT}.md`), "utf-8");
    expect(pluginBytes).toContain("## Branch Coverage");

    // One sync lands the template in the default space and says so once.
    const first = sync(p);
    expect(first).toContain(PLACED_LINE);
    expect(readFileSync(templatePath(p), "utf-8")).toBe(pluginBytes);
    expect(sync(p)).not.toContain("templates are in");
    expect(readFileSync(templatePath(p), "utf-8")).toBe(pluginBytes);

    // The shipped sensor requires the plugin's `##` headings for the artifact:
    // a missing section is the precise finding; an emoji-decorated heading
    // satisfies its plain template heading.
    const outDir = join(p.proj, "out");
    mkdirSync(outDir, { recursive: true });
    const output = join(outDir, `${ARTIFACT}.md`);
    writeFileSync(output, "# Plan\n\n## Scope\nS.\n\n## Risks\nR.\n");
    const missing = runSensor(p, output);
    expect(missing.pass).toBe(false);
    expect(missing.template).toBe("applied");
    expect(missing.template_missing).toEqual(["## Branch Coverage"]);
    expect(missing.findings_count).toBe(1);
    writeFileSync(output, "# Plan\n\n## Scope\nS.\n\n## 🧪 Branch Coverage\nB.\n\n## Risks\nR.\n");
    const complete = runSensor(p, output);
    expect(complete.pass).toBe(true);
    expect(complete.template).toBe("applied");
    expect(complete.template_missing).toEqual([]);

    // Off takes the file out; on brings it back byte for byte.
    select(p, "aidlc");
    expect(existsSync(templatePath(p))).toBe(false);
    select(p, "aidlc,test-pro");
    expect(sync(p)).not.toContain("templates are in");
    expect(readFileSync(templatePath(p), "utf-8")).toBe(pluginBytes);

    // A new space starts with it, and sync finds nothing to do.
    ok(tool(p, "aidlc-utility.ts", ["space-create", "beta", "--project-dir", p.proj]));
    expect(readFileSync(templatePath(p, "beta"), "utf-8")).toBe(pluginBytes);
    expect(sync(p)).not.toContain("templates are in");

    // A hand edit makes the file the person's: kept, said once, and it
    // survives off and on; doctor calls nothing missing.
    const own = `${pluginBytes}\n## Our Own Gate\n\nWhat our team adds.\n`;
    writeFileSync(templatePath(p), own);
    const kept = sync(p);
    expect(kept).toContain(`Kept your own aidlc/spaces/default/memory/templates/${ARTIFACT}.md; test-pro's template did not replace it.`);
    expect(readFileSync(templatePath(p), "utf-8")).toBe(own);
    expect(sync(p)).not.toContain("Kept your own");
    expect(readFileSync(templatePath(p), "utf-8")).toBe(own);
    expect(doctorComposedRow(p)).toStartWith("Composed plugin surface: all enabled plugin stages");
    select(p, "aidlc");
    expect(readFileSync(templatePath(p), "utf-8")).toBe(own);
    expect(existsSync(templatePath(p, "beta"))).toBe(false);
    select(p, "aidlc,test-pro");
    sync(p);
    expect(readFileSync(templatePath(p), "utf-8")).toBe(own);
    expect(readFileSync(templatePath(p, "beta"), "utf-8")).toBe(pluginBytes);

    // Deleted (whatever took it), doctor names the gap in its one row, and one
    // sync puts the plugin's bytes back.
    rmSync(templatePath(p));
    const row = doctorComposedRow(p);
    expect(row).toContain(`test-pro: template missing from aidlc/spaces/default/memory/templates/${ARTIFACT}.md`);
    sync(p);
    expect(readFileSync(templatePath(p), "utf-8")).toBe(pluginBytes);
    expect(doctorComposedRow(p)).toStartWith("Composed plugin surface: all enabled plugin stages");

    // A copy-channel refresh ships only the templates/ floor, so the plugin's
    // file survives it and sync still finds nothing to do.
    copyRefresh(p);
    expect(readFileSync(templatePath(p), "utf-8")).toBe(pluginBytes);
    expect(sync(p)).not.toContain("templates are in");
    expect(readFileSync(templatePath(p), "utf-8")).toBe(pluginBytes);
  });
});
