import {
  colorEnabled,
  configureColor,
  errorLabel,
  fixLabel,
  heading,
} from "./aidlc-color.ts";

export const ROUTE_NAMESPACE_DECLARATIONS = {
  public: { trustedPrefix: false },
  engine: { trustedPrefix: true },
  system: { trustedPrefix: false },
} as const;

export type RouteNamespaceName = keyof typeof ROUTE_NAMESPACE_DECLARATIONS;

const trustedNamespaces = Object.entries(ROUTE_NAMESPACE_DECLARATIONS)
  .filter(([, declaration]) => declaration.trustedPrefix)
  .map(([namespace]) => namespace as RouteNamespaceName);

if (trustedNamespaces.length !== 1) {
  throw new Error(
    `route namespace declarations must identify exactly one trusted prefix; found ${trustedNamespaces.length}`,
  );
}

export const TRUSTED_ROUTE_NAMESPACE = trustedNamespaces[0];
export const TRUSTED_COMMAND_PREFIX = `aidlc ${TRUSTED_ROUTE_NAMESPACE}`;
export const TRUSTED_COMMAND_TOKENS = ["aidlc", TRUSTED_ROUTE_NAMESPACE] as const;
export const UNTRUSTED_ROUTE_NAMESPACES = Object.keys(ROUTE_NAMESPACE_DECLARATIONS)
  .filter((namespace) =>
    namespace !== "public" && namespace !== TRUSTED_ROUTE_NAMESPACE
  ) as RouteNamespaceName[];

export function trustedCommand(suffix = ""): string {
  return suffix ? `${TRUSTED_COMMAND_PREFIX} ${suffix}` : TRUSTED_COMMAND_PREFIX;
}

// Lightweight dispatcher grammar. aidlc-lib.ts retains the same public
// workspace helpers for methodology callers; keeping this copy in the existing
// command module avoids loading the full methodology graph at CLI startup.
export const PINNED_TOP_LEVEL_ROUTES = [
  "next",
  "continue",
  "report",
  "park",
  "team-board",
  "unit",
  "compose",
  "--claim",
  "--release",
  "--status",
  "--resume",
  "--scope",
] as const;

export const PINNED_SYSTEM_GROUPS = ["workspace-sync"] as const;

const LAUNCHER_FLAG_VALUES = new Set(["--project-dir"]);
const LAUNCHER_GLOBAL_FLAGS = new Set([
  "--json",
  "--quiet",
  "--no-color",
  "--yes",
  "--offline",
  "--verbose",
]);

export function launcherRouteUsesPin(argv: readonly string[]): boolean {
  const route: string[] = [];
  for (let index = 0; index < argv.length && route.length < 2; index++) {
    const token = argv[index];
    if (LAUNCHER_FLAG_VALUES.has(token)) {
      index++;
      continue;
    }
    if (LAUNCHER_GLOBAL_FLAGS.has(token)) continue;
    route.push(token);
  }
  const [head, noun] = route;
  if (head === "engine") {
    return Boolean(noun && noun !== "--help" && noun !== "-h");
  }
  if (head === "system") {
    return PINNED_SYSTEM_GROUPS.includes(
      noun as (typeof PINNED_SYSTEM_GROUPS)[number],
    );
  }
  return PINNED_TOP_LEVEL_ROUTES.includes(
    head as (typeof PINNED_TOP_LEVEL_ROUTES)[number],
  );
}

type DispatcherWorkspaceNoun = "intent" | "space";

const DISPATCHER_INTENT_VERBS = new Set(["list", "switch", "create"]);
const DISPATCHER_SPACE_VERBS = new Set(["list", "switch", "create"]);
const DISPATCHER_RESERVED_FUTURE = new Set([
  "archive",
  "rename",
  "show",
  "birth",
]);

export type DispatcherWorkspaceCommand =
  | { kind: "list"; noun: DispatcherWorkspaceNoun; json: boolean }
  | {
      kind: "switch";
      noun: DispatcherWorkspaceNoun;
      name: string;
      explicit: boolean;
    }
  | { kind: "create"; noun: "space"; name: string }
  | { kind: "create-intent"; noun: "intent"; rest: string[] }
  | { kind: "help"; noun: DispatcherWorkspaceNoun }
  | {
      kind: "error";
      noun: DispatcherWorkspaceNoun;
      message: string;
    }
  | { kind: "not-workspace" };

function missingDispatcherWorkspaceName(
  noun: DispatcherWorkspaceNoun,
  verb: "switch" | "create" | "space-create",
): DispatcherWorkspaceCommand {
  const usage = verb === "space-create"
    ? "space-create <name>"
    : `${noun} ${verb} <name>`;
  return {
    kind: "error",
    noun,
    message: `Usage: aidlc ${usage}`,
  };
}

function isDispatcherWorkspaceNoun(
  token: string | undefined,
): token is DispatcherWorkspaceNoun {
  return token === "intent" || token === "space";
}

export function parseDispatcherWorkspaceCommand(
  tokens: string[],
): DispatcherWorkspaceCommand {
  const head = tokens[0];
  if (head === "space-create") {
    const name = tokens[1];
    return name === undefined
      ? missingDispatcherWorkspaceName("space", "space-create")
      : { kind: "create", noun: "space", name };
  }
  if (!isDispatcherWorkspaceNoun(head)) return { kind: "not-workspace" };
  const noun = head;
  const verbOrName = tokens[1];
  if (verbOrName === undefined) return { kind: "list", noun, json: false };
  if (verbOrName === "--json") return { kind: "list", noun, json: true };
  if (verbOrName === "help" || verbOrName === "-h") {
    return { kind: "help", noun };
  }
  if (DISPATCHER_RESERVED_FUTURE.has(verbOrName)) {
    return {
      kind: "error",
      noun,
      message:
        `${noun} ${verbOrName} is reserved for a future workspace verb and is not implemented yet. ` +
        `Use ${noun} switch ${verbOrName} to select an existing record with that name.`,
    };
  }
  if (noun === "intent") {
    if (verbOrName === "list") return { kind: "list", noun, json: tokens[2] === "--json" };
    if (verbOrName === "switch") {
      const name = tokens[2];
      return name === undefined
        ? missingDispatcherWorkspaceName(noun, "switch")
        : { kind: "switch", noun, name, explicit: true };
    }
    if (verbOrName === "create") {
      return { kind: "create-intent", noun, rest: tokens.slice(2) };
    }
  }
  if (noun === "space") {
    if (verbOrName === "list") return { kind: "list", noun, json: tokens[2] === "--json" };
    if (verbOrName === "switch") {
      const name = tokens[2];
      return name === undefined
        ? missingDispatcherWorkspaceName(noun, "switch")
        : { kind: "switch", noun, name, explicit: true };
    }
    if (verbOrName === "create") {
      const name = tokens[2];
      return name === undefined
        ? missingDispatcherWorkspaceName(noun, "create")
        : { kind: "create", noun, name };
    }
  }
  if (
    (noun === "intent" && DISPATCHER_INTENT_VERBS.has(verbOrName)) ||
    (noun === "space" && DISPATCHER_SPACE_VERBS.has(verbOrName))
  ) {
    return { kind: "error", noun, message: `invalid ${noun} command` };
  }
  return { kind: "switch", noun, name: verbOrName, explicit: false };
}

export function dispatcherWorkspaceUtilityArgv(
  command: DispatcherWorkspaceCommand,
): string[] | null {
  switch (command.kind) {
    case "list":
      return command.json ? [command.noun, "--json"] : [command.noun];
    case "switch":
      return command.explicit
        ? [command.noun, "switch", command.name]
        : [command.noun, command.name];
    case "create":
      return ["space-create", command.name];
    case "create-intent":
      return ["intent-create", ...command.rest];
    case "help":
      return ["help"];
    case "error":
    case "not-workspace":
      return null;
  }
}

export type DispatcherPluginCommand =
  | { kind: "not-plugin" }
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; argv: string[] };

export function parseDispatcherPluginCommand(
  args: string[],
): DispatcherPluginCommand {
  if (args[0] !== "plugin") return { kind: "not-plugin" };
  const verb = args[1];
  if (verb === "help" || verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  const target = verb === "select"
    ? "select-plugins"
    : verb === "list"
    ? "plugin-list"
    : verb === "sync"
    ? "plugin-sync"
    : verb === "validate"
    ? "plugin-validate"
    : verb === "build"
    ? "plugin-build"
    : undefined;
  if (target !== undefined) {
    return { kind: "run", argv: [target, ...args.slice(2)] };
  }
  const detail = verb ? `unknown verb '${verb}'` : "missing verb";
  return {
    kind: "error",
    message: `aidlc: ${detail} for noun 'plugin'; try 'aidlc help --all'`,
  };
}

export type NamespaceRouteShape = {
  namespace: string;
  group: string;
  kind: string;
  verbs: readonly string[];
};

export type NamespaceInvocation = {
  file: string;
  line: number;
  source: "aidlc" | "{{INVOKE}}";
  namespace: "engine" | "system";
  noun?: string;
  verb?: string;
  command: string;
  resolves: boolean;
};

function cleanInvocationToken(token: string | undefined): string | undefined {
  return token
    ?.replace(/^[([`"']+/, "")
    .replace(/[\]),.:;\\`"']+$/, "");
}

export function namespaceInvocationResolves(
  routes: readonly NamespaceRouteShape[],
  namespace: "engine" | "system",
  noun: string | undefined,
  verb: string | undefined,
): boolean {
  if (
    !noun ||
    noun === "*" ||
    noun === ".*" ||
    noun === "--help" ||
    noun === "-h" ||
    noun.includes("<") ||
    noun.startsWith("$")
  ) {
    return true;
  }
  const namespaceRoutes = routes.filter((route) => route.namespace === namespace);
  if (
    namespaceRoutes.some((route) =>
      route.group === "top" && route.verbs.includes(noun)
    )
  ) {
    return true;
  }
  const grouped = namespaceRoutes.filter((route) => route.group === noun);
  if (grouped.length === 0) return false;
  if (!verb) return true;
  if (verb.startsWith("<") || verb.startsWith("$")) return true;
  if (verb.startsWith("--")) {
    return grouped.some((route) => route.kind === "routing-only");
  }
  return grouped.some((route) =>
    route.kind === "routing-only" ||
    route.verbs.some((candidate) =>
      candidate === verb ||
      candidate.startsWith(`${verb} `) ||
      candidate.startsWith("<")
    )
  );
}

export function scanNamespaceInvocations(
  file: string,
  value: string,
  routes: readonly NamespaceRouteShape[],
): NamespaceInvocation[] {
  const invocations: NamespaceInvocation[] = [];
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    const invocation =
      /(\baidlc|\{\{INVOKE\}\})\s+(engine|system)(?:\s+([^\s`"'|;&(){}]+))?(?:\s+([^\s`"'|;&(){}]+))?/g;
    for (const match of line.matchAll(invocation)) {
      const source = match[1] === "aidlc" ? "aidlc" : "{{INVOKE}}";
      const namespace = match[2] as "engine" | "system";
      const noun = cleanInvocationToken(match[3]);
      const verb = cleanInvocationToken(match[4]);
      invocations.push({
        file,
        line: index + 1,
        source,
        namespace,
        noun,
        verb,
        command: [source, namespace, noun, verb].filter(Boolean).join(" "),
        resolves: namespaceInvocationResolves(routes, namespace, noun, verb),
      });
    }
  }
  return invocations;
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unavailable: 3,
  integrity: 4,
  actionNeeded: 5,
} as const;

export type OutputMode = "human" | "quiet" | "json";

export type CommandResult = {
  ok: boolean;
  code: number;
  status: string;
  message: string;
  data?: unknown;
  remediation?: string;
};

export type GlobalOptions = {
  mode: OutputMode;
  color: boolean;
  yes: boolean;
  offline: boolean;
  verbose: boolean;
};

export function globalOptions(argv: readonly string[]): GlobalOptions {
  configureColor(argv);
  return {
    mode: argv.includes("--json") ? "json" : argv.includes("--quiet") ? "quiet" : "human",
    color: colorEnabled(process.stdout),
    yes: argv.includes("--yes"),
    offline: argv.includes("--offline") || process.env.AIDLC_OFFLINE === "1",
    verbose: argv.includes("--verbose"),
  };
}

export function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function valuesAfter(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      values.push(argv[++i]);
    }
  }
  return values;
}

export function emitResult(result: CommandResult, options: GlobalOptions): void {
  if (options.mode === "json") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
  } else if (options.mode === "quiet") {
    const output = result.ok ? result.message : (result.remediation ?? result.message);
    if (output) process.stdout.write(`${output}\n`);
  } else {
    if (result.ok) {
      process.stdout.write(`${result.message}\n`);
    } else if (result.code === EXIT.actionNeeded) {
      process.stdout.write(`action: ${result.message}\n`);
    } else {
      process.stdout.write(`${errorLabel("error:", process.stdout)} ${result.message}\n`);
    }
    if (result.remediation) {
      process.stdout.write(
        `${
          result.status === "usage"
            ? heading("usage:", process.stdout)
            : fixLabel("fix:", process.stdout)
        } ${result.remediation}\n`,
      );
    } else if (result.status === "usage") {
      process.stdout.write(
        `${heading("usage:", process.stdout)} rerun with --help for valid usage\n`,
      );
    }
  }
  process.exitCode = result.code;
}

export function usage(message: string, remediation?: string): CommandResult {
  return { ok: false, code: EXIT.usage, status: "usage", message, remediation };
}

export function failure(
  message: string,
  code: number = EXIT.failure,
  remediation?: string,
): CommandResult {
  return { ok: false, code, status: "failed", message, remediation };
}

export function success(message: string, data?: unknown): CommandResult {
  return { ok: true, code: EXIT.ok, status: "ok", message, data };
}
