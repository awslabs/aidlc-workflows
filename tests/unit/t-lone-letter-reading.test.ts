// covers: file:aidlc-common/protocols/stage-protocol.md, file:skills/aidlc/SKILL.md, function:planOfferQuestionNote
//
// t-lone-letter-reading: at a question shown with numbers or in a box, a lone
// letter ("a", "b") or "..." is no pick; the agent asks once which they meant.
// A letter names a choice only where the question showed letters (a questions
// file's lettered options). The agent reads the reply and no tool does, so the
// subject is the sentence every harness's agent reads, and the answers corpus
// that measures the reading must say the same. The sentence lives in the
// protocol alone, so the skill's gate step and the plan offer, where a reply is
// read with no stage step in front of the agent (a gate shown again on resume,
// the plan offer before any stage), name its section by heading and path.
//
// Read from the generated dist/ trees: the protocol is a projection, so the
// bytes that ship are the subject.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import { ANSWERS } from "../harness/aidlc-answers-corpus.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const HARNESS_NAMES = readdirSync(join(REPO_ROOT, "harness"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, "harness", entry.name, "manifest.ts")))
  .map((entry) => entry.name)
  .sort();

async function manifestOf(name: string): Promise<HarnessManifest> {
  return (await import(join(REPO_ROOT, "harness", name, "manifest.ts"))).default as HarnessManifest;
}

async function protocolOf(name: string): Promise<string> {
  const manifest = await manifestOf(name);
  return readFileSync(join(REPO_ROOT, "dist", name, manifest.harnessDir, "aidlc-common", "protocols", "stage-protocol.md"), "utf-8");
}

const SECTION = "Reading the person's reply at a checkpoint";
const asTheSection = (harnessDir: string): string =>
  `their reply as \`${harnessDir}/aidlc-common/protocols/stage-protocol.md\` section "${SECTION}" says`;

// The "They chose" bullet of "Reading the person's reply at a checkpoint", as one line.
function theyChose(protocol: string): string {
  const at = protocol.indexOf("- **They chose:**");
  expect(at, "the They chose bullet").toBeGreaterThanOrEqual(0);
  const end = protocol.indexOf("\n- **", at + 1);
  return protocol.slice(at, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

describe("a lone letter is a pick only where the question showed letters", () => {
  for (const name of HARNESS_NAMES) {
    test(`${name}: the shipped protocol says so`, async () => {
      const bullet = theyChose(await protocolOf(name));
      expect(bullet).not.toContain("a letter, \"approved\"");
      expect(bullet).toContain("A letter names one only where the question showed letters");
      expect(bullet).toContain("a lone letter at a question shown with numbers or in a box, or \"...\", is unclear: ask once which they meant");
    });
  }

  test("the answers corpus reads it the same way", () => {
    const lone = ANSWERS.filter((item) => /^[a-dA-D]$/.test(item.input.trim()));
    const unlettered = lone.filter((item) => item.shown !== "lettered");
    expect(unlettered.length).toBeGreaterThan(0);
    for (const item of unlettered) {
      expect({ id: item.id, ambiguous: item.ambiguous, recorded: item.expected.end.recorded, asks: item.expected.end.asks })
        .toEqual({ id: item.id, ambiguous: true, recorded: "none", asks: 1 });
    }
    const lettered = lone.filter((item) => item.shown === "lettered");
    expect(lettered.length).toBeGreaterThan(0);
    for (const item of lettered) {
      expect({ id: item.id, recorded: item.expected.end.recorded === "none", asks: item.expected.end.asks })
        .toEqual({ id: item.id, recorded: false, asks: 0 });
    }
  });
});

describe("where a reply is read outside a stage step, the protocol's section is named", () => {
  for (const name of HARNESS_NAMES) {
    test(`${name}: the skill's summary and gate steps name it, and say the rule no second way`, async () => {
      const manifest = await manifestOf(name);
      expect(manifest.orchestratorSkillPath, "the shipped skill").toBeDefined();
      const skill = readFileSync(join(REPO_ROOT, "dist", name, manifest.orchestratorSkillPath ?? ""), "utf-8");
      expect(skill.split(`Otherwise read ${asTheSection(manifest.harnessDir)}`).length - 1).toBe(2);
      expect(skill).not.toContain("ask one short question only when their intent is genuinely unclear");
      expect(await protocolOf(name)).toContain(`\n### ${SECTION}\n`);
    });

    test(`${name}: the plan offer's step names it in this install, with a plan proposed and with none`, async () => {
      const manifest = await manifestOf(name);
      const directive = await import(join(REPO_ROOT, "dist", name, manifest.harnessDir, "tools", "aidlc-directive.ts"));
      for (const ask_type of ["scope-confirm", "compose-offer"]) {
        const step = directive.withAgentNotes({ kind: "ask", ask_type, response_route: "next", question: "q" }, "bun x.ts");
        expect(String(step.question_note), ask_type).toContain(` Read ${asTheSection(manifest.harnessDir)}.`);
      }
    });
  }
});
