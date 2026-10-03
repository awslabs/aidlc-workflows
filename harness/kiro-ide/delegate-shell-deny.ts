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
// delegate run, each decided by the guard itself. Any other spelling under the
// allow is denied; one outside it asks the person. The copy channel's
// aidlc-orchestrate.ts, aidlc-state.ts and aidlc-jump.ts stay denied whole: no
// persona instruction runs them by that spelling.
//
// Kiro's exclude, as measured: "X *" lifts X followed by arguments but not the
// bare X, so each command is excluded both ways.

import {
  DELEGATED_LIFECYCLE_SCRIPTS,
  delegatedLifecycleCommand,
} from "../../core/hooks/aidlc-state-transition-guard.ts";
import { ROUTES, TOOLS } from "../../core/tools/aidlc.ts";
import { trustedCommand, TRUSTED_ROUTE_NAMESPACE } from "../../core/tools/aidlc-command.ts";
import { UTILITY_COMMANDS } from "../../core/tools/aidlc-utility.ts";

export type ShellDeny = { match: string[]; exclude: string[] };

const both = (command: string): string[] => [command, `${command} *`];
// A sample argument, so a verb that needs a name (a switch, an archive) is
// read as the mutation it is.
const delegateMayRun = (command: string): boolean =>
  delegatedLifecycleCommand(`${command} x`) === null;

export function copyChannelDelegateShellDeny(harnessDir: string): ShellDeny {
  const tool = (file: string) => `bun ${harnessDir}/tools/${file}`;
  const lifecycle: readonly string[] = DELEGATED_LIFECYCLE_SCRIPTS;
  return {
    match: [tool("aidlc-*")],
    exclude: [
      ...Object.values(TOOLS).filter((file) => !lifecycle.includes(file)).sort().flatMap((file) => both(tool(file))),
      ...UTILITY_COMMANDS.map((command) => `${tool("aidlc-utility.ts")} ${command}`)
        .filter(delegateMayRun)
        .flatMap(both),
    ],
  };
}

export function nativeDelegateShellDeny(): ShellDeny {
  const routes = ROUTES.filter((route) => route.namespace === TRUSTED_ROUTE_NAMESPACE);
  const exclude: string[] = [];
  for (const group of [...new Set(routes.map((route) => route.group))]) {
    const verbs = [...new Set(
      routes.filter((route) => route.group === group).flatMap((route) => route.verbs),
    )].filter((verb) => !verb.startsWith("<"));
    if (group === "top") {
      exclude.push(...verbs.map((verb) => trustedCommand(verb)).filter(delegateMayRun).flatMap(both));
      continue;
    }
    const allowed = verbs.map((verb) => trustedCommand(`${group} ${verb}`)).filter(delegateMayRun);
    // A noun the guard never refuses is excluded whole, unless it takes a bare
    // name (an implicit workspace switch).
    const takesName = routes.some((route) => route.group === group && route.verbs.some((verb) => verb.startsWith("<")));
    exclude.push(
      ...(allowed.length === verbs.length && (verbs.length === 0 || !takesName)
        ? both(trustedCommand(group))
        : allowed.flatMap(both)),
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
