param(
    [string]$PackageRoot,
    [string]$OutputDirectory,
    [switch]$Format
)

$ErrorActionPreference = 'Stop'

function Resolve-CodexPackage {
    if ($PackageRoot) {
        return [pscustomobject]@{
            Version = 'manual'
            Root = [IO.Path]::GetFullPath($PackageRoot)
        }
    }

    $package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) {
        throw 'OpenAI.Codex AppX package was not found.'
    }

    $root = $package.InstallLocation
    if (Test-Path -LiteralPath (Join-Path $root 'app\resources\app.asar')) {
        $root = Join-Path $root 'app'
    }

    return [pscustomobject]@{
        Version = $package.Version.ToString()
        Root = $root
    }
}

function Export-AsarEntry {
    param(
        [Parameter(Mandatory)] [string]$Entry,
        [Parameter(Mandatory)] [string]$Destination
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $normalizedEntry = $Entry.TrimStart('\') -replace '/', '\'
    Push-Location $Destination
    try {
        & $script:NpxPath --yes '@electron/asar' extract-file $script:ArchivePath $normalizedEntry | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to extract ASAR entry: $Entry"
        }
    }
    finally {
        Pop-Location
    }

    return Join-Path $Destination ([IO.Path]::GetFileName($normalizedEntry))
}

function Get-PortableRelativePath {
    param(
        [Parameter(Mandatory)] [string]$BasePath,
        [Parameter(Mandatory)] [string]$TargetPath
    )

    $baseUri = [Uri]($BasePath.TrimEnd('\') + '\')
    $targetUri = [Uri]$TargetPath
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

$resolved = Resolve-CodexPackage
$resourcesPath = Join-Path $resolved.Root 'resources'
$script:ArchivePath = Join-Path $resourcesPath 'app.asar'
if (-not (Test-Path -LiteralPath $script:ArchivePath)) {
    throw "ASAR archive was not found: $script:ArchivePath"
}

$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npxCommand) {
    throw 'npx is required to run @electron/asar.'
}
$script:NpxPath = $npxCommand.Source

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $env:TEMP "codex-desktop-re-$($resolved.Version)"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$entries = @(& $script:NpxPath --yes '@electron/asar' list $script:ArchivePath)
if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) {
    throw 'Failed to list ASAR entries.'
}

$extracted = [Collections.Generic.List[string]]::new()
$extracted.Add((Export-AsarEntry -Entry 'package.json' -Destination $OutputDirectory))
$extracted.Add((Export-AsarEntry -Entry 'webview\index.html' -Destination (Join-Path $OutputDirectory 'renderer')))

$mainEntries = $entries | Where-Object { $_ -match '^\\\.vite\\build\\[^\\]+\.js$' }
foreach ($entry in $mainEntries) {
    $extracted.Add((Export-AsarEntry -Entry $entry -Destination (Join-Path $OutputDirectory 'main')))
}

$featurePattern = '^\\webview\\assets\\(?:app-main|app-initial|rpc|rolldown-runtime|modulepreload-polyfill|auto-review-approval-nudge|codex-micro-bridge|editor-diff-page|external-agent-config-import-flow|git-commit-|git-rebase-|git-settings-|local-conversation-thread|local-environment-editor|mcp-capability-view-page|mcp-settings|new-thread-panel-page|skills-page|skills-settings|subagent-panel|thread-app-shell-chrome|thread-overflow-menu|use-codex-worktrees|worktree-environment-dropdown|worktree-setup-auto-fix|worktrees-settings-page)[^\\]*\.js$'
$featureEntries = $entries | Where-Object { $_ -match $featurePattern }
foreach ($entry in $featureEntries) {
    $extracted.Add((Export-AsarEntry -Entry $entry -Destination (Join-Path $OutputDirectory 'renderer\selected')))
}

if ($Format) {
    $javascriptFiles = $extracted | Where-Object { $_ -like '*.js' }
    if ($javascriptFiles.Count -gt 0) {
        & $script:NpxPath --yes prettier --parser babel --write @javascriptFiles | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Prettier failed while formatting extracted JavaScript.'
        }
    }
}

$binaryNames = @(
    'codex.exe',
    'codex-code-mode-host.exe',
    'codex-command-runner.exe',
    'codex-windows-sandbox-setup.exe',
    'rg.exe'
)
$binaryInventory = foreach ($name in $binaryNames) {
    $path = Join-Path $resourcesPath $name
    if (-not (Test-Path -LiteralPath $path)) {
        continue
    }
    $item = Get-Item -LiteralPath $path
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    [pscustomobject]@{
        name = $name
        path = $path
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        signatureStatus = $signature.Status.ToString()
        signer = $signature.SignerCertificate.Subject
    }
}

$computerUse = Get-ChildItem -LiteralPath $resourcesPath -Recurse -Filter 'codex-computer-use.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($computerUse) {
    $signature = Get-AuthenticodeSignature -LiteralPath $computerUse.FullName
    $binaryInventory += [pscustomobject]@{
        name = $computerUse.Name
        path = $computerUse.FullName
        bytes = $computerUse.Length
        sha256 = (Get-FileHash -LiteralPath $computerUse.FullName -Algorithm SHA256).Hash
        signatureStatus = $signature.Status.ToString()
        signer = $signature.SignerCertificate.Subject
    }
}

$packageMetadata = Get-Content -Raw -LiteralPath (Join-Path $OutputDirectory 'package.json') | ConvertFrom-Json
$manifest = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    packageVersion = $resolved.Version
    packageRoot = $resolved.Root
    packageName = $packageMetadata.name
    internalVersion = $packageMetadata.version
    buildNumber = $packageMetadata.codexBuildNumber
    electronVersion = $packageMetadata.devDependencies.electron
    archive = [ordered]@{
        path = $script:ArchivePath
        bytes = (Get-Item -LiteralPath $script:ArchivePath).Length
        sha256 = (Get-FileHash -LiteralPath $script:ArchivePath -Algorithm SHA256).Hash
        entryCount = $entries.Count
        sourceMapCount = @($entries | Where-Object { $_ -match '\.map$' }).Count
    }
    extracted = [ordered]@{
        mainJavaScriptCount = $mainEntries.Count
        selectedRendererJavaScriptCount = $featureEntries.Count
        formatted = $Format.IsPresent
        files = @($extracted | ForEach-Object { Get-PortableRelativePath -BasePath $OutputDirectory -TargetPath $_ })
    }
    binaries = @($binaryInventory)
}

$manifestPath = Join-Path $OutputDirectory 'reverse-manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8

[pscustomobject]@{
    OutputDirectory = $OutputDirectory
    Manifest = $manifestPath
    MainJavaScript = $mainEntries.Count
    SelectedRendererJavaScript = $featureEntries.Count
    SourceMaps = $manifest.archive.sourceMapCount
} | Format-List
