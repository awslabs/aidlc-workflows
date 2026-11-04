// covers: file:skills/aidlc/SKILL.md
//
// t-copilot-record-write-rule: the /aidlc skill AI-DLC ships for Copilot carries
// one `allowed-tools` write rule, so Copilot CLI creates and edits the files of
// AI-DLC's own record without its "Do you want to create" dialog while the skill
// is in use, and still asks for every other file. Its one shell rule names
// AI-DLC's own launcher (t-copilot-engine-launcher.test.ts) and nothing else.
//
// Measured on Copilot CLI 1.0.96 and 1.0.105 (Linux) and 1.0.105 (Windows
// Server), in Copilot's own terminal: Copilot adds a skill's rules when the
// skill is invoked; a relative write rule matches by trailing path components
// (`./` does not anchor it, and an absolute path cannot ship in a file every
// clone shares); the person's own `--deny-tool=write` still wins; with the rule,
// the record's files under the intents folder are written without a dialog and
// the space's memory files are still asked. Without it, every record write was a
// dialog: 14 to 15 of a release journey's 35 to 37, 31 to 33 of a golden bugfix
// journey's 83 to 86.
//
// The record's path is the engine's own (`intentsDir`), so a layout change fails
// here and not silently in a person's session. Read from the shipped skill on
// both channels (copy and native); no spawn.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { intentsDir } from "../../dist/claude/.claude/tools/aidlc-locks.ts";
import { LAUNCHER_PATH } from "../../core/tools/aidlc-launcher-voucher.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const SKILLS = ["dist", "dist-release"].map((root) =>
  join(REPO_ROOT, root, "copilot", ".github", "skills", "aidlc", "SKILL.md"),
);

// `aidlc/spaces/*/intents`: every space's intents folder, as the engine lays it out.
const SPACE = "space-name";
const PROJECT = join(REPO_ROOT, "project");
const INTENTS_ROOT = relative(PROJECT, intentsDir(PROJECT, SPACE))
  .split(sep)
  .map((part) => (part === SPACE ? "*" : part))
  .join("/");
const RECORD_RULE = `write(${INTENTS_ROOT}/**)`;
const LAUNCHER_RULE = `shell(${LAUNCHER_PATH})`;

function allowedTools(skill: string): unknown {
  const fm = readFileSync(skill, "utf-8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  expect(fm, skill).toBeDefined();
  return (Bun.YAML.parse(fm as string) as Record<string, unknown>)["allowed-tools"];
}

/** Each rule that would let Copilot do more than write AI-DLC's own record, with why. */
function ruleFindings(rules: unknown): string[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return [`allowed-tools is not a list: ${JSON.stringify(rules)}`];
  const findings: string[] = [];
  for (const rule of rules) {
    if (rule === LAUNCHER_RULE) continue;
    const path = typeof rule === "string" ? rule.match(/^write\((.+)\)$/)?.[1] : undefined;
    if (path === undefined) findings.push(`${String(rule)}: not a write rule naming a path`);
    else if (!path.startsWith(`${INTENTS_ROOT}/`) || path.split("/").includes(".."))
      findings.push(`${rule}: a path outside AI-DLC's record`);
  }
  return findings;
}

describe("t-copilot-record-write-rule: Copilot writes AI-DLC's own record without a dialog, and nothing else", () => {
  test("the record's intents folder is aidlc/spaces/<space>/intents", () => {
    expect(INTENTS_ROOT).toBe("aidlc/spaces/*/intents");
  });

  for (const skill of SKILLS) {
    const channel = skill.includes(`${sep}dist-release${sep}`) ? "native" : "copy";

    test(`${channel} channel: the /aidlc skill allows writes under AI-DLC's record`, () => {
      expect(allowedTools(skill)).toEqual([LAUNCHER_RULE, RECORD_RULE]);
    });

    test(`${channel} channel: the rules name only AI-DLC's record path and its own launcher`, () => {
      expect(ruleFindings(allowedTools(skill))).toEqual([]);
    });
  }

  test("the check names a shell rule, a bare write and a path outside the record", () => {
    expect(
      ruleFindings([
        "shell(bun)",
        "Bash(bun:*)",
        `shell(${LAUNCHER_PATH} *)`,
        "write",
        "write(src/**)",
        "write(/home/someone/project/aidlc/spaces/*/intents/**)",
        "write(aidlc/spaces/*/intents/../../memory/**)",
        RECORD_RULE,
        LAUNCHER_RULE,
      ]),
    ).toHaveLength(7);
  });
});
