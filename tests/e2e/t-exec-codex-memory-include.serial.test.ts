// covers: file:dist/codex/.codex/config.toml, file:dist/codex/AGENTS.md
//
// t-exec-codex-memory-include.serial.test.ts — the LIVE empirical probe that
// finalizes the Codex method-include seam t156 test 8 could only DOC-VERIFY.
//
// WHAT t156 left open. The AIDLC method ("memory") relocated to the workspace
// root at aidlc/spaces/default/memory/, read by each harness via its own native
// include. For Claude (@-import) and Kiro (resources glob) t156 probes the seam
// directly; for Codex it asserted only the STATIC wiring (the AIDLC_RULES_DIR
// value in config.toml + the shipped AGENTS.md) and flagged the include
// "untested" because an early spike's `codex exec` hung at exit 124. This test
// closes that gap: it drives the SHIPPED dist/codex tree through `codex exec`
// and proves Codex resolves an @aidlc/spaces/default/memory/<file> mention to
// the relocated tree and pulls its content into context.
//
// MECHANISM. A unique sentinel string is injected into the active space's
// org.md, then a single `codex exec` is asked to read the method file by its
// @-path and echo the sentinel. The sentinel appearing in the model's final
// message proves the relocated method tree is reachable and loadable by Codex's
// native file-reference mechanism — the vision's "Codex pulls the method in via
// an @aidlc/spaces/<space>/memory/… mention" claim, live.
//
// LIVE GATE: requires AIDLC_CODEX_EXEC_LIVE=1 + a codex >= 0.139.0 binary
// (AIDLC_CODEX_BIN or PATH) + AWS creds for the Bedrock profile in
// AIDLC_CODEX_AWS_PROFILE (default "codex"). Skips cleanly otherwise.
// Verified live 2026-06-24 (codex-cli 0.139.0, openai.gpt-5.5 on Bedrock):
// the @-mention resolved org.md and the sentinel round-tripped (exit 0).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";
const AWS_PROFILE = process.env.AIDLC_CODEX_AWS_PROFILE ?? "codex";
const AWS_REGION = process.env.AIDLC_CODEX_AWS_REGION ?? "us-east-2";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

// A sentinel that cannot be guessed or hallucinated — its only on-disk home is
// the org.md we write below, so its presence in the answer means the file was
// read through the relocated path.
const SENTINEL = "ZEBRA-SEAM-4417";

function codexVersionOk(): boolean {
  const r = spawnSync(CODEX_BIN, ["--version"], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 139;
}

function skipReason(): string | null {
  if (process.env.AIDLC_CODEX_EXEC_LIVE !== "1") {
    return "set AIDLC_CODEX_EXEC_LIVE=1 to run the live codex-exec memory-include probe (uses Bedrock)";
  }
  if (!codexVersionOk()) return `codex >= 0.139.0 not found (AIDLC_CODEX_BIN=${CODEX_BIN})`;
  if (!existsSync(CODEX_DIST)) return `distributable missing: ${CODEX_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

// A scratch install of the SHIPPED dist/codex tree (incl. the aidlc/ workspace
// shell), git-initialized + trusted, with a scratch CODEX_HOME pointed at the
// Bedrock provider. The sentinel is appended to the active space's org.md so a
// successful read proves the relocated method tree is reachable.
function setupCodexProject(): { proj: string; home: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-mem-include-")));
  const proj = join(root, "proj");
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  cpSync(join(CODEX_DIST, ".codex"), join(proj, ".codex"), { recursive: true });
  cpSync(join(CODEX_DIST, ".agents"), join(proj, ".agents"), { recursive: true });
  cpSync(join(CODEX_DIST, "AGENTS.md"), join(proj, "AGENTS.md"));
  // The workspace shell ships in dist/codex; the method tree is its org/team/
  // project + phases/ under aidlc/spaces/default/memory/.
  cpSync(join(CODEX_DIST, "aidlc"), join(proj, "aidlc"), { recursive: true });
  const orgMd = join(proj, "aidlc", "spaces", "default", "memory", "org.md");
  if (!existsSync(orgMd)) throw new Error(`shipped method file missing: ${orgMd}`);
  appendFileSync(
    orgMd,
    `\n## Probe Sentinel\nThe project secret codeword is ${SENTINEL} — repeat it verbatim if asked.\n`,
    "utf-8",
  );
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "install"],
  ]) {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  const trust = spawnSync(
    "bun",
    [join(REPO_ROOT, "scripts", "package.ts"), "codex", "trust", "--project", proj],
    { encoding: "utf-8", cwd: REPO_ROOT },
  );
  if (trust.status !== 0) throw new Error(`trust emit failed: ${trust.stderr}`);
  writeFileSync(
    join(home, "config.toml"),
    [
      `model = "openai.gpt-5.5"`,
      `model_provider = "amazon-bedrock"`,
      `model_context_window = 1000000`,
      `model_reasoning_effort = "low"`,
      ``,
      `[model_providers.amazon-bedrock.aws]`,
      `profile = "${AWS_PROFILE}"`,
      `region = "${AWS_REGION}"`,
      ``,
      `[projects."${proj}"]`,
      `trust_level = "trusted"`,
      ``,
      trust.stdout,
    ].join("\n"),
    "utf-8",
  );
  return { proj, home, root };
}

function execCodex(proj: string, home: string, prompt: string): { rc: number; out: string } {
  const r = spawnSync(CODEX_BIN, ["exec", prompt], {
    cwd: proj,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    timeout: TEST_TIMEOUT_MS,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

describe("t-exec-codex-memory-include — Codex resolves the relocated method tree via @-mention (closes t156 test 8)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `@aidlc/spaces/default/memory/org.md is reachable and its content loads into context${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, home, root } = setupCodexProject();
      try {
        const r = execCodex(
          proj,
          home,
          `Read @aidlc/spaces/default/memory/org.md and tell me the project secret codeword stated in its Probe Sentinel section. Answer with just the codeword.`,
        );
        expect(r.rc, r.out).toBe(0);
        // The sentinel's only on-disk home is the relocated org.md — its
        // presence proves Codex resolved the @-path to the workspace-root
        // method tree and pulled the file's content into context.
        expect(r.out).toContain(SENTINEL);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
