$ErrorActionPreference = "Stop"

$Package = "github:MengShengbo/TurboFluxCli"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing required command: $Name"
    Write-Host "Install Node.js 20+ first: https://nodejs.org/"
    exit 1
  }
}

Require-Command "node"
Require-Command "npm"

$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]") | Out-String).Trim()
if ($NodeMajor -lt 20) {
  Write-Host "Node.js 20+ is required. Current version: $(node --version)"
  exit 1
}

Write-Host "Installing TurboFlux CLI from $Package ..."
npm install -g $Package

Write-Host "TurboFlux installed:"
turboflux --version
Write-Host "Run: turboflux C:\path\to\project"
