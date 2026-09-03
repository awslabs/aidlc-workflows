import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const STAGE_GRAPH = join(
  ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "data",
  "stage-graph.json",
);

type StageNode = {
  slug: string;
  phase: string;
  html_capable: string[];
};

type AllowlistedMention = {
  file: string;
  text: string;
  reason: string;
};

const ALLOWLIST: AllowlistedMention[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stageBody(source: string): string {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("stage file has no frontmatter boundary");
  return match[1];
}

describe("HTML-capable stage prose uses directive-relative paths", () => {
  test("stage bodies do not hard-code capable Markdown filenames", () => {
    const graph = JSON.parse(readFileSync(STAGE_GRAPH, "utf8")) as StageNode[];
    const htmlCapable = [...new Set(graph.flatMap((stage) => stage.html_capable))];
    const usedAllowlist = new Set<AllowlistedMention>();
    const violations: string[] = [];

    for (const stage of graph) {
      if (!(["ideation", "inception"].includes(stage.phase))) continue;
      if (stage.slug === "reverse-engineering") continue;
      const file = `${stage.phase}/${stage.slug}.md`;
      const source = readFileSync(
        join(ROOT, "core", "aidlc-common", "stages", file),
        "utf8",
      );

      for (const line of stageBody(source).split("\n")) {
        for (const artifact of htmlCapable) {
          const markdownName = new RegExp(`\\b${escapeRegExp(artifact)}\\.md\\b`, "i");
          if (!markdownName.test(line)) continue;
          const allowed = ALLOWLIST.find(
            (entry) => entry.file === file && entry.text === line,
          );
          if (allowed) usedAllowlist.add(allowed);
          else violations.push(`${file}:${artifact}: ${line}`);
        }
      }
    }

    expect(ALLOWLIST.every((entry) => entry.reason.trim().length > 0)).toBe(true);
    expect(violations).toEqual([]);
    expect([...usedAllowlist]).toEqual(ALLOWLIST);
  });

  test("the shared protocol declares directive paths authoritative", () => {
    const protocol = readFileSync(
      join(ROOT, "core", "aidlc-common", "protocols", "stage-protocol.md"),
      "utf8",
    );
    expect(protocol).toContain("### Directive paths are authoritative");
  });
});
