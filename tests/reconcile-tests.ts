#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { captureTestSource, testSourceOutputIsExcluded } from "./lib/test-source.ts";
import { prepareTestMatrixPlan, reconcileTestMatrix } from "./lib/test-matrix.ts";

/** Pure offline CLI. It never discovers required jobs from received results. */
export function main(argv: string[]): number {
  let output: string | undefined;
  try {
    const command = argv[0]?.startsWith("--") ? "reconcile" : argv.shift();
    const options = new Map<string, string>();
    const receipts: string[] = [];
    if (command !== "source" && command !== "reconcile" && command !== "prepare") throw new Error("expected source, prepare or reconcile command");
    const allowed = command === "source" ? ["--repo"] : command === "prepare"
      ? ["--profile", "--cohort", "--repo", "--output"] : ["--plan", "--receipt", "--output"];
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!allowed.includes(flag) || !value || value.startsWith("--")) throw new Error("invalid CLI arguments");
      if (flag === "--receipt") receipts.push(resolve(value));
      else {
        if (options.has(flag)) throw new Error(`duplicate ${flag}`);
        options.set(flag, value);
      }
    }
    if (command === "source") {
      const root = options.get("--repo");
      if (!root) throw new Error("source requires --repo ROOT");
      process.stdout.write(`${captureTestSource(root).sourceDigest}\n`);
      return 0;
    }
    if (command === "prepare") {
      const profile = options.get("--profile");
      const cohort = options.get("--cohort");
      const root = options.get("--repo");
      const destination = options.get("--output");
      if (!profile || !cohort || !root || !destination) {
        throw new Error("prepare requires --profile FILE --cohort ID --repo ROOT --output FILE");
      }
      const target = resolve(destination);
      const sameProfile = existsSync(target)
        ? realpathSync(target) === realpathSync(profile) : target === resolve(profile);
      const source = captureTestSource(root);
      const sourceTarget = source.files.some((file) => resolve(root, file.path) === target);
      if (sameProfile || sourceTarget || !testSourceOutputIsExcluded(root, target)) {
        throw new Error("prepared plan must be in ignored/outside source storage and must not replace its profile");
      }
      const plan = prepareTestMatrixPlan(profile, cohort, root);
      publish(target, plan);
      process.stdout.write(`${plan.sourceDigest}\n`);
      return 0;
    }
    const plan = options.get("--plan");
    const destination = options.get("--output");
    if (!plan || !destination) throw new Error("reconcile requires --plan FILE and --output FILE");
    const inputs = [plan, ...receipts, ...referencedJUnitPaths(receipts)];
    const destinationIdentity = inputIdentity(destination);
    if (inputs.some((path) => inputIdentity(path) === destinationIdentity)) {
      throw new Error("reconciliation output must not overwrite an input");
    }
    // Authorize both normal and error publication only after protecting every
    // reference, including receipts rejected later and a missing/invalid plan.
    output = resolve(destination);
    const report = reconcileTestMatrix(plan, receipts);
    publish(output, report);
    const fulfilled = report.obligations.filter((row) => row.status === "FULFILLED").length;
    const requested = report.obligations.filter((row) => row.status !== "NOT_REQUESTED").length;
    process.stdout.write(`${report.status}: ${fulfilled}/${requested} requested obligations fulfilled\n`);
    return report.complete ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (output) {
      try { publish(output, { version: 1, status: "ERROR", complete: false, errors: [message], obligations: [] }); }
      catch { /* The stderr/exit status must still expose publication failure. */ }
    }
    process.stderr.write(`test-matrix: ${message}\n`);
    return 2;
  }
}

function inputIdentity(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  // Missing evidence must stay missing, including through a directory alias.
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    missing.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

function referencedJUnitPaths(receipts: readonly string[]): string[] {
  return receipts.flatMap((path) => {
    // This only protects inputs; test-matrix remains the schema/evidence
    // validator. Unreadable JSON cannot authorize writing a report destination.
    const receipt: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
    if (!receipt || typeof receipt !== "object" || !("files" in receipt) || !Array.isArray(receipt.files)) return [];
    return receipt.files.flatMap((file: unknown) =>
      file && typeof file === "object" && "junitPath" in file &&
      typeof file.junitPath === "string" && file.junitPath.length > 0
        ? [resolve(dirname(path), file.junitPath)] : []);
  });
}

function publish(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
