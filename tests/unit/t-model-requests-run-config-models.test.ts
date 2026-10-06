// covers: file:skills/aidlc/SKILL.md
//
// A person asks in plain words, with no /aidlc, to change an agent's model or
// effort ("make the developer agent think harder"). The agent used to edit the
// projected agent file by hand: `config models --check` then reported drift,
// and the next `aidlc config` put the old value back. Every harness's ambient
// onboarding and its /aidlc skill now name the `config models` command, and no
// doc tells anyone to edit the projected file.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const COMMAND = "config models --agent <name> --effort <low|medium|high|xhigh|max> --project --yes";
const NO_HAND_EDIT = "Never edit the `aidlc-*-agent` files for this.";
// A model alone takes no effort, and a project with two harnesses asks which.
const MODEL_ONLY = "`--model <id>` in place of `--effort`";
const NAMED_HARNESS = "run it again naming this tool's harness";

function releasePath(path: string): string {
  return path.replace(join(REPO_ROOT, "dist"), join(REPO_ROOT, "dist-release"));
}

describe("a model or effort request runs config models", () => {
  test("every harness's ambient onboarding names the command, in both channels", () => {
    expect(HARNESS_MATRIX.length).toBe(7);
    for (const harness of HARNESS_MATRIX) {
      const invokes = [
        { path: harness.harnessOnboardingDist, invoke: `bun ${harness.manifest.harnessDir}/tools/aidlc.ts` },
        { path: releasePath(harness.harnessOnboardingDist), invoke: "aidlc" },
      ];
      for (const { path, invoke } of invokes) {
        const onboarding = readFileSync(path, "utf-8");
        expect(onboarding, path).toContain("## Models and effort");
        expect(onboarding, path).toContain(`\`${invoke} ${COMMAND}\``);
        expect(onboarding, path).toContain(NO_HAND_EDIT);
        expect(onboarding, path).toContain(MODEL_ONLY);
        expect(onboarding, path).toContain(NAMED_HARNESS);
      }
    }
  });

  test("every harness's /aidlc skill names the command", () => {
    for (const harness of HARNESS_MATRIX) {
      const skill = readFileSync(join(harness.skillsRoot, "aidlc", "SKILL.md"), "utf-8");
      expect(skill, harness.name).toContain("**Model and effort requests.**");
      expect(skill, harness.name).toContain(`${harness.manifest.harnessDir}/tools/aidlc.ts ${COMMAND}`);
      expect(skill, harness.name).toContain(NO_HAND_EDIT);
      expect(skill, harness.name).toContain(MODEL_ONLY);
      expect(skill, harness.name).toContain(NAMED_HARNESS);
    }
  });

  test("no doc or onboarding tells anyone to edit the projected agent file", () => {
    const sources = [
      "core/templates/onboarding.md",
      "core/templates/onboarding-harness.md",
      "docs/guide/13-customization.md",
      "docs/guide/18-install-and-lifecycle.md",
      "docs/reference/05-agent-system.md",
      ...HARNESS_MATRIX.map((harness) => `harness/${harness.name}/skills/aidlc/SKILL.md`),
    ];
    for (const rel of sources) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(text, rel).not.toMatch(/edit the projected (?:value|`model:`)/);
      expect(text, rel).not.toContain("add a `\"model\"` field to the agent's");
    }
    const guide = readFileSync(join(REPO_ROOT, "docs/guide/13-customization.md"), "utf-8");
    expect(guide).toContain("To change ONE agent's effort, run `aidlc config models --agent <name> --effort");
    expect(guide).toContain("To pin its model, use `--model <id>`");
  });
});
