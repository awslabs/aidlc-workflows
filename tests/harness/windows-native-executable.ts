import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_COMPILE_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

// Use the small .NET console executable pattern from t150/t255. A .cmd file
// cannot stand in for a native executable passed to node:child_process on Windows.
export function writeWindowsExecutable(executable: string, source: string): string {
  const sourcePath = `${executable}.cs`;
  writeFileSync(sourcePath, source, "utf-8");
  const compiler = join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe",
  );
  const compiled = spawnSync(
    compiler,
    ["/nologo", "/optimize+", "/target:exe", `/out:${executable}`, sourcePath],
    { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS, { phase: "native executable compile" }) },
  );
  if (compiled.error || compiled.status !== 0) {
    throw new Error(`Native fixture compile failed (${executable}): ${compiled.error?.message || compiled.stderr || compiled.stdout}`);
  }
  return executable;
}

export function writeWindowsBunLauncher(executable: string, script: string): string {
  return writeWindowsExecutable(executable, String.raw`using System;
using System.Diagnostics;
using System.Text;
using System.Threading;

internal static class BunFixtureLauncher {
  // ProcessStartInfo.Arguments uses Windows argv quoting, not shell syntax.
  // Double backslashes before quotes and before the closing quote; preserve
  // empty arguments and ordinary backslashes verbatim.
  private static string Quote(string value) {
    var quoted = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') {
        slashes++;
        continue;
      }
      if (character == '"') {
        quoted.Append('\\', slashes * 2 + 1).Append('"');
      } else {
        quoted.Append('\\', slashes).Append(character);
      }
      slashes = 0;
    }
    return quoted.Append('\\', slashes * 2).Append('"').ToString();
  }

  public static int Main(string[] args) {
    var arguments = new StringBuilder(Quote(${JSON.stringify(script)}));
    foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));
    try {
      using (var child = new Process()) {
        child.StartInfo = new ProcessStartInfo(${JSON.stringify(process.execPath)}, arguments.ToString()) {
          UseShellExecute = false,
          CreateNoWindow = true,
          RedirectStandardOutput = true,
          RedirectStandardError = true
        };
        // cwd, environment and stdin are inherited. Drain both output pipes
        // concurrently, matching t255's native launcher, then relay the exit code.
        child.Start();
        var stdout = new Thread(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
        var stderr = new Thread(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
        stdout.Start();
        stderr.Start();
        child.WaitForExit();
        stdout.Join();
        stderr.Join();
        return child.ExitCode;
      }
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return 1;
    }
  }
}
`);
}
