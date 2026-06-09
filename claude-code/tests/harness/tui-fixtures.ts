// tui-fixtures.ts — shared project seeding for TUI journey tests, the TypeScript
// mirror of bash setup_integration_project (tests/lib/fixtures.sh:150-198). The
// render-surface tests inline `cpSync(AIDLC_SRC) + writeFileSync(state)`; the
// JOURNEY tests additionally need the greenfield/brownfield/RE stubs that drive
// workspace-detection and reverse-engineering — those are fixture-DIRECTORY copies
// (fixtures.sh:168-173), too much to re-inline per file. This is the one helper.
//
// It is import-safe (no top-level side effects) and used ONLY by tui tests, which
// SPAWN tui-drive.ts as a subprocess — this module never loads node-pty, so it is
// safe to import under bun on every platform.
//
// Mirrors the bash flags faithfully:
//   withState        -> seed_state_file       (fixtures.sh:165)  aidlc-docs/aidlc-state.md
//   withAudit        -> seed_audit_file       (fixtures.sh:166)  aidlc-docs/audit.md
//   noAidlcDocs      -> --no-aidlc-docs        (fixtures.sh:167)  rm -rf aidlc-docs
//   greenfieldStub   -> --with-greenfield-stub (fixtures.sh:168)  cp greenfield-todo/.
//   brownfieldStub   -> --with-brownfield-stub (fixtures.sh:169)  cp brownfield-todo/.
//   reArtifacts      -> --with-re-artifacts     (fixtures.sh:170)  cp re-artifacts/*.md
//                                                                  -> inception/reverse-engineering/

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCustomHarness } from "./custom-harness.ts";

// tests/harness/ -> repo root -> dist/claude/.claude (the shipped distributable).
const HARNESS_DIR = import.meta.dir;
const REPO_ROOT = join(HARNESS_DIR, "..", "..");
export const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

export interface TuiProjectOptions {
  /** Seed aidlc-docs/aidlc-state.md from tests/fixtures/<withState> (a filename like
   *  "state-mid-ideation.md"). Omit for a fresh project. */
  withState?: string;
  /** Seed an empty-ish aidlc-docs/audit.md so the workflow appends to it. */
  withAudit?: boolean;
  /** Remove aidlc-docs/ entirely (the --no-aidlc-docs case: a brand-new workspace
   *  that the journey will scaffold itself). */
  noAidlcDocs?: boolean;
  /** Copy the greenfield-todo stub (a README.md) into the project root — drives
   *  workspace-detection to Greenfield. */
  greenfieldStub?: boolean;
  /** Copy the brownfield-todo stub (a full React/Vite/TS Todo app) into the
   *  project root — drives workspace-detection to Brownfield + reverse-engineering. */
  brownfieldStub?: boolean;
  /** Pre-seed the 4 reverse-engineering artifacts under
   *  aidlc-docs/inception/reverse-engineering/ (so a requirements-analysis journey
   *  has its upstream present). */
  reArtifacts?: boolean;
  /** Pre-seed the 3 REQUIRED ideation artifacts (intent-statement,
   *  scope-document, intent-backlog) at their canonical producing-stage paths
   *  under aidlc-docs/ideation/. A forward `--stage` jump into a late ideation
   *  stage (e.g. approval-handoff) scans the target's `consumes` and renders a
   *  Missing-inputs Continue/Cancel gate if a required upstream artifact is
   *  absent (SKILL.md:212-215). A mid-ideation state fixture marks stages [x]
   *  but ships no artifacts, so without this the jump gates. Seeding them makes
   *  the fixture self-consistent (state [x] ⇒ artifact exists) and the jump
   *  gateless — the genuine deterministic landing the journey tests. */
  ideationArtifacts?: boolean;
  /**
   * Seed the Harness-Engineer custom harness (custom scope + two chained stages
   * + sensor + project rule) into the copied .claude/ and recompile the stage
   * graph — the same seeding the sdk fixture does, so a {sdk,tui} two-driver
   * test drives byte-identical config on both paths. See
   * tests/harness/custom-harness.ts.
   */
  customHarness?: boolean;
}

/**
 * Create a temp project seeded for a TUI journey and return its absolute path.
 * The caller cpSyncs nothing else — this does the distributable copy + every
 * requested stub. Mirrors setup_integration_project. The caller is responsible
 * for cleanup (rmSync) in a finally block, exactly as the inline tests do.
 */
export function setupTuiProject(opts: TuiProjectOptions = {}): string {
  let proj = mkdtempSync(join(tmpdir(), "aidlc-tui-"));
  // Canonicalise so app-written paths (e.g. state Project Root) compare equal —
  // on macOS mkdtemp hands back /tmp|/var symlinks but the app records the
  // resolved /private/... realpath. Mirrors fixtures.ts createTestProject:70-82
  // (the t70 macOS symlink bug). Reading/writing/cleanup resolve transparently.
  try {
    proj = realpathSync(proj);
  } catch {
    /* keep the raw path */
  }

  // 1. Copy the distributable to <proj>/.claude (dest must NOT pre-exist or cp
  //    nests it — same caveat the inline render tests note).
  cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });

  // 2. State / audit / no-docs. The distributable copy may bring a default
  //    aidlc-docs/; honour the bash order (state/audit seed AFTER copy, and
  //    --no-aidlc-docs wipes it).
  if (opts.noAidlcDocs) {
    rmSync(join(proj, "aidlc-docs"), { recursive: true, force: true });
  } else {
    const docsDir = join(proj, "aidlc-docs");
    mkdirSync(docsDir, { recursive: true });
    if (opts.withState) {
      const fixturePath = join(FIXTURES_DIR, opts.withState);
      if (!existsSync(fixturePath)) {
        throw new Error(`setupTuiProject: state fixture not found: ${fixturePath}`);
      }
      writeFileSync(join(docsDir, "aidlc-state.md"), readFileSync(fixturePath, "utf8"));
    }
    if (opts.withAudit) {
      // seed_audit_file (fixtures.sh) writes a minimal audit.md the workflow
      // appends to; an empty file is sufficient for "exists and grows".
      const auditPath = join(docsDir, "audit.md");
      if (!existsSync(auditPath)) writeFileSync(auditPath, "# Audit Log\n");
    }
  }

  // 3. Stubs (fixture-directory copies). greenfield/brownfield land in the project
  //    ROOT; re-artifacts land under aidlc-docs/inception/reverse-engineering/.
  if (opts.greenfieldStub) {
    copyDirContents(join(FIXTURES_DIR, "greenfield-todo"), proj);
  }
  if (opts.brownfieldStub) {
    copyDirContents(join(FIXTURES_DIR, "brownfield-todo"), proj);
  }
  if (opts.reArtifacts) {
    const reDir = join(proj, "aidlc-docs", "inception", "reverse-engineering");
    mkdirSync(reDir, { recursive: true });
    const src = join(FIXTURES_DIR, "re-artifacts");
    for (const f of readdirSync(src)) {
      if (f.endsWith(".md")) {
        writeFileSync(join(reDir, f), readFileSync(join(src, f), "utf8"));
      }
    }
  }
  if (opts.ideationArtifacts) {
    // Seed the 3 REQUIRED ideation artifacts at the canonical paths their
    // producing stages write (intent-capture/intent-statement.md;
    // scope-definition/{scope-document,intent-backlog}.md — verified against the
    // stage frontmatter `outputs:` lines). This is what the forward-jump
    // missing-input scan checks (SKILL.md:212), so seeding them keeps the jump
    // gateless without touching the checkbox state the [S] marks derive from.
    const src = join(FIXTURES_DIR, "ideation-artifacts");
    const intentDir = join(proj, "aidlc-docs", "ideation", "intent-capture");
    const scopeDir = join(proj, "aidlc-docs", "ideation", "scope-definition");
    mkdirSync(intentDir, { recursive: true });
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(
      join(intentDir, "intent-statement.md"),
      readFileSync(join(src, "intent-statement.md"), "utf8"),
    );
    writeFileSync(
      join(scopeDir, "scope-document.md"),
      readFileSync(join(src, "scope-document.md"), "utf8"),
    );
    writeFileSync(
      join(scopeDir, "intent-backlog.md"),
      readFileSync(join(src, "intent-backlog.md"), "utf8"),
    );
  }

  // customHarness is seeded LAST so it edits + recompiles against the final
  // .claude/ — identical seeding to the sdk fixture (shared module) so a
  // {sdk,tui} two-driver test drives byte-identical custom harness.
  if (opts.customHarness) seedCustomHarness(proj);

  return proj;
}

// Mirror `cp -r "$SRC/." "$DEST/"` — copy the CONTENTS of src into dest (not src
// itself as a subdir). cpSync(src, dest) with dest existing merges contents, which
// is what we want for stubbing into a project that already has .claude/.
function copyDirContents(src: string, dest: string): void {
  if (!existsSync(src)) {
    throw new Error(`setupTuiProject: stub fixture dir not found: ${src}`);
  }
  for (const entry of readdirSync(src)) {
    cpSync(join(src, entry), join(dest, entry), { recursive: true });
  }
}

/** Cleanup helper — rmSync the temp project. Safe on a missing path.
 *
 *  Locatability escape hatch: when `AIDLC_KEEP_TEMP=1` is set, the project is
 *  PRESERVED and its path printed to stderr instead of being removed. A live tui
 *  journey that times out or fails otherwise leaves nothing to inspect (random
 *  mkdtemp name, cleaned in `finally`), so a debugging run sets this to keep the
 *  seeded .claude/, the written artefacts, the audit, and the sensor detail dir
 *  for post-mortem. Green CI never sets it, so normal runs still clean up. */
export function cleanupTuiProject(proj: string): void {
  if (process.env.AIDLC_KEEP_TEMP === "1") {
    if (proj) process.stderr.write(`[tui-fixtures] AIDLC_KEEP_TEMP=1 — preserved ${proj}\n`);
    return;
  }
  if (proj && existsSync(proj)) rmSync(proj, { recursive: true, force: true });
}
