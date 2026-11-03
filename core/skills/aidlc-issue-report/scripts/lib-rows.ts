// Every audit row, every field, each value by its own field's rule. One rule for both sides: collect.ts shapes a
// row with `shapeValue`, and the check (lib-gate.ts) passes a written value only when the same `shapeValue`, run
// again with labels standing for themselves, writes it back unchanged (`valueOk`). The rule is per field, never one rule for every value: AI-DLC's word list holds ordinary words
// (`billing`, `user`, `table`), so a value is kept as it is only where its field can hold nothing but AI-DLC's own
// words (an event, a stage, an agent), a number or a time; a name the person chose (a Unit, an intent, a file) and
// any text someone wrote become a label, the same value the same label in one report. AI-DLC's own sentences (an
// error, a command, a "phase > unit > stage > file" context) keep their fixed text and label what was filled in.

import { HOST_TOOLS } from "./lib-shape.ts";
import { onlyLabels } from "./redact.ts";

export type RowVocab = {
  words: Set<string>;
  stages: Set<string>;
  phases: Set<string>;
  agents: Set<string>;
  scopes: Set<string>;
  sensors: Set<string>;
  hooks: Set<string>;
  tools: Set<string>;
  guards: Set<string>;
  phrases: Set<string>;
  // A name the person hid (the redaction map's `named` entries, lib-check.ts hiddenIn) stands in it: an AI-DLC field
  // name holding one is a label too.
  hidden?: (s: string) => boolean;
};

export type RowValue = string | number | string[];

// The kinds of AI-DLC's words a field is read against (lib-vocab.ts reads each from the install).
export const VOCAB_KINDS = ["stages", "phases", "agents", "scopes", "sensors", "hooks", "tools", "guards"] as const;

// The label kinds a row writes. Fixed: a field's name never becomes a kind.
export const ROW_KINDS = ["value", "text", "file", "dir", "hash", "id", "session", "field", "unit", "intent", "space"] as const;
export type RowKind = (typeof ROW_KINDS)[number];


export type Shape = {
  label(kind: RowKind, raw: string): string;
  // A Unit's or an intent's label from the redaction map, when it has one.
  known(raw: string): string | undefined;
};

type Policy =
  | "stage" | "stages" | "phase" | "scope" | "sensor" | "guard" | "agent" | "tool"
  | "enum" | "titled" | "tech" | "count"
  | "hash" | "id" | "session" | "unit" | "intent"
  | "path" | "paths" | "files" | "titles" | "context" | "command" | "engine" | "options" | "floor"
  | "sensor-state" | "plan-target" | "phase-move" | "answer-mode" | "agent-or-word" | "text";

// Fields AI-DLC writes, by what they can hold. A field not listed is read as text (a label).
const POLICY: Record<string, Policy> = {
  Stage: "stage", "Stage slug": "stage", "Current Stage": "stage", "Next Stage": "stage",
  "Stages skipped": "stages", "Stages added": "stages", Stages: "stages", "Gate Stages": "stages",
  Phase: "phase", "Lifecycle Phase": "phase", "From phase": "phase", "To phase": "phase",
  Scope: "scope", "Gate Scope": "enum",
  "Sensor ID": "sensor", Guard: "guard",
  "Agent Type": "agent", Reviewer: "agent", Agent: "agent-or-word", "Asked By": "agent-or-word",
  Tool: "tool",
  Status: "enum", Verdict: "enum", Result: "enum", Direction: "enum", Origin: "enum", "Question Kind": "enum",
  Authority: "enum", Actor: "enum", Grant: "enum", Mode: "enum", Kind: "enum", "Review Verdict Dictated": "enum",
  "State Validity": "enum", "Cap layer": "enum", "Fallback driver": "enum", Harness: "enum", Verified: "enum",
  Reopen: "enum", "Answer Mode": "answer-mode", "Project Type Source": "enum",
  Checkpoint: "titled",
  Languages: "tech", Frameworks: "tech", "Build System": "tech", "Project Type": "tech",
  "Exit Code": "count", "Duration ms": "count", Iteration: "count", "Revision count": "count", "Revision Count": "count",
  "Findings count": "count", "Rule count": "count", "Stage count": "count", "Open Decisions": "count",
  "Stages completed": "count", "Sections Written": "titles", "Sources Scanned": "files", "Directive Epoch": "hash",
  Recorded: "hash", Current: "hash", "Source Baseline": "hash", "Artifact Fingerprint": "hash", "Brief Digest": "hash",
  "Request Fingerprint": "hash", "Review Record Digest": "hash", "Review File Digest": "hash", Fingerprint: "hash",
  "Unit Source Fingerprint": "hash", "Source Fingerprint": "hash", "Request Source Fingerprint": "hash",
  "Command SHA-256": "hash", "Verification Command SHA-256": "hash", "Questions SHA-256": "hash",
  "Prompt SHA-256": "hash", "Approval Fingerprint": "hash", "Content-Hash": "hash", "Validation Basis": "hash",
  "Error Fingerprint": "hash",
  "Fire id": "id", "Message Id": "id", "Request Id": "id", "Verification Id": "id", "Candidate-ID": "id",
  Session: "session",
  Unit: "unit", "Failed Bolt": "unit",
  Intent: "intent",
  File: "path", "Output path": "path", "Review File": "path", "Review Record": "path", "Questions File": "path",
  Path: "path", "Detail path": "path", Destination: "path", "Source Listing": "path",
  Changed: "paths",
  Context: "context",
  Command: "command",
  "Plan Target": "plan-target", "Phase boundary": "phase-move",
  // What a person or an agent wrote, and records of it: a label, whatever its words.
  Request: "text", "Person Reply": "text", "User Input": "text", Feedback: "text", Reply: "text", Message: "text",
  Heading: "text", Drafts: "text", "Affirming User": "text", "Command Label": "text", Plan: "text",
  "Mandated Rules Appended": "text", "Forbidden Rules Appended": "text", "Review Finding Dispositions": "text",
  "Run floors": "text", "Asked Evidence": "text", "Approved Evidence": "text",
  Error: "engine", Details: "engine", Reason: "engine", Decision: "engine",
  Options: "options",
  "Run floor": "floor",
  "Sensor State": "sensor-state",
};
// A move's Source and Target are stages; any other Source is one of AI-DLC's words (who switched a guard, how a reply
// came) and any other Target a file.
const STAGE_ENDPOINT_EVENTS: ReadonlySet<string> = new Set(["STAGE_JUMPED"]);
function policyOf(event: string, name: string): Policy {
  if (name === "Source") return STAGE_ENDPOINT_EVENTS.has(event) ? "stage" : "enum";
  if (name === "Target") return STAGE_ENDPOINT_EVENTS.has(event) ? "stage" : "path";
  return Object.hasOwn(POLICY, name) ? POLICY[name] : "text";
}

// A field's name: AI-DLC's (listed above, or a name its tools write) stays; anything else is labelled.
const FIELD_NAME = /^[A-Z][A-Za-z0-9]*(?:[ -][A-Za-z0-9]+){0,5}$/;
export function fieldName(v: RowVocab, s: Shape, name: string): string {
  if (v.hidden?.(name)) return s.label("field", name);
  return Object.hasOwn(POLICY, name) || name === "Source" || name === "Target" || (FIELD_NAME.test(name) && v.words.has(name)) ? name : s.label("field", name);
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const COUNT = /^-?\d{1,9}$/;
// A number filled into one of AI-DLC's sentences (an iteration, a count): short, or it is a label (an order or an
// employee number reads the same).
const SHORT_NUMBER = /^\d{1,4}$/;
const TOKEN = /^(?:[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+){0,7}|[A-Z][A-Z0-9_]{1,59})$/;
const TITLED = /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,4}$/;
const EVENT = /^[A-Z][A-Z0-9_]{1,59}$/;

// The extensions a project file keeps beside its label: common ones only, so a made-up extension names nothing.
const EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonl", "md", "mdx", "txt", "yaml", "yml", "toml", "ini", "cfg",
  "py", "ipynb", "java", "kt", "kts", "scala", "go", "rs", "rb", "php", "cs", "fs", "vb", "c", "h", "cc", "cpp", "hpp",
  "m", "mm", "swift", "dart", "lua", "r", "sql", "graphql", "proto", "html", "htm", "css", "scss", "sass", "less",
  "vue", "svelte", "astro", "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "xml", "gradle", "properties", "lock",
  "tf", "tfvars", "hcl", "dockerfile", "env", "csv", "tsv", "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "pdf",
  "drawio", "puml", "mermaid", "mmd", "zip", "gz", "tar", "log",
]);
// AI-DLC's own folders inside `aidlc/` (spaces/<space>/intents/<intent>/<phase>/<unit>/…).
const RECORD_DIRS = new Set([
  "aidlc", "spaces", "intents", "audit", "verification", "knowledge", "memory", "diagnostics", "sessions", "plans",
  "reviews", "questions", "construction", "inception", "ideation", "operation", "initialization", "phases", "active-memory",
  "issue-reports", "learnings", "units", "bolts", "artifacts", "requests", ".aidlc-engine", "stage", "unit", "sensors",
]);
// The AI tools' own folders at the project's top (`.kiro/steering/`), and the folders under them they name.
const TOOL_TOP = new Set([".claude", ".kiro", ".codex", ".copilot", ".cursor", ".agents", ".aidlc", ".github", ".vscode"]);
const TOOL_SUB = new Set(["settings", "steering", "skills", "prompts", "agents", "hooks", "tools", "rules", "commands", "data", "aidlc-common"]);
// The default space AI-DLC makes; any other space is named by the person.
const DEFAULT_SPACE = "default";

function typed(v: RowVocab, word: string): boolean {
  return v.stages.has(word) || v.phases.has(word) || v.agents.has(word) || v.sensors.has(word) || v.hooks.has(word) ||
    v.tools.has(word) || v.guards.has(word) || v.scopes.has(word) || (EVENT.test(word) && v.words.has(word));
}

function extensionOf(name: string): string | null {
  const m = name.match(/\.([A-Za-z0-9]{1,12})$/);
  return m && EXTENSIONS.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}

function fileLabel(s: Shape, rel: string): string {
  // What this rule wrote already (`<custom-file-3>.ts`) is written again the same way.
  const own = rel.match(/^(<[^<>/]+>)(?:\.([a-z0-9]{1,12}))?$/);
  if (own) return `${s.label("file", own[1])}${own[2] && EXTENSIONS.has(own[2]) ? `.${own[2]}` : ""}`;
  const base = rel.split("/").pop() ?? rel;
  const ext = extensionOf(base);
  return `${s.label("file", rel)}${ext ? `.${ext}` : ""}`;
}

// A path. Inside `aidlc/`, an intent's `.aidlc-engine/` and an AI tool's folder (`.kiro/steering/`), AI-DLC's and
// the tool's own layout stays (their folders, a stage's or a phase's name, an artifact AI-DLC names) and the person's
// names in it are labelled (a space other than the default, the intent, a Unit), a hex folder or digest is a hash
// label; anywhere else the file is `<custom-file-N>` with a common extension. An absolute path or one outside the
// project is one label.
function layoutSegment(v: RowVocab, s: Shape, parts: string[], i: number, last: boolean): string {
  const part = parts[i];
  const prev = parts[i - 1];
  if (prev === "spaces") return part === DEFAULT_SPACE ? part : s.known(part) ?? s.label("space", part);
  if (prev === "intents" && part !== "audit") return s.known(part) ?? s.label("intent", part);
  if (RECORD_DIRS.has(part) || TOOL_TOP.has(part) || TOOL_SUB.has(part) || v.stages.has(part) || v.phases.has(part)) return part;
  if (/^[0-9a-f]{8,64}$/.test(part)) return s.label("hash", part);
  const review = part.match(/^(\d{1,6})\.([0-9a-f]{8,64}|<[^<>]+>)\.review\.md$/);
  if (review) return `${review[1]}.${s.label("hash", review[2])}.review.md`;
  // A file AI-DLC names (`requirements.md`, `.aidlc-request-text`) stays. A Unit's or an intent's name gets its label
  // wherever it stands. Any other name before the last is a folder (`<custom-dir-N>`, by its own text); the last is a
  // file, labelled by its whole path with its common extension kept (a path ending in `/` is a folder's). A label
  // already there is the rule's own.
  if (last && (((extensionOf(part) || part.startsWith(".")) && v.words.has(part)) || /^\d{1,6}\.json$/.test(part) || /^[0-9a-f]{12}-[0-9a-f]{12}\.md$/.test(part))) return part;
  const known = s.known(part);
  if (known) return known;
  if (!last) return s.label("dir", part);
  return fileLabel(s, /^<[^<>/]+>(?:\.[a-z0-9]{1,12})?$/.test(part) ? part : parts.slice(0, i + 1).join("/"));
}
const inLayout = (first: string) => first === "aidlc" || first === ".aidlc-engine" || TOOL_TOP.has(first);
function shapePath(v: RowVocab, s: Shape, raw: string): string {
  let p = raw.trim().replaceAll("\\", "/");
  let lead = "";
  const placeholder = p.match(/^<project(?:-dir)?>\//);
  if (placeholder) {
    lead = "<project>/";
    p = p.slice(placeholder[0].length);
  }
  if (p.startsWith("./")) p = p.slice(2);
  if (!p || /^[a-zA-Z]:\//.test(p) || p.startsWith("/") || p.startsWith("~") || p.split("/").includes("..") || /:\/\//.test(p)) {
    return s.label("file", raw);
  }
  const trailing = p.endsWith("/") ? "/" : "";
  const parts = p.replace(/\/+$/, "").split("/");
  if (!inLayout(parts[0])) return lead + fileLabel(s, p.replace(/\/+$/, "")) + trailing;
  return lead + parts.map((_, i) => layoutSegment(v, s, parts, i, i === parts.length - 1 && !trailing)).join("/") + trailing;
}
// Small words AI-DLC's sentences join their fixed parts with; they name nothing.
const JOINERS = new Set([
  "a", "an", "the", "for", "in", "of", "on", "to", "at", "by", "from", "with", "and", "or", "is", "are", "was", "be",
  "it", "its", "this", "that", "no", "not", "as", "into", "after", "before", "than", "then", "has", "have", "per",
]);
const PUNCT = /^[\s"'`.,;:!?()[\]{}<>=+*/|&#%@~^-]*$/;

// AI-DLC's own sentence: its fixed text (a phrase from the installed tools) with what was filled in shaped one piece
// at a time. null when the value is not one: less than half of it is fixed text, or it does not start with one.
// A label is what the rule wrote for a filled-in piece: it counts neither as text to cover nor before the first fixed part,
// so the value the rule wrote reads the same way again.
const LABEL_TOKEN = /<[a-z][a-z0-9:-]{0,40}>/g;
function covered(v: RowVocab, value: string): [number, number][] | null {
  if (value.length < 16) return null;
  const spans: [number, number][] = [];
  for (const ph of v.phrases) {
    let at = value.indexOf(ph);
    while (at >= 0) {
      spans.push([at, at + ph.length]);
      at = value.indexOf(ph, at + 1);
    }
  }
  if (spans.length === 0) return null;
  // Longest first, then keep the ones that do not overlap.
  spans.sort((a, b) => b[1] - b[0] - (a[1] - a[0]) || a[0] - b[0]);
  const kept: [number, number][] = [];
  for (const sp of spans) if (!kept.some((k) => sp[0] < k[1] && k[0] < sp[1])) kept.push(sp);
  kept.sort((a, b) => a[0] - b[0]);
  const fixed = kept.reduce((n, [a, b]) => n + (b - a), 0);
  const text = value.replace(LABEL_TOKEN, "").replace(/\s+/g, "");
  if (value.slice(0, kept[0][0]).replace(LABEL_TOKEN, "").length > 2 || fixed * 2 < text.length) return null;
  return kept;
}
// A filled-in stretch, one piece at a time; a label (`<id:…>` too) stays one piece.
function gapPieces(gap: string): string[] {
  return gap.match(/<[a-z][a-z0-9:-]{0,40}>(?:\.[a-z0-9]{1,12})?|\s+|["'`(),;:]+|[^\s"'`(),;:<]+|</g) ?? [];
}
function shapeGapPiece(v: RowVocab, s: Shape, piece: string): string {
  if (PUNCT.test(piece) || JOINERS.has(piece.toLowerCase()) || SHORT_NUMBER.test(piece) || typed(v, piece)) return piece;
  if (piece.includes("/") || extensionOf(piece)) return shapePath(v, s, piece);
  return s.known(piece) ?? s.label("value", piece);
}
function splitAt(value: string, spans: [number, number][]): { gaps: string[]; fixed: string[] } {
  const gaps: string[] = [];
  const fixed: string[] = [];
  let at = 0;
  for (const [a, b] of spans) {
    gaps.push(value.slice(at, a));
    fixed.push(value.slice(a, b));
    at = b;
  }
  gaps.push(value.slice(at));
  return { gaps, fixed };
}
function shapeEngine(v: RowVocab, s: Shape, value: string): string {
  if ((value.includes(" ") && v.words.has(value)) || ANSWERS.test(value)) return value;
  const spans = covered(v, value);
  if (!spans) return s.label("text", value);
  const { gaps, fixed } = splitAt(value, spans);
  return gaps.map((g, i) => gapPieces(g).map((p) => shapeGapPiece(v, s, p)).join("") + (fixed[i] ?? "")).join("");
}
// A question's answers as AI-DLC records them: `Q1: A; Q2: B,C`, `Q1, Q2, Q3`.
const ANSWERS = /^Q\d{1,3}(?::\s?[A-Z](?:,[A-Z]){0,9})?(?:[;,]\s?Q\d{1,3}(?::\s?[A-Z](?:,[A-Z]){0,9})?){0,40}$/;
// The few one-word choices AI-DLC's own gates offer; any other one-word option is the agent's text.
const GATE_WORDS = new Set(["Approve", "Reject", "Skip", "Chat", "Continue", "Stop", "Yes", "No", "Other", "None"]);
function optionOk(v: RowVocab, o: string): boolean {
  return GATE_WORDS.has(o) || (o.includes(" ") && v.words.has(o)) || typed(v, o);
}

// An enumeration's value: one word (`in-progress`, `APPROVED`) or a few lower-case words AI-DLC writes (`workspace scan`).
function enumOk(v: RowVocab, value: string): boolean {
  return (TOKEN.test(value) || /^[a-z]+(?: [a-z]+){1,3}$/.test(value)) && v.words.has(value);
}
function list(value: string): string[] {
  return value.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
}

export function shapeValue(v: RowVocab, s: Shape, event: string, name: string, raw: string): RowValue {
  const value = raw.trim();
  const pick = (ok: boolean, kind: RowKind = "value") => (ok ? value : s.label(kind, value));
  switch (policyOf(event, name)) {
    case "stage":
      return pick(v.stages.has(value));
    case "stages":
      return value === "none" ? value : list(value).map((x) => (v.stages.has(x) ? x : s.label("value", x)));
    case "phase":
      return pick(v.phases.has(value));
    case "scope":
      return pick(v.scopes.has(value) || enumOk(v, value));
    case "sensor":
      return pick(v.sensors.has(value));
    case "guard":
      return pick(v.guards.has(value) || v.hooks.has(value));
    case "agent":
      return pick(v.agents.has(value));
    case "tool":
      return pick(typed(v, value) || HOST_TOOLS.has(value));
    case "enum":
      return pick(enumOk(v, value));
    case "titled":
      return pick((enumOk(v, value) || TITLED.test(value)) && v.words.has(value));
    case "tech":
      return list(value).map((x) => (/^[A-Za-z][A-Za-z0-9.+#-]{0,30}$/.test(x) && v.words.has(x) ? x : s.label("value", x)));
    case "count":
      return COUNT.test(value) ? Number(value) : s.label("value", value);
    case "hash":
      return s.label("hash", value);
    case "id":
      return s.label("id", value);
    case "session":
      return s.label("session", value);
    case "unit":
      return s.known(value) ?? s.label("unit", value);
    case "intent":
      return s.known(value) ?? s.label("intent", value);
    case "path":
      return shapePath(v, s, value);
    case "paths": {
      const more = value.match(/^(.*) \(and (\d{1,6}) more\)$/);
      const paths = list(more ? more[1] : value);
      // Always a list: one that is not a list of paths is a list of one label.
      if (paths.some((p) => /\s/.test(p))) return [s.label("text", value)];
      const shaped = paths.map((p) => shapePath(v, s, p));
      return more ? [...shaped, `(and ${more[2]} more)`] : shaped;
    }
    case "context":
      return value.split(" > ").map((part, i, all) =>
        v.phases.has(part) || v.stages.has(part) || (i === all.length - 1 && extensionOf(part) && v.words.has(part))
          ? part
          : i === all.length - 1 && extensionOf(part)
            ? fileLabel(s, part)
            : s.known(part) ?? s.label("unit", part)).join(" > ");
    case "command":
      return shapeCommand(v, s, value);
    case "engine":
      return shapeEngine(v, s, value);
    case "options":
      return value.split(/\s*[,;]\s*/).filter(Boolean).map((o) => (ANSWERS.test(o) || /^[A-Z]$/.test(o) || optionOk(v, o) ? o : s.label("text", o)));
    case "floor": {
      const m = value.match(/^([A-Z][A-Z0-9_]{1,59}):([0-9T:.\-Z+]{10,35})#(\d{1,6})$/);
      return m && v.words.has(m[1]) && TIME.test(m[2]) ? value : s.label("text", value);
    }
    case "sensor-state":
      return shapeSensorState(v, s, value);
    case "plan-target": {
      const m = value.match(/^unit:(.+)$/);
      return m ? `unit:${s.known(m[1]) ?? s.label("unit", m[1])}` : pick(v.stages.has(value));
    }
    case "phase-move": {
      const m = value.match(/^([a-z-]+) → ([a-z-]+)$/);
      return pick(!!m && v.phases.has(m[1]) && v.phases.has(m[2]));
    }
    case "answer-mode": {
      const m = value.match(/^([a-z][a-z-]{0,30})(?: \(reused from ([a-z][a-z0-9-]{0,60})\))?$/);
      return pick(!!m && v.words.has(m[1]) && (!m[2] || v.stages.has(m[2])));
    }
    case "agent-or-word":
      return pick(v.agents.has(value) || (TOKEN.test(value) && v.words.has(value)));
    case "files":
      return list(value).map((x) => (v.words.has(x) && (extensionOf(x) || /^[a-z][a-z ]{2,40}$/.test(x)) ? x : extensionOf(x) ? fileLabel(s, x) : s.label("text", x)));
    case "titles":
      return list(value).map((x) => (TITLED.test(x) || /^[A-Z][a-z]+(?: [a-z]+){1,4}$/.test(x)) && v.words.has(x) ? x : s.label("text", x));
    default:
      return s.label("text", value);
  }
}

// A gate's checks as AI-DLC writes them (aidlc-state.ts sensorStateAtGate): `none`, or `<check>@<path>=<result>` with an
// optional ` [detail: <path>]`, entries joined by `; `, a last `+N more`. Each entry keeps its check, result and the
// layout of its paths; a value of any other shape is one label.
const SENSOR_ENTRY = /^([a-z][a-z0-9-]{0,40}|<[a-z][a-z0-9:-]{0,40}>)@(.+?)=(passed|not-run|could-not-run|failed\(\d{1,6}\))(?: \[detail: (.+)\])?$/;
function shapeSensorState(v: RowVocab, s: Shape, value: string): string {
  if (value === "none") return value;
  const shaped: string[] = [];
  for (const entry of value.split("; ")) {
    if (/^\+\d{1,6} more$/.test(entry)) {
      shaped.push(entry);
      continue;
    }
    const m = entry.match(SENSOR_ENTRY);
    if (!m || (m[1].startsWith("<") && !onlyLabels(m[1]))) return s.label("text", value);
    const check = v.sensors.has(m[1]) ? m[1] : s.label("value", m[1]);
    shaped.push(`${check}@${shapePath(v, s, m[2])}=${m[3]}${m[4] ? ` [detail: ${shapePath(v, s, m[4])}]` : ""}`);
  }
  return shaped.join("; ");
}

// `--stage <stage>`, `--unit <Unit>`: a flag's value by the flag; a bare word only when it is AI-DLC's command or a
// stage, phase, agent or tool name; a quoted value is text.
const FLAG_KIND: Record<string, "stage" | "unit" | "intent" | "agent" | "phase" | "path"> = {
  stage: "stage", unit: "unit", intent: "intent", reviewer: "agent", agent: "agent", phase: "phase", file: "path",
  path: "path", out: "path",
};
function commandPieces(value: string): string[] {
  return value.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
}
// Only a command line of AI-DLC's own tools is read piece by piece; any other command is the person's or the agent's.
// The first word is AI-DLC's own command (one of the install's tools, or `aidlc` itself) and stays as it is.
const AIDLC_SELF = new Set(["aidlc", "aidlc.ts", "aidlc.exe", "aidlc.cmd"]);
const aidlcCommand = (v: RowVocab, first: string | undefined) => !!first && (v.tools.has(first) || AIDLC_SELF.has(first));
function shapeCommand(v: RowVocab, s: Shape, value: string): string {
  const pieces = commandPieces(value);
  if (!aidlcCommand(v, pieces[0])) return s.label("text", value);
  const out: string[] = [pieces[0]];
  for (const [i, piece] of pieces.entries()) {
    if (i === 0) continue;
    const flag = piece.match(/^--?([a-z][a-z0-9-]{0,40})(?:=(.*))?$/);
    if (flag) {
      const known = v.words.has(flag[1]) || Object.hasOwn(FLAG_KIND, flag[1]);
      const name = piece.slice(0, piece.length - (flag[2] !== undefined ? flag[2].length + 1 : 0));
      out.push(!known ? s.label("value", piece) : flag[2] !== undefined ? `${name}=${flagValue(v, s, flag[1], flag[2])}` : name);
      continue;
    }
    const before = pieces[i - 1]?.match(/^--?([a-z][a-z0-9-]{0,40})$/);
    if (before && Object.hasOwn(FLAG_KIND, before[1])) out.push(flagValue(v, s, before[1], piece));
    else if (/^["']/.test(piece)) out.push(s.label("text", piece));
    else if (typed(v, piece) || (TOKEN.test(piece) && v.words.has(piece)) || choices(v, piece)) out.push(piece);
    else out.push(s.label("value", piece));
  }
  return out.join(" ");
}
function flagValue(v: RowVocab, s: Shape, flag: string, raw: string): string {
  const kind = FLAG_KIND[flag];
  if (kind === "stage") return v.stages.has(raw) ? raw : s.label("value", raw);
  if (kind === "phase") return v.phases.has(raw) ? raw : s.label("value", raw);
  if (kind === "agent") return v.agents.has(raw) ? raw : s.label("value", raw);
  if (kind === "unit" || kind === "intent") return s.known(raw) ?? s.label(kind, raw);
  if (kind === "path") return shapePath(v, s, raw);
  return typed(v, raw) ? raw : s.label("value", raw);
}
// A usage line's choices (`<start|pause|resume>`): each one AI-DLC's word.
function choices(v: RowVocab, piece: string): boolean {
  const m = piece.match(/^<([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)>$/);
  return !!m && m[1].split("|").every((w) => v.words.has(w));
}
// The check: the value the rule writes when it reads this written value again, with every label standing for itself
// and anything else refused. A label the rule wrote, or the redaction wrote over a kept value, comes back as it was; a
// raw value (a Unit's name, a reply, a project path, an id) does not.
function asWritten(): Shape & { refused: boolean } {
  const s = {
    refused: false,
    label: (_kind: RowKind, raw: string) => {
      if (!onlyLabels(raw)) s.refused = true;
      return raw;
    },
    known: () => undefined,
  };
  return s;
}
export function fieldNameOk(v: RowVocab, name: string): boolean {
  const s = asWritten();
  return fieldName(v, s, name) === name && !s.refused;
}
export function valueOk(v: RowVocab, event: string, name: string, value: unknown): boolean {
  let raw: string;
  if (typeof value === "number") raw = String(value);
  else if (typeof value === "string") raw = value;
  else if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
    const more = value.length > 0 && /^\(and \d{1,6} more\)$/.test(value[value.length - 1]);
    raw = more ? `${value.slice(0, -1).join(", ")} ${value[value.length - 1]}` : value.join(", ");
  } else return false;
  const s = asWritten();
  const again = shapeValue(v, s, event, name, raw);
  return !s.refused && JSON.stringify(again) === JSON.stringify(value);
}
