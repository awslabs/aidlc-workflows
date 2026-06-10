// covers: subcommand:aidlc-runtime:summary
//
// Structural + contract port of tests/feature/t107-session-skills-readonly.sh
// (TAP plan 24). Mechanism = none: the subject is the three shipped read-only
// session-skill manifests (session-cost / replay / outcomes-pack) as bytes on
// disk. There is no process to spawn and no LLM in the loop — the test reads
// each SKILL.md straight off the distributable and asserts on its frontmatter
// and body, exactly as the .sh did via `grep` on the shipped files. Zero
// tokens, zero subprocess.
//
// The .sh carried NO `# covers:` header, so no registry link is being
// preserved here. The one enumerated unit these three skills genuinely bind to
// is the deterministic data plane every one of them sources its numbers from —
// `bun .claude/tools/aidlc-runtime.ts summary --json` — hence the
// `subcommand:aidlc-runtime:summary` claim above. (The session-skill SKILL.md
// files themselves are not an enumerated unit class in the coverage registry;
// this twin proves their authored read-only contract.)
//
// Source under test (the shipped, distributable manifests):
//   dist/claude/.claude/skills/aidlc-session-cost/SKILL.md
//   dist/claude/.claude/skills/aidlc-replay/SKILL.md
//   dist/claude/.claude/skills/aidlc-outcomes-pack/SKILL.md
// Each declares YAML frontmatter (name / user-invocable / classification) and
// a Markdown body. The PR-C contract the .sh pins:
//   - name == aidlc-<slug>, user-invocable: true, classification: read-only.
//   - every skill sources numbers from `aidlc-runtime.ts summary --json`.
//   - the retired "characters / 4" token heuristic must not reappear anywhere.
//   - read-only: no skill names appendAuditEntry / aidlc-audit.ts / an
//     aidlc-state.ts advance|approve|complete call.
//   - write surface: session-cost & replay are pure stdout (name no report
//     artefact); only outcomes-pack writes OUTCOMES.md.
//
// Test-design note (house style): assert the OBSERVABLE authored contract the
// .sh asserted — frontmatter field values and body content — and prefer
// STRONGER where cheap: frontmatter field checks are scoped to the parsed
// frontmatter BLOCK (not "appears anywhere in the file"), name is matched by
// exact equality (not a `grep ^name:` prefix), and the token-heuristic /
// audit-emit / state-advance regexes are widened to every spacing variant the
// shipped prose could use.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1  (session-cost SKILL.md exists)              -> "session-cost SKILL.md exists"
//   .sh 2  (replay SKILL.md exists)                    -> "replay SKILL.md exists"
//   .sh 3  (outcomes-pack SKILL.md exists)             -> "outcomes-pack SKILL.md exists"
//   .sh 4  (session-cost declares name)                -> "session-cost frontmatter name == aidlc-session-cost"
//   .sh 5  (replay declares name)                      -> "replay frontmatter name == aidlc-replay"
//   .sh 6  (outcomes-pack declares name)               -> "outcomes-pack frontmatter name == aidlc-outcomes-pack"
//   .sh 7  (session-cost user-invocable)               -> "session-cost frontmatter user-invocable: true"
//   .sh 8  (replay user-invocable)                     -> "replay frontmatter user-invocable: true"
//   .sh 9  (outcomes-pack user-invocable)              -> "outcomes-pack frontmatter user-invocable: true"
//   .sh 10 (session-cost classified read-only)         -> "session-cost frontmatter classification: read-only"
//   .sh 11 (replay classified read-only)               -> "replay frontmatter classification: read-only"
//   .sh 12 (outcomes-pack classified read-only)        -> "outcomes-pack frontmatter classification: read-only"
//   .sh 13 (session-cost reads summary --json)         -> "session-cost body sources aidlc-runtime.ts summary --json"
//   .sh 14 (replay reads summary --json)               -> "replay body sources aidlc-runtime.ts summary --json"
//   .sh 15 (outcomes-pack reads summary --json)        -> "outcomes-pack body sources aidlc-runtime.ts summary --json"
//   .sh 16 (session-cost drops chars/4 heuristic)      -> "session-cost carries no chars/4 token heuristic"
//   .sh 17 (replay carries no token heuristic)         -> "replay carries no chars/4 token heuristic"
//   .sh 18 (outcomes-pack carries no token heuristic)  -> "outcomes-pack carries no chars/4 token heuristic"
//   .sh 19 (session-cost no audit / no state advance)  -> "session-cost emits no audit / no state advance"
//   .sh 20 (replay no audit / no state advance)        -> "replay emits no audit / no state advance"
//   .sh 21 (outcomes-pack no audit / no state advance) -> "outcomes-pack emits no audit / no state advance"
//   .sh 22 (session-cost names no report artefact)     -> "session-cost names no report artefact"
//   .sh 23 (replay writes no SESSION-REPLAY.md)        -> "replay names no SESSION-REPLAY.md (pure stdout)"
//   .sh 24 (outcomes-pack writes OUTCOMES.md)          -> "outcomes-pack body names OUTCOMES.md as its artefact"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SKILLS_DIR = join(AIDLC_SRC, "skills");

interface Skill {
  slug: string;
  path: string;
}

const COST: Skill = {
  slug: "aidlc-session-cost",
  path: join(SKILLS_DIR, "aidlc-session-cost", "SKILL.md"),
};
const REPLAY: Skill = {
  slug: "aidlc-replay",
  path: join(SKILLS_DIR, "aidlc-replay", "SKILL.md"),
};
const PACK: Skill = {
  slug: "aidlc-outcomes-pack",
  path: join(SKILLS_DIR, "aidlc-outcomes-pack", "SKILL.md"),
};

/** Whole-file bytes of a skill manifest. */
function read(skill: Skill): string {
  return readFileSync(skill.path, "utf-8");
}

/**
 * Split a SKILL.md into its YAML frontmatter block and the body that follows.
 * The .sh checked `^name:` etc. — i.e. it relied on these being frontmatter
 * lines. We parse the leading `---\n...\n---` fence explicitly so the
 * frontmatter-field assertions are scoped to the BLOCK, not the whole file
 * (STRONGER than a bare `grep ^key:`).
 */
function split(skill: Skill): { frontmatter: string; body: string } {
  const src = read(skill);
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    throw new Error(`${skill.slug}: no YAML frontmatter fence found`);
  }
  return { frontmatter: m[1], body: m[2] };
}

/**
 * Value of a scalar frontmatter key (e.g. `name`, `user-invocable`,
 * `classification`), read from the frontmatter block only. Returns null when
 * the key is absent. Trims surrounding whitespace from the value.
 */
function frontmatterValue(skill: Skill, key: string): string | null {
  const { frontmatter } = split(skill);
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
  const hit = frontmatter.match(re);
  return hit ? hit[1].trim() : null;
}

// The retired token heuristic, every spacing/divider variant the shipped prose
// could carry (the .sh grepped `÷ 4` and `/ 4` with optional pluralisation;
// widen to optional spaces around the operator so a re-formatted regression
// can't slip through).
const TOKEN_HEURISTIC = /char(?:acter)?s?\s*[÷/]\s*4/i;

// Read-only contract: no audit-append helper, no aidlc-audit.ts reference, and
// no aidlc-state.ts state-advancing subcommand (advance / approve / complete).
const AUDIT_EMIT = /appendAuditEntry|aidlc-audit\.ts/;
const STATE_ADVANCE = /aidlc-state\.ts\s+(?:advance|approve|complete)/;

describe("t107 session skills — existence (migrated from t107-session-skills-readonly.sh, plan 24)", () => {
  test("session-cost SKILL.md exists [.sh 1]", () => {
    expect(existsSync(COST.path)).toBe(true);
  });
  test("replay SKILL.md exists [.sh 2]", () => {
    expect(existsSync(REPLAY.path)).toBe(true);
  });
  test("outcomes-pack SKILL.md exists [.sh 3]", () => {
    expect(existsSync(PACK.path)).toBe(true);
  });
});

describe("t107 session skills — frontmatter name (block-scoped, exact)", () => {
  // STRONGER than the .sh `grep '^name: aidlc-...'`: the value must equal the
  // slug exactly, and it must live in the parsed frontmatter block.
  test("session-cost frontmatter name == aidlc-session-cost [.sh 4]", () => {
    expect(frontmatterValue(COST, "name")).toBe("aidlc-session-cost");
  });
  test("replay frontmatter name == aidlc-replay [.sh 5]", () => {
    expect(frontmatterValue(REPLAY, "name")).toBe("aidlc-replay");
  });
  test("outcomes-pack frontmatter name == aidlc-outcomes-pack [.sh 6]", () => {
    expect(frontmatterValue(PACK, "name")).toBe("aidlc-outcomes-pack");
  });
});

describe("t107 session skills — user-invocable: true (block-scoped)", () => {
  test("session-cost frontmatter user-invocable: true [.sh 7]", () => {
    expect(frontmatterValue(COST, "user-invocable")).toBe("true");
  });
  test("replay frontmatter user-invocable: true [.sh 8]", () => {
    expect(frontmatterValue(REPLAY, "user-invocable")).toBe("true");
  });
  test("outcomes-pack frontmatter user-invocable: true [.sh 9]", () => {
    expect(frontmatterValue(PACK, "user-invocable")).toBe("true");
  });
});

describe("t107 session skills — classification: read-only (block-scoped)", () => {
  test("session-cost frontmatter classification: read-only [.sh 10]", () => {
    expect(frontmatterValue(COST, "classification")).toBe("read-only");
  });
  test("replay frontmatter classification: read-only [.sh 11]", () => {
    expect(frontmatterValue(REPLAY, "classification")).toBe("read-only");
  });
  test("outcomes-pack frontmatter classification: read-only [.sh 12]", () => {
    expect(frontmatterValue(PACK, "classification")).toBe("read-only");
  });
});

describe("t107 session skills — data-plane sourcing (summary --json)", () => {
  // Every skill must pull its numbers from the deterministic tool, no LLM-side
  // counting. Assert on the body so a stray frontmatter mention couldn't satisfy
  // it (STRONGER than the .sh's whole-file grep).
  const NEEDLE = "aidlc-runtime.ts summary --json";
  test("session-cost body sources aidlc-runtime.ts summary --json [.sh 13]", () => {
    expect(split(COST).body).toContain(NEEDLE);
  });
  test("replay body sources aidlc-runtime.ts summary --json [.sh 14]", () => {
    expect(split(REPLAY).body).toContain(NEEDLE);
  });
  test("outcomes-pack body sources aidlc-runtime.ts summary --json [.sh 15]", () => {
    expect(split(PACK).body).toContain(NEEDLE);
  });
});

describe("t107 session skills — retired chars/4 token heuristic must not reappear", () => {
  // Whole-file scan (the .sh grepped the whole file): the heuristic must not
  // appear in frontmatter OR body of any session skill.
  test("session-cost carries no chars/4 token heuristic [.sh 16]", () => {
    expect(TOKEN_HEURISTIC.test(read(COST))).toBe(false);
  });
  test("replay carries no chars/4 token heuristic [.sh 17]", () => {
    expect(TOKEN_HEURISTIC.test(read(REPLAY))).toBe(false);
  });
  test("outcomes-pack carries no chars/4 token heuristic [.sh 18]", () => {
    expect(TOKEN_HEURISTIC.test(read(PACK))).toBe(false);
  });
});

describe("t107 session skills — read-only contract (no audit emit / no state advance)", () => {
  // Two distinct guards collapsed onto each skill exactly as the .sh did: no
  // appendAuditEntry / aidlc-audit.ts reference, and no aidlc-state.ts
  // advance|approve|complete call.
  test("session-cost emits no audit / no state advance [.sh 19]", () => {
    const src = read(COST);
    expect(AUDIT_EMIT.test(src)).toBe(false);
    expect(STATE_ADVANCE.test(src)).toBe(false);
  });
  test("replay emits no audit / no state advance [.sh 20]", () => {
    const src = read(REPLAY);
    expect(AUDIT_EMIT.test(src)).toBe(false);
    expect(STATE_ADVANCE.test(src)).toBe(false);
  });
  test("outcomes-pack emits no audit / no state advance [.sh 21]", () => {
    const src = read(PACK);
    expect(AUDIT_EMIT.test(src)).toBe(false);
    expect(STATE_ADVANCE.test(src)).toBe(false);
  });
});

describe("t107 session skills — write surface (only outcomes-pack writes a file)", () => {
  // session-cost and replay are pure stdout; only outcomes-pack names a report
  // artefact (OUTCOMES.md). The .sh forbade SESSION-REPLAY.md and OUTCOMES.md
  // in the two stdout skills and required OUTCOMES.md in the pack.
  test("session-cost names no report artefact [.sh 22]", () => {
    const src = read(COST);
    expect(src.includes("SESSION-REPLAY.md")).toBe(false);
    expect(src.includes("OUTCOMES.md")).toBe(false);
  });
  test("replay names no SESSION-REPLAY.md (pure stdout) [.sh 23]", () => {
    expect(read(REPLAY).includes("SESSION-REPLAY.md")).toBe(false);
  });
  test("outcomes-pack body names OUTCOMES.md as its artefact [.sh 24]", () => {
    expect(read(PACK).includes("OUTCOMES.md")).toBe(true);
  });
});
