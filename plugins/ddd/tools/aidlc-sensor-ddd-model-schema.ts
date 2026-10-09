// aidlc-sensor-ddd-model-schema.ts — BLOCKING model-schema sensor (ddd plugin).
//
// Deterministically validates a `ddd-domain-model.md` artifact against the plugin's normative schema
// (knowledge/aidlc-architect-agent/ddd-model-and-rule-schema.md, "Frontmatter schema" table). Fires at
// the `ddd-domain-modeling` gate; a failure holds the gate until the frontmatter conforms.
//
// Why this exists: the modeling stage is an LLM authoring step. Without a deterministic check, a model
// can silently omit fields the `ddd-conformance` compiler depends on (the `aggregate:` citation on
// events and invariants, the `on` transition key, a declared context for every ID prefix) and still be
// approved. That exact drift was observed in validation; this sensor makes it a gate failure.
//
// Self-contained: no import of the framework's aidlc-lib (a plugin tool ships in its own delta).
// Frontmatter is parsed with a small YAML-subset parser covering what the schema emits.
import { existsSync, readFileSync } from "node:fs";

interface Flags {
  stage?: string;
  outputPath?: string;
}
interface Finding {
  id: string;
  detail: string;
}
type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// argv / io contract (same as every deterministic sensor)
function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stage") out.stage = argv[++i];
    else if (argv[i] === "--output-path") out.outputPath = argv[++i];
  }
  return out;
}
function emit(pass: boolean, findings: Finding[], extra: Rec = {}): never {
  process.stdout.write(
    `${JSON.stringify({
      pass,
      findings_count: findings.length,
      findings: findings.map((f) => `${f.id}: ${f.detail}`),
      ...extra,
    })}\n`,
  );
  process.exit(0);
}
function passThrough(): never {
  emit(true, []);
}
function hardFail(msg: string): never {
  process.stderr.write(`aidlc-sensor-ddd-model-schema: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// YAML subset: block maps/seqs, flow {} / [], quoted + plain scalars, ints, `>`/`|` folded blocks.
interface Line {
  indent: number;
  text: string;
}
/** Strip a trailing ` # comment` that is not inside quotes. */
function stripInlineComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}
function toLines(src: string): Line[] {
  return src
    .split(/\r?\n/)
    .map((l) => stripInlineComment(l))
    .filter((l) => l.trim().length > 0)
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
}
function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  if (s.startsWith("[")) return splitTop(s.slice(1, s.lastIndexOf("]"))).map(scalar);
  if (s.startsWith("{")) {
    const obj: Rec = {};
    for (const pair of splitTop(s.slice(1, s.lastIndexOf("}")))) {
      const i = pair.indexOf(":");
      obj[pair.slice(0, i).trim()] = scalar(pair.slice(i + 1));
    }
    return obj;
  }
  return s;
}
function splitKey(text: string): [string, string] | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":" && (i + 1 === text.length || text[i + 1] === " ")) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}
class Parser {
  private i = 0;
  constructor(private readonly lines: Line[]) {}
  parse(): unknown {
    return this.lines.length ? this.block(this.lines[0].indent) : {};
  }
  private peek(): Line | undefined {
    return this.lines[this.i];
  }
  private block(indent: number): unknown {
    const first = this.peek();
    if (!first) return null;
    return first.text.startsWith("- ") || first.text === "-" ? this.seq(indent) : this.map(indent);
  }
  private folded(indent: number): string {
    const parts: string[] = [];
    while (this.peek() && (this.peek() as Line).indent > indent) parts.push(this.lines[this.i++].text);
    return parts.join(" ");
  }
  private map(indent: number): Rec {
    const obj: Rec = {};
    while (this.peek() && (this.peek() as Line).indent === indent && !(this.peek() as Line).text.startsWith("- ")) {
      const line = this.lines[this.i];
      const kv = splitKey(line.text);
      if (!kv) throw new Error(`cannot parse mapping line "${line.text}"`);
      const [key, rest] = kv;
      this.i++;
      if (rest === ">" || rest === "|") obj[key] = this.folded(indent);
      else if (rest === "") {
        const next = this.peek();
        obj[key] = next && next.indent > indent ? this.block(next.indent) : null;
      } else obj[key] = scalar(rest);
    }
    return obj;
  }
  private seq(indent: number): unknown[] {
    const arr: unknown[] = [];
    while (this.peek() && (this.peek() as Line).indent === indent && (this.peek() as Line).text.startsWith("-")) {
      const rest = this.lines[this.i].text.replace(/^-\s?/, "");
      if (rest === "") {
        this.i++;
        const next = this.peek();
        arr.push(next && next.indent > indent ? this.block(next.indent) : null);
        continue;
      }
      if (rest.startsWith("{") || rest.startsWith("[") || !splitKey(rest)) {
        arr.push(scalar(rest));
        this.i++;
        continue;
      }
      const itemIndent = indent + 2;
      this.lines[this.i] = { indent: itemIndent, text: rest };
      arr.push(this.map(itemIndent));
    }
    return arr;
  }
}

// ---------------------------------------------------------------------------------------------
// The schema rules (mirror the "Frontmatter schema" table; keep in lockstep with that file).
const ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/;
const CONTEXT_ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
const CONTEXT_MAP_TYPES = new Set([
  "shared-kernel",
  "customer-supplier",
  "conformist",
  "acl",
  "ohs",
  "published-language",
  "separate-ways",
]);
// A token is past-tense when it ends in -ed or is a common irregular past participle.
const PAST_TOKEN_RE =
  /^(?:[a-z]+ed|set|put|sent|paid|sold|held|won|lost|met|left|kept|made|found|torn|worn|drawn|given|taken|seen|known|grown|thrown|shown|gone|done|built|spent|felt|meant|dealt|bound|hit|cut|shut|split|read|fed|led|bred|bought|brought|caught|taught|thought|fought|sought|wrote|written|broken|chosen|frozen|forgotten|hidden|ridden|risen|spoken|stolen|struck|swept|wept|slept|sworn|begun|rung|sung|hung|stuck|struck|withdrawn|overdrawn)$/;

export function validateModel(raw: string): { findings: Finding[]; checks: number } {
  const findings: Finding[] = [];
  let checks = 0;
  const fail = (id: string, detail: string) => {
    findings.push({ id, detail });
  };
  const check = (id: string, ok: boolean, detail: string) => {
    checks++;
    if (!ok) fail(id, detail);
  };
  const isArr = (v: unknown): v is Rec[] => Array.isArray(v);
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  check("fm-present", !!fmMatch, "artifact has YAML frontmatter");
  if (!fmMatch) return { findings, checks };
  let fm: Rec;
  try {
    fm = new Parser(toLines(fmMatch[1])).parse() as Rec;
  } catch (e) {
    fail("fm-parses", `frontmatter YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
    return { findings, checks };
  }
  const body = fmMatch[2];

  check("top-model", str(fm.model), "top-level `model` is a non-empty string");
  check("top-version", Number.isInteger(fm.version) && (fm.version as number) >= 1, "top-level `version` is an integer >= 1");
  for (const k of ["ubiquitous_language", "bounded_contexts", "context_map", "entities", "value_objects", "aggregates", "domain_events", "rules"]) {
    check(`key-${k}`, isArr(fm[k]), `frontmatter has array \`${k}\``);
  }
  for (const h of ["## Ubiquitous Language", "## Bounded Contexts", "## Aggregates"]) {
    check(`body-${h.slice(3).toLowerCase().replace(/ /g, "-")}`, body.includes(h), `body has '${h}' section`);
  }

  const ul = isArr(fm.ubiquitous_language) ? fm.ubiquitous_language : [];
  const contexts = isArr(fm.bounded_contexts) ? fm.bounded_contexts : [];
  const cmap = isArr(fm.context_map) ? fm.context_map : [];
  const entities = isArr(fm.entities) ? fm.entities : [];
  const vos = isArr(fm.value_objects) ? fm.value_objects : [];
  const aggregates = isArr(fm.aggregates) ? fm.aggregates : [];
  const events = isArr(fm.domain_events) ? fm.domain_events : [];
  const rules = isArr(fm.rules) ? fm.rules : [];

  // ubiquitous language
  check("ul-nonempty", ul.length > 0, "ubiquitous_language is non-empty");
  for (const t of ul) {
    check(`ul-${t.term}`, str(t.term) && str(t.definition) && Array.isArray(t.displaces), `term '${t.term}' has term, definition, displaces[]`);
  }

  // bounded contexts
  check("bc-count", contexts.length >= 1, `at least one bounded context (found ${contexts.length})`);
  const contextIds = new Set<string>();
  for (const c of contexts) {
    check(`bc-${c.id}`, str(c.id) && CONTEXT_ID_RE.test(c.id) && str(c.name) && str(c.purpose), `context '${c.id}' has id={project}.{context}, name, purpose`);
    if (str(c.id)) contextIds.add(c.id);
  }

  // context map
  for (const [i, r] of cmap.entries()) {
    check(`cm-${i}-endpoints`, contextIds.has(r.from as string) && contextIds.has(r.to as string), `context_map[${i}] '${r.from}'→'${r.to}': both endpoints are declared contexts`);
    check(`cm-${i}-type`, CONTEXT_MAP_TYPES.has(r.type as string), `context_map[${i}] type '${r.type}' is a valid integration type`);
  }

  // ID discipline + context membership
  const seen = new Map<string, string>();
  const reg = (kind: string, items: Rec[], type: string) => {
    for (const it of items) {
      const id = str(it.id) ? it.id : "";
      check(`id-${id || `<${kind} missing id>`}`, ID_RE.test(id), `${kind} id '${id}' matches {project}.{context}.{type}.{name}`);
      check(`id-type-${id}`, id.split(".")[2] === type, `${kind} id '${id}' has type segment '${type}'`);
      check(`id-dup-${id}`, !seen.has(id), `id '${id}' is unique`);
      seen.set(id, kind);
      const ctx = id.split(".").slice(0, 2).join(".");
      check(`id-ctx-${id}`, contextIds.has(ctx), `${kind} '${id}' belongs to a DECLARED context ('${ctx}' must appear in bounded_contexts)`);
    }
  };
  reg("entity", entities, "entity");
  reg("value_object", vos, "vo");
  reg("aggregate", aggregates, "aggregate");
  reg("event", events, "event");
  reg("rule", rules, "rule");

  for (const e of entities) {
    check(`entity-fields-${e.id}`, str(e.name) && str(e.context) && str(e.identifier) && Array.isArray(e.attributes), `entity '${e.id}' has name, context, identifier, attributes[]`);
    check(`entity-ctx-${e.id}`, contextIds.has(e.context as string), `entity '${e.id}' context '${e.context}' is declared`);
  }
  for (const v of vos) {
    check(`vo-fields-${v.id}`, str(v.name) && str(v.definition), `value object '${v.id}' has name, definition`);
  }

  // aggregates + FSM
  check("agg-nonempty", aggregates.length > 0, "at least one aggregate");
  const memberIds = new Set([...entities, ...vos].map((x) => x.id as string));
  const aggIds = new Set(aggregates.map((a) => a.id as string));
  for (const a of aggregates) {
    check(`agg-root-${a.id}`, memberIds.has(a.root as string), `aggregate '${a.id}' root '${a.root}' is a declared entity`);
    check(`agg-members-${a.id}`, Array.isArray(a.members), `aggregate '${a.id}' has members[]`);
    for (const m of (a.members as unknown[]) ?? []) {
      check(`agg-member-${a.id}-${m}`, memberIds.has(m as string), `aggregate '${a.id}' member '${m}' is declared`);
    }
    check(`agg-invariant-${a.id}`, str(a.invariant), `aggregate '${a.id}' states its single-transaction invariant`);
    const sm = a.state_machine as Rec | undefined;
    if (sm) {
      const states = new Set((sm.states as unknown[]) ?? []);
      check(`fsm-states-${a.id}`, states.size > 0, `FSM '${a.id}' declares states[]`);
      check(`fsm-initial-${a.id}`, states.has(sm.initial), `FSM '${a.id}' initial '${sm.initial}' is a declared state`);
      for (const t of (sm.terminal as unknown[]) ?? []) {
        check(`fsm-terminal-${a.id}-${t}`, states.has(t), `FSM '${a.id}' terminal '${t}' is a declared state`);
      }
      const trs = (sm.transitions as Rec[]) ?? [];
      check(`fsm-transitions-${a.id}`, trs.length > 0, `FSM '${a.id}' has transitions[]`);
      for (const [i, tr] of trs.entries()) {
        const usesEventKey = tr.on === undefined && tr.event !== undefined;
        check(`fsm-${a.id}-t${i}-key`, !usesEventKey, `FSM '${a.id}' transition ${i} uses key \`event\`; the schema key is \`on\` ({ from, on, to })`);
        check(`fsm-${a.id}-t${i}`, states.has(tr.from) && states.has(tr.to) && str(tr.on), `FSM '${a.id}' transition ${i} (${tr.from} --${tr.on ?? "?"}--> ${tr.to}) has declared from/to and an \`on\``);
      }
      for (const t of (sm.terminal as unknown[]) ?? []) {
        check(`fsm-terminal-closed-${a.id}-${t}`, !trs.some((tr) => tr.from === t), `FSM '${a.id}' terminal state '${t}' has no outgoing transition`);
      }
    }
  }

  // events
  for (const ev of events) {
    const name = String(ev.id ?? "").split(".").pop() ?? "";
    const tokens = name.split("-").filter(Boolean);
    check(`ev-past-${ev.id}`, tokens.some((t) => PAST_TOKEN_RE.test(t)), `event '${ev.id}' is past-tense (no past-participle token in '${name}')`);
    check(`ev-name-${ev.id}`, str(ev.name) && /^[A-Z][A-Za-z0-9]*$/.test(ev.name), `event '${ev.id}' has a PascalCase name`);
    check(`ev-agg-${ev.id}`, aggIds.has(ev.aggregate as string), `event '${ev.id}' cites a declared aggregate via \`aggregate:\` (REQUIRED — the emitting aggregate)`);
  }

  // rules
  check("rule-invariant-present", rules.some((r) => r.kind === "invariant"), "at least one kind: invariant rule");
  check("rule-functional-present", rules.some((r) => r.kind === "functional"), "at least one kind: functional rule");
  for (const r of rules) {
    if (r.kind === "invariant") {
      check(`rule-expr-${r.id}`, str(r.expr), `invariant '${r.id}' has expr`);
      check(`rule-agg-${r.id}`, aggIds.has(r.aggregate as string), `invariant '${r.id}' cites a declared aggregate via \`aggregate:\` (REQUIRED — hosts the runtime assertion)`);
    } else if (r.kind === "functional") {
      check(`rule-gwt-${r.id}`, str(r.given) && str(r.when) && str(r.then), `functional '${r.id}' has given/when/then`);
    } else {
      check(`rule-kind-${r.id}`, false, `rule '${r.id}' kind '${r.kind}' must be invariant|functional (structural rule-0 is DERIVED, never authored)`);
    }
  }
  return { findings, checks };
}

// ---------------------------------------------------------------------------------------------
function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.outputPath) hardFail("--output-path is required");
  const path = flags.outputPath as string;
  // The dispatcher fires on EVERY write under the record dir; act only on the model artifact.
  if (!path.endsWith("ddd-domain-model.md")) passThrough();
  if (!existsSync(path)) passThrough();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    hardFail(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { findings, checks } = validateModel(raw as string);
  emit(findings.length === 0, findings, { checks, passed: checks - findings.length });
}

if (import.meta.main) main();
