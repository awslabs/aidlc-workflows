// covers: harness-instrument:e2e-temporary-root
//
// Where the runner puts each test file's fixtures. On Windows they sit under
// the shorter of the runner's TEMP and the system's temp folder, so a test
// project is as deep as a person's; a live Codex leg keeps the runner's own
// TEMP, because Codex's Windows sandbox refuses AI-DLC's writes under
// %SystemRoot%. Each case reads the pick from a fresh runner process, since
// the helper keeps its first answer. Off Windows both cases hold as they did.

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { createE2eTemporaryRoot } from "../lib/e2e-workers.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const WORKERS = pathToFileURL(join(import.meta.dir, "..", "lib", "e2e-workers.ts")).href;
const made: string[] = [];

afterAll(() => {
  for (const path of made.reverse()) rmSync(path, { recursive: true, force: true });
});

// A runner TEMP deeper than %SystemRoot%\Temp, outside any Git marker.
async function runnerTemp(): Promise<string> {
  const base = await createE2eTemporaryRoot();
  made.push(base);
  const temp = join(base, "a-runner-temp-deeper-than-the-system-one");
  mkdirSync(temp);
  return realpathSync(temp);
}

// The fixture root a fresh runner process makes with this TEMP.
function fixtureRoot(temp: string, codexLive: boolean): string {
  const env: NodeJS.ProcessEnv = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
  if (codexLive) env.AIDLC_CODEX_EXEC_LIVE = "1";
  else delete env.AIDLC_CODEX_EXEC_LIVE;
  const script = "const { createE2eTemporaryRoot } = await import(process.argv[1]);" +
    "console.log(await createE2eTemporaryRoot());";
  const child = spawnSync(process.execPath, ["-e", script, WORKERS], {
    env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  expect(child.status, `${child.stdout}${child.stderr}`).toBe(0);
  const root = child.stdout.trim();
  made.push(root);
  return realpathSync(root);
}

test("a live Codex leg's fixtures stay in the runner's own temp folder, never the system one", async () => {
  const temp = await runnerTemp();
  expect(dirname(fixtureRoot(temp, true))).toBe(temp);
});

test("every other file still gets the shorter temp folder", async () => {
  const temp = await runnerTemp();
  expect(dirname(fixtureRoot(temp, false)).length).toBeLessThanOrEqual(temp.length);
});
