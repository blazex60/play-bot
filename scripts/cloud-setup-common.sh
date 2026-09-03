#!/usr/bin/env bash

set -Eeuo pipefail

readonly CLOUD_SETUP_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CLOUD_SETUP_PROJECT_ROOT="$(cd -- "${CLOUD_SETUP_SCRIPT_DIR}/.." && pwd)"
readonly CLOUD_SETUP_PLATFORM="${1:-unknown}"
readonly CLOUD_SETUP_PHASE="${2:-all}"

log() {
  printf '[cloud-setup:%s] %s\n' "${CLOUD_SETUP_PLATFORM}" "$*"
}

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    log "root privileges or sudo are required to install system packages"
    return 1
  fi
}

disable_unreachable_launchpad_sources() {
  local source_file
  local disabled_file

  for source_file in /etc/apt/sources.list.d/*; do
    [[ -f "${source_file}" ]] || continue
    [[ "${source_file}" == *.disabled-by-cloud-setup ]] && continue
    if ! grep -Eq 'https?://ppa\.launchpadcontent\.net/' "${source_file}"; then
      continue
    fi

    disabled_file="${source_file}.disabled-by-cloud-setup"
    log "disabling unreachable apt source: ${source_file}"
    run_as_root mv -- "${source_file}" "${disabled_file}"
  done
}

install_system_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get is unavailable; skipping Ubuntu package installation"
    return
  fi

  log "installing system packages"
  disable_unreachable_launchpad_sources
  run_as_root apt-get update
  run_as_root apt-get install -y --no-install-recommends \
    aubio-tools \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "using Bun $(bun --version)"
    return
  fi

  if ! command -v npm >/dev/null 2>&1; then
    log "Bun is missing and npm is unavailable"
    return 1
  fi

  log "Bun is missing; installing the current Bun release with npm"
  run_as_root npm install --global bun@latest
  log "installed Bun $(bun --version)"
}

install_node_dependencies() {
  cd -- "${CLOUD_SETUP_PROJECT_ROOT}"
  log "installing dependencies from bun.lock"

  if bun install --frozen-lockfile; then
    return
  fi

  if [[ "${CLOUD_SETUP_PLATFORM}" != "claude-code" ]]; then
    log "bun install failed"
    return 1
  fi

  # Bun is pre-installed in Claude Code Cloud but currently has documented
  # proxy compatibility issues. npm can still populate node_modules for the
  # project's Bun-based commands without creating or changing a lockfile.
  log "bun install failed; retrying through npm for Claude Code Cloud"
  npm install --no-package-lock
}

install_python_tools() {
  log "installing yt-dlp"
  run_as_root python3 -m pip install \
    --break-system-packages \
    --disable-pip-version-check \
    --upgrade \
    'yt-dlp[default]'
}

install_playwright_browser() {
  cd -- "${CLOUD_SETUP_PROJECT_ROOT}"
  log "installing the Playwright Chromium browser"
  ./node_modules/.bin/playwright install chromium
}

install_playwright_system_dependencies() {
  cd -- "${CLOUD_SETUP_PROJECT_ROOT}"
  log "installing Playwright Chromium OS dependencies"
  run_as_root ./node_modules/.bin/playwright install-deps chromium
}

verify_toolchain() {
  cd -- "${CLOUD_SETUP_PROJECT_ROOT}"
  log "verifying the cloud toolchain"
  node --version
  bun --version
  ffmpeg -version | sed -n '1p'
  aubiotrack --version 2>&1 | sed -n '1p'
  yt-dlp --version
  ./node_modules/.bin/playwright --version
}

main() {
  log "preparing ${CLOUD_SETUP_PROJECT_ROOT}"

  case "${CLOUD_SETUP_PHASE}" in
    all)
      install_system_packages
      ensure_bun
      install_node_dependencies
      install_python_tools
      install_playwright_system_dependencies
      install_playwright_browser
      verify_toolchain
      ;;
    project)
      ensure_bun
      install_node_dependencies
      install_playwright_browser
      ;;
    *)
      log "unknown setup phase: ${CLOUD_SETUP_PHASE}"
      return 2
      ;;
  esac

  log "setup completed"
}

main "$@"
