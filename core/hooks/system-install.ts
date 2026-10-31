// A system package install nobody asked for: the agent at Build and Test, or
// the developer at Code Generation, finds a tool missing and installs it for
// the whole machine (`sudo apt-get install -y python3-pytest`), outside the
// project. The factory never runs a command nobody ordered outside the
// project, so this is not a fence: no Guard Policy word or plan-approval
// setting lowers it. Only AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1, which turns the
// hook that calls it off, turns it off.
//
// The install is let through when the person's turn stands with no decision
// after it (their own request, or their go-ahead after the hold), and the row
// it leaves names their message; or when a plan the person approved names it.
// Otherwise the one step is to tell the person the command. Which program and
// verb, and whether a turn stands, are read here; what the package is for and
// what the person's reply meant are the agent's to say and read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  auditBlockField,
  errorMessage,
  personsWordsText,
  readAuditShardEvents,
  recordGuardBlockedRow,
  recordHookDrop,
  releaseAuditLock,
} from "../tools/aidlc-lib.ts";
import { readMessage, standingPersonTurn } from "../tools/aidlc-message-store.ts";
import { askedQuestionFields, questionShows } from "../tools/aidlc-questions.ts";
import {
  approvalFingerprint,
  codeGenerationRecordDir,
  projectPlanApprovalContent,
  readTestingContract,
} from "../tools/aidlc-testing-posture.ts";
import { shellCommandInvocationDetails } from "./review-freeze-command.ts";

// The OS package managers, each with the names its family goes by (a plan that
// says "with apt" names an `apt-get` install) and the word that makes it
// install: a verb, or for the flag-driven ones a flag.
interface Installer {
  family: readonly string[];
  installs: (arg: string) => boolean;
}

const verb = (...verbs: string[]) => (arg: string): boolean => !arg.startsWith("-") && verbs.includes(arg.toLowerCase());
const APT: Installer = { family: ["apt-get", "apt", "aptitude"], installs: verb("install", "reinstall", "build-dep") };
const DNF: Installer = {
  family: ["dnf", "dnf5", "yum", "microdnf"],
  installs: verb("install", "reinstall", "localinstall", "groupinstall"),
};
const INSTALLERS: Record<string, Installer> = {
  "apt-get": APT,
  apt: APT,
  aptitude: APT,
  dnf: DNF,
  dnf5: DNF,
  yum: DNF,
  microdnf: DNF,
  dpkg: { family: ["dpkg"], installs: (arg) => arg === "-i" || arg === "--install" },
  // `-i`, `-ivh`, `-U`, `-Uvh`; a query (`-qi`) starts with its own letter.
  rpm: { family: ["rpm"], installs: (arg) => /^-[iU][A-Za-z]*$/.test(arg) || arg === "--install" || arg === "--upgrade" },
  zypper: { family: ["zypper"], installs: verb("install", "in", "source-install", "si") },
  // `-S`, `-Syu`, `-U`; not the look-ups `-Ss`, `-Si`, `-Sl`, `-Sg`, `-Sp`,
  // `-Sc` or the download-only `-Sw`.
  pacman: {
    family: ["pacman"],
    installs: (arg) => (/^-[SU][A-Za-z]*$/.test(arg) && !/^-S[A-Za-z]*[silgpcw]/.test(arg)) ||
      arg === "--sync" || arg === "--upgrade",
  },
  apk: { family: ["apk"], installs: verb("add") },
  brew: { family: ["brew"], installs: verb("install", "reinstall") },
  port: { family: ["port"], installs: verb("install") },
  snap: { family: ["snap"], installs: verb("install") },
  flatpak: { family: ["flatpak"], installs: verb("install") },
  winget: { family: ["winget"], installs: verb("install", "add") },
  choco: { family: ["choco"], installs: verb("install") },
  scoop: { family: ["scoop"], installs: verb("install") },
};

export interface SystemInstall {
  /** The installer's family names, any of which a plan may name it by. */
  family: readonly string[];
  /** The packages it installs, as written. */
  packages: string[];
}

// The packages one invocation installs, or null when it installs nothing. The
// verb is found anywhere among the words that are not options, so `apt-get -y
// install x` and `apt-get -t stable install x` read as installs; a verb with no
// package after it (`apt-get install -f`, `pacman -Syu`) installs nothing new.
function installed(name: string, args: readonly string[]): SystemInstall | null {
  const installer = Object.hasOwn(INSTALLERS, name) ? INSTALLERS[name] : undefined;
  const from = installer === undefined ? -1 : args.findIndex(installer.installs);
  if (installer === undefined || from < 0) return null;
  const packages = args.slice(from + 1).filter((arg) => arg.length > 0 && !arg.startsWith("-"));
  return packages.length > 0 ? { family: installer.family, packages } : null;
}

/** The system package installs a shell line runs, read with the shared lexer (`sudo`, `env` and the like unwrapped). */
export function systemInstalls(command: string): SystemInstall[] {
  const found: SystemInstall[] = [];
  for (const invocation of shellCommandInvocationDetails(command)) {
    const install = installed(invocation.name.replace(/\.ps1$/i, ""), invocation.args);
    if (install !== null) found.push(install);
  }
  return found;
}

// The words of each plan and its test instructions the person approved on this
// work, one set a plan, read as approved: the committed files count only while
// `approvalFingerprint` over them still equals the fingerprint the row
// recorded, so a line added after the approval names nothing, and the plan is
// read through the approval's own projection, which leaves out a reviewer's
// terminal appendix. A plan that plan approval off built without asking
// (PLAN_APPROVAL_SKIPPED, the poc and express default) was the agent's own:
// nobody saw it, so it names nothing.
function approvedPlanWords(projectDir: string): Set<string>[] {
  // Loaded only once an install is seen: a plan's words end where its named files do.
  const { PLAN_WORD_BREAK } = require("../tools/aidlc-plan-approval-ask.ts") as {
    PLAN_WORD_BREAK: RegExp;
  };
  const plans: Set<string>[] = [];
  for (const row of readAuditShardEvents(projectDir)) {
    if (row.event !== "PLAN_APPROVAL_RECORDED") continue;
    const targetId = auditBlockField(row.block, "Plan Target");
    const intentId = auditBlockField(row.block, "Intent");
    const runFloor = auditBlockField(row.block, "Run floor");
    const fingerprint = auditBlockField(row.block, "Approval Fingerprint");
    if (targetId === null || intentId === null || runFloor === null || fingerprint === null) continue;
    const unit = targetId.startsWith("unit:") ? targetId.slice("unit:".length) : null;
    try {
      const dir = codeGenerationRecordDir(projectDir, unit);
      const plan = readFileSync(join(dir, "code-generation-plan.md"), "utf-8");
      const instructions = readFileSync(join(dir, "unit-test-instructions.md"), "utf-8");
      const contract = readTestingContract(plan);
      if (!("contract" in contract)) continue;
      const current = approvalFingerprint(plan, instructions, contract.contract.contract_sha256, { targetId, intentId, runFloor });
      if (current !== fingerprint) continue;
      const words = new Set<string>();
      for (const raw of `${projectPlanApprovalContent(plan)}\n${instructions}`.split(new RegExp(`${PLAN_WORD_BREAK.source}+`))) {
        const word = raw.replace(/[.:!?]+$/, "").toLowerCase();
        if (word.length > 0) words.add(word);
      }
      plans.push(words);
    } catch {
      // A plan that cannot be read names nothing; the person is asked.
    }
  }
  return plans;
}

/** Whether one plan names the install: the package manager (any of its family's names) and every package. */
export function namedByOnePlan(plans: readonly ReadonlySet<string>[], install: SystemInstall): boolean {
  return plans.some((words) =>
    install.family.some((name) => words.has(name)) && install.packages.every((name) => words.has(name.toLowerCase())));
}

// The go-ahead's row: the command, and the message whose turn stood behind it
// with the person's words. It says that turn stood, never that they approved.
function recordAllowed(
  projectDir: string,
  hook: string,
  command: string,
  turn: { block: string },
  fields: Record<string, string>,
): void {
  const id = auditBlockField(turn.block, "Message Id");
  let reply: string | null = null;
  try {
    const message = id === null ? null : readMessage(projectDir, id);
    reply = message === null ? null : personsWordsText(message.words ?? message.text);
  } catch {
    reply = null;
  }
  if (!acquireAuditLock(projectDir, 5, 50)) {
    recordHookDrop(projectDir, hook, "audit lock contended; SYSTEM_INSTALL_ALLOWED row dropped (the install was let through)");
    return;
  }
  try {
    appendAuditEntryUnlocked("SYSTEM_INSTALL_ALLOWED", {
      ...fields,
      Command: command,
      ...(id !== null ? { "Message Id": id } : {}),
      ...(reply ? { "Person Reply": reply } : {}),
    }, projectDir);
  } catch (error) {
    // The row is the record, never the decision: the install is still let through.
    recordHookDrop(projectDir, hook, `SYSTEM_INSTALL_ALLOWED row not recorded: ${errorMessage(error)}`);
  } finally {
    releaseAuditLock(projectDir);
  }
}

// The go-ahead the agent now asks for is a question to the person, on the
// record with its id (aidlc-questions.ts) beside the hold's row; their
// go-ahead's row closes it. Record-only: a lost row holds nothing.
function recordInstallQuestion(
  projectDir: string,
  hook: string,
  command: string,
  fields: Record<string, string>,
  session: string | null,
): void {
  if (!acquireAuditLock(projectDir, 5, 50)) return;
  try {
    appendAuditEntryUnlocked("QUESTION_ASKED", {
      ...askedQuestionFields(projectDir, { type: "system-install", shows: questionShows([command]), chat: session }),
      ...fields,
    }, projectDir);
  } catch (error) {
    recordHookDrop(projectDir, hook, `QUESTION_ASKED row not recorded: ${errorMessage(error)}`);
  } finally {
    releaseAuditLock(projectDir);
  }
}

/**
 * The refusal for a shell line that installs a system package nobody asked
 * for, or null when it runs: it installs none, the person's turn stands (the
 * row it leaves names their message), or an approved plan names every install.
 * `shown` is the command as the refusal quotes it, on one line.
 */
export function unaskedSystemInstall(
  projectDir: string,
  command: string,
  shown: string,
  context: { hook: string; session: string | null; stage: string },
): string | null {
  const installs = systemInstalls(command);
  if (installs.length === 0) return null;
  const fields = { Stage: context.stage, ...(context.session ? { Session: context.session } : {}) };
  const turn = standingPersonTurn(projectDir, "plain", { requests: true });
  if (turn !== null) {
    recordAllowed(projectDir, context.hook, command, turn, fields);
    return null;
  }
  const plans = approvedPlanWords(projectDir);
  if (installs.every((install) => namedByOnePlan(plans, install))) return null;
  const held = recordGuardBlockedRow(projectDir, {
    eventType: "SYSTEM_INSTALL_BLOCKED",
    hook: context.hook,
    reason: "system-install",
    tool: "Bash",
    target: shown,
    session: context.session,
    stage: context.stage,
  });
  if (held) recordInstallQuestion(projectDir, context.hook, command, fields, context.session);
  return `AI-DLC stopped this command: \`${shown}\` installs a system package on this machine, outside the project, ` +
    "and no plan the person approved names it. Tell the person the command and what it is for. It runs once the " +
    "person says so, or they can run it themselves.";
}
