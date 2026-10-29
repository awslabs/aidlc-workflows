// The check (lib-gate.ts) reads the files to be sent as written, never through redaction: a value redaction
// left behind is refused here, a label and a value the person allowed exempt only their own span, and safe.json
// holds only AI-DLC's words, this skill's, labels and known shapes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type GateContext, safeHits, skillWords, textHits } from "../../core/skills/aidlc-issue-report/scripts/lib-gate.ts";
import { importSecretRules } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";
import { type Dictionary, redact, useSecretRules } from "../../core/skills/aidlc-issue-report/scripts/redact.ts";

const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path
useSecretRules(await importSecretRules(RULES));

const AIDLC_WORDS = ["code-generation", "functional-design", "traceability", "HUMAN_TURN", "GATE_OPENED", "SENSOR_PASSED", "aidlc-state.md", "feature", "kiro"];
const ctx = (dict: Dictionary = { entries: [] }, allowed: string[] = []): GateContext => ({
  words: new Set([...AIDLC_WORDS, ...skillWords()]),
  dict,
  allowed,
});
const reasons = (text: string, c = ctx()) => textHits(c, text).map((h) => h.reason);

describe("what redaction leaves behind is refused", () => {
  const project: Dictionary = { entries: [{ value: "/srv/shop", label: "<project>", kind: "path" }] };
  test("each value a redaction rule missed is refused in what redact() wrote", () => {
    for (const [line, dict] of [
      [["<user>pass", "word=192.168.0.1-PrivateTail99"].join(""), { entries: [] }],
      ["<user>password=<redacted>Secret1234", { entries: [] }],
      ["https://tenant.example/<user>/Bearer abcdefgh12345678", { entries: [] }],
      ['"/srv/shop Finance Shared/x/<user>"', project],
      ['"/srv/shop HTTPS://tenant.example/PrivateTenant"', project],
      ['"/srv/shop\tFinance Shared/x"', project],
      ["QQabcdefl0qq://tenant.example/x", { entries: [] }],
    ] as Array<[string, Dictionary]>) {
      expect(textHits(ctx(dict), redact(line, dict)).length).toBeGreaterThan(0);
    }
  });
  test("an address, an email, an IP, a home and a host in less common shapes are refused", () => {
    for (const line of [
      "see __https://intranet.contoso.example/finance__",
      "id_https://intranet.contoso.example/x",
      "open www.intranet-contoso.example/finance",
      "mail rené@contoso.example",
      "server fe80::1ff:fe23:4567:890a",
      "C:\\users\\bob\\Documents\\x.txt",
      "/Users/jane doe/x",
      "the host intranet.contoso.example answered",
      "token=abc",
      `GITHUB_TOKEN_X=${["abcd", "1234", "efgh"].join("")}`,
      "Authorization: Basic dXNlcjpwYXNzd29yZDEy",
      "a%40b and &#64; and \\u0040",
      "the <div> and a <placeholder left>",
      "the 김기현 team",
      "account 123456789012",
      "mac aa:bb:cc:dd:ee:ff",
      "<customer-1>.com hosts it",
    ]) {
      expect(reasons(line).length).toBeGreaterThan(0);
    }
  });
  test("a hit names the line and the reason, never the value", () => {
    const hits = JSON.stringify(textHits(ctx(), "ok\nmail kim@acme.example"));
    expect(hits).toContain('"line":2');
    expect(hits).not.toContain("kim");
    expect(hits).not.toContain("acme");
  });
});

describe("what a report says is not refused", () => {
  test("the template's words, labels, AI-DLC's names and its own paths pass", () => {
    for (const line of [
      "- Trying to: approve the code-generation plan in Construction for <intent-1>",
      "| Window | 2026-10-23T08:00:00Z – 2026-10-30T08:00:00Z (UTC) |",
      "| Model · effort | claude-opus-5-5 (12 sessions) · high; Kiro agent `aidlc` |",
      "- Evidence: `HUMAN_TURN` ×4, `GATE_OPENED` ×3 · doctor `hooks-health-stale`, e.g. at 10:12",
      "the state file at `<project>/aidlc/spaces/<space-1>/intents/<intent-1>/aidlc-state.md` and `~/.kiro/settings/cli.json`",
      "run `aidlc engine sensor-traceability --stage functional-design`; `/aidlc --doctor --export` makes one",
      "password=<redacted> and Authorization: Bearer <redacted-token>, Basic Onboarding",
      "the token budget ran out; 3/5 checks passed; SENSOR_PASSED=29",
      "Kiro CLI 2.33.1 (at collection), AI-DLC 2.11.2, darwin 25.6.0 arm64",
    ]) {
      expect([line, reasons(line)]).toEqual([line, []]);
    }
  });
  test("a value the person allowed passes exactly, and nothing around it", () => {
    const allowed = ["Error: ENOENT /srv/shop/contoso.yaml"];
    expect(reasons("The tool printed Error: ENOENT /srv/shop/contoso.yaml once.", ctx(undefined, allowed))).toEqual([]);
    expect(reasons("The tool printed Error: ENOENT /srv/shop/contoso.yaml.bak once.", ctx(undefined, allowed)).length).toBeGreaterThan(0);
    expect(reasons("Error: ENOENT /srv/shop/contoso.yaml and password=hunter22x", ctx(undefined, allowed))).toContain("a credential");
  });
});

describe("safe.json", () => {
  const field = (value: unknown) => safeHits(ctx(), value).map((h) => `${h.field}: ${h.reason}`);
  test("AI-DLC's words, the skill's own, labels, times, versions and counts pass", () => {
    expect(
      field({
        schema: 2,
        generatedAt: "2026-10-30T08:00:00.000Z",
        environment: { os: "linux 6.8.0-45-generic x64", toolsUsed: ["kiro-cli"], native: { sourceRef: "refs/tags/v2.11.2" } },
        audit: { counts: { HUMAN_TURN: 4, "<custom-event-1>": 1 }, absence: [{ kind: "same-error-repeated x2 (<custom-tool-1>)" }] },
        transcripts: [{ tool: "kiro (v3: Kiro CLI)", handRunChecks: [{ check: "sensor-traceability --stage functional-design", pass: true }] }],
        intents: [{ scope: "feature", stages: { "code-generation": "-", "<custom-stage-1>": "S" } }],
      }),
    ).toEqual([]);
  });
  test("a value that is not one of them is refused, by its field", () => {
    expect(field({ environment: { os: "linux 6.8.0-PrivateTail99 x64" } })).toEqual(["safe.environment.os: not one of AI-DLC's words, a label or a known shape (replace it with <redacted>)"]);
    expect(field({ intents: [{ scope: "contoso-billing" }] }).length).toBe(1);
    expect(field({ audit: { counts: { CONTOSO_FAILED: 1 } } }).length).toBe(1);
    expect(field({ transcripts: [{ notes: ["read from https://tenant.example/x"] }] }).length).toBeGreaterThan(0);
  });
  test("a kernel release keeps only a distribution's own words", async () => {
    const { KERNEL_RELEASE } = await import("../../core/skills/aidlc-issue-report/scripts/lib-shape.ts");
    for (const r of ["6.8.0-45-generic", "5.15.167.4-microsoft-standard-WSL2", "6.1.112-122.189.amzn2023.x86_64", "25.6.0"]) expect(KERNEL_RELEASE.test(r)).toBe(true);
    expect(KERNEL_RELEASE.test("6.8.0-PrivateTail99")).toBe(false);
  });
});

test("the skill's own sentences in safe.json pass the report's rules", () => {
  const scripts = join(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts");
  const sentences = [...readFileSync(join(scripts, "collect.ts"), "utf8").matchAll(/^\s*"([A-Z][^"\n]{20,})",$/gm)].map((m) => m[1]);
  expect(sentences.length).toBeGreaterThan(3);
  for (const s of sentences) expect([s, reasons(s)]).toEqual([s, []]);
});

describe("shapes the round-11 reviews found", () => {
  test("a credential under any spelling of its name is refused", () => {
    for (const line of [
      "export db_pass=Summer2024",
      "dbPassword=Summer2024",
      "db_password=Summer2024!",
      "mysql_pwd: Summer2024",
      "github_token: ghp_x9Yz",
      "aws_secret_access_key = abcdefghij",
      "AIDLC_PLUGIN_KEY=hunter2pw",
      "apiKey: abcd",
    ]) {
      expect([line, reasons(line, { ...ctx(), words: new Set([...ctx().words, "AIDLC_PLUGIN_KEY"]) }).includes("a credential")]).toEqual([line, true]);
    }
    for (const line of ["Key finding: the gate opened twice", "Confidence: high", "SENSOR_PASSED=29", "Trying to: approve the plan", "AIDLC_PLUGIN_KEY=<redacted>"]) {
      expect([line, reasons(line, { ...ctx(), words: new Set([...ctx().words, "AIDLC_PLUGIN_KEY"]) })]).toEqual([line, []]);
    }
  });
  test("an allowed value exempts only itself as a whole word, and never in safe.json", () => {
    expect(reasons("connect to 192.168.10.5 failed", ctx(undefined, ["10"])).length).toBeGreaterThan(0);
    expect(reasons("account 123456789012", ctx(undefined, ["3456"])).length).toBeGreaterThan(0);
    expect(safeHits(ctx(undefined, ["192.168.10.5"]), { notes: ["connect 192.168.10.5"] }).length).toBeGreaterThan(0);
  });
  test("invisible characters, full-width signs and grouped digits do not hide a value", () => {
    for (const line of ["bob​@​example​.com", "bob＠example．com", "10．0．0．5", "1234-5678-9012", "card 4111 1111 1111 1111", "a\u00a0b", "x\u200by", "a\u001bb"]) {
      expect(reasons(line).length).toBeGreaterThan(0);
    }
    expect(reasons("Window 2026-10-23 – 2026-10-30 · effort high — ok… ×4 → done")).toEqual([]);
    expect(reasons("a\tb\r")).toEqual([]);
  });
  test("safe.json takes no long number, no unknown flag and no hidden name in any field", () => {
    const d: Dictionary = { entries: [{ value: "contoso", label: "<customer-1>", kind: "named" }] };
    for (const value of [{ intents: [{ status: "123456789012" }] }, { audit: { rowsTotal: 2065550100123 } }, { transcripts: [{ aidlcCommands: { "aidlc next --bob-jones": 1 } }] }, { environment: { native: { dir: "contoso" } } }]) {
      expect([value, safeHits(ctx(d), value).length > 0]).toEqual([value, true]);
    }
  });
});

describe("shapes the round-11 Codex review found", () => {
  const d: Dictionary = {
    entries: [
      { value: "Contoso", label: "<customer-1>", kind: "named" },
      { value: "Acme Corp", label: "<customer-2>", kind: "named" },
    ],
  };
  test("an authorization header takes only a label; a credential's value on the next line is still its value", () => {
    for (const text of ["Authorization: Bearer abc", "Authorization: Basic ajopaioh", "credentials:\nabc", "password =\n  hunter22x"]) {
      expect([text, textHits(ctx(), text).some((h) => h.reason === "a credential")]).toEqual([text, true]);
    }
    for (const text of ["Authorization: Bearer <redacted-token>", "the bearer token expired", "Basic Onboarding", "the run passed (`pass: true`)"]) {
      expect([text, reasons(text)]).toEqual([text, []]);
    }
  });
  test("a host after a digit, and IPv6 in eight short groups, are refused", () => {
    for (const line of ["1.acme.com", "10:20:30:40:50:60:70:80"]) expect(reasons(line).length).toBeGreaterThan(0);
  });
  test("a hidden name split by emphasis, a link, an entity or a line break is still found", () => {
    for (const text of ["Con**toso**", "[Con](#)toso", "Con&ZeroWidthSpace;toso", "Acme\nCorp"]) {
      expect([text, textHits(ctx(d), text).length > 0]).toEqual([text, true]);
    }
    // A name that holds a sign Markdown uses is found as written too.
    expect(textHits(ctx({ entries: [{ value: "shop_api", label: "<project>", kind: "project-name" }] }), "the shop_api build").length).toBeGreaterThan(0);
  });
  test("a label holds a small number only", () => {
    expect(reasons("<customer-123456789012>").length).toBeGreaterThan(0);
    expect(reasons("<customer-12> and <custom-stage-3>")).toEqual([]);
  });
  test("an allowed value never takes a credential's name with it, and passes a hidden name it is", () => {
    expect(reasons("password=abc", ctx(undefined, ["password"]))).toContain("a credential");
    expect(textHits(ctx(d, ["Contoso"]), "the Contoso log")).toEqual([]);
  });
  test("an OS release, a model with its context suffix pass", () => {
    for (const line of ["6.8.0-45-generic", "5.15.167.4-microsoft-standard-WSL2", "claude-opus-5-5[1m]"]) expect([line, reasons(line)]).toEqual([line, []]);
  });
  test("safe.json takes no letter of another script, and no comment of this skill's scripts as a word", () => {
    expect(safeHits(ctx(), { intents: [{ scope: "김기현" }] }).length).toBeGreaterThan(0);
    expect(skillWords().has("~/Clients/Contoso Merger.pdf")).toBe(false);
    expect(safeHits(ctx(), { environment: { native: { dir: "/Users/build/.codex" } } }).length).toBeGreaterThan(0);
  });
});

describe("shapes the round-12 reviews found (values copied by mistake)", () => {
  const d: Dictionary = {
    entries: [
      { value: "Contoso", label: "<customer-1>", kind: "named" },
      { value: "Fabrikam Bank", label: "<customer-2>", kind: "named" },
      { value: "Acme Corp", label: "<customer-3>", kind: "named" },
    ],
  };
  const refused = (text: string, c = ctx(d)) => textHits(c, text).length > 0;
  test("a credential in a command, a flag, a cookie or without a sign is refused", () => {
    for (const t of [
      "mysql -u root --password s3cr3tP4ss", "curl -u admin:s3cr3tP4ss", "--token abc123def456", "PGPASSWORD hunter2",
      "apiKey hunter2", "Cookie: session=abcd1234efgh", "Bearer: abc12345", "pw=hunter22", "db_password=false", "password=no",
      "**Authorization**: Bearer abc", "**password**: hunter2",
    ]) {
      expect([t, refused(t)]).toEqual([t, true]);
    }
    for (const t of ["the GITHUB_TOKEN was set", "**password:** <redacted>", "pass: true", "run with --stage functional-design"]) {
      expect([t, reasons(t)]).toEqual([t, []]);
    }
  });
  test("an allowed value exempts only what it covers whole", () => {
    expect(refused("Fabrikam Bank rejected the call.", ctx(d, ["Bank"]))).toBe(true);
    expect(refused("password : hunter2", ctx(d, ["password"]))).toBe(true);
    expect(refused("Authorization: Bearer abc", ctx(d, ["Authorization: Bearer"]))).toBe(true);
    expect(textHits(ctx(d, ["Contoso"]), "the **Contoso** log")).toEqual([]);
  });
  test("long numbers, card, phone and personal numbers are refused", () => {
    for (const t of ["Card 4111111111111111", "SSN 123-45-6789", "+1 425 555 0100", "010-1234-5678", "tel: 4255550100", "acct 1234567890123", "Phone: +1 (206) 555-0123"]) {
      expect([t, refused(t)]).toEqual([t, true]);
    }
  });
  test("a cloud resource name, an EC2 host name, a short IPv6 and an address with a release's suffix are refused", () => {
    for (const t of ["the bucket arn:aws:s3:::acme-data", "host ip-10-0-1-23 failed", "server 10:20::30:40", "host 10.20.30.40-aws"]) {
      expect([t, refused(t)]).toEqual([t, true]);
    }
  });
  test("a hidden name with two spaces in it, or the gate's own stand-in character, does not get through", () => {
    expect(refused("Acme  Corp signed off")).toBe(true);
    expect(refused("Con\uE000toso failed")).toBe(true);
  });
  test("safe.json takes no long label number, no address as an OS release, no long repeat count and no number as a version or a path", () => {
    for (const value of [
      { intents: [{ scope: "<customer-123456789012>" }] },
      { environment: { os: "linux 10.20.30.40 x64" } },
      { intents: [{ scope: "aidlc x123456789012" }] },
      { intents: [{ scope: "425.555.0100" }] },
      { intents: [{ scope: "1.2.3-99999999" }] },
      { environment: { native: { dir: "4255550100" } } },
    ]) {
      expect([value, safeHits(ctx(d), value).length > 0]).toEqual([value, true]);
    }
  });
});

describe("shapes the round-13 reviews found (values copied by mistake)", () => {
  const refused = (text: string, c = ctx()) => textHits(c, text).length > 0;
  test("short password options, a credential after another name, and a password after a space are refused", () => {
    for (const t of [
      "mysql -u admin -pPa55word! -h db", "docker login -u bob -p Pa55word!", "sshpass -p 'Pa55word!' ssh x", "redis-cli -a hunter2",
      ["curl -u", "admin:hunter2 x"].join(""), "-Dpassword=hunter2", "env: PGPASSWORD=qwerty12", "error: DB_PASSWORD=Pa55w",
      "ConnectionStrings: Password=Pa55", "Failed: token=abc", "Error: api_key=xyz", '$env:API_TOKEN="abc"',
      "machine host login bob password hunter2", "password Pa55word!", "--password correcthorse", "--api-key abcdefgh",
      "GITHUB_TOKEN abcdefgh", "aws configure set aws_secret_access_key abcdefg",
    ]) {
      expect([t, refused(t)]).toEqual([t, true]);
    }
  });
  test("counts, modes and AI-DLC's own address are not credentials or addresses", () => {
    for (const t of [
      "Pass: 29, Fail: 0", "token_count: 4521", "TOKEN_LIMIT=200000", "auth: ok", "Auth: none", "AUTH_MODE=oauth",
      "see https://github.com/awslabs/aidlc-workflows/issues/2706", "a Node.js tool", "mkdir -p out and ssh -p 22 host",
      "the password reset page", "the GITHUB_TOKEN was set", "run with --password-stdin",
    ]) {
      expect([t, reasons(t)]).toEqual([t, []]);
    }
  });
  test("more number shapes and host names that spell an IP are refused", () => {
    for (const t of ["3782 822463 10005", "+33 1 23 45 67 89", "+61 2 1234 5678", "SSN 123 45 6789", "800101-1234567", "ec2-3-91-12-4", "IP-10-0-1-23", "node-10-0-1-23"]) {
      expect([t, refused(t)]).toEqual([t, true]);
    }
    expect(reasons("from 2026-10-23 to 2026-10-30, 3 of 5")).toEqual([]);
  });
});

describe("shapes the round-13 Codex review found (values copied by mistake)", () => {
  const refused = (text: string) => textHits(ctx(), text).length > 0;
  test("a numeric or sign-only credential, and one the scheme word stands for, are refused", () => {
    for (const t of ["passcode=123456", "pw=basic", "pw='!!!'", "mysql --password hunter", "PGPASSWORD hunter"]) expect([t, refused(t)]).toEqual([t, true]);
  });
  test("phone numbers with dots, file names, cloud resource ids and short IPv6 are refused", () => {
    for (const t of ["call 212.555.1234", "read /data/2026/1234", "the .env file", "wrote 2026.csv", "sg-1234abcd", "subnet-ab12cd34", "i-0abc12345def67890", "::1", "10::20", "2001:db8::"]) {
      expect([t, refused(t)]).toEqual([t, true]);
    }
  });
  test("a file named with its line, a Windows build and a slice pass", () => {
    for (const t of ["see aidlc-state.md:123 and `~/.kiro/settings/cli.json:4`", "Python slice [1::2]", "3/5 checks"]) expect([t, reasons(t)]).toEqual([t, []]);
    expect(safeHits(ctx(), { environment: { os: "win32 10.0.26100 x64" } })).toEqual([]);
  });
  test("safe.json refuses a credential's value held in a list, and a phone written as a version", () => {
    for (const value of [{ audit: { counts: { password: ["123456"] } } }, { intents: [{ scope: "212.555.1234" }] }, { passcode: "123456" }]) {
      expect([value, safeHits(ctx(), value).length > 0]).toEqual([value, true]);
    }
  });
});

test("what a version is has one owner, shared by collect, set-version and the check", async () => {
  const { exactVersion, version } = await import("../../core/skills/aidlc-issue-report/scripts/lib-shape.ts");
  for (const v of ["1.104.10000", "2026.01.5", "212.555.1234"]) expect([v, exactVersion(v), version(v)]).toEqual([v, null, null]);
  for (const v of ["2.33.1", "2.11.2-preview.20261029.1", "3.0.0-rc.2"]) expect([v, safeHits(ctx(), { environment: { bun: exactVersion(v) } })]).toEqual([v, []]);
});

test("a slash standing alone between two values is not a path", () => {
  expect(reasons("| Kiro engine | configured: project `v3` / home `v3`; ran: `v3` |")).toEqual([]);
});

describe("AI-DLC's own messages", () => {
  const phrases = [
    "Cannot request review pass",
    '" because this stage allows',
    "Do not ask the reviewer again; include the findings in the approval summary for the human.",
    "Apply any fixes first, then request the review with --iteration <next ordinal>",
  ];
  const c = (dict: Dictionary = { entries: [] }) => ({ ...ctx(dict), phrases });
  test("a message is quoted as it is, whole or cut short, without asking", () => {
    for (const t of [
      '- `Cannot request review pass 2 for "contract-design" because this stage allows 1 review pass. Do not ask the reviewer again; include the findings in the approval summary for the human.`',
      "- the engine said: `Apply any fixes first, then request the review with --iteration <next ordinal> …`",
    ]) {
      expect([t, textHits(c(), t)]).toEqual([t, []]);
    }
  });
  test("what a message filled in is still checked", () => {
    const d: Dictionary = { entries: [{ value: "Contoso", label: "<customer-1>", kind: "named" }] };
    for (const t of [
      'Cannot request review pass 2 for "/srv/contoso/app" because this stage allows 1 review pass.',
      'Cannot request review pass 2 for "Contoso" because this stage allows 1 review pass.',
      "Cannot request review pass 2 with password=hunter22x",
    ]) {
      expect([t, textHits(c(d), t).length > 0]).toEqual([t, true]);
    }
  });
});

describe("what collect writes on every platform", () => {
  test("the skill's own sentences with its local/ folder, and the doctor bundle's own path, pass safe.json", () => {
    const value = {
      doctor: { note: "the export stays in local/doctor-raw and is not sent" },
      transcripts: [{ tool: "codex", error: "this reader failed (details in local/errors.jsonl)" }],
      secretRules: ".claude/tools/aidlc-doctor-bundle.ts",
    };
    expect(safeHits({ ...ctx(), words: new Set([...skillWords()]) }, value)).toEqual([]);
  });
  test("an OS line passes as the shaper writes it on Windows, Linux and macOS, and an address in it does not", async () => {
    const { Shaper, Labels } = await import("../../core/skills/aidlc-issue-report/scripts/lib-shape.ts");
    const { emptyVocab } = await import("../../core/skills/aidlc-issue-report/scripts/lib-vocab.ts");
    const shaper = new Shaper(emptyVocab(), new Labels());
    const os = (line: string) => shaper.environment({ os: line, bun: null, pin: null, native: null, tools: {}, kiroHomeEngine: { file: false, agentEngine: null } }).os;
    expect(os("win32 10.0.26100 x64")).toBe("win32 10.0.26100 x64");
    expect(os("linux 6.8.0-acme x64")).toBe("linux x64");
    for (const line of ["win32 10.0.26100 x64", "linux 6.8.0 x64", "linux x64", "darwin 25.6.0 arm64", "linux 5.15.167.4-microsoft-standard-WSL2 x64"]) {
      expect([line, safeHits(ctx(), { environment: { os: line } })]).toEqual([line, []]);
    }
    expect(safeHits(ctx(), { environment: { os: "linux 10.20.30.40 x64" } }).length).toBe(1);
  });
});

test("an AI-DLC public address passes only as a plain link; anything after its host is still read", () => {
  expect(reasons("see https://github.com/awslabs/aidlc-workflows/issues/2706 and https://kiro.dev/docs/hooks")).toEqual([]);
  for (const t of [
    "See https://github.com/awslabs/aidlc-workflows/issues/alice@contoso.com",
    "https://kiro.dev/10.20.30.40/x",
    "https://kiro.dev/arn:aws:iam::x:role/y",
    "https://code.claude.com/~/Clients/Contoso/a.pdf",
  ]) {
    expect([t, reasons(t).length > 0]).toEqual([t, true]);
  }
});

test("the readers' own notes pass the report's rules", () => {
  const notes = [...readFileSync(join(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"), "utf8").matchAll(/notes\.push\("([^"]+)"\)/g)].map((m) => m[1]);
  expect(notes.length).toBeGreaterThan(3);
  for (const n of notes) expect([n, reasons(n)]).toEqual([n, []]);
});
