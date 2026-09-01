// covers: tool:aidlc-init, function:probeHarnessCli, function:providerDoctorCheck, function:acquireRelease

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  probeHarnessCli,
  providerDoctorCheck,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import { firstRunPathRemediation } from "../../core/tools/aidlc-init.ts";
import { acquireRelease } from "../../core/tools/aidlc-release.ts";
import { machineTransactionRoot } from "../../core/tools/aidlc-install-paths.ts";
import {
  executePlan,
  transactionState,
  writeOperation,
} from "../../core/tools/aidlc-transaction.ts";

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST = join(REPO_ROOT, "dist");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("AIDLC_") || name.startsWith("CLAUDE_") || name.startsWith("KIRO_")) {
      delete env[name];
    }
  }
  return { ...env, ...extra };
}

function readmeCopyProject(): string {
  const project = temp("aidlc-t304-copy-");
  mkdirSync(join(project, ".git"));
  cpSync(join(DIST, "claude", ".claude"), join(project, ".claude"), {
    recursive: true,
  });
  cpSync(join(DIST, "claude", "aidlc"), join(project, "aidlc"), {
    recursive: true,
  });
  return project;
}

function runCopied(
  project: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    BUN,
    [join(project, ".claude", "tools", "aidlc.ts"), ...args],
    {
      cwd: project,
      env: cleanEnv(options.env),
      input: options.input,
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function expectCopyChannelPurity(output: string): void {
  expect(output).not.toContain("Run: ");
  expect(output).not.toMatch(
    /(?:^|[\s`'"])aidlc (?:config|doctor|update|use|uninstall|version)(?:\s|[`'"]|$)/m,
  );
}

function runWizard(
  input: string,
  options: { hasCredentials?: boolean } = {},
): {
  project: string;
  status: number;
  stdout: string;
  stderr: string;
} {
  const project = temp("aidlc-t304-wizard-");
  mkdirSync(join(project, ".git"));
  const hasCredentials = options.hasCredentials ?? true;
  const detection = JSON.stringify({
    harnesses: {
      claude: { found: false, probed: true },
      codex: { found: false, probed: true },
      copilot: { found: false, probed: true },
      cursor: { found: false, probed: true },
      kiro: { found: false, probed: true },
      "kiro-ide": { found: false, probed: false },
      opencode: { found: false, probed: true },
    },
    aws: {
      hasCredentials,
      sources: hasCredentials ? ["fixture"] : [],
      profiles: [],
      regions: hasCredentials ? ["us-east-2"] : [],
      files: [],
    },
    runtimeIssues: [],
  });
  const result = spawnSync(BUN, [INIT, "config", "--project-dir", project], {
    cwd: project,
    env: cleanEnv({
      AIDLC_RUNTIME_ROOT: DIST_RELEASE,
      AIDLC_TEST_CONFIG_TTY: "1",
      AIDLC_TEST_CONFIG_DETECTION_JSON: detection,
    }),
    input,
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    project,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("t304 copied projection configuration", () => {
  test("copied projection descriptors reject traversal before reading outside bytes", () => {
    const project = readmeCopyProject();
    const outside = temp("aidlc-t304-outside-");
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "keep\n");
    const descriptorPath = join(
      project,
      ".claude",
      "tools",
      "data",
      "aidlc-projection.json",
    );
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    descriptor.managedDirectories.push("../outside");
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    const result = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
      "--yes",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "managed directory is not a safe top-level name",
    );
    expect(readFileSync(sentinel, "utf-8")).toBe("keep\n");
  });

  test.skipIf(process.platform === "win32")(
    "copied projection metadata and nested content must be regular files",
    () => {
      const metadataProject = readmeCopyProject();
      const descriptorPath = join(
        metadataProject,
        ".claude",
        "tools",
        "data",
        "aidlc-projection.json",
      );
      const outsideDescriptor = join(temp("aidlc-t304-metadata-"), "descriptor.json");
      writeFileSync(outsideDescriptor, readFileSync(descriptorPath));
      rmSync(descriptorPath);
      symlinkSync(outsideDescriptor, descriptorPath);
      const metadata = runCopied(metadataProject, [
        "config",
        "models",
        "--preset",
        "balanced",
        "--project",
        "--yes",
      ]);
      expect(metadata.status).not.toBe(0);
      expect(metadata.stdout + metadata.stderr).toContain(
        "projected path traverses a symlink: .claude/tools/data/aidlc-projection.json",
      );

      const nestedProject = readmeCopyProject();
      const outside = join(temp("aidlc-t304-link-"), "outside.txt");
      writeFileSync(outside, "outside\n");
      symlinkSync(outside, join(nestedProject, ".claude", "linked-outside"));
      const nested = runCopied(nestedProject, [
        "config",
        "models",
        "--preset",
        "balanced",
        "--project",
        "--yes",
      ]);
      expect(nested.status).not.toBe(0);
      expect(nested.stdout + nested.stderr).toContain(
        "links and special files are not valid projection content",
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "root integrations reject a symlinked parent before reading outside bytes",
    () => {
      const project = readmeCopyProject();
      const outside = temp("aidlc-t304-parent-link-");
      writeFileSync(join(outside, "secret.txt"), "outside-secret\n");
      symlinkSync(outside, join(project, "escape"));
      const descriptorPath = join(
        project,
        ".claude",
        "tools",
        "data",
        "aidlc-projection.json",
      );
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
      descriptor.rootIntegrations.push({
        path: "escape/secret.txt",
        policy: "whole-file",
      });
      writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

      const result = runCopied(project, [
        "config",
        "models",
        "--preset",
        "balanced",
        "--project",
        "--yes",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "projected path traverses a symlink: escape/secret.txt",
      );
      expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe(
        "outside-secret\n",
      );
    },
  );

  test("the exact README Claude copy records settings and diagnostic answers without a runtime", () => {
    const project = readmeCopyProject();
    const models = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
      "--yes",
    ]);
    expect(models.status, models.stdout + models.stderr).toBe(0);
    expect(models.stdout).not.toContain("harness claude is not installed");

    const providers = runCopied(project, [
      "config",
      "providers",
      "--provider",
      "other",
      "--acknowledge",
      "--yes",
    ]);
    expect(providers.status, providers.stdout + providers.stderr).toBe(0);

    const trust = runCopied(project, [
      "config",
      "trust",
      "--acknowledge",
      "--yes",
    ]);
    expect(trust.status, trust.stdout + trust.stderr).toBe(0);

    expect(JSON.parse(readFileSync(join(project, "aidlc.settings.json"), "utf-8")))
      .toEqual(expect.objectContaining({
        models: expect.objectContaining({ preset: "balanced" }),
      }));
    const harness = JSON.parse(
      readFileSync(join(project, ".claude", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(harness.providers.provider).toBe("other");
    expect(harness.trust.reviewed).toBe(true);
  }, 60_000);

  test("bare config announces and uses the recognized copied-projection walk", () => {
    const project = readmeCopyProject();
    const result = runCopied(project, ["config"], {
      input: "n\n",
      env: { AIDLC_TEST_CONFIG_TTY: "1" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "using the existing copied projection",
    );
    expect(result.stdout).toContain("Setup check -");
    expect(result.stdout).not.toContain("harness claude is not installed");
  });

  test("copy-channel project refresh names the two real source options", () => {
    const project = readmeCopyProject();
    const result = runCopied(project, [
      "config",
      "project",
      "--plugins",
      "all",
      "--mcp",
      "none",
      "--yes",
    ]);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain("copy-channel project");
    expect(result.stdout).toContain("Install the native aidlc command");
    expect(result.stdout).toContain("re-copy the matching dist/<harness>/ tree");
    expect(result.stdout).not.toContain("harness claude is not installed");
  });

  test("human config usage errors use the shared lowercase voice", () => {
    const project = readmeCopyProject();
    const result = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toStartWith("error:");
    expect(result.stdout).toContain(
      "\nusage: bun .claude/tools/aidlc.ts config models --preset balanced --project --yes",
    );
    expect(result.stdout).not.toContain("ERROR ");
    expect(result.stdout).not.toContain("Run: ");
  });

  test("copy-channel doctor, config, and error output never leaks native invocations", () => {
    const project = readmeCopyProject();
    const machineRoot = temp("aidlc-t304-machine-");
    const env = { AIDLC_INSTALL_ROOT: machineRoot };
    const git = spawnSync("git", ["init", "-q"], {
      cwd: project,
      encoding: "utf-8",
    });
    expect(git.status, git.stderr ?? "").toBe(0);
    const doctor = runCopied(project, ["doctor"], { env });
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain(
      "fix: run `bun .claude/tools/aidlc.ts update --check`",
    );
    expect(doctor.stdout).toContain(
      "fix: run `bun .claude/tools/aidlc.ts doctor --verbose`",
    );

    const topTypo = runCopied(project, ["confg"], { env });
    expect(topTypo.status).toBe(2);
    expect(topTypo.stderr).toContain(
      "usage: bun .claude/tools/aidlc.ts <command> [flags]",
    );

    const sectionTypo = runCopied(project, ["config", "modles"], {
      env: { ...env, AIDLC_TEST_CONFIG_TTY: "1" },
      input: "",
    });
    expect(sectionTypo.status).toBe(2);
    expect(sectionTypo.stderr).toContain(
      "usage: bun .claude/tools/aidlc.ts config <section> [flags]",
    );

    const noYes = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
    ], { env });
    expect(noYes.status).toBe(2);

    for (const result of [doctor, topTypo, sectionTypo, noYes]) {
      expectCopyChannelPurity(`${result.stdout}${result.stderr}`);
    }
  });

  test("legacy harness policy breakage collapses to one doctor row", () => {
    const project = readmeCopyProject();
    const path = join(project, ".claude", "tools", "data", "harness.json");
    const harness = JSON.parse(readFileSync(path, "utf-8"));
    harness.models = { schemaVersion: 1 };
    writeFileSync(path, `${JSON.stringify(harness, null, 2)}\n`);
    const doctor = runCopied(project, ["doctor", "--json"]);
    expect(doctor.status).toBe(1);
    const checks = (JSON.parse(doctor.stdout) as {
      data: { checks: Array<{ label: string; fix?: string }> };
    }).data.checks;
    const legacy = checks.filter((check) =>
      `${check.label} ${check.fix ?? ""}`.includes(
        "legacy policy key(s)",
      )
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0].label).toContain("Harness data:");
    expect(legacy[0].fix).toContain(
      "Remove models",
    );
  });
});

describe("t304 first-run prompt and detection safety", () => {
  test("EOF at a no-default harness prompt cancels with bounded output", () => {
    const result = runWizard("");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Nothing written.");
    expect(result.stdout.length).toBeLessThan(20_000);
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
  });

  test("EOF mid-customize cancels with bounded output", () => {
    const result = runWizard("1\n2");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Nothing written.");
    expect(result.stdout.length).toBeLessThan(20_000);
  });

  test("a same-named executable is not detected when its version probe fails", () => {
    expect(probeHarnessCli("claude", {
      interactivePath: "/fixture",
      which: () => "/fixture/claude",
      run: () => ({ status: 1, stdout: "not claude\n" }),
    })).toEqual(expect.objectContaining({
      status: "missing",
      path: "/fixture/claude",
    }));
    expect(probeHarnessCli("cursor", {
      interactivePath: "/fixture",
      which: (command) => command === "cursor" ? "/fixture/cursor" : null,
      run: () => ({ status: 0, stdout: "Cursor 1.0.0\n" }),
    })).toEqual(expect.objectContaining({
      command: "cursor",
      status: "found",
    }));
  });

  test("Windows PATH remediation names the actual User PATH directory", () => {
    expect(firstRunPathRemediation(
      "win32",
      "C:\\Users\\Example\\AppData\\Local\\aidlc\\bin",
    )).toEqual([
      "Add C:\\Users\\Example\\AppData\\Local\\aidlc\\bin to your User PATH in Windows Settings, then open a new terminal.",
    ]);
    expect(firstRunPathRemediation("linux", "/home/example/.local/bin").join("\n"))
      .toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  test("recommended defaults without credentials leave provider setup manual", () => {
    const result = runWizard("1\n\n", { hasCredentials: false });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "provider recorded as other; manual provider setup remains",
    );
    expect(result.stdout).toContain("Choose and configure a model provider");
    expect(result.stdout).not.toContain("Run: ");
    expectCopyChannelPurity(result.stdout);
    const harness = JSON.parse(
      readFileSync(join(result.project, ".claude", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(harness.providers).toBeUndefined();
  }, 120_000);
});

describe("t304 diagnostics and release truthfulness", () => {
  test("corrupt harness JSON is a failing provider doctor row with recovery", () => {
    const project = readmeCopyProject();
    const path = join(project, ".claude", "tools", "data", "harness.json");
    writeFileSync(path, "{\n");
    const check = providerDoctorCheck(project);
    expect(check).toEqual(expect.objectContaining({
      pass: false,
      label: "Providers: could not read recorded answers",
    }));
    expect(check.severity).toBeUndefined();
    expect(check.fix).toContain("restore");
  });

  test("HTTP 404 explains that no native release is published yet", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("missing", { status: 404 }),
    });
    try {
      await expect(acquireRelease({
        version: "9.9.9",
        names: ["aidlc-linux-x64"],
        baseUrl: `http://127.0.0.1:${server.port}`,
      })).rejects.toThrow("No published native release is available yet");
    } finally {
      server.stop(true);
    }
  });
});

describe("t304 transaction boundaries", () => {
  test("candidate validation cannot race a stale destination into commit", () => {
    const root = temp("aidlc-t304-transaction-race-");
    const target = join(root, "value.txt");
    writeFileSync(target, "planned\n");
    const planned = transactionState(target);

    expect(() =>
      executePlan({
        schemaVersion: 1,
        root,
        operations: [writeOperation("value.txt", "replacement\n", planned)],
      }, {
        validateCandidates: () => {
          writeFileSync(target, "concurrent\n");
        },
      })
    ).toThrow("value.txt: source changed after planning");
    expect(readFileSync(target, "utf-8")).toBe("concurrent\n");
  });

  test("machine scope excludes unrelated descendants of the shared lock root", () => {
    const home = temp("aidlc-t304-route-scope-");
    const install = join(home, ".local", "share", "aidlc");
    const bin = join(home, ".local", "bin");
    mkdirSync(join(home, ".local"), { recursive: true });
    const prior = {
      install: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
      route: process.env.AIDLC_ROUTE_ID,
      scope: process.env.AIDLC_ROUTE_MUTATION_SCOPE,
      project: process.env.AIDLC_ROUTE_PROJECT_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = install;
    process.env.AIDLC_BIN_DIR = bin;
    process.env.AIDLC_ROUTE_ID = "test-machine";
    process.env.AIDLC_ROUTE_MUTATION_SCOPE = "machine";
    process.env.AIDLC_ROUTE_PROJECT_DIR = home;
    try {
      const root = machineTransactionRoot();
      const unrelated = join(home, ".local", "unrelated-app", "owned.txt");
      expect(() =>
        executePlan({
          schemaVersion: 1,
          root,
          operations: [
            writeOperation(relative(root, unrelated), "no\n", "absent"),
          ],
        })
      ).toThrow("machine mutation scope cannot mutate project path");
      expect(existsSync(unrelated)).toBe(false);

      const owned = join(install, "owned.txt");
      executePlan({
        schemaVersion: 1,
        root,
        operations: [
          writeOperation(relative(root, owned), "yes\n", "absent"),
        ],
      });
      expect(readFileSync(owned, "utf-8")).toBe("yes\n");
    } finally {
      const restore = (name: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore("AIDLC_INSTALL_ROOT", prior.install);
      restore("AIDLC_BIN_DIR", prior.bin);
      restore("AIDLC_ROUTE_ID", prior.route);
      restore("AIDLC_ROUTE_MUTATION_SCOPE", prior.scope);
      restore("AIDLC_ROUTE_PROJECT_DIR", prior.project);
    }
  });
});
