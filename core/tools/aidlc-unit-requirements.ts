import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  listIntentDirs, listSpaces, recordDir, resolveBoltDag, visibleMarkdownLines,
  withAuditLock,
} from "./aidlc-lib.ts";

import { executePlan, writeOperation } from "./aidlc-transaction.ts";

export const REQUIREMENT_ASSIGNMENTS_FILE = "unit-requirement-assignments.json";
export interface RequirementAssignment {
  id: string;
  owner: string;
  related: string[];
  required_for: "owner" | "participants" | "all";
}
export interface AssignmentResult { ids: Set<string>; reasons: string[] }
export interface AssignmentDocument { version: 1; assignments: RequirementAssignment[] }
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Independent upstream input. Downstream coverage never defines expectations.
export function requirementAssignments(text: string, required: Set<string>, units: string[], unit?: string): AssignmentResult {
  const result: AssignmentResult = { ids: new Set(), reasons: [] };
  const reject = (reason: string) => result.reasons.push(`requirement assignments: ${reason}`);
  let input: unknown;
  try { input = JSON.parse(text); } catch { reject("malformed JSON"); return result; }
  if (!isObject(input) || input.version !== 1 || !Array.isArray(input.assignments)) {
    reject("version1 assignments array required"); return result;
  }
  if (input.draft === true || input.not_for_active_use === true) {
    reject("draft input is not approved for active use"); return result;
  }
  if (unit !== undefined && !units.includes(unit)) reject(`unknown Unit ${unit}`);
  const seen = new Set<string>();
  for (const row of input.assignments) {
    if (!isObject(row) || typeof row.id !== "string" || !required.has(row.id)) {
      reject(`unknown requirement ${isObject(row) ? row.id : "entry"}`); continue;
    }
    if (seen.has(row.id)) reject(`duplicate/conflicting assignment ${row.id}`);
    seen.add(row.id);
    if (typeof row.owner !== "string" || !units.includes(row.owner)) reject(`unknown owner ${row.id}`);
    if (!Array.isArray(row.related) || row.related.some((u: unknown) => typeof u !== "string" || !units.includes(u))
        || new Set(row.related).size !== row.related.length || row.related.includes(row.owner)) {
      reject(`invalid related Units ${row.id}`); continue;
    }
    if (row.required_for !== "owner" && row.required_for !== "participants" && row.required_for !== "all") {
      reject(`unresolved required_for ${row.id}`); continue;
    }
    if (unit === undefined || row.required_for === "all" || row.owner === unit
        || (row.required_for === "participants" && row.related.includes(unit))) result.ids.add(row.id);
  }
  for (const id of required) if (!seen.has(id)) reject(`missing assignment ${id}`);
  if (required.size === 0) reject("requirements.md contains no FR/NFR IDs");
  if (unit !== undefined && !result.ids.size && !result.reasons.length) reject(`no requirements assigned to Unit ${unit}`);
  if (result.reasons.length) result.ids.clear();
  return result;
}

export function requirementIds(text: string): Set<string> {
  // Same FR/NFR vocabulary as traceability (including FR group headings).
  return new Set(text.match(/\b(?:FR\d+(?:\.\d+)?|NFR\d+\b(?!\.\d))\b/g) ?? []);
}

function cells(line: string): string[] {
  return line.trimStart().startsWith("|")
    ? line.split("|").slice(1, -1).map(cell => cell.trim().replace(/^`(.*)`$/, "$1")) : [];
}

// Exact ID/directory table join only. No fuzzy name, prose, or downstream join.
export function requirementUnitAliases(definition: string, units: string[]): Map<string, string> {
  const aliases = new Map(units.map(unit => [unit, unit]));
  const conflicts = new Set<string>();
  for (const line of visibleMarkdownLines(definition)) {
    const row = cells(line);
    const ids = row.filter(cell => /^U\d+$/i.test(cell));
    const directories = row.filter(cell => units.includes(cell));
    if (ids.length !== 1 || directories.length !== 1) continue;
    const id = ids[0].toUpperCase();
    if (aliases.has(id) && aliases.get(id) !== directories[0]) conflicts.add(id);
    else aliases.set(id, directories[0]);
  }
  for (const id of conflicts) aliases.delete(id);
  return aliases;
}

export interface LegacyAssignmentResult { document?: AssignmentDocument; reasons: string[] }
export function recoverRequirementAssignments(requirements: string, definition: string, map: string, units: string[]): LegacyAssignmentResult {
  const required = requirementIds(requirements);
  const aliases = requirementUnitAliases(definition, units);
  const assignments: RequirementAssignment[] = [];
  const reasons: string[] = [];
  let header: string[] = [];
  for (const line of visibleMarkdownLines(map)) {
    const row = cells(line);
    if (!row.length) { header = []; continue; }
    if (row.every(cell => /^:?-+:?$/.test(cell.replace(/\s/g, "")))) continue;
    const keys = row.map(cell => cell.toLowerCase().replace(/[_-]/g, " "));
    if (keys.some(key => ["requirement", "requirement id", "fr", "fr id", "id"].includes(key))) { header = keys; continue; }
    const idIndex = header.findIndex(key => ["requirement", "requirement id", "fr", "fr id", "id"].includes(key));
    if (idIndex < 0 || !/^(?:FR\d+(?:\.\d+)?|NFR\d+)$/.test(row[idIndex] ?? "")) continue;
    const id = row[idIndex];
    const ownerKeys = ["owner", "unit", "unit id", "unit name", "implementing unit", "directory"];
    const relatedKeys = ["related", "related units"];
    const idKeys = ["requirement", "requirement id", "fr", "fr id", "id"];
    const knownKeys = new Set([...ownerKeys, ...relatedKeys, ...idKeys, "required for"]);
    const ownerColumns = header.flatMap((key, index) => ownerKeys.includes(key) ? [index] : []);
    const relatedColumns = header.flatMap((key, index) => relatedKeys.includes(key) ? [index] : []);
    const scopeColumns = header.flatMap((key, index) => key === "required for" ? [index] : []);
    const resolveUnit = (value: string) => aliases.get(value) ?? aliases.get(value.toUpperCase());
    const owners = ownerColumns.map(index => resolveUnit(row[index] ?? ""));
    const owner = owners[0];
    const relatedText = relatedColumns.length === 0 ? "" : row[relatedColumns[0]] ?? "";
    const related = relatedText === "" || relatedText === "-" ? [] : relatedText.split(/\s*[,;]\s*/).map(resolveUnit);
    // Unknown or conflicting columns may carry applicability. Preserve that
    // uncertainty instead of silently dropping information in an old table.
    const ambiguous = header.some(key => !knownKeys.has(key)) || row.length !== header.length
      || header.filter(key => idKeys.includes(key)).length !== 1
      || relatedColumns.length > 1 || scopeColumns.length > 1
      || owners.some(value => value !== owner);
    const scope = scopeColumns.length === 0 && id.startsWith("FR") && related.length === 0
      ? "owner" : row[scopeColumns[0]];
    if (ambiguous || !owner || related.some(unit => unit === undefined) || !["owner", "participants", "all"].includes(scope)) {
      reasons.push(`cannot recover ${id}: use unambiguous Requirement, Owner, Related, Required For columns; declare one Owner, Related Units (comma-separated), and Required For (owner|participants|all)`); continue;
    }
    assignments.push({ id, owner, related: related as string[], required_for: scope as RequirementAssignment["required_for"] });
  }
  const document: AssignmentDocument = { version: 1, assignments };
  const checked = requirementAssignments(JSON.stringify(document), required, units);
  reasons.push(...checked.reasons);
  return reasons.length ? { reasons } : { document, reasons };
}

export function loadRequirementAssignments(dir: string, requirements: string, units: string[], unit?: string): AssignmentResult {
  const path = join(dir, REQUIREMENT_ASSIGNMENTS_FILE);
  const required = requirementIds(requirements);
  try {
    // A present invalid file is authoritative: never replace it by a fallback.
    if (lstatPresent(path)) return requirementAssignments(readFileSync(path, "utf-8"), required, units, unit);
    const recovered = recoverRequirementAssignments(requirements,
      readFileSync(join(dir, "unit-of-work.md"), "utf-8"),
      readFileSync(join(dir, "unit-of-work-story-map.md"), "utf-8"), units);
    if (recovered.document) return requirementAssignments(JSON.stringify(recovered.document), required, units, unit);
    return { ids: new Set(), reasons: [assignmentRemedy(path), ...recovered.reasons] };
  } catch (error) {
    return { ids: new Set(), reasons: [assignmentRemedy(path), String(error)] };
  }
}
function lstatPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function assignmentRemedy(path: string): string {
  return `missing or unreadable Unit requirement assignments: author ${path} from requirements.md and the Unit definitions; include every FR/NFR with owner, related, required_for; review changed applicability through the normal Units Generation review/gate. Do not infer it from code-generation coverage.`;
}

// Config's projection transaction is not an artifact-migration transaction.
// Run after a successful refresh; each record independently retries under its
// owning lock. A failure never rolls back the installed runtime or other records.
export function migrateProjectRequirementAssignments(projectDir: string): string[] {
  const notes: string[] = [];
  for (const { name: space } of listSpaces(projectDir)) {
    for (const intent of listIntentDirs(projectDir, space)) {
      try {
        withAuditLock(projectDir, () => {
          const record = recordDir(projectDir, intent, space);
          if (!record) return;
          const dir = join(record, "inception", "units-generation");
          const path = join(dir, REQUIREMENT_ASSIGNMENTS_FILE);
          if (lstatPresent(path) || existsSync(join(record, "inception", "user-stories", "stories.md")) || !existsSync(dir)) return;
          const dag = resolveBoltDag(projectDir, intent, space);
          if (dag.state === "none") return;
          if (dag.state !== "ok") { notes.push(`${relative(projectDir, dir)}: repair the Unit DAG before recovering requirement assignments`); return; }
          const recovered = recoverRequirementAssignments(
            readFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "utf-8"),
            readFileSync(join(dir, "unit-of-work.md"), "utf-8"),
            readFileSync(join(dir, "unit-of-work-story-map.md"), "utf-8"), dag.units);
          if (!recovered.document) {
            notes.push(`${relative(projectDir, path)}: not migrated; ${recovered.reasons.join("; ")}. ${assignmentRemedy(path)}`); return;
          }
          executePlan({ schemaVersion: 1, root: projectDir, operations: [writeOperation(relative(projectDir, path), `${JSON.stringify(recovered.document, null, 2)}\n`, "absent")] });
          notes.push(`Recovered ${relative(projectDir, path)} from explicit upstream assignments; existing approvals were not rewritten. Units Generation review receipts detect this added artifact.`);
        }, intent, space);
      } catch (error) { notes.push(`${space}/${intent}: requirement assignment migration left existing files intact; retry config refresh after fixing: ${String(error)}`); }
    }
  }
  return notes;
}
