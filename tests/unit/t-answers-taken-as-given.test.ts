// covers: file:aidlc-common/protocols/stage-protocol.md, file:aidlc-common/protocols/stage-protocol-governance.md, file:aidlc-common/stages/inception/requirements-analysis.md, file:knowledge/aidlc-shared/ai-dlc-principles.md
//
// An answer the person gave is taken as given, and how they answer is asked
// once. The stage protocol's "The person drives" says to ask only when their
// intent is genuinely unclear and never to make them confirm what they already
// said; the engine asks how to answer once per piece of work and tells later
// stages to reuse it (answerModeNote in aidlc-directive.ts). Shipped lines that
// told the agent to follow up on "B, probably", a one-word answer or its own
// doubt, to have the person explain a pick, or to offer the answer mode again
// at a later stage pulled the other way, so the person could be asked again.
// This reads every shipped tree's own markdown, never a person's words; a
// later copy of one of those lines anywhere in a tree fails it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (/\.mdc?$/.test(entry.name)) out.push(path);
  }
  return out;
}

// Each is a follow-up the person-drives rule does not ask for.
const ASK_AGAIN: Array<[string, RegExp]> = [
  ["ask when in doubt", /When in doubt, ask/],
  ["have the person explain a pick", /explain their reasoning/],
  ["ask by default", /Default to asking, not assuming/],
  ["follow up on a one-word answer", /Single-word answers to open-ended questions/],
  ["follow up on a hedged pick", /"maybe B"/],
  ["read \"probably\" as a vague answer", /"not sure"[^\n]*"probably"/],
];

// Each offers the answer mode again at the stage.
const MODE_OFFER = [/interaction mode choice/, /choice between guided/, /Guide Me \/ Edit File \/ Chat/];

describe("t-answers-taken-as-given", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: no shipped line asks the person again about an answer they gave",
    (_name, harness) => {
      const protocol = read(join(harness.engineRoot, "aidlc-common", "protocols", "stage-protocol.md"));
      expect(protocol).toContain("Ask only when their intent is genuinely unclear");
      expect(protocol).toContain("Never make them repeat themselves");
      const found: string[] = [];
      for (const file of markdownFiles(harness.distRoot)) {
        const text = read(file);
        for (const [what, pattern] of ASK_AGAIN) {
          if (pattern.test(text)) found.push(`${relative(harness.distRoot, file)}: ${what}`);
        }
      }
      expect(found).toEqual([]);
    },
  );

  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: no stage offers the answer mode the person already chose",
    (_name, harness) => {
      const found: string[] = [];
      for (const file of markdownFiles(join(harness.engineRoot, "aidlc-common", "stages"))) {
        const text = read(file);
        for (const pattern of MODE_OFFER) {
          if (pattern.test(text)) found.push(`${relative(harness.distRoot, file)}: ${pattern.source}`);
        }
      }
      expect(found).toEqual([]);
    },
  );

  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: the phase check is not said to run from the status command",
    (_name, harness) => {
      const governance = read(join(harness.engineRoot, "aidlc-common", "protocols", "stage-protocol-governance.md"));
      expect(governance.includes("--status"), "the governance module names the status command").toBe(false);
    },
  );
});
