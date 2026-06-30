#!/usr/bin/env bun
// compose-contributions.ts — merge a plugin's contribution files into the
// COMPILED stage-graph.json (not the stage .md files). This avoids fragile YAML
// manipulation: we let the base graph compile as normal (from unmodified stage
// files), then post-process the compiled JSON to union in the contribution's
// structural surfaces (produces, consumes, sensors).
//
// This runs AFTER aidlc-graph compile, not before.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT!;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR!;
const GRAPH_PATH = join(PROJECT_DIR, ".claude", "tools", "data", "stage-graph.json");
const CONTRIB_DIR = join(PLUGIN_ROOT, "contributions");

if (!existsSync(CONTRIB_DIR) || !existsSync(GRAPH_PATH)) process.exit(0);

interface ContribAdds {
  produces: string[];
  consumes: Array<{ artifact: string; required: boolean }>;
  sensors: string[];
}

interface GraphStage {
  slug: string;
  produces: string[];
  consumes: Array<{ artifact: string; required: boolean; conditional_on?: string }>;
  sensors_applicable?: Array<{ id: string }>;
  [key: string]: any;
}

function parseContributionAdds(content: string): { target: string; adds: ContribAdds } | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;
  const fm = frontmatterMatch[1];

  const targetMatch = fm.match(/^target:\s*(.+)$/m);
  if (!targetMatch) return null;
  const target = targetMatch[1].trim();

  const adds: ContribAdds = { produces: [], consumes: [], sensors: [] };

  // Extract the adds: block
  const addsMatch = fm.match(/^adds:\n([\s\S]*?)(?=^fragments:|^---$|$(?![\s\S]))/m);
  if (!addsMatch) return { target, adds };
  const addsBlock = addsMatch[1];

  // produces
  const producesMatch = addsBlock.match(/produces:\n((?:\s+- [\w-]+\n?)*)/);
  if (producesMatch) {
    adds.produces = [...producesMatch[1].matchAll(/^\s+- ([\w-]+)/gm)].map(m => m[1]);
  }

  // consumes
  const consumesMatch = addsBlock.match(/consumes:\n((?:\s+- (?:artifact|required).*\n?)*)/);
  if (consumesMatch) {
    const artifacts = [...consumesMatch[1].matchAll(/artifact:\s*([\w-]+)/g)];
    const requireds = [...consumesMatch[1].matchAll(/required:\s*(true|false)/g)];
    adds.consumes = artifacts.map((m, i) => ({
      artifact: m[1],
      required: requireds[i]?.[1] !== "false",
    }));
  }

  // sensors
  const sensorsMatch = addsBlock.match(/sensors:\n((?:\s+- [\w-]+\n?)*)/);
  if (sensorsMatch) {
    adds.sensors = [...sensorsMatch[1].matchAll(/^\s+- ([\w-]+)/gm)].map(m => m[1]);
  }

  return { target, adds };
}

// Load the compiled graph
const graph: GraphStage[] = JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
let modified = false;

// Walk contribution files
for (const phase of readdirSync(CONTRIB_DIR)) {
  const phaseDir = join(CONTRIB_DIR, phase);
  let entries: string[];
  try { entries = readdirSync(phaseDir); } catch { continue; }
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const content = readFileSync(join(phaseDir, file), "utf-8");
    const parsed = parseContributionAdds(content);
    if (!parsed) continue;

    const node = graph.find(s => s.slug === parsed.target);
    if (!node) {
      console.error(`compose-contributions: target "${parsed.target}" not in graph, skipping ${file}`);
      continue;
    }

    // Union produces
    if (parsed.adds.produces.length) {
      const existing = new Set(node.produces || []);
      for (const p of parsed.adds.produces) {
        if (!existing.has(p)) {
          node.produces.push(p);
          modified = true;
        }
      }
    }

    // Union consumes
    if (parsed.adds.consumes.length) {
      const existingArtifacts = new Set((node.consumes || []).map(c => c.artifact));
      for (const c of parsed.adds.consumes) {
        if (!existingArtifacts.has(c.artifact)) {
          node.consumes.push(c);
          modified = true;
        }
      }
    }

    // Union sensors
    if (parsed.adds.sensors.length) {
      const existing = new Set((node.sensors_applicable || []).map(s => s.id));
      if (!node.sensors_applicable) node.sensors_applicable = [];
      for (const id of parsed.adds.sensors) {
        if (!existing.has(id)) {
          node.sensors_applicable.push({ id });
          modified = true;
        }
      }
    }
  }
}

if (modified) {
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + "\n");
}
