// covers: function:gitAddressKey, function:recordableGitAddress, function:workspaceHomeLocation, function:sameGitAddress, function:checkTeamResults, subcommand:aidlc-unit:push
//
// One identity for a git address and the person's own git setup, for teams
// building Units as work of their own (#2410). A user and token in an origin
// URL are never recorded or printed; two clones that spell the home's address
// differently are one home; the git AI-DLC runs on a step nobody typed never
// opens a sign-in window, and uses each code repo's own ssh setup; the merge
// check fetches only the branch a Unit merges into; a push goes to the remote
// git would push to, and only the person names one when git cannot.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, fixtureIntentId8, seededStateFile } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  ENV,
  finishBuild,
  git,
  HOME_RECORD,
  makeHome,
  next,
  refundsTaken,
  run,
  STATE,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const servers: Array<{ kill: () => void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.kill();
  cleanupTeamBuild();
});

const TOKEN = "ghp_r2SecretToken";

describe("addresses", () => {
  test("every spelling of one repo's address is one key, and a recorded address never carries a user or token", async () => {
    const { gitAddressKey, recordableGitAddress } = await import("../../dist/claude/.claude/tools/aidlc-workspace-repos.ts");
    const one = [
      "git@example.test:org/ws.git",
      "ssh://git@example.test/org/ws",
      "ssh://git@Example.TEST:22/org/ws.git",
      "https://example.test/org/ws.git",
      `https://lead:${TOKEN}@example.test/org/ws/`,
    ];
    expect(new Set(one.map((address) => gitAddressKey(address)))).toEqual(new Set(["example.test/org/ws"]));
    expect(gitAddressKey("https://example.test/org/other.git")).not.toBe(gitAddressKey(one[0]));
    expect(gitAddressKey("/srv/git/ws.git")).toBe(gitAddressKey("file:///srv/git/ws"));
    expect(recordableGitAddress(`https://lead:${TOKEN}@example.test/org/ws.git`)).toBe("https://example.test/org/ws.git");
    expect(recordableGitAddress("git@example.test:org/ws.git")).toBe("git@example.test:org/ws.git");
    // Over ssh the user is part of the address, not a secret.
    expect(recordableGitAddress("ssh://git@example.test/org/ws.git")).toBe("ssh://git@example.test/org/ws.git");
    expect(recordableGitAddress(`http://lead:${TOKEN}@example.test/org/ws.git`)).toBe("http://example.test/org/ws.git");
  });

  test("an origin with a token in it: teams are chosen and repos.json is written, and neither the record nor the file holds the token", () => {
    const home = makeHome();
    git(home.dir, ["remote", "set-url", "origin", `https://lead:${TOKEN}@example.test/org/ws.git`]);
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    expect(readFileSync(seededStateFile(home.dir), "utf-8")).toContain("- **Home Location**: https://example.test/org/ws.git");
    const record = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD);
    const audit = readdirSync(join(record, "audit")).map((shard) => readFileSync(join(record, "audit", shard), "utf-8")).join("\n");
    expect(audit).not.toContain(TOKEN);
    expect(readFileSync(seededStateFile(home.dir), "utf-8")).not.toContain(TOKEN);
    const written = run(join(AIDLC_SRC, "tools", "aidlc-workspace-sync.ts"), ["--write-manifest"], home.dir);
    expect(written.status, written.out).toBe(0);
    const manifest = readFileSync(join(home.dir, "repos.json"), "utf-8");
    expect(manifest).toContain("https://example.test/org/ws.git");
    expect(manifest).not.toContain(TOKEN);
  });

  test("a teammate whose clone spells the home's address another way is at the home, not in a copy of it", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(`file://${home.remote}`, "alice");
    expect(git(alice, ["remote", "get-url", "origin"])).toBe(`file://${home.remote}`);
    const take = next(alice);
    expect(take.ask_type, JSON.stringify(take)).toBe("unit-take");
    expect(String(take.question)).not.toContain("its home is");
    expect((take.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Carry on fixture here, as its home");
  });
});

// A git host stand-in that wants a sign-in for everything: git then asks its
// credential helpers and an askpass program, never anything else.
async function signInHost(): Promise<string> {
  const child = spawn(process.execPath, ["-e", `
    const server = Bun.serve({ port: 0, fetch: () => new Response("sign in", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="host"' } }) });
    console.log(server.port);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  servers.push({ kill: () => child.kill() });
  const port = await new Promise<string>((resolve) => child.stdout!.once("data", (chunk: Buffer) => resolve(chunk.toString().trim())));
  return `http://127.0.0.1:${port}/org/ws.git`;
}

describe("the person's own git, on steps nobody typed", () => {
  test("a home whose remote wants a sign-in: the step opens no sign-in window, comes back, and says once that it could not reach it", async () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    git(home.dir, ["remote", "set-url", "origin", await signInHost()]);
    const marker = join(tempDir("askpass"), "asked");
    const askpass = join(tempDir("askpass-bin"), "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\necho asked >> '${marker}'\necho nobody\n`);
    chmodSync(askpass, 0o755);
    const step = next(home.dir, { ...ENV, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass });
    expect(step.kind, JSON.stringify(step)).toBe("notice");
    expect(existsSync(marker)).toBe(false);
    expect(((step.change_notices ?? []) as string[]).filter((line) => line.includes("could not be reached"))).toHaveLength(1);
  });

  test.skipIf(process.platform === "win32")("the merge check fetches each code repo with that repo's own ssh setup, and only the branch the Unit merges into", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    // An ssh stand-in that notes who called it and runs git's command here.
    const bin = tempDir("ssh-bin");
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\ntag=$1; shift\necho "$tag $*" >> '${log}'\nfor last; do :; done\nexec sh -c "$last"\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    git(home.dir, ["config", "core.sshCommand", `${join(bin, "ssh")} workspace`]);
    const billing = join(home.dir, "billing");
    git(billing, ["config", "core.sshCommand", `${join(bin, "ssh")} billing`]);
    git(billing, ["remote", "set-url", "origin", `ssh://codehost${hosts.billing}`]);
    const trace = join(tempDir("trace"), "trace2.json");
    const env: NodeJS.ProcessEnv = { ...ENV, GIT_TRACE2_EVENT: trace };
    delete env.GIT_SSH_COMMAND;
    delete env.GIT_SSH;
    next(home.dir, env);
    const calls = readFileSync(log, "utf-8").trim().split("\n");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((line) => line.startsWith("billing -o BatchMode=yes -o ConnectTimeout=15 "))).toBe(true);
    const fetches = readFileSync(trace, "utf-8").split("\n").filter((line) => line.includes('"event":"start"'))
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
      .filter((argv) => argv.includes("fetch") && argv.includes("origin") && !argv.some((arg) => arg.includes("claim")));
    expect(fetches.length).toBeGreaterThan(0);
    for (const argv of fetches) expect(argv.at(-1)).toBe("main");
  });
});

describe("the push goes where git would push it", () => {
  test("a repo with two remotes and none set for pushing: the push offers each, and the pick is where it goes", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const billing = join(alice, "billing");
    git(billing, ["remote", "rename", "origin", "team"]);
    const fork = tempDir("billing-fork");
    git(fork, ["init", "-q", "--bare", "-b", "main"]);
    git(billing, ["remote", "add", "fork", fork]);
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Push to fork", "Push to team", "Not now"]);
    const team = choices.find((choice) => choice.label === "Push to team")!.command!;
    expect(team).toEndWith("aidlc-unit.ts push --remote billing=team");
    const picked = run(UNIT, ["push", "--remote", "billing=team"], alice);
    expect(picked.status, picked.out).toBe(0);
    expect(git(hosts.billing, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toContain("lib/refund.ts");
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: fork }).status).not.toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.result).toBeDefined();
  });
});
