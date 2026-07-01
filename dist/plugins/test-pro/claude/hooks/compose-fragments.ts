#!/usr/bin/env bun
// compose-fragments.ts — splice a plugin's contribution PROSE fragments into
// the target stage's body. This is the prose half of the contribution seam
// (compose-contributions.ts handles the structural half: produces/sensors).
//
// A contribution declares, in frontmatter:
//   fragments:
//     - anchor: after-step:9      # where to splice
//       order: 100               # cross-contribution ordering
// and, in the body, one `## fragment: <anchor>` block per entry (paired
// positionally with the frontmatter list — Nth block ↔ Nth entry).
//
// Anchors:
//   after-step:<n>   — after `### Step <n>`'s content (before the next ### or ##)
//   before-step:<n>  — immediately before `### Step <n>`
//   end-of-steps     — at the end of the `## Steps` block
//   in:<Compartment> — at the end of the named `## <Compartment>` block
//
// Ordering within an anchor: (order, bundle). Idempotent: a fragment already
// present (matched by its heading line) is not re-spliced, so re-running on
// every SessionStart is safe.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT!;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR!;
const STAGES_DIR = join(PROJECT_DIR, ".claude", "aidlc-common", "stages");
const CONTRIB_DIR = join(PLUGIN_ROOT, "contributions");
const HARNESS_LEAF = ".claude";

if (!existsSync(CONTRIB_DIR) || !existsSync(STAGES_DIR)) process.exit(0);

const PHASES = ["initialization", "ideation", "inception", "construction", "operation"];

interface Fragment {
  anchor: string;
  order: number;
  bundle: string;
  prose: string;
}

function findStageFile(slug: string): string | null {
  for (const phase of PHASES) {
    const p = join(STAGES_DIR, phase, `${slug}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

// Parse a contribution file into { target, bundle, fragments[] }.
function parseContribution(content: string): { target: string; bundle: string; fragments: Fragment[] } | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const body = fmMatch[2];

  const target = fm.match(/^target:\s*(.+)$/m)?.[1].trim();
  if (!target) return null;
  const bundle = fm.match(/^bundle:\s*(.+)$/m)?.[1].trim() ?? "";

  // Frontmatter fragments list: ordered (anchor, order) pairs.
  const fragMeta: Array<{ anchor: string; order: number }> = [];
  const fragBlockMatch = fm.match(/^fragments:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m);
  if (fragBlockMatch) {
    // Each entry: `  - anchor: X\n    order: N`
    const entryRe = /-\s*anchor:\s*(\S+)\s*\n\s*order:\s*(\d+)/g;
    for (const m of fragBlockMatch[1].matchAll(entryRe)) {
      fragMeta.push({ anchor: m[1], order: Number(m[2]) });
    }
  }
  if (fragMeta.length === 0) return { target, bundle, fragments: [] };

  // Body `## fragment: <anchor>` blocks, in document order (paired positionally).
  const blocks: Array<{ anchor: string; prose: string }> = [];
  const blockRe = /^## fragment:\s*(\S+)\s*\n([\s\S]*?)(?=^## fragment:|$(?![\s\S]))/gm;
  for (const m of body.matchAll(blockRe)) {
    blocks.push({ anchor: m[1], prose: m[2].trim() });
  }

  // Pair positionally; the anchors must agree (they do in authored files).
  const fragments: Fragment[] = [];
  for (let i = 0; i < fragMeta.length && i < blocks.length; i++) {
    fragments.push({
      anchor: fragMeta[i].anchor,
      order: fragMeta[i].order,
      bundle,
      prose: blocks[i].prose.replace(/\{\{HARNESS_DIR\}\}/g, HARNESS_LEAF),
    });
  }
  return { target, bundle, fragments };
}

// Splice a block of prose into `content` at the position returned by `locate`.
// Returns content unchanged if the fragment heading is already present.
function splice(content: string, prose: string, insertAt: number): string {
  return content.slice(0, insertAt) + "\n" + prose + "\n" + content.slice(insertAt);
}

// Resolve an anchor to a character offset in the stage content. Returns -1 if
// the anchor target isn't found (fragment skipped, logged).
function locateAnchor(content: string, anchor: string): number {
  if (anchor.startsWith("after-step:")) {
    const n = anchor.slice("after-step:".length);
    // End of `### Step <n>...` block = just before the next `### ` or `## `.
    const stepRe = new RegExp(`^### Step ${n}\\b.*$`, "m");
    const m = content.match(stepRe);
    if (!m) return -1;
    const from = m.index! + m[0].length;
    const nextHeading = content.slice(from).search(/^#{2,3} /m);
    return nextHeading === -1 ? content.length : from + nextHeading;
  }
  if (anchor.startsWith("before-step:")) {
    const n = anchor.slice("before-step:".length);
    const m = content.match(new RegExp(`^### Step ${n}\\b.*$`, "m"));
    return m ? m.index! : -1;
  }
  if (anchor === "end-of-steps") {
    const steps = content.match(/^## Steps\b.*$/m);
    if (!steps) return -1;
    const from = steps.index! + steps[0].length;
    const nextH2 = content.slice(from).search(/^## /m);
    return nextH2 === -1 ? content.length : from + nextH2;
  }
  if (anchor.startsWith("in:")) {
    const compartment = anchor.slice("in:".length);
    const m = content.match(new RegExp(`^## ${compartment}\\b.*$`, "m"));
    if (!m) return -1;
    const from = m.index! + m[0].length;
    const nextH2 = content.slice(from).search(/^## /m);
    return nextH2 === -1 ? content.length : from + nextH2;
  }
  return -1;
}

// First line of the prose (the `### ...` heading) — used for idempotency.
function fragmentHeading(prose: string): string {
  return prose.split("\n")[0].trim();
}

for (const phase of readdirSync(CONTRIB_DIR)) {
  const phaseDir = join(CONTRIB_DIR, phase);
  let files: string[];
  try { files = readdirSync(phaseDir); } catch { continue; }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const parsed = parseContribution(readFileSync(join(phaseDir, file), "utf-8"));
    if (!parsed || parsed.fragments.length === 0) continue;

    const stageFile = findStageFile(parsed.target);
    if (!stageFile) {
      console.error(`compose-fragments: target "${parsed.target}" not found, skipping ${file}`);
      continue;
    }

    let content = readFileSync(stageFile, "utf-8");

    // Group fragments by anchor; within an anchor, order by (order, bundle).
    const byAnchor = new Map<string, Fragment[]>();
    for (const f of parsed.fragments) {
      if (!byAnchor.has(f.anchor)) byAnchor.set(f.anchor, []);
      byAnchor.get(f.anchor)!.push(f);
    }

    for (const [anchor, frags] of byAnchor) {
      frags.sort((a, b) => a.order - b.order || a.bundle.localeCompare(b.bundle));
      // Insert in reverse so earlier insertions don't shift later offsets;
      // but we want final order = sorted asc at the same anchor point, so
      // build the combined block then splice once.
      const fresh = frags.filter((f) => !content.includes(fragmentHeading(f.prose)));
      if (fresh.length === 0) continue;
      const at = locateAnchor(content, anchor);
      if (at === -1) {
        console.error(`compose-fragments: anchor "${anchor}" not found in ${parsed.target}, skipping`);
        continue;
      }
      const combined = fresh.map((f) => f.prose).join("\n\n");
      content = splice(content, combined, at);
    }

    writeFileSync(stageFile, content);
  }
}
