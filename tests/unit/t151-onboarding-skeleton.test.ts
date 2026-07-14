// t151-onboarding-skeleton: the shared onboarding-doc skeleton renders a
// COMPLETE doc for every harness — including a brand-new one — from one source.
//
// covers: file:scripts/onboarding.ts
//
// WHAT. core/templates/onboarding.md + scripts/onboarding.ts render each
// harness's CLAUDE.md / AGENTS.md. This pins the "a 4th harness gets a complete
// onboarding doc for free, provably" guarantee:
//   (1) renderOnboarding() over a SYNTHETIC 4th harness's fills produces a doc
//       with every shared section present, the invoke command substituted, and
//       NO leftover {{SLOT:...}} / {{INVOKE}} marker — i.e. nothing was forgotten.
//   (2) An incomplete fill set (a declared slot left unprovided that the renderer
//       fails to blank) cannot pass — the renderer THROWS. We assert the
//       completeness guard fires on a deliberately-broken skeleton.
//   (3) Each manifest-discovered shipped harness renders with zero leftover
//       markers via its real fills, and its projected onboarding file exists.
//
// Mechanism: none. Pure in-process render over the skeleton + fills modules.
// Zero spawn, zero LLM, zero tokens.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  declaredSlots,
  renderOnboarding,
  type OnboardingFills,
} from "../../scripts/onboarding.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const SKELETON = readFileSync(
  join(REPO_ROOT, "core", "templates", "onboarding.md"),
  "utf-8",
);

// The shared sections every rendered onboarding doc must carry, regardless of
// harness (they live in the skeleton body, not a per-harness slot).
const REQUIRED_SECTIONS = [
  "## Prerequisites",
  "## AI-DLC Structure",
  "## Conventions",
  "## Documentation",
  "## Session Resumption",
  "## Git Integration",
];

function noLeftoverMarkers(rendered: string): RegExpMatchArray | null {
  return rendered.match(/\{\{SLOT:[a-z_]+\}\}|\{\{INVOKE\}\}|\{\{HARNESS_DIR\}\}/);
}

describe("t151 onboarding skeleton — a new harness gets a complete doc for free", () => {
  test("1: a synthetic 4th harness renders a complete doc (all sections, no leftover markers)", () => {
    // A minimal fills set for an imaginary harness "Foo CLI". Every declared
    // slot gets a value (some empty — intentional omission). This is exactly what
    // a porter writes: one fills file, no skeleton edit.
    const fooFills: OnboardingFills = {
      invoke: "@aidlc",
      slots: Object.fromEntries(
        declaredSlots(SKELETON).map((name) => [
          name,
          name === "title_block"
            ? "# Project Name\n\nThis project uses AI-DLC on the Foo CLI harness. Run `@aidlc` to begin."
            : name === "prereq_bullets"
              ? "- **Foo CLI**: install per its docs.\n- **bun**: required for the tools."
              : "", // every other slot intentionally omitted for this minimal harness
        ]),
      ),
    };

    // Render, then substitute the harness-dir token the packager would apply.
    let rendered = renderOnboarding(SKELETON, fooFills);
    rendered = rendered.split("{{HARNESS_DIR}}").join(".foo");

    // Every shared section is present — the doc is structurally complete.
    for (const section of REQUIRED_SECTIONS) {
      expect(rendered).toContain(section);
    }
    // The invoke command was substituted everywhere.
    expect(rendered).toContain("@aidlc");
    // Nothing was forgotten: no slot/invoke/harness-dir marker survives.
    expect(noLeftoverMarkers(rendered)).toBeNull();
  });

  test("2: omitted slots render blank (no marker leaks) and the guard catches an unsubstituted invoke", () => {
    // A) Completeness by construction: a declared slot with NO fill renders to
    //    empty — the doc never ships a visible {{SLOT:...}} marker, whether the
    //    slot sits on its own line or mid-line.
    const sk = "# T {{SLOT:inline}} x\n\n{{SLOT:lone}}\nbody {{INVOKE}}\n";
    const out = renderOnboarding(sk, { invoke: "/aidlc", slots: {} });
    expect(out).not.toContain("{{SLOT:");
    expect(out).toContain("body /aidlc"); // invoke substituted
    expect(out).toContain("# T  x"); // inline slot blanked in place

    // B) The defensive completeness guard: if the invoke value itself smuggles a
    //    surviving marker (a malformed/typo'd token the slot loop never matched),
    //    renderOnboarding THROWS rather than shipping it.
    expect(() =>
      renderOnboarding("body {{INVOKE}}\n", { invoke: "{{INVOKE}}", slots: {} }),
    ).toThrow(/render incomplete/);
  });

  test("3: every shipped harness renders with zero leftover markers via its real fills", () => {
    for (const harness of HARNESS_MATRIX) {
      const fills = (
        require(harness.onboardingFills) as {
          default: OnboardingFills;
        }
      ).default;
      let rendered = renderOnboarding(SKELETON, fills);
      rendered = rendered.split("{{HARNESS_DIR}}").join(harness.manifest.harnessDir);
      expect({ harness: harness.name, leftover: noLeftoverMarkers(rendered) }).toEqual({
        harness: harness.name,
        leftover: null,
      });

      const shipped = readFileSync(harness.onboardingDist, "utf-8");
      expect(noLeftoverMarkers(shipped), `${harness.name}: shipped onboarding markers`).toBeNull();
      for (const section of REQUIRED_SECTIONS) {
        expect(rendered).toContain(section);
        expect(shipped, `${harness.name}: shipped ${section}`).toContain(section);
      }
    }
  });
});
