// Credential-free diagnostic fixture for Codex 0.151.0 runner_client.rs.
// Never changes window-station/desktop permissions or uses existing accounts.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class AidlcRunnerBootstrapProbe {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Overlapped {
        public IntPtr Internal, InternalHigh;
        public uint Offset, OffsetHigh;
        public IntPtr Event;
    }
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, IntPtr data, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetUserObjectSecurity(IntPtr handle, ref uint sections, byte[] data, uint length, out uint needed);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessWithLogonW(string user, string domain, string password, uint logonFlags,
        string application, StringBuilder command, uint flags, IntPtr environment, string cwd,
        ref StartupInfo startup, out ProcessInformation process);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment,
        string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disabledCount, IntPtr disabled,
        uint privilegeCount, IntPtr privileges, uint sidCount, ref SidAndAttributes sid, out IntPtr token);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateNamedPipeW(string name, uint access, uint mode, uint instances,
        uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ConnectNamedPipe(SafeFileHandle pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetOverlappedResult(SafeFileHandle pipe, IntPtr overlapped, out uint transferred, bool wait);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CancelIoEx(SafeFileHandle pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafeFileHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint status);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint status);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern uint SetErrorMode(uint mode);

    private static Dictionary<string, object> GuiObject(IntPtr handle) {
        var result = new Dictionary<string, object>();
        uint needed;
        GetUserObjectInformationW(handle, 2, IntPtr.Zero, 0, out needed);
        IntPtr buffer = Marshal.AllocHGlobal((int)Math.Max(needed, 12u));
        try {
            if (!GetUserObjectInformationW(handle, 2, buffer, needed, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            result["name"] = Marshal.PtrToStringUni(buffer);
            if (!GetUserObjectInformationW(handle, 1, buffer, 12, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            result["flags"] = Marshal.ReadInt32(buffer, 8);
        } finally { Marshal.FreeHGlobal(buffer); }
        uint sections = 7; // owner, group, DACL; never request/change the SACL.
        GetUserObjectSecurity(handle, ref sections, null, 0, out needed);
        byte[] descriptor = new byte[needed];
        if (GetUserObjectSecurity(handle, ref sections, descriptor, needed, out needed)) {
            var security = new RawSecurityDescriptor(descriptor, 0);
            result["ownerSid"] = security.Owner.Value;
            result["sddl"] = security.GetSddlForm(AccessControlSections.Owner |
                AccessControlSections.Group | AccessControlSections.Access);
        } else {
            result["securityQueryError"] = Marshal.GetLastWin32Error();
        }
        return result;
    }

    private sealed class Pipe : IDisposable {
        public readonly string Name;
        private SafeFileHandle handle;
        private IntPtr operation;
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private bool pending, connected;
        public Pipe(string sid, uint access) {
            Name = @"\\.\pipe\aidlc-runner-probe-" + Guid.NewGuid().ToString("N");
            var security = new RawSecurityDescriptor("D:(A;;GA;;;" + sid + ")");
            byte[] descriptor = new byte[security.BinaryLength];
            security.GetBinaryForm(descriptor, 0);
            GCHandle pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            try {
                var attrs = new SecurityAttributes {
                    Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pin.AddrOfPinnedObject()
                };
                // Same byte-mode, SID-scoped directions as runner_pipe.rs.
                // Overlapped connect lets us observe early child exit.
                handle = CreateNamedPipeW(Name, access | 0x40000000, 0, 1, 65536, 65536, 0, ref attrs);
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                operation = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Overlapped)));
                Marshal.StructureToPtr(new Overlapped { Event = ready.SafeWaitHandle.DangerousGetHandle() }, operation, false);
                if (ConnectNamedPipe(handle, operation)) connected = true;
                else {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 535) connected = true; // ERROR_PIPE_CONNECTED
                    else if (error == 997) pending = true; // ERROR_IO_PENDING
                    else throw new Win32Exception(error);
                }
            } catch {
                Dispose();
                throw;
            } finally { pin.Free(); }
        }
        public bool Connected(uint expectedPid) {
            if (pending) {
                uint transferred;
                if (GetOverlappedResult(handle, operation, out transferred, false)) {
                    pending = false;
                    connected = true;
                } else {
                    int error = Marshal.GetLastWin32Error();
                    if (error != 996) throw new Win32Exception(error); // ERROR_IO_INCOMPLETE
                }
            }
            if (!connected) return false;
            uint actualPid;
            if (!GetNamedPipeClientProcessId(handle, out actualPid))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (actualPid != expectedPid) throw new InvalidOperationException("Unexpected pipe client identity.");
            return true;
        }
        public void Dispose() {
            if (handle != null && !handle.IsClosed) {
                if (pending) {
                    // Keep OVERLAPPED and its event alive until cancellation
                    // completes, including the no-child/early-exit paths.
                    CancelIoEx(handle, operation);
                    uint transferred;
                    GetOverlappedResult(handle, operation, out transferred, true);
                    pending = false;
                }
                handle.Dispose();
            }
            if (operation != IntPtr.Zero) { Marshal.FreeHGlobal(operation); operation = IntPtr.Zero; }
            ready.Dispose();
        }
    }

    public static Dictionary<string, object> Run(string runner, string user, string password, string sid, string cwd) {
        return RunDesktop(runner, user, password, sid, cwd, null);
    }
    public static Dictionary<string, object> RunPrivateDesktop(string runner, string user, string password, string sid, string cwd) {
        string owner = WindowsIdentity.GetCurrent().User.Value;
        var station = GuiObject(GetProcessWindowStation());
        if ((string)station["ownerSid"] != owner || (int)station["flags"] != 0 ||
            !((string)station["name"]).StartsWith("Service-0x"))
            throw new InvalidOperationException("Expected the fixture's noninteractive station.");
        // Faithful to pinned desktop.rs: create on the current station, then
        // launch with its hard-coded Winsta0 prefix. Never open/change Winsta0.
        string name = "CodexSandboxDesktop-" + Guid.NewGuid().ToString("N");
        var security = new RawSecurityDescriptor("D:P(A;;0xf01ff;;;" + owner + ")(A;;0x201ff;;;" + sid + ")");
        byte[] bytes = new byte[security.BinaryLength];
        security.GetBinaryForm(bytes, 0);
        GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        IntPtr desktop = IntPtr.Zero;
        try {
            var attributes = new SecurityAttributes {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pin.AddrOfPinnedObject()
            };
            desktop = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, 0xf01ff, ref attributes);
            if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var result = RunDesktop(runner, user, password, sid, cwd, "Winsta0\\" + name);
            result["restrictedCreateProcessAsUser"] = RunDesktop(runner, user, password, sid, cwd, "Winsta0\\" + name, true);
            return result;
        } finally {
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
            pin.Free();
        }
    }
    private static Dictionary<string, object> RunDesktop(string runner, string user, string password, string sid, string cwd, string desktopName, bool asUser = false) {
        // Both accounts must be fresh random fixture accounts. The caller never
        // looks up or changes CodexSandboxOffline/Online or their credentials.
        using (var identity = WindowsIdentity.GetCurrent()) {
            if (!identity.Name.Substring(identity.Name.LastIndexOf('\\') + 1).StartsWith("aidlc-pv-") ||
                !System.Text.RegularExpressions.Regex.IsMatch(user, "^aidlc-pr-[0-9a-f]{8}$") ||
                identity.User.Value == sid)
                throw new InvalidOperationException("Expected two distinct fixture identities.");
            var result = new Dictionary<string, object> {
                { "callerSid", identity.User.Value }, { "targetSid", sid },
                { "sessionId", Process.GetCurrentProcess().SessionId },
                { "station", GuiObject(GetProcessWindowStation()) },
                { "desktop", GuiObject(GetThreadDesktop(GetCurrentThreadId())) },
                { "startupDesktop", null }, { "logonFlags", 0 },
                { "creationFlags", "CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT" }
            };
            var logonSids = new List<string>();
            foreach (IdentityReference group in identity.Groups)
                if (group.Value.StartsWith("S-1-5-5-")) logonSids.Add(group.Value);
            result["logonSids"] = logonSids;
            var info = new ProcessInformation();
            var watch = Stopwatch.StartNew();
            string pipeSid = asUser ? identity.User.Value : sid;
            using (var pipeIn = new Pipe(pipeSid, 2)) // PIPE_ACCESS_OUTBOUND
            using (var pipeOut = new Pipe(pipeSid, 1)) { // PIPE_ACCESS_INBOUND
                var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)) };
                if (desktopName != null) {
                    startup.Desktop = desktopName;
                    result["startupDesktop"] = startup.Desktop;
                }
                // Exact pinned runner arguments. Names contain no quotes/spaces.
                var command = new StringBuilder("\"" + runner + "\" --pipe-in=" + pipeIn.Name + " --pipe-out=" + pipeOut.Name);
                bool created;
                // Match runner_client.rs, including suppression of native
                // loader error dialogs in this noninteractive logon.
                uint previousErrorMode = SetErrorMode(3);
                try {
                if (asUser) {
                    // A restricted version of the caller's token needs no
                    // SeAssignPrimaryToken privilege. No privilege is added.
                    byte[] sidBytes = new byte[identity.User.BinaryLength];
                    identity.User.GetBinaryForm(sidBytes, 0);
                    GCHandle sidPin = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
                    IntPtr token = IntPtr.Zero;
                    try {
                        var restricting = new SidAndAttributes { Sid = sidPin.AddrOfPinnedObject() };
                        if (!CreateRestrictedToken(identity.Token, 0xd, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, ref restricting, out token))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        created = CreateProcessAsUserW(token, runner, command, IntPtr.Zero, IntPtr.Zero, false,
                            0x08000000 | 0x400, IntPtr.Zero, cwd, ref startup, out info);
                        result["creationError"] = created ? 0 : Marshal.GetLastWin32Error();
                        result["api"] = "CreateProcessAsUserW(restricted caller token)";
                    } finally { if (token != IntPtr.Zero) CloseHandle(token); sidPin.Free(); }
                } else {
                    created = CreateProcessWithLogonW(user, ".", password, 0, runner, command,
                        0x08000000 | 0x400, IntPtr.Zero, cwd, ref startup, out info);
                    if (!created) result["creationError"] = Marshal.GetLastWin32Error();
                }
                } finally { SetErrorMode(previousErrorMode); }
                if (!created) {
                    return result;
                }
                try {
                    result["processId"] = info.ProcessId;
                    bool input = false, output = false;
                    do {
                        input = pipeIn.Connected(info.ProcessId);
                        output = pipeOut.Connected(info.ProcessId);
                        if (input && output) break;
                        uint state = WaitForSingleObject(info.Process, 0);
                        if (state == 0) {
                            uint exit;
                            if (!GetExitCodeProcess(info.Process, out exit))
                                throw new Win32Exception(Marshal.GetLastWin32Error());
                            result["naturalExitCode"] = "0x" + exit.ToString("X8");
                            break;
                        }
                        if (state != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
                        Thread.Sleep(10);
                    } while (watch.ElapsedMilliseconds < 15000);
                    result["pipeInConnected"] = input;
                    result["pipeOutConnected"] = output;
                    result["elapsedMs"] = watch.ElapsedMilliseconds;
                    result["timedOut"] = !(input && output) && !result.ContainsKey("naturalExitCode");
                } finally {
                    try {
                        uint state = WaitForSingleObject(info.Process, 0);
                        if (state == 258) {
                            if (!TerminateProcess(info.Process, 1))
                                throw new Win32Exception(Marshal.GetLastWin32Error());
                            if (WaitForSingleObject(info.Process, 5000) != 0)
                                throw new InvalidOperationException("Owned runner retirement was not confirmed.");
                        } else if (state != 0) {
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                        result["retired"] = true;
                    } finally {
                        CloseHandle(info.Thread);
                        CloseHandle(info.Process);
                    }
                }
            }
            return result;
        }
    }
}
