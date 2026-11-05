/**
 * The work the t126 and t138 live legs start from, created the way a person's
 * own `/aidlc <plan> <words>` creates it: the creation command with their words,
 * so the work's description is theirs. Each leg types the same words to the
 * agent (`/aidlc ${seed.scope} ${seed.request}`).
 *
 * The words ride as `--arguments`, not as the `--request <id>` a person's start
 * passes: only `next` writes the question copy a request id names, and `next`
 * run from a test process outside a chat stops at the hooks-presence step.
 * handleIntentCreate turns a request id into the same `arguments` field, so the
 * description record is the one a person's start writes.
 */
import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface LiveWorkSeed {
  scope: string;
  /** What the person asks for, typed after the plan's name. */
  request: string;
  /** The short folder name the agent gives the work on a person's start. */
  label: string;
  /** Creation settings the leg starts with. */
  settings?: readonly string[];
}

export const T126_SEED: LiveWorkSeed = {
  scope: "poc",
  request:
    "Build a local CLI that converts CSV input to formatted JSON output. " +
    "Use the simplest sensible stack, and approve each gate.",
  label: "csv-to-json",
};

// The reviewer is off: the scope-routing invariant does not depend on the
// review class, and with it on two adversarial iterations at nfr-requirements
// (three of four runs on 2026-09-12) took the leg past its budget.
export const T138_SEED: LiveWorkSeed = {
  scope: "security-patch",
  request:
    "This is a synthetic security-patch fixture. Scaffold a tiny " +
    "dependency-free Bun CLI that prints an HTML greeting for its argument, then fix " +
    "unsafe interpolation by exporting and using escapeHtmlText. Its exact contract is " +
    "to encode & as &amp;, < as &lt;, > as &gt;, double quote as &quot;, and single " +
    "quote as &#39;, while preserving ordinary and Unicode text. Add table-driven " +
    "regression tests that call the real exported function and a CLI test proving " +
    "the greeting uses it; those tests must fail against the unescaped implementation. " +
    "Use Bun built-in APIs, and continue through workflow completion.",
  label: "html-escape-patch",
  settings: ["--review", "none"],
};

function utility(proj: string, args: readonly string[], timeoutMs: number) {
  const res = spawnSync(
    process.execPath,
    [join(proj, ".claude", "tools", "aidlc-utility.ts"), ...args, "--project-dir", proj],
    { timeout: timeoutMs, cwd: proj, encoding: "utf8" },
  );
  return { status: res.status, stdout: res.stdout ?? "", output: `${res.stdout}\n${res.stderr}` };
}

/** Create the seed's work in `proj`, then check the description the stages
 *  read for `[desc]` is the person's words, not the engine's placeholder. */
export function seedLiveWork(proj: string, seed: LiveWorkSeed, timeoutMs: number): void {
  const created = utility(
    proj,
    [
      "intent-create",
      "--scope", seed.scope,
      "--arguments", seed.request,
      "--label", seed.label,
      ...(seed.settings ?? []),
    ],
    timeoutMs,
  );
  expect(created.status, created.output).toBe(0);
  expect(created.output).toContain("State initialized");

  const read = utility(proj, ["project-description"], timeoutMs);
  expect(read.status, read.output).toBe(0);
  expect((JSON.parse(read.stdout) as { description: unknown }).description).toBe(seed.request);
}
