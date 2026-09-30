param(
    [string]$OutputDirectory = "test-runs\2026-09-21-qwen4-perf"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $root $OutputDirectory
$gatewayPath = Join-Path $root "home-assistant-gateway"
$auditPath = Join-Path $outputPath "matrix-audit.txt"
$model = "qwen3.8-4b-distill"

New-Item -ItemType Directory -Force $outputPath | Out-Null
Set-Content $auditPath @(
    "MODEL=$model",
    "QUANT=Q4_K_M",
    "EXPLICIT_UNLOAD_BEFORE_EVERY_CELL=true",
    "GLOBAL_SETTINGS_UNCHANGED=true",
    "START_UTC=$([DateTime]::UtcNow.ToString('o'))"
)

function Get-LmsOutput {
    return ((& lms ps 2>&1 | Out-String).Trim())
}

function Get-LoadedIdentifiers {
    $lmsOutput = Get-LmsOutput
    return @($lmsOutput -split "`r?`n" | ForEach-Object {
        if ($_ -match '^\s*(\S+)\s+\S+\s+\S+\s+\d+(?:\.\d+)?\s+GB\s+') {
            $Matches[1]
        }
    })
}

function Unload-AllModels {
    $identifiers = @(Get-LoadedIdentifiers)
    Add-Content $auditPath "UNLOAD_IDENTIFIERS=$($identifiers -join ',')"
    foreach ($identifier in $identifiers) {
        Add-Content $auditPath "UNLOAD_COMMAND=lms unload $identifier"
        & lms unload $identifier 2>&1 | Add-Content $auditPath
        if ($LASTEXITCODE -ne 0) { throw "Failed to unload $identifier" }
    }
    $after = Get-LmsOutput
    Add-Content $auditPath @("LMS_PS_AFTER_UNLOAD:", $after)
    if ($after -notmatch 'No models are currently loaded') {
        throw "LM Studio is not empty after explicit unload"
    }
}

function Get-ResourceSnapshot {
    $operatingSystem = Get-CimInstance Win32_OperatingSystem
    return [pscustomobject]@{
        utc = [DateTime]::UtcNow.ToString('o')
        ramUsedMB = [math]::Round(($operatingSystem.TotalVisibleMemorySize - $operatingSystem.FreePhysicalMemory) / 1024, 1)
        ramTotalMB = [math]::Round($operatingSystem.TotalVisibleMemorySize / 1024, 1)
        gpu = @(& nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits)
        lmsPs = Get-LmsOutput
    }
}

function Assert-LoadedRow([int]$ContextLength, [int]$Parallel) {
    $lmsOutput = Get-LmsOutput
    $row = @($lmsOutput -split "`r?`n" | Where-Object { $_ -match '^\s*qwen3\.8-4b-distill\s+' } | Select-Object -First 1)
    if ($row.Count -ne 1) { throw "Qwen 4B row not found" }
    $fields = @($row[0] -split '\s+' | Where-Object { $_ })
    if ($fields.Count -lt 7 -or $fields[2] -ne "IDLE" -or [int]$fields[5] -ne $ContextLength -or [int]$fields[6] -ne $Parallel) {
        throw "Unexpected loaded row: $($row[0])"
    }
    $apiStatus = (& curl.exe -sS --max-time 10 -o NUL -w '%{http_code}' http://127.0.0.1:1234/v1/models 2>&1 | Out-String).Trim()
    if ($apiStatus -ne "200") { throw "LM API health failed: $apiStatus" }
    return $row[0]
}

function Load-CliCell([int]$ContextLength, [int]$Parallel) {
    Unload-AllModels
    $started = [Diagnostics.Stopwatch]::StartNew()
    & lms load $model --context-length $ContextLength --parallel $Parallel --gpu max --identifier $model --ttl 3600 -y 2>&1 | Add-Content $auditPath
    $exitCode = $LASTEXITCODE
    $started.Stop()
    if ($exitCode -ne 0) { throw "Load failed for context=$ContextLength parallel=$Parallel" }
    $row = Assert-LoadedRow $ContextLength $Parallel
    Add-Content $auditPath @(
        "LOAD_CONTEXT=$ContextLength",
        "LOAD_PARALLEL=$Parallel",
        "LOAD_WALL_SECONDS=$([math]::Round($started.Elapsed.TotalSeconds, 3))",
        "LOADED_ROW=$row"
    )
}

function Run-Perf(
    [string]$OutputFile,
    [int]$TargetPromptTokens,
    [int]$Concurrency,
    [int]$Repetitions,
    [int]$Warmups = 1
) {
    Push-Location $gatewayPath
    try {
        $result = & node dist/perfBenchmark.js --model $model --target-prompt-tokens $TargetPromptTokens --max-tokens 128 --warmups $Warmups --repetitions $Repetitions --concurrency $Concurrency 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Performance request failed: $result" }
        Set-Content (Join-Path $outputPath $OutputFile) $result.Trim()
    } finally {
        Pop-Location
    }
}

function Save-CellMetadata([string]$Name, [object]$Before, [object]$After) {
    [pscustomobject]@{
        name = $Name
        before = $Before
        after = $After
    } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outputPath "$Name-resources.json")
}

try {
    foreach ($contextLength in @(8192, 32768, 131072, 262144)) {
        Add-Content $auditPath "=== CONTEXT_$contextLength ==="
        $before = Get-ResourceSnapshot
        Load-CliCell $contextLength 1
        $loaded = Get-ResourceSnapshot
        Run-Perf "context-$contextLength.json" 3000 1 3
        $after = Get-ResourceSnapshot
        Save-CellMetadata "context-$contextLength" $before $after
        Add-Content $auditPath "CONTEXT_CELL_COMPLETED=$contextLength"
    }

    foreach ($parallel in @(1, 4)) {
        Add-Content $auditPath "=== PARALLEL_$parallel ==="
        $before = Get-ResourceSnapshot
        Load-CliCell 32768 $parallel
        Run-Perf "parallel-$parallel.json" 3000 4 2
        $after = Get-ResourceSnapshot
        Save-CellMetadata "parallel-$parallel" $before $after
        Add-Content $auditPath "PARALLEL_CELL_COMPLETED=$parallel"
    }

    Add-Content $auditPath "=== ACTUAL_PROMPT_SCALING ==="
    Load-CliCell 262144 1
    foreach ($target in @(16384, 65536)) {
        Run-Perf "prompt-$target.json" $target 1 1 0
        Add-Content $auditPath "PROMPT_CELL_COMPLETED=$target"
    }

    foreach ($kvGpu in @($true, $false)) {
        $label = if ($kvGpu) { "on" } else { "off" }
        Add-Content $auditPath "=== KV_GPU_$label ==="
        Unload-AllModels
        Push-Location $gatewayPath
        try {
            $loadResult = & node dist/loadPerfModel.js --model $model --identifier $model --context-length 32768 --kv-gpu $kvGpu.ToString().ToLowerInvariant() --eval-batch-size 512 --flash-attention false --fp16-kv true 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) { throw "SDK load failed: $loadResult" }
            Set-Content (Join-Path $outputPath "kv-$label-load.json") $loadResult.Trim()
        } finally {
            Pop-Location
        }
        $loadedOutput = Get-LmsOutput
        Add-Content $auditPath @("KV_$label`_LMS_PS:", $loadedOutput)
        if ($loadedOutput -notmatch '(?m)^\s*qwen3\.8-4b-distill\s+') { throw "KV $label model row missing" }
        Run-Perf "kv-$label.json" 3000 1 3
        Get-ResourceSnapshot | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outputPath "kv-$label-resources.json")
        Add-Content $auditPath "KV_CELL_COMPLETED=$label"
    }
} finally {
    Add-Content $auditPath "=== RESTORE_SERVICE ==="
    Unload-AllModels
    & lms load nvidia/nemotron-3-nano-4b --context-length 32768 --parallel 1 --gpu max --identifier nvidia/nemotron-3-nano-4b --ttl 3600 -y 2>&1 | Add-Content $auditPath
    Add-Content $auditPath @("RESTORE_EXIT=$LASTEXITCODE", "FINAL_LMS_PS:", (Get-LmsOutput), "END_UTC=$([DateTime]::UtcNow.ToString('o'))")
}