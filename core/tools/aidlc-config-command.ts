// aidlc-config-command.ts — how a printed `config` command spells the tool
// invocation, the project target, and the harness name, so the command runs
// as printed from where the person is. ONE implementation, shared by the
// config flow itself (aidlc-init.ts) and by doctor's fix hints
// (aidlc-utility.ts): never hand-roll a second spelling.

import { basename, dirname, join, resolve } from "node:path";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
  projectedDispatcher,
  quoteCommandArgument,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";
import {
  fileIdentity,
  normalizeDriveLetter,
  sameFileIdentity,
} from "./aidlc-lib.ts";
import type { ModelHarness } from "./aidlc-model-policy.ts";

export function ranFromProject(projectDir: string): boolean {
  return normalizeDriveLetter(resolve(projectDir)) === normalizeDriveLetter(resolve(process.cwd()));
}

// A concrete follow-up command runs from the same shell, so it names the
// project whenever this command did not run from it.
export function projectTarget(projectDir: string): string {
  return ranFromProject(projectDir)
    ? ""
    : ` --project-dir ${quoteCommandArgument(projectDir)}`;
}

// Whether two paths reach one file. File identity settles it, since one file
// has several spellings (a link, or a Windows 8.3 short name Bun's realpath
// keeps) and two files can differ only in case. A missing path reaches none.
function sameFile(left: string, right: string): boolean {
  try {
    const identity = fileIdentity(left);
    return identity.ino !== 0n && sameFileIdentity(identity, fileIdentity(right));
  } catch {
    return false;
  }
}

// The harness this config run sets up or refreshes, once it is known. No
// projection names one in the source tree, so the commands this run prints
// name this harness's tool there, not the first install the project shows.
let configTargetHarnessDir: string | null = null;

export function setConfigTargetHarnessDir(harnessDir: string | null): void {
  configTargetHarnessDir = harnessDir;
}

// How a printed command starts so it runs from where the user is: `aidlc`, or
// the Bun tool that ran this command. The project's own tool is named from the
// project when run there and by its path in the project when not. Any other
// tool (a runtime unpacked elsewhere, which may be adding a harness the project
// does not have yet) is named by its own path, unless it is the one under the
// working directory. In the source tree the project's own tool of the harness
// being set up stands in. A newer release's config that an older copied tool
// handed its refresh to names the tool the person ran.
export function configInvocationFor(projectDir = process.cwd()): string {
  const invocation = aidlcInvocation();
  if (invocation === "aidlc") return invocation;
  const ran = process.env.AIDLC_CONFIG_HANDOFF || projectedDispatcher();
  // A tool's relative invocation names the harness directory it lives in,
  // whatever the environment says the harness is.
  const harnessDir = ran === null
    ? configTargetHarnessDir ?? runtimeHarnessDir()
    : basename(dirname(dirname(ran)));
  const own = `bun ${harnessDir}/tools/aidlc.ts`;
  const toolIn = (root: string) => join(root, harnessDir, "tools", "aidlc.ts");
  if (ran === null || sameFile(ran, toolIn(projectDir))) {
    return ranFromProject(projectDir) ? own : `bun ${quoteCommandArgument(toolIn(projectDir))}`;
  }
  return sameFile(ran, toolIn(process.cwd())) ? own : `bun ${quoteCommandArgument(ran)}`;
}

// A printed config command about one harness of the project names that
// harness when the project has more than one, since config would otherwise
// ask which.
export function namedHarness(projectDir: string, harness: string | undefined): string {
  return harness && discoverProjectHarnesses(projectDir).length > 1 ? ` --harness ${harness}` : "";
}

// A `config models` command about one harness of the project, run as shown
// from where the user is.
export function modelsCommand(projectDir: string, harness: ModelHarness, args: string): string {
  return `${configInvocationFor(projectDir)} config models ${args}${namedHarness(projectDir, harness)}${projectTarget(projectDir)}`;
}
