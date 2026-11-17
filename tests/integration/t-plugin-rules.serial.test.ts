// covers: file:core/tools/aidlc-plugin.ts, function:mergePluginRules, function:movePluginRules, function:stripPluginRules, function:copyPluginRulesToSpace, function:rulesRecordGaps, subcommand:aidlc-utility:select-plugins, subcommand:aidlc-utility:space-create
//
// A plugin's house rules on a real install of Claude Code, Kiro CLI and Codex
// (test-pro carrying one rules file and one phase file): they land at the
// level the plugin names, or the one set at install, and reach the next stage
// brief; off takes them out of the next brief and on brings them back byte for
// byte; practices-promote and a learning never reach inside them; a new space
// has them; a copy-channel refresh drops the default space's org and phase
// files, doctor names the gap in one row, and one sync puts them back; a CRLF
// checkout keeps its line endings. AIDLC_POC_NUMBERS=<file> writes the sizes.

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
const HEADING = "## Rules from the test-pro plugin";
const KIRO_IDE_INLINE_MAX_BYTES = 64 * 1024;
const HARNESSES = [
  { name: "claude", leaf: ".claude" },
  { name: "kiro", leaf: ".kiro" },
  { name: "codex", leaf: ".codex" },
] as const;
type Harness = (typeof HARNESSES)[number];

const made: string[] = [];
const numbers: Record<string, unknown> = {};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  if (process.env.AIDLC_POC_NUMBERS) writeFileSync(process.env.AIDLC_POC_NUMBERS, `${JSON.stringify(numbers, null, 2)}\n`);
});

type Project = { proj: string; harness: Harness; root: string; env: NodeJS.ProcessEnv };

// A copy-channel install of the harness with test-pro installed: the plugin's
// projection for that host (Kiro: folder-dropped into the project, as its
// install step does), named to sync as a host hook names it.
function installed(harness: Harness): Project {
  const base = mkdtempSync(join(tmpdir(), `aidlc-rules-${harness.name}-`));
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

function tool(p: Project, name: string, args: string[], env: NodeJS.ProcessEnv = p.env): { status: number; out: string } {
  const r = spawnSync(BUN, [join(p.proj, p.harness.leaf, "tools", name), ...args], {
    cwd: p.proj,
    encoding: "utf-8",
    env,
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

function memory(p: Project, space = "default"): string {
  return join(p.proj, "aidlc", "spaces", space, "memory");
}

// Every rule file of every space, by project-relative path.
function ruleFiles(p: Project): Map<string, string> {
  const files = new Map<string, string>();
  const spaces = join(p.proj, "aidlc", "spaces");
  for (const space of readdirSync(spaces).sort()) {
    const dir = join(spaces, space, "memory");
    if (!existsSync(dir)) continue;
    for (const rel of ["org.md", "team.md", "project.md", ...readdirSync(join(dir, "phases")).map((f) => `phases/${f}`)]) {
      const path = join(dir, rel);
      if (existsSync(path)) files.set(relative(p.proj, path).split(sep).join("/"), readFileSync(path, "utf-8"));
    }
  }
  return files;
}

function holding(p: Project): string[] {
  return [...ruleFiles(p)].filter(([, text]) => text.includes(HEADING)).map(([path]) => path).sort();
}

// The rules the next brief of a stage carries, whole files by path, as the
// agent gets them: `next`, then every `continue` of the load-steering parts.
function brief(p: Project, stage = "requirements-analysis"): { files: Map<string, string>; messages: number[] } {
  const files = new Map<string, string>();
  const messages: number[] = [];
  const run = (args: string[]) => {
    const out = ok(tool(p, "aidlc-orchestrate.ts", [...args, "--project-dir", p.proj])).trim();
    messages.push(Buffer.byteLength(out));
    return JSON.parse(out) as { kind: string; receipt?: string; rules_content?: Array<{ path: string; text: string }> };
  };
  let directive = run(["next", "--scope", "mvp", "--stage", stage]);
  for (let hops = 0; ; hops++) {
    for (const item of directive.rules_content ?? []) files.set(item.path, (files.get(item.path) ?? "") + item.text);
    if (directive.kind !== "load-steering") break;
    expect(hops).toBeLessThan(50);
    directive = run(["continue", directive.receipt ?? ""]);
  }
  expect(directive.kind).toBe("run-stage");
  return { files, messages };
}

// What the next step the agent speaks from tells the person, for one chat.
function personNotices(p: Project, env: NodeJS.ProcessEnv): string[] {
  const run = (args: string[]) => JSON.parse(ok(tool(p, "aidlc-orchestrate.ts", [...args, "--project-dir", p.proj], env)).trim()) as
    { kind: string; receipt?: string; change_notices?: string[] };
  let directive = run(["next", "--scope", "mvp", "--stage", "requirements-analysis"]);
  for (let hops = 0; directive.kind === "load-steering" && hops < 50; hops++) directive = run(["continue", directive.receipt ?? ""]);
  return directive.change_notices ?? [];
}

function briefHolding(p: Project, stage?: string): string[] {
  return [...brief(p, stage).files].filter(([, text]) => text.includes(HEADING)).map(([path]) => path).sort();
}

function doctorComposedRow(p: Project): string {
  // Doctor exits 1 on any failed row; this reads the one row the rules join.
  const out = tool(p, "aidlc-utility.ts", ["doctor", "--json", "--project-dir", p.proj]).out;
  const report = JSON.parse(out.slice(out.indexOf("{"))) as { data?: { checks?: Array<{ label: string; fix?: string }> } };
  const row = report.data?.checks?.find((check) => check.label.startsWith("Composed plugin surface"));
  return row ? `${row.label}${row.fix ? ` - ${row.fix}` : ""}` : "";
}

// A copy-channel refresh: the runtime copied over the project, leaving out
// what copyChannelOmits leaves out of the archive (the default space's team.md
// and project.md, the chosen space, and the root files a team owns).
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

function auditText(p: Project): string {
  const parts: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry.endsWith(".md") && dir.split(sep).includes("audit")) parts.push(readFileSync(path, "utf-8"));
    }
  };
  visit(join(p.proj, "aidlc"));
  return parts.join("\n");
}

function snapshot(p: Project): Map<string, string> {
  return new Map(ruleFiles(p));
}

function sizes(p: Project, label: string, extra: Record<string, unknown> = {}): void {
  const delivered = brief(p);
  const rules = [...delivered.files].reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  const section = [...delivered.files].reduce((sum, [, text]) => {
    const start = text.indexOf(HEADING);
    if (start === -1) return sum;
    const close = text.indexOf("-->", text.indexOf("<!-- /plugin:test-pro:rules:", start)) + 4;
    return sum + Buffer.byteLength(text.slice(start, close));
  }, 0);
  const memoryBytes = [...ruleFiles(p)].filter(([path]) => path.startsWith("aidlc/spaces/default/"))
    .reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  numbers[`${p.harness.name}:${label}`] = {
    briefRuleBytes: rules,
    pluginSectionBytes: section,
    messages: delivered.messages.length,
    messageBytes: delivered.messages,
    defaultSpaceRuleFileBytes: memoryBytes,
    kiroIdeInlineCap: KIRO_IDE_INLINE_MAX_BYTES,
    ...extra,
  };
}

describe.each([...HARNESSES])("$name: a plugin's rules on a real install", (harness) => {
  test("default level, off and on, promote and a learning, a new space, a copy refresh", () => {
    const p = installed(harness);
    sizes(p, "before-plugin");
    const before = snapshot(p);

    // Installed at the plugin's default (team): said once, where they went,
    // and kept for the person in the chat whose session start ran the sync.
    const chat = { ...p.env, AIDLC_SESSION_OVERRIDE: "4f0c2a8e-1111-4222-8333-944455556666", AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
    const first = ok(tool(p, "aidlc-plugin.ts", ["sync"], chat));
    const placementLine = first.split("\n").find((line) => line.startsWith("test-pro's rules are in")) ?? "";
    expect(personNotices(p, chat)).toContain(placementLine);
    expect(personNotices(p, chat)).not.toContain(placementLine);
    expect(first).toContain("test-pro's rules are in team.md (and phases/inception.md), in a section of their own at the end.");
    expect(holding(p)).toEqual(["aidlc/spaces/default/memory/phases/inception.md", "aidlc/spaces/default/memory/team.md"]);
    expect(briefHolding(p)).toEqual(["aidlc/spaces/default/memory/phases/inception.md", "aidlc/spaces/default/memory/team.md"]);
    const team = readFileSync(join(memory(p), "team.md"), "utf-8");
    expect(team.startsWith(before.get("aidlc/spaces/default/memory/team.md") ?? "")).toBe(true);
    expect(team).toContain("### Test-first habits");
    expect(team.split("\n").filter((line) => line.startsWith("## ")).at(-1)).toBe(HEADING);
    // The chat's own copy of the rules follows at once.
    expect(readFileSync(join(p.proj, "aidlc", "active-memory", "team.md"), "utf-8")).toContain(HEADING);
    sizes(p, "default-level");
    const placed = snapshot(p);
    expect(sync(p)).not.toContain("rules are in");
    expect(snapshot(p)).toEqual(placed);

    // Off: out of every file and the next brief. On: back byte for byte.
    const off = select(p, "aidlc");
    expect(off).toContain("What test-pro added to other stages and agents, and its rules, is taken out");
    expect(holding(p)).toEqual([]);
    expect(briefHolding(p)).toEqual([]);
    expect(snapshot(p)).toEqual(before);
    expect(readFileSync(join(p.proj, "aidlc", "active-memory", "team.md"), "utf-8")).not.toContain(HEADING);
    select(p, "aidlc,test-pro");
    expect(sync(p)).not.toContain("rules are in");
    expect(snapshot(p)).toEqual(placed);

    // practices-promote rewrites team.md's five sections and adds project
    // rules; a learning lands under Corrections, the section right above.
    const drafts = join(p.proj, "drafts");
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, "team-practices.md"), [
      "# Team practices", "", "## Way of Working", "", "Trunk-based.", "", "## Walking Skeleton", "", "Yes.", "",
      "## Testing Posture", "", "We test first.", "", "## Deployment", "", "Weekly.", "", "## Code Style", "", "Biome.", "",
    ].join("\n"));
    writeFileSync(join(drafts, "discovered-rules.md"), "## Mandated\n\n- ALWAYS review\n\n## Forbidden\n\n- NEVER force-push main\n");
    mkdirSync(join(drafts, "contributions"), { recursive: true });
    for (const agent of ["aidlc-quality-agent", "aidlc-developer-agent", "aidlc-devsecops-agent"]) {
      writeFileSync(join(drafts, "contributions", `${agent}.md`), `**Collaborator:** ${agent}\n\nAgreed.\n`);
    }
    const intents = join(p.proj, "aidlc", "spaces", "default", "intents");
    mkdirSync(join(intents, ".aidlc-engine", "learnings"), { recursive: true });
    if (!existsSync(join(intents, "aidlc-state.md"))) {
      writeFileSync(join(intents, "aidlc-state.md"), [
        "# AI-DLC State Tracking", "", "## Project Information", "- **Project**: rules", "- **Scope**: feature",
        "- **Practices Affirmed Timestamp**:", "", "## Current Status", "- **Current Stage**: practices-discovery",
        "- **Status**: In Progress", "",
      ].join("\n"));
    }
    ok(tool(p, "aidlc-state.ts", [
      "practices-promote", "--team-practices", join(drafts, "team-practices.md"),
      "--discovered-rules", join(drafts, "discovered-rules.md"), "--project-dir", p.proj,
    ]));
    const selections = join(intents, ".aidlc-engine", "learnings", "user-stories-selections.json");
    writeFileSync(selections, JSON.stringify({
      space: "default", intent: null, stage_slug: "user-stories",
      selections: [{ candidate_id: "c1", type: "learning", scope: "team", heading: "Corrections", text: "Name the fixture after the case", source: "orchestrator" }],
    }));
    const persisted = tool(p, "aidlc-learnings.ts", ["persist", "--slug", "user-stories", "--selections-json", selections, "--project-dir", p.proj]);
    const promoted = readFileSync(join(memory(p), "team.md"), "utf-8");
    const block = (text: string) => text.slice(text.indexOf(HEADING));
    expect(block(promoted)).toBe(block(placed.get("aidlc/spaces/default/memory/team.md") ?? ""));
    expect(promoted).toContain("We test first.");
    if (persisted.status === 0) {
      expect(promoted.indexOf("Name the fixture after the case")).toBeGreaterThan(-1);
      expect(promoted.indexOf("Name the fixture after the case")).toBeLessThan(promoted.indexOf(HEADING));
    }
    numbers[`${harness.name}:learning-persist`] = { status: persisted.status, out: persisted.out.trim().slice(0, 300) };
    expect(sync(p)).not.toContain("rules are in");
    expect(block(readFileSync(join(memory(p), "team.md"), "utf-8"))).toBe(block(promoted));

    // A new space has the sections from the start, and sync finds nothing to do.
    ok(tool(p, "aidlc-utility.ts", ["space-create", "beta", "--project-dir", p.proj]));
    expect(holding(p)).toEqual([
      "aidlc/spaces/beta/memory/phases/inception.md", "aidlc/spaces/beta/memory/team.md",
      "aidlc/spaces/default/memory/phases/inception.md", "aidlc/spaces/default/memory/team.md",
    ]);
    const withSpace = snapshot(p);
    expect(sync(p)).not.toContain("rules are in");
    expect(snapshot(p)).toEqual(withSpace);

    // A copy-channel refresh drops the default space's phase section; doctor
    // names it in its one row, and one sync puts it back.
    copyRefresh(p);
    expect(holding(p)).not.toContain("aidlc/spaces/default/memory/phases/inception.md");
    const row = doctorComposedRow(p);
    expect(row).toContain("test-pro: rules missing from aidlc/spaces/default/memory/phases/inception.md");
    numbers[`${harness.name}:copy-refresh-doctor`] = row;
    expect(sync(p)).not.toContain("rules are in");
    expect(snapshot(p)).toEqual(withSpace);
    expect(doctorComposedRow(p)).toStartWith("Composed plugin surface: all enabled plugin stages");
  });

  test("a level set at install, moved by select, and a CRLF checkout", () => {
    const p = installed(harness);
    for (const [path, text] of ruleFiles(p)) writeFileSync(join(p.proj, path), text.replace(/\r?\n/g, "\r\n"));
    const crlf = snapshot(p);

    // Kiro CLI's install step, the same sync on every host: org, not team.
    expect(sync(p, "--rules-level", "test-pro=org")).toContain("test-pro's rules are in org.md (and phases/inception.md)");
    expect(holding(p)).toEqual(["aidlc/spaces/default/memory/org.md", "aidlc/spaces/default/memory/phases/inception.md"]);
    expect(briefHolding(p)).toEqual(["aidlc/spaces/default/memory/org.md", "aidlc/spaces/default/memory/phases/inception.md"]);
    for (const [path, text] of ruleFiles(p)) expect(/(^|[^\r])\n/.test(text), path).toBe(false);
    sizes(p, "org-level");

    // The person moves them with select, no names: the selection stays as it is.
    const harnessJson = readFileSync(join(p.proj, harness.leaf, "tools", "data", "harness.json"), "utf-8");
    expect(select(p, "--rules-level", "test-pro=project")).toContain("test-pro's rules are in project.md (and phases/inception.md)");
    expect(readFileSync(join(p.proj, harness.leaf, "tools", "data", "harness.json"), "utf-8")).toBe(harnessJson);
    // The record says the level moved and the selection did not.
    const audit = auditText(p);
    const last = audit.slice(audit.lastIndexOf("**Event**: PLUGIN_SELECTION_CHANGED"));
    expect(last).toContain("**Previous Selection**: all enabled (no selection)");
    expect(last).toContain("**New Selection**: all enabled (no selection)");
    expect(last).toContain("**Rules Level**: test-pro=project");
    expect(holding(p)).toEqual(["aidlc/spaces/default/memory/phases/inception.md", "aidlc/spaces/default/memory/project.md"]);
    expect(briefHolding(p)).toEqual(["aidlc/spaces/default/memory/phases/inception.md", "aidlc/spaces/default/memory/project.md"]);
    expect(sync(p)).not.toContain("rules are in");
    const moved = snapshot(p);
    for (const [path, text] of moved) expect(/(^|[^\r])\n/.test(text), path).toBe(false);

    // Off keeps the level and the CRLF bytes; on comes back to project.md.
    select(p, "aidlc");
    expect(snapshot(p)).toEqual(crlf);
    select(p, "aidlc,test-pro");
    sync(p);
    expect(snapshot(p)).toEqual(moved);
  });
});

describe("two harnesses in one project", () => {
  test("the level the person chose holds on both; the rule files are the project's, not one harness's", () => {
    const claude = installed(HARNESSES[0]);
    cpSync(join(REPO_ROOT, "dist", "codex"), claude.proj, { recursive: true });
    const codexRoot = join(REPO_ROOT, "dist", "plugins", "test-pro", "codex");
    const codex: Project = {
      proj: claude.proj,
      harness: HARNESSES[2],
      root: codexRoot,
      env: { ...claude.env, AIDLC_HARNESS_DIR: ".codex", AIDLC_PLUGIN_ROOT: codexRoot },
    };
    sync(claude);
    sync(codex);
    expect(holding(claude)).toEqual(["aidlc/spaces/default/memory/phases/inception.md", "aidlc/spaces/default/memory/team.md"]);

    // Moved from one harness, kept by the other's next compose.
    expect(select(claude, "--rules-level", "test-pro=org")).toContain("test-pro's rules are in org.md");
    const moved = snapshot(claude);
    expect(sync(codex)).not.toContain("rules are in");
    expect(snapshot(claude)).toEqual(moved);
    expect(sync(claude)).not.toContain("rules are in");
    expect(snapshot(claude)).toEqual(moved);
    expect(holding(claude)).toEqual(["aidlc/spaces/default/memory/org.md", "aidlc/spaces/default/memory/phases/inception.md"]);
  });

  test("turned off and moved in one select, the line says where the rules will be, not where they are", () => {
    const p = installed(HARNESSES[0]);
    sync(p);
    const out = select(p, "aidlc", "--rules-level", "test-pro=org");
    expect(out).toContain("and its rules, is taken out");
    expect(out).not.toContain("test-pro's rules are in");
    expect(out).toContain("test-pro's rules will be in org.md");
    expect(holding(p)).toEqual([]);
    select(p, "aidlc,test-pro");
    sync(p);
    expect(holding(p)).toEqual(["aidlc/spaces/default/memory/org.md", "aidlc/spaces/default/memory/phases/inception.md"]);
  });
});

describe("a rules-level request is never dropped", () => {
  test("asked for a plugin that is off, sync keeps it for when it is on; a bare or unknown request says what it takes", () => {
    const p = installed(HARNESSES[0]);
    sync(p);
    select(p, "aidlc");
    expect(sync(p, "--rules-level", "test-pro=org")).toContain("test-pro's rules will be in org.md");
    expect(holding(p)).toEqual([]);
    select(p, "aidlc,test-pro");
    sync(p);
    expect(holding(p)).toEqual(["aidlc/spaces/default/memory/org.md", "aidlc/spaces/default/memory/phases/inception.md"]);

    const bare = tool(p, "aidlc-plugin.ts", ["sync", "--rules-level"]);
    expect(bare.status, bare.out).toBe(2);
    expect(bare.out).toContain("--rules-level takes <plugin>=<org|team|project>");
    const unknown = tool(p, "aidlc-plugin.ts", ["sync", "--rules-level", "nope=org"]);
    expect(unknown.status, unknown.out).toBe(2);
    expect(unknown.out).toContain("--rules-level names nope, which is not installed in this project");
  });
});
