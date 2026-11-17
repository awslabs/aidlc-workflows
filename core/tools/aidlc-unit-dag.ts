// The Unit DAG's grammar, one parser: the fenced yaml `units:` block of
// inception/units-generation/unit-of-work-dependency.md (Units Generation writes
// it), read into its Units, their kinds and dependencies, and the topological
// batches Construction walks; and the Unit name rule the block, the compiled
// graph and the lifecycle commands share. aidlc-lib.ts and
// aidlc-review-records.ts re-export these names, so their callers are
// unchanged. Nothing here imports another module: the status line hook reads
// the Units through it on every render.

// New workflows author lowercase kebab-case names, but pre-lifecycle DAGs
// accepted other filesystem-safe names. Keep those existing identifiers
// routable while still excluding separators, traversal, whitespace, and
// control characters.
export const UNIT_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const UNIT_NAME_MAX_LENGTH = 64;

// Unit names become path components under construction/<unit>/ and are also
// mirrored into single-line state fields. Keep one canonical validator for the
// authored DAG, cached runtime graph, and lifecycle CLI. Lowercase kebab-case is
// the authoring convention; leading digits, uppercase letters, underscores,
// and dots remain accepted for safe legacy DAG names.
export function validateUnitName(name: string): string | null {
  if (!name) return "Unit name is empty";
  if (name.length > UNIT_NAME_MAX_LENGTH) {
    return `Unit name "${name.slice(0, 32)}..." is ${name.length} chars; max is ${UNIT_NAME_MAX_LENGTH}`;
  }
  if (!UNIT_NAME_REGEX.test(name)) {
    return (
      `Invalid Unit name "${name}" - must match ${UNIT_NAME_REGEX} ` +
      "(ASCII letter/digit, then ASCII letters/digits/dot/underscore/hyphen)"
    );
  }
  return null;
}

// The unit-kind enum: what a Unit of Work IS, so the engine can prune the
// per-unit construction design matrix to the artifacts that actually apply.
// A spec unit owes no scalability doc, a packaging unit no business-logic
// model. Authored once at the 2.7 gate on the units-generation edge block and
// confirmed by the human; consumed by the stage-schema validator (which shares
// this constant) and the engine's produces filter. Missing kind = full matrix
// (conservative default, zero behaviour change for untagged units).
export const UNIT_KINDS = ["service", "spec", "ui", "packaging", "library"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export interface UnitDependencyEdge {
  name: string;
  depends_on: string[];
  // Optional per-unit kind (UNIT_KINDS). Absent = full design-artifact matrix.
  kind?: UnitKind;
}

// Discriminated result so the two consumers (the required-sections sensor's
// gate-time validation and aidlc-runtime compile's DAG emission) branch on
// one single source of truth:
//   - absent    : no fenced ```yaml units: block in the body
//   - malformed : block present but structurally invalid (duplicate name,
//                 dangling dependency, self-dependency, non-list value, no units)
//   - cyclic    : structurally valid edges that contain a dependency cycle
//   - ok        : units + batches (topological levels; each level sorted
//                 lexicographically; units with satisfied, non-mutual deps
//                 share a batch)
export type BoltDagParse =
  | { ok: true; units: UnitDependencyEdge[]; batches: string[][] }
  | { ok: false; reason: "absent" | "malformed" | "cyclic"; detail: string };

// Locate the first fenced ```yaml block whose body declares a top-level
// `units:` key. Returns the inner block text, or null when no such fence
// exists. Other fenced blocks (mermaid diagrams, prose examples) are skipped.
function extractYamlUnitsBlock(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^```ya?ml\s*$/.test(lines[i].trim())) {
      const inner: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j].trim())) break;
        inner.push(lines[j]);
      }
      const block = inner.join("\n");
      if (/^\s*units\s*:/m.test(block)) {
        return block;
      }
      i = j; // not the units block: resume scanning past its close fence
    }
  }
  return null;
}

function unquoteScalar(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseInlineDepsList(raw: string): string[] {
  const t = raw.trim();
  if (t === "" || t === "[]") return [];
  if (t.startsWith("[")) {
    let close = -1;
    let quote: "\"" | "'" | null = null;
    for (let i = 1; i < t.length; i++) {
      const char = t[i];
      if (quote !== null) {
        if (quote === "\"" && char === "\\") {
          i++;
        } else if (char === quote) {
          quote = null;
        }
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (char === "]") {
        close = i;
        break;
      }
    }
    if (quote !== null || close === -1) return [];
    if (!/^[ \t]*(?:#[^\r\n]*)?$/.test(t.slice(close + 1))) return [];

    const body = t.slice(1, close);
    const items: string[] = [];
    let start = 0;
    quote = null;
    for (let i = 0; i < body.length; i++) {
      const char = body[i];
      if (quote !== null) {
        if (quote === "\"" && char === "\\") {
          i++;
        } else if (char === quote) {
          quote = null;
        }
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (char === ",") {
        items.push(body.slice(start, i));
        start = i + 1;
      }
    }
    if (quote !== null) return [];
    items.push(body.slice(start));
    return items.map((item) => unquoteScalar(item)).filter((item) => item !== "");
  }
  // Bare scalar (rare): treat as a one-item list.
  return [unquoteScalar(t)];
}

// Hand-rolled zero-dep scanner for the `units:` block list. Mirrors the
// scalarField / listField primitives in aidlc-lib.ts (the framework ships no
// YAML dependency). Throws on a structurally unparseable block; the caller maps
// the throw to a `malformed` result.
function parseUnitsBlock(block: string): UnitDependencyEdge[] {
  const lines = block.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^\s*units\s*:/.test(lines[i])) {
      const after = lines[i].replace(/^\s*units\s*:/, "").trim();
      if (after !== "") {
        throw new Error("units: must be a block list, not an inline value");
      }
      break;
    }
  }
  if (i >= lines.length) throw new Error("missing units: key");
  i++; // step past the `units:` line

  const edges: UnitDependencyEdge[] = [];
  let current: UnitDependencyEdge | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const nameMatch = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
    if (nameMatch) {
      if (current) edges.push(current);
      current = { name: unquoteScalar(nameMatch[1]), depends_on: [] };
      continue;
    }

    const depMatch = line.match(/^\s*depends_on\s*:\s*(.*)$/);
    if (depMatch) {
      if (!current) throw new Error("depends_on: before any - name: entry");
      current.depends_on = parseInlineDepsList(depMatch[1]);
      continue;
    }

    // Optional per-unit kind. Mirrors the depends_on guard: a kind: line
    // before any - name: is malformed. The value must be one of UNIT_KINDS;
    // a typo fails loud here (mapped to reason "malformed" by parseBoltDag)
    // rather than silently falling back to the full matrix. Last-write-wins
    // on a duplicate kind: line, matching depends_on:'s posture.
    const kindMatch = line.match(/^\s*kind\s*:\s*(.+?)\s*$/);
    if (kindMatch) {
      if (!current) throw new Error("kind: before any - name: entry");
      const value = unquoteScalar(kindMatch[1]);
      if (!(UNIT_KINDS as readonly string[]).includes(value)) {
        throw new Error(
          `unit "${current.name}" has invalid kind "${value}" ` +
            `(expected ${UNIT_KINDS.join("|")})`
        );
      }
      current.kind = value as UnitKind;
      continue;
    }

    // Block-form dependency item (a bare `- dep` under `depends_on:`).
    const itemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (itemMatch && current) {
      current.depends_on.push(unquoteScalar(itemMatch[1]));
      continue;
    }

    throw new Error(`unrecognised line in units block: ${line.trim()}`);
  }
  if (current) edges.push(current);

  for (const e of edges) {
    const nameError = validateUnitName(e.name);
    if (nameError) throw new Error(nameError);
  }
  return edges;
}

// Kahn's algorithm by level. Each level is a batch: the units whose
// dependencies are all already placed (satisfied, non-mutual). Levels are
// sorted lexicographically before emission so the output is deterministic
// regardless of input order or Set iteration order. Returns null when a
// cycle remains (no unit has all dependencies satisfied).
function computeBatches(edges: UnitDependencyEdge[]): string[][] | null {
  const deps = new Map<string, string[]>();
  for (const e of edges) deps.set(e.name, e.depends_on);
  const remaining = new Set(edges.map((e) => e.name));
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const level: string[] = [];
    for (const name of remaining) {
      const satisfied = deps.get(name)!.every((dep) => !remaining.has(dep));
      if (satisfied) level.push(name);
    }
    if (level.length === 0) return null; // cycle
    level.sort();
    for (const name of level) remaining.delete(name);
    batches.push(level);
  }
  return batches;
}

// Parse the required fenced ```yaml edge block out of a
// unit-of-work-dependency.md body and compute the topological batch DAG.
//
// The block shape, authored once at the 2.7 gate (knowledge work by the
// LLM, behind a human approval gate):
//
//   ```yaml
//   units:
//     - name: auth
//       kind: service
//       depends_on: []
//     - name: api
//       depends_on: [auth]
//   ```
//
// The optional `kind:` line (UNIT_KINDS) drives the per-unit construction
// design-artifact pruning; omitting it keeps a unit on the full matrix.
//
// Pure data: no model call, no NLP. A given body always parses to the same
// result, so a hook-fired re-compile of runtime-graph.json stays
// byte-identical (no model in the path; the determinism invariant holds).
export function parseBoltDag(body: string): BoltDagParse {
  const block = extractYamlUnitsBlock(body);
  if (block === null) {
    return {
      ok: false,
      reason: "absent",
      detail: "no fenced ```yaml units: block found",
    };
  }

  let edges: UnitDependencyEdge[];
  try {
    edges = parseUnitsBlock(block);
  } catch (e) {
    // parseUnitsBlock throws only Errors of its own.
    return { ok: false, reason: "malformed", detail: (e as Error).message };
  }

  if (edges.length === 0) {
    return { ok: false, reason: "malformed", detail: "units: block has no entries" };
  }

  const names = new Set<string>();
  const foldedNames = new Map<string, string>();
  for (const u of edges) {
    if (names.has(u.name)) {
      return { ok: false, reason: "malformed", detail: `duplicate unit name: ${u.name}` };
    }
    names.add(u.name);
    const folded = u.name.toLowerCase();
    const existing = foldedNames.get(folded);
    if (existing !== undefined && existing !== u.name) {
      return {
        ok: false,
        reason: "malformed",
        detail: `case-folding unit name collision: "${existing}" and "${u.name}"`,
      };
    }
    foldedNames.set(folded, u.name);
  }
  for (const u of edges) {
    for (const dep of u.depends_on) {
      if (dep === u.name) {
        return { ok: false, reason: "malformed", detail: `unit "${u.name}" depends on itself` };
      }
      if (!names.has(dep)) {
        return {
          ok: false,
          reason: "malformed",
          detail: `unit "${u.name}" depends on unknown unit "${dep}"`,
        };
      }
    }
  }

  const batches = computeBatches(edges);
  if (batches === null) {
    return { ok: false, reason: "cyclic", detail: "dependency cycle detected" };
  }
  return { ok: true, units: edges, batches };
}
