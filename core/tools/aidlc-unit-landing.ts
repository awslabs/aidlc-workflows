// Whether a team Unit has landed, as a checkout that claimed it can tell: the
// merged cell of the Unit Progress table and the claim commit main merged.
// aidlc-lib.ts loads this module at start: nothing here may import
// aidlc-lib.ts.
import { spawnSync } from "node:child_process";

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
