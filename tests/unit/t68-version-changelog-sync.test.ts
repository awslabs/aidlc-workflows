// covers: subcommand:aidlc-utility:version
//
// Port of tests/unit/t68-version-changelog-sync.sh (TAP plan 6).
// Mechanism = mixed: five of the six checks are deterministic text/filesystem
// invariants over real repo files already on disk (no spawn, no import of a
// shipped unit — mechanism none), and ONE check spawns the wired CLI through
// the bun runtime to assert the process-boundary version contract (mechanism
// cli). Because the body BOTH reads files in-process AND spawns the real tool,
// the derived mechanism is mixed.
//
// COVERS HEADER: the .sh carried NO `# covers:` header. Of its six checks,
// five guard repo metadata consistency (CHANGELOG.md ⇄ aidlc-version.ts ⇄
// README.md) and join to no enumerated unit class. The sixth (test 5) is the
// only one that exercises a shipped unit: it invokes the wired `version`
// subcommand of aidlc-utility.ts and asserts its exact stdout. That subcommand
// (`aidlc-utility version`, registry minMechanism=cli) was UNCOVERED in the
// registry; this twin claims it via `subcommand:aidlc-utility:version` (the
// colon form gen-coverage-registry.ts:952 accepts, joining to unitId
// "aidlc-utility version"). The five metadata-guard checks contribute no
// enumerated-unit claim, exactly as the .sh contributed none.
//
// SUBJECT / SOURCE UNDER TEST:
//   - dist/claude/.claude/tools/aidlc-version.ts:4
//       export const AIDLC_VERSION = "<N.N.N>";  (single source of truth)
//   - CHANGELOG.md (repo root): reverse-chronological `## [N.N.N] - DATE`
//       headings + matching `[N.N.N]:` link references at the bottom.
//   - dist/claude/.claude/tools/aidlc-utility.ts:
//       :54 imports AIDLC_VERSION; :173 handleVersion() writes
//       `aidlc ${AIDLC_VERSION}\n` to stdout; :2823 the `version` subcommand
//       dispatches to it. A renamed constant, broken import, or switch-case
//       typo would break this seam.
//   - README.md:5 shields.io badge
//       ![version](https://img.shields.io/badge/version-<N.N.N>-blue)
//
// WHY mostly mechanism none (not cli): tests 1-4 and 6 are pure greps over
// files on disk — exactly the bash `grep -oE ... | head -1` extractions and
// `grep -cE` counts the .sh ran. None needs a spawned tool; we read the same
// bytes and compute the same invariants in-process. Test 5 is the one
// process-boundary contract: it asserts the CLI's stdout, so it spawns the
// real aidlc-utility.ts via the bun runtime (the same env seam the .sh's
// `bun "$UTILITY_TS" version` used), preserving that guarantee unweakened.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (extracted exactly one non-empty AIDLC_VERSION)
//        -> "version.ts declares exactly one AIDLC_VERSION assignment"
//   .sh test 2 (AIDLC_VERSION matches latest CHANGELOG heading)
//        -> "AIDLC_VERSION matches the latest CHANGELOG heading"
//   .sh test 3 ([N.N.N]: link reference present)  [SUPERSEDED — see below]
//        -> "the latest version appears as a CHANGELOG heading"
//   .sh test 4 (heading-count == link-ref-count, both > 0)  [REPURPOSED]
//        -> "## [N.N.N] headings are unique (no duplicate / post-rebase dupe)"
//   .sh test 5 (bun aidlc-utility.ts version prints 'aidlc <CL_VERSION>')
//        -> "wired CLI `version` subcommand prints 'aidlc <CHANGELOG version>'"
//   .sh test 6 (README badge matches version.ts)
//        -> "README.md version badge matches aidlc-version.ts"
//
// CHANGELOG LINK-REF POLICY CHANGE (v0.6.9): the bottom-of-file `[N.N.N]:`
// link references were REMOVED. They shipped as broken `OWNER/REPO` scaffold
// placeholders, and this file is distributed inside `.claude/` — internal users
// download it and may share it externally, so embedding a repository host (the
// internal GitLab or a not-yet-populated public mirror) is wrong. Version
// headings stay as readable `## [N.N.N]` text; per-release compare links belong
// on the public release home, added at the publish step, not in the shipped file.
//   - test 3 was "the matching link-ref exists" — SUPERSEDED: the version pin is
//     the heading (test 2 already binds version.ts == latest heading); test 3
//     now just asserts the heading is present in the parsed heading set.
//   - test 4 was "heading count == link-ref count" (a post-rebase duplicate
//     guard) — REPURPOSED to assert headings are UNIQUE, the real invariant it
//     protected (a rebase that duplicates a `## [N.N.N]` block).
//   - NET-NEW test 7: the link-ref policy guard — NO version link references may
//     reappear, and no repository host URL may leak into the changelog.
// (.test.ts has no TAP `plan`, so changing case bodies does not drift t55 — see
// t55's header; the "plan 6" provenance above describes the .sh ancestor.)

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath; // the bun running this test
const VERSION_TS = join(AIDLC_SRC, "tools", "aidlc-version.ts");
const UTILITY_TS = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const CHANGELOG = join(REPO_ROOT, "CHANGELOG.md");
const README = join(REPO_ROOT, "README.md");

const SEMVER = /[0-9]+\.[0-9]+\.[0-9]+/;

/** All `AIDLC_VERSION = "N.N.N"` literals in version.ts (defends against a
 *  merge-conflict marker leaving two assignments — the .sh's `head -1` + count). */
function versionAssignments(): string[] {
  const src = readFileSync(VERSION_TS, "utf-8");
  return [...src.matchAll(/AIDLC_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)"/g)].map(
    (m) => m[1],
  );
}

/** The first (latest, reverse-chronological) `## [N.N.N]` CHANGELOG heading. */
function changelogHeadings(): string[] {
  const src = readFileSync(CHANGELOG, "utf-8");
  return src
    .split("\n")
    .filter((l) => /^## \[[0-9]+\.[0-9]+\.[0-9]+\]/.test(l))
    .map((l) => (l.match(SEMVER) as RegExpMatchArray)[0]);
}

/** Every `[N.N.N]:` link-reference line at the bottom of CHANGELOG. */
function changelogLinkRefs(): string[] {
  const src = readFileSync(CHANGELOG, "utf-8");
  return src
    .split("\n")
    .filter((l) => /^\[[0-9]+\.[0-9]+\.[0-9]+\]:/.test(l))
    .map((l) => (l.match(SEMVER) as RegExpMatchArray)[0]);
}

describe("t68 version/CHANGELOG/README sync (migrated from t68-version-changelog-sync.sh, plan 6)", () => {
  // .sh test 1: extracted exactly one non-empty version from version.ts.
  test("version.ts declares exactly one AIDLC_VERSION assignment [.sh test 1]", () => {
    const assigns = versionAssignments();
    expect(assigns.length).toBe(1);
    expect(assigns[0]).toMatch(SEMVER);
    expect(assigns[0].length).toBeGreaterThan(0);
  });

  // .sh test 2: AIDLC_VERSION matches the FIRST (latest) CHANGELOG heading.
  test("AIDLC_VERSION matches the latest CHANGELOG heading [.sh test 2]", () => {
    const tsVersion = versionAssignments()[0];
    const latestHeading = changelogHeadings()[0];
    expect(tsVersion).toBe(latestHeading);
  });

  // test 3 (SUPERSEDED): the version pin is the HEADING, not a link reference
  // (link refs were removed in v0.6.9 — see the header note). Test 2 already
  // binds version.ts == latest heading; here we assert that version is present
  // in the parsed heading set (the canonical pin), not as a raw substring.
  test("the latest AIDLC_VERSION appears as a CHANGELOG heading [.sh test 3, superseded]", () => {
    const tsVersion = versionAssignments()[0];
    expect(changelogHeadings()).toContain(tsVersion);
  });

  // test 4 (REPURPOSED): the .sh guarded against a duplicated `## [N.N.N]` block
  // post-rebase via a heading==link-ref count match. With link refs gone, the
  // real invariant it protected is that headings are UNIQUE — a rebase that
  // duplicates a version block (the t68 conflict-trap in AGENTS.md) must fail.
  test("## [N.N.N] headings are unique — no duplicate version block [.sh test 4, repurposed]", () => {
    const headings = changelogHeadings();
    expect(headings.length).toBeGreaterThan(0);
    const dupes = headings.filter((v, i) => headings.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  // .sh test 5: CLI wiring — `bun aidlc-utility.ts version` prints
  // `aidlc <CL_VERSION>`. This is the ONE process-boundary (cli) assertion:
  // catches a renamed constant, broken import, switch-case typo, or missing
  // version.ts. Spawn the real tool through the bun runtime (env seam).
  test("wired CLI `version` subcommand prints 'aidlc <CHANGELOG version>' [.sh test 5]", () => {
    const clVersion = changelogHeadings()[0];
    const res = spawnSync(BUN, [UTILITY_TS, "version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    expect(res.status).toBe(0);
    // handleVersion() writes `aidlc ${AIDLC_VERSION}\n`; the .sh compared the
    // trimmed stdout to "aidlc $CL_VERSION".
    expect((res.stdout ?? "").trim()).toBe(`aidlc ${clVersion}`);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // .sh test 6: README shields.io badge matches version.ts. A release that
  // bumps version.ts but forgets the badge ships a wrong public number
  // (the v0.5.0 release missed exactly this).
  test("README.md version badge matches aidlc-version.ts [.sh test 6]", () => {
    const tsVersion = versionAssignments()[0];
    const src = readFileSync(README, "utf-8");
    // Same extraction the .sh ran: between `badge/version-` and `-blue`.
    const m = src.match(/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-blue/);
    expect(m).not.toBeNull();
    expect((m as RegExpMatchArray)[1]).toBe(tsVersion);
  });

  // NET-NEW test 7: link-ref policy guard. Version link references were removed
  // in v0.6.9 (broken `OWNER/REPO` placeholders + host-leak risk in a file
  // internal users download and may share externally). This guard fails if a
  // `[N.N.N]:` link reference reappears OR if any repository host URL leaks into
  // the changelog — both forms reintroduce the exact problems the removal fixed.
  test("CHANGELOG carries no version link references and no repository host URL", () => {
    const src = readFileSync(CHANGELOG, "utf-8");
    // No bottom-of-file `[N.N.N]:` link-reference lines.
    expect(changelogLinkRefs()).toEqual([]);
    // No host URL anywhere — neither the internal GitLab, nor a github mirror,
    // nor the scaffold placeholder. (Prose may name a host in plain words; this
    // bans URL forms + the placeholder token that imply a shipped link.)
    const banned = [
      "gitlab.aws.dev",
      "github.com/",
      "OWNER/REPO",
    ];
    const hits = banned.filter((b) => src.includes(b));
    expect(hits).toEqual([]);
  });
});
