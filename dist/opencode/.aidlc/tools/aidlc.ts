#!/usr/bin/env bun
import { existsSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  errorMessage,
  parseWorkspaceCommand,
  workspaceCommandUtilityArgv,
} from "./aidlc-lib.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import { packagedDistributionRoot, runtimeHarnessDir } from "./aidlc-runtime-paths.ts";

type Classification = "passthrough" | "translation" | "stub" | "routing-only" | "help";
type RouteKind =
  | "top-passthrough"
  | "top-prefix"
  | "top-stub"
  | "top-help"
  | "noun-passthrough"
  | "noun-map"
  | "custom"
  | "routing-only";

type HelpLine = {
  command: string;
  summary: string;
};

type CustomRoute = "workspace" | "config" | "plugin" | "gen";
type RouteOnly = "hook" | "statusline" | "adapter";

export type Route = {
  id: string;
  group: string;
  kind: RouteKind;
  classification: Classification;
  verbs: readonly string[];
  tool?: string;
  prefix?: readonly string[];
  targets?: Readonly<Record<string, string>>;
  custom?: CustomRoute;
  routeOnly?: RouteOnly;
  human?: readonly HelpLine[];
  all?: readonly string[];
};

type Alias = {
  from: string;
  to: string;
  irregular?: boolean;
};

export const TOOLS = {
  audit: "aidlc-audit.ts",
  bolt: "aidlc-bolt.ts",
  graph: "aidlc-graph.ts",
  jump: "aidlc-jump.ts",
  learnings: "aidlc-learnings.ts",
  log: "aidlc-log.ts",
  orchestrate: "aidlc-orchestrate.ts",
  runnerGen: "aidlc-runner-gen.ts",
  runtime: "aidlc-runtime.ts",
  sensor: "aidlc-sensor.ts",
  sensorLinter: "aidlc-sensor-linter.ts",
  sensorRequiredSections: "aidlc-sensor-required-sections.ts",
  sensorTypeCheck: "aidlc-sensor-type-check.ts",
  sensorUpstreamCoverage: "aidlc-sensor-upstream-coverage.ts",
  state: "aidlc-state.ts",
  swarm: "aidlc-swarm.ts",
  utility: "aidlc-utility.ts",
  validate: "aidlc-validate.ts",
  worktree: "aidlc-worktree.ts",
} as const;

export const SLASH_FLAG_ALIASES: readonly Alias[] = [
  { from: "--status", to: "status" },
  { from: "--doctor", to: "doctor" },
  { from: "--help", to: "help" },
  { from: "--version", to: "version" },
  { from: "--resume", to: "next --resume", irregular: true },
  { from: "--scope", to: "next --scope", irregular: true },
  { from: "--upgrade", to: "upgrade", irregular: true },
  { from: "config-change", to: "config set", irregular: true },
  { from: "space-create", to: "space create", irregular: true },
];

// ROUTES_TABLE_START
export const ROUTES: readonly Route[] = [
  {
    id: "top-orchestrate",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["next", "report", "park"],
    tool: TOOLS.orchestrate,
    human: [
      { command: "next [args]", summary: "run the next orchestrator action" },
      { command: "report [args]", summary: "render the orchestrator report" },
      { command: "park [args]", summary: "park the current workflow" },
    ],
    all: ["next [args]", "report [args]", "park [args]"],
  },
  {
    id: "top-compose",
    group: "top",
    kind: "top-prefix",
    classification: "translation",
    verbs: ["compose"],
    tool: TOOLS.orchestrate,
    prefix: ["next", "compose"],
    human: [{ command: "compose [args]", summary: "start composition through orchestrate next compose" }],
    all: ["compose [args]"],
  },
  {
    id: "top-utility",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["recompose", "status", "doctor", "version"],
    tool: TOOLS.utility,
    human: [
      { command: "status [args]", summary: "show the current AIDLC status" },
      { command: "doctor [args]", summary: "run environment diagnostics" },
      { command: "version [args]", summary: "print the installed AIDLC version" },
      { command: "recompose [args]", summary: "rerun composition through the utility handler" },
    ],
    all: ["recompose [args]", "status [args]", "doctor [args]", "version [args]"],
  },
  {
    id: "top-help",
    group: "top",
    kind: "top-help",
    classification: "help",
    verbs: ["help"],
    all: ["help [--all]"],
  },
  {
    id: "top-transition",
    group: "top",
    kind: "top-passthrough",
    classification: "translation",
    verbs: ["init", "upgrade"],
    tool: TOOLS.utility,
    all: [],
  },
  {
    id: "state-passthrough",
    group: "state",
    kind: "noun-passthrough",
    classification: "passthrough",
    tool: TOOLS.state,
    verbs: [
      "get",
      "set",
      "set-skeleton-stance",
      "set-construction-iteration",
      "checkbox",
      "count",
      "advance",
      "finalize",
      "complete-workflow",
      "gate-start",
      "approve",
      "reject",
      "revise",
      "skip",
      "resume",
      "acknowledge-compaction",
      "reuse-artifact",
      "lookup",
      "practices-event",
      "practices-promote",
      "fork",
      "merge",
      "park",
      "unpark",
    ],
  },
  {
    id: "state-utility",
    group: "state",
    kind: "noun-map",
    classification: "translation",
    verbs: ["set-status", "init"],
    tool: TOOLS.utility,
    targets: { "set-status": "set-status", init: "state-init" },
  },
  {
    id: "audit-passthrough",
    group: "audit",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["append", "append-batch", "append-raw"],
    tool: TOOLS.audit,
  },
  {
    id: "audit-renames",
    group: "audit",
    kind: "noun-map",
    classification: "translation",
    verbs: ["fork", "merge"],
    tool: TOOLS.audit,
    targets: { fork: "audit-fork", merge: "audit-merge" },
  },
  {
    id: "graph",
    group: "graph",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: [
      "artifacts",
      "producers",
      "consumers",
      "topo",
      "cycles",
      "scope",
      "validate-scope",
      "validate-grid",
      "compile",
      "resolve",
      "export",
    ],
    tool: TOOLS.graph,
  },
  {
    id: "runtime",
    group: "runtime",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["compile", "read", "summary", "fragment-fork", "fragment-merge"],
    tool: TOOLS.runtime,
  },
  {
    id: "sensor",
    group: "sensor",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["list", "describe", "fire"],
    tool: TOOLS.sensor,
  },
  {
    id: "swarm",
    group: "swarm",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["prepare", "check", "finalize"],
    tool: TOOLS.swarm,
  },
  {
    id: "bolt",
    group: "bolt",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["start", "complete", "fail", "abort", "set-autonomy", "dispatch-event", "hold-merge", "release-merge"],
    tool: TOOLS.bolt,
  },
  {
    id: "worktree",
    group: "worktree",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["create", "merge", "discard", "list", "verify", "info"],
    tool: TOOLS.worktree,
  },
  {
    id: "jump",
    group: "jump",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["resolve", "execute"],
    tool: TOOLS.jump,
  },
  {
    id: "log",
    group: "log",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["decision", "answer"],
    tool: TOOLS.log,
  },
  {
    id: "learnings",
    group: "learnings",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["surface", "persist"],
    tool: TOOLS.learnings,
  },
  {
    id: "validate",
    group: "validate",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["outputs"],
    tool: TOOLS.validate,
  },
  {
    id: "intent",
    group: "intent",
    kind: "custom",
    classification: "translation",
    verbs: ["list", "switch", "<name>", "birth"],
    custom: "workspace",
    human: [{ command: "intent [list|switch|birth]", summary: "list, switch, or create intent context" }],
    all: ["list [--json]", "switch <name>", "<name>", "birth [args]"],
  },
  {
    id: "space",
    group: "space",
    kind: "custom",
    classification: "translation",
    verbs: ["list", "switch", "<name>", "create"],
    custom: "workspace",
    human: [{ command: "space [list|switch|create]", summary: "list, switch, or create a space" }],
    all: ["list", "switch <name>", "<name>", "create <name>"],
  },
  {
    id: "scope",
    group: "scope",
    kind: "noun-map",
    classification: "translation",
    verbs: ["change", "detect", "resolve-env"],
    tool: TOOLS.utility,
    targets: { change: "scope-change", detect: "detect-scope", "resolve-env": "resolve-env-scope" },
  },
  {
    id: "config",
    group: "config",
    kind: "custom",
    classification: "translation",
    verbs: ["set depth", "set test-strategy", "get", "list"],
    custom: "config",
    targets: {
      "set depth": "config-change",
      "set test-strategy": "config-change",
      get: "config-get",
      list: "config-list",
    },
    human: [
      { command: "config get <key>", summary: "print supported project configuration" },
      { command: "config set <key> <value>", summary: "change supported project configuration" },
      { command: "config list", summary: "list supported project configuration" },
    ],
    all: ["set depth <value>", "set test-strategy <value>", "get <key>", "list"],
  },
  {
    id: "plugin",
    group: "plugin",
    kind: "custom",
    classification: "translation",
    verbs: ["select", "sync", "list"],
    custom: "plugin",
    targets: { select: "select-plugins", sync: "plugin-sync", list: "plugin-list" },
    human: [
      { command: "plugin select [names]", summary: "set enabled plugins" },
      { command: "plugin list", summary: "list installed plugin enablement" },
      { command: "plugin sync", summary: "compose installed plugins" },
    ],
    all: ["select [names]", "sync", "list"],
  },
  {
    id: "gen",
    group: "gen",
    kind: "custom",
    classification: "translation",
    verbs: ["runners", "runners --check", "runner-list", "runner-scopes", "stage-table", "scope-table"],
    custom: "gen",
    tool: TOOLS.runnerGen,
    all: ["runners [args]", "runners --check", "runner-list", "runner-scopes", "stage-table [args]", "scope-table [args]"],
  },
  {
    id: "workspace",
    group: "workspace",
    kind: "noun-map",
    classification: "translation",
    verbs: ["detect", "codekb"],
    tool: TOOLS.utility,
    targets: { detect: "detect", codekb: "codekb-path" },
  },
  {
    id: "hook",
    group: "hook",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["<name>"],
    routeOnly: "hook",
    all: ["<name>"],
  },
  {
    id: "statusline",
    group: "top",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["statusline"],
    routeOnly: "statusline",
    all: ["statusline"],
  },
  {
    id: "adapter",
    group: "top",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["adapter"],
    routeOnly: "adapter",
    all: ["adapter <harness> <target> [args]"],
  },
];
// ROUTES_TABLE_END

export type Action =
  | { type: "delegate"; tool: string; args: string[] }
  | { type: "hook"; name: string; path: string; projectDir?: string }
  | { type: "statusline"; path: string; projectDir?: string }
  | { type: "adapter"; harness: AdapterHarness; target: string; extraArgs: string[]; path: string; projectDir?: string }
  | { type: "sensor-script-file"; id: string; args: string[]; projectDir?: string }
  | { type: "version" }
  | { type: "stub"; message: string; code: number }
  | { type: "help"; all: boolean }
  | { type: "error"; message: string; code: number };

function text(fd: number, value: string | Uint8Array): void {
  if (typeof value === "string") {
    writeSync(fd, value);
    return;
  }
  writeSync(fd, value);
}

function dispatcherDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function toolsDir(): string {
  // Test seam for parity suites that need one dispatcher copy to delegate to a
  // different generated tools tree. Production resolves sibling tools beside
  // this dispatcher.
  const fromEnv = process.env.AIDLC_DISPATCH_TOOLS_DIR;
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
  return dispatcherDir();
}

type AdapterHarness = "codex" | "kiro" | "kiro-ide";

const ADAPTER_HARNESS_LEAF: Record<AdapterHarness, string> = {
  codex: ".codex",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
};

function isAdapterHarness(value: string): value is AdapterHarness {
  return Object.hasOwn(ADAPTER_HARNESS_LEAF, value);
}

function resolveHookPath(
  file: string,
  harness?: AdapterHarness,
  projectDir = process.cwd(),
): string {
  const moduleRelative = join(dispatcherDir(), "..", "hooks", file);
  const runtimeLeaf = harness
    ? ADAPTER_HARNESS_LEAF[harness]
    : runtimeHarnessDir(projectDir);
  const leaves = harness
    ? [ADAPTER_HARNESS_LEAF[harness]]
    : [
        runtimeLeaf,
        ".claude",
        ".kiro",
        ".codex",
      ].filter((value, index, values): value is string =>
        typeof value === "string" && value.length > 0 && values.indexOf(value) === index
      );
  const installed = leaves.map((leaf) => join(projectDir, leaf, "hooks", file));
  const executableRelative = join(
    packagedDistributionRoot(runtimeLeaf, harness),
    runtimeLeaf,
    "hooks",
    file,
  );
  const candidates = [moduleRelative, ...installed, executableRelative];
  return candidates.find((candidate) => existsSync(candidate)) ?? moduleRelative;
}

function routeForms(route: Route): string[] {
  if (route.all) return [...route.all];
  return [...route.verbs];
}

export function listRoutes(): readonly Route[] {
  return ROUTES;
}

export function renderHumanHelp(): string {
  const lines: string[] = ["aidlc <noun> <verb> [args]", "", "Human commands:"];
  const commands = ROUTES.flatMap((route) => [...(route.human ?? [])]);
  const width = Math.max(...commands.map((line) => line.command.length));
  for (const line of commands) {
    lines.push(`  ${line.command.padEnd(width)}  ${line.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderAllHelp(): string {
  const lines: string[] = ["aidlc <noun> <verb> [args]", "", "Top level:"];
  for (const route of ROUTES.filter((item) => item.group === "top")) {
    for (const form of routeForms(route)) lines.push(`  ${form}`);
  }

  lines.push("", "conductor protocol - not a stable scripting interface", "Plumbing:");
  const grouped = new Map<string, string[]>();
  for (const route of ROUTES.filter((item) => item.group !== "top")) {
    grouped.set(route.group, [...(grouped.get(route.group) ?? []), ...routeForms(route)]);
  }
  for (const [group, forms] of grouped) {
    lines.push(`  ${group}: ${forms.join(", ")}`);
  }

  lines.push("", "Slash-flag aliases:");
  for (const alias of SLASH_FLAG_ALIASES) {
    const mark = alias.irregular ? " (irregular)" : "";
    lines.push(`  ${alias.from} -> ${alias.to}${mark}`);
  }
  return `${lines.join("\n")}\n`;
}

function topLevelError(command: string): Action {
  return {
    type: "error",
    code: 1,
    message: `aidlc: unknown command or noun '${command}'; try 'aidlc --help'\n`,
  };
}

function nounError(noun: string, verb: string | undefined): Action {
  const detail = verb ? `unknown verb '${verb}'` : "missing verb";
  return {
    type: "error",
    code: 1,
    message: `aidlc: ${detail} for noun '${noun}'; try 'aidlc help --all'\n`,
  };
}

function requireValue(noun: string, verb: string, value: string | undefined): Action | undefined {
  if (value) return undefined;
  return nounError(noun, verb);
}

function isSafeName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

// TRANSLATION_LOGIC_START
function handleWorkspace(argv: string[]): Action {
  const command = parseWorkspaceCommand(argv);
  if (command.kind === "not-workspace") return nounError(argv[0], argv[1]);
  if (command.kind === "error") {
    return { type: "error", code: 1, message: `${command.message}\n` };
  }
  const utilityArgv = workspaceCommandUtilityArgv(command);
  if (utilityArgv === null) return nounError(argv[0], argv[1]);
  return { type: "delegate", tool: TOOLS.utility, args: utilityArgv };
}

function handleConfig(route: Route, argv: string[]): Action {
  const verb = argv[1];
  if (verb === "get" || verb === "list") {
    const target = route.targets?.[verb];
    if (target) return { type: "delegate", tool: TOOLS.utility, args: [target, ...argv.slice(2)] };
  }
  if (verb !== "set") return nounError("config", verb);

  const key = argv[2];
  const value = argv[3];
  if (key === "depth") {
    const missing = requireValue("config", "set depth", value);
    if (missing) return missing;
    return { type: "delegate", tool: TOOLS.utility, args: ["config-change", "--depth", value, ...argv.slice(4)] };
  }
  if (key === "test-strategy") {
    const missing = requireValue("config", "set test-strategy", value);
    if (missing) return missing;
    return { type: "delegate", tool: TOOLS.utility, args: ["config-change", "--test-strategy", value, ...argv.slice(4)] };
  }
  return nounError("config", key ? `set ${key}` : "set");
}

function handlePlugin(route: Route, argv: string[]): Action {
  const verb = argv[1];
  if (verb === "select") {
    const target = route.targets?.select ?? "select-plugins";
    return { type: "delegate", tool: TOOLS.utility, args: [target, ...argv.slice(2)] };
  }
  if (verb === "sync" || verb === "list") {
    const target = route.targets?.[verb];
    if (target) return { type: "delegate", tool: TOOLS.utility, args: [target, ...argv.slice(2)] };
  }
  return nounError("plugin", verb);
}

function handleGen(argv: string[]): Action {
  const verb = argv[1];
  if (verb === "runners") {
    // Keep --check as a flag-shaped route. Other runner flags are passed
    // through unchanged, including Windows callers that avoid shell redirects.
    if (argv[2] === "--check") {
      return { type: "delegate", tool: TOOLS.runnerGen, args: ["check", ...argv.slice(3)] };
    }
    return { type: "delegate", tool: TOOLS.runnerGen, args: ["write", ...argv.slice(2)] };
  }
  if (verb === "runner-list") {
    return { type: "delegate", tool: TOOLS.runnerGen, args: ["list", ...argv.slice(2)] };
  }
  if (verb === "runner-scopes") {
    return { type: "delegate", tool: TOOLS.runnerGen, args: ["scopes", ...argv.slice(2)] };
  }
  if (verb === "stage-table" || verb === "scope-table") {
    return { type: "delegate", tool: TOOLS.utility, args: [verb, ...argv.slice(2)] };
  }
  return nounError("gen", verb);
}

function handleCustom(route: Route, argv: string[]): Action {
  if (route.custom === "workspace") return handleWorkspace(argv);
  if (route.custom === "config") return handleConfig(route, argv);
  if (route.custom === "plugin") return handlePlugin(route, argv);
  if (route.custom === "gen") return handleGen(argv);
  return nounError(argv[0], argv[1]);
}

function handleRouteOnly(route: Route, argv: string[]): Action {
  if (route.routeOnly === "hook") {
    const name = argv[1];
    if (!name) return nounError("hook", undefined);
    if (!isSafeName(name)) return nounError("hook", name);
    return { type: "hook", name, path: resolveHookPath(`aidlc-${name}.ts`) };
  }
  if (route.routeOnly === "statusline") {
    return { type: "statusline", path: resolveHookPath("aidlc-statusline.ts") };
  }
  if (route.routeOnly === "adapter") {
    const harness = argv[1];
    const target = argv[2];
    if (!harness) return nounError("adapter", undefined);
    if (!isAdapterHarness(harness)) return nounError("adapter", harness);
    if (!target) return nounError("adapter", undefined);
    if (!isSafeName(target)) return nounError("adapter", target);
    const file = harness === "codex" ? "aidlc-codex-adapter.ts" : "aidlc-kiro-adapter.ts";
    return {
      type: "adapter",
      harness,
      target,
      extraArgs: argv.slice(3),
      path: resolveHookPath(file, harness),
    };
  }
  return nounError(argv[0], argv[1]);
}

function resolveAlias(argv: string[]): Action | undefined {
  const head = argv[0];
  if (head === "space-create") return handleWorkspace(argv);
  if (head === "__sensor-script-file") {
    const id = argv[1];
    if (!id || !isSafeName(id)) {
      return topLevelError(argv.slice(0, 2).join(" "));
    }
    return {
      type: "sensor-script-file",
      id,
      args: argv.slice(2),
    };
  }
  if (head === "__sensor-script") {
    const scripts: Record<string, string> = {
      linter: TOOLS.sensorLinter,
      "required-sections": TOOLS.sensorRequiredSections,
      "type-check": TOOLS.sensorTypeCheck,
      "upstream-coverage": TOOLS.sensorUpstreamCoverage,
    };
    const tool = scripts[argv[1] ?? ""];
    return tool
      ? { type: "delegate", tool, args: argv.slice(2) }
      : topLevelError(argv.slice(0, 2).join(" "));
  }
  if (head === "--status") return { type: "delegate", tool: TOOLS.utility, args: ["status", ...argv.slice(1)] };
  if (head === "--doctor") return { type: "delegate", tool: TOOLS.utility, args: ["doctor", ...argv.slice(1)] };
  if (head === "--version") return { type: "version" };
  if (head === "--resume") return { type: "delegate", tool: TOOLS.orchestrate, args: ["next", "--resume", ...argv.slice(1)] };
  if (head === "--scope") return { type: "delegate", tool: TOOLS.orchestrate, args: ["next", "--scope", ...argv.slice(1)] };
  if (head === "--upgrade") return { type: "delegate", tool: TOOLS.utility, args: ["upgrade", ...argv.slice(1)] };
  if (head === "config-change") {
    return { type: "delegate", tool: TOOLS.utility, args: ["config-change", ...argv.slice(1)] };
  }
  return undefined;
}

function resolveTop(argv: string[]): Action | undefined {
  const verb = argv[0];
  for (const route of ROUTES.filter((item) => item.group === "top")) {
    if (!route.verbs.includes(verb)) continue;

    if (route.kind === "top-passthrough" && route.tool) {
      if (verb === "version") return { type: "version" };
      return { type: "delegate", tool: route.tool, args: [verb, ...argv.slice(1)] };
    }
    if (route.kind === "top-prefix" && route.tool && route.prefix) {
      return { type: "delegate", tool: route.tool, args: [...route.prefix, ...argv.slice(1)] };
    }
    if (route.kind === "top-stub") {
      return {
        type: "stub",
        code: 3,
        message: "reserved; not available in this install\n",
      };
    }
    if (route.kind === "top-help") return { type: "help", all: argv[1] === "--all" };
    if (route.kind === "routing-only") return handleRouteOnly(route, argv);
  }
  return undefined;
}

function resolveNoun(argv: string[]): Action | undefined {
  const noun = argv[0];
  const routes = ROUTES.filter((item) => item.group === noun);
  if (routes.length === 0) return undefined;

  for (const route of routes) {
    if (route.kind === "custom") return handleCustom(route, argv);
    if (route.kind === "routing-only") return handleRouteOnly(route, argv);

    const verb = argv[1];
    if (!verb || !route.verbs.includes(verb)) continue;

    if (route.kind === "noun-passthrough" && route.tool) {
      return { type: "delegate", tool: route.tool, args: [verb, ...argv.slice(2)] };
    }
    if (route.kind === "noun-map" && route.tool && route.targets) {
      return { type: "delegate", tool: route.tool, args: [route.targets[verb], ...argv.slice(2)] };
    }
  }

  return nounError(noun, argv[1]);
}

function resolveActionWithoutGlobalFlags(argv: string[]): Action {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { type: "help", all: false };
  }
  if (argv[0] === "help") {
    return { type: "help", all: argv[1] === "--all" };
  }

  const alias = resolveAlias(argv);
  if (alias) return alias;

  const top = resolveTop(argv);
  if (top) return top;

  const noun = resolveNoun(argv);
  if (noun) return noun;

  return topLevelError(argv[0]);
}

export function resolveAction(argv: string[]): Action {
  const clean: string[] = [];
  let projectDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--project-dir") {
      clean.push(argv[i]);
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      return {
        type: "error",
        code: 1,
        message: "aidlc: --project-dir requires a path value\n",
      };
    }
    projectDir = value;
  }

  const action = resolveActionWithoutGlobalFlags(clean);
  if (projectDir) {
    const absoluteProjectDir = isAbsolute(projectDir)
      ? projectDir
      : resolve(process.cwd(), projectDir);
    if (action.type === "delegate") {
      action.args.push("--project-dir", absoluteProjectDir);
    } else if (action.type === "hook") {
      action.projectDir = absoluteProjectDir;
      action.path = resolveHookPath(`aidlc-${action.name}.ts`, undefined, absoluteProjectDir);
    } else if (action.type === "statusline") {
      action.projectDir = absoluteProjectDir;
      action.path = resolveHookPath("aidlc-statusline.ts", undefined, absoluteProjectDir);
    } else if (action.type === "adapter") {
      action.projectDir = absoluteProjectDir;
      const file = action.harness === "codex"
        ? "aidlc-codex-adapter.ts"
        : "aidlc-kiro-adapter.ts";
      action.path = resolveHookPath(file, action.harness, absoluteProjectDir);
    } else if (action.type === "sensor-script-file") {
      action.projectDir = absoluteProjectDir;
    }
  }
  return action;
}
// TRANSLATION_LOGIC_END

function toolPath(tool: string): string {
  return join(toolsDir(), tool);
}

function bunExecutable(): string {
  return basename(process.execPath).startsWith("bun") ? process.execPath : "bun";
}

function delegatedProjectDir(args: readonly string[]): string | undefined {
  const index = args.indexOf("--project-dir");
  return index >= 0 ? args[index + 1] : undefined;
}

function runDelegateDev(tool: string, args: string[]): number {
  try {
    const child = Bun.spawnSync([bunExecutable(), toolPath(tool), ...args], { /* dev-mode bun spawn */
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        ...(delegatedProjectDir(args)
          ? { AIDLC_PROJECT_DIR: delegatedProjectDir(args) }
          : {}),
      },
    });
    return child.exitCode ?? 1;
  } catch (error) {
    text(2, `aidlc: failed to spawn ${tool}: ${String(error)}\n`);
    return 1;
  }
}

type DelegateModule = {
  main(argv: string[]): void | Promise<void>;
};

async function loadDelegate(tool: string): Promise<DelegateModule | null> {
  switch (tool) {
    case TOOLS.audit:
      return import("./aidlc-audit.ts");
    case TOOLS.bolt:
      return import("./aidlc-bolt.ts");
    case TOOLS.graph:
      return import("./aidlc-graph.ts");
    case TOOLS.jump:
      return import("./aidlc-jump.ts");
    case TOOLS.learnings:
      return import("./aidlc-learnings.ts");
    case TOOLS.log:
      return import("./aidlc-log.ts");
    case TOOLS.orchestrate:
      return import("./aidlc-orchestrate.ts");
    case TOOLS.runnerGen:
      return import("./aidlc-runner-gen.ts");
    case TOOLS.runtime:
      return import("./aidlc-runtime.ts");
    case TOOLS.sensor:
      return import("./aidlc-sensor.ts");
    case TOOLS.sensorLinter:
      return import("./aidlc-sensor-linter.ts");
    case TOOLS.sensorRequiredSections:
      return import("./aidlc-sensor-required-sections.ts");
    case TOOLS.sensorTypeCheck:
      return import("./aidlc-sensor-type-check.ts");
    case TOOLS.sensorUpstreamCoverage:
      return import("./aidlc-sensor-upstream-coverage.ts");
    case TOOLS.state:
      return import("./aidlc-state.ts");
    case TOOLS.swarm:
      return import("./aidlc-swarm.ts");
    case TOOLS.utility:
      return import("./aidlc-utility.ts");
    case TOOLS.validate:
      return import("./aidlc-validate.ts");
    case TOOLS.worktree:
      return import("./aidlc-worktree.ts");
    default:
      return null;
  }
}

async function runDelegateInProcess(tool: string, args: string[]): Promise<number> {
  const previousProjectDir = process.env.AIDLC_PROJECT_DIR;
  const projectDir = delegatedProjectDir(args);
  if (projectDir) process.env.AIDLC_PROJECT_DIR = projectDir;
  try {
    const mod = await loadDelegate(tool);
    if (mod === null || typeof mod.main !== "function") {
      text(2, `${JSON.stringify({ error: `${tool} does not export main(argv)` })}\n`);
      return 1;
    }
    await mod.main(args);
    const code = process.exitCode;
    if (typeof code === "number") return code;
    return code ? Number(code) || 1 : 0;
  } catch (error) {
    text(2, `${JSON.stringify({ error: errorMessage(error) })}\n`);
    return 1;
  } finally {
    if (previousProjectDir === undefined) delete process.env.AIDLC_PROJECT_DIR;
    else process.env.AIDLC_PROJECT_DIR = previousProjectDir;
  }
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

async function withProjectDir(
  projectDir: string | undefined,
  run: () => Promise<number>,
): Promise<number> {
  if (!projectDir) return await run();
  const previousAidlc = process.env.AIDLC_PROJECT_DIR;
  const previousClaude = process.env.CLAUDE_PROJECT_DIR;
  process.env.AIDLC_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  try {
    return await run();
  } finally {
    if (previousAidlc === undefined) delete process.env.AIDLC_PROJECT_DIR;
    else process.env.AIDLC_PROJECT_DIR = previousAidlc;
    if (previousClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousClaude;
  }
}

async function runHook(action: Extract<Action, { type: "hook" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, `aidlc hook ${action.name}: not available in this install\n`);
    return 1;
  }
  const mod = await import(pathToFileURL(action.path).href);
  if (typeof mod.run !== "function") {
    text(2, `aidlc hook ${action.name}: hook does not export run(input)\n`);
    return 1;
  }
  return await mod.run(await readStdin());
}

async function runStatusline(action: Extract<Action, { type: "statusline" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, "aidlc statusline: not available in this install\n");
    return 1;
  }
  const mod = await import(pathToFileURL(action.path).href);
  if (typeof mod.run !== "function") {
    text(2, "aidlc statusline: hook does not export run(input)\n");
    return 1;
  }
  return await mod.run(await readStdin());
}

async function runAdapter(action: Extract<Action, { type: "adapter" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, `aidlc adapter ${action.harness} ${action.target}: not available in this install\n`);
    return 1;
  }
  const previousHarness = process.env.AIDLC_HARNESS_DIR;
  const previousExecutable = process.env.AIDLC_COMPILED_EXECUTABLE;
  process.env.AIDLC_HARNESS_DIR = ADAPTER_HARNESS_LEAF[action.harness];
  if (import.meta.url.includes("/$bunfs/")) {
    process.env.AIDLC_COMPILED_EXECUTABLE = process.execPath;
  }
  try {
    const mod = await import(pathToFileURL(action.path).href);
    if (typeof mod.run !== "function") {
      text(2, `aidlc adapter ${action.harness} ${action.target}: adapter does not export run(target, input, extraArgs)\n`);
      return 1;
    }
    return await mod.run(action.target, await readStdin(), action.extraArgs);
  } finally {
    if (previousHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
    else process.env.AIDLC_HARNESS_DIR = previousHarness;
    if (previousExecutable === undefined) delete process.env.AIDLC_COMPILED_EXECUTABLE;
    else process.env.AIDLC_COMPILED_EXECUTABLE = previousExecutable;
  }
}

async function runSensorScriptFile(
  action: Extract<Action, { type: "sensor-script-file" }>,
): Promise<number> {
  const sensorModule = await import("./aidlc-sensor.ts") as {
    resolveSensorScriptPath?: (id: string) => string;
  };
  if (typeof sensorModule.resolveSensorScriptPath !== "function") {
    text(2, "aidlc sensor worker: resolver unavailable\n");
    return 1;
  }
  let path: string;
  try {
    path = sensorModule.resolveSensorScriptPath(action.id);
  } catch (error) {
    text(2, `aidlc sensor worker: ${errorMessage(error)}\n`);
    return 1;
  }
  if (!existsSync(path)) {
    text(2, `aidlc sensor worker: not found: ${path}\n`);
    return 1;
  }
  const mod = await import(pathToFileURL(path).href) as {
    main?: (argv: string[]) => void | Promise<void>;
  };
  if (typeof mod.main !== "function") {
    text(2, `aidlc sensor worker: ${path} does not export main(argv)\n`);
    return 1;
  }
  await mod.main(action.args);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function execute(action: Action): Promise<number> {
  const isCompiled = import.meta.url.includes("/$bunfs/");
  if (action.type === "delegate") {
    // Tool modules are imported lazily in compiled mode to keep dev-mode startup
    // fast and to avoid loading every tool for help/version calls.
    return isCompiled
      ? await runDelegateInProcess(action.tool, action.args)
      : runDelegateDev(action.tool, action.args);
  }
  if (action.type === "help") {
    text(1, action.all ? renderAllHelp() : renderHumanHelp());
    return 0;
  }
  if (action.type === "version") {
    text(1, `aidlc ${AIDLC_VERSION}\n`);
    return 0;
  }
  if (action.type === "hook") {
    return await withProjectDir(action.projectDir, () => runHook(action));
  }
  if (action.type === "statusline") {
    return await withProjectDir(action.projectDir, () => runStatusline(action));
  }
  if (action.type === "adapter") {
    return await withProjectDir(action.projectDir, () => runAdapter(action));
  }
  if (action.type === "sensor-script-file") {
    return await withProjectDir(action.projectDir, () => runSensorScriptFile(action));
  }
  if (action.type === "stub" || action.type === "error") {
    text(2, action.message);
    return action.code;
  }
  return 1;
}

export async function main(argv: string[]): Promise<void> {
  process.exitCode = 0;
  if (import.meta.url.includes("/$bunfs/") && !process.env.AIDLC_HARNESS_DIR) {
    // Compiled, no explicit harness: probe the project install (.claude /
    // .kiro / .codex by tools/data/harness.json) rather than assuming
    // .claude — module-relative derivation can't work from $bunfs, and every
    // delegate and sibling tool reads this env, so pin the probe's answer
    // once here. Falls back to .claude when no install is present.
    process.env.AIDLC_HARNESS_DIR = runtimeHarnessDir();
  }
  const code = await execute(resolveAction(argv));
  process.exitCode = code;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    text(2, `aidlc: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
