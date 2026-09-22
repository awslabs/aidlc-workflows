#requires -Version 5.1
#requires -RunAsAdministrator
param([string]$SourceRoot, [string]$FixtureRoot, [string]$BunPath,
    [ValidateSet('seal', 'failure-collect', 'poisoned-collect', 'deny')][string]$Case,
    [ValidateSet('run', 'cleanup')][string]$Mode = 'run', [Parameter(Mandatory)][Guid]$FixtureId)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Check([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }

function Remove-FixtureProfile([Security.Principal.SecurityIdentifier]$Sid) {
    Check ($Sid.Value -eq $createdUserSid.Value -and $Sid.Value -ne $runnerSid.Value) 'Refusing profile cleanup outside the fixture SID.'
    # Run only after the provisioning PowerShell client exits. Loaded is
    # diagnostic status; let Windows reject a profile that is actually in use.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $lastFailure = 'profile deletion has not completed'
    $attempts = 0
    $firstLoaded = $null
    do {
        $profile = Get-CimInstance Win32_UserProfile -Filter ("SID='" + $Sid.Value + "'")
        if ($null -eq $profile) {
            return @{ removed = $true; deleteAttempts = $attempts; firstLoaded = $firstLoaded }
        }
        Check (-not $profile.Special) 'Refusing to remove a special system profile.'
        if ($null -eq $firstLoaded) { $firstLoaded = [bool]$profile.Loaded }
        $attempts++
        try {
            $profile | Remove-CimInstance -ErrorAction Stop
            if ($null -eq (Get-CimInstance Win32_UserProfile -Filter ("SID='" + $Sid.Value + "'"))) {
                return @{ removed = $true; deleteAttempts = $attempts; firstLoaded = $firstLoaded }
            }
        } catch {
            if ($_.FullyQualifiedErrorId -notmatch '\b0x800700(?:20|21)\b') { throw }
            $lastFailure = $_.Exception.Message
            if ($env:GITHUB_ACTIONS -ceq 'true' -and $env:RUNNER_ENVIRONMENT -ceq 'github-hosted') {
                # The account and every process using its SID are already gone.
                # Windows services can retain the hive until this disposable VM
                # exits. Report that residual honestly; never waive live identity
                # retirement or use this path on persistent developer hosts.
                return @{
                    removed = $false; deferredToHostDisposal = $true
                    reason = 'profile-service-sharing-lock'
                    deleteAttempts = $attempts; firstLoaded = $firstLoaded
                }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw ("Fixture profile cleanup timed out for SID {0}: {1}" -f $Sid.Value, $lastFailure)
}

# Load the actual production functions and native boundary checks without
# executing main's fixed C:\aidlc-live/user/profile setup on a developer host.
$source = Join-Path $SourceRoot '.github\scripts\prepare-live-runtime.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
Check ($errors.Count -eq 0) 'Production PowerShell did not parse.'
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
        Invoke-Expression $statement.Extent.Text
    } elseif ($statement -is [Management.Automation.Language.PipelineAst] -and
        $statement.PipelineElements[0] -is [Management.Automation.Language.CommandAst] -and
        $statement.PipelineElements[0].GetCommandName() -eq 'Add-Type') {
        Invoke-Expression $statement.Extent.Text
    }
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class AidlcFixtureAccountCleanup {
    [StructLayout(LayoutKind.Sequential)]
    private struct Attributes {
        public uint Length;
        public IntPtr Root, Name;
        public uint Flags;
        public IntPtr Descriptor, Quality;
    }
    [DllImport("advapi32.dll")] private static extern uint LsaOpenPolicy(IntPtr name, ref Attributes attrs, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")] private static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool all, IntPtr rights, uint count);
    [DllImport("advapi32.dll")] private static extern uint LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll")] private static extern uint LsaClose(IntPtr policy);
    public static void RemoveRights(string value) {
        SecurityIdentifier sid = new SecurityIdentifier(value);
        byte[] bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        Attributes attrs = new Attributes();
        attrs.Length = (uint)Marshal.SizeOf(typeof(Attributes));
        IntPtr policy;
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x800, out policy);
        if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        try {
            status = LsaRemoveAccountRights(policy, bytes, true, IntPtr.Zero, 0);
            if (status != 0 && status != 0xC0000034) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        } finally { LsaClose(policy); }
    }
}
'@

$runnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$receiptRoot = Join-Path $FixtureRoot 'trusted-teardown'
$receiptPath = Join-Path $receiptRoot 'identity.json'

function Save-FixtureIdentity {
    $identityReceipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
}

if ($Mode -eq 'cleanup') {
    # No account provisioning in this mode. Only an administrator-owned receipt
    # from the just-exited fixture can authorize deletion of its exact SID.
    foreach ($path in @($receiptRoot, $receiptPath)) {
        Assert-PlainPath $path
        $acl = Get-Acl -LiteralPath $path
        $trusted = @($runnerSid.Value, $systemSid.Value, $adminSid.Value)
        Check ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $trusted) 'Untrusted fixture receipt owner.'
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow') {
                Check ($rule.IdentityReference.Value -in $trusted) 'Fixture receipt is not administrator-only.'
            }
        }
    }
    [AidlcFileBoundary]::RequireSingleLink($receiptPath)
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    Check ($receipt.fixtureId -ceq $FixtureId.ToString() -and
        $receipt.fixtureRoot -ceq [IO.Path]::GetFullPath($FixtureRoot) -and
        $receipt.case -ceq $Case -and $receipt.runnerSid -ceq $runnerSid.Value) 'Fixture receipt binding mismatch.'
    Check ($receipt.userName -cmatch '^aidlc-pv-[0-9a-f]{8}$' -and
        $receipt.processesDrained -eq $true -and $receipt.accountRemoved -eq $true) 'Fixture account teardown did not complete.'
    $createdUserSid = [Security.Principal.SecurityIdentifier]::new($receipt.createdUserSid)
    Check ($null -eq (Get-RecordedLocalUser $createdUserSid)) 'Fixture account still exists.'
    foreach ($process in Get-CimInstance Win32_Process) {
        try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop }
        catch {
            if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw }
            continue
        }
        Check (-not ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $createdUserSid.Value)) 'Fixture still has a live process.'
    }
    $cleanup = Remove-FixtureProfile $createdUserSid
    $cleanup['fixtureId'] = $FixtureId.ToString()
    $cleanup | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $receiptRoot 'cleanup.json') -Encoding UTF8
    exit 0
}

$root = Join-Path $FixtureRoot 'runtime'
$work = Join-Path $root 'work'
$sandboxHome = Join-Path $root 'home'
$tools = Join-Path $root 'tools'
$workspace = Join-Path $FixtureRoot 'runner-workspace'
$runnerTemp = Join-Path $FixtureRoot 'runner-temp'
$runnerHome = Join-Path $FixtureRoot 'runner-home'
$stateRoot = Join-Path $runnerTemp 'aidlc-live-runtime'
$userName = 'aidlc-pv-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$sandboxSid = $null
$createdUserSid = $null
$credential = $null
$Family = 'isolation'
$stage = 'fixture'
$exitCode = 0
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$livePath = "$tools;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$node = (Get-Command node.exe -CommandType Application).Source
$bun = $BunPath
Check ([IO.File]::Exists($bun)) 'The test runner must supply its existing Bun executable.'
$secret = 'runner-only-fixture-sentinel'
$deniedLink = Join-Path $tools 'npm\protected-link'
$junction = Join-Path $tools 'npm\linked-directory'
$poisonedLog = Join-Path $tools 'logs\linked.log'
$result = [ordered]@{ case = $Case }
$fixtureFailure = $null
$identityReceipt = $null

try {
    Set-RuntimeAcl $FixtureRoot $null 'ReadAndExecute'
    New-PrivateDirectory $receiptRoot
    foreach ($path in @($root, $work, $sandboxHome, $tools, $workspace, $runnerTemp, $runnerHome, $stateRoot,
        (Join-Path $tools 'jobs'), (Join-Path $tools 'logs'), (Join-Path $tools 'npm'),
        (Join-Path $tools 'npm-cli'), (Join-Path $tools 'npm-cli\bin'), (Join-Path $sandboxHome 'tmp'))) {
        New-PrivateDirectory $path
    }
    [IO.File]::Copy($node, (Join-Path $tools 'node.exe'))
    [IO.File]::Copy($bun, (Join-Path $tools 'bun.exe'))
    [IO.File]::Copy((Join-Path $SourceRoot '.github\scripts\normalize-live-tools.cjs'), (Join-Path $tools 'normalize-live-tools.cjs'))
    [void][IO.Directory]::CreateDirectory((Join-Path $workspace 'scripts'))
    [IO.File]::Copy((Join-Path $SourceRoot 'scripts\ci-sanitize-logs.ts'), (Join-Path $workspace 'scripts\ci-sanitize-logs.ts'))
    [IO.File]::WriteAllText((Join-Path $runnerHome 'protected.txt'), $secret)
    Set-RuntimeAcl $runnerHome $null 'ReadAndExecute' -Tree
    $password = ConvertTo-SecureString ('Aa1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
    $user = New-LocalUser -Name $userName -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
    $sandboxSid = $user.SID
    $createdUserSid = $sandboxSid
    $identityReceipt = [ordered]@{
        fixtureId = $FixtureId.ToString(); fixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
        case = $Case; runnerSid = $runnerSid.Value; createdUserSid = $createdUserSid.Value
        userName = $userName; processesDrained = $false; accountRemoved = $false
    }
    Save-FixtureIdentity
    Add-LocalGroupMember -SID $usersSid -Member $user
    Grant-BatchLogonRight
    $credential = [Management.Automation.PSCredential]::new(($env:COMPUTERNAME + '\' + $userName), $password)
    $env:GITHUB_WORKSPACE = $workspace
    $env:RUNNER_TEMP = $runnerTemp
    $env:USERPROFILE = $runnerHome
    Set-RuntimeAcl $FixtureRoot $sandboxSid 'ReadAndExecute'
    Set-RuntimeAcl $root $sandboxSid 'ReadAndExecute'
    Set-RuntimeAcl $work $sandboxSid 'Modify'
    Set-RuntimeAcl $sandboxHome $sandboxSid 'Modify' -Tree
    # Fixture npm models the pinned vendors' real hard-link-first placement.
    [IO.File]::WriteAllText((Join-Path $tools 'npm-cli\bin\npm-cli.js'), @'
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] !== "install" || !args.includes("--global") || args.at(-1) !== "fixture@1.0.0") throw Error("wrong install invocation");
const root = args[args.indexOf("--prefix") + 1];
const binary = path.join(root, "binary.exe"), alias = path.join(root, "launcher.exe");
fs.writeFileSync(binary, Buffer.alloc(1024 * 1024 + 17, 97));
fs.linkSync(binary, alias);
fs.linkSync(binary, path.join(process.env.HOME, "outside-link"));
fs.writeFileSync(path.join(root, "installed.json"), JSON.stringify({
  links: fs.statSync(binary).nlink,
  identity: cp.execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {encoding:"utf8"}),
  forbidden: Object.keys(process.env).filter(name => /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GH_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/.test(name))
}));
'@)
    Set-RuntimeAcl $tools $sandboxSid 'ReadAndExecute' -Tree
    Set-RuntimeAcl (Join-Path $tools 'npm') $sandboxSid 'Modify'
    $safe = Get-SafeEnvironment
    if ($Case -eq 'seal') {
        [void](Invoke-Isolated 'npm-install' $safe (Get-NpmInstallBody 'fixture@1.0.0') -TimeoutMinutes 2)
        Stop-SandboxProcesses
        $installed = Get-Content (Join-Path $tools 'npm\installed.json') -Raw | ConvertFrom-Json
        Check ($installed.links -eq 3) 'Fixture did not produce real hard links.'
        Check ($installed.identity.Contains($sandboxSid.Value)) 'Installer did not run as the sandbox SID.'
        Check ($installed.forbidden.Count -eq 0) 'Installer inherited forbidden environment variables.'
        Set-RuntimeAcl $tools $sandboxSid 'ReadAndExecute' -Tree -RejectLinks
        $expectedHash = (Get-FileHash -LiteralPath (Join-Path $sandboxHome 'outside-link') -Algorithm SHA256).Hash
        foreach ($file in @('binary.exe', 'launcher.exe')) {
            $path = Join-Path $tools ('npm\' + $file)
            [AidlcFileBoundary]::RequireSingleLink($path)
            $acl = Get-Acl -LiteralPath $path
            Check ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $runnerSid.Value) 'Sealed tool owner is not the runner.'
            Check ((Get-Item $path).Length -eq (1024 * 1024 + 17)) 'Tool bytes were truncated.'
            Check ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $expectedHash) 'Tool bytes were changed.'
        }
        $body = @'
$target = Join-Path ($env:AIDLC_LIVE_PATH.Split(';')[0]) 'npm\binary.exe'
$denied = $false
try { [IO.File]::WriteAllText($target, 'changed') }
catch {
    if ($_.Exception.GetBaseException() -isnot [UnauthorizedAccessException]) { throw }
    $denied = $true
}
if (-not $denied) { throw 'Sealed tool was writable.' }
[IO.File]::WriteAllText((Join-Path $env:HOME 'outside-link'), 'outside changed')
exit 0
'@
        [void](Invoke-Isolated 'seal-proof' $safe $body -TimeoutMinutes 2)
        Check ((Get-FileHash -LiteralPath (Join-Path $tools 'npm\binary.exe') -Algorithm SHA256).Hash -eq $expectedHash) 'An outside alias changed the sealed tool.'
        $result['singleLinkTools'] = $true
        $result['lowUserWriteDenied'] = $true
    } elseif ($Case -eq 'deny') {
        New-Item -ItemType HardLink -Path $deniedLink -Target (Join-Path $runnerHome 'protected.txt') | Out-Null
        $rejected = $false
        try { Set-RuntimeAcl $deniedLink $sandboxSid 'ReadAndExecute' -RejectLinks }
        catch { $rejected = $_.Exception.ToString().Contains('Refusing hard-linked runtime evidence.') }
        Check $rejected 'Privileged sealing did not reject the hard link.'
        $failed = $false
        try {
            $body = "& " + (ConvertTo-PSLiteral (Join-Path $tools 'node.exe')) + ' ' +
                (ConvertTo-PSLiteral (Join-Path $tools 'normalize-live-tools.cjs')) + ' ' +
                (ConvertTo-PSLiteral (Join-Path $tools 'npm')) + "`nexit `$LASTEXITCODE"
            [void](Invoke-Isolated 'read-boundary' $safe $body -TimeoutMinutes 2)
        } catch { $failed = $true }
        Check $failed 'Normalizer read through a protected hard link.'
        $denials = @(Get-ChildItem -LiteralPath (Join-Path $tools 'logs') -Filter stdout.log -Recurse |
            Where-Object { [IO.File]::ReadAllText($_.FullName) -match '(?s)(EACCES|EPERM).*(open|lstat).*protected-link' })
        Check ($denials.Count -gt 0) 'Failure did not prove the protected-file read was denied.'
        Check ([IO.File]::ReadAllText((Join-Path $runnerHome 'protected.txt')) -eq $secret) 'Protected file was changed.'
        [IO.File]::Delete($deniedLink)
        New-Item -ItemType Junction -Path $junction -Target $sandboxHome | Out-Null
        $failed = $false
        try { Set-RuntimeAcl $tools $sandboxSid 'ReadAndExecute' -Tree -RejectLinks } catch { $failed = $true }
        Check $failed 'Tool sealing accepted a reparse point.'
        $result['protectedReadDenied'] = $true
        $result['reparseRejected'] = $true
    } else {
        $failure = $null
        try { [void](Invoke-Isolated 'npm-install' $safe "Write-Output 'fixture installer failed'; exit 7" -TimeoutMinutes 2) }
        catch { $failure = $_ }
        Check ($null -ne $failure) 'Expected an installer failure.'
        Stop-SandboxProcesses -Disable
        $identityReceipt.processesDrained = $true
        [AidlcFixtureAccountCleanup]::RemoveRights($sandboxSid.Value)
        Remove-LocalUser -SID $sandboxSid
        if ($Case -eq 'poisoned-collect') {
            New-Item -ItemType HardLink -Path $poisonedLog -Target (Join-Path $runnerHome 'protected.txt') | Out-Null
        }
        Save-PreparationFailure $failure $true
        $savedFailure = Get-Content -LiteralPath (Join-Path $stateRoot 'preparation-failed.json') -Raw | ConvertFrom-Json
        Check ($savedFailure.CodexSandboxSids -is [Array] -and $savedFailure.CodexSandboxSids.Count -eq 0) 'Non-Codex failure must retain an empty SID array.'
        if ([IO.File]::Exists($poisonedLog)) { [IO.File]::Delete($poisonedLog) }
        Remove-OwnedTree $root
        # Run the real collect entry point with no runtime root, user or
        # credential file. Only the protected failure evidence may be copied.
        & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $source -Mode collect -Family isolation
        Check ($LASTEXITCODE -eq 0) 'Collection failed after preparation removed the account.'
        $logs = Join-Path $workspace 'tests\logs'
        $summaries = @(Get-ChildItem -LiteralPath $logs -Filter preparation.log -Recurse)
        Check ($summaries.Count -eq 1) 'Missing preparation summary artifact.'
        $outputs = @(Get-ChildItem -LiteralPath $logs -Filter stdout.log -Recurse)
        if ($Case -eq 'poisoned-collect') {
            Check ($outputs.Count -eq 0) 'Unsafe launch evidence was retained.'
            Check (([IO.File]::ReadAllText($summaries[0].FullName)).Contains('could not be retained safely')) 'Missing safe-copy failure diagnostic.'
            $result['linkedEvidenceRejected'] = $true
        } else {
            Check ($outputs.Count -gt 0) 'Missing preserved installer output.'
            Check (([IO.File]::ReadAllText($outputs[0].FullName)).Contains('fixture installer failed')) 'Wrong installer output.'
        }
        Check (@(Get-ChildItem -LiteralPath $logs -Filter '*.clixml' -Recurse).Count -eq 0) 'Credential state entered log artifacts.'
        $result['collectedAfterUserRemoval'] = $true
        $result['summaryArtifacts'] = $summaries.Count
    }
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot 'result.json') -Encoding UTF8
} catch {
    $fixtureFailure = $_
    throw
} finally {
    try {
        if ($null -ne $createdUserSid) {
            $existing = Get-RecordedLocalUser $createdUserSid
            if ($null -ne $existing) {
                Stop-SandboxProcesses -Disable
                $identityReceipt.processesDrained = $true
                [AidlcFixtureAccountCleanup]::RemoveRights($createdUserSid.Value)
                Remove-LocalUser -SID $createdUserSid
            }
            $identityReceipt.accountRemoved = $null -eq (Get-RecordedLocalUser $createdUserSid)
            Save-FixtureIdentity
        }
        if ([IO.File]::Exists($deniedLink)) { [IO.File]::Delete($deniedLink) }
        if ([IO.File]::Exists($poisonedLog)) { [IO.File]::Delete($poisonedLog) }
        if ([IO.Directory]::Exists($junction)) { [IO.Directory]::Delete($junction) }
    } catch {
        if ($null -eq $fixtureFailure) { throw }
        # Preserve the boundary assertion that failed; finally must not replace
        # it with a secondary cleanup exception.
        [Console]::Error.WriteLine(('Additional fixture cleanup failure: ' + $_.Exception.ToString()))
    } finally {
        $credential = $null
    }
}
