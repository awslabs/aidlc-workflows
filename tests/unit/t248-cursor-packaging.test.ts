// t248-cursor-packaging: dist/cursor parity + drift guard + Cursor-native wiring.
//
// covers: file:tools/aidlc-lib.ts
//
// The direct analog of t150-codex-packaging.test.ts for the Cursor harness.
// ADR-006 names this `t145-cursor-packaging.test.ts`, but t145 is already taken
// twice under tests/integration/; scanning every tier, the next free sequential
// number is 248. It lands in tests/unit/ (packaging parity) — the same tier as
// t150-codex — keeping the descriptive `-cursor-packaging` suffix.
//
// WHAT. Six contracts land here (TC-SEC-001..006 from security/testing-framework.md):
//   (1) The committed dist/cursor tree is byte-identical to what
//       `bun scripts/package.ts cursor --check` regenerates (drift guard, same
//       UX as codex's t150 test 1 and TC-SEC-033).
//   (2) Core parity: every .ts under dist/cursor/.cursor/{tools,hooks}/ is
//       BYTE-IDENTICAL to its dist/claude source (the architecture-B invariant:
//       the generator may transform prose/data paths, never code). The authored
//       Cursor adapter (aidlc-cursor-*.ts) has no claude counterpart and is
//       exempt.
//   (3) No cross-harness prose contamination — the shipped tree names no OTHER
//       harness's `bun <dir>/tools/` command idiom.
//   (4) Cursor-native wiring — hooks.json declares the lifecycle events with the
//       correct security fields (TC-SEC-001/002/003/006: beforeShellExecution &
//       preToolUse failClosed:true; beforeSubmitPrompt & afterFileEdit fail-open;
//       stop loop_limit:3; preToolUse matcher covers the read tools), and the
//       .mdc rule frontmatter is well-formed (aidlc-method alwaysApply:true; the
//       phase rules alwaysApply:false with a description).
//   (5) Doctor — cpSync the dist/cursor/ contents into a scratch project and
//       assert `aidlc-utility.ts doctor` exits 0 (same idiom as t150 test 13 /
//       t240 test 10).
//   (6) cli.json deny list (TC-SEC-004) + the dot-gitignore credential excludes
//       are present.
//
// WHY SUBPROCESS for (1). Same idiom as t141/t150/t240: the packager is a CLI;
// we pin its observable behavior, not its internals.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const CURSOR_ROOT = join(REPO_ROOT, "dist", "cursor");
const CURSOR_DST = join(CURSOR_ROOT, ".cursor");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Parse a .mdc file's YAML frontmatter block into a raw string (between the
 *  leading `---` fences), or "" when the file carries none. */
function frontmatterOf(mdcPath: string): string {
  const raw = readFileSync(mdcPath, "utf-8");
  return raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

describe("t248 dist/cursor packaging parity + Cursor-native wiring", () => {
  test("1: committed dist/cursor matches the packaging script (drift guard) [TC-SEC-033]", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "cursor", "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) {
      // Surface the script's own stale-file list — it names the fix.
      console.error(r.stderr);
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in sync");
  });

  test("2: every packaged .ts file is byte-identical to its dist/claude source (code is never transformed)", () => {
    // tools/ + hooks/ carry the deterministic core. The cursor adapter
    // (authored shim, aidlc-cursor-*.ts) has no claude counterpart and is
    // exempt; everything else must match its source byte-for-byte.
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(CURSOR_DST, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        if (/aidlc-cursor-[^/]+\.ts$/.test(file)) continue;
        const rel = file.slice(dstDir.length + 1);
        const src = join(CLAUDE_SRC, sub, rel);
        if (!readFileSync(file).equals(readFileSync(src))) divergent.push(`${sub}/${rel}`);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: shipped cursor prose names no other harness's engine dir", () => {
    // Each other harness's `bun <dir>/tools/` command idiom must be absent from
    // the generated tree — the same contamination probe as codex's t150 test 3
    // and opencode's t240 test 7. (Prose that LISTS the harness dirs as scan
    // excludes — e.g. workspace-detection.md — is legitimate and not a command
    // idiom, so it does not match these patterns.)
    for (const idiom of [
      "bun .claude/tools/",
      "bun .kiro/tools/",
      "bun .codex/tools/",
      "bun .opencode/tools/",
      "bun .aidlc/tools/",
    ]) {
      const r = spawnSync("grep", ["-rn", idiom, CURSOR_ROOT], { encoding: "utf-8" });
      // grep exits 1 on no matches — exactly what we want.
      expect(r.status, `unexpected contamination: ${idiom}`).toBe(1);
    }
  });

  test("4: hooks.json wires the Cursor lifecycle events with the correct security fields [TC-SEC-001/002/003/006]", () => {
    // NOTE: system-architecture.md §236 prose says "eight" events, but its own
    // §275 event-mapping table (the authoritative HOOK_WIRING in
    // harness/cursor/emit.ts) ships SEVEN. We assert the shipped surface.
    const wiring = JSON.parse(readFileSync(join(CURSOR_DST, "hooks.json"), "utf-8")) as {
      version: number;
      hooks: Record<
        string,
        Array<{ command: string; failClosed?: boolean; matcher?: string; loop_limit?: number }>
      >;
    };
    expect(wiring.version).toBe(1);
    expect(Object.keys(wiring.hooks).sort()).toEqual(
      [
        "afterFileEdit",
        "beforeShellExecution",
        "beforeSubmitPrompt",
        "preCompact",
        "preToolUse",
        "stop",
        "subagentStop",
      ].sort(),
    );

    // Every registration routes through the single authored adapter.
    for (const groups of Object.values(wiring.hooks)) {
      for (const h of groups) {
        expect(h.command).toMatch(/^bun \.cursor\/hooks\/aidlc-cursor-adapter\.ts [a-z-]+$/);
      }
    }

    const only = (event: string) => {
      const groups = wiring.hooks[event];
      expect(groups.length, `${event}: exactly one registration`).toBe(1);
      return groups[0];
    };

    // TC-SEC-001: the shell gate fails CLOSED.
    expect(only("beforeShellExecution").failClosed).toBe(true);
    // TC-SEC-002: the reviewer read-scope gate fails CLOSED.
    expect(only("preToolUse").failClosed).toBe(true);
    // Advisory hooks are fail-open — failClosed absent (not merely false).
    expect(only("beforeSubmitPrompt").failClosed).toBeUndefined();
    expect(only("afterFileEdit").failClosed).toBeUndefined();
    // TC-SEC-003: the stop hook bounds self-correction at a positive integer.
    const loopLimit = only("stop").loop_limit;
    expect(typeof loopLimit).toBe("number");
    expect(Number.isInteger(loopLimit as number)).toBe(true);
    expect(loopLimit).toBe(3);
    // TC-SEC-006: the read-scope matcher covers every file-reading tool.
    const matcher = only("preToolUse").matcher ?? "";
    for (const tool of ["Read", "LS", "Glob", "Grep"]) {
      expect(matcher, `preToolUse matcher covers ${tool}`).toContain(tool);
    }
  });

  test("4b: .mdc rule frontmatter — method is alwaysApply, phase rules carry a description", () => {
    // aidlc-method: alwaysApply:true, no description (an always-on rule needs no
    // agent-decided applicability hint). The packager may split it into
    // aidlc-method-core / aidlc-method-project when over the line cap — accept
    // either shape, but every method layer stays alwaysApply:true.
    const rulesRoot = join(CURSOR_DST, "rules");
    const ruleDirs = readdirSync(rulesRoot).filter((d) =>
      statSync(join(rulesRoot, d)).isDirectory(),
    );
    const methodDirs = ruleDirs.filter((d) => d.startsWith("aidlc-method"));
    expect(methodDirs.length).toBeGreaterThan(0);
    for (const d of methodDirs) {
      const fm = frontmatterOf(join(rulesRoot, d, `${d}.mdc`));
      expect(fm, `${d}: alwaysApply:true`).toMatch(/^alwaysApply: true$/m);
      expect(fm, `${d}: no description on an always-on rule`).not.toMatch(/^description:/m);
    }

    // Phase rules: alwaysApply:false WITH a description (Cursor uses the
    // description to decide when to pull the phase rule in).
    for (const slug of ["ideation", "inception", "construction", "operation"]) {
      const name = `aidlc-phase-${slug}`;
      const fm = frontmatterOf(join(rulesRoot, name, `${name}.mdc`));
      expect(fm, `${name}: alwaysApply:false`).toMatch(/^alwaysApply: false$/m);
      expect(fm, `${name}: carries a description`).toMatch(/^description: \S.*$/m);
    }
  });

  test("5: doctor exits 0 on a scratch project seeded from dist/cursor/", () => {
    const root = mkdtempSync(join(tmpdir(), "t248-cursor-doctor-"));
    try {
      const project = join(root, "project");
      // The whole shipped distribution — .cursor/ engine + .cursor-plugin/ +
      // AGENTS.md + the aidlc/ workspace shell + the .gitignore.
      cpSync(CURSOR_ROOT, project, { recursive: true });
      const tool = join(project, ".cursor", "tools", "aidlc-utility.ts");
      const r = spawnSync(process.execPath, [tool, "doctor", "--project-dir", project], {
        cwd: project,
        encoding: "utf-8",
      });
      if (r.status !== 0) console.error(`${r.stdout ?? ""}${r.stderr ?? ""}`);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("0 failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("6: cli.json deny list [TC-SEC-004] and the dot-gitignore credential excludes are present", () => {
    // TC-SEC-004: the cursor-agent CLI permission set denies destructive,
    // history-rewriting, and network commands.
    const cli = JSON.parse(readFileSync(join(CURSOR_DST, "cli.json"), "utf-8")) as {
      permissions: { allow: string[]; deny: string[] };
    };
    const deny = cli.permissions.deny;
    for (const pattern of ["rm -rf", "git push", "git reset --hard", "curl", "wget"]) {
      expect(
        deny.some((d) => d.includes(pattern)),
        `cli.json deny list must include a pattern matching: ${pattern}`,
      ).toBe(true);
    }

    // The shipped .gitignore carries the credential excludes (defense-in-depth
    // alongside the beforeShellExecution / preToolUse gates).
    const gitignore = join(CURSOR_ROOT, ".gitignore");
    expect(existsSync(gitignore)).toBe(true);
    const ignore = readFileSync(gitignore, "utf-8");
    for (const secret of [".env", "*.pem", "*.key", ".aws/credentials"]) {
      expect(ignore, `.gitignore excludes ${secret}`).toContain(secret);
    }
    // TC-SEC-005 corollary: no legacy single-file .cursorrules ships.
    expect(existsSync(join(CURSOR_ROOT, ".cursorrules"))).toBe(false);
  });
});
