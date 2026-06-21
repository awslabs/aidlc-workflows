// covers: docs-gate:legacy-refs
//
// t174 — the P9 DOCS ALLOWLIST GATE. Mechanism: none (readFileSync over docs/,
// zero spawn, zero LLM, zero tokens). Technique: deterministic closed predicate.
//
// P9 retired the flat `aidlc-docs/` record layout and the `/aidlc --init` command:
// the docs now describe the per-intent workspace model + auto-birth. This gate
// makes that a CLOSED, reviewable predicate rather than a free-text "is this
// legitimately legacy?" judgement (which is trivially satisfiable by allowlisting
// everything). It scans every docs/**/*.md line PLUS the user-facing onboarding
// template `core/templates/onboarding.md` (the source-of-truth that renders to the
// shipped dist `CLAUDE.md` / `AGENTS.md` — the FIRST surface a user reads, and the
// blind spot that let stale flat-layout prose ship in an earlier pass) for a
// surviving `aidlc-docs` or `--init` occurrence and FAILS unless:
//   (a) the occurrence is pinned in tests/fixtures/docs-legacy-refs.json by exact
//       file + line text — so widening the allowlist needs a visible diff there; AND
//   (b) the pinned-set size stays <= the fixture's `ceiling` — so blanket-
//       allowlisting (dumping every remaining occurrence in) trips the cap.
//
// Convergence is `occurrences == pinned set`, NOT grep-clean-to-zero: the migration
// legitimately keys on the legacy layout and the shipped sensor `matches` glob
// `**/{aidlc-docs,intents}/**` carries the `aidlc-docs` substring.
//
// `--init` token: every aidlc-command `--init` reference is retired; `git init`/
// `npm init` are NOT the aidlc command, so the scanner only flags a bare `--init`
// token (a hyphen-led flag), never an `<word> init` shell command.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const DOCS_DIR = join(REPO_ROOT, "docs");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "docs-legacy-refs.json");
// Authored-prose surfaces OUTSIDE docs/, derived FROM DISK so a new harness's
// SKILL.md or a new onboarding template is auto-covered without a test edit. Two
// roots beyond docs/: every `core/templates/*.md` (these render to the shipped
// CLAUDE.md / AGENTS.md — the FIRST surface a user reads), and each harness's
// orchestrator `SKILL.md` (the conductor prose the harness loads at runtime — the
// blind spot that let stale rules-dir prose ship in an earlier pass).
//   EXCLUDED by design: dist/** (generated — `package.ts --check` proves byte
//   parity, so gating the authored source suffices for all 4 dist trees) and
//   core/aidlc-common/** (the engine-parsed stage/protocol method tree — its
//   `aidlc-docs/` reroot is a separate deferred sweep; scanning it here would red
//   on pre-existing debt this gate does not own).
function listExtraAuthoredDocs(): string[] {
  const out: string[] = [];
  // core/templates/*.md (non-recursive — templates live flat)
  for (const name of readdirSync(join(REPO_ROOT, "core", "templates"))) {
    if (name.endsWith(".md")) out.push(`core/templates/${name}`);
  }
  // each harness's orchestrator SKILL.md: harness/<h>/skills/aidlc/SKILL.md
  for (const h of readdirSync(join(REPO_ROOT, "harness"))) {
    const rel = `harness/${h}/skills/aidlc/SKILL.md`;
    try {
      statSync(join(REPO_ROOT, rel));
      out.push(rel);
    } catch {
      // harness without an orchestrator SKILL.md — skip
    }
  }
  return out;
}
const EXTRA_DOC_FILES = listExtraAuthoredDocs();

interface AllowEntry {
  file: string;
  text: string;
  why: string;
}
interface AllowFixture {
  ceiling: number;
  allowed: AllowEntry[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8")) as AllowFixture;

/** Recursively list every .md file under docs/, repo-root-relative (posix). */
function listDocs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...listDocs(abs));
    } else if (name.endsWith(".md")) {
      out.push(abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"));
    }
  }
  return out;
}

/** A surviving legacy-ref occurrence: a docs line carrying `aidlc-docs` OR a bare
 *  `--init` flag token (the retired aidlc command — NOT `git init`/`npm init`). */
interface Occurrence {
  file: string;
  line: number;
  text: string;
}

function scanOccurrences(): Occurrence[] {
  const out: Occurrence[] = [];
  for (const rel of [...listDocs(DOCS_DIR), ...EXTRA_DOC_FILES]) {
    const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hasAidlcDocs = line.includes("aidlc-docs");
      // A bare `--init` flag token: `--init` not preceded by another flag char.
      const hasInit = /(^|[^-\w])--init\b/.test(line);
      // Retired rules-DIR tokens (the dotted per-harness rules dirs). The method
      // tree relocated to `aidlc/spaces/<space>/memory/` (graph.ts MEMORY_SEGMENTS);
      // the dotted dirs survive ONLY in native-include prose (the `.claude/rules/
      // aidlc.md` @-import stub mentions, the Kiro `.kiro/steering/` resources glob,
      // the packager rename narrative) — those are pinned in the fixture.
      const hasRulesDir =
        line.includes(".claude/rules/") ||
        line.includes(".kiro/steering/") ||
        line.includes(".codex/aidlc-rules/");
      // Retired dated learnings-LOG filenames. A confirmed learning is now a
      // practice in `memory/{team,project}.md` (aidlc-learnings.ts); there is no
      // `*-learnings.md` surface. Filename-anchored so the live tool
      // `aidlc-learnings.ts` and the phrase "learnings ritual" never match.
      const hasLearningsLog = /[a-z]+-learnings\.md/.test(line);
      if (hasAidlcDocs || hasInit || hasRulesDir || hasLearningsLog) {
        out.push({ file: rel, line: i + 1, text: line.trim() });
      }
    }
  }
  return out;
}

describe("t174 docs legacy-ref allowlist gate (P9 — closed predicate)", () => {
  const occurrences = scanOccurrences();
  const allowedByFile = new Map<string, Set<string>>();
  for (const e of fixture.allowed) {
    if (!allowedByFile.has(e.file)) allowedByFile.set(e.file, new Set());
    allowedByFile.get(e.file)?.add(e.text.trim());
  }

  test("every surviving aidlc-docs/--init/rules-dir/learnings-log docs occurrence is pinned in the allowlist", () => {
    const unpinned = occurrences.filter(
      (o) => !(allowedByFile.get(o.file)?.has(o.text) ?? false),
    );
    // Surface the exact offenders so a fix is a one-line diff (rewrite the prose
    // to the workspace model, or — if genuinely legacy — pin it in the fixture).
    expect(
      unpinned.map((o) => `${o.file}:${o.line}  ${o.text}`),
    ).toEqual([]);
  });

  test("pinned-set size stays <= the known-legacy ceiling (no blanket allowlisting)", () => {
    expect(fixture.allowed.length).toBeLessThanOrEqual(fixture.ceiling);
  });

  test("every pinned entry still matches a live docs line (no stale allowlist rot)", () => {
    // A pinned entry whose (file, text) no longer appears in docs is dead weight —
    // it must be pruned so the allowlist reflects the real surviving set.
    const liveByFile = new Map<string, Set<string>>();
    for (const o of occurrences) {
      if (!liveByFile.has(o.file)) liveByFile.set(o.file, new Set());
      liveByFile.get(o.file)?.add(o.text);
    }
    const stale = fixture.allowed.filter(
      (e) => !(liveByFile.get(e.file)?.has(e.text.trim()) ?? false),
    );
    expect(stale.map((e) => `${e.file}  ${e.text}`)).toEqual([]);
  });
});
