// covers: function:parseSensorManifest, function:validateSensorManifest, function:sensorTakesFilePath, file:sensors/aidlc-claim-sources.md, file:sensors/aidlc-required-sections.md, file:sensors/aidlc-upstream-coverage.md, file:sensors/aidlc-traceability.md, file:sensors/aidlc-linter.md, file:sensors/aidlc-type-check.md
//
// t86 — sensor manifest schema for the 6 framework sensors + the legacy
// negative-case fixtures. Migrated from tests/unit/t86-sensor-manifest-schema.sh
// (extended plan 40: Part 1 = 7 existence rows, Part 2 = 6 manifests × 5
// frontmatter rows = 30, Part 3 = 3 negative-fixture rejection rows).
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
//     linter,type-check,claim-sources}.md — the 5 shipped framework manifests.
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
//   .sh L44-46   Part1: framework manifest files exist        -> "each of the 5 framework manifests exists" [5 expects]
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
import { sensorTakesFilePath } from "../../dist/claude/.claude/tools/aidlc-sensor.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same root the .sh resolved
// SENSORS_DIR under ($AIDLC_SRC/sensors).
const SENSORS_DIR = join(AIDLC_SRC, "sensors");
const NEG_DIR = join(FIXTURES_DIR, "v05-mr3-sensors-dir");

// The 6 framework manifests, keyed by their expected frontmatter id. id MUST
// equal the filename stem minus the `aidlc-` prefix and the `.md` suffix
// (filename↔id contract). Same roster as the .sh's SENSOR_NAMES.
const SENSOR_NAMES = [
  "claim-sources",
  "required-sections",
  "upstream-coverage",
  "traceability",
  "linter",
  "type-check",
] as const;

const manifestPath = (name: string): string =>
  join(SENSORS_DIR, `aidlc-${name}.md`);
const GATE_SENSORS = new Set([
  "claim-sources",
  "required-sections",
  "upstream-coverage",
]);

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

describe("t86 sensor manifest schema (extended from t86-sensor-manifest-schema.sh, plan 34)", () => {
  // ===========================================================================
  // Part 1 — directory + file existence (6 rows).
  // ===========================================================================
  test("sensors/ directory exists [.sh Part 1]", () => {
    expect(existsSync(SENSORS_DIR), `missing ${SENSORS_DIR}`).toBe(true);
    expect(statSync(SENSORS_DIR).isDirectory()).toBe(true);
  });

  test("each of the 6 framework manifests exists [Part 1 ×6]", () => {
    for (const name of SENSOR_NAMES) {
      const f = manifestPath(name);
      expect(existsSync(f), `missing sensors/aidlc-${name}.md`).toBe(true);
    }
  });

  // ===========================================================================
  // Part 2 — per-manifest frontmatter shape (6 manifests × 5 checks = 30 rows).
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
      // .sh check 3: command points at the source-channel dispatcher.
      expect(obj.command).toBe(
        `bun .claude/tools/aidlc.ts engine sensor-${name}`,
      );
      // .sh check 4: applies_to ABSENT from the frontmatter bytes (pull
      // authoring removed it; scope lives on the stage side via stage.sensors[]).
      expect(
        frontmatterHasAppliesTo(raw),
        `aidlc-${name}.md still carries applies_to (legacy push shape)`,
      ).toBe(false);
      // .sh check 5: default_severity AND description present (and non-empty —
      // the validator already enforced non-empty description; pin both here).
      expect(obj.default_severity).toBe("advisory");
      expect(obj.fire_on).toBe(GATE_SENSORS.has(name) ? "gate" : "write");
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

  test("fire_on defaults to write when omitted", () => {
    const raw = [
      "---",
      "id: default-fire",
      "kind: deterministic",
      "command: bun .claude/tools/aidlc-sensor-default-fire.ts",
      "default_severity: advisory",
      "description: default fire mode",
      "---",
    ].join("\n");
    const obj = parseSensorManifest(raw);
    expect(obj.fire_on).toBe("write");
    expect(() =>
      validateSensorManifest(obj, "aidlc-default-fire.md", "default-fire"),
    ).not.toThrow();
  });

  test("fire_on accepts gate and rejects unknown values", () => {
    const valid = parseSensorManifest([
      "---",
      "id: gate-fire",
      "kind: deterministic",
      "command: bun .claude/tools/aidlc-sensor-gate-fire.ts",
      "default_severity: advisory",
      "fire_on: gate",
      "description: gate fire mode",
      "---",
    ].join("\n"));
    expect(() =>
      validateSensorManifest(valid, "aidlc-gate-fire.md", "gate-fire"),
    ).not.toThrow();

    const invalid = { ...valid, fire_on: "later" } as unknown as typeof valid;
    expect(() =>
      validateSensorManifest(invalid, "aidlc-gate-fire.md", "gate-fire"),
    ).toThrow(/fire_on must be one of: "write", "gate"/);
  });

  test("default_severity accepts blocking and rejects unknown values", () => {
    const blocking = parseSensorManifest([
      "---",
      "id: blocking",
      "kind: deterministic",
      "command: bun .claude/tools/aidlc-sensor-blocking.ts",
      "default_severity: blocking",
      "fire_on: gate",
      "description: blocking gate sensor",
      "---",
    ].join("\n"));
    expect(() =>
      validateSensorManifest(blocking, "aidlc-blocking.md", "blocking"),
    ).not.toThrow();

    const invalid = {
      ...blocking,
      default_severity: "critical",
    } as unknown as typeof blocking;
    expect(() =>
      validateSensorManifest(invalid, "aidlc-blocking.md", "blocking"),
    ).toThrow(/default_severity must be one of: "advisory", "blocking"/);
  });

  // input_schema is the manifest's declared invocation contract, and the
  // dispatcher routes a sensor's path argument on it: a sensor that declares
  // file_path is invoked with --file-path, everything else with --output-path.
  // The shipped six already declare exactly that split, so the parser has to
  // surface it - a plugin has no other way to reach the routing decision.
  test("every shipped manifest's input_schema parses, and the code sensors are the file_path pair", () => {
    const declared = new Map<string, string[]>();
    for (const name of SENSOR_NAMES) {
      const manifest = parseSensorManifest(
        readFileSync(join(AIDLC_SRC, "sensors", `aidlc-${name}.md`), "utf-8"),
      );
      const keys = Object.keys(manifest.input_schema ?? {});
      expect(keys.length, `aidlc-${name}.md declares no input_schema keys`).toBeGreaterThan(0);
      declared.set(name, keys);
    }
    const filePathSensors = [...declared.entries()]
      .filter(([, keys]) => keys.includes("file_path"))
      .map(([name]) => name)
      .sort();
    expect(filePathSensors).toEqual(["linter", "type-check"]);
    for (const [name, keys] of declared) {
      if (filePathSensors.includes(name)) continue;
      expect(keys, `aidlc-${name}.md`).toContain("output_path");
      expect(keys, `aidlc-${name}.md`).not.toContain("file_path");
    }
    // The next top-level key ends the block, so output_schema's nested
    // violations list stays out of the input contract.
    expect(Object.keys(parseSensorManifest(
      readFileSync(join(AIDLC_SRC, "sensors", "aidlc-linter.md"), "utf-8"),
    ).input_schema ?? {})).toEqual(["file_path"]);
  });

  // Re-count the original migrated assertion budget. The fire/severity enum
  // and input_schema cases above are additive coverage for the expanded schema.
  test("covers EXACTLY 40 migrated assertions", () => {
    const PART1 = 1 + SENSOR_NAMES.length; // dir + 6 files = 7
    const PART2 = SENSOR_NAMES.length * 5; // 6 manifests × 5 checks = 30
    const PART3 = 3; // 3 negative-case fixtures
    expect(PART1).toBe(7);
    expect(PART2).toBe(30);
    expect(PART3).toBe(3);
    expect(PART1 + PART2 + PART3).toBe(40);
    expect([...SENSOR_NAMES]).toEqual([
      "claim-sources",
      "required-sections",
      "upstream-coverage",
      "traceability",
      "linter",
      "type-check",
    ]);
  });
});

// A plugin reaches the path-argument routing only through its manifest's
// input_schema, so every shape an author can write has to parse. A shape that
// silently read as "no declaration" would send a plugin code sensor
// --output-path: its script exits on the unknown flag and the fire is
// recorded as a pass.
describe("t86 input_schema invocation contract", () => {
  const withSchema = (schema: string): Record<string, unknown> | undefined =>
    parseSensorManifest([
      "---",
      "id: x",
      "kind: deterministic",
      "command: c",
      "default_severity: advisory",
      "description: d",
      schema,
      "timeout_seconds: 5",
      "---",
      "",
    ].join("\n")).input_schema;

  test("block and flow mappings parse, with comments and quoted keys", () => {
    expect(withSchema("input_schema:\n  file_path: string")).toEqual({ file_path: "string" });
    // The header comment is the reference doc's own example shape.
    expect(withSchema("input_schema:        # optional\n  file_path: string  # the file")).toEqual({
      file_path: "string",
    });
    expect(withSchema("input_schema:\n# the analysed file\n  file_path: string")).toEqual({
      file_path: "string",
    });
    expect(withSchema(`input_schema:\n  "file_path": string\n  'stage_slug': string`)).toEqual({
      file_path: "string",
      stage_slug: "string",
    });
    expect(withSchema("input_schema: { file_path: string, deliverables: string[] } # flow")).toEqual({
      file_path: "string",
      deliverables: "string[]",
    });
  });

  test("nesting under a key belongs to that key", () => {
    expect(withSchema("input_schema:\n  file_path:\n    type: string\n  stage_slug: string")).toEqual({
      file_path: "",
      stage_slug: "string",
    });
    expect(withSchema("input_schema: { file_path: { type: string }, stage_slug: string }")).toEqual({
      file_path: "{ type: string }",
      stage_slug: "string",
    });
  });

  test("an empty, scalar, or absent declaration reads as no declaration", () => {
    expect(withSchema("input_schema: {}")).toBeUndefined();
    expect(withSchema("input_schema:")).toBeUndefined();
    expect(withSchema("input_schema: file_path")).toBeUndefined();
    expect(withSchema("category: code-quality")).toBeUndefined();
  });
});

// The dispatcher used to decide a sensor's path argument from a hardcoded id
// pair, so a plugin sensor that follows the shipped code-sensor convention
// received --output-path, exited on the unknown flag, and was recorded as a
// pass in tens of milliseconds. The manifest's declared input_schema is the
// only signal a plugin can reach, so routing reads it.
describe("t86 sensor path-argument routing", () => {
  const manifest = (input_schema?: Record<string, string>) => ({
    id: "x",
    kind: "deterministic" as const,
    command: "c",
    default_severity: "advisory" as const,
    description: "d",
    fire_on: "write" as const,
    ...(input_schema ? { input_schema } : {}),
  });

  test("a declared file_path routes the file path, whoever ships the sensor", () => {
    expect(sensorTakesFilePath(manifest({ file_path: "string" }), "chunk-validate")).toBe(true);
    expect(sensorTakesFilePath(manifest({ file_path: "string" }), "linter")).toBe(true);
  });

  test("a declared contract without file_path routes the output path", () => {
    const declared = { output_path: "string", stage_slug: "string" };
    expect(sensorTakesFilePath(manifest(declared), "chunk-validate")).toBe(false);
    // A declared contract wins over the id: the manifest is the authority.
    expect(sensorTakesFilePath(manifest(declared), "linter")).toBe(false);
  });

  test("no declared contract falls back to the shipped code-sensor pair", () => {
    expect(sensorTakesFilePath(manifest(), "linter")).toBe(true);
    expect(sensorTakesFilePath(manifest(), "type-check")).toBe(true);
    expect(sensorTakesFilePath(manifest(), "required-sections")).toBe(false);
    expect(sensorTakesFilePath(manifest(), "chunk-validate")).toBe(false);
    expect(sensorTakesFilePath(manifest({}), "chunk-validate")).toBe(false);
  });
});
