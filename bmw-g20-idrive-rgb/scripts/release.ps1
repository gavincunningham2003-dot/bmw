# release.ps1 - test, build, check and publish the MGU Store release of Ambient RGB (PUBLISHING.md).
#
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1            # publish v<version of app.json>
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Draft     # a draft release (the Store ignores drafts)
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -BuildOnly # tests + build + check, nothing uploaded
#
# Nothing here touches a car. It stops at the first thing that is not right and uploads only packages that
# passed scripts\build_app.py's check.
param([switch]$Draft, [switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Fail($msg) { Write-Host "release: $msg" -ForegroundColor Red; exit 1 }
function Run($what, [scriptblock]$cmd) {
    Write-Host "== $what" -ForegroundColor Cyan
    & $cmd
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)" }
}

$spec = Get-Content -Raw (Join-Path $root 'app\ambient_rgb\app.json') | ConvertFrom-Json
$id = $spec.id
$version = $spec.version
$tag = "v$version"
$ident = "$id@$version"
Write-Host "release: $ident (tag $tag)"

if (-not $BuildOnly) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'the GitHub CLI is not installed: winget install GitHub.cli, then gh auth login' }
    $dirty = git status --porcelain
    if ($dirty) { Fail "uncommitted changes: commit them first, so the release is what the tag says`n$dirty" }
    $tags = git tag --points-at HEAD
    if (-not ($tags -contains $tag)) { Fail "HEAD is not tagged $tag (git tag $tag; git push origin $tag)" }
}

Run 'Node tests' { npm test }
Run 'Python tests' { npm run test:py }
Run 'build and check' { python scripts\build_app.py }

$assets = @("dist\$ident.tgz", "dist\$ident.mgu", 'dist\mgu-store.json', "dist\$id.png")
foreach ($a in $assets) { if (-not (Test-Path $a)) { Fail "missing $a" } }
$build = Get-Content -Raw 'dist\BUILD.json' | ConvertFrom-Json
if (-not $build.checked -or $build.sdkInPackages) { Fail 'dist\BUILD.json does not say the packages were checked and SDK-free' }

if ($BuildOnly) { Write-Host "release: built and checked, nothing uploaded: $($assets -join ', ')" -ForegroundColor Green; exit 0 }

$notes = Join-Path $env:TEMP "ambient_rgb-$version-notes.md"
$log = Get-Content (Join-Path $root 'CHANGELOG.md')
$start = ($log | Select-String -Pattern "^## $([regex]::Escape($version))" | Select-Object -First 1).LineNumber
if (-not $start) { Fail "CHANGELOG.md has no section for $version" }
$rest = $log[$start..($log.Count - 1)]
$next = ($rest | Select-String -Pattern '^## ' | Select-Object -First 1).LineNumber
$body = if ($next) { $rest[0..($next - 2)] } else { $rest }
@("Ambient RGB $version for iDrive 7 (MGU). Install through MGU Store: add this repository as a source, Releases.", '',
  'The packages contain no BMW code: the head unit generates the oap-sdk module when it installs them.', '') + $body |
    Set-Content -Encoding utf8 $notes

$ghArgs = @('release', 'create', $tag) + $assets + @('--title', "Ambient RGB $version", '--notes-file', $notes, '--verify-tag')
if ($Draft) { $ghArgs += '--draft' }
Run 'publish the GitHub release' { gh @ghArgs }
Write-Host "release: published $tag with $($assets.Count) assets" -ForegroundColor Green
