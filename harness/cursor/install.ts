#!/usr/bin/env bun
// Non-destructive installer for dist/cursor. It preserves project-owned files,
// structurally merges Cursor's shared JSON surfaces, and refuses ambiguous
// collisions before writing any part of the distribution.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST_ROOT = dirname(fileURLToPath(import.meta.url));
const AGENTS_BEGIN = "<!-- BEGIN AIDLC CURSOR -->";
const AGENTS_END = "<!-- END AIDLC CURSOR -->";
const GITIGNORE_BEGIN = "# BEGIN AIDLC CURSOR";
const GITIGNORE_END = "# END AIDLC CURSOR";
const RECEIPT_REL = ".cursor/aidlc-install.json";

type JsonObject = Record<string, unknown>;
type WriteAction =
  | { kind: "copy"; source: string; target: string }
  | { kind: "write"; target: string; content: string | Buffer }
  | { kind: "remove"; target: string };

interface InstallReceipt {
  schemaVersion: 1;
  managedFiles: Record<string, string>;
}

function assertNoSymlinks(
  path: string,
  targetRoot: string,
  recursive = true,
): void {
  const root = resolve(targetRoot);
  const candidate = resolve(path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${path}: installer target resolves outside ${root}`);
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const label = relative(root, candidate).replaceAll("\\", "/") || ".";
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}: symlinked installer targets are not allowed`);
  }
  if (!recursive || !stat.isDirectory()) return;
  for (const name of readdirSync(candidate)) {
    assertNoSymlinks(join(candidate, name), root);
  }
}

function assertSafeManagedTree(targetRoot: string): void {
  assertNoSymlinks(targetRoot, targetRoot, false);
  for (const rel of [".cursor", "aidlc", "AGENTS.md", ".gitignore"]) {
    assertNoSymlinks(join(targetRoot, rel), targetRoot);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(path: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`${path}: malformed JSON (${error instanceof Error ? error.message : error})`);
  }
  if (!isObject(parsed)) throw new Error(`${path}: expected a JSON object`);
  return parsed;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readReceipt(path: string): InstallReceipt | null {
  if (!existsSync(path)) return null;
  const parsed = parseObject(path);
  if (parsed.schemaVersion !== 1 || !isObject(parsed.managedFiles)) {
    throw new Error(`${path}: unsupported or malformed AI-DLC install receipt`);
  }
  const managedFiles: Record<string, string> = {};
  for (const [file, hash] of Object.entries(parsed.managedFiles)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`${path}: invalid managed-file hash for ${file}`);
    }
    managedFiles[file] = hash;
  }
  return { schemaVersion: 1, managedFiles };
}

function activeSpaceFor(targetRoot: string): string {
  const pointer = join(targetRoot, "aidlc", "active-space");
  if (!existsSync(pointer)) return "default";
  const space = readFileSync(pointer, "utf-8").trim();
  return /^[a-z0-9][a-z0-9._-]*$/.test(space) ? space : "default";
}

function parseBufferObject(content: Buffer, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch (error) {
    throw new Error(`${label}: malformed JSON (${error instanceof Error ? error.message : error})`);
  }
  if (!isObject(parsed)) throw new Error(`${label}: expected a JSON object`);
  return parsed;
}

function activePluginSelection(targetRoot: string): string[] | null {
  const path = join(targetRoot, ".cursor", "tools", "data", "harness.json");
  if (!existsSync(path)) return null;
  const parsed = parseObject(path);
  if (!Object.hasOwn(parsed, "plugins")) return null;
  return stringArray(parsed.plugins, `${path}: plugins`);
}

interface StageContribRecord {
  produces?: string[];
  sensors?: string[];
  consumes?: string[];
  scopes?: string[];
  required_sections?: string[];
  required_sections_created?: boolean;
}

interface PluginStageState {
  records: PluginStageRecord[];
  unsafe: boolean;
}

interface PluginSidecar {
  path: string;
  data: JsonObject;
  dirty: boolean;
}

interface PluginStageRecord {
  slug: string;
  record: StageContribRecord;
  raw: JsonObject;
  sidecar: PluginSidecar;
}

interface PluginRuntimeState {
  composed: boolean;
  stages: Map<string, PluginStageState>;
  sidecars: PluginSidecar[];
}

interface PluginFragment {
  plugin: string;
  anchor: string;
  order: number;
  block: string;
  start: number;
  end: number;
}

interface ConsumeEntry {
  artifact: string;
  required: boolean;
  conditional_on?: string;
}

function stageContribRecord(value: unknown): StageContribRecord | null {
  if (!isObject(value)) return null;
  const record: StageContribRecord = {};
  for (const field of [
    "produces",
    "sensors",
    "consumes",
    "scopes",
    "required_sections",
  ] as const) {
    const entries = value[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      return null;
    }
    record[field] = entries;
  }
  if (value.required_sections_created !== undefined) {
    if (typeof value.required_sections_created !== "boolean") return null;
    record.required_sections_created = value.required_sections_created;
  }
  return record;
}

function pluginRuntimeState(targetRoot: string): PluginRuntimeState {
  const state: PluginRuntimeState = {
    composed: false,
    stages: new Map<string, PluginStageState>(),
    sidecars: [],
  };
  const stageState = (slug: string): PluginStageState => {
    const current = state.stages.get(slug);
    if (current) return current;
    const created = { records: [], unsafe: false };
    state.stages.set(slug, created);
    return created;
  };
  const dataDir = join(targetRoot, ".cursor", "tools", "data");
  try {
    for (const name of readdirSync(dataDir).sort()) {
      if (!name.startsWith("plugin-contrib-") || !name.endsWith(".json")) continue;
      state.composed = true;
      try {
        const path = join(dataDir, name);
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        if (isObject(parsed)) {
          const sidecar = { path, data: parsed, dirty: false };
          state.sidecars.push(sidecar);
          for (const [slug, value] of Object.entries(parsed)) {
            const target = stageState(slug);
            const record = stageContribRecord(value);
            if (record && isObject(value)) {
              target.records.push({ slug, record, raw: value, sidecar });
            }
            else target.unsafe = true;
          }
        }
      } catch {
        // The sidecar's presence still proves composition; collision handling
        // remains conservative when its per-stage record is unreadable.
      }
    }
  } catch {
    // Fall through to graph/source evidence.
  }
  try {
    const graph = JSON.parse(
      readFileSync(join(dataDir, "stage-graph.json"), "utf-8"),
    ) as Array<{ plugin?: unknown }>;
    if (graph.some((stage) => typeof stage.plugin === "string")) state.composed = true;
  } catch {
    // Fall through to prose-fragment evidence.
  }
  const stagesDir = join(targetRoot, ".cursor", "aidlc-common", "stages");
  try {
    for (const path of filesUnder(stagesDir)) {
      if (!path.endsWith(".md")) continue;
      if (!readFileSync(path, "utf-8").includes("<!-- plugin:")) continue;
      state.composed = true;
      stageState(basename(path, ".md"));
    }
  } catch {
    // Existing sidecar/graph evidence remains usable.
  }
  return state;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashProse(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pluginFragments(content: string): PluginFragment[] | null {
  const fragments: PluginFragment[] = [];
  const open =
    /<!-- plugin:([^:\n]+):(.+):(\d+):([0-9a-f]+) -->/g;
  let match = open.exec(content);
  while (match) {
    const [marker, plugin, anchor, orderRaw, hash] = match;
    const close = `<!-- /plugin:${plugin}:${anchor}:${orderRaw}:${hash} -->`;
    const proseStart = match.index + marker.length;
    const closeIndex = content.indexOf(close, proseStart);
    if (
      closeIndex === -1 ||
      content[proseStart] !== "\n" ||
      content[closeIndex - 1] !== "\n"
    ) {
      return null;
    }
    const prose = content.slice(proseStart + 1, closeIndex - 1);
    if (hashProse(prose) !== hash) return null;
    const end = closeIndex + close.length;
    fragments.push({
      plugin,
      anchor,
      order: Number(orderRaw),
      block: content.slice(match.index, end),
      start: match.index,
      end,
    });
    open.lastIndex = end;
    match = open.exec(content);
  }
  return fragments;
}

function scalarValue(raw: string): string {
  const value = raw.trim();
  const quoted = value.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : value;
}

function listFieldValues(content: string, field: string): string[] | null {
  if (new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m").test(content)) return [];
  const block = content.match(new RegExp(`^${field}:\\n((?: {2}- .+\\n)*)`, "m"));
  if (!block) return null;
  return [...block[1].matchAll(/^ {2}- (.+?)\s*$/gm)].map((entry) =>
    scalarValue(entry[1])
  );
}

function consumeEntries(content: string, artifacts: ReadonlySet<string>): ConsumeEntry[] | null {
  if (artifacts.size === 0) return [];
  const block = content.match(
    /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m,
  )?.[1];
  if (block === undefined) return null;
  const found = new Map<string, ConsumeEntry>();
  for (const match of block.matchAll(
    /^ {2}- artifact:\s*([\w-]+).*\n((?: {4}(?:required|conditional_on):.*\n)*)/gm,
  )) {
    if (!artifacts.has(match[1])) continue;
    const required = match[2].match(/^ {4}required:\s*(true|false)\s*$/m)?.[1];
    if (!required || found.has(match[1])) return null;
    const conditionalOn = match[2].match(/^ {4}conditional_on:\s*(\S+)\s*$/m)?.[1];
    found.set(match[1], {
      artifact: match[1],
      required: required === "true",
      ...(conditionalOn ? { conditional_on: conditionalOn } : {}),
    });
  }
  if ([...artifacts].some((artifact) => !found.has(artifact))) return null;
  return [...found.values()];
}

function consumeArtifactValues(content: string): ReadonlySet<string> {
  return new Set(
    [...content.matchAll(/^ {2}- artifact:\s*([\w-]+)/gm)].map((entry) => entry[1]),
  );
}

function reconcileCoreOwnedContributions(source: Buffer, state: PluginStageState): void {
  const content = source.toString("utf-8");
  const coreValues = {
    produces: new Set(listFieldValues(content, "produces") ?? []),
    sensors: new Set(listFieldValues(content, "sensors") ?? []),
    consumes: consumeArtifactValues(content),
    scopes: new Set(listFieldValues(content, "scopes") ?? []),
    required_sections: new Set(listFieldValues(content, "required_sections") ?? []),
  };
  const coreHasRequiredSections =
    listFieldValues(content, "required_sections") !== null;

  for (const binding of state.records) {
    for (const field of [
      "produces",
      "sensors",
      "consumes",
      "scopes",
      "required_sections",
    ] as const) {
      const prior = binding.record[field] ?? [];
      const retained = prior.filter((value) => !coreValues[field].has(value));
      if (retained.length === prior.length) continue;
      if (retained.length > 0) binding.raw[field] = retained;
      else delete binding.raw[field];
      binding.record[field] = retained;
      binding.sidecar.dirty = true;
    }
    if (
      binding.record.required_sections_created === true &&
      coreHasRequiredSections
    ) {
      delete binding.raw.required_sections_created;
      delete binding.record.required_sections_created;
      binding.sidecar.dirty = true;
    }
    if (Object.keys(binding.raw).length === 0) {
      delete binding.sidecar.data[binding.slug];
      binding.sidecar.dirty = true;
    }
  }
}

function removeListValues(
  content: string,
  field: string,
  values: ReadonlySet<string>,
  dropEmptyField: boolean,
): string {
  const blockRe = new RegExp(`^${field}:\\n((?: {2}- .+\\n)*)`, "m");
  const match = content.match(blockRe);
  if (!match) return content;
  const entries = [...match[1].matchAll(/^ {2}- (.+)$/gm)].map((entry) => entry[1]);
  const removeIndexes = new Set<number>();
  const remaining = new Set(values);
  for (let index = 0; index < entries.length; index++) {
    if (remaining.delete(entries[index].trim())) removeIndexes.add(index);
  }
  for (const value of remaining) {
    const index = entries.findIndex(
      (entry, candidate) =>
        !removeIndexes.has(candidate) && scalarValue(entry) === value,
    );
    if (index !== -1) removeIndexes.add(index);
  }
  const kept = entries.filter((_, index) => !removeIndexes.has(index));
  const replacement =
    kept.length > 0
      ? `${field}:\n${kept.map((value) => `  - ${value}`).join("\n")}\n`
      : dropEmptyField
        ? ""
        : `${field}: []\n`;
  return content.replace(blockRe, replacement);
}

function removeConsumesEntries(content: string, artifacts: ReadonlySet<string>): string {
  const blockRe =
    /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m;
  const match = content.match(blockRe);
  if (!match) return content;
  const kept = [
    ...match[1].matchAll(
      /^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm,
    ),
  ]
    .filter((entry) => !artifacts.has(entry[1]))
    .map((entry) => entry[0]);
  const replacement =
    kept.length > 0 ? `consumes:\n${kept.join("")}` : "consumes: []\n";
  return content.replace(blockRe, replacement);
}

function stripPluginFragments(content: string, fragments: readonly PluginFragment[]): string {
  let stripped = content;
  for (const fragment of [...fragments].sort((left, right) => right.start - left.start)) {
    stripped = stripped.slice(0, fragment.start) + stripped.slice(fragment.end);
  }
  return stripped.replace(/\n{3,}/g, "\n\n");
}

function mergeListValues(content: string, field: string, values: readonly string[]): string | null {
  const items = [...new Set(values)];
  if (items.length === 0) return content;
  const emptyRe = new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m");
  if (emptyRe.test(content)) {
    return content.replace(
      emptyRe,
      `${field}:\n${items.map((item) => `  - ${item}`).join("\n")}`,
    );
  }
  const blockRe = new RegExp(`^(${field}:\\n(?: {2}- .+\\n)*)`, "m");
  const match = content.match(blockRe);
  if (!match) return null;
  const existing = new Set(
    [...match[1].matchAll(/^ {2}- (.+)$/gm)].map((entry) => scalarValue(entry[1])),
  );
  const additions = items.filter((item) => !existing.has(item));
  if (additions.length === 0) return content;
  return content.replace(
    blockRe,
    match[1] + additions.map((item) => `  - ${item}`).join("\n") + "\n",
  );
}

function mergeConsumes(content: string, entries: readonly ConsumeEntry[]): string | null {
  if (entries.length === 0) return content;
  const render = (entry: ConsumeEntry) =>
    `  - artifact: ${entry.artifact}\n    required: ${entry.required}` +
    (entry.conditional_on ? `\n    conditional_on: ${entry.conditional_on}` : "");
  const emptyRe = /^consumes:\s*\[\s*\]\s*$/m;
  if (emptyRe.test(content)) {
    return content.replace(emptyRe, `consumes:\n${entries.map(render).join("\n")}`);
  }
  const blockRe =
    /^(consumes:\n(?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m;
  const match = content.match(blockRe);
  if (!match) return null;
  const existing = new Set(
    [...match[1].matchAll(/- artifact:\s*([\w-]+)/g)].map((entry) => entry[1]),
  );
  const additions = entries.filter((entry) => !existing.has(entry.artifact));
  if (additions.length === 0) return content;
  return content.replace(
    blockRe,
    match[1] + additions.map(render).join("\n") + "\n",
  );
}

function mergeRequiredSections(content: string, values: readonly string[]): string | null {
  const items = [...new Set(values)];
  if (items.length === 0) return content;
  const render = (entries: readonly string[]) =>
    entries.map((entry) => `  - "${entry}"`).join("\n");
  const emptyRe = /^required_sections:\s*\[\s*\]\s*$/m;
  if (emptyRe.test(content)) {
    return content.replace(emptyRe, `required_sections:\n${render(items)}`);
  }
  const blockRe = /^(required_sections:\n(?: {2}- .+\n)*)/m;
  const match = content.match(blockRe);
  if (match) {
    const existing = new Set(
      [...match[1].matchAll(/^ {2}- (.+?)\s*$/gm)].map((entry) =>
        scalarValue(entry[1])
      ),
    );
    const additions = items.filter((item) => !existing.has(item));
    if (additions.length === 0) return content;
    return content.replace(blockRe, match[1] + render(additions) + "\n");
  }
  const frontmatterClose = content.match(/^---\r?\n[\s\S]*?\n(---)(?:\r?\n|$)/);
  if (!frontmatterClose) return null;
  const insertAt = frontmatterClose.index! + frontmatterClose[0].lastIndexOf("---");
  return (
    content.slice(0, insertAt) +
    `required_sections:\n${render(items)}\n` +
    content.slice(insertAt)
  );
}

function locateAnchor(content: string, anchor: string): number {
  const stepAnchor = (kind: "after" | "before"): number => {
    const number = anchor.slice(anchor.indexOf(":") + 1);
    if (!/^\d+$/.test(number)) return -1;
    const wanted = Number(number);
    let hit: { index: number; length: number } | null = null;
    for (const match of content.matchAll(/^### Step (\d+)(?:-(\d+))?\b.*$/gm)) {
      const low = Number(match[1]);
      const high = match[2] ? Number(match[2]) : low;
      if (wanted >= low && wanted <= high) {
        hit = { index: match.index!, length: match[0].length };
        break;
      }
    }
    if (!hit) return -1;
    if (kind === "before") return hit.index;
    const from = hit.index + hit.length;
    const next = content.slice(from).search(/^#{2,3} /m);
    return next === -1 ? content.length : from + next;
  };
  if (anchor.startsWith("after-step:")) return stepAnchor("after");
  if (anchor.startsWith("before-step:")) return stepAnchor("before");
  if (anchor === "end-of-steps") {
    const steps = content.match(/^## Steps\b.*$/m);
    if (!steps) return -1;
    const from = steps.index! + steps[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  if (anchor.startsWith("in:")) {
    const component = anchor.slice(3);
    if (!/^[\w -]+$/.test(component)) return -1;
    const heading = content.match(new RegExp(`^## ${escapeRegExp(component)}\\b.*$`, "m"));
    if (!heading) return -1;
    const from = heading.index! + heading[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  return -1;
}

function spliceFragment(content: string, fragment: PluginFragment): string | null {
  const plugin = escapeRegExp(fragment.plugin);
  const anchor = escapeRegExp(fragment.anchor);
  if (
    new RegExp(
      `<!-- plugin:${plugin}:${anchor}:${fragment.order}:[0-9a-f]+ -->`,
    ).test(content)
  ) {
    return null;
  }
  const peers: Array<{ order: number; plugin: string; start: number; end: number }> = [];
  for (const match of content.matchAll(
    new RegExp(`<!-- plugin:([^:]+):${anchor}:(\\d+):([0-9a-f]+) -->`, "g"),
  )) {
    const peerPlugin = match[1];
    const order = Number(match[2]);
    const close =
      `<!-- /plugin:${peerPlugin}:${fragment.anchor}:${order}:${match[3]} -->`;
    const closeIndex = content.indexOf(close, match.index!);
    if (closeIndex === -1) return null;
    peers.push({
      order,
      plugin: peerPlugin,
      start: match.index!,
      end: closeIndex + close.length,
    });
  }
  if (peers.length > 0) {
    const after = peers.find(
      (peer) =>
        peer.order > fragment.order ||
        (peer.order === fragment.order &&
          peer.plugin.localeCompare(fragment.plugin) > 0),
    );
    if (after) {
      return (
        content.slice(0, after.start) +
        fragment.block +
        "\n\n" +
        content.slice(after.start)
      );
    }
    const lastEnd = Math.max(...peers.map((peer) => peer.end));
    return (
      content.slice(0, lastEnd) +
      "\n\n" +
      fragment.block +
      content.slice(lastEnd)
    );
  }
  const insertion = locateAnchor(content, fragment.anchor);
  if (insertion === -1) return null;
  return (
    content.slice(0, insertion) +
    "\n" +
    fragment.block +
    "\n" +
    content.slice(insertion)
  );
}

function rebuildPluginComposedStage(
  source: Buffer,
  current: Buffer,
  state: PluginStageState,
): { desired: Buffer; base: Buffer } | null {
  if (state.unsafe) return null;
  const installed = current.toString("utf-8");
  const fragments = pluginFragments(installed);
  if (fragments === null) return null;

  const owned = {
    produces: new Set<string>(),
    sensors: new Set<string>(),
    consumes: new Set<string>(),
    scopes: new Set<string>(),
    required_sections: new Set<string>(),
  };
  let requiredSectionsCreated = false;
  for (const { record } of state.records) {
    for (const field of [
      "produces",
      "sensors",
      "consumes",
      "scopes",
      "required_sections",
    ] as const) {
      for (const value of record[field] ?? []) owned[field].add(value);
    }
    requiredSectionsCreated ||= record.required_sections_created === true;
  }

  const ordered: Record<"produces" | "sensors" | "scopes" | "required_sections", string[]> = {
    produces: [],
    sensors: [],
    scopes: [],
    required_sections: [],
  };
  for (const field of ["produces", "sensors", "scopes", "required_sections"] as const) {
    const values = listFieldValues(installed, field);
    if (owned[field].size > 0 && values === null) return null;
    ordered[field] = (values ?? []).filter((value) => owned[field].has(value));
    if (ordered[field].length !== owned[field].size) return null;
  }
  const consumes = consumeEntries(installed, owned.consumes);
  if (consumes === null) return null;

  let base = stripPluginFragments(installed, fragments);
  base = removeListValues(base, "produces", owned.produces, false);
  base = removeListValues(base, "sensors", owned.sensors, false);
  base = removeListValues(base, "scopes", owned.scopes, false);
  base = removeConsumesEntries(base, owned.consumes);
  base = removeListValues(
    base,
    "required_sections",
    owned.required_sections,
    requiredSectionsCreated,
  );

  let desired: string | null = source.toString("utf-8");
  desired = mergeListValues(desired, "produces", ordered.produces);
  if (desired === null) return null;
  desired = mergeListValues(desired, "sensors", ordered.sensors);
  if (desired === null) return null;
  desired = mergeListValues(desired, "scopes", ordered.scopes);
  if (desired === null) return null;
  desired = mergeConsumes(desired, consumes);
  if (desired === null) return null;
  desired = mergeRequiredSections(desired, ordered.required_sections);
  if (desired === null) return null;
  for (const fragment of [...fragments].sort(
    (left, right) =>
      left.order - right.order || left.plugin.localeCompare(right.plugin),
  )) {
    desired = spliceFragment(desired, fragment);
    if (desired === null) return null;
  }
  return {
    desired: Buffer.from(desired, "utf-8"),
    base: Buffer.from(base, "utf-8"),
  };
}

function managedContent(
  rel: string,
  source: Buffer,
  activeSpace: string,
  existing?: Buffer,
): Buffer {
  if (rel === ".cursor/tools/data/harness.json" && existing) {
    const shipped = parseBufferObject(source, rel);
    const current = parseBufferObject(existing, rel);
    if (Object.hasOwn(current, "plugins")) {
      shipped.plugins = stringArray(current.plugins, `${rel}: plugins`);
    }
    return Buffer.from(`${JSON.stringify(shipped, null, 2)}\n`, "utf-8");
  }

  if (
    /^\.cursor\/rules\/.+\.mdc$/.test(rel) ||
    /^\.cursor\/agents\/[^/]+-agent\.md$/.test(rel)
  ) {
    return Buffer.from(
      source
        .toString("utf-8")
        .replace(
          /aidlc\/spaces\/[^/]+\/memory\//g,
          `aidlc/spaces/${activeSpace}/memory/`,
        ),
      "utf-8",
    );
  }
  return source;
}

function receiptComparableContent(rel: string, current: Buffer, activeSpace: string): Buffer {
  if (rel === ".cursor/tools/data/harness.json") {
    const parsed = parseBufferObject(current, rel);
    delete parsed.plugins;
    return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  }
  if (
    /^\.cursor\/rules\/.+\.mdc$/.test(rel) ||
    /^\.cursor\/agents\/[^/]+-agent\.md$/.test(rel)
  ) {
    return Buffer.from(
      current
        .toString("utf-8")
        .replaceAll(
          `aidlc/spaces/${activeSpace}/memory/`,
          "aidlc/spaces/default/memory/",
        ),
      "utf-8",
    );
  }
  return current;
}

function isRuntimeOwnedManagedFile(
  rel: string,
  selectedPlugins: string[] | null,
  pluginComposition: boolean,
): boolean {
  if (selectedPlugins === null && !pluginComposition) return false;
  return (
    rel === ".cursor/tools/data/stage-graph.json" ||
    rel === ".cursor/tools/data/scope-grid.json" ||
    rel === ".cursor/skills/aidlc/SKILL.md"
  );
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected an array of strings`);
  }
  return value as string[];
}

function mergeHooks(sourcePath: string, targetPath: string): string {
  const source = parseObject(sourcePath);
  const existing = existsSync(targetPath) ? parseObject(targetPath) : {};
  const sourceVersion = source.version;
  if (
    existing.version !== undefined &&
    sourceVersion !== undefined &&
    existing.version !== sourceVersion
  ) {
    throw new Error(
      `${targetPath}: hooks version ${String(existing.version)} conflicts with shipped version ${String(sourceVersion)}`,
    );
  }
  const sourceHooks = source.hooks;
  const existingHooks = existing.hooks;
  if (!isObject(sourceHooks)) throw new Error(`${sourcePath}: hooks must be an object`);
  if (existingHooks !== undefined && !isObject(existingHooks)) {
    throw new Error(`${targetPath}: hooks must be an object`);
  }

  const mergedHooks: JsonObject = { ...(existingHooks ?? {}) };
  for (const [event, shippedEntries] of Object.entries(sourceHooks)) {
    if (!Array.isArray(shippedEntries)) {
      throw new Error(`${sourcePath}: hooks.${event} must be an array`);
    }
    const projectEntries = mergedHooks[event];
    if (projectEntries !== undefined && !Array.isArray(projectEntries)) {
      throw new Error(`${targetPath}: hooks.${event} must be an array`);
    }
    const merged = [...((projectEntries as unknown[] | undefined) ?? [])];
    for (const entry of shippedEntries) {
      const command = isObject(entry) && typeof entry.command === "string" ? entry.command : null;
      const existingIndex =
        command === null
          ? -1
          : merged.findIndex(
              (candidate) => isObject(candidate) && candidate.command === command,
            );
      // A command match identifies an AI-DLC-owned hook entry. Replace it with
      // the refreshed shipped object so security metadata such as failClosed
      // upgrades instead of being frozen at the first installed version.
      if (existingIndex === -1) merged.push(entry);
      else merged[existingIndex] = entry;
    }
    mergedHooks[event] = merged;
  }

  const merged = {
    ...existing,
    ...(sourceVersion === undefined ? {} : { version: sourceVersion }),
    hooks: mergedHooks,
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeCli(sourcePath: string, targetPath: string): string {
  const source = parseObject(sourcePath);
  const existing = existsSync(targetPath) ? parseObject(targetPath) : {};
  const sourcePermissions = source.permissions;
  const existingPermissions = existing.permissions;
  if (!isObject(sourcePermissions)) throw new Error(`${sourcePath}: permissions must be an object`);
  if (existingPermissions !== undefined && !isObject(existingPermissions)) {
    throw new Error(`${targetPath}: permissions must be an object`);
  }

  const shippedAllow = stringArray(sourcePermissions.allow, `${sourcePath}: permissions.allow`);
  const shippedDeny = stringArray(sourcePermissions.deny, `${sourcePath}: permissions.deny`);
  const projectAllow = stringArray(existingPermissions?.allow, `${targetPath}: permissions.allow`);
  const projectDeny = stringArray(existingPermissions?.deny, `${targetPath}: permissions.deny`);
  const conflicts = [
    ...shippedAllow.filter((entry) => projectDeny.includes(entry)),
    ...shippedDeny.filter((entry) => projectAllow.includes(entry)),
  ];
  if (conflicts.length > 0) {
    throw new Error(
      `${targetPath}: shipped permissions conflict with existing allow/deny entries: ${[...new Set(conflicts)].join(", ")}`,
    );
  }

  const permissions = {
    ...(existingPermissions ?? {}),
    allow: [...new Set([...projectAllow, ...shippedAllow])],
    deny: [...new Set([...projectDeny, ...shippedDeny])],
  };
  return `${JSON.stringify({ ...existing, permissions }, null, 2)}\n`;
}

function replaceOrAppendMarked(
  existing: string,
  shipped: string,
  begin: string,
  end: string,
): string {
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  if ((start === -1) !== (finish === -1) || (start !== -1 && finish < start)) {
    throw new Error(`cannot merge text with an incomplete ${begin} section`);
  }
  const section = `${begin}\n${shipped.trimEnd()}\n${end}`;
  if (start !== -1) {
    return `${existing.slice(0, start)}${section}${existing.slice(finish + end.length)}`;
  }
  if (existing.length === 0) return `${section}\n`;
  return `${existing.trimEnd()}\n\n${section}\n`;
}

function* filesUnder(root: string): Generator<string> {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

async function refreshPluginRouting(targetRoot: string): Promise<void> {
  const utilityPath = join(targetRoot, ".cursor", "tools", "aidlc-utility.ts");
  const module = await import(pathToFileURL(utilityPath).href) as {
    regenerateSelectionSurfaces?: (projectDir: string) => void;
  };
  if (typeof module.regenerateSelectionSurfaces !== "function") {
    throw new Error(`${utilityPath}: missing plugin-routing regeneration export`);
  }

  const priorProject = process.env.AIDLC_PROJECT_DIR;
  const priorHarnessDir = process.env.AIDLC_HARNESS_DIR;
  const priorHarnessName = process.env.AIDLC_HARNESS_NAME;
  process.env.AIDLC_PROJECT_DIR = targetRoot;
  process.env.AIDLC_HARNESS_DIR = ".cursor";
  process.env.AIDLC_HARNESS_NAME = "cursor";
  try {
    module.regenerateSelectionSurfaces(targetRoot);
  } finally {
    if (priorProject === undefined) delete process.env.AIDLC_PROJECT_DIR;
    else process.env.AIDLC_PROJECT_DIR = priorProject;
    if (priorHarnessDir === undefined) delete process.env.AIDLC_HARNESS_DIR;
    else process.env.AIDLC_HARNESS_DIR = priorHarnessDir;
    if (priorHarnessName === undefined) delete process.env.AIDLC_HARNESS_NAME;
    else process.env.AIDLC_HARNESS_NAME = priorHarnessName;
  }
}

export async function install(targetDir: string): Promise<void> {
  const targetRoot = resolve(targetDir);
  assertSafeManagedTree(targetRoot);
  const actions: WriteAction[] = [];
  const collisions: string[] = [];
  const sharedJson = new Set([".cursor/hooks.json", ".cursor/cli.json"]);
  const receiptTarget = join(targetRoot, RECEIPT_REL);
  const priorReceipt = readReceipt(receiptTarget);
  const activeSpace = activeSpaceFor(targetRoot);
  const selectedPlugins = activePluginSelection(targetRoot);
  const pluginRuntime = pluginRuntimeState(targetRoot);
  const managedFiles: Record<string, string> = {};

  for (const top of [".cursor", "aidlc"]) {
    const sourceRoot = join(DIST_ROOT, top);
    for (const source of filesUnder(sourceRoot)) {
      const rel = relative(DIST_ROOT, source).replaceAll("\\", "/");
      if (sharedJson.has(rel)) continue;
      const target = join(targetRoot, rel);
      const sourceBytes = readFileSync(source);

      // Workspace memory is project-owned after seeding, and active-space is a
      // per-user runtime pointer. Seed missing files but never overwrite them.
      if (rel === "aidlc/active-space" || rel.startsWith("aidlc/spaces/")) {
        if (!existsSync(target)) actions.push({ kind: "copy", source, target });
        continue;
      }

      managedFiles[rel] = sha256(sourceBytes);
      const targetBytes = existsSync(target) ? readFileSync(target) : undefined;
      let desired = managedContent(
        rel,
        sourceBytes,
        activeSpace,
        targetBytes,
      );
      let pluginBase: Buffer | undefined;
      let rebuiltPluginStage = false;
      const pluginStage =
        rel.startsWith(".cursor/aidlc-common/stages/") && rel.endsWith(".md")
          ? pluginRuntime.stages.get(basename(rel, ".md"))
          : undefined;
      if (targetBytes && pluginStage) {
        const rebuilt = rebuildPluginComposedStage(sourceBytes, targetBytes, pluginStage);
        if (rebuilt) {
          desired = rebuilt.desired;
          pluginBase = rebuilt.base;
          rebuiltPluginStage = true;
        }
      }
      const runtimeOwned = isRuntimeOwnedManagedFile(
        rel,
        selectedPlugins,
        pluginRuntime.composed,
      );
      if (!existsSync(target)) {
        actions.push({ kind: "write", target, content: desired });
      } else if (targetBytes?.equals(desired)) {
        // Already current, including an active-space-adjusted Cursor surface.
        if (pluginStage && rebuiltPluginStage) {
          reconcileCoreOwnedContributions(sourceBytes, pluginStage);
        }
      } else if (priorReceipt?.managedFiles[rel] !== undefined) {
        const unchangedSinceInstall = pluginStage
          ? pluginBase !== undefined &&
            sha256(pluginBase) === priorReceipt.managedFiles[rel]
          : sha256(receiptComparableContent(rel, targetBytes!, activeSpace)) ===
            priorReceipt.managedFiles[rel];
        if (unchangedSinceInstall || runtimeOwned) {
          actions.push({ kind: "write", target, content: desired });
          if (pluginStage && rebuiltPluginStage) {
            reconcileCoreOwnedContributions(sourceBytes, pluginStage);
          }
        } else {
          collisions.push(rel);
        }
      } else {
        collisions.push(rel);
      }
    }
  }

  for (const sidecar of pluginRuntime.sidecars) {
    if (!sidecar.dirty) continue;
    actions.push({
      kind: "write",
      target: sidecar.path,
      content: `${JSON.stringify(sidecar.data, null, 2)}\n`,
    });
  }

  for (const [rel, priorHash] of Object.entries(priorReceipt?.managedFiles ?? {})) {
    if (Object.hasOwn(managedFiles, rel)) continue;
    const target = join(targetRoot, rel);
    if (!existsSync(target)) continue;
    const comparable = receiptComparableContent(
      rel,
      readFileSync(target),
      activeSpace,
    );
    if (sha256(comparable) === priorHash) {
      actions.push({ kind: "remove", target });
    } else {
      collisions.push(`${rel} (removed upstream but modified locally)`);
    }
  }

  const hooksTarget = join(targetRoot, ".cursor", "hooks.json");
  const cliTarget = join(targetRoot, ".cursor", "cli.json");
  const hooks = mergeHooks(join(DIST_ROOT, ".cursor", "hooks.json"), hooksTarget);
  const cli = mergeCli(join(DIST_ROOT, ".cursor", "cli.json"), cliTarget);
  actions.push({ kind: "write", target: hooksTarget, content: hooks });
  actions.push({ kind: "write", target: cliTarget, content: cli });

  const agentsSource = readFileSync(join(DIST_ROOT, "AGENTS.md"), "utf-8");
  const agentsTarget = join(targetRoot, "AGENTS.md");
  const agentsExisting = existsSync(agentsTarget) ? readFileSync(agentsTarget, "utf-8") : "";
  actions.push({
    kind: "write",
    target: agentsTarget,
    content: replaceOrAppendMarked(
      agentsExisting,
      agentsSource,
      AGENTS_BEGIN,
      AGENTS_END,
    ),
  });

  const gitignoreSource = readFileSync(join(DIST_ROOT, ".gitignore"), "utf-8");
  const aidlcBlockStart = gitignoreSource.indexOf("# AI-DLC");
  if (aidlcBlockStart === -1) throw new Error("shipped .gitignore has no AI-DLC section");
  const gitignoreTarget = join(targetRoot, ".gitignore");
  const gitignoreExisting = existsSync(gitignoreTarget)
    ? readFileSync(gitignoreTarget, "utf-8")
    : "";
  actions.push({
    kind: "write",
    target: gitignoreTarget,
    content: replaceOrAppendMarked(
      gitignoreExisting || gitignoreSource.slice(0, aidlcBlockStart),
      gitignoreSource.slice(aidlcBlockStart),
      GITIGNORE_BEGIN,
      GITIGNORE_END,
    ),
  });

  if (collisions.length > 0) {
    throw new Error(
      `refusing to overwrite existing files that differ:\n${collisions.map((path) => `  ${path}`).join("\n")}`,
    );
  }

  for (const action of actions) {
    if (action.kind === "remove") {
      rmSync(action.target, { force: true });
      continue;
    }
    mkdirSync(dirname(action.target), { recursive: true });
    if (action.kind === "copy") cpSync(action.source, action.target);
    else writeFileSync(action.target, action.content, "utf-8");
  }
  if (selectedPlugins !== null || pluginRuntime.composed) {
    await refreshPluginRouting(targetRoot);
    console.log("AI-DLC Cursor installer refreshed plugin routing against the upgraded core.");
  }
  mkdirSync(dirname(receiptTarget), { recursive: true });
  writeFileSync(
    receiptTarget,
    `${JSON.stringify(
      { schemaVersion: 1, managedFiles } satisfies InstallReceipt,
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target || target === "--help" || target === "-h") {
    console.log("Usage: bun dist/cursor/install.ts <project-directory>");
    process.exit(target ? 0 : 2);
  }
  try {
    await install(target);
    console.log(`AI-DLC Cursor harness installed into ${resolve(target)}`);
  } catch (error) {
    console.error(`Cursor install failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
