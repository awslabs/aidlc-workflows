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

function Get-CodexGuiBootstrap([string[]]$ChildSids = $codexSandboxSids) {
    # CreateProcessWithLogonW does not grant access to the caller's inherited
    # station/desktop (except on Windows XP). Task Scheduler creates these
    # noninteractive objects for our low user. Run this only as that owner.
    # https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw
    $body = @'
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class AidlcCodexGuiBootstrap {
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, IntPtr data, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool GetUserObjectSecurity(IntPtr handle, ref uint sections, byte[] data, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool SetUserObjectSecurity(IntPtr handle, ref uint sections, byte[] data);
    [DllImport("advapi32.dll", SetLastError=true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, byte[] data, uint length, out uint needed);
    private static byte[] Information(IntPtr handle, int index) {
        uint needed;
        GetUserObjectInformationW(handle, index, IntPtr.Zero, 0, out needed);
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try {
            if (!GetUserObjectInformationW(handle, index, buffer, needed, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] result = new byte[needed];
            Marshal.Copy(buffer, result, 0, result.Length);
            return result;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    private static string Name(IntPtr handle) {
        return System.Text.Encoding.Unicode.GetString(Information(handle, 2)).TrimEnd('\0');
    }
    private static RawSecurityDescriptor Security(IntPtr handle) {
        uint sections = 7, needed;
        GetUserObjectSecurity(handle, ref sections, null, 0, out needed);
        byte[] bytes = new byte[needed];
        if (!GetUserObjectSecurity(handle, ref sections, bytes, needed, out needed))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return new RawSecurityDescriptor(bytes, 0);
    }
    private static void Grant(IntPtr handle, RawSecurityDescriptor security, string[] children, int rights) {
        if (security.DiscretionaryAcl == null) throw new InvalidOperationException("Missing GUI object DACL.");
        foreach (string child in children) {
            var sid = new SecurityIdentifier(child);
            for (int i = security.DiscretionaryAcl.Count - 1; i >= 0; i--) {
                var ace = security.DiscretionaryAcl[i] as CommonAce;
                if (ace == null || !ace.SecurityIdentifier.Equals(sid) || ace.AceQualifier != AceQualifier.AccessAllowed) continue;
                if (ace.AceFlags != AceFlags.None) throw new InvalidOperationException("Unexpected inherited sandbox GUI grant.");
                security.DiscretionaryAcl.RemoveAce(i);
            }
            security.DiscretionaryAcl.InsertAce(security.DiscretionaryAcl.Count,
                new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, rights, sid, false, null));
        }
        byte[] bytes = new byte[security.BinaryLength];
        security.GetBinaryForm(bytes, 0);
        uint sections = 4; // DACL only: preserve owner, group and audit rules.
        if (!SetUserObjectSecurity(handle, ref sections, bytes))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Prepare(string expectedOwner, string[] children) {
        using (var identity = WindowsIdentity.GetCurrent()) {
            if (identity.User.Value != expectedOwner || Process.GetCurrentProcess().SessionId != 0)
                throw new InvalidOperationException("Codex bootstrap requires its noninteractive low user.");
            if (children.Length < 1 || children.Length > 2) throw new InvalidOperationException("Invalid sandbox identity count.");
            foreach (string child in children) {
                var sid = new SecurityIdentifier(child);
                if (!sid.IsAccountSid() || sid.Equals(identity.User) || !sid.AccountDomainSid.Equals(identity.User.AccountDomainSid))
                    throw new InvalidOperationException("Codex bootstrap requires distinct local sandbox identities.");
            }
            byte[] statistics = new byte[56];
            uint needed;
            if (!GetTokenInformation(identity.Token, 10, statistics, (uint)statistics.Length, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            string expectedStation = "Service-0x" + BitConverter.ToUInt32(statistics, 12).ToString("x") +
                "-" + BitConverter.ToUInt32(statistics, 8).ToString("x") + "$";
            IntPtr station = GetProcessWindowStation(), desktop = GetThreadDesktop(GetCurrentThreadId());
            var stationSecurity = Security(station);
            var desktopSecurity = Security(desktop);
            // Validate both objects before either write. Never touch Winsta0,
            // an interactive session, another logon, or another user's desktop.
            if (!String.Equals(Name(station), expectedStation, StringComparison.OrdinalIgnoreCase) ||
                (BitConverter.ToUInt32(Information(station, 1), 8) & 1) != 0 || Name(desktop) != "Default" ||
                stationSecurity.Owner.Value != expectedOwner || desktopSecurity.Owner.Value != expectedOwner)
                throw new InvalidOperationException("Codex bootstrap refuses unowned or interactive GUI objects.");
            // Native DLL initialization also requires WINSTA_EXITWINDOWS.
            // This is this batch logon's noninteractive station, never the
            // operator's session. No clipboard, screen, hook/journal, desktop
            // switching, DELETE, WRITE_DAC or WRITE_OWNER rights are granted.
            Grant(station, stationSecurity, children, 0x20063);
            Grant(desktop, desktopSecurity, children, 0x20087);
        }
    }
}
"@
[AidlcCodexGuiBootstrap]::Prepare(__OWNER__, [string[]]@(__CHILDREN__))
'@
    $children = @($ChildSids | ForEach-Object { ConvertTo-PSLiteral $_ }) -join ','
    return $body.Replace('__OWNER__', (ConvertTo-PSLiteral $sandboxSid.Value)).Replace('__CHILDREN__', $children)
}

function Get-CodexHomeInitializer {
    # Executed only as the original low-user SID. Copy machine-scope DPAPI
    # artifacts, not passwords, preserving the pinned setup's access boundaries.
    # No subsequent administrator request or credential-bearing elevation exists.
    $body = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$initializerWatch = [Diagnostics.Stopwatch]::StartNew()
# Import the initializer's known Windows PowerShell dependencies without
# command discovery across PSModulePath. Use concatenation: Join-Path itself
# depends on Microsoft.PowerShell.Management being loaded.
foreach ($module in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security')) {
    Import-Module -Name ($PSHOME + '\Modules\' + $module + '\' + $module + '.psd1') -ErrorAction Stop
}
function Write-CodexInitializerPhase([string]$Phase, [int]$Entry = -1) {
    if ($env:AIDLC_CODEX_INITIALIZER_DIAGNOSTICS -ne '1') { return }
    # Fixed labels and counts only. Never print paths, ACLs, hashes or secrets.
    [Console]::Error.WriteLine((@{
        probe = 'codex-home-initializer'; phase = $Phase; entry = $Entry
        elapsedMs = $initializerWatch.ElapsedMilliseconds; pid = $PID
    } | ConvertTo-Json -Compress))
}
Write-CodexInitializerPhase 'start'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne __SID__) { throw 'Wrong Codex initializer identity.' }
Write-CodexInitializerPhase 'add-type-start'
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
Write-CodexInitializerPhase 'add-type-complete'
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
    Write-CodexInitializerPhase 'directory-validation'
    if (-not $env:CODEX_HOME -or -not $env:TEMP) { throw 'Fresh Codex home and runner temporary root are required.' }
    if ($env:CODEX_HOME -notmatch '^[A-Za-z]:[\\/]') { throw 'Codex home must be an absolute local path.' }
    $homePath = [IO.Path]::GetFullPath($env:CODEX_HOME).TrimEnd('\')
    $tempPath = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    if ($homePath -notmatch '^[A-Za-z]:\\' -or
        -not $homePath.StartsWith($tempPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Codex home is outside this test temporary root.'
    }
    Pin-Path $homePath
    Write-CodexInitializerPhase 'home-owner-validation'
    if ((Get-Acl -LiteralPath $homePath).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne __SID__) {
        throw 'Codex home is not owned by its calling user.'
    }
    $seed = __SEED__
    Write-CodexInitializerPhase 'seed-directory-validation'
    Pin-Path $seed
    Write-CodexInitializerPhase 'manifest-read'
    $manifest = Get-Content -LiteralPath (Join-Path $seed 'template.json') -Raw | ConvertFrom-Json
    $existing = [IO.Directory]::Exists((Join-Path $homePath '.sandbox'))
    $entryIndex = 0
    foreach ($entry in $manifest.entries) {
        $path = Join-Path $homePath $entry.path
        Write-CodexInitializerPhase 'acl-materialization' $entryIndex
        $acl = Access-Acl $entry
        if ($entry.directory) {
            Write-CodexInitializerPhase 'entry-directory-validation' $entryIndex
            if (-not $existing) {
                if (Test-Path -LiteralPath $path) { throw 'Refusing a partial or occupied Codex sandbox home.' }
                [void][IO.Directory]::CreateDirectory($path, $acl)
            }
            $pins.Add([AidlcCodexDirectoryPin]::Open($path))
        } else {
            Write-CodexInitializerPhase 'entry-file-validation' $entryIndex
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
            Write-CodexInitializerPhase 'hash-validation' $entryIndex
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.sha256) {
                throw 'Codex sandbox artifact differs from this provisioning generation.'
            }
        }
        Write-CodexInitializerPhase 'acl-validation' $entryIndex
        $actualAcl = Get-Acl -LiteralPath $path
        if ($actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne __SID__) {
            throw 'Codex sandbox artifact owner changed.'
        }
        $actual = Access-Signature $actualAcl
        $expected = Access-Signature $acl
        if ($actual -cne $expected) { throw 'Codex sandbox artifact access boundary changed.' }
        $entryIndex++
    }
} finally {
    for ($index = $pins.Count - 1; $index -ge 0; $index--) { $pins[$index].Dispose() }
}
Write-CodexInitializerPhase 'template-complete'
'@
    return $body.Replace('__SID__', (ConvertTo-PSLiteral $sandboxSid.Value)).Replace('__SEED__', (ConvertTo-PSLiteral $codexSeed)) +
        "`r`nWrite-CodexInitializerPhase 'gui-bootstrap-start'`r`n" + (Get-CodexGuiBootstrap) +
        "`r`nWrite-CodexInitializerPhase 'gui-bootstrap-complete'`r`nWrite-CodexInitializerPhase 'completed'`r`n"
}

function Get-CodexDesktopProcessSource {
    return @'
public static class AidlcCodexDesktopProcess {
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
    private struct Startup {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
    private static extern bool CreateProcessW(string application, System.Text.StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern IntPtr GetCurrentThread();
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool ReadFile(IntPtr handle, byte[] bytes, uint size, out uint read, IntPtr overlapped);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool WriteFile(IntPtr handle, byte[] bytes, uint size, out uint written, IntPtr overlapped);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool CancelSynchronousIo(IntPtr thread);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, byte[] info, uint length);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, byte[] info, uint length, IntPtr returned);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern uint ResumeThread(IntPtr thread);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static Exception Error(string operation) {
        return new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(), operation);
    }
    private static IntPtr Take(ref IntPtr handle) { IntPtr result = handle; handle = IntPtr.Zero; return result; }
    private static void Close(ref IntPtr handle) {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(Take(ref handle));
    }
    private static IntPtr Duplicate(IntPtr handle) {
        IntPtr result;
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) ||
            !DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), out result, 0, false, 2))
            throw Error("Duplicate owned I/O handle");
        return result;
    }
    private static uint ActiveProcesses(IntPtr job) {
        // Win64 JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, as in e2e-process.ts.
        byte[] accounting = new byte[48];
        if (!QueryInformationJobObject(job, 1, accounting, (uint)accounting.Length, IntPtr.Zero))
            throw Error("Query owned native job");
        return BitConverter.ToUInt32(accounting, 40);
    }
    private static void RetireJob(IntPtr job) {
        if (ActiveProcesses(job) != 0 && !TerminateJobObject(job, 137))
            throw Error("Retire owned native descendants");
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (ActiveProcesses(job) != 0) {
            if (watch.ElapsedMilliseconds >= 5000)
                throw new System.IO.IOException("Owned native descendants did not retire.");
            System.Threading.Thread.Sleep(10);
        }
    }
    // Each synchronous pump owns its handles. Cancellation targets its retained
    // thread HANDLE and retries across the check/read race; no PID lookup occurs.
    private sealed class Pump {
        private IntPtr source, destination, nativeThread;
        private readonly System.Threading.Thread thread;
        private readonly bool input;
        private volatile bool cancel;
        private bool started;
        public volatile Exception Failure;
        public Pump(IntPtr read, IntPtr write, bool stdin) {
            source = read; destination = write; input = stdin;
            thread = new System.Threading.Thread(Copy) { IsBackground = true };
        }
        public void Start() { thread.Start(); started = true; }
        public bool Done { get { return !started || thread.Join(0); } }
        public void Cancel() {
            cancel = true;
            IntPtr handle = System.Threading.Interlocked.CompareExchange(ref nativeThread, IntPtr.Zero, IntPtr.Zero);
            if (handle != IntPtr.Zero) CancelSynchronousIo(handle);
        }
        public bool Finish(DateTime deadline) {
            while (!Done && DateTime.UtcNow < deadline) { Cancel(); thread.Join(10); }
            if (!Done) return false; // pump retains its handles until Copy ends
            if (!started) { Close(ref source); Close(ref destination); }
            Close(ref nativeThread);
            return true;
        }
        private void Copy() {
            try {
                System.Threading.Interlocked.Exchange(ref nativeThread, Duplicate(GetCurrentThread()));
                byte[] buffer = new byte[32768];
                while (!cancel) {
                    uint read;
                    if (!ReadFile(source, buffer, (uint)buffer.Length, out read, IntPtr.Zero)) {
                        int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                        if (cancel || error == 109 || error == 38 || error == 995) break;
                        throw new System.ComponentModel.Win32Exception(error, "Read child stream");
                    }
                    if (read == 0) break;
                    uint offset = 0;
                    while (offset < read && !cancel) {
                        byte[] chunk = buffer;
                        if (offset != 0) {
                            chunk = new byte[read - offset];
                            Buffer.BlockCopy(buffer, (int)offset, chunk, 0, chunk.Length);
                        }
                        uint written;
                        if (!WriteFile(destination, chunk, read - offset, out written, IntPtr.Zero)) {
                            int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                            if (cancel || error == 995 || (input && error == 109)) return;
                            throw new System.ComponentModel.Win32Exception(error, "Write child stream");
                        }
                        if (written == 0) throw new System.IO.IOException("Child stream made no progress.");
                        offset += written;
                    }
                }
            } catch (Exception error) { if (!cancel) Failure = error; }
            finally { Close(ref source); Close(ref destination); }
        }
    }
    public static int Run(System.Diagnostics.ProcessStartInfo info, string desktop, int timeout, bool relayInput) {
        if (String.IsNullOrEmpty(desktop) || desktop.IndexOf('\\') <= 0 || desktop.IndexOf('\0') >= 0 ||
            info.FileName.IndexOf('\0') >= 0 || info.Arguments.IndexOf('\0') >= 0 || timeout < -1)
            throw new ArgumentException("Invalid explicit desktop launch.");
        IntPtr childIn = IntPtr.Zero, parentIn = IntPtr.Zero, parentOut = IntPtr.Zero, childOut = IntPtr.Zero;
        IntPtr parentError = IntPtr.Zero, childError = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        bool attributesReady = false, created = false, exited = false, assigned = false, retired = false;
        var process = new ProcessInfo();
        var pumps = new System.Collections.Generic.List<Pump>();
        Exception failure = null;
        int exitCode = 1;
        try {
            if (IntPtr.Size != 8) throw new InvalidOperationException("Native jobs require a 64-bit launcher.");
            // An unnamed, non-inheritable nested job owns only this invocation.
            // No breakaway rights: descendants must retire before pipe EOF.
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Error("Create owned native job");
            byte[] limits = new byte[144]; // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            Buffer.BlockCopy(BitConverter.GetBytes((uint)0x2000), 0, limits, 16, 4); // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, limits, (uint)limits.Length))
                throw Error("Configure owned native job");
            var security = new Security { Size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Security)), Inherit = 1 };
            if (!CreatePipe(out childIn, out parentIn, ref security, 0) ||
                !CreatePipe(out parentOut, out childOut, ref security, 0) ||
                !CreatePipe(out parentError, out childError, ref security, 0)) throw Error("Create child stdio pipes");
            foreach (IntPtr handle in new IntPtr[] { parentIn, parentOut, parentError })
                if (!SetHandleInformation(handle, 1, 0)) throw Error("Protect parent pipe inheritance");
            if (!relayInput) Close(ref parentIn); // the inert probe must never consume Codex's prompt
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == UIntPtr.Zero) throw Error("Measure stdio handle list");
            attributes = System.Runtime.InteropServices.Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw Error("Initialize stdio handle list");
            attributesReady = true;
            handles = System.Runtime.InteropServices.Marshal.AllocHGlobal(IntPtr.Size * 3);
            System.Runtime.InteropServices.Marshal.Copy(new IntPtr[] { childIn, childOut, childError }, 0, handles, 3);
            if (!UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x20002), handles, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero))
                throw Error("Set three-handle inheritance list");
            var entries = new System.Collections.Generic.List<string>();
            foreach (string key in info.EnvironmentVariables.Keys) entries.Add(key + "=" + info.EnvironmentVariables[key]);
            entries.Sort(StringComparer.OrdinalIgnoreCase);
            environment = System.Runtime.InteropServices.Marshal.StringToHGlobalUni(String.Join("\0", entries) + "\0\0");
            var startup = new StartupEx {
                Info = new Startup { Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(StartupEx)),
                    Desktop = desktop, Flags = 0x100, Input = childIn, Output = childOut, Error = childError },
                Attributes = attributes
            };
            // Filename is the sealed native path; Windows filenames cannot
            // contain quotes. Arguments were quoted by the existing bridge.
            var command = new System.Text.StringBuilder("\"" + info.FileName + "\" " + info.Arguments);
            string cwd = String.IsNullOrEmpty(info.WorkingDirectory) ? Environment.CurrentDirectory : info.WorkingDirectory;
            if (Environment.GetEnvironmentVariable("AIDLC_CODEX_GUI_DIAGNOSTICS") == "1")
                Console.WriteLine("Codex native cwd: executable=" + System.IO.Path.GetFileName(info.FileName) +
                    "; expected=" + Environment.GetEnvironmentVariable("AIDLC_CODEX_EXPECTED_CWD") + "; actual=" + cwd);
            if (!CreateProcessW(info.FileName, command, IntPtr.Zero, IntPtr.Zero, true,
                0x08000000 | 0x400 | 0x80000 | 0x4, environment, cwd, ref startup, out process)) throw Error("CreateProcessW on private desktop");
            created = true;
            // Assign while suspended so no descendant can start before ownership.
            if (!AssignProcessToJobObject(job, process.Process)) throw Error("Assign owned native job");
            assigned = true;
            if (ResumeThread(process.Thread) == UInt32.MaxValue) throw Error("Resume owned native process");
            Close(ref process.Thread);
            Close(ref childIn); Close(ref childOut); Close(ref childError);
            IntPtr outputTarget = Duplicate(GetStdHandle(-11));
            pumps.Add(new Pump(Take(ref parentOut), outputTarget, false));
            IntPtr errorTarget = Duplicate(GetStdHandle(-12));
            pumps.Add(new Pump(Take(ref parentError), errorTarget, false));
            if (relayInput) pumps.Add(new Pump(Duplicate(GetStdHandle(-10)), Take(ref parentIn), true));
            foreach (Pump pump in pumps) pump.Start();
            var watch = System.Diagnostics.Stopwatch.StartNew();
            while (true) {
                uint wait = WaitForSingleObject(process.Process, 50);
                if (wait == 0) { exited = true; break; }
                if (wait != 258) throw Error("Wait for owned native process");
                foreach (Pump pump in pumps) if (pump.Failure != null) throw pump.Failure;
                if (timeout >= 0 && watch.ElapsedMilliseconds >= timeout) throw new TimeoutException("Native desktop child exceeded its deadline.");
            }
            uint code;
            if (!GetExitCodeProcess(process.Process, out code)) throw Error("Read owned native exit status");
            exitCode = unchecked((int)code);
            if (relayInput) pumps[2].Cancel();
            // The CLI can exit while a helper still owns inherited pipe writers.
            // Retire those owned helpers, then drain all queued bytes to EOF.
            uint remainingProcesses = ActiveProcesses(job);
            RetireJob(job);
            retired = true;
            DateTime drainDeadline = DateTime.UtcNow.AddSeconds(5);
            while ((!pumps[0].Done || !pumps[1].Done) && DateTime.UtcNow < drainDeadline) System.Threading.Thread.Sleep(10);
            if (!pumps[0].Done || !pumps[1].Done) throw new System.IO.IOException(
                "Native output did not finish after process-tree retirement (exit=" + exitCode +
                "; jobProcessesAtExit=" + remainingProcesses + "; stdoutDone=" + pumps[0].Done +
                "; stderrDone=" + pumps[1].Done + ").");
            foreach (Pump pump in pumps) if (pump.Failure != null) throw pump.Failure;
        } catch (Exception error) { failure = error; }
        finally {
            if (created && !exited) {
                if (WaitForSingleObject(process.Process, 0) != 0) TerminateProcess(process.Process, 1);
                if (WaitForSingleObject(process.Process, 5000) != 0)
                    failure = new AggregateException(failure ?? new Exception("Native child failed"), new Exception("Owned native retirement was not confirmed."));
            }
            if (assigned && !retired) {
                try { RetireJob(job); retired = true; }
                catch (Exception error) { failure = new AggregateException(failure ?? new Exception("Native child failed"), error); }
            }
            foreach (Pump pump in pumps) pump.Cancel();
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            foreach (Pump pump in pumps) if (!pump.Finish(deadline))
                failure = new AggregateException(failure ?? new Exception("Native I/O failed"), new Exception("Native pipe pump retirement was not confirmed."));
            Close(ref process.Thread); Close(ref process.Process);
            Close(ref job);
            Close(ref childIn); Close(ref parentIn); Close(ref parentOut); Close(ref childOut); Close(ref parentError); Close(ref childError);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(environment);
        }
        if (failure != null) throw failure;
        return exitCode;
    }
}
'@
}

function Get-CodexHostedGuiSource {
    return @'
public static class AidlcCodexHostedGui {
    private const int ControllerStationRights = 0x2006b; // includes CREATE_DESKTOP
    private const int SandboxStationRights = 0x20063;
    private const int ControllerDesktopRights = 0x20087;
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Attributes { public int Size; public IntPtr Security; public int Inherit; }
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    private static extern bool CloseWindowStation(IntPtr station);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetProcessWindowStation();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint thread);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern void SetLastError(uint error);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    private static extern bool SetProcessWindowStation(IntPtr station);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    private static extern bool SetThreadDesktop(IntPtr desktop);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref Attributes attributes);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    private static extern bool CloseDesktop(IntPtr desktop);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    private static extern bool GetUserObjectSecurity(IntPtr handle, ref uint sections, byte[] data, uint length, out uint needed);
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
    private static extern bool SetUserObjectSecurity(IntPtr handle, ref uint sections, byte[] data);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, IntPtr data, uint length, out uint needed);
    private static Exception Error(string operation) {
        return new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(), operation);
    }
    private static System.Security.AccessControl.RawSecurityDescriptor Read(IntPtr station) {
        uint sections = 7, needed;
        GetUserObjectSecurity(station, ref sections, null, 0, out needed);
        byte[] data = new byte[needed];
        if (!GetUserObjectSecurity(station, ref sections, data, needed, out needed)) throw Error("Read WinSta0 security");
        return new System.Security.AccessControl.RawSecurityDescriptor(data, 0);
    }
    private static void RequireSessionZero() {
        if (System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
            throw new InvalidOperationException("Codex hosted GUI requires session 0.");
    }
    private static string ObjectName(IntPtr handle) {
        uint needed;
        GetUserObjectInformationW(handle, 2, IntPtr.Zero, 0, out needed);
        IntPtr buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal((int)needed);
        try {
            if (!GetUserObjectInformationW(handle, 2, buffer, needed, out needed)) throw Error("Read inherited GUI object name");
            return System.Runtime.InteropServices.Marshal.PtrToStringUni(buffer);
        } finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer); }
    }
    public static void VerifyInheritedDesktop(string controller, string expectedDesktop) {
        RequireSessionZero();
        using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) {
            if (identity.User.Value != controller || new System.Security.Principal.WindowsPrincipal(identity).IsInRole(
                System.Security.Principal.WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("GUI inheritance probe requires the prepared low controller.");
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(expectedDesktop, "^AidlcCodexController-[0-9a-f]{32}$"))
            throw new InvalidOperationException("Invalid expected private desktop.");
        string station = ObjectName(GetProcessWindowStation());
        string desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
        if (station != "WinSta0" || desktop != expectedDesktop)
            throw new InvalidOperationException("GUI inheritance mismatch: expected WinSta0\\" + expectedDesktop +
                "; observed " + station + "\\" + desktop);
        if (Environment.GetEnvironmentVariable("AIDLC_CODEX_GUI_DIAGNOSTICS") == "1")
            Console.WriteLine("Codex GUI inheritance verified: session=0; station=" + station + "; desktop=" + desktop);
    }
    public static void ValidateStationWorker(string sid, int session) {
        if (sid != "S-1-5-18" || session != 0)
            throw new InvalidOperationException("Codex station operations require SYSTEM in session 0.");
    }
    private static void RequireStationWorker() {
        using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) {
            ValidateStationWorker(identity.User.Value, System.Diagnostics.Process.GetCurrentProcess().SessionId);
        }
    }
    public static string InspectForPreparation(string trustedAdministrator) {
        RequireStationWorker();
        IntPtr station = OpenWindowStationW("WinSta0", false, 0x20002);
        if (station == IntPtr.Zero) throw Error("Open session-0 WinSta0");
        try {
            string owner = Read(station).Owner.Value;
            if (owner != "S-1-5-18" && owner != "S-1-5-32-544" && owner != trustedAdministrator)
                throw new InvalidOperationException("Untrusted WinSta0 owner.");
            return owner;
        } finally { CloseWindowStation(station); }
    }
    private static void ValidateSids(string controller, string[] children) {
        var parent = new System.Security.Principal.SecurityIdentifier(controller);
        if (!parent.IsAccountSid() || children.Length != 2 || children[0] == children[1])
            throw new InvalidOperationException("Expected three distinct prepared local identities.");
        foreach (string value in children) {
            var child = new System.Security.Principal.SecurityIdentifier(value);
            if (!child.IsAccountSid() || child.Equals(parent) || !child.AccountDomainSid.Equals(parent.AccountDomainSid))
                throw new InvalidOperationException("Unexpected sandbox identity.");
        }
    }
    // Pure descriptor operation: no native handles or writes. Validate all
    // owned entries on a copy before the administrator can publish the DACL.
    public static System.Security.AccessControl.RawSecurityDescriptor EditOwnedEntries(
        System.Security.AccessControl.RawSecurityDescriptor original, string controller, string[] children, bool remove) {
        ValidateSids(controller, children);
        if (original.DiscretionaryAcl == null) throw new InvalidOperationException("Missing station DACL.");
        byte[] originalBytes = new byte[original.BinaryLength];
        original.GetBinaryForm(originalBytes, 0);
        var security = new System.Security.AccessControl.RawSecurityDescriptor(originalBytes, 0);
        string[] values = new string[] { controller, children[0], children[1] };
        for (int target = 0; target < values.Length; target++) {
            var sid = new System.Security.Principal.SecurityIdentifier(values[target]);
            int rights = target == 0 ? ControllerStationRights : SandboxStationRights;
            for (int i = security.DiscretionaryAcl.Count - 1; i >= 0; i--) {
                var known = security.DiscretionaryAcl[i] as System.Security.AccessControl.KnownAce;
                if (known == null || !known.SecurityIdentifier.Equals(sid)) continue;
                var ace = known as System.Security.AccessControl.CommonAce;
                if (!remove || ace == null || ace.AceFlags != System.Security.AccessControl.AceFlags.None ||
                    ace.AceQualifier != System.Security.AccessControl.AceQualifier.AccessAllowed || ace.AccessMask != rights)
                    throw new InvalidOperationException("WinSta0 already contains an unexpected entry for a runtime SID.");
                security.DiscretionaryAcl.RemoveAce(i);
            }
            if (!remove) security.DiscretionaryAcl.InsertAce(security.DiscretionaryAcl.Count,
                new System.Security.AccessControl.CommonAce(System.Security.AccessControl.AceFlags.None,
                    System.Security.AccessControl.AceQualifier.AccessAllowed, rights, sid, false, null));
        }
        return security;
    }
    public static void UpdateStation(string owner, string controller, string[] children, bool remove) {
        RequireStationWorker();
        IntPtr station = OpenWindowStationW("WinSta0", false, 0x60002); // administrator READ_CONTROL/WRITE_DAC only
        if (station == IntPtr.Zero) throw Error("Open WinSta0 for owned SID cleanup/preparation");
        try {
            var security = Read(station);
            if (security.Owner.Value != owner || security.DiscretionaryAcl == null)
                throw new InvalidOperationException("WinSta0 ownership or DACL changed.");
            security = EditOwnedEntries(security, controller, children, remove);
            byte[] bytes = new byte[security.BinaryLength];
            security.GetBinaryForm(bytes, 0);
            uint sections = 4;
            if (!SetUserObjectSecurity(station, ref sections, bytes)) throw Error("Update exact WinSta0 runtime entries");
        } finally { CloseWindowStation(station); }
    }
    public static int RunOnPrivateDesktop(string owner, string controller, string[] children, Func<string, int> run) {
        RequireSessionZero();
        ValidateSids(controller, children);
        using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) {
            if (identity.User.Value != controller || new System.Security.Principal.WindowsPrincipal(identity).IsInRole(
                System.Security.Principal.WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("Codex GUI launcher requires its prepared low controller.");
        }
        int result = 1;
        Exception failure = null;
        // A new thread has no windows/hooks, as SetThreadDesktop requires.
        var thread = new System.Threading.Thread(() => {
            IntPtr originalStation = GetProcessWindowStation(), originalDesktop = GetThreadDesktop(GetCurrentThreadId());
            IntPtr station = IntPtr.Zero, desktop = IntPtr.Zero;
            bool stationChanged = false, desktopChanged = false;
            try {
                station = OpenWindowStationW("WinSta0", false, ControllerStationRights);
                if (station == IntPtr.Zero) throw Error("Open prepared WinSta0");
                if (Read(station).Owner.Value != owner) throw new InvalidOperationException("Prepared WinSta0 owner changed.");
                if (!SetProcessWindowStation(station)) throw Error("Select prepared WinSta0");
                stationChanged = true;
                string sddl = "D:P(A;;0x20087;;;" + controller + ")";
                foreach (string child in children) sddl += "(A;;0x20087;;;" + child + ")";
                var security = new System.Security.AccessControl.RawSecurityDescriptor(sddl);
                byte[] bytes = new byte[security.BinaryLength];
                security.GetBinaryForm(bytes, 0);
                var pin = System.Runtime.InteropServices.GCHandle.Alloc(bytes, System.Runtime.InteropServices.GCHandleType.Pinned);
                string desktopName = "AidlcCodexController-" + Guid.NewGuid().ToString("N");
                try {
                    var attributes = new Attributes {
                        Size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Attributes)), Security = pin.AddrOfPinnedObject()
                    };
                    SetLastError(0);
                    desktop = CreateDesktopW(desktopName,
                        IntPtr.Zero, IntPtr.Zero, 0, ControllerDesktopRights, ref attributes);
                    if (desktop == IntPtr.Zero) throw Error("Create private controller desktop");
                    if (System.Runtime.InteropServices.Marshal.GetLastWin32Error() == 183)
                        throw new InvalidOperationException("Refusing an existing controller desktop.");
                } finally { pin.Free(); }
                var actualDesktop = Read(desktop);
                if (actualDesktop.Owner.Value != controller ||
                    actualDesktop.GetSddlForm(System.Security.AccessControl.AccessControlSections.Access) !=
                    security.GetSddlForm(System.Security.AccessControl.AccessControlSections.Access))
                    throw new InvalidOperationException("Controller desktop ownership or access differs from its private policy.");
                if (!SetThreadDesktop(desktop)) throw Error("Select private controller desktop");
                desktopChanged = true;
                result = run(desktopName);
            } catch (Exception error) { failure = error; }
            finally {
                // Never open or grant access to WinSta0\\Default.
                if (stationChanged && !SetProcessWindowStation(originalStation) && failure == null)
                    failure = Error("Restore controller station");
                if (desktopChanged && !SetThreadDesktop(originalDesktop) && failure == null)
                    failure = Error("Restore controller desktop");
                if (desktop != IntPtr.Zero && !CloseDesktop(desktop) && failure == null)
                    failure = Error("Close private controller desktop");
                if (station != IntPtr.Zero && !CloseWindowStation(station) && failure == null)
                    failure = Error("Close controller station handle");
            }
        });
        thread.Start();
        thread.Join();
        if (failure != null) throw failure;
        return result;
    }
}
'@
}

function Assert-CodexHostedParent {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    $context = [ordered]@{
        githubActionsBool = ($env:GITHUB_ACTIONS -ceq 'true')
        githubHostedBool = ($env:RUNNER_ENVIRONMENT -ceq 'github-hosted')
        administratorBool = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    }
    $json = $context | ConvertTo-Json -Compress
    [Console]::WriteLine(('Codex station parent context: ' + $json))
    if ($null -ne $stateRoot -and [IO.Directory]::Exists($stateRoot)) {
        $path = Join-Path $stateRoot 'codex-parent-context.json'
        if (-not (Test-Path -LiteralPath $path)) {
            [IO.File]::WriteAllText($path, $json)
            Set-RuntimeAcl $path $null 'ReadAndExecute'
        }
    }
    if (-not $context.githubActionsBool -or -not $context.githubHostedBool -or -not $context.administratorBool) {
        throw 'Codex station preparation requires the GitHub-hosted runner administrator.'
    }
    return $context
}

function Assert-CodexStationControl([string]$Path) {
    Assert-PlainPath $Path
    $acl = Get-Acl -LiteralPath $Path
    $trusted = @($runnerSid.Value, $systemSid.Value, $adminSid.Value)
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Untrusted station control owner.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) {
            throw 'Station control is not administrator-only.'
        }
    }
    if ([IO.File]::Exists($Path)) { [AidlcFileBoundary]::RequireSingleLink($Path) }
}

function Get-CodexStationWorkerScript {
    # Two immutable scripts are generated before models: prepare and cleanup.
    # Neither accepts parameters, commands, source paths, or environment from a
    # model. The fixed assembly and authorization hashes are sealed into both.
    return @'
#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$operation = __OPERATION__
$taskRoot = __TASK_ROOT__
$receiptPath = __RECEIPT__
$runnerSid = __RUNNER_SID__
$generation = __GENERATION__
$trusted = @($runnerSid, 'S-1-5-18', 'S-1-5-32-544')
$result = [ordered]@{ generation = $generation; operation = $operation; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId; system = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ceq 'S-1-5-18'); exitCode = 1; error = $null }
$controlSafe = $false
$pins = [Collections.Generic.List[IDisposable]]::new()
function Check-Control([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked station control path.' }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Untrusted station control owner.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { throw 'Station control is not administrator-only.' }
    }
}
function Pin-Hash([string]$Path, [string]$Expected) {
    Check-Control $Path
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
    $pins.Add($stream)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    if ($actual -cne $Expected) { throw 'Station control digest mismatch.' }
    $stream.Position = 0
    return $stream
}
try {
    if (-not $result.system -or $result.sessionId -ne 0) { throw 'Station worker must be SYSTEM in session 0.' }
    if (-not [String]::Equals($PSScriptRoot, $taskRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected station worker location.' }
    Check-Control ([IO.Path]::GetDirectoryName($taskRoot))
    Check-Control $taskRoot
    Check-Control $PSCommandPath
    $controlSafe = $true
    # A SYSTEM task has its own machine environment, not the runner's process
    # environment. Explicitly discard any provider/broker credentials regardless.
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ($name -match '^(AWS_|BROKER_|AIDLC_BROKER|ANTHROPIC_|OPENAI_|GITHUB_TOKEN$|GH_TOKEN$|ACTIONS_.*TOKEN)') {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
    }
    $authorizationPath = Join-Path $taskRoot 'authorization.json'
    $authorizationStream = Pin-Hash $authorizationPath __AUTH_HASH__
    $assemblyPath = Join-Path $taskRoot 'station.dll'
    $assemblyStream = Pin-Hash $assemblyPath __ASSEMBLY_HASH__
    Add-Type -Path $assemblyPath
    [AidlcStationFileBoundary]::RequireSingleLink($authorizationStream)
    [AidlcStationFileBoundary]::RequireSingleLink($assemblyStream)
    $authorization = Get-Content -LiteralPath $authorizationPath -Raw | ConvertFrom-Json
    if ($authorization.Version -ne 1 -or $authorization.Generation -cne $generation -or
        $authorization.RunnerSid -cne $runnerSid -or -not $authorization.GitHubActions -or
        -not $authorization.GitHubHosted -or $authorization.RuntimeRoot -cne 'C:\aidlc-live' -or
        $authorization.SandboxSids.Count -ne 2) { throw 'Invalid fixed station authorization.' }
    if ($operation -eq 'prepare') {
        if (Test-Path -LiteralPath $receiptPath) { throw 'Refusing an existing station receipt.' }
        $owner = [AidlcCodexHostedGui]::InspectForPreparation($runnerSid)
        # Persist intent before the native DACL write, including its owner.
        $receipt = [ordered]@{
            Version = 1; SessionId = 0; Station = 'WinSta0'; OwnerSid = $owner
            RunnerSid = $runnerSid; ControllerSid = $authorization.ControllerSid
            SandboxSids = [string[]]$authorization.SandboxSids; RuntimeRoot = $authorization.RuntimeRoot
            Generation = $generation
        }
        $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
        Check-Control $receiptPath
        [AidlcCodexHostedGui]::UpdateStation($owner, $authorization.ControllerSid, [string[]]$authorization.SandboxSids, $false)
    } elseif ($operation -eq 'cleanup') {
        if ([IO.File]::Exists($receiptPath)) {
            Check-Control $receiptPath
            $stream = [IO.File]::Open($receiptPath, 'Open', 'Read', 'Read')
            try {
                [AidlcStationFileBoundary]::RequireSingleLink($stream)
                $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
                if ($receipt.Version -ne 1 -or $receipt.SessionId -ne 0 -or $receipt.Station -cne 'WinSta0' -or
                    $receipt.Generation -cne $generation -or $receipt.RunnerSid -cne $runnerSid -or
                    $receipt.RuntimeRoot -cne $authorization.RuntimeRoot -or
                    $receipt.ControllerSid -cne $authorization.ControllerSid -or
                    (@($receipt.SandboxSids | Sort-Object) -join ',') -cne (@($authorization.SandboxSids | Sort-Object) -join ',')) {
                    throw 'Station receipt binding mismatch.'
                }
                [AidlcCodexHostedGui]::UpdateStation($receipt.OwnerSid, $authorization.ControllerSid, [string[]]$authorization.SandboxSids, $true)
            } finally { $stream.Dispose() }
            [IO.File]::Delete($receiptPath)
        }
    } else { throw 'Unsupported station operation.' }
    $result.exitCode = 0
} catch {
    $message = $_.Exception.GetBaseException().Message
    $result.error = $message.Substring(0, [Math]::Min(1024, $message.Length))
} finally {
    for ($index = $pins.Count - 1; $index -ge 0; $index--) { $pins[$index].Dispose() }
    if ($controlSafe) {
        $result | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $taskRoot ($operation + '.result.json')) -Encoding UTF8
    }
}
exit $result.exitCode
'@
}

function New-CodexStationTaskControl($Context) {
    $taskRoot = Join-Path $stateRoot 'codex-station-task'
    New-PrivateDirectory $taskRoot
    $authorization = [ordered]@{
        Version = 1; Generation = [Guid]::NewGuid().ToString('N')
        RunnerSid = $runnerSid.Value; ControllerSid = $sandboxSid.Value
        SandboxSids = [string[]]$codexSandboxSids; RuntimeRoot = $root
        GitHubActions = [bool]$Context.githubActionsBool; GitHubHosted = [bool]$Context.githubHostedBool
        ParentSessionId = $Context.sessionId
    }
    $authorizationPath = Join-Path $taskRoot 'authorization.json'
    $authorization | ConvertTo-Json | Set-Content -LiteralPath $authorizationPath -Encoding UTF8
    $boundary = @'
public static class AidlcStationFileBoundary {
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, out Info info);
    public static void RequireSingleLink(System.IO.FileStream stream) {
        Info info;
        if (!GetFileInformationByHandle(stream.SafeFileHandle, out info))
            throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        if (info.Links != 1 || (info.Attributes & 0x400) != 0)
            throw new System.IO.IOException("Linked station control file.");
    }
}
'@
    $compilerRoot = Join-Path $taskRoot 'compiler'
    New-PrivateDirectory $compilerRoot
    $compiler = [CodeDom.Compiler.CompilerParameters]::new()
    $compiler.GenerateInMemory = $false
    $compiler.OutputAssembly = Join-Path $taskRoot 'station.dll'
    $compiler.CompilerOptions = '/platform:x64 /optimize+'
    $compiler.TempFiles = [CodeDom.Compiler.TempFileCollection]::new($compilerRoot, $false)
    [void]$compiler.ReferencedAssemblies.Add('System.dll')
    $provider = [Microsoft.CSharp.CSharpCodeProvider]::new()
    try {
        $compiled = $provider.CompileAssemblyFromSource($compiler, ("using System;`r`n" + (Get-CodexHostedGuiSource) + "`r`n" + $boundary))
        if ($compiled.Errors.HasErrors) { throw 'Could not compile the fixed station helper.' }
    } finally { $provider.Dispose(); $compiler.TempFiles.Delete() }
    $assemblyHash = (Get-FileHash -LiteralPath $compiler.OutputAssembly -Algorithm SHA256).Hash.ToLowerInvariant()
    $authorizationHash = (Get-FileHash -LiteralPath $authorizationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    foreach ($operation in @('prepare', 'cleanup')) {
        $body = (Get-CodexStationWorkerScript).Replace('__OPERATION__', (ConvertTo-PSLiteral $operation)).
            Replace('__TASK_ROOT__', (ConvertTo-PSLiteral $taskRoot)).
            Replace('__RECEIPT__', (ConvertTo-PSLiteral (Join-Path $stateRoot 'codex-station.json'))).
            Replace('__RUNNER_SID__', (ConvertTo-PSLiteral $runnerSid.Value)).
            Replace('__GENERATION__', (ConvertTo-PSLiteral $authorization.Generation)).
            Replace('__AUTH_HASH__', (ConvertTo-PSLiteral $authorizationHash)).
            Replace('__ASSEMBLY_HASH__', (ConvertTo-PSLiteral $assemblyHash))
        [IO.File]::WriteAllText((Join-Path $taskRoot ($operation + '.ps1')), $body, [Text.UTF8Encoding]::new($true))
    }
    $hashes = [ordered]@{}
    foreach ($name in @('authorization.json', 'station.dll', 'prepare.ps1', 'cleanup.ps1')) {
        $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $taskRoot $name) -Algorithm SHA256).Hash
    }
    $hashes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'hashes.json') -Encoding UTF8
    Set-RuntimeAcl $taskRoot $null 'ReadAndExecute' -Tree -RejectLinks
}

function Invoke-CodexStationTask([ValidateSet('prepare', 'cleanup')][string]$Operation) {
    [void](Assert-CodexHostedParent)
    $taskRoot = Join-Path $stateRoot 'codex-station-task'
    Assert-CodexStationControl $taskRoot
    $activePath = Join-Path $taskRoot 'active-task.json'
    if (Test-Path -LiteralPath $activePath) {
        Assert-CodexStationControl $activePath
        throw 'A previous station task was not confirmed retired; refusing another operation.'
    }
    $hashPath = Join-Path $taskRoot 'hashes.json'
    Assert-CodexStationControl $hashPath
    $hashes = Get-Content -LiteralPath $hashPath -Raw | ConvertFrom-Json
    foreach ($name in @('authorization.json', 'station.dll', 'prepare.ps1', 'cleanup.ps1')) {
        $path = Join-Path $taskRoot $name
        Assert-CodexStationControl $path
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $hashes.$name) { throw 'Station task source digest mismatch.' }
    }
    $authorization = Get-Content -LiteralPath (Join-Path $taskRoot 'authorization.json') -Raw | ConvertFrom-Json
    if ($authorization.RunnerSid -cne $runnerSid.Value -or $authorization.RuntimeRoot -cne $root) { throw 'Station authorization owner mismatch.' }
    $resultPath = Join-Path $taskRoot ($Operation + '.result.json')
    if (Test-Path -LiteralPath $resultPath) { Assert-CodexStationControl $resultPath; [IO.File]::Delete($resultPath) }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $definition = $scheduler.NewTask(0)
    $definition.Principal.UserId = 'S-1-5-18'
    $definition.Principal.LogonType = 5 # TASK_LOGON_SERVICE_ACCOUNT
    $definition.Principal.RunLevel = 1
    $definition.Settings.ExecutionTimeLimit = 'PT1M'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $action = $definition.Actions.Create(0)
    $action.Path = $powershell
    $action.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $taskRoot ($Operation + '.ps1')) + '"'
    $action.WorkingDirectory = $taskRoot
    $taskName = 'aidlc-codex-station-' + [Guid]::NewGuid().ToString('N')
    $taskAcl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;' + $runnerSid.Value + ')'
    $registered = $null
    try {
        $registered = $folder.RegisterTaskDefinition($taskName, $definition, 0x12, 'SYSTEM', $null, 5, $taskAcl)
        @{ task = $taskName; operation = $Operation; generation = $authorization.Generation } |
            ConvertTo-Json | Set-Content -LiteralPath $activePath -Encoding UTF8
        $previousRun = $registered.LastRunTime
        [void]$registered.Run($null)
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        do {
            if ($registered.LastRunTime -gt $previousRun -and $registered.GetInstances(0).Count -eq 0) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Session-0 station task exceeded its deadline.' }
            Start-Sleep -Milliseconds 200
        } while ($true)
        if (-not [IO.File]::Exists($resultPath)) { throw ('Station task returned {0} without a result.' -f $registered.LastTaskResult) }
        Assert-CodexStationControl $resultPath
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if ($result.generation -cne $authorization.Generation -or $result.operation -cne $Operation -or
            $result.sessionId -ne 0 -or $result.system -ne $true) { throw 'Untrusted station task result.' }
        [Console]::WriteLine(('Codex station task result: ' + ($result | ConvertTo-Json -Compress)))
        if ($registered.LastTaskResult -ne 0 -or $result.exitCode -ne 0) { throw 'Session-0 station operation failed.' }
    } finally {
        if ($null -ne $registered) {
            if ($registered.GetInstances(0).Count -ne 0) {
                try { $registered.Stop(0) }
                catch { if ($registered.GetInstances(0).Count -ne 0) { throw } }
            }
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while ($registered.GetInstances(0).Count -ne 0) {
                if ([DateTime]::UtcNow -ge $deadline) { throw 'Station worker retirement was not confirmed; retaining control files.' }
                Start-Sleep -Milliseconds 200
            }
            $folder.DeleteTask($taskName, 0)
            if ([IO.File]::Exists($activePath)) { [IO.File]::Delete($activePath) }
        }
    }
}

function Initialize-CodexHostedStationAccess {
    $context = Assert-CodexHostedParent
    if (-not $createdRoot -or -not $createdState -or $null -eq $createdUserSid -or
        $createdUserSid.Value -cne $sandboxSid.Value -or $codexSandboxSids.Count -ne 2) {
        throw 'Hosted GUI preparation requires this freshly created GitHub runtime.'
    }
    foreach ($sid in @($sandboxSid.Value) + $codexSandboxSids) {
        $account = Get-RecordedLocalUser ([Security.Principal.SecurityIdentifier]::new($sid))
        if ($null -eq $account -or -not $account.Enabled) { throw 'Prepared GUI identity is absent or disabled.' }
    }
    $receiptPath = Join-Path $stateRoot 'codex-station.json'
    if (Test-Path -LiteralPath $receiptPath) { throw 'Refusing an existing GUI preparation receipt.' }
    New-CodexStationTaskControl $context
    Invoke-CodexStationTask 'prepare'
    Assert-CodexStationControl $receiptPath
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    [Console]::WriteLine('Prepared exact runtime SID access to session-0 WinSta0; Default desktop unchanged.')
    return $receipt.OwnerSid
}

function Remove-CodexHostedStationAccess([string]$ControllerSid, [string[]]$SandboxSids) {
    $receiptPath = Join-Path $stateRoot 'codex-station.json'
    $taskRoot = Join-Path $stateRoot 'codex-station-task'
    if (-not [IO.Directory]::Exists($taskRoot)) {
        if ([IO.File]::Exists($receiptPath)) { throw 'Station receipt lacks its fixed task control.' }
        return
    }
    Assert-CodexStationControl $taskRoot
    if (-not [IO.File]::Exists((Join-Path $taskRoot 'hashes.json'))) {
        if ((Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath (Join-Path $taskRoot 'active-task.json'))) {
            throw 'Incomplete station control has evidence of an armed operation.'
        }
        # Compilation/sealing did not finish, so Invoke-CodexStationTask could
        # not register or start a worker. There is no station grant to undo.
        return
    }
    $authorizationPath = Join-Path $taskRoot 'authorization.json'
    Assert-CodexStationControl $authorizationPath
    $authorization = Get-Content -LiteralPath $authorizationPath -Raw | ConvertFrom-Json
    if ($authorization.RunnerSid -cne $runnerSid.Value -or $authorization.RuntimeRoot -cne $root -or
        $authorization.ControllerSid -cne $ControllerSid -or $authorization.SandboxSids.Count -ne 2 -or
        (@($authorization.SandboxSids | Sort-Object) -join ',') -cne (@($SandboxSids | Sort-Object) -join ',')) {
        throw 'Station task authorization does not match the drained identities.'
    }
    if (-not [IO.File]::Exists($receiptPath)) {
        # Preparation may have stopped before a station write or result.
        # The fixed cleanup worker decides from its own protected receipt.
        Invoke-CodexStationTask 'cleanup'
        return
    }
    Assert-PlainPath $receiptPath
    [AidlcFileBoundary]::RequireSingleLink($receiptPath)
    $acl = Get-Acl -LiteralPath $receiptPath
    $trusted = @($runnerSid.Value, $systemSid.Value, $adminSid.Value)
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Untrusted GUI receipt owner.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) {
            throw 'GUI receipt is not administrator-only.'
        }
    }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.Version -ne 1 -or $receipt.SessionId -ne 0 -or $receipt.Station -cne 'WinSta0' -or
        $receipt.RunnerSid -cne $runnerSid.Value -or $receipt.RuntimeRoot -cne $root -or
        $receipt.ControllerSid -cne $ControllerSid -or $receipt.SandboxSids.Count -ne 2 -or
        (@($receipt.SandboxSids | Sort-Object) -join ',') -cne (@($SandboxSids | Sort-Object) -join ',')) {
        throw 'GUI receipt does not belong to this retired runtime.'
    }
    # Every caller has already disabled new logons and drained these exact SIDs.
    Invoke-CodexStationTask 'cleanup'
}

function Initialize-CodexRuntime {
    [void](Assert-CodexHostedParent)
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
    # A workspace may be readable while its private ancestors cannot be stat'ed.
    # PowerShell location discovery and Bun realpath both inspect those ancestors.
    # Permit directory metadata/traversal on these exact runtime-owned containers;
    # do not grant directory listing, file contents, writes, or inherited access.
    foreach ($path in @($root, $sandboxHome, (Join-Path $sandboxHome 'temp'))) {
        Assert-PlainPath $path
        if (-not [IO.Directory]::Exists($path)) { throw 'Codex workspace ancestor is absent.' }
        $acl = Get-Acl -LiteralPath $path
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $groupSid, 'ReadAttributes, ReadExtendedAttributes, ReadPermissions, Traverse', 'None', 'None', 'Allow'))
        [IO.Directory]::SetAccessControl($path, $acl)
    }
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
    $hostedStationOwner = Initialize-CodexHostedStationAccess
    $launcher = @'
using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
__DESKTOP_PROCESS_SOURCE__
__HOSTED_GUI_SOURCE__
public static class AidlcCodexLauncher {
    private const string Native = __NATIVE__;
    private const string PackageRoot = __PACKAGE_ROOT__;
    private const string PowerShell = __POWERSHELL__;
    private const string Initializer = __INITIALIZER__;
    private const string GuiProbe = __GUI_PROBE__;
    // Hosted Windows cold initialization has completed successfully in ~45s.
    // Keep a finite deadline with room for that startup before native execution.
    private const int InitializerTimeoutMs = 60000;
    private const bool HostedGui = __HOSTED_GUI__;
    private const string StationOwner = __STATION_OWNER__;
    private const string ControllerSid = __CONTROLLER_SID__;
    private static readonly string[] SandboxSids = __SANDBOX_SIDS__;
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
    private static ProcessStartInfo StartInfo(string executable, string[] args) {
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
        return info;
    }
    private static int RunExplicit(string executable, string[] args, int timeout, string desktop, bool relayInput) {
        return AidlcCodexDesktopProcess.Run(StartInfo(executable, args), desktop, timeout, relayInput);
    }
    private static int Run(string executable, string[] args, int timeout) {
        ProcessStartInfo info = StartInfo(executable, args);
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
            if (Environment.GetEnvironmentVariable("AIDLC_CODEX_GUI_DIAGNOSTICS") == "1")
                Console.WriteLine("Codex launcher cwd: expected=" +
                    Environment.GetEnvironmentVariable("AIDLC_CODEX_EXPECTED_CWD") + "; actual=" + Environment.CurrentDirectory);
            bool version = args.Length == 1 && (args[0] == "--version" || args[0] == "-V");
            if (!version) {
                int initialized = Run(PowerShell, new string[] {
                    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", Initializer
                }, InitializerTimeoutMs);
                if (initialized != 0) return initialized;
                // The accepted Service-station initializer runs first. Bind
                // only this launcher and native Codex to the prepared station;
                // the test runner stays on its original service desktop.
                if (HostedGui) return AidlcCodexHostedGui.RunOnPrivateDesktop(
                    StationOwner, ControllerSid, SandboxSids, (desktopName) => {
                        string desktop = "WinSta0\\" + desktopName;
                        int probed = RunExplicit(GuiProbe, new string[] { desktopName }, 15000, desktop, false);
                        if (probed != 0) throw new InvalidOperationException(
                            "Codex GUI inheritance probe failed before native CLI start (exit " + probed + ").");
                        return RunExplicit(Native, args, -1, desktop, true);
                    });
            }
            return Run(Native, args, -1);
        } catch (Exception error) {
            Console.Error.WriteLine("Codex native launcher failed: " + error.Message);
            return 1;
        }
    }
}
'@
    $launcher = $launcher.Replace('__DESKTOP_PROCESS_SOURCE__', (Get-CodexDesktopProcessSource)).
        Replace('__HOSTED_GUI_SOURCE__', (Get-CodexHostedGuiSource)).
        Replace('__HOSTED_GUI__', 'true').
        Replace('__STATION_OWNER__', (ConvertTo-Json -InputObject $hostedStationOwner -Compress)).
        Replace('__CONTROLLER_SID__', (ConvertTo-Json -InputObject $sandboxSid.Value -Compress)).
        Replace('__SANDBOX_SIDS__', ('new string[] { ' + (($codexSandboxSids | ForEach-Object {
            ConvertTo-Json -InputObject $_ -Compress
        }) -join ', ') + ' }'))
    $launcher = $launcher.Replace('__NATIVE__', (ConvertTo-Json -InputObject (Join-Path $nativeDirectory 'bin\codex.exe') -Compress))
    $launcher = $launcher.Replace('__PACKAGE_ROOT__', (ConvertTo-Json -InputObject $nativeDirectory -Compress))
    $launcher = $launcher.Replace('__POWERSHELL__', (ConvertTo-Json -InputObject $powershell -Compress))
    $launcher = $launcher.Replace('__INITIALIZER__', (ConvertTo-Json -InputObject $initializer -Compress))
    $launcher = $launcher.Replace('__GUI_PROBE__', (ConvertTo-Json -InputObject (Join-Path $tools 'codex-gui-probe.exe') -Compress))
    $guiProbeSource = @'
using System;
__HOSTED_GUI_SOURCE__
public static class AidlcCodexGuiProbe {
    public static int Main(string[] args) {
        try {
            if (args.Length != 1) throw new InvalidOperationException("Expected one private desktop name.");
            AidlcCodexHostedGui.VerifyInheritedDesktop(__CONTROLLER_SID__, args[0]);
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine("Codex GUI inheritance probe: " + error.Message);
            return 1;
        }
    }
}
'@
    $guiProbeSource = $guiProbeSource.Replace('__HOSTED_GUI_SOURCE__', (Get-CodexHostedGuiSource)).
        Replace('__CONTROLLER_SID__', (ConvertTo-Json -InputObject $sandboxSid.Value -Compress))
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
        $compiler.OutputAssembly = Join-Path $tools 'codex-gui-probe.exe'
        $compiled = $provider.CompileAssemblyFromSource($compiler, $guiProbeSource)
        if ($compiled.Errors.HasErrors) { throw 'Could not compile the native GUI inheritance probe.' }
        $compiler.OutputAssembly = Join-Path $tools 'codex-capability-probe.exe'
        $entry = 'public static class Entry { public static int Main(string[] args) { return AidlcCodexCapabilityProbe.Run(args); } }'
        $compiled = $provider.CompileAssemblyFromSource($compiler, ((Get-CodexCapabilityProbeSource) + $entry))
        if ($compiled.Errors.HasErrors) { throw 'Could not compile the native sandbox capability probe.' }
    } finally { $provider.Dispose(); $compiler.TempFiles.Delete() }
    foreach ($name in @('codex-initialize-home.ps1', 'codex-managed.exe', 'codex-gui-probe.exe', 'codex-capability-probe.exe')) {
        Set-RuntimeAcl (Join-Path $tools $name) $sandboxSid 'ReadAndExecute' -RejectLinks
    }
    # Only executable inputs, never tools/jobs or tools/logs (which can contain
    # the original low user's credential-bearing launch environment).
    $readable = @($tools, (Join-Path $tools 'bun.exe'), (Join-Path $tools 'node.exe'), (Join-Path $tools 'codex-capability-probe.exe'), $nativeDirectory) +
        @([IO.Directory]::GetDirectories($nativeDirectory, '*', [IO.SearchOption]::AllDirectories)) +
        @([IO.Directory]::GetFiles($nativeDirectory, '*', [IO.SearchOption]::AllDirectories))
    foreach ($path in $readable) {
        $acl = Get-Acl -LiteralPath $path
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($groupSid, 'ReadAndExecute', 'None', 'None', 'Allow'))
        if ([IO.Directory]::Exists($path)) { [IO.Directory]::SetAccessControl($path, $acl) }
        else { [IO.File]::SetAccessControl($path, $acl) }
    }
}

function Get-CodexCapabilityProbeSource {
    return @'
public static class AidlcCodexCapabilityProbe {
    private static string Json(string value) {
        var text = new System.Text.StringBuilder("\"");
        foreach (char c in value) {
            if (c == '\\' || c == '"') text.Append('\\').Append(c);
            else if (c < 32) text.Append("\\u").Append(((int)c).ToString("x4"));
            else text.Append(c);
        }
        return text.Append('"').ToString();
    }
    public static int Run(string[] args) {
        try {
            if (args.Length != 7) throw new System.InvalidOperationException("Expected seven capability arguments.");
            string expectedSid = args[0], secret = args[1], forbidden = args[2], literal = args[3];
            string expectedProject = args[4], marker = args[5], token = args[6];
            using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) {
                if (identity.User.Value != expectedSid)
                    throw new System.InvalidOperationException("Wrong native sandbox identity.");
                if (new System.Security.Principal.WindowsPrincipal(identity).IsInRole(
                    System.Security.Principal.WindowsBuiltInRole.Administrator))
                    throw new System.InvalidOperationException("Native sandbox identity is an administrator.");
                if (literal != "space \"quoted\" & symbols \\tail\\")
                    throw new System.InvalidOperationException("Native launcher changed an argument.");
                string cwd = System.Environment.CurrentDirectory;
                System.Console.WriteLine("{\"probe\":\"codex-native-capability-cwd\",\"expectedProject\":" +
                    Json(expectedProject) + ",\"osCwd\":" + Json(cwd) + ",\"sid\":" + Json(identity.User.Value) + "}");
                if (marker != ".aidlc-cwd-" + token ||
                    !System.Text.RegularExpressions.Regex.IsMatch(token, "^[0-9a-f]{32}$"))
                    throw new System.InvalidOperationException("Invalid cwd proof marker.");
                // A vendor-created junction may identify the same project.
                // Verify the actual OS cwd without changing it or any shell state.
                foreach (string directory in new string[] { expectedProject, cwd }) {
                    if (!System.IO.Path.IsPathRooted(directory) ||
                        !System.IO.File.Exists(System.IO.Path.Combine(directory, marker)) ||
                        System.IO.File.ReadAllText(System.IO.Path.Combine(directory, marker)) != token)
                        throw new System.InvalidOperationException("Native sandbox cwd does not identify the expected project.");
                }
                System.IO.File.WriteAllText(System.IO.Path.Combine(cwd, "workspace-write.txt"), "workspace-write verified");
                bool denied = false;
                try { using (System.IO.File.OpenRead(secret)) {} }
                catch (System.UnauthorizedAccessException) { denied = true; }
                if (!denied) throw new System.InvalidOperationException("Native sandbox can read its credential store.");
                denied = false;
                try { System.IO.File.WriteAllText(forbidden, "must not be written"); }
                catch (System.UnauthorizedAccessException) { denied = true; }
                if (!denied) throw new System.InvalidOperationException("Native sandbox can write outside its workspace.");
            }
            System.Console.WriteLine("Codex native identity, workspace write, secret denial and protected-tool denial verified.");
            return 0;
        } catch (System.Exception error) {
            System.Console.Error.WriteLine("Codex native capability probe: " + error.GetType().FullName + ": " + error.Message);
            return 1;
        }
    }
}
'@
}

function Get-CodexShellReadinessSource {
    return @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'shell-proof.json') | ConvertFrom-Json
$providerMarker = Join-Path (Get-Location).ProviderPath $config.marker
if (-not [IO.File]::Exists($providerMarker) -or [IO.File]::ReadAllText($providerMarker) -cne $config.token) {
    throw 'Native PowerShell location does not identify the expected project.'
}
& $config.probe $config.sid $config.secret $config.forbidden 'space "quoted" & symbols \tail\' $config.project $config.marker $config.token
if ($LASTEXITCODE -ne 0) { throw 'Native command capability proof failed.' }
# Relative script lookup exercises the same shell -> Bun route as model tools.
& $config.bun '.\path-proof.cjs' $config.project $config.marker $config.token
if ($LASTEXITCODE -ne 0) { throw 'Native Bun project canonicalization failed.' }
[Console]::WriteLine('Codex PowerShell location and Bun realpath verified.')
'@
}

function Get-CodexReadinessBody([string]$ProofRoot) {
    # Actual native sandbox commands, not a model or provider probe. Exercise
    # both machine accounts through distinct fresh CODEX_HOMEs, then retain
    # the encrypted metadata only until the administrator drains those SIDs.
    $body = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$native = __NATIVE__
$bun = __BUN__
$env:CODEX_MANAGED_PACKAGE_ROOT = __PACKAGE_ROOT__
$env:AIDLC_CODEX_GUI_DIAGNOSTICS = '1'
$env:AIDLC_CODEX_INITIALIZER_DIAGNOSTICS = '1'
$expectedSids = __SIDS__
$initializer = __INITIALIZER__
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$commandShell = __COMMAND_SHELL__
function Invoke-ReadinessInitializer {
    $previousPreference = $ErrorActionPreference
    $nativeExit = $null
    try {
        # Credential-free readiness may relay fixed stderr phase diagnostics on
        # stdout. PS5.1 must not mistake those diagnostics for a command failure.
        $ErrorActionPreference = 'Continue'
        # Native commands update the global automatic variable. A local sentinel
        # shadows that update and falsely rejects even an initializer that exits 0.
        $global:LASTEXITCODE = $null
        & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $initializer 2>&1 |
            ForEach-Object { [Console]::WriteLine([string]$_) }
        $nativeExit = $global:LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($null -eq $nativeExit -or $nativeExit -ne 0) { throw 'Fresh Codex home initialization failed.' }
}
# Create the actual temporary root as the live user, as the test runner does.
# Assigning another user's ownership from the administrator requires a restore
# privilege that hosted runner tokens do not necessarily enable.
$ownedTemp = __PROOF_ROOT__
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
    $cwdToken = [Guid]::NewGuid().ToString('N')
    $cwdMarker = '.aidlc-cwd-' + $cwdToken
    [IO.File]::WriteAllText((Join-Path $project $cwdMarker), $cwdToken)
    [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME 'config.toml'), "[windows]`nsandbox = `"elevated`"`n")
    Invoke-ReadinessInitializer
    # No secret data is printed. The caller confirms existence; the sandboxed
    # command must prove access denial, not mistake a missing file for a deny.
    $secretPath = Join-Path $env:CODEX_HOME '.sandbox-secrets\sandbox_users.json'
    if (-not [IO.File]::Exists($secretPath)) { throw 'Fresh Codex sandbox credential file is absent.' }
    $probe = __CAPABILITY_PROBE__
    $shellProbe = Join-Path $project 'shell-proof.ps1'
    [IO.File]::WriteAllText($shellProbe, __SHELL_SOURCE__)
    @{
        project = $project; probe = $probe; sid = $expectedSids[$index]
        secret = $secretPath; forbidden = __FORBIDDEN__; bun = $bun
        marker = $cwdMarker; token = $cwdToken
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $project 'shell-proof.json') -Encoding UTF8
    [IO.File]::WriteAllText((Join-Path $project 'path-proof.cjs'), @"
const {realpathSync, readFileSync, lstatSync} = require("node:fs");
const {join, dirname} = require("node:path");
const [project, marker, token] = process.argv.slice(2);
if (realpathSync(process.cwd()).toLowerCase() !== realpathSync(project).toLowerCase()) {
  throw Error("Bun sandbox cwd does not identify the expected project");
}
for (let path = project; ; path = dirname(path)) {
  if (!lstatSync(path).isDirectory()) throw Error("Project ancestor is not a directory");
  if (dirname(path) === path) break;
}
if (readFileSync(join(project, marker), "utf8") !== token) throw Error("Wrong Bun project marker");
console.log("Bun sandbox project and ancestor metadata verified.");
"@)
    $invoke = Join-Path $project 'invoke.cjs'
    [IO.File]::WriteAllText($invoke, @"
const {spawnSync} = require("node:child_process");
const {writeSync, realpathSync} = require("node:fs");
const [launcher, shell, shellProbe, project, network] = process.argv.slice(2);
const callerCwd = process.cwd();
writeSync(1, JSON.stringify({probe:"codex-caller-cwd",expectedProject:project,callerCwd}) + "\n");
if (realpathSync.native(callerCwd).toLowerCase() !== realpathSync.native(project).toLowerCase()) {
  throw Error("Bun caller cwd does not identify the expected project");
}
const args = ["-c", "sandbox_mode=workspace-write", "-c", "windows.sandbox=elevated",
  "-c", "sandbox_workspace_write.network_access=" + network, "sandbox", "--",
  shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", shellProbe];
const result = spawnSync(launcher, args, {cwd:project,
  env:{...process.env,AIDLC_CODEX_EXPECTED_CWD:project},encoding:"utf8", stdio:["ignore","pipe","pipe"], timeout:90000});
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
    [Console]::WriteLine((@{probe='codex-parent-cwd'; expectedProject=$project; providerCwd=(Get-Location).Path; osCwd=[Environment]::CurrentDirectory} | ConvertTo-Json -Compress))
    & $bun $invoke $native $commandShell $shellProbe $project $network
    if ($LASTEXITCODE -ne 0) { throw 'Fresh-home elevated sandbox readiness command failed.' }
    if (-not [IO.File]::Exists((Join-Path $project 'workspace-write.txt'))) { throw 'Native workspace write was not observed.' }
    # Resume-style reentry must validate the same generation without resetting
    # global account passwords or overwriting the test's own config.
    Invoke-ReadinessInitializer
    $index++
}
[Console]::WriteLine('Codex elevated provisioning verified in two fresh low-user homes.')
'@
    $nativeDirectory = Get-VerifiedCodexDirectory
    $native = Join-Path $tools 'codex-managed.exe'
    $body = $body.Replace('__NATIVE__', (ConvertTo-PSLiteral $native))
    $body = $body.Replace('__BUN__', (ConvertTo-PSLiteral (Join-Path $tools 'bun.exe')))
    $body = $body.Replace('__CAPABILITY_PROBE__', (ConvertTo-PSLiteral (Join-Path $tools 'codex-capability-probe.exe')))
    $body = $body.Replace('__PACKAGE_ROOT__', (ConvertTo-PSLiteral $nativeDirectory))
    $body = $body.Replace('__INITIALIZER__', (ConvertTo-PSLiteral (Join-Path $tools 'codex-initialize-home.ps1')))
    $body = $body.Replace('__PROOF_ROOT__', (ConvertTo-PSLiteral $ProofRoot))
    $body = $body.Replace('__COMMAND_SHELL__', (ConvertTo-PSLiteral (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe')))
    $body = $body.Replace('__SHELL_SOURCE__', (ConvertTo-PSLiteral (Get-CodexShellReadinessSource)))
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
        $diagnostics = @(
            (Join-Path $stateRoot 'codex-parent-context.json'),
            (Join-Path $stateRoot 'codex-setup.stdout.log'), (Join-Path $stateRoot 'codex-setup.stderr.log'),
            (Join-Path $stateRoot 'codex-station-task\prepare.result.json'),
            (Join-Path $stateRoot 'codex-station-task\cleanup.result.json')
        )
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
        Remove-CodexHostedStationAccess $script:sandboxSid.Value $codexSandboxSids
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
        foreach ($path in @('tmp', 'temp', 'AppData\Roaming', 'AppData\Local', 'npm-cache')) {
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
            # Use the same private ancestor chain as the real test fixtures.
            # The live identity creates/owns the leaf inside Get-CodexReadinessBody.
            $proofRoot = Join-Path (Join-Path $sandboxHome 'temp') ('codex-readiness-' + [Guid]::NewGuid().ToString('N'))
            $proofEnvironment = Get-SafeEnvironment
            $proofEnvironment.TEMP = Join-Path $sandboxHome 'temp'
            $proofEnvironment.TMP = $proofEnvironment.TEMP
            $proofEnvironment.TMPDIR = $proofEnvironment.TEMP
            $exitCode = Invoke-Isolated 'codex-sandbox-proof' $proofEnvironment (Get-CodexReadinessBody $proofRoot) -TimeoutMinutes 3
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
        Remove-CodexHostedStationAccess $sandboxSid.Value $codexSandboxSids
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
                    Remove-CodexHostedStationAccess $createdUserSid.Value $codexSandboxSids
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
