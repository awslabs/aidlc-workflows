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
// merged is in its history. A merged cell alone (a hand edit, an adopter on
// the claim branch) or a git that cannot answer keeps the checkout held. The
// stamp file stays until the next claim here clears it.
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
    ).status === 0;
    LANDED_SCOPE_STAMPS.set(key, landed);
  }
  return landed;
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
