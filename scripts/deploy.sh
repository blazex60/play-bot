#!/usr/bin/env bash
# Scoped deploy: only rebuild/recreate the compose services affected by the
# files that changed in this pull, so an in-flight VC session in music-bot
# (in-memory GuildQueue/GuildPlayer, no persistence) isn't torn down by
# unrelated web/docs changes.
set -e

OLD_SHA=$(git rev-parse HEAD)
git pull origin main
NEW_SHA=$(git rev-parse HEAD)

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  echo "[deploy] no new commits (HEAD unchanged at $NEW_SHA) - nothing to do"
  exit 0
fi

CHANGED=$(git diff --name-only "$OLD_SHA" "$NEW_SHA")

echo "[deploy] $OLD_SHA -> $NEW_SHA"
echo "[deploy] changed files:"
echo "$CHANGED" | sed 's/^/[deploy]   /'

if echo "$CHANGED" | grep -Eq '^(Dockerfile|docker-compose\.yml|package\.json|package-lock\.json)$'; then
  echo "[deploy] Dockerfile/compose/package manifest changed -> full rebuild (music-bot, music-web, cloudflared)"
  docker compose up --build -d
  exit 0
fi

BOT_CHANGED=false
WEB_CHANGED=false

if echo "$CHANGED" | grep -E '^src/' | grep -Ev '^src/web/' | grep -q .; then
  BOT_CHANGED=true
fi

if echo "$CHANGED" | grep -Eq '^(web/|src/web/)'; then
  WEB_CHANGED=true
fi

if [ "$BOT_CHANGED" = true ] && [ "$WEB_CHANGED" = true ]; then
  echo "[deploy] both src/ (bot) and web/src/web/ changed -> rebuilding music-bot + music-web"
  docker compose up -d --build music-bot music-web
elif [ "$BOT_CHANGED" = true ]; then
  echo "[deploy] src/ (excluding src/web/) changed -> rebuilding music-bot only"
  docker compose up -d --build music-bot
elif [ "$WEB_CHANGED" = true ]; then
  echo "[deploy] web/ or src/web/ changed -> rebuilding music-web only (--no-deps)"
  docker compose up -d --build --no-deps music-web
else
  echo "[deploy] no changes under src/ or web/ (docs/legal/other only) -> skipping docker compose, no restart"
fi
