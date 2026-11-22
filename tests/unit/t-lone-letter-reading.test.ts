// covers: file:aidlc-common/protocols/stage-protocol.md
//
// t-lone-letter-reading: at a question shown with numbers or in a box, a lone
// letter ("a", "b") or "..." is no pick; the agent asks once which they meant.
// A letter names a choice only where the question showed letters (a questions
// file's lettered options). The agent reads the reply and no tool does, so the
// subject is the sentence every harness's agent reads, and the answers corpus
// that measures the reading must say the same.
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

async function protocolOf(name: string): Promise<string> {
  const manifest = (await import(join(REPO_ROOT, "harness", name, "manifest.ts"))).default as HarnessManifest;
  return readFileSync(join(REPO_ROOT, "dist", name, manifest.harnessDir, "aidlc-common", "protocols", "stage-protocol.md"), "utf-8");
}

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
