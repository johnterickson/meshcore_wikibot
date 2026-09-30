$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $root "test-runs\2026-09-21-qwen4-perf"
$gatewayPath = Join-Path $root "home-assistant-gateway"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$loadScript = Join-Path $gatewayPath "dist\loadPerfModel.js"
$perfScript = Join-Path $gatewayPath "dist\perfBenchmark.js"
$model = "qwen3.8-4b-distill"
$auditPath = Join-Path $outputPath "kv-audit.txt"

New-Item -ItemType Directory -Force $outputPath | Out-Null
Set-Content $auditPath @(
    "NODE=$node",
    "LOAD_SCRIPT=$loadScript",
    "PERF_SCRIPT=$perfScript",
    "EXPLICIT_UNLOAD_BEFORE_EVERY_CELL=true",
    "START_UTC=$([DateTime]::UtcNow.ToString('o'))"
)

function Get-LmsOutput {
    return ((& lms ps 2>&1 | Out-String).Trim())
}

function Get-LoadedIdentifiers {
    $lmsOutput = Get-LmsOutput
    return @($lmsOutput -split "`r?`n" | ForEach-Object {
        if ($_ -match '^\s*(\S+)\s+\S+\s+\S+\s+\d+(?:\.\d+)?\s+GB\s+') { $Matches[1] }
    })
}

function Unload-AllModels {
    $identifiers = @(Get-LoadedIdentifiers)
    Add-Content $auditPath "UNLOAD_IDENTIFIERS=$($identifiers -join ',')"
    foreach ($identifier in $identifiers) {
        & lms unload $identifier 2>&1 | Add-Content $auditPath
        if ($LASTEXITCODE -ne 0) { throw "Failed to unload $identifier" }
    }
    $after = Get-LmsOutput
    Add-Content $auditPath @("LMS_PS_AFTER_UNLOAD:", $after)
    if ($after -notmatch 'No models are currently loaded') { throw "LM Studio is not empty" }
}

function Get-Resources {
    $operatingSystem = Get-CimInstance Win32_OperatingSystem
    return [pscustomobject]@{
        utc = [DateTime]::UtcNow.ToString('o')
        ramUsedMB = [math]::Round(($operatingSystem.TotalVisibleMemorySize - $operatingSystem.FreePhysicalMemory) / 1024, 1)
        ramTotalMB = [math]::Round($operatingSystem.TotalVisibleMemorySize / 1024, 1)
        gpu = @(& nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits)
        lmsPs = Get-LmsOutput
    }
}

function Assert-GtxAllocation {
    $gpuRows = @(& nvidia-smi --query-gpu=name,memory.used --format=csv,noheader,nounits)
    Add-Content $auditPath @("GPU_ALLOCATION:", $gpuRows)
    $gtxRow = $gpuRows | Where-Object { $_ -match 'GTX 1650 SUPER' } | Select-Object -First 1
    $quadroRow = $gpuRows | Where-Object { $_ -match 'Quadro K1200' } | Select-Object -First 1
    $gtxUsedMB = [int](($gtxRow -split ',')[1].Trim())
    $quadroUsedMB = [int](($quadroRow -split ',')[1].Trim())
    if ($gtxUsedMB -lt 3000 -or $quadroUsedMB -gt 1000) {
        throw "Unexpected GPU allocation: GTX=$gtxUsedMB MB, Quadro=$quadroUsedMB MB"
    }
}

try {
    foreach ($kvGpu in @($true, $false)) {
        $label = if ($kvGpu) { "on" } else { "off" }
        Add-Content $auditPath "=== KV_GPU_$label ==="
        Unload-AllModels
        $before = Get-Resources
        $loadResult = & $node $loadScript --model $model --identifier $model --context-length 32768 --kv-gpu $kvGpu.ToString().ToLowerInvariant() --eval-batch-size 512 --flash-attention false --fp16-kv true 2>&1 | Out-String
        $loadExit = $LASTEXITCODE
        Set-Content (Join-Path $outputPath "kv-$label-load.json") $loadResult.Trim()
        if ($loadExit -ne 0) { throw "SDK load failed for KV $label`: $loadResult" }
        $loaded = Get-LmsOutput
        Add-Content $auditPath @("LMS_PS_AFTER_LOAD:", $loaded)
        if ($loaded -notmatch '(?m)^\s*qwen3\.8-4b-distill\s+') { throw "Qwen row missing for KV $label" }
        Assert-GtxAllocation
        $perfResult = & $node $perfScript --model $model --target-prompt-tokens 3000 --max-tokens 128 --warmups 1 --repetitions 3 --concurrency 1 2>&1 | Out-String
        $perfExit = $LASTEXITCODE
        Set-Content (Join-Path $outputPath "kv-$label.json") $perfResult.Trim()
        if ($perfExit -ne 0) { throw "Performance run failed for KV $label`: $perfResult" }
        $after = Get-Resources
        [pscustomobject]@{ before = $before; after = $after } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outputPath "kv-$label-resources.json")
        Add-Content $auditPath "KV_CELL_COMPLETED=$label"
    }
} finally {
    Add-Content $auditPath "=== RESTORE_SERVICE ==="
    Unload-AllModels
    & lms load nvidia/nemotron-3-nano-4b --context-length 32768 --parallel 1 --gpu max --identifier nvidia/nemotron-3-nano-4b --ttl 3600 -y 2>&1 | Add-Content $auditPath
    Add-Content $auditPath @("RESTORE_EXIT=$LASTEXITCODE", "FINAL_LMS_PS:", (Get-LmsOutput), "END_UTC=$([DateTime]::UtcNow.ToString('o'))")
}