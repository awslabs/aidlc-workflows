#!/usr/bin/env bun
// compose-contributions.ts — merge a plugin's contribution files into the
// STAGE SOURCE FILES (not the compiled JSON). Editing source is durable: the
// merged artifacts survive every subsequent `aidlc-graph compile` (which a
// later /aidlc --init or runtime-compile hook may trigger). Post-compile JSON
// patching does NOT survive a recompile — hence source-file merge.
//
// Scope (MVP): additive LIST surfaces only — produces + sensors. These are the
// surfaces that make the graph resolve (produced artifacts) and bind checks
// (sensors). We append to the existing list, right before the next top-level
// key — a surgical edit that never rewrites the surrounding YAML. consumes
// (nested objects) and fragments (prose) are future work.
//
// Idempotent: an item already present in the list is not appended again, so
// re-running on every SessionStart is safe.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT!;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR!;
const STAGES_DIR = join(PROJECT_DIR, ".claude", "aidlc-common", "stages");
const CONTRIB_DIR = join(PLUGIN_ROOT, "contributions");

if (!existsSync(CONTRIB_DIR) || !existsSync(STAGES_DIR)) process.exit(0);

const PHASES = ["initialization", "ideation", "inception", "construction", "operation"];

function findStageFile(slug: string): string | null {
  for (const phase of PHASES) {
    const p = join(STAGES_DIR, phase, `${slug}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

// Parse the adds.<field> list items from a contribution's frontmatter.
function parseAddsList(fm: string, field: string): string[] {
  const addsMatch = fm.match(/^adds:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m);
  if (!addsMatch) return [];
  const block = addsMatch[1];
  const fieldMatch = block.match(new RegExp(`^  ${field}:\\n((?:    - [\\w-]+\\n?)*)`, "m"));
  if (!fieldMatch) return [];
  return [...fieldMatch[1].matchAll(/^    - ([\w-]+)/gm)].map((m) => m[1]);
}

// Append items to an existing top-level list field, right before the next
// top-level key. Skips items already present. MVP only augments an existing
// list (never creates one) — build-and-test etc. already declare produces/sensors.
function appendToListField(content: string, field: string, items: string[]): string {
  if (items.length === 0) return content;
  const re = new RegExp(`^(${field}:\\n(?:  - .+\\n)*)`, "m");
  const m = content.match(re);
  if (!m) return content;
  const existing = new Set([...m[1].matchAll(/^  - (.+)$/gm)].map((x) => x[1].trim()));
  const toAdd = items.filter((i) => !existing.has(i));
  if (toAdd.length === 0) return content;
  const additions = toAdd.map((i) => `  - ${i}`).join("\n") + "\n";
  return content.replace(re, m[1] + additions);
}

for (const phase of readdirSync(CONTRIB_DIR)) {
  const phaseDir = join(CONTRIB_DIR, phase);
  let files: string[];
  try { files = readdirSync(phaseDir); } catch { continue; }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const content = readFileSync(join(phaseDir, file), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];

    const targetMatch = fm.match(/^target:\s*(.+)$/m);
    if (!targetMatch) continue;
    const target = targetMatch[1].trim();

    const stageFile = findStageFile(target);
    if (!stageFile) {
      console.error(`compose-contributions: target "${target}" not found, skipping ${file}`);
      continue;
    }

    const produces = parseAddsList(fm, "produces");
    const sensors = parseAddsList(fm, "sensors");
    if (produces.length === 0 && sensors.length === 0) continue;

    let stageContent = readFileSync(stageFile, "utf-8");
    stageContent = appendToListField(stageContent, "produces", produces);
    stageContent = appendToListField(stageContent, "sensors", sensors);
    writeFileSync(stageFile, stageContent);
  }
}
