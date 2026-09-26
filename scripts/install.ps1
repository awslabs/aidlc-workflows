[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
  'PSReviewUnusedParameter',
  'Yes',
  Justification = 'Public parity flag; the installer is non-interactive and never prompts.'
)]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
  'PSReviewUnusedParameter',
  'NoColor',
  Justification = 'Public parity flag; this installer emits no ANSI color.'
)]
[CmdletBinding(PositionalBinding = $false)]
param(
  # Release version grammar: stable x.y.z, or a preview id
  # x.y.z-preview.YYYYMMDD.N. PowerShell literal of PREVIEW_CHANNEL / VERSION_ID
  # in core/tools/aidlc-channel.ts. Empty selects latest for the Windows one-liner;
  # the manifest check below requires a non-empty version.
  # Use a strict end assertion and explicit case sensitivity in .NET.
  [Parameter()]
  [ValidatePattern('^(?:(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.[0-9]{8}\.[1-9][0-9]*)?)?(?![\s\S])', Options = 'None')]
  [string]$Version,

  [Parameter()]
  [string]$From,

  [Parameter()]
  [switch]$Offline,

  [Parameter()]
  [string]$ReleaseBaseUrl = $(if ($env:AIDLC_RELEASE_BASE_URL) {
    $env:AIDLC_RELEASE_BASE_URL
  } elseif ($env:AIDLC_RELEASE_REPOSITORY) {
    "https://github.com/$($env:AIDLC_RELEASE_REPOSITORY)/releases"
  } else {
    'https://github.com/awslabs/aidlc-workflows/releases'
  }),

  [Parameter()]
  [string]$CaBundle = $env:AIDLC_CA_BUNDLE,

  [Parameter()]
  [switch]$Yes,

  [Parameter()]
  [switch]$Quiet,

  [Parameter()]
  [switch]$Json,

  [Parameter()]
  [switch]$NoColor,

  [Parameter()]
  [switch]$NoModifyPath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$LiteralArguments
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PackagedVersion = ''
if (-not $PSBoundParameters.ContainsKey('Version') -and -not $From) {
  $Version = $PackagedVersion
}
$releaseRepository = if ($env:AIDLC_RELEASE_REPOSITORY) {
  $env:AIDLC_RELEASE_REPOSITORY
} else {
  'awslabs/aidlc-workflows'
}
$releaseWorkflow = $env:AIDLC_RELEASE_WORKFLOW

function Write-Result {
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidUsingWriteHost',
    '',
    Justification = 'The installation receipt is intentional human-mode output under PowerShell 5.1.'
  )]
  param(
    [bool]$Ok,
    [int]$Code,
    [string]$Status,
    [string]$Message,
    [string]$Remediation = '',
    [hashtable]$Data
  )
  if ($Json) {
    $result = [ordered]@{
      schemaVersion = 1
      ok = $Ok
      code = $Code
      status = $Status
      message = $Message
    }
    if ($Remediation) { $result.remediation = $Remediation }
    if ($Data) { $result.data = $Data }
    $result | ConvertTo-Json -Compress
  } elseif ($Quiet) {
    if ($Remediation -and -not $Ok) { $Remediation } else { $Message }
  } elseif ($Ok) {
    Write-Host $Message
  } else {
    [Console]::Error.WriteLine("$(if ($Code -eq 4) { 'FAIL' } else { 'ERROR' }) $Message")
    if ($Remediation) { [Console]::Error.WriteLine("Run: $Remediation") }
  }
  $global:LASTEXITCODE = $Code
}

function Stop-Install {
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSUseShouldProcessForStateChangingFunctions',
    '',
    Justification = 'This helper only emits the terminal result and exits; it performs no state mutation.'
  )]
  param(
    [int]$Code,
    [string]$Status,
    [string]$Message,
    [string]$Remediation = '',
    [hashtable]$Data
  )
  Write-Result -Ok $false -Code $Code -Status $Status -Message $Message `
    -Remediation $Remediation -Data $Data
  exit $Code
}

function Get-ReleaseFile {
  param([string]$Url, [string]$Output)
  if (-not $Quiet -and -not $Json) {
    [Console]::Error.WriteLine("Downloading $([IO.Path]::GetFileName($Output))...")
  }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $arguments = @('--fail', '--silent', '--show-error', '--location')
    if ($CaBundle) { $arguments += @('--cacert', $CaBundle) }
    $arguments += @('--output', $Output, $Url)
    & $curl.Source @arguments
    if ($LASTEXITCODE -ne 0) {
      Stop-Install -Code 3 -Status 'unavailable' -Message 'download failed' `
        -Remediation 'check the release URL, proxy, and CA bundle'
    }
    return
  }
  if ($CaBundle) {
    Stop-Install -Code 1 -Status 'failed' `
      -Message 'curl.exe is required when --CaBundle is used'
  }
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Output
  } catch {
    Stop-Install -Code 3 -Status 'unavailable' -Message 'download failed' `
      -Remediation 'check the release URL and proxy'
  }
}

function Get-ExpectedHash {
  param([string]$Checksums, [string]$Name)
  $escaped = [Regex]::Escape($Name)
  $rows = @(Get-Content -LiteralPath $Checksums | Where-Object {
    $_ -match "^([a-f0-9]{64})  $escaped$"
  })
  if ($rows.Count -ne 1) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message "checksums.txt has no unique row for $Name"
  }
  return ($rows[0] -split '  ', 2)[0]
}

# TokenElevationType: 1 is a full token with no split (the built-in
# Administrator, or UAC off), 2 is the elevated half of a UAC split token,
# 3 is the limited half.
function Get-InstallTokenElevationType {
  # Emit the P/Invoke in memory. Add-Type would compile through the account's
  # writable temp directory before the refusal, where a non-elevated process
  # of the same account could replace what this elevated session then loads.
  if (-not $script:InstallTokenQuery) {
    $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
      [Reflection.AssemblyName]::new('Aidlc.Installer.TokenQuery'),
      [Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $type = $assembly.DefineDynamicModule('Aidlc.Installer.TokenQuery').DefineType(
      'Aidlc.Installer.TokenQuery', 'Public, Class, Sealed, Abstract'
    )
    $method = $type.DefinePInvokeMethod(
      'GetTokenInformation', 'advapi32.dll',
      [Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
      [Reflection.CallingConventions]::Standard, [bool],
      [Type[]]@([IntPtr], [int], [int].MakeByRefType(), [int], [int].MakeByRefType()),
      [Runtime.InteropServices.CallingConvention]::Winapi,
      [Runtime.InteropServices.CharSet]::Unicode
    )
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    $script:InstallTokenQuery = $type.CreateType()
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $value = 0
    $returned = 0
    if (-not $script:InstallTokenQuery::GetTokenInformation($identity.Token, 18, [ref]$value, 4, [ref]$returned)) {
      throw 'could not read the token elevation type'
    }
    return $value
  } finally {
    $identity.Dispose()
  }
}

function Confirm-NotUacElevated {
  param([Nullable[int]]$ElevationType)
  if ($null -eq $ElevationType) {
    $principal = [Security.Principal.WindowsPrincipal]::new(
      [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    # A session without administrator rights has no elevated token to check.
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }
    try {
      $ElevationType = Get-InstallTokenElevationType
    } catch {
      # Fail closed: an unreadable elevated token is treated as UAC-elevated.
      $ElevationType = 2
    }
  }
  # Under UAC, a non-elevated process of the same account can replace verified
  # files in user-writable locations before this elevated session runs them.
  # A full-token session has no lower-integrity half, so it may install.
  if ($ElevationType -eq 2) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'This PowerShell window is running as administrator. AI-DLC installs just for your account and doesn''t need admin rights. Open PowerShell normally (not "Run as administrator") and run the install command again.'
  }
}

function Get-PathWithDirectory {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Directory,
    [bool]$ExpandVariables = $true
  )
  if ($Directory -match '[;\r\n]') {
    throw 'the command directory cannot be a PATH entry; choose another directory or use -NoModifyPath'
  }
  $target = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
  foreach ($entry in ($Path -split ';')) {
    $expanded = $entry.Trim().Trim('"')
    if ($ExpandVariables) {
      $expanded = [Environment]::ExpandEnvironmentVariables($expanded)
    }
    if (-not [IO.Path]::IsPathRooted($expanded)) { continue }
    try {
      $candidate = [IO.Path]::GetFullPath($expanded).TrimEnd('\', '/')
      if ($candidate.Equals($target, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ Path = $Path; Changed = $false }
      }
    } catch {
      # Preserve unrelated entries even when they cannot be normalized.
      continue
    }
  }
  $updated = if ([string]::IsNullOrEmpty($Path)) {
    $Directory
  } elseif ($Path.EndsWith(';')) {
    "$Path$Directory"
  } else {
    "$Path;$Directory"
  }
  return [pscustomobject]@{ Path = $updated; Changed = $true }
}

function Write-PathRegistration {
  param([string]$Path, [byte[]]$Bytes)
  $temporaryRecord = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllBytes($temporaryRecord, $Bytes)
    if ([IO.File]::Exists($Path)) {
      [IO.File]::Replace($temporaryRecord, $Path, [NullString]::Value)
    } else {
      [IO.File]::Move($temporaryRecord, $Path)
    }
  } finally {
    if ([IO.File]::Exists($temporaryRecord)) { [IO.File]::Delete($temporaryRecord) }
  }
}

function Set-UserPath {
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSUseShouldProcessForStateChangingFunctions',
    '',
    Justification = 'The installer applies this user-scoped change after verification; -NoModifyPath opts out without interactive prompts.'
  )]
  param(
    [string]$Directory,
    [string]$InstallRoot,
    [string]$AccountSid,
    [Microsoft.Win32.RegistryKey]$EnvironmentKey
  )
  $ownsKey = $null -eq $EnvironmentKey
  $key = if ($ownsKey) {
    [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  } else {
    $EnvironmentKey
  }
  try {
    $recordPath = Join-Path $InstallRoot 'windows-path.json'
    $previousRecord = $null
    if (Test-Path -LiteralPath $recordPath) {
      $recordItem = Get-Item -LiteralPath $recordPath
      if ($recordItem.PSIsContainer -or
        ($recordItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'the PATH ownership record is not a regular file'
      }
      $previousRecord = [IO.File]::ReadAllBytes($recordPath)
      $record = [Text.Encoding]::UTF8.GetString($previousRecord) | ConvertFrom-Json
      $previousIsMissing = $null -eq $record.previousValue
      if ($record.schemaVersion -ne 1 -or $record.scope -cne 'user' -or
        $record.accountSid -cne $AccountSid -or $record.entry -isnot [string] -or
        $record.registeredValue -isnot [string] -or
        (!$previousIsMissing -and $record.previousValue -isnot [string]) -or
        ($previousIsMissing -and $null -ne $record.previousKind) -or
        (!$previousIsMissing -and $record.previousKind -cnotin @('String', 'ExpandString')) -or
        -not [IO.Path]::GetFullPath($record.entry).Equals(
          [IO.Path]::GetFullPath($Directory), [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'the PATH ownership record does not match this account and command directory'
      }
      $expectedRegistered = if ([string]::IsNullOrEmpty($record.previousValue)) {
        $record.entry
      } elseif ($record.previousValue.EndsWith(';')) {
        "$($record.previousValue)$($record.entry)"
      } else {
        "$($record.previousValue);$($record.entry)"
      }
      if ($record.registeredValue -cne $expectedRegistered) {
        throw 'the PATH ownership record has an inconsistent entry'
      }
    }
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    $current = ''
    $existed = $key.GetValueNames() -contains 'Path'
    if ($existed) {
      $kind = $key.GetValueKind('Path')
      if ($kind -notin @(
        [Microsoft.Win32.RegistryValueKind]::String,
        [Microsoft.Win32.RegistryValueKind]::ExpandString
      )) {
        throw 'the existing user PATH is not a string; repair it or use -NoModifyPath'
      }
      $current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
    $update = Get-PathWithDirectory -Path $current -Directory $Directory `
      -ExpandVariables ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString)
    if ($update.Changed) {
      $registration = [ordered]@{
        schemaVersion = 1
        scope = 'user'
        accountSid = $AccountSid
        entry = $Directory
        previousValue = $(if ($existed) { $current } else { $null })
        previousKind = $(if ($existed) { $kind.ToString() } else { $null })
        registeredValue = $update.Path
      }
      $recordBytes = [Text.UTF8Encoding]::new($false).GetBytes(
        ($registration | ConvertTo-Json -Compress) + "`n"
      )
      # Record intent before changing the registry. A stopped install can then
      # remove only this entry; a failed write restores the earlier record.
      Write-PathRegistration -Path $recordPath -Bytes $recordBytes
      try {
        $key.SetValue('Path', $update.Path, $kind)
      } catch {
        if ($null -eq $previousRecord) {
          [IO.File]::Delete($recordPath)
        } else {
          Write-PathRegistration -Path $recordPath -Bytes $previousRecord
        }
        throw
      }
    }
    return [pscustomobject]@{
      Changed = $update.Changed
      Owned = $update.Changed -or $null -ne $previousRecord
    }
  } finally {
    if ($ownsKey) { $key.Close() }
  }
}

function Send-EnvironmentChange {
  try {
    if (-not ('Aidlc.Installer.EnvironmentNotification' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Aidlc.Installer {
  public static class EnvironmentNotification {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr window, uint message, UIntPtr wParam, string lParam,
      uint flags, uint timeout, out UIntPtr result);
  }
}
'@
    }
    $result = [UIntPtr]::Zero
    $sent = [Aidlc.Installer.EnvironmentNotification]::SendMessageTimeout(
      [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result
    )
    return $sent -ne [IntPtr]::Zero
  } catch {
    # Registration already succeeded; notification is best-effort in SSH and
    # other sessions without an interactive Windows desktop.
    return $false
  }
}

function Get-PersistentCommandPath {
  param([string]$Name)
  $processPath = $env:Path
  try {
    $env:Path = @(
      [Environment]::GetEnvironmentVariable('Path', 'Machine'),
      [Environment]::GetEnvironmentVariable('Path', 'User')
    ) -join ';'
    $resolved = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($resolved) { return $resolved.Source }
    return $null
  } finally {
    $env:Path = $processPath
  }
}

if ($LiteralArguments) {
  Stop-Install -Code 2 -Status 'usage' `
    -Message "unknown argument: $($LiteralArguments[0])"
}

Confirm-NotUacElevated

if ($env:AIDLC_OFFLINE -eq '1') {
  $Offline = $true
}
if ($Offline -and -not $From) {
  Stop-Install -Code 3 -Status 'unavailable' `
    -Message '--Offline requires --From <release-directory>'
}
if ($From) {
  $Offline = $true
  $From = [IO.Path]::GetFullPath($From)
  if (-not (Test-Path -LiteralPath $From -PathType Container)) {
    Stop-Install -Code 2 -Status 'usage' `
      -Message "offline source is not a directory: $From"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $From 'install.ps1') -PathType Leaf)) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'offline source is missing install.ps1'
  }
}
if (-not $From) {
  try {
    $releaseUri = [Uri]::new($ReleaseBaseUrl)
  } catch {
    Stop-Install -Code 2 -Status 'usage' -Message 'release URL is invalid'
  }
  if ($releaseUri.UserInfo -or $releaseUri.Query -or $releaseUri.Fragment) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'release URL must not include credentials, a query, or a fragment'
  }
  if ($releaseUri.Scheme -ne 'https' -and
    -not ($releaseUri.Scheme -eq 'http' -and $releaseUri.IsLoopback)) {
    Stop-Install -Code 4 -Status 'failed' -Message 'release URL must use HTTPS'
  }
}
if ($CaBundle -and -not [IO.Path]::IsPathRooted($CaBundle)) {
  Stop-Install -Code 2 -Status 'usage' `
    -Message '--CaBundle must be an absolute path'
}

$installRoot = if ($env:AIDLC_INSTALL_ROOT) {
  [IO.Path]::GetFullPath($env:AIDLC_INSTALL_ROOT)
} else {
  Join-Path $env:LOCALAPPDATA 'aidlc'
}
$binDir = if ($env:AIDLC_BIN_DIR) {
  [IO.Path]::GetFullPath($env:AIDLC_BIN_DIR)
} else {
  Join-Path $installRoot 'bin'
}
$command = Join-Path $binDir 'aidlc.cmd'
$existingAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $env:AIDLC_BIN_DIR -and $existingAidlc -and
  -not [IO.Path]::GetFullPath($existingAidlc.Source).Equals(
    [IO.Path]::GetFullPath($command),
    [StringComparison]::OrdinalIgnoreCase
  )) {
  Stop-Install -Code 4 -Status 'failed' `
    -Message "existing aidlc at $($existingAidlc.Source) is outside the native install destination" `
    -Remediation 'use its package manager, or set AIDLC_BIN_DIR to an explicit empty directory'
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) "aidlc-install-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($temporary) | Out-Null

try {
  $metadataSegment = if ($Version) { "download/v$Version" } else { 'latest/download' }
  $metadata = @('version.json', 'checksums.txt', 'aidlc-release.intoto.jsonl')
  foreach ($name in $metadata) {
    $output = Join-Path $temporary $name
    if ($From) {
      $source = Join-Path $From $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Stop-Install -Code 4 -Status 'failed' `
          -Message "offline source is missing $name"
      }
      Copy-Item -LiteralPath $source -Destination $output
    } else {
      Get-ReleaseFile `
        -Url "$($ReleaseBaseUrl.TrimEnd('/'))/$metadataSegment/$name" `
        -Output $output
    }
  }

  $manifestPath = Join-Path $temporary 'version.json'
  $checksumsPath = Join-Path $temporary 'checksums.txt'
  $bundle = Join-Path $temporary 'aidlc-release.intoto.jsonl'
  foreach ($metadataPath in @($manifestPath, $checksumsPath, $bundle)) {
    if ((Get-Item -LiteralPath $metadataPath).Length -gt 1MB) {
      Stop-Install -Code 4 -Status 'failed' `
        -Message "$([IO.Path]::GetFileName($metadataPath)) exceeds the 1 MiB metadata limit"
    }
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.[0-9]{8}\.[1-9][0-9]*)?(?![\s\S])') {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'version.json has an invalid schema or version'
  }
  if (-not $releaseWorkflow) {
    $workflowName = if ($manifest.version -match '-preview\.') {
      'preview-release.yml'
    } else {
      'release.yml'
    }
    $releaseWorkflow = "$releaseRepository/.github/workflows/$workflowName"
  }
  $ghPath = $env:AIDLC_GH_BIN
  if (-not $ghPath) {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($gh) { $ghPath = $gh.Source }
  }
  $provenanceVerifierAvailable = $false
  if ($ghPath -and (Test-Path -LiteralPath $ghPath -PathType Leaf)) {
    try {
      $ghAttestationHelp = (& $ghPath attestation verify --help 2>&1 | Out-String)
      $provenanceVerifierAvailable = (
        $LASTEXITCODE -eq 0 -and
        $ghAttestationHelp -match '--signer-workflow\b' -and
        $ghAttestationHelp -match '--source-ref\b' -and
        $ghAttestationHelp -match '--source-digest\b'
      )
    } catch {
      $provenanceVerifierAvailable = $false
    }
  }
  if (-not $provenanceVerifierAvailable -and -not $Quiet -and -not $Json) {
    [Console]::Error.WriteLine(
      'WARN GitHub CLI attestation verification is unavailable; continuing with SHA-256 release checksums.'
    )
  }
  if ($provenanceVerifierAvailable) {
    & $ghPath attestation verify $checksumsPath `
      --bundle $bundle `
      --repo $releaseRepository `
      --signer-workflow $releaseWorkflow | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Stop-Install -Code 4 -Status 'failed' `
        -Message 'release provenance verification failed' `
        -Remediation "obtain the release from $releaseRepository"
    }
  }
  $manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
  if ($manifestHash -ne (Get-ExpectedHash -Checksums $checksumsPath -Name 'version.json')) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'checksum mismatch for version.json'
  }
  $expectedSourceRef = if ($manifest.version -match '-preview\.') {
    'refs/heads/main'
  } else {
    "refs/tags/v$($manifest.version)"
  }
  if ($manifest.sourceRef -ne $expectedSourceRef -or $manifest.sourceDigest -notmatch '^[a-f0-9]{40}$') {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'version.json has an invalid release source identity'
  }
  if ($provenanceVerifierAvailable) {
    & $ghPath attestation verify $checksumsPath `
      --bundle $bundle `
      --repo $releaseRepository `
      --signer-workflow $releaseWorkflow `
      --source-ref $manifest.sourceRef `
      --source-digest $manifest.sourceDigest | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Stop-Install -Code 4 -Status 'failed' `
        -Message 'release provenance source verification failed' `
        -Remediation "obtain the release from $releaseRepository"
    }
  }
  $verifiedInstaller = Join-Path $temporary 'install.ps1'
  if ($From) {
    Copy-Item -LiteralPath (Join-Path $From 'install.ps1') -Destination $verifiedInstaller
  } else {
    Get-ReleaseFile `
      -Url "$($ReleaseBaseUrl.TrimEnd('/'))/$metadataSegment/install.ps1" `
      -Output $verifiedInstaller
  }
  $installerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifiedInstaller).Hash.ToLowerInvariant()
  if ($installerHash -ne (Get-ExpectedHash -Checksums $checksumsPath -Name 'install.ps1')) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'checksum mismatch for install.ps1'
  }
  if ($Version -and $manifest.version -ne $Version) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message "release endpoint returned $($manifest.version), not requested $Version"
  }
  $Version = $manifest.version

  $runtimeAsset = "aidlc-runtime-$Version.tar.gz"
  $assets = @("aidlc-windows-x64.exe", $runtimeAsset)
  foreach ($name in $assets) {
    $asset = @($manifest.assets | Where-Object { $_.name -eq $name })
    if ($asset.Count -ne 1) {
      Stop-Install -Code 3 -Status 'unavailable' `
        -Message "release does not provide $name"
    }
    $expected = Get-ExpectedHash -Checksums $checksumsPath -Name $name
    if ($asset[0].sha256 -ne $expected) {
      Stop-Install -Code 4 -Status 'failed' `
        -Message "$name checksum metadata does not match version.json"
    }
    $output = Join-Path $temporary $name
    if ($From) {
      $source = Join-Path $From $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Stop-Install -Code 4 -Status 'failed' `
          -Message "offline source is missing $name"
      }
      Copy-Item -LiteralPath $source -Destination $output
    } else {
      Get-ReleaseFile `
        -Url "$($ReleaseBaseUrl.TrimEnd('/'))/download/v$Version/$name" `
        -Output $output
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Stop-Install -Code 4 -Status 'failed' -Message "checksum mismatch for $name"
    }
    if ((Get-Item -LiteralPath $output).Length -ne [long]$asset[0].bytes) {
      Stop-Install -Code 4 -Status 'failed' -Message "size mismatch for $name"
    }
    Unblock-File -LiteralPath $output -ErrorAction SilentlyContinue
  }

  $binary = Join-Path $temporary 'aidlc-windows-x64.exe'
  $arguments = @('system', 'lifecycle', 'install-apply', '--version', $Version, '--from', $temporary)
  $applyOutput = (& $binary @arguments --json | Out-String).Trim()
  $applyCode = $LASTEXITCODE
  try {
    $applyResult = $applyOutput | ConvertFrom-Json
  } catch {
    Stop-Install -Code 1 -Status 'failed' `
      -Message 'verified installer binary returned an invalid result'
  }
  if ($applyCode -ne 0) {
    Stop-Install -Code $applyCode -Status $applyResult.status `
      -Message $applyResult.message -Remediation $applyResult.remediation
  }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $installAccount = $identity.Name
  $accountSid = $identity.User.Value
  $identity.Dispose()
  $directConfig = "& '$($command.Replace("'", "''"))' config"
  $data = @{
    installed = $true
    ready = $true
    version = $Version
    account = $installAccount
    installRoot = $installRoot
    command = $command
    path = @{
      scope = 'user'
      status = 'skipped'
      changed = $false
      owned = $false
    }
    nextSteps = @("In your project, run: $directConfig")
  }
  $resultStatus = 'ok'
  $pathMessage = 'PATH was not changed (-NoModifyPath).'
  if ($NoModifyPath -and (Test-Path -LiteralPath (Join-Path $installRoot 'windows-path.json'))) {
    # Opting out leaves any earlier registration alone without adopting or
    # validating it. Its ownership is deliberately not assessed in this run.
    $data.path.owned = $null
  }
  if (-not $NoModifyPath) {
    $previousProcessPath = $env:Path
    try {
      $resolvedAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if (-not $resolvedAidlc -or
        -not [IO.Path]::GetFullPath($resolvedAidlc.Source).Equals(
          [IO.Path]::GetFullPath($command),
          [StringComparison]::OrdinalIgnoreCase
        )) {
        $env:Path = "$binDir;$env:Path"
        $resolvedAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
          Select-Object -First 1
        if (-not $resolvedAidlc -or
          -not [IO.Path]::GetFullPath($resolvedAidlc.Source).Equals(
            [IO.Path]::GetFullPath($command),
            [StringComparison]::OrdinalIgnoreCase
          )) {
          throw 'installed aidlc is not resolvable after applying the PATH update'
        }
      }
      $registration = Set-UserPath -Directory $binDir -InstallRoot $installRoot -AccountSid $accountSid
      $pathChanged = $registration.Changed
      $data.path.changed = $pathChanged
      $data.path.owned = $registration.Owned
    } catch {
      $env:Path = $previousProcessPath
      $data.ready = $false
      $data.path.status = 'failed'
      Stop-Install -Code 1 -Status 'failed' `
        -Message "Installed AI-DLC $Version, but PATH setup needs attention: $($_.Exception.Message)" `
        -Remediation "In your project, run: $directConfig" -Data $data
    }
    $pathMessage = if ($pathChanged) {
      $data.path.status = 'updated'
      'Added aidlc to your user PATH.'
    } else {
      $data.path.status = 'unchanged'
      'aidlc is already on your user PATH.'
    }
    $data.nextSteps = @('In your project, run: aidlc config')
    if ($pathChanged -and -not (Send-EnvironmentChange)) {
      $resultStatus = 'warning'
      $data.path.notification = 'unavailable'
      $data.nextSteps += 'Sign out and back in if a new terminal cannot find aidlc.'
    }
    $persistentCommand = Get-PersistentCommandPath -Name 'aidlc'
    if (-not $persistentCommand -or
      -not [IO.Path]::GetFullPath($persistentCommand).Equals(
        [IO.Path]::GetFullPath($command),
        [StringComparison]::OrdinalIgnoreCase
      )) {
      $conflict = if ($persistentCommand) { "'$persistentCommand'" } else { 'no aidlc command' }
      $resultStatus = 'warning'
      $data.ready = $false
      $data.path.status = 'conflict'
      $data.path.resolvedCommand = $persistentCommand
      $pathMessage = "Setup needs attention: PATH resolves $conflict."
      $data.nextSteps = @("In your project, run: $directConfig", 'Resolve the PATH conflict to use the aidlc shortcut.')
    }
  }
  $message = "Installed AI-DLC $Version"
  if ($Json) {
    if (-not $data.ready) { $message += '; setup needs attention' }
  } elseif ($Quiet) {
    $message += "; command: $command; $pathMessage"
    if (-not $data.ready -or $NoModifyPath) { $message += "; $($data.nextSteps[0])" }
  } else {
    $lines = @(
      $message,
      "Account: $installAccount",
      "Command: $command",
      $pathMessage,
      '',
      "Next: $($data.nextSteps[0])"
    )
    if ($data.ready -and -not $NoModifyPath) {
      $lines += 'Restart existing terminals or IDEs if they cannot find aidlc.'
    }
    if ($data.nextSteps.Count -gt 1) { $lines += $data.nextSteps[1..($data.nextSteps.Count - 1)] }
    $message = $lines -join [Environment]::NewLine
  }
  Write-Result -Ok $true -Code 0 -Status $resultStatus -Message $message -Data $data
} catch {
  Stop-Install -Code 4 -Status 'failed' `
    -Message "installer validation failed: $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
