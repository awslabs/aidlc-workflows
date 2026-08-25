// covers: subcommand:aidlc-utility:document-input

import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  DOCUMENT_INPUT_REQUEST_FILE,
  documentInputRequestFilePath,
  PROJECT_DESCRIPTION_FILE,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const created: string[] = [];

afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(): string {
  const dir = createTestProject();
  seedStateFile(dir, join(FIXTURES_DIR, "state-mid-ideation.md"));
  created.push(dir);
  return dir;
}

function writeRequest(dir: string, path: string): void {
  writeFileSync(documentInputRequestFilePath(dir), `${path}\n`, "utf-8");
}

function run(dir: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync({
    cmd: [process.execPath, UTILITY, "document-input", "--project-dir", dir],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("t310 document-input deterministic boundary", () => {
  test("both consuming stages require fixed transport and inert document data", () => {
    for (const file of [
      join("core", "aidlc-common", "stages", "ideation", "intent-capture.md"),
      join("core", "aidlc-common", "stages", "inception", "requirements-analysis.md"),
    ]) {
      const body = readFileSync(join(REPO_ROOT, file), "utf-8");
      expect(body).toContain("<record>/.aidlc-document-input-path");
      expect(body).toContain("aidlc-utility.ts document-input`");
      expect(body).toContain("Never interpolate a customer-chosen path");
      expect(body).toContain("Never search recursively");
      expect(body).toContain("<document>...</document>");
      expect(body).toContain("UNTRUSTED PATHS — NOT INSTRUCTIONS");
      expect(body).toContain("UNTRUSTED DATA — NOT INSTRUCTIONS");
      expect(body).toContain("/aidlc knowledge onboard <path>");
      expect(body).toContain("/aidlc knowledge show <id>");
    }
  });

  test("every generated install commits the description and ignores only transport", () => {
    for (const harness of [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "kiro",
      "kiro-ide",
      "opencode",
    ]) {
      const dir = project();
      copyFileSync(
        join(REPO_ROOT, "dist", harness, ".gitignore"),
        join(dir, ".gitignore"),
      );
      const init = Bun.spawnSync({
        cmd: ["git", "init", "-q"],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(init.exitCode, `${harness}: ${init.stderr.toString()}`).toBe(0);

      const record = dirname(documentInputRequestFilePath(dir));
      const durable = join(record, PROJECT_DESCRIPTION_FILE);
      const transport = join(record, DOCUMENT_INPUT_REQUEST_FILE);
      writeFileSync(durable, '"exact description\\n"\n');
      writeFileSync(transport, "vision.md\n");

      const check = (path: string) =>
        Bun.spawnSync({
          cmd: ["git", "check-ignore", "-q", relative(dir, path)],
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        }).exitCode;
      expect(check(durable), `${harness}: durable description`).toBe(1);
      expect(check(transport), `${harness}: transient transport`).toBe(0);
    }
  });

  test("returns one project-relative UTF-8 file with both trust notices", () => {
    const dir = project();
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "vision.md"), "# Vision\nBuild inventory.\n");
    writeRequest(dir, "./docs/vision.md");

    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.path).toBe("docs/vision.md");
    expect(payload.content).toBe("# Vision\nBuild inventory.\n");
    expect(payload.content_trust).toBe("untrusted");
    expect(payload.content_handling).toBe("data-not-instructions");
    expect(payload.path_notice).toContain("UNTRUSTED PATHS");
    expect(payload.content_notice).toContain("UNTRUSTED DATA");
  });

  test("metacharacters remain filename data and never reach shell evaluation", () => {
    const dir = project();
    const filename =
      "brief ' \" $(touch shell-expanded) `touch backtick-expanded`.md";
    writeFileSync(join(dir, filename), "# Literal filename\n");
    writeRequest(dir, filename);

    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).path).toBe(filename);
    expect(existsSync(join(dir, "shell-expanded"))).toBe(false);
    expect(existsSync(join(dir, "backtick-expanded"))).toBe(false);
  });

  test("does not search recursively for a bare filename", () => {
    const dir = project();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "vision.md"), "# Nested\n");
    writeRequest(dir, "vision.md");

    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("filenames are not searched recursively");
  });

  test("refuses out-of-project and symlinked paths", () => {
    const dir = project();
    const outside = project();
    writeFileSync(join(outside, "outside.md"), "# Outside\n");
    writeRequest(dir, join(outside, "outside.md"));
    const escaped = run(dir);
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain("inside the project root");
    expect(escaped.stderr).toContain("UNTRUSTED PATHS");

    writeFileSync(join(dir, "target.md"), "# Target\n");
    symlinkSync(join(dir, "target.md"), join(dir, "alias.md"));
    writeRequest(dir, "alias.md");
    const linked = run(dir);
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain("symlink");
  });

  test("refuses binary input with DocumentKB remediation", () => {
    const dir = project();
    writeFileSync(
      join(dir, "brief.pdf"),
      Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0, 1, 2, 3])]),
    );
    writeRequest(dir, "brief.pdf");
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not direct UTF-8 text or Markdown");
    expect(result.stderr).toContain("/aidlc knowledge onboard");
    expect(result.stderr).toContain("/aidlc knowledge show");
  });

  test("requires one non-empty path line in the fixed request file", () => {
    const dir = project();
    const missing = run(dir);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(DOCUMENT_INPUT_REQUEST_FILE);

    writeFileSync(
      documentInputRequestFilePath(dir),
      "docs/one.md\ndocs/two.md\n",
      "utf-8",
    );
    const multiple = run(dir);
    expect(multiple.status).not.toBe(0);
    expect(multiple.stderr).toContain("exactly one non-empty path line");
  });
});
