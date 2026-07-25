// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:continue
//
// Deterministic stage-rule delivery. Rules cross the engine boundary through
// bounded load-steering directives before run-stage; optional persona/knowledge
// remains path-loaded with actionable warnings.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const MAX_DIRECTIVE_BYTES = 28 * 1024;

type RuleContent = { path: string; text: string };
type WireDirective = {
  kind: string;
  stage?: string;
  bundle?: string;
  part?: number;
  parts?: number;
  rules_content?: RuleContent[];
  continue_token?: string;
  rules_in_context?: string[];
  inline_context_paths?: string[];
  context_warnings?: string[];
  message?: string;
};

const projects: string[] = [];

function project(): string {
  const proj = setupIntegrationProject();
  projects.push(proj);
  return proj;
}

afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

function invoke(
  proj: string,
  subcommand: "next" | "continue",
  args: string[],
): { directive: WireDirective; bytes: number } {
  const res = spawnSync(
    BUN,
    [
      join(proj, ".claude", "tools", "aidlc-orchestrate.ts"),
      subcommand,
      ...args,
      "--project-dir",
      proj,
    ],
    { encoding: "utf-8", env: { ...process.env } },
  );
  expect(res.status, res.stderr).toBe(0);
  const line = (res.stdout ?? "").trim();
  return {
    directive: JSON.parse(line) as WireDirective,
    bytes: Buffer.byteLength(line, "utf-8"),
  };
}

function drive(
  proj: string,
  args = ["--scope", "mvp", "--stage", "intent-capture"],
): {
  loads: WireDirective[];
  contents: RuleContent[];
  final: WireDirective;
  sizes: number[];
} {
  const loads: WireDirective[] = [];
  const contents: RuleContent[] = [];
  const sizes: number[] = [];
  let result = invoke(proj, "next", args);
  sizes.push(result.bytes);
  while (result.directive.kind === "load-steering") {
    loads.push(result.directive);
    contents.push(...(result.directive.rules_content ?? []));
    const token = result.directive.continue_token;
    expect(token).toBeString();
    result = invoke(proj, "continue", [token ?? ""]);
    sizes.push(result.bytes);
  }
  return { loads, contents, final: result.directive, sizes };
}

function reconstructed(contents: RuleContent[], path: string): string {
  return contents
    .filter((entry) => entry.path === path)
    .map((entry) => entry.text)
    .join("");
}

describe("t248 deterministic steering delivery", () => {
  test("delivers substantive rules before run-stage and keeps knowledge path-loaded", () => {
    const proj = project();
    const result = drive(proj);

    expect(result.loads.length).toBeGreaterThan(0);
    expect(result.final.kind).toBe("run-stage");
    expect(result.final.rules_in_context).toEqual([
      "aidlc/spaces/default/memory/org.md",
      "aidlc/spaces/default/memory/phases/ideation.md",
    ]);
    expect(result.final).not.toHaveProperty("rules_content");
    expect(result.final).not.toHaveProperty("rules_content_omitted");
    expect(result.final).not.toHaveProperty("inline_context_content");
    expect(result.final).not.toHaveProperty("inline_context_omitted");
    expect(result.final.inline_context_paths?.length ?? 0).toBeGreaterThan(1);

    const memory = join(proj, "aidlc", "spaces", "default", "memory");
    for (const rel of ["org.md", "phases/ideation.md"]) {
      const path = `aidlc/spaces/default/memory/${rel}`;
      expect(reconstructed(result.contents, path)).toBe(
        readFileSync(join(memory, rel), "utf-8"),
      );
    }
    expect(result.contents.some((entry) => entry.path.endsWith("team.md"))).toBe(false);
    expect(result.contents.some((entry) => entry.path.endsWith("project.md"))).toBe(false);
  });

  test("a populated placeholder is delivered as part of the ordered bundle", () => {
    const proj = project();
    const teamPath = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "memory",
      "team.md",
    );
    appendFileSync(
      teamPath,
      "\n## Testing Posture\n\nWe use BDD. Specifications drive scenarios.\n",
      "utf-8",
    );
    const result = drive(proj);
    expect(
      reconstructed(
        result.contents,
        "aidlc/spaces/default/memory/team.md",
      ),
    ).toBe(readFileSync(teamPath, "utf-8"));
  });

  test("large rules are automatically chunked and every directive fits 28 KiB", () => {
    const proj = project();
    const orgPath = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "memory",
      "org.md",
    );
    const large = Array.from(
      { length: 240 },
      (_, i) =>
        `## Policy ${i}\n\nPolicy ${i} requires deterministic evidence ` +
        `${"x".repeat(280)}.\n\n`,
    ).join("");
    writeFileSync(orgPath, large, "utf-8");

    const result = drive(proj);
    expect(result.loads.length).toBeGreaterThan(3);
    expect(result.loads.map((load) => load.part)).toEqual(
      Array.from({ length: result.loads.length }, (_, i) => i + 1),
    );
    expect(result.loads.every((load) => load.parts === result.loads.length)).toBe(true);
    expect(result.sizes.every((bytes) => bytes <= MAX_DIRECTIVE_BYTES)).toBe(true);
    expect(
      reconstructed(
        result.contents,
        "aidlc/spaces/default/memory/org.md",
      ),
    ).toBe(large);
    expect(result.final.kind).toBe("run-stage");
  });

  test("JSON-escaped control characters are chunked by serialized size", () => {
    const proj = project();
    const orgPath = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "memory",
      "org.md",
    );
    const controls = "\u0000\u0001\u0002\t".repeat(5_000);
    const rule = `# Organization\n\n## Control Policy\n\n${controls}\n`;
    writeFileSync(orgPath, rule, "utf-8");

    const result = drive(proj);
    expect(result.loads.length).toBeGreaterThan(3);
    expect(result.sizes.every((bytes) => bytes <= MAX_DIRECTIVE_BYTES)).toBe(
      true,
    );
    expect(
      reconstructed(
        result.contents,
        "aidlc/spaces/default/memory/org.md",
      ),
    ).toBe(rule);
    expect(result.final.kind).toBe("run-stage");
  });

  test("plain next restarts at part one with a deterministic token", () => {
    const proj = project();
    const first = invoke(proj, "next", [
      "--scope",
      "mvp",
      "--stage",
      "intent-capture",
    ]).directive;
    const restarted = invoke(proj, "next", [
      "--scope",
      "mvp",
      "--stage",
      "intent-capture",
    ]).directive;
    expect(first.kind).toBe("load-steering");
    expect(restarted.part).toBe(1);
    expect(restarted.bundle).toBe(first.bundle);
    expect(restarted.continue_token).toBe(first.continue_token);
  });

  test("a changed rule invalidates an in-flight continuation", () => {
    const proj = project();
    const first = invoke(proj, "next", [
      "--scope",
      "mvp",
      "--stage",
      "intent-capture",
    ]).directive;
    appendFileSync(
      join(proj, "aidlc", "spaces", "default", "memory", "org.md"),
      "\n## New Policy\n\nChanged during delivery.\n",
      "utf-8",
    );
    const stale = invoke(proj, "continue", [first.continue_token ?? ""]).directive;
    expect(stale.kind).toBe("error");
    expect(stale.message).toContain("Run a fresh `next`");
  });

  test("a changed workflow state invalidates an in-flight continuation", () => {
    const proj = setupIntegrationProject({
      withState: "state-mid-ideation.md",
    });
    projects.push(proj);
    const first = invoke(proj, "next", []).directive;
    appendFileSync(
      seededStateFile(proj),
      "\n<!-- State changed during delivery. -->\n",
      "utf-8",
    );

    const stale = invoke(proj, "continue", [
      first.continue_token ?? "",
    ]).directive;
    expect(stale.kind).toBe("error");
    expect(stale.message).toContain("workflow state changed");
    expect(stale.message).toContain("Run a fresh `next`");
  });

  test("a changed scope route invalidates an in-flight continuation", () => {
    const proj = project();
    const first = invoke(proj, "next", [
      "--scope",
      "mvp",
      "--stage",
      "intent-capture",
    ]).directive;
    const gridPath = join(
      proj,
      ".claude",
      "tools",
      "data",
      "scope-grid.json",
    );
    const grid = JSON.parse(readFileSync(gridPath, "utf-8")) as Record<
      string,
      { stages: Record<string, "EXECUTE" | "SKIP"> }
    >;
    const changed = Object.keys(grid.mvp.stages).find(
      (slug) =>
        slug !== "intent-capture" && grid.mvp.stages[slug] === "EXECUTE",
    );
    expect(changed).toBeString();
    grid.mvp.stages[changed ?? "market-research"] = "SKIP";
    writeFileSync(gridPath, `${JSON.stringify(grid, null, 2)}\n`, "utf-8");

    const stale = invoke(proj, "continue", [
      first.continue_token ?? "",
    ]).directive;
    expect(stale.kind).toBe("error");
    expect(stale.message).toContain("stage route changed");
    expect(stale.message).toContain("Run a fresh `next`");
  });

  test("missing required rules block before stage work with repair guidance", () => {
    const proj = project();
    rmSync(join(proj, "aidlc", "spaces", "default", "memory", "org.md"));
    const result = invoke(proj, "next", [
      "--scope",
      "mvp",
      "--stage",
      "intent-capture",
    ]).directive;
    expect(result.kind).toBe("error");
    expect(result.message).toContain("Cannot load required stage rule");
    expect(result.message).toContain("The stage has not started");
    expect(result.message).toContain("run `next` again");
  });

  test("invalid UTF-8 required rules block before stage work", () => {
    const proj = project();
    writeFileSync(
      join(proj, "aidlc", "spaces", "default", "memory", "org.md"),
      Buffer.from([0xc3, 0x28]),
    );
    const result = invoke(proj, "next", [
      "--scope",
      "mvp",
      "--stage",
      "intent-capture",
    ]).directive;
    expect(result.kind).toBe("error");
    expect(result.message).toContain("Cannot load required stage rule");
    expect(result.message).toContain("UTF-8");
    expect(result.message).toContain("The stage has not started");
  });

  test("active-space paths and delivered content name the same files", () => {
    const proj = project();
    const defaultSpace = join(proj, "aidlc", "spaces", "default");
    const teamSpace = join(proj, "aidlc", "spaces", "team-a");
    mkdirSync(teamSpace, { recursive: true });
    cpSync(join(defaultSpace, "memory"), join(teamSpace, "memory"), {
      recursive: true,
    });
    writeFileSync(join(proj, "aidlc", "active-space"), "team-a\n", "utf-8");

    const result = drive(proj);
    expect(
      result.final.rules_in_context?.every((path) =>
        path.startsWith("aidlc/spaces/team-a/memory/")
      ),
    ).toBe(true);
    expect(
      result.contents.every((entry) =>
        entry.path.startsWith("aidlc/spaces/team-a/memory/")
      ),
    ).toBe(true);
  });

  test("unreadable optional knowledge warns and is omitted without blocking", () => {
    const proj = project();
    const knowledgeDir = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "knowledge",
      "aidlc-product-agent",
    );
    mkdirSync(knowledgeDir, { recursive: true });
    const broken = join(knowledgeDir, "broken.md");
    symlinkSync(join(knowledgeDir, "missing-target.md"), broken);

    const result = drive(proj);
    const rel =
      "aidlc/spaces/default/knowledge/aidlc-product-agent/broken.md";
    expect(result.final.kind).toBe("run-stage");
    expect(result.final.inline_context_paths).not.toContain(rel);
    expect(result.final.context_warnings?.join("\n")).toContain(rel);
    expect(result.final.context_warnings?.join("\n")).toContain(
      "this stage will continue",
    );
  });

  test("invalid UTF-8 optional knowledge warns and is omitted", () => {
    const proj = project();
    const knowledgeDir = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "knowledge",
      "aidlc-product-agent",
    );
    mkdirSync(knowledgeDir, { recursive: true });
    const invalid = join(knowledgeDir, "invalid.md");
    writeFileSync(invalid, Buffer.from([0xc3, 0x28]));

    const result = drive(proj);
    const rel =
      "aidlc/spaces/default/knowledge/aidlc-product-agent/invalid.md";
    expect(result.final.kind).toBe("run-stage");
    expect(result.final.inline_context_paths).not.toContain(rel);
    expect(result.final.context_warnings?.join("\n")).toContain(rel);
    expect(result.final.context_warnings?.join("\n")).toContain("invalid UTF-8");
  });

  test("many optional-context failures aggregate without overflowing run-stage", () => {
    const proj = project();
    const knowledgeDir = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "knowledge",
      "aidlc-product-agent",
    );
    mkdirSync(knowledgeDir, { recursive: true });
    for (let i = 0; i < 120; i++) {
      symlinkSync(
        join(knowledgeDir, `missing-${i}.md`),
        join(knowledgeDir, `broken-${String(i).padStart(3, "0")}.md`),
      );
    }

    const result = drive(proj);
    expect(result.final.kind).toBe("run-stage");
    expect(result.sizes.every((bytes) => bytes <= MAX_DIRECTIVE_BYTES)).toBe(
      true,
    );
    expect(result.final.context_warnings?.join("\n")).toContain(
      "additional optional persona/knowledge warning(s)",
    );
  });
});
