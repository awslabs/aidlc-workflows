// Teams building each Unit as a piece of work of their own (#2410): where the
// home is, what the Unit plan says about each Unit (likely repos, what it waits
// on), whether who builds which Unit was answered, and a Unit's build. Built on
// aidlc-lib.ts, which requires it lazily where its own functions need it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { artifactFilename } from "./aidlc-artifact-vocabulary.ts";
import {
  type AuditShardEvent,
  auditBlockField,
  type BoltDagResolution,
  committedTextBytes,
  filterProducesByKind,
  getField,
  type IntentRegistryEntry,
  intentRepos,
  intentsDir,
  isPerUnitStage,
  isTeamUnitOwnership,
  listIntentDirs,
  loadScopeMapping,
  loadStageGraphAll,
  markdownBlocks,
  parseBoltDag,
  readStateFile,
  slugify,
  unitDependencyPath,
  writeFileAtomic,
} from "./aidlc-lib.ts";
import { gitAddressKey, recordableGitAddress } from "./aidlc-workspace-repos.ts";

// Where the home of team-built work is: the address the workspace's own
// remote points to (origin, else its one remote; read, never set, with any user
// and token left out), or "local" for a workspace with no remote. Recorded once, when teams are chosen; every copy of the workspace
// reads it. Its presence puts the work on teams building each Unit as a piece of
// work of their own; team work without it keeps the claim, publish, pin, gate
// and land flow it started on.
export const HOME_LOCATION_FIELD = "Home Location";

// Who settled a piece of work's project type (aidlc-utility.ts reads it); a
// Unit's build takes the type its home settled.
export const PROJECT_TYPE_SOURCE_FIELD = "Project Type Source";
export const PROJECT_TYPE_SOURCE_HOME = "the home";

export function homeLocation(stateContent: string | null): string | null {
  const value = stateContent === null ? null : getField(stateContent, HOME_LOCATION_FIELD)?.trim();
  return value ? value : null;
}

// What to record as the home's location for a workspace, or null when it is not
// a git repo (teams then keep today's flow in one checkout).
export function workspaceHomeLocation(projectDir: string): string | null {
  if (!existsSync(join(projectDir, ".git"))) return null;
  const read = (args: string[]): string => spawnSync("git", args, { cwd: projectDir, encoding: "utf-8" }).stdout?.trim() ?? "";
  const remotes = read(["remote"]).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  const address = remote === null ? "" : read(["remote", "get-url", remote]);
  return address ? recordableGitAddress(address) : "local";
}

// Each Unit's likely repos, as Units Generation proposed them (a guide only),
// read from the authored units block. Empty when the block names none or
// cannot be read.
export function unitLikelyRepos(projectDir: string, intent?: string, space?: string): Map<string, string[]> {
  try {
    return unitLikelyReposFrom(readFileSync(unitDependencyPath(projectDir, intent, space), "utf-8"));
  } catch {
    // No units block yet.
    return new Map();
  }
}

// The same, from a Unit plan's own text.
export function unitLikelyReposFrom(dependencyBody: string): Map<string, string[]> {
  const likely = new Map<string, string[]>();
  const parsed = parseBoltDag(dependencyBody);
  if (!parsed.ok) return likely;
  for (const unit of parsed.units) {
    if (unit.repos !== undefined && unit.repos.length > 0) likely.set(unit.name, unit.repos);
  }
  return likely;
}

// Each Unit's direct dependencies, from the authored units block.
export function unitDependencies(projectDir: string, intent?: string, space?: string): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  try {
    const parsed = parseBoltDag(readFileSync(unitDependencyPath(projectDir, intent, space), "utf-8"));
    if (parsed.ok) for (const unit of parsed.units) deps.set(unit.name, unit.depends_on);
  } catch {
    // No units block yet.
  }
  return deps;
}

// The given Units in the order the person's plan writes them.
export function unitsInPlanOrder(projectDir: string, units: readonly string[]): string[] {
  return [...unitDependencies(projectDir).keys(), ...units].filter((unit, at, all) =>
    units.includes(unit) && all.indexOf(unit) === at);
}

// Who builds which Unit was answered since the person last chose teams.
export function unitsAssignedSinceTeams(rows: readonly AuditShardEvent[]): boolean {
  const ordered = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  let teamsAt = -1;
  ordered.forEach((row, at) => {
    if (row.event === "UNIT_OWNERSHIP_SET" && auditBlockField(row.block, "Mode") === "team") teamsAt = at;
  });
  return ordered.slice(teamsAt + 1).some((row) => row.event === "UNITS_ASSIGNED");
}

// The lead's answer to who builds which Unit, kept while the home could not
// be reached (the newest UNITS_ASSIGNED since teams says `Held: not yet`).
export function assignmentNotHeld(rows: readonly AuditShardEvent[]): { pairs: string[]; open: boolean } | null {
  const ordered = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  let teamsAt = -1;
  ordered.forEach((row, at) => {
    if (row.event === "UNIT_OWNERSHIP_SET" && auditBlockField(row.block, "Mode") === "team") teamsAt = at;
  });
  const last = ordered.slice(teamsAt + 1).filter((row) => row.event === "UNITS_ASSIGNED").at(-1);
  if (last === undefined || auditBlockField(last.block, "Held") !== "not yet") return null;
  const pairs = (auditBlockField(last.block, "Assigned") ?? "").split(",").map((pair) => pair.trim()).filter((pair) => pair.includes("="));
  return { pairs, open: auditBlockField(last.block, "Open") === "all" };
}

// The line for likely repos the work does not record: said once, kept as
// written. Null when every one names a recorded repo, or the work records none
// (its likely folders are inside the one repo).
export function unknownLikelyReposLine(projectDir: string): string | null {
  const recorded = intentRepos(projectDir);
  if (recorded.length === 0) return null;
  const unknown: string[] = [];
  for (const [unit, repos] of unitLikelyRepos(projectDir)) {
    for (const repo of repos) {
      if (!recorded.includes(repo.split("/")[0])) unknown.push(`${repo} for ${unit}`);
    }
  }
  if (unknown.length === 0) return null;
  return `The Unit plan names ${unknown.join(", ")}, which is not one of this work's repos (${recorded.join(", ")}). ` +
    "It stays as written, as a guide.";
}

// A per-Unit stage runs for a Unit of this kind when it produces something
// for that kind (filterProducesByKind, its required produces only).
export function teamUnitStageApplies(
  stage: { produces?: string[]; produces_kinds?: Record<string, string[]> },
  unitKind: string | null,
): boolean {
  const names = stage.produces ?? [];
  return names.length > 0 && filterProducesByKind(stage.produces_kinds, names, unitKind).length > 0;
}

// The Units built here, one at a time, before the work switched to teams:
// done at the home as they were, never recorded as merged.
export function unitsBuiltBeforeTeams(rows: readonly AuditShardEvent[], finalStage: string): Set<string> {
  const ordered = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  let teamsAt = -1;
  ordered.forEach((row, at) => {
    if (row.event === "UNIT_OWNERSHIP_SET" && auditBlockField(row.block, "Mode") === "team") teamsAt = at;
  });
  return teamsAt < 0 ? new Set() : soloUnitsProgress(ordered.slice(0, teamsAt), finalStage).done;
}

// The space a team's label names: "Payments" and "payments" are one team.
export function teamSpaceOf(label: string): string {
  return slugify(label);
}

// --- A Unit's build -----------------------------------------------------------
//
// The piece of work a team builds one Unit of the home's work as, in its own
// space. Its state names the home's location, the home's work, where its record
// is, the Unit and the claim attempt it came from.
export const UNIT_BUILD_FIELD = "Unit Build";
// "later" while the person has not asked for the push yet, "unsent" when the
// code went but the home did not take the result, "pushed" once it reached home.
export const UNIT_PUSH_FIELD = "Unit Push";

export interface UnitBuild {
  unit: string;
  homeLocation: string;
  homeWork: string;
  homeRecord: string;
  attempt: number;
}

export function unitBuildOf(stateContent: string | null): UnitBuild | null {
  if (stateContent === null) return null;
  const unit = getField(stateContent, UNIT_BUILD_FIELD)?.trim();
  if (!unit) return null;
  return {
    unit,
    homeLocation: getField(stateContent, HOME_LOCATION_FIELD)?.trim() ?? "",
    homeWork: getField(stateContent, "Home Work")?.trim() ?? "",
    homeRecord: getField(stateContent, "Home Record")?.trim() ?? "",
    attempt: Number.parseInt(getField(stateContent, "Home Attempt")?.trim() ?? "1", 10) || 1,
  };
}

// The build of a home's Unit in this workspace, in any space: what taking that
// Unit again here carries on.
export function findUnitBuild(projectDir: string, homeWork: string, unit: string): { space: string; dirName: string } | null {
  let spaces: string[];
  try {
    spaces = readdirSync(join(projectDir, "aidlc", "spaces"));
  } catch {
    return null;
  }
  for (const space of spaces) {
    for (const dirName of listIntentDirs(projectDir, space)) {
      let state: string;
      try {
        state = readStateFile(projectDir, dirName, space);
      } catch {
        continue;
      }
      const build = unitBuildOf(state);
      if (build?.unit === unit && build.homeWork === homeWork) return { space, dirName };
    }
  }
  return null;
}

// A build walks only its own Unit: its copy of the home's plan names every
// Unit, and the others are the home's or other teams' to build.
export function onlyTheBuildsUnit(
  projectDir: string,
  resolution: BoltDagResolution,
  intent?: string,
  space?: string,
): BoltDagResolution {
  if (resolution.state !== "ok") return resolution;
  let unit: string | null = null;
  try {
    unit = unitBuildOf(readStateFile(projectDir, intent, space))?.unit ?? null;
  } catch {
    // No state yet: the plan as authored.
  }
  if (unit === null || !resolution.units.includes(unit)) return resolution;
  const kind = resolution.unitKinds?.get(unit);
  return { state: "ok", batches: [[unit]], units: [unit], unitKinds: kind === undefined ? null : new Map([[unit, kind]]) };
}

// Two spellings of one git address (gitAddressKey).
export function sameGitAddress(a: string, b: string): boolean {
  return gitAddressKey(a) === gitAddressKey(b);
}

// The home's work that git copied into a team's own workspace: its recorded
// home is not this workspace's own origin. It is the home's, read only, never
// this team's to carry on; nothing in the copy is changed.
export function isHomesCopiedWork(projectDir: string, state: string): boolean {
  const home = isTeamUnitOwnership(state) ? homeLocation(state) : null;
  if (home === null || home === "local") return false;
  return !sameGitAddress(home, workspaceHomeLocation(projectDir) ?? "");
}

// --- A build's registry row, kept in its own record folder --------------------
//
// Two builds started at once in one space then share no file, so the clones
// they were started in never conflict on a pull. readIntentRegistry lists these
// rows with the space's own; writeIntentRegistry writes them back here.
export const RECORD_ENTRY_FILE = "aidlc-intent.json";

function recordEntryPath(projectDir: string, space: string | undefined, dirName: string): string {
  return join(intentsDir(projectDir, space), dirName, RECORD_ENTRY_FILE);
}

// The rows kept in record folders that intents.json does not list.
export function recordKeptEntries(
  projectDir: string,
  listed: readonly IntentRegistryEntry[],
  space?: string,
): IntentRegistryEntry[] {
  const kept: IntentRegistryEntry[] = [];
  for (const dirName of listIntentDirs(projectDir, space)) {
    if (listed.some((row) => row.dirName === dirName)) continue;
    let text: string;
    try {
      text = readFileSync(recordEntryPath(projectDir, space, dirName), "utf-8");
    } catch {
      continue;
    }
    try {
      const entry = JSON.parse(text) as IntentRegistryEntry;
      if (typeof entry?.uuid !== "string" || listed.some((row) => row.uuid === entry.uuid)) continue;
      kept.push({ ...entry, dirName });
    } catch {
      // A hand-broken file lists nothing; the folder still shows as a record.
    }
  }
  return kept;
}

export function keepIntentEntryInRecord(projectDir: string, entry: IntentRegistryEntry, space?: string): void {
  if (!entry.dirName) throw new Error("A row kept in its record folder needs the folder's name.");
  writeRowIfChanged(recordEntryPath(projectDir, space, entry.dirName), entry);
}

// The rows for the space's own intents.json: a row its record folder keeps is
// written back there instead.
export function keepRecordKeptEntries(
  projectDir: string,
  all: readonly IntentRegistryEntry[],
  space?: string,
): IntentRegistryEntry[] {
  return all.filter((entry) => {
    if (!entry.dirName || !existsSync(recordEntryPath(projectDir, space, entry.dirName))) return true;
    writeRowIfChanged(recordEntryPath(projectDir, space, entry.dirName), entry);
    return false;
  });
}

function writeRowIfChanged(path: string, entry: IntentRegistryEntry): void {
  const text = `${JSON.stringify(entry, null, 2)}\n`;
  try {
    if (readFileSync(path, "utf-8") === text) return;
  } catch {
    // A new row.
  }
  writeFileAtomic(path, text);
}

// --- A Unit's result, and whether it merged -----------------------------------
//
// What a team's push sends home on the claim: per repo, the branch, the commit
// the Unit started from, every head pushed (the last is current), each changed
// path's blob at the head (null when deleted) and the change's patch-id. The
// home checks each repo against its own integration branch with git alone.

export interface RepoResult {
  // A repo name, or "." for the workspace's own repo.
  repo: string;
  branch: string;
  base: string;
  heads: string[];
  paths: Record<string, string | null>;
  patch_id?: string;
  // The team's own check, for a home that cannot fetch the repo itself.
  reported?: { merged: boolean; commit?: string };
}

export interface UnitResult {
  by: string;
  repos: RepoResult[];
  // Record-relative paths of the Unit outputs the home's later stages read,
  // carried as files in the claim commit's tree under RESULT_FILES_ROOT.
  outputs: string[];
  // Taken in from a file changed after the team wrote it.
  edited?: true;
}

export const RESULT_FILES_ROOT = ".aidlc-unit-result";

function gitIn(dir: string, args: string[], input?: string): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, out: result.stdout ?? "" };
}

// Each path's blob at a commit; a path the commit does not have is left out.
export function blobsAt(dir: string, commit: string, paths: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  if (paths.length === 0) return blobs;
  const listed = gitIn(dir, ["ls-tree", "-r", "--full-tree", commit, "--", ...paths]);
  for (const line of listed.out.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    blobs.set(line.slice(tab + 1), line.slice(0, tab).split(" ")[2]);
  }
  return blobs;
}

// The stable patch-id of the change from one commit to another over the paths.
export function patchIdOf(dir: string, from: string, to: string, paths: readonly string[]): string | null {
  const diff = gitIn(dir, ["diff", "--no-ext-diff", "--no-textconv", from, to, "--", ...paths]);
  if (!diff.ok || diff.out.length === 0) return null;
  return gitIn(dir, ["patch-id", "--stable"], diff.out).out.split(" ")[0] || null;
}

export type MergeVerdict =
  | { merged: true; commit: string; how: "ancestry" | "same content" | "same change" }
  | { merged: false };

// Whether a repo's part of a Unit is in its integration branch: the last head
// is an ancestor of it (a merge commit, a fast-forward); or a first-parent
// commit after the base has every changed path at the head's blob and every
// deleted path gone (a squash, a rebase; a later edit to the same files comes
// after it); or one first-parent commit is the same change by patch-id.
// Anything else is not merged yet.
// ponytail: the walk reads the latest 500 first-parent commits after the base.
export function unitMergeVerdict(dir: string, integration: string, result: RepoResult): MergeVerdict {
  const head = result.heads.at(-1);
  if (head && gitIn(dir, ["merge-base", "--is-ancestor", head, integration]).ok) {
    return { merged: true, commit: head, how: "ancestry" };
  }
  const paths = Object.keys(result.paths);
  if (paths.length === 0) return { merged: false };
  const known = gitIn(dir, ["rev-parse", "--verify", "--quiet", `${result.base}^{commit}`]).ok;
  const commits = gitIn(dir, ["rev-list", "--first-parent", "--reverse", "--max-count=500", known ? `${result.base}..${integration}` : integration])
    .out.split("\n").filter(Boolean);
  for (const commit of commits) {
    const at = blobsAt(dir, commit, paths);
    if (paths.every((path) => (result.paths[path] === null ? !at.has(path) : at.get(path) === result.paths[path]))) {
      return { merged: true, commit, how: "same content" };
    }
  }
  if (result.patch_id) {
    for (const commit of commits) {
      if (patchIdOf(dir, `${commit}^`, commit, paths) === result.patch_id) return { merged: true, commit, how: "same change" };
    }
  }
  return { merged: false };
}

// The Unit outputs the home's stages after the per-Unit ones read (Build and
// Test reads Code Generation's summary and test instructions): record-relative
// paths, for the scope's stages that run.
export function unitOutputsHomeReads(unit: string, scope: string): string[] {
  const graph = loadStageGraphAll();
  const grid = loadScopeMapping()[scope]?.stages ?? {};
  const perUnit = graph.filter((stage) => isPerUnitStage(stage));
  const outputs = new Set<string>();
  for (const stage of graph) {
    if ((stage.phase !== "construction" && stage.phase !== "operation") || isPerUnitStage(stage)) continue;
    if (grid[stage.slug] !== "EXECUTE") continue;
    for (const consume of stage.consumes ?? []) {
      const producer = perUnit.find((entry) =>
        [...(entry.produces ?? []), ...(entry.optional_produces ?? [])].includes(consume.artifact)
      );
      if (producer) outputs.add(`construction/${unit}/${producer.slug}/${artifactFilename(consume.artifact)}`);
    }
    // What the stage's own checks read of each Unit, beside what it consumes.
    // Loaded here only: this module also runs beside the library in hooks.
    const coverage = require("./aidlc-sensor-traceability.ts") as typeof import("./aidlc-sensor-traceability.ts");
    if (stage.slug === coverage.CROSS_UNIT_COVERAGE_STAGE) {
      for (const rel of coverage.crossUnitCoverageReads()) outputs.add(`construction/${unit}/${rel}`);
    }
  }
  return [...outputs].sort();
}

// A Unit's writes by the repo each is in, as its source manifest records them:
// a write names its repo, or is in the work's one recorded repo, or in the
// workspace's own repo (".").
export function writesByRepo(projectDir: string, writes: ReadonlyArray<{ path: string; repo?: string }>): Map<string, string[]> {
  const recorded = intentRepos(projectDir);
  const byRepo = new Map<string, string[]>();
  for (const write of writes) {
    const repo = write.repo ?? (recorded.length === 1 ? recorded[0] : ".");
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), write.path]);
  }
  return byRepo;
}

// --- The board ----------------------------------------------------------------
//
// One line per Unit, the same at the home and in every team's workspace.

export interface UnitBoardRow {
  unit: string;
  team: string | null;
  status: string;
}

export function renderUnitBoard(label: string, rows: readonly UnitBoardRow[]): string {
  return [`Units of ${label}:`, ...rows.map((row) => `- ${row.unit}, ${row.team ?? "open"}: ${row.status}`)].join("\n");
}

// How far a pushed Unit's repos are merged, in words: "checkout-api merged,
// billing not merged yet (1 of 2 merged)".
export function mergedStatus(verdicts: ReadonlyArray<{ repo: string; merged: boolean }>): string {
  const merged = verdicts.filter((verdict) => verdict.merged).length;
  const parts = verdicts.map((verdict) => `${verdict.repo === "." ? "the repo" : verdict.repo} ${verdict.merged ? "merged" : "not merged yet"}`);
  return verdicts.length === 1 ? parts[0] : `${parts.join(", ")} (${merged} of ${verdicts.length} merged)`;
}

// --- Files for a team that cannot reach the home ------------------------------
//
// One readable Markdown text each: the hand-off a lead writes for a Unit, and
// the progress and result files the team sends back. Bound by the home's work
// id, the Unit, the attempt and fingerprints; never signed. Written with LF,
// read with CRLF too; paths with forward slashes.

export type HandFileKind = "handoff" | "progress" | "result";

export interface HandFile {
  kind: HandFileKind;
  fields: Record<string, string>;
  files: Map<string, string>;
  result?: UnitResult;
  // A file whose fingerprints no longer match what it says it holds.
  edited: boolean;
}

export const HANDOFF_DIR = "aidlc/handoff";

// A text's fingerprint, the same for its LF and CRLF spellings.
export function textFingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(committedTextBytes(Buffer.from(text, "utf-8"))).digest("hex")}`;
}

function filesFingerprint(files: ReadonlyMap<string, string>, result?: UnitResult): string {
  return textFingerprint([
    ...[...files].map(([path, text]) => `${path} ${textFingerprint(text)}`),
    ...(result ? [JSON.stringify(result)] : []),
  ].join("\n"));
}

// A fence longer than any run of tildes in the text it holds.
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/~+/g) ?? []).map((run) => run.length));
  return "~".repeat(Math.max(4, longest + 1));
}

export function renderHandFile(
  kind: HandFileKind,
  title: string,
  intro: string,
  fields: Record<string, string>,
  files: ReadonlyMap<string, string>,
  result?: UnitResult,
): string {
  const lines = [`# ${title}`, "", intro, "", `<!-- aidlc-${kind} 1 -->`];
  for (const [name, value] of Object.entries({ ...fields, Fingerprint: filesFingerprint(files, result) })) {
    lines.push(`- **${name}**: ${value}`);
  }
  lines.push("");
  if (files.size > 0) {
    lines.push("## Files", "", "| File | Fingerprint |", "| --- | --- |");
    for (const [path, text] of files) lines.push(`| ${path} | ${textFingerprint(text)} |`);
    lines.push("");
  }
  if (result) {
    const json = JSON.stringify(result, null, 2);
    const fence = fenceFor(json);
    lines.push("## Result", "", `${fence}json`, json, fence, "");
  }
  for (const [path, text] of files) {
    const normalized = text.replace(/\r\n?/g, "\n");
    const fence = fenceFor(normalized);
    const ends = normalized.endsWith("\n");
    lines.push(`## File: ${path}`, "", ends ? fence : `${fence} noeol`, ends ? normalized.slice(0, -1) : normalized, fence, "");
  }
  return lines.join("\n");
}

// A table's rows as cells, from markdownBlocks: the one reading of Markdown structure.
function tableRows(lines: readonly string[], blocks: ReturnType<typeof markdownBlocks>["lines"]): string[][] {
  return lines.flatMap((line, at) => blocks[at]?.kind === "table" && blocks[at].containers.length === 0
    ? [line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())]
    : []);
}

// Read a hand-off, progress or result file; null for any other text. Its
// marker, field list, headings, fences and table are located by
// markdownBlocks, so an editor that pads the table or rewrites the fences in
// backticks changes nothing.
export function parseHandFile(raw: string): HandFile | null {
  const text = raw.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks = markdownBlocks(text).lines;
  if (blocks.length !== lines.length) return null;
  const top = (at: number): boolean => blocks[at].containers.length === 0;
  const markerAt = lines.findIndex((line, at) =>
    blocks[at].kind === "htmlFlow" && top(at) && /^<!-- aidlc-(handoff|progress|result) 1 -->$/.test(line.trim()));
  if (markerAt < 0) return null;
  const kind = /aidlc-(\w+)/.exec(lines[markerAt])![1] as HandFileKind;
  const fields: Record<string, string> = {};
  let at = markerAt + 1;
  for (; at < lines.length && blocks[at].kind !== "blank" && blocks[at].kind !== "heading"; at++) {
    const field = /^\s*[-*] \*\*(.+?)\*\*: ?(.*)$/.exec(lines[at]);
    if (field) fields[field[1]] = field[2].trim();
  }
  const listed = new Map(tableRows(lines, blocks).filter((cells) => /^sha256:[0-9a-f]+$/.test(cells[1] ?? "")).map((cells) => [cells[0], cells[1]]));
  const files = new Map<string, string>();
  let result: UnitResult | undefined;
  for (; at < lines.length; at++) {
    if (blocks[at].kind !== "heading" || !top(at)) continue;
    const file = /^## File: (.+)$/.exec(lines[at].trim());
    const isResult = lines[at].trim() === "## Result";
    if (!file && !isResult) continue;
    let open = at + 1;
    while (open < lines.length && blocks[open].kind === "blank") open++;
    if (blocks[open]?.kind !== "codeFenced") continue;
    const block = blocks[open].block;
    let close = open;
    while (close + 1 < lines.length && blocks[close + 1].block === block && blocks[close + 1].kind === "codeFenced") close++;
    const fence = /^\s*(~{3,}|`{3,})\s*(\S*)/.exec(lines[open]);
    if (!fence || close === open || !lines[close].trim().startsWith(fence[1])) break;
    const body = lines.slice(open + 1, close).join("\n");
    if (isResult) {
      try {
        result = JSON.parse(body) as UnitResult;
      } catch {
        result = undefined;
      }
    } else {
      files.set(file![1], /noeol/.test(lines[open]) ? body : `${body}\n`);
    }
    at = close;
  }
  const edited = fields.Fingerprint !== filesFingerprint(files, result) ||
    [...files].some(([path, text]) => listed.get(path) !== textFingerprint(text));
  return { kind, fields, files, ...(result ? { result } : {}), edited };
}

// --- A shared input a team proposes to change -------------------------------------
//
// A team proposes a change to one of the inputs its Unit was approved with; the
// person who owns the shared plan answers at the home; an approved change
// reaches every team building with it, once, as an amendment on its claim.

export interface Proposal {
  // Record-relative path of the input, as approved-inputs.md lists it.
  input: string;
  by: string;
  words: string;
  at: string;
  answer?: "approved" | "turned down";
  answer_words?: string;
}

export interface Amendment {
  input: string;
  at: string;
  words: string;
}

// The files a build was approved with, as its approved-inputs.md lists them.
export function approvedInputsOf(recordDir: string): Array<{ path: string; fingerprint: string }> {
  let text: string;
  try {
    text = readFileSync(join(recordDir, "approved-inputs.md"), "utf-8");
  } catch {
    return [];
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  return tableRows(normalized.split("\n"), markdownBlocks(normalized).lines)
    .filter((cells) => /^sha256:[0-9a-f]+$/.test(cells[1] ?? ""))
    .map((cells) => ({ path: cells[0], fingerprint: cells[1] }));
}

// An input's name for the person: "contract summary" for
// inception/contract-design/contract-summary.md.
export function inputName(rel: string): string {
  return (rel.split("/").at(-1) ?? rel).replace(/\.md$/, "").replaceAll("-", " ");
}

// Which stage produced a record-relative Inception output, and as which artifact.
export function artifactAt(rel: string): { producer: string; artifact: string } | null {
  const [, producer, file] = rel.split("/");
  const stage = loadStageGraphAll().find((entry) => entry.slug === producer);
  const artifact = [...(stage?.produces ?? []), ...(stage?.optional_produces ?? [])].find((name) => artifactFilename(name) === file);
  return stage && artifact ? { producer, artifact } : null;
}

// --- Solo work driven from another machine -----------------------------------------

// Solo work built one Unit at a time whose active Unit last moved in another
// clone's audit shard: it is being built from another machine. That Unit and
// the stage it was on; null otherwise.
export function builtFromAnotherMachine(
  stateContent: string,
  rows: readonly AuditShardEvent[],
  ownShard: string,
): { unit: string; stage: string; shard: string } | null {
  if (isTeamUnitOwnership(stateContent) || getField(stateContent, "Construction Iteration")?.trim() !== "unit-major") return null;
  const moves = rows
    .filter((row) => row.event.startsWith("UNIT_") && auditBlockField(row.block, "Unit") && auditBlockField(row.block, "Stage"))
    .sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.pos - b.pos));
  const last = moves.at(-1);
  // A row's shard is the shard file's path; ownShard is this clone's shard name.
  if (last === undefined || basename(last.shard) === ownShard) return null;
  return { unit: auditBlockField(last.block, "Unit")!, stage: auditBlockField(last.block, "Stage")!, shard: last.shard };
}

// Whether the person who last committed a file is this clone's git identity
// (user.email, else user.name): one person's work on two machines.
export function lastCommittedByThisPerson(projectDir: string, path: string): boolean {
  const run = (args: string[]) => (spawnSync("git", args, { cwd: projectDir, encoding: "utf-8" }).stdout ?? "").trim();
  const [email = "", name = ""] = run(["log", "-1", "--format=%ae%n%an", "--", path]).split("\n");
  const mine = run(["config", "user.email"]);
  if (email && mine) return email.toLowerCase() === mine.toLowerCase();
  return name !== "" && name === run(["config", "user.name"]);
}

// A solo walk's Units: started when any per-Unit stage started for it, done
// when its last per-Unit stage completed.
export function soloUnitsProgress(
  rows: readonly AuditShardEvent[],
  finalStage: string,
): { started: Set<string>; done: Set<string> } {
  const started = new Set<string>();
  const done = new Set<string>();
  for (const row of rows) {
    const unit = auditBlockField(row.block, "Unit");
    if (!unit) continue;
    if (row.event === "UNIT_STARTED") started.add(unit);
    if (row.event === "UNIT_COMPLETED" && auditBlockField(row.block, "Stage") === finalStage) done.add(unit);
  }
  return { started, done };
}
