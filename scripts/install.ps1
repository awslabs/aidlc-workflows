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
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
  'PSAvoidUsingWriteHost',
  '',
  Justification = 'The PATH instruction is part of the pinned human-mode stdout contract under PowerShell 5.1.'
)]
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter()]
  [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
  [string]$Version,

  [Parameter()]
  [string]$From,

  [Parameter()]
  [switch]$Offline,

  [Parameter()]
  [string]$ReleaseBaseUrl = $(if ($env:AIDLC_RELEASE_BASE_URL) {
    $env:AIDLC_RELEASE_BASE_URL
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

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$LiteralArguments
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$releaseRepository = if ($env:AIDLC_RELEASE_REPOSITORY) {
  $env:AIDLC_RELEASE_REPOSITORY
} else {
  'awslabs/aidlc-workflows'
}
$releaseWorkflow = if ($env:AIDLC_RELEASE_WORKFLOW) {
  $env:AIDLC_RELEASE_WORKFLOW
} else {
  "$releaseRepository/.github/workflows/release.yml"
}

function Write-Result {
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidUsingWriteHost',
    '',
    Justification = 'PASS output is part of the pinned human-mode stdout contract under PowerShell 5.1.'
  )]
  param(
    [bool]$Ok,
    [int]$Code,
    [string]$Status,
    [string]$Message,
    [string]$Remediation = ''
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
    $result | ConvertTo-Json -Compress
  } elseif ($Quiet) {
    if ($Remediation -and -not $Ok) { $Remediation } else { $Message }
  } elseif ($Ok) {
    Write-Host "PASS $Message"
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
    [string]$Remediation = ''
  )
  Write-Result -Ok $false -Code $Code -Status $Status -Message $Message `
    -Remediation $Remediation
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

function Confirm-NotAdministrator {
  if ($env:AIDLC_ALLOW_ADMIN_INSTALL -eq '1') { return }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'refusing an Administrator install; run as the target user'
  }
}

if ($LiteralArguments) {
  Stop-Install -Code 2 -Status 'usage' `
    -Message "unknown argument: $($LiteralArguments[0])"
}

Confirm-NotAdministrator

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
  if ($manifest.schemaVersion -ne 1 -or $manifest.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'version.json has an invalid schema or version'
  }
  $ghPath = $env:AIDLC_GH_BIN
  if (-not $ghPath) {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($gh) { $ghPath = $gh.Source }
  }
  if (-not $ghPath -or -not (Test-Path -LiteralPath $ghPath -PathType Leaf)) {
    Stop-Install -Code 1 -Status 'failed' `
      -Message 'GitHub CLI is required to verify release provenance' `
      -Remediation 'install gh, then rerun this installer'
  }
  & $ghPath attestation verify $checksumsPath `
    --bundle $bundle `
    --repo $releaseRepository `
    --signer-workflow $releaseWorkflow `
    --source-ref "refs/tags/v$($manifest.version)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'release provenance verification failed' `
      -Remediation "obtain the release from $releaseRepository"
  }
  $manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
  if ($manifestHash -ne (Get-ExpectedHash -Checksums $checksumsPath -Name 'version.json')) {
    Stop-Install -Code 4 -Status 'failed' `
      -Message 'checksum mismatch for version.json'
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

  $assets = @("aidlc-windows-x64.exe", "aidlc-runtime.tar.gz")
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

  $pathCommand = ''
  $resolvedAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $resolvedAidlc -or
    -not [IO.Path]::GetFullPath($resolvedAidlc.Source).Equals(
      [IO.Path]::GetFullPath($command),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    $pathCommand = "`$env:Path = '$($binDir.Replace("'", "''"));' + `$env:Path"
    $env:Path = "$binDir;$env:Path"
    $resolvedAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $resolvedAidlc -or
      -not [IO.Path]::GetFullPath($resolvedAidlc.Source).Equals(
        [IO.Path]::GetFullPath($command),
        [StringComparison]::OrdinalIgnoreCase
      )) {
      Stop-Install -Code 4 -Status 'failed' `
        -Message 'installed aidlc is not resolvable after applying the PATH update'
    }
  }
  if ($pathCommand -and -not $Quiet -and -not $Json) {
    Write-Host "For each new PowerShell session, run: $pathCommand"
  }
  $message = "installed AI-DLC $Version; command: $command"
  if ($pathCommand -and $Quiet) { $message = "$message; run $pathCommand in a new session" }
  Write-Result -Ok $true -Code 0 -Status 'ok' -Message $message
} catch {
  Stop-Install -Code 4 -Status 'failed' `
    -Message "installer validation failed: $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
