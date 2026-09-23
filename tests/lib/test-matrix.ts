import { createHash, randomUUID } from "node:crypto";
import {
  linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { readJUnitEvidence, type JUnitTestCase } from "./e2e-plan.ts";
import { captureTestSource, testSourceOutputIsExcluded, type TestSourceCapture } from "./test-source.ts";

export const TEST_MATRIX_LIVE_GATES = [
  "AIDLC_CLAUDE_SDK_LIVE", "AIDLC_TUI_LIVE", "AIDLC_KIRO_ACP_LIVE",
  "AIDLC_KIRO_TUI_LIVE", "AIDLC_CODEX_EXEC_LIVE", "AIDLC_COPILOT_EXEC_LIVE",
  "AIDLC_CURSOR_RUN_LIVE", "AIDLC_KIRO_IDE_LIVE", "AIDLC_OPENCODE_RUN_LIVE",
  "AIDLC_RELEASE_CONTRACT_LIVE",
] as const;
export type AllowedLiveGate = typeof TEST_MATRIX_LIVE_GATES[number];
export type TestMatrixBackend = "bun" | "tmux" | "node-pty" | "none";
export interface TestMatrixCase { classname: string; name: string }
export interface TestMatrixFile { path: string; cases: TestMatrixCase[] }
export interface TestMatrixRuntimeIdentity {
  platform: NodeJS.Platform;
  architecture: string;
  backend: TestMatrixBackend;
  bunVersion: string;
}
export interface TestMatrixJob {
  id: string;
  platform: NodeJS.Platform;
  architecture: string;
  backend: TestMatrixBackend;
  files: TestMatrixFile[];
  gates?: Partial<Record<AllowedLiveGate, "0" | "1">>;
}
export interface TestMatrixPlan {
  version: 1;
  cohortId: string;
  sourceDigest: string;
  jobs: TestMatrixJob[];
  profile?: {
    name: string;
    notRequested?: Array<Omit<TestMatrixJob, "gates"> & { reason: string }>;
  };
}
export interface TestMatrixContext {
  readonly root: string;
  readonly planPath: string;
  readonly planDigest: string;
  readonly plan: TestMatrixPlan;
  readonly job: TestMatrixJob;
  readonly source: TestSourceCapture;
}
export type TestMatrixFileState = "PASS" | "FAIL" | "SKIP" | "TIMED_OUT" | "INCOMPLETE" | "ERROR";
export type TestMatrixRunStatus = "PASS" | "FAIL" | "ERROR" | "INTERRUPTED" | "INCOMPLETE";
type EffectiveGates = Record<AllowedLiveGate, "0" | "1" | "invalid" | null>;
export interface TestMatrixReceiptFile {
  file: string;
  junitPath: string | null;
  junitSha256: string | null;
  state: TestMatrixFileState;
  evidenceComplete: boolean;
  xmlComplete: boolean;
  cases: JUnitTestCase[];
  errors: string[];
}
export interface TestMatrixReceipt {
  version: 1;
  cohortId: string;
  sourceDigest: string;
  sourceAfterDigest: string | null;
  sourceUnchanged: boolean;
  planDigest: string;
  planUnchanged: boolean;
  jobId: string;
  stamp: string;
  runtimeIdentity: TestMatrixRuntimeIdentity;
  gates: EffectiveGates;
  effectiveInventory: TestMatrixFile[];
  files: TestMatrixReceiptFile[];
  runStatus: TestMatrixRunStatus;
  status: "PASS" | "FAIL";
  errors: string[];
}
export interface TestMatrixReceiptInput {
  stampDir: string;
  files: Array<{
    file: string; junitPath?: string | null; state: TestMatrixFileState; evidenceComplete: boolean;
  }>;
  runStatus: TestMatrixRunStatus;
  errors: string[];
  runtimeIdentity: TestMatrixRuntimeIdentity;
  gates: Record<string, string | null | undefined>;
}

const backends = ["bun", "tmux", "node-pty", "none"];
const platforms = ["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"];
const fileStates = ["PASS", "FAIL", "SKIP", "TIMED_OUT", "INCOMPLETE", "ERROR"];
const runStates = ["PASS", "FAIL", "ERROR", "INTERRUPTED", "INCOMPLETE"];
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const caseKey = (value: TestMatrixCase): string => JSON.stringify([value.classname, value.name]);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const contexts = new WeakMap<TestMatrixContext, {
  selection?: string[]; runtimeIdentity?: TestMatrixRuntimeIdentity;
}>();

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has unknown fields`);
}
function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.trim().length === 0)) {
    throw new Error(`${label} must be a ${empty ? "" : "nonempty "}string`);
  }
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}
function list(value: unknown, label: string, nonempty = true): unknown[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) throw new Error(`${label} must be an ${nonempty ? "nonempty " : ""}array`);
  return value;
}
function strings(value: unknown, label: string): string[] {
  return list(value, label, false).map((entry) => text(entry, label));
}
function choice<T extends string>(value: unknown, allowed: readonly string[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`invalid ${label}`);
  return value as T;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function portablePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (
    isAbsolute(path) || win32.isAbsolute(path) || /[:\\]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`${label} must be a contained relative POSIX path`);
  return path;
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
function cases(value: unknown, label: string, outcomes = false, nonempty = true): JUnitTestCase[] {
  const result = list(value, label, nonempty).map((entry) => {
    const row = object(entry, label);
    keys(row, outcomes ? ["classname", "name", "outcome", "file"] : ["classname", "name"], label);
    return {
      classname: text(row.classname, `${label}.classname`, true),
      name: text(row.name, `${label}.name`),
      outcome: outcomes ? choice<JUnitTestCase["outcome"]>(row.outcome, ["PASS", "FAIL", "SKIP"], "case outcome") : "PASS" as const,
      ...(outcomes && row.file !== undefined ? { file: text(row.file, `${label}.file`) } : {}),
    };
  });
  unique(result.map(caseKey), `${label} identity`);
  return result;
}
function inventory(value: unknown, label: string, nonempty = true): TestMatrixFile[] {
  const result = list(value, label, nonempty).map((entry) => {
    const row = object(entry, label);
    keys(row, ["path", "cases"], label);
    return {
      path: portablePath(row.path, `${label}.path`),
      cases: cases(row.cases, `${label}.cases`, false, nonempty).map(({ classname, name }) => ({ classname, name })),
    };
  });
  unique(result.map((file) => file.path), `${label} path`);
  return result;
}
function expectedGates(value: unknown): TestMatrixJob["gates"] {
  if (value === undefined) return undefined;
  const row = object(value, "job gates");
  keys(row, [...TEST_MATRIX_LIVE_GATES], "job gates");
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, choice(value, ["0", "1"], `expected gate ${key}`)]));
}
function runtime(value: unknown): TestMatrixRuntimeIdentity {
  const row = object(value, "runtime identity");
  keys(row, ["platform", "architecture", "backend", "bunVersion"], "runtime identity");
  const architecture = text(row.architecture, "architecture");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(architecture)) throw new Error("invalid architecture");
  const bunVersion = text(row.bunVersion, "Bun version");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(bunVersion)) throw new Error("invalid Bun version");
  return {
    platform: choice(row.platform, platforms, "platform"),
    architecture,
    backend: choice(row.backend, backends, "backend"),
    bunVersion,
  };
}
function job(value: unknown, optional = false): TestMatrixJob & { reason?: string } {
  const row = object(value, "job");
  keys(row, ["id", "platform", "architecture", "backend", "files", ...(optional ? ["reason"] : ["gates"])], "job");
  const identity = runtime({ platform: row.platform, architecture: row.architecture, backend: row.backend, bunVersion: "0.0.0" });
  return {
    id: text(row.id, "job id"),
    platform: identity.platform, architecture: identity.architecture, backend: identity.backend,
    files: inventory(row.files, "job files"),
    ...(optional ? { reason: text(row.reason, "not-requested reason") } : { gates: expectedGates(row.gates) }),
  };
}
function decodeJSON(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} is not valid UTF-8 JSON`); }
}
function parsePlan(value: unknown): TestMatrixPlan {
  const row = object(value, "matrix plan");
  keys(row, ["version", "cohortId", "sourceDigest", "jobs", "profile"], "matrix plan");
  if (row.version !== 1) throw new Error("unsupported matrix plan version");
  const jobs = list(row.jobs, "jobs").map((value) => job(value));
  let profile: TestMatrixPlan["profile"];
  if (row.profile !== undefined) {
    const p = object(row.profile, "profile");
    keys(p, ["name", "notRequested"], "profile");
    profile = {
      name: text(p.name, "profile name"),
      notRequested: p.notRequested === undefined ? [] :
        list(p.notRequested, "notRequested", false).map((value) => job(value, true) as Omit<TestMatrixJob, "gates"> & { reason: string }),
    };
  }
  unique([...jobs, ...(profile?.notRequested ?? [])].map((j) => j.id), "job id");
  return { version: 1, cohortId: text(row.cohortId, "cohortId"), sourceDigest: digest(row.sourceDigest, "sourceDigest"), jobs, ...(profile ? { profile } : {}) };
}
function readPlan(path: string): { plan: TestMatrixPlan; planDigest: string } {
  const bytes = readFileSync(path);
  return { plan: parsePlan(decodeJSON(bytes, "matrix plan")), planDigest: hash(bytes) };
}

/** Prepare from a reviewed profile, never from received result inventories. */
export function prepareTestMatrixPlan(profilePath: string, cohortId: string, root: string): TestMatrixPlan {
  const bytes = readFileSync(profilePath);
  const profile = object(decodeJSON(bytes, "matrix profile"), "matrix profile");
  keys(profile, ["version", "name", "jobs", "notRequested"], "matrix profile");
  if (profile.version !== 1) throw new Error("unsupported matrix profile version");
  const source = captureTestSource(root);
  const plan = parsePlan({
    version: 1, cohortId, sourceDigest: source.sourceDigest, jobs: profile.jobs,
    profile: { name: profile.name, ...(profile.notRequested !== undefined ? { notRequested: profile.notRequested } : {}) },
  });
  const authored = new Set(source.files.filter((file) => file.kind === "file").map((file) => file.path));
  if (plan.jobs.some((job) => job.files.some((file) => !authored.has(file.path)))) {
    throw new Error("matrix profile requests a file that is not a regular authored source input");
  }
  if (hash(readFileSync(profilePath)) !== hash(bytes)) throw new Error("matrix profile changed during preparation");
  return plan;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function loadTestMatrixJob(planPath: string, jobId: string, root: string): TestMatrixContext {
  const loaded = readPlan(planPath);
  const selected = loaded.plan.jobs.find((job) => job.id === jobId);
  if (!selected) throw new Error("matrix job is not requested by this plan");
  const source = captureTestSource(root);
  if (source.sourceDigest !== loaded.plan.sourceDigest) throw new Error("matrix source digest mismatch before dispatch");
  const authored = new Set(source.files.filter((file) => file.kind === "file").map((file) => file.path));
  if (selected.files.some((file) => !authored.has(file.path))) throw new Error("matrix job file is not a regular authored source input");
  const context = freeze({
    root: realpathSync(resolve(root)), planPath: resolve(planPath),
    planDigest: loaded.planDigest, plan: loaded.plan, job: selected, source,
  });
  contexts.set(context, {});
  return context;
}

function validateSelection(context: TestMatrixContext, relativeFiles: readonly string[], actual: TestMatrixRuntimeIdentity): void {
  const files = relativeFiles.map((file) => portablePath(file, "selected file"));
  unique(files, "selected file");
  if (!sameSet(files, context.job.files.map((file) => file.path))) throw new Error("matrix selected/prerequisite file inventory mismatch");
  for (const key of ["platform", "architecture", "backend"] as const) {
    if (actual[key] !== context.job[key]) throw new Error(`matrix runtime ${key} mismatch`);
  }
}

export function validateMatrixSelection(
  context: TestMatrixContext, relativeFiles: readonly string[], runtimeIdentity: TestMatrixRuntimeIdentity,
): void {
  const saved = contexts.get(context);
  if (!saved) throw new Error("matrix context was not loaded by loadTestMatrixJob");
  const actual = runtime(runtimeIdentity);
  validateSelection(context, relativeFiles, actual);
  if (saved.selection && (
    !sameSet(saved.selection, relativeFiles) || JSON.stringify(saved.runtimeIdentity) !== JSON.stringify(actual)
  )) throw new Error("matrix pre-dispatch identity cannot be replaced");
  saved.selection = [...relativeFiles];
  saved.runtimeIdentity = actual;
}

function effectiveGates(input: Record<string, unknown>): EffectiveGates {
  return Object.fromEntries(TEST_MATRIX_LIVE_GATES.map((key) => {
    const value = input[key];
    return [key, value == null ? null : value === "0" || value === "1" ? value : "invalid"];
  })) as EffectiveGates;
}
function gateErrors(job: TestMatrixJob, gates: EffectiveGates): string[] {
  return [
    ...Object.entries(gates).filter(([, value]) => value === "invalid").map(([key]) => `invalid effective live gate: ${key}`),
    ...Object.entries(job.gates ?? {}).flatMap(([key, expected]) =>
      gates[key as AllowedLiveGate] === expected ? [] : [`matrix expected live gate mismatch: ${key}`]),
  ];
}
function containedFile(root: string, path: string): Buffer {
  const name = portablePath(path, "JUnit path");
  let current = root;
  for (const part of name.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("JUnit path must not traverse a symlink");
  }
  if (!lstatSync(current).isFile()) throw new Error("JUnit evidence must be a regular file");
  return readFileSync(current);
}
function collectFile(stamp: string, input: TestMatrixReceiptInput["files"][number], expected: TestMatrixFile | undefined): TestMatrixReceiptFile {
  const file = portablePath(input.file, "receipt file");
  const errors: string[] = [];
  let junitPath: string | null = null;
  try { junitPath = portablePath(input.junitPath, "JUnit path"); }
  catch { errors.push("JUnit path is missing or is not a contained relative POSIX path"); }
  let state: TestMatrixFileState = "ERROR";
  try { state = choice<TestMatrixFileState>(input.state, fileStates, "file state"); }
  catch { errors.push("invalid file execution state"); }
  const evidenceComplete = input.evidenceComplete === true;
  if (typeof input.evidenceComplete !== "boolean") errors.push("invalid file evidenceComplete value");
  let junitSha256: string | null = null;
  let observed: JUnitTestCase[] = [];
  let xmlComplete = false;
  try {
    if (!junitPath) throw new Error("no JUnit path");
    const bytes = containedFile(stamp, junitPath);
    junitSha256 = hash(bytes);
    const parsed = readJUnitEvidence(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (parsed.complete) { observed = parsed.testcases; xmlComplete = true; }
    else errors.push(parsed.error);
  } catch {
    errors.push("JUnit evidence is missing, inaccessible, escaping, or not valid UTF-8");
  }
  if (!expected) errors.push("unplanned file");
  else if (!sameSet(expected.cases.map(caseKey), observed.map(caseKey))) errors.push("JUnit testcase inventory mismatch");
  for (const testcase of observed) {
    if (testcase.file !== undefined) {
      const declared = testcase.file.replaceAll("\\", "/").replace(/^\.\//, "");
      const absolute = isAbsolute(declared) || win32.isAbsolute(declared);
      if (declared !== file && !(absolute && declared.endsWith(`/${file}`))) {
        errors.push("JUnit declares a different source file");
      }
    }
  }
  if (!evidenceComplete) errors.push("caller reports incomplete file evidence");
  if (state !== "PASS") errors.push(`file state is ${state}`);
  if (observed.some((testcase) => testcase.outcome !== "PASS")) errors.push("JUnit contains failed or skipped cases");
  return { file, junitPath, junitSha256, state, evidenceComplete, xmlComplete, cases: observed, errors };
}

/** Seal once. Evidence errors are recorded as FAIL; an unpublishable receipt throws. */
export function writeTestMatrixReceipt(context: TestMatrixContext, input: TestMatrixReceiptInput): {
  receiptPath: string; receipt: TestMatrixReceipt;
} {
  const saved = contexts.get(context);
  if (!saved) throw new Error("matrix context was not loaded by loadTestMatrixJob");
  const errors: string[] = [];
  try { errors.push(...strings(input.errors, "run errors")); }
  catch { errors.push("invalid run error metadata"); }
  let actual: TestMatrixRuntimeIdentity;
  try { actual = runtime(input.runtimeIdentity); }
  catch {
    actual = { platform: process.platform, architecture: process.arch, backend: "none", bunVersion: Bun.version };
    errors.push("invalid runtime identity; sealing host identity recorded without backend proof");
  }
  let runStatus: TestMatrixRunStatus = "ERROR";
  try { runStatus = choice<TestMatrixRunStatus>(input.runStatus, runStates, "run status"); }
  catch { errors.push("invalid run finalization status"); }
  let gateInput: Record<string, unknown> = {};
  try { gateInput = object(input.gates, "effective gates"); }
  catch { errors.push("invalid effective gate metadata"); }
  const gates = effectiveGates(gateInput);
  const inputFiles = Array.isArray(input.files) ? input.files : [];
  if (!Array.isArray(input.files)) errors.push("invalid file evidence inventory");
  if (!saved.selection || JSON.stringify(saved.runtimeIdentity) !== JSON.stringify(actual)) {
    errors.push("matrix pre-dispatch selection/runtime validation is missing or changed");
  }
  try { validateSelection(context, inputFiles.map((file) => file.file), actual); }
  catch (error) { errors.push(errorText(error)); }
  errors.push(...gateErrors(context.job, gates));
  mkdirSync(input.stampDir, { recursive: true });
  const stamp = realpathSync(input.stampDir);
  const receiptPath = join(stamp, "test-matrix-receipt.json");
  if (!testSourceOutputIsExcluded(context.root, receiptPath)) {
    throw new Error("matrix receipts must be outside authored source or in a Git-ignored output directory");
  }
  const files: TestMatrixReceiptFile[] = [];
  for (const file of inputFiles) {
    try { files.push(collectFile(stamp, file, context.job.files.find((planned) => planned.path === file.file))); }
    catch { errors.push("invalid file evidence entry"); }
  }
  const junitPaths = files.flatMap((file) => file.junitPath === null ? [] : [file.junitPath]);
  if (new Set(junitPaths).size !== junitPaths.length) errors.push("JUnit path reused for multiple files");
  for (const file of files) errors.push(...file.errors.map((error) => `${file.file}: ${error}`));
  let sourceAfterDigest: string | null = null;
  try { sourceAfterDigest = captureTestSource(context.root).sourceDigest; }
  catch { errors.push("source identity could not be captured at sealing"); }
  const sourceUnchanged = sourceAfterDigest === context.source.sourceDigest;
  if (!sourceUnchanged) errors.push("matrix source changed during run");
  let planUnchanged = false;
  try { planUnchanged = hash(readFileSync(context.planPath)) === context.planDigest; }
  catch { /* The failure is recorded below. */ }
  if (!planUnchanged) errors.push("matrix plan changed during run");
  if (runStatus !== "PASS") errors.push(`run finalization is ${runStatus}`);
  const receipt: TestMatrixReceipt = {
    version: 1, cohortId: context.plan.cohortId,
    sourceDigest: context.source.sourceDigest, sourceAfterDigest, sourceUnchanged,
    planDigest: context.planDigest, planUnchanged,
    jobId: context.job.id, stamp: basename(stamp), runtimeIdentity: actual, gates,
    effectiveInventory: files.map((file) => ({
      path: file.file, cases: file.cases.map(({ classname, name }) => ({ classname, name })),
    })),
    files, runStatus, status: errors.length === 0 ? "PASS" : "FAIL", errors,
  };
  const temporary = join(stamp, `.test-matrix-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    linkSync(temporary, receiptPath); // Atomic publication that cannot replace an earlier failure.
  } finally {
    try { unlinkSync(temporary); } catch { /* Creation itself may have failed. */ }
  }
  return { receiptPath, receipt };
}

function parseReceipt(value: unknown): TestMatrixReceipt {
  const row = object(value, "matrix receipt");
  keys(row, ["version", "cohortId", "sourceDigest", "sourceAfterDigest", "sourceUnchanged",
    "planDigest", "planUnchanged", "jobId", "stamp", "runtimeIdentity", "gates",
    "effectiveInventory", "files", "runStatus", "status", "errors"], "matrix receipt");
  if (row.version !== 1) throw new Error("unsupported matrix receipt version");
  const gateObject = object(row.gates, "receipt gates");
  keys(gateObject, [...TEST_MATRIX_LIVE_GATES], "receipt gates");
  for (const value of Object.values(gateObject)) {
    if (value !== null) choice(value, ["0", "1", "invalid"], "effective gate");
  }
  const files = list(row.files, "receipt files", false).map((value) => {
    const f = object(value, "receipt file");
    keys(f, ["file", "junitPath", "junitSha256", "state", "evidenceComplete", "xmlComplete", "cases", "errors"], "receipt file");
    return {
      file: portablePath(f.file, "receipt file"), junitPath: f.junitPath === null ? null : portablePath(f.junitPath, "JUnit path"),
      junitSha256: f.junitSha256 === null ? null : digest(f.junitSha256, "JUnit digest"),
      state: choice<TestMatrixFileState>(f.state, fileStates, "file state"),
      evidenceComplete: bool(f.evidenceComplete, "file evidenceComplete"),
      xmlComplete: bool(f.xmlComplete, "xmlComplete"),
      cases: cases(f.cases, "receipt cases", true, false), errors: strings(f.errors, "file errors"),
    };
  });
  unique(files.map((file) => file.file), "receipt file");
  unique(files.flatMap((file) => file.junitPath === null ? [] : [file.junitPath]), "JUnit path");
  return {
    version: 1, cohortId: text(row.cohortId, "receipt cohortId"),
    sourceDigest: digest(row.sourceDigest, "receipt sourceDigest"),
    sourceAfterDigest: row.sourceAfterDigest === null ? null : digest(row.sourceAfterDigest, "sourceAfterDigest"),
    sourceUnchanged: bool(row.sourceUnchanged, "sourceUnchanged"),
    planDigest: digest(row.planDigest, "receipt planDigest"), planUnchanged: bool(row.planUnchanged, "planUnchanged"),
    jobId: text(row.jobId, "receipt jobId"), stamp: text(row.stamp, "receipt stamp"),
    runtimeIdentity: runtime(row.runtimeIdentity), gates: effectiveGates(gateObject),
    effectiveInventory: inventory(row.effectiveInventory, "effectiveInventory", false),
    files, runStatus: choice(row.runStatus, runStates, "run status"),
    status: choice(row.status, ["PASS", "FAIL"], "receipt status"), errors: strings(row.errors, "receipt errors"),
  };
}

export interface TestMatrixObligation extends TestMatrixCase {
  jobId: string; platform: NodeJS.Platform; architecture: string; backend: TestMatrixBackend; file: string;
  status: "FULFILLED" | "FAILED" | "MISSING-INCOMPLETE" | "NOT_REQUESTED";
  reasons: string[];
  evidence: Array<{ receipt: string; junitPath?: string; junitSha256?: string | null; outcome?: string }>;
}
export interface TestMatrixReport {
  version: 1; cohortId: string; sourceDigest: string; planDigest: string;
  profile?: string; status: "PASS" | "FAIL"; complete: boolean; errors: string[];
  obligations: TestMatrixObligation[];
}

/** Recheck artifacts offline. Every submitted attempt is considered; no last-pass-wins policy. */
export function reconcileTestMatrix(planPath: string, receiptPaths: readonly string[]): TestMatrixReport {
  const { plan, planDigest } = readPlan(planPath);
  const errors: string[] = [];
  type Attempt = {
    path: string; hash: string; receipt: TestMatrixReceipt; identityErrors: string[];
    files: Map<string, TestMatrixReceiptFile>;
  };
  const attempts = new Map<string, Attempt[]>();
  for (const inputPath of receiptPaths) {
    const path = resolve(inputPath);
    try {
      const bytes = readFileSync(path);
      const receipt = parseReceipt(decodeJSON(bytes, "matrix receipt"));
      const expected = plan.jobs.find((job) => job.id === receipt.jobId);
      if (!expected) throw new Error("receipt has an unrequested job id");
      const identityErrors: string[] = [];
      if (receipt.cohortId !== plan.cohortId) identityErrors.push("cohort mismatch");
      if (receipt.planDigest !== planDigest || !receipt.planUnchanged) identityErrors.push("plan digest changed or mismatched");
      if (receipt.sourceDigest !== plan.sourceDigest || receipt.sourceAfterDigest !== plan.sourceDigest || !receipt.sourceUnchanged) {
        identityErrors.push("source identity changed or mismatched");
      }
      for (const key of ["platform", "architecture", "backend"] as const) {
        if (receipt.runtimeIdentity[key] !== expected[key]) identityErrors.push(`runtime ${key} mismatch`);
      }
      identityErrors.push(...gateErrors(expected, receipt.gates));
      if (!sameSet(receipt.files.map((file) => file.file), expected.files.map((file) => file.path))) {
        identityErrors.push("effective file inventory mismatch");
      }
      const files = new Map<string, TestMatrixReceiptFile>();
      const stamp = realpathSync(dirname(path));
      for (const file of receipt.files) {
        const observed = collectFile(stamp, file, expected.files.find((entry) => entry.path === file.file));
        if (observed.junitSha256 !== file.junitSha256) observed.errors.push("JUnit digest mismatch");
        if (observed.xmlComplete !== file.xmlComplete || JSON.stringify(observed.cases) !== JSON.stringify(file.cases)) {
          observed.errors.push("receipt testcase observations disagree with JUnit");
        }
        observed.errors.push(...file.errors);
        files.set(file.file, observed);
      }
      const recordedInventory = receipt.files.map((file) => ({
        path: file.file, cases: file.cases.map(({ classname, name }) => ({ classname, name })),
      }));
      if (JSON.stringify(receipt.effectiveInventory) !== JSON.stringify(recordedInventory)) {
        identityErrors.push("effective case inventory disagrees with receipt files");
      }
      const attempt = { path, hash: hash(bytes), receipt, identityErrors, files };
      attempts.set(expected.id, [...(attempts.get(expected.id) ?? []), attempt]);
      errors.push(...identityErrors.map((error) => `${expected.id}: ${error}`));
      errors.push(...receipt.errors.map((error) => `${expected.id}: ${error}`));
      for (const file of files.values()) errors.push(...file.errors.map((error) => `${expected.id}/${file.file}: ${error}`));
      if (receipt.status !== "PASS" || receipt.runStatus !== "PASS") errors.push(`${expected.id}: receipt finalization is not PASS`);
    } catch (error) {
      errors.push(`${path}: ${errorText(error)}`);
    }
  }
  const obligations: TestMatrixObligation[] = [];
  for (const job of plan.jobs) {
    const received = attempts.get(job.id) ?? [];
    const conflict = new Set(received.map((attempt) => attempt.hash)).size > 1;
    if (conflict) errors.push(`${job.id}: conflicting duplicate receipts`);
    for (const file of job.files) {
      for (const testcase of file.cases) {
        const row: TestMatrixObligation = {
          jobId: job.id, platform: job.platform, architecture: job.architecture, backend: job.backend,
          file: file.path, ...testcase, status: "FULFILLED", reasons: [], evidence: [],
        };
        const fail = (status: "FAILED" | "MISSING-INCOMPLETE", reason: string) => {
          if (row.status !== "FAILED") row.status = status;
          row.reasons.push(reason);
        };
        if (received.length === 0) fail("MISSING-INCOMPLETE", "no receipt for required job");
        if (conflict) fail("FAILED", "conflicting duplicate receipts");
        for (const attempt of received) {
          const observed = attempt.files.get(file.path);
          const actual = observed?.cases.find((entry) => caseKey(entry) === caseKey(testcase));
          row.evidence.push({
            receipt: attempt.path,
            ...(observed ? {
              ...(observed.junitPath ? { junitPath: join(dirname(attempt.path), observed.junitPath) } : {}),
              junitSha256: observed.junitSha256,
            } : {}),
            ...(actual ? { outcome: actual.outcome } : {}),
          });
          if (actual?.outcome === "FAIL") fail("FAILED", "JUnit assertion/setup failure");
          if (attempt.identityErrors.length) fail("MISSING-INCOMPLETE", attempt.identityErrors.join("; "));
          if (!observed || !actual || actual.outcome === "SKIP" || !observed.xmlComplete || !observed.evidenceComplete) {
            fail("MISSING-INCOMPLETE", "required testcase evidence is missing, incomplete, or skipped");
          } else if (observed.errors.length || observed.state !== "PASS") {
            fail("FAILED", "file evidence failed validation or execution");
          }
          if (attempt.receipt.status !== "PASS" || attempt.receipt.runStatus !== "PASS" || attempt.receipt.errors.length) {
            if (row.status === "FULFILLED") fail("FAILED", "run finalization is not PASS");
          }
        }
        obligations.push(row);
      }
    }
  }
  for (const job of plan.profile?.notRequested ?? []) {
    for (const file of job.files) for (const testcase of file.cases) obligations.push({
      jobId: job.id, platform: job.platform, architecture: job.architecture, backend: job.backend,
      file: file.path, ...testcase, status: "NOT_REQUESTED", reasons: [job.reason], evidence: [],
    });
  }
  const complete = errors.length === 0 && obligations.every((row) =>
    row.status === "FULFILLED" || row.status === "NOT_REQUESTED");
  return {
    version: 1, cohortId: plan.cohortId, sourceDigest: plan.sourceDigest, planDigest,
    ...(plan.profile ? { profile: plan.profile.name } : {}),
    status: complete ? "PASS" : "FAIL", complete, errors: [...new Set(errors)], obligations,
  };
}
