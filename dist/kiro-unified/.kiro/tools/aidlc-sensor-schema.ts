// Sensor manifest schema — capability descriptor only. Sibling of
// aidlc-stage-schema.ts and aidlc-rule-schema.ts. Consumed by
// aidlc-graph compile (loadSensors). Hand-rolled, zero-dep — reuses
// scalarField from aidlc-lib.ts as a zero-dep YAML primitive.
//
// Pull authoring: manifests describe what the sensor IS, not which
// stages use it. The relationship lives on the stage side via
// `sensors: [<id>]` in stage frontmatter; the resolver looks each
// declared id up here at compile time.
//
// Schema:
//   - id: string                    — required; matches filename stem after
//                                      `aidlc-` prefix and before `.md`
//   - kind: "deterministic"         — required; sole accepted value today
//   - command: string               — required; sensor invocation
//   - default_severity: "advisory"  — required; sole accepted value today
//   - description: string           — required; one-line capability summary
//   - category: string              — optional grouping label
//   - input_schema: object          — optional invocation contract
//   - output_schema: object         — optional return contract
//   - timeout_seconds: number       — optional execution budget
//   - matches: string               — optional path-shape filter; consumed
//                                      by the PostToolUse hook at fire time.
//                                      Sensors that analyse any output omit it.
//
// Tolerates unknown keys for forward-compat (per 07-sensor-system.md).

import { scalarField } from "./aidlc-lib.ts";

export interface SensorManifest {
  id: string;
  kind: "deterministic";
  command: string;
  default_severity: "advisory";
  description: string;
  category?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  timeout_seconds?: number;
  matches?: string;
}

const REQUIRED_FIELDS = [
  "id",
  "kind",
  "command",
  "default_severity",
  "description",
] as const;

// parseSensorManifest — extract the YAML frontmatter from a sensor manifest
// body. Throws when frontmatter is missing or malformed. Strips a UTF-8 BOM
// before matching so editors that add one don't silently drop the manifest.
export function parseSensorManifest(raw: string): SensorManifest {
  const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const m = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    throw new Error("Sensor manifest missing YAML frontmatter (---...---)");
  }
  const fm = m[1];

  const obj: Record<string, unknown> = {};

  // Scalar fields — read each known scalar via the zero-dep helper. Empty
  // string ("" return from scalarField when absent) is left out so
  // validateSensorManifest sees the genuinely-missing case.
  const id = scalarField(fm, "id");
  if (id !== "") obj.id = id;
  const kind = scalarField(fm, "kind");
  if (kind !== "") obj.kind = kind;
  const command = scalarField(fm, "command");
  if (command !== "") obj.command = command;
  const default_severity = scalarField(fm, "default_severity");
  if (default_severity !== "") obj.default_severity = default_severity;
  const description = scalarField(fm, "description");
  if (description !== "") obj.description = description;
  const category = scalarField(fm, "category");
  if (category !== "") obj.category = category;
  const matches = scalarField(fm, "matches");
  if (matches !== "") obj.matches = matches;
  const timeout = scalarField(fm, "timeout_seconds");
  if (timeout !== "") {
    const n = parseInt(timeout, 10);
    if (!Number.isNaN(n)) obj.timeout_seconds = n;
  }

  // Cast-through-unknown: obj is Record<string, unknown> with the
  // shape of a SensorManifest by construction (we wrote each known
  // scalar above) but no index-signature/structural overlap exists at
  // the type level. validateSensorManifest() runs immediately after
  // and throws on any field that's actually missing.
  // type-coverage:ignore-next-line — documented parseSensorManifest trust boundary
  return obj as unknown as SensorManifest;
}

// Helper: throw if obj[field] isn't a non-empty string. Centralises
// the (typeof !== "string" || length === 0) pattern that recurs across
// id / command / description / matches checks. Keeps each call site
// to a single conditional and pushes complexity into a per-field tag
// rather than the validator function's branching factor.
function requireNonEmptyString(
  obj: SensorManifest,
  field: "id" | "command" | "description" | "matches",
  file: string,
): void {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    const suffix = field === "matches" ? " when present" : "";
    throw new Error(`${file}: ${field} must be a non-empty string${suffix}`);
  }
}

// Helper: throw if obj[field] !== expected. Centralises the literal-
// match check used for kind ("deterministic") and default_severity
// ("advisory"). Optional `hint` appends a trailing clause to the
// thrown message (e.g., "; other kinds reserved for future releases").
function requireExactValue<K extends "kind" | "default_severity">(
  obj: SensorManifest,
  field: K,
  expected: SensorManifest[K],
  file: string,
  hint?: string,
): void {
  if (obj[field] !== expected) {
    const tail = hint ? `; ${hint}` : "";
    throw new Error(
      `${file}: ${field} must be "${expected}" (got "${obj[field]}")${tail}`,
    );
  }
}

// validateSensorManifest — schema check on a parsed manifest. Throws
// "<file>: <message>" on the first violation, mirroring
// compileStageGraph's error pattern. Cross-checks `id:` against the
// filename stem (passed by the caller, who knows the path).
//
// Per-field validation delegates to requireNonEmptyString and
// requireExactValue helpers above; the function itself only branches
// on (a) the required-fields presence loop, (b) the id-vs-filename
// cross-check that needs both inputs, and (c) the optional-matches
// gate. Cyclomatic complexity stays under the linter's complexity cap.
export function validateSensorManifest(
  obj: SensorManifest,
  file: string,
  filenameId: string,
): void {
  // Cast through Record<string, unknown> to enable dynamic field iteration
  // over REQUIRED_FIELDS without per-field overhead. obj is already typed
  // as SensorManifest by the parse step's trust boundary; the iteration
  // here cross-checks that the fields the type promises actually exist
  // at runtime (catches edge cases where parseSensorManifest emits empty
  // string for a field rather than the typed shape).
  // type-coverage:ignore-next-line — typed-to-record widening for runtime field iteration
  const objAsRecord: Record<string, unknown> = obj as unknown as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj) || objAsRecord[field] === undefined) {
      throw new Error(`${file}: missing required field: ${field}`);
    }
  }

  requireNonEmptyString(obj, "id", file);
  if (obj.id !== filenameId) {
    throw new Error(
      `${file}: id "${obj.id}" must match filename stem "${filenameId}" ` +
        `(file should be aidlc-${obj.id}.md)`,
    );
  }

  requireExactValue(
    obj,
    "kind",
    "deterministic",
    file,
    "other kinds reserved for future releases",
  );
  requireNonEmptyString(obj, "command", file);
  requireExactValue(obj, "default_severity", "advisory", file);
  requireNonEmptyString(obj, "description", file);

  if (obj.matches !== undefined) {
    requireNonEmptyString(obj, "matches", file);
  }
}
