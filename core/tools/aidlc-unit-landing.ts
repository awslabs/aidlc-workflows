// What a checkout that claimed a team Unit can tell on its own: whether the
// Unit has landed (the merged cell of the Unit Progress table and the claim
// commit main merged), and which stages it reopens itself.
// aidlc-lib.ts loads this module at start: nothing here may import
// aidlc-lib.ts.
import { spawnSync } from "node:child_process";
import { entrySkillInvocation } from "./aidlc-runtime-paths.ts";

// Whether the Unit Progress table records `unit` as merged: a `merged` column
// (only land's state fold writes one) whose cell in the Unit's one row is
// `[x]`. No column, no row, two rows or any other cell reads as not merged.
export function unitRowMerged(stateContent: string, unit: string): boolean {
  const heading = /^## Unit Progress\s*$/m.exec(stateContent);
  if (!heading) return false;
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(stateContent.slice(after));
  const rows = stateContent
    .slice(after, next ? after + next.index : stateContent.length)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows.find((cells) => cells[0]?.toLowerCase() === "unit");
  const mergedIndex = header?.findIndex((cell) => cell.toLowerCase() === "merged") ?? -1;
  if (!header || mergedIndex < 0) return false;
  const own = rows.filter((cells) => cells.length === header.length && cells[0] === unit);
  return own.length === 1 && own[0][mergedIndex] === "[x]";
}

// The Unit Progress table's header and its Unit rows, each as its cells.
export function unitProgressTable(state: string): { header: string[]; rows: string[][] } | null {
  const match = /^## Unit Progress\s*$/m.exec(state);
  if (!match) return null;
  const after = match.index + match[0].length;
  const next = /^## /m.exec(state.slice(after));
  const section = state.slice(after, next ? after + next.index : state.length);
  const table = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = table.find((cells) => cells[0]?.toLowerCase() === "unit");
  if (!header) return null;
  const rows = table.filter((cells) =>
    cells.length === header.length && cells.length >= 4 &&
    !(cells[0].toLowerCase() === "unit" && cells[1].toLowerCase() === "owner") &&
    !cells.every((cell) => /^-+$/.test(cell))
  );
  return { header, rows };
}

// The Units whose Unit Progress row is complete: every stage cell, and the
// merged cell where land wrote one. One reading for the claim overview and the
// lib's which-checkout-holds-a-Unit read.
export function completedUnits(state: string): Set<string> {
  const table = unitProgressTable(state);
  if (!table) return new Set();
  const { header } = table;
  const mergedIndex = header.findIndex(
    (cell) => cell.toLowerCase() === "merged",
  );
  const done = new Set<string>();
  for (const cells of table.rows) {
    const workCells = cells.slice(
      2,
      mergedIndex >= 0 ? mergedIndex : undefined,
    );
    if (
      workCells.every((cell) => cell === "[x]") &&
      (mergedIndex < 0 || unitRowMerged(state, cells[0]))
    ) {
      done.add(cells[0]);
    }
  }
  return done;
}

// A landed Unit's claim is over: once this checkout holds the landing (a pull
// of the main that merged it), it is no longer held to the Unit. Both facts
// must say so: its own record has the Unit merged, and the claim commit main
// merged is in its history, or, when it is not (a squash-merged records pull
// request), HEAD records the landing of a candidate built on this claim
// (landingRecorded). A merged cell alone (a hand edit, an adopter on the claim
// branch) or a git that cannot answer keeps the checkout held. The stamp file
// stays until the next claim here clears it.
const LANDED_SCOPE_STAMPS = new Map<string, boolean>();
export function scopeStampLanded(
  projectDir: string,
  stateContent: string,
  stamp: { unit: string; claim_oid: string },
): boolean {
  if (!unitRowMerged(stateContent, stamp.unit) || !/^[0-9a-f]{40,64}$/.test(stamp.claim_oid)) return false;
  const key = `${projectDir}\u0000${stamp.claim_oid}`;
  let landed = LANDED_SCOPE_STAMPS.get(key);
  if (landed === undefined) {
    landed = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", stamp.claim_oid, "HEAD"],
      { cwd: projectDir, stdio: "ignore" },
    ).status === 0 || landingRecorded(projectDir, "HEAD", { unit: stamp.unit, claimOid: stamp.claim_oid });
    LANDED_SCOPE_STAMPS.set(key, landed);
  }
  return landed;
}

const GIT_OID = /^[0-9a-f]{40,64}$/;

// A team Unit's landing, as much of it as the one asking knows: the lead's
// landing transaction knows its merge commit, pinned candidate and attempt;
// a claimed checkout knows its claim commit.
export interface UnitLanding {
  unit: string;
  mergeOid?: string;
  pinnedOid?: string;
  generation?: number;
  claimOid?: string;
}

// Whether `rev` records a team Unit's landing by its content: the fallback
// every reader that asks whether a landing reached a branch runs after its
// own ancestry check fails. A landing is one merge commit (land makes it, and
// checks it, before anything is pushed); a merge of the records pull request
// brings its commits, which the ancestry check sees, while a squash or a
// rebase brings only its content, as new commits. That content carries the
// UNIT_MERGED row land's state step writes in a tracked audit shard, naming
// the Unit, the pinned candidate (the merge's second parent), the merge
// commit and the attempt; an audit shard is append-only, so later commits
// keep the row. The row counts when every fact the asker knows matches it,
// and a claim commit counts only when the row's pinned candidate is built on
// it. A merged cell in the Unit Progress table names no commit, so a hand edit
// of the table alone never satisfies this; nor does the row of an earlier
// attempt, whose candidate a reopened claim is not under. A git that cannot
// answer reads as not there.
export function landingRecorded(projectDir: string, rev: string, landing: UnitLanding): boolean {
  return recordedLandings(projectDir, rev, landing.unit).some((row) =>
    (landing.mergeOid === undefined || row.mergeOid === landing.mergeOid) &&
    (landing.pinnedOid === undefined || row.pinnedOid === landing.pinnedOid) &&
    (landing.generation === undefined || row.generation === landing.generation) &&
    (landing.claimOid === undefined ||
      (GIT_OID.test(landing.claimOid) && GIT_OID.test(row.pinnedOid) &&
        isAncestor(projectDir, landing.claimOid, row.pinnedOid)))
  );
}

function isAncestor(projectDir: string, oid: string, rev: string): boolean {
  return spawnSync("git", ["merge-base", "--is-ancestor", oid, rev], { cwd: projectDir, stdio: "ignore" }).status === 0;
}

// The UNIT_MERGED rows for `unit` in the audit shards `rev` tracks. The rows
// are read as aidlc-record-core's auditShardBlocks and auditBlockField read
// them; this module loads before it and cannot import it.
function recordedLandings(
  projectDir: string,
  rev: string,
  unit: string,
): Array<{ pinnedOid: string; mergeOid: string; generation: number }> {
  const run = (args: string[]) => spawnSync("git", args, { cwd: projectDir, encoding: "utf-8", maxBuffer: 1 << 28 });
  const listed = run(["grep", "-l", "-F", "-e", "UNIT_MERGED", rev, "--", ":(top,glob)**/audit/*.md"]);
  if (listed.status !== 0) return [];
  const field = (block: string, name: string): string | null => {
    const prefix = `**${name}**:`;
    for (const raw of block.split("\n")) {
      const line = raw.startsWith("- ") ? raw.slice(2) : raw;
      if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
    }
    return null;
  };
  const rows: Array<{ pinnedOid: string; mergeOid: string; generation: number }> = [];
  for (const path of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    // git grep names each file `<rev>:<path>`, the object show reads.
    const shard = run(["show", path]);
    if (shard.status !== 0) continue;
    for (const block of shard.stdout.replace(/\r\n/g, "\n").split(/\n---\n/)) {
      if (field(block, "Event") !== "UNIT_MERGED" || field(block, "Unit") !== unit) continue;
      rows.push({
        pinnedOid: field(block, "Pinned OID") ?? "",
        mergeOid: field(block, "Merge commit OID") ?? "",
        generation: Number(field(block, "Attempt Generation")),
      });
    }
  }
  return rows;
}

// The stages a checkout that claimed `claimedUnit` reopens itself: that
// Unit's own per-Unit Construction stages on this work's plan. `unitStages` is
// unitMajorConstructionStageSlugs(Scope, state, true), the block its walk
// takes the Unit through; both readers pass exactly that. Any other stage is
// the whole project's, and another Unit's are its claimant's. The recovery
// question's reopen (evaluateGuardRefusal), `next --stage` (routeNext's
// claimedCheckoutMove) and the plan-approval hook's admission of the picked
// reopen (isSelectedGuardRestartContinuation) all read this, so what is
// offered there is taken.
export function claimedCheckoutReopens(
  claimedUnit: string,
  unitStages: readonly string[],
  stage: string,
  unit?: string,
): boolean {
  return (unit === undefined || unit === claimedUnit) && unitStages.includes(stage);
}

// What a checkout that claimed a Unit says of a move that is not the Unit's
// own. True in the project's own checkout that claimed a Unit and in a team's
// clone alike: the checkout makes the move itself once the Unit has landed
// there (scopeStampLanded), so it never sends the person to "the main
// checkout", where they may already be.
export function claimedCheckoutMovesElsewhere(claimedUnit: string, action: string): string {
  return `Run \`${entrySkillInvocation()}\` here to carry on with Unit "${claimedUnit}"; once ${claimedUnit} has landed ` +
    `and this checkout has pulled main, ${action} from here.`;
}
