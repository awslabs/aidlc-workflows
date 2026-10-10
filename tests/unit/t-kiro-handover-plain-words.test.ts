// What the Kiro adapters and agent prompts hand the agent carries no label for
// it to read back to the person. On Kiro CLI the agent said "Per the
// deterministic forwarding instruction, my first tool call must be exactly the
// engine call" in 36 of 73 live turns, quoting the "SYSTEM (deterministic ...)"
// label the adapter put in front of the command, and "The engine binary
// aidlc-orchestrate.ts is the ONLY authority" from the agent prompt's block that
// repeated the skill's forwarding rules. The command and the rules stay; the
// label and the repeat go.
//
// covers: file:harness/kiro/hooks/aidlc-kiro-adapter.ts
// covers: file:harness/kiro-ide/hooks/aidlc-kiro-adapter.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SHIPPED = [
  { tree: "kiro", adapter: "dist/kiro/.kiro/hooks/aidlc-kiro-adapter.ts", prompt: "dist/kiro/.kiro/agents/aidlc.json" },
  { tree: "kiro-ide", adapter: "dist/kiro-ide/.kiro/hooks/aidlc-kiro-adapter.ts", prompt: "dist/kiro-ide/.kiro/agents/aidlc.md" },
];
// Words the agent read back to the person from the hand-over text.
const LABEL_WORDS = ["SYSTEM (", "deterministic", "by the harness", "terminal utility"];
// Words the agent read back from the agent prompt's repeat of the skill's rules.
const PROMPT_WORDS = ["CRITICAL forwarding rules", "aidlc-orchestrate.ts", "ONLY authority", "directive", "forwarding loop", "engine"];

// Every string literal in the adapter source, so a comment that names the old
// mechanism does not count and a shipped literal does.
function stringLiterals(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}

describe("the Kiro hand-over carries no label for the agent to repeat", () => {
  for (const { tree, adapter, prompt } of SHIPPED) {
    test(`${tree}: the adapter's text to the agent names no label`, () => {
      const literals = stringLiterals(readFileSync(join(REPO, adapter), "utf-8"));
      for (const word of LABEL_WORDS) {
        const hits = literals.filter((s) => s.includes(word));
        expect(hits, `${adapter} hands the agent ${JSON.stringify(word)} in ${JSON.stringify(hits.slice(0, 2))}`).toEqual([]);
      }
    });
    test(`${tree}: the agent prompt does not repeat the skill's forwarding rules`, () => {
      const text = readFileSync(join(REPO, prompt), "utf-8");
      const body = prompt.endsWith(".json") ? String((JSON.parse(text) as { prompt?: string }).prompt ?? "") : text.replace(/^---\n[\s\S]*?\n---\n/, "");
      for (const word of PROMPT_WORDS) {
        expect(body.toLowerCase().includes(word.toLowerCase()), `${prompt} carries ${JSON.stringify(word)}`).toBe(false);
      }
    });
  }
});
