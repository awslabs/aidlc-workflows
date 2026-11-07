// AI-DLC's own words, read from the AI-DLC this project has installed. Only a file the install manifest
// (aidlc-manifest.json) lists, with the hash it recorded, counts: a file edited since, a plugin's (recorded
// in its own plugin-owned record) and a team's stage file are not AI-DLC's. From those files: the stages
// whose stage file is listed, and their phases (stage-graph.json); the agents, hooks, sensors, scopes and
// tools; and every string literal in the tools and hooks (event names, statuses, finding ids). A value that
// is one of these is AI-DLC's and can be sent as it is; any other value is the person's, and lib-shape.ts
// gives it an anonymous label instead. The same files give AI-DLC's own message text (`phrases`): the fixed parts
// of its messages, which the report may quote as they are. Not covered: files a team had in a copied tree before its
// first AI-DLC setup, which that setup records as its own.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Vocab = {
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
};

export function emptyVocab(): Vocab {
  return {
    words: new Set(),
    stages: new Set(),
    phases: new Set(),
    agents: new Set(),
    scopes: new Set(),
    sensors: new Set(),
    hooks: new Set(),
    tools: new Set(),
    guards: new Set(),
    phrases: new Set(),
  };
}

// The fixed parts of AI-DLC's messages: each string literal, and each part of a template literal between its
// `${…}` slots, line by line, of three words and sixteen characters or more (`Cannot request review pass`,
// `Do not ask the reviewer again; include the findings in the approval summary for the human.`). What a message
// fills into its slots (a stage, a path) is not in them.
const STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const TEMPLATE = /`((?:[^`\\]|\\.)*)`/gs;
const SLOT = /\$\{(?:[^{}]|\{[^{}]*\})*\}/g;
function addPhrases(into: Set<string>, text: string): void {
  const keep = (piece: string) => {
    const t = piece.replace(/\\(["'`\\])/g, "$1").trim();
    if (t.length >= 16 && t.length <= 400 && t.split(/\s+/).length >= 3 && /[A-Za-z]/.test(t)) into.add(t);
  };
  for (const m of text.matchAll(TEMPLATE)) for (const part of m[1].split(SLOT)) for (const line of part.split(/\\n|\n/)) keep(line);
  for (const m of text.replace(TEMPLATE, "``").matchAll(STRING)) for (const line of (m[1] ?? m[2]).split(/\\n/)) keep(line);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// A quoted literal that reads as a word or a short phrase: `"STAGE_STARTED"`, `'gate-unresolved'`,
// `"in-progress"`. A template literal's text is built at run time; only its opening words are taken, for
// the finding ids doctor makes from a check's label.
const LITERAL = /"([A-Za-z][A-Za-z0-9 _.:/-]{0,59})"|'([A-Za-z][A-Za-z0-9 _.:/-]{0,59})'/g;
const TEMPLATE_HEAD = /`([A-Za-z][^`$\n]{2,80})/g;

// `findingId`: doctor's own findingIdFromLabel; `holds`: AI-DLC's holdsRecordedWrite, so a tree checked out with
// other line endings (git core.autocrlf) still counts as unchanged. Both from the same install
// (lib-project.ts importAidlcTools); without `holds` only the exact bytes match.
export function loadVocab(
  project: string,
  treeDirs: string[],
  findingId?: (label: string) => string,
  holds: (content: Buffer, hash: string) => boolean = (content, hash) => hash === `sha256:${createHash("sha256").update(content).digest("hex")}`,
): Vocab {
  const v = emptyVocab();
  for (const dir of treeDirs) {
    const data = join(project, dir, "tools", "data");
    const manifest = readJson<{ files?: Record<string, unknown> }>(join(data, "aidlc-manifest.json"));
    const shipped = new Set<string>();
    for (const [file, hash] of Object.entries(manifest?.files ?? {})) {
      const path = join(project, file);
      if (typeof hash !== "string" || !existsSync(path)) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      if (!holds(bytes, hash)) continue;
      shipped.add(file.replaceAll("\\", "/"));
      const parts = file.split(/[\\/]/);
      const kind = parts[parts.length - 2];
      const base = parts[parts.length - 1];
      const name = base.replace(/\.(?:md|json|ts|toml|yaml|yml)$/, "");
      if (kind === "agents") v.agents.add(name);
      else if (kind === "hooks") v.hooks.add(name.replace(/^aidlc-/, ""));
      else if (kind === "sensors") v.sensors.add(name.replace(/^aidlc-/, ""));
      // A scope is named by its file's `name:` (`feature` in aidlc-feature.md), the word the state file writes.
      else if (kind === "scopes") {
        v.scopes.add(name);
        const declared = bytes.toString("utf8").match(/^name:\s*([a-z][a-z0-9-]{0,40})\s*$/m)?.[1];
        if (declared) v.scopes.add(declared);
      }
      else if (kind === "tools" && base.endsWith(".ts")) {
        v.tools.add(base);
        v.tools.add(name);
      }
      if (base.endsWith(".ts") && (kind === "tools" || kind === "hooks")) {
        const text = bytes.toString("utf8");
        addPhrases(v.phrases, text);
        for (const m of text.matchAll(LITERAL)) {
          v.words.add(m[1] ?? m[2]);
          if (findingId) v.words.add(findingId(m[1] ?? m[2]));
        }
        if (findingId) for (const m of text.matchAll(TEMPLATE_HEAD)) v.words.add(findingId(m[1]));
        // The guards: the fence list AI-DLC declares (GUARD_FENCES).
        if (base === "aidlc-guard-fences.ts") {
          const list = text.match(/GUARD_FENCES\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
          for (const m of list.matchAll(LITERAL)) v.guards.add(m[1] ?? m[2]);
        }
      }
    }
    const graph = readJson<{ slug?: unknown; phase?: unknown; plugin?: unknown }[]>(join(data, "stage-graph.json"));
    for (const node of Array.isArray(graph) ? graph : []) {
      if (node.plugin !== undefined || typeof node.slug !== "string" || typeof node.phase !== "string") continue;
      if (!shipped.has(`${dir}/aidlc-common/stages/${node.phase}/${node.slug}.md`)) continue;
      v.stages.add(node.slug);
      v.phases.add(node.phase);
    }
  }
  for (const set of [v.stages, v.phases, v.agents, v.scopes, v.sensors, v.hooks, v.tools, v.guards]) for (const w of set) v.words.add(w);
  return v;
}
