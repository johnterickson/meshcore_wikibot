param(
    [string]$InstallRoot = "D:\prism-bonsai\prism-b10709-9a9394a"
)

$ErrorActionPreference = "Stop"
$tag = "prism-b10709-9a9394a"
$baseUrl = "https://github.com/PrismML-Eng/llama.cpp/releases/download/$tag"
$downloadDir = Join-Path $InstallRoot "downloads"
$cudaDir = Join-Path $InstallRoot "cuda"
$cpuDir = Join-Path $InstallRoot "cpu"
$assets = @(
    "llama-$tag-bin-win-cuda-12.4-x64.zip",
    "cudart-llama-bin-win-cuda-12.4-x64.zip",
    "llama-$tag-bin-win-cpu-x64.zip"
)

New-Item -ItemType Directory -Force -Path $downloadDir, $cudaDir, $cpuDir | Out-Null

foreach ($asset in $assets) {
    $archive = Join-Path $downloadDir $asset
    if (-not (Test-Path $archive)) {
        Write-Host "Downloading $asset"
        & curl.exe --fail --location --output $archive "$baseUrl/$asset"
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to download $asset"
        }
    }

    $destination = if ($asset -like "*cpu*") { $cpuDir } else { $cudaDir }
    Expand-Archive -Path $archive -DestinationPath $destination -Force
}

$cudaCli = Get-ChildItem $cudaDir -Recurse -Filter llama-cli.exe |
    Select-Object -First 1 -ExpandProperty FullName
$cpuCli = Get-ChildItem $cpuDir -Recurse -Filter llama-cli.exe |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $cudaCli -or -not $cpuCli) {
    throw "The release archives did not contain both llama-cli executables"
}

Write-Host "CUDA_CLI=$cudaCli"
& $cudaCli --version
& $cudaCli --list-devices
Write-Host "CPU_CLI=$cpuCli"
& $cpuCli --version