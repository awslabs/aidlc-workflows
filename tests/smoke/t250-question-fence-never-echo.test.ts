// covers: doc:harness/claude/skills/aidlc/question-rendering.md(never-echo-spec), doc:harness/codex/skills/aidlc/question-rendering.md(never-echo-spec), doc:harness/kiro/skills/aidlc/question-rendering.md(never-echo-spec), doc:harness/kiro-ide/skills/aidlc/question-rendering.md(never-echo-spec), doc:harness/opencode/skills/aidlc/question-rendering.md(never-echo-spec), doc:aidlc-common/protocols/stage-protocol.md(structured-questions-never-echo)
//
// t250: regression guard for the "never echo the ```question fence" contract:
// an orchestrator that dumps a fenced ` ```question ` block as LITERAL text
// instead of rendering it through the harness's question-rendering annex.
// The prohibition lives in every annex that renders structured questions:
//   - harness/claude/skills/aidlc/question-rendering.md    (AskUserQuestion)
//   - harness/codex/skills/aidlc/question-rendering.md     (request_user_input / prose)
//   - harness/kiro/skills/aidlc/question-rendering.md      (numbered prose)
//   - harness/kiro-ide/skills/aidlc/question-rendering.md  (numbered prose)
//   - harness/opencode/skills/aidlc/question-rendering.md  (numbered prose)
//   - core/aidlc-common/protocols/stage-protocol.md        (harness-neutral § "Structured questions")
//
// Mechanism: none. There is no tool / process / argv seam: the subject IS the
// prose contract in shipped source files. The failure mode (an LLM echoing the
// fence at runtime) is a behavioural mistake no static test can observe
// directly; that is exactly why the optional runtime lint/hook was investigated
// and DEFERRED. What a static test CAN pin (and what this guard exists to hold)
// is that the strengthened prohibition does not silently regress OUT of the
// source files, and that the source fences needed for illustrative annex
// mappings and normative protocol templates are preserved so the rule never
// forbids its own authoring specs. Zero LLM, zero tokens, zero subprocess.
//
// Assert against SOURCE (core/ + harness/), not dist/: source is the authored
// contract; the dist projection is regenerated from it and guarded separately
// by the package.ts `--check` drift tests. Pinning source keeps this guard
// meaningful even in a worktree where dist was not rebuilt.
//
// Design note (substring pins, not exact prose): each assertion matches a
// short, load-bearing PHRASE (case-insensitive where natural), never a whole
// paragraph. A future copy-edit that rewords around the phrase stays green; the
// guard only trips when the CONTRACT itself is removed. Each phrase was
// confirmed present in the post-fix source at authoring time.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// REPO_ROOT = <repo> (tests/harness/../..). The authored source trees sit
// directly beneath it: core/ (harness-neutral) and harness/<h>/.
const HARNESSES = ["claude", "codex", "kiro", "kiro-ide", "opencode"] as const;

function annexPath(harness: string): string {
  return join(
    REPO_ROOT,
    "harness",
    harness,
    "skills",
    "aidlc",
    "question-rendering.md",
  );
}

const PROTOCOL = join(
  REPO_ROOT,
  "core",
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);

const OPENING_QUESTION_FENCE = /^\s*```question\s*$/gm;

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("t250 (smoke) ```question fence is a SPEC to render, never echoed to chat", () => {
  test("all five annexes and the protocol exist (no vacuous pass on a rename)", () => {
    for (const h of HARNESSES) {
      expect(existsSync(annexPath(h))).toBe(true);
    }
    expect(existsSync(PROTOCOL)).toBe(true);
  });

  for (const harness of HARNESSES) {
    describe(`harness annex: ${harness}`, () => {
      test("carries the non-negotiable 'Never echo the spec' prohibition", () => {
        const t = read(annexPath(harness));
        // The section heading the fix introduces in every rendering annex.
        expect(/never echo the spec/i.test(t)).toBe(true);
        // The prohibition verb: matching keeps this robust to reorder.
        expect(/never\s+echo/i.test(t)).toBe(true);
      });

      test("names echoing the fence a protocol violation", () => {
        const t = read(annexPath(harness));
        expect(/protocol violation/i.test(t)).toBe(true);
      });

      test("lists representative structured-question sites the rule applies to", () => {
        const t = read(annexPath(harness));
        // The sites are representative, never an exhaustive allowlist.
        expect(/including but not limited to/i.test(t)).toBe(true);
        // Pin representative sites, including the consolidated-summary gate
        // that was missed by the original list.
        expect(/approval gate/i.test(t)).toBe(true);
        expect(/interaction-mode/i.test(t)).toBe(true);
        expect(/ladder prompt/i.test(t)).toBe(true);
        expect(/halt-and-ask/i.test(t)).toBe(true);
        expect(/consolidated-summary confirmation/i.test(t)).toBe(true);
        expect(/learnings gate/i.test(t)).toBe(true);
      });

      test("preserves the self-reference carve-out: illustrative example fences survive", () => {
        const t = read(annexPath(harness));
        // Each annex documents the spec BY SHOWING it (the mapping / rendering
        // example). Those fences must stay, or the examples become
        // uninterpretable. The fix must not delete its own illustrations while
        // forbidding runtime echoing.
        const fenceCount = t.match(OPENING_QUESTION_FENCE)?.length ?? 0;
        expect(fenceCount).toBeGreaterThanOrEqual(1);
      });
    });
  }

  test("Claude annex frames the fence as INPUT to the AskUserQuestion tool", () => {
    const t = read(annexPath("claude"));
    // Pin the load-bearing Claude-specific framing from its
    // `## Never echo the spec` section.
    expect(t).toContain("INPUT to the `AskUserQuestion` tool");
  });

  describe("harness-neutral protocol (stage-protocol.md) carries the same contract", () => {
    test("§ Structured questions states the fence is a spec, NEVER printed verbatim", () => {
      const t = read(PROTOCOL);
      // Neutral framing (no tool named): the fence is rendered THROUGH the
      // annex, never echoed. Match the durable phrase, case-insensitive.
      expect(/never\s+printed\s+verbatim/i.test(t)).toBe(true);
      expect(/never\s+echo\s+the\s+fence/i.test(t)).toBe(true);
    });

    test("keeps the neutral 'spec in, answerable prompt out' framing for all harnesses", () => {
      const t = read(PROTOCOL);
      expect(/spec in, answerable prompt out/i.test(t)).toBe(true);
    });

    test("keeps protocol fences normative while excluding only their raw syntax from chat", () => {
      const t = read(PROTOCOL);
      expect(/normative authoring specs/i.test(t)).toBe(true);
      expect(/content\s+MUST\s+still\s+be\s+presented/i.test(t)).toBe(true);
      expect(/not\s+literal\s+questions\s+to\s+paste\s+into\s+chat/i.test(t)).toBe(
        true,
      );
    });

    test("preserves its own normative ```question spec fences", () => {
      const t = read(PROTOCOL);
      // The protocol carries normative prompt specs throughout § "Structured
      // questions" and § "Question Format". The prohibition must not strip
      // those source fences while forbidding their raw syntax in chat.
      const fenceCount = t.match(OPENING_QUESTION_FENCE)?.length ?? 0;
      expect(fenceCount).toBeGreaterThanOrEqual(2);
    });
  });
});
