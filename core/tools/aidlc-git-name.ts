import { spawnSync } from "node:child_process";

// Who is at the keyboard, as far as AI-DLC can tell without asking. aidlc-lib.ts
// re-exports these and imports them, so nothing here may import it.

// An unattended driver is the only component that knows its prompt-submit
// event did not originate from a person. Withhold the authority-bearing ledger
// mint while retaining non-authority turn markers used by forwarding hooks.
export function humanTurnMintAllowed(): boolean {
  return process.env.AIDLC_UNATTENDED !== "1";
}

// The person's name as their own git reports it for this project: `git config
// user.name` in the project folder reads the repo's own setting, then their
// global and system ones, the way their commits do. Read only, never set, and
// no email. Null when git is missing, fails, or has no name. The Unit board's
// claim owner and the audit's Git Name both read it here (#1395 decision 31).
export function gitUserName(projectDir: string): string | null {
  const result = spawnSync("git", ["config", "user.name"], { cwd: projectDir, encoding: "utf-8" });
  if (result.error || result.status !== 0) return null;
  const name = (result.stdout ?? "").trim();
  return name === "" ? null : name;
}

// The Git Name field of a row that records a decision of the person's: who was
// at the keyboard as git reports it, not a signature or proof of identity.
// Nothing when git has no name, or when the run is unattended and nobody is at
// the keyboard. Each emitter adds it on the branch where the row is theirs,
// never by event type: an autonomous approval, a backfill or a scope's setting
// is no decision of the person's (audit-format.md, "Git Name").
export function personGitNameField(projectDir: string): Record<string, string> {
  if (!humanTurnMintAllowed()) return {};
  const name = gitUserName(projectDir);
  return name === null ? {} : { "Git Name": name };
}
