// Deterministic Windows account/ACL tests; no CLI download or model calls.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { writeWindowsExecutable } from "../harness/windows-native-executable.ts";

const source = resolve(import.meta.dir, "../..");
const fixture = join(source, "tests/fixtures/windows-live-provisioning.ps1");
const runnerProbe = process.env.AIDLC_CODEX_RUNNER_PROBE;
const runnerProbeOnly = process.env.AIDLC_CODEX_RUNNER_PROBE_ONLY === "1";
if (runnerProbeOnly && !runnerProbe) throw new Error("Runner-only probing requires AIDLC_CODEX_RUNNER_PROBE.");

describe.skipIf(process.platform !== "win32")("Windows live provisioning boundary", () => {
  describe("native Codex launcher", () => {
    let root: string | undefined;
    let executable: string;
    let native: string;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "aidlc-native launcher &-"));
      const script = readFileSync(join(source, ".github/scripts/prepare-live-runtime.ps1"), "utf8");
      const guiMatch = script.match(/function Get-CodexHostedGuiSource \{\r?\n\s*return @'\r?\n([\s\S]*?)\r?\n'@/);
      expect(guiMatch).not.toBeNull();
      const guiSource = guiMatch![1];
      const capabilityMatch = script.match(/function Get-CodexCapabilityProbeSource \{\r?\n\s*return @'\r?\n([\s\S]*?)\r?\n'@/);
      expect(capabilityMatch).not.toBeNull();
      native = writeWindowsExecutable(join(root, "native-fixture.exe"), `using System;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
${guiSource}
${capabilityMatch![1]}
public static class NativeOutputFixture {
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct Attributes { public int Size; public IntPtr Security; public int Inherit; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct FileInfo {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref Attributes attributes);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
  private static extern bool GetUserObjectInformationW(IntPtr handle, int index, IntPtr data, uint length, out uint needed);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfo info);
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct SidAttributes { public IntPtr Sid; public uint Attributes; }
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint count, ref SidAttributes disabled,
    uint privilegeCount, IntPtr privileges, uint restrictedCount, IntPtr restrictedSids, out IntPtr restricted);
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
  private struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
  private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
    IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Attributes attributes, uint size);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool TerminateProcess(IntPtr process, uint code);
  private static string Arg(string value) {
    var quoted = new StringBuilder("\\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\\\') { slashes++; continue; }
      if (c == '"') quoted.Append('\\\\', slashes * 2 + 1).Append(c);
      else quoted.Append('\\\\', slashes).Append(c);
      slashes = 0;
    }
    return quoted.Append('\\\\', slashes * 2).Append('"').ToString();
  }
  private static long Created(IntPtr process) {
    long created, exited, kernel, user;
    Check(GetProcessTimes(process, out created, out exited, out kernel, out user), "Process creation identity unavailable.");
    return created;
  }
  private static IntPtr Retain(uint pid, long created) {
    IntPtr process = OpenProcess(0x101001, false, pid); // synchronize, query-limited, terminate
    Check(process != IntPtr.Zero, "Could not retain the live fixture process.");
    try {
      Check(Created(process) == created && WaitForSingleObject(process, 0) == 258, "Fixture process identity changed.");
      return process;
    } catch { CloseHandle(process); throw; }
  }
  private static void Retire(IntPtr process) {
    if (process == IntPtr.Zero) return;
    if (WaitForSingleObject(process, 0) == 258) Check(TerminateProcess(process, 99), "Owned fixture termination failed.");
    Check(WaitForSingleObject(process, 5000) == 0, "Owned fixture retirement unconfirmed.");
  }
  private static void AwaitFile(string path) {
    var deadline = DateTime.UtcNow.AddSeconds(10);
    while (!System.IO.File.Exists(path)) {
      if (DateTime.UtcNow >= deadline) throw new TimeoutException("Fixture handshake missing: " + path);
      System.Threading.Thread.Sleep(10);
    }
  }
  private static ProcessInfo StartInherited(string[] args) {
    string executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
    var attributes = new Attributes { Size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Attributes)), Inherit = 1 };
    IntPtr input, writer;
    Check(CreatePipe(out input, out writer, ref attributes, 0), "Fixture stdin pipe unavailable.");
    CloseHandle(writer); // inert children receive EOF
    try {
      var startup = new Startup {
        Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Startup)), Flags = 0x100,
        Desktop = Name(GetProcessWindowStation()) + "\\\\" + Name(GetThreadDesktop(GetCurrentThreadId())),
        Input = input, Output = GetStdHandle(-11), Error = GetStdHandle(-12)
      };
      foreach (IntPtr handle in new IntPtr[] { startup.Input, startup.Output, startup.Error })
        Check(SetHandleInformation(handle, 1, 1), "Fixture stdio inheritance unavailable.");
      ProcessInfo child;
      // No breakaway: the descendant must remain inside the leader's invocation job.
      Check(CreateProcessW(executable, new StringBuilder(Arg(executable) + " " + String.Join(" ", Array.ConvertAll(args, Arg))),
        IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child),
        "Could not start owned stdio fixture.");
      CloseHandle(child.Thread); child.Thread = IntPtr.Zero;
      return child;
    } finally { CloseHandle(input); }
  }
  private static int StdioLeader(string path, bool timeout) {
    ProcessInfo descendant = StartInherited(new string[] { "--held-stdio-descendant", path });
    bool handedOff = false;
    try {
      // Keep both original processes alive until the observer has validated and
      // retained their HANDLEs. Cleanup never reopens a PID after this handoff.
      System.IO.File.WriteAllText(path + ".record-writing",
        System.Diagnostics.Process.GetCurrentProcess().Id + "," + Created(GetCurrentProcess()) + "," +
        descendant.Pid + "," + Created(descendant.Process));
      System.IO.File.Move(path + ".record-writing", path + ".record");
      AwaitFile(path + ".ack"); handedOff = true;
      AwaitFile(path + ".ready"); // both large output writes have completed
      Check(WaitForSingleObject(descendant.Process, 0) == 258, "Descendant ended before its leader.");
      Console.Out.WriteLine("\\nleader-tail"); Console.Out.Flush();
      Console.Error.WriteLine("\\nleader-error-tail"); Console.Error.Flush();
      // Deliberately held until explicit HANDLE/job retirement; no natural exit.
      if (timeout) System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);
      return 7;
    } finally {
      if (!handedOff) Retire(descendant.Process);
      CloseHandle(descendant.Process);
    }
  }
  private static int StdioTree(System.Reflection.MethodInfo method, string desktop, string managed, bool timeout) {
    string path = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(managed), "stdio-tree-" + Guid.NewGuid().ToString("N"));
    ProcessInfo unrelated = StartInherited(new string[] { "--unrelated-control", path });
    IntPtr leader = IntPtr.Zero, descendant = IntPtr.Zero;
    System.Threading.Tasks.Task run = null;
    int exit = -1; Exception failure = null;
    try {
      AwaitFile(path + ".control");
      run = System.Threading.Tasks.Task.Run(() => {
        try {
          exit = (int)method.Invoke(null, new object[] {
            System.Reflection.Assembly.GetExecutingAssembly().Location,
            new string[] { "--held-stdio-leader", path, timeout ? "timeout" : "exit" },
            timeout ? 5000 : 10000, desktop, false
          });
        } catch (System.Reflection.TargetInvocationException error) { failure = error.InnerException; }
        catch (Exception error) { failure = error; }
      });
      AwaitFile(path + ".record");
      string[] identity = System.IO.File.ReadAllText(path + ".record").Split(',');
      Check(identity.Length == 4, "Incomplete fixture identity handoff.");
      leader = Retain(uint.Parse(identity[0]), long.Parse(identity[1]));
      descendant = Retain(uint.Parse(identity[2]), long.Parse(identity[3]));
      System.IO.File.WriteAllText(path + ".ack", "retained");
      Check(run.Wait(20000), "Explicit launcher did not settle.");
      uint descendantInitialWait = WaitForSingleObject(descendant, 0);
      // Job termination is asynchronous. Observe completion on the HANDLE
      // retained before leader exit, within the existing retirement backstop
      // and strictly before fixture cleanup can terminate anything.
      var retirementWatch = System.Diagnostics.Stopwatch.StartNew();
      uint descendantWait = WaitForSingleObject(descendant, 5000);
      retirementWatch.Stop();
      bool retired = descendantWait == 0;
      bool unrelatedAlive = WaitForSingleObject(unrelated.Process, 0) == 258;
      uint leaderExit = 0;
      Check(WaitForSingleObject(leader, 0) == 0 && GetExitCodeProcess(leader, out leaderExit), "Leader retirement unconfirmed.");
      Console.Out.WriteLine("{\\"tree\\":true,\\"timeout\\":" + timeout.ToString().ToLowerInvariant() +
        ",\\"leaderExit\\":" + leaderExit + ",\\"descendantRetired\\":" + retired.ToString().ToLowerInvariant() +
        ",\\"descendantInitialWait\\":" + descendantInitialWait + ",\\"descendantWait\\":" + descendantWait +
        ",\\"descendantWaitMs\\":" + retirementWatch.Elapsed.TotalMilliseconds.ToString("F3", System.Globalization.CultureInfo.InvariantCulture) +
        ",\\"unrelatedAlive\\":" + unrelatedAlive.ToString().ToLowerInvariant() + "}");
      if (failure != null && !(timeout && failure is TimeoutException))
        Console.Error.WriteLine("launcher-error: " + failure.Message);
      Check(retired, "Stdio descendant survived invocation retirement.");
      Check(unrelatedAlive, "Invocation retirement affected an unrelated process.");
      if (timeout) Check(failure is TimeoutException, "Expected the original execution timeout.");
      else {
        if (failure != null) throw failure;
        Check(exit == 7 && leaderExit == 7, "Leader exit code was not preserved.");
      }
      return timeout ? 0 : exit;
    } finally {
      Retire(descendant); Retire(leader); Retire(unrelated.Process);
      if (run != null) Check(run.Wait(10000), "Fixture launcher task did not retire.");
      if (descendant != IntPtr.Zero) CloseHandle(descendant);
      if (leader != IntPtr.Zero) CloseHandle(leader);
      CloseHandle(unrelated.Process);
      foreach (string suffix in new string[] { ".record-writing", ".record", ".ack", ".ready", ".control" })
        if (System.IO.File.Exists(path + suffix)) System.IO.File.Delete(path + suffix);
    }
  }
  private static int CapabilityFixture(string scenario) {
    string cwd = Environment.CurrentDirectory;
    string expected = scenario == "wrong-cwd" ? System.IO.Directory.GetParent(cwd).FullName : cwd;
    string token = Guid.NewGuid().ToString("N"), marker = ".aidlc-cwd-" + token;
    System.IO.File.WriteAllText(System.IO.Path.Combine(expected, marker), token);
    string secret = System.IO.Path.Combine(cwd, "fixture-secret"), outside = System.IO.Path.Combine(cwd, "fixture-protected");
    System.IO.File.WriteAllText(secret, "private fixture"); System.IO.File.WriteAllText(outside, "protected fixture");
    var secretAcl = System.IO.File.GetAccessControl(secret);
    var outsideAcl = System.IO.File.GetAccessControl(outside);
    IntPtr original = IntPtr.Zero, restricted = IntPtr.Zero;
    var admin = new SecurityIdentifier("S-1-5-32-544");
    byte[] bytes = new byte[admin.BinaryLength]; admin.GetBinaryForm(bytes, 0);
    var pin = System.Runtime.InteropServices.GCHandle.Alloc(bytes, System.Runtime.InteropServices.GCHandleType.Pinned);
    try {
      var sid = WindowsIdentity.GetCurrent().User;
      if (scenario != "readable-secret") {
        var acl = System.IO.File.GetAccessControl(secret);
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.ReadData, AccessControlType.Deny));
        System.IO.File.SetAccessControl(secret, acl);
      }
      if (scenario != "writable-outside") {
        var acl = System.IO.File.GetAccessControl(outside);
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.WriteData, AccessControlType.Deny));
        System.IO.File.SetAccessControl(outside, acl);
      }
      if (scenario == "missing-secret") System.IO.File.Delete(secret);
      Check(OpenProcessToken(GetCurrentProcess(), 0xE, out original), "Open own fixture token failed.");
      var disabled = new SidAttributes { Sid = pin.AddrOfPinnedObject() };
      Check(CreateRestrictedToken(original, 1, 1, ref disabled, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted),
        "Restrict own fixture token failed.");
      // Current account only. Disable privileges and administrator membership
      // for this synchronous call; no logon, account, profile or process creation.
      using (WindowsIdentity.Impersonate(restricted)) {
        return AidlcCodexCapabilityProbe.Run(new string[] {
          sid.Value, secret, outside, "space \\"quoted\\" & symbols \\\\tail\\\\", expected, marker, token
        });
      }
    } finally {
      if (System.IO.File.Exists(secret)) System.IO.File.SetAccessControl(secret, secretAcl);
      System.IO.File.SetAccessControl(outside, outsideAcl);
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (original != IntPtr.Zero) CloseHandle(original);
      pin.Free();
    }
  }
  private static string Name(IntPtr handle) {
    uint size;
    GetUserObjectInformationW(handle, 2, IntPtr.Zero, 0, out size);
    IntPtr data = System.Runtime.InteropServices.Marshal.AllocHGlobal((int)size);
    try {
      Check(GetUserObjectInformationW(handle, 2, data, size, out size), "Read GUI name failed.");
      return System.Runtime.InteropServices.Marshal.PtrToStringUni(data);
    } finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(data); }
  }
  private static int ExplicitDesktop(string[] args) {
    string station = Name(GetProcessWindowStation());
    string desktopName = "AidlcExplicitTest-" + Guid.NewGuid().ToString("N");
    var security = new RawSecurityDescriptor("D:P(A;;0x20087;;;" + WindowsIdentity.GetCurrent().User.Value + ")");
    byte[] bytes = new byte[security.BinaryLength]; security.GetBinaryForm(bytes, 0);
    var pin = System.Runtime.InteropServices.GCHandle.Alloc(bytes, System.Runtime.InteropServices.GCHandleType.Pinned);
    IntPtr desktop = IntPtr.Zero;
    string extraPath = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(args[1]), Guid.NewGuid().ToString("N") + ".handle");
    try {
      var attributes = new Attributes { Size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Attributes)), Security = pin.AddrOfPinnedObject() };
      // Own new desktop only: no station ACL write, thread switch or Default access.
      desktop = CreateDesktopW(desktopName, IntPtr.Zero, IntPtr.Zero, 0, 0x20087, ref attributes);
      Check(desktop != IntPtr.Zero, "Create owned test desktop failed.");
      using (var extra = new System.IO.FileStream(extraPath, System.IO.FileMode.CreateNew, System.IO.FileAccess.ReadWrite)) {
        IntPtr handle = extra.SafeFileHandle.DangerousGetHandle();
        Check(SetHandleInformation(handle, 1, 1), "Set unrelated inheritable handle failed.");
        FileInfo identity;
        Check(GetFileInformationByHandle(handle, out identity), "Read unrelated handle identity failed.");
        bool timeout = args[0] == "--explicit-timeout";
        var childArgs = new System.Collections.Generic.List<string> {
          timeout ? "--desktop-timeout-child" : "--desktop-child", station, desktopName, handle.ToInt64().ToString(),
          identity.Volume.ToString(), identity.IndexHigh.ToString(), identity.IndexLow.ToString()
        };
        childArgs.AddRange(new ArraySegment<string>(args, 2, args.Length - 2));
        var assembly = System.Reflection.Assembly.LoadFile(args[1]);
        var method = assembly.GetType("AidlcCodexLauncher").GetMethod("RunExplicit",
          System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        try {
          if (args[0] == "--explicit-stdio-tree" || args[0] == "--explicit-stdio-tree-timeout")
            return StdioTree(method, station + "\\\\" + desktopName, args[1], args[0].EndsWith("-timeout"));
          if (args[0] == "--explicit-powershell-cwd") {
            return (int)method.Invoke(null, new object[] {
              args[3], new string[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-File", args[2] },
              10000, station + "\\\\" + desktopName, false
            });
          }
          return (int)method.Invoke(null, new object[] {
            System.Reflection.Assembly.GetExecutingAssembly().Location, childArgs.ToArray(), timeout ? 1000 : 10000, station + "\\\\" + desktopName, true
          });
        } catch (System.Reflection.TargetInvocationException error) {
          if (!timeout || !(error.InnerException is TimeoutException)) throw;
          Console.Out.WriteLine("timeout-retired"); return 0;
        }
      }
    } finally {
      if (desktop != IntPtr.Zero) Check(CloseDesktop(desktop), "Owned test desktop remained in use.");
      pin.Free();
      if (System.IO.File.Exists(extraPath)) System.IO.File.Delete(extraPath);
    }
  }
  private const string Controller = "S-1-5-21-111-222-333-1001";
  private static readonly string[] Children = { "S-1-5-21-111-222-333-1002", "S-1-5-21-111-222-333-1003" };
  private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
  private static string Bytes(GenericSecurityDescriptor value) {
    byte[] bytes = new byte[value.BinaryLength]; value.GetBinaryForm(bytes, 0);
    return Convert.ToBase64String(bytes);
  }
  private static void VerifyAcls() {
    var original = new RawSecurityDescriptor("O:SYG:BAD:P(D;;0x4;;;S-1-5-21-111-222-333-1999)(A;;GA;;;SY)(A;OICIIO;GR;;;BA)");
    string originalBytes = Bytes(original);
    var prepared = AidlcCodexHostedGui.EditOwnedEntries(original, Controller, Children, false);
    Check(Bytes(original) == originalBytes, "Preparation changed its input descriptor.");
    Check(prepared.Owner.Equals(original.Owner) && prepared.Group.Equals(original.Group) &&
      prepared.ControlFlags == original.ControlFlags, "Descriptor owner/group/control changed.");
    Check(prepared.DiscretionaryAcl.Count == original.DiscretionaryAcl.Count + 3, "Wrong grant count.");
    for (int i = 0; i < 3; i++) {
      var ace = (CommonAce)prepared.DiscretionaryAcl[original.DiscretionaryAcl.Count + i];
      Check(ace.SecurityIdentifier.Value == (i == 0 ? Controller : Children[i - 1]) &&
        ace.AccessMask == (i == 0 ? 0x2006b : 0x20063) && ace.AceFlags == AceFlags.None &&
        ace.AceQualifier == AceQualifier.AccessAllowed, "Wrong explicit runtime grant.");
    }
    // An unrelated entry can arrive between prepare and collect. Preserve it.
    var other = new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x20002,
      new SecurityIdentifier("S-1-5-21-111-222-333-1998"), false, null);
    prepared.DiscretionaryAcl.InsertAce(prepared.DiscretionaryAcl.Count, other);
    original.DiscretionaryAcl.InsertAce(original.DiscretionaryAcl.Count, other);
    var removed = AidlcCodexHostedGui.EditOwnedEntries(prepared, Controller, Children, true);
    Check(Bytes(removed) == Bytes(original), "Cleanup lost an unrelated ACL entry.");
    Check(Bytes(AidlcCodexHostedGui.EditOwnedEntries(removed, Controller, Children, true)) == Bytes(removed),
      "Repeated cleanup was not idempotent.");
    bool refused = false;
    string before = Bytes(prepared);
    try { AidlcCodexHostedGui.EditOwnedEntries(prepared, Controller, Children, false); }
    catch (InvalidOperationException) { refused = true; }
    Check(refused && Bytes(prepared) == before, "Existing runtime entries were accepted or modified.");
    // A changed grant for one of our SIDs cannot authorize deleting other ACEs.
    ((CommonAce)prepared.DiscretionaryAcl[3]).AccessMask |= 0x40000;
    before = Bytes(prepared); refused = false;
    try { AidlcCodexHostedGui.EditOwnedEntries(prepared, Controller, Children, true); }
    catch (InvalidOperationException) { refused = true; }
    Check(refused && Bytes(prepared) == before, "Ambiguous cleanup changed its input.");
    Console.Out.WriteLine("owned-station-acls-verified");
  }
  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    // These controls remain alive until the observer retires their HANDLEs.
    // The outer test runner's owned job is the final backstop if the fixture aborts.
    if (args.Length == 2 && args[0] == "--unrelated-control") {
      System.IO.File.WriteAllText(args[1] + ".control", "ready");
      System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); return 0;
    }
    if (args.Length == 2 && args[0] == "--held-stdio-descendant") {
      Console.Out.Write(new string('D', 131072)); Console.Out.Flush();
      Console.Error.Write(new string('F', 131072)); Console.Error.Flush();
      System.IO.File.WriteAllText(args[1] + ".ready", "all output queued");
      System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); return 0;
    }
    if (args.Length == 3 && args[0] == "--held-stdio-leader") return StdioLeader(args[1], args[2] == "timeout");
    if (args.Length == 2 && args[0] == "--capability-fixture") return CapabilityFixture(args[1]);
    if (args.Length >= 2 && (args[0] == "--explicit-desktop" || args[0] == "--explicit-timeout" || args[0] == "--explicit-powershell-cwd" ||
      args[0] == "--explicit-stdio-tree" || args[0] == "--explicit-stdio-tree-timeout")) return ExplicitDesktop(args);
    if (args.Length >= 7 && (args[0] == "--desktop-child" || args[0] == "--desktop-timeout-child")) {
      Check(Name(GetProcessWindowStation()) == args[1] &&
        Name(GetThreadDesktop(GetCurrentThreadId())) == args[2], "Explicit desktop was not used.");
      FileInfo extra;
      bool inherited = GetFileInformationByHandle(new IntPtr(long.Parse(args[3])), out extra) &&
        extra.Volume == uint.Parse(args[4]) && extra.IndexHigh == uint.Parse(args[5]) && extra.IndexLow == uint.Parse(args[6]);
      Check(!inherited, "An unrelated handle crossed the three-handle list.");
      if (args[0] == "--desktop-timeout-child") {
        Console.Out.WriteLine("child-started"); Console.Out.Flush();
        System.Threading.Thread.Sleep(30000);
        throw new Exception("Timed-out child survived.");
      }
      byte[] stdin;
      using (var buffer = new System.IO.MemoryStream()) {
        Console.OpenStandardInput().CopyTo(buffer); stdin = buffer.ToArray();
      }
      Console.Out.Write(new string('O', 131072));
      Console.Error.Write(new string('E', 131072));
      Console.Out.WriteLine("\\nargv:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\\0", new ArraySegment<string>(args, 7, args.Length - 7)))));
      Console.Out.WriteLine("stdin:" + Convert.ToBase64String(stdin));
      Console.Out.WriteLine("cwd:" + Environment.CurrentDirectory);
      Console.Out.WriteLine("env:" + Environment.GetEnvironmentVariable("AIDLC_EXPLICIT_DESKTOP_LITERAL"));
      Console.Out.WriteLine("station:" + args[1]);
      return 7;
    }
    if (args.Length == 1 && args[0] == "--verify-owned-station-acls") {
      VerifyAcls(); return 0;
    }
    if (args.Length == 1 && args[0] == "--reject-foreign-controller") {
      AidlcCodexHostedGui.ValidateStationWorker("S-1-5-18", 0);
      int refusedWorkers = 0;
      foreach (string sid in new string[] { Controller, "S-1-5-18" }) {
        try { AidlcCodexHostedGui.ValidateStationWorker(sid, sid == Controller ? 0 : 1); }
        catch (InvalidOperationException) { refusedWorkers++; }
      }
      Check(refusedWorkers == 2, "Station worker accepted a non-SYSTEM identity or session 1.");
      try { AidlcCodexHostedGui.RunOnPrivateDesktop("S-1-5-18", Controller, Children,
        (_desktop) => { throw new Exception("Native callback must not run."); }); }
      catch (InvalidOperationException error) {
        Check(error.Message == "Codex GUI launcher requires its prepared low controller." ||
          error.Message == "Codex hosted GUI requires session 0.", "Unexpected refusal.");
        Console.Out.WriteLine("foreign-controller-refused"); return 0;
      }
      throw new Exception("Foreign controller was accepted.");
    }
    Console.Out.WriteLine("stdout-marker:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\\0", args))));
    Console.Error.WriteLine("stderr-marker");
    return 7;
  }
}`);
      const initializer = join(root, "initialize.ps1");
      writeFileSync(initializer, `
if ($env:AIDLC_FIXTURE_INITIALIZER_DELAY_MS) {
    [Threading.Thread]::Sleep([int]$env:AIDLC_FIXTURE_INITIALIZER_DELAY_MS)
}
if ($env:AIDLC_FIXTURE_INITIALIZER_EXIT_CODE) {
    exit ([int]$env:AIDLC_FIXTURE_INITIALIZER_EXIT_CODE)
}
exit 0
`);
      // Compile the actual authored bridge with inert child commands. This
      // exercises its native process boundary without creating sandbox users.
      const match = script.match(/\$launcher = @'\r?\n([\s\S]*?)\r?\n'@/);
      expect(match).not.toBeNull();
      let launcher = match![1];
      const processMatch = script.match(/function Get-CodexDesktopProcessSource \{\r?\n\s*return @'\r?\n([\s\S]*?)\r?\n'@/);
      expect(processMatch).not.toBeNull();
      launcher = launcher.replaceAll("__DESKTOP_PROCESS_SOURCE__", processMatch![1])
        .replaceAll("__HOSTED_GUI_SOURCE__", guiSource)
        .replaceAll("__HOSTED_GUI__", "false")
        .replaceAll("__STATION_OWNER__", JSON.stringify("S-1-5-18"))
        .replaceAll("__CONTROLLER_SID__", JSON.stringify("S-1-5-21-111-222-333-1001"))
        .replaceAll("__SANDBOX_SIDS__", 'new string[] { "S-1-5-21-111-222-333-1002", "S-1-5-21-111-222-333-1003" }');
      for (const [marker, value] of [
        ["__NATIVE__", native], ["__PACKAGE_ROOT__", root], ["__INITIALIZER__", initializer],
        ["__GUI_PROBE__", native],
        ["__POWERSHELL__", join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")],
      ]) launcher = launcher.replaceAll(marker, JSON.stringify(value));
      executable = writeWindowsExecutable(join(root, "managed.exe"), launcher);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    // Both invocations use the same immutable executables. Compile once, while
    // keeping each process boundary and its literal-argv assertions independent.
    test.each([
      ["version", ["--version"]],
      ["initialized", ["sandbox", "two words", 'a"quote', "\\tail\\", "& () %PATH%"]],
    ] as const)("preserves child output and arguments: %s", (_name, args) => {
      const result = spawnSync(executable, args, {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(7);
      expect(result.stdout.trim()).toBe(`stdout-marker:${Buffer.from(args.join("\0")).toString("base64")}`);
      expect(result.stderr.trim()).toBe("stderr-marker");
    }, 20_000);
    test("allows a successful initializer to finish beyond the former 30-second deadline", () => {
      const result = spawnSync(executable, ["sandbox"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 85_000,
        env: { ...process.env, AIDLC_FIXTURE_INITIALIZER_DELAY_MS: "31000" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(7);
      expect(result.stdout.trim()).toBe(`stdout-marker:${Buffer.from("sandbox").toString("base64")}`);
      expect(result.stderr.trim()).toBe("stderr-marker");
    }, 90_000);
    test("refuses native execution after initializer failure", () => {
      const result = spawnSync(executable, ["sandbox"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 85_000,
        env: { ...process.env, AIDLC_FIXTURE_INITIALIZER_EXIT_CODE: "9" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(9);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }, 90_000);
    test("initializer phase markers diagnose a refused directory without stdout or secret contents", () => {
      const sourceText = readFileSync(join(source, ".github/scripts/prepare-live-runtime.ps1"), "utf8");
      const body = sourceText.match(/function Get-CodexHomeInitializer \{[\s\S]*?\$body = @'\r?\n([\s\S]*?)\r?\n'@/);
      expect(body).not.toBeNull();
      const script = join(root!, "initializer-phases.ps1");
      writeFileSync(script, body![1]
        .replaceAll("__SID__", "([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)")
        .replaceAll("__SEED__", "'UNREAD_PRIVATE_SEED'"));
      const shell = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
      const privateParent = join(root!, "different-private-parent");
      mkdirSync(privateParent);
      for (const enabled of ["1", "0"]) {
        const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: NATIVE_FIXTURE_SETUP_TIMEOUT_MS - 5000,
          env: { ...process.env, CODEX_HOME: root!, TEMP: privateParent, TMP: privateParent,
            AIDLC_CODEX_INITIALIZER_DIAGNOSTICS: enabled },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Codex home is outside this test temporary root.");
        const rows = result.stderr.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        expect(rows.map(row => row.phase)).toEqual(enabled === "1"
          ? ["start", "add-type-start", "add-type-complete", "directory-validation"] : []);
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual(["elapsedMs", "entry", "phase", "pid", "probe"]);
          expect(row.probe).toBe("codex-home-initializer");
          expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
          expect(row.entry).toBe(-1);
        }
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);
    test("preserves unrelated station ACL entries and refuses ambiguous cleanup", () => {
      const result = spawnSync(native, ["--verify-owned-station-acls"], { encoding: "utf8", timeout: 15_000 });
      expect(result.status, `${result.error ?? ""}\n${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("owned-station-acls-verified");
    }, 20_000);
    test("refuses a foreign hosted controller before opening WinSta0", () => {
      const result = spawnSync(native, ["--reject-foreign-controller"], { encoding: "utf8", timeout: 15_000 });
      expect(result.status, `${result.error ?? ""}\n${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("foreign-controller-refused");
    }, 20_000);
    test("explicit private desktop preserves stdio argv cwd environment and handle boundaries", () => {
      const args = ["two words", 'a"quote', "", "\\tail\\", "& () %PATH%", "日本"];
      const input = "stdin Ω\n";
      const result = spawnSync(native, ["--explicit-desktop", executable, ...args], {
        encoding: "utf8", input, cwd: root, timeout: 15_000,
        env: { ...process.env, AIDLC_EXPLICIT_DESKTOP_LITERAL: "snowman ☃ 日本" },
      });
      expect(result.status, `${result.error ?? ""}\n${result.stderr.slice(-2000)}`).toBe(7);
      expect(result.stdout.startsWith("O".repeat(131072))).toBe(true);
      expect(result.stderr).toBe("E".repeat(131072));
      expect(result.stdout).toContain(`argv:${Buffer.from(args.join("\0")).toString("base64")}`);
      expect(result.stdout).toContain(`stdin:${Buffer.from(input).toString("base64")}`);
      expect(result.stdout).toContain(`cwd:${root}`);
      expect(result.stdout).toContain("env:snowman ☃ 日本");
      console.log(result.stdout.slice(result.stdout.lastIndexOf("station:")).trim());
    }, 20_000);
    test("explicit desktop timeout retires the child and a blocked stdin pump", async () => {
      const child = spawn(native, ["--explicit-timeout", executable], {
        cwd: root, stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), 15_000);
      try {
        // Intentionally keep stdin open with no bytes. Native cancellation must
        // unblock its own input reader after terminating the original HANDLE.
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(code, stderr).toBe(0);
        expect(stdout).toContain("child-started");
        expect(stdout).toContain("timeout-retired");
      } finally {
        clearTimeout(timer);
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    }, 20_000);
    for (const timeout of [false, true]) {
      test(timeout
        ? "explicit desktop timeout retires stdio descendants and preserves unrelated processes"
        : "explicit desktop leader exit drains queued output after retiring stdio descendants", () => {
        const result = spawnSync(native, [timeout ? "--explicit-stdio-tree-timeout" : "--explicit-stdio-tree", executable], {
          cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 40_000,
        });
        const output = result.stdout.replaceAll("\r\n", "\n");
        const errors = result.stderr.replaceAll("\r\n", "\n");
        const summaryOffset = output.lastIndexOf('{"tree":');
        const diagnostic = `${result.error ?? ""}\n${output.slice(-2000)}\n${errors.slice(-2000)}`;
        expect(result.error, diagnostic).toBeUndefined();
        expect(result.status, diagnostic).toBe(timeout ? 0 : 7);
        expect(summaryOffset, diagnostic).toBeGreaterThan(0);
        expect(output.slice(0, summaryOffset)).toBe(`${"D".repeat(131072)}\nleader-tail\n`);
        expect(errors).toBe(`${"F".repeat(131072)}\nleader-error-tail\n`);
        expect(JSON.parse(output.slice(summaryOffset))).toMatchObject({
          tree: true, timeout, descendantRetired: true, descendantWait: 0, unrelatedAlive: true,
          ...(!timeout ? { leaderExit: 7 } : {}),
        });
        console.log(output.slice(summaryOffset).trim());
      }, 45_000);
    }
    test("PowerShell provider location and OS cwd survive explicit desktop launch", () => {
      const report = join(root!, "cwd-report.ps1");
      const cwdCheck = `$providerCwd = (Get-Location).Path
$osCwd = [Environment]::CurrentDirectory
[ordered]@{expectedProject=$ExpectedProject; providerCwd=$providerCwd; osCwd=$osCwd; scriptRoot=$PSScriptRoot} | ConvertTo-Json -Compress
foreach ($directory in @($ExpectedProject, $osCwd, $providerCwd)) {
  if (-not [IO.File]::Exists((Join-Path $directory $CwdMarker)) -or [IO.File]::ReadAllText((Join-Path $directory $CwdMarker)) -cne $CwdToken) { throw 'Native sandbox cwd does not identify the expected project' }
}
`;
      const token = "a".repeat(32);
      writeFileSync(join(root!, `.aidlc-cwd-${token}`), token);
      const setup = `$ErrorActionPreference='Stop'\n$ExpectedProject=$PSScriptRoot\n$CwdToken='${token}'\n$CwdMarker='.aidlc-cwd-${token}'\n`;
      writeFileSync(report, setup + cwdCheck);
      const shell = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
      const result = spawnSync(native, ["--explicit-powershell-cwd", executable, report, shell], {
        cwd: root, encoding: "utf8", timeout: 15_000,
      });
      console.log(`Explicit PowerShell cwd: ${result.stdout.trim()}`);
      expect(result.status, `${result.error ?? ""}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ expectedProject: root, providerCwd: root, osCwd: root, scriptRoot: root });
      // A provider-only location change must be diagnosed and refused even
      // while the process's OS cwd still identifies the expected project.
      writeFileSync(report, `${setup}Set-Location -LiteralPath ([IO.Path]::GetPathRoot($PSScriptRoot))\n${cwdCheck}`);
      const wrong = spawnSync(native, ["--explicit-powershell-cwd", executable, report, shell], {
        cwd: root, encoding: "utf8", timeout: 15_000,
      });
      expect(wrong.status, `${wrong.error ?? ""}\n${wrong.stderr}`).toBe(1);
      expect(JSON.parse(wrong.stdout)).toMatchObject({ expectedProject: root, providerCwd: parse(root!).root, osCwd: root });
      expect(wrong.stderr).toContain("Native sandbox cwd does not identify the expected project");
    }, 20_000);
    for (const [scenario, message] of [
      ["allowed", "Codex native identity, workspace write, secret denial and protected-tool denial verified."],
      ["wrong-cwd", "Native sandbox cwd does not identify the expected project"],
      ["missing-secret", "System.IO.FileNotFoundException"],
      ["readable-secret", "Native sandbox can read its credential store"],
      ["writable-outside", "Native sandbox can write outside its workspace"],
    ] as const) {
      test(`native sandbox capability probe enforces ${scenario}`, () => {
        const project = join(root!, `capability-${scenario}`);
        mkdirSync(project);
        const result = spawnSync(native, ["--capability-fixture", scenario], {
          cwd: project, encoding: "utf8", timeout: 15_000,
        });
        const diagnostics = `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`;
        expect(result.error, diagnostics).toBeUndefined();
        expect(result.status, diagnostics).toBe(scenario === "allowed" ? 0 : 1);
        expect(scenario === "allowed" ? result.stdout : result.stderr).toContain(message);
        if (scenario === "allowed") {
          expect(JSON.parse(result.stdout.trim().split(/\r?\n/)[0]!)).toMatchObject({
            probe: "codex-native-capability-cwd", expectedProject: project, osCwd: project,
          });
          expect(readFileSync(join(project, "workspace-write.txt"), "utf8")).toBe("workspace-write verified");
          expect(readFileSync(join(project, "fixture-protected"), "utf8")).toBe("protected fixture");
        } else if (scenario === "wrong-cwd") {
          expect(existsSync(join(project, "workspace-write.txt"))).toBe(false);
        }
      }, 20_000);
    }

  });

  for (const [name, expected] of [
    ["seal", { singleLinkTools: true, lowUserWriteDenied: true }],
    ["deny", { protectedReadDenied: true, reparseRejected: true }],
    ["failure-collect", { collectedAfterUserRemoval: true, summaryArtifacts: 1 }],
    ["poisoned-collect", { collectedAfterUserRemoval: true, linkedEvidenceRejected: true }],
    ["runner-bootstrap", {}],
  ] as const) {
    // CI supplies the hash-checked runner and executes all boundary cases.
    // Local diagnostics may explicitly select only the bootstrap case.
    test.skipIf(name === "runner-bootstrap" ? !runnerProbe : runnerProbeOnly)(
      `${name} uses real low-user execution and filesystem boundaries`, () => {
      // A second Windows account cannot resolve Node scripts through the
      // administrator's private AppData ancestors. Mirror production's C: root.
      const volume = parse(process.env.SystemRoot ?? "C:\\Windows").root;
      const root = mkdtempSync(join(volume, "aidlc-win-provision-"));
      const fixtureId = randomUUID();
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture,
        "-SourceRoot", source, "-FixtureRoot", root, "-BunPath", process.execPath, "-Case", name];
      if (name === "runner-bootstrap") args.push("-RunnerPath", runnerProbe!);
      const failures: unknown[] = [];
      try {
        const result = spawnSync(
          powershell, [...args, "-FixtureId", fixtureId],
          { encoding: "utf8", timeout: 180_000, windowsHide: true },
        );
        expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
        const record = JSON.parse(readFileSync(join(root, "result.json"), "utf8").replace(/^\uFEFF/, ""));
        expect(record).toMatchObject({ case: name, ...expected });
        if (name === "runner-bootstrap") {
          // Preserve native exit/GUI evidence even when the handshake fails.
          // An early runner exit or a timeout must never be reported as a pass.
          console.log(`Native runner bootstrap: ${JSON.stringify(record.probe)}`);
          expect(record.probe, JSON.stringify(record.probe)).toMatchObject({
            pipeInConnected: true, pipeOutConnected: true, retired: true, timedOut: false,
            before: { naturalExitCode: "0xC0000142", pipeInConnected: false, pipeOutConnected: false, retired: true },
            refusedInputs: 5, idempotent: true,
          });
        }
        expect(existsSync(join(root, "trusted-teardown/identity.json"))).toBe(true);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          if (existsSync(join(root, "trusted-teardown/identity.json"))) {
            // Task Scheduler/CIM clients have exited before profile deletion.
            // Keep cleanup separate even when a boundary assertion failed.
            if (name === "seal") {
              try {
                const rejected = spawnSync(powershell, [...args, "-Mode", "cleanup", "-FixtureId", randomUUID()],
                  { encoding: "utf8", timeout: 10_000, windowsHide: true });
                expect(rejected.status).toBe(1);
                expect(rejected.stderr).toContain("Fixture receipt binding mismatch.");
              } catch (error) {
                failures.push(error);
              }
            }
            const cleanup = spawnSync(powershell, [...args, "-Mode", "cleanup", "-FixtureId", fixtureId],
              { encoding: "utf8", timeout: 35_000, windowsHide: true });
            expect(cleanup.status, `Profile cleanup:\n${cleanup.error ?? ""}\n${cleanup.stdout}\n${cleanup.stderr}`).toBe(0);
            const receipt = JSON.parse(readFileSync(join(root, "trusted-teardown/cleanup.json"), "utf8").replace(/^\uFEFF/, ""));
            expect(receipt.fixtureId).toBe(fixtureId);
            if (receipt.removed !== true) {
              expect(process.env.GITHUB_ACTIONS).toBe("true");
              expect(process.env.RUNNER_ENVIRONMENT).toBe("github-hosted");
              expect(receipt).toMatchObject({
                removed: false, deferredToHostDisposal: true, reason: "profile-service-sharing-lock",
              });
            }
            if (receipt.runnerProfile && receipt.runnerProfile.removed !== true) {
              expect(process.env.GITHUB_ACTIONS).toBe("true");
              expect(process.env.RUNNER_ENVIRONMENT).toBe("github-hosted");
              expect(receipt.runnerProfile).toMatchObject({
                removed: false, deferredToHostDisposal: true, reason: "profile-service-sharing-lock",
              });
            }
            console.log(`Fixture profile cleanup: ${JSON.stringify({ case: name, ...receipt })}`);
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.stack : String(error)).join("\n"));
      }
    // Preserve the 180s body and 30s deletion bounds, plus cleanup client startup
    // and the 10s receipt-binding refusal check after the body process exits.
    }, 230_000);
  }
});
