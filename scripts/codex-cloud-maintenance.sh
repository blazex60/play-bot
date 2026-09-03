#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cd -- "${PROJECT_ROOT}"

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' '[codex-maintenance] Bun is missing; rebuild the Codex environment cache.' >&2
  exit 1
fi

printf '%s\n' '[codex-maintenance] refreshing dependencies from bun.lock'
bun install --frozen-lockfile

printf '%s\n' '[codex-maintenance] refreshing the Playwright Chromium browser'
./node_modules/.bin/playwright install chromium
