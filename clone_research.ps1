# clone_research.ps1 - clone the repositories the project was researched from, at the commits that were read.
# They are not part of this repository (their own licences; some carry BMW-derived material).
#   .\clone_research.ps1            # into .\research\
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot "research"
New-Item -ItemType Directory -Force $root | Out-Null
$repos = @(
    @{ r = "cauliflowermossgrape/idrive7-apps";      sha = "25c7167ce88bcf3a709ad973ac07ad0570ce89f6"; shallow = $false },
    @{ r = "cauliflowermossgrape/idrive7-8-ssh-root"; sha = "524452490ff08357ef49cdeb1f47e887d0ffeb9f"; shallow = $false },
    @{ r = "robertnisipeanu/mgu-store";              sha = "181a9364df399c0e84ab57030bb0079a5fcb2066"; shallow = $false },
    @{ r = "cauliflowermossgrape/mgu-store";         sha = "a063d34612539e18e1163fd992b1f3d8b3302cd7"; shallow = $false },
    @{ r = "robertnisipeanu/idrive-apps";            sha = "8e978c93371d283765ed99cc9b2ca6e6af7167c1"; shallow = $false },
    @{ r = "Dauxdu/bmw-coding";                      sha = "ebb3b532dd01abe8d4a25d1bb79595a166cb376b"; shallow = $false },
    @{ r = "aremmell/g8x-colors";                    sha = "4b0ea4a511937552e00c44f8726d0013edbe4fee"; shallow = $false },
    @{ r = "siegester03/bmw-g-series-coding";        sha = "b40f1baf7f27d2d5e9267e6f87cd4f1556ed8b9f"; shallow = $false },
    @{ r = "Viaszx/BMW_HU_Info";                     sha = "c140b1d62ca59e0043a8c620eb390c96e6272c76"; shallow = $false },
    @{ r = "HadiCherkaoui/klartext";                 sha = "04c9ee520c3c33cbc933377ae57321c82e191319"; shallow = $false },
    @{ r = "pylessard/python-udsoncan";              sha = "07d7be1fcfd17e41af9a30f1c5573774e45bcdbd"; shallow = $true },
    @{ r = "jacobschaer/python-doipclient";          sha = "9887b80c2cc61686a6fdb5314724e026bb4e9a25"; shallow = $true },
    @{ r = "hardbyte/python-can";                    sha = "b4f82abede25ff83376be793a2935c41f81c3869"; shallow = $true },
    @{ r = "COVESA/vsomeip";                         sha = "4187431d2815bd351845a09d01aa85b2a3163cab"; shallow = $true },
    @{ r = "uholeschak/ediabaslib";                  sha = "e628f64f65d2b1a532f34729dfff53a0d961b988"; shallow = $true }
)
foreach ($p in $repos) {
    $name = $p.r -replace "/", "_"
    $dir = Join-Path $root $name
    if (Test-Path $dir) { Write-Host "exists  $name"; continue }
    Write-Host "cloning $($p.r)"
    if ($p.shallow) {
        git clone --quiet --depth 1 "https://github.com/$($p.r).git" $dir
        Write-Host "  (shallow clone; analysed at $($p.sha), the current head may differ)"
    } else {
        git clone --quiet "https://github.com/$($p.r).git" $dir
        git -C $dir checkout --quiet $p.sha
    }
}
Write-Host "done: $root"
