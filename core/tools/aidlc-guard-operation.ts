import { isSwitchableGuardFence, type SwitchableGuardFence } from "./aidlc-guard-fences.ts";
import { aidlcInvocation, runtimeHarnessDir } from "./aidlc-runtime-paths.ts";

// These are domain operations, not shell programs. Owning commands retain their
// own checks; rendering an operation does not authenticate human selection.
// The conductor must obtain that selection before executing a human remedy.
// A recovery operation cannot approve a plan, record a verdict, or invent feedback.
export type GuardRecoveryOperation =
  | { kind: "restart-stage"; stage: string }
  | { kind: "abort-bolt"; unit: string; slug: string }
  // The switchable set is the source of truth for fence recovery operations.
  // unit is null for a stage-level plan (--stage-level).
  | { kind: "lower-fence"; fence: SwitchableGuardFence }
  | { kind: "reapprove-plan"; unit: string | null }
  | { kind: "show-plan-drift"; unit: string | null };

export type GuardRecoveryInteraction = "command" | "human-input" | "external-work";

export interface GuardOperationInvocation extends EngineInvocation {
  route: "orchestrate" | "bolt" | "testing-posture" | "config";
  args: string[];
  // Source installs run bun <harness>/tools/aidlc-<route>.ts <args>, so route is
  // also the tool stem. The fence switch breaks that: its native route is config
  // (aidlc engine config set guard.<fence> off), which handleConfig in aidlc.ts
  // translates onto aidlc-utility.ts config-change --guard.<fence> off. There is
  // no aidlc-config.ts, and the argv differs too, so a tool-name field alone
  // would not suffice. Routing source installs through aidlc.ts engine config
  // was rejected: the plan-approval hook trusts direct aidlc-*.ts tools but gives
  // the unified entry point only the planning exceptions. An invocation may
  // therefore carry its own source spelling, whose route is the source tool
  // stem. The renderer uses it in source mode and the native route otherwise.
  // Omitted when source tool name and argv match the native route (orchestrate,
  // bolt, testing-posture).
  source?: EngineInvocation;
}

export interface EngineInvocation {
  route: string;
  args: readonly string[];
}

type InvocationRenderOptions = {
  mode?: "source" | "native";
  harnessDir?: string;
  shell?: "posix" | "powershell";
};

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
  if (operation.kind === "lower-fence") {
    return Object.keys(operation).length === 2 && isSwitchableGuardFence(operation.fence);
  }
  if (operation.kind === "reapprove-plan" || operation.kind === "show-plan-drift") {
    return Object.keys(operation).length === 2 &&
      (operation.unit === null || identifier(operation.unit));
  }
  return false;
}

export function guardOperationInvocation(operation: GuardRecoveryOperation): GuardOperationInvocation {
  if (!isGuardRecoveryOperation(operation)) throw new Error("Invalid guard recovery operation");
  switch (operation.kind) {
    case "restart-stage":
      return { route: "orchestrate", args: ["next", "--stage", operation.stage] };
    case "abort-bolt":
      return {
        route: "bolt",
        args: [
          "abort", "--name", operation.unit, "--slug", operation.slug,
          "--reason", "stale review recovery exhausted", "--discard",
        ],
      };
    case "lower-fence": {
      // The guard. prefix is the config-key spelling owned by guardFenceConfigKey
      // in aidlc-guard-fences.ts; recovery operations never import aidlc-lib.ts.
      const key = `guard.${operation.fence}`;
      return {
        route: "config",
        args: ["set", key, "off"],
        source: { route: "utility", args: ["config-change", `--${key}`, "off"] },
      };
    }
    case "reapprove-plan":
      // --reapprove withdraws the approval the drift invalidated, so the
      // command succeeds on its first attempt.
      return {
        route: "testing-posture",
        args: ["fingerprint", ...planTarget(operation.unit), "--reapprove"],
      };
    case "show-plan-drift":
      return { route: "testing-posture", args: ["verify", ...planTarget(operation.unit)] };
  }
}

function planTarget(unit: string | null): string[] {
  return unit === null ? ["--stage-level"] : ["--unit", unit];
}

function quoteArgument(value: string, shell: "posix" | "powershell"): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return shell === "powershell"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function defaultInvocationMode(): "source" | "native" {
  return aidlcInvocation().startsWith("bun ") ? "source" : "native";
}

export function renderGuardOperation(
  operation: GuardRecoveryOperation,
  options: InvocationRenderOptions = {},
): string {
  const invocation = guardOperationInvocation(operation);
  const mode = options.mode ?? defaultInvocationMode();
  return renderEngineInvocation(
    mode === "source" && invocation.source ? invocation.source : invocation,
    { ...options, mode },
  );
}

export function renderEngineInvocation(
  invocation: EngineInvocation,
  options: InvocationRenderOptions = {},
): string {
  const mode = options.mode ?? defaultInvocationMode();
  const shell = options.shell ?? (process.platform === "win32" ? "powershell" : "posix");
  const harness = options.harnessDir ?? runtimeHarnessDir();
  if (!/^\.[A-Za-z0-9_.-]+$/.test(harness)) throw new Error("Invalid recovery harness directory");
  const prefix = mode === "native"
    ? `aidlc engine ${quoteArgument(invocation.route, shell)}`
    : `bun ${quoteArgument(`${harness}/tools/aidlc-${invocation.route}.ts`, shell)}`;
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
  // The tool stem is not pinned here: the exact comparison below renders the
  // operation's own source tool, so any other stem fails equality.
  const source = /^bun (\.[A-Za-z0-9_.-]+)\/tools\/aidlc-[A-Za-z0-9_-]+\.ts /.exec(command);
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
  switch (operation.kind) {
    case "restart-stage":
      return ["restart-stage", "redo-jump", "restore-or-jump"].includes(remedy) &&
        operation.stage === stage;
    case "abort-bolt":
      return remedy === "abort-bolt" && operation.unit === unit;
    case "lower-fence":
      return remedy === "lower-fence";
    case "reapprove-plan":
      return remedy === "reapprove-plan" && operation.unit === (unit ?? null);
    case "show-plan-drift":
      return remedy === "show-plan-drift" && operation.unit === (unit ?? null);
  }
}

export function sameGuardOperation(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!isGuardRecoveryOperation(left) || !isGuardRecoveryOperation(right)) return false;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "restart-stage":
      return left.stage === (right as typeof left).stage;
    case "abort-bolt":
      return left.unit === (right as typeof left).unit &&
        left.slug === (right as typeof left).slug;
    case "lower-fence":
      return left.fence === (right as typeof left).fence;
    case "reapprove-plan":
    case "show-plan-drift":
      return left.unit === (right as typeof left).unit;
  }
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
// direct refusals print an abort or fence-switch ask through guardRefusalOutput,
// which records the refusal but does not publish an active directive. The strict
// drift refusal in aidlc-plan-approval-guard.ts is one. Requiring a consumed marker
// here would strand that offered recovery after human approval.
// Conductor-prose-obtained abort consent remains the trust boundary; a mistaken
// abort --discard parks work for aidlc engine worktree restore --slug <slug>.
// A mechanical selection receipt remains a future candidate, not a check here.
// Source installs already trust the equivalent aidlc-utility.ts config-change
// invocation, so admitting the exact native `config set guard.<fence> off` is
// native parity, not a new capability; `on`, extra arguments and other keys are
// not admitted. The hook admits only the fully specified native abort and fence
// switch, without granting Plan Approval or exempting any other subcommand.
// Native restart continuations have a separate marker-bound check because the
// orchestrator publishes their asks.
export function isGuardRecoveryEngineInvocation(args: readonly string[]): boolean {
  if (args[0] !== "engine") return false;
  let operation: GuardRecoveryOperation;
  if (args[1] === "bolt" && args.length === 10) {
    operation = { kind: "abort-bolt", unit: args[4], slug: args[6] };
  } else if (
    args[1] === "config" && args.length === 5 &&
    typeof args[3] === "string" && args[3].startsWith("guard.")
  ) {
    const fence = args[3].slice("guard.".length);
    if (!isSwitchableGuardFence(fence)) return false;
    operation = { kind: "lower-fence", fence };
  } else {
    return false;
  }
  if (!isGuardRecoveryOperation(operation)) return false;
  const invocation = guardOperationInvocation(operation);
  const expected = ["engine", invocation.route, ...invocation.args];
  return expected.length === args.length && expected.every((value, index) => value === args[index]);
}
