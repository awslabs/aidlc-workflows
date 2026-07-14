// scripts/onboarding.ts — the shared onboarding-doc renderer.
//
// One hand-authored skeleton (core/templates/onboarding.md) renders into every
// harness's shipped onboarding doc (CLAUDE.md / AGENTS.md). The skeleton carries:
//   - {{HARNESS_DIR}} — the harness dir token, left UNSUBSTITUTED here so the
//     packager's single sanctioned transform() (+ rules-rename) handles it,
//     exactly like every other core/ .md. This module never touches it.
//   - {{INVOKE}} — the invoke command (`/aidlc`, `$aidlc`, …), substituted here.
//   - {{SLOT:<name>}} — named per-harness slots, filled from the harness's
//     onboarding.fills.ts. A slot with no fill renders empty (intentional
//     "section omitted"); an UNKNOWN {{SLOT:...}} left in the output is a bug and
//     throws — that is the "a new harness gets a complete doc, provably" guard.
//
// Both consumers import renderOnboarding(): package.ts (claude, kiro, kiro-ide)
// and harness/codex/emit.ts (codex). Adding a harness = author one fills file;
// the skeleton and this renderer are untouched.

/** Per-harness fill set: the invoke command + the slot bodies. */
export type OnboardingFills = {
  /** The invoke command this harness uses, e.g. "/aidlc" or "$aidlc". */
  invoke: string;
  /**
   * Slot name → markdown body. A slot listed in the skeleton but absent here
   * renders to empty (the section is intentionally omitted for this harness).
   * Bodies should NOT carry a trailing newline; the renderer manages spacing.
   */
  slots: Record<string, string>;
};

/** Every {{SLOT:<name>}} marker the skeleton declares, for validation. */
export function declaredSlots(skeleton: string): string[] {
  const out = new Set<string>();
  for (const m of skeleton.matchAll(/\{\{SLOT:([a-z_]+)\}\}/g)) out.add(m[1]);
  return [...out];
}

/**
 * Render the onboarding skeleton for one harness. Returns markdown with
 * {{HARNESS_DIR}} STILL PRESENT (the caller's transform substitutes it).
 *
 * Throws if the rendered output still contains a {{SLOT:...}} or {{INVOKE}}
 * marker — that can only happen if the skeleton declares a slot the fills omit
 * AND the renderer failed to blank it, i.e. a real bug. (A deliberately-empty
 * slot is blanked, not left as a marker.) This is the completeness guarantee.
 */
export function renderOnboarding(skeleton: string, fills: OnboardingFills): string {
  let out = skeleton;

  // Fill named slots. Every declared slot is replaced — with its fill body if
  // provided, else with empty string (intentional omission). A slot marker that
  // sits alone on its line is removed cleanly (line + its trailing newline) so
  // an omitted section leaves no blank-line scar; a non-empty fill replaces the
  // marker in place.
  for (const name of declaredSlots(skeleton)) {
    const body = fills.slots[name] ?? "";
    const loneLine = new RegExp(`^\\{\\{SLOT:${name}\\}\\}\\n`, "m");
    if (body === "" && loneLine.test(out)) {
      out = out.replace(loneLine, "");
    } else {
      out = out.split(`{{SLOT:${name}}}`).join(body);
    }
  }

  // Substitute the invoke command.
  out = out.split("{{INVOKE}}").join(fills.invoke);

  // Completeness guard: no slot/invoke marker may survive.
  const leftover = out.match(/\{\{SLOT:[a-z_]+\}\}|\{\{INVOKE\}\}/);
  if (leftover) {
    throw new Error(
      `onboarding render incomplete: marker ${leftover[0]} survived for invoke="${fills.invoke}". ` +
        `Every {{SLOT:...}} the skeleton declares must be fillable.`,
    );
  }

  // Strip per-line trailing whitespace — an inline slot filled with "" can leave
  // a trailing space (e.g. "… `docs/README.md`. " when guide_pointer is empty).
  out = out.replace(/[ \t]+$/gm, "");
  // Collapse any run of 3+ blank lines an omitted slot may have left to 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  // Ensure a single trailing newline.
  return out.replace(/\n*$/, "\n");
}
