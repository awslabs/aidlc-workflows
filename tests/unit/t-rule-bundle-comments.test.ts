// covers: function:readRuleBundle, function:isSubstantiveRuleText, function:withoutCommentBlocks, hook:aidlc-deliver-stage-rules
//
// The rules a stage hands the agent, and a helper it dispatches, are the rule
// files' text without their HTML comment blocks: the notes the shipped
// templates leave for the person who edits them (#3542). Every line the team
// wrote reaches the agent byte for byte, a comment-looking line in their own
// code included; the files on disk are never written.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSubstantiveRuleText, readRuleBundle } from "../../core/tools/aidlc-steering.ts";
import { augmentDispatchRules } from "../../dist/claude/.claude/hooks/aidlc-deliver-stage-rules.ts";
import { cleanupTestProject, REPO_ROOT, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TEMPLATES = join(REPO_ROOT, "core", "memory");
const made: string[] = [];
const projects: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  for (const proj of projects) cleanupTestProject(proj);
});

function template(name: string): string {
  return readFileSync(join(TEMPLATES, name), "utf-8");
}

// What the stage hands the agent for each file, by name; a name missing from
// the result was left out as holding no rule.
function deliver(files: Record<string, string>): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-rule-comments-"));
  made.push(dir);
  const entries = Object.entries(files).map(([name, text]) => {
    writeFileSync(join(dir, name), text, "utf-8");
    return { rel: name, abs: join(dir, name) };
  });
  const bundle = readRuleBundle(entries);
  expect(bundle.error).toBeNull();
  for (const [name, text] of Object.entries(files)) expect(readFileSync(join(dir, name), "utf-8")).toBe(text);
  return new Map(bundle.content.map((entry) => [entry.path, entry.text]));
}

// The shipped templates write each note as its own top-level comment block:
// the lines from one starting `<!--` through the line holding its `-->`.
function templateCommentLines(text: string): Set<number> {
  const lines = text.split(/\r?\n/);
  const inside = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("<!--")) continue;
    let j = i;
    while (!lines[j].includes("-->")) j++;
    for (let k = i; k <= j; k++) inside.add(k);
    i = j;
  }
  return inside;
}

// The delivered text is the file without its comment blocks: the same
// non-blank lines outside them, in order and byte for byte (line endings
// included), no comment left, and no run of blank lines where one stood.
function expectWithoutTemplateComments(delivered: string | undefined, file: string): void {
  expect(delivered).toBeDefined();
  const text = delivered ?? "";
  const comments = templateCommentLines(file);
  const kept = file.split(/(?<=\n)/).filter((line, i) => !comments.has(i) && line.trim() !== "");
  expect(text.split(/(?<=\n)/).filter((line) => line.trim() !== "")).toEqual(kept);
  expect(text).not.toContain("<!--");
  expect(text).not.toMatch(/\n\r?\n\r?\n/);
}

const TEAM_LINES: Record<string, string> = {
  "## Way of Working": "We use trunk-based development; branches live one day at most.",
  "## Walking Skeleton": "We skip the walking skeleton; our pipeline is mature.",
  "## Testing Posture": "Every change ships with a unit test that fails first.",
  "## Guard Policy": "Mode: strict",
  "## Deployment": "We deploy on merge to staging.",
  "## Code Style": "- Prefer named exports over default exports",
  "## Forbidden": "- NEVER commit secrets or .env files (affirmed 2026-11-05)",
  "## Mandated": "- ALWAYS run the linter before a commit (affirmed 2026-11-05)",
  "## Corrections": "- Name each test after the behaviour it checks (learned 2026-11-05)",
};

// The team's lines, each right under its heading, as the gate writes them.
function withTeamLines(text: string, lines: Record<string, string> = TEAM_LINES): string {
  let out = text;
  for (const [heading, line] of Object.entries(lines)) {
    const at = out.indexOf(`${heading}\n`);
    expect(at, heading).toBeGreaterThanOrEqual(0);
    const after = at + heading.length + 1;
    out = `${out.slice(0, after)}\n${line}\n${out.slice(after)}`;
  }
  return out;
}

describe("the rules a stage delivers leave out the templates' comments", () => {
  test("a stock team.md and project.md deliver nothing", () => {
    const delivered = deliver({ "team.md": template("team.md"), "project.md": template("project.md") });
    expect([...delivered.keys()]).toEqual([]);
  });

  test("a team.md with the team's lines delivers every one and no template comment text", () => {
    const team = withTeamLines(template("team.md"));
    const delivered = deliver({ "team.md": team }).get("team.md");
    expectWithoutTemplateComments(delivered, team);
    for (const line of Object.values(TEAM_LINES)) expect(delivered).toContain(`\n${line}\n`);
    expect(delivered).toContain("> This team's affirmed practices and corrections.");
    expect(delivered).not.toContain("Affirmed during practices-discovery");
    expect(delivered?.endsWith(`## Corrections\n\n${TEAM_LINES["## Corrections"]}\n`)).toBe(true);
  });

  test("project.md and org.md are delivered without their notes", () => {
    const project = withTeamLines(template("project.md"), { "## Tech Stack": "TypeScript on Bun; PostgreSQL 16." });
    const org = template("org.md");
    const delivered = deliver({ "org.md": org, "project.md": project });
    expectWithoutTemplateComments(delivered.get("org.md"), org);
    expectWithoutTemplateComments(delivered.get("project.md"), project);
    expect(delivered.get("org.md")).toContain("## Guard Policy\n\n## Deployment\n");
    expect(delivered.get("org.md")?.endsWith("## Corrections\n")).toBe(true);
  });

  test("a rule inside a comment-looking block the team wrote stays", () => {
    const team = [
      "# Team-Level Rules",
      "",
      "## Code Style",
      "",
      "<!-- Team-specific conventions beyond the linter. -->",
      "",
      "```html",
      "<!-- Every page starts with this licence header -->",
      "```",
      "",
      "    <!-- an indented example, kept as code -->",
      "",
      "<!-- note --> NEVER inline styles",
      "- Prefer named exports (learned 2026-11-01) <!-- cid:intent:code-generation:abc -->",
      "",
      "> <!-- quoted note -->",
      "> ALWAYS keep the changelog current",
      "",
      "<!-- a note",
      "over three",
      "lines -->",
      "",
      "## Corrections",
      "",
    ].join("\n");
    expect(deliver({ "team.md": team }).get("team.md")).toBe([
      "# Team-Level Rules",
      "",
      "## Code Style",
      "",
      "```html",
      "<!-- Every page starts with this licence header -->",
      "```",
      "",
      "    <!-- an indented example, kept as code -->",
      "",
      "<!-- note --> NEVER inline styles",
      "- Prefer named exports (learned 2026-11-01) <!-- cid:intent:code-generation:abc -->",
      "",
      "> ALWAYS keep the changelog current",
      "",
      "## Corrections",
      "",
    ].join("\n"));
  });

  test("a comment left open keeps every line after it, and a note between two lines leaves both", () => {
    const open = "## Forbidden\n\n<!-- a note never closed\n- NEVER force-push main\n";
    expect(deliver({ "team.md": open }).get("team.md")).toBe(open);
    const between = "## Mandated\n\n- ALWAYS tag releases\n<!-- Format: - ALWAYS [behavior] -->\n- ALWAYS sign commits\n";
    expect(deliver({ "team.md": between }).get("team.md")).toBe("## Mandated\n\n- ALWAYS tag releases\n- ALWAYS sign commits\n");
  });

  test("a CRLF team.md keeps CRLF on every line it delivers, with or without a BOM", () => {
    const lf = withTeamLines(template("team.md"));
    const crlf = lf.replaceAll("\n", "\r\n");
    const delivered = deliver({ "team.md": crlf }).get("team.md") ?? "";
    expectWithoutTemplateComments(delivered, crlf);
    expect(delivered.replaceAll("\r\n", "")).not.toContain("\n");
    const plain = deliver({ "team.md": lf }).get("team.md") ?? "";
    expect(delivered).toBe(plain.replaceAll("\n", "\r\n"));
    // The file is read as UTF-8, which takes a byte order mark off, as it always has.
    expect(deliver({ "team.md": `\uFEFF${lf}` }).get("team.md")).toBe(plain);
  });

  test("a team.md holding only comments, its own included, delivers nothing", () => {
    const team = `${template("team.md")}\n<!-- NEVER deploy on a Friday -->\n`;
    expect([...deliver({ "team.md": team }).keys()]).toEqual([]);
    expect(isSubstantiveRuleText(team)).toBe(false);
  });

  test("what holds a rule is read by structure", () => {
    expect(isSubstantiveRuleText("## Code Style\n\n    <!-- indented code -->\n")).toBe(true);
    expect(isSubstantiveRuleText("## Code Style\n\n- <!-- an empty item's note -->\n")).toBe(false);
    expect(isSubstantiveRuleText("## Code Style\n\n```\n<!-- a fenced sample -->\n```\n")).toBe(true);
  });
});

describe("the stage brief and a dispatched helper get the same rules", () => {
  test("next and the dispatch hook carry team.md without its template notes", () => {
    const proj = setupIntegrationProject();
    projects.push(proj);
    const teamPath = join(proj, "aidlc", "spaces", "default", "memory", "team.md");
    const onDisk = withTeamLines(readFileSync(teamPath, "utf-8"));
    writeFileSync(teamPath, onDisk, "utf-8");

    const contents: Array<{ path: string; text: string }> = [];
    const step = (args: string[]) => {
      const res = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), ...args, "--project-dir", proj], {
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(res.status, res.stderr).toBe(0);
      return JSON.parse(res.stdout.trim()) as { kind: string; receipt?: string; rules_content?: typeof contents };
    };
    let directive = step(["next", "--scope", "mvp", "--stage", "requirements-analysis"]);
    for (let hops = 0; ; hops++) {
      contents.push(...(directive.rules_content ?? []));
      if (directive.kind !== "load-steering") break;
      expect(hops).toBeLessThan(20);
      directive = step(["continue", directive.receipt ?? ""]);
    }
    expect(directive.kind).toBe("run-stage");
    const team = contents.filter((c) => c.path === "aidlc/spaces/default/memory/team.md").map((c) => c.text).join("");
    expectWithoutTemplateComments(team, onDisk);
    expect(contents.some((c) => c.text.includes("<!--"))).toBe(false);
    expect(readFileSync(teamPath, "utf-8")).toBe(onDisk);

    const dispatched = augmentDispatchRules(
      "task",
      { subagent_type: "aidlc-product-agent", prompt: "Run .claude/aidlc-common/stages/inception/requirements-analysis.md." },
      proj,
    );
    expect(dispatched.error ?? null).toBeNull();
    const prompt = String(dispatched.updatedInput?.prompt ?? "");
    expect(prompt).toContain(team);
    expect(prompt).not.toContain("Affirmed during practices-discovery");
  });
});
