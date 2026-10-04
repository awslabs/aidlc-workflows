// harness/kiro-ide/delegate-shell-deny.ts — the shell deny each delegated
// persona carries in place of the state-transition guard's delegated branch.
//
// A delegate's own calls carry no agent identity, so that branch never fires
// on Kiro, and on a delegated call Kiro enforces the persona's deny but not its
// allow: the delegate runs whatever the conductor's allow covers (measured on
// Kiro CLI 2.27.1 and IDE 1.2.4). The conductor allows `bun .kiro/tools/aidlc-*`
// in the copy channel and `aidlc engine *` in the native one.
//
// Kiro matches the command text as written, so a deny that lists forbidden
// spellings misses a quoted or re-spaced one. The persona therefore denies the
// conductor's whole allow and excludes the canonical commands the guard lets a
// delegate run, each decided by the guard itself. Host-only routing surfaces
// (routes classified routing-only: hook, adapter, statusline, the sensors) and
// the scripts behind them are never excluded. Any other spelling under the
// allow is denied; one outside it asks the person. Kiro judges each part of a
// command joined by &&, ||, ;, |, &, a newline, $( ), backticks or <( ) on its
// own (measured), so an excluded part lifts only itself.
//
// Kiro's exclude, as measured: "X *" lifts X followed by arguments but not the
// bare X, so each command is excluded both ways.

import {
  DELEGATED_LIFECYCLE_SCRIPTS,
  delegatedLifecycleCommand,
} from "../../core/hooks/aidlc-state-transition-guard.ts";
import { ROUTES, TOOLS } from "../../core/tools/aidlc.ts";
import { trustedCommand, TRUSTED_ROUTE_NAMESPACE } from "../../core/tools/aidlc-command.ts";
import { isWorkspaceNoun, parseWorkspaceCommand, UTILITY_COMMANDS, WORKSPACE_NOUNS } from "../../core/tools/aidlc-lib.ts";

export type ShellDeny = { match: string[]; exclude: string[] };

const both = (command: string): string[] => [command, `${command} *`];
// Sample arguments, so a verb that needs a name (a switch, an archive) is read
// as the mutation it is, also after a flag that takes the first one as its
// value (`intent --json true other` switches intent).
const delegateMayRun = (command: string): boolean =>
  [`${command} x`, `${command} x y`].every((sample) => delegatedLifecycleCommand(sample) === null);
// A command the guard refuses with an argument but allows bare (a query, such
// as `select-plugins` printing the current selection) is excluded exactly, and
// with `--json` when the guard allows that too.
const exactQuery = (command: string): string[] =>
  [command, ...(command.endsWith(" --json") ? [] : [`${command} --json`])].filter(
    (query) => delegatedLifecycleCommand(query) === null,
  );
const exclusionsFor = (command: string): string[] =>
  delegateMayRun(command) ? both(command) : exactQuery(command);

const hostRoutes = ROUTES.filter((route) => route.classification !== "routing-only");
const hostOnlyTools = new Set(
  ROUTES.filter((route) => route.classification === "routing-only" && route.tool).map((route) => route.tool),
);

// A workspace noun's reads, as the workspace parser reads them: the bare noun
// (excluded exactly, since `<noun> <name>` switches) and the list and help forms.
const workspaceReads = (noun: string): string[] =>
  ["list", "--json", "--all", "help", "-h"]
    .filter((token) => ["list", "help"].includes(parseWorkspaceCommand([noun, token]).kind))
    .map((token) => `${noun} ${token}`);
const workspaceExclusions = (prefix: string, noun: string): string[] => [
  `${prefix} ${noun}`,
  ...workspaceReads(noun).flatMap((read) => exclusionsFor(`${prefix} ${read}`)),
];

// A lifecycle script's verbs: the utility's commands, or for the other scripts
// the verbs their engine route passes straight through to them.
const scriptVerbs = (file: string): readonly string[] =>
  file === "aidlc-utility.ts"
    ? UTILITY_COMMANDS.filter((command) => !isWorkspaceNoun(command))
    : ROUTES.filter((route) => route.tool === file && route.kind === "noun-passthrough").flatMap((route) => route.verbs);

export function copyChannelDelegateShellDeny(harnessDir: string): ShellDeny {
  const tool = (file: string) => `bun ${harnessDir}/tools/${file}`;
  const lifecycle: readonly string[] = DELEGATED_LIFECYCLE_SCRIPTS;
  return {
    match: [tool("aidlc-*")],
    exclude: [
      ...Object.values(TOOLS)
        .filter((file) => !lifecycle.includes(file) && !hostOnlyTools.has(file))
        .sort()
        .flatMap((file) => both(tool(file))),
      ...lifecycle.flatMap((file) =>
        scriptVerbs(file).flatMap((verb) => exclusionsFor(`${tool(file)} ${verb}`))
      ),
      ...WORKSPACE_NOUNS.flatMap((noun) => workspaceExclusions(tool("aidlc-utility.ts"), noun)),
    ],
  };
}

export function nativeDelegateShellDeny(): ShellDeny {
  const routes = hostRoutes.filter((route) => route.namespace === TRUSTED_ROUTE_NAMESPACE);
  const exclude: string[] = [];
  for (const group of [...new Set(routes.map((route) => route.group))]) {
    const verbs = [...new Set(
      routes.filter((route) => route.group === group).flatMap((route) => route.verbs),
    )].filter((verb) => !verb.startsWith("<"));
    if (group === "top") {
      exclude.push(...verbs.flatMap((verb) => exclusionsFor(trustedCommand(verb))));
      continue;
    }
    if (isWorkspaceNoun(group)) {
      exclude.push(...workspaceExclusions(trustedCommand(), group));
      continue;
    }
    const commands = verbs.map((verb) => trustedCommand(`${group} ${verb}`));
    // A noun the guard never refuses is excluded whole.
    exclude.push(
      ...(commands.every(delegateMayRun) ? both(trustedCommand(group)) : commands.flatMap(exclusionsFor)),
    );
  }
  return { match: [trustedCommand("*")], exclude };
}

export const shellDenyLines = ({ match, exclude }: ShellDeny): string[] => [
  "    - capability: shell",
  "      effect: deny",
  "      match:",
  ...match.map((pattern) => `        - "${pattern}"`),
  "      exclude:",
  ...exclude.map((pattern) => `        - "${pattern}"`),
];
