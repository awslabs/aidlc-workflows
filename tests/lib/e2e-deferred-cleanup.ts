import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { IsolatedProcessRetirement } from "./e2e-process.ts";

const CODEX_FILE = /^t-exec-codex-(?:status|memory-include|compose-front|compose-inflight|journey-workspace)\.serial\.test\.ts$/;
const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

function plainDirectory(path: string): (atPath?: string) => void {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error("Deferred Codex cleanup requires unchanged plain directories");
  }
  return (atPath = path) => {
    const now = lstatSync(atPath, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== stat.dev || now.ino !== stat.ino ||
      !samePath(realpathSync(atPath), atPath)) throw new Error("Deferred Codex cleanup directory identity changed");
  };
}

function readPlain(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid deferred Codex cleanup control file");
  return readFileSync(path, "utf8");
}

/** A receipt requests retention; it never proves process retirement or grants
 * deletion authority. The coordinator supplies its native retirement result. */
export async function retainDeferredCodexFixtures(
  env: NodeJS.ProcessEnv,
  artifactDir: string,
  retirement?: IsolatedProcessRetirement,
): Promise<string | undefined> {
  const names = readdirSync(artifactDir).filter(name => name.startsWith("codex-deferred-cleanup-"));
  if (names.length === 0) return undefined;
  const invalid = () => new Error("Deferred Codex cleanup receipt does not match the retired file");
  if (names.some(name => !/^codex-deferred-cleanup-[1-9]\d*\.json$/.test(name)) ||
    retirement?.platform !== "win32" || !retirement.job ||
    !/^Local\\aidlc-e2e-[a-f0-9-]{36}$/.test(retirement.job) ||
    env.AIDLC_CODEX_EXEC_LIVE !== "1" || env.AIDLC_TEST_WORKER_PROCESS_GROUP !== "0" ||
    !/^[1-9]\d*$/.test(env.AIDLC_TEST_WORKER_ID ?? "") ||
    !CODEX_FILE.test(env.AIDLC_TEST_NAME ?? "")) throw invalid();

  const temp = env.TEMP;
  if (!temp || !isAbsolute(temp) || !isAbsolute(artifactDir) ||
    !env.TMP || !env.TMPDIR || !env.AIDLC_TEST_WORKER_ROOT ||
    !samePath(temp, env.TMP) || !samePath(temp, env.TMPDIR) ||
    !samePath(artifactDir, env.AIDLC_TEST_WORKER_ROOT) ||
    !/^aidlc-e2e-fixtures-[A-Za-z0-9]+$/.test(basename(temp)) ||
    !samePath(retirement.configPath, join(artifactDir, "process-config.json"))) throw invalid();
  const verifyTemp = plainDirectory(temp);
  const verifyArtifacts = plainDirectory(artifactDir);
  const verifyRoots = new Map<string, (atPath?: string) => void>();
  if (readPlain(retirement.configPath) !== retirement.configText) throw invalid();
  const config = JSON.parse(retirement.configText);
  if (config.job !== retirement.job || typeof config.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(config.token) ||
    !Array.isArray(config.command) || config.command[1] !== "test" ||
    typeof config.command[2] !== "string" || !isAbsolute(config.command[2]) ||
    typeof config.cwd !== "string" || !isAbsolute(config.cwd) ||
    typeof config.status !== "string" ||
    !samePath(config.status, join(artifactDir, "process-status.json")) ||
    !samePath(config.command[2], join(config.cwd, "tests", "e2e", env.AIDLC_TEST_NAME!))) throw invalid();
  const status = JSON.parse(readPlain(config.status));
  if (status.token !== config.token || !["running", "exited", "error"].includes(status.phase)) throw invalid();

  const reportPath = join(dirname(dirname(artifactDir)), "e2e-results.json");
  const report = JSON.parse(readPlain(reportPath));
  const rows = Array.isArray(report.files) ? report.files.filter((row: Record<string, unknown>) =>
    row.worker === Number(env.AIDLC_TEST_WORKER_ID) &&
    row.file === `tests/e2e/${env.AIDLC_TEST_NAME}`) : [];
  const row = rows[0];
  if (rows.length !== 1 || row.state !== "RUNNING" ||
    typeof row.artifacts !== "string" || !samePath(row.artifacts, artifactDir) ||
    typeof row.temporaryDirectory !== "string" || !samePath(row.temporaryDirectory, temp) ||
    typeof row.checkout !== "string" || !samePath(row.checkout, config.cwd)) throw invalid();

  const roots = new Set<string>();
  for (const name of names) {
    const receipt = JSON.parse(readPlain(join(artifactDir, name)));
    if (typeof receipt.root !== "string" || !isAbsolute(receipt.root) ||
      !samePath(dirname(receipt.root), temp) ||
      !/^(?:codex-exec|codex-mem-include|aidlc-journey)-[A-Za-z0-9]+$/.test(basename(receipt.root)) ||
      typeof receipt.temporaryDirectory !== "string" || !samePath(receipt.temporaryDirectory, temp) ||
      typeof receipt.coordinatorReport !== "string" || !samePath(receipt.coordinatorReport, reportPath) ||
      typeof receipt.runnerConfig !== "string" || !samePath(receipt.runnerConfig, retirement.configPath) ||
      receipt.job !== retirement.job) throw invalid();
    verifyRoots.set(receipt.root, plainDirectory(receipt.root));
    roots.add(receipt.root);
  }

  // Move the whole container just as failed fixtures are already preserved.
  // This avoids reading/deleting protected Codex children. Cross-volume moves
  // require copying, but must leave the protected source for host cleanup.
  const destination = join(artifactDir, "retained-fixtures");
  verifyTemp();
  verifyArtifacts();
  for (const verify of verifyRoots.values()) verify();
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error("Deferred Codex snapshot destination already exists");
  let sourceKept = false;
  try {
    await rename(temp, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await mkdir(destination);
    // The root is exclusively reserved above. Bun rejects copying a directory
    // onto that existing root with errorOnExist, so copy its fresh entries.
    for (const name of readdirSync(temp)) {
      await cp(join(temp, name), join(destination, name), {
        recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false,
      });
    }
    sourceKept = true;
  }
  verifyArtifacts();
  verifyTemp(sourceKept ? temp : destination);
  for (const [root, verify] of verifyRoots) verify(sourceKept ? root : join(destination, basename(root)));
  await writeFile(join(artifactDir, "deferred-cleanup.json"), `${JSON.stringify({
    schemaVersion: 1,
    state: "process-retired-fixtures-retained",
    temporaryDirectory: temp,
    roots: [...roots],
    retainedRoots: [...roots].map(root => join(destination, basename(root))),
    snapshot: destination,
    sourceKept,
    runnerConfig: retirement.configPath,
    retiredJob: retirement.job,
    receipts: names.sort(),
    // This is diagnostic evidence, not authorization for a later deletion.
    cleanupOwner: "host",
  }, null, 2)}\n`, { flag: "wx" });
  console.error(`Codex fixtures retained after verified job retirement: ${destination}; original source kept: ${sourceKept}`);
  return destination;
}
