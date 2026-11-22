// covers: function:saySecretMaskedOnce, function:maskSecretShapes, function:SECRET_SHAPES, function:SECRET_MASK, function:SECRET_MASKED_LINE, function:renderAuditBlock, function:handleIntentCreateStateBuild, function:redactSecretPatterns
//
// A key, a token or a password the person types (in their first request, in a
// reply at a gate, or in a question box's own text field) is masked in AI-DLC's
// committed record (the audit rows, project-description.json and the state's
// Project line); their whole message stays in the git-ignored message record on
// their machine, and the chat hears one line about it, once. Driven over the
// shipped hook and tools with the shipped .gitignore block, so git itself says
// what a commit would carry. The masker's own table pins what it leaves alone
// (commit ids, fingerprints, slugs, paths, prose about passwords), and the
// doctor bundle shares its shapes.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AnswersItem, env, exec, next, pick, projectAt, recordByAgent, reply, say, templateProjects,
} from "../harness/aidlc-answers-corpus.ts";
import {
  AIDLC_SRC, DEFAULT_RECORD_DIR, DEFAULT_SPACE, REPO_ROOT, cleanupTestProject, createTestProject, fixtureIntentId8, removeWorkspaceRecord,
  seedAuditFile, seedStateFile,
} from "../harness/fixtures.ts";
import { auditBlockField, readAllAuditShards, readAuditShardEvents, worktreePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(240_000);

const audit = await import("../../dist/claude/.claude/tools/aidlc-audit.ts") as Record<string, unknown>;
const maskSecretShapes = (text: string): string => (audit.maskSecretShapes as (text: string) => string)(text);
const { redactSecretPatterns } = await import("../../dist/claude/.claude/tools/aidlc-doctor-bundle.ts");

const LINE = "Your message looked like it held a key or password. AI-DLC keeps it out of its committed record, " +
  "but this chat still received it, so if it is real, change it where it was issued.";
const MASK = "[masked]";

// Fake secrets, assembled here so no token-shaped literal sits in the source.
const run = (n: number): string => "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2eF4hJ6kL8nP0rS2uV4xY6zA8cD0fG2iL4oR6tU8wX0".repeat(4).slice(0, n);
// Key-shaped fixtures are put together at run time, so no line of this file is
// shaped like a key itself: the repository's secret scan reads every commit.
const dashes = "-".repeat(5);
const keyHeader = (kind: string): string => `${dashes}BEGIN ${kind}${dashes}`;
const keyFooter = (kind: string): string => `${dashes}END ${kind}${dashes}`;
const hex = (n: number, seed = 3): string => Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 7 + seed) % 16]).join("");
const uuid = (seed: number): string => [hex(8, seed), hex(4, seed + 1), hex(4, seed + 2), hex(4, seed + 3), hex(12, seed + 4)].join("-");
const GITHUB = `ghp_${run(36)}`;
const PASSWORD = "hunter2hunter2";
const STRIPE = `sk_live_${run(28)}`;

const made: string[] = [];
afterAll(() => {
  for (const proj of [...made, ...templateProjects()]) cleanupTestProject(proj);
});

/** The project as a person's repo: a git repository with AI-DLC's shipped .gitignore block. */
function asRepo(proj: string): string {
  made.push(proj);
  spawnSync("git", ["init", "-q"], { cwd: proj });
  copyFileSync(join(REPO_ROOT, "harness", "claude", "dot-gitignore"), join(proj, ".gitignore"));
  return proj;
}
/** Files under aidlc/ a `git add -A` would stage that hold `secret`. */
function committedHolding(proj: string, secret: string): string[] {
  const listed = spawnSync("git", ["ls-files", "-o", "--exclude-standard", "-z", "aidlc"], { cwd: proj, encoding: "utf-8" });
  return listed.stdout.split("\0").filter(Boolean).filter((rel) => readFileSync(join(proj, rel), "utf-8").includes(secret));
}
/** Files under the git-ignored session area that hold `secret`. */
function keptLocally(proj: string, secret: string): string[] {
  const listed = spawnSync("git", ["ls-files", "-o", "-i", "--exclude-standard", "-z", "aidlc/.aidlc-sessions"], { cwd: proj, encoding: "utf-8" });
  return listed.stdout.split("\0").filter(Boolean).filter((rel) => readFileSync(join(proj, rel), "utf-8").includes(secret));
}
const times = (text: string, part: string): number => text.split(part).length - 1;

describe("what the committed record keeps of a key the person typed", () => {
  test("a reply at a gate: the decision row keeps their words with the key and the password masked, the chat hears the line once", async () => {
    const proj = asRepo(await projectAt("stage-gate"));
    const words = `Approve. Also the deploy key is ${GITHUB} and password=${PASSWORD}`;
    const item = { question: "stage-gate", via: "chat", input: words, expected: { end: {} } } as unknown as AnswersItem;
    expect((await reply(proj, item)).status).toBe(0);
    const reported = await recordByAgent(proj, item, "Approve");
    expect(reported?.exec.status, reported?.exec.stderr).toBe(0);

    const approved = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED").at(-1);
    expect(approved && auditBlockField(approved.block, "Person Reply"))
      .toBe(`Approve. Also the deploy key is ${MASK} and password=${MASK}`);
    expect(committedHolding(proj, GITHUB)).toEqual([]);
    expect(committedHolding(proj, PASSWORD)).toEqual([]);
    expect(keptLocally(proj, GITHUB).length).toBeGreaterThan(0);
    expect(keptLocally(proj, PASSWORD).length).toBeGreaterThan(0);

    const said = `${reported?.exec.stdout ?? ""}${(await next(proj, [])).out}`;
    expect(times(said, LINE), said).toBe(1);
    expect(times((await next(proj, [])).out, LINE)).toBe(0);
  });

  test("the first request: the description, the Project line and the Request rows keep it masked, the first step says the line once", async () => {
    const proj = createTestProject();
    removeWorkspaceRecord(proj);
    asRepo(proj);
    const request = `build a payments page, my .env has STRIPE_KEY=${STRIPE}`;
    expect((await say(proj, `/aidlc ${request}`, "claude")).status).toBe(0);
    const created = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "intent-create",
      "--scope", "poc", "--arguments", request, "--label", "payments", "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(created.status, created.stderr).toBe(0);

    const masked = `build a payments page, my .env has STRIPE_KEY=${MASK}`;
    const listed = spawnSync("git", ["ls-files", "-o", "--exclude-standard", "aidlc"], { cwd: proj, encoding: "utf-8" }).stdout;
    const description = listed.split("\n").find((rel) => rel.endsWith("/project-description.json")) as string;
    expect(JSON.parse(readFileSync(join(proj, description), "utf-8"))).toBe(masked);
    expect(readFileSync(join(proj, description.replace("project-description.json", "aidlc-state.md")), "utf-8"))
      .toContain(`- **Project**: ${masked}\n`);
    const requests = readAuditShardEvents(proj).map((row) => auditBlockField(row.block, "Request")).filter((value) => value !== null);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const value of requests) expect(value).toBe(`/aidlc ${masked}`);
    expect(committedHolding(proj, STRIPE)).toEqual([]);
    expect(keptLocally(proj, STRIPE).length).toBeGreaterThan(0);

    const said = `${created.stdout}${(await next(proj, [])).out}`;
    expect(times(said, LINE), said).toBe(1);
    expect(times((await next(proj, [])).out, LINE)).toBe(0);
  });

  test("the first request, when the agent leaves the key out of the request it records: nothing to mask, and the line is still said once", async () => {
    const proj = createTestProject();
    removeWorkspaceRecord(proj);
    asRepo(proj);
    expect((await say(proj, `/aidlc build a payments page. fyi my .env has STRIPE_KEY=${STRIPE}`, "claude")).status).toBe(0);
    const created = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "intent-create",
      "--scope", "poc", "--arguments", "build a payments page", "--label", "payments", "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(created.status, created.stderr).toBe(0);
    expect(committedHolding(proj, STRIPE)).toEqual([]);
    expect(times(`${created.stdout}${(await next(proj, [])).out}`, LINE)).toBe(1);
    expect(times((await next(proj, [])).out, LINE)).toBe(0);
  });

  test("the first request: a reference in an address stays as written, a password made of words is masked, and the line is said once", async () => {
    const proj = createTestProject();
    removeWorkspaceRecord(proj);
    asRepo(proj);
    const request = "connect to postgres://app:$DB_PASSWORD@db and seed it as admin with password=correct-horse-battery-staple";
    expect((await say(proj, `/aidlc ${request}`, "claude")).status).toBe(0);
    const created = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "intent-create",
      "--scope", "poc", "--arguments", request, "--label", "seed", "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(created.status, created.stderr).toBe(0);
    const listed = spawnSync("git", ["ls-files", "-o", "--exclude-standard", "aidlc"], { cwd: proj, encoding: "utf-8" }).stdout;
    const description = listed.split("\n").find((rel) => rel.endsWith("/project-description.json")) as string;
    expect(JSON.parse(readFileSync(join(proj, description), "utf-8")))
      .toBe(`connect to postgres://app:$DB_PASSWORD@db and seed it as admin with password=${MASK}`);
    expect(committedHolding(proj, "correct-horse-battery-staple")).toEqual([]);
    expect(times(`${created.stdout}${(await next(proj, [])).out}`, LINE)).toBe(1);
  });

  test("a key typed into a question box's text field: the turn's row and the box's reply row keep it masked", async () => {
    const proj = asRepo(await projectAt("stage-gate"));
    const typed = `Request Changes, and use ${GITHUB} for CI`;
    const item = {
      question: "stage-gate", via: "picker", input: typed, expected: { end: {} },
      picker: { question: "Approve the requirements?", options: ["Approve", "Request Changes"], answer: typed },
    } as unknown as AnswersItem;
    expect((await pick(proj, item, "claude")).status).toBe(0);
    const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
    expect(turn && auditBlockField(turn.block, "Picked")).toBe(JSON.stringify([`Request Changes, and use ${MASK} for CI`]));
    const replied = readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_REPLIED").at(-1);
    expect(replied && auditBlockField(replied.block, "Reply")).toBe(`Request Changes, and use ${MASK} for CI`);
    expect(committedHolding(proj, GITHUB)).toEqual([]);
    // The hook names this chat (the session the host hands it), so the line rides the next step.
    expect(times((await next(proj, [])).out, LINE)).toBe(1);
    expect(times((await next(proj, [])).out, LINE)).toBe(0);
  });

  test("a key in the agent's own words is masked in the row, and the person hears nothing about their message", async () => {
    const proj = asRepo(await projectAt("stage-gate"));
    const item = { question: "stage-gate", via: "chat", input: "looks good, approve", expected: { end: {} } } as unknown as AnswersItem;
    expect((await reply(proj, item)).status).toBe(0);
    const note = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-audit.ts"), "append-raw", "Recovery: test database",
      `**Description**: seeded the test database with password=${PASSWORD}`, "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(note.status, note.stderr).toBe(0);
    expect(committedHolding(proj, PASSWORD)).toEqual([]);
    expect(readAllAuditShards(proj)).toContain(`**Description**: seeded the test database with password=${MASK}`);
    const reported = await recordByAgent(proj, item, "Approve");
    expect(reported?.exec.status, reported?.exec.stderr).toBe(0);
    expect(times(`${reported?.exec.stdout ?? ""}${(await next(proj, [])).out}`, LINE)).toBe(0);
  });

  test("a worktree's rows merge into the main record byte for byte, masked once at their own write", async () => {
    const proj = createTestProject();
    made.push(proj);
    seedStateFile(proj, "state-construction.md");
    seedAuditFile(proj);
    const bolt = (args: string[]) => spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-bolt.ts"), ...args, "--project-dir", proj], { encoding: "utf-8" });
    // As t77 sets it up: the worktree folder exists before the fork.
    const wt = worktreePath(proj, fixtureIntentId8(proj), "round");
    mkdirSync(wt, { recursive: true });
    const started = bolt(["start", "--name", "Round", "--batch", "1", "--worktree", "--slug", "round"]);
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);
    // The worker's own row, on the work's forked shard in its worktree.
    const write = `const { appendAuditEntry } = await import(${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-audit.ts"))});
      appendAuditEntry("HEALTH_CHECKED", { Details: process.argv[1] }, ${JSON.stringify(wt)}, ${JSON.stringify(DEFAULT_RECORD_DIR)}, ${JSON.stringify(DEFAULT_SPACE)});`;
    const appended = spawnSync(process.execPath, ["-e", write, `the worker read token=${PASSWORD} and ${MASK} already`], { encoding: "utf-8" });
    expect(appended.status, appended.stderr).toBe(0);
    const row = `**Details**: the worker read token=${MASK} and ${MASK} already\n`;
    const block = readAllAuditShards(wt, DEFAULT_RECORD_DIR, DEFAULT_SPACE).split("\n---\n").find((part) => part.includes(row)) as string;
    expect(block).toBeDefined();
    const complete = ["complete", "--name", "Round", "--batch", "1", "--merge", "--slug", "round"];
    const merged = bolt(complete);
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    expect(times(readAllAuditShards(proj), block)).toBe(1);
    expect(readAllAuditShards(proj)).not.toContain(PASSWORD);
    bolt(complete);
    expect(times(readAllAuditShards(proj), block)).toBe(1);
  });
});

describe("the masker", () => {
  const masked: Array<[string, string]> = [
    [`${keyHeader("RSA PRIVATE KEY")}\nMIIEow${run(40)}\n${run(30)}==\n${keyFooter("RSA PRIVATE KEY")}`, MASK],
    [`key:\n${keyHeader("OPENSSH PRIVATE KEY")}\\nb3Blbn${run(50)}`, `key:\n${MASK}`],
    [`the deploy key is ${GITHUB}.`, `the deploy key is ${MASK}.`],
    [`github_pat_${run(40)}`, MASK],
    [`glpat-${run(20)}`, MASK],
    [`xoxb-1234567890-${run(24)}`, MASK],
    [`STRIPE_KEY=${STRIPE}`, `STRIPE_KEY=${MASK}`],
    [`sk-ant-api03-${run(60)}`, MASK],
    [`sk-proj-${run(64)}`, MASK],
    [`sk-${run(48)}`, MASK],
    [`AIza${run(35)}`, MASK],
    [`npm_${run(36)}`, MASK],
    [`hf_${run(34)}`, MASK],
    ["postgres://app:hunter2@db:5432/app", `postgres://app:${MASK}@db:5432/app`],
    ["redis://:p4ss@cache:6379", `redis://:${MASK}@cache:6379`],
    // A password chosen as words: after a password's name, words joined by - . or _ count.
    ["password=correct-horse-battery-staple", `password=${MASK}`],
    ["the password is password=correct-horse-battery-staple.", `the password is password=${MASK}.`],
    ["DB_PASSWORD: correct_horse_battery", `DB_PASSWORD: ${MASK}`],
    ["passphrase: correct.horse.battery.staple", `passphrase: ${MASK}`],
    [`AKIA${"IOSFODNN7EXAMPLE"}`, MASK],
    [`Authorization: Bearer ${run(24)}`, `Authorization: Bearer ${MASK}`],
    [`eyJ${run(20)}.eyJ${run(20)}.${run(30)}`, MASK],
    [`password=${PASSWORD}`, `password=${MASK}`],
    [`{"db_password": "s3cret!"}`, `{"db_password": "${MASK}"}`],
    [`AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY${run(10)}`, `AWS_SECRET_ACCESS_KEY=${MASK}`],
    ["GITHUB_TOKEN: abc123xyz", `GITHUB_TOKEN: ${MASK}`],
    ["SESSION_KEY=a8f3k2p9q1", `SESSION_KEY=${MASK}`],
    ["apiKey: abc123def", `apiKey: ${MASK}`],
    [`SECRET_KEY_BASE=${hex(32)}`, `SECRET_KEY_BASE=${MASK}`],
    [`APP_KEY=base64:${run(44)}`, `APP_KEY=${MASK}`],
    [`${keyHeader("PGP PRIVATE KEY BLOCK")}\nVersion: GnuPG v2\n\n${run(64)}\n${run(30)}\n${keyFooter("PGP PRIVATE KEY BLOCK")}`, MASK],
    ["SECRET_KEY=django-insecure-9x8y7z", `SECRET_KEY=${MASK}`],
    [`${keyHeader("ENCRYPTED PRIVATE KEY")}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC123\n\n${run(64)}\n${keyFooter("ENCRYPTED PRIVATE KEY")}`, MASK],
  ];
  const leftAlone = [
    "3866bfadd0c1b2a3d4e5f60718293a4b5c6d7e8f",
    `sha256:${"0123456789abcdef".repeat(4)}`,
    "01995000-7a11-7000-8000-00000000d001",
    "5b7cd901",
    "sk-learn-pipeline-for-classification",
    "sk-proj-management-dashboard-v2",
    "task-tokenizer",
    "261024-payments",
    "src/auth/password-reset.ts",
    "the plan hashes passwords with bcrypt",
    "token: 2000",
    "use Bearer authentication for the API",
    "send Bearer authorization headers",
    "a login form with email and password: required",
    "secret: rotate weekly",
    "primary_key=user_id",
    "api_key: your-api-key-here",
    "ssh://git@github.com:22/org/repo",
    "https://example.com/path?token",
    "token_limit: 128000",
    "refresh_token_ttl_seconds: 2592000",
    "token_ttl: 3600",
    "api_key = os.environ['API_KEY']",
    "password = getpass()",
    "Password=bcrypt(cost=12)",
    // A workflow file's reference to a stored secret, written out so it is no template.
    ["secret: $", "{{ secrets.DEPLOY_TOKEN }}"].join(""),
    "Store access token in memory, refresh token in HttpOnly cookie.",
    "All API endpoints require JWT authentication with RS256 signing.",
    // A key's header named in prose, not pasted.
    `reject uploads containing ${keyHeader("RSA PRIVATE KEY")} headers and alert security, then log it`,
    `Scan for ${keyHeader("PRIVATE KEY")} markers\nThe app should also handle\nuser login. Then more`,
    `The PEM header ${keyHeader("RSA PRIVATE KEY")} is on line 1`,
    // A reference to a variable, not its value.
    "PASSWORD=$DB_PASSWORD",
    "GITHUB_TOKEN=$GITHUB_TOKEN",
    "token: $TOKEN",
    "POSTGRES_PASSWORD: $POSTGRES_PASSWORD",
    // Names that hold no secret, and settings named after one.
    `Idempotency-Key: ${uuid(5)}`,
    "cache_key: user-123",
    "s3_key: uploads/2024/avatar.png",
    "object_key=reports/2025/q1.pdf",
    `kms_key_arn: ${uuid(9)}`,
    "encryption_key_id: alias/app-kms-2024",
    "ssh_key_path: ~/.ssh/id_rsa",
    "password_complexity: upper+lower+digit",
    "password_policy: NIST-800-63B",
    "secret_id: db-creds-v2",
    "token_expiry: 30days",
    "token-limit: 8k-context",
    // A reference in an address, not its password.
    "postgres://app:$DB_PASSWORD@db:5432/app",
    ["postgres://app:$", "{DB_PASSWORD}@db"].join(""),
    "postgres://app:{{ .Values.db.password }}@db",
    // Placeholders after a token's or key's name keep their words.
    "token: your-token-here",
    "api_key: your-api-key-here",
    "password: required",
    // One hyphenated word after a password's name is prose; a passphrase has three or more words.
    "password: case-sensitive",
    "password: per-user",
    "password: change-me",
    "Login needs email and password: case-sensitive. Then a dashboard.",
    "pwd: /home/ubuntu/src/aidlc-workflows",
    // A Windows variable reference and a placeholder in an address or after a name.
    "password=%DB_PASSWORD%",
    "postgres://app:%DB_PASSWORD%@db",
    "postgres://app:<password>@db",
    // A header with many "word: " pairs on its own line: no header lines follow it, and no time is lost.
    `${keyHeader("RSA PRIVATE KEY")} ${"x: ".repeat(40)}`,
  ];

  test("masks each shape, keeping what names it", () => {
    for (const [input, expected] of masked) expect(maskSecretShapes(input), input).toBe(expected);
  });
  test("leaves engine identifiers and prose about tokens and passwords as they are", () => {
    for (const input of leftAlone) expect(maskSecretShapes(input), input).toBe(input);
  });
  test("is idempotent", () => {
    for (const input of [...masked.map(([value]) => value), ...leftAlone]) {
      const once = maskSecretShapes(input);
      expect(maskSecretShapes(once), input).toBe(once);
    }
  });
  test("the doctor bundle shares the shapes and keeps its own broader rules and markers", () => {
    expect(redactSecretPatterns(`the deploy key is ${GITHUB}`)).not.toContain(GITHUB);
    expect(redactSecretPatterns(`STRIPE_KEY=${STRIPE}`)).not.toContain(STRIPE);
    expect(redactSecretPatterns(`password=${PASSWORD}`)).toBe("password=<redacted>");
    expect(redactSecretPatterns("token=abcdefghij")).toBe("token=<redacted>");
    expect(redactSecretPatterns("Bearer authentication-header")).toBe("Bearer <redacted-token>");
    expect(redactSecretPatterns("AKIAIOSFODNN7EXAMPLE connector")).toBe("<redacted-aws-key> connector");
  });
});
