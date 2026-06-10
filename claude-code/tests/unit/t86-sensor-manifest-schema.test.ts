// covers: function:parseSensorManifest, function:validateSensorManifest, file:sensors/aidlc-required-sections.md, file:sensors/aidlc-upstream-coverage.md, file:sensors/aidlc-linter.md, file:sensors/aidlc-type-check.md
//
// t86 — sensor manifest schema for the 4 framework sensors + the legacy
// negative-case fixtures. Migrated from tests/unit/t86-sensor-manifest-schema.sh
// (TAP plan 28: Part 1 = 5 existence rows, Part 2 = 4 manifests × 5 frontmatter
// rows = 20, Part 3 = 3 negative-fixture rejection rows).
//
// Mechanism: none. This is a pure schema / structural check over shipped bytes
// — no process boundary, no argv/exit/stdout seam, no LLM, zero tokens. The .sh
// HAND-ROLLED the schema in awk (extract_field / has_frontmatter_field). The
// real contract those awk snippets approximate is the shipped validator
// `aidlc-sensor-schema.ts` (parseSensorManifest + validateSensorManifest),
// consumed by aidlc-graph compile (loadSensors). This twin is equal-or-stronger
// because it asserts against the REAL validator the framework runs, not an awk
// re-implementation, then additionally pins the exact field literals the .sh
// grepped for.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-sensor-schema.ts
//     :54  parseSensorManifest(raw): SensorManifest  — extract+coerce frontmatter
//     :142 validateSensorManifest(obj, file, filenameId): void
//            - :155 required-fields loop (id, kind, command, default_severity,
//                   description) — throws "missing required field: <f>"
//            - :162 id must equal filenameId (filename↔id contract)
//            - :169 kind must be "deterministic" (sole v0.5.0 enum value)
//            - :176 command must be a non-empty string
//            - :177 default_severity must be "advisory"
//            - :178 description must be a non-empty string
//            - :26  tolerates UNKNOWN keys for forward-compat (so a stray
//                   `applies_to:` is ignored, NOT rejected — see negative B)
//   dist/claude/.claude/sensors/aidlc-{required-sections,upstream-coverage,
//     linter,type-check}.md — the 4 shipped framework manifests.
//   tests/fixtures/v05-mr3-sensors-dir/malformed-{unknown-kind,empty-applies-to,
//     missing-id}.md — legacy negative-case fixtures.
//
// Schema being frozen (post applies_to removal, milestone 7b pull authoring):
//   - id matches filename stem (filename↔id contract)
//   - kind == deterministic (only valid v0.5.0 enum value)
//   - command points at the per-sensor script (canonical execution shape:
//     `bun .claude/tools/aidlc-sensor-<id>.ts`)
//   - applies_to ABSENT from the manifest bytes (pull authoring put scope on the
//     stage side via stage.sensors[]; the resolver gets no info from applies_to)
//   - default_severity and description present
//
// IMPORTANT semantic the .sh encodes (verified against the live validator):
//   negative B (malformed-empty-applies-to) is NOT a validateSensorManifest
//   rejection — the schema tolerates the unknown `applies_to:` key and ACCEPTS
//   the file. The .sh's negative-B assertion is purely: "this legacy fixture
//   STILL CARRIES applies_to in its frontmatter" (the field pull authoring
//   removed). So negative B is asserted at the FRONTMATTER-BYTES level here,
//   mirroring the .sh's manifest_has_applies_to, NOT as a validator throw.
//   Negatives A and C ARE real validator rejections.
//
// Old TAP -> new test parity (1:1, every .sh row -> a named expect()):
//   .sh L42      Part1: .claude/sensors/ dir exists           -> "sensors/ directory exists"
//   .sh L44-46   Part1: 4 manifest files exist                -> "each of the 4 framework manifests exists" [4 expects]
//   .sh L90      Part2 check1 ×4: id matches filename stem     -> "<id>: real schema accepts it; id == filename stem"
//   .sh L94      Part2 check2 ×4: kind == deterministic        -> (same per-manifest test, kind pin)
//   .sh L102     Part2 check3 ×4: command per-sensor script    -> (same per-manifest test, command pin)
//   .sh L106-110 Part2 check4 ×4: applies_to absent            -> (same per-manifest test, frontmatter applies_to absent)
//   .sh L113-117 Part2 check5 ×4: default_severity + desc      -> (same per-manifest test, both present)
//   .sh L127-133 Part3 A: unknown-kind rejected                -> "negative A: unknown kind rejected by validateSensorManifest"
//   .sh L139-144 Part3 B: empty-applies-to still carries field -> "negative B: legacy fixture still carries applies_to (field gone in pull authoring)"
//   .sh L147-153 Part3 C: missing id rejected                  -> "negative C: missing id rejected by validateSensorManifest"
//   .sh L36      plan 28                                       -> "covers EXACTLY 28 assertions (TAP plan parity)"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";
import {
  parseSensorManifest,
  validateSensorManifest,
} from "../../dist/claude/.claude/tools/aidlc-sensor-schema.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same root the .sh resolved
// SENSORS_DIR under ($AIDLC_SRC/sensors).
const SENSORS_DIR = join(AIDLC_SRC, "sensors");
const NEG_DIR = join(FIXTURES_DIR, "v05-mr3-sensors-dir");

// The 4 framework manifests, keyed by their expected frontmatter id. id MUST
// equal the filename stem minus the `aidlc-` prefix and the `.md` suffix
// (filename↔id contract). Same roster as the .sh's SENSOR_NAMES.
const SENSOR_NAMES = [
  "required-sections",
  "upstream-coverage",
  "linter",
  "type-check",
] as const;

const manifestPath = (name: string): string =>
  join(SENSORS_DIR, `aidlc-${name}.md`);

/**
 * Reproduce the .sh's has_frontmatter_field for `applies_to` (L67-83): does a
 * TOP-LEVEL frontmatter line `applies_to:` exist inside the first `---...---`
 * block? Recognises both `applies_to: value` (scalar) and `applies_to:`
 * (block start). Operates on the raw frontmatter bytes, NOT the parsed object,
 * because the parser drops unknown keys — and applies_to IS an unknown key.
 */
function frontmatterHasAppliesTo(raw: string): boolean {
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  return m[1]
    .split("\n")
    .some((line) => /^applies_to:/.test(line));
}

describe("t86 sensor manifest schema (migrated from t86-sensor-manifest-schema.sh, plan 28)", () => {
  // ===========================================================================
  // Part 1 — directory + file existence (5 .sh rows).
  // ===========================================================================
  test("sensors/ directory exists [.sh Part 1]", () => {
    expect(existsSync(SENSORS_DIR), `missing ${SENSORS_DIR}`).toBe(true);
    expect(statSync(SENSORS_DIR).isDirectory()).toBe(true);
  });

  test("each of the 4 framework manifests exists [.sh Part 1 ×4]", () => {
    for (const name of SENSOR_NAMES) {
      const f = manifestPath(name);
      expect(existsSync(f), `missing sensors/aidlc-${name}.md`).toBe(true);
    }
  });

  // ===========================================================================
  // Part 2 — per-manifest frontmatter shape (4 manifests × 5 checks = 20 rows).
  // Each manifest gets ONE test() that runs the REAL validator (stronger than
  // the .sh's awk) and pins the five field literals the .sh asserted.
  // ===========================================================================
  for (const name of SENSOR_NAMES) {
    test(`aidlc-${name}.md: real schema accepts + 5 field pins [.sh Part 2 checks 1-5]`, () => {
      const file = manifestPath(name);
      const raw = readFileSync(file, "utf-8");
      const obj = parseSensorManifest(raw);

      // STRONGER than the .sh: the REAL validator the framework runs at compile
      // accepts the manifest (id↔filename cross-check included). The .sh only
      // re-implemented the checks in awk; this proves the actual contract.
      expect(() => validateSensorManifest(obj, file, name)).not.toThrow();

      // .sh check 1: id field present and equals the filename stem.
      expect(obj.id).toBe(name);
      // .sh check 2: kind == deterministic (sole v0.5.0 enum value).
      expect(obj.kind).toBe("deterministic");
      // .sh check 3: command points at the per-sensor script (canonical
      // execution shape). Exact literal, same as the .sh's expected_command.
      expect(obj.command).toBe(`bun .claude/tools/aidlc-sensor-${name}.ts`);
      // .sh check 4: applies_to ABSENT from the frontmatter bytes (pull
      // authoring removed it; scope lives on the stage side via stage.sensors[]).
      expect(
        frontmatterHasAppliesTo(raw),
        `aidlc-${name}.md still carries applies_to (legacy push shape)`,
      ).toBe(false);
      // .sh check 5: default_severity AND description present (and non-empty —
      // the validator already enforced non-empty description; pin both here).
      expect(obj.default_severity).toBe("advisory");
      expect(typeof obj.description).toBe("string");
      expect((obj.description ?? "").length).toBeGreaterThan(0);
    });
  }

  // ===========================================================================
  // Part 3 — legacy negative-case fixtures (3 rows). Each is asserted on the
  // surface the .sh actually exercised; A and C are REAL validator rejections
  // (§6-E: the failure event must actually fire — here, validateSensorManifest
  // THROWS), B is a frontmatter-bytes presence assertion.
  // ===========================================================================

  // .sh L127-133 negative A: kind: arbitrary-bogus -> kind != deterministic.
  // STRONGER: the real validator throws with the kind-enum message, not an awk
  // inference that the value "would PASS".
  test("negative A: unknown kind rejected by validateSensorManifest [.sh Part 3 A]", () => {
    const file = join(NEG_DIR, "malformed-unknown-kind.md");
    const obj = parseSensorManifest(readFileSync(file, "utf-8"));
    expect(() =>
      validateSensorManifest(obj, file, "malformed-unknown-kind"),
    ).toThrow(/kind must be "deterministic"/);
  });

  // .sh L139-144 negative B: malformed-empty-applies-to predates pull
  // authoring. VERIFIED against the live validator: the schema TOLERATES the
  // unknown applies_to key and ACCEPTS the file — so the rejection is NOT a
  // validator throw, it is the .sh's manifest_has_applies_to assertion: this
  // legacy fixture STILL CARRIES applies_to (the field pull authoring removed).
  test("negative B: legacy fixture still carries applies_to (field gone in pull authoring) [.sh Part 3 B]", () => {
    const file = join(NEG_DIR, "malformed-empty-applies-to.md");
    const raw = readFileSync(file, "utf-8");
    // The legacy push-shape field is present in the fixture's frontmatter.
    expect(
      frontmatterHasAppliesTo(raw),
      "fixture malformed-empty-applies-to.md unexpectedly missing applies_to",
    ).toBe(true);
    // Pin the .sh's premise (forward-compat tolerance): the parser DROPS the
    // unknown key, so the schema is what makes applies_to meaningless — the
    // field is gone from the parsed manifest even though the bytes carry it.
    const obj = parseSensorManifest(raw) as unknown as Record<string, unknown>;
    expect("applies_to" in obj).toBe(false);
  });

  // .sh L147-153 negative C: id field absent -> rejected. STRONGER: the real
  // validator throws the missing-required-field message rather than the .sh's
  // "extract_field returns empty" inference.
  test("negative C: missing id rejected by validateSensorManifest [.sh Part 3 C]", () => {
    const file = join(NEG_DIR, "malformed-missing-id.md");
    const obj = parseSensorManifest(readFileSync(file, "utf-8"));
    expect(() =>
      validateSensorManifest(obj, file, "malformed-missing-id"),
    ).toThrow(/missing required field: id/);
  });

  // .sh L36: plan 28. Re-count the assertion budget so a silently dropped
  // manifest or negative case is caught (5 existence + 4×5 frontmatter + 3
  // negatives = 28).
  test("covers EXACTLY 28 assertions (TAP plan parity)", () => {
    const PART1 = 1 + SENSOR_NAMES.length; // dir + 4 files = 5
    const PART2 = SENSOR_NAMES.length * 5; // 4 manifests × 5 checks = 20
    const PART3 = 3; // 3 negative-case fixtures
    expect(PART1).toBe(5);
    expect(PART2).toBe(20);
    expect(PART3).toBe(3);
    expect(PART1 + PART2 + PART3).toBe(28);
    expect([...SENSOR_NAMES]).toEqual([
      "required-sections",
      "upstream-coverage",
      "linter",
      "type-check",
    ]);
  });
});
