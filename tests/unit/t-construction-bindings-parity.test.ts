// covers: file:aidlc-common/protocols/stage-protocol-construction.md
//
// The Construction module carries one "Harness construction bindings"
// subsection per tool. They tell the agent the same two things on every tool:
// how to settle `gate: "unresolved"` (the walking-skeleton stance) and how to
// run one per-unit iteration. The copies were written per tool and drifted: a
// later fix reached some copies and not others, so the agent on one tool was
// told to follow a skeleton-first Unit route and not to present a gate on a
// per-unit `gate: false`, while the agent on another tool was not. This pin
// holds every copy to one text, in the authored module and in every shipped
// tree (a tree may carry all seven subsections or only its own).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const MODULE = "aidlc-common/protocols/stage-protocol-construction.md";
const BLOCK_HEADING = "## Harness construction bindings";

// The subsection heading each shipped tree names its own tool by.
const TOOL_HEADING: Record<string, string> = {
  claude: "Claude Code",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
  codex: "Codex CLI",
  cursor: "Cursor",
  opencode: "opencode",
  copilot: "GitHub Copilot",
};
const TOOL_HEADINGS = new Set(Object.values(TOOL_HEADING));

// Every tool subsection under the bindings block, keyed by its heading. A
// subsection ends at the next heading; the `---` rule between subsections is
// layout, not text.
function bindingSubsections(text: string): Map<string, string> {
  const lines = text.split("\n");
  const start = lines.indexOf(BLOCK_HEADING);
  expect(start, "bindings block heading").toBeGreaterThan(-1);
  const sections = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  const close = () => {
    if (current !== null) {
      sections.set(current, body.filter((line) => line.trim() !== "---").join("\n").trim());
    }
  };
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (heading) {
      close();
      if (heading[1] === "###" && TOOL_HEADINGS.has(heading[2])) {
        current = heading[2];
        body = [];
        continue;
      }
      return sections;
    }
    if (current !== null) body.push(line);
  }
  close();
  return sections;
}

describe("Construction bindings say the same thing on every tool", () => {
  const core = bindingSubsections(
    readFileSync(join(REPO_ROOT, "core", MODULE), "utf-8"),
  );

  test("the authored module has one subsection per tool, all with the same text", () => {
    expect([...core.keys()].sort()).toEqual([...TOOL_HEADINGS].sort());
    const reference = core.get("Claude Code") ?? "";
    for (const [tool, body] of core) {
      expect(body, `${tool} subsection`).toBe(reference);
    }
  });

  test("the text carries each fix every tool needs", () => {
    const body = core.get("Claude Code") ?? "";
    for (const sentence of [
      "Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted.",
      "(do NOT report-approve, do NOT present a gate)",
      "(the engine then uses the active scope file's `skeleton:` field)",
      "emit the override row first",
      "See the conductor persona for the full classification rules.",
      "names a LATER Construction stage (including code-generation, which the unit-major walk covers)",
    ]) {
      expect(body).toContain(sentence);
    }
    expect(body).not.toContain("non-autonomous code-generation");
    expect(body).not.toContain("names a LATER design stage");
  });

  for (const harness of HARNESS_MATRIX) {
    test(`${harness.name}: the shipped copy carries its own subsection with the same text`, () => {
      const shipped = bindingSubsections(
        readFileSync(join(harness.engineRoot, MODULE), "utf-8"),
      );
      expect(shipped.has(TOOL_HEADING[harness.name]), "own subsection").toBe(true);
      for (const [tool, body] of shipped) {
        expect(body, `${harness.name} ${tool} subsection`).toBe(core.get("Claude Code") ?? "");
      }
    });
  }
});
