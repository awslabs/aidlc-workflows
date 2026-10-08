// aidlc-includes.ts: what each harness reads the AI-DLC method from.
//
// The AIDLC method (the layered practice files org/team/project + phase rules)
// lives ONCE at the workspace root under aidlc/spaces/<space>/memory/. Each
// harness pulls it into ambient context through its OWN native include,
// evaluated by the CLI *before* AIDLC's engine runs:
//   - Claude: an @-import stub at <harness>/rules/aidlc.md naming each method file.
//   - Kiro CLI: a `resources` glob in each agents/*.json.
//   - Kiro IDE: an always-included steering file holding the memory text
//     (Kiro IDE does not expand file references in steering; see
//     kiroIdeSteering below).
//   - opencode: the `instructions` glob in the project-root opencode.json.
//   - Cursor: standing + phase read pointers in <harness>/rules/*.mdc.
//   - Copilot: @-import lines in AI-DLC's part of the root AGENTS.md.
//   - Codex has no include: the engine hands each step its rules.
//
// Every include names ONE fixed, git-ignored location, aidlc/active-memory/
// (ACTIVE_MEMORY_DIR): a copy of the active space's memory files that the
// engine refreshes (refreshActiveMemory) at session start, on a space switch or
// space create, when a specialist is dispatched, and with each step whose rules
// it sends in full. So a space switch changes no tracked file: the committed
// includes are the same for every teammate, and each person's copy follows
// their own gitignored active-space cursor. (Why a copy and not a link: Windows
// cannot portably create links, and Kiro's resources glob does not walk a
// linked root.) The engine's own resolver reads aidlc/spaces/<space>/memory/
// directly and never needs the copy.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  assertProjectionPathHasNoSymlinks,
  jsonEntriesIsSafe,
  managedBlockIsSafe,
  mergeBlock,
  mergeJsonEntries,
  type ProjectionDescriptor,
  readRootIntegrations,
  type RootIntegration,
  rootBlockPath,
  rootIntegrationTarget,
  unionBlocks,
} from "./aidlc-distribution.ts";
import { activeSpace, sessionsDir, writeFileAtomic } from "./aidlc-lib.ts";
import { discoverProjectHarnesses, runtimeHarnessName } from "./aidlc-runtime-paths.ts";

/** Workspace-relative POSIX memory path for a space: `aidlc/spaces/<space>/memory`.
 *  POSIX separators — these strings live in include files read identically on
 *  every OS. */
function spaceMemoryRel(space: string): string {
  return `aidlc/spaces/${space}/memory`;
}

// --- Kiro IDE: the memory text in the always-included steering file ----------
//
// Kiro IDE does not expand `#[[file:...]]` references in steering (measured on
// 1.2.4, #2023): a reference file gives the chat seven literal lines and none of
// the rules. Inline text does reach it, captured once when the chat starts and
// kept through summaries and reloads. So the steering file holds the active
// space's memory TEXT, written here from the memory files (the only source; a
// person edits those, never this file). It is gitignored and written again at
// each session start, on a space switch, and by `next` once the files changed.
// A memory too large to put in every chat keeps the reference form, and the
// engine then sends the rules with each step, as it does on every tool.

export const KIRO_IDE_STEERING = ".kiro/steering/aidlc-active-memory.md";

// The rule layers, in the order the memory resolver applies them; any other
// Markdown file beside them or under phases/ follows, sorted.
const MEMORY_LAYERS = [
  "org.md",
  "team.md",
  "project.md",
  "phases/ideation.md",
  "phases/inception.md",
  "phases/construction.md",
  "phases/operation.md",
];

// Inline text past this size would sit in every chat and every helper's
// context; the reference form is written instead.
const KIRO_IDE_INLINE_MAX_BYTES = 64 * 1024;

const KIRO_IDE_STEERING_HEAD = [
  "---",
  "inclusion: always",
  "---",
  "",
  "# AI-DLC Active Memory",
  "",
];

function memoryLayerFiles(memoryDir: string): string[] {
  const extra = (sub: string): string[] => {
    try {
      return readdirSync(join(memoryDir, sub), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => (sub ? `${sub}/${entry.name}` : entry.name))
        .filter((rel) => !MEMORY_LAYERS.includes(rel))
        .sort();
    } catch {
      return [];
    }
  };
  return [...MEMORY_LAYERS, ...extra(""), ...extra("phases")]
    .filter((rel) => {
      try {
        return lstatSync(join(memoryDir, rel)).isFile();
      } catch {
        return false;
      }
    });
}

function kiroIdeReferenceSteering(space: string): string {
  return [
    ...KIRO_IDE_STEERING_HEAD,
    "The following live workspace files are the active AI-DLC method and policy",
    "layers. They apply to the conductor and delegated agents.",
    "",
    ...MEMORY_LAYERS.map((rel) => `#[[file:${spaceMemoryRel(space)}/${rel}]]`),
    "",
  ].join("\n");
}

/** The memory files of `space` as inline blocks (`<memory-file path="...">`),
 *  with the project-relative path of each; null when the text cannot be put in
 *  a chat (a file that is not UTF-8, a memory too large, or no file at all).
 *  `only` limits it to those files (by their path under memory/). */
export function inlineMemoryFiles(
  projectDir: string,
  space: string,
  only?: readonly string[],
): { parts: string[]; inlined: string[]; bytes: number } | null {
  const rel = spaceMemoryRel(space);
  const memoryDir = join(projectDir, ...rel.split("/"));
  const parts: string[] = [];
  const inlined: string[] = [];
  let bytes = 0;
  for (const file of memoryLayerFiles(memoryDir).filter((name) => only === undefined || only.includes(name))) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(memoryDir, file)));
    } catch {
      return null;
    }
    bytes += Buffer.byteLength(text, "utf-8");
    if (bytes > KIRO_IDE_INLINE_MAX_BYTES) return null;
    parts.push(`<memory-file path="${rel}/${file}">\n${text}${text.endsWith("\n") ? "" : "\n"}</memory-file>\n`);
    inlined.push(`${rel}/${file}`);
  }
  return inlined.length === 0 ? null : { parts, inlined, bytes };
}

/** The steering file Kiro IDE should hold for `space`, and the memory files
 *  (project-relative) whose exact text it carries. `inlined` is empty when the
 *  text cannot be inlined (a file that is not UTF-8, or a memory too large). */
export function kiroIdeSteering(projectDir: string, space: string): { text: string; inlined: string[] } {
  const rel = spaceMemoryRel(space);
  const inline = inlineMemoryFiles(projectDir, space);
  if (inline === null) return { text: kiroIdeReferenceSteering(space), inlined: [] };
  const { parts, inlined } = inline;
  return {
    text: [
      ...KIRO_IDE_STEERING_HEAD,
      `<!-- AI-DLC writes this file from ${rel}/ for every chat. Do not edit it: edit those files instead. -->`,
      "",
      "The text of each file below is the active AI-DLC method and policy layers. They apply to the",
      "conductor and delegated agents.",
      "",
      parts.join("\n"),
    ].join("\n"),
    inlined,
  };
}

// The tree Kiro IDE (and Kiro CLI v3) runs; the Kiro CLI 2.0 tree shares `.kiro`.
function kiroIdeTree(projectDir: string): boolean {
  try {
    return runtimeHarnessName(projectDir, ".kiro") === "kiro-ide";
  } catch {
    return false;
  }
}

/** Write Kiro IDE's steering file for `space` when it differs from the memory
 *  files now. Returns whether it wrote. A no-op outside the Kiro IDE tree. */
export function refreshKiroIdeSteering(projectDir: string, space: string): boolean {
  if (!kiroIdeTree(projectDir)) return false;
  const path = join(projectDir, ...KIRO_IDE_STEERING.split("/"));
  const { text } = kiroIdeSteering(projectDir, space);
  if (readSafe(path) === text) return false;
  try {
    assertProjectionPathHasNoSymlinks(projectDir, KIRO_IDE_STEERING);
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, text);
    return true;
  } catch {
    // The chat gets the rules with each step instead.
    return false;
  }
}

// The steering file was committed before it carried the memory text. Git keeps
// tracking it after the .gitignore line lands, so every memory edit shows it
// as changed. Asked once per clone.
const TRACKED_STEERING_ASKED = "kiro-ide-steering-tracked-asked";

/** The one line the session start gives the agent when this clone's git still
 *  tracks Kiro IDE's steering file, or "" (also once it was asked, outside the
 *  Kiro IDE tree, or with no git). */
export function trackedKiroIdeSteeringAsk(projectDir: string): string {
  if (!kiroIdeTree(projectDir)) return "";
  const marker = join(sessionsDir(projectDir), TRACKED_STEERING_ASKED);
  if (existsSync(marker)) return "";
  // A repository's fsmonitor program is never run just to word this ask, the
  // same rule every git command AI-DLC runs for its own bookkeeping follows.
  const listed = spawnSync("git", [
    "-c", "core.fsmonitor=false", "ls-files", "--error-unmatch", "--", KIRO_IDE_STEERING,
  ], {
    cwd: projectDir,
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  // 0 tracked, 1 not tracked; anything else (no repository yet) asks later.
  if (listed.error || (listed.status !== 0 && listed.status !== 1)) return "";
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileAtomic(marker, `${new Date().toISOString()}\n`);
  } catch {
    // Not asked rather than asked in every chat.
    return "";
  }
  if (listed.status !== 0) return "";
  return "ASK ONCE: after you answer the person's message, ask them this in their language: " +
    `"Your repo tracks ${KIRO_IDE_STEERING}, which AI-DLC now rebuilds for each chat. ` +
    'Do you want me to stop tracking it? Your memory files stay as they are." ' +
    `On yes, run \`git rm --cached -- ${KIRO_IDE_STEERING}\` (the file stays on disk) and say it is done. ` +
    "On no, leave it. Do not ask again.";
}

// --- The copy every harness include reads ------------------------------------

/** Where the harness includes read the active space's method from: a copy of
 *  `aidlc/spaces/<space>/memory/`, git-ignored and refreshed by the engine. */
export const ACTIVE_MEMORY_DIR = "aidlc/active-memory";

function activeMemoryCopyDir(projectDir: string): string {
  return join(projectDir, ...ACTIVE_MEMORY_DIR.split("/"));
}

function spaceMemoryDir(projectDir: string, space: string): string {
  return join(projectDir, ...spaceMemoryRel(space).split("/"));
}

function sameBytes(left: string, right: string): boolean {
  try {
    return readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

/** The copy's files that are not the memory files of `space` now, by their path
 *  under memory/: missing or different ones, and ones the space no longer has.
 *  Empty when the copy is current. */
export function activeMemoryCopyDrift(projectDir: string, space: string): string[] {
  const source = spaceMemoryDir(projectDir, space);
  const copy = activeMemoryCopyDir(projectDir);
  const wanted = memoryLayerFiles(source);
  return [
    ...wanted.filter((rel) => !sameBytes(join(source, rel), join(copy, rel))),
    ...memoryLayerFiles(copy).filter((rel) => !wanted.includes(rel)),
  ];
}

/** Write the memory files of `space` into the copy, file by file, and remove
 *  copied files the space no longer has. Returns whether anything changed.
 *  Best effort: a file that cannot be copied leaves the chat to the rules the
 *  engine sends with each step, and never a write through a link. */
export function refreshActiveMemoryCopy(projectDir: string, space: string): boolean {
  const drift = activeMemoryCopyDrift(projectDir, space);
  if (drift.length === 0) return false;
  const source = spaceMemoryDir(projectDir, space);
  const copy = activeMemoryCopyDir(projectDir);
  const wanted = new Set(memoryLayerFiles(source));
  let changed = false;
  for (const rel of drift) {
    const target = join(copy, rel);
    try {
      assertProjectionPathHasNoSymlinks(projectDir, `${ACTIVE_MEMORY_DIR}/${rel}`);
      if (!wanted.has(rel)) {
        rmSync(target, { force: true });
      } else {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(source, rel)));
        mkdirSync(dirname(target), { recursive: true });
        writeFileAtomic(target, text);
      }
      changed = true;
    } catch {
      // This file stays as it was.
    }
  }
  return changed;
}

/** Bring what the harnesses read for `space` up to date: the memory copy, and
 *  on the Kiro IDE tree the steering file that carries the memory text.
 *  Returns the workspace-relative paths written. `space` omitted means the
 *  active-space cursor (cursorless: `default`). */
export function refreshActiveMemory(projectDir: string, space?: string): string[] {
  const sp = space ?? activeSpace(projectDir);
  const written: string[] = [];
  if (refreshActiveMemoryCopy(projectDir, sp)) written.push(ACTIVE_MEMORY_DIR);
  if (refreshKiroIdeSteering(projectDir, sp)) written.push(KIRO_IDE_STEERING);
  return written;
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// --- AI-DLC's part of the team's root files ---------------------------------
//
// A copy runtime leaves the team's .gitignore and AGENTS.md out (a copy would
// replace them) and ships AI-DLC's part of each in root-blocks. Where config
// never ran (no harness in the project has its install record), this adds that
// part with config's own rule, at the same two moments as the includes: after
// the team's content, or as the whole file when there is none. A part that is
// exactly what a release shipped is brought up to date; a part the team
// changed, and every file config or the Cursor installer manages, is left as
// it is. Best-effort: a file that cannot be read or merged is skipped, never
// corrupted, and nothing outside the project is read or written.
export function addRootBlocks(projectDir: string): string[] {
  const written: string[] = [];
  const parts = new Map<string, {
    integration: RootIntegration;
    contributors: Array<{ distribution: string; text: string }>;
    legacy: Set<string>;
    configured: boolean;
  }>();
  // AI-DLC's part of a team's JSON file (opencode.json), from root-blocks.
  const entryParts = new Map<string, { distribution: string; text: string; configured: boolean }>();
  let harnesses: ReturnType<typeof discoverProjectHarnesses>;
  try {
    harnesses = discoverProjectHarnesses(projectDir);
  } catch {
    return written;
  }
  for (const harness of harnesses) {
    const data = join(harness.root, "tools", "data");
    let descriptor: ProjectionDescriptor;
    try {
      descriptor = JSON.parse(readFileSync(join(data, "aidlc-projection.json"), "utf-8")) as ProjectionDescriptor;
      if (descriptor.harnessDir !== harness.harnessDir || descriptor.distribution !== harness.distribution) continue;
    } catch {
      continue;
    }
    const configured = existsSync(join(data, "aidlc-manifest.json"));
    const integrations = readRootIntegrations(descriptor.rootIntegrations);
    for (const integration of (Array.isArray(integrations) ? integrations : []) as RootIntegration[]) {
      if (integration?.policy === "json-entries" && jsonEntriesIsSafe(integration)) {
        const partPath = rootBlockPath(harness.root, integration);
        try {
          assertProjectionPathHasNoSymlinks(projectDir, relative(projectDir, partPath).split(sep).join("/"));
        } catch {
          continue;
        }
        const text = readSafe(partPath);
        const known = entryParts.get(integration.path);
        if (text !== null && (!known || harness.distribution.localeCompare(known.distribution) < 0)) {
          entryParts.set(integration.path, { distribution: harness.distribution, text, configured: configured || Boolean(known?.configured) });
        } else if (known) {
          known.configured ||= configured;
        }
        continue;
      }
      // Config's own check on a managed block: a path inside the project and a
      // plain marker, and no symlink on the way to the copy in root-blocks.
      if (integration?.policy !== "managed-block" || !managedBlockIsSafe(integration)) continue;
      const blockPath = rootBlockPath(harness.root, integration);
      try {
        assertProjectionPathHasNoSymlinks(projectDir, relative(projectDir, blockPath).split(sep).join("/"));
      } catch {
        continue;
      }
      const text = readSafe(blockPath);
      if (text === null) continue;
      const part = parts.get(integration.path) ?? {
        integration,
        contributors: [],
        legacy: new Set<string>(),
        configured: false,
      };
      part.contributors.push({ distribution: harness.distribution, text });
      for (const hash of integration.legacySignatures?.wholeFileHashes ?? []) part.legacy.add(hash);
      part.configured ||= configured;
      parts.set(integration.path, part);
    }
  }
  for (const [path, part] of parts) {
    if (part.configured) continue;
    const shipped = part.integration.shared === "union"
      ? unionBlocks(part.contributors)
      : [...part.contributors].sort((left, right) => left.distribution.localeCompare(right.distribution))[0].text;
    const target = join(projectDir, path);
    let current = "";
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) continue;
      if (stat) {
        const bytes = readFileSync(target);
        current = bytes.toString("utf-8");
        if (!Buffer.from(current, "utf-8").equals(bytes)) continue;
      }
    } catch {
      continue;
    }
    // A file the Cursor installer manages already holds AI-DLC's part, under
    // that installer's own markers; it stays the installer's to update.
    if (/^(?:# |<!-- )BEGIN AIDLC [A-Z]+/m.test(current)) continue;
    const merged = mergeBlock(path, current, shipped, part.integration.marker || basename(path), [...part.legacy]);
    if (merged.error || merged.value === undefined || merged.value === current) continue;
    if (merged.currentHash && !merged.currentBlockShipped) continue;
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      writeFileAtomic(target, merged.value);
      written.push(path);
    } catch {
      // Leave the file as it was; the next session or config tries again.
    }
  }
  for (const [key, part] of entryParts) {
    if (part.configured) continue;
    // The team's file (the opencode.jsonc a team keeps, for opencode.json).
    const path = rootIntegrationTarget(projectDir, key);
    const target = join(projectDir, path);
    let current = "";
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.size > MAX_ENTRY_FILE_BYTES)) continue;
      if (stat) {
        const bytes = readFileSync(target);
        current = bytes.toString("utf-8");
        if (!Buffer.from(current, "utf-8").equals(bytes)) continue;
      }
    } catch {
      continue;
    }
    // With no record, only entries that name AI-DLC's own folders are read
    // as AI-DLC's; the team's keys and values stay theirs.
    const merged = mergeJsonEntries(current, part.text, { kind: "none" });
    if ("conflict" in merged || merged.text === current) continue;
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      writeFileAtomic(target, merged.text);
      written.push(path);
    } catch {
      // Leave the file as it was; the next session or config tries again.
    }
  }
  return written;
}

// A team settings file this large is not one AI-DLC adds its part to at session start.
const MAX_ENTRY_FILE_BYTES = 1024 * 1024;
