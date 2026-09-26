// covers: file:scripts/install.ps1

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_PS1 = fileURLToPath(new URL("../../scripts/install.ps1", import.meta.url));
const DIRECTORY = String.raw`C:\Users\Path Tester\aidlc\bin`;
const OTHER_ENTRIES = String.raw`C:\Windows;%AIDLC_TEST_OTHER_ROOT%\bin;D:\Other Tools`;
const VARIABLE_DIRECTORY = String.raw`%AIDLC_TEST_PATH_ROOT%\aidlc\bin`;
const ACCOUNT_SID = "S-1-5-21-100-200-300-1001";

type PathResult = { Path: string; Changed: boolean };

function runInstallerHelpers<T>(probe: string, input: object, env: Record<string, string> = {}): T {
  const result = spawnInstallerHelpers(probe, input, env);
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim());
}

function spawnInstallerHelpers(probe: string, input: object, env: Record<string, string> = {}) {
  // Load only top-level function definitions from the real installer AST.
  // Never execute its body: registry tests explicitly inject a disposable key.
  const bootstrap = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$case = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
  $env:AIDLC_TEST_INSTALLER_PATH, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$definitions = @($ast.EndBlock.Statements | Where-Object {
  $_ -is [Management.Automation.Language.FunctionDefinitionAst]
})
foreach ($definition in $definitions) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
${probe}
`;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(bootstrap, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        AIDLC_TEST_INSTALLER_PATH: INSTALL_PS1,
        AIDLC_TEST_PATH_ROOT: String.raw`C:\Users\Path Tester`,
        AIDLC_TEST_OTHER_ROOT: String.raw`D:\Unrelated Tools`,
        ...env,
      },
    },
  );
  if (result.error) throw result.error;
  return result;
}

function getPathResults(path: string | null, expandVariables?: boolean): {
  initial: PathResult;
  repeated: PathResult;
} {
  // These pure-helper cases never call Set-UserPath or open a registry key.
  return runInstallerHelpers(`
$helperOptions = @{}
if ($null -ne $case.ExpandVariables) {
  $helperOptions.ExpandVariables = $case.ExpandVariables
}
$initial = @(Get-PathWithDirectory -Path $case.Path -Directory $case.Directory @helperOptions)
if ($initial.Count -ne 1) { throw 'Expected one initial PATH result' }
$repeated = @(Get-PathWithDirectory -Path $initial[0].Path -Directory $case.Directory @helperOptions)
if ($repeated.Count -ne 1) { throw 'Expected one repeated PATH result' }
[pscustomobject]@{
  initial = $initial[0]
  repeated = $repeated[0]
} | ConvertTo-Json -Depth 4 -Compress
`, {
    Path: path,
    Directory: DIRECTORY,
    ExpandVariables: expandVariables,
  });
}

type RegistryKind = "String" | "ExpandString";
type PathReceipt = {
  schemaVersion: 1;
  scope: "user";
  accountSid: string;
  entry: string;
  previousValue: string | null;
  previousKind: RegistryKind | null;
  registeredValue: string;
};
type RegistrationState = {
  result: { Changed: boolean; Owned: boolean } | null;
  error: { type: string; message: string } | null;
  path: string | null;
  kind: RegistryKind | null;
  receipt: PathReceipt | null;
  receiptText: string | null;
  files: string[];
};

function registerUserPath(options: {
  path: string | null;
  kind?: RegistryKind;
  readOnly?: boolean;
  repeat?: boolean;
  laterPath?: string;
}): { initial: RegistrationState; repeated: RegistrationState | null } {
  return runInstallerHelpers(`
$id = [Guid]::NewGuid().ToString('N')
$keyPath = 'Software\\Aidlc-test-' + $id
$installRoot = Join-Path ([IO.Path]::GetTempPath()) ('Aidlc-test-' + $id)
$receiptPath = Join-Path $installRoot 'windows-path.json'

function Invoke-TestRegistration {
  param([bool]$ReadOnly)
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, -not $ReadOnly)
  if ($null -eq $key) { throw 'Disposable test key was not created' }
  $result = $null
  $failure = $null
  try {
    $values = @(Set-UserPath -Directory $case.Directory -InstallRoot $installRoot -AccountSid $case.AccountSid -EnvironmentKey $key)
    if ($values.Count -ne 1) { throw 'Expected one registration result' }
    $result = $values[0]
  } catch {
    $cause = $_.Exception.GetBaseException()
    $failure = [pscustomobject]@{ type = $cause.GetType().FullName; message = $cause.Message }
  } finally {
    $key.Close()
  }
  $inspectionKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $false)
  try {
    $path = $null
    $kind = $null
    if ($inspectionKey.GetValueNames() -contains 'Path') {
      $path = $inspectionKey.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = $inspectionKey.GetValueKind('Path').ToString()
    }
    $receipt = $null
    $receiptText = $null
    if ([IO.File]::Exists($receiptPath)) {
      $receiptText = [IO.File]::ReadAllText($receiptPath)
      $receipt = $receiptText | ConvertFrom-Json
    }
    return [pscustomobject]@{
      result = $result
      error = $failure
      path = $path
      kind = $kind
      receipt = $receipt
      receiptText = $receiptText
      files = @(Get-ChildItem -LiteralPath $installRoot -Force | ForEach-Object { $_.Name })
    }
  } finally {
    $inspectionKey.Close()
  }
}

try {
  [IO.Directory]::CreateDirectory($installRoot) | Out-Null
  $seed = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
  try {
    if ($null -ne $case.path) {
      $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $case.kind)
      $seed.SetValue('Path', $case.path, $kind)
    }
  } finally {
    $seed.Close()
  }
  $initial = Invoke-TestRegistration -ReadOnly ([bool]$case.readOnly)
  $repeated = $null
  if ($case.repeat) {
    if ($null -ne $case.laterPath) {
      $edited = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $true)
      try {
        $edited.SetValue('Path', $case.laterPath, $edited.GetValueKind('Path'))
      } finally {
        $edited.Close()
      }
    }
    # A rerun with the bin already present must not need a registry write.
    $repeated = Invoke-TestRegistration -ReadOnly $true
  }
  [pscustomobject]@{ initial = $initial; repeated = $repeated } |
    ConvertTo-Json -Depth 8 -Compress
} finally {
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($keyPath, $false)
  if ([IO.Directory]::Exists($installRoot)) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
  }
}
`, {
    kind: "ExpandString",
    ...options,
    Directory: DIRECTORY,
    AccountSid: ACCOUNT_SID,
  });
}

describe.skipIf(process.platform !== "win32")("Windows installer PATH helper", () => {
  const cases: Array<{
    name: string;
    path: string | null;
    expandVariables?: boolean;
    expected: PathResult;
  }> = [
    {
      name: "creates a missing user PATH",
      path: null,
      expected: { Path: DIRECTORY, Changed: true },
    },
    {
      name: "fills an empty user PATH",
      path: "",
      expected: { Path: DIRECTORY, Changed: true },
    },
    {
      name: "appends without changing unrelated entries or expandable variables",
      path: OTHER_ENTRIES,
      expected: { Path: `${OTHER_ENTRIES};${DIRECTORY}`, Changed: true },
    },
    {
      name: "preserves leading, consecutive, and trailing semicolons",
      path: `;${OTHER_ENTRIES};;`,
      expected: { Path: `;${OTHER_ENTRIES};;${DIRECTORY}`, Changed: true },
    },
    {
      name: "does not confuse a matching path prefix with the bin directory",
      path: `${DIRECTORY}-old;${DIRECTORY}\\tools`,
      expected: {
        Path: `${DIRECTORY}-old;${DIRECTORY}\\tools;${DIRECTORY}`,
        Changed: true,
      },
    },
    {
      name: "preserves literal variable text and appends the concrete bin when expansion is disabled",
      path: `${OTHER_ENTRIES};${VARIABLE_DIRECTORY}`,
      expandVariables: false,
      expected: {
        Path: `${OTHER_ENTRIES};${VARIABLE_DIRECTORY};${DIRECTORY}`,
        Changed: true,
      },
    },
    {
      name: "still de-duplicates a concrete bin entry when expansion is disabled",
      path: `${OTHER_ENTRIES};${DIRECTORY}`,
      expandVariables: false,
      expected: { Path: `${OTHER_ENTRIES};${DIRECTORY}`, Changed: false },
    },
    ...[
      { name: "exact spelling", entry: DIRECTORY },
      { name: "different casing", entry: DIRECTORY.toUpperCase() },
      { name: "a trailing backslash", entry: `${DIRECTORY}\\` },
      { name: "a trailing forward slash", entry: `${DIRECTORY}/` },
      {
        name: "an expandable variable and trailing separator",
        entry: `${VARIABLE_DIRECTORY}\\`,
      },
    ].map(({ name, entry }) => ({
      name: `preserves an existing bin entry with ${name}`,
      path: `${OTHER_ENTRIES};${entry};;`,
      expected: { Path: `${OTHER_ENTRIES};${entry};;`, Changed: false },
    })),
  ];

  for (const { name, path, expandVariables, expected } of cases) {
    test(`${name}; rerunning is idempotent`, () => {
      const result = getPathResults(path, expandVariables);
      expect(result.initial).toEqual(expected);
      expect(result.repeated).toEqual({ Path: expected.Path, Changed: false });
    }, 35_000);
  }
});

describe.skipIf(process.platform !== "win32")("Windows installer PATH ownership", () => {
  for (const { name, path, kind } of [
    { name: "missing PATH", path: null, kind: "ExpandString" },
    { name: "empty string PATH", path: "", kind: "String" },
    { name: "literal string PATH", path: OTHER_ENTRIES, kind: "String" },
    {
      name: "unexpanded matching variable in a string PATH",
      path: `${OTHER_ENTRIES};${VARIABLE_DIRECTORY}`,
      kind: "String",
    },
    { name: "expandable PATH", path: OTHER_ENTRIES, kind: "ExpandString" },
    { name: "trailing empty entries", path: `;${OTHER_ENTRIES};;`, kind: "ExpandString" },
  ] as const) {
    test(`records the original ${name} only when adding the bin directory`, () => {
      const { initial } = registerUserPath({ path, kind });
      const registeredValue = !path || path.endsWith(";")
        ? `${path ?? ""}${DIRECTORY}`
        : `${path};${DIRECTORY}`;
      expect(initial.error).toBeNull();
      expect(initial.result).toEqual({ Changed: true, Owned: true });
      expect(initial.path).toBe(registeredValue);
      expect(initial.kind).toBe(kind);
      expect(initial.receipt).toEqual({
        schemaVersion: 1,
        scope: "user",
        accountSid: ACCOUNT_SID,
        entry: DIRECTORY,
        previousValue: path,
        previousKind: path === null ? null : kind,
        registeredValue,
      });
      expect(initial.files).toEqual(["windows-path.json"]);
    }, 35_000);
  }

  for (const { name, entry, kind } of [
    { name: "literal", entry: DIRECTORY, kind: "String" },
    { name: "case-insensitive", entry: `${DIRECTORY.toUpperCase()}\\`, kind: "String" },
    { name: "expandable", entry: VARIABLE_DIRECTORY, kind: "ExpandString" },
  ] as const) {
    test(`does not claim an existing ${name} entry or write the read-only registry key`, () => {
      const path = `${OTHER_ENTRIES};${entry};;`;
      const { initial } = registerUserPath({ path, kind, readOnly: true });
      expect(initial.error).toBeNull();
      expect(initial.result).toEqual({ Changed: false, Owned: false });
      expect(initial.path).toBe(path);
      expect(initial.kind).toBe(kind);
      expect(initial.receipt).toBeNull();
      expect(initial.files).toEqual([]);
    }, 35_000);
  }

  for (const laterPath of [undefined, `D:\\Added Later;${OTHER_ENTRIES};${DIRECTORY};;`]) {
    test(`rerun preserves ownership${laterPath ? " and later PATH edits" : ""}`, () => {
      const { initial, repeated } = registerUserPath({
        path: OTHER_ENTRIES,
        repeat: true,
        laterPath,
      });
      expect(initial.error).toBeNull();
      expect(initial.result).toEqual({ Changed: true, Owned: true });
      expect(repeated?.error).toBeNull();
      expect(repeated?.result).toEqual({ Changed: false, Owned: true });
      expect(repeated?.path).toBe(laterPath ?? initial.path);
      expect(repeated?.kind).toBe(initial.kind);
      expect(repeated?.receipt).toEqual(initial.receipt);
      expect(repeated?.receiptText).toBe(initial.receiptText);
      expect(repeated?.files).toEqual(["windows-path.json"]);
    }, 35_000);
  }

  for (const path of [null, OTHER_ENTRIES]) {
    test(`registry write failure removes the new receipt and preserves ${path === null ? "missing" : "existing"} PATH`, () => {
      const { initial } = registerUserPath({ path, kind: "String", readOnly: true });
      expect(initial.result).toBeNull();
      expect(initial.error?.type).toBe("System.UnauthorizedAccessException");
      expect(initial.path).toBe(path);
      expect(initial.kind).toBe(path === null ? null : "String");
      expect(initial.receipt).toBeNull();
      expect(initial.files).toEqual([]);
    }, 35_000);
  }

  test("registry write failure on a rerun restores the earlier receipt", () => {
    const laterPath = String.raw`D:\Changed Since Install;%AIDLC_TEST_OTHER_ROOT%\bin`;
    const { initial, repeated } = registerUserPath({
      path: OTHER_ENTRIES,
      repeat: true,
      laterPath,
    });
    expect(initial.error).toBeNull();
    expect(initial.result).toEqual({ Changed: true, Owned: true });
    expect(repeated?.result).toBeNull();
    expect(repeated?.error?.type).toBe("System.UnauthorizedAccessException");
    expect(repeated?.path).toBe(laterPath);
    expect(repeated?.kind).toBe("ExpandString");
    expect(repeated?.receiptText).toBe(initial.receiptText);
    expect(repeated?.files).toEqual(["windows-path.json"]);
  }, 35_000);
});

describe.skipIf(process.platform !== "win32")("Windows installer result output", () => {
  const command = `${DIRECTORY}\\aidlc.cmd`;
  const account = String.raw`TEST-PC\Path Tester`;
  const version = "1.2.3";
  const heading = `Installed AI-DLC ${version}`;

  function render(options: {
    mode: "human" | "quiet" | "json";
    code?: number;
    status?: string;
    message?: string;
    pathStatus?: string;
    ready?: boolean;
    changed?: boolean;
    owned?: boolean | null;
  }): { lines: string[]; code: number } {
    return runInstallerHelpers(`
$Json = $case.mode -eq 'json'
$Quiet = $case.mode -eq 'quiet'
$data = @{
  installed = $true
  ready = $case.ready
  version = $case.version
  account = $case.account
  installRoot = [IO.Path]::GetDirectoryName($case.Directory)
  command = $case.command
  path = @{
    scope = 'user'
    status = $case.pathStatus
    changed = $case.changed
    owned = $case.owned
  }
  nextSteps = @("In your project, run: & '$($case.command)' config")
}
$lines = @(Write-Result -Ok ($case.code -eq 0) -Code $case.code -Status $case.status -Message $case.message -Data $data 6>&1 |
  ForEach-Object { $_.ToString() })
[pscustomobject]@{ lines = $lines; code = $global:LASTEXITCODE } |
  ConvertTo-Json -Depth 4 -Compress
`, {
      code: 0,
      status: "ok",
      message: heading,
      pathStatus: "updated",
      ready: true,
      changed: true,
      owned: true,
      ...options,
      command,
      account,
      version,
      Directory: DIRECTORY,
    });
  }

  for (const mode of ["human", "quiet"] as const) {
    test(`${mode} output preserves the installed heading without a PASS prefix`, () => {
      const message = mode === "human"
        ? `${heading}\r\nAccount: ${account}\r\nCommand: ${command}\r\nNext: In your project, run: aidlc config`
        : `${heading}; command: ${command}`;
      const result = render({ mode, message });
      expect(result.code).toBe(0);
      expect(result.lines).toEqual([message]);
      expect(result.lines[0]).toStartWith("Installed ");
    }, 35_000);
  }

  for (const scenario of [
    { pathStatus: "updated", status: "ok", code: 0, ready: true, changed: true, owned: true },
    { pathStatus: "unchanged", status: "ok", code: 0, ready: true, changed: false, owned: false },
    { pathStatus: "skipped", status: "ok", code: 0, ready: true, changed: false, owned: false },
    { pathStatus: "skipped", status: "ok", code: 0, ready: true, changed: false, owned: null },
    { pathStatus: "conflict", status: "warning", code: 0, ready: false, changed: true, owned: true },
    { pathStatus: "failed", status: "failed", code: 1, ready: false, changed: false, owned: false },
  ]) {
    test(`JSON preserves nested readiness and PATH data for ${scenario.pathStatus}${scenario.owned === null ? " with ownership unassessed" : ""}`, () => {
      const result = render({ mode: "json", ...scenario });
      expect(result.code).toBe(scenario.code);
      expect(result.lines).toHaveLength(1);
      const json = JSON.parse(result.lines[0]);
      expect(json).toEqual({
        schemaVersion: 1,
        ok: scenario.code === 0,
        code: scenario.code,
        status: scenario.status,
        message: heading,
        data: {
          installed: true,
          ready: scenario.ready,
          version,
          account,
          installRoot: String.raw`C:\Users\Path Tester\aidlc`,
          command,
          path: {
            scope: "user",
            status: scenario.pathStatus,
            changed: scenario.changed,
            owned: scenario.owned,
          },
          nextSteps: [`In your project, run: & '${command}' config`],
        },
      });
    }, 35_000);
  }
});

describe.skipIf(process.platform !== "win32")("Windows installer elevation policy", () => {
  const warning =
    'This PowerShell window is running as administrator. AI-DLC installs just for your account and doesn\'t need admin rights, and installing as administrator is less safe: another program running as you could interfere with it.';
  const stderrLines = (stderr: string) => stderr.split(/\r?\n/);

  for (const [type, name] of [[1, "a full token without UAC"], [3, "a limited UAC token"]] as const) {
    test(`installs from ${name} without a warning`, () => {
      const result = spawnInstallerHelpers(`
function Read-InstallConfirmation { throw 'no prompt expected' }
Confirm-UacElevatedInstall -ElevationType $case.type -Interactive $true
@{ allowed = $true } | ConvertTo-Json -Compress
`, { type });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ allowed: true });
      expect(result.stderr).not.toContain("running as administrator");
    }, 35_000);
  }

  test("-Yes installs from a UAC-elevated window after a warning", () => {
    const result = spawnInstallerHelpers(`
$Yes = $true
function Read-InstallConfirmation { throw 'no prompt expected' }
Confirm-UacElevatedInstall -ElevationType 2 -Interactive $true
@{ allowed = $true } | ConvertTo-Json -Compress
`, {});
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ allowed: true });
    expect(stderrLines(result.stderr)).toContain(`WARNING ${warning}`);
  }, 35_000);

  for (const [answer, proceeds] of [["y", true], ["yes", true], ["n", false], ["", false]] as const) {
    test(`an interactive UAC-elevated window is warned and asked; ${JSON.stringify(answer)} ${proceeds ? "proceeds" : "cancels"}`, () => {
      const result = spawnInstallerHelpers(`
function Read-InstallConfirmation { return $case.answer }
Confirm-UacElevatedInstall -ElevationType 2 -Interactive $true
@{ allowed = $true } | ConvertTo-Json -Compress
`, { answer });
      expect(stderrLines(result.stderr)).toContain(
        `WARNING ${warning} For the safest install, answer N and run the install command from a normal PowerShell window.`,
      );
      if (proceeds) {
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual({ allowed: true });
      } else {
        expect(result.status).toBe(1);
        expect(stderrLines(result.stderr)).toContain(
          "ERROR install cancelled; run the install command from a normal PowerShell window",
        );
      }
    }, 35_000);
  }

  test("a non-interactive UAC-elevated install without -Yes stops with guidance", () => {
    const result = spawnInstallerHelpers(`
$Json = $true
function Read-InstallConfirmation { throw 'no prompt expected' }
Confirm-UacElevatedInstall -ElevationType 2
'unreachable'
`, {});
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(2);
    expect(result.stdout).not.toContain("unreachable");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      schemaVersion: 1, ok: false, code: 2, status: "usage",
      message: `${warning} Run the install command from a normal PowerShell window, or rerun with -Yes to install as administrator anyway.`,
    });
  }, 35_000);

  test("reads the real token and broadcasts PATH without compiling through the writable temp directory", () => {
    // Add-Type would compile there, where a same-account process could
    // replace the output an elevated session then loads.
    const temp = mkdtempSync(join(tmpdir(), "aidlc-elevation-temp-"));
    try {
      const result = runInstallerHelpers<{ type: number; created: string[] }>(`
$before = @(Get-ChildItem -LiteralPath $env:TEMP -Recurse -Force | ForEach-Object FullName)
$type = Get-InstallTokenElevationType
$null = Send-EnvironmentChange
$after = @(Get-ChildItem -LiteralPath $env:TEMP -Recurse -Force | ForEach-Object FullName)
@{ type = $type; created = @($after | Where-Object { $_ -notin $before }) } | ConvertTo-Json -Compress
`, {}, { TEMP: temp, TMP: temp });
      expect([1, 2, 3]).toContain(result.type);
      expect(result.created).toEqual([]);
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 35_000);

  test("the installer never compiles code with Add-Type", () => {
    const code = readFileSync(INSTALL_PS1, "utf-8").split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(code.join("\n")).not.toContain("Add-Type");
  });

  test("reads this session's real token and applies the same policy", () => {
    const result = spawnInstallerHelpers(`
$Json = $true
[Console]::Out.WriteLine((@{ type = (Get-InstallTokenElevationType) } | ConvertTo-Json -Compress))
Confirm-UacElevatedInstall
[Console]::Out.WriteLine('{"allowed":true}')
`, {});
    const [first, second] = result.stdout.trim().split(/\r?\n/);
    const { type } = JSON.parse(first) as { type: number };
    expect([1, 2, 3]).toContain(type);
    if (type === 2) {
      // Non-interactive JSON without -Yes stops before installing.
      expect(result.status).toBe(2);
      expect(JSON.parse(second).message).toContain(warning);
    } else {
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(second)).toEqual({ allowed: true });
    }
  }, 35_000);
});
