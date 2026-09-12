import { aidlcInvocation, runtimeHarnessDir } from "./aidlc-runtime-paths.ts";

// These are domain operations, not shell programs. Owning commands retain their
// own checks; rendering an operation does not authenticate human selection.
// The conductor must obtain that selection before executing a human remedy.
// A recovery operation cannot approve a plan, record a verdict, or invent feedback.
export type GuardRecoveryOperation =
  | { kind: "restart-stage"; stage: string }
  | { kind: "abort-bolt"; unit: string; slug: string };

export type GuardRecoveryInteraction = "command" | "human-input" | "external-work";

export interface GuardOperationInvocation {
  route: "orchestrate" | "bolt";
  args: string[];
}

function identifier(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
}

export function isGuardRecoveryOperation(value: unknown): value is GuardRecoveryOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  if (operation.kind === "restart-stage") {
    return Object.keys(operation).length === 2 && identifier(operation.stage);
  }
  if (operation.kind === "abort-bolt") {
    return Object.keys(operation).length === 3 &&
      identifier(operation.unit) && identifier(operation.slug);
  }
  return false;
}

export function guardOperationInvocation(operation: GuardRecoveryOperation): GuardOperationInvocation {
  if (!isGuardRecoveryOperation(operation)) throw new Error("Invalid guard recovery operation");
  if (operation.kind === "restart-stage") {
    return { route: "orchestrate", args: ["next", "--stage", operation.stage] };
  }
  return {
    route: "bolt",
    args: [
      "abort", "--name", operation.unit, "--slug", operation.slug,
      "--reason", "stale review recovery exhausted", "--discard",
    ],
  };
}

function quoteArgument(value: string, shell: "posix" | "powershell"): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return shell === "powershell"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function renderGuardOperation(
  operation: GuardRecoveryOperation,
  options: {
    mode?: "source" | "native";
    harnessDir?: string;
    shell?: "posix" | "powershell";
  } = {},
): string {
  const invocation = guardOperationInvocation(operation);
  const mode = options.mode ?? (aidlcInvocation().startsWith("bun ") ? "source" : "native");
  const shell = options.shell ?? (process.platform === "win32" ? "powershell" : "posix");
  const harness = options.harnessDir ?? runtimeHarnessDir();
  if (!/^\.[A-Za-z0-9_.-]+$/.test(harness)) throw new Error("Invalid recovery harness directory");
  const prefix = mode === "native"
    ? `aidlc engine ${invocation.route}`
    : `bun ${harness}/tools/aidlc-${invocation.route}.ts`;
  return `${prefix} ${invocation.args.map((arg) => quoteArgument(arg, shell)).join(" ")}`;
}

// Validate display commands against the same operation that constructs them.
// This is deliberately not a general shell parser: wrappers, redirections,
// additional flags and trailing commands cannot become part of a remedy.
export function guardOperationMatchesCommand(
  operation: GuardRecoveryOperation,
  command: string,
): boolean {
  if (!isGuardRecoveryOperation(operation)) return false;
  const source = /^bun (\.[A-Za-z0-9_.-]+)\/tools\/aidlc-(?:orchestrate|bolt)\.ts /.exec(command);
  for (const shell of ["posix", "powershell"] as const) {
    if (command === renderGuardOperation(operation, { mode: "native", shell })) return true;
    if (source && command === renderGuardOperation(operation, {
      mode: "source", harnessDir: source[1], shell,
    })) return true;
  }
  return false;
}

export function guardOperationMatchesRemedy(
  operation: GuardRecoveryOperation,
  remedy: string,
  stage: string,
  unit?: string,
): boolean {
  if (!isGuardRecoveryOperation(operation)) return false;
  return operation.kind === "restart-stage"
    ? ["restart-stage", "redo-jump", "restore-or-jump"].includes(remedy) &&
      operation.stage === stage
    : remedy === "abort-bolt" && operation.unit === unit;
}

export function sameGuardOperation(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!isGuardRecoveryOperation(left) || !isGuardRecoveryOperation(right)) return false;
  return left.kind === "restart-stage"
    ? right.kind === "restart-stage" && left.stage === right.stage
    : right.kind === "abort-bolt" && left.unit === right.unit && left.slug === right.slug;
}

export interface GuardRestartContinuation {
  operation: Extract<GuardRecoveryOperation, { kind: "restart-stage" }>;
  direction: "redo" | "backward";
  scope: string;
}

// next --stage returns this second command to perform the reset. Match the
// complete native command, not a shell invocation extracted from a larger
// program: wrappers, redirections, extra commands and flags are not a reset.
// The hook separately checks the human selection and resolves the direction
// against the current effective plan before admitting this continuation.
export function parseGuardRestartContinuationCommand(
  command: string,
): GuardRestartContinuation | null {
  const [executable, ...args] = command.split(" ");
  if (
    (executable !== "aidlc" && executable !== "aidlc.exe") ||
    args.length !== 9 ||
    args[0] !== "engine" || args[1] !== "jump" || args[2] !== "execute" ||
    args[3] !== "--target" || !identifier(args[4]) ||
    args[5] !== "--direction" || (args[6] !== "redo" && args[6] !== "backward") ||
    args[7] !== "--scope" || !identifier(args[8])
  ) return null;
  return {
    operation: { kind: "restart-stage", stage: args[4] },
    direction: args[6],
    scope: args[8],
  };
}

// Native Plan Approval admission uses the same argv as remedy rendering. This
// matches the existing trusted source-tool route, NOT a recorded-choice check:
// direct log review refusals print an abort ask through guardRefusalOutput,
// which records the refusal but does not publish an active directive. Requiring
// a consumed marker here would strand that offered recovery after human approval.
// The conductor owns the abort's human selection; the hook admits only this
// fully specified native abort, without granting Plan Approval or exempting any
// other Bolt subcommand or extra argument. Native restart continuations have a
// separate marker-bound check because the orchestrator publishes their asks.
export function isGuardRecoveryEngineInvocation(args: readonly string[]): boolean {
  if (args[0] !== "engine" || args[1] !== "bolt" || args.length !== 10) return false;
  const operation: GuardRecoveryOperation = { kind: "abort-bolt", unit: args[4], slug: args[6] };
  if (!isGuardRecoveryOperation(operation)) return false;
  const expected = ["engine", "bolt", ...guardOperationInvocation(operation).args];
  return expected.length === args.length && expected.every((value, index) => value === args[index]);
}
