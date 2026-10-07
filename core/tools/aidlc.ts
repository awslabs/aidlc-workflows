#!/usr/bin/env bun
import { existsSync, readFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONFIG_SECTIONS,
  dispatcherWorkspaceUtilityArgv,
  HUMAN_PRESENCE_NO_SWITCH,
  LAUNCHER_GLOBAL_FLAGS,
  launcherRouteUsesPin,
  parseDispatcherPluginCommand,
  parseDispatcherWorkspaceCommand,
  type RouteNamespaceName,
} from "./aidlc-command.ts";
import {
  cmd,
  configureColor,
  dim,
  errorLabel,
  fixLabel,
  heading,
  tipLabel,
} from "./aidlc-color.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
  isCompiledExecutable,
  kiroTreeLayout,
  packagedDistributionRoot,
  discoverableRuntimeHarnessDir,
  runtimeHarnessDir,
  runtimeHarnessName,
} from "./aidlc-runtime-paths.ts";

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

type HelpSection = {
  label: string;
  forms: readonly string[];
};

type CustomRoute = "workspace" | "config" | "plugin" | "gen";
type RouteOnly = "hook" | "statusline" | "adapter" | "tool-passthrough";
type Visibility = "public" | "hidden" | "legacy";
type RouteNamespace = RouteNamespaceName;
type ProjectRequirement = "none" | "optional" | "required";
type PinPolicy = "active" | "inspect" | "pinned";
type NetworkPolicy = "forbidden" | "explicit-only" | "interactive-bounded" | "required";
type MutationScope =
  | "none"
  | "project"
  | "machine"
  | "project-and-machine"
  | "user-home";

export type Route = {
  id: string;
  namespace: RouteNamespace;
  group: string;
  kind: RouteKind;
  classification: Classification;
  verbs: readonly string[];
  tool?: string;
  prefix?: readonly string[];
  targets?: Readonly<Record<string, string>>;
  custom?: CustomRoute;
  routeOnly?: RouteOnly;
  visibility: Visibility;
  projectRequirement: ProjectRequirement;
  pinPolicy: PinPolicy;
  networkPolicy: NetworkPolicy;
  mutationScope: MutationScope;
  outputModes: readonly ("human" | "quiet" | "json")[];
  human?: readonly HelpLine[];
  all?: readonly string[];
  helpSummary?: string;
  helpSections?: readonly HelpSection[];
};

export type NamespaceHelpOptions = {
  namespace: Exclude<RouteNamespace, "public">;
  usage: string;
  header: string;
  excludedRouteIds?: ReadonlySet<string>;
};

const PUBLIC_ENGINE = {
  namespace: "engine",
  visibility: "hidden",
  projectRequirement: "required",
  pinPolicy: "pinned",
  networkPolicy: "forbidden",
  mutationScope: "project",
  outputModes: ["human", "json"],
} as const;

const HIDDEN_ENGINE = {
  ...PUBLIC_ENGINE,
  visibility: "hidden",
} as const;

type Alias = {
  from: string;
  to: string;
  irregular?: boolean;
};

export const TOOLS = {
  attest: "aidlc-attest.ts",
  audit: "aidlc-audit.ts",
  bolt: "aidlc-bolt.ts",
  graph: "aidlc-graph.ts",
  doctor: "aidlc-doctor.ts",
  init: "aidlc-init.ts",
  jump: "aidlc-jump.ts",
  knowledge: "aidlc-knowledge.ts",
  testingPosture: "aidlc-testing-posture.ts",
  learnings: "aidlc-learnings.ts",
  log: "aidlc-log.ts",
  lifecycle: "aidlc-lifecycle.ts",
  machineConfig: "aidlc-machine-config.ts",
  completions: "aidlc-completions.ts",
  orchestrate: "aidlc-orchestrate.ts",
  plugin: "aidlc-plugin.ts",
  runnerGen: "aidlc-runner-gen.ts",
  runtime: "aidlc-runtime.ts",
  reviewBrief: "aidlc-review-brief.ts",
  sensor: "aidlc-sensor.ts",
  sensorClaimSources: "aidlc-sensor-claim-sources.ts",
  sensorLinter: "aidlc-sensor-linter.ts",
  sensorRequiredSections: "aidlc-sensor-required-sections.ts",
  sensorTraceability: "aidlc-sensor-traceability.ts",
  sensorTypeCheck: "aidlc-sensor-type-check.ts",
  sensorUpstreamCoverage: "aidlc-sensor-upstream-coverage.ts",
  state: "aidlc-state.ts",
  swarm: "aidlc-swarm.ts",
  unit: "aidlc-unit.ts",
  utility: "aidlc-utility.ts",
  validate: "aidlc-validate.ts",
  worktree: "aidlc-worktree.ts",
  workspaceSync: "aidlc-workspace-sync.ts",
} as const;

const SENSOR_WORKERS = [
  ["claim-sources", TOOLS.sensorClaimSources],
  ["linter", TOOLS.sensorLinter],
  ["required-sections", TOOLS.sensorRequiredSections],
  ["traceability", TOOLS.sensorTraceability],
  ["type-check", TOOLS.sensorTypeCheck],
  ["upstream-coverage", TOOLS.sensorUpstreamCoverage],
] as const;

export const SLASH_FLAG_ALIASES: readonly Alias[] = [
  { from: "--claim", to: "unit claim", irregular: true },
  { from: "--release", to: "unit release", irregular: true },
  { from: "--status", to: "status" },
  { from: "--doctor", to: "doctor" },
  { from: "--help", to: "help" },
  { from: "--version", to: "version" },
  { from: "--resume", to: "next --resume", irregular: true },
  { from: "--scope", to: "next --scope", irregular: true },
  { from: "config-change", to: "config set", irregular: true },
  { from: "space-create", to: "space create", irregular: true },
];

export const PUBLIC_COMMANDS = [
  "config",
  "doctor",
  "version",
  "update",
  "use",
  "uninstall",
] as const;

type PublicCommand = (typeof PUBLIC_COMMANDS)[number];

const HUMAN_TOP_ROUTE_IDS = new Set([
  "top-doctor",
  "top-version",
  "top-help",
  "top-config",
  "top-update",
  "top-use",
  "top-uninstall",
]);

export const ENGINE_NAMESPACE_HELP: NamespaceHelpOptions = {
  namespace: "engine",
  usage: "aidlc engine <noun> <verb> [args]",
  header: "Engine machinery - generated harness surfaces only; not for human scripts:",
  excludedRouteIds: HUMAN_TOP_ROUTE_IDS,
};

export const SYSTEM_NAMESPACE_HELP: NamespaceHelpOptions = {
  namespace: "system",
  usage: "aidlc system <noun> <verb> [args]",
  header: "Operations on this user's aidlc installation; never a system-wide or root install:",
};

// ROUTES_TABLE_START
export const ROUTES: readonly Route[] = [
  {
    id: "top-orchestrate",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["next", "continue", "report", "park", "team-board"],
    tool: TOOLS.orchestrate,
    ...PUBLIC_ENGINE,
    namespace: "public",
    human: [
      { command: "next [args]", summary: "run the next orchestrator action" },
      { command: "report [args]", summary: "render the orchestrator report" },
      { command: "park [args]", summary: "park the current workflow" },
    ],
    all: [
      "next [args]",
      "continue <token>",
      "report [args]",
      "park [args]",
      "team-board [--snapshot] [--space <name>] [--intent <name>]",
    ],
  },
  {
    id: "unit",
    group: "unit",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: [
      "adopt",
      "claim",
      "gate",
      "land",
      "merge-status",
      "participate",
      "pin",
      "publish",
      "release",
      "status",
    ],
    tool: TOOLS.unit,
    ...PUBLIC_ENGINE,
    namespace: "public",
    mutationScope: "project",
    all: [
      "unit adopt <unit>",
      "unit claim <unit>",
      "unit gate <unit> --decision <approve|reject> --user-input <text>",
      "unit land <unit> [--step git|state|audit|all] [--target <branch>] [--accept-released-attempt --user-input <text>]",
      "unit merge-status <unit>",
      "unit participate",
      "unit pin <unit>",
      "unit publish <unit>",
      "unit release <unit>",
      "unit status",
    ],
  },
  {
    id: "top-compose",
    group: "top",
    kind: "top-prefix",
    classification: "translation",
    verbs: ["compose"],
    tool: TOOLS.orchestrate,
    prefix: ["next", "compose"],
    ...PUBLIC_ENGINE,
    namespace: "public",
    human: [{ command: "compose [args]", summary: "start composition through orchestrate next compose" }],
    all: ["compose [args]"],
  },
  {
    id: "top-status",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["status"],
    tool: TOOLS.utility,
    ...PUBLIC_ENGINE,
    namespace: "engine",
    mutationScope: "none",
    human: [
      { command: "status [args]", summary: "show the current AIDLC status" },
    ],
    all: ["status [args]"],
  },
  {
    id: "top-recompose",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["recompose"],
    tool: TOOLS.utility,
    ...PUBLIC_ENGINE,
    namespace: "engine",
    human: [
      { command: "recompose [args]", summary: "rerun composition through the utility handler" },
    ],
    all: ["recompose [args]"],
  },
  {
    id: "top-now",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["now"],
    tool: TOOLS.utility,
    ...PUBLIC_ENGINE,
    namespace: "engine",
    mutationScope: "none",
    human: [{ command: "now", summary: "print the current UTC time for a document" }],
    all: ["now"],
  },
  {
    id: "top-doctor",
    namespace: "public",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["doctor"],
    tool: TOOLS.doctor,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "interactive-bounded",
    mutationScope: "project-and-machine",
    outputModes: ["human", "quiet", "json"],
    human: [
      { command: "doctor [--check-updates]", summary: "run environment diagnostics" },
    ],
    all: [
      "doctor [--verbose] [--json] [--quiet] [--check-updates] [--release-base-url <url>] [--ca-bundle <path>] [--offline] [--export] [--output <dir>]",
    ],
  },
  {
    id: "top-version",
    namespace: "public",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["version"],
    tool: TOOLS.utility,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human", "json"],
    human: [{ command: "version [--json]", summary: "print the installed AIDLC version" }],
    all: ["version [--json]"],
  },
  {
    id: "top-help",
    namespace: "public",
    group: "top",
    kind: "top-help",
    classification: "help",
    verbs: ["help"],
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human"],
    all: ["help [--all]"],
  },
  {
    id: "top-config",
    namespace: "public",
    group: "top",
    kind: "top-passthrough",
    classification: "translation",
    verbs: ["config"],
    tool: TOOLS.init,
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "project-and-machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "config [args]", summary: "configure, pin, or refresh this project" }],
    all: [
      "config [--harness <name>] [--from <path>|--download [--release-base-url <url>] [--ca-bundle <path>]] [--mcp <defaults|none>] [--pin <version>|--unpin] [--dry-run] [--yes] [--json] [--quiet] [--force] [--plan-token <token>] [--project-dir <path>]",
      "config models [--show [--json]|--check|--reset|--preset <name>|--from <preset|profile> --save-as <name>] [--local|--project|--global]",
      "config models [--deciding-effort <e>] [--reviewing-effort <e>] [--writing-up-effort <e>] [--agent <name> [--effort <e>] [--model <raw-id>]] [--session-model <id>] [--local|--project|--global] [--dry-run] [--yes] [--download [--release-base-url <url>] [--ca-bundle <path>]]",
      "config runtime [--show [--json]|--check|--record-paths|--reset] [--dry-run] [--yes] [--download [--release-base-url <url>] [--ca-bundle <path>]]",
      "config providers [--show [--json]|--check|--reset|--provider <current|amazon-bedrock|other>] [--region <region>] [--profile <profile>] [--opencode-default <yes|no>] [--acknowledge] [--mark-done <id>] [--dry-run] [--yes] [--download [--release-base-url <url>] [--ca-bundle <path>]]",
      "config trust [--show [--json]|--check|--acknowledge|--reset] [--dry-run] [--yes] [--download [--release-base-url <url>] [--ca-bundle <path>]]",
      "config flags [--show [--json]|--check|--reset] [--default-scope <name>] [--swarm <on|off>] [--hook-debug <on|off>] [--sensor-timeout-ms <n>] [--question-retention-days <days|unlimited>] [--bypass <name>] [--clear-bypass <name>] [--local|--project|--global] [--dry-run] [--yes] [--download [--release-base-url <url>] [--ca-bundle <path>]]",
      "config project [--show [--json]|--check|--reset] [--plugins <names|all>] [--mcp <defaults|none>] [--completions <shell|none>] [--dry-run] [--yes] [--download [--release-base-url <url>] [--ca-bundle <path>]]",
      "config --pin <version> [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>] [--offline]",
      "config --unpin",
      "config --channel [stable|preview]",
    ],
  },
  {
    id: "top-update",
    namespace: "public",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["update"],
    tool: TOOLS.lifecycle,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [
      { command: "update [args]", summary: "install and activate a framework release" },
    ],
    all: [
      "update [--version <version>] [--channel <stable|preview>] [--from <dir>] [--release-base-url <url>] [--release-api-url <url>] [--ca-bundle <path>] [--offline] [--check|--dry-run] [--yes] [--json|--quiet]",
    ],
  },
  {
    id: "top-rollback",
    namespace: "system",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["rollback"],
    tool: TOOLS.lifecycle,
    visibility: "hidden",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: ["rollback [<version>|--version <version>|--list] [--allow-harness-loss] [--yes]"],
  },
  {
    id: "top-use",
    namespace: "public",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["use"],
    tool: TOOLS.lifecycle,
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "use <version>", summary: "select an exact machine release" }],
    all: [
      "use <version> [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>] [--offline] [--yes] [--json|--quiet]",
    ],
  },
  {
    id: "top-uninstall",
    namespace: "public",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["uninstall"],
    tool: TOOLS.lifecycle,
    visibility: "public",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "uninstall [--purge]", summary: "remove the machine installation" }],
    all: ["uninstall [--purge] [--yes] [--json|--quiet]"],
  },
  {
    id: "top-completions",
    namespace: "system",
    group: "completions",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["<shell>"],
    tool: TOOLS.completions,
    routeOnly: "tool-passthrough",
    visibility: "hidden",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human"],
    all: ["completions <bash|zsh|fish|powershell>"],
  },
  {
    id: "versions-list",
    namespace: "system",
    group: "versions",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["list"],
    tool: TOOLS.lifecycle,
    prefix: ["versions"],
    visibility: "hidden",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "versions list", summary: "inspect retained releases" }],
    all: ["list"],
  },
  {
    id: "versions-install",
    namespace: "system",
    group: "versions",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["install"],
    tool: TOOLS.lifecycle,
    prefix: ["versions"],
    visibility: "hidden",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    human: [{ command: "versions install", summary: "install a retained release" }],
    all: [
      "install <version> [--from <dir>] [--release-base-url <url>] [--ca-bundle <path>]",
    ],
  },
  {
    id: "versions-prune",
    namespace: "system",
    group: "versions",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["prune"],
    tool: TOOLS.lifecycle,
    prefix: ["versions"],
    visibility: "hidden",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: ["prune [--yes]"],
  },
  {
    id: "state-passthrough",
    group: "state",
    kind: "noun-passthrough",
    classification: "passthrough",
    tool: TOOLS.state,
    ...HIDDEN_ENGINE,
    verbs: [
      "get",
      "set",
      "set-skeleton-stance",
      "set-construction-iteration",
      "set-construction-checkpoints",
      "set-construction-execution",
      "set-construction-verification-command",
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
      "set-unit-ownership",
      "set-unit-gate-rhythm",
      // The engine calls these itself once Delivery Planning records
      // `Construction Iteration: unit-major` with `Unit Ownership: team`: the
      // first two from aidlc-orchestrate.ts spawnState, fold-unit-merge from
      // aidlc-unit.ts runStateFold during `unit land`. Under bun both reach
      // aidlc-state.ts directly, so a missing entry here only ever surfaces on
      // a compiled install, where the engine's own call is refused.
      "refresh-unit-progress",
      "sync-unit-scope-stage",
      "fold-unit-merge",
      "fork",
      "merge",
      "park",
      "unpark",
      "unit",
    ],
    helpSections: [
      {
        label: "records",
        forms: [
          "get",
          "set",
          "set-status",
          "set-skeleton-stance",
          "set-construction-iteration",
          "set-construction-checkpoints",
          "set-construction-execution",
          "set-construction-verification-command",
          "checkbox",
          "count",
          "lookup",
        ],
      },
      {
        label: "lifecycle",
        forms: [
          "init",
          "advance",
          "finalize",
          "complete-workflow",
          "skip",
          "resume",
          "acknowledge-compaction",
          "reuse-artifact",
        ],
      },
      {
        label: "gates",
        forms: ["gate-start", "approve", "reject", "revise"],
      },
      {
        label: "practices",
        forms: ["practices-event", "practices-promote"],
      },
      {
        label: "fork/merge",
        forms: ["fork", "merge"],
      },
      {
        label: "parking",
        forms: ["park", "unpark"],
      },
    ],
  },
  {
    id: "state-utility",
    group: "state",
    kind: "noun-map",
    classification: "translation",
    verbs: ["set-status", "init"],
    tool: TOOLS.utility,
    ...HIDDEN_ENGINE,
    targets: { "set-status": "set-status", init: "state-init" },
  },
  {
    id: "audit-passthrough",
    group: "audit",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["append", "append-batch", "append-raw", "history"],
    tool: TOOLS.audit,
    ...HIDDEN_ENGINE,
  },
  {
    id: "audit-renames",
    group: "audit",
    kind: "noun-map",
    classification: "translation",
    verbs: ["fork", "merge"],
    tool: TOOLS.audit,
    ...HIDDEN_ENGINE,
    targets: { fork: "audit-fork", merge: "audit-merge" },
  },
  {
    // Commit provenance. `resolve` is read-only attribution and `anchor` appends
    // a SOURCE_COMMITTED audit event, so the route mutates the project at most.
    // It is a public noun (`aidlc attest resolve`, no engine prefix) because it
    // is invoked by people and pipelines outside a workflow turn, but hidden
    // from the capped top-level help like the other non-`top` public nouns.
    // Never pinned: `attest` is not a PINNED_TOP_LEVEL_ROUTE, and the launcher
    // drift guard compares the two.
    id: "attest",
    group: "attest",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["resolve", "anchor"],
    tool: TOOLS.attest,
    namespace: "public",
    visibility: "hidden",
    projectRequirement: "required",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "project",
    outputModes: ["human", "json"],
    human: [
      { command: "attest <verb>", summary: "resolve commits/diffs to reviewed units; anchor commits" },
    ],
    all: [
      "resolve [commit|--commit <rev>] [--diff <base>..<head>] [--record-ref <ref>] [--require-trust <level>] [--fail-on <statuses>]",
      "anchor [--commit <rev>] [--reconcile]",
    ],
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
      "ars",
      "compile",
      "resolve",
      "export",
    ],
    tool: TOOLS.graph,
    ...HIDDEN_ENGINE,
  },
  {
    id: "runtime",
    group: "runtime",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["compile", "read", "summary", "fragment-fork", "fragment-merge"],
    tool: TOOLS.runtime,
    ...HIDDEN_ENGINE,
  },
  {
    id: "sensor",
    group: "sensor",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["list", "describe", "fire"],
    tool: TOOLS.sensor,
    ...HIDDEN_ENGINE,
  },
  {
    id: "swarm",
    group: "swarm",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["prepare", "check", "finalize"],
    tool: TOOLS.swarm,
    ...HIDDEN_ENGINE,
  },
  {
    id: "bolt",
    group: "bolt",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["start", "complete", "fail", "abort", "set-autonomy", "checkpoint", "swarm-checkpoint", "dispatch-event", "hold-merge", "release-merge"],
    tool: TOOLS.bolt,
    ...HIDDEN_ENGINE,
  },
  {
    id: "worktree",
    group: "worktree",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["create", "merge", "discard", "restore", "purge", "list", "verify", "info"],
    tool: TOOLS.worktree,
    ...HIDDEN_ENGINE,
  },
  {
    id: "jump",
    group: "jump",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["resolve", "execute", "reopen"],
    tool: TOOLS.jump,
    ...HIDDEN_ENGINE,
  },
  {
    id: "log",
    group: "log",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["decision", "answer", "answers", "review", "link"],
    tool: TOOLS.log,
    ...HIDDEN_ENGINE,
  },
  {
    id: "learnings",
    group: "learnings",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["surface", "persist"],
    tool: TOOLS.learnings,
    ...HIDDEN_ENGINE,
  },
  {
    id: "testing-posture",
    group: "testing-posture",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["resolve", "render", "fingerprint", "verify", "begin", "brief", "reply", "restore"],
    tool: TOOLS.testingPosture,
    ...HIDDEN_ENGINE,
  },
  {
    id: "validate",
    group: "validate",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["outputs"],
    tool: TOOLS.validate,
    ...HIDDEN_ENGINE,
  },
  {
    id: "intent",
    group: "intent",
    kind: "custom",
    classification: "translation",
    verbs: ["list", "switch", "<name>", "create", "archive", "unarchive"],
    custom: "workspace",
    ...PUBLIC_ENGINE,
    human: [
      {
        command: "intent [list|switch|create|archive|unarchive]",
        summary: "list, switch, create, archive, or unarchive intent context",
      },
    ],
    all: [
      "list [--json] [--all]",
      "switch <name>",
      "<name>",
      "create [args]",
      "archive <name> [--reason <text>]",
      "unarchive <name>",
    ],
  },
  {
    id: "space",
    group: "space",
    kind: "custom",
    classification: "translation",
    verbs: ["list", "switch", "<name>", "create"],
    custom: "workspace",
    ...PUBLIC_ENGINE,
    human: [{ command: "space [list|switch|create]", summary: "list, switch, or create a space" }],
    all: ["list", "switch <name>", "<name>", "create <name>"],
  },
  {
    id: "scope",
    group: "scope",
    kind: "noun-map",
    classification: "translation",
    verbs: ["change", "save", "detect", "resolve-env"],
    tool: TOOLS.utility,
    ...PUBLIC_ENGINE,
    targets: {
      change: "scope-change",
      save: "scope-save",
      detect: "detect-scope",
      "resolve-env": "resolve-env-scope",
    },
  },
  {
    id: "config-global",
    namespace: "system",
    group: "config",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["global"],
    tool: TOOLS.machineConfig,
    visibility: "hidden",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: ["global <get|set|clear|list>"],
  },
  {
    id: "config",
    group: "config",
    kind: "custom",
    classification: "translation",
    verbs: [
      "set depth",
      "set test-strategy",
      "set review",
      "set guard-policy",
      "set change-control",
      "set sensors",
      "set learnings",
      "set collaborators",
      "set summary-confirmation",
      "set plan-approval",
      "set guard.plan-approval",
      "set guard.review-freeze",
      "set guard.state-transition",
      "set guard.reviewer-scope",
      "get",
      "list",
    ],
    custom: "config",
    ...PUBLIC_ENGINE,
    visibility: "hidden",
    targets: {
      "set depth": "config-change",
      "set test-strategy": "config-change",
      "set review": "config-change",
      "set guard-policy": "config-change",
      // Retired spelling of guard-policy, accepted for one release.
      "set change-control": "config-change",
      "set sensors": "config-change",
      "set learnings": "config-change",
      "set collaborators": "config-change",
      "set summary-confirmation": "config-change",
      "set plan-approval": "config-change",
      "set guard.plan-approval": "config-change",
      "set guard.review-freeze": "config-change",
      "set guard.state-transition": "config-change",
      "set guard.reviewer-scope": "config-change",
      get: "config-get",
      list: "config-list",
    },
    human: [
      { command: "config get <key>", summary: "print supported project configuration" },
      { command: "config set <key> <value>", summary: "change supported project configuration" },
      { command: "config list", summary: "list supported project configuration" },
    ],
    all: ["set depth <value>", "set test-strategy <value>", "set review <value>", "set guard-policy <strict|relaxed|off>", "set sensors <on|off>", "set learnings <on|off>", "set summary-confirmation <on|off>", "set guard.<fence> <on|off>", "get <key>", "list"],
  },
  {
    id: "plugin",
    group: "plugin",
    kind: "custom",
    classification: "translation",
    verbs: ["select", "sync", "list", "validate", "build"],
    custom: "plugin",
    ...PUBLIC_ENGINE,
    visibility: "hidden",
    targets: {
      select: "select-plugins",
      sync: "sync",
      list: "list",
      validate: "plugin-validate",
      build: "plugin-build",
    },
    human: [
      { command: "plugin select [names]", summary: "set enabled plugins" },
      { command: "plugin list [--verbose|--json]", summary: "compare installed and composed plugins" },
      { command: "plugin sync [--prune-missing]", summary: "transactionally compose installed plugins" },
      { command: "plugin validate [path]", summary: "validate an authored plugin" },
      { command: "plugin build <harness> [outDir]", summary: "build an authored plugin for a harness" },
    ],
    all: ["select [names]", "sync [--prune-missing] [--yes]", "list [--verbose] [--json]", "validate [path]", "build <harness> [outDir]"],
  },
  {
    // The plugin AUTHORING surface (v2): `aidlc plugin validate` / `aidlc plugin
    // build` run against a plugin checkout, which is usually NOT an installed
    // project, so this route is public, unpinned, and carries no project
    // requirement. The installed-plugin lifecycle (select/sync/list) stays on
    // the engine `plugin` noun above.
    id: "plugin-author",
    group: "plugin",
    kind: "noun-map",
    classification: "translation",
    verbs: ["validate", "build"],
    tool: TOOLS.utility,
    targets: { validate: "plugin-validate", build: "plugin-build" },
    namespace: "public",
    visibility: "hidden",
    projectRequirement: "none",
    pinPolicy: "active",
    networkPolicy: "forbidden",
    mutationScope: "none",
    outputModes: ["human", "json"],
    all: ["validate [path]", "build <harness> [outDir] [--plugin-root <path>]"],
  },
  {
    // The DocumentKB noun. Unlike `plugin`, the verb IS the subcommand -- these
    // verbs live in their own tool -- so there is no `targets` translation table
    // to keep in step. Only the verbs the tool actually implements are listed:
    // registering a verb the tool would reject turns a clean "unknown verb"
    // error into a confusing one from a layer down.
    id: "knowledge",
    group: "knowledge",
    // `noun-passthrough`, NOT `top-passthrough`: this route's group is
    // "knowledge", and the two resolvers split on group. `resolveTop` only
    // iterates `group === "top"` routes, so it never saw this one; `resolveNoun`
    // did see it but handles only `noun-passthrough`/`noun-map`/`custom`/
    // `routing-only`, so it fell through to "unknown verb". The result was that
    // NO knowledge verb ran through the compiled dispatcher while the tool
    // itself worked perfectly when invoked directly -- which is why the defect
    // survived a review round in which it was reported, claimed fixed, and never
    // executed. The dispatcher test below runs every verb rather than asserting
    // this literal, because reading the route is exactly what missed it.
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["onboard", "sync", "list", "show", "associate", "dissociate", "rebind", "summarize", "help"],
    tool: TOOLS.knowledge,
    ...PUBLIC_ENGINE,
    // ONE line in the human help, which is capped at 20 lines: it is a summary
    // for a person deciding what to type, not the surface. Every verb still
    // appears in `help --all` via `all` below.
    human: [
      { command: "knowledge <verb>", summary: "index and read customer documents" },
    ],
    all: [
      "onboard [path]", "sync", "list", "show <id>",
      "associate <id> --intent [slug]", "dissociate <id> --intent [slug]",
      "rebind <id> --to <path>",
      "summarize <id> --text-file <path> --source-revision <sha256>",
    ],
  },
  {
    id: "gen",
    group: "gen",
    kind: "custom",
    classification: "translation",
    verbs: ["runners", "runners --check", "runner-list", "runner-scopes", "stage-table", "scope-table"],
    custom: "gen",
    tool: TOOLS.runnerGen,
    ...HIDDEN_ENGINE,
    all: ["runners [args]", "runners --check", "runner-list", "runner-scopes", "stage-table [args]", "scope-table [args]"],
  },
  {
    id: "workspace",
    group: "workspace",
    kind: "noun-map",
    classification: "translation",
    verbs: [
      "detect",
      "reclassify",
      "codekb",
      "codekb-scope-diff",
      "codekb-snapshot",
      "codekb-publish",
      "project-description",
      "document-input",
    ],
    tool: TOOLS.utility,
    ...HIDDEN_ENGINE,
    targets: {
      detect: "detect",
      reclassify: "reclassify",
      codekb: "codekb-path",
      "codekb-scope-diff": "codekb-scope-diff",
      "codekb-snapshot": "codekb-snapshot",
      "codekb-publish": "codekb-publish",
      "project-description": "project-description",
      "document-input": "document-input",
    },
  },
  {
    id: "review-brief",
    group: "review-brief",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["review", "context", "summary"],
    tool: TOOLS.reviewBrief,
    ...HIDDEN_ENGINE,
  },
  {
    id: "workspace-sync",
    namespace: "system",
    group: "workspace-sync",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["<args>"],
    tool: TOOLS.workspaceSync,
    routeOnly: "tool-passthrough",
    visibility: "hidden",
    projectRequirement: "required",
    pinPolicy: "pinned",
    networkPolicy: "required",
    mutationScope: "project",
    outputModes: ["human", "quiet", "json"],
    all: ["[--force] [--project-dir <path>]"],
  },
  {
    id: "engine-orchestrate",
    group: "orchestrate",
    kind: "noun-passthrough",
    classification: "passthrough",
    verbs: ["next", "continue", "report", "park", "wait", "team-board"],
    tool: TOOLS.orchestrate,
    ...HIDDEN_ENGINE,
    all: [
      "next [args]",
      "continue <token>",
      "report [args]",
      "park [args]",
      "wait --stage <slug> --for collaborators|artifacts|review [--unit <unit>] [--review-file <path>] [--timeout <seconds>]",
      "team-board [--snapshot] [--space <name>] [--intent <name>]",
    ],
  },
  {
    id: "engine-orchestrate-help",
    group: "orchestrate",
    kind: "noun-map",
    classification: "translation",
    verbs: ["help"],
    tool: TOOLS.utility,
    targets: { help: "help" },
    ...HIDDEN_ENGINE,
    all: ["help"],
  },
  ...SENSOR_WORKERS.map(([sensorId, tool]): Route => {
    const group = `sensor-${sensorId}`;
    return {
    id: `engine-${group}`,
    namespace: "engine",
    group,
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["<args>"],
    tool,
    routeOnly: "tool-passthrough",
    visibility: "hidden",
    projectRequirement: "required",
    pinPolicy: "pinned",
    networkPolicy: "forbidden",
    mutationScope: "project",
    outputModes: ["human", "quiet", "json"],
  };
  }),
  {
    id: "system-lifecycle",
    namespace: "system",
    group: "lifecycle",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["<command>"],
    tool: TOOLS.lifecycle,
    routeOnly: "tool-passthrough",
    visibility: "hidden",
    projectRequirement: "optional",
    pinPolicy: "active",
    networkPolicy: "explicit-only",
    mutationScope: "machine",
    outputModes: ["human", "quiet", "json"],
    all: [
      "install-apply --from <dir> --version <version> [args]",
      "install-profile --profile <path> --bin-dir <path> [args]",
    ],
  },
  {
    id: "hook",
    group: "hook",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["<name>"],
    routeOnly: "hook",
    ...HIDDEN_ENGINE,
    all: ["<name>"],
  },
  {
    id: "statusline",
    group: "top",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["statusline"],
    routeOnly: "statusline",
    ...HIDDEN_ENGINE,
    all: ["statusline"],
  },
  {
    id: "adapter",
    group: "top",
    kind: "routing-only",
    classification: "routing-only",
    verbs: ["adapter"],
    routeOnly: "adapter",
    ...HIDDEN_ENGINE,
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
  | { type: "version"; json: boolean }
  | { type: "stub"; message: string; code: number }
  | { type: "help"; scope: "human" | "engine" | "system" | "all" | "config" }
  | { type: "error"; message: string; humanMessage?: string; code: number };

function text(fd: number, value: string | Uint8Array): void {
  if (typeof value === "string") {
    writeSync(fd, value);
    return;
  }
  writeSync(fd, value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Opt-in hook phase trace; aidlc-hook-trace.ts owns the switch and the format.
// It is loaded only when its variable is set, so a runtime tree without that
// file dispatches exactly as before.
function hookTrace(phase: string, detail?: Record<string, unknown>): void {
  if (!process.env.AIDLC_HOOK_TRACE_DIR) return;
  try {
    (require("./aidlc-hook-trace.ts") as typeof import("./aidlc-hook-trace.ts")).hookTrace(phase, detail);
  } catch {
    // Diagnostics only.
  }
}

// Hooks enter as `engine hook <name>`, or through a harness adapter as
// `engine adapter <harness> <target>`; only those routes are traced.
export function tracedHookRoute(argv: readonly string[]): "hook" | "adapter" | undefined {
  return argv[0] === "engine" && (argv[1] === "hook" || argv[1] === "adapter") && argv[2]
    ? argv[1]
    : undefined;
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

type AdapterHarness = "codex" | "copilot" | "cursor" | "kiro" | "kiro-ide";

const ADAPTER_HARNESS_LEAF: Record<AdapterHarness, string> = {
  codex: ".codex",
  copilot: ".aidlc",
  cursor: ".cursor",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
};

function isAdapterHarness(value: string): value is AdapterHarness {
  return Object.hasOwn(ADAPTER_HARNESS_LEAF, value);
}

function adapterFile(harness: AdapterHarness): string {
  if (harness === "codex") return "aidlc-codex-adapter.ts";
  if (harness === "copilot") return "aidlc-copilot-adapter.ts";
  if (harness === "cursor") return "aidlc-cursor-adapter.ts";
  return "aidlc-kiro-adapter.ts";
}

// The KAS adapter reads its own payload, and only for the targets that need one,
// because Kiro IDE 0.12 left stdin open; every other adapter is handed stdin.
// `kiro-ide` names the KAS adapter. `kiro` names whichever Kiro tree carries the
// adapter file, so its layout decides.
function kasAdapter(action: Extract<Action, { type: "adapter" }>): boolean {
  if (action.harness === "kiro-ide") return true;
  return action.harness === "kiro" && kiroTreeLayout(dirname(dirname(action.path))) === "kas";
}

// The distribution name can come from project metadata and the harness
// directory from the environment, so the packaged path counts only when each is
// one directory inside the executable's runtime/ tree. Anything else resolves
// to no file, which the callers report as not available.
function packagedHookPath(file: string, runtimeLeaf: string, harness?: AdapterHarness): string {
  const runtimeDir = join(dirname(process.execPath), "runtime");
  const distributionRoot = packagedDistributionRoot(runtimeLeaf, harness);
  const harnessRoot = join(distributionRoot, runtimeLeaf);
  return dirname(distributionRoot) === runtimeDir && dirname(harnessRoot) === distributionRoot
    ? join(harnessRoot, "hooks", file)
    : "";
}

// The compiled engine runs only the hook and adapter files packaged beside its
// executable. A native project also holds copies of them, and those are project
// files: preferring them would let a changed project run in place of the
// installed runtime. A missing packaged file is a damaged install, so it fails
// at the caller instead of falling back to the project. The statusline only
// renders and is documented as customizable in the project, so it keeps the
// project-first order. The Bun dispatcher (the copy channel and source
// checkouts) keeps resolving beside itself and then in the project, because
// there the project holds the runtime.
export function resolveHookPath(
  file: string,
  harness?: AdapterHarness,
  projectDir = process.cwd(),
  compiled = isCompiledExecutable(),
): string {
  const moduleRelative = join(dispatcherDir(), "..", "hooks", file);
  const runtimeLeaf = harness
    ? ADAPTER_HARNESS_LEAF[harness]
    : runtimeHarnessDir(projectDir);
  const leaves = harness
    ? [ADAPTER_HARNESS_LEAF[harness]]
    : [
        runtimeLeaf,
        ...discoverProjectHarnesses(projectDir).map((candidate) => candidate.harnessDir),
        ".claude",
        ".kiro",
        ".codex",
        ".cursor",
      ].filter((value, index, values): value is string =>
        typeof value === "string" && value.length > 0 && values.indexOf(value) === index
      );
  const installed = leaves.map((leaf) => join(projectDir, leaf, "hooks", file));
  const executableRelative = packagedHookPath(file, runtimeLeaf, harness);
  if (compiled) {
    if (file !== "aidlc-statusline.ts") return executableRelative;
    return [...installed, executableRelative].find((candidate) => existsSync(candidate)) ??
      executableRelative;
  }
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

// The tool scripts behind a route that can change the machine (a release,
// machine-wide settings, the installation). Copy channels pre-approve
// AI-DLC's other tool scripts, never these, so running one directly shows the
// host's own prompt.
export function machineReachingTools(): string[] {
  return [...new Set(
    ROUTES.filter((route) => route.mutationScope === "machine" || route.mutationScope === "project-and-machine")
      .map((route) => route.tool)
      .filter((tool): tool is string => tool !== undefined),
  )].sort();
}

// AI-DLC's tool scripts a copy channel pre-approves: every one but those.
export function copyChannelToolScripts(): string[] {
  const machine = new Set(machineReachingTools());
  return [...new Set(Object.values(TOOLS))].filter((tool) => !machine.has(tool)).sort();
}

// The dispatcher's public commands, outside its engine namespace, that every
// install pre-approves, each spelled exactly as AI-DLC runs it: the doctor,
// status and version utilities in both spellings agents use (doctor with or
// without `--verbose`), config's read-only forms (`--show`, with or without
// `--json`, top level or per section, and `--help`), and
// turning one recorded check back on
// (`config flags --clear-bypass <switch> --yes`, the form the skills name),
// which only ever raises a check. A host that matches text as written cannot
// tell a quoted or re-spelled machine-wide config flag from a project one, so
// every other config command, bare `config` (the guided setup) and turning a
// check off included, is left to the host's prompt.
export function copyChannelDispatcherCommands(): string[] {
  // Only the packager and the tests ask for this list, so the settings reader
  // loads here and the dispatcher's own start stays as light as before.
  const { RECORDABLE_PROJECT_BYPASSES } = require("./aidlc-settings.ts") as typeof import("./aidlc-settings.ts");
  return [
    "doctor",
    "doctor --verbose",
    "version",
    "--doctor",
    "--doctor --verbose",
    "--version",
    "status",
    "--status",
    "config --help",
    // An unknown option there, answered with the config usage line and no
    // change; agents run it first for "show my settings".
    "config --show",
    "config --show --json",
    ...CONFIG_SECTIONS.flatMap((section) => [
      `config ${section} --show`,
      `config ${section} --show --json`,
      `config ${section} --help`,
    ]),
    ...RECORDABLE_PROJECT_BYPASSES.map((name) => `config flags --clear-bypass ${name} --yes`),
  ];
}

export function renderHumanHelp(): string {
  const invoke = aidlcInvocation();
  const out = process.stdout;
  const row = (name: string, summary: string): string =>
    `  ${cmd(name, out)}${" ".repeat(12 - name.length)}${summary}`;
  return [
    "aidlc - structured AI-driven development for your coding agent",
    "",
    heading("USAGE", out),
    `  ${cmd(`${invoke} <command> [flags]`, out)}`,
    "",
    heading("SET UP A PROJECT", out),
    row("config", "Set up, refresh, or pin this project (run bare for the guided setup)"),
    row("doctor", "Check this machine and project, with fixes for anything wrong"),
    "",
    heading("MANAGE THE MACHINE INSTALL", out),
    row("update", "Install and switch to a newer release"),
    row("use", "Switch to an exact installed release"),
    row("version", "Print binary and runtime versions"),
    row("uninstall", "Remove aidlc from this machine"),
    "",
    heading("EXAMPLES", out),
    `  ${cmd(`${invoke} config`, out)}                     guided setup in the current project`,
    `  ${cmd(`${invoke} config models --show`, out)}       see which model each agent uses, and why`,
    `  ${cmd(`${invoke} doctor`, out)}                     find out why something isn't working`,
    "",
    heading("LEARN MORE", out),
    dim(`  Use '${invoke} <command> --help' for more about a command.`, out),
    dim("  Docs: https://awslabs.github.io/aidlc-workflows/", out),
    dim(`  Agents: workflows run through '${invoke} engine' - see '${invoke} engine --help'.`, out),
    "",
  ].join("\n");
}

const COMMAND_HELP_USAGE: Record<PublicCommand, string> = {
  config: "aidlc config [options]",
  doctor: "aidlc doctor [options]",
  version: "aidlc version [--json]",
  update: "aidlc update [options]",
  use: "aidlc use <version> [options]",
  uninstall: "aidlc uninstall [options]",
};

const ROOT_CONFIG_HELP_VALUE_FLAGS = new Set([
  "--ca-bundle",
  "--channel",
  "--from",
  "--harness",
  "--mcp",
  "--pin",
  "--plan-token",
  "--project-dir",
  "--release-base-url",
]);

function publicCommandFromToken(token: string | undefined): PublicCommand | null {
  if ((PUBLIC_COMMANDS as readonly (string | undefined)[]).includes(token)) {
    return token as PublicCommand;
  }
  if (token === "--doctor") return "doctor";
  if (token === "--version") return "version";
  return null;
}

export function renderCommandHelp(command: PublicCommand): string {
  const route = ROUTES.find((candidate) =>
    candidate.namespace === "public" &&
    candidate.group === "top" &&
    candidate.verbs.includes(command)
  );
  if (!route) throw new Error(`dispatcher route registry is missing public command ${command}`);
  const invoke = aidlcInvocation();
  const out = process.stdout;
  if (command === "config") {
    const sectionRow = (name: string, summary: string): string =>
      `  ${cmd(name, out)}${" ".repeat(12 - name.length)}${summary}`;
    return [
      "Set up, refresh, or change AI-DLC project configuration",
      "",
      heading("USAGE", out),
      `  ${cmd(`${invoke} config`, out)}`,
      `  ${cmd(`${invoke} config <section> [flags]`, out)}`,
      "",
      heading("SECTIONS", out),
      sectionRow("models", "Which model and effort each agent uses, or the Kiro CLI session model (presets: thorough, balanced, minimal)"),
      sectionRow("runtime", "Whether hooks can find bun, aidlc, and the selected harness"),
      sectionRow("providers", "Provider, AWS region/profile, and manual provider actions"),
      sectionRow("trust", "Host trust and command allowlist acknowledgement"),
      sectionRow("flags", "Default scope, swarm, hook debug, sensor timeout, and bypasses"),
      sectionRow("project", "Plugins, MCP servers, and shell completions"),
      "",
      heading("COMMON FLAGS", out),
      "  --pin <version>   Pin this project to an installed release",
      "  --download        Fetch and verify the release this project needs, if it is missing",
      "  --channel [name]  Show or set the machine release channel (stable, preview)",
      "  --show            Show one section, or every section with no section named, without changing it",
      "  --dry-run         Print the transaction plan without writing",
      "  --yes             Confirm explicit choices; it never chooses values",
      "",
      heading("EXAMPLES", out),
      `  ${cmd(`${invoke} config`, out)}`,
      `  ${cmd(`${invoke} config --show`, out)}`,
      `  ${cmd(`${invoke} config models --show`, out)}`,
      `  ${cmd(`${invoke} config models --preset thorough --project --yes`, out)}`,
      "",
      dim("Every interactive question has an equivalent flag for non-interactive use.", out),
      dim(`Full flag reference: ${invoke} config <section> --help`, out),
      "",
    ].join("\n");
  }
  const descriptions: Record<Exclude<PublicCommand, "config">, string> = {
    doctor: "Check this machine and project and show a fix for every problem",
    version: "Print binary and selected runtime versions",
    update: "Install and switch to a newer aidlc release",
    use: "Switch to an exact installed aidlc release",
    uninstall: "Remove aidlc from this machine",
  };
  const examples: Partial<Record<Exclude<PublicCommand, "config">, string[]>> = {
    doctor: [`  ${invoke} doctor`, `  ${invoke} doctor --verbose`],
    update: [
      `  ${invoke} update --check`,
      `  ${invoke} update --dry-run`,
      `  ${invoke} update --channel preview`,
    ],
    use: [`  ${invoke} use 2.6.2`],
    uninstall: [`  ${invoke} uninstall`, `  ${invoke} uninstall --purge`],
  };
  return [
    descriptions[command],
    "",
    heading("USAGE", out),
    `  ${cmd(`${invoke} ${COMMAND_HELP_USAGE[command].replace(/^aidlc\s+/, "")}`, out)}`,
    ...(examples[command]?.length
      ? [
          "",
          heading("EXAMPLES", out),
          ...(examples[command] ?? []).map((line) =>
            `  ${cmd(line.trimStart(), out)}`
          ),
        ]
      : []),
    "",
    dim(`Run '${invoke} --help' for the public command list.`, out),
    "",
  ].join("\n");
}

function commandHelpRequest(argv: readonly string[]): PublicCommand | null {
  const clean = withoutProjectDirFlag(argv);
  const invocation = clean[0];
  const command = publicCommandFromToken(invocation);
  const delimiter = clean.indexOf("--");
  const commandArgs = delimiter < 0 ? clean : clean.slice(0, delimiter);
  if (
    !command ||
    !commandArgs.slice(1).some((token) => token === "--help" || token === "-h")
  ) {
    return null;
  }
  if (command === "config") {
    const normalized = normalizePublicCommandArgv(argv, command, invocation);
    for (let index = 1; index < normalized.length; index++) {
      const token = normalized[index];
      if (ROOT_CONFIG_HELP_VALUE_FLAGS.has(token)) {
        const value = normalized[index + 1];
        if (value && !value.startsWith("-")) index++;
        continue;
      }
      if (token === "--help" || token === "-h") return command;
      if (!token.startsWith("-")) return null;
    }
    return null;
  }
  return command;
}

function stripHelpGroupPrefix(group: string, form: string): string {
  if (form === group) return "";
  return form.startsWith(`${group} `) ? form.slice(group.length + 1) : form;
}

export function renderNamespaceHelp(
  options: NamespaceHelpOptions,
  summaryOverrides: ReadonlyMap<string, string> = new Map(),
): string {
  const lines: string[] = [options.usage, "", options.header];
  const grouped = new Map<string, string[]>();
  const summaries = new Map<string, string>();
  const sections = new Map<string, readonly HelpSection[]>();
  for (const route of ROUTES) {
    if (
      route.namespace !== options.namespace ||
      options.excludedRouteIds?.has(route.id)
    ) {
      continue;
    }
    const group = route.group === "top"
      ? route.id.replace(/^top-/, "")
      : route.group;
    grouped.set(group, [...(grouped.get(group) ?? []), ...routeForms(route)]);
    const summary = summaryOverrides.get(group) ?? route.helpSummary;
    if (summary) summaries.set(group, summary);
    if (route.helpSections) sections.set(group, route.helpSections);
  }
  for (const [group, forms] of grouped) {
    const summary = summaries.get(group);
    if (summary) {
      lines.push(`  ${group}: ${summary}`);
      continue;
    }
    const helpSections = sections.get(group);
    if (helpSections) {
      lines.push(`  ${group}:`);
      for (const section of helpSections) {
        lines.push(`    ${section.label}: ${section.forms.join(", ")}`);
      }
      continue;
    }
    const rendered = forms.map((form) => stripHelpGroupPrefix(group, form));
    if (rendered.length === 1 && rendered[0] === "") {
      lines.push(`  ${group}`);
      continue;
    }
    lines.push(`  ${group}: ${rendered.filter(Boolean).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function renderEngineHelp(): Promise<string> {
  const { sensorHelpSummaries } = await import("./aidlc-sensor.ts");
  return renderNamespaceHelp(ENGINE_NAMESPACE_HELP, sensorHelpSummaries());
}

function renderConfigHelp(): string {
  const route = ROUTES.find((candidate) => candidate.id === "config");
  if (!route) throw new Error("dispatcher route registry is missing engine noun config");
  return [
    "aidlc engine config <verb> [args] [--intent <id>] [--space <name>]",
    "",
    "Settings for the selected piece of work:",
    ...routeForms(route).map((form) => `  ${form}`),
    "",
  ].join("\n");
}

export function renderAllHelp(): string {
  return [
    renderHumanHelp().trimEnd(),
    "",
    "Hidden namespaces:",
    "  engine  Generated harness surfaces only; not for human scripts. Run: aidlc engine --help",
    "  system  This user's installation; unsupported interface. Run: aidlc system --help",
    "",
  ].join("\n");
}

function topLevelError(command: string): Action {
  return {
    type: "error",
    code: 2,
    message: `aidlc: unknown command or noun '${command}'; try 'aidlc --help'\n`,
  };
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const prior = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = prior;
    }
  }
  return row[right.length];
}

function publicCommandError(command: string): Action {
  const invoke = aidlcInvocation();
  const nearest = [...PUBLIC_COMMANDS]
    .map((candidate) => ({ candidate, distance: editDistance(command, candidate) }))
    .sort((left, right) =>
      left.distance - right.distance || left.candidate.localeCompare(right.candidate)
    )[0];
  const tip = nearest && nearest.distance <= 2
    ? `\n  tip: did you mean '${nearest.candidate}'?\n`
    : "";
  return {
    type: "error",
    code: 2,
    message: `aidlc: unknown command or noun '${command}'; try 'aidlc --help'\n`,
    humanMessage:
      `${errorLabel("error:", process.stderr)} unknown command '${command}'\n${
        tip ? `\n  ${tipLabel("tip:", process.stderr)} did you mean '${nearest?.candidate}'?\n` : ""
      }\n` +
      `${heading("usage:", process.stderr)} ${invoke} <command> [flags]\n` +
      `For the full list, run '${invoke} --help'.\n`,
  };
}

function nounError(noun: string, verb: string | undefined, namespace: "engine" | "system" = "engine"): Action {
  const detail = verb ? `unknown verb '${verb}'` : "missing verb";
  return {
    type: "error",
    code: 2,
    message: `aidlc: ${detail} for ${namespace} noun '${noun}'; try 'aidlc ${namespace} --help'\n`,
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
  const command = parseDispatcherWorkspaceCommand(argv);
  if (command.kind === "not-workspace") return nounError(argv[0], argv[1]);
  if (command.kind === "error") {
    return { type: "error", code: 2, message: `${command.message}\n` };
  }
  const utilityArgv = dispatcherWorkspaceUtilityArgv(command);
  if (utilityArgv === null) return nounError(argv[0], argv[1]);
  return { type: "delegate", tool: TOOLS.utility, args: utilityArgv };
}

function handleConfig(route: Route, argv: string[]): Action {
  const verb = argv[1];
  if (verb === "get" || verb === "list") {
    const target = route.targets?.[verb];
    if (target) return { type: "delegate", tool: TOOLS.utility, args: [target, ...argv.slice(2)] };
  }
  if (verb === "--help" || verb === "-h" || verb === "help") return { type: "help", scope: "config" };
  if (verb !== "set") return nounError("config", verb);

  const key = argv[2];
  const value = argv[3];
  if (key === "guard.human-presence") {
    return { type: "error", code: 2, message: `aidlc: ${HUMAN_PRESENCE_NO_SWITCH}\n` };
  }
  const target = route.targets?.[`set ${key}`];
  if (target) {
    const missing = requireValue("config", `set ${key}`, value);
    if (missing) return missing;
    return { type: "delegate", tool: TOOLS.utility, args: [target, `--${key}`, value, ...argv.slice(4)] };
  }
  return nounError("config", key ? `set ${key}` : "set");
}

function handlePlugin(argv: string[]): Action {
  const command = parseDispatcherPluginCommand(argv);
  if (command.kind === "help") {
    return { type: "help", scope: "engine" };
  }
  if (command.kind === "error") {
    return { type: "error", code: 1, message: `${command.message}\n` };
  }
  if (command.kind === "run") {
    if (argv[1] === "list" || argv[1] === "sync") {
      return { type: "delegate", tool: TOOLS.plugin, args: [argv[1], ...argv.slice(2)] };
    }
    return { type: "delegate", tool: TOOLS.utility, args: command.argv };
  }
  return nounError("plugin", argv[1]);
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
  if (route.custom === "plugin") return handlePlugin(argv);
  if (route.custom === "gen") return handleGen(argv);
  return nounError(argv[0], argv[1]);
}

function handleRouteOnly(route: Route, argv: string[]): Action {
  if (route.routeOnly === "tool-passthrough") {
    if (!route.tool) return nounError(argv[0], argv[1]);
    return { type: "delegate", tool: route.tool, args: argv.slice(1) };
  }
  if (route.routeOnly === "hook") {
    const name = argv[1];
    if (!name) return nounError("hook", undefined);
    if (!isSafeName(name)) return nounError("hook", name);
    // 2.8.0 projected the Cursor and Copilot adapters onto this one-argument
    // route (`aidlc engine hook cursor-adapter <target>`), and that wiring is
    // project-owned, so `aidlc update` alone cannot rewrite it. Resolve those
    // two shipped spellings to the adapter action they meant.
    if (name === "cursor-adapter" || name === "copilot-adapter") {
      const harness: AdapterHarness = name === "cursor-adapter" ? "cursor" : "copilot";
      const target = argv[2];
      if (!target) return nounError("adapter", undefined);
      if (!isSafeName(target)) return nounError("adapter", target);
      return {
        type: "adapter",
        harness,
        target,
        extraArgs: argv.slice(3),
        path: resolveHookPath(adapterFile(harness), harness),
      };
    }
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
    const file = adapterFile(harness);
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

function resolveAlias(argv: string[], engineNamespace = false): Action | undefined {
  const head = argv[0];
  if (engineNamespace && head === "__sensor-script-file") {
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
  if (engineNamespace && head === "__sensor-script") {
    const scripts: Record<string, string> = {
      "claim-sources": TOOLS.sensorClaimSources,
      linter: TOOLS.sensorLinter,
      "required-sections": TOOLS.sensorRequiredSections,
      traceability: TOOLS.sensorTraceability,
      "type-check": TOOLS.sensorTypeCheck,
      "upstream-coverage": TOOLS.sensorUpstreamCoverage,
    };
    const tool = scripts[argv[1] ?? ""];
    return tool
      ? { type: "delegate", tool, args: argv.slice(2) }
      : topLevelError(argv.slice(0, 2).join(" "));
  }
  if (head === "--status") return { type: "delegate", tool: TOOLS.utility, args: ["status", ...argv.slice(1)] };
  if (head === "--claim") return { type: "delegate", tool: TOOLS.utility, args: ["claim", ...argv.slice(1)] };
  if (head === "--release") return { type: "delegate", tool: TOOLS.utility, args: ["release", ...argv.slice(1)] };
  if (head === "--doctor") return { type: "delegate", tool: TOOLS.doctor, args: ["doctor", ...argv.slice(1)] };
  if (head === "--version") return { type: "version", json: false };
  if (head === "--resume") return { type: "delegate", tool: TOOLS.orchestrate, args: ["next", "--resume", ...argv.slice(1)] };
  if (head === "--scope") return { type: "delegate", tool: TOOLS.orchestrate, args: ["next", "--scope", ...argv.slice(1)] };
  return undefined;
}

function resolveTop(argv: string[]): Action | undefined {
  const verb = argv[0];
  for (const route of ROUTES.filter((item) =>
    item.group === "top" && item.namespace === "public"
  )) {
    if (!route.verbs.includes(verb)) continue;

    if (route.kind === "top-passthrough" && route.tool) {
      if (verb === "version") return { type: "version", json: false };
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
    if (route.kind === "top-help") return { type: "help", scope: "human" };
    if (route.kind === "routing-only") return handleRouteOnly(route, argv);
  }
  return undefined;
}

function resolveNoun(argv: string[], namespace: Exclude<RouteNamespace, "public">): Action | undefined {
  const noun = argv[0];
  const routes = ROUTES.filter((item) =>
    item.namespace === namespace && item.group === noun
  );
  if (routes.length === 0) return undefined;

  for (const route of routes) {
    if (route.kind === "routing-only") return handleRouteOnly(route, argv);

    const verb = argv[1];
    if (!verb || !route.verbs.includes(verb)) continue;

    if (route.kind === "top-stub") {
      return {
        type: "stub",
        code: 3,
        message: `${noun} ${verb} is reserved for the next lifecycle release\n`,
      };
    }
    if (route.kind === "noun-passthrough" && route.tool) {
      return {
        type: "delegate",
        tool: route.tool,
        args: [...(route.prefix ?? []), verb, ...argv.slice(2)],
      };
    }
    if (route.kind === "noun-map" && route.tool && route.targets) {
      return { type: "delegate", tool: route.tool, args: [route.targets[verb], ...argv.slice(2)] };
    }
  }

  const custom = routes.find((route) => route.kind === "custom");
  if (custom) return handleCustom(custom, argv);
  return nounError(noun, argv[1], namespace);
}

function resolveEngine(argv: string[]): Action {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { type: "help", scope: "engine" };
  }

  const alias = resolveAlias(argv, true);
  if (alias) return alias;

  const noun = resolveNoun(argv, "engine");
  if (noun) return noun;

  const top = ROUTES.find((route) =>
    route.namespace === "engine" &&
    route.group === "top" &&
    route.verbs.includes(argv[0])
  );
  if (top?.kind === "top-passthrough" && top.tool) {
    return { type: "delegate", tool: top.tool, args: [argv[0], ...argv.slice(1)] };
  }

  const routeOnly = ROUTES.find((route) =>
    route.namespace === "engine" &&
    route.group === "top" &&
    route.kind === "routing-only" &&
    route.verbs.includes(argv[0])
  );
  if (routeOnly) return handleRouteOnly(routeOnly, argv);

  return topLevelError(`engine ${argv[0]}`);
}

function resolveSystem(argv: string[]): Action {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { type: "help", scope: "system" };
  }

  const noun = resolveNoun(argv, "system");
  if (noun) return noun;

  const top = ROUTES.find((route) =>
    route.namespace === "system" &&
    route.group === "top" &&
    route.verbs.includes(argv[0])
  );
  if (top?.kind === "top-passthrough" && top.tool) {
    return { type: "delegate", tool: top.tool, args: [argv[0], ...argv.slice(1)] };
  }
  return topLevelError(`system ${argv[0]}`);
}

// Public noun routes (the v2 team/authoring surface): `aidlc unit <verb>` and
// `aidlc plugin <validate|build>` resolve at the top level without the engine
// prefix. A head token whose verb does not match falls through to the public
// unknown-command error rather than a noun error, so `aidlc plugin list`
// remains "unknown command 'plugin'" (that engine surface is `aidlc engine
// plugin list`).
function resolvePublicNoun(argv: string[]): Action | undefined {
  const noun = argv[0];
  const verb = argv[1];
  for (const route of ROUTES.filter((item) =>
    item.namespace === "public" && item.group !== "top" && item.group === noun
  )) {
    if (!verb || !route.verbs.includes(verb)) continue;
    if (route.kind === "noun-passthrough" && route.tool) {
      return {
        type: "delegate",
        tool: route.tool,
        args: [...(route.prefix ?? []), verb, ...argv.slice(2)],
      };
    }
    if (route.kind === "noun-map" && route.tool && route.targets) {
      return { type: "delegate", tool: route.tool, args: [route.targets[verb], ...argv.slice(2)] };
    }
  }
  return undefined;
}

function resolveActionWithoutGlobalFlags(argv: string[]): Action {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { type: "help", scope: "human" };
  }
  if (argv[0] === "help") {
    return {
      type: "help",
      scope: argv[1] === "--all" ? "all" : "human",
    };
  }
  if (argv[0] === "engine") return resolveEngine(argv.slice(1));
  if (argv[0] === "system") return resolveSystem(argv.slice(1));

  const alias = resolveAlias(argv);
  if (alias) return alias;

  const top = resolveTop(argv);
  if (top) return top;

  const publicNoun = resolvePublicNoun(argv);
  if (publicNoun) return publicNoun;

  return publicCommandError(argv[0]);
}

// The 2.8.0 Copilot adapter spawned its core hooks as `aidlc hook <name>` (no
// `engine` namespace). That adapter still lives in every native Copilot project
// configured by 2.8.0. The compiled engine runs its packaged adapter
// instead (resolveHookPath()), but a Bun dispatcher still resolves the project
// copy, so the spelling stays accepted ONLY in the context that adapter's
// children run in: runAdapter()
// pins AIDLC_HARNESS_NAME=copilot and, under the compiled binary, exports
// AIDLC_COMPILED_EXECUTABLE, and the adapter forwards both. Any other caller
// keeps getting `unknown command 'hook'`; `aidlc config` installs the adapter
// that uses the canonical `engine hook` route.
function canonicalizeLegacyCopilotHookArgv(argv: string[]): string[] {
  return argv[0] === "hook" &&
      process.env.AIDLC_HARNESS_NAME === "copilot" &&
      (process.env.AIDLC_COMPILED_EXECUTABLE ?? "") !== ""
    ? ["engine", ...argv]
    : argv;
}

export function resolveAction(
  rawArgv: string[],
  compiled = isCompiledExecutable(),
): Action {
  const argv = canonicalizeLegacyCopilotHookArgv(rawArgv);
  const clean: string[] = [];
  const globalFlags: string[] = [];
  let projectDir: string | undefined;
  let literalArgs = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      literalArgs = true;
      clean.push(argv[i]);
      continue;
    }
    if (
      !literalArgs &&
      LAUNCHER_GLOBAL_FLAGS.has(argv[i])
    ) {
      globalFlags.push(argv[i]);
      continue;
    }
    if (!literalArgs && argv[i].startsWith("--project-dir=")) {
      return {
        type: "error",
        code: 2,
        message: "aidlc: --project-dir takes a separate path value; use --project-dir <path>\n",
      };
    }
    if (literalArgs || argv[i] !== "--project-dir") {
      clean.push(argv[i]);
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      return {
        type: "error",
        code: 2,
        message: "aidlc: --project-dir requires a path value\n",
      };
    }
    if (projectDir !== undefined) {
      return {
        type: "error",
        code: 2,
        message: "aidlc: --project-dir may be specified only once\n",
      };
    }
    projectDir = value;
  }

  const action = resolveActionWithoutGlobalFlags(clean);
  if (action.type === "version" && globalFlags.includes("--json")) {
    action.json = true;
  }
  if (projectDir) {
    const absoluteProjectDir = isAbsolute(projectDir)
      ? projectDir
      : resolve(process.cwd(), projectDir);
    if (action.type === "delegate") {
      const delimiter = action.args.indexOf("--");
      if (delimiter >= 0) action.args.splice(delimiter, 0, "--project-dir", absoluteProjectDir);
      else action.args.push("--project-dir", absoluteProjectDir);
    } else if (action.type === "hook") {
      action.projectDir = absoluteProjectDir;
      action.path = resolveHookPath(`aidlc-${action.name}.ts`, undefined, absoluteProjectDir);
    } else if (action.type === "statusline") {
      action.projectDir = absoluteProjectDir;
      action.path = resolveHookPath("aidlc-statusline.ts", undefined, absoluteProjectDir);
    } else if (action.type === "adapter") {
      action.projectDir = absoluteProjectDir;
      const file = adapterFile(action.harness);
      action.path = resolveHookPath(file, action.harness, absoluteProjectDir);
    } else if (action.type === "sensor-script-file") {
      action.projectDir = absoluteProjectDir;
    }
  } else if (compiled && (action.type === "hook" || action.type === "sensor-script-file")) {
    // The compiled engine loads these modules from the runtime payload beside
    // the executable, so a module's own path names the install, never the
    // project. Pin the host's project: its project environment, else the
    // directory it launched the command in. The statusline and the adapters
    // resolve a project from their host first and hand it to what they run.
    action.projectDir = dispatcherProjectDirFrom(argv);
  }
  if (action.type === "delegate") {
    const delimiter = action.args.indexOf("--");
    // Literal text after `--` may itself contain `--project-dir`. Delegates
    // that scan argv for that flag must find the dispatcher's directory first,
    // so when the caller gave none the resolved directory is pinned ahead of
    // the delimiter. The literal text stays byte-for-byte intact.
    if (delimiter >= 0 && !projectDir) {
      action.args.splice(delimiter, 0, "--project-dir", dispatcherProjectDirFrom(argv));
    }
    if (delimiter >= 0) action.args.splice(action.args.indexOf("--"), 0, ...globalFlags);
    else action.args.push(...globalFlags);
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
  return projectDirFlag(args).value;
}

function runDelegateDev(tool: string, args: string[]): number {
  try {
    const child = Bun.spawnSync([bunExecutable(), toolPath(tool), ...args], { /* dev-mode bun spawn */
      cwd: process.cwd(),
      // The tool reads the same stdin it would read in the compiled binary,
      // so input piped to the command (`--proposal /dev/stdin`) arrives.
      stdin: "inherit",
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

type ToolFile = (typeof TOOLS)[keyof typeof TOOLS];

type DelegateModule = {
  main(argv: string[]): void | Promise<void>;
};

// Issue #1070 shipped in 2.8.0-2.8.2 because reviewBrief was added to TOOLS and
// routed, but this loader's switch never got its arm. Dev mode spawns
// `bun <tool>`, so every test that ran the tool passed; only the compiled binary
// walks this table. The Record<ToolFile, ...> annotation makes a missing loader
// OR a delegate without `export main` a tsc error under `bun run check`. Keep
// import specifiers literal so `bun build --compile` bundles every delegate.
const DELEGATES: Record<ToolFile, () => Promise<DelegateModule>> = {
  "aidlc-attest.ts": () => import("./aidlc-attest.ts"),
  "aidlc-audit.ts": () => import("./aidlc-audit.ts"),
  "aidlc-bolt.ts": () => import("./aidlc-bolt.ts"),
  "aidlc-completions.ts": () => import("./aidlc-completions.ts"),
  "aidlc-doctor.ts": () => import("./aidlc-doctor.ts"),
  "aidlc-graph.ts": () => import("./aidlc-graph.ts"),
  "aidlc-init.ts": () => import("./aidlc-init.ts"),
  "aidlc-jump.ts": () => import("./aidlc-jump.ts"),
  "aidlc-knowledge.ts": () => import("./aidlc-knowledge.ts"),
  "aidlc-learnings.ts": () => import("./aidlc-learnings.ts"),
  "aidlc-lifecycle.ts": () => import("./aidlc-lifecycle.ts"),
  "aidlc-log.ts": () => import("./aidlc-log.ts"),
  "aidlc-machine-config.ts": () => import("./aidlc-machine-config.ts"),
  "aidlc-orchestrate.ts": () => import("./aidlc-orchestrate.ts"),
  "aidlc-plugin.ts": () => import("./aidlc-plugin.ts"),
  "aidlc-review-brief.ts": () => import("./aidlc-review-brief.ts"),
  "aidlc-runner-gen.ts": () => import("./aidlc-runner-gen.ts"),
  "aidlc-runtime.ts": () => import("./aidlc-runtime.ts"),
  "aidlc-sensor-claim-sources.ts": () => import("./aidlc-sensor-claim-sources.ts"),
  "aidlc-sensor-linter.ts": () => import("./aidlc-sensor-linter.ts"),
  "aidlc-sensor-required-sections.ts": () => import("./aidlc-sensor-required-sections.ts"),
  "aidlc-sensor-traceability.ts": () => import("./aidlc-sensor-traceability.ts"),
  "aidlc-sensor-type-check.ts": () => import("./aidlc-sensor-type-check.ts"),
  "aidlc-sensor-upstream-coverage.ts": () => import("./aidlc-sensor-upstream-coverage.ts"),
  "aidlc-sensor.ts": () => import("./aidlc-sensor.ts"),
  "aidlc-state.ts": () => import("./aidlc-state.ts"),
  "aidlc-swarm.ts": () => import("./aidlc-swarm.ts"),
  "aidlc-testing-posture.ts": () => import("./aidlc-testing-posture.ts"),
  "aidlc-unit.ts": () => import("./aidlc-unit.ts"),
  "aidlc-utility.ts": () => import("./aidlc-utility.ts"),
  "aidlc-validate.ts": () => import("./aidlc-validate.ts"),
  "aidlc-workspace-sync.ts": () => import("./aidlc-workspace-sync.ts"),
  "aidlc-worktree.ts": () => import("./aidlc-worktree.ts"),
};

function loadDelegate(tool: string): Promise<DelegateModule> | null {
  return Object.hasOwn(DELEGATES, tool) ? DELEGATES[tool as ToolFile]() : null;
}

async function runDelegateInProcess(tool: string, args: string[]): Promise<number> {
  const previousProjectDir = process.env.AIDLC_PROJECT_DIR;
  const projectDir = delegatedProjectDir(args);
  if (projectDir) process.env.AIDLC_PROJECT_DIR = projectDir;
  try {
    const delegate = loadDelegate(tool);
    if (delegate === null) {
      text(2, `${JSON.stringify({ error: `${tool} has no in-process delegate; DELEGATES in aidlc.ts is out of step with TOOLS` })}\n`);
      return 1;
    }
    const mod = await delegate;
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

let bufferedStdin: string | null = null;

async function readStdin(): Promise<string> {
  if (bufferedStdin === null) bufferedStdin = await Bun.stdin.text();
  return bufferedStdin;
}

async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString("utf-8"));
    const onError = () => finish("");
    timeout = setTimeout(() => {
      process.stdin.pause();
      finish("");
    }, timeoutMs);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
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
    text(2, `aidlc engine hook ${action.name}: not available in this install\n`);
    return 1;
  }
  // Human-turn is an authority boundary. Keep its implementation out of the
  // dispatcher's importable process and invoke only the script entry point, so
  // project code cannot import a public run(input) function and forge a host
  // UserPromptSubmit payload.
  if (action.name === "record-human-turn") {
    const processToken = crypto.randomUUID();
    const dispatcher = isCompiledExecutable()
      ? [process.execPath]
      : [bunExecutable(), fileURLToPath(import.meta.url)];
    const child = Bun.spawn([
      ...dispatcher,
      "--internal-aidlc-record-human-turn",
      action.path,
    ], {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        AIDLC_INTERNAL_HUMAN_TURN_TOKEN: processToken,
      },
    });
    child.stdin.write(await readStdin());
    child.stdin.end();
    hookTrace("hook-child-started", { childPid: child.pid });
    const childCode = await child.exited;
    hookTrace("hook-run-end", { code: childCode });
    return childCode;
  }
  hookTrace("hook-import-begin");
  const mod = await import(pathToFileURL(action.path).href);
  hookTrace("hook-import-end");
  if (typeof mod.run !== "function") {
    text(2, `aidlc engine hook ${action.name}: hook does not export run(input)\n`);
    return 1;
  }
  const code = await runHookModule(mod.run, await readStdin());
  hookTrace("hook-run-end", { code });
  return code;
}

// Claude Code shows a blocking hook's stderr behind the hook's own command
// ("[aidlc engine hook plan-approval-guard]: ..."), and a deny decision on
// stdout with only its reason. So on Claude a PreToolUse refusal also prints
// that decision, with the words it wrote to stderr. Exit 2 blocks on its own,
// so the call stays refused if the JSON is ever not read. Adapters pin their
// own harness name and read stderr, so nothing changes for them.
async function runHookModule(
  run: (input: string) => number | Promise<number>,
  input: string,
): Promise<number> {
  let event: unknown;
  try {
    event = (JSON.parse(input) as { hook_event_name?: unknown }).hook_event_name;
  } catch {
    event = undefined;
  }
  let claude = false;
  try {
    claude = event === "PreToolUse" && runtimeHarnessName() === "claude";
  } catch {
    // No harness to name: the plain refusal stands.
  }
  if (!claude) return await run(input);
  const written: string[] = [];
  let wroteStdout = false;
  const stderrWrite = process.stderr.write;
  const stdoutWrite = process.stdout.write;
  const text = (chunk: unknown): string =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf-8");
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(text(chunk));
    return (stderrWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    wroteStdout = true;
    return (stdoutWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await run(input);
  } finally {
    process.stderr.write = stderrWrite;
    process.stdout.write = stdoutWrite;
  }
  const reason = written.join("").trim();
  // A hook that already answered on stdout keeps its own answer.
  if (code === 2 && reason && !wroteStdout) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`);
  }
  return code;
}

async function runStatusline(action: Extract<Action, { type: "statusline" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, "aidlc engine statusline: not available in this install\n");
    return 1;
  }
  const mod = await import(pathToFileURL(action.path).href);
  if (typeof mod.run !== "function") {
    text(2, "aidlc engine statusline: hook does not export run(input)\n");
    return 1;
  }
  return await mod.run(await readStdin());
}

async function runAdapter(action: Extract<Action, { type: "adapter" }>): Promise<number> {
  if (!existsSync(action.path)) {
    text(2, `aidlc engine adapter ${action.harness} ${action.target}: not available in this install\n`);
    return 1;
  }
  // Dispatcher startup may already have pinned AIDLC_HARNESS_DIR/NAME from
  // the cwd's metadata (compiled mode does so before routing). The adapter's
  // harness is authoritative here: pin both so the core hooks it spawns
  // resolve the matching packaged runtime even when the hook cwd carries no
  // harness metadata (.aidlc is shared by copilot and opencode; the
  // metadata-free fallback names opencode).
  const previousHarness = process.env.AIDLC_HARNESS_DIR;
  const previousHarnessName = process.env.AIDLC_HARNESS_NAME;
  const previousExecutable = process.env.AIDLC_COMPILED_EXECUTABLE;
  process.env.AIDLC_HARNESS_DIR = ADAPTER_HARNESS_LEAF[action.harness];
  process.env.AIDLC_HARNESS_NAME = action.harness;
  if (isCompiledExecutable()) {
    process.env.AIDLC_COMPILED_EXECUTABLE = process.execPath;
  }
  try {
    // Kiro IDE runs these two after every shell command, as one after-shell
    // card. When nothing they read changed since they last found nothing to do,
    // they are skipped before the engine loads; the card is skipped only when
    // both are, and whenever the gate cannot tell, they run as before.
    if (
      kasAdapter(action) &&
      (action.target === "rebuild-stage-graph" || action.target === "sync-workflow-state" || action.target === "after-shell")
    ) {
      const gate = await import("./aidlc-hook-front-gate.ts");
      const dirs = gate.frontGateProjectDirs(action.path);
      const gated = action.target === "after-shell" ? gate.FRONT_GATED_TARGETS : [action.target];
      if (gated.every((target) => gate.frontGateSkips(target, dirs))) {
        hookTrace("adapter-front-gate-skip", { target: action.target });
        return 0;
      }
    }
    hookTrace("adapter-import-begin");
    const mod = await import(pathToFileURL(action.path).href);
    hookTrace("adapter-import-end");
    if (typeof mod.run !== "function") {
      text(2, `aidlc engine adapter ${action.harness} ${action.target}: adapter does not export run(target, input, extraArgs)\n`);
      return 1;
    }
    let input = "";
    if (!kasAdapter(action)) {
      input = await readStdin();
    } else if (
      action.target === "audit-and-sensors" ||
      action.target === "enforce-approval-gate" ||
      action.target === "log-subagent" ||
      action.target === "plan-approval-guard" ||
      action.target === "record-human-turn" ||
      action.target === "rebuild-stage-graph" ||
      action.target === "review-freeze" ||
      action.target === "state-transition-guard" ||
      action.target === "session-start" ||
      action.target === "continue-workflow" ||
      action.target === "verb-intercept" ||
      action.target === "terminal-command-guard" ||
      action.target === "guard-tool-call" ||
      action.target === "after-shell"
    ) {
      // Mirror the adapter entry point's dual-generation channel contract.
      // IDE 0.12 provides USER_PROMPT and leaves stdin open forever, so consume
      // a non-empty env payload immediately. IDE 1.x leaves USER_PROMPT empty
      // and writes+closes stdin; the timeout is only a broken-channel ceiling.
      const legacyPayload = process.env.USER_PROMPT ?? "";
      if (legacyPayload.trim().length > 0) {
        input = legacyPayload;
      } else if (!process.stdin.isTTY) {
        // AIDLC_IDE_STDIN_TIMEOUT_MS mirrors the adapter's test seam so both
        // entry points share one contract.
        const override = Number(process.env.AIDLC_IDE_STDIN_TIMEOUT_MS ?? "");
        const ceiling = Number.isFinite(override) && override > 0 ? override : 2000;
        input = await readStdinWithTimeout(ceiling);
      }
    }
    // An adapter that runs core hooks as child processes shows a stuck child
    // as a file that ends before adapter-run-end.
    const code = await mod.run(action.target, input, action.extraArgs);
    hookTrace("adapter-run-end", { code });
    return code;
  } finally {
    if (previousHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
    else process.env.AIDLC_HARNESS_DIR = previousHarness;
    if (previousHarnessName === undefined) delete process.env.AIDLC_HARNESS_NAME;
    else process.env.AIDLC_HARNESS_NAME = previousHarnessName;
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
  const isCompiled = isCompiledExecutable();
  if (action.type === "delegate") {
    // Tool modules are imported lazily in compiled mode to keep dev-mode startup
    // fast and to avoid loading every tool for help/version calls.
    return isCompiled
      ? await runDelegateInProcess(action.tool, action.args)
      : runDelegateDev(action.tool, action.args);
  }
  if (action.type === "help") {
    const rendered = action.scope === "engine"
      ? await renderEngineHelp()
      : action.scope === "system"
      ? renderNamespaceHelp(SYSTEM_NAMESPACE_HELP)
      : action.scope === "all"
      ? renderAllHelp()
      : action.scope === "config"
      ? renderConfigHelp()
      : renderHumanHelp();
    text(
      1,
      rendered,
    );
    if (action.scope === "human" && process.stdout.isTTY) {
      try {
        const { cachedUpdateNotice } = await import("./aidlc-update.ts");
        const notice = cachedUpdateNotice();
        if (notice) text(1, `\n${notice}\n`);
      } catch {
        // Ambient discovery never makes help fail.
      }
    }
    return 0;
  }
  if (action.type === "version") {
    text(
      1,
      action.json
        ? `${JSON.stringify({
            schemaVersion: 1,
            binaryVersion: AIDLC_VERSION,
            runtimeVersion: AIDLC_VERSION,
          })}\n`
        : `aidlc ${AIDLC_VERSION} (runtime ${AIDLC_VERSION})\n`,
    );
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
    text(2, action.type === "error" ? action.humanMessage ?? action.message : action.message);
    return action.code;
  }
  return 1;
}

// Whether `engine adapter <harness> …` will run the KAS adapter, decided before
// startup buffers stdin for it: the KAS adapter must not have stdin read for it.
function kasAdapterInvocation(argv: string[]): boolean {
  const harness = withoutProjectDirFlag(argv)[2];
  if (harness === "kiro-ide") return true;
  if (harness !== "kiro") return false;
  try {
    const action = resolveAction(argv);
    return action.type === "adapter" && kasAdapter(action);
  } catch {
    return false;
  }
}

// The argv the route table reads: global output flags and --project-dir are
// dropped before the `--` delimiter, so `unit --json land` routes as `unit land`.
export function withoutProjectDirFlag(argv: readonly string[]): string[] {
  const clean: string[] = [];
  let literalArgs = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--") {
      literalArgs = true;
      clean.push(argv[index]);
      continue;
    }
    if (
      !literalArgs &&
      ["--json", "--quiet", "--no-color", "--yes", "--offline", "--verbose"].includes(argv[index])
    ) {
      continue;
    }
    if (!literalArgs && argv[index] === "--project-dir") {
      index++;
      continue;
    }
    clean.push(argv[index]);
  }
  return clean;
}

function normalizePublicCommandArgv(
  argv: readonly string[],
  command: PublicCommand,
  invocation: string = command,
): string[] {
  const normalized: string[] = [command];
  let removedCommand = false;
  let literalArgs = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") {
      literalArgs = true;
      normalized.push(token);
      continue;
    }
    if (!literalArgs && token === "--project-dir") {
      normalized.push(token);
      if (argv[index + 1] !== undefined) normalized.push(argv[++index]);
      continue;
    }
    if (!removedCommand && token === invocation) {
      removedCommand = true;
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}

function routeById(id: string): Route {
  const route = ROUTES.find((candidate) => candidate.id === id);
  if (!route) throw new Error(`dispatcher route registry is missing ${id}`);
  return route;
}

// The plugin terminal subcommands (classifyTerminalCommand) and the
// `engine plugin` verb each one runs.
const PLUGIN_TERMINAL_VERBS: Readonly<Record<string, string>> = {
  "plugin-list": "list",
  "plugin-sync": "sync",
  "select-plugins": "select",
  "plugin-validate": "validate",
  "plugin-build": "build",
};

/**
 * The dispatcher argv (after `aidlc`, or after the copy channel's
 * `bun <harness>/tools/aidlc.ts`) for one classified `/aidlc` terminal command
 * (classifyTerminalCommand in aidlc-lib.ts). Most of these live under
 * `engine`, but a verb this table makes public at the top level (doctor,
 * version) has no `engine` spelling, and `/aidlc`'s own usage is the engine's
 * `orchestrate help`, the text `aidlc-utility.ts help` prints, not the
 * binary's command list. The engine's read-only flag directive and the Kiro
 * adapters' native path all read this.
 */
export function terminalDispatcherArgv(command: {
  subcommand: string;
  arg?: string;
  args?: readonly string[];
  source: string;
}): string[] {
  const forwarded = command.args ?? (command.arg !== undefined ? [command.arg] : []);
  if (command.source === "plugin-verb" && PLUGIN_TERMINAL_VERBS[command.subcommand]) {
    return ["engine", "plugin", PLUGIN_TERMINAL_VERBS[command.subcommand], ...forwarded];
  }
  if (command.source === "knowledge-verb") {
    return ["engine", "knowledge", command.subcommand, ...forwarded];
  }
  if (command.subcommand === "help") return ["engine", "orchestrate", "help"];
  if (command.subcommand === "space-create") return ["engine", "space", "create", ...forwarded];
  if (command.subcommand === "intent-create") return ["engine", "intent", "create", ...forwarded];
  const publicTop = ROUTES.some((route) =>
    route.namespace === "public" && route.group === "top" && route.verbs.includes(command.subcommand)
  );
  return publicTop ? [command.subcommand, ...forwarded] : ["engine", command.subcommand, ...forwarded];
}

export function routePolicyFor(argv: readonly string[]): Route | null {
  const clean = withoutProjectDirFlag(argv);
  const head = clean[0];
  if (!head || head === "--help" || head === "-h" || head === "help") {
    return routeById("top-help");
  }
  const aliasRoutes: Readonly<Record<string, string>> = {
    "--claim": "unit",
    "--release": "unit",
    "--status": "top-status",
    "--doctor": "top-doctor",
    "--version": "top-version",
    "--resume": "top-orchestrate",
    "--scope": "top-orchestrate",
  };
  if (aliasRoutes[head]) return routeById(aliasRoutes[head]);

  if (head === "engine" || head === "system") {
    const namespace = head;
    const delegate = clean[1];
    const command = clean[2];
    if (!delegate || delegate === "--help" || delegate === "-h" || delegate === "help") {
      return head === "engine" ? routeById("top-help") : null;
    }
    if (
      namespace === "engine" &&
      (delegate === "__sensor-script" || delegate === "__sensor-script-file")
    ) {
      return routeById("sensor");
    }
    const nounRoutes = ROUTES.filter((route) =>
      route.namespace === namespace && route.group === delegate
    );
    if (nounRoutes.length > 0) {
      const matched = nounRoutes.find((route) => route.verbs.includes(command ?? "")) ??
        nounRoutes.find((route) =>
          route.kind === "custom" &&
          route.verbs.includes(`${command ?? ""} ${clean[3] ?? ""}`)
        ) ??
        nounRoutes.find((route) =>
          route.kind === "custom" &&
          route.verbs.includes("<name>") &&
          Boolean(command && isSafeName(command))
        ) ??
        nounRoutes.find((route) => route.kind === "routing-only") ??
        undefined;
      if (matched) return matched;
    }
    return ROUTES.find((route) =>
      route.namespace === namespace &&
      route.group === "top" &&
      route.verbs.includes(delegate)
    ) ?? null;
  }

  const top = ROUTES.find((route) =>
    route.namespace === "public" &&
    route.group === "top" &&
    route.verbs.includes(head)
  );
  if (top) return top;
  const publicNoun = ROUTES.find((route) =>
    route.namespace === "public" &&
    route.group !== "top" &&
    route.group === head &&
    route.verbs.includes(clean[1] ?? "")
  );
  if (publicNoun) return publicNoun;
  return null;
}

function routePinPolicy(argv: readonly string[]): PinPolicy {
  const route = routePolicyFor(argv);
  if (
    route &&
    (route.pinPolicy === "pinned") !== launcherRouteUsesPin(argv)
  ) {
    throw new Error(`launcher pin policy drift for route ${route.id}`);
  }
  return route?.pinPolicy ?? "active";
}

function dispatcherProjectDirFrom(argv: readonly string[]): string {
  const explicit = projectDirFlag(argv).value;
  const value = explicit || process.env.AIDLC_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR || process.env.KIRO_PROJECT_DIR;
  return value
    ? (isAbsolute(value) ? value : resolve(process.cwd(), value))
    : process.cwd();
}

// The dispatcher owns the --project-dir grammar before the `--` delimiter:
// only the two-token form is accepted, because delegates that also parse
// `--project-dir=<path>` would otherwise mutate a directory the dispatcher's
// policy never inspected. Tokens after `--` are literal task text and are never
// interpreted here; resolveAction() pins the dispatcher's own project
// directory ahead of that delimiter so no delegate can route on the literal.
function projectDirFlag(argv: readonly string[]): {
  value?: string;
  error?: string;
} {
  let value: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") break;
    if (token.startsWith("--project-dir=")) {
      return { error: "--project-dir takes a separate path value; use --project-dir <path>" };
    }
    if (token !== "--project-dir") continue;
    const candidate = argv[++index];
    if (!candidate || candidate.startsWith("--")) {
      return { error: "--project-dir requires a path value" };
    }
    if (value !== undefined) {
      return { error: "--project-dir may be specified only once" };
    }
    value = candidate;
  }
  return { value };
}

async function dispatchPinnedVersion(
  argv: string[],
  input: string | null,
): Promise<number | null> {
  if (routePinPolicy(argv) !== "pinned") return null;
  const projectDir = dispatcherProjectDirFrom(argv);
  const pinPath = join(projectDir, ".aidlc-version");
  if (!existsSync(pinPath)) return null;
  const { resolvePinnedDispatch } = await import("./aidlc-lifecycle.ts");
  const result = resolvePinnedDispatch(argv, projectDir, { reserve: true });
  if (result.kind === "none") return null;
  if (result.kind === "failure") {
    return renderDispatcherFailure(
      argv,
      result.code,
      result.message,
      result.remediation,
    );
  }
  const releaseReservation = result.release;
  if (!releaseReservation) {
    text(
      2,
      `aidlc: another AI-DLC command is still changing this machine's install, so this ran on aidlc ${result.version} without waiting for it to finish.\n`,
    );
  }
  try {
    const child = Bun.spawnSync([result.executable, ...argv], {
      cwd: process.cwd(),
      stdin: input === null ? "inherit" : new TextEncoder().encode(input),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        AIDLC_PIN_DISPATCHED: result.version,
        AIDLC_ACTIVE_VERSION: AIDLC_VERSION,
      },
    });
    return child.exitCode ?? 1;
  } finally {
    releaseReservation?.();
  }
}

function refuseUnpinnedMajorSkew(argv: readonly string[]): number | null {
  if (routePinPolicy(argv) !== "pinned") return null;
  const projectDir = dispatcherProjectDirFrom(argv);
  if (existsSync(join(projectDir, ".aidlc-version"))) return null;
  for (const harness of discoverProjectHarnesses(projectDir)) {
    if (
      harness.frameworkVersion &&
      harness.frameworkVersion.split(".")[0] !== AIDLC_VERSION.split(".")[0]
    ) {
      return renderDispatcherFailure(
        argv,
        1,
        `project runtime ${harness.frameworkVersion} is incompatible with selected engine ${AIDLC_VERSION}`,
        "aidlc use <installed-version> or aidlc config",
      );
    }
  }
  return null;
}

function requestedOutputMode(argv: readonly string[]): "human" | "quiet" | "json" {
  const delimiter = argv.indexOf("--");
  const globalArgs = delimiter < 0 ? argv : argv.slice(0, delimiter);
  if (globalArgs.includes("--json")) return "json";
  if (globalArgs.includes("--quiet")) return "quiet";
  return "human";
}

function renderDispatcherFailure(
  argv: readonly string[],
  code: number,
  message: string,
  remediation?: string,
): number {
  const cleanMessage = message.replace(/^aidlc:\s*/, "").trim();
  const mode = requestedOutputMode(argv);
  if (mode === "json") {
    text(1, `${
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        code,
        status: code === 2 ? "usage" : code === 3 ? "unavailable" : "failed",
        message: cleanMessage,
        ...(remediation ? { remediation } : {}),
      })
    }\n`);
  } else if (mode === "quiet") {
    text(1, `${remediation ?? cleanMessage}\n`);
  } else {
    text(2, `${errorLabel("aidlc:", process.stderr)} ${cleanMessage}\n`);
    if (remediation) {
      text(2, `${fixLabel("fix:", process.stderr)} ${remediation}\n`);
    }
  }
  return code;
}

function basicPolicyError(route: Route, argv: readonly string[]): string | null {
  const output = requestedOutputMode(argv);
  if (!route.outputModes.includes(output)) {
    return `${route.id} does not support --${output}`;
  }
  const delimiter = argv.indexOf("--");
  const globalArgs = delimiter < 0 ? argv : argv.slice(0, delimiter);
  if (route.networkPolicy === "required" && globalArgs.includes("--offline")) {
    return `${route.id} requires network access and cannot run with --offline`;
  }
  return null;
}

type SimplePublicGrammar = {
  values: ReadonlySet<string>;
  bare: ReadonlySet<string>;
};

const SIMPLE_PUBLIC_GRAMMARS: Readonly<
  Partial<Record<PublicCommand, SimplePublicGrammar>>
> = {
  doctor: {
    values: new Set([
      "--ca-bundle",
      "--output",
      "--project-dir",
      "--release-base-url",
    ]),
    bare: new Set([
      "--check-updates",
      "--export",
      "--json",
      "--no-color",
      "--offline",
      "--quiet",
      "--verbose",
    ]),
  },
  version: {
    values: new Set(["--project-dir"]),
    bare: new Set(["--json", "--no-color"]),
  },
};

function validateSimplePublicGrammar(
  command: PublicCommand,
  argv: readonly string[],
): string | null {
  const grammar = SIMPLE_PUBLIC_GRAMMARS[command];
  if (!grammar) return null;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      return `unexpected ${command} positional ${JSON.stringify(token)}`;
    }
    if (grammar.values.has(token)) {
      if (seen.has(token)) return `${token} may be specified only once`;
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return `${token} requires a value`;
      seen.add(token);
      index++;
      continue;
    }
    if (!grammar.bare.has(token)) return `unknown ${command} option ${token}`;
    if (seen.has(token)) return `${token} may be specified only once`;
    seen.add(token);
  }
  if (argv.includes("--json") && argv.includes("--quiet")) {
    return "--json and --quiet are mutually exclusive";
  }
  if (
    command === "doctor" &&
    argv.includes("--output") &&
    !argv.includes("--export")
  ) {
    return "--output requires --export";
  }
  if (
    command === "doctor" &&
    argv.includes("--export") &&
    (argv.includes("--json") || argv.includes("--quiet"))
  ) {
    return "--export cannot be combined with --json or --quiet";
  }
  return null;
}

async function publicCommandGrammarError(
  route: Route | null,
  argv: readonly string[],
): Promise<string | null> {
  if (
    route?.namespace !== "public" ||
    route.group !== "top"
  ) {
    return null;
  }
  const command = route.verbs[0] as PublicCommand | undefined;
  const invocation = withoutProjectDirFlag(argv)[0];
  if (
    !command ||
    !(PUBLIC_COMMANDS as readonly string[]).includes(command) ||
    publicCommandFromToken(invocation) !== command
  ) {
    return null;
  }
  const normalized = normalizePublicCommandArgv(argv, command, invocation);
  if (command === "config") {
    const { validatePublicConfigArgs } = await import("./aidlc-init.ts");
    return validatePublicConfigArgs(normalized);
  }
  if (command === "update" || command === "use" || command === "uninstall") {
    const { validatePublicLifecycleArgs } = await import("./aidlc-lifecycle.ts");
    return validatePublicLifecycleArgs(normalized);
  }
  return validateSimplePublicGrammar(command, normalized);
}

function renderPublicGrammarFailure(
  argv: readonly string[],
  message: string,
): number {
  const configSection = /^unknown config section "([^"]+)";/.exec(message)?.[1];
  if (
    configSection &&
    requestedOutputMode(argv) === "human" &&
    (process.stdin.isTTY || process.env.AIDLC_TEST_CONFIG_TTY === "1")
  ) {
    const invoke = aidlcInvocation();
    const nearest = [
      "models",
      "runtime",
      "providers",
      "trust",
      "flags",
      "project",
    ]
      .map((candidate) => ({
        candidate,
        distance: editDistance(configSection, candidate),
      }))
      .sort((left, right) =>
        left.distance - right.distance ||
        left.candidate.localeCompare(right.candidate)
      )[0];
    text(
      2,
      `${errorLabel("error:", process.stderr)} unknown config section '${configSection}'\n`,
    );
    if (nearest && nearest.distance <= 2) {
      text(
        2,
        `\n  ${tipLabel("tip:", process.stderr)} did you mean '${nearest.candidate}'?\n`,
      );
    }
    text(
      2,
      `\n${heading("usage:", process.stderr)} ${invoke} config <section> [flags]\n`,
    );
    text(2, `For the full list, run '${invoke} config --help'.\n`);
    return 2;
  }
  return renderDispatcherFailure(argv, 2, message);
}

function projectPolicyError(route: Route, argv: readonly string[]): string | null {
  if (route.projectRequirement !== "required") return null;
  const projectDir = dispatcherProjectDirFrom(argv);
  const recognized = [
    ".git",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "aidlc",
  ].some((entry) => existsSync(join(projectDir, entry))) ||
    discoverProjectHarnesses(projectDir).length > 0;
  return recognized
    ? null
    : `${route.id} requires an installed project harness or recognized project directory; run aidlc config`;
}

// A project inside a machine root is never acceptable. The reverse (a machine
// root inside the project) matters only for the project-required engine and
// unit routes, whose tools write `<project>/aidlc` and the harness directory
// directly. Optional-project public commands (doctor, config) are commonly
// run from `$HOME`, which contains the default install and command roots;
// their writes go through the transaction engine, which refuses machine-owned
// targets in a project-rooted plan, so the reverse check would only refuse
// read-only diagnostics there.
async function projectMachineOverlapError(
  route: Route,
  argv: readonly string[],
): Promise<string | null> {
  const scope = effectiveMutationScope(route, argv);
  const required = route.projectRequirement === "required";
  if (!required && scope !== "project" && scope !== "project-and-machine") {
    return null;
  }
  const projectDir = dispatcherProjectDirFrom(argv);
  const { isMachineOwnedPath, projectPathOverlapsMachineRoots } = await import(
    "./aidlc-install-paths.ts"
  );
  const overlaps = required
    ? projectPathOverlapsMachineRoots(projectDir)
    : isMachineOwnedPath(projectDir);
  return overlaps
    ? `${route.id} cannot use an AI-DLC machine install or command directory as its project directory`
    : null;
}

// The one line a person sees when they ask for AI-DLC in a folder that holds
// AI-DLC's own install (most often the home folder) or sits inside it. It
// names only the step; the troubleshooting guide says why.
function machineRootStep(argv: readonly string[]): string {
  return `AI-DLC can't run in ${dispatcherProjectDirFrom(argv)}. Start the session from your project's folder.`;
}

// AI-DLC never runs in such a folder, so a host's hooks, adapters and
// statusline stand aside there: every tool call goes on as it would with no
// AI-DLC, and the person's other work in that folder is never stopped. The
// step line is said when the person asks for AI-DLC itself (the engine
// routes). Copilot's tool guard gives no decision, so its own permission
// rules apply; Cursor's failClosed guard needs an explicit allow.
async function standAsideInMachineRoot(argv: readonly string[]): Promise<number> {
  let action: Action | null = null;
  try {
    action = resolveAction([...argv]);
  } catch {
    action = null;
  }
  if (
    action?.type === "adapter" &&
    ((action.harness === "copilot" && action.target === "guard-tool-call") ||
      (action.harness === "cursor" && action.target === "guards"))
  ) {
    // Take the payload the host is still writing, so the answer does not meet
    // a closed pipe.
    await readStdin();
    if (action.harness === "cursor") text(1, `${JSON.stringify({ permission: "allow" })}\n`);
  }
  return 0;
}

function effectiveMutationScope(
  route: Route,
  argv: readonly string[],
): MutationScope {
  const clean = withoutProjectDirFlag(argv);
  if (
    route.id === "system-lifecycle" &&
    clean[2] === "install-profile"
  ) {
    return "user-home";
  }
  return route.mutationScope;
}

async function withRoutePolicy(route: Route, argv: readonly string[], run: () => Promise<number>): Promise<number> {
  const values: Record<string, string> = {
    AIDLC_ROUTE_ID: route.id,
    AIDLC_ROUTE_NETWORK_POLICY: route.networkPolicy,
    AIDLC_ROUTE_MUTATION_SCOPE: effectiveMutationScope(route, argv),
    AIDLC_ROUTE_PROJECT_DIR: dispatcherProjectDirFrom(argv),
    AIDLC_ROUTE_OUTPUT_MODE: requestedOutputMode(argv),
  };
  const prior = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function main(rawArgv: string[]): Promise<void> {
  if (
    rawArgv[0] === "--internal-aidlc-record-human-turn" &&
    rawArgv.length === 2 &&
    (process.env.AIDLC_INTERNAL_HUMAN_TURN_TOKEN ?? "") !== ""
  ) {
    await import(pathToFileURL(rawArgv[1]).href);
    return;
  }
  // Canonicalized before route policy so stdin buffering, pinning, and
  // dispatch see `engine hook`.
  const argv = canonicalizeLegacyCopilotHookArgv(rawArgv);
  process.exitCode = 0;
  bufferedStdin = null;
  const tracedHook = tracedHookRoute(argv);
  if (tracedHook !== undefined && process.env.AIDLC_HOOK_TRACE_DIR) {
    // runtimeStartedAt against this line's time shows a slow runtime start.
    hookTrace("dispatcher-start", {
      ...(tracedHook === "hook" ? { hook: argv[2] } : { adapter: argv[2], target: argv[3] }),
      runtimeStartedAt: new Date(performance.timeOrigin).toISOString(),
      platform: process.platform,
      runtime: process.versions.bun ?? process.version,
    });
    process.on("exit", (code) => hookTrace("exit", { code }));
  }
  configureColor(argv);
  const projectDirOption = projectDirFlag(argv);
  if (projectDirOption.error) {
    process.exitCode = renderDispatcherFailure(argv, 2, projectDirOption.error);
    return;
  }
  if (argv.length === 1 && argv[0] === "--internal-metrics-send") {
    const metrics = await import("./aidlc-metrics.ts");
    await metrics.sendMetricFromStdin();
    return;
  }
  const commandHelp = commandHelpRequest(argv);
  if (commandHelp) {
    text(1, renderCommandHelp(commandHelp));
    return;
  }
  const route = routePolicyFor(argv);
  if (route) {
    const error = basicPolicyError(route, argv);
    if (error) {
      process.exitCode = renderDispatcherFailure(argv, 2, error);
      return;
    }
  }
  const grammarError = await publicCommandGrammarError(route, argv);
  if (grammarError) {
    process.exitCode = renderPublicGrammarFailure(argv, grammarError);
    return;
  }
  if (route) {
    const overlapError = await projectMachineOverlapError(route, argv);
    if (overlapError) {
      process.exitCode =
        route.routeOnly === "hook" || route.routeOnly === "statusline" || route.routeOnly === "adapter"
          ? await standAsideInMachineRoot(argv)
          : renderDispatcherFailure(argv, 1, route.namespace === "engine" ? machineRootStep(argv) : overlapError);
      return;
    }
  }
  if (isCompiledExecutable()) {
    // Compiled, no explicit harness: discover the project install from its
    // shipped stamp/harness metadata. Module-relative derivation cannot work
    // from $bunfs, and embedded data may be Claude-flavoured. Every delegate
    // and sibling tool reads these envs, so pin both identifiers once here,
    // before lazy delegate imports, so same-directory harnesses retain
    // identity. Falls back to .claude when no install is present. A working
    // directory that cannot be read pins neither: commands that need no
    // harness (such as version and the installer's own check) still run, and
    // a command that needs one reports the error when it resolves its harness.
    if (!process.env.AIDLC_HARNESS_DIR) {
      const harnessDir = discoverableRuntimeHarnessDir();
      if (harnessDir) process.env.AIDLC_HARNESS_DIR = harnessDir;
    }
    if (process.env.AIDLC_HARNESS_DIR && !process.env.AIDLC_HARNESS_NAME) {
      process.env.AIDLC_HARNESS_NAME = runtimeHarnessName();
    }
  }
  if (
    process.platform === "win32" &&
    !["doctor", "--doctor", "uninstall"].includes(argv[0] ?? "")
  ) {
    try {
      const { describeWindowsUninstallFailure, recoverWindowsUninstallContinuations } = await import(
        "./aidlc-windows-uninstall.ts"
      );
      // A failed continuation does not block other commands: the fence still
      // stops machine mutation, and `aidlc uninstall` retries it explicitly.
      // A reinstall retries it too, since the failed cleanup may have removed
      // the command that would otherwise run that retry.
      const reinstalling = argv[0] === "system" && argv[1] === "lifecycle" &&
        argv[2] === "install-apply";
      const recovery = recoverWindowsUninstallContinuations(undefined, { retryFailed: reinstalling });
      if (recovery.resumed > 0 || recovery.running > 0) {
        process.exitCode = renderDispatcherFailure(
          argv,
          3,
          recovery.resumed > 0
            ? `resumed ${recovery.resumed} pending Windows uninstall continuation(s); this command was not run${
              recovery.retriedFailures.length > 0
                ? ` (last attempt ${recovery.retriedFailures.map(describeWindowsUninstallFailure).join("; ")})`
                : ""
            }`
            : "a Windows uninstall cleanup is still running; this command was not run",
        );
        return;
      }
    } catch (error) {
      process.exitCode = renderDispatcherFailure(
        argv,
        1,
        `Windows uninstall recovery failed: ${errorMessage(error)}`,
        "aidlc doctor",
      );
      return;
    }
  }
  if (
    process.platform === "win32" &&
    isCompiledExecutable() &&
    !["doctor", "--doctor", "uninstall"].includes(argv[0] ?? "")
  ) {
    // Every previous launcher helper forwards @args and the current one does
    // not, so a current helper costs one read. A binary that is not the active
    // release (a pinned project's) may also have to give an older active
    // release back the helper it needs, so it reads which release is active.
    try {
      const installRoot = dirname(dirname(dirname(process.execPath)));
      const helper = join(installRoot, "aidlc-shim.ps1");
      const otherActive = (): boolean => {
        try {
          return readFileSync(join(installRoot, "active-version"), "utf-8").trim() !==
            basename(dirname(process.execPath));
        } catch {
          return false;
        }
      };
      if (readFileSync(helper, "utf-8").includes("& $executable @args") || otherActive()) {
        const { replacePreviousWindowsShimHelper } = await import("./aidlc-lifecycle.ts");
        replacePreviousWindowsShimHelper();
      }
    } catch {
      // A binary run from outside an install has no helper to replace.
    }
  }
  if (
    route?.routeOnly === "hook" ||
    route?.routeOnly === "statusline" ||
    (route?.routeOnly === "adapter" && !kasAdapterInvocation(argv))
  ) {
    if (tracedHook !== undefined) hookTrace("stdin-begin");
    const input = await readStdin();
    if (tracedHook !== undefined) hookTrace("stdin-end", { bytes: Buffer.byteLength(input, "utf8") });
  }
  if (
    route?.id === "top-config" &&
    process.env.AIDLC_TEST_CONFIG_TTY === "1" &&
    !process.stdin.isTTY
  ) {
    process.env.AIDLC_TEST_CONFIG_INPUT = await readStdin();
  }
  const pinnedCode = await dispatchPinnedVersion(argv, bufferedStdin);
  if (pinnedCode !== null) {
    process.exitCode = pinnedCode;
    return;
  }
  const skewCode = refuseUnpinnedMajorSkew(argv);
  if (skewCode !== null) {
    process.exitCode = skewCode;
    return;
  }
  if (route) {
    const error = projectPolicyError(route, argv);
    if (error) {
      process.exitCode = renderDispatcherFailure(argv, 1, error);
      return;
    }
  }
  const action = resolveAction(argv);
  if (
    (action.type === "error" || action.type === "stub") &&
    requestedOutputMode(argv) !== "human"
  ) {
    process.exitCode = renderDispatcherFailure(argv, action.code, action.message);
    return;
  }
  const code = route
    ? await withRoutePolicy(route, argv, () => execute(action))
    : await execute(action);
  process.exitCode = code;
}

if (import.meta.main) {
  // Keep pending stdin and async dispatch alive, while leaving this module
  // synchronous to import (completions imports its route table during dispatch).
  const keepAlive = setInterval(() => {}, 1_000);
  void main(process.argv.slice(2)).catch((error) => {
    // Recorded before the message is rendered, so a failing stderr write
    // still leaves the reason in the trace. Only hook routes are traced.
    if (tracedHookRoute(canonicalizeLegacyCopilotHookArgv(process.argv.slice(2))) !== undefined) {
      hookTrace("dispatcher-error", { message: errorMessage(error) });
    }
    process.exitCode = renderDispatcherFailure(
      process.argv.slice(2),
      1,
      errorMessage(error),
    );
  }).finally(() => clearInterval(keepAlive));
}
