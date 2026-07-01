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
import {
  DEFAULT_INTENT_UUID,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  FIXTURE_CLONE_ID,
  intentsDirOf,
  seededAuditShard,
  seededRecordDir,
} from "./fixtures.ts";

// tests/harness/ -> repo root -> dist/claude/.claude (the shipped distributable).
const HARNESS_DIR = import.meta.dir;
const REPO_ROOT = join(HARNESS_DIR, "..", "..");
export const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
export const KIRO_SRC = join(REPO_ROOT, "dist", "kiro", ".kiro");
// The Kiro IDE distributable ships the .kiro.hook files the IDE actually reads
// (the human-presence mint + block); dist/kiro/.kiro/hooks has none. Seed this tree
// for IDE-shaped tests.
export const KIRO_IDE_SRC = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");
// The per-harness memory shell (aidlc/spaces/default/memory) ships beside the
// engine tree; copy it so the resolver finds the rule layers, mirroring
// setupIntegrationProject's AIDLC_MEMORY_SRC copy.
const CLAUDE_MEMORY_SRC = join(REPO_ROOT, "dist", "claude", "aidlc");
const KIRO_MEMORY_SRC = join(REPO_ROOT, "dist", "kiro", "aidlc");
const KIRO_IDE_MEMORY_SRC = join(REPO_ROOT, "dist", "kiro-ide", "aidlc");

/** Seed the per-intent workspace shell into a TUI fixture project: the default
 *  intent record + cursors + registry + pinned clone-id (mirrors fixtures.ts
 *  seedWorkspaceShell). Idempotent; the dist copy already brings the memory tree. */
function seedTuiWorkspaceShell(proj: string, space = DEFAULT_SPACE): void {
  const intentsDir = intentsDirOf(proj, space);
  mkdirSync(seededRecordDir(proj, space), { recursive: true });
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${FIXTURE_CLONE_ID}\n`, "utf-8");
  writeFileSync(join(proj, "aidlc", "active-space"), `${space}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [{ uuid: DEFAULT_INTENT_UUID, slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

export interface TuiProjectOptions {
  /** Which harness distributable to seed. "claude" (default) copies
   *  dist/claude/.claude → <proj>/.claude; "kiro" copies dist/kiro/.kiro →
   *  <proj>/.kiro plus dist/kiro/AGENTS.md → <proj>/AGENTS.md (the shipped
   *  Kiro install shape — workspace default agent + steering ride along);
   *  "kiro-ide" copies dist/kiro-ide/.kiro → <proj>/.kiro plus
   *  dist/kiro-ide/AGENTS.md → <proj>/AGENTS.md (the IDE install shape, which
   *  carries the .kiro.hook files the IDE reads - the human-presence mint + block).
   *  Everything else (state, audit, stubs) is harness-neutral. */
  harness?: "claude" | "kiro" | "kiro-ide";
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
  /**
   * Seed a NON-default second space (a sibling dir under aidlc/spaces/) so the
   * statusline orientation prefix paints its `<space> ·` segment. The prefix
   * builder suppresses that segment until listSpaces().length > 1
   * (aidlc-statusline.ts orientationPrefix → listSpaces(projectDir).length > 1),
   * so a single-space fixture never paints the space token — the render-half
   * journey (P10 / Stage E) needs >1 space + an active intent for the FULL
   * `<space> · <intent> · <phase>` orientation to appear in a real TUI pane.
   *
   * The second space gets the same default-space memory shell shape (so it is a
   * real space the resolver/listSpaces honours, not a bare dir); the ACTIVE
   * space stays `default`, whose seeded record (seedTuiWorkspaceShell) carries
   * the active intent. So the prefix renders as `default · <slug> · <phase>`.
   * Defaults to "teamB" when set to `true`; pass a string to name it.
   */
  secondSpace?: boolean | string;
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

  // 1. Copy the distributable (dest must NOT pre-exist or cp nests it — same
  //    caveat the inline render tests note). Harness selects the dist tree.
  //    Also copy the sibling aidlc/ memory shell so the resolver finds the rule
  //    layers (the engine tree under .claude/.kiro does NOT include it).
  if (opts.harness === "kiro") {
    cpSync(KIRO_SRC, join(proj, ".kiro"), { recursive: true });
    cpSync(join(KIRO_SRC, "..", "AGENTS.md"), join(proj, "AGENTS.md"));
    if (existsSync(KIRO_MEMORY_SRC)) cpSync(KIRO_MEMORY_SRC, join(proj, "aidlc"), { recursive: true });
  } else if (opts.harness === "kiro-ide") {
    // The Kiro IDE install shape — same .kiro + AGENTS.md + aidlc/ as Kiro CLI,
    // but from dist/kiro-ide/ so the .kiro.hook files the IDE reads (mint + block)
    // ride along (dist/kiro/.kiro/hooks ships none).
    cpSync(KIRO_IDE_SRC, join(proj, ".kiro"), { recursive: true });
    cpSync(join(KIRO_IDE_SRC, "..", "AGENTS.md"), join(proj, "AGENTS.md"));
    if (existsSync(KIRO_IDE_MEMORY_SRC)) cpSync(KIRO_IDE_MEMORY_SRC, join(proj, "aidlc"), { recursive: true });
  } else {
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    if (existsSync(CLAUDE_MEMORY_SRC)) cpSync(CLAUDE_MEMORY_SRC, join(proj, "aidlc"), { recursive: true });
  }

  // 2. Seed the per-intent workspace shell (default record + cursors), then write
  //    state/audit into the record. noAidlcDocs is the no-workspace case: strip
  //    the record so no intent resolves (the resolver falls to the bare space root).
  seedTuiWorkspaceShell(proj);
  const record = seededRecordDir(proj);
  if (opts.noAidlcDocs) {
    rmSync(intentsDirOf(proj), { recursive: true, force: true });
  } else {
    if (opts.withState) {
      const fixturePath = join(FIXTURES_DIR, opts.withState);
      if (!existsSync(fixturePath)) {
        throw new Error(`setupTuiProject: state fixture not found: ${fixturePath}`);
      }
      writeFileSync(join(record, "aidlc-state.md"), readFileSync(fixturePath, "utf8"));
    }
    if (opts.withAudit) {
      // A minimal audit shard the workflow appends to; the readers glob the
      // record's audit/ dir, so one seeded shard reads back as the trail.
      const auditShard = seededAuditShard(proj);
      mkdirSync(join(record, "audit"), { recursive: true });
      if (!existsSync(auditShard)) writeFileSync(auditShard, "# Audit Log\n");
    }
  }

  // 3. Stubs (fixture-directory copies). greenfield/brownfield land in the project
  //    ROOT; re-artifacts + ideation artifacts land under the intent record.
  if (opts.greenfieldStub) {
    copyDirContents(join(FIXTURES_DIR, "greenfield-todo"), proj);
  }
  if (opts.brownfieldStub) {
    copyDirContents(join(FIXTURES_DIR, "brownfield-todo"), proj);
  }
  if (opts.reArtifacts) {
    const reDir = join(record, "inception", "reverse-engineering");
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
    // producing stages write under the intent record (intent-capture/
    // intent-statement.md; scope-definition/{scope-document,intent-backlog}.md).
    // This is what the forward-jump missing-input scan checks (SKILL.md:212), so
    // seeding them keeps the jump gateless without touching checkbox state.
    const src = join(FIXTURES_DIR, "ideation-artifacts");
    const intentDir = join(record, "ideation", "intent-capture");
    const scopeDir = join(record, "ideation", "scope-definition");
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

  // A non-default SECOND space so listSpaces().length > 1 and the statusline
  // orientation prefix paints its `<space> ·` segment (the render-half journey).
  // The active space stays `default` (whose record carries the active intent),
  // so the prefix reads `default · <slug> · <phase>`.
  if (opts.secondSpace) {
    const name = typeof opts.secondSpace === "string" ? opts.secondSpace : "teamB";
    seedSecondSpace(proj, name);
  }

  return proj;
}

/** Seed a NON-default space as an additive sibling of identical shape: copy the
 *  default space's memory shell into aidlc/spaces/<name>/ so listSpaces() reports
 *  it as a real space (>1 → the orientation prefix's space token paints). The
 *  active-space cursor is NOT touched — `default` stays active, so its seeded
 *  record remains the active intent the orientation prefix renders. */
function seedSecondSpace(proj: string, name: string): void {
  if (name === DEFAULT_SPACE) {
    throw new Error(`seedSecondSpace: a second space must be non-default, got "${name}"`);
  }
  const spacesRoot = join(proj, "aidlc", "spaces");
  const defaultMemory = join(spacesRoot, DEFAULT_SPACE, "memory");
  const targetMemory = join(spacesRoot, name, "memory");
  if (existsSync(defaultMemory)) {
    cpSync(defaultMemory, targetMemory, { recursive: true });
  } else {
    // Dist shell with no default memory tree — still make the dir a real space.
    mkdirSync(targetMemory, { recursive: true });
  }
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
