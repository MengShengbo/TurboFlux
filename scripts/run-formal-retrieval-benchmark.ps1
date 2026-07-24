param(
  [Parameter(Mandatory = $true)]
  [string]$ApiConfigId,
  [int]$Concurrency = 25
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$implementationCommit = 'bf5d517c4e8cd94438f304e0895c097ec3612585'
$experimentRoot = Join-Path $repoRoot 'benchmark-results\2026-07-25-fastcontext-formal-scale'
$statusPath = Join-Path $experimentRoot 'status.json'
$pidPath = Join-Path $experimentRoot 'runner.pid'

Set-Location $repoRoot
New-Item -ItemType Directory -Force -Path $experimentRoot | Out-Null
Set-Content -LiteralPath $pidPath -Value $PID -Encoding ascii

function Write-ExperimentStatus {
  param(
    [string]$Phase,
    [string]$State,
    [string]$Message
  )

  $mainJournal = Join-Path $experimentRoot 'main-200\runs.jsonl'
  $confirmJournal = Join-Path $experimentRoot 'confirm-100x3\runs.jsonl'
  $mainRuns = if (Test-Path -LiteralPath $mainJournal) { (Get-Content -LiteralPath $mainJournal).Count } else { 0 }
  $confirmRuns = if (Test-Path -LiteralPath $confirmJournal) { (Get-Content -LiteralPath $confirmJournal).Count } else { 0 }
  [ordered]@{
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    pid = $PID
    phase = $Phase
    state = $State
    message = $Message
    implementationCommit = $implementationCommit
    harnessCommit = (git rev-parse HEAD).Trim()
    mainRunsJournaled = $mainRuns
    mainRunsExpected = 600
    confirmRunsJournaled = $confirmRuns
    confirmRunsExpected = 900
  } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}

function Invoke-BenchmarkStage {
  param(
    [string]$Phase,
    [string]$Manifest,
    [string]$Output,
    [int]$Repeats
  )

  $logPath = Join-Path $experimentRoot "$Phase.log"
  Write-ExperimentStatus -Phase $Phase -State 'running' -Message "Starting $Phase"
  & npx tsx scripts/paper-retrieval-benchmark.ts run `
    --manifest $Manifest `
    --output $Output `
    --systems fastcontext,claude-code-readonly,opencode-explore `
    --repeats $Repeats `
    --concurrency $Concurrency `
    --timeout-seconds 600 `
    --retry-transient `
    --transient-attempts 3 `
    --api-config-id $ApiConfigId 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) {
    throw "$Phase exited with code $LASTEXITCODE"
  }
  Write-ExperimentStatus -Phase $Phase -State 'completed' -Message "$Phase completed"
}

try {
  git merge-base --is-ancestor $implementationCommit HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "Implementation commit $implementationCommit is not an ancestor of HEAD"
  }

  Invoke-BenchmarkStage `
    -Phase 'main-200' `
    -Manifest 'benchmark-data/retrieval-paper-v1/manifest.json' `
    -Output 'benchmark-results/2026-07-25-fastcontext-formal-scale/main-200' `
    -Repeats 1

  Invoke-BenchmarkStage `
    -Phase 'confirm-100x3' `
    -Manifest 'benchmark-data/retrieval-paper-v1/splits/holdout-test-manifest.json' `
    -Output 'benchmark-results/2026-07-25-fastcontext-formal-scale/confirm-100x3' `
    -Repeats 3

  Write-ExperimentStatus -Phase 'all' -State 'completed' -Message 'All 1500 system runs completed'
} catch {
  Write-ExperimentStatus -Phase 'runner' -State 'failed' -Message $_.Exception.Message
  throw
}
