#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidateSet('prepare', 'prove', 'run', 'smoke', 'collect')]
    [string]$Mode = 'prepare',
    [ValidateSet('claude-sdk', 'claude-tui', 'codex', 'opencode', 'release-contract', 'isolation')]
    [string]$Family = 'isolation'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# DirectorySecurity creation overloads below intentionally use .NET Framework.
# Hosted workflows may default to pwsh; re-enter the native Windows PS5.1 host.
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $nativeArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Mode', $Mode)
    if ($PSBoundParameters.ContainsKey('Family')) { $nativeArguments += @('-Family', $Family) }
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
$exitCode = 1
$stage = $Mode
$stateRoot = $null
$git = 'C:\Program Files\Git\cmd\git.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$livePath = "$tools;$tools\npm;C:\Program Files\Git\cmd;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"

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
    return [ordered]@{
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
    $path = Join-Path $tools ('launch-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("Set-StrictMode -Version Latest`n`$ErrorActionPreference = 'Stop'")
    $lines.Add(@'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Inspect the raw alternate-logon environment before clearing even machine defaults.
foreach ($key in [Environment]::GetEnvironmentVariables('Process').Keys) {
    if ($key -match '^(ACTIONS_|AWS_|BROKER_|GH_TOKEN$|GITHUB_TOKEN$|ANTHROPIC_API_KEY$|OPENAI_API_KEY$|KIRO_API_KEY$|CURSOR_API_KEY$)') {
        [Console]::Error.WriteLine('Alternate logon inherited a forbidden environment variable.')
        exit 1
    }
}
foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    [Environment]::SetEnvironmentVariable($key, $null, 'Process')
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

function Invoke-Isolated([string]$Label, $Environment, [string]$Body) {
    $script:stage = $Label
    $wrapper = New-LaunchScript $Environment $Body
    $id = $Label + '-' + [Guid]::NewGuid().ToString('N')
    $logRoot = Join-Path $tools 'logs'
    $stdout = Join-Path $logRoot ($id + '.stdout.log')
    $stderr = Join-Path $logRoot ($id + '.stderr.log')
    # -ArgumentList is joined by Start-Process; quote the complete -File path once.
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $wrapper + '"'
    $childExit = -1
    try {
        $process = Start-Process -FilePath $powershell -ArgumentList $arguments -Credential $credential `
            -UseNewEnvironment -WorkingDirectory $work -Wait -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $process.Refresh()
        if ($null -eq $process.ExitCode) { throw 'Alternate-logon process did not report an exit code.' }
        $childExit = [int]$process.ExitCode
        $script:exitCode = $childExit
        if ($childExit -ne 0) { throw "Isolated $Label exited $childExit" }
        return $childExit
    } catch {
        if ($childExit -eq -1) {
            [IO.File]::AppendAllText($stderr, ($_.Exception.ToString() + "`r`n"))
        }
        [Console]::Error.WriteLine(('Isolated {0} exit code: {1}' -f $Label, $childExit))
        # Tool output remains untrusted even on failures: sanitize before printing.
        & (Join-Path $tools 'bun.exe') (Join-Path $env:GITHUB_WORKSPACE 'scripts\ci-sanitize-logs.ts') $logRoot
        if ($LASTEXITCODE -eq 0) {
            $marker = 'aidlc-diagnostics-' + [Guid]::NewGuid().ToString('N')
            [Console]::WriteLine(('::stop-commands::{0}' -f $marker))
            foreach ($log in @($stdout, $stderr)) {
                [Console]::WriteLine(('--- last 40 lines: {0} ---' -f [IO.Path]::GetFileName($log)))
                if ([IO.File]::Exists($log)) {
                    Get-Content -LiteralPath $log -Encoding UTF8 -Tail 40 | ForEach-Object { [Console]::WriteLine([string]$_) }
                } else { [Console]::WriteLine('No retained UTF-8 text output.') }
            }
            [Console]::WriteLine(('::{0}::' -f $marker))
        } else { [Console]::Error.WriteLine('Child output sanitization failed; diagnostic text withheld.') }
        throw
    } finally {
        # These are runner-created read-only files, not sandbox-authored paths.
        if ([IO.File]::Exists($wrapper)) { [IO.File]::Delete($wrapper) }
    }
}

function Stop-SandboxProcesses([switch]$Disable) {
    # Collection disables new logons; preparation only drains finished installers.
    if ($Disable) { Disable-LocalUser -SID $sandboxSid }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $found = $false
        foreach ($process in Get-CimInstance Win32_Process) {
            try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop }
            catch {
                if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw }
                continue
            }
            if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sandboxSid.Value) {
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

function Get-ProofBody {
    $paths = @($state.RunnerHome, $state.RunnerTemp, $state.Workspace)
    $files = @((Join-Path $stateRoot 'credential.clixml'), (Join-Path $state.Workspace 'scripts\ci-live-sandbox.ts'))
    if ($env:GITHUB_ENV) { $files += $env:GITHUB_ENV }
    $body = @'
$expected = __SID__
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $expected) { throw 'Wrong process identity.' }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
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
$launcher = [Diagnostics.Process]::GetProcessById(__PID__)
$denied = $false
try { $modules = $launcher.Modules; if ($null -eq $modules -or $modules.Count -eq 0) { throw 'No module evidence.' } }
catch {
    if (-not (Test-AccessDenied $_ -Win32)) { throw }
    $denied = $true
}
if (-not $denied) { throw 'Sandbox can enumerate launcher modules.' }
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
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory=C:/aidlc-live/work -C 'C:\aidlc-live\work' rev-parse --is-inside-work-tree
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$configProbe = [IO.File]::Open((Join-Path $env:HOME '.gitconfig'), 'Open', 'ReadWrite', 'Read')
$configProbe.Dispose()
[Console]::WriteLine('Separate-user Windows isolation verified: identity, environment, files, modules, PROCESS_VM_READ.')
exit 0
'@
    $directoryLiterals = @($paths | ForEach-Object { ConvertTo-PSLiteral $_ }) -join ', '
    $fileLiterals = @($files | ForEach-Object { ConvertTo-PSLiteral $_ }) -join ', '
    return $body.Replace('__SID__', (ConvertTo-PSLiteral $sandboxSid.Value)).Replace('__DIRECTORIES__', ('@(' + $directoryLiterals + ')')).Replace('__FILES__', ('@(' + $fileLiterals + ')')).Replace('__PID__', [string]$PID)
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
        $stage = 'copying checkout'
        # No .git auth config, user config, reparse targets, or credential files cross.
        Copy-PlainTree $workspace $work -Checkout
        $stage = 'copying tools'
        foreach ($name in @('bun.exe', 'node.exe')) {
            $source = (Get-Command $name -CommandType Application -ErrorAction Stop).Source
            Assert-PlainPath $source
            [IO.File]::Copy($source, (Join-Path $tools $name), $false)
        }
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
        & icacls.exe $work /setowner ($env:COMPUTERNAME + '\' + $userName) /T /C /Q
        if ($LASTEXITCODE -ne 0) { throw 'Cannot transfer sandbox worktree ownership.' }
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
        $exitCode = Invoke-Isolated 'git-init' $safe $gitBody
        if ($exitCode -ne 0) { throw 'Isolated source snapshot failed.' }
        if ($package) {
            # Installer code runs without runner authority, even before AWS setup.
            Set-RuntimeAcl (Join-Path $tools 'npm') $sandboxSid 'Modify'
            $installBody = "& 'C:\aidlc-live\tools\node.exe' 'C:\aidlc-live\tools\npm-cli\bin\npm-cli.js' install --global --prefix 'C:\aidlc-live\tools\npm' --no-audit --no-fund " + (ConvertTo-PSLiteral $package) + "`nexit `$LASTEXITCODE"
            $exitCode = Invoke-Isolated 'npm-install' $safe $installBody
            if ($exitCode -ne 0) { throw 'Pinned isolated CLI installation failed.' }
            Stop-SandboxProcesses
            Set-RuntimeAcl $tools $sandboxSid 'ReadAndExecute' -Tree -RejectLinks
        }
        $exitCode = Invoke-Isolated 'prepare-proof' $safe (Get-ProofBody)
        Stop-SandboxProcesses
        if ($exitCode -ne 0) { throw 'Windows isolation proof failed.' }
        [Console]::WriteLine('Prepared the separate-user Windows live runtime.')
        exit 0
    }

    Assert-PlainPath $stateFile
    Assert-PlainPath $credentialFile
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($state.Version -ne 1 -or $state.RunnerSid -ne $runnerSid.Value -or
        $state.Workspace -ne $workspace -or $state.RunnerHome -ne $runnerHome -or $state.RunnerTemp -ne $runnerTemp) {
        throw 'Runtime state does not belong to this runner.'
    }
    $user = Get-LocalUser -Name $userName
    if ($user.SID.Value -ne $state.SandboxSid) { throw 'Runtime identity no longer matches its owner record.' }
    $sandboxSid = $user.SID
    if ($PSBoundParameters.ContainsKey('Family') -and $Family -ne $state.Family) { throw 'Runtime was prepared for another family.' }
    $Family = $state.Family
    if ($Mode -eq 'collect') {
        Stop-SandboxProcesses -Disable
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
        foreach ($log in [IO.Directory]::EnumerateFiles((Join-Path $tools 'logs'), '*.log')) {
            Assert-PlainPath $log
            [IO.File]::Copy($log, (Join-Path $launchLogs ([IO.Path]::GetFileName($log))), $false)
        }
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
    switch ($Mode) {
        'prove' { $body = Get-ProofBody }
        'smoke' { $body = "& 'C:\aidlc-live\tools\bun.exe' tests/run-tests.ts --smoke --filter '^t01'`nexit `$LASTEXITCODE" }
        'run' {
            if ($Family -eq 'isolation') { throw 'Choose a live family when preparing a live run.' }
            if ($Family -ne 'release-contract') { Add-BrokerEnvironment $safe }
            $body = "& 'C:\aidlc-live\tools\bun.exe' scripts/ci-live-sandbox.ts " + (ConvertTo-PSLiteral $Family) + " win32`nexit `$LASTEXITCODE"
        }
    }
    $exitCode = Invoke-Isolated $Mode $safe $body
    [Console]::WriteLine(('Windows isolated {0} exited {1}; collect preserves its logs.' -f $Mode, $exitCode))
    exit $exitCode
} catch {
    [Console]::Error.WriteLine(('Windows live runtime failed closed during {0} ({1}, line {2}).' -f $stage, $_.Exception.GetType().Name, $_.InvocationInfo.ScriptLineNumber))
    if ($Mode -eq 'prepare') {
        $mayRemoveRoot = $null -eq $createdUserSid
        if ($null -ne $createdUserSid) {
            try {
                $ownedUser = Get-LocalUser -Name $userName
                if ($ownedUser.SID.Value -eq $createdUserSid.Value) {
                    Stop-SandboxProcesses -Disable
                    $mayRemoveRoot = $true
                    Remove-LocalUser -SID $createdUserSid
                }
            } catch { [Console]::Error.WriteLine('Could not remove the newly created sandbox identity; this runner must be discarded.') }
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
