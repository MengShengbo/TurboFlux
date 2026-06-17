#!/usr/bin/env bash
set -euo pipefail

PACKAGE="github:MengShengbo/TurboFluxCli"

info() {
  printf '%s\n' "$1"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    info "Missing required command: $1"
    info "Install Node.js 20+ first: https://nodejs.org/"
    exit 1
  fi
}

need_cmd node
need_cmd npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  info "Node.js 20+ is required. Current version: $(node --version)"
  exit 1
fi

info "Installing TurboFlux CLI from ${PACKAGE} ..."
npm install -g "$PACKAGE"

info "TurboFlux installed:"
turboflux --version
info "Run: turboflux /path/to/project"
