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
// conductor's whole allow and excludes, in their canonical spelling, only the
// commands the guard admits a delegate (DELEGATE_ADMITTED_VERBS) and does not
// refuse. A tool or verb not admitted there, host-only routing
// surfaces included, is never excluded. Any other spelling under the allow is
// denied; one outside it asks the person. Kiro judges each part of a
// command joined by &&, ||, ;, |, &, a newline, $( ), backticks or <( ) on its
// own (measured), so an excluded part lifts only itself.
//
// Kiro's exclude, as measured: "X *" lifts X followed by arguments but not the
// bare X, so each command is excluded both ways.

import {
  DELEGATE_ADMITTED_VERBS,
  delegatedLifecycleCommand,
} from "../../core/hooks/aidlc-state-transition-guard.ts";
import { resolveAction, ROUTES } from "../../core/tools/aidlc.ts";
import { LAUNCHER_GLOBAL_FLAGS, trustedCommand, TRUSTED_ROUTE_NAMESPACE } from "../../core/tools/aidlc-command.ts";
import { isWorkspaceNoun, parseWorkspaceCommand, WORKSPACE_NOUNS } from "../../core/tools/aidlc-lib.ts";

export type ShellDeny = { match: string[]; exclude: string[] };

const both = (command: string): string[] => [command, `${command} *`];
// Sample arguments, so a verb that needs a name (a switch, an archive) is read
// as the mutation it is, also after a flag that takes the first one as its
// value (`intent --json true other` switches intent).
const delegateMayRun = (command: string): boolean =>
  [`${command} x`, `${command} x y`].every((sample) => delegatedLifecycleCommand(sample) === null);
// A command the guard refuses with an argument but allows bare (a query, such
// as `select-plugins` printing the current selection) is excluded exactly, and
// with each of the dispatcher's global flags the guard allows there too.
const exactQuery = (command: string): string[] => {
  const words = command.split(" ");
  return [command, ...[...LAUNCHER_GLOBAL_FLAGS].filter((flag) => !words.includes(flag)).map((flag) => `${command} ${flag}`)]
    .filter((query) => delegatedLifecycleCommand(query) === null);
};
const exclusionsFor = (command: string): string[] =>
  delegateMayRun(command) ? both(command) : exactQuery(command);

// An engine route verb is admitted when the script and verb the dispatcher
// runs for it are.
const admittedRoute = (words: string[]): boolean => {
  const action = resolveAction(["engine", ...words]);
  return action.type === "delegate" && (DELEGATE_ADMITTED_VERBS[action.tool] ?? []).includes(action.args[0] ?? "");
};

// A workspace noun's reads, as the workspace parser reads them: the bare noun
// (excluded exactly, since `<noun> <name>` switches) and the list and help forms.
const workspaceReads = (noun: string): string[] =>
  ["list", "--all", "help", "-h"]
    .filter((token) => ["list", "help"].includes(parseWorkspaceCommand([noun, token]).kind))
    .map((token) => `${noun} ${token}`);
const workspaceExclusions = (prefix: string, noun: string): string[] => [
  ...exactQuery(`${prefix} ${noun}`),
  ...workspaceReads(noun).flatMap((read) => exclusionsFor(`${prefix} ${read}`)),
];

export function copyChannelDelegateShellDeny(harnessDir: string): ShellDeny {
  const tool = (file: string) => `bun ${harnessDir}/tools/${file}`;
  return {
    match: [tool("aidlc-*")],
    exclude: [
      ...Object.keys(DELEGATE_ADMITTED_VERBS).sort().flatMap((file) =>
        DELEGATE_ADMITTED_VERBS[file].flatMap((verb) => exclusionsFor(`${tool(file)} ${verb}`))
      ),
      ...WORKSPACE_NOUNS.flatMap((noun) => workspaceExclusions(tool("aidlc-utility.ts"), noun)),
    ],
  };
}

export function nativeDelegateShellDeny(): ShellDeny {
  const routes = ROUTES.filter(
    (route) => route.namespace === TRUSTED_ROUTE_NAMESPACE && route.classification !== "routing-only",
  );
  const exclude: string[] = [];
  for (const noun of WORKSPACE_NOUNS.filter((noun) => routes.some((route) => route.group === noun))) {
    exclude.push(...workspaceExclusions(trustedCommand(), noun));
  }
  for (const route of routes.filter((route) => !isWorkspaceNoun(route.group))) {
    const prefix = route.group === "top" ? "" : `${route.group} `;
    for (const verb of route.verbs.filter((verb) => !verb.startsWith("<"))) {
      const words = [...(route.group === "top" ? [] : [route.group]), ...verb.split(" ")];
      if (admittedRoute(words)) exclude.push(...exclusionsFor(trustedCommand(`${prefix}${verb}`)));
    }
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
