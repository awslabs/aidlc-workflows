// covers: file:scripts/ci-sanitize-logs.ts
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets, sanitizeLogs } from "../../scripts/ci-sanitize-logs.ts";

const scratch: string[] = [];
const accessKey = `AKIA${"A1".repeat(8)}`;
const sessionKey = `ASIA${"B2".repeat(8)}`;
const cli = fileURLToPath(new URL("../../scripts/ci-sanitize-logs.ts", import.meta.url));

function fixture(): string {
  // macOS temp roots may themselves be reached through /var -> /private/var.
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "aidlc-ci-sanitize-")));
  scratch.push(directory);
  return directory;
}

function put(root: string, path: string, content: string | Buffer): string {
  const file = join(root, path);
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function traceFixture(root: string): string[] {
  const paths = [
    "raw.ndjson",
    "nested/transcript.ndjson",
    "nested/sdk-drive-debug.json",
    "nested/tui-drive-output.txt",
    "nested/sdk-drive-session/deeper/output.log",
    "nested/tui-drive-session/deeper/output.log",
    "e2e-artifacts/traces/raw.txt",
    "nested/e2e-artifacts/run/harness/traces/raw.bin",
  ];
  for (const path of paths) put(root, path, "Bearer fixture-trace\n");
  put(root, "nested/traces/summary.txt", "safe transcript summary\n");
  put(root, "nested/e2e-artifacts/run/summary.json", '{"status":"passed"}\n');
  return paths;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("CI log credential redaction", () => {
  for (const keepTraces of [false, true]) {
    test(`removes Codex sandbox secret subtrees without reading them (keepTraces=${keepTraces})`, async () => {
      const root = fixture();
      const secretRoot = "e2e-artifacts/codex/retained-fixtures/project/.home/.sandbox-secrets";
      put(root, `${secretRoot}/nested/account.json`, '{"opaque":"synthetic-unrecognized-credential"}');
      put(root, "other-home/.SANDBOX-SECRETS/account.json", '{"opaque":"synthetic-other-credential"}');
      const diagnostic = put(root, "e2e-artifacts/codex/retained-fixtures/project/.home/.sandbox/sandbox.log", "setup diagnostic\n");
      const similar = put(root, ".sandbox-secrets-not-a-secret-dir/summary.log", "keep exact-name siblings\n");
      const read = fs.readFileSync;
      const hook = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]).toLowerCase().includes(".sandbox-secrets/") ||
          String(args[0]).toLowerCase().includes(".sandbox-secrets\\")) {
          throw new Error("secret content must not be opened");
        }
        return read(...args);
      }) as typeof fs.readFileSync);
      // sanitizeFile reads through a descriptor; prohibit opening these files too.
      const open = fs.openSync;
      const opener = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        if (String(path).toLowerCase().split(/[\\/]/).includes(".sandbox-secrets")) {
          throw new Error("secret content must not be opened");
        }
        return open(path, flags, mode);
      });
      try { await sanitizeLogs(root, { keepTraces }); }
      finally { hook.mockRestore(); opener.mockRestore(); }
      expect(fs.existsSync(join(root, secretRoot))).toBe(false);
      expect(fs.existsSync(join(root, "other-home/.SANDBOX-SECRETS"))).toBe(false);
      expect(fs.readFileSync(diagnostic, "utf8")).toBe("setup diagnostic\n");
      expect(fs.readFileSync(similar, "utf8")).toBe("keep exact-name siblings\n");
      const report = fs.readFileSync(join(root, "sanitizer-report.json"), "utf8");
      expect(report).toContain('"reason": "sandbox-secrets"');
      expect(report).not.toContain("account.json");
      expect(report).not.toContain("synthetic-unrecognized-credential");
    });
  }

  test("a selected log root beneath .sandbox-secrets is removed without a report inside it", async () => {
    const outer = fixture();
    const root = join(outer, ".sandbox-secrets", "nested");
    put(root, "account.json", '{"opaque":"synthetic-credential"}');
    await sanitizeLogs(root, { keepTraces: true });
    expect(fs.existsSync(root)).toBe(false);
  });

  test("a .sandbox-secrets junction is removed without touching its target", async () => {
    const root = fixture();
    const outside = fixture();
    const file = put(outside, "account.json", "synthetic outside data");
    fs.symlinkSync(outside, join(root, ".sandbox-secrets"), process.platform === "win32" ? "junction" : "dir");
    await sanitizeLogs(root, { keepTraces: true });
    expect(fs.existsSync(join(root, ".sandbox-secrets"))).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("synthetic outside data");
  });

  test("redacts the run's broker identity while retaining unrelated numeric fixtures", () => {
    const account = "123456789012";
    const arn = `arn:aws:sts::${account}:assumed-role/test-role/test-session`;
    const text = `account=${account}\ncaller=${arn}\nfixture=111122223333\nBearer fixture-token\n`;
    expect(redactSecrets(text, JSON.stringify({ account, arn }))).toBe(
      "account=[REDACTED]\ncaller=[REDACTED]\nfixture=111122223333\nBearer [REDACTED]\n",
    );
    for (const invalid of ["", "invalid-json", "null", '{"account":42,"arn":"invalid"}']) {
      expect(redactSecrets(text, invalid)).toBe(text.replace("fixture-token", "[REDACTED]"));
    }
  });

  test("redacts standalone AWS and Kiro keys without changing surrounding text", () => {
    expect(redactSecrets(`first ${accessKey}, second ${sessionKey}; ksk_fixture-123_abc. done\n`))
      .toBe("first [REDACTED], second [REDACTED]; [REDACTED]. done\n");
    const safe = "AKIAshort ASIAshort, keys: accessKeyId, ordinary text; café 日本語\r\n";
    expect(redactSecrets(safe)).toBe(safe);
  });

  test("redacts assignments, quoted credentials, and broker authentication while retaining structure", () => {
    const text = [
      "export AWS_SECRET_ACCESS_KEY=fixture/value+pad==",
      "aws_session_token = 'fixture session/+=' # comment",
      'AwS_AcCeSs_KeY_Id: "fixture-key"',
      'ANTHROPIC_API_KEY="fixture-anthropic"',
      "CURSOR_API_KEY=fixture-cursor",
      "KIRO_API_KEY=fixture-kiro",
      "AIDLC_BROKER_TOKEN=fixture-broker",
      "X-AIDLC-Broker-Token: fixture-header",
      "Authorization: bEaReR fixture-bearer_123/+=",
      '{"X-AIDLC-Broker-Token":"fixture-broker","Authorization":"Bearer fixture-json"}',
      '{"accessKeyId":"fixture-id","secretAccessKey":"fixture\\"secret","sessionToken":"fixture-session","region":"us-east-1"}',
      "status=passed",
    ].join("\r\n");
    const expected = [
      "export AWS_SECRET_ACCESS_KEY=[REDACTED]",
      "aws_session_token = '[REDACTED]' # comment",
      'AwS_AcCeSs_KeY_Id: "[REDACTED]"',
      'ANTHROPIC_API_KEY="[REDACTED]"',
      "CURSOR_API_KEY=[REDACTED]",
      "KIRO_API_KEY=[REDACTED]",
      "AIDLC_BROKER_TOKEN=[REDACTED]",
      "X-AIDLC-Broker-Token: [REDACTED]",
      "Authorization: bEaReR [REDACTED]",
      '{"X-AIDLC-Broker-Token":"[REDACTED]","Authorization":"Bearer [REDACTED]"}',
      '{"accessKeyId":"[REDACTED]","secretAccessKey":"[REDACTED]","sessionToken":"[REDACTED]","region":"us-east-1"}',
      "status=passed",
    ].join("\r\n");
    expect(redactSecrets(text)).toBe(expected);
    expect(redactSecrets(expected)).toBe(expected);
  });

  test("retains sanitized UTF-8 but removes and reports binary or unknown-encoding files", async () => {
    const root = fixture();
    const secret = put(root, "nested/output.log", `café 日本語\r\n${sessionKey}\r\n`);
    if (process.platform !== "win32") fs.chmodSync(secret, 0o640);
    const mode = fs.statSync(secret).mode;
    const clean = put(root, "clean.txt", "same bytes\r\n\tno credentials\n");
    const cleanBytes = fs.readFileSync(clean);
    const nulBytes = Buffer.from(`binary\0AWS_SECRET_ACCESS_KEY=fixture-binary ${accessKey}`);
    const invalidUtf8 = Buffer.concat([Buffer.from([0xff, 0x80]), Buffer.from(`Bearer fixture-binary ${sessionKey}`)]);
    const binary = put(root, "nested/image.bin", nulBytes);
    const invalid = put(root, "encoded.dat", invalidUtf8);
    const utf8 = put(root, "bom.log", Buffer.from(`\ufeffBearer fixture-utf8\r\n`));
    const utf16le = put(root, "windows.log", Buffer.from("\ufeffANTHROPIC_API_KEY=fixture-windows\r\n", "utf16le"));
    const utf16be = put(root, "big-endian.log", Buffer.from("\ufeffAIDLC_BROKER_TOKEN=fixture-big-endian\n", "utf16le").swap16());

    await sanitizeLogs(root);

    expect(fs.readFileSync(secret, "utf8")).toBe("café 日本語\r\n[REDACTED]\r\n");
    expect(fs.statSync(secret).mode).toBe(mode);
    expect(fs.readFileSync(clean)).toEqual(cleanBytes);
    expect(fs.existsSync(binary)).toBe(false);
    expect(fs.existsSync(invalid)).toBe(false);
    expect(fs.readFileSync(utf8)).toEqual(Buffer.from("\ufeffBearer [REDACTED]\r\n"));
    expect(fs.existsSync(utf16le)).toBe(false);
    expect(fs.existsSync(utf16be)).toBe(false);
    const report = JSON.parse(fs.readFileSync(join(root, "sanitizer-report.json"), "utf8"));
    expect(report.removed.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path))).toEqual([
      { path: "big-endian.log", reason: "invalid-utf8" },
      { path: "encoded.dat", reason: "invalid-utf8" },
      { path: "nested/image.bin", reason: "nul-byte" },
      { path: "windows.log", reason: "invalid-utf8" },
    ]);
  });

  test("deletes nested driver traces by default, not unrelated trace summaries", async () => {
    const root = fixture();
    const traces = traceFixture(root);
    put(root, "nested/output.log", "Bearer fixture-retained\n");

    await sanitizeLogs(root);

    for (const path of traces) expect(fs.existsSync(join(root, path)), path).toBe(false);
    expect(fs.existsSync(join(root, "nested/sdk-drive-session"))).toBe(false);
    expect(fs.existsSync(join(root, "nested/tui-drive-session"))).toBe(false);
    expect(fs.existsSync(join(root, "nested/e2e-artifacts/run/harness/traces"))).toBe(false);
    expect(fs.readFileSync(join(root, "nested/output.log"), "utf8")).toBe("Bearer [REDACTED]\n");
    expect(fs.readFileSync(join(root, "nested/traces/summary.txt"), "utf8")).toBe("safe transcript summary\n");
    expect(fs.readFileSync(join(root, "nested/e2e-artifacts/run/summary.json"), "utf8")).toBe('{"status":"passed"}\n');
  });

  test("explicit trace retention still redacts all retained driver text", async () => {
    const root = fixture();
    const traces = traceFixture(root);

    await sanitizeLogs(root, { keepTraces: true });

    for (const path of traces) {
      expect(fs.readFileSync(join(root, path), "utf8"), path).toBe("Bearer [REDACTED]\n");
    }
  });

  test("recognizes an e2e-artifacts ancestor outside the selected log root", async () => {
    const outer = fixture();
    const root = join(outer, "e2e-artifacts", "run");
    put(root, "nested/traces/raw.log", "trace contents");
    put(root, "summary.log", "passed");

    await sanitizeLogs(root);

    expect(fs.existsSync(join(root, "nested/traces"))).toBe(false);
    expect(fs.readFileSync(join(root, "summary.log"), "utf8")).toBe("passed");
  });

  test("a missing log directory is a successful no-op without creating it", async () => {
    const missing = join(fixture(), "missing", "logs");
    await sanitizeLogs(missing);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test.each([false, true])("removes directory links without touching outside data (keepTraces=%s)", async (keepTraces) => {
    const root = fixture();
    const outside = fixture();
    const body = "Bearer fixture-outside\n";
    put(outside, "outside.log", body);
    put(outside, "outside.ndjson", body);
    const link = join(root, "outside-link");
    const traceLink = join(root, "e2e-artifacts", "nested", "traces");
    fs.mkdirSync(dirname(traceLink), { recursive: true });
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(outside, traceLink, process.platform === "win32" ? "junction" : "dir");

    await sanitizeLogs(root, { keepTraces });

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(traceLink)).toBe(false);
    expect(fs.readFileSync(join(outside, "outside.log"), "utf8")).toBe(body);
    expect(fs.readFileSync(join(outside, "outside.ndjson"), "utf8")).toBe(body);
  });

  test.skipIf(process.platform === "win32")("removes file and dangling symlinks without writing targets", async () => {
    const root = fixture();
    const outside = fixture();
    const target = put(outside, "credentials.txt", "AWS_SECRET_ACCESS_KEY=fixture-outside\n");
    const fileLink = join(root, "credentials.log");
    const dangling = join(root, "missing.log");
    fs.symlinkSync(target, fileLink);
    fs.symlinkSync(join(outside, "absent"), dangling);

    await sanitizeLogs(root);

    expect(() => fs.lstatSync(fileLink)).toThrow();
    expect(() => fs.lstatSync(dangling)).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("AWS_SECRET_ACCESS_KEY=fixture-outside\n");
  });

  test("removes a linked root but refuses a linked ancestor without traversing it", async () => {
    const outer = fixture();
    const outside = fixture();
    const body = "Bearer fixture-outside-root\n";
    put(outside, "nested/output.log", body);
    const rootLink = join(outer, "logs-link");
    fs.symlinkSync(outside, rootLink, process.platform === "win32" ? "junction" : "dir");

    await expect(sanitizeLogs(join(rootLink, "nested"))).rejects.toThrow("linked ancestor");
    expect(fs.readFileSync(join(outside, "nested/output.log"), "utf8")).toBe(body);
    await sanitizeLogs(rootLink);
    expect(fs.existsSync(rootLink)).toBe(false);
    expect(fs.readFileSync(join(outside, "nested/output.log"), "utf8")).toBe(body);
  });

  test("CLI sanitizes artifacts and honors only the exact trace retention opt-in", () => {
    const root = fixture();
    const trace = put(root, "nested/sdk-drive.ndjson", "Bearer fixture-cli-trace\n");
    const log = put(root, "output.log", "ANTHROPIC_API_KEY=fixture-cli-log\n");
    const retained = Bun.spawnSync([process.execPath, cli, root], {
      env: { ...process.env, AIDLC_NIGHTLY_UPLOAD_TRACES: "1" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(retained.exitCode, retained.stderr.toString()).toBe(0);
    expect(retained.stdout.toString()).toBe("");
    expect(fs.readFileSync(trace, "utf8")).toBe("Bearer [REDACTED]\n");
    expect(fs.readFileSync(log, "utf8")).toBe("ANTHROPIC_API_KEY=[REDACTED]\n");

    const pruned = Bun.spawnSync([process.execPath, cli, root], {
      env: { ...process.env, AIDLC_NIGHTLY_UPLOAD_TRACES: "true" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(pruned.exitCode, pruned.stderr.toString()).toBe(0);
    expect(fs.existsSync(trace)).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toBe("ANTHROPIC_API_KEY=[REDACTED]\n");
  });

  test("CLI fails without leaking an unsafe path into diagnostic output", () => {
    const root = fixture();
    const unsafe = put(root, "ANTHROPIC_API_KEY=fixture-not-for-logs", "not a directory");
    const result = Bun.spawnSync([process.execPath, cli, unsafe], {
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).not.toContain("fixture-not-for-logs");
    expect(result.stderr.toString()).not.toContain(unsafe);
    expect(fs.readFileSync(unsafe, "utf8")).toBe("not a directory");
  });
});
