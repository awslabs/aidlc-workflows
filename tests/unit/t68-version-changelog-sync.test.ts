// covers: subcommand:aidlc-utility:version
//
// Mechanism = mixed: most checks are deterministic text/filesystem
// invariants over real repo files already on disk (no spawn, no import of a
// shipped unit — mechanism none), and ONE check spawns the wired CLI through
// the bun runtime to assert the process-boundary version contract (mechanism
// cli). Because the body BOTH reads files in-process AND spawns the real tool,
// the derived mechanism is mixed.
//
// COVERS HEADER: the metadata checks guard repo metadata consistency
// (CHANGELOG.md, aidlc-version.ts, README.md) and join to no enumerated unit
// class. Test 5 is the only one that exercises a shipped unit: it invokes the
// wired `version` subcommand of aidlc-utility.ts and asserts its exact stdout.
// That subcommand (`aidlc-utility version`, registry minMechanism=cli) is in the
// registry; this twin claims it via `subcommand:aidlc-utility:version` (the
// colon form gen-coverage-registry.ts accepts, joining to unitId
// "aidlc-utility version"). The metadata-guard checks contribute no
// enumerated-unit claim.
//
// SUBJECT / SOURCE UNDER TEST:
//   - dist/claude/.claude/tools/aidlc-version.ts
//       export const AIDLC_VERSION = "<N.N.N>";  (single source of truth)
//   - CHANGELOG.md (repo root): reverse-chronological `## [N.N.N] - DATE`
//       headings, with no `[N.N.N]:` link references (test 7).
//   - dist/claude/.claude/tools/aidlc-utility.ts: imports AIDLC_VERSION;
//       handleVersion() writes `aidlc ${AIDLC_VERSION}\n` to stdout; the
//       `version` subcommand dispatches to it. A renamed constant, broken
//       import, or switch-case typo would break this seam.
//   - README.md shields.io badge
//       ![version](https://img.shields.io/badge/version-<N.N.N>-blue)
//
// WHY mostly mechanism none (not cli): the metadata tests are pure greps over
// files on disk. None needs a spawned tool; we read the bytes and compute the
// invariants in-process. Test 5 is the one process-boundary contract: it
// asserts the CLI's stdout, so it spawns the real aidlc-utility.ts via the bun
// runtime.
//
// CHANGELOG LINK-REF POLICY: a distributed file should not embed a repository
// host (AGENTS.md, Release Metadata Policy), so version headings stay as
// readable `## [N.N.N]` text and per-release compare links belong on the
// public release home, added at the publish step.
//   - test 3: the version pin is the heading (test 2 already binds
//     version.ts == latest heading); test 3 asserts the heading is present in
//     the parsed heading set.
//   - test 4: headings are UNIQUE, so a rebase that duplicates a
//     `## [N.N.N]` block fails.
//   - test 7: the link-ref policy guard - NO version link references may
//     reappear, and no repository host URL may leak into the changelog.
//   - test 8 (#636): every entry newer than 2.11.0 opens with one of three
//     `Compatibility:` lines (the Release Metadata Policy in AGENTS.md).

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

const BUN = process.execPath;
const VERSION_TS = join(AIDLC_SRC, "tools", "aidlc-version.ts");
const UTILITY_TS = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const CHANGELOG = join(REPO_ROOT, "CHANGELOG.md");
const README = join(REPO_ROOT, "README.md");

const SEMVER = /[0-9]+\.[0-9]+\.[0-9]+/;

/** All `AIDLC_VERSION = "N.N.N"` literals in version.ts (defends against a
 *  merge-conflict marker leaving two assignments). */
function versionAssignments(): string[] {
  const src = readFileSync(VERSION_TS, "utf-8");
  return [...src.matchAll(/AIDLC_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)"/g)].map(
    (m) => m[1],
  );
}

/** All `## [N.N.N]` CHANGELOG headings in file order (latest first). */
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

const COMPATIBILITY_LINES = [
  "Compatibility: refresh only",
  "Compatibility: refresh plus a step",
  "Compatibility: breaking for scripts",
];

/** What is wrong with each release entry newer than 2.11.0: the first line
 *  under its heading is not one of the three Compatibility lines, or it has a
 *  bullet starting `Breaking for scripts:` and does not say so. */
function compatibilityProblems(changelog: string): string[] {
  const problems: string[] = [];
  for (const entry of changelog.split(/^(?=## \[)/m)) {
    const version = entry.match(/^## \[([0-9]+\.[0-9]+\.[0-9]+)\]/)?.[1];
    if (!version || Bun.semver.order(version, "2.11.0") <= 0) continue;
    const lines = entry.split(/\r?\n/).slice(1).map((l) => l.trimEnd());
    const line = lines.find((l) => l !== "") ?? "";
    if (!COMPATIBILITY_LINES.includes(line)) {
      problems.push(`${version}: the line under the heading is "${line}"; it must be one of: ${COMPATIBILITY_LINES.join(" | ")}`);
    } else if (lines.some((l) => /^[*-] Breaking for scripts:/.test(l)) && line !== COMPATIBILITY_LINES[2]) {
      problems.push(`${version}: has a "Breaking for scripts:" bullet, so it must say "${COMPATIBILITY_LINES[2]}", not "${line}"`);
    }
  }
  return problems;
}

describe("t68 version/CHANGELOG/README sync (migrated from t68-version-changelog-sync.sh, plan 6)", () => {
  test("version.ts declares exactly one AIDLC_VERSION assignment [.sh test 1]", () => {
    const assigns = versionAssignments();
    expect(assigns.length).toBe(1);
    expect(assigns[0]).toMatch(SEMVER);
    expect(assigns[0].length).toBeGreaterThan(0);
  });

  test("AIDLC_VERSION matches the latest CHANGELOG heading [.sh test 2]", () => {
    const tsVersion = versionAssignments()[0];
    const latestHeading = changelogHeadings()[0];
    expect(tsVersion).toBe(latestHeading);
  });

  // test 3: the version pin is the HEADING, not a link reference. Test 2
  // already binds version.ts == latest heading; here we assert that version is
  // present in the parsed heading set (the canonical pin), not as a raw
  // substring.
  test("the latest AIDLC_VERSION appears as a CHANGELOG heading [.sh test 3, superseded]", () => {
    const tsVersion = versionAssignments()[0];
    expect(changelogHeadings()).toContain(tsVersion);
  });

  // test 4: headings are UNIQUE - a rebase that duplicates a version block
  // (the t68 conflict-trap in AGENTS.md) must fail.
  test("## [N.N.N] headings are unique — no duplicate version block [.sh test 4, repurposed]", () => {
    const headings = changelogHeadings();
    expect(headings.length).toBeGreaterThan(0);
    const dupes = headings.filter((v, i) => headings.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  // CLI wiring - `bun aidlc-utility.ts version` prints
  // `aidlc <CL_VERSION>`. This is the ONE process-boundary (cli) assertion:
  // catches a renamed constant, broken import, switch-case typo, or missing
  // version.ts. Spawn the real tool through the bun runtime (env seam).
  test("wired CLI `version` subcommand prints 'aidlc <CHANGELOG version>' [.sh test 5]", () => {
    const clVersion = changelogHeadings()[0];
    const res = spawnSync(BUN, [UTILITY_TS, "version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect((res.stdout ?? "").trim()).toBe(`aidlc ${clVersion}`);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // README shields.io badge matches version.ts. A release that
  // bumps version.ts but forgets the badge ships a wrong public number
  // (the v0.5.0 release missed exactly this).
  test("README.md version badge matches aidlc-version.ts [.sh test 6]", () => {
    const tsVersion = versionAssignments()[0];
    const src = readFileSync(README, "utf-8");
    // Extract between `badge/version-` and `-blue`.
    const m = src.match(/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-blue/);
    expect(m).not.toBeNull();
    expect((m as RegExpMatchArray)[1]).toBe(tsVersion);
  });

  // Link-ref policy guard: version link references were broken `OWNER/REPO`
  // placeholders and would embed a repository host in a distributed file. This
  // guard fails if a `[N.N.N]:` link reference reappears OR if any repository
  // host URL leaks into the changelog.
  test("CHANGELOG carries no version link references and no repository host URL", () => {
    const src = readFileSync(CHANGELOG, "utf-8");
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

  // test 8 (#636): an entry newer than 2.11.0 says, right under its
  // heading, what the upgrade asks of each project, in one of three fixed
  // lines. Entries up to and including 2.11.0 stay as they shipped.
  test("every release entry newer than 2.11.0 carries its Compatibility line", () => {
    expect(compatibilityProblems(readFileSync(CHANGELOG, "utf-8"))).toEqual([]);
  });

  const changelog = (...entries: string[]) => `# Changelog\n\n${entries.join("\n")}`;
  const entry = (version: string, ...lines: string[]) =>
    `## [${version}] - 2026-10-20\n\n${lines.join("\n\n")}\n\n* \`aidlc version\` reports \`${version}\`.\n`;
  const summary = "AI-DLC rolls up the changes since the last release.";
  const breaking = "* Breaking for scripts: a retired flag now fails.";

  test("an entry newer than 2.11.0 with no Compatibility line, or a fourth value, fails", () => {
    expect(compatibilityProblems(changelog(entry("2.12.0", summary)))).toEqual([
      expect.stringContaining("2.12.0"),
    ]);
    expect(
      compatibilityProblems(changelog(entry("2.12.0", "Compatibility: config-compatible", summary))),
    ).toEqual([expect.stringContaining("2.12.0")]);
  });

  test("an entry with a `Breaking for scripts:` bullet must say breaking for scripts", () => {
    expect(
      compatibilityProblems(changelog(entry("2.12.0", "Compatibility: refresh only", summary, breaking))),
    ).toEqual([expect.stringContaining("Breaking for scripts")]);
    expect(
      compatibilityProblems(changelog(entry("2.12.0", "Compatibility: breaking for scripts", summary, breaking))),
    ).toEqual([]);
  });

  test("each of the three lines passes, and entries up to 2.11.0 need none", () => {
    for (const line of COMPATIBILITY_LINES) {
      expect(compatibilityProblems(changelog(entry("2.12.0", line, summary)))).toEqual([]);
    }
    expect(
      compatibilityProblems(changelog(entry("2.11.0", summary, breaking), entry("2.8.6", summary))),
    ).toEqual([]);
  });
});
