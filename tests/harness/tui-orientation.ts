import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTuiProject, setupTuiProject } from "./tui-fixtures.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "./tui-runtime.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "state-mid-ideation.md");
export const ORIENTATION_MARKER = "default · fixture · IDEATION";
const STARTUP_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(driver: string, args: string[]): Run {
  const { bin, prefix } = resolveTuiRuntime(driver);
  const res = spawnSync(bin, [...prefix, ...args], { encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
// Gate: the watched live-TUI tier (AIDLC_TUI_LIVE) + the selected substrate.
// Claude is needed on every platform; the distributable +
// the fixture must be present. A creds-less / binary-less machine SKIPs with a
// reason — never a hard fail (the P10 live-leg posture).
export function absentReason({ command }: { command: readonly [string, ...string[]] }): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live Claude TUI orientation render (watched tier)";
  }
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (spawnSync(command[0], ["--version"], { encoding: "utf-8" }).status !== 0) {
    return `${command[0]} CLI not found`;
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  if (!existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  return null;
}

export interface OrientationSample {
  pane: string;
  startupWallMs: number;
}

// Launch the claude TUI on the >1-space + active-intent fixture and return the
// captured pane once the orientation-bearing workflow statusline has painted.
// Every launch uses a unique session and proves its process tree is gone before
// the next launch can begin.
export function captureOrientationStatusline(
  sampleIndex: number,
  { driver, command }: { driver: string; command: readonly [string, ...string[]] },
): OrientationSample {
  const session = `aidlc_tui_journey_orient_${process.pid}_${sampleIndex}`;
  // setupTuiProject seeds the per-intent shell (default space's record + cursors)
  // and writes the mid-ideation state into it; secondSpace seeds a non-default
  // sibling space so listSpaces().length > 1 and the orientation prefix paints
  // its `<space> ·` segment. With the active space still `default`, the prefix
  // renders `default · fixture · IDEATION …`. No prompt, no tokens.
  const sandbox = setupTuiProject({ withState: "state-mid-ideation.md", secondSpace: true });
  let sample: OrientationSample | undefined;
  let launchError: unknown;
  try {
    // The statusLine key is what wires aidlc-statusline.ts into the TUI; a copy
    // that dropped it would render no [AIDLC] line at all.
    expect(readFileSync(join(sandbox, ".claude", "settings.json"), "utf8")).toContain(
      '"statusLine"',
    );

    const launchStartedAt = Date.now();
    const started = drive(driver, [
      "start",
      "--session",
      session,
      "--cwd",
      sandbox,
      "--width",
      "120",
      "--height",
      "40",
      "--",
      ...command,
    ]);
    expect(started.rc).toBe(0);

    // One bounded grid-driven startup loop handles both old Claude modal paths
    // and the current preseeded path. A visible trust / bypass modal is answered;
    // otherwise the already-painted orientation statusline returns immediately.
    const startup = drive(driver, [
      "startup",
      "--session",
      session,
      "--ready-pattern",
      ORIENTATION_MARKER,
      "--timeout-ms",
      String(STARTUP_TIMEOUT_MS),
    ]);
    const pane = drive(driver, ["capture", "--session", session]).stdout;
    if (startup.rc !== 0) {
      throw new Error(
        `orientation statusline "${ORIENTATION_MARKER}" never painted.\n` +
          `---- startup stderr ----\n${startup.stderr}\n` +
          `---- last pane ----\n${pane}\n-------------------`,
      );
    }
    sample = {
      pane,
      startupWallMs: Date.now() - launchStartedAt,
    };
  } catch (error) {
    launchError = error;
  }

  const killed = drive(driver, ["kill", "--session", session]);
  const dead = drive(driver, [
    "wait-dead",
    "--session",
    session,
    "--timeout-ms",
    String(PROCESS_EXIT_TIMEOUT_MS),
  ]);
  let fixtureCleanupError: unknown;
  if (killed.rc === 0 && dead.rc === 0) {
    try {
      cleanupTuiProject(sandbox);
    } catch (error) {
      fixtureCleanupError = error;
    }
  } else {
    fixtureCleanupError =
      `skipped because process teardown failed; workspace preserved at ${sandbox}`;
  }

  if (killed.rc !== 0 || dead.rc !== 0 || fixtureCleanupError !== undefined) {
    throw new Error(
      `TUI session '${session}' did not cleanly reap its process tree and fixture.\n` +
        `---- kill stderr ----\n${killed.stderr}\n` +
        `---- wait-dead stderr ----\n${dead.stderr}\n` +
        `---- fixture cleanup ----\n${String(fixtureCleanupError ?? "ok")}\n` +
        `---- original launch error ----\n${String(launchError ?? "none")}\n`,
    );
  }

  if (launchError !== undefined) throw launchError;
  if (sample === undefined) {
    throw new Error(`TUI session '${session}' produced no orientation sample`);
  }
  return sample;
}
