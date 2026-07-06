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

// Health-file logging (mirrors core's recordHookDrop) — no silent failures.
// The bare workspace-level health dir (`aidlc/.aidlc-hooks-health/`) matches where
// core hooks write drops and where --doctor reads them; compose runs before any
// intent exists, so it stays at the workspace root rather than a per-intent record.
function recordDrop(reason: string): void {
  try {
    const healthDir = join(PROJECT_DIR, "aidlc", ".aidlc-hooks-health");
    mkdirSync(healthDir, { recursive: true });
    const line = `${new Date().toISOString()}\tplugin-compose\t${reason.replace(/\r?\n/g, " ")}\n`;
    writeFileSync(join(healthDir, "plugin-compose.drops"), line, { flag: "a" });
  } catch { /* truly non-fatal */ }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Guard: only compose in an AIDLC project, with a resolvable plugin root.
if (!PLUGIN_ROOT) {
  recordDrop("plugin root env not set (CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT/AIDLC_PLUGIN_ROOT)");
  process.exit(0);
}
if (!existsSync(join(HARNESS_DIR, "tools", "aidlc-graph.ts"))) {
  process.exit(0); // not an AIDLC project — nothing to do
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
function copyTreeNoClobber(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  let wrote = false;
  for (const file of walk(src)) {
    const rel = relative(src, file);
    const dest = join(dst, rel);
    if (existsSync(dest)) continue; // no-clobber — never replace core/another plugin
    mkdirSync(join(dest, ".."), { recursive: true });
    let buf = readFileSync(file);
    if (file.endsWith(".md")) {
      buf = Buffer.from(buf.toString("utf-8").replaceAll("{{HARNESS_DIR}}", HARNESS_LEAF));
    }
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

// Append consumes objects (artifact + required). Handles block + `consumes: []`.
function mergeConsumes(content: string, entries: Array<{ artifact: string; required: boolean }>, target: string): string {
  if (entries.length === 0) return content;
  const render = (e: { artifact: string; required: boolean }) =>
    `  - artifact: ${e.artifact}\n    required: ${e.required}`;
  const emptyRe = /^consumes:\s*\[\s*\]\s*$/m;
  if (emptyRe.test(content)) {
    return content.replace(emptyRe, "consumes:\n" + entries.map(render).join("\n"));
  }
  const blockRe = /^(consumes:\n(?:  - artifact:.*\n(?:    required:.*\n)?)*)/m;
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

// Resolve a fragment anchor to a char offset. Anchors are validated + escaped
// (review #6) — a malformed anchor is skipped-with-log, never a thrown regex.
function locateAnchor(content: string, anchor: string, target: string): number {
  const stepAnchor = (kind: "after" | "before"): number => {
    const n = anchor.slice(anchor.indexOf(":") + 1);
    if (!/^\w+$/.test(n)) { recordDrop(`contribution to ${target}: bad ${kind}-step anchor "${anchor}"`); return -1; }
    const m = content.match(new RegExp(`^### Step ${escapeRegExp(n)}\\b.*$`, "m"));
    if (!m) return -1;
    if (kind === "before") return m.index!;
    const from = m.index! + m[0].length;
    const next = content.slice(from).search(/^#{2,3} /m);
    return next === -1 ? content.length : from + next;
  };
  if (anchor.startsWith("after-step:")) return stepAnchor("after");
  if (anchor.startsWith("before-step:")) return stepAnchor("before");
  if (anchor === "end-of-steps") {
    const s = content.match(/^## Steps\b.*$/m);
    if (!s) return -1;
    const from = s.index! + s[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  if (anchor.startsWith("in:")) {
    const comp = anchor.slice(3);
    if (!/^[\w -]+$/.test(comp)) { recordDrop(`contribution to ${target}: bad in: anchor "${anchor}"`); return -1; }
    const m = content.match(new RegExp(`^## ${escapeRegExp(comp)}\\b.*$`, "m"));
    if (!m) return -1;
    const from = m.index! + m[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  recordDrop(`contribution to ${target}: unknown anchor "${anchor}"`);
  return -1;
}

// --- main compose ----------------------------------------------------------

let changed = false;
try {
  // 1. Copy NEW primitives (no-clobber, token-substituted).
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "stages"), STAGES_DIR) || changed;
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "sensors"), join(HARNESS_DIR, "sensors")) || changed;
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "tools"), join(HARNESS_DIR, "tools")) || changed;

  // 2. Merge contributions into stage SOURCE (structural + prose fragments).
  const contribRoot = join(PLUGIN_ROOT, "contributions");
  for (const phase of existsSync(contribRoot) ? readdirSync(contribRoot) : []) {
    const phaseDir = join(contribRoot, phase);
    let files: string[];
    try { files = readdirSync(phaseDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      // Normalize CRLF once so every downstream block/list regex is newline-safe
      // regardless of the OS a contribution was authored on (review #8: one parser).
      const content = readFileSync(join(phaseDir, file), "utf-8").replace(/\r\n/g, "\n");
      const fm = frontmatter(content);
      const target = fm.match(/^target:\s*(.+)$/m)?.[1].trim();
      if (!target) continue;
      const bundle = fm.match(/^bundle:\s*(.+)$/m)?.[1].trim() ?? "";
      const stageFile = findStageFile(target);
      if (!stageFile) { recordDrop(`contribution "${file}" targets missing stage "${target}"`); continue; }

      // structural: adds.produces / adds.sensors / adds.consumes
      const addsBlock = fm.match(/^adds:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "";
      const listOf = (f: string): string[] => {
        const s = addsBlock.match(new RegExp(`^  ${f}:\\n((?:    - [\\w-]+\\n?)*)`, "m"));
        return s ? [...s[1].matchAll(/^    - ([\w-]+)/gm)].map((x) => x[1]) : [];
      };
      const consumes = (() => {
        const s = addsBlock.match(/consumes:\n((?:\s+- (?:artifact|required).*\n)*)/);
        if (!s) return [];
        const arts = [...s[1].matchAll(/artifact:\s*([\w-]+)/g)];
        const reqs = [...s[1].matchAll(/required:\s*(true|false)/g)];
        return arts.map((m, i) => ({ artifact: m[1], required: reqs[i]?.[1] !== "false" }));
      })();

      let stageContent = readFileSync(stageFile, "utf-8");
      const before = stageContent;
      stageContent = mergeListField(stageContent, "produces", listOf("produces"), target);
      stageContent = mergeListField(stageContent, "sensors", listOf("sensors"), target);
      stageContent = mergeConsumes(stageContent, consumes, target);

      // prose fragments — paired positionally with the frontmatter fragments list.
      const body = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? "";
      const fragMeta = [...(fm.match(/^fragments:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "")
        .matchAll(/-\s*anchor:\s*(\S+)\s*\n\s*order:\s*(\d+)/g)].map((m) => ({ anchor: m[1], order: Number(m[2]) }));
      const blocks = [...body.matchAll(/^## fragment:\s*(\S+)\s*\n([\s\S]*?)(?=^## fragment:|$(?![\s\S]))/gm)]
        .map((m) => m[2].trim());
      const frags = fragMeta.map((meta, i) => ({
        ...meta, bundle,
        prose: (blocks[i] ?? "").replaceAll("{{HARNESS_DIR}}", HARNESS_LEAF),
      })).filter((f) => f.prose);

      // group by anchor, order by (order, bundle); idempotent via a sentinel marker.
      const byAnchor = new Map<string, typeof frags>();
      for (const f of frags) { (byAnchor.get(f.anchor) ?? byAnchor.set(f.anchor, []).get(f.anchor)!).push(f); }
      for (const [anchor, list] of byAnchor) {
        list.sort((a, b) => a.order - b.order || a.bundle.localeCompare(b.bundle));
        const fresh = list.filter((f) => {
          const marker = `<!-- plugin:${f.bundle}:${anchor}:${f.order} -->`;
          return !stageContent.includes(marker);
        });
        if (fresh.length === 0) continue;
        const at = locateAnchor(stageContent, anchor, target);
        if (at === -1) continue;
        const combined = fresh
          .map((f) => `<!-- plugin:${f.bundle}:${anchor}:${f.order} -->\n${f.prose}`)
          .join("\n\n");
        stageContent = stageContent.slice(0, at) + "\n" + combined + "\n" + stageContent.slice(at);
      }

      if (stageContent !== before) { // compare-before-write (review #11)
        writeFileSync(stageFile, stageContent);
        changed = true;
      }
    }
  }

  // 3. Recompile only if something changed (short-circuit — review #7).
  if (changed) {
    const bun = process.execPath;
    const r = spawnSync(bun, [join(HARNESS_DIR, "tools", "aidlc-graph.ts"), "compile"], {
      cwd: PROJECT_DIR, encoding: "utf-8",
    });
    if (r.status !== 0) recordDrop(`aidlc-graph compile failed: ${(r.stderr || "").slice(0, 400)}`);
  }
} catch (e) {
  recordDrop(`compose threw: ${e instanceof Error ? e.message : String(e)}`);
  // Non-fatal: never break the user's session over a compose failure.
}
