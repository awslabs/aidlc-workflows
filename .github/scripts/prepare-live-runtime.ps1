#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidateSet('prepare', 'prove', 'run', 'smoke', 'collect')]
    [string]$Mode = 'prepare',
    [ValidateSet('claude-sdk', 'claude-tui', 'codex', 'opencode', 'release-contract', 'isolation')]
    [string]$Family = 'isolation',
    [ValidatePattern('^[1-9][0-9]*/[1-9][0-9]*$')]
    [string]$Shard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# DirectorySecurity creation overloads below intentionally use .NET Framework.
# Hosted workflows may default to pwsh; re-enter the native Windows PS5.1 host.
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $nativeArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Mode', $Mode)
    if ($PSBoundParameters.ContainsKey('Family')) { $nativeArguments += @('-Family', $Family) }
    if ($PSBoundParameters.ContainsKey('Shard')) { $nativeArguments += @('-Shard', $Shard) }
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @nativeArguments
    exit $LASTEXITCODE
}
$root = 'C:\aidlc-live'
$work = Join-Path $root 'work'
$sandboxHome = Join-Path $root 'home'
$tools = Join-Path $root 'tools'
$userName = 'aidlc-live'
$runnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$sandboxSid = $null
$credential = $null
$createdRoot = $false
$createdState = $false
$createdUserSid = $null
$codexSandboxSids = @()
$codexSeed = Join-Path $root 'codex-sandbox-seed'
$exitCode = 1
$stage = $Mode
$stateRoot = $null
$git = 'C:\Program Files\Git\cmd\git.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# Windows system directories precede Git so MSYS coreutils (whoami, find, sort)
# never shadow the native tools, matching the hosted runner's own PATH order.
# npm exposes claude.cmd; native-launch journeys require the actual executable.
# This package directory is normalized and sealed with the rest of $tools before
# any credential-bearing run. Never discover it through the runner's profile.
$claudeNativeBin = Join-Path $tools 'npm\node_modules\@anthropic-ai\claude-code\bin'
$livePath = "$tools;$claudeNativeBin;$tools\npm;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0;C:\Program Files\Git\cmd;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin"

# File handles detect hard links (not reparse points), including links to secrets
# that the collecting administrator could read but the sandbox identity cannot.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AidlcFileBoundary {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    public static void RequireSingleLink(FileStream stream) {
        FileInformation info;
        if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (info.Links != 1) { throw new IOException("Refusing hard-linked runtime evidence."); }
        if ((info.Attributes & (uint)FileAttributes.ReparsePoint) != 0) {
            throw new IOException("Refusing reparse-backed runtime evidence.");
        }
    }
    public static void RequireSingleLink(string path) {
        using (FileStream stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            RequireSingleLink(stream);
        }
    }
}
'@

# C# 5-compatible: Windows PowerShell 5.1 uses the .NET Framework compiler.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class AidlcBatchLogon {
    [StructLayout(LayoutKind.Sequential)]
    private struct LsaObjectAttributes {
        public uint Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct LsaUnicodeString {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }
    [DllImport("advapi32.dll")]
    private static extern uint LsaOpenPolicy(IntPtr systemName, ref LsaObjectAttributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")]
    private static extern uint LsaAddAccountRights(IntPtr policy, [In] byte[] sid, [In] LsaUnicodeString[] rights, uint count);
    [DllImport("advapi32.dll")]
    private static extern uint LsaEnumerateAccountRights(IntPtr policy, [In] byte[] sid, out IntPtr rights, out uint count);
    [DllImport("advapi32.dll")]
    private static extern uint LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll")]
    private static extern uint LsaFreeMemory(IntPtr buffer);
    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr policy);

    private static void Check(uint status, string operation) {
        if (status == 0) { return; }
        uint error = LsaNtStatusToWinError(status);
        throw new Win32Exception(unchecked((int)error), operation + " failed (NTSTATUS 0x" + status.ToString("X8") + ", Win32 " + error + "): " + new Win32Exception(unchecked((int)error)).Message);
    }

    public static void Grant(string sidString) {
        GrantRight(sidString, "SeBatchLogonRight");
    }

    public static void GrantSandboxInteractive(string sidString) {
        GrantRight(sidString, "SeInteractiveLogonRight");
    }

    private static void GrantRight(string sidString, string name) {
        SecurityIdentifier identity = new SecurityIdentifier(sidString);
        byte[] sid = new byte[identity.BinaryLength];
        identity.GetBinaryForm(sid, 0);
        LsaObjectAttributes attributes = new LsaObjectAttributes();
        attributes.Length = (uint)Marshal.SizeOf(typeof(LsaObjectAttributes));
        IntPtr policy = IntPtr.Zero;
        IntPtr rightBuffer = IntPtr.Zero;
        IntPtr granted = IntPtr.Zero;
        try {
            // POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES; no service-logon grant.
            Check(LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x10 | 0x800, out policy), "LsaOpenPolicy");
            rightBuffer = Marshal.StringToHGlobalUni(name);
            LsaUnicodeString right = new LsaUnicodeString();
            right.Length = (ushort)(name.Length * 2);
            right.MaximumLength = (ushort)(right.Length + 2);
            right.Buffer = rightBuffer;
            Check(LsaAddAccountRights(policy, sid, new LsaUnicodeString[] { right }, 1), "LsaAddAccountRights");
            uint count;
            Check(LsaEnumerateAccountRights(policy, sid, out granted, out count), "LsaEnumerateAccountRights");
            int size = Marshal.SizeOf(typeof(LsaUnicodeString));
            bool found = false;
            for (uint index = 0; index < count; index++) {
                LsaUnicodeString item = (LsaUnicodeString)Marshal.PtrToStructure(IntPtr.Add(granted, checked((int)index * size)), typeof(LsaUnicodeString));
                string value = Marshal.PtrToStringUni(item.Buffer, item.Length / 2);
                if (String.Equals(value, name, StringComparison.Ordinal)) { found = true; }
            }
            if (!found) { throw new InvalidOperationException("LsaEnumerateAccountRights did not report SeBatchLogonRight."); }
        } finally {
            if (granted != IntPtr.Zero) { LsaFreeMemory(granted); }
            if (rightBuffer != IntPtr.Zero) { Marshal.FreeHGlobal(rightBuffer); }
            if (policy != IntPtr.Zero) { LsaClose(policy); }
        }
    }
}
'@

function Assert-PlainPath([string]$Path) {
    # Check ancestors too: testing just the final component misses junction roots.
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        try { $attributes = [IO.File]::GetAttributes($cursor) }
        catch [IO.FileNotFoundException] { $attributes = 0 }
        catch [IO.DirectoryNotFoundException] { $attributes = 0 }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Refusing a linked runtime path.'
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function New-PrivateDirectory([string]$Path) {
    Assert-PlainPath $Path
    if (Test-Path -LiteralPath $Path) { throw 'Refusing to reuse an existing runtime directory.' }
    # Supply the protected DACL at creation; do not briefly expose credential files.
    $acl = New-RuntimeAcl $true $null 'ReadAndExecute'
    [void][IO.Directory]::CreateDirectory($Path, $acl)
}

function New-RuntimeAcl([bool]$Directory, $Identity, [string]$Rights) {
    if ($Directory) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    # Do not recursively rewrite the existing runner owner's identity: profile
    # files may be SYSTEM-owned. Only the DACL needs to deny the sandbox access.
    if ($null -ne $Identity) { $acl.SetOwner($runnerSid) }
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($Directory) {
        $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    }
    foreach ($sid in @($systemSid, $adminSid, $runnerSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    if ($null -ne $Identity) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($Identity, $Rights, $inheritance, 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    return $acl
}

function Set-RuntimeAcl([string]$Path, $Identity, [string]$Rights, [switch]$Tree, [switch]$RejectLinks) {
    Assert-PlainPath $Path
    $directory = [IO.Directory]::Exists($Path)
    if ($RejectLinks -and -not $directory) { [AidlcFileBoundary]::RequireSingleLink($Path) }
    $acl = New-RuntimeAcl $directory $Identity $Rights
    if ($directory) { [IO.Directory]::SetAccessControl($Path, $acl) }
    else { [IO.File]::SetAccessControl($Path, $acl) }
    if ($Tree -and $directory) {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Path)) {
            # A link's target may be outside the runner's property. Never follow it.
            if (([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                if ($RejectLinks) { throw 'Refusing a linked installed tool.' }
                continue
            }
            Set-RuntimeAcl $entry $Identity $Rights -Tree -RejectLinks:$RejectLinks
        }
    }
}

function Copy-PlainTree([string]$Source, [string]$Destination, [switch]$Checkout, [switch]$RejectLinks) {
    Assert-PlainPath $Source
    Assert-PlainPath $Destination
    [void][IO.Directory]::CreateDirectory($Destination)
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Source)) {
        $name = [IO.Path]::GetFileName($entry)
        if ($Checkout -and ($name -match '^(\.git|\.aws|\.ssh|\.azure|\.config|\.npmrc|\.netrc|_netrc|\.pypirc|\.env(?:\..*)?)$')) { continue }
        $attributes = [IO.File]::GetAttributes($entry)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            if ($RejectLinks) { throw 'Refusing linked log evidence.' }
            continue
        }
        $target = Join-Path $Destination $name
        Assert-PlainPath $target
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
            Copy-PlainTree $entry $target -Checkout:$Checkout -RejectLinks:$RejectLinks
        } else {
            # Copy bytes, not source ACLs, alternate streams, or hard-link identity.
            $sourceStream = [IO.File]::Open($entry, 'Open', 'Read', 'Read')
            try {
                if ($RejectLinks) { [AidlcFileBoundary]::RequireSingleLink($sourceStream) }
                $output = [IO.File]::Open($target, 'CreateNew', 'Write', 'None')
                try { $sourceStream.CopyTo($output) } finally { $output.Dispose() }
            } finally { $sourceStream.Dispose() }
        }
    }
}

function Remove-OwnedTree([string]$Path) {
    # Only called for roots created by this invocation, never for a pre-existing root.
    Assert-PlainPath $Path
    if (-not [IO.Directory]::Exists($Path)) { return }
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Path)) {
        $attributes = [IO.File]::GetAttributes($entry)
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [IO.Directory]::Delete($entry) }
            else { Remove-OwnedTree $entry }
        } else {
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                [AidlcFileBoundary]::RequireSingleLink($entry)
                [IO.File]::SetAttributes($entry, 'Normal')
            }
            [IO.File]::Delete($entry)
        }
    }
    [IO.Directory]::Delete($Path)
}

function ConvertTo-PSLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-SafeEnvironment {
    $environment = [ordered]@{
        SystemRoot = $env:SystemRoot
        WINDIR = $env:SystemRoot
        SystemDrive = [IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd('\')
        ComSpec = (Join-Path $env:SystemRoot 'System32\cmd.exe')
        PATH = $livePath
        PATHEXT = '.COM;.EXE;.BAT;.CMD'
        PSModulePath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')
        OS = 'Windows_NT'
        PROCESSOR_ARCHITECTURE = 'AMD64'
        NUMBER_OF_PROCESSORS = [string][Environment]::ProcessorCount
        USERNAME = $userName
        USERDOMAIN = $env:COMPUTERNAME
        COMPUTERNAME = $env:COMPUTERNAME
        HOME = $sandboxHome
        USERPROFILE = $sandboxHome
        HOMEDRIVE = 'C:'
        HOMEPATH = '\aidlc-live\home'
        APPDATA = (Join-Path $sandboxHome 'AppData\Roaming')
        LOCALAPPDATA = (Join-Path $sandboxHome 'AppData\Local')
        TEMP = (Join-Path $sandboxHome 'tmp')
        TMP = (Join-Path $sandboxHome 'tmp')
        CI = 'true'
        GITHUB_ACTIONS = 'true'
        TERM = 'xterm-256color'
        AIDLC_LIVE_ROOT = $work
        AIDLC_LIVE_HOME = $sandboxHome
        AIDLC_LIVE_PATH = $livePath
        AIDLC_TEST_PACKAGE_READY = '1'
        AIDLC_NODE_BIN = (Join-Path $tools 'node.exe')
        AIDLC_BUN_BIN = (Join-Path $tools 'bun.exe')
        CLAUDE_CODE_GIT_BASH_PATH = 'C:\Program Files\Git\bin\bash.exe'
        GIT_CONFIG_NOSYSTEM = '1'
        GIT_CONFIG_GLOBAL = (Join-Path $sandboxHome '.gitconfig')
        GIT_TERMINAL_PROMPT = '0'
        npm_config_userconfig = (Join-Path $sandboxHome 'empty.npmrc')
        npm_config_globalconfig = (Join-Path $sandboxHome 'empty-global.npmrc')
        npm_config_cache = (Join-Path $sandboxHome 'npm-cache')
        npm_config_registry = 'https://registry.npmjs.org/'
    }
    if ($Family -eq 'codex') {
        $environment.AIDLC_CODEX_BIN = Join-Path $tools 'codex-managed.exe'
    }
    return $environment
}

function Add-BrokerEnvironment($Environment) {
    $url = $null
    if (-not [Uri]::TryCreate($env:AIDLC_BROKER_URL, [UriKind]::Absolute, [ref]$url) -or
        $url.Scheme -cne 'http' -or $url.Host -cne '127.0.0.1' -or $url.Port -le 0 -or
        $url.UserInfo -or $url.AbsolutePath -cne '/' -or $url.Query -or $url.Fragment) {
        throw 'Expected a loopback credential broker.'
    }
    $identity = ConvertFrom-Json -InputObject $env:AIDLC_BROKER_IDENTITY
    if ($identity.account -notmatch '^\d{12}$' -or
        $identity.arn -notmatch ('^arn:aws:sts::' + $identity.account + ':assumed-role/[A-Za-z0-9_+=,.@/-]+$')) {
        throw 'Expected a verified nonsecret broker identity.'
    }
    $Environment['AIDLC_BROKER_URL'] = $url.GetLeftPart([UriPartial]::Authority)
    $Environment['AIDLC_BROKER_IDENTITY'] = (@{ account = $identity.account; arn = $identity.arn } | ConvertTo-Json -Compress)
    foreach ($name in @('ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($value) {
            if ($value -notmatch '^global\.anthropic\.[a-z0-9.:-]+(?:\[1m\])?$') { throw 'Invalid model routing pin.' }
            $Environment[$name] = $value
        }
    }
}

function New-LaunchScript($Environment, [string]$Body) {
    $path = Join-Path (Join-Path $tools 'jobs') ('body-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("Set-StrictMode -Version Latest`n`$ErrorActionPreference = 'Stop'")
    $lines.Add(@'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Machine-level image markers are not credentials. Name inherited credential
# variables for diagnosis, remove them, then prove the scrub before adding the
# explicit nonsecret runtime/model configuration below. Never print values.
$credentialNames = '^(ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|ACTIONS_RUNTIME_TOKEN|ACTIONS_RESULTS_URL|GITHUB_TOKEN|GH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_ROLE_ARN|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|ANTHROPIC_.*|KIRO_API_KEY|CURSOR_API_KEY|AIDLC_BROKER_TOKEN)$'
$inheritedForbidden = @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -match $credentialNames } | Sort-Object)
if ($inheritedForbidden.Count -gt 0) {
    [Console]::WriteLine(('Removed forbidden env: {0}' -f ($inheritedForbidden -join ', ')))
    foreach ($key in $inheritedForbidden) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    [Environment]::SetEnvironmentVariable($key, $null, 'Process')
}
$remainingForbidden = @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -match $credentialNames } | Sort-Object)
if ($remainingForbidden.Count -gt 0) {
    [Console]::Error.WriteLine(('Forbidden env after scrub: {0}' -f ($remainingForbidden -join ', ')))
    exit 1
}
'@)
    foreach ($name in $Environment.Keys) {
        $lines.Add('[Environment]::SetEnvironmentVariable(' + (ConvertTo-PSLiteral $name) + ', ' + (ConvertTo-PSLiteral $Environment[$name]) + ", 'Process')")
    }
    $lines.Add('try {')
    $lines.Add($Body)
    $lines.Add("} catch { [Console]::Error.WriteLine(`$_.Exception.ToString()); exit 1 }")
    [IO.File]::WriteAllText($path, ($lines -join "`r`n"), [Text.UTF8Encoding]::new($true))
    Set-RuntimeAcl $path $sandboxSid 'ReadAndExecute'
    return $path
}

function Invoke-NativeChecked([string]$File, [string[]]$Arguments, [switch]$BestEffort) {
    $nativeExit = -1
    $captured = @()
    $previousPreference = $ErrorActionPreference
    try {
        # PS5.1 otherwise promotes native stderr into terminating errors.
        $ErrorActionPreference = 'Continue'
        $captured = @(& $File @Arguments 2>&1)
        $nativeExit = $LASTEXITCODE
    } catch {
        $captured += $_.Exception.ToString()
    } finally { $ErrorActionPreference = $previousPreference }
    if ($nativeExit -ne 0) {
        [Console]::Error.WriteLine(('{0} failed with exit code {1}' -f $File, $nativeExit))
        $marker = 'aidlc-native-' + [Guid]::NewGuid().ToString('N')
        [Console]::WriteLine(('::stop-commands::{0}' -f $marker))
        foreach ($line in $captured) { [Console]::Error.WriteLine([string]$line) }
        [Console]::WriteLine(('::{0}::' -f $marker))
        if (-not $BestEffort) { throw ('{0} failed with exit code {1}' -f $File, $nativeExit) }
    }
}

function Grant-BatchLogonRight {
    try {
        [AidlcBatchLogon]::Grant($sandboxSid.Value)
        [Console]::WriteLine('LSA granted and verified SeBatchLogonRight for the sandbox identity.')
        return
    } catch {
        [Console]::Error.WriteLine(('LSA batch-logon grant failed; trying secedit fallback: {0}' -f $_.Exception.ToString()))
    }
    $policy = Join-Path $stateRoot 'batch-logon.inf'
    $database = Join-Path $stateRoot 'batch-logon.sdb'
    Invoke-NativeChecked secedit.exe @('/export', '/cfg', $policy, '/areas', 'USER_RIGHTS', '/quiet')
    $lines = [Collections.Generic.List[string]]::new()
    $lines.AddRange([IO.File]::ReadAllLines($policy))
    $section = -1
    $right = -1
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^\s*\[Privilege Rights\]\s*$') { $section = $index; continue }
        if ($section -ge 0 -and $lines[$index] -match '^\s*\[') { break }
        if ($section -ge 0 -and $lines[$index] -match '^\s*SeBatchLogonRight\s*=') { $right = $index }
    }
    $entry = '*' + $sandboxSid.Value
    if ($right -ge 0) {
        $existing = @((($lines[$right] -split '=', 2)[1] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($existing -notcontains $entry) { $existing += $entry }
        $lines[$right] = 'SeBatchLogonRight = ' + ($existing -join ',')
    } elseif ($section -ge 0) {
        $lines.Insert($section + 1, 'SeBatchLogonRight = ' + $entry)
    } else {
        $lines.Add('[Privilege Rights]')
        $lines.Add('SeBatchLogonRight = ' + $entry)
    }
    [IO.File]::WriteAllLines($policy, $lines, [Text.Encoding]::Unicode)
    Invoke-NativeChecked secedit.exe @('/configure', '/db', $database, '/cfg', $policy, '/areas', 'USER_RIGHTS', '/quiet')
    Invoke-NativeChecked secedit.exe @('/export', '/cfg', $policy, '/areas', 'USER_RIGHTS', '/quiet')
    $verified = @([IO.File]::ReadAllLines($policy) | Where-Object { $_ -match '^\s*SeBatchLogonRight\s*=' })
    if ($verified.Count -ne 1) { throw 'Expected one batch logon policy entry.' }
    $principals = @((($verified[0] -split '=', 2)[1] -split ',') | ForEach-Object { $_.Trim() })
    if ($principals -notcontains $entry) { throw 'Sandbox batch logon right was not applied.' }
    [Console]::WriteLine('Granted and verified SeBatchLogonRight for the sandbox identity; no service-logon right added.')
}

function Invoke-Isolated([string]$Label, $Environment, [string]$Body, [int]$TimeoutMinutes = 30) {
    $script:stage = $Label
    if ($TimeoutMinutes -lt 1 -or $TimeoutMinutes -gt 350) { throw 'Invalid isolated task timeout.' }
    $bodyScript = New-LaunchScript $Environment $Body
    $id = $Label + '-' + [Guid]::NewGuid().ToString('N')
    $taskName = 'aidlc-live-' + $id
    $logRoot = Join-Path (Join-Path $tools 'logs') $id
    New-PrivateDirectory $logRoot
    Set-RuntimeAcl $logRoot $sandboxSid 'Modify'
    $stdout = Join-Path $logRoot 'stdout.log'
    $stderr = Join-Path $logRoot 'stderr.log'
    $wrapper = Join-Path (Join-Path $tools 'jobs') ($id + '.ps1')
    $taskBody = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $location = (Get-Location).Path
    [IO.File]::AppendAllText(__STDOUT__, ('Started as {0}; cwd={1}; session={2}' -f $identity, $location, (Get-Process -Id $PID).SessionId) + "`r`n", [Text.UTF8Encoding]::new($true))
    # Preserve body exit codes in a real child; native stderr must not trigger
    # PS5.1's terminating NativeCommandError before it reaches the UTF-8 log.
    $ErrorActionPreference = 'Continue'
    & __POWERSHELL__ -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File __BODY__ 2>&1 | Out-File -LiteralPath __STDOUT__ -Encoding UTF8 -Append
    $result = $LASTEXITCODE
    exit $result
} catch {
    [IO.File]::AppendAllText(__STDERR__, $_.Exception.ToString() + "`r`n", [Text.UTF8Encoding]::new($true))
    exit 1
}
'@
    $taskBody = $taskBody.Replace('__STDOUT__', (ConvertTo-PSLiteral $stdout)).Replace('__STDERR__', (ConvertTo-PSLiteral $stderr)).Replace('__POWERSHELL__', (ConvertTo-PSLiteral $powershell)).Replace('__BODY__', (ConvertTo-PSLiteral $bodyScript))
    [IO.File]::WriteAllText($wrapper, $taskBody, [Text.UTF8Encoding]::new($true))
    Set-RuntimeAcl $wrapper $sandboxSid 'ReadAndExecute'
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $wrapper + '"'
    $childExit = -1
    $registered = $false
    try {
        $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $work
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeoutMinutes) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $plainPassword = $credential.GetNetworkCredential().Password
        try {
            Register-ScheduledTask -TaskName $taskName -Action $action -User $credential.UserName -Password $plainPassword -RunLevel Limited -Settings $settings -ErrorAction Stop | Out-Null
            $registered = $true
        } catch {
            # Fallback only when registration fails, never after task execution.
            [Console]::Error.WriteLine(('Task Scheduler registration failed ({0}); attempting secondary-logon fallback.' -f $_.Exception.GetType().Name))
        } finally { $plainPassword = $null }
        if ($registered) {
            $previousRun = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime
            $startedAt = [DateTime]::UtcNow
            Start-ScheduledTask -TaskName $taskName
            $deadline = $startedAt.AddMinutes($TimeoutMinutes)
            do {
                $task = Get-ScheduledTask -TaskName $taskName
                $info = Get-ScheduledTaskInfo -TaskName $taskName
                if ($task.State -eq 'Ready' -and $info.LastRunTime -gt $previousRun) {
                    $childExit = [long]$info.LastTaskResult
                    break
                }
                if ($info.LastRunTime -le $previousRun -and [DateTime]::UtcNow -ge $startedAt.AddSeconds(30)) {
                    $childExit = [long]$info.LastTaskResult
                    throw ('Isolated scheduled task never started: state={0}, LastTaskResult=0x{1:X8}' -f $task.State, $childExit)
                }
                if ([DateTime]::UtcNow -ge $deadline) {
                    $childExit = [long]$info.LastTaskResult
                    throw ('Isolated scheduled task exceeded {0} minutes: state={1}, LastTaskResult=0x{2:X8}' -f $TimeoutMinutes, $task.State, $childExit)
                }
                Start-Sleep -Seconds 2
            } while ($true)
        } else {
            $process = Start-Process -FilePath $powershell -ArgumentList $arguments -Credential $credential `
                -UseNewEnvironment -WorkingDirectory $work -Wait -NoNewWindow -PassThru
            $process.Refresh()
            if ($null -eq $process.ExitCode) { throw 'Alternate-logon process did not report an exit code.' }
            $childExit = [long]$process.ExitCode
        }
        $script:exitCode = $childExit
        if ($childExit -ne 0) { throw "Isolated $Label exited $childExit" }
        if ($Label -eq 'batch-logon' -and [IO.File]::Exists($stdout)) {
            Get-Content -LiteralPath $stdout -Encoding UTF8 | ForEach-Object { [Console]::WriteLine([string]$_) }
        }
        return $childExit
    } catch {
        [IO.File]::AppendAllText($stderr, ($_.Exception.ToString() + "`r`n"))
        if ($registered) {
            try {
                $diagnostic = Get-ScheduledTaskInfo -TaskName $taskName | Format-List * | Out-String
                [IO.File]::WriteAllText((Join-Path $logRoot 'task-info.log'), $diagnostic, [Text.UTF8Encoding]::new($true))
            } catch { [Console]::Error.WriteLine('Task Scheduler information unavailable.') }
        }
        try {
            $events = Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 20 -ErrorAction Stop |
                Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List | Out-String
            [IO.File]::WriteAllText((Join-Path $logRoot 'task-events.log'), $events, [Text.UTF8Encoding]::new($true))
        } catch { [Console]::Error.WriteLine('Task Scheduler operational events unavailable.') }
        [Console]::Error.WriteLine(('Isolated {0} exit code: {1}' -f $Label, $childExit))
        & (Join-Path $tools 'bun.exe') (Join-Path $env:GITHUB_WORKSPACE 'scripts\ci-sanitize-logs.ts') $logRoot
        if ($LASTEXITCODE -eq 0) {
            $marker = 'aidlc-diagnostics-' + [Guid]::NewGuid().ToString('N')
            [Console]::WriteLine(('::stop-commands::{0}' -f $marker))
            foreach ($log in @($stdout, $stderr, (Join-Path $logRoot 'task-info.log'), (Join-Path $logRoot 'task-events.log'))) {
                $diagnosticLog = [IO.Path]::GetFileName($log) -like 'task-*.log'
                [Console]::WriteLine(('--- {0}: {1} ---' -f $(if ($diagnosticLog) { 'diagnostic' } else { 'last 40 lines' }), [IO.Path]::GetFileName($log)))
                if ([IO.File]::Exists($log)) {
                    if ($diagnosticLog) {
                        Get-Content -LiteralPath $log -Encoding UTF8 | ForEach-Object { [Console]::WriteLine([string]$_) }
                    } else {
                        Get-Content -LiteralPath $log -Encoding UTF8 -Tail 40 | ForEach-Object { [Console]::WriteLine([string]$_) }
                    }
                } else { [Console]::WriteLine('No retained UTF-8 text output.') }
            }
            [Console]::WriteLine(('::{0}::' -f $marker))
        } else { [Console]::Error.WriteLine('Child output sanitization failed; diagnostic text withheld.') }
        throw
    } finally {
        if ($registered) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        foreach ($scriptFile in @($wrapper, $bodyScript)) {
            if ([IO.File]::Exists($scriptFile)) { [IO.File]::Delete($scriptFile) }
        }
    }
}

function Get-RecordedLocalUser([Security.Principal.SecurityIdentifier]$Sid) {
    try { return Get-LocalUser -SID $Sid -ErrorAction Stop }
    catch {
        if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return $null }
        throw
    }
}

function Stop-SandboxProcesses([switch]$Disable, [string[]]$AdditionalSids = @()) {
    $ownedSids = @($sandboxSid.Value) + $AdditionalSids
    # Collection disables new logons; preparation only drains finished installers.
    if ($Disable) {
        foreach ($sid in $ownedSids) {
            $identity = [Security.Principal.SecurityIdentifier]::new($sid)
            if (Get-RecordedLocalUser $identity) {
                try { Disable-LocalUser -SID $identity -ErrorAction Stop }
                catch {
                    # Account deletion can race collection. Its old token SID
                    # still participates in the process drain below.
                    if (Get-RecordedLocalUser $identity) { throw }
                }
            }
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $found = $false
        foreach ($process in Get-CimInstance Win32_Process) {
            try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop }
            catch {
                if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw }
                continue
            }
            if ($owner.ReturnValue -eq 0 -and $owner.Sid -in $ownedSids) {
                $found = $true
                $result = Invoke-CimMethod -InputObject $process -MethodName Terminate -Arguments @{ Reason = [uint32]1 }
                if ($result.ReturnValue -ne 0 -and $result.ReturnValue -ne 9) { throw 'Could not stop an isolated process.' }
            }
        }
        if (-not $found) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Isolated processes did not stop; refusing unsafe collection.'
}

function Get-NpmInstallBody([string]$Package) {
    $node = ConvertTo-PSLiteral (Join-Path $tools 'node.exe')
    $npm = ConvertTo-PSLiteral (Join-Path $tools 'npm-cli\bin\npm-cli.js')
    $prefix = ConvertTo-PSLiteral (Join-Path $tools 'npm')
    $normalize = ConvertTo-PSLiteral (Join-Path $tools 'normalize-live-tools.cjs')
    # Both installer and normalization run with the sandbox identity. Never let
    # the collecting administrator copy bytes through an installer's hard link.
    return "& $node $npm install --global --prefix $prefix --no-audit --no-fund " +
        (ConvertTo-PSLiteral $Package) + "`nif (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }`n" +
        "& $node $normalize $prefix`nexit `$LASTEXITCODE"
}

function Get-VerifiedCodexDirectory {
    # rust-v0.151.0 -> 78c290807ce710180111df227df3b7a4fe845452.
    # Main/setup/runner hashes match the official GitHub release archives. The
    # complete npm payload, including manifest/code-mode host/rg, was independently
    # verified against its published SHA512 integrity. Sealing alone would not
    # authenticate an installer's output.
    if ($env:CODEX_VERSION -cne '0.151.0') { throw 'Codex provisioning requires the audited 0.151.0 native release.' }
    $expected = [ordered]@{
        'bin\codex.exe' = 'cf68265897197ac5f3bff6a10c168eec159842b353129726da5e3ed6b91ef0f4'
        'codex-resources\codex-windows-sandbox-setup.exe' = '46b9f3adb62ea6030ea026647b6a29f10566bff7307ca76d10f3a1c1189bd6e9'
        'codex-resources\codex-command-runner.exe' = '5a84820fc507e5e3c8689047434259d96197730e92d88e6a915b0da97c758da6'
        'bin\codex-code-mode-host.exe' = '4ea17cf938023f2d0c292b6dbcd4d51e7fbdf72f3885cf341017a380a87e77dc'
        'codex-path\rg.exe' = '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680'
        'codex-package.json' = '8689b9e6cb755d4b35e335fd08a847ce5d19f6f4ef6d893d1a16d044feefdf34'
    }
    $candidates = @(
        (Join-Path $tools 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'),
        (Join-Path $tools 'npm\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'),
        (Join-Path $tools 'npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc')
    )
    $found = @($candidates | Where-Object { [IO.File]::Exists((Join-Path $_ 'bin\codex.exe')) })
    if ($found.Count -ne 1) { throw 'Expected one installed native Codex directory.' }
    $directory = $found[0]
    Assert-PlainPath $directory
    # Prevent a correctly hashed executable loading an installer-planted DLL.
    $entries = @([IO.Directory]::GetFiles($directory, '*', [IO.SearchOption]::AllDirectories))
    if ($entries.Count -ne $expected.Count) { throw 'Unexpected companion files beside native Codex.' }
    foreach ($name in $expected.Keys) {
        $file = Join-Path $directory $name
        Assert-PlainPath $file
        [AidlcFileBoundary]::RequireSingleLink($file)
        $acl = Get-Acl -LiteralPath $file
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $runnerSid.Value) {
            throw 'Native Codex was not sealed by this runner.'
        }
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected[$name]) {
            throw 'Native Codex release digest mismatch.'
        }
    }
    return $directory
}

function Invoke-CodexProvisioning([string]$NativeDirectory, [string]$CodexHomePath) {
    # The public pinned CLI implements ProvisionOnly: no project execution,
    # provider request, or UAC prompt when invoked from this elevated process.
    # Use an empty, administrator-owned home and a cleared environment, never
    # a model-writable config as input to an administrator process.
    New-PrivateDirectory $CodexHomePath
    $adminHome = Join-Path $stateRoot 'codex-admin-home'
    New-PrivateDirectory $adminHome
    [IO.File]::WriteAllText((Join-Path $CodexHomePath 'config.toml'), '')
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $NativeDirectory 'bin\codex.exe'
    $info.Arguments = 'sandbox setup --elevated --user "' + $env:COMPUTERNAME + '\' + $userName + '" --codex-home "' + $CodexHomePath + '"'
    $info.WorkingDirectory = $CodexHomePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Clear()
    $clean = @{
        SystemRoot = $env:SystemRoot; WINDIR = $env:SystemRoot
        SystemDrive = [IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd('\')
        ComSpec = (Join-Path $env:SystemRoot 'System32\cmd.exe')
        PATH = "$NativeDirectory;$env:SystemRoot\System32;$env:SystemRoot"
        HOME = $adminHome; USERPROFILE = $adminHome; TEMP = $adminHome; TMP = $adminHome
        CODEX_HOME = $CodexHomePath; CODEX_MANAGED_PACKAGE_ROOT = $NativeDirectory; CI = 'true'; USERNAME = $env:USERNAME; USERDOMAIN = $env:COMPUTERNAME
    }
    foreach ($key in $clean.Keys) { $info.EnvironmentVariables[$key] = $clean[$key] }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) {
            # Stop only our exact process object. Preparation fails closed; a
            # timed-out administrator setup makes this ephemeral runner unusable.
            $process.Kill()
            throw 'Codex provisioning timed out; discard this ephemeral runner.'
        }
        [IO.File]::WriteAllText((Join-Path $stateRoot 'codex-setup.stdout.log'), $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $stateRoot 'codex-setup.stderr.log'), $stderr.GetAwaiter().GetResult())
        if ($process.ExitCode -ne 0) { throw 'Trusted Codex provisioning failed; retain sandbox.log, never sandbox-secrets.' }
    } finally { $process.Dispose() }
}

function Get-CodexHomeInitializer {
    # Executed only as the original low-user SID. Copy machine-scope DPAPI
    # artifacts, not passwords, preserving the pinned setup's access boundaries.
    # No subsequent administrator request or credential-bearing elevation exists.
    $body = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne __SID__) { throw 'Wrong Codex initializer identity.' }
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AidlcCodexDirectoryPin {
    [StructLayout(LayoutKind.Sequential)]
    private struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static SafeFileHandle Open(string path) {
        SafeFileHandle handle = CreateFileW(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        Info info;
        if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0) {
            handle.Dispose(); throw new InvalidOperationException("Codex home has a replaced or linked directory.");
        }
        return handle;
    }
}
"@
$pins = [Collections.Generic.List[IDisposable]]::new()
function Pin-Path([string]$Path) {
    $cursor = [IO.Path]::GetPathRoot($Path)
    foreach ($part in $Path.Substring($cursor.Length).Split('\')) {
        if (-not $part) { continue }
        $cursor = Join-Path $cursor $part
        $pins.Add([AidlcCodexDirectoryPin]::Open($cursor))
    }
}
function Access-Acl($Entry) {
    if ($Entry.directory) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [Security.AccessControl.FileSecurity]::new() }
    $acl.SetSecurityDescriptorSddlForm($Entry.sddl, [Security.AccessControl.AccessControlSections]::Access)
    # Directories have explicit native grants; discard inherited seed-root
    # grants so runtime refresh produces the same ACL. Secret files inherit
    # their native deny/grant rules, which must become explicit on the copy.
    $acl.SetAccessRuleProtection($true, (-not $Entry.directory))
    return $acl
}
function Access-Signature($Acl) {
    $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
        '{0}/{1}/{2}/{3}/{4}' -f $_.IdentityReference.Value, [int]$_.AccessControlType,
            [long]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags
    } | Sort-Object)
    return ([string]$Acl.AreAccessRulesProtected + ':' + ($rules -join '|'))
}
try {
    if (-not $env:CODEX_HOME -or -not $env:TEMP) { throw 'Fresh Codex home and runner temporary root are required.' }
    if ($env:CODEX_HOME -notmatch '^[A-Za-z]:[\\/]') { throw 'Codex home must be an absolute local path.' }
    $homePath = [IO.Path]::GetFullPath($env:CODEX_HOME).TrimEnd('\')
    $tempPath = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    if ($homePath -notmatch '^[A-Za-z]:\\' -or
        -not $homePath.StartsWith($tempPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Codex home is outside this test temporary root.'
    }
    Pin-Path $homePath
    if ((Get-Acl -LiteralPath $homePath).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne __SID__) {
        throw 'Codex home is not owned by its calling user.'
    }
    $seed = __SEED__
    Pin-Path $seed
    $manifest = Get-Content -LiteralPath (Join-Path $seed 'template.json') -Raw | ConvertFrom-Json
    $existing = [IO.Directory]::Exists((Join-Path $homePath '.sandbox'))
    foreach ($entry in $manifest.entries) {
        $path = Join-Path $homePath $entry.path
        $acl = Access-Acl $entry
        if ($entry.directory) {
            if (-not $existing) {
                if (Test-Path -LiteralPath $path) { throw 'Refusing a partial or occupied Codex sandbox home.' }
                [void][IO.Directory]::CreateDirectory($path, $acl)
            }
            $pins.Add([AidlcCodexDirectoryPin]::Open($path))
        } else {
            if (-not $existing) {
                $input = [IO.File]::Open((Join-Path $seed $entry.path), 'Open', 'Read', 'Read')
                try {
                    $output = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew,
                        [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096,
                        [IO.FileOptions]::None, $acl)
                    try { $input.CopyTo($output) } finally { $output.Dispose() }
                } finally { $input.Dispose() }
            }
            $attributes = [IO.File]::GetAttributes($path)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked Codex sandbox artifact.' }
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.sha256) {
                throw 'Codex sandbox artifact differs from this provisioning generation.'
            }
        }
        $actualAcl = Get-Acl -LiteralPath $path
        if ($actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne __SID__) {
            throw 'Codex sandbox artifact owner changed.'
        }
        $actual = Access-Signature $actualAcl
        $expected = Access-Signature $acl
        if ($actual -cne $expected) { throw 'Codex sandbox artifact access boundary changed.' }
    }
} finally {
    for ($index = $pins.Count - 1; $index -ge 0; $index--) { $pins[$index].Dispose() }
}
'@
    return $body.Replace('__SID__', (ConvertTo-PSLiteral $sandboxSid.Value)).Replace('__SEED__', (ConvertTo-PSLiteral $codexSeed))
}

function Initialize-CodexRuntime {
    $nativeDirectory = Get-VerifiedCodexDirectory
    # Setup rotates fixed machine-wide accounts. A fresh CI host is mandatory;
    # never reset an operator's existing Codex users or provision homes serially.
    foreach ($name in @('CodexSandboxOffline', 'CodexSandboxOnline')) {
        if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { throw 'Refusing pre-existing Codex sandbox accounts.' }
    }
    if (Get-LocalGroup -Name 'CodexSandboxUsers' -ErrorAction SilentlyContinue) { throw 'Refusing a pre-existing Codex sandbox group.' }
    try { Invoke-CodexProvisioning $nativeDirectory $codexSeed }
    finally {
        $script:codexSandboxSids = @(
            foreach ($name in @('CodexSandboxOffline', 'CodexSandboxOnline')) {
                $created = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
                if ($created) { $created.SID.Value }
            }
        )
        $state | Add-Member -NotePropertyName CodexSandboxSids -NotePropertyValue $codexSandboxSids -Force
        $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    }
    if ($codexSandboxSids.Count -ne 2) { throw 'Codex sandbox accounts were not provisioned.' }
    # 0.151.0 elevated/runner_client.rs uses CreateProcessWithLogonW(flags=0).
    # Explicitly grant the corresponding logon right to only our new accounts;
    # server policy need not grant it to the broad BUILTIN\Users group.
    foreach ($sid in $codexSandboxSids) { [AidlcBatchLogon]::GrantSandboxInteractive($sid) }
    $groupSid = (Get-LocalGroup -Name 'CodexSandboxUsers').SID
    $entries = @(
        foreach ($relative in @('.sandbox', '.sandbox-secrets', '.sandbox-bin', '.sandbox\setup_marker.json', '.sandbox-secrets\sandbox_users.json')) {
            $path = Join-Path $codexSeed $relative
            Assert-PlainPath $path
            $isDirectory = [IO.Directory]::Exists($path)
            if (-not $isDirectory) { [AidlcFileBoundary]::RequireSingleLink($path) }
            $acl = Get-Acl -LiteralPath $path
            if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($runnerSid.Value, $adminSid.Value, $systemSid.Value)) {
                throw 'Sandbox template ownership changed before sealing.'
            }
            $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            $allowed = @($runnerSid.Value, $adminSid.Value, $systemSid.Value, $sandboxSid.Value, $groupSid.Value)
            if (@($rules | Where-Object { $_.IdentityReference.Value -notin $allowed }).Count) {
                throw 'Sandbox template contains an unexpected principal.'
            }
            if ($relative -like '.sandbox-secrets*' -or $relative -eq '.sandbox\setup_marker.json') {
                if (@($rules | Where-Object {
                    $_.IdentityReference.Value -eq $groupSid.Value -and $_.AccessControlType -eq 'Allow'
                }).Count) { throw 'Sandbox template exposes a private setup artifact.' }
            }
            if ($relative -like '.sandbox-secrets*' -and -not @($rules | Where-Object {
                $_.IdentityReference.Value -eq $groupSid.Value -and $_.AccessControlType -eq 'Deny' -and
                ([long]$_.FileSystemRights -band 1)
            }).Count) { throw 'Sandbox template lacks its credential read denial.' }
            [pscustomobject]@{
                path = $relative; directory = $isDirectory
                sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
                sha256 = $(if ($isDirectory) { $null } else { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash })
            }
        }
    )
    [IO.File]::WriteAllText((Join-Path $codexSeed 'template.json'), (@{ entries = $entries } | ConvertTo-Json -Depth 5))
    # Keep the authoritative generation outside test TEMP and immutable to the
    # low user. The sandbox accounts receive no read access to this seed.
    Set-RuntimeAcl $codexSeed $sandboxSid 'ReadAndExecute' -Tree -RejectLinks
    $initializer = Join-Path $tools 'codex-initialize-home.ps1'
    [IO.File]::WriteAllText($initializer, (Get-CodexHomeInitializer), [Text.UTF8Encoding]::new($true))
    $launcher = @'
using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
public static class AidlcCodexLauncher {
    private const string Native = __NATIVE__;
    private const string PackageRoot = __PACKAGE_ROOT__;
    private const string PowerShell = __POWERSHELL__;
    private const string Initializer = __INITIALIZER__;
    // Quote each argv element with the CommandLineToArgvW backslash rules.
    // No command shell, expansion, or user-controlled command-line fragment.
    private static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); }
            else { result.Append('\\', slashes).Append(c); }
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static int Run(string executable, string[] args, int timeout) {
        ProcessStartInfo info = new ProcessStartInfo(executable);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.Arguments = String.Join(" ", Array.ConvertAll(args, Quote));
        info.EnvironmentVariables["CODEX_MANAGED_PACKAGE_ROOT"] = PackageRoot;
        info.EnvironmentVariables["CODEX_MANAGED_BY_NPM"] = "1";
        info.EnvironmentVariables.Remove("CODEX_MANAGED_BY_BUN");
        info.EnvironmentVariables.Remove("CODEX_MANAGED_BY_PNPM");
        using (Process child = Process.Start(info)) {
            // A console-less intermediate launcher must relay both pipes.
            // Native descendants otherwise have no usable console output.
            Task stdout = Task.Run(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
            Task stderr = Task.Run(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
            if (!child.WaitForExit(timeout)) {
                child.Kill();
                Console.Error.WriteLine("Codex home initialization timed out.");
                return 1;
            }
            if (!Task.WaitAll(new Task[] { stdout, stderr }, 5000)) {
                Console.Error.WriteLine("Codex native output did not finish after process exit.");
                return 1;
            }
            return child.ExitCode;
        }
    }
    public static int Main(string[] args) {
        try {
            bool version = args.Length == 1 && (args[0] == "--version" || args[0] == "-V");
            if (!version) {
                int initialized = Run(PowerShell, new string[] {
                    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", Initializer
                }, 30000);
                if (initialized != 0) return initialized;
            }
            return Run(Native, args, -1);
        } catch (Exception error) {
            Console.Error.WriteLine("Codex native launcher failed: " + error.Message);
            return 1;
        }
    }
}
'@
    $launcher = $launcher.Replace('__NATIVE__', (ConvertTo-Json -InputObject (Join-Path $nativeDirectory 'bin\codex.exe') -Compress))
    $launcher = $launcher.Replace('__PACKAGE_ROOT__', (ConvertTo-Json -InputObject $nativeDirectory -Compress))
    $launcher = $launcher.Replace('__POWERSHELL__', (ConvertTo-Json -InputObject $powershell -Compress))
    $launcher = $launcher.Replace('__INITIALIZER__', (ConvertTo-Json -InputObject $initializer -Compress))
    $compilerTemp = Join-Path $stateRoot 'codex-compiler-temp'
    New-PrivateDirectory $compilerTemp
    $compiler = [CodeDom.Compiler.CompilerParameters]::new()
    $compiler.GenerateExecutable = $true
    $compiler.GenerateInMemory = $false
    $compiler.OutputAssembly = Join-Path $tools 'codex-managed.exe'
    $compiler.CompilerOptions = '/platform:x64 /optimize+'
    $compiler.TempFiles = [CodeDom.Compiler.TempFileCollection]::new($compilerTemp, $false)
    [void]$compiler.ReferencedAssemblies.Add('System.dll')
    $provider = [Microsoft.CSharp.CSharpCodeProvider]::new()
    try {
        $compiled = $provider.CompileAssemblyFromSource($compiler, $launcher)
        if ($compiled.Errors.HasErrors) { throw 'Could not compile the trusted native Codex launcher.' }
    } finally { $provider.Dispose(); $compiler.TempFiles.Delete() }
    foreach ($name in @('codex-initialize-home.ps1', 'codex-managed.exe')) {
        Set-RuntimeAcl (Join-Path $tools $name) $sandboxSid 'ReadAndExecute' -RejectLinks
    }
    # Only executable inputs, never tools/jobs or tools/logs (which can contain
    # the original low user's credential-bearing launch environment).
    $readable = @($tools, (Join-Path $tools 'bun.exe'), (Join-Path $tools 'node.exe'), $nativeDirectory) +
        @([IO.Directory]::GetDirectories($nativeDirectory, '*', [IO.SearchOption]::AllDirectories)) +
        @([IO.Directory]::GetFiles($nativeDirectory, '*', [IO.SearchOption]::AllDirectories))
    foreach ($path in $readable) {
        $acl = Get-Acl -LiteralPath $path
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($groupSid, 'ReadAndExecute', 'None', 'None', 'Allow'))
        if ([IO.Directory]::Exists($path)) { [IO.Directory]::SetAccessControl($path, $acl) }
        else { [IO.File]::SetAccessControl($path, $acl) }
    }
}

function Get-CodexReadinessBody {
    # Actual native sandbox commands, not a model or provider probe. Exercise
    # both machine accounts through distinct fresh CODEX_HOMEs, then retain
    # the encrypted metadata only until the administrator drains those SIDs.
    $body = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$native = __NATIVE__
$bun = __BUN__
$env:CODEX_MANAGED_PACKAGE_ROOT = __PACKAGE_ROOT__
$expectedSids = __SIDS__
$initializer = __INITIALIZER__
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# Create the actual temporary root as the live user, as the test runner does.
# Assigning another user's ownership from the administrator requires a restore
# privilege that hosted runner tokens do not necessarily enable.
$ownedTemp = Join-Path $env:TEMP 'owned-temp'
[void][IO.Directory]::CreateDirectory($ownedTemp)
$env:TEMP = $ownedTemp
$env:TMP = $ownedTemp
$env:TMPDIR = $ownedTemp
$index = 0
foreach ($network in @('false', 'true')) {
    $base = Join-Path $env:TEMP ('home-' + $index)
    $env:CODEX_HOME = Join-Path $base 'codex home'
    $project = Join-Path $base 'project with spaces'
    [void][IO.Directory]::CreateDirectory($env:CODEX_HOME)
    [void][IO.Directory]::CreateDirectory($project)
    [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME 'config.toml'), "[windows]`nsandbox = `"elevated`"`n")
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $initializer
    if ($LASTEXITCODE -ne 0) { throw 'Fresh Codex home initialization failed.' }
    # No secret data is printed. The caller confirms existence; the sandboxed
    # command must prove access denial, not mistake a missing file for a deny.
    $secretPath = Join-Path $env:CODEX_HOME '.sandbox-secrets\sandbox_users.json'
    if (-not [IO.File]::Exists($secretPath)) { throw 'Fresh Codex sandbox credential file is absent.' }
    $probe = Join-Path $project 'probe.ps1'
    [IO.File]::WriteAllText($probe, @"
param([string]`$ExpectedSid, [string]`$SecretPath, [string]`$ForbiddenPath, [string]`$Literal)
`$ErrorActionPreference = 'Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne `$ExpectedSid) { throw 'Wrong native sandbox identity.' }
`$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (`$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Native sandbox identity is an administrator.' }
if (`$Literal -cne 'space "quoted" & symbols \tail\') { throw 'Native launcher changed an argument.' }
[IO.File]::WriteAllText((Join-Path (Get-Location) 'workspace-write.txt'), 'workspace-write verified')
`$denied = `$false
try { `$s = [IO.File]::OpenRead(`$SecretPath); `$s.Dispose() } catch [UnauthorizedAccessException] { `$denied = `$true }
if (-not `$denied) { throw 'Native sandbox can read its credential store.' }
`$denied = `$false
try { [IO.File]::WriteAllText(`$ForbiddenPath, 'must not be written') } catch [UnauthorizedAccessException] { `$denied = `$true }
if (-not `$denied) { throw 'Native sandbox can write outside its workspace.' }
Write-Output 'Codex native identity, workspace write, secret denial and protected-tool denial verified.'
"@)
    $invoke = Join-Path $project 'invoke.cjs'
    [IO.File]::WriteAllText($invoke, @"
const {spawnSync} = require("node:child_process");
const {writeSync} = require("node:fs");
const [launcher, shell, script, sid, secret, forbidden, network] = process.argv.slice(2);
const args = ["-c", "sandbox_mode=workspace-write", "-c", "windows.sandbox=elevated",
  "-c", "sandbox_workspace_write.network_access=" + network, "sandbox", "--",
  shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", script, "-ExpectedSid", sid, "-SecretPath", secret, "-ForbiddenPath", forbidden,
  "-Literal", 'space "quoted" & symbols \\tail\\'];
const result = spawnSync(launcher, args, {encoding:"utf8", stdio:["ignore","pipe","pipe"], timeout:90000});
writeSync(1, result.stdout || "");
// This credential-free probe records both channels on stdout so PowerShell 5
// cannot turn a diagnostic stderr line into an exception before exit handling.
writeSync(1, result.stderr || "");
writeSync(1, JSON.stringify({probe:"codex-native-readiness",network,status:result.status,
  signal:result.signal,error:result.error?.message,stdoutBytes:Buffer.byteLength(result.stdout || ""),
  stderrBytes:Buffer.byteLength(result.stderr || "")}) + "\n");
process.exitCode = result.status === null ? 1 : result.status;
"@)
    Set-Location -LiteralPath $project
    & $bun $invoke $native $powershell $probe $expectedSids[$index] $secretPath __FORBIDDEN__ $network
    if ($LASTEXITCODE -ne 0) { throw 'Fresh-home elevated sandbox readiness command failed.' }
    if (-not [IO.File]::Exists((Join-Path $project 'workspace-write.txt'))) { throw 'Native workspace write was not observed.' }
    # Resume-style reentry must validate the same generation without resetting
    # global account passwords or overwriting the test's own config.
    & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $initializer
    if ($LASTEXITCODE -ne 0) { throw 'Codex home could not be reused after native sandbox execution.' }
    $index++
}
[Console]::WriteLine('Codex elevated provisioning verified in two fresh low-user homes.')
'@
    $nativeDirectory = Get-VerifiedCodexDirectory
    $native = Join-Path $tools 'codex-managed.exe'
    $body = $body.Replace('__NATIVE__', (ConvertTo-PSLiteral $native))
    $body = $body.Replace('__BUN__', (ConvertTo-PSLiteral (Join-Path $tools 'bun.exe')))
    $body = $body.Replace('__PACKAGE_ROOT__', (ConvertTo-PSLiteral $nativeDirectory))
    $body = $body.Replace('__INITIALIZER__', (ConvertTo-PSLiteral (Join-Path $tools 'codex-initialize-home.ps1')))
    $body = $body.Replace('__SIDS__', ('@(' + (($codexSandboxSids | ForEach-Object { ConvertTo-PSLiteral $_ }) -join ',') + ')'))
    return $body.Replace('__FORBIDDEN__', (ConvertTo-PSLiteral (Join-Path $tools 'codex-outside-write-must-not-exist')))
}

function Get-CodexRuntimeSids($Record) {
    if (-not $Record.PSObject.Properties['CodexSandboxSids']) { return }
    if ($null -eq $Record.CodexSandboxSids) { return }
    $recorded = @($Record.CodexSandboxSids)
    if ($recorded.Count -eq 0) { return }
    foreach ($sid in $recorded) {
        $account = Get-RecordedLocalUser ([Security.Principal.SecurityIdentifier]::new([string]$sid))
        if ($null -ne $account -and $account.Name -notin @('CodexSandboxOffline', 'CodexSandboxOnline')) {
            throw 'Recorded Codex sandbox account no longer matches this runtime.'
        }
        # Never resolve a removed account by name: a new account with that
        # name is unrelated. Retain the recorded SID for residual processes.
        [string]$sid
    }
}

function Assert-RuntimeOwner($Record) {
    if ($Record.Version -ne 1 -or $Record.RunnerSid -ne $runnerSid.Value -or
        $Record.Workspace -ne $workspace -or $Record.RunnerHome -ne $runnerHome -or $Record.RunnerTemp -ne $runnerTemp) {
        throw 'Runtime state does not belong to this runner.'
    }
}

function Save-PreparationFailure($Failure, [bool]$IncludeLaunchLogs) {
    $evidence = Join-Path $stateRoot 'preparation-evidence'
    New-PrivateDirectory $evidence
    $summary = 'Windows live runtime failed closed during {0} ({1}, line {2}).' -f $stage, $Failure.Exception.GetType().Name, $Failure.InvocationInfo.ScriptLineNumber
    [IO.File]::WriteAllText((Join-Path $evidence 'preparation.log'), $summary + "`r`n", [Text.UTF8Encoding]::new($true))
    if ($Family -eq 'codex') {
        # Explicit diagnostic allowlist. Never traverse or copy sandbox-secrets.
        $diagnostics = @((Join-Path $stateRoot 'codex-setup.stdout.log'), (Join-Path $stateRoot 'codex-setup.stderr.log'))
        $sandboxLogs = Join-Path $codexSeed '.sandbox'
        if ([IO.Directory]::Exists($sandboxLogs)) {
            $diagnostics += @([IO.Directory]::GetFiles($sandboxLogs, 'sandbox*.log', [IO.SearchOption]::TopDirectoryOnly))
            $diagnostics += Join-Path $sandboxLogs 'setup_error.json'
        }
        foreach ($path in $diagnostics) {
            if (-not [IO.File]::Exists($path)) { continue }
            Assert-PlainPath $path
            [AidlcFileBoundary]::RequireSingleLink($path)
            [IO.File]::Copy($path, (Join-Path $evidence ([IO.Path]::GetFileName($path))), $false)
        }
    }
    if ($IncludeLaunchLogs -and [IO.Directory]::Exists((Join-Path $tools 'logs'))) {
        try { Copy-PlainTree (Join-Path $tools 'logs') (Join-Path $evidence 'launch') -RejectLinks }
        catch {
            # A failed strict copy may have left partial files. Do not publish
            # any of that tree, and never retry without the link checks.
            $partial = Join-Path $evidence 'launch'
            if ([IO.Directory]::Exists($partial)) { Remove-OwnedTree $partial }
            [IO.File]::AppendAllText((Join-Path $evidence 'preparation.log'), "Launch output could not be retained safely.`r`n")
        }
    }
    # PowerShell 5.1 serializes the empty output of $(if (...) { @() }) as
    # AutomationNull/{} inside a property. Preserve a real array so collection
    # never interprets an empty non-Codex record as an account SID.
    $recordedCodexSids = @()
    if ($Family -eq 'codex') { $recordedCodexSids = @($codexSandboxSids) }
    [pscustomobject]@{
        Version = 1; RunnerSid = $runnerSid.Value
        SandboxSid = $(if ($null -ne $createdUserSid) { $createdUserSid.Value } else { $null })
        CodexSandboxSids = $recordedCodexSids
        Family = $Family; Workspace = $workspace; RunnerHome = $runnerHome; RunnerTemp = $runnerTemp
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateRoot 'preparation-failed.json') -Encoding UTF8
}

function Collect-PreparationFailure([bool]$FamilyProvided) {
    $marker = Join-Path $stateRoot 'preparation-failed.json'
    Assert-PlainPath $marker
    $record = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    Assert-RuntimeOwner $record
    $codexSandboxSids = @(Get-CodexRuntimeSids $record)
    if ($FamilyProvided -and $Family -ne $record.Family) { throw 'Runtime was prepared for another family.' }
    if ($null -ne $record.SandboxSid) {
        $script:sandboxSid = [Security.Principal.SecurityIdentifier]::new($record.SandboxSid)
        # Preparation normally already removed this identity. Its recorded SID
        # still identifies any remaining token/process; never disable a new user
        # that happens to have reused the same account name.
        Stop-SandboxProcesses -Disable -AdditionalSids $codexSandboxSids
    }
    $destination = Join-Path $workspace 'tests\logs'
    Assert-PlainPath $destination
    [void][IO.Directory]::CreateDirectory($destination)
    $collected = Join-Path $destination ('windows-preparation-' + [Guid]::NewGuid().ToString('N'))
    Copy-PlainTree (Join-Path $stateRoot 'preparation-evidence') $collected -RejectLinks
    Set-RuntimeAcl $collected $null 'ReadAndExecute' -Tree
    [Console]::WriteLine('Collected failed Windows preparation evidence for sanitization.')
}

function Get-ProofBody {
    $paths = @($state.RunnerHome, $state.RunnerTemp, $state.Workspace)
    $files = @((Join-Path $stateRoot 'credential.clixml'), (Join-Path $state.Workspace 'scripts\ci-live-sandbox.ts'))
    if ($env:GITHUB_ENV) { $files += $env:GITHUB_ENV }
    $body = @'
$expected = __SID__
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $expected) { throw 'Wrong process identity.' }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
# Batch logons may use session 0; identity and process/file access denial, not
# interactive-session numbering, establish this hosted CLI boundary.
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Sandbox is an administrator.' }
function Test-AccessDenied($Failure, [switch]$Win32) {
    $exception = $Failure.Exception
    while ($null -ne $exception) {
        if ($Win32 -and $exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 5) { return $true }
        if (-not $Win32 -and $exception -is [UnauthorizedAccessException]) { return $true }
        $exception = $exception.InnerException
    }
    return $false
}
foreach ($path in __DIRECTORIES__) {
    $denied = $false
    try { [void][IO.Directory]::GetFileSystemEntries($path) }
    catch { if (-not (Test-AccessDenied $_)) { throw }; $denied = $true }
    if (-not $denied) { throw 'Sandbox can list a protected runner directory.' }
}
foreach ($path in __FILES__) {
    $denied = $false
    try { $stream = [IO.File]::OpenRead($path); $stream.Dispose() }
    catch { if (-not (Test-AccessDenied $_)) { throw }; $denied = $true }
    if (-not $denied) { throw 'Sandbox can read a protected control-plane file.' }
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AidlcProcessProof {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
"@
# Both independent probes must fail specifically with ERROR_ACCESS_DENIED.
# Module enumeration needs PROCESS_QUERY_INFORMATION | PROCESS_VM_READ; probe
# that handle directly because .NET's Process.Modules can return an empty list
# instead of surfacing the denial.
if ([Diagnostics.Process]::GetProcessById(__PID__).HasExited) { throw 'Launcher process exited before the proof ran.' }
$handle = [AidlcProcessProof]::OpenProcess(0x0410, $false, __PID__)
$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($handle -ne [IntPtr]::Zero) {
    [void][AidlcProcessProof]::CloseHandle($handle)
    throw 'Sandbox can enumerate launcher modules.'
}
if ($errorCode -ne 5) { throw 'Module probe did not prove access denial.' }
$handle = [AidlcProcessProof]::OpenProcess(0x0010, $false, __PID__)
$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($handle -ne [IntPtr]::Zero) {
    [void][AidlcProcessProof]::CloseHandle($handle)
    throw 'Sandbox can open launcher process memory.'
}
if ($errorCode -ne 5) { throw 'Process-memory probe did not prove access denial.' }
if (-not [IO.File]::Exists('C:\aidlc-live\work\scripts\ci-live-sandbox.ts')) { throw 'Isolated source is missing.' }
& 'C:\aidlc-live\tools\bun.exe' --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (__CLAUDE_FAMILY__) {
    $nativeClaude = 'C:\aidlc-live\tools\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
    $resolvedClaude = (Get-Command claude.exe -CommandType Application -ErrorAction Stop).Source
    if (-not [String]::Equals([IO.Path]::GetFullPath($resolvedClaude), $nativeClaude, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Native Claude did not resolve inside the sealed tool package.'
    }
    $denied = $false
    try { $stream = [IO.File]::Open($nativeClaude, 'Open', 'Write', 'ReadWrite'); $stream.Dispose() }
    catch { if (-not (Test-AccessDenied $_)) { throw }; $denied = $true }
    if (-not $denied) { throw 'Sandbox can write the native Claude executable.' }
    & $nativeClaude --version
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory=C:/aidlc-live/work -C 'C:\aidlc-live\work' rev-parse --is-inside-work-tree
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$configProbe = [IO.File]::Open((Join-Path $env:HOME '.gitconfig'), 'Open', 'ReadWrite', 'Read')
$configProbe.Dispose()
[Console]::WriteLine('Separate-user Windows isolation verified: identity, environment, files, modules, PROCESS_VM_READ.')
exit 0
'@
    $directoryLiterals = @($paths | ForEach-Object { ConvertTo-PSLiteral $_ }) -join ', '
    $fileLiterals = @($files | ForEach-Object { ConvertTo-PSLiteral $_ }) -join ', '
    $claudeFamily = if ($Family -in @('claude-sdk', 'claude-tui')) { '$true' } else { '$false' }
    return $body.Replace('__SID__', (ConvertTo-PSLiteral $sandboxSid.Value)).Replace('__DIRECTORIES__', ('@(' + $directoryLiterals + ')')).Replace('__FILES__', ('@(' + $fileLiterals + ')')).Replace('__PID__', [string]$PID).Replace('__CLAUDE_FAMILY__', $claudeFamily)
}

try {
    if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell.' }
    foreach ($name in @('GITHUB_WORKSPACE', 'RUNNER_TEMP', 'USERPROFILE')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not $value -or -not [IO.Directory]::Exists($value)) { throw 'Missing trusted runner directory.' }
        Assert-PlainPath $value
    }
    $workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd('\')
    $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
    $runnerHome = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
    foreach ($path in @($workspace, $runnerTemp, $runnerHome)) {
        if ($path.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $root.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Runner and sandbox roots must not overlap.'
        }
    }
    $stateRoot = Join-Path $runnerTemp 'aidlc-live-runtime'
    $stateFile = Join-Path $stateRoot 'state.json'
    $credentialFile = Join-Path $stateRoot 'credential.clixml'
    Assert-PlainPath $root
    Assert-PlainPath $stateRoot

    if ($Mode -eq 'prepare') {
        if ((Get-LocalUser -Name $userName -ErrorAction SilentlyContinue) -or
            (Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $stateRoot)) {
            throw 'Refusing to reuse an existing sandbox identity or root.'
        }
        foreach ($name in @('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'BROKER_ACCESS_KEY_ID', 'BROKER_SECRET_ACCESS_KEY', 'BROKER_SESSION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KIRO_API_KEY', 'CURSOR_API_KEY')) {
            if ([Environment]::GetEnvironmentVariable($name, 'Process')) { throw 'Prepare must run before provider credentials are acquired.' }
        }
        New-PrivateDirectory $stateRoot
        $createdState = $true
        New-PrivateDirectory $root
        $createdRoot = $true
        foreach ($path in @($work, $sandboxHome, $tools)) { New-PrivateDirectory $path }
        New-PrivateDirectory (Join-Path $tools 'logs')
        New-PrivateDirectory (Join-Path $tools 'jobs')
        $stage = 'copying checkout'
        # No .git auth config, user config, reparse targets, or credential files cross.
        Copy-PlainTree $workspace $work -Checkout
        $stage = 'copying tools'
        foreach ($name in @('bun.exe', 'node.exe')) {
            $source = (Get-Command $name -CommandType Application -ErrorAction Stop).Source
            Assert-PlainPath $source
            [IO.File]::Copy($source, (Join-Path $tools $name), $false)
        }
        $normalizerSource = Join-Path $workspace '.github\scripts\normalize-live-tools.cjs'
        Assert-PlainPath $normalizerSource
        [AidlcFileBoundary]::RequireSingleLink($normalizerSource)
        [IO.File]::Copy($normalizerSource, (Join-Path $tools 'normalize-live-tools.cjs'), $false)
        Assert-PlainPath $git
        if (-not [IO.File]::Exists($git)) { throw 'Hosted Windows Git is required.' }
        foreach ($path in @('tmp', 'AppData\Roaming', 'AppData\Local', 'npm-cache')) {
            [void][IO.Directory]::CreateDirectory((Join-Path $sandboxHome $path))
        }
        foreach ($name in @('empty.npmrc', 'empty-global.npmrc')) { [IO.File]::WriteAllText((Join-Path $sandboxHome $name), '') }
        $package = $null
        $pinName = $null
        switch ($Family) {
            { $_ -in @('claude-sdk', 'claude-tui') } { $package = '@anthropic-ai/claude-code'; $pinName = 'CLAUDE_CODE_VERSION' }
            'codex' { $package = '@openai/codex'; $pinName = 'CODEX_VERSION' }
            'opencode' { $package = 'opencode-ai'; $pinName = 'OPENCODE_VERSION' }
        }
        if ($package) {
            $version = [Environment]::GetEnvironmentVariable($pinName, 'Process')
            if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'A pinned family CLI version is required.' }
            $package += '@' + $version
            $npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
            $npmSource = Join-Path ([IO.Path]::GetDirectoryName($npmCommand)) 'node_modules\npm'
            if (-not [IO.File]::Exists((Join-Path $npmSource 'bin\npm-cli.js'))) { throw 'Cannot locate the hosted npm CLI.' }
            Copy-PlainTree $npmSource (Join-Path $tools 'npm-cli')
        }
        [void][IO.Directory]::CreateDirectory((Join-Path $tools 'npm'))
        [void][IO.Directory]::CreateDirectory((Join-Path $tools 'git-template'))
        Start-Service seclogon
        Invoke-NativeChecked wevtutil.exe @('sl', 'Microsoft-Windows-TaskScheduler/Operational', '/e:true') -BestEffort
        $stage = 'creating identity'
        $random = [byte[]]::new(48)
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($random) } finally { $generator.Dispose() }
        $password = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($random)) -AsPlainText -Force
        [Array]::Clear($random, 0, $random.Length)
        $user = New-LocalUser -Name $userName -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description 'Ephemeral isolated AIDLC live runtime'
        $sandboxSid = $user.SID
        $createdUserSid = $sandboxSid
        Add-LocalGroupMember -SID $usersSid -Member $user
        foreach ($group in Get-LocalGroup) {
            if ($group.SID.Value -eq $usersSid.Value) { continue }
            $members = @(Get-LocalGroupMember -SID $group.SID)
            if (@($members | Where-Object { $_.SID.Value -eq $sandboxSid.Value }).Count -ne 0) {
                throw 'The sandbox identity has unexpected local group membership.'
            }
        }
        $stage = 'granting sandbox batch logon'
        Grant-BatchLogonRight
        $credential = [Management.Automation.PSCredential]::new(($env:COMPUTERNAME + '\' + $userName), $password)
        $password = $null
        # Windows bypass-traverse rights make a private root alone insufficient.
        # Reset real descendants too, including previously protected child DACLs.
        $stage = 'protecting runner files'
        foreach ($path in @($runnerHome, $runnerTemp, $workspace)) { Set-RuntimeAcl $path $null 'ReadAndExecute' -Tree }
        Set-RuntimeAcl $root $sandboxSid 'ReadAndExecute'
        Set-RuntimeAcl $tools $sandboxSid 'ReadAndExecute' -Tree
        Set-RuntimeAcl $work $sandboxSid 'Modify' -Tree
        Set-RuntimeAcl $sandboxHome $sandboxSid 'Modify' -Tree
        $stage = 'transferring sandbox worktree ownership'
        Invoke-NativeChecked icacls.exe @($work, '/setowner', ($env:COMPUTERNAME + '\' + $userName), '/T', '/C', '/Q')
        # The sandbox owns its worktree; keep an explicit path-only Git trust record.
        [IO.File]::WriteAllText((Join-Path $sandboxHome '.gitconfig'), "[safe]`n`tdirectory = C:/aidlc-live/work`n")
        [Console]::WriteLine(('Sandbox worktree owner: {0}' -f (Get-Acl -LiteralPath $work).Owner))
        $credential | Export-Clixml -LiteralPath $credentialFile
        Set-RuntimeAcl $credentialFile $null 'ReadAndExecute'
        $state = [pscustomobject]@{
            Version = 1; RunnerSid = $runnerSid.Value; SandboxSid = $sandboxSid.Value
            Family = $Family; Workspace = $workspace; RunnerHome = $runnerHome; RunnerTemp = $runnerTemp
        }
        $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
        $safe = Get-SafeEnvironment
        $exitCode = Invoke-Isolated 'batch-logon' $safe "& '$env:SystemRoot\System32\whoami.exe' /priv`nexit `$LASTEXITCODE" -TimeoutMinutes 2
        if ($exitCode -ne 0) { throw 'Sandbox batch logon probe failed.' }
        # Fresh metadata cannot contain the original checkout's credential helpers.
        $gitBody = @'
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory=C:/aidlc-live/work -c init.templateDir=C:/aidlc-live/tools/git-template init --quiet .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory=C:/aidlc-live/work -C 'C:\aidlc-live\work' rev-parse --is-inside-work-tree
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory=C:/aidlc-live/work -c core.hooksPath=C:/aidlc-live/tools/git-template add --all -- .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory=C:/aidlc-live/work -c core.hooksPath=C:/aidlc-live/tools/git-template -c commit.gpgsign=false -c user.name=aidlc-live -c user.email=aidlc-live@localhost commit --quiet --allow-empty -m 'Isolated source snapshot'
exit $LASTEXITCODE
'@
        $exitCode = Invoke-Isolated 'git-init' $safe $gitBody -TimeoutMinutes 10
        if ($exitCode -ne 0) { throw 'Isolated source snapshot failed.' }
        if ($package) {
            # Installer code runs without runner authority, even before AWS setup.
            Set-RuntimeAcl (Join-Path $tools 'npm') $sandboxSid 'Modify'
            $installBody = Get-NpmInstallBody $package
            $exitCode = Invoke-Isolated 'npm-install' $safe $installBody
            if ($exitCode -ne 0) { throw 'Pinned isolated CLI installation failed.' }
            Stop-SandboxProcesses -AdditionalSids $codexSandboxSids
            Set-RuntimeAcl $tools $sandboxSid 'ReadAndExecute' -Tree -RejectLinks
        }
        if ($Family -eq 'codex') {
            $stage = 'provisioning the verified Codex sandbox'
            Initialize-CodexRuntime
        }
        $exitCode = Invoke-Isolated 'prepare-proof' $safe (Get-ProofBody)
        Stop-SandboxProcesses -AdditionalSids $codexSandboxSids
        if ($exitCode -ne 0) { throw 'Windows isolation proof failed.' }
        if ($Family -eq 'codex') {
            $stage = 'proving fresh Codex sandbox homes'
            $proofRoot = Join-Path $root ('codex-readiness-' + [Guid]::NewGuid().ToString('N'))
            New-PrivateDirectory $proofRoot
            Set-RuntimeAcl $proofRoot $sandboxSid 'Modify'
            $proofEnvironment = Get-SafeEnvironment
            $proofEnvironment.TEMP = $proofRoot
            $proofEnvironment.TMP = $proofRoot
            $proofEnvironment.TMPDIR = $proofRoot
            $exitCode = Invoke-Isolated 'codex-sandbox-proof' $proofEnvironment (Get-CodexReadinessBody) -TimeoutMinutes 3
            Stop-SandboxProcesses -AdditionalSids $codexSandboxSids
            if ($exitCode -ne 0) { throw 'Fresh-home Codex sandbox proof failed.' }
            Remove-OwnedTree $proofRoot
        }
        [Console]::WriteLine('Prepared the separate-user Windows live runtime.')
        exit 0
    }

    if ($Mode -eq 'collect' -and [IO.File]::Exists((Join-Path $stateRoot 'preparation-failed.json'))) {
        Collect-PreparationFailure ($PSBoundParameters.ContainsKey('Family'))
        exit 0
    }
    Assert-PlainPath $stateFile
    Assert-PlainPath $credentialFile
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    Assert-RuntimeOwner $state
    $codexSandboxSids = @(Get-CodexRuntimeSids $state)
    $user = Get-LocalUser -Name $userName
    if ($user.SID.Value -ne $state.SandboxSid) { throw 'Runtime identity no longer matches its owner record.' }
    $sandboxSid = $user.SID
    if ($PSBoundParameters.ContainsKey('Family') -and $Family -ne $state.Family) { throw 'Runtime was prepared for another family.' }
    $Family = $state.Family
    if ($Mode -eq 'collect') {
        Stop-SandboxProcesses -Disable -AdditionalSids $codexSandboxSids
        $source = Join-Path $work 'tests\logs'
        Assert-PlainPath (Join-Path $work 'tests')
        Assert-PlainPath $source
        $destination = Join-Path $workspace 'tests\logs'
        Assert-PlainPath $destination
        if ([IO.Directory]::Exists($source)) {
            # Fresh staging prevents overwriting a link planted in an existing destination.
            $staging = Join-Path $stateRoot ('logs-' + [Guid]::NewGuid().ToString('N'))
            Copy-PlainTree $source $staging -RejectLinks
            if (Test-Path -LiteralPath $destination) {
                # Preserve existing trusted logs rather than deleting another step's evidence.
                $destination = Join-Path $destination ('windows-isolated-' + [Guid]::NewGuid().ToString('N'))
            }
            Copy-PlainTree $staging $destination -RejectLinks
        } else { [void][IO.Directory]::CreateDirectory($destination) }
        $launchLogs = Join-Path $destination ('windows-launch-' + [Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($launchLogs)
        Copy-PlainTree (Join-Path $tools 'logs') $launchLogs -RejectLinks
        Set-RuntimeAcl (Join-Path $workspace 'tests\logs') $null 'ReadAndExecute' -Tree
        [Console]::WriteLine('Collected runner-owned Windows logs for sanitization; sandbox logons are disabled.')
        exit 0
    }
    if (-not $user.Enabled) { throw 'The collected runtime cannot launch further processes.' }
    Start-Service seclogon
    $credential = Import-Clixml -LiteralPath $credentialFile
    if ($credential -isnot [Management.Automation.PSCredential] -or $credential.UserName -ne ($env:COMPUTERNAME + '\' + $userName)) {
        throw 'Invalid runtime credential record.'
    }
    $safe = Get-SafeEnvironment
    $timeoutMinutes = 30
    if ($Mode -eq 'smoke') { $timeoutMinutes = 10 }
    if ($Mode -eq 'run') { $timeoutMinutes = 44 }
    switch ($Mode) {
        'prove' { $body = Get-ProofBody }
        'smoke' { $body = "& 'C:\aidlc-live\tools\bun.exe' tests/run-tests.ts --smoke --filter '^t01'`nexit `$LASTEXITCODE" }
        'run' {
            if ($Family -eq 'isolation') { throw 'Choose a live family when preparing a live run.' }
            if ($Family -ne 'release-contract') { Add-BrokerEnvironment $safe }
            $arguments = @($Family, 'win32')
            if ($PSBoundParameters.ContainsKey('Shard')) { $arguments += $Shard }
            $quotedArguments = ($arguments | ForEach-Object { ConvertTo-PSLiteral $_ }) -join ' '
            $body = "& 'C:\aidlc-live\tools\bun.exe' scripts/ci-live-sandbox.ts " + $quotedArguments + "`nexit `$LASTEXITCODE"
        }
    }
    $exitCode = Invoke-Isolated $Mode $safe $body -TimeoutMinutes $timeoutMinutes
    [Console]::WriteLine(('Windows isolated {0} exited {1}; collect preserves its logs.' -f $Mode, $exitCode))
    exit $exitCode
} catch {
    $failure = $_
    [Console]::Error.WriteLine(('Windows live runtime failed closed during {0} ({1}, line {2}).' -f $stage, $_.Exception.GetType().Name, $_.InvocationInfo.ScriptLineNumber))
    if ($Mode -eq 'prepare') {
        $mayRemoveRoot = $null -eq $createdUserSid
        if ($null -ne $createdUserSid) {
            try {
                $ownedUser = Get-LocalUser -Name $userName
                if ($ownedUser.SID.Value -eq $createdUserSid.Value) {
                    Stop-SandboxProcesses -Disable -AdditionalSids $codexSandboxSids
                    $mayRemoveRoot = $true
                    Remove-LocalUser -SID $createdUserSid
                }
            } catch { [Console]::Error.WriteLine('Could not remove the newly created sandbox identity; this runner must be discarded.') }
        }
        if ($createdState) {
            try { Save-PreparationFailure $failure ($createdRoot -and $mayRemoveRoot) }
            catch { [Console]::Error.WriteLine('Could not retain preparation evidence safely.') }
        }
        if ($createdRoot -and $mayRemoveRoot) {
            try { Remove-OwnedTree $root }
            catch { [Console]::Error.WriteLine('Could not remove the newly created runtime root; this runner must be discarded.') }
        }
        if ($createdState -and [IO.File]::Exists((Join-Path $stateRoot 'credential.clixml'))) {
            try { [IO.File]::Delete((Join-Path $stateRoot 'credential.clixml')) } catch { }
        }
    }
    if ($exitCode -eq 0) { $exitCode = 1 }
    exit $exitCode
} finally {
    $credential = $null
}
