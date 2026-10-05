// harness/kiro-ide/delegate-shell-deny.ts — the shell deny each delegated
// persona carries in place of the state-transition guard's delegated branch.
//
// A delegate's own calls carry no agent identity, so that branch never fires
// on Kiro, and on a delegated call Kiro enforces the persona's deny but not its
// allow: the delegate runs whatever the conductor's allow covers (measured on
// Kiro CLI 2.27.1 and IDE 1.2.4). The conductor allows `bun .kiro/tools/aidlc-*`
// and the dispatcher's engine namespace in the copy channel, and
// `aidlc engine *` in the native one.
//
// Kiro matches the command text as written, so a deny that lists forbidden
// spellings misses a quoted or re-spaced one. The persona therefore denies the
// conductor's whole allow and excludes, in their canonical spelling, only the
// commands the guard admits that persona (delegateAdmittedVerbs: everyone's,
// plus its own role's) and does not refuse. A tool or verb not admitted there, host-only routing
// surfaces included, is never excluded. Any other spelling under the allow is
// denied; one outside it asks the person. Kiro judges each part of a
// command joined by &&, ||, ;, |, &, a newline, $( ), backticks or <( ) on its
// own (measured), so an excluded part lifts only itself.
//
// Kiro's exclude, as measured: "X *" lifts X followed by arguments but not the
// bare X, so each command is excluded both ways.

import {
  delegateAdmittedVerbs,
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
const admittedRoute = (admitted: Readonly<Record<string, readonly string[]>>, words: string[]): boolean => {
  const action = resolveAction(["engine", ...words]);
  return action.type === "delegate" && (admitted[action.tool] ?? []).includes(action.args[0] ?? "");
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

// The engine routes the guard admits the persona, spelled after `engine`
// (`aidlc engine` on the native channel, the copy channel's dispatcher path
// before it there).
function engineRouteExclusions(agent: string, engine: string): string[] {
  const admitted = delegateAdmittedVerbs(agent);
  const routes = ROUTES.filter(
    (route) => route.namespace === TRUSTED_ROUTE_NAMESPACE && route.classification !== "routing-only",
  );
  const exclude: string[] = [];
  for (const noun of WORKSPACE_NOUNS.filter((noun) => routes.some((route) => route.group === noun))) {
    exclude.push(...workspaceExclusions(engine, noun));
  }
  for (const route of routes.filter((route) => !isWorkspaceNoun(route.group))) {
    const prefix = route.group === "top" ? "" : `${route.group} `;
    for (const verb of route.verbs.filter((verb) => !verb.startsWith("<"))) {
      const words = [...(route.group === "top" ? [] : [route.group]), ...verb.split(" ")];
      if (admittedRoute(admitted, words)) exclude.push(...exclusionsFor(`${engine} ${prefix}${verb}`));
    }
  }
  return exclude;
}

// The copy channel's conductor allows the tool scripts and the dispatcher's
// engine namespace, so the persona denies both.
export function copyChannelDelegateShellDeny(harnessDir: string, agent: string): ShellDeny {
  const tool = (file: string) => `bun ${harnessDir}/tools/${file}`;
  const engine = `${tool("aidlc.ts")} ${TRUSTED_ROUTE_NAMESPACE}`;
  const admitted = delegateAdmittedVerbs(agent);
  return {
    match: [tool("aidlc-*"), `${engine} *`],
    exclude: [
      ...Object.keys(admitted).sort().flatMap((file) =>
        admitted[file].flatMap((verb) => exclusionsFor(`${tool(file)} ${verb}`))
      ),
      ...WORKSPACE_NOUNS.flatMap((noun) => workspaceExclusions(tool("aidlc-utility.ts"), noun)),
      ...engineRouteExclusions(agent, engine),
    ],
  };
}

export function nativeDelegateShellDeny(agent: string): ShellDeny {
  return { match: [trustedCommand("*")], exclude: engineRouteExclusions(agent, trustedCommand()) };
}

// Shell forms that can run, expand, or redirect more than the one command a
// rule names, as Kiro rule text: "\\n" and "\\r" are the YAML escapes for a
// line break. The conductor asks before a command holding one; a delegate is
// refused one on an AI-DLC command, so the deny holds whichever ask Kiro
// applies to a delegated call.
export const RISKY_SHELL_FORMS = ["$", "`", ">", "<", "&", "@(", "@{", "\\n", "\\r"] as const;

// The deny for those forms after each command prefix a delegate inherits from
// the conductor's allow.
export const riskyFormDenyLines = (prefixes: readonly string[]): string[] => [
  "    - capability: shell",
  "      effect: deny",
  "      match:",
  ...prefixes.flatMap((prefix) => RISKY_SHELL_FORMS.map((form) => `        - "${prefix}*${form}*"`)),
];

export const shellDenyLines = ({ match, exclude }: ShellDeny): string[] => [
  "    - capability: shell",
  "      effect: deny",
  "      match:",
  ...match.map((pattern) => `        - "${pattern}"`),
  "      exclude:",
  ...exclude.map((pattern) => `        - "${pattern}"`),
];
