#!/usr/bin/env bun
// compose.ts — AIDLC plugin SessionStart compose hook (single bun entry point).
//
// Replaces the former compose.sh + compose-contributions.ts + compose-fragments.ts
// trio. Folding to one TS file removes the shell-portability bug class entirely:
// GNU-only `sed -i` becomes replaceAll; the `cp -rn || cp -r` no-clobber (which
// clobbers on BSD/coreutils>=9.2) becomes an existsSync guard + cpSync; every
// failure is caught and logged to the hooks-health file instead of swallowed by
// `2>/dev/null || true`.
//
// Runs on SessionStart (Claude/Codex) or via the Kiro .kiro.hook. Harness-agnostic:
//   PLUGIN_ROOT   ← CLAUDE_PLUGIN_ROOT | PLUGIN_ROOT | AIDLC_PLUGIN_ROOT
//   PROJECT_DIR   ← CLAUDE_PROJECT_DIR | AIDLC_PROJECT_DIR | PWD  (Codex unsets the first)
//   HARNESS_LEAF  ← AIDLC_HARNESS_DIR  (".claude" default)
//
// Steps: (1) copy new stages/sensors/tools with {{HARNESS_DIR}} substitution,
// no-clobber; (2) merge contributions (produces/consumes/sensors set-union +
// prose fragments spliced) into stage SOURCE — durable across recompiles;
// (3) recompile the graph. Idempotent + short-circuits when nothing changed.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.AIDLC_PLUGIN_ROOT || "";
const PROJECT_DIR =
  process.env.CLAUDE_PROJECT_DIR || process.env.AIDLC_PROJECT_DIR || process.env.PWD || process.cwd();
const HARNESS_LEAF = process.env.AIDLC_HARNESS_DIR || ".claude";
const HARNESS_DIR = join(PROJECT_DIR, HARNESS_LEAF);
const STAGES_DIR = join(HARNESS_DIR, "aidlc-common", "stages");
const PHASES = ["initialization", "ideation", "inception", "construction", "operation"];

// The plugin's stable IDENTITY, computed once up front so every per-plugin
// artifact (the drops file, the retry marker) is keyed the same way — including
// on the early-exit guards, which flush drops before the main body runs. NOT the
// plugin-root basename: a projection root is `dist/plugins/<name>/<harness>`, so
// its basename is the harness leaf (claude/kiro), shared by every plugin — keying
// on it would let two plugins on one harness clobber each other's drops/retry
// files. Prefer the manifest `name`; fall back to the parent-dir <name> segment.
const PLUGIN_KEY = (() => {
  if (!PLUGIN_ROOT) return "plugin";
  for (const md of [".claude-plugin", ".codex-plugin", ".kiro-plugin"]) {
    try {
      const m = JSON.parse(readFileSync(join(PLUGIN_ROOT, md, "plugin.json"), "utf-8"));
      if (typeof m?.name === "string" && m.name) return m.name.replace(/[^\w.-]/g, "_");
    } catch { /* try next / fall through */ }
  }
  const parts = PLUGIN_ROOT.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return (parts[parts.length - 2] || parts[parts.length - 1] || "plugin").replace(/[^\w.-]/g, "_");
})();

// Resolve the hooks-health dir from the INSTALLED tree so compose drops land
// exactly where core hooks write theirs (hooksHealthDir under docsRoot) and where
// --doctor scans — not a bespoke flat path (round-2 major: the old path was read
// by nothing). Memoized; falls back to the workspace-level dir if the lib can't be
// loaded (e.g. a partial install), so a drop is never lost.
let _healthDir: string | null = null;
async function resolveHealthDir(): Promise<string> {
  if (_healthDir) return _healthDir;
  let dir: string;
  try {
    const lib = await import(join(HARNESS_DIR, "tools", "aidlc-lib.ts"));
    dir = lib.hooksHealthDir(PROJECT_DIR) as string;
  } catch {
    dir = join(PROJECT_DIR, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
  }
  _healthDir = dir;
  return dir;
}

// Buffer drops synchronously so callers stay sync; flush to disk once at the end
// (and eagerly on the pre-guard early exits). No silent failures. Each drop is
// tagged with a severity so --doctor can FAIL on a genuinely-degrading drop
// (a half-applied contribution, a failed compile) but treat a benign/expected one
// (a documented-deferred surface declared, a version-skew skip) as advisory. The
// severity is a leading `[degraded]`/`[advisory]` token on the reason field.
type DropSeverity = "degraded" | "advisory";
const _drops: string[] = [];
function recordDrop(reason: string, severity: DropSeverity = "degraded"): void {
  _drops.push(`${new Date().toISOString()}\t[${severity}] ${reason.replace(/\r?\n/g, " ")}`);
}
// Flush drops as the CURRENT run's complete record: OVERWRITE (not append), and
// REMOVE the file when the run had none. So the drops file always reflects only
// the latest compose — it self-clears when the cause is fixed and re-composed,
// and can't grow unboundedly on a persistent collision (round-5). Doctor reading
// it therefore sees a live signal, not accumulated history.
// The drops file is PER-PLUGIN (`plugin-compose-<PLUGIN_KEY>.drops`), not a
// single shared file: SessionStart runs one compose per installed plugin against
// the same project, and an overwrite-per-run shared file let the LAST plugin win
// — a clean plugin's compose (or an early-exit guard) deleted another plugin's
// live degraded drop, so doctor went green (round-6). Per-plugin files isolate
// each plugin's signal; doctor globs `*.drops` and aggregates them all.
async function flushDrops(): Promise<void> {
  try {
    const healthDir = await resolveHealthDir();
    const dropFile = join(healthDir, `plugin-compose-${PLUGIN_KEY}.drops`);
    if (_drops.length === 0) {
      if (existsSync(dropFile)) rmSync(dropFile, { force: true });
    } else {
      mkdirSync(healthDir, { recursive: true });
      writeFileSync(dropFile, _drops.map((l) => l + "\n").join(""), { flag: "w" });
    }
  } catch { /* truly non-fatal */ }
  _drops.length = 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Does the INSTALLED engine accept a frontmatter key? Probes the installed
// validator (not our own copy) so compose never writes a key an older shipped
// engine would reject — which would permanently break that install's graph
// compile with only a drops line as evidence (round-3 blocker). Run the installed
// validateStageFrontmatter against a minimal-but-valid stage carrying the key; if
// it rejects specifically because of that key, the merge is unsafe here. Fails
// OPEN (returns true) if the lib can't be loaded — a partial install already
// can't compile, so we don't add a second failure mode.
async function installedSchemaAccepts(key: string, sampleValue: unknown): Promise<boolean> {
  try {
    const schema = await import(join(HARNESS_DIR, "tools", "aidlc-stage-schema.ts"));
    const base: Record<string, unknown> = {
      slug: "probe-stage", phase: "construction", execution: "ALWAYS", condition: "always",
      lead_agent: "aidlc-quality-agent", support_agents: [], mode: "inline",
      produces: [], consumes: [], requires_stage: [], inputs: "x", outputs: "y",
    };
    const withKey = { ...base, [key]: sampleValue };
    const res = schema.validateStageFrontmatter(withKey);
    if (res.valid) return true;
    // Rejected — is it BECAUSE of our key? (An unknown/!array error naming it.)
    const errs: string[] = res.errors ?? [];
    return !errs.some((e) => e.includes(key));
  } catch {
    return true; // can't probe → don't block (see note above)
  }
}

// Guard: only compose in an AIDLC project, with a resolvable plugin root.
if (!existsSync(join(HARNESS_DIR, "tools", "aidlc-graph.ts"))) {
  process.exit(0); // not an AIDLC project — nothing to do (no drop: not our project)
}
if (!PLUGIN_ROOT) {
  recordDrop("plugin root env not set (CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT/AIDLC_PLUGIN_ROOT)");
  await flushDrops();
  process.exit(0);
}
// A set-but-wrong PLUGIN_ROOT (e.g. a mistyped path from a hand-run command)
// would otherwise pass the non-empty check and then find nothing to copy/merge —
// a silent no-op. Record it so it surfaces in --doctor rather than looking clean.
if (!existsSync(PLUGIN_ROOT)) {
  recordDrop(`plugin root does not exist: "${PLUGIN_ROOT}" — check the AIDLC_PLUGIN_ROOT path`);
  await flushDrops();
  process.exit(0);
}

// --- helpers ---------------------------------------------------------------

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// No-clobber copy of one tree into another, with {{HARNESS_DIR}} substitution on
// .md prose. NEVER overwrites an existing dest (portable no-clobber — the point
// of the former `cp -n`, done right). Returns true if anything was written.
// `kind` labels the tree (stages/sensors/tools) for the collision drop-log: a
// dest that already exists with DIFFERENT content is a real collision (a plugin
// trying to ship a file that shadows core or another plugin) and is dropped-with-
// log — silently skipping it made a plugin "override" a no-op with no evidence
// (round-4). An identical dest is a benign idempotent re-run (no log).
function copyTreeNoClobber(src: string, dst: string, kind: string): boolean {
  if (!existsSync(src)) return false;
  let wrote = false;
  for (const file of walk(src)) {
    const rel = relative(src, file);
    const dest = join(dst, rel);
    let buf = readFileSync(file);
    if (file.endsWith(".md")) {
      buf = Buffer.from(buf.toString("utf-8").replaceAll("{{HARNESS_DIR}}", HARNESS_LEAF));
    }
    if (existsSync(dest)) {
      // no-clobber — never replace core/another plugin. Log only a genuine
      // content collision, not an identical idempotent re-copy.
      if (!readFileSync(dest).equals(buf)) {
        recordDrop(`${kind} "${rel}" collides with an existing file (core or another plugin); not overwritten — rename it to a plugin-namespaced path`);
      }
      continue;
    }
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, buf);
    wrote = true;
  }
  return wrote;
}

function findStageFile(slug: string): string | null {
  for (const phase of PHASES) {
    const p = join(STAGES_DIR, phase, `${slug}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

// Read half: a single frontmatter split (LF/CRLF tolerant) shared by every read
// in this file — after the three-file fold there is one parser here, not two, so
// a robustness fix lands once (review #8). Contribution frontmatter is a distinct
// shape (target/adds/fragments) from stage frontmatter, so it stays local rather
// than importing aidlc-lib's stage parser.
function frontmatter(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

// Append items to a top-level list field, or replace the inline-empty `field: []`
// form with a block (fixes the silent-drop asymmetry, review #5). Idempotent.
// Returns the (possibly unchanged) content; logs when a field is absent entirely.
function mergeListField(content: string, field: string, items: string[], target: string): string {
  if (items.length === 0) return content;
  const emptyRe = new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m");
  if (emptyRe.test(content)) {
    return content.replace(emptyRe, `${field}:\n` + items.map((i) => `  - ${i}`).join("\n"));
  }
  const blockRe = new RegExp(`^(${field}:\\n(?:  - .+\\n)*)`, "m");
  const m = content.match(blockRe);
  if (!m) {
    recordDrop(`contribution to ${target}: no '${field}:' field to append to (adds dropped)`);
    return content;
  }
  const existing = new Set([...m[1].matchAll(/^  - (.+)$/gm)].map((x) => x[1].trim()));
  const toAdd = items.filter((i) => !existing.has(i));
  if (toAdd.length === 0) return content;
  return content.replace(blockRe, m[1] + toAdd.map((i) => `  - ${i}`).join("\n") + "\n");
}

// Append consumes objects (artifact + required + optional conditional_on).
// Handles block + `consumes: []`.
type ConsumeEntry = { artifact: string; required: boolean; conditional_on?: string };
function mergeConsumes(content: string, entries: ConsumeEntry[], target: string): string {
  if (entries.length === 0) return content;
  const render = (e: ConsumeEntry) =>
    `  - artifact: ${e.artifact}\n    required: ${e.required}` +
    (e.conditional_on ? `\n    conditional_on: ${e.conditional_on}` : "");
  const emptyRe = /^consumes:\s*\[\s*\]\s*$/m;
  if (emptyRe.test(content)) {
    return content.replace(emptyRe, "consumes:\n" + entries.map(render).join("\n"));
  }
  // Each entry is `- artifact:` plus every following indented continuation line
  // (`required:`, `conditional_on:`). Matching those continuations is what keeps
  // an append AFTER the last core entry — omit `conditional_on` and the block
  // ends early, splicing the new entry INSIDE a core entry and stealing its
  // brownfield gate (round-2 major). The new entries land past the whole block.
  const blockRe = /^(consumes:\n(?:  - artifact:.*\n(?:    (?:required|conditional_on):.*\n)*)*)/m;
  const m = content.match(blockRe);
  if (!m) {
    recordDrop(`contribution to ${target}: no 'consumes:' field to append to`);
    return content;
  }
  const existing = new Set([...m[1].matchAll(/- artifact:\s*([\w-]+)/g)].map((x) => x[1]));
  const toAdd = entries.filter((e) => !existing.has(e.artifact));
  if (toAdd.length === 0) return content;
  return content.replace(blockRe, m[1] + toAdd.map(render).join("\n") + "\n");
}

// Merge required_sections (quoted-string values, e.g. "Branch Coverage"). Unlike
// produces/sensors, a core stage often has NO required_sections field, so this
// ADDS the field (before the closing frontmatter `---`) when absent, appends to
// the block form, and replaces the inline-empty `[]` form. Idempotent by value.
function mergeRequiredSections(content: string, items: string[], target: string): string {
  if (items.length === 0) return content;
  const render = (list: string[]) => list.map((s) => `  - "${s}"`).join("\n");
  const emptyRe = /^required_sections:\s*\[\s*\]\s*$/m;
  if (emptyRe.test(content)) {
    return content.replace(emptyRe, "required_sections:\n" + render(items));
  }
  const blockRe = /^(required_sections:\n(?:  - .+\n)*)/m;
  const m = content.match(blockRe);
  if (m) {
    const existing = new Set([...m[1].matchAll(/^  - (.+?)\s*$/gm)].map((x) => x[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")));
    const toAdd = items.filter((s) => !existing.has(s));
    if (toAdd.length === 0) return content;
    return content.replace(blockRe, m[1] + render(toAdd) + "\n");
  }
  // Field absent — insert it just before the closing frontmatter `---`. The
  // closing fence may be followed by a newline OR sit at EOF (a stage file with
  // no trailing newline is valid) — `(?:\n|$)` tolerates both; requiring `\r?\n`
  // after `---` silently dropped the whole merge on a newline-less file (round-4).
  const fmClose = content.match(/^---\r?\n[\s\S]*?\n(---)(?:\r?\n|$)/);
  if (!fmClose) {
    recordDrop(`contribution to ${target}: cannot add required_sections (no frontmatter block)`);
    return content;
  }
  const insertAt = fmClose.index! + fmClose[0].lastIndexOf("---");
  return content.slice(0, insertAt) + "required_sections:\n" + render(items) + "\n" + content.slice(insertAt);
}

// Resolve a fragment anchor to a char offset. Anchors are validated + escaped
// (review #6) — a malformed anchor is skipped-with-log, never a thrown regex. A
// valid anchor whose target heading is ABSENT also returns -1 but logs a distinct
// "not found" drop (round-4: the not-found case was silent, so a contribution's
// frontmatter `adds` landed while its prose vanished — a half-applied merge).
function locateAnchor(content: string, anchor: string, target: string): number {
  const stepAnchor = (kind: "after" | "before"): number => {
    const n = anchor.slice(anchor.indexOf(":") + 1);
    if (!/^\d+$/.test(n)) { recordDrop(`contribution to ${target}: bad ${kind}-step anchor "${anchor}" (step must be an integer)`); return -1; }
    const want = Number(n);
    // Match a plain `### Step 7` OR a range heading `### Step 4-8:` that CONTAINS
    // `want` — core ships combined headings (e.g. build-and-test's `### Step 4-8:`),
    // and `^### Step 8\b` would never match "Step 4-8". Scan all step headings.
    let hit: { index: number; length: number } | null = null;
    for (const m of content.matchAll(/^### Step (\d+)(?:-(\d+))?\b.*$/gm)) {
      const lo = Number(m[1]); const hi = m[2] ? Number(m[2]) : lo;
      if (want >= lo && want <= hi) { hit = { index: m.index!, length: m[0].length }; break; }
    }
    if (!hit) { recordDrop(`contribution to ${target}: ${kind}-step anchor "${anchor}" — no "### Step ${n}" heading found (a range like "### Step 4-8" counts); prose dropped`); return -1; }
    if (kind === "before") return hit.index;
    const from = hit.index + hit.length;
    const next = content.slice(from).search(/^#{2,3} /m);
    return next === -1 ? content.length : from + next;
  };
  if (anchor.startsWith("after-step:")) return stepAnchor("after");
  if (anchor.startsWith("before-step:")) return stepAnchor("before");
  if (anchor === "end-of-steps") {
    const s = content.match(/^## Steps\b.*$/m);
    if (!s) { recordDrop(`contribution to ${target}: anchor "end-of-steps" — no "## Steps" section found; prose dropped`); return -1; }
    const from = s.index! + s[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  if (anchor.startsWith("in:")) {
    const comp = anchor.slice(3);
    if (!/^[\w -]+$/.test(comp)) { recordDrop(`contribution to ${target}: bad in: anchor "${anchor}"`); return -1; }
    const m = content.match(new RegExp(`^## ${escapeRegExp(comp)}\\b.*$`, "m"));
    if (!m) { recordDrop(`contribution to ${target}: in: anchor "${anchor}" — no "## ${comp}" section found; prose dropped`); return -1; }
    const from = m.index! + m[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  recordDrop(`contribution to ${target}: unknown anchor "${anchor}"`);
  return -1;
}

// FNV-1a 32-bit hex — a dependency-free content fingerprint. Embedded in a
// fragment's sentinel so a plugin UPGRADE (rewritten prose) is detected and the
// old block replaced, rather than filtered as already-present forever.
function hashProse(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface Fragment { bundle: string; anchor: string; order: number; prose: string; }

// Splice ONE fragment into stage source, idempotently and order-deterministically.
// Each spliced block is delimited by an open sentinel carrying (bundle, anchor,
// order, content-hash) and a matching close sentinel. Because blocks are
// self-delimiting we can (a) skip when the same block is already present, (b)
// replace it when only the hash changed (upgrade), and (c) insert a NEW block at
// its correct (order, bundle) slot among peer plugin blocks at the same anchor —
// so plugins composing in separate hook runs still interleave by (order, bundle),
// never by hook-firing order. Never relies on "the next heading" to bound a block.
function spliceFragment(content: string, f: Fragment, target: string): string {
  const hash = hashProse(f.prose);
  const bE = escapeRegExp(f.bundle), aE = escapeRegExp(f.anchor);
  // The close marker carries the SAME content hash as the open, so the block's
  // boundary is content-specific: a close-marker-lookalike line inside the prose
  // (which lacks the exact hash) can't be mistaken for the real close on an
  // upgrade re-splice (round-5 — the old hashless close matched the first
  // occurrence, so prose containing the marker corrupted the block).
  const closeOf = (h: string) => `<!-- /plugin:${f.bundle}:${f.anchor}:${f.order}:${h} -->`;
  const block = `<!-- plugin:${f.bundle}:${f.anchor}:${f.order}:${hash} -->\n${f.prose}\n${closeOf(hash)}`;

  // Present already? Skip on hash match; replace the whole block on hash change.
  const mine = content.match(new RegExp(`<!-- plugin:${bE}:${aE}:${f.order}:([0-9a-f]+) -->`));
  if (mine) {
    if (mine[1] === hash) return content;
    const start = mine.index!;
    const oldClose = closeOf(mine[1]); // the OLD block's own hash-qualified close
    const end = content.indexOf(oldClose, start);
    if (end === -1) { recordDrop(`contribution to ${target}: fragment block for "${f.anchor}" order ${f.order} missing close marker; left as-is`); return content; }
    return content.slice(0, start) + block + content.slice(end + oldClose.length);
  }

  // Insert at the ordered slot among peer plugin blocks at this anchor (any bundle).
  const peers: Array<{ order: number; bundle: string; start: number; end: number }> = [];
  for (const m of content.matchAll(new RegExp(`<!-- plugin:([^:]+):${aE}:(\\d+):([0-9a-f]+) -->`, "g"))) {
    const pBundle = m[1], pOrder = Number(m[2]), pHash = m[3];
    const close = `<!-- /plugin:${pBundle}:${f.anchor}:${pOrder}:${pHash} -->`;
    const cIdx = content.indexOf(close, m.index!);
    if (cIdx === -1) continue;
    peers.push({ order: pOrder, bundle: pBundle, start: m.index!, end: cIdx + close.length });
  }
  if (peers.length > 0) {
    const after = peers.find((p) => p.order > f.order || (p.order === f.order && p.bundle.localeCompare(f.bundle) > 0));
    if (after) return content.slice(0, after.start) + block + "\n\n" + content.slice(after.start);
    const lastEnd = Math.max(...peers.map((p) => p.end));
    return content.slice(0, lastEnd) + "\n\n" + block + content.slice(lastEnd);
  }

  // Virgin anchor — use the structural locator for the base insertion point.
  const base = locateAnchor(content, f.anchor, target);
  if (base === -1) return content;
  return content.slice(0, base) + "\n" + block + "\n" + content.slice(base);
}

// --- main compose ----------------------------------------------------------

let changed = false;
try {
  // 1. Copy NEW primitives (no-clobber, token-substituted).
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "stages"), STAGES_DIR, "stage") || changed;
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "sensors"), join(HARNESS_DIR, "sensors"), "sensor") || changed;
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "tools"), join(HARNESS_DIR, "tools"), "tool") || changed;

  // 2. Merge contributions into stage SOURCE (structural + prose fragments).
  // Probe ONCE whether the installed engine accepts required_sections — writing
  // it into a stage an older engine can't parse would break every later compile.
  const requiredSectionsSafe = await installedSchemaAccepts("required_sections", ["Probe Section"]);
  const contribRoot = join(PLUGIN_ROOT, "contributions");
  // Fragment keys seen across ALL contribution files this run, so a same
  // (target, bundle, anchor, order) arriving from a SECOND file drops-with-log
  // rather than silently last-writer-winning via the hash-upgrade path (round-3).
  const seenFragKeys = new Set<string>();
  for (const phase of existsSync(contribRoot) ? readdirSync(contribRoot) : []) {
    const phaseDir = join(contribRoot, phase);
    let files: string[];
    try { files = readdirSync(phaseDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      // Normalize CRLF once so every downstream block/list regex is newline-safe;
      // strip a leading UTF-8 BOM and any leading blank lines so the `^---`
      // frontmatter anchor still matches a file saved with a BOM (common on
      // Windows) or a stray blank first line — otherwise the whole contribution
      // was silently skipped with no drop (round-5).
      const content = readFileSync(join(phaseDir, file), "utf-8")
        .replace(/\r\n/g, "\n").replace(/^﻿/, "").replace(/^\n+/, "");
      const fm = frontmatter(content);
      const target = fm.match(/^target:\s*(.+)$/m)?.[1].trim();
      // A .md in contributions/ with no parseable `target:` is a malformed
      // contribution — log it (a present-but-unknown target is already logged
      // below; a missing one was a silent bare continue).
      if (!target) { recordDrop(`contribution "${file}" has no parseable frontmatter target: — skipped (check for a BOM, a leading blank line, or a missing target: key)`); continue; }
      const bundle = fm.match(/^bundle:\s*(.+)$/m)?.[1].trim() ?? "";
      // `:` is the fragment-sentinel delimiter (<!-- plugin:bundle:anchor:order -->),
      // so a bundle containing `:` would break the peer-block scan's `[^:]+` and
      // silently misorder splices. Reject it up front (round-6).
      if (bundle.includes(":")) { recordDrop(`contribution "${file}" has an invalid bundle "${bundle}" (must not contain ':'); skipped`); continue; }
      const stageFile = findStageFile(target);
      if (!stageFile) { recordDrop(`contribution "${file}" targets missing stage "${target}"`); continue; }

      // structural: adds.produces / adds.sensors / adds.consumes
      const addsBlock = fm.match(/^adds:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "";
      const listOf = (f: string): string[] => {
        const s = addsBlock.match(new RegExp(`^  ${f}:\\n((?:    - [\\w-]+\\n?)*)`, "m"));
        return s ? [...s[1].matchAll(/^    - ([\w-]+)/gm)].map((x) => x[1]) : [];
      };
      const consumes = (() => {
        // Parse consumes per-entry, NOT by zipping two independent artifact/required
        // scans: a dash-less `required:`/`conditional_on:` continuation line must
        // bind to the artifact above it, or entry 2+ is dropped and required flips
        // (round-2 blocker). Each entry starts at `- artifact:` and owns every
        // following indented non-dash line until the next `- artifact:`.
        const block = addsBlock.match(/^  consumes:\n((?:    -? .*\n?)*)/m)?.[1];
        if (!block) return [];
        const out: Array<{ artifact: string; required: boolean; conditional_on?: string }> = [];
        // Split on ANY-indent `- artifact:` (a YAML-legal 6-space list must still
        // yield one chunk per entry; a fixed 4-space anchor silently merged them —
        // round-3). Drop-log if entries outnumber chunks (a split that failed).
        for (const chunk of block.split(/^(?=\s*- artifact:)/m)) {
          const artifact = chunk.match(/-\s*artifact:\s*([\w-]+)/)?.[1];
          if (!artifact) continue;
          // `required` defaults to true ONLY when the key is genuinely absent;
          // an explicit `required: false` must survive.
          const reqRaw = chunk.match(/^\s*required:\s*(true|false)\b/m)?.[1];
          const conditional_on = chunk.match(/^\s*conditional_on:\s*(\w+)/m)?.[1];
          out.push({ artifact, required: reqRaw !== "false", ...(conditional_on ? { conditional_on } : {}) });
        }
        const declared = (block.match(/-\s*artifact:/g) ?? []).length;
        if (declared > out.length) {
          recordDrop(`contribution to ${target}: parsed ${out.length} of ${declared} consumes entries (check indentation); some dropped`);
        }
        return out;
      })();

      // Drop-log any adds.* key compose does not implement — no silent no-op.
      // Implemented merge surfaces: produces / sensors / consumes / required_sections.
      // A documented-but-deferred surface (e.g. scopes) is recorded as a drop so an
      // author sees it had no effect, per the no-silent-failures contract. (When a
      // surface graduates, add it to IMPLEMENTED_ADDS + a merge call below.)
      const IMPLEMENTED_ADDS = new Set(["produces", "sensors", "consumes", "required_sections"]);
      for (const km of addsBlock.matchAll(/^  ([a-z_]+):/gm)) {
        if (!IMPLEMENTED_ADDS.has(km[1])) {
          recordDrop(`contribution to ${target}: adds.${km[1]} is not yet an implemented merge surface (only produces/sensors/consumes/required_sections); ignored`, "advisory");
        }
      }

      // required_sections values are quoted strings ("Branch Coverage"), unlike
      // the kebab slugs in produces/sensors. Capture the whole value then strip
      // only a MATCHED pair of outer quotes — a `[^"]` class dropped any value
      // with an interior quote (`"Say "Hi" Section"`) silently (round-5).
      const requiredSections = (() => {
        const s = addsBlock.match(/^  required_sections:\n((?:    - .*\n?)*)/m)?.[1];
        if (!s) return [];
        const out: string[] = [];
        for (const x of s.matchAll(/^    - (.+?)\s*$/gm)) {
          const v = x[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
          // An empty (or quote-only) value would merge a useless `- ""` into the
          // stage with no signal — drop-log it instead (round-6).
          if (v === "") { recordDrop(`contribution to ${target}: empty required_sections value; dropped`); continue; }
          out.push(v);
        }
        return out;
      })();

      // Normalize CRLF up front so a merge never inserts LF lines into a CRLF
      // stage (mixed endings). Contribution content is already normalized above.
      let stageContent = readFileSync(stageFile, "utf-8").replace(/\r\n/g, "\n");
      const before = stageContent;
      stageContent = mergeListField(stageContent, "produces", listOf("produces"), target);
      stageContent = mergeListField(stageContent, "sensors", listOf("sensors"), target);
      stageContent = mergeConsumes(stageContent, consumes, target);
      // Only merge required_sections if the installed engine accepts the key —
      // otherwise skip + drop-log rather than break the install's next compile.
      if (requiredSections.length > 0 && !requiredSectionsSafe) {
        recordDrop(`contribution to ${target}: installed engine does not accept 'required_sections' (older dist); skipped its merge — re-copy your dist/<harness> shell to enable it`, "advisory");
      } else {
        stageContent = mergeRequiredSections(stageContent, requiredSections, target);
      }

      // prose fragments — paired to their `## fragment: <anchor>` body block BY
      // ANCHOR LABEL, not array index. Positional pairing silently mismatched
      // prose to anchors when the body order differed from the frontmatter order
      // (round-4). Multiple fragments may target the same anchor (test-pro has 3×
      // after-step:9), so pair per-anchor FIFO: the i-th frontmatter entry for
      // anchor A takes the i-th body block labelled A. A frontmatter entry with no
      // matching body block (or vice versa) is dropped-with-log, not silently
      // cross-paired to some other anchor's prose.
      const body = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? "";
      const fragMeta = [...(fm.match(/^fragments:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "")
        .matchAll(/-\s*anchor:\s*(\S+)\s*\n\s*order:\s*(\d+)/g)].map((m) => ({ anchor: m[1], order: Number(m[2]) }));
      // Split the body into `## fragment: <anchor>` blocks with a FENCE-AWARE line
      // scanner, not a global regex: a `## fragment:` line INSIDE a ``` code fence
      // (exactly how an author documents the fragment format) must NOT be treated
      // as a delimiter — the regex form truncated the block there and spawned
      // phantom blocks, silently dropping trailing real prose (round-5).
      const blocksByAnchor = new Map<string, string[]>();
      {
        let curAnchor: string | null = null; let curLines: string[] = [];
        let inFence = false; let fenceChar = ""; let fenceLen = 0;
        const flush = () => { if (curAnchor !== null) (blocksByAnchor.get(curAnchor) ?? blocksByAnchor.set(curAnchor, []).get(curAnchor)!).push(curLines.join("\n").trim()); };
        for (const line of body.split("\n")) {
          // CommonMark fence rules: a closing fence is the SAME char, length >=
          // the opener, and carries no info string. Tracking only the char (not
          // the length) let an inner ``` close an outer ```` — so documenting the
          // fragment format with a nested fence corrupted the block (round-6).
          const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
          if (fence) {
            const ch = fence[2][0]; const len = fence[2].length; const info = fence[3].trim();
            if (!inFence) { inFence = true; fenceChar = ch; fenceLen = len; }
            else if (ch === fenceChar && len >= fenceLen && info === "") { inFence = false; fenceChar = ""; fenceLen = 0; }
          }
          const hdr = !inFence && line.match(/^## fragment:\s*(\S+)\s*$/);
          if (hdr) { flush(); curAnchor = hdr[1]; curLines = []; continue; }
          if (curAnchor !== null) curLines.push(line);
        }
        flush();
      }
      const frags: Fragment[] = [];
      for (const meta of fragMeta) {
        const queue = blocksByAnchor.get(meta.anchor);
        const prose = (queue && queue.length > 0 ? queue.shift()! : "").replaceAll("{{HARNESS_DIR}}", HARNESS_LEAF);
        if (!prose) { recordDrop(`contribution to ${target}: fragment anchor "${meta.anchor}" order ${meta.order} has no matching "## fragment: ${meta.anchor}" prose block; dropped`); continue; }
        frags.push({ ...meta, bundle, prose });
      }
      // Leftover body blocks with no matching frontmatter entry are dropped-with-
      // log — the "or vice versa" half the prior comment promised but never did
      // (round-5). An empty leftover (blank prose) is ignored, not logged.
      for (const [anchor, remaining] of blocksByAnchor) {
        for (const leftover of remaining) {
          if (leftover) recordDrop(`contribution to ${target}: "## fragment: ${anchor}" prose block has no matching frontmatter fragments entry; dropped`);
        }
      }

      // Splice each fragment at its ordered (order, bundle) slot. A same
      // (target, bundle, anchor, order) collision — whether within this file OR
      // from an earlier contribution file this run — drops-with-log rather than
      // silently overwriting (the hash-upgrade path would otherwise let a second
      // file replace the first, winner decided by readdir order). Aligned with
      // the "collision is an error" doc claim.
      const ordered = [...frags].sort((a, b) => a.order - b.order || a.bundle.localeCompare(b.bundle));
      for (const f of ordered) {
        const key = `${target}:${f.bundle}:${f.anchor}:${f.order}`;
        if (seenFragKeys.has(key)) { recordDrop(`contribution to ${target}: duplicate fragment ${f.bundle}:${f.anchor}:${f.order} (same bundle/anchor/order, possibly across files); dropped`); continue; }
        seenFragKeys.add(key);
        stageContent = spliceFragment(stageContent, f, target);
      }

      if (stageContent !== before) { // compare-before-write (review #11)
        writeFileSync(stageFile, stageContent);
        changed = true;
      }
    }
  }

  // 3. Recompile when something changed OR when a prior compile did not land —
  //    a transient failure (disk full, killed mid-session-start) must self-heal
  //    next session. Under the no-clobber + sentinel + compare-before-write gates
  //    `changed` stays false on reruns, so gating on `changed` alone would make a
  //    failed compile permanent (round-2 major). Detect it by checking the
  //    compiled graph actually contains this plugin's stage slugs.
  const pluginSlugs: string[] = [];
  for (const phase of PHASES) {
    const dir = join(PLUGIN_ROOT, "stages", phase);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) pluginSlugs.push(f.slice(0, -3));
  }
  const graphPath = join(HARNESS_DIR, "tools", "data", "stage-graph.json");
  const graphMissingPluginStage = (() => {
    if (pluginSlugs.length === 0) return false;
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as Array<{ slug?: string }>;
      const present = new Set(graph.map((s) => s.slug));
      return pluginSlugs.some((s) => !present.has(s));
    } catch { return true; } // unreadable/absent graph — compile
  })();
  // A contributions-only plugin has no stage slug to detect a missing compile, so
  // the graph-slug check can't see its failed recompile. A persisted retry marker
  // covers that case: written on compile failure, deleted on success, and any
  // presence forces a retry next run — so a transient failure self-heals for
  // stage-carrying AND contributions-only plugins alike (round-3). The marker is
  // PROJECT-side (never in PLUGIN_ROOT, which may be read-only / under dist/), and
  // keyed by the plugin's identity (PLUGIN_KEY, computed up front) so two plugins
  // on one harness never share a marker.
  const retryMarker = join(PROJECT_DIR, "aidlc", `.plugin-compose-retry-${PLUGIN_KEY}`);
  const retryPending = existsSync(retryMarker);
  if (changed || graphMissingPluginStage || retryPending) {
    const bun = process.execPath;
    const r = spawnSync(bun, [join(HARNESS_DIR, "tools", "aidlc-graph.ts"), "compile"], {
      cwd: PROJECT_DIR, encoding: "utf-8",
    });
    if (r.status !== 0) {
      recordDrop(`aidlc-graph compile failed: ${(r.stderr || "").slice(0, 400)}`);
      try { mkdirSync(join(PROJECT_DIR, "aidlc"), { recursive: true }); writeFileSync(retryMarker, new Date().toISOString() + "\n"); } catch { /* best-effort */ }
    } else if (retryPending) {
      try { rmSync(retryMarker, { force: true }); } catch { /* best-effort */ }
    }
  }
} catch (e) {
  recordDrop(`compose threw: ${e instanceof Error ? e.message : String(e)}`);
  // Non-fatal: never break the user's session over a compose failure.
}

// Flush any recorded drops to the installed hooks-health dir (--doctor surfaces
// them). Best-effort — flushDrops swallows its own errors.
await flushDrops();
