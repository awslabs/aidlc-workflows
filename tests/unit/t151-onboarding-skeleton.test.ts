// t151: every harness ships complete native onboarding, while harnesses that
// share root instructions receive exactly the same neutral bytes.
// covers: file:scripts/onboarding.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  declaredSlots,
  renderNeutralOnboarding,
  renderOnboarding,
  type OnboardingFills,
} from "../../scripts/onboarding.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const NEUTRAL = readFileSync(join(REPO_ROOT, "core", "templates", "onboarding.md"), "utf-8");
const HARNESS = readFileSync(join(REPO_ROOT, "core", "templates", "onboarding-harness.md"), "utf-8");
const NEUTRAL_SECTIONS = [
  "## What AI-DLC does for you",
  "## Where things live",
  "## Harness onboarding",
  "## Conventions",
  "## Documentation",
  "## Session Resumption",
  "## Git Integration",
];
const HARNESS_SECTIONS = ["## Prerequisites", "## AI-DLC Structure", "## Plugins"];

function noLeftoverMarkers(rendered: string): RegExpMatchArray | null {
  return rendered.match(/\{\{[^}]+\}\}/);
}

function releasePath(path: string): string {
  return path.replace(join(REPO_ROOT, "dist"), join(REPO_ROOT, "dist-release"));
}

describe("t151 neutral and native onboarding", () => {
  test("neutral onboarding is marker-free and rejects harness-specific tokens", () => {
    expect(noLeftoverMarkers(NEUTRAL)).toBeNull();
    expect(NEUTRAL).not.toMatch(/^# /m);
    for (const marker of ["{{HARNESS_DIR}}", "{{INVOKE}}", "{{SKILL_INVOKE}}", "{{SLOT:title_block}}"] ) {
      expect(() => renderNeutralOnboarding(NEUTRAL + marker)).toThrow(/must not contain template markers/);
    }
    expect(renderNeutralOnboarding(NEUTRAL)).toBe(NEUTRAL);
  });

  test("the native skeleton exposes frontmatter and eight body fills", () => {
    expect(HARNESS.startsWith("{{SLOT:frontmatter}}\n{{SLOT:title_block}}\n")).toBe(true);
    expect(declaredSlots(HARNESS).sort()).toEqual([
      "agents_note",
      "frontmatter",
      "hook_permissions_note",
      "prereq_bullets",
      "prereq_bullets_tail",
      "sections_after_resumption",
      "sections_before_resumption",
      "structure_extra",
      "title_block",
    ]);
  });

  test("user-typed skill names carry the harness's skill prefix, not the shell invocation", () => {
    // `{{INVOKE}}` is a shell command (`bun <dir>/tools/aidlc.ts`, or `aidlc` on
    // a native install). Gluing a skill suffix onto it renders a command that
    // does not exist; the skill prefix each harness declares is what a person
    // types. Any `{{INVOKE}}-<suffix>` is that mistake.
    expect(HARNESS).not.toMatch(/\{\{INVOKE\}\}-/);

    const skills = ["session-cost", "replay", "outcomes-pack", "knowledge", "init"];
    for (const invoke of ["/aidlc", "$aidlc"]) {
      const rendered = renderOnboarding(HARNESS, { invoke, slots: {} })
        .replaceAll("{{HARNESS_DIR}}", ".foo")
        .replaceAll("{{INVOKE}}", "bun .foo/tools/aidlc.ts");
      for (const skill of skills) {
        expect(rendered, `${invoke}-${skill}`).toContain(`${invoke}-${skill}`);
      }
      expect(rendered).not.toContain("aidlc.ts-");
    }
  });

  test("runtime examples on {{INVOKE}} name commands the CLI routes", () => {
    // `--stage <slug> --single` is an orchestrator-skill flag the CLI rejects
    // as an unknown command, and `knowledge` is an engine noun, so neither is
    // reachable as a top-level `{{INVOKE}}` command. The shipped forms are pinned
    // per harness and channel in "every harness ships complete onboarding".
    expect(HARNESS).not.toMatch(/\{\{INVOKE\}\} --stage /);
    expect(HARNESS).not.toMatch(/\{\{INVOKE\}\} knowledge /);
  });

  test("a new harness gets complete onboarding without editing either skeleton", () => {
    const fills: OnboardingFills = {
      invoke: "@aidlc",
      slots: {
        title_block: "# AI-DLC on Foo CLI\n\nRun `@aidlc` to begin.",
        prereq_bullets: "- **Foo CLI**: install per its docs.",
      },
    };
    const rendered = renderOnboarding(HARNESS + "\n" + NEUTRAL, fills)
      .replaceAll("{{HARNESS_DIR}}", ".foo")
      .replaceAll("{{INVOKE}}", "aidlc");
    for (const section of [...NEUTRAL_SECTIONS, ...HARNESS_SECTIONS]) {
      expect(rendered).toContain(section);
    }
    expect(rendered).toContain("@aidlc");
    expect(noLeftoverMarkers(rendered)).toBeNull();
    expect(rendered).not.toMatch(/\n{3,}/);
  });

  test("omitted slots disappear, and malformed fills cannot leak template markers", () => {
    const out = renderOnboarding(
      "# T {{SLOT:inline}} x\n\n{{SLOT:lone}}\nbody {{SKILL_INVOKE}} runs {{INVOKE}}\n",
      { invoke: "/aidlc", slots: {} },
    );
    expect(out).toBe("# T  x\n\nbody /aidlc runs {{INVOKE}}\n");
    expect(() => renderOnboarding("body {{SKILL_INVOKE}}\n", {
      invoke: "{{SKILL_INVOKE}}",
      slots: {},
    })).toThrow(/render incomplete/);
  });

  test("every harness ships complete onboarding in both invocation channels", () => {
    for (const harness of HARNESS_MATRIX) {
      // The manifest-owned fills module has the shared renderer contract.
      const fillsModule = require(harness.onboardingFills) as { default: OnboardingFills };
      const fills = fillsModule.default;
      for (const native of [false, true]) {
        const root = readFileSync(native ? releasePath(harness.onboardingDist) : harness.onboardingDist, "utf-8");
        const setup = readFileSync(native ? releasePath(harness.harnessOnboardingDist) : harness.harnessOnboardingDist, "utf-8");
        expect(noLeftoverMarkers(root), harness.name).toBeNull();
        expect(noLeftoverMarkers(setup), harness.name).toBeNull();
        for (const section of NEUTRAL_SECTIONS) expect(root, harness.name).toContain(section);
        for (const section of HARNESS_SECTIONS) expect(setup, harness.name).toContain(section);
        expect(setup, harness.name).toContain(
          `${native ? "aidlc" : `bun ${harness.manifest.harnessDir}/tools/aidlc.ts`} engine runtime summary --json`,
        );
        expect(setup, harness.name).not.toContain(`${fills.invoke} engine`);
        expect(setup, harness.name).toContain(
          `${native ? "aidlc" : `bun ${harness.manifest.harnessDir}/tools/aidlc.ts`} engine knowledge <verb>`,
        );
        expect(setup, harness.name).toContain(`\`${fills.invoke} --stage <slug> --single\``);
        if (harness.manifest.onboarding?.harnessDst) {
          expect(root, harness.name).toBe(NEUTRAL);
          expect(setup, harness.name).not.toContain("## Where things live");
        } else {
          expect(setup.match(/^#+ .+$/gm)?.[0], harness.name).toBe("# Project Name <!-- Replace with your project name -->");
          expect(setup.endsWith("\n## Shared AI-DLC onboarding\n\n" + NEUTRAL), harness.name).toBe(true);
        }
      }
    }
  });

  test("all five identical-sharing harnesses ship byte-identical root instructions", () => {
    const sharing = HARNESS_MATRIX.filter((h) => h.manifest.rootIntegrations.some(
      (integration) => integration.path === "AGENTS.md" && integration.shared === "identical",
    ));
    expect(sharing.map((h) => h.name)).toEqual(["codex", "cursor", "kiro", "kiro-ide", "opencode"]);
    const expected = Buffer.from(NEUTRAL);
    for (const harness of sharing) {
      expect(readFileSync(harness.onboardingDist), harness.name).toEqual(expected);
      expect(readFileSync(releasePath(harness.onboardingDist)), harness.name).toEqual(expected);
    }
  });

  test("neutral onboarding documents the full DocumentKB verb surface exactly once", () => {
    for (const harness of HARNESS_MATRIX) {
      const root = readFileSync(harness.onboardingDist, "utf-8");
      const paragraphs = root.split("\n").filter((line) => line.includes("Document knowledge (DocumentKB)"));
      expect(paragraphs, harness.name).toHaveLength(1);
      const paragraph = paragraphs[0];
      expect(paragraph).toContain("`knowledge <verb>`");
      expect(paragraph.match(/`summarize <id>/g), harness.name).toHaveLength(1);
      for (const verb of ["onboard", "sync", "list", "show", "associate", "dissociate", "rebind", "summarize"]) {
        expect(paragraph, `${harness.name}: ${verb}`).toContain(verb);
      }
      expect(paragraph).not.toMatch(/`remove\s+<id>/);
    }
  });
});
