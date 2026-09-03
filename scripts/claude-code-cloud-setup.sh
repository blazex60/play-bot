#!/usr/bin/env bash

# Paste this file's contents into the Claude Code Cloud environment's
# Setup script field. The repository is not required during this phase.

set -Eeuo pipefail

log() {
  printf '[claude-cloud-setup] %s\n' "$*"
}

log 'installing system tools used by music-bot development and tests'
apt-get update
apt-get install -y --no-install-recommends \
  aubio-tools \
  build-essential \
  ca-certificates \
  curl \
  ffmpeg \
  python3 \
  python3-dev \
  python3-pip \
  python3-venv

if ! command -v bun >/dev/null 2>&1; then
  log 'installing Bun'
  npm install --global bun@latest
fi

log 'installing yt-dlp'
python3 -m pip install \
  --break-system-packages \
  --disable-pip-version-check \
  --upgrade \
  'yt-dlp[default]'

# Project dependencies are installed later by the repository's SessionStart
# hook. Install only the browser's Ubuntu libraries in the cached environment.
log 'installing Playwright Chromium system dependencies'
npx --yes playwright@1.56.1 install-deps chromium

log "Node $(node --version)"
log "Bun $(bun --version)"
log "yt-dlp $(yt-dlp --version)"
log 'setup completed'
