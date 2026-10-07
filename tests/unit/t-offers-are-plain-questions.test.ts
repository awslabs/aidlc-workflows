// covers: function:forwardJumpNotice, function:backwardJumpNotice, function:staleStageLine, function:codeArrivedStageLine, function:planSourceDriftRelaxedNotice
//
// A line the person reads never tells them to type exact words or a command
// ("Say 'review the plan first' to ...", "To go back, type `/aidlc --stage x`").
// Something AI-DLC chose or noticed is offered as a plain question they answer
// in their own words, and the agent does it; a way back after their own action
// is said as a plain fact. A setting a line names gets a few plain words on
// what it does.
//
// Mechanism: source scan of core/tools and core/hooks, plus the line builders
// themselves. Lines other open work rewords are listed in OWNED and leave the
// list as that work lands.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { backwardJumpNotice, forwardJumpNotice } from "../../dist/claude/.claude/tools/aidlc-jump.ts";
import { staleStageLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeArrivedStageLine } from "../../dist/claude/.claude/tools/aidlc-validity.ts";
import { planSourceDriftRelaxedNotice } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

// Files another piece of open work owns whole, and exact phrases it rewords.
const OWNED_FILES = new Set(["aidlc-guard-switch.ts", "aidlc-recorded-switches.ts"]);
const OWNED = [
  "off\\` yourself ",
];
// A break-glass override the person must type in their own words on purpose.
const KEPT = ["Last resort, human only: type "];

// What a person-facing template must never carry, as it reads in the source.
const FORBIDDEN: Array<[string, RegExp]> = [
  ["say '<words>'", /\b[Ss]ay \\?['"][^'"\n]{2,60}\\?['"]/],
  ["Say go ahead", /\bSay go ahead\b/],
  ["type `/aidlc ...`", /\b[Tt]ype \\`\$\{entrySkillInvocation\(\)\}/],
  ["type ` + (split across lines)", /\b[Tt]ype [`"]\s*\+\s*$/],
  ["they can also type", /\bcan also type\b/],
];

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !OWNED_FILES.has(name))
    .map((name) => ({ file: `${dir.slice(REPO_ROOT.length + 1)}/${name}`, text: readFileSync(join(dir, name), "utf-8") }));
}

describe("t-offers-are-plain-questions: no line tells the person to type exact words", () => {
  const files = [...sources(join(REPO_ROOT, "core", "tools")), ...sources(join(REPO_ROOT, "core", "hooks"))];
  for (const [label, pattern] of FORBIDDEN) {
    test(`no "${label}" in core/tools or core/hooks`, () => {
      const hits: string[] = [];
      for (const { file, text } of files) {
        text.split("\n").forEach((line, index) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if ([...OWNED, ...KEPT].some((phrase) => line.includes(phrase))) return;
          if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});

describe("t-offers-are-plain-questions: the lines say what happened, then a plain question or the way back", () => {
  test("a jump says where it moved and that the way back is there, with nothing to type", () => {
    const forward = forwardJumpNotice(
      { slug: "code-generation", name: "Code Generation" },
      [{ slug: "nfr-design", name: "NFR Design" }],
      "functional-design",
    );
    expect(forward).toBe("Moved to Code Generation; skipped NFR Design. You can go back to Functional Design any time.");
    const backward = backwardJumpNotice(
      { slug: "requirements-analysis", name: "Requirements Analysis" },
      { slug: "units-generation", name: "Units Generation" },
    );
    expect(backward).toBe("Moved back to Requirements Analysis. You can return to Units Generation any time.");
  });

  test("a stage behind a change carries on and asks whether to redo it", () => {
    expect(staleStageLine("Requirements Analysis")).toBe(
      "Something Requirements Analysis used changed after it finished. I'm carrying on with it as it is. " +
        "Do you want me to redo Requirements Analysis with the change?",
    );
    expect(codeArrivedStageLine("Requirements Analysis")).toBe(
      "Requirements Analysis ran before the code was here. I'm carrying on with it as it is. " +
        "Do you want me to redo Requirements Analysis with the code?",
    );
  });

  test("changed code after a plan's approval carries on and asks whether to look at the plan first", () => {
    expect(planSourceDriftRelaxedNotice(["src/a.ts"])).toBe(
      "1 file changed since this plan was approved: src/a.ts. Carrying on. " +
        "Do you want to look at the plan again and approve it first?",
    );
  });
});
