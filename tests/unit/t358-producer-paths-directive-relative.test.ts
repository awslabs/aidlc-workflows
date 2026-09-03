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

type AllowlistedProducer = {
  stage: string;
  artifact: string;
  line: string;
  reason: string;
};

const ALLOWLIST: AllowlistedProducer[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stageBody(source: string): string {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("stage file has no frontmatter boundary");
  return match[1];
}

describe("HTML-capable stage producers use directive-relative paths", () => {
  test("producer prose does not hard-code Markdown filenames", () => {
    const graph = JSON.parse(readFileSync(STAGE_GRAPH, "utf8")) as StageNode[];
    const usedAllowlist = new Set<AllowlistedProducer>();
    const violations: string[] = [];

    for (const stage of graph) {
      if (!stage.html_capable.length) continue;
      const source = readFileSync(
        join(ROOT, "core", "aidlc-common", "stages", stage.phase, `${stage.slug}.md`),
        "utf8",
      );
      const lines = stageBody(source).split("\n");

      for (const artifact of stage.html_capable) {
        const producer = new RegExp(
          `\\b(create|write|save|generate|produce|author|emit)\\b[^\\n]{0,120}\\b${escapeRegExp(artifact)}\\.md\\b`,
          "i",
        );
        for (const line of lines) {
          if (!producer.test(line)) continue;
          const allowed = ALLOWLIST.find(
            (entry) =>
              entry.stage === stage.slug &&
              entry.artifact === artifact &&
              entry.line === line,
          );
          if (allowed) usedAllowlist.add(allowed);
          else violations.push(`${stage.slug}:${artifact}: ${line}`);
        }
      }
    }

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
