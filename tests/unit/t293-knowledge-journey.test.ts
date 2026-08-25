// covers: subcommand:aidlc:knowledge subcommand:aidlc-knowledge:onboard subcommand:aidlc-knowledge:sync subcommand:aidlc-knowledge:list subcommand:aidlc-knowledge:show subcommand:aidlc-knowledge:associate subcommand:aidlc-knowledge:dissociate subcommand:aidlc-knowledge:rebind
//
// t293 - the DOCUMENTKB JOURNEY. PR #731 had two review rounds where a
// reviewer found user-reachable defects that 460 passing tests, four green CI
// jobs and six adversarial reviews all missed -- because every existing test
// spawns the tool per-behaviour with a purpose-built fixture, and nothing ever
// asked "does the documented workflow actually work, end to end, from an empty
// project, using only the public command?" Two concrete defects a journey test
// would have caught immediately, both reproduced live against the shipped
// dispatcher/tool before this file existed:
//
//   THE DISPATCHER NEVER RAN A KNOWLEDGE VERB. `aidlc.ts knowledge <verb>`
//   is the ONLY public surface a user or a skill actually invokes; every prior
//   knowledge test spawned `aidlc-knowledge.ts` directly, so a dispatcher-only
//   defect (the knowledge route registered under the wrong route `kind`,
//   silently falling through to "unknown verb") shipped and was reported,
//   claimed fixed, and never executed.
//
//   AN OVERSIZED FILE USED TO TOMBSTONE WHILE SITTING ON DISK. Growing an
//   already-onboarded file past the 32 MiB per-document cap made `sync`
//   report `change: "removed"` and `list` report `tombstoned` for a file `ls`
//   shows plainly present -- reachable only by a multi-step sequence (onboard,
//   grow, sync), never a single-behaviour fixture.
//
// Rule 1 (public surface only): every command below goes through
// `dist/claude/.claude/tools/aidlc.ts knowledge <verb>`, spawned as a real
// process. The library is never imported and `aidlc-knowledge.ts` is never
// invoked directly -- that is the exact distinction the dispatcher bug hid
// behind.
//
// Rule 4 (assert the step, not just the end state): every command's exit
// status is asserted at the point of call, via `run()`, which names the
// command in the failure message. `checkInvariants()` (Rule 3) runs after
// EVERY step against a fresh `list --json`, so a failure localises to the
// step that broke it rather than surfacing only at the end.
//
// Mechanism: real filesystem, real subprocesses, real intent birth via
// `aidlc-utility.ts intent-create` (a hand-written intents.json would let the
// test agree with a fiction). Generous timeouts: this spawns dozens of
// processes, and the oversized-file phase alone writes >32 MiB.

import { afterEach, describe, expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLAUDE_TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const AIDLC = join(CLAUDE_TOOLS, "aidlc.ts");
const UTILITY = join(CLAUDE_TOOLS, "aidlc-utility.ts");
const SPACE = "default";
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

let proj: string | undefined;

afterEach(() => {
  if (proj !== undefined) rmSync(proj, { recursive: true, force: true });
  proj = undefined;
});

function scratchProject(): string {
  proj = mkdtempSync(join(tmpdir(), "t290-"));
  mkdirSync(documentsDir(proj), { recursive: true });
  return proj;
}

function documentsDir(p: string): string {
  return join(p, "aidlc", "spaces", SPACE, "knowledge", "documents");
}

function doc(p: string, name: string, body = "text\n"): string {
  const full = join(documentsDir(p), name);
  writeFileSync(full, body);
  return full;
}

/** Every command in this journey MUST go through the compiled dispatcher --
 *  never `aidlc-knowledge.ts` directly -- because that distinction is the
 *  entire point of this file. */
function knowledge(p: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    "bun",
    [AIDLC, "knowledge", ...args, "--project-dir", p, "--json"],
    { encoding: "utf-8", env: CHILD_ENV },
  );
}

/** Asserts the STEP, not just the end state: the command that failed is named
 *  in the failure message, and the parsed JSON body is returned so each phase
 *  can assert on it immediately, not just at the end of the journey. */
function run(p: string, label: string, args: string[]): Record<string, unknown> {
  const r = knowledge(p, args);
  expect(
    r.status,
    `${label} (knowledge ${args.join(" ")}) failed: status=${r.status} stderr=${r.stderr} stdout=${r.stdout}`,
  ).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function intentCreate(p: string, label: string): string {
  const r = spawnSync(
    "bun",
    [UTILITY, "intent-create", "--scope", "feature", "--arguments", label, "--project-dir", p],
    { encoding: "utf-8", env: CHILD_ENV },
  );
  expect(r.status, `intent-create ${label} failed: ${r.stderr}`).toBe(0);
  const registry = JSON.parse(
    require("node:fs").readFileSync(
      join(p, "aidlc", "spaces", SPACE, "intents", "intents.json"),
      "utf-8",
    ),
  ) as { uuid: string; slug: string }[];
  const row = registry.find((i) => i.slug === label);
  expect(row, `intent-create must register a row for slug ${label}`).toBeDefined();
  return row!.uuid;
}

interface ListedRow {
  id: string;
  path: string;
  state: string;
  status: string;
  bytes: number;
  indexed_at: string;
  intents?: string[];
}

function listRows(p: string, step: string): ListedRow[] {
  const body = run(p, `${step} (list)`, ["list"]);
  return (body.documents as ListedRow[]) ?? [];
}

/** Rule 3's reusable checker. Every invariant here is a property of the WHOLE
 *  catalog after a step, not of any one row -- so it is run after every step
 *  rather than folded into each phase's own assertions. */
function checkInvariants(p: string, step: string): ListedRow[] {
  const rows = listRows(p, step);

  // No two LIVE (non-tombstoned) rows share a source path.
  const liveByPath = new Map<string, string>();
  for (const row of rows) {
    if (row.status === "tombstoned") continue;
    const clash = liveByPath.get(row.path);
    expect(clash, `${step}: two LIVE rows share source.path ${row.path} (${clash}, ${row.id})`).toBeUndefined();
    liveByPath.set(row.path, row.id);
  }

  // No row is tombstoned while its file exists on disk.
  for (const row of rows) {
    if (row.status !== "tombstoned") continue;
    const abs = join(documentsDir(p), row.path.replace(/^documents\//, ""));
    expect(
      existsSync(abs),
      `${step}: row ${row.id} (${row.path}) is tombstoned but the file still exists on disk`,
    ).toBe(false);
  }

  // Extracted content exists under documentkb/<that row's own id>/. The schema
  // owns content/summary path ownership; t288 pins that validator contract.
  for (const row of rows) {
    if (row.status === "tombstoned") continue;
    const shown = run(p, `${step} (show ${row.id})`, ["show", row.id]);
    // content is inline text on `show`, not a path; the on-disk path
    // convention is asserted directly against the id, matching the writer.
    if (shown.content !== undefined) {
      const expectedDir = join(
        p, "aidlc", "spaces", SPACE, "knowledge", "documentkb", row.id,
      );
      expect(
        existsSync(join(expectedDir, "content.md")),
        `${step}: row ${row.id} has content but no content.md under its OWN documentkb/<id>/ dir`,
      ).toBe(true);
    }
  }

  // list and show agree on state/status for the same row.
  for (const row of rows) {
    const shown = run(p, `${step} (list/show agreement ${row.id})`, ["show", row.id]);
    expect(shown.state, `${step}: list/show state mismatch for ${row.id}`).toBe(row.state);
    expect(shown.status, `${step}: list/show status mismatch for ${row.id}`).toBe(row.status);
  }

  // The index still validates -- a `list` that exits non-zero already failed
  // inside listRows()/run() above, so reaching here IS the assertion.
  return rows;
}

describe("t293 the documented workflow, end to end, through the public dispatcher only", () => {
  test(
    "onboard (single + folder), list, show, edit-reonboard, move+sync, delete+sync",
    () => {
      const p = scratchProject();

      // 1. onboard a single file, then a folder of several.
      doc(p, "a.md", "a v1\n");
      run(p, "onboard single a.md", ["onboard", join(documentsDir(p), "a.md")]);
      checkInvariants(p, "after onboard a.md");

      mkdirSync(join(documentsDir(p), "sub"), { recursive: true });
      doc(p, join("sub", "b.md"), "b v1\n");
      doc(p, join("sub", "c.md"), "c v1\n");
      run(p, "onboard folder sub/", ["onboard", join(documentsDir(p), "sub")]);
      let rows = checkInvariants(p, "after onboard sub/");

      // 2. list -- every onboarded file present, states sane.
      expect(rows.length, "list must show all 3 onboarded files").toBe(3);
      for (const row of rows) {
        expect(row.status, `${row.path} must be indexed`).toBe("indexed");
        expect(row.state, `${row.path} must be extracted (plain text)`).toBe("extracted");
      }

      // 3. show <id> -- citation resolves and names the right document.
      const aRow = rows.find((r) => r.path === "documents/a.md")!;
      const shownA = run(p, "show a.md", ["show", aRow.id]);
      expect(shownA.citation as string).toContain("documents/a.md");
      expect(shownA.content as string).toBe("a v1\n");

      // 4. edit a.md in place, onboard again: exactly ONE live row, status
      // "edited", same id (identity survives a same-path edit).
      doc(p, "a.md", "a v2 edited\n");
      const reonboard = run(p, "re-onboard edited a.md", ["onboard", join(documentsDir(p), "a.md")]);
      const reIndexed = (reonboard.indexed as { id: string; status: string }[])[0];
      expect(reIndexed.id, "identity must survive a same-path edit").toBe(aRow.id);
      expect(reIndexed.status).toBe("edited");
      rows = checkInvariants(p, "after re-onboarding edited a.md");
      expect(rows.filter((r) => r.path === "documents/a.md").length, "exactly one live row for a.md").toBe(1);

      // 5. move b.md, sync: the row follows, same id.
      const bRow = rows.find((r) => r.path === "documents/sub/b.md")!;
      renameSync(join(documentsDir(p), "sub", "b.md"), join(documentsDir(p), "sub", "b-renamed.md"));
      const syncMove = run(p, "sync after move b.md", ["sync"]);
      const moveChanges = syncMove.changes as { id: string; path: string; change: string }[];
      const moved = moveChanges.find((c) => c.change === "moved");
      expect(moved, "sync must report the move").toBeDefined();
      expect(moved!.id, "moved row keeps its id").toBe(bRow.id);
      expect(moved!.path).toBe("documents/sub/b-renamed.md");
      rows = checkInvariants(p, "after sync (moved b.md)");

      // 6. delete c.md, sync: tombstoned, and the OTHER rows untouched.
      const cRow = rows.find((r) => r.path === "documents/sub/c.md")!;
      const otherIds = rows.filter((r) => r.id !== cRow.id).map((r) => r.id);
      rmSync(join(documentsDir(p), "sub", "c.md"));
      const syncDelete = run(p, "sync after delete c.md", ["sync"]);
      const deleteChanges = syncDelete.changes as { id: string; change: string }[];
      const removed = deleteChanges.find((c) => c.id === cRow.id);
      expect(removed?.change, "delete must tombstone via sync, not silently drop").toBe("removed");
      rows = checkInvariants(p, "after sync (deleted c.md)");
      const cAfter = rows.find((r) => r.id === cRow.id)!;
      expect(cAfter.status).toBe("tombstoned");
      for (const id of otherIds) {
        const other = rows.find((r) => r.id === id)!;
        expect(other.status, `deleting c.md must not disturb row ${id}`).not.toBe("tombstoned");
      }
    },
    30_000,
  );

  test(
    "associate/dissociate, rebind a moved-and-edited file, then sync re-extracts",
    () => {
      const p = scratchProject();
      doc(p, "policy.md", "policy v1\n");
      const onboarded = run(p, "onboard policy.md", ["onboard", join(documentsDir(p), "policy.md")]);
      const id = (onboarded.indexed as { id: string }[])[0].id;
      checkInvariants(p, "after onboard policy.md");

      // 7. associate to a real intent (born via aidlc-utility.ts intent-create),
      // then dissociate.
      const intentUuid = intentCreate(p, "auth");
      const assoc = run(p, "associate policy.md to auth", ["associate", id, "--intent", "auth"]);
      expect(assoc.intent).toBe(intentUuid);
      let rows = checkInvariants(p, "after associate");
      expect(rows.find((r) => r.id === id)?.intents).toContain(intentUuid);

      const dissoc = run(p, "dissociate policy.md from auth", ["dissociate", id, "--intent", "auth"]);
      expect(dissoc.intent).toBe(intentUuid);
      rows = checkInvariants(p, "after dissociate");
      expect(rows.find((r) => r.id === id)?.intents ?? []).not.toContain(intentUuid);

      // 8. rebind a moved-and-edited file, then sync: re-extracted, content
      // matches the new bytes.
      renameSync(join(documentsDir(p), "policy.md"), join(documentsDir(p), "policy-v2.md"));
      writeFileSync(join(documentsDir(p), "policy-v2.md"), "policy v2 moved and edited\n");
      const rebound = run(p, "rebind policy.md -> policy-v2.md", [
        "rebind", id, "--to", "aidlc/spaces/default/knowledge/documents/policy-v2.md",
      ]);
      expect(rebound.id).toBe(id);
      expect(rebound.to).toBe("documents/policy-v2.md");
      rows = checkInvariants(p, "after rebind");
      expect(rows.find((r) => r.id === id)?.path).toBe("documents/policy-v2.md");

      const syncAfterRebind = run(p, "sync after rebind", ["sync"]);
      const retried = (syncAfterRebind.changes as { id: string; change: string }[]).find((c) => c.id === id);
      expect(retried?.change, "rebind invalidates extraction; sync must re-extract").toBe("retried");
      rows = checkInvariants(p, "after sync (rebind re-extraction)");
      const shown = run(p, "show rebound row content", ["show", id]);
      expect(shown.content).toBe("policy v2 moved and edited\n");
    },
    30_000,
  );

  test(
    "growing a file past the 32 MiB cap refuses cleanly (NOT a tombstone) while it exists on disk, and a real deletion still tombstones",
    () => {
      const p = scratchProject();
      const abs = doc(p, "growing.md", "small\n");
      run(p, "onboard growing.md", ["onboard", abs]);
      let rows = checkInvariants(p, "after onboard growing.md (small)");
      const id = rows[0].id;

      // Grow it PAST the 32 MiB per-document cap. Reproduced live against the
      // shipped tool before this test existed: the old behaviour reported
      // `change: "removed"` and `list` said "tombstoned" for a file `ls`
      // shows plainly present.
      const chunk = Buffer.alloc(1024 * 1024, "a");
      const fh = require("node:fs").openSync(abs, "a");
      for (let i = 0; i < 33; i++) require("node:fs").writeSync(fh, chunk);
      require("node:fs").closeSync(fh);
      expect(existsSync(abs), "the oversized file must still exist on disk").toBe(true);

      const syncOversized = run(p, "sync with oversized file present", ["sync"]);
      const oversizedChange = (syncOversized.changes as { id: string; change: string }[]).find(
        (c) => c.id === id,
      );
      expect(
        oversizedChange,
        "an oversized-but-present file must not appear as a real change (not removed)",
      ).toBeUndefined();

      rows = checkInvariants(p, "after sync (oversized, still on disk)");
      const oversizedRow = rows.find((r) => r.id === id)!;
      expect(
        oversizedRow.status,
        "status must read as refused ('present_but_refused'), never 'tombstoned', while the file exists",
      ).toBe("present_but_refused");
      expect(oversizedRow.status).not.toBe("tombstoned");

      // Now a REAL deletion: the row must still tombstone correctly.
      rmSync(abs);
      const syncAfterDelete = run(p, "sync after deleting the oversized file", ["sync"]);
      const deleteChange = (syncAfterDelete.changes as { id: string; change: string }[]).find(
        (c) => c.id === id,
      );
      expect(deleteChange?.change, "a genuine deletion of a refused file must still tombstone").toBe("removed");
      rows = checkInvariants(p, "after sync (oversized file genuinely deleted)");
      expect(rows.find((r) => r.id === id)?.status).toBe("tombstoned");
    },
    60_000,
  );

  test(
    "onboarding past 20 documents individually, then sync, still succeeds",
    () => {
      const p = scratchProject();
      const total = 21;
      for (let i = 1; i <= total; i++) {
        const abs = doc(p, `doc${i}.md`, `doc ${i}\n`);
        run(p, `onboard doc${i}.md individually`, ["onboard", abs]);
      }
      let rows = checkInvariants(p, "after onboarding 21 documents one at a time");
      expect(rows.length).toBe(total);

      // Reproduced live against the shipped tool before this test existed:
      // `sync` over a tree that ALREADY held >20 reconciled documents refused
      // forever ("documents/ holds 21 files, over the 20-document batch
      // cap"), even with nothing changed on disk.
      const syncOverCap = run(p, "sync over a 21-document tree, nothing changed", ["sync"]);
      const changes = syncOverCap.changes as { change: string }[];
      expect(changes.every((c) => c.change === "unchanged"), "a no-op sync must not churn").toBe(true);
      rows = checkInvariants(p, "after sync over a 21-document tree");
      expect(rows.length).toBe(total);
    },
    60_000,
  );

  test("a present non-regular source is refused, not tombstoned", () => {
    const p = scratchProject();
    const abs = doc(p, "changing-kind.md", "regular first\n");
    run(p, "onboard changing-kind.md", ["onboard", abs]);
    let rows = checkInvariants(p, "after onboard changing-kind.md");
    const id = rows[0].id;

    rmSync(abs);
    mkdirSync(abs);
    const refused = run(p, "sync with directory at recorded source path", ["sync"]);
    expect((refused.changes as { id: string; change: string }[]).find((c) => c.id === id))
      .toBeUndefined();
    rows = checkInvariants(p, "after non-regular source refusal");
    expect(rows.find((r) => r.id === id)?.status).toBe("present_but_refused");

    rmSync(abs, { recursive: true });
    const removed = run(p, "sync after actual removal", ["sync"]);
    expect((removed.changes as { id: string; change: string }[]).find((c) => c.id === id)?.change)
      .toBe("removed");
  }, 30_000);
});
