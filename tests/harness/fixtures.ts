// fixtures.ts — TS port of tests/lib/fixtures.sh's project-scaffolding.
//
// Ports the project-creation / teardown helpers so the SDK harness can build
// and tear down temp AIDLC projects from TypeScript, the same way the shell
// suite did from bash. The bytes of the scaffolding match fixtures.sh:
//   - create_test_project   -> createTestProject()  (now seeds the per-intent
//                                                     workspace shell, not flat
//                                                     aidlc-docs/)
//   - seed_state_file        -> seedStateFile()
//   - seed_audit_file        -> seedAuditFile()
//   - reset_aidlc_env        -> resetAidlcEnv()
//   - cleanup_test_project   -> cleanupTestProject()
//   - setup_integration_project -> setupIntegrationProject()
//   - sed_i                  -> sedReplaceInFile() (portable in-place edit)
//
// DELIBERATELY NOT PORTED: run_claude. The SDK driver (sdk-drive.ts
// driveAidlc) replaces it entirely — there is no `claude -p` subprocess, no
// exit-124 timeout heuristic, no CLAUDE_OUTPUT/CLAUDE_RC globals.
//
// Path layout (mirrors fixtures.sh:5-8, resolved from tests/harness/):
//   REPO_ROOT    = tests/harness/../..            (the worktree root)
//   AIDLC_SRC    = <REPO_ROOT>/dist/claude/.claude
//   FIXTURES_DIR = <REPO_ROOT>/tests/fixtures

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedCustomHarness } from "./custom-harness.ts";
import type { ShippedHarnessName } from "./harness-matrix.ts";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(import.meta.url);
export const REPO_ROOT = join(HARNESS_DIR, "..", "..");
export const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");

// The per-intent WORKSPACE layout the fixtures seed (P9 — the flat aidlc-docs/
// layout is retired). A fixture project gets a SEED-style shell (aidlc/active-space
// + spaces/default/) plus ONE default intent record so the path helpers resolve
// the record dir rather than the bare space root. The slug is fixed + SLUG_RE-valid
// and the id8 is all-hex so it matches the `<slug>-<id8>` record-dir shape. Tests
// resolve the seeded paths via seededRecordDir()/seededStateFile() below (or
// import recordDirFor from sdk-drive.ts) instead of hardcoding aidlc-docs/.
export const DEFAULT_SPACE = "default";
// The seeded default intent's uuid (canonical UUIDv7 shape). The record dir name
// is `<slug>-<id8>` where id8 = idSuffix(uuid) = the trailing 16 hex chars (dashes
// stripped) — the SAME derivation the runtime uses to join an intents.json row to
// its dir (aidlc-lib.ts idSuffix/listIntents). Deriving DEFAULT_RECORD_DIR from
// the uuid keeps the row and the dir consistent BY CONSTRUCTION, so the seeded
// fixture models a layout the runtime can actually produce (a hand-kept suffix had
// drifted: uuid …8000-000000000001 → idSuffix `8000000000000001`, not the literal
// `0000000000000001` the dir used, so listIntents()/updateIntentStatus() never
// matched the row to its dir).
export const DEFAULT_INTENT_UUID = "00000000-0000-7000-8000-000000000001";
const DEFAULT_RECORD_ID8 = DEFAULT_INTENT_UUID.replace(/-/g, "").slice(-16);
export const DEFAULT_RECORD_DIR = `fixture-${DEFAULT_RECORD_ID8}`;
// A FIXED per-clone audit-shard token seeded into every fixture project's
// gitignored aidlc/.aidlc-clone-id. Pinning it makes the audit shard a spawned
// tool resolves (auditShardName = `<host>-<clone>.md`) DETERMINISTIC, so a test
// that pre-seeds a shard header or reads back a specific shard agrees with the
// subprocess. On a real project the token is minted + gitignored per clone; a
// fixture wants it stable across the test process and the tools it spawns.
export const FIXTURE_CLONE_ID = "fixturecloneid01";
// The relocated method ("memory") ships at the dist tree ROOT (beside .claude/),
// at aidlc/spaces/default/memory/. A fixture project must copy this alongside
// .claude/ so the resolver's default (join(<harness>/tools, "..", "..",
// aidlc/spaces/default/memory)) finds the rule layers. (NOTE: P5 copies the
// shipped method tree as-is; P9 owns the full per-intent fixture re-root.)
export const AIDLC_MEMORY_SRC = join(REPO_ROOT, "dist", "claude", "aidlc");
export const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

const RETRYABLE_RM_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

function resetSelectionSensitiveCaches(): void {
  // fixtures.ts is imported by sandbox tests that copy no core/ tree, so core/
  // cannot be a module-load-time dependency.
  const graph = requireHere(
    "../../core/tools/aidlc-graph.ts",
  ) as typeof import("../../core/tools/aidlc-graph.ts");
  const lib = requireHere(
    "../../core/tools/aidlc-lib.ts",
  ) as typeof import("../../core/tools/aidlc-lib.ts");

  graph.__resetGraphCache();
  lib._resetStageGraphForTests();
  lib._resetScopeMappingForTests();
  lib._resetAgentsForTests();
  lib._resetHarnessDataForTests();
}

export function withEnvAndFreshCaches<T>(
  env: Record<string, string | undefined>,
  fn: () => T,
): T {
  const prior = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) prior.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSelectionSensitiveCaches();
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSelectionSensitiveCaches();
  }
}

/**
 * Unset AIDLC-related env vars that a developer's shell (or a prior test) may
 * have leaked, so fixture-defined defaults aren't shadowed. Mirrors
 * reset_aidlc_env (fixtures.sh:16-18).
 */
export function resetAidlcEnv(): void {
  delete process.env.AWS_AIDLC_DEFAULT_SCOPE;
}

/**
 * Create a bare temp project dir seeded with the per-intent workspace shell
 * (aidlc/active-space + spaces/default/ + one default intent record). Mirrors
 * create_test_project (fixtures.sh:20-33). On Windows (Git Bash / MSYS) the
 * raw mktemp path is a POSIX path native Bun cannot resolve; cygpath -m
 * rewrites it to an absolute Windows path with forward slashes that both Git
 * Bash and native Bun understand and that round-trips through JSON. We
 * replicate that cygpath step here for parity.
 *
 * Canonicalise the path (realpathSync) before returning — on macOS mkdtemp
 * hands back /tmp/... or /var/folders/... but those are symlinks to
 * /private/tmp/... and /private/var/folders/..., and the app records the
 * resolved path (the realpath) in fields like state's Project Root. Returning
 * the canonical form here means a caller comparing app-written paths to this
 * value compares equal. Reading/writing/cleanup are unaffected (the symlink
 * resolves transparently either way). Mirrors setupWorktreeFixture's realpath
 * step below.
 */
export function createTestProject(): string {
  const base = process.env.TMPDIR || tmpdir();
  let proj = mkdtempSync(join(base, "aidlc-test-"));
  // Canonicalise so app-written paths (e.g. state Project Root) compare equal
  // (macOS /tmp -> /private/tmp, /var -> /private/var).
  try {
    proj = realpathSync(proj);
  } catch {
    /* keep the raw path */
  }
  seedWorkspaceShell(proj);
  proj = toPortablePath(proj);
  return proj;
}

/**
 * The absolute intents dir for a space: `<proj>/aidlc/spaces/<space>/intents`.
 */
export function intentsDirOf(proj: string, space = DEFAULT_SPACE): string {
  return join(proj, "aidlc", "spaces", space, "intents");
}

/**
 * The default intent's RECORD directory a fixture seeds:
 * `<proj>/aidlc/spaces/default/intents/<DEFAULT_RECORD_DIR>`. The data-path
 * helpers (seededStateFile/seededAuditDir) resolve under this; the chokepoint
 * seeders write here. Mirrors the per-intent layout the engine writes. (Named
 * seededRecordDir to avoid colliding with sdk-drive.ts recordDirFor and the many
 * test-local recordDirOf helpers that resolve from live cursors instead.)
 */
export function seededRecordDir(proj: string, space = DEFAULT_SPACE): string {
  return join(intentsDirOf(proj, space), DEFAULT_RECORD_DIR);
}

/** The seeded state file path: `<record>/aidlc-state.md`. */
export function seededStateFile(proj: string, space = DEFAULT_SPACE): string {
  return join(seededRecordDir(proj, space), "aidlc-state.md");
}

/** The seeded audit SHARD DIR path: `<record>/audit`. */
export function seededAuditDir(proj: string, space = DEFAULT_SPACE): string {
  return join(seededRecordDir(proj, space), "audit");
}

/**
 * The DETERMINISTIC audit shard path a spawned tool resolves in a fixture
 * project: `<record>/audit/<host-slug>-<FIXTURE_CLONE_ID>.md`. Mirrors
 * auditShardName() in aidlc-lib.ts (hostname slugified + the pinned clone token).
 * A test that pre-seeds an audit header or reads a single shard should target
 * THIS path so it agrees with the tool's own resolution.
 */
export function seededAuditShard(proj: string, space = DEFAULT_SPACE): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return join(seededAuditDir(proj, space), `${host}-${FIXTURE_CLONE_ID}.md`);
}

/**
 * Seed a SEED-style workspace shell plus ONE default intent record + cursors +
 * registry, so the path helpers resolve the per-intent record. This is the
 * per-intent analog of the old `mkdir aidlc-docs/`. The record dir holds no
 * aidlc-state.md until a seeder writes one (a bare createTestProject leaves an
 * empty record, matching the old empty aidlc-docs/).
 */
function seedWorkspaceShell(proj: string, space = DEFAULT_SPACE): void {
  const intentsDir = intentsDirOf(proj, space);
  mkdirSync(join(proj, "aidlc", "spaces", space, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(proj, space), { recursive: true });
  // Pin the per-clone audit-shard token so a spawned tool's shard is
  // deterministic (see FIXTURE_CLONE_ID / seededAuditShard).
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${FIXTURE_CLONE_ID}\n`, "utf-8");
  // The cursors (per-user, gitignored on a real project) + the canonical registry.
  writeFileSync(join(proj, "aidlc", "active-space"), `${space}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [
        {
          uuid: DEFAULT_INTENT_UUID,
          slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
          status: "in-flight",
        },
      ],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

/**
 * Remove the seeded workspace record + cursor so the no-workspace (no active
 * intent) path is tested. Leaves the shell (active-space + spaces/default/) so a
 * resolver still finds the space; the record dir + cursor + registry go. Mirrors
 * the old `rm -rf aidlc-docs/` no-layout option.
 */
export function removeWorkspaceRecord(proj: string, space = DEFAULT_SPACE): void {
  const intentsDir = intentsDirOf(proj, space);
  rmSync(intentsDir, { recursive: true, force: true });
}

/**
 * On Windows, rewrite a POSIX-ish temp path to a mixed-mode Windows path via
 * `cygpath -m`. No-op on platforms without cygpath. Mirrors the
 * `command -v cygpath` guard in create_test_project.
 */
export function toPortablePath(p: string): string {
  if (process.platform !== "win32") return p;
  try {
    return execFileSync("cygpath", ["-m", p], { encoding: "utf8" }).trim() || p;
  } catch {
    return p;
  }
}

/**
 * Copy a state fixture into the default intent's record:
 * <proj>/aidlc/spaces/default/intents/<record>/aidlc-state.md. `fixturePath` may
 * be an absolute path or a bare fixture filename resolved against FIXTURES_DIR.
 */
export function seedStateFile(proj: string, fixturePath: string): void {
  const recDir = seededRecordDir(proj);
  mkdirSync(recDir, { recursive: true });
  const src = existsSync(fixturePath) ? fixturePath : join(FIXTURES_DIR, fixturePath);
  copyFileSync(src, join(recDir, "aidlc-state.md"));
}

/**
 * Copy the audit sample into the default intent's DETERMINISTIC per-clone shard
 * (<record>/audit/<host>-<FIXTURE_CLONE_ID>.md) — the SAME shard a spawned tool
 * resolves (the fixture pins the clone-id). Seeding the tool's own shard means
 * the seeded trail and the tool's appends share one file: readers glob audit/*.md
 * and merge by timestamp, and a test that sabotages the shard blocks the tool.
 */
export function seedAuditFile(proj: string): void {
  const shard = seededAuditShard(proj);
  mkdirSync(dirname(shard), { recursive: true });
  copyFileSync(join(FIXTURES_DIR, "audit-sample.md"), shard);
}

/**
 * Recursively remove a temp project dir. Mirrors cleanup_test_project
 * (fixtures.sh:58-61) — guards against empty/non-existent paths.
 */
export function cleanupTestProject(proj: string | undefined): void {
  if (proj && existsSync(proj)) removeTreeWithRetry(proj);
}

/**
 * Portable in-place text replace. The shell version (sed_i, fixtures.sh:38-43)
 * shells out to sed via a tempfile to dodge BSD/GNU `-i` differences; in TS we
 * just read/replace/write. `pattern` may be a string (replaced once) or a
 * RegExp (use the `g` flag for replace-all). Provided for parity with the
 * `--strip-env-scope` path below.
 */
export function sedReplaceInFile(
  file: string,
  pattern: string | RegExp,
  replacement: string,
): void {
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(pattern, replacement));
}

// ============================================================================
// Worktree fixtures — TS port of tests/lib/worktree-helpers.sh.
//
// aidlc-worktree.ts runs REAL `git worktree add/remove/list` and asserts it is
// invoked from the main checkout (assertNotSiblingWorktree, aidlc-worktree.ts
// :101). So a worktree-tier test needs an actual git repo on `main` with one
// commit, plus the per-intent workspace shell for the audit emit. These helpers
// build and tear that down, mirroring setup_worktree_fixture /
// cleanup_worktree_fixture.
// ============================================================================

/** Basename prefix every worktree fixture lives under; cleanup refuses any
 *  path whose basename doesn't start with it (defence-in-depth, mirrors
 *  WORKTREE_FIXTURE_PREFIX_NAME in worktree-helpers.sh:15). */
export const WORKTREE_FIXTURE_PREFIX = "aidlc-worktree-";

/**
 * Create a fresh git repo in a tempdir with one commit on `main`, plus the
 * per-intent workspace shell. Returns the canonical (realpath) project path — git
 * worktree list --porcelain emits canonical paths, so callers comparing to
 * this path need the canonical form too (macOS /var -> /private/var). Mirrors
 * setup_worktree_fixture (worktree-helpers.sh:21-52): init + symbolic-ref main
 * (not `git init -b`, which needs git >= 2.28) + seed commit. Throws on any
 * git failure rather than returning a bad path.
 */
export function setupWorktreeFixture(): string {
  const base = process.env.TMPDIR || tmpdir();
  let proj = mkdtempSync(join(base, WORKTREE_FIXTURE_PREFIX));
  // Canonicalise so `git worktree list --porcelain` paths compare equal.
  try {
    proj = realpathSync(proj);
  } catch {
    /* keep the raw path */
  }
  proj = toPortablePath(proj);
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf8" });
    if (r.status !== 0) {
      rmSync(proj, { recursive: true, force: true });
      throw new Error(
        `git ${args.join(" ")} failed: ${r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status}`}`,
      );
    }
  };
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(proj, "README.md"), "seed\n");
  git(["add", "README.md"]);
  git(["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "init"]);
  // Seed the per-intent workspace shell + default record so the data-path
  // helpers (and the worktree-mirror resolution that threads relativeRecordDir)
  // anchor under aidlc/spaces/default/intents/<record>/ instead of a flat
  // aidlc-docs/ tree.
  seedWorkspaceShell(proj);
  return proj;
}

/**
 * Remove a worktree fixture: detach + remove every child worktree (errors
 * swallowed so a partially-set-up fixture still cleans), then rm -rf the
 * parent. Refuses any path whose basename doesn't start with the fixture
 * prefix. Mirrors cleanup_worktree_fixture (worktree-helpers.sh:80-111).
 */
export function cleanupWorktreeFixture(proj: string | undefined): void {
  if (!proj?.trim()) return;
  if (!basename(proj).startsWith(WORKTREE_FIXTURE_PREFIX)) return;
  if (!existsSync(proj)) return;
  // Prune any registered child worktrees first so rm -rf doesn't orphan git
  // metadata. `git worktree list --porcelain` lists the main checkout first.
  const list = spawnSync("git", ["-C", proj, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  if (list.status === 0) {
    let mainSeen = false;
    for (const line of (list.stdout || "").split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const wt = line.slice("worktree ".length);
      if (!mainSeen) {
        mainSeen = true;
        continue;
      }
      spawnSync("git", ["-C", proj, "worktree", "remove", "--force", wt], {
        encoding: "utf8",
      });
    }
  }
  removeTreeWithRetry(proj);
}

function removeTreeWithRetry(path: string): void {
  const attempts = process.platform === "win32" ? 10 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableRmError(err) || i === attempts - 1) break;
      sleepSync(50 * (i + 1));
    }
  }
  throw lastErr;
}

function isRetryableRmError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_RM_CODES.has(code);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Options for setupIntegrationProject — the flags from setup_integration_project. */
export interface IntegrationProjectOptions {
  /** Seed aidlc-state.md from this fixture (path or FIXTURES_DIR-relative name). */
  withState?: string;
  /** Seed audit.md from audit-sample.md. */
  withAudit?: boolean;
  /** Remove the scaffolded intent record + cursor (test the no-workspace path). */
  noAidlcDocs?: boolean;
  /** Strip AWS_AIDLC_DEFAULT_SCOPE from the copied settings.json so shell env wins. */
  stripEnvScope?: boolean;
  /** Drop in the greenfield-todo stub project. */
  withGreenfieldStub?: boolean;
  /** Drop in the brownfield-todo stub project. */
  withBrownfieldStub?: boolean;
  /** Copy reverse-engineering artifacts into inception/reverse-engineering/. */
  withReArtifacts?: boolean;
  /** Copy the requirements/design/units inception artifact set. */
  withInceptionArtifacts?: boolean;
  /** Copy the construction functional-design artifact. */
  withConstructionArtifacts?: boolean;
  /**
   * Seed the Harness-Engineer custom harness (custom scope + two chained stages
   * + sensor + project rule) into the copied .claude/ and recompile the stage
   * graph. The Phase-5 two-driver prerequisite — see
   * tests/harness/custom-harness.ts.
   */
  customHarness?: boolean;
}

/**
 * Scaffold a full integration project: a temp dir with the shipped
 * dist/claude/.claude/ copied into <proj>/.claude, plus any requested
 * fixtures. Mirrors setup_integration_project (fixtures.sh:133-181).
 *
 * Hooks/tools are .ts run via bun and need no executable bit (the shell
 * version's chmod +x on *.sh is a no-op now that hooks are TypeScript — see
 * the shipped CLAUDE.md "All 9 hooks are TypeScript ... No executable bits
 * required"), so this port skips the chmod.
 *
 * Returns the (portable) project path.
 */
export function setupIntegrationProject(
  opts: IntegrationProjectOptions = {},
): string {
  const proj = createTestProject();
  cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
  // Copy the relocated method tree (aidlc/spaces/default/memory/) to the project
  // root beside .claude/ — the resolver reads the rule layers from there now
  // (P5 relocation). Absent in a tree built before P5, so guard it.
  if (existsSync(AIDLC_MEMORY_SRC)) {
    cpSync(AIDLC_MEMORY_SRC, join(proj, "aidlc"), { recursive: true });
  }

  if (opts.withState) seedStateFile(proj, opts.withState);
  if (opts.withAudit) seedAuditFile(proj);

  if (opts.noAidlcDocs) {
    removeWorkspaceRecord(proj);
  }

  if (opts.stripEnvScope) {
    const settings = join(proj, ".claude", "settings.json");
    if (existsSync(settings)) {
      // Drop the line carrying "AWS_AIDLC_DEFAULT_SCOPE": ... — mirrors the
      // sed_i '/"AWS_AIDLC_DEFAULT_SCOPE":/d' delete in --strip-env-scope.
      const kept = readFileSync(settings, "utf8")
        .split("\n")
        .filter((l) => !l.includes('"AWS_AIDLC_DEFAULT_SCOPE":'))
        .join("\n");
      writeFileSync(settings, kept);
    }
  }

  if (opts.withGreenfieldStub) {
    cpSync(join(FIXTURES_DIR, "greenfield-todo"), proj, { recursive: true });
  }
  if (opts.withBrownfieldStub) {
    cpSync(join(FIXTURES_DIR, "brownfield-todo"), proj, { recursive: true });
  }

  if (opts.withReArtifacts) {
    const dest = join(seededRecordDir(proj), "inception", "reverse-engineering");
    mkdirSync(dest, { recursive: true });
    cpSync(join(FIXTURES_DIR, "re-artifacts"), dest, { recursive: true });
  }

  if (opts.withInceptionArtifacts) {
    const ra = join(seededRecordDir(proj), "inception", "requirements-analysis");
    const ad = join(seededRecordDir(proj), "inception", "application-design");
    const ug = join(seededRecordDir(proj), "inception", "units-generation");
    mkdirSync(ra, { recursive: true });
    mkdirSync(ad, { recursive: true });
    mkdirSync(ug, { recursive: true });
    const ia = join(FIXTURES_DIR, "inception-artifacts");
    copyFileSync(join(ia, "requirements.md"), join(ra, "requirements.md"));
    for (const f of [
      "components.md",
      "component-methods.md",
      "services.md",
      "component-dependency.md",
    ]) {
      copyFileSync(join(ia, f), join(ad, f));
    }
    for (const f of ["unit-of-work.md", "unit-of-work-story-map.md"]) {
      copyFileSync(join(ia, f), join(ug, f));
    }
  }

  if (opts.withConstructionArtifacts) {
    const dest = join(
      seededRecordDir(proj),
      "construction",
      "todo-core",
      "functional-design",
    );
    mkdirSync(dest, { recursive: true });
    copyFileSync(
      join(FIXTURES_DIR, "construction-artifacts", "functional-design.md"),
      join(dest, "functional-design.md"),
    );
  }

  // customHarness is seeded LAST so it edits + recompiles against the final
  // .claude/ (after every other stub has landed). Mutates scope metadata,
  // stage-graph.json, the stages tree, sensors/, and rules/, then recompiles.
  if (opts.customHarness) seedCustomHarness(proj);

  return proj;
}

// ============================================================================
// Workspace-journey fixture (P10 / Stage E) — the net-new harness piece.
//
// The live multi-repo·intent·space journey needs a workspace whose shape the
// per-intent fixtures above never model: TWO sibling code repos under one
// workspace root, the shipped harness shell, and NO pre-born intent (the
// journey's step 1 auto-births it live). setupWorkspaceJourney() builds that.
//
// Why a fresh tmpdir root (not createTestProject's reuse): the journey's
// construction beat forks git worktrees INSIDE the sibling repos, and
// assertNotSiblingWorktree (aidlc-worktree.ts:112) is a STRUCTURAL git check
// (`git rev-parse --show-toplevel` vs `dirname(--git-common-dir)`) keyed on the
// target repo's cwd. Scaffolding under .claude/worktrees/ would leave the
// spawned tool inside this very worktree's git tree; an os.tmpdir() root with
// its own git-init'd sibling repos makes toplevel == dirname(common-dir) hold
// for each repo, so the guard passes (the same posture setupCodexProject takes).
//
// Harness-parameterized so every shipped distribution can reuse ONE fixture:
// the matrix resolves any discovered harness's dist root, so live drivers and
// deterministic fixture tests alike pick their row without touching this file.
// ============================================================================

export type JourneyHarness = ShippedHarnessName;

export interface WorkspaceJourney {
  /** The tmp workspace root (canonical realpath) — the project dir every driver
   *  points the engine at (--project-dir / spawn cwd). The aidlc/ roof + the
   *  harness engine dir live directly under here; the sibling repos are children. */
  root: string;
  /** Sibling repo dirs (immediate children of root), git-init'd with one commit
   *  so discoverSiblingRepos(root) returns ["repo-a","repo-b"]. */
  repoA: string;
  repoB: string;
  /** An isolated $HOME the codex harness needs for its CODEX_HOME/config.toml.
   *  Allocated for every harness so callers can rely on it; only codex uses it. */
  home: string;
  /** The harness this shell was seeded for. */
  harness: JourneyHarness;
}

function gitInit(dir: string, seedFile: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, seedFile), "seed\n", "utf-8");
  for (const args of [
    ["init", "-q"],
    ["symbolic-ref", "HEAD", "refs/heads/main"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  ]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} in ${dir} failed: ${r.stderr?.trim() || r.stdout?.trim()}`);
    }
  }
}

/**
 * Scaffold a multi-repo workspace journey root and return its paths. Copies the
 * shipped dist/<harness>/ shell (engine dir + the sibling aidlc/ memory shell)
 * into a fresh os.tmpdir() root, then git-init's two sibling repos (repo-a,
 * repo-b) as immediate children so discoverSiblingRepos finds them sorted. Does
 * NOT auto-birth an intent — the journey's step 1 does that live; the shell ships
 * the default space's memory only.
 *
 * Each repo gets a tiny brownfield-ish source file + an initial commit so a
 * reverse-engineering stage has something to scan and write per-repo codekb for
 * (the journey's step-2 cheaper variant), and so the construction-worktree guard
 * sees a real checkout.
 */
export function setupWorkspaceJourney(harness: JourneyHarness = "claude"): WorkspaceJourney {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-journey-")));
  const home = join(root, ".home");
  mkdirSync(home, { recursive: true });

  // 1. Copy the complete shipped distribution root. The matrix resolves the
  //    manifest-backed dist row; copying its entries keeps this fixture agnostic
  //    to engine-dir, root-file, and emitted-skill layout differences.
  //    Loaded lazily, NOT at module scope: harness-matrix.ts walks harness/ and
  //    dist/ at import time, and fixtures.ts is imported by sandbox tests (t52's
  //    t48 sandbox) whose trees ship neither - a top-level import throws ENOENT
  //    there. Same posture as resetSelectionSensitiveCaches above.
  const { harnessByName } = requireHere(
    "./harness-matrix.ts",
  ) as typeof import("./harness-matrix.ts");
  const distRoot = harnessByName(harness).distRoot;
  for (const entry of readdirSync(distRoot)) {
    cpSync(join(distRoot, entry), join(root, entry), { recursive: true });
  }

  // Pin the per-clone audit-shard token (gitignored on a real project) so any
  // shard a spawned tool writes is deterministic — same posture as the per-intent
  // fixtures (FIXTURE_CLONE_ID / seededAuditShard).
  writeFileSync(join(root, "aidlc", ".aidlc-clone-id"), `${FIXTURE_CLONE_ID}\n`, "utf-8");

  // 2. Two git-init'd sibling repos as immediate children of the root, each with a
  //    tiny source file so a reverse-engineering scan has real content and the
  //    construction guard sees a checkout. discoverSiblingRepos sorts + dedups, so
  //    the names come back ["repo-a","repo-b"] regardless of creation order.
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  gitInit(repoA, "main.py");
  gitInit(repoB, "main.py");

  return { root, repoA, repoB, home, harness };
}

/** Remove a workspace-journey root. Mirrors the codex test's rmSync(root) and
 *  cleanupTuiProject's AIDLC_KEEP_TEMP escape hatch (a timed-out live journey
 *  otherwise leaves nothing under a random mkdtemp name to inspect). */
export function cleanupWorkspaceJourney(journey: WorkspaceJourney | undefined): void {
  if (!journey?.root) return;
  if (process.env.AIDLC_KEEP_TEMP === "1") {
    process.stderr.write(`[fixtures] AIDLC_KEEP_TEMP=1 — preserved ${journey.root}\n`);
    return;
  }
  if (existsSync(journey.root)) removeTreeWithRetry(journey.root);
}
