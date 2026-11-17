// covers: function:replyTurnsAfter, function:personRepliedAfter, function:repliesAfter, function:latestReplyAfter, function:auditMark
//
// The plan question's reply check (#3603). A question remembers where this
// checkout's audit trail stood when it was shown. A team checkout that claims
// a Unit after that writes the work's rows, the person's turns included, to
// the Unit's own record, so the check reads the person's turns in the mark's
// shard after its offset and in the shard the checkout writes now, stamped
// after the mark. What it never counts: a turn from before the question (one
// the claim moved into the Unit's record included), a command to AIDLC, a turn
// another engine question took, a turn a HOST_TURN took back (in either
// shard), another work's turn, another clone's. A question shown before marks
// kept a time takes one from its shard, or from its last showing when the
// claim left nothing at its offset. The shards are written by
// hand here, as the claim and the human-turn hook leave them.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { auditMark, latestReplyAfter, personRepliedAfter, repliesAfter } from "../../core/tools/aidlc-lib.ts";
import type { AuditMark } from "../../core/tools/aidlc-record-core.ts";
import { saveMessage, type StoredMessage } from "../../core/tools/aidlc-message-store.ts";
import {
  DEFAULT_INTENT_UUID,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const HOST = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "host";
const TOKEN = "planreplyshards";
// The claim's own shard name for a checkout whose shard main already has.
const CLAIM_SHARD = `${HOST}-5f02e3230680.md`;
const OTHER_UUID = "00000000-0000-7000-8000-000000000002";
const OTHER_RECORD = `other-${OTHER_UUID.replace(/-/g, "").slice(-16)}`;
const CHAT = "01995000-7a11-7000-8000-00000000a001";

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
// Whole seconds before and after now, the mark's own time.
const before = (s: number) => iso(Date.now() - s * 1000);
const after = (s: number) => iso(Date.now() + s * 1000);

const block = (event: string, at: string, fields: Record<string, string> = {}) =>
  [`## ${event}`, `**Timestamp**: ${at}`, `**Event**: ${event}`, ...Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)]
    .join("\n");
const rows = (...blocks: string[]) => blocks.map((b) => `\n${b}\n\n---\n`).join("");
const turn = (at: string, id: string, extra: Record<string, string> = {}) =>
  block("HUMAN_TURN", at, { Session: CHAT, Origin: "person", Source: "typed", "Message Id": id, ...extra });

// The person's message as the human-turn hook keeps it.
function message(dir: string, text: string, at: string): StoredMessage {
  return saveMessage(dir, {
    session: CHAT, at, source: "prompt", text, picker: null, words: text, settings: [],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  });
}

const made: string[] = [];
const previous = process.env.CLAUDE_PROJECT_DIR;
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previous;
});

interface Checkout {
  dir: string;
  /** This clone's tracked shard, where the question was shown. */
  tracked: string;
  /** The claimed Unit's own record, once the claim's stamp is written. */
  unitRecord: string;
}

// A team checkout of one work, its own shard on record, no claim yet.
function checkout(): Checkout {
  const dir = mkdtempSync(join(tmpdir(), "t-plan-reply-every-shard-"));
  made.push(dir);
  const intents = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  writeFileSync(join(intents, "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([
    { uuid: DEFAULT_INTENT_UUID, slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" },
    { uuid: OTHER_UUID, slug: "other", status: "in-flight" },
  ])}\n`);
  seedAidlcMemory(dir);
  const state = readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md"), "utf-8")
    .replace("## Runtime State\n", "## Runtime State\n- **Unit Ownership**: team\n");
  writeFileSync(seededStateFile(dir), state);
  writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${TOKEN}\n${HOST}\n`);
  const audit = join(seededRecordDir(dir), "audit");
  mkdirSync(audit, { recursive: true });
  const tracked = join(audit, `${HOST}-${TOKEN}.md`);
  writeFileSync(tracked, `# AI-DLC Audit Log\n${rows(block("STAGE_STARTED", before(600), { Stage: "code-generation" }))}`);
  process.env.CLAUDE_PROJECT_DIR = dir;
  return { dir, tracked, unitRecord: join(seededRecordDir(dir), ".aidlc-engine", "audit", CLAIM_SHARD) };
}

// The claim's stamp: from now on the checkout writes the work's rows to the
// Unit's own record, starting with the rows the claim moved there.
function claim(c: Checkout, moved = ""): void {
  writeFileSync(join(c.dir, "aidlc", ".aidlc-unit-scope.json"), `${JSON.stringify({
    version: 1, space: DEFAULT_SPACE, intent_uuid: DEFAULT_INTENT_UUID, intent_id8: "00000001", unit: "alpha",
    owner: "lead team", generation: 1, nonce: "5f02e323-0680-4e0e-b544-f5543bc69171",
    claim_ref: "refs/heads/claim/00000001/alpha", claim_oid: "0".repeat(40), claimed_from_oid: "1".repeat(40),
    integration_ref: "refs/remotes/origin/main", gate_rhythm: "per-stage", audit_shard: CLAIM_SHARD,
  })}\n`);
  mkdirSync(join(seededRecordDir(c.dir), ".aidlc-engine", "audit"), { recursive: true });
  writeFileSync(c.unitRecord, moved);
}

// The question shown: the mark it keeps, in the shard written then.
function shown(c: Checkout): AuditMark {
  const mark = auditMark(c.dir);
  appendFileSync(c.tracked, rows(block("QUESTION_ASKED", iso(Date.now()), { Checkpoint: "plan-approval" })));
  return mark;
}

describe("a reply in the Unit's record after a claim", () => {
  test("counts: the lead's checkout claimed the Unit after the question was shown", () => {
    const c = checkout();
    const mark = shown(c);
    expect(mark.shard).toBe(`aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}/audit/${HOST}-${TOKEN}.md`);
    claim(c);
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
    appendFileSync(c.unitRecord, rows(turn(after(2), "8af869ee")));
    expect(personRepliedAfter(c.dir, mark)).toBe(true);
    expect(repliesAfter(c.dir, mark).map((one) => one.messageId)).toEqual(["8af869ee"]);
    // The mark keeps the time it was taken, in whole seconds as rows are.
    expect(mark.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("a turn from before the question, moved into the Unit's record by the claim, does not count", () => {
    const c = checkout();
    const early = turn(before(120), "17c377e2");
    appendFileSync(c.tracked, rows(early));
    const mark = shown(c);
    // The claim moves the rows the shard had not committed (the early turn
    // and the question) into the Unit's record and resets the shard.
    claim(c, readFileSync(c.tracked, "utf-8").replace(/^# AI-DLC Audit Log\n/, ""));
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
    expect(repliesAfter(c.dir, mark)).toEqual([]);
  });

  test("a command to AIDLC, a turn another engine question took, and a turn taken back do not count", () => {
    const c = checkout();
    const mark = shown(c);
    claim(c);
    appendFileSync(c.unitRecord, rows(
      turn(after(2), "a1000001", { Reply: "command" }),
      turn(after(3), "a1000002", { "Open Question": "unit-paused" }),
      turn(after(4), "a1000003"),
      block("HOST_TURN", after(5), { Origin: "host", Reason: "scheduled", Source: "record", "Message Id": "a1000003" }),
    ));
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
  });

  test("a turn in the question's shard that a HOST_TURN in the Unit's record takes back does not count", () => {
    const c = checkout();
    const mark = shown(c);
    appendFileSync(c.tracked, rows(turn(after(1), "b2000001")));
    expect(personRepliedAfter(c.dir, mark)).toBe(true);
    claim(c);
    appendFileSync(c.unitRecord, rows(
      block("HOST_TURN", after(3), { Origin: "host", Reason: "scheduled", Source: "record", "Message Id": "b2000001" }),
    ));
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
  });

  test("another clone's shard and another work's record prove nothing", () => {
    const c = checkout();
    const mark = shown(c);
    claim(c);
    writeFileSync(join(seededRecordDir(c.dir), "audit", "teammate-0a1b2c3d4e5f.md"),
      `# AI-DLC Audit Log\n${rows(turn(after(2), "c3000001"))}`);
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
    // The person moves to another piece of work and replies there.
    rmSync(join(c.dir, "aidlc", ".aidlc-unit-scope.json"));
    const other = join(intentsDirOf(c.dir, DEFAULT_SPACE), OTHER_RECORD);
    mkdirSync(join(other, "audit"), { recursive: true });
    writeFileSync(join(other, "aidlc-state.md"), readFileSync(seededStateFile(c.dir), "utf-8"));
    writeFileSync(join(intentsDirOf(c.dir, DEFAULT_SPACE), "active-intent"), `${OTHER_RECORD}\n`);
    writeFileSync(join(other, "audit", `${HOST}-${TOKEN}.md`), `# AI-DLC Audit Log\n${rows(turn(after(3), "c3000002"))}`);
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
    expect(repliesAfter(c.dir, mark)).toEqual([]);
  });

  test("a question shown while the Unit was claimed counts the reply in the tracked shard once the claim is gone", () => {
    const c = checkout();
    claim(c);
    const mark = auditMark(c.dir);
    expect(mark.shard).toEndWith(`/.aidlc-engine/audit/${CLAIM_SHARD}`);
    rmSync(join(c.dir, "aidlc", ".aidlc-unit-scope.json"));
    appendFileSync(c.tracked, rows(turn(before(30), "d4000001")));
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
    appendFileSync(c.tracked, rows(turn(after(2), "d4000002")));
    expect(repliesAfter(c.dir, mark).map((one) => one.messageId)).toEqual(["d4000002"]);
  });

  test("the replies across both shards are listed oldest first, each once, and the latest names the newest", () => {
    const c = checkout();
    const mark = shown(c);
    const first = message(c.dir, "Hold on, first share it.", after(1));
    const second = message(c.dir, "Our plan looks good, go ahead.", after(3));
    const firstTurn = turn(after(1), first.id);
    appendFileSync(c.tracked, rows(firstTurn));
    // The claim moved that turn, uncommitted, into the Unit's record too.
    claim(c, rows(firstTurn));
    appendFileSync(c.unitRecord, rows(turn(after(3), second.id)));
    expect(repliesAfter(c.dir, mark).map((one) => one.messageId)).toEqual([first.id, second.id]);
    expect(latestReplyAfter(c.dir, mark)).toEqual({ messageId: second.id, words: "Our plan looks good, go ahead." });
  });
});

describe("a question shown before marks kept their time", () => {
  test("takes its time from the first row after its offset", () => {
    const c = checkout();
    appendFileSync(c.tracked, rows(turn(before(300), "e5000001")));
    const { at: _taken, ...mark } = auditMark(c.dir);
    appendFileSync(c.tracked, rows(block("QUESTION_ASKED", before(200), { Checkpoint: "plan-approval" })));
    // The claim moved a turn sent before the question into the Unit's record.
    claim(c, rows(turn(before(300), "e5000001")));
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
    appendFileSync(c.unitRecord, rows(turn(before(100), "e5000002")));
    expect(repliesAfter(c.dir, mark).map((one) => one.messageId)).toEqual(["e5000002"]);
  });

  test("proves nothing elsewhere when its shard no longer reaches its offset", () => {
    const c = checkout();
    const { at: _taken, ...mark } = auditMark(c.dir);
    appendFileSync(c.tracked, rows(block("QUESTION_ASKED", before(200), { Checkpoint: "plan-approval" })));
    claim(c);
    truncateSync(c.tracked, mark.offset - 1);
    appendFileSync(c.unitRecord, rows(turn(before(100), "f6000001")));
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
  });

  test("with no row left at its offset, takes the time its question was shown again", () => {
    const c = checkout();
    const { at: _taken, ...mark } = auditMark(c.dir);
    appendFileSync(c.tracked, rows(block("QUESTION_ASKED", before(200), { Checkpoint: "plan-approval" })));
    claim(c, rows(turn(before(300), "f7000001")));
    truncateSync(c.tracked, mark.offset - 1);
    appendFileSync(c.unitRecord, rows(turn(before(150), "f7000002")));
    // Shown again 120 seconds ago: only a reply after that counts.
    expect(personRepliedAfter(c.dir, mark, before(120))).toBe(false);
    appendFileSync(c.unitRecord, rows(turn(before(100), "f7000003")));
    expect(personRepliedAfter(c.dir, mark, before(120))).toBe(true);
  });
});

describe("work with no claim reads as before", () => {
  test("a reply after the mark counts and one before it does not", () => {
    const c = checkout();
    appendFileSync(c.tracked, rows(turn(before(60), "a7000001")));
    const mark = shown(c);
    expect(personRepliedAfter(c.dir, mark)).toBe(false);
    // Read by its offset: a turn written after the mark counts in its own shard.
    appendFileSync(c.tracked, rows(turn(before(60), "a7000002")));
    expect(repliesAfter(c.dir, mark).map((one) => one.messageId)).toEqual(["a7000002"]);
  });
});

describe("a handover adopted into the Unit's record", () => {
  // Named in #3603's PR: a teammate's turns a handover adopts into this
  // checkout's Unit record carry nothing that names the checkout they came
  // from, so one stamped after the mark reads as a reply here. The person's
  // own words are still what an answer records.
  test("a teammate's turn stamped after the mark counts", () => {
    const c = checkout();
    const mark = shown(c);
    claim(c);
    appendFileSync(c.unitRecord, rows(block("HUMAN_TURN", after(2), {
      Session: "01995000-7a11-7000-8000-00000000b002", Origin: "person", Source: "typed", "Message Id": "0dd0b002",
    })));
    expect(personRepliedAfter(c.dir, mark)).toBe(true);
  });
});
