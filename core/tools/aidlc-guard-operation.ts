import { isSwitchableGuardFence, type SwitchableGuardFence } from "./aidlc-guard-fences.ts";
import {
  aidlcInvocation,
  quoteCommandArgument,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";

// These are domain operations, not shell programs. Owning commands retain their
// own checks; rendering an operation does not authenticate human selection.
// The conductor must obtain that selection before executing a human remedy.
// A recovery operation cannot approve a plan, record a verdict, or invent feedback.
export type GuardRecoveryOperation =
  | { kind: "restart-stage"; stage: string }
  | { kind: "abort-bolt"; unit: string; slug: string }
  // The switchable set is the source of truth for fence recovery operations.
  | { kind: "lower-fence"; fence: SwitchableGuardFence }
  // Records the Unit's missing UNIT_COMPLETED receipt from artifacts already on
  // disk; the state tool checks them and the open ask before it writes.
  | { kind: "record-unit-completion"; stage: string; unit: string }
  // Starts one Unit's step of a solo unit-major walk again: a new attempt for
  // that Unit and stage only, the record a Unit checkpoint's Request Changes
  // writes. Every other Unit keeps its finished work.
  | { kind: "reopen-unit"; stage: string; unit: string }
  // Sets this work's reviews to advisory, so the reviewer's open findings go to
  // the approval gate for the person instead of another review pass.
  | { kind: "review-advisory" };

export type GuardRecoveryInteraction = "command" | "human-input" | "external-work";

export interface GuardOperationInvocation extends EngineInvocation {
  route: "orchestrate" | "bolt" | "config" | "state" | "jump";
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
  // bolt).
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
  if (operation.kind === "review-advisory") return Object.keys(operation).length === 1;
  if (operation.kind === "record-unit-completion" || operation.kind === "reopen-unit") {
    return Object.keys(operation).length === 3 &&
      identifier(operation.stage) && identifier(operation.unit);
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
    case "record-unit-completion":
      return {
        route: "state",
        args: ["unit", "complete", "--stage", operation.stage, "--unit", operation.unit],
      };
    case "reopen-unit":
      return {
        route: "jump",
        args: ["reopen", "--target", operation.stage, "--units", operation.unit],
      };
    case "review-advisory":
      return {
        route: "config",
        args: ["set", "review", "advisory"],
        source: { route: "utility", args: ["config-change", "--review", "advisory"] },
      };
  }
}

const quoteArgument = quoteCommandArgument;

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
    case "record-unit-completion":
      return remedy === "record-unit-completion" && operation.stage === stage &&
        operation.unit === unit;
    case "reopen-unit":
      return remedy === "reopen-unit-step" && operation.stage === stage &&
        operation.unit === unit;
    case "review-advisory":
      return remedy === "review-advisory-gate";
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
    case "record-unit-completion":
    case "reopen-unit":
      return left.stage === (right as typeof left).stage &&
        left.unit === (right as typeof left).unit;
    case "review-advisory":
      return true;
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
// A source install prints the same continuation as
// `bun <harness>/tools/aidlc-jump.ts execute ...`; pass that harness directory
// to accept it. Any other script path, or a harness directory not passed, is not a reset.
export function parseGuardRestartContinuationCommand(
  command: string,
  options: { harnessDir?: string } = {},
): GuardRestartContinuation | null {
  const [executable, ...words] = command.split(" ");
  let args: string[];
  if ((executable === "aidlc" || executable === "aidlc.exe") &&
    words[0] === "engine" && words[1] === "jump") {
    args = words.slice(2);
  } else if (
    executable === "bun" && options.harnessDir !== undefined &&
    words[0] === `${options.harnessDir}/tools/aidlc-jump.ts`
  ) {
    args = words.slice(1);
  } else {
    return null;
  }
  if (
    args.length !== 7 ||
    args[0] !== "execute" ||
    args[1] !== "--target" || !identifier(args[2]) ||
    args[3] !== "--direction" || (args[4] !== "redo" && args[4] !== "backward") ||
    args[5] !== "--scope" || !identifier(args[6])
  ) return null;
  return {
    operation: { kind: "restart-stage", stage: args[2] },
    direction: args[4],
    scope: args[6],
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
  } else if (
    args[1] === "utility" && args.length === 5 && args[2] === "config-change" &&
    typeof args[3] === "string" && args[3].startsWith("--guard.")
  ) {
    const fence = args[3].slice("--guard.".length);
    if (!isSwitchableGuardFence(fence)) return false;
    operation = { kind: "lower-fence", fence };
  } else {
    return false;
  }
  if (!isGuardRecoveryOperation(operation)) return false;
  return guardOperationMatchesEngineArgs(operation, args);
}

// The operation's own argv, in its native route or its source-tool spelling,
// as `engine <route> <args>`. Exact: no extra flag, value, or trailing word.
export function guardOperationMatchesEngineArgs(
  operation: GuardRecoveryOperation,
  args: readonly string[],
): boolean {
  if (!isGuardRecoveryOperation(operation)) return false;
  const invocation = guardOperationInvocation(operation);
  return [invocation, ...(invocation.source ? [invocation.source] : [])].some((spelling) => {
    const expected = ["engine", spelling.route, ...spelling.args];
    return expected.length === args.length &&
      expected.every((value, index) => value === args[index]);
  });
}

export interface GuardRemedyWordingContext {
  code: string;
  // The stage's plain name, and with its Unit ("Code Generation for beta").
  stage: string;
  target: string;
  unit?: string;
  fence?: SwitchableGuardFence;
  sourceUnbindable: boolean;
  // A solo unit-major walk: a stage-wide reset reaches every Unit's work.
  everyUnit: boolean;
}

// What the person reads for each way on put to them: a name and one line on
// what happens, never how the workflow keeps track. Only commands the person
// types are code. `null` is the conductor's own work (`external-work`), which
// it does without asking. aidlc-lib.ts checks every op has an entry.
export type GuardRemedyWording =
  | ((context: GuardRemedyWordingContext) => { label: string; description: string })
  | null;

export const GUARD_REMEDY_WORDING = {
  "present-approval-gate": (c) => ({
    label: "Decide at approval",
    description:
      `I'll bring ${c.target} to you for approval with what its review raised, instead of ` +
      "asking for another review.",
  }),
  "request-review": null,
  "start-recovery-review": null,
  "apply-repairs-then-request": null,
  "record-verdict": null,
  "retry-pending": null,
  "request-changes": (c) => ({
    label: "Request Changes",
    description: `Tell me what should change in ${c.target}, and I'll revise it.${guardResetCost(c, "reject")}`,
  }),
  "finish-revision": null,
  "redo-jump": (c) => ({
    label: "Start the stage over",
    description:
      `I'll redo ${c.stage} from the top. Your answers are kept, but you'll confirm the summary ` +
      `again and I'll save each of its documents again.${guardResetCost(c, "jump")}`,
  }),
  "restore-or-jump": (c) => ({
    label: "Reopen the approved stage",
    description: (c.sourceUnbindable
      ? `${c.stage} is already approved, but I can't check the project's source files. I'll ` +
        "reopen it and redo it from the top. To keep the approval instead, fix the list of " +
        "source folders in .aidlc-source-paths.json so the files can be checked."
      : `${c.stage} is already approved. I'll reopen it and redo it from the top. To keep the ` +
        "approval instead, put the files back the way they were when it was reviewed.") +
      guardResetCost(c, "jump"),
  }),
  "restart-stage": (c) => ({
    label: "Restart the stage",
    description:
      `I'll restart ${c.stage}. Your answers are kept, and you'll be asked to confirm them ` +
      `again.${guardResetCost(c, "jump")}`,
  }),
  "redo-unit-step": null,
  "reopen-unit-step": (c) => ({
    label: "Do this step again for the Unit",
    description:
      `I'll start ${c.stage} again for ${c.unit ?? "this Unit"} only. The other Units keep ` +
      "their finished work and approvals.",
  }),
  "review-advisory-gate": (c) => ({
    label: "Decide now",
    description:
      `I'll stop the review rounds for this piece of work and bring ${c.target} to you for ` +
      "approval with the reviewer's open points.",
  }),
  "change-scope": (c) => ({
    label: "Switch to a scope that includes it",
    description:
      `${c.stage} is not part of this work's scope (the set of stages it runs). I'll switch to a scope ` +
      "that includes it and restart it.",
  }),
  "restore-scope": () => ({
    label: "Switch to a scope with per-Unit stages",
    description:
      "This work's scope (the set of stages it runs) has no Construction stage that runs for each Unit, " +
      "so nothing can approve this Unit. I'll switch to a scope that has one and try again.",
  }),
  "abort-bolt": (c) => ({
    label: "Restart this Unit",
    description:
      `The automatic run for ${c.unit ?? "this Unit"} is stuck. I'll stop it, set its unfinished ` +
      "work aside, and start it fresh.",
  }),
  "record-unit-completion": (c) =>
    c.code === "UNIT_COMPLETION_MISSING"
      ? {
          label: "Mark this Unit finished",
          description:
            `The documents for ${c.unit ?? "this Unit"} are already in place. I'll record that it ` +
            "is finished and bring it to you for approval.",
        }
      : {
          label: "Finish with the review it has",
          description:
            `I'll finish ${c.stage} for ${c.unit ?? "this Unit"} with the review it already has. ` +
            "What the review raised comes to you when its work is up for approval.",
        },
  "repair-source-boundary": null,
  "reconfirm-summary": (c) => ({
    label: "Confirm the summary again",
    description:
      `I'll show you the current summary of your answers for ${c.target} to confirm, then save ` +
      "its documents again from it.",
  }),
  "unset-unattended": (c) => ({
    label: "Stop working unattended",
    description:
      `I'll stop working on my own and ask you what should change in ${c.target}.` +
      guardResetCost(c, "reject"),
  }),
  // The person decides; the agent runs the setter (the remedy's command), which
  // records it as set by them. So the option says what will happen.
  "lower-fence": (c) => ({
    label: "Turn this check off",
    description:
      `I'll turn ${c.fence ? `the ${checkWords(c.fence)}` : "this"} check off for this piece of work. ` +
      "It is recorded, and it comes back on for the next piece of work.",
  }),
} satisfies Record<string, GuardRemedyWording>;

// A check as the person knows it ("review freeze", "reviewer read scope"), as
// the check setter names it.
function checkWords(fence: SwitchableGuardFence): string {
  return fence.replace("reviewer-scope", "reviewer read scope").replaceAll("-", " ");
}

// What a stage-wide reset in a solo unit-major walk throws away, said in the
// line the person reads, as unitMajorResetCost says it to the conductor.
function guardResetCost(context: GuardRemedyWordingContext, reset: "jump" | "reject"): string {
  if (!context.everyUnit) return "";
  return reset === "jump"
    ? " This also throws away the work every Unit has finished, and each needs its reviews and approvals again."
    : ` This also throws away every Unit's finished ${context.stage} work, and each needs its review and approval again.`;
}
