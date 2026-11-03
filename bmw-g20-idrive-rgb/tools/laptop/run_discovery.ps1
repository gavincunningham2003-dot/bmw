# run_discovery.ps1 - self-test, then the read-only discovery scan over ENET. Run as Administrator.
param([string]$Gateway = "", [string]$Out = "out")
Set-Location $PSScriptRoot
Write-Host "== self-test against the simulated car =="
python -m enetdiag selftest --out $Out
if ($LASTEXITCODE -ne 0) { Write-Host "self-test failed; stopping"; exit 1 }
Write-Host "== discovery scan (read-only, UDS 0x22 only) =="
if ($Gateway -ne "") { python -m enetdiag scan --gateway $Gateway --out $Out } else { python -m enetdiag scan --out $Out }
Write-Host "Reports are in $Out (VIN and serial numbers redacted). Review the .log before sharing."
if (Test-Path $Out) { Invoke-Item $Out }
