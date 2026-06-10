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
//   .sh test 3 ([N.N.N]: link reference present)
//        -> "matching [N.N.N]: link reference present in CHANGELOG"
//   .sh test 4 (heading-count == link-ref-count, both > 0)
//        -> "## [N.N.N] heading count == [N.N.N]: link-ref count (both > 0)"
//   .sh test 5 (bun aidlc-utility.ts version prints 'aidlc <CL_VERSION>')
//        -> "wired CLI `version` subcommand prints 'aidlc <CHANGELOG version>'"
//   .sh test 6 (README badge matches version.ts)
//        -> "README.md version badge matches aidlc-version.ts"

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

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

  // .sh test 3: a matching `[N.N.N]:` link reference exists for that version.
  test("matching [N.N.N]: link reference present in CHANGELOG [.sh test 3]", () => {
    const tsVersion = versionAssignments()[0];
    const src = readFileSync(CHANGELOG, "utf-8");
    // Same anchored match the .sh's `grep -qE "^\[${TS_VERSION}\]:"` used.
    const re = new RegExp(`^\\[${tsVersion.replace(/\./g, "\\.")}\\]:`, "m");
    expect(re.test(src)).toBe(true);
    // STRONGER: the version appears in the parsed link-ref set, not just as a
    // raw substring somewhere.
    expect(changelogLinkRefs()).toContain(tsVersion);
  });

  // .sh test 4: heading count == link-ref count, both > 0 (post-rebase guard
  // for a duplicated `## [N.N.N]` block or an orphaned heading).
  test("## [N.N.N] heading count == [N.N.N]: link-ref count (both > 0) [.sh test 4]", () => {
    const headingCount = changelogHeadings().length;
    const linkRefCount = changelogLinkRefs().length;
    expect(headingCount).toBeGreaterThan(0);
    expect(headingCount).toBe(linkRefCount);
    // STRONGER than the .sh count-only check: every heading version has a
    // matching link reference and vice versa (catches a count-balanced
    // mismatch the bare count comparison would miss).
    const headings = [...changelogHeadings()].sort();
    const linkRefs = [...changelogLinkRefs()].sort();
    expect(headings).toEqual(linkRefs);
  });

  // .sh test 5: CLI wiring — `bun aidlc-utility.ts version` prints
  // `aidlc <CL_VERSION>`. This is the ONE process-boundary (cli) assertion:
  // catches a renamed constant, broken import, switch-case typo, or missing
  // version.ts. Spawn the real tool through the bun runtime (env seam).
  test("wired CLI `version` subcommand prints 'aidlc <CHANGELOG version>' [.sh test 5]", () => {
    const clVersion = changelogHeadings()[0];
    const res = spawnSync(BUN, [UTILITY_TS, "version"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    // handleVersion() writes `aidlc ${AIDLC_VERSION}\n`; the .sh compared the
    // trimmed stdout to "aidlc $CL_VERSION".
    expect((res.stdout ?? "").trim()).toBe(`aidlc ${clVersion}`);
  }, 30000);

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
});
