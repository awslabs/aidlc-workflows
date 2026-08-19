// covers: function:resolveIntentFlag function:setIntentAssociation audit:DOCUMENT_UPDATED
//
// t297 - intent association: scoping a document to an intent, and every way that
// can be ambiguous.
//
// Mechanism: real filesystem + real intent births (a hand-written intents.json
// would let the test agree with a fiction; `intent-create` produces the shape the
// tool actually meets).
//
// Subject under test: dist/claude/.claude/tools/aidlc-knowledge.ts.
//
// The rules, and what each one prevents:
//
//   SPACE-WIDE IS THE DEFAULT, spelled by OMITTING related_intent_ids. An EMPTY
//   LIST IS INVALID -- ambiguous between "space-wide" and "scoped to nothing" --
//   so dissociating the last intent deletes the key rather than leaving `[]`.
//
//   PERSISTENCE IS ALWAYS A UUID. A slug is only ever input: it is a display name
//   that can be renamed or reused, so a persisted slug would silently re-point a
//   document's scope the day someone renames an intent. The test therefore
//   asserts the slug appears NOWHERE in the written files.
//
//   AMBIGUITY FAILS, BEFORE ANYTHING IS WRITTEN. Two intents can share a slug;
//   picking one would scope the document wrongly and silently.
//
//   ASSOCIATE/DISSOCIATE ARE IDEMPOTENT AND SAY WHICH HAPPENED, and a no-op emits
//   NO audit event. A silent no-op is indistinguishable from success, and an event
//   per call would inflate the ledger with non-changes -- breaking the
//   reconstructible-from-the-ledger invariant.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentDir,
  documentsDir,
  indexPath,
  listDocuments,
  onboard,
  readIndex,
  resolveIntentFlag,
  setIntentAssociation,
  spaceAuditShardPath,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";
import {
  intentsDir,
  intentsRegistryPath,
  readIntentRegistry,
  setActiveIntentCursor,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const NOW = "2026-08-07T00:00:00Z";
const SPACE = "default";
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

let proj: string | undefined;

/** A project with N real intents, birthed through the shipped tool so the
 *  registry has the shape this code actually meets in the field. */
function projectWithIntents(...labels: string[]): string {
  proj = mkdtempSync(join(tmpdir(), "t297-"));
  for (const label of labels) {
    const r = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-utility.ts"), "intent-create", "--label", label,
       "--project-dir", proj],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(r.status, `intent-create ${label} failed: ${r.stderr}`).toBe(0);
  }
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

function doc(p: string, name: string, body = "text\n"): string {
  const full = join(documentsDir(p, SPACE), name);
  writeFileSync(full, body);
  return full;
}

function auditBody(p: string): string {
  const path = spaceAuditShardPath(p, SPACE);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

afterEach(() => {
  if (proj !== undefined) {
    rmSync(proj, { recursive: true, force: true });
    proj = undefined;
  }
});

describe("t297 space-wide is the default, and is spelled by OMISSION", () => {
  test("no --intent means the key is ABSENT, not an empty array", () => {
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const row = readIndex(p, SPACE).documents[0];
    expect("related_intent_ids" in row).toBe(false);
    // An empty array would be REJECTED by the schema on the next read, so
    // producing one would make the index unreadable immediately.
    expect(row.related_intent_ids).toBeUndefined();
  });

  test("resolveIntentFlag(undefined) is null — space-wide, not an error", () => {
    const p = projectWithIntents("auth");
    expect(resolveIntentFlag(p, SPACE, undefined)).toBeNull();
  });

  test("a space-wide document is still listed with no intents field", () => {
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    expect(listDocuments(p, SPACE)[0].intents).toBeUndefined();
  });
});

describe("t297 persistence is a UUID; a slug is only ever INPUT", () => {
  test("onboard --intent <slug> persists the UUID and NOT the slug", () => {
    // The failure this prevents: a persisted slug silently re-points a document's
    // scope the day someone renames an intent.
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const resolved = resolveIntentFlag(p, SPACE, "auth");
    expect(resolved).not.toBeNull();
    onboard(p, SPACE, undefined, NOW, resolved!.uuid);

    const row = readIndex(p, SPACE).documents[0];
    expect(row.related_intent_ids).toEqual([resolved!.uuid]);
    // The slug must appear NOWHERE in either written file.
    const indexText = readFileSync(indexPath(p, SPACE), "utf-8");
    const metaText = readFileSync(join(documentDir(p, SPACE, row.id), "metadata.json"), "utf-8");
    expect(indexText).not.toContain('"auth"');
    expect(metaText).not.toContain('"auth"');
  });

  test("RENAMING the slug does not break an existing association", () => {
    // The whole reason persistence is a UUID. The registry row keeps its uuid; the
    // document keeps pointing at it.
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const resolved = resolveIntentFlag(p, SPACE, "auth")!;
    onboard(p, SPACE, undefined, NOW, resolved.uuid);

    // Rename the slug in the registry, leaving the uuid alone.
    const registry = readIntentRegistry(p, SPACE);
    registry[0].slug = "authentication";
    writeFileSync(intentsRegistryPath(p, SPACE), `${JSON.stringify(registry, null, 2)}\n`);

    // The association still resolves to the same intent by uuid.
    const row = readIndex(p, SPACE).documents[0];
    expect(row.related_intent_ids).toEqual([resolved.uuid]);
    expect(readIntentRegistry(p, SPACE)[0].uuid).toBe(resolved.uuid);
    // And the NEW slug now resolves to that same uuid.
    expect(resolveIntentFlag(p, SPACE, "authentication")!.uuid).toBe(resolved.uuid);
  });

  test("bare --intent resolves the ACTIVE intent to a UUID", () => {
    const p = projectWithIntents("auth");
    const bare = resolveIntentFlag(p, SPACE, "");
    expect(bare).not.toBeNull();
    expect(bare!.uuid).toMatch(/^[0-9a-f]{8}-/);
    expect(bare!.slug).toBe("auth");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The finding this closes: the unchanged-document shortcut in `onboard`
// returned `already` BEFORE `intentUuid` was applied, so re-onboarding an
// already-indexed, UNCHANGED document with `--intent` succeeded (status
// `already`, exit 0) while leaving `related_intent_ids` untouched -- silently
// discarding the scope the caller asked for.
// ─────────────────────────────────────────────────────────────────────────────
describe("t297 an unchanged re-onboard with --intent applies the scope, not just reports `already`", () => {
  test("onboard WITHOUT --intent, then again WITH --intent on the unchanged file: the scope lands", () => {
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const first = onboard(p, SPACE, undefined, NOW);
    expect(first.indexed[0].status).toBe("fresh");
    expect(readIndex(p, SPACE).documents[0].related_intent_ids).toBeUndefined();

    const intent = resolveIntentFlag(p, SPACE, "auth")!;
    const second = onboard(p, SPACE, undefined, NOW, intent.uuid);
    expect(second.indexed[0].status).toBe("already");
    // The command SUCCEEDED at status "already", but the scope it was asked
    // to apply must not have been dropped just because the digest matched.
    const row = readIndex(p, SPACE).documents[0];
    expect(row.related_intent_ids, "an unchanged re-onboard must not silently drop --intent").toEqual([intent.uuid]);
  });

  test("the association is idempotent: re-onboarding a THIRD time with the same --intent is a true no-op", () => {
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;
    onboard(p, SPACE, undefined, NOW, intent.uuid);
    const before = readFileSync(indexPath(p, SPACE), "utf-8");
    onboard(p, SPACE, undefined, NOW, intent.uuid);
    expect(readFileSync(indexPath(p, SPACE), "utf-8")).toBe(before);
  });

  test("through the real CLI: onboard, then onboard --intent on the unchanged path, applies the scope", () => {
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const first = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(first.status, first.stderr).toBe(0);
    const second = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--intent", "auth", "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).indexed[0].status).toBe("already");
    const row = readIndex(p, SPACE).documents[0];
    expect(row.related_intent_ids?.length, "the CLI path must apply the scope too").toBe(1);
  });
});

describe("t297 every ambiguity FAILS, before anything is written", () => {
  test("an unknown slug is refused, and the message lists what IS known", () => {
    const p = projectWithIntents("auth");
    const err = (() => {
      try { resolveIntentFlag(p, SPACE, "nope"); return null; } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/No intent with slug "nope"/);
    // Listing the alternatives beats making the user go look.
    expect(err?.message).toMatch(/auth/);
  });

  test("a DUPLICATE slug is ambiguous and refused, naming the record dirs", () => {
    // Two intents can share a slug. Picking one would scope the document wrongly
    // and silently, so the refusal names the dirs that disambiguate.
    const p = projectWithIntents("auth", "auth");
    const err = (() => {
      try { resolveIntentFlag(p, SPACE, "auth"); return null; } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/Ambiguous intent "auth"/);
    expect(err?.message).toMatch(/record-dir name/);
  });

  test("--intent in a space with NO intents is refused, with both options named", () => {
    proj = mkdtempSync(join(tmpdir(), "t297-"));
    mkdirSync(documentsDir(proj, SPACE), { recursive: true });
    const err = (() => {
      try { resolveIntentFlag(proj!, SPACE, "auth"); return null; } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/no intents/);
    // Both remedies, because either may be what the user meant.
    expect(err?.message).toMatch(/drop the flag/);
    expect(err?.message).toMatch(/birth an intent/);
  });

  test("a refused resolution writes NOTHING", () => {
    // Resolution happens before the transaction precisely so a failure leaves no
    // trace -- and it reads intents.json, which can fail.
    const p = projectWithIntents("auth", "auth");
    doc(p, "a.md");
    expect(() => resolveIntentFlag(p, SPACE, "auth")).toThrow();
    expect(existsSync(indexPath(p, SPACE))).toBe(false);
  });
});

describe("t297 associate/dissociate are idempotent and SAY which happened", () => {
  test("a fresh associate reports `fresh` and adds the uuid", () => {
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;

    const out = setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "associate");
    expect(out.status).toBe("fresh");
    expect(readIndex(p, SPACE).documents[0].related_intent_ids).toEqual([intent.uuid]);
  });

  test("associating TWICE reports `already` and emits NO second event", () => {
    // An event per call inflates the ledger with non-changes and breaks the
    // reconstructible-from-the-ledger invariant.
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;

    setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "associate");
    const afterFirst = auditBody(p);
    const second = setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "associate");

    expect(second.status).toBe("already");
    // Byte-identical ledger: the no-op wrote nothing at all.
    expect(auditBody(p)).toBe(afterFirst);
    expect(readIndex(p, SPACE).documents[0].related_intent_ids).toEqual([intent.uuid]);
  });

  test("dissociating an UNLINKED intent reports `already` and emits nothing", () => {
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;
    const before = auditBody(p);

    const out = setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "dissociate");
    expect(out.status).toBe("already");
    expect(auditBody(p)).toBe(before);
  });

  test("dissociating the LAST intent OMITS the key rather than leaving []", () => {
    // An empty list is invalid -- ambiguous between space-wide and scoped-to-
    // nothing -- so it must never be written. The schema would reject the row on
    // the next read.
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;

    setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "associate");
    setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "dissociate");

    const row = readIndex(p, SPACE).documents[0];
    expect("related_intent_ids" in row).toBe(false);
    // And the index still reads back, which it would not with an empty array.
    expect(() => readIndex(p, SPACE)).not.toThrow();
  });

  test("a second intent is ADDED, not replaced", () => {
    const p = projectWithIntents("auth", "billing");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const a = resolveIntentFlag(p, SPACE, "auth")!;
    const b = resolveIntentFlag(p, SPACE, "billing")!;

    setIntentAssociation(p, SPACE, indexed[0].id, a.uuid, "associate");
    setIntentAssociation(p, SPACE, indexed[0].id, b.uuid, "associate");
    expect(readIndex(p, SPACE).documents[0].related_intent_ids).toEqual([a.uuid, b.uuid]);

    // Removing one leaves the other.
    setIntentAssociation(p, SPACE, indexed[0].id, a.uuid, "dissociate");
    expect(readIndex(p, SPACE).documents[0].related_intent_ids).toEqual([b.uuid]);
  });

  test("an unknown document id is refused, with the remedy named", () => {
    const p = projectWithIntents("auth");
    const intent = resolveIntentFlag(p, SPACE, "auth")!;
    const err = (() => {
      try {
        setIntentAssociation(p, SPACE, "019fda80-8f8d-7bfa-b56c-983cf0353faa",
          intent.uuid, "associate");
        return null;
      } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/No document with id/);
    expect(err?.message).toMatch(/knowledge list/);
  });

  test("metadata.json is updated alongside the index, so the REBUILD agrees", () => {
    // index.json is the catalog and metadata.json is what rebuilds it -- if only
    // one carried the association, a rebuild would silently drop the scoping.
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;
    setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "associate");

    const meta = JSON.parse(
      readFileSync(join(documentDir(p, SPACE, indexed[0].id), "metadata.json"), "utf-8"),
    );
    expect(meta.related_intent_ids).toEqual([intent.uuid]);
  });
});

describe("t297 the event lands in the SPACE shard, with the intent as a FIELD", () => {
  test("DOCUMENT_UPDATED records the intent without selecting the shard by it", () => {
    // This verb is precisely what can CHANGE a document's scope, so it is the one
    // that would split a document's history across shards if the intent selected
    // the destination.
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;
    setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "associate");

    const body = auditBody(p);
    expect(body).toContain("**Event**: DOCUMENT_UPDATED");
    expect(body).toContain(`**Intent**: ${intent.uuid}`);
    expect(body).toContain("**Change**: associate");
    // The shard is the space one, not the intent's.
    expect(spaceAuditShardPath(p, SPACE)).toContain(join("intents", "audit"));
  });

  test("both associate and dissociate land in the SAME shard", () => {
    // One document's history must be readable in one place across a scope change.
    const p = projectWithIntents("auth");
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const intent = resolveIntentFlag(p, SPACE, "auth")!;
    setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "associate");
    setIntentAssociation(p, SPACE, indexed[0].id, intent.uuid, "dissociate");

    const body = auditBody(p);
    expect((body.match(/\*\*Event\*\*: DOCUMENT_UPDATED/g) ?? []).length).toBe(2);
    expect(body).toContain("**Change**: dissociate");
  });
});

describe("t297 I09: a space-wide document survives intent creation", () => {
  test("indexing space-wide, then birthing an intent, leaves the row findable", () => {
    // The row this story inherited: the failure mode is a row that becomes
    // unreachable once the space gains its first intent, because something
    // re-targeted by the active-intent cursor. Count totals must not move.
    proj = mkdtempSync(join(tmpdir(), "t297-"));
    const p = proj;
    mkdirSync(documentsDir(p, SPACE), { recursive: true });
    doc(p, "a.md");

    // Index BEFORE any intent exists.
    const first = onboard(p, SPACE, undefined, NOW);
    expect(first.indexed.length).toBe(1);
    const id = first.indexed[0].id;
    expect(readIndex(p, SPACE).documents.length).toBe(1);

    // Now birth the space's FIRST intent.
    const r = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-utility.ts"), "intent-create", "--label", "auth",
       "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(r.status, r.stderr).toBe(0);

    // The row is still there, still space-wide, still the same id.
    const rows = readIndex(p, SPACE).documents;
    expect(rows.length, "creating an intent must not lose a row").toBe(1);
    expect(rows[0].id).toBe(id);
    expect("related_intent_ids" in rows[0]).toBe(false);
    // And it is still findable through the read path.
    expect(listDocuments(p, SPACE).map((d) => d.id)).toEqual([id]);

    // Re-onboarding is idempotent across the boundary: still ONE row, reported
    // `already` rather than duplicated under the new intent.
    const second = onboard(p, SPACE, undefined, NOW);
    expect(second.indexed.map((o) => o.status)).toEqual(["already"]);
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// An ORPHAN intent record: a dir under `intents/` holding a real
// `aidlc-state.md` but NO row in `intents.json` -- a hand-created record, or
// one whose registry row was lost/never written. `listIntents()`
// (aidlc-lib.ts) reports this as `{ uuid: "", status: "unknown", ... }`, a
// STRING, never `undefined`.
//
// The finding this closes: `resolveIntentFlag`'s bare-flag path (`--intent`
// with no value, meaning "the active one") matched this orphan by `dirName`
// and returned `match.uuid` -- the empty string -- as a resolved intent.
// `intentUuid !== undefined` back in `onboard` is TRUE for `""`, so `onboard`
// staged and RENAMED a completed document tree into place with
// `related_intent_ids: [""]` before the schema's write-side UUID check ever
// ran. Reproduced on a FRESH space, zero hand-editing of anything this tool
// itself would not create in the ordinary course of a hand-authored orphan.
// ─────────────────────────────────────────────────────────────────────────────
describe("t297 an ORPHAN intent record (no registry row) refuses to scope a document", () => {
  /** A project with one real, hand-authored orphan record: a dir under
   *  intents/ holding aidlc-state.md, with NO row in intents.json, made the
   *  ACTIVE intent so the bare `--intent` flag resolves to it. */
  function projectWithOrphanIntent(): string {
    proj = mkdtempSync(join(tmpdir(), "t297-orphan-"));
    const p = proj;
    mkdirSync(documentsDir(p, SPACE), { recursive: true });
    const dirName = "orphan-ab12cd34";
    mkdirSync(join(intentsDir(p, SPACE), dirName), { recursive: true });
    writeFileSync(join(intentsDir(p, SPACE), dirName, "aidlc-state.md"), "# state\n");
    setActiveIntentCursor(p, dirName, SPACE);
    return p;
  }

  test("resolveIntentFlag('') on an orphan cursor REFUSES, naming the remedy", () => {
    const p = projectWithOrphanIntent();
    const err = (() => {
      try { resolveIntentFlag(p, SPACE, ""); return null; } catch (e) { return e as Error; }
    })();
    expect(err, "an orphan intent must not resolve to a usable UUID").not.toBeNull();
    expect(err?.message).toMatch(/orphan/i);
    expect(err?.message).toMatch(/intents\.json/);
  });

  test("onboard --intent through the orphan refuses BEFORE writing anything -- the space can self-heal", () => {
    // The regression, driven through the real CLI so the staging/rename passes
    // are the actual code under test, not a mock of them.
    const p = projectWithOrphanIntent();
    doc(p, "policy.md");
    const r = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--intent", "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(r.status, `expected a refusal, got stdout: ${r.stdout}`).not.toBe(0);
    expect((r.stdout ?? "") + (r.stderr ?? "")).toMatch(/orphan/i);

    // NOTHING landed: no index.json, no documentkb/<id>/ dir at all -- the
    // refusal fires before staging, not after a rename already committed a
    // bad row (which is what the shipped tool did before this fix).
    expect(existsSync(indexPath(p, SPACE))).toBe(false);

    // The space is immediately usable: a plain onboard (no --intent) succeeds,
    // and so does a subsequent sync. Self-heal is a PROPERTY, not a one-off --
    // asserted here for the specific failure this finding measured; the
    // general property (any injected failure -> a later plain sync succeeds)
    // is pinned separately in t278's self-heal suite.
    const plain = onboard(p, SPACE, undefined, NOW);
    expect(plain.refused).toBeUndefined();
    expect(plain.indexed.length).toBe(1);
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  });

  test("resolveIntentFlag by SLUG through an orphan also refuses (both resolution paths)", () => {
    // The bare-flag path is what the finding measured, but the named-slug path
    // shares the same `match.uuid` return and must not have a second hole.
    const p = projectWithOrphanIntent();
    const err = (() => {
      try {
        // The orphan's displayed slug is derived from its dir name (see
        // listIntents' displaySlugFromDirName), which for "orphan-ab12cd34" is
        // "orphan".
        resolveIntentFlag(p, SPACE, "orphan");
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/orphan/i);
  });
});
