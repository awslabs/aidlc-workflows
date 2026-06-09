// fixtures.ts — TS port of tests/lib/fixtures.sh's project-scaffolding.
//
// Ports the project-creation / teardown helpers so the SDK harness can build
// and tear down temp AIDLC projects from TypeScript, the same way the shell
// suite did from bash. The bytes of the scaffolding match fixtures.sh:
//   - create_test_project   -> createTestProject()
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
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedCustomHarness } from "./custom-harness.ts";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HARNESS_DIR, "..", "..");
export const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
export const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

/**
 * Unset AIDLC-related env vars that a developer's shell (or a prior test) may
 * have leaked, so fixture-defined defaults aren't shadowed. Mirrors
 * reset_aidlc_env (fixtures.sh:16-18).
 */
export function resetAidlcEnv(): void {
  delete process.env.AWS_AIDLC_DEFAULT_SCOPE;
}

/**
 * Create a bare temp project dir with an empty aidlc-docs/. Mirrors
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
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  proj = toPortablePath(proj);
  return proj;
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
 * Copy a state fixture to <proj>/aidlc-docs/aidlc-state.md. Mirrors
 * seed_state_file (fixtures.sh:45-50). `fixturePath` may be an absolute path
 * or a bare fixture filename resolved against FIXTURES_DIR.
 */
export function seedStateFile(proj: string, fixturePath: string): void {
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  const src = existsSync(fixturePath) ? fixturePath : join(FIXTURES_DIR, fixturePath);
  copyFileSync(src, join(proj, "aidlc-docs", "aidlc-state.md"));
}

/**
 * Copy the audit sample to <proj>/aidlc-docs/audit.md. Mirrors seed_audit_file
 * (fixtures.sh:52-56).
 */
export function seedAuditFile(proj: string): void {
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  copyFileSync(join(FIXTURES_DIR, "audit-sample.md"), join(proj, "aidlc-docs", "audit.md"));
}

/**
 * Recursively remove a temp project dir. Mirrors cleanup_test_project
 * (fixtures.sh:58-61) — guards against empty/non-existent paths.
 */
export function cleanupTestProject(proj: string | undefined): void {
  if (proj && existsSync(proj)) rmSync(proj, { recursive: true, force: true });
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
// commit, plus an aidlc-docs/ dir for the audit emit. These helpers build and
// tear that down, mirroring setup_worktree_fixture / cleanup_worktree_fixture.
// ============================================================================

/** Basename prefix every worktree fixture lives under; cleanup refuses any
 *  path whose basename doesn't start with it (defence-in-depth, mirrors
 *  WORKTREE_FIXTURE_PREFIX_NAME in worktree-helpers.sh:15). */
export const WORKTREE_FIXTURE_PREFIX = "aidlc-worktree-";

/**
 * Create a fresh git repo in a tempdir with one commit on `main`, plus an
 * empty aidlc-docs/. Returns the canonical (realpath) project path — git
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
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
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
  rmSync(proj, { recursive: true, force: true });
}

/** Options for setupIntegrationProject — the flags from setup_integration_project. */
export interface IntegrationProjectOptions {
  /** Seed aidlc-state.md from this fixture (path or FIXTURES_DIR-relative name). */
  withState?: string;
  /** Seed audit.md from audit-sample.md. */
  withAudit?: boolean;
  /** Remove the scaffolded aidlc-docs/ dir (test the no-workspace path). */
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

  if (opts.withState) seedStateFile(proj, opts.withState);
  if (opts.withAudit) seedAuditFile(proj);

  if (opts.noAidlcDocs) {
    rmSync(join(proj, "aidlc-docs"), { recursive: true, force: true });
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
    const dest = join(proj, "aidlc-docs", "inception", "reverse-engineering");
    mkdirSync(dest, { recursive: true });
    cpSync(join(FIXTURES_DIR, "re-artifacts"), dest, { recursive: true });
  }

  if (opts.withInceptionArtifacts) {
    const ra = join(proj, "aidlc-docs", "inception", "requirements-analysis");
    const ad = join(proj, "aidlc-docs", "inception", "application-design");
    const ug = join(proj, "aidlc-docs", "inception", "units-generation");
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
      proj,
      "aidlc-docs",
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
