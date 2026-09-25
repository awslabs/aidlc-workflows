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
//   - default_severity: enum        — required; "advisory" | "blocking"
//   - description: string           — required; one-line capability summary
//   - category: string              — optional grouping label
//   - fire_on: enum                  — optional; "write" | "gate" (default write)
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
  default_severity: "advisory" | "blocking";
  description: string;
  category?: string;
  fire_on: "write" | "gate";
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
  const fireOn = scalarField(fm, "fire_on");
  obj.fire_on = fireOn === "" ? "write" : fireOn;
  const matches = scalarField(fm, "matches");
  if (matches !== "") obj.matches = matches;
  const timeout = scalarField(fm, "timeout_seconds");
  if (timeout !== "") {
    const n = parseInt(timeout, 10);
    if (!Number.isNaN(n)) obj.timeout_seconds = n;
  }
  // The declared invocation contract. Only the key SET is read: the values are
  // type hints nothing consumes, while the dispatcher routes a sensor's path
  // argument on which key it declares (file_path vs output_path).
  const inputSchema = mappingKeys(fm, "input_schema");
  if (inputSchema) obj.input_schema = inputSchema;

  // Cast-through-unknown: obj is Record<string, unknown> with the
  // shape of a SensorManifest by construction (we wrote each known
  // scalar above) but no index-signature/structural overlap exists at
  // the type level. validateSensorManifest() runs immediately after
  // and throws on any field that's actually missing.
  // type-coverage:ignore-next-line — documented parseSensorManifest trust boundary
  return obj as unknown as SensorManifest;
}

// Helper: the top-level keys of a nested `<field>:` mapping in the
// frontmatter, in declaration order. Reads both shapes an author can write:
// the block form (keys indented under `<field>:`) and the one-line flow form
// (`<field>: { a: x, b: y }`). A key may be quoted, and a trailing `# comment`
// is ignored on any line, including the header. A declaration that yields no
// keys (`{}`) reads the same as no declaration.
function mappingKeys(fm: string, field: string): Record<string, string> | undefined {
  const lines = fm.split(/\r?\n/);
  const headRe = new RegExp(`^${field}[ \\t]*:(.*)$`);
  const head = lines.findIndex((line) => headRe.test(line));
  if (head < 0) return undefined;
  // What follows the header's colon: nothing for the block form, `{...}` for
  // the flow form. Anything else is not a mapping and declares no keys.
  const inline = stripYamlComment(lines[head].replace(headRe, "$1"));
  let parts: string[] = [];
  if (inline === "") {
    parts = blockMappingLines(lines, head + 1);
  } else if (inline.startsWith("{") && inline.endsWith("}")) {
    parts = splitFlowMapping(inline.slice(1, -1));
  }
  const entries: Record<string, string> = {};
  for (const part of parts) {
    const entry = part.match(/^(?:"([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_-]*))[ \t]*:[ \t]*(.*)$/);
    const key = entry?.[1] ?? entry?.[2] ?? entry?.[3];
    if (entry && key) entries[key] = stripYamlComment(entry[4]);
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

// Helper: the trimmed entry lines of a block mapping that starts at `start`.
// Blank and comment lines are skipped wherever they sit, deeper nesting (a
// list of objects under one of the keys) belongs to the key above it, and the
// block ends at the next unindented line.
function blockMappingLines(lines: string[], start: number): string[] {
  const out: string[] = [];
  let indent: number | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const width = line.length - line.trimStart().length;
    if (width === 0) break;
    if (indent === null) indent = width;
    if (width === indent) out.push(text);
  }
  return out;
}

// Helper: split a flow mapping's body on its top-level commas, so a nested
// `{...}` or `[...]` value stays with its key.
function splitFlowMapping(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts;
}

// Helper: drop a YAML comment (a `#` at the start or after whitespace) and trim.
function stripYamlComment(text: string): string {
  return text.replace(/(^|[ \t])#.*$/, "").trim();
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

// Helper: throw if obj[field] !== expected. Optional `hint` appends a trailing
// clause to the thrown message (e.g., "; other kinds reserved for future releases").
function requireExactValue<K extends "kind">(
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

function requireEnumValue<K extends "default_severity" | "fire_on">(
  obj: SensorManifest,
  field: K,
  allowed: readonly SensorManifest[K][],
  file: string,
): void {
  if (!allowed.includes(obj[field])) {
    throw new Error(
      `${file}: ${field} must be one of: ${allowed.map((v) => `"${v}"`).join(", ")} ` +
        `(got "${obj[field]}")`,
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
  requireEnumValue(
    obj,
    "default_severity",
    ["advisory", "blocking"],
    file,
  );
  requireEnumValue(obj, "fire_on", ["write", "gate"], file);
  requireNonEmptyString(obj, "description", file);

  if (obj.matches !== undefined) {
    requireNonEmptyString(obj, "matches", file);
  }
}
